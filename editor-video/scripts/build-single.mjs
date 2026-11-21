// Gera dist-single/estudio-ia.html: o app inteiro num só arquivo HTML
// (CSS e JS embutidos), para abrir no celular ou publicar como página.
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";

const dist = "dist";
const html = readFileSync(join(dist, "index.html"), "utf8");
const assets = readdirSync(join(dist, "assets"));
const js = assets.filter((f) => f.endsWith(".js"));
const css = assets.filter((f) => f.endsWith(".css"));
if (js.length !== 1) throw new Error(`Esperava 1 arquivo JS, achei ${js.length}: ${js}`);

const code = readFileSync(join(dist, "assets", js[0]), "utf8").replace(/<\/script/gi, "<\\/script").replace(/\uFFFD/g, "\\uFFFD");
const style = css.map((f) => readFileSync(join(dist, "assets", f), "utf8")).join("\n");
const body = html.slice(html.indexOf("<body>") + 6, html.indexOf("</body>"));
const title = html.match(/<title>.*?<\/title>/)[0];

const out = `${title}
<style>
${style}
html, body { height: 100%; }
</style>
${body.replace(/<script type="module"[^>]*><\/script>/, "").trim()}
<script type="module">
${code}
</script>
`;
mkdirSync("dist-single", { recursive: true });
writeFileSync("dist-single/estudio-ia.html", out);
console.log(`dist-single/estudio-ia.html (${(out.length / 1024).toFixed(0)} KB)`);
