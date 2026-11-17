import {
  state, uid, ASPECTS, DEFAULT_FILTERS, clipDuration, layoutClips, totalDuration, clipAt,
  getMedia, fmtTime, clamp, makeSceneClip, makeMediaClip, makeText,
} from "./state.js";
import { initPlayer, play, pause, seek, resize, requestRender, exportVideo, cancelExport, snapshot, setNarration } from "./player.js";
import {
  getApiKey, getModel, saveSettings, hasAI, generateStoryboard, offlineStoryboard,
  assistantCommand, offlineCommand,
} from "./ai.js";

const $ = (s) => document.querySelector(s);
const el = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) e.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids.flat()) if (k != null) e.append(k.nodeType ? k : document.createTextNode(k));
  return e;
};

function toast(msg, ms = 2500) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove("show"), ms);
}

// ---------------------------------------------------------------------------
// Desfazer / refazer
// ---------------------------------------------------------------------------
const undoStack = [];
const redoStack = [];
let lastUndoKey = null, lastUndoAt = 0;
const snap = () => JSON.stringify({ clips: state.clips, texts: state.texts, audio: state.audio });

function pushUndo(key = null) {
  const now = Date.now();
  if (key && key === lastUndoKey && now - lastUndoAt < 1200) {
    lastUndoAt = now;
    return;
  }
  lastUndoKey = key;
  lastUndoAt = now;
  undoStack.push(snap());
  if (undoStack.length > 100) undoStack.shift();
  redoStack.length = 0;
}
function restore(s) {
  const d = JSON.parse(s);
  state.clips = d.clips;
  state.texts = d.texts;
  state.audio = d.audio;
  if (state.selected && !findSelected()) state.selected = null;
  changed();
}
function undo() {
  if (!undoStack.length) return toast("Nada para desfazer");
  redoStack.push(snap());
  restore(undoStack.pop());
  lastUndoKey = null;
}
function redo() {
  if (!redoStack.length) return;
  undoStack.push(snap());
  restore(redoStack.pop());
}

/** Executa uma alteração com suporte a desfazer. */
function mutate(fn, key = null) {
  pushUndo(key);
  fn();
  changed();
}

function changed() {
  state.currentTime = Math.min(state.currentTime, totalDuration());
  renderTimeline();
  renderProps();
  requestRender();
}

// ---------------------------------------------------------------------------
// Mídia
// ---------------------------------------------------------------------------
function loadMedia(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const type = file.type.startsWith("video") ? "video" : file.type.startsWith("audio") ? "audio" : file.type.startsWith("image") ? "image" : null;
    if (!type) return resolve(null);
    const m = { id: uid("m"), name: file.name, type, url, el: null, duration: 0, thumb: "" };
    if (type === "image") {
      const img = new Image();
      img.onload = () => { m.el = img; m.thumb = url; resolve(m); };
      img.onerror = () => resolve(null);
      img.src = url;
    } else {
      const media = document.createElement(type);
      media.preload = "auto";
      media.crossOrigin = "anonymous";
      if (type === "video") { media.playsInline = true; media.setAttribute("playsinline", ""); }
      media.onloadedmetadata = () => {
        m.duration = media.duration;
        m.el = media;
        if (type === "video") {
          media.currentTime = Math.min(0.5, media.duration / 3);
          media.addEventListener("seeked", () => {
            try {
              const c = document.createElement("canvas");
              c.width = 160; c.height = 90;
              const cx = c.getContext("2d");
              const r = Math.max(160 / media.videoWidth, 90 / media.videoHeight);
              cx.drawImage(media, (160 - media.videoWidth * r) / 2, (90 - media.videoHeight * r) / 2, media.videoWidth * r, media.videoHeight * r);
              m.thumb = c.toDataURL("image/jpeg", 0.7);
            } catch { /* sem miniatura */ }
            resolve(m);
          }, { once: true });
        } else resolve(m);
      };
      media.onerror = () => resolve(null);
      media.src = url;
    }
  });
}

async function importFiles(files) {
  const list = [...files];
  if (!list.length) return;
  toast(`Importando ${list.length} arquivo(s)…`);
  for (const f of list) {
    const m = await loadMedia(f);
    if (m) state.media.push(m);
    else toast(`Formato não suportado: ${f.name}`);
  }
  renderMedia();
}

function addMediaToTimeline(m, index = state.clips.length) {
  mutate(() => {
    if (m.type === "audio") {
      state.audio = { mediaId: m.id, volume: 0.6, offset: 0 };
      state.selected = { type: "audio", id: m.id };
    } else {
      const c = makeMediaClip(m);
      state.clips.splice(index, 0, c);
      state.selected = { type: "clip", id: c.id };
    }
  });
}

function renderMedia() {
  const list = $("#media-list");
  list.innerHTML = "";
  for (const m of state.media) {
    const icon = m.type === "audio" ? "🎵" : m.type === "video" ? "" : "";
    const item = el("div", { class: "media-item", draggable: "true", title: m.name },
      el("div", { class: "thumb", style: m.thumb ? `background-image:url(${m.thumb})` : "" }, icon),
      el("div", { class: "meta" }, `${m.type === "video" ? "🎞️" : m.type === "image" ? "🖼️" : "🎵"} ${m.name}${m.duration ? ` · ${fmtTime(m.duration)}` : ""}`),
      el("button", { class: "add", title: "Adicionar à timeline", onclick: () => addMediaToTimeline(m) }, "＋"),
    );
    item.addEventListener("dragstart", (e) => e.dataTransfer.setData("text/media-id", m.id));
    item.addEventListener("dblclick", () => addMediaToTimeline(m));
    list.append(item);
  }
}

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------
const tracks = $("#tracks");
const scroll = $("#tracks-scroll");

