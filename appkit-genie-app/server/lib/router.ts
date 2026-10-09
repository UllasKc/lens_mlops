import { aiConfig } from './aiConfig.js';
import { rulesMode, type Mode } from './autoMode.js';
import { historyWindow, isVagueFollowUp, type SessionHistory, type Turn } from './memory.js';
import { chat, forFeature, parseJsonObject, type TokenLedger } from './models.js';
import { DATA_WORDS, platformCandidate } from './platformGuide.js';

/**
 * The router: for each typed question, where it goes (the query engine or the platform
 * guide), how deep (Quick answer or Deep analysis), and the question to send, read in the
 * light of the conversation so far.
 *
 * 1. Signals, no model: is this a repeat of an earlier question, a request for more depth
 *    ("this is not enough"), pushback ("you do it"), or worded as a platform question?
 * 2. One model call (auto_mode in the deploy config) reads the recent turns and returns
 *    destination, depth, intent, a standalone rewrite of the question and its confidence.
 * 3. Safety rules over the model's decision, so the conversation can't get stuck: more
 *    depth or a repeat goes to Deep analysis with a fresh answer; pushback after a guide
 *    answer goes to the data; the guide is used only when the model is sure; the person's
 *    own Quick/Deep choice is kept unless they ask for more. In Auto, the model decides the
 *    depth of every question, follow-ups included. Without the model (off, slow or
 *    unreadable) the same rules run on the signals alone.
 */

export type Destination = 'data' | 'platform';
export type Intent = 'new_question' | 'follow_up' | 'more_depth' | 'repeat' | 'pushback' | 'platform_help';
export type Selected = 'auto' | Mode;

export interface RouteDecision {
  destination: Destination;
  mode: Mode;
  intent: Intent;
  /** The question as sent to the engine: the typed one, or a standalone rewrite of a follow-up. */
  standalone: string;
  /** More depth or a repeat: a Deep analysis, with a fresh answer (never from the cache). */
  escalated: boolean;
  /** Asked again after a good answer: the person chooses between a deep analysis and the answer again. */
  confirm?: boolean;
  /** The earlier question this one repeats (so the Assistant can show its answer again). */
  repeatOf?: string;
  confidence: number | null;
  reason: string;
  /** Safety rules that changed or confirmed the decision, in words, for Observability. */
  rules: string[];
  method: 'ai' | 'rules' | 'preset' | 'button';
  selected: Selected;
  model?: string;
  ms?: number;
  fallback?: string;
}

// --- signals (no model) -----------------------------------------------------------------

/** "Not enough", "I need more detail", "go deeper": the last answer fell short. */
export const MORE_DEPTH = /\b(not (enough|sufficient|detailed|complete)|isn'?t enough|need (more|a lot more|much more|further)|want (more|a fuller|a deeper)|more (detail|details|info|information|depth|insight|analysis)|go (deeper|further)|dig (deeper|into)|deep(er)? (dive|analysis|research)|in (more )?(depth|detail)|full(er)? (analysis|picture|answer|breakdown)|elaborate|too (short|brief|shallow|vague|high[- ]level)|that'?s (it|all)\?|incomplete|superficial|explain (more|further|in detail))\b/i;

/** "You do it", "answer it yourself": the person wanted the answer, not the steps to find it. */
export const PUSHBACK = /\b(you do it|do it (yourself|for me)|answer (it |this |that )?(yourself|for me|directly)|(i )?(can'?t|cannot|don'?t want to) do (it|this|that)|just (tell|show|give) me|not the steps|i asked (for|about) the (data|numbers)|show me the (data|numbers|answer)|that'?s not what i asked|not what i (asked|wanted|meant)|wrong answer|you (didn'?t|did not) answer)\b/i;

/** Starts like a new question ("why is…", "which…"), not a request for more of the same. */
const ASKS_NEW = /^\s*(why|what|which|how|where|when|who|whose|is|are|was|were|does|do|did|show|list|compare|rank|give me the)\b/i;

