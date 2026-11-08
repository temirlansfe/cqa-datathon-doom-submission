#!/usr/bin/env python3
"""Upload a checklist JSON as a new (active) version to a running CQA instance.

    python3 tools/push_checklist.py --api http://localhost:8090 --note "уточнения по критериям"
Defaults to backend/app/default_checklist.json. Existing evaluations keep their old version.
"""
import argparse
import json
import urllib.request
from pathlib import Path

ap = argparse.ArgumentParser()
ap.add_argument("--api", default="http://localhost:8091")
ap.add_argument("--file", default=str(Path(__file__).resolve().parents[1] / "backend/app/default_checklist.json"))
ap.add_argument("--note", default="")
ap.add_argument("--no-activate", action="store_true")
a = ap.parse_args()
body = {"config": json.load(open(a.file)), "note": a.note or None, "activate": not a.no_activate}
req = urllib.request.Request(a.api.rstrip("/") + "/api/checklists", json.dumps(body).encode(),
                             {"content-type": "application/json"})
r = json.load(urllib.request.urlopen(req))
print(f"Создан чек-лист #{r['id']} v{r['version']}{' (активный)' if r.get('is_active') else ''}")
