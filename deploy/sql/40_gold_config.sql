-- Business thresholds as data, not hardcoded logic. The certified and Command Center views read
-- them from here (gold.qry_rules), so changing a row and re-running the views step moves every figure.
CREATE OR REPLACE TABLE {{catalog}}.{{prefix}}_gold.business_rules_config (
  rule_name STRING, threshold_value DOUBLE, notes STRING
) COMMENT 'Thresholds behind model health, alerts and actions, with the reason for each value';

INSERT INTO {{catalog}}.{{prefix}}_gold.business_rules_config VALUES
('low_confidence_score', 0.60,
 'A prediction is low-confidence when confidence_score < 0.60. Source: the source data''s demo questions ("confidence below 60%").'),
('low_confidence_model_share', 0.20,
 'A model is flagged low-confidence when at least 20% (1 in 5) of its predictions on the latest day are low-confidence. Calibrated on the data: an average-confidence cut of 0.60 flags only 1 of 100 models; this share flags 12, with a clear drop below (next model 19%).'),
('drift_alert_threshold', 0.30,
 'A model is drifting when its average drift_score on the latest day is >= 0.30. Calibrated on the data: drifting models average about 0.51 on the latest day against a fleet baseline near 0.10; nothing else exceeds 0.11.'),
('false_positive_rate_threshold', 0.25,
 'Alerting needs tuning when more than 25% (1 in 4) of a model''s alerts were false positives. The fleet-wide rate is about 26%.');

-- One row with every threshold as a column, for views to CROSS JOIN.
CREATE OR REPLACE VIEW {{catalog}}.{{prefix}}_gold.qry_rules AS
SELECT
  MAX(CASE WHEN rule_name = 'low_confidence_score' THEN threshold_value END)          AS low_confidence_score,
  MAX(CASE WHEN rule_name = 'low_confidence_model_share' THEN threshold_value END)    AS low_confidence_model_share,
  MAX(CASE WHEN rule_name = 'drift_alert_threshold' THEN threshold_value END)         AS drift_alert_threshold,
  MAX(CASE WHEN rule_name = 'false_positive_rate_threshold' THEN threshold_value END) AS false_positive_rate_threshold
FROM {{catalog}}.{{prefix}}_gold.business_rules_config;
