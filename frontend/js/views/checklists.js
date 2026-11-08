import { api } from "../api.js";
import {
  esc, $, $$, fmtNum, toast, busy, modal, TYPE_LABEL,
  plural, icon, confirmDialog, watchMenuSpace,
} from "../util.js";
import { latestRuleChecklist, openRuleProposal, sameRule, versionSources } from "../rule-proposal.js";

let draft = null;            // config being edited
let base = null;             // config of the version being edited (null for a new checklist)
let openSet = new Set();     // expanded criterion objects

const TYPE_SHORT = { binary: "Да / Нет", scale: "Шкала", critical: "Грубая ошибка" };
const FIELD = {
  id: "ID", code: "Код", title: "Название", section: "Секция", type: "Тип ответа", weight: "Вес",
  na_allowed: "N/A разрешён", description: "Формулировка", guidance: "Уточнения для оценки",
  na_condition: "Условие N/A", scale: "Шкала",
};
const LONG_FIELDS = new Set(["description", "guidance", "na_condition", "general_rules"]);
const displayCode = (code) => String(code || "").replace(/^0+(?=\d+$)/, "");

const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
};

let offUnload = null;
let leavePrompt = null;

export function hasUnsavedChanges() {
  return isDirty();
}

export async function confirmLeave() {
  if (!isDirty()) return true;
  leavePrompt ??= confirmDialog({
    title: "Несохранённые изменения",
    body: "<p>Если уйти сейчас, правки чек-листа будут потеряны.</p>",
    cancelText: "Продолжить редактирование",
    okText: "Уйти без сохранения", danger: true,
  }).finally(() => { leavePrompt = null; });
  return leavePrompt;
}

export async function render(root, params, query = {}) {
  if (offUnload) { offUnload(); offUnload = null; }
  const [list, appealDetail] = await Promise.all([
    api.checklists(), /^\d+$/.test(query.appeal || "") ? api.appeal(Number(query.appeal)) : null,
  ]);
  const feedback = appealDetail?.appeal.status !== "open" ? appealDetail : null;
  const family = feedback ? list.filter((c) => c.name === feedback.evaluation.checklist_name) : [];
  let current;
  if (params.id === "new") {
    current = { id: null, config: blankConfig(), version: null, is_active: false };
  } else {
    const id = params.id ? Number(params.id) : (family[0] || list.find((c) => c.is_active) || list[0])?.id;
    current = id ? await api.checklist(id) : { id: null, config: blankConfig() };
  }
  if (!root.isConnected) return;
  draft = structuredClone(current.config);
  draft.sections ||= [];
  draft.criteria ||= [];
  base = current.id ? structuredClone(current.config) : null;
  openSet = new Set();
  const selectedVersion = list.find((version) => version.id === current.id);
  const multipleChecklists = new Set(list.map((version) => version.name)).size > 1;
  const source = family.some((c) => c.id === current.id) ? feedback.appeal : null;
  const linkedRule = source && versionSources(current).appealIds.includes(source.id);
  const target = draft.criteria.find((c) => c.id === (query.criterion || source?.criterion_id));
  if (target) openSet.add(target);
  const conversation = query.conversation || (source ? feedback.conversation.id : "");
  const comparison = query.eval || (source ? feedback.evaluation.id : null);
  const earlierVersion = list.filter((c) => c.name === current.config.name && c.version < current.version)
    .sort((a, b) => b.version - a.version)[0];
  const ruleCheckQuery = target ? `?${new URLSearchParams({ criterion: target.id })}` : "";
  const editorParams = new URLSearchParams();
  if (query.conversation) editorParams.set("conversation", query.conversation);
  if (query.eval) editorParams.set("eval", query.eval);
  if (feedback) editorParams.set("appeal", feedback.appeal.id);
  if (query.criterion) editorParams.set("criterion", query.criterion);
  const editorQuery = editorParams.size ? `?${editorParams}` : "";
  const returnToDialog = (kid) => {
    const q = new URLSearchParams({ checklist: kid });
    if (comparison) q.set("eval", comparison);
    if (target) q.set("crit", target.id);
    return `#/conversation/${encodeURIComponent(conversation)}?${q}`;
  };
  const checkRule = current.id && earlierVersion
    ? `<a class="btn btn-primary" id="btn-rule-check" href="#/checklists/${current.id}/rule-check${esc(ruleCheckQuery)}">${icon("check")}Сравнить версии правила</a>` : "";
  const apply = current.id
    ? `<button class="btn${checkRule ? "" : " btn-primary"}" type="button" id="btn-apply">${icon("play")}Применить к набору…</button>` : "";

  const versionInfo = (label, id) => `<details class="action-menu cl-info" hidden>
    <summary class="btn${id === "cl-changes" ? " btn-primary" : ""}">${label}</summary>
    <div class="action-menu-panel cl-info-panel" role="region" aria-label="${label}" tabindex="0"><div id="${id}"></div></div>
  </details>`;
  const contextInfo = source || conversation ? `<details class="action-menu cl-info">
    <summary class="btn">${source ? `Апелляция №${source.id}` : "Связанный диалог"}</summary>
    <div class="action-menu-panel cl-info-panel" tabindex="0"><div>
      ${source ? `
        <a class="cl-context-link" href="#/appeals/${source.id}">Открыть апелляцию №${source.id}</a>
        <p>${esc(source.reason)}</p>
        ${linkedRule ? "" : `<p>${target ? "Сформулируйте общее правило для похожих диалогов и сохраните новую версию." : "Спорного критерия нет в этой версии. Выберите подходящую версию в редакторе."}</p>`}
        ${target ? '<button type="button" class="btn" id="focus-feedback-rule">К уточнению</button>' : ""}
      ` : `
        <b>Новые правила для диалога ${esc(conversation)}</b>
        <p>Сохраните версию, затем вернитесь к разговору и переоцените его.</p>
        <a class="btn" href="${esc(returnToDialog(current.id || ""))}" id="return-dialog">К диалогу</a>
      `}
    </div></div>
  </details>` : "";

  root.innerHTML = `<div class="journal-page cl-page">
    <header class="journal-page-head">
      <div class="page-head">
        <div>
          <h1>${current.id ? "Чек-листы" : "Новый чек-лист"}</h1>
          ${current.id ? `<div class="cl-name">${esc(current.config.name)}</div>` : ""}
        </div>
        ${current.id ? `<div class="spacer"></div>
          <div class="page-actions"><a class="btn btn-primary" href="#/checklists/new${esc(editorQuery)}">${icon("plus")}Новый чек-лист</a></div>` : ""}
      </div>
      <div class="cl-toolbar">
        <div class="cl-tools">
          ${list.length ? `<div class="cl-version">
            <label class="sr-only" for="cl-version">Версия чек-листа</label>
            <select class="input" id="cl-version">
              ${selectedVersion ? "" : '<option value="" selected disabled>Выберите версию</option>'}
              ${list.map((version) => `<option value="${version.id}" ${version === selectedVersion ? "selected" : ""}>${multipleChecklists ? `${esc(version.name)} · ` : ""}Version ${esc(version.version)}${version.is_active ? " (активная)" : ""}</option>`).join("")}
            </select>
            ${selectedVersion ? `<span>${selectedVersion.evaluated_conversations} ${plural(selectedVersion.evaluated_conversations, ["диалог", "диалога", "диалогов"])} с оценкой</span>` : ""}
          </div>` : ""}
          ${current.id ? versionInfo("Изменения в версии", "cl-changes") + versionInfo("Предложения по правилам", "rule-suggestions") : ""}
          ${contextInfo}
        </div>
        <div class="cl-actions">
          ${checkRule || apply}
          ${current.id && !current.is_active ? `<button class="btn" type="button" id="btn-activate">${icon("star")}Сделать активной</button>` : ""}
          <details class="action-menu">
            <summary class="btn">Ещё</summary>
            <div class="action-menu-panel">
              ${checkRule ? apply : ""}
              <button type="button" id="btn-json">${icon("code")}Открыть JSON</button>
            </div>
          </details>
        </div>
      </div>
    </header>
    <section class="card cl-editor journal-panel" aria-label="Редактор чек-листа">
      <div class="journal-scroll" role="region" aria-label="Критерии чек-листа" tabindex="0">
        <div class="card-pad" id="editor"></div>
      </div>
      <div class="save-bar" id="save-bar"></div>
    </section></div>`;
  const page = root.firstElementChild;
  const stopWatching = watchMenuSpace($(".journal-page-head", page), $(".cl-editor", page));

  $("#cl-version", page)?.addEventListener("change", (e) => {
    const select = e.currentTarget;
    const id = select.value;
    select.value = String(selectedVersion?.id ?? "");
    if (id) location.hash = `#/checklists/${id}${editorQuery}`;
  });
  $("#btn-activate", page)?.addEventListener("click", async (e) => {
    const button = e.currentTarget;
    const activate = await confirmDialog({
      title: `Сделать Version ${current.version} активной?`,
      body: `<p>Эта версия станет чек-листом по умолчанию для новых оценок. Ранее выставленные оценки сохранятся.</p>
        ${isDirty() ? "<p>Несохранённые правки в редакторе будут сброшены.</p>" : ""}`,
      okText: "Сделать активной",
    });
    if (!activate || !button.isConnected) return;
    busy(button, true, "…");
    try {
      await api.activateChecklist(current.id);
      toast(`Version ${current.version} теперь активна для новых оценок`);
      if (button.isConnected) render(root, params, query);
    } catch (err) { toast(err.message, true); busy(button, false); }
  });
  $("#btn-apply", page)?.addEventListener("click", () => applyDialog(current));
  $("#btn-json", page).addEventListener("click", () => jsonDialog(page, current));

  const editor = $("#editor", page);
  const suggestionAppeals = new Set();
  drawEditor(editor);
  $("#focus-feedback-rule", page)?.addEventListener("click", (e) => {
    e.currentTarget.closest("details").open = false;
    focusGuidance(editor, target);
  });
  const versionSection = $("#cl-changes", page);
  if (versionSection) loadVersionChanges(versionSection, { current, earlierVersion, appealDetail, editor });
  const suggestionSection = $("#rule-suggestions", page);
  if (suggestionSection) loadRuleSuggestions(suggestionSection, {
    current, list, editor, suggestionAppeals, editorQuery, sourceAppealId: source?.id,
  });
  editor.addEventListener("input", (e) => onInput(e, editor));
  editor.addEventListener("change", (e) => onChange(e, editor));
  editor.addEventListener("click", (e) => onClick(e, editor));
  $("#save-bar", page).addEventListener("click", (e) => {
    if (e.target.closest("[data-act=save]")) {
      openSave(page, current, list, conversation ? returnToDialog : null, source?.id, [...suggestionAppeals]);
    }
    if (e.target.closest("[data-act=show-err]")) revealFirstError(editor);
  });

  const onUnload = (e) => { if (isDirty()) { e.preventDefault(); e.returnValue = ""; } };
  window.addEventListener("beforeunload", onUnload);
  offUnload = () => {
    stopWatching();
    window.removeEventListener("beforeunload", onUnload);
  };
  return offUnload;
}

