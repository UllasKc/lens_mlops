# LensS MLOps

Decision intelligence for a fleet of production ML models, built on Databricks by the Concentrix Data & Analytics Practice. It shows how 100 industrial ML models are doing (confidence, drift, accuracy against actual values, latency), how good their alerts are, and the value attributed to them (downtime avoided, cost savings, yield). Governed bronze → silver → gold data feeds a web app with four tabs:

| Tab | What it does |
|---|---|
| **Command Center** | Two personas (a small menu next to the account icon): **Executive**, the default on every visit, gives plain-language essentials (models, business-critical, service availability, value, status, top risks, decisions, opportunity). **ML Ops practitioner** gives the full technical story: an executive summary (bottom line, where we stand, the fleet, what's hurting us, this week, extra upside), then one story in five chapters: are we on track this month (SLA, volume vs forecast, month-end outlook, error budget, promotions, latency SLO), how healthy is the fleet (KPIs and five tiers), what's hurting us (issues ranked, with the recorded cause), what to do today / this week / this month, and the value delivered plus the upside. Every figure opens the models behind it (and every incident its alerts), with CSV export |
| **Explorer** | Self-service drill-down by business unit, site, asset type, model type, criticality, owner team, health and day, with diagnostic panels and the model records behind each item |
| **Assistant** | Plain-language questions answered by a Genie space ("LensS query engine"): Quick answer, Deep analysis or Auto, with conversation memory, answers about the platform itself, charts, SQL and a quality score |
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

**Synthetic operations data.** The source data has no serving SLA, cost, feature-level drift, retraining dates, promotions, governance records or recorded causes, which the Command Center needs. `deploy/synthetic/ops_data.py` generates them for the same 100 models with a fixed seed (identical on every run and workspace) and consistent with the source data: the 4 models that drift there are the ones with high feature drift, and accuracy uses the source data's own error change. The ingest step generates and lands them; nothing extra is needed on another laptop. Every table and view says "synthetic" in Unity Catalog, the page labels the figures, and the Assistant says so when it uses them.

| Table (`silver.`) | Grain |
|---|---|
| `ops_model_endpoint` | One serving endpoint per model: real-time or batch, GPU or CPU, value at stake, last trained, retraining cadence |
| `ops_serving_daily` | One row per model per day, 8 Sep - 7 Oct 2026: requests vs forecast, downtime, p95 latency, errors, cost, utilisation |
| `ops_feature_drift` | One row per model input feature: PSI at month start and on the latest day, and its feed |
| `ops_promotion` | Candidate versions in staging or canary, with status and blocker |
| `ops_model_governance` | Model card and bias-audit dates per model |
| `ops_pipeline_event`, `ops_event_model` | Recorded pipeline and platform events and the models each affected: the only source of a "recorded cause" |

The ingest checks row counts, and the transform step checks the source data's own quality rules (unique keys, every model registered, one prediction per model per minute, confirmed ≤ predicted, false positives = predicted − confirmed, alerts per hour match the predictions, and so on); a hard rule that fails stops the deploy.

**Thresholds** live in `gold.business_rules_config`, with the reason for each, and the views read them from there: a low-confidence prediction is below 0.60; a model is low-confidence when at least 20% of its latest-day predictions are; a model is drifting when its latest-day average drift is 0.30 or more; alert tuning is suggested above 25% false alarms. The two model-level thresholds were calibrated on the data (an average-confidence cut of 0.60 flags only 1 of 100 models).

Operations rules sit in the same table (20 more): a 99.9% serving SLA, a 200 ms p95 latency SLO for real-time endpoints, PSI over 0.25 on 3+ features for data drift, error up 5% for degrading (10% to roll back), 90 days to stale, 14 days overdue, and the assumptions behind the upside and the health score.

**Limits, stated in the UI and the Assistant:** three days of monitoring data, so no forecasts (the month-end SLA outlook is labelled a projection of recent downtime); no model was retrained, so no claims about what retraining would achieve, and upside figures are estimates on stated assumptions; no full model cost, so savings but not ROI; the only targets are the SLA and latency SLO; and a cause is shown only when a pipeline event is recorded against the models, never inferred.

## Deploy everything with one command

```bash
python deploy/deploy.py --config deploy/config/<your-config>.json
```

That single run, idempotently and in order:

| Step | What it does |
|---|---|
| `schemas` | Creates `<catalog>.lenss_mlops_{bronze,silver,gold,context}` and the `raw_files` volume (and the catalog itself if `create_catalog` is true) |
| `ingest` | Uploads the three CSVs and lands them in bronze, lands the reference sheets of `metadata.xlsx` in context, and generates and lands the synthetic operations data, verifying row counts |
| `context` | Creates the governance tables not in the source files (SQL-generation controls, known limitations, demo question sequence) |
| `transform` | Builds silver (typed, primary keys), runs the data-quality checks, then `business_rules_config`, 2 metric views and the certified views |
| `views` | Builds the Command Center and Explorer views (`qry_cc_*`, `qry_explorer_base`) and the operations views (`qry_model_ops`, `qry_cc_ops_month`, `qry_cc_tiers`, `qry_cc_issues`, `qry_cc_ops_actions`, `qry_cc_upside`, `qry_feature_drift_status`, `qry_serving_daily`, `qry_pipeline_events`) |
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

Configs live in `deploy/config/`: `personal.json` (Free Edition workspace: catalog `cnx_automl_dev`, reusing the account's one Lakebase project with its own `lenssmlops` database) and `org-v1.json` (the organisation workspace, version 1: catalog `collectionanalytics1`, warehouse `collectionanalytics`, CLI profile `lenss-mlops-org`, shared with LensS but with its own `lenss_mlops_v1_*` schemas, app and Lakebase database). Configs that would carry a real organisation name go in `deploy/config/org*-local.json`, which git ignores. A new organisation workspace or version starts from a copy of `org-v1.json`. Every field, including the optional AI features (semantic cache, guardrails, faithfulness judge, follow-ups, Auto mode, platform questions, conversation memory, evaluations), is described in [SETUP_GUIDE.md section 7](SETUP_GUIDE.md#7-point-the-config-at-your-workspace).

Permissions you need in the workspace: `CREATE SCHEMA` on the catalog, permission to create Genie spaces, Lakebase project creation, and Databricks Apps creation.

## Giving people access

Databricks Apps **cannot** be made public or anonymous. The app is reachable over HTTPS, but every visitor must sign in with a Databricks-recognised identity:

- **People:** add them to the workspace, then grant them `CAN_USE` on the app (or set `readers_group`).
- **Systems / APIs:** a service principal with an OAuth M2M secret can call the app's API. It needs `CAN_USE` on the app **and the `workspace-access` entitlement**.
- **People who give demos** start the app after idle stop, which needs `CAN_MANAGE` on the app and read access to its source folder. Set `demo_givers_group` in the config to a group with **Workspace access** only (no SQL, no admin): the deploy gives it `CAN_MANAGE`, and shares the source folder (read-only) with it and everyone else who manages the app. `app_starters` lists any further users or groups who need to start it. Readers keep `readers_group` (Consumer access + `CAN_USE`).

### Databricks cost (Observability 8)

The cost page shows **this project's** Databricks cost at list price. The deploy's app step creates `gold.qry_platform_cost` over `system.billing.usage` and `system.billing.list_prices` for the app's workspace (its ID is taken from the app URL), and gives every billing row a scope:
- **project:** this project's apps and Genie spaces, counted in full. Every version is one project: `lenss-mlops`, `lenss-mlops-v2`… and "LensS MLOps Analytics", "… v2"… (`project_family()` in `deploy.py`).
- **other:** other projects' apps and Genie spaces, and other SQL warehouses. None of it is counted.
- **shared:** the SQL warehouse, Lakebase, model serving, storage and the rest. The project's part is worked out **per day**: its share of that day's warehouse query time (queries naming its schemas, from `system.query.history`). It is 0 before the project's first day (its first app or Genie billing day), and days without queries or after the last deploy use the share over the 7 calendar days up to the warehouse's last day with queries (the same days for every project, so the projects' shares never add up to more than 100%). The shares are worked out at deploy time as the person deploying, because query history shows each reader only their own queries, even through a view. The page shows the cost-weighted share over the whole period.

Genie's free allowance (`GENIE_FREE_USAGE`) has no price and is kept at $0. A view runs with its owner's access, so the app needs nothing beyond its SELECT on gold; the person deploying must be able to read the billing tables and query history (if billing can't be read, the deploy warns and the page says the figures aren't available; if query history can't be read, shared services count in full). Anyone with `CAN_USE` on the app can see these figures. The view isn't in the Genie space.

### Showing only some tabs

A deployment can hide tabs that aren't ready to show, with one config line (hiding only: the APIs behind a hidden tab still answer):

```json
"visible_tabs": ["assistant"]      // any of "home" (Command Center), "explorer", "assistant", "obs" (Observability); null or absent = all four
```

- **What a hidden tab gets:** no button, it can't be opened by any route (the buttons, links between tabs, the Assistant's "Inspect in Observability"), and its data isn't loaded in the background.
- **Opening tab:** the app opens on the first visible tab.
- **Current setting:** `org-v1.json` shows only the Assistant.
- **To bring the tabs back:** remove the line and run `--only app` (about 2 minutes).

### Idle stop

Databricks Apps never stop on their own and bill while running, so the app stops itself after a stretch with no use. Set it per deployment in the config:

```json
"idle_stop_minutes": 60      // minutes without use before the app stops; null or 0 = never stop
```

The default is 60 (`org-v1.json` 60, `personal.json` 15).
- **Use** means any request from a signed-in person or service principal: opening a page, a question, an evaluation. An answer still streaming, or an evaluation in progress, keeps the app up.
- **Start it again** from Compute → Apps → Start. That needs CAN_MANAGE on the app, so give it to whoever runs demos. Starting takes a few minutes. A deploy starts a stopped app by itself.
- **How it stops:** the app stops itself with its own service principal. The deploy gives that principal CAN_MANAGE on this app only (`server/lib/idleStop.ts`).
- **Who can start it again:** starting re-runs the last deployment as the person pressing Start, so they (and the app's service principal) must read the folder the deploy synced to (`/Workspace/Users/<deployer>/apps/<app>`). The deploy shares that folder read-only with the app's service principal, every app manager, the `demo_givers_group` and `app_starters`, one at a time. It logs "Source folder readable by N of M" and names anyone it couldn't share with (for example a user who is no longer in the workspace).

## Smoke test

```bash
set LENSS_SMOKE_CLIENT_ID=<service principal application id>
set LENSS_SMOKE_CLIENT_SECRET=<its OAuth secret>
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

### Org smoke test (organisation workspace only)

The full check of a deployed app, for the organisation workspace. It costs about 40 minutes of real usage (many quick and deep questions, the in-app evaluations, the live conversations), so it refuses to run against the personal workspace.

```bash
python deploy/deploy.py --config deploy/config/org-v1.json --only org-smoke
python deploy/deploy.py --config deploy/config/org-v1.json --only org-smoke --test-args "--sections E,F"         # some sections
python deploy/deploy.py --config deploy/config/org-v1.json --only org-smoke --test-args "--skip-slow"            # about 10 minutes
```

**Workspace checks** run first, as the person deploying:
- **P1:** the app is running and its deployment succeeded.
- **P2:** app permissions: the app's own service principal (for idle stop), the smoke tester and the readers group.
- **P3:** the gold data matches the source data.
- **P4:** every gold object exists and is described.
- **P5:** the metric views use the rules table.
- **P6:** the Genie space answers a question directly.
- **P7:** the Lakebase tables, evaluation cases and cache versions.
- **P8:** the cost view.
- **P9:** the smoke-test credentials.

Then `deploy/org_smoke_test.py` runs against the app as the smoke-test service principal, in sections:

| Section | What it checks |
|---|---|
| A | Access: token, requests without one refused, every script, stylesheet and image the page loads, `/api/me` |
| B | Command Center: the figures add up and match the source data, the rules, every list matches its card, narrowed lists add up, incident alerts, bad and hostile input refused (never a 500), executive summary, cache, and every operations tier, issue, action and lever list matches its figure |
| C | Explorer: reconciles to the Command Center, every business unit adds up, combined and date filters, hostile filter values |
| D | Observability: usage and AI configuration, insights, evaluation cases, Responsible AI data, cost page, suggestions |
| E | The source data's key questions, with facts checked against the app's own figures (health, drift, confidence, savings, value by business unit, false positives, the last hour, low-confidence count, action queues, accuracy), a deep analysis, the answer trace and quality score |
| F | Guardrails and policy: injection, abusive language, personal details, off-topic, a thank-you, and the limits (retraining effect, ROI, forecasts, root cause, contact details) |
| G | The in-app evaluations: routing (42), guardrail, policy and accuracy |
| H | Clicks and buttons: a clicked suggestion, "What can you help me with?", "Answer from the data instead", "Go deeper" |
| I | Live routing conversations: the three from `routing_test.py` plus three for org (short replies aren't attacks, Quick kept with a deep analysis offered, follow-ups keep context) |
| J | Sessions and memory: a chart and the session's name, a follow-up switching mode, history, feedback, the audit trail, rename and delete |
| K | Answer cache and Refresh |

**Statuses:**
- **PASS / FAIL:** the check passed or failed.
- **WARN:** a worded answer or a source-data fact for a person to judge. It doesn't fail the run.
- **SKIP:** not applicable here.

Everything printed is also saved to `deploy/.state/org-smoke-<time>.log`; paste that log when something needs fixing.

### Org routing test (organisation workspace only)

Every routing combination, for the organisation workspace (about 30 minutes; refuses the personal workspace):

```bash
python deploy/deploy.py --config deploy/config/org-v1.json --only org-routing
python deploy/deploy.py --config deploy/config/org-v1.json --only org-routing --test-args "--matrix-only"            # router only, ~10 min
python deploy/deploy.py --config deploy/config/org-v1.json --only org-routing --test-args "--contexts C1,C3 --skip-slow"
```

1. **Routing matrix:** 22 kinds of message × 3 settings (Auto, Quick, Deep) × 4 starting points (a new chat, after a quick data answer, after a deep analysis, after a guide answer). That's about 260 probes. Each starting point is seeded once with a real answer; the probes then only ask the router (`/api/chat/route`), so they cost no query-engine calls. The kinds of message are:
   - data lookups and multi-step "why" questions;
   - app questions;
   - "where is" / "help" with data or with something on screen;
   - short follow-ups, "not enough" and "go deeper";
   - pushback, with and without data words;
   - a repeat and a new question about the answer;
   - "what's the total?" and thanks;
   - Hindi, Spanish, and personal details.

   Each context prints a grid (✓ pass, ✗ fail, ~ warn, · info), with details for anything that didn't pass.
   - **FAIL:** a rule `router.ts` enforces whatever the router model reads was broken. That means a bug in the code or the deployment. The firm rules:
     - after a data answer, "not enough", "go deeper" and pushback give a fresh deep analysis;
     - a repeat gives the choice, or a deep analysis after a weak answer;
     - after an app answer, short follow-ups and pushback that names no data stay with the guide;
     - a question naming model data goes to the data.
     
     For every probe, also: a guide answer is Quick, an escalated answer is Deep, otherwise the Quick or Deep setting is kept, and "deep analysis offered" appears only with Quick. These were checked offline: 59,241 rule checks across every possible model reading, none broken.
   - **WARN:** the router model's judgement where the rules let it decide (for example, whether an app question is recognised).
   - **INFO:** no single right answer; recorded for review.
2. **End to end** (real answers):
   - clicked suggestions in Quick and in Deep;
   - "What can you help me with?" with each setting;
   - a follow-up chip;
   - "Answer from the data instead" with Quick and with Deep selected;
   - "Go deeper";
   - the live conversations (the three from `routing_test.py` and the org smoke test's three).

The log is saved to `deploy/.state/org-routing-<time>.log`.

## Repository layout

| Path | Contents |
|---|---|
| `deploy/deploy.py` | The one-command deploy, including the data-quality checks |
| `deploy/config/` | Workspace configs (see above) |
| `deploy/sql/` | All table/view DDL, templated by catalog and schema prefix |
| `deploy/genie/space.py` | Genie space as code: sources, instructions, examples, benchmarks |
| `deploy/synthetic/ops_data.py` | Seeded generator of the synthetic operations data (run by `ingest`; `python deploy/synthetic/ops_data.py <data_dir> [<out_dir>]` prints a summary) |
| `deploy/lakebase/schema.sql` | Chat history, usage log, answer cache, evaluation and memory tables |
| `deploy/evals/cases.py` | Evaluation cases: ground-truth, red-team guardrail and policy cases (seeded into Lakebase) |
| `deploy/smoke_test.py` | End-to-end test of a deployed app |
| `deploy/routing_test.py` | Live routing conversations through a deployed app |
| `deploy/org_smoke_test.py` | The full org smoke test (organisation workspace only) |
| `deploy/org_routing_test.py` | Every routing combination (organisation workspace only) |
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
| [DATABRICKS_IMPLEMENTATION_GUIDE.md](DATABRICKS_IMPLEMENTATION_GUIDE.md) | Engineers | Part A: how LensS MLOps is built on this data, and why. Part B: the platform's engineering history from LensS |
| [How it works](docs/LensS_MLOps_How_It_Works.png) (diagram) | Everyone, non-technical | Four steps from people to trusted data, the safety on every step, and three promises |
| [Technical architecture](docs/LensS_MLOps_Architecture.png) (diagram) | Engineers, architects | People and access; the app (web UI, API routes, assistant pipeline, app identity); the Databricks services; the medallion pipeline and the 13-step deploy |
| [Agentic architecture](docs/LensS_MLOps_Agentic_Architecture.png) (diagram) | Leaders, architects | The governed request-to-response path: channels, the question router, context and engine selection, governed engines (live and ready to add), execution and governance, the data layer |
| [Command Center walkthrough](docs/LensS_MLOps_Command_Center_Walkthrough.md) | Presenters, leaders | The data (real and synthetic), then every number on the Command Center, top to bottom, with how each is calculated |
| [Logging guide](docs/LensS_MLOps_Logging_Guide.md) | Whoever supports the app | The app's own Lakebase records vs the Databricks app telemetry tables, which to look at for what, and queries for recent errors |
| [CHANGELOG.md](CHANGELOG.md) | Everyone | Every change by version: what, why, what was verified |
| [APP_SERVICE_PRINCIPAL_SETUP.md](APP_SERVICE_PRINCIPAL_SETUP.md) | Special case | Converting an app created in the Databricks UI to service-principal access (`deploy.py` does this automatically) |
| [appkit-genie-app/README.md](appkit-genie-app/README.md) | App developers | The app's structure, API routes and running it locally |
| [Question Routing](https://claude.ai/artifact/5f4tqq53k4eXzLoLb5ZTw1) (web page) | Everyone | How the Assistant sends each question to the platform guide, a Quick answer or a Deep analysis, with worked examples. Written for LensS (collections examples); LensS MLOps uses the same router |
| [Routing Reference](https://claude.ai/artifact/HyZSsXXrSw7f3Z5E4pFTXo) (web page) | Engineers | Every routing, context, cache and guardrail rule with its ID and the function that implements it, diagrams, settings and known limits. Written for LensS as of `router-v1.2`; the rules are the same here, only the data words, the router's prompt and the examples differ |

## Known limits and future work

- **Running the app on more than one server (scale-out).** The app assumes a single server, which is how Databricks Apps runs it today. Two things are kept in that server's memory and would need moving to Lakebase first:
  - **The question router's decision** (`rememberRoute` / `takeRoute` in `server/lib/router.ts`). The browser asks for the route, then sends the question, and the decision is kept in memory for up to 10 minutes in between. If the second request reached a different server, the question would be routed a second time: about 1 s extra and one more model call, and the decision could differ. Fix: store the decision in a short-lived Lakebase table keyed by user and question, or send the decision with the question.
  - **The running evaluation** (`evalRunning` in `server/lib/evals.ts`): "one run at a time" is enforced per server. Fix: check `chatapp.eval_runs` for a run in progress instead.

  The rest (chat history, the usage log, the answer cache with its pre-warm lock, conversation memory) already lives in Lakebase.
