// Accuracy against a hand-labelled ground truth, with a version history.
// Every batch (a run of the system on a dataset group) is one version: checklist version,
// model and settings, prompt / code fingerprints and a note on what changed. Any two runs
// can be compared: what got fixed, what broke. The ground truth is only used here, never by the model.
import { api } from "../api.js";
import { esc, $, fmtNum, fmtDate, toast, modal } from "../util.js";

const st = { group: "", gtId: "", run: null, base: null, crit: "", hideUnsure: false, poll: null };

const ANS = { yes: "Да", no: "Нет", na: "N/A" };
// For a critical-error criterion «Да» means a violation was found, so the colours are inverted.
const ansBadge = (v, critical = false) => {
  const good = critical ? "no" : "yes", bad = critical ? "yes" : "no";
  const cls = v === good ? "yes" : v === bad ? "no" : v === "na" ? "na" : "outline";
  return `<span class="badge ${cls}">${esc(ANS[v] || v)}</span>`;
};
const pct = (v) => (v === null || v === undefined ? "—" : `${fmtNum(v, 1)}%`);
const delta = (a, b, { invert = false, unit = " п.п." } = {}) => {
  if (a === null || a === undefined || b === null || b === undefined) return "";
  const d = a - b;
  if (Math.abs(d) < 0.05) return `<span class="acc-delta">±0</span>`;
  const good = invert ? d < 0 : d > 0;
  return `<span class="acc-delta ${good ? "up" : "down"}">${d > 0 ? "+" : "−"}${fmtNum(Math.abs(d), 1)}${unit}</span>`;
};
const thinking = (p) => (p?.thinking_budget === undefined || p?.thinking_budget === null ? "—"
  : p.thinking_budget === 0 ? "выкл" : p.thinking_budget < 0 ? "авто" : String(p.thinking_budget));
const KIND = { normal: "обычные", adversarial: "ловушки" };
const groupLabel = (key) => {
  const [dim, val] = key.split(": ");
  return dim === "Тип" ? [KIND[val] || val, "Тип диалога"] : [val, dim];
};
const kindGroups = (run) => (run.groups || []).filter((g) => g.key.startsWith("Тип: "));

