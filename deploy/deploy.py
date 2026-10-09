#!/usr/bin/env python3
"""One-command deploy of Lens MLOps into a Databricks workspace.

    python deploy/deploy.py --config deploy/config/org.json

Creates/updates, idempotently and in order:
  schemas    catalog (optional) + bronze/silver/gold/context schemas + raw_files volume
  ingest     uploads the 3 source CSVs to bronze and metadata.xlsx's reference sheets to context
  context    governance tables that are not in the source files
  transform  silver typed tables + data-quality checks, gold rules, 2 metric views, certified views
  views      Command Center and Explorer views
  summary    writes the Command Center's executive summary to gold.exec_summary (no LLM)
  genie      Genie space: sources, instructions, examples, benchmarks
  lakebase   Postgres project/database + chat-history/usage schema
  app        Databricks App (create/update, bind resources, grants, deploy)
  smoke      end-to-end test of the deployed URL (needs LENS_SMOKE_CLIENT_ID/SECRET)

Run a subset with --only ingest,transform or --skip smoke. Everything goes
through the `databricks` CLI, so it uses whatever auth the CLI profile has
(the VS Code extension's OAuth login, or DATABRICKS_HOST/DATABRICKS_TOKEN).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

DEPLOY_DIR = Path(__file__).resolve().parent
REPO_DIR = DEPLOY_DIR.parent
STEPS = ["schemas", "ingest", "context", "transform", "views", "summary", "genie", "lakebase", "app", "smoke"]

SOURCES = {  # source CSV -> bronze table (landed as-is)
    "model_registry.csv": "model_registry",
    "predictions.csv": "predictions",
    "business_outcomes.csv": "business_outcomes",
}
METADATA_FILE = "metadata.xlsx"
METADATA_SHEETS = {  # metadata.xlsx sheet -> (context table, column that must be filled for a row to count)
    "Table Overview": ("table_overview", "Table Name"),
    "Data Dictionary": ("data_dictionary", "Field"),
    "Join Keys & ER": ("join_keys", "Parent Key"),
    "Sample Demo Questions": ("sample_questions", "Natural-Language Question"),
    "Data Quality Rules": ("data_quality_rules", "Rule"),
    "Planted Incidents": ("reference_incidents", "Incident Start"),
    "Enumerations": ("enumerations", "Allowed Value"),
}


# Windows consoles often can't print characters such as ° or ²; replace them rather than crash the deploy.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(errors="replace")


def log(msg: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


class DeployError(RuntimeError):
    pass


# --------------------------------------------------------------------------- CLI

class Databricks:
    def __init__(self, profile: str | None):
        exe = os.environ.get("DATABRICKS_CLI_PATH") or shutil.which("databricks")
        if not exe:
            raise DeployError(
                "Databricks CLI not found. Install it (winget install Databricks.DatabricksCLI, "
                "or brew install databricks) or set DATABRICKS_CLI_PATH."
            )
        self.exe = exe
        self.profile = profile

    def run(self, *args: str, json_body: dict | None = None, check: bool = True, output_json: bool = True):
        cmd = [self.exe, *args]
        if self.profile:
            cmd += ["--profile", self.profile]
        tmp = None
        if json_body is not None:
            tmp = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8")
            json.dump(json_body, tmp)
            tmp.close()
            cmd += ["--json", f"@{tmp.name}"]
        if output_json:
            cmd += ["-o", "json"]
        try:
            # cwd=REPO_DIR: never run inside the app folder, whose AppKit-generated
            # databricks.yml would otherwise hijack the target host.
            proc = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", cwd=REPO_DIR)
        finally:
            if tmp:
                os.unlink(tmp.name)
        if proc.returncode != 0:
            if check:
                raise DeployError(f"`databricks {' '.join(args)}` failed:\n{proc.stderr.strip() or proc.stdout.strip()}")
            return None
        out = proc.stdout.strip()
        if not output_json:
            return out
        if not out:
            return {}
        try:
            return json.loads(out)
        except json.JSONDecodeError:
            return out


# --------------------------------------------------------------------------- SQL

def split_sql(text: str) -> list[str]:
    """Splits on ';' outside $$...$$ blocks and single-quoted strings; drops -- comment lines."""
    lines = [ln for ln in text.splitlines() if not ln.strip().startswith("--")]
    text = "\n".join(lines)
    out, buf, i, in_dollar, in_quote = [], [], 0, False, False
    while i < len(text):
        if not in_quote and text.startswith("$$", i):
            in_dollar = not in_dollar
            buf.append("$$")
            i += 2
            continue
        ch = text[i]
        if not in_dollar and ch == "'":
            if in_quote and text.startswith("''", i):
                buf.append("''")
                i += 2
                continue
            in_quote = not in_quote
        if ch == ";" and not in_dollar and not in_quote:
            stmt = "".join(buf).strip()
            if stmt:
                out.append(stmt)
            buf = []
        else:
            buf.append(ch)
        i += 1
    tail = "".join(buf).strip()
    if tail:
        out.append(tail)
    return out


class Sql:
    def __init__(self, db: Databricks, warehouse_id: str):
        self.db, self.warehouse_id = db, warehouse_id

    def execute(self, statement: str) -> list[list]:
        resp = self.db.run(
            "api", "post", "/api/2.0/sql/statements",
            json_body={"statement": statement, "warehouse_id": self.warehouse_id, "wait_timeout": "50s"},
        )
        while resp["status"]["state"] in ("PENDING", "RUNNING"):
            time.sleep(2)
            resp = self.db.run("api", "get", f"/api/2.0/sql/statements/{resp['statement_id']}")
        if resp["status"]["state"] != "SUCCEEDED":
            msg = resp["status"].get("error", {}).get("message", resp["status"]["state"])
            raise DeployError(f"SQL failed: {msg}\n--- statement ---\n{statement[:600]}")
        return resp.get("result", {}).get("data_array", []) or []

    def run_file(self, path: Path, cfg: dict) -> None:
        text = path.read_text(encoding="utf-8")
        text = text.replace("{{catalog}}", cfg["catalog"]).replace("{{prefix}}", cfg["schema_prefix"])
        stmts = split_sql(text)
        for n, stmt in enumerate(stmts, 1):
            first = " ".join(stmt.split())[:90]
            log(f"  {path.name} [{n}/{len(stmts)}] {first}")
            self.execute(stmt)


# --------------------------------------------------------------------------- helpers

def ident(name: str) -> str:
    if not re.fullmatch(r"[A-Za-z0-9_]+", name):
        raise DeployError(f"Unsafe identifier in config: {name!r}")
    return name


def load_config(path: Path) -> dict:
    cfg = json.loads(path.read_text(encoding="utf-8"))
    defaults = {
        "profile": None,
        "create_catalog": False,
        "schema_prefix": "lens_mlops",
        "warehouse_id": None,
        "warehouse_name": None,
        # Folder with the source CSVs and metadata.xlsx, relative to the repo (kept out of git).
        "data_dir": "../All_data_and_details",
        "genie_space_title": "Lens MLOps Analytics",
        "genie_space_id": None,
        "lakebase_project": "lens-mlops-app",
        "lakebase_database": "lensmlops",
        "app_name": "lens-mlops",
        "app_dir": "appkit-genie-app",
        "app_workspace_path": None,
        "readers_group": None,
        # Optional chat model that names chat sessions, e.g. "databricks-meta-llama-3-3-70b-instruct".
        # Off by default: sessions are named from the first question.
        "title_endpoint": None,
        # Answer cache (DATABRICKS_IMPLEMENTATION_GUIDE.md, Step 8e): reuse answers to standalone
        # questions until the data or Genie changes, and pre-warm the 10 suggested questions.
        "answer_cache": True,
        "prewarm_suggestions": True,
    }
    for k, v in defaults.items():
        cfg.setdefault(k, v)
    for key in ("catalog", "schema_prefix"):
        ident(cfg[key])
    # Checked up front so a bad name fails before anything is created (Lakebase and Apps reject
    # underscores and capitals in these IDs).
    for key in ("lakebase_project", "lakebase_database", "app_name"):
        if not re.fullmatch(r"[a-z]([a-z0-9-]{0,61}[a-z0-9])?", str(cfg[key])):
            raise DeployError(f"{key} must be lowercase letters, digits and hyphens, starting with a letter "
                              f"(no underscores), got {cfg[key]!r}")
    return cfg


def state_path(cfg_path: Path) -> Path:
    return DEPLOY_DIR / ".state" / f"{cfg_path.stem}.json"


def load_state(cfg_path: Path) -> dict:
    p = state_path(cfg_path)
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else {}


def save_state(cfg_path: Path, state: dict) -> None:
    p = state_path(cfg_path)
    p.parent.mkdir(exist_ok=True)
    p.write_text(json.dumps(state, indent=2), encoding="utf-8")


# --------------------------------------------------------------------------- steps

def step_preflight(db: Databricks, cfg: dict, state: dict) -> None:
    me = db.run("current-user", "me")
    state["user"] = me["userName"]
    log(f"Authenticated as {state['user']}")

    wh_id = cfg["warehouse_id"]
    if not wh_id:
        whs = db.run("warehouses", "list")
        whs = whs if isinstance(whs, list) else whs.get("warehouses", [])
        if cfg["warehouse_name"]:
            whs = [w for w in whs if w["name"] == cfg["warehouse_name"]]
        if not whs:
            raise DeployError("No matching SQL warehouse found — set warehouse_id or warehouse_name in the config.")
        wh_id = whs[0]["id"]
    state["warehouse_id"] = wh_id
    wh = db.run("warehouses", "get", wh_id)
    if wh.get("state") != "RUNNING":
        log(f"Starting warehouse {wh['name']} ({wh_id})…")
        db.run("warehouses", "start", wh_id)
    log(f"Using warehouse {wh['name']} ({wh_id})")


def step_schemas(sql: Sql, cfg: dict) -> None:
    c, p = cfg["catalog"], cfg["schema_prefix"]
    if cfg["create_catalog"]:
        sql.execute(f"CREATE CATALOG IF NOT EXISTS {c}")
    for layer in ("bronze", "silver", "gold", "context"):
        sql.execute(f"CREATE SCHEMA IF NOT EXISTS {c}.{p}_{layer}")
    sql.execute(f"CREATE VOLUME IF NOT EXISTS {c}.{p}_bronze.raw_files")
    log(f"Schemas {c}.{p}_{{bronze,silver,gold,context}} and volume raw_files ready")


def snake(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", str(name).lower()).strip("_")


def step_ingest(db: Databricks, sql: Sql, cfg: dict) -> None:
    import pandas as pd  # imported lazily so other steps don't need pandas

    c, p = cfg["catalog"], cfg["schema_prefix"]
    data_dir = (REPO_DIR / cfg["data_dir"]).resolve()
    missing = [f for f in [*SOURCES, METADATA_FILE] if not (data_dir / f).exists()]
    if missing:
        raise DeployError(f"Source files not found in {data_dir}: {missing}")
    volume = f"/Volumes/{c}/{p}_bronze/raw_files"

    # Source CSVs land in bronze exactly as they are.
    for name, table in SOURCES.items():
        path = data_dir / name
        with path.open(encoding="utf-8") as fh:
            expected = sum(1 for _ in fh) - 1
        log(f"Uploading {name} ({path.stat().st_size / 1e6:.1f} MB, {expected:,} rows)")
        db.run("fs", "cp", str(path), f"dbfs:{volume}/{name}", "--overwrite", output_json=False)
        src = f"read_files('{volume}/{name}', format => 'csv', header => true, inferSchema => true)"
        cols = [r[0] for r in sql.execute(f"DESCRIBE QUERY SELECT * FROM {src}") if r[0] != "_rescued_data"]
        col_list = ", ".join(f"`{col}`" for col in cols)
        sql.execute(f"CREATE OR REPLACE TABLE {c}.{p}_bronze.{table} AS SELECT {col_list} FROM {src}")
        count = int(sql.execute(f"SELECT COUNT(*) FROM {c}.{p}_bronze.{table}")[0][0])
        if count != expected:
            raise DeployError(f"{table}: expected {expected:,} rows, loaded {count:,}")
        log(f"  {name} -> {p}_bronze.{table} ({count:,} rows)")

    # metadata.xlsx: the reference sheets become context tables (column names made SQL-safe).
    # The source's brand name is the first word of its README title; it is removed from every cell.
    xlsx = data_dir / METADATA_FILE
    sheets = pd.read_excel(xlsx, sheet_name=None)
    absent = set(METADATA_SHEETS) - set(sheets)
    if absent:
        raise DeployError(f"{METADATA_FILE} is missing sheets: {sorted(absent)}")
    readme = sheets.get("README")
    brand = str(readme.columns[0]).split()[0] if readme is not None and len(readme.columns) else ""
    scrub = (lambda s: re.sub(rf"\b{re.escape(brand)}\s*", "", s)) if len(brand) > 2 else (lambda s: s)
    with tempfile.TemporaryDirectory() as tmp:
        for sheet, (table, required) in METADATA_SHEETS.items():
            df = sheets[sheet]
            df = df[df[required].notna()].copy()
            for col in df.columns:
                if pd.api.types.is_datetime64_any_dtype(df[col]):
                    df[col] = df[col].dt.strftime("%Y-%m-%d %H:%M")
                df[col] = df[col].map(lambda x: None if pd.isna(x) else scrub(str(x)))
            df.columns = [snake(col) for col in df.columns]
            csv = Path(tmp) / f"{table}.csv"
            df.to_csv(csv, index=False)
            db.run("fs", "cp", str(csv), f"dbfs:{volume}/context_{table}.csv", "--overwrite", output_json=False)
            src = (f"read_files('{volume}/context_{table}.csv', format => 'csv', header => true, "
                   f"inferSchema => false, multiLine => true, escape => '\"')")
            col_list = ", ".join(f"`{col}`" for col in df.columns)
            sql.execute(f"CREATE OR REPLACE TABLE {c}.{p}_context.{table} AS SELECT {col_list} FROM {src}")
            count = int(sql.execute(f"SELECT COUNT(*) FROM {c}.{p}_context.{table}")[0][0])
            if count != len(df):
                raise DeployError(f"{table}: expected {len(df)} rows, loaded {count}")
            log(f"  {METADATA_FILE} [{sheet}] -> {p}_context.{table} ({count} rows)")


def step_context(sql: Sql, cfg: dict) -> None:
    sql.run_file(DEPLOY_DIR / "sql" / "20_context_manual.sql", cfg)


# The source data's quality rules (metadata.xlsx, "Data Quality Rules"), checked on silver.
# Each query returns the number of rows breaking the rule; hard rules stop the deploy.
QUALITY_CHECKS = [
    ("hard", "model_id is unique and matches MDL_###",
     "SELECT COUNT(*) - COUNT(DISTINCT model_id) + COUNT_IF(NOT model_id RLIKE '^MDL_[0-9]{{3}}$') FROM {s}.dim_model"),
    ("hard", "every prediction's model exists in the registry",
     "SELECT COUNT(*) FROM {s}.fact_predictions f LEFT ANTI JOIN {s}.dim_model m ON m.model_id = f.model_id"),
    ("hard", "every outcome's model exists in the registry",
     "SELECT COUNT(*) FROM {s}.fact_business_outcomes o LEFT ANTI JOIN {s}.dim_model m ON m.model_id = o.model_id"),
    ("hard", "predictions are on exact minutes",
     "SELECT COUNT_IF(second(prediction_time) <> 0) FROM {s}.fact_predictions"),
    ("hard", "one prediction per model per minute",
     "SELECT COUNT(*) - COUNT(DISTINCT model_id, prediction_time) FROM {s}.fact_predictions"),
    ("hard", "every model has a prediction for every minute",
     "SELECT ABS(COUNT(*) - COUNT(DISTINCT model_id) * COUNT(DISTINCT prediction_time)) FROM {s}.fact_predictions"),
    ("hard", "confidence_score and drift_score are between 0 and 1",
     "SELECT COUNT_IF(confidence_score NOT BETWEEN 0 AND 1 OR drift_score NOT BETWEEN 0 AND 1) FROM {s}.fact_predictions"),
    ("hard", "prediction_error = actual_value - predicted_value",
     "SELECT COUNT_IF(actual_value IS NOT NULL AND ABS(prediction_error - (actual_value - predicted_value)) > 0.001 + 0.001 * ABS(actual_value)) "
     "FROM {s}.fact_predictions"),
    ("hard", "incidents_confirmed <= incidents_predicted",
     "SELECT COUNT_IF(incidents_confirmed > incidents_predicted) FROM {s}.fact_business_outcomes"),
    ("hard", "false_positives = incidents_predicted - incidents_confirmed",
     "SELECT COUNT_IF(false_positives <> incidents_predicted - incidents_confirmed) FROM {s}.fact_business_outcomes"),
    ("hard", "one outcome row per model per hour, for every hour",
     "SELECT ABS(COUNT(*) - COUNT(DISTINCT model_id, date_hour)) + ABS(COUNT(*) - COUNT(DISTINCT model_id) * COUNT(DISTINCT date_hour)) "
     "FROM {s}.fact_business_outcomes"),
    ("hard", "incidents_predicted equals the hour's anomaly alerts",
     "SELECT COUNT(*) FROM {s}.fact_business_outcomes o LEFT JOIN (SELECT model_id, date_trunc('HOUR', prediction_time) AS h, "
     "COUNT_IF(anomaly_flag) AS n FROM {s}.fact_predictions GROUP BY 1, 2) a ON a.model_id = o.model_id AND a.h = o.date_hour "
     "WHERE o.incidents_predicted <> COALESCE(a.n, 0)"),
    ("soft", "yield is reported only for Reactor and Furnace models",
     "SELECT COUNT(*) FROM {s}.fact_business_outcomes o JOIN {s}.dim_model m ON m.model_id = o.model_id "
     "WHERE o.yield_improvement_pct <> 0 AND m.asset_type NOT IN ('Reactor', 'Furnace')"),
]


def check_quality(sql: Sql, cfg: dict) -> None:
    s = f"{cfg['catalog']}.{cfg['schema_prefix']}_silver"
    failed = []
    for severity, rule, query in QUALITY_CHECKS:
        bad = int(sql.execute(query.format(s=s))[0][0] or 0)
        if bad:
            log(f"  {'FAIL' if severity == 'hard' else 'warn'}: {rule} ({bad:,} rows)")
            if severity == "hard":
                failed.append(rule)
        else:
            log(f"  ok: {rule}")
    (null_share,) = sql.execute(f"SELECT 1.0 * COUNT_IF(actual_value IS NULL) / COUNT(*) FROM {s}.fact_predictions")[0]
    log(f"  info: {float(null_share):.1%} of predictions have no ground truth yet (about 30% is expected)")
    if failed:
        raise DeployError(f"Data-quality rules failed: {failed}")


def step_transform(sql: Sql, cfg: dict) -> None:
    sql.run_file(DEPLOY_DIR / "sql" / "30_silver.sql", cfg)
    log("Data-quality checks (the source data's rules):")
    check_quality(sql, cfg)
    for name in ("40_gold_config.sql", "50_metric_views.sql", "60_certified_views.sql"):
        sql.run_file(DEPLOY_DIR / "sql" / name, cfg)
    c, p = cfg["catalog"], cfg["schema_prefix"]
    models, drifting, low_conf = sql.execute(
        f"SELECT COUNT(*), SUM(drifting_flag), SUM(low_confidence_flag) FROM {c}.{p}_gold.qry_model_health")[0]
    log(f"Transform done: {models} models, {drifting} drifting and {low_conf} low-confidence "
        f"(4 and 12 expected for the source data)")


def step_views(sql: Sql, cfg: dict) -> None:
    """Command Center views (70_command_center_views.sql): additive, safe to run on a shared gold schema."""
    sql.run_file(DEPLOY_DIR / "sql" / "70_command_center_views.sql", cfg)
    c, p = cfg["catalog"], cfg["schema_prefix"]
    (models, healthy, savings) = sql.execute(
        f"SELECT models, healthy_models, cost_savings_usd FROM {c}.{p}_gold.qry_cc_kpis")[0]
    log(f"Command Center views ready: {healthy} of {models} models healthy, {money(savings)} estimated savings")


def money(v) -> str:
    v = float(v or 0)
    if abs(v) >= 1e9:
        return f"${v / 1e9:.2f}B"
    return f"${v / 1e6:.1f}M" if abs(v) >= 1e6 else f"${v / 1e3:.0f}K" if abs(v) >= 1e3 else f"${v:,.0f}"


def pct(v, digits: int = 0) -> str:
    return f"{float(v or 0) * 100:.{digits}f}%"


def build_exec_summary(sql: Sql, gold: str) -> tuple[str, str]:
    """The Command Center's executive summary, written from the certified views.

    Deterministic on purpose: every number is read straight from gold, so the
    text can't drift from the dashboard, and it only changes when this step
    re-runs (after new data), not on every page load.
    """
    cols = ["models", "sites", "healthy_models", "drifting_models", "low_confidence_only_models",
            "high_criticality_needing_attention", "drifting_first_avg_drift", "drifting_latest_avg_drift",
            "alerts", "confirmed_incidents", "alert_precision", "false_positives", "false_positive_rate", "incidents",
            "downtime_avoided_hours", "cost_savings_usd", "as_of_time"]
    k = dict(zip(cols, sql.execute(f"SELECT {', '.join(cols)} FROM {gold}.qry_cc_kpis")[0]))
    top = sql.execute(f"SELECT model_name, site_name, cost_savings_usd FROM {gold}.qry_incidents "
                      f"ORDER BY cost_savings_usd DESC LIMIT 1")
    (tune,) = sql.execute(f"SELECT tune_alert_models FROM {gold}.qry_cc_actions")[0]
    as_of = time.strptime(str(k["as_of_time"]).replace("T", " ")[:16], "%Y-%m-%d %H:%M")
    n = lambda key: int(float(k[key] or 0))  # noqa: E731
    parts = [
        f"As of {time.strftime('%d %B %Y, %H:%M', as_of).lstrip('0')}, {n('healthy_models')} of {n('models')} models "
        f"across {n('sites')} sites are healthy.",
        f"{n('drifting_models')} models are drifting (their average drift score rose from "
        f"{float(k['drifting_first_avg_drift'] or 0):.2f} to {float(k['drifting_latest_avg_drift'] or 0):.2f} over the window) "
        f"and {n('low_confidence_only_models')} more report low confidence"
        + (f"; {n('high_criticality_needing_attention')} of them is business-critical."
           if n('high_criticality_needing_attention') == 1 else
           f"; {n('high_criticality_needing_attention')} of them are business-critical."),
        f"The models raised {n('alerts'):,} alerts across {n('incidents')} incidents and {n('confirmed_incidents'):,} were confirmed "
        f"({pct(k['alert_precision'])}), avoiding an estimated {float(k['downtime_avoided_hours'] or 0):,.0f} hours of downtime "
        f"and {money(k['cost_savings_usd'])} in costs.",
    ]
    if top and float(k["cost_savings_usd"] or 0):
        name, site, saved = top[0]
        parts.append(f"One incident, on {name} at {site}, accounts for {money(saved)} "
                     f"({pct(float(saved) / float(k['cost_savings_usd']))}) of that.")
    parts.append(f"{n('false_positives'):,} alerts ({pct(k['false_positive_rate'])}) were false alarms; "
                 f"{int(float(tune or 0))} models need their alert thresholds tuned.")
    return " ".join(parts), str(k["as_of_time"])[:10]


def step_summary(sql: Sql, cfg: dict) -> None:
    gold = f"{cfg['catalog']}.{cfg['schema_prefix']}_gold"
    narrative, snapshot = build_exec_summary(sql, gold)
    # When the data was last loaded (the transform step), shown under the summary. The app
    # can only read gold, so it's stored here rather than looked up by the app.
    silver = f"{cfg['schema_prefix']}_silver"
    rows = sql.execute(f"SELECT CAST(MAX(last_altered) AS STRING) FROM {cfg['catalog']}.information_schema.tables "
                       f"WHERE table_schema = '{silver}' AND table_name = 'fact_predictions'")
    refreshed = f"TIMESTAMP '{rows[0][0]}'" if rows and rows[0][0] else "CAST(NULL AS TIMESTAMP)"
    escaped = narrative.replace("\\", "\\\\").replace("'", "\\'")
    # One row, rewritten every run (CREATE OR REPLACE also adds new columns to an older table).
    sql.execute(f"CREATE OR REPLACE TABLE {gold}.exec_summary "
                f"COMMENT 'Command Center executive summary, written by deploy.py from the certified views' AS "
                f"SELECT current_timestamp() AS generated_at, DATE '{snapshot}' AS snapshot_date, '{escaped}' AS narrative, "
                f"{refreshed} AS data_refreshed_at")
    log(f"Executive summary written ({len(narrative)} characters):\n    {narrative}")


def step_genie(db: Databricks, cfg: dict, state: dict, cfg_path: Path) -> None:
    sys.path.insert(0, str(DEPLOY_DIR / "genie"))
    from space import build_serialized_space  # noqa: E402

    gold = f"{cfg['catalog']}.{cfg['schema_prefix']}_gold"
    serialized = json.dumps(build_serialized_space(gold))
    title = cfg["genie_space_title"]
    space_id = state.get("genie_space_id") or cfg["genie_space_id"]

    if not space_id:
        token = None
        while True:
            args = ["genie", "list-spaces"] + (["--page-token", token] if token else [])
            page = db.run(*args)
            for s in page.get("spaces", []):
                if s.get("title") == title:
                    space_id = s["space_id"]
            token = page.get("next_page_token")
            if space_id or not token:
                break

    if space_id and db.run("genie", "get-space", space_id, check=False) is None:
        log(f"Genie space {space_id} no longer exists — creating a new one")
        space_id = None

    body = {
        "serialized_space": serialized,
        "title": title,
        "description": "ML model fleet health, drift, alerts and business value (Lens MLOps).",
        "warehouse_id": state["warehouse_id"],
    }
    if space_id:
        db.run("genie", "update-space", space_id, json_body=body)
        log(f"Updated Genie space {space_id}")
    else:
        created = db.run("api", "post", "/api/2.0/genie/spaces",
                         json_body={**body, "parent_path": f"/Users/{state['user']}"})
        space_id = created["space_id"]
        log(f"Created Genie space {space_id} ({created.get('title')})")
    state["genie_space_id"] = space_id
    save_state(cfg_path, state)
    # Same instructions and sources → same answers, so only a real change counts.
    genie_version = hashlib.sha256(f"{space_id}|{serialized}".encode()).hexdigest()[:12]
    bump_cache_version(db, cfg, state, cfg_path, "genie", genie_version)


def pg_connect(db: Databricks, state: dict, database: str):
    import psycopg2  # noqa: E402

    cred = db.run("postgres", "generate-database-credential", state["lakebase_endpoint"])
    return psycopg2.connect(
        host=state["lakebase_host"], port=5432, dbname=database,
        user=state["user"], password=cred["token"], sslmode="require",
    )


def bump_cache_version(db: Databricks, cfg: dict, state: dict, cfg_path: Path, name: str, version: str) -> None:
    """Record a new data or Genie version so the app's answer cache moves on.

    The app keys cached answers by these versions, so bumping one makes every
    older answer unreachable and triggers a fresh pre-warm. Kept in the state
    file too, so a first deploy (Lakebase not created yet) still gets them.
    """
    versions = state.setdefault("cache_versions", {})
    if versions.get(name) == version:
        return
    versions[name] = version
    save_state(cfg_path, state)
    if "lakebase_host" in state:
        write_cache_versions(db, cfg, state)


def write_cache_versions(db: Databricks, cfg: dict, state: dict) -> None:
    versions = state.get("cache_versions") or {}
    if not versions:
        return
    try:
        conn = pg_connect(db, state, cfg["lakebase_database"])
        conn.autocommit = True
        with conn.cursor() as cur:
            for name, version in versions.items():
                cur.execute(
                    "INSERT INTO chatapp.cache_versions (name, version, updated_at) VALUES (%s, %s, now()) "
                    "ON CONFLICT (name) DO UPDATE SET version = EXCLUDED.version, updated_at = now() "
                    "WHERE chatapp.cache_versions.version <> EXCLUDED.version",
                    (name, version))
        conn.close()
        log(f"Answer cache versions: {', '.join(f'{k}={v}' for k, v in versions.items())}")
    except Exception as e:  # the cache is an optimisation; never fail a deploy over it
        log(f"WARNING: could not update answer-cache versions ({e}); cached answers may be stale until the next deploy")


def write_eval_cases(db: Databricks, cfg: dict, state: dict) -> None:
    """Seed the evaluation suite (ground-truth, red-team and policy cases) into Lakebase.

    Upserts by (category, question), so re-running updates expectations and SQL
    without touching cases added from the app's feedback queue or switched off there.
    """
    sys.path.insert(0, str(DEPLOY_DIR / "evals"))
    from cases import eval_cases  # noqa: E402

    gold = f"{cfg['catalog']}.{cfg['schema_prefix']}_gold"
    cases = eval_cases(gold)
    try:
        conn = pg_connect(db, state, cfg["lakebase_database"])
        conn.autocommit = True
        with conn.cursor() as cur:
            for category, question, mode, expected, expected_sql, source, notes in cases:
                cur.execute(
                    "INSERT INTO chatapp.eval_cases (category, question, mode, expected, expected_sql, source, notes) "
                    "VALUES (%s, %s, %s, %s, %s, %s, %s) "
                    "ON CONFLICT (category, question) DO UPDATE SET mode = EXCLUDED.mode, expected = EXCLUDED.expected, "
                    "expected_sql = EXCLUDED.expected_sql, source = EXCLUDED.source, notes = EXCLUDED.notes",
                    (category, question, mode, expected, expected_sql, source, notes))
        conn.close()
        counts = {c: sum(1 for x in cases if x[0] == c) for c in ("accuracy", "guardrail", "policy", "routing")}
        log(f"Evaluation cases: {counts['accuracy']} accuracy, {counts['guardrail']} guardrail, {counts['policy']} policy, {counts['routing']} routing")
    except Exception as e:  # evals are optional; never fail a deploy over them
        log(f"WARNING: could not seed evaluation cases ({e})")


def step_lakebase(db: Databricks, cfg: dict, state: dict, cfg_path: Path) -> None:
    project = f"projects/{cfg['lakebase_project']}"
    proj = db.run("postgres", "get-project", project, check=False)
    if proj is None:
        log(f"Creating Lakebase project {cfg['lakebase_project']} (takes a minute)…")
        proj = db.run("postgres", "create-project", cfg["lakebase_project"])
    branch = proj["status"]["default_branch"]

    endpoints = db.run("postgres", "list-endpoints", branch)
    endpoints = endpoints if isinstance(endpoints, list) else endpoints.get("endpoints", [])
    rw = [e for e in endpoints if e["status"].get("endpoint_type") == "ENDPOINT_TYPE_READ_WRITE"]
    if not rw:
        raise DeployError(f"No read-write endpoint on {branch}")
    # The pooled "-pooler" host rejects OAuth/SASL logins; always use the direct host.
    state["lakebase_host"] = rw[0]["status"]["hosts"]["host"]
    state["lakebase_endpoint"] = rw[0]["name"]

    roles = db.run("postgres", "list-roles", branch)
    roles = roles if isinstance(roles, list) else roles.get("roles", [])
    mine = [r for r in roles if r["status"].get("postgres_role") == state["user"]]
    if not mine:
        raise DeployError(f"No Postgres role for {state['user']} on {branch} — you need CAN_MANAGE on the project.")

    dbs = db.run("postgres", "list-databases", branch)
    dbs = dbs if isinstance(dbs, list) else dbs.get("databases", [])
    if not any(d["status"].get("postgres_database") == cfg["lakebase_database"] for d in dbs):
        db.run("postgres", "create-database", branch, "--database-id", cfg["lakebase_database"],
               json_body={"spec": {"role": mine[0]["name"], "postgres_database": cfg["lakebase_database"]}})
        log(f"Created database {cfg['lakebase_database']}")

    conn = pg_connect(db, state, cfg["lakebase_database"])
    conn.autocommit = True
    with conn.cursor() as cur:
        cur.execute((DEPLOY_DIR / "lakebase" / "schema.sql").read_text(encoding="utf-8"))
    conn.close()
    state["lakebase_branch"] = branch
    save_state(cfg_path, state)
    write_cache_versions(db, cfg, state)
    write_eval_cases(db, cfg, state)
    log(f"Lakebase ready: {state['lakebase_host']} / {cfg['lakebase_database']}")


def write_app_yaml(app_dir: Path, cfg: dict, state: dict) -> None:
    gold = f"{cfg['catalog']}.{cfg['schema_prefix']}_gold"
    (app_dir / "app.yaml").write_text(
        "# Generated by deploy/deploy.py — edit the config, not this file.\n"
        "command: ['npm', 'run', 'start']\n"
        "env:\n"
        "  - name: DATABRICKS_GENIE_SPACE_ID\n    valueFrom: genie-space\n"
        "  - name: DATABRICKS_WAREHOUSE_ID\n    valueFrom: sql-warehouse\n"
        f"  - name: LENS_GOLD_SCHEMA\n    value: {gold}\n"
        "  # Direct endpoint host, not the '-pooler' one (it rejects OAuth logins).\n"
        f"  - name: PGHOST\n    value: {state['lakebase_host']}\n"
        f"  - name: PGDATABASE\n    value: {cfg['lakebase_database']}\n"
        "  - name: PGPORT\n    value: '5432'\n"
        "  - name: PGSSLMODE\n    value: require\n"
        f"  - name: LAKEBASE_ENDPOINT\n    value: {state['lakebase_endpoint']}\n"
        + ("  - name: LENS_TITLE_ENDPOINT\n    valueFrom: title-model\n" if state.get("title_endpoint") else "")
        + f"  - name: LENS_ANSWER_CACHE\n    value: '{'on' if cfg.get('answer_cache', True) else 'off'}'\n"
        + f"  - name: LENS_PREWARM\n    value: '{'on' if cfg.get('prewarm_suggestions', True) else 'off'}'\n"
        # Semantic cache, guardrails and judge settings (only the parts that are on).
        + (f"  - name: LENS_AI_CONFIG\n    value: '{json.dumps(state['ai_config'], separators=(',', ':'))}'\n"
           if state.get("ai_config") else ""),
        encoding="utf-8",
    )


def grant_use_catalog(sql: Sql, catalog: str, sp: str) -> bool:
    """USE CATALOG for the app's service principal. Returns False if it's still missing.

    Granting it needs MANAGE on the catalog (or ownership), which the person
    deploying into a shared catalog often doesn't have. Many shared catalogs
    already give USE CATALOG to `account users`, which every service principal
    belongs to, so that counts too. Otherwise this warns instead of failing,
    so everything else still deploys and only this one grant is left to an admin.
    """
    try:
        sql.execute(f"GRANT USE CATALOG ON CATALOG {catalog} TO `{sp}`")
        log(f"Granted USE CATALOG on {catalog} to the app's service principal")
        return True
    except DeployError as e:
        if "PERMISSION_DENIED" not in str(e):
            raise
    try:
        grants = sql.execute(f"SHOW GRANTS ON CATALOG {catalog}")
    except DeployError:
        grants = []
    for principal, action, *_ in grants:
        if principal in ("account users", sp) and action.replace("_", " ").upper() in ("USE CATALOG", "ALL PRIVILEGES"):
            log(f"USE CATALOG on {catalog} already comes from `{principal}`; no catalog grant needed")
            return True
    log(f"WARNING: you can't grant USE CATALOG on {catalog} (it needs MANAGE on the catalog), and it isn't "
        f"granted to `account users`. Ask the catalog owner or an admin to run:\n"
        f"    GRANT USE CATALOG ON CATALOG {catalog} TO `{sp}`;\n"
        f"  It only lets the app enter the catalog; data access still comes only from your schema grants. "
        f"Until then the app loads, but its dashboard and Genie answers fail.")
    return False


def resolve_ai_config(db: Databricks, cfg: dict) -> dict:
    """The optional AI features for the app (semantic cache, guardrails, judge).

    A section missing from the config means that feature is off. Each model is
    checked like the Genie space and Lakebase are: if its serving endpoint
    doesn't exist in this workspace (models are enabled there by hand), the
    deploy warns and carries on without it instead of failing.
    """
    seen: dict = {}

    def exists(endpoint: str) -> bool:
        if endpoint not in seen:
            seen[endpoint] = db.run("serving-endpoints", "get", endpoint, check=False) is not None
            if not seen[endpoint]:
                log(f"WARNING: serving endpoint '{endpoint}' not found in this workspace (enable it under Serving, "
                    f"then re-run --only app)")
        return seen[endpoint]

    ai: dict = {}
    sc = cfg.get("semantic_cache")
    if sc and sc.get("threshold") not in (None, "", 0, "off"):
        threshold = float(sc["threshold"])
        threshold = threshold / 100 if threshold > 1 else threshold
        if not 0.5 <= threshold <= 1:
            raise DeployError(f"semantic_cache.threshold must be between 50 and 100 (or 0.5 and 1), got {sc['threshold']}")
        model = sc.get("embedding_model") or "databricks-gte-large-en"
        if exists(model):
            ai["semantic_cache"] = {"threshold": threshold, "embedding_model": model}
            log(f"Semantic cache: on, similarity >= {threshold:.2f}, embeddings from {model}")
        else:
            log("Semantic cache: off (embedding model missing)")
    else:
        log("Semantic cache: off")

    g = cfg.get("guardrails")
    if g:
        model = g.get("model") or None
        if model and not exists(model):
            model = None
        ai["guardrails"] = {"model": model, "input": g.get("input") or {}, "output": g.get("output") or {}}
        log(f"Guardrails: on ({'pattern checks + ' + model if model else 'pattern checks only, no classifier model'})")
    else:
        log("Guardrails: off")

    j = cfg.get("faithfulness_judge")
    if j:
        model = j.get("model") or None
        if model and not exists(model):
            model = None
        ai["faithfulness_judge"] = {"model": model, "sample_percent": j.get("sample_percent", 100),
                                    "warn_below": j.get("warn_below", 70)}
        log(f"Answer-quality judge: on ({'numbers check + ' + model if model else 'numbers check only, no judge model'}), "
            f"low-confidence warning below {j.get('warn_below', 70)}%")
    else:
        log("Answer-quality judge: off")

    f = cfg.get("follow_ups")
    if f and f.get("model") and exists(f["model"]):
        ai["follow_ups"] = {"model": f["model"]}
        log(f"Suggested follow-up questions: on ({f['model']})")
    else:
        log("Suggested follow-up questions: engine's own only")

    # Auto mode: "ai" (a small model routes each question to Quick answer or Deep analysis)
    # or "rules" (a word rule, no model). With no section, the guardrail classifier's model is
    # used when there is one; set "rules" to keep model calls to a minimum.
    am = cfg.get("auto_mode") or {}
    method = str(am.get("method") or ("ai" if (ai.get("guardrails") or {}).get("model") else "rules")).lower()
    if method not in ("ai", "rules"):
        raise DeployError(f'auto_mode.method must be "ai" or "rules", got {am.get("method")!r}')
    model = am.get("model") or (ai.get("guardrails") or {}).get("model") if method == "ai" else None
    if method == "ai" and model and exists(model):
        ai["auto_mode"] = {"method": "ai", "model": model, "timeout_ms": int(am.get("timeout_ms", 6000))}
        log(f"Auto mode: AI classifier ({model}), word rule as fallback")
    else:
        ai["auto_mode"] = {"method": "rules"}
        log("Auto mode: word rule (no model)" + (" - no model available for the AI classifier" if method == "ai" else ""))

    # Platform help: questions about Lens MLOps itself (tabs, navigation, how answers are checked) are
    # answered from the platform guide. "ai": a small model answers from the guide (default, with the
    # follow-up or guardrail model); "guide": the guide's own text, no model; "off": sent to the engine.
    ph = cfg.get("platform_help") or {}
    method = "off" if ph.get("enabled") is False else str(ph.get("method") or "ai").lower()
    if method not in ("ai", "guide", "off"):
        raise DeployError(f'platform_help.method must be "ai", "guide" or "off", got {ph.get("method")!r}')
    model = (ph.get("model") or (ai.get("follow_ups") or {}).get("model") or (ai.get("guardrails") or {}).get("model")) if method == "ai" else None
    if method == "ai" and model and exists(model):
        ai["platform_help"] = {"method": "ai", "model": model}
        log(f"Platform questions: answered from the platform guide by {model}")
    elif method == "off":
        ai["platform_help"] = {"method": "off"}
        log("Platform questions: disabled (every question goes to the query engine)")
    else:
        ai["platform_help"] = {"method": "guide"}
        log("Platform questions: answered with the platform guide's text (no model)")

    # Conversation memory: follow-ups carry a summary of older turns (compacted every
    # compact_every question-and-answer pairs, by a small model or a no-model digest) plus the
    # recent turns, so "tell me more about this" is understood whichever mode or source answered.
    cm = cfg.get("conversation_memory") or {}
    if cm.get("enabled") is False:
        ai["conversation_memory"] = {"enabled": False}
        log("Conversation memory: off (only the query engine's own conversation)")
    else:
        every = int(cm.get("compact_every", 5))
        if not 2 <= every <= 20:
            raise DeployError(f"conversation_memory.compact_every must be between 2 and 20, got {every}")
        model = cm.get("model") or (ai.get("follow_ups") or {}).get("model") or (ai.get("guardrails") or {}).get("model")
        model = model if model and exists(model) else None
        # Context budgets in estimated tokens (whole question-and-answer pairs, newest first); see aiConfig.ts.
        budgets = {k: int(cm[k]) for k in ("router_tokens", "guide_tokens", "genie_tokens", "genie_latest_max_tokens", "send_all_below_tokens") if k in cm}
        ai["conversation_memory"] = {"enabled": True, "compact_every": every, **({"model": model} if model else {}), **budgets}
        log(f"Conversation memory: on, compacted every {every} questions ({model or 'no-model digest'})")

    e = cfg.get("evals")
    if e:
        ai["evals"] = {"max_accuracy_cases": int(e.get("max_accuracy_cases", 5))}
        log(f"Evaluations: on (up to {ai['evals']['max_accuracy_cases']} ground-truth questions per run)")
    else:
        log("Evaluations: off")

    # Optional USD per million tokens, per endpoint, for Monitoring's cost estimate.
    if cfg.get("pricing"):
        ai["pricing"] = cfg["pricing"]
    return ai


def ai_endpoints(ai: dict) -> list[str]:
    eps = [(ai.get("semantic_cache") or {}).get("embedding_model"),
           (ai.get("guardrails") or {}).get("model"),
           (ai.get("faithfulness_judge") or {}).get("model"),
           (ai.get("follow_ups") or {}).get("model"),
           (ai.get("auto_mode") or {}).get("model"),
           (ai.get("platform_help") or {}).get("model"),
           (ai.get("conversation_memory") or {}).get("model")]
    return sorted({e for e in eps if e})


def step_app(db: Databricks, sql: Sql, cfg: dict, state: dict, cfg_path: Path) -> None:
    name = cfg["app_name"]
    app_dir = (REPO_DIR / cfg["app_dir"]).resolve()
    ws_path = cfg["app_workspace_path"] or f"/Workspace/Users/{state['user']}/apps/{name}"
    space = db.run("genie", "get-space", state["genie_space_id"])
    spec = {
        "description": "Lens MLOps: model fleet health and value. Genie chat + agent mode, command center, monitoring.",
        # No on-behalf-of-user scopes: the app calls Genie and SQL as its own service
        # principal, so users need only CAN_USE on the app and are never asked to
        # authorize anything. (Empty list also clears a scope set by an older deploy.)
        "user_api_scopes": [],
        "resources": [
            {"name": "genie-space", "description": "Genie space for natural-language questions",
             "genie_space": {"name": space["title"], "space_id": state["genie_space_id"], "permission": "CAN_RUN"}},
            {"name": "sql-warehouse", "description": "Warehouse for dashboard queries",
             "sql_warehouse": {"id": state["warehouse_id"], "permission": "CAN_USE"}},
            # Lakebase database as a declared resource: Databricks creates the app's
            # Postgres login (named dbrx-apps-<sp id>) and grants CONNECT/CREATE on it.
            # Table-level grants on chatapp.* are still applied below.
            {"name": "database", "description": "Lakebase database for chat history and usage log",
             "postgres": {"branch": state["lakebase_branch"],
                          "database": f"{state['lakebase_branch']}/databases/{cfg['lakebase_database']}",
                          "permission": "CAN_CONNECT_AND_CREATE"}},
        ],
    }
    # Optional model that names chat sessions (the app falls back to the question text).
    state["title_endpoint"] = None
    if cfg["title_endpoint"]:
        if db.run("serving-endpoints", "get", cfg["title_endpoint"], check=False) is not None:
            state["title_endpoint"] = cfg["title_endpoint"]
            spec["resources"].append(
                {"name": "title-model", "description": "Chat model that names chat sessions",
                 "serving_endpoint": {"name": cfg["title_endpoint"], "permission": "CAN_QUERY"}})
        else:
            log(f"Serving endpoint {cfg['title_endpoint']} not found — sessions will be named from the question text")
    # Optional AI features: each model the app calls is bound with CAN_QUERY (no keys).
    state["ai_config"] = resolve_ai_config(db, cfg)
    for i, endpoint in enumerate(ai_endpoints(state["ai_config"]), start=1):
        if endpoint == state.get("title_endpoint"):
            continue  # already bound as title-model
        spec["resources"].append(
            {"name": f"ai-model-{i}", "description": "Model for the semantic cache, guardrails, answer-quality judge or follow-up suggestions",
             "serving_endpoint": {"name": endpoint, "permission": "CAN_QUERY"}})
    # `apps update` replaces the fields it is sent, so always send the full spec.
    if db.run("apps", "get", name, check=False) is None:
        log(f"Creating app {name} (starts compute; a few minutes)…")
        # With --json the CLI takes the name inside the body, not as an argument.
        app = db.run("apps", "create", json_body={**spec, "name": name})
    else:
        app = db.run("apps", "update", name, json_body=spec)
    sp = app["service_principal_client_id"]
    state["app_url"] = app.get("url")
    log(f"App {name}, service principal {sp}")

    # Unity Catalog: only the app's service principal reads gold (Genie runs its SQL
    # as the app too). App users get no data grants: they see data only through the app.
    c, p = cfg["catalog"], cfg["schema_prefix"]
    catalog_ok = grant_use_catalog(sql, c, sp)
    sql.execute(f"GRANT USE SCHEMA ON SCHEMA {c}.{p}_gold TO `{sp}`")
    sql.execute(f"GRANT SELECT ON SCHEMA {c}.{p}_gold TO `{sp}`")
    log("Granted USE SCHEMA / SELECT on gold to the app's service principal")
    state["catalog_access_pending"] = not catalog_ok

    # Lakebase: a Postgres role for the app's service principal, then table grants.
    branch = state["lakebase_branch"]
    roles = db.run("postgres", "list-roles", branch)
    roles = roles if isinstance(roles, list) else roles.get("roles", [])
    if not any(r["status"].get("postgres_role") == sp for r in roles):
        # Unique per service principal: a recreated app gets a new one, and the old
        # role (same app name) may still exist.
        role_id = re.sub(r"[^a-z0-9-]", "-", f"app-{name}-{sp[:8]}".lower())[:63].strip("-")
        db.run("postgres", "create-role", branch, "--role-id", role_id, json_body={"spec": {
            "identity_type": "SERVICE_PRINCIPAL", "postgres_role": sp, "auth_method": "LAKEBASE_OAUTH_V1"}})
    conn = pg_connect(db, state, cfg["lakebase_database"])
    conn.autocommit = True
    with conn.cursor() as cur:
        cur.execute(f'GRANT USAGE ON SCHEMA chatapp TO "{sp}"')
        cur.execute(f'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA chatapp TO "{sp}"')
        cur.execute(f'ALTER DEFAULT PRIVILEGES IN SCHEMA chatapp GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "{sp}"')
    conn.close()
    log("Granted the app's Postgres role access to chatapp.*")

    # People: CAN_USE on the app is the only permission they get — no Genie space,
    # warehouse, table or Lakebase access.
    if cfg["readers_group"]:
        db.run("apps", "update-permissions", name, json_body={"access_control_list": [
            {"group_name": cfg["readers_group"], "permission_level": "CAN_USE"}]})
        log(f"Granted CAN_USE on the app (and nothing else) to {cfg['readers_group']}")

    write_app_yaml(app_dir, cfg, state)
    log(f"Syncing {app_dir.name} -> {ws_path}")
    db.run("sync", str(app_dir), ws_path, "--full",
           "--exclude", "node_modules/**", "--exclude", "dist/**", "--exclude", ".git/**", output_json=False)
    # A stopped app (idle policy, workspace quota, or someone pressed Stop) rejects deploys.
    compute = (db.run("apps", "get", name).get("compute_status") or {}).get("state")
    if compute != "ACTIVE":
        log(f"App compute is {compute}; starting it (a few minutes)…")
        db.run("apps", "start", name)
    # Starting an app redeploys its previous version, and only one deployment may run at a time.
    for _ in range(120):
        app_now = db.run("apps", "get", name)
        states = {(app_now.get(k) or {}).get("status", {}).get("state") for k in ("active_deployment", "pending_deployment")}
        if "IN_PROGRESS" not in states:
            break
        if _ == 0:
            log("Waiting for the app's current deployment to finish…")
        time.sleep(10)
    log("Deploying (the platform runs npm install + build)…")
    dep = db.run("apps", "deploy", name, "--source-code-path", ws_path)
    status = dep.get("status", {})
    if status.get("state") != "SUCCEEDED":
        raise DeployError(f"App deployment did not succeed: {status}")
    save_state(cfg_path, state)
    log(f"App live at {state['app_url']}")
    if state.get("catalog_access_pending"):
        log(f"Still needed from an admin: GRANT USE CATALOG ON CATALOG {c} TO `{sp}`; (see the warning above). "
            f"No redeploy is needed after they run it.")


def step_smoke(cfg: dict, state: dict, db: Databricks) -> None:
    if not (os.environ.get("LENS_SMOKE_CLIENT_ID") and os.environ.get("LENS_SMOKE_CLIENT_SECRET")):
        log("Skipping smoke test (set LENS_SMOKE_CLIENT_ID / LENS_SMOKE_CLIENT_SECRET — see README)")
        return
    host = db.run("auth", "describe", check=False) or {}
    host = (host.get("details", {}) or {}).get("host") or os.environ.get("DATABRICKS_HOST")
    if not host:
        raise DeployError("Could not determine workspace host for the smoke test; set DATABRICKS_HOST.")
    rc = subprocess.run([sys.executable, str(DEPLOY_DIR / "smoke_test.py"), "--host", host,
                         "--app-url", state["app_url"]]).returncode
    if rc != 0:
        raise DeployError("Smoke test failed — see output above.")


# --------------------------------------------------------------------------- main

def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--config", required=True, help="Path to a config JSON, e.g. deploy/config/org.json")
    ap.add_argument("--only", help=f"Comma-separated steps to run: {','.join(STEPS)}")
    ap.add_argument("--skip", help="Comma-separated steps to skip")
    args = ap.parse_args()

    cfg_path = Path(args.config).resolve()
    cfg = load_config(cfg_path)
    steps = args.only.split(",") if args.only else list(STEPS)
    if args.skip:
        steps = [s for s in steps if s not in args.skip.split(",")]
    unknown = set(steps) - set(STEPS)
    if unknown:
        sys.exit(f"Unknown steps: {sorted(unknown)}")

    db = Databricks(cfg["profile"])
    state = load_state(cfg_path)
    started = time.time()
    run_stamp = time.strftime("%Y%m%d-%H%M%S")
    try:
        step_preflight(db, cfg, state)
        sql = Sql(db, state["warehouse_id"])
        for step in STEPS:
            if step not in steps:
                continue
            log(f"=== {step} ===")
            if step == "schemas":
                step_schemas(sql, cfg)
            elif step == "ingest":
                step_ingest(db, sql, cfg)
            elif step == "context":
                step_context(sql, cfg)
            elif step == "transform":
                step_transform(sql, cfg)
            elif step == "views":
                step_views(sql, cfg)
            elif step == "summary":
                step_summary(sql, cfg)
            elif step == "genie":
                step_genie(db, cfg, state, cfg_path)
            elif step == "lakebase":
                step_lakebase(db, cfg, state, cfg_path)
            elif step == "app":
                for needed in ("genie_space_id", "lakebase_host"):
                    if needed not in state:
                        raise DeployError(f"'app' needs '{needed}' — run the genie and lakebase steps first.")
                step_app(db, sql, cfg, state, cfg_path)
            elif step == "smoke":
                if "app_url" not in state:
                    raise DeployError("'smoke' needs a deployed app — run the app step first.")
                step_smoke(cfg, state, db)
            if step in ("ingest", "transform", "views", "summary"):
                # New gold data or views → cached answers may be wrong. One stamp per run, so a full deploy bumps once.
                bump_cache_version(db, cfg, state, cfg_path, "data", run_stamp)
        save_state(cfg_path, state)
    except DeployError as e:
        log(f"FAILED: {e}")
        sys.exit(1)
    log(f"Done in {int(time.time() - started)}s. App: {state.get('app_url', '(not deployed)')}")


if __name__ == "__main__":
    main()
