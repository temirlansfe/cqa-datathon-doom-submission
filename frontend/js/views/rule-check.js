import { api } from "../api.js";
import { $, $$, answerOptions, answerView, busy, esc, icon } from "../util.js";

const MAX_EXAMPLES = 6;

function dialogLink(id, turn) {
  return `#/conversation/${encodeURIComponent(id)}${turn ? `?msg=${turn}` : ""}`;
}

function comparisonOptions(before, after) {
  const oldAnswers = new Set(answerOptions(before).map((o) => o.value));
  return answerOptions(after).filter((o) => oldAnswers.has(o.value));
}

function resultSide(version, crit, side, expected, cid) {
  const matches = side && String(side.answer) === String(expected);
  return `<div class="rc-result-side">
    <div class="rc-result-label"><span>Версия v${version}</span>
      ${side ? `<b>${esc(answerView(crit, side.answer).label)}</b>
        <span class="badge ${matches ? "yes" : "no"}">${matches ? "Совпало" : "Расхождение"}</span>`
        : '<span class="badge warn">Нет результата</span>'}</div>
    ${side ? `<p>${esc(side.explanation || "Обоснование отсутствует")}</p>
      ${side.evidence.length ? `<ul class="rc-quotes">${side.evidence.map(({ turn, quote, issue }) => `
        <li>${issue ? `<span class="cv-evidence-status">${esc(issue)}</span>`
          : `<a href="${dialogLink(cid, turn)}">Реплика №${turn}</a>`}
          ${quote ? `<span>«${esc(quote)}»</span>` : ""}</li>`).join("")}</ul>` : ""}` : ""}
  </div>`;
}

function resultKind(row) {
  if (!row.before || !row.after || row.error) return { kind: "warn", label: "Неполная проверка" };
  const expected = String(row.expected_answer);
  const before = String(row.before.answer) === expected;
  const after = String(row.after.answer) === expected;
  if (!before && after) return { kind: "yes", label: "Исправлено" };
  if (before && !after) return { kind: "no", label: "Новое расхождение" };
  return before ? { kind: "yes", label: "Совпало в обеих версиях" } : { kind: "warn", label: "Расхождение осталось" };
}

function reportHtml(report, baseline, candidate, beforeCrit, crit) {
  if (!report) return '<p class="muted">После проверки здесь появятся ответы обеих версий и их обоснования.</p>';
  const complete = report.results.filter((r) => r.before && r.after && !r.error);
  const matches = (side, row) => String(row[side].answer) === String(row.expected_answer);
  const beforeCount = complete.filter((r) => matches("before", r)).length;
  const afterCount = complete.filter((r) => matches("after", r)).length;
  const fixed = complete.filter((r) => !matches("before", r) && matches("after", r)).length;
  const regressed = complete.filter((r) => matches("before", r) && !matches("after", r)).length;
  const failed = report.results.length - complete.length;
  return `
    <div class="rc-metrics">
      <div><span>Совпадения с ожидаемым</span><b>${beforeCount} из ${complete.length} → ${afterCount} из ${complete.length}</b></div>
      <div><span>Исправлено</span><b>${fixed}</b></div>
      <div><span>Новые расхождения</span><b>${regressed}</b></div>
      ${failed ? `<div><span>Неполные проверки</span><b>${failed}</b></div>` : ""}
    </div>
    <p class="muted small">${esc(report.model)} · ответы на выбранных контрольных примерах</p>
    ${report.results.map((r) => {
      const status = resultKind(r);
      return `
      <article class="rc-result" data-result-dialog="${esc(r.conversation_id)}">
        <header><div><a href="${dialogLink(r.conversation_id)}">${esc(r.conversation_id)}</a>
          <span class="badge ${status.kind}">${status.label}</span></div>
          <span>Ожидаемый ответ · <b>${esc(answerView(crit, r.expected_answer).label)}</b></span></header>
        ${r.error ? `<p class="cv-note cv-note-warn">${esc(r.error)}</p>` : ""}
        <div class="rc-pair">
          ${resultSide(baseline.version, beforeCrit, r.before, r.expected_answer, r.conversation_id)}
          ${resultSide(candidate.version, crit, r.after, r.expected_answer, r.conversation_id)}
        </div>
      </article>`;
    }).join("")}`;
}

