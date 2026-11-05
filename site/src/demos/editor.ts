// The editor demo: a dummy Filum window drawing the sample design from its
// real shapes and stitch plan (public/data/badge.json, scripts/export-badge.mjs)
// in the Vector, Stitch and Realistic views, with layers to pick, a
// properties panel and a stitch-out to play and scrub.

import { luminance, shade } from "./colour";
import { icon } from "./icons";

export interface Badge {
  name: string;
  hoop: { w: number; h: number };
  threads: { id: string; name: string; color: string }[];
  objects: { name: string; type: string; method: string | null; thread: number; width: number | null; d: string }[];
  blocks: { thread: number; runs: number[][]; stitches: number }[];
  stats: { stitches: number; colours: number; seconds: number; width: number; height: number; threadM: number; trims: number };
}

type View = "vector" | "stitch" | "realistic";
const METHOD: Record<string, string> = { tatami: "Tatami fill", radial: "Sunburst fill", spiral: "Spiral fill" };
const typeLabel = (o: Badge["objects"][number]) => (o.type === "fill" ? METHOD[o.method ?? ""] ?? "Fill" : o.type === "satin" ? "Satin column" : "Running stitch");
const typeIcon = (o: Badge["objects"][number]) => (o.type === "satin" ? "stitch-satin" : o.type === "running" ? "stitch-running" : o.method === "radial" ? "stitch-radial" : o.method === "spiral" ? "stitch-spiral" : "stitch-fill");
const fmt = (n: number) => n.toLocaleString("en-US");
const mins = (s: number) => `${Math.max(1, Math.round(s / 60))} min`;

let badgeP: Promise<Badge> | null = null;
export const loadBadge = () => (badgeP ??= fetch("./data/badge.json").then((r) => r.json() as Promise<Badge>));

export interface Editor {
  setView(v: View): void;
  play(fromStart?: boolean): void;
  select(i: number | null): void;
  readonly playing: boolean;
}

