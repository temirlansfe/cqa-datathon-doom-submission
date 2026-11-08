// Conversation card: transcript, recording, evaluation and appeals.
// Deep links can open a criterion, focus a message, or jump to section=deductions.
import { api } from "../api.js";
import { esc, $, $$, fmtNum, fmtDate, toast, busy, modal, answerView, tsSeconds, fmtClock, LANG, CHANNEL, icon, watchMenuSpace } from "../util.js";
import { refreshBadge } from "../app.js";
import { createPlayer, buildSegments, audioTimeline } from "../card/player.js";
import { msgHtml, scrollInBox } from "../card/transcript.js";
import { critHtml, findingsHtml, lossItems, metaHtml, loadingHtml, updateLoading, firstRef, plural, isRevised, changeReview } from "../card/score.js";

let ctx = null;

const FILTERS = [
  { key: "all", label: "Все" },
  { key: "client", label: "Клиент" },
  { key: "operator", label: "Оператор" },
  { key: "ctx", label: "Бот · система" },
];
export async function render(root, params, query) {
  const [conv, checklists] = await Promise.all([api.conversation(params.id), api.checklists()]);
  // Superseded by a newer navigation: the router already detached this host.
  if (!root.isConnected) return undefined;
  const first = conv.transcript[0]?.timestamp;
  const seconds = conv.transcript.map((m) => tsSeconds(m.timestamp, first));
  const known = seconds.filter((s) => s !== null && s !== undefined);
  const duration = known.length ? Math.max(...known) : null;
  const isCall = conv.channel === "voice call" || !!conv.audio_url;
  const history = conv.evaluations.find((ev) => ev.id === Number(query.eval)) || conv.evaluations[0];
  const selected = checklists.find((c) => c.id === Number(query.checklist))
    || checklists.find((c) => c.is_active) || checklists[0];
  const hasCtx = conv.transcript.some((m) => !["client", "operator"].includes(String(m.speaker || "").toLowerCase()));

  // For calls, message positions are in recording time (start / cut pause / lead), not transcript time.
  const clock = (arr) => arr.map((s) => (s === null || s === undefined ? null : fmtClock(s)));
  const audioSec = isCall && conv.audio_url ? audioTimeline(conv.transcript, seconds, null) : seconds;
  ctx = {
    root, conv, checklists, seconds: audioSec, isCall, evaluation: null, player: null,
    openCrit: query.crit || null, compareId: Number(query.compare) || null,
    followUntil: 0, loadingTimer: null, pollTimer: null,
    rel: isCall ? clock(audioSec) : null,
  };
  const mine = ctx;

  const chan = CHANNEL[conv.channel] || (isCall ? "Звонок" : conv.channel || "Диалог");
  const started = /^\d{4}-\d{2}-\d{2}T/.test(first || "") ? new Date(first) : null;
  const date = started && Number.isFinite(started.valueOf())
    ? started.toLocaleString("ru-RU", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" }) : "";
  root.innerHTML = `<div class="cv-page" data-pane="score">
    <div class="crumbs cv-back"><a href="#/conversations">${icon("back")}Все разговоры</a></div>
    <div class="page-head cv-head">
      <div class="cv-head-main">
        <h1>${esc(conv.title?.trim() || (isCall ? "Разбор звонка" : "Разбор чата"))}</h1>
        <div class="cv-head-sub">
          <span>${esc(chan)} №${esc(conv.id)}</span>
          ${date ? `<span>${esc(date)}</span>` : ""}
          ${conv.language ? `<span>${esc(LANG[conv.language] || conv.language)}</span>` : ""}
          ${!date && isCall && duration ? `<span>${fmtClock(duration)}</span>` : ""}
        </div>
      </div>
      <details class="action-menu cv-settings" id="cv-settings" ${!history || (selected && selected.id !== history.checklist_id) ? "open" : ""}>
        <summary class="btn" id="cv-settings-label">${history ? "Переоценка" : "Чек-лист и оценка"}</summary>
        <div class="action-menu-panel cv-eval-ctl">
          <label class="field" for="sel-checklist">Чек-лист</label>
          <select class="input" id="sel-checklist">
            ${checklists.map((c) => `<option value="${c.id}" ${c.id === selected?.id ? "selected" : ""}>v${c.version} · ${esc(c.name)}${c.is_active ? " (активный)" : ""}</option>`).join("")}
          </select>
          <div class="cv-eval-actions">
            <a class="btn" id="cv-edit-checklist">Изменить чек-лист</a>
            <button class="btn btn-primary" id="btn-eval" type="button">${history ? "Переоценить диалог" : "Оценить диалог"}</button>
          </div>
          <div id="cv-version-ready" class="qa-handoff" hidden></div>
        </div>
      </details>
    </div>
    <div class="cv-pane-switch" role="group" aria-label="Разделы карточки">
      <button class="btn" type="button" data-cv-pane="score" aria-pressed="true" aria-controls="eval-panel">Оценка</button>
      <button class="btn" type="button" data-cv-pane="transcript" aria-pressed="false" aria-controls="cv-transcript-card">${isCall ? "Запись и реплики" : "Переписка"}</button>
    </div>
    <div class="cv-grid">
      <section class="card cv-ev-card" id="eval-panel" aria-label="Оценка качества" tabindex="0"></section>
      <section class="card cv-tr-card" id="cv-transcript-card" aria-label="${isCall ? "Запись и расшифровка" : "Переписка"}">
        <div class="card-head cv-tr-head">
          <h2>${isCall ? "Запись и расшифровка" : "Переписка"}</h2><div class="spacer"></div>
          <details class="cv-filter-menu">
            <summary aria-label="Фильтр реплик">${icon("filter")}<span>Реплики</span></summary>
            <div class="cv-filter" role="group" aria-label="Фильтр по участнику">
              ${FILTERS.filter((f) => f.key !== "ctx" || hasCtx).map((f) => `<button type="button" data-filter="${f.key}" aria-pressed="${f.key === "all"}">${esc(f.label)}</button>`).join("")}
            </div>
          </details>
        </div>
        <div class="cv-tr-body">
          ${isCall ? `<div id="cv-player-host"></div>` : ""}
          <div class="cv-tr-ctx" id="cv-tr-ctx" hidden></div>
          <div class="cv-transcript${isCall ? "" : " cv-transcript--chat"}" id="transcript" data-filter="all" tabindex="0" role="region" aria-label="Реплики диалога">
            ${conv.transcript.map((m, i) => msgHtml(m, i + 1, { chat: !isCall, sec: audioSec[i], playable: isCall && !!conv.audio_url })).join("")}
          </div>
        </div>
        <button type="button" class="cv-follow" id="cv-follow" hidden>↓ К текущей реплике</button>
      </section>
    </div></div>`;

  const stopWatching = watchMenuSpace($(".cv-head", root), $(".cv-grid", root));
  const cleanup = () => {
    stopWatching();
    if (mine.player) mine.player.destroy();
    clearInterval(mine.loadingTimer);
    clearTimeout(mine.pollTimer);
    if (ctx === mine) ctx = null;
  };
  const tr = $("#transcript", root);
  $$("[data-cv-pane]", root).forEach((button) => button.addEventListener("click", () => showPane(root, button.dataset.cvPane)));
  tr.addEventListener("click", (e) => {
    const p = e.target.closest("[data-play]");
    if (p) playAt(Number(p.dataset.play));
  });
  // Manual scrolling pauses karaoke auto-follow for a few seconds.
  const pauseFollow = () => { if (ctx) ctx.followUntil = Date.now() + 6000; };
  ["wheel", "touchmove", "keydown", "mousedown"].forEach((t) => tr.parentElement.addEventListener(t, pauseFollow, { passive: true }));
  $("#cv-follow", root).addEventListener("click", () => {
    ctx.followUntil = 0;
    $("#cv-follow", root).hidden = true;
    const el = $(".cv-msg.is-playing", root);
    if (el) scrollInBox(transcriptScroller(tr), el);
  });
  $$(".cv-filter [data-filter]", root).forEach((b) => b.addEventListener("click", () => {
    setFilter(b.dataset.filter);
    b.closest("details").open = false;
    b.closest("details").querySelector("summary").focus();
  }));
  $("#cv-tr-ctx", root).addEventListener("click", (e) => {
    if (e.target.closest("[data-clear]")) toggleCrit(ctx.openCrit);
  });
  $("#btn-eval", root).addEventListener("click", (e) => runEvaluation(e.currentTarget));
  $("#sel-checklist", root).addEventListener("change", updateChecklistControls);
  updateChecklistControls();

  if (isCall) {
    const mineCtx = ctx;
    ctx.player = createPlayer($("#cv-player-host", root), {
      // The organizer link is an HTML page with an hourly-expiring mp3 link; the backend caches the file.
      audioUrl: conv.audio_url ? api.audioUrl(conv.id) : null,
      sourceUrl: conv.audio_url || null,
      segments: buildSegments(conv.transcript, audioSec),
      retime: (duration) => {
        // The real file length tells how much of the recording pause was cut out.
        const sec = audioTimeline(conv.transcript, seconds, duration);
        mineCtx.seconds = sec;
        mineCtx.rel = clock(sec);
        $$('[data-cv-ref]', root).forEach((b) => {
          const time = mineCtx.rel[Number(b.dataset.cvRef) - 1];
          b.textContent = time ? `К реплике на ${time}` : `К реплике №${b.dataset.cvRef}`;
        });
        $$("[data-play]", root).forEach((b) => {
          const s = sec[Number(b.dataset.play) - 1];
          if (s === null || s === undefined) return;
          b.lastChild.textContent = fmtClock(s);
          b.setAttribute("aria-label", `Прослушать реплику #${b.dataset.play} с ${fmtClock(s)}`);
        });
        return buildSegments(conv.transcript, sec);
      },
      onSegment: (n) => focusMsg(n, { seek: false }),
      onActive: (n, isPlaying) => karaoke(n, isPlaying),
    });
  }

  if (history) await loadEvaluation(history.id);
  else drawEmpty();
  if (ctx === mine) {
    if (query.msg) focusMsg(Number(query.msg), { page: true });
    else if (query.section === "deductions") showDeductions(root);
  }
  return cleanup;
}

export function onQuery(query) {
  if (!ctx) return;
  const owner = ctx;
  const go = async () => {
    const kid = Number(query.checklist);
    if (ctx.checklists.some((c) => c.id === kid)) {
      $("#sel-checklist", ctx.root).value = String(kid);
      updateChecklistControls();
    }
    const id = Number(query.eval);
    const compareId = Number(query.compare) || null;
    if (id !== ctx.evaluation?.id && ctx.conv.evaluations.some((ev) => ev.id === id)) {
      ctx.openCrit = query.crit || null;
      ctx.compareId = compareId;
      await loadEvaluation(id);
    } else if (ctx.evaluation && compareId !== ctx.compareId) {
      ctx.openCrit = query.crit || null;
      ctx.compareId = compareId;
      drawEvaluation(ctx.evaluation);
    } else if (query.crit && query.crit !== ctx.openCrit) {
      toggleCrit(query.crit, true, { focus: !query.msg });
    }
    if (ctx !== owner) return;
    if (query.msg) focusMsg(Number(query.msg), { page: true });
    else if (query.section === "deductions") showDeductions(owner.root);
  };
  go().catch((e) => toast(e.message, true));
}

function showDeductions(root) {
  // The router focuses the view after rendering. Move focus to the requested heading after that.
  requestAnimationFrame(() => {
    if (!root.isConnected) return;
    const heading = $("#cv-loss-heading", root);
    if (!heading) return;
    showPane(root, "score");
    scrollInBox($("#eval-panel", root), heading, { smooth: false });
    heading.focus({ preventScroll: true });
  });
}

function showPane(root, pane) {
  const page = $(".cv-page", root);
  if (page.dataset.pane === pane) return false;
  page.dataset.pane = pane;
  $$("[data-cv-pane]", page).forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.cvPane === pane)));
  return $(".cv-pane-switch", page).offsetWidth > 0;
}

