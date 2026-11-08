#!/usr/bin/env python3
"""Accuracy against a ground truth, from the command line (the same numbers as the «Точность» tab).

    # a run (batch) against the group's latest ground truth stored in the app:
    python3 tools/accuracy.py --batch 4
    python3 tools/accuracy.py --batch 4 --compare 1 --show c02,c06     # what got fixed / broken vs run 1
    # the latest evaluation of each conversation against a local ground-truth file:
    python3 tools/accuracy.py --group SYNTH --gt samples/synthetic_ground_truth.json --show all

Uses the original model answers (before appeals); the logic lives in backend/app/accuracy.py.
"""
from __future__ import annotations

import argparse
import json
import sys
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
from app import accuracy  # noqa: E402


def get(api: str, path: str):
    with urllib.request.urlopen(api.rstrip("/") + path, timeout=120) as r:
        return json.load(r)


def pct(v) -> str:
    return "    —" if v is None else f"{v:5.1f}%"


def report(m: dict, show: set[str]) -> None:
    print(f"\nСовпадение ответов: {pct(m['accuracy'])} ({m['n_answers']} ответов, {m['n_conversations']} диалогов)"
          f" · без спорных {pct(m['accuracy_sure'])}")
    print(f"Итоговый балл: MAE {m['mae_total']} · |Δ|≤5: {pct(m['within5'])} · флаг грубой ошибки: {pct(m['critical_accuracy'])}")
    print("\nПо критериям                     все     без спорных  частые ошибки (эталон→модель)")
    for c in m["criteria"]:
        errs = ", ".join(f"{e['gt']}→{e['model']}×{e['count']}" for e in c["errors"][:3])
        print(f"  {c['criterion_id']} {(c['title'] or '')[:24]:24} {pct(c['accuracy'])} ({c['hit']}/{c['n']})"
              f" {pct(c['accuracy_sure'])}  {errs}")
    print("\nПо группам")
    for g in m["groups"]:
        print(f"  {g['key']:24} {pct(g['accuracy'])} ({g['hit']}/{g['n']})")
    if show:
        print("\nРасхождения:")
        for it in m["items"]:
            for x in it["mismatches"]:
                if "all" in show or x["criterion_id"] in show:
                    print(f"  {x['criterion_id']} {it['id']:11} эталон={x['gt']:3} модель={x['model']:3}"
                          f"{' (спорно)' if x['uncertain'] else ''}  {x['explanation'][:150]}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--api", default="http://localhost:8091")
    ap.add_argument("--batch", type=int, help="run (batch) id; uses the ground truth stored in the app")
    ap.add_argument("--compare", type=int, help="with --batch: base run to diff against")
    ap.add_argument("--gt", help="local ground-truth JSON (with --group)")
    ap.add_argument("--group", default="DEV")
    ap.add_argument("--checklist", type=int, help="with --gt: checklist id (default: active)")
    ap.add_argument("--show", default="", help="criteria to list mismatches for, e.g. c02,c07 or 'all'")
    ap.add_argument("--json", help="write metrics to this file")
    a = ap.parse_args()
    show = {s.strip() for s in a.show.split(",") if s.strip()}

    if a.batch:
        q = f"/api/accuracy/{a.batch}" + (f"?compare={a.compare}" if a.compare else "")
        res = get(a.api, q)
        r, m = res["run"], res["metrics"]
        p = r.get("pipeline") or {}
        print(f"Прогон #{r['id']} · {r['dataset_group']} · чек-лист v{r['checklist_version']} · {p.get('model', '—')}"
              f" · эталон v{res['ground_truth_version']}" + (f" · «{r['note']}»" if r.get("note") else ""))
        report(m, show)
        if a.compare:
            d = res["compare"]
            print(f"\nСравнение с прогоном #{a.compare}: исправлено {len(d['fixed'])}, сломано {len(d['broken'])},"
                  f" осталось ошибок {len(d['still'])}")
            for x in d["broken"]:
                print(f"  сломано    {x['criterion_id']} {x['id']:11} эталон={x['gt']} стало={x['now']}")
            for x in d["fixed"]:
                print(f"  исправлено {x['criterion_id']} {x['id']:11} эталон={x['gt']} было={x['was']}")
    else:
        if not a.gt:
            ap.error("укажите --batch или --gt")
        labels = accuracy.labels_of(json.load(open(a.gt)))
        kid = a.checklist or get(a.api, "/api/checklists/active")["id"]
        convs = [c for c in get(a.api, f"/api/conversations?group={a.group}&checklist_id={kid}")
                 if c["id"] in labels and c.get("status") == "done"]
        with ThreadPoolExecutor(8) as ex:
            evals = list(ex.map(lambda c: get(a.api, f"/api/evaluations/{c['eval_id']}"), convs))
        if not evals:
            print("Нет завершённых оценок для диалогов из эталона.")
            return 1
        rows = [{"id": c["id"], "language": c["language"], "channel": c["channel"], "eval_id": e["id"],
                 "criteria": e["criteria"], "total": e["total"], "critical": e["critical"]} for c, e in zip(convs, evals)]
        m = accuracy.compute(evals[0]["checklist"], labels, rows)
        print(f"Чек-лист #{kid} v{evals[0]['checklist_version']} · {evals[0]['model']} · последняя оценка каждого диалога")
        report(m, show)
    if a.json:
        json.dump(m, open(a.json, "w"), ensure_ascii=False, indent=1)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
