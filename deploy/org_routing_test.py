"""Org routing test: every routing combination, for the ORGANISATION workspace only.

1. Routing matrix (router decisions only). 22 kinds of message x 3 settings (Auto / Quick / Deep) x 4 starting
   points (a new chat; after a quick data answer; after a deep analysis; after a guide answer about the app).
   Each starting point is seeded once with a real answer; the probes then only ask the router
   (POST /api/chat/route), which adds nothing to the chat. About 260 probes, no query-engine calls.
     FAIL  a firm rule in router.ts was broken (e.g. "Quick/Deep is kept", "asking for more after a data
           answer is a fresh deep analysis", "app wording goes to the guide")
     WARN  the router model's judgement went the other way where the rules let it decide
     INFO  no single right answer (recorded for review)
2. End to end (real answers): clicked suggestions and buttons in each mode, then the live conversations
   (routing_test.py's three plus the org smoke test's three).

It costs real usage (the 70B router for every probe; several answers and deep analyses), so it refuses to
run against the personal workspace. Everything printed is also written to deploy/.state/org-routing-<time>.log.

Usage (same service principal as the smoke test):
  python deploy/deploy.py --config deploy/config/org-v1.json --only org-routing [--test-args "--matrix-only"]
  python deploy/org_routing_test.py --host https://<workspace> --app-url https://<app> [--matrix-only] [--skip-slow]
"""
import argparse
import os
import sys
import time
from datetime import datetime
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).resolve().parent))
from org_smoke_test import ORG_CONVERSATIONS, PERSONAL_WORKSPACE_IDS  # noqa: E402
from routing_test import CONVERSATIONS, run_conversations  # noqa: E402
from smoke_test import get_m2m_token, new_session, read_sse  # noqa: E402

SETTINGS = ["auto", "chat", "agent"]

# The starting points, each seeded once with a real answer: (setting to ask in, question, what the seed must be).
CONTEXTS = {
    "C0": ("a new chat", None),
    "C1": ("after a quick data answer", ("chat", "Which models are showing drift this week?", "data")),
    "C2": ("after a deep analysis", ("agent", "Which site has the most drifting models?", "data")),
    "C3": ("after a guide answer about the app", ("chat", "What does the Observability tab show?", "platform")),
}

# The kinds of message probed. REPEAT is the starting point's own question.
MESSAGES = {
    "LOOKUP": "Which models are drifting right now?",
    "MULTI": "Why are the drifting models losing confidence, and which sites should we review first?",
    "LOOSE_DATA": "Where is the drift concentrated across sites?",
    "HELP_DATA": "Help me find the models with the most false alarms",
    "PLATFORM": "How do I export the model list?",
    "PLATFORM2": "What does the Explorer tab do?",
    "LOOSE_UI": "Where is the site filter?",
    "VAGUE": "Tell me more",
    "VAGUE_SITE": "and for Houston 1?",
    "EXPLAIN": "Can you explain that?",
    "MORE": "This is not enough, I need more detail",
    "DEEPER": "Go deeper",
    "PUSH": "No, you do it",
    "PUSH_DATA": "Just show me the numbers",
    "NOT_ASKED": "That's not what I asked",
    "REPEAT": None,
    "NEW_Q": "Why is the second one so high?",
    "TOTAL": "What's the total?",
    "THANKS": "Thanks!",
    "HINDI": "इस हफ्ते कौन से मॉडल ड्रिफ्ट दिखा रहे हैं?",
    "SPANISH": "¿Cómo exporto la lista de modelos?",
    "PII": "My email is jane.doe@example.com. Which models are drifting?",
}

DATA_KINDS = {"LOOKUP", "MULTI", "LOOSE_DATA", "HELP_DATA", "PII"}
ESCALATE_KINDS = {"MORE", "DEEPER", "PUSH", "PUSH_DATA", "NOT_ASKED"}


