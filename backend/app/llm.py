"""LLM providers. Each returns (parsed_json, usage_dict, model_name)."""
from __future__ import annotations

import asyncio
import json
import random
import re

import httpx

from . import config
from .prompt import SYSTEM_PROMPT, build_user_prompt

RESPONSE_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "criteria": {
            "type": "ARRAY",
            "items": {
                "type": "OBJECT",
                "properties": {
                    "criterion_id": {"type": "STRING"},
                    "analysis": {"type": "STRING"},
                    "answer": {"type": "STRING"},
                    "explanation": {"type": "STRING"},
                    "evidence": {
                        "type": "ARRAY",
                        "items": {
                            "type": "OBJECT",
                            "properties": {"turn": {"type": "INTEGER"}, "quote": {"type": "STRING"}},
                            "required": ["turn", "quote"],
                        },
                    },
                    "checked_from": {"type": "INTEGER", "nullable": True},
                    "checked_to": {"type": "INTEGER", "nullable": True},
                    "na_reason": {"type": "STRING", "nullable": True},
                },
                "required": ["criterion_id", "analysis", "answer", "explanation", "evidence"],
                "propertyOrdering": ["criterion_id", "analysis", "answer", "explanation", "evidence",
                                     "checked_from", "checked_to", "na_reason"],
            },
        },
        "summary": {"type": "STRING"},
    },
    "required": ["criteria", "summary"],
    "propertyOrdering": ["criteria", "summary"],
}

_client: httpx.AsyncClient | None = None


def client() -> httpx.AsyncClient:
    global _client
    if _client is None:
        _client = httpx.AsyncClient(timeout=config.LLM_TIMEOUT)
    return _client


async def evaluate(cfg: dict, conv: dict) -> tuple[dict, dict, str]:
    provider = config.effective_provider()
    if provider == "gemini":
        return await _gemini(cfg, conv)
    return _mock(cfg, conv)


async def _gemini(cfg: dict, conv: dict) -> tuple[dict, dict, str]:
    return await gemini_json(SYSTEM_PROMPT, build_user_prompt(cfg, conv), RESPONSE_SCHEMA)


async def gemini_json(system_prompt: str, user_prompt: str, schema: dict) -> tuple[dict, dict, str]:
    model = config.GEMINI_MODEL
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
    gen_cfg: dict = {
        "temperature": 0,
        "responseMimeType": "application/json",
        "responseSchema": schema,
    }
    if config.GEMINI_THINKING_BUDGET >= 0:
        gen_cfg["thinkingConfig"] = {"thinkingBudget": config.GEMINI_THINKING_BUDGET}
    body = {
        "systemInstruction": {"parts": [{"text": system_prompt}]},
        "contents": [{"role": "user", "parts": [{"text": user_prompt}]}],
        "generationConfig": gen_cfg,
    }
    headers = {"x-goog-api-key": config.GEMINI_API_KEY, "content-type": "application/json"}
    last_err = ""
    for attempt in range(5):
        try:
            r = await client().post(url, json=body, headers=headers)
        except httpx.HTTPError as e:
            last_err = f"network: {e}"
        else:
            if r.status_code == 200:
                data = r.json()
                try:
                    text = "".join(p.get("text", "") for p in data["candidates"][0]["content"]["parts"]
                                   if not p.get("thought"))
                    parsed = _parse_json(text)
                except (KeyError, IndexError, ValueError) as e:
                    last_err = f"bad response: {e}: {json.dumps(data)[:500]}"
                else:
                    um = data.get("usageMetadata", {})
                    usage = {
                        "input_tokens": um.get("promptTokenCount", 0),
                        "output_tokens": um.get("candidatesTokenCount", 0) + um.get("thoughtsTokenCount", 0),
                        "thinking_tokens": um.get("thoughtsTokenCount", 0),
                        "calls": attempt + 1,
                    }
                    return parsed, usage, model
            else:
                last_err = f"HTTP {r.status_code}: {r.text[:500]}"
                if r.status_code not in (429, 500, 502, 503, 504):
                    break
        await asyncio.sleep(min(2 ** attempt + random.random(), 20))
    raise RuntimeError(f"Gemini error: {last_err}")


