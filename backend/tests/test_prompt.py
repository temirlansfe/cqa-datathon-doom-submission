from app.prompt import annotate, render_transcript


def msg(sp, text, ts="00:00"):
    return {"speaker": sp, "text": text, "timestamp": ts}


def test_hold_marks_lines_internal_until_released():
    t = [
        msg("operator", "Прошу вас ожидать на линии."),
        msg("system", "Клиент находится на удержании."),
        msg("operator", "Коллеги, клиент хочет купить бумагу."),
        msg("operator", "Можете сразу клиенту озвучить."),
        msg("system", "Клиент больше не находится на удержании."),
        msg("operator", "Благодарю вас за ожидание."),
    ]
    assert [f["internal"] for f in annotate(t)] == [False, False, True, True, False, False]


def test_exact_duplicate_is_skipped_but_numbering_kept():
    t = [
        msg("client", "Я хотела вот.", "13:11:40"),
        msg("client", "Я хотела вот.", "13:11:40"),
        msg("operator", "Да.", "13:11:51"),
    ]
    out = render_transcript({"id": "x", "transcript": t})
    assert "[#1]" in out and "[#2]" not in out and "[#3]" in out


def test_same_text_at_different_time_is_not_duplicate():
    t = [msg("client", "[Данные идентификации скрыты]", "12:51:48"),
         msg("client", "[Данные идентификации скрыты]", "12:51:50")]
    assert [f["duplicate"] for f in annotate(t)] == [False, False]


def test_internal_label_in_prompt():
    t = [msg("system", "Клиент находится на удержании."), msg("operator", "Алло, добрый день.")]
    assert "ВНУТРЕННЕЕ" in render_transcript({"id": "x", "transcript": t})
