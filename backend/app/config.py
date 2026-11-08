import os


def _f(name: str, default: float) -> float:
    try:
        return float(os.getenv(name, default))
    except ValueError:
        return default


DATABASE_URL = os.getenv("DATABASE_URL", "postgresql://cqa:cqa@localhost:5432/cqa")

# Organizer dataset API. Either a full URL template containing {group_id},
# or a base URL to which ?group_id=<id> is appended.
DATASET_API_URL = os.getenv("DATASET_API_URL", "").strip()

# LLM provider: gemini | mock
LLM_PROVIDER = os.getenv("LLM_PROVIDER", "gemini").strip().lower()
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "").strip()
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-2.5-flash").strip()
GEMINI_THINKING_BUDGET = int(os.getenv("GEMINI_THINKING_BUDGET", "-1"))  # -1 = model default

# USD per 1M tokens, used to estimate the cost of one evaluation.
PRICE_INPUT_PER_M = _f("PRICE_INPUT_PER_M", 0.30)
PRICE_OUTPUT_PER_M = _f("PRICE_OUTPUT_PER_M", 2.50)

BATCH_CONCURRENCY = int(os.getenv("BATCH_CONCURRENCY", "6"))
LLM_TIMEOUT = _f("LLM_TIMEOUT", 180)


def effective_provider() -> str:
    if LLM_PROVIDER == "gemini" and not GEMINI_API_KEY:
        return "mock"
    return LLM_PROVIDER
