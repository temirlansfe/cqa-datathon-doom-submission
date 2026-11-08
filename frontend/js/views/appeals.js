// Appeals: list (open / resolved tabs) and the reviewer's decision page.
import { api } from "../api.js";
import { esc, $, $$, fmtNum, fmtDate, toast, busy, answerView, answerOptions, LANG, CHANNEL, SPEAKER, icon } from "../util.js";
import { refreshBadge } from "../app.js";
import { msgHtml, scrollInBox, speakerKind } from "../card/transcript.js";
import { plural } from "../card/score.js";
import { latestRuleChecklist, openRuleProposal, sameRule, versionSources } from "../rule-proposal.js";

let tab = "";
let caseCategory = "";
const TABS = { open: "На рассмотрении", resolved: "Рассмотренные", cases: "Сохранённые кейсы" };
const CASE_CATEGORIES = {
  service: "Обслуживание и процессы", product: "Продукт и баги",
  checklist: "Правила оценки", other: "Другое",
};

export async function render(root, params, query = {}) {
  if (params.id) return renderDetail(root, Number(params.id));
  const all = await api.appeals();
  if (!root.isConnected) return;
  const lists = {
    open: all.filter((a) => a.status === "open"),
    resolved: all.filter((a) => a.status !== "open"),
    cases: all.filter((a) => a.case_details),
  };
  if (Object.hasOwn(TABS, query.tab)) tab = query.tab;
  else if (!tab) tab = lists.open.length || !lists.resolved.length ? "open" : "resolved";
  if (!lists.cases.length) caseCategory = "";

  function selectTab(key) {
    tab = key;
    history.replaceState(history.state, "", `#/appeals?tab=${key}`);
    draw();
    $(`[data-tab="${tab}"]`, root)?.focus();
  }

  const draw = () => {
    const showCases = tab === "cases";
    const list = showCases && caseCategory ? lists.cases.filter((a) => a.case_details.category === caseCategory) : lists[tab];
    root.innerHTML = `
      <div class="journal-page journal-page--compact">
        <header class="journal-page-head">
          <div class="page-head"><h1>Апелляции</h1></div>
          <div class="ap-toolbar">
            <div class="ap-tabs" role="tablist" aria-label="Разделы апелляций">
              ${Object.entries(TABS).map(([key, label]) => tabBtn(key, label, lists[key].length)).join("")}
            </div>
            ${showCases && lists.cases.length ? `<div class="ap-case-filter">
              <label for="case-filter">Категория</label>
              <select class="input" id="case-filter">
                <option value="">Все категории</option>
                ${Object.entries(CASE_CATEGORIES).map(([key, label]) =>
                  `<option value="${key}" ${caseCategory === key ? "selected" : ""}>${label}</option>`).join("")}
              </select>
            </div>` : ""}
          </div>
        </header>
        <div class="card journal-panel">
          <div class="journal-scroll" role="tabpanel" id="ap-panel" aria-labelledby="ap-tab-${tab}" tabindex="0">
            ${list.length ? `<ul class="ap-list">${list.map((a) => rowHtml(a, showCases)).join("")}</ul>`
              : emptyHtml(tab, lists)}
          </div>
        </div>
      </div>`;
    $$("[data-tab], [data-ap-go]", root).forEach((b) => {
      b.addEventListener("click", () => selectTab(b.dataset.tab || b.dataset.apGo));
    });
    $("#case-filter", root)?.addEventListener("change", (e) => {
      caseCategory = e.target.value;
      draw();
      $("#case-filter", root).focus();
    });
    $("[data-ap-reset-case]", root)?.addEventListener("click", () => {
      caseCategory = "";
      draw();
      $("#case-filter", root).focus();
    });
    $(".ap-tabs", root).addEventListener("keydown", (e) => {
      if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
      e.preventDefault();
      const keys = Object.keys(TABS);
      const direction = e.key === "ArrowRight" ? 1 : -1;
      selectTab(keys[(keys.indexOf(tab) + direction + keys.length) % keys.length]);
    });
  };
  draw();
}

