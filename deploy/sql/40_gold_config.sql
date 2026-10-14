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
 'Alerting needs tuning when more than 25% (1 in 4) of a model''s alerts were false positives. The fleet-wide rate is about 26%. 4 of the 5 models with alerts are above it; 3 are in the tune-alert queue, because a drifting model goes to the drift queue first. Used by qry_model_health (high_false_positive_flag, action_order 3).');

-- One row with every threshold as a column, for views to CROSS JOIN or read with {{live:<name>}}.
CREATE OR REPLACE VIEW {{catalog}}.{{prefix}}_gold.qry_rules AS
SELECT
  MAX(CASE WHEN rule_name = 'low_confidence_score' THEN threshold_value END)          AS low_confidence_score,
  MAX(CASE WHEN rule_name = 'low_confidence_model_share' THEN threshold_value END)    AS low_confidence_model_share,
  MAX(CASE WHEN rule_name = 'drift_alert_threshold' THEN threshold_value END)         AS drift_alert_threshold,
  MAX(CASE WHEN rule_name = 'false_positive_rate_threshold' THEN threshold_value END) AS false_positive_rate_threshold
FROM {{catalog}}.{{prefix}}_gold.business_rules_config;
COMMENT ON TABLE {{catalog}}.{{prefix}}_gold.qry_rules IS 'Every business threshold as one row (one column per rule), read by the gold views. Values come from gold.business_rules_config, which explains each one; query that table, not this one, to explain a rule.';
