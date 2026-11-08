"""Export organizer results in JSON format 1.0 from a saved batch or a new evaluation."""
from __future__ import annotations

import argparse
import asyncio
from collections import Counter
import json
from pathlib import Path
import sys
from tempfile import NamedTemporaryFile

import asyncpg
import httpx

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
from app import config, dataset, evaluator, llm, scoring  # noqa: E402

CRITERIA = {
    "c01": ("contact", "binary", 10, False, []),
    "c02": ("discovery", "binary", 15, True, []),
    "c03": ("identification", "binary", 20, True, []),
    "c04": ("consultation", "scale", 20, True, [20, 15, 10, 5, 0]),
    "c05": ("empathy", "binary", 15, False, []),
    "c06": ("dialogue", "scale", 15, False, [10, 7, 4, 0]),
    "c07": ("closure", "binary", 5, True, []),
    "c08": ("critical", "critical", 0, False, []),
}
CHANNEL_COUNTS = {"dev": {"agent chat": 60, "voice call": 5}, "prod": {"agent chat": 10}}


def read_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8-sig"))


def validate_source(split: str, conversations: list[dict]) -> None:
    channels = Counter(conv["channel"] for conv in conversations)
    if channels != CHANNEL_COUNTS[split]:
        raise ValueError(f"Ожидаемые каналы для {split}: {CHANNEL_COUNTS[split]}; получено {dict(channels)}")
    ids = set()
    for conv in conversations:
        cid = conv["raw"].get("conversation_id")
        if not isinstance(cid, str) or not cid.strip() or cid != conv["id"] or cid in ids:
            raise ValueError(f"Нет исходного conversation_id или он повторяется: {cid!r}")
        ids.add(cid)
        if len(conv["raw"]["transcript"]) != len(conv["transcript"]):
            raise ValueError(f"{cid}: исходный массив transcript содержит некорректные реплики")


def validate_checklist(cfg: dict) -> None:
    rows = cfg["criteria"]
    if Counter(c["id"] for c in rows) != dict.fromkeys(CRITERIA, 1) or cfg.get("rounding", 2) != 2:
        raise ValueError("Для сдачи нужен исходный набор из восьми критериев и округление до двух знаков.")
    for c in rows:
        actual = (c["type"], c["weight"], bool(c.get("na_allowed")), scoring.scale_values(c))
        if actual != CRITERIA[c["id"]][1:]:
            raise ValueError(f"Тип, вес, N/A или шкала {c['id']} расходятся с форматом сдачи.")


def result_row(cfg: dict, conv: dict, raw: dict) -> dict:
    raw_ids = Counter(row["criterion_id"] for row in raw["criteria"])
    if raw_ids != dict.fromkeys(CRITERIA, 1):
        raise ValueError("Модель должна вернуть каждый из восьми критериев ровно один раз.")
    legacy_refs = {}
    for row in raw["criteria"]:
        items = row["evidence"]
        if not isinstance(items, list):
            raise ValueError(f"Некорректный список доказательств по {row['criterion_id']}.")
        refs = [item for item in items if not isinstance(item, dict)]
        if any(type(index) is not int or not 1 <= index <= len(conv["transcript"]) for index in refs):
            raise ValueError(f"Некорректные номера реплик по {row['criterion_id']}.")
        legacy_refs[row["criterion_id"]] = refs
    criteria = evaluator.build_criteria(cfg, conv, raw)
    for row in criteria:
        row["evidence"] = sorted(set(row["evidence"]) | set(legacy_refs[row["criterion_id"]]))
    return export_row(cfg, conv, criteria)


