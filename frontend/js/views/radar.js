import { api } from "../api.js";
import { $, CHANNEL, LANG, busy, confirmDialog, esc, fmtDate, fmtNum, icon, modal, plural, toast } from "../util.js";

const CATEGORIES = {
  access: "Вход и доступ",
  app: "Приложение",
  documents: "Документы и отчёты",
  deposit: "Пополнение и переводы",
  withdrawal: "Вывод средств",
  trading: "Торговые операции",
  verification: "Идентификация и данные",
  support: "Поддержка и процессы",
  other: "Другое",
};
const RUN_STATUS = { running: "В процессе", finished: "Завершён", error: "Ошибка" };
const TASK_STATUS = {
  new: { label: "На рассмотрении", badge: "warn" },
  in_progress: { label: "В работе", badge: "brand" },
  fixed: { label: "Исправлено", badge: "yes" },
};
const TASKS_HREF = "#/radar?tab=tasks";
const taskHref = (id) => `${TASKS_HREF}&task=${encodeURIComponent(id)}`;
const POLL_MS = 2500;

function hrefFor(group, runId, topic) {
  const query = new URLSearchParams({ group });
  if (runId) query.set("run", runId);
  if (topic != null) query.set("topic", topic);
  return `#/radar?${query}`;
}

function runName(run) {
  return `Отчёт №${run.id} · ${fmtDate(run.created_at)} · ${RUN_STATUS[run.status] || run.status}`;
}

function empty(title, description) {
  return `<div class="card empty-state">
    <div class="ic">${icon("score")}</div>
    <h3>${esc(title)}</h3><p>${esc(description)}</p>
  </div>`;
}

function overviewHtml(run) {
  if (run?.status !== "finished" || !run.result) return "";
  const complaints = run.result.dialogs_with_signals;
  const themes = run.result.groups.length;
  const share = run.done > 0 ? ` (${fmtNum(complaints * 100 / run.done, 1)}%)` : "";
  return `<span>Проанализировано <strong>${fmtNum(run.done, 0)} из ${fmtNum(run.total, 0)}</strong></span>
    <span>С жалобами <strong>${fmtNum(complaints, 0)}</strong>${share}</span>
    <span><strong>${fmtNum(themes, 0)}</strong> ${plural(themes, ["повторяющаяся тема", "повторяющиеся темы", "повторяющихся тем"])}</span>`;
}

const sourceHref = (item) => `#/conversation/${encodeURIComponent(item.conversation_id)}?msg=${encodeURIComponent(item.turn)}`;
const affectedCount = (problem) => new Set(problem.items.map((item) => item.conversation_id)).size;

function quoteRow(item) {
  return `<li class="radar-quote">
    <div class="radar-quote-main">
      <div class="radar-quote-meta">
        <span class="mono">${esc(item.conversation_id)}</span>
        <span>${esc(CHANNEL[item.channel] || item.channel)}</span>
        <span>${esc(LANG[item.language] || item.language)}</span>
      </div>
      <blockquote>${esc(item.quote)}</blockquote>
    </div>
    <a class="btn radar-source" href="${esc(sourceHref(item))}">К реплике №${esc(item.turn)} ${icon("chev")}</a>
  </li>`;
}

function problemsHtml(groups, analyzed) {
  const ranked = groups.map((problem, index) => ({ problem, index, count: affectedCount(problem) }))
    .sort((a, b) => b.count - a.count);
  const rows = ranked.map(({ problem, index, count }) => {
    const category = esc(CATEGORIES[problem.category] || CATEGORIES.other);
    const share = analyzed > 0 ? `${fmtNum(count * 100 / analyzed, 1)}%` : "—";
    return `<tr>
      <th scope="row"><span class="radar-category-inline">${category}</span>${esc(problem.label)}</th>
      <td class="radar-category-col"><span class="radar-category-tag">${category}</span></td>
      <td class="num radar-reach"><strong>${fmtNum(count, 0)}</strong><span class="radar-share-inline">${share}</span></td>
      <td class="num radar-share-col">${share}</td>
      <td><div class="radar-row-actions">
        <button class="btn btn-sm" type="button" data-radar-sources="${index}" aria-label="Посмотреть реплики · ${esc(problem.label)}">
          <span class="radar-action-full">Посмотреть реплики</span><span class="radar-action-short">Реплики</span> ${icon("chev")}
        </button>
      </div></td>
    </tr>`;
  }).join("");
  return `<section class="radar-results" aria-labelledby="radar-topics-heading">
    <h2 class="radar-results-heading" id="radar-topics-heading">Повторяющиеся жалобы</h2>
    <table class="table radar-table">
      <thead><tr>
        <th scope="col" class="radar-topic-col">Тема</th><th scope="col" class="radar-category-col">Категория</th>
        <th scope="col" class="num">Диалоги</th>
        <th scope="col" class="num radar-share-col" title="Доля от всех проанализированных диалогов">Доля</th>
        <th scope="col"><span class="sr-only">Действия</span></th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </section>`;
}

