import { aiConfig } from './aiConfig.js';
import { chat, forFeature } from './models.js';
import type { Lakebase } from './answerCache.js';

/**
 * Conversation memory: what a follow-up question is sent with, so "tell me more about
 * this" or "and for Mumbai?" are understood. The query engine only remembers its own
 * conversation for one mode; answers from the cache, from the platform guide, or from
 * the other mode never reach it. So every follow-up carries a compact context built
 * from the whole session:
 *   - a running summary of older turns, compacted every N question-and-answer pairs
 *     (by a small model, or by a no-model digest), and
 *   - the most recent turns verbatim (trimmed).
 * Compaction runs after the answer is sent, so it never adds to anyone's wait.
 */

export interface Turn { q: string; a: string; platform: boolean; sections: string[]; mode: string }
export interface SessionHistory { turns: Turn[]; summary: string | null; summarizedUpto: number }

const KEEP_VERBATIM = 2;     // pairs always kept word for word after a compaction
const MAX_RECENT = 7;        // compact_every + KEEP_VERBATIM: nothing falls between the summary and the recent turns
const ANSWER_CHARS = 450;

const cfg = () => aiConfig.memory;

/** The session's question-and-answer pairs (oldest first) and its stored summary. */
export async function loadHistory(db: Lakebase, sessionId: string): Promise<SessionHistory> {
  const { rows } = await db.query(
    `SELECT role, content, mode, (attachment_json ? 'platform') AS platform, attachment_json->'platform'->'sections' AS sections
       FROM chatapp.chat_messages WHERE session_id = $1 ORDER BY created_at`,
    [sessionId],
  );
  const turns: Turn[] = [];
  let pending: { q: string; mode: string } | null = null;
  for (const r of rows) {
    if (r.role === 'user') pending = { q: String(r.content ?? ''), mode: String(r.mode) };
    else if (pending) { turns.push({ q: pending.q, a: String(r.content ?? ''), platform: Boolean(r.platform), sections: Array.isArray(r.sections) ? r.sections.map(String) : [], mode: pending.mode }); pending = null; }
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

/** The text placed before a follow-up question; empty for the first question of a session. */
export function contextPreamble(h: SessionHistory): string {
  if (!cfg() || !h.turns.length) return '';
  const recent = h.turns.slice(h.summary ? h.summarizedUpto : 0).slice(-Math.max(MAX_RECENT, cfg()!.compactEvery + KEEP_VERBATIM));
  const older = h.summary && h.summarizedUpto > 0 ? `Summary of the earlier conversation: ${h.summary}\n` : '';
  const lines = recent.map((t) => `Q: ${trim(t.q, 300)}\nA: ${trim(t.a, ANSWER_CHARS)}`).join('\n');
  return `Context from earlier in this conversation (use it to understand references like "this", "that" or "the previous question"; answer only the new question):\n${older}${lines}\n\nNew question: `;
}

const SUMMARY_PROMPT = `Write the memory of this analytics conversation in at most 80 words, as short factual notes.
Include only what is actually there: the topics asked about, key figures with their units, the products,
regions, arrears buckets or filters named, and conclusions. Never write that something was "not specified"
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
