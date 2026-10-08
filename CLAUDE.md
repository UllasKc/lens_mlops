# Lens MLOps: project playbook for Claude

Read this before doing anything in this project. It carries over how we work, the platform we reuse, and the lessons from building **LensS Collections Intelligence**, a sibling project built on the same platform.

## 1. What this project is

- **Product:** **Lens MLOps**, a Concentrix product. Brand it as **Concentrix**: "Built by the Concentrix Data & Analytics Practice", the Concentrix wordmark and the navy/aqua theme.
- **Never mention the client's name** anywhere: code, UI, docs, commit messages or comments. The source data folder is named after them; refer to it only as "the source data".
- **Starting point:** this folder is a copy of LensS Collections Intelligence **v1.9.2** (plus its executive summary, from 2026-10-07), the template to adapt. It is **not** yet adapted: it still contains collections-specific code, wording, views and Genie content, and about 20 files still say "LensS".
- **New data:** `../All_data_and_details/` holds `predictions.csv`, `model_registry.csv`, `business_outcomes.csv` and `metadata.xlsx`. This is ML-model data (models, predictions, business outcomes), not a collections workbook. Before building, study it and map it onto the platform pattern below.
- **The platform pattern to reuse** (proven in LensS): governed data → certified views → a story-led Command Center + Explorer + governed AI Assistant (Genie) + Observability, deployed by one command.

## 2. How the user wants us to work (always follow)

- **Plan before building** on anything substantial: show the mapping or plan, then build.
- **Commit and push only when the user says so.** Use good, descriptive commit messages (what, why, what was verified), and end them with the co-author line. For a change that might be rolled back, make it a separate commit with an annotated tag as a rollback point.
- **After every change, update `CHANGELOG.md`** (an "Unreleased" section, newest first; moved under a version heading with date and short hash after a commit) **and `README.md` where relevant. Do NOT update other docs** (setup guide, implementation guide, Word or HTML guides) unless the user asks for that document.
- **Never print secrets** (PATs, OAuth secrets, tokens). Read secrets into environment variables only. Mask real people's emails in anything shared, including screenshots.
- **Confirm before anything irreversible** (deleting catalogs, tables, apps or files; force operations). Look at the target first. If a tool blocks a destructive action, give the user the command to run themselves.
- **Keep AI/Genie usage minimal on the personal (Free Edition) workspace:** use small models, pre-warm off, offline tests, and reuse cached answers in tests.
- **Explain plainly.** The user wants direct answers; give a recommendation rather than a survey of options.
- **Org deploys run from the office laptop.** Configs with real organisation names stay out of git (`deploy/config/org*-local.json` is ignored).

## 3. The platform (as built in LensS; adapt names and content)

| Layer | What | Where |
|---|---|---|
| Data | Unity Catalog medallion: bronze (as landed) → silver (typed, primary keys) → gold (metric views, certified views, Command Center/Explorer views, business rules, summary) → context (definitions, rules, limitations) | `deploy/sql/*.sql` (templated by `{{catalog}}`/`{{prefix}}`) |
| Query engine | Genie space as code: curated gold sources, instructions, certified example SQL, benchmarks; Chat (quick) and Agent (deep) modes | `deploy/genie/space.py` |
| App | Databricks App, one Node.js process on one port: TypeScript server (AppKit + Express) serving the API and the static UI | `appkit-genie-app/server/`, `appkit-genie-app/public/` |
| App database | Lakebase Postgres, schema `chatapp`: chats, memory, answer cache, usage/audit log, evals | `deploy/lakebase/schema.sql` |
| AI trust layer | Guardrails (PII, abuse, injection, off-topic), faithfulness judge, Auto router, platform-guide answers, conversation memory, follow-ups, empty-result notes; all switchable per config | `appkit-genie-app/server/lib/` |
| Deploy | One command, idempotent steps: `schemas, ingest, context, transform, views, summary, genie, lakebase, app, smoke` | `deploy/deploy.py --config deploy/config/<name>.json [--only …]` |
| Tests | Deployed smoke test as a non-admin service principal; browser click-through of every tab (headless Chrome over CDP) | `deploy/smoke_test.py` |

The app runs as its **own service principal** (read-only on gold). Users need only **Can use** on the app.

## 4. Adapting LensS to the new data: checklist (in order)

1. **Understand the data:** grain, keys, joins, sizes, dates, what "good/bad" means, and the business questions it should answer. Write the mapping first and agree it with the user.
2. **Ingest** (`deploy.py` → `step_ingest`, `SHEETS` mapping): it is written for one xlsx workbook; adapt it to the CSVs plus `metadata.xlsx`. Keep the row-count checks.
3. **Silver/gold SQL** (`deploy/sql/30_*`–`70_*`): new typed tables, metric views (each measure defined once; rates as sum/sum), certified views for the key questions, and Command Center/Explorer views. Drop the collections views.
4. **Business rules and context tables** (`40_gold_config.sql`, `20_context_manual.sql`): thresholds as data, with the source of each.
5. **Genie space** (`space.py`): sources, instructions, scope and refusals, certified examples, benchmarks. Remove misleading sources rather than adding instructions to work around them.
6. **App:**
   - the Command Center story (chapters, opening lines, executive summary, issues, queues, "View accounts" lists → the equivalent records), the Explorer dimensions and measures, the suggested questions (`server/lib/suggestions.ts`), the platform guide (`server/lib/platformGuide.ts`), the KPI dictionary, the guardrail wording;
   - rename **LensS → Lens MLOps** everywhere user-facing.
