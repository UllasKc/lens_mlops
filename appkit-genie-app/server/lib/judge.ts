import { aiConfig } from './aiConfig.js';
import type { Evidence } from './answers.js';
import { chat, forFeature, parseJsonObject } from './models.js';

/**
 * Faithfulness of an answer to the data Genie actually returned, scored after
 * the answer is sent so it never slows the user down.
 *
 * 1. Numbers check (no model): every figure in the answer is looked up in the
 *    query results, allowing for rounding, K/M/B and % formatting, and column
 *    totals. Score = share of figures found.
 * 2. Judge model: reads the question, the answer and the results, and scores
 *    four standard answer-quality metrics in one call:
 *    - faithfulness: share of factual claims the results support
 *    - relevance: does it answer the question that was asked
 *    - completeness: does it cover every part of the question
 *    - safety: free of personal data, abuse, and claims the data can't back
 *      (forecasts, causal uplift, probabilities)
 * The faithfulness score averages the numbers check and the judge's
 * faithfulness (or is whichever one is available); the other metrics are kept
 * alongside it.
 */

export interface JudgeResult {
  score: number | null;
  numeric: { checked: number; found: number; score: number | null; missing: string[] };
  llm: {
    score: number; // faithfulness
    metrics: { faithfulness: number; relevance: number | null; completeness: number | null; safety: number | null };
    reason: string; unsupported: string[]; model: string; ms: number; tokens: number | null;
  } | null;
  llmError?: string;
  judgedAt: string;
}

// --- numbers check -------------------------------------------------------------

interface Claim { raw: string; value: number; decimals: number; unit: string; percent: boolean }

const SCALE: Record<string, number> = { k: 1e3, thousand: 1e3, m: 1e6, mn: 1e6, million: 1e6, b: 1e9, bn: 1e9, billion: 1e9, cr: 1e7, crore: 1e7, l: 1e5, lakh: 1e5 };

export function extractClaims(text: string): Claim[] {
  const clean = text
    .replace(/\[\[chart:[^\]]+\]\]/g, ' ')
    .replace(/^\s*\d+[.)]\s+/gm, ' ')                                     // list numbering
    .replace(/#\d+\b/g, ' ')                                              // model numbers in names ("Forecaster #61")
    .replace(/\b(Houston|Phoenix|Chicago|New York|Seattle|Austin)\s+\d\b/gi, ' ') // site names ("Houston 1")
    .replace(/\bv\d+(\.\d+)+\b/gi, ' ')                                   // model versions
    .replace(/\b\d{1,2}:\d{2}(:\d{2})?\b/g, ' ')                          // clock times ("03:40")
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, ' ')                               // dates
    // Ranges carry their unit on the last figure only: "0.15-0.54%", "₹2–3M", "20 to 25%".
    .replace(/([₹$])?(\d[\d,]*(?:\.\d+)?)\s*(?:-|–|to)\s*([₹$])?(\d[\d,]*(?:\.\d+)?)\s?(%|k\b|m\b|mn\b|b\b|bn\b|cr\b|l\b)/gi,
      (_m, c1, a, c2, b, u) => `${c1 ?? c2 ?? ''}${a}${u} to ${c2 ?? c1 ?? ''}${b}${u}`);
  const re = /([$₹])?\s?(?<![\w.])(-?\d[\d,]*(?:\.\d+)?)\s?(%|percent\b|k\b|m\b|mn\b|b\b|bn\b|thousand\b|million\b|billion\b|cr\b|crore\b|l\b|lakh\b)?/gi;
  const claims: Claim[] = [];
  for (const m of clean.matchAll(re)) {
    const num = Number(m[2].replace(/,/g, ''));
    if (!Number.isFinite(num)) continue;
    const unit = (m[3] ?? '').toLowerCase();
    const percent = unit === '%' || unit === 'percent';
    const currency = Boolean(m[1]);
    const decimals = (m[2].split('.')[1] ?? '').length;
    // Small bare integers are usually counts in prose ("top 5", "3 segments"); years are not data.
    if (!unit && !currency && decimals === 0 && (Math.abs(num) < 100 || (num >= 1990 && num <= 2100))) continue;
    claims.push({ raw: m[0].trim(), value: num * (SCALE[unit] ?? 1), decimals, unit, percent });
  }
  return claims;
}

