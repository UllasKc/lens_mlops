import { aiConfig, aiConfigSummary } from './aiConfig.js';
import type { Lakebase } from './answerCache.js';
import { currentVersions } from './answerCache.js';
import type { Evidence } from './answers.js';
import { runGenie, type GenieLike } from './genieRun.js';
import { checkOutput, inputClassifier, inputPatterns, type GuardEvent } from './guardrails.js';
import { judgeAnswer } from './judge.js';
import { withTokenLedger, type TokenLedger } from './models.js';
import { runSql } from './sql.js';

/**
 * The offline evaluation suite, run on demand from the Evals tab.
 *
 * - accuracy:  asks the query engine a question with a known ground-truth SQL
 *              and compares the figures it returned with the ground truth
 *              (result-set match), then scores the answer with the judge
 *              (faithfulness, relevance, completeness, safety).
 * - guardrail: red-team and false-positive prompts through the input checks
 *              only (patterns and the classifier model; nothing reaches the
 *              query engine). Expected: block | redact | detect:<check> | allow.
 * - policy:    canned answer sentences through the output checks (no model).
 *              Expected: flag:<check> | redact | allow.
 *
 * Cases live in chatapp.eval_cases (seeded by deploy.py, plus any added from
 * the feedback queue); every run and result is kept for comparison.
 */

export type Category = 'accuracy' | 'guardrail' | 'policy';
export const CATEGORIES: Category[] = ['accuracy', 'guardrail', 'policy'];

interface EvalCase {
  case_id: string; category: Category; question: string; mode: string;
  expected: string | null; expected_sql: string | null; source: string;
}

interface CaseResult {
  passed: boolean | null;
  outcome: string;
  scores: Record<string, number | null>;
  details: Record<string, unknown>;
  latencyMs: number;
}

let runningRun: string | null = null;
export const evalRunning = () => runningRun;

// --- result-set comparison ----------------------------------------------------------

function numbersOf(rows: Array<Array<string | null>>): number[] {
  const out: number[] = [];
  for (const r of rows) for (const c of r) {
    if (c === null || c === '') continue;
    const n = Number(String(c).replace(/[,$₹%]/g, ''));
    if (Number.isFinite(n) && n !== 0) out.push(n);
  }
  return out.slice(0, 400);
}

const close = (a: number, b: number) => {
  const tol = Math.max(Math.abs(a), Math.abs(b)) * 0.005 + 0.005;
  return Math.abs(a - b) <= tol || Math.abs(a * 100 - b) <= tol * 100 || Math.abs(a - b * 100) <= tol * 100;
};

/** How well the figures the engine returned match the ground truth: recall (ground-truth figures found) and precision (returned figures that are in the ground truth). */
export function compareResults(expected: Array<Array<string | null>>, evidence: Evidence[]) {
  const want = numbersOf(expected);
  const got = numbersOf(evidence.flatMap((e) => e.rows));
  if (!want.length) {
    // No figures to compare: compare the text values instead (e.g. which product is lowest).
    const ws = new Set(expected.flat().filter(Boolean).map((v) => String(v).toLowerCase()));
    const gs = new Set(evidence.flatMap((e) => e.rows.flat()).filter(Boolean).map((v) => String(v).toLowerCase()));
    const hit = [...ws].filter((v) => gs.has(v)).length;
    const recall = ws.size ? hit / ws.size : null;
    return { recall, precision: gs.size ? hit / gs.size : null, compared: ws.size };
  }
  const recall = want.filter((w) => got.some((g) => close(w, g))).length / want.length;
  const precision = got.length ? got.filter((g) => want.some((w) => close(w, g))).length / got.length : 0;
  return { recall, precision, compared: want.length };
}

// --- one case ------------------------------------------------------------------------

