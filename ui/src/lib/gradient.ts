// Multi-colour gradient fills. A gradient is a group of fill objects, one per
// colour stop, with the same shape, angle and stitch grid (see
// crates/core/src/stitches/gradient.rs). This module creates and edits those
// layer groups and mirrors the core's weights / dithers for UI previews.

import { useStore } from "../store";
import type { DesignObject, DitherMethod, FillParams, FreePoint, GradientKind, GradientMesh, GradientParams, GradientStop, StitchDocument, SubPath, TransitionCurve, Vec2 } from "../types";
import { defaultFill, normAngle, objectBounds, uid, unionBoxes, type Box } from "./geometry";

const store = () => useStore.getState();

export type GradientFill = FillParams & { gradient: GradientParams };

export const isGradientLayer = (o: DesignObject): o is DesignObject & { stitch: { type: "fill" } & GradientFill } =>
  o.stitch.type === "fill" && !!o.stitch.gradient;

/** Layers of a gradient group, in stop order. */
export function gradientLayers(doc: StitchDocument, group: string): DesignObject[] {
  return doc.objects
    .filter((o) => o.stitch.type === "fill" && o.stitch.gradient?.group === group)
    .sort((a, b) => (a.stitch as GradientFill).gradient.layer - (b.stitch as GradientFill).gradient.layer);
}

/** The gradient of the selection (any selected layer), if there is one. */
export function selectedGradient(): { group: string; params: GradientParams; layers: DesignObject[] } | null {
  const s = store();
  const o = s.doc.objects.find((x) => s.selection.includes(x.id) && isGradientLayer(x));
  if (!o || o.stitch.type !== "fill" || !o.stitch.gradient) return null;
  const group = o.stitch.gradient.group;
  const layers = gradientLayers(s.doc, group);
  return { group, params: (layers[0].stitch as GradientFill).gradient, layers };
}

/** Rows perpendicular to the gradient direction (fewest splits). */
export function rowAngleFor(from: Vec2, to: Vec2): number {
  const phi = (Math.atan2(to[1] - from[1], to[0] - from[0]) * 180) / Math.PI;
  return normAngle(-(phi + 90));
}

const hasClosed = (o: DesignObject) => o.paths.some((p) => p.closed && p.nodes.length >= 3);

/** The most contrasting colour of the palette (or a new contrasting one). */
function secondThread(first: string): string {
  const s = store();
  const rgb = (hex: string) => {
    const v = parseInt(hex.slice(1), 16);
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
  };
  const base = rgb(s.doc.threads.find((x) => x.id === first)?.color ?? "#1f2a56");
  let best: { id: string; d: number } | null = null;
  for (const t of s.doc.threads) {
    if (t.id === first) continue;
    const c = rgb(t.color);
    const d = Math.hypot(c[0] - base[0], c[1] - base[1], c[2] - base[2]);
    if (!best || d > best.d) best = { id: t.id, d };
  }
  if (best && best.d > 120) return best.id;
  const lum = base[0] * 0.3 + base[1] * 0.59 + base[2] * 0.11;
  return s.ensureThread(lum > 128 ? "#1f2a56" : "#f2c14e");
}

/** Turn a closed object into a two-colour gradient from `from` to `to`. */
export function makeGradient(objId: string, from: Vec2, to: Vec2, opts: Partial<GradientParams> = {}): string | null {
  const s = store();
  const o = s.doc.objects.find((x) => x.id === objId);
  if (!o || !hasClosed(o) || o.text) return null;
  const group = uid("grd");
  const kind = opts.kind ?? "linear";
  const base: GradientParams = {
    kind,
    from,
    to,
    stops: [
      { pos: 0, mid: 0.5 },
      { pos: 1, mid: 0.5 },
    ],
    curve: "linear",
    steps: 4,
    dither: kind === "linear" || kind === "reflected" ? "rows" : "diffusion",
    cell: 3,
    layer: 0,
    group,
    seed: 1,
    ...opts,
  };
  const fill: FillParams =
    // a flow fill with its direction field stays one (its layers share the streamlines)
    o.stitch.type === "fill"
      ? { ...o.stitch, method: (o.stitch.method === "flow" && o.stitch.flow) || o.stitch.method === "curved" ? o.stitch.method : "tatami" }
      : { ...defaultFill() };
  const angle = kind === "linear" || kind === "reflected" ? rowAngleFor(from, to) : fill.angle;
  const paths: SubPath[] = o.paths.filter((p) => p.closed && p.nodes.length >= 3);
  const threads = [o.thread, secondThread(o.thread)];
  const layers: DesignObject[] = threads.map((thread, layer) => ({
    ...o,
    id: layer === 0 ? o.id : uid(),
    name: `${o.name.replace(/ · colour \d+$/, "")} · colour ${layer + 1}`,
    thread,
    paths,
    group,
    start: layer === 0 ? o.start : undefined,
    end: undefined,
    stitch: { type: "fill", ...fill, angle, endRowSpacing: 0, gradient: { ...base, layer } },
  }));
  s.commit((d) => {
    const i = d.objects.findIndex((x) => x.id === o.id);
    const objects = [...d.objects];
    objects.splice(i, 1, ...layers);
    return { ...d, objects };
  });
  s.select(layers.map((l) => l.id));
  return group;
}

