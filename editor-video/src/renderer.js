// Desenha um quadro da composição no canvas para um instante de tempo.
import { state, layoutClips, getMedia, clamp } from "./state.js";

const ease = (t) => 1 - Math.pow(1 - clamp(t, 0, 1), 3);

export function filterString(f) {
  if (!f) return "none";
  const parts = [];
  if (f.brightness !== 100) parts.push(`brightness(${f.brightness}%)`);
  if (f.contrast !== 100) parts.push(`contrast(${f.contrast}%)`);
  if (f.saturate !== 100) parts.push(`saturate(${f.saturate}%)`);
  if (f.grayscale) parts.push(`grayscale(${f.grayscale}%)`);
  if (f.sepia) parts.push(`sepia(${f.sepia}%)`);
  if (f.hue) parts.push(`hue-rotate(${f.hue}deg)`);
  if (f.blur) parts.push(`blur(${f.blur}px)`);
  return parts.length ? parts.join(" ") : "none";
}

function drawCover(ctx, src, sw, sh, W, H, fit, scale = 1, panX = 0, panY = 0) {
  if (!sw || !sh) return;
  const r = fit === "contain" ? Math.min(W / sw, H / sh) : Math.max(W / sw, H / sh);
  const dw = sw * r * scale;
  const dh = sh * r * scale;
  const dx = (W - dw) / 2 + panX * (dw - W) / 2;
  const dy = (H - dh) / 2 + panY * (dh - H) / 2;
  ctx.drawImage(src, dx, dy, dw, dh);
}

function motionParams(motion, p) {
  switch (motion) {
    case "zoom-in": return { s: 1 + 0.15 * p, x: 0, y: 0 };
    case "zoom-out": return { s: 1.15 - 0.15 * p, x: 0, y: 0 };
    case "pan-left": return { s: 1.15, x: 1 - 2 * p, y: 0 };
    case "pan-right": return { s: 1.15, x: -1 + 2 * p, y: 0 };
    default: return { s: 1, x: 0, y: 0 };
  }
}

function wrapLines(ctx, text, maxW) {
  const out = [];
  for (const para of String(text).split("\n")) {
    const words = para.split(/\s+/).filter(Boolean);
    let line = "";
    for (const w of words) {
      const test = line ? line + " " + w : w;
      if (ctx.measureText(test).width > maxW && line) {
        out.push(line);
        line = w;
      } else line = test;
    }
    out.push(line);
  }
  return out;
}

