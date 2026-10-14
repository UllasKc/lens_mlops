# Changelog: Lens MLOps

Every change to this project: what changed, why, and what was verified. Newest first. Work not yet committed sits under "Unreleased"; after a commit it moves under a version heading with the date and short commit hash.

## Unreleased

### Fix: Observability stopped loading; per-day cost split; routing test from the deploy (2026-10-14)
Ported from LensS `aac5aeb` (v1.10.1), plus two fixes of our own.
- **Observability stopped loading** (traces empty, panels stuck on "Loading…"). `cost.js` declared a global `renderCost` that replaced `monitoring.js`'s own; `loadMonitoring` then threw before it could hand out its data.
  - `cost.js` is now wrapped in a function, so only `window.loadCost` is global. A chart drawn while its pane was hidden is resized when the pane opens.
  - A scan of the page's 12 scripts finds no other top-level name defined twice.
- **Every Observability area preloads** after the Command Center (Evaluations, Responsible AI and Databricks cost too); opening one still refreshes it.
- **Shared costs split per day** (`platform_cost_view`): each day uses this project's share of that day's warehouse query time, 0 before its first day. This replaces the single share and our first-day fix. The page shows the cost-weighted share (`cost.ts`); before, MAX showed a misleading figure.
- **Our fix: a common window for the default share.** Days with no warehouse queries (10–12 Oct, a weekend) and days after the last deploy use a default share. LensS's version used each project's own "latest 7 days with queries", which covered different periods for the two projects, so on those days the two shares came to 115%. The default now uses the 7 calendar days up to the warehouse's last day with queries, the same days for every project. Measured over that window: Lens MLOps 30.4% + LensS 68.8% = 99.2%.
- **Our fix: LensS leftovers in the UI.**
  - Observability's "Data snapshot: 15 September 2026" was LensS's date; it now shows the monitoring window from the data (5 Oct 00:00 to 7 Oct 23:59 UTC).
  - The Responsible AI limits said "a single snapshot… month-end results" and "strategy comparisons". They now give this data's limits: a three-day window with no forecasts, observed differences rather than causes, no ROI without cost data, and about 30% of predictions without actuals yet.
- **`deploy.py --only routing`** runs the live routing test with the host and app address the deploy already knows. `run_app_test()` is shared with the smoke step. It runs only when named, never in a full deploy.
- **Cost page wording:** "What this project has cost…", and the grants to ask a metastore admin for when billing can't be read.

**Verified on the personal workspace:**
- The real UI ran headless from the local files, with its API calls passed through to the deployed app as the smoke-test service principal. All 8 Observability areas render with live data (602 trace rows, the charts drawn), with no "Loading…" and no page errors.
- Per-day shares: Lens MLOps plus LensS stay at or under 100% on every day both measure.
- Cost through the app equals a direct query on the view.
- Type-check passes; smoke test **30/30**; `--only routing` **15/15** turns.

### Cost page: this project only, every version counted as one (2026-10-14)
Ported from LensS (its per-project cost change and commit `517de69`), plus one fix of our own.
- **Per project, not the whole workspace** (`deploy.py` `platform_cost_view`, `cost.ts`, `cost.js`, CSS). Every billing row gets a scope:
  - project: this project's apps and Genie spaces, counted in full;
  - other: other projects' apps, spaces and warehouses, not counted;
  - shared: warehouse, Lakebase, model serving, storage, counted at the project's share of the warehouse's query time, worked out at deploy time.

  The page shows this project's total, a "What is counted" card, and per-service notes (the share counted for shared services; how much of Genie's usage was free). Prices now use a left join, so Genie's free usage (no list price) is kept at $0 instead of dropped. This replaces the "whole workspace" note from the previous entry.
- **Every version is one project** (`project_family()`): apps `lens-mlops[-vN]`, Genie spaces titled "Lens MLOps Analytics[ vN]", schemas `lens_mlops[_vN]`.
- **Our fix: shared costs count only from the project's first day** (its first app or Genie billing day, 8 Oct here), and the query-time share is measured from that day.
  - Without it, 12% of shared costs from 23 Sep to 7 Oct (before Lens MLOps existed) were counted: $12.42 of a $27.76 total.
  - The share was also diluted by those LensS-only weeks: 12% over all history against 31% since 8 Oct.
  - The "left out" text now says it also includes the other projects' part of the shared services.
