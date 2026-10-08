# Setup Guide — deploying LensS Collections to a new Databricks workspace

This guide takes you from a fresh laptop to a running app in any Databricks workspace. Every step, what it needs, and how to check it worked.

**Time:** about 30 minutes the first time (most of it installing tools), then about 10 minutes per deploy.

**What you end up with**, all created by one command:

| Piece | Where it lives |
|---|---|
| Bronze / silver / gold / context tables and views | Unity Catalog: `<catalog>.lenss_collections_*` |
| The source workbook | Unity Catalog volume `<catalog>.lenss_collections_bronze.raw_files` |
| Genie space "LensS Collections Analytics" (instructions, 19 examples, 7 benchmarks) | Genie |
| Chat-history and usage database | Lakebase Postgres project `lenss-collections-app` |
| The web app: Command Center, Explorer, Assistant, Observability (with Evaluations and Responsible AI) | Databricks Apps |

---

## 1. Do I need VS Code?

**No.** Everything runs from a terminal. Pick whichever you have:

| Terminal | Works? | Notes |
|---|---|---|
| Windows **Command Prompt** (`cmd`) | ✅ | Commands in this guide show a `cmd` version where syntax differs |
| Windows **PowerShell** | ✅ | Shown as `PowerShell` where syntax differs |
| VS Code's built-in terminal | ✅ | Same as the above — it just runs PowerShell or cmd inside VS Code |
| macOS / Linux terminal | ✅ | Shown as `bash` where syntax differs |

VS Code is only useful for **editing** files (for example the config in step 6). The Databricks VS Code extension is **not required**.

---

## 2. What to install on the laptop

| Tool | Needed for | Version used to build this | Required? |
|---|---|---|---|
| **Git** | Downloading the project from GitHub | 2.55 | Yes (or download the ZIP from GitHub instead) |
| **Python** | Running the deploy script | 3.12.10 (3.10 or newer works) | **Yes** |
| Python packages `pandas`, `openpyxl`, `psycopg2-binary`, `requests` | Reading the Excel file, talking to Lakebase | from `deploy/requirements.txt` | **Yes** |
| **Databricks CLI** | Every call to the workspace | **v1.18.0** | **Yes**. It must be a recent version: the script uses the `genie` and `postgres` command groups, which older CLIs don't have |
| Node.js | Only for running the app **on your laptop** for development | 24.19 (22 or newer works) | **No** for deploying. Databricks builds the app itself |
| Databricks **SDK for Python** (`databricks-sdk`) | — | — | **No.** Not used; the CLI does everything |
| VS Code | Editing files | any | No |

> **About "the Databricks SDK".** The app itself uses the Databricks JavaScript SDK (through `@databricks/appkit`). You don't install it: Databricks runs `npm install` on its side when the app is deployed. The deploy script needs only the **Databricks CLI**.

### 2.1 Install Git

- **Windows:** download from https://git-scm.com/download/win, or `winget install Git.Git`
- **macOS:** `xcode-select --install` (or `brew install git`)

Check it: `git --version`

### 2.2 Install Python

- **Windows:** https://www.python.org/downloads/ (tick **"Add python.exe to PATH"** in the installer), or `winget install Python.Python.3.12`
- **macOS:** `brew install python@3.12`

Check it: `python --version` (on macOS/Linux you may need `python3`)

### 2.3 Install the Databricks CLI

- **Windows:** `winget install Databricks.DatabricksCLI`
- **macOS:** `brew tap databricks/tap` then `brew install databricks`
- **Linux / macOS without Homebrew:** `curl -fsSL https://raw.githubusercontent.com/databricks/setup-cli/main/install.sh | sh`

**Close and reopen the terminal** after installing so it picks up the new `PATH`, then check:

```
databricks --version
```

It should print `Databricks CLI v1.18.0` or newer.

> **Only have the CLI that came with the VS Code extension?** That's fine. Find its path and point the script at it: `set DATABRICKS_CLI_PATH=C:\path\to\databricks.exe` (cmd), `$env:DATABRICKS_CLI_PATH="C:\path\to\databricks.exe"` (PowerShell), or `export DATABRICKS_CLI_PATH=/path/to/databricks` (bash).

---

## 3. What the Databricks workspace must have

Check these with your workspace admin **before** the first run. The script stops with the platform's own error message at the first missing permission, so you won't break anything, but it saves time to know up front.

| Feature | Why | How to check |
|---|---|---|
| **Unity Catalog** | All tables and views | Left sidebar → **Catalog** shows your catalogs |
| A **SQL warehouse**, Serverless or Pro | Runs all SQL; Genie requires Serverless or Pro | Sidebar → **SQL Warehouses** |
| **Genie** | The natural-language space | Sidebar → **Genie** |
| **Genie Agent mode** | The app's "Agent" button | Open any Genie space; the question box has an **Agent** option. If it's missing, Chat mode still works but Agent questions will fail |
| **Databricks Apps** | Hosts the web app | Sidebar → **Compute → Apps** tab |
| **Lakebase Postgres** | Chat history, sessions, usage log | Sidebar → **Compute → Lakebase / Database** (or ask the admin whether Lakebase is enabled) |
| *(optional)* A chat model endpoint, e.g. `databricks-meta-llama-3-3-70b-instruct` | Names chat sessions automatically | Sidebar → **Serving**. If missing, sessions are named from the question text instead |

**Permissions you need** (a workspace admin has all of them):

- `USE CATALOG` and `CREATE SCHEMA` on the target catalog (or `CREATE CATALOG` if you set `create_catalog: true`)
- `CAN_USE` on the SQL warehouse
- Permission to create Genie spaces, Databricks Apps and Lakebase projects
- `CAN_MANAGE` on the Lakebase project the script creates (you get this automatically as its creator)

