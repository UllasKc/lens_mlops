import express from 'express';
import { currentVersions, type Lakebase } from '../lib/answerCache.js';
import { runSql } from '../lib/sql.js';
import { MODEL_COLUMNS, MODEL_TOTALS } from './dashboard.js';

const GOLD = process.env.LENS_GOLD_SCHEMA ?? 'cnx_automl_dev.lens_mlops_gold';
if (!/^[A-Za-z0-9_]+\.[A-Za-z0-9_]+$/.test(GOLD)) {
  throw new Error(`LENS_GOLD_SCHEMA must be "<catalog>.<schema>", got: ${GOLD}`);
}
const BASE = `${GOLD}.qry_explorer_base`;

/** Filterable dimensions: query parameter -> column of qry_explorer_base (and qry_model_health). */
const DIMS: Record<string, string> = {
  business_unit: 'business_unit', site: 'site_name', asset: 'asset_type', model_type: 'model_type',
  criticality: 'criticality', team: 'owner_team', health: 'health_status',
};
const ORDER: Record<string, string> = { criticality: 'MIN(criticality_order)' };
const DATES: Record<string, '>=' | '<='> = { dayFrom: '>=', dayTo: '<=' };

/**
 * Two steps, so every measure keeps the certified definitions: first one row per model within
 * the filters (sums, and each model's own error %), then the group. Rates are sum/sum; error %
 * is the average of the models' own values, because units differ between models.
 */
const PER_MODEL = (where: string) => `
  SELECT model_id, MAX(model_name) AS model_name, MAX(business_unit) AS business_unit, MAX(site_name) AS site_name,
    MAX(asset_type) AS asset_type, MAX(model_type) AS model_type, MAX(criticality) AS criticality,
    MIN(criticality_order) AS criticality_order, MAX(owner_team) AS owner_team, MAX(health_status) AS health_status,
    MAX(drifting_flag) AS drifting_flag, MAX(low_confidence_flag) AS low_confidence_flag,
    MAX(needs_attention_flag) AS needs_attention_flag,
    SUM(predictions) AS predictions, SUM(verified_predictions) AS verified_predictions, SUM(confidence_sum) AS confidence_sum,
    SUM(low_confidence_predictions) AS low_confidence_predictions, SUM(drift_sum) AS drift_sum, SUM(latency_sum) AS latency_sum,
    SUM(abs_error_sum) / NULLIF(SUM(abs_actual_sum), 0) AS error_pct,
    SUM(alerts) AS alerts, SUM(confirmed_incidents) AS confirmed_incidents, SUM(false_positives) AS false_positives,
    SUM(downtime_avoided_hours) AS downtime_avoided_hours, SUM(cost_savings_usd) AS cost_savings_usd
  FROM ${BASE} ${where} GROUP BY model_id`;

const MEASURES = `
  COUNT(*) AS models,
  SUM(CASE WHEN health_status = 'Healthy' THEN 1 ELSE 0 END) AS healthy_models,
  SUM(needs_attention_flag) AS models_needing_attention,
  1.0 * SUM(needs_attention_flag) / NULLIF(COUNT(*), 0) AS attention_share,
  SUM(drifting_flag) AS drifting_models,
  SUM(low_confidence_flag) AS low_confidence_models,
  SUM(predictions) AS predictions,
  1.0 * SUM(verified_predictions) / NULLIF(SUM(predictions), 0) AS verified_share,
  SUM(confidence_sum) / NULLIF(SUM(predictions), 0) AS avg_confidence,
  1.0 * SUM(low_confidence_predictions) / NULLIF(SUM(predictions), 0) AS low_confidence_share,
  SUM(drift_sum) / NULLIF(SUM(predictions), 0) AS avg_drift,
  AVG(error_pct) AS avg_error_pct,
  SUM(latency_sum) / NULLIF(SUM(predictions), 0) AS avg_latency_ms,
  SUM(alerts) AS alerts,
  SUM(confirmed_incidents) AS confirmed_incidents,
  SUM(false_positives) AS false_positives,
  1.0 * SUM(false_positives) / NULLIF(SUM(alerts), 0) AS false_positive_rate,
  SUM(downtime_avoided_hours) AS downtime_avoided_hours,
  SUM(cost_savings_usd) AS cost_savings_usd`;

