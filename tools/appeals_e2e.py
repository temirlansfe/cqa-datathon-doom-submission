"""End-to-end appeal scenarios: create appeals, decide them, check the recomputed totals.

Totals are cross-checked with an independent implementation of the PDF rules
(not backend/app/scoring.py), so a shared bug would not hide itself.

It CREATES appeals and decisions, so run it only against a throwaway instance
seeded with evaluated dialogs, never against the shared site:

    python3 tools/appeals_e2e.py http://127.0.0.1:8096
"""
import json
import sys
import urllib.error
import urllib.request

if len(sys.argv) != 2:
    sys.exit("usage: appeals_e2e.py <api base, e.g. http://127.0.0.1:8096>")
BASE = sys.argv[1].rstrip("/")
results = []


def call(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method,
                                 headers={"content-type": "application/json"} if data else {})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, raw.decode(errors="replace")


def check(name, ok, detail=""):
    results.append((name, bool(ok), detail))
    print(("PASS " if ok else "FAIL ") + name + (f" — {detail}" if detail else ""))


def expected_total(cfg, answers):
    """PDF rules: yes=full weight, no=0, scale proportional (top step = full weight),
    N/A excluded and weights renormalised to 100, round to 2, none applicable -> None."""
    crits = [c for c in cfg["criteria"] if c["type"] != "critical" and float(c.get("weight") or 0) > 0]
    appl = [c for c in crits if answers.get(c["id"]) not in (None, "na")]
    w = sum(float(c["weight"]) for c in appl)
    if not w:
        return None
    tot = 0.0
    for c in appl:
        a = answers[c["id"]]
        if c["type"] == "scale":
            top = max(float(s["value"]) for s in c["scale"])
            ratio = float(a) / top
        else:
            ratio = 1.0 if a == "yes" else 0.0
        tot += ratio * float(c["weight"]) * 100.0 / w
    return round(tot, 2)


def answers_of(ev):
    return {r["criterion_id"]: r["answer"] for r in ev["final_criteria"]}


def ev_get(eid):
    return call("GET", f"/api/evaluations/{eid}")[1]


def appeal(eid, cid, comment="Тест: не согласен с оценкой"):
    return call("POST", "/api/appeals", {"evaluation_id": eid, "criterion_id": cid, "comment": comment, "author": "e2e"})


def decide(aid, decision, new_answer=None, reason="Тест: решение проверяющего"):
    return call("POST", f"/api/appeals/{aid}/decision",
                {"decision": decision, "new_answer": new_answer, "reason": reason, "reviewer": "e2e-reviewer"})


def same(a, b):
    return (a is None and b is None) or (a is not None and b is not None and abs(float(a) - float(b)) < 0.005)


# ---------------------------------------------------------------- pick data ----
st, active = call("GET", "/api/checklists/active")
kid = active["id"]
st, convs = call("GET", f"/api/conversations?checklist_id={kid}")
done = [c for c in convs if c.get("eval_id") and c.get("status") == "done"]
print(f"checklist #{kid} v{active.get('version')}: {len(done)} evaluated conversations")
evs = [ev_get(c["eval_id"]) for c in done[:40]]
cfg = evs[0]["checklist"]
types = {c["id"]: c for c in cfg["criteria"]}
scale_ids = [c["id"] for c in cfg["criteria"] if c["type"] == "scale"]
na_ids = [c["id"] for c in cfg["criteria"] if c.get("na_allowed")]
crit_id = next(c["id"] for c in cfg["criteria"] if c["type"] == "critical")
no_na_binary = next(c["id"] for c in cfg["criteria"] if c["type"] == "binary" and not c.get("na_allowed"))


def find(pred):
    for ev in evs:
        for r in ev["final_criteria"]:
            if pred(ev, r):
                return ev, r
    return None, None


used = set()


def fresh(pred):
    ev, r = find(lambda e, r: (e["id"], r["criterion_id"]) not in used and pred(e, r))
    if ev:
        used.add((ev["id"], r["criterion_id"]))
    return ev, r