async function loadVersionChanges(section, { current, earlierVersion, appealDetail, editor }) {
  const { note, appealIds } = versionSources(current);
  const [previous, details] = await Promise.all([
    earlierVersion ? api.checklist(earlierVersion.id).catch(() => null) : null,
    Promise.all(appealIds.map((id) => appealDetail?.appeal.id === id ? appealDetail : api.appeal(id).catch(() => null))),
  ]);
  if (!section.isConnected) return;
  const appeals = details.filter((detail) => detail?.conversation?.id && detail.appeal.status !== "open"
    && detail.evaluation.checklist_name === current.config.name);
  const diff = previous ? computeDiff(previous.config, current.config) : null;
  const change = diff?.changed.length === 1 && diffCount(diff) === 1 ? diff.changed[0] : null;
  const criterion = change?.now;
  const oldRule = change?.old.guidance?.trim() || "";
  const rule = criterion?.guidance?.trim() || "";
  const addition = oldRule && rule.startsWith(oldRule + "\n") ? rule.slice(oldRule.length).trim() : "";
  let text = note === "Начальная конфигурация из PDF" || (diff && note === autoNote(diff)) ? "" : note;
  if (criterion && text) {
    const [code, description] = text.split(/\s*·\s*/, 2);
    if (description && [criterion.id, criterion.code].some((value) => String(value).toLowerCase() === code.toLowerCase())) {
      text = text.slice(text.indexOf("·") + 1).trim();
    }
    if (text === `Критерий ${criterion.code || criterion.id}`) text = "";
  }
  const summary = addition && addition.length <= 300 ? addition : text;
  if (!summary && !criterion && !appeals.length) return;

  section.innerHTML = `
    ${criterion ? `<button class="cl-change-rule" type="button" data-change-criterion="${esc(criterion.id)}">
      ${criterion.code ? `${esc(displayCode(criterion.code))} · ` : ""}${esc(criterion.title)} ${icon("chev")}
    </button>` : ""}
    ${summary ? `<p class="cl-change-summary">${esc(summary)}</p>` : ""}
    ${appeals.length ? `<div class="cl-appeal-sources">
      <span>Основание для изменений</span>
      <ul>${appeals.map(({ appeal, conversation }) => `<li><a href="#/appeals/${appeal.id}">
        <strong>Апелляция №${appeal.id}</strong><span>Диалог ${esc(conversation.id)}</span>${icon("chev")}
      </a></li>`).join("")}</ul>
    </div>` : ""}`;
  const menu = section.closest("details");
  menu.hidden = false;
  $("[data-change-criterion]", section)?.addEventListener("click", () => {
    menu.open = false;
    focusGuidance(editor, draft.criteria.find((c) => c.id === criterion.id));
  });
}

