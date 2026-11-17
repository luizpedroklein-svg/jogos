// Estado do projeto e utilitários compartilhados.

let nextId = 1;
export const uid = (p = "id") => `${p}${nextId++}`;

export const ASPECTS = {
  "16:9": [1280, 720],
  "9:16": [720, 1280],
  "1:1": [1080, 1080],
};

export const DEFAULT_FILTERS = () => ({
  brightness: 100,
  contrast: 100,
  saturate: 100,
  grayscale: 0,
  sepia: 0,
  blur: 0,
  hue: 0,
});

export const state = {
  aspect: "16:9",
  width: 1280,
  height: 720,
  media: [], // {id, name, type, url, el, duration, thumb}
  clips: [], // trilha principal (sequencial)
  texts: [], // sobreposições de texto
  audio: null, // {mediaId, volume, offset}
  currentTime: 0,
  playing: false,
  selected: null, // {type: 'clip'|'text'|'audio', id}
  zoom: 60, // px por segundo
};

/** Duração efetiva do clipe na timeline. */
export function clipDuration(c) {
  if (c.kind === "video") return Math.max(0.1, (c.out - c.in) / (c.speed || 1));
  return Math.max(0.1, c.duration);
}

/** Lista de clipes com início/fim calculados. */
export function layoutClips() {
  let t = 0;
  return state.clips.map((c) => {
    const d = clipDuration(c);
    const item = { clip: c, start: t, end: t + d, duration: d };
    t += d;
    return item;
  });
}

export function totalDuration() {
  const clipsEnd = state.clips.reduce((s, c) => s + clipDuration(c), 0);
  const textsEnd = state.texts.reduce((m, t) => Math.max(m, t.end), 0);
  return Math.max(clipsEnd, textsEnd, 0);
}

export function clipAt(time) {
  const items = layoutClips();
  for (let i = 0; i < items.length; i++) {
    if (time >= items[i].start && time < items[i].end) return { ...items[i], index: i };
  }
  return null;
}

export const getMedia = (id) => state.media.find((m) => m.id === id);

export function fmtTime(s) {
  s = Math.max(0, s || 0);
  const m = Math.floor(s / 60);
  const sec = s - m * 60;
  return `${String(m).padStart(2, "0")}:${sec.toFixed(1).padStart(4, "0")}`;
}

export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export function makeSceneClip(scene = {}) {
  return {
    id: uid("c"),
    kind: "scene",
    duration: scene.duration || 4,
    transition: scene.transition || "fade",
    filters: DEFAULT_FILTERS(),
    fit: "cover",
    motion: "none",
    scene: {
      title: scene.title ?? "Título",
      subtitle: scene.subtitle ?? "",
      emoji: scene.emoji ?? "",
      bg1: scene.bg1 || "#7c5cff",
      bg2: scene.bg2 || "#22d3ee",
      style: scene.style || "gradiente",
      anim: scene.anim || "subir",
      textColor: scene.textColor || "#ffffff",
      mediaId: scene.mediaId || null,
    },
    narration: scene.narration || "",
  };
}

export function makeMediaClip(media) {
  const base = {
    id: uid("c"),
    mediaId: media.id,
    transition: "none",
    filters: DEFAULT_FILTERS(),
    fit: "cover",
    volume: 1,
    speed: 1,
  };
  if (media.type === "video") {
    return { ...base, kind: "video", in: 0, out: media.duration || 5, motion: "none" };
  }
  return { ...base, kind: "image", duration: 4, motion: "zoom-in" };
}

export function makeText(opts = {}) {
  return {
    id: uid("t"),
    text: opts.text ?? "Seu texto aqui",
    start: opts.start ?? state.currentTime,
    end: opts.end ?? state.currentTime + 3,
    position: opts.position || "bottom", // top | center | bottom
    size: opts.size || 56,
    color: opts.color || "#ffffff",
    bg: opts.bg ?? "rgba(0,0,0,0.55)",
    bold: opts.bold ?? true,
    anim: opts.anim || "fade", // none | fade | slide | pop | typewriter
  };
}
