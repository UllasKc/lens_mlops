-- Command Center operations views: serving SLA, cost, feature drift, retraining, governance and
-- recorded causes, built on the synthetic silver.ops_* tables plus the source data's accuracy and
-- health (qry_model_health). Thresholds come from gold.qry_rules. The model health views and
-- figures from the source data are unchanged; these views add to them.

-- 1. One row per model: operations facts, flags, fleet tier, health score and optimisation lever.
CREATE OR REPLACE VIEW {{catalog}}.{{prefix}}_gold.qry_model_ops AS
WITH a AS (SELECT * FROM {{catalog}}.{{prefix}}_gold.qry_as_of),
r AS (SELECT * FROM {{catalog}}.{{prefix}}_gold.qry_rules),
acc AS (
  SELECT f.model_id,
    SUM(CASE WHEN CAST(f.prediction_time AS DATE) = a.first_day THEN ABS(f.prediction_error) END)
      / NULLIF(SUM(CASE WHEN CAST(f.prediction_time AS DATE) = a.first_day AND f.actual_value IS NOT NULL THEN ABS(f.actual_value) END), 0) AS first_day_error_pct,
    SUM(CASE WHEN CAST(f.prediction_time AS DATE) = a.latest_day THEN ABS(f.prediction_error) END)
      / NULLIF(SUM(CASE WHEN CAST(f.prediction_time AS DATE) = a.latest_day AND f.actual_value IS NOT NULL THEN ABS(f.actual_value) END), 0) AS latest_day_error_pct
  FROM {{catalog}}.{{prefix}}_silver.fact_predictions f CROSS JOIN a
  GROUP BY f.model_id
), sv AS (
  SELECT s.model_id,
    SUM(s.cost_usd) AS monthly_cost_usd,
    SUM(CASE WHEN s.serving_date >= trunc(a.latest_day, 'MM') THEN s.cost_usd ELSE 0 END) AS cost_mtd_usd,
    SUM(CASE WHEN s.serving_date >= trunc(a.latest_day, 'MM') THEN s.requests ELSE 0 END) AS requests_mtd,
    SUM(CASE WHEN s.serving_date >= trunc(a.latest_day, 'MM') THEN s.downtime_minutes ELSE 0 END) AS downtime_mtd_minutes,
    MAX(CASE WHEN s.serving_date = a.latest_day THEN s.p95_latency_ms END) AS latest_p95_latency_ms,
    MAX(CASE WHEN s.serving_date > date_sub(a.latest_day, 7) THEN s.p95_latency_ms END) AS week_max_p95_latency_ms,
    AVG(CASE WHEN s.serving_date > date_sub(a.latest_day, 7) THEN s.utilization_pct END) AS week_avg_utilization_pct,
    AVG(CASE WHEN s.serving_date > date_sub(a.latest_day, 7) THEN s.requests END) AS week_avg_requests_per_day
  FROM {{catalog}}.{{prefix}}_silver.ops_serving_daily s CROSS JOIN a
  GROUP BY s.model_id
), fd AS (
  SELECT d.model_id, COUNT(*) AS features,
    SUM(CASE WHEN d.psi_latest > r.psi_drift_threshold THEN 1 ELSE 0 END) AS drifted_features,
    MAX(d.psi_latest) AS max_feature_psi,
    array_join(array_sort(collect_list(CASE WHEN d.psi_latest > r.psi_drift_threshold THEN d.feature_name END)), ', ') AS drifted_feature_names
  FROM {{catalog}}.{{prefix}}_silver.ops_feature_drift d CROSS JOIN r
  GROUP BY d.model_id
), ev AS (
  SELECT em.model_id,
    array_join(array_sort(collect_list(concat(date_format(e.event_time, 'd MMM'), ': ', e.description))), ' ') AS recorded_causes
  FROM {{catalog}}.{{prefix}}_silver.ops_event_model em
  JOIN {{catalog}}.{{prefix}}_silver.ops_pipeline_event e ON e.event_id = em.event_id
  GROUP BY em.model_id
), b AS (
  SELECT h.model_id, h.model_name, h.business_unit, h.site_name, h.asset_type, h.model_type, h.criticality,
    h.criticality_order, h.owner_team, h.model_version, h.health_status, h.drifting_flag, h.low_confidence_flag, h.action_order,
    e.endpoint_name, e.serving_mode, e.compute_type, e.instance_count, e.value_at_stake_usd_month,
    e.last_trained_date, e.retrain_cadence_days, datediff(a.latest_day, e.last_trained_date) AS days_since_trained,
    acc.first_day_error_pct, acc.latest_day_error_pct,
    acc.latest_day_error_pct / NULLIF(acc.first_day_error_pct, 0) - 1 AS error_change,
    sv.monthly_cost_usd, sv.cost_mtd_usd, sv.requests_mtd, sv.downtime_mtd_minutes, sv.latest_p95_latency_ms,
    sv.week_max_p95_latency_ms, sv.week_avg_utilization_pct, sv.week_avg_requests_per_day,
    fd.features, fd.drifted_features, fd.max_feature_psi, fd.drifted_feature_names,
    g.model_card_updated, g.last_bias_audit, g.next_audit_due, g.review_deadline,
    ev.recorded_causes,
    CASE WHEN e.serving_mode = 'real_time' AND sv.latest_p95_latency_ms > r.latency_slo_ms THEN 1 ELSE 0 END AS latency_breach_flag,
    CASE WHEN e.serving_mode = 'real_time' AND sv.week_max_p95_latency_ms > r.latency_slo_ms THEN 1 ELSE 0 END AS latency_breach_week_flag,
    CASE WHEN fd.drifted_features >= r.psi_drift_feature_count THEN 1 ELSE 0 END AS data_drift_flag,
    CASE WHEN fd.drifted_features BETWEEN 1 AND r.psi_drift_feature_count - 1 THEN 1 ELSE 0 END AS feature_watch_flag,
    CASE WHEN acc.latest_day_error_pct / NULLIF(acc.first_day_error_pct, 0) - 1 >= r.accuracy_drop_watch THEN 1 ELSE 0 END AS accuracy_drop_flag,
    CASE WHEN acc.latest_day_error_pct / NULLIF(acc.first_day_error_pct, 0) - 1 >= r.accuracy_drop_rollback THEN 1 ELSE 0 END AS rollback_flag,
    CASE WHEN datediff(a.latest_day, e.last_trained_date) > r.stale_model_days THEN 1 ELSE 0 END AS stale_flag,
    CASE WHEN datediff(a.latest_day, e.last_trained_date) <= r.stale_model_days
          AND datediff(a.latest_day, e.last_trained_date) - e.retrain_cadence_days > r.retrain_overdue_days THEN 1 ELSE 0 END AS retrain_overdue_flag,
    CASE WHEN datediff(a.latest_day, g.model_card_updated) > r.model_card_max_age_days OR g.next_audit_due < a.latest_day THEN 1 ELSE 0 END AS governance_gap_flag,
    CASE WHEN e.compute_type = 'GPU' AND sv.week_avg_utilization_pct < r.gpu_low_utilization_pct THEN 1 ELSE 0 END AS low_utilization_flag,
    CASE WHEN sv.week_avg_requests_per_day < r.idle_requests_per_day THEN 1 ELSE 0 END AS idle_flag
  FROM {{catalog}}.{{prefix}}_gold.qry_model_health h
  JOIN {{catalog}}.{{prefix}}_silver.ops_model_endpoint e ON e.model_id = h.model_id
  JOIN {{catalog}}.{{prefix}}_silver.ops_model_governance g ON g.model_id = h.model_id
  LEFT JOIN acc ON acc.model_id = h.model_id
  LEFT JOIN sv ON sv.model_id = h.model_id
  LEFT JOIN fd ON fd.model_id = h.model_id
  LEFT JOIN ev ON ev.model_id = h.model_id
  CROSS JOIN a CROSS JOIN r
), t AS (
  SELECT b.*,
    CASE WHEN latency_breach_flag = 1 THEN 'Breaching SLO'
         WHEN data_drift_flag = 1 OR drifting_flag = 1 OR accuracy_drop_flag = 1 THEN 'Degrading'
         WHEN stale_flag = 1 THEN 'Stale'
         WHEN feature_watch_flag = 1 OR low_confidence_flag = 1 OR retrain_overdue_flag = 1 THEN 'Watch'
         ELSE 'Healthy' END AS fleet_tier,
    CASE WHEN latency_breach_flag = 1 THEN 1
         WHEN data_drift_flag = 1 OR drifting_flag = 1 OR accuracy_drop_flag = 1 THEN 2
         WHEN stale_flag = 1 THEN 3
         WHEN feature_watch_flag = 1 OR low_confidence_flag = 1 OR retrain_overdue_flag = 1 THEN 4
         ELSE 5 END AS tier_order
  FROM b
), l AS (
  SELECT t.*,
    100 - CASE tier_order WHEN 1 THEN r.health_penalty_breaching WHEN 2 THEN r.health_penalty_degrading
                          WHEN 3 THEN r.health_penalty_stale WHEN 4 THEN r.health_penalty_watch ELSE 0 END AS health_score,
    CASE WHEN criticality = 'High' AND tier_order <= 3 THEN 1 ELSE 0 END AS high_risk_flag,
    CASE WHEN latency_breach_flag = 1 THEN 'Fix latency'
         WHEN tier_order = 2 THEN 'Retrain'
         WHEN stale_flag = 1 AND idle_flag = 1 THEN 'Decommission'
         WHEN low_utilization_flag = 1 THEN 'Right-size GPU' END AS optimisation_lever,
    CASE WHEN latency_breach_flag = 1 OR tier_order = 2 THEN 'Value recovery'
         WHEN (stale_flag = 1 AND idle_flag = 1) OR low_utilization_flag = 1 THEN 'Cost saving' END AS lever_kind,
    CASE WHEN latency_breach_flag = 1 OR tier_order = 2 THEN value_at_stake_usd_month * r.degraded_value_loss_share
         WHEN stale_flag = 1 AND idle_flag = 1 THEN monthly_cost_usd
         WHEN low_utilization_flag = 1 THEN monthly_cost_usd * r.rightsize_saving_share
         ELSE 0 END AS potential_saving_usd_month
  FROM t CROSS JOIN r
)
SELECT l.*,
  CASE WHEN potential_saving_usd_month > 0
       THEN ROW_NUMBER() OVER (ORDER BY potential_saving_usd_month DESC, model_id) END AS optimisation_rank,
  CASE WHEN potential_saving_usd_month > 0
        AND ROW_NUMBER() OVER (ORDER BY potential_saving_usd_month DESC, model_id) <= r.top_optimisation_targets THEN 1 ELSE 0 END AS top_target_flag