- **Genie wording checked on this space's billing:** your own questions in the Genie UI used the free allowance (0.75 units); everything billed (49.3 units, $3.45) was asked as a service principal (the app). So the page says "a free allowance", not "Genie is free".

**Verified on the personal workspace:**
- through the app as the smoke-test service principal: this project **$22.88** of **$248.99** (shared share 31.3%, first day 8 Oct, $0 before it), equal to a direct query on the view;
- `project_family()` maps `-v2` names to the same project;
- the page rendered headless from the live response at 1280 and 390 px with no errors and no sideways scroll;
- smoke test **30/30**.

### Databricks cost page, notifications when minimised, app text follows the rules (2026-10-14)
Ported from LensS (its uncommitted batch after gold-v2), adapted where needed.
- **Observability "8. Databricks cost"** (new):
  - **The view:** `deploy.py`'s new `platform_cost_view()` creates `gold.qry_platform_cost` in the app step. It covers `system.billing.usage` priced with `system.billing.list_prices` at the price in force on each day, filtered to the app's workspace (its ID taken from the app URL). A view runs with its owner's access, so the app reads billing with its existing SELECT on gold; no grant on the system catalog is needed. It is described in Unity Catalog and is not a Genie source. If the person deploying can't read billing, the deploy warns instead of failing.
  - **The route:** `server/routes/cost.ts` (`GET /api/cost`, cached 30 min, `?refresh=1`) serves daily cost by service, the top 12 SKUs and the date range. A missing view or permission returns `available: false`.
  - **The page:** `public/js/cost.js` shows the total since day one with a service-share bar; tiles for this month, the last 7 days, the average per day and the biggest service; a daily stacked chart with a running total; the cost by service and the top SKUs.
  - **Adapted for this app:** the service descriptions, and the note that this is the **whole workspace's** spend. The personal workspace is shared with LensS, so its usage is included; LensS's page assumes a workspace of its own.
- **Notifications when the window is minimised** (`notify.js`):
  - "Away" now also means a window without focus, because some browsers keep a minimised or covered window "visible".
  - `renotify: true` makes a second answer in the same chat alert again.
  - The badge also clears when the window regains focus.
- **App text follows the rules table:**
  - `/api/dashboard/summary` returns `rules` (from `qry_rules`).
  - The KPI definitions, the list descriptions and the model table's "below N%" now show the values in force instead of typed 0.30 / 0.60 / 20% / 25%. This closes the UI gap noted in the gold-v2 port.
  - The model lists themselves already filtered on `qry_model_health`'s flags, so they needed no change.
- **Not ported:** LensS's top-N priority list as a rule. Lens MLOps has no "top N" list: its action list is every model with a next step (19), each in one queue.
- **README:** a "Databricks cost" section, and a line that the app follows the same rules.

**Verified on the personal workspace:**
- the cost view was created by the app step; through the app as the smoke-test service principal, `/api/cost` gives **$248.99** (23 Sep to 14 Oct, 10 services, 12 SKUs), equal to a direct query on the view;
- headless browser checks with stubbed data:
  - unfocused window on the same chat gives a notification (tag kept, `renotify` on) and a "(1)" badge;
  - focused on the same chat gives nothing;
  - the focus event clears the badge;
  - two answers give two notifications;
  - the cost page renders at 1280 and 390 px with no sideways scroll, and the unavailable state explains the setup;
- `/api/dashboard/summary` returns the four rules;
- gold fingerprints: every existing object identical, `qry_platform_cost` added;
- server type-check; smoke test **30/30**.

### Gold layer and Genie review, ported from LensS gold-v2 (2026-10-14)
Ported from LensS commit `f079f41` (tag `gold-v2`): audited against this data first, gaps filled, no collections content copied.
- **Every threshold is data.** `deploy.py` gains the LensS templating:
  - `run_file(path, cfg, rules)`: `{{live:<rule>}}` becomes a live read of `gold.qry_rules`; `{{rule:<rule>}}` writes the table's value into SQL that can't read a table, and a missing rule stops the deploy.
  - `business_rules()`.
  - `step_transform` runs silver, the quality checks and `40_gold_config.sql`, reads the rules, then runs 50/60 with them; `step_views` passes them to 70.
  - The `genie` step writes them into the Genie instructions, which quoted the numbers by hand.

  Audit: the certified and Command Center views already read all four rules through `qry_rules`. The two metric-view measures that repeated 0.60 now use `{{rule:low_confidence_score}}`. The other literals in the views are category values (Reactor/Furnace for yield, Ignored/No Action for unanswered alerts, criticality High) or statistics (p95), not thresholds, and there are no business `LIMIT`s. SQL control 6 no longer types the values.