/** Change gradient settings shared by every layer (not the colours). */
export function updateGradient(group: string, patch: Partial<GradientParams> & { angle?: number; rowSpacing?: number }, live = false) {
  const s = store();
  const { angle, rowSpacing, ...gp } = patch;
  const fn = (d: StitchDocument) => ({
    ...d,
    objects: d.objects.map((o) =>
      o.stitch.type === "fill" && o.stitch.gradient?.group === group
        ? {
            ...o,
            stitch: {
              ...o.stitch,
              ...(angle !== undefined ? { angle } : {}),
              ...(rowSpacing !== undefined ? { rowSpacing } : {}),
              gradient: { ...o.stitch.gradient, ...gp, layer: o.stitch.gradient.layer, group },
            },
          }
        : o,
    ),
  });
  if (live) s.liveUpdate(fn);
  else s.commit(fn);
}

export interface StopEdit extends GradientStop {
  thread: string;
}

/** The stops with their colours. */
export function stopsOf(doc: StitchDocument, group: string): StopEdit[] {
  const layers = gradientLayers(doc, group);
  const g = (layers[0]?.stitch as GradientFill | undefined)?.gradient;
  if (!g) return [];
  return g.stops.map((st, i) => ({ ...st, thread: layers[i]?.thread ?? layers[0].thread }));
}

/**
 * Replace the stops (add / remove / move / recolour). Layers are reused by
 * index; new ones are copies of the first layer.
 */
export function setStops(group: string, stops: StopEdit[], live = false, extra: Partial<GradientParams> = {}) {
  const s = store();
  const fn = (d: StitchDocument) => {
    const layers = gradientLayers(d, group);
    if (!layers.length || stops.length < 1) return d;
    const first = layers[0];
    const g0 = (first.stitch as GradientFill).gradient;
    const gs: GradientStop[] = stops.map(({ pos, mid }) => ({ pos: Math.min(1, Math.max(0, pos)), mid }));
    const next: DesignObject[] = stops.map((st, i) => {
      const src = layers[i] ?? first;
      return {
        ...src,
        id: layers[i] ? src.id : uid(),
        name: `${first.name.replace(/ · colour \d+$/, "")} · colour ${i + 1}`,
        thread: st.thread,
        start: i === 0 ? first.start : undefined,
        end: undefined,
        group: first.group ?? group,
        stitch: { ...(src.stitch as GradientFill), type: "fill", gradient: { ...g0, ...extra, stops: gs, layer: i } },
      } as DesignObject;
    });
    const ids = new Set(layers.map((l) => l.id));
    const at = d.objects.findIndex((o) => ids.has(o.id));
    const rest = d.objects.filter((o) => !ids.has(o.id));
    const objects = [...rest.slice(0, at), ...next, ...rest.slice(at)];
    return { ...d, objects };
  };
  if (live) s.liveUpdate(fn);
  else s.commit(fn);
}

/** Back to a plain fill (keeps the first colour). */
export function removeGradient(group: string) {
  const s = store();
  s.commit((d) => {
    const layers = gradientLayers(d, group);
    if (!layers.length) return d;
    const keep = layers[0];
    const ids = new Set(layers.slice(1).map((l) => l.id));
    const { gradient: _g, ...fill } = keep.stitch as GradientFill;
    void _g;
    return {
      ...d,
      objects: d.objects
        .filter((o) => !ids.has(o.id))
        .map((o) => (o.id === keep.id ? { ...o, group: undefined, name: o.name.replace(/ · colour \d+$/, ""), stitch: { ...fill, type: "fill" } } : o)),
    };
  });
}

/** After one layer's geometry changed, give every layer of its gradient the same paths. */
export function syncGradientGeometry(d: StitchDocument, changed: DesignObject): StitchDocument {
  if (changed.stitch.type !== "fill" || !changed.stitch.gradient) return d;
  const group = changed.stitch.gradient.group;
  return {
    ...d,
    objects: d.objects.map((o) => (o.id !== changed.id && o.stitch.type === "fill" && o.stitch.gradient?.group === group ? { ...o, paths: changed.paths } : o)),
  };
}

/** Default gradient vector across an object (left → right through its middle). */
export function defaultVector(objs: DesignObject[]): [Vec2, Vec2] {
  const b = unionBoxes(objs.map(objectBounds)) ?? { x: 0, y: 0, w: 10, h: 10 };
  return [
    [b.x, b.y + b.h / 2],
    [b.x + b.w, b.y + b.h / 2],
  ];
}

// ---------------------------------------------------------------------------
// Preview mirrors of the core maths (crates/core/src/stitches/gradient.rs)

function ease(curve: TransitionCurve, steps: number, u: number): number {
  u = Math.min(1, Math.max(0, u));
  const sm = (x: number) => x * x * (3 - 2 * x);
  switch (curve) {
    case "linear":
      return u;
    case "smooth":
      return sm(u);
    case "easeIn":
      return u * u;
    case "easeOut":
      return 1 - (1 - u) * (1 - u);
    case "sharp":
      return sm(sm(u));
    case "steps": {
      const n = Math.max(2, steps);
      return Math.min(n - 1, Math.floor(u * n)) / (n - 1);
    }
  }
}