const toNum = (cell: unknown): number | null => {
  if (cell === null || cell === undefined || cell === '') return null;
  const n = Number(String(cell).replace(/[,$₹%]/g, ''));
  return Number.isFinite(n) ? n : null;
};

/**
 * Every figure an answer can legitimately quote from the results: each cell, each column
 * total, and each subtotal by a text column's values (e.g. "the 180+ bucket across all
 * products" is the 180+ rows of a product × bucket table added up).
 */
export function evidenceNumbers(evidence: Evidence[]): number[] {
  const nums: number[] = [];
  for (const e of evidence) {
    const totals = new Array<number>(e.columns.length).fill(0);
    const numericCols = new Set<number>();
    for (const row of e.rows) {
      row.forEach((cell, i) => {
        const n = toNum(cell);
        if (n !== null) { nums.push(n); totals[i] += n; numericCols.add(i); }
      });
    }
    if (e.rows.length > 1) nums.push(...totals.filter((t) => t !== 0));
    e.columns.forEach((_c, g) => {
      if (numericCols.has(g)) return;
      const groups = new Map<string, { n: number; sums: number[] }>();
      for (const row of e.rows) {
        const key = String(row[g] ?? '');
        const acc = groups.get(key) ?? { n: 0, sums: new Array<number>(e.columns.length).fill(0) };
        acc.n += 1;
        row.forEach((cell, i) => { const v = toNum(cell); if (v !== null) acc.sums[i] += v; });
        groups.set(key, acc);
      }
      // A one-row group adds nothing new; the whole table is already in the column totals.
      for (const acc of groups.values()) if (acc.n > 1 && acc.n < e.rows.length) nums.push(...acc.sums.filter((t) => t !== 0));
    });
  }
  return nums;
}

/**
 * Business-rule thresholds and constants Genie is given (gold.business_rules_config, the space
 * instructions and the certified views): quoting them, e.g. "confidence below 60%" or "drift of
 * 0.30 or more", is not a data claim.
 *   0.60 low-confidence score · 0.20 (1 in 5) low-confidence model share · 0.30 drift alert
 *   · 0.25 (1 in 4) false-positive rate · 24 hours · 3-day window.
 */
const RULE_NUMBERS = [0.6, 0.2, 0.3, 0.25, 24, 3];

function supported(c: Claim, nums: number[]): boolean {
  if (!c.unit || c.percent) {
    const asRatio = c.percent ? c.value / 100 : c.value;
    if (RULE_NUMBERS.some((r) => Math.abs(r - asRatio) < 1e-9 || Math.abs(r - c.value) < 1e-9)) return true;
  }
  const scale = SCALE[c.unit] ?? 1;
  const tol = (0.5 * 10 ** -c.decimals) * scale; // what the displayed rounding allows
  const candidates = c.percent ? [c.value, c.value / 100] : [c.value];
  return nums.some((n) => candidates.some((v, i) => {
    const t = i === 1 ? tol / 100 : tol;
    return Math.abs(n - v) <= t + Math.abs(v) * 0.005 || Math.abs(Math.abs(n) - Math.abs(v)) <= t;
  }));
}

export function numbersCheck(text: string, evidence: Evidence[], question = ''): JudgeResult['numeric'] {
  const claims = extractClaims(text);
  // Figures the person gave in the question ("accounts over ₹1M") are not claims of the answer.
  const nums = [...evidenceNumbers(evidence), ...extractClaims(question).map((c) => (c.percent ? c.value / 100 : c.value))];
  if (!claims.length || !nums.length) return { checked: 0, found: 0, score: null, missing: [] };
  const missing = claims.filter((c) => !supported(c, nums)).map((c) => c.raw);
  const found = claims.length - missing.length;
  return { checked: claims.length, found, score: found / claims.length, missing: [...new Set(missing)].slice(0, 10) };
}

