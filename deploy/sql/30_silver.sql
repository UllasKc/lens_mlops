-- Silver: typed, constrained, canonical. One table per source file, explicit casts (no SELECT *).

-- One row per model (model_registry.csv).
CREATE OR REPLACE TABLE {{catalog}}.{{prefix}}_silver.dim_model (
  model_id STRING NOT NULL COMMENT 'Model identifier, e.g. MDL_061',
  model_name STRING COMMENT 'Readable model name, e.g. Reactor Yield Forecaster #61',
  model_type STRING COMMENT 'Modelling approach: Time-Series, First-Principle or Hybrid',
  business_unit STRING COMMENT 'Owning business unit',
  site_id STRING COMMENT 'Site code, e.g. SITE_HOU_01',
  site_name STRING COMMENT 'Site in plain words, e.g. Houston 1',
  asset_type STRING COMMENT 'Equipment class the model watches',
  prediction_target STRING COMMENT 'What the model predicts',
  unit_of_measure STRING COMMENT 'Unit of predicted and actual values',
  deployed_date DATE COMMENT 'Go-live date',
  model_version STRING COMMENT 'Deployed semantic version',
  owner_team STRING COMMENT 'Team that owns the model',
  criticality STRING COMMENT 'Business criticality: High, Medium or Low',
  criticality_order INT COMMENT '1 = High, 2 = Medium, 3 = Low',
  CONSTRAINT dim_model_pk PRIMARY KEY (model_id)
) COMMENT 'Model registry: one row per production ML model';

INSERT INTO {{catalog}}.{{prefix}}_silver.dim_model
SELECT
  CAST(model_id AS STRING),
  CAST(model_name AS STRING),
  CAST(model_type AS STRING),
  CAST(business_unit AS STRING),
  CAST(site_id AS STRING),
  CONCAT(CASE split(site_id, '_')[1]
           WHEN 'HOU' THEN 'Houston' WHEN 'PHX' THEN 'Phoenix' WHEN 'CHI' THEN 'Chicago'
           WHEN 'NYC' THEN 'New York' WHEN 'SEA' THEN 'Seattle' WHEN 'ATX' THEN 'Austin'
           ELSE split(site_id, '_')[1] END,
         ' ', CAST(CAST(split(site_id, '_')[2] AS INT) AS STRING)),
  CAST(asset_type AS STRING),
  CAST(prediction_target AS STRING),
  CAST(unit_of_measure AS STRING),
  CAST(deployed_date AS DATE),
  CAST(model_version AS STRING),
  CAST(owner_team AS STRING),
  CAST(criticality AS STRING),
  CASE criticality WHEN 'High' THEN 1 WHEN 'Medium' THEN 2 ELSE 3 END
FROM {{catalog}}.{{prefix}}_bronze.model_registry;

-- One row per model per minute (predictions.csv).
CREATE OR REPLACE TABLE {{catalog}}.{{prefix}}_silver.fact_predictions (
  prediction_time TIMESTAMP NOT NULL COMMENT 'Minute the prediction was made',
  model_id STRING NOT NULL COMMENT 'Model that made the prediction',
  predicted_value DOUBLE COMMENT 'Model output, in the model''s unit of measure',
  actual_value DOUBLE COMMENT 'Measured value; null (about 30%) when ground truth has not arrived yet, which is expected',
  prediction_error DOUBLE COMMENT 'actual_value - predicted_value; null when actual_value is null',
  confidence_score DOUBLE COMMENT 'Model self-reported confidence, 0 to 1',
  anomaly_flag BOOLEAN COMMENT 'True when the model flagged this reading as an anomaly (an alert)',
  drift_score DOUBLE COMMENT 'Input-feature drift, 0 (none) to 1',
  latency_ms INT COMMENT 'Time to score, milliseconds',
  input_feature_hash STRING COMMENT 'Fingerprint of the input features (technical; not for analysis)',
  CONSTRAINT fact_predictions_pk PRIMARY KEY (prediction_time, model_id)
) COMMENT 'Minute-level model predictions with ground truth where available';

INSERT INTO {{catalog}}.{{prefix}}_silver.fact_predictions
SELECT
  CAST(`timestamp` AS TIMESTAMP),
  CAST(model_id AS STRING),
  CAST(predicted_value AS DOUBLE),
  CAST(actual_value AS DOUBLE),
  CAST(prediction_error AS DOUBLE),
  CAST(confidence_score AS DOUBLE),
  CAST(anomaly_flag AS BOOLEAN),
  CAST(drift_score AS DOUBLE),
  CAST(latency_ms AS INT),
  CAST(input_feature_hash AS STRING)
FROM {{catalog}}.{{prefix}}_bronze.predictions;

-- One row per model per hour (business_outcomes.csv). incidents_predicted is the hour's count of
-- anomaly alerts in fact_predictions; incidents_confirmed is the subset confirmed on site.
CREATE OR REPLACE TABLE {{catalog}}.{{prefix}}_silver.fact_business_outcomes (
  date_hour TIMESTAMP NOT NULL COMMENT 'Hour bucket (floor of prediction_time to the hour)',
  model_id STRING NOT NULL COMMENT 'Model the outcome is attributed to',
  incidents_predicted INT COMMENT 'Anomaly alerts raised in the hour',
  incidents_confirmed INT COMMENT 'Alerts confirmed as real incidents',
  false_positives INT COMMENT 'Alerts that were not real: incidents_predicted - incidents_confirmed',
  downtime_avoided_hours DOUBLE COMMENT 'Estimated equipment downtime avoided, hours',
  estimated_cost_savings_usd DOUBLE COMMENT 'Estimated cost savings, US dollars',
  yield_improvement_pct DOUBLE COMMENT 'Yield improvement in percentage points; only Reactor and Furnace models report it (0 elsewhere)',
  action_taken STRING COMMENT 'Response recorded: No Action, Alert Sent, Manual Intervention, Auto-Adjusted or Ignored',
  CONSTRAINT fact_business_outcomes_pk PRIMARY KEY (date_hour, model_id)
) COMMENT 'Hourly business outcomes attributed to each model';

INSERT INTO {{catalog}}.{{prefix}}_silver.fact_business_outcomes
SELECT
  CAST(date_hour AS TIMESTAMP),
  CAST(model_id AS STRING),
  CAST(incidents_predicted AS INT),
  CAST(incidents_confirmed AS INT),
  CAST(false_positives AS INT),
  CAST(downtime_avoided_hours AS DOUBLE),
  CAST(estimated_cost_savings_usd AS DOUBLE),
  CAST(yield_improvement_pct AS DOUBLE),
  CAST(action_taken AS STRING)
FROM {{catalog}}.{{prefix}}_bronze.business_outcomes;