FROM l CROSS JOIN r;
COMMENT ON TABLE {{catalog}}.{{prefix}}_gold.qry_model_ops IS 'Answers: "Which models are breaching SLO / degrading / stale / on watch?", "What is each model''s health score, cost and potential saving?", "Why is this model flagged?" One row per model: serving (mode, compute, cost, latency, utilisation), retraining age, feature drift, governance dates, accuracy change over the window, flags, fleet_tier and the optimisation lever. SYNTHETIC DEMO DATA for serving, cost, feature drift, retraining, governance and recorded causes (silver.ops_*); accuracy (error_change) and drifting / low-confidence come from the source data. Tier precedence: Breaching SLO > Degrading > Stale > Watch > Healthy. Thresholds in gold.business_rules_config.';
COMMENT ON COLUMN {{catalog}}.{{prefix}}_gold.qry_model_ops.fleet_tier IS 'Breaching SLO (real-time endpoint over latency_slo_ms on the latest day), Degrading (data drift on psi_drift_feature_count+ features, drifting in the source data, or error up accuracy_drop_watch+), Stale (trained more than stale_model_days ago), Watch (1-2 drifted features, low confidence or retraining overdue) or Healthy; the first that applies';
COMMENT ON COLUMN {{catalog}}.{{prefix}}_gold.qry_model_ops.tier_order IS '1 Breaching SLO, 2 Degrading, 3 Stale, 4 Watch, 5 Healthy';
COMMENT ON COLUMN {{catalog}}.{{prefix}}_gold.qry_model_ops.error_change IS 'Relative change in error (weighted absolute percentage error) from the first to the latest day; +0.14 means error rose 14% (accuracy fell). From the source data';
COMMENT ON COLUMN {{catalog}}.{{prefix}}_gold.qry_model_ops.health_score IS '100 minus the tier penalty (health_penalty_* rules); the fleet health score is the average';
COMMENT ON COLUMN {{catalog}}.{{prefix}}_gold.qry_model_ops.high_risk_flag IS '1 when High criticality and in the Breaching SLO, Degrading or Stale tier';
COMMENT ON COLUMN {{catalog}}.{{prefix}}_gold.qry_model_ops.monthly_cost_usd IS 'Serving cost over the last 30 days, US dollars (synthetic)';
COMMENT ON COLUMN {{catalog}}.{{prefix}}_gold.qry_model_ops.value_at_stake_usd_month IS 'Monthly business value that depends on the model, US dollars (synthetic estimate)';
COMMENT ON COLUMN {{catalog}}.{{prefix}}_gold.qry_model_ops.optimisation_lever IS 'Fix latency, Retrain, Decommission or Right-size GPU: the first that applies; null when none';
COMMENT ON COLUMN {{catalog}}.{{prefix}}_gold.qry_model_ops.potential_saving_usd_month IS 'Estimated monthly upside of the lever: value recovered (value at stake x degraded_value_loss_share) or cost saved (monthly cost, or x rightsize_saving_share). An estimate built on stated assumptions';
COMMENT ON COLUMN {{catalog}}.{{prefix}}_gold.qry_model_ops.recorded_causes IS 'Recorded pipeline or platform events linked to this model (silver.ops_pipeline_event); null when none is recorded. Quote these; never infer other causes';
COMMENT ON COLUMN {{catalog}}.{{prefix}}_gold.qry_model_ops.optimisation_rank IS '1 = largest potential saving; null when the model has no lever';