const STOP = new Set('a an the of in on for to and or is are was were be what which who how why when where do does did can could should would will we our my me i you your it this that these those with by from at as about please tell show give list'.split(' '));
const words = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, ' ').split(/\s+/).filter((w) => w && !STOP.has(w));

/** An earlier question in this chat that this one repeats (same content words, near enough). */
export function repeatOf(question: string, turns: Turn[]): Turn | null {
  const q = new Set(words(question));
  if (q.size < 3) return null;
  for (const t of [...turns].reverse().slice(0, 8)) {
    const p = new Set(words(t.q));
    if (!p.size) continue;
    // Each side has a word the other lacks (a different site, product or number: "…at Houston" / "…at Phoenix"):
    // another question, not a repeat. Rewordings ("need" / "require") are left to the router model.
    if ([...q].some((w) => !p.has(w)) && [...p].some((w) => !q.has(w))) continue;
    const shared = [...q].filter((w) => p.has(w)).length;
    if (shared / new Set([...q, ...p]).size >= 0.75) return t;
  }
  return null;
}

export interface Signals { repeat: Turn | null; moreDepth: boolean; pushback: boolean; platformWording: boolean; dataWords: boolean; vague: boolean }

export function signalsOf(question: string, turns: Turn[]): Signals {
  return {
    repeat: repeatOf(question, turns),
    moreDepth: MORE_DEPTH.test(question),
    pushback: PUSHBACK.test(question),
    platformWording: platformCandidate(question, true),
    dataWords: DATA_WORDS.test(question),
    vague: turns.length > 0 && isVagueFollowUp(question),
  };
}

// --- the model's reading ------------------------------------------------------------------

export interface ModelReading { destination: Destination; depth: Mode; intent: Intent; standalone: string; confidence: number; reason: string }

const PROMPT = `You are the router of Lens MLOps, an analytics assistant that monitors a fleet of industrial ML models
(models and versions, predictions, confidence, drift, accuracy and error, alerts, anomalies and incidents, false
positives, downtime, savings and business value, by business unit, site, asset type, criticality and owner team).
For the user's latest message, decide:

destination:
- "data": anything answered from the model-monitoring data: figures, models, lists, comparisons, trends, causes,
  recommendations, "where is the drift concentrated", "where are we losing value", "which models". This is the default.
- "platform": ONLY questions about using the Lens MLOps app itself: its tabs, buttons, filters, menus, exports,
  features, how answers are checked, what it can do. "Where is the drift concentrated?" is data; "Where is the
  site filter?" is platform.

depth:
- "quick": one query answers it: a lookup, list, ranking, filter or a few figures ("Which models are drifting?",
  "Total cost savings this week", "Which models have confidence below 60%?", "Status of all compressors at Houston 1").
- "deep": several queries and reasoning: why something happened, root causes, what to do, recommendations,
  prioritising, briefings, trade-offs, or several parts ("What's happening with MDL_061? Explain the spike.",
  "Which models need action first, and why?", "Give me a daily executive briefing").
For a follow-up, judge what the new message itself needs; the depth of the previous answer is only a hint
(a single figure after a deep analysis is "quick"; a "why" after a quick answer is "deep").

intent:
- "new_question": a fresh question.
- "follow_up": continues the conversation ("and for Houston 1?", "tell me more").
- "more_depth": ONLY when the user says the previous answer was not enough, too short or missing detail, or asks
  for more detail or to go deeper on the same thing. A new question about something in the answer ("why is the
  third one so high?", "what about Phoenix?") is "follow_up", not "more_depth".
- "repeat": asks again, in the same or other words, something already asked in this conversation (it was not answered well).
- "pushback": rejects the previous answer ("you do it", "that's not what I asked", "answer it yourself").
- "platform_help": a question about the app itself.

standalone: the user's request rewritten as one self-contained question that makes sense without the
conversation, in the user's language, at most 40 words. Resolve "this", "that", "it", "you do it", "more" from the
conversation. For "more_depth", "repeat" or "pushback", it is the earlier request the user still wants answered,
asking for the fuller answer. For a "new_question", repeat the question as it is.

Rules: if the previous answer was "Answered by: the Lens MLOps guide" and the user pushes back, repeats or asks for
more, the destination is "data". When unsure between data and platform, choose "data".
confidence: 0 to 1, how sure you are of the destination.
Reply with JSON only:
{"destination":"data"|"platform","depth":"quick"|"deep","intent":"...","standalone":"...","confidence":0.0,"reason":"<under 15 words>"}`;