function openSources(problem, onCompose, onClose) {
  const count = affectedCount(problem);
  const title = problem.label;
  const m = modal({
    title,
    cancelText: "Закрыть",
    submitText: "Подготовить задачу",
    onSubmit: onCompose,
    onClose,
    body: `<div class="muted small">${esc(CATEGORIES[problem.category] || CATEGORIES.other)} · ${fmtNum(count, 0)} ${plural(count, ["диалог", "диалога", "диалогов"])}</div>
    <strong>Исходные реплики</strong>
    <ul class="radar-quotes">${problem.items.map(quoteRow).join("")}</ul>`,
  });
  const dialog = $('[role="dialog"]', m.el);
  dialog.classList.add("modal-wide");
  dialog.setAttribute("aria-label", title);
  $(".radar-source", m.el)?.focus();
  return m;
}

function openInsight(problem, run) {
  const count = affectedCount(problem);
  const sources = problem.items.map((item) => {
    const url = new URL(sourceHref(item), window.location.href).href;
    const channel = CHANNEL[item.channel] || item.channel;
    return `- ${item.conversation_id} · ${channel} · реплика №${item.turn}\n  «${item.quote}»\n  ${url}`;
  });
  const insight = [
    `Инсайт · ${problem.label}`,
    `Категория · ${CATEGORIES[problem.category] || CATEGORIES.other}`,
    "",
    "Затронутые диалоги",
    `${count} из ${run.done} обработанных · набор ${run.dataset_group} · прогон №${run.id}`,
    "",
    "Исходные реплики", ...sources,
  ].join("\n");
  const m = modal({
    title: "Черновик задачи",
    cancelText: "К репликам",
    submitText: "Добавить в очередь техкоманды",
    body: `<label class="field">Описание задачи
      <textarea class="input radar-draft-text" id="radar-draft-text" rows="13">${esc(insight)}</textarea></label>
      <p class="muted small">Задача появится во внутренней очереди «Задачи техкоманды».</p>
      <p class="muted small radar-draft-status" id="radar-draft-status" role="status"></p>`,
    onSubmit: async (el) => {
      const report = $("#radar-draft-text", el).value.trim();
      if (!report) throw new Error("Введите описание задачи.");
      const task = await api.createRadarTask({ run_id: run.id, group_index: problem.source_group_index, report });
      if (!el.isConnected) return;
      toast(`Задача №${task.id} в очереди техкоманды.`);
      location.hash = taskHref(task.id);
    },
  });
  const dialog = $('[role="dialog"]', m.el);
  dialog.classList.add("modal-wide");
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "btn";
  copy.textContent = "Скопировать текст";
  $("[data-ok]", m.el).before(copy);
  copy.addEventListener("click", async () => {
    const input = $("#radar-draft-text", m.el);
    const status = $("#radar-draft-status", m.el);
    try {
      await navigator.clipboard.writeText(input.value);
      status.textContent = "Текст скопирован.";
    } catch {
      input.focus();
      input.select();
      status.textContent = "Текст выделен. Скопируйте его вручную.";
    }
  });
  return m;
}