-- 2. The month so far: SLA, volume, error budget, outlook, promotions, latency SLO and fleet KPIs (one row).
CREATE OR REPLACE VIEW {{catalog}}.{{prefix}}_gold.qry_cc_ops_month AS
WITH a AS (SELECT * FROM {{catalog}}.{{prefix}}_gold.qry_as_of),
r AS (SELECT * FROM {{catalog}}.{{prefix}}_gold.qry_rules),
m AS (
  SELECT trunc(a.latest_day, 'MM') AS month_start, last_day(a.latest_day) AS month_end,
    day(a.latest_day) AS days_elapsed, day(last_day(a.latest_day)) AS days_in_month,
    day(last_day(a.latest_day)) - day(a.latest_day) AS days_left, a.latest_day
  FROM a
), s AS (
  SELECT COUNT(DISTINCT x.model_id) AS endpoints,
    SUM(CASE WHEN x.serving_date >= m.month_start THEN x.requests ELSE 0 END) AS requests_mtd,
    SUM(CASE WHEN x.serving_date >= m.month_start THEN x.forecast_requests ELSE 0 END) AS forecast_requests_mtd,
    SUM(CASE WHEN x.serving_date >= m.month_start THEN x.downtime_minutes ELSE 0 END) AS downtime_mtd_minutes,
    SUM(CASE WHEN x.serving_date >= m.month_start THEN 1440 ELSE 0 END) AS endpoint_minutes_mtd,
    SUM(CASE WHEN x.serving_date >= m.month_start THEN x.cost_usd ELSE 0 END) AS cost_mtd_usd,
    SUM(CASE WHEN x.serving_date >= m.month_start THEN x.error_requests ELSE 0 END) AS error_requests_mtd,
    SUM(CASE WHEN x.serving_date > date_sub(m.latest_day, CAST(r.outlook_run_rate_days AS INT)) THEN x.downtime_minutes ELSE 0 END)
      / MAX(r.outlook_run_rate_days) AS recent_daily_downtime_minutes
  FROM {{catalog}}.{{prefix}}_silver.ops_serving_daily x CROSS JOIN m CROSS JOIN r
), p AS (
  SELECT COUNT(*) AS promotions_in_flight,
    SUM(CASE WHEN status = 'on_track' THEN 1 ELSE 0 END) AS promotions_on_track,
    SUM(CASE WHEN status = 'at_risk' THEN 1 ELSE 0 END) AS promotions_at_risk,
    SUM(CASE WHEN status = 'blocked' THEN 1 ELSE 0 END) AS promotions_blocked
  FROM {{catalog}}.{{prefix}}_silver.ops_promotion
), o AS (
  SELECT COUNT(*) AS models_in_production,
    AVG(health_score) AS fleet_health_score,
    SUM(high_risk_flag) AS high_risk_models,
    SUM(CASE WHEN tier_order = 2 THEN 1 ELSE 0 END) AS degrading_models,
    SUM(CASE WHEN tier_order = 1 THEN 1 ELSE 0 END) AS breaching_slo_models,
    SUM(CASE WHEN serving_mode = 'real_time' THEN 1 ELSE 0 END) AS real_time_models,
    SUM(latency_breach_flag) AS latency_breach_models,
    SUM(latency_breach_week_flag) AS latency_breach_week_models,
    SUM(monthly_cost_usd) AS monthly_cost_usd
  FROM {{catalog}}.{{prefix}}_gold.qry_model_ops
), b AS (
  SELECT m.*, s.*, p.*, o.*, r.sla_uptime_target,
    (1 - r.sla_uptime_target) * s.endpoints * 1440 * m.days_in_month AS error_budget_minutes
  FROM m CROSS JOIN s CROSS JOIN p CROSS JOIN o CROSS JOIN r
)
SELECT b.month_start, b.latest_day, b.days_elapsed, b.days_in_month, b.days_left, b.endpoints,
  b.sla_uptime_target,
  1 - b.downtime_mtd_minutes / NULLIF(b.endpoint_minutes_mtd, 0) AS uptime_mtd,
  b.downtime_mtd_minutes,
  b.requests_mtd, b.forecast_requests_mtd,
  1.0 * b.requests_mtd / NULLIF(b.forecast_requests_mtd, 0) AS requests_vs_forecast,
  b.error_budget_minutes,
  1 - b.downtime_mtd_minutes / NULLIF(b.error_budget_minutes, 0) AS error_budget_remaining_share,
  (b.downtime_mtd_minutes / NULLIF(b.error_budget_minutes, 0)) / (1.0 * b.days_elapsed / b.days_in_month) AS error_budget_burn_rate,
  b.recent_daily_downtime_minutes,
  (b.error_budget_minutes - b.downtime_mtd_minutes) / NULLIF(b.days_left, 0) AS allowed_daily_downtime_minutes,
  1 - (b.downtime_mtd_minutes + b.recent_daily_downtime_minutes * b.days_left) / (b.endpoints * 1440.0 * b.days_in_month) AS projected_uptime,
  CASE WHEN b.error_budget_minutes - b.downtime_mtd_minutes <= 0 THEN 'Unlikely'
       WHEN b.recent_daily_downtime_minutes <= r.outlook_headroom * (b.error_budget_minutes - b.downtime_mtd_minutes) / NULLIF(b.days_left, 0) THEN 'Likely'
       WHEN b.recent_daily_downtime_minutes <= (b.error_budget_minutes - b.downtime_mtd_minutes) / NULLIF(b.days_left, 0) THEN 'Possible'
       ELSE 'Unlikely' END AS outlook_likelihood,
  b.promotions_in_flight, b.promotions_on_track, b.promotions_at_risk, b.promotions_blocked,
  b.real_time_models, b.latency_breach_models, b.latency_breach_week_models,
  1.0 * b.latency_breach_models / NULLIF(b.real_time_models, 0) AS latency_breach_share,
  1.0 * b.latency_breach_week_models / NULLIF(b.real_time_models, 0) AS latency_breach_week_share,
  b.models_in_production, b.fleet_health_score, b.high_risk_models, b.degrading_models, b.breaching_slo_models,
  b.cost_mtd_usd, b.monthly_cost_usd,
  1000.0 * b.cost_mtd_usd / NULLIF(b.requests_mtd, 0) AS cost_per_1k_inferences_usd,
  1.0 * b.error_requests_mtd / NULLIF(b.requests_mtd, 0) AS request_error_rate
