// HTML builders for the "Оценка качества" panel (pure functions, no DOM state).
import { esc, fmtNum, fmtDate, fmtTs, answerView, SPEAKER } from "../util.js";

/** Icon text + kind for a criterion answer (✓ ✕ ~ N/A !). */
export function iconFor(crit, answer) {
  const av = answerView(crit, answer);
  if (answer === "na") return { ...av, icon: "N/A" };
  return av;
}

/** Omit rubric echoes such as "Консультация — 10." before the actual explanation. */
function shortReason(row) {
  return String(row.explanation || "").trim()
    .replace(/^[^.!?\n]{1,100}\s+[—–]\s*(?:да|нет|частично|\d+(?:[,.]\d+)?)\.\s+/i, "");
}

export const firstRef = (row) => (row && ((row.evidence || [])[0] || (row.checked_range || [])[0])) || null;

/** Same answer regardless of representation: 20 / 20.0 / "20" for scale steps; yes / no / na as is. */
function sameAnswer(a, b) {
  const num = (v) => (v === null || v === undefined || v === "" ? NaN : Number(v));
  const x = num(a), y = num(b);
  return Number.isNaN(x) || Number.isNaN(y) ? a === b : x === y;
}

/** True when reviewers left this criterion with an answer different from the model's original one. */
export const isRevised = (row, orow) => !!(row && orow && !sameAnswer(orow.answer, row.answer));

export function changeReview(row, original) {
  if (!isRevised(row, original)) return null;
  const history = row.reviews || (row.review ? [row.review] : []);
  return history.findLast((decision) => !decision.confirmed) || null;
}

const pointsLabel = (crit, row, srow) => {
  const av = answerView(crit, row.answer);
  if (crit.type === "critical") return { main: `<span class="cv-pill ${row.answer === "yes" ? "is-crit" : "is-ok"}">${esc(av.label)}</span>`, sub: "без баллов" };
  if (row.answer === "na") return { main: `<span class="cv-pill is-na">N/A</span>`, sub: `вес ${fmtNum(crit.weight)} перераспределён` };
  const redistributed = srow && srow.max_points !== null && Math.abs(srow.max_points - crit.weight) > 0.001;
  return {
    main: `${fmtNum(srow?.points)}<span class="cv-of"> / ${fmtNum(srow?.max_points)}</span>`,
    sub: `${esc(av.label)} · вес ${fmtNum(crit.weight)}${redistributed ? ` → ${fmtNum(srow.max_points)}` : ""}`,
  };
};

function evidenceHtml(row, msgs, rel) {
  const hasQuotes = Array.isArray(row.evidence_quotes);
  const quotes = hasQuotes ? row.evidence_quotes : (row.evidence || []).map((turn) => ({ turn }));
  const chips = quotes.map(({ turn: n, quote, issue }) => {
    const m = msgs[n - 1];
    if (!m && !issue) return "";
    const sp = String(m?.speaker || "").toLowerCase();
    const t = rel && rel[n - 1] !== null && rel[n - 1] !== undefined ? rel[n - 1] : null;
    const ref = m ? `#${n} · ${esc(SPEAKER[sp] || m.speaker)}${t !== null ? ` · ${esc(t)}` : m.timestamp ? ` · ${esc(fmtTs(m.timestamp))}` : ""}` : "Реплика недоступна";
    if (issue) return `<div class="cv-ev is-unverified">
      <span class="cv-ev-ref">${m ? `<button type="button" class="cv-link" data-msg="${n}">${ref}</button>` : ref}</span>
      ${quote ? `<span class="cv-ev-q">«${esc(quote)}»</span>` : ""}
      <span class="cv-ev-issue">${esc(issue)}</span>
    </div>`;
    return `<button type="button" class="cv-ev cv-ev-${esc(sp)}" data-msg="${n}" aria-label="Перейти к реплике #${n}">
      <span class="cv-ev-ref">${ref}${hasQuotes ? " · Цитата сверена" : ""}</span>
      <span class="cv-ev-q">${hasQuotes ? `«${esc(quote)}»` : esc(m.text)}</span></button>`;
  }).join("");
  const empty = row.evidence_review && !chips ? `<div class="cv-note cv-note-warn">${esc(row.evidence_review)}</div>` : "";
  return chips ? `<div class="cv-sub-h">${hasQuotes ? "Цитаты из оценки" : "Реплики из оценки"}</div><div class="cv-ev-list">${chips}</div>` : empty;
}