export async function render(root, params, query) {
  const [candidate, versions, conversations] = await Promise.all([
    api.checklist(params.id), api.checklists(), api.conversations(),
  ]);
  const older = versions.filter((v) => v.name === candidate.name && v.version < candidate.version);
  const source = candidate.source_appeal_id ? await api.appeal(candidate.source_appeal_id) : null;
  const reference = older.find((v) => v.id === Number(query.baseline))
    || older.find((v) => v.id === source?.evaluation.checklist_id) || older[0];
  const baseline = reference ? await api.checklist(reference.id) : null;
  const beforeCriteria = new Map((baseline?.config.criteria || []).map((c) => [c.id, c]));
  const criteria = candidate.config.criteria.filter((c) => {
    const old = beforeCriteria.get(c.id);
    return old?.type === c.type && comparisonOptions(old, c).length;
  });
  const requested = query.criterion || source?.appeal.criterion_id;
  const crit = criteria.find((c) => c.id === requested) || criteria[0];
  const path = `#/checklists/${candidate.id}/rule-check`;
  const header = `<div class="crumbs"><a href="#/checklists/${candidate.id}">Чек-лист v${candidate.version}</a> / Проверка правила</div>
    <div class="page-head"><div><h1>Проверка правила</h1>
      <div class="sub">${esc(candidate.name)} · новая версия v${candidate.version}</div></div>
      <div class="spacer"></div><a class="btn" href="#/checklists/${candidate.id}">К чек-листу</a></div>`;
  const shell = (content) => `<div class="journal-page"><header class="journal-page-head">${header}</header>
    <section class="journal-panel">
      <div class="journal-scroll journal-content" role="region" aria-label="Материалы проверки" tabindex="0">${content}</div>
    </section></div>`;
  const pickBaseline = `<label class="field">Сравнить с версией<select class="input" id="rc-baseline">
    ${older.map((v) => `<option value="${v.id}" ${v.id === baseline?.id ? "selected" : ""}>v${v.version}${v.is_active ? " · активная" : ""}</option>`).join("")}
  </select></label>`;
  const bindBaseline = () => {
    $("#rc-baseline", root)?.addEventListener("change", (e) => {
      const q = new URLSearchParams({ baseline: e.target.value });
      if (requested || crit) q.set("criterion", crit?.id || requested);
      location.hash = `${path}?${q}`;
    });
  };
  if (!crit) {
    root.innerHTML = shell(`
      ${older.length ? pickBaseline : ""}
      <p>${older.length ? "В выбранных версиях нет общего критерия с сопоставимыми ответами." : "Для сравнения нужна более ранняя версия этого чек-листа."}</p>
    `);
    bindBaseline();
    return;
  }
  const beforeCrit = beforeCriteria.get(crit.id);
  const options = comparisonOptions(beforeCrit, crit);
  let [examples, report] = await Promise.all([api.ruleExamples(candidate.id, crit.id), api.ruleCheck(candidate.id, crit.id)]);
  if (report?.baseline_id !== baseline.id) report = null;
  let working = false;

  function draw() {
    const scrollTop = $(".journal-scroll", root)?.scrollTop ?? 0;
    const known = new Set(examples.map((r) => r.conversation_id));
    const available = conversations.filter((c) => !known.has(c.id));
    const atLimit = examples.length >= MAX_EXAMPLES;
    root.innerHTML = shell(`
      <section class="card card-pad rc-panel" aria-label="Настройки проверки">
        <div class="rc-controls">
          ${pickBaseline}
          <label class="field">Критерий<select class="input" id="rc-criterion">
            ${criteria.map((c) => `<option value="${esc(c.id)}" ${c.id === crit.id ? "selected" : ""}>${esc(c.code || c.id)} · ${esc(c.title)}</option>`).join("")}
          </select></label>
        </div>
      </section>
      <section class="card card-pad rc-panel" aria-labelledby="rc-examples-title">
        <div class="rc-head"><h2 id="rc-examples-title">Контрольные примеры</h2><span class="badge">${examples.length} / ${MAX_EXAMPLES}</span></div>
        ${examples.length ? `<ul class="rc-example-list">
          ${examples.map((r) => `<li>
            <a href="${dialogLink(r.conversation_id)}">${esc(r.conversation_id)}</a>
            <b>${esc(answerView(crit, r.expected_answer).label)}</b>
            ${r.source_appeal_id ? `<a href="#/appeals/${r.source_appeal_id}">Апелляция #${r.source_appeal_id}</a>` : '<span class="muted small">Задан вручную</span>'}
            <button type="button" class="btn btn-ghost" data-rc-action data-remove="${esc(r.conversation_id)}"
              aria-label="Убрать пример ${esc(r.conversation_id)}">Убрать</button>
          </li>`).join("")}</ul>`
          : '<p class="muted">Сохраните решение из рассмотренной апелляции или добавьте диалог с ожидаемым ответом.</p>'}
        ${atLimit ? `<p class="muted small">В одной проверке доступно до ${MAX_EXAMPLES} диалогов.</p>` : `
          <form id="rc-example-form" class="rc-controls">
            <label class="field">Диалог<select class="input" id="rc-conversation" required>
              <option value="">Выберите диалог</option>
              ${available.map((c) => `<option value="${esc(c.id)}">${esc(c.id)}${c.title ? ` · ${esc(c.title)}` : ""}</option>`).join("")}
            </select></label>
            <label class="field">Ожидаемый ответ<select class="input" id="rc-expected" required>
              <option value="">Выберите ответ</option>
              ${options.map((o) => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join("")}
            </select></label>
            <button id="rc-add" data-rc-action class="btn" type="submit">Добавить пример</button>
          </form>`}
        <p id="rc-error" class="cv-note cv-note-warn" role="alert" hidden></p>
      </section>
      <section class="card card-pad rc-panel" aria-labelledby="rc-report-title">
        <div class="rc-head"><h2 id="rc-report-title">Сравнение ответов</h2>
          <button id="rc-run" data-rc-action class="btn btn-primary" type="button" ${examples.length ? "" : "disabled"}>${icon("play")}Запустить сравнение</button></div>
        <div id="rc-report">${reportHtml(report, baseline, candidate, beforeCrit, crit)}</div>
      </section>`);
    $(".journal-scroll", root).scrollTop = scrollTop;
    bindBaseline();
    $("#rc-criterion", root).addEventListener("change", (e) => {
      location.hash = `${path}?${new URLSearchParams({ baseline: baseline.id, criterion: e.target.value })}`;
    });
    $("#rc-example-form", root)?.addEventListener("submit", (e) => {
      e.preventDefault();
      const cid = $("#rc-conversation", root).value;
      const expected = $("#rc-expected", root).value;
      update($("#rc-add", root), "Сохраняем…", async () => {
        const example = await api.addRuleExample(candidate.id, { criterion_id: crit.id, conversation_id: cid, expected_answer: expected });
        examples = [...examples, example];
        report = null;
      });
    });
    $$("[data-remove]", root).forEach((btn) => btn.addEventListener("click", () => {
      update(btn, "Убираем…", async () => {
        await api.removeRuleExample(candidate.id, crit.id, btn.dataset.remove);
        examples = examples.filter((r) => r.conversation_id !== btn.dataset.remove);
        report = null;
      });
    }));
    $("#rc-run", root).addEventListener("click", (e) => {
      update(e.currentTarget, "Сравниваем версии…", async () => {
        report = await api.runRuleCheck(candidate.id, { baseline_id: baseline.id, criterion_id: crit.id });
      });
    });
  }

  async function update(button, label, action) {
    if (working) return;
    working = true;
    const error = $("#rc-error", root);
    error.hidden = true;
    const buttons = $$("[data-rc-action]:enabled", root);
    for (const b of buttons) b.disabled = true;
    busy(button, true, label);
    try {
      await action();
      if (root.isConnected) draw();
    } catch (err) {
      error.textContent = err.message;
      error.hidden = false;
    } finally {
      working = false;
      busy(button, false);
      for (const b of buttons) b.disabled = false;
    }
  }

  if (root.isConnected) draw();
}
