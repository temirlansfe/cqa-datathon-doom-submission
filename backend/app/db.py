import asyncio
import json
from pathlib import Path

import asyncpg

from . import config

pool: asyncpg.Pool | None = None


async def _init_conn(conn: asyncpg.Connection) -> None:
    for t in ("json", "jsonb"):
        await conn.set_type_codec(t, encoder=json.dumps, decoder=json.loads, schema="pg_catalog")


async def connect() -> None:
    global pool
    last = None
    for _ in range(30):
        try:
            pool = await asyncpg.create_pool(config.DATABASE_URL, init=_init_conn, min_size=1, max_size=15)
            break
        except (OSError, asyncpg.PostgresError) as e:  # db container still starting
            last = e
            await asyncio.sleep(1)
    else:
        raise RuntimeError(f"database unavailable: {last}")
    schema = (Path(__file__).parent / "schema.sql").read_text()
    async with pool.acquire() as conn:
        await conn.execute(schema)
        if not await conn.fetchval("SELECT count(*) FROM checklists"):
            cfg = json.loads((Path(__file__).parent / "default_checklist.json").read_text())
            await conn.execute(
                "INSERT INTO checklists (name, version, config, is_active, note) VALUES ($1, 1, $2, true, $3)",
                cfg["name"], cfg, "Начальная конфигурация из PDF",
            )


async def close() -> None:
    if pool:
        await pool.close()


def rec(r) -> dict | None:
    return dict(r) if r is not None else None


def recs(rows) -> list[dict]:
    return [dict(r) for r in rows]
