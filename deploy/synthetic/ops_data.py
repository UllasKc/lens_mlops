"""Synthetic ML-operations data for the Command Center: serving, SLA, cost, feature drift, promotions,
governance and recorded pipeline events, for the same 100 models as the source data.

The source data covers model health and business value over 5-7 Oct 2026. It has no serving SLA, cost,
feature-level drift, retraining dates, promotions or governance records, so these are generated here:
deterministic (fixed seed, same output on every run and workspace) and consistent with the source
(e.g. the 4 models that really drift are the ones with high feature drift, tied to a recorded event).
Every table is labelled synthetic in Unity Catalog and on the page.

    python deploy/synthetic/ops_data.py <data_dir> [<out_dir>]   # writes the CSVs and prints a summary
"""
import sys
from datetime import date, datetime, timedelta
from pathlib import Path

import numpy as np
import pandas as pd

SEED = 20261007
AS_OF = date(2026, 10, 7)                 # the source data's latest day ("now")
FIRST_DAY = AS_OF - timedelta(days=29)    # 30 days of daily serving history
GPU_USD_PER_INSTANCE_DAY = 76.8           # $3.20 an hour
CPU_USD_PER_INSTANCE_DAY = 9.6            # $0.40 an hour
USD_PER_MILLION_REQUESTS = 0.60

FEATURES = {  # asset type -> its input features (sensor tags unless noted)
    "Compressor": ["discharge_pressure", "suction_pressure", "inlet_temp", "vibration_rms", "motor_current", "flow_rate"],
    "Pump": ["discharge_pressure", "suction_pressure", "flow_rate", "vibration_rms", "bearing_temp", "motor_current"],
    "Reactor": ["reactor_pressure", "bed_temp", "feed_rate", "catalyst_age_days", "lab_purity", "lab_moisture"],
    "Furnace": ["firebox_temp", "fuel_gas_pressure", "excess_o2", "tube_skin_temp", "feed_rate", "lab_sulfur"],
    "Turbine": ["inlet_pressure", "exhaust_temp", "shaft_speed", "vibration_rms", "fuel_flow", "ambient_temp"],
    "HVAC Unit": ["supply_air_temp", "return_air_temp", "duct_pressure", "fan_speed", "chilled_water_temp", "ambient_temp"],
    "Heat Exchanger": ["shell_inlet_pressure", "tube_inlet_temp", "tube_outlet_temp", "flow_rate", "delta_p", "lab_fouling_index"],
}


def source_of(feature: str) -> str:
    if feature.startswith("lab_"):
        return "lims.lab_results"
    if feature == "ambient_temp":
        return "weather.ambient"
    if feature == "catalyst_age_days":
        return "erp.maintenance_orders"
    return "historian.sensor_events"


def real_stats(data_dir: Path) -> pd.DataFrame:
    """Per-model facts from the source predictions: p95 latency, latest-day drift, error change."""
    p = pd.read_csv(data_dir / "predictions.csv",
                    usecols=["timestamp", "model_id", "actual_value", "prediction_error", "drift_score", "latency_ms"])
    p["day"] = p["timestamp"].str[:10]
    last, first = str(AS_OF), str(AS_OF - timedelta(days=2))
    v = p.dropna(subset=["actual_value"]).assign(ae=lambda d: d.prediction_error.abs(), aa=lambda d: d.actual_value.abs())
    err = v.groupby(["model_id", "day"])[["ae", "aa"]].sum()
    err = (err.ae / err.aa).unstack()
    return pd.DataFrame({
        "p95": p.groupby("model_id").latency_ms.quantile(0.95),
        "drift_latest": p[p.day == last].groupby("model_id").drift_score.mean(),
        "error_change": err[last] / err[first] - 1,
    })


