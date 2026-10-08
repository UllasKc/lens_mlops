import express from 'express';
import { currentVersions, type Lakebase } from '../lib/answerCache.js';
import { runSql } from '../lib/sql.js';

const GOLD = process.env.LENS_GOLD_SCHEMA ?? 'cnx_automl_dev.lens_mlops_gold';
if (!/^[A-Za-z0-9_]+\.[A-Za-z0-9_]+$/.test(GOLD)) {
  throw new Error(`LENS_GOLD_SCHEMA must be "<catalog>.<schema>", got: ${GOLD}`);
}

/** Keep results this long if the data version can't be read (e.g. Lakebase down). */
const FALLBACK_TTL_MS = 10 * 60_000;

/** How often the app checks whether the data changed, to have the Command Center ready again. */
const WARM_EVERY_MS = 5 * 60_000;

/** Times are shown as recorded in the data (site time), never shifted to the viewer's time zone. */
const t = (col: string, as = col) => `date_format(${col}, 'yyyy-MM-dd HH:mm') AS ${as}`;

/**
 * The Command Center only changes when deploy.py reloads gold data, so each
 * panel's result is kept in memory for the current data version: every
 * visitor gets it instantly and the warehouse isn't queried. The app fills it
 * itself when it starts and when the data changes (see `warm`), so the first
 * visitor doesn't wait for the warehouse either; visitors arriving while it is
 * being computed share that one computation.
 */
