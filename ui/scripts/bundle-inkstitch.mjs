// Bundle the Ink/Stitch resources the app replicates into the repository, and
// describe the Embroidery Nerds thread charts as an optional download:
//
//   ui/public/palettes/*.gpl              Ink/Stitch thread charts (GPL-3.0)
//   ui/public/palettes/index.json         chart list: id, name, brand, source, count
//                                         (download: the pack a chart comes from)
//   ui/public/downloads/embroiderynerd-charts.json
//                                         Matthew Enderle / The Embroidery Nerds charts:
//                                         no licence is stated, so they are not
//                                         redistributed — the app downloads the
//                                         corel-swatches XML from the author's repository
//                                         (pinned commit) when the user asks for them in
//                                         Preferences ▸ Downloads and converts them there
//   crates/core/src/stitches/meander_tiles.json
//                                         Ink/Stitch meander tiles (tiles/*/tile.svg) as
//                                         line segments + repeat vectors, in mm
//   crates/core/assets/inkstitch/*.svg    Ink/Stitch command symbols and markers,
//                                         embedded in exported SVGs
//
//   node ui/scripts/bundle-inkstitch.mjs
//   INKSTITCH_SHA=<commit> EN_SHA=<commit> node ui/scripts/bundle-inkstitch.mjs   # pinned
//
// The outputs are committed; rerun to update. Downloads come from
// raw.githubusercontent.com at the commits recorded in index.json.

import fs from "node:fs";
import { corelEntries, corelTitle } from "../src/lib/corelPalette.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const pub = path.join(root, "ui/public");
const INK = "inkstitch/inkstitch";
const EN = "Matthewenderle/Embroidery-Thread-Palette-Converter";
const PX = 25.4 / 96; // Ink/Stitch works in CSS pixels

async function get(url, as = "text") {
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(url, { headers: url.includes("api.github.com") ? { Accept: "application/vnd.github+json" } : {} });
    if (r.ok) return as === "json" ? r.json() : r.text();
    if (attempt >= 3) throw new Error(`${url}: HTTP ${r.status}`);
    await new Promise((res) => setTimeout(res, 1000 * (attempt + 1)));
  }
}
async function tree(repo, pin) {
  const sha = pin || (await get(`https://api.github.com/repos/${repo}/commits/HEAD`, "json")).sha;
  const t = await get(`https://api.github.com/repos/${repo}/git/trees/${sha}?recursive=1`, "json");
  const blobs = t.tree.filter((e) => e.type === "blob");
  return { sha, files: blobs.map((e) => e.path), sizes: new Map(blobs.map((e) => [e.path, e.size])) };
}
const raw = (repo, sha, p) => `https://raw.githubusercontent.com/${repo}/${sha}/${p.split("/").map(encodeURIComponent).join("/")}`;
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k], k);
      }
    }),
  );
  return out;
}

// ---------------------------------------------------------------------------
// Brands: names are "<brand> <line>"; these brands have spaces or dashes

const BRANDS = [
  "Brothread/Brother", "New Brothreads", "Jenny Haskins", "Poly X40", "Cotone Mako", "Misairu Tsuru", "Filato Lana", "Hilos Iris", "Robison-Anton", "Fil-Tec", "Coats", "Pearl Yacht", "Quilters Select", "Hilos Iris", "Embroidery Service", "Colourful Thread",
  "The Institute of Heraldry", "Madeira", "Isacord", "Gunold", "Sulky", "Mettler", "Floriani", "Brother", "Brothread", "Marathon",
  "Gutermann", "Gütermann", "Aurifil", "AURIfil", "Simthread", "Wonderfil", "Exquisite", "Embellish", "Robison Anton", "King Star", "Kingstar",
  "Outback", "Radiant", "Royal", "Tristar", "Sigma", "Janome", "Admelody", "ARC", "BFC", "Brildor", "FuFu", "Fufu", "Isafil", "Isalon", "Amann",
  "Angelking", "Candle", "Durak", "Embro", "Iris", "Polyseda", "RNK", "Sakura", "Setta", "Silky", "Skylab", "Tridalia", "Wonang", "Yenmet",
];
function brandOf(name) {
  const n = name.replace(/_/g, " ");
  const b = BRANDS.filter((x) => n.toLowerCase().startsWith(x.toLowerCase() + " ") || n.toLowerCase() === x.toLowerCase()).sort((a, c) => c.length - a.length)[0];
  const brand = b ?? n.split(/\s+/)[0];
  const norm = { "Brothread/Brother": "Brother", "New Brothreads": "Brother", "Threadart": "ThreadArt", "Pantone®": "Pantone", "AURIfil": "Aurifil", "Gutermann": "Gütermann", "Kingstar": "King Star", "Fufu": "FuFu", "Robison Anton": "Robison-Anton", "Brothread": "Brother" };
  return norm[brand] ?? brand;
}

