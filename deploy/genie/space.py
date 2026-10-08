"""Genie space definition for Lens MLOps, as code.

`build_serialized_space(gold)` returns the dict that goes (JSON-encoded, as a
string) into the `serialized_space` field of POST /api/2.0/genie/spaces or
`databricks genie update-space`. Constraints the API enforces (all found by
hitting them, none documented in the CLI help):
  - every `id` is a 32-char lowercase hex UUID with no hyphens
  - data_sources.tables / metric_views sorted by `identifier`; every other
    list sorted by `id`
  - every benchmark needs >= 1 answer; answer format enum is the bare "SQL"
"""
import uuid

METRIC_VIEWS = ["mv_model_predictions", "mv_business_outcomes"]
TABLES = [
    "business_rules_config",
    "qry_as_of", "qry_model_health", "qry_hourly_model_signals", "qry_incidents", "qry_anomaly_predictions",
    "qry_latest_readings", "qry_daily_fleet_trend",
    "qry_value_by_business_unit", "qry_value_by_site", "qry_value_by_criticality",
    # Command Center views (deploy/sql/70_command_center_views.sql). qry_explorer_base is not a
    # source: it holds partial sums for the Explorer and would invite wrong averages.
    "qry_cc_kpis", "qry_cc_health_by_bu", "qry_cc_actions",
]

INSTRUCTIONS_TEXT = """LENS MLOPS: RULES AND GUARDRAILS

Scope: answer questions about the production ML model fleet in this data: model health
(confidence, drift, accuracy, latency), anomaly alerts and incidents, and the business value
attributed to the models (downtime avoided, cost savings, yield). Politely decline anything else.

THE DATA
- 100 models across business units, sites and asset types, scoring every minute over a three-day
  window. "Now", "right now", "today", "this week" and "the last N hours" are relative to the
  latest prediction in the data (qry_as_of.as_of_time), never the system clock. The window is
  the whole of "this week".
- Name models by model_name with model_id in brackets, e.g. "Reactor Yield Forecaster #61
  (MDL_061)". Use site_name (e.g. "Houston 1") for sites; site_id (e.g. SITE_HOU_01) also works
  in filters, and "the Houston sites" means site_id LIKE 'SITE_HOU%'.
- Money is in US dollars: show it as $48.3M, $612K, $2,450.

DEFINITIONS (thresholds live in business_rules_config; always use them)
- A low-confidence prediction has confidence_score < 0.60.
- A model is low-confidence when at least 20% of its predictions on the latest day are
  low-confidence; it is drifting when its average drift_score on the latest day is >= 0.30.
  qry_model_health has these as drifting_flag, low_confidence_flag and health_status.
- An alert is a prediction with anomaly_flag = true. In business outcomes, incidents_predicted
  is the same alerts counted per hour; never add the two together. An incident is a run of
  consecutive alert hours for one model (qry_incidents).
- False positive rate = false positives / alerts; alert precision = confirmed / alerts.
- "Worst-performing" or "needs attention": order qry_model_health by action_order, then the
  latest-day drift (highest first), then latest-day confidence (lowest first).

CALCULATION RULES
- Rates are SUM(numerator)/SUM(denominator), never an average of percentages.
- Never add, average or compare predicted values, actual values, MAE or RMSE across models with
  different units of measure. To compare accuracy across models use error_pct per model from
  qry_model_health; for a group, average those per-model values.
- About 30% of predictions have no actual_value yet (ground truth arrives later). This is
  expected, not a data error: exclude them from accuracy and never treat them as zero.
- Yield improvement is reported only by Reactor and Furnace models.
- For questions about a single model over time, use qry_hourly_model_signals (one row per model
  per hour) and qry_incidents.

WHAT YOU MUST NOT DO
- No forecasts: the data covers three days, so do not project drift, alerts or savings beyond
  the window. Describe the trend inside it and say a forecast needs longer history.
- No causal claims: never say retraining, tuning or any action "will fix", "would save" or
  "caused" something. No model was retrained in the window. Describe what was observed and
  recommend a review or a controlled comparison.
- No ROI: the data has savings but no model cost. Report savings (per model, per group) and
  say ROI needs cost data.
- No targets: the data has no targets, budgets or service levels; do not say "on track" or
  "behind plan".
- No root cause: drift scores and alerts are recorded, not their causes or the input features.
  Say the cause needs engineering investigation.
- No process topology: the data does not say which assets are upstream or downstream of others.
  For "correlated" or "downstream" questions, compare alerts by site and hour and say the
  physical connection is not in the data.
- The data contains no personal information. If asked for people's names or contact details,
  say plainly it isn't in this data.
- If a question needs data that isn't here, say so rather than approximating."""