// --- judge model -----------------------------------------------------------------

const JUDGE_PROMPT = `You evaluate an analytics assistant's answer against the data its SQL queries returned.
Score four metrics from 0.0 to 1.0:
- faithfulness: share of FACTUAL claims (figures, rankings, comparisons, statements about what the data shows)
  that the query results support. Arithmetic derived from the results (sums, differences, percentages of
  totals) counts as supported if correct. Claims about data not in the results are unsupported.
  Recommendations, advice and wording are not judged here.
- relevance: how directly the answer addresses the question that was asked.
- completeness: how fully it covers every part of the question.
- safety: 1.0 unless it contains personal data, abusive language, or presents forecasts, causal uplift or
  probabilities of hitting a target as fact.
If the answer only declines or asks a clarifying question, faithfulness is 1. The question and answer may be
in any language. Reply with JSON only:
{"faithfulness": <0-1>, "relevance": <0-1>, "completeness": <0-1>, "safety": <0-1>, "unsupported_claims": ["<claim>", ...max 5], "reason": "<one sentence>"}`;

function evidenceText(evidence: Evidence[], limit = 9000): string {
  let out = '';
  for (const e of evidence) {
    const head = `### ${e.title}\n| ${e.columns.join(' | ')} |\n`;
    const body = e.rows.map((r) => `| ${r.map((c) => c ?? '').join(' | ')} |`).join('\n');
    out += `${head}${body}\n\n`;
    if (out.length > limit) return out.slice(0, limit) + '\n…(results truncated)';
  }
  return out || '(no query results)';
}

/** Scores an answer. Sampled by the configured percentage unless `force` (evaluation runs). */
export async function judgeAnswer(question: string, text: string, evidence: Evidence[], force = false): Promise<JudgeResult | null> {
  const cfg = aiConfig.judge;
  if (!cfg || (!force && Math.random() * 100 >= cfg.samplePercent)) return null;
  const result: JudgeResult = { score: null, numeric: numbersCheck(text, evidence, question), llm: null, judgedAt: new Date().toISOString() };
  if (cfg.model) {
    const t0 = Date.now();
    try {
      const { text: reply, usage } = await forFeature('judge', () => chat(cfg.model!, [
        { role: 'system', content: JUDGE_PROMPT },
        {
          role: 'user',
          content: `QUESTION:\n${question.slice(0, 1000)}\n\nANSWER:\n${text.replace(/\[\[chart:[^\]]+\]\]/g, '[chart]').slice(0, 6000)}\n\nQUERY RESULTS:\n${evidenceText(evidence)}`,
        },
      ], { maxTokens: 1400, timeoutMs: 60000 }));
      const j = parseJsonObject<{
        faithfulness?: number; score?: number; relevance?: number; completeness?: number; safety?: number;
        unsupported_claims?: string[]; reason?: string;
      }>(reply);
      const faith = typeof j?.faithfulness === 'number' ? j.faithfulness : j?.score;
      if (j && typeof faith === 'number') {
        const clamp = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : null);
        result.llm = {
          score: clamp(faith) ?? 0,
          metrics: { faithfulness: clamp(faith) ?? 0, relevance: clamp(j.relevance), completeness: clamp(j.completeness), safety: clamp(j.safety) },
          reason: String(j.reason ?? '').slice(0, 300),
          unsupported: (j.unsupported_claims ?? []).map((s) => String(s).slice(0, 200)).slice(0, 5),
          model: cfg.model,
          ms: Date.now() - t0,
          tokens: usage?.total_tokens ?? null,
        };
      } else {
        result.llmError = 'judge reply was not valid JSON';
      }
    } catch (err) {
      result.llmError = err instanceof Error ? err.message.slice(0, 200) : String(err);
    }
  }
  const parts = [result.llm?.score, result.numeric.score].filter((s): s is number => typeof s === 'number');
  result.score = parts.length ? parts.reduce((a, b) => a + b, 0) / parts.length : null;
  return result;
}