export function weights(g: Pick<GradientParams, "stops" | "curve" | "steps">, t: number): number[] {
  const n = Math.max(1, g.stops.length);
  const w = new Array<number>(n).fill(0);
  if (g.stops.length < 2) {
    w[0] = 1;
    return w;
  }
  const order = g.stops.map((_, i) => i).sort((a, b) => g.stops[a].pos - g.stops[b].pos);
  const first = order[0];
  const last = order[order.length - 1];
  if (t <= g.stops[first].pos) return (w[first] = 1), w;
  if (t >= g.stops[last].pos) return (w[last] = 1), w;
  for (let k = 0; k < order.length - 1; k++) {
    const [a, b] = [order[k], order[k + 1]];
    const [pa, pb] = [g.stops[a].pos, g.stops[b].pos];
    if (t >= pa && t <= pb) {
      let u = pb - pa < 1e-9 ? 1 : (t - pa) / (pb - pa);
      const mid = Math.min(0.95, Math.max(0.05, g.stops[a].mid));
      if (Math.abs(mid - 0.5) > 1e-6) u = Math.pow(u, Math.log(0.5) / Math.log(mid));
      u = ease(g.curve, g.steps, u);
      w[a] = 1 - u;
      w[b] += u;
      return w;
    }
  }
  w[last] = 1;
  return w;
}

const BAYER = [0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26, 12, 44, 4, 36, 14, 46, 6, 38, 60, 28, 52, 20, 62, 30, 54, 22, 3, 35, 11, 43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25, 15, 47, 7, 39, 13, 45, 5, 37, 63, 31, 55, 23, 61, 29, 53, 21];
const hash = (a: number, b: number) => {
  let x = (a * 374761393 + b * 668265263) | 0;
  x = Math.imul(x ^ (x >>> 13), 1274126177);
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
};
const vdc = (n: number) => {
  let r = 0;
  let f = 0.5;
  n = ((n % 1048576) + 1048576) % 1048576;
  while (n) {
    if (n & 1) r += f;
    n >>= 1;
    f /= 2;
  }
  return r;
};
const pick = (w: number[], thr: number) => {
  let acc = 0;
  for (let k = 0; k < w.length; k++) if (thr < (acc += w[k])) return k;
  return w.length - 1;
};

/**
 * Dithered preview grid (`rows` × `cols` cells) of a horizontal gradient:
 * the stop index of every cell, as the engine would assign it.
 */
export function ditherGrid(g: Pick<GradientParams, "stops" | "curve" | "steps" | "dither">, cols: number, rows: number): Uint8Array {
  return ditherCells((c) => weights(g, (c + 0.5) / cols), Math.max(1, g.stops.length), g.dither, cols, rows);
}

/** Dithered grid of any weight field: `wAt(col, row)` gives the stop weights of a cell. */
export function ditherCells(wAt: (c: number, r: number) => number[], n: number, dither: DitherMethod, cols: number, rows: number): Uint8Array {
  const out = new Uint8Array(cols * rows);
  const g = { dither };
  if (g.dither === "diffusion" && n > 1) {
    let cur = new Float64Array(cols * n);
    let next = new Float64Array(cols * n);
    for (let r = 0; r < rows; r++) {
      const rev = r % 2 === 1;
      for (let s = 0; s < cols; s++) {
        const c = rev ? cols - 1 - s : s;
        const w = wAt(c, r);
        const v = w.map((x, k) => x + cur[c * n + k]);
        let best = 0;
        for (let k = 1; k < n; k++) if (v[k] > v[best]) best = k;
        out[r * cols + c] = best;
        const fwd = rev ? c - 1 : c + 1;
        const back = rev ? c + 1 : c - 1;
        for (let k = 0; k < n; k++) {
          const e = v[k] - (k === best ? 1 : 0);
          if (fwd >= 0 && fwd < cols) {
            cur[fwd * n + k] += (e * 7) / 16;
            next[fwd * n + k] += e / 16;
          }
          if (back >= 0 && back < cols) next[back * n + k] += (e * 3) / 16;
          next[c * n + k] += (e * 5) / 16;
        }
      }
      [cur, next] = [next, cur];
      next.fill(0);
    }
    return out;
  }
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const thr =
        g.dither === "rows" ? vdc(r) : g.dither === "ordered" ? (BAYER[(r % 8) * 8 + (c % 8)] + 0.5) / 64 : g.dither === "noise" ? hash(r, c) : 0.5;
      out[r * cols + c] = pick(wAt(c, r), thr);
    }
  return out;
}

export const DITHERS: { id: DitherMethod; label: string; title: string }[] = [
  { id: "rows", label: "Rows", title: "Whole rows interleave — smooth stripes, fewest extra stitches" },
  { id: "diffusion", label: "Diffusion", title: "Error diffusion — the most even, finest mix" },
  { id: "ordered", label: "Woven", title: "Ordered Bayer pattern — a regular woven / pixel look" },
  { id: "noise", label: "Noise", title: "Random — organic, painterly mix" },
  { id: "bands", label: "Bands", title: "No mixing — hard colour edges" },
];

