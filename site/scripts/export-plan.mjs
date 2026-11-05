// Export a design's stitch plan from the running Filum app for the
// Blender renders (blender/data/<name>.json): needle points with flags,
// colour block and object index, the threads and the objects' stitch types.
//
//   # in the Filum repo: npm run dev
//   NODE_PATH=<dir with playwright>/node_modules node scripts/export-plan.mjs blender/data/mountain-badge.json
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const { chromium } = createRequire(import.meta.url)("playwright");
const out = process.argv[2] ?? "blender/data/mountain-badge.json";
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(process.env.APP_URL || "http://localhost:1420", { waitUntil: "networkidle" });
const data = await page.evaluate(async () => {
  const { useStore } = await import("/src/store.ts");
  for (let i = 0; i < 80 && (useStore.getState().planning || !useStore.getState().plan); i++) await new Promise((r) => setTimeout(r, 250));
  const s = useStore.getState();
  const pl = s.plan;
  const stitches = [];
  let block = 0;
  for (let i = 0; i < pl.flags.length; i++) {
    const f = pl.flags[i];
    if (f & 4) {
      block++; // colour change
      continue;
    }
    stitches.push([+pl.coords[2 * i].toFixed(3), +pl.coords[2 * i + 1].toFixed(3), f, block, pl.objects[i]]);
  }
  return {
    name: s.doc.name,
    hoop: s.doc.hoop,
    threads: pl.threads.map((t) => ({ name: t.name, color: t.color })),
    objects: s.doc.objects.map((o) => ({ name: o.name, type: o.stitch?.type, method: o.stitch?.method ?? o.stitch?.fill?.method ?? null })),
    stitches,
  };
});
writeFileSync(out, JSON.stringify(data));
console.log(`${data.name}: ${data.stitches.length} stitches in ${data.threads.length} colour blocks → ${out}`);
await browser.close();
