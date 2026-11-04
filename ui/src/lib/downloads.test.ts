// Licensing-clean build and the optional downloads (npm run test:match):
// nothing with a non-redistributable licence is bundled, every download is
// described by a pinned pack, and the chart converter matches the build's.

import { corelEntries, corelTitle, gplText } from "./corelPalette.mjs";
import { PACK_IDS, type DownloadPack } from "./downloadStore";

// The UI has no Node types; the checks run in Node (bundled to CommonJS).
declare const process: { cwd(): string; exit(code: number): never };
declare function require(m: string): unknown;
const { existsSync, readdirSync, readFileSync } = require("node:fs") as {
  existsSync(p: string): boolean;
  readdirSync(p: string): string[];
  readFileSync(p: string, enc: "utf8"): string;
};
const path = require("node:path") as { resolve(...p: string[]): string; join(...p: string[]): string };

let failed = 0;
const check = (ok: boolean, msg: string) => {
  console.log((ok ? "ok   " : "FAIL ") + msg);
  if (!ok) failed++;
};

const pub = path.resolve(process.cwd(), existsSync("ui/public") ? "ui/public" : "public");
const json = <T>(p: string): T => JSON.parse(readFileSync(path.join(pub, p), "utf8")) as T;

// --- packs
const packs = PACK_IDS.map((id) => json<DownloadPack>(`downloads/${id}.json`));
for (const p of packs) {
  check(/^[0-9a-f]{40}$/.test(p.version) && p.base.includes(p.version), `${p.id}: pinned to a commit (${p.version.slice(0, 10)})`);
  check(p.base.startsWith("https://raw.githubusercontent.com/"), `${p.id}: downloads from the author's repository`);
  check(!!p.license.name && /^https:\/\//.test(p.license.url) && p.license.terms.length > 40, `${p.id}: has a licence name, link and summary`);
  check(p.items.length > 0 && p.items.every((it) => it.files.length > 0 && it.files.every(([f, n]) => !!f && n > 0)), `${p.id}: every item lists its files with sizes`);
  check(p.bytes === p.items.reduce((n, it) => n + it.files.reduce((m, f) => m + f[1], 0), 0), `${p.id}: total size matches the files`);
  check(new Set(p.items.map((i) => i.id)).size === p.items.length, `${p.id}: item ids are unique`);
}
const byId = new Map(packs.map((p) => [p.id, p]));

// --- fonts: non-commercial ones are listed, not bundled
type Row = { id: string; license: string; download?: string };
const fonts = json<{ fonts: Row[] }>("embroidery-fonts/index.json").fonts;
const nc = (l: string) => /\bNC\b|non.?commercial/i.test(l);
check(fonts.filter((f) => !f.download).every((f) => !nc(f.license)), "no bundled embroidery font has a non-commercial licence");
check(fonts.filter((f) => nc(f.license)).every((f) => f.download === "nc-fonts"), "every non-commercial font is an optional download");
const fontPack = byId.get("nc-fonts")!;
check(fonts.filter((f) => f.download).every((f) => fontPack.items.some((i) => i.id === f.id)), "every downloadable font is in the font pack");
check(fonts.filter((f) => f.download).every((f) => !existsSync(path.join(pub, "embroidery-fonts", f.id))), "downloadable fonts have no files in the app");
check(fonts.filter((f) => !f.download).every((f) => existsSync(path.join(pub, "embroidery-fonts", f.id, "font.json.gz"))), "every bundled font has its files");
check(fontPack.items.every((i) => i.files.some(([f]) => f.endsWith("/font.json")) && i.files.some(([f]) => f.endsWith(".svg"))), "font pack items have font.json and glyph files");

// --- thread charts: Embroidery Nerds charts are listed, not bundled
type Chart = { id: string; source: string; download?: string };
const charts = json<{ charts: Chart[] }>("palettes/index.json").charts;
check(charts.filter((c) => c.source === "embroiderynerd").every((c) => c.download === "embroiderynerd-charts"), "every Embroidery Nerds chart is an optional download");
check(!existsSync(path.join(pub, "palettes", "en")) || readdirSync(path.join(pub, "palettes", "en")).length === 0, "no Embroidery Nerds chart files in the app");
const chartPack = byId.get("embroiderynerd-charts")!;
check(charts.filter((c) => c.download).every((c) => chartPack.items.some((i) => i.id === c.id)), "every downloadable chart is in the chart pack");
check(charts.filter((c) => !c.download).every((c) => existsSync(path.join(pub, "palettes", `${c.id}.gpl`))), "every bundled chart has its file");

// --- chart conversion (the same code the build used for the bundled charts)
const xml = `<?xml version="1.0"?><palette guid="x" name="Madeira - Polyneon &amp; Co">
<colors><page>
<color cs="RGB" tints="1,0,0" name="1621 - Rust"/>
<color cs="RGB" tints="0.5,0.5,0.5" name="Yellow C - Yellow C"/>
<color cs="RGB" tints="0,0,1" name="Red 032 C"/>
<color cs="CMYK" tints="0,0,0,1" name="skip"/>
</page></colors></palette>`;
const t = corelTitle(xml, "x");
check(t.brand === "Madeira" && t.name === "Madeira Polyneon & Co", "chart title: brand and name");
const es = corelEntries(xml);
check(es.length === 3, "only RGB colours");
check(es[0].code === "1621" && es[0].name === "Rust" && es[0].rgb.join() === "255,0,0", "code first, then the name");
check(es[1].code === "" && es[1].name === "Yellow C", "a label without a number is a name");
check(es[2].code === "Red032C" && es[2].name === "Red 032 C", "a numbered label keeps its name, coded without spaces");
const gpl = gplText("Embroidery Nerds: Madeira Polyneon", es);
check(gpl.startsWith("GIMP Palette\nName: Embroidery Nerds: Madeira Polyneon\n") && gpl.includes("255   0   0\tRust 1621"), "GIMP palette text");

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("all passed");