function transcriptScroller(transcript) {
  return getComputedStyle(transcript).overflowY === "visible" ? transcript.parentElement : transcript;
}

// ------------------------------------------------------------ transcript ----

function setFilter(key) {
  const tr = $("#transcript", ctx.root);
  tr.dataset.filter = key;
  $$(".cv-filter [data-filter]", ctx.root).forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.filter === key)));
}

function playAt(n) {
  const s = ctx.seconds[n - 1];
  focusMsg(n, { seek: false });
  if (!ctx.player || s === null || s === undefined) return;
  if (!ctx.player.hasAudio()) { toast("Запись недоступна в браузере — откройте её по ссылке «Открыть в плеере»", true); return; }
  ctx.followUntil = 0;
  ctx.player.seekTo(s, { autoplay: true });
}

/** Highlight + scroll to a message. For calls the recording is positioned there too. */
function focusMsg(n, { seek = true, scroll = true, page = false } = {}) {
  if (!ctx) return;
  const el = $(`#msg-${n}`, ctx.root);
  if (!el) return;
  const tr = $("#transcript", ctx.root);
  if (tr.dataset.filter !== "all" && !matchesFilter(el, tr.dataset.filter)) setFilter("all");
  $$(".cv-msg.is-focus", ctx.root).forEach((m) => m.classList.remove("is-focus"));
  el.classList.add("is-focus");
  // restart the flash animation
  el.classList.remove("is-flash"); void el.offsetWidth; el.classList.add("is-flash");
  if (scroll) {
    ctx.followUntil = Date.now() + 4000;
    if (page && showPane(ctx.root, "transcript")) tr.focus({ preventScroll: true });
    if (tr.clientHeight) scrollInBox(transcriptScroller(tr), el);
  }
  if (ctx.player) {
    ctx.player.setMarks({ focus: n });
    if (seek && ctx.player.hasAudio()) ctx.player.seekTo(ctx.seconds[n - 1], { autoplay: false });
  }
}

