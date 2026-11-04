// Shape manipulators on Bézier paths (mm): round /
// inverted / chamfered corners (per corner or all), pucker & bloat, zig zag,
// roughen, twist, envelope warps (arc, arch, bulge, flag, wave, fish, rise,
// inflate, squeeze), simplify, smooth, add anchor points, reverse and sharpen.
// Every effect maps sub-paths to sub-paths, so it works for fills, runs,
// satin rails and appliqué alike.

import type { PathNode, SubPath, Vec2 } from "../types";
import { cubicAt, fitPath, flattenSubPath, segmentOf, splitCubic, type Cubic } from "./bezier";
import { smoothPath } from "./geometry";

const add = (a: Vec2, b: Vec2): Vec2 => [a[0] + b[0], a[1] + b[1]];
const sub = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]];
const mul = (a: Vec2, k: number): Vec2 => [a[0] * k, a[1] * k];
const dot = (a: Vec2, b: Vec2) => a[0] * b[0] + a[1] * b[1];
const len = (a: Vec2) => Math.hypot(a[0], a[1]);
const dist = (a: Vec2, b: Vec2) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const norm = (a: Vec2): Vec2 => {
  const l = len(a);
  return l < 1e-12 ? [0, 0] : [a[0] / l, a[1] / l];
};
const rot = (a: Vec2, ang: number): Vec2 => [a[0] * Math.cos(ang) - a[1] * Math.sin(ang), a[0] * Math.sin(ang) + a[1] * Math.cos(ang)];

// ---------------------------------------------------------------------------
// Segments

interface Seg {
  c: Cubic;
  straight: boolean;
}

function segments(sp: SubPath): Seg[] {
  const n = sp.nodes.length;
  const count = sp.closed ? n : n - 1;
  const out: Seg[] = [];
  for (let s = 0; s < count; s++) {
    const a = sp.nodes[s];
    const b = sp.nodes[(s + 1) % n];
    out.push({ c: segmentOf(sp, s), straight: !a.o && !b.i });
  }
  return out;
}

/** Rebuild nodes from consecutive segments (end of one = start of the next). */
function fromSegments(segs: Seg[], closed: boolean): SubPath {
  if (!segs.length) return { closed, nodes: [] };
  const h = (q: Vec2, at: Vec2) => (dist(q, at) > 1e-6 ? q : undefined);
  const nodes: PathNode[] = [];
  const m = segs.length;
  for (let s = 0; s < m; s++) {
    const seg = segs[s];
    const prev = s > 0 ? segs[s - 1] : closed ? segs[m - 1] : null;
    const node: PathNode = { p: seg.c[0] };
    const i = prev && !prev.straight ? h(prev.c[2], seg.c[0]) : undefined;
    const o = !seg.straight ? h(seg.c[1], seg.c[0]) : undefined;
    if (i) node.i = i;
    if (o) node.o = o;
    nodes.push(node);
  }
  if (!closed) {
    const last = segs[m - 1];
    const node: PathNode = { p: last.c[3] };
    const i = !last.straight ? h(last.c[2], last.c[3]) : undefined;
    if (i) node.i = i;
    nodes.push(node);
  }
  return { closed, nodes };
}

/** Arc length table of a cubic. */
function arcTable(c: Cubic, n = 32): number[] {
  const out = [0];
  let prev = c[0];
  for (let k = 1; k <= n; k++) {
    const p = cubicAt(c, k / n);
    out.push(out[k - 1] + dist(prev, p));
    prev = p;
  }
  return out;
}

const segLength = (s: Seg) => (s.straight ? dist(s.c[0], s.c[3]) : arcTable(s.c).at(-1)!);