FROM b CROSS JOIN r;
COMMENT ON TABLE {{catalog}}.{{prefix}}_gold.qry_cc_ops_month IS 'Answers: "Are we on track this month?", "Are we meeting the SLA?", "How much error budget is left?", "Will we hit 99.9% this month?", "What does serving cost per 1,000 inferences?", "What is the fleet health score?" One row, month to date (1st of the as-of month to the latest day). SYNTHETIC DEMO DATA (silver.ops_*). uptime_mtd vs sla_uptime_target; error budget = downtime the target allows for the whole month; burn rate 1.0 = on pace to use exactly the budget; projected_uptime assumes the last outlook_run_rate_days days'' downtime continues and is a projection, not a forecast of record; outlook_likelihood compares that run rate with what the remaining budget allows per day.';
COMMENT ON COLUMN {{catalog}}.{{prefix}}_gold.qry_cc_ops_month.uptime_mtd IS 'Share of endpoint-minutes available this month so far (SLA % met)';
COMMENT ON COLUMN {{catalog}}.{{prefix}}_gold.qry_cc_ops_month.error_budget_remaining_share IS 'Share of the month''s downtime budget not yet used';
COMMENT ON COLUMN {{catalog}}.{{prefix}}_gold.qry_cc_ops_month.error_budget_burn_rate IS 'Budget used / month elapsed: above 1 means burning faster than the month allows';
COMMENT ON COLUMN {{catalog}}.{{prefix}}_gold.qry_cc_ops_month.projected_uptime IS 'Month-end uptime if the recent daily downtime continues (a projection)';
COMMENT ON COLUMN {{catalog}}.{{prefix}}_gold.qry_cc_ops_month.outlook_likelihood IS 'Likely, Possible or Unlikely to meet the SLA by month end (outlook_headroom rule)';
COMMENT ON COLUMN {{catalog}}.{{prefix}}_gold.qry_cc_ops_month.latency_breach_share IS 'Share of real-time models over the latency SLO on the latest day';
COMMENT ON COLUMN {{catalog}}.{{prefix}}_gold.qry_cc_ops_month.cost_per_1k_inferences_usd IS 'Serving cost month to date per 1,000 requests, US dollars';

