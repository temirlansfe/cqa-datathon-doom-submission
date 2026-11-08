from __future__ import annotations

import asyncio
import csv
import hashlib
import io
import json
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated, Any, Literal

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, StringConstraints

from . import accuracy, audio, config, dataset, db, evaluator, radar, rule_checks, scoring, version

_bg: set[asyncio.Task] = set()


def spawn(coro) -> None:
    t = asyncio.create_task(coro)
    _bg.add(t)
    t.add_done_callback(_bg.discard)


@asynccontextmanager
async def lifespan(_: FastAPI):
    await db.connect()
    # Evaluations interrupted by a restart are marked as errors so they can be re-run.
    async with db.pool.acquire() as conn:
        await conn.execute("UPDATE evaluations SET status='error', error='interrupted by restart' "
                           "WHERE status IN ('pending','running')")
        await conn.execute("UPDATE batches SET status='finished', finished_at=now() WHERE status='running'")
        await conn.execute(
            """UPDATE radar_runs SET status='error', error='Анализ прерван перезапуском сервиса.',
                      finished_at=now() WHERE status='running'"""
        )
    yield
    await db.close()


app = FastAPI(title="CQA — Conversation Quality Analytics", lifespan=lifespan)
app.include_router(rule_checks.router)
app.include_router(radar.router)


@app.exception_handler(dataset.DatasetError)
async def _dataset_err(_: Request, e: dataset.DatasetError):
    return JSONResponse({"detail": str(e)}, status_code=400)


def not_found(what: str):
    raise HTTPException(404, f"{what} не найден")


# ------------------------------------------------------------------ meta ----
@app.get("/api/health")
async def health():
    async with db.pool.acquire() as conn:
        await conn.fetchval("SELECT 1")
    return {"ok": True}


def user_email(request: Request) -> str | None:
    """Signed-in user from the Google gate. nginx overwrites X-Auth-Email, so it cannot be forged from outside."""
    return (request.headers.get("x-auth-email") or "").strip() or None


@app.get("/api/me")
async def me(request: Request):
    return {"email": user_email(request)}


@app.get("/api/meta")
async def meta():
    return {
        "provider": config.effective_provider(),
        "model": config.GEMINI_MODEL if config.effective_provider() == "gemini" else "mock-heuristic",
        "dataset_api_configured": bool(config.DATASET_API_URL),
        "price_input_per_m": config.PRICE_INPUT_PER_M,
        "price_output_per_m": config.PRICE_OUTPUT_PER_M,
    }


# --------------------------------------------------------------- datasets ----
class ImportReq(BaseModel):
    group_id: str = Field(min_length=1)
    api_url: str | None = None


async def upsert(group: str, records: list[dict]) -> int:
    async with db.pool.acquire() as conn:
        async with conn.transaction():
            for r in records:
                await conn.execute(
                    """INSERT INTO conversations (id, dataset_group, channel, language, transcript, audio_url, raw)
                       VALUES ($1,$2,$3,$4,$5,$6,$7)
                       ON CONFLICT (id) DO UPDATE SET dataset_group=EXCLUDED.dataset_group, channel=EXCLUDED.channel,
                         language=EXCLUDED.language, transcript=EXCLUDED.transcript, audio_url=EXCLUDED.audio_url,
                         topic=CASE WHEN conversations.transcript=EXCLUDED.transcript THEN conversations.topic END,
                         raw=EXCLUDED.raw, imported_at=now()""",
                    r["id"], group, r["channel"], r["language"], r["transcript"], r["audio_url"], r["raw"])
    return len(records)


@app.post("/api/datasets/import")
async def import_group(req: ImportReq):
    group, records = await dataset.fetch_group(req.group_id.strip(), req.api_url)
    n = await upsert(group, records)
    return {"group": group, "imported": n}


@app.post("/api/datasets/upload")
async def upload(request: Request, group: str | None = None):
    try:
        payload = json.loads(await request.body())
    except ValueError:
        raise HTTPException(400, "Файл не является корректным JSON")
    g, records = dataset.extract_records(payload, default_group=group or "UPLOAD")
    if group:
        g = group
    n = await upsert(g, records)
    return {"group": g, "imported": n}


@app.get("/api/groups")
async def groups():
    async with db.pool.acquire() as conn:
        rows = await conn.fetch("SELECT dataset_group AS id, count(*) AS count FROM conversations "
                                "GROUP BY 1 ORDER BY max(imported_at) DESC")
    return db.recs(rows)


