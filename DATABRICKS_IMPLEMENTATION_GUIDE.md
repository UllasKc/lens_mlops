# Lens MLOps — Databricks Implementation Guide

*How Lens MLOps is built, in order, and why. Part A describes this product on its data. Part B is the engineering history of the platform it reuses (built for LensS Collections Intelligence), kept because the app, caching, guardrails and deploy work the same way; its examples use the collections data. For deploying, follow `SETUP_GUIDE.md`; for what changed in each version, `CHANGELOG.md`.*

# Part A — Lens MLOps

## Feature catalogue: what was built and why

### Data foundation

| What | Why |
|---|---|
| Bronze → silver → gold → context layers in Unity Catalog (`<catalog>.lens_mlops_*`) | Raw data is kept as received, cleaned once, and served in a governed form |
| Ingestion of the three source CSVs (bronze) and seven reference sheets of `metadata.xlsx` (context), with row-count checks; the source's brand name is stripped from the metadata | The data loads the same way every time, and a short load is caught |
| The source data's 13 quality rules checked on silver at every transform | Bad data stops the deploy instead of reaching the dashboards |
| Thresholds as data (`business_rules_config`), read by every view through `qry_rules`, each with the reason for its value | One place to change a rule; every figure moves with it |
| 2 metric views + certified views (model health, hourly signals, incidents, alerts, latest readings, daily trend, value by business unit / site / criticality) | Each measure is defined once, and the AI answers from approved sources only |
| Command Center and Explorer views (`qry_cc_kpis`, `qry_cc_health_by_bu`, `qry_cc_actions`, `qry_explorer_base`) | The dashboard and the AI read the same governed figures |
| Executive summary written from the certified views (no AI) | The headline is accurate and costs nothing to generate |

### AI query engine (Genie, presented as the "Lens query engine")

| What | Why |
|---|---|
| Genie space as code: 16 sources, instructions, 20 examples, 8 sample questions, 8 benchmarks, built from the source data's 13 demo questions | Rebuilt identically in any workspace; the demo questions answer consistently |
| Instructions: "now" is the end of the data, thresholds, unit rules, no forecasts, no retraining effects, no ROI, no targets, no root causes, no process topology | Answers stay inside what three days of model telemetry can support |
| Quick answer, Deep analysis and Auto; conversation memory; platform answers; empty-result notes | Reused unchanged from the platform (Part B) |

### The app

| What | Why |
|---|---|
| Command Center as one story in five chapters: is the fleet healthy → where it needs attention → what is degrading → what to do this week → what value was delivered, each opening with its answer in one sentence | A presenter can tell it top to bottom, and each figure appears once |
| No "vs target" framing | The data has no targets; fleet health is the honest headline |
| Executive summary: a bottom line and one line per chapter | The fleet in 30 seconds |
| **View models** on every card, issue, queue and panel; **View alerts** on every incident (same rule and count as the figure, CSV export) | No number is a dead end |
| Action queues: each model in one queue only (drift → low confidence → false alarms → unanswered alerts) | A plan with no double counting |
| Explorer: business unit, site, asset type, model type, criticality, owner team, health and day filters; 12 tiles against the fleet; slicer; business unit × asset grid; health; accuracy; day by day; value by site; model records | Self-service "where and why" that reconciles to the Command Center |
| KPI dictionary (15 definitions) | Anyone can check exactly how a figure is calculated |
| Limits stated on the page (no forecasts, no ROI, no targets) | Leaders aren't misled by what the data can't say |

Speed and cost, safety, answer quality, evaluation, Observability, branding, security and deployment work as described in Part B; the domain-specific parts (guardrail wording, policy checks, cache matching, judge rules, evaluation cases, suggested questions) were rewritten for this data and are listed in the CHANGELOG.

## The data

The source data (outside git, in `../All_data_and_details`) is a three-day monitoring window of 100 industrial ML models.

| File | Grain and keys | Notes |
|---|---|---|
| `model_registry.csv` | 100 rows, one per `model_id` | Business unit (5), site (8), asset type (7), model type (3), criticality (High 19 / Medium 53 / Low 28), owner team (5), version, prediction target and unit of measure (°C, m²K/W, EER, %, index, probability) |
| `predictions.csv` | 432,000 rows: 100 models × 4,320 minutes; key (`timestamp`, `model_id`) | Predicted and actual values (actual null for about 30%: ground truth arrives later), confidence, anomaly flag, drift score, latency |
| `business_outcomes.csv` | 7,200 rows: 100 models × 72 hours; key (`date_hour`, `model_id`) | Alerts (`incidents_predicted`), confirmed incidents, false positives, downtime avoided, savings, yield, action taken |
| `metadata.xlsx` | 8 sheets | Data dictionary, join keys, 13 demo questions by persona, 12 quality rules, 5 reference incidents, enumerations |

Facts that shaped the design, each verified against the data:

- **`incidents_predicted` is exactly the hour's count of `anomaly_flag = true`** (690 = 690). The two tables are a deterministic rollup, so never add them together.
- **Only 14 of 7,200 outcome rows are non-zero**, spread over 5 incidents on 5 models. All value ($48.3M, 1,279 hours of downtime avoided) comes from those incidents, and one of them (Reactor Yield Forecaster #61, New York 1) is 89% of it.
- **4 models drift**, their average drift score rising from 0.14 to 0.51 over the three days; everything else stays near 0.10.
- **Units differ by model**, so errors can't be pooled across models.
- **There are no targets, no model costs, and no retraining events**, so the product makes no "vs plan", ROI or retraining-effect claims.

## Architecture

The platform pattern is unchanged from LensS (Part B): governed data → certified views → a story-led Command Center, an Explorer, a governed Genie assistant and Observability, deployed by one command. Why layers:

- **Bronze** keeps the files as received.
- **Silver** is the one typed, constrained version: `dim_model`, `fact_predictions`, `fact_business_outcomes`, with primary keys and column comments (Genie reads them). Plain site names (`Houston 1`) are derived from the codes so no internal codes need to appear on screen.
- **Gold** has three kinds of object: **metric views** for measures sliced any way, **certified views** for logic that must be fixed (health rules, incident grouping, action queues), and a **config table** for thresholds.

## Step 1 — Ingest (`deploy.py`, step `ingest`)

1. Upload each CSV to the `raw_files` volume and create `bronze.<table>` with `read_files(..., inferSchema => true)`. Check the row count against the file's line count.
2. Read `metadata.xlsx` with pandas and keep the rows that have a value in each sheet's key column (this drops the ER-diagram text and note rows). Make the column names SQL-safe, strip the source brand name (taken from the README sheet's title, so the code never names it), write one CSV per sheet, and land each in `context`.

## Step 2 — Silver and the quality checks (`30_silver.sql`, `deploy.py` `check_quality`)

Explicit casts, primary keys and comments. Then the 13 checks, which mirror `metadata.xlsx`'s quality rules: unique model IDs in the right pattern, every prediction and outcome belongs to a registered model, predictions on exact minutes, one per model per minute and none missing, confidence and drift between 0 and 1, `prediction_error = actual − predicted`, confirmed ≤ predicted, false positives = predicted − confirmed, one outcome per model per hour, alerts per hour match the predictions, and (soft) yield only for reactors and furnaces. A hard failure stops the deploy.

## Step 3 — Thresholds (`40_gold_config.sql`)

| Rule | Value | Why |
|---|---|---|
| `low_confidence_score` | 0.60 | Stated in the source data's demo questions ("confidence below 60%") |
| `low_confidence_model_share` | 0.20 | **Calibrated.** Applying 0.60 to each model's average confidence flags 1 of 100 models. A model is low-confidence when at least 1 in 5 of its latest-day predictions are below 0.60: 12 models, with a clear drop below (next model 19%) |
| `drift_alert_threshold` | 0.30 | **Calibrated.** Drifting models average 0.51 on the latest day; nothing else exceeds 0.11 |
| `false_positive_rate_threshold` | 0.25 | 1 in 4 alerts false; the fleet rate is 26% |

The same lesson as LensS's over-contact rule: **query a threshold against the data before trusting it.** `qry_rules` pivots the table into one row; views `CROSS JOIN` it. Metric views can't join a config table, so the 0.60 appears once in `mv_model_predictions` with a comment pointing at the rule.

## Step 4 — Gold views (`50_metric_views.sql`, `60_certified_views.sql`, `70_command_center_views.sql`)

