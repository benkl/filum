// Issue #7 — feature demos captured from the real app (no mock-ups).
//
//   # in the Filum repo: npm run dev   (the editor on http://localhost:1420)
//   NODE_PATH=<dir with playwright>/node_modules node scripts/capture.mjs [name …]
//
// Needs Playwright with Chromium, ffmpeg (H.264 + VP9) and ImageMagick.
// Writes public/demos/*.webp, *.mp4 and *.webm. Frames are captured step by
// step from the app's own state (no screen recording), so loops are smooth.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, "..", "public", "demos");
const APP = process.env.APP_URL || "http://localhost:1420";
const DSF = 2;
mkdirSync(OUT, { recursive: true });

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
  for (let i = 0; i < 120; i++) {
    if (!(await run(p, "return s.planning || !s.plan"))) return;
    await wait(p, 120);
  }
}
const webp = (png, name, q = 84) => execFileSync("magick", [png, "-quality", String(q), "-define", "webp:method=6", join(OUT, `${name}.webp`)]);
/** A square crop around the middle of the canvas. */
async function canvasSquare(p, size = 640) {
  const b = await p.locator(".canvas-wrap").boundingBox();
  const cx = b.x + b.width / 2 + 10, cy = b.y + b.height / 2 + 6;
  return { x: cx - size / 2, y: cy - size / 2, width: size, height: size };
}
function encode(dir, name, fps) {
  const inp = ["-framerate", String(fps), "-i", join(dir, "f%04d.png")];
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", ...inp, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "24", "-preset", "slow", "-movflags", "+faststart", "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2", join(OUT, `${name}.mp4`)]);
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", ...inp, "-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "36", "-row-mt", "1", "-pix_fmt", "yuv420p", join(OUT, `${name}.webm`)]);
}
// the showcase's edits: the disc's yellow gets a satin edge, and the sew order puts the
// cactus outline over the cactus, the pot (and its brown outline) over the cactus, and the
// red flower over all of it
const DISC = [254, 227, 163];
// the artwork has six stitched colours: presets at six (one goes to the background) get seven
const COLOURS = { logo: 7, patch: 7 };
const SEW_ORDER = [DISC, [63, 154, 90], [33, 95, 55], [234, 124, 69], [110, 66, 39], [216, 60, 64]];
// the digitizer presets the page's demo offers (src/demos/digitize.ts), by their app labels
const PAGE_PRESETS = [["logo", "Logo"], ["illustration", "Illustration"], ["lineart", "Line art"], ["patch", "Patch"], ["cartoon", "Cartoon"], ["pixel", "Pixel art"]];
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