# ----------------------------------------------------------- conversations ----
@app.get("/api/conversations")
async def list_conversations(group: str | None = None, checklist_id: int | None = None, include_criteria: bool = False):
    async with db.pool.acquire() as conn:
        rows = await conn.fetch(
            """SELECT c.id, c.dataset_group, c.channel, c.language, c.audio_url,
                      COALESCE(NULLIF(btrim(c.raw->>'title'), ''), c.topic) AS title,
                      jsonb_array_length(c.transcript) AS messages,
                      e.id AS eval_id, e.status, e.total, e.final_total, e.critical, e.checklist_id,
                      e.final_score->>'critical' AS final_critical, e.error,
                      CASE WHEN $3::bool AND e.status='done' THEN e.final_score->'criteria' END AS criterion_scores,
                      (SELECT count(*) FROM appeals a WHERE a.evaluation_id=e.id AND a.status='open') AS open_appeals,
                      (SELECT count(*) FROM appeals a WHERE a.evaluation_id=e.id) AS appeals
               FROM conversations c
               LEFT JOIN LATERAL (
                   SELECT * FROM evaluations e WHERE e.conversation_id=c.id
                     AND ($2::int IS NULL OR e.checklist_id=$2) ORDER BY e.id DESC LIMIT 1) e ON true
               WHERE ($1::text IS NULL OR c.dataset_group=$1)
               ORDER BY c.id""", group, checklist_id, include_criteria)
    return db.recs(rows)


@app.get("/api/audio/{cid}")
async def get_audio(cid: str):
    """Call recording as a seekable mp3 (Range requests), cached locally; the organizer link expires hourly."""
    async with db.pool.acquire() as conn:
        url = await conn.fetchval("SELECT audio_url FROM conversations WHERE id=$1", cid)
    if not url:
        not_found("Запись звонка")
    try:
        path = await audio.cached_file(cid, url)
    except audio.AudioError as e:
        raise HTTPException(502, str(e))
    return FileResponse(path, media_type="audio/mpeg", headers={"Cache-Control": "private, max-age=86400"})


@app.get("/api/conversations/{cid}")
async def get_conversation(cid: str):
    async with db.pool.acquire() as conn:
        c = await conn.fetchrow("SELECT id, dataset_group, channel, language, transcript, audio_url, imported_at, raw->>'title' AS title "
                                "FROM conversations WHERE id=$1", cid)
        if not c:
            not_found("Диалог")
        evs = await conn.fetch(
            """SELECT e.id, e.checklist_id, k.name AS checklist_name, k.version AS checklist_version, e.status,
                      e.total, e.final_total, e.critical, e.model, e.created_at, e.error
               FROM evaluations e JOIN checklists k ON k.id=e.checklist_id
               WHERE e.conversation_id=$1 ORDER BY e.id DESC""", cid)
    return {**db.rec(c), "evaluations": db.recs(evs)}


# -------------------------------------------------------------- checklists ----
class ChecklistIn(BaseModel):
    config: dict[str, Any]
    note: str | None = None
    activate: bool = True
    source_appeal_id: int | None = Field(default=None, gt=0)
    base_checklist_id: int | None = Field(default=None, gt=0)


def validate_checklist(cfg: dict) -> dict:
    if not cfg.get("name"):
        raise HTTPException(400, "Укажите название чек-листа")
    crits = cfg.get("criteria")
    if not isinstance(crits, list) or not crits:
        raise HTTPException(400, "Нужен хотя бы один критерий")
    ids = set()
    sections = {s["id"] for s in cfg.get("sections") or []}
    for c in crits:
        if not c.get("id") or c["id"] in ids:
            raise HTTPException(400, f"Пустой или повторяющийся id критерия: {c.get('id')!r}")
        ids.add(c["id"])
        if not c.get("title"):
            raise HTTPException(400, f"Критерий {c['id']}: нет названия")
        if c.get("type") not in ("binary", "scale", "critical"):
            raise HTTPException(400, f"Критерий {c['id']}: неизвестный тип {c.get('type')!r}")
        c["weight"] = 0 if c["type"] == "critical" else float(c.get("weight") or 0)
        if c["weight"] < 0:
            raise HTTPException(400, f"Критерий {c['id']}: вес не может быть отрицательным")
        c["na_allowed"] = bool(c.get("na_allowed"))
        if c["type"] == "scale":
            sc = c.get("scale") or []
            try:
                vals = [float(s["value"]) for s in sc]
            except (KeyError, TypeError, ValueError):
                raise HTTPException(400, f"Критерий {c['id']}: некорректная шкала")
            if len(vals) < 2 or len(set(vals)) != len(vals) or max(vals) <= 0:
                raise HTTPException(400, f"Критерий {c['id']}: шкала должна иметь ≥2 разных ступеней и максимум > 0")
            c["scale"] = sorted(({"value": float(s["value"]) if float(s["value"]) % 1 else int(float(s["value"])),
                                  "description": s.get("description", "")} for s in sc), key=lambda s: -s["value"])
        else:
            c.pop("scale", None)
        if sections and c.get("section") and c["section"] not in sections:
            raise HTTPException(400, f"Критерий {c['id']}: неизвестная секция {c['section']!r}")
    cfg["rounding"] = int(cfg.get("rounding", 2))
    return cfg