-- 3. Fleet tiers: one row per tier, all five always present.
CREATE OR REPLACE VIEW {{catalog}}.{{prefix}}_gold.qry_cc_tiers AS
WITH tiers AS (
  SELECT * FROM VALUES (1, 'Breaching SLO'), (2, 'Degrading'), (3, 'Stale'), (4, 'Watch'), (5, 'Healthy') AS t(tier_order, fleet_tier)
), m AS (SELECT * FROM {{catalog}}.{{prefix}}_gold.qry_model_ops)
SELECT tiers.tier_order, tiers.fleet_tier,
  COUNT(m.model_id) AS models,
  1.0 * COUNT(m.model_id) / (SELECT COUNT(*) FROM m) AS model_share,
  COALESCE(SUM(m.monthly_cost_usd), 0) AS monthly_cost_usd,
  COALESCE(SUM(m.value_at_stake_usd_month), 0) AS value_at_stake_usd_month,
  AVG(m.error_change) AS avg_error_change,
  SUM(CASE WHEN m.criticality = 'High' THEN 1 ELSE 0 END) AS high_criticality_models
FROM tiers LEFT JOIN m ON m.tier_order = tiers.tier_order
GROUP BY tiers.tier_order, tiers.fleet_tier;
COMMENT ON TABLE {{catalog}}.{{prefix}}_gold.qry_cc_tiers IS 'Answers: "How is the fleet distributed across health tiers?", "How much do degrading models cost?" One row per fleet tier (Breaching SLO, Degrading, Stale, Watch, Healthy): models, share, monthly serving cost, value at stake and average error change. Built on qry_model_ops (cost and value are synthetic). avg_error_change is relative: +0.05 means error up 5% (accuracy down).';