/** Curve parameter at arc length `d` from the start. */
function paramAt(s: Seg, d: number): number {
  if (s.straight) {
    const L = dist(s.c[0], s.c[3]);
    return L < 1e-12 ? 0 : Math.min(1, Math.max(0, d / L));
  }
  const tab = arcTable(s.c);
  const n = tab.length - 1;
  if (d <= 0) return 0;
  if (d >= tab[n]) return 1;
  let k = 1;
  while (tab[k] < d) k++;
  const f = (d - tab[k - 1]) / Math.max(1e-12, tab[k] - tab[k - 1]);
  return (k - 1 + f) / n;
}

/** The part of a segment between parameters t0 < t1. */
function subSeg(s: Seg, t0: number, t1: number): Seg {
  if (s.straight) {
    const p = (t: number): Vec2 => [s.c[0][0] + (s.c[3][0] - s.c[0][0]) * t, s.c[0][1] + (s.c[3][1] - s.c[0][1]) * t];
    const a = p(t0);
    const b = p(t1);
    return { c: [a, a, b, b], straight: true };
  }
  let c = s.c;
  if (t1 < 1) c = splitCubic(c, t1)[0];
  if (t0 > 0) c = splitCubic(c, t0 / Math.max(1e-12, t1))[1];
  return { c, straight: false };
}

const tangentOut = (s: Seg): Vec2 => {
  const [a, b, c, d] = s.c;
  return norm(dist(a, b) > 1e-9 ? sub(b, a) : dist(a, c) > 1e-9 ? sub(c, a) : sub(d, a));
};
const tangentIn = (s: Seg): Vec2 => {
  const [a, b, c, d] = s.c;
  return norm(dist(d, c) > 1e-9 ? sub(d, c) : dist(d, b) > 1e-9 ? sub(d, b) : sub(d, a));
};

// ---------------------------------------------------------------------------
// Corners

export type CornerStyle = "round" | "inverted" | "chamfer";

/** Turn angle (rad, 0 = straight) at each node; NaN at the ends of open paths. */
export function cornerAngles(sp: SubPath): number[] {
  const segs = segments(sp);
  const n = sp.nodes.length;
  return sp.nodes.map((_, k) => {
    const inSeg = k > 0 ? segs[k - 1] : sp.closed ? segs[segs.length - 1] : null;
    const outSeg = k < segs.length ? segs[k] : null;
    if (!inSeg || !outSeg || (!sp.closed && (k === 0 || k === n - 1))) return NaN;
    const a = tangentIn(inSeg);
    const b = tangentOut(outSeg);
    return Math.acos(Math.max(-1, Math.min(1, dot(a, b))));
  });
}

/**
 * Round the corners of a sub-path. `radii[k]` is the radius at node k (0 =
 * keep); corners need a turn of at least `minTurnDeg`. Tangent lengths are
 * clamped to half of each neighbouring segment, like live corners in
 * vector editors.
 */
