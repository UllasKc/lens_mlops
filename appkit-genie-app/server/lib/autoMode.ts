import { aiConfig } from './aiConfig.js';
import { chat, forFeature, parseJsonObject, type TokenLedger } from './models.js';

/**
 * Auto mode: decides per question whether a Quick answer (the engine's Chat mode, ~20 s)
 * is enough or the question needs a Deep analysis (its Agent mode, 1-3 min).
 *
 * - "ai": a small model reads the question and decides (configurable per deployment).
 * - "rules": a word rule, no model (used where model calls should be kept to a minimum).
 * The AI route falls back to the rule if the model is slow or its reply can't be read,
 * so a question is never held up.
 */

export type Mode = 'chat' | 'agent';
export interface RouteResult {
  mode: Mode;
  method: 'ai' | 'rules';
  reason: string;
  model?: string;
  ms?: number;
  fallback?: string;
}

const DEEP = /\b(why|how (can|could|should|do|would) we|what should|recommend|strateg(y|ies)|improve|root cause|driving|compare|comparison|analy[sz]e|analysis|investigat|prioriti[sz]e|plan|explain|briefing|brief|impact|trade-?off|correlat\w*|what (is|are) (causing|behind))\b/;
/** "Which / what / show / list / how many …" questions that only look something up. */
const LOOKUP_START = /^\s*(which|what (is|are|was|were)|show|list|give me|how (many|much)|top \d+|count)\b/;

/** The word rule: reasoning words or long multi-part questions go deep; plain lookups stay quick. */
export function rulesMode(question: string): RouteResult {
  const t = String(question).toLowerCase();
  const words = t.split(/\s+/).filter(Boolean).length;
  if (words > 22) return { mode: 'agent', method: 'rules', reason: 'long, multi-part question' };
  const m = t.match(DEEP);
  if (m) return { mode: 'agent', method: 'rules', reason: `asks for reasoning ("${m[0]}")` };
  // "happening" / "spike" / "concentrated" only mean analysis when the question isn't a plain lookup.
  if (!LOOKUP_START.test(t) && /\b(happening|spikes?|concentrat\w*)\b/.test(t)) return { mode: 'agent', method: 'rules', reason: 'asks what happened or where it concentrates' };
  return { mode: 'chat', method: 'rules', reason: 'a direct lookup' };
}

const PROMPT = `You route questions for an assistant that monitors a fleet of industrial ML models. It has two modes:
- "quick": one SQL query answers it. Looking up, listing, ranking, filtering or comparing a few figures
  ("Which models are drifting?", "Total cost savings this week", "Which models have confidence below 60%?",
  "False positive rate by model version", "Status of all compressors at Houston 1").
- "deep": needs several queries and reasoning: explaining why or what happened, what to do, recommendations,
  prioritising actions, briefings, or questions with several parts
  ("What's happening with MDL_061? Explain the spike.", "Which models need action first, and why?",
  "Give me a daily executive briefing", "Are anomalies at the same site correlated?").
Greetings, help requests and anything unclear are "quick". The question may be in any language.
A PREVIOUS QUESTION, when given, is only there so you can tell what a short follow-up refers to.
Reply with JSON only: {"mode": "quick" | "deep", "reason": "<under 12 words>"}`;

/** Where the conversation is, for a follow-up: the previous question and how it was answered. */
export interface RouteContext { previousQuestion: string; previousMode: Mode; previousWasPlatform: boolean }

/**
 * For the person asking, it's one assistant: a short follow-up ("tell me more", "and for
 * Mumbai?") continues at the depth of the answer it follows. It can go deeper (a "why" after
 * a quick answer), but a follow-up to a deep analysis is never cut down to a quick answer.
 */
export async function routeFollowUp(question: string, ctx: RouteContext | null, isFollowUp: boolean): Promise<RouteResult> {
  const route = await routeQuestion(question, isFollowUp ? ctx?.previousQuestion : undefined);
  if (ctx && isFollowUp && !ctx.previousWasPlatform && ctx.previousMode === 'agent' && route.mode === 'chat') {
    return { ...route, mode: 'agent', reason: 'a follow-up to a deep analysis' };
  }
  return route;
}

export async function routeQuestion(question: string, previousQuestion?: string): Promise<RouteResult> {
  const cfg = aiConfig.autoMode;
  if (cfg.method !== 'ai' || !cfg.model) return rulesMode(question);
  const t0 = Date.now();
  try {
    const { text } = await forFeature('auto_mode', () => chat(cfg.model!, [
      { role: 'system', content: PROMPT },
      { role: 'user', content: (previousQuestion ? `PREVIOUS QUESTION: ${previousQuestion.slice(0, 300)}\n` : '') + `QUESTION: ${question.slice(0, 800)}` },
    ], { maxTokens: 60, timeoutMs: cfg.timeoutMs }));
    const j = parseJsonObject<{ mode?: string; reason?: string }>(text);
    const mode = j?.mode === 'deep' ? 'agent' : j?.mode === 'quick' ? 'chat' : null;
    if (!mode) return { ...rulesMode(question), fallback: 'the model reply could not be read', ms: Date.now() - t0 };
    return { mode, method: 'ai', reason: String(j?.reason ?? '').slice(0, 120), model: cfg.model, ms: Date.now() - t0 };
  } catch (err) {
    return { ...rulesMode(question), fallback: err instanceof Error ? err.message.slice(0, 120) : 'model call failed', ms: Date.now() - t0 };
  }
}

/**
 * The browser asks for the route first (so it can show the right progress), then sends the
 * question. The decision and its tokens are kept briefly so the question's log records them.
 */
const recent = new Map<string, { at: number; route: RouteResult; tokens: TokenLedger }>();
const key = (email: string, q: string) => `${email}\n${q.trim()}`;
export function rememberRoute(email: string, question: string, route: RouteResult, tokens: TokenLedger) {
  const now = Date.now();
  for (const [k, v] of recent) if (now - v.at > 10 * 60_000) recent.delete(k);
  recent.set(key(email, question), { at: now, route, tokens });
}
export function takeRoute(email: string, question: string) {
  const k = key(email, question);
  const v = recent.get(k);
  recent.delete(k);
  return v ?? null;
}