# 0. baseline: stored totals match the independent rules
bad = [(e["conversation_id"], e["final_total"], expected_total(cfg, answers_of(e))) for e in evs
       if not same(e["final_total"], expected_total(cfg, answers_of(e)))]
check("baseline totals match PDF rules", not bad, f"{len(evs)} evals" if not bad else str(bad[:5]))

# 1. change a scale criterion to a lower step
ev, r = fresh(lambda e, r: r["criterion_id"] in scale_ids and r["answer"] not in ("na", 0, "0"))
if ev:
    steps = sorted(float(s["value"]) for s in types[r["criterion_id"]]["scale"])
    low = steps[0]
    st, a = appeal(ev["id"], r["criterion_id"])
    check("S1 create appeal (scale)", st == 200 and a.get("status") == "open", f"{ev['conversation_id']} {r['criterion_id']}={r['answer']}")
    exp_before = ev["final_total"]
    check("S1 total_before = current final_total", same(a.get("total_before"), exp_before), f"{a.get('total_before')} vs {exp_before}")
    st, d = decide(a["id"], "change", str(int(low)) if low.is_integer() else str(low))
    ans = answers_of(ev); ans[r["criterion_id"]] = low
    exp = expected_total(cfg, ans)
    check("S1 change scale -> total recomputed", st == 200 and d.get("status") == "changed" and same(d.get("total_after"), exp),
          f"{exp_before} -> {d.get('total_after')} (expected {exp})")
    ev2 = ev_get(ev["id"])
    check("S1 original evaluation untouched", same(ev2["total"], ev["total"]) and answers_of({"final_criteria": ev2["criteria"]}) == answers_of({"final_criteria": ev["criteria"]}))
    check("S1 final_total stored", same(ev2["final_total"], exp), f"{ev2['final_total']}")
    row = next(x for x in ev2["final_criteria"] if x["criterion_id"] == r["criterion_id"])
    check("S1 review trail on criterion", row.get("review", {}).get("appeal_id") == a["id"] and row.get("review", {}).get("from") == r["answer"], str(row.get("review")))
    # S6: second appeal on the same (now resolved) criterion is allowed and starts from the new answer
    st, a2 = appeal(ev["id"], r["criterion_id"], "Повторная апелляция")
    check("S6 re-appeal after resolution allowed", st == 200, str(a2)[:120])
    if st == 200:
        check("S6 re-appeal original_answer = decided answer", same(a2.get("original_answer"), low), f"{a2.get('original_answer')}")
        st, a3 = appeal(ev["id"], r["criterion_id"], "Дубль")
        check("S7 duplicate open appeal rejected", st == 400, f"{st} {a3}")
        st, d2 = decide(a2["id"], "confirm")
        check("S2 confirm keeps total", st == 200 and d2.get("status") == "confirmed" and same(d2.get("total_after"), exp), f"{d2.get('total_after')}")
        st, d3 = decide(a2["id"], "confirm")
        check("S8 deciding a resolved appeal rejected", st == 400, f"{st} {d3}")

# 3. change an answer to N/A -> redistribution
ev, r = fresh(lambda e, r: r["criterion_id"] in na_ids and r["answer"] != "na")
if ev:
    ev = ev_get(ev["id"])
    st, a = appeal(ev["id"], r["criterion_id"])
    st, d = decide(a["id"], "change", "na")
    ans = answers_of(ev); ans[r["criterion_id"]] = "na"
    exp = expected_total(cfg, ans)
    check("S3 change to N/A redistributes weight", st == 200 and same(d.get("total_after"), exp), f"{ev['conversation_id']} {r['criterion_id']}: {a.get('total_before')} -> {d.get('total_after')} (expected {exp})")
    ev2 = ev_get(ev["id"])
    eff = sum(float(x["max_points"]) for x in ev2["final_score"]["criteria"] if x["max_points"] is not None)
    check("S3 max stays 100", abs(eff - 100) < 0.01, f"sum max_points={eff}")

