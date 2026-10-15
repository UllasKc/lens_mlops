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

Configs live in `deploy/config/`: `personal.json` (Free Edition workspace: catalog `cnx_automl_dev`, reusing the account's one Lakebase project with its own `lensmlops` database) and `org-v1.json` (the organisation workspace, version 1: catalog `collectionanalytics1`, warehouse `collectionanalytics`, CLI profile `lenss-mlops-org`, shared with LensS but with its own `lens_mlops_v1_*` schemas, app and Lakebase database). Configs that would carry a real organisation name go in `deploy/config/org*-local.json`, which git ignores. A new organisation workspace or version starts from a copy of `org-v1.json`. Every field, including the optional AI features (semantic cache, guardrails, faithfulness judge, follow-ups, Auto mode, platform questions, conversation memory, evaluations), is described in [SETUP_GUIDE.md section 7](SETUP_GUIDE.md#7-point-the-config-at-your-workspace).

Permissions you need in the workspace: `CREATE SCHEMA` on the catalog, permission to create Genie spaces, Lakebase project creation, and Databricks Apps creation.

## Giving people access

Databricks Apps **cannot** be made public or anonymous. The app is reachable over HTTPS, but every visitor must sign in with a Databricks-recognised identity:

- **People:** add them to the workspace, then grant them `CAN_USE` on the app (or set `readers_group`).
- **Systems / APIs:** a service principal with an OAuth M2M secret can call the app's API. It needs `CAN_USE` on the app **and the `workspace-access` entitlement**.

### Databricks cost (Observability 8)

The cost page shows **this project's** Databricks cost at list price. The deploy's app step creates `gold.qry_platform_cost` over `system.billing.usage` and `system.billing.list_prices` for the app's workspace (its ID is taken from the app URL), and gives every billing row a scope:
- **project:** this project's apps and Genie spaces, counted in full. Every version is one project: `lens-mlops`, `lens-mlops-v2`… and "Lens MLOps Analytics", "… v2"… (`project_family()` in `deploy.py`).
- **other:** other projects' apps and Genie spaces, and other SQL warehouses. None of it is counted.
- **shared:** the SQL warehouse, Lakebase, model serving, storage and the rest. The project's part is worked out **per day**: its share of that day's warehouse query time (queries naming its schemas, from `system.query.history`). It is 0 before the project's first day (its first app or Genie billing day), and days without queries or after the last deploy use the share over the 7 calendar days up to the warehouse's last day with queries (the same days for every project, so the projects' shares never add up to more than 100%). The shares are worked out at deploy time as the person deploying, because query history shows each reader only their own queries, even through a view. The page shows the cost-weighted share over the whole period.

Genie's free allowance (`GENIE_FREE_USAGE`) has no price and is kept at $0. A view runs with its owner's access, so the app needs nothing beyond its SELECT on gold; the person deploying must be able to read the billing tables and query history (if billing can't be read, the deploy warns and the page says the figures aren't available; if query history can't be read, shared services count in full). Anyone with `CAN_USE` on the app can see these figures. The view isn't in the Genie space.

### Idle stop

Databricks Apps never stop on their own and bill while running, so the app stops itself after a stretch with no use. Set it per deployment in the config:

```json
"idle_stop_minutes": 60      // minutes without use before the app stops; null or 0 = never stop
```

The default is 60 (`org-v1.json` 60, `personal.json` 15).
- **Use** means any request from a signed-in person or service principal: opening a page, a question, an evaluation. An answer still streaming, or an evaluation in progress, keeps the app up.
- **Start it again** from Compute → Apps → Start. That needs CAN_MANAGE on the app, so give it to whoever runs demos. Starting takes a few minutes. A deploy starts a stopped app by itself.
- **How it stops:** the app stops itself with its own service principal. The deploy gives that principal CAN_MANAGE on this app only (`server/lib/idleStop.ts`).

## Smoke test

```bash
set LENS_SMOKE_CLIENT_ID=<service principal application id>
set LENS_SMOKE_CLIENT_SECRET=<its OAuth secret>
set PYTHONIOENCODING=utf-8
python deploy/smoke_test.py --host https://<workspace> --app-url https://<app>.databricksapps.com
```

It runs as a real, non-admin identity, which is what catches missing grants. It checks the UI shell, the Auto-mode router, the Command Center and Explorer APIs (the Explorer must reconcile to the Command Center, **every "View models" list must hold exactly the models its card counts**, and every incident's alert list must match its row), Quick-answer and Deep-analysis questions (skip the latter with `--skip-agent`), a session end to end, platform questions, guardrails, the answer cache and Observability.


### Routing test (live conversations)

`deploy/routing_test.py` plays three scripted conversations through the deployed app, the way the browser does (ask the router, then send). They switch between the data and the platform guide, and between Quick answer and Deep analysis. For every turn it checks:
- where the question went, its mode, and escalation;
- the "You asked this before" choice;
- whether the engine was sent the turns it missed;
- that an answer came back.

It uses the same service principal as the smoke test, and real engine calls (several deep analyses, about 10–15 minutes). Run it after a change to routing:

```bash
python deploy/deploy.py --config deploy/config/<config>.json --only routing   # host and app address from the deploy
python deploy/routing_test.py --host https://<workspace>.cloud.databricks.com --app-url https://<app>.databricksapps.com
python deploy/routing_test.py ... --only 2      # one conversation
```

`--only routing` runs only when named; a full deploy never runs it.

The routing evaluation in the app (Observability → Evaluations → Routing) checks the router alone, in about a minute.

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

## Business rules and view descriptions

- **Every threshold is a row in `gold.business_rules_config`** (`deploy/sql/40_gold_config.sql`): the low-confidence score (0.60), the low-confidence model share (20%), drift (0.30) and the false-positive rate for alert tuning (25%). Each row says what it means, why that value, how it measures on the data and which views use it.
  - **Certified and Command Center views** read the values live through `gold.qry_rules`, by `CROSS JOIN` or with `{{live:<rule>}}`, which the deploy expands into a read of `qry_rules`.
  - **Metric views** can't read a table at query time, so the deploy writes the value in (`{{rule:<rule>}}`) and stops if a rule is missing.
  - **The Genie instructions** quote the thresholds; the deploy's `genie` step writes them in from the table.
  - **To change a threshold:** edit its row in `40_gold_config.sql`, then run `--only transform,views,summary,genie,app`. An `UPDATE` on the table changes the certified views at once, but not the metric views or the Genie instructions, and the next transform resets the table to the file.
- **Every gold view has a description** (`COMMENT ON TABLE` / `COLUMN`, next to the view in `deploy/sql/60_certified_views.sql` and `70_command_center_views.sql`; the metric views' `comment:` in their YAML). It gives the business question the view answers (from the source data's questions), its grain, its rules, and when to prefer it over a similar view. Genie and Catalog Explorer read these.
  - **Edit descriptions in the SQL files only:** every deploy re-creates the views, so descriptions typed in Catalog Explorer are lost.
  - **The same goes for the Genie space** (instructions, examples, benchmarks): edit `deploy/genie/space.py`, not the Genie UI.
- **The app follows the same rules.** The model lists behind the Command Center's cards (`server/routes/dashboard.ts`) filter on `qry_model_health`'s flags, which use the rules, and the text that names a threshold (KPI definitions, list descriptions, the model table) shows the value in `qry_rules`, returned with `/api/dashboard/summary`.

## Documentation

| Document | For | What's in it |
|---|---|---|
| [SETUP_GUIDE.md](SETUP_GUIDE.md) | Whoever deploys | Installing tools, configuring a workspace, deploying, updating, troubleshooting |
| [DATABRICKS_IMPLEMENTATION_GUIDE.md](DATABRICKS_IMPLEMENTATION_GUIDE.md) | Engineers | Part A: how Lens MLOps is built on this data, and why. Part B: the platform's engineering history from LensS |
| [CHANGELOG.md](CHANGELOG.md) | Everyone | Every change by version: what, why, what was verified |
| [APP_SERVICE_PRINCIPAL_SETUP.md](APP_SERVICE_PRINCIPAL_SETUP.md) | Special case | Converting an app created in the Databricks UI to service-principal access (`deploy.py` does this automatically) |
| [appkit-genie-app/README.md](appkit-genie-app/README.md) | App developers | The app's structure, API routes and running it locally |
| [Question Routing](https://claude.ai/artifact/5f4tqq53k4eXzLoLb5ZTw1) (web page) | Everyone | How the Assistant sends each question to the platform guide, a Quick answer or a Deep analysis, with worked examples. Written for LensS (collections examples); Lens MLOps uses the same router |
| [Routing Reference](https://claude.ai/artifact/HyZSsXXrSw7f3Z5E4pFTXo) (web page) | Engineers | Every routing, context, cache and guardrail rule with its ID and the function that implements it, diagrams, settings and known limits. Written for LensS as of `router-v1.2`; the rules are the same here, only the data words, the router's prompt and the examples differ |

## Known limits and future work

- **Running the app on more than one server (scale-out).** The app assumes a single server, which is how Databricks Apps runs it today. Two things are kept in that server's memory and would need moving to Lakebase first:
  - **The question router's decision** (`rememberRoute` / `takeRoute` in `server/lib/router.ts`). The browser asks for the route, then sends the question, and the decision is kept in memory for up to 10 minutes in between. If the second request reached a different server, the question would be routed a second time: about 1 s extra and one more model call, and the decision could differ. Fix: store the decision in a short-lived Lakebase table keyed by user and question, or send the decision with the question.
  - **The running evaluation** (`evalRunning` in `server/lib/evals.ts`): "one run at a time" is enforced per server. Fix: check `chatapp.eval_runs` for a run in progress instead.

  The rest (chat history, the usage log, the answer cache with its pre-warm lock, conversation memory) already lives in Lakebase.