export function roundCorners(sp: SubPath, radii: number[] | number, style: CornerStyle = "round", minTurnDeg = 2): SubPath {
  const n = sp.nodes.length;
  if (n < 3 && !(n === 2 && !sp.closed)) return sp;
  const segs = segments(sp);
  if (!segs.length) return sp;
  const turn = cornerAngles(sp);
  const lens = segs.map(segLength);
  const r = (k: number) => (Array.isArray(radii) ? radii[k] ?? 0 : radii);
  // trims at the start / end of every segment (arc length)
  const tStart = new Array<number>(segs.length).fill(0);
  const tEnd = new Array<number>(segs.length).fill(0);
  const rounded = new Array<boolean>(n).fill(false);
  for (let k = 0; k < n; k++) {
    const phi = turn[k];
    if (!(phi >= (minTurnDeg * Math.PI) / 180) || r(k) <= 0 || phi > Math.PI - 1e-3) continue;
    const inS = k > 0 ? k - 1 : segs.length - 1;
    const outS = k;
    const want = style === "round" ? r(k) * Math.tan(phi / 2) : r(k);
    const t = Math.min(want, lens[inS] * 0.5, lens[outS] * 0.5);
    if (t < 1e-4) continue;
    tEnd[inS] = t;
    tStart[outS] = t;
    rounded[k] = true;
  }
  if (!rounded.some(Boolean)) return sp;
  const trimmed: Seg[] = segs.map((s, i) => {
    const t0 = tStart[i] ? paramAt(s, tStart[i]) : 0;
    const t1 = tEnd[i] ? paramAt(s, lens[i] - tEnd[i]) : 1;
    return subSeg(s, t0, Math.max(t0 + 1e-6, t1));
  });
  // assemble: trimmed segments with fillets between them
  const out: Seg[] = [];
  const m = trimmed.length;
  for (let i = 0; i < m; i++) {
    const k = (i + 1) % n; // node at the end of segment i
    out.push(trimmed[i]);
    const isLast = i === m - 1;
    if ((!sp.closed && isLast) || !rounded[k]) continue;
    const a = trimmed[i].c[3];
    const b = trimmed[(i + 1) % m].c[0];
    const din = tangentIn(segs[i]);
    const dout = tangentOut(segs[(i + 1) % m]);
    if (style === "chamfer") {
      out.push({ c: [a, a, b, b], straight: true });
      continue;
    }
    const phi = turn[k];
    if (style === "round") {
      const t = dist(a, sp.nodes[k].p);
      const radius = t / Math.tan(phi / 2);
      const hl = (4 / 3) * Math.tan(phi / 4) * radius;
      out.push({ c: [a, add(a, mul(din, hl)), sub(b, mul(dout, hl)), b], straight: false });
    } else {
      // inverted: an arc around the corner point (a scallop)
      const C = sp.nodes[k].p;
      const t = dist(a, C);
      const span = Math.PI - phi;
      const hl = (4 / 3) * Math.tan(span / 4) * t;
      let ta = norm(rot(sub(a, C), Math.PI / 2));
      if (dot(ta, sub(b, a)) < 0) ta = mul(ta, -1);
      let tb = norm(rot(sub(b, C), Math.PI / 2));
      if (dot(tb, sub(b, a)) < 0) tb = mul(tb, -1);
      out.push({ c: [a, add(a, mul(ta, hl)), sub(b, mul(tb, hl)), b], straight: false });
    }
  }
  return fromSegments(out, sp.closed);
}

/** A rounded rectangle (the rectangle tool's corner radius). */
export function roundedRectPath(x: number, y: number, w: number, h: number, r: number): SubPath {
  const base: SubPath = {
    closed: true,
    nodes: [{ p: [x, y] }, { p: [x + w, y] }, { p: [x + w, y + h] }, { p: [x, y + h] }],
  };
  return r > 0 ? roundCorners(base, Math.min(r, w / 2, h / 2)) : base;
}

// ---------------------------------------------------------------------------
// Anchor points

/** Split every segment `times` times in half (Add anchors). */
export function addAnchors(sp: SubPath, times = 1): SubPath {
  let cur = sp;
  for (let k = 0; k < times; k++) {
    const segs = segments(cur);
    const out: Seg[] = [];
    for (const s of segs) {
      if (s.straight) {
        const m: Vec2 = mul(add(s.c[0], s.c[3]), 0.5);
        out.push({ c: [s.c[0], s.c[0], m, m], straight: true }, { c: [m, m, s.c[3], s.c[3]], straight: true });
      } else {
        const [l, r] = splitCubic(s.c, 0.5);
        out.push({ c: l, straight: false }, { c: r, straight: false });
      }
    }
    cur = fromSegments(out, cur.closed);
  }
  return cur;
}

/** Split every segment into `parts` equal-parameter pieces. */
function subdivide(sp: SubPath, parts: number): Seg[] {
  const out: Seg[] = [];
  for (const s of segments(sp)) {
    for (let k = 0; k < parts; k++) out.push(subSeg(s, k / parts, (k + 1) / parts));
  }
  return out;
}