type Rows = Record<string, string | null>[];
type Options = { dims: Record<string, string[]>; dates: Record<string, string | null> };

const sqlStr = (v: string) => `'${v.replace(/'/g, "''")}'`;

export function buildExplorerRouter(db: Lakebase): express.Router {
  const router = express.Router();

  // Results are cached per data version, like the Command Center; filters are part of the key.
  const entries = new Map<string, { version: string | null; at: number; value: unknown }>();
  async function cached<T>(key: string, compute: () => Promise<T>): Promise<T> {
    const version = await currentVersions(db).then((v) => v.data, () => null);
    const e = entries.get(key);
    if (e && (version && e.version ? e.version === version : Date.now() - e.at < 10 * 60_000)) return e.value as T;
    const value = await compute();
    if (entries.size > 300) entries.clear();
    entries.set(key, { version, at: Date.now(), value });
    return value;
  }

  const options = () => cached<Options>('options', async () => {
    const dims: Record<string, string[]> = {};
    const lists = await Promise.all(Object.entries(DIMS).map(([k, col]) =>
      runSql(`SELECT ${col} AS v FROM ${BASE} GROUP BY ${col} ORDER BY ${ORDER[k] ?? col}`)
        .then((rows) => [k, rows.map((r) => String(r.v))] as const)));
    for (const [k, v] of lists) dims[k] = v;
    const [d] = await runSql(`SELECT CAST(MIN(prediction_date) AS STRING) AS dayMin, CAST(MAX(prediction_date) AS STRING) AS dayMax FROM ${BASE}`);
    return { dims, dates: d ?? {} };
  });

  /** The WHERE clause for the request's filters. Only values that exist in the data are accepted. */
  async function filtersFrom(query: express.Request['query'], { dates = true, alias = '' } = {}) {
    const opts = await options();
    const clauses: string[] = [];
    const applied: Record<string, string> = {};
    for (const [k, col] of Object.entries(DIMS)) {
      const v = typeof query[k] === 'string' ? query[k] as string : '';
      if (!v) continue;
      if (!opts.dims[k]?.includes(v)) throw Object.assign(new Error(`Unknown ${k}: ${v}`), { status: 400 });
      clauses.push(`${alias}${col} = ${sqlStr(v)}`);
      applied[k] = v;
    }
    for (const [k, op] of Object.entries(DATES)) {
      const v = typeof query[k] === 'string' ? query[k] as string : '';
      if (!v) continue;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw Object.assign(new Error(`Bad date for ${k}`), { status: 400 });
      if (dates) clauses.push(`prediction_date ${op} DATE '${v}'`);
      applied[k] = v;
    }
    return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', applied };
  }

  const fail = (res: express.Response, err: unknown) => {
    const status = (err as { status?: number }).status ?? 500;
    res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
  };

  router.get('/api/explorer/options', async (_req, res) => {
    try { res.json(await options()); } catch (err) { fail(res, err); }
  });

  /**
   * The models behind any Explorer chart item: the current filters plus the item's own (sent as
   * one more filter, so it is checked the same way), optionally narrowed to a health flag. Same
   * columns as the Command Center's lists, so the browser shows them in the same window. Model
   * health and value are for the whole window; the date filter applies to the charts.
   */
  const FLAGS: Record<string, string> = {
    attention: 'h.needs_attention_flag = 1', drifting: 'h.drifting_flag = 1', low_confidence: 'h.low_confidence_flag = 1',
    with_alerts: 'h.alerts > 0', healthy: "h.health_status = 'Healthy'",
  };
  router.get('/api/explorer/models', async (req, res) => {
    try {
      const { where, applied } = await filtersFrom(req.query, { dates: false, alias: 'h.' });
      const clauses = where ? [where.replace(/^WHERE /, '')] : [];
      const flag = typeof req.query.flag === 'string' ? req.query.flag : '';
      if (flag) {
        if (!FLAGS[flag]) throw Object.assign(new Error(`Unknown flag: ${flag}`), { status: 400 });
        clauses.push(FLAGS[flag]);
      }
      const from = `FROM ${GOLD}.qry_model_health h ${clauses.length ? 'WHERE ' + clauses.join(' AND ') : ''}`;
      const value = await cached('models:' + JSON.stringify({ applied, flag }), async () => {
        const [[totals], rows] = await Promise.all([
          runSql(`SELECT ${MODEL_TOTALS} ${from}`),
          runSql(`SELECT ${MODEL_COLUMNS} ${from} ORDER BY h.action_order, h.criticality_order, h.model_id`),
        ]);
        return { totals, rows };
      });
      res.json(value);
    } catch (err) { fail(res, err); }
  });

  /**
   * One round trip for the whole Explorer: filtered headline measures (and the whole fleet for
   * comparison), every breakdown, business unit x asset type, the day-by-day trend and the
   * models behind it all. A breakdown that fails comes back empty.
   */
  router.get('/api/explorer/data', async (req, res) => {
    try {
      const { where, applied } = await filtersFrom(req.query);
      const value = await cached('data:' + JSON.stringify(applied), async () => {
        const q = (sql: string) => runSql(sql).catch((err): Rows => {
          console.warn('[explorer] query failed:', err instanceof Error ? err.message : err);
          return [];
        });
        const pm = `(${PER_MODEL(where)}) pm`;
        const by = (col: string, order = 'models DESC') =>
          q(`SELECT ${col} AS k, ${MEASURES} FROM ${pm} GROUP BY ${col} ORDER BY ${order}, k`);
        const [totals, fleet, bu, site, asset, modelType, criticality, team, health, grid, trend, models] = await Promise.all([
          q(`SELECT ${MEASURES} FROM ${pm}`),
          cached('fleet', () => q(`SELECT ${MEASURES} FROM (${PER_MODEL('')}) pm`)),
          by('business_unit'),
          by('site_name'),
          by('asset_type'),
          by('model_type'),
          q(`SELECT criticality AS k, MIN(criticality_order) AS ord, ${MEASURES} FROM ${pm} GROUP BY criticality ORDER BY ord`),
          by('owner_team'),
          by('health_status'),
          q(`SELECT business_unit, asset_type, ${MEASURES} FROM ${pm} GROUP BY business_unit, asset_type`),
          q(`SELECT CAST(prediction_date AS STRING) AS day, COUNT(DISTINCT model_id) AS models, SUM(predictions) AS predictions,
                    SUM(confidence_sum) / SUM(predictions) AS avg_confidence,
                    1.0 * SUM(low_confidence_predictions) / SUM(predictions) AS low_confidence_share,
                    SUM(drift_sum) / SUM(predictions) AS avg_drift, SUM(alerts) AS alerts,
                    SUM(confirmed_incidents) AS confirmed_incidents, SUM(cost_savings_usd) AS cost_savings_usd
               FROM ${BASE} ${where} GROUP BY prediction_date ORDER BY prediction_date`),
          q(`SELECT model_id, model_name, business_unit, site_name, asset_type, model_type, criticality, owner_team, health_status,
                    predictions, confidence_sum / NULLIF(predictions, 0) AS avg_confidence,
                    1.0 * low_confidence_predictions / NULLIF(predictions, 0) AS low_confidence_share,
                    drift_sum / NULLIF(predictions, 0) AS avg_drift, error_pct, latency_sum / NULLIF(predictions, 0) AS avg_latency_ms,
                    alerts, confirmed_incidents, false_positives, downtime_avoided_hours, cost_savings_usd
               FROM ${pm} ORDER BY needs_attention_flag DESC, cost_savings_usd DESC, model_id`),
        ]);
        return {
          applied, totals: totals[0] ?? null, fleet: fleet[0] ?? null,
          by: { business_unit: bu, site: site, asset: asset, model_type: modelType, criticality, team, health },
          grid, trend, models,
        };
      });
      res.json(value);
    } catch (err) { fail(res, err); }
  });

  return router;
}
