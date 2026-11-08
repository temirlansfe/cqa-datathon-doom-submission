import { api } from "../api.js";
import {
  esc, $, fmtNum, toast, busy, modal, LANG, CHANNEL,
  plural, debounce, icon, confirmDialog, answerView,
} from "../util.js";

const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
  del: (k) => { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};

// Survives navigation to a card and back.
const state = {
  group: store.get("cqa.group") || "", checklistId: null,
  lang: "", channel: "", status: "", q: "", criterion: "", outcome: "",
  view: store.get("cqa.conversations.view") === "criteria" ? "criteria" : "list",
  sort: { key: "id", dir: 1 },
};
let activePoll = null;

const LANG_ORDER = ["RU", "KZ", "EN"];
const VISIBLE_ROWS = 8;
const FILTER_LANG = { RU: "Русский", KZ: "Казахский", EN: "Английский" };
const FILTER_KEYS = ["group", "lang", "channel", "status", "criterion", "outcome"];
const selectFace = '<button type="button"><selectedcontent></selectedcontent></button>';
const supportsPopover = typeof HTMLElement.prototype.showPopover === "function";
const STATUS = [
  { v: "", label: "Все статусы" },
  { v: "none", label: "Не оценены", test: (r) => !r.eval_id },
  { v: "done", label: "Оценены", test: (r) => r.status === "done" },
  { v: "critical", label: "С грубой ошибкой", test: (r) => r.status === "done" && r.final_critical === "true" },
  { v: "appeal", label: "С апелляцией", test: (r) => Number(r.appeals) > 0 },
  { v: "error", label: "Ошибки оценки", test: (r) => r.status === "error" },
];
const chanIcon = (c) => icon(c === "voice call" ? "phone" : "chat");
const chanLabel = (c) => CHANNEL[c] || c || "—";
const searchText = (value) => value?.toLowerCase().replaceAll("ё", "е") || "";

