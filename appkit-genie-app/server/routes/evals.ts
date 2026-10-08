import express from 'express';
import { aiConfig, aiConfigSummary } from '../lib/aiConfig.js';
import type { Lakebase } from '../lib/answerCache.js';
import { CATEGORIES, evalRunning, startEvalRun, type Category } from '../lib/evals.js';
import type { GenieLike } from '../lib/genieRun.js';
import { runSql } from '../lib/sql.js';

/** Evals tab (cases, runs, results) and the Responsible AI page's live facts. */

function currentUserEmail(req: express.Request): string {
  const email = req.headers['x-forwarded-email'];
  return typeof email === 'string' && email ? email : 'local-dev@localhost';
}

const GOLD = process.env.LENS_GOLD_SCHEMA ?? '';
let sourcesMemo: { at: number; rows: Array<{ name: string; kind: string; comment: string | null }> } | null = null;

/** The certified views and metric views the assistant answers from (cached for an hour). */
async function dataSources() {
  if (sourcesMemo && Date.now() - sourcesMemo.at < 3_600_000) return sourcesMemo.rows;
  if (!GOLD) return [];
  const [catalog, schema] = GOLD.split('.');
  const rows = await runSql(
    `SELECT table_name, table_type, comment FROM ${catalog}.information_schema.tables
      WHERE table_schema = '${schema.replace(/'/g, '')}' ORDER BY table_name`,
  );
  const list = rows
    .filter((r) => /^(qry_|mv_|business_rules_config$)/.test(String(r.table_name)) && r.table_name !== 'qry_month_end_forecast')
    .map((r) => ({
      name: String(r.table_name),
      kind: String(r.table_name).startsWith('mv_') ? 'Metric view' : r.table_name === 'business_rules_config' ? 'Business rules' : 'Certified view',
      comment: r.comment ?? null,
    }));
  sourcesMemo = { at: Date.now(), rows: list };
  return list;
}

export function buildEvalsRouter(appkit: { lakebase: Lakebase; genie: GenieLike }): express.Router {
  const router = express.Router();
  router.use(express.json());
  const db = appkit.lakebase;

  router.get('/api/evals', async (_req, res) => {
    if (!aiConfig.evals) {
      res.json({ enabled: false });
      return;
    }
    const [cases, runs] = await Promise.all([
      db.query(`SELECT case_id, category, question, mode, expected, expected_sql IS NOT NULL AS has_ground_truth, source, notes, enabled
                  FROM chatapp.eval_cases ORDER BY category, source, created_at`),
      db.query(`SELECT run_id, started_by, categories, status, total, completed, config, summary, started_at, finished_at
                  FROM chatapp.eval_runs ORDER BY started_at DESC LIMIT 20`),
    ]);
    res.json({
      enabled: true,
      maxAccuracyCases: aiConfig.evals.maxAccuracyCases,
      judge: aiConfigSummary().judge,
      guardrailsOn: Boolean(aiConfig.guardrails),
      running: evalRunning(),
      cases: cases.rows,
      runs: runs.rows,
    });
  });

  router.post('/api/evals/runs', async (req, res) => {
    const cats = (Array.isArray(req.body?.categories) ? req.body.categories : CATEGORIES).map(String) as Category[];
    try {
      const runId = await startEvalRun(db, appkit.genie, cats, currentUserEmail(req));
      res.status(202).json({ runId });
    } catch (err) {
      res.status(409).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get('/api/evals/runs/:id', async (req, res) => {
    const [run, results] = await Promise.all([
      db.query(`SELECT run_id, started_by, categories, status, total, completed, config, summary, started_at, finished_at
                  FROM chatapp.eval_runs WHERE run_id = $1`, [req.params.id]),
      db.query(`SELECT result_id, case_id, category, question, expected, passed, scores, outcome, details, latency_ms
                  FROM chatapp.eval_results WHERE run_id = $1 ORDER BY category, created_at`, [req.params.id]),
    ]);
    if (!run.rows.length) {
      res.status(404).json({ error: 'run not found' });
      return;
    }
    res.json({ run: run.rows[0], results: results.rows });
  });

  router.patch('/api/evals/cases/:id', async (req, res) => {
    const { rows } = await db.query(
      `UPDATE chatapp.eval_cases SET enabled = $2 WHERE case_id = $1 RETURNING case_id, enabled`,
      [req.params.id, req.body?.enabled !== false],
    );
    if (!rows.length) res.status(404).json({ error: 'case not found' });
    else res.json(rows[0]);
  });

  // Live facts for the Responsible AI page: models in use, data sources, latest evaluation, checks in force.
  router.get('/api/ai/transparency', async (_req, res) => {
    const [sources, latest, guardCounts, totals] = await Promise.all([
      dataSources().catch(() => []),
      db.query(`SELECT run_id, summary, finished_at FROM chatapp.eval_runs WHERE status = 'done' ORDER BY finished_at DESC LIMIT 1`)
        .then((r) => r.rows[0] ?? null).catch(() => null),
      db.query(`SELECT COUNT(*) FILTER (WHERE guard_action = 'blocked')::int AS blocked,
                       COUNT(*) FILTER (WHERE guard_action = 'redacted')::int AS redacted,
                       COUNT(*) FILTER (WHERE faithfulness IS NOT NULL)::int AS judged,
                       ROUND(AVG(faithfulness)::numeric, 3) AS avg_faithfulness,
                       COUNT(*) FILTER (WHERE feedback = -1)::int AS thumbs_down,
                       COUNT(*) FILTER (WHERE feedback = -1 AND review_status IN ('fixed','dismissed','added_to_evals'))::int AS reviewed
                  FROM chatapp.usage_log`).then((r) => r.rows[0]).catch(() => null),
      db.query(`SELECT COUNT(*)::int AS questions, MIN(created_at) AS since FROM chatapp.usage_log`).then((r) => r.rows[0]).catch(() => null),
    ]);
    res.json({ config: aiConfigSummary(), sources, latestEval: latest, guardCounts, totals });
  });

  return router;
}
