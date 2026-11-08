"""Deterministic scoring per the checklist rules.

1. Applicability: N/A only where allowed.
2. Yes = full weight, No = 0; scale -> one of the listed steps.
3. Scale points are proportional to weight; the top step gives the full weight.
4. N/A criteria are excluded and their weight is redistributed proportionally,
   so the maximum stays 100.
5. Total rounded to `rounding` digits; no applicable weighted criteria -> no total.
   Critical errors are flagged separately and do not change the score.
"""
from __future__ import annotations

from decimal import Decimal, ROUND_HALF_UP
from typing import Any

YES, NO, NA = "yes", "no", "na"


def _num(v: float) -> int | float:
    return int(v) if float(v).is_integer() else float(v)


def scale_values(criterion: dict) -> list[float]:
    return sorted({_num(float(s["value"])) for s in criterion.get("scale") or []}, reverse=True)


def normalize_answer(criterion: dict, raw: Any) -> tuple[str | float, str | None]:
    """Coerce a raw answer into a valid one. Returns (answer, warning)."""
    ctype = criterion["type"]
    na_allowed = bool(criterion.get("na_allowed"))
    s = str(raw).strip().lower() if raw is not None else ""
    if s in ("na", "n/a", "н/д", "null", "none", ""):
        if na_allowed:
            return NA, None
        fallback = NO if ctype != "scale" else (scale_values(criterion) or [0])[-1]
        return fallback, "N/A не разрешён для критерия — ответ заменён"
    if ctype == "scale":
        values = scale_values(criterion)
        try:
            v = float(s.replace(",", "."))
        except ValueError:
            if s == YES and values:
                return values[0], "Ответ «да» для шкалы — выставлена верхняя ступень"
            return (values[-1] if values else 0.0), f"Некорректный ответ шкалы: {raw}"
        if not values:
            return _num(v), None
        nearest = min(values, key=lambda x: abs(x - v))
        warn = None if nearest == v else f"Значение {v:g} приведено к ступени {nearest:g}"
        return nearest, warn
    if s in (YES, "да", "иә", "true", "1"):
        return YES, None
    if s in (NO, "нет", "жоқ", "false", "0"):
        return NO, None
    return NO, f"Некорректный ответ: {raw}"


def criterion_ratio(criterion: dict, answer: str | float) -> Decimal | None:
    """Share of the criterion weight earned; None when N/A."""
    if answer == NA:
        return None
    if criterion["type"] == "scale":
        values = scale_values(criterion)
        top = values[0] if values else 0.0
        return Decimal(str(answer)) / Decimal(str(top)) if top else Decimal(0)
    return Decimal(int(answer == YES))


def compute(config: dict, answers: dict[str, Any]) -> dict:
    """answers: {criterion_id: answer}. Returns per-criterion points, sections, total, critical flag."""
    rounding = int(config.get("rounding", 2))
    criteria = config["criteria"]

    applicable_weight = Decimal(0)
    for c in criteria:
        if c["type"] == "critical" or float(c.get("weight") or 0) <= 0:
            continue
        if answers.get(c["id"], NA) != NA:
            applicable_weight += Decimal(str(c["weight"]))

    rows = []
    critical_hits = []
    earned_weight = Decimal(0)
    for c in criteria:
        ans = answers.get(c["id"])
        base_w = Decimal(str(c.get("weight") or 0))
        row = {
            "criterion_id": c["id"],
            "answer": ans,
            "base_weight": float(base_w),
            "effective_weight": None,
            "points": None,
            "max_points": None,
        }
        if c["type"] == "critical":
            if ans == YES:
                critical_hits.append(c["id"])
        elif base_w > 0 and ans != NA and applicable_weight > 0:
            ratio = criterion_ratio(c, ans)
            eff = base_w * 100 / applicable_weight
            row.update(effective_weight=float(round(eff, 4)), points=float(round(ratio * eff, 4)),
                       max_points=float(round(eff, 4)))
            earned_weight += ratio * base_w
        rows.append(row)

    sections = []
    for sec in config.get("sections") or []:
        sec_rows = [r for r, c in zip(rows, criteria) if c.get("section") == sec["id"] and r["max_points"] is not None]
        pts = sum(r["points"] for r in sec_rows)
        mx = sum(r["max_points"] for r in sec_rows)
        sections.append({
            "section_id": sec["id"],
            "title": sec["title"],
            "points": round(pts, rounding) if sec_rows else None,
            "max_points": round(mx, rounding) if sec_rows else None,
            "percent": round(pts / mx * 100, rounding) if mx else None,
        })

    total = None
    if applicable_weight > 0:
        precision = Decimal(1).scaleb(-rounding)
        total = float((earned_weight * 100 / applicable_weight).quantize(precision, rounding=ROUND_HALF_UP))
    return {
        "criteria": rows,
        "sections": sections,
        "total": total,
        "applicable_weight": float(applicable_weight),
        "critical": bool(critical_hits),
        "critical_criteria": critical_hits,
    }