export async function render(root) {
  clearInterval(activePoll);
  const [groups, checklists, meta] = await Promise.all([api.groups(), api.checklists(), api.meta().catch(() => null)]);
  const openImport = () => importDialog(onImported, meta?.dataset_api_configured);
  if (state.group && !groups.some((g) => g.id === state.group)) state.group = "";
  if (!checklists.some((c) => c.id === state.checklistId)) {
    state.checklistId = (checklists.find((c) => c.is_active) || checklists[0])?.id ?? null;
  }
  const multipleChecklists = new Set(checklists.map((c) => c.name)).size > 1;
  const checklistLabel = (c) => `${multipleChecklists ? `${c.name} · ` : ""}Версия ${c.version}`;
  const clName = (id) => {
    const c = checklists.find((x) => x.id === id);
    return c ? checklistLabel(c) : `#${id}`;
  };

  root.innerHTML = `<div class="conv-page">
    <header class="page-head">
      <div>
        <h1>Разговоры</h1>
        <div class="conv-overview" id="conv-overview" role="group" aria-label="Сводка разговоров" hidden></div>
      </div>
    </header>
    <div id="batch"></div>
    <section class="conv-journal" aria-label="Список разговоров">
      <div class="conv-tools">
        <div class="conv-query">
          <label class="input-icon f-search">${icon("search")}<span class="sr-only">Поиск разговоров</span>
            <input class="input" type="search" id="f-q" placeholder="Поиск разговоров…" value="${esc(state.q)}" autocomplete="off"></label>
          <button class="btn" type="button" id="btn-filters" aria-expanded="false" aria-controls="conv-filters">
            ${icon("filter")}Фильтры<span class="conv-filter-count" hidden></span>
          </button>
          <div class="conv-view-toggle" role="group" aria-label="Вид таблицы">
            <button class="btn" type="button" data-table-view="list" aria-pressed="${state.view === "list"}" aria-controls="table">${icon("list")}Список</button>
            <button class="btn" type="button" data-table-view="criteria" aria-pressed="${state.view === "criteria"}" aria-controls="table">${icon("table")}По критериям</button>
          </div>
        </div>
        <div class="conv-actions">
          <label class="sr-only" for="f-checklist">Чек-лист для оценки</label>
          <select class="input f-cl" id="f-checklist" ${checklists.length ? "" : "disabled"}>
            ${selectFace}
            ${checklists.map((c) => `<option value="${c.id}" ${c.id === state.checklistId ? "selected" : ""}>Чек-лист: ${esc(checklistLabel(c))}</option>`).join("")}
          </select>
          <button class="btn btn-primary" type="button" id="btn-batch">${icon("play")}Оценить новые</button>
          <details class="action-menu conv-more">
            <summary class="btn btn-ghost" aria-label="Дополнительные действия" title="Дополнительные действия">${icon("more")}</summary>
            <div class="action-menu-panel">
              <div class="conv-menu-label">Добавить диалоги</div>
              <button type="button" id="btn-upload">${icon("upload")}Загрузить файл</button>
              <button type="button" id="btn-import">${icon("cloud")}Импортировать из API</button>
              <button type="button" id="btn-rebatch">${icon("refresh")}Переоценить все</button>
            </div>
          </details>
        </div>
      </div>
      <div class="conv-filters" id="conv-filters" role="group" aria-label="Фильтры разговоров" hidden>
        <div class="field"><label for="f-group">Набор</label>
          <select class="input" id="f-group">
            ${selectFace}
            <option value="">Все наборы</option>
            ${groups.map((g) => `<option value="${esc(g.id)}" ${g.id === state.group ? "selected" : ""}>${esc(g.id)} (${g.count})</option>`).join("")}
          </select></div>
        <div class="field"><label for="f-lang">Язык</label><select class="input" id="f-lang"></select></div>
        <div class="field"><label for="f-channel">Канал</label><select class="input" id="f-channel"></select></div>
        <div class="field"><label for="f-status">Статус</label><select class="input" id="f-status"></select></div>
        <div class="field"><label for="f-criterion">Критерий</label><select class="input" id="f-criterion"></select></div>
        <div class="field"><label for="f-outcome">Результат по критерию</label>
          <select class="input" id="f-outcome" disabled>
            ${selectFace}
            <option value="">Все результаты</option>
            <option value="issue">Есть замечание</option>
            <option value="ok">Без замечаний</option>
            <option value="na">Не применимо (N/A)</option>
            <option value="missing">Нет результата</option>
          </select>
        </div>
      </div>
      <div class="conv-selection" id="conv-selection" hidden>
        <div class="conv-chips" id="conv-chips" aria-label="Активные фильтры" role="group" hidden></div>
        <span id="conv-matches" role="status"></span>
      </div>
      <div class="conv-results" id="table" role="region" aria-label="Результаты оценки разговоров"></div>
    </section></div>`;
  const page = root.firstElementChild;

  let rows = [];
  let checklistConfig, loadedChecklistId, loadedGroup;
  let loadId = 0;
  const criteria = () => checklistConfig?.criteria || [];
  const selectedCriterion = () => criteria().find((criterion) => criterion.id === state.criterion);
  const filtersActive = () => !!(state.lang || state.channel || state.status || state.outcome || state.q.trim());
  const filterToggle = $("#btn-filters", root);
  const filters = $("#conv-filters", root);
  const chips = $("#conv-chips", root);
  const results = $("#table", root);
  const tableSize = new ResizeObserver(([{ target }]) => {
    if (target.isConnected) fitVisibleRows(target);
    else tableSize.unobserve(target);
  });

  function fitVisibleRows(table) {
    const last = table.tBodies[0]?.rows[VISIBLE_ROWS - 1];
    if (!last) return;
    const height = last.getBoundingClientRect().bottom - table.getBoundingClientRect().top;
    results.style.setProperty("--journal-rows-height", `${Math.ceil(height) + 2}px`);
  }

  async function load(keepScroll = false) {
    const id = ++loadId;
    const { group, checklistId } = state;
    const [list, config] = await Promise.all([
      api.conversations({ group: group || null, checklist_id: checklistId, include_criteria: true }),
      checklistId && loadedChecklistId !== checklistId
        ? api.checklist(checklistId).then((checklist) => checklist.config)
        : checklistConfig,
    ]);
    if (id !== loadId || !page.isConnected) return;
    rows = list;
    checklistConfig = config;
    loadedChecklistId = checklistId;
    loadedGroup = group;
    if (!selectedCriterion()) state.criterion = state.outcome = "";
    loadFilters();
    drawCriterionFilters();
    draw(keepScroll);
  }

  function filtered() {
    const q = searchText(state.q.trim());
    const st = STATUS.find((s) => s.v === state.status);
    const criterion = selectedCriterion();
    return rows.filter((r) =>
      (!state.lang || r.language === state.lang) &&
      (!state.channel || r.channel === state.channel) &&
      (!st?.test || st.test(r)) &&
      (!criterion || !state.outcome || criterionResult(criterion, criterionScore(r, criterion)).outcome === state.outcome) &&
      (!q || searchText(r.id).includes(q) || searchText(r.title).includes(q)));
  }

  function sorted(list) {
    const { key, dir } = state.sort;
    const val = (r) => key === "score" ? (r.status === "done" ? Number(r.final_total) : null) : r.id;
    return [...list].sort((a, b) => {
      const x = val(a), y = val(b);
      if (x === null && y === null) return a.id.localeCompare(b.id);
      if (x === null) return 1; // not evaluated always last
      if (y === null) return -1;
      const c = typeof x === "string" ? x.localeCompare(y, "ru", { numeric: true }) : x - y;
      return c * dir || a.id.localeCompare(b.id);
    });
  }

  function draw(keepScroll = false) {
    const list = sorted(filtered());
    drawOverview();
    for (const key of ["group", "lang", "channel", "status"]) {
      const select = $(`#f-${key}`, root);
      select.value = state[key];
      select.toggleAttribute("data-active", !!state[key]);
    }
    drawActiveFilters(list.length);
    drawTable(list, keepScroll);
  }

  function drawOverview() {
    const overview = $("#conv-overview", root);
    overview.hidden = false;
    const done = rows.filter((r) => r.status === "done");
    const avg = done.length ? done.reduce((s, r) => s + Number(r.final_total || 0), 0) / done.length : null;
    const crit = done.filter((r) => r.final_critical === "true").length;
    const criticalOnly = state.status === "critical";
    overview.innerHTML = `
      <span><strong>${rows.length}</strong> ${plural(rows.length, ["разговор", "разговора", "разговоров"])}</span>
      <span>Средний балл <strong>${fmtNum(avg)}</strong></span>
      ${crit || criticalOnly
        ? `<button type="button" class="conv-critical" data-critical-filter aria-controls="table" aria-pressed="${criticalOnly}"
            title="${criticalOnly ? "Снять фильтр грубых ошибок" : "Показать разговоры с грубыми ошибками"}">
            <span><strong>${crit}</strong> с грубыми ошибками</span></button>`
        : '<span><strong>0</strong> с грубыми ошибками</span>'}`;
  }

  function drawActiveFilters(count) {
    const active = FILTER_KEYS.filter((key) => state[key]);
    const labels = {
      group: state.group,
      lang: FILTER_LANG[state.lang] || state.lang,
      channel: chanLabel(state.channel),
      status: STATUS.find((s) => s.v === state.status)?.label,
      criterion: selectedCriterion() ? shortCriterionTitle(selectedCriterion()) : "",
      outcome: $("#f-outcome", root).selectedOptions[0]?.textContent,
    };
    const filterCount = $(".conv-filter-count", filterToggle);
    filterCount.textContent = active.length;
    filterCount.hidden = !active.length;
    const focusedKey = chips.contains(document.activeElement) ? document.activeElement.dataset.removeFilter : null;
    chips.hidden = !active.length;
    chips.innerHTML = active.map((key) => `<button class="conv-chip" type="button" data-remove-filter="${key}" aria-label="Снять фильтр: ${esc(labels[key])}">
      ${esc(labels[key])}${icon("x")}</button>`).join("") +
      (active.length ? '<button class="btn-link" type="button" data-reset>Сбросить</button>' : "");
    if (focusedKey) ($(`[data-remove-filter="${focusedKey}"]`, chips) || $("[data-remove-filter]", chips) || filterToggle).focus();
    const searching = !!state.q.trim();
    $("#conv-selection", root).hidden = !active.length && !searching;
    $("#conv-matches", root).textContent = active.length || searching ? `Найдено: ${count}` : "";
  }

  function loadFilters() {
    const option = (v, label) => `<option value="${esc(v)}">${esc(label)}</option>`;
    const values = (field, selected) => [...new Set([...rows.map((r) => r[field]), selected].filter(Boolean))];
    const langs = values("language", state.lang)
      .sort((a, b) => (LANG_ORDER.indexOf(a) + 1 || 99) - (LANG_ORDER.indexOf(b) + 1 || 99) || a.localeCompare(b));
    const chans = values("channel", state.channel).sort();
    $("#f-lang", root).innerHTML = selectFace + option("", "Все языки") + langs.map((l) => option(l, FILTER_LANG[l] || l)).join("");
    $("#f-channel", root).innerHTML = selectFace + option("", "Все каналы") + chans.map((c) => option(c, chanLabel(c))).join("");
    $("#f-status", root).innerHTML = selectFace + STATUS.map((s) => option(s.v, s.label)).join("");
  }

  function drawCriterionFilters() {
    const options = criteria();
    const sections = checklistConfig?.sections || [];
    const option = (c) => `<option value="${esc(c.id)}">${esc(criterionName(c))}</option>`;
    const groups = sections.map((s) => {
      const members = options.filter((c) => c.section === s.id);
      return members.length ? `<optgroup label="${esc(s.title)}">${members.map(option).join("")}</optgroup>` : "";
    });
    const other = options.filter((c) => !sections.some((s) => s.id === c.section));
    const select = $("#f-criterion", root);
    select.innerHTML = `${selectFace}<option value="">Все критерии</option>${groups.join("")}${other.map(option).join("")}`;
    select.value = state.criterion;
    select.disabled = !options.length;
    syncOutcomeFilter();
  }

  function syncOutcomeFilter() {
    const select = $("#f-outcome", root);
    select.disabled = !state.criterion;
    select.value = state.outcome;
    select.toggleAttribute("data-active", !!state.outcome);
    $("#f-criterion", root).toggleAttribute("data-active", !!state.criterion);
  }

  function th(key, label, cls = "") {
    const on = state.sort.key === key;
    const aria = on ? (state.sort.dir > 0 ? "ascending" : "descending") : "none";
    return `<th role="columnheader" scope="col" class="${cls}" aria-sort="${aria}"><button type="button" class="th-sort" data-sort="${key}" ${on ? `data-dir="${state.sort.dir}"` : ""}>${label}<span class="arr" aria-hidden="true">${on ? (state.sort.dir > 0 ? "▲" : "▼") : "↕"}</span></button></th>`;
  }

  function drawTable(list, keepScroll = false) {
    const t = results;
    const scrollTop = keepScroll ? t.scrollTop : 0;
    tableSize.disconnect();
    t.style.removeProperty("--journal-rows-height");
    t.tabIndex = list.length ? 0 : -1;
    if (!rows.length) {
      t.innerHTML = `
        <div class="empty-state">
          <div class="ic">${icon("inbox")}</div>
          <h3>${state.group ? `В наборе ${esc(state.group)} нет диалогов` : "Диалогов пока нет"}</h3>
          <p>Импортируйте набор из API организаторов (group_id = DEV) или загрузите транскрипты в JSON.</p>
          <div class="row" style="justify-content:center">
            <button class="btn btn-primary" type="button" data-cta="import">${icon("cloud")}Импорт из API</button>
            <button class="btn" type="button" data-cta="upload">${icon("upload")}Загрузить JSON</button>
          </div>
        </div>`;
      return;
    }
    if (!list.length) {
      t.innerHTML = `
        <div class="empty-state">
          <div class="ic">${icon("filter")}</div>
          <h3>Ничего не найдено</h3>
          <p>Под выбранные фильтры не подходит ни один диалог.</p>
          <button class="btn" type="button" data-reset data-clear-search>Сбросить условия</button>
        </div>`;
      return;
    }
    const detailed = state.view === "criteria";
    const checklistCriteria = criteria();
    const columns = detailed ? checklistCriteria : [];
    const criteriaById = detailed ? null : new Map(checklistCriteria.map((criterion) => [criterion.id, criterion]));
    t.innerHTML = `
      <table class="table conv-table${detailed ? "" : " is-list"}${columns.length > 10 ? " is-stacked" : ""}" role="table" aria-label="Разговоры и результаты оценки">
        <colgroup><col class="conv-name-col">${detailed ? columns.map(() => "<col>").join("") : "<col>"}<col class="conv-total-col"></colgroup>
        <thead role="rowgroup"><tr role="row">
          ${th("id", "Разговор", "id-cell")}
          ${detailed ? "" : '<th role="columnheader" scope="col" class="conv-list-notes">Замечания</th>'}
          ${columns.map((c) => `<th role="columnheader" scope="col" class="criterion-col${c.id === state.criterion ? " is-selected" : ""}" title="${esc(criterionName(c))}" aria-label="${esc(criterionName(c))}">
            <span class="criterion-code" aria-hidden="true">${c.code ? esc(criterionCode(c)) : ""}</span>
            <span class="criterion-title">${esc(shortCriterionTitle(c))}</span>
          </th>`).join("")}
          ${th("score", "Оценка", "num")}
        </tr></thead>
        <tbody role="rowgroup">
          ${list.map((r, index) => `
            <tr role="row" class="click" data-id="${esc(r.id)}" data-href="${esc(cardHref(r))}">
              <td role="cell" class="id-cell"><div class="conv-dialog-info">${conversationCell(r)}</div></td>
              ${detailed ? "" : `<td role="cell" class="conv-list-notes">${listNotes(r, criteriaById, `conv-notes-${index}`)}</td>`}
              ${columns.map((c) => `<td role="cell" class="criterion-col">
                <span class="conv-cell-label" title="${esc(criterionName(c))}">${c.code ? `${esc(criterionCode(c))} · ` : ""}${esc(shortCriterionTitle(c))}</span>
                ${criterionCell(r, c)}</td>`).join("")}
              <td role="cell" class="num conv-total">${scoreCell(r)}<span class="conv-row-arrow" aria-hidden="true">${icon("chev")}</span></td>
            </tr>`).join("")}
        </tbody>
      </table>`;
    const table = t.firstElementChild;
    if (list.length > VISIBLE_ROWS) {
      fitVisibleRows(table);
      tableSize.observe(table);
    }
    t.scrollTo({ top: scrollTop, behavior: "instant" });
  }

  function resetFilters(clearSearch) {
    const hadGroup = !!state.group;
    for (const key of FILTER_KEYS) state[key] = "";
    if (clearSearch) {
      state.q = "";
      $("#f-q", root).value = "";
    }
    $("#f-criterion", root).value = "";
    syncOutcomeFilter();
    if (hadGroup) { store.del("cqa.group"); load(); }
    else draw();
  }

  function removeFilter(key) {
    state[key] = "";
    if (key === "criterion") {
      state.outcome = "";
      $("#f-criterion", root).value = "";
    }
    syncOutcomeFilter();
    if (key === "group") { store.del("cqa.group"); load(); }
    else draw();
  }

  function toggleFilters(open) {
    filters.hidden = !open;
    filterToggle.setAttribute("aria-expanded", String(open));
  }

  // ---- events
  filterToggle.addEventListener("click", () => {
    toggleFilters(filters.hidden);
    if (!filters.hidden) $("#f-group", root).focus();
  });
  filters.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || (CSS.supports("selector(select:open)") && e.target.matches("select:open"))) return;
    toggleFilters(false);
    filterToggle.focus();
  });
  page.addEventListener("click", (e) => {
    const viewButton = e.target.closest("[data-table-view]");
    if (viewButton) {
      const view = viewButton.dataset.tableView;
      if (view === state.view) return;
      state.view = view;
      store.set("cqa.conversations.view", view);
      for (const button of page.querySelectorAll("[data-table-view]")) {
        button.setAttribute("aria-pressed", String(button === viewButton));
      }
      drawTable(sorted(filtered()));
      return;
    }
    const sortBtn = e.target.closest("[data-sort]");
    if (sortBtn) {
      const key = sortBtn.dataset.sort;
      state.sort = state.sort.key === key ? { key, dir: -state.sort.dir } : { key, dir: key === "score" ? -1 : 1 };
      draw();
      root.querySelector(`[data-sort="${key}"]`)?.focus();
      return;
    }
    const chip = e.target.closest("[data-remove-filter]");
    if (chip) { removeFilter(chip.dataset.removeFilter); return; }
    const reset = e.target.closest("[data-reset]");
    if (reset) { resetFilters(reset.hasAttribute("data-clear-search")); filterToggle.focus(); return; }
    if (e.target.closest("[data-critical-filter]")) {
      state.status = state.status === "critical" ? "" : "critical";
      draw();
      ($("[data-critical-filter]", root) || filterToggle).focus();
      return;
    }
    const cta = e.target.closest("[data-cta]");
    if (cta) {
      if (cta.dataset.cta === "import") openImport();
      else uploadDialog(onImported);
      return;
    }
    const tr = e.target.closest("tr[data-href]");
    if (tr && !e.defaultPrevented && !e.target.closest("a, button, .conv-notes-popover")
        && window.getSelection()?.isCollapsed !== false) {
      location.hash = tr.dataset.href;
    }
  });
  $("#f-group", root).addEventListener("change", (e) => {
    state.group = e.target.value;
    store.set("cqa.group", state.group);
    load();
  });
  $("#f-checklist", root).addEventListener("change", (e) => { state.checklistId = Number(e.target.value); load(); });
  for (const key of ["lang", "channel", "status"]) {
    $(`#f-${key}`, root).addEventListener("change", (e) => { state[key] = e.target.value; draw(); });
  }
  $("#f-criterion", root).addEventListener("change", (e) => {
    state.criterion = e.target.value;
    state.outcome = "";
    syncOutcomeFilter();
    draw();
  });
  $("#f-outcome", root).addEventListener("change", (e) => {
    state.outcome = e.target.value;
    syncOutcomeFilter();
    draw();
  });
  const onSearch = debounce(() => draw(), 120);
  $("#f-q", root).addEventListener("input", (e) => { state.q = e.target.value; onSearch(); });

  function closeActionMenu(button) {
    const menu = button.closest(".action-menu");
    menu.open = false;
    $("summary", menu).focus();
  }
  $("#btn-import", root).addEventListener("click", (e) => {
    closeActionMenu(e.currentTarget);
    openImport();
  });
  $("#btn-upload", root).addEventListener("click", (e) => {
    closeActionMenu(e.currentTarget);
    uploadDialog(onImported);
  });
  function onImported(res) {
    toast(`Импортировано ${res.imported} ${plural(res.imported, ["диалог", "диалога", "диалогов"])} в набор ${res.group}. Нажмите «Оценить новые», чтобы запустить оценку.`);
    state.group = res.group;
    store.set("cqa.group", res.group);
    tableSize.disconnect();
    render(root);
  }

  // ---- batches
  let costPromise = null;
  const avgCost = () => (costPromise ||= api.stats({ checklist_id: state.checklistId }).then((s) => s.avg_cost_usd).catch(() => null));

  async function startBatch(onlyMissing, btn) {
    if (loadedChecklistId !== state.checklistId || loadedGroup !== state.group) return;
    const scoped = filtersActive();
    const scope = scoped ? filtered() : rows;
    const targets = onlyMissing ? scope.filter((r) => !r.eval_id || r.status === "error") : scope;
    if (!targets.length) {
      toast(onlyMissing ? "Нет новых диалогов: все уже оценены этим чек-листом" : "Нет диалогов для оценки");
      return;
    }
    const cost = await avgCost();
    const n = targets.length;
    const ok = await confirmDialog({
      title: onlyMissing ? "Оценить новые диалоги" : "Переоценить все диалоги",
      okText: `Оценить ${n} ${plural(n, ["диалог", "диалога", "диалогов"])}`,
      body: `
        <dl class="cost-list">
          <dt>Чек-лист</dt><dd>${esc(clName(state.checklistId))}</dd>
          <dt>Набор</dt><dd>${esc(state.group || "все наборы")}</dd>
          <dt>Диалогов к оценке</dt><dd>${n}</dd>
          ${cost ? `<dt>Ориентировочная стоимость</dt><dd>≈ $${fmtNum(cost * n, 3)}</dd>` : ""}
        </dl>
        ${scoped ? `<div class="note warn">Учитываются активные фильтры: будут оценены только показанные диалоги.</div>` : ""}
        <div class="note">${onlyMissing ? "Оценка идёт в фоне, прогресс и стоимость будут видны над таблицей." : "Каждый диалог будет оценён заново. Предыдущие оценки сохранятся в истории."}</div>`,
    });
    if (!ok) return;
    busy(btn, true, "Запуск…");
    try {
      const body = { group: state.group || null, checklist_id: state.checklistId, only_missing: onlyMissing };
      if (scoped) body.conversation_ids = scope.map((r) => r.id);
      const b = await api.batch(body);
      if (!b.total) { toast("Нет диалогов для оценки"); return; }
      toast(`Запущена оценка ${b.total} ${plural(b.total, ["диалога", "диалогов", "диалогов"])}`);
      trackBatch(b.id);
    } catch (e) { toast(e.message, true); } finally { busy(btn, false); }
  }

  function trackBatch(id) {
    clearInterval(activePoll);
    const box = $("#batch", root);
    let first = true, t0 = null, d0 = 0;
    const tick = async () => {
      let b;
      try { b = await api.batchStatus(id); } catch { clearInterval(activePoll); store.del("cqa.batch"); return; }
      if (!root.isConnected) { clearInterval(activePoll); return; }
      const processed = Number(b.done) + Number(b.failed);
      const running = b.status === "running";
      if (first) {
        first = false;
        // Show the rows of the batch's checklist/group so statuses move live.
        let switched = false;
        if (b.checklist_id && b.checklist_id !== state.checklistId && checklists.some((c) => c.id === b.checklist_id)) {
          state.checklistId = b.checklist_id; $("#f-checklist", root).value = String(b.checklist_id); switched = true;
        }
        if (b.dataset_group && b.dataset_group !== state.group && groups.some((g) => g.id === b.dataset_group)) {
          state.group = b.dataset_group; store.set("cqa.group", state.group); $("#f-group", root).value = state.group; switched = true;
        }
        if (switched) costPromise = null;
        t0 = Date.now(); d0 = processed;
      }
      box.innerHTML = batchPanel(b, { clName, eta: running ? eta(t0, d0, processed, b.total) : null });
      if (!running) {
        clearInterval(activePoll);
        if (store.get("cqa.batch") === String(id)) {
          store.del("cqa.batch");
          toast(`Пакет #${b.id} завершён: ${b.done} ${plural(b.done, ["оценка", "оценки", "оценок"])}${b.failed ? `, ошибок: ${b.failed}` : ""}`, !!b.failed && !b.done);
        }
      }
      await load(true);
    };
    store.set("cqa.batch", String(id));
    tick();
    activePoll = setInterval(tick, 2500);
  }
  $("#batch", root).addEventListener("click", (e) => {
    if (e.target.closest("[data-hide-batch]")) $("#batch", root).innerHTML = "";
  });
  $("#btn-batch", root).addEventListener("click", (e) => startBatch(true, e.currentTarget));
  $("#btn-rebatch", root).addEventListener("click", (e) => {
    closeActionMenu(e.currentTarget);
    startBatch(false, e.currentTarget);
  });

  await load();
  const running = store.get("cqa.batch");
  if (running) trackBatch(Number(running));
  return () => {
    clearInterval(activePoll);
    tableSize.disconnect();
  };
}