const INTENTS: Intent[] = ['new_question', 'follow_up', 'more_depth', 'repeat', 'pushback', 'platform_help'];

async function readWithModel(question: string, history: SessionHistory): Promise<{ reading: ModelReading | null; ms: number; fallback?: string }> {
  const cfg = aiConfig.autoMode;
  const t0 = Date.now();
  if (cfg.method !== 'ai' || !cfg.model) return { reading: null, ms: 0 };
  // The chat so far: all of it when small, else the summary plus the newest whole question-and-answer pairs.
  const recent = historyWindow(history, aiConfig.contextBudgets.router);
  try {
    const { text } = await forFeature('router', () => chat(cfg.model!, [
      { role: 'system', content: PROMPT },
      { role: 'user', content: `${recent ? `CONVERSATION SO FAR:\n${recent}\n\n` : 'This is the first message of the conversation.\n\n'}LATEST MESSAGE: ${question.slice(0, 1000)}` },
    ], { maxTokens: 220, timeoutMs: cfg.timeoutMs }));
    const j = parseJsonObject<Record<string, unknown>>(text);
    const destination = j?.destination === 'platform' ? 'platform' : j?.destination === 'data' ? 'data' : null;
    const depth = j?.depth === 'deep' ? 'agent' : j?.depth === 'quick' ? 'chat' : null;
    if (!j || !destination || !depth) return { reading: null, ms: Date.now() - t0, fallback: 'the model reply could not be read' };
    const intent = INTENTS.includes(j.intent as Intent) ? (j.intent as Intent) : 'new_question';
    const conf = Number(j.confidence);
    return {
      reading: {
        destination, depth, intent,
        standalone: String(j.standalone ?? '').replace(/\s+/g, ' ').trim().slice(0, 600),
        confidence: Number.isFinite(conf) ? Math.max(0, Math.min(1, conf)) : 0.5,
        reason: String(j.reason ?? '').slice(0, 140),
      },
      ms: Date.now() - t0,
    };
  } catch (err) {
    return { reading: null, ms: Date.now() - t0, fallback: err instanceof Error ? err.message.slice(0, 120) : 'model call failed' };
  }
}

// --- the safety rules (pure: unit-tested without a model) ------------------------------------

const lastDataQuestion = (turns: Turn[]) => [...turns].reverse().find((t) => !t.platform && !PUSHBACK.test(t.q) && !MORE_DEPTH.test(t.q))?.q
  ?? [...turns].reverse().find((t) => !PUSHBACK.test(t.q) && !MORE_DEPTH.test(t.q))?.q ?? null;