export async function initEditor(root: HTMLElement): Promise<Editor> {
  const data = await loadBadge();
  const canvas = root.querySelector<HTMLCanvasElement>("canvas")!;
  const ctx = canvas.getContext("2d")!;
  const layer = document.createElement("canvas"); // the sewn stitches, drawn incrementally
  const lctx = layer.getContext("2d")!;
  const layersEl = root.querySelector<HTMLElement>("[data-layers]")!;
  const propsEl = root.querySelector<HTMLElement>("[data-props]")!;
  const scrub = root.querySelector<HTMLInputElement>("[data-scrub]")!;
  const countEl = root.querySelector<HTMLElement>("[data-count]")!;
  const playBtn = root.querySelector<HTMLButtonElement>("[data-play]")!;
  const viewBtns = [...root.querySelectorAll<HTMLButtonElement>("[data-view]")];

  // the stitch plan as flat arrays in sew order
  const total = data.blocks.reduce((n, b) => n + b.runs.reduce((m, r) => m + r.length / 2, 0), 0);
  const xs = new Float32Array(total), ys = new Float32Array(total);
  const blockOf = new Uint8Array(total), starts = new Uint8Array(total);
  let k = 0;
  data.blocks.forEach((b, bi) =>
    b.runs.forEach((run) => {
      for (let i = 0; i < run.length; i += 2) {
        xs[k] = run[i] / 10;
        ys[k] = run[i + 1] / 10;
        blockOf[k] = bi;
        starts[k] = i === 0 ? 1 : 0;
        k++;
      }
    }),
  );
  const color = (bi: number) => data.threads[data.blocks[bi].thread]?.color ?? "#888";
  const bbox = data.blocks.map((_, bi) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < total; i++)
      if (blockOf[i] === bi) {
        x0 = Math.min(x0, xs[i]); y0 = Math.min(y0, ys[i]);
        x1 = Math.max(x1, xs[i]); y1 = Math.max(y1, ys[i]);
      }
    return [x0, y0, x1, y1];
  });
  const paths = data.objects.map((o) => new Path2D(o.d));
  /** A satin given by two rails (two subpaths) is the column between them, as the app draws it. */
  const railSatin = (o: Badge["objects"][number]) => o.type === "satin" && (o.d.match(/M/g) ?? []).length === 2;
  /** Objects drawn as areas (fills, two-rail satins) rather than as lines. */
  const isArea = (o: Badge["objects"][number]) => o.type === "fill" || railSatin(o);

  let view: View = "vector";
  let shown = total; // stitches sewn so far
  let drawn = 0; // stitches already on the canvas (for incremental drawing)
  let selected: number | null = null;
  let playing = false;
  let raf = 0;

  // ---- canvas geometry
  const M = 8; // mm of margin around the hoop
  let scale = 1, dpr = 1;
  function resize() {
    const r = canvas.getBoundingClientRect();
    dpr = Math.min(2, devicePixelRatio || 1);
    layer.width = canvas.width = Math.round(r.width * dpr);
    layer.height = canvas.height = Math.round(r.height * dpr);
    scale = Math.min(r.width, r.height) / (data.hoop.w + 2 * M);
    invalidate();
  }
  const toMm = (g: CanvasRenderingContext2D = ctx) => {
    const r = canvas.getBoundingClientRect();
    const ox = (r.width - (data.hoop.w + 2 * M) * scale) / 2, oy = (r.height - (data.hoop.h + 2 * M) * scale) / 2;
    g.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * (ox + M * scale), dpr * (oy + M * scale));
    return { ox, oy };
  };

  // fabric texture for the realistic view (a faint weave)
  const weave = (() => {
    const c = document.createElement("canvas");
    c.width = c.height = 8;
    const g = c.getContext("2d")!;
    g.fillStyle = "#f4efe5";
    g.fillRect(0, 0, 8, 8);
    g.fillStyle = "rgba(120, 100, 70, 0.06)";
    g.fillRect(0, 0, 8, 1);
    g.fillRect(0, 4, 8, 1);
    g.fillStyle = "rgba(255, 255, 255, 0.5)";
    g.fillRect(0, 2, 4, 1);
    g.fillRect(4, 6, 4, 1);
    return ctx.createPattern(c, "repeat")!;
  })();

  function background() {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (view === "realistic") {
      ctx.fillStyle = weave;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    } else {
      ctx.fillStyle = "#efefec";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    toMm();
    const { w, h } = data.hoop;
    if (view !== "realistic") {
      ctx.strokeStyle = "rgba(40, 40, 30, 0.07)";
      ctx.lineWidth = 0.15;
      ctx.beginPath();
      for (let x = 0; x <= w; x += 10) (ctx.moveTo(x, 0), ctx.lineTo(x, h));
      for (let y = 0; y <= h; y += 10) (ctx.moveTo(0, y), ctx.lineTo(w, y));
      ctx.stroke();
    }
    ctx.setLineDash([2, 1.4]);
    ctx.strokeStyle = view === "realistic" ? "rgba(63, 154, 110, 0.35)" : "#3f9a6e";
    ctx.lineWidth = 0.45;
    ctx.beginPath();
    ctx.roundRect(0, 0, w, h, 6);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  function vector() {
    // as the app's vector view: areas filled with a hairline outline a shade darker, a
    // single-line satin as its column width, running stitch as a line
    data.objects.forEach((o, i) => {
      const c = data.threads[o.thread]?.color ?? "#888";
      if (isArea(o)) {
        ctx.fillStyle = c;
        ctx.fill(paths[i], "evenodd");
        ctx.strokeStyle = shade(c, -0.35);
        ctx.lineWidth = 0.2;
        ctx.stroke(paths[i]);
      } else {
        ctx.strokeStyle = c;
        ctx.lineWidth = o.type === "satin" ? o.width ?? 3 : 0.55;
        ctx.lineCap = ctx.lineJoin = "round";
        ctx.stroke(paths[i]);
      }
    });
  }

  /** Stitches [a, b) in the stitch or realistic look. */
  function stitches(a: number, b: number) {
    const ctx = lctx;
    toMm(lctx);
    const real = view === "realistic";
    let i = Math.max(1, a);
    while (i < b) {
      const bi = blockOf[i];
      const j0 = i;
      while (i < b && blockOf[i] === bi) i++;
      const c = color(bi);
      const p = new Path2D();
      for (let j = j0; j < i; j++) {
        if (starts[j]) continue;
        const x0 = xs[j - 1], y0 = ys[j - 1], x1 = xs[j], y1 = ys[j];
        if (real) {
          // a little gap at each needle point, so stitches read as stitches
          const dx = x1 - x0, dy = y1 - y0, l = Math.hypot(dx, dy) || 1, g = Math.min(0.08, l * 0.12);
          p.moveTo(x0 + (dx / l) * g, y0 + (dy / l) * g);
          p.lineTo(x1 - (dx / l) * g, y1 - (dy / l) * g);
        } else {
          p.moveTo(x0, y0);
          p.lineTo(x1, y1);
        }
      }
      ctx.lineCap = "round";
      if (real) {
        ctx.strokeStyle = shade(c, -0.35);
        ctx.lineWidth = 0.46;
        ctx.stroke(p);
        ctx.strokeStyle = c;
        ctx.lineWidth = 0.3;
        ctx.stroke(p);
        ctx.save();
        ctx.translate(-0.05, -0.06);
        ctx.strokeStyle = shade(c, 0.45);
        ctx.lineWidth = 0.08;
        ctx.globalAlpha = 0.8;
        ctx.stroke(p);
        ctx.restore();
      } else {
        if (luminance(c) > 0.85) {
          ctx.strokeStyle = "rgba(0, 0, 0, 0.28)";
          ctx.lineWidth = 0.3;
          ctx.stroke(p);
        }
        ctx.strokeStyle = c;
        ctx.lineWidth = 0.16;
        ctx.stroke(p);
      }
    }
  }

  function selection() {
    if (selected === null) return;
    const [x0, y0, x1, y1] = bbox[selected];
    const pad = 1.2;
    ctx.strokeStyle = "#7c3aed";
    ctx.lineWidth = 0.35;
    ctx.setLineDash([1.2, 0.9]);
    ctx.strokeRect(x0 - pad, y0 - pad, x1 - x0 + 2 * pad, y1 - y0 + 2 * pad);
    ctx.setLineDash([]);
    ctx.fillStyle = "#fff";
    for (const [x, y] of [[x0 - pad, y0 - pad], [x1 + pad, y0 - pad], [x0 - pad, y1 + pad], [x1 + pad, y1 + pad]]) {
      ctx.beginPath();
      ctx.rect(x - 0.9, y - 0.9, 1.8, 1.8);
      ctx.fill();
      ctx.stroke();
    }
  }

  /** Redraw the sewn stitches from the start (view, visibility or size changed). */
  function invalidate() {
    lctx.setTransform(1, 0, 0, 1, 0, 0);
    lctx.clearRect(0, 0, layer.width, layer.height);
    drawn = 0;
    redraw();
  }
  function redraw() {
    background();
    if (view === "vector") vector();
    else {
      if (shown < drawn) {
        lctx.setTransform(1, 0, 0, 1, 0, 0);
        lctx.clearRect(0, 0, layer.width, layer.height);
        drawn = 0;
      }
      if (shown > drawn) stitches(drawn, shown);
      drawn = shown;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(layer, 0, 0);
      toMm();
    }
    selection();
    if (view !== "vector" && shown < total && shown > 0) needle();
  }
  /** The needle at the newest stitch while sewing. */
  function needle() {
    const i = Math.max(0, shown - 1);
    ctx.fillStyle = "rgba(124, 58, 237, 0.16)";
    ctx.beginPath();
    ctx.arc(xs[i], ys[i], 2.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#7c3aed";
    ctx.beginPath();
    ctx.arc(xs[i], ys[i], 0.8, 0, Math.PI * 2);
    ctx.fill();
  }

  // ---- panels
  layersEl.innerHTML = data.objects
    .map((o, i) => ({ o, i }))
    .reverse()
    .map(
      ({ o, i }) => `<li class="layer" data-i="${i}" role="option" aria-selected="false" tabindex="-1">
        <i class="sw" style="--c:${data.threads[o.thread]?.color}"></i>
        <span class="lname">${o.name}</span>
        <span class="ltype" title="${typeLabel(o)}">${icon(typeIcon(o))}</span>
      </li>`,
    )
    .join("");

  function props() {
    const s = data.stats;
    if (selected === null) {
      propsEl.innerHTML = `
        <h5>Design</h5>
        <dl>
          <dt>Hoop</dt><dd>${data.hoop.w} × ${data.hoop.h} mm</dd>
          <dt>Size</dt><dd>${s.width.toFixed(0)} × ${s.height.toFixed(0)} mm</dd>
          <dt>Fabric</dt><dd>Cotton</dd>
          <dt>Stitches</dt><dd>${fmt(s.stitches)}</dd>
          <dt>Colours</dt><dd>${data.blocks.length}</dd>
          <dt>Thread</dt><dd>${s.threadM.toFixed(0)} m</dd>
          <dt>Run time</dt><dd>${mins(s.seconds)}</dd>
        </dl>
        <p class="hint">Click a shape or a layer.</p>`;
      return;
    }
    const o = data.objects[selected];
    const t = data.threads[o.thread];
    propsEl.innerHTML = `
      <h5>${o.name}</h5>
      <div class="pchip">${icon(typeIcon(o))} ${typeLabel(o)}</div>
      <dl>
        <dt>Thread</dt><dd><i class="sw" style="--c:${t.color}"></i> ${t.name}</dd>
        <dt>Stitches</dt><dd>${fmt(data.blocks[selected].stitches)}</dd>
        ${o.type === "fill" ? `<dt>Spacing</dt><dd>0.40 mm</dd><dt>Underlay</dt><dd>Auto</dd>` : ""}
        ${o.type === "satin" ? `<dt>Width</dt><dd>${(o.width ?? 3).toFixed(1)} mm</dd><dt>Underlay</dt><dd>Centre walk</dd>` : ""}
        ${o.type === "running" ? `<dt>Length</dt><dd>2.5 mm</dd>` : ""}
        <dt>Sewn</dt><dd>${selected + 1} of ${data.objects.length}</dd>
      </dl>`;
  }

  function select(i: number | null) {
    selected = i;
    for (const li of layersEl.querySelectorAll<HTMLElement>(".layer")) li.setAttribute("aria-selected", String(+li.dataset.i! === i));
    props();
    redraw();
  }

  function setView(v: View) {
    view = v;
    for (const b of viewBtns) b.setAttribute("aria-selected", String(b.dataset.view === v));
    invalidate();
  }

  function counter() {
    const s = data.stats;
    countEl.textContent = `${fmt(Math.round((shown / total) * s.stitches))} / ${fmt(s.stitches)} stitches · ${mins((shown / total) * s.seconds)}`;
    scrub.value = String(shown);
    scrub.style.setProperty("--p", `${(shown / total) * 100}%`);
  }

  function setShown(n: number) {
    shown = Math.max(0, Math.min(total, Math.round(n)));
    redraw(); // only the stitches since the last frame are drawn
    counter();
  }

  function stop() {
    playing = false;
    cancelAnimationFrame(raf);
    playBtn.innerHTML = `${icon("play")}<span>Animate</span>`;
    root.classList.remove("playing");
  }
  function play(fromStart = false) {
    if (playing) return stop();
    if (view === "vector") setView("realistic");
    if (fromStart || shown >= total) setShown(0);
    playing = true;
    root.classList.add("playing");
    playBtn.innerHTML = `${icon("pause")}<span>Pause</span>`;
    let last = performance.now();
    const rate = total / 9; // the whole design in about nine seconds
    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      setShown(shown + rate * dt * (shown / total < 0.08 ? 0.6 : 1));
      if (shown >= total) return stop();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
  }

  // ---- events
  for (const b of viewBtns) b.addEventListener("click", () => setView(b.dataset.view as View));
  playBtn.addEventListener("click", () => play());
  scrub.max = String(total);
  scrub.addEventListener("input", () => {
    stop();
    if (view === "vector") setView("stitch");
    setShown(+scrub.value);
  });
  layersEl.addEventListener("click", (e) => {
    const li = (e.target as HTMLElement).closest<HTMLElement>(".layer");
    if (li) select(+li.dataset.i! === selected ? null : +li.dataset.i!);
  });
  canvas.addEventListener("click", (e) => {
    const r = canvas.getBoundingClientRect();
    const { ox, oy } = toMm();
    const x = (e.clientX - r.left - ox) / scale - M, y = (e.clientY - r.top - oy) / scale - M;
    let hit: number | null = null;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    for (let i = data.objects.length - 1; i >= 0; i--) {
      const o = data.objects[i];
      ctx.lineWidth = o.type === "satin" ? o.width ?? 3 : 2;
      if (isArea(o) ? ctx.isPointInPath(paths[i], x, y, "evenodd") : ctx.isPointInStroke(paths[i], x, y)) {
        hit = i;
        break;
      }
    }
    select(hit);
  });
  new ResizeObserver(resize).observe(canvas);
  resize();
  props();
  counter();
  playBtn.innerHTML = `${icon("play")}<span>Animate</span>`;

  return {
    setView,
    play,
    select,
    get playing() {
      return playing;
    },
  };
}