function emptyHtml(key, lists) {
  const review = '<button class="btn btn-sm" type="button" data-ap-go="resolved">К рассмотренным апелляциям</button>';
  const conversations = '<a class="btn btn-sm" href="#/conversations">К разговорам</a>';
  if (key === "cases") {
    if (lists.cases.length) {
      return `<div class="ap-empty"><b>В этой категории пока нет кейсов</b>
        <button class="btn btn-sm" type="button" data-ap-reset-case>Показать все категории</button></div>`;
    }
    return `<div class="ap-empty"><b>Сохранённых кейсов пока нет</b>
      <span>Кейс можно сохранить в карточке апелляции.</span>${review}</div>`;
  }
  if (key === "open" && lists.resolved.length) {
    return `<div class="ap-empty"><b>Все апелляции рассмотрены</b>${review}</div>`;
  }
  if (key === "resolved" && lists.open.length) {
    return `<div class="ap-empty"><b>Рассмотренных апелляций пока нет</b>
      <button class="btn btn-sm" type="button" data-ap-go="open">На рассмотрение</button></div>`;
  }
  return `<div class="ap-empty"><b>Апелляций пока нет</b>${conversations}</div>`;
}

const tabBtn = (key, label, n) =>
  `<button type="button" class="btn ap-tab" role="tab" id="ap-tab-${key}" data-tab="${key}" aria-selected="${tab === key}" aria-controls="ap-panel" tabindex="${tab === key ? 0 : -1}">${label}<span class="ap-count">${n}</span></button>`;

const statusHtml = (s) =>
  s === "open" ? `<span class="ap-status is-open">На рассмотрении</span>`
  : s === "changed" ? `<span class="ap-status is-changed">Оценка изменена</span>`
  : `<span class="ap-status is-confirmed">Оценка подтверждена</span>`;

function deltaHtml(before, after) {
  if (before === null || before === undefined || after === null || after === undefined) return "";
  const d = Number(after) - Number(before);
  if (Math.abs(d) < 0.001) return `<span class="ap-delta is-zero">±0</span>`;
  return `<span class="ap-delta ${d > 0 ? "is-up" : "is-down"}">${d > 0 ? "+" : "−"}${fmtNum(Math.abs(d))}</span>`;
}

function rowHtml(a, showCase) {
  const resolved = a.status !== "open";
  const criterion = a.criterion_title || a.criterion_id;
  const topic = a.conversation_title?.trim();
  const date = fmtDate(resolved ? a.resolved_at : a.created_at);
  const before = fmtNum(a.total_before);
  const after = fmtNum(a.total_after);
  const totalChanged = a.total_before != null && a.total_after != null && Math.abs(a.total_after - a.total_before) >= 0.001;
  return `
    <li><a class="ap-row" href="#/appeals/${a.id}">
      <div class="ap-row-main">
        <h2>${esc(topic || `Разговор ${a.conversation_id}`)}</h2>
        <div class="ap-row-meta">
          <span>№${a.id}</span>${topic ? `<span>${esc(a.conversation_id)}</span>` : ""}
          <span class="ap-row-criterion">${esc(criterion)}</span>${date ? `<span class="ap-row-date">${esc(date)}</span>` : ""}
          ${showCase ? `<span>${esc(CASE_CATEGORIES[a.case_details.category] || "Другое")}</span>` : ""}
        </div>
        <p class="ap-comment">${esc(showCase ? a.case_details.summary : a.comment)}</p>
      </div>
      <div class="ap-row-outcome">
        ${statusHtml(a.status)}
        <span class="ap-row-score"><span>${resolved ? "Итог" : "Итог до пересмотра"}</span>
          ${resolved && totalChanged ? `<span class="muted">${before} →</span>` : ""}
          <strong>${resolved && a.total_after != null ? after : before}</strong></span>
      </div>
      <span class="ap-row-arrow" aria-hidden="true">${icon("chev")}</span>
    </a></li>`;
}

