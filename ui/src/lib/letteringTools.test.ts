// Lettering tools (npm run test:match): batch lettering texts and file names
// (Ink/Stitch's batch_lettering.py), the ZIP they are packed in, font sample
// sheets and the font editor's live metrics.

import { batchFileName, batchTexts, fontJsonText, fontSampleText, kerningRows, sampleGlyphNames, withFontInfo } from "./letteringTools";
import { crc32, makeZip, readZip } from "./zip";
import type { EmbroideryFont, EmbroideryGlyph } from "./fonts";

let failed = 0;
const check = (ok: boolean, msg: string) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${msg}`);
  if (!ok) failed++;
};
const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;

// --- batch texts ---------------------------------------------------------------
let t = batchTexts("Anna\nBen\n\nCleo\n");
check(t.map((x) => x.text).join(",") === "Anna,Ben,Cleo", "one text per line, empty lines skipped");
check(t.map((x) => x.index).join(",") === "0,1,3", "skipped texts keep their numbers");
t = batchTexts("Anna;Ben Smith\\nTeam A;Cleo", ";");
check(t.length === 3 && t[1].text === "Ben Smith\nTeam A", "custom separator; \\n is a line break");
t = batchTexts("a\r\nb");
check(t.map((x) => x.text).join("|") === "a|b", "Windows line ends");
check(batchFileName(0, "Anna", "pes") === "000-Anna.pes", "file name: number and text");
check(batchFileName(12, "Benjamin Kleinert", "dst") === "012-Benjami.dst", `file name: 8 characters with the dash, like Ink/Stitch (${batchFileName(12, "Benjamin Kleinert", "dst")})`);
check(batchFileName(3, "Ünïcødé!", "jef") === "003-ncd.jef", "file name: ASCII letters and digits only");
check(batchFileName(4, "★★", "svg") === "004.svg", "file name: just the number without letters");

// --- zip ---------------------------------------------------------------------------
const enc = new TextEncoder();
check(crc32(enc.encode("hello")) === 0x3610a686, "CRC-32");
const zip = makeZip([
  { name: "000-Anna.pes", bytes: enc.encode("pes data") },
  { name: "000-Anna.pes", bytes: enc.encode("again") },
  { name: "Ünï.dst", bytes: new Uint8Array([0, 1, 2, 255]) },
]);
check(zip[0] === 0x50 && zip[1] === 0x4b && zip[2] === 3 && zip[3] === 4, "zip: local file header first");
const back = readZip(zip);
check(back.length === 3 && back[0].name === "000-Anna.pes" && back[1].name === "000-Anna (2).pes" && back[2].name === "Ünï.dst", "zip: names (UTF-8, duplicates numbered)");
check(new TextDecoder().decode(back[0].bytes) === "pes data" && back[2].bytes[3] === 255, "zip: contents round-trip");

// --- font sample and font info -----------------------------------------------------
const glyphW: Record<string, number> = { A: 10, B: 10, C: 10, D: 10, "ل.init": 5, ل: 5 };
const font = {
  kind: "embroidery",
  key: "emb:t",
  name: "T",
  size: 10,
  minScale: 1,
  maxScale: 1,
  leading: 20,
  space: 5,
  advDefault: null,
  adv: {},
  kerning: { "A B": 2 },
  letterCase: "",
  defaultGlyph: "�",
  direction: "ltr",
  colors: [],
  names: new Set(Object.keys(glyphW)),
  variant: "ltr",
  variants: ["ltr"],
  reversible: true,
  namesOf: () => new Set(Object.keys(glyphW)),
  glyph: async (name: string): Promise<EmbroideryGlyph> => ({ name, objects: [{} as never], colors: [0], width: glyphW[name], minX: 0 }),
} as EmbroideryFont;
check(sampleGlyphNames(["b", "A", "ل.init", "a", "1", " "]).join("") === "1Aab", "sample glyphs: code-point order, no positional forms or spaces");
(async () => {
  // 10 mm glyphs, kerning A→B −2 mm: A B fit in 20 mm, C breaks the line
  const s = await fontSampleText(font, 10, 20);
  check(s === "AB\nCD\nل", `sample sheet: lines broken at the width (${JSON.stringify(s)})`);
  const big = await fontSampleText(font, 20, 40);
  check(big === "AB\nCD\nل", "sample sheet: widths scale with the size");
  const f2 = withFontInfo(font, { name: "Edited", size: 12, leading: 96, horiz_adv_x_space: 48, kerning_pairs: { "A V": -9.6 }, horiz_adv_x: { A: 96 }, reversible: false });
  check(f2.name === "Edited" && f2.size === 12 && near(f2.leading, 25.4) && near(f2.space, 12.7), "font info: metrics px → mm");
  check(near(f2.kerning["A V"], -2.54) && near(f2.adv.A, 25.4) && f2.reversible === false, "font info: kerning, advances, reversible");
  check(f2.glyph === font.glyph, "font info: the glyphs stay");
  const rows = kerningRows({ "B A": 1, "A V": -2, AT: 3 });
  check(rows.map((r) => `${r.left}|${r.right}`).join(",") === "A|T,A|V,B|A", "kerning rows: legacy pairs split, sorted");
  check(JSON.parse(fontJsonText({ name: "x", kerning_pairs: {} })).name === "x", "font.json text parses back");

  if (failed) throw new Error(`${failed} lettering tool check(s) failed`);
  console.log("all passed");
})().catch((e) => {
  // fail the run (an uncaught error ends Node with an error code)
  setTimeout(() => {
    throw e;
  });
});

// --- letters to font -------------------------------------------------------------
import { extractGlyphs } from "./inkFontPack.mjs";
import { fontNameFromFiles, letterOfFile, wrapGlyphLayer } from "./letteringTools";
check(letterOfFile("abc/Example_Font_A.pes") === "A" && letterOfFile("x_Ä.v2.dst") === "Ä" && letterOfFile("") === null, "letters to font: the glyph is the last character before the dot");
check(fontNameFromFiles(["Example_Font_A.pes", "Example_Font_B.pes"]) === "Example Font", "letters to font: the name from the common prefix");
check(fontNameFromFiles(["A.pes", "B.pes"]) === "Letters", "letters to font: a default name");
{
  const wrapped = wrapGlyphLayer('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="10mm" height="10mm" viewBox="0 0 10 10"><metadata>x</metadata><path d="M1 1 L5 5" style="stroke:#ff0000;fill:none"/></svg>', '"', 2);
  const g = extractGlyphs(wrapped).glyphs;
  check(Object.keys(g).join() === '"' && g['"'].includes("translate(2 0)") && !g['"'].includes("metadata"), "letters to font: the file becomes a glyph layer (escaped name, moved, metadata dropped)");
}