function eta(t0, d0, processed, total) {
  const elapsed = (Date.now() - t0) / 1000, doneNow = processed - d0;
  if (doneNow < 1 || elapsed < 3) return null;
  const left = ((total - processed) * elapsed) / doneNow;
  return left < 60 ? "меньше минуты" : `≈ ${Math.round(left / 60)} мин`;
}

function duration(a, b) {
  if (!a || !b) return null;
  const s = Math.max(0, Math.round((Date.parse(b) - Date.parse(a)) / 1000));
  return s < 60 ? `${s} с` : `${Math.floor(s / 60)} мин ${s % 60} с`;
}

function batchPanel(b, { clName, eta: etaText }) {
  const total = Number(b.total) || 0, done = Number(b.done) || 0, failed = Number(b.failed) || 0;
  const running = b.status === "running";
  const p = total ? Math.round(((done + failed) / total) * 100) : 100;
  const took = !running ? duration(b.created_at, b.finished_at) : null;
  return `
    <div class="card batch-panel ${running ? "is-running" : "is-done"} ${failed ? "has-fail" : ""}" role="status">
      <div class="bp-ic">${running ? '<span class="spinner" aria-hidden="true"></span>' : icon(failed ? "alert" : "check")}</div>
      <div class="bp-title">
        <b>${running ? "Идёт оценка" : "Оценка завершена"} · пакет #${esc(b.id)}</b>
        <span class="muted small">${esc(clName(b.checklist_id))}${b.dataset_group ? ` · набор ${esc(b.dataset_group)}` : ""}</span>
      </div>
      <div class="bp-pct">${p}%${!running ? `<button class="btn btn-sm btn-ghost" type="button" data-hide-batch aria-label="Скрыть панель пакета">${icon("x")}</button>` : ""}</div>
      <div class="bp-bar" role="progressbar" aria-label="Прогресс пакета" aria-valuemin="0" aria-valuemax="${total}" aria-valuenow="${done + failed}">
        ${done ? `<i style="width:${(done / Math.max(total, 1)) * 100}%" title="Оценено: ${done}"></i>` : ""}
        ${failed ? `<i class="f" style="width:${(failed / Math.max(total, 1)) * 100}%" title="Ошибок: ${failed}"></i>` : ""}
      </div>
      <div class="bp-stats" style="grid-column:2">
        <span>Оценено <b>${done}</b> из <b>${total}</b></span>
        ${failed ? `<span style="color:var(--bad)">Ошибок <b style="color:inherit">${failed}</b></span>` : ""}
        <span>Стоимость <b>$${fmtNum(b.cost_usd, 4)}</b>${done ? ` <span class="muted">(≈ $${fmtNum(Number(b.cost_usd) / done, 4)} за диалог)</span>` : ""}</span>
        ${running && etaText ? `<span>Осталось <b>${etaText}</b></span>` : ""}
        ${took ? `<span>Время <b>${took}</b></span>` : ""}
      </div>
    </div>`;
}

