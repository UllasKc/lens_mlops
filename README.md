# Lens MLOps

Decision intelligence for a fleet of production ML models, built on Databricks by the Concentrix Data & Analytics Practice. It shows how 100 industrial ML models are doing (confidence, drift, accuracy against actual values, latency), how good their alerts are, and the value attributed to them (downtime avoided, cost savings, yield). Governed bronze → silver → gold data feeds a web app with four tabs:

| Tab | What it does |
|---|---|
| **Command Center** | An executive summary ("the fleet in 30 seconds"), then one story in five chapters: is the fleet healthy, where does it need attention, what is degrading, what to do this week, and what value the models delivered. Every figure opens the models behind it (and every incident its alerts), with CSV export |
| **Explorer** | Self-service drill-down by business unit, site, asset type, model type, criticality, owner team, health and day, with diagnostic panels and the model records behind each item |
| **Assistant** | Plain-language questions answered by a Genie space ("Lens query engine"): Quick answer, Deep analysis or Auto, with conversation memory, answers about the platform itself, charts, SQL and a quality score |
| **Observability** | How the Assistant's answers were made: pipeline traces, answer quality and faithfulness, performance, security and guardrails, Evaluations and Responsible AI |

Every Command Center and Explorer figure comes from certified SQL views; no AI computes them. See [CHANGELOG.md](CHANGELOG.md) for what changed and what was verified.

## The data

The source data sits outside the repository, in `../All_data_and_details/` (set `data_dir` in the config to move it):

| File | Grain | Lands in |
|---|---|---|
| `model_registry.csv` | 100 models | `bronze.model_registry` → `silver.dim_model` |
| `predictions.csv` | 432,000 rows: one per model per minute over three days; about 30% have no actual value yet (expected) | `bronze.predictions` → `silver.fact_predictions` |
| `business_outcomes.csv` | 7,200 rows: one per model per hour (alerts, confirmed incidents, false positives, downtime avoided, savings, yield, action taken) | `bronze.business_outcomes` → `silver.fact_business_outcomes` |
| `metadata.xlsx` | Data dictionary, join keys, sample questions, data-quality rules, reference incidents, enumerations | `context.*` |

The ingest checks row counts, and the transform step checks the source data's own quality rules (unique keys, every model registered, one prediction per model per minute, confirmed ≤ predicted, false positives = predicted − confirmed, alerts per hour match the predictions, and so on); a hard rule that fails stops the deploy.

**Thresholds** live in `gold.business_rules_config`, with the reason for each, and the views read them from there: a low-confidence prediction is below 0.60; a model is low-confidence when at least 20% of its latest-day predictions are; a model is drifting when its latest-day average drift is 0.30 or more; alert tuning is suggested above 25% false alarms. The two model-level thresholds were calibrated on the data (an average-confidence cut of 0.60 flags only 1 of 100 models).

**Limits, stated in the UI and the Assistant:** three days of data, so no forecasts; no model was retrained, so no claims about what retraining would achieve; no model cost data, so savings but not ROI; no targets; and alerts and drift are recorded, not their causes.

## Deploy everything with one command

```bash
python deploy/deploy.py --config deploy/config/<your-config>.json
```

That single run, idempotently and in order:

| Step | What it does |
|---|---|
| `schemas` | Creates `<catalog>.lens_mlops_{bronze,silver,gold,context}` and the `raw_files` volume (and the catalog itself if `create_catalog` is true) |
| `ingest` | Uploads the three CSVs and lands them in bronze, and lands the reference sheets of `metadata.xlsx` in context, verifying row counts |
| `context` | Creates the governance tables not in the source files (SQL-generation controls, known limitations, demo question sequence) |
| `transform` | Builds silver (typed, primary keys), runs the data-quality checks, then `business_rules_config`, 2 metric views and the certified views |
| `views` | Builds the Command Center and Explorer views (`qry_cc_*`, `qry_explorer_base`) |
| `summary` | Writes the executive summary and the time the data was last loaded to `gold.exec_summary` (no LLM) |
| `genie` | Creates or updates the Genie space: sources, instructions, examples, sample questions, benchmarks |
| `lakebase` | Creates or upgrades the Lakebase database: chat history, usage log, answer cache, evaluations, conversation memory |
| `app` | Writes `app.yaml`, creates or updates the Databricks App, binds the Genie space, SQL warehouse and model endpoints, grants the app's service principal read access on gold and access to Lakebase, then syncs and deploys |
| `smoke` | Calls the deployed URL end to end (skipped unless smoke-test credentials are set — see below) |

