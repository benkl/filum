// Takes the screenshots for the README and the wiki (docs/wiki/images/*.webp).
//
//   npm run dev                                   # the editor on http://localhost:1420
//   mkdir -p /tmp/shots && cd /tmp/shots && npm i playwright@1 && npx playwright install chromium
//   NODE_PATH=/tmp/shots/node_modules node docs/tools/screenshots.mjs          # every shot
//   NODE_PATH=/tmp/shots/node_modules node docs/tools/screenshots.mjs digitize # just some
//
// Needs ImageMagick (`magick`) for the WebP conversion and `rsvg-convert` for
// the test picture. Each shot starts in a fresh browser profile, so it sees the
// sample design ("Mountain badge") and default settings. The app's store is
// imported from the dev server (/src/store.ts) to set views and selections.

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, "..", "wiki", "images");
const TMP = "/tmp/filum-shots";
const URL = process.env.URL || "http://localhost:1420";
const W = 1440, H = 900, DSF = 1.25;

mkdirSync(OUT, { recursive: true });
mkdirSync(TMP, { recursive: true });
const CACTUS = [...execFileSync("rsvg-convert", [join(HERE, "cactus.svg")])];

/** Run `body` with s = store state, useStore and a = args inside the page. */
const run = (p, body, ...a) =>
  p.evaluate(
    async ([body, a]) => {
      const { useStore } = await import("/src/store.ts");
      return new Function("s", "useStore", "a", body)(useStore.getState(), useStore, a);
    },
    [body, a],
  );
const wait = (p, ms) => p.waitForTimeout(ms);
async function waitPlan(p) {
  for (let i = 0; i < 80; i++) {
    if (!(await run(p, "return s.planning || !s.plan"))) return;
    await wait(p, 250);
  }
}
const select = async (p, name, view = "stitch") => {
  const id = await run(p, `return s.doc.objects.find((o) => o.name === a[0])?.id`, name);
  await run(p, `s.select([a[0]]); useStore.setState({ inspectorTab: "selection" }); s.setViewMode(a[1])`, id, view);
};
const emptyDesign = (p) => p.evaluate(async () => {
  const m = await import("/src/store.ts");
  m.useStore.getState().setDoc(m.emptyDoc());
});
async function openDigitizer(p) {
  await p.evaluate(async (bytes) => {
    const a = await import("/src/lib/actions.ts");
    a.pending.image = { name: "cactus.png", bytes: new Uint8Array(bytes) };
    (await import("/src/store.ts")).useStore.getState().setDialog("digitize");
  }, CACTUS);
  await wait(p, 6000);
}
const dialog = (name) => (p) => run(p, `s.setDialog(a[0])`, name);

const SHOTS = {
  "editor-light": (p) => run(p, `s.setViewMode("realistic")`),
  "editor-dark": (p) => run(p, `s.setTheme("dark"); s.setViewMode("realistic")`),
  start: emptyDesign,
  "view-vector": (p) => run(p, `s.setViewMode("vector")`),
  "view-stitch": (p) => run(p, `s.setViewMode("stitch")`),
  "view-realistic": (p) => run(p, `s.setViewMode("realistic")`),
  "stitch-settings": (p) => select(p, "Mountains"),
  "realistic-closeup": async (p) => {
    await run(p, `s.setViewMode("realistic")`);
    await waitPlan(p);
    await p.mouse.move(760, 450);
    for (let i = 0; i < 3; i++) {
      await p.mouse.wheel(0, -240);
      await wait(p, 150);
    }
  },
  "stitch-out": async (p) => {
    await run(p, `s.setViewMode("realistic")`);
    await waitPlan(p);
    await run(p, `const n = s.plan?.stitches?.length ?? 20000;
      useStore.setState({ anim: { playing: false, index: Math.floor(n * 0.55), speed: 1 } })`);
  },
  digitize: openDigitizer,
  "digitize-result": async (p) => {
    await emptyDesign(p);
    await openDigitizer(p);
    await p.getByRole("button", { name: "Add to design", exact: true }).click();
    await wait(p, 1500);
    await waitPlan(p);
    await run(p, `s.setViewMode("realistic")`);
  },
  "cross-stitch": async (p) => {
    await emptyDesign(p);
    await openDigitizer(p);
    await p.getByRole("button", { name: "Cross stitch", exact: true }).first().click();
    await wait(p, 5000);
  },
  lettering: async (p) => {
    await emptyDesign(p);
    await run(p, `s.setTool("text")`);
    await p.mouse.click(700, 330);
    await wait(p, 500);
    await p.keyboard.type("Filum", { delay: 40 });
    await wait(p, 800);
    await p.keyboard.press("Escape");
    await wait(p, 800);
    const id = await run(p, `return s.doc.objects[0]?.id`);
    await run(p, `s.select([a[0]]); useStore.setState({ inspectorTab: "selection" }); s.setViewMode("realistic")`, id);
  },
  "menu-stitch": (p) => p.getByRole("button", { name: "Stitch", exact: true }).first().click(),
  "command-palette": async (p) => {
    await p.keyboard.press("Control+k");
    await wait(p, 400);
    await p.keyboard.type("satin");
  },
  density: (p) => run(p, `useStore.setState({ showDensity: true }); s.setViewMode("stitch")`),
  issues: async (p) => {
    await emptyDesign(p);
    await openDigitizer(p);
    await p.getByRole("button", { name: "Add to design", exact: true }).click();
    await wait(p, 1500);
    await waitPlan(p);
    await run(p, `s.select([]); useStore.setState({ outlineTab: "issues" }); s.setViewMode("stitch")`);
  },
  export: dialog("export"),
  print: dialog("production"),
  threads: dialog("threads"),
  fonts: dialog("fonts"),
  shortcuts: dialog("shortcuts"),
  preferences: dialog("settings"),
  downloads: (p) => run(p, `s.openSettings("downloads")`),
  swatches: async (p) => {
    await select(p, "Mountains");
    await run(p, `s.setDialog("swatches")`);
  },
};

const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(SHOTS);
const browser = await chromium.launch();
for (const name of names) {
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: DSF });
  const p = await ctx.newPage();
  const errors = [];
  p.on("pageerror", (e) => errors.push(e.message));
  await p.goto(URL, { waitUntil: "networkidle" });
  await waitPlan(p);
  await wait(p, 800);
  try {
    await SHOTS[name](p);
  } catch (e) {
    errors.push(`action: ${e.message.split("\n")[0]}`);
  }
  await waitPlan(p);
  await wait(p, 1500);
  const png = join(TMP, `${name}.png`);
  await p.screenshot({ path: png });
  execFileSync("magick", [png, "-quality", "86", "-define", "webp:method=6", join(OUT, `${name}.webp`)]);
  rmSync(png);
  console.log(errors.length ? `${name}: ${errors.join(" | ")}` : `${name}: ok`);
  await ctx.close();
}
await browser.close();

// Three views side by side, cropped to the hoop (docs/wiki/images/views.webp)
if (["view-vector", "view-stitch", "view-realistic"].every((n) => names.includes(n))) {
  const crop = `${Math.round(560 * DSF)}x${Math.round(560 * DSF)}+${Math.round(436 * DSF)}+${Math.round(170 * DSF)}`;
  execFileSync("magick", [
    ...["view-vector", "view-stitch", "view-realistic"].flatMap((n) => ["(", join(OUT, `${n}.webp`), "-crop", crop, "+repage", ")"]),
    "+append", "-quality", "86", join(OUT, "views.webp"),
  ]);
  for (const n of ["view-vector", "view-stitch", "view-realistic"]) rmSync(join(OUT, `${n}.webp`));
}