def generate(data_dir: Path) -> dict[str, pd.DataFrame]:
    rng = np.random.default_rng(SEED)
    reg = pd.read_csv(data_dir / "model_registry.csv").sort_values("model_id").reset_index(drop=True)
    st = real_stats(data_dir).reindex(reg.model_id)
    ids = list(reg.model_id)
    crit = dict(zip(reg.model_id, reg.criticality))
    drifting = [m for m in ids if st.loc[m, "drift_latest"] >= 0.30]
    acc_drop = [m for m in ids if st.loc[m, "error_change"] >= 0.05]

    # ---- Choose the synthetic situations (seeded), keeping them disjoint where a model can't be both.
    taken = set(drifting) | set(acc_drop)
    pool = [m for m in ids if m not in taken]
    def pick(n, cond=lambda m: True):
        out = [m for m in rng.permutation(pool) if cond(m) and m not in taken][:n]
        taken.update(out)
        return out
    stale = pick(6, lambda m: crit[m] != "High")                 # not retrained in > 90 days
    unused = stale[:4]                                            # stale and barely called: decommission candidates
    backlog = pick(9)                                             # retrain overdue (> 14 days), not stale
    watch = pick(9)                                               # 1-2 input features drifting, under the model threshold

    # ---- Endpoints: one per model.
    ep = []
    for _, r in reg.iterrows():
        m, c = r.model_id, r.criticality
        real_time = c == "High" or (c == "Medium" and rng.random() < 0.7) or (c == "Low" and rng.random() < 0.5)
        if m in unused:
            real_time = False
        gpu = r.model_type != "First-Principle" and rng.random() < (0.45 if r.model_type == "Time-Series" else 0.55)
        inst = int(rng.integers(1, 5 if gpu else 4))
        value = {"High": (180e3, 650e3), "Medium": (40e3, 180e3), "Low": (6e3, 40e3)}[c]
        cadence = {"High": 30, "Medium": 45, "Low": 60}[c]
        deployed = date.fromisoformat(r.deployed_date)
        if m in stale:
            trained = AS_OF - timedelta(days=int(rng.integers(100, 181)))
        elif m in backlog:
            trained = AS_OF - timedelta(days=min(cadence + int(rng.integers(16, 41)), 88))
        else:
            trained = AS_OF - timedelta(days=int(rng.integers(5, cadence - 1)))
        ep.append({"model_id": m, "endpoint_name": f"{m.lower().replace('_', '-')}-serving",
                   "serving_mode": "real_time" if real_time else "batch", "compute_type": "GPU" if gpu else "CPU",
                   "instance_count": inst, "value_at_stake_usd_month": round(rng.uniform(*value), -3),
                   "last_trained_date": max(trained, deployed), "retrain_cadence_days": cadence})
    ep = pd.DataFrame(ep)
    ep.loc[ep.model_id == "MDL_061", "value_at_stake_usd_month"] = 950_000.0   # the model behind the largest incident
    rt_gpu = ep[(ep.serving_mode == "real_time") & (ep.compute_type == "GPU")].model_id
    order = [m for m in rng.permutation(rt_gpu) if m not in drifting]
    latency_hit = [m for m in order if crit[m] == "High"][:3] + [m for m in order if crit[m] == "Medium"][:2]
    latency_fixed = latency_hit[:2]                               # minimum replicas restored on 5 Oct
    low_util = [m for m in rng.permutation(ep[ep.compute_type == "GPU"].model_id) if m not in latency_hit][:8]

    # ---- Daily serving, 8 Sep - 7 Oct.
    days = [FIRST_DAY + timedelta(days=i) for i in range(30)]
    rows = []
    for _, e in ep.iterrows():
        m = e.model_id
        base = 150 if m in unused else (rng.lognormal(np.log(800e3), 0.8) if e.serving_mode == "real_time" else rng.uniform(20e3, 200e3))
        util = rng.uniform(8, 20) if m in low_util else rng.uniform(35, 75)
        for d in days:
            wk = 0.8 if d.weekday() >= 5 else 1.0
            forecast = base * wk
            actual = forecast * rng.uniform(0.92, 1.01)
            down = 0.0
            if rng.random() < 0.012:
                down = float(rng.integers(3, 20))
            p95 = float(st.loc[m, "p95"]) + rng.normal(0, 2.5)
            if m in latency_hit and date(2026, 10, 2) <= d and not (m in latency_fixed and d >= date(2026, 10, 5)):
                p95 = rng.uniform(215, 420)
                if d <= date(2026, 10, 4):
                    down += float(rng.integers(60, 110))
            per_day = GPU_USD_PER_INSTANCE_DAY if e.compute_type == "GPU" else CPU_USD_PER_INSTANCE_DAY
            cost = e.instance_count * per_day + actual / 1e6 * USD_PER_MILLION_REQUESTS
            rows.append({"day": d, "model_id": m, "requests": int(actual), "forecast_requests": int(forecast),
                         "downtime_minutes": down, "p95_latency_ms": round(p95, 1),
                         "error_requests": int(actual * (0.0004 + (0.004 if down else 0))),
                         "cost_usd": round(cost, 2), "utilization_pct": round(util + rng.normal(0, 3), 1)})
    serving = pd.DataFrame(rows)

    # ---- Feature drift (population stability index), month start vs latest day.
    fd = []
    for _, r in reg.iterrows():
        m = r.model_id
        feats = FEATURES[r.asset_type]
        high = []
        if m in drifting:
            sensor = [f for f in feats if source_of(f) == "historian.sensor_events"]
            high = list(rng.permutation(sensor)[: int(rng.integers(3, 5))])
        elif m in watch:
            high = list(rng.permutation(feats)[: int(rng.integers(1, 3))])
        for f in feats:
            latest = rng.uniform(0.28, 0.55) if (f in high and m in drifting) else rng.uniform(0.26, 0.32) if f in high else rng.uniform(0.02, 0.18)
            fd.append({"model_id": m, "feature_name": f, "feature_source": source_of(f),
                       "psi_month_start": round(rng.uniform(0.02, 0.10), 3), "psi_latest": round(latest, 3)})
    feature_drift = pd.DataFrame(fd)

    # ---- Promotions in flight (candidate versions in staging or canary).
    cand = [m for m in rng.permutation(ids) if m not in stale + unused][:6]
    status = ["on_track", "on_track", "on_track", "on_track", "at_risk", "blocked"]
    blockers = {"at_risk": "Canary error 6% above the live version", "blocked": "Waiting on lab-results data to retrain"}
    promotions = pd.DataFrame([{
        "promotion_id": f"PRM-{i + 1:03d}", "model_id": m,
        "candidate_version": "v" + ".".join(str(int(x) + (1 if j == 1 else 0)) for j, x in enumerate(
            reg.set_index("model_id").loc[m, "model_version"].lstrip("v").split("."))),
        "stage": "canary" if i < 2 else "staging", "planned_date": AS_OF + timedelta(days=int(rng.integers(2, 23))),
        "status": s, "blocker": blockers.get(s)} for i, (m, s) in enumerate(zip(cand, status))])

    # ---- Governance: model cards and quarterly bias audits.
    gaps = [m for m in rng.permutation(ids)][:11]
    gov = []
    for m in ids:
        if m in gaps and rng.random() < 0.5:
            card, audit = AS_OF - timedelta(days=int(rng.integers(190, 400))), AS_OF - timedelta(days=int(rng.integers(20, 80)))
        elif m in gaps:
            card, audit = AS_OF - timedelta(days=int(rng.integers(20, 150))), AS_OF - timedelta(days=int(rng.integers(100, 200)))
        else:
            card, audit = AS_OF - timedelta(days=int(rng.integers(10, 170))), AS_OF - timedelta(days=int(rng.integers(5, 85)))
        gov.append({"model_id": m, "model_card_updated": card, "last_bias_audit": audit,
                    "next_audit_due": audit + timedelta(days=91), "review_deadline": date(2026, 11, 30)})
    governance = pd.DataFrame(gov)

    # ---- Recorded pipeline events and the models each affected (the "recorded cause" of an issue).
    events = pd.DataFrame([
        ("EVT-001", datetime(2026, 10, 5, 2, 0), "historian.sensor_events", "schema_change",
         "Pressure tags in the sensor feed switched from bar to psi; models reading them saw their inputs shift."),
        ("EVT-002", datetime(2026, 10, 2, 9, 0), "serving platform", "config_change",
         "Autoscaling minimum replicas set to 0 on GPU endpoints; cold starts pushed p95 latency over the SLO."),
        ("EVT-003", datetime(2026, 10, 5, 14, 0), "serving platform", "fix",
         "Minimum replicas restored on 2 of the 5 affected endpoints."),
        ("EVT-004", datetime(2026, 9, 20, 6, 0), "lims.lab_results", "pipeline_failure",
         "Lab-results ingestion job failing since 20 Sep; retraining datasets are incomplete."),
        ("EVT-005", datetime(2026, 10, 1, 0, 0), "operations log", "process_change",
         "Seasonal operating-mode switch at several sites on 1 Oct."),
        ("EVT-006", datetime(2026, 10, 1, 9, 0), "model risk office", "audit_cycle",
         "Quarterly model-risk review opened: model cards and bias audits are due by 30 Nov."),
    ], columns=["event_id", "event_time", "source", "event_type", "description"])
    links = ([("EVT-001", m, "feature_drift") for m in drifting] + [("EVT-002", m, "latency") for m in latency_hit]
             + [("EVT-003", m, "latency") for m in latency_fixed] + [("EVT-004", m, "retrain_backlog") for m in backlog[:6]]
             + [("EVT-005", m, "accuracy") for m in acc_drop] + [("EVT-006", m, "governance") for m in gaps])
    event_models = pd.DataFrame(links, columns=["event_id", "model_id", "issue_type"])

    return {"ops_model_endpoints": ep, "ops_serving_daily": serving, "ops_feature_drift": feature_drift,
            "ops_promotions": promotions, "ops_governance": governance, "ops_pipeline_events": events,
            "ops_event_models": event_models}