/** Give straight segments handles at a third, so they can bend. */
const curvable = (s: Seg): Seg =>
  s.straight ? { c: [s.c[0], add(s.c[0], mul(sub(s.c[3], s.c[0]), 1 / 3)), add(s.c[0], mul(sub(s.c[3], s.c[0]), 2 / 3)), s.c[3]], straight: false } : s;

/** Apply a point map to every anchor and handle. */
function mapPoints(segs: Seg[], f: (p: Vec2) => Vec2): Seg[] {
  return segs.map((s) => ({ c: s.c.map(f) as Cubic, straight: s.straight }));
}

// ---------------------------------------------------------------------------
// Distort & transform

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Pucker (< 0) & bloat (> 0), −100…100 %. */
export function puckerBloat(sp: SubPath, amount: number, centre: Vec2, detail = 0): SubPath {
  const k = amount / 100;
  const segs = (detail > 0 ? subdivide(sp, detail + 1) : segments(sp)).map(curvable);
  const anchor = (p: Vec2) => add(centre, mul(sub(p, centre), 1 - k * 0.5));
  const handle = (p: Vec2) => add(centre, mul(sub(p, centre), 1 + k));
  const out = segs.map((s) => ({ c: [anchor(s.c[0]), handle(s.c[1]), handle(s.c[2]), anchor(s.c[3])] as Cubic, straight: false }));
  return fromSegments(out, sp.closed);
}

/** Even samples (by arc length) along a sub-path, with normals. */
function samples(sp: SubPath, count: number): { p: Vec2; n: Vec2 }[] {
  const pts = flattenSubPath(sp, 0.1);
  if (sp.closed && pts.length > 1 && dist(pts[0], pts[pts.length - 1]) > 1e-6) pts.push(pts[0]);
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + dist(pts[i - 1], pts[i]));
  const L = cum[cum.length - 1];
  const out: { p: Vec2; n: Vec2 }[] = [];
  const total = sp.closed ? count : count + 1;
  let j = 1;
  for (let i = 0; i < total; i++) {
    const d = (L * i) / count;
    while (j < pts.length - 1 && cum[j] < d) j++;
    const a = pts[j - 1];
    const b = pts[j];
    const f = (d - cum[j - 1]) / Math.max(1e-12, cum[j] - cum[j - 1]);
    const p: Vec2 = [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
    const t = norm(sub(b, a));
    out.push({ p, n: [-t[1], t[0]] });
  }
  return out;
}

const polyline = (pts: Vec2[], closed: boolean): SubPath => ({ closed, nodes: pts.map((p) => ({ p })) });

export function zigZag(sp: SubPath, size: number, ridges: number, smooth: boolean): SubPath {
  const segCount = sp.closed ? sp.nodes.length : sp.nodes.length - 1;
  let count = Math.max(2, Math.round(ridges * Math.max(1, segCount)));
  if (sp.closed && count % 2) count++;
  const pts = samples(sp, count).map((s, i) => add(s.p, mul(s.n, i % 2 ? size : -size)));
  return smooth ? smoothPath(pts, sp.closed, 1) : polyline(pts, sp.closed);
}

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) / 4294967296) * 2 - 1;
  };
}

export function roughen(sp: SubPath, size: number, perCm: number, smooth: boolean, seed: number): SubPath {
  const pts = flattenSubPath(sp, 0.2);
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += dist(pts[i - 1], pts[i]);
  if (sp.closed) L += dist(pts[pts.length - 1], pts[0]);
  const count = Math.max(sp.closed ? 6 : 3, Math.round((L / 10) * perCm));
  const r = rng(seed * 7919 + 13);
  const out = samples(sp, count).map((s) => add(s.p, [r() * size, r() * size]));
  return smooth ? smoothPath(out, sp.closed, 1) : polyline(out, sp.closed);
}

