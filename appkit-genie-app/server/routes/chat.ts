import express from 'express';
import { getExecutionContext } from '@databricks/appkit';
import { agentAnswer, stripCitations, type Answer } from '../lib/answers.js';
import { aiConfig, aiConfigSummary } from '../lib/aiConfig.js';
import {
  attachJudge, cacheEnabled, cacheKey, currentVersions, embedQuestions, evict, lookup, semanticLookup, startPrewarm, store,
  type Lakebase, type SemanticMatch,
} from '../lib/answerCache.js';
import { runGenie, type GenieLike, type GenieRun, type Mode } from '../lib/genieRun.js';
import { checkOutput, inputClassifier, inputPatterns, type GuardEvent } from '../lib/guardrails.js';
import { judgeAnswer } from '../lib/judge.js';
import { DEEPER_NOTE, fixedRoute, rememberRoute, routeMessage, takeRoute, type RouteDecision, type Selected } from '../lib/router.js';
import { answerPlatform, type PlatformAnswer } from '../lib/platformHelp.js';
import { dropEmptyCharts } from '../lib/emptyResults.js';
import { engineContext, historyWindow, isVagueFollowUp, loadHistory, maybeCompact, type SessionHistory } from '../lib/memory.js';
import { suggestFollowUps } from '../lib/followups.js';
import { modelLabel, withTokenLedger, type TokenLedger } from '../lib/models.js';
import { LIBRARY, MORE_SUGGESTIONS, QUICK_START, STARTERS } from '../lib/suggestions.js';
import { GUARDED_TITLES, generateTitle, isGuardedTitle } from '../lib/titles.js';
import { Trace, sourcesFromSql } from '../lib/trace.js';

/** The engine is at capacity or hit a transient fault: worth retrying. */
function busy(message: string | null | undefined): boolean {
  return Boolean(message) && /RESOURCE_EXHAUSTED|rate_limit|too_many_requests|temporarily at capacity|Self-suppression|\b(429|503)\b|UNAVAILABLE|ECONNRESET|socket hang up/i.test(String(message));
}

/** The strongest guardrail action on a question, for Monitoring's counts. */
function strongestAction(events: GuardEvent[]): string | null {
  for (const [action, label] of [['block', 'blocked'], ['redact', 'redacted'], ['warn', 'warned'], ['flag', 'flagged']] as const) {
    if (events.some((e) => e.action === action)) return label;
  }
  return null;
}

type Row = Record<string, unknown>;

/** Estimated USD for a token ledger, when prices are configured for its models. */
function costOf(ledger: TokenLedger | null | undefined): number | null {
  let total = 0;
  let priced = false;
  for (const e of Object.values(ledger ?? {})) {
    const p = aiConfig.pricing[e.model];
    if (!p) continue;
    priced = true;
    total += (e.input * p.input + e.output * p.output) / 1e6;
  }
  return priced ? total : null;
}

/**
 * The trust summary shown under an answer: the judge's verdict (or whether it
 * is still running), the data sources behind it and the guardrail checks.
 */
function qualitySummary(row: { details?: unknown; faithfulness?: unknown; success?: unknown; created_at?: unknown; from_cache?: unknown }) {
  const d = (row.details ?? {}) as Row;
  const judge = d.judge as { score?: number | null; reused?: boolean; numeric?: { checked: number; found: number; missing: string[] };
    llm?: { metrics?: Record<string, number | null>; unsupported?: string[]; reason?: string; model?: string } | null } | undefined;
  const events = (((d.guardrails as Row | undefined)?.events ?? []) as GuardEvent[]).map((e) => ({ stage: e.stage, check: e.check, action: e.action }));
  const blocked = events.some((e) => e.action === 'block');
  const age = Date.now() - new Date(String(row.created_at ?? 0)).getTime();
  const status = !aiConfig.judge ? 'off'
    : judge ? 'done'
    : blocked || row.success === false ? 'n/a'
    : !row.from_cache && age < 180_000 ? 'pending' : 'not_judged'; // a cache hit reuses the judge's verdict or has none
  return {
    status,
    score: typeof judge?.score === 'number' ? judge.score : null,
    metrics: judge?.llm?.metrics ?? null,
    reason: judge?.llm?.reason ?? null,
    unsupported: judge?.llm?.unsupported ?? [],
    missing: judge?.numeric?.missing ?? [],
    numbers: judge?.numeric ? { checked: judge.numeric.checked, found: judge.numeric.found } : null,
    judgeModel: modelLabel(judge?.llm?.model ?? aiConfig.judge?.model) || null,
    reused: Boolean(judge?.reused),
    warnBelow: aiConfig.judge?.warnBelow ?? 0.7,
    sources: (d.sources as string[] | undefined) ?? sourcesFromSql(((d.queries ?? []) as Array<{ sql?: string }>).map((q) => q.sql)),
    queries: ((d.queries ?? []) as unknown[]).length,
    guard: events,
    fromCache: Boolean(row.from_cache),
  };
}

/** The slice of the AppKit plugin map this router actually uses (avoids
 * fighting PluginMap<T>'s plugin-array-dependent generic — TS structural
 * typing means the real `appkit` object from server.ts satisfies this). */
interface ChatAppKit {
  lakebase: Lakebase;
  genie: GenieLike;
}

const GENIE_AGENT_ID = process.env.DATABRICKS_GENIE_SPACE_ID ?? '';

function currentUserEmail(req: express.Request): string {
  const email = req.headers['x-forwarded-email'];
  if (typeof email === 'string' && email) return email;
  // Local dev has no reverse proxy setting this header.
  return 'local-dev@localhost';
}

/** Follow-ups offered after a platform answer: other parts of the guide. */
const PLATFORM_FOLLOW_UPS = [
  { section: 'command-center', q: 'What does the Command Center show?' },
  { section: 'explorer', q: 'How do I filter and drill down in the Explorer?' },
  { section: 'modes', q: 'When should I use Quick answer or Deep analysis?' },
  { section: 'trust', q: 'How does Lens MLOps check that answers are accurate?' },
  { section: 'observability', q: 'What can I see in Observability?' },
];