- **As of:** `qry_as_of` takes the window from the data (`MAX(prediction_time)`), so nothing is hard-coded to a date. "Latest day" is that date.
- **`qry_model_health`** (one row per model) is the centre: window-level confidence, latest-day confidence and low-confidence share, first- and latest-day drift, alerts and outcomes, accuracy (MAE, RMSE and **error % = Σ|error| ÷ Σ|actual|**, unit-free), latency, the flags, `health_status` (Drifting > Low confidence > Healthy), and `recommended_action` with `action_order`, which puts each model in exactly one queue.
- **`qry_incidents`** groups consecutive alert hours per model (gaps and islands), with start and end from the alert minutes, responses in order, unanswered alerts, and the predicted level during the incident against normal. The incident ID is `MDL_061 2026-10-07 03:40`; a compact `…-20261007-0340` form was rejected because the PII check reads it as a national ID number.
- **`qry_explorer_base`** is one row per model per day holding sums, not ratios. The Explorer aggregates per model first, then per group, so rates are sum/sum and error % is the average of models' own values; with no filters it reconciles exactly to the Command Center.
- **Error across models:** pooling Σ|error| ÷ Σ|actual| across models is dominated by temperature-scale models (every business unit comes out near 0.7%). Group figures therefore average per-model values, and the metric view's comment says so.

## Step 5 — Genie (`deploy/genie/space.py`)

Sources: the two metric views, `business_rules_config` and 13 certified and Command Center views (`qry_explorer_base` is left out: its partial sums invite wrong averages). The instructions carry the definitions and refusals listed in the feature catalogue. Examples and benchmarks start from the source data's 13 demo questions. Notes on the harder ones:

- *"Which models are flagging anomalies in the last hour?"* correctly returns nothing (no alerts in the data's last hour); the empty-result note explains it.
- *"Correlated anomalies between compressors and downstream reactors"*: alerts are compared by site and hour, and the instructions say the data holds no process topology.
- *"ROI of High vs Low criticality"*: answered as savings per model, with the statement that ROI needs cost data.
- The refusal benchmark is about retraining effects (no retraining in the data).

All 28 example and benchmark SQL statements were executed against the warehouse before the space was deployed.

## Step 6 — Testing

- **Deploy-time:** row counts, the 13 quality checks, and a sanity line (4 drifting, 12 low-confidence models).
- **Guardrails:** the policy cases and false-positive checks run locally against `checkOutput`/`inputPatterns`.
- **Browser pass** (headless Chrome): every tab at desktop and phone width, console errors, sideways scroll, and the drill-through windows against their cards.
- **Smoke test** (`deploy/smoke_test.py`, 30 checks) as a non-admin service principal, including two checks specific to this build: **every "View models" list holds exactly the models its card counts** (13 lists), and **every incident's alert list matches its row**.

## Lessons from this adaptation

- **Calibrate thresholds on the data.** The confidence threshold from the source's own questions finds almost nothing at model level; the useful rule is about the share of low-confidence readings.
- **Watch units.** A fleet-wide MAE or pooled error % looks precise and means nothing when models predict in °C and probabilities.
- **Format times in SQL.** The warehouse returns timestamps as UTC ISO strings; formatting them in SQL (`date_format`) shows the data's own times and stops the browser shifting them by the viewer's time zone. The deploy parses `2026-10-07T23:59…` (with a `T`).
- **Identifiers can trip PII patterns.** Date-stamped IDs with long digit runs match national-ID patterns; choose readable IDs and test them against the guardrails.
- **Keep the data out of git** and point the deploy at it (`data_dir`). The 35 MB predictions file doesn't belong in the repository.
- **Windows:** `npm run dev` fails in cmd (`NODE_ENV=…`); run `tsx` from Git Bash. Local Lakebase needs `PGUSER` set to your workspace email.
- **Genie Agent** can return `internal_error` before running any SQL; it's transient (the same question then succeeds), and one failed smoke check of that kind is a reason to re-run, not to change code.

## Known limits of this build

1. Three days of data: no forecasts, and "trend" means how the window unfolded.
2. No retraining events, model costs or targets: no retraining effects, no ROI, no "vs plan".
3. Drift and alerts are recorded, not their causes or the input features.
4. No process topology: "downstream" can't be established.
5. Value is concentrated in 5 incidents (one is 89%), so value comparisons between groups are dominated by them; the Command Center says so.
6. Health is judged on the latest day; the Explorer's day range changes the other measures but not health.
7. `incidents_confirmed` and the savings figures are estimates recorded in the data, not audited.

---

# Part B — Platform build history (from LensS Collections Intelligence)

*Kept for its engineering record: how the app, Genie Chat and Agent modes, Lakebase, caching, guardrails, the judge, Observability and the deploy were built and debugged. These parts are reused unchanged in Lens MLOps. The examples (accounts, promises, DPD buckets, ₹) refer to the collections data, view names such as `qry_mtd_vs_target` no longer exist here, and environment variables have since been renamed `LENSS_*` → `LENS_*`.*

## Step 8 — Optional: custom UI

If a branded/custom look matters, build a **Databricks App** with the Genie Agent wired in as a resource. Stay inside a Databricks App rather than external hosting — it inherits your workspace's SSO with no extra auth layer to build, and true anonymous public internet access isn't something Databricks supports for this anyway (nor is it advisable for this kind of data).

**What's out of the box, verified 2026-09-25**: only **Chat**, via AppKit's `GenieChat` component:
```jsx
import { GenieChat } from "@databricks/appkit-ui/react";
export function ChatPage() {
  return (<div style={{ height: 600 }}><GenieChat alias="sales" /></div>);
}
```
One server-side plugin + this one component — handles streaming, message rendering, conversation ID, and history replay automatically. The `alias` matches the Genie Agent resource bound in the app's config.

**Monitor and Benchmark are not embeddable AppKit components — and shouldn't be.** They're builder/admin tools living on the Genie Agent's own page (usage/feedback review, accuracy scoring — exactly what you've used for the 7 acceptance tests). Business users don't need them in a custom app; keep using the native Genie Agent page for these, same as now.

**Not truly from scratch**: Databricks maintains a real template repo, `databricks/app-templates` on GitHub, including a full-stack template with dashboards + file browser + Genie chat already wired together, and a dedicated "Genie Conversational Analytics" template — start from one of these rather than an empty project.

**Genuinely custom work**: anything beyond chat itself — e.g. dashboard stat tiles for `qry_mtd_vs_target` or a chart over `mv_collections_funnel` — is normal app code querying the SQL Warehouse via the same resource binding, not a re-implementation of anything Genie already does.

## Step 8b — Agent Mode + observability (why native chat looks better than the app)

**Root cause found 2026-09-26**: the app's `GenieChat` widget only ever uses Genie's **Chat mode** (one query, one raw chart) — the richer, multi-section, multi-chart reports you see in native Genie chat come from a *separate* capability, **Agent Mode**, which `GenieChat` has no prop to enable (confirmed — its full prop list is `alias`, `basePath`, `placeholder`, `className`, nothing mode-related).

**Agent Mode is a different REST API entirely**: `POST /api/2.0/genie/agents/{agent_id}/responses`, body `{input: [...], conversation_id, enable_viz: true}`, response streamed as Server-Sent Events (`response.created` → `response.output_item.added/updated/done` → `response.completed`, with polymorphic items: `reasoning`, `function_call` (SQL), `function_call_output` (results), `message` (final report)). Getting this into your app means building a custom streaming chat UI, not configuring `GenieChat`. **This is now actually built and verified — see Step 8c.**

**Immediate chart-scale bug, fix regardless of mode**: Chat mode's single chart was plotting `Target_Achievement_Pct` (0–1) on the same axis as multi-million-dollar columns, making the percentage bar invisible. Add a narrower certified Example:
```sql
SELECT Product, AVG(Target_Achievement_Pct) AS Target_Achievement_Pct
FROM cnx_automl_dev.lenss_collections_gold.qry_mtd_vs_target
GROUP BY Product ORDER BY Target_Achievement_Pct;
```

---

## Step 8c — Agent Mode + Chat Mode + multi-user history + monitoring, built and verified end-to-end (2026-09-25)