- **Rules checked against the data** (the LensS R09 lesson). All four fire, measured:
  - drift 0.30: 4 models at 0.51 against a fleet near 0.10, next highest 0.102; per day 0, 4, 4;
  - low-confidence share 20%: 12 models (lowest 21.2%), next 19.3%, so it's sensitive;
  - false-positive rate 25%: 4 of the 5 alerting models.

  Each measurement is in its rule's note in `business_rules_config`. Two count gaps the instructions didn't explain are now stated:
  - 12 models are flagged low-confidence but 11 show that status, because MDL_088 is drifting too;
  - 4 models are over the false-alarm rate but the tune-alert queue holds 3, because drift goes first.

  "Unanswered" (Ignored or No Action on an alert hour) is now defined; in this data only one hour, on MDL_061, qualifies.
- **The R09 equivalent here:** the Genie example "Which models are flagging anomalies in the last hour?" returned no rows (the last alert is 16:19, the data ends 23:59). It now always returns a row: the alerts in the last hour plus the most recent alert and its model. A benchmark covers it.
- **A description on every gold object.** `COMMENT ON TABLE` / `COLUMN` next to each certified and Command Center view, and the metric views' YAML `comment:`. Each gives the business question it answers, its grain and rules, and when to prefer it. `business_rules_config` and `qry_rules` are described too.
- **Genie space:**
  - an example for every source: 25 examples (5 new: action queues, health by business unit, latest alerts, the window, the thresholds);
  - a "WHICH VIEW ANSWERS WHICH QUESTION" section;
  - the count and "last hour" rules;
  - 3 new benchmarks (11 in all).
- **Router:** with Quick chosen, when the model reads a multi-step question, the answer stays Quick and a deep analysis is offered (`suggestDeep` in `router.ts`, `answers.ts`, `chat.ts`, `chat.js`; `:suggest` in `evals.ts`). There's one new routing case for this data (40 in all).
- **Tests:** `smoke_test.py` and `routing_test.py` write UTF-8, so an emoji in an answer can't crash them on a Windows console.
- **README:** "Business rules and view descriptions".
- **Not changed:** the KPI-definition text in the app (UI wording) still states the values.

**Verified on the personal workspace:**
- gold fingerprints (row count + md5 of sorted, normalised rows) before and after: 17 of 19 identical; the two differences are intended (`business_rules_config` notes, `exec_summary` timestamp);
- a live rule change: drift 0.10 moved the Command Center from 4 to 51 drifting models and the daily trend with it; restoring 0.30 brought back 4;
- 19 of 19 gold objects described in Unity Catalog;
- all 36 example and benchmark SQL statements return rows (the refusal excepted);
- server type-check; offline rule tests 11/11; routing eval **40/40**; smoke test **30/30**; live routing test (`routing_test.py`) **15/15** turns;
- live Genie questions pick the intended views: "last hour" → the new query (0 alerts, most recent MDL_088 at 16:19); low-confidence → 12 models, 1 also drifting; action queues → `qry_cc_actions`. That last answer first called the 114 false alarms "114 models", so every count column of `qry_cc_actions` is now described (models, alerts or hours) and the example aliases the column; asked again, it reads "114 false alarms".

### Live routing test (2026-10-09)
`deploy/routing_test.py` (documented in the README under Smoke test), ported from LensS with conversations written for this data. Three scripted conversations run through the deployed app the way the browser does (ask the router, then send), switching between the data and the platform guide and between Quick answer and Deep analysis:
1. **Data, the guide and back:** data → guide → "tell me more" → data (deep) → a follow-up → "not enough".
2. **Your own setting:** Quick kept for a "why", Deep kept, an app question mid-conversation, "No, you do it" staying with the guide, "just show me the numbers for that site" going to the data, a Quick follow-up.
3. **Asking again:** the choice, "Show the earlier answer", "Run a deep analysis".