const countGpl = (text) => text.split("\n").filter((l) => /^\s*\d+\s+\d+\s+\d+/.test(l)).length;

// ---------------------------------------------------------------------------
// Palettes

async function palettes(ink, en) {
  const dir = path.join(pub, "palettes");
  fs.mkdirSync(path.join(dir, "en"), { recursive: true });
  const index = [];
  // Ink/Stitch: "palettes/InkStitch Madeira Polyneon.gpl" → Madeira-Polyneon.gpl
  const inkFiles = ink.files.filter((f) => /^palettes\/InkStitch .*\.gpl$/.test(f));
  await pool(inkFiles, 8, async (f) => {
    const name = path.basename(f, ".gpl").replace(/^InkStitch /, "");
    const id = name.replace(/\s+/g, "-");
    const text = await get(raw(INK, ink.sha, f));
    fs.writeFileSync(path.join(dir, `${id}.gpl`), text.replace(/\r\n/g, "\n"));
    index.push({ id, name, brand: brandOf(name), source: "inkstitch", count: countGpl(text) });
  });
  // Embroidery Nerds: corel-swatches/*.xml, listed for download (converted in the app)
  fs.rmSync(path.join(dir, "en"), { recursive: true, force: true });
  const enFiles = en.files.filter((f) => /^corel-swatches\/.*\.xml$/.test(f));
  const items = [];
  await pool(enFiles, 8, async (f) => {
    const stem = path.basename(f, ".xml");
    const xml = await get(raw(EN, en.sha, f));
    const { brand, name } = corelTitle(xml, stem);
    const count = corelEntries(xml).length;
    if (!count) return;
    const id = `en/${stem}`;
    const meta = { id, name, brand: brandOf(brand || name), source: "embroiderynerd", count, download: "embroiderynerd-charts" };
    index.push(meta);
    items.push({ id, name, brand: meta.brand, count, files: [[f, en.sizes.get(f) ?? 0]] });
  });
  items.sort((a, b) => a.brand.localeCompare(b.brand) || a.name.localeCompare(b.name));
  writePack({
    id: "embroiderynerd-charts",
    kind: "charts",
    title: "Embroidery Nerds thread charts",
    summary: `${items.length} more thread charts from the Embroidery Nerds thread database, by Matthew Enderle — Amann, Angelking, ARC, Aurifil, Coats, Fil-Tec, Floriani, Hemingworth, Kingfisher, Sulky and many more.`,
    license: {
      name: "No licence stated",
      url: `https://github.com/${EN}`,
      terms: "The author offers these charts as a free download for embroiderers but has not published a licence, so Filum can't include them. Filum downloads them from the author's repository to this device, for your own use. Brand and colour names belong to their owners.",
    },
    source: { label: `${EN} (corel-swatches)`, url: `https://github.com/${EN}/tree/${en.sha}/corel-swatches` },
    base: `https://raw.githubusercontent.com/${EN}/${en.sha}/`,
    version: en.sha,
    items,
  });
  // charts from other bundlers (e.g. bundle-cotona.mjs) stay
  const indexFile = path.join(dir, "index.json");
  const prev = fs.existsSync(indexFile) ? JSON.parse(fs.readFileSync(indexFile, "utf8")) : { sources: {}, charts: [] };
  index.push(...prev.charts.filter((c) => c.source !== "inkstitch" && c.source !== "embroiderynerd"));
  index.sort((a, b) => a.brand.localeCompare(b.brand) || a.name.localeCompare(b.name) || a.source.localeCompare(b.source));
  const out = {
    sources: {
      ...prev.sources,
      inkstitch: { label: "Ink/Stitch", url: `https://github.com/${INK}/tree/${ink.sha}/palettes`, license: "GPL-3.0-or-later" },
      embroiderynerd: { label: "Embroidery Nerds", url: `https://github.com/${EN}/tree/${en.sha}/corel-swatches`, license: "none stated (\"provided for free\") — downloaded on request, not bundled" },
    },
    charts: index,
  };
  fs.writeFileSync(path.join(dir, "index.json"), JSON.stringify(out, null, 1) + "\n");
  console.log(`palettes: ${index.filter((c) => c.source === "inkstitch").length} Ink/Stitch + ${index.filter((c) => c.source === "embroiderynerd").length} Embroidery Nerds, ${index.reduce((a, c) => a + c.count, 0)} colours`);
}