function conversationCell(r) {
  const title = r.title?.trim();
  const appeal = Number(r.open_appeals) ? `<span class="badge warn">Апелляция открыта</span>`
    : Number(r.appeals) ? `<span class="badge outline">${icon("scale")}Апелляция</span>` : "";
  return `<a href="${cardHref(r)}"${title ? ` title="${esc(title)}"` : ""}>${esc(title || r.id)}</a>
    <div class="conv-row-meta">
      ${title ? `<span class="conv-row-id">${esc(r.id)}</span>` : ""}
      <span class="chan">${chanIcon(r.channel)}${esc(chanLabel(r.channel))}</span>
      <span class="lang" title="${esc(LANG[r.language] || r.language || "")}">${esc(r.language || "—")}</span>
      ${statusBadge(r)}${appeal}
    </div>`;
}

function scoreCell(r) {
  if (r.status !== "done") return `<span class="muted">—</span>`;
  const fin = r.final_total, orig = r.total;
  const changed = fin !== null && orig !== null && Number(fin) !== Number(orig);
  const title = `Оценка ${fmtNum(fin)} из 100${changed ? ` (до апелляции ${fmtNum(orig)})` : ""}`;
  return `<span class="conv-total-score" title="${esc(title)}">
    ${changed ? `<span class="strike">${fmtNum(orig)}</span>` : ""}
    <span class="score-pill">${fmtNum(fin)}</span></span>`;
}

