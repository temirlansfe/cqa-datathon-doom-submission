// Call player and a compact timeline built from message timestamps.
// The native <audio> element stays hidden; everything degrades gracefully when the
// recording cannot be loaded (CORS / 404) — the timeline still navigates the transcript.
import { esc, fmtClock, SPEAKER } from "../util.js";

const RATES = [1, 1.25, 1.5, 2];
const BARS = 112;

const ICON_PLAY = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l11-6.5z"/></svg>`;
const ICON_PAUSE = `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6.5" y="5" width="4" height="14" rx="1"/><rect x="13.5" y="5" width="4" height="14" rx="1"/></svg>`;

/** Time segments per message: start from the timestamp, end estimated from text length / next message. */
export function buildSegments(transcript, seconds) {
  const items = transcript
    .map((m, i) => ({ n: i + 1, m, s: seconds[i] }))
    .filter((x) => x.s !== null && x.s !== undefined && Number.isFinite(x.s));
  return items.map((x, k) => {
    const next = items.slice(k + 1).find((y) => y.s > x.s);
    const est = Math.max(1.4, String(x.m.text || "").length / 15); // ~15 chars per second of speech
    let end = x.s + est;
    if (next) end = Math.min(end, Math.max(x.s + 0.8, next.s - 0.25));
    const sp = String(x.m.speaker || "").toLowerCase();
    return { n: x.n, speaker: sp, start: x.s, end, text: String(x.m.text || "") };
  });
}

/**
 * Transcript time -> position in the recording file (seconds), per message.
 * - the file starts at the "recording started" event (a callback may have lines before it);
 * - during "recording paused … resumed" part of the pause is cut from the file: the cut is measured as
 *   (transcript length from recording start) - (file duration); without the duration, the whole pause;
 * - timestamps mark roughly the end of a phrase, so positions are shifted a few seconds earlier.
 */
export const AUDIO_LEAD = 3;

export function audioTimeline(transcript, rel, duration) {
  const find = (re, from = 0) => transcript.findIndex((m, i) => i >= from && m.speaker === "system" && re.test(m.text));
  const iStart = find(/транскрибирование запущены|транскрипция басталды|recording.*start/i);
  const iPause = find(/транскрибирование приостановлены|recording.*paus/i);
  const iResume = iPause >= 0 ? find(/транскрибирование возобновлены|recording.*resum/i, iPause) : -1;
  const start = iStart >= 0 ? rel[iStart] ?? 0 : 0;
  const pause = iResume >= 0 ? rel[iPause] : null;
  const resume = iResume >= 0 ? rel[iResume] : null;
  const end = rel.filter((s) => s !== null && s !== undefined).pop() ?? 0;
  let cut = 0;
  if (pause !== null && resume !== null) {
    cut = duration && Number.isFinite(duration) ? Math.max(0, end - start - duration) : resume - pause;
  }
  return rel.map((s) => {
    if (s === null || s === undefined) return null;
    let a = s - start;
    if (pause !== null) {
      if (s >= resume) a -= cut;
      else if (s > pause) a = pause - start;
    }
    return Math.max(0, Math.round(a - AUDIO_LEAD));
  });
}