function clipLabel(c) {
  if (c.kind === "scene") return `${c.scene.emoji || "✨"} ${c.scene.title || "Cena"}`;
  return getMedia(c.mediaId)?.name || "Mídia ausente";
}

function isSel(type, id) {
  return state.selected && state.selected.type === type && state.selected.id === id;
}

function renderTimeline() {
  const pps = state.zoom;
  const total = totalDuration();
  const width = Math.max(scroll.clientWidth, (total + 10) * pps);
  tracks.style.width = width + "px";

  // régua
  const ruler = $("#ruler");
  ruler.innerHTML = "";
  const step = pps >= 100 ? 1 : pps >= 40 ? 2 : pps >= 20 ? 5 : 10;
  for (let s = 0; s * pps < width; s += step) {
    ruler.append(el("div", { class: "tick", style: `left:${s * pps}px` }, fmtTime(s).replace(/\.0$/, "")));
  }

  // vídeo
  const tv = $("#track-video");
  tv.innerHTML = "";
  layoutClips().forEach((it, i) => {
    const c = it.clip;
    const m = c.mediaId ? getMedia(c.mediaId) : null;
    const node = el("div", {
      class: `tl-item ${c.kind}${isSel("clip", c.id) ? " selected" : ""}`,
      style: `left:${it.start * pps}px;width:${Math.max(4, it.duration * pps - 2)}px;${m?.thumb ? `background-image:url(${m.thumb})` : c.kind === "scene" ? `background-image:linear-gradient(90deg,${c.scene.bg1},${c.scene.bg2})` : ""}`,
      title: `${i + 1}. ${clipLabel(c)} (${it.duration.toFixed(1)}s)`,
      "data-id": c.id,
    },
      el("div", { class: "handle l" }),
      el("span", { class: "label-txt" }, `${i + 1}. ${clipLabel(c)}${c.speed && c.speed !== 1 ? ` · ${c.speed}x` : ""}`),
      el("div", { class: "handle r" }),
    );
    bindClipDrag(node, c);
    tv.append(node);
  });

  // textos
  const tt = $("#track-text");
  tt.innerHTML = "";
  // distribui textos sobrepostos em faixas
  const laneEnds = [];
  const lanes = new Map();
  [...state.texts].sort((a, b) => a.start - b.start).forEach((tx) => {
    let l = laneEnds.findIndex((end) => end <= tx.start + 0.001);
    if (l < 0) { l = laneEnds.length; laneEnds.push(0); }
    laneEnds[l] = tx.end;
    lanes.set(tx, l);
  });
  const nLanes = Math.max(1, laneEnds.length);
  const laneH = 40 / nLanes;
  for (const tx of state.texts) {
    const node = el("div", {
      class: `tl-item text${isSel("text", tx.id) ? " selected" : ""}`,
      style: `left:${tx.start * pps}px;width:${Math.max(4, (tx.end - tx.start) * pps)}px;top:${5 + lanes.get(tx) * laneH}px;height:${laneH - 1}px;padding-top:0;padding-bottom:0;line-height:${laneH - 1}px`,
      title: tx.text,
    }, el("div", { class: "handle l" }), el("span", { class: "label-txt" }, tx.text), el("div", { class: "handle r" }));
    bindTextDrag(node, tx);
    tt.append(node);
  }

  // áudio
  const ta = $("#track-audio");
  ta.innerHTML = "";
  if (state.audio) {
    const m = getMedia(state.audio.mediaId);
    if (m) {
      const node = el("div", {
        class: `tl-item audio${isSel("audio", m.id) ? " selected" : ""}`,
        style: `left:${(state.audio.offset || 0) * pps}px;width:${Math.max(4, m.duration * pps)}px`,
      }, el("span", { class: "label-txt" }, `🎵 ${m.name}`));
      bindAudioDrag(node);
      ta.append(node);
    }
  }
  $("#tl-info").textContent = `${state.clips.length} clipe(s) · ${state.texts.length} texto(s) · ${fmtTime(total)}`;
  updatePlayhead();
}

function updatePlayhead() {
  $("#playhead").style.left = state.currentTime * state.zoom + "px";
  $("#time").textContent = `${fmtTime(state.currentTime)} / ${fmtTime(totalDuration())}`;
  $("#btn-play").textContent = state.playing ? "⏸" : "▶";
  if (state.playing) {
    const x = state.currentTime * state.zoom;
    if (x > scroll.scrollLeft + scroll.clientWidth - 40 || x < scroll.scrollLeft) scroll.scrollLeft = x - 60;
  }
}

/** Arrastar genérico com limiar. */
function dragHelper(node, { onStart, onMove, onEnd, onClick }) {
  node.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const target = e.target.classList.contains("handle") ? (e.target.classList.contains("l") ? "l" : "r") : "body";
    const x0 = e.clientX;
    let started = false;
    node.setPointerCapture(e.pointerId);
    const move = (ev) => {
      const dx = ev.clientX - x0;
      if (!started && Math.abs(dx) > 4) {
        started = true;
        onStart?.(target);
      }
      if (started) onMove?.(target, dx / state.zoom, ev);
    };
    const up = (ev) => {
      node.removeEventListener("pointermove", move);
      node.removeEventListener("pointerup", up);
      node.removeEventListener("pointercancel", up);
      if (started) onEnd?.(target, ev);
      else onClick?.();
    };
    node.addEventListener("pointermove", move);
    node.addEventListener("pointerup", up);
    node.addEventListener("pointercancel", up);
  });
}

function select(type, id) {
  state.selected = { type, id };
  renderTimeline();
  renderProps();
}

