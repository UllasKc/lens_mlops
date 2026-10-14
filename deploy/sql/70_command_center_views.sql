-- Command Center and Explorer views. Every card is built from gold.qry_model_health (one row per
-- model) or the outcome tables, with thresholds from gold.qry_rules, so each figure is reproducible
-- and each "View models" list uses the same rule as its card.

-- 1. Headline figures (one row).
CREATE OR REPLACE VIEW {{catalog}}.{{prefix}}_gold.qry_cc_kpis AS
WITH h AS (SELECT * FROM {{catalog}}.{{prefix}}_gold.qry_model_health),
a AS (SELECT * FROM {{catalog}}.{{prefix}}_gold.qry_as_of),
i AS (SELECT COUNT(*) AS incidents, SUM(unanswered_alerts) AS unanswered_alerts FROM {{catalog}}.{{prefix}}_gold.qry_incidents)
SELECT
  COUNT(*)                                                         AS models,
  COUNT(DISTINCT h.site_id)                                        AS sites,
  COUNT(DISTINCT h.business_unit)                                  AS business_units,
  SUM(h.predictions)                                               AS predictions,
  SUM(h.verified_predictions)                                      AS verified_predictions,
  1.0 * SUM(h.verified_predictions) / NULLIF(SUM(h.predictions), 0) AS verified_share,
  SUM(h.avg_confidence * h.predictions) / NULLIF(SUM(h.predictions), 0) AS avg_confidence,
  SUM(h.low_confidence_predictions)                                AS low_confidence_predictions,
  1.0 * SUM(h.low_confidence_predictions) / NULLIF(SUM(h.predictions), 0) AS low_confidence_share,
  SUM(CASE WHEN h.health_status = 'Healthy' THEN 1 ELSE 0 END)    AS healthy_models,
  SUM(h.drifting_flag)                                             AS drifting_models,
  SUM(h.low_confidence_flag)                                       AS low_confidence_models,
  SUM(CASE WHEN h.health_status = 'Low confidence' THEN 1 ELSE 0 END) AS low_confidence_only_models,
  SUM(h.needs_attention_flag)                                      AS models_needing_attention,
  SUM(CASE WHEN h.criticality = 'High' THEN 1 ELSE 0 END)         AS high_criticality_models,
  SUM(CASE WHEN h.criticality = 'High' AND h.needs_attention_flag = 1 THEN 1 ELSE 0 END) AS high_criticality_needing_attention,
  AVG(CASE WHEN h.drifting_flag = 1 THEN h.latest_day_avg_drift END)  AS drifting_latest_avg_drift,
  AVG(CASE WHEN h.drifting_flag = 1 THEN h.first_day_avg_drift END)   AS drifting_first_avg_drift,
  AVG(CASE WHEN h.drifting_flag = 0 THEN h.latest_day_avg_drift END)  AS others_latest_avg_drift,
  SUM(h.alerts)                                                    AS alerts,
  SUM(h.confirmed_incidents)                                       AS confirmed_incidents,
  SUM(h.false_positives)                                           AS false_positives,
  1.0 * SUM(h.false_positives) / NULLIF(SUM(h.alerts), 0)         AS false_positive_rate,
  1.0 * SUM(h.confirmed_incidents) / NULLIF(SUM(h.alerts), 0)     AS alert_precision,
  SUM(CASE WHEN h.alerts > 0 THEN 1 ELSE 0 END)                   AS models_with_alerts,
  SUM(h.high_false_positive_flag)                                  AS high_false_positive_models,
  SUM(h.downtime_avoided_hours)                                    AS downtime_avoided_hours,
  SUM(h.cost_savings_usd)                                          AS cost_savings_usd,
  MAX(h.cost_savings_usd)                                          AS top_model_savings,
  MAX(i.incidents)                                                 AS incidents,
  MAX(i.unanswered_alerts)                                         AS unanswered_alerts,
  SUM(h.avg_latency_ms * h.predictions) / NULLIF(SUM(h.predictions), 0) AS avg_latency_ms,
  MAX(h.p95_latency_ms)                                            AS worst_p95_latency_ms,
  MAX(a.window_start)                                              AS window_start,
  MAX(a.as_of_time)                                                AS as_of_time,
  MAX(a.days_in_window)                                            AS days_in_window
