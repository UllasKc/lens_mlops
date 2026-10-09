import { aiConfig } from './aiConfig.js';
import { chat, forFeature } from './models.js';
import type { Lakebase } from './answerCache.js';

/**
 * Conversation memory: what each reader gets of the chat so far, so "tell me more about
 * this" or "and for Houston 1?" are understood. Always whole question-and-answer pairs,
 * newest first, within a budget of estimated tokens (contextBudgets in aiConfig).
 *   - The query engine keeps its own conversation per mode (with every table, query and
 *     step it made). It is sent only the data turns that conversation missed (other mode,
 *     cache, before a retry), never guide turns: engineContext().
 *   - The router and the platform guide's model have no memory of their own: they get the
 *     whole chat when it is small, else the summary plus the newest pairs: historyWindow().
 *   - Older turns: a running summary, compacted every N pairs (by a small model, or a
 *     no-model digest), after the answer is sent, so it never adds to anyone's wait; and a
 *     one-line summary per turn where the stored summary doesn't reach.
 */

/** One question and its answer. `conv`: the engine conversation that produced the answer (none for guide or blocked answers). */
export interface Turn {
  q: string; a: string; platform: boolean; sections: string[]; mode: string; conv?: string | null;
  /** Stopped by a guardrail; answered from the answer cache; the answer's first table (with its query). */
  blocked?: boolean; cached?: boolean;
  table?: { title: string; columns: string[]; rows: Array<Array<string | null>>; sql?: string } | null;
  /** The answer fell short: said little, scored low on completeness, or got a 👎 (for "asked again"). */
  weak?: boolean;
}
export interface SessionHistory { turns: Turn[]; summary: string | null; summarizedUpto: number }

const KEEP_VERBATIM = 2;     // pairs always kept word for word after a compaction

const cfg = () => aiConfig.memory;

/** The first chart of an answer as a table: title, column names, rows and its query. */
function tableOf(c: unknown): Turn['table'] {
  const x = c as { title?: string; sql?: string; columns?: Array<{ name: string }>; rows?: Array<Array<string | null>> } | null;
  if (!x || !Array.isArray(x.rows) || !Array.isArray(x.columns)) return null;
  return { title: String(x.title ?? ''), columns: x.columns.map((k) => String(k.name)), rows: x.rows, sql: x.sql };
}

/**
 * An answer that fell short: a line or two, a question back, little text with no chart (the same test as the
 * Assistant's Go deeper offer), completeness scored below the warning level, or a 👎.
 */
export function weakAnswer(text: string, charts: number, completeness: number | null, thumbsDown: boolean): boolean {
  const t = text.replace(/\[\[chart:[^\]]+\]\]/g, '').trim();
  const thin = t.length < 140 || (!charts && t.length < 320) || (/\?\s*$/.test(t) && t.length < 400);
  return thin || thumbsDown || (completeness !== null && completeness < (aiConfig.judge?.warnBelow ?? 0.7));
}

/** The session's question-and-answer pairs (oldest first) and its stored summary. */
export async function loadHistory(db: Lakebase, sessionId: string): Promise<SessionHistory> {
  const { rows } = await db.query(
    `SELECT m.role, m.content, m.mode, (m.attachment_json ? 'platform') AS platform, m.attachment_json->'platform'->'sections' AS sections,
            m.genie_conversation_id, m.from_cache, COALESCE((m.attachment_json->'guard'->>'blocked')::boolean, false) AS blocked,
            m.attachment_json->'charts'->0 AS chart, COALESCE(jsonb_array_length(m.attachment_json->'charts'), 0) AS n_charts, m.feedback,
            (SELECT (u.details->'judge'->'llm'->'metrics'->>'completeness')::numeric FROM chatapp.usage_log u
              WHERE u.assistant_message_id = m.message_id LIMIT 1) AS completeness
       FROM chatapp.chat_messages m WHERE m.session_id = $1 ORDER BY m.created_at`,
    [sessionId],
  );
  const turns: Turn[] = [];
  let pending: { q: string; mode: string } | null = null;
  for (const r of rows) {
    if (r.role === 'user') pending = { q: String(r.content ?? ''), mode: String(r.mode) };
    else if (pending) { turns.push({ q: pending.q, a: String(r.content ?? ''), platform: Boolean(r.platform), sections: Array.isArray(r.sections) ? r.sections.map(String) : [], mode: pending.mode, conv: (r.genie_conversation_id as string | null) ?? null,
        blocked: Boolean(r.blocked), cached: Boolean(r.from_cache), table: tableOf(r.chart),
        weak: weakAnswer(String(r.content ?? ''), Number(r.n_charts), r.completeness === null ? null : Number(r.completeness), r.feedback === -1) });
      pending = null; }
  }
  let summary: string | null = null;
  let summarizedUpto = 0;
  try {
    const s = await db.query(`SELECT context_summary, context_summary_upto FROM chatapp.chat_sessions WHERE session_id = $1`, [sessionId]);
    summary = (s.rows[0]?.context_summary as string | null) ?? null;
    summarizedUpto = Number(s.rows[0]?.context_summary_upto ?? 0);
  } catch { /* memory columns not created yet (deploy's lakebase step): recent turns only */ }
  return { turns, summary, summarizedUpto: Math.min(summarizedUpto, turns.length) };
}