SAMPLE_QUESTIONS = [
    "How healthy is our model fleet right now?",
    "Which models are showing drift this week?",
    "Which models have confidence below 60% right now?",
    "What's happening with MDL_061? Explain the spike.",
    "What is total cost savings this week?",
    "Which business unit delivered the most value?",
    "Which model version has the highest false positive rate?",
    "Compare predicted vs actual accuracy across all Furnace models",
]


def examples(g: str):
    return [
        ("How healthy is our model fleet right now? / How many models need attention?",
         f"SELECT models, healthy_models, drifting_models, low_confidence_only_models, models_needing_attention, "
         f"high_criticality_needing_attention, as_of_time FROM {g}.qry_cc_kpis;"),
        ("Which models need action? / Which is the worst-performing model?",
         f"SELECT model_id, model_name, business_unit, site_name, criticality, health_status, latest_day_avg_drift, "
         f"latest_day_avg_confidence, latest_day_low_confidence_share, recommended_action FROM {g}.qry_model_health "
         f"WHERE action_order < 9 ORDER BY action_order, latest_day_avg_drift DESC, latest_day_avg_confidence;"),
        ("Which models are showing drift this week?",
         f"SELECT model_id, model_name, business_unit, site_name, criticality, first_day_avg_drift, latest_day_avg_drift, "
         f"drift_change FROM {g}.qry_model_health WHERE drifting_flag = 1 ORDER BY latest_day_avg_drift DESC;"),
        ("Which models have confidence below 60% right now?",
         f"SELECT model_id, model_name, business_unit, site_name, criticality, confidence_score, prediction_time "
         f"FROM {g}.qry_latest_readings WHERE low_confidence_flag = 1 ORDER BY confidence_score;"),
        ("Which models are flagging anomalies in the last hour?",
         f"SELECT h.model_id, h.model_name, h.site_name, h.asset_type, h.anomaly_alerts, h.date_hour "
         f"FROM {g}.qry_hourly_model_signals h JOIN {g}.qry_as_of a ON h.date_hour = date_trunc('HOUR', a.as_of_time) "
         f"WHERE h.anomaly_alerts > 0 ORDER BY h.anomaly_alerts DESC;"),
        ("What's happening with MDL_061? Explain the spike.",
         f"SELECT date_hour, avg_predicted_value, avg_actual_value, max_predicted_value, avg_confidence, avg_drift, "
         f"anomaly_alerts, incidents_confirmed, false_positives, downtime_avoided_hours, estimated_cost_savings_usd, action_taken "
         f"FROM {g}.qry_hourly_model_signals WHERE model_id = 'MDL_061' ORDER BY date_hour;"),
        ("List the incidents / What incidents did the models catch?",
         f"SELECT incident_id, model_name, model_id, site_name, asset_type, criticality, incident_start, incident_end, "
         f"duration_minutes, alerts, confirmed_incidents, false_positive_rate, downtime_avoided_hours, cost_savings_usd, responses "
         f"FROM {g}.qry_incidents ORDER BY incident_start;"),
        ("Show me the status of all compressors at SITE_HOU_01",
         f"SELECT model_id, model_name, health_status, latest_day_avg_confidence, latest_day_avg_drift, alerts, recommended_action "
         f"FROM {g}.qry_model_health WHERE asset_type = 'Compressor' AND site_id = 'SITE_HOU_01' ORDER BY model_id;"),
        ("Compare predicted vs actual accuracy across all Furnace models",
         f"SELECT model_id, model_name, unit_of_measure, verified_predictions, mae, rmse, error_pct "
         f"FROM {g}.qry_model_health WHERE asset_type = 'Furnace' ORDER BY error_pct;"),
        ("Which models are least accurate?",
         f"SELECT model_id, model_name, asset_type, unit_of_measure, error_pct, mae, verified_predictions "
         f"FROM {g}.qry_model_health ORDER BY error_pct DESC LIMIT 10;"),
        ("Which model version has the highest false positive rate?",
         f"SELECT model_version, COUNT(*) AS models, SUM(alerts) AS alerts, SUM(false_positives) AS false_positives, "
         f"1.0 * SUM(false_positives) / SUM(alerts) AS false_positive_rate FROM {g}.qry_model_health WHERE alerts > 0 "
         f"GROUP BY model_version ORDER BY false_positive_rate DESC;"),
        ("What is total cost savings this week?",
         f"SELECT MEASURE(cost_savings_usd) AS cost_savings_usd, MEASURE(downtime_avoided_hours) AS downtime_avoided_hours, "
         f"MEASURE(confirmed_incidents) AS confirmed_incidents FROM {g}.mv_business_outcomes;"),
        ("Which business unit delivered the most value?",
         f"SELECT business_unit, cost_savings_usd, share_of_savings, downtime_avoided_hours, confirmed_incidents "
         f"FROM {g}.qry_value_by_business_unit ORDER BY cost_savings_usd DESC;"),
        ("Which business unit delivered the most value in the last 24 hours?",
         f"SELECT h.business_unit, SUM(h.estimated_cost_savings_usd) AS cost_savings_usd, SUM(h.downtime_avoided_hours) AS downtime_avoided_hours "
         f"FROM {g}.qry_hourly_model_signals h CROSS JOIN {g}.qry_as_of a "
         f"WHERE h.date_hour > a.as_of_time - INTERVAL 24 HOURS GROUP BY h.business_unit ORDER BY cost_savings_usd DESC;"),
        ("How much downtime did we avoid at the Houston sites?",
         f"SELECT site_name, models, downtime_avoided_hours, cost_savings_usd, confirmed_incidents "
         f"FROM {g}.qry_value_by_site WHERE site_id LIKE 'SITE_HOU%' ORDER BY site_name;"),
        ("What's the ROI of our High-criticality models vs Low-criticality ones?",
         f"SELECT criticality, models, models_with_alerts, cost_savings_usd, savings_per_model, downtime_avoided_hours "
         f"FROM {g}.qry_value_by_criticality ORDER BY criticality_order;"),
        ("Are there correlated anomalies between compressors and reactors at the same site?",
         f"SELECT site_name, date_hour, SUM(CASE WHEN asset_type = 'Compressor' THEN anomaly_alerts ELSE 0 END) AS compressor_alerts, "
         f"SUM(CASE WHEN asset_type = 'Reactor' THEN anomaly_alerts ELSE 0 END) AS reactor_alerts "
         f"FROM {g}.qry_hourly_model_signals WHERE asset_type IN ('Compressor', 'Reactor') GROUP BY site_name, date_hour "
         f"HAVING SUM(anomaly_alerts) > 0 ORDER BY date_hour;"),
        ("How has the fleet changed day by day?",
         f"SELECT day, avg_confidence, low_confidence_share, avg_drift, drifting_models, alerts, confirmed_incidents, cost_savings_usd "
         f"FROM {g}.qry_daily_fleet_trend ORDER BY day;"),
        ("What is the scoring latency by asset type?",
         f"SELECT asset_type, MEASURE(avg_latency_ms) AS avg_latency_ms, MEASURE(p95_latency_ms) AS p95_latency_ms "
         f"FROM {g}.mv_model_predictions GROUP BY asset_type ORDER BY p95_latency_ms DESC;"),
        ("What yield improvement are reactor and furnace models delivering?",
         f"SELECT asset_type, MEASURE(avg_yield_improvement_pct) AS avg_yield_improvement_pct, MEASURE(models) AS models "
         f"FROM {g}.mv_business_outcomes WHERE asset_type IN ('Reactor', 'Furnace') GROUP BY asset_type;"),
    ]