export async function render(root, params, query) {
  const [groups, gts] = await Promise.all([api.groups(), api.groundTruth()]);
  const withGt = [...new Set(gts.map((g) => g.dataset_group))];
  if (query.group) st.group = query.group;
  if (!st.group || !groups.some((g) => g.id === st.group)) st.group = withGt[0] || groups[0]?.id || "";
  const versions = gts.filter((g) => g.dataset_group === st.group);
  if (!versions.some((v) => String(v.id) === String(st.gtId))) st.gtId = "";

  const data = st.group ? await api.accuracy(st.group, st.gtId || null) : { ground_truth: null, runs: [] };
  const runs = data.runs;
  if (!runs.some((r) => r.id === st.run)) st.run = runs.length ? runs[runs.length - 1].id : null;
  if (st.base && !runs.some((r) => r.id === st.base)) st.base = null;
  if (st.base === null && runs.length > 1) st.base = runs[runs.length - 2].id;

  root.innerHTML = `
    <div class="page-head">
      <div><h1>Точность</h1>
        <div class="sub">Сравнение исходных ответов модели (до апелляций) с эталонной разметкой. Эталон используется только для замера и не передаётся модели.</div></div>
      <div class="spacer"></div>
      <select class="input" id="acc-group" style="width:auto" aria-label="Набор диалогов">
        ${groups.map((g) => `<option value="${esc(g.id)}" ${g.id === st.group ? "selected" : ""}>${esc(g.id)} · ${g.count}${withGt.includes(g.id) ? "" : " · без эталона"}</option>`).join("")}
      </select>
      ${versions.length ? `<select class="input" id="acc-gt" style="width:auto" aria-label="Версия эталона">
        ${versions.map((v, i) => `<option value="${v.id}" ${String(v.id) === String(st.gtId) || (!st.gtId && i === 0) ? "selected" : ""}>Эталон v${v.version} · ${v.labels} диал.${i === 0 ? " (последний)" : ""}</option>`).join("")}
      </select>` : ""}
      <button class="btn" id="acc-upload">Загрузить эталон</button>
      <button class="btn btn-primary" id="acc-run" ${st.group ? "" : "disabled"}>Новый прогон</button>
    </div>
    <div id="acc-progress"></div>
    ${!data.ground_truth ? emptyHtml() : !runs.length ? `<div class="card card-pad muted">Для набора ${esc(st.group)} ещё нет завершённых прогонов. Нажмите «Новый прогон».</div>` : `
      <div id="acc-kpis"></div>
      <section class="card acc-hist">
        <div class="card-head"><h2>История версий</h2><div class="spacer"></div>
          <span class="muted small">Строка — прогон системы на наборе. Клик открывает детали, ◎ — база для сравнения.</span></div>
        ${trendSvg(runs)}
        <div class="table-wrap acc-table-wrap">${historyTable(runs)}</div>
      </section>
      <div id="acc-detail"></div>`}`;

  $("#acc-group", root)?.addEventListener("change", (e) => { st.group = e.target.value; st.gtId = ""; st.run = st.base = null; render(root, params, {}); });
  $("#acc-gt", root)?.addEventListener("change", (e) => { st.gtId = e.target.value; render(root, params, {}); });
  $("#acc-upload", root).addEventListener("click", () => uploadDialog(root, params, groups));
  $("#acc-run", root).addEventListener("click", () => runDialog(root, params));
  if (!runs.length) return stop;

  const hist = $(".acc-hist", root);
  hist.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-base]");
    if (b) { e.stopPropagation(); st.base = Number(b.dataset.base) === st.base ? null : Number(b.dataset.base); return render(root, params, {}); }
    const n = e.target.closest("[data-note]");
    if (n) { e.stopPropagation(); return noteDialog(root, params, runs.find((r) => r.id === Number(n.dataset.note))); }
    const tr = e.target.closest("[data-run]");
    if (tr) { st.run = Number(tr.dataset.run); render(root, params, {}); }
  });
  await drawDetail(root, runs);
  return stop;
}

function stop() {
  if (st.poll) { clearInterval(st.poll); st.poll = null; }
}

function emptyHtml() {
  return `
    <div class="card card-pad acc-empty">
      <h3>Для этого набора нет эталона</h3>
      <p class="muted">Загрузите JSON с ручной разметкой. Каждая загрузка сохраняется как новая версия эталона, старые версии остаются.</p>
      <pre class="mono small">{ "labels": {
    "p1-ru-001": { "c01": "yes", "c02": "na", "c04": "20", "c06": "10", "_uncertain": ["c02"], "_kind": "normal" },
    …
} }</pre>
      <p class="muted small">Ответы: yes / no / na или ступень шкалы. Необязательно: <span class="mono">_uncertain</span> — спорные критерии (считаются отдельно), <span class="mono">_kind</span> — тип диалога для разбивки, <span class="mono">_note</span> — комментарий.</p>
    </div>`;
}

