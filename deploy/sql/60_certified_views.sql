-- Certified views: the governed answers to the key questions. Thresholds come from
-- gold.qry_rules (business_rules_config); the as-of point is the latest prediction in the data.

-- The monitoring window: first and latest prediction, and the latest full day.
CREATE OR REPLACE VIEW {{catalog}}.{{prefix}}_gold.qry_as_of AS
SELECT MIN(prediction_time) AS window_start, MAX(prediction_time) AS as_of_time,
       CAST(MIN(prediction_time) AS DATE) AS first_day, CAST(MAX(prediction_time) AS DATE) AS latest_day,
       COUNT(DISTINCT CAST(prediction_time AS DATE)) AS days_in_window
FROM {{catalog}}.{{prefix}}_silver.fact_predictions;

-- Model health: one row per model. Health is judged on the latest day (drift, confidence);
-- alerts, value and accuracy cover the whole window.
CREATE OR REPLACE VIEW {{catalog}}.{{prefix}}_gold.qry_model_health AS
WITH a AS (SELECT * FROM {{catalog}}.{{prefix}}_gold.qry_as_of),
r AS (SELECT * FROM {{catalog}}.{{prefix}}_gold.qry_rules),
p AS (
  SELECT f.model_id,
    COUNT(*) AS predictions,
    COUNT(f.actual_value) AS verified_predictions,
    AVG(f.confidence_score) AS avg_confidence,
    SUM(CASE WHEN f.confidence_score < r.low_confidence_score THEN 1 ELSE 0 END) AS low_confidence_predictions,
    SUM(CASE WHEN CAST(f.prediction_time AS DATE) = a.latest_day THEN 1 ELSE 0 END) AS latest_day_predictions,
    AVG(CASE WHEN CAST(f.prediction_time AS DATE) = a.latest_day THEN f.confidence_score END) AS latest_day_avg_confidence,
    SUM(CASE WHEN CAST(f.prediction_time AS DATE) = a.latest_day AND f.confidence_score < r.low_confidence_score THEN 1 ELSE 0 END) AS latest_day_low_confidence_predictions,
    AVG(f.drift_score) AS avg_drift,
    AVG(CASE WHEN CAST(f.prediction_time AS DATE) = a.first_day THEN f.drift_score END) AS first_day_avg_drift,
    AVG(CASE WHEN CAST(f.prediction_time AS DATE) = a.latest_day THEN f.drift_score END) AS latest_day_avg_drift,
    SUM(CASE WHEN f.anomaly_flag THEN 1 ELSE 0 END) AS anomaly_alerts,
    AVG(ABS(f.prediction_error)) AS mae,
    SQRT(AVG(f.prediction_error * f.prediction_error)) AS rmse,
    SUM(ABS(f.prediction_error)) / NULLIF(SUM(CASE WHEN f.actual_value IS NOT NULL THEN ABS(f.actual_value) END), 0) AS error_pct,
    AVG(f.latency_ms) AS avg_latency_ms,
    PERCENTILE_APPROX(f.latency_ms, 0.95) AS p95_latency_ms
  FROM {{catalog}}.{{prefix}}_silver.fact_predictions f CROSS JOIN a CROSS JOIN r
  GROUP BY f.model_id
), o AS (
  SELECT model_id,
    SUM(incidents_predicted) AS alerts,
    SUM(incidents_confirmed) AS confirmed_incidents,
    SUM(false_positives) AS false_positives,
    SUM(downtime_avoided_hours) AS downtime_avoided_hours,
    SUM(estimated_cost_savings_usd) AS cost_savings_usd,
    AVG(yield_improvement_pct) AS avg_yield_all_hours,
    SUM(CASE WHEN incidents_predicted > 0 AND action_taken IN ('Ignored', 'No Action') THEN 1 ELSE 0 END) AS unanswered_alert_hours
  FROM {{catalog}}.{{prefix}}_silver.fact_business_outcomes
  GROUP BY model_id
), h AS (
  SELECT m.*, p.predictions, p.verified_predictions,
    1.0 * p.verified_predictions / NULLIF(p.predictions, 0) AS verified_share,
    p.avg_confidence, p.low_confidence_predictions, p.latest_day_predictions, p.latest_day_avg_confidence,
    p.latest_day_low_confidence_predictions,
    1.0 * p.latest_day_low_confidence_predictions / NULLIF(p.latest_day_predictions, 0) AS latest_day_low_confidence_share,
    p.avg_drift, p.first_day_avg_drift, p.latest_day_avg_drift,
    p.latest_day_avg_drift - p.first_day_avg_drift AS drift_change,
    p.anomaly_alerts, p.mae, p.rmse, p.error_pct, p.avg_latency_ms, p.p95_latency_ms,
    o.alerts, o.confirmed_incidents, o.false_positives,
    1.0 * o.false_positives / NULLIF(o.alerts, 0) AS false_positive_rate,
    o.downtime_avoided_hours, o.cost_savings_usd,
    CASE WHEN m.asset_type IN ('Reactor', 'Furnace') THEN o.avg_yield_all_hours END AS avg_yield_improvement_pct,
    o.unanswered_alert_hours,
    CASE WHEN p.latest_day_avg_drift >= r.drift_alert_threshold THEN 1 ELSE 0 END AS drifting_flag,
    CASE WHEN 1.0 * p.latest_day_low_confidence_predictions / NULLIF(p.latest_day_predictions, 0) >= r.low_confidence_model_share THEN 1 ELSE 0 END AS low_confidence_flag,
    CASE WHEN o.alerts > 0 AND 1.0 * o.false_positives / o.alerts > r.false_positive_rate_threshold THEN 1 ELSE 0 END AS high_false_positive_flag
  FROM {{catalog}}.{{prefix}}_silver.dim_model m
  JOIN p ON p.model_id = m.model_id
  LEFT JOIN o ON o.model_id = m.model_id
  CROSS JOIN r
)
SELECT h.*,
  CASE WHEN drifting_flag = 1 OR low_confidence_flag = 1 THEN 1 ELSE 0 END AS needs_attention_flag,
  CASE WHEN drifting_flag = 1 THEN 'Drifting' WHEN low_confidence_flag = 1 THEN 'Low confidence' ELSE 'Healthy' END AS health_status,
  CASE WHEN drifting_flag = 1 THEN 'Review drift and plan retraining'
       WHEN low_confidence_flag = 1 THEN 'Investigate low confidence'
       WHEN high_false_positive_flag = 1 THEN 'Tune alert threshold'
       WHEN unanswered_alert_hours > 0 THEN 'Review unanswered alerts'
       ELSE 'No action needed' END AS recommended_action,
  CASE WHEN drifting_flag = 1 THEN 1 WHEN low_confidence_flag = 1 THEN 2 WHEN high_false_positive_flag = 1 THEN 3
       WHEN unanswered_alert_hours > 0 THEN 4 ELSE 9 END AS action_order
