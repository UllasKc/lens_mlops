-- Silver: synthetic operations data for the same 100 models (deploy/synthetic/ops_data.py, fixed seed).
-- The source data has no serving SLA, cost, feature-level drift, retraining dates, promotions or
-- governance records; these tables supply them for the Command Center. Every table says so in its comment.

-- One row per model: its serving endpoint and retraining facts.
CREATE OR REPLACE TABLE {{catalog}}.{{prefix}}_silver.ops_model_endpoint (
  model_id STRING NOT NULL COMMENT 'Model identifier (dim_model)',
  endpoint_name STRING COMMENT 'Serving endpoint name',
  serving_mode STRING COMMENT 'real_time (an online endpoint with a latency SLO) or batch',
  compute_type STRING COMMENT 'GPU or CPU',
  instance_count INT COMMENT 'Provisioned instances',
  value_at_stake_usd_month DOUBLE COMMENT 'Business value a month that depends on this model working well, US dollars (an estimate)',
  last_trained_date DATE COMMENT 'When the live version was last trained',
  retrain_cadence_days INT COMMENT 'Planned retraining interval, days (High 30, Medium 45, Low 60)',
  CONSTRAINT ops_model_endpoint_pk PRIMARY KEY (model_id)
) COMMENT 'SYNTHETIC demo data: one serving endpoint per model, with value at stake and retraining dates. Generated for the Command Center; not from the source data.';

INSERT INTO {{catalog}}.{{prefix}}_silver.ops_model_endpoint
SELECT CAST(model_id AS STRING), CAST(endpoint_name AS STRING), CAST(serving_mode AS STRING), CAST(compute_type AS STRING),
  CAST(instance_count AS INT), CAST(value_at_stake_usd_month AS DOUBLE), CAST(last_trained_date AS DATE),
  CAST(retrain_cadence_days AS INT)
FROM {{catalog}}.{{prefix}}_bronze.ops_model_endpoints;

-- One row per model per day for the 30 days to the as-of date.
CREATE OR REPLACE TABLE {{catalog}}.{{prefix}}_silver.ops_serving_daily (
  serving_date DATE NOT NULL COMMENT 'Day',
  model_id STRING NOT NULL COMMENT 'Model served',
  requests BIGINT COMMENT 'Inference requests served',
  forecast_requests BIGINT COMMENT 'Requests forecast for the day (capacity plan)',
  downtime_minutes DOUBLE COMMENT 'Minutes the endpoint was unavailable (0 to 1440)',
  p95_latency_ms DOUBLE COMMENT '95th-percentile response time, milliseconds',
  error_requests BIGINT COMMENT 'Requests that returned an error',
  cost_usd DOUBLE COMMENT 'Serving cost for the day: instances plus per-request charge, US dollars',
  utilization_pct DOUBLE COMMENT 'Average compute utilisation, percent',
  CONSTRAINT ops_serving_daily_pk PRIMARY KEY (serving_date, model_id)
) COMMENT 'SYNTHETIC demo data: daily serving volume, uptime, latency and cost per model endpoint, 8 Sep - 7 Oct 2026. Generated for the Command Center; not from the source data.';

INSERT INTO {{catalog}}.{{prefix}}_silver.ops_serving_daily
SELECT CAST(`day` AS DATE), CAST(model_id AS STRING), CAST(requests AS BIGINT), CAST(forecast_requests AS BIGINT),
  CAST(downtime_minutes AS DOUBLE), CAST(p95_latency_ms AS DOUBLE), CAST(error_requests AS BIGINT),
  CAST(cost_usd AS DOUBLE), CAST(utilization_pct AS DOUBLE)
FROM {{catalog}}.{{prefix}}_bronze.ops_serving_daily;

-- One row per model per input feature.
CREATE OR REPLACE TABLE {{catalog}}.{{prefix}}_silver.ops_feature_drift (
  model_id STRING NOT NULL COMMENT 'Model',
  feature_name STRING NOT NULL COMMENT 'Input feature',
  feature_source STRING COMMENT 'Upstream feed the feature comes from, e.g. historian.sensor_events',
  psi_month_start DOUBLE COMMENT 'Population stability index at the start of the month (under 0.10 stable, 0.10-0.25 moderate, over 0.25 significant)',
  psi_latest DOUBLE COMMENT 'Population stability index on the latest day',
  CONSTRAINT ops_feature_drift_pk PRIMARY KEY (model_id, feature_name)
) COMMENT 'SYNTHETIC demo data: feature-level data drift (PSI) per model input. Consistent with the source data: the 4 models drifting in the source have the high PSI values. Not from the source data.';