-- 4. Top issues, ranked: severity, headline, evidence and the recorded cause.
CREATE OR REPLACE VIEW {{catalog}}.{{prefix}}_gold.qry_cc_issues AS
WITH r AS (SELECT * FROM {{catalog}}.{{prefix}}_gold.qry_rules),
m AS (SELECT * FROM {{catalog}}.{{prefix}}_gold.qry_model_ops),
flagged AS (
  SELECT 'data_drift' AS issue_key, 'feature_drift' AS issue_type, model_id FROM m WHERE data_drift_flag = 1
  UNION ALL SELECT 'latency', 'latency', model_id FROM m WHERE latency_breach_week_flag = 1
  UNION ALL SELECT 'accuracy', 'accuracy', model_id FROM m WHERE accuracy_drop_flag = 1
  UNION ALL SELECT 'retrain_backlog', 'retrain_backlog', model_id FROM m WHERE retrain_overdue_flag = 1
  UNION ALL SELECT 'governance', 'governance', model_id FROM m WHERE governance_gap_flag = 1
  UNION ALL SELECT 'stale', 'stale', model_id FROM m WHERE stale_flag = 1
), agg AS (
  SELECT f.issue_key, COUNT(*) AS models,
    SUM(CASE WHEN m.criticality = 'High' THEN 1 ELSE 0 END) AS high_criticality_models,
    SUM(m.value_at_stake_usd_month) AS value_at_stake_usd_month,
    MAX(m.max_feature_psi) AS max_feature_psi,
    MAX(m.latest_p95_latency_ms) AS worst_latest_p95_ms,
    MAX(m.week_max_p95_latency_ms) AS worst_week_p95_ms,
    SUM(m.latency_breach_flag) AS still_breaching,
    MAX(m.error_change) AS max_error_change,
    MAX_BY(m.model_id, m.error_change) AS worst_error_model,
    MAX(m.days_since_trained - m.retrain_cadence_days) AS max_days_overdue,
    MIN(m.review_deadline) AS review_deadline,
    MAX(m.days_since_trained) AS max_days_since_trained
  FROM flagged f JOIN m ON m.model_id = f.model_id
  GROUP BY f.issue_key
), cause AS (
  SELECT f.issue_key,
    COUNT(DISTINCT em.model_id) AS models_with_recorded_cause,
    array_join(array_sort(collect_set(concat(date_format(e.event_time, 'd MMM'), ', ', e.source, ': ', e.description))), ' ') AS recorded_cause
  FROM flagged f
  JOIN {{catalog}}.{{prefix}}_silver.ops_event_model em ON em.model_id = f.model_id AND em.issue_type = f.issue_type
  JOIN {{catalog}}.{{prefix}}_silver.ops_pipeline_event e ON e.event_id = em.event_id
  GROUP BY f.issue_key
), rows AS (
  SELECT agg.*, cause.recorded_cause, COALESCE(cause.models_with_recorded_cause, 0) AS models_with_recorded_cause,
    CASE agg.issue_key
      WHEN 'data_drift' THEN format_string('%d models have data drift on %d or more input features', agg.models, CAST(r.psi_drift_feature_count AS INT))
      WHEN 'latency' THEN format_string('%d real-time endpoints breached the %d ms latency SLO this week', agg.models, CAST(r.latency_slo_ms AS INT))
      WHEN 'accuracy' THEN format_string('Accuracy is falling on %d models (concept drift)', agg.models)
      WHEN 'retrain_backlog' THEN format_string('%d models are more than %d days overdue for retraining', agg.models, CAST(r.retrain_overdue_days AS INT))
      WHEN 'governance' THEN format_string('%d models have governance gaps', agg.models)
      WHEN 'stale' THEN format_string('%d models have not been retrained in over %d days', agg.models, CAST(r.stale_model_days AS INT))
    END AS headline,
    CASE agg.issue_key
      WHEN 'data_drift' THEN format_string('PSI up to %.2f against a %.2f threshold; %d of them business-critical', agg.max_feature_psi, r.psi_drift_threshold, agg.high_criticality_models)
      WHEN 'latency' THEN format_string('%d still over the SLO on the latest day; worst p95 %.0f ms this week', agg.still_breaching, agg.worst_week_p95_ms)
      WHEN 'accuracy' THEN format_string('Error up %.0f%% or more over the window; worst %s at +%.0f%%', r.accuracy_drop_watch * 100, agg.worst_error_model, agg.max_error_change * 100)
      WHEN 'retrain_backlog' THEN format_string('Up to %d days past the planned cadence; %d business-critical', agg.max_days_overdue, agg.high_criticality_models)
      WHEN 'governance' THEN format_string('Model card older than %d days or bias audit overdue; review deadline %s', CAST(r.model_card_max_age_days AS INT), date_format(agg.review_deadline, 'd MMM yyyy'))
      WHEN 'stale' THEN format_string('Oldest trained %d days ago', agg.max_days_since_trained)
    END AS evidence,
    CASE agg.issue_key WHEN 'data_drift' THEN 'ops_data_drift' WHEN 'latency' THEN 'ops_latency_week'
      WHEN 'accuracy' THEN 'ops_accuracy_drop' WHEN 'retrain_backlog' THEN 'ops_retrain_overdue'
      WHEN 'governance' THEN 'ops_governance_gap' WHEN 'stale' THEN 'ops_stale' END AS list_key,
    CASE agg.issue_key WHEN 'data_drift' THEN 'Which models have data drift, on which features, and what is the recorded cause?'
      WHEN 'latency' THEN 'Which real-time endpoints breached the latency SLO this week, and why?'
      WHEN 'accuracy' THEN 'Which models are losing accuracy, and by how much?'
      WHEN 'retrain_backlog' THEN 'Which models are overdue for retraining, and what is blocking them?'
      WHEN 'governance' THEN 'Which models have governance gaps, and when is the review deadline?'
      WHEN 'stale' THEN 'Which models have not been retrained in over 90 days?' END AS ask_question,
    CASE WHEN agg.issue_key IN ('data_drift', 'latency', 'accuracy') AND agg.high_criticality_models > 0 THEN 'Critical'
         WHEN agg.issue_key IN ('data_drift', 'latency', 'accuracy') OR agg.high_criticality_models > 0 THEN 'High'
         ELSE 'Medium' END AS severity,
    CASE WHEN agg.issue_key IN ('data_drift', 'latency', 'accuracy') THEN 1 ELSE 2 END AS issue_class_order
  FROM agg LEFT JOIN cause ON cause.issue_key = agg.issue_key CROSS JOIN r
)
SELECT ROW_NUMBER() OVER (ORDER BY CASE severity WHEN 'Critical' THEN 1 WHEN 'High' THEN 2 ELSE 3 END, issue_class_order, value_at_stake_usd_month DESC) AS issue_rank,
  issue_key, severity, headline, evidence,
  COALESCE(recorded_cause, 'No recorded cause') AS recorded_cause, models_with_recorded_cause,
  models, high_criticality_models, value_at_stake_usd_month, list_key, ask_question