@app.get("/api/checklists")
async def list_checklists():
    async with db.pool.acquire() as conn:
        rows = await conn.fetch(
            """SELECT k.id, k.name, k.version, k.is_active, k.note, k.created_at,
                      jsonb_array_length(k.config->'criteria') AS criteria_count,
                      stats.evaluations, stats.evaluated_conversations
               FROM checklists k
               CROSS JOIN LATERAL (
                   SELECT count(*) AS evaluations,
                          count(DISTINCT e.conversation_id) FILTER (WHERE e.status='done') AS evaluated_conversations
                   FROM evaluations e WHERE e.checklist_id=k.id
               ) stats
               ORDER BY k.id DESC""")
    return db.recs(rows)


@app.get("/api/checklists/active")
async def active_checklist():
    async with db.pool.acquire() as conn:
        r = await conn.fetchrow("SELECT * FROM checklists WHERE is_active ORDER BY id DESC LIMIT 1")
    return db.rec(r) or not_found("Активный чек-лист")


@app.get("/api/checklists/{kid}")
async def get_checklist(kid: int):
    async with db.pool.acquire() as conn:
        r = await conn.fetchrow("SELECT * FROM checklists WHERE id=$1", kid)
    return db.rec(r) or not_found("Чек-лист")


@app.post("/api/checklists")
async def save_checklist(body: ChecklistIn):
    cfg = validate_checklist(body.config)
    async with db.pool.acquire() as conn:
        async with conn.transaction():
            await conn.execute("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
                               f"checklist-version:{cfg['name']}")
            latest = await conn.fetchrow(
                "SELECT id, version FROM checklists WHERE name=$1 ORDER BY version DESC, id DESC LIMIT 1", cfg["name"])
            if body.base_checklist_id is not None and (not latest or latest["id"] != body.base_checklist_id):
                raise HTTPException(409, "Появилась новая версия чек-листа. Закройте предложение и запросите его снова.")
            if body.source_appeal_id is not None:
                source = await conn.fetchrow(
                    """SELECT a.status, k.name FROM appeals a
                       JOIN evaluations e ON e.id=a.evaluation_id
                       JOIN checklists k ON k.id=e.checklist_id WHERE a.id=$1""", body.source_appeal_id)
                if not source or source["status"] == "open":
                    raise HTTPException(400, "Сначала сохраните решение по апелляции.")
                if source["name"] != cfg["name"]:
                    raise HTTPException(400, "Сохраните правило в новой версии чек-листа из апелляции.")
            ver = latest["version"] + 1 if latest else 1
            if body.activate:
                await conn.execute("UPDATE checklists SET is_active=false")
            r = await conn.fetchrow(
                """INSERT INTO checklists (name, version, config, is_active, note, source_appeal_id)
                   VALUES ($1,$2,$3,$4,$5,$6) RETURNING *""",
                cfg["name"], ver, cfg, body.activate, body.note, body.source_appeal_id)
    return db.rec(r)


@app.post("/api/checklists/{kid}/activate")
async def activate_checklist(kid: int):
    async with db.pool.acquire() as conn:
        async with conn.transaction():
            if not await conn.fetchval("SELECT 1 FROM checklists WHERE id=$1", kid):
                not_found("Чек-лист")
            await conn.execute("UPDATE checklists SET is_active=(id=$1)", kid)
    return {"ok": True}


# ------------------------------------------------------------- evaluations ----
class EvalReq(BaseModel):
    conversation_id: str
    checklist_id: int | None = None


async def resolve_checklist(conn, kid: int | None) -> int:
    if kid:
        if not await conn.fetchval("SELECT 1 FROM checklists WHERE id=$1", kid):
            not_found("Чек-лист")
        return kid
    kid = await conn.fetchval("SELECT id FROM checklists WHERE is_active ORDER BY id DESC LIMIT 1")
    if not kid:
        not_found("Активный чек-лист")
    return kid


