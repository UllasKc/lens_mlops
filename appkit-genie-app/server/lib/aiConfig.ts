/**
 * Optional AI features, configured per deployment in the deploy config and
 * passed in as one JSON env var (LENSS_AI_CONFIG) by deploy.py. deploy.py only
 * includes a model here after checking its serving endpoint exists, and binds
 * it to the app with CAN_QUERY. A missing section means the feature is off.
 */

import { modelLabel } from './models.js';

export type GuardAction = 'block' | 'redact' | 'warn' | 'flag' | 'off';

export interface AiConfig {
  semanticCache: { threshold: number; embeddingModel: string } | null;
  guardrails: {
    model: string | null; // AI classifier; null = pattern checks only
    input: { pii: GuardAction; profanity: GuardAction; prompt_injection: GuardAction; off_topic: GuardAction };
    output: { pii: GuardAction; profanity: GuardAction; policy_checks: GuardAction };
  } | null;
  judge: { model: string | null; samplePercent: number; warnBelow: number } | null; // model null = numbers check only
  /** Suggested next questions when the query engine offers none. */
  followUps: { model: string } | null;
  /** Auto mode: how a question is routed to Quick answer or Deep analysis ("ai" model or "rules"). */
  autoMode: { method: 'ai' | 'rules'; model: string | null; timeoutMs: number };
  /** Questions about the platform itself: answered from the platform guide (by a model, or the guide's own text). */
  platformHelp: { method: 'ai' | 'guide'; model: string | null } | null;
  /** Conversation memory: follow-ups carry a summary of older turns (compacted every N pairs) plus recent turns. */
  memory: { compactEvery: number; model: string | null } | null;
  /**
   * How much of the chat each reader gets, in estimated tokens (about 4 characters each), always in whole
   * question-and-answer pairs, newest first. router / guide: the router's and the platform guide's model.
   * genie: the turns the engine's conversation missed; its latest missed pair may go up to genieLatestMax.
   * sendAllBelow: a chat this small goes to the router whole, with no summary.
   */
  contextBudgets: { router: number; guide: number; genie: number; genieLatestMax: number; sendAllBelow: number };
  /** Evaluation suite: how many ground-truth (accuracy) questions one run may ask. */
  evals: { maxAccuracyCases: number } | null;
  /** Optional USD per million tokens, per model endpoint, for Monitoring's cost estimate. */
  pricing: Record<string, { input: number; output: number }>;
}

const DEFAULT_BUDGETS = { router: 2000, guide: 1000, genie: 2500, genieLatestMax: 4000, sendAllBelow: 2000 };
function budgetsFrom(cm: Record<string, unknown> | undefined): AiConfig['contextBudgets'] {
  const n = (v: unknown, d: number) => (Number.isFinite(Number(v)) && Number(v) >= 200 ? Math.min(20000, Math.round(Number(v))) : d);
  return {
    router: n(cm?.router_tokens, DEFAULT_BUDGETS.router),
    guide: n(cm?.guide_tokens, DEFAULT_BUDGETS.guide),
    genie: n(cm?.genie_tokens, DEFAULT_BUDGETS.genie),
    genieLatestMax: n(cm?.genie_latest_max_tokens, DEFAULT_BUDGETS.genieLatestMax),
    sendAllBelow: n(cm?.send_all_below_tokens, DEFAULT_BUDGETS.sendAllBelow),
  };
}