FROM rows;
COMMENT ON TABLE {{catalog}}.{{prefix}}_gold.qry_cc_issues IS 'Answers: "What are the top issues?", "What is hurting us?", "Why are models degrading?" One row per issue type with models affected, ranked by severity (Critical when a performance issue hits a High-criticality model), then performance issues before hygiene issues, then value at stake: data drift (PSI), latency SLO, accuracy loss (concept drift, from the source data), retraining backlog, governance gaps, stale models. recorded_cause quotes recorded pipeline events (synthetic) linked to the affected models, and models_with_recorded_cause says how many of them it covers; "No recorded cause" means none is recorded, so never infer one.';

-- 5. Prioritised actions with horizons.
CREATE OR REPLACE VIEW {{catalog}}.{{prefix}}_gold.qry_cc_ops_actions AS
WITH m AS (SELECT * FROM {{catalog}}.{{prefix}}_gold.qry_model_ops),
a AS (
  SELECT 'TODAY' AS horizon, 1 AS horizon_order, 1 AS action_order, 'Roll back to the previous version' AS action,
    'Error rose past the rollback threshold' AS reason, 'ops_rollback' AS list_key,
    COUNT(*) AS models, SUM(value_at_stake_usd_month) AS value_at_stake_usd_month FROM m WHERE rollback_flag = 1
  UNION ALL SELECT 'TODAY', 1, 2, 'Restore capacity on endpoints over the latency SLO',
    'Real-time endpoints still over the SLO on the latest day', 'ops_latency',
    COUNT(*), SUM(value_at_stake_usd_month) FROM m WHERE latency_breach_flag = 1
  UNION ALL SELECT 'THIS WEEK', 2, 3, 'Retrain models with data drift once their input feed is corrected',
    'Data drift on several input features', 'ops_data_drift',
    COUNT(*), SUM(value_at_stake_usd_month) FROM m WHERE data_drift_flag = 1
  UNION ALL SELECT 'THIS WEEK', 2, 4, 'Retrain models whose accuracy is falling',
    'Error rising, below the rollback threshold, no data drift', 'ops_accuracy_watch',
    COUNT(*), SUM(value_at_stake_usd_month) FROM m WHERE accuracy_drop_flag = 1 AND rollback_flag = 0 AND data_drift_flag = 0
  UNION ALL SELECT 'THIS WEEK', 2, 5, 'Clear the retraining backlog',
    'Past the planned retraining cadence', 'ops_retrain_overdue',
    COUNT(*), SUM(value_at_stake_usd_month) FROM m WHERE retrain_overdue_flag = 1
  UNION ALL SELECT 'THIS WEEK', 2, 6, 'Investigate low confidence',
    'Low confidence, not drifting (action queue 2)', 'queue_confidence',
    COUNT(*), SUM(value_at_stake_usd_month) FROM m WHERE action_order = 2
  UNION ALL SELECT 'THIS MONTH', 3, 7, 'Retire or retrain stale models',
    'Trained more than the stale threshold ago', 'ops_stale',
    COUNT(*), SUM(value_at_stake_usd_month) FROM m WHERE stale_flag = 1
  UNION ALL SELECT 'THIS MONTH', 3, 8, 'Right-size under-used GPU endpoints',
    'GPU utilisation under the threshold over the last 7 days', 'ops_low_utilization',
    COUNT(*), SUM(value_at_stake_usd_month) FROM m WHERE low_utilization_flag = 1
  UNION ALL SELECT 'THIS MONTH', 3, 9, 'Close governance gaps before the review deadline',
    'Model card out of date or bias audit overdue', 'ops_governance_gap',
    COUNT(*), SUM(value_at_stake_usd_month) FROM m WHERE governance_gap_flag = 1
)
SELECT * FROM a WHERE models > 0;
COMMENT ON TABLE {{catalog}}.{{prefix}}_gold.qry_cc_ops_actions IS 'Answers: "What should we do today / this week / this month?" Prioritised actions with horizons: TODAY (roll back, restore latency), THIS WEEK (retrain drifting or degrading models, clear the retraining backlog, investigate low confidence), THIS MONTH (stale models, right-size GPUs, governance). One row per action with models and value at stake; a model can appear in more than one action. Built on qry_model_ops (synthetic operations data plus the source data''s accuracy and health).';

