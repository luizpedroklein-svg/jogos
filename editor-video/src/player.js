// Reprodução sincronizada (vídeo, música, narração) e exportação.
import { state, layoutClips, getMedia, totalDuration } from "./state.js";
import { renderFrame } from "./renderer.js";

let canvas, ctx;
let onTick = () => {};
let lastTs = 0;
let rafId = 0;
let audioCtx = null;
let streamDest = null;
const sources = new WeakMap();
let lastNarrated = null;
export let narrationEnabled = false;
export const setNarration = (v) => {
  narrationEnabled = v;
  if (!v) speechSynthesis?.cancel();
};

export function initPlayer(cv, tickCb) {
  canvas = cv;
  ctx = cv.getContext("2d");
  onTick = tickCb;
  loop(performance.now());
}

function ensureAudio() {
  if (audioCtx) return;
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    streamDest = audioCtx.createMediaStreamDestination();
  } catch {
    audioCtx = null;
  }
}

/** Liga um elemento de mídia ao grafo de áudio (para que o som entre na exportação). */
function route(el) {
  if (!audioCtx || sources.has(el)) return;
  try {
    const src = audioCtx.createMediaElementSource(el);
    src.connect(audioCtx.destination);
    src.connect(streamDest);
    sources.set(el, src);
  } catch {
    /* elemento já conectado */
  }
}

export function resize() {
  canvas.width = state.width;
  canvas.height = state.height;
  requestRender();
}

let dirty = true;
export const requestRender = () => (dirty = true);

export function play() {
  ensureAudio();
  audioCtx?.resume();
  if (state.currentTime >= totalDuration() - 0.05) state.currentTime = 0;
  state.playing = true;
  lastNarrated = null;
  lastTs = performance.now();
}

export function pause() {
  state.playing = false;
  for (const m of state.media) if (m.el && m.el.pause) m.el.pause();
  speechSynthesis?.cancel();
  requestRender();
}

export function seek(t) {
  state.currentTime = Math.max(0, Math.min(t, totalDuration()));
  lastNarrated = null;
  speechSynthesis?.cancel();
  requestRender();
}

function syncMedia(time, playing) {
  const items = layoutClips();
  const active = items.find((it) => time >= it.start && time < it.end);
  const activeEls = new Set();

  if (active) {
    const c = active.clip;
    const local = time - active.start;
    let m = null, desired = 0, rate = 1, vol = 1;
    if (c.kind === "video") {
      m = getMedia(c.mediaId);
      desired = c.in + local * (c.speed || 1);
      rate = c.speed || 1;
      vol = c.volume ?? 1;
    } else if (c.kind === "scene" && c.scene.mediaId) {
      m = getMedia(c.scene.mediaId);
      if (m && m.type === "video") desired = local % (m.duration || 1);
      vol = 0;
      if (m && m.type !== "video") m = null;
    }
    if (m && m.el) {
      const el = m.el;
      activeEls.add(el);
      if (playing) route(el);
      el.volume = Math.max(0, Math.min(1, vol));
      el.muted = vol === 0;
      if (Math.abs(el.playbackRate - rate) > 0.01) el.playbackRate = rate;
      const drift = Math.abs(el.currentTime - desired);
      if (playing) {
        if (drift > 0.3) el.currentTime = desired;
        if (el.paused) el.play().catch(() => {});
      } else {
        if (!el.paused) el.pause();
        if (drift > 0.03 && !el.seeking) {
          el.currentTime = desired;
          el.addEventListener("seeked", requestRender, { once: true });
        }
      }
    }
    // narração por voz (preview)
    if (playing && narrationEnabled && c.narration && lastNarrated !== c.id && "speechSynthesis" in window) {
      lastNarrated = c.id;
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(c.narration);
      u.lang = "pt-BR";
      u.rate = 1.05;
      speechSynthesis.speak(u);
    }
  }

  // música de fundo
  if (state.audio) {
    const m = getMedia(state.audio.mediaId);
    if (m && m.el) {
      const el = m.el;
      activeEls.add(el);
      const desired = time - (state.audio.offset || 0);
      el.volume = Math.max(0, Math.min(1, state.audio.volume ?? 0.6));
      if (playing && desired >= 0 && desired < (m.duration || Infinity)) {
        route(el);
        if (Math.abs(el.currentTime - desired) > 0.3) el.currentTime = desired;
        if (el.paused) el.play().catch(() => {});
      } else if (!el.paused) el.pause();
    }
  }

  for (const m of state.media) {
    if (m.el && m.el.pause && !activeEls.has(m.el) && !m.el.paused) m.el.pause();
  }
}

function loop(ts) {
  rafId = requestAnimationFrame(loop);
  if (state.playing) {
    const dt = (ts - lastTs) / 1000;
    state.currentTime += Math.min(dt, 0.25);
    const total = totalDuration();
    if (state.currentTime >= total) {
      state.currentTime = total;
      pause();
      exportDone?.();
    }
    dirty = true;
  }
  lastTs = ts;
  syncMedia(state.currentTime, state.playing);
  if (dirty || state.playing) {
    renderFrame(ctx, state.currentTime);
    dirty = false;
    onTick();
  }
}

// --- Exportação ---
let exportDone = null;
let recorder = null;

function pickMime() {
  const opts = [
    "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
    "video/mp4;codecs=avc1.42E01E,opus",
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
  ];
  return opts.find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || "";
}

export function exportVideo(onProgress) {
  return new Promise((resolve, reject) => {
    const total = totalDuration();
    if (total <= 0) return reject(new Error("A timeline está vazia."));
    if (!window.MediaRecorder || !canvas.captureStream) return reject(new Error("Seu navegador não suporta gravação (use Chrome, Edge ou Firefox)."));
    ensureAudio();
    audioCtx?.resume();
    for (const m of state.media) if (m.el && m.type !== "image") route(m.el);

    const stream = canvas.captureStream(30);
    if (streamDest) streamDest.stream.getAudioTracks().forEach((t) => stream.addTrack(t));
    const mimeType = pickMime();
    const chunks = [];
    try {
      recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 8_000_000 });
    } catch (e) {
      return reject(e);
    }
    recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    let cancelled = false;
    recorder.onstop = () => {
      clearInterval(timer);
      exportDone = null;
      stream.getVideoTracks().forEach((t) => t.stop());
      if (cancelled) return reject(new Error("cancelado"));
      const type = recorder.mimeType || mimeType || "video/webm";
      resolve({ blob: new Blob(chunks, { type }), ext: type.includes("mp4") ? "mp4" : "webm" });
    };
    recorder._cancel = () => {
      cancelled = true;
      pause();
      recorder.state !== "inactive" && recorder.stop();
    };

    pause();
    state.currentTime = 0;
    // pequeno atraso para os vídeos buscarem o primeiro quadro
    setTimeout(() => {
      recorder.start(250);
      play();
      exportDone = () => setTimeout(() => recorder.state !== "inactive" && recorder.stop(), 150);
    }, 400);
    const timer = setInterval(() => onProgress?.(state.currentTime / total), 200);
  });
}

export function cancelExport() {
  recorder?._cancel?.();
}

export function snapshot(maxW = 768) {
  const s = Math.min(1, maxW / canvas.width);
  const c = document.createElement("canvas");
  c.width = Math.round(canvas.width * s);
  c.height = Math.round(canvas.height * s);
  c.getContext("2d").drawImage(canvas, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", 0.8).split(",")[1];
}

export function stopAll() {
  cancelAnimationFrame(rafId);
}