function bindClipDrag(node, c) {
  let orig, dropIndex;
  dragHelper(node, {
    onClick: () => select("clip", c.id),
    onStart: () => {
      pushUndo();
      orig = { ...c };
      state.selected = { type: "clip", id: c.id };
    },
    onMove: (target, dt, ev) => {
      if (target === "body") {
        // reordenar: calcula posição de soltura
        const rect = tracks.getBoundingClientRect();
        const t = (ev.clientX - rect.left) / state.zoom;
        const items = layoutClips();
        dropIndex = items.findIndex((it) => t < it.start + it.duration / 2);
        if (dropIndex < 0) dropIndex = items.length;
        node.style.transform = `translateX(${dt * state.zoom}px)`;
        node.style.opacity = 0.7;
        node.style.zIndex = 4;
        return;
      }
      if (c.kind === "video") {
        const m = getMedia(c.mediaId);
        const sp = c.speed || 1;
        if (target === "l") c.in = clamp(orig.in + dt * sp, 0, c.out - 0.1);
        else c.out = clamp(orig.out + dt * sp, c.in + 0.1, m?.duration || orig.out);
      } else {
        c.duration = Math.max(0.3, orig.duration + (target === "l" ? -dt : dt));
      }
      renderTimeline();
      requestRender();
    },
    onEnd: (target) => {
      if (target === "body" && dropIndex != null) {
        const from = state.clips.indexOf(c);
        let to = dropIndex > from ? dropIndex - 1 : dropIndex;
        state.clips.splice(from, 1);
        state.clips.splice(to, 0, c);
      }
      dropIndex = null;
      changed();
    },
  });
}

function bindTextDrag(node, tx) {
  let orig;
  dragHelper(node, {
    onClick: () => select("text", tx.id),
    onStart: () => { pushUndo(); orig = { ...tx }; state.selected = { type: "text", id: tx.id }; },
    onMove: (target, dt) => {
      if (target === "body") {
        const d = orig.end - orig.start;
        tx.start = Math.max(0, orig.start + dt);
        tx.end = tx.start + d;
      } else if (target === "l") tx.start = clamp(orig.start + dt, 0, tx.end - 0.2);
      else tx.end = Math.max(tx.start + 0.2, orig.end + dt);
      renderTimeline();
      requestRender();
    },
    onEnd: () => changed(),
  });
}

function bindAudioDrag(node) {
  let orig;
  dragHelper(node, {
    onClick: () => select("audio", state.audio.mediaId),
    onStart: () => { pushUndo(); orig = state.audio.offset || 0; },
    onMove: (_t, dt) => { state.audio.offset = Math.max(0, orig + dt); renderTimeline(); },
    onEnd: () => changed(),
  });
}

// régua / clique na trilha = posicionar o cursor
function bindScrub(area) {
  area.addEventListener("pointerdown", (e) => {
    if (e.target.closest(".tl-item")) return;
    const rect = tracks.getBoundingClientRect();
    const go = (ev) => {
      seek((ev.clientX - rect.left) / state.zoom);
      updatePlayhead();
    };
    if (state.playing) pause();
    go(e);
    if (e.target.closest("#ruler")) {
      const mv = (ev) => go(ev);
      const up = () => { window.removeEventListener("pointermove", mv); window.removeEventListener("pointerup", up); };
      window.addEventListener("pointermove", mv);
      window.addEventListener("pointerup", up);
    } else if (state.selected) {
      state.selected = null;
      renderTimeline();
      renderProps();
    }
  });
}
bindScrub(tracks);

// soltar mídia na trilha
const tv = $("#track-video");
tracks.addEventListener("dragover", (e) => e.preventDefault());
tracks.addEventListener("drop", (e) => {
  e.preventDefault();
  const id = e.dataTransfer.getData("text/media-id");
  if (id) {
    const m = getMedia(id);
    if (!m) return;
    const t = (e.clientX - tracks.getBoundingClientRect().left) / state.zoom;
    let idx = layoutClips().findIndex((it) => t < it.start + it.duration / 2);
    if (idx < 0) idx = state.clips.length;
    addMediaToTimeline(m, idx);
  } else if (e.dataTransfer.files.length) {
    importFiles(e.dataTransfer.files);
  }
});

// ---------------------------------------------------------------------------
// Painel de propriedades
// ---------------------------------------------------------------------------
function findSelected() {
  const s = state.selected;
  if (!s) return null;
  if (s.type === "clip") return state.clips.find((c) => c.id === s.id);
  if (s.type === "text") return state.texts.find((t) => t.id === s.id);
  if (s.type === "audio") return state.audio && state.audio.mediaId === s.id ? state.audio : null;
  return null;
}