const matchesFilter = (el, f) => f === "all" || (f === "ctx" ? !["client", "operator"].includes(el.dataset.sp) : el.dataset.sp === f);

function karaoke(n, isPlaying) {
  if (!ctx) return;
  $$(".cv-msg.is-playing", ctx.root).forEach((m) => m.classList.remove("is-playing"));
  if (!n) return;
  const el = $(`#msg-${n}`, ctx.root);
  if (!el) return;
  el.classList.add("is-playing");
  if (!isPlaying) return;
  const tr = $("#transcript", ctx.root);
  const follow = $("#cv-follow", ctx.root);
  if (Date.now() >= ctx.followUntil) { if (tr.clientHeight) scrollInBox(transcriptScroller(tr), el); follow.hidden = true; }
  else follow.hidden = false;
}

function markEvidence(row, crit, { announce = true } = {}) {
  $$(".cv-msg.is-evidence, .cv-msg.in-range", ctx.root).forEach((m) => m.classList.remove("is-evidence", "in-range"));
  const bar = $("#cv-tr-ctx", ctx.root);
  const original = row && ctx.evaluation?.criteria?.find((r) => r.criterion_id === row.criterion_id);
  const revised = isRevised(row, original);
  $(".cv-tr-card", ctx.root).classList.toggle("is-critical-evidence", !revised && crit?.type === "critical" && row?.answer === "yes");
  const range = [];
  if (row?.checked_range && (announce || !row.evidence?.length)) {
    for (let n = row.checked_range[0]; n <= row.checked_range[1]; n++) range.push(n);
  }
  if (row) {
    (row.evidence || []).forEach((n) => $(`#msg-${n}`, ctx.root)?.classList.add("is-evidence"));
    range.forEach((n) => $(`#msg-${n}`, ctx.root)?.classList.add("in-range"));
  }
  if (ctx.player) ctx.player.setMarks({ evidence: row ? row.evidence || [] : [], range, focus: null });
  const ev = row?.evidence?.length || 0;
  if (!crit || !announce || (!ev && !range.length)) { bar.hidden = true; bar.innerHTML = ""; return; }
  bar.hidden = false;
  bar.innerHTML = `
    <span class="cv-tr-ctx-dot" aria-hidden="true"></span>
    <span class="cv-tr-ctx-text">${revised ? "Фрагменты из оценки модели" : ev ? `Подсвечено ${ev} ${plural(ev, "доказательство", "доказательства", "доказательств")}` : "Подсвечен проверенный участок"} по критерию
      <b>${crit.code ? esc(crit.code) + " " : ""}${esc(crit.title)}</b>${range.length ? ` · участок #${range[0]}–#${range[range.length - 1]}` : ""}</span>
    <button type="button" class="cv-x" data-clear aria-label="Снять подсветку">✕</button>`;
}

// ------------------------------------------------------------ evaluation ----

function updateChecklistControls() {
  const kid = Number($("#sel-checklist", ctx.root).value);
  const cl = ctx.checklists.find((item) => item.id === kid);
  const edit = $("#cv-edit-checklist", ctx.root);
  edit.hidden = !cl;
  if (cl) {
    const q = new URLSearchParams({ conversation: ctx.conv.id });
    if (ctx.evaluation) q.set("eval", ctx.evaluation.id);
    edit.href = `#/checklists/${cl.id}?${q}`;
  }
  const ready = $("#cv-version-ready", ctx.root);
  const ev = ctx.evaluation;
  const changed = cl && ev?.status === "done" && ev.checklist_id !== kid;
  const canCheckRule = changed && cl.name === ev.checklist_name && cl.version > ev.checklist_version;
  const ruleCheckQuery = canCheckRule ? new URLSearchParams({
    baseline: ev.checklist_id, ...(ctx.openCrit ? { criterion: ctx.openCrit } : {}),
  }) : null;
  ready.hidden = !changed;
  if (changed) $("#cv-settings", ctx.root).open = true;
  ready.innerHTML = changed ? `<span class="qa-handoff-icon">${icon("refresh")}</span>
    <div><b>Выбрана другая версия чек-листа · v${esc(cl.version)}</b>
    <div>Нажмите «Переоценить диалог», чтобы применить её к этому разговору.</div></div>
    ${canCheckRule ? `<a class="btn" href="#/checklists/${kid}/rule-check?${esc(String(ruleCheckQuery))}">Сравнить версии правила</a>` : ""}` : "";
}

