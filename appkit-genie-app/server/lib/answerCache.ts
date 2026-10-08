import { createHash } from 'node:crypto';
import { aiConfig } from './aiConfig.js';
import type { Answer } from './answers.js';
import { cosine, embed, forFeature } from './models.js';
import { runGenie, type GenieLike, type GenieRun, type Mode } from './genieRun.js';
import { ALL_SUGGESTIONS } from './suggestions.js';
import { dropEmptyCharts } from './emptyResults.js';

/**
 * Exact-match answer cache in Lakebase (chatapp.answer_cache).
 *
 * Only standalone questions are cached: the first question of a chat, or a
 * suggested question. Follow-ups depend on the conversation, so they always go
 * to Genie. The key is the normalized question + mode + the data and Genie
 * versions that deploy.py bumps, so new data or a changed Genie space makes
 * every older answer unreachable at once — there is no stale window to manage.
 * The app calls Genie as its service principal, so every user would get the
 * same answer and one shared cache is safe.
 */

export interface Lakebase {
  query: (text: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
}

export interface Versions { data: string; genie: string; settled: boolean }

export interface CachedAnswer {
  key: string;
  answer: Answer;
  details: Record<string, unknown>;
  source: 'live' | 'prewarm';
  createdAt: string;
  /** Set for a semantic hit: the cached question that was matched, and how similar it was. */
  similarTo?: { question: string; similarity: number };
}

/** How long an answer to a live (non-suggested) question is reused. */
const LIVE_TTL_HOURS = 24;
/** Versions must be unchanged this long before pre-warming, so one deploy that
 * bumps data and then Genie doesn't pre-warm twice. */
const SETTLE_MS = 2 * 60_000;
const PREWARM_EVERY_MS = 10 * 60_000;
/** A running pre-warm with no heartbeat for this long belonged to an app
 * instance that was stopped (a redeploy restarts the app), so it's taken over.
 * One Agent question takes up to ~4 minutes. */
const PREWARM_STALE_MINUTES = 10;
/** A pre-warm that ended with unanswered questions is retried after this long. */
const PREWARM_RETRY_MINUTES = 60;

export const cacheEnabled = (process.env.LENS_ANSWER_CACHE ?? 'on') !== 'off';
const prewarmEnabled = cacheEnabled && (process.env.LENS_PREWARM ?? 'on') !== 'off';

export function normalizeQuestion(q: string): string {
  return q
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”"]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[\s?.!]+$/, '');
}

export function cacheKey(question: string, mode: Mode, v: Versions): string {
  return createHash('sha256')
    .update([normalizeQuestion(question), mode, v.data, v.genie].join('|'))
    .digest('hex');
}

let versionsMemo: { at: number; value: Versions } | null = null;

/** Current data/Genie versions (re-read at most every 30 s). */
export async function currentVersions(db: Lakebase): Promise<Versions> {
  if (versionsMemo && Date.now() - versionsMemo.at < 30_000) return versionsMemo.value;
  const { rows } = await db.query(`SELECT name, version, updated_at FROM chatapp.cache_versions`);
  const byName = Object.fromEntries(rows.map((r) => [r.name as string, r.version as string]));
  const newest = Math.max(0, ...rows.map((r) => new Date(r.updated_at as string).getTime()));
  const value: Versions = {
    data: byName.data ?? 'initial',
    genie: byName.genie ?? 'initial',
    settled: Date.now() - newest > SETTLE_MS,
  };
  versionsMemo = { at: Date.now(), value };
  return value;
}

export async function lookup(db: Lakebase, key: string): Promise<CachedAnswer | null> {
  const { rows } = await db.query(
    `UPDATE chatapp.answer_cache SET hits = hits + 1, last_hit_at = now()
      WHERE cache_key = $1 AND (expires_at IS NULL OR expires_at > now())
      RETURNING answer_json, details, source, created_at`,
    [key],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    key,
    answer: r.answer_json as Answer,
    details: (r.details ?? {}) as Record<string, unknown>,
    source: r.source as 'live' | 'prewarm',
    createdAt: new Date(r.created_at as string).toISOString(),
  };
}

/** Details worth keeping with a cached answer, so a cache hit can still show
 * Monitoring the SQL and steps behind it. */
function runDetails(run: GenieRun): Record<string, unknown> {
  return {
    timeline: run.timeline,
    queries: run.queries,
    latencyMs: run.latencyMs,
    genieConversationId: run.conversationId ?? null,
    genieMessageId: run.genieMessageId,
  };
}

export async function store(
  db: Lakebase, key: string, question: string, mode: Mode, v: Versions, run: GenieRun, source: 'live' | 'prewarm',
  embedding: number[] | null = null,
): Promise<void> {
  if (!run.success || !run.answer || !(run.answer.text || run.answer.charts.length)) return;
  await db.query(
    `INSERT INTO chatapp.answer_cache
       (cache_key, question, normalized, mode, data_version, genie_version, answer_json, details, source, expires_at, embedding)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9,
             CASE WHEN $9 = 'live' THEN now() + make_interval(hours => $10) END, $11::real[])
     ON CONFLICT (cache_key) DO UPDATE SET
       question = EXCLUDED.question, answer_json = EXCLUDED.answer_json, details = EXCLUDED.details,
       source = EXCLUDED.source, created_at = now(), expires_at = EXCLUDED.expires_at, hits = 0, last_hit_at = NULL,
       embedding = COALESCE(EXCLUDED.embedding, chatapp.answer_cache.embedding)`,
    [key, question, normalizeQuestion(question), mode, v.data, v.genie,
      JSON.stringify(run.answer), JSON.stringify(runDetails(run)), source, LIVE_TTL_HOURS, embedding],
  );
}

/** Stores the judge's verdict with a cached answer, so cache hits can show it without judging again. */
export async function attachJudge(db: Lakebase, key: string, judge: unknown): Promise<void> {
  await db.query(
    `UPDATE chatapp.answer_cache SET details = jsonb_set(COALESCE(details, '{}'::jsonb), '{judge}', $2::jsonb) WHERE cache_key = $1`,
    [key, JSON.stringify(judge)],
  );
}

// --- semantic matching -------------------------------------------------------

/** Embeddings for the semantic cache (one call for many questions); nulls when it's off or the call fails. */
export async function embedQuestions(questions: string[]): Promise<Array<number[] | null>> {
  const sc = aiConfig.semanticCache;
  if (!sc || !questions.length) return questions.map(() => null);
  try {
    const vecs = await forFeature('embeddings', () => embed(sc.embeddingModel, questions.map(normalizeQuestion)));
    return questions.map((_, i) => (vecs[i]?.length ? vecs[i] : null));
  } catch (err) {
    console.warn('[cache] embedding failed; semantic matching skipped:', err instanceof Error ? err.message : err);
    return questions.map(() => null);
  }
}

const UNITS = ['refining', 'aerospace', 'building controls', 'process solutions', 'connected plant'];
const ASSETS = ['compressor', 'furnace', 'turbine', 'hvac', 'pump', 'reactor', 'heat exchanger'];
const NAMED = ['houston', 'phoenix', 'chicago', 'new york', 'seattle', 'austin', 'high', 'medium', 'low',
  'time-series', 'first-principle', 'hybrid'];
const DIMENSIONS: Record<string, RegExp> = {
  unit: /\bbusiness units?\b|\bbus?\b|\bdivisions?\b/, site: /\bsites?\b|\bplants?\b|\blocations?\b/,
  asset: /\bassets?\b|\bequipment\b|\basset types?\b/, model_type: /\bmodel types?\b|\bapproach\b/,
  criticality: /\bcriticality\b|\bcritical\b/, team: /\bteams?\b|\bowners?\b/, version: /\bversions?\b/,
  time: /\bhours?\b|\bday\b|\bdays\b|\bdaily\b|\btrend\b/, drift: /\bdrift/, confidence: /\bconfiden/,
  accuracy: /\baccura|\berrors?\b|\bmae\b|\brmse\b/, alerts: /\balerts?\b|\banomal/, false_positive: /\bfalse\b/,
  value: /\bsavings?\b|\bvalue\b|\bdowntime\b|\broi\b|\byield\b/, latency: /\blatency\b/,
};
const HIGH = /\b(best|highest|top|most|strongest|leading|largest|biggest|maximum)\b/;
const LOW = /\b(worst|lowest|bottom|least|weakest|smallest|minimum|underperform\w*|lagging|behind)\b/;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');

/**
 * The details two questions must share for one answer to serve both: numbers
 * (model IDs, thresholds), named business units, asset types, sites, criticality and
 * model types, the dimensions asked about, and the direction (best vs worst).
 * Embeddings alone score "drift at Houston 1" and "drift at Houston 2" as near-identical.
 */
export function keyDetails(question: string): string {
  const q = normalizeQuestion(question);
  const found = (list: string[]) => list.filter((x) => new RegExp(`\\b${escapeRe(x)}\\b`).test(q));
  const parts = [
    ...(q.match(/\d+(\.\d+)?\+?/g) ?? []).map((n) => `n:${n}`),
    ...found(UNITS).map((x) => `p:${x}`),
    ...found(ASSETS).map((x) => `c:${x}`),
    ...found(NAMED).map((x) => `s:${x}`),
    ...Object.entries(DIMENSIONS).filter(([, re]) => re.test(q)).map(([k]) => `d:${k}`),
    HIGH.test(q) ? 'dir:high' : '',
    LOW.test(q) ? 'dir:low' : '',
  ].filter(Boolean);
  return [...new Set(parts)].sort().join('|');
}

export interface SemanticMatch {
  hit: CachedAnswer | null;
  best: { question: string; similarity: number; sameDetails: boolean } | null;
}

/** Nearest cached question with the same mode and versions; a hit only above the threshold and with the same key details. */
export async function semanticLookup(db: Lakebase, question: string, mode: Mode, v: Versions, vec: number[]): Promise<SemanticMatch> {
  const sc = aiConfig.semanticCache;
  if (!sc) return { hit: null, best: null };
  const { rows: missing } = await db.query(
    `SELECT cache_key, question FROM chatapp.answer_cache
      WHERE mode = $1 AND data_version = $2 AND genie_version = $3 AND embedding IS NULL
        AND (expires_at IS NULL OR expires_at > now())
      LIMIT 25`,
    [mode, v.data, v.genie],
  );
  if (missing.length) {
    const vecs = await embedQuestions(missing.map((r) => r.question as string));
    for (const [i, r] of missing.entries()) {
      if (vecs[i]) await db.query(`UPDATE chatapp.answer_cache SET embedding = $2::real[] WHERE cache_key = $1`, [r.cache_key, vecs[i]]);
    }
  }
  const { rows } = await db.query(
    `SELECT cache_key, question, embedding FROM chatapp.answer_cache
      WHERE mode = $1 AND data_version = $2 AND genie_version = $3 AND embedding IS NOT NULL
        AND (expires_at IS NULL OR expires_at > now())`,
    [mode, v.data, v.genie],
  );
  let best: { key: string; question: string; similarity: number } | null = null;
  for (const r of rows) {
    const s = cosine(vec, (r.embedding as Array<number | string>).map(Number));
    if (!best || s > best.similarity) best = { key: r.cache_key as string, question: r.question as string, similarity: s };
  }
  if (!best) return { hit: null, best: null };
  const sameDetails = keyDetails(question) === keyDetails(best.question);
  const summary = { question: best.question, similarity: Math.round(best.similarity * 10000) / 10000, sameDetails };
  if (best.similarity < sc.threshold || !sameDetails) return { hit: null, best: summary };
  const hit = await lookup(db, best.key);
  return { hit: hit ? { ...hit, similarTo: { question: best.question, similarity: summary.similarity } } : null, best: summary };
}

export async function evict(db: Lakebase, key: string): Promise<void> {
  await db.query(`DELETE FROM chatapp.answer_cache WHERE cache_key = $1`, [key]);
}

// --- pre-warm ----------------------------------------------------------------

/**
 * Keeps the suggested questions answered for the current versions. Runs 30 s
 * after start and then every 10 minutes, but only does work when the versions
 * changed (or the cache for them is still empty). A row in prewarm_runs claims
 * the work, so with several app instances only one of them asks Genie.
 */
export type PrewarmHook = (key: string, question: string, run: GenieRun) => void;

export function startPrewarm(db: Lakebase, genie: GenieLike, onPrewarmed?: PrewarmHook): void {
  if (!prewarmEnabled) {
    console.log('[cache] pre-warm is off (LENS_PREWARM=off or LENS_ANSWER_CACHE=off)');
    return;
  }
  const tick = () => {
    prewarmOnce(db, genie, onPrewarmed).catch((err: unknown) =>
      console.warn('[cache] pre-warm failed:', err instanceof Error ? err.message : err));
  };
  setTimeout(tick, 30_000).unref();
  setInterval(tick, PREWARM_EVERY_MS).unref();
}

export async function prewarmOnce(db: Lakebase, genie: GenieLike, onPrewarmed?: PrewarmHook): Promise<{ answered: number } | null> {
  versionsMemo = null;
  const v = await currentVersions(db);
  if (!v.settled) return null;
  const versionsKey = `${v.data}|${v.genie}`;

  // Housekeeping: answers for older versions can never be hit again.
  await db.query(
    `DELETE FROM chatapp.answer_cache
      WHERE data_version <> $1 OR genie_version <> $2 OR expires_at < now()`,
    [v.data, v.genie],
  );

  const claimed = await db.query(
    `INSERT INTO chatapp.prewarm_runs (versions_key, status, heartbeat_at) VALUES ($1, 'running', now())
     ON CONFLICT (versions_key) DO UPDATE
       SET status = 'running', started_at = now(), heartbeat_at = now(), finished_at = NULL, answered = 0
       WHERE (chatapp.prewarm_runs.status = 'running'
              AND COALESCE(chatapp.prewarm_runs.heartbeat_at, chatapp.prewarm_runs.started_at) < now() - make_interval(mins => $2))
          OR (chatapp.prewarm_runs.status = 'failed'
              AND chatapp.prewarm_runs.finished_at < now() - make_interval(mins => $3))
     RETURNING versions_key`,
    [versionsKey, PREWARM_STALE_MINUTES, PREWARM_RETRY_MINUTES],
  );
  if (!claimed.rows.length) return null;

  console.log(`[cache] pre-warming ${ALL_SUGGESTIONS.length} suggested questions for versions ${versionsKey}`);
  let answered = 0;
  const vectors = await embedQuestions(ALL_SUGGESTIONS.map((s) => s.q)); // one call for all ten
  for (const [i, s] of ALL_SUGGESTIONS.entries()) {
    await db.query(
      `UPDATE chatapp.prewarm_runs SET heartbeat_at = now(), answered = $2 WHERE versions_key = $1`,
      [versionsKey, answered],
    );
    const key = cacheKey(s.q, s.mode, v);
    // Already answered live since the versions changed: keep that answer, but
    // like any suggested question it now lasts until the versions change.
    const existing = await db.query(
      `UPDATE chatapp.answer_cache SET source = 'prewarm', expires_at = NULL, embedding = COALESCE(embedding, $2::real[])
        WHERE cache_key = $1 AND (expires_at IS NULL OR expires_at > now()) RETURNING 1`,
      [key, vectors[i]],
    );
    if (existing.rows.length) { answered++; continue; }
    const run = await runGenie(genie, s.mode, s.q);
    if (run.success && run.answer) await dropEmptyCharts(s.q, run.answer).catch(() => null);
    if (run.success) {
      // Suggested questions don't expire; they stay until the versions change.
      await store(db, key, s.q, s.mode, v, run, 'prewarm', vectors[i]);
      onPrewarmed?.(key, s.q, run);
      answered++;
    } else {
      console.warn(`[cache] pre-warm: no answer for "${s.q.slice(0, 60)}": ${run.errorMessage ?? 'empty answer'}`);
    }
  }
  await db.query(
    `UPDATE chatapp.prewarm_runs SET status = $2, answered = $3, finished_at = now() WHERE versions_key = $1`,
    [versionsKey, answered === ALL_SUGGESTIONS.length ? 'done' : 'failed', answered],
  );
  console.log(`[cache] pre-warm finished: ${answered}/${ALL_SUGGESTIONS.length} answered`);
  return { answered };
}