function field(label, input) {
  return el("label", {}, label, input);
}
function rangeField(label, obj, key, min, max, step = 1, suffix = "", after) {
  const out = el("output", {}, `${obj[key]}${suffix}`);
  const input = el("input", { type: "range", min, max, step, value: obj[key] });
  input.addEventListener("input", () => {
    pushUndo(`${label}-${obj.id || ""}`);
    obj[key] = Number(input.value);
    renderTimeline();
    requestRender();
    out.textContent = `${obj[key]}${suffix}`;
    after?.();
  });
  return el("label", {}, label, el("div", { class: "range-row" }, input, out));
}
function textField(label, obj, key, multiline = false) {
  const input = el(multiline ? "textarea" : "input", multiline ? { rows: 2 } : { type: "text", value: obj[key] ?? "" });
  if (multiline) input.value = obj[key] ?? "";
  input.addEventListener("input", () => {
    pushUndo(`${label}-${obj.id || ""}`);
    obj[key] = input.value;
    renderTimeline();
    requestRender();
  });
  return field(label, input);
}
function numberField(label, obj, key, step = 0.1, min = 0) {
  const input = el("input", { type: "number", step, min, value: Number(obj[key]).toFixed(2) });
  input.addEventListener("change", () => mutate(() => { obj[key] = Math.max(min, Number(input.value) || 0); }));
  return field(label, input);
}
function selectField(label, obj, key, options) {
  const s = el("select", {}, options.map(([v, t]) => el("option", { value: v, selected: obj[key] === v }, t)));
  s.addEventListener("change", () => mutate(() => { obj[key] = s.value; }));
  return field(label, s);
}
function colorField(label, obj, key) {
  const input = el("input", { type: "color", value: /^#[0-9a-f]{6}$/i.test(obj[key]) ? obj[key] : "#ffffff" });
  input.addEventListener("input", () => {
    pushUndo(`${label}-${obj.id || ""}`);
    obj[key] = input.value;
    renderTimeline();
    requestRender();
  });
  return field(label, input);
}
const section = (title, ...kids) => el("div", { class: "section" }, el("h4", {}, title), ...kids);

const FILTER_PRESETS = {
  nenhum: {},
  preto_e_branco: { grayscale: 100, contrast: 110 },
  sepia: { sepia: 80 },
  vivido: { saturate: 150, contrast: 110 },
  cinema: { contrast: 120, saturate: 85, brightness: 95 },
  frio: { hue: -12, saturate: 90, brightness: 103 },
  quente: { sepia: 25, saturate: 125 },
  desbotado: { contrast: 85, saturate: 70, brightness: 110 },
  vintage: { sepia: 45, contrast: 90, saturate: 80 },
  desfoque: { blur: 6 },
};
const PRESET_NAMES = {
  nenhum: "Nenhum", preto_e_branco: "Preto e branco", sepia: "Sépia", vivido: "Vívido", cinema: "Cinema",
  frio: "Frio", quente: "Quente", desbotado: "Desbotado", vintage: "Vintage", desfoque: "Desfoque",
};
const applyPreset = (c, p) => { c.filters = { ...DEFAULT_FILTERS(), ...(FILTER_PRESETS[p] || {}) }; };

function renderProps() {
  const box = $("#props");
  box.innerHTML = "";
  const obj = findSelected();
  if (!obj) {
    box.append(el("p", { class: "muted" }, "Selecione um clipe, texto ou música na timeline."),
      el("p", { class: "muted small" }, "Atalhos: Espaço = play · S = dividir · Delete = excluir · Ctrl+Z = desfazer · ←/→ = mover cursor"));
    return;
  }
  const type = state.selected.type;

  if (type === "clip") {
    const c = obj;
    const idx = state.clips.indexOf(c);
    box.append(el("p", { class: "small" }, el("strong", {}, `Clipe ${idx + 1}`), ` · ${clipLabel(c)}`));
    if (c.kind === "scene") {
      const sc = c.scene;
      sc.id = c.id;
      box.append(section("Cena",
        textField("Título", sc, "title", true),
        textField("Subtítulo", sc, "subtitle", true),
        textField("Emoji", sc, "emoji"),
        el("div", { class: "grid2" }, colorField("Cor 1", sc, "bg1"), colorField("Cor 2", sc, "bg2")),
        colorField("Cor do texto", sc, "textColor"),
        selectField("Fundo animado", sc, "style", [["gradiente", "Gradiente"], ["particulas", "Partículas"], ["bokeh", "Bokeh"], ["ondas", "Ondas"], ["listras", "Listras"], ["neon", "Neon"], ["solido", "Sólido"]]),
        selectField("Animação do texto", sc, "anim", [["subir", "Subir"], ["fade", "Aparecer"], ["zoom", "Zoom"], ["digitar", "Digitar"], ["deslizar", "Deslizar"], ["nenhuma", "Nenhuma"]]),
        selectField("Mídia de fundo", sc, "mediaId", [["", "Nenhuma"], ...state.media.filter((m) => m.type !== "audio").map((m) => [m.id, m.name])]),
        numberField("Duração (s)", c, "duration", 0.1, 0.3),
        textField("Narração (voz/legenda)", c, "narration", true),
      ));
    } else if (c.kind === "video") {
      const m = getMedia(c.mediaId);
      box.append(section("Corte",
        el("div", { class: "grid2" }, numberField("Início (s)", c, "in"), numberField("Fim (s)", c, "out")),
        el("p", { class: "small muted" }, `Original: ${fmtTime(m?.duration)} · Na timeline: ${clipDuration(c).toFixed(1)}s`),
        rangeField("Velocidade", c, "speed", 0.25, 4, 0.25, "x", renderTimeline),
        rangeField("Volume", c, "volume", 0, 1, 0.05),
      ));
    } else {
      box.append(section("Imagem", numberField("Duração (s)", c, "duration", 0.1, 0.3)));
    }

    if (c.kind !== "scene") {
      box.append(section("Enquadramento",
        selectField("Ajuste", c, "fit", [["cover", "Preencher (cortar)"], ["contain", "Caber (fundo desfocado)"]]),
        selectField("Movimento", c, "motion", [["none", "Nenhum"], ["zoom-in", "Zoom in (Ken Burns)"], ["zoom-out", "Zoom out"], ["pan-left", "Panorâmica ←"], ["pan-right", "Panorâmica →"]]),
      ));
    }

    const presetSel = el("select", {}, el("option", { value: "" }, "Escolher predefinição…"),
      Object.entries(PRESET_NAMES).map(([k, v]) => el("option", { value: k }, v)));
    presetSel.addEventListener("change", () => { if (presetSel.value) mutate(() => applyPreset(c, presetSel.value)); });
    const f = c.filters;
    f.id = c.id;
    box.append(section("Filtros",
      field("Predefinição", presetSel),
      rangeField("Brilho", f, "brightness", 0, 200, 1, "%"),
      rangeField("Contraste", f, "contrast", 0, 200, 1, "%"),
      rangeField("Saturação", f, "saturate", 0, 200, 1, "%"),
      rangeField("Preto e branco", f, "grayscale", 0, 100, 1, "%"),
      rangeField("Sépia", f, "sepia", 0, 100, 1, "%"),
      rangeField("Matiz", f, "hue", -180, 180, 1, "°"),
      rangeField("Desfoque", f, "blur", 0, 20, 0.5, "px"),
    ));
    box.append(section("Transição de entrada",
      selectField("Tipo", c, "transition", [["none", "Corte seco"], ["fade", "Fade (do preto)"]])));
    box.append(section("Ações", el("div", { class: "row gap wrap" },
      el("button", { onclick: () => moveClip(c, -1) }, "◀ Mover"),
      el("button", { onclick: () => moveClip(c, 1) }, "Mover ▶"),
      el("button", { onclick: () => duplicateClip(c) }, "Duplicar"),
      el("button", { class: "danger", onclick: deleteSelected }, "Excluir"),
    )));
  } else if (type === "text") {
    const tx = obj;
    box.append(
      section("Texto",
        textField("Conteúdo", tx, "text", true),
        el("div", { class: "grid2" }, numberField("Início (s)", tx, "start"), numberField("Fim (s)", tx, "end")),
        selectField("Posição", tx, "position", [["top", "Topo"], ["center", "Centro"], ["bottom", "Rodapé"]]),
        rangeField("Tamanho", tx, "size", 16, 160, 1),
        colorField("Cor", tx, "color"),
        selectField("Fundo", tx, "bg", [["rgba(0,0,0,0.55)", "Caixa escura"], ["rgba(255,255,255,0.85)", "Caixa clara"], ["rgba(124,92,255,0.9)", "Caixa roxa"], ["transparent", "Sem caixa (sombra)"]]),
        selectField("Animação", tx, "anim", [["none", "Nenhuma"], ["fade", "Aparecer"], ["slide", "Subir"], ["pop", "Pop"], ["typewriter", "Máquina de escrever"]]),
        el("label", { class: "check" }, (() => {
          const cb = el("input", { type: "checkbox", checked: tx.bold });
          cb.addEventListener("change", () => mutate(() => { tx.bold = cb.checked; }));
          return cb;
        })(), "Negrito"),
      ),
      section("Ações", el("div", { class: "row gap wrap" },
        el("button", { onclick: () => mutate(() => { const n = { ...tx, id: uid("t"), start: tx.end, end: tx.end + (tx.end - tx.start) }; state.texts.push(n); state.selected = { type: "text", id: n.id }; }) }, "Duplicar"),
        el("button", { class: "danger", onclick: deleteSelected }, "Excluir"),
      )),
    );
  } else if (type === "audio") {
    const a = obj;
    a.id = "audio";
    box.append(section("Música de fundo",
      el("p", { class: "small" }, getMedia(a.mediaId)?.name || ""),
      rangeField("Volume", a, "volume", 0, 1, 0.05),
      numberField("Começa em (s)", a, "offset"),
      el("button", { class: "danger", onclick: deleteSelected }, "Remover música"),
    ));
  }
}

// ---------------------------------------------------------------------------
// Operações de edição
// ---------------------------------------------------------------------------
function splitAt(t) {
  const hit = clipAt(t);
  if (!hit) return false;
  const c = hit.clip;
  const local = t - hit.start;
  if (local < 0.1 || hit.duration - local < 0.1) return false;
  const b = JSON.parse(JSON.stringify(c));
  b.id = uid("c");
  b.transition = "none";
  if (c.kind === "video") {
    const cut = c.in + local * (c.speed || 1);
    c.out = cut;
    b.in = cut;
  } else {
    b.duration = c.duration - local;
    c.duration = local;
  }
  state.clips.splice(hit.index + 1, 0, b);
  return true;
}

function moveClip(c, dir) {
  const i = state.clips.indexOf(c);
  const j = i + dir;
  if (j < 0 || j >= state.clips.length) return;
  mutate(() => { state.clips.splice(i, 1); state.clips.splice(j, 0, c); });
}
function duplicateClip(c) {
  mutate(() => {
    const d = JSON.parse(JSON.stringify(c));
    d.id = uid("c");
    state.clips.splice(state.clips.indexOf(c) + 1, 0, d);
    state.selected = { type: "clip", id: d.id };
  });
}
function deleteSelected() {
  const s = state.selected;
  if (!s) return;
  mutate(() => {
    if (s.type === "clip") state.clips = state.clips.filter((c) => c.id !== s.id);
    if (s.type === "text") state.texts = state.texts.filter((t) => t.id !== s.id);
    if (s.type === "audio") state.audio = null;
    state.selected = null;
  });
}

/** Aplica as operações devolvidas pelo assistente. Retorna descrições. */
function applyOperations(ops) {
  const before = [...state.clips];
  const pick = (n) => (n === 0 || n == null ? [...state.clips] : [before[n - 1]].filter((c) => c && state.clips.includes(c)));
  const done = [];
  for (const op of ops || []) {
    try {
      switch (op.op) {
        case "set_filter":
          pick(op.clip).forEach((c) => applyPreset(c, op.preset));
          done.push(`Filtro ${PRESET_NAMES[op.preset] || op.preset} → ${op.clip ? "clipe " + op.clip : "todos"}`);
          break;
        case "adjust":
          pick(op.clip).forEach((c) => (c.filters[op.property] = Number(op.value)));
          done.push(`Ajuste ${op.property}=${op.value} → ${op.clip ? "clipe " + op.clip : "todos"}`);
          break;
        case "add_text":
          state.texts.push(makeText({
            text: op.text, start: Math.max(0, op.start), end: Math.max(op.start + 0.3, op.end),
            position: op.position, color: op.color, size: op.size || 56, anim: op.anim,
            bg: op.background === false ? "transparent" : "rgba(0,0,0,0.55)",
          }));
          done.push(`Texto "${op.text}" (${fmtTime(op.start)}–${fmtTime(op.end)})`);
          break;
        case "remove_texts":
          state.texts = [];
          done.push("Textos removidos");
          break;
        case "delete_clip": {
          const del = pick(op.clip);
          state.clips = state.clips.filter((c) => !del.includes(c));
          done.push(`Clipe ${op.clip || "(todos)"} excluído`);
          break;
        }
        case "trim_clip":
          pick(op.clip).forEach((c) => {
            if (c.kind === "video") {
              c.in = Math.min(c.out - 0.1, c.in + Math.max(0, op.cut_start || 0));
              c.out = Math.max(c.in + 0.1, c.out - Math.max(0, op.cut_end || 0));
            } else c.duration = Math.max(0.3, c.duration - (op.cut_start || 0) - (op.cut_end || 0));
          });
          done.push(`Corte no clipe ${op.clip || "(todos)"}`);
          break;
        case "set_duration":
          pick(op.clip).forEach((c) => { if (c.kind !== "video") c.duration = Math.max(0.3, op.duration); });
          done.push(`Duração ${op.duration}s → clipe ${op.clip || "(todos)"}`);
          break;
        case "set_speed":
          pick(op.clip).forEach((c) => { if (c.kind === "video") c.speed = clamp(op.speed, 0.25, 4); });
          done.push(`Velocidade ${op.speed}x → ${op.clip ? "clipe " + op.clip : "todos os vídeos"}`);
          break;
        case "set_transition":
          pick(op.clip).forEach((c) => (c.transition = op.transition));
          done.push(`Transição ${op.transition} → ${op.clip ? "clipe " + op.clip : "todos"}`);
          break;
        case "set_motion":
          pick(op.clip).forEach((c) => { if (c.kind !== "scene") c.motion = op.motion; });
          done.push(`Movimento ${op.motion}`);
          break;
        case "move_clip": {
          const [c] = pick(op.clip);
          if (c) {
            state.clips.splice(state.clips.indexOf(c), 1);
            state.clips.splice(clamp(op.to - 1, 0, state.clips.length), 0, c);
            done.push(`Clipe ${op.clip} movido para posição ${op.to}`);
          }
          break;
        }
        case "split":
          if (splitAt(op.time)) done.push(`Dividido em ${fmtTime(op.time)}`);
          break;
        case "set_volume":
          pick(op.clip).forEach((c) => (c.volume = clamp(op.volume, 0, 1)));
          done.push(`Volume ${Math.round(op.volume * 100)}%`);
          break;
        case "set_music_volume":
          if (state.audio) { state.audio.volume = clamp(op.volume, 0, 1); done.push(`Música ${Math.round(op.volume * 100)}%`); }
          break;
        case "add_scene": {
          const sc = makeSceneClip({ ...op, style: op.style, anim: op.anim });
          const pos = clamp((op.position || state.clips.length + 1) - 1, 0, state.clips.length);
          // posição relativa ao estado original
          const ref = before[op.position - 1];
          const at = ref && state.clips.includes(ref) ? state.clips.indexOf(ref) : pos;
          state.clips.splice(at, 0, sc);
          done.push(`Cena "${op.title}" adicionada`);
          break;
        }
        case "edit_scene":
          pick(op.clip).forEach((c) => {
            if (c.kind !== "scene") return;
            for (const k of ["title", "subtitle", "emoji", "bg1", "bg2"]) if (op[k]) c.scene[k] = op[k];
          });
          done.push(`Cena ${op.clip} editada`);
          break;
      }
    } catch (e) {
      console.warn("operação inválida", op, e);
    }
  }
  return done;
}

function projectSummary() {
  return {
    formato: state.aspect,
    duracao_total: +totalDuration().toFixed(2),
    cursor: +state.currentTime.toFixed(2),
    clipes: layoutClips().map((it, i) => {
      const c = it.clip;
      const base = { n: i + 1, tipo: c.kind, inicio: +it.start.toFixed(2), duracao: +it.duration.toFixed(2), transicao: c.transition };
      if (c.kind === "scene") Object.assign(base, { titulo: c.scene.title, subtitulo: c.scene.subtitle, emoji: c.scene.emoji, cores: [c.scene.bg1, c.scene.bg2], narracao: c.narration });
      else Object.assign(base, { arquivo: getMedia(c.mediaId)?.name, filtros: c.filters, movimento: c.motion });
      if (c.kind === "video") Object.assign(base, { trecho_original: [+c.in.toFixed(2), +c.out.toFixed(2)], velocidade: c.speed, volume: c.volume });
      return base;
    }),
    textos: state.texts.map((t) => ({ texto: t.text, inicio: t.start, fim: t.end, posicao: t.position })),
    musica: state.audio ? { arquivo: getMedia(state.audio.mediaId)?.name, volume: state.audio.volume } : null,
  };
}

// ---------------------------------------------------------------------------
// Criar com IA
// ---------------------------------------------------------------------------
async function createVideo() {
  const prompt = $("#create-prompt").value.trim();
  if (!prompt) return toast("Descreva o vídeo que você quer criar.");
  const duration = clamp(Number($("#create-duration").value) || 30, 5, 180);
  const style = $("#create-style").value;
  const useMedia = $("#create-use-media").checked;
  const visual = useMedia ? state.media.filter((m) => m.type !== "audio") : [];
  const btn = $("#btn-create");
  const status = $("#create-status");
  btn.disabled = true;
  let sb;
  try {
    if (hasAI()) {
      status.innerHTML = `<span class="spinner"></span>A IA está escrevendo o roteiro…`;
      sb = await generateStoryboard({ prompt, duration, style, aspect: state.aspect, media: visual });
    } else {
      status.textContent = "Sem chave de API: usando o gerador offline. Configure ⚙️ IA para roteiros criados pelo Claude.";
      sb = offlineStoryboard({ prompt, duration, style, media: visual });
    }
  } catch (e) {
    status.textContent = "❌ " + e.message;
    btn.disabled = false;
    return;
  }
  btn.disabled = false;
  if (!sb.scenes.length) {
    status.textContent = "A IA não retornou cenas. Tente detalhar mais o pedido.";
    return;
  }

  mutate(() => {
    if ($("#create-replace").checked) {
      state.clips = [];
      state.texts = [];
    }
    const offset = totalDuration();
    let t = offset;
    sb.scenes.forEach((s, i) => {
      const media = s.mediaIndex >= 0 ? visual[s.mediaIndex] : null;
      const c = makeSceneClip({ ...s, transition: i === 0 ? "fade" : "fade", mediaId: media?.id || null });
      state.clips.push(c);
      if ($("#create-captions").checked && s.narration) {
        // legendas divididas em blocos curtos
        const words = s.narration.split(/\s+/);
        const chunks = [];
        for (let k = 0; k < words.length; k += 7) chunks.push(words.slice(k, k + 7).join(" "));
        const per = s.duration / chunks.length;
        chunks.forEach((txt, k) => state.texts.push(makeText({
          text: txt, start: +(t + k * per).toFixed(2), end: +(t + (k + 1) * per - 0.05).toFixed(2),
          position: "bottom", size: 38, anim: "fade", bold: false,
        })));
      }
      t += s.duration;
    });
    state.selected = null;
  });
  seek(0);

  const box = $("#script-box");
  box.hidden = false;
  box.open = true;
  $("#script-content").innerHTML = "";
  $("#script-content").append(
    el("p", {}, el("strong", {}, sb.title)),
    sb.description ? el("p", { class: "muted" }, sb.description) : null,
    sb.hashtags.length ? el("p", { class: "muted" }, sb.hashtags.map((h) => (h.startsWith("#") ? h : "#" + h)).join(" ")) : null,
    el("ol", {}, sb.scenes.map((s) => el("li", {}, el("strong", {}, `${s.emoji} ${s.title}`), ` (${s.duration.toFixed(1)}s)`, el("br"), el("span", { class: "muted" }, s.narration)))),
  );
  status.textContent = `✅ ${sb.scenes.length} cenas criadas (${fmtTime(totalDuration())})${hasAI() ? "" : " no modo offline — configure ⚙️ IA para roteiros do Claude"}. Dê play para assistir!`;
}

// ---------------------------------------------------------------------------
// Assistente
// ---------------------------------------------------------------------------
const chatHistory = [];
function chatMsg(cls, text, items = []) {
  const m = el("div", { class: `msg ${cls}` }, text, items.length ? el("ul", {}, items.map((i) => el("li", {}, i))) : null);
  $("#chat").append(m);
  $("#chat").scrollTop = 1e9;
  return m;
}

async function sendAssistant(text) {
  text = (text ?? $("#assist-input").value).trim();
  if (!text) return;
  $("#assist-input").value = "";
  chatMsg("user", text);
  const wait = chatMsg("ai", "");
  wait.innerHTML = `<span class="spinner"></span>Pensando…`;
  const btn = $("#btn-assist");
  btn.disabled = true;
  try {
    let res;
    if (hasAI()) {
      const img = $("#assist-frame").checked && (state.clips.length || state.texts.length) ? snapshot() : null;
      res = await assistantCommand({ command: text, project: projectSummary(), imageB64: img, history: chatHistory.slice(-6) });
    } else {
      res = offlineCommand(text);
    }
    wait.remove();
    let done = [];
    if (res.operations?.length) {
      pushUndo();
      done = applyOperations(res.operations);
      changed();
    }
    const m = chatMsg("ai", res.reply || "Pronto!", done);
    if (done.length) m.append(el("div", { class: "row gap", style: "margin-top:6px" }, el("button", { class: "chip", onclick: undo }, "↩ Desfazer")));
    chatHistory.push({ role: "user", text }, { role: "assistant", text: res.reply || "" });
  } catch (e) {
    wait.remove();
    chatMsg("err", "❌ " + e.message);
  } finally {
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Exportar
// ---------------------------------------------------------------------------
async function doExport() {
  if (!state.clips.length && !state.texts.length) return toast("Adicione algo à timeline primeiro.");
  const dlg = $("#export-dlg");
  const prog = $("#export-progress");
  const msg = $("#export-msg");
  prog.value = 0;
  msg.textContent = `Duração: ${fmtTime(totalDuration())}`;
  dlg.showModal();
  try {
    const { blob, ext } = await exportVideo((p) => {
      prog.value = p;
      msg.textContent = `${Math.round(p * 100)}% · ${fmtTime(state.currentTime)} / ${fmtTime(totalDuration())}`;
    });
    const a = el("a", { href: URL.createObjectURL(blob), download: `estudio-ia-${Date.now()}.${ext}` });
    document.body.append(a);
    a.click();
    a.remove();
    dlg.close();
    toast(`Vídeo exportado (${ext.toUpperCase()}, ${(blob.size / 1e6).toFixed(1)} MB)`, 4000);
  } catch (e) {
    dlg.close();
    if (e.message !== "cancelado") toast("Erro ao exportar: " + e.message, 5000);
  }
}

// ---------------------------------------------------------------------------
// Eventos gerais
// ---------------------------------------------------------------------------
document.querySelectorAll(".tabs").forEach((tabs) => {
  tabs.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-tab]");
    if (!b) return;
    tabs.querySelectorAll("button").forEach((x) => x.classList.toggle("active", x === b));
    tabs.parentElement.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.id === b.dataset.tab));
  });
});