// ---------------------------------------------------------------- detail ----

const TURN_REF = /[#№]\s*(\d+)\b|реплик[а-яё]*\s+(\d+)\b/giu;

/** Points a criterion would get for `value` (null when it depends on N/A redistribution). */
function pointsFor(crit, value, srow) {
  if (crit.type === "critical" || value === "na") return null;
  const max = srow && srow.max_points !== null && srow.max_points !== undefined ? Number(srow.max_points) : Number(crit.weight);
  if (crit.type === "scale") {
    const top = Math.max(...(crit.scale || []).map((s) => Number(s.value)));
    return top > 0 ? (max * Number(value)) / top : 0;
  }
  return value === "yes" ? max : 0;
}

async function renderDetail(root, id) {
  const { appeal: a, evaluation: ev, conversation: conv, checklist_versions: versions } = await api.appeal(id);
  if (!root.isConnected) return;
  const crit = ev.checklist.criteria.find((c) => c.id === a.criterion_id);
  if (!crit) throw new Error("Критерий не найден в версии чек-листа этой оценки");
  const row = ev.criteria.find((r) => r.criterion_id === a.criterion_id) || {}; // original model result
  const curRow = ev.final_criteria.find((r) => r.criterion_id === a.criterion_id) || row;
  const srowFinal = ev.final_score.criteria.find((r) => r.criterion_id === a.criterion_id);
  const srowOrig = ev.score.criteria.find((r) => r.criterion_id === a.criterion_id);
  const msgs = conv.transcript || [];
  const isOpen = a.status === "open";
  const cardLink = (msg) => `#/conversation/${encodeURIComponent(conv.id)}?eval=${ev.id}&crit=${encodeURIComponent(crit.id)}${msg ? `&msg=${msg}` : ""}`;

  // Keep the reviewer's citations separate from the appeal and the original evaluation.
  const validTurn = (n) => Number.isInteger(n) && n >= 1 && n <= msgs.length;
  const turnMentions = (text) => [...text.matchAll(TURN_REF)].filter((match) =>
    !/(?:апелляци[а-яё]*|критери[а-яё]*|верси[а-яё]*|задач[а-яё]*)\s*$/iu.test(text.slice(0, match.index)));
  const turnNumber = (match) => Number(match[1] ?? match[2]);
  const citedBy = (text) => new Set(turnMentions(String(text ?? "")).map(turnNumber).filter(validTurn));
  const decisionRefs = isOpen ? new Set() : citedBy(a.reason);
  const evid = new Set((row.evidence || []).map(Number).filter(validTurn));
  const refs = citedBy(a.comment);
  const citedTurns = [...new Set([...decisionRefs, ...refs, ...evid])];
  function linkedText(value) {
    const text = String(value ?? "");
    let html = "";
    let start = 0;
    for (const match of turnMentions(text)) {
      const n = turnNumber(match);
      if (!validTurn(n)) continue;
      html += esc(text.slice(start, match.index)) + `<button class="btn-link" type="button" data-ap-turn="${n}" aria-label="Показать реплику №${n}">${esc(match[0])}</button>`;
      start = match.index + match[0].length;
    }
    return html + esc(text.slice(start));
  }
  const citationsHtml = citedTurns.map((n) => {
    const msg = msgs[n - 1];
    const role = SPEAKER[speakerKind(msg.speaker)] || msg.speaker || "Участник";
    const sources = [
      decisionRefs.has(n) ? '<span class="badge brand">В решении</span>' : "",
      refs.has(n) ? '<span class="badge outline">В апелляции</span>' : "",
      evid.has(n) ? '<span class="badge outline">В оценке модели</span>' : "",
    ].join("");
    return `<li class="ap-citation" id="ap-msg-${n}" tabindex="-1">
      <div class="ap-citation-meta">
        <a href="${esc(cardLink(n))}" title="Открыть разговор на этой реплике">Реплика №${n}</a>
        <span>${esc(role)}</span>${sources}
      </div>
      <blockquote>${esc(msg.text)}</blockquote>
    </li>`;
  }).join("");
  const inRange = (n) => row.checked_range && n >= row.checked_range[0] && n <= row.checked_range[1];
  const marks = new Set();
  for (const n of citedTurns) {
    for (let k = n - 2; k <= n + 2; k++) marks.add(k);
  }
  if (row.checked_range) for (let k = row.checked_range[0] - 1; k <= row.checked_range[1] + 1; k++) marks.add(k);
  if (!marks.size) for (let k = 1; k <= Math.min(6, msgs.length); k++) marks.add(k);
  const shown = [...marks].filter((n) => n >= 1 && n <= msgs.length).sort((x, y) => x - y);
  const gap = (k) => `<div class="ap-frag-gap"><span>… ${k} ${plural(k, "реплика скрыта", "реплики скрыты", "реплик скрыто")}</span></div>`;
  let fragment = shown[0] > 1 ? gap(shown[0] - 1) : "";
  shown.forEach((n, i) => {
    if (i > 0 && n - shown[i - 1] > 1) fragment += gap(n - shown[i - 1] - 1);
    fragment += msgHtml(msgs[n - 1], n, {
      idPrefix: "ap-context-msg-",
      cls: `${refs.has(n) ? "is-appeal-reference" : ""} ${evid.has(n) ? "is-evidence" : ""} ${inRange(n) ? "in-range" : ""}`,
    });
  });
  const lastShown = shown[shown.length - 1] || 0;
  if (lastShown < msgs.length) fragment += gap(msgs.length - lastShown);

  const disputed = a.original_answer;
  const maxNow = srowFinal && srowFinal.max_points !== null ? srowFinal.max_points : crit.type === "critical" ? null : crit.weight;
  const chan = CHANNEL[conv.channel] || conv.channel || "";
  const appealMeta = [a.author, fmtDate(a.created_at)].filter(Boolean).map(esc).join(" · ");

  const scaleList = crit.type === "scale" ? `
    <div class="ap-sec-h">Шкала критерия</div>
    <div class="ap-scale">${[...crit.scale].sort((x, y) => y.value - x.value).map((s) => {
      const cls = String(s.value) === String(disputed) ? "is-cur" : a.status === "changed" && String(s.value) === String(a.new_answer) ? "is-new" : "";
      return `<div class="${cls}"><b>${esc(s.value)}</b><span>${esc(s.description)}${cls === "is-cur" ? " · <em>спорная оценка</em>" : cls === "is-new" ? " · <em>решение проверяющего</em>" : ""}</span></div>`;
    }).join("")}</div>` : "";

  const opts = answerOptions(crit).filter((o) => String(o.value) !== String(curRow.answer));
  const curPts = pointsFor(crit, curRow.answer, srowFinal);

  root.innerHTML = `
    <div class="journal-page journal-page--compact ap-detail-page">
    <header class="journal-page-head">
    <div class="crumbs"><a href="#/appeals">← Все апелляции</a></div>
    <div class="page-head ap-head">
      <div>
        <h1>Апелляция №${a.id}</h1>
        <div class="ap-head-sub">
          ${conv.title?.trim() ? `<strong>${esc(conv.title.trim())}</strong>` : ""}
          <span>${esc(conv.id)}</span>
          ${chan ? `<span>${esc(chan)}</span>` : ""}
          ${conv.language ? `<span>${esc(LANG[conv.language] || conv.language)}</span>` : ""}
        </div>
      </div>
      <a class="btn" href="${esc(cardLink(citedTurns[0]))}">${icon("chat")}Открыть разговор</a>
    </div>
    </header>
    <section class="journal-panel">
      <div class="journal-scroll journal-content" role="region" aria-label="Материалы апелляции" tabindex="0">
    <div class="ap-grid">
      <div class="ap-col">
        <section class="ap-section" aria-labelledby="ap-dispute-title">
          <h2 id="ap-dispute-title">Что оспорили</h2>
          <div class="ap-dispute-title"><strong>${esc(crit.title)}</strong>
            <span class="badge outline" title="Оспоренная оценка">${esc(answerView(crit, disputed).label)}</span></div>
          <blockquote class="ap-quote">${linkedText(a.comment)}</blockquote>
          ${appealMeta ? `<div class="ap-by">${appealMeta}</div>` : ""}
        </section>
        ${isOpen ? `
        <section class="ap-section" aria-labelledby="ap-review-title">
          <div class="ap-section-head"><h2 id="ap-review-title">Решение проверяющего</h2>${statusHtml(a.status)}</div>
          <div class="ap-form">
            <div class="ap-choice" role="radiogroup" aria-label="Решение">
              <label><input type="radio" name="dec" value="confirm" checked><b>Подтвердить ответ</b></label>
              <label><input type="radio" name="dec" value="change" ${opts.length ? "" : "disabled"}><b>Изменить ответ</b></label>
            </div>
            <fieldset class="ap-opt" id="new-wrap" hidden style="border:0;padding:0;margin:0">
              <legend class="ap-sec-h" style="margin-top:0">Новая оценка (сейчас: ${esc(answerView(crit, curRow.answer).label)})</legend>
              ${opts.map((o, i) => {
                const p = pointsFor(crit, o.value, srowFinal);
                return `<label><input type="radio" name="new-answer" value="${esc(o.value)}" ${i === 0 ? "checked" : ""}>
                  <span class="ap-opt-main">${esc(o.label)}</span>
                  <span class="ap-opt-pts">${o.value === "na" ? "вес перераспределится" : crit.type === "critical" ? "без баллов" : `${fmtNum(p)} / ${fmtNum(maxNow)}`}</span></label>`;
              }).join("")}
            </fieldset>
            <div class="ap-preview" id="ap-preview" aria-live="polite"></div>
            <label class="field">Причина решения
              <textarea class="input" id="reason" rows="3" placeholder="Например: оператор представился в реплике #3 — критерий выполнен"></textarea></label>
            <label class="field">Проверяющий
              <input class="input" id="reviewer" placeholder="ФИО или e-mail" value="${esc(window.CQA_USER || "")}" ${window.CQA_USER ? "readonly" : ""}></label>
            <div class="ap-actions">
              <button class="btn btn-primary" id="btn-decide" type="button">Сохранить решение</button>
            </div>
          </div>
        </section>` : resultHtml({ a, ev, crit, srowOrig, linkedText })}
      </div>
      <section class="ap-section ap-evidence" aria-labelledby="ap-evidence-title">
        <h2 id="ap-evidence-title">Реплики</h2>
        ${!isOpen && !decisionRefs.size ? '<p class="ap-evidence-note">В решении номера реплик не указаны.</p>' : ""}
        ${row.evidence_review ? `<div class="cv-note cv-note-warn"><b>Основание требует проверки.</b>
          ${esc(row.evidence_review)} <a href="${esc(cardLink())}">Сверить в карточке</a></div>` : ""}
        ${citationsHtml ? `<ul class="ap-citations">${citationsHtml}</ul>` : '<p class="ap-evidence-note">В апелляции и оценке нет ссылок на отдельные реплики.</p>'}
        ${fragment ? `<details class="ap-rule-details">
          <summary>Показать контекст разговора</summary>
          <div class="ap-frag">${fragment}</div>
        </details>` : ""}
        <details class="ap-rule-details">
          <summary>Правило и оценка модели</summary>
          ${row.explanation ? `<p>${esc(row.explanation)}</p>` : ""}
          ${row.na_reason ? `<p><b>Почему N/A</b> · ${esc(row.na_reason)}</p>` : ""}
          <p class="ap-by">${esc(ev.checklist_name)} · Version ${esc(ev.checklist_version)}</p>
          ${crit.description ? `<p>${esc(crit.description)}</p>` : ""}
          ${row.checked_range ? `<p>Модель проверила реплики #${esc(row.checked_range[0])}–#${esc(row.checked_range[1])}.</p>` : ""}
          ${String(row.answer) !== String(disputed) && row.answer !== undefined ? `<p>Ответ модели: <b>${esc(answerView(crit, row.answer).label)}</b></p>` : ""}
          ${crit.na_allowed && crit.na_condition ? `<p><b>Когда допустим N/A:</b> ${esc(crit.na_condition)}</p>` : ""}
          ${scaleList}
        </details>
      </section>
      <div class="ap-detail-tools">
        ${isOpen ? "" : ruleToolsHtml(a, versions)}
        <details class="ap-rule-details ap-case-details">
          <summary>${a.case_details ? "Сохранённый кейс" : "Сохранить как кейс"}</summary>
          <form class="ap-form" id="ap-case-form">
            <label class="field">Категория
              <select class="input" id="ap-case-category" required>
                <option value="">Выберите категорию</option>
                ${Object.entries(CASE_CATEGORIES).map(([key, label]) =>
                  `<option value="${key}" ${a.case_details?.category === key ? "selected" : ""}>${label}</option>`).join("")}
              </select></label>
            <label class="field">Что произошло
              <textarea class="input" id="ap-case-summary" rows="3" maxlength="500" required
                placeholder="Например, клиенту не объяснили, когда ждать ответ по заявке">${esc(a.case_details?.summary || "")}</textarea></label>
            <div class="ap-actions">
              <span class="muted small" id="ap-case-status" role="status"></span>
              <a class="btn" href="#/appeals?tab=cases">Все кейсы</a>
              <button class="btn" type="submit">${a.case_details ? "Обновить кейс" : "Сохранить кейс"}</button>
            </div>
          </form>
        </details>
      </div>
    </div></div></section></div>`;

  $$("[data-ap-turn]", root).forEach((button) => button.addEventListener("click", () => {
    const message = $(`#ap-msg-${button.dataset.apTurn}`, root);
    if (!message) return;
    message.focus({ preventScroll: true });
    scrollInBox($(".journal-scroll", root), message, { smooth: !matchMedia("(prefers-reduced-motion: reduce)").matches });
  }));

  $("#ap-case-form", root).addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const button = $("button[type=submit]", form);
    const status = $("#ap-case-status", form);
    const summary = $("#ap-case-summary", form).value.trim();
    if (!summary) { status.textContent = "Опишите кейс."; return; }
    status.textContent = "";
    busy(button, true, "Сохраняем…");
    let saved = false;
    try {
      await api.saveAppealCase(id, { category: $("#ap-case-category", form).value, summary });
      saved = true;
      status.textContent = "Кейс сохранён";
    } catch (err) {
      status.textContent = err.message;
    } finally {
      busy(button, false);
      if (saved) {
        button.textContent = "Обновить кейс";
        $("summary", form.parentElement).textContent = "Сохранённый кейс";
      }
    }
  });

  if (!isOpen) {
    if (a.status === "changed" || versions.length) loadAppealRuleAction(root, a, ev, crit, versions);
    $("#btn-rule-example", root).addEventListener("click", async (e) => {
      const button = e.currentTarget;
      const status = $("#ap-rule-example-status", root);
      status.textContent = "";
      busy(button, true, "Сохраняем…");
      try {
        await api.addRuleExample(ev.checklist_id, { criterion_id: crit.id, source_appeal_id: a.id });
        button.textContent = "Контрольный пример сохранён";
        status.textContent = "Решение проверяющего станет ожидаемым ответом при проверке правила.";
      } catch (err) {
        busy(button, false);
        status.textContent = err.message;
      }
    });
    return;
  }

  const preview = () => {
    const dec = $("input[name=dec]:checked", root).value;
    const box = $("#ap-preview", root);
    $("#new-wrap", root).hidden = dec !== "change";
    const total = ev.final_total;
    if (dec === "confirm") {
      box.innerHTML = `Итог останется <b>${fmtNum(total)}</b> · ответ «${esc(answerView(crit, curRow.answer).label)}» будет отмечен как подтверждённый`;
      return;
    }
    const nv = $("input[name=new-answer]:checked", root)?.value;
    if (nv === undefined) { box.textContent = ""; return; }
    const np = pointsFor(crit, nv, srowFinal);
    if (crit.type === "critical") {
      box.innerHTML = `Балл не изменится (<b>${fmtNum(total)}</b>), изменится флаг грубой ошибки`;
    } else if (np === null || curPts === null || total === null || total === undefined) {
      box.innerHTML = `Итог <b>${fmtNum(total)}</b> будет пересчитан с перераспределением весов N/A`;
    } else {
      const after = Number(total) + (np - curPts);
      box.innerHTML = `Итог: <b>${fmtNum(total)}</b> → <b>≈ ${fmtNum(after)}</b> ${deltaHtml(total, after)}`;
    }
  };
  $$("input[name=dec], input[name=new-answer]", root).forEach((r) => r.addEventListener("change", preview));
  preview();

  $("#btn-decide", root).addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    const decision = $("input[name=dec]:checked", root).value;
    const reasonEl = $("#reason", root);
    const reason = reasonEl.value.trim();
    if (!reason) { toast("Укажите причину решения", true); reasonEl.focus(); return; }
    busy(btn, true, "Сохранение…");
    try {
      const res = await api.decide(id, {
        decision, reason, reviewer: $("#reviewer", root).value.trim() || null,
        new_answer: decision === "change" ? $("input[name=new-answer]:checked", root)?.value ?? null : null,
      });
      toast(`Решение сохранено. Итог: ${fmtNum(res.total_before)} → ${fmtNum(res.total_after)}`);
      refreshBadge();
      await renderDetail(root, id);
    } catch (err) {
      toast(err.message, true);
      busy(btn, false);
    }
  });
}

