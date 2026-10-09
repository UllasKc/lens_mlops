"""
Live routing test: scripted conversations that switch between the data and the platform guide, and between
Quick answer (chat) and Deep analysis (agent), through a deployed app, the way the browser does it (ask the
router, then send). Every turn checks where it went, the mode, escalation, the "asked before" choice, what the
engine was sent, and that an answer came back.

It asks real questions, so it uses the query engine (several deep analyses, about 10-15 minutes in all).
The routing evaluation in the app (Observability > Evaluations > Routing) checks the router alone, cheaply.

Usage (same service principal as the smoke test):
  set LENS_SMOKE_CLIENT_ID=<service principal application id>
  set LENS_SMOKE_CLIENT_SECRET=<oauth secret>
  python deploy/routing_test.py --host https://<workspace> --app-url https://<app>
  python deploy/routing_test.py ... --only 2      (one conversation)
"""

import argparse
import os
import sys
import time
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).resolve().parent))
from smoke_test import ask, get_m2m_token, new_session  # noqa: E402

ENV_PREFIX = "LENS_SMOKE"

# Each turn: say (the message), setting (auto | chat | agent: the person's Quick/Deep/Auto choice), expect
# (dest data|platform, mode chat|agent, escalated, confirm, sent: True = the engine got the missed turns as
# context, False = the person's own words only; None or absent = not checked), choose ('again' | 'deep')
# when the Assistant offers "You asked this before", and a note on what the turn tests.
CONVERSATIONS = [
    {
        "name": "Data, the guide and back, across modes (Auto)",
        "turns": [
            {"say": "Which model has the highest false positive rate this week?", "expect": {"dest": "data"},
             "note": "a data question"},
            {"say": "What does the Explorer tab do?", "expect": {"dest": "platform"},
             "note": "an app question goes to the guide"},
            {"say": "Tell me more", "expect": {"dest": "platform"},
             "note": "'tell me more' after an app answer stays with the guide"},
            {"say": "Why is that model raising so many false alarms, and what should we do about it?",
             "expect": {"dest": "data", "mode": "agent", "sent": True},
             "note": "back to the data, deep; the new deep conversation gets the missed data turn, not the guide turns"},
            {"say": "and how much downtime did it cause?", "expect": {"dest": "data"},
             "note": "a follow-up; the router picks the depth"},
            {"say": "This is not enough, I need more detail", "expect": {"dest": "data", "mode": "agent", "escalated": True},
             "note": "asking for more: a fresh deep analysis"},
        ],
    },
    {
        "name": "Your own Quick/Deep setting, pushback and the guide",
        "turns": [
            {"say": "Why are confidence scores dropping?", "setting": "chat", "expect": {"dest": "data", "mode": "chat"},
             "note": "Quick selected: kept, even for a 'why'"},
            {"say": "Which site has the most drifting models?", "setting": "agent", "expect": {"dest": "data", "mode": "agent", "sent": True},
             "note": "Deep selected: kept; the deep conversation gets the quick turn it missed"},
            {"say": "How do I export this list?", "expect": {"dest": "platform"},
             "note": "an app question in the middle of a data conversation"},
            {"say": "No, you do it", "expect": {"dest": "platform"},
             "note": "pushback on a genuine app answer stays with the guide"},
            {"say": "No, just show me the numbers for that site", "expect": {"dest": "data"},
             "note": "a data request after the guide goes to the data"},
            {"say": "and the second-worst site?", "setting": "chat", "expect": {"dest": "data", "mode": "chat"},
             "note": "Quick again: a short follow-up at the chosen depth"},
        ],
    },
    {
        "name": "Asking the same question again",
        "turns": [
            {"say": "Which models are showing drift this week?", "expect": {"dest": "data"},
             "note": "a good, full answer"},
            {"say": "Which models are showing drift this week?", "expect": {"dest": "data", "confirm": True}, "choose": "again",
             "note": "asked again after a good answer: the person chooses; 'Show the earlier answer' sends nothing"},
            {"say": "Which models are showing drift this week?", "expect": {"dest": "data", "confirm": True}, "choose": "deep",
             "then": {"mode": "agent", "escalated": True, "sent": True},
             "note": "'Run a deep analysis': a fresh deep analysis, with the earlier answer as context"},
        ],
    },
]


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--host", required=True)
    p.add_argument("--app-url", required=True)
    p.add_argument("--only", type=int, help="Run only this conversation (1-based)")
    args = p.parse_args()
    cid, sec = os.environ.get(f"{ENV_PREFIX}_CLIENT_ID"), os.environ.get(f"{ENV_PREFIX}_CLIENT_SECRET")
    if not cid or not sec:
        sys.exit(f"Set {ENV_PREFIX}_CLIENT_ID and {ENV_PREFIX}_CLIENT_SECRET")
    base = args.app_url.rstrip("/")
    headers = {"Authorization": f"Bearer {get_m2m_token(args.host, cid, sec)}", "Content-Type": "application/json"}
    rows, failures = [], 0

    def logged(message_id):
        """The usage-log entry of an answer (it is written just after the answer is sent)."""
        for _ in range(10):
            recent = requests.get(f"{base}/api/admin/usage", headers=headers, timeout=120).json().get("recent", [])
            e = next((x for x in recent if x.get("assistant_message_id") == message_id), None)
            if e:
                return e
            time.sleep(2)
        return None

    def compare(expect, got):
        bad = [f"{k}: expected {v}, got {got.get(k)}" for k, v in expect.items() if v is not None and got.get(k) != v]
        return bad

    for n, conv in enumerate(CONVERSATIONS, start=1):
        if args.only and n != args.only:
            continue
        sid = new_session(base, headers)
        print(f"\n== {n}. {conv['name']}")
        for i, t in enumerate(conv["turns"], start=1):
            setting = t.get("setting", "auto")
            started = time.time()
            route = requests.post(f"{base}/api/chat/route", headers=headers, timeout=120,
                                  json={"question": t["say"], "selected": setting, "sessionId": sid}).json()
            got = {"dest": route.get("destination"), "mode": route.get("mode"), "escalated": route.get("escalated"), "confirm": route.get("confirm")}
            exp = dict(t.get("expect", {}))
            sent_expect = exp.pop("sent", None)
            problems = compare(exp, got)
            detail = f"route {got['dest']}/{got['mode']}{' escalated' if got['escalated'] else ''}{' confirm' if got['confirm'] else ''} ({route.get('method')}: {route.get('reason')})"
            if route.get("confirm") and t.get("choose") == "again":
                # "Show the earlier answer": the browser scrolls to it and sends nothing, so neither does the test.
                detail += " · the person chose the earlier answer: nothing sent"
            else:
                extra = {"selected": setting}
                mode = route.get("mode") or "chat"
                then = {}
                if route.get("confirm") and t.get("choose") == "deep":
                    extra["force"], mode, then = "deeper", "agent", t.get("then", {})
                elif route.get("confirm"):
                    problems.append("the choice was offered but the test has no 'choose'")
                answer = ask(base, headers, mode, t["say"], session_id=sid, **extra)
                if not answer["success"]:
                    problems.append(f"no answer ({answer.get('error')})")
                e = logged(answer["message_id"]) if answer.get("message_id") else None
                r = (e or {}).get("details", {}).get("router") or {}
                c = (e or {}).get("details", {}).get("context") or {}
                is_guide = bool(answer.get("platform"))
                want_dest = then.get("dest", t.get("expect", {}).get("dest"))
                if want_dest and is_guide != (want_dest == "platform"):
                    problems.append(f"answered by {'the guide' if is_guide else 'the data'}")
                for k in ("mode", "escalated"):
                    if then.get(k) is not None and r.get(k) != then[k]:
                        problems.append(f"{k}: expected {then[k]}, logged {r.get(k)}")
                want_sent = then.get("sent", sent_expect)
                if want_sent is not None and not is_guide and c and c.get("sent") != want_sent:
                    problems.append(f"context sent: expected {want_sent}, logged {c.get('sent')} ({c.get('why')})")
                detail += f" · answered by {'guide' if is_guide else (e or {}).get('mode') or mode}" + (" from cache" if (e or {}).get("from_cache") else "")
                if c:
                    detail += f" · context: {c.get('why')}"
            status = "FAIL" if problems else "PASS"
            failures += bool(problems)
            rows.append((f"{n}.{i}", status, t["say"]))
            print(f"  {status} {n}.{i} [{setting}] {t['say']!r} ({time.time() - started:.0f}s)\n       {t.get('note', '')}\n       {detail}"
                  + (f"\n       PROBLEMS: {'; '.join(problems)}" if problems else ""))
        requests.delete(f"{base}/api/chat/sessions/{sid}", headers=headers, timeout=30)

    print(f"\n{len(rows) - failures}/{len(rows)} turns routed as expected")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