Re-running is safe. Run part of it with `--only views,summary,app` or `--skip smoke`. Common combinations:

| Situation | Steps |
|---|---|
| App code changed | `--only app` |
| Views, thresholds or Genie changed | `--only transform,views,summary,genie,app` |
| New source data | `--only ingest,transform,views,summary,app` |
| A brand-new workspace | everything (no `--only`) |

### Prerequisites (once per laptop)

1. **Python 3.10+** and the packages: `pip install -r deploy/requirements.txt`
2. **Databricks CLI** on `PATH` (`winget install Databricks.DatabricksCLI` on Windows, `brew install databricks` on Mac). If you only have the one bundled with the VS Code extension, set `DATABRICKS_CLI_PATH` to it.
3. **An authenticated CLI profile:** `databricks auth login --host https://<your-workspace> --profile <name>`. Put the profile name in the config's `profile` field.

Node.js is **not** needed to deploy; Databricks builds the app.

### Configuration

Configs live in `deploy/config/`: `personal.json` (Free Edition workspace: catalog `cnx_automl_dev`, reusing the account's one Lakebase project with its own `lensmlops` database) and `org.json` (template). Organisation configs with real names go in `deploy/config/org*-local.json`, which git ignores. Every field, including the optional AI features (semantic cache, guardrails, faithfulness judge, follow-ups, Auto mode, platform questions, conversation memory, evaluations), is described in [SETUP_GUIDE.md section 7](SETUP_GUIDE.md#7-point-the-config-at-your-workspace).

Permissions you need in the workspace: `CREATE SCHEMA` on the catalog, permission to create Genie spaces, Lakebase project creation, and Databricks Apps creation.

## Giving people access

Databricks Apps **cannot** be made public or anonymous. The app is reachable over HTTPS, but every visitor must sign in with a Databricks-recognised identity:

- **People:** add them to the workspace, then grant them `CAN_USE` on the app (or set `readers_group`).
- **Systems / APIs:** a service principal with an OAuth M2M secret can call the app's API. It needs `CAN_USE` on the app **and the `workspace-access` entitlement**.

## Smoke test

```bash
set LENS_SMOKE_CLIENT_ID=<service principal application id>
set LENS_SMOKE_CLIENT_SECRET=<its OAuth secret>
set PYTHONIOENCODING=utf-8
python deploy/smoke_test.py --host https://<workspace> --app-url https://<app>.databricksapps.com
```

It runs as a real, non-admin identity, which is what catches missing grants. It checks the UI shell, the Auto-mode router, the Command Center and Explorer APIs (the Explorer must reconcile to the Command Center, **every "View models" list must hold exactly the models its card counts**, and every incident's alert list must match its row), Quick-answer and Deep-analysis questions (skip the latter with `--skip-agent`), a session end to end, platform questions, guardrails, the answer cache and Observability.

## Repository layout

| Path | Contents |
|---|---|
| `deploy/deploy.py` | The one-command deploy, including the data-quality checks |
| `deploy/config/` | Workspace configs (see above) |
| `deploy/sql/` | All table/view DDL, templated by catalog and schema prefix |
| `deploy/genie/space.py` | Genie space as code: sources, instructions, examples, benchmarks |
| `deploy/lakebase/schema.sql` | Chat history, usage log, answer cache, evaluation and memory tables |
| `deploy/evals/cases.py` | Evaluation cases: ground-truth, red-team guardrail and policy cases (seeded into Lakebase) |
| `deploy/smoke_test.py` | End-to-end test of a deployed app |
| `appkit-genie-app/` | The app: Node/Express server (`server/`) and static UI (`public/`); see [its README](appkit-genie-app/README.md) |

`SETUP_GUIDE.md`, `DATABRICKS_IMPLEMENTATION_GUIDE.md` and `APP_SERVICE_PRINCIPAL_SETUP.md` are carried over from the LensS template and still describe the collections version in places; they are updated only on request.
