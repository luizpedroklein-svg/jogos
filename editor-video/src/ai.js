// Integração com o Claude (Anthropic) + geradores offline de reserva.
import Anthropic from "@anthropic-ai/sdk";

const KEY_STORAGE = "estudio-ia:key";
const MODEL_STORAGE = "estudio-ia:model";
const DEFAULT_MODEL = "claude-opus-5-5";

const store = {
  get(k) {
    try { return localStorage.getItem(k) || ""; } catch { return ""; }
  },
  set(k, v) {
    try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch { /* sem storage */ }
  },
};

export const getApiKey = () => store.get(KEY_STORAGE);
export const getModel = () => store.get(MODEL_STORAGE) || DEFAULT_MODEL;
export function saveSettings(key, model) {
  store.set(KEY_STORAGE, key.trim());
  store.set(MODEL_STORAGE, model);
}
// Quando a página roda dentro do Claude (artifact), usa a conta do próprio usuário,
// sem precisar de chave. Fora dele, `window.claude` não existe e isso resolve null.
let sampleFn = null;
export async function initAI() {
  try {
    sampleFn = window.claude?.use ? await window.claude.use("sample") : null;
  } catch {
    sampleFn = null;
  }
  return aiMode();
}
/** "claude" (conta do usuário no app Claude), "key" (chave da API) ou "offline". */
export const aiMode = () => (sampleFn ? "claude" : getApiKey() ? "key" : "offline");
export const hasAI = () => aiMode() !== "offline";

const SAMPLE_ERRORS = {
  not_granted: "Você não permitiu que esta página use o Claude. Recarregue a página para permitir.",
  sampling_disabled: "O Claude não está disponível para esta conta.",
  rate_limited: "Muitos pedidos seguidos. Espere um pouco e tente de novo.",
  session_expired: "Sua sessão expirou. Entre de novo no Claude.",
  refused: "O Claude recusou este pedido. Tente reformular.",
  invalid_json: "A resposta veio num formato inesperado. Tente de novo.",
  empty_completion: "O Claude não respondeu nada. Tente pedir de outro jeito.",
  prompt_too_large: "O projeto ficou grande demais para enviar. Tente simplificar.",
  cancelled: "cancelado",
};