@app.post("/api/evaluations")
async def create_evaluation(req: EvalReq):
    async with db.pool.acquire() as conn:
        if not await conn.fetchval("SELECT 1 FROM conversations WHERE id=$1", req.conversation_id):
            not_found("Диалог")
        kid = await resolve_checklist(conn, req.checklist_id)
    eid = await evaluator.create(req.conversation_id, kid)
    async with evaluator.sem():
        await evaluator.run(eid)
    return await get_evaluation(eid)


@app.get("/api/evaluations/{eid}")
async def get_evaluation(eid: int):
    async with db.pool.acquire() as conn:
        e = await conn.fetchrow(
            """SELECT e.*, k.name AS checklist_name, k.version AS checklist_version, k.config AS checklist,
                      c.transcript AS current_transcript
               FROM evaluations e JOIN checklists k ON k.id=e.checklist_id
               JOIN conversations c ON c.id=e.conversation_id WHERE e.id=$1""", eid)
        if not e:
            not_found("Оценка")
        appeals = await conn.fetch("SELECT * FROM appeals WHERE evaluation_id=$1 ORDER BY id", eid)
    result = db.rec(e)
    transcript = result.pop("current_transcript")
    for field in ("criteria", "final_criteria"):
        if result[field] is not None:
            result[field] = [evaluator.check_evidence(row, transcript) for row in result[field]]
    for row in result["final_criteria"] or []:
        if row.get("review") and "reviews" not in row:
            row["reviews"] = _appeal_history(appeals, row["criterion_id"]) or [row["review"]]
    return {**result, "appeals": db.recs(appeals)}


class BatchReq(BaseModel):
    group: str | None = None
    checklist_id: int | None = None
    conversation_ids: list[str] | None = None
    only_missing: bool = True
    note: str | None = None  # what changed in this run — shown in the accuracy history


@app.post("/api/batches")
async def create_batch(req: BatchReq):
    async with db.pool.acquire() as conn:
        kid = await resolve_checklist(conn, req.checklist_id)
        ids = await conn.fetch(
            """SELECT c.id FROM conversations c
               WHERE ($1::text IS NULL OR c.dataset_group=$1)
                 AND ($2::text[] IS NULL OR c.id = ANY($2))
                 AND (NOT $3 OR NOT EXISTS (SELECT 1 FROM evaluations e WHERE e.conversation_id=c.id
                                            AND e.checklist_id=$4 AND e.status IN ('done','running','pending')))
               ORDER BY c.id""", req.group, req.conversation_ids, req.only_missing, kid)
        ids = [r["id"] for r in ids]
        bid = await conn.fetchval(
            "INSERT INTO batches (dataset_group, checklist_id, total, note, pipeline) VALUES ($1,$2,$3,$4,$5) RETURNING id",
            req.group, kid, len(ids), (req.note or "").strip() or None, version.pipeline())
    eids = [await evaluator.create(cid, kid, bid) for cid in ids]
    if eids:
        spawn(evaluator.run_batch(bid, eids))
    else:
        async with db.pool.acquire() as conn:
            await conn.execute("UPDATE batches SET status='finished', finished_at=now() WHERE id=$1", bid)
    return await get_batch(bid)


@app.get("/api/batches")
async def list_batches():
    async with db.pool.acquire() as conn:
        return db.recs(await conn.fetch("SELECT * FROM batches ORDER BY id DESC LIMIT 20"))


@app.get("/api/batches/{bid}")
async def get_batch(bid: int):
    async with db.pool.acquire() as conn:
        b = await conn.fetchrow(
            """SELECT b.*, (SELECT coalesce(sum(cost_usd),0) FROM evaluations e WHERE e.batch_id=b.id) AS cost_usd
               FROM batches b WHERE b.id=$1""", bid)
    return db.rec(b) or not_found("Пакет")


# ----------------------------------------------------------------- appeals ----
# Free text that must carry something besides whitespace (surrounding spaces are stripped).
NonBlank = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]


class AppealIn(BaseModel):
    evaluation_id: int
    criterion_id: str
    comment: NonBlank
    author: str | None = None


class DecisionIn(BaseModel):
    decision: str  # confirm | change
    new_answer: Any = None
    reason: NonBlank
    reviewer: str | None = None


class AppealCaseIn(BaseModel):
    category: Literal["service", "product", "checklist", "other"]
    summary: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=500)]


def _same_answer(a: Any, b: Any) -> bool:
    """20 == 20.0 == "20" for scale steps; plain equality for yes / no / na."""
    try:
        return float(a) == float(b)
    except (TypeError, ValueError):
        return a == b