function listNotes(row, criteriaById, popoverId) {
  if (row.status !== "done") return '<span class="muted">—</span>';
  const critical = row.final_critical === "true"
    ? `<span class="conv-criterion-score is-no is-critical">${icon("alert")}Грубая ошибка</span>`
    : "";
  const deductions = [];
  for (const score of row.criterion_scores || []) {
    const criterion = criteriaById.get(score.criterion_id);
    if (!criterion || criterion.type === "critical" || score.answer == null || score.answer === "na") continue;
    const loss = scoreLoss(score);
    if (loss <= 0.001) continue;
    deductions.push({ criterion, score, loss });
  }
  deductions.sort((a, b) => b.loss - a.loss);
  if (!deductions.length && !critical) return '<span class="muted">—</span>';
  const finding = deductions[0] ? deductionLink(row, deductions[0]) : "";
  const more = deductions.length > 1 ? moreNotes(row, deductions, popoverId) : "";
  return `<div class="conv-list-findings">${critical}${finding}${more}</div>`;
}

function deductionLink(row, { criterion, score, loss }) {
  const result = criterionResult(criterion, score);
  return `<a class="conv-list-finding" href="${esc(criterionHref(row, criterion))}"
      title="${esc(criterion.title)} — снято баллов: ${fmtNum(loss)}">
      <span>${esc(shortCriterionTitle(criterion))}</span><span class="conv-criterion-score is-${result.kind}">${esc(result.label)}</span>
    </a>`;
}

