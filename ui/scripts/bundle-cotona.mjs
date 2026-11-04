// Build the Madeira Cotona thread charts from Madeira's published colour
// cards (no digital chart of Cotona is published elsewhere):
//
//   • Madeira (garne.madeira.de) Cotona colour card: all 120 colours with the
//     marks for Cotona 30 (red dot, 70 colours) and Cotona 80 (blue dot,
//     11 colours); Cotona 50 comes in all of them.
//   • Madeira USA / Quilting Thread custom colour card: the same 120 colours
//     as flat digital chips with names.
//
// Solid colours are the chips of the digital card (median), cross-checked
// against the Madeira card (median ΔE ≈ 1); the 16 multicolour threads are
// photos, so they get their mean colour (in linear light). Names are
// Madeira's, from the Madeira card.
//
//   node ui/scripts/bundle-cotona.mjs
//
// Needs Ghostscript (gswin64c / gs, or GS=<path>) and ImageMagick (magick).
// Writes ui/public/palettes/madeira/Cotona-{50,30,80}.gpl and adds them to
// ui/public/palettes/index.json.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pub = path.resolve(here, "../public/palettes");
const CARDS = {
  madeira: "https://garne.madeira.de/fileadmin/user_upload/home/Farbkarten_2024/Colour_Card_COTONA.pdf",
  usa: "https://cdn.shopify.com/s/files/1/0693/8007/9875/files/Cotona_Color_Card.pdf?v=1743004996",
};

function ghostscript() {
  if (process.env.GS) return process.env.GS;
  for (const c of ["gswin64c", "gs"]) {
    try {
      execFileSync(c, ["-v"], { stdio: "ignore" });
      return c;
    } catch {}
  }
  const base = "C:/Program Files/gs";
  if (fs.existsSync(base)) for (const v of fs.readdirSync(base).sort().reverse()) {
    const exe = path.join(base, v, "bin/gswin64c.exe");
    if (fs.existsSync(exe)) return exe;
  }
  throw new Error("Ghostscript not found (set GS=<path to gs>)");
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), "cotona-"));
const gs = ghostscript();
const run = (cmd, args) => execFileSync(cmd, args, { stdio: ["ignore", "ignore", "ignore"] });

// --- downloads, renders (one page per call: Ghostscript fails on the
// digital card when rendering several pages at once), text positions
for (const [k, url] of Object.entries(CARDS)) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  fs.writeFileSync(path.join(work, `${k}.pdf`), Buffer.from(await r.arrayBuffer()));
}
const render = (pdf, page, dpi, out) => {
  run(gs, ["-q", "-dNOPAUSE", "-dBATCH", "-sDEVICE=png16m", `-r${dpi}`, `-dFirstPage=${page}`, `-dLastPage=${page}`, `-sOutputFile=${out}.png`, pdf]);
  run("magick", [`${out}.png`, "-depth", "8", `${out}.ppm`]);
};
const textPos = (pdf, out, pages = []) => run(gs, ["-q", "-dNOPAUSE", "-dBATCH", "-sDEVICE=txtwrite", "-dTextFormat=1", ...pages, `-sOutputFile=${out}`, pdf]);
render(path.join(work, "madeira.pdf"), 2, 216, path.join(work, "md"));
for (const p of [1, 2, 3]) render(path.join(work, "usa.pdf"), p, 144, path.join(work, `us${p}`));
textPos(path.join(work, "madeira.pdf"), path.join(work, "md.xml"), ["-dFirstPage=2", "-dLastPage=2"]);
textPos(path.join(work, "usa.pdf"), path.join(work, "us.xml"));