def export_row(cfg: dict, conv: dict, criteria: list[dict], saved_score: dict | None = None) -> dict:
    ids = Counter(row["criterion_id"] for row in criteria)
    if ids != dict.fromkeys(CRITERIA, 1):
        raise ValueError(f"{conv['id']}: ожидается восемь разных критериев.")
    exported = []
    for row in criteria:
        cid = row["criterion_id"]
        rationale = row["explanation"].strip()
        if row["warning"] or not rationale:
            raise ValueError(f"Неполный или недопустимый ответ модели по {cid}.")
        answer = row["answer"]
        code, kind, _, na_allowed, scale = CRITERIA[cid]
        if answer == scoring.NA and na_allowed:
            value = None
        elif kind == "scale" and type(answer) in (int, float) and answer in scale:
            value = int(answer)
        elif kind != "scale" and answer in (scoring.YES, scoring.NO):
            value = answer == scoring.YES
        else:
            raise ValueError(f"{conv['id']}: недопустимый ответ по {cid}.")
        refs = row["evidence"]
        if not isinstance(refs, list) or any(type(n) is not int or not 1 <= n <= len(conv["transcript"]) for n in refs):
            raise ValueError(f"{conv['id']}: недопустимые номера реплик по {cid}.")
        exported.append({"criterion_id": code, "value": value,
                         "rationale": rationale, "evidence_turns": sorted(set(refs))})

    score = scoring.compute(cfg, evaluator.answers_of(criteria))
    if saved_score is not None and (saved_score["total"], saved_score["critical"]) != (score["total"], score["critical"]):
        raise ValueError(f"{conv['id']}: сохранённый итог не совпадает с расчётом по ответам модели.")
    return {"conversation_id": conv["id"], "status": "ok", "criteria": exported,
            "score": {"final_score": score["total"], "critical_flag": score["critical"]}}


async def export_batch(split: str, batch_id: int) -> tuple[str, list[dict]]:
    conn = await asyncpg.connect(config.DATABASE_URL)
    try:
        await conn.set_type_codec("jsonb", schema="pg_catalog", encoder=json.dumps, decoder=json.loads)
        async with conn.transaction(isolation="repeatable_read", readonly=True):
            batch = await conn.fetchrow(
                """SELECT b.status, b.dataset_group, b.total, b.pipeline, b.checklist_id, k.config
                   FROM batches b JOIN checklists k ON k.id=b.checklist_id WHERE b.id=$1""", batch_id)
            if not batch or batch["status"] != "finished" or not batch["dataset_group"]:
                raise ValueError("Укажите завершённый пакет оценки с набором организаторов.")
            group = batch["dataset_group"]
            if (split == "dev") != (group.casefold() == "dev"):
                raise ValueError("Набор выбранного пакета не соответствует DEV или PROD.")
            records = await conn.fetch(
                """SELECT c.id, c.channel, c.transcript, c.raw, e.checklist_id, e.status,
                          e.provider, e.model, e.criteria, e.score
                   FROM evaluations e JOIN conversations c ON c.id=e.conversation_id
                   WHERE e.batch_id=$1 ORDER BY c.id""", batch_id)
            group_ids = await conn.fetch("SELECT id FROM conversations WHERE dataset_group=$1", group)
    finally:
        await conn.close()

    conversations = [dict(row) for row in records]
    validate_source(split, conversations)
    if len(records) != batch["total"] or {r["id"] for r in records} != {r["id"] for r in group_ids}:
        raise ValueError("Пакет должен содержать ровно по одной оценке на каждый диалог набора.")
    cfg = batch["config"]
    validate_checklist(cfg)
    model_names = set()
    results = []
    for record in conversations:
        cid = record["id"]
        if record["checklist_id"] != batch["checklist_id"] or record["status"] not in ("done", "error"):
            raise ValueError(f"{cid}: оценка не завершена или использован другой чек-лист.")
        if record["status"] == "error":
            results.append({"conversation_id": cid, "status": "error", "criteria": [], "score": None,
                            "error": "Оценка в сохранённом прогоне завершилась ошибкой."})
            continue
        if record["provider"] != "gemini" or not record["model"] or record["score"] is None:
            raise ValueError(f"{cid}: для сдачи нужна завершённая оценка Gemini.")
        model_names.add(record["model"])
        # Use the original automatic answers and recheck quotes against their source turns.
        criteria = [evaluator.check_evidence(row, record["transcript"]) for row in record["criteria"]]
        results.append(export_row(cfg, record, criteria, record["score"]))
    pipeline = batch["pipeline"] or {}
    if not model_names and pipeline.get("provider") == "gemini" and pipeline.get("model"):
        model_names.add(pipeline["model"])
    if not model_names:
        raise ValueError("В пакете не указана фактически использованная модель.")
    return ", ".join(sorted(model_names)), results


def submission(team: str, model: str, rows: list[dict]) -> dict:
    return {"schema_version": "1.0", "team_name": team,
            "model": {"mode": "external_api", "name": model}, "results": rows}