FROM h;

-- One row per model per hour: the time series behind "what happened with this model?".
CREATE OR REPLACE VIEW {{catalog}}.{{prefix}}_gold.qry_hourly_model_signals AS
WITH r AS (SELECT * FROM {{catalog}}.{{prefix}}_gold.qry_rules),
p AS (
  SELECT f.model_id, date_trunc('HOUR', f.prediction_time) AS date_hour,
    COUNT(*) AS predictions,
    AVG(f.predicted_value) AS avg_predicted_value,
    AVG(f.actual_value) AS avg_actual_value,
    MAX(f.predicted_value) AS max_predicted_value,
    AVG(f.confidence_score) AS avg_confidence,
    SUM(CASE WHEN f.confidence_score < r.low_confidence_score THEN 1 ELSE 0 END) AS low_confidence_predictions,
    AVG(f.drift_score) AS avg_drift,
    SUM(CASE WHEN f.anomaly_flag THEN 1 ELSE 0 END) AS anomaly_alerts,
    AVG(ABS(f.prediction_error)) AS mae,
    AVG(f.latency_ms) AS avg_latency_ms
  FROM {{catalog}}.{{prefix}}_silver.fact_predictions f CROSS JOIN r
  GROUP BY f.model_id, date_trunc('HOUR', f.prediction_time)
)
SELECT p.date_hour, p.model_id, m.model_name, m.business_unit, m.site_name, m.site_id, m.asset_type, m.criticality,
  m.unit_of_measure, p.predictions, p.avg_predicted_value, p.avg_actual_value, p.max_predicted_value,
  p.avg_confidence, p.low_confidence_predictions, p.avg_drift, p.anomaly_alerts, p.mae, p.avg_latency_ms,
  o.incidents_confirmed, o.false_positives, o.downtime_avoided_hours, o.estimated_cost_savings_usd,
  o.yield_improvement_pct, o.action_taken