export const CURVES: { id: TransitionCurve; label: string }[] = [
  { id: "linear", label: "Linear" },
  { id: "smooth", label: "Smooth" },
  { id: "easeIn", label: "Ease in" },
  { id: "easeOut", label: "Ease out" },
  { id: "sharp", label: "Sharp" },
  { id: "steps", label: "Steps" },
];

// ---------------------------------------------------------------------------
// 2D gradients: a gradient mesh (a grid of coloured nodes) and
// freeform colour points. Mirrors `weights_at` in the core.

export const is2D = (k: GradientKind) => k === "mesh" || k === "freeform";

function position(g: GradientParams, p: Vec2): number {
  const d = [g.to[0] - g.from[0], g.to[1] - g.from[1]];
  const l2 = Math.max(1e-12, d[0] * d[0] + d[1] * d[1]);
  const v = [p[0] - g.from[0], p[1] - g.from[1]];
  const along = (v[0] * d[0] + v[1] * d[1]) / l2;
  switch (g.kind) {
    case "linear":
      return along;
    case "reflected":
      return Math.abs(along);
    case "radial":
      return Math.hypot(v[0], v[1]) / Math.sqrt(l2);
    case "conic": {
      const T = Math.PI * 2;
      const a = Math.atan2(v[1], v[0]) - Math.atan2(d[1], d[0]);
      return (((a % T) + T) % T) / T;
    }
    default:
      return Math.min(1, Math.max(0, along));
  }
}

const oneHot = (n: number, k: number) => {
  const w = new Array<number>(n).fill(0);
  w[Math.min(n - 1, Math.max(0, k))] = 1;
  return w;
};

/** Sharpen / posterise a mix with the transition curve. */
function shapeMix(g: GradientParams, w: number[]) {
  if (g.curve === "linear") return;
  let sum = 0;
  for (let k = 0; k < w.length; k++) sum += w[k] = ease(g.curve, g.steps, w[k]);
  if (sum < 1e-9) {
    const best = w.reduce((b, x, i) => (x > w[b] ? i : b), 0);
    w.fill(0);
    w[best] = 1;
  } else for (let k = 0; k < w.length; k++) w[k] /= sum;
}

const cross = (a: Vec2, b: Vec2) => a[0] * b[1] - a[1] * b[0];

/** (u, v) of `p` in the quad a (0,0) → b (1,0) → c (1,1) → d (0,1). */
export function invBilinear(p: Vec2, a: Vec2, b: Vec2, c: Vec2, d: Vec2): [number, number] | null {
  const e: Vec2 = [b[0] - a[0], b[1] - a[1]];
  const f: Vec2 = [d[0] - a[0], d[1] - a[1]];
  const g: Vec2 = [a[0] - b[0] + c[0] - d[0], a[1] - b[1] + c[1] - d[1]];
  const h: Vec2 = [p[0] - a[0], p[1] - a[1]];
  const k2 = cross(g, f);
  const k1 = cross(e, f) + cross(h, g);
  const k0 = cross(h, e);
  const uOf = (v: number) => {
    const dx = e[0] + g[0] * v;
    const dy = e[1] + g[1] * v;
    if (Math.abs(dx) > Math.abs(dy)) return (h[0] - f[0] * v) / dx;
    return Math.abs(dy) > 1e-12 ? (h[1] - f[1] * v) / dy : NaN;
  };
  const scale = Math.max(e[0] * e[0] + e[1] * e[1], f[0] * f[0] + f[1] * f[1], 1e-12);
  let vs: number[];
  if (Math.abs(k2) < 1e-9 * scale) {
    if (Math.abs(k1) < 1e-12) return null;
    vs = [-k0 / k1];
  } else {
    const disc = k1 * k1 - 4 * k0 * k2;
    if (disc < 0) return null;
    const sq = Math.sqrt(disc);
    vs = [(-k1 - sq) / (2 * k2), (-k1 + sq) / (2 * k2)];
  }
  const out = (u: number, v: number) => Math.max(0, -u, u - 1, -v, v - 1);
  let best: [number, number] | null = null;
  for (const v of vs) {
    const u = uOf(v);
    if (!Number.isFinite(u) || !Number.isFinite(v)) continue;
    if (!best || out(u, v) < out(best[0], best[1])) best = [u, v];
  }
  return best;
}

const nodeAt = (m: GradientMesh, r: number, c: number) => m.nodes[r * m.cols + c];
export const meshValid = (m: GradientMesh | undefined): m is GradientMesh => !!m && m.rows >= 2 && m.cols >= 2 && m.nodes.length === m.rows * m.cols;

/** The patch under a point and its local (u, v). */
export function meshLocate(m: GradientMesh, p: Vec2): { r: number; c: number; u: number; v: number } | null {
  const eps = 1e-6;
  for (let r = 0; r < m.rows - 1; r++)
    for (let c = 0; c < m.cols - 1; c++) {
      const q = [nodeAt(m, r, c).p, nodeAt(m, r, c + 1).p, nodeAt(m, r + 1, c + 1).p, nodeAt(m, r + 1, c).p];
      if (q.every((x) => x[0] < p[0] - eps) || q.every((x) => x[0] > p[0] + eps) || q.every((x) => x[1] < p[1] - eps) || q.every((x) => x[1] > p[1] + eps)) continue;
      const uv = invBilinear(p, q[0], q[1], q[2], q[3]);
      if (!uv) continue;
      const [u, v] = uv;
      if (u < -1e-9 || u > 1 + 1e-9 || v < -1e-9 || v > 1 + 1e-9) continue;
      return { r, c, u: Math.min(1, Math.max(0, u)), v: Math.min(1, Math.max(0, v)) };
    }
  return null;
}