**Network (important on corporate laptops):** the script connects to Lakebase over **PostgreSQL port 5432** at `*.database.<region>.cloud.databricks.com`. Some corporate networks and VPNs block outbound 5432. If the `lakebase` step times out, see [Troubleshooting](#10-troubleshooting).

---

## 4. Get the code

```
git clone https://github.com/<your-github-user>/lenss-collections.git
cd lenss-collections
```

(Or on GitHub click **Code → Download ZIP**, unzip, and `cd` into the folder.)

**Run every command in this guide from this project root folder**, the one containing `README.md` and `deploy/`.

---

## 5. Install the Python packages

Using a virtual environment is recommended, so this project's packages don't clash with anything else:

| Terminal | Commands |
|---|---|
| cmd | `python -m venv .venv` then `.venv\Scripts\activate.bat` |
| PowerShell | `python -m venv .venv` then `.venv\Scripts\Activate.ps1` |
| bash | `python3 -m venv .venv` then `source .venv/bin/activate` |

If PowerShell says *"running scripts is disabled on this system"*, use Command Prompt for these steps instead (or skip the virtual environment).

Then install:

```
pip install -r deploy/requirements.txt
```

**Check:** `python -c "import pandas, openpyxl, psycopg2, requests; print('ok')"` prints `ok`.

> **Behind a corporate proxy?** `pip install --proxy http://<proxy>:<port> -r deploy/requirements.txt`

---

## 6. Log the CLI in to the workspace

You create a named **profile**, and the config file refers to it by name. Replace the URL with your workspace's address, which is everything up to `.com` in the browser bar.

### Option A — browser login (OAuth), recommended

```
databricks auth login --host https://<your-workspace>.cloud.databricks.com --profile lenss-org
```

A browser window opens. Sign in and approve, then return to the terminal.

### Option B — personal access token (use this if the browser login does nothing)

1. In the workspace: click your avatar (top right) → **Settings → Developer → Access tokens → Generate new token**. Copy it.
2. Run:
   ```
   databricks configure --profile lenss-org
   ```
   Paste the host when asked, then the token.

**Check (both options):**

```
databricks current-user me --profile lenss-org
```

It should print JSON containing your `userName` (email). If it errors, fix this before going further.

---

## 7. Point the config at your workspace

Configs live in `deploy/config/`:

| File | What it is |
|---|---|
| `personal.json` | The original Free Edition workspace this was built in. Don't use it for a new workspace |
| `org.json` | A template for an organisation workspace. **Edit this one**, or copy it to a new name such as `deploy/config/myteam.json` |
| `org-v2.json` | A template for a second version running next to the first (section 11.1) |
| `org2-v2.json` | The current organisation deployment, app `lenss-collections-v2` (catalog `collectionanalytics1`, profile `lenss-org2`) |

`org2.json` (the first app in that organisation workspace) exists only on the laptops that deploy it and is deliberately kept out of git.

Open it in any editor (Notepad works):

```json
{
  "profile": "lenss-org",
  "catalog": "cnx_automl_dev",
  "create_catalog": false,
  "schema_prefix": "lenss_collections",
  "warehouse_id": null,
  "warehouse_name": "Starter Warehouse",
  "genie_space_title": "LensS Collections Analytics",
  "lakebase_project": "lenss-collections-app",
  "lakebase_database": "chatapp",
  "app_name": "lenss-collections",
  "readers_group": null
}
```

| Field | What to put | Notes |
|---|---|---|
| `profile` | The profile name from step 6 (`lenss-org`) | `null` means "use `DATABRICKS_HOST` / `DATABRICKS_TOKEN` environment variables instead" |
| `catalog` | An existing catalog you can create schemas in | |
| `create_catalog` | `false` for a shared/org catalog, `true` to have the script create it | Creating catalogs usually needs admin rights |
| `schema_prefix` | Leave as `lenss_collections` | Schemas become `<prefix>_bronze`, `_silver`, `_gold`, `_context`. Change it only to run a second copy side by side |
| `warehouse_id` **or** `warehouse_name` | Which SQL warehouse to use | Find the ID with `databricks warehouses list --profile lenss-org`, or in the UI under **SQL Warehouses → your warehouse → Overview**. If both are `null`, the first warehouse found is used |
| `genie_space_title` | Name of the Genie space | Re-runs find the space by this title, so keep it stable |
| `lakebase_project` | Lakebase project name | lowercase letters, digits, hyphens |
| `lakebase_database` | Leave as `chatapp` | |
| `app_name` | The app's name, which becomes part of its URL | lowercase letters, digits, hyphens; must be unique in the workspace |
| `readers_group` | *(optional)* A workspace group, e.g. `"lenss-users"` | Gets **only** `CAN_USE` on the app: no access to the Genie space, warehouse, tables or Lakebase (see 9.1) |
| `title_endpoint` | *(optional, not in the file by default)* Chat model endpoint used to name sessions | Off by default: sessions are named from their first question. To turn it on, set it to a chat model endpoint that exists, e.g. `"databricks-meta-llama-3-3-70b-instruct"` |
| `answer_cache`, `prewarm_suggestions` | *(optional)* `true` / `false` | Both default to `true`. See 9.4 |
| `semantic_cache` | *(optional)* `{ "threshold": 98, "embedding_model": "databricks-gte-large-en" }` | Reuses a cached answer when a question means the same as a cached one. Threshold as `98` or `0.98`. **Left out = off.** See 9.5 |
| `guardrails` | *(optional)* model plus an action per input and output check | Screens questions and answers. **Left out = off.** See 9.5 |
| `faithfulness_judge` | *(optional)* `{ "model": "databricks-gpt-oss-120b", "sample_percent": 100, "warn_below": 70 }` | Scores each answer's faithfulness, relevance, completeness and safety; answers below `warn_below` (%) show a warning. **Left out = off.** See 9.5 |
| `follow_ups` | *(optional)* `{ "model": "databricks-meta-llama-3-3-70b-instruct" }` | Tops up suggested follow-up questions to three after each answer. **Left out = only the engine's own suggestions.** See 9.6 |
| `auto_mode` | *(optional)* `{ "method": "ai", "model": "databricks-meta-llama-3-3-70b-instruct" }` or `{ "method": "rules" }` | How **Auto** picks Quick answer or Deep analysis. `ai`: a small model reads each question (about 2 s, about 250 tokens), with the word rule as fallback. `rules`: a word rule, no model. **Left out = `ai` with the guardrail classifier's model if there is one, else `rules`.** `personal.json` uses `rules` to keep model calls down. See 9.5 |
| `platform_help` | *(optional)* `{ "enabled": true, "method": "ai", "model": "databricks-meta-llama-3-1-8b-instruct" }`, `{ "method": "guide" }`, or `{ "enabled": false }` to send every question straight to the query engine | Questions about LensS itself (what it is, the tabs, navigation, how answers are checked) are answered from the platform guide instead of the query engine, which only knows the data. `ai`: a small model answers from the guide (about 8 s, about 2,500 tokens, only for such questions). `guide`: the guide's own sections, no model. **Left out = `ai` with the follow-up or guardrail model, else `guide`.** See 9.5 |
| `conversation_memory` | *(optional)* `{ "enabled": true, "compact_every": 5, "model": "databricks-meta-llama-3-1-8b-instruct" }` or `{ "enabled": false }` | Follow-up questions carry the conversation so far: a summary of older turns plus the recent turns, across both modes and including cached and platform answers. Every `compact_every` questions in a chat, older turns are summarised (by the model, about 700 tokens, after the answer is sent; or a no-model digest). **Left out = on, every 5, with the follow-up or guardrail model.** `false` = only the query engine's own conversation for that mode. Needs the `lakebase` step (two columns on `chat_sessions`). See 9.5 |
| `evals` | *(optional)* `{ "max_accuracy_cases": 10 }` | Turns on the **Evals** tab; caps how many ground-truth questions one run asks. **Left out = off.** See 9.6 |
| `pricing` | *(optional)* `{ "databricks-gpt-oss-120b": { "input": 0.15, "output": 0.6 } }` | USD per million tokens per endpoint, from your price sheet, so Monitoring can estimate cost. **Left out = tokens only** |

**Models.** The three optional AI features call Databricks model serving endpoints (Foundation Model APIs). Enable the models you want in the workspace yourself (sidebar → **Serving**). The `app` step checks that each configured endpoint exists, binds it to the app with **Can query** (no keys), and prints whether each feature is on. If an endpoint is missing, it warns and leaves that feature (or that model) off instead of failing.

| Feature | Recommended for the org workspace | Lightweight choice (used in `personal.json`) |
|---|---|---|
| Semantic cache embeddings | `databricks-gte-large-en` | the same: embeddings are cheap |
| Guardrail classifier | `databricks-meta-llama-3-3-70b-instruct` (more accurate) | `databricks-meta-llama-3-1-8b-instruct` |
| Faithfulness judge | `databricks-gpt-oss-120b`, or a Claude Sonnet endpoint if your workspace has one | `databricks-gpt-oss-20b` |
| Follow-up suggestions | `databricks-meta-llama-3-3-70b-instruct` | `databricks-meta-llama-3-1-8b-instruct` |

Use a non-reasoning chat model for the guardrail classifier (Llama, not gpt-oss). It only has a few dozen tokens to reply in, and reasoning models spend those on thinking.

---

## 8. Deploy — the one command

```
python deploy/deploy.py --config deploy/config/org.json
```

(Use your own file name if you copied the config.)

Output looks like this. Each step prints as it goes:

```
[10:00:01] Authenticated as you@company.com
[10:00:02] Using warehouse Starter Warehouse (abcd1234…)
[10:00:02] === schemas ===          creates the 4 schemas + volume                     ~20 s
[10:00:22] === ingest ===           uploads the workbook, loads all 11 sheets           ~3 min
[10:03:30] === context ===          governance tables                                   ~20 s
[10:03:50] === transform ===        silver, gold config, 2 metric views, 16 views       ~1 min
           Transform done — sanity check: qry_immediate_intervention = 604 accounts (604 expected for the demo pack)
[10:05:00] === summary ===          writes the Command Center's executive summary         ~30 s
[10:05:30] === genie ===            creates or updates the Genie space                   ~5 s
[10:05:05] === lakebase ===         Postgres project, database, tables                   ~1–2 min the first time
[10:06:30] === app ===              creates the app, grants access, uploads and builds   ~2–5 min the first time
[10:10:00] App live at https://lenss-collections-<id>.<region>.databricksapps.com
[10:10:00] === smoke ===            skipped unless you set up a test identity (step 9.2)
[10:10:00] Done in 600s. App: https://…
```

**Check:** the last line says `Done` and prints the app URL. On failure it prints `FAILED:` with the reason. Fix the cause (see [Troubleshooting](#10-troubleshooting)) and run the same command again.

**Re-running is always safe.** Every step creates things if they are missing and updates them if they exist. Nothing is deleted or duplicated.

### Running only some steps

```
python deploy/deploy.py --config deploy/config/org.json --only app
python deploy/deploy.py --config deploy/config/org.json --only ingest,transform
python deploy/deploy.py --config deploy/config/org.json --skip smoke
```

Steps, in order: `schemas, ingest, context, transform, summary, genie, lakebase, app, smoke`. The `app` step needs `genie` and `lakebase` to have run at least once on this laptop, because it reads their IDs from `deploy/.state/<config-name>.json`. On a new laptop, run the full command once. It re-finds everything that already exists instead of creating duplicates.

---

## 9. After the deploy

### 9.1 Open the app and give people access

1. Open the URL printed at the end. You'll sign in with your normal Databricks login.
2. Give other people access: workspace sidebar → **Compute → Apps → (your app) → Permissions → Add** → the user or group → **Can use**. Setting `readers_group` in the config does this for a whole group on every deploy.

   **App access is the only permission people need.** Don't grant them the Genie space, the SQL warehouse or the tables: the app reads data and calls Genie as its own service principal. Someone with only **Can use** on the app can use everything in it, but is refused (`403`) if they try to open the Genie space, read the gold tables or run SQL directly. This was verified with an identity that has nothing but **Can use** on the app. Give app users only the **Consumer access** entitlement, not Workspace access: that's confirmed to be enough to open and use the app. Users get a simplified Databricks view with no notebooks, SQL editor or compute.

   **Recommended setup:** one group (e.g. `lenss-users`) with Consumer access and **Can use** on the app. Adding a person later means only adding them to the group:
   1. **Settings → Identity and access → Groups → Add group** → `lenss-users`.
   2. Add the people to the group. In an organisation, use an account group synced from the company identity provider (e.g. Entra ID) and assign it to the workspace.
   3. Give the group (or each user) the **Consumer access** entitlement only.
   4. Set `"readers_group": "lenss-users"` in the config and run `--only app`; this grants the group **Can use** on the app. Or do it by hand: **Apps → (your app) → Permissions → add the group → Can use**.
3. People who aren't in the workspace yet must first be added by an admin (**Settings → Identity and access → Users**). For people outside the company this goes through your identity provider (SSO/SCIM). Databricks Apps **cannot** be made public or anonymous; everyone signs in.

Every user gets their own private chat history. The **Monitoring** tab shows usage across all users.

### 9.2 (Optional) Automatic end-to-end test

The `smoke` step asks real questions through the deployed URL as a separate, non-admin identity. That catches permission problems that don't show up when you test as yourself. To enable it once:

1. **Settings → Identity and access → Service principals → Add service principal**, named e.g. `lenss-smoke-test`.
2. Open it → **Secrets → Generate secret**. Copy the **client ID** and the **secret** (the secret is shown only once).
3. On the same page → **Configurations / Entitlements** → tick **Workspace access**. Without this the app answers `401` even with a valid token.
4. The app → **Permissions** → add the service principal with **Can use**.
5. Set the two values in your terminal, then run the smoke step:

| Terminal | Commands |
|---|---|
| cmd | `set LENSS_SMOKE_CLIENT_ID=<client id>` then `set LENSS_SMOKE_CLIENT_SECRET=<secret>` |
| PowerShell | `$env:LENSS_SMOKE_CLIENT_ID="<client id>"` then `$env:LENSS_SMOKE_CLIENT_SECRET="<secret>"` |
| bash | `export LENSS_SMOKE_CLIENT_ID=<client id>` then `export LENSS_SMOKE_CLIENT_SECRET=<secret>` |

```
python deploy/deploy.py --config deploy/config/org.json --only smoke
```

It ends with `23/23 checks passed`. It covers the UI, the dashboard and executive summary, the suggested questions, the answer cache (a repeated suggested question is served from the cache, and Refresh replaces it with a live answer) and the Command Center cache, Chat and Agent questions, the personal-data refusal, charts, session naming, history, 👍/👎 feedback (including delivery to Genie), the Monitoring audit trail, rename/delete and monitoring. The Agent questions take 1–2 minutes each.

**Never commit the secret** or paste it into a file in this folder.

### 9.3 Things to try in the app

- **Command Center**, one story in five chapters, each opening with its answer in one sentence written from the data. The story bar under the banner jumps between chapters.
  1. **Are we on track?** The verdict (on track / within reach / at risk), progress to target with days left, and tiles for still to collect, expected from promises, month-end outlook and likelihood. Underneath: how the outlook is worked out, as a plain sum with the real figures, and **Data refreshed on**.
  2. **How healthy is the book?** Five vital signs (overdue balance, recovery rate, high-risk accounts, accounts worsening, cost to collect), five more on demand, and the arrears-stage snapshot.
  3. **What is holding us back?** Five issues ranked by risk and money, each with its likely driver. Broken promises comes first, with this month's 3,945 promises shown as one bar (kept, broken, due this week, at risk, later). Rates throughout the page say what they are out of ("1,234 of 1,886").
  4. **What should we do this week?** Four work queues numbered Today → This month.
  5. **What more can we recover from high-risk customers?** Beyond this week's plan: the 604 high-risk customers still likely to pay, what they are worth by product, the accounts worth the most, and one next step for each.
- **View accounts:** every card, issue, queue, stage and next step opens the exact accounts behind its number, with totals and **Export CSV**.
- **Ask LensS:** each issue, queue and panel has an **Ask LensS** button; hover it to see the question it will ask.
- **KPI definitions** (in the banner and at the foot of the page): what each figure means and how it is calculated.
- **Explorer:** filters (product, arrears stage, region, channel, strategy, driver, team, balance band, vulnerability, contact and promise dates); 12 KPI tiles compared with the whole portfolio; a dimension × measure workspace; diagnostic panels (achievement, shortfall, heatmap, drivers, strategies, funnel, channels, regions, collectors); the accounts behind the numbers with CSV export. Every chart item has **View** to open its accounts; heatmap cells are clickable.
- **Assistant:**
  - **Layout:** a full-screen chat in the style of Microsoft Copilot. The chat list (New chat, Search, Chats) is on the left and can be collapsed. The lightbulb (top right) opens suggested questions.
  - **Modes:** **Auto** (the default) chooses per question; **Quick answer** (~20 s); **Deep analysis** (step by step with charts and recommendations, 1–3 min). A follow-up to a deep analysis stays deep.
  - **Conversation:** follow-ups such as "which of those is the lowest?" are understood; older turns are summarised every 5 questions.
  - **About LensS:** questions about the platform itself ("What is LensS?", "How do I filter in the Explorer?") are answered from the platform guide.
  - **Under each answer:** copy, 👍/👎, regenerate and **Details** (quality score, sources, safety checks, how the answer was made). Charts have **Chart / Table / SQL** tabs; tables that came back empty are replaced by a one-line reason.
  - **PDF:** saves the conversation as it looks on screen.
- **Observability:** seven areas: pipeline traces, answer quality and faithfulness, performance and latency, data and model drift, security and guardrails, evaluations, Responsible AI. Service accounts show as "Automated test"; no internal IDs are shown.
- **Loading:** the Command Center loads first (its data is prepared when the app starts); the Explorer and Observability then load in the background, so they open instantly.
- **Currency:** all amounts are in Indian rupees (₹), matching the data model.
- **Answer cache:** within about 10 minutes of a deploy that changed the data, the app answers the 10 suggested questions in the background. Clicking one then shows the answer at once, marked **⚡ Answered from cache**, with **↻ Refresh** to ask again live. See 9.4.

### 9.4 The answer cache

The app keeps answers in Lakebase so repeated questions don't wait for Genie again. It needs no setup; the `lakebase` step creates the tables.

- **What's cached:** the Command Center numbers (in memory, until the data changes), the 10 suggested questions (pre-warmed after each data or Genie change), and the first question of each chat (24 hours). Follow-up questions always go to Genie.
- **When it refreshes:** every step that changes the data or Genie records a new version, and older answers are never served again. You don't need to clear anything by hand. To force fresh answers without new data, run `python deploy/deploy.py --config <config> --only summary`.
- **When pre-warming runs:** it doesn't run on every restart. It runs once per data/Genie version, about 2–12 minutes after a deploy that changed them, and takes about 10 minutes (the Agent questions are the slow part). Progress shows under **Monitoring → Answer cache → Last pre-warm**.
- **A wrong cached answer:** 👎 removes it from the cache, and **↻ Refresh** asks Genie again.
- **Turning it off:** in your config file (step 7), set `"answer_cache": false` (no answer caching or pre-warm) or `"prewarm_suggestions": false` (caching, but no pre-warm), then run `--only app`. Both default to `true`. The Command Center cache is always on.

The design is in `DATABRICKS_IMPLEMENTATION_GUIDE.md`, Step 8e.

### 9.5 Semantic cache, guardrails, faithfulness judge and notifications

The first three are switched on per workspace in the config (step 7); leaving a section out turns it off. Check what's on under **Monitoring → Guardrails and answer quality**.

**Semantic cache** (`semantic_cache`)
- **When it applies:** a standalone question that isn't an exact repeat can reuse the answer to a cached question that means the same. Two conditions:
  - the similarity is at least the threshold;
  - the key details match exactly: numbers and DPD buckets, products, channels, strategies, what it's broken down by, and best vs worst.
- **Example:** "Which accounts need immediate intervention?" reuses "Which accounts require immediate intervention?" (98.9% similar). "Recovery for 31-60" never reuses "recovery for 61-90".
- **What users see:** **⚡ Answered from cache · similar to "…"**, with **↻ Refresh** as usual.
- **Choosing a threshold:** 98–99 only catches close rewordings, which is the safe end. Every cache miss records the closest cached question and its similarity in the audit trail, so you can see what a lower threshold would have matched before changing it.

**Guardrails** (`guardrails`)
- **Questions**, checked before the cache and Genie. A blocked question never reaches Genie.

  | Check | How it's detected | Actions |
  |---|---|---|
  | `pii` | Patterns: emails, phone numbers, card numbers, Aadhaar, PAN, SSN, IBAN. Account IDs are fine | `redact` (mask it and answer) or `block` |
  | `profanity` | A word list plus the model | `block`, `warn` or `off` |
  | `prompt_injection` | Patterns plus the model | `block`, `warn` or `off` |
  | `off_topic` | The model | `warn` (answer and log it), `block` or `off` |

- **Answers**, checked before they're sent:
  - `pii` and `profanity`: `redact`.
  - `policy_checks` flags "would deliver X uplift" wording, month-end forecasts, cure rate and probabilities of hitting target. Use `flag` to log only, `warn` to also show the user a caution, or `off`.
- **No model?** Without `model`, only the pattern checks run. If the model call fails, the question goes ahead; a classifier failure never blocks anyone.
- **In Monitoring:** counts by check and action, recent events, and the checks that fired on each question in the audit trail.

**Faithfulness judge** (`faithfulness_judge`)
- **When it runs:** after each live answer, in the background, so it adds no wait.
- **Numbers check** (no model): every figure in the answer is looked up in the query results. It accepts each cell, column totals, subtotals by group (for example "the 180+ bucket across all products" = the 180+ rows added up), both ends of a range ("0.15–0.54%"), the business-rule thresholds Genie is given (0.70 risk, 0.25 propensity, 4.5 contacts, 7 days and so on) and figures the person typed in the question. Anything else is listed under "Figures not found in the results".
- **Judge model:** scores how well the factual claims are supported and lists any unsupported ones. It doesn't judge recommendations.
- **Final score** is the average of the two.
- **Cached answers** show the score from when they were generated, so they aren't judged again.
- **Cost control:** `sample_percent` judges only some answers.
- **In Monitoring:** a **Faithfulness** KPI with the judge model's name, a **Faithful** column in the audit trail, and the details (figures not found, unsupported claims, tokens used) in each row.

**Auto mode** (`auto_mode`)
- **What it does:** when the mode menu is on **Auto**, each question is first sent to `POST /api/chat/route`, which answers Quick answer or Deep analysis with a short reason. The browser shows "Choosing quick answer or deep analysis…" meanwhile.
- **`ai`:** a small model classifies the question (any language). If it's slow (over `timeout_ms`, default 6000) or its reply can't be read, the word rule decides instead, so a question is never held up.
- **`rules`:** reasoning words (why, what should, recommend, compare, root cause, prioritise, explain…) or more than 22 words → Deep analysis; plain lookups ("which…", "show…", "top 10…") → Quick answer.
- **Where it shows:** each question's trace in Observability records the decision, the method and the reason; the classifier's tokens are counted under "Auto mode router"; the Responsible AI page and the models list say which method is on.
- **Not affected:** picking Quick answer or Deep analysis yourself, and prompts that carry their own mode (quick-start, library, Command Center and Explorer links).

**Platform questions** (`platform_help`)
- **What it does:** "What is LensS?", "What tabs are there?", "How do I filter by region?", "Where can I see the SQL?" are answered from the platform guide (`server/lib/platformGuide.ts`), with a note "From the LensS platform guide, not the collections data" and platform follow-up questions. Auto sends them to Quick answer.
- **Data questions are untouched:** a cheap word check only lets questions that mention the platform through; with `ai`, the model also hands back any data question (it replies `DATA_QUESTION`) and it goes to the query engine as usual. Guardrails still run first; only an off-topic flag is lifted for a platform question.
- **Keeping it right:** the guide is the only source these answers may use, so update it when the UI changes. It holds no data figures, so reloading data never makes it stale.
- **Where it shows:** the trace in Observability says the question was answered from the guide and which sections; tokens count under "Platform questions"; Responsible AI lists the feature.

**Conversation memory** (`conversation_memory`)
- **Why:** the query engine remembers only its own conversation for one mode. Answers from the cache, from the platform guide or from the other mode never reach it, so "tell me more about this" used to arrive with no context.
- **What follow-ups are sent with:** "Context from earlier in this conversation…", then the session summary (if any) and the recent questions and answers (answers trimmed), then the new question. The first question of a chat and suggested questions are sent on their own (and can use the answer cache).
- **Compaction:** after every `compact_every` questions, the older turns are folded into a summary stored on the session (`context_summary`); the last two turns stay word for word. It runs after the answer is sent.
- **Platform follow-ups:** "tell me more", "explain that", "my previous question" right after a platform answer go back to the platform guide, which then shows the parts not covered yet.
- **Where it shows:** each question's trace says how many earlier questions were carried (and how many summarised); summary tokens count under "Conversation memory".

**Notifications** (no config)
- **When:** an answer finishes while the person is on another tab or another chat.
- **What:**
  - an in-app **Answer ready** toast with **View**;
  - if the browser tab is in the background, also a browser notification and a "(1)" in the tab title.
- **Permission:** the app offers to turn browser notifications on once, on the first question.
- **Limit:** notifications work while the page is open.

### 9.6 Answer trust, Evals, Responsible AI, feedback review, voice and branding

**Under every answer** (needs `faithfulness_judge` for the score)
- **Trust bar:**
  - **Quality chip:** **✓ Verified · 96%** (green 85% and up, amber above `warn_below`, red below). It reads **Checking accuracy…** for the few seconds the judge takes after the answer arrives.
  - **Other chips:** how many certified data sources were used, and whether personal details were masked or another safety check acted.
- **How this answer was made:**
  - the four quality scores with the judge's reason and any unsupported claims;
  - the data sources and each SQL query;
  - the safety checks;
  - a request trace showing where the time went;
  - the AI models and tokens used.
- **Low confidence:** below `warn_below`, a red box lists what couldn't be verified. It's in the PDF too.
- **Follow-up questions:** up to three buttons after the answer. They come from the engine and, with `follow_ups` set, a small model.

**Evaluations** (Observability → 6. Evaluations; config `evals`)
- **Running it:** choose the categories and press **Run evals**. Results appear as each case finishes. Run history shows the scores of each run and the change from the previous one.
- **The cases** (seeded by the `lakebase` step from `deploy/evals/cases.py`; switch any off in the tab):
  - **Accuracy:** the Genie benchmark questions, asked live. The figures returned are compared with the ground-truth SQL's, then the answer is scored by the judge. Each one costs a query-engine answer plus a judge call, so `max_accuracy_cases` caps them per run.
  - **Guardrails:** red-team prompts that must be blocked or cleaned, and normal questions (including Hindi and Spanish) that must get through. These use only the classifier model.
  - **Policy:** answer sentences the output checks must flag, clean or leave alone. No model is used.
- **Adding cases:** add them in `deploy/evals/cases.py` and re-run `--only lakebase`, or from the feedback queue (below).

**Feedback review** (Monitoring)
- **What users see:** 👎 asks what was wrong (wrong numbers; wrong products, buckets or filters; didn't answer; hard to understand; something else) with an optional note.
- **What reviewers do:** each one waits under **Monitoring → Feedback review**, where a reviewer marks it **Fixed** or **Dismiss**, or **Add to evals**, which turns the question into an accuracy case.

**AI usage and cost** (Monitoring)
- **Tokens:** by feature and model, for questions and eval runs. The query engine's own usage is billed with the SQL warehouse and isn't counted here.
- **Cost:** add `pricing` to the config to see estimated cost.

**Responsible AI** (Observability → 7. Responsible AI; no config)
- **What it covers:**
  - purpose and intended use;
  - each AI model, when it runs and whether it's on;
  - the certified data sources;
  - the protections in force, with counts;
  - how quality is measured (including the latest eval run);
  - data handling, known limitations, and an alignment table for NIST AI RMF and the EU AI Act.
- **Live:** it reads the live configuration, so it always matches what's deployed.

**Voice input**
- **Using it:** the 🎤 button in the question box dictates the question in the browser's language.
- **Browsers:** Chrome and Edge; the button is hidden elsewhere. The browser asks for microphone permission once.

**Branding**
- **Logos:** they're in `appkit-genie-app/public/img/`. To replace one, overwrite the file with the same name and redeploy with `--only app`.
  - `concentrix-logo.png` is the full wordmark, used in the header and on the PDF's first page.
  - `cnx-mark.png` is the small mark, used as the assistant's avatar in chats.
  - `favicon.png` is the browser-tab icon.
- **No vendor names:** the app doesn't name the underlying platform anywhere users look.

---

## 10. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Databricks CLI not found` | CLI not installed, or the terminal was opened before installing | Reopen the terminal; or set `DATABRICKS_CLI_PATH` (step 2.3) |
| `unknown command "postgres"` or `"genie"` | CLI too old | Upgrade: `winget upgrade Databricks.DatabricksCLI` / `brew upgrade databricks` |
| `databricks auth login` opens nothing / hangs | Browser OAuth blocked on this machine | Use Option B (token) in step 6 |
| `FAILED: … PERMISSION_DENIED … CREATE SCHEMA` | Missing catalog privileges | Ask an admin for `USE CATALOG` + `CREATE SCHEMA` on the catalog, or point `catalog` at one you own |
| `No matching SQL warehouse found` | `warehouse_name` doesn't match exactly | Use `warehouse_id` from `databricks warehouses list --profile <p>` |
| `Workbook not found` | Running from the wrong folder, or the xlsx was not downloaded | `cd` to the project root; check `all_details_and _data/LensS_Collections_Demo_Development_Pack.xlsx` exists |
| `No Postgres role for <you>` | You don't manage the Lakebase project (someone else created it) | Ask its owner for `CAN_MANAGE`, or set a different `lakebase_project` name |
| `lakebase` step hangs, or `could not connect to server … 5432` | Corporate network/VPN blocks PostgreSQL port 5432 | Try off VPN or another network, or ask IT to allow outbound 5432 to `*.cloud.databricks.com`. Every other step works without it: run `--skip lakebase` for the rest, then run `--only lakebase,app` from a network that allows 5432 |
| App URL shows "App not running", or `Cannot deploy app … not in RUNNING state` | The app's compute was stopped (idle policy or workspace quota) | Re-run `--only app`: it starts the app before deploying. Or **Apps → (your app) → Start** |
| `App deployment did not succeed` | Build or start failure on the Databricks side | Workspace → **Apps → (your app) → Logs** shows the npm/Node error |
| App opens but Agent answers "Sorry — that question couldn't be answered" | Agent mode not enabled in this workspace, or the app lost its grants | Check that Agent mode exists in Genie (section 3); re-run `--only app`, which re-applies the grants |
| Smoke test: `401` for the service principal | Missing **Workspace access** entitlement | Section 9.2, step 3 |
| Sessions are named after the question instead of a short title | Expected: `title_endpoint` is off by default | To use a model for titles, set `title_endpoint` to a chat model that exists (sidebar → **Serving**) and re-run `--only app` |
| Command Center says "No executive summary yet" | The `summary` step hasn't run in this workspace | `python deploy/deploy.py --config <config> --only summary`. Re-run it whenever the data changes |
| An answer looks out of date | It came from the answer cache (it shows **⚡ Answered from cache**) and the data changed without a deploy step | Click **↻ Refresh** under it, or re-run `--only summary` to invalidate every cached answer |
| Suggested questions aren't instant after a deploy | Pre-warming hasn't finished: it starts ~2 min after the versions settle and takes ~10 min | Check **Monitoring → Answer cache → Last pre-warm**; if it says `failed`, the app logs show which question Genie didn't answer, and it retries within the hour |
| `WARNING: serving endpoint '…' not found` during `--only app` | The model in `semantic_cache`, `guardrails` or `faithfulness_judge` isn't enabled in this workspace | Enable it under **Serving** (or change the name in the config to one that exists), then re-run `--only app`. Until then that feature runs without the model, or stays off |
| Faithfulness shows "Judge model error" in Monitoring | The judge model timed out or replied without valid JSON | The numbers check still scores the answer. A larger judge model is more reliable, as is lowering `sample_percent` if it's being rate-limited |
| Warehouse takes minutes on the first command | Warehouse was stopped; the script starts it | Wait. Serverless starts in seconds, Pro in a few minutes |
| `git pull`: *Your local changes to … app.yaml would be overwritten* | `deploy.py` rewrites `appkit-genie-app/app.yaml` on every app deploy, so each laptop has its own copy | Safe to discard: `git checkout -- appkit-genie-app/app.yaml`, then `git pull`. The next deploy writes it again |
| `Cannot update app … compute is in STARTING state`, or *a pending deployment in progress* | The app was starting (e.g. after an idle stop) or another deploy is running | Wait a few minutes until **Apps → (your app)** shows Running, then re-run `--only app` |
| Command Center shows no "Data refreshed on" line | The `summary` step hasn't run since v1.9 (it now records when the data was loaded) | `--only summary` |
| Smoke test crashes with `UnicodeEncodeError … '\u20b9'` on Windows | The console can't print ₹ | Run it with `set PYTHONIOENCODING=utf-8` first |

---

## 11. Updating later

| You changed… | Run |
|---|---|
| Pulled new code from GitHub (`git pull`) | `--only app` if only the app changed; the CHANGELOG entry for each version says which steps it needs (e.g. v1.8 needs `lakebase` once) |
| The app (`appkit-genie-app/`) | `--only app` |
| Genie instructions / examples / benchmarks (`deploy/genie/space.py`) | `--only genie` |
| The workbook (new data, same sheets) | `--only ingest,transform,views,summary` (this also invalidates the answer cache and pre-warms again) |
| Any SQL in `deploy/sql/` | `--only context,transform` |
| The Command Center and Explorer views (`deploy/sql/70_command_center_views.sql`) | `--only views,genie,app` |

Deploying to **another workspace** is the same procedure: a new CLI profile (step 6), a new config file (step 7), and run it. Each config keeps its own IDs in `deploy/.state/<config-name>.json`, which stays on your laptop and is not committed.

---

### 11.1 Running a new version next to the existing one

To give people a new version without replacing the one they use, deploy it as a second app with its own config. `deploy/config/org-v2.json` is ready for this. It is `org.json` with three names changed:

| Field | v1 (`org.json`) | v2 (`org-v2.json`) | Why it must differ |
|---|---|---|---|
| `app_name` | `lenss-collections` | `lenss-collections-v2` | A second app with its own URL and service principal |
| `genie_space_title` | `LensS Collections Analytics` | `LensS Collections Analytics v2` | The deploy finds the space by title; the same title would overwrite v1's instructions and examples |
| `lakebase_database` | `chatapp` | `chatappv2` | A separate database in the same Lakebase project, so the two versions don't share chat history, cache or logs. Lowercase letters, digits and hyphens only (no underscores) |

Everything else, including the catalog, gold schema, warehouse and models, is shared and read-only, so both versions answer from the same data. The deploy keeps a separate state file per config (`deploy/.state/org-v2.json`), so nothing in v1's state is touched.

1. `git pull` on the laptop that deploys to the org.
2. Enable the models `org-v2.json` names, under **Serving** in the workspace.
3. Deploy only what v2 needs:
   ```bash
   python deploy/deploy.py --config deploy/config/org-v2.json --only genie,lakebase,app
   ```
   Don't run `schemas`, `ingest` or `transform`. They rebuild the shared data that v1 also reads. `views` and `summary` are safe on the shared gold schema (they only add views and rewrite the same summary from the same data). For later releases, the organisation deployment uses:
   ```bash
   python deploy/deploy.py --config deploy/config/org2-v2.json --only lakebase,views,summary,genie,app
   ```
4. If the deploy prints a `GRANT USE CATALOG …` warning, an admin runs that one statement for the new app's service principal.
5. Open the URL printed at the end and give people access (`readers_group`, or **Permissions** on the app).

Both apps then run side by side. To retire v1 later, delete the `lenss-collections` app, and optionally its Genie space and the `chatapp` database.

## 12. (Optional) Run the app on your laptop for development

Only needed to change the app and see the result before deploying. It needs **Node.js 22+** and a completed deploy (it uses the same Genie space, warehouse and Lakebase).

```
cd appkit-genie-app
npm install
```

Set these environment variables, using values from `appkit-genie-app/app.yaml` (written by the last deploy) and your profile. `DATABRICKS_CONFIG_PROFILE=lenss-org` works in place of host + token:

```
DATABRICKS_HOST, DATABRICKS_TOKEN (or DATABRICKS_CONFIG_PROFILE)
DATABRICKS_GENIE_SPACE_ID, DATABRICKS_WAREHOUSE_ID, LENSS_GOLD_SCHEMA
PGHOST, PGDATABASE=chatapp, PGPORT=5432, PGSSLMODE=require, LAKEBASE_ENDPOINT
DATABRICKS_APP_PORT=8000
```

Then:

- **bash / Git Bash / macOS:** `npm run dev`
- **Windows cmd / PowerShell:** `npm run dev` uses Unix-style `NODE_ENV=…` syntax that Windows shells don't understand. Set `NODE_ENV=development` yourself, then run `npx tsx watch --tsconfig ./tsconfig.server.json ./server/server.ts`

Open http://localhost:8000. Locally you're signed in as `local-dev@localhost`.

---

## 13. Where things are

See [README.md](README.md) for the repository layout, and [DATABRICKS_IMPLEMENTATION_GUIDE.md](DATABRICKS_IMPLEMENTATION_GUIDE.md) for the design decisions and every gotcha found while building this.

---

## 14. Databricks features used, and why

### Data and governance

| Feature | What it's used for | Why |
|---|---|---|
| **Unity Catalog** | Catalog (`cnx_automl_dev`) with schemas `lenss_collections_bronze / silver / gold / context` | One place for access control, and the same names work in every workspace |
| **UC Volumes** | `raw_files` volume holds the uploaded workbook and one CSV per sheet | A governed place for raw files that SQL can read directly with `read_files()` |
| **Delta tables** | Bronze and context tables (the 11 sheets as-is), typed silver tables | Bronze keeps the source untouched; silver fixes types and adds a primary key and NOT NULL rules so Genie joins tables correctly |
| **Metric views** | `mv_performance_targets`, `mv_collections_funnel` | Measures such as achievement % and recovery rate are defined once, and monthly targets can't be double-counted when joined to account-level data |
| **Certified views** | 16 `qry_*` views, e.g. `qry_mtd_vs_target`, `qry_immediate_intervention` | Checked SQL for the key business questions, reused by both the dashboard and Genie |
| **Grants** | `USE CATALOG`, `USE SCHEMA`, `SELECT` on gold for the app's service principal | The app reads only gold. Without these grants Agent mode fails with "internal error" |

### Compute and querying

| Feature | What it's used for | Why |
|---|---|---|
| **SQL warehouse** (Serverless or Pro) | All deploy SQL, the dashboard queries, and Genie's queries | Genie requires Serverless or Pro; serverless starts in seconds |
| **SQL Statement Execution API** | Running SQL from `deploy.py` and from the app's dashboard endpoints | Runs SQL over HTTPS, with no JDBC driver or cluster needed |

### AI

| Feature | What it's used for | Why |
|---|---|---|
| **Genie space** | 19 data sources, instructions, 19 example SQLs, sample questions, 7 benchmarks | Turns plain-English questions into governed SQL; the benchmarks measure answer accuracy |
| **Genie space as code** | `deploy/genie/space.py` produces the space definition, which the Genie API creates or updates | The Genie setup is recreated identically in any workspace instead of rebuilt by hand |
| **Genie Chat mode** (Conversation API) | The app's **Quick answer** mode: text, the SQL used, and result rows, which become the charts | Fast answers of about 20 seconds |
| **Genie Agent mode** | The app's **Agent** answers: several SQL steps, generated charts, a written report | "Why is this happening / what should we do" questions, in 1–3 minutes |
| **Model Serving** (foundation model, e.g. Llama 3.3 70B) | Can give each chat session a short title | **Off by default** (`title_endpoint`); sessions are named from their first question |
| **Model Serving** (Foundation Model APIs) | Guardrail classifier, embeddings for the semantic cache, the answer-quality judge, follow-up suggestions | Each is optional and set per workspace; the deploy binds each endpoint to the app with Can query |
| **Genie feedback API** | 👍/👎 on each answer, stored in the app and sent to the Genie space's Monitor | Space owners see which answers to fix, with the real user recorded in the app |

### App and storage

| Feature | What it's used for | Why |
|---|---|---|
| **Databricks Apps** | Hosts the web app (Command Center, Assistant, Monitoring, Evals, Responsible AI) | Company sign-in (SSO) built in and no servers to run; Databricks builds the Node app on each deploy |
| **App resources** | The app is linked to the Genie space (Can run), the SQL warehouse (Can use), the Lakebase database `chatapp` (Can connect and create) and, if enabled, the title model (Can query) | Grants these permissions to the app's identity automatically, with no secrets in code |
| **App service principal** | The identity the app uses to call Genie, SQL and Lakebase | Users only need **Can use** on the app, not their own data permissions |
| **User identity header** | `x-forwarded-email` identifies the signed-in user | Keeps each person's chat history private to them |
| **AppKit** (`@databricks/appkit`) | Databricks' Node framework: Genie, Lakebase and server plugins | Handles authentication and connections; custom routes are added on top |
| **Lakebase Postgres** | The `chatapp` database: chat sessions, messages, usage log, and the answer cache | Chat history needs fast small reads and writes, which suits Postgres better than Delta. Logins use Databricks OAuth, so there are no passwords |

### Identity, access and deployment

| Feature | What it's used for | Why |
|---|---|---|
| **Service principal + OAuth M2M** | The smoke-test identity (section 9.2) | Tests the deployed URL as a non-admin identity, which catches missing permissions |
| **Entitlements** | **Workspace access** entitlement for that identity | Without it the app returns `401` even with a valid token |
| **App permissions** | **Can use** for users and groups (the `readers_group` setting) | How people are given access to the app |
| **Databricks CLI** | Every step of `deploy.py` | One tool with one sign-in, which works in any terminal |
| **Workspace files / sync** | App source uploaded to `/Workspace/Users/<you>/apps/<app>` before each deploy | Databricks Apps deploy from a workspace folder |
| **OAuth login or personal access token** | Signing the CLI in to the workspace (section 6) | Either works; use a token if the browser login does nothing |

### Considered but not used

- **Asset Bundles:** they can't upload the workbook, write Genie's content, or create the Lakebase tables, so `deploy.py` does the whole job instead. The `databricks.yml` in `appkit-genie-app/` comes from the app template and isn't used by the deploy.
- **Jobs, notebooks, Lakeflow/DLT:** not needed for a one-time load of a static workbook. They would matter once real data arrives on a schedule.
- **AI/BI dashboards, Delta Sharing:** options for giving external clients read-only access instead of the app.
- **On-behalf-of-user auth:** `asUser()` doesn't work in this AppKit version, so the app calls Genie and SQL as its service principal.