Built directly into the existing `appkit-genie` app (personal workspace) via the Databricks CLI (installed with `winget`, authenticated with a PAT since browser OAuth doesn't work from an automated shell — see the note under "Your real environment" above), and tested for real against the live Genie space, not just written and assumed correct. Two real bugs were caught this way and are documented below rather than papered over.

### Architecture

- **Chat mode and Agent Mode are both wrapped server-side** in one new Express router (`server/routes/chat.ts`), mounted via `appkit.server.extend()` inside `onPluginsReady` in `server/server.ts` — the officially-documented AppKit extension point, confirmed by reading the framework's own `.d.ts` files rather than assuming.
- **Chat mode** calls the `genie` plugin's own built-in `appkit.genie.sendMessage(alias, content, conversationId)` — an `AsyncGenerator` yielding typed events (`message_start`/`status`/`message_result`/`query_result`/`error`). This wraps Genie's Conversation API (`start-conversation`/`create-message`/`get-message`) for you — no need to hand-roll those calls.
- **Agent Mode** has no such built-in wrapper in this AppKit version, so it's hand-rolled against the low-level escape hatch `client.apiClient.request({ path, method, raw: true, payload, headers })`, where `client` comes from `getExecutionContext().client` (a `WorkspaceClient`). Confirmed by reading the *compiled* `api-client.js`, not just its `.d.ts`: with `raw: true` the return value is `{ contents: ReadableStream<Uint8Array> }` — **not** `{ body }`, despite what the type naming might suggest. Using `.body` here would have silently returned `undefined` and failed at runtime. The stream is parsed as standard SSE (`event:`/`data:` lines, records separated by blank lines) and re-emitted to the browser as our own SSE stream. See `server/lib/agentMode.ts`.
- **Multi-user chat history + usage logging** live in **Lakebase** (Databricks' managed autoscaling Postgres), not Unity Catalog — this is a transactional, per-message-write, per-user-session workload, which Delta tables are the wrong tool for. Wired via AppKit's own `lakebase()` plugin (`AppKit.lakebase.query(sql, values)`), which handles OAuth token refresh and connection pooling automatically — no hand-rolled credential-refresh code needed once the plugin is added.
- **Identifying the current user**: `req.headers['x-forwarded-email']`, the header Databricks Apps' own reverse proxy injects for the signed-in user (confirmed in the framework's `.d.ts`: `UserContext.userEmail` is documented as sourced from exactly this header). Falls back to `'local-dev@localhost'` when absent (local dev, no reverse proxy).

### Provisioning Lakebase (done once, via CLI — no UI click-through)

```powershell
databricks postgres create-project lenss-collections-app
# a default branch "production" and endpoint "primary" are created automatically —
# no separate create-endpoint call needed
databricks postgres create-database projects/lenss-collections-app/branches/production `
  --database-id chatapp `
  --json '{"spec": {"role": "projects/lenss-collections-app/branches/production/roles/ullaskc98", "postgres_database": "chatapp"}}'
databricks postgres create-role projects/lenss-collections-app/branches/production `
  --role-id appkit-genie-sp `
  --json '{"spec": {"identity_type": "SERVICE_PRINCIPAL", "postgres_role": "<app-service-principal-client-id>", "auth_method": "LAKEBASE_OAUTH_V1"}}'
```
**Gotcha, confirmed by trial and error**: `create-database`'s JSON body needed three iterations to get right — the CLI's own `--help` doesn't document the `spec.role`/`spec.postgres_database` fields, and `spec.role` specifically must be the **fully-qualified** `projects/.../branches/.../roles/...` path, not a bare role ID (a bare ID fails with a clear "expects that format" error, so this is discoverable, just not documented up front).

**Bigger gotcha, would have caused a silent connection failure**: the endpoint's **pooled** host (`...-pooler.database...`) rejects OAuth/SASL authentication — connecting via `psycopg2`/`pg` against it fails with `SASL authentication failed`. The **direct** host (no `-pooler` suffix, from `status.hosts.host` on the endpoint) works. Use the direct host for `PGHOST`.

The actual schema (`chatapp.chat_sessions`, `chatapp.chat_messages`, `chatapp.usage_log`, plus a `GRANT` to the app's service-principal role) was created by connecting directly with `psycopg2` using a token from `databricks postgres generate-database-credential <endpoint>` — see the schema SQL inline in the setup script; not repeated here since it's a one-time bootstrap, not something re-run per deploy.

### `app.yaml` additions

```yaml
env:
  - name: DATABRICKS_GENIE_SPACE_ID
    valueFrom: genie-space
  - name: PGHOST
    value: ep-divine-fire-d8b4rmqv.database.us-east-2.cloud.databricks.com   # direct host, not "-pooler"
  - name: PGDATABASE
    value: chatapp
  - name: PGPORT
    value: '5432'
  - name: PGSSLMODE
    value: require
  - name: LAKEBASE_ENDPOINT
    value: projects/lenss-collections-app/branches/production/endpoints/primary
```
`DATABRICKS_GENIE_SPACE_ID` is reused as the Agent Mode `agent_id` too — unverified beyond "the docs say it's the same identifier that appears in the Genie Agent URL," but it worked correctly in live testing below, so treat this as *confirmed in practice* for this build rather than merely assumed.

### `server/server.ts`

```ts
import { createApp, genie, server, lakebase } from '@databricks/appkit';
import { buildChatRouter } from './routes/chat.js';

createApp({
  plugins: [genie(), lakebase(), server()],
  onPluginsReady(appkit) {
    appkit.server.extend((app) => {
      app.use(buildChatRouter(appkit));
    });
  },
}).catch(console.error);
```

### Real bugs found by actually running it against the live app — not hypothetical

1. **`appkit.genie.asUser(req).sendMessage(...)` throws** `Cannot read properties of undefined (reading 'resolveSpaceId')` in this AppKit version (`0.65.0`) — a framework-internal issue with how the OBO proxy wraps an `AsyncGenerator` class method, not a mistake in how it was called. **Workaround used**: call the service-principal-context `appkit.genie.sendMessage(...)` directly instead of `asUser(req)`. This Genie space already grants `CAN_RUN` to the app's service principal, so per-user OBO wasn't actually required for this build's permission model — revisit only if a future version needs Genie calls to respect individual users' own data permissions.
2. **`message.content` on a Chat-mode `message_result` event is the *original question text*, not the answer** — confirmed against a real response (`"content":"What is my MTD collections performance versus target?"` on the assistant's own message object). The actual narrative answer lives in `message.attachments[].text.content` (a text-purpose attachment). An earlier version of this code stored the echoed question as the "assistant" reply — fixed by scanning `attachments` for the one with a `text.content` field, both server-side (for persistence) and client-side (for display while streaming).

### Verified working end-to-end (2026-09-25, against the live `Collections Performance and Recovery Analytics` Genie space)

- **Chat mode**: "What is my MTD collections performance versus target?" → real SQL generated and executed against `qry_mtd_vs_target`, real 25-row result, real narrative ("...achievement rates ranging from approximately 85% to 96% of target...") — persisted correctly to Lakebase after the fix above.
- **Agent Mode**: "Why are collections lagging this month and what should we do about it?" → genuine multi-step run: reasoning → multiple `execute_sql` function calls across several certified views → a ~6,200-character structured final report with headed sections, bullet recommendations, and inline citation links back to the native Genie chat UI. Took ~107 seconds end to end — Agent Mode is meaningfully slower than Chat mode (~21s average), which is expected given it's doing several queries and a synthesis pass, not one.
- **Usage log correctly distinguishes the two modes**: after this testing, `/api/admin/usage` reported `{"byMode":[{"mode":"agent","questions":1,"avg_latency_ms":"106688"},{"mode":"chat","questions":3,"avg_latency_ms":"21281"}]}` — real numbers, not illustrative ones.

### A real build-tooling gotcha worth knowing about before it bites you again

AppKit's server build (`tsdown.server.config.ts` → `appkitServerConfig()`) uses tsdown's `unbundle: true` mode, which emits one output file per **discovered entry**, not one per file reachable from the entry via imports. It only auto-discovers `server/agents/*/agent.ts` as extra entries. Adding new files under `server/routes/` or `server/lib/` and importing them from `server/server.ts` **builds successfully with zero errors** but produces a `dist/server.js` that still imports the literal, non-existent `./routes/chat.ts` — a runtime crash on `node dist/server.js`, invisible until you actually run it. Fix: list the new files explicitly:
```ts
// tsdown.server.config.ts
export default appkitServerConfig({
  entry: ['server/routes/*.ts', 'server/lib/*.ts'],
});
```

### What's still genuinely open, not glossed over

- **No formal `databricks.yml` resource binding for the Postgres/Lakebase database yet.** The app connects successfully because the env vars above are set directly and the Postgres-level `GRANT` was applied directly via SQL — but the declarative `resources: - name: postgres, postgres: { branch, database, permission: CAN_CONNECT_AND_CREATE }` block (confirmed to exist as a real Databricks Apps resource type) wasn't added because its exact value format (full resource path vs. bare ID) wasn't confirmed in official docs and guessing wrong risks a broken deploy for no functional gain — the app already works without it. Add it later if/when you want the admin-facing "Resources" tab in the Apps UI to show the database, rather than only `.env`/`app.yaml`.
- **`asUser` for Genie is bypassed, not fixed** — if a future Genie space needs different users to see different rows/columns, this workaround (service-principal-only calls) won't respect that; you'd need to either patch around the AppKit bug or wait for a newer `@databricks/appkit` release.
- **Visualization data isn't rendered as a chart yet** — Chat mode's `query_result` events and Agent Mode's raw SQL results are passed through to the client as JSON (visible, usable, just not chart-rendered). Wiring an actual chart component (the `appkit-ui` package has `BarChart`/`LineChart`/etc. already available) is straightforward follow-up work, not a blocker.

---

## Step 8d — Production round: new UI, the real Agent-mode bug, one-command deploy (2026-09-25)

### Correction: the Agent-mode "internal error" was a permissions bug, not a timing issue

The deployed app returned `internal error` for every Agent-mode question. It was first attributed to a timeout/timing issue — **that was wrong**. The actual cause: the app's service principal had `CAN_RUN` on the Genie space but **no Unity Catalog privileges on the gold schema and no binding to the SQL warehouse**. Chat mode appeared fine only because it was always tested as an admin locally; Agent mode runs several `execute_sql` calls as the app's identity and failed on the first one. Fix (now automated in `deploy.py`'s `app` step):

```sql
GRANT USE CATALOG ON CATALOG cnx_automl_dev TO `<app-sp-client-id>`;
GRANT USE SCHEMA, SELECT ON SCHEMA cnx_automl_dev.lenss_collections_gold TO `<app-sp-client-id>`;
-- gold only: UC views (incl. metric views) execute with the owner's rights, so silver needs no grant
```
plus an app resource `sql-warehouse` with `CAN_USE`. **Lesson**: "it works" must be proven as a non-admin identity against the deployed URL — which is what `deploy/smoke_test.py` now does.

### Testing the deployed URL as a real non-admin identity

- A dedicated service principal (`lenss-smoke-test`) with an OAuth M2M secret calls the app with a bearer token.
- It needs `CAN_USE` on the app **and the `workspace-access` entitlement** — without the entitlement the app proxy returns **401 even with a valid token**.
- An earlier "GET / returned 200" check was a false pass: it was the SSO login page. The smoke test now asserts real UI content.
- Result against `https://appkit-genie-7474660150071734.aws.databricksapps.com`: **13/13 checks passed** — UI, 4 dashboard APIs, 4 Chat questions (incl. PII refusal), 2 Agent questions (~12 s and ~110 s), usage API.

### New UI (ported from a reference UI, `refernce_ui_code/`, since removed from the repository)

The React client was replaced with a static `public/` UI (HTML/CSS/vanilla JS + Chart.js) built on the reference design, with three tabs:

| Tab | Backed by |
|---|---|
| Command Center | `/api/dashboard/{summary,by-product,segments,funnel-rates}` → `server/routes/dashboard.ts` → Statement Execution API on the gold views |
| Chat + Agent | `/api/chat/sessions/...` SSE, mode toggle, per-user history in Lakebase |
| Monitoring | `/api/admin/usage` (questions, latency, errors by mode) |

`server/routes/dashboard.ts` reads `LENSS_GOLD_SCHEMA` (regex-validated) and `DATABRICKS_WAREHOUSE_ID` from `app.yaml`.

### External (internet) access

Databricks Apps **cannot be public/anonymous** — bypassing SSO is unsupported. The URL is reachable from anywhere over HTTPS, but every visitor must authenticate. Chosen route: keep Databricks Apps and have a workspace admin provision external users through the identity provider (SCIM/JIT), then grant `CAN_USE` on the app (or put them in `readers_group`). Systems use service principals with M2M OAuth (needs the `workspace-access` entitlement, see above).

### Charts, named sessions, and choosing Chat/Agent per question

User feedback after the first production round: answers showed raw `**markdown**` and no graphs, every session was called "New conversation", and the mode was fixed per session. What changed and why:

- **Charts.** Both modes already return the data; the UI was discarding it.
  - *Chat mode*: AppKit emits a `query_result` event per SQL attachment with `manifest.schema.columns` + `result.data_array`; the attachment carries the query title and SQL.
  - *Agent mode* (verified against a captured live stream): each `execute_sql` step returns its result as a **markdown table** in `function_call_output.output`; a `generate_visualization` call references that step by `query_attachment_id`; and the final assistant message contains an **empty `output_text` part whose `metadata.viz.attachment_id`** marks where the chart goes.
  - `server/lib/answers.ts` normalizes both into one `Answer {text, charts[], steps[], suggestions[]}` (text carries `[[chart:id]]` markers for inline placement). It's sent as a single `answer` SSE event and stored in `chat_messages.attachment_json`, so reopened sessions show the same charts. The UI picks bar / horizontal bar / line + percentage axis from column types and names, with Chart / Table / SQL tabs.
- **Session names.** The first question is named ChatGPT-style by a chat model serving endpoint (`title_endpoint` in the deploy config, default `databricks-meta-llama-3-3-70b-instruct`, bound to the app as the `title-model` resource with `CAN_QUERY`). If that endpoint doesn't exist in a workspace, the name is the tidied question. Users can rename and delete sessions; empty sessions are no longer listed.
- **Mode per question.** Genie keeps the two conversation types apart — verified: sending a Chat message to an Agent conversation returns `400 "Sending messages is not supported for Agent mode conversations"`, and Agent mode returns `404` for a Chat conversation id. So each app session stores both (`genie_conversation_id`, `agent_conversation_id`), and when a question switches mode the latest turns from the other mode are prepended as context so follow-ups still work.
- **Verified** against the deployed URL as the non-admin smoke identity (17/17), including one session that asks in Chat mode ("Show MTD collections versus target by product" → a 5-row chart, and the session was named "Monthly Collections Product Targets") and then follows up in Agent mode ("For the weakest product in that answer…" → Agent answered about Personal Loan with 6 charts, ~100 s). Reloading the session returned 4 messages in both modes and 7 stored charts. The UI was also driven in headless Chrome: the charts rendered and the page logged no console errors.

### One-command deploy — `deploy/deploy.py`

`python deploy/deploy.py --config deploy/config/<env>.json` runs `preflight → schemas → ingest → context → transform → genie → lakebase → app → smoke`, idempotently, with state in `deploy/.state/`. See the root `README.md` for usage. This is the migration path to the org workspace rather than a pure Asset Bundle, because three things a bundle cannot do are required: ingest the xlsx into tables, write the Genie space content (sources/instructions/examples/benchmarks via `serialized_space`), and apply the Lakebase DDL/grants.

---

## Step 8e — Answer caching (Phase 1; Phase 2 is built in Step 8f)

### Why

A Chat answer takes about 20 s and an Agent answer 1–3 min, and most of that is Genie writing and running SQL. The data only changes when `deploy.py` reloads it, and the same questions come up again and again: the 10 suggested questions, and the opening question of most demos. Answering those again every time costs warehouse time and makes people wait for an answer that can't have changed.

### Phase 1 (built): three caches

| Cache | What it holds | Where | Invalidated by |
|---|---|---|---|
| **Command Center** | The results of the four `/api/dashboard/*` endpoints | App memory, per instance | A new data version (checked every 30 s); if Lakebase can't be read, a 10-minute expiry |
| **Pre-warmed suggested questions** | Answers to the 10 suggested questions (5 Chat, 5 Agent) | Lakebase `chatapp.answer_cache`, `source = 'prewarm'` | A new data or Genie version, or a 👎 on the answer |
| **Exact-match answers** | Answers to any other *standalone* question | Lakebase `chatapp.answer_cache`, `source = 'live'` | A new data or Genie version, a 👎, or 24 hours |

**The key.** `sha256(normalized question | mode | data version | Genie version)`. Normalizing lowercases, collapses spaces, and drops quotes and trailing `?.!`, so "Which accounts require immediate intervention?" and "which accounts require  immediate intervention" share an answer. Chat and Agent answers are cached separately.

**Versions: how stale answers are ruled out.** `chatapp.cache_versions` holds two rows that `deploy.py` maintains:

- `data` is set to the run's timestamp whenever `ingest`, `transform` or `summary` runs (once per run, so a full deploy bumps it once).
- `genie` is a hash of the Genie space ID and its `serialized_space`, set by the `genie` step. Re-running `genie` with no changes keeps the same version, so the cache survives.

Because both versions are part of the key, a reload makes every older answer unreachable at once. Nothing has to be found and deleted, and no stale answer can be served in between. The versions are also kept in `deploy/.state/`, so a first deploy (where Lakebase is created after `transform` and `genie`) writes them during the `lakebase` step.

**Only standalone questions are cached.** A question is standalone when it's the first in a chat, a click on a suggested question, or a Refresh of one of those. Follow-ups depend on the conversation, so they always go to Genie. An answer is only *stored* when Genie saw the question with no earlier turns (no Genie conversation yet and no carried-over context), so a cached answer never relies on context a later asker won't have.

**Follow-ups after a cached answer.** A cached answer never reaches the session's Genie conversation. The same mechanism that carries turns across Chat and Agent (`crossModeContext`) now also carries cached turns: it looks for turns after the last *live* answer in the target mode, so the cached question and answer are prepended as context to the next question.

**Why one cache for everyone is safe.** The app calls Genie and SQL as its service principal, so every user gets the same answer to the same question. With on-behalf-of-user auth, row-level security could differ per user, and the key would need to include the user or their groups.

### Pre-warming

`startPrewarm()` in `server/lib/answerCache.ts` runs 30 s after the app starts and then every 10 minutes. It does nothing unless:

1. **The versions have settled.** Neither version changed in the last 2 minutes, so one deploy that bumps data and then Genie pre-warms once.
2. **No run exists yet for these versions.** It claims a `chatapp.prewarm_runs` row for `data|genie` with `INSERT … ON CONFLICT`, so with several app instances only one asks Genie. The running instance updates a heartbeat after each question. A `running` claim with no heartbeat for 10 minutes belongs to an instance that was stopped, and another instance takes it over. This matters because a redeploy briefly starts the old deployment and then stops it: found in testing, where the first claim was orphaned 5 s after it was made. A run that ended `failed` (some questions unanswered) is retried after 60 minutes.

It asks the 10 questions one after another, as the service principal, through the same `runGenie()` function that live questions use. The cached answer therefore has exactly the same shape: text, charts, Agent steps, SQL and Genie IDs. If a suggested question was already answered live since the versions changed, that answer is kept and promoted: it no longer expires after 24 hours. A full pre-warm takes about 10 minutes, mostly for the Agent questions. It also deletes cache rows for older versions or with an expired TTL.

**It does not run on every start.** The cache is in Lakebase, so restarts and redeploys keep it. A restart finds a `done` run for the current versions and skips. Only new data, a Genie change, or an empty cache triggers work. The suggested questions come from `server/lib/suggestions.ts`, which the UI loads from `GET /api/chat/suggestions`, so the tiles and the pre-warm can't drift apart.

### What the user sees

- A cached answer appears at once, without the live "Understanding the question…" steps.
- It renders exactly like a live one: text, charts with Chart / Table / SQL tabs, the Agent's "How the agent worked it out" with its SQL, and follow-up chips.
- Under it: **⚡ Answered from cache · generated &lt;time&gt;** and a **↻ Refresh** button on the latest answer. Refresh sends `refreshOf: <messageId>`. The server deletes the cached answer, asks Genie live and bypasses the lookup, and the new answer replaces the old one in place and in the cache.
- 👍/👎 still go to Genie against the original Genie message. **👎 also evicts the entry**, so the next person gets a fresh answer.

### Monitoring

- **KPIs.** *Cache Hits* (% of questions answered from the cache, with the average hit time). *Avg Latency* now shows Genie answers only, so hits don't hide how slow Genie is.
- **Audit trail.** A hit shows ⚡ in the Time column. Its details say whether it was pre-warmed or an earlier answer, when it was generated and how long the original took. They also show "How Genie originally answered it" (the original stage timings) and the original SQL. A miss says whether it was stored, and a Refresh says so.
- **Answer cache panel.** Cache on/off, the current data and Genie versions, the last pre-warm (status, count, time), and the cached questions with source, hits, generation time and expiry.

### Settings

| Deploy config key | App env var (written to `app.yaml`) | Default | Effect |
|---|---|---|---|
| `answer_cache` | `LENSS_ANSWER_CACHE` | `true` / `on` | `false` turns off answer caching and pre-warming; the Command Center cache stays |
| `prewarm_suggestions` | `LENSS_PREWARM` | `true` / `on` | `false` keeps the answer cache but skips pre-warming |

To force fresh answers without new data, re-run `python deploy/deploy.py --config <config> --only summary`, which bumps the data version.

### Files

- `deploy/lakebase/schema.sql`, v4: `cache_versions`, `answer_cache` and `prewarm_runs`, plus `from_cache`/`cache_key` columns on `chat_messages` and `from_cache` on `usage_log`.
- `deploy/deploy.py`: `bump_cache_version()` and `write_cache_versions()`.
- `server/lib/genieRun.ts`: one Genie call (Chat or Agent), shared by live questions and the pre-warm.
- `server/lib/answerCache.ts`: key, lookup, store, evict and pre-warm.
- `server/lib/suggestions.ts`: the 10 questions.
- `server/routes/chat.ts`: standalone detection, hit/miss/refresh, 👎 eviction, cache stats.
- `server/routes/dashboard.ts`: Command Center cache (`X-Cache: hit|miss` header).
- `public/js/chat.js`, `public/js/monitoring.js`: the label, Refresh and the Monitoring panel.
- `deploy/smoke_test.py`: checks that a suggested question asked twice is served from the cache, that Refresh returns a live answer in place, and that the Command Center returns `X-Cache: hit`.

### Phase 2 (built in Step 8f): semantic cache

Exact matching misses rewordings: "Which accounts need immediate intervention?" and "Which accounts require immediate intervention?" are the same question to a person. Phase 2 reuses an answer when a new standalone question means the same as a cached one: a strict similarity threshold on embeddings, plus a check that the questions name the same things. The planned design changed in three ways while building it:
- **Storage.** Embeddings live in a `REAL[]` column, and the nearest match is computed in the app instead of with pgvector. There are only a few hundred entries per data/Genie version, so a scan takes milliseconds, and nothing depends on a Postgres extension.
- **Detail matching.** The "same things named" check also covers what the question is broken down by and its direction (best vs worst). Embeddings rate "which channel works best" and "…worst" as near-identical.
- **Shadow mode.** It became the audit trail instead: every miss records its closest cached question and similarity, so the threshold can be tuned from real data at any time.

---

## Step 8f — Semantic cache, guardrails, faithfulness judge, notifications

All three AI features are optional per workspace. A missing section in the deploy config means off.
- **Wiring.** `deploy.py` (`resolve_ai_config`) checks that each configured serving endpoint exists, the same way it re-finds the Genie space and Lakebase. If one is missing, it warns and leaves that feature or model off.
- **Permissions.** It binds each model endpoint to the app as a `serving_endpoint` resource with `CAN_QUERY`, so the service principal can call it without keys.
- **App settings.** It passes the settings as one JSON env var, `LENSS_AI_CONFIG`.

### Models

Enabled in the workspace by hand:

| Feature | Org recommendation | Personal workspace (lightweight) | Why |
|---|---|---|---|
| Embeddings | `databricks-gte-large-en` | the same | 1024-dim English embeddings, ~100 ms, very cheap |
| Guardrail classifier | `databricks-meta-llama-3-3-70b-instruct` | `databricks-meta-llama-3-1-8b-instruct` | Non-reasoning, so the JSON verdict fits in 80 output tokens |
| Faithfulness judge | `databricks-gpt-oss-120b` (or Claude Sonnet if available) | `databricks-gpt-oss-20b` | A reasoning model; runs after the answer, so speed doesn't matter |

### Request flow (`server/routes/chat.ts`)

1. **Input patterns** (`inputPatterns`, synchronous): PII is masked or blocked, plus profanity and prompt-injection phrasing.
   - The masked text is what goes to Genie, the cache, `chat_messages` and `usage_log`, so raw PII is never stored.
   - A pattern block returns at once. The live test blocked a prompt injection without a model or Genie call.
2. **Input classifier** (`inputClassifier`): one small-model call returning `{abusive, prompt_injection, off_topic, reason}`.
   - It runs *while* the session, versions, exact cache and embedding are looked up, so it doesn't add to latency.
   - A classifier failure never blocks a question.
3. **Exact cache, then semantic cache.** On an exact miss, the question is embedded and compared with entries of the same mode and versions.
   - It's a hit only when similarity ≥ threshold **and** `keyDetails()` are identical: numbers and buckets, products, channels, strategies, dimensions, direction.
   - Entries cached before semantic matching was enabled get embeddings filled in on first use (one batched call).
4. **Genie**, as before.
5. **Output guard** (`checkOutput`), before the answer is sent or cached:
   - PII and profanity are redacted;
   - policy wording is flagged, sentence by sentence, skipping negated sentences, so the required caveat "…not a forecast of uplift" doesn't trigger it.
6. **Faithfulness judge** (`judgeAnswer`), after `res.end()`:
   - **Numbers check:** every figure in the answer, with K/M/B and % handling, is looked up in the query results and their column totals. Digits inside IDs like `ACC011174` are ignored.
   - **Judge model:** reads the question, the answer and the results (capped at 60 rows per query, about 9,000 characters), and returns a score, a reason and up to 5 unsupported claims.
   - **Final score** is the mean of the two.
   - **Where it's stored:** `usage_log.faithfulness` plus `details.judge`, and the cache entry. Cache hits reuse it; pre-warmed answers are judged too.
   - **Evidence:** Agent mode keeps every `execute_sql` result for the judge (`agentEvidence`), not only the visualised ones.

### Monitoring

- **KPIs:** **Faithfulness** (with the judge model's name and how many answers scored below 70%) and **Blocked**. Cache hits show how many were similar-question hits.
- **"Guardrails and answer quality" section:** which features are on with their models and actions, counts by stage/check/action, and recent events.
- **Audit trail:** a **Faithful** column. Each row's details add the judge result, the guardrail checks that fired, and, for a cache miss, the closest cached question and its similarity.
- **Schema:** v5 in `deploy/lakebase/schema.sql` (`answer_cache.embedding`, `usage_log.guard_action`, `usage_log.faithfulness`).

### Notifications (`public/js/notify.js`)

- **On another app tab or chat:** an "Answer ready" toast with **View**, which opens the chat.
- **Browser tab hidden:** also a browser notification (once permission is given) and a "(n)" title badge.
- **Permission:** asked through a one-time banner on the first question, because browsers only allow the request after a user action.
- **Limit:** no service worker, so notifications need the page to be open.

### Verified (personal workspace, kept to a handful of model calls)

- **Offline tests:** PII patterns (7 kinds, no false positives on IDs, money, percentages or buckets); policy checks, including negated sentences; the numbers check (it caught a fabricated $25.0M and confirmed a total built from column sums); `keyDetails` (31-60 vs 61-90, Personal Loan vs Credit Card, best vs worst, product vs bucket all kept apart).
- **Live:**
  - prompt injection blocked;
  - one Chat answer judged: the gpt-oss-20b judge gave 100% with no unsupported claims, using 4,012 tokens in 1.4 s;
  - "Which accounts need immediate intervention?" served from the semantic cache, matching "…require immediate intervention?" at 98.9%;
  - toast, Monitoring KPIs and the guardrail panel checked in headless Chrome.

---

## Step 8g — Demo showcase: answer trust, evals, Responsible AI, branding

The AI features from Step 8f mostly lived in Monitoring. This step puts them in front of the user and adds the pieces clients ask about: evaluation, transparency, human review, cost and tracing. The app is presented as **Concentrix LensS**: users see what the AI did, never the platform's name.

### What was built

| Piece | Where | How |
|---|---|---|
| Trust bar + "How this answer was made" | `public/js/chat.js` (`addTrustBar`, `openTrace`) | Reads `GET /api/chat/messages/:id/trace` (owner-checked). That endpoint reads the question's `usage_log` row: quality summary, trace, queries, sources, guard events and tokens. Polls every 4 s while the judge is pending |
| Low-confidence warning | same | Score below `faithfulness_judge.warn_below` (default 0.7) |
| Multi-metric judge | `server/lib/judge.ts` | One call returns faithfulness, relevance, completeness and safety; the faithfulness score is still averaged with the numbers check |
| Request trace | `server/lib/trace.ts`, `chat.ts` | Spans with start offsets: patterns, classifier (parallel), exact and semantic cache, embedding, the engine plus its stages, output checks, follow-ups and judge. Stored in `usage_log.details.trace`; drawn as a waterfall by `renderWaterfall` in `app.js` |
| Token ledger | `server/lib/models.ts` | An `AsyncLocalStorage` ledger per question or eval run. Every `chat()` and `embed()` call adds its usage under a feature label set with `forFeature()`. Stored in `details.tokens` and summed in Monitoring; cost is computed when `pricing` is set |
| Follow-up suggestions | `server/lib/followups.ts` | Engine suggestions topped up to three by a small model; each passes `inputPatterns`. Sent as a `followups` SSE event and saved into the message |
| Feedback review | `chat.ts` (`PATCH /api/admin/feedback/:id`), `monitoring.js` | The 👎 reason and comment are stored on the message and the usage log (`review_status` open, fixed, dismissed or added_to_evals); "Add to evals" inserts an accuracy case |
| Evals | `server/lib/evals.ts`, `routes/evals.ts`, `public/js/evals.js`, `deploy/evals/cases.py` | Cases are seeded by `write_eval_cases` in the lakebase step. One background run at a time, results written as each case finishes. Accuracy compares the engine's returned figures with the ground-truth SQL's (recall and precision, ±0.5%, ratio vs percent tolerated) and runs the judge with `force` |
| Responsible AI | `routes/evals.ts` (`GET /api/ai/transparency`), `public/js/responsible.js` | Live config with model names, gold views from `information_schema` (cached 1 h), the latest eval run, guard and feedback counts |
| Voice input | `public/js/voice.js` | Web Speech API (`webkitSpeechRecognition`), `lang = navigator.language`, interim results into the box; the user still presses Send |
| Branding | `index.html`, `chat.js`, `export.js`, `style.css`, `public/img/` | The full wordmark goes in the header and on the PDF's first page (drawn from the header image), with a text fallback. The small mark is the assistant's avatar in chat rows and the favicon. The PDF header and footer leave out the session name, and models are shown by name via `modelLabel()` |
| Guarded session names | `server/lib/titles.ts`, schema v6 | Blocked or PII-redacted first questions get "⚠ Blocked question" or "⚠ Personal details removed"; the next clean question renames the session |

### Choices worth knowing
- **Answers render on `saved`, not on stream end.** Follow-ups, the title and the usage-log row come after. The trust bar therefore retries its lookup on 404 for a few seconds.
- **Exact cache hits don't wait for the classifier.** The same normalized text was screened when it was first answered. Semantic hits (different text) still wait.
- **Eval accuracy is lenient on shape and strict on figures.** It passes when at least 80% of the ground-truth figures appear in what the engine returned, *or* at least 80% of what it returned is in the ground truth. This tolerates a breakdown versus a total while still catching wrong numbers. Faithfulness must also clear `warn_below`.
- **Evals run in-process,** not as an MLflow job. The demo needs results inside the app with no extra infrastructure. Moving the same cases to `mlflow.genai.evaluate` is straightforward if the org wants experiment tracking.

### Verified
See `CHANGELOG.md` (Unreleased / v1.5.0): one live question end to end; a blocked question; two eval runs (the second after fixing a classifier false positive the first one found); and the UI and PDF in headless Chrome.

---

## Step 8h — UX redesign after the leadership demo

Leadership found the first demo too analyst-oriented: the Command Center was thin, and "Chat + Agent" meant nothing to an end user. This step rebuilt both screens and Monitoring around what a collections leader needs.

### Command Center (`public/js/home.js`, `GET /api/dashboard/overview`)

*Superseded: the Command Center layout described here was replaced by the five-chapter story in Step 8k (v1.9). Kept as build history.*
- **One API call,** 16 certified-view or metric-view queries run in parallel and cached per data version like the other dashboard panels. A failing panel returns empty instead of breaking the page. The app still reads **gold only**: account-level cuts (strategy, region, vulnerability, totals) come from `mv_collections_funnel` with `MEASURE()`, not from silver.
- **Layout, top to bottom:**
  - hero (greeting, progress to target, 4 headline stats);
  - executive summary;
  - **Today's priorities** (4 cards worked out from the data: biggest product gap, accounts to act on, broken promises, over-contact);
  - 10 metrics;
  - panels for performance against target (product bars with a 100% marker, shortfall sources, product × bucket heatmap), customer engagement (funnel, best channel per bucket), where to act (top 8 accounts with next best action, action mix, opportunity by product), and drivers (non-payment reasons, strategies, regions, collectors).
- **Ask AI everywhere:** `data-ask` / `data-mode` on any element opens the Assistant (`window.askAssistant`), starts a new conversation and asks the question in that mode.
- **No AI computes these figures,** which the page footer states.

### Assistant (`public/js/chat.js`)
- **Tab and modes:** the tab is **Assistant**. The modes are **Deep analysis** (Agent, the default) and **Quick answer** (Chat), chosen from a dropdown with plain descriptions. The preference key is `lenss.mode.v2`, so everyone starts on Deep analysis.
- **Empty state:** a personal greeting, a three-step "how it works" strip and starter cards tagged by mode.
- **While it works:** Deep analysis shows a progress bar and tells the user they can keep working; the existing notifications fire when it's ready.

### Monitoring (`public/js/monitoring.js`, `GET /api/admin/insights?days=`)
- **Time range:** 24 hours, 7 days, 30 days or all time.
- **Health banner:** healthy, needs attention (with the reasons) or idle.
- **Seven insight tiles:** answer rate, quality, p50/p90 speed per mode, served from cache, satisfaction, safety actions.
- **Trend charts:** questions per day by mode with failures, answer time per mode, quality and cache use per day, and questions by hour.
- **Breakdowns:** most-asked questions, latency percentiles and 👎 reasons.
- The existing sections follow, with the old mode and latency charts removed.

### Second review: full-screen assistant, executive language, one currency
- **Assistant layout:** the Assistant is a full-screen chat app.
  - **Screen space:** `body.assistant-on` removes the page padding, and the chat column is `100vh − --nav-h`, measured from the top bar with a `ResizeObserver`.
  - **Conversation list:** a 60 px rail that opens to 280 px with search (`lenss.sideOpen`, closed by default; an overlay with a backdrop below 900 px).
  - **Suggestions:** a drawer, closed by default.
  - **Messages:** a 860 px centred reading column with a floating question box.
- **Command Center copy:** it speaks as "we" and uses plain terms for leadership.
- **Rupees:** money is ₹ everywhere. The data model's `Currency_Code` is `INR`, and a CURRENCY AND FORMAT rule in the Genie instructions keeps the query engine consistent.
- **Senior-QA pass:** found four defects, two of them style-priority overrides that hid or blocked the welcome screen and the conversation panel. Both scripts are kept as regression checks: the 25-check UI script and the extended smoke test (24 checks, now including `/api/dashboard/overview`, `/api/admin/insights`, `/api/evals` and `/api/ai/transparency`).

### Visual system
The Concentrix palette (navy `#003B5C`, aqua `#25E2CC`) carries the hero, tabs with icons and the send button. Purple marks Deep analysis and blue marks Quick answer throughout. Bars, heatmap, funnel, skeleton loading states and responsive layouts were checked at phone width.

---

## Step 8i — Command Center to the leadership spec, benchmark features

The leadership spec (`all_details_and _data/Book6.xlsx`) lists six Command Center sections; a healthcare referral demo was set as the UX benchmark. This step builds the spec on governed views and adopts the benchmark's best ideas.

### Governed views (`deploy/sql/70_command_center_views.sql`, deploy step `views`)
- **Seven gold views computed from silver,** because the app's service principal reads gold only:
  - `qry_cc_kpis`, one row of headline KPIs;
  - `qry_cc_risk_snapshot`, accounts and balance per DPD bucket;
  - `qry_cc_target_outlook`, achieved, gap and outlook;
  - `qry_cc_actions` and `qry_cc_action_accounts`, the five action queues;
  - `qry_cc_channel` and `qry_cc_region`, effectiveness by channel and by region;
  - `qry_explorer_base`, the account-level base of the Explorer (not a Genie source).
- **Population:** accounts in arrears (DPD > 0) on the latest snapshot, like every other governed view. The spec's figures use the whole book (all 20,000 accounts), so some differ: ₹1.93B outstanding instead of ₹2.03B, and ₹53.4M collected instead of ₹55.4M. The KPI dictionary states the population of each figure.
- **High propensity is ≥ 0.60:** the spec asks for > 0.80, but no account scores above about 0.6.
- **Target outlook is a pipeline estimate, not a statistical forecast:** achieved + promises due in the rest of the month × the observed honour rate. Likelihood is High when the outlook covers the gap 1.5× or more, Medium at 1.0× or more, else Low.
- **Wiring:** the views are Genie sources (`deploy/genie/space.py`), and `/api/dashboard/overview` returns them as `cc`.

### Four tabs (leadership review)
After the first build, leadership asked for the benchmark's four tabs and a clear split. The spreadsheet's figures are a reference only: the v1.6 calculations stay.
- **Command Center:** how the business is doing, in about a minute.
- **Explorer:** why, with drill-downs and filters.
- **Assistant:** the conversation with LensS.
- **Observability:** traces, quality, performance, drift, security, plus Evaluations (area 6) and Responsible AI (area 7).

A "Built by the Concentrix Data & Analytics Practice" strip and a footer frame every page except the full-screen Assistant. Every "Ask AI" link is now "Ask LensS", and answers are signed "LensS Intelligence Engine".

### Command Center (`public/js/home.js`)

*Superseded: the Command Center layout described here was replaced by the five-chapter story in Step 8k (v1.9). Kept as build history.*
The page runs top to bottom:
- hero (target progress, outlook, recoverable now / 604 priority accounts, customers in arrears, 879 high-risk, over-contact);
- executive summary (the narrative written by the `summary` step);
- today's priorities (four cards);
- core metrics: five large cards and the seven v1.6 metrics under "show more" (customers reached 47.4%, agreed to pay 46.1% of customers reached, promises honoured 34.6% of promises due, amount promised, accounts worsening, cost to collect, contacts per customer);
- executive brief and priority watchouts;
- risk snapshot and target outlook;
- Action Center (5 queues), recommended next steps, recovery opportunity by product, largest recovery opportunities;
- a hand-off card to the Explorer.

Each renderer is isolated, so one failing panel can't blank the page. A KPI dictionary dialog defines every figure, including both high-risk figures (879 at risk ≥ 0.70; 604 of them still likely to pay).

### Explorer (`public/js/explorer.js`, `server/routes/explorer.ts`, view `qry_explorer_base`)
- **Data:** `qry_explorer_base` is one row per account in collections (DPD > 0, balance > 0, latest snapshot) with nine dimensions, the two dates and the flags the measures need. The server computes each measure with the metric-view formula (for example agreed to pay = SUM(PTP_Flag) / SUM(RPC_Flag)), so the unfiltered Explorer reconciles exactly to the Command Center. Targets come from `qry_product_bucket_performance`, which only has product × stage grain.
- **API:** `GET /api/explorer/options` returns the filter values and date ranges. `GET /api/explorer/data?product=…&bucket=…&contactFrom=YYYY-MM-DD…` returns totals, the portfolio for comparison, a breakdown per dimension, collectors (30+ accounts), targets, product × stage cells, the best channel per stage (same rule as `qry_recommended_channel`) and the top 500 accounts by recovery opportunity. Values are checked against the options list and dates against `YYYY-MM-DD`, so no free text reaches the SQL. Results are cached per data version.
- **Page:** filters and chips; 12 filtered tiles compared with the portfolio; Layer 1, a dimension × measure slicer (bars or table, click to drill); the why panels (target, drivers, strategies, funnel, channels, regions, collectors); Layer 2, account records with search, sort, paging and CSV; and the segment table. Each "Ask LensS" question carries the active filters.

### Assistant prompts (`server/lib/suggestions.ts`, `public/js/chat.js`)
- **Quick-start prompts:** six one-click analyses, each with a mode.
- **Question library:** five categories.
- **Where they appear:** in the welcome screen and in a side panel that opens beside a conversation on wide screens.

### Observability (`public/js/observability.js`, `GET /api/admin/insights`)
- **Layout:** seven areas under a headline row. Areas 6 (Evaluations) and 7 (Responsible AI) were separate tabs before the leadership review; they load when opened.
- **Pipeline traces:** a trace list and a detail view with the 9-stage path, a waterfall and the SQL.
- **The other four sub-tabs:** answer quality, performance and latency (including average time per stage), data and model drift (versions, models, question mix, eval pass rate per run) and security and guardrails.
- **New insights fields:** `reconciliation`, `pii`, `stages`, `lowConfidence` and `traces`.

### Auto mode, faithfulness check, account menu (second review)
- **Auto mode** (`server/lib/autoMode.ts`): the browser calls `POST /api/chat/route` before sending a question in Auto. With `auto_mode.method = "ai"` a small model returns `{"mode": "quick" | "deep", "reason"}` (6 s timeout); otherwise, or on any failure, the word rule decides. The decision and the classifier's tokens are kept for 10 minutes keyed by user and question, and attached to that question's log when it arrives (`details.autoMode`, token feature `auto_mode`), so the browser never reports its own token counts.
- **Numbers check** (`server/lib/judge.ts`): evidence numbers now include subtotals by each text column's values (groups of 2+ rows, short of the whole table), ranges are expanded so both ends carry the unit, and the question's own figures and the business-rule constants are accepted. The model judge is unchanged.
- **Platform questions** (`server/lib/platformGuide.ts`, `platformHelp.ts`): the engine only knows the data, so questions about LensS itself are answered from a written guide (about, each tab, how-to steps, modes, trust, navigation, data, limits). `platformCandidate()` is a word check (strict without a model, looser with one); with a model the answer is written from the guide only, and a `DATA_QUESTION` reply sends the question to the engine unchanged. It runs before the answer cache (so a cached engine reply to "What is LensS?" is not reused), after the input pattern checks, and never touches the engine conversation. The answer carries `platform: { method, sections }`.
- **Account menu:** `/api/me` returns `{ email, name, workspaceUrl }`; the name comes from the workspace SCIM directory (cached per email, 4 s timeout) or is derived from the email. Log out is app-side only, because Databricks Apps has no supported way to end the platform session.

---

## Step 8j — One assistant: platform answers, conversation memory, routing (v1.8)

The Assistant behaves as one assistant, whichever path answers.

- **Platform answers** (`server/lib/platformGuide.ts`, `platformHelp.ts`). A written guide covers what LensS is, each tab, exact how-to steps, the modes, how answers are checked, navigation and limits; it holds no data figures, so it never goes stale. A word check picks candidate questions; with a model, the model answers from the guide only or replies `DATA_QUESTION` and the question goes to the engine as usual. `platform_help` in the config: `ai`, `guide` (no model) or `enabled: false`.
- **Conversation memory** (`server/lib/memory.ts`, Lakebase schema v8: `chat_sessions.context_summary`, `context_summary_upto`). Each follow-up carries a summary of older turns plus up to 7 recent question-and-answer pairs, across both modes and including cached and platform answers. Every 5 pairs, older turns are folded into the summary after the answer is sent, keeping the last 2 verbatim. The engine's own conversation only remembers its own mode, which is why this is needed.
- **Routing.** Auto reads the conversation (`routeFollowUp` in `server/lib/autoMode.ts`): a short follow-up to a deep analysis stays deep, a "why" after a quick answer can go deeper, and the AI router gets the previous question. A short follow-up after a platform answer goes back to the guide unless it names data (accounts, products, regions, rates…). Retries in a fresh engine conversation keep the same context.
- **Empty tables** (`server/lib/emptyResults.ts`). A chart or table with no rows is dropped; where nothing else explains it, a small model writes one line saying what found nothing. Escaped pipes in Agent result tables no longer drop rows.

## Step 8k — Command Center as one story, account drill-down, loading (v1.9)

- **Story layout** (`public/index.html`, `public/js/home.js`). Five chapters, each with an opening line computed from the figures (`setTake`). Removed as repeats: the executive summary paragraph, the decision brief, the target panel, the duplicate hero tiles and the top-250 queue. The "remind the other promises" queue excludes the at-risk ones, so the two promise queues don't double-count.
- **Account lists.** `GET /api/dashboard/accounts?list=…&value=…` (fixed list definitions in `server/routes/dashboard.ts`, values checked against the data) and `GET /api/explorer/accounts` (the Explorer's own validated filters plus a funnel `stage` or a `collector`). Both read `qry_explorer_base` joined to `qry_immediate_intervention`, return totals and up to 1,000 rows, and are cached per data version. Each list uses the same rule as its figure; all were checked to match their card or chart exactly.
- **Data refresh time.** The `summary` step reads the silver fact table's `last_altered` from `information_schema` (the app can read gold only) and stores it in `exec_summary.data_refreshed_at`; the table is rewritten each run.
- **Loading.** The Command Center's data is prepared when the app starts and whenever the data version changes (a Lakebase check every 5 minutes); concurrent visitors share one computation; its queries run in one parallel round. The browser draws the banner from the small summary first, then each chapter in order; scripts are deferred. Once it has drawn, the Explorer and Observability load in the background while the browser is idle (Observability refreshes when opened if older than a minute).
- **Verified.** Deployed smoke test 27/27; a browser pass of every tab 23/23, including all 27 Command Center account lists and the Explorer lists against their charts.
- **v1.9.1: figures that explain themselves.**
  - **"X of Y" counts.** Rates say what they are out of where they are read: "1,234 of 1,886", "8,563 of 18,074", "604 of 879", "610 of 1,198". The function `counts()` in `home.js` reads the certified figures. The two counts not stored (promises already due; accounts worsening) are derived exactly from stored ones (broken ÷ broken share; rate × accounts) and reconcile (1,234 + 652 = 1,886).
  - **Promises explained as one whole.** Issue 1 tells the story of the 3,945 promises this month in words, with one bar of five parts (kept, broken, this week likely kept, this week at risk, later); the parts sum to 3,945.
  - **The outlook as plain arithmetic** under the banner tiles ("₹53.4M collected so far + ₹30.3M expected from promises = ₹83.7M …").
  - **Attempts vs reached.** "Contact attempts" (answered or not) and "reached" (spoken to) are named separately. The over-contact issue headlines "4.5+ attempts" and says the customers are in groups *averaging* 4.5+. The 4.5 cut-off is a build-time recalibration of the sample SQL's 6+, which finds nothing in this data; it sits on the book's average.
  - **Observability panels** show "Loading…" until their data arrives.


---

# Appendix — environment self-checks (any workspace)

**Fastest privilege self-check** — run in any Notebook/SQL Editor:
```sql
SELECT CURRENT_METASTORE();
SHOW CATALOGS;
CREATE CATALOG IF NOT EXISTS <test_name>;
```
`CURRENT_METASTORE()` returning a value confirms Unity Catalog is attached. `CREATE CATALOG` succeeding confirms catalog-creation rights; failing means you need an admin to either grant `CREATE CATALOG ON METASTORE` or create one and grant you `ALL PRIVILEGES` on it directly (the narrower, easier-to-approve ask). Note from this project's actual experience: even when `CREATE CATALOG` fails, you may still be granted `CREATE SCHEMA` rights within an existing catalog — worth testing separately (`CREATE SCHEMA IF NOT EXISTS <catalog>.<test_name>;`) rather than assuming the table-prefix workaround is your only option.

**If you can create a Genie Agent yourself**, that alone confirms Genie/AI-BI is entitled on the account — no separate check needed.

**SQL Warehouse type matters for Genie**: must be Pro or Serverless, not Classic — check the badge next to the warehouse name in the SQL Warehouses list before assuming an existing warehouse will work.

**Groups** for readers (e.g. `lens-mlops-users`) are best created at the Account Console (account-level, works across workspaces) or under Workspace Settings → Identity and access. Creating them needs workspace-admin rights.