function focusGuidance(editor, criterion) {
  const index = draft.criteria.indexOf(criterion);
  if (index < 0) return;
  openSet.add(criterion);
  drawEditor(editor);
  $(`[data-k="criteria.${index}.guidance"]`, editor)?.focus();
}

async function loadRuleSuggestions(section, { current, list, editor, suggestionAppeals, editorQuery, sourceAppealId }) {
  let result, latest;
  try {
    result = await api.ruleSuggestions(current.id);
    if (!section.isConnected || !result.items.length) return;
    latest = result.items.some((item) => item.case_count >= result.minimum_cases)
      ? await latestRuleChecklist(current, list) : current;
  } catch {
    if (section.isConnected) {
      section.closest("details").hidden = false;
      section.textContent = "Не удалось загрузить предложения по правилам.";
    }
    return;
  }
  if (!section.isConnected) return;
  const counts = new Map(result.items.map((item) => [item.criterion_id, item.case_count]));
  const items = current.config.criteria.filter((c) => counts.has(c.id));
  if (!items.length) return;
  section.innerHTML = `
    <ul class="rule-suggestion-list">${items.map((c) => {
      const count = counts.get(c.id);
      const ready = count >= result.minimum_cases;
      const status = ready ? `${count} ${plural(count, ["диалог", "диалога", "диалогов"])}` : `Для предложения: ${count} из ${result.minimum_cases} диалогов`;
      const action = ready && (sameRule(current, latest, c.id)
        ? `<button type="button" class="btn btn-primary" data-suggest-rule="${esc(c.id)}">Предложить уточнение правила</button>`
        : `<a class="btn" href="#/checklists/${latest.id}?${esc(ruleVersionQuery(editorQuery, c.id))}">Открыть актуальное правило · Version ${esc(latest.version)}</a>`);
      return `<li><b>${esc(displayCode(c.code || c.id))} · ${esc(c.title)}</b>
        <span class="badge ${ready ? "brand" : "outline"}">${status}</span>
        ${action || ""}
      </li>`;
    }).join("")}</ul>`;
  section.closest("details").hidden = false;

  let generating = false;
  section.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-suggest-rule]");
    if (!button || generating) return;
    const id = button.dataset.suggestRule;
    const original = current.config.criteria.find((c) => c.id === id);
    const criterion = draft.criteria.find((c) => c.id === id);
    const isOriginal = () => draft?.criteria.includes(criterion) && JSON.stringify(criterion) === JSON.stringify(original);
    if (!isOriginal()) {
      toast("Сохраните текущие изменения этого критерия перед запросом предложения.", true);
      return;
    }
    generating = true;
    try {
      await openRuleProposal(button, {
        source: current, criterionId: id, sourceAppealId,
        canSave: () => !isDirty(),
        onSaved: (saved) => { location.hash = `#/checklists/${saved.id}?${ruleVersionQuery(editorQuery, id)}`; },
        onDraft: isDirty() ? (guidance, appealIds) => {
          if (!isOriginal()) throw new Error("Критерий в редакторе изменился. Сохраните изменения и запросите уточнение снова.");
          criterion.guidance = guidance;
          appealIds.forEach((aid) => suggestionAppeals.add(aid));
          section.closest("details").open = false;
          focusGuidance(editor, criterion);
        } : undefined,
      });
    } finally {
      generating = false;
    }
  });
}

function ruleVersionQuery(editorQuery, criterionId) {
  const params = new URLSearchParams(editorQuery);
  params.set("criterion", criterionId);
  return params;
}

/* ------------------------------------------------------------ model ---- */

function blankConfig() {
  return {
    name: "Новый чек-лист", description: "", rounding: 2, general_rules: "",
    sections: [{ id: "main", title: "Основное" }],
    criteria: [],
  };
}

function newCriterion() {
  const n = draft.criteria.length + 1;
  let id = `c${String(n).padStart(2, "0")}`;
  while (draft.criteria.some((c) => c.id === id)) id += "x";
  return {
    id, code: String(n).padStart(2, "0"), section: draft.sections[0]?.id || "", title: "",
    type: "binary", weight: 10, na_allowed: false, description: "", guidance: "", na_condition: "",
  };
}

const scoredCriteria = () => draft.criteria.filter((c) => c.type !== "critical");
const totalWeight = () => scoredCriteria().reduce((s, c) => s + (Number(c.weight) || 0), 0);
const share = (c) => {
  const tw = totalWeight();
  return c.type === "critical" || !tw ? 0 : ((Number(c.weight) || 0) / tw) * 100;
};

function validate() {
  const e = {};
  if (!String(draft.name || "").trim()) e.name = "Укажите название чек-листа";
  if (!draft.criteria.length) e.criteria = "Добавьте хотя бы один критерий";
  const secIds = new Set();
  draft.sections.forEach((s, i) => {
    const id = String(s.id || "").trim();
    if (!id) e[`sections.${i}.id`] = "Пустой id";
    else if (secIds.has(id)) e[`sections.${i}.id`] = "id повторяется";
    secIds.add(id);
  });
  const seen = {};
  draft.criteria.forEach((c) => { const id = String(c.id || "").trim(); if (id) seen[id] = (seen[id] || 0) + 1; });
  draft.criteria.forEach((c, i) => {
    const k = (f) => `criteria.${i}.${f}`;
    const id = String(c.id || "").trim();
    if (!id) e[k("id")] = "Укажите ID";
    else if (seen[id] > 1) e[k("id")] = "ID повторяется";
    if (!String(c.title || "").trim()) e[k("title")] = "Укажите название критерия";
    if (c.type !== "critical" && Number(c.weight) < 0) e[k("weight")] = "Вес не может быть отрицательным";
    if (c.section && secIds.size && !secIds.has(c.section)) e[k("section")] = "Секция не найдена";
    if (c.type === "scale") {
      const vals = (c.scale || []).map((s) => (s.value === "" || s.value === null ? NaN : Number(s.value)));
      if (vals.some((v) => !Number.isFinite(v))) e[k("scale")] = "У каждой ступени должен быть балл";
      else if (new Set(vals).size !== vals.length) e[k("scale")] = "Баллы ступеней не должны повторяться";
      else if (vals.length < 2) e[k("scale")] = "Шкале нужно минимум 2 ступени";
      else if (Math.max(...vals) <= 0) e[k("scale")] = "Верхняя ступень должна быть больше 0";
    }
  });
  return e;
}