function panelHead(ev) {
  const hist = ctx.conv.evaluations;
  return `
    <div class="card-head cv-ev-head">
      <h2>Оценка качества</h2>
      ${hist.length > 1 ? `<label class="cv-sr" for="sel-eval">История оценок</label>
        <select class="input cv-hist" id="sel-eval">
          ${hist.map((h) => `<option value="${h.id}" ${ev && h.id === ev.id ? "selected" : ""}>#${h.id} · ${esc(h.checklist_name)} v${h.checklist_version} · ${esc(fmtDate(h.created_at))}${h.status === "error" ? " · ошибка" : h.final_total !== null && h.final_total !== undefined ? ` · ${fmtNum(h.final_total)}` : ""}</option>`).join("")}
        </select>`
      : ""}
    </div>`;
}

function drawEmpty() {
  stopLoading();
  $("#eval-panel", ctx.root).innerHTML = `${panelHead(null)}
    <div class="cv-empty">
      <b>Диалог ещё не оценён</b>
      <span>Выберите чек-лист и нажмите «Оценить диалог».</span>
    </div>`;
  bindHistory();
}

function startLoading(ev) {
  stopLoading();
  const kid = Number($("#sel-checklist", ctx.root).value);
  const cl = ctx.checklists.find((c) => c.id === kid);
  const crits = ev?.checklist?.criteria?.length || cl?.criteria_count || 0;
  $("#eval-panel", ctx.root).innerHTML = panelHead(ev) + loadingHtml({ messages: ctx.conv.transcript.length, criteria: crits });
  bindHistory();
  const t0 = ev && ev.created_at ? Math.min(Date.now(), Date.parse(ev.created_at)) : Date.now();
  const panel = $("#eval-panel", ctx.root);
  const tickFn = () => updateLoading(panel, (Date.now() - t0) / 1000);
  tickFn();
  ctx.loadingTimer = setInterval(tickFn, 500);
}

