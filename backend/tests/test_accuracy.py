from app.accuracy import compute, diff, labels_of

CFG = {"rounding": 2, "criteria": [
    {"id": "c01", "type": "binary", "weight": 50, "na_allowed": False},
    {"id": "c04", "type": "scale", "weight": 50, "na_allowed": True,
     "scale": [{"value": 20}, {"value": 10}, {"value": 0}]},
    {"id": "c08", "type": "critical", "weight": 0, "na_allowed": False},
]}
GT = {"_meta": {}, "labels": {
    "a": {"c01": "yes", "c04": "20", "c08": "no", "_kind": "normal"},
    "b": {"c01": "no", "c04": "na", "c08": "yes", "_uncertain": ["c01"], "_kind": "adversarial"},
}}


def row(cid, c01, c04, c08, total, critical):
    return {"id": cid, "language": "RU", "channel": "agent chat", "eval_id": 1, "total": total, "critical": critical,
            "criteria": [{"criterion_id": "c01", "answer": c01}, {"criterion_id": "c04", "answer": c04},
                         {"criterion_id": "c08", "answer": c08}]}


def test_labels_skip_meta_and_accept_flat():
    assert set(labels_of(GT)) == {"a", "b"}
    assert set(labels_of({"x": {"c01": "yes"}, "_rules": []})) == {"x"}


def test_compute_counts_scale_numbers_and_uncertain():
    m = compute(CFG, labels_of(GT), [row("a", "yes", 20.0, "no", 100, False), row("b", "yes", "na", "yes", 100, True)])
    assert m["n_answers"] == 6 and m["accuracy"] == round(500 / 6, 2)
    assert m["accuracy_sure"] == 100.0                      # the only miss is marked uncertain
    c01 = next(c for c in m["criteria"] if c["criterion_id"] == "c01")
    assert c01["errors"] == [{"gt": "no", "model": "yes", "count": 1}]
    assert {g["key"]: g["accuracy"] for g in m["groups"]}["Тип: normal"] == 100.0
    assert m["mae_total"] == 50.0                           # b: reference total 0 (c01 no, c04 n/a) vs 100
    assert m["critical_accuracy"] == 100.0


def test_diff_fixed_and_broken():
    base = compute(CFG, labels_of(GT), [row("a", "no", 20, "no", 50, False), row("b", "no", "na", "yes", 0, True)])
    new = compute(CFG, labels_of(GT), [row("a", "yes", 20, "no", 100, False), row("b", "no", "10", "yes", 0, True)])
    d = diff(base, new)
    assert [(x["id"], x["criterion_id"]) for x in d["fixed"]] == [("a", "c01")]
    assert [(x["id"], x["criterion_id"], x["now"]) for x in d["broken"]] == [("b", "c04", "10")]