// --- helpers
function spans(file) {
  const out = [];
  const seen = new Set();
  fs.readFileSync(file, "utf8")
    .split("<page>")
    .slice(1)
    .forEach((pg, pi) => {
      for (const m of pg.matchAll(/<span bbox="(\d+) (\d+) (\d+) (\d+)"[^>]*size="([\d.]+)">([\s\S]*?)<\/span>/g)) {
        const text = [...m[6].matchAll(/c="((?:[^"]|&quot;)*)"/g)].map((c) => c[1].replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&quot;/g, '"').replace(/&amp;/g, "&")).join("");
        const s = { page: pi + 1, x0: +m[1], y: +m[2], size: +m[5], text };
        const k = `${s.page}|${s.x0}|${s.y}|${s.text}`;
        if (!seen.has(k)) seen.add(k), out.push(s);
      }
    });
  return out;
}
function readPPM(file) {
  const b = fs.readFileSync(file);
  let i = 0;
  const tok = () => {
    while (b[i] === 0x23 || b[i] <= 32) {
      if (b[i] === 0x23) while (b[i] !== 10) i++;
      i++;
    }
    let s = "";
    while (b[i] > 32) s += String.fromCharCode(b[i++]);
    return s;
  };
  if (tok() !== "P6") throw new Error(`${file}: not a binary PPM`);
  const w = +tok();
  const h = +tok();
  tok();
  return { w, h, data: b.subarray(i + 1) };
}
const lin = (c) => ((c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const enc = (c) => Math.round(255 * Math.max(0, Math.min(1, c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055)));
function pixels(img, k, [x0, y0, x1, y1]) {
  const px = [];
  for (let y = Math.round(y0 * k); y < Math.round(y1 * k); y++)
    for (let x = Math.round(x0 * k); x < Math.round(x1 * k); x++) {
      const o = (y * img.w + x) * 3;
      px.push([img.data[o], img.data[o + 1], img.data[o + 2]]);
    }
  return px;
}
function sample(img, k, box) {
  const px = pixels(img, k, box);
  const med = [0, 1, 2].map((c) => px.map((p) => p[c]).sort((a, b) => a - b)[px.length >> 1]);
  const mean = [0, 1, 2].map((c) => enc(px.reduce((a, p) => a + lin(p[c]), 0) / px.length));
  const sd = Math.sqrt(px.reduce((a, p) => a + (p[0] - med[0]) ** 2 + (p[1] - med[1]) ** 2 + (p[2] - med[2]) ** 2, 0) / px.length / 3);
  return { med, mean, sd };
}
function lab([r, g, b]) {
  [r, g, b] = [lin(r), lin(g), lin(b)];
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const [x, y, z] = [(0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047, 0.2126 * r + 0.7152 * g + 0.0722 * b, (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883].map(f);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}
const dE = (a, b) => Math.hypot(...lab(a).map((v, i) => v - lab(b)[i]));
const title = (s) =>
  s
    .split(" ")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");

// --- Madeira card: numbers (9 pt) with the swatch to the left, the marks
// to the right and the name (5.5–9 pt) below
const colours = new Map();
const md = readPPM(path.join(work, "md.ppm"));
const mdSpans = spans(path.join(work, "md.xml")).filter((s) => s.x0 < 1600); // right panel: index
for (const n of mdSpans.filter((s) => /^\s*\d{3}\b/.test(s.text) && s.size > 8)) {
  const code = n.text.trim().slice(0, 3);
  const name = mdSpans
    .filter((s) => Math.abs(s.x0 - n.x0) <= 3 && s.y > n.y + 2 && s.y < n.y + 26 && !/^\s*\d{3}\b/.test(s.text) && s.size >= 5 && s.text.trim())
    .sort((a, b) => a.y - b.y)
    .map((s) => s.text.trim())
    .join(" ")
    .replace(/-\s+/g, "")
    .replace(/\s+/g, " ");
  const marks = pixels(md, 3, [n.x0 + 12, n.y - 12, n.x0 + 32, n.y + 4]);
  colours.set(code, {
    code,
    name: title(name),
    madeira: sample(md, 3, [n.x0 - 68, n.y - 8, n.x0 - 12, n.y + 10]),
    no30: marks.filter(([r, g, b]) => r > 180 && g < 100 && b < 100).length > 4,
    no80: marks.filter(([r, g, b]) => b > 140 && r < 100 && g < 170).length > 4,
  });
}
// --- digital card: "Cotona Color #: 772" under each chip
const usSpans = spans(path.join(work, "us.xml"));
for (const p of [1, 2, 3]) {
  const img = readPPM(path.join(work, `us${p}.ppm`));
  for (const l of usSpans.filter((s) => s.page === p && /Cotona Color/.test(s.text))) {
    const code = l.text.match(/\d{3}/)[0];
    const c = colours.get(code);
    if (!c) throw new Error(`colour ${code} is not on the Madeira card`);
    const nm = usSpans.find((s) => s.page === p && /^Name:/.test(s.text) && Math.abs(s.x0 - l.x0) <= 2 && s.y > l.y && s.y < l.y + 12);
    c.usa = sample(img, 2, [l.x0 + 6, l.y - 52, l.x0 + 62, l.y - 14]);
    if (!c.name && nm) c.name = nm.text.replace(/^Name:\s*/, "").trim();
  }
}
const all = [...colours.values()].sort((a, b) => a.code.localeCompare(b.code));
const missing = all.filter((c) => !c.usa).map((c) => c.code);
if (all.length !== 120 || missing.length) throw new Error(`expected 120 colours on both cards; ${all.length}, missing on the digital card: ${missing}`);
const n30 = all.filter((c) => c.no30).length;
const n80 = all.filter((c) => c.no80).length;
if (n30 !== 70 || n80 !== 11) throw new Error(`the card says 70 Cotona 30 and 11 Cotona 80 colours; found ${n30} and ${n80}`);

const entries = all.map((c) => {
  const multi = c.usa.sd >= 6;
  const rgb = multi ? c.usa.mean : c.usa.med;
  return { ...c, multi, rgb, check: multi ? null : dE(c.madeira.med, c.usa.med) };
});
const checks = entries.filter((e) => e.check !== null).map((e) => e.check).sort((a, b) => a - b);
console.log(`Cotona: ${entries.length} colours (${entries.filter((e) => e.multi).length} multicolour), Cotona 30: ${n30}, Cotona 80: ${n80}`);
console.log(`cards agree: median ΔE ${checks[checks.length >> 1].toFixed(2)}, 90 % ≤ ${checks[Math.floor(checks.length * 0.9)].toFixed(2)}`);

// --- charts
fs.mkdirSync(path.join(pub, "madeira"), { recursive: true });
const gpl = (name, list) =>
  [
    "GIMP Palette",
    `Name: ${name}`,
    "Columns: 4",
    "# Sampled from Madeira's Cotona colour cards (Madeira; Madeira USA / Quilting Thread)",
    "# RGB Value\tColor Name Number",
    ...list.map((e) => `${e.rgb.map((v) => String(v).padStart(3)).join(" ")}\t${e.name}${e.multi ? " Multicolour" : ""} ${e.code}`),
  ].join("\n") + "\n";
const charts = [
  { id: "madeira/Cotona-50", name: "Madeira Cotona 50", list: entries },
  { id: "madeira/Cotona-30", name: "Madeira Cotona 30", list: entries.filter((e) => e.no30) },
  { id: "madeira/Cotona-80", name: "Madeira Cotona 80", list: entries.filter((e) => e.no80) },
];
for (const c of charts) fs.writeFileSync(path.join(pub, `${c.id}.gpl`), gpl(c.name, c.list));

// --- index
const indexFile = path.join(pub, "index.json");
const index = JSON.parse(fs.readFileSync(indexFile, "utf8"));
index.sources.madeira = { label: "Madeira colour cards", url: CARDS.madeira, license: "sampled from Madeira's published colour cards (approximate screen colours)" };
index.charts = index.charts.filter((c) => c.source !== "madeira");
index.charts.push(...charts.map((c) => ({ id: c.id, name: c.name, brand: "Madeira", source: "madeira", count: c.list.length })));
index.charts.sort((a, b) => a.brand.localeCompare(b.brand) || a.name.localeCompare(b.name) || a.source.localeCompare(b.source));
fs.writeFileSync(indexFile, JSON.stringify(index, null, 1) + "\n");
fs.rmSync(work, { recursive: true, force: true });
console.log(`→ ${charts.map((c) => `${c.id}.gpl (${c.list.length})`).join(", ")}`);
