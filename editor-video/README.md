# 🎬 Estúdio IA — editor e criador de vídeos com IA

Editor de vídeo que roda no navegador, com um criador de vídeos por inteligência artificial (Claude, da Anthropic).

## Como rodar

```bash
cd editor-video
npm install
npm run dev      # abre em http://localhost:5173
npm run build    # gera a versão estática em dist/
```

Use Chrome ou Edge (recomendados), ou Firefox.

Para gerar o app inteiro num único arquivo HTML (bom para abrir no celular ou publicar como página no Claude):

```bash
npm run build:single   # gera dist-single/estudio-ia.html
```

Quando essa página roda dentro do Claude (como artifact), a IA usa a conta Claude de quem está usando,
sem precisar de chave, e o vídeo exportado é salvo pelo próprio app do Claude.

## O que dá para fazer

**Editor**
- Importar vídeos, imagens e músicas (arrastar e soltar)
- Timeline com trilhas de vídeo, texto e áudio; zoom
- Cortar arrastando as bordas dos clipes, dividir (S), reordenar arrastando, duplicar, excluir
- Velocidade (0,25x a 4x), volume, enquadramento (preencher / caber com fundo desfocado)
- Movimento Ken Burns (zoom, panorâmica) em fotos e vídeos
- Filtros: brilho, contraste, saturação, P&B, sépia, matiz, desfoque e predefinições (cinema, vintage, vívido…)
- Transição fade, textos animados (aparecer, subir, pop, máquina de escrever)
- Formatos 16:9, 9:16 (Reels/TikTok) e 1:1
- Desfazer/refazer (Ctrl+Z / Ctrl+Shift+Z)
- Exportar em MP4 ou WebM, com áudio (a gravação acontece em tempo real)

**IA**
- **✨ Criar com IA**: descreva o vídeo e o Claude escreve o roteiro e monta as cenas animadas,
  com cores, emojis, narração e legendas. Pode usar suas mídias como fundo das cenas.
  Também sugere título, descrição e hashtags.
- **🤖 Assistente**: peça edições em linguagem natural ("deixa o segundo clipe em preto e branco",
  "coloca um título nos 3 primeiros segundos", "acelera tudo 1.5x"). O assistente vê o quadro atual
  e aplica as mudanças na timeline (com botão de desfazer).
- Narração por voz no preview (voz do navegador).

## Configurar a IA

Clique em **⚙️ IA** e cole sua chave da API da Anthropic (https://console.anthropic.com).
O modelo padrão é o Claude Opus 5.5; também dá para escolher Sonnet 5.5 ou Haiku 5.5.

A chave fica salva só no `localStorage` do seu navegador e é enviada direto para a API da Anthropic.
Como ela fica exposta no navegador, use este modo apenas no seu computador. Para publicar o app
para outras pessoas, coloque as chamadas da IA atrás de um servidor seu.

Sem chave, o app continua funcionando: o criador usa um gerador simples offline e o assistente
entende comandos básicos.

## Estrutura

| Arquivo | Função |
|---|---|
| `src/state.js` | Estado do projeto (clipes, textos, música) |
| `src/renderer.js` | Desenha cada quadro no canvas (mídia, filtros, cenas animadas, textos) |
| `src/player.js` | Reprodução sincronizada e exportação (MediaRecorder) |
| `src/ai.js` | Chamadas ao Claude com saída estruturada (JSON Schema) e geradores offline |
| `src/main.js` | Interface: mídia, timeline, propriedades, criador e assistente |