// ---------------------------------------------------------------- history ----
function trendSvg(runs) {
  if (runs.length < 2) return "";
  const W = 1000, H = 120, P = 18;
  const vals = runs.map((r) => r.accuracy ?? 0);
  const lo = Math.max(0, Math.floor(Math.min(...vals) - 3)), hi = Math.min(100, Math.ceil(Math.max(...vals) + 2));
  const x = (i) => P + (i * (W - 2 * P)) / (runs.length - 1);
  const y = (v) => H - P - ((v - lo) / Math.max(1, hi - lo)) * (H - 2 * P);
  const pts = runs.map((r, i) => `${x(i).toFixed(1)},${y(r.accuracy ?? lo).toFixed(1)}`).join(" ");
  return `
    <div class="acc-trend" aria-label="Совпадение ответов по прогонам">
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
        <line x1="${P}" x2="${W - P}" y1="${y(hi)}" y2="${y(hi)}" class="grid"/><line x1="${P}" x2="${W - P}" y1="${y(lo)}" y2="${y(lo)}" class="grid"/>
        <polyline points="${pts}" class="line"/>
        ${runs.map((r, i) => `<circle cx="${x(i)}" cy="${y(r.accuracy ?? lo)}" r="${r.id === st.run ? 7 : 4.5}" class="${r.id === st.run ? "cur" : ""}"><title>#${r.id}: ${pct(r.accuracy)}</title></circle>`).join("")}
      </svg>
      <div class="acc-trend-axis"><span>${hi}%</span><span>${lo}%</span></div>
    </div>`;
}

function historyTable(runs) {
  const kinds = [...new Set(runs.flatMap((r) => kindGroups(r).map((g) => g.key)))];
  return `
    <table class="table">
      <thead><tr>
        <th title="База для сравнения">◎</th><th>Прогон</th><th>Что изменили</th><th>Чек-лист</th><th>Модель</th>
        <th title="Бюджет рассуждений модели">Рассужд.</th><th title="Отпечатки системного промпта и кода бэкенда">Промпт · код</th>
        <th class="num">Диал.</th><th class="num">Совпадение</th><th class="num">Без спорных</th>
        ${kinds.map((k) => `<th class="num">${esc(groupLabel(k)[0])}</th>`).join("")}
        <th class="num" title="Средняя ошибка итогового балла">MAE итога</th><th class="num">$ / оценку</th>
      </tr></thead>
      <tbody>
        ${runs.map((r, i) => {
          const prev = runs[i - 1];
          const p = r.pipeline || {};
          return `
          <tr class="click ${r.id === st.run ? "acc-cur" : ""}" data-run="${r.id}">
            <td><button class="acc-radio ${r.id === st.base ? "on" : ""}" data-base="${r.id}" aria-label="Сделать прогон #${r.id} базой для сравнения" title="База для сравнения"></button></td>
            <td><b>#${r.id}</b><div class="muted small">${fmtDate(r.created_at)}</div></td>
            <td class="acc-note">${r.note ? esc(r.note) : `<span class="muted">—</span>`} <button class="btn btn-ghost btn-sm" data-note="${r.id}" title="Изменить заметку" aria-label="Изменить заметку">✎</button></td>
            <td>v${esc(r.checklist_version ?? "?")}</td>
            <td class="small">${esc(p.model || "—")}</td>
            <td>${thinking(p)}</td>
            <td class="mono small">${esc(p.prompt_hash || "—")} · ${esc(p.code_hash || "—")}</td>
            <td class="num">${r.n_conversations}</td>
            <td class="num"><b>${pct(r.accuracy)}</b> ${delta(r.accuracy, prev?.accuracy)}</td>
            <td class="num">${pct(r.accuracy_sure)}</td>
            ${kinds.map((k) => `<td class="num">${pct(kindGroups(r).find((g) => g.key === k)?.accuracy)}</td>`).join("")}
            <td class="num">${r.mae_total ?? "—"} ${delta(r.mae_total, prev?.mae_total, { invert: true, unit: "" })}</td>
            <td class="num">${r.n_conversations && r.cost_usd ? "$" + fmtNum(r.cost_usd / r.n_conversations, 4) : "—"}</td>
          </tr>`;
        }).join("")}
      </tbody>
    </table>`;
}

// ----------------------------------------------------------------- detail ----
async function drawDetail(root, runs) {
  const host = $("#acc-detail", root);
  const kpis = $("#acc-kpis", root);
  const compare = st.base && st.base !== st.run ? st.base : null;
  const res = await api.accuracyRun(st.run, { gtId: st.gtId || null, compare });
  const m = res.metrics, run = res.run;
  const base = compare ? runs.find((r) => r.id === compare) : null;

  kpis.innerHTML = `
    <div class="kpis">
      <div class="card kpi"><div class="lbl">Совпадение ответов · #${run.id}</div><div class="v">${pct(m.accuracy)}</div>${base ? `<div class="small">${delta(m.accuracy, base.accuracy)} к #${base.id}</div>` : ""}</div>
      <div class="card kpi"><div class="lbl">Без спорных меток</div><div class="v">${pct(m.accuracy_sure)}</div>${base ? `<div class="small">${delta(m.accuracy_sure, base.accuracy_sure)}</div>` : ""}</div>
      <div class="card kpi"><div class="lbl">Ошибка итога (MAE)</div><div class="v">${m.mae_total ?? "—"}<small> балла</small></div>${base ? `<div class="small">${delta(m.mae_total, base.mae_total, { invert: true, unit: "" })}</div>` : ""}</div>
      <div class="card kpi"><div class="lbl">Итог в пределах ±5</div><div class="v">${pct(m.within5)}</div></div>
      <div class="card kpi"><div class="lbl">Флаг грубой ошибки</div><div class="v">${pct(m.critical_accuracy)}</div></div>
      <div class="card kpi"><div class="lbl">Ответов сравнено</div><div class="v">${m.n_answers}<small> · ${m.n_conversations} диал.</small></div></div>
    </div>`;

  const crits = [...new Set(m.items.flatMap((it) => it.mismatches.map((x) => x.criterion_id)))];
  const rows = m.items.flatMap((it) => it.mismatches.map((x) => ({ it, x })))
    .filter(({ x }) => (!st.crit || x.criterion_id === st.crit) && (!st.hideUnsure || !x.uncertain));
  const critical = new Set(m.criteria.filter((c) => c.type === "critical").map((c) => c.criterion_id));
  const critTitle = Object.fromEntries(m.criteria.map((c) => [c.criterion_id, `${c.code || ""} ${c.title || ""}`.trim()]));
  const link = (it, cid) => `#/conversation/${encodeURIComponent(it.id)}?eval=${it.eval_id}${cid ? `&crit=${encodeURIComponent(cid)}` : ""}`;

  host.innerHTML = `
    <div class="an-grid acc-grid">
      <section class="card card-pad">
        <h3>По критериям · прогон #${run.id}</h3>
        ${m.criteria.map((c) => {
          const b = base?.criteria?.find((x) => x.criterion_id === c.criterion_id);
          const top = c.errors.slice(0, 3).map((e) => `${ANS[e.gt] || e.gt}→${ANS[e.model] || e.model} ×${e.count}`).join(", ");
          return `
          <div class="hbar acc-hbar" title="${esc(critTitle[c.criterion_id])}: ${c.hit} из ${c.n}">
            <span class="lbl">${esc(c.code || c.criterion_id)} <small>${esc((c.title || "").slice(0, 26))}</small></span>
            <div class="track"><div class="fill ${c.accuracy < 85 ? "weak" : ""}" style="width:${c.accuracy ?? 0}%"></div></div>
            <span class="num">${pct(c.accuracy)}</span>
          </div>
          <div class="acc-err small muted">${top ? `ошибки (эталон→модель): ${esc(top)}` : "без ошибок"}${b ? ` · ${delta(c.accuracy, b.accuracy)}` : ""}</div>`;
        }).join("")}
      </section>
      <section class="card card-pad">
        <h3>По группам</h3>
        ${m.groups.map((g) => `
          <div class="hbar acc-hbar" title="${g.hit} из ${g.n}">
            <span class="lbl">${esc(groupLabel(g.key)[0])} <small>${esc(groupLabel(g.key)[1])}</small></span>
            <div class="track"><div class="fill ${g.accuracy < 85 ? "weak" : ""}" style="width:${g.accuracy ?? 0}%"></div></div>
            <span class="num">${pct(g.accuracy)}</span>
          </div>`).join("")}
        <h3 style="margin-top:18px">Конфигурация прогона</h3>
        <dl class="acc-dl small">
          <dt>Чек-лист</dt><dd>${esc(run.checklist_name || "")} · v${esc(run.checklist_version ?? "?")}</dd>
          <dt>Модель</dt><dd>${esc(run.pipeline?.model || "—")} · рассуждения: ${thinking(run.pipeline)}</dd>
          <dt>Промпт · код</dt><dd class="mono">${esc(run.pipeline?.prompt_hash || "—")} · ${esc(run.pipeline?.code_hash || "—")}</dd>
          <dt>Эталон</dt><dd>v${res.ground_truth_version}</dd>
          <dt>Стоимость · время</dt><dd>$${fmtNum(run.cost_usd || 0, 3)} · ${run.avg_ms ? fmtNum(run.avg_ms / 1000, 1) + " с на оценку" : "—"}</dd>
        </dl>
      </section>
    </div>
    ${res.compare ? compareHtml(res.compare, run, critTitle, (id) => m.items.find((it) => it.id === id), critical) : ""}
    <section class="card">
      <div class="card-head"><h2>Расхождения с эталоном · ${rows.length}</h2><div class="spacer"></div>
        <select class="input" id="acc-crit" style="width:auto" aria-label="Критерий">
          <option value="">Все критерии</option>
          ${crits.map((c) => `<option value="${esc(c)}" ${c === st.crit ? "selected" : ""}>${esc(critTitle[c] || c)}</option>`).join("")}
        </select>
        <label class="check small"><input type="checkbox" id="acc-unsure" ${st.hideUnsure ? "checked" : ""}> скрыть спорные</label>
      </div>
      <div class="table-wrap">
        <table class="table">
          <thead><tr><th>Диалог</th><th>Критерий</th><th>Эталон</th><th>Модель</th><th>Объяснение модели</th><th class="num">Итог: эталон → модель</th></tr></thead>
          <tbody>
            ${rows.map(({ it, x }) => `
              <tr>
                <td class="acc-id"><a href="${link(it, x.criterion_id)}" class="mono">${esc(it.id)}</a>
                  <div class="muted small">${esc(it.language || "")}${it.kind ? ` · ${esc(KIND[it.kind] || it.kind)}` : ""}</div></td>
                <td>${esc(critTitle[x.criterion_id] || x.criterion_id)}${x.uncertain ? ` <span class="badge warn" title="Метка помечена в эталоне как спорная">спорно</span>` : ""}</td>
                <td>${ansBadge(x.gt, critical.has(x.criterion_id))}</td><td>${ansBadge(x.model, critical.has(x.criterion_id))}</td>
                <td class="small acc-expl">${esc(x.explanation || "")}</td>
                <td class="num">${it.total_gt ?? "—"} → ${it.total_model ?? "—"}</td>
              </tr>`).join("") || `<tr><td colspan="6" class="muted">Расхождений нет</td></tr>`}
          </tbody>
        </table>
      </div>
    </section>`;

  $("#acc-crit", host).addEventListener("change", (e) => { st.crit = e.target.value; drawDetail(root, runs); });
  $("#acc-unsure", host).addEventListener("change", (e) => { st.hideUnsure = e.target.checked; drawDetail(root, runs); });
}