async function sampleJSON({ system, text, schema, imageB64 }) {
  const prompt =
    `${system}\n\n${text}\n\n` +
    `Responda SOMENTE com um objeto JSON válido (sem texto antes ou depois) que siga este JSON Schema:\n${JSON.stringify(schema)}`;
  const opts = { modelTier: "default", cache: false };
  if (imageB64) {
    const limits = await sampleFn.limits().catch(() => null);
    if (limits?.images) {
      const bin = atob(imageB64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      opts.images = [new Blob([bytes], { type: "image/jpeg" })];
    }
  }
  try {
    return await sampleFn.json(prompt, opts);
  } catch (e) {
    throw new Error(SAMPLE_ERRORS[e?.code] || "Falha ao falar com o Claude. Tente de novo.");
  }
}

function client() {
  return new Anthropic({ apiKey: getApiKey(), dangerouslyAllowBrowser: true, maxRetries: 2 });
}

function extractJSON(text) {
  try { return JSON.parse(text); } catch { /* tenta extrair */ }
  const a = text.indexOf("{"), b = text.lastIndexOf("}");
  if (a >= 0 && b > a) return JSON.parse(text.slice(a, b + 1));
  throw new Error("A IA não retornou JSON válido.");
}

/**
 * Chamada ao Claude que devolve JSON validado por esquema (structured outputs).
 * Se o esquema for recusado pela API, repete pedindo JSON no prompt.
 */
async function callJSON({ system, text, imageB64 = null, schema, maxTokens = 16000 }) {
  if (sampleFn) return sampleJSON({ system, text, schema, imageB64 });
  const content = imageB64
    ? [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: imageB64 } }, { type: "text", text }]
    : text;
  const api = client();
  const model = getModel();
  const base = {
    model,
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content }],
  };
  // Haiku não tem fallback no servidor; Opus/Sonnet usam o fallback padrão em caso de recusa.
  const send = (params) =>
    model.startsWith("claude-haiku")
      ? api.messages.create(params)
      : api.beta.messages.create({ ...params, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" });

  let res;
  try {
    res = await send({ ...base, output_config: { effort: "medium", format: { type: "json_schema", schema } } });
  } catch (err) {
    if (err instanceof Anthropic.BadRequestError && /schema|output_config|format/i.test(err.message)) {
      res = await send({
        ...base,
        output_config: { effort: "medium" },
        system: `${system}\n\nResponda SOMENTE com um objeto JSON válido que siga este JSON Schema:\n${JSON.stringify(schema)}`,
      });
    } else throw friendlyError(err);
  }
  if (res.stop_reason === "refusal") {
    throw new Error("A IA recusou este pedido. Tente reformular.");
  }
  if (res.stop_reason === "max_tokens") {
    throw new Error("A resposta ficou longa demais. Tente um vídeo mais curto.");
  }
  const reply = res.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  return extractJSON(reply);
}

function friendlyError(err) {
  if (err instanceof Anthropic.AuthenticationError) return new Error("Chave da API inválida. Confira em ⚙️ IA.");
  if (err instanceof Anthropic.PermissionDeniedError) return new Error("Sua chave não tem permissão para este modelo.");
  if (err instanceof Anthropic.RateLimitError) return new Error("Limite de uso atingido. Aguarde um pouco e tente de novo.");
  if (err instanceof Anthropic.APIConnectionError) return new Error("Falha de conexão com a API da Anthropic.");
  if (err instanceof Anthropic.APIError) return new Error(`Erro da API (${err.status}): ${err.message}`);
  return err;
}

// ---------------------------------------------------------------------------
// 1) Criador: prompt -> roteiro com cenas
// ---------------------------------------------------------------------------
const SCENE_STYLES = ["gradiente", "particulas", "bokeh", "ondas", "listras", "neon", "solido"];
const SCENE_ANIMS = ["subir", "fade", "zoom", "digitar", "deslizar"];

const storyboardSchema = {
  type: "object",
  additionalProperties: false,
  required: ["title", "description", "hashtags", "scenes"],
  properties: {
    title: { type: "string", description: "Título do vídeo" },
    description: { type: "string", description: "Descrição curta para publicar" },
    hashtags: { type: "array", items: { type: "string" } },
    scenes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["duration", "title", "subtitle", "emoji", "narration", "bg1", "bg2", "text_color", "style", "anim", "media_index"],
        properties: {
          duration: { type: "number", description: "Segundos (2 a 10)" },
          title: { type: "string", description: "Texto grande na tela, curto (até ~6 palavras)" },
          subtitle: { type: "string", description: "Linha de apoio curta, ou vazio" },
          emoji: { type: "string", description: "Um emoji ou vazio" },
          narration: { type: "string", description: "Fala do narrador para esta cena" },
          bg1: { type: "string", description: "Cor hex #rrggbb" },
          bg2: { type: "string", description: "Cor hex #rrggbb" },
          text_color: { type: "string", description: "Cor hex do texto, com bom contraste" },
          style: { type: "string", enum: SCENE_STYLES },
          anim: { type: "string", enum: SCENE_ANIMS },
          media_index: { type: "integer", description: "Índice (0..n-1) da mídia do usuário a usar como fundo, ou -1 para nenhuma" },
        },
      },
    },
  },
};

export async function generateStoryboard({ prompt, duration, style, aspect, media }) {
  const mediaList = media.length
    ? media.map((m, i) => `${i}: ${m.type} "${m.name}"`).join("\n")
    : "(nenhuma — use media_index = -1)";
  const system =
    "Você é um diretor criativo e roteirista de vídeos curtos para redes sociais. " +
    "Cria roteiros em português do Brasil, com ganchos fortes no início, ritmo dinâmico e um final com chamada para ação. " +
    "Cada cena mostra pouco texto na tela (o detalhe vai na narração). Escolha paletas harmoniosas e com bom contraste.";
  const user =
    `Crie o roteiro de um vídeo.\n\nPedido: ${prompt}\n` +
    `Duração total desejada: ~${duration} segundos (a soma das durações das cenas deve ficar próxima disso; ` +
    `a narração de cada cena deve caber na duração dela, ~2,5 palavras por segundo).\n` +
    `Estilo visual: ${style}\nFormato: ${aspect}\n` +
    `Mídias do usuário disponíveis para fundos:\n${mediaList}`;
  const data = await callJSON({ system, text: user, schema: storyboardSchema });
  return normalizeStoryboard(data);
}

