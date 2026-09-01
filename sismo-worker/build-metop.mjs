// build-metop.mjs — inietta metop-viewer.html dentro index.js, fra i marcatori
// METOP_HTML. Una sola sorgente (l'HTML), nessuna copia da tenere allineata a
// mano. Lanciare dopo ogni modifica alla pagina:  node build-metop.mjs
import { readFileSync, writeFileSync } from "fs";

const html = readFileSync(new URL("./metop-viewer.html", import.meta.url), "utf8");
if (html.includes("`") || html.includes("${"))
  throw new Error("La pagina contiene ` o ${ : romperebbero il template literal. Rimuoverli.");

const idx = new URL("./index.js", import.meta.url);
let js = readFileSync(idx, "utf8");
const re = /\/\/ >>>METOP_HTML[\s\S]*?\/\/ <<<METOP_HTML/;
if (!re.test(js)) throw new Error("Marcatori METOP_HTML non trovati in index.js");

js = js.replace(re,
  "// >>>METOP_HTML (generato da build-metop.mjs — NON editare a mano: modifica metop-viewer.html)\n"
  + "const METOP_HTML = `" + html + "`;\n"
  + "// <<<METOP_HTML");

writeFileSync(idx, js);
console.log("METOP_HTML iniettato:", html.length, "byte");
