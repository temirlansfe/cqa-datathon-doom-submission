"""Call recordings.

The organizer's audio_url returns an HTML page with an <audio><source src=…> whose signed Dynamics link
expires in about an hour. We resolve the page, download the mp3 once and serve it from a local cache,
so the player keeps working (and seeking) regardless of link expiry.
"""
from __future__ import annotations

import asyncio
import html
import os
import re
from pathlib import Path

import httpx

CACHE_DIR = Path(os.getenv("AUDIO_CACHE_DIR", "/tmp/cqa-audio"))
_SRC = re.compile(r"<source[^>]+src=\"([^\"]+)\"|<audio[^>]+src=\"([^\"]+)\"", re.I)
_locks: dict[str, asyncio.Lock] = {}


class AudioError(Exception):
    pass


def _path(cid: str) -> Path:
    return CACHE_DIR / (re.sub(r"[^A-Za-z0-9_.-]", "_", cid) + ".mp3")


async def _get(c: httpx.AsyncClient, url: str) -> httpx.Response:
    last = ""
    for attempt in range(4):
        try:
            r = await c.get(url)
            if r.status_code == 200:
                return r
            last = f"HTTP {r.status_code}"
            if r.status_code < 500 and r.status_code != 429:
                break
        except httpx.HTTPError as e:
            last = str(e) or type(e).__name__
        await asyncio.sleep(1.5 * (attempt + 1))
    raise AudioError(f"Не удалось получить {url[:80]}…: {last}")


async def resolve_mp3_url(page_url: str, c: httpx.AsyncClient) -> str:
    r = await _get(c, page_url)
    if r.headers.get("content-type", "").startswith("audio/"):
        return page_url
    m = _SRC.search(r.text)
    if not m:
        raise AudioError("На странице записи не найден тег <audio>/<source>")
    return html.unescape(m.group(1) or m.group(2))


async def cached_file(cid: str, page_url: str) -> Path:
    p = _path(cid)
    if p.exists() and p.stat().st_size > 0:
        return p
    lock = _locks.setdefault(cid, asyncio.Lock())
    async with lock:
        if p.exists() and p.stat().st_size > 0:
            return p
        async with httpx.AsyncClient(timeout=120, follow_redirects=True) as c:
            mp3 = await resolve_mp3_url(page_url, c)
            r = await _get(c, mp3)
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        tmp = p.with_suffix(".part")
        tmp.write_bytes(r.content)
        tmp.replace(p)
        return p