const catmullRom = (t: number) => {
  const t2 = t * t;
  const t3 = t2 * t;
  return [(-t3 + 2 * t2 - t) / 2, (3 * t3 - 5 * t2 + 2) / 2, (-3 * t3 + 4 * t2 + t) / 2, (t3 - t2) / 2];
};

function meshWeights(g: GradientParams, m: GradientMesh, p: Vec2, n: number): number[] {
  const col = (r: number, c: number) => Math.min(n - 1, Math.max(0, nodeAt(m, r, c).c));
  const loc = meshLocate(m, p);
  const w = new Array<number>(n).fill(0);
  if (loc) {
    const { r, c, u, v } = loc;
    if (g.curve === "smooth") {
      const bu = catmullRom(u);
      const bv = catmullRom(v);
      for (let i = 0; i < 4; i++) {
        const rr = Math.min(m.rows - 1, Math.max(0, r + i - 1));
        for (let j = 0; j < 4; j++) w[col(rr, Math.min(m.cols - 1, Math.max(0, c + j - 1)))] += bu[j] * bv[i];
      }
      let sum = 0;
      for (let k = 0; k < n; k++) sum += w[k] = Math.max(0, w[k]);
      for (let k = 0; k < n; k++) w[k] /= Math.max(sum, 1e-12);
    } else {
      const eu = ease(g.curve, g.steps, u);
      const ev = ease(g.curve, g.steps, v);
      w[col(r, c)] += (1 - eu) * (1 - ev);
      w[col(r, c + 1)] += eu * (1 - ev);
      w[col(r + 1, c + 1)] += eu * ev;
      w[col(r + 1, c)] += (1 - eu) * ev;
    }
    return w;
  }
  // outside the mesh: the nearest border colour continues
  const border: [number, number][] = [];
  for (let c = 0; c < m.cols; c++) border.push([0, c]);
  for (let r = 1; r < m.rows; r++) border.push([r, m.cols - 1]);
  for (let c = m.cols - 2; c >= 0; c--) border.push([m.rows - 1, c]);
  for (let r = m.rows - 2; r >= 1; r--) border.push([r, 0]);
  let best = { d: Infinity, a: 0, b: 0, t: 0 };
  for (let i = 0; i < border.length; i++) {
    const A = border[i];
    const B = border[(i + 1) % border.length];
    const pa = nodeAt(m, A[0], A[1]).p;
    const pb = nodeAt(m, B[0], B[1]).p;
    const d = [pb[0] - pa[0], pb[1] - pa[1]];
    const t = Math.min(1, Math.max(0, ((p[0] - pa[0]) * d[0] + (p[1] - pa[1]) * d[1]) / Math.max(1e-12, d[0] * d[0] + d[1] * d[1])));
    const dist = Math.hypot(pa[0] + d[0] * t - p[0], pa[1] + d[1] * t - p[1]);
    if (dist < best.d) best = { d: dist, a: col(A[0], A[1]), b: col(B[0], B[1]), t };
  }
  const t = ease(g.curve, g.steps, best.t);
  w[best.a] += 1 - t;
  w[best.b] += t;
  return w;
}

function freeWeights(g: GradientParams, pts: FreePoint[], p: Vec2, n: number): number[] {
  const w = new Array<number>(n).fill(0);
  for (const fp of pts) {
    const d = Math.hypot(fp.p[0] - p[0], fp.p[1] - p[1]) / Math.max(0.1, fp.spread);
    const k = Math.min(n - 1, Math.max(0, fp.c));
    if (d < 1e-4) return oneHot(n, k);
    w[k] += 1 / (d * d);
  }
  const sum = w.reduce((a, b) => a + b, 0);
  for (let k = 0; k < n; k++) w[k] /= Math.max(sum, 1e-12);
  shapeMix(g, w);
  return w;
}

/** Weight of every colour layer at a point of the design (they sum to 1). */
export function weightsAt(g: GradientParams, p: Vec2): number[] {
  const n = Math.max(1, g.stops.length);
  if (g.kind === "mesh") return meshValid(g.mesh) ? meshWeights(g, g.mesh, p, n) : oneHot(n, 0);
  if (g.kind === "freeform") return g.points?.length ? freeWeights(g, g.points, p, n) : oneHot(n, 0);
  return weights(g, position(g, p));
}

const argmax = (w: number[]) => w.reduce((b, x, i) => (x > w[b] + 1e-9 ? i : b), 0);

/** Point of the mesh at global parameters (U along the columns, V along the rows). */
export function meshEval(m: GradientMesh, U: number, V: number): Vec2 {
  const c = Math.min(m.cols - 2, Math.max(0, Math.floor(U)));
  const r = Math.min(m.rows - 2, Math.max(0, Math.floor(V)));
  const u = U - c;
  const v = V - r;
  const [a, b, cc, d] = [nodeAt(m, r, c).p, nodeAt(m, r, c + 1).p, nodeAt(m, r + 1, c + 1).p, nodeAt(m, r + 1, c).p];
  const top: Vec2 = [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u];
  const bot: Vec2 = [d[0] + (cc[0] - d[0]) * u, d[1] + (cc[1] - d[1]) * u];
  return [top[0] + (bot[0] - top[0]) * v, top[1] + (bot[1] - top[1]) * v];
}