// Deterministic pseudo-random [0,1) so the waveform looks the same on every render.
function rnd(a, b) {
  let h = (a * 374761393 + b * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * @param host     element to render into
 * @param opts     { audioUrl, sourceUrl, segments, onSegment(n), onActive(n|null),
 *                  retime(duration) -> segments: rebuild the timeline once the real file length is known }
 */
export function createPlayer(host, { audioUrl, sourceUrl, segments, onSegment, onActive, retime }) {
  let transcriptEnd = segments.reduce((mx, s) => Math.max(mx, s.end), 0) || 1;
  const st = {
    audioDur: null, mode: "full", failed: !audioUrl, raf: 0, active: null, rate: 0,
    evidence: new Set(), focus: null, range: new Set(),
  };

  host.innerHTML = `
    <section class="cv-player ${audioUrl ? "" : "is-noaudio"}" aria-label="Запись звонка">
      <div class="cv-pl-top">
        <button class="cv-pl-play" type="button" data-pl="play" aria-label="Воспроизвести" ${audioUrl ? "" : "disabled"}>${ICON_PLAY}</button>
        <div class="cv-tl" aria-label="Шкала времени по репликам">
          <div class="cv-tl-tracks" data-pl="tracks">
            <div class="cv-lane"></div>
            <div class="cv-playhead" data-pl="head" aria-hidden="true"></div>
            <div class="cv-hover" data-pl="hover" aria-hidden="true"></div>
          </div>
          <input class="cv-pl-seek" type="range" min="0" step="0.1" value="0" data-pl="seek" aria-label="Позиция в записи" ${audioUrl ? "" : "disabled"}>
        </div>
        <div class="cv-pl-time" aria-live="off"><b data-pl="cur">00:00</b><span> / </span><span data-pl="dur">${fmtClock(transcriptEnd)}</span></div>
      </div>
      <div class="cv-pl-extras">
        <span class="cv-pl-status" data-pl="status">${audioUrl ? "" : "Запись недоступна. Можно открыть реплики на шкале."}</span>
        <div class="cv-pl-tools">
          <div class="cv-seg-toggle" data-pl="zoom" role="group" aria-label="Масштаб таймлайна" hidden>
            <button type="button" data-mode="full" aria-pressed="true">Вся запись</button>
            <button type="button" data-mode="dialog" aria-pressed="false">Реплики</button>
          </div>
          ${audioUrl ? `<button class="btn btn-sm btn-ghost cv-pl-rate" type="button" data-pl="rate" aria-label="Скорость воспроизведения">1×</button>
          <a class="btn" href="${esc(safeHref(sourceUrl || audioUrl))}" target="_blank" rel="noopener">Открыть в плеере ↗</a>` : ""}
        </div>
      </div>
      ${audioUrl ? `<audio data-pl="audio" preload="metadata" src="${esc(audioUrl)}"></audio>` : ""}
    </section>`;

  const q = (k) => host.querySelector(`[data-pl="${k}"]`);
  const el = {
    play: q("play"), cur: q("cur"), dur: q("dur"), status: q("status"), zoom: q("zoom"), rate: q("rate"),
    tracks: q("tracks"), head: q("head"), hover: q("hover"), seek: q("seek"), audio: q("audio"),
  };
  const audio = el.audio;

  const range = () => (st.mode === "dialog" ? transcriptEnd : Math.max(st.audioDur || 0, transcriptEnd));
  const now = () => (audio && !st.failed ? audio.currentTime || 0 : 0);
  const playing = () => !!audio && !audio.paused && !audio.ended;

  function layout() {
    const R = range();
    const visible = segments.filter((s) => s.start <= R);
    const heights = new Array(BARS).fill(0.08);
    for (const s of visible) {
      const first = Math.floor(s.start / R * BARS);
      const last = Math.min(BARS - 1, Math.max(first, Math.ceil(Math.min(s.end, R) / R * BARS) - 1));
      for (let i = first; i <= last; i++) heights[i] = Math.max(heights[i], 0.25 + 0.72 * rnd(s.n, i));
    }
    const step = 1000 / BARS;
    const bars = heights.map((h, i) => `<rect x="${(i * step + step * .2).toFixed(2)}" y="${(20 - h * 18).toFixed(2)}" width="${(step * .55).toFixed(2)}" height="${(h * 36).toFixed(2)}" rx="2"/>`).join("");
    const svg = (cls) => `<svg class="cv-wave ${cls}" viewBox="0 0 1000 40" preserveAspectRatio="none" aria-hidden="true">${bars}</svg>`;
    el.tracks.querySelector(".cv-lane").innerHTML = visible.map((s) => {
      const left = s.start / R * 100, width = (Math.min(s.end, R) - s.start) / R * 100;
      const who = SPEAKER[s.speaker] || s.speaker || "";
      const label = `#${s.n} · ${who} · ${fmtClock(s.start)} — ${s.text.length > 70 ? s.text.slice(0, 70) + "…" : s.text}`;
      return `<button type="button" class="cv-seg" data-seg="${s.n}" style="left:${left.toFixed(3)}%;width:${width.toFixed(3)}%" title="${esc(label)}" aria-label="${esc(label)}"></button>`;
    }).join("") + svg("") + svg("is-played");
    el.seek.max = String(R);
    applyMarks();
    tick();
  }

  function tick() {
    const t = now(), R = range();
    const p = Math.max(0, Math.min(1, t / R));
    el.head.style.left = `${p * 100}%`;
    el.head.classList.toggle("is-off", t > R + 0.01);
    el.tracks.querySelectorAll(".cv-wave.is-played").forEach((s) => (s.style.clipPath = `inset(0 ${(100 - p * 100).toFixed(3)}% 0 0)`));
    el.cur.textContent = fmtClock(t);
    if (document.activeElement !== el.seek) el.seek.value = String(Math.min(t, R));
    // Active (karaoke) message while playing: the last segment that already started.
    if (playing()) {
      let act = null;
      for (const s of segments) if (s.start <= t + 0.3 && (!act || s.start >= act.start)) act = s;
      setActive(act ? act.n : null);
    }
  }

  function setActive(n) {
    if (n !== st.active) {
      st.active = n;
      el.tracks.querySelectorAll(".cv-seg.is-active").forEach((b) => b.classList.remove("is-active"));
      if (n) el.tracks.querySelector(`.cv-seg[data-seg="${n}"]`)?.classList.add("is-active");
      onActive && onActive(n, playing());
    }
  }

  function loop() {
    tick();
    st.raf = playing() ? requestAnimationFrame(loop) : 0;
  }

  function setPlayIcon() {
    const on = playing();
    el.play.innerHTML = on ? ICON_PAUSE : ICON_PLAY;
    el.play.setAttribute("aria-label", on ? "Пауза" : "Воспроизвести");
    host.querySelector(".cv-player").classList.toggle("is-playing", on);
  }

  function fail(msg) {
    st.failed = true;
    el.play.disabled = true;
    el.seek.disabled = true;
    el.status.textContent = msg;
    host.querySelector(".cv-player").classList.add("is-failed");
    setPlayIcon();
  }

  async function play() {
    if (!audio || st.failed) return false;
    try { await audio.play(); return true; } catch (e) {
      if (e && e.name === "AbortError") return false;
      el.status.textContent = "Браузер не смог воспроизвести запись — откройте её по ссылке";
      return false;
    }
  }

  function seekTo(sec, { autoplay = false } = {}) {
    if (!audio || st.failed || sec === null || sec === undefined) return;
    try { audio.currentTime = Math.max(0, sec); } catch { /* metadata not ready */ }
    if (!autoplay && !playing()) setActive(null);
    if (autoplay) play();
    tick();
  }

  function applyMarks() {
    el.tracks.querySelectorAll(".cv-seg").forEach((b) => {
      const n = Number(b.dataset.seg);
      b.classList.toggle("is-evidence", st.evidence.has(n));
      b.classList.toggle("is-range", st.range.has(n));
      b.classList.toggle("is-focus", st.focus === n);
      b.classList.toggle("is-active", st.active === n);
    });
  }

  // ---- events
  const on = (t, ev, fn) => { t.addEventListener(ev, fn); offs.push(() => t.removeEventListener(ev, fn)); };
  const offs = [];
  on(el.play, "click", () => (playing() ? audio.pause() : play()));
  if (el.rate) on(el.rate, "click", () => {
    st.rate = (st.rate + 1) % RATES.length;
    audio.playbackRate = RATES[st.rate];
    el.rate.textContent = `${String(RATES[st.rate]).replace(".", ",")}×`;
  });
  on(el.zoom, "click", (e) => {
    const b = e.target.closest("[data-mode]");
    if (!b) return;
    st.mode = b.dataset.mode;
    el.zoom.querySelectorAll("[data-mode]").forEach((x) => x.setAttribute("aria-pressed", String(x.dataset.mode === st.mode)));
    layout();
  });
  on(el.seek, "input", () => { if (audio && !st.failed) { audio.currentTime = Number(el.seek.value); if (!playing()) setActive(null); tick(); } });
  on(el.tracks, "click", (e) => {
    const seg = e.target.closest("[data-seg]");
    if (seg) {
      const s = segments.find((x) => x.n === Number(seg.dataset.seg));
      seekTo(s.start);
      onSegment && onSegment(s.n);
      return;
    }
    if (!audio || st.failed) return;
    const r = el.tracks.getBoundingClientRect();
    const t = ((e.clientX - r.left) / r.width) * range();
    audio.currentTime = Math.max(0, t);
    if (!playing()) setActive(null);
    tick();
  });
  on(el.tracks, "mousemove", (e) => {
    const r = el.tracks.getBoundingClientRect();
    const f = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    el.hover.style.left = `${f * 100}%`;
    el.hover.dataset.t = fmtClock(f * range());
    el.hover.classList.add("is-on");
  });
  on(el.tracks, "mouseleave", () => el.hover.classList.remove("is-on"));

  if (audio) {
    on(audio, "loadedmetadata", () => {
      if (Number.isFinite(audio.duration) && audio.duration > 0) {
        st.audioDur = audio.duration;
        el.dur.textContent = fmtClock(audio.duration);
        const fresh = retime && retime(audio.duration);
        if (fresh) {
          segments.splice(0, segments.length, ...fresh);
          transcriptEnd = segments.reduce((mx, s) => Math.max(mx, s.end), 0) || 1;
        }
        // The recording is much longer than the transcript: offer a zoom on the replies.
        if (audio.duration > transcriptEnd * 1.5 + 5) {
          el.zoom.hidden = false;
          st.mode = "dialog";
          el.zoom.querySelectorAll("[data-mode]").forEach((x) => x.setAttribute("aria-pressed", String(x.dataset.mode === st.mode)));
        }
        layout();
      }
    });
    on(audio, "error", () => fail("Запись не загрузилась (ошибка сети или доступа) — откройте её по ссылке"));
    on(audio, "play", () => { setPlayIcon(); cancelAnimationFrame(st.raf); loop(); });
    on(audio, "pause", () => { setPlayIcon(); tick(); });
    on(audio, "ended", () => { setPlayIcon(); tick(); });
    on(audio, "seeked", tick);
    on(audio, "waiting", () => host.querySelector(".cv-player").classList.add("is-buffering"));
    on(audio, "playing", () => host.querySelector(".cv-player").classList.remove("is-buffering"));
  }

  layout();

  return {
    hasAudio: () => !!audio && !st.failed,
    isPlaying: playing,
    seekTo,
    play,
    setMarks({ evidence, range: rng, focus } = {}) {
      if (evidence !== undefined) st.evidence = new Set(evidence || []);
      if (rng !== undefined) st.range = new Set(rng || []);
      if (focus !== undefined) st.focus = focus;
      applyMarks();
    },
    destroy() {
      cancelAnimationFrame(st.raf);
      if (audio) { try { audio.pause(); audio.removeAttribute("src"); audio.load(); } catch { /* ignore */ } }
      offs.forEach((f) => f());
    },
  };
}

// External data: allow only http(s) (and same-origin relative) links.
function safeHref(u) {
  const s = String(u || "").trim();
  if (/^https?:\/\//i.test(s) || /^\/(?!\/)/.test(s)) return s;
  return "#";
}