function stopLoading() {
  if (ctx) clearInterval(ctx.loadingTimer);
}

async function runEvaluation(btn) {
  const kid = Number($("#sel-checklist", ctx.root).value);
  const sel = $("#sel-checklist", ctx.root);
  busy(btn, true, "Оценка…");
  sel.disabled = true;
  $("#cv-settings", ctx.root).open = false;
  showPane(ctx.root, "score");
  startLoading(null);
  const mine = ctx;
  const previous = ctx.evaluation;
  try {
    const ev = await api.evaluate(ctx.conv.id, kid);
    if (ctx !== mine) return;
    const updated = await api.conversation(mine.conv.id);
    if (ctx !== mine) return;
    ctx.conv = { ...ctx.conv, evaluations: updated.evaluations };
    ctx.compareId = previous?.status === "done" && previous.checklist_id !== ev.checklist_id ? previous.id : null;
    ctx.openCrit = null;
    drawEvaluation(ev);
    setUrl();
    if (ev.status === "error") toast(`Ошибка оценки: ${ev.error}`, true);
    else toast(`Оценка готова: ${fmtNum(ev.final_total)} из 100`);
  } catch (e) {
    if (ctx !== mine) return;
    toast(e.message, true);
    if (ctx.evaluation) drawEvaluation(ctx.evaluation); else drawEmpty();
  } finally {
    if (ctx === mine) {
      busy(btn, false);
      if (ctx.evaluation) btn.textContent = "Переоценить диалог";
      sel.disabled = false;
    }
  }
}

async function loadEvaluation(id) {
  const owner = ctx;
  const ev = await api.evaluation(id);
  // Navigated to another card (or away) while loading: don't draw into it.
  if (!ctx || ctx !== owner || !owner.root.isConnected) return;
  drawEvaluation(ev);
}

