-- App state in Lakebase Postgres: per-user chat sessions/messages + usage log.
-- Idempotent; run as the database owner. The app's service-principal role is
-- granted access separately by deploy.py (it only exists once the app does).
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE SCHEMA IF NOT EXISTS chatapp;

CREATE TABLE IF NOT EXISTS chatapp.chat_sessions (
  session_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_email TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('chat','agent')),
  title TEXT,
  genie_conversation_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS chatapp.chat_messages (
  message_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES chatapp.chat_sessions(session_id) ON DELETE CASCADE,
  user_email TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content TEXT,
  mode TEXT NOT NULL,
  attachment_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS chatapp.usage_log (
  event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID,
  user_email TEXT NOT NULL,
  mode TEXT NOT NULL,
  question TEXT,
  success BOOLEAN NOT NULL,
  latency_ms INTEGER,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- v2: the mode is chosen per message, not per session. Genie keeps Chat and
-- Agent conversations separate (neither accepts the other's conversation id),
-- so a session holds one of each; `genie_conversation_id` is the Chat one.
ALTER TABLE chatapp.chat_sessions ADD COLUMN IF NOT EXISTS agent_conversation_id TEXT;
ALTER TABLE chatapp.chat_sessions ALTER COLUMN mode SET DEFAULT 'chat';
-- Name sessions created before titles existed after their first question.
UPDATE chatapp.chat_sessions s
   SET title = left(m.content, 60)
  FROM (SELECT DISTINCT ON (session_id) session_id, content
          FROM chatapp.chat_messages WHERE role = 'user'
         ORDER BY session_id, created_at) m
 WHERE s.session_id = m.session_id AND s.title IS NULL;

-- v3: answer feedback (synced to Genie) and per-question observability details.
-- genie_* ids identify the answer in Genie, which is what its feedback API needs.
ALTER TABLE chatapp.chat_messages ADD COLUMN IF NOT EXISTS genie_conversation_id TEXT;
ALTER TABLE chatapp.chat_messages ADD COLUMN IF NOT EXISTS genie_message_id TEXT;
ALTER TABLE chatapp.chat_messages ADD COLUMN IF NOT EXISTS feedback SMALLINT;      -- 1 helpful, -1 not helpful
ALTER TABLE chatapp.chat_messages ADD COLUMN IF NOT EXISTS feedback_at TIMESTAMPTZ;
ALTER TABLE chatapp.usage_log ADD COLUMN IF NOT EXISTS assistant_message_id UUID;
ALTER TABLE chatapp.usage_log ADD COLUMN IF NOT EXISTS feedback SMALLINT;
ALTER TABLE chatapp.usage_log ADD COLUMN IF NOT EXISTS details JSONB;           -- SQL run, timings, Genie ids

-- v4: answer cache. A standalone question (the first in a chat, or a
-- suggested question) is answered once and served from here after that. The
-- key includes the data and Genie versions, so reloading data or changing the
-- Genie space makes old answers unreachable; deploy.py bumps the versions.
CREATE TABLE IF NOT EXISTS chatapp.cache_versions (
  name TEXT PRIMARY KEY,                      -- 'data' | 'genie'
  version TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO chatapp.cache_versions (name, version) VALUES ('data', 'initial'), ('genie', 'initial')
ON CONFLICT (name) DO NOTHING;

CREATE TABLE IF NOT EXISTS chatapp.answer_cache (
  cache_key TEXT PRIMARY KEY,                 -- sha256(normalized question | mode | data version | genie version)
  question TEXT NOT NULL,
  normalized TEXT NOT NULL,
  mode TEXT NOT NULL,
  data_version TEXT NOT NULL,
  genie_version TEXT NOT NULL,
  answer_json JSONB NOT NULL,                 -- the same answer shape a live answer has
  details JSONB,                              -- SQL, timeline and Genie ids of the original run
  source TEXT NOT NULL CHECK (source IN ('live','prewarm')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ,                     -- NULL = valid for as long as the versions are
  hits INTEGER NOT NULL DEFAULT 0,
  last_hit_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_answer_cache_versions ON chatapp.answer_cache (data_version, genie_version);

-- One row per versions pair: which app instance pre-warmed it, and when.
CREATE TABLE IF NOT EXISTS chatapp.prewarm_runs (
  versions_key TEXT PRIMARY KEY,
  status TEXT NOT NULL,                       -- running | done | failed
  answered INTEGER NOT NULL DEFAULT 0,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);

-- Updated after each question; a 'running' claim with no heartbeat for 10
-- minutes belongs to an app instance that was stopped (e.g. by a redeploy).
ALTER TABLE chatapp.prewarm_runs ADD COLUMN IF NOT EXISTS heartbeat_at TIMESTAMPTZ;

ALTER TABLE chatapp.chat_messages ADD COLUMN IF NOT EXISTS from_cache BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE chatapp.chat_messages ADD COLUMN IF NOT EXISTS cache_key TEXT;
ALTER TABLE chatapp.usage_log ADD COLUMN IF NOT EXISTS from_cache BOOLEAN NOT NULL DEFAULT false;

-- v5: optional AI features (each off unless set in the deploy config).
-- Semantic cache: the question's embedding, compared in the app (a few hundred
-- rows per version pair, so no vector index is needed).
ALTER TABLE chatapp.answer_cache ADD COLUMN IF NOT EXISTS embedding REAL[];
-- Guardrails: the strongest action taken on the question or answer
-- (blocked > redacted > warned > flagged), with every check in details.guardrails.
ALTER TABLE chatapp.usage_log ADD COLUMN IF NOT EXISTS guard_action TEXT;
-- Faithfulness judge: 0-1 score, written shortly after the answer (details.judge has the rest).
ALTER TABLE chatapp.usage_log ADD COLUMN IF NOT EXISTS faithfulness REAL;

-- v6: feedback review, evaluations.
-- A thumbs-down asks why; reviewers work through them in Monitoring.
ALTER TABLE chatapp.chat_messages ADD COLUMN IF NOT EXISTS feedback_reason TEXT;
ALTER TABLE chatapp.chat_messages ADD COLUMN IF NOT EXISTS feedback_comment TEXT;
ALTER TABLE chatapp.usage_log ADD COLUMN IF NOT EXISTS feedback_reason TEXT;
ALTER TABLE chatapp.usage_log ADD COLUMN IF NOT EXISTS feedback_comment TEXT;
ALTER TABLE chatapp.usage_log ADD COLUMN IF NOT EXISTS review_status TEXT;   -- open | fixed | dismissed | added_to_evals
ALTER TABLE chatapp.usage_log ADD COLUMN IF NOT EXISTS reviewed_by TEXT;
ALTER TABLE chatapp.usage_log ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;

-- Evaluation suite. Cases are seeded by deploy.py (ground-truth questions from
-- the Genie benchmarks, red-team prompts, policy wording) and added from the
-- feedback queue. category: accuracy | guardrail | policy.
-- expected: accuracy = ground-truth SQL in expected_sql; guardrail = block |
-- redact | detect:<check> | allow; policy = flag:<check> | redact | allow.
CREATE TABLE IF NOT EXISTS chatapp.eval_cases (
  case_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category TEXT NOT NULL CHECK (category IN ('accuracy','guardrail','policy')),
  question TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'chat',
  expected TEXT,
  expected_sql TEXT,
  source TEXT NOT NULL DEFAULT 'manual',   -- benchmark | redteam | policy | feedback | manual
  notes TEXT,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (category, question)
);

CREATE TABLE IF NOT EXISTS chatapp.eval_runs (
  run_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  started_by TEXT,
  categories TEXT[],
  status TEXT NOT NULL DEFAULT 'running',  -- running | done | failed
  total INTEGER NOT NULL DEFAULT 0,
  completed INTEGER NOT NULL DEFAULT 0,
  config JSONB,                            -- models and versions the run used
  summary JSONB,                           -- pass rates and average scores per category
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS chatapp.eval_results (
  result_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES chatapp.eval_runs(run_id) ON DELETE CASCADE,
  case_id UUID,
  category TEXT NOT NULL,
  question TEXT NOT NULL,
  expected TEXT,
  passed BOOLEAN,
  scores JSONB,                            -- correctness, faithfulness, relevance, completeness, safety
  outcome TEXT,                            -- what actually happened, in a few words
  details JSONB,                           -- answer preview, SQL, judge reasons, guard events
  latency_ms INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_eval_results_run ON chatapp.eval_results (run_id);

-- Sessions named from a question a guardrail blocked or redacted get a neutral
-- title instead (the app does this for new sessions; this fixes older ones).
UPDATE chatapp.chat_sessions s
   SET title = CASE WHEN f.guard_action = 'blocked' THEN '⚠ Blocked question' ELSE '⚠ Personal details removed' END
  FROM (SELECT DISTINCT ON (session_id) session_id, guard_action, details
          FROM chatapp.usage_log ORDER BY session_id, created_at) f
 WHERE f.session_id = s.session_id
   AND (f.guard_action = 'blocked'
        OR (f.guard_action = 'redacted' AND f.details->'guardrails'->'events' @> '[{"stage":"input","check":"pii"}]'))
   AND s.title IS NOT NULL AND s.title NOT LIKE '⚠%';

-- v8: conversation memory. Every N question-and-answer pairs the older turns of a session
-- are folded into a short summary, sent with follow-up questions together with the recent turns.
ALTER TABLE chatapp.chat_sessions ADD COLUMN IF NOT EXISTS context_summary TEXT;
ALTER TABLE chatapp.chat_sessions ADD COLUMN IF NOT EXISTS context_summary_upto INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_chat_sessions_user ON chatapp.chat_sessions (user_email, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chatapp.chat_messages (session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_usage_log_created ON chatapp.usage_log (created_at);
CREATE INDEX IF NOT EXISTS idx_usage_log_user ON chatapp.usage_log (user_email);
