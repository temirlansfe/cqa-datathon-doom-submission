"""Stored runs of the complaint radar and their technical team queue."""

from __future__ import annotations

import asyncio
import logging
from typing import Annotated, Literal

from fastapi import APIRouter, BackgroundTasks, HTTPException
from pydantic import BaseModel, Field, StringConstraints

from . import config, db, evaluator, radar_analysis

router = APIRouter(prefix="/api/radar")
logger = logging.getLogger(__name__)
CHUNK_SIZE = 5


class RadarRequest(BaseModel):
    group: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]


class TaskRequest(BaseModel):
    run_id: int = Field(gt=0, le=2_147_483_647)
    group_index: int = Field(ge=0, le=2_147_483_647)
    report: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=100_000)]


class TaskStatusRequest(BaseModel):
    status: Literal["new", "in_progress", "fixed"]


async def _extract(run_id: int, conversations: list[dict]) -> tuple[list[dict], list[str]]:
    async with evaluator.sem():
        found = await radar_analysis.extract_chunk(conversations)
    missing = [conversation for conversation in conversations if conversation["id"] not in found]
    if missing:
        async with evaluator.sem():
            try:
                found.update(await radar_analysis.extract_chunk(missing))
            except Exception as exc:
                logger.warning("Radar run %s: incomplete chunk retry failed (%s)", run_id, type(exc).__name__)
    return (
        [signal for conversation in conversations for signal in found.get(conversation["id"], [])],
        [conversation["id"] for conversation in conversations if conversation["id"] not in found],
    )


async def _run(run_id: int, conversations: list[dict]) -> None:
    async def process(chunk: list[dict]) -> tuple[list[dict], list[str]]:
        try:
            signals, failed_ids = await _extract(run_id, chunk)
        except Exception as exc:
            logger.warning("Radar run %s: chunk failed (%s)", run_id, type(exc).__name__)
            signals, failed_ids = [], [conversation["id"] for conversation in chunk]
        async with db.pool.acquire() as conn:
            await conn.execute(
                "UPDATE radar_runs SET done=done+$2, failed=failed+$3 WHERE id=$1 AND status='running'",
                run_id, len(chunk) - len(failed_ids), len(failed_ids),
            )
        return signals, failed_ids

    result = None
    error = None
    try:
        chunks = [conversations[i:i + CHUNK_SIZE] for i in range(0, len(conversations), CHUNK_SIZE)]
        parts = await asyncio.gather(*(process(chunk) for chunk in chunks))
        signals = [signal for found, _ in parts for signal in found]
        failed_ids = [cid for _, failed in parts for cid in failed]
        dialogs_with_signals = len({signal["conversation_id"] for signal in signals})
        result = {
            "signal_count": len(signals),
            "dialogs_with_signals": dialogs_with_signals,
            "groups": [],
            "failed_ids": failed_ids,
        }
        if len(failed_ids) == len(conversations):
            error = "Gemini не удалось обработать диалоги. Попробуйте запустить анализ ещё раз."
        elif dialogs_with_signals >= 2:
            async with evaluator.sem():
                result["groups"] = await radar_analysis.group_signals(signals)
    except Exception as exc:
        logger.warning("Radar run %s: analysis failed (%s)", run_id, type(exc).__name__)
        error = "Не удалось завершить анализ жалоб. Попробуйте запустить его ещё раз."
    async with db.pool.acquire() as conn:
        await conn.execute(
            """UPDATE radar_runs SET status=$2, result=$3, error=$4, finished_at=now()
               WHERE id=$1 AND status='running'""",
            run_id, "error" if error else "finished", result, error,
        )


@router.post("/runs")
async def start_run(request: RadarRequest, background: BackgroundTasks):
    if config.effective_provider() != "gemini":
        raise HTTPException(503, "Для анализа жалоб подключите Gemini.")

    async with db.pool.acquire() as conn:
        running = await conn.fetchrow(
            "SELECT * FROM radar_runs WHERE dataset_group=$1 AND status='running'", request.group,
        )
        if running:
            return db.rec(running)
        conversations = await conn.fetch(
            """SELECT id, channel, language, transcript FROM conversations
               WHERE dataset_group=$1 ORDER BY id""",
            request.group,
        )
        if not conversations:
            raise HTTPException(404, "В этом наборе нет диалогов.")
        run = await conn.fetchrow(
            """INSERT INTO radar_runs (dataset_group, total, model) VALUES ($1, $2, $3)
               ON CONFLICT (dataset_group) WHERE status='running' DO NOTHING RETURNING *""",
            request.group, len(conversations), config.GEMINI_MODEL,
        )
        if not run:
            return db.rec(await conn.fetchrow(
                "SELECT * FROM radar_runs WHERE dataset_group=$1 ORDER BY id DESC LIMIT 1", request.group,
            ))
    background.add_task(_run, run["id"], db.recs(conversations))
    return db.rec(run)