function compareHtml(d, run, critTitle, itemOf, critical) {
  const line = (x, kind) => {
    const b = (v) => ansBadge(v, critical.has(x.criterion_id));
    const it = itemOf(x.id);
    const href = it ? `#/conversation/${encodeURIComponent(x.id)}?eval=${it.eval_id}&crit=${encodeURIComponent(x.criterion_id)}` : "#";
    const what = kind === "broken" ? `было верно (${b(x.gt)}), стало ${b(x.now)}` : `было ${b(x.was)}, стало верно ${b(x.gt)}`;
    return `<li><a class="mono" href="${href}">${esc(x.id)}</a> · ${esc(critTitle[x.criterion_id] || x.criterion_id)}: ${what}</li>`;
  };
  return `
    <section class="card card-pad acc-compare">
      <h3>Прогон #${run.id} против #${d.batch_id}</h3>
      <div class="acc-compare-cols">
        <div><div class="acc-delta up">Исправлено: ${d.fixed.length}</div><ul>${d.fixed.map((x) => line(x, "fixed")).join("") || "<li class=muted>—</li>"}</ul></div>
        <div><div class="acc-delta down">Сломано: ${d.broken.length}</div><ul>${d.broken.map((x) => line(x, "broken")).join("") || "<li class=muted>—</li>"}</ul></div>
      </div>
      <div class="muted small">Ошибок осталось в обоих прогонах: ${d.still.length}${d.still.some((x) => x.was !== x.now) ? ` (из них с другим неверным ответом: ${d.still.filter((x) => x.was !== x.now).length})` : ""}</div>
    </section>`;
}