def _appeal_history(appeals, criterion_id: str) -> list[dict]:
    resolved = sorted(
        (a for a in appeals if a["criterion_id"] == criterion_id and a["resolved_at"] is not None),
        key=lambda a: (a["resolved_at"], a["id"]),
    )
    return [
        {"appeal_id": a["id"], "reason": a["reason"], "reviewer": a["reviewer"],
         **({"confirmed": True} if a["status"] == "confirmed"
            else {"from": a["original_answer"], "to": a["new_answer"]})}
        for a in resolved
    ]


@app.post("/api/appeals")
async def create_appeal(body: AppealIn, request: Request):
    author = user_email(request) or body.author
    async with db.pool.acquire() as conn:
        e = await conn.fetchrow("SELECT * FROM evaluations WHERE id=$1", body.evaluation_id)
        if not e or e["status"] != "done":
            raise HTTPException(400, "Оценка не найдена или не завершена")
        crit = next((c for c in e["final_criteria"] if c["criterion_id"] == body.criterion_id), None)
        if not crit:
            not_found("Критерий")
        if await conn.fetchval("SELECT 1 FROM appeals WHERE evaluation_id=$1 AND criterion_id=$2 AND status='open'",
                               body.evaluation_id, body.criterion_id):
            raise HTTPException(400, "По этому критерию уже есть открытая апелляция")
        r = await conn.fetchrow(
            """INSERT INTO appeals (evaluation_id, criterion_id, comment, author, original_answer, total_before)
               VALUES ($1,$2,$3,$4,$5,$6) RETURNING *""",
            body.evaluation_id, body.criterion_id, body.comment, author, crit["answer"], e["final_total"])
    return db.rec(r)


@app.get("/api/appeals")
async def list_appeals(status: str | None = None):
    async with db.pool.acquire() as conn:
        rows = await conn.fetch(
            """SELECT a.*, e.conversation_id, c.language, c.channel, k.config->'criteria' AS criteria,
                      COALESCE(NULLIF(btrim(c.raw->>'title'), ''), c.topic) AS conversation_title
               FROM appeals a JOIN evaluations e ON e.id=a.evaluation_id
               JOIN conversations c ON c.id=e.conversation_id JOIN checklists k ON k.id=e.checklist_id
               WHERE ($1::text IS NULL OR ($1='open' AND a.status='open') OR ($1='resolved' AND a.status<>'open'))
               ORDER BY (a.status='open') DESC, a.id DESC""", status)
    out = []
    for r in db.recs(rows):
        crit = next((c for c in r.pop("criteria") or [] if c["id"] == r["criterion_id"]), {})
        out.append({**r, "criterion_title": crit.get("title"), "criterion_code": crit.get("code"),
                    "criterion_type": crit.get("type")})
    return out


@app.get("/api/appeals/{aid}")
async def get_appeal(aid: int):
    async with db.pool.acquire() as conn:
        a = await conn.fetchrow("SELECT * FROM appeals WHERE id=$1", aid)
        if not a:
            not_found("Апелляция")
    ev = await get_evaluation(a["evaluation_id"])
    async with db.pool.acquire() as conn:
        conv = await conn.fetchrow(
            """SELECT id, channel, language, transcript, audio_url,
                      COALESCE(NULLIF(btrim(raw->>'title'), ''), topic) AS title
               FROM conversations WHERE id=$1""", ev["conversation_id"])
        versions = await conn.fetch(
            "SELECT id, name, version, is_active FROM checklists WHERE source_appeal_id=$1 ORDER BY id DESC", aid)
    return {"appeal": db.rec(a), "evaluation": ev, "conversation": db.rec(conv), "checklist_versions": db.recs(versions)}


@app.patch("/api/appeals/{aid}/case")
async def save_appeal_case(aid: int, body: AppealCaseIn):
    async with db.pool.acquire() as conn:
        details = await conn.fetchval(
            "UPDATE appeals SET case_details=$2 WHERE id=$1 RETURNING case_details", aid, body.model_dump())
    return details or not_found("Апелляция")