/** A criterion row (collapsed header + expandable body). */
export function critHtml({ row, crit, srow, orow, appeals, msgs, rel, canAppeal, open }) {
  if (!crit) return "";
  const status = row.answer === "na" ? "Не применимо" : crit.type === "binary"
    ? (row.answer === "yes" ? "Выполнено" : "Не выполнено") : answerView(crit, row.answer).label;
  const pts = pointsLabel(crit, row, srow);
  const openAppeal = appeals.find((a) => a.status === "open");
  const revised = isRevised(row, orow);
  const modelAnswer = orow?.answer ?? row.answer;
  const cid = esc(crit.id);
  const range = row.checked_range
    ? `<div class="cv-note cv-note-range"><b>Проверенный участок:</b>
        <button type="button" class="cv-link" data-msg="${row.checked_range[0]}">#${row.checked_range[0]}</button>–<button type="button" class="cv-link" data-msg="${row.checked_range[1]}">#${row.checked_range[1]}</button>
        ${modelAnswer === "no" ? " — ожидаемое действие здесь не найдено" : ""}</div>` : "";
  // Older rows carry only `review` (latest decision); newer ones also keep the full `reviews` history.
  const reviews = row.reviews || (row.review ? [row.review] : []);
  const last = reviews[reviews.length - 1];
  const decision = changeReview(row, orow) || last;
  let review = "";
  if (decision) {
    const who = decision.reviewer ? ` · ${esc(decision.reviewer)}` : "";
    const head = revised ? "✎ Изменено проверяющим" : last.confirmed ? "✔ Оценка подтверждена проверяющим" : "↺ Возвращён ответ модели";
    review = `<div class="cv-review ${revised ? "is-changed" : "is-confirmed"}"><div class="cv-review-h">${head}${who}</div>
        ${revised ? `<div class="cv-review-ft">
          <span class="cv-was"><small>Модель</small>${esc(answerView(crit, orow.answer).label)}${orow.points !== null && orow.points !== undefined ? ` · ${fmtNum(orow.points)} б.` : ""}</span>
          <span class="cv-arrow" aria-hidden="true">→</span>
          <span class="cv-now"><small>Итог</small>${esc(answerView(crit, row.answer).label)}${srow && srow.points !== null && srow.points !== undefined ? ` · ${fmtNum(srow.points)} б.` : ""}</span>
        </div>` : ""}
        <div class="cv-review-r">${esc(decision.reason)}</div>
        ${reviews.length > 1 ? `<div class="cv-review-r">Решений по критерию: ${reviews.length}, история — в апелляциях ниже</div>` : ""}</div>`;
  }
  const apps = appeals.map((a) => `
    <div class="cv-note cv-note-appeal ${a.status === "open" ? "is-open" : ""}">
      <span>${a.status === "open" ? "⏳ Апелляция на рассмотрении" : a.status === "changed" ? "Апелляция: оценка изменена" : "Апелляция: оценка подтверждена"}
      — «${esc(a.comment)}»</span> <a href="#/appeals/${a.id}">Апелляция #${a.id} →</a></div>`).join("");
  const ref = firstRef(row);
  return `
    <div class="cv-crit ${open ? "is-open" : ""}" data-crit="${cid}">
      <button type="button" class="cv-crit-top" data-toggle="${cid}" aria-expanded="${open ? "true" : "false"}" aria-controls="cvc-${cid}">
        <span class="cv-crit-main">
          <span class="cv-crit-title">${esc(crit.title)}</span>
          ${row.evidence_review ? '<span class="cv-evidence-status">Требует проверки</span>' : ""}
          ${openAppeal ? '<span class="cv-tag is-warn">Апелляция</span>' : ""}
          ${last ? `<span class="cv-tag is-brand">${revised ? "Пересмотрено" : last.confirmed ? "Подтверждено" : "Ответ модели восстановлен"}</span>` : ""}
        </span>
        <span class="cv-crit-result">${esc(status)}</span>
        <span class="cv-chev" aria-hidden="true"></span>
      </button>
      <div class="cv-crit-body" id="cvc-${cid}" ${open ? "" : "hidden"}>
        <div class="cv-crit-detail-line"><b>${pts.main}</b><span>${pts.sub}</span></div>
        ${review}
        ${revised ? `<div class="cv-sub-h">Объяснение модели · исходный ответ «${esc(answerView(crit, modelAnswer).label)}»</div>` : ""}
        <p class="cv-expl">${esc(row.explanation || "—")}</p>
        ${modelAnswer === "na" && row.na_reason ? `<div class="cv-note cv-note-na"><b>Почему N/A:</b> ${esc(row.na_reason)}</div>` : ""}
        ${evidenceHtml(row, msgs, rel)}
        ${range}
        ${row.warning ? `<div class="cv-note cv-note-warn">⚠ ${esc(row.warning)}</div>` : ""}
        ${apps}
        <div class="cv-crit-actions">
          ${ref ? `<button type="button" class="btn" data-jump="${cid}">Перейти к фрагменту</button>` : ""}
          ${canAppeal && !openAppeal ? `<button type="button" class="btn cv-btn-appeal" data-appeal="${cid}">Оспорить оценку</button>` : ""}
        </div>
      </div>
    </div>`;
}