/** A rectangular mesh over a box; node colours sampled from `colorAt`. */
export function meshGrid(b: Box, rows: number, cols: number, colorAt: (p: Vec2) => number, us?: number[], vs?: number[]): GradientMesh {
  const U = us ?? Array.from({ length: cols }, (_, j) => j / (cols - 1));
  const V = vs ?? Array.from({ length: rows }, (_, i) => i / (rows - 1));
  const nodes = [];
  for (const v of V)
    for (const u of U) {
      const p: Vec2 = [b.x + b.w * u, b.y + b.h * v];
      nodes.push({ p, c: colorAt(p) });
    }
  return { rows: V.length, cols: U.length, nodes };
}

/**
 * Add mesh lines through `p` (the mesh tool): a new row and a new
 * column, or only one of them when `only` is set. Returns the new node at `p`.
 */
export function meshInsert(g: GradientParams, p: Vec2, only?: "row" | "col"): { mesh: GradientMesh; node: number } | null {
  const m = g.mesh;
  if (!meshValid(m)) return null;
  const loc = meshLocate(m, p);
  if (!loc) return null;
  const Us = Array.from({ length: m.cols }, (_, j) => j);
  const Vs = Array.from({ length: m.rows }, (_, i) => i);
  const U = loc.c + loc.u;
  const V = loc.r + loc.v;
  const near = (x: number, arr: number[]) => arr.some((a) => Math.abs(a - x) < 0.02);
  const addCol = only !== "row" && !near(U, Us);
  const addRow = only !== "col" && !near(V, Vs);
  if (!addCol && !addRow) return null;
  if (addCol) Us.splice(loc.c + 1, 0, U);
  if (addRow) Vs.splice(loc.r + 1, 0, V);
  const nodes = [];
  for (const v of Vs)
    for (const u of Us) {
      if (Number.isInteger(u) && Number.isInteger(v)) nodes.push(nodeAt(m, v, u));
      else {
        const q = meshEval(m, u, v);
        nodes.push({ p: q, c: argmax(weightsAt(g, q)) });
      }
    }
  const mesh = { rows: Vs.length, cols: Us.length, nodes };
  const ri = addRow ? loc.r + 1 : Vs.reduce((b, x, i) => (Math.abs(x - V) < Math.abs(Vs[b] - V) ? i : b), 0);
  const ci = addCol ? loc.c + 1 : Us.reduce((b, x, i) => (Math.abs(x - U) < Math.abs(Us[b] - U) ? i : b), 0);
  return { mesh, node: ri * mesh.cols + ci };
}

/** Remove the mesh lines through a node (its row and / or column; border lines stay). */
export function meshRemoveLines(m: GradientMesh, idx: number): GradientMesh | null {
  const r = Math.floor(idx / m.cols);
  const c = idx % m.cols;
  const dropRow = r > 0 && r < m.rows - 1;
  const dropCol = c > 0 && c < m.cols - 1;
  if (!dropRow && !dropCol) return null;
  const nodes = m.nodes.filter((_, i) => !(dropRow && Math.floor(i / m.cols) === r) && !(dropCol && i % m.cols === c));
  return { rows: m.rows - (dropRow ? 1 : 0), cols: m.cols - (dropCol ? 1 : 0), nodes };
}

/** The same mesh with another number of rows and columns (keeps its warp). */
export function meshResample(g: GradientParams, rows: number, cols: number): GradientMesh | null {
  const m = g.mesh;
  if (!meshValid(m)) return null;
  const nodes = [];
  for (let i = 0; i < rows; i++)
    for (let j = 0; j < cols; j++) {
      const p = meshEval(m, (j * (m.cols - 1)) / (cols - 1), (i * (m.rows - 1)) / (rows - 1));
      nodes.push({ p, c: argmax(weightsAt(g, p)) });
    }
  return { rows, cols, nodes };
}

/** Freeform points that reproduce a gradient: one per colour at its centre of mass. */
export function pointsFrom(g: GradientParams, b: Box): FreePoint[] {
  const n = Math.max(1, g.stops.length);
  const acc = Array.from({ length: n }, () => ({ x: 0, y: 0, w: 0 }));
  const N = 14;
  for (let i = 0; i < N; i++)
    for (let j = 0; j < N; j++) {
      const p: Vec2 = [b.x + (b.w * (j + 0.5)) / N, b.y + (b.h * (i + 0.5)) / N];
      weightsAt(g, p).forEach((w, k) => {
        acc[k].x += p[0] * w;
        acc[k].y += p[1] * w;
        acc[k].w += w;
      });
    }
  const spread = Math.max(2, Math.hypot(b.w, b.h) * 0.25);
  return acc.flatMap((a, k) => (a.w > N * N * 0.02 ? [{ p: [a.x / a.w, a.y / a.w] as Vec2, c: k, spread }] : []));
}