function drawEvaluation(ev) {
  ctx.evaluation = ev;
  $("#cv-settings-label", ctx.root).textContent = "Переоценка";
  const btn = $("#btn-eval", ctx.root);
  if (!btn.disabled) btn.textContent = "Переоценить диалог";
  updateChecklistControls();
  clearTimeout(ctx.pollTimer);
  const panel = $("#eval-panel", ctx.root);

  if (ev.status !== "done") {
    if (ev.status === "running" || ev.status === "pending") {
      startLoading(ev);
      ctx.pollTimer = setTimeout(() => ctx && ctx.evaluation?.id === ev.id && loadEvaluation(ev.id).catch(() => {}), 2500);
    } else {
      stopLoading();
      panel.innerHTML = panelHead(ev) + `<div class="cv-pad">
        <div class="cv-note cv-note-warn"><b>Ошибка оценки:</b> ${esc(ev.error || "неизвестная ошибка")}</div>
        <p class="cv-muted-s">Нажмите «Оценить», чтобы повторить.</p></div>`;
      bindHistory();
    }
    markEvidence(null);
    return;
  }
  stopLoading();

  const cfg = ev.checklist;
  const score = ev.final_score;
  const critCfg = Object.fromEntries(cfg.criteria.map((c) => [c.id, c]));
  const scoreRows = Object.fromEntries(score.criteria.map((r) => [r.criterion_id, r]));
  const origRows = Object.fromEntries(ev.score.criteria.map((r) => [r.criterion_id, r]));
  const appealsBy = {};
  ev.appeals.forEach((a) => (appealsBy[a.criterion_id] = appealsBy[a.criterion_id] || []).push(a));
  if (ctx.openCrit && !critCfg[ctx.openCrit]) ctx.openCrit = null;

  const totalChanged = ev.total !== null && ev.final_total !== null && Math.abs(Number(ev.total) - Number(ev.final_total)) > 0.001;
  const resolved = ev.appeals.filter((a) => a.status !== "open").length;
  const openApp = ev.appeals.filter((a) => a.status === "open").length;
  const delta = totalChanged ? Number(ev.final_total) - Number(ev.total) : 0;
  const previous = ctx.conv.evaluations.find((item) => item.id === ctx.compareId && item.id !== ev.id && item.status === "done");
  const rowsBy = Object.fromEntries(ev.final_criteria.map((r) => [r.criterion_id, r]));

  const criteria = cfg.criteria.filter((c) => rowsBy[c.id]);
  const reviewCriteria = criteria.filter((c) => rowsBy[c.id].evidence_review);
  const critical = criteria.filter((c) => c.type === "critical" && rowsBy[c.id].answer === "yes")
    .map((crit) => ({ crit, row: rowsBy[crit.id] }));
  const losses = lossItems(ev, critCfg, scoreRows);
  const findingContext = { origRows, rel: ctx.rel };
  const canAppeal = criteria.some((c) => !(appealsBy[c.id] || []).some((a) => a.status === "open"));
  const criterionRow = (c) => critHtml({
    row: rowsBy[c.id], crit: c, srow: scoreRows[c.id], orow: origRows[c.id], appeals: appealsBy[c.id] || [],
    msgs: ctx.conv.transcript, rel: ctx.rel, canAppeal: true, open: ctx.openCrit === c.id,
  });

  panel.innerHTML = panelHead(ev) + `
    <div class="cv-ev-content">
    <div class="cv-score">
      ${score.total === null ? `<p class="cv-no-finding">Нет применимых критериев с весом: итоговый балл не рассчитан.</p>`
        : `<div class="cv-score-line"><strong>${fmtNum(score.total)}</strong><span>из 100 баллов</span></div>`}
      ${totalChanged ? `<div class="cv-revised"><span>До пересмотра ${fmtNum(ev.total)}</span>
        <span class="cv-delta ${delta > 0 ? "is-up" : "is-down"}">${delta > 0 ? "+" : "−"}${fmtNum(Math.abs(delta))}</span></div>`
        : resolved ? `<div class="cv-muted-s">Апелляции рассмотрены (${resolved}), итог не изменился</div>` : ""}
      ${openApp ? `<div class="cv-muted-s">${openApp} ${plural(openApp, "апелляция", "апелляции", "апелляций")} на рассмотрении</div>` : ""}
    </div>
    ${losses.length ? `<section class="cv-findings" aria-labelledby="cv-loss-heading">
      <h3 id="cv-loss-heading" tabindex="-1">За что сняли баллы</h3>
      ${findingsHtml(losses, findingContext)}
    </section>` : score.total === null ? "" : `<p class="cv-no-finding cv-score-clean">${icon("check")}Баллы не сняты</p>`}
    ${critical.length ? `<section class="cv-findings is-critical" aria-labelledby="cv-critical-heading">
      <h3 id="cv-critical-heading">Грубые ошибки</h3>
      ${findingsHtml(critical, findingContext)}
    </section>` : ""}
    ${reviewCriteria.length ? `<div class="cv-evidence-banner">
      ${icon("alert")}
      <div><strong>Требует проверки</strong><span>Сверьте основания по ${reviewCriteria.length} ${plural(reviewCriteria.length, "критерию", "критериям", "критериям")}.</span></div>
      <button type="button" class="btn" data-open="${esc(reviewCriteria[0].id)}">Проверить</button>
    </div>` : ""}
    ${previous ? `<div class="cv-version-compare">
      <div><b>Оценки модели по двум версиям</b><span>Один и тот же диалог</span></div>
      <div class="cv-version-values"><span><small>v${esc(previous.checklist_version)}</small><strong>${fmtNum(previous.total)}</strong></span>
      <span aria-hidden="true">→</span><span><small>v${esc(ev.checklist_version)}</small><strong>${fmtNum(ev.total)}</strong></span></div>
    </div>` : ""}
    <details class="cv-all-criteria" ${ctx.openCrit ? "open" : ""}>
      <summary>Все критерии</summary>
      <div class="cv-crits" id="crit-list">${criteria.map(criterionRow).join("")}</div>
    </details>
    <details class="cv-score-details">
      <summary>Дополнительно об оценке</summary>
      ${ev.summary ? `<div class="cv-summary"><span class="cv-summary-h">Резюме модели${ev.final_criteria.some((r) => isRevised(r, origRows[r.criterion_id])) ? " · до пересмотра" : ""}</span>${esc(ev.summary)}</div>` : ""}
      <div class="cv-secs">${(score.sections || []).filter((s) => s.max_points !== null).map((s) =>
        `<div class="cv-sec"><span>${esc(s.title)}</span><b>${fmtNum(s.points)} / ${fmtNum(s.max_points)}</b></div>`).join("")}</div>
      ${metaHtml(ev)}
    </details>
    <button type="button" class="btn cv-appeal-main" data-appeal-all ${canAppeal ? "" : "disabled"}>Оспорить оценку</button>
    </div>`;

  bindHistory();
  panel.onclick = onPanelClick;
  if (ctx.openCrit) toggleCrit(ctx.openCrit, true);
  else markEvidence(null);
}