-- 6. Upside: potential monthly saving by lever and model family.
CREATE OR REPLACE VIEW {{catalog}}.{{prefix}}_gold.qry_cc_upside AS
SELECT lever_kind, optimisation_lever, model_type,
  COUNT(*) AS models,
  SUM(potential_saving_usd_month) AS potential_saving_usd_month,
  SUM(top_target_flag) AS top_target_models
FROM {{catalog}}.{{prefix}}_gold.qry_model_ops
WHERE optimisation_lever IS NOT NULL
GROUP BY lever_kind, optimisation_lever, model_type;
COMMENT ON TABLE {{catalog}}.{{prefix}}_gold.qry_cc_upside IS 'Answers: "Where is the extra upside?", "How much could we save by lever or model family?" One row per lever and model type (model family: Time-Series, Hybrid, First-Principle): models and estimated monthly upside. Value recovery (Fix latency, Retrain) = value at stake x degraded_value_loss_share; cost saving (Decommission, Right-size GPU) = serving cost saved. Estimates on synthetic data with stated assumptions (gold.business_rules_config). Sum over model_type for a lever total; the top targets are qry_model_ops WHERE top_target_flag = 1 ORDER BY optimisation_rank.';

-- 7. Feature drift per model input, with the threshold applied.
CREATE OR REPLACE VIEW {{catalog}}.{{prefix}}_gold.qry_feature_drift_status AS
SELECT d.model_id, m.model_name, m.business_unit, m.site_name, m.asset_type, m.criticality,
  d.feature_name, d.feature_source, d.psi_month_start, d.psi_latest,
  d.psi_latest - d.psi_month_start AS psi_change,
  CASE WHEN d.psi_latest > r.psi_drift_threshold THEN 1 ELSE 0 END AS drifted_flag
FROM {{catalog}}.{{prefix}}_silver.ops_feature_drift d
JOIN {{catalog}}.{{prefix}}_silver.dim_model m ON m.model_id = d.model_id
CROSS JOIN {{catalog}}.{{prefix}}_gold.qry_rules r;
COMMENT ON TABLE {{catalog}}.{{prefix}}_gold.qry_feature_drift_status IS 'Answers: "Which input features are drifting?", "Which feeds do the drifting features come from?" One row per model and input feature: population stability index (PSI) at month start and on the latest day, and drifted_flag (PSI over psi_drift_threshold). SYNTHETIC DEMO DATA, consistent with the source data''s 4 drifting models.';

-- 8. Daily serving per model.
CREATE OR REPLACE VIEW {{catalog}}.{{prefix}}_gold.qry_serving_daily AS
SELECT s.serving_date, s.model_id, m.model_name, m.business_unit, m.site_name, m.criticality, e.serving_mode, e.compute_type,
  s.requests, s.forecast_requests, s.downtime_minutes, 1 - s.downtime_minutes / 1440.0 AS uptime,
  s.p95_latency_ms,
  CASE WHEN e.serving_mode = 'real_time' AND s.p95_latency_ms > r.latency_slo_ms THEN 1 ELSE 0 END AS latency_breach_flag,
  s.error_requests, s.cost_usd, s.utilization_pct
FROM {{catalog}}.{{prefix}}_silver.ops_serving_daily s
JOIN {{catalog}}.{{prefix}}_silver.dim_model m ON m.model_id = s.model_id
JOIN {{catalog}}.{{prefix}}_silver.ops_model_endpoint e ON e.model_id = s.model_id
CROSS JOIN {{catalog}}.{{prefix}}_gold.qry_rules r;
COMMENT ON TABLE {{catalog}}.{{prefix}}_gold.qry_serving_daily IS 'Answers: "How did uptime / latency / cost / traffic trend day by day?", "When did latency breach start?" One row per model per day, 8 Sep - 7 Oct 2026: requests vs forecast, downtime and uptime, p95 latency with the SLO flag (real-time only), errors, cost and utilisation. SYNTHETIC DEMO DATA. For fleet uptime divide summed downtime by (models x 1440) per day; never average uptime across rows of different days and models without weighting.';

-- 9. Recorded pipeline and platform events, with the models each affected.
CREATE OR REPLACE VIEW {{catalog}}.{{prefix}}_gold.qry_pipeline_events AS
SELECT e.event_id, e.event_time, e.source, e.event_type, e.description,
  em.issue_type, COUNT(em.model_id) AS models_affected,
  array_join(array_sort(collect_list(em.model_id)), ', ') AS model_ids
FROM {{catalog}}.{{prefix}}_silver.ops_pipeline_event e
LEFT JOIN {{catalog}}.{{prefix}}_silver.ops_event_model em ON em.event_id = e.event_id
GROUP BY e.event_id, e.event_time, e.source, e.event_type, e.description, em.issue_type;
COMMENT ON TABLE {{catalog}}.{{prefix}}_gold.qry_pipeline_events IS 'Answers: "What caused it?", "What changed in the pipelines?", "Was there a recorded cause?" One row per recorded event and issue type: when, which system, what happened and the models it affected. SYNTHETIC DEMO DATA. These are the only recorded causes: quote them, and when an issue has no event here say no cause is recorded rather than guessing.';
