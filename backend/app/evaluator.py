from __future__ import annotations

import asyncio
import time
from unicodedata import normalize

from . import config, db, llm, scoring, version


def _cost(usage: dict) -> float:
    return round(usage.get("input_tokens", 0) / 1e6 * config.PRICE_INPUT_PER_M
                 + usage.get("output_tokens", 0) / 1e6 * config.PRICE_OUTPUT_PER_M, 6)


def _quote_text(text: str) -> str:
    return " ".join(normalize("NFC", text).split())


def verify_evidence(items: list, transcript: list[dict]) -> list[dict]:
    quotes = []
    for item in items:
        turn = item.get("turn") if isinstance(item, dict) else item
        turn = turn if type(turn) is int else None
        quote = item.get("quote") if isinstance(item, dict) else None
        quote = quote.strip() if isinstance(quote, str) else ""
        if turn is None or not 1 <= turn <= len(transcript):
            issue = "Указанной реплики нет в транскрипте."
        elif not quote:
            issue = "Модель сослалась на реплику без цитаты."
        elif _quote_text(quote) not in _quote_text(str(transcript[turn - 1].get("text") or "")):
            issue = "Цитата не найдена в указанной реплике."
        else:
            issue = None
        quotes.append({"turn": turn, "quote": quote, "issue": issue})
    return quotes


def check_evidence(row: dict, transcript: list[dict]) -> dict:
    # Older evaluations contain only numbered references. Preserve that format on read.
    if "evidence_quotes" not in row:
        return row
    quotes = verify_evidence(row["evidence_quotes"], transcript)
    issue = next((quote["issue"] for quote in quotes if quote["issue"]), None)
    return {
        **row,
        "evidence_quotes": quotes,
        "evidence": sorted({quote["turn"] for quote in quotes if not quote["issue"]}),
        "evidence_review": issue or row.get("evidence_missing"),
    }


def build_criteria(cfg: dict, conv: dict, model_out: dict) -> list[dict]:
    """Merge raw model output with checklist config; validate answers and evidence."""
    n = len(conv["transcript"])
    by_id = {str(x.get("criterion_id")): x for x in model_out.get("criteria") or []}
    rows = []
    for c in cfg["criteria"]:
        x = by_id.get(c["id"], {})
        answer, warn = scoring.normalize_answer(c, x.get("answer"))
        if not x:
            warn = "Модель не вернула ответ по критерию"
        evidence = x.get("evidence")
        evidence = evidence if isinstance(evidence, list) else []
        cf, ct = x.get("checked_from"), x.get("checked_to")
        checked = None
        if type(cf) is int and type(ct) is int and 1 <= cf <= ct <= n:
            checked = [cf, ct]
        na_reason = x.get("na_reason") if answer == scoring.NA else None
        allows_no_quote = (answer == scoring.NA and na_reason) or (
            answer == "no" and (checked or c["type"] == "critical")
        )
        rows.append(check_evidence({
            "criterion_id": c["id"],
            "answer": answer,
            "explanation": x.get("explanation") or "",
            "analysis": x.get("analysis") or "",
            "evidence_quotes": evidence,
            "evidence_missing": "Модель не привела цитату для этого вывода." if not evidence and not allows_no_quote else None,
            "checked_range": checked,
            "na_reason": na_reason,
            "warning": warn,
        }, conv["transcript"]))
    return rows


def answers_of(criteria: list[dict]) -> dict:
    return {r["criterion_id"]: r["answer"] for r in criteria}


async def run(evaluation_id: int) -> None:
    async with db.pool.acquire() as conn:
        ev = await conn.fetchrow("SELECT * FROM evaluations WHERE id=$1", evaluation_id)
        conv = db.rec(await conn.fetchrow("SELECT * FROM conversations WHERE id=$1", ev["conversation_id"]))
        cl = await conn.fetchrow("SELECT * FROM checklists WHERE id=$1", ev["checklist_id"])
        await conn.execute("UPDATE evaluations SET status='running' WHERE id=$1", evaluation_id)
    cfg = cl["config"]
    t0 = time.monotonic()
    try:
        out, usage, model = await llm.evaluate(cfg, conv)
        criteria = build_criteria(cfg, conv, out)
        score = scoring.compute(cfg, answers_of(criteria))
    except Exception as e:  # noqa: BLE001 — surfaced to the UI
        async with db.pool.acquire() as conn:
            await conn.execute(
                "UPDATE evaluations SET status='error', error=$2, finished_at=now(), duration_ms=$3 WHERE id=$1",
                evaluation_id, str(e)[:2000], int((time.monotonic() - t0) * 1000))
        return
    async with db.pool.acquire() as conn:
        await conn.execute(
            """UPDATE evaluations SET status='done', provider=$2, model=$3, criteria=$4, score=$5, total=$6,
                   critical=$7, final_criteria=$4, final_score=$5, final_total=$6, summary=$8, usage=$9,
                   cost_usd=$10, duration_ms=$11, finished_at=now(), error=NULL, pipeline=$12
               WHERE id=$1""",
            evaluation_id, config.effective_provider(), model, criteria, score, score["total"],
            score["critical"], out.get("summary") or "", usage, _cost(usage),
            int((time.monotonic() - t0) * 1000), version.pipeline())


async def create(conversation_id: str, checklist_id: int, batch_id: int | None = None) -> int:
    async with db.pool.acquire() as conn:
        return await conn.fetchval(
            "INSERT INTO evaluations (conversation_id, checklist_id, batch_id) VALUES ($1,$2,$3) RETURNING id",
            conversation_id, checklist_id, batch_id)


_sem: asyncio.Semaphore | None = None


def sem() -> asyncio.Semaphore:
    global _sem
    if _sem is None:
        _sem = asyncio.Semaphore(config.BATCH_CONCURRENCY)
    return _sem


async def run_batch(batch_id: int, eval_ids: list[int]) -> None:
    async def one(eid: int):
        async with sem():
            await run(eid)
        async with db.pool.acquire() as conn:
            st = await conn.fetchval("SELECT status FROM evaluations WHERE id=$1", eid)
            col = "done" if st == "done" else "failed"
            await conn.execute(f"UPDATE batches SET {col}={col}+1 WHERE id=$1", batch_id)

    await asyncio.gather(*(one(e) for e in eval_ids))
    async with db.pool.acquire() as conn:
        await conn.execute("UPDATE batches SET status='finished', finished_at=now() WHERE id=$1", batch_id)


def recompute_final(cfg: dict, final_criteria: list[dict]) -> dict:
    return scoring.compute(cfg, answers_of(final_criteria))