function moreNotes(row, deductions, id) {
  const remaining = deductions.length - 1;
  const unit = plural(remaining, ["замечание", "замечания", "замечаний"]);
  const label = `Ещё ${remaining} ${unit}`;
  const text = `ещё ${remaining}<span class="conv-more-unit"> ${unit}</span>`;
  const details = esc(cardHref(row, { section: "deductions" }));
  if (!supportsPopover) return `<a class="conv-list-more" href="${details}" aria-label="${label}">${text}</a>`;
  return `<button type="button" class="conv-list-more" popovertarget="${id}" aria-label="${label}">${text}</button>
    <div class="conv-notes-popover" id="${id}" popover="auto" role="region" aria-labelledby="${id}-title">
      <div class="conv-notes-title" id="${id}-title">Замечания · ${esc(row.id)}</div>
      <ul>${deductions.map((item) => `<li>${deductionLink(row, item)}</li>`).join("")}</ul>
      <a class="conv-notes-details" href="${details}">Открыть разбор</a>
    </div>`;
}

const SHORT_CRITERION_TITLES = new Map([
  ["Установление контакта", "Контакт"],
  ["Выявление потребности", "Потребность"],
  ["Корректная и полная консультация", "Консультация"],
  ["Эмпатия и клиентоориентированность", "Эмпатия"],
  ["Управление диалогом, скорость и грамотность", "Ведение диалога"],
]);
const shortCriterionTitle = (criterion) => SHORT_CRITERION_TITLES.get(criterion.title) || criterion.title;
const criterionCode = (criterion) => String(criterion.code).replace(/^0+(?=\d+$)/, "");
const criterionName = (criterion) => criterion.code ? `${criterionCode(criterion)} · ${criterion.title}` : criterion.title;
const criterionScore = (row, criterion) => row.criterion_scores?.find((score) => score.criterion_id === criterion.id);
const scoreLoss = (score) => score.points == null || score.max_points == null ? 0 : score.max_points - score.points;
const criterionHref = (row, criterion) => cardHref(row, { crit: criterion.id });