/* ------------------------------------------------------------- diff ---- */

const normScale = (sc) => JSON.stringify([...(sc || [])].map((s) => ({ v: Number(s.value), d: String(s.description || "").trim() })).sort((a, b) => b.v - a.v));
const scaleValues = (sc) => [...(sc || [])].map((s) => Number(s.value)).sort((a, b) => b - a).map((v) => fmtNum(v)).join(" / ") || "—";

function fieldValue(c, f) {
  if (f === "weight") return c.type === "critical" ? 0 : Number(c.weight) || 0;
  if (f === "na_allowed") return !!c.na_allowed;
  if (f === "scale") return c.type === "scale" ? normScale(c.scale) : "";
  return String(c[f] ?? "").trim();
}

function computeDiff(a, b) {
  const d = { general: [], added: [], removed: [], changed: [], reordered: false };
  if (!a) return d;
  for (const [f, label] of [["name", "Название"], ["description", "Описание"], ["rounding", "Округление"], ["general_rules", "Общие правила"]]) {
    const x = String(a[f] ?? "").trim(), y = String(b[f] ?? "").trim();
    if (x !== y) d.general.push({ f, label, old: x, new: y });
  }
  const as = new Map((a.sections || []).map((s) => [s.id, s])), bs = new Map((b.sections || []).map((s) => [s.id, s]));
  for (const [id, s] of bs) {
    if (!as.has(id)) d.general.push({ label: "Секция добавлена", new: s.title || id });
    else if ((as.get(id).title || "") !== (s.title || "")) d.general.push({ label: `Секция «${id}» переименована`, old: as.get(id).title, new: s.title });
  }
  for (const [id, s] of as) if (!bs.has(id)) d.general.push({ label: "Секция удалена", old: s.title || id });

  const am = new Map(a.criteria.map((c) => [c.id, c])), bm = new Map(b.criteria.map((c) => [c.id, c]));
  b.criteria.forEach((c) => { if (!am.has(c.id)) d.added.push(c); });
  a.criteria.forEach((c) => { if (!bm.has(c.id)) d.removed.push(c); });
  b.criteria.forEach((c) => {
    const o = am.get(c.id);
    if (!o) return;
    const fields = Object.keys(FIELD).filter((f) => f !== "id" && fieldValue(o, f) !== fieldValue(c, f));
    if (fields.length) d.changed.push({ old: o, now: c, fields });
  });
  const ao = a.criteria.map((c) => c.id).filter((id) => bm.has(id)), bo = b.criteria.map((c) => c.id).filter((id) => am.has(id));
  d.reordered = ao.join("\u0001") !== bo.join("\u0001");
  return d;
}

const diffCount = (d) => d.general.length + d.added.length + d.removed.length + d.changed.length + (d.reordered ? 1 : 0);

function showValue(cfg, c, f) {
  if (f === "type") return TYPE_LABEL[c.type] || c.type;
  if (f === "na_allowed") return c.na_allowed ? "да" : "нет";
  if (f === "weight") return c.type === "critical" ? "без баллов" : fmtNum(c.weight);
  if (f === "section") return (cfg.sections || []).find((s) => s.id === c.section)?.title || c.section || "—";
  if (f === "scale") return c.type === "scale" ? scaleValues(c.scale) : "—";
  return String(c[f] ?? "").trim() || "—";
}

function inlineChange(o, n) {
  return `<span class="diff-old">${esc(o)}</span> → <span class="diff-new">${esc(n)}</span>`;
}
function blockChange(o, n) {
  return `<div class="diff-text">${o ? `<span class="diff-old">${esc(o)}</span>` : ""}${n ? `<span class="diff-new">${esc(n)}</span>` : ""}</div>`;
}

function diffHtml(d) {
  const n = diffCount(d);
  if (!n) return `<div class="diff-empty">Изменений нет — новая версия совпадёт с текущей.</div>`;
  const crit = (c) => `<span class="code">${esc(c.code || c.id)}</span>${esc(c.title || "Без названия")}`;
  const items = [];
  if (d.general.length) {
    items.push(`<div class="diff-item gen"><div class="dh">Общие параметры</div><ul>${d.general.map((g) => {
      if (LONG_FIELDS.has(g.f)) return `<li><span class="f">${esc(g.label)}</span>${blockChange(g.old, g.new)}</li>`;
      if (g.old !== undefined && g.new !== undefined) return `<li><span class="f">${esc(g.label)}:</span> ${inlineChange(g.old || "—", g.new || "—")}</li>`;
      return `<li><span class="f">${esc(g.label)}:</span> ${g.new !== undefined ? `<span class="diff-new">${esc(g.new)}</span>` : `<span class="diff-old">${esc(g.old)}</span>`}</li>`;
    }).join("")}</ul></div>`);
  }
  d.added.forEach((c) => items.push(`<div class="diff-item add"><div class="dh"><span class="badge yes">добавлен</span>${crit(c)}</div>
    <ul><li>${esc(TYPE_LABEL[c.type] || c.type)} · вес ${esc(showValue(draft, c, "weight"))} · N/A ${c.na_allowed ? "разрешён" : "запрещён"}${c.type === "scale" ? ` · шкала ${esc(scaleValues(c.scale))}` : ""}</li>
    ${c.description ? `<li>${esc(c.description)}</li>` : ""}</ul></div>`));
  d.removed.forEach((c) => items.push(`<div class="diff-item del"><div class="dh"><span class="badge no">удалён</span>${crit(c)}</div></div>`));
  d.changed.forEach(({ old, now, fields }) => items.push(`<div class="diff-item mod"><div class="dh"><span class="badge warn">изменён</span>${crit(now)}</div><ul>
    ${fields.map((f) => {
      if (LONG_FIELDS.has(f)) return `<li><span class="f">${FIELD[f]}</span>${blockChange(String(old[f] ?? "").trim(), String(now[f] ?? "").trim())}</li>`;
      if (f === "scale") {
        const ov = showValue(base, old, f), nv = showValue(draft, now, f);
        return `<li><span class="f">Шкала:</span> ${ov === nv ? "изменены описания ступеней" : inlineChange(ov, nv)}</li>`;
      }
      return `<li><span class="f">${FIELD[f]}:</span> ${inlineChange(showValue(base, old, f), showValue(draft, now, f))}</li>`;
    }).join("")}</ul></div>`));
  if (d.reordered) items.push(`<div class="diff-item gen"><div class="dh">Изменён порядок критериев</div></div>`);
  return `
    <div class="diff-sum">
      ${d.added.length ? `<span class="badge yes">+${d.added.length} ${plural(d.added.length, ["добавлен", "добавлено", "добавлено"])}</span>` : ""}
      ${d.removed.length ? `<span class="badge no">−${d.removed.length} ${plural(d.removed.length, ["удалён", "удалено", "удалено"])}</span>` : ""}
      ${d.changed.length ? `<span class="badge warn">${d.changed.length} ${plural(d.changed.length, ["критерий изменён", "критерия изменено", "критериев изменено"])}</span>` : ""}
      ${d.general.length ? `<span class="badge brand">общие параметры: ${d.general.length}</span>` : ""}
    </div>
    <div class="diff-list">${items.join("")}</div>`;
}