export function twist(sp: SubPath, angleDeg: number, centre: Vec2, reach: number): SubPath {
  const a = (angleDeg * Math.PI) / 180;
  const f = (p: Vec2): Vec2 => {
    const v = sub(p, centre);
    const w = Math.max(0, 1 - len(v) / Math.max(reach, 1e-6));
    return add(centre, rot(v, a * w * w));
  };
  return fromSegments(mapPoints(subdivide(sp, 4).map(curvable), f), sp.closed);
}

export type WarpStyle = "arc" | "arch" | "bulge" | "flag" | "wave" | "fish" | "rise" | "inflate" | "squeeze";

export const WARPS: { id: WarpStyle; label: string }[] = [
  { id: "arc", label: "Arc" },
  { id: "arch", label: "Arch" },
  { id: "bulge", label: "Bulge" },
  { id: "flag", label: "Flag" },
  { id: "wave", label: "Wave" },
  { id: "fish", label: "Fish" },
  { id: "rise", label: "Rise" },
  { id: "inflate", label: "Inflate" },
  { id: "squeeze", label: "Squeeze" },
];

/** The warp as a map of normalised coordinates (u along, v across, both −1…1). */
function warpUV(style: WarpStyle, b: number, u: number, v: number): [number, number] {
  const arch = 1 - u * u;
  switch (style) {
    case "arc":
      // the top bends more than the bottom (a fan)
      return [u * (1 + b * 0.25 * -v), v - b * arch * (1 - v) * 0.5];
    case "arch":
      return [u, v - b * arch];
    case "bulge":
      return [u, v + b * arch * v * 0.6];
    case "flag":
      return [u, v - b * Math.sin(u * Math.PI) * 0.5];
    case "wave":
      return [u, v - b * Math.sin(u * Math.PI) * 0.5 * (1 + v) * 0.5 + b * Math.sin(u * Math.PI) * 0.5 * (1 - v) * 0.5];
    case "fish":
      return [u, v * (1 + b * 0.6 * Math.cos(((u + 0.4) * Math.PI) / 1.4)) ];
    case "rise":
      return [u, v - b * (Math.sin((u * Math.PI) / 2) * 0.5 + u * 0.25)];
    case "inflate": {
      const r2 = Math.min(1, u * u + v * v);
      const k = 1 + b * 0.45 * (1 - r2);
      return [u * k, v * k];
    }
    case "squeeze":
      return [u * (1 + b * 0.2 * (1 - v * v)), v * (1 - b * 0.45 * arch)];
  }
}

export function warp(sp: SubPath, style: WarpStyle, bendPct: number, box: Box, vertical: boolean): SubPath {
  const b = bendPct / 100;
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const hw = Math.max(box.w / 2, 1e-6);
  const hh = Math.max(box.h / 2, 1e-6);
  const f = (p: Vec2): Vec2 => {
    let u = (p[0] - cx) / hw;
    let v = (p[1] - cy) / hh;
    if (vertical) [u, v] = [v, u];
    let [u2, v2] = warpUV(style, b, u, v);
    if (vertical) [u2, v2] = [v2, u2];
    return [cx + u2 * hw, cy + v2 * hh];
  };
  return fromSegments(mapPoints(subdivide(sp, 4).map(curvable), f), sp.closed);
}

// ---------------------------------------------------------------------------
// Path clean-up

export function simplify(sp: SubPath, tolerance: number, cornerDeg = 70, lines = true): SubPath {
  const pts = flattenSubPath(sp, Math.max(0.05, tolerance / 4));
  if (pts.length < 3) return sp;
  const fit = fitPath(pts, tolerance, sp.closed, cornerDeg, undefined, { lines });
  if (sp.closed && fit.nodes.length > 2 && dist(fit.nodes[0].p, fit.nodes[fit.nodes.length - 1].p) < 1e-6) {
    // fitPath repeats the first point at the end of closed paths
    const last = fit.nodes.pop()!;
    if (last.i) fit.nodes[0] = { ...fit.nodes[0], i: last.i };
  }
  return { ...fit, closed: sp.closed };
}