def expectations(ctx: str, kind: str, setting: str):
    """[(key, value, 'firm'|'soft', why)] for one probe; empty = INFO (no single right answer).
    Firm: enforced by router.ts decide() whatever the router model reads (checked offline against every
    reading). Soft: the router model's judgement. invariants() adds the firm rules that hold for every probe."""
    e = []
    after_data, after_guide = ctx in ("C1", "C2"), ctx == "C3"

    if kind in ("PLATFORM", "PLATFORM2"):
        e.append(("dest", "platform", "soft", "app wording goes to the guide"))
    elif kind == "LOOSE_UI":
        e.append(("dest", "platform", "soft", "names something on screen"))
    elif kind == "SPANISH":
        e.append(("dest", "platform", "soft", "an app question in Spanish"))
    elif kind == "HINDI":
        e.append(("dest", "data", "soft", "a data question in Hindi"))
    elif kind in DATA_KINDS:
        e.append(("dest", "data", "firm", "names model data and nothing on screen" + (" (personal details masked)" if kind == "PII" else "")))
        e.append(("escalated", False, "soft", "a new question is not 'asked for more'"))
        if kind == "MULTI" and setting == "chat":
            e.append(("suggestDeep", True, "soft", "Quick kept for a multi-step question, deep analysis offered"))
        if kind == "MULTI" and setting == "auto":
            e.append(("mode", "agent", "soft", "Auto: a multi-step 'why' needs a deep analysis"))
    elif kind in ("VAGUE", "EXPLAIN"):
        if after_guide:
            e.append(("dest", "platform", "firm", "a short follow-up to an app answer continues the guide"))
        elif after_data:
            e += [("dest", "data", "soft", "a short follow-up to a data answer stays with the data"), ("escalated", False, "soft", "not 'asked for more'")]
    elif kind == "VAGUE_SITE":
        if ctx != "C0":
            e.append(("dest", "data", "firm", "names model data (a site), so the data"))
    elif kind in ("MORE", "DEEPER"):
        if after_data:
            e += [("dest", "data", "firm", "asked for more after a data answer"), ("escalated", True, "firm", "a fresh deep analysis, whatever the setting")]
        elif after_guide:
            e.append(("dest", "platform", "firm", "asking for more about an app answer continues the guide"))
    elif kind in ("PUSH", "NOT_ASKED"):
        if after_data:
            e += [("dest", "data", "firm", "pushback after a data answer"), ("escalated", True, "firm", "pushback gets a deep analysis, whatever the setting")]
        elif after_guide:
            e.append(("dest", "platform", "firm", "pushback on a genuine app answer, naming no data, stays with the guide"))
    elif kind == "PUSH_DATA":
        if after_data:
            e += [("dest", "data", "firm", "pushback after a data answer"), ("escalated", True, "firm", "pushback gets a deep analysis")]
        elif after_guide:
            e.append(("dest", "data", "firm", "pushback naming data ('numbers') after the guide goes to the data"))
    elif kind == "REPEAT":
        if after_data:
            e += [("dest", "data", "firm", "asked again"), ("repeat", True, "firm", "asked again: the person chooses, or a fresh deep analysis after a weak answer")]
        elif after_guide:
            # The no-model repeat check needs 3+ content words; this guide question has 2, so the model decides.
            e.append(("dest", "data", "soft", "never the guide twice when the same app question is asked again"))
    elif kind == "NEW_Q":
        if after_guide:
            e.append(("dest", "platform", "firm", "a new question about an app answer, naming no data, continues the guide"))
        elif after_data:
            e += [("dest", "data", "soft", "a new question about the answer"), ("escalated", False, "soft", "a follow-up, not 'asked for more'")]
    elif kind == "TOTAL":
        if after_data:
            e.append(("dest", "data", "soft", "a follow-up about the data"))
    # THANKS, and most short replies in a new chat: no single right answer.
    return e


def invariants(setting: str, got: dict):
    """Firm rules that hold for every probe, whatever the router model reads: [(problem)]."""
    bad = []
    if got["dest"] == "platform" and got["mode"] != "chat":
        bad.append(f"mode {got['mode']} (a guide answer is always Quick)")
    if got["escalated"] and got["mode"] != "agent":
        bad.append(f"mode {got['mode']} (an escalated answer is always a deep analysis)")
    if got["dest"] == "data" and not got["escalated"] and not got["confirm"] and setting in ("chat", "agent") and got["mode"] != setting:
        bad.append(f"mode {got['mode']} (the {setting} setting is kept unless the person asks for more)")
    if got["suggestDeep"] and not (setting == "chat" and got["dest"] == "data" and got["mode"] == "chat"):
        bad.append("a deep analysis offered outside Quick")
    return bad