INSERT INTO {{catalog}}.{{prefix}}_silver.ops_feature_drift
SELECT CAST(model_id AS STRING), CAST(feature_name AS STRING), CAST(feature_source AS STRING),
  CAST(psi_month_start AS DOUBLE), CAST(psi_latest AS DOUBLE)
FROM {{catalog}}.{{prefix}}_bronze.ops_feature_drift;

-- Candidate versions on their way to production.
CREATE OR REPLACE TABLE {{catalog}}.{{prefix}}_silver.ops_promotion (
  promotion_id STRING NOT NULL COMMENT 'Promotion identifier',
  model_id STRING COMMENT 'Model being upgraded',
  candidate_version STRING COMMENT 'Version being promoted',
  stage STRING COMMENT 'staging or canary',
  planned_date DATE COMMENT 'Planned go-live date',
  status STRING COMMENT 'on_track, at_risk or blocked',
  blocker STRING COMMENT 'What is holding it up (empty when on track)',
  CONSTRAINT ops_promotion_pk PRIMARY KEY (promotion_id)
) COMMENT 'SYNTHETIC demo data: model versions in staging or canary, with status and blockers. Not from the source data.';

INSERT INTO {{catalog}}.{{prefix}}_silver.ops_promotion
SELECT CAST(promotion_id AS STRING), CAST(model_id AS STRING), CAST(candidate_version AS STRING), CAST(stage AS STRING),
  CAST(planned_date AS DATE), CAST(status AS STRING), CAST(blocker AS STRING)
FROM {{catalog}}.{{prefix}}_bronze.ops_promotions;

-- Governance records per model.
CREATE OR REPLACE TABLE {{catalog}}.{{prefix}}_silver.ops_model_governance (
  model_id STRING NOT NULL COMMENT 'Model',
  model_card_updated DATE COMMENT 'When the model card was last updated',
  last_bias_audit DATE COMMENT 'Last bias / fairness audit',
  next_audit_due DATE COMMENT 'Next audit due (quarterly)',
  review_deadline DATE COMMENT 'Deadline of the current model-risk review',
  CONSTRAINT ops_model_governance_pk PRIMARY KEY (model_id)
) COMMENT 'SYNTHETIC demo data: model card and bias audit dates per model. Not from the source data.';

INSERT INTO {{catalog}}.{{prefix}}_silver.ops_model_governance
SELECT CAST(model_id AS STRING), CAST(model_card_updated AS DATE), CAST(last_bias_audit AS DATE),
  CAST(next_audit_due AS DATE), CAST(review_deadline AS DATE)
FROM {{catalog}}.{{prefix}}_bronze.ops_governance;

-- Recorded pipeline and platform events: the recorded cause behind an issue.
CREATE OR REPLACE TABLE {{catalog}}.{{prefix}}_silver.ops_pipeline_event (
  event_id STRING NOT NULL COMMENT 'Event identifier',
  event_time TIMESTAMP COMMENT 'When it happened',
  source STRING COMMENT 'System it happened in',
  event_type STRING COMMENT 'schema_change, config_change, fix, pipeline_failure, process_change or audit_cycle',
  description STRING COMMENT 'What happened, as recorded',
  CONSTRAINT ops_pipeline_event_pk PRIMARY KEY (event_id)
) COMMENT 'SYNTHETIC demo data: recorded data-pipeline and platform events (schema changes, config changes, failures). Quote these as the recorded cause of an issue; never infer a cause that is not recorded here. Not from the source data.';

INSERT INTO {{catalog}}.{{prefix}}_silver.ops_pipeline_event
SELECT CAST(event_id AS STRING), CAST(event_time AS TIMESTAMP), CAST(source AS STRING), CAST(event_type AS STRING),
  CAST(description AS STRING)
FROM {{catalog}}.{{prefix}}_bronze.ops_pipeline_events;

CREATE OR REPLACE TABLE {{catalog}}.{{prefix}}_silver.ops_event_model (
  event_id STRING NOT NULL COMMENT 'Event (ops_pipeline_event)',
  model_id STRING NOT NULL COMMENT 'Model it affected',
  issue_type STRING COMMENT 'Issue it is recorded against: feature_drift, latency, retrain_backlog, accuracy or governance',
  CONSTRAINT ops_event_model_pk PRIMARY KEY (event_id, model_id)
) COMMENT 'SYNTHETIC demo data: which models each recorded event affected, and the issue it is recorded against. Not from the source data.';

INSERT INTO {{catalog}}.{{prefix}}_silver.ops_event_model
SELECT CAST(event_id AS STRING), CAST(model_id AS STRING), CAST(issue_type AS STRING)
FROM {{catalog}}.{{prefix}}_bronze.ops_event_models;
