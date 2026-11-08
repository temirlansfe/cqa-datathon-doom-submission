"""Fingerprint of the evaluation pipeline, stored with every batch and evaluation.

Lets the accuracy history answer "what exactly produced these results": model and settings,
plus short hashes of the system prompt and of the backend code. The checklist version is
tracked separately (checklist_id on the batch).
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

from . import config
from .llm import RESPONSE_SCHEMA
from .prompt import SYSTEM_PROMPT


def _h(data: bytes) -> str:
    return hashlib.sha1(data).hexdigest()[:8]


PROMPT_HASH = _h((SYSTEM_PROMPT + json.dumps(RESPONSE_SCHEMA, sort_keys=True)).encode())
CODE_HASH = _h(b"".join(p.read_bytes() for p in sorted(Path(__file__).parent.glob("*.py"))))


def pipeline() -> dict:
    provider = config.effective_provider()
    return {
        "provider": provider,
        "model": config.GEMINI_MODEL if provider == "gemini" else "mock-heuristic",
        "thinking_budget": config.GEMINI_THINKING_BUDGET if provider == "gemini" else None,
        "prompt_hash": PROMPT_HASH,
        "code_hash": CODE_HASH,
    }
