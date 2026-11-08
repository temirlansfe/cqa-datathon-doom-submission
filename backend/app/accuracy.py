"""Agreement between model evaluations and a hand-labelled ground truth.

The ground truth is only ever read here, to measure results — it never reaches the prompt.
Model answers are the original ones (before appeals). The reference total is computed with the
same scoring.py, so the total error reflects answer errors, not arithmetic.
"""
from __future__ import annotations

from collections import defaultdict

from . import scoring


def norm(v) -> str:
    if v is None:
        return "na"
    if isinstance(v, (int, float)):
        return str(int(v)) if float(v).is_integer() else str(v)
    s = str(v).strip().lower()
    try:
        f = float(s)
        return str(int(f)) if f.is_integer() else s
    except ValueError:
        return s


def labels_of(gt: dict) -> dict:
    """Accepts {"labels": {...}} or a flat {conversation_id: {...}}; drops "_meta"-style keys."""
    src = gt.get("labels", gt) if isinstance(gt, dict) else {}
    return {k: v for k, v in src.items() if not k.startswith("_") and isinstance(v, dict)}


def _gt_answers(cfg: dict, lab: dict) -> dict:
    out = {}
    for c in cfg["criteria"]:
        v = lab.get(c["id"])
        if v is None:
            continue
        v = norm(v)
        out[c["id"]] = scoring.NA if v == "na" else (float(v) if c["type"] == "scale" else v)
    return out


def _pct(hit: int, n: int) -> float | None:
    return round(100.0 * hit / n, 2) if n else None


def compute(cfg: dict, labels: dict, rows: list[dict]) -> dict:
    """rows: [{"id", "language", "channel", "eval_id", "criteria", "total", "critical"}] — one per conversation."""
    crit_meta = {c["id"]: c for c in cfg["criteria"]}
    rows = [r for r in rows if r["id"] in labels]
    crit_ids = [c["id"] for c in cfg["criteria"] if any(c["id"] in labels[r["id"]] for r in rows)]

    per = {c: {"hit": 0, "n": 0, "hit_sure": 0, "n_sure": 0, "confusion": defaultdict(int)} for c in crit_ids}
    groups = defaultdict(lambda: {"hit": 0, "n": 0})
    items, errs = [], []
    crit_hit = 0
    for r in rows:
        lab = labels[r["id"]]
        unsure = set(lab.get("_uncertain") or [])
        model = {x["criterion_id"]: x for x in r.get("criteria") or []}
        keys = [f"Язык: {r.get('language') or '—'}", f"Канал: {r.get('channel') or '—'}"]
        if lab.get("_kind"):
            keys.append(f"Тип: {lab['_kind']}")
        mism = []
        for cid in crit_ids:
            if cid not in lab:
                continue
            g, m = norm(lab[cid]), norm(model.get(cid, {}).get("answer"))
            ok = g == m
            p = per[cid]
            p["hit"] += ok; p["n"] += 1
            if cid not in unsure:
                p["hit_sure"] += ok; p["n_sure"] += 1
            if not ok:
                p["confusion"][(g, m)] += 1
                mism.append({"criterion_id": cid, "gt": g, "model": m, "uncertain": cid in unsure,
                             "explanation": model.get(cid, {}).get("explanation", "")})
            for k in keys:
                groups[k]["hit"] += ok; groups[k]["n"] += 1
        g_score = scoring.compute(cfg, _gt_answers(cfg, lab))
        total_gt = g_score["total"]
        total_m = float(r["total"]) if r.get("total") is not None else None
        if total_gt is not None and total_m is not None:
            errs.append(abs(total_gt - total_m))
        crit_hit += bool(g_score["critical"]) == bool(r.get("critical"))
        items.append({"id": r["id"], "eval_id": r.get("eval_id"), "language": r.get("language"),
                      "channel": r.get("channel"), "kind": lab.get("_kind"), "note": lab.get("_note"),
                      "total_gt": total_gt, "total_model": total_m,
                      "critical_gt": bool(g_score["critical"]), "critical_model": bool(r.get("critical")),
                      "mismatches": mism})

    hit = sum(p["hit"] for p in per.values()); n = sum(p["n"] for p in per.values())
    hs = sum(p["hit_sure"] for p in per.values()); ns = sum(p["n_sure"] for p in per.values())
    return {
        "n_conversations": len(rows),
        "n_answers": n,
        "accuracy": _pct(hit, n),
        "accuracy_sure": _pct(hs, ns),
        "mae_total": round(sum(errs) / len(errs), 2) if errs else None,
        "within5": _pct(sum(e <= 5 for e in errs), len(errs)),
        "critical_accuracy": _pct(crit_hit, len(rows)),
        "criteria": [{
            "criterion_id": c, "code": crit_meta[c].get("code"), "title": crit_meta[c].get("title"),
            "type": crit_meta[c].get("type"),
            "accuracy": _pct(per[c]["hit"], per[c]["n"]), "hit": per[c]["hit"], "n": per[c]["n"],
            "accuracy_sure": _pct(per[c]["hit_sure"], per[c]["n_sure"]),
            "errors": [{"gt": g, "model": m, "count": k}
                       for (g, m), k in sorted(per[c]["confusion"].items(), key=lambda x: -x[1])],
        } for c in crit_ids],
        "groups": [{"key": k, "accuracy": _pct(v["hit"], v["n"]), "hit": v["hit"], "n": v["n"]}
                   for k, v in sorted(groups.items())],
        "items": items,
    }


def diff(base: dict, new: dict) -> dict:
    """Per (conversation, criterion): fixed = was wrong in base and right now; broken = the opposite."""
    def wrong(m):
        return {(it["id"], x["criterion_id"]): x for it in m["items"] for x in it["mismatches"]}

    def seen(m):
        return {it["id"] for it in m["items"]}

    wb, wn = wrong(base), wrong(new)
    common = seen(base) & seen(new)
    fixed = [{"id": k[0], "criterion_id": k[1], "gt": v["gt"], "was": v["model"]}
             for k, v in wb.items() if k[0] in common and k not in wn]
    broken = [{"id": k[0], "criterion_id": k[1], "gt": v["gt"], "now": v["model"]}
              for k, v in wn.items() if k[0] in common and k not in wb]
    still = [{"id": k[0], "criterion_id": k[1], "gt": v["gt"], "was": wb[k]["model"], "now": v["model"]}
             for k, v in wn.items() if k in wb]
    key = lambda x: (x["id"], x["criterion_id"])  # noqa: E731
    return {"fixed": sorted(fixed, key=key), "broken": sorted(broken, key=key), "still": sorted(still, key=key)}