/** Bounds of a gradient's shape. */
export function gradientBox(group: string): Box {
  const layers = gradientLayers(store().doc, group);
  return unionBoxes(layers.slice(0, 1).map(objectBounds)) ?? { x: 0, y: 0, w: 10, h: 10 };
}

/** Switch the gradient type; mesh and points are built from the current look. */
export function setGradientKind(group: string, kind: GradientKind) {
  const layers = gradientLayers(store().doc, group);
  if (!layers.length) return;
  const g = (layers[0].stitch as GradientFill).gradient;
  const b = gradientBox(group);
  const patch: Partial<GradientParams> = { kind };
  if (kind === "mesh" && !meshValid(g.mesh)) {
    patch.mesh = meshGrid(b, 3, 3, (p) => argmax(weightsAt(g, p)));
    if (g.curve === "linear") patch.curve = "smooth";
  }
  if (kind === "freeform" && !g.points?.length) {
    if (g.kind === "mesh" && meshValid(g.mesh)) {
      // the mesh nodes become the points, reaching about one patch
      const spread = Math.max(2, Math.hypot(b.w / (g.mesh.cols - 1), b.h / (g.mesh.rows - 1)) * 0.6);
      patch.points = g.mesh.nodes.map((n) => ({ p: n.p, c: n.c, spread }));
    } else patch.points = pointsFrom(g, b);
  }
  if (is2D(kind) && g.dither === "rows") patch.dither = "diffusion";
  store().set({ gradNodes: [] });
  updateGradient(group, patch);
}

/**
 * Store new mesh nodes / points. Colour layers no node uses are dropped
 * (and `threads` may add new ones); the stops follow the layers.
 */
export function commit2D(group: string, next: { mesh?: GradientMesh; points?: FreePoint[] }, threads?: string[], live = false) {
  const layers = gradientLayers(store().doc, group);
  if (!layers.length) return;
  const g = (layers[0].stitch as GradientFill).gradient;
  const list = threads ?? stopsOf(store().doc, group).map((x) => x.thread);
  const mesh = next.mesh ?? g.mesh;
  const points = next.points ?? g.points;
  const active = g.kind === "mesh" ? mesh?.nodes ?? [] : points ?? [];
  const used = new Set(active.map((x) => x.c));
  const patch = { ...(mesh ? { mesh } : {}), ...(points ? { points } : {}) };
  if (live || used.size === list.length) {
    if (list.length !== layers.length) setStops(group, list.map((thread, i) => ({ pos: list.length > 1 ? i / (list.length - 1) : 0, mid: 0.5, thread })), live, patch);
    else updateGradient(group, patch, live);
    return;
  }
  const remap = new Map<number, number>();
  const keep: string[] = [];
  list.forEach((t, i) => {
    if (used.has(i)) {
      remap.set(i, keep.length);
      keep.push(t);
    }
  });
  if (!keep.length) return;
  const re = <T extends { c: number }>(xs: T[]) => xs.map((x) => ({ ...x, c: remap.get(x.c) ?? 0 }));
  const n = keep.length;
  setStops(
    group,
    keep.map((thread, i) => ({ pos: n > 1 ? i / (n - 1) : 0, mid: 0.5, thread })),
    false,
    { ...(mesh ? { mesh: { ...mesh, nodes: re(mesh.nodes) } } : {}), ...(points ? { points: re(points) } : {}) },
  );
}

/** Give mesh nodes / freeform points a thread colour (adds a colour layer if new). */
export function colorNodes(group: string, idx: number[], thread: string) {
  const layers = gradientLayers(store().doc, group);
  if (!layers.length || !idx.length) return;
  const g = (layers[0].stitch as GradientFill).gradient;
  const threads = stopsOf(store().doc, group).map((x) => x.thread);
  let k = threads.indexOf(thread);
  if (k < 0) {
    threads.push(thread);
    k = threads.length - 1;
  }
  const sel = new Set(idx);
  if (g.kind === "mesh" && g.mesh) commit2D(group, { mesh: { ...g.mesh, nodes: g.mesh.nodes.map((n, i) => (sel.has(i) ? { ...n, c: k } : n)) } }, threads);
  else if (g.points) commit2D(group, { points: g.points.map((q, i) => (sel.has(i) ? { ...q, c: k } : q)) }, threads);
}

/** Delete freeform points / the mesh lines through a node. */
export function removeNodes(group: string, idx: number[]) {
  const layers = gradientLayers(store().doc, group);
  if (!layers.length || !idx.length) return false;
  const g = (layers[0].stitch as GradientFill).gradient;
  if (g.kind === "mesh" && meshValid(g.mesh)) {
    const m = meshRemoveLines(g.mesh, idx[0]);
    if (!m) return false;
    commit2D(group, { mesh: m });
  } else if (g.points) {
    const sel = new Set(idx);
    const pts = g.points.filter((_, i) => !sel.has(i));
    if (!pts.length) return false;
    commit2D(group, { points: pts });
  } else return false;
  store().set({ gradNodes: [] });
  return true;
}

