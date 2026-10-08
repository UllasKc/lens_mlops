-- Governed metric views. Each measure is defined once; rates are sum/sum.
-- Thresholds that metric views can't read from a table repeat gold.business_rules_config's value
-- and say so in the comment (low_confidence_score = 0.60).

-- Model health: one row per model per minute.
CREATE OR REPLACE VIEW {{catalog}}.{{prefix}}_gold.mv_model_predictions WITH METRICS LANGUAGE YAML AS $$
version: 1.1
comment: "Model health from minute-level predictions: confidence, drift, anomaly alerts, accuracy against ground truth and latency, by model and its registry attributes"
source: {{catalog}}.{{prefix}}_silver.fact_predictions
joins:
  - name: model
    source: {{catalog}}.{{prefix}}_silver.dim_model
    on: source.model_id = model.model_id
    cardinality: many_to_one
fields:
  - name: model_id
    expr: source.model_id
    synonyms: [model, model code, MDL]
  - name: model_name
    expr: model.model_name
  - name: business_unit
    expr: model.business_unit
    synonyms: [BU, division, business]
  - name: site_name
    expr: model.site_name
    synonyms: [site, plant, location, facility]
  - name: site_id
    expr: model.site_id
  - name: asset_type
    expr: model.asset_type
    synonyms: [asset, equipment, equipment class]
  - name: model_type
    expr: model.model_type
    synonyms: [modelling approach, model family]
  - name: criticality
    expr: model.criticality
    synonyms: [business criticality, priority, importance]
  - name: owner_team
    expr: model.owner_team
    synonyms: [team, owner, owning team]
  - name: model_version
    expr: model.model_version
    synonyms: [version, release]
  - name: prediction_target
    expr: model.prediction_target
  - name: unit_of_measure
    expr: model.unit_of_measure
  - name: prediction_date
    expr: CAST(source.prediction_time AS DATE)
    synonyms: [day, date]
  - name: prediction_hour
    expr: date_trunc('HOUR', source.prediction_time)
    synonyms: [hour]
measures:
  - name: models
    expr: COUNT(DISTINCT source.model_id)
    comment: "Number of models"
  - name: predictions
    expr: COUNT(1)
    comment: "Number of predictions"
    synonyms: [scores, inferences, readings]
  - name: verified_predictions
    expr: COUNT(source.actual_value)
    comment: "Predictions with ground truth (actual value) available"
  - name: verified_share
    expr: COUNT(source.actual_value) / NULLIF(COUNT(1), 0)
    comment: "Share of predictions with ground truth; about 70% is expected, missing actuals are not a data error"
    synonyms: [ground truth coverage, labelled share]
  - name: avg_confidence
    expr: AVG(source.confidence_score)
    comment: "Average confidence score"
    synonyms: [confidence, certainty]
  - name: low_confidence_predictions
    expr: SUM(CASE WHEN source.confidence_score < 0.60 THEN 1 ELSE 0 END)
    comment: "Predictions with confidence below 0.60 (low_confidence_score in gold.business_rules_config)"
  - name: low_confidence_share
    expr: SUM(CASE WHEN source.confidence_score < 0.60 THEN 1 ELSE 0 END) / NULLIF(COUNT(1), 0)
    comment: "Share of predictions with confidence below 0.60"
  - name: avg_drift
    expr: AVG(source.drift_score)
    comment: "Average drift score, 0 (none) to 1"
    synonyms: [drift, feature drift, data drift]
  - name: max_drift
    expr: MAX(source.drift_score)
    comment: "Highest drift score"
  - name: anomaly_alerts
    expr: SUM(CASE WHEN source.anomaly_flag THEN 1 ELSE 0 END)
    comment: "Predictions flagged as anomalies (alerts raised)"
    synonyms: [anomalies, alerts, flags, incidents predicted]
  - name: anomaly_rate
    expr: SUM(CASE WHEN source.anomaly_flag THEN 1 ELSE 0 END) / NULLIF(COUNT(1), 0)
    comment: "Share of predictions flagged as anomalies"
  - name: mae
    expr: AVG(ABS(source.prediction_error))
    comment: "Mean absolute error, in the model's own unit; compare only models with the same unit"
    synonyms: [mean absolute error, average error]
  - name: rmse
    expr: SQRT(AVG(source.prediction_error * source.prediction_error))
    comment: "Root mean squared error, in the model's own unit; compare only models with the same unit"
  - name: error_pct
    expr: SUM(ABS(source.prediction_error)) / NULLIF(SUM(CASE WHEN source.actual_value IS NOT NULL THEN ABS(source.actual_value) END), 0)
    comment: "Absolute error as a share of actual values (weighted absolute percentage error). Group by model_id: across models it is dominated by large-valued units such as temperature; for a group, average the per-model values (qry_model_health.error_pct)"
    synonyms: [WAPE, relative error, error rate]
  - name: avg_latency_ms
    expr: AVG(source.latency_ms)
    comment: "Average scoring latency, milliseconds"
    synonyms: [latency, response time, scoring time]
  - name: p95_latency_ms
    expr: PERCENTILE_APPROX(source.latency_ms, 0.95)
    comment: "95th percentile scoring latency, milliseconds"