const dz = $("#dropzone");
$("#file-input").addEventListener("change", (e) => { importFiles(e.target.files); e.target.value = ""; });
dz.addEventListener("dragover", (e) => { e.preventDefault(); dz.classList.add("over"); });
dz.addEventListener("dragleave", () => dz.classList.remove("over"));
dz.addEventListener("drop", (e) => { e.preventDefault(); dz.classList.remove("over"); importFiles(e.dataTransfer.files); });

$("#btn-add-text").onclick = () => mutate(() => {
  const t = makeText();
  state.texts.push(t);
  state.selected = { type: "text", id: t.id };
});
$("#btn-add-scene").onclick = () => mutate(() => {
  const c = makeSceneClip({ title: "Nova cena", subtitle: "Edite no painel à direita" });
  const hit = clipAt(state.currentTime);
  state.clips.splice(hit ? hit.index + 1 : state.clips.length, 0, c);
  state.selected = { type: "clip", id: c.id };
});

$("#btn-play").onclick = () => (state.playing ? pause() : play());
$("#btn-start").onclick = () => { pause(); seek(0); updatePlayhead(); scroll.scrollLeft = 0; };
$("#btn-split").onclick = () => {
  pushUndo();
  if (splitAt(state.currentTime)) changed();
  else { undoStack.pop(); toast("Posicione o cursor dentro de um clipe para dividir."); }
};
$("#btn-delete").onclick = deleteSelected;
$("#btn-export").onclick = doExport;
$("#btn-export-cancel").onclick = cancelExport;
$("#narrate").onchange = (e) => setNarration(e.target.checked);
$("#zoom").oninput = (e) => { state.zoom = Number(e.target.value); renderTimeline(); };
$("#btn-create").onclick = createVideo;
$("#btn-assist").onclick = () => sendAssistant();
$("#assist-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendAssistant(); }
});
document.querySelectorAll("[data-quick]").forEach((b) => (b.onclick = () => sendAssistant(b.dataset.quick)));