function taskReportHtml(report) {
  return report.split(/\r?\n/).map((line) => {
    const source = line.trim().match(/^https?:\/\/[^#\s]+(#\/conversation\/\S+)$/);
    return source ? `  <a href="${esc(source[1])}">${esc(source[1])}</a>` : esc(line);
  }).join("\n");
}

function openTask(task) {
  const title = `Задача №${task.id}`;
  const m = modal({
    title,
    cancelText: "Закрыть",
    submitText: "Сохранить статус",
    body: `<div><strong>${esc(task.title)}</strong></div>
      <pre class="radar-task-report">${taskReportHtml(task.report)}</pre>
      <div class="field"><label for="radar-task-status">Статус задачи</label>
        <select id="radar-task-status" class="input">
          ${Object.entries(TASK_STATUS).map(([id, status]) => `<option value="${id}" ${id === task.status ? "selected" : ""}>${status.label}</option>`).join("")}
        </select>
      </div>`,
    onSubmit: async (el) => {
      await api.setRadarTaskStatus(task.id, $("#radar-task-status", el).value);
      if (!el.isConnected) return;
      toast(`Статус задачи №${task.id} сохранён.`);
      location.hash = TASKS_HREF;
    },
  });
  const dialog = $('[role="dialog"]', m.el);
  dialog.classList.add("modal-wide");
  dialog.setAttribute("aria-label", title);
  return m;
}

async function renderTasks(root, query) {
  const tasks = await api.radarTasks();
  if (!root.isConnected) return;
  root.innerHTML = `<div class="radar-page radar-tasks-page journal-page journal-page--compact">
    <header class="journal-page-head"><div class="page-head">
      <h1>Задачи техкоманды</h1>
      <a class="btn" href="#/radar">${icon("back")}К инсайтам</a>
    </div></header>
    <section class="journal-panel">
      <div class="journal-scroll" role="region" aria-label="Очередь техкоманды" tabindex="0">
    ${tasks.length ? `
      <div class="radar-table-wrap">
        <table class="table radar-table radar-task-table">
          <thead><tr><th scope="col">Задача</th><th scope="col" class="num radar-task-count">Диалоги</th>
            <th scope="col" class="radar-task-state">Статус</th><th scope="col" class="radar-task-date">Обновлено</th></tr></thead>
          <tbody>${tasks.map((task) => {
            const status = TASK_STATUS[task.status];
            return `<tr>
              <th scope="row"><a class="radar-task-link" href="${taskHref(task.id)}">№${esc(task.id)} · ${esc(task.title)}</a>
                <small>${esc(CATEGORIES[task.category] || CATEGORIES.other)}</small></th>
              <td class="num radar-task-count">${fmtNum(task.affected_count, 0)}</td>
              <td class="radar-task-state"><span class="badge ${status.badge}">${status.label}</span></td>
              <td class="radar-task-date">${esc(fmtDate(task.updated_at))}</td></tr>`;
          }).join("")}</tbody>
        </table>
      </div>
    ` : empty("Очередь пока пуста", "Откройте реплики по теме в «Инсайтах» и добавьте задачу в очередь.")}
      </div>
    </section>
  </div>`;
  if (!/^\d+$/.test(query.task || "")) return;
  try {
    const task = await api.radarTask(Number(query.task));
    if (!root.isConnected) return;
    const dialog = openTask(task);
    return () => dialog.close();
  } catch (error) {
    if (root.isConnected) toast(error.message, true);
  }
}

function warningsHtml(run) {
  const result = run.result || {};
  const failedIds = result.failed_ids || [];
  return `${run.failed ? `<aside class="radar-warning">
    <strong>Не удалось обработать ${fmtNum(run.failed, 0)} ${plural(run.failed, ["диалог", "диалога", "диалогов"])}</strong>
    ${failedIds.length ? `<p class="mono">${failedIds.map(esc).join(", ")}</p>` : ""}
  </aside>` : ""}
  ${result.stale_evidence ? `<aside class="radar-warning">
    <strong>Часть транскриптов обновилась</strong>
    <p>Запустите анализ снова, чтобы сверить все реплики с текущими транскриптами.</p>
  </aside>` : ""}`;
}

function reportHtml(run, group) {
  if (!group) return empty("Нет наборов для анализа", "Загрузите набор диалогов в разделе «Разговоры».");
  if (!run) return empty("Для этого набора ещё нет отчёта", "Нажмите «Запустить анализ», чтобы найти повторяющиеся жалобы клиентов.");
  if (run.status === "running") {
    const processed = run.done + run.failed;
    return `<section class="card card-pad radar-progress" aria-label="Ход анализа">
      <div class="radar-progress-heading"><h2>Анализ выполняется</h2>
        <span>Обработано ${fmtNum(processed, 0)} из ${fmtNum(run.total, 0)}</span></div>
      <progress aria-label="Обработано диалогов" value="${processed}" max="${run.total}"></progress>
      <p class="muted small">Найденные жалобы будут сгруппированы после обработки диалогов.</p>
    </section>`;
  }
  if (run.status === "error") {
    return `<section class="card card-pad radar-warning">
      <h2>Анализ не завершился</h2>
      <p>${esc(run.error || "Попробуйте запустить анализ снова.")}</p>
    </section>`;
  }
  const result = run.result;
  if (!result) return empty("Отчёт пока недоступен", "Нажмите «Обновить», чтобы повторить загрузку.");
  return result.groups.length ? problemsHtml(result.groups, run.done)
    : empty("Повторяющиеся жалобы не найдены", "Для группы нужны подтверждающие реплики из двух или более диалогов.");
}

export async function render(root, params, query = {}) {
  if (query.tab === "tasks") return renderTasks(root, query);
  const groups = await api.groups();
  const group = groups.find((entry) => entry.id === query.group)
    || groups.find((entry) => entry.id === "DEV") || groups[0];
  let runs = group ? await api.radarRuns(group.id) : [];
  const selected = runs.find((entry) => String(entry.id) === query.run) || runs[0];
  let run = selected ? await api.radarRun(selected.id) : null;
  if (!root.isConnected) return;

  root.innerHTML = `<div class="radar-page radar-report-page journal-page">
    <header class="journal-page-head">
      <div class="page-head">
        <div><h1>Инсайты</h1>
          <div id="radar-overview" class="radar-overview" role="group" aria-label="Сводка по набору" hidden></div>
        </div>
        <a class="btn radar-queue-link" href="${TASKS_HREF}">${icon("list")}Задачи техкоманды</a>
      </div>
      <div class="radar-actions">
        <div class="field"><label class="sr-only" for="radar-group">Набор диалогов</label>
          <select class="input" id="radar-group" ${group ? "" : "disabled"}>
            <button type="button"><selectedcontent></selectedcontent></button>
            ${groups.map((entry) => `<option value="${esc(entry.id)}" ${entry === group ? "selected" : ""}>Набор: ${esc(entry.id)} · ${fmtNum(entry.count, 0)}</option>`).join("") || '<option>Нет наборов</option>'}
          </select>
        </div>
        <div class="field radar-history" id="radar-history" hidden><label class="sr-only" for="radar-run-select">Отчёт</label>
          <select class="input" id="radar-run-select"></select>
        </div>
        <button class="btn" id="radar-warnings" type="button" hidden>${icon("alert")}Предупреждения</button>
        <button class="btn" id="radar-refresh" type="button" title="Загрузить актуальное состояние отчёта" ${group ? "" : "disabled"}>${icon("refresh")}Обновить</button>
        <button class="btn btn-primary" id="radar-run" type="button"></button>
      </div>
    </header>
    <section class="journal-panel">
      <div class="journal-scroll" role="region" aria-label="Отчёт по инсайтам" tabindex="0">
        <p id="radar-feedback" class="radar-warning" role="status" hidden></p>
        <div id="radar-progress" aria-live="polite" class="radar-sr"></div>
        <div id="radar-results"></div>
      </div>
    </section>
  </div>`;

  const historyField = $("#radar-history", root);
  const runSelect = $("#radar-run-select", root);
  const runButton = $("#radar-run", root);
  const refreshButton = $("#radar-refresh", root);
  const warningsButton = $("#radar-warnings", root);
  const overview = $("#radar-overview", root);
  const feedback = $("#radar-feedback", root);
  const progress = $("#radar-progress", root);
  const results = $("#radar-results", root);
  let timer;
  let dialog;
  let draftDialog;
  let warningsDialog;
  let pending = false;

  function updateRun(next) {
    run = next;
    if (!next) return;
    const index = runs.findIndex((entry) => entry.id === next.id);
    if (index < 0) runs.unshift(next);
    else runs[index] = next;
  }

  function drawControls() {
    const running = runs.some((entry) => entry.status === "running");
    runButton.disabled = !group || running;
    runButton.innerHTML = running ? "Анализ выполняется" : `${icon("play")}Запустить анализ`;
    historyField.hidden = runs.length < 2;
    runSelect.innerHTML = '<button type="button"><selectedcontent></selectedcontent></button>'
      + runs.map((entry) => `<option value="${esc(entry.id)}" ${entry.id === run?.id ? "selected" : ""}>${esc(runName(entry))}</option>`).join("");
  }

  function drawReport() {
    const summary = overviewHtml(run);
    overview.innerHTML = summary;
    overview.hidden = !summary;
    warningsButton.hidden = !(run?.failed || run?.result?.stale_evidence);
    results.dataset.runStatus = run?.status || "empty";
    results.innerHTML = reportHtml(run, group);
    const announcement = run?.status === "running" ? `Обработано ${run.done + run.failed} из ${run.total}` : "";
    if (progress.textContent !== announcement) progress.textContent = announcement;
  }

  function showFeedback(message = "") {
    feedback.textContent = message;
    feedback.hidden = !message;
  }

  function schedule(delay = POLL_MS) {
    clearTimeout(timer);
    const active = runs.find((entry) => entry.status === "running");
    if (root.isConnected && active) timer = setTimeout(() => poll(active.id), delay);
  }

  async function poll(id) {
    if (!root.isConnected) return;
    if (pending) { schedule(); return; }
    pending = true;
    let delay = POLL_MS;
    try {
      const next = await api.radarRun(id);
      if (!root.isConnected) return;
      const isSelected = run?.id === id;
      if (isSelected) {
        updateRun(next);
        drawReport();
      } else {
        const index = runs.findIndex((entry) => entry.id === id);
        if (index >= 0) runs[index] = next;
      }
      if (next.status !== "running") drawControls();
      showFeedback();
    } catch {
      showFeedback("Не удалось обновить ход анализа. Повторим запрос через несколько секунд.");
      delay = 6000;
    } finally {
      pending = false;
      schedule(delay);
    }
  }

  async function refresh() {
    if (pending || !group) return;
    pending = true;
    refreshButton.disabled = true;
    try {
      const latest = await api.radarRuns(group.id);
      const summary = latest.find((entry) => String(entry.id) === query.run) || latest[0];
      const next = summary ? await api.radarRun(summary.id) : null;
      if (!root.isConnected) return;
      runs = latest;
      updateRun(next);
      showFeedback();
      drawControls();
      drawReport();
    } catch (err) {
      showFeedback(err.message);
    } finally {
      pending = false;
      refreshButton.disabled = false;
      schedule();
    }
  }

  function showTopic(index) {
    const sourceRun = run;
    const problem = sourceRun?.result?.groups[index];
    if (!problem) return;
    dialog?.close();
    const topicHash = hrefFor(group.id, sourceRun.id, index);
    const reportHash = hrefFor(group.id, sourceRun.id);
    history.replaceState(history.state, "", topicHash);
    dialog = openSources(problem, () => {
      draftDialog = openInsight(problem, sourceRun);
      return false;
    }, () => {
      if (location.hash === topicHash) history.replaceState(history.state, "", reportHash);
    });
  }

  $("#radar-group", root).addEventListener("change", (event) => { location.hash = hrefFor(event.target.value); });
  results.addEventListener("click", (event) => {
    const button = event.target.closest("[data-radar-sources]");
    if (button) showTopic(Number(button.dataset.radarSources));
  });
  runSelect.addEventListener("change", (event) => { location.hash = hrefFor(group.id, event.target.value); });
  warningsButton.addEventListener("click", () => {
    if (run) warningsDialog = modal({
      title: "Предупреждения отчёта",
      body: warningsHtml(run),
      cancelText: "Закрыть",
    });
  });
  refreshButton.addEventListener("click", refresh);
  runButton.addEventListener("click", async () => {
    if (pending || !group) return;
    pending = true;
    const confirmed = await confirmDialog({
      title: "Запустить анализ жалоб?",
      body: `<p>Будет обработан набор <strong>${esc(group.id)}</strong> · ${fmtNum(group.count, 0)} ${plural(group.count, ["диалог", "диалога", "диалогов"])}. Результат появится в «Инсайтах».</p>`,
      okText: "Запустить анализ",
    });
    if (!confirmed || !root.isConnected) {
      pending = false;
      schedule();
      return;
    }
    busy(runButton, true, "Запускаем…");
    try {
      const next = await api.startRadar(group.id);
      if (!root.isConnected) return;
      query.run = String(next.id);
      history.replaceState(history.state, "", hrefFor(group.id, next.id));
      updateRun(next);
      showFeedback();
      drawReport();
    } catch (err) {
      showFeedback(err.message);
    } finally {
      pending = false;
      drawControls();
      schedule();
    }
  });

  updateRun(run);
  drawControls();
  drawReport();
  if (String(run?.id) === query.run && /^\d+$/.test(query.topic || "")) showTopic(Number(query.topic));
  schedule();
  return () => {
    clearTimeout(timer);
    draftDialog?.close();
    dialog?.close();
    warningsDialog?.close();
  };
}