function autoNote(d) {
  const parts = [];
  d.changed.forEach(({ now, fields }) => parts.push(`${now.code || now.id} ${now.title}: ${fields.map((f) => FIELD[f].toLowerCase()).join(", ")}`));
  d.added.forEach((c) => parts.push(`добавлен ${c.code || c.id} ${c.title}`));
  d.removed.forEach((c) => parts.push(`удалён ${c.code || c.id} ${c.title}`));
  if (d.general.length) parts.push("общие параметры");
  if (d.reordered) parts.push("порядок критериев");
  const s = parts.join("; ");
  return s.length > 200 ? s.slice(0, 197) + "…" : s;
}

function isDirty() {
  if (!draft) return false;
  return diffCount(computeDiff(base || blankConfig(), draft)) > 0;
}

/* ----------------------------------------------------------- editor ---- */

function errSlot(key) { return `<small class="field-err" data-err="${esc(key)}" role="alert"></small>`; }

function drawEditor(el, focusKey) {
  const settingsOpen = el.querySelector(".ed-settings")?.open;
  el.innerHTML = `
    <div class="ed-section-title">Критерии <span class="badge brand">${draft.criteria.length}</span><span class="spacer"></span>
      ${draft.criteria.length ? `<button class="btn btn-ghost" type="button" data-act="expand-all">${draft.criteria.every((c) => openSet.has(c)) ? "Свернуть все" : "Развернуть все"}</button>` : ""}
      <button class="btn" type="button" data-act="add-crit">${icon("plus")}Добавить критерий</button></div>
    ${errSlot("criteria")}
    <div id="crit-list">${draft.criteria.map((c, i) => critEditor(c, i)).join("")}</div>

    <details class="ed-settings"${settingsOpen ? " open" : ""}>
    <summary>Общие параметры и секции</summary>
    <div class="ed-general">
      <label class="field span4">Название чек-листа<input class="input" data-k="name" value="${esc(draft.name)}">${errSlot("name")}</label>
      <label class="field span2">Округление итога, знаков<input class="input" type="number" min="0" max="4" data-k="rounding" value="${esc(draft.rounding ?? 2)}"></label>
      <label class="field span6">Описание<input class="input" data-k="description" value="${esc(draft.description || "")}" placeholder="Коротко: для чего этот чек-лист"></label>
      <label class="field span6">Общие правила для оценщика <span class="hint">контекст, который получает модель вместе с критериями</span>
        <textarea class="input" rows="3" data-k="general_rules">${esc(draft.general_rules || "")}</textarea></label>
    </div>

    <div class="ed-section-title">Секции <span class="muted">(${draft.sections.length})</span></div>
    <div>
      ${draft.sections.map((s, i) => `
        <div class="sec-ed">
          <label class="field"><span class="sr-only">id секции ${i + 1}</span><input class="input mono" data-k="sections.${i}.id" value="${esc(s.id)}" placeholder="id">${errSlot(`sections.${i}.id`)}</label>
          <label class="field"><span class="sr-only">Название секции ${i + 1}</span><input class="input" data-k="sections.${i}.title" value="${esc(s.title)}" placeholder="Название секции"></label>
          <button class="btn btn-ghost btn-danger btn-icon" type="button" data-act="del-section" data-i="${i}" aria-label="Удалить секцию ${esc(s.title || s.id)}" title="Удалить секцию">${icon("trash")}</button>
        </div>`).join("")}
      <button class="btn" type="button" data-act="add-section">${icon("plus")}Секция</button>
    </div>
    </details>`;
  paint(el);
  if (focusKey) {
    const f = el.querySelector(`[data-k="${CSS.escape(focusKey)}"]`);
    if (f) f.focus();
  }
}

function critEditor(c, i) {
  const k = (f) => `criteria.${i}.${f}`;
  const open = openSet.has(c);
  return `
    <div class="ed-crit${open ? " open" : ""}" data-ci="${i}">
      <button type="button" class="ed-toggle" data-act="toggle" data-i="${i}" aria-expanded="${open}" aria-controls="crit-body-${i}">
        <svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>
        <span class="code" data-h="code"></span>
        <span class="title" data-h="title"></span>
        <span class="err-dot" title="Есть ошибки"></span>
        <span class="tags">
          <span class="badge">${esc(TYPE_SHORT[c.type] || c.type)}</span>
          <span class="badge brand keep" data-h="weight"></span>
          ${c.na_allowed ? `<span class="badge na">N/A</span>` : ""}
        </span>
      </button>
      <div class="ed-crit-body" id="crit-body-${i}">
        <label class="field">Код<input class="input" data-k="${k("code")}" value="${esc(c.code || "")}"></label>
        <label class="field">ID<input class="input mono" data-k="${k("id")}" value="${esc(c.id)}">${errSlot(k("id"))}</label>
        <label class="field span4">Название<input class="input" data-k="${k("title")}" value="${esc(c.title)}" placeholder="Например: Установление контакта">${errSlot(k("title"))}</label>
        <label class="field span2">Секция
          <select class="input" data-k="${k("section")}">
            <option value="">—</option>
            ${draft.sections.map((s) => `<option value="${esc(s.id)}" ${s.id === c.section ? "selected" : ""}>${esc(s.title || s.id)}</option>`).join("")}
          </select>${errSlot(k("section"))}</label>
        <label class="field span2">Тип ответа
          <select class="input" data-k="${k("type")}" data-redraw>
            ${Object.entries(TYPE_LABEL).map(([v, l]) => `<option value="${v}" ${v === c.type ? "selected" : ""}>${esc(l)}</option>`).join("")}
          </select></label>
        <label class="field">Вес<input class="input" type="number" min="0" step="0.5" data-k="${k("weight")}" value="${c.type === "critical" ? 0 : esc(c.weight)}" ${c.type === "critical" ? 'disabled title="Грубая ошибка не даёт баллов"' : ""}>${errSlot(k("weight"))}</label>
        <div class="field"><span>N/A</span><label class="checkline"><input type="checkbox" data-k="${k("na_allowed")}" data-redraw ${c.na_allowed ? "checked" : ""}> разрешён</label></div>
        <label class="field span6">${c.type === "critical" ? "Что считается грубой ошибкой" : c.type === "scale" ? "Что оценивается по шкале" : "Формулировка: что значит «Да»"}
          <textarea class="input" rows="2" data-k="${k("description")}">${esc(c.description || "")}</textarea></label>
        <label class="field span6">Уточнения для оценки (памятка для модели: пограничные случаи, что не считать нарушением)
          <textarea class="input" rows="3" data-k="${k("guidance")}">${esc(c.guidance || "")}</textarea></label>
        ${c.na_allowed ? `<label class="field span6">Когда ставить N/A<input class="input" data-k="${k("na_condition")}" value="${esc(c.na_condition || "")}" placeholder="Например: запрос не требовал идентификации"></label>` : ""}
        ${c.type === "scale" ? `
          <div class="field span6"><span>Шкала <span class="hint">верхняя ступень даёт полный вес, остальные — пропорционально</span></span>
            <div class="scale-head"><span>Балл</span><span>Описание ступени</span><span></span></div>
            ${(c.scale || []).map((s, j) => `
              <div class="scale-row">
                <input class="input" type="number" step="any" data-k="${k(`scale.${j}.value`)}" value="${esc(s.value)}" aria-label="Балл ступени ${j + 1}">
                <input class="input" data-k="${k(`scale.${j}.description`)}" value="${esc(s.description)}" placeholder="Описание ступени" aria-label="Описание ступени ${j + 1}">
                <button class="btn btn-ghost btn-danger btn-icon" type="button" data-act="del-step" data-i="${i}" data-j="${j}" aria-label="Удалить ступень ${j + 1}" title="Удалить ступень">${icon("x")}</button>
              </div>`).join("")}
            ${errSlot(k("scale"))}
            <div><button class="btn" type="button" data-act="add-step" data-i="${i}">${icon("plus")}Ступень</button></div>
          </div>` : ""}
        <div class="ed-crit-actions span6">
          <button class="btn btn-ghost btn-danger" type="button" data-act="del-crit" data-i="${i}">${icon("trash")}Удалить критерий</button>
        </div>
      </div>
    </div>`;
}