FROM h CROSS JOIN a CROSS JOIN i;
COMMENT ON TABLE {{catalog}}.{{prefix}}_gold.qry_cc_kpis IS 'Answers: "How healthy is our model fleet right now?", "How many models need attention?", the headline figures on the Command Center. One row: models, sites, healthy / drifting / low-confidence models, alerts, incidents, false-positive rate, downtime avoided, savings, latency and the window, all from qry_model_health and qry_incidents. Use it for headline counts; drifting_models + low_confidence_only_models = models_needing_attention.';
COMMENT ON COLUMN {{catalog}}.{{prefix}}_gold.qry_cc_kpis.low_confidence_models IS 'Models with low_confidence_flag (includes a drifting one)';
COMMENT ON COLUMN {{catalog}}.{{prefix}}_gold.qry_cc_kpis.low_confidence_only_models IS 'Models whose health_status is Low confidence (not drifting)';
COMMENT ON COLUMN {{catalog}}.{{prefix}}_gold.qry_cc_kpis.models_needing_attention IS 'Drifting or low-confidence models';
COMMENT ON COLUMN {{catalog}}.{{prefix}}_gold.qry_cc_kpis.high_false_positive_models IS 'Models above false_positive_rate_threshold, whatever their queue';

-- 2. Fleet health by business unit.
CREATE OR REPLACE VIEW {{catalog}}.{{prefix}}_gold.qry_cc_health_by_bu AS
SELECT business_unit, COUNT(*) AS models,
  SUM(CASE WHEN health_status = 'Healthy' THEN 1 ELSE 0 END) AS healthy_models,
  SUM(drifting_flag) AS drifting_models,
  SUM(CASE WHEN health_status = 'Low confidence' THEN 1 ELSE 0 END) AS low_confidence_models,
  SUM(needs_attention_flag) AS models_needing_attention,
  SUM(CASE WHEN criticality = 'High' THEN 1 ELSE 0 END) AS high_criticality_models,
  SUM(avg_confidence * predictions) / NULLIF(SUM(predictions), 0) AS avg_confidence,
  SUM(cost_savings_usd) AS cost_savings_usd
FROM {{catalog}}.{{prefix}}_gold.qry_model_health
GROUP BY business_unit;
COMMENT ON TABLE {{catalog}}.{{prefix}}_gold.qry_cc_health_by_bu IS 'Answers: "Where does the fleet need attention?", fleet health by business unit. One row per business unit: models, healthy, drifting, low-confidence (status) and needing attention, high-criticality models, average confidence and savings. For value by business unit use qry_value_by_business_unit.';
COMMENT ON COLUMN {{catalog}}.{{prefix}}_gold.qry_cc_health_by_bu.low_confidence_models IS 'Models whose health_status is Low confidence';

-- 3. Action queues (one row). Each model sits in one queue: the first that applies in
-- qry_model_health.recommended_action (drift, then confidence, then false alarms, then unanswered alerts).
CREATE OR REPLACE VIEW {{catalog}}.{{prefix}}_gold.qry_cc_actions AS
SELECT
  SUM(CASE WHEN action_order = 1 THEN 1 ELSE 0 END) AS retrain_review_models,
  SUM(CASE WHEN action_order = 1 AND criticality = 'High' THEN 1 ELSE 0 END) AS retrain_review_high_criticality,
  SUM(CASE WHEN action_order = 2 THEN 1 ELSE 0 END) AS investigate_confidence_models,
  SUM(CASE WHEN action_order = 2 AND criticality = 'High' THEN 1 ELSE 0 END) AS investigate_confidence_high_criticality,
  SUM(CASE WHEN action_order = 3 THEN 1 ELSE 0 END) AS tune_alert_models,
  SUM(CASE WHEN action_order = 3 THEN false_positives ELSE 0 END) AS tune_alert_false_positives,
  SUM(CASE WHEN action_order = 3 THEN alerts ELSE 0 END) AS tune_alert_alerts,
  SUM(CASE WHEN unanswered_alert_hours > 0 THEN 1 ELSE 0 END) AS unanswered_alert_models,
  SUM(unanswered_alert_hours) AS unanswered_alert_hours,
  SUM(CASE WHEN action_order < 9 THEN 1 ELSE 0 END) AS models_with_action