FROM p
JOIN {{catalog}}.{{prefix}}_silver.dim_model m ON m.model_id = p.model_id
LEFT JOIN {{catalog}}.{{prefix}}_silver.fact_business_outcomes o ON o.model_id = p.model_id AND o.date_hour = p.date_hour;

-- Incidents: consecutive alert hours for one model form one incident.
CREATE OR REPLACE VIEW {{catalog}}.{{prefix}}_gold.qry_incidents AS
WITH h AS (
  SELECT o.*,
    CAST(unix_timestamp(o.date_hour) / 3600 AS BIGINT) - ROW_NUMBER() OVER (PARTITION BY o.model_id ORDER BY o.date_hour) AS grp
  FROM {{catalog}}.{{prefix}}_silver.fact_business_outcomes o
  WHERE o.incidents_predicted > 0
), e AS (
  SELECT model_id, grp, MIN(date_hour) AS first_hour, MAX(date_hour) AS last_hour, COUNT(*) AS alert_hours,
    SUM(incidents_predicted) AS alerts, SUM(incidents_confirmed) AS confirmed_incidents, SUM(false_positives) AS false_positives,
    SUM(downtime_avoided_hours) AS downtime_avoided_hours, SUM(estimated_cost_savings_usd) AS cost_savings_usd,
    array_join(array_distinct(transform(array_sort(collect_list(struct(date_hour, action_taken))), x -> x.action_taken)), ', then ') AS responses,
    SUM(CASE WHEN action_taken IN ('Ignored', 'No Action') THEN incidents_predicted ELSE 0 END) AS unanswered_alerts
  FROM h GROUP BY model_id, grp
), a AS (
  SELECT e.model_id, e.grp, MIN(f.prediction_time) AS incident_start, MAX(f.prediction_time) AS incident_end,
    MAX(f.predicted_value) AS peak_predicted_value, AVG(f.predicted_value) AS avg_predicted_during
  FROM e JOIN {{catalog}}.{{prefix}}_silver.fact_predictions f
    ON f.model_id = e.model_id AND f.anomaly_flag
   AND f.prediction_time >= e.first_hour AND f.prediction_time < e.last_hour + INTERVAL 1 HOUR
  GROUP BY e.model_id, e.grp
), b AS (
  SELECT model_id, AVG(predicted_value) AS normal_predicted_value
  FROM {{catalog}}.{{prefix}}_silver.fact_predictions WHERE NOT anomaly_flag GROUP BY model_id
)
SELECT concat(e.model_id, ' ', date_format(a.incident_start, 'yyyy-MM-dd HH:mm')) AS incident_id,
  e.model_id, m.model_name, m.business_unit, m.site_name, m.site_id, m.asset_type, m.criticality, m.model_version,
  m.unit_of_measure, a.incident_start, a.incident_end,
  CAST((unix_timestamp(a.incident_end) - unix_timestamp(a.incident_start)) / 60 + 1 AS INT) AS duration_minutes,
  e.alert_hours, e.alerts, e.confirmed_incidents, e.false_positives,
  1.0 * e.false_positives / NULLIF(e.alerts, 0) AS false_positive_rate,
  e.downtime_avoided_hours, e.cost_savings_usd, e.responses, e.unanswered_alerts,
  a.peak_predicted_value, a.avg_predicted_during, b.normal_predicted_value,
  a.avg_predicted_during / NULLIF(b.normal_predicted_value, 0) AS level_vs_normal
