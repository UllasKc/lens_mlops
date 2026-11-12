-- Business thresholds as data, not hardcoded logic. Every certified and Command Center view reads
-- them through gold.qry_rules, and the deploy writes them into the metric views ({{rule:<name>}}),
-- so changing a value here and re-running the deploy's transform and views steps moves every figure.
-- Each note says what the rule means, why the value, how it measures on the source data, and which
-- views use it.
CREATE OR REPLACE TABLE {{catalog}}.{{prefix}}_gold.business_rules_config (
  rule_name STRING COMMENT 'Name used by gold.qry_rules and the views',
  threshold_value DOUBLE COMMENT 'The value in force',
  notes STRING COMMENT 'What the rule means, why this value, how it measures on the data and which views use it'
) COMMENT 'Every business threshold the gold views use, with its meaning, the reason for its value and the views that use it. Views read these values through gold.qry_rules; quote this table when asked how a figure is defined (for example what counts as a drifting or low-confidence model).';

INSERT INTO {{catalog}}.{{prefix}}_gold.business_rules_config VALUES
('low_confidence_score', 0.60,
 'A prediction is low-confidence when confidence_score < 0.60. Source: the source data''s demo questions ("confidence below 60%"). About 4.8% of predictions fall below it. Used by qry_model_health, qry_hourly_model_signals, qry_latest_readings (low_confidence_flag), qry_daily_fleet_trend, qry_explorer_base and the metric view measures low_confidence_predictions and low_confidence_share.'),
('low_confidence_model_share', 0.20,
 'A model is flagged low-confidence when at least 20% (1 in 5) of its predictions on the latest day are low-confidence. Calibrated on the data: an average-confidence cut of 0.60 flags only 1 of 100 models; this share flags 12 (lowest 21.2%), and the next model is at 19.3%, so a small move in the value changes the count. Used by qry_model_health (low_confidence_flag) and everything built on it.'),
('drift_alert_threshold', 0.30,
 'A model is drifting when its average drift_score on the latest day is >= 0.30. Calibrated on the data: the 4 drifting models average 0.51 on the latest day (0.14 on the first) against a fleet baseline near 0.10, and no other model exceeds 0.11. Used by qry_model_health (drifting_flag) and qry_daily_fleet_trend (drifting_models per day: 0, 4, 4).'),
('false_positive_rate_threshold', 0.25,
 'Alerting needs tuning when more than 25% (1 in 4) of a model''s alerts were false positives. The fleet-wide rate is about 26%. 4 of the 5 models with alerts are above it; 3 are in the tune-alert queue, because a drifting model goes to the drift queue first. Used by qry_model_health (high_false_positive_flag, action_order 3).'),
-- Operations rules (Command Center). They apply to the synthetic serving, drift, retraining and
-- governance tables (silver.ops_*), so their counts describe demo data.
('sla_uptime_target', 0.999,
 'Serving SLA: endpoints should be available 99.9% of the minutes in a month (about 43 minutes of downtime per endpoint a month). The error budget is the downtime this allows. Used by qry_cc_ops_month (uptime vs target, error budget, burn rate, month-end outlook).'),
('latency_slo_ms', 200,
 'Latency SLO for real-time endpoints: p95 response time at or under 200 ms. Batch endpoints have no latency SLO. Used by qry_model_ops (latency_breach_flag on the latest day, latency_breach_week_flag over the last 7 days; Breaching SLO tier) and qry_cc_ops_month.'),
('psi_drift_threshold', 0.25,
 'An input feature has drifted significantly when its population stability index (PSI) on the latest day is over 0.25, the industry convention (under 0.10 stable, 0.10-0.25 moderate). Used by qry_model_ops (drifted_features) and qry_feature_drift_status.'),
('psi_drift_feature_count', 3,
 'A model has data drift when at least 3 of its input features are over psi_drift_threshold; 1-2 features put it on Watch. Matches the source data: the 4 models drifting there have 3-4 features over the threshold. Used by qry_model_ops (data_drift_flag, feature_watch_flag).'),
('accuracy_drop_watch', 0.05,
 'A model is degrading when its error (weighted absolute percentage error) on the latest day is at least 5% higher, relative, than on the first day of the window. Measured on the source data: 4 models (MDL_067 +14%, MDL_035 +7%, MDL_007 +6%, MDL_029 +5%). Used by qry_model_ops (accuracy_drop_flag, Degrading tier).'),
('accuracy_drop_rollback', 0.10,
 'Roll back to the previous version when the error rose at least 10% (relative) over the window. Measured on the source data: 1 model (MDL_067, +14%). Used by qry_model_ops (rollback_flag) and qry_cc_ops_actions (TODAY).'),
('stale_model_days', 90,
 'A model is stale when its live version was trained more than 90 days ago. Used by qry_model_ops (stale_flag, Stale tier).'),
('retrain_overdue_days', 14,
 'Retraining is overdue when a model is more than 14 days past its planned cadence (and not yet stale). Used by qry_model_ops (retrain_overdue_flag, Watch tier) and qry_cc_issues (retrain backlog).'),
('model_card_max_age_days', 180,
 'A model card older than 180 days is a governance gap, as is a bias audit past its due date. Used by qry_model_ops (governance_gap_flag).'),
('gpu_low_utilization_pct', 25,
 'A GPU endpoint averaging under 25% utilisation over the last 7 days is a right-sizing candidate. Used by qry_model_ops (low_utilization_flag, lever Right-size GPU).'),