const DEMOS = {
  async views(p) {
    for (const v of ["vector", "stitch", "realistic"]) {
      await run(p, `s.setViewMode(a[0]); s.select([])`, v);
      await waitPlan(p);
      await wait(p, 900);
      const png = join(tmp, `view-${v}.png`);
      await p.screenshot({ path: png, clip: await canvasSquare(p) });
      webp(png, `view-${v}`);
    }
  },
  async stitchout(p) {
    await run(p, `s.setViewMode("realistic")`);
    await waitPlan(p);
    await wait(p, 800);
    const n = await run(p, "return s.plan.flags.length");
    const clip = await canvasSquare(p);
    const dir = mkdtempSync(join(tmp, "so-"));
    const frames = 150, hold = 45;
    for (let i = 0; i < frames + hold; i++) {
      const k = Math.min(1, i / frames);
      await run(p, `useStore.setState({ anim: { playing: false, index: a[0], speed: 1 } })`, Math.max(1, Math.round(ease(k) * n)));
      await wait(p, 40);
      await p.screenshot({ path: join(dir, `f${String(i).padStart(4, "0")}.png`), clip });
    }
    encode(dir, "stitchout", 30);
    webp(join(dir, `f${String(frames + hold - 1).padStart(4, "0")}.png`), "stitchout-poster");
  },
  async digitize(p) {
    await p.evaluate(async () => {
      const m = await import("/src/store.ts");
      m.useStore.getState().setDoc(m.emptyDoc());
    });
    const bytes = [...execFileSync("rsvg-convert", ["-w", "800", resolve(HERE, "cactus.svg")])];
    await p.evaluate(async (bytes) => {
      const a = await import("/src/lib/actions.ts");
      a.pending.image = { name: "cactus.png", bytes: new Uint8Array(bytes) };
      (await import("/src/store.ts")).useStore.getState().setDialog("digitize");
    }, bytes);
    await wait(p, 7000);
    const box = p.locator(".dz-box");
    let png;
    // the real stitched result of every preset the page offers, with the dialog's stats
    // (public/demos/digitize-<preset>.webp and public/data/digitize.json)
    const stats = {};
    await p.getByRole("button", { name: "Stitches", exact: true }).first().click();
    // wait for the re-digitize and the stitch plan to settle
    // (the dialog re-digitizes 220 ms after a change and shows its busy line meanwhile:
    // wait for that to come and go, then for the stats to stay put)
    const busy = () => p.locator(".dot-pulse").count();
    const settle = async () => {
      for (let i = 0; i < 10 && !(await busy()); i++) await wait(p, 100);
      for (let i = 0; i < 240 && (await busy()); i++) await wait(p, 250);
      let last = "";
      for (let i = 0; i < 60; i++) {
        await wait(p, 500);
        const now = await p.locator(".dz-stats").innerText();
        if (now === last && /stitches/.test(now) && !(await busy())) break;
        last = now;
      }
    };
    const pane = (name) => p.locator(".dz-side [role=tab], .dz-side button", { hasText: name }).first().click();
    const rgbOf = (css) => css.match(/\d+/g).slice(0, 3).map(Number);
    const dist = (a, b) => a.reduce((s, v, k) => s + (v - b[k]) ** 2, 0);
    /** Put the result's threads in the sew order SEW_ORDER (with the dialog's ↑ buttons). */
    const sewOrder = async () => {
      for (let guard = 0; guard < 20; guard++) {
        const sw = await p.locator(".dz-order li .dz-order-sw").evaluateAll((els) => els.map((e) => getComputedStyle(e).backgroundColor));
        const rank = sw.map((c) => {
          const rgb = rgbOf(c);
          let best = 0;
          SEW_ORDER.forEach((t, k) => dist(t, rgb) < dist(SEW_ORDER[best], rgb) && (best = k));
          return best;
        });
        const i = rank.findIndex((r, k) => k > 0 && r < rank[k - 1]);
        if (i < 0) return;
        await p.locator(".dz-order li").nth(i).locator("button").first().click();
        await settle();
      }
    };
    /** No satin edges and the digitizer's own sew order (the edits carry over between presets). */
    const clearEdits = async () => {
      for (const btn of await p.locator('.dz-colours button[aria-label$="satin edge"][aria-pressed="true"]').all()) {
        await btn.click();
        await settle();
      }
      const auto = p.locator(".dz-side button", { hasText: "Auto" });
      if (await auto.count()) {
        await auto.first().click();
        await settle();
      }
    };
    /** Satin edge on for the colour nearest `rgb`. */
    const satinEdge = async (rgb) => {
      const rows = p.locator(".dz-colours .dz-colour");
      const colours = await rows.locator('input[type="color"]').evaluateAll((els) => els.map((e) => e.value));
      let best = 0;
      colours.forEach((h, k) => {
        const c = [1, 3, 5].map((o) => parseInt(h.slice(o, o + 2), 16));
        const b = [1, 3, 5].map((o) => parseInt(colours[best].slice(o, o + 2), 16));
        if (dist(c, rgb) < dist(b, rgb)) best = k;
      });
      const btn = rows.nth(best).locator('button[aria-label$="satin edge"]');
      if ((await btn.getAttribute("aria-pressed")) !== "true") {
        await btn.click();
        await settle();
      }
    };
    for (const [id, label] of PAGE_PRESETS) {
      await pane("Style");
      await p.locator(".dz-presets button", { hasText: label }).first().click();
      await settle();
      // the showcase's edits, made in the Colours tab: the sew order, and a satin edge
      // in the disc's own yellow (not where the preset already outlines the design)
      await pane("Colours");
      await wait(p, 300);
      if (COLOURS[id]) {
        // the Colours slider (it commits on key-up)
        await p.evaluate((k) => {
          const el = document.querySelector(".dz-side input[type=range]");
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, String(k));
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
        }, COLOURS[id]);
        await settle();
      }
      await clearEdits();
      if (!["patch", "cartoon"].includes(id)) await satinEdge(DISC);
      await sewOrder();
      await wait(p, 1200);
      png = join(tmp, `digitize-${id}.png`);
      await box.screenshot({ path: png });
      // the square around the hoop (the preview box is wider than the hoop: no grey bars),
      // shown at most ~520 css px wide on the page: 1000 px is enough for 2x screens
      const [bw, bh] = execFileSync("magick", ["identify", "-format", "%w %h", png]).toString().split(" ").map(Number);
      const side = Math.min(bw, bh);
      execFileSync("magick", [png, "-gravity", "center", "-crop", `${side}x${side}+0+0`, "+repage", "-resize", "1000x1000", "-quality", "82", "-define", "webp:method=6", join(OUT, `digitize-${id}.webp`)]);
      const t = (await p.locator(".dz-stats").innerText()).replace(/\s+/g, " ");
      const n = (re) => +(t.match(re)?.[1] ?? "0").replace(/,/g, "");
      stats[id] = { objects: n(/(\d+) objects/), fills: n(/(\d+) fills/), satins: n(/(\d+) satins/), running: n(/(\d+) running/), threads: n(/(\d+) threads/), stitches: n(/([\d,]+) stitches/), time: t.match(/([\d:]+) min/)?.[1] ?? "" };
    }
    writeFileSync(resolve(HERE, "..", "public", "data", "digitize.json"), JSON.stringify(stats, null, 1) + "\n");
    console.log(stats);
  },
  async lettering(p) {
    await p.evaluate(async () => {
      const m = await import("/src/store.ts");
      m.useStore.getState().setDoc(m.emptyDoc());
    });
    await run(p, `s.setViewMode("realistic"); s.setTool("text")`);
    const b = await p.locator(".canvas-wrap").boundingBox();
    const cx = b.x + b.width / 2, cy = b.y + b.height / 2 - 150; // above the "Start a design" cards
    await p.mouse.move(cx, cy);
    for (let i = 0; i < 2; i++) {
      await p.mouse.wheel(0, -240);
      await wait(p, 200);
    }
    await p.mouse.click(cx, cy);
    await wait(p, 1200); // the text box must have focus, or "S" picks the Satin tool
    // centred on the click: the text grows from there both ways
    const clip = { x: cx - 400, y: cy - 150, width: 800, height: 230 };
    const dir = mkdtempSync(join(tmp, "lt-"));
    let f = 0;
    const shot = async (times) => {
      for (let k = 0; k < times; k++) await p.screenshot({ path: join(dir, `f${String(f++).padStart(4, "0")}.png`), clip });
    };
    for (const ch of "Filum") {
      await p.keyboard.type(ch);
      await waitPlan(p);
      await wait(p, 120);
      await shot(5);
    }
    await p.keyboard.press("Escape");
    await waitPlan(p);
    await wait(p, 400);
    await run(p, "s.select([])");
    await wait(p, 300);
    await shot(45);
    encode(dir, "lettering", 15);
    webp(join(dir, `f${String(f - 1).padStart(4, "0")}.png`), "lettering-poster");
  },
  async export(p) {
    await run(p, `s.setDialog("export")`);
    await wait(p, 1800);
    const png = join(tmp, "export.png");
    await p.locator(".dialog").first().screenshot({ path: png });
    webp(png, "export");
  },
  async threads(p) {
    await run(p, `s.setDialog("threads")`);
    await wait(p, 1800);
    const png = join(tmp, "threads.png");
    await p.locator(".dialog").first().screenshot({ path: png });
    webp(png, "threads");
  },
};

const tmp = mkdtempSync(join(tmpdir(), "filum-capture-"));
// the page uses the digitizer's stitched result; the other captures are kept for reference
const names = process.argv.slice(2).length ? process.argv.slice(2) : ["digitize"];
const browser = await chromium.launch();
for (const name of names) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 940 }, deviceScaleFactor: DSF, locale: "en-US" });
  const p = await ctx.newPage();
  const errors = [];
  p.on("pageerror", (e) => errors.push(e.message));
  await p.goto(APP, { waitUntil: "networkidle" });
  await waitPlan(p);
  await wait(p, 600);
  try {
    await DEMOS[name](p);
  } catch (e) {
    errors.push(e.message.split("\n")[0]);
  }
  console.log(errors.length ? `${name}: ${errors.join(" | ")}` : `${name}: ok`);
  await ctx.close();
}
await browser.close();
rmSync(tmp, { recursive: true, force: true });