export function decide(question: string, selected: Selected, turns: Turn[], s: Signals, m: ModelReading | null): Omit<RouteDecision, 'method' | 'model' | 'ms' | 'fallback'> {
  const rules: string[] = [];
  const last = turns[turns.length - 1];
  const afterGuide = Boolean(last?.platform);

  // Intent: the model's reading, with the clear signals taking precedence.
  let intent: Intent = m?.intent ?? (s.platformWording ? 'platform_help' : s.vague ? 'follow_up' : 'new_question');
  // The model's "more depth" needs the words for it: a new question about the answer ("why is the third one so
  // high?") is a follow-up, answered at the chosen depth, not an escalation.
  if (intent === 'more_depth' && !s.moreDepth && ASKS_NEW.test(question)) intent = 'follow_up';
  if (s.moreDepth) intent = 'more_depth';
  else if (s.pushback) intent = 'pushback';
  else if (s.repeat && intent !== 'more_depth') intent = 'repeat';

  // Destination.
  let destination: Destination;
  if (m) {
    destination = m.destination;
    if (destination === 'platform' && m.confidence < 0.7) { destination = 'data'; rules.push('unsure whether it was about the app, so the data'); }
    if (destination === 'platform' && s.dataWords && !s.platformWording && !/\b(tabs?|pages?|buttons?|filters?|drop-?downs?|menus?|click|screen|export|download|explorer|assistant|observability|dashboard|settings)\b/i.test(question)) {
      destination = 'data'; rules.push('names model data and nothing on screen, so the data');
    }
  } else {
    // No model: platform wording, or a "tell me more" right after a guide answer.
    destination = s.platformWording || (afterGuide && s.vague && !s.dataWords) ? 'platform' : 'data';
  }
  // After a genuine app question ("What does Observability show?"), a short "tell me more" with no data words
  // continues the guide, whatever the model read. After a data question the guide answered by mistake, it doesn't.
  // The guide's question was really about the app: app wording, or a data word next to something on screen
  // ("Where is the site filter?"), or no data words at all. Not a data question the guide answered by mistake.
  const guideQuestion = afterGuide && (platformCandidate(last.q, false) || !DATA_WORDS.test(last.q));
  const continuesGuide = guideQuestion && (s.vague || intent === 'more_depth' || intent === 'follow_up') && !s.dataWords && !s.pushback && !s.repeat;
  if (destination === 'data' && continuesGuide) {
    destination = 'platform';
    rules.push('continues the answer about the app');
  }
  // Pushback after a genuine app question, naming no data ("Where is the site filter?" → "No, you do it"), stays
  // with the guide: the person wants the app done for them, which the guide can answer; the data can't.
  const pushbackOnGuide = guideQuestion && intent === 'pushback' && !s.dataWords;
  if (pushbackOnGuide && destination === 'data') {
    destination = 'platform';
    rules.push('pushback on an answer about the app stays with the guide');
  }
  // Otherwise pushback, a repeat or asking for more never gets the guide again.
  if (destination === 'platform' && ['pushback', 'more_depth', 'repeat'].includes(intent) && !continuesGuide && !pushbackOnGuide && (afterGuide || !s.platformWording)) {
    destination = 'data';
    rules.push(afterGuide ? 'never the guide twice when the person pushes back' : 'pushback goes to the data');
  }

  // Depth.
  // Asked again: straight to a deep analysis when the earlier answer fell short (said little, scored low on
  // completeness, or got a 👎); after a good answer, the person is asked first (it takes 1-3 minutes).
  const repeated = intent === 'repeat' ? (s.repeat ?? last ?? null) : null;
  const confirm = destination === 'data' && intent === 'repeat' && Boolean(repeated) && !repeated!.weak;
  if (confirm) rules.push('asked again after a good answer, so the person chooses');
  const escalated = destination === 'data' && !confirm && (intent === 'more_depth' || intent === 'repeat' || (intent === 'pushback' && afterGuide === false));
  let mode: Mode;
  if (destination === 'platform') mode = 'chat';
  else if (escalated) {
    mode = 'agent';
    rules.push(intent === 'repeat' ? 'asked again after a weak answer, so a deep analysis with a fresh answer' : intent === 'pushback' ? 'the answer was rejected, so a deep analysis' : 'asked for more, so a deep analysis');
    if (selected === 'chat') rules.push('the latest message outranks the Quick answer setting');
  } else if (selected !== 'auto') mode = selected;
  else {
    // The model judges what a follow-up needs ("what's the total?" after a deep analysis can be quick).
    // Only without the model, a vague follow-up ("and for Houston 1?") keeps the depth of the answer it follows.
    mode = m ? m.depth : rulesMode(question).mode;
    if (!m && mode === 'chat' && last && !last.platform && last.mode === 'agent' && (intent === 'follow_up' || s.vague)) {
      mode = 'agent'; rules.push('a follow-up to a deep analysis stays deep (word rules)');
    }
  }

  // The question sent to the engine.
  let standalone = question;
  if (destination === 'data' && intent !== 'new_question') {
    // A "rewrite" that only repeats the message ("No, you do it") is no use to the engine.
    const same = (a: string, b: string) => words(a).join(' ') === words(b).join(' ');
    const rewrite = m?.standalone && m.standalone.length >= 8 && !same(m.standalone, question) ? m.standalone : null;
    const earlier = ['more_depth', 'repeat', 'pushback'].includes(intent) ? (s.repeat?.q ?? lastDataQuestion(turns)) : null;
    standalone = rewrite ?? (earlier && earlier !== question ? earlier : question);
    if (standalone !== question) rules.push('sent as a standalone question');
  }

  const reason = rules[0] ?? (m?.reason || (destination === 'platform' ? 'a question about the Lens MLOps app' : mode === 'agent' ? 'needs analysis' : 'a direct lookup'));
  return { destination, mode, intent, standalone, escalated, ...(confirm ? { confirm, repeatOf: repeated!.q } : {}), confidence: m ? m.confidence : null, reason, rules, selected };
}