export function buildChatRouter(appkit: ChatAppKit): express.Router {
  const router = express.Router();
  router.use(express.json());

  const ownedSession = async (id: string, email: string) => {
    const { rows } = await appkit.lakebase.query(
      `SELECT session_id, title, genie_conversation_id, agent_conversation_id
         FROM chatapp.chat_sessions
        WHERE session_id = $1 AND user_email = $2`,
      [id, email],
    );
    return rows[0];
  };

  /**
   * Genie keeps Chat and Agent conversations apart (each rejects the other's
   * conversation id — confirmed against the live API). When a question goes
   * to one mode after turns were answered in the other, carry the latest of
   * those turns over as context so follow-ups still make sense. Answers served
   * from the cache never reached this session's Genie conversation either, so
   * they are carried over the same way.
   */
  const crossModeContext = async (sessionId: string, mode: Mode): Promise<string> => {
    const { rows } = await appkit.lakebase.query(
      `SELECT role, content, mode FROM chatapp.chat_messages
        WHERE session_id = $1
          AND created_at > COALESCE(
                (SELECT MAX(created_at) FROM chatapp.chat_messages
                  WHERE session_id = $1 AND mode = $2 AND NOT from_cache), 'epoch')
        ORDER BY created_at DESC
        LIMIT 4`,
      [sessionId, mode],
    );
    if (!rows.length) return '';
    const turns = rows
      .reverse()
      .map((r) => `${r.role === 'user' ? 'Q' : 'A'}: ${String(r.content ?? '').slice(0, 700)}`)
      .join('\n');
    return `Context from earlier in this conversation:\n${turns}\n\nNew question: `;
  };

  /** The last few turns of a session (any mode), as context for a retry in a fresh conversation. */
  const recentContext = async (sessionId: string, question: string): Promise<string> => {
    const { rows } = await appkit.lakebase.query(
      `SELECT role, content FROM chatapp.chat_messages WHERE session_id = $1 ORDER BY created_at DESC LIMIT 5`,
      [sessionId],
    );
    const turns = rows.reverse().filter((r, i, all) => !(i === all.length - 1 && r.role === 'user' && r.content === question));
    if (!turns.length) return '';
    return `Context from earlier in this conversation:\n${turns.slice(-4).map((r) => `${r.role === 'user' ? 'Q' : 'A'}: ${String(r.content ?? '').slice(0, 700)}`).join('\n')}\n\nNew question: `;
  };

  // Who is signed in: email from the platform's header, full name from the workspace user
  // directory (cached), or worked out from the email if the directory can't be read.
  const names = new Map<string, string>();
  const nameFromEmail = (email: string) => String(email).split('@')[0].split(/[._-]+/).map((p) => p.replace(/\d+$/, ''))
    .filter(Boolean).map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
  router.get('/api/me', async (req, res) => {
    const email = currentUserEmail(req);
    let name = names.get(email);
    if (name === undefined && email.includes('@') && !email.endsWith('@localhost')) {
      try {
        const client = getExecutionContext().client;
        const r = (await Promise.race([
          client.apiClient.request({
            path: '/api/2.0/preview/scim/v2/Users', method: 'GET', headers: new Headers(), raw: false,
            query: { filter: `userName eq "${email.replace(/"/g, '')}"`, attributes: 'displayName,name' },
          } as never),
          new Promise((_, reject) => setTimeout(() => reject(new Error('timed out')), 4000)),
        ])) as { Resources?: Array<{ displayName?: string; name?: { givenName?: string; familyName?: string } }> };
        const u = r.Resources?.[0];
        name = u ? (u.displayName || [u.name?.givenName, u.name?.familyName].filter(Boolean).join(' ')) : '';
      } catch (err) {
        console.warn('[me] user directory lookup failed:', err instanceof Error ? err.message : err);
      }
      names.set(email, name ?? '');
    }
    const host = (process.env.DATABRICKS_HOST ?? '').replace(/\/$/, '');
    // Some directories store the email as the display name: then the name is built from the email.
    const display = name && !name.includes('@') ? name : nameFromEmail(email);
    res.json({ email, name: display, workspaceUrl: host ? (host.startsWith('http') ? host : `https://${host}`) : null });
  });

  // One list for the tiles, the side panel and the cache pre-warm.
  router.get('/api/chat/suggestions', (_req, res) => {
    res.json({ starters: STARTERS, more: MORE_SUGGESTIONS, quickStart: QUICK_START, library: LIBRARY });
  });

  // Pre-warmed answers are judged too, so cache hits can show their score.
  startPrewarm(appkit.lakebase, appkit.genie, (key, q, run) => {
    if (!aiConfig.judge || !run.answer?.text) return;
    void judgeAnswer(q, run.answer.text, run.evidence)
      .then((verdict) => (verdict ? attachJudge(appkit.lakebase, key, verdict) : undefined))
      .catch(() => {});
  });

  // --- sessions -------------------------------------------------------

  router.get('/api/chat/sessions', async (req, res) => {
    const email = currentUserEmail(req);
    // Sessions nobody has asked anything in yet aren't worth listing.
    const { rows } = await appkit.lakebase.query(
      `SELECT s.session_id, s.title, s.created_at, s.updated_at,
              (SELECT COUNT(*)::int FROM chatapp.chat_messages m WHERE m.session_id = s.session_id AND m.role = 'user') AS questions
         FROM chatapp.chat_sessions s
        WHERE s.user_email = $1
          AND EXISTS (SELECT 1 FROM chatapp.chat_messages m WHERE m.session_id = s.session_id)
        ORDER BY s.updated_at DESC
        LIMIT 100`,
      [email],
    );
    res.json(rows);
  });

  router.post('/api/chat/sessions', async (req, res) => {
    const email = currentUserEmail(req);
    const { rows } = await appkit.lakebase.query(
      `INSERT INTO chatapp.chat_sessions (user_email, title)
       VALUES ($1, NULL)
       RETURNING session_id, title, created_at, updated_at`,
      [email],
    );
    res.status(201).json(rows[0]);
  });

  router.patch('/api/chat/sessions/:id', async (req, res) => {
    const email = currentUserEmail(req);
    const title = String(req.body?.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
    if (!title) {
      res.status(400).json({ error: 'title is required' });
      return;
    }
    const { rows } = await appkit.lakebase.query(
      `UPDATE chatapp.chat_sessions SET title = $1 WHERE session_id = $2 AND user_email = $3 RETURNING session_id, title`,
      [title, req.params.id, email],
    );
    if (!rows.length) res.status(404).json({ error: 'session not found' });
    else res.json(rows[0]);
  });

  router.delete('/api/chat/sessions/:id', async (req, res) => {
    const email = currentUserEmail(req);
    const { rows } = await appkit.lakebase.query(
      `DELETE FROM chatapp.chat_sessions WHERE session_id = $1 AND user_email = $2 RETURNING session_id`,
      [req.params.id, email],
    );
    if (!rows.length) res.status(404).json({ error: 'session not found' });
    else res.status(204).end();
  });

  router.get('/api/chat/sessions/:id/messages', async (req, res) => {
    const email = currentUserEmail(req);
    if (!(await ownedSession(req.params.id, email))) {
      res.status(404).json({ error: 'session not found' });
      return;
    }
    const { rows } = await appkit.lakebase.query(
      `SELECT m.message_id, m.role, m.content, m.mode, m.attachment_json, m.feedback, m.feedback_reason, m.from_cache, m.created_at,
              u.details AS log_details, u.faithfulness, u.success AS log_success, u.created_at AS logged_at
         FROM chatapp.chat_messages m
         LEFT JOIN chatapp.usage_log u ON u.assistant_message_id = m.message_id
        WHERE m.session_id = $1
        ORDER BY m.created_at ASC`,
      [req.params.id],
    );
    // Messages stored before answers were normalized hold Agent Mode's raw
    // `output` array — convert so old sessions get their charts too.
    for (const r of rows) {
      const a = r.attachment_json as unknown;
      if (Array.isArray(a) && r.mode === 'agent') r.attachment_json = agentAnswer(a as never);
      const answer = r.attachment_json as Answer | null;
      if (answer && typeof answer.text === 'string') answer.text = stripCitations(answer.text);
      if (typeof r.content === 'string') r.content = stripCitations(r.content);
      if (r.role === 'assistant' && r.log_details) {
        r.quality = qualitySummary({ details: r.log_details, success: r.log_success, created_at: r.logged_at, from_cache: r.from_cache });
      }
      delete r.log_details; delete r.log_success; delete r.logged_at; delete r.faithfulness;
    }
    res.json(rows);
  });

  // --- send a message (SSE response; the mode is chosen per message) ---

  // The router: where a typed question goes (the data or the platform guide), how deep, and the question
  // to send, read with the conversation so far. Asked first by the browser, so it can show the route.
  router.post('/api/chat/route', async (req, res) => {
    const typed = String(req.body?.question ?? '').trim().slice(0, 2000);
    if (!typed) { res.status(400).json({ error: 'question is required' }); return; }
    const ledger: TokenLedger = {};
    const email = currentUserEmail(req);
    const selected: Selected = ['chat', 'agent'].includes(req.body?.selected) ? req.body.selected : 'auto';
    const session = typeof req.body?.sessionId === 'string' ? await ownedSession(req.body.sessionId, email).catch(() => null) : null;
    const history: SessionHistory = (session ? await loadHistory(appkit.lakebase, session.session_id as string).catch(() => null) : null)
      ?? { turns: [], summary: null, summarizedUpto: 0 };
    // Personal details are masked before the router's model sees the question, as before the engine.
    const route = await withTokenLedger(ledger, () => routeMessage(inputPatterns(typed).text, selected, history));
    rememberRoute(email, typed, route, ledger);
    res.json({
      destination: route.destination, mode: route.mode, intent: route.intent, escalated: route.escalated, reason: route.reason,
      confirm: route.confirm ?? false, repeatOf: route.repeatOf ?? null,
      method: route.method, model: route.model ? modelLabel(route.model) : null, ms: route.ms ?? null, fallback: route.fallback ?? null,
    });
  });

  router.post('/api/chat/sessions/:id/messages', (req, res) => {
    // Every model call made for this question lands in its token ledger (Monitoring's cost view).
    const tokens: TokenLedger = {};
    void withTokenLedger(tokens, () => handleSend(req, res, tokens)).catch((err: unknown) => {
      console.error('[chat] send failed:', err);
      if (!res.headersSent) res.status(500).json({ error: 'Could not answer that question' });
      else res.end();
    });
  });

  const handleSend = async (req: express.Request, res: express.Response, tokens: TokenLedger) => {
    const email = currentUserEmail(req);
    const content = String(req.body?.content ?? '').trim();
    let mode: Mode = req.body?.mode === 'agent' ? 'agent' : 'chat';
    // The router's decision for a typed question (made when the browser asked for the route), with its tokens.
    const remembered = takeRoute(email, content);
    if (remembered) for (const [f, e] of Object.entries(remembered.tokens)) tokens[f] = e;
    const session = await ownedSession(req.params.id as string, email);
    if (!session) {
      res.status(404).json({ error: 'session not found' });
      return;
    }
    if (!content) {
      res.status(400).json({ error: 'content is required' });
      return;
    }
    const trace = new Trace();
    const startedAt = trace.t0;
    // Input guardrails: the pattern checks decide the text at once (PII masked); the
    // classifier model runs while the session and cache are looked up.
    const patterns = inputPatterns(content);
    trace.add('Input checks: personal data, profanity, injection', 'guardrail', 0, trace.now());
    const classifierStart = trace.now();
    const guardInPromise = inputClassifier({ ...patterns, events: [...patterns.events] }).then((r) => {
      if (r.modelMs) trace.add(`Input classifier (${modelLabel(aiConfig.guardrails?.model)})`, 'model', classifierStart, r.modelMs);
      return r;
    });

    // Refresh: the user asked for a live answer in place of a cached one.
    const refreshOf = typeof req.body?.refreshOf === 'string' ? req.body.refreshOf : null;
    if (refreshOf) {
      const removed = await appkit.lakebase.query(
        `DELETE FROM chatapp.chat_messages
          WHERE message_id = $1 AND session_id = $2 AND role = 'assistant' AND from_cache
          RETURNING cache_key`,
        [refreshOf, session.session_id],
      );
      if (!removed.rows.length) {
        res.status(404).json({ error: 'cached answer not found' });
        return;
      }
    }

    // Only standalone questions use the cache: the first question of a chat,
    // a suggested question, or a refresh of one of those. Follow-ups depend
    // on the conversation, so they always go to the query engine.
    const { rows: earlier } = await appkit.lakebase.query(
      `SELECT COUNT(*)::int AS n FROM chatapp.chat_messages WHERE session_id = $1`,
      [session.session_id],
    );
    const standalone = cacheEnabled && (earlier[0].n === 0 || req.body?.standalone === true || Boolean(refreshOf));
    const versions = standalone ? await currentVersions(appkit.lakebase).catch(() => null) : null;

    // What's stored and sent on is the guarded question: PII never reaches the engine, the cache or the logs.
    const question = patterns.text;
    // The session so far (all modes, cached, platform and engine answers alike), for follow-ups.
    const history: SessionHistory = await loadHistory(appkit.lakebase, session.session_id as string)
      .catch(() => ({ turns: [], summary: null, summarizedUpto: 0 }));
    // Where it goes and how deep. Clicked suggestions and the Go deeper / Ask the data buttons say so
    // themselves; a typed question was routed when the browser asked (or is routed now, for API callers).
    // A refresh re-asks the same question the same way.
    const force = ['deeper', 'data', 'guide'].includes(req.body?.force) ? req.body.force as 'deeper' | 'data' | 'guide' : null;
    const selected: Selected = ['chat', 'agent', 'auto'].includes(req.body?.selected) ? req.body.selected : mode;
    let route: RouteDecision | null = refreshOf ? null
      : req.body?.preset === true ? fixedRoute(question, 'preset', mode, history.turns)
      : force ? fixedRoute(question, force, mode, history.turns)
      : remembered?.route ?? await trace.time(`Question router${aiConfig.autoMode.model ? ` (${modelLabel(aiConfig.autoMode.model)})` : ''}`, 'model',
          () => withTokenLedger(tokens, () => routeMessage(question, selected, history)));
    if (route && remembered && route.method === 'ai' && route.ms) trace.add(`Question router (${modelLabel(route.model)})`, 'model', 0, route.ms);
    if (route) mode = route.mode;
    // Questions about Lens MLOps itself are answered from the platform guide (the engine only knows the data).
    // The guide's model can still hand a typed question back as a data question (a safety net under the router).
    let platform: PlatformAnswer | null = null;
    if (route?.destination === 'platform' && !patterns.blocked) {
      const forced = route.method === 'preset' || route.method === 'button';   // a click says it's for the guide
      platform = await trace.time('Platform guide', aiConfig.platformHelp?.model ? 'model' : 'cache',
        () => answerPlatform(question, history.turns, { force: forced, context: historyWindow(history, aiConfig.contextBudgets.guide) })).catch(() => null);
      if (!platform) route = { ...route, destination: 'data', rules: [...route.rules, 'the guide said it was a data question'] };
    }
    // More depth or a repeat gets a fresh deep analysis: never the cached answer it is replacing.
    const key = versions && !patterns.blocked && !platform && !route?.escalated ? cacheKey(question, mode, versions) : null;
    let hit = key && !refreshOf
      ? await trace.time('Answer cache: exact match', 'cache', () => lookup(appkit.lakebase, key).catch(() => null))
      : null;

    // Semantic cache: on an exact miss, the nearest cached question if it's similar enough.
    let questionVector: number[] | null = null;
    let semantic: SemanticMatch | null = null;
    if (key && versions && !hit && aiConfig.semanticCache) {
      [questionVector] = await trace.time(`Question embedding (${modelLabel(aiConfig.semanticCache.embeddingModel)})`, 'model',
        () => embedQuestions([question]));
      const vec = questionVector;
      if (vec && !refreshOf) {
        semantic = await trace.time('Answer cache: similar questions', 'cache',
          () => semanticLookup(appkit.lakebase, question, mode, versions, vec).catch(() => null));
        hit = semantic?.hit ?? null;
      }
    }
    // An exact repeat was already screened when it was first answered, so it doesn't
    // wait for the classifier (the pattern checks above still apply); everything else does.
    const exactHit = Boolean(hit) && !semantic;
    let guardIn = exactHit ? { ...patterns, events: [...patterns.events] } : await guardInPromise;
    // An off-topic block can't apply to a question about the platform itself (other blocks still do).
    if (platform && guardIn.blocked && guardIn.events.filter((e) => e.action === 'block').every((e) => e.check === 'off_topic')) {
      guardIn = { ...guardIn, blocked: false, message: null };
    }
    const guardEvents: GuardEvent[] = [...guardIn.events];
    if (guardIn.blocked) hit = null;
    const piiRemoved = guardEvents.some((e) => e.stage === 'input' && e.check === 'pii' && e.action === 'redact');

    // The engine remembers its own conversation (one per mode) and keeps it: it holds every table, query and
    // step it produced. The app only fills the gap: the data turns that conversation has not seen (answered
    // by the other mode, from the cache, or before a retry), never guide turns, newest first in whole pairs
    // within the budget, older ones summarised (memory.ts). Nothing missed: the person's own words. A
    // self-contained question (first of a chat, or a suggestion) carries nothing.
    const ownConversation = (session[mode === 'agent' ? 'agent_conversation_id' : 'genie_conversation_id'] as string | null) ?? null;
    const gap = standalone || !aiConfig.memory ? null : engineContext(history.turns, ownConversation);
    const modeWord = mode === 'agent' ? 'deep analysis' : 'quick answer';
    const contextWhy = standalone || !history.turns.length ? 'a standalone question'
      : gap ? `${!ownConversation ? `no ${modeWord} conversation yet in this chat` : `data turns answered outside this ${modeWord} conversation`}: ${gap.full} sent in full, ${gap.summarised} summarised${gap.leftOut ? `, ${gap.leftOut} left out` : ''} (about ${gap.tokens} tokens)`
      : ownConversation ? 'the engine already has every data turn in this chat'
      : 'no earlier data turns in this chat (only questions about the app)';
    const preamble = hit || guardIn.blocked || platform || standalone ? ''
      : gap ? gap.text
      : !aiConfig.memory ? await crossModeContext(session.session_id as string, mode) : '';
    if (!refreshOf) {
      await appkit.lakebase.query(
        `INSERT INTO chatapp.chat_messages (session_id, user_email, role, content, mode, from_cache)
         VALUES ($1, $2, 'user', $3, $4, $5)`,
        [session.session_id, email, question, mode, Boolean(hit)],
      );
    }

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const send = (event: string, data: unknown) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    // Name the session from its first question while the engine works. A blocked
    // question, or one personal details were removed from, never names a session:
    // it gets a neutral warning title, which the next clean question replaces.
    const currentTitle = (session.title as string | null) ?? null;
    const guardedTitle = guardIn.blocked ? GUARDED_TITLES.blocked : piiRemoved ? GUARDED_TITLES.redacted : null;
    const needsTitle = !currentTitle || (isGuardedTitle(currentTitle) && !guardedTitle);
    const titlePromise: Promise<string | null> = !needsTitle
      ? Promise.resolve(null)
      : (guardedTitle ? Promise.resolve(guardedTitle) : generateTitle(question)).then(async (title) => {
          const { rows } = await appkit.lakebase.query(
            `UPDATE chatapp.chat_sessions SET title = $1
              WHERE session_id = $2 AND (title IS NULL OR title = $3) RETURNING title`,
            [title, session.session_id, currentTitle],
          );
          return rows.length ? title : null;
        });

    const convColumn = mode === 'agent' ? 'agent_conversation_id' : 'genie_conversation_id';
    const priorConversation = (session[convColumn] as string | null) ?? undefined;

    let answer: Answer | null;
    let success: boolean;
    let errorMessage: string | null = null;
    let genieConversationId: string | null = null;
    let genieMessageId: string | null = null;
    let details: Record<string, unknown>;
    let cacheInfo: Record<string, unknown> | null = null;
    let liveRun: GenieRun | null = null;
    let rewrittenUsed = false;   // the router's rewrite went to the engine (only after a guide answer)
    let storedKey: string | null = null;
    // A platform question is on-topic by definition: an off-topic warning doesn't apply to it.
    const offTopicOnly = guardEvents.length > 0 && guardEvents.every((e) => e.check === 'off_topic');
    const notices: string[] = guardIn.message && !guardIn.blocked && !(platform && offTopicOnly) ? [guardIn.message] : [];

    if (guardIn.blocked) {
      // Never sent to the engine; the reason is shown as the answer.
      answer = { version: 2, mode, text: guardIn.message ?? 'This question was blocked.', charts: [], guard: { blocked: true } };
      success = false;
      errorMessage = `Blocked by guardrail: ${guardEvents.filter((e) => e.action === 'block').map((e) => e.check).join(', ')}`;
      details = { queries: [] };
    } else if (platform) {
      // Answered from the platform guide; the engine and its conversation are not involved.
      const g = checkOutput(platform.text);
      guardEvents.push(...g.events);
      answer = {
        version: 2, mode, text: g.text, charts: [],
        platform: { method: platform.method, sections: platform.sections },
        suggestions: PLATFORM_FOLLOW_UPS.filter((f) => !platform.sections.includes(f.section)).slice(0, 3).map((f) => f.q),
      };
      success = true;
      details = { queries: [], platformHelp: { method: platform.method, sections: platform.sections, model: platform.model ?? null, ms: platform.ms } };
    } else if (hit) {
      // Same answer, charts, steps and SQL as when it was first produced; nothing
      // is sent to the engine, so the session's engine conversation is untouched.
      answer = {
        ...hit.answer,
        text: stripCitations(hit.answer.text), // entries cached before citations were stripped
        cache: { generatedAt: hit.createdAt, source: hit.source, similarTo: hit.similarTo },
      };
      success = true;
      genieConversationId = (hit.details.genieConversationId as string | null) ?? null;
      genieMessageId = (hit.details.genieMessageId as string | null) ?? null;
      cacheInfo = {
        hit: true, key: hit.key, source: hit.source, generatedAt: hit.createdAt,
        match: hit.similarTo ? 'semantic' : 'exact', similarTo: hit.similarTo ?? null,
        originalLatencyMs: hit.details.latencyMs ?? null, originalTimeline: hit.details.timeline ?? [],
      };
      details = { queries: hit.details.queries ?? [], judge: hit.details.judge ? { ...(hit.details.judge as object), reused: true } : undefined };
    } else {
      // The query engine can be briefly at capacity (RESOURCE_EXHAUSTED), which also surfaces as
      // "Self-suppression not permitted". Retry twice in a fresh conversation (carrying the recent
      // turns as context), then, for Deep analysis, fall back to a Quick answer rather than nothing.
      const progress = (p: { kind: string; text: string }) => send('progress', p);
      const attempt = async (m: Mode, text: string, conv: string | undefined) => {
        const name = m === 'agent' ? 'Lens query engine (Agent)' : 'Lens query engine';
        const start = trace.now();
        const r = await runGenie(appkit.genie, m, text, conv, progress);
        trace.add(r.success ? name : `${name}: ${busy(r.errorMessage) ? 'busy' : 'failed'}`, 'engine', start, r.latencyMs);
        if (r.success) trace.addStages(name, start, r.timeline);
        return r;
      };
      let usedMode: Mode = mode;
      // A retry starts a fresh engine conversation, so it gets the same context a follow-up gets
      // (a self-contained question still goes on its own).
      // A retry starts a fresh conversation, so every data turn of the chat counts as missed.
      const retryContext = async () => standalone ? ''
        : aiConfig.memory ? engineContext(history.turns, null)?.text ?? '' : preamble || await recentContext(session.session_id as string, question);
      // The engine gets the person's own words: its own memory, or the missed turns sent with them, explain
      // "the third one". The router's standalone rewrite is used only when the message points back at a guide
      // answer, which the engine is never sent ("No, you do it"). When the person asked for more, a note asks
      // for the fuller answer. A retry (a fresh conversation) gets the same question.
      const note = route?.escalated ? DEEPER_NOTE : '';
      const refersToGuide = Boolean(history.turns[history.turns.length - 1]?.platform) && route?.intent !== 'new_question';
      const useRewrite = refersToGuide && Boolean(route?.standalone) && route?.standalone !== question;
      const rewritten = note + (useRewrite ? route!.standalone : question);
      const engineQuestion = rewritten;
      rewrittenUsed = useRewrite;
      let run = await attempt(mode, preamble + engineQuestion, priorConversation);
      const retries: string[] = [];
      for (const wait of [3000, 8000]) {
        if (run.success || !busy(run.errorMessage)) break;
        retries.push(String(run.errorMessage).slice(0, 160));
        progress({ kind: 'notice', text: 'The analysis service is busy, retrying…' });
        await new Promise((r) => setTimeout(r, wait));
        run = await attempt(mode, (await retryContext()) + rewritten, undefined);
      }
      if (!run.success && mode === 'agent' && busy(run.errorMessage)) {
        retries.push(String(run.errorMessage).slice(0, 160));
        progress({ kind: 'notice', text: 'Deep analysis is busy, getting you a quick answer instead…' });
        usedMode = 'chat';
        run = await attempt('chat', (await retryContext()) + rewritten, undefined);
        if (run.success && run.answer) {
          run.answer.mode = 'chat';
          notices.push('Deep analysis was busy, so this is a quick answer. Ask again in a minute for the full step-by-step analysis.');
        }
      }
      liveRun = run;
      answer = run.answer;
      success = run.success;
      errorMessage = run.errorMessage;
      genieConversationId = run.conversationId ?? null;
      genieMessageId = run.genieMessageId;
      details = { timeline: run.timeline, queries: run.queries, ...(retries.length ? { retries, fallbackFrom: usedMode !== mode ? mode : undefined } : {}) };
      // Only a conversation that produced an answer is kept for follow-ups; a failed one would poison them.
      if (run.success) {
        await appkit.lakebase.query(
          `UPDATE chatapp.chat_sessions SET ${usedMode === 'agent' ? 'agent_conversation_id' : 'genie_conversation_id'} = $1, updated_at = now() WHERE session_id = $2`,
          [genieConversationId, session.session_id],
        );
      }
      // Empty tables aren't shown; where nothing else explains them, a one-line reason takes their place.
      if (answer && run.success) {
        const emptyStart = trace.now();
        const dropped = await dropEmptyCharts(question, answer).catch(() => null);
        if (dropped) {
          details.emptyResults = dropped;
          if (dropped.explained) trace.add('Empty results explained', 'model', emptyStart, trace.now() - emptyStart);
        }
      }
      // A follow-up the engine answers from its own memory runs no query, so it comes back
      // without charts ("show the visualizations again", or the same question repeated).
      // Then the chat's most recent charts are shown again, labelled as such.
      if (answer && run.success && !answer.charts.length && history.turns.length) {
        const asksForCharts = /\b(charts?|graphs?|visuali[sz]\w*|plots?|diagrams?|again)\b/i.test(question);
        const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
        const repeated = history.turns.some((t) => norm(t.q) === norm(question));
        if (asksForCharts || repeated || isVagueFollowUp(question)) {
          const { rows } = await appkit.lakebase.query(
            `SELECT attachment_json->'charts' AS charts FROM chatapp.chat_messages
              WHERE session_id = $1 AND role = 'assistant' AND jsonb_array_length(COALESCE(attachment_json->'charts', '[]'::jsonb)) > 0
              ORDER BY created_at DESC LIMIT 1`,
            [session.session_id],
          ).catch(() => ({ rows: [] as Array<Record<string, unknown>> }));
          const earlier = (rows[0]?.charts ?? []) as Answer['charts'];
          if (earlier.length) {
            answer.charts = earlier;
            answer.text = answer.text.replace(/\[\[chart:[^\]]+\]\]/g, '');
            notices.push('The charts below are from the earlier answer in this chat.');
            details.reusedCharts = earlier.length;
          }
        }
      }
      // Output guardrails before the answer is sent or cached.
      if (answer?.text) {
        const outStart = trace.now();
        const g = checkOutput(answer.text);
        answer.text = g.text;
        guardEvents.push(...g.events);
        if (g.notice) notices.push(g.notice);
        trace.add('Output checks: personal data, profanity, policy wording', 'guardrail', outStart, trace.now() - outStart);
      }
      // Cache it only if the engine saw the question on its own (no earlier turns),
      // otherwise the answer may lean on context a later asker won't have.
      let stored = false;
      if (key && versions && !priorConversation && !preamble && run.success && usedMode === mode) {
        stored = await store(appkit.lakebase, key, question, mode, versions, run, 'live', questionVector).then(() => true, () => false);
        if (stored) storedKey = key;
      }
      if (standalone) {
        cacheInfo = { hit: false, refreshed: Boolean(refreshOf), stored, closest: semantic?.best ?? null };
      }
    }
    if (answer && notices.length) answer.guard = { ...(answer.guard ?? {}), notices };
    // How it was routed, shown under the answer (with Go deeper / Ask the data where they apply).
    if (answer && route) {
      answer.route = { destination: platform ? 'platform' : 'data', intent: route.intent, reason: route.reason, escalated: route.escalated, method: route.method, asked: route.standalone };
    }
    const latencyMs = Date.now() - startedAt;
    if (hit) details.timeline = [{ stage: 'Answered from cache', ms: latencyMs }];
    const sources = sourcesFromSql(((details.queries ?? []) as Array<{ sql?: string }>).map((q) => q.sql));

    // Suggested next questions: the engine's own, topped up to three by a small model
    // (Agent mode never suggests any; Chat mode often gives one).
    const followStart = trace.now();
    const engineSuggestions = answer?.suggestions ?? [];
    const followPromise: Promise<string[]> = answer && !guardIn.blocked && !platform && answer.text && engineSuggestions.length < 3
      ? suggestFollowUps(question, answer.text).then((q) => {
          if (aiConfig.followUps) trace.add(`Follow-up suggestions (${modelLabel(aiConfig.followUps.model)})`, 'model', followStart, trace.now() - followStart);
          return q;
        })
      : Promise.resolve([]);

    let assistantMessageId: string | null = null;
    if (answer && (answer.text || answer.charts.length)) {
      send('answer', answer);
      const saved = await appkit.lakebase.query(
        `INSERT INTO chatapp.chat_messages
           (session_id, user_email, role, content, mode, attachment_json, genie_conversation_id, genie_message_id,
            from_cache, cache_key)
         VALUES ($1, $2, 'assistant', $3, $4, $5, $6, $7, $8, $9)
         RETURNING message_id`,
        [session.session_id, email, answer.text, mode, JSON.stringify(answer), genieConversationId, genieMessageId,
          Boolean(hit), hit?.key ?? key],
      );
      assistantMessageId = saved.rows[0]?.message_id as string;
      send('saved', { messageId: assistantMessageId, feedbackEnabled: Boolean(genieConversationId && genieMessageId) });
      if (hit || guardIn.blocked || platform) {
        await appkit.lakebase.query(`UPDATE chatapp.chat_sessions SET updated_at = now() WHERE session_id = $1`, [session.session_id]);
      }
      const extra = await followPromise.catch(() => [] as string[]);
      const seen = new Set(engineSuggestions.map((q) => q.toLowerCase()));
      const followUps = [...engineSuggestions, ...extra.filter((q) => !seen.has(q.toLowerCase()))].slice(0, 3);
      if (extra.length && followUps.length) {
        answer.suggestions = followUps;
        send('followups', { messageId: assistantMessageId, questions: followUps });
        await appkit.lakebase.query(
          `UPDATE chatapp.chat_messages SET attachment_json = jsonb_set(attachment_json, '{suggestions}', $2::jsonb) WHERE message_id = $1`,
          [assistantMessageId, JSON.stringify(followUps)],
        );
      }
    } else {
      send('error', { error: errorMessage ?? 'No answer was returned', busy: busy(errorMessage) });
    }

    const reusedJudge = details.judge as { score?: number } | undefined;
    const logDetails = () => ({
      ...details,
      charts: answer?.charts.length ?? 0,
      agentSteps: answer?.steps?.length ?? null,
      answerPreview: (answer?.text ?? '').slice(0, 1500),
      contextCarriedOver: Boolean(preamble),
      // What the engine was sent besides the question, and why (Observability's trace).
      context: liveRun ? {
        sent: Boolean(preamble), rewritten: rewrittenUsed, why: contextWhy,
        ...(gap ? { full: gap.full, summarised: gap.summarised, leftOut: gap.leftOut, tokens: gap.tokens } : {}),
      } : undefined,
      memory: preamble && aiConfig.memory
        ? { turns: history.turns.length, summarized: history.summary ? history.summarizedUpto : 0, chars: preamble.length }
        : undefined,
      genieConversationId,
      genieMessageId,
      cache: cacheInfo,
      router: route ? {
        destination: platform ? 'platform' : route.destination, mode: route.mode, intent: route.intent, escalated: route.escalated,
        method: route.method, selected: route.selected, model: route.model ?? null, ms: route.ms ?? null, confidence: route.confidence,
        reason: route.reason, rules: route.rules, fallback: route.fallback ?? null,
        standalone: route.standalone !== question ? route.standalone : undefined,
      } : undefined,
      guardrails: guardEvents.length ? { events: guardEvents, classifierMs: guardIn.modelMs } : undefined,
      trace: trace.toJSON(),
      tokens,
      sources,
      followUps: answer?.suggestions?.length ?? 0,
    });
    const logged = await appkit.lakebase.query(
      `INSERT INTO chatapp.usage_log
         (session_id, user_email, mode, question, success, latency_ms, error_message, assistant_message_id, details,
          from_cache, guard_action, faithfulness)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING event_id`,
      [session.session_id, email, mode, question, success, latencyMs, errorMessage, assistantMessageId, JSON.stringify(logDetails()),
        Boolean(hit), strongestAction(guardEvents), reusedJudge?.score ?? null],
    );

    const title = await titlePromise.catch(() => null);
    if (title) send('session_title', { sessionId: session.session_id, title });
    send('done', {
      success, latencyMs, fromCache: Boolean(hit), blocked: guardIn.blocked,
      judging: Boolean(liveRun?.success && answer?.text && aiConfig.judge),
    });
    res.end();

    // Conversation memory: every N question-and-answer pairs, older turns fold into the session summary.
    if (assistantMessageId) {
      const memEventId = logged.rows[0]?.event_id as string | undefined;
      void withTokenLedger(tokens, () => maybeCompact(appkit.lakebase, session.session_id as string))
        .then(async () => {
          // The summary's model tokens belong to the question that triggered it (Monitoring's cost view).
          if (tokens.memory && memEventId) {
            await appkit.lakebase.query(`UPDATE chatapp.usage_log SET details = jsonb_set(details, '{tokens}', $2::jsonb) WHERE event_id = $1`,
              [memEventId, JSON.stringify(tokens)]);
          }
        })
        .catch((err: unknown) => console.warn('[memory] compaction failed:', err instanceof Error ? err.message : err));
    }

    // Answer-quality judge: after the user has the answer, so it never adds to their wait.
    if (liveRun?.success && answer?.text) {
      const eventId = logged.rows[0]?.event_id as string | undefined;
      const judgeStart = trace.now();
      void judgeAnswer(question, answer.text, liveRun.evidence).then(async (verdict) => {
        if (!verdict) return;
        trace.add(`Answer quality judge (${modelLabel(aiConfig.judge?.model) || 'numbers check'})`, 'model', judgeStart, trace.now() - judgeStart);
        if (eventId) {
          await appkit.lakebase.query(
            `UPDATE chatapp.usage_log SET faithfulness = $2, details = $3::jsonb WHERE event_id = $1`,
            [eventId, verdict.score, JSON.stringify({ ...logDetails(), judge: verdict })],
          );
        }
        if (storedKey) await attachJudge(appkit.lakebase, storedKey, verdict);
      }).catch((err: unknown) => console.warn('[judge] failed:', err instanceof Error ? err.message : err));
    }
  };

  // --- how an answer was made: trace, sources, checks, quality -------------

  router.get('/api/chat/messages/:id/trace', async (req, res) => {
    const email = currentUserEmail(req);
    const { rows } = await appkit.lakebase.query(
      `SELECT u.details, u.faithfulness, u.success, u.created_at, u.from_cache, u.latency_ms, u.mode, u.question
         FROM chatapp.chat_messages m
         JOIN chatapp.usage_log u ON u.assistant_message_id = m.message_id
        WHERE m.message_id = $1 AND m.user_email = $2`,
      [req.params.id, email],
    );
    const r = rows[0];
    if (!r) {
      // Just after an answer is shown, its log entry may still be being written.
      const { rows: own } = await appkit.lakebase.query(
        `SELECT 1 FROM chatapp.chat_messages WHERE message_id = $1 AND user_email = $2`, [req.params.id, email]);
      if (own.length) res.json({ pending: true, quality: { status: 'pending', guard: [], sources: [], warnBelow: aiConfig.judge?.warnBelow ?? 0.7 } });
      else res.status(404).json({ error: 'answer not found' });
      return;
    }
    const d = (r.details ?? {}) as Row;
    const ledger = (d.tokens ?? {}) as TokenLedger;
    res.json({
      question: r.question,
      mode: r.mode,
      latencyMs: r.latency_ms,
      quality: qualitySummary(r),
      trace: d.trace ?? null,
      timeline: d.timeline ?? [],
      queries: ((d.queries ?? []) as Array<Row>).map((q) => ({ title: q.title, sql: q.sql, rows: q.rows })),
      cache: d.cache ?? null,
      guard: ((d.guardrails as Row | undefined)?.events ?? []) as GuardEvent[],
      tokens: Object.entries(ledger).map(([feature, e]) => ({ feature, model: modelLabel(e.model), calls: e.calls, input: e.input, output: e.output })),
      cost: costOf(ledger),
    });
  });

  // --- answer feedback: stored here and sent to the engine's monitor ----------

  router.post('/api/chat/messages/:id/feedback', async (req, res) => {
    const email = currentUserEmail(req);
    const raw = req.body?.rating;
    const value = raw === 'up' ? 1 : raw === 'down' ? -1 : null;
    // A thumbs-down can say why; it then waits in Monitoring's review queue.
    const REASONS = ['wrong_numbers', 'wrong_data', 'not_answered', 'unclear', 'other'];
    const reason = value === -1 && REASONS.includes(String(req.body?.reason)) ? String(req.body.reason) : null;
    const comment = value === -1 ? String(req.body?.comment ?? '').trim().slice(0, 500) || null : null;
    const { rows } = await appkit.lakebase.query(
      `UPDATE chatapp.chat_messages SET feedback = $1, feedback_at = now(), feedback_reason = $4, feedback_comment = $5
        WHERE message_id = $2 AND user_email = $3 AND role = 'assistant'
        RETURNING genie_conversation_id, genie_message_id, cache_key`,
      [value, req.params.id, email, reason, comment],
    );
    if (!rows.length) {
      res.status(404).json({ error: 'answer not found' });
      return;
    }
    // A thumbs-down removes the answer from the cache, so the next person gets a fresh one.
    if (value === -1 && rows[0].cache_key) await evict(appkit.lakebase, rows[0].cache_key as string).catch(() => {});
    await appkit.lakebase.query(
      `UPDATE chatapp.usage_log
          SET feedback = $1, feedback_reason = $3, feedback_comment = $4,
              review_status = CASE WHEN $1::smallint = -1 THEN COALESCE(NULLIF(review_status, 'dismissed'), 'open')
                                   WHEN review_status = 'open' THEN NULL ELSE review_status END
        WHERE assistant_message_id = $2`,
      [value, req.params.id, reason, comment],
    );

    // Saved; reply now. The rating is also forwarded to the query engine's feedback API
    // (it accepts Chat and Agent answers) in the background, so the user never waits on it.
    res.json({ rating: raw ?? null });
    const { genie_conversation_id: conv, genie_message_id: msg } = rows[0] as Record<string, string | null>;
    if (GENIE_AGENT_ID && conv && msg) {
      getExecutionContext().client.apiClient.request({
        path: `/api/2.0/genie/spaces/${GENIE_AGENT_ID}/conversations/${conv}/messages/${msg}/feedback`,
        method: 'POST',
        headers: new Headers({ 'Content-Type': 'application/json' }),
        raw: false,
        payload: { rating: value === 1 ? 'POSITIVE' : value === -1 ? 'NEGATIVE' : 'NONE' },
      } as never).catch((err: unknown) => console.warn('Engine feedback not delivered:', err instanceof Error ? err.message : err));
    }
  });

  // --- monitoring / observability --------------------------------------

  router.get('/api/admin/usage', async (_req, res) => {
    const [totals, byUser, byMode, recent] = await Promise.all([
      appkit.lakebase.query(
        `SELECT COUNT(*)::int AS total_questions,
                COUNT(*) FILTER (WHERE success)::int AS successful,
                COUNT(*) FILTER (WHERE guard_action = 'blocked')::int AS blocked,
                COUNT(*) FILTER (WHERE faithfulness IS NOT NULL)::int AS judged,
                ROUND(AVG(faithfulness)::numeric, 3) AS avg_faithfulness,
                COUNT(*) FILTER (WHERE faithfulness < $1)::int AS low_faithfulness,
                ROUND(AVG((details->'judge'->'llm'->'metrics'->>'relevance')::numeric), 3) AS avg_relevance,
                ROUND(AVG((details->'judge'->'llm'->'metrics'->>'completeness')::numeric), 3) AS avg_completeness,
                ROUND(AVG((details->'judge'->'llm'->'metrics'->>'safety')::numeric), 3) AS avg_safety,
                COALESCE(SUM((details->'cache'->>'originalLatencyMs')::numeric) FILTER (WHERE from_cache), 0)::bigint AS engine_ms_saved,
                COUNT(*) FILTER (WHERE details->'cache'->>'match' = 'semantic')::int AS semantic_hits,
                ROUND(AVG(latency_ms)) AS avg_latency_ms,
                COUNT(*) FILTER (WHERE feedback = 1)::int AS helpful,
                COUNT(*) FILTER (WHERE feedback = -1)::int AS not_helpful,
                COUNT(*) FILTER (WHERE from_cache)::int AS cache_hits,
                ROUND(AVG(latency_ms) FILTER (WHERE from_cache)) AS avg_cache_latency_ms,
                ROUND(AVG(latency_ms) FILTER (WHERE NOT from_cache)) AS avg_live_latency_ms
           FROM chatapp.usage_log`,
        [aiConfig.judge?.warnBelow ?? 0.7],
      ),
      appkit.lakebase.query(
        `SELECT u.user_email, COUNT(*)::int AS questions,
                COUNT(*) FILTER (WHERE u.success)::int AS successful,
                ROUND(AVG(u.latency_ms)) AS avg_latency_ms,
                COUNT(DISTINCT u.session_id)::int AS sessions,
                MAX(u.created_at) AS last_active
           FROM chatapp.usage_log u
          GROUP BY u.user_email
          ORDER BY questions DESC
          LIMIT 50`,
      ),
      appkit.lakebase.query(
        `SELECT mode, COUNT(*)::int AS questions,
                COUNT(*) FILTER (WHERE success)::int AS successful,
                COUNT(*) FILTER (WHERE from_cache)::int AS cache_hits,
                ROUND(AVG(latency_ms) FILTER (WHERE NOT from_cache)) AS avg_latency_ms
           FROM chatapp.usage_log
          GROUP BY mode`,
      ),
      appkit.lakebase.query(
        `SELECT u.event_id, u.assistant_message_id, u.session_id, s.title AS session_title, u.user_email, u.mode, u.question, u.success,
                u.latency_ms, u.error_message, u.feedback, u.feedback_reason, u.feedback_comment, u.details, u.from_cache, u.guard_action, u.faithfulness, u.created_at
           FROM chatapp.usage_log u
           LEFT JOIN chatapp.chat_sessions s ON s.session_id = u.session_id
          ORDER BY u.created_at DESC
          LIMIT 100`,
      ),
    ]);
    // The cache view is optional: an older schema without the cache tables still gets the rest.
    const cache = await Promise.all([
      appkit.lakebase.query(
        `SELECT question, mode, source, hits, created_at, expires_at, last_hit_at
           FROM chatapp.answer_cache c
          WHERE (c.data_version, c.genie_version) = (
                  (SELECT version FROM chatapp.cache_versions WHERE name = 'data'),
                  (SELECT version FROM chatapp.cache_versions WHERE name = 'genie'))
            AND (expires_at IS NULL OR expires_at > now())
          ORDER BY hits DESC, created_at DESC
          LIMIT 50`,
      ),
      appkit.lakebase.query(`SELECT name, version, updated_at FROM chatapp.cache_versions ORDER BY name`),
      appkit.lakebase.query(
        `SELECT versions_key, status, answered, started_at, finished_at FROM chatapp.prewarm_runs
          ORDER BY started_at DESC LIMIT 1`,
      ),
    ]).then(([entries, versions, prewarm]) => ({
      enabled: cacheEnabled, entries: entries.rows, versions: versions.rows, lastPrewarm: prewarm.rows[0] ?? null,
    })).catch(() => null);
    // Guardrails and judge: what's configured, and what has fired.
    const ai = await Promise.all([
      appkit.lakebase.query(
        `SELECT e->>'stage' AS stage, e->>'check' AS check_name, e->>'action' AS action, COUNT(*)::int AS n
           FROM chatapp.usage_log, jsonb_array_elements(details->'guardrails'->'events') e
          GROUP BY 1, 2, 3 ORDER BY n DESC`,
      ),
      appkit.lakebase.query(
        `SELECT u.created_at, u.user_email, u.mode, u.question, u.guard_action, details->'guardrails'->'events' AS events
           FROM chatapp.usage_log u WHERE u.guard_action IS NOT NULL ORDER BY u.created_at DESC LIMIT 50`,
      ),
    ]).then(([counts, events]) => ({
      config: aiConfigSummary(),
      guardCounts: counts.rows,
      guardEvents: events.rows,
    })).catch(() => ({ config: aiConfigSummary(), guardCounts: [], guardEvents: [] }));
    res.json({
      totals: totals.rows[0],
      byUser: byUser.rows,
      byMode: byMode.rows,
      // Older answers still carry Genie's citation links to the workspace.
      recent: recent.rows.map((r) => {
        const d = r.details as { answerPreview?: unknown } | null;
        if (d && typeof d.answerPreview === 'string') d.answerPreview = stripCitations(d.answerPreview);
        return r;
      }),
      cache,
      ai,
      cost: await costView(),
      feedbackQueue: await feedbackQueue(),
    });
  });

  /**
   * Monitoring's trend and breakdown view for a time window (?days=1|7|30|0 for all):
   * daily volume, speed, quality and cache use; latency percentiles by mode; the
   * most-asked questions; why people gave 👎; and a health verdict for the banner.
   */
  router.get('/api/admin/insights', async (req, res) => {
    const days = Math.max(0, Math.min(365, Number(req.query.days ?? 30) || 0));
    const since = days ? `created_at >= now() - interval '${days} days'` : 'TRUE';
    const empty = { rows: [] as Row[] };
    const run = (sql: string) => appkit.lakebase.query(sql).catch((err: unknown) => {
      console.warn('[insights]', err instanceof Error ? err.message : err);
      return empty;
    });
    const [daily, latency, topQuestions, reasons, people, summary, hourly] = await Promise.all([
      run(`SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day,
                  COUNT(*) FILTER (WHERE mode = 'chat')::int AS quick,
                  COUNT(*) FILTER (WHERE mode = 'agent')::int AS deep,
                  COUNT(*) FILTER (WHERE NOT success AND guard_action IS DISTINCT FROM 'blocked')::int AS failed,
                  COUNT(*) FILTER (WHERE guard_action = 'blocked')::int AS blocked,
                  ROUND(AVG(latency_ms) FILTER (WHERE NOT from_cache AND mode = 'chat')) AS quick_ms,
                  ROUND(AVG(latency_ms) FILTER (WHERE NOT from_cache AND mode = 'agent')) AS deep_ms,
                  ROUND(AVG(faithfulness)::numeric, 3) AS faithfulness,
                  ROUND(AVG(CASE WHEN from_cache THEN 1.0 ELSE 0 END), 3) AS cache_rate
             FROM chatapp.usage_log WHERE ${since} GROUP BY 1 ORDER BY 1`),
      run(`SELECT mode, COUNT(*)::int AS n,
                  percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms) AS p50,
                  percentile_cont(0.9) WITHIN GROUP (ORDER BY latency_ms) AS p90,
                  percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) AS p95
             FROM chatapp.usage_log WHERE ${since} AND success AND NOT from_cache GROUP BY mode`),
      run(`SELECT MIN(question) AS question, COUNT(*)::int AS times, COUNT(DISTINCT user_email)::int AS people,
                  ROUND(AVG(faithfulness)::numeric, 3) AS faithfulness,
                  COUNT(*) FILTER (WHERE from_cache)::int AS from_cache
             FROM chatapp.usage_log WHERE ${since} AND COALESCE(guard_action, '') <> 'blocked'
            GROUP BY lower(regexp_replace(trim(question), '[[:punct:][:space:]]+', ' ', 'g'))
            ORDER BY times DESC, MAX(created_at) DESC LIMIT 8`),
      run(`SELECT COALESCE(feedback_reason, 'none') AS reason, COUNT(*)::int AS n
             FROM chatapp.usage_log WHERE ${since} AND feedback = -1 GROUP BY 1 ORDER BY n DESC`),
      run(`SELECT COUNT(DISTINCT user_email)::int AS users, COUNT(DISTINCT session_id)::int AS sessions,
                  COUNT(DISTINCT user_email) FILTER (WHERE created_at >= now() - interval '1 day')::int AS active_today
             FROM chatapp.usage_log WHERE ${since}`),
      run(`SELECT COUNT(*)::int AS questions,
                  ROUND(AVG(CASE WHEN success OR guard_action = 'blocked' THEN 1.0 ELSE 0 END), 3) AS success_rate,
                  ROUND(AVG(faithfulness)::numeric, 3) AS faithfulness,
                  ROUND(AVG(CASE WHEN from_cache THEN 1.0 ELSE 0 END), 3) AS cache_rate,
                  COUNT(*) FILTER (WHERE feedback = 1)::int AS up, COUNT(*) FILTER (WHERE feedback = -1)::int AS down,
                  COUNT(*) FILTER (WHERE guard_action IS NOT NULL)::int AS guarded
             FROM chatapp.usage_log WHERE ${since}`),
      run(`SELECT EXTRACT(HOUR FROM created_at)::int AS hour, COUNT(*)::int AS n
             FROM chatapp.usage_log WHERE ${since} GROUP BY 1 ORDER BY 1`),
    ]);
    // Governance figures for the Observability headline and its tabs.
    const [recon, pii, stages, lowConf, traces] = await Promise.all([
      run(`SELECT COALESCE(SUM((details->'judge'->'numeric'->>'checked')::int), 0)::int AS checked,
                  COALESCE(SUM((details->'judge'->'numeric'->>'found')::int), 0)::int AS found,
                  COUNT(*) FILTER (WHERE details->'judge'->'llm' IS NOT NULL)::int AS llm_judged,
                  COALESCE(SUM(jsonb_array_length(COALESCE(details->'judge'->'llm'->'unsupported', '[]'::jsonb))), 0)::int AS unsupported
             FROM chatapp.usage_log WHERE ${since} AND details ? 'judge'`),
      run(`SELECT e->>'stage' AS stage, e->>'action' AS action, COUNT(*)::int AS n
             FROM chatapp.usage_log, jsonb_array_elements(details->'guardrails'->'events') e
            WHERE ${since} AND e->>'check' = 'pii' GROUP BY 1, 2`),
      run(`SELECT st->>'stage' AS stage, mode, ROUND(AVG((st->>'ms')::numeric)) AS avg_ms, COUNT(*)::int AS n
             FROM chatapp.usage_log, jsonb_array_elements(details->'timeline') st
            WHERE ${since} AND NOT from_cache AND success GROUP BY 1, 2 HAVING COUNT(*) >= 2 ORDER BY avg_ms DESC LIMIT 16`),
      run(`SELECT event_id, created_at, user_email, mode, question, faithfulness,
                  details->'judge'->'llm'->'unsupported' AS unsupported, details->'judge'->'numeric'->'missing' AS missing
             FROM chatapp.usage_log WHERE ${since} AND faithfulness < ${aiConfig.judge?.warnBelow ?? 0.7}
            ORDER BY created_at DESC LIMIT 10`),
      run(`SELECT COUNT(*)::int AS total, MAX(created_at) AS latest FROM chatapp.usage_log`),
    ]);
    // How questions were routed (recorded from the router's introduction on).
    const [routing, routingRules] = await Promise.all([
      run(`SELECT details->'router'->>'destination' AS destination, details->'router'->>'mode' AS mode,
                  details->'router'->>'method' AS method, COALESCE((details->'router'->>'escalated')::boolean, false) AS escalated,
                  COUNT(*)::int AS n
             FROM chatapp.usage_log WHERE ${since} AND details ? 'router' GROUP BY 1, 2, 3, 4`),
      run(`SELECT r AS rule, COUNT(*)::int AS n
             FROM chatapp.usage_log, jsonb_array_elements_text(COALESCE(details->'router'->'rules', '[]'::jsonb)) r
            WHERE ${since} GROUP BY 1 ORDER BY n DESC LIMIT 8`),
    ]);
    // Health: what a non-technical owner should look at first.
    const s = summary.rows[0] ?? {};
    const issues: string[] = [];
    if (Number(s.questions) && Number(s.success_rate) < 0.9) issues.push(`only ${Math.round(Number(s.success_rate) * 100)}% of questions answered`);
    if (s.faithfulness !== null && s.faithfulness !== undefined && Number(s.faithfulness) < (aiConfig.judge?.warnBelow ?? 0.7) + 0.1) {
      issues.push(`answer quality ${Math.round(Number(s.faithfulness) * 100)}%`);
    }
    if (Number(s.down) > Number(s.up) && Number(s.down) >= 3) issues.push('more 👎 than 👍');
    res.json({
      days, daily: daily.rows, latency: latency.rows, topQuestions: topQuestions.rows, reasons: reasons.rows,
      people: people.rows[0] ?? {}, summary: s, hourly: hourly.rows,
      reconciliation: recon.rows[0] ?? {}, pii: pii.rows, stages: stages.rows,
      lowConfidence: lowConf.rows.map((r) => ({ ...r, question: String(r.question ?? '').slice(0, 300) })),
      traces: traces.rows[0] ?? {},
      routing: routing.rows, routingRules: routingRules.rows,
      health: { status: !Number(s.questions) ? 'idle' : issues.length ? 'attention' : 'healthy', issues },
    });
  });

  /** Tokens by feature and model (questions and eval runs), with an estimated cost when prices are set. */
  const costView = async () => {
    const [byFeature, evals] = await Promise.all([
      appkit.lakebase.query(
        `SELECT f.key AS feature, f.value->>'model' AS model, SUM((f.value->>'calls')::int)::int AS calls,
                SUM((f.value->>'input')::bigint)::bigint AS input, SUM((f.value->>'output')::bigint)::bigint AS output,
                COUNT(DISTINCT u.event_id)::int AS questions
           FROM chatapp.usage_log u, jsonb_each(u.details->'tokens') f
          GROUP BY 1, 2 ORDER BY input DESC`,
      ),
      appkit.lakebase.query(
        `SELECT f.key AS feature, f.value->>'model' AS model, SUM((f.value->>'calls')::int)::int AS calls,
                SUM((f.value->>'input')::bigint)::bigint AS input, SUM((f.value->>'output')::bigint)::bigint AS output
           FROM chatapp.eval_runs r, jsonb_each(r.summary->'tokens') f
          GROUP BY 1, 2`,
      ).catch(() => ({ rows: [] as Row[] })),
    ]).catch(() => [{ rows: [] as Row[] }, { rows: [] as Row[] }]);
    const shape = (r: Row, source: string) => {
      const entry = { model: String(r.model), calls: Number(r.calls), input: Number(r.input), output: Number(r.output) };
      return { source, feature: r.feature, modelLabel: modelLabel(entry.model), ...entry, questions: r.questions ?? null, cost: costOf({ x: entry }) };
    };
    return {
      priced: Object.keys(aiConfig.pricing).length > 0,
      rows: [...byFeature.rows.map((r) => shape(r, 'questions')), ...evals.rows.map((r) => shape(r, 'evals'))],
    };
  };

  const feedbackQueue = async () => {
    const { rows } = await appkit.lakebase.query(
      `SELECT event_id, created_at, user_email, mode, question, feedback_reason, feedback_comment,
              COALESCE(review_status, 'open') AS review_status, reviewed_by, reviewed_at, faithfulness,
              details->>'answerPreview' AS answer_preview
         FROM chatapp.usage_log
        WHERE feedback = -1
        ORDER BY (COALESCE(review_status, 'open') = 'open') DESC, created_at DESC
        LIMIT 100`,
    ).catch(() => ({ rows: [] as Row[] }));
    return rows.map((r) => ({ ...r, answer_preview: stripCitations(String(r.answer_preview ?? '')).slice(0, 600) }));
  };

  // A reviewer works through thumbs-down answers: fixed, dismissed, or turned into an eval case.
  router.patch('/api/admin/feedback/:eventId', async (req, res) => {
    const email = currentUserEmail(req);
    const status = String(req.body?.status ?? '');
    if (!['open', 'fixed', 'dismissed', 'added_to_evals'].includes(status)) {
      res.status(400).json({ error: 'status must be open, fixed, dismissed or added_to_evals' });
      return;
    }
    const { rows } = await appkit.lakebase.query(
      `UPDATE chatapp.usage_log SET review_status = $2, reviewed_by = $3, reviewed_at = now()
        WHERE event_id = $1 AND feedback = -1
        RETURNING question, mode, feedback_reason, feedback_comment`,
      [req.params.eventId, status, email],
    );
    if (!rows.length) {
      res.status(404).json({ error: 'feedback not found' });
      return;
    }
    if (status === 'added_to_evals') {
      const r = rows[0];
      const note = [r.feedback_reason, r.feedback_comment].filter(Boolean).join(': ');
      await appkit.lakebase.query(
        `INSERT INTO chatapp.eval_cases (category, question, mode, source, notes)
         VALUES ('accuracy', $1, $2, 'feedback', $3)
         ON CONFLICT (category, question) DO UPDATE SET enabled = true, notes = EXCLUDED.notes`,
        [r.question, r.mode, note ? `From a thumbs-down (${note})` : 'From a thumbs-down'],
      );
    }
    res.json({ status });
  });

  return router;
}
