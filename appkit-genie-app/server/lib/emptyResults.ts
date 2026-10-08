import { aiConfig } from './aiConfig.js';
import { chat, forFeature } from './models.js';
import type { Answer, ChartSpec } from './answers.js';

/**
 * A chart or table whose query returned no rows is never shown (it renders as column
 * headers over nothing). In its place the answer gets one line saying what found nothing,
 * written by a small model from the query (or a plain sentence without one).
 *
 * - An empty table with the same title as one that has data is just dropped.
 * - Quick answers describe their single query in the text already, so an empty table there
 *   is dropped without a note, unless the answer has no text at all.
 */

const PROMPT = `A database query run to answer a business user's question returned no rows.
In one short sentence for that user, say what found nothing, based on the query's filters
(for example: "No models flagged an anomaly in the last hour of the data.").
Plain business words: no SQL, no table or column names, no figures that aren't in the query.
Reply with the sentence only.`;

const fallback = (c: ChartSpec) => `No data matched for "${c.title}", so that table isn't shown.`;

async function reason(question: string, c: ChartSpec): Promise<string> {
  const model = aiConfig.followUps?.model ?? aiConfig.guardrails?.model;
  if (!model || !c.sql) return fallback(c);
  try {
    const { text } = await forFeature('empty_results', () => chat(model, [
      { role: 'system', content: PROMPT },
      { role: 'user', content: `QUESTION: ${question.slice(0, 500)}\nQUERY TITLE: ${c.title}\nQUERY:\n${(c.sql ?? '').slice(0, 2500)}` },
    ], { maxTokens: 70, timeoutMs: 8000 }));
    const line = text.replace(/\s+/g, ' ').trim().replace(/^["'“]|["'”]$/g, '');
    return line.length >= 10 && line.length <= 240 ? line : fallback(c);
  } catch {
    return fallback(c);
  }
}

/** Removes the answer's empty charts in place; returns how many were removed and explained. */
export async function dropEmptyCharts(question: string, answer: Answer): Promise<{ removed: number; explained: number } | null> {
  const empty = answer.charts.filter((c) => !c.rows.length);
  if (!empty.length) return null;
  const kept = answer.charts.filter((c) => c.rows.length);
  const shown = new Set(kept.map((c) => c.title.toLowerCase()));
  const explain = answer.mode === 'chat' && answer.text.trim() ? [] : empty
    .filter((c, i) => !shown.has(c.title.toLowerCase()) && empty.findIndex((x) => x.title.toLowerCase() === c.title.toLowerCase()) === i)
    .slice(0, 3);
  const notes = new Map<string, string>();
  await Promise.all(explain.map(async (c) => notes.set(c.id, await reason(question, c))));

  let text = answer.text;
  for (const c of empty) {
    const note = notes.get(c.id);
    const marker = `[[chart:${c.id}]]`;
    if (text.includes(marker)) text = text.replace(marker, note ? `_${note}_` : '');
    else if (note) text = `${text.trimEnd()}\n\n_${note}_`;
  }
  answer.text = text.replace(/\n{3,}/g, '\n\n').trim();
  answer.charts = kept;
  return { removed: empty.length, explained: notes.size };
}