FROM e
JOIN a ON a.model_id = e.model_id AND a.grp = e.grp
JOIN b ON b.model_id = e.model_id
JOIN {{catalog}}.{{prefix}}_silver.dim_model m ON m.model_id = e.model_id;

-- Every prediction flagged as an anomaly (an alert), with the incident it belongs to.
CREATE OR REPLACE VIEW {{catalog}}.{{prefix}}_gold.qry_anomaly_predictions AS
SELECT f.prediction_time, f.model_id, m.model_name, m.business_unit, m.site_name, m.asset_type, m.criticality,
  m.unit_of_measure, f.predicted_value, f.actual_value, f.prediction_error, f.confidence_score, f.drift_score,
  f.latency_ms, i.incident_id
FROM {{catalog}}.{{prefix}}_silver.fact_predictions f
JOIN {{catalog}}.{{prefix}}_silver.dim_model m ON m.model_id = f.model_id
LEFT JOIN {{catalog}}.{{prefix}}_gold.qry_incidents i
  ON i.model_id = f.model_id AND f.prediction_time BETWEEN i.incident_start AND i.incident_end
WHERE f.anomaly_flag;

-- The latest reading of every model ("right now" = the end of the data).
CREATE OR REPLACE VIEW {{catalog}}.{{prefix}}_gold.qry_latest_readings AS
SELECT f.prediction_time, f.model_id, m.model_name, m.business_unit, m.site_name, m.site_id, m.asset_type,
  m.criticality, m.unit_of_measure, f.predicted_value, f.actual_value, f.confidence_score,
  CASE WHEN f.confidence_score < r.low_confidence_score THEN 1 ELSE 0 END AS low_confidence_flag,
  f.drift_score, f.anomaly_flag, f.latency_ms
FROM {{catalog}}.{{prefix}}_silver.fact_predictions f
JOIN {{catalog}}.{{prefix}}_gold.qry_as_of a ON f.prediction_time = a.as_of_time
JOIN {{catalog}}.{{prefix}}_silver.dim_model m ON m.model_id = f.model_id
CROSS JOIN {{catalog}}.{{prefix}}_gold.qry_rules r;

-- The fleet day by day.
CREATE OR REPLACE VIEW {{catalog}}.{{prefix}}_gold.qry_daily_fleet_trend AS
WITH r AS (SELECT * FROM {{catalog}}.{{prefix}}_gold.qry_rules),
md AS (
  SELECT CAST(f.prediction_time AS DATE) AS day, f.model_id,
    COUNT(*) AS predictions, COUNT(f.actual_value) AS verified_predictions,
    SUM(f.confidence_score) AS confidence_sum,
    SUM(CASE WHEN f.confidence_score < r.low_confidence_score THEN 1 ELSE 0 END) AS low_confidence_predictions,
    AVG(f.drift_score) AS avg_drift,
    SUM(CASE WHEN f.anomaly_flag THEN 1 ELSE 0 END) AS anomaly_alerts
  FROM {{catalog}}.{{prefix}}_silver.fact_predictions f CROSS JOIN r
  GROUP BY CAST(f.prediction_time AS DATE), f.model_id
), od AS (
  SELECT CAST(date_hour AS DATE) AS day, SUM(incidents_confirmed) AS confirmed_incidents, SUM(false_positives) AS false_positives,
    SUM(downtime_avoided_hours) AS downtime_avoided_hours, SUM(estimated_cost_savings_usd) AS cost_savings_usd
  FROM {{catalog}}.{{prefix}}_silver.fact_business_outcomes GROUP BY CAST(date_hour AS DATE)
)
SELECT md.day, COUNT(*) AS models, SUM(md.predictions) AS predictions,
  1.0 * SUM(md.verified_predictions) / SUM(md.predictions) AS verified_share,
  SUM(md.confidence_sum) / SUM(md.predictions) AS avg_confidence,
  1.0 * SUM(md.low_confidence_predictions) / SUM(md.predictions) AS low_confidence_share,
  SUM(md.avg_drift * md.predictions) / SUM(md.predictions) AS avg_drift,
  SUM(CASE WHEN md.avg_drift >= r.drift_alert_threshold THEN 1 ELSE 0 END) AS drifting_models,
  SUM(md.anomaly_alerts) AS alerts,
  MAX(od.confirmed_incidents) AS confirmed_incidents, MAX(od.false_positives) AS false_positives,
  MAX(od.downtime_avoided_hours) AS downtime_avoided_hours, MAX(od.cost_savings_usd) AS cost_savings_usd
