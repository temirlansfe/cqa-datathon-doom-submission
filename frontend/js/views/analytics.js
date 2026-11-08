import { api } from "../api.js";
import { esc, $, fmtNum, scoreClass, LANG, CHANNEL, plural, icon, pct } from "../util.js";

const st = { group: "", checklist_id: "" };
const LANG_ORDER = ["RU", "KZ", "EN"];

export async function render(root) {
  const [groups, checklists, meta] = await Promise.all([api.groups(), api.checklists(), api.meta().catch(() => null)]);
  if (st.group && !groups.some((g) => g.id === st.group)) st.group = "";
  if (!checklists.some((c) => String(c.id) === st.checklist_id)) {
    st.checklist_id = String((checklists.find((c) => c.is_active) || checklists[0])?.id || "");
  }
  const params = { group: st.group || null, checklist_id: st.checklist_id || null };
  const cl = checklists.find((c) => String(c.id) === st.checklist_id);
  const [s, rows, full] = await Promise.all([
    api.stats(params),
    api.conversations(params),
    cl ? api.checklist(cl.id) : Promise.resolve(null),
  ]);
  const cfg = full?.config || { criteria: [], sections: [] };
  const done = rows.filter((r) => r.status === "done" && r.final_total !== null);

  root.innerHTML = `<div class="an-page">
    <div class="page-head">
      <div><h1>Аналитика</h1>
        <div class="sub">Последняя оценка каждого диалога выбранной версией чек-листа, с учётом решений по апелляциям.</div></div>
      <div class="spacer"></div>
      <div class="an-filters">
        <label class="field">Набор
          <select class="input" id="a-group">
            <option value="">Все наборы</option>
            ${groups.map((g) => `<option value="${esc(g.id)}" ${g.id === st.group ? "selected" : ""}>${esc(g.id)} (${g.count})</option>`).join("")}
          </select></label>
        <label class="field">Чек-лист
          <select class="input" id="a-cl">
            ${checklists.map((c) => `<option value="${c.id}" ${String(c.id) === st.checklist_id ? "selected" : ""}>${esc(c.name)} · v${c.version}${c.is_active ? " (активный)" : ""}</option>`).join("")}
          </select></label>
        <a class="btn" href="${esc(api.exportUrl(params))}" download>${icon("download")}Экспорт CSV</a>
      </div>
    </div>
    ${kpis(s, rows, done, meta)}
    ${s.evaluated ? charts(s, rows, done, cfg) : `
      <div class="card empty-state">
        <div class="ic">${icon("score")}</div>
        <h3>Пока нет оценок${cl ? ` по «${esc(cl.name)} v${esc(cl.version)}»` : ""}</h3>
        <p>Запустите оценку диалогов этой версией чек-листа — здесь появятся распределения, разбивки и результаты по критериям.</p>
        <a class="btn btn-primary" href="#/conversations">${icon("play")}К диалогам</a>
      </div>`}
  </div>`;

  $("#a-group", root).addEventListener("change", (e) => { st.group = e.target.value; rerender(root); });
  $("#a-cl", root).addEventListener("change", (e) => { st.checklist_id = e.target.value; rerender(root); });
}

async function rerender(root) {
  const page = root.firstElementChild;
  if (page) page.style.opacity = ".55";
  root.setAttribute("aria-busy", "true");
  try { await render(root); } finally { root.removeAttribute("aria-busy"); }
}

