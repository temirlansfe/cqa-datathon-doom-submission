"""Builds the evaluation prompt from a checklist config and a transcript."""
from __future__ import annotations

import re

SPEAKER_LABEL = {"client": "КЛИЕНТ", "operator": "ОПЕРАТОР", "bot": "БОТ", "system": "СИСТЕМА"}

SYSTEM_PROMPT = """Ты — эксперт отдела контроля качества клиентского обслуживания брокерской компании.
Ты оцениваешь работу ОПЕРАТОРА в диалоге с клиентом строго по заданному чек-листу.

Правила:
- Оценивается только оператор. Реплики БОТА и СИСТЕМЫ — контекст (например, бот мог уже собрать данные или
  провести идентификацию; системные события показывают переводы, закрытие чата, ожидание).
- Диалог может быть на русском, казахском или английском. Оценивай по смыслу на языке диалога.
  Пиши объяснения на русском языке.
- Каждое сообщение пронумеровано как [#N]. Ссылайся на сообщения только по этим номерам.
- answer: для критериев типа «да/нет» — "yes" или "no"; для шкалы — одно из разрешённых значений шкалы числом в
  виде строки (например "15"); "na" — только если N/A разрешён И выполнено условие N/A.
- «Нет» — действие было нужно, но оператор его пропустил или выполнил неправильно. N/A — критерий неприменим по условию.
- Для критерия «грубые ошибки» "yes" означает, что нарушение ВЫЯВЛЕНО.
- evidence — объекты {"turn": N, "quote": "..."} с номером сообщения и короткой дословной цитатой из его текста.
  Копируй непрерывный фрагмент на языке реплики без номера, имени роли, перевода, пересказа и многоточий.
  Если подходящей цитаты нет, верни пустой массив.
  Для пропущенного действия укажи в checked_from/checked_to участок разговора, где действие ожидалось,
  и, если это помогает проверить вывод, процитируй соответствующее сообщение (например, первый ответ оператора).
- Для N/A заполни na_reason: какое условие неприменимости выполнено.
- explanation — 1–3 предложения в стиле: «Завершение — Нет. После ответа на вопрос оператор закрыл чат без прощания.
  Основание — последняя реплика оператора и сообщение о закрытии чата».
- analysis — краткие рассуждения перед ответом (что требуется критерием и что есть в диалоге).
- Не выдумывай факты, которых нет в транскрипте.

Как применять критерии:
- Оценивай каждый критерий независимо, строго по его формулировке и уточнениям. Нарушение, у которого есть свой
  критерий (грубая ошибка, отсутствие имени, переспрос), отражай в этом критерии и не снижай из-за него другие,
  если оно не влияет на их вопрос.
- Всё, что клиент написал боту до подключения оператора, оператор видит: это известные детали запроса.
  Приветствие и ответы бота не засчитываются оператору.
- Если в чек-листе есть уточнения к критерию, они важнее общего впечатления от диалога.
- Звонки — автоматическая расшифровка речи: в ней бывают искажённые слова и повторы. Не считай ошибки
  распознавания ошибками оператора. «[Имя скрыто]», «[Персональные данные скрыты]», «[Данные идентификации скрыты]» —
  замаскированные данные, которые на самом деле были произнесены.
- Реплики, помеченные как ВНУТРЕННЕЕ, оператор говорил коллеге, пока клиент был на удержании: клиент их не слышал.
- Время до первого ответа оператора не оценивается.
"""

TYPE_LABEL = {"binary": "да / нет", "scale": "шкала", "critical": "да / нет (флаг грубой ошибки, без баллов)"}


def render_checklist(cfg: dict) -> str:
    sections = {s["id"]: s["title"] for s in cfg.get("sections") or []}
    lines = [f"ЧЕК-ЛИСТ: {cfg.get('name', '')}"]
    if cfg.get("general_rules"):
        lines.append(f"Общие правила: {cfg['general_rules']}")
    lines.append("")
    for c in cfg["criteria"]:
        t = TYPE_LABEL.get(c["type"], c["type"])
        na = "N/A разрешён" if c.get("na_allowed") else "N/A НЕ разрешён"
        sec = sections.get(c.get("section"), "")
        lines.append(f"criterion_id={c['id']} · {c.get('code', '')} {c['title']} [{t}; {na}]" + (f" · секция: {sec}" if sec else ""))
        lines.append(f"  Как оценивать: {c.get('description', '')}")
        if c.get("guidance"):
            lines.append(f"  Уточнения: {c['guidance']}")
        if c.get("na_allowed") and c.get("na_condition"):
            lines.append(f"  Условие N/A: {c['na_condition']}")
        if c["type"] == "scale":
            for s in sorted(c.get("scale") or [], key=lambda x: -float(x["value"])):
                lines.append(f"    {s['value']:g} — {s['description']}" if isinstance(s["value"], (int, float)) else f"    {s['value']} — {s['description']}")
        lines.append("")
    return "\n".join(lines)


# System events that put the client on hold / take them off it (RU, EN, KZ).
_HOLD_OFF = re.compile(r"больше не находится на удержании|no longer on hold|taken off hold|ұстаудан шықты", re.I)
_HOLD_ON = re.compile(r"находится на удержании|placed on hold|is on hold|ұстауда", re.I)


def annotate(transcript: list[dict]) -> list[dict]:
    """Per message flags, index-aligned with the transcript (numbering is never changed):
    duplicate — exact repeat of the previous line (same speaker, timestamp and text), an ASR artefact;
    internal  — said while the client was on hold (operator talking to a colleague), the client did not hear it.
    """
    flags, on_hold, prev = [], False, None
    for m in transcript:
        sp, text = str(m.get("speaker", "")).lower(), str(m.get("text", ""))
        if sp == "system":
            if _HOLD_OFF.search(text):
                on_hold = False
            elif _HOLD_ON.search(text):
                on_hold = True
        key = (sp, m.get("timestamp"), text)
        flags.append({"duplicate": key == prev, "internal": on_hold and sp != "system"})
        prev = key
    return flags


def render_transcript(conv: dict) -> str:
    out = [
        f"ДИАЛОГ {conv['id']} · канал: {conv.get('channel') or '-'} · язык: {conv.get('language') or '-'}",
        "",
    ]
    for i, (m, f) in enumerate(zip(conv["transcript"], annotate(conv["transcript"])), start=1):
        if f["duplicate"]:
            continue
        sp = SPEAKER_LABEL.get(str(m.get("speaker", "")).lower(), str(m.get("speaker", "")).upper())
        if f["internal"]:
            sp = f"{sp} (ВНУТРЕННЕЕ, клиент на удержании)"
        out.append(f"[#{i}] {m.get('timestamp', '')} {sp}: {m.get('text', '')}")
    return "\n".join(out)


def build_user_prompt(cfg: dict, conv: dict) -> str:
    ids = ", ".join(c["id"] for c in cfg["criteria"])
    return (
        render_checklist(cfg)
        + "\n=====\n"
        + render_transcript(conv)
        + "\n=====\n"
        + f"Оцени диалог по каждому критерию ({ids}). Верни ровно по одному объекту на критерий и общий summary (2–3 предложения на русском)."
    )