def write(tables: dict[str, pd.DataFrame], out_dir: Path) -> dict[str, Path]:
    out_dir.mkdir(parents=True, exist_ok=True)
    paths = {}
    for name, df in tables.items():
        paths[name] = out_dir / f"{name}.csv"
        df.to_csv(paths[name], index=False)
    return paths


if __name__ == "__main__":
    data_dir = Path(sys.argv[1])
    t = generate(data_dir)
    if len(sys.argv) > 2:
        write(t, Path(sys.argv[2]))
    s = t["ops_serving_daily"]
    mtd = s[s.day >= date(2026, 10, 1)]
    minutes = len(mtd) * 1440
    print({k: len(v) for k, v in t.items()})
    print(f"MTD uptime {1 - mtd.downtime_minutes.sum() / minutes:.4%}, downtime {mtd.downtime_minutes.sum():.0f} min; "
          f"requests {mtd.requests.sum() / 1e6:.0f}M vs forecast {mtd.forecast_requests.sum() / 1e6:.0f}M; "
          f"cost ${mtd.cost_usd.sum():,.0f} MTD; per 1K ${mtd.cost_usd.sum() / mtd.requests.sum() * 1000:.4f}")
    last3 = s[s.day >= date(2026, 10, 5)]
    print(f"last 3 days downtime {last3.downtime_minutes.sum():.0f} min; "
          f"latency over 200 ms in the last 7 days: {mtd[mtd.p95_latency_ms > 200].model_id.nunique()} endpoints")
    fd = t["ops_feature_drift"]
    hi = fd[fd.psi_latest > 0.25].groupby("model_id").size()
    print(f"PSI > 0.25 on >= 3 features: {(hi >= 3).sum()} models; on 1-2: {((hi >= 1) & (hi < 3)).sum()} models")
    e = t["ops_model_endpoints"]
    age = (pd.Timestamp(date(2026, 10, 7)) - pd.to_datetime(e.last_trained_date)).dt.days
    print(f"stale (>90 d): {(age > 90).sum()}; overdue >14 d and not stale: {((age - e.retrain_cadence_days > 14) & (age <= 90)).sum()}; "
          f"GPU {(e.compute_type == 'GPU').sum()}, real-time {(e.serving_mode == 'real_time').sum()}")
    g = t["ops_governance"]
    gap = (g.model_card_updated < AS_OF - timedelta(days=180)) | (g.next_audit_due < AS_OF)
    print(f"governance gaps: {gap.sum()}; promotions: {t['ops_promotions'].status.value_counts().to_dict()}")