@app.post("/api/appeals/{aid}/decision")
async def decide_appeal(aid: int, body: DecisionIn, request: Request):
    reviewer = user_email(request) or body.reviewer
    if body.decision not in ("confirm", "change"):
        raise HTTPException(400, "decision: confirm | change")
    async with db.pool.acquire() as conn:
        async with conn.transaction():
            a = await conn.fetchrow("SELECT * FROM appeals WHERE id=$1 FOR UPDATE", aid)
            if not a:
                not_found("Апелляция")
            if a["status"] != "open":
                raise HTTPException(400, "Апелляция уже рассмотрена")
            e = await conn.fetchrow(
                "SELECT e.*, k.config AS cfg FROM evaluations e JOIN checklists k ON k.id=e.checklist_id "
                "WHERE e.id=$1 FOR UPDATE OF e", a["evaluation_id"])
            cfg = e["cfg"]
            crit_cfg = next(c for c in cfg["criteria"] if c["id"] == a["criterion_id"])
            final = e["final_criteria"]
            row = next(r for r in final if r["criterion_id"] == a["criterion_id"])
            new_answer = row["answer"]
            if body.decision == "change":
                if body.new_answer is None or str(body.new_answer).strip() == "":
                    raise HTTPException(400, "Для решения «Изменить» укажите новый ответ")
                new_answer, warn = scoring.normalize_answer(crit_cfg, body.new_answer)
                if warn:
                    raise HTTPException(400, f"Некорректный новый ответ: {warn}")
                if _same_answer(new_answer, row["answer"]):
                    raise HTTPException(400, "Новый ответ совпадает с текущим — выберите «Подтвердить»")
                review = {"from": row["answer"], "to": new_answer, "reason": body.reason,
                          "appeal_id": aid, "reviewer": reviewer}
                row["answer"] = new_answer
            else:
                review = {"confirmed": True, "reason": body.reason, "appeal_id": aid, "reviewer": reviewer}
            history = row.get("reviews") or []
            if not history and row.get("review"):
                previous = await conn.fetch(
                    """SELECT * FROM appeals WHERE evaluation_id=$1 AND criterion_id=$2
                       AND resolved_at IS NOT NULL""", e["id"], a["criterion_id"])
                history = _appeal_history(previous, a["criterion_id"]) or [row["review"]]
            row["review"] = review
            row["reviews"] = [*history, review]
            score = evaluator.recompute_final(cfg, final)
            await conn.execute("UPDATE evaluations SET final_criteria=$2, final_score=$3, final_total=$4 WHERE id=$1",
                               e["id"], final, score, score["total"])
            r = await conn.fetchrow(
                """UPDATE appeals SET status=$2, new_answer=$3, reason=$4, reviewer=$5, total_after=$6, resolved_at=now()
                   WHERE id=$1 RETURNING *""",
                aid, "changed" if body.decision == "change" else "confirmed", new_answer, body.reason,
                reviewer, score["total"])
    return db.rec(r)


# --------------------------------------------------------- stats & export ----
# ---------------------------------------------------------------- accuracy ----
# Ground truth is stored for measurement only and is never passed to the evaluator.
@app.post("/api/ground-truth")
async def upload_ground_truth(request: Request, group: str, note: str | None = None):
    try:
        payload = json.loads(await request.body())
    except ValueError:
        raise HTTPException(400, "Файл не является корректным JSON")
    labels = accuracy.labels_of(payload)
    if not labels:
        raise HTTPException(400, "Не найдены метки: ожидается {\"labels\": {conversation_id: {c01: …}}}")
    meta = {k: v for k, v in payload.items() if k.startswith("_")} if isinstance(payload, dict) else {}
    async with db.pool.acquire() as conn:
        async with conn.transaction():
            await conn.execute("LOCK TABLE ground_truth IN SHARE ROW EXCLUSIVE MODE")
            ver = await conn.fetchval("SELECT coalesce(max(version),0)+1 FROM ground_truth WHERE dataset_group=$1", group)
            gid = await conn.fetchval(
                "INSERT INTO ground_truth (dataset_group, version, labels, meta, note, author) "
                "VALUES ($1,$2,$3,$4,$5,$6) RETURNING id",
                group, ver, labels, meta, (note or "").strip() or None, user_email(request))
        known = await conn.fetchval("SELECT count(*) FROM conversations WHERE dataset_group=$1 AND id = ANY($2)",
                                    group, list(labels))
    return {"id": gid, "group": group, "version": ver, "labels": len(labels), "matched_conversations": known}


@app.get("/api/ground-truth")
async def list_ground_truth():
    async with db.pool.acquire() as conn:
        rows = await conn.fetch(
            """SELECT id, dataset_group, version, note, author, created_at, meta,
                      (SELECT count(*) FROM jsonb_object_keys(labels)) AS labels
               FROM ground_truth ORDER BY dataset_group, version DESC""")
    return db.recs(rows)


async def _gt(conn, group: str, gt_id: int | None):
    if gt_id:
        return await conn.fetchrow("SELECT * FROM ground_truth WHERE id=$1 AND dataset_group=$2", gt_id, group)
    return await conn.fetchrow("SELECT * FROM ground_truth WHERE dataset_group=$1 ORDER BY version DESC LIMIT 1", group)