function dashboardCache(db: Lakebase) {
  const entries = new Map<string, { version: string | null; at: number; value: unknown }>();
  const inflight = new Map<string, Promise<unknown>>();
  const get = async (name: string, compute: () => Promise<unknown>): Promise<{ value: unknown; hit: boolean }> => {
    const version = await currentVersions(db).then((v) => v.data, () => null);
    const e = entries.get(name);
    if (e && (version && e.version ? e.version === version : Date.now() - e.at < FALLBACK_TTL_MS)) return { value: e.value, hit: true };
    const key = `${name}|${version}`;
    let p = inflight.get(key);
    if (!p) {
      p = compute()
        .then((value) => { entries.set(name, { version, at: Date.now(), value }); return value; })
        .finally(() => inflight.delete(key));
      inflight.set(key, p);
    }
    return { value: await p, hit: false };
  };
  const send = async (name: string, res: express.Response, compute: () => Promise<unknown>) => {
    try {
      const { value, hit } = await get(name, compute);
      res.setHeader('X-Cache', hit ? 'hit' : 'miss');
      res.json(value);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  };
  return { get, send };
}

/** Model columns shown wherever a list of models opens (Command Center and Explorer). */
export const MODEL_COLUMNS = `h.model_id, h.model_name, h.business_unit, h.site_name, h.asset_type, h.criticality, h.owner_team,
  h.model_version, h.health_status, h.latest_day_avg_confidence, h.latest_day_low_confidence_share, h.first_day_avg_drift,
  h.latest_day_avg_drift, h.error_pct, h.mae, h.unit_of_measure, h.alerts, h.confirmed_incidents, h.false_positive_rate,
  h.downtime_avoided_hours, h.cost_savings_usd, h.recommended_action`;
export const MODEL_TOTALS = `COUNT(*) AS models, SUM(h.alerts) AS alerts, SUM(h.confirmed_incidents) AS confirmed_incidents,
  SUM(h.downtime_avoided_hours) AS downtime_avoided_hours, SUM(h.cost_savings_usd) AS cost_savings_usd`;

export function buildDashboardRouter(db: Lakebase): express.Router {
  const router = express.Router();
  const cache = dashboardCache(db);
  const cached = cache.send;

  const computeSummary = async () => {
    const [[kpis], [narrative]] = await Promise.all([
      runSql(`SELECT *, ${t('as_of_time', 'as_of')}, ${t('window_start', 'window_from')} FROM ${GOLD}.qry_cc_kpis`),
      // Written once by deploy.py's `summary` step; missing until that step has run.
      runSql(`SELECT narrative, CAST(generated_at AS STRING) AS narrative_generated_at,
                     CAST(data_refreshed_at AS STRING) AS data_refreshed_at FROM ${GOLD}.exec_summary LIMIT 1`)
        .catch(() => [{ narrative: null, narrative_generated_at: null, data_refreshed_at: null }]),
    ]);
    return { ...kpis, ...narrative };
  };
  router.get('/api/dashboard/summary', (_req, res) => cached('summary', res, computeSummary));

  /**
   * Everything the Command Center shows beyond the headline, in one round trip: each panel
   * is a certified-view query (no AI), run in parallel and cached per data version like the
   * rest. A panel that fails comes back empty rather than failing the page.
   */
  const computeOverview = async () => {
    const q = (sql: string) => runSql(sql).catch((err) => {
      console.warn('[dashboard] overview panel failed:', err instanceof Error ? err.message : err);
      return [] as Record<string, string | null>[];
    });
    const [actions, healthByBu, assets, attention, incidents, valueByBu, valueByCrit, trend, yieldByAsset, rules] = await Promise.all([
      q(`SELECT * FROM ${GOLD}.qry_cc_actions`),
      q(`SELECT * FROM ${GOLD}.qry_cc_health_by_bu ORDER BY models_needing_attention DESC, models DESC`),
      q(`SELECT asset_type, COUNT(*) AS models, SUM(needs_attention_flag) AS models_needing_attention,
                SUM(drifting_flag) AS drifting_models, SUM(low_confidence_flag) AS low_confidence_models,
                AVG(error_pct) AS avg_error_pct, SUM(cost_savings_usd) AS cost_savings_usd
           FROM ${GOLD}.qry_model_health GROUP BY asset_type ORDER BY models_needing_attention DESC, asset_type`),
      q(`SELECT model_id, model_name, business_unit, site_name, asset_type, criticality, health_status, recommended_action,
                action_order, first_day_avg_drift, latest_day_avg_drift, latest_day_avg_confidence, latest_day_low_confidence_share,
                alerts, false_positives, false_positive_rate, unanswered_alert_hours
           FROM ${GOLD}.qry_model_health WHERE action_order < 9
          ORDER BY action_order, criticality_order, latest_day_avg_drift DESC, latest_day_low_confidence_share DESC`),
      q(`SELECT incident_id, model_id, model_name, business_unit, site_name, asset_type, criticality, ${t('incident_start')},
                ${t('incident_end')}, duration_minutes, alerts, confirmed_incidents, false_positives, false_positive_rate,
                downtime_avoided_hours, cost_savings_usd, responses, unanswered_alerts, level_vs_normal
           FROM ${GOLD}.qry_incidents ORDER BY cost_savings_usd DESC`),
      q(`SELECT * FROM ${GOLD}.qry_value_by_business_unit ORDER BY cost_savings_usd DESC, business_unit`),
      q(`SELECT * FROM ${GOLD}.qry_value_by_criticality ORDER BY criticality_order`),
      q(`SELECT CAST(day AS STRING) AS day, models, verified_share, avg_confidence, low_confidence_share, avg_drift, drifting_models,
                alerts, confirmed_incidents, false_positives, downtime_avoided_hours, cost_savings_usd
           FROM ${GOLD}.qry_daily_fleet_trend ORDER BY day`),
      q(`SELECT asset_type, MEASURE(avg_yield_improvement_pct) AS avg_yield_improvement_pct, MEASURE(models) AS models
           FROM ${GOLD}.mv_business_outcomes WHERE asset_type IN ('Reactor', 'Furnace') GROUP BY asset_type ORDER BY asset_type`),
      q(`SELECT * FROM ${GOLD}.qry_rules`),
    ]);
    return {
      actions: actions[0] ?? null, healthByBu, assets, attention, incidents, valueByBu, valueByCrit, trend, yieldByAsset,
      rules: rules[0] ?? null,
    };
  };
  router.get('/api/dashboard/overview', (_req, res) => cached('overview', res, computeOverview));

  /**
   * The models behind a Command Center figure: every card can show its list, using the same
   * rule as the card's number (qry_model_health flags, qry_cc_kpis, qry_cc_actions). Lists are
   * fixed here; a request only picks one, plus a business unit, site, asset type or next step
   * where the list needs it (checked against the data, so nothing typed reaches the SQL).
   */
  type Needs = 'business_unit' | 'site_name' | 'asset_type' | 'criticality' | 'recommended_action';
  const LISTS: Record<string, { where: (v: string) => string; order: string; needs?: Needs }> = {
    all: { where: () => 'TRUE', order: 'h.action_order, h.model_id' },
    healthy: { where: () => "h.health_status = 'Healthy'", order: 'h.model_id' },
    attention: { where: () => 'h.needs_attention_flag = 1', order: 'h.action_order, h.criticality_order, h.model_id' },
    drifting: { where: () => 'h.drifting_flag = 1', order: 'h.latest_day_avg_drift DESC' },
    low_confidence: { where: () => 'h.low_confidence_flag = 1', order: 'h.latest_day_low_confidence_share DESC' },
    high_crit_attention: { where: () => "h.criticality = 'High' AND h.needs_attention_flag = 1", order: 'h.action_order, h.model_id' },
    high_criticality: { where: () => "h.criticality = 'High'", order: 'h.action_order, h.model_id' },
    with_alerts: { where: () => 'h.alerts > 0', order: 'h.cost_savings_usd DESC' },
    high_fp: { where: () => 'h.high_false_positive_flag = 1', order: 'h.false_positive_rate DESC' },
    unanswered: { where: () => 'h.unanswered_alert_hours > 0', order: 'h.unanswered_alert_hours DESC' },
    with_action: { where: () => 'h.action_order < 9', order: 'h.action_order, h.criticality_order, h.model_id' },
    queue_retrain: { where: () => 'h.action_order = 1', order: 'h.criticality_order, h.latest_day_avg_drift DESC' },
    queue_confidence: { where: () => 'h.action_order = 2', order: 'h.criticality_order, h.latest_day_low_confidence_share DESC' },
    queue_tune: { where: () => 'h.action_order = 3', order: 'h.false_positive_rate DESC' },
    action: { where: (v) => `h.recommended_action = ${v}`, order: 'h.criticality_order, h.model_id', needs: 'recommended_action' },
    business_unit: { where: (v) => `h.business_unit = ${v}`, order: 'h.action_order, h.model_id', needs: 'business_unit' },
    business_unit_attention: { where: (v) => `h.business_unit = ${v} AND h.needs_attention_flag = 1`, order: 'h.action_order, h.model_id', needs: 'business_unit' },
    site: { where: (v) => `h.site_name = ${v}`, order: 'h.action_order, h.model_id', needs: 'site_name' },
    asset: { where: (v) => `h.asset_type = ${v}`, order: 'h.action_order, h.model_id', needs: 'asset_type' },
    criticality: { where: (v) => `h.criticality = ${v}`, order: 'h.action_order, h.model_id', needs: 'criticality' },
  };
  /** The values a list may be narrowed to, from the data itself. */
  const allowed = (needs: Needs) => cache.get(`values:${needs}`, async () =>
    (await runSql(`SELECT DISTINCT ${needs} AS v FROM ${GOLD}.qry_model_health WHERE ${needs} IS NOT NULL`)).map((r) => String(r.v)),
  ).then((r) => r.value as string[]);

  router.get('/api/dashboard/models', async (req, res) => {
    const name = String(req.query.list ?? '');
    const list = LISTS[name];
    if (!list) { res.status(400).json({ error: 'unknown list' }); return; }
    let value = '';
    if (list.needs) {
      const v = String(req.query.value ?? '');
      if (!(await allowed(list.needs).catch(() => [] as string[])).includes(v)) { res.status(400).json({ error: `unknown ${list.needs}` }); return; }
      value = `'${v.replace(/'/g, "''")}'`;
    }
    const from = `FROM ${GOLD}.qry_model_health h WHERE ${list.where(value)}`;
    await cached(`models:${name}:${value}`, res, async () => {
      const [[totals], rows] = await Promise.all([
        runSql(`SELECT ${MODEL_TOTALS} ${from}`),
        runSql(`SELECT ${MODEL_COLUMNS} ${from} ORDER BY ${list.order}`),
      ]);
      return { totals, rows };
    });
  });

  /** The alerts (anomaly-flagged predictions) behind one incident, minute by minute. */
  const incidentIds = () => cache.get('values:incident', async () =>
    (await runSql(`SELECT incident_id AS v FROM ${GOLD}.qry_incidents`)).map((r) => String(r.v)),
  ).then((r) => r.value as string[]);
  router.get('/api/dashboard/alerts', async (req, res) => {
    const id = String(req.query.incident ?? '');
    if (!(await incidentIds().catch(() => [] as string[])).includes(id)) { res.status(400).json({ error: 'unknown incident' }); return; }
    const where = `WHERE incident_id = '${id.replace(/'/g, "''")}'`;
    await cached(`alerts:${id}`, res, async () => {
      const [[totals], rows] = await Promise.all([
        runSql(`SELECT COUNT(*) AS alerts, COUNT(actual_value) AS verified, AVG(confidence_score) AS avg_confidence,
                       MAX(predicted_value) AS peak_predicted_value FROM ${GOLD}.qry_anomaly_predictions ${where}`),
        runSql(`SELECT ${t('prediction_time')}, model_id, model_name, site_name, unit_of_measure, predicted_value, actual_value,
                       prediction_error, confidence_score, drift_score, latency_ms
                  FROM ${GOLD}.qry_anomaly_predictions ${where} ORDER BY prediction_time`),
      ]);
      return { totals, rows };
    });
  });

  // Have the Command Center ready before anyone asks: when the app starts, then whenever the
  // data version changes (a quick Lakebase read every few minutes; the warehouse is only
  // queried when something changed).
  const warm = () => {
    void Promise.all([cache.get('summary', computeSummary), cache.get('overview', computeOverview)])
      .catch((err: unknown) => console.warn('[dashboard] warm-up failed:', err instanceof Error ? err.message : err));
  };
  setTimeout(warm, 3000).unref();
  setInterval(warm, WARM_EVERY_MS).unref();

  return router;
}