FROM {{catalog}}.{{prefix}}_gold.qry_model_health;
COMMENT ON TABLE {{catalog}}.{{prefix}}_gold.qry_cc_actions IS 'Answers: "What should we do this week?", "What are the action queues?" One row: the size of each queue. Each model sits in the first queue that applies (qry_model_health.action_order): drift review, investigate confidence, tune alerts (more than false_positive_rate_threshold false alarms and not drifting or low-confidence), then unanswered alerts. List the models with qry_model_health WHERE action_order < 9.';
COMMENT ON COLUMN {{catalog}}.{{prefix}}_gold.qry_cc_actions.retrain_review_models IS 'Models in queue 1 (drifting): review drift and plan retraining';
COMMENT ON COLUMN {{catalog}}.{{prefix}}_gold.qry_cc_actions.retrain_review_high_criticality IS 'Of the queue 1 models, how many are High criticality';
COMMENT ON COLUMN {{catalog}}.{{prefix}}_gold.qry_cc_actions.investigate_confidence_models IS 'Models in queue 2 (low confidence, not drifting)';
COMMENT ON COLUMN {{catalog}}.{{prefix}}_gold.qry_cc_actions.investigate_confidence_high_criticality IS 'Of the queue 2 models, how many are High criticality';
COMMENT ON COLUMN {{catalog}}.{{prefix}}_gold.qry_cc_actions.tune_alert_false_positives IS 'A count of ALERTS, not models: the false alarms raised by the queue 3 models';
COMMENT ON COLUMN {{catalog}}.{{prefix}}_gold.qry_cc_actions.tune_alert_alerts IS 'A count of ALERTS, not models: all alerts raised by the queue 3 models';
COMMENT ON COLUMN {{catalog}}.{{prefix}}_gold.qry_cc_actions.unanswered_alert_hours IS 'A count of HOURS, not models: alert hours recorded as Ignored or No Action';
COMMENT ON COLUMN {{catalog}}.{{prefix}}_gold.qry_cc_actions.tune_alert_models IS 'Models in queue 3 only (a drifting model with many false alarms is in queue 1)';
COMMENT ON COLUMN {{catalog}}.{{prefix}}_gold.qry_cc_actions.unanswered_alert_models IS 'Models with alert hours recorded as Ignored or No Action, whatever their queue';
COMMENT ON COLUMN {{catalog}}.{{prefix}}_gold.qry_cc_actions.models_with_action IS 'Models with any next step (action_order < 9)';

-- 4. Explorer base: one row per model per day, with every dimension the Explorer filters on and
-- the sums its measures are built from. The app aggregates per model first, then per group, with
-- the same formulas as the certified views, so an unfiltered Explorer reconciles to the Command Center.
CREATE OR REPLACE VIEW {{catalog}}.{{prefix}}_gold.qry_explorer_base AS
WITH r AS (SELECT * FROM {{catalog}}.{{prefix}}_gold.qry_rules),
pd AS (
  SELECT f.model_id, CAST(f.prediction_time AS DATE) AS prediction_date,
    COUNT(*) AS predictions,
    COUNT(f.actual_value) AS verified_predictions,
    SUM(f.confidence_score) AS confidence_sum,
    SUM(CASE WHEN f.confidence_score < r.low_confidence_score THEN 1 ELSE 0 END) AS low_confidence_predictions,
    SUM(f.drift_score) AS drift_sum,
    SUM(CASE WHEN f.anomaly_flag THEN 1 ELSE 0 END) AS anomaly_alerts,
    SUM(ABS(f.prediction_error)) AS abs_error_sum,
    SUM(CASE WHEN f.actual_value IS NOT NULL THEN ABS(f.actual_value) END) AS abs_actual_sum,
    SUM(f.latency_ms) AS latency_sum
  FROM {{catalog}}.{{prefix}}_silver.fact_predictions f CROSS JOIN r
  GROUP BY f.model_id, CAST(f.prediction_time AS DATE)
), od AS (
  SELECT model_id, CAST(date_hour AS DATE) AS outcome_date,
    SUM(incidents_predicted) AS alerts, SUM(incidents_confirmed) AS confirmed_incidents, SUM(false_positives) AS false_positives,
    SUM(downtime_avoided_hours) AS downtime_avoided_hours, SUM(estimated_cost_savings_usd) AS cost_savings_usd
  FROM {{catalog}}.{{prefix}}_silver.fact_business_outcomes
  GROUP BY model_id, CAST(date_hour AS DATE)
)
SELECT h.model_id, h.model_name, h.business_unit, h.site_name, h.site_id, h.asset_type, h.model_type, h.criticality,
  h.criticality_order, h.owner_team, h.model_version, h.unit_of_measure, h.health_status, h.recommended_action,
  h.drifting_flag, h.low_confidence_flag, h.high_false_positive_flag, h.needs_attention_flag,
  pd.prediction_date, pd.predictions, pd.verified_predictions, pd.confidence_sum, pd.low_confidence_predictions,
  pd.drift_sum, pd.anomaly_alerts, pd.abs_error_sum, pd.abs_actual_sum, pd.latency_sum,
  COALESCE(od.alerts, 0) AS alerts, COALESCE(od.confirmed_incidents, 0) AS confirmed_incidents,
  COALESCE(od.false_positives, 0) AS false_positives, COALESCE(od.downtime_avoided_hours, 0) AS downtime_avoided_hours,
  COALESCE(od.cost_savings_usd, 0) AS cost_savings_usd
FROM pd
JOIN {{catalog}}.{{prefix}}_gold.qry_model_health h ON h.model_id = pd.model_id
LEFT JOIN od ON od.model_id = pd.model_id AND od.outcome_date = pd.prediction_date;
COMMENT ON TABLE {{catalog}}.{{prefix}}_gold.qry_explorer_base IS 'Internal to the Explorer tab, not a Genie source: one row per model per day with partial sums (confidence_sum, drift_sum, abs_error_sum...). The app aggregates per model, then per group. Averaging its columns directly gives wrong answers; use qry_model_health or the metric views instead.';
