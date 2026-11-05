// The digitizer demo: presets, a colour-count slider and the Original /
// Regions / Stitches preview. Regions are computed live in the browser (the
// background left out, k-means in Lab on the rest, as the digitizer does);
// Stitches is the real result of each preset, captured from Filum with its
// stats (scripts/capture.mjs → public/demos/digitize-<preset>.webp, data/digitize.json).

import { hexToRgb, lab } from "./colour";
import { icon } from "./icons";

// [id, label, icon, the colours of the showcase result (the preset's, or one more where it
// needs it: scripts/capture.mjs), hint]
const PRESETS: [string, string, string, number, string][] = [
  ["logo", "Logo", "stitch-fill", 7, "Crisp shapes, satin for strokes"],
  ["illustration", "Illustration", "image", 10, "More colours, finer detail"],
  ["lineart", "Line art", "pen", 3, "Few colours, satin and running lines"],
  ["patch", "Patch", "patch-border", 7, "Bold fills with a satin border"],
  ["cartoon", "Cartoon", "sparkle", 8, "Flat colours, dark outlines on every edge"],
  ["pixel", "Pixel art", "stitch-cross", 16, "Sprites and icons, depixelized"],
];
// the edits made in the dialog's Colours tab for the showcase (scripts/capture.mjs)
const EDITS: Record<string, string> = {
  logo: "7 colours, sew order and a satin edge set",
  illustration: "sew order and a satin edge set",
  lineart: "sew order and a satin edge set",
  pixel: "sew order and a satin edge set",
  patch: "7 colours, sew order set",
  cartoon: "sew order set",
};
interface Result {
  objects: number;
  fills: number;
  satins: number;
  running: number;
  threads: number;
  stitches: number;
  time: string;
}

type Tab = "original" | "regions" | "stitches";

/** Distance (ΔE76) from Lab colour p to the segment between a and b, for points inside it. */
function segDist(p: number[], a: number[], b: number[]) {
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const len = ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2 || 1;
  const t = ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1] + (p[2] - a[2]) * ab[2]) / len;
  if (t < 0.15 || t > 0.85) return Infinity; // near an end: a shade of that colour, not a blend
  return Math.hypot(p[0] - a[0] - t * ab[0], p[1] - a[1] - t * ab[1], p[2] - a[2] - t * ab[2]);
}