const trim = (s: string, n: number) => {
  const t = s.replace(/\[\[chart:[^\]]+\]\]/g, '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
};

const SUMMARY_PROMPT = `Write the memory of this analytics conversation in at most 80 words, as short factual notes.
Include only what is actually there: the topics asked about, key figures with their units, the models,
sites, business units, asset types or filters named, and conclusions. Never write that something was "not specified"
or "not mentioned"; just leave it out. No preamble, no headings.`;

/** Every `compact_every` pairs, older turns are folded into the session's summary (after the answer is sent). */
export async function maybeCompact(db: Lakebase, sessionId: string): Promise<void> {
  const c = cfg();
  if (!c) return;
  const h = await loadHistory(db, sessionId);
  // Every `compactEvery` pairs since the last compaction (which kept KEEP_VERBATIM pairs back).
  const sinceLast = h.turns.length - (h.summarizedUpto > 0 ? h.summarizedUpto + KEEP_VERBATIM : 0);
  if (sinceLast < c.compactEvery) return;
  const upto = h.turns.length - KEEP_VERBATIM;
  const fold = h.turns.slice(h.summarizedUpto, upto);
  const transcript = `${h.summary ? `Earlier summary: ${h.summary}\n` : ''}${fold.map((t) => `Q: ${trim(t.q, 300)}\nA: ${trim(t.a, 900)}`).join('\n')}`;
  let summary: string;
  if (c.model) {
    try {
      const { text } = await forFeature('memory', () => chat(c.model!, [
        { role: 'system', content: SUMMARY_PROMPT },
        { role: 'user', content: transcript.slice(0, 8000) },
      ], { maxTokens: 220, timeoutMs: 20000 }));
      summary = text.trim() || digest(h.summary, fold);
    } catch {
      summary = digest(h.summary, fold);
    }
  } else {
    summary = digest(h.summary, fold);
  }
  await db.query(
    `UPDATE chatapp.chat_sessions SET context_summary = $2, context_summary_upto = $3 WHERE session_id = $1`,
    [sessionId, summary.slice(0, 1500), upto],
  ).catch((err: unknown) => console.warn('[memory] could not save the summary:', err instanceof Error ? err.message : err));
}

/** No-model summary: each folded question with the first sentence of its answer. */
function digest(prev: string | null, turns: Turn[]): string {
  const parts = turns.map((t) => `${trim(t.q, 120)} → ${trim(t.a.split(/(?<=[.!?])\s/)[0] ?? '', 160)}`);
  return trim(`${prev ? prev + ' | ' : ''}${parts.join(' | ')}`, 1500);
}

/** A short reference back to the previous answer ("tell me more", "explain that", "what about it?"). */
export function isVagueFollowUp(question: string): boolean {
  const t = question.trim().toLowerCase();
  const words = t.split(/\s+/).filter(Boolean).length;
  return words <= 12 && /^(tell me more|more|explain|elaborate|go on|continue|what about|and\b|why\b|how so|details?|example|can you|could you|i am asking|i'm asking|what do you mean|meaning)|\b(this|that|it|these|those|previous|above|last (one|answer|question)|you said)\b/.test(t);
}

// --- what each reader is sent ---------------------------------------------------------------
// Whole question-and-answer pairs only, newest first, within a budget of estimated tokens.

/** Tokens, estimated (no tokenizer for these models in the app): about 4 characters each. */
export const estimateTokens = (s: string) => Math.ceil(s.length / 4);

const clean = (s: string) => s.replace(/\[\[chart:[^\]]+\]\]/g, '').replace(/\n{3,}/g, '\n\n').trim();

/** Cuts a long text to at most `max` tokens at a paragraph (or else sentence) boundary, and says so. */
function cutAtBoundary(s: string, max: number): string {
  if (estimateTokens(s) <= max) return s;
  const part = s.slice(0, max * 4);
  const para = part.lastIndexOf('\n\n');
  const sentence = Math.max(part.lastIndexOf('. '), part.lastIndexOf('.\n'));
  const at = para > part.length * 0.5 ? para : sentence > part.length * 0.3 ? sentence + 1 : part.length;
  return `${part.slice(0, at).trim()}\n[…the rest of this answer is left out]`;
}