/** Criteria that lost points, biggest loss first. */
export function lossItems(ev, critCfg, scoreRows) {
  return ev.final_criteria
    .map((row) => ({ row, crit: critCfg[row.criterion_id], s: scoreRows[row.criterion_id] }))
    .filter(({ crit, row, s }) => crit && crit.type !== "critical" && row.answer !== "na" && s && s.max_points !== null && s.points !== null && s.max_points - s.points > 0.001)
    .map((x) => ({ ...x, loss: x.s.max_points - x.s.points }))
    .sort((a, b) => b.loss - a.loss);
}

export function findingsHtml(items, { origRows, rel }) {
  return `<ul class="cv-findings-list">${items.map(({ row, crit, s, loss }) => {
    const id = esc(crit.id);
    const decision = changeReview(row, origRows[crit.id]);
    const ref = decision ? null : firstRef(row);
    const clock = rel?.[ref - 1];
    const reason = decision ? `<b>Решение проверяющего:</b> ${esc(decision.reason)}`
      : esc(shortReason(row) || "Причина не указана.");
    return `<li class="cv-finding">
      <div class="cv-finding-top">
        <button type="button" class="cv-link cv-finding-name" data-open="${id}">${esc(crit.title)}</button>
        ${loss == null ? "" : `<span class="cv-finding-loss"
          title="Начислено: ${fmtNum(s.points)} из ${fmtNum(s.max_points)}">Снято баллов: ${fmtNum(loss)}</span>`}
      </div>
      <p>${reason}</p>
      ${ref ? `<button type="button" class="cv-link cv-finding-jump" data-jump="${id}" data-cv-ref="${esc(ref)}">${clock ? `К реплике на ${esc(clock)}` : `К реплике №${esc(ref)}`}</button>` : ""}
    </li>`;
  }).join("")}</ul>`;
}

export function plural(n, one, few, many) {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}

export function metaHtml(ev) {
  const parts = [`Оценка #${ev.id}`];
  if (ev.model) parts.push(`${esc(ev.model)}${ev.provider === "mock" ? " (mock)" : ""}`);
  if (ev.usage) parts.push(`${fmtNum(ev.usage.input_tokens, 0)} вх. / ${fmtNum(ev.usage.output_tokens, 0)} вых. токенов`);
  if (ev.cost_usd !== null && ev.cost_usd !== undefined) parts.push(`≈ $${fmtNum(ev.cost_usd, 4)}`);
  if (ev.duration_ms) parts.push(`${fmtNum(ev.duration_ms / 1000, 1)} с`);
  if (ev.finished_at) parts.push(esc(fmtDate(ev.finished_at)));
  return `<div class="cv-meta">${parts.map((p) => `<span>${p}</span>`).join("")}</div>`;
}

const STAGES = [
  [0, "Готовим диалог и чек-лист"],
  [2, "Модель читает реплики"],
  [7, "Сверяет диалог с критериями"],
  [15, "Формирует объяснения и ссылки на реплики"],
  [24, "Почти готово — считаем баллы"],
];

/** Loading view while the LLM evaluation runs (~10–30 s). Returns { html, update(elapsedSec) } helper. */
export function loadingHtml({ messages, criteria }) {
  return `
    <div class="cv-loading" role="status" aria-live="polite">
      <div class="cv-ld-top">
        <div class="cv-ld-orb" aria-hidden="true"><i></i><i></i><i></i></div>
        <div class="cv-ld-text">
          <b data-ld="stage">${esc(STAGES[0][1])}…</b>
          <div class="cv-ld-sub"><span data-ld="sec">0</span> с · обычно 10–30 с · ${messages} ${plural(messages, "реплика", "реплики", "реплик")}${criteria ? `, ${criteria} ${plural(criteria, "критерий", "критерия", "критериев")}` : ""}</div>
        </div>
      </div>
      <div class="cv-ld-bar" aria-hidden="true"><i></i></div>
      <ol class="cv-ld-steps">
        ${STAGES.map(([, s], i) => `<li data-step="${i}">${esc(s)}</li>`).join("")}
      </ol>
      <div class="cv-skel" aria-hidden="true">
        ${Array.from({ length: 6 }, (_, i) => `<div class="cv-skel-row"><i class="sq"></i><i class="ln" style="width:${55 + ((i * 17) % 35)}%"></i><i class="pt"></i></div>`).join("")}
      </div>
    </div>`;
}

export function updateLoading(root, sec) {
  const box = root.querySelector(".cv-loading");
  if (!box) return;
  let idx = 0;
  STAGES.forEach(([t], i) => { if (sec >= t) idx = i; });
  box.querySelector("[data-ld=sec]").textContent = String(Math.floor(sec));
  box.querySelector("[data-ld=stage]").textContent = `${STAGES[idx][1]}…`;
  box.querySelectorAll("[data-step]").forEach((li) => {
    const i = Number(li.dataset.step);
    li.className = i < idx ? "is-done" : i === idx ? "is-now" : "";
  });
}