FROM md CROSS JOIN r LEFT JOIN od ON od.day = md.day
GROUP BY md.day, r.drift_alert_threshold;

-- Value by business unit.
CREATE OR REPLACE VIEW {{catalog}}.{{prefix}}_gold.qry_value_by_business_unit AS
SELECT business_unit, COUNT(*) AS models,
  SUM(CASE WHEN alerts > 0 THEN 1 ELSE 0 END) AS models_with_alerts,
  SUM(alerts) AS alerts, SUM(confirmed_incidents) AS confirmed_incidents, SUM(false_positives) AS false_positives,
  1.0 * SUM(false_positives) / NULLIF(SUM(alerts), 0) AS false_positive_rate,
  SUM(downtime_avoided_hours) AS downtime_avoided_hours, SUM(cost_savings_usd) AS cost_savings_usd,
  SUM(cost_savings_usd) / NULLIF(SUM(SUM(cost_savings_usd)) OVER (), 0) AS share_of_savings,
  SUM(needs_attention_flag) AS models_needing_attention
FROM {{catalog}}.{{prefix}}_gold.qry_model_health
GROUP BY business_unit;

-- Value by site.
CREATE OR REPLACE VIEW {{catalog}}.{{prefix}}_gold.qry_value_by_site AS
SELECT site_name, site_id, COUNT(*) AS models,
  SUM(CASE WHEN alerts > 0 THEN 1 ELSE 0 END) AS models_with_alerts,
  SUM(alerts) AS alerts, SUM(confirmed_incidents) AS confirmed_incidents, SUM(false_positives) AS false_positives,
  1.0 * SUM(false_positives) / NULLIF(SUM(alerts), 0) AS false_positive_rate,
  SUM(downtime_avoided_hours) AS downtime_avoided_hours, SUM(cost_savings_usd) AS cost_savings_usd,
  SUM(cost_savings_usd) / NULLIF(SUM(SUM(cost_savings_usd)) OVER (), 0) AS share_of_savings,
  SUM(needs_attention_flag) AS models_needing_attention
FROM {{catalog}}.{{prefix}}_gold.qry_model_health
GROUP BY site_name, site_id;

-- Value by criticality. There is no model running-cost data, so this is savings per model, not ROI.
CREATE OR REPLACE VIEW {{catalog}}.{{prefix}}_gold.qry_value_by_criticality AS
SELECT criticality, MIN(criticality_order) AS criticality_order, COUNT(*) AS models,
  SUM(CASE WHEN alerts > 0 THEN 1 ELSE 0 END) AS models_with_alerts,
  SUM(confirmed_incidents) AS confirmed_incidents, SUM(downtime_avoided_hours) AS downtime_avoided_hours,
  SUM(cost_savings_usd) AS cost_savings_usd, SUM(cost_savings_usd) / COUNT(*) AS savings_per_model,
  SUM(needs_attention_flag) AS models_needing_attention
FROM {{catalog}}.{{prefix}}_gold.qry_model_health
GROUP BY criticality;