export function initDigitize(root: HTMLElement) {
  const list = root.querySelector<HTMLElement>("[data-presets]")!;
  const slider = root.querySelector<HTMLInputElement>("[data-colours]")!;
  const out = root.querySelector<HTMLElement>("[data-colours-out]")!;
  const canvas = root.querySelector<HTMLCanvasElement>("canvas")!;
  const after = root.querySelector<HTMLImageElement>("[data-after]")!;
  const chips = root.querySelector<HTMLElement>("[data-palette]")!;
  const stats = root.querySelector<HTMLElement>("[data-stats]")!;
  const tabs = [...root.querySelectorAll<HTMLButtonElement>("[data-tab]")];
  const stage = root.querySelector<HTMLElement>(".dz-stage")!;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  let tab: Tab = "original";
  // the demo opens on Pixel art: its result is the showcase's preview
  const START = PRESETS.findIndex(([id]) => id === "pixel");
  let preset = START;

  const results = fetch("./data/digitize.json").then((r) => r.json() as Promise<Record<string, Result>>);
  list.innerHTML = PRESETS.map(
    ([, name, ic, , hint], i) => `<button type="button" class="preset" data-i="${i}" aria-pressed="${i === START}" title="${hint}">${icon(ic)}<span>${name}</span></button>`,
  ).join("");

  // the source picture, downsampled for the live colour reduction
  const img = new Image();
  img.src = "./data/cactus.svg";
  const N = 300;
  let px: Uint8ClampedArray | null = null;
  const ready = img.decode().then(() => {
    canvas.width = canvas.height = N;
    ctx.drawImage(img, 0, 0, N, N);
    px = ctx.getImageData(0, 0, N, N).data;
  });

  /** The background (the colour of the picture's corner, and anything close to it)
   * is left out, as the digitizer does; the rest is reduced to k thread colours by
   * k-means in Lab with a farthest-point start. Draws the regions with their edges. */
  function reduce(k: number): string[] {
    const n = N * N;
    const L = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const h = "#" + [0, 1, 2].map((c) => px![i * 4 + c].toString(16).padStart(2, "0")).join("");
      const [l, a, b] = lab(h);
      L[i * 3] = l;
      L[i * 3 + 1] = a;
      L[i * 3 + 2] = b;
    }
    const d2 = (i: number, c: number[]) => (L[i * 3] - c[0]) ** 2 + (L[i * 3 + 1] - c[1]) ** 2 + (L[i * 3 + 2] - c[2]) ** 2;
    const bgc = [L[0], L[1], L[2]];
    const bg = new Uint8Array(n);
    for (let i = 0; i < n; i++) bg[i] = d2(i, bgc) < 36 ? 1 : 0; // within ~6 ΔE of the corner
    let first = 0;
    while (bg[first]) first++;
    const centers: number[][] = [[L[first * 3], L[first * 3 + 1], L[first * 3 + 2]]];
    while (centers.length < k) {
      let best = 0, bd = -1;
      for (let i = 0; i < n; i += 7) {
        if (bg[i]) continue;
        const d = Math.min(...centers.map((c) => d2(i, c)));
        if (d > bd) [bd, best] = [d, i];
      }
      if (bd <= 0) break; // fewer colours in the picture than asked for
      centers.push([L[best * 3], L[best * 3 + 1], L[best * 3 + 2]]);
    }
    const label = new Uint8Array(n);
    for (let it = 0; it < 8; it++) {
      const sum = centers.map(() => [0, 0, 0, 0]);
      for (let i = 0; i < n; i++) {
        if (bg[i]) continue;
        let bi = 0, bd = Infinity;
        for (let c = 0; c < centers.length; c++) {
          const d = d2(i, centers[c]);
          if (d < bd) [bd, bi] = [d, c];
        }
        label[i] = bi;
        const s = sum[bi];
        s[0] += L[i * 3];
        s[1] += L[i * 3 + 1];
        s[2] += L[i * 3 + 2];
        s[3]++;
      }
      sum.forEach((s, c) => s[3] && (centers[c] = [s[0] / s[3], s[1] / s[3], s[2] / s[3]]));
      // a small cluster whose colour is a blend of two others (or of one and the
      // background) is the anti-aliased ring along an edge, not a thread colour:
      // drop it and let its pixels join their nearest real colour
      if (it >= 3) {
        const fg = sum.reduce((a, s) => a + s[3], 0);
        for (let c = centers.length - 1; c >= 0 && centers.length > 1; c--) {
          if (sum[c][3] > fg * 0.05) continue;
          const others = [bgc, ...centers.filter((_, j) => j !== c)];
          let blend = false;
          for (let a = 0; a < others.length && !blend; a++)
            for (let b = a + 1; b < others.length && !blend; b++) blend = segDist(centers[c], others[a], others[b]) < 5;
          if (blend) centers.splice(c, 1);
        }
      }
    }
    for (let i = 0; i < n; i++) {
      if (bg[i]) continue;
      let bi = 0, bd = Infinity;
      for (let c = 0; c < centers.length; c++) {
        const d = d2(i, centers[c]);
        if (d < bd) [bd, bi] = [d, c];
      }
      label[i] = bi;
    }
    // each region in the mean sRGB colour of its pixels
    const rgb = centers.map(() => [0, 0, 0, 0]);
    for (let i = 0; i < n; i++) {
      if (bg[i]) continue;
      const s = rgb[label[i]];
      s[0] += px![i * 4];
      s[1] += px![i * 4 + 1];
      s[2] += px![i * 4 + 2];
      s[3]++;
    }
    const hex = rgb.map((s) => "#" + s.slice(0, 3).map((v) => Math.round(v / Math.max(1, s[3])).toString(16).padStart(2, "0")).join(""));
    const outImg = ctx.createImageData(N, N);
    for (let i = 0; i < n; i++) {
      if (bg[i]) continue; // left out: the stage's checkerboard shows through
      const x = i % N, y = (i / N) | 0;
      // a darker line where two regions meet: the shapes the digitizer will trace
      const edge = (x > 0 && !bg[i - 1] && label[i - 1] !== label[i]) || (y > 0 && !bg[i - N] && label[i - N] !== label[i]);
      const [r, g, b] = hexToRgb(hex[label[i]]);
      const f = edge ? 0.62 : 1;
      outImg.data.set([r * f, g * f, b * f, 255], i * 4);
    }
    ctx.putImageData(outImg, 0, 0);
    return hex.filter((_, c) => rgb[c][3] > n * 0.002);
  }

  let pending = 0;
  const custom = () => +slider.value !== PRESETS[preset][3];
  async function update() {
    await ready;
    const k = +slider.value;
    out.textContent = String(k);
    slider.style.setProperty("--p", `${((k - 2) / (16 - 2)) * 100}%`);
    if (tab === "original") {
      ctx.drawImage(img, 0, 0, N, N);
      chips.innerHTML = "";
      stats.innerHTML = `<b>cactus.png</b> · 800 × 800 px · drop your own picture in the app`;
    } else if (tab === "regions") {
      clearTimeout(pending);
      pending = window.setTimeout(() => {
        const colours = reduce(k);
        chips.innerHTML = colours.map((c) => `<i class="sw" style="--c:${c}" title="${c}"></i>`).join("");
        stats.innerHTML = `<b>${colours.length}</b> thread colours · white background left out`;
      }, 30);
    } else {
      const [id, name, , n] = PRESETS[preset];
      after.src = `./demos/digitize-${id}.webp`;
      after.alt = `The cactus digitized with the ${name} preset, in the realistic preview`;
      chips.innerHTML = "";
      const r = (await results)[id];
      if (tab !== "stitches" || PRESETS[preset][0] !== id) return;
      const kinds = [[r.fills, "fill"], [r.satins, "satin"], [r.running, "running"]].filter(([c]) => c).map(([c, w]) => `${c} ${w}${c === 1 ? "" : "s"}`);
      stats.innerHTML =
        `<b>${r.objects}</b> objects (${kinds.join(", ")}) · <b>${r.threads}</b> threads · <b>${r.stitches.toLocaleString("en-US")}</b> stitches · <b>${r.time}</b> min` +
        (custom() ? ` <span class="muted">· ${name} at its ${n} colours — the app re-stitches at any setting</span>` : ` <span class="muted">· ${name}${EDITS[id] ? ` · ${EDITS[id]}` : ""}</span>`);
    }
  }

  function setTab(t: Tab) {
    tab = t;
    for (const b of tabs) b.setAttribute("aria-selected", String(b.dataset.tab === t));
    stage.dataset.tab = t;
    if (t === "stitches") {
      stage.classList.remove("scan");
      void stage.offsetWidth;
      stage.classList.add("scan");
    }
    update();
  }

  function setPreset(i: number) {
    preset = i;
    for (const b of list.querySelectorAll<HTMLButtonElement>(".preset")) b.setAttribute("aria-pressed", String(+b.dataset.i! === i));
    slider.value = String(PRESETS[i][3]);
    if (tab === "original") setTab("regions");
    else if (tab === "stitches") setTab("stitches"); // replay the reveal with the new result
    else update();
  }

  list.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>(".preset");
    if (b) setPreset(+b.dataset.i!);
  });
  slider.addEventListener("input", () => (tab === "original" ? setTab("regions") : update()));
  for (const b of tabs) b.addEventListener("click", () => setTab(b.dataset.tab as Tab));
  after.loading = "lazy";
  // warm the cache for the other presets once the demo is in use
  root.addEventListener("pointerenter", () => PRESETS.forEach(([id]) => (new Image().src = `./demos/digitize-${id}.webp`)), { once: true });
  update();

  /** The guide's "Show me": a preset, the regions, then the stitches. */
  return {
    async run() {
      setPreset(START);
      await new Promise((r) => setTimeout(r, 1300));
      setTab("stitches");
    },
  };
}