def main():
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    p = argparse.ArgumentParser(description="Org routing test (organisation workspace only)")
    p.add_argument("--host", required=True)
    p.add_argument("--app-url", required=True)
    p.add_argument("--matrix-only", action="store_true", help="Only the routing matrix (no end-to-end answers beyond the 3 seeds)")
    p.add_argument("--skip-slow", action="store_true", help="Skip the deep-analysis seed and deep end-to-end checks")
    p.add_argument("--contexts", default="C0,C1,C2,C3", help="Starting points to probe, e.g. C1,C3")
    p.add_argument("--log-dir", default=str(Path(__file__).resolve().parent / ".state"))
    args = p.parse_args()
    if any(w in args.host or w in args.app_url for w in PERSONAL_WORKSPACE_IDS):
        sys.exit("org_routing_test.py is for the organisation workspace only; this is the personal workspace. Stopping.")

    Path(args.log_dir).mkdir(parents=True, exist_ok=True)
    log_path = Path(args.log_dir) / f"org-routing-{datetime.now():%Y%m%d-%H%M%S}.log"
    log_file = open(log_path, "w", encoding="utf-8")

    def out(line=""):
        print(line, flush=True)
        log_file.write(line + "\n")
        log_file.flush()

    cid, sec = os.environ.get("LENS_SMOKE_CLIENT_ID"), os.environ.get("LENS_SMOKE_CLIENT_SECRET")
    if not cid or not sec:
        sys.exit("Set LENS_SMOKE_CLIENT_ID and LENS_SMOKE_CLIENT_SECRET (see README, Smoke test)")
    base = args.app_url.rstrip("/")
    H = {"Authorization": f"Bearer {get_m2m_token(args.host, cid, sec)}", "Content-Type": "application/json"}
    contexts = [c.strip().upper() for c in args.contexts.split(",") if c.strip().upper() in CONTEXTS]
    if args.skip_slow and "C2" in contexts:
        contexts.remove("C2")
    made = []
    totals = {"PASS": 0, "WARN": 0, "FAIL": 0, "INFO": 0, "SKIP": 0}
    problems = []

    out("=== ORG ROUTING TEST ===")
    out(f"app {base} · contexts {','.join(contexts)}{' · matrix only' if args.matrix_only else ''}{' · skip-slow' if args.skip_slow else ''}"
        f" · {datetime.now():%Y-%m-%d %H:%M}")
    out(f"log {log_path}")

    def ask(question, mode, sid, **extra):
        t0 = time.time()
        with requests.post(f"{base}/api/chat/sessions/{sid}/messages", headers={**H, "Accept": "text/event-stream"},
                           json={"content": question, "mode": mode, **extra}, stream=True, timeout=900) as r:
            r.raise_for_status()
            answer, error, done = {}, None, False
            for event, data in read_sse(r):
                if event == "answer":
                    answer = data
                elif event == "error":
                    error = data
                elif event == "done":
                    done = bool(isinstance(data, dict) and data.get("success"))
        return {"ok": done and not error and bool(answer.get("text")), "answer": answer, "error": error, "secs": round(time.time() - t0, 1),
                "platform": bool(answer.get("platform")), "mode": answer.get("mode"), "route": answer.get("route") or {},
                "blocked": bool((answer.get("guard") or {}).get("blocked")), "cache": answer.get("cache")}

    def session():
        sid = new_session(base, H)
        made.append(sid)
        return sid

    # ------------------------------------------------------------------------------------- 1. seeds
    out("\n--- 1. Routing matrix: seeding the starting points")
    seeds = {}
    for c in contexts:
        label, seed = CONTEXTS[c]
        sid = session()
        if not seed:
            seeds[c] = (sid, None)
            out(f"SEED [{c}] {label}: empty chat")
            continue
        mode, q, want = seed
        a = ask(q, mode, sid, standalone=True, selected=mode)
        got = "platform" if a["platform"] else "data"
        if not a["ok"] or got != want or a["blocked"]:
            out(f"FAIL [{c}] seed {label}: {q!r} → {got} ({a['secs']}s, {a['error'] or ('blocked' if a['blocked'] else '')}); its probes are skipped")
            problems.append(f"seed {c} failed")
            totals["FAIL"] += 1
            continue
        seeds[c] = (sid, q)
        out(f"SEED [{c}] {label}: {q!r} answered by {got}{' (' + a['mode'] + ')' if a.get('mode') else ''}"
            f"{' from cache' if a['cache'] else ''} in {a['secs']}s")

    # ------------------------------------------------------------------------------------- 1. probes
    out("\n--- 1. Routing matrix: probes (router only)")
    t_matrix = time.time()
    for c in contexts:
        if c not in seeds:
            n = sum(1 for k in MESSAGES for _ in SETTINGS)
            totals["SKIP"] += n
            continue
        sid, own_q = seeds[c]
        out(f"\n  [{c}] {CONTEXTS[c][0]}")
        grid = []
        for kind, text in MESSAGES.items():
            q = own_q if kind == "REPEAT" else text
            if q is None:
                continue
            cells = []
            for setting in SETTINGS:
                r = requests.post(f"{base}/api/chat/route", headers=H, timeout=120,
                                  json={"question": q, "selected": setting, "sessionId": sid})
                if r.status_code >= 400:
                    cells.append("✗")
                    totals["FAIL"] += 1
                    problems.append(f"{c} {kind} {setting}: HTTP {r.status_code}")
                    out(f"    FAIL {kind:<10} {setting:<5} HTTP {r.status_code}: {r.text[:150]}")
                    continue
                d = r.json()
                got = {"dest": d.get("destination"), "mode": d.get("mode"), "escalated": bool(d.get("escalated")),
                       "confirm": bool(d.get("confirm")), "suggestDeep": bool(d.get("suggestDeep"))}
                # "repeat": the person is asked to choose, or (after a weak answer) a fresh deep analysis runs.
                got["repeat"] = got["confirm"] or (got["escalated"] and "weak answer" in str(d.get("reason", "")))
                exp = expectations(c, kind, setting)
                firm_bad = [f"{k} {got.get(k)} (want {v}: {why})" for k, v, lvl, why in exp if lvl == "firm" and got.get(k) != v]
                firm_bad += invariants(setting, got)
                soft_bad = [f"{k} {got.get(k)} (want {v}: {why})" for k, v, lvl, why in exp if lvl == "soft" and got.get(k) != v]
                status = "FAIL" if firm_bad else "WARN" if soft_bad else "PASS" if exp else "INFO"   # INFO still had the invariants checked
                totals[status] += 1
                cells.append({"PASS": "✓", "FAIL": "✗", "WARN": "~", "INFO": "·"}[status])
                desc = (f"{got['dest']}/{got['mode']}{' escalated' if got['escalated'] else ''}{' confirm' if got['confirm'] else ''}"
                        f"{' suggest-deep' if got['suggestDeep'] else ''} ({d.get('method')}: {str(d.get('reason'))[:80]})")
                if status != "PASS":
                    out(f"    {status} {kind:<10} {setting:<5} {q[:60]!r} → {desc}"
                        + (f"\n           {'; '.join(firm_bad or soft_bad)}" if firm_bad or soft_bad else ""))
                    if status == "FAIL":
                        problems.append(f"{c} {kind} {setting}: {'; '.join(firm_bad)}")
            grid.append(f"    {kind:<10} " + "  ".join(f"{s[:5]:<5}{x}" for s, x in zip(SETTINGS, cells)))
        out("    grid (✓ pass, ✗ fail, ~ warn, · info):")
        for g in grid:
            out(g)
    out(f"\n  matrix done in {(time.time() - t_matrix) / 60:.1f} min")

    # ------------------------------------------------------------------------------------- 2. end to end
    if not args.matrix_only:
        out("\n--- 2. End to end: clicks and buttons in each mode")

        def e2e(name, fn):
            t0 = time.time()
            try:
                status, detail = "PASS", fn()
            except Exception as e:  # noqa: BLE001
                status, detail = ("SKIP", str(e)[6:]) if str(e).startswith("[skip]") else ("FAIL", f"{type(e).__name__}: {e}")
            totals[status] += 1
            if status == "FAIL":
                problems.append(f"e2e {name}: {detail}"[:200])
            out(f"{status:<4} {name} ({time.time() - t0:.0f}s)\n       {str(detail)[:400]}")

        def need(a, cond, msg):
            if not a["ok"]:
                raise RuntimeError(f"no answer ({a['error']})")
            if a["blocked"]:
                raise RuntimeError("blocked by a guardrail")
            if not cond:
                raise RuntimeError(msg)

        def preset(q, mode, want_platform):
            def fn():
                a = ask(q, mode, session(), preset=True, standalone=True, selected=mode)
                need(a, a["platform"] == want_platform, f"answered by {'the guide' if a['platform'] else 'the data'}")
                if not want_platform and a["mode"] and a["mode"] != mode:
                    raise RuntimeError(f"answered in {a['mode']}, the click's mode was {mode}")
                return f"{'guide' if a['platform'] else 'data'} in {a.get('mode')}{' from cache' if a['cache'] else ''}, {a['secs']}s"
            return fn

        e2e("clicked data suggestion, Quick", preset("Which business unit delivered the most value?", "chat", False))
        if args.skip_slow:
            e2e("clicked data suggestion, Deep", lambda: (_ for _ in ()).throw(RuntimeError("[skip] --skip-slow")))
        else:
            e2e("clicked data suggestion, Deep", preset("What's happening with MDL_061? Explain the spike.", "agent", False))
        e2e("clicked 'What can you help me with?', Quick", preset("What can you help me with?", "chat", True))
        e2e("clicked 'What can you help me with?', Deep setting (guide still answers)", preset("What can you help me with?", "agent", True))

        def chip():
            sid = session()
            first = ask("Which models are showing drift this week?", "chat", sid, standalone=True, selected="chat")
            need(first, True, "")
            a = ask("Which of those are high criticality?", "chat", sid, preset=True, selected="chat")
            need(a, not a["platform"], "a follow-up chip went to the guide")
            return f"chip answered by the data in {a.get('mode')}, {a['secs']}s"
        e2e("follow-up chip in the mode of the answer it follows", chip)

        def data_instead():
            sid = session()
            g = ask("What does the Explorer tab do?", "chat", sid, selected="auto")
            need(g, g["platform"], "the app question wasn't answered from the guide")
            out_ = []
            for setting in ("chat", "agent") if not args.skip_slow else ("chat",):
                a = ask("What does the Explorer tab do?", setting, sid, force="data", selected=setting)
                need(a, not a["platform"], f"'Answer from the data instead' ({setting}) went to the guide again")
                out_.append(f"{setting}: data in {a.get('mode')} {a['secs']}s")
            return "; ".join(out_)
        e2e("'Answer from the data instead' with Quick and Deep selected", data_instead)

        def deeper():
            if args.skip_slow:
                raise RuntimeError("[skip] --skip-slow")
            sid = session()
            q = ask("Which models are least accurate?", "chat", sid, selected="chat")
            need(q, not q["platform"], "")
            a = ask("Which models are least accurate?", "agent", sid, force="deeper", selected="chat")
            need(a, a["route"].get("escalated") and not a["cache"], f"not a fresh escalated deep analysis: route {a['route']}, cache {a['cache']}")
            return f"fresh deep analysis in {a['secs']}s"
        e2e("'Go deeper' from a Quick answer with Quick selected", deeper)

        out("\n--- 2. End to end: live conversations")
        if args.skip_slow:
            out("SKIP live conversations (--skip-slow)")
            totals["SKIP"] += 1
        else:
            rows, failures = run_conversations(base, H, conversations=CONVERSATIONS + ORG_CONVERSATIONS,
                                               out=lambda line: out("  " + line.replace("\n", "\n  ")))
            totals["PASS"] += len(rows) - failures
            totals["FAIL"] += failures
            problems += [f"conversation turn {r[0]}: {r[2]!r}" for r in rows if r[1] == "FAIL"]
            out(f"  {len(rows) - failures}/{len(rows)} conversation turns routed as expected")

    for sid in made:
        requests.delete(f"{base}/api/chat/sessions/{sid}", headers=H, timeout=30)

    out("\n=== SUMMARY ===")
    out("  " + ", ".join(f"{k} {v}" for k, v in totals.items() if v))
    for pr in problems:
        out(f"  FAIL {pr}")
    out(f"Full log: {log_path}")
    log_file.close()
    sys.exit(1 if totals["FAIL"] else 0)


if __name__ == "__main__":
    main()