def write_results(path: Path, payload: dict) -> None:
    content = json.dumps(payload, ensure_ascii=False, allow_nan=False, indent=2) + "\n"
    path.parent.mkdir(parents=True, exist_ok=True)
    with NamedTemporaryFile(mode="w", encoding="utf-8", newline="\n", dir=path.parent, delete=False) as f:
        tmp = Path(f.name)
        f.write(content)
    try:
        tmp.replace(path)
    finally:
        tmp.unlink(missing_ok=True)


async def load_source(args: argparse.Namespace) -> list[dict]:
    if args.input:
        group, conversations = dataset.extract_records(read_json(args.input))
    else:
        group, conversations = await dataset.fetch_group(args.group)
        if group.casefold() != args.group.casefold():
            raise ValueError("API вернул другой набор. Сверьте group_id с кодом организаторов.")
    if args.split == "prod" and group.casefold() == "dev":
        raise ValueError("Набор DEV нельзя выгружать как PROD.")
    validate_source(args.split, conversations)
    return conversations


async def evaluate_source(args: argparse.Namespace) -> tuple[str, list[dict]]:
    if config.effective_provider() != "gemini" or not config.GEMINI_API_KEY or not config.GEMINI_MODEL:
        raise ValueError("Для сдачи задайте GEMINI_API_KEY и GEMINI_MODEL. Mock-режим недоступен.")
    if config.BATCH_CONCURRENCY < 1:
        raise ValueError("BATCH_CONCURRENCY должен быть положительным.")
    conversations = await load_source(args)
    cfg = read_json(ROOT / "backend" / "app" / "default_checklist.json")
    validate_checklist(cfg)

    sem = asyncio.Semaphore(config.BATCH_CONCURRENCY)

    async def evaluate(conv: dict) -> dict:
        async with sem:
            try:
                if not conv["transcript"]:
                    raise ValueError("Пустая расшифровка.")
                raw, _, _ = await llm.evaluate(cfg, conv)
                row = result_row(cfg, conv, raw)
            except (RuntimeError, httpx.HTTPError):
                row = {"status": "error", "error": "Не удалось получить ответ модели."}
            except (KeyError, TypeError, ValueError, AttributeError):
                row = {"status": "error", "error": "Пустая расшифровка или некорректный ответ модели."}
        if row["status"] == "error":
            row.update(conversation_id=conv["id"], criteria=[], score=None)
        print(f"{conv['id']}: {row['status']}", flush=True)
        return row

    try:
        rows = await asyncio.gather(*(evaluate(conv) for conv in conversations))
    finally:
        await llm.client().aclose()
    return config.GEMINI_MODEL, rows


async def run(args: argparse.Namespace) -> int:
    if args.validate_only:
        if args.batch is not None:
            _, rows = await export_batch(args.split, args.batch)
        else:
            rows = await load_source(args)
            validate_checklist(read_json(ROOT / "backend" / "app" / "default_checklist.json"))
        print(f"{args.split.upper()}: проверено {len(rows)} записей.", flush=True)
        return 0

    if args.batch is not None:
        model, rows = await export_batch(args.split, args.batch)
    else:
        model, rows = await evaluate_source(args)
    path = ROOT / "results" / args.split / "results.json"
    write_results(path, submission(args.team.strip(), model, rows))
    errors = sum(row["status"] == "error" for row in rows)
    print(f"{path}: {len(rows) - errors} оценено, {errors} ошибок", flush=True)
    return int(errors > 0)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("split", choices=CHANNEL_COUNTS)
    parser.add_argument("--team", required=True)
    parser.add_argument("--validate-only", action="store_true",
                        help="Validate the source and checklist without evaluating or writing results")
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--input", type=Path, help="Saved response from the organizer API")
    source.add_argument("--group", help="Group ID supplied by the organizers")
    source.add_argument("--batch", type=int, help="Finished app batch ID, read from DATABASE_URL")
    args = parser.parse_args()
    if not args.team.strip():
        parser.error("--team cannot be empty")
    try:
        return asyncio.run(run(args))
    except asyncpg.PostgresError:
        parser.exit(2, "Не удалось прочитать пакет из PostgreSQL. Проверьте DATABASE_URL.\n")
    except (ValueError, OSError, dataset.DatasetError, httpx.HTTPError) as exc:
        parser.exit(2, f"{exc}\n")


if __name__ == "__main__":
    sys.exit(main())