$$;

-- Business value: one row per model per hour.
CREATE OR REPLACE VIEW {{catalog}}.{{prefix}}_gold.mv_business_outcomes WITH METRICS LANGUAGE YAML AS $$
version: 1.1
comment: "Business outcomes attributed to models, hourly: alerts, confirmed incidents, false positives, downtime avoided, cost savings and yield improvement"
source: {{catalog}}.{{prefix}}_silver.fact_business_outcomes
joins:
  - name: model
    source: {{catalog}}.{{prefix}}_silver.dim_model
    on: source.model_id = model.model_id
    cardinality: many_to_one
fields:
  - name: model_id
    expr: source.model_id
    synonyms: [model, model code, MDL]
  - name: model_name
    expr: model.model_name
  - name: business_unit
    expr: model.business_unit
    synonyms: [BU, division, business]
  - name: site_name
    expr: model.site_name
    synonyms: [site, plant, location, facility]
  - name: site_id
    expr: model.site_id
  - name: asset_type
    expr: model.asset_type
    synonyms: [asset, equipment, equipment class]
  - name: model_type
    expr: model.model_type
  - name: criticality
    expr: model.criticality
    synonyms: [business criticality, priority, importance]
  - name: owner_team
    expr: model.owner_team
  - name: model_version
    expr: model.model_version
    synonyms: [version, release]
  - name: action_taken
    expr: source.action_taken
    synonyms: [response, action, intervention]
  - name: outcome_date
    expr: CAST(source.date_hour AS DATE)
    synonyms: [day, date]
  - name: outcome_hour
    expr: source.date_hour
    synonyms: [hour]
measures:
  - name: models
    expr: COUNT(DISTINCT source.model_id)
    comment: "Number of models"
  - name: alerts
    expr: SUM(source.incidents_predicted)
    comment: "Alerts raised (incidents predicted)"
    synonyms: [incidents predicted, predicted incidents, anomaly alerts]
  - name: confirmed_incidents
    expr: SUM(source.incidents_confirmed)
    comment: "Alerts confirmed as real incidents"
    synonyms: [incidents confirmed, true positives, real incidents]
  - name: false_positives
    expr: SUM(source.false_positives)
    comment: "Alerts that turned out not to be real"
    synonyms: [false alarms, false alerts]
  - name: false_positive_rate
    expr: SUM(source.false_positives) / NULLIF(SUM(source.incidents_predicted), 0)
    comment: "False positives as a share of alerts raised"
    synonyms: [false alarm rate, FP rate]
  - name: alert_precision
    expr: SUM(source.incidents_confirmed) / NULLIF(SUM(source.incidents_predicted), 0)
    comment: "Confirmed incidents as a share of alerts raised"
    synonyms: [precision, hit rate]
  - name: downtime_avoided_hours
    expr: SUM(source.downtime_avoided_hours)
    comment: "Estimated equipment downtime avoided, hours"
    synonyms: [downtime avoided, hours saved, uptime protected]
  - name: cost_savings_usd
    expr: SUM(source.estimated_cost_savings_usd)
    comment: "Estimated cost savings, US dollars"
    synonyms: [savings, value, cost avoided, money saved, ROI value]
  - name: avg_yield_improvement_pct
    expr: AVG(CASE WHEN model.asset_type IN ('Reactor', 'Furnace') THEN source.yield_improvement_pct END)
    comment: "Average yield improvement, percentage points; only Reactor and Furnace models report yield"
    synonyms: [yield, yield gain]
  - name: incident_hours
    expr: SUM(CASE WHEN source.incidents_predicted > 0 THEN 1 ELSE 0 END)
    comment: "Model-hours with at least one alert"
$$;
