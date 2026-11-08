// Hash router. Each view is a module exporting `render(root, params, query)`
// that may return a cleanup function. Views only touch `root`, so each one can
// be mounted on its own (e.g. a single Dynamics 365 form tab).
import { api } from "./api.js";
import { esc, $$, icon } from "./util.js";
import * as conversations from "./views/conversations.js";
import * as card from "./views/card.js";
import * as checklists from "./views/checklists.js";
import * as ruleCheck from "./views/rule-check.js";
import * as appeals from "./views/appeals.js";
import * as radar from "./views/radar.js";

const routes = [
  { re: /^\/conversations$/, view: conversations, nav: "conversations", title: "Разговоры", skel: "journal" },
  { re: /^\/conversation\/(.+)$/, view: card, nav: "conversations", keys: ["id"], title: "Диалог", skel: "split" },
  { re: /^\/checklists$/, view: checklists, nav: "checklists", title: "Чек-листы", skel: "editor" },
  { re: /^\/checklists\/(new|\d+)$/, view: checklists, nav: "checklists", keys: ["id"], title: "Чек-листы", skel: "editor" },
  { re: /^\/checklists\/(\d+)\/rule-check$/, view: ruleCheck, nav: "checklists", keys: ["id"], title: "Проверка правила", skel: "list" },
  { re: /^\/appeals$/, view: appeals, nav: "appeals", title: "Апелляции", skel: "split" },
  { re: /^\/appeals\/(\d+)$/, view: appeals, nav: "appeals", keys: ["id"], title: "Апелляции", skel: "split" },
  { re: /^\/radar$/, view: radar, nav: "radar", title: "Сервис инсайтов", skel: "list" },
];

let cleanup = null;
let lastPath = null;
let currentView = null;
let currentHash = "";
let currentPosition = history.state?.cqaPosition ?? 0;
let restoringEntry = false;
let approvedHash = null;
let seq = 0;
const siteHeader = document.querySelector(".site-head");
const navToggle = siteHeader.querySelector(".site-nav-toggle");

function closeNavigation(restoreFocus = false) {
  if (navToggle.getAttribute("aria-expanded") !== "true") return;
  navToggle.setAttribute("aria-expanded", "false");
  if (restoreFocus && navToggle.offsetWidth) navToggle.focus();
}

/** Placeholder shown while a view loads its data (only if loading takes a moment). */
function skeleton(kind) {
  const lines = (n, w = [92, 78, 85, 64, 88, 70]) =>
    Array.from({ length: n }, (_, i) => `<div class="skel skel-line" style="width:${w[i % w.length]}%"></div>`).join("");
  const head = `<div><div class="skel skel-title"></div><div class="skel skel-line" style="width:340px;max-width:80%;margin-top:10px"></div></div>`;
  if (kind === "split") {
    return `<div class="skel-page" aria-hidden="true">${head}
      <div class="skel-split"><div class="skel-card">${lines(6)}</div><div class="skel-card">${lines(10)}</div></div></div>`;
  }
  return `<div class="skel-page" aria-hidden="true">${head}
    ${kind === "list" ? `<div class="skel-kpis">${'<div class="skel"></div>'.repeat(5)}</div>` : ""}
    <div class="skel-card">${lines(9)}</div></div>`;
}

const bar = () => document.getElementById("route-bar");
function loading(on) {
  const b = bar();
  if (!b) return;
  if (on) { b.classList.remove("done"); void b.offsetWidth; b.classList.add("on"); }
  else { b.classList.remove("on"); b.classList.add("done"); }
}