$("#aspect").onchange = (e) => {
  state.aspect = e.target.value;
  [state.width, state.height] = ASPECTS[state.aspect];
  resize();
};

$("#btn-new").onclick = () => {
  if (!confirm("Começar um projeto novo? A timeline atual será apagada (dá para desfazer com Ctrl+Z).")) return;
  mutate(() => { state.clips = []; state.texts = []; state.audio = null; state.selected = null; });
  seek(0);
};

const settings = $("#settings");
$("#btn-settings").onclick = () => {
  $("#api-key").value = getApiKey();
  $("#api-model").value = getModel();
  settings.showModal();
};
settings.addEventListener("close", () => {
  if (settings.returnValue === "save") {
    saveSettings($("#api-key").value, $("#api-model").value);
    updateAIBadge();
    toast(hasAI() ? "IA configurada ✅" : "Chave removida — modo offline");
  }
});
function updateAIBadge() {
  $("#btn-settings").textContent = hasAI() ? "⚙️ IA ✅" : "⚙️ IA (configurar)";
}

window.addEventListener("keydown", (e) => {
  const tag = document.activeElement?.tagName;
  if (["INPUT", "TEXTAREA", "SELECT"].includes(tag) || document.querySelector("dialog[open]")) return;
  const mod = e.ctrlKey || e.metaKey;
  if (e.code === "Space") { e.preventDefault(); state.playing ? pause() : play(); }
  else if (mod && e.key.toLowerCase() === "z" && e.shiftKey) { e.preventDefault(); redo(); }
  else if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); undo(); }
  else if (mod && e.key.toLowerCase() === "y") { e.preventDefault(); redo(); }
  else if (e.key === "s" || e.key === "S") $("#btn-split").click();
  else if (e.key === "Delete" || e.key === "Backspace") deleteSelected();
  else if (e.key === "ArrowLeft") { seek(state.currentTime - (e.shiftKey ? 1 : 1 / 30)); updatePlayhead(); }
  else if (e.key === "ArrowRight") { seek(state.currentTime + (e.shiftKey ? 1 : 1 / 30)); updatePlayhead(); }
});
window.addEventListener("resize", renderTimeline);

// ---------------------------------------------------------------------------
// Início: projeto de boas-vindas
// ---------------------------------------------------------------------------
state.clips = [
  makeSceneClip({ title: "Bem-vindo ao Estúdio IA", subtitle: "Edite vídeos ou crie do zero com inteligência artificial", emoji: "🎬", bg1: "#7c5cff", bg2: "#22d3ee", style: "particulas", anim: "subir", duration: 4 }),
  makeSceneClip({ title: "Arraste seus vídeos", subtitle: "ou use ✨ Criar com IA à esquerda", emoji: "✨", bg1: "#f43f5e", bg2: "#f59e0b", style: "bokeh", anim: "zoom", duration: 4 }),
];
updateAIBadge();
initPlayer($("#preview"), updatePlayhead);
renderMedia();
renderTimeline();
renderProps();