function median(xs) {
  if (!xs.length) return null;
  const a = [...xs].sort((x, y) => x - y), m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

function kpis(s, rows, done, meta) {
  const sc = scoreClass(s.avg_total);
  const evalPct = pct(s.evaluated, rows.length);
  const med = median(done.map((r) => Number(r.final_total)));
  const totalCost = s.avg_cost_usd !== null && s.avg_cost_usd !== undefined ? s.avg_cost_usd * s.evaluated : null;
  const ap = s.appeals || { open: 0, changed: 0, confirmed: 0 };
  return `
    <div class="kpis">
      <div class="card kpi">
        <div class="lbl">${icon("done")}Оценено диалогов</div>
        <div class="v">${s.evaluated}${rows.length ? `<small> / ${rows.length}</small>` : ""}</div>
        <div class="meter" title="${fmtNum(evalPct, 0)}% набора оценено"><i style="width:${Math.min(100, evalPct ?? 0)}%"></i></div>
      </div>
      <div class="card kpi ${sc === "hi" ? "is-good" : sc === "mid" ? "is-warn" : sc === "lo" ? "is-bad" : ""}">
        <div class="lbl">${icon("score")}Средний итог</div>
        <div class="v">${fmtNum(s.avg_total)}<small> / 100</small></div>
        <div class="foot">${med !== null ? `медиана ${fmtNum(med)}` : "—"}</div>
      </div>
      <div class="card kpi ${s.critical ? "is-bad" : ""}">
        <div class="lbl">${icon("alert")}Грубые ошибки</div>
        <div class="v">${s.critical}</div>
        <div class="foot">${s.evaluated ? `${fmtNum(pct(s.critical, s.evaluated), 0)}% оценённых диалогов` : "—"}</div>
      </div>
      <a class="card kpi ${ap.open ? "is-warn" : ""}" href="#/appeals" title="Перейти к апелляциям">
        <span class="lbl">${icon("scale")}Апелляции открыты</span>
        <span class="v">${ap.open}</span>
        <span class="foot" title="По всем наборам и версиям">изменено ${ap.changed} · подтв. ${ap.confirmed}</span>
      </a>
      <div class="card kpi">
        <div class="lbl">${icon("coin")}Стоимость оценки</div>
        <div class="v">${s.avg_cost_usd !== null && s.avg_cost_usd !== undefined ? `$${fmtNum(s.avg_cost_usd, 4)}` : "—"}</div>
        <div class="foot">${totalCost !== null ? `≈ $${fmtNum(totalCost, 3)} за ${s.evaluated} ${plural(s.evaluated, ["диалог", "диалога", "диалогов"])}` : "нет данных"}</div>
      </div>
      <div class="card kpi">
        <div class="lbl">${icon("clock")}Время оценки</div>
        <div class="v">${s.avg_duration_ms ? fmtNum(s.avg_duration_ms / 1000, 1) : "—"}<small> с</small></div>
        <div class="foot">${meta?.model ? `модель ${esc(meta.model)}` : "в среднем на диалог"}</div>
      </div>
    </div>`;
}

function hbars(entries, labelOf) {
  if (!entries.length) return `<div class="muted small">Нет данных</div>`;
  return `
    ${entries.map(([k, v]) => {
      const { label, sub } = labelOf(k);
      return `
      <div class="hbar" title="${esc(`${sub || label}: ${v.n} ${plural(v.n, ["диалог", "диалога", "диалогов"])}, средний итог ${fmtNum(v.avg)}`)}">
        <span class="lbl"><b class="l1">${esc(label)}${sub ? ` <span>${esc(sub)}</span>` : ""}</b><small>${v.n} ${plural(v.n, ["диалог", "диалога", "диалогов"])}</small></span>
        <div class="track"><div class="fill" style="width:${Math.max(0, Math.min(100, Number(v.avg) || 0))}%"></div></div>
        <span class="num">${fmtNum(v.avg)}</span>
      </div>`;
    }).join("")}
    <div class="hbar-axis" aria-hidden="true"><span></span><div><span>0</span><span>50</span><span>100</span></div><span></span></div>`;
}

function charts(s, rows, done, cfg) {
  const byLang = Object.entries(s.by_language || {})
    .sort(([a], [b]) => (LANG_ORDER.indexOf(a) + 1 || 99) - (LANG_ORDER.indexOf(b) + 1 || 99) || a.localeCompare(b));
  const chanMap = {};
  done.forEach((r) => { (chanMap[r.channel || "—"] ||= []).push(Number(r.final_total)); });
  const byChan = Object.entries(chanMap).map(([k, xs]) => [k, { n: xs.length, avg: xs.reduce((a, b) => a + b, 0) / xs.length }])
    .sort((a, b) => b[1].n - a[1].n);

  const hist = s.histogram || [];
  const histMax = Math.max(1, ...hist);
  const avg = Number(s.avg_total);
  const histHtml = `
    <div class="hist" role="img" aria-label="Распределение итоговых баллов: ${esc(hist.map((n, i) => `${i * 10}–${i === 9 ? 100 : i * 10 + 9}: ${n}`).join(", "))}">
      ${hist.map((n, i) => {
        const h = (n / histMax) * 100;
        return `<div class="bin" title="${i * 10}–${i === 9 ? 100 : i * 10 + 9}: ${n} ${plural(n, ["диалог", "диалога", "диалогов"])}">
          <i style="height:${h}%"></i>${n ? `<span style="bottom:calc(${h}% + 2px)">${n}</span>` : ""}</div>`;
      }).join("")}
      ${Number.isFinite(avg) && s.avg_total !== null ? `<div class="avg-line ${avg > 70 ? "flip" : ""}" style="left:${Math.max(0, Math.min(100, avg))}%"><span>среднее ${fmtNum(avg)}</span></div>` : ""}
    </div>
    <div class="hist-x" aria-hidden="true">${hist.map((_, i) => `<span>${i * 10}</span>`).join("")}</div>`;

  // Criteria in checklist order, then any extra ids found in the stats.
  const metaById = Object.fromEntries((cfg.criteria || []).map((c) => [c.id, c]));
  const ids = [...(cfg.criteria || []).map((c) => c.id).filter((id) => s.criteria[id]), ...Object.keys(s.criteria).filter((id) => !metaById[id])];
  const secTitle = Object.fromEntries((cfg.sections || []).map((x) => [x.id, x.title]));
  const scoredW = (cfg.criteria || []).filter((c) => c.type !== "critical").reduce((a, c) => a + Number(c.weight || 0), 0);
  const rowsData = ids.map((id) => {
    const d = s.criteria[id], c = metaById[id] || { id, title: id, type: d.scale ? "scale" : "binary" };
    const isCrit = c.type === "critical";
    const applicable = d.yes + d.no;
    let rate = null, result = "—", basis = "";
    if (c.type === "scale") {
      const top = Math.max(...(c.scale || []).map((x) => Number(x.value)), 0);
      if (d.scale && top) {
        const average = d.scale_sum / d.scale;
        rate = average / top * 100;
        result = `${fmtNum(average, 1)} из ${fmtNum(top)}`;
        basis = `по ${d.scale} ${plural(d.scale, ["оценке", "оценкам", "оценкам"])}`;
      }
    } else if (applicable) {
      if (isCrit) {
        result = `${d.yes} выявлено`;
      } else {
        rate = d.yes / applicable * 100;
        result = `${fmtNum(rate, 0)}%`;
        basis = `${d.yes} из ${applicable}`;
      }
    }
    return { d, c, isCrit, rate, result, basis };
  });
  const weakest = rowsData.filter((r) => r.c.type === "binary" && r.rate !== null).sort((a, b) => a.rate - b.rate)[0];
  const typeShort = (c) => (c.type === "scale" ? "шкала" : c.type === "critical" ? "флаг" : "да / нет");

  const critTable = `
    <div class="card" style="margin-top:16px">
      <div class="card-head"><h2>Результаты по критериям</h2><div class="spacer"></div>
        <div class="legend" aria-label="Легенда">
          <span><i style="background:var(--good)"></i>Выполнено / грубых ошибок нет</span>
          <span><i style="background:var(--bad)"></i>Не выполнено / грубая ошибка</span>
          <span><i style="background:var(--na-mark)"></i>N/A</span>
          <span><i style="background:var(--brand-600)"></i>Шкала: средний балл от максимума</span>
        </div></div>
      <div class="table-wrap" style="max-height:none">
      <table class="table crit-table">
        <caption class="sr-only">Ответы по критериям чек-листа</caption>
        <thead><tr><th>Критерий</th><th class="col-opt">Тип</th><th class="num col-opt">Вес</th>
          <th class="num col-opt">Да</th><th class="num col-opt">Нет</th><th class="num col-opt">N/A</th><th class="num">Результат</th><th style="width:24%" class="dist col-opt">Диаграмма</th></tr></thead>
        <tbody>
          ${rowsData.map(({ d, c, isCrit, rate, result, basis }) => {
            const good = isCrit ? d.no : d.yes, bad = isCrit ? d.yes : d.no;
            const total = good + bad + d.na;
            const tip = c.type === "scale"
              ? `Оценок по шкале: ${d.scale} · средний балл: ${result} · N/A: ${d.na}`
              : `${isCrit ? "Да (выявлено)" : "Да"}: ${d.yes} · ${isCrit ? "Нет (не выявлено)" : "Нет"}: ${d.no} · N/A: ${d.na}`;
            const bar = c.type === "scale"
              ? `<div class="stack" title="${esc(tip)}"><i class="s-scale" style="flex:${rate ?? 0}"></i><i class="s-rest" style="flex:${100 - (rate ?? 0)}"></i></div>`
              : `<div class="stack" title="${esc(tip)}">${good ? `<i class="s-yes" style="flex:${good}"></i>` : ""}${bad ? `<i class="s-no" style="flex:${bad}"></i>` : ""}${d.na ? `<i class="s-na" style="flex:${d.na}"></i>` : ""}${total ? "" : `<i class="s-na" style="flex:1"></i>`}</div>`;
            const share = c.type !== "critical" && scoredW ? (Number(c.weight || 0) / scoredW) * 100 : null;
            return `<tr ${isCrit && d.yes ? 'style="background:#fff7f5"' : ""}>
              <td><span class="ct-title"><span><span class="mono muted">${esc(c.code || "")}</span> <b>${esc(c.title)}</b></span>${secTitle[c.section] ? `<small>${esc(secTitle[c.section])}</small>` : ""}</span></td>
              <td class="small muted col-opt">${typeShort(c)}</td>
              <td class="num col-opt" title="${share !== null ? `${fmtNum(share, 1)}% итога` : "без баллов"}">${c.type === "critical" ? "—" : fmtNum(c.weight)}</td>
              <td class="num col-opt">${c.type === "scale" ? "—" : d.yes}</td>
              <td class="num col-opt">${c.type === "scale" ? "—" : d.no}</td>
              <td class="num col-opt">${d.na}</td>
              <td class="num"><span class="pct" title="${esc(tip)}">${esc(result)}</span>${basis ? `<small class="ct-basis">${esc(basis)}</small>` : ""}</td>
              <td class="dist col-opt">${bar}</td>
            </tr>`;
          }).join("") || `<tr><td colspan="8" class="empty">Нет оценок</td></tr>`}
        </tbody>
      </table></div>
      <div class="card-pad">
        <p class="crit-table-note muted small">N/A исключается из процента выполнения и среднего балла. «Да» по грубым ошибкам означает, что нарушение выявлено.</p>
        ${weakest ? `<div class="insight">${icon("bulb")}<div>Реже всего выполняется среди критериев «Да / Нет» — <b>${esc(weakest.c.code || "")} ${esc(weakest.c.title)}</b> (${esc(weakest.result)}, ${esc(weakest.basis)} применимых диалогов).</div></div>` : ""}
      </div>
    </div>`;

  return `
    <div class="an-grid-3">
      <div class="card card-pad">
        <div class="card-title">Средний итог по языкам</div>
        ${hbars(byLang, (k) => ({ label: k, sub: LANG[k] || "" }))}
      </div>
      <div class="card card-pad">
        <div class="card-title">Средний итог по каналам</div>
        ${hbars(byChan, (k) => ({ label: CHANNEL[k] || k, sub: "" }))}
      </div>
      <div class="card card-pad">
        <div class="card-title">Распределение итоговых баллов <span class="muted">${s.evaluated} ${plural(s.evaluated, ["диалог", "диалога", "диалогов"])}</span></div>
        ${histHtml}
      </div>
    </div>
    ${critTable}`;
}