('idle_requests_per_day', 1000,
 'An endpoint averaging under 1,000 requests a day over the last 7 days is barely used; if it is also stale it is a decommission candidate. Used by qry_model_ops (idle_flag, lever Decommission).'),
('rightsize_saving_share', 0.5,
 'Right-sizing an under-used GPU endpoint is assumed to save half its monthly serving cost. An assumption for the upside estimate. Used by qry_model_ops (potential_saving_usd_month).'),
('degraded_value_loss_share', 0.25,
 'A degrading or SLO-breaching model is assumed to put a quarter of its monthly value at stake at risk; fixing it recovers that. An assumption for the upside estimate. Used by qry_model_ops (potential_saving_usd_month).'),
('outlook_run_rate_days', 3,
 'The month-end outlook projects the remaining days at the downtime run rate of the last 3 days. Used by qry_cc_ops_month (projected_uptime).'),
('outlook_headroom', 0.8,
 'Month-end outlook: Likely when the recent daily downtime is at most 80% of what the remaining error budget allows per day, Possible up to 100%, Unlikely above. Used by qry_cc_ops_month (outlook_likelihood).'),
('top_optimisation_targets', 10,
 'How many models the Command Center lists as top optimisation targets (largest potential saving first). Used by qry_model_ops (optimisation_rank) and qry_cc_upside.'),
('health_penalty_breaching', 60,
 'Fleet health score: each model starts at 100 and loses 60 points in the Breaching SLO tier, 40 Degrading, 25 Stale, 10 Watch; the fleet score is the average. Used by qry_model_ops (health_score) and qry_cc_ops_month (fleet_health_score).'),
('health_penalty_degrading', 40, 'Fleet health score penalty for the Degrading tier (see health_penalty_breaching).'),
('health_penalty_stale', 25, 'Fleet health score penalty for the Stale tier (see health_penalty_breaching).'),
('health_penalty_watch', 10, 'Fleet health score penalty for the Watch tier (see health_penalty_breaching).');

-- One row with every threshold as a column, for views to CROSS JOIN or read with {{live:<name>}}.
CREATE OR REPLACE VIEW {{catalog}}.{{prefix}}_gold.qry_rules AS
SELECT
  MAX(CASE WHEN rule_name = 'low_confidence_score' THEN threshold_value END)          AS low_confidence_score,
  MAX(CASE WHEN rule_name = 'low_confidence_model_share' THEN threshold_value END)    AS low_confidence_model_share,
  MAX(CASE WHEN rule_name = 'drift_alert_threshold' THEN threshold_value END)         AS drift_alert_threshold,
  MAX(CASE WHEN rule_name = 'false_positive_rate_threshold' THEN threshold_value END) AS false_positive_rate_threshold,
  MAX(CASE WHEN rule_name = 'sla_uptime_target' THEN threshold_value END) AS sla_uptime_target,
  MAX(CASE WHEN rule_name = 'latency_slo_ms' THEN threshold_value END) AS latency_slo_ms,
  MAX(CASE WHEN rule_name = 'psi_drift_threshold' THEN threshold_value END) AS psi_drift_threshold,
  MAX(CASE WHEN rule_name = 'psi_drift_feature_count' THEN threshold_value END) AS psi_drift_feature_count,
  MAX(CASE WHEN rule_name = 'accuracy_drop_watch' THEN threshold_value END) AS accuracy_drop_watch,
  MAX(CASE WHEN rule_name = 'accuracy_drop_rollback' THEN threshold_value END) AS accuracy_drop_rollback,
  MAX(CASE WHEN rule_name = 'stale_model_days' THEN threshold_value END) AS stale_model_days,
  MAX(CASE WHEN rule_name = 'retrain_overdue_days' THEN threshold_value END) AS retrain_overdue_days,
  MAX(CASE WHEN rule_name = 'model_card_max_age_days' THEN threshold_value END) AS model_card_max_age_days,
  MAX(CASE WHEN rule_name = 'gpu_low_utilization_pct' THEN threshold_value END) AS gpu_low_utilization_pct,
  MAX(CASE WHEN rule_name = 'idle_requests_per_day' THEN threshold_value END) AS idle_requests_per_day,
  MAX(CASE WHEN rule_name = 'rightsize_saving_share' THEN threshold_value END) AS rightsize_saving_share,
  MAX(CASE WHEN rule_name = 'degraded_value_loss_share' THEN threshold_value END) AS degraded_value_loss_share,
  MAX(CASE WHEN rule_name = 'outlook_run_rate_days' THEN threshold_value END) AS outlook_run_rate_days,
  MAX(CASE WHEN rule_name = 'outlook_headroom' THEN threshold_value END) AS outlook_headroom,
  MAX(CASE WHEN rule_name = 'top_optimisation_targets' THEN threshold_value END) AS top_optimisation_targets,
  MAX(CASE WHEN rule_name = 'health_penalty_breaching' THEN threshold_value END) AS health_penalty_breaching,
  MAX(CASE WHEN rule_name = 'health_penalty_degrading' THEN threshold_value END) AS health_penalty_degrading,
  MAX(CASE WHEN rule_name = 'health_penalty_stale' THEN threshold_value END) AS health_penalty_stale,
  MAX(CASE WHEN rule_name = 'health_penalty_watch' THEN threshold_value END) AS health_penalty_watch
FROM {{catalog}}.{{prefix}}_gold.business_rules_config;
COMMENT ON TABLE {{catalog}}.{{prefix}}_gold.qry_rules IS 'Every business threshold as one row (one column per rule), read by the gold views. Values come from gold.business_rules_config, which explains each one; query that table, not this one, to explain a rule.';