def benchmarks(g: str):
    return [
        ("How healthy is our model fleet right now?",
         f"SELECT models, healthy_models, drifting_models, low_confidence_only_models, models_needing_attention, "
         f"high_criticality_needing_attention, as_of_time FROM {g}.qry_cc_kpis;"),
        ("Which models are showing drift this week?",
         f"SELECT model_id, model_name, business_unit, site_name, criticality, first_day_avg_drift, latest_day_avg_drift, "
         f"drift_change FROM {g}.qry_model_health WHERE drifting_flag = 1 ORDER BY latest_day_avg_drift DESC;"),
        ("Which models have confidence below 60% right now?",
         f"SELECT model_id, model_name, business_unit, site_name, criticality, confidence_score, prediction_time "
         f"FROM {g}.qry_latest_readings WHERE low_confidence_flag = 1 ORDER BY confidence_score;"),
        ("What is total cost savings this week?",
         f"SELECT MEASURE(cost_savings_usd) AS cost_savings_usd, MEASURE(downtime_avoided_hours) AS downtime_avoided_hours, "
         f"MEASURE(confirmed_incidents) AS confirmed_incidents FROM {g}.mv_business_outcomes;"),
        ("Which model version has the highest false positive rate?",
         f"SELECT model_version, COUNT(*) AS models, SUM(alerts) AS alerts, SUM(false_positives) AS false_positives, "
         f"1.0 * SUM(false_positives) / SUM(alerts) AS false_positive_rate FROM {g}.qry_model_health WHERE alerts > 0 "
         f"GROUP BY model_version ORDER BY false_positive_rate DESC;"),
        ("Compare predicted vs actual accuracy across all Furnace models",
         f"SELECT model_id, model_name, unit_of_measure, verified_predictions, mae, rmse, error_pct "
         f"FROM {g}.qry_model_health WHERE asset_type = 'Furnace' ORDER BY error_pct;"),
        ("Which business unit delivered the most value?",
         f"SELECT business_unit, cost_savings_usd, share_of_savings, downtime_avoided_hours, confirmed_incidents "
         f"FROM {g}.qry_value_by_business_unit ORDER BY cost_savings_usd DESC;"),
        # Refusal case: the API requires an answer, so this documents the expected
        # refusal; Genie answers without SQL, so the result is marked for manual review.
        ("Will retraining the drifting models fix them, and how much will it save?",
         "SELECT 'No retraining happened in the data, so its effect cannot be measured: list the drifting models, recommend a review "
         "and a controlled comparison, and give no savings figure.' AS Expected_Refusal_Reasoning;"),
    ]