function parse(): AiConfig {
  const off: AiConfig = { semanticCache: null, guardrails: null, judge: null, followUps: null,
    autoMode: { method: 'rules', model: null, timeoutMs: 6000 }, platformHelp: { method: 'guide', model: null },
    memory: { compactEvery: 5, model: null }, evals: null, pricing: {}, contextBudgets: budgetsFrom(undefined) };
  const raw = process.env.LENSS_AI_CONFIG;
  if (!raw) return off;
  try {
    const c = JSON.parse(raw) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    const sc = c.semantic_cache;
    const g = c.guardrails;
    const j = c.faithfulness_judge;
    const pct = (v: unknown, d: number) => (v === undefined || v === null || v === '' ? d : Number(v) > 1 ? Number(v) / 100 : Number(v));
    const action = (v: unknown, d: GuardAction): GuardAction =>
      ['block', 'redact', 'warn', 'flag', 'off'].includes(String(v)) ? (v as GuardAction) : d;
    return {
      semanticCache: sc && sc.embedding_model && Number(sc.threshold) > 0
        ? { threshold: Number(sc.threshold) > 1 ? Number(sc.threshold) / 100 : Number(sc.threshold), embeddingModel: String(sc.embedding_model) }
        : null,
      guardrails: g
        ? {
            model: g.model ? String(g.model) : null,
            input: {
              pii: action(g.input?.pii, 'redact'),
              profanity: action(g.input?.profanity, 'block'),
              prompt_injection: action(g.input?.prompt_injection, 'block'),
              off_topic: action(g.input?.off_topic, 'warn'),
            },
            output: {
              pii: action(g.output?.pii, 'redact'),
              profanity: action(g.output?.profanity, 'redact'),
              policy_checks: action(g.output?.policy_checks, 'flag'),
            },
          }
        : null,
      judge: j
        ? {
            model: j.model ? String(j.model) : null,
            samplePercent: Math.max(0, Math.min(100, Number(j.sample_percent ?? 100))),
            warnBelow: pct(j.warn_below, 0.7),
          }
        : null,
      followUps: c.follow_ups?.model ? { model: String(c.follow_ups.model) } : null,
      // deploy.py resolves the method and model (rules when no model is available).
      autoMode: c.auto_mode?.method === 'ai' && c.auto_mode?.model
        ? { method: 'ai', model: String(c.auto_mode.model), timeoutMs: Math.max(1000, Math.min(15000, Number(c.auto_mode.timeout_ms ?? 6000))) }
        : { method: 'rules', model: null, timeoutMs: 6000 },
      // enabled: false (or method "off") sends every question straight to the query engine.
      platformHelp: c.platform_help?.enabled === false || c.platform_help?.method === 'off'
        ? null
        : c.platform_help?.method === 'ai' && c.platform_help?.model
          ? { method: 'ai', model: String(c.platform_help.model) }
          : { method: 'guide', model: null },
      contextBudgets: budgetsFrom(c.conversation_memory),
      memory: c.conversation_memory?.enabled === false
        ? null
        : { compactEvery: Math.max(2, Math.min(20, Number(c.conversation_memory?.compact_every ?? 5))),
            model: c.conversation_memory?.model ? String(c.conversation_memory.model) : null },
      evals: c.evals ? { maxAccuracyCases: Math.max(0, Math.min(50, Number(c.evals.max_accuracy_cases ?? 5))) } : null,
      pricing: Object.fromEntries(Object.entries((c.pricing ?? {}) as Record<string, { input?: number; output?: number }>)
        .map(([m, p]) => [m, { input: Number(p?.input ?? 0), output: Number(p?.output ?? 0) }])),
    };
  } catch (err) {
    console.warn('LENSS_AI_CONFIG is not valid JSON; AI features are off:', err instanceof Error ? err.message : err);
    return off;
  }
}

export const aiConfig: AiConfig = parse();

/** What Monitoring and the Responsible AI page show: on/off, thresholds, and each model by its own name. */
export function aiConfigSummary() {
  const c = aiConfig;
  return {
    semanticCache: c.semanticCache ? { threshold: c.semanticCache.threshold, model: modelLabel(c.semanticCache.embeddingModel) } : null,
    guardrails: c.guardrails ? { model: modelLabel(c.guardrails.model) || null, input: c.guardrails.input, output: c.guardrails.output } : null,
    judge: c.judge ? { model: modelLabel(c.judge.model) || null, samplePercent: c.judge.samplePercent, warnBelow: c.judge.warnBelow } : null,
    followUps: c.followUps ? { model: modelLabel(c.followUps.model) } : null,
    autoMode: { method: c.autoMode.method, model: c.autoMode.model ? modelLabel(c.autoMode.model) : null },
    platformHelp: c.platformHelp ? { method: c.platformHelp.method, model: c.platformHelp.model ? modelLabel(c.platformHelp.model) : null } : null,
    memory: c.memory ? { compactEvery: c.memory.compactEvery, model: c.memory.model ? modelLabel(c.memory.model) : null } : null,
    evals: c.evals,
    titles: process.env.LENSS_TITLE_ENDPOINT ? { model: modelLabel(process.env.LENSS_TITLE_ENDPOINT) } : null,
    priced: Object.keys(c.pricing).length > 0,
  };
}