async def _batch_accuracy(conn, batch: dict, labels: dict) -> dict:
    rows = await conn.fetch(
        """SELECT c.id, c.language, c.channel, e.id AS eval_id, e.criteria, e.total, e.critical
           FROM evaluations e JOIN conversations c ON c.id=e.conversation_id
           WHERE e.batch_id=$1 AND e.status='done'""", batch["id"])
    cfg = await conn.fetchval("SELECT config FROM checklists WHERE id=$1", batch["checklist_id"])
    return accuracy.compute(cfg, labels, db.recs(rows))


_RUN_COLS = """b.id, b.dataset_group, b.checklist_id, b.total, b.done, b.failed, b.status, b.created_at,
               b.finished_at, b.note, b.pipeline, k.version AS checklist_version, k.name AS checklist_name,
               (SELECT coalesce(sum(cost_usd),0) FROM evaluations e WHERE e.batch_id=b.id) AS cost_usd,
               (SELECT avg(duration_ms) FROM evaluations e WHERE e.batch_id=b.id AND e.status='done') AS avg_ms,
               (SELECT e.pipeline FROM evaluations e WHERE e.batch_id=b.id AND e.pipeline IS NOT NULL LIMIT 1) AS eval_pipeline,
               (SELECT e.model FROM evaluations e WHERE e.batch_id=b.id AND e.model IS NOT NULL LIMIT 1) AS model"""


def _run_row(b: dict, m: dict) -> dict:
    b = dict(b)
    b["pipeline"] = b.pop("eval_pipeline") or b["pipeline"] or ({"model": b["model"]} if b.get("model") else None)
    b.pop("model", None)
    return {**b, **{k: m[k] for k in ("n_conversations", "n_answers", "accuracy", "accuracy_sure", "mae_total",
                                       "within5", "critical_accuracy", "groups")},
            "criteria": [{k: c[k] for k in ("criterion_id", "code", "accuracy")} for c in m["criteria"]]}


@app.get("/api/accuracy")
async def accuracy_runs(group: str, gt_id: int | None = None):
    """Accuracy history: one row per batch (= one version of the system run on this group)."""
    async with db.pool.acquire() as conn:
        gt = await _gt(conn, group, gt_id)
        if not gt:
            return {"ground_truth": None, "runs": []}
        batches = await conn.fetch(
            f"SELECT {_RUN_COLS} FROM batches b LEFT JOIN checklists k ON k.id=b.checklist_id "
            "WHERE b.dataset_group=$1 ORDER BY b.id", group)
        runs = []
        for b in batches:
            m = await _batch_accuracy(conn, b, gt["labels"])
            if m["n_conversations"]:
                runs.append(_run_row(b, m))
    g = dict(gt)
    g["labels"] = len(g["labels"])
    return {"ground_truth": g, "runs": runs}


@app.get("/api/accuracy/{batch_id}")
async def accuracy_run(batch_id: int, gt_id: int | None = None, compare: int | None = None):
    """Full metrics of one run, with mismatches; with ?compare=<batch> also what got fixed / broken."""
    async with db.pool.acquire() as conn:
        b = await conn.fetchrow(f"SELECT {_RUN_COLS} FROM batches b LEFT JOIN checklists k ON k.id=b.checklist_id "
                                "WHERE b.id=$1", batch_id)
        if not b:
            not_found("Прогон")
        gt = await _gt(conn, b["dataset_group"], gt_id)
        if not gt:
            raise HTTPException(404, "Для этого набора нет эталона")
        m = await _batch_accuracy(conn, b, gt["labels"])
        out = {"run": _run_row(b, m), "metrics": m, "ground_truth_id": gt["id"], "ground_truth_version": gt["version"]}
        if compare:
            cb = await conn.fetchrow("SELECT * FROM batches WHERE id=$1", compare)
            if not cb:
                not_found("Прогон для сравнения")
            out["compare"] = {"batch_id": compare, **accuracy.diff(await _batch_accuracy(conn, cb, gt["labels"]), m)}
    return out


@app.patch("/api/batches/{bid}")
async def update_batch_note(bid: int, body: dict):
    async with db.pool.acquire() as conn:
        await conn.execute("UPDATE batches SET note=$2 WHERE id=$1", bid, (body.get("note") or "").strip() or None)
    return await get_batch(bid)