async function route() {
  const requestedHash = location.hash;
  const position = history.state?.cqaPosition;
  if (restoringEntry) {
    restoringEntry = false;
    if (requestedHash === currentHash && position === currentPosition) return;
  }
  const approved = approvedHash === requestedHash;
  approvedHash = null;
  if (currentView === checklists && requestedHash !== currentHash && !approved) {
    const leave = await checklists.confirmLeave();
    if (location.hash !== requestedHash) return;
    if (!leave) {
      const offset = position == null ? -1 : currentPosition - position;
      if (offset) {
        restoringEntry = true;
        history.go(offset);
      } else {
        history.replaceState(history.state, "", currentHash);
      }
      return;
    }
  }
  const hash = location.hash.replace(/^#/, "") || "/conversations";
  const [path, qstr] = hash.split("?");
  const query = Object.fromEntries(new URLSearchParams(qstr || ""));
  const m = routes.map((r) => ({ r, m: path.match(r.re) })).find((x) => x.m);
  const root = document.getElementById("view");
  closeNavigation();
  if (!m) { location.replace("#/conversations"); return; }
  currentPosition = position ?? (currentView ? currentPosition + 1 : currentPosition);
  if (position == null) history.replaceState({ ...history.state, cqaPosition: currentPosition }, "");
  currentView = m.r.view;
  currentHash = requestedHash;

  // Same card, only the query changed (e.g. ?msg=5) — let the view handle it in place.
  if (path === lastPath && m.r.view.onQuery) { m.r.view.onQuery(query); return; }
  lastPath = path;

  if (typeof cleanup === "function") cleanup();
  cleanup = null;
  const token = ++seq;
  $$(".site-nav [data-nav]").forEach((a) => {
    const on = a.dataset.nav === m.r.nav;
    a.classList.toggle("active", on);
    if (on) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
  });
  document.title = `${m.r.title} · Freedom Broker`;
  const params = {};
  (m.r.keys || []).forEach((k, i) => (params[k] = decodeURIComponent(m.m[i + 1])));

  // Each navigation renders into its own host, so a slow, superseded render
  // writes into a detached node instead of over the newer screen.
  const host = document.createElement("div");
  host.className = "view-host";
  root.replaceChildren(host);
  window.scrollTo(0, 0);
  root.setAttribute("aria-busy", "true");
  loading(true);
  const skelTimer = setTimeout(() => { if (!host.childElementCount) host.innerHTML = skeleton(m.r.skel); }, 120);
  let result;
  try {
    result = await m.r.view.render(host, params, query);
  } catch (e) {
    if (token === seq) {
      host.innerHTML = `
        <div class="card empty-state" role="alert">
          <div class="ic"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 2 20h20z"/><path d="M12 10v4M12 17.5v.01"/></svg></div>
          <h3>Не удалось открыть страницу</h3>
          <p>${esc(e.message)}</p>
          <button class="btn btn-primary" type="button" data-retry>Повторить</button>
        </div>`;
      host.querySelector("[data-retry]").addEventListener("click", () => { lastPath = null; route(); });
    }
  } finally {
    clearTimeout(skelTimer);
  }
  if (token !== seq) { if (typeof result === "function") result(); return; }
  cleanup = result;
  root.setAttribute("aria-busy", "false");
  loading(false);
  host.classList.add("view-enter");
  if (!document.activeElement?.closest(".modal-back")) root.focus({ preventScroll: true });
  refreshBadge();
}

export async function refreshBadge() {
  try {
    const open = await api.appeals("open");
    const b = document.getElementById("appeals-badge");
    b.hidden = !open.length;
    b.textContent = open.length;
    b.title = `Открытых апелляций: ${open.length}`;
  } catch { /* ignore */ }
}

async function loadAccount() {
  try {
    const me = await api.me();
    window.CQA_USER = me.email || null;
    if (!me.email) return;
    document.getElementById("account-info").innerHTML =
      `<div class="site-account"><b>${esc(me.email)}</b><a href="/oauth2/sign_out?rd=%2F">Выйти</a></div>`;
    document.getElementById("account-menu").hidden = false;
  } catch { /* ignore */ }
}

// Back from Google sign-in: restore the screen the user was on.
try {
  const back = sessionStorage.getItem("cqa.returnTo");
  if (back) { sessionStorage.removeItem("cqa.returnTo"); if (!location.hash) location.hash = back; }
} catch { /* ignore */ }

// The skip link must not change the hash (that would navigate).
document.getElementById("skip-link")?.addEventListener("click", (e) => {
  e.preventDefault();
  document.getElementById("view").focus();
});

window.addEventListener("hashchange", route);
document.addEventListener("click", async (e) => {
  const link = e.target.closest("a[href^='#/']");
  if (!link || e.defaultPrevented || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey
      || link.target || link.hash === location.hash || currentView !== checklists || !checklists.hasUnsavedChanges()) return;
  e.preventDefault();
  const from = location.hash;
  if (await checklists.confirmLeave() && location.hash === from) {
    approvedHash = link.hash;
    location.hash = link.hash;
  }
});
$$("[data-icon]", siteHeader).forEach((slot) => { slot.innerHTML = icon(slot.dataset.icon); });
navToggle.addEventListener("click", () => {
  const open = navToggle.getAttribute("aria-expanded") === "true";
  navToggle.setAttribute("aria-expanded", String(!open));
});
siteHeader.addEventListener("click", (e) => {
  if (e.target.closest(".site-nav a, .brand") && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey) {
    closeNavigation(true);
  }
});
for (const menu of $$(".site-menu")) {
  menu.addEventListener("click", (e) => { if (e.target.closest("a")) menu.open = false; });
  document.addEventListener("click", (e) => { if (!menu.contains(e.target)) menu.open = false; });
}
for (const menu of $$(".site-head details")) {
  menu.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && menu.open) {
      e.preventDefault();
      menu.open = false;
      menu.querySelector("summary").focus();
    }
  });
}
document.addEventListener("click", (e) => {
  if (!siteHeader.contains(e.target)) closeNavigation();
  for (const menu of $$(".action-menu[open]")) {
    if (!menu.contains(e.target)) menu.open = false;
  }
});
document.addEventListener("keydown", (e) => {
  if (e.defaultPrevented || e.key !== "Escape") return;
  if (navToggle.offsetWidth && navToggle.getAttribute("aria-expanded") === "true") {
    closeNavigation(true);
    return;
  }
  const menu = e.target.closest?.(".action-menu[open]");
  if (menu) {
    menu.open = false;
    menu.querySelector("summary").focus();
  }
});
loadAccount();
route();