7. **Configs:** `deploy/config/personal.json` and `org.json` already use distinct names (`lens_mlops`, `lens-mlops`, "Lens MLOps Analytics", database `lensmlops`) so they can't overwrite LensS in the same workspace. Keep them distinct.
8. **Evals and smoke test:** replace the collections questions with ones for the new data.
9. **Verify:** deploy to personal, run the smoke test and a browser pass of every tab; only then report "done".

## 5. Quality bar (what "good" looked like in LensS)

- **No AI in the figures:** every dashboard and Explorer number comes from certified SQL views. The AI only answers questions, and every answer shows its SQL, a quality score and a trace.
- **Tell one story, top to bottom:** numbered chapters, each opening with its answer in one sentence computed from the data. Each figure appears once. An **executive summary** (bottom line + one line per chapter) sits under the banner.
- **Every number opens its records** ("View accounts"), using the same rule as the figure, with Export CSV. Each list must match its card exactly; test that.
- **Say what a rate is out of** ("1,234 of 1,886") where it is read. Explain composite figures as a sum in plain words. Use plain business language, with no internal IDs or codes on screen.
- **Be honest about limits:** no forecasts from one snapshot and no causal claims without a controlled test; say so in the UI and the Assistant.
- **Performance:** Command Center data is prepared at app start and cached per data version; the page draws top to bottom; other tabs preload when idle.
- **Before saying done:** server type-check, a local browser check of the changed screen (screenshot), the deployed smoke test, a phone-width check (no sideways scroll), and no console errors.

## 6. Lessons and gotchas (from LensS)

- **Genie Chat and Agent conversations don't share memory**, and answers from the cache or platform guide never reach Genie. Our own conversation memory (summary + recent turns) makes follow-ups work across all of them.
- **The Agent can answer a follow-up from memory without running SQL**, so there is no chart. Re-show the chat's previous charts (implemented in `server/routes/chat.ts`).
- **The Agent's visualisation gives only a title and a query, not the columns**, so pick the plotted columns from the title (`titledColumns` in `public/js/chat.js`).
- **Thresholds copied from sample documents may find nothing in the real data** (LensS's over-contact rule 6+ returned zero rows; it was recalibrated to 4.5). Always query before trusting a threshold, and record the reason.
- **Genie benchmarks grade result sets;** "why" questions and refusals don't fit. Conflicting example queries break benchmarks.
- **Prove "it works" as a non-admin identity against the deployed URL.** Missing service-principal grants look like timeouts.
- **A redeploy briefly runs the old deployment**, so any startup claim needs a heartbeat or a timeout.
- **Models are enabled per workspace by hand;** the deploy checks they exist and degrades gracefully.
- **The deploy rewrites `appkit-genie-app/app.yaml` on every app deploy**, so `git pull` conflicts on it. Discard it with `git checkout -- appkit-genie-app/app.yaml`.
- **Windows console:** set `PYTHONIOENCODING=utf-8` before the smoke test (₹ and other symbols).
- **Some directories return the email as the display name;** derive the first name from the email.
- **CSS class clashes:** generic class names (`t-good`, …) are already used by the heatmap and bars; use prefixed names for new components.
- **Free Edition (personal workspace):** no credits or expiry, but an unpublished daily fair-use quota (compute pauses until reset). One SQL warehouse (2X-Small), up to 3 apps (each runs at most 24 h after a start or deploy; redeploy or Start to wake it), **one Lakebase project per account** (so reuse `lenss-collections-app` with a different database), and **no commercial use**. Client demos run on the organisation workspace. The CLI login expires; re-run `databricks auth login --profile personal`.
- **App names:** lowercase letters, digits and hyphens. **Lakebase database names:** no underscores.

## 7. Useful commands

```bat
python deploy\deploy.py --config deploy\config\personal.json                 :: everything
python deploy\deploy.py --config deploy\config\personal.json --only app      :: app code only
python deploy\deploy.py --config deploy\config\personal.json --only lakebase,views,summary,genie,app
set PYTHONIOENCODING=utf-8
python deploy\smoke_test.py --host <workspace URL> --app-url <app URL> --skip-agent
```
The smoke test needs `LENSS_SMOKE_CLIENT_ID` / `LENSS_SMOKE_CLIENT_SECRET` (a service principal's ID and OAuth secret) in the environment; never print them.