# 4. N/A -> yes
ev, r = fresh(lambda e, r: r["criterion_id"] in na_ids and r["answer"] == "na" and types[r["criterion_id"]]["type"] == "binary")
if ev:
    ev = ev_get(ev["id"])
    st, a = appeal(ev["id"], r["criterion_id"])
    st, d = decide(a["id"], "change", "yes")
    ans = answers_of(ev); ans[r["criterion_id"]] = "yes"
    exp = expected_total(cfg, ans)
    check("S4 N/A -> yes", st == 200 and same(d.get("total_after"), exp), f"{ev['conversation_id']} {r['criterion_id']}: {a.get('total_before')} -> {d.get('total_after')} (expected {exp})")

# 5. critical flag flip: score unchanged, flag set
ev, r = fresh(lambda e, r: r["criterion_id"] == crit_id and r["answer"] == "no")
if ev:
    st, a = appeal(ev["id"], r["criterion_id"])
    st, d = decide(a["id"], "change", "yes")
    ev2 = ev_get(ev["id"])
    check("S5 gross error flip keeps score", st == 200 and same(d.get("total_after"), a.get("total_before")), f"{a.get('total_before')} -> {d.get('total_after')}")
    check("S5 gross error flag set in final_score", ev2["final_score"].get("critical") is True, str(ev2["final_score"].get("critical")))

# 9. invalid inputs
ev, r = fresh(lambda e, r: r["criterion_id"] in scale_ids)
if ev:
    st, a = appeal(ev["id"], r["criterion_id"])
    st1, d = decide(a["id"], "change", "13")
    check("S9 off-scale value rejected", st1 == 400, f"{st1} {d}")
    st2, d = decide(a["id"], "confirm", reason="   ")
    check("S11 whitespace-only reason rejected", st2 in (400, 422), f"{st2}")
    if st2 == 200:
        used.add(("noop", 0))
ev, r = fresh(lambda e, r: r["criterion_id"] == no_na_binary)
if ev:
    st, a = appeal(ev["id"], r["criterion_id"])
    st1, d = decide(a["id"], "change", "na")
    check("S10 N/A where not allowed rejected", st1 == 400, f"{st1} {d}")
    st2, d = decide(a["id"], "change", None)
    check("S15 change with empty new_answer rejected", st2 == 400, f"{st2} {str(d)[:100]}")
    st3, d = decide(a["id"], "change", r["answer"])
    check("S16 change to the same answer rejected", st3 == 400, f"{st3} status={d.get('status') if isinstance(d, dict) else d}")
ev, r = fresh(lambda e, r: r["criterion_id"] in na_ids)
if ev:
    st, a = appeal(ev["id"], r["criterion_id"])
    st2, d = decide(a["id"], "change", None)
    check("S15b change with empty new_answer on N/A-allowed criterion rejected", st2 == 400, f"{st2} -> {d.get('new_answer') if isinstance(d, dict) else d}")
st, a = call("POST", "/api/appeals", {"evaluation_id": evs[0]["id"], "criterion_id": "c01", "comment": "   "})
check("S12 whitespace-only comment rejected", st in (400, 422), f"{st}")
st, a = call("POST", "/api/appeals", {"evaluation_id": evs[0]["id"], "criterion_id": "zzz", "comment": "x"})
check("S13 unknown criterion rejected", st == 404, f"{st}")

# 17. lists and stats reflect results
st, lst = call("GET", "/api/appeals")
st2, op = call("GET", "/api/appeals?status=open")
st3, rs = call("GET", "/api/appeals?status=resolved")
check("S17 list split open/resolved consistent", len(op) + len(rs) == len(lst), f"all={len(lst)} open={len(op)} resolved={len(rs)}")
st, stats = call("GET", f"/api/stats?checklist_id={kid}")
check("S17 stats has appeals block", isinstance(stats, dict) and "appeals" in stats, json.dumps(stats.get("appeals") if isinstance(stats, dict) else stats, ensure_ascii=False)[:200])

print()
fails = [n for n, ok, _ in results if not ok]
print(f"{len(results) - len(fails)}/{len(results)} passed")
for n in fails:
    print("  FAILED:", n)
sys.exit(1 if fails else 0)