// ---------------------------------------------------------------------------
// Meander tiles: tile.svg → segments (only the end points of each sub-path
// count, as in Ink/Stitch lib/tiles.py) and the repeat vectors from the
// "para" parallelogram.

function parseTransform(t) {
  let m = [1, 0, 0, 1, 0, 0];
  const mul = (a, b) => [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3], a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
  for (const [, fn, args] of (t ?? "").matchAll(/(\w+)\s*\(([^)]*)\)/g)) {
    const v = args.split(/[\s,]+/).filter(Boolean).map(Number);
    let k = [1, 0, 0, 1, 0, 0];
    if (fn === "matrix") k = v;
    else if (fn === "translate") k = [1, 0, 0, 1, v[0], v[1] ?? 0];
    else if (fn === "scale") k = [v[0], 0, 0, v[1] ?? v[0], 0, 0];
    else if (fn === "rotate") {
      const a = (v[0] * Math.PI) / 180;
      const [c, s] = [Math.cos(a), Math.sin(a)];
      k = [c, s, -s, c, 0, 0];
      if (v.length === 3) k = mul(mul([1, 0, 0, 1, v[1], v[2]], k), [1, 0, 0, 1, -v[1], -v[2]]);
    } else if (fn === "skewX") k = [1, 0, Math.tan((v[0] * Math.PI) / 180), 1, 0, 0];
    else if (fn === "skewY") k = [1, Math.tan((v[0] * Math.PI) / 180), 0, 1, 0, 0];
    m = mul(m, k);
  }
  return { m, mul };
}
const apply = (m, [x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

/** End points of each sub-path of an SVG path. */
function subpathEnds(d) {
  return pathNodes(d).map((n) => [n[0], n[n.length - 1]]);
}

/** On-curve points of each sub-path of an SVG path (Z returns to the start). */
function pathNodes(d) {
  const toks = d.match(/[a-df-z]|[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi) ?? [];
  const out = [];
  let i = 0;
  let cmd = "";
  let cur = [0, 0];
  let start = null;
  let first = [0, 0];
  const num = () => parseFloat(toks[i++]);
  let nodes = [];
  const close = () => {
    if (start && nodes.length > 1) out.push(nodes);
    start = null;
    nodes = [];
  };
  const ARGS = { m: 2, l: 2, h: 1, v: 1, c: 6, s: 4, q: 4, t: 2, a: 7, z: 0 };
  while (i < toks.length) {
    if (/[a-z]/i.test(toks[i])) cmd = toks[i++];
    const lc = cmd.toLowerCase();
    const rel = cmd !== cmd.toUpperCase();
    if (lc === "z") {
      cur = first;
      nodes.push(cur);
      close();
      cmd = "";
      continue;
    }
    if (!ARGS[lc]) throw new Error(`path command ${cmd}`);
    const a = Array.from({ length: ARGS[lc] }, num);
    let p;
    if (lc === "h") p = [rel ? cur[0] + a[0] : a[0], cur[1]];
    else if (lc === "v") p = [cur[0], rel ? cur[1] + a[0] : a[0]];
    else p = rel ? [cur[0] + a[a.length - 2], cur[1] + a[a.length - 1]] : [a[a.length - 2], a[a.length - 1]];
    if (lc === "m") {
      close();
      start = p;
      first = p;
      cur = p;
      nodes = [p];
      cmd = rel ? "l" : "L";
      continue;
    }
    cur = p;
    nodes.push(p);
  }
  close();
  return out;
}

function parseTile(svg) {
  const lines = [];
  let para = null;
  const stack = [[1, 0, 0, 1, 0, 0]];
  const { mul } = parseTransform("");
  for (const m of svg.matchAll(/<(\/?)([\w:]+)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g)) {
    const [, closing, tag, attrs, selfClose] = m;
    if (tag.startsWith("?") || tag.startsWith("!")) continue;
    if (closing) {
      if (tag === "g" || tag === "svg:g") stack.pop();
      continue;
    }
    const a = Object.fromEntries([...attrs.matchAll(/([\w:-]+)\s*=\s*"([^"]*)"/g)].map((x) => [x[1], x[2]]));
    const m0 = mul(stack[stack.length - 1], parseTransform(a.transform).m);
    const name = tag.replace(/^svg:/, "");
    if (name === "g") {
      if (!selfClose) stack.push(m0);
      continue;
    }
    if (/\bdisplay\s*:\s*none/.test(a.style ?? "")) continue;
    const isPara = (a.class ?? "").split(/\s+/).includes("para");
    if (isPara) {
      let pts;
      if (name === "polygon" || name === "polyline") {
        const v = a.points.trim().split(/[\s,]+/).map(Number);
        pts = [];
        for (let k = 0; k + 1 < v.length; k += 2) pts.push([v[k], v[k + 1]]);
      } else if (name === "path") {
        pts = pathNodes(a.d)[0];
      } else if (name === "rect") {
        const [x, y, w, h] = [+a.x || 0, +a.y || 0, +a.width, +a.height];
        pts = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
      }
      if (pts && pts.length >= 3) {
        const p = pts.map((q) => apply(m0, q));
        para = [[p[1][0] - p[0][0], p[1][1] - p[0][1]], [p[2][0] - p[1][0], p[2][1] - p[1][1]]];
      }
      continue;
    }
    if (name === "path" && a.d) for (const [s, e] of subpathEnds(a.d)) lines.push([apply(m0, s), apply(m0, e)]);
  }
  const root = /<svg\b((?:[^>"']|"[^"]*")*)>/.exec(svg)?.[1] ?? "";
  // the page size in px (inkex viewport_width / viewport_height)
  const UNIT = { "": 1, px: 1, mm: 96 / 25.4, cm: 96 / 2.54, in: 96, pt: 96 / 72, pc: 16 };
  const dim = (k) => {
    const m = new RegExp(`\\b${k}="([\\d.]+)\\s*([a-z]*)"`).exec(root);
    return m ? parseFloat(m[1]) * (UNIT[m[2]] ?? 1) : 0;
  };
  if (!para) para = [[dim("width"), 0], [0, dim("height")]];
  // centre on the bounds of the lines (Ink/Stitch does the same)
  const xs = lines.flatMap((l) => [l[0][0], l[1][0]]);
  const ys = lines.flatMap((l) => [l[0][1], l[1][1]]);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
  const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  const r = (v) => Math.round(v * PX * 1e4) / 1e4;
  return {
    shift0: para[0].map(r),
    shift1: para[1].map(r),
    lines: lines.filter((l) => Math.hypot(l[1][0] - l[0][0], l[1][1] - l[0][1]) > 1e-6).map(([s, e]) => [r(s[0] - cx), r(s[1] - cy), r(e[0] - cx), r(e[1] - cy)]),
  };
}

/** Dead ends of the infinite tiling (should be none): a sanity check. */
function deadEnds(t) {
  const deg = new Map();
  // Ink/Stitch snaps nodes to whole pixels
  const key = (x, y) => `${Math.round(x / PX)},${Math.round(y / PX)}`;
  for (let i = -3; i <= 3; i++)
    for (let j = -3; j <= 3; j++) {
      const ox = i * t.shift0[0] + j * t.shift1[0];
      const oy = i * t.shift0[1] + j * t.shift1[1];
      for (const [x1, y1, x2, y2] of t.lines) {
        for (const k of [key(x1 + ox, y1 + oy), key(x2 + ox, y2 + oy)]) deg.set(k, (deg.get(k) ?? 0) + 1);
      }
    }
  let n = 0;
  for (const [k, d] of deg) {
    const [x, y] = k.split(",").map((v) => +v * PX);
    if (Math.hypot(x, y) < 3 && d === 1) n++;
  }
  return n;
}

async function tiles(ink) {
  const ids = [...new Set(ink.files.filter((f) => /^tiles\/[^/]+\/tile\.svg$/.test(f)).map((f) => f.split("/")[1]))].sort();
  const out = await pool(ids, 8, async (id) => {
    const svg = await get(raw(INK, ink.sha, `tiles/${id}/tile.svg`));
    let meta = {};
    try {
      meta = JSON.parse(await get(raw(INK, ink.sha, `tiles/${id}/tile.json`)));
    } catch {}
    const t = parseTile(svg);
    const dead = deadEnds(t);
    if (dead) console.warn(`  tile ${id}: ${dead} dead ends near the centre (pruned, as in Ink/Stitch)`);
    return { id: meta.id ?? id, name: meta.name ?? id, ...t };
  });
  const file = path.join(root, "crates/core/src/stitches/meander_tiles.json");
  fs.writeFileSync(file, JSON.stringify({ source: `https://github.com/${INK}/tree/${ink.sha}/tiles`, license: "GPL-3.0-or-later", tiles: out }) + "\n");
  console.log(`tiles: ${out.length}, ${out.reduce((a, t) => a + t.lines.length, 0)} segments → ${path.relative(root, file)}`);
}

async function symbols(ink) {
  const dir = path.join(root, "crates/core/assets/inkstitch");
  fs.mkdirSync(dir, { recursive: true });
  for (const f of ["symbols/inkstitch.svg", "symbols/marker.svg"]) fs.writeFileSync(path.join(dir, path.basename(f)), (await get(raw(INK, ink.sha, f))).replace(/\r\n/g, "\n"));
  console.log(`symbols → ${path.relative(root, dir)}`);
}

/** A download pack (public/downloads/<id>.json): what Preferences ▸ Downloads offers. */
function writePack(pack) {
  const dir = path.join(pub, "downloads");
  fs.mkdirSync(dir, { recursive: true });
  const bytes = pack.items.reduce((n, it) => n + it.files.reduce((m, f) => m + f[1], 0), 0);
  fs.writeFileSync(path.join(dir, `${pack.id}.json`), JSON.stringify({ ...pack, bytes }, null, 1) + "\n");
  console.log(`download pack ${pack.id}: ${pack.items.length} items, ${(bytes / 1e6).toFixed(1)} MB`);
}

const [ink, en] = await Promise.all([tree(INK, process.env.INKSTITCH_SHA), tree(EN, process.env.EN_SHA)]);
console.log(`Ink/Stitch ${ink.sha.slice(0, 10)}, Embroidery Nerds ${en.sha.slice(0, 10)}`);
await palettes(ink, en);
await tiles(ink);
await symbols(ink);