function onPanelClick(e) {
  const t = e.target;
  const msg = t.closest("[data-msg]");
  if (msg) { focusMsg(Number(msg.dataset.msg), { page: true }); return; }
  if (t.closest("[data-appeal-all]")) { appealDialog(); return; }
  const ap = t.closest("[data-appeal]");
  if (ap) { appealDialog(ap.dataset.appeal); return; }
  const jump = t.closest("[data-jump]");
  if (jump) { toggleCrit(jump.dataset.jump, true, { page: true }); return; }
  const open = t.closest("[data-open]");
  if (open) {
    toggleCrit(open.dataset.open, true);
    const el = $(`.cv-crit[data-crit="${CSS.escape(open.dataset.open)}"]`, ctx.root);
    if (el) scrollInBox($("#eval-panel", ctx.root), $(".cv-crit-top", el), { center: false });
    return;
  }
  const tog = t.closest("[data-toggle]");
  if (tog) toggleCrit(tog.dataset.toggle);
}

function bindHistory() {
  const sel = $("#sel-eval", ctx.root);
  if (sel) sel.addEventListener("change", () => {
    history.replaceState(history.state, "", `#/conversation/${encodeURIComponent(ctx.conv.id)}?eval=${sel.value}`);
    ctx.openCrit = null;
    ctx.compareId = null;
    loadEvaluation(Number(sel.value)).catch((e) => toast(e.message, true));
  });
}

function setUrl() {
  const ev = ctx.evaluation;
  if (!ev) return;
  const q = new URLSearchParams({ eval: String(ev.id) });
  const kid = Number($("#sel-checklist", ctx.root).value);
  if (kid && (kid !== ev.checklist_id || ctx.compareId)) q.set("checklist", kid);
  if (ctx.compareId) q.set("compare", ctx.compareId);
  if (ctx.openCrit) q.set("crit", ctx.openCrit);
  const message = new URLSearchParams(location.hash.split("?")[1]).get("msg");
  if (message) q.set("msg", message);
  history.replaceState(history.state, "", `#/conversation/${encodeURIComponent(ctx.conv.id)}?${q.toString()}`);
}