/** Updates validation messages, criterion headers and the save bar without re-rendering inputs. */
function paint(el) {
  const errs = validate();
  $$("[data-err]", el).forEach((s) => { s.textContent = errs[s.dataset.err] || ""; });
  $$("[data-k]", el).forEach((inp) => {
    if (errs[inp.dataset.k]) inp.setAttribute("aria-invalid", "true"); else inp.removeAttribute("aria-invalid");
  });
  $$(".ed-crit", el).forEach((card) => {
    const i = Number(card.dataset.ci), c = draft.criteria[i];
    if (!c) return;
    const prefix = `criteria.${i}.`;
    card.classList.toggle("has-err", Object.keys(errs).some((k) => k.startsWith(prefix)));
    const t = $("[data-h=title]", card);
    t.textContent = c.title || "Без названия";
    t.classList.toggle("empty-t", !c.title);
    $("[data-h=code]", card).textContent = displayCode(c.code);
    const weight = $("[data-h=weight]", card);
    weight.textContent = c.type === "critical" ? "без баллов" : `${fmtNum(share(c), 1)}%`;
    if (c.type !== "critical") weight.title = `Вес критерия: ${fmtNum(c.weight)}`;
  });
  paintSaveBar(el, errs);
}

function paintSaveBar(el, errs) {
  const bar = el.closest(".cl-editor")?.querySelector("#save-bar");
  if (!bar) return;
  const nErr = Object.keys(errs).length;
  const d = computeDiff(base, draft), n = diffCount(d);
  bar.hidden = Boolean(base && !n);
  if (bar.hidden) return;
  const parts = [];
  if (nErr) parts.push(`<span class="badge no">${icon("alert")}${nErr} ${plural(nErr, ["ошибка", "ошибки", "ошибок"])}</span><button class="btn-link small" type="button" data-act="show-err">показать</button>`);
  if (base) parts.push(`<span class="badge warn">${n} ${plural(n, ["изменение", "изменения", "изменений"])}</span>`);
  else parts.push(`<span class="muted">Новый чек-лист · ${draft.criteria.length} ${plural(draft.criteria.length, ["критерий", "критерия", "критериев"])}</span>`);
  bar.innerHTML = `
    <div class="status" aria-live="polite">${parts.join("")}</div>
    <button class="btn btn-primary" type="button" data-act="save">${icon("check")}Сохранить новую версию…</button>`;
}

function revealFirstError(el) {
  const errs = validate();
  const key = Object.keys(errs)[0];
  if (!key) return;
  const m = key.match(/^criteria\.(\d+)\./);
  if (m) {
    const c = draft.criteria[Number(m[1])];
    if (c && !openSet.has(c)) { openSet.add(c); drawEditor(el); }
  }
  const target = el.querySelector(`[data-k="${CSS.escape(key)}"]`) || el.querySelector(`[data-err="${CSS.escape(key)}"]`);
  if (target) {
    const settings = target.closest("details");
    if (settings) settings.open = true;
    target.scrollIntoView({ block: "center", behavior: "smooth" });
    if (target.focus) target.focus({ preventScroll: true });
  }
}

function setPath(obj, path, value) {
  const parts = path.split(".");
  let o = obj;
  for (let i = 0; i < parts.length - 1; i++) o = o[parts[i]];
  o[parts.at(-1)] = value;
}

function onInput(e, editor) {
  const t = e.target;
  if (!t.dataset.k || t.type === "checkbox" || t.tagName === "SELECT") return;
  let v = t.value;
  if (t.type === "number") v = v === "" ? (t.dataset.k.includes(".scale.") ? "" : 0) : Number(v);
  const k = t.dataset.k;
  const sec = k.match(/^sections\.(\d+)\.id$/);
  if (sec) {
    // Keep criteria attached to a renamed section.
    const old = draft.sections[Number(sec[1])].id;
    draft.criteria.forEach((c) => { if (c.section === old) c.section = v; });
  }
  setPath(draft, k, v);
  if (/^sections\.\d+\.(id|title)$/.test(k)) syncSectionOptions(editor);
  paint(editor);
}

/** Rebuilds the criterion section selects in place (no re-render, focus stays put). */
function syncSectionOptions(editor) {
  $$('select[data-k$=".section"]', editor).forEach((sel) => {
    const c = draft.criteria[Number(sel.dataset.k.split(".")[1])];
    sel.innerHTML = `<option value="">—</option>` + draft.sections.map((s) =>
      `<option value="${esc(s.id)}" ${s.id === c.section ? "selected" : ""}>${esc(s.title || s.id)}</option>`).join("");
  });
}

