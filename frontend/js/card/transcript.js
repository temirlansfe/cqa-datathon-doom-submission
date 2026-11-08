// Transcript rendering shared by the conversation card and the appeal page.
import { esc, fmtClock, fmtTs, SPEAKER } from "../util.js";

export const speakerKind = (sp) => {
  const s = String(sp || "").toLowerCase();
  return s === "client" || s === "operator" || s === "bot" || s === "system" ? s : "other";
};

const isContext = (k) => k === "bot" || k === "system" || k === "other";

/**
 * One transcript message.
 * opts: { chat: render all roles as bubbles, sec: seconds from start (calls), playable: show ▶ button, cls: extra classes, idPrefix }
 */
export function msgHtml(m, n, { chat = false, sec = null, playable = false, cls = "", idPrefix = "msg-" } = {}) {
  const k = speakerKind(m.speaker);
  const who = SPEAKER[k] || m.speaker || "—";
  const ts = m.timestamp ? `<span class="cv-ts" title="${esc(m.timestamp)}">${esc(fmtTs(m.timestamp))}</span>` : "";
  const play = playable && sec !== null && sec !== undefined
    ? `<button type="button" class="cv-play" data-play="${n}" aria-label="Прослушать реплику #${n} с ${fmtClock(sec)}">
         <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l11-6.5z"/></svg>${fmtClock(sec)}</button>`
    : "";
  if (isContext(k) && !chat) {
    return `
      <div class="cv-msg cv-ctx cv-sp-${k} ${cls}" id="${idPrefix}${n}" data-n="${n}" data-sp="${k}">
        <div class="cv-ctx-in">
          <span class="cv-n">#${n}</span><span class="cv-who">${esc(who)}</span>
          <span class="cv-ctx-text">${esc(m.text)}</span>${ts}${play}
        </div>
      </div>`;
  }
  return `
    <div class="cv-msg cv-sp-${k} ${cls}" id="${idPrefix}${n}" data-n="${n}" data-sp="${k}">
      <div class="cv-bubble">
        <div class="cv-mhead"><span class="cv-n">#${n}</span><span class="cv-who">${esc(who)}</span>${ts}${play}<span class="cv-proof-label">Основание оценки</span></div>
        <div class="cv-text">${esc(m.text)}</div>
      </div>
    </div>`;
}

/** Scroll `el` into view inside its scrollable `box` only (never moves the page). */
export function scrollInBox(box, el, { center = true, smooth = true } = {}) {
  if (!box || !el) return;
  const b = box.getBoundingClientRect(), r = el.getBoundingClientRect();
  const delta = center ? r.top - b.top - (b.height - r.height) / 2 : r.top < b.top ? r.top - b.top - 8 : r.bottom > b.bottom ? r.bottom - b.bottom + 8 : 0;
  if (Math.abs(delta) < 2) return;
  box.scrollTo({ top: box.scrollTop + delta, behavior: smooth ? "smooth" : "auto" });
}