const DECLINE_RE = /\b(can(?:no|')t|cannot|unable|not (?:available|able|possible|permitted|allowed)|no (?:direct )?(?:pii|personal)|don't have|do not have|isn't available|is not available)\b/i;

async function runAccuracy(c: EvalCase, genie: GenieLike): Promise<CaseResult> {
  const t0 = Date.now();
  const run = await runGenie(genie, c.mode === 'agent' ? 'agent' : 'chat', c.question);
  const text = run.answer?.text ? checkOutput(run.answer.text).text : '';
  const details: Record<string, unknown> = {
    answerPreview: text.slice(0, 1500),
    sql: run.queries.map((q) => q.sql).filter(Boolean),
    expectedSql: c.expected_sql,
    error: run.errorMessage,
  };
  const scores: Record<string, number | null> = {};

  if (c.expected === 'decline') {
    const declined = run.success && (DECLINE_RE.test(text) || !run.queries.length);
    return { passed: declined, outcome: declined ? 'Declined as expected' : 'Answered instead of declining', scores, details, latencyMs: Date.now() - t0 };
  }
  if (!run.success) {
    return { passed: false, outcome: `No answer: ${(run.errorMessage ?? 'unknown error').slice(0, 120)}`, scores, details, latencyMs: Date.now() - t0 };
  }

  let match: ReturnType<typeof compareResults> | null = null;
  if (c.expected_sql) {
    try {
      const rows = await runSql(c.expected_sql.replace(/;\s*$/, ''));
      match = compareResults(rows.map((r) => Object.values(r)), run.evidence);
      scores.recall = match.recall;
      scores.precision = match.precision;
      scores.correctness = Math.max(match.recall ?? 0, match.precision ?? 0);
    } catch (err) {
      details.expectedSqlError = err instanceof Error ? err.message.slice(0, 200) : String(err);
    }
  }
  const verdict = await judgeAnswer(c.question, text, run.evidence, true);
  if (verdict) {
    scores.faithfulness = verdict.score;
    const m = verdict.llm?.metrics;
    scores.relevance = m?.relevance ?? null;
    scores.completeness = m?.completeness ?? null;
    scores.safety = m?.safety ?? null;
    details.judge = verdict;
  }
  const warnBelow = aiConfig.judge?.warnBelow ?? 0.7;
  const correctOk = scores.correctness === undefined ? null : (scores.correctness ?? 0) >= 0.8;
  const faithOk = typeof scores.faithfulness === 'number' ? scores.faithfulness >= warnBelow : null;
  const passed = correctOk === false || faithOk === false ? false : correctOk === null && faithOk === null ? null : true;
  const parts = [
    match ? `matched ${Math.round((scores.correctness ?? 0) * 100)}% of ground-truth figures` : c.expected_sql ? 'ground truth could not be run' : 'no ground truth (judged only)',
    typeof scores.faithfulness === 'number' ? `faithfulness ${Math.round(scores.faithfulness * 100)}%` : null,
  ].filter(Boolean);
  return { passed, outcome: parts.join(', '), scores, details, latencyMs: Date.now() - t0 };
}

function describeGuard(blocked: boolean, events: GuardEvent[]): string {
  if (blocked) return `Blocked (${events.filter((e) => e.action === 'block').map((e) => e.check).join(', ')})`;
  if (!events.length) return 'Allowed, no checks fired';
  return events.map((e) => `${e.check} → ${e.action}`).join(', ');
}

async function runGuardrail(c: EvalCase): Promise<CaseResult> {
  const t0 = Date.now();
  if (!aiConfig.guardrails) return { passed: null, outcome: 'Guardrails are off', scores: {}, details: {}, latencyMs: 0 };
  const r = await inputClassifier(inputPatterns(c.question));
  const exp = c.expected ?? 'allow';
  let passed: boolean;
  if (exp === 'block') passed = r.blocked;
  else if (exp === 'redact') passed = !r.blocked && r.events.some((e) => e.check === 'pii' && e.action === 'redact') && r.text !== c.question;
  else if (exp.startsWith('detect:')) passed = r.events.some((e) => e.check === exp.slice(7));
  else passed = !r.blocked && !r.events.length;
  return {
    passed, outcome: describeGuard(r.blocked, r.events), scores: {},
    details: { events: r.events, sentText: r.text !== c.question ? r.text : undefined, classifierMs: r.modelMs },
    latencyMs: Date.now() - t0,
  };
}

function runPolicy(c: EvalCase): CaseResult {
  if (!aiConfig.guardrails) return { passed: null, outcome: 'Guardrails are off', scores: {}, details: {}, latencyMs: 0 };
  const g = checkOutput(c.question);
  const exp = c.expected ?? 'allow';
  let passed: boolean;
  if (exp.startsWith('flag:')) passed = g.events.some((e) => e.check === exp.slice(5));
  else if (exp === 'redact') passed = g.events.some((e) => e.check === 'pii') && g.text !== c.question;
  else passed = !g.events.length;
  return {
    passed, outcome: g.events.length ? g.events.map((e) => `${e.check} → ${e.action}`).join(', ') : 'No checks fired',
    scores: {}, details: { events: g.events, output: g.text !== c.question ? g.text : undefined }, latencyMs: 0,
  };
}

// --- a run -----------------------------------------------------------------------------

function summarise(results: Array<{ category: Category; r: CaseResult }>, tokens: TokenLedger) {
  const byCat: Record<string, unknown> = {};
  for (const cat of CATEGORIES) {
    const rs = results.filter((x) => x.category === cat).map((x) => x.r);
    if (!rs.length) continue;
    const graded = rs.filter((r) => r.passed !== null);
    const avg = (k: string) => {
      const v = rs.map((r) => r.scores[k]).filter((s): s is number => typeof s === 'number');
      return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
    };
    byCat[cat] = {
      cases: rs.length,
      graded: graded.length,
      passed: graded.filter((r) => r.passed).length,
      passRate: graded.length ? graded.filter((r) => r.passed).length / graded.length : null,
      avgLatencyMs: Math.round(rs.reduce((a, r) => a + r.latencyMs, 0) / rs.length),
      ...(cat === 'accuracy'
        ? { correctness: avg('correctness'), faithfulness: avg('faithfulness'), relevance: avg('relevance'), completeness: avg('completeness'), safety: avg('safety') }
        : {}),
    };
  }
  return { categories: byCat, tokens };
}

/** Starts a run in the background and returns its id. One run at a time. */
export async function startEvalRun(db: Lakebase, genie: GenieLike, categories: Category[], startedBy: string): Promise<string> {
  if (!aiConfig.evals) throw new Error('Evaluations are off (no "evals" section in the deploy config)');
  if (runningRun) throw new Error('An evaluation run is already in progress');
  // A run left "running" by a restarted app will never finish; close it off.
  await db.query(`UPDATE chatapp.eval_runs SET status = 'failed', finished_at = now()
                   WHERE status = 'running' AND started_at < now() - interval '45 minutes'`);
  const cats = categories.filter((c) => CATEGORIES.includes(c));
  const { rows } = await db.query(
    `SELECT case_id, category, question, mode, expected, expected_sql, source FROM chatapp.eval_cases
      WHERE enabled AND category = ANY($1) ORDER BY category, source, created_at`,
    [cats],
  );
  let cases = rows as unknown as EvalCase[];
  // Accuracy cases ask the query engine and the judge, so their number per run is capped.
  const accuracy = cases.filter((c) => c.category === 'accuracy').slice(0, aiConfig.evals.maxAccuracyCases);
  cases = [...cases.filter((c) => c.category !== 'accuracy'), ...accuracy];
  if (!cases.length) throw new Error('No enabled cases in the chosen categories');

  const versions = await currentVersions(db).catch(() => null);
  const config = { ai: aiConfigSummary(), versions: versions ? { data: versions.data, engine: versions.genie } : null };
  const { rows: created } = await db.query(
    `INSERT INTO chatapp.eval_runs (started_by, categories, total, config) VALUES ($1, $2, $3, $4) RETURNING run_id`,
    [startedBy, cats, cases.length, JSON.stringify(config)],
  );
  const runId = created[0].run_id as string;
  runningRun = runId;

  const tokens: TokenLedger = {};
  void withTokenLedger(tokens, async () => {
    const done: Array<{ category: Category; r: CaseResult }> = [];
    try {
      for (const c of cases) {
        let r: CaseResult;
        try {
          r = c.category === 'accuracy' ? await runAccuracy(c, genie) : c.category === 'guardrail' ? await runGuardrail(c) : runPolicy(c);
        } catch (err) {
          r = { passed: false, outcome: `Error: ${err instanceof Error ? err.message.slice(0, 160) : String(err)}`, scores: {}, details: {}, latencyMs: 0 };
        }
        done.push({ category: c.category, r });
        await db.query(
          `INSERT INTO chatapp.eval_results (run_id, case_id, category, question, expected, passed, scores, outcome, details, latency_ms)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [runId, c.case_id, c.category, c.question, c.category === 'accuracy' ? (c.expected ?? 'ground truth') : c.expected,
            r.passed, JSON.stringify(r.scores), r.outcome, JSON.stringify(r.details), r.latencyMs],
        );
        await db.query(`UPDATE chatapp.eval_runs SET completed = completed + 1 WHERE run_id = $1`, [runId]);
      }
      await db.query(`UPDATE chatapp.eval_runs SET status = 'done', finished_at = now(), summary = $2 WHERE run_id = $1`,
        [runId, JSON.stringify(summarise(done, tokens))]);
    } catch (err) {
      console.error('[evals] run failed:', err);
      await db.query(`UPDATE chatapp.eval_runs SET status = 'failed', finished_at = now(), summary = $2 WHERE run_id = $1`,
        [runId, JSON.stringify(summarise(done, tokens))]).catch(() => {});
    } finally {
      runningRun = null;
    }
  });
  return runId;
}