async function loadAppealRuleAction(root, appeal, evaluation, criterion, linkedVersions) {
  const host = $("#ap-rule-action", root);
  const source = { id: evaluation.checklist_id, version: evaluation.checklist_version, config: evaluation.checklist };
  try {
    const versions = await api.checklists();
    if (!host.isConnected) return;
    const linkedIds = new Set(linkedVersions.map((version) => version.id));
    const linked = versions.filter((version) => version.name === source.config.name
      && (linkedIds.has(version.id) || versionSources(version).appealIds.includes(appeal.id)));
    const applied = linked.find((version) => version.is_active) || linked[0];
    if (applied) {
      host.innerHTML = `<a class="btn" href="#/checklists/${applied.id}?appeal=${appeal.id}">Уточнение в Version ${esc(applied.version)}${applied.is_active ? " · активная" : ""}</a>`;
      return;
    }
    if (appeal.status !== "changed") return;
    const readiness = await api.ruleSuggestions(source.id);
    if (!host.isConnected) return;
    const count = readiness.items.find((item) => item.criterion_id === criterion.id)?.case_count || 0;
    if (count < readiness.minimum_cases) {
      host.textContent = `Уточнение правила · пересмотрено ${count} из ${readiness.minimum_cases} нужных диалогов`;
      return;
    }
    const target = await latestRuleChecklist(source, versions);
    if (!host.isConnected) return;
    const current = sameRule(source, target, criterion.id);
    host.innerHTML = current ? '<button class="btn" type="button">Предложить уточнение правила</button>'
      : `<a class="btn" href="#/checklists/${target.id}?criterion=${encodeURIComponent(criterion.id)}">Открыть актуальное правило · Version ${esc(target.version)}</a>`;
    $("button", host)?.addEventListener("click", (event) => openRuleProposal(event.currentTarget, {
      source, criterionId: criterion.id, sourceAppealId: appeal.id,
      onSaved: (saved) => { location.hash = `#/checklists/${saved.id}?appeal=${appeal.id}`; },
    }));
  } catch {
    if (host.isConnected) host.textContent = "Предложения по правилу временно недоступны.";
  }
}