/** Smooth every node (keep corners sharper than `keepDeg`, 180 = none). */
export function smoothNodes(sp: SubPath, tension = 1, keepDeg = 180): SubPath {
  const turn = cornerAngles(sp);
  const n = sp.nodes.length;
  const nodes = sp.nodes.map((nd, k) => {
    if ((turn[k] * 180) / Math.PI > keepDeg) return { p: nd.p };
    const prev = k > 0 ? sp.nodes[k - 1].p : sp.closed ? sp.nodes[n - 1].p : null;
    const next = k < n - 1 ? sp.nodes[k + 1].p : sp.closed ? sp.nodes[0].p : null;
    const dir = norm(sub(next ?? nd.p, prev ?? nd.p));
    const out: PathNode = { p: nd.p };
    if (prev) out.i = sub(nd.p, mul(dir, (dist(prev, nd.p) / 3) * tension));
    if (next) out.o = add(nd.p, mul(dir, (dist(next, nd.p) / 3) * tension));
    return out;
  });
  return { ...sp, nodes };
}

/** Make every node a corner (drop all handles). */
export const sharpen = (sp: SubPath): SubPath => ({ ...sp, nodes: sp.nodes.map((n) => ({ p: n.p })) });

/** Reverse the direction (start ↔ end; handles swap). */
export function reversePath(sp: SubPath): SubPath {
  const nodes = [...sp.nodes].reverse().map((n) => ({ p: n.p, ...(n.o ? { i: n.o } : {}), ...(n.i ? { o: n.i } : {}) }));
  if (sp.closed && nodes.length) nodes.unshift(nodes.pop()!);
  return { ...sp, nodes };
}

// ---------------------------------------------------------------------------
// Effects (dialog)

export type EffectId = "corners" | "pucker" | "zigzag" | "roughen" | "twist" | "warp" | "simplify" | "smooth" | "anchors";

export interface EffectParams {
  corners: { radius: number; style: CornerStyle; minTurn: number };
  pucker: { amount: number; detail: number };
  zigzag: { size: number; ridges: number; smooth: boolean };
  roughen: { size: number; detail: number; smooth: boolean; seed: number };
  twist: { angle: number };
  warp: { style: WarpStyle; bend: number; vertical: boolean };
  simplify: { tolerance: number; corner: number; lines?: boolean };
  smooth: { tension: number; keep: number };
  anchors: { times: number };
}

export const DEFAULT_EFFECTS: EffectParams = {
  corners: { radius: 3, style: "round", minTurn: 5 },
  pucker: { amount: 40, detail: 0 },
  zigzag: { size: 1.5, ridges: 6, smooth: true },
  roughen: { size: 1, detail: 4, smooth: false, seed: 1 },
  twist: { angle: 60 },
  warp: { style: "arc", bend: 40, vertical: false },
  simplify: { tolerance: 0.3, corner: 70, lines: true },
  smooth: { tension: 1, keep: 180 },
  anchors: { times: 1 },
};

/** Apply an effect to the sub-paths of one object (`box`: the selection's bounds). */
export function applyEffect<K extends EffectId>(paths: SubPath[], id: K, p: EffectParams[K], box: Box): SubPath[] {
  const centre: Vec2 = [box.x + box.w / 2, box.y + box.h / 2];
  const reach = Math.hypot(box.w, box.h) / 2;
  return paths.map((sp) => {
    if (sp.nodes.length < 2) return sp;
    switch (id) {
      case "corners": {
        const q = p as EffectParams["corners"];
        return roundCorners(sp, q.radius, q.style, q.minTurn);
      }
      case "pucker": {
        const q = p as EffectParams["pucker"];
        return puckerBloat(sp, q.amount, centre, q.detail);
      }
      case "zigzag": {
        const q = p as EffectParams["zigzag"];
        return zigZag(sp, q.size, q.ridges, q.smooth);
      }
      case "roughen": {
        const q = p as EffectParams["roughen"];
        return roughen(sp, q.size, q.detail, q.smooth, q.seed);
      }
      case "twist":
        return twist(sp, (p as EffectParams["twist"]).angle, centre, reach);
      case "warp": {
        const q = p as EffectParams["warp"];
        return warp(sp, q.style, q.bend, box, q.vertical);
      }
      case "simplify": {
        const q = p as EffectParams["simplify"];
        return simplify(sp, q.tolerance, q.corner, q.lines ?? true);
      }
      case "smooth": {
        const q = p as EffectParams["smooth"];
        return smoothNodes(sp, q.tension, q.keep);
      }
      case "anchors":
        return addAnchors(sp, (p as EffectParams["anchors"]).times);
    }
    return sp;
  });
}