function toggleCrit(id, forceOpen = false, { focus = true, page = false } = {}) {
  if (!ctx || !ctx.evaluation || !id) return;
  const el = $(`.cv-crit[data-crit="${CSS.escape(id)}"]`, ctx.root);
  if (!el) return;
  const willOpen = forceOpen || !el.classList.contains("is-open");
  $$(".cv-crit.is-open", ctx.root).forEach((c) => {
    c.classList.remove("is-open");
    c.querySelector(".cv-crit-top").setAttribute("aria-expanded", "false");
    c.querySelector(".cv-crit-body").hidden = true;
  });
  if (willOpen) {
    el.closest("details").open = true;
    el.classList.add("is-open");
    el.querySelector(".cv-crit-top").setAttribute("aria-expanded", "true");
    el.querySelector(".cv-crit-body").hidden = false;
    ctx.openCrit = id;
    const row = ctx.evaluation.final_criteria.find((r) => r.criterion_id === id);
    const crit = ctx.evaluation.checklist.criteria.find((c) => c.id === id);
    markEvidence(row, crit);
    const ref = firstRef(row);
    if (focus && ref) focusMsg(ref, { page });
  } else {
    ctx.openCrit = null;
    markEvidence(null);
    $$(".cv-msg.is-focus", ctx.root).forEach((m) => m.classList.remove("is-focus"));
  }
  setUrl();
}

function appealDialog(critId) {
  const ev = ctx.evaluation;
  const rows = new Map(ev.final_criteria.map((row) => [row.criterion_id, row]));
  const pending = new Set(ev.appeals.filter((a) => a.status === "open").map((a) => a.criterion_id));
  const choices = ev.checklist.criteria.filter((c) => rows.has(c.id) && !pending.has(c.id) && (!critId || c.id === critId));
  if (!choices.length) return;
  const summary = (crit) => {
    const row = rows.get(crit.id);
    const score = ev.final_score.criteria.find((r) => r.criterion_id === crit.id);
    const original = ev.criteria.find((r) => r.criterion_id === crit.id);
    const decision = changeReview(row, original);
    return `<b>Текущая оценка: ${esc(answerView(crit, row.answer).label)}</b>
      ${score?.points != null ? ` · ${fmtNum(score.points)} / ${fmtNum(score.max_points)} балл.` : ""}
      <div class="cv-muted-s">${decision ? `Решение проверяющего · ${esc(decision.reason)}` : esc(row.explanation || "")}</div>`;
  };
  const { el } = modal({
    title: critId ? `Оспорить оценку: ${choices[0].title}` : "Оспорить оценку",
    submitText: "Подать апелляцию",
    body: `
      ${critId ? "" : `<label class="field">Критерий
        <select class="input" id="ap-criterion" required><option value="" selected disabled>Выберите критерий</option>${choices.map((c) => `<option value="${esc(c.id)}">${esc(c.title)}</option>`).join("")}</select></label>`}
      <div class="cv-ap-cur" id="ap-summary" ${critId ? "" : "hidden"}>${critId ? summary(choices[0]) : ""}</div>
      <label class="field">Комментарий — почему оценка неверна
        <textarea class="input" id="ap-comment" rows="4" placeholder="Например: оператор представился в реплике #3, приветствие было на казахском"></textarea></label>
      <label class="field">Автор (необязательно)
        <input class="input" id="ap-author" placeholder="Оператор / супервайзер" value="${esc(window.CQA_USER || "")}" ${window.CQA_USER ? "readonly" : ""}></label>
      <div class="cv-muted-s">Проверяющий увидит комментарий, объяснение модели и фрагмент диалога, затем подтвердит или изменит оценку.</div>`,
    onSubmit: async (el) => {
      const criterion = $("#ap-criterion", el);
      if (criterion && !criterion.reportValidity()) return false;
      const comment = $("#ap-comment", el).value.trim();
      if (!comment) throw new Error("Добавьте комментарий");
      const selected = criterion?.value || choices[0].id;
      const a = await api.createAppeal({ evaluation_id: ev.id, criterion_id: selected, comment, author: $("#ap-author", el).value.trim() || null });
      toast(`Апелляция #${a.id} отправлена проверяющему`);
      if (ctx?.evaluation?.id !== ev.id) return;
      ctx.openCrit = selected;
      await loadEvaluation(ev.id);
      refreshBadge();
    },
  });
  $("#ap-criterion", el)?.addEventListener("change", (e) => {
    const preview = $("#ap-summary", el);
    preview.innerHTML = summary(choices.find((c) => c.id === e.target.value));
    preview.hidden = false;
  });
}