Every turn checks where the question went, the mode, escalation, the choice, whether the engine was sent the turns it missed, and that an answer came back. It uses the `LENS_SMOKE_*` service principal and real engine calls (about 10–15 minutes).
- **Verified on personal: 15/15 turns.** The engine never received guide turns. Each engine conversation got only the turns it missed.

### README: links to the routing pages (2026-10-09)
- The documentation table now links the two routing web pages (Question Routing, for everyone; Routing Reference, for engineers). Both were written for LensS, and the README says so; the rules apply here once the router port below is done.

### Question router, conversation context and routing fixes, ported from LensS (2026-10-09)
Ported LensS `router-v1` (51b0b83), `context-v1` (d429661), `router-v1.1` (68457a5) and `router-v1.2` (fcbb1e2) by a three-way merge per file:
- **base:** LensS `cd89dac`, already here as c20469b;
- **theirs:** LensS `fcbb1e2`;
- **ours:** this repository.

Lens MLOps names were kept: `LENS_AI_CONFIG`, `lens:` events and storage keys, "Lens MLOps", "model data". A partial earlier attempt was stashed, not discarded (`git stash list`: "Partial router port by the MLOps session").
- **Question router** (`server/lib/router.ts`, new):
  - **Signals with no model:** a repeat, asking for more, pushback, platform wording.
  - **One Llama 3.3 70B call:** destination, depth, intent, confidence and a standalone rewrite.
  - **Safety rules:**
    - asking for more → a fresh deep analysis;
    - asking again → a fresh deep analysis after a weak answer, otherwise the person chooses "Run a deep analysis" or "Show the earlier answer";
    - pushback never gets the guide twice, except pushback on a genuine app answer, which stays with the guide;
    - the guide is used only when the model is sure;
    - your Quick/Deep choice is kept unless you ask for more.
  - **Word-rule fallback** when the model is unavailable.
  - **The router's prompt is written for this data:** the fleet of industrial ML models, with drift, confidence, alerts, sites, business units and MDL ids as examples.
- **Conversation context** (`server/lib/memory.ts`):
  - **Genie** gets only the data turns its own conversation missed, never guide turns: the latest missed pair whole with its table and query (up to 4,000 tokens), then whole pairs within 2,500, then older ones as one line with a summarised answer. Otherwise it gets the person's own words.
  - **The router and the guide** get the whole chat when it is small, else the summary plus the newest whole pairs (2,000 and 1,000 tokens).
  - **Budgets** are settings under `conversation_memory`.
- **Assistant:**
  - the route line while answering;
  - **Go deeper** on thin or incomplete Quick answers;
  - **Answer from the data instead** on guide answers;
  - the "You asked this before" choice;
  - Regenerate and Try again re-ask the same question in the same mode (Regenerate on a guide answer asks the guide again).
- **Observability:** router and context details on every trace (stage 1), and a "How questions were routed" panel in Performance.
- **Evals:** a new **Routing** category, 39 cases written for this data. They cover:
  - data questions that sound like the app;
  - app questions;
  - pushback after misrouted and genuine guide answers;
  - asking for more and asking again (after weak and good answers);
  - a different site not being a repeat;
  - depth for new questions and follow-ups, and your own setting;
  - Hindi and Spanish.

  `schema.sql` accepts the category.
