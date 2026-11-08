import json
from pathlib import Path

from app import scoring

CFG = json.loads((Path(__file__).resolve().parents[1] / "app" / "default_checklist.json").read_text())


def test_all_max_gives_100():
    ans = {"c01": "yes", "c02": "yes", "c03": "yes", "c04": 20, "c05": "yes", "c06": 10, "c07": "yes", "c08": "no"}
    r = scoring.compute(CFG, ans)
    assert r["total"] == 100
    assert r["critical"] is False


def test_scale_proportional_to_weight():
    # slide example: conduct 7/10 on weight 15 -> 10.5 points
    ans = {"c01": "yes", "c02": "yes", "c03": "yes", "c04": 15, "c05": "yes", "c06": 7, "c07": "no", "c08": "no"}
    r = scoring.compute(CFG, ans)
    pts = {x["criterion_id"]: x["points"] for x in r["criteria"]}
    assert pts["c04"] == 15 and pts["c06"] == 10.5 and pts["c07"] == 0
    assert r["total"] == 85.5


def test_na_redistributes_weight():
    # identification N/A (20) -> remaining 80 scaled to 100
    ans = {"c01": "no", "c02": "yes", "c03": "na", "c04": 20, "c05": "yes", "c06": 10, "c07": "yes", "c08": "no"}
    r = scoring.compute(CFG, ans)
    assert r["applicable_weight"] == 80
    assert r["total"] == round(70 / 80 * 100, 2)  # 87.5
    eff = {x["criterion_id"]: x["effective_weight"] for x in r["criteria"]}
    assert eff["c03"] is None and eff["c01"] == 12.5


def test_critical_flag_separate_from_score():
    ans = {"c01": "yes", "c02": "yes", "c03": "yes", "c04": 20, "c05": "yes", "c06": 10, "c07": "yes", "c08": "yes"}
    r = scoring.compute(CFG, ans)
    assert r["total"] == 100 and r["critical"] is True and r["critical_criteria"] == ["c08"]


def test_total_rounds_half_up_after_redistribution():
    ans = {"c01": "yes", "c02": "no", "c03": "na", "c04": 5, "c05": "yes", "c06": 7, "c07": "no", "c08": "no"}
    assert scoring.compute(CFG, ans)["total"] == 50.63


def test_no_applicable_criteria_no_total():
    cfg = {"criteria": [{"id": "a", "type": "binary", "weight": 10, "na_allowed": True}], "sections": []}
    assert scoring.compute(cfg, {"a": "na"})["total"] is None


def test_normalize_answer():
    c04 = next(c for c in CFG["criteria"] if c["id"] == "c04")
    c01 = next(c for c in CFG["criteria"] if c["id"] == "c01")
    assert scoring.normalize_answer(c04, "14")[0] == 15
    assert scoring.normalize_answer(c04, "na")[0] == "na"
    assert scoring.normalize_answer(c01, "na") == ("no", "N/A не разрешён для критерия — ответ заменён")
    assert scoring.normalize_answer(c01, "Да")[0] == "yes"


def test_sections():
    ans = {"c01": "yes", "c02": "na", "c03": "na", "c04": "na", "c05": "yes", "c06": 10, "c07": "yes", "c08": "no"}
    r = scoring.compute(CFG, ans)
    sec = {s["section_id"]: s for s in r["sections"]}
    assert sec["security"]["points"] is None
    assert r["total"] == 100