def _id() -> str:
    return uuid.uuid4().hex


def build_serialized_space(gold_schema: str) -> dict:
    """gold_schema is '<catalog>.<schema>', e.g. 'cnx_automl_dev.lens_mlops_gold'."""
    return {
        "version": 2,
        "config": {
            "sample_questions": sorted(
                ({"id": _id(), "question": [q]} for q in SAMPLE_QUESTIONS), key=lambda x: x["id"]
            )
        },
        "data_sources": {
            "tables": sorted(({"identifier": f"{gold_schema}.{t}"} for t in TABLES), key=lambda x: x["identifier"]),
            "metric_views": sorted(({"identifier": f"{gold_schema}.{m}"} for m in METRIC_VIEWS), key=lambda x: x["identifier"]),
        },
        "instructions": {
            "text_instructions": [{"id": _id(), "content": [INSTRUCTIONS_TEXT]}],
            "example_question_sqls": sorted(
                ({"id": _id(), "question": [q], "sql": [s]} for q, s in examples(gold_schema)), key=lambda x: x["id"]
            ),
        },
        "benchmarks": {
            "questions": sorted(
                ({"id": _id(), "question": [q], "answer": [{"format": "SQL", "content": [s]}]} for q, s in benchmarks(gold_schema)),
                key=lambda x: x["id"],
            )
        },
    }