// ---------------------------------------------------------------- dialogs ----
function uploadDialog(root, params, groups) {
  modal({
    title: "Загрузить эталон",
    submitText: "Загрузить",
    body: `
      <label class="field">Набор диалогов
        <select class="input" id="gt-group">${groups.map((g) => `<option value="${esc(g.id)}" ${g.id === st.group ? "selected" : ""}>${esc(g.id)}</option>`).join("")}</select></label>
      <label class="field">Файл JSON<input class="input" type="file" id="gt-file" accept=".json,application/json"></label>
      <label class="field">Что изменилось в этой версии эталона<input class="input" id="gt-note" placeholder="Например: 07 — строгая трактовка"></label>
      <p class="muted small">Загрузка создаёт новую версию эталона. Предыдущие версии сохраняются, точность можно смотреть по любой.</p>`,
    onSubmit: async (dlg) => {
      const f = $("#gt-file", dlg).files[0];
      if (!f) { toast("Выберите файл", true); return false; }
      const group = $("#gt-group", dlg).value;
      const r = await api.uploadGroundTruth(group, await f.text(), $("#gt-note", dlg).value);
      toast(`Эталон ${group} v${r.version}: ${r.labels} диалогов, найдено в наборе ${r.matched_conversations}`);
      st.group = group; st.gtId = "";
      render(root, params, {});
    },
  });
}