function criterionResult(criterion, score) {
  if (score?.answer == null) return { outcome: "missing", kind: "missing", label: "—", detail: "Нет результата" };
  const answer = answerView(criterion, score.answer);
  if (answer.kind === "na") return { outcome: "na", kind: "na", label: answer.label, detail: "Не применимо (N/A)" };
  const scored = score.points != null && score.max_points != null;
  const loss = scoreLoss(score);
  const deducted = loss > 0.001;
  const points = scored ? `${fmtNum(score.points)} из ${fmtNum(score.max_points)}` : null;
  return {
    outcome: answer.kind === "yes" ? "ok" : "issue",
    kind: deducted ? (Number(score.points) > 0 ? "part" : "no") : answer.kind,
    label: deducted ? `−${fmtNum(loss)}` : scored && answer.kind === "yes" ? "✓" : answer.label,
    detail: scored
      ? `${deducted ? `Снято баллов: ${fmtNum(loss)}. ` : ""}Начислено: ${points}`
      : answer.label,
  };
}

function criterionCell(row, criterion) {
  const result = criterionResult(criterion, criterionScore(row, criterion));
  if (result.outcome === "missing") return '<span class="muted" aria-label="Нет результата">—</span>';
  const label = esc(`${criterionName(criterion)} — ${result.detail}`);
  const href = criterionHref(row, criterion);
  const critical = criterion.type === "critical" && result.kind === "no";
  return `<a class="conv-criterion-score is-${result.kind}${critical ? " is-critical" : ""}" href="${esc(href)}" title="${label}" aria-label="${label}">${critical ? icon("alert") : ""}${esc(result.label)}</a>`;
}

function statusBadge(r) {
  if (!r.eval_id) return `<span class="badge na">Не оценён</span>`;
  if (r.status === "done") return "";
  if (r.status === "error") return `<span class="badge no" title="${esc(r.error || "")}">Ошибка оценки</span>`;
  return `<span class="badge warn"><span class="spinner" style="width:10px;height:10px" aria-hidden="true"></span>${r.status === "running" ? "Оценивается" : "В очереди"}</span>`;
}

