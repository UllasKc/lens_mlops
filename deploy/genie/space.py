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
    # Operations views (deploy/sql/75_ops_views.sql) on the synthetic serving, cost, drift, retraining,
    # promotion, governance and pipeline-event data.
    "qry_model_ops", "qry_cc_ops_month", "qry_cc_tiers", "qry_cc_issues", "qry_cc_ops_actions", "qry_cc_upside",
    "qry_feature_drift_status", "qry_serving_daily", "qry_pipeline_events",
]

INSTRUCTIONS_TEXT = """LENS MLOPS: RULES AND GUARDRAILS

Scope: answer questions about the production ML model fleet in this data: model health
(confidence, drift, accuracy, latency), anomaly alerts and incidents, the business value
attributed to the models (downtime avoided, cost savings, yield), and model operations (serving
SLA, cost, feature drift, retraining, promotions, governance). Politely decline anything else.

THE DATA
- 100 models across business units, sites and asset types, scoring every minute over a three-day
  window. "Now", "right now", "today", "this week" and "the last N hours" are relative to the
  latest prediction in the data (qry_as_of.as_of_time), never the system clock. The window is
  the whole of "this week".
- Name models by model_name with model_id in brackets, e.g. "Reactor Yield Forecaster #61
  (MDL_061)". Use site_name (e.g. "Houston 1") for sites; site_id (e.g. SITE_HOU_01) also works
  in filters, and "the Houston sites" means site_id LIKE 'SITE_HOU%'.
- Money is in US dollars: show it as $48.3M, $612K, $2,450.
- SYNTHETIC OPERATIONS DATA: serving uptime and SLA, request volume and forecast, latency SLO,
  serving cost, feature-level drift (PSI), retraining dates, promotions, governance (model cards,
  bias audits) and recorded pipeline events are SYNTHETIC DEMO DATA for the same 100 models
  (qry_model_ops, qry_cc_ops_month, qry_cc_tiers, qry_cc_issues, qry_cc_ops_actions, qry_cc_upside,
  qry_feature_drift_status, qry_serving_daily, qry_pipeline_events). Whenever an answer uses them,
  say once that these figures are synthetic demo data. Model health, accuracy, alerts and savings
  come from the monitoring data and are not synthetic.
- "This month" / "month to date" means the 1st of the latest day's month up to the latest day
  (1-7 Oct 2026, 24 days left). Serving history runs 8 Sep - 7 Oct 2026.

DEFINITIONS (thresholds live in business_rules_config; quote that table when asked how a figure
is defined, and use the flags in qry_model_health rather than typing a number)
- A low-confidence prediction has confidence_score < {low_confidence_score}.
- A model is low-confidence when at least {low_confidence_model_share} of its predictions on the latest day are
  low-confidence; it is drifting when its average drift_score on the latest day is >= {drift_alert_threshold}.
  qry_model_health has these as drifting_flag, low_confidence_flag and health_status.
- health_status shows one label, Drifting before Low confidence. A model can be both, so the count
  of low_confidence_flag = 1 can be one more than the models whose status is Low confidence. Say
  which you mean: "low-confidence models" in a health summary are qry_cc_kpis.low_confidence_only_models.
- Alerting needs tuning when more than {false_positive_rate_threshold} of a model's alerts were false positives
  (high_false_positive_flag). The tune-alert queue (action_order 3) holds only models that are not
  drifting or low-confidence, so it can be smaller than the number of flagged models.
- An unanswered alert is one in an hour whose action_taken is Ignored or No Action.
- An alert is a prediction with anomaly_flag = true. In business outcomes, incidents_predicted
  is the same alerts counted per hour; never add the two together. An incident is a run of
  consecutive alert hours for one model (qry_incidents).
- False positive rate = false positives / alerts; alert precision = confirmed / alerts.
- "Worst-performing" or "needs attention": order qry_model_health by action_order, then the
  latest-day drift (highest first), then latest-day confidence (lowest first).
- Operations (synthetic): the serving SLA target is {sla_uptime_target} uptime; real-time endpoints have a
  latency SLO of p95 <= {latency_slo_ms} ms (batch endpoints have none). A feature has drifted when its PSI is
  over {psi_drift_threshold}; a model has data drift with {psi_drift_feature_count} or more drifted features. A model is
  degrading when its error rose {accuracy_drop_watch} or more (relative) over the monitoring window, and a
  rollback candidate at {accuracy_drop_rollback} or more. Stale = trained over {stale_model_days} days ago; retraining
  overdue = more than {retrain_overdue_days} days past its cadence.
- Fleet tiers (qry_model_ops.fleet_tier, first that applies): Breaching SLO, Degrading, Stale, Watch,
  Healthy. This is a different label from health_status (Drifting / Low confidence / Healthy, from
  the monitoring data only); say which one you use. "How many models are healthy" without "SLA",
  "tier" or "operations" means health_status (85).
- Error budget = the downtime the SLA target allows for the whole month; burn rate above 1 means it
  is being used faster than the month allows.

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
- "The last hour" / "the last N hours" are the N hours up to qry_as_of.as_of_time. If nothing
  happened in that period, say so and give the most recent alert from qry_anomaly_predictions
  (when and which model) instead of returning nothing.

WHICH VIEW ANSWERS WHICH QUESTION (prefer these; each view's description says more)
- Fleet health, how many models need attention, headline figures: qry_cc_kpis. By business unit:
  qry_cc_health_by_bu.
- Anything per model (status, flags, drift, confidence, accuracy, alerts, value, next step) and
  "worst-performing": qry_model_health. Group it for other cuts.
- This week's action queues: qry_cc_actions (sizes); the models in them: qry_model_health WHERE
  action_order < 9.
- One model or one site over time, "explain the spike", the last N hours: qry_hourly_model_signals.
- Incidents: qry_incidents. Individual alerts and the most recent alert: qry_anomaly_predictions.
- "Right now" (the latest minute): qry_latest_readings. The window and what "now" means: qry_as_of.
- Day by day: qry_daily_fleet_trend.
- Value by business unit, site or criticality: qry_value_by_business_unit, qry_value_by_site,
  qry_value_by_criticality. Value in a time range: qry_hourly_model_signals.
- A measure by a dimension no view has (asset type, model type, owner team, version, hour, action
  taken): mv_model_predictions or mv_business_outcomes with MEASURE(...) GROUP BY the dimension.
- How a figure is defined, which threshold applies: business_rules_config.
- "Are we on track this month?", SLA, uptime, error budget, burn rate, month-end outlook,
  predictions vs forecast, promotions, cost per 1,000 inferences, fleet health score: qry_cc_ops_month.
- Fleet tiers and what each costs: qry_cc_tiers. Per model operations, tiers, flags, cost, value at
  stake, levers and recorded causes: qry_model_ops.
- Top issues, "what is hurting us", why models are degrading: qry_cc_issues (ranked, with the
  recorded cause). Recorded events: qry_pipeline_events.
- What to do today / this week / this month: qry_cc_ops_actions.
- Upside, savings potential by lever or model family: qry_cc_upside; top optimisation targets:
  qry_model_ops WHERE top_target_flag = 1 ORDER BY optimisation_rank.
- Which input features drift: qry_feature_drift_status. Uptime, latency, traffic or cost day by
  day: qry_serving_daily.

WHAT YOU MUST NOT DO
- No forecasts: the monitoring data covers three days, so do not project drift, alerts or savings
  beyond it; say a forecast needs longer history. The one exception is the month-end SLA outlook
  in qry_cc_ops_month: quote projected_uptime and outlook_likelihood as "if the downtime of the
  last few days continues, the month ends near X (a projection)", never as a promise.
- No causal claims: never say retraining, tuning or any action "will fix", "would save" or
  "caused" something. No model was retrained in the window. Describe what was observed and
  recommend a review or a controlled comparison. Upside figures (qry_cc_upside,
  potential_saving_usd_month) are estimates built on stated assumptions: call them "estimated
  upside", never what an action will deliver.
- No ROI: the data has savings and (synthetic) serving cost, but no full model cost
  (development, data, people). Report savings and serving cost side by side if asked, and say ROI
  needs full cost data; never state an ROI percentage or multiple.
- Targets: the only targets are the serving SLA and the latency SLO (synthetic). "On track"
  means against the SLA (qry_cc_ops_month). There are no savings, budget or business targets: do not
  say savings are on track or behind plan.
- Root cause: quote only RECORDED causes: qry_cc_issues.recorded_cause, qry_model_ops.recorded_causes
  or qry_pipeline_events, as "the recorded cause is ..." with its date and source, and say how many
  of the affected models it is recorded for. When no cause is recorded ("No recorded cause" or
  null), say so and that it needs engineering investigation. Never infer or guess a cause.
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


LAST_HOUR_SQL = (
    "SELECT a.as_of_time, COUNT_IF(p.prediction_time > a.as_of_time - INTERVAL 1 HOUR) AS alerts_in_last_hour, "
    "COUNT(DISTINCT CASE WHEN p.prediction_time > a.as_of_time - INTERVAL 1 HOUR THEN p.model_id END) AS models_alerting_in_last_hour, "
    "MAX(p.prediction_time) AS most_recent_alert, MAX_BY(p.model_id, p.prediction_time) AS most_recent_alert_model, "
    "MAX_BY(p.model_name, p.prediction_time) AS most_recent_alert_model_name "
    "FROM {g}.qry_as_of a LEFT JOIN {g}.qry_anomaly_predictions p ON TRUE GROUP BY a.as_of_time;"
)

# Used when no rules are passed (tests); the deploy passes gold.business_rules_config's values.
DEFAULT_RULES = {"low_confidence_score": 0.60, "low_confidence_model_share": 0.20,
                 "drift_alert_threshold": 0.30, "false_positive_rate_threshold": 0.25,
                 "sla_uptime_target": 0.999, "latency_slo_ms": 200, "psi_drift_threshold": 0.25,
                 "psi_drift_feature_count": 3, "accuracy_drop_watch": 0.05, "accuracy_drop_rollback": 0.10,
                 "stale_model_days": 90, "retrain_overdue_days": 14}


def instructions(rules: dict | None = None) -> str:
    """The instructions with the thresholds written in from business_rules_config, so they can't go stale."""
    r = {**DEFAULT_RULES, **(rules or {})}
    return INSTRUCTIONS_TEXT.format(
        low_confidence_score=f"{r['low_confidence_score']:.2f}",
        low_confidence_model_share=f"{r['low_confidence_model_share']:.0%}",
        drift_alert_threshold=f"{r['drift_alert_threshold']:.2f}",
        false_positive_rate_threshold=f"{r['false_positive_rate_threshold']:.0%}",
        sla_uptime_target=f"{r['sla_uptime_target']:.1%}",
        latency_slo_ms=f"{r['latency_slo_ms']:.0f}",
        psi_drift_threshold=f"{r['psi_drift_threshold']:.2f}",
        psi_drift_feature_count=f"{r['psi_drift_feature_count']:.0f}",
        accuracy_drop_watch=f"{r['accuracy_drop_watch']:.0%}",
        accuracy_drop_rollback=f"{r['accuracy_drop_rollback']:.0%}",
        stale_model_days=f"{r['stale_model_days']:.0f}",
        retrain_overdue_days=f"{r['retrain_overdue_days']:.0f}",
    )


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
        # Always returns a row: the last hour's alerts, and the most recent alert when there were none
        # (the data's last alert is hours before its end, so a plain filter returned nothing).
        ("Which models are flagging anomalies in the last hour?", LAST_HOUR_SQL.format(g=g)),
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
        # One example for every source that had none (2026-10-14), so Genie learns what each is for.
        ("What should we do this week? / What are the action queues?",
         f"SELECT retrain_review_models, retrain_review_high_criticality, investigate_confidence_models, tune_alert_models, "
         f"tune_alert_false_positives AS false_alarms_from_tune_alert_models, unanswered_alert_models, models_with_action "
         f"FROM {g}.qry_cc_actions;"),
        ("Which business units need attention? / Fleet health by business unit",
         f"SELECT business_unit, models, healthy_models, drifting_models, low_confidence_models, models_needing_attention, "
         f"high_criticality_models FROM {g}.qry_cc_health_by_bu ORDER BY models_needing_attention DESC, business_unit;"),
        ("When was the most recent alert? / Show the latest alerts",
         f"SELECT prediction_time, model_id, model_name, site_name, asset_type, predicted_value, unit_of_measure, incident_id "
         f"FROM {g}.qry_anomaly_predictions ORDER BY prediction_time DESC LIMIT 20;"),
        ("What period does the data cover? / What does 'now' mean?",
         f"SELECT window_start, as_of_time, first_day, latest_day, days_in_window FROM {g}.qry_as_of;"),
        ("How do you define a drifting or low-confidence model? / What thresholds do you use?",
         f"SELECT rule_name, threshold_value, notes FROM {g}.business_rules_config ORDER BY rule_name;"),
        # Operations (synthetic serving, cost, drift, retraining and governance data).
        ("Are we on track this month? / Are we meeting the SLA?",
         f"SELECT uptime_mtd, sla_uptime_target, days_left, error_budget_remaining_share, error_budget_burn_rate, projected_uptime, "
         f"outlook_likelihood, requests_mtd, forecast_requests_mtd, requests_vs_forecast, promotions_in_flight, promotions_on_track, "
         f"latency_breach_models, real_time_models FROM {g}.qry_cc_ops_month;"),
        ("How is the fleet distributed across health tiers? / What is the fleet health score?",
         f"SELECT t.tier_order, t.fleet_tier, t.models, t.model_share, t.monthly_cost_usd, t.value_at_stake_usd_month, t.avg_error_change, "
         f"m.fleet_health_score FROM {g}.qry_cc_tiers t CROSS JOIN {g}.qry_cc_ops_month m ORDER BY t.tier_order;"),
        ("What are the top issues? / What is hurting us?",
         f"SELECT issue_rank, severity, headline, evidence, recorded_cause, models_with_recorded_cause, models, value_at_stake_usd_month "
         f"FROM {g}.qry_cc_issues ORDER BY issue_rank;"),
        ("Which models have data drift, on which features, and what is the recorded cause?",
         f"SELECT o.model_id, o.model_name, o.criticality, o.drifted_features, o.max_feature_psi, o.drifted_feature_names, o.recorded_causes "
         f"FROM {g}.qry_model_ops o WHERE o.data_drift_flag = 1 ORDER BY o.max_feature_psi DESC;"),
        ("Which real-time endpoints breached the latency SLO this week, and why?",
         f"SELECT model_id, model_name, criticality, compute_type, latest_p95_latency_ms, week_max_p95_latency_ms, latency_breach_flag, recorded_causes "
         f"FROM {g}.qry_model_ops WHERE latency_breach_week_flag = 1 ORDER BY week_max_p95_latency_ms DESC;"),
        ("What should we do today, this week and this month?",
         f"SELECT horizon, action, reason, models, value_at_stake_usd_month FROM {g}.qry_cc_ops_actions ORDER BY horizon_order, action_order;"),
        ("Where is the extra upside? / What could we save by lever?",
         f"SELECT lever_kind, optimisation_lever, SUM(models) AS models, SUM(potential_saving_usd_month) AS potential_saving_usd_month "
         f"FROM {g}.qry_cc_upside GROUP BY lever_kind, optimisation_lever ORDER BY potential_saving_usd_month DESC;"),
        ("Which models are the top optimisation targets?",
         f"SELECT optimisation_rank, model_id, model_name, fleet_tier, optimisation_lever, potential_saving_usd_month, monthly_cost_usd "
         f"FROM {g}.qry_model_ops WHERE top_target_flag = 1 ORDER BY optimisation_rank;"),
        ("Which models are overdue for retraining, and what is blocking them?",
         f"SELECT model_id, model_name, criticality, last_trained_date, days_since_trained, retrain_cadence_days, "
         f"days_since_trained - retrain_cadence_days AS days_overdue, recorded_causes FROM {g}.qry_model_ops "
         f"WHERE retrain_overdue_flag = 1 ORDER BY days_overdue DESC;"),
        ("Which models have governance gaps, and when is the review deadline?",
         f"SELECT model_id, model_name, criticality, model_card_updated, last_bias_audit, next_audit_due, review_deadline "
         f"FROM {g}.qry_model_ops WHERE governance_gap_flag = 1 ORDER BY next_audit_due;"),
        ("How did fleet uptime and latency trend day by day?",
         f"SELECT serving_date, 1 - SUM(downtime_minutes) / (COUNT(*) * 1440.0) AS fleet_uptime, SUM(requests) AS requests, "
         f"SUM(latency_breach_flag) AS endpoints_over_latency_slo, SUM(cost_usd) AS cost_usd FROM {g}.qry_serving_daily "
         f"GROUP BY serving_date ORDER BY serving_date;"),
        ("What changed in the pipelines? / What recorded events affected the models?",
         f"SELECT event_time, source, event_type, description, issue_type, models_affected, model_ids FROM {g}.qry_pipeline_events "
         f"ORDER BY event_time;"),
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
        # Rules fixed or clarified in the 2026-10-14 review.
        ("Which models are flagging anomalies in the last hour?", LAST_HOUR_SQL.format(g=g)),
        ("How many models are low-confidence, and how many of those are also drifting?",
         f"SELECT SUM(low_confidence_flag) AS low_confidence_models, SUM(CASE WHEN low_confidence_flag = 1 AND drifting_flag = 1 THEN 1 ELSE 0 END) AS also_drifting, "
         f"SUM(CASE WHEN health_status = 'Low confidence' THEN 1 ELSE 0 END) AS low_confidence_status FROM {g}.qry_model_health;"),
        ("Which models have too many false alarms, and which queue is each in?",
         f"SELECT model_id, model_name, alerts, false_positives, false_positive_rate, health_status, recommended_action "
         f"FROM {g}.qry_model_health WHERE high_false_positive_flag = 1 ORDER BY false_positive_rate DESC;"),
        # Operations (synthetic data).
        ("Are we on track to meet the SLA this month?",
         f"SELECT uptime_mtd, sla_uptime_target, days_left, error_budget_remaining_share, error_budget_burn_rate, projected_uptime, "
         f"outlook_likelihood FROM {g}.qry_cc_ops_month;"),
        ("What are the top issues hurting the fleet?",
         f"SELECT issue_rank, severity, headline, evidence, recorded_cause, models FROM {g}.qry_cc_issues ORDER BY issue_rank;"),
        ("How many models are in each fleet tier?",
         f"SELECT fleet_tier, models FROM {g}.qry_cc_tiers ORDER BY tier_order;"),
        ("Which models should we roll back today?",
         f"SELECT model_id, model_name, error_change, first_day_error_pct, latest_day_error_pct FROM {g}.qry_model_ops "
         f"WHERE rollback_flag = 1 ORDER BY error_change DESC;"),
        # Refusal case: the API requires an answer, so this documents the expected
        # refusal; Genie answers without SQL, so the result is marked for manual review.
        ("Will retraining the drifting models fix them, and how much will it save?",
         "SELECT 'No retraining happened in the data, so its effect cannot be measured: list the drifting models, recommend a review "
         "and a controlled comparison, and give no savings figure.' AS Expected_Refusal_Reasoning;"),
    ]


def _id() -> str:
    return uuid.uuid4().hex


def build_serialized_space(gold_schema: str, rules: dict | None = None) -> dict:
    """gold_schema is '<catalog>.<schema>', e.g. 'cnx_automl_dev.lens_mlops_gold'; rules is
    gold.business_rules_config as {rule_name: value}."""
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
            "text_instructions": [{"id": _id(), "content": [instructions(rules)]}],
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