@app.get("/api/stats")
async def stats(group: str | None = None, checklist_id: int | None = None):
    async with db.pool.acquire() as conn:
        rows = await conn.fetch(
            """SELECT DISTINCT ON (e.conversation_id) e.conversation_id, c.language, c.channel, e.final_total,
                      (e.final_score->>'critical')::boolean AS critical, e.final_criteria, e.cost_usd, e.usage,
                      e.duration_ms, e.checklist_id
               FROM evaluations e JOIN conversations c ON c.id=e.conversation_id
               WHERE e.status='done' AND ($1::text IS NULL OR c.dataset_group=$1)
                 AND ($2::int IS NULL OR e.checklist_id=$2)
               ORDER BY e.conversation_id, e.id DESC""", group, checklist_id)
        appeals = await conn.fetchrow(
            "SELECT count(*) FILTER (WHERE status='open') AS open, count(*) FILTER (WHERE status='changed') AS changed,"
            " count(*) FILTER (WHERE status='confirmed') AS confirmed FROM appeals")
    rows = db.recs(rows)
    totals = [float(r["final_total"]) for r in rows if r["final_total"] is not None]

    def avg(xs):
        return round(sum(xs) / len(xs), 2) if xs else None

    by_lang: dict[str, list[float]] = {}
    for r in rows:
        if r["final_total"] is not None:
            by_lang.setdefault(r["language"] or "?", []).append(float(r["final_total"]))
    crit: dict[str, dict[str, int]] = {}
    for r in rows:
        for c in r["final_criteria"] or []:
            a = c["answer"]
            k = "na" if a == "na" else ("yes" if a == "yes" else ("no" if a == "no" else "scale"))
            d = crit.setdefault(c["criterion_id"], {"yes": 0, "no": 0, "na": 0, "scale": 0, "scale_sum": 0})
            d[k] += 1
            if k == "scale":
                d["scale_sum"] += float(a)
    costs = [float(r["cost_usd"]) for r in rows if r["cost_usd"] is not None]
    hist = [0] * 10
    for t in totals:
        hist[min(int(t // 10), 9)] += 1
    return {
        "evaluated": len(rows),
        "avg_total": avg(totals),
        "critical": sum(1 for r in rows if r["critical"]),
        "by_language": {k: {"n": len(v), "avg": avg(v)} for k, v in sorted(by_lang.items())},
        "criteria": crit,
        "histogram": hist,
        "avg_cost_usd": round(sum(costs) / len(costs), 5) if costs else None,
        "avg_duration_ms": avg([r["duration_ms"] for r in rows if r["duration_ms"]]),
        "appeals": db.rec(appeals),
    }


@app.get("/api/export.csv")
async def export_csv(group: str | None = None, checklist_id: int | None = None):
    async with db.pool.acquire() as conn:
        rows = await conn.fetch(
            """SELECT DISTINCT ON (e.conversation_id) e.conversation_id, c.dataset_group, c.language, c.channel,
                      e.id AS evaluation_id, e.checklist_id, e.total, e.final_total,
                      (e.final_score->>'critical') AS critical, e.final_criteria
               FROM evaluations e JOIN conversations c ON c.id=e.conversation_id
               WHERE e.status='done' AND ($1::text IS NULL OR c.dataset_group=$1)
                 AND ($2::int IS NULL OR e.checklist_id=$2)
               ORDER BY e.conversation_id, e.id DESC""", group, checklist_id)
    crit_ids: list[str] = []
    for r in rows:
        for c in r["final_criteria"] or []:
            if c["criterion_id"] not in crit_ids:
                crit_ids.append(c["criterion_id"])
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["conversation_id", "group", "language", "channel", "evaluation_id", "checklist_id",
                "total_original", "total_final", "critical", *crit_ids])
    for r in rows:
        ans = {c["criterion_id"]: c["answer"] for c in r["final_criteria"] or []}
        w.writerow([r["conversation_id"], r["dataset_group"], r["language"], r["channel"], r["evaluation_id"],
                    r["checklist_id"], r["total"], r["final_total"], r["critical"], *[ans.get(i, "") for i in crit_ids]])
    return Response(buf.getvalue(), media_type="text/csv; charset=utf-8",
                    headers={"content-disposition": "attachment; filename=cqa_results.csv"})


# ---------------------------------------------------------------- frontend ----
FRONTEND = Path(__file__).resolve().parent.parent / "frontend"
if FRONTEND.exists():
    # Version the whole asset path so relative module imports refresh together.
    assets = sorted(path for path in FRONTEND.rglob("*") if path.suffix in {".js", ".css", ".ttf"})
    asset_version = hashlib.sha256(b"".join(path.read_bytes() for path in assets)).hexdigest()[:12]
    app.mount(f"/static/{asset_version}", StaticFiles(directory=FRONTEND), name="versioned-static")
    app.mount("/static", StaticFiles(directory=FRONTEND), name="static")
    index_html = (FRONTEND / "index.html").read_text(encoding="utf-8")
    index_html = index_html.replace('"static/', f'"static/{asset_version}/')

    @app.get("/")
    async def index():
        return HTMLResponse(index_html, headers={"cache-control": "no-cache"})