function importDialog(done, configured) {
  const m = modal({
    title: "Импорт набора из API организаторов",
    submitText: "Импортировать",
    body: `
      <label class="field">Код набора
        <input class="input" id="imp-group" value="DEV" placeholder="DEV" autocomplete="off" aria-describedby="imp-group-help" required>
        <span class="hint" id="imp-group-help">Для учебного набора используйте DEV.</span>
      </label>
      <details class="more" ${configured === false ? "open" : ""}>
        <summary>${configured ? "Указать другой адрес API" : "Ссылка на API организаторов"}</summary>
        <label class="field">Адрес API
          <input class="input" id="imp-url" type="password" placeholder="https://…" autocomplete="off" spellcheck="false" aria-describedby="imp-url-help">
          <span class="hint" id="imp-url-help">${configured ? "Если оставить поле пустым, используем настроенное подключение." : "Вставьте полную ссылку из гайда организаторов."}</span>
        </label>
      </details>
      <div class="note">Повторный импорт обновит транскрипты и сохранит оценки.</div>
      <div class="import-error" id="imp-error" role="alert" hidden></div>`,
    onSubmit: async (el) => {
      const group = $("#imp-group", el);
      const url = $("#imp-url", el);
      const error = $("#imp-error", el);
      const g = group.value.trim();
      const address = url.value.trim();
      error.hidden = true;
      const showError = (message, field) => {
        error.textContent = message;
        error.hidden = false;
        if (field) {
          if (field === url) url.closest("details").open = true;
          field.setAttribute("aria-invalid", "true");
          field.setAttribute("aria-errormessage", error.id);
          field.focus();
        }
        return false;
      };
      if (!g) return showError("Укажите код набора.", group);
      if (configured === false && !address) return showError("Вставьте ссылку из гайда организаторов.", url);
      if (address && !/^https?:\/\//i.test(address)) return showError("Ссылка должна начинаться с https:// или http://.", url);
      const ok = $("[data-ok]", el);
      busy(ok, true, "Импорт…");
      let result;
      try {
        result = await api.importGroup(g, address);
      } catch (e) {
        return showError(e instanceof TypeError ? "Нет связи с сервером. Попробуйте ещё раз." : e.message);
      } finally { busy(ok, false); }
      done(result);
    },
  });
  m.el.addEventListener("input", (e) => {
    e.target.removeAttribute("aria-invalid");
    e.target.removeAttribute("aria-errormessage");
    $("#imp-error", m.el).hidden = true;
  });
  $("#imp-group", m.el).select();
}

function countRecords(o) {
  if (o && typeof o === "object" && !Array.isArray(o) && "isSuccess" in o) o = o.data || {};
  if (o && Array.isArray(o.records)) return { n: o.records.length, group: o.dataset_group_id || "" };
  if (Array.isArray(o)) return { n: o.length, group: "" };
  if (o && typeof o === "object" && "transcript" in o) return { n: 1, group: "" };
  return { n: 0, group: "" };
}

export function uploadDialog(done) {
  let fileText = null;
  const m = modal({
    title: "Загрузить транскрипты",
    submitText: "Загрузить",
    body: `
      <label class="dropzone" id="up-drop">
        <input type="file" id="up-file" accept=".json,application/json">
        ${icon("upload")}
        <span id="up-drop-text"><b>Перетащите JSON-файл сюда</b> или нажмите, чтобы выбрать</span>
        <span class="muted small" id="up-drop-info">Полный ответ API, объект <code>data</code>, массив записей или одна запись</span>
      </label>
      <div class="or-sep">или вставьте JSON</div>
      <label class="field"><span class="sr-only">JSON</span>
        <textarea class="input mono" id="up-text" rows="6" placeholder='{"conversation_id":"demo-1","channel":"agent chat","language":"RU","transcript":[{"timestamp":"00:02","speaker":"operator","text":"Здравствуйте!"}]}'></textarea></label>
      <label class="field">Набор (group) <span class="hint">необязательно; по умолчанию из файла или UPLOAD</span>
        <input class="input" id="up-group" placeholder="UPLOAD" autocomplete="off"></label>`,
    onSubmit: async (el) => {
      const text = fileText ?? $("#up-text", el).value.trim();
      if (!text) throw new Error("Выберите файл или вставьте JSON");
      try { JSON.parse(text); } catch { throw new Error("Это не корректный JSON — проверьте файл"); }
      const ok = $("[data-ok]", el);
      busy(ok, true, "Загрузка…");
      try {
        done(await api.upload(text, $("#up-group", el).value.trim() || null));
      } finally { busy(ok, false); }
    },
  });
  const el = m.el, drop = $("#up-drop", el), info = $("#up-drop-info", el), dtext = $("#up-drop-text", el);
  async function useFile(f) {
    if (!f) return;
    const text = await f.text();
    let summary;
    try {
      const { n, group } = countRecords(JSON.parse(text));
      summary = n ? `Найдено записей: <b>${n}</b>${group ? ` · набор ${esc(group)}` : ""}` : `<span style="color:var(--bad)">Записи не найдены — проверьте формат</span>`;
      if (group && !$("#up-group", el).value) $("#up-group", el).placeholder = group;
    } catch {
      summary = `<span style="color:var(--bad)">Файл не является корректным JSON</span>`;
    }
    fileText = text;
    drop.classList.add("has-file");
    dtext.innerHTML = `<b>${esc(f.name)}</b> · ${fmtNum(f.size / 1024, 1)} КБ`;
    info.innerHTML = `${summary} · <button type="button" class="btn-link" data-clear>убрать</button>`;
  }
  $("#up-file", el).addEventListener("change", (e) => useFile(e.target.files[0]));
  ["dragenter", "dragover"].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add("over"); }));
  ["dragleave", "drop"].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
  drop.addEventListener("drop", (e) => useFile(e.dataTransfer.files[0]));
  drop.addEventListener("click", (e) => {
    if (!e.target.closest("[data-clear]")) return;
    e.preventDefault();
    fileText = null;
    $("#up-file", el).value = "";
    drop.classList.remove("has-file");
    dtext.innerHTML = `<b>Перетащите JSON-файл сюда</b> или нажмите, чтобы выбрать`;
    info.innerHTML = `Полный ответ API, объект <code>data</code>, массив записей или одна запись`;
  });
}

// Open the card on the evaluation the row shows (the list is filtered by checklist version).
function cardHref(row, params = {}) {
  const query = new URLSearchParams(row.eval_id ? { eval: row.eval_id, ...params } : params).toString();
  return `#/conversation/${encodeURIComponent(row.id)}${query ? `?${query}` : ""}`;
}
