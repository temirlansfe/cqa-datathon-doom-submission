from app.evaluator import build_criteria, check_evidence


def test_only_quotes_from_the_cited_turn_become_evidence():
    cfg = {"criteria": [{"id": "c", "type": "binary"}]}
    transcript = [{"text": "Я уточню.\nОжидайте ответа."}, {"text": "Хорошего дня."}]
    model_out = {"criteria": [{"criterion_id": "c", "answer": "yes", "evidence": [
        {"turn": 1, "quote": "уточню. Ожидайте"},
        {"turn": 1, "quote": "Хорошего дня."},
        {"turn": 99, "quote": "Придуманная реплика"},
        {"turn": True, "quote": "Я уточню."},
    ]}]}
    row, = build_criteria(cfg, {"transcript": transcript}, model_out)
    assert row["answer"] == "yes"
    assert row["evidence"] == [1]
    assert [bool(item["issue"]) for item in row["evidence_quotes"]] == [False, True, True, True]
    assert row["evidence_review"]


def test_a_reimport_can_invalidate_a_previous_match():
    row = {"evidence_quotes": [{"turn": 1, "quote": "Здравствуйте!"}]}
    checked = check_evidence(row, [{"text": "Здравствуйте! Чем могу помочь?"}])
    assert checked["evidence"] == [1]
    assert checked["evidence_review"] is None
    updated = check_evidence(checked, [{"text": "Чем могу помочь?"}])
    assert updated["evidence"] == []
    assert updated["evidence_review"]
    legacy = {"evidence": [1]}
    assert check_evidence(legacy, [{"text": "Чем могу помочь?"}]) == legacy


def test_no_quote_is_valid_for_a_checked_absence_or_explained_na():
    cfg = {"criteria": [
        {"id": "closing", "type": "binary"},
        {"id": "identification", "type": "binary", "na_allowed": True},
        {"id": "contact", "type": "binary"},
        {"id": "critical", "type": "critical"},
    ]}
    model_out = {"criteria": [
        {"criterion_id": "closing", "answer": "no", "checked_from": 1, "checked_to": 1, "evidence": []},
        {"criterion_id": "identification", "answer": "na", "na_reason": "Общий вопрос.", "evidence": []},
        {"criterion_id": "contact", "answer": "yes", "evidence": []},
        {"criterion_id": "critical", "answer": "yes", "checked_from": 1, "checked_to": 1, "evidence": []},
    ]}
    rows = build_criteria(cfg, {"transcript": [{"text": "Здравствуйте!"}]}, model_out)
    assert [bool(row["evidence_review"]) for row in rows] == [False, False, True, True]