/** A short summary of an answer: its opening sentence, which states the headline result. */
export function briefOf(answer: string): string {
  const t = clean(answer).replace(/[#*_>`|]/g, '').replace(/\s+/g, ' ').trim();
  const m = t.match(/^(.{20,240}?[.!?])(\s|$)/);
  return m ? m[1] : t.length > 200 ? `${t.slice(0, 200)}…` : t;
}

const answeredBy = (t: Turn) => (t.platform ? 'the Lens MLOps guide' : t.mode === 'agent' ? 'a deep analysis' : t.cached ? 'a saved quick answer' : 'a quick answer');

/** The answer's first table as compact text, with the query behind it (the figures a follow-up may point at). */
function tableText(t: Turn): string {
  const tb = t.table;
  if (!tb || !tb.rows.length) return '';
  const rows = tb.rows.slice(0, 10).map((r) => r.map((v) => v ?? '').join(' | ')).join('\n');
  return `\nTable "${tb.title}" (${tb.columns.join(' | ')}):\n${rows}${tb.rows.length > 10 ? `\n(${tb.rows.length - 10} more rows)` : ''}`
    + (tb.sql ? `\nQuery behind it: ${tb.sql.replace(/\s+/g, ' ').slice(0, 800)}` : '');
}

export interface EngineContext { text: string; full: number; summarised: number; leftOut: number; tokens: number }

/**
 * For the query engine: only the data turns its conversation (`conv`, one per mode) has not seen, so
 * nothing it already remembers is repeated. Guide questions and answers and blocked questions are left
 * out. The latest missed pair goes in whole with its table (up to genieLatestMax), then more whole pairs
 * while the budget allows, then older ones as one line each with a short summary of the answer.
 * Null when nothing was missed.
 */
export function engineContext(turns: Turn[], conv: string | null): EngineContext | null {
  const b = aiConfig.contextBudgets;
  const missed = turns.filter((t) => !t.platform && !t.blocked && !(conv && t.conv === conv));
  if (!missed.length) return null;
  const pair = (t: Turn, withTable: boolean) => `Q: ${t.q}\nA (${answeredBy(t)}): ${clean(t.a)}${withTable ? tableText(t) : ''}`;
  const full: string[] = [];
  let used = 0;
  let i = missed.length - 1;
  const latest = cutAtBoundary(pair(missed[i], true), b.genieLatestMax);
  full.unshift(latest);
  used += estimateTokens(latest);
  for (i -= 1; i >= 0; i -= 1) {
    const p = pair(missed[i], false);
    if (used + estimateTokens(p) > b.genie) break;
    full.unshift(p);
    used += estimateTokens(p);
  }
  // Older ones, newest first, one line each; a little room even when the latest pair alone filled the budget.
  const limit = Math.max(b.genie, used + 300);
  const brief: string[] = [];
  let leftOut = 0;
  for (; i >= 0; i -= 1) {
    const line = `- Q: ${missed[i].q.replace(/\s+/g, ' ')} → A (${answeredBy(missed[i])}, summarised): ${briefOf(missed[i].a)}`;
    if (used + estimateTokens(line) > limit) { leftOut = i + 1; break; }
    brief.unshift(line);
    used += estimateTokens(line);
  }
  const text = 'Earlier turns of this chat that this conversation has not seen, in order (questions about the Lens MLOps app are left out). '
    + 'Use them only to understand what the new question refers to, and work out every figure from the data.\n'
    + (leftOut ? `(${leftOut} older question${leftOut === 1 ? '' : 's'} left out)\n` : '')
    + (brief.length ? `Older, with the answers summarised:\n${brief.join('\n')}\n\n` : '')
    + `Most recent, in full:\n${full.join('\n\n')}\n\nNew question: `;
  return { text, full: full.length, summarised: brief.length, leftOut, tokens: estimateTokens(text) };
}

/**
 * For the router and the guide's model: the whole chat when it is small (under sendAllBelow); otherwise
 * the newest whole pairs within `budget`, the stored summary for what it covers, and one line each (with
 * a short summary of the answer) for older turns it doesn't, newest first while room remains.
 */
export function historyWindow(h: SessionHistory, budget: number): string {
  if (!h.turns.length) return '';
  const b = aiConfig.contextBudgets;
  const pair = (t: Turn) => `User: ${t.q}\nAnswered by: ${answeredBy(t)}\nAnswer: ${clean(t.a)}`;
  const all = h.turns.map(pair);
  if (estimateTokens(all.join('\n\n')) <= Math.min(budget, b.sendAllBelow)) return all.join('\n\n');
  const full: string[] = [];
  let used = 0;
  let i = h.turns.length - 1;
  const latest = cutAtBoundary(all[i], budget);
  full.unshift(latest);
  used += estimateTokens(latest);
  for (i -= 1; i >= 0; i -= 1) {
    if (used + estimateTokens(all[i]) > budget) break;
    full.unshift(all[i]);
    used += estimateTokens(all[i]);
  }
  const summary = h.summary && h.summarizedUpto > 0 ? `Summary of the earlier conversation: ${h.summary}` : '';
  used += estimateTokens(summary);
  const brief: string[] = [];
  for (; i >= (summary ? h.summarizedUpto : 0); i -= 1) {
    const t = h.turns[i];
    const line = `- User: ${t.q.replace(/\s+/g, ' ')} → ${answeredBy(t)} (summarised): ${briefOf(t.a)}`;
    if (used + estimateTokens(line) > budget + 300) break;
    brief.unshift(line);
    used += estimateTokens(line);
  }
  return [summary, brief.length ? `Older turns, answers summarised:\n${brief.join('\n')}` : '', `Most recent, in full:\n${full.join('\n\n')}`]
    .filter(Boolean).join('\n\n');
}