function onChange(e, editor) {
  const t = e.target;
  if (!t.dataset.k || (t.type !== "checkbox" && t.tagName !== "SELECT")) return;
  const k = t.dataset.k;
  const v = t.type === "checkbox" ? t.checked : t.value;
  setPath(draft, k, v);
  if (k.endsWith(".type")) {
    const c = draft.criteria[Number(k.split(".")[1])];
    if (v === "scale" && !(c.scale || []).length) c.scale = [{ value: 10, description: "" }, { value: 5, description: "" }, { value: 0, description: "" }];
    if (v === "critical") { c.weight = 0; c.na_allowed = false; }
    if (v !== "critical" && !Number(c.weight)) c.weight = 10;
  }
  // Type and N/A change the shape of the criterion form.
  if (t.dataset.redraw !== undefined) drawEditor(editor, k);
  else paint(editor);
}

async function onClick(e, editor) {
  const b = e.target.closest("[data-act]");
  if (!b || b.disabled) return;
  const i = Number(b.dataset.i);
  let focusKey = null;
  switch (b.dataset.act) {
    case "toggle": {
      const c = draft.criteria[i];
      if (openSet.has(c)) openSet.delete(c); else openSet.add(c);
      const card = b.closest(".ed-crit");
      card.classList.toggle("open", openSet.has(c));
      b.setAttribute("aria-expanded", String(openSet.has(c)));
      const ex = $("[data-act=expand-all]", editor);
      if (ex) ex.textContent = draft.criteria.every((x) => openSet.has(x)) ? "Свернуть все" : "Развернуть все";
      return;
    }
    case "expand-all": {
      const all = draft.criteria.every((c) => openSet.has(c));
      openSet = all ? new Set() : new Set(draft.criteria);
      break;
    }
    case "add-crit": {
      const c = newCriterion();
      draft.criteria.push(c);
      openSet.add(c);
      focusKey = `criteria.${draft.criteria.length - 1}.title`;
      break;
    }
    case "del-crit": {
      const c = draft.criteria[i];
      const ok = await confirmDialog({
        title: "Удалить критерий?",
        body: `<p style="margin:0">Критерий <b>${esc(c.code || "")} ${esc(c.title || c.id)}</b> будет удалён из новой версии. Сохранённые версии и оценки не изменятся.</p>`,
        okText: "Удалить", danger: true,
      });
      if (!ok) return;
      draft.criteria.splice(i, 1);
      break;
    }
    case "add-step": {
      const sc = (draft.criteria[i].scale ||= []);
      sc.push({ value: "", description: "" });
      focusKey = `criteria.${i}.scale.${sc.length - 1}.value`;
      break;
    }
    case "del-step": draft.criteria[i].scale.splice(Number(b.dataset.j), 1); break;
    case "add-section": {
      let n = draft.sections.length + 1, id = `s${n}`;
      while (draft.sections.some((s) => s.id === id)) id = `s${++n}`;
      draft.sections.push({ id, title: "" });
      focusKey = `sections.${draft.sections.length - 1}.title`;
      break;
    }
    case "del-section": {
      const s = draft.sections[i];
      const used = draft.criteria.filter((c) => c.section === s.id).length;
      if (used) { toast(`Секция используется в ${used} ${plural(used, ["критерии", "критериях", "критериях"])} — сначала перенесите их`, true); return; }
      draft.sections.splice(i, 1);
      break;
    }
    default: return;
  }
  drawEditor(editor, focusKey);
}

/* ------------------------------------------------------------- save ---- */

function cleanConfig() {
  const cfg = structuredClone(draft);
  cfg.name = String(cfg.name || "").trim();
  cfg.sections = cfg.sections.map((s) => ({ ...s, id: String(s.id).trim() }));
  cfg.criteria.forEach((c) => {
    c.id = String(c.id).trim();
    c.title = String(c.title).trim();
    if (c.type === "scale") c.scale = (c.scale || []).map((s) => ({ value: Number(s.value), description: s.description || "" }));
  });
  return cfg;
}

function openSave(page, current, list, returnToDialog, sourceAppealId, suggestionAppeals) {
  const editor = $("#editor", page);
  const errs = validate();
  if (Object.keys(errs).length) {
    toast(`Исправьте ошибки в чек-листе (${Object.keys(errs).length})`, true);
    revealFirstError(editor);
    return;
  }
  const cfg = cleanConfig();
  const d = computeDiff(base, cfg);
  const sameName = list.filter((c) => c.name === cfg.name);
  const next = sameName.length ? Math.max(...sameName.map((c) => c.version)) + 1 : 1;
  const nameChanged = base && base.name !== cfg.name;
  const appeals = [...new Set([sourceAppealId, ...suggestionAppeals].filter(Boolean))];
  const originNote = appeals.length ? `По ${appeals.length === 1 ? "апелляции" : "апелляциям"} ${appeals.map((id) => `#${id}`).join(", ")}` : "";
  const note = [originNote, base ? autoNote(d) : ""].filter(Boolean).join(" · ");
  const m = modal({
    title: `Сохранить «${cfg.name}» · Version ${next}`,
    submitText: returnToDialog ? `Сохранить и вернуться` : `Сохранить Version ${next}`,
    body: `
      ${base ? `<div class="small muted">Сравнение с <b>${esc(base.name)} · Version ${esc(current.version)}</b>.</div>`
        : `<div class="small muted">${cfg.criteria.length} ${plural(cfg.criteria.length, ["критерий", "критерия", "критериев"])}.</div>`}
      ${nameChanged ? `<div class="note warn">Версии нумеруются отдельно для каждого названия чек-листа.</div>` : ""}
      ${base ? diffHtml(d) : ""}
      <label class="field">Комментарий к версии
        <input class="input" id="sv-note" maxlength="300" value="${esc(note.slice(0, 300))}" placeholder="Что изменено и зачем"></label>
      <label class="check"><input type="checkbox" id="sv-activate" ${returnToDialog || suggestionAppeals.length ? "" : "checked"}> Сделать активной — выбирается по умолчанию для новых оценок</label>`,
    onSubmit: async (el) => {
      const ok = $("[data-ok]", el);
      busy(ok, true, "Сохранение…");
      try {
        const activate = $("#sv-activate", el).checked;
        const saved = await api.saveChecklist(cfg, $("#sv-note", el).value.trim() || null, activate, sourceAppealId);
        draft = null; base = null; // not dirty any more
        toast(`Сохранено: ${saved.name} · Version ${saved.version}`);
        if (returnToDialog) location.hash = returnToDialog(saved.id);
        else {
          location.hash = `#/checklists/${saved.id}`;
          if (!suggestionAppeals.length) {
            setTimeout(() => applyDialog({ id: saved.id, version: saved.version, config: saved.config || cfg, is_active: activate }, { justSaved: true }), 0);
          }
        }
      } finally { busy(ok, false); }
    },
  });
  m.el.querySelector(".modal").classList.add("modal-wide");
}

