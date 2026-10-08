-- Governance content not in the source files: how SQL must be written, what the data can't answer,
-- and the demo question sequence.
CREATE OR REPLACE TABLE {{catalog}}.{{prefix}}_context.sql_generation_controls (
  control_id INT, control_text STRING
);

INSERT INTO {{catalog}}.{{prefix}}_context.sql_generation_controls VALUES
(1,  'Resolve "now", "right now", "today" and "this week" against the latest prediction in the data (gold.qry_as_of), never the system clock.'),
(2,  'Count models with COUNT(DISTINCT model_id); count predictions with COUNT(*).'),
(3,  'Calculate rates as SUM(numerator)/SUM(denominator), never an average of per-group percentages.'),
(4,  'Never average or sum predicted values, actual values, MAE or RMSE across models with different units of measure; use error_pct to compare models.'),
(5,  'A null actual_value means ground truth has not arrived yet (about 30% of predictions). It is expected, not a data error; exclude nulls from accuracy, never treat them as zero.'),
(6,  'Use the thresholds in gold.business_rules_config (low confidence 0.60, low-confidence model share 0.20, drift 0.30, false-positive rate 0.25).'),
(7,  'incidents_predicted in business outcomes equals the anomaly alerts in predictions for the same model and hour; do not add the two together.'),
(8,  'Report yield improvement only for Reactor and Furnace models; other asset types do not measure yield.'),
(9,  'Label comparisons between models or groups as observed differences, not causes.'),
(10, 'Return a plain limitation message when the data cannot answer a question, rather than approximating.');

CREATE OR REPLACE TABLE {{catalog}}.{{prefix}}_context.known_limitations (
  topic STRING, question_pattern STRING, why_blocked STRING, required_behavior STRING
);

INSERT INTO {{catalog}}.{{prefix}}_context.known_limitations VALUES
('Forecasting', 'Which models will drift next week? / What will savings be next month?',
 'The data covers three days. There is no history long enough to project forward.',
 'Describe the trend inside the window only, and state that a forecast needs a longer history.'),
('Retraining impact', 'Will retraining fix the drift? / How much would retraining save?',
 'No model has been retrained inside the window, so there is no before-and-after comparison.',
 'Recommend a review and a controlled comparison; never give a number for the effect of retraining.'),
('Return on investment', 'What is the ROI of our models?',
 'The data has estimated savings but no model running or development cost.',
 'Report savings (in total, per model, per group) and state that ROI needs cost data.'),
('Targets', 'Are we on track against plan? / Did we hit our savings target?',
 'The data has no targets, budgets or service levels.',
 'Report actual figures only and state that no target is defined in the data.'),
('Root cause', 'Why did this model drift? / What caused the incident?',
 'The data records drift scores and alerts, not their causes or the input features themselves.',
 'Describe when and how much, and which models and sites were involved; say the cause needs engineering investigation.');

CREATE OR REPLACE TABLE {{catalog}}.{{prefix}}_context.demo_query_sequence (
  step_order INT, question STRING
);

INSERT INTO {{catalog}}.{{prefix}}_context.demo_query_sequence VALUES
(1, 'How healthy is our model fleet right now?'),
(2, 'Which models are showing drift this week?'),
(3, 'Which models have confidence below 60% right now?'),
(4, 'What happened with MDL_061? Explain the spike.'),
(5, 'What is total cost savings this week?'),
(6, 'Which business unit delivered the most value?'),
(7, 'Which model version has the highest false positive rate?'),
(8, 'Give me a daily executive briefing: top incident, biggest savings, worst-performing model.');