/** Corner turn (deg) helper for UIs. */
export const turnDeg = (sp: SubPath, k: number) => (cornerAngles(sp)[k] * 180) / Math.PI;

// ---------------------------------------------------------------------------
// Shape tool (rectangle / polygon / star, optionally with rounded corners)

export type ShapeKind = "rect" | "polygon" | "star";

/** Regular polygon or star inscribed in a box (first point at the top). */
export function polygonPath(b: Box, sides: number, star = false, inner = 0.5): SubPath {
  const n = Math.max(3, Math.round(sides));
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  const count = star ? n * 2 : n;
  const nodes: PathNode[] = [];
  for (let k = 0; k < count; k++) {
    const a = -Math.PI / 2 + (k * Math.PI * 2) / count;
    const r = star && k % 2 ? inner : 1;
    nodes.push({ p: [cx + (Math.cos(a) * r * b.w) / 2, cy + (Math.sin(a) * r * b.h) / 2] });
  }
  return { closed: true, nodes };
}

export function shapeToolPath(kind: ShapeKind, b: Box, o: { radius: number; sides: number; inner: number }): SubPath {
  const base = kind === "rect" ? { closed: true, nodes: [{ p: [b.x, b.y] as Vec2 }, { p: [b.x + b.w, b.y] as Vec2 }, { p: [b.x + b.w, b.y + b.h] as Vec2 }, { p: [b.x, b.y + b.h] as Vec2 }] } : polygonPath(b, o.sides, kind === "star", o.inner);
  return o.radius > 0 ? roundCorners(base, o.radius) : base;
}

// ---------------------------------------------------------------------------
// Live corner widgets

export interface CornerWidget {
  /** Node index. */
  k: number;
  /** The corner point. */
  p: Vec2;
  /** Unit vector into the corner (the bisector, towards where the fillet goes). */
  dir: Vec2;
  /** Turn angle (rad). */
  phi: number;
}

/** Corners of a sub-path that can be rounded (turn of at least `minTurnDeg`). */
export function cornerWidgets(sp: SubPath, minTurnDeg = 5): CornerWidget[] {
  const segs = segments(sp);
  const turn = cornerAngles(sp);
  const out: CornerWidget[] = [];
  for (let k = 0; k < sp.nodes.length; k++) {
    const phi = turn[k];
    if (!(phi >= (minTurnDeg * Math.PI) / 180) || phi > Math.PI - 0.02) continue;
    const a = tangentIn(k > 0 ? segs[k - 1] : segs[segs.length - 1]);
    const b = tangentOut(segs[k]);
    const dir = norm(sub(b, a));
    if (!dir[0] && !dir[1]) continue;
    out.push({ k, p: sp.nodes[k].p, dir, phi });
  }
  return out;
}

/** Radius whose fillet passes through a point `s` mm along the bisector. */
export function radiusFromWidget(s: number, phi: number): number {
  const theta = Math.PI - phi;
  const f = 1 / Math.sin(theta / 2) - 1;
  return Math.max(0, f > 1e-6 ? s / f : s);
}
