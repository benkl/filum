// Export the sample design from the running Filum app for the page's
// interactive editor (public/data/badge.json): the objects as SVG paths (the
// vector view) and the stitch plan as compact runs in sew order (the stitch and
// realistic views and the stitch-out).
//
//   # in the Filum repo: npm run dev
//   NODE_PATH=<dir with playwright>/node_modules node scripts/export-badge.mjs
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const { chromium } = createRequire(import.meta.url)("playwright");
const OUT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "public", "data", "badge.json");
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(process.env.APP_URL || "http://localhost:1420", { waitUntil: "networkidle" });
const data = await page.evaluate(async () => {
  const { useStore } = await import("/src/store.ts");
  for (let i = 0; i < 80 && (useStore.getState().planning || !useStore.getState().plan); i++) await new Promise((r) => setTimeout(r, 250));
  const s = useStore.getState();
  const doc = s.doc;
  const pl = s.plan;
  const f = (v) => +v.toFixed(2);
  const d = (sp) => {
    const n = sp.nodes;
    let out = `M${f(n[0].p[0])} ${f(n[0].p[1])}`;
    const seg = (a, b) => {
      const c1 = a.o ?? a.p, c2 = b.i ?? b.p;
      out += a.o || b.i ? `C${f(c1[0])} ${f(c1[1])} ${f(c2[0])} ${f(c2[1])} ${f(b.p[0])} ${f(b.p[1])}` : `L${f(b.p[0])} ${f(b.p[1])}`;
    };
    for (let i = 1; i < n.length; i++) seg(n[i - 1], n[i]);
    if (sp.closed) {
      seg(n[n.length - 1], n[0]);
      out += "Z";
    }
    return out;
  };
  const threads = doc.threads.map((t) => ({ id: t.id, name: t.name, color: t.color }));
  const objects = doc.objects.map((o) => ({
    name: o.name,
    type: o.stitch?.type,
    method: o.stitch?.method ?? null,
    thread: threads.findIndex((t) => t.id === o.thread),
    width: o.stitch?.width ?? null,
    d: o.paths.map(d).join(" "),
  }));
  // stitch plan: runs (broken at jumps/trims) per colour block, coordinates in 0.1 mm
  const blocks = [];
  let block = { thread: 0, runs: [], stitches: 0 }, run = [];
  const close = () => {
    if (run.length >= 4) block.runs.push(run);
    run = [];
  };
  for (let i = 0; i < pl.flags.length; i++) {
    const fl = pl.flags[i];
    if (fl & 4) {
      close();
      if (block.runs.length) blocks.push(block);
      block = { thread: blocks.length + 1, runs: [], stitches: 0 };
      continue;
    }
    if (fl & 3) close(); // jump / trim
    run.push(Math.round(pl.coords[2 * i] * 10), Math.round(pl.coords[2 * i + 1] * 10));
    block.stitches++;
  }
  close();
  if (block.runs.length) blocks.push(block);
  const planThreads = pl.threads.map((t) => threads.findIndex((x) => x.color.toLowerCase() === t.color.toLowerCase()));
  blocks.forEach((b, i) => (b.thread = planThreads[i] ?? b.thread));
  return { name: doc.name, hoop: { w: doc.hoop.width, h: doc.hoop.height }, threads, objects, blocks, stats: { stitches: pl.flags.length, colours: pl.threads.length, ...pl.stats } };
});
writeFileSync(OUT, JSON.stringify(data));
console.log(`${data.name}: ${data.objects.length} objects, ${data.blocks.length} blocks, ${data.stats.stitches} stitches → ${OUT}`);
await browser.close();
