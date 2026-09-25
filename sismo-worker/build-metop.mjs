// build-metop.mjs — inietta metop-viewer.html dentro index.js, fra i marcatori
// METOP_HTML. Una sola sorgente (l'HTML), nessuna copia da tenere allineata a
// mano. Lanciare dopo ogni modifica alla pagina:  node build-metop.mjs
import { readFileSync, writeFileSync } from "fs";

const idx = new URL("./index.js", import.meta.url);
let js = readFileSync(idx, "utf8");
const pages = [
  { file:"metop-viewer.html", marker:"METOP_HTML", constant:"METOP_HTML" },
  { file:"modis-viewer.html", marker:"MODIS_HTML", constant:"MODIS_HTML" },
];
for (const page of pages) {
  const html = readFileSync(new URL("./"+page.file, import.meta.url), "utf8");
  if (html.includes("`") || html.includes("${"))
    throw new Error(page.file+" contiene ` o ${ : romperebbero il template literal. Rimuoverli.");
  // Dentro un template literal il backslash e' un carattere di escape: senza
  // raddoppiarlo, le regex della pagina arrivavano rotte al browser (/\bdust\b/
  // diventava /<backspace>dust<backspace>/, [\s-] diventava [s-]). Raddoppiato,
  // la pagina servita e' identica byte per byte al file .html.
  const body = html.replace(/\\/g, "\\\\");
  const re = new RegExp("// >>>"+page.marker+"[\\s\\S]*?// <<<"+page.marker);
  if (!re.test(js)) throw new Error("Marcatori "+page.marker+" non trovati in index.js");
  // Funzione e non stringa come sostituto: in una stringa "$&", "$'" ecc.
  // dentro la pagina verrebbero interpretati da replace() invece di restare testo.
  js = js.replace(re, () =>
    "// >>>"+page.marker+" (generato da build-metop.mjs — NON editare a mano: modifica "+page.file+")\n"
    + "const "+page.constant+" = `" + body + "`;\n"
    + "// <<<"+page.marker);
}

writeFileSync(idx, js);
console.log("Pagine viewer iniettate.");