/** Routes a typed question. Never throws: without a usable model the rules decide on the signals alone. */
export async function routeMessage(question: string, selected: Selected, history: SessionHistory): Promise<RouteDecision> {
  const s = signalsOf(question, history.turns);
  const { reading, ms, fallback } = await readWithModel(question, history);
  const d = decide(question, selected, history.turns, s, reading);
  return { ...d, method: reading ? 'ai' : 'rules', model: reading ? aiConfig.autoMode.model ?? undefined : undefined, ms: ms || undefined, fallback };
}

/** Clicked questions and buttons skip the model: the click says where they go. */
export function fixedRoute(question: string, how: 'preset' | 'deeper' | 'data' | 'guide', mode: Mode, turns: Turn[]): RouteDecision {
  if (how === 'guide') {
    // Regenerate on a guide answer: the guide again.
    return { destination: 'platform', mode: 'chat', intent: 'platform_help', standalone: question, escalated: false, confidence: null,
      reason: 'Regenerate on a guide answer', rules: [], method: 'button', selected: mode };
  }
  if (how === 'preset') {
    const platform = platformCandidate(question, true);
    return { destination: platform ? 'platform' : 'data', mode: platform ? 'chat' : mode, intent: platform ? 'platform_help' : 'new_question',
      standalone: question, escalated: false, confidence: null, reason: platform ? 'a suggested question about the app' : 'a suggested question',
      rules: [], method: 'preset', selected: mode };
  }
  if (how === 'deeper') {
    return { destination: 'data', mode: 'agent', intent: 'more_depth', standalone: question, escalated: true, confidence: null,
      reason: 'Go deeper was pressed', rules: ['a deep analysis with a fresh answer'], method: 'button', selected: 'agent' };
  }
  return { destination: 'data', mode, intent: turns.length ? 'pushback' : 'new_question', standalone: question, escalated: false, confidence: null,
    reason: 'Ask the data was pressed', rules: ['answered from the data, not the guide'], method: 'button', selected: mode };
}

/**
 * The browser asks for the route first (so it can show the right progress), then sends the
 * question. The decision and its tokens are kept briefly so the question's log records them.
 */
const remembered = new Map<string, { at: number; route: RouteDecision; tokens: TokenLedger }>();
const memoKey = (email: string, q: string) => `${email}\n${q.trim()}`;
export function rememberRoute(email: string, question: string, route: RouteDecision, tokens: TokenLedger) {
  const now = Date.now();
  for (const [k, v] of remembered) if (now - v.at > 10 * 60_000) remembered.delete(k);
  remembered.set(memoKey(email, question), { at: now, route, tokens });
}
export function takeRoute(email: string, question: string) {
  const k = memoKey(email, question);
  const v = remembered.get(k);
  remembered.delete(k);
  return v ?? null;
}

/** What the engine is told when the person asked for more: the fuller answer, not the same one again. */
export const DEEPER_NOTE = 'The person found the earlier answer to this not detailed enough. Give a fuller, multi-step analysis with the key figures, what is driving them, and what to do. Question: ';