async function runDialog(root, params) {
  const cls = await api.checklists();
  const active = cls.find((c) => c.is_active) || cls[0];
  modal({
    title: `Новый прогон · ${st.group}`,
    submitText: "Запустить",
    body: `
      <label class="field">Чек-лист
        <select class="input" id="run-cl">${cls.map((c) => `<option value="${c.id}" ${c.id === active?.id ? "selected" : ""}>${esc(c.name)} · v${c.version}${c.is_active ? " (активный)" : ""}</option>`).join("")}</select></label>
      <label class="field">Что изменили (попадёт в историю версий)
        <textarea class="input" id="run-note" rows="3" placeholder="Например: уточнение к 06 — 4 vs 7"></textarea></label>
      <p class="muted small">Оцениваются заново все диалоги набора текущей версией системы. Модель, промпт и код фиксируются автоматически.</p>`,
    onSubmit: async (dlg) => {
      const b = await api.batch({ group: st.group, checklist_id: Number($("#run-cl", dlg).value), only_missing: false,
                                  note: $("#run-note", dlg).value });
      watch(root, params, b.id);
    },
  });
}

function watch(root, params, id) {
  stop();
  const bar = $("#acc-progress", root);
  const tick = async () => {
    const b = await api.batchStatus(id).catch(() => null);
    if (!b || !bar.isConnected) return stop();
    bar.innerHTML = `<div class="card card-pad acc-running">Прогон #${b.id}: ${b.done + b.failed} из ${b.total}${b.failed ? ` · ошибок ${b.failed}` : ""} · $${fmtNum(b.cost_usd || 0, 3)}
      <div class="acc-bar"><i style="width:${b.total ? ((b.done + b.failed) / b.total) * 100 : 0}%"></i></div></div>`;
    if (b.status === "finished") { stop(); st.run = b.id; toast(`Прогон #${b.id} завершён`); render(root, params, {}); }
  };
  tick();
  st.poll = setInterval(tick, 3000);
}

function noteDialog(root, params, run) {
  modal({
    title: `Заметка к прогону #${run.id}`,
    body: `<label class="field">Что изменили<textarea class="input" id="n-text" rows="3">${esc(run.note || "")}</textarea></label>`,
    onSubmit: async (dlg) => { await api.updateBatchNote(run.id, $("#n-text", dlg).value); render(root, params, {}); },
  });
}