/* ------------------------------------------------------------ apply ---- */

async function applyDialog(cl, { justSaved = false } = {}) {
  let groups = [], cost = null;
  try {
    [groups, cost] = await Promise.all([
      api.groups(),
      api.stats({}).then((s) => s.avg_cost_usd).catch(() => null),
    ]);
  } catch (e) { toast(e.message, true); return; }
  const last = store.get("cqa.group");
  const name = cl.config?.name || "";
  const m = modal({
    title: justSaved ? `Version ${cl.version} сохранена` : `Применить «${name}» · Version ${cl.version}`,
    submitText: "Запустить оценку",
    cancelText: justSaved ? "Позже" : "Отмена",
    body: `
      ${justSaved ? `<div class="success-head">${icon("done")}<div><b>«${esc(name)}» · Version ${esc(cl.version)}${cl.is_active ? " активна" : ""}</b><br><span class="small">Примените версию к набору — диалоги будут оценены по новому чек-листу.</span></div></div>` : ""}
      ${groups.length ? `
        <label class="field">Набор диалогов
          <select class="input" id="ap-group">
            <option value="__none" selected disabled>— выберите набор —</option>
            ${groups.map((g) => `<option value="${esc(g.id)}">${esc(g.id)} (${g.count})${g.id === last ? " · последний" : ""}</option>`).join("")}
            <option value="">Все наборы</option>
          </select></label>
        <label class="check"><input type="checkbox" id="ap-missing" checked> Только диалоги без оценки этой версией</label>
        <dl class="cost-list" id="ap-est" aria-live="polite"></dl>
        <div class="note">Оценка идёт в фоне, прогресс и стоимость видны на странице «Диалоги». Предыдущие оценки сохраняются.</div>`
        : `<div class="note warn">Наборов пока нет — сначала импортируйте диалоги на странице «Диалоги».</div>`}`,
    onSubmit: async (el) => {
      if (!groups.length) { location.hash = "#/conversations"; return; }
      const gv = $("#ap-group", el).value;
      if (gv === "__none") { toast("Выберите набор диалогов", true); $("#ap-group", el).focus(); return false; }
      const group = gv || null;
      const ok = $("[data-ok]", el);
      busy(ok, true, "Запуск…");
      try {
        const b = await api.batch({ group, checklist_id: cl.id, only_missing: $("#ap-missing", el).checked });
        if (!b.total) { toast("Нет диалогов для оценки — все уже оценены этой версией"); return false; }
        store.set("cqa.batch", String(b.id));
        if (group) store.set("cqa.group", group);
        toast(`Запущена оценка ${b.total} ${plural(b.total, ["диалога", "диалогов", "диалогов"])} по Version ${cl.version}`);
        location.hash = "#/conversations";
      } finally { busy(ok, false); }
    },
  });
  if (!groups.length) { const ok = $("[data-ok]", m.el); ok.textContent = "К диалогам"; return; }
  const est = $("#ap-est", m.el);
  let seq = 0;
  async function estimate() {
    const my = ++seq;
    if ($("#ap-group", m.el).value === "__none") { est.innerHTML = `<dt>Будет оценено</dt><dd class="muted">выберите набор</dd>`; return; }
    est.innerHTML = `<dt>Будет оценено</dt><dd><span class="spinner" aria-hidden="true"></span></dd>`;
    try {
      const rows = await api.conversations({ group: $("#ap-group", m.el).value || null, checklist_id: cl.id });
      if (my !== seq) return;
      const n = $("#ap-missing", m.el).checked ? rows.filter((r) => !r.eval_id || r.status === "error").length : rows.length;
      est.innerHTML = `<dt>Будет оценено</dt><dd>${n} ${plural(n, ["диалог", "диалога", "диалогов"])}</dd>
        ${cost && n ? `<dt>Ориентировочная стоимость</dt><dd>≈ $${fmtNum(cost * n, 3)}</dd>` : ""}`;
    } catch { if (my === seq) est.innerHTML = ""; }
  }
  $("#ap-group", m.el).addEventListener("change", estimate);
  $("#ap-missing", m.el).addEventListener("change", estimate);
  estimate();
}

/* ------------------------------------------------------------- JSON ---- */

function jsonDialog(page, current) {
  const fname = `${(draft.name || "checklist").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "")}${current.version ? `-v${current.version}` : ""}.json`;
  const m = modal({
    title: "Конфигурация в JSON",
    submitText: "Загрузить в редактор",
    body: `
      <div class="row">
        <button class="btn" type="button" data-j="download">${icon("download")}Скачать .json</button>
        <button class="btn" type="button" data-j="copy">${icon("copy")}Копировать</button>
        <label class="btn" style="position:relative">${icon("upload")}Открыть файл…<input type="file" accept=".json,application/json" id="js-file" style="position:absolute;inset:0;opacity:0;cursor:pointer"></label>
      </div>
      <label class="field"><span class="sr-only">JSON</span><textarea class="input mono" id="js-text" rows="18" spellcheck="false">${esc(JSON.stringify(draft, null, 2))}</textarea></label>
      <div class="muted small">Изменённый JSON загружается в редактор как черновик — затем проверьте разницу и сохраните новую версию.</div>`,
    onSubmit: (el) => {
      let parsed;
      try { parsed = JSON.parse($("#js-text", el).value); } catch (e) { throw new Error("Некорректный JSON: " + e.message); }
      if (!parsed || !Array.isArray(parsed.criteria)) throw new Error("В JSON нет массива criteria");
      parsed.sections ||= [];
      draft = parsed;
      openSet = new Set();
      drawEditor($("#editor", page));
      toast("JSON загружен в редактор — проверьте изменения и сохраните версию");
    },
  });
  m.el.querySelector(".modal").classList.add("modal-wide");
  const ta = $("#js-text", m.el);
  m.el.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-j]");
    if (!b) return;
    if (b.dataset.j === "download") {
      const url = URL.createObjectURL(new Blob([ta.value], { type: "application/json" }));
      const a = Object.assign(document.createElement("a"), { href: url, download: fname });
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } else if (b.dataset.j === "copy") {
      try { await navigator.clipboard.writeText(ta.value); toast("JSON скопирован"); }
      catch { ta.select(); toast("Не удалось скопировать автоматически — текст выделен, нажмите Ctrl+C", true); }
    }
  });
  $("#js-file", m.el).addEventListener("change", async (e) => {
    const f = e.target.files[0];
    if (f) ta.value = await f.text();
  });
}