@router.get("/runs")
async def list_runs(group: str | None = None):
    async with db.pool.acquire() as conn:
        rows = await conn.fetch(
            """SELECT id, dataset_group, status, total, done, failed, model, error, created_at, finished_at,
                      NULL::jsonb AS result
               FROM radar_runs WHERE ($1::text IS NULL OR dataset_group=$1) ORDER BY id DESC LIMIT 20""",
            group,
        )
    return db.recs(rows)


def _matches_client_turn(item: dict, transcript: list[dict]) -> bool:
    turn = item["turn"]
    if not 1 <= turn <= len(transcript):
        return False
    message = transcript[turn - 1]
    return str(message.get("speaker", "")).lower() == "client" and item["quote"] in message.get("text", "")


async def _current_result(conn, result: dict) -> dict:
    ids = {item["conversation_id"] for group in result["groups"] for item in group["items"]}
    if not ids:
        return result
    rows = await conn.fetch("SELECT id, transcript FROM conversations WHERE id=ANY($1::text[])", list(ids))
    transcripts = {row["id"]: row["transcript"] for row in rows}
    groups = []
    stale = 0
    for index, group in enumerate(result["groups"]):
        items = [
            item for item in group["items"]
            if _matches_client_turn(item, transcripts.get(item["conversation_id"], []))
        ]
        stale += len(group["items"]) - len(items)
        if len({item["conversation_id"] for item in items}) >= 2:
            groups.append({**group, "items": items, "source_group_index": index})
    current = {**result, "groups": groups}
    if stale:
        current["stale_evidence"] = stale
    return current


@router.get("/runs/{run_id}")
async def get_run(run_id: int):
    async with db.pool.acquire() as conn:
        run = db.rec(await conn.fetchrow("SELECT * FROM radar_runs WHERE id=$1", run_id))
        if run is None:
            raise HTTPException(404, "Результат анализа не найден.")
        if run["result"] is not None:
            run["result"] = await _current_result(conn, run["result"])
    return run


@router.get("/tasks")
async def list_tasks():
    async with db.pool.acquire() as conn:
        tasks = await conn.fetch(
            """SELECT id, run_id, group_index, title, category, affected_count, status, created_at, updated_at
               FROM radar_tasks ORDER BY id DESC"""
        )
    return db.recs(tasks)


@router.post("/tasks")
async def create_task(request: TaskRequest):
    by_source = "SELECT * FROM radar_tasks WHERE run_id=$1 AND group_index=$2"
    async with db.pool.acquire() as conn:
        existing = await conn.fetchrow(by_source, request.run_id, request.group_index)
        if existing is not None:
            return db.rec(existing)

        run = await conn.fetchrow("SELECT status, result FROM radar_runs WHERE id=$1", request.run_id)
        if run is None:
            raise HTTPException(404, "Результат анализа не найден.")
        if run["status"] != "finished":
            raise HTTPException(409, "Дождитесь завершения анализа.")

        groups = (run["result"] or {}).get("groups", [])
        if request.group_index >= len(groups):
            raise HTTPException(404, "Инсайт не найден в этом анализе.")
        result = await _current_result(conn, {"groups": [groups[request.group_index]]})
        if not result["groups"]:
            raise HTTPException(409, "Исходные реплики изменились. Обновите анализ перед отправкой инсайта.")

        group = result["groups"][0]
        task = await conn.fetchrow(
            """INSERT INTO radar_tasks (run_id, group_index, title, category, affected_count, report)
               VALUES ($1, $2, $3, $4, $5, $6)
               ON CONFLICT (run_id, group_index) DO NOTHING RETURNING *""",
            request.run_id, request.group_index, group["label"], group["category"],
            len({item["conversation_id"] for item in group["items"]}), request.report,
        )
        if task is None:
            task = await conn.fetchrow(by_source, request.run_id, request.group_index)
    return db.rec(task)


@router.get("/tasks/{task_id}")
async def get_task(task_id: int):
    async with db.pool.acquire() as conn:
        task = await conn.fetchrow("SELECT * FROM radar_tasks WHERE id=$1", task_id)
    if task is None:
        raise HTTPException(404, "Задача не найдена.")
    return db.rec(task)


@router.patch("/tasks/{task_id}")
async def update_task(task_id: int, request: TaskStatusRequest):
    async with db.pool.acquire() as conn:
        task = await conn.fetchrow(
            """UPDATE radar_tasks SET status=$2, updated_at=CASE WHEN status<>$2 THEN now() ELSE updated_at END
               WHERE id=$1 RETURNING *""",
            task_id, request.status,
        )
    if task is None:
        raise HTTPException(404, "Задача не найдена.")
    return db.rec(task)