- **Config:** `auto_mode` is Llama 3.3 70B with an 8 s timeout in `personal.json` and `org.json`.
- **Also fixed here:** the memory summariser's prompt still named collections terms ("products, regions, arrears buckets"). It now says models, sites, business units and asset types.
- **Repeat signal fix** (also made in LensS): two questions that each have a word the other lacks ("…at Houston" / "…at Phoenix") are different questions, not a repeat. They used to escalate to a deep analysis.
- **README:** "Known limits and future work" (running on more than one server).
- **Verified:**
  - offline rule tests (35, rewritten with this data's terms);
  - server type-check;
  - browser scripts parse;
  - the deploy's lakebase step seeded 39 routing cases;
  - on the personal app: routing eval **39/39** with the real router model (about 1.2 s a decision), smoke test **30/30**.

### Assistant routing: data questions go to the query engine; clicked questions skip routing (2026-10-09)
Ported from the LensS sibling project (its commit `cd89dac`), adapted to the model data, so both products keep the same capabilities.
- **Loose platform words no longer capture data questions** (`server/lib/platformGuide.ts`). A question with only a loose word ("where is", "help") that names model data now goes to the query engine, unless it also names something on screen. `DATA_WORDS` (model vocabulary: models, predictions, drift, confidence, alerts, incidents, error, accuracy, sites, business units, asset types, criticality, owner teams, savings, value, days, figures…) moved here and is exported, and `UI_WORDS` is new (tab, page, button, filter, menu, export, download, Explorer, Assistant, Observability…). In LensS the small platform model had answered a data question from the guide with made-up steps.
- **Pushback ends the platform loop** (`server/lib/platformHelp.ts`). "You do it", "just tell me", "show me the numbers" after a platform answer go to the engine with the conversation as context. `answerPlatform(…, force)` always answers a clicked platform question from the guide.
- **Clicked questions skip routing** (`public/js/chat.js`, `server/routes/chat.ts`). Suggestions, Ask Lens buttons and follow-up chips are sent with `preset: true`: straight to the engine in their own mode, or straight to the guide when their wording is about the platform. Chips use the mode of the answer they follow.
- **Verified:** server type-check passes. 14 routing cases pass: 3 data questions with loose words, 7 platform questions (including "What does Observability show about drift?"), "Tell me more" and "Can you explain that?" after a platform answer, pushback, and a plain data question. All 37 clicked questions in the app were classified: only "What can you help me with?" goes to the guide.

### Fix: "Turn on" notifications gave no feedback and the banner never closed (2026-10-08)
- **Cause:** the banner closed only when the browser's permission prompt settled. A quiet prompt (an icon next to the address), a suppressed prompt, or a framed page can leave that promise pending forever, so after **Turn on** nothing visible happened. Older Safari also returns no promise, so `.finally` would throw.
- **Fix** (`public/js/notify.js`, `public/css/style.css`): on click the buttons are disabled and the banner says to choose "Allow" in the browser's prompt. The outcome is then shown in the banner (on / blocked / still off, with where to change it), and the banner closes 4 s later. If the browser never answers, it reports after 15 s. Both the promise and the callback forms of `requestPermission` are handled.
- **Verified:** a headless test of the real `notify.js` with four simulated browsers (allow, block, a prompt that never answers, callback-only): every case shows feedback, closes, and throws no errors.

### Guides updated for Lens MLOps (2026-10-08)
- **`SETUP_GUIDE.md`:** names, schemas, configs and profiles; the source-data folder next to the project (`data_dir`); the new deploy output and the data-quality failure message; the Command Center and Explorer tour; guardrail, cache and judge wording; smoke test (30 checks, the `lens-mlops-smoke-tester`, keeping its secret with `setx`); troubleshooting for missing source files and failed quality rules; local development on Windows; the features table.
- **`DATABRICKS_IMPLEMENTATION_GUIDE.md`** (1,734 → 655 lines): **Part A** is new and covers Lens MLOps (features, the data and the facts that shaped the design, architecture, ingest, quality checks, thresholds and their calibration, gold views, Genie, testing, lessons, limits). **Part B** keeps the LensS Steps 8–8k (app, Genie modes, Lakebase, caching, guardrails, judge, Observability, deploy) as the platform's engineering history, labelled as using the collections data. The obsolete collections build steps, synonym table and limitations appendix were removed, along with a line naming a real person's email address.
- **`APP_SERVICE_PRINCIPAL_SETUP.md`:** Genie space and gold schema names.

## v2.0.0 — 2026-10-08 (`6eb7532`)

### Adapted to the ML-model data (2026-10-08)
**What:** the template now runs on the source data (100 models, 432,000 minute-level predictions, 7,200 hourly business outcomes, `metadata.xlsx`) instead of the collections workbook. All collections code, views, wording and questions are gone, and "LensS" is renamed to Lens MLOps everywhere user-facing, including env vars (`LENS_*`), browser storage keys and export file names.
- **Data:** `step_ingest` lands the three CSVs (read from `../All_data_and_details`, kept out of git) and seven `metadata.xlsx` sheets; the source's brand name is stripped from the metadata on the way in. Silver has `dim_model`, `fact_predictions` and `fact_business_outcomes` with primary keys. The transform runs the source data's 13 quality rules on silver and stops on a hard failure.
- **Thresholds** in `business_rules_config`, read by the views through `qry_rules` (in LensS the values were repeated in each view): low-confidence prediction < 0.60 (from the source data's questions); low-confidence model ≥ 20% of latest-day predictions; drifting ≥ 0.30 latest-day average drift; alert tuning > 25% false alarms. The two model thresholds were calibrated on the data, because an average-confidence cut of 0.60 flags only 1 model.
- **Gold:** metric views `mv_model_predictions` and `mv_business_outcomes`; certified views for model health, hourly signals, incidents (consecutive alert hours), alerts, latest readings, daily trend, and value by business unit, site and criticality; Command Center views (`qry_cc_kpis`, `qry_cc_health_by_bu`, `qry_cc_actions`) and `qry_explorer_base` (model × day). Error is compared as a share of actual values per model, because models predict in different units. The as-of point is the latest prediction in the data, not a hard-coded date.
- **Command Center:** no targets exist in the data, so the story is fleet health, not "vs plan": 1 is the fleet healthy, 2 where it needs attention, 3 what is degrading, 4 four action queues plus every model with a next step, 5 the incidents and the value delivered, with an executive summary. "View models" and "View alerts" replace "View accounts".
- **Explorer:** filters by business unit, site, asset type, model type, criticality, owner team, health and day; slicer, business unit × asset type grid, health and criticality, accuracy, day by day, value by site and model records.
- **Genie space:** 16 sources, new instructions (no forecasts, no retraining effects, no ROI, no targets, no root causes, unit rules), 20 certified examples and 8 benchmarks built from the source data's sample questions. All 28 SQL statements were run against the warehouse.
- **AI layer:** guardrail classifier, block messages and policy checks for this domain (the cure-rate check is now an ROI-claim check; US phone numbers are now detected); auto-mode, follow-up, title, platform-help and empty-result prompts; the answer cache's matching details; the judge ignores model numbers, site numbers, versions and clock times. 29 evaluation cases (8 accuracy, 14 guardrail, 7 policy).
- **Smoke test:** new questions, and new checks that every "View models" list matches its card and every incident's alert list matches its row.

**Verified:** data steps deployed to the personal workspace (all quality rules pass; 4 drifting and 12 low-confidence models, $48.3M savings, as in the local analysis). Server type-check passes. Guardrail policy cases all pass, with no false positives on incident IDs, dates or figures. Local browser pass of every tab: no console errors, lists match their cards (4, 12, 3, 19 models; 240 alerts), Explorer drill-down works, no sideways scroll at phone width after wrapping two Explorer tables. App deployed to https://lens-mlops-7474660150071734.aws.databricksapps.com; its APIs answer as the app's service principal, and one Genie question and one platform question work end to end. Smoke test **30/30** as a new non-admin service principal, `lens-mlops-smoke-tester` (CAN_USE on the app and workspace-access only; its secret is in the deploying user's environment as `LENS_SMOKE_CLIENT_ID/SECRET`). A first run had one Deep-analysis failure: Genie's Agent returned `internal_error` before running any SQL. The same question then succeeded, and the full re-run passed.

### Project set up from the LensS template (2026-10-08)
- **Copied** the LensS Collections Intelligence platform (v1.9.2 plus its executive summary) as the starting template:
  - the app (`appkit-genie-app/`);
  - the deploy tooling (`deploy/`: deploy script, SQL, Genie space as code, Lakebase schema, evaluation cases, smoke test);
  - `README.md`, `SETUP_GUIDE.md`, `DATABRICKS_IMPLEMENTATION_GUIDE.md`, `APP_SERVICE_PRINCIPAL_SETUP.md`.
  
  Not copied: the collections data and documents, deploy state, the generated `app.yaml`, the workspace configs and the LensS changelog.
- **New configs** `deploy/config/personal.json` and `org.json` with distinct resource names (schema prefix `lens_mlops`, app `lens-mlops`, Genie space "Lens MLOps Analytics", Lakebase database `lensmlops`), so a deploy can't overwrite LensS in a shared workspace. On the Free Edition workspace it reuses the one allowed Lakebase project, with its own database.
- **`CLAUDE.md`:** the project playbook (working rules, platform, adaptation checklist, quality bar, lessons).
- **Not yet adapted:** the code, views, Genie space, UI wording and docs are still the collections versions. Next: study the new data in `../All_data_and_details/` and agree the mapping (see `CLAUDE.md` section 4).