function resultHtml({ a, ev, crit, srowOrig, linkedText }) {
  const changed = a.status === "changed";
  const from = answerView(crit, a.original_answer), to = answerView(crit, a.new_answer);
  const totalsDiffer = a.total_before != null && a.total_after != null && Math.abs(a.total_after - a.total_before) >= 0.001;
  const reviewMeta = [a.reviewer, fmtDate(a.resolved_at)].filter(Boolean).map(esc).join(" · ");
  const laterTotal = ev.final_total != null && a.total_after != null && Math.abs(ev.final_total - a.total_after) >= 0.001;
  const reason = a.reason?.trim();
  const sameReason = reason && reason === a.comment?.trim();
  const originalDiffers = ev.total != null && a.total_before != null && Math.abs(ev.total - a.total_before) > 0.001;
  return `
    <section class="ap-section ap-result" aria-labelledby="ap-result-title">
      <div class="ap-section-head"><h2 id="ap-result-title">Решение проверяющего</h2>${statusHtml(a.status)}</div>
      <dl class="ap-decision-metrics">
        <div>
          <dt>Оценка по критерию</dt>
          <dd>${changed ? `<span>${esc(from.label)}</span> → ` : ""}<strong>${esc((changed ? to : from).label)}</strong></dd>
        </div>
        <div>
          <dt>Итог разговора</dt>
          <dd>${totalsDiffer ? `<span>${fmtNum(a.total_before)}</span> → ` : ""}<strong>${fmtNum(a.total_after ?? a.total_before)}</strong></dd>
        </div>
      </dl>
      <p class="ap-reason">${sameReason ? "Обоснование совпадает с комментарием к апелляции."
        : reason ? linkedText(reason) : "Обоснование не указано."}</p>
      ${reviewMeta ? `<div class="ap-by">${reviewMeta}</div>` : ""}
      ${originalDiffers || laterTotal ? `<details class="ap-rule-details">
        <summary>История оценки</summary>
        ${originalDiffers ? `<p>Исходная оценка модели · ${fmtNum(ev.total)}${srowOrig?.points != null ? ` · по критерию ${fmtNum(srowOrig.points)} б.` : ""}</p>` : ""}
        ${laterTotal ? `<p>Текущий итог разговора · <b>${fmtNum(ev.final_total)}</b></p>` : ""}
      </details>` : ""}
    </section>`;
}

function ruleToolsHtml(a, versions) {
  return `<details class="ap-rule-details">
    <summary>Работа с правилом</summary>
    <div class="ap-followup">
      ${a.status === "changed" || versions.length ? '<div class="muted small ap-rule-action" id="ap-rule-action" aria-live="polite"></div>' : ""}
      <button class="btn btn-sm" type="button" id="btn-rule-example">Добавить в примеры для проверки</button>
      <a class="btn btn-sm" href="#/checklists?appeal=${a.id}">Изменить правило вручную</a>
      ${versions.map((v) => `<a class="btn btn-sm" href="#/checklists/${v.id}">Version ${v.version}${v.is_active ? " · активная" : ""}</a>`).join("")}
    </div>
    <div class="muted small" id="ap-rule-example-status" role="status"></div>
  </details>`;
}