def _parse_json(text: str) -> dict:
    text = text.strip()
    m = re.search(r"\{.*\}", text, re.S)
    return json.loads(m.group(0) if m else text)


# ---------------------------------------------------------------- mock ----
# Keyword heuristics so the UI can be exercised without an API key.
# Results are clearly labelled as "mock" in the UI.
_GREET = re.compile(r"здравствуй|добрый|привет|сәлем|қайырлы|hello|hi\b|good (morning|afternoon|evening)", re.I)
_BYE = re.compile(r"до свидания|всего доброго|хорошего дня|сау болыңыз|goodbye|have a (nice|good)|bye", re.I)
_CRIT = re.compile(r"переведите мне|на мою карту|личн(ый|ого) номер|дурак|идиот|my personal account", re.I)


def _mock(cfg: dict, conv: dict) -> tuple[dict, dict, str]:
    msgs = conv["transcript"]
    op_idx = [i for i, m in enumerate(msgs, 1) if m.get("speaker") == "operator"]
    first_op = op_idx[0] if op_idx else 1
    last_op = op_idx[-1] if op_idx else len(msgs)
    first_text = msgs[first_op - 1]["text"] if op_idx else ""
    last_text = msgs[last_op - 1]["text"] if op_idx else ""
    crit_hit = next((i for i in op_idx if _CRIT.search(msgs[i - 1]["text"])), None)
    out = []
    for c in cfg["criteria"]:
        item = {"criterion_id": c["id"], "analysis": "mock", "evidence": [first_op],
                "checked_from": None, "checked_to": None, "na_reason": None}
        t = c["title"].lower()
        if c["type"] == "critical":
            item["answer"] = "yes" if crit_hit else "no"
            item["evidence"] = [crit_hit] if crit_hit else []
            item["checked_from"], item["checked_to"] = 1, len(msgs)
            item["explanation"] = "Найдена подозрительная реплика оператора." if crit_hit else "Грубых нарушений не найдено (эвристика)."
        elif c["type"] == "scale":
            vals = sorted((s["value"] for s in c.get("scale") or []), reverse=True)
            item["answer"] = str(vals[1] if len(vals) > 1 else vals[0]) if vals else "0"
            item["evidence"] = [last_op]
            item["explanation"] = "Эвристическая оценка без LLM (mock)."
        elif "контакт" in t or "contact" in t:
            ok = bool(_GREET.search(first_text))
            item["answer"] = "yes" if ok else "no"
            item["explanation"] = "Приветствие в первом ответе оператора найдено." if ok else "В первом ответе оператора приветствие не найдено."
        elif "заверш" in t:
            ok = bool(_BYE.search(last_text))
            item["answer"] = "yes" if ok else "no"
            item["evidence"] = [last_op]
            item["explanation"] = "Оператор попрощался." if ok else "Прощание в последней реплике оператора не найдено."
        elif c.get("na_allowed"):
            item["answer"] = "na"
            item["na_reason"] = "Эвристика: условие применимости не проверялось (mock)."
            item["evidence"] = []
            item["explanation"] = "N/A (mock-режим без LLM)."
        else:
            item["answer"] = "yes"
            item["explanation"] = "Эвристическая оценка без LLM (mock)."
        item["evidence"] = [
            {"turn": turn, "quote": msgs[turn - 1]["text"]}
            for turn in item["evidence"] if 1 <= turn <= len(msgs) and msgs[turn - 1]["text"].strip()
        ]
        out.append(item)
    return ({"criteria": out, "summary": "Оценка выполнена в mock-режиме (ключ LLM не задан)."},
            {"input_tokens": 0, "output_tokens": 0, "calls": 0}, "mock-heuristic")