/** Turn a closed shape into a mesh / freeform gradient with a new colour at `click`. */
export function makeGradient2D(objId: string, click: Vec2, kind: "mesh" | "freeform"): string | null {
  const o = store().doc.objects.find((x) => x.id === objId);
  if (!o || !hasClosed(o) || o.text) return null;
  const b = objectBounds(o) ?? { x: 0, y: 0, w: 10, h: 10 };
  const cx = Math.min(b.x + b.w * 0.9, Math.max(b.x + b.w * 0.1, click[0]));
  const cy = Math.min(b.y + b.h * 0.9, Math.max(b.y + b.h * 0.1, click[1]));
  const extra: Partial<GradientParams> = { kind, dither: "diffusion" };
  let node = 0;
  if (kind === "mesh") {
    // the click adds a row and a column; the new node gets the new colour
    const u = (cx - b.x) / b.w;
    const v = (cy - b.y) / b.h;
    const mesh = meshGrid(b, 3, 3, () => 0, [0, u, 1], [0, v, 1]);
    mesh.nodes[4] = { ...mesh.nodes[4], c: 1 };
    extra.mesh = mesh;
    extra.curve = "smooth";
    node = 4;
  } else {
    const centre: Vec2 = [b.x + b.w / 2, b.y + b.h / 2];
    const spread = Math.max(2, Math.hypot(b.w, b.h) * 0.25);
    let other: Vec2 = [2 * centre[0] - cx, 2 * centre[1] - cy];
    if (Math.hypot(other[0] - cx, other[1] - cy) < Math.hypot(b.w, b.h) * 0.25) other = [b.x + b.w * 0.15, b.y + b.h * 0.15];
    extra.points = [
      { p: other, c: 0, spread },
      { p: [cx, cy], c: 1, spread },
    ];
    extra.curve = "linear";
    node = 1;
  }
  const group = makeGradient(objId, [b.x, b.y + b.h / 2], [b.x + b.w, b.y + b.h / 2], extra);
  if (group) store().set({ gradNodes: [node] });
  return group;
}

/** The node / point of a 2D gradient near `p` (the nearest within `tol`). */
export function nodeHit(g: GradientParams, p: Vec2, tol: number): number | null {
  const pts = g.kind === "mesh" ? g.mesh?.nodes ?? [] : g.kind === "freeform" ? g.points ?? [] : [];
  let best: number | null = null;
  let bd = tol;
  for (let i = pts.length - 1; i >= 0; i--) {
    const d = Math.hypot(pts[i].p[0] - p[0], pts[i].p[1] - p[1]);
    if (d < bd) {
      bd = d;
      best = i;
    }
  }
  return best;
}

/** Is `p` on a mesh line? "row" for a line along a row, "col" for a column line. */
export function meshLineHit(m: GradientMesh, p: Vec2, tol: number): "row" | "col" | null {
  const segDist = (a: Vec2, b: Vec2) => {
    const d = [b[0] - a[0], b[1] - a[1]];
    const t = Math.min(1, Math.max(0, ((p[0] - a[0]) * d[0] + (p[1] - a[1]) * d[1]) / Math.max(1e-12, d[0] * d[0] + d[1] * d[1])));
    return Math.hypot(a[0] + d[0] * t - p[0], a[1] + d[1] * t - p[1]);
  };
  for (let r = 0; r < m.rows; r++) for (let c = 0; c < m.cols - 1; c++) if (segDist(nodeAt(m, r, c).p, nodeAt(m, r, c + 1).p) < tol) return "row";
  for (let c = 0; c < m.cols; c++) for (let r = 0; r < m.rows - 1; r++) if (segDist(nodeAt(m, r, c).p, nodeAt(m, r + 1, c).p) < tol) return "col";
  return null;
}

/** The rows a gradient or density gradient is sewn in. */
export type RowStyle = "tatami" | "curved" | "flow";

/** Where a fill's flow comes from: the picture's direction field (auto-digitized
 *  Flow fills), the colour bands of its gradient, or nothing (no flow). */
export function flowSource(o: DesignObject): "picture" | "colours" | null {
  if (o.stitch.type !== "fill") return null;
  if (o.stitch.flow) return "picture";
  return (o.stitch.gradient?.stops.length ?? 0) >= 2 ? "colours" : null;
}

/** Can these objects flow (a picture field, or a gradient to follow)? */
export const canFlow = (objects: DesignObject[]) => objects.length > 0 && objects.every((o) => flowSource(o) !== null);

/** The row style of a set of fills (the first one's). */
export function rowStyleOf(objects: DesignObject[]): RowStyle {
  const st = objects[0]?.stitch;
  return st?.type === "fill" && (st.method === "curved" || st.method === "flow") ? st.method : "tatami";
}

/** Sew these fills in straight rows, curved rows or the picture's flow. */
export function setRowStyle(ids: string[], style: RowStyle) {
  const s = store();
  s.commit((d) => ({
    ...d,
    objects: d.objects.map((o) => (ids.includes(o.id) && o.stitch.type === "fill" ? { ...o, stitch: { ...o.stitch, method: style === "flow" && !flowSource(o) ? "tatami" : style } } : o)),
  }));
}

/** Flow gradients: rows along the colour bands, or across them (all layers alike). */
export function setFlowAcross(ids: string[], across: boolean) {
  store().commit((d) => ({
    ...d,
    objects: d.objects.map((o) => (ids.includes(o.id) && o.stitch.type === "fill" ? { ...o, stitch: { ...o.stitch, flowAcross: across || undefined } } : o)),
  }));
}