function normalizeStoryboard(d) {
  const hex = (c, fb) => (/^#[0-9a-f]{6}$/i.test(c || "") ? c : fb);
  return {
    title: d.title || "Meu vídeo",
    description: d.description || "",
    hashtags: Array.isArray(d.hashtags) ? d.hashtags : [],
    scenes: (d.scenes || []).map((s) => ({
      duration: Math.min(12, Math.max(1.5, Number(s.duration) || 4)),
      title: s.title || "",
      subtitle: s.subtitle || "",
      emoji: s.emoji || "",
      narration: s.narration || "",
      bg1: hex(s.bg1, "#7c5cff"),
      bg2: hex(s.bg2, "#22d3ee"),
      textColor: hex(s.text_color ?? s.textColor, "#ffffff"),
      style: SCENE_STYLES.includes(s.style) ? s.style : "gradiente",
      anim: SCENE_ANIMS.includes(s.anim) ? s.anim : "subir",
      mediaIndex: Number.isInteger(s.media_index) ? s.media_index : s.mediaIndex ?? -1,
    })),
  };
}

const PALETTES = {
  moderno: [["#7c5cff", "#22d3ee"], ["#f43f5e", "#f59e0b"], ["#0ea5e9", "#6366f1"], ["#10b981", "#3b82f6"]],
  minimalista: [["#111827", "#374151"], ["#f3f4f6", "#d1d5db"], ["#1f2937", "#111827"]],
  neon: [["#0f0c29", "#302b63"], ["#12002e", "#ff00e5"], ["#000814", "#00f5d4"]],
  natureza: [["#14532d", "#65a30d"], ["#0f766e", "#84cc16"], ["#78350f", "#d97706"]],
  corporativo: [["#0b3d91", "#1e88e5"], ["#1e293b", "#0ea5e9"], ["#0f172a", "#334155"]],
  divertido: [["#ff6b6b", "#feca57"], ["#48dbfb", "#ff9ff3"], ["#1dd1a1", "#feca57"]],
};
const STYLE_FX = { moderno: "particulas", minimalista: "solido", neon: "neon", natureza: "ondas", corporativo: "listras", divertido: "bokeh" };

/** Gerador simples sem IA: divide o texto em frases e cria cenas. */
export function offlineStoryboard({ prompt, duration, style, media }) {
  let parts = prompt.split(/(?<=[.!?;])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
  if (parts.length < 3) parts = [prompt.trim() || "Meu vídeo", "Vamos começar", "Obrigado por assistir!"];
  parts = parts.slice(0, 10);
  const pal = PALETTES[style] || PALETTES.moderno;
  const per = Math.max(2, duration / parts.length);
  const anims = ["subir", "zoom", "fade", "deslizar", "digitar"];
  const light = style === "minimalista";
  return {
    title: parts[0].slice(0, 60),
    description: prompt,
    hashtags: [],
    scenes: parts.map((p, i) => {
      const [a, b] = pal[i % pal.length];
      const words = p.split(/\s+/);
      return {
        duration: per,
        title: words.slice(0, 6).join(" ") + (words.length > 6 ? "…" : ""),
        subtitle: words.length > 6 ? words.slice(6, 16).join(" ") : "",
        emoji: "",
        narration: p,
        bg1: a,
        bg2: b,
        textColor: light && i % pal.length === 1 ? "#111827" : "#ffffff",
        style: STYLE_FX[style] || "gradiente",
        anim: anims[i % anims.length],
        mediaIndex: media.length ? i % media.length : -1,
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// 2) Assistente de edição: comando em linguagem natural -> operações
// ---------------------------------------------------------------------------
const FILTER_PRESETS = ["nenhum", "preto_e_branco", "sepia", "vivido", "cinema", "frio", "quente", "desbotado", "vintage", "desfoque"];
const POSITIONS = ["top", "center", "bottom"];
const TEXT_ANIMS = ["none", "fade", "slide", "pop", "typewriter"];

const obj = (props) => ({
  type: "object",
  additionalProperties: false,
  required: Object.keys(props),
  properties: props,
});
const CLIP = { type: "integer", description: "Número do clipe (1 = primeiro). 0 = todos os clipes" };

const opsSchema = obj({
  reply: { type: "string", description: "Resposta curta ao usuário explicando o que foi feito (ou a resposta pedida)" },
  operations: {
    type: "array",
    items: {
      anyOf: [
        obj({ op: { type: "string", enum: ["set_filter"] }, clip: CLIP, preset: { type: "string", enum: FILTER_PRESETS } }),
        obj({
          op: { type: "string", enum: ["adjust"] }, clip: CLIP,
          property: { type: "string", enum: ["brightness", "contrast", "saturate", "grayscale", "sepia", "blur", "hue"] },
          value: { type: "number", description: "brightness/contrast/saturate em % (100 = normal); grayscale/sepia 0-100; blur em px; hue em graus" },
        }),
        obj({
          op: { type: "string", enum: ["add_text"] }, text: { type: "string" },
          start: { type: "number" }, end: { type: "number" },
          position: { type: "string", enum: POSITIONS },
          color: { type: "string", description: "hex #rrggbb" },
          size: { type: "number", description: "Tamanho relativo (padrão 56; título grande ~80; legenda ~44)" },
          anim: { type: "string", enum: TEXT_ANIMS },
          background: { type: "boolean", description: "Caixa escura atrás do texto" },
        }),
        obj({ op: { type: "string", enum: ["remove_texts"] } }),
        obj({ op: { type: "string", enum: ["delete_clip"] }, clip: CLIP }),
        obj({
          op: { type: "string", enum: ["trim_clip"] }, clip: CLIP,
          cut_start: { type: "number", description: "Segundos a cortar do início" },
          cut_end: { type: "number", description: "Segundos a cortar do fim" },
        }),
        obj({ op: { type: "string", enum: ["set_duration"] }, clip: CLIP, duration: { type: "number", description: "Segundos (só para imagens e cenas)" } }),
        obj({ op: { type: "string", enum: ["set_speed"] }, clip: CLIP, speed: { type: "number", description: "0.25 a 4" } }),
        obj({ op: { type: "string", enum: ["set_transition"] }, clip: CLIP, transition: { type: "string", enum: ["none", "fade"] } }),
        obj({ op: { type: "string", enum: ["set_motion"] }, clip: CLIP, motion: { type: "string", enum: ["none", "zoom-in", "zoom-out", "pan-left", "pan-right"] } }),
        obj({ op: { type: "string", enum: ["move_clip"] }, clip: CLIP, to: { type: "integer", description: "Nova posição (1 = primeiro)" } }),
        obj({ op: { type: "string", enum: ["split"] }, time: { type: "number", description: "Tempo na timeline em segundos" } }),
        obj({ op: { type: "string", enum: ["set_volume"] }, clip: CLIP, volume: { type: "number", description: "0 a 1" } }),
        obj({ op: { type: "string", enum: ["set_music_volume"] }, volume: { type: "number", description: "0 a 1" } }),
        obj({
          op: { type: "string", enum: ["add_scene"] },
          position: { type: "integer", description: "Inserir antes deste clipe (1 = início). Use um número maior que o total para colocar no fim" },
          duration: { type: "number" }, title: { type: "string" }, subtitle: { type: "string" }, emoji: { type: "string" },
          bg1: { type: "string" }, bg2: { type: "string" },
          style: { type: "string", enum: SCENE_STYLES }, anim: { type: "string", enum: SCENE_ANIMS },
        }),
        obj({
          op: { type: "string", enum: ["edit_scene"] }, clip: CLIP,
          title: { type: "string" }, subtitle: { type: "string" }, emoji: { type: "string" },
          bg1: { type: "string" }, bg2: { type: "string" },
        }),
      ],
    },
  },
});

export async function assistantCommand({ command, project, imageB64, history }) {
  const system =
    "Você é o assistente de edição de um editor de vídeo no navegador. " +
    "Recebe o estado do projeto em JSON e um pedido do usuário em português. " +
    "Traduza o pedido em operações de edição (o campo 'operations'), na ordem em que devem ser aplicadas, " +
    "e escreva em 'reply' uma resposta curta e amigável em português. " +
    "Números de clipe começam em 1 e se referem ao estado ANTES das operações; se for apagar ou mover vários, " +
    "pense no efeito da ordem. Use clip = 0 para aplicar a todos. " +
    "Se o usuário pedir só texto (ideias, legenda para redes, opinião), responda em 'reply' e deixe 'operations' vazio. " +
    "Se uma imagem do quadro atual for enviada, use-a para entender o conteúdo visual.";
  const ctx = history.length
    ? `Conversa recente:\n${history.map((h) => `${h.role === "user" ? "Usuário" : "Assistente"}: ${h.text}`).join("\n")}\n\n`
    : "";
  const text = `${ctx}Estado do projeto:\n${JSON.stringify(project, null, 1)}\n\nPedido: ${command}`;
  return callJSON({ system, text, imageB64, schema: opsSchema, maxTokens: 8000 });
}

/** Interpretação simples de comandos quando não há chave de API. */
export function offlineCommand(command) {
  const c = command.toLowerCase();
  const ops = [];
  const num = c.match(/(\d+)[ºo°]?\s*clipe|clipe\s*(\d+)/);
  const clip = num ? Number(num[1] || num[2]) : 0;
  if (/preto e branco|p&b|pb\b/.test(c)) ops.push({ op: "set_filter", clip, preset: "preto_e_branco" });
  if (/s[ée]pia/.test(c)) ops.push({ op: "set_filter", clip, preset: "sepia" });
  if (/cinema|cinematogr/.test(c)) ops.push({ op: "set_filter", clip, preset: "cinema" });
  if (/vintage|retr[ôo]/.test(c)) ops.push({ op: "set_filter", clip, preset: "vintage" });
  if (/vivo|vibrante|satur/.test(c)) ops.push({ op: "set_filter", clip, preset: "vivido" });
  if (/remove.*filtro|sem filtro/.test(c)) ops.push({ op: "set_filter", clip, preset: "nenhum" });
  const sp = c.match(/(\d+(?:[.,]\d+)?)\s*x/);
  if (/aceler|r[áa]pido/.test(c)) ops.push({ op: "set_speed", clip, speed: sp ? parseFloat(sp[1].replace(",", ".")) : 1.5 });
  if (/c[âa]mera lenta|devagar|lento/.test(c)) ops.push({ op: "set_speed", clip, speed: sp ? parseFloat(sp[1].replace(",", ".")) : 0.5 });
  if (/transi/.test(c)) ops.push({ op: "set_transition", clip, transition: "fade" });
  const q = command.match(/["“'']([^"”'']+)["”'']/);
  if (q && /t[íi]tulo|texto|legenda|escrev/.test(c)) {
    ops.push({ op: "add_text", text: q[1], start: 0, end: 3, position: /legenda/.test(c) ? "bottom" : "center", color: "#ffffff", size: /t[íi]tulo/.test(c) ? 80 : 52, anim: "pop", background: /legenda/.test(c) });
  }
  return {
    reply: ops.length
      ? "Apliquei usando o modo offline (sem IA). Configure uma chave em ⚙️ IA para pedidos mais complexos."
      : "Sem chave de API eu só entendo comandos simples (preto e branco, sépia, cinema, acelerar, câmera lenta, transição, título \"...\"). Configure a IA em ⚙️ IA.",
    operations: ops,
  };
}
