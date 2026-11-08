// Shared helpers: escaping, formatting, toasts, modals, timestamps.

export const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Give menus above a fixed workspace at most as much height as the workspace itself. */
export function watchMenuSpace(header, workspace) {
  const observer = new ResizeObserver(([entry]) => {
    header.style.setProperty("--menu-space", `${entry.contentRect.height}px`);
  });
  observer.observe(workspace);
  return () => observer.disconnect();
}

export const SPEAKER = { client: "Клиент", operator: "Оператор", bot: "Бот", system: "Система" };
export const LANG = { RU: "Русский", KZ: "Қазақша", EN: "English" };
export const CHANNEL = { "agent chat": "Чат", "voice call": "Звонок" };
export const TYPE_LABEL = { binary: "Да / Нет", scale: "Шкала", critical: "Грубая ошибка (без баллов)" };

export function fmtNum(v, digits = 2) {
  if (v === null || v === undefined || v === "") return "—";
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString("ru-RU", { maximumFractionDigits: digits });
}

export function scoreClass(v) {
  if (v === null || v === undefined) return "";
  const n = Number(v);
  return n >= 85 ? "hi" : n >= 65 ? "mid" : "lo";
}

export function fmtDate(s) {
  if (!s) return "";
  const d = new Date(s);
  return d.toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

/** Answer label + css kind for a criterion answer. */
export function answerView(crit, answer) {
  if (answer === "na") return { label: "N/A", kind: "na", icon: "–" };
  if (crit && crit.type === "scale") {
    const vals = (crit.scale || []).map((s) => Number(s.value));
    const top = Math.max(...vals);
    const v = Number(answer);
    const kind = v >= top ? "yes" : v <= Math.min(...vals) ? "no" : "part";
    return { label: `${fmtNum(v)} из ${fmtNum(top)}`, kind, icon: kind === "yes" ? "✓" : kind === "no" ? "✕" : "~" };
  }
  if (crit && crit.type === "critical") {
    return answer === "yes"
      ? { label: "Выявлено", kind: "no", icon: "!" }
      : { label: "Не выявлено", kind: "yes", icon: "✓" };
  }
  return answer === "yes" ? { label: "Да", kind: "yes", icon: "✓" } : { label: "Нет", kind: "no", icon: "✕" };
}

/** Allowed answers for a criterion (for appeal decisions). */
export function answerOptions(crit) {
  const opts = [];
  if (crit.type === "scale") {
    [...(crit.scale || [])].sort((a, b) => b.value - a.value).forEach((s) => opts.push({ value: String(s.value), label: `${s.value} — ${s.description}` }));
  } else if (crit.type === "critical") {
    opts.push({ value: "yes", label: "Выявлено (Да)" }, { value: "no", label: "Не выявлено (Нет)" });
  } else {
    opts.push({ value: "yes", label: "Да" }, { value: "no", label: "Нет" });
  }
  if (crit.na_allowed) opts.push({ value: "na", label: "N/A" });
  return opts;
}

/** Seconds from the conversation start for a message timestamp (MM:SS, HH:MM:SS or ISO 8601). */
export function tsSeconds(ts, firstTs) {
  const parse = (t) => {
    if (!t) return null;
    const s = String(t).trim();
    if (/^\d{1,2}(:\d{1,2}){1,2}(\.\d+)?$/.test(s)) {
      return s.split(":").reduce((acc, p) => acc * 60 + Number(p), 0);
    }
    const d = Date.parse(s);
    return Number.isNaN(d) ? null : d / 1000;
  };
  const a = parse(ts);
  if (a === null) return null;
  const isClock = /^\d{1,2}:/.test(String(ts).trim());
  if (isClock) return a;
  const b = parse(firstTs);
  return b === null ? null : Math.max(0, a - b);
}

export function fmtClock(sec) {
  if (sec === null || sec === undefined) return "";
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const mm = String(m).padStart(2, "0"), ss = String(s).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** Short display for a raw timestamp (ISO -> HH:MM:SS local to the string). */
export function fmtTs(ts) {
  const s = String(ts || "");
  const m = s.match(/T(\d{2}:\d{2}:\d{2})/);
  return m ? m[1] : s;
}

export function toast(msg, isErr = false) {
  const el = document.createElement("div");
  el.className = "toast" + (isErr ? " err" : "");
  el.textContent = msg;
  document.getElementById("toasts").appendChild(el);
  setTimeout(() => el.remove(), isErr ? 7000 : 3500);
}

/** Simple modal. `body` is HTML. Returns {el, close}. onSubmit(el) may return false to keep open. */
export function modal({ title, body, submitText = "Сохранить", onSubmit, onClose, cancelText = "Отмена" }) {
  const opener = document.activeElement;
  const back = document.createElement("div");
  back.className = "modal-back";
  back.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <div class="modal-head"><h3>${esc(title)}</h3><button class="btn btn-ghost btn-sm" data-x aria-label="Закрыть">✕</button></div>
      <div class="modal-body">${body}</div>
      <div class="modal-foot">
        <button class="btn" data-x>${esc(cancelText)}</button>
        ${onSubmit ? `<button class="btn btn-primary" data-ok>${esc(submitText)}</button>` : ""}
      </div>
    </div>`;
  const isTop = () => $$(".modal-back").at(-1) === back;
  const focusable = () => $$("a[href], button, input, select, textarea, summary, [tabindex]", back)
    .filter((el) => el.tabIndex >= 0 && !el.matches(":disabled") && el.getClientRects().length && getComputedStyle(el).visibility === "visible");
  const close = () => {
    if (!back.isConnected) return;
    const restoreFocus = isTop();
    back.remove();
    document.removeEventListener("keydown", onKey, true);
    if (restoreFocus && opener?.isConnected) opener.focus({ preventScroll: true });
    onClose?.();
  };
  const onKey = (e) => {
    if (!isTop()) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === "Tab") {
      const items = focusable();
      const first = items[0], last = items.at(-1);
      const active = document.activeElement;
      if (!items.includes(active) || active === (e.shiftKey ? first : last)) {
        e.preventDefault();
        (e.shiftKey ? last : first)?.focus();
      }
    }
  };
  document.addEventListener("keydown", onKey, true);
  back.addEventListener("click", (e) => { if (e.target === back || e.target.closest("[data-x]")) close(); });
  const ok = back.querySelector("[data-ok]");
  if (ok) {
    ok.addEventListener("click", async () => {
      ok.disabled = true;
      try {
        const res = await onSubmit(back);
        if (res !== false) close();
      } catch (e) {
        toast(e.message, true);
      } finally {
        ok.disabled = false;
      }
    });
  }
  document.body.appendChild(back);
  const items = focusable();
  (items.find((el) => el.matches("textarea, input, select")) || items[0])?.focus();
  return { el: back, close };
}

export function busy(btn, on, text) {
  if (!btn) return;
  if (on) {
    btn.dataset.label = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner"></span> ${esc(text || "")}`;
  } else {
    btn.disabled = false;
    if (btn.dataset.label) btn.innerHTML = btn.dataset.label;
  }
}

export function ring(value, size = 112) {
  const r = 46, c = 2 * Math.PI * r;
  const v = value === null || value === undefined ? 0 : Math.max(0, Math.min(100, Number(value)));
  const color = value === null || value === undefined ? "var(--line-strong)" : v >= 85 ? "var(--good)" : v >= 65 ? "var(--warn)" : "var(--bad)";
  return `
    <div class="ring" style="width:${size}px;height:${size}px">
      <svg viewBox="0 0 100 100" aria-hidden="true">
        <circle cx="50" cy="50" r="${r}" fill="none" stroke="var(--brand-100)" stroke-width="8"/>
        <circle cx="50" cy="50" r="${r}" fill="none" stroke="${color}" stroke-width="8" stroke-linecap="round"
          stroke-dasharray="${(c * v) / 100} ${c}"/>
      </svg>
      <div class="val"><b>${value === null || value === undefined ? "—" : fmtNum(value)}</b><span>/ 100</span></div>
    </div>`;
}

/* ---------- helpers added for the shell / list / checklist / analytics screens ---------- */

/** Russian plural: plural(5, ["диалог", "диалога", "диалогов"]) → "диалогов". */
export function plural(n, forms) {
  const a = Math.abs(Math.trunc(Number(n) || 0)) % 100, b = a % 10;
  if (a > 10 && a < 20) return forms[2];
  if (b > 1 && b < 5) return forms[1];
  if (b === 1) return forms[0];
  return forms[2];
}

export function debounce(fn, ms = 200) {
  let t = null;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

/** Stroke icons (24×24, styled by the surrounding CSS). Static markup only. */
const ICONS = {
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  chat: '<path d="M4 5h16v11H8l-4 4z"/>',
  phone: '<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a1 1 0 0 1-1 1A16 16 0 0 1 4 5a1 1 0 0 1 1-1z"/>',
  upload: '<path d="M12 16V4M7 9l5-5 5 5M4 20h16"/>',
  download: '<path d="M12 4v12M7 11l5 5 5-5M4 20h16"/>',
  cloud: '<path d="M7 18a4 4 0 0 1-.6-7.96A6 6 0 0 1 18 9.5a4.25 4.25 0 0 1-.5 8.5z"/><path d="M12 11v6M9.5 14.5 12 17l2.5-2.5"/>',
  play: '<path d="M7 5v14l11-7z"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.6M20 4v7h-7"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  alert: '<path d="M12 3 2 20h20z"/><path d="M12 10v4M12 17.5v.01"/>',
  list: '<path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/>',
  table: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M10 9v11"/>',
  done: '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
  score: '<path d="M4 19h16M7 16V10M12 16V5M17 16v-4"/>',
  scale: '<path d="M12 3v18M5 7h14M5 7l-3 7h6zM19 7l-3 7h6zM8 21h8"/>',
  coin: '<circle cx="12" cy="12" r="9"/><path d="M14.5 9.2c-.5-.8-1.4-1.2-2.5-1.2-1.6 0-2.7.8-2.7 2s1 1.7 2.7 2c1.7.3 2.8.8 2.8 2s-1.2 2-2.8 2c-1.2 0-2.2-.5-2.7-1.3M12 6.5V8M12 16v1.5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  up: '<path d="m6 15 6-6 6 6"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  back: '<path d="M20 12H4m6-6-6 6 6 6"/>',
  chev: '<path d="m9 6 6 6-6 6"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  code: '<path d="m8 8-4 4 4 4M16 8l4 4-4 4"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>',
  star: '<path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/>',
  bulb: '<path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z"/>',
  inbox: '<path d="M4 13h4l2 3h4l2-3h4M5 5h14l1 8v6H4v-6z"/>',
  filter: '<path d="M4 5h16l-6 8v6l-4-2v-4z"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
};
export function icon(name) {
  return `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${ICONS[name] || ""}</svg>`;
}

/** Percentage of part in total (0..100), null when total is 0. */
export function pct(part, total) {
  return total ? (Number(part) / Number(total)) * 100 : null;
}

/** Confirmation dialog built on modal(). Resolves true on confirm, false on cancel/close. */
export function confirmDialog({ title, body, okText = "Подтвердить", cancelText = "Отмена", danger = false, wide = false }) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; obs.disconnect(); resolve(v); } };
    const m = modal({ title, body, submitText: okText, cancelText, onSubmit: () => { finish(true); } });
    const box = m.el.querySelector(".modal");
    if (wide) box.classList.add("modal-wide");
    const ok = m.el.querySelector("[data-ok]");
    if (danger && ok) { ok.classList.remove("btn-primary"); ok.classList.add("btn-danger"); }
    if (ok && !m.el.querySelector("textarea, input, select")) {
      (danger ? m.el.querySelector(".modal-foot [data-x]") : ok).focus();
    }
    const obs = new MutationObserver(() => { if (!m.el.isConnected) finish(false); });
    obs.observe(document.body, { childList: true });
  });
}