// --- Cenas procedurais (geradas pela IA) ---
function seeded(i) {
  const x = Math.sin(i * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

function drawSceneBackground(ctx, sc, t, W, H) {
  const { bg1, bg2, style } = sc;
  if (sc.mediaId) {
    const m = getMedia(sc.mediaId);
    if (m && m.el) {
      const sw = m.type === "video" ? m.el.videoWidth : m.el.naturalWidth;
      const sh = m.type === "video" ? m.el.videoHeight : m.el.naturalHeight;
      drawCover(ctx, m.el, sw, sh, W, H, "cover", 1 + 0.04 * t, 0, 0);
      ctx.fillStyle = "rgba(0,0,0,0.35)";
      ctx.fillRect(0, 0, W, H);
      return;
    }
  }
  if (style === "solido") {
    ctx.fillStyle = bg1;
    ctx.fillRect(0, 0, W, H);
    return;
  }
  const a = t * 0.4;
  const cx = W / 2, cy = H / 2, R = Math.hypot(W, H) / 2;
  const g = ctx.createLinearGradient(cx - Math.cos(a) * R, cy - Math.sin(a) * R, cx + Math.cos(a) * R, cy + Math.sin(a) * R);
  g.addColorStop(0, bg1);
  g.addColorStop(1, bg2);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  const minD = Math.min(W, H);
  ctx.save();
  if (style === "particulas") {
    ctx.fillStyle = "rgba(255,255,255,0.7)";
    for (let i = 0; i < 70; i++) {
      const x = (seeded(i) * W + t * 20 * (0.5 + seeded(i + 9))) % W;
      const y = (seeded(i + 3) * H - t * 30 * (0.3 + seeded(i + 5)) + H * 10) % H;
      const r = 1 + seeded(i + 7) * 3;
      ctx.globalAlpha = 0.3 + 0.5 * Math.abs(Math.sin(t * 2 + i));
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    }
  } else if (style === "bokeh") {
    for (let i = 0; i < 18; i++) {
      const x = seeded(i) * W + Math.sin(t * 0.5 + i) * 30;
      const y = seeded(i + 1) * H + Math.cos(t * 0.4 + i) * 30;
      const r = minD * (0.04 + seeded(i + 2) * 0.12);
      const rg = ctx.createRadialGradient(x, y, 0, x, y, r);
      rg.addColorStop(0, "rgba(255,255,255,0.35)");
      rg.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = rg;
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    }
  } else if (style === "ondas") {
    for (let k = 0; k < 4; k++) {
      ctx.globalAlpha = 0.12 + k * 0.05;
      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      const base = H * (0.6 + k * 0.1);
      ctx.moveTo(0, H);
      for (let x = 0; x <= W; x += 20) {
        ctx.lineTo(x, base + Math.sin(x / (120 + k * 40) + t * (1 + k * 0.3)) * (20 + k * 8));
      }
      ctx.lineTo(W, H); ctx.closePath(); ctx.fill();
    }
  } else if (style === "listras") {
    ctx.globalAlpha = 0.1;
    ctx.fillStyle = "#fff";
    ctx.translate(W / 2, H / 2);
    ctx.rotate(-0.5);
    const off = (t * 60) % 80;
    for (let x = -R * 1.5; x < R * 1.5; x += 80) ctx.fillRect(x + off, -R * 1.5, 30, R * 3);
  } else if (style === "neon") {
    ctx.globalAlpha = 0.6;
    ctx.strokeStyle = bg2;
    ctx.lineWidth = 3;
    ctx.shadowColor = bg2; ctx.shadowBlur = 25;
    for (let i = 0; i < 3; i++) {
      const r = minD * (0.25 + i * 0.12) + Math.sin(t * 2 + i) * 10;
      ctx.beginPath(); ctx.arc(W / 2, H / 2, r, t * (0.5 + i * 0.2), t * (0.5 + i * 0.2) + Math.PI * 1.3); ctx.stroke();
    }
  }
  ctx.restore();
  // vinheta
  const vg = ctx.createRadialGradient(W / 2, H / 2, minD * 0.3, W / 2, H / 2, R);
  vg.addColorStop(0, "rgba(0,0,0,0)");
  vg.addColorStop(1, "rgba(0,0,0,0.35)");
  ctx.fillStyle = vg;
  ctx.fillRect(0, 0, W, H);
}

function drawSceneText(ctx, sc, t, dur, W, H) {
  const minD = Math.min(W, H);
  const p = ease(t / 0.8);
  const out = dur - t < 0.4 ? clamp((dur - t) / 0.4, 0, 1) : 1;
  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = sc.textColor || "#fff";
  ctx.shadowColor = "rgba(0,0,0,0.45)";
  ctx.shadowBlur = 18;
  ctx.globalAlpha = (sc.anim === "nenhuma" ? 1 : p) * out;

  let dy = 0, scale = 1;
  if (sc.anim === "subir") dy = (1 - p) * minD * 0.08;
  if (sc.anim === "zoom") scale = 0.6 + 0.4 * p;
  let dx = 0;
  if (sc.anim === "deslizar") dx = (1 - p) * -W * 0.3;

  const hasEmoji = !!sc.emoji;
  let y = H / 2 - (sc.subtitle ? minD * 0.05 : 0) + (hasEmoji ? minD * 0.08 : 0);
  ctx.translate(W / 2 + dx, y + dy);
  ctx.scale(scale, scale);

  if (hasEmoji) {
    const bounce = Math.sin(t * 3) * minD * 0.01;
    ctx.font = `${Math.round(minD * 0.16)}px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif`;
    ctx.fillText(sc.emoji, 0, -minD * 0.2 + bounce);
  }

  let title = sc.title || "";
  if (sc.anim === "digitar") title = title.slice(0, Math.floor(title.length * clamp(t / Math.min(1.5, dur * 0.6), 0, 1)));
  const tSize = Math.round(minD * 0.085);
  ctx.font = `800 ${tSize}px system-ui, "Segoe UI", Roboto, sans-serif`;
  const lines = wrapLines(ctx, title, W * 0.84);
  const lh = tSize * 1.15;
  const startY = -((lines.length - 1) * lh) / 2;
  lines.forEach((l, i) => ctx.fillText(l, 0, startY + i * lh));

  if (sc.subtitle) {
    const sSize = Math.round(minD * 0.042);
    ctx.font = `500 ${sSize}px system-ui, "Segoe UI", Roboto, sans-serif`;
    ctx.globalAlpha *= clamp((t - 0.3) / 0.6, 0, 1);
    const sl = wrapLines(ctx, sc.subtitle, W * 0.8);
    const baseY = startY + (lines.length - 1) * lh + tSize * 0.6 + sSize * 0.9;
    sl.forEach((l, i) => ctx.fillText(l, 0, baseY + i * sSize * 1.3));
  }
  ctx.restore();
}

// --- Textos sobrepostos ---
function drawTextOverlay(ctx, tx, time, W, H) {
  const local = time - tx.start;
  const dur = tx.end - tx.start;
  const minD = Math.min(W, H);
  const size = Math.round((tx.size / 720) * minD);
  ctx.save();
  ctx.font = `${tx.bold ? 800 : 500} ${size}px system-ui, "Segoe UI", Roboto, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  let text = tx.text;
  let alpha = 1, dy = 0, scale = 1;
  const pin = ease(local / 0.4);
  const pout = clamp((dur - local) / 0.3, 0, 1);
  switch (tx.anim) {
    case "fade": alpha = Math.min(pin, pout); break;
    case "slide": alpha = Math.min(pin, pout); dy = (1 - pin) * size; break;
    case "pop": scale = 0.5 + 0.5 * ease(local / 0.25) + Math.sin(clamp(local / 0.35, 0, 1) * Math.PI) * 0.08; alpha = pout; break;
    case "typewriter": text = text.slice(0, Math.ceil(text.length * clamp(local / Math.min(1.5, dur * 0.6), 0, 1))); alpha = pout; break;
  }
  const lines = wrapLines(ctx, text, W * 0.86);
  const lh = size * 1.2;
  const blockH = lines.length * lh;
  let cy;
  if (tx.position === "top") cy = H * 0.1 + blockH / 2;
  else if (tx.position === "center") cy = H / 2;
  else cy = H * 0.88 - blockH / 2;

  ctx.globalAlpha = alpha;
  ctx.translate(W / 2, cy + dy);
  ctx.scale(scale, scale);
  const fullLines = wrapLines(ctx, tx.text, W * 0.86); // fundo estável no modo máquina de escrever
  if (tx.bg && tx.bg !== "transparent") {
    const maxW = Math.max(...fullLines.map((l) => ctx.measureText(l).width));
    const padX = size * 0.4, padY = size * 0.2;
    const fh = fullLines.length * lh;
    ctx.fillStyle = tx.bg;
    roundRect(ctx, -maxW / 2 - padX, -fh / 2 - padY, maxW + padX * 2, fh + padY * 2, size * 0.25);
    ctx.fill();
  } else {
    ctx.shadowColor = "rgba(0,0,0,0.8)";
    ctx.shadowBlur = size * 0.2;
  }
  ctx.fillStyle = tx.color;
  const sy = -((fullLines.length - 1) * lh) / 2;
  lines.forEach((l, i) => ctx.fillText(l, 0, sy + i * lh));
  ctx.restore();
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Desenha o quadro do tempo `time`. */
export function renderFrame(ctx, time) {
  const W = state.width, H = state.height;
  ctx.save();
  ctx.filter = "none";
  ctx.globalAlpha = 1;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, W, H);

  const items = layoutClips();
  const idx = items.findIndex((it) => time >= it.start && time < it.end);
  if (idx >= 0) {
    const it = items[idx];
    const c = it.clip;
    const local = time - it.start;
    const p = it.duration > 0 ? local / it.duration : 0;

    // transições: fade a partir do preto
    const fd = Math.min(0.5, it.duration / 3);
    let alpha = 1;
    if (c.transition === "fade" && local < fd) alpha = local / fd;
    const next = items[idx + 1];
    if (next && next.clip.transition === "fade" && it.end - time < fd) alpha = Math.min(alpha, (it.end - time) / fd);

    ctx.globalAlpha = clamp(alpha, 0, 1);
    ctx.filter = filterString(c.filters);

    if (c.kind === "scene") {
      drawSceneBackground(ctx, c.scene, local, W, H);
      ctx.filter = "none";
      drawSceneText(ctx, c.scene, local, it.duration, W, H);
    } else {
      const m = getMedia(c.mediaId);
      if (m && m.el) {
        const mp = motionParams(c.motion, p);
        const sw = m.type === "video" ? m.el.videoWidth : m.el.naturalWidth;
        const sh = m.type === "video" ? m.el.videoHeight : m.el.naturalHeight;
        if (c.fit === "contain") {
          // fundo desfocado para preencher as bordas
          ctx.save();
          ctx.filter = filterString(c.filters) + " blur(24px) brightness(60%)";
          drawCover(ctx, m.el, sw, sh, W, H, "cover", 1.1);
          ctx.restore();
          ctx.globalAlpha = clamp(alpha, 0, 1);
          ctx.filter = filterString(c.filters);
        }
        drawCover(ctx, m.el, sw, sh, W, H, c.fit, mp.s, mp.x, mp.y);
      }
    }
  }
  ctx.restore();

  for (const tx of state.texts) {
    if (time >= tx.start && time < tx.end) drawTextOverlay(ctx, tx, time, W, H);
  }
}
