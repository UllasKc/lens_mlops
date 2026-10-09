# Changelog: Lens MLOps

Every change to this project: what changed, why, and what was verified. Newest first. Work not yet committed sits under "Unreleased"; after a commit it moves under a version heading with the date and short commit hash.

## Unreleased

### README: links to the routing pages (2026-10-09)
- The documentation table now links the two routing web pages (Question Routing, for everyone; Routing Reference, for engineers). Both were written for LensS, and the README says so; the rules apply here once the router port below is done.

### Pending: port from LensS (awaiting the user's approval)
Recorded 2026-10-09. Not started: nothing below is implemented until the user approves. Port these LensS commits in order (read each with `git -C D:/LensS_Collections show <hash>`; the LensS CHANGELOG has full detail).
1. **`51b0b83` (tag `router-v1`): conversation-aware question router.**
   - New `server/lib/router.ts`:
     - signals that need no model call: a repeat, a request for more, pushback, platform wording;
     - one Llama 3.3 70B call returning destination, depth, intent, confidence and a standalone rewrite;
     - safety rules;
     - `fixedRoute` for clicks and buttons;
     - `rememberRoute` / `takeRoute`.
   - `autoMode.ts` is reduced to the fallback word rule. `platformHelp.ts` only answers (the DATA_QUESTION safety net, plus `force` for clicked questions).
   - `routes/chat.ts`:
     - `/api/chat/route` for every typed question;
     - sending a question uses its route;
     - `answer.route`;
     - router and context details in the log;
     - routing panel data in `/api/admin/insights`.
   - `chat.js`: a route line while answering; "Go deeper" and "Answer from the data instead" buttons; offers after thin answers and after the judge's completeness check.
   - Observability: routing text in stage 1, and a "How questions were routed" panel.
   - Evals: a Routing category. The `schema.sql` CHECK adds `'routing'`; `cases.py` gets `ROUTING_CASES`, which `deploy.py` counts.
   - Config: `auto_mode` uses `databricks-meta-llama-3-3-70b-instruct`, `timeout_ms` 8000.
2. **`d429661` (tag `context-v1`): conversation context.**
   - `memory.ts`:
     - `engineContext()` passes only the data turns the engine's conversation missed, never guide or blocked turns. The latest pair goes whole, with its first table and query, up to 4,000 tokens; more whole pairs go within 2,500; older ones get one line each with a summarised answer.
     - `historyWindow()` for the router (2,000 tokens) and the guide (1,000): the whole chat when it's under 2,000, otherwise a summary plus the newest whole pairs.
   - `aiConfig.ts` gets `contextBudgets`; `deploy.py` passes the `conversation_memory.*_tokens` settings.
3. **`68457a5` (tag `router-v1.1`): refinements.**
   - The engine gets the person's own words; the rewrite is used only after a guide answer.
   - Asking again: after a weak earlier answer (`weakAnswer()` in `memory.ts`), a fresh deep analysis runs; after a good one, the person chooses (`chooseOnRepeat` / `showEarlierAnswer` in `chat.js`).
   - README: "Known limits and future work" (scale-out).
   - Evals: the `[quick+]` marker and `data:ask`.

**Adaptation when approved:**
- Rewrite the router prompt's domain description and every `ROUTING_CASES` entry for the ML-model data. Keep the same structure: logged-failure style cases, pushback, more/again, guide follow-ups, depth, own setting, languages.
- Keep `MORE_DEPTH`, `PUSHBACK` and `ASKS_NEW` as they are, since they are domain-neutral. `DATA_WORDS` and `UI_WORDS` were already adapted in `c20469b`.
- Verify with the offline rule tests, the routing eval on the personal app, and the smoke test.

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
