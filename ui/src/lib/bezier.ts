// Cubic Bézier helpers for the pen, satin and node tools: evaluation and
// splitting, nearest point, inserting / deleting / converting nodes without
// changing the shape, angle constraints, stitch previews, and Philip
// Schneider's curve fitting ("An Algorithm for Automatically Fitting
// Digitized Curves", Graphics Gems 1990) for freehand strokes.

import type { PathNode, SubPath, Vec2 } from "../types";

export type Cubic = [Vec2, Vec2, Vec2, Vec2];

const add = (a: Vec2, b: Vec2): Vec2 => [a[0] + b[0], a[1] + b[1]];
const sub = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]];
const mul = (a: Vec2, k: number): Vec2 => [a[0] * k, a[1] * k];
const dot = (a: Vec2, b: Vec2) => a[0] * b[0] + a[1] * b[1];
const len = (a: Vec2) => Math.hypot(a[0], a[1]);
const lerp = (a: Vec2, b: Vec2, t: number): Vec2 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
export const vdist = (a: Vec2, b: Vec2) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const norm = (a: Vec2): Vec2 => {
  const l = len(a);
  return l < 1e-12 ? [0, 0] : [a[0] / l, a[1] / l];
};

export function cubicAt([a, b, c, d]: Cubic, t: number): Vec2 {
  const u = 1 - t;
  const k0 = u * u * u;
  const k1 = 3 * u * u * t;
  const k2 = 3 * u * t * t;
  const k3 = t * t * t;
  return [k0 * a[0] + k1 * b[0] + k2 * c[0] + k3 * d[0], k0 * a[1] + k1 * b[1] + k2 * c[1] + k3 * d[1]];
}

/** de Casteljau split at t. */
export function splitCubic([a, b, c, d]: Cubic, t: number): [Cubic, Cubic] {
  const ab = lerp(a, b, t);
  const bc = lerp(b, c, t);
  const cd = lerp(c, d, t);
  const abc = lerp(ab, bc, t);
  const bcd = lerp(bc, cd, t);
  const m = lerp(abc, bcd, t);
  return [
    [a, ab, abc, m],
    [m, bcd, cd, d],
  ];
}

export const segmentCount = (sp: SubPath) => (sp.closed ? sp.nodes.length : sp.nodes.length - 1);

/** Segment i of a sub-path as a cubic (straight segments get collinear controls). */
export function segmentOf(sp: SubPath, i: number): Cubic {
  const a = sp.nodes[i];
  const b = sp.nodes[(i + 1) % sp.nodes.length];
  return [a.p, a.o ?? a.p, b.i ?? b.p, b.p];
}
export const isCurved = (sp: SubPath, i: number) => !!(sp.nodes[i].o || sp.nodes[(i + 1) % sp.nodes.length].i);

export interface Nearest {
  seg: number;
  t: number;
  p: Vec2;
  d: number;
}

/** Closest point of a sub-path to q (sampling, then refinement). */
export function nearestOnSubPath(sp: SubPath, q: Vec2): Nearest | null {
  let best: Nearest | null = null;
  const n = segmentCount(sp);
  for (let s = 0; s < n; s++) {
    const c = segmentOf(sp, s);
    const steps = isCurved(sp, s) ? 32 : 1;
    if (steps === 1) {
      const ab = sub(c[3], c[0]);
      const l2 = dot(ab, ab);
      const t = l2 < 1e-12 ? 0 : Math.max(0, Math.min(1, dot(sub(q, c[0]), ab) / l2));
      const p = lerp(c[0], c[3], t);
      const d = vdist(p, q);
      if (!best || d < best.d) best = { seg: s, t, p, d };
      continue;
    }
    let bt = 0;
    let bd = Infinity;
    for (let k = 0; k <= steps; k++) {
      const d = vdist(cubicAt(c, k / steps), q);
      if (d < bd) {
        bd = d;
        bt = k / steps;
      }
    }
    // golden refinement around the best sample
    let lo = Math.max(0, bt - 1 / steps);
    let hi = Math.min(1, bt + 1 / steps);
    for (let it = 0; it < 24; it++) {
      const m1 = lo + (hi - lo) * 0.382;
      const m2 = lo + (hi - lo) * 0.618;
      if (vdist(cubicAt(c, m1), q) < vdist(cubicAt(c, m2), q)) hi = m2;
      else lo = m1;
    }
    const t = (lo + hi) / 2;
    const p = cubicAt(c, t);
    const d = vdist(p, q);
    if (!best || d < best.d) best = { seg: s, t, p, d };
  }
  return best;
}

const clone = (n: PathNode): PathNode => ({ p: n.p, ...(n.i ? { i: n.i } : {}), ...(n.o ? { o: n.o } : {}) });

/** Insert a node on segment `seg` at `t` without changing the shape. */
export function insertNode(sp: SubPath, seg: number, t: number): { sp: SubPath; index: number } {
  const nodes = sp.nodes.map(clone);
  const ia = seg;
  const ib = (seg + 1) % nodes.length;
  const a = nodes[ia];
  const b = nodes[ib];
  let mid: PathNode;
  if (!isCurved(sp, seg)) {
    mid = { p: lerp(a.p, b.p, t) };
  } else {
    const [l, r] = splitCubic(segmentOf(sp, seg), t);
    // a corner stays a corner: handles that coincide with their point are dropped
    const h = (q: Vec2, at: Vec2) => (vdist(q, at) > 1e-6 ? q : undefined);
    const ao = h(l[1], a.p);
    const bi = h(r[2], b.p);
    if (ao) a.o = ao;
    else delete a.o;
    if (bi) b.i = bi;
    else delete b.i;
    mid = { p: l[3] };
    const mi = h(l[2], l[3]);
    const mo = h(r[1], l[3]);
    if (mi) mid.i = mi;
    if (mo) mid.o = mo;
  }
  nodes.splice(ia + 1, 0, mid);
  return { sp: { ...sp, nodes }, index: ia + 1 };
}

/** Remove node i (the neighbours keep their handles). */
export function deleteNode(sp: SubPath, i: number): SubPath {
  const nodes = sp.nodes.filter((_, k) => k !== i).map(clone);
  return { ...sp, nodes, closed: sp.closed && nodes.length >= 3 };
}

export const isSmooth = (n: PathNode) => !!(n.i || n.o);

/** Corner ↔ smooth. Smooth handles follow the neighbours (Catmull-Rom like). */
export function toggleSmooth(sp: SubPath, i: number): SubPath {
  const nodes = sp.nodes.map(clone);
  const n = nodes[i];
  if (isSmooth(n)) {
    delete n.i;
    delete n.o;
    return { ...sp, nodes };
  }
  const m = nodes.length;
  const prev = i > 0 ? nodes[i - 1].p : sp.closed ? nodes[m - 1].p : null;
  const next = i < m - 1 ? nodes[i + 1].p : sp.closed ? nodes[0].p : null;
  const dir = norm(sub(next ?? n.p, prev ?? n.p));
  if (!dir[0] && !dir[1]) return sp;
  if (prev) n.i = sub(n.p, mul(dir, vdist(prev, n.p) / 3));
  if (next) n.o = add(n.p, mul(dir, vdist(next, n.p) / 3));
  return { ...sp, nodes };
}

/** Snap `to` so the direction from `from` is a multiple of `stepDeg`. */
export function constrainAngle(from: Vec2, to: Vec2, stepDeg: number): Vec2 {
  const d = sub(to, from);
  const step = (stepDeg * Math.PI) / 180;
  const a = Math.round(Math.atan2(d[1], d[0]) / step) * step;
  const l = len(d);
  return [from[0] + Math.cos(a) * l, from[1] + Math.sin(a) * l];
}

/** Polyline of a sub-path (curves subdivided adaptively by length). */
export function flattenSubPath(sp: SubPath, maxStep = 0.25): Vec2[] {
  const out: Vec2[] = [];
  if (!sp.nodes.length) return out;
  out.push(sp.nodes[0].p);
  for (let s = 0; s < segmentCount(sp); s++) {
    const c = segmentOf(sp, s);
    if (!isCurved(sp, s)) {
      out.push(c[3]);
      continue;
    }
    const approx = vdist(c[0], c[1]) + vdist(c[1], c[2]) + vdist(c[2], c[3]);
    const k = Math.max(4, Math.min(200, Math.ceil(approx / maxStep)));
    for (let j = 1; j <= k; j++) out.push(cubicAt(c, j / k));
  }
  return out;
}

/** Points every `step` mm along a polyline (stitch preview). */
export function resample(pts: Vec2[], step: number): Vec2[] {
  if (pts.length < 2 || step <= 0) return pts.slice();
  const out: Vec2[] = [pts[0]];
  let carry = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const l = vdist(a, b);
    let pos = step - carry;
    while (pos <= l) {
      out.push(lerp(a, b, pos / l));
      pos += step;
    }
    carry = l - (pos - step);
  }
  if (vdist(out[out.length - 1], pts[pts.length - 1]) > step * 0.25) out.push(pts[pts.length - 1]);
  return out;
}

// ---------------------------------------------------------------------------
// Schneider curve fitting

function chordParams(pts: Vec2[]): number[] {
  const u = [0];
  for (let i = 1; i < pts.length; i++) u.push(u[i - 1] + vdist(pts[i], pts[i - 1]));
  const total = u[u.length - 1] || 1;
  return u.map((x) => x / total);
}

function generate(pts: Vec2[], u: number[], t1: Vec2, t2: Vec2): Cubic {
  const first = pts[0];
  const last = pts[pts.length - 1];
  const C = [
    [0, 0],
    [0, 0],
  ];
  const X = [0, 0];
  for (let i = 0; i < pts.length; i++) {
    const t = u[i];
    const b1 = 3 * t * (1 - t) * (1 - t);
    const b2 = 3 * t * t * (1 - t);
    const a1 = mul(t1, b1);
    const a2 = mul(t2, b2);
    C[0][0] += dot(a1, a1);
    C[0][1] += dot(a1, a2);
    C[1][0] = C[0][1];
    C[1][1] += dot(a2, a2);
    const b0 = (1 - t) ** 3;
    const b3 = t ** 3;
    const tmp = sub(pts[i], add(add(mul(first, b0), mul(first, b1)), add(mul(last, b2), mul(last, b3))));
    X[0] += dot(a1, tmp);
    X[1] += dot(a2, tmp);
  }
  const det = C[0][0] * C[1][1] - C[1][0] * C[0][1];
  const segLen = vdist(first, last);
  let al = det === 0 ? 0 : (X[0] * C[1][1] - X[1] * C[0][1]) / det;
  let ar = det === 0 ? 0 : (C[0][0] * X[1] - C[1][0] * X[0]) / det;
  const eps = 1e-6 * segLen;
  if (al < eps || ar < eps) al = ar = segLen / 3;
  return [first, add(first, mul(t1, al)), add(last, mul(t2, ar)), last];
}

function maxError(pts: Vec2[], c: Cubic, u: number[]): { d: number; i: number } {
  let d = 0;
  let idx = Math.floor(pts.length / 2);
  for (let i = 1; i < pts.length - 1; i++) {
    const e = vdist(cubicAt(c, u[i]), pts[i]);
    if (e > d) {
      d = e;
      idx = i;
    }
  }
  return { d, i: idx };
}

function reparam(c: Cubic, pts: Vec2[], u: number[]): number[] {
  // one Newton–Raphson step per point
  const d1: Vec2[] = [mul(sub(c[1], c[0]), 3), mul(sub(c[2], c[1]), 3), mul(sub(c[3], c[2]), 3)];
  const d2: Vec2[] = [mul(sub(d1[1], d1[0]), 2), mul(sub(d1[2], d1[1]), 2)];
  const quad = (q: Vec2[], t: number): Vec2 => {
    const s = 1 - t;
    return [s * s * q[0][0] + 2 * s * t * q[1][0] + t * t * q[2][0], s * s * q[0][1] + 2 * s * t * q[1][1] + t * t * q[2][1]];
  };
  return u.map((t, i) => {
    const p = sub(cubicAt(c, t), pts[i]);
    const q1 = quad(d1, t);
    const q2 = lerp(d2[0], d2[1], t);
    const den = dot(q1, q1) + dot(p, q2);
    if (Math.abs(den) < 1e-12) return t;
    return Math.max(0, Math.min(1, t - dot(p, q1) / den));
  });
}

function fitCubic(pts: Vec2[], t1: Vec2, t2: Vec2, err: number, out: Cubic[]) {
  if (pts.length === 2) {
    const d = vdist(pts[0], pts[1]) / 3;
    out.push([pts[0], add(pts[0], mul(t1, d)), add(pts[1], mul(t2, d)), pts[1]]);
    return;
  }
  let u = chordParams(pts);
  let c = generate(pts, u, t1, t2);
  let { d, i } = maxError(pts, c, u);
  if (d < err) {
    out.push(c);
    return;
  }
  if (d < err * 4) {
    for (let k = 0; k < 20; k++) {
      u = reparam(c, pts, u);
      c = generate(pts, u, t1, t2);
      ({ d, i } = maxError(pts, c, u));
      if (d < err) {
        out.push(c);
        return;
      }
    }
  }
  // split at the worst point with a shared tangent
  const tc = norm(sub(pts[i - 1], pts[i + 1]));
  fitCubic(pts.slice(0, i + 1), t1, tc, err, out);
  fitCubic(pts.slice(i), mul(tc, -1), t2, err, out);
}

/** Indices where the stroke turns sharply (kept as corners). */
function cornerIndices(pts: Vec2[], angleDeg: number, reach: number): number[] {
  const out: number[] = [];
  const cos = Math.cos((angleDeg * Math.PI) / 180);
  for (let i = 1; i < pts.length - 1; i++) {
    // look a little way along the stroke so jitter doesn't count
    let a = i - 1;
    while (a > 0 && vdist(pts[a], pts[i]) < reach) a--;
    let b = i + 1;
    while (b < pts.length - 1 && vdist(pts[b], pts[i]) < reach) b++;
    const u = norm(sub(pts[i], pts[a]));
    const v = norm(sub(pts[b], pts[i]));
    if (dot(u, v) < cos) {
      // keep the sharpest point of a run
      const prev = out[out.length - 1];
      if (prev !== undefined && vdist(pts[prev], pts[i]) < reach) {
        const pu = norm(sub(pts[prev], pts[Math.max(0, prev - 1)]));
        const pv = norm(sub(pts[Math.min(pts.length - 1, prev + 1)], pts[prev]));
        if (dot(u, v) < dot(pu, pv)) out[out.length - 1] = i;
      } else out.push(i);
    }
  }
  return out;
}

/** Curve fitting options shared by every tool that fits curves. */
export interface FitOptions {
  /** Straight runs become straight segments (lines stay lines). */
  lines?: boolean;
  /** Join neighbouring curves where one curve fits as well (fewer nodes). */
  merge?: boolean;
}

/** Direction of a stroke at index `i`, averaged over `reach` along it (forwards or backwards). */
function tangentAt(pts: Vec2[], i: number, forward: boolean, reach: number): Vec2 {
  let acc: Vec2 = [0, 0];
  const step = forward ? 1 : -1;
  for (let k = i + step; k >= 0 && k < pts.length; k += step) {
    const d = sub(pts[k], pts[i]);
    const l = len(d);
    if (l < 1e-9) continue;
    acc = add(acc, mul(d, 1 / l));
    if (l > reach) break;
  }
  const n = norm(acc);
  return len(n) > 0 ? n : norm(sub(pts[Math.max(0, Math.min(pts.length - 1, i + step))], pts[i]));
}

/** Straight runs of a stroke part: [from, to] index pairs whose points stay within `err` of the chord. */
function straightRuns(pts: Vec2[], err: number, minLen: number): [number, number][] {
  const out: [number, number][] = [];
  const within = (i: number, j: number) => {
    const a = pts[i];
    const ab = sub(pts[j], a);
    const l = len(ab);
    if (l < 1e-9) return true;
    for (let k = i + 1; k < j; k++) {
      const d = Math.abs((pts[k][0] - a[0]) * ab[1] - (pts[k][1] - a[1]) * ab[0]) / l;
      if (d > err) return false;
    }
    return true;
  };
  let i = 0;
  while (i < pts.length - 2) {
    let j = i + 2;
    while (j < pts.length && within(i, j)) j++;
    j--;
    if (j - i >= 3 && vdist(pts[i], pts[j]) >= minLen) {
      out.push([i, j]);
      i = j;
    } else i++;
  }
  return out;
}

/** Join neighbouring curves (smooth joints only) where one curve fits both within `err`. */
function mergeCurves(curves: Cubic[], err: number, corners: Set<number>): Cubic[] {
  const out = [...curves];
  let changed = true;
  while (changed) {
    changed = false;
    for (let k = 0; k + 1 < out.length; k++) {
      if (corners.has(k)) continue;
      const [c1, c2] = [out[k], out[k + 1]];
      // two lines in a row that are one line (hand jitter split them)
      if (isLine(c1) && isLine(c2)) {
        const ab = sub(c2[3], c1[0]);
        const l = len(ab);
        const off = l < 1e-9 ? 0 : Math.abs((c1[3][0] - c1[0][0]) * ab[1] - (c1[3][1] - c1[0][1]) * ab[0]) / l;
        if (off < err) {
          out.splice(k, 2, lineCubic(c1[0], c2[3]));
          const shifted = [...corners].map((x) => (x > k ? x - 1 : x));
          corners.clear();
          shifted.forEach((x) => corners.add(x));
          changed = true;
        }
        continue;
      }
      // a line next to a curve stays as it is
      if (isLine(c1) || isLine(c2)) continue;
      const pts: Vec2[] = [];
      for (let i = 0; i <= 12; i++) pts.push(cubicAt(c1, i / 12));
      for (let i = 1; i <= 12; i++) pts.push(cubicAt(c2, i / 12));
      const t1 = norm(sub(c1[1], c1[0]));
      const t2 = norm(sub(c2[2], c2[3]));
      if (!len(t1) || !len(t2)) continue;
      let u = chordParams(pts);
      let c = generate(pts, u, t1, t2);
      let { d } = maxError(pts, c, u);
      for (let it = 0; it < 12 && d >= err; it++) {
        u = reparam(c, pts, u);
        c = generate(pts, u, t1, t2);
        ({ d } = maxError(pts, c, u));
      }
      if (d < err) {
        out.splice(k, 2, c);
        // the corner marks after this joint move one back
        const shifted = [...corners].map((x) => (x > k ? x - 1 : x));
        corners.clear();
        shifted.forEach((x) => corners.add(x));
        changed = true;
      }
    }
  }
  return out;
}

const LINE = Symbol("line");
type LineCubic = Cubic & { [LINE]?: true };
const isLine = (c: Cubic) => !!(c as LineCubic)[LINE];
function lineCubic(a: Vec2, b: Vec2): Cubic {
  const c = [a, lerp(a, b, 1 / 3), lerp(a, b, 2 / 3), b] as LineCubic;
  c[LINE] = true;
  return c;
}

/**
 * Fit a smooth Bézier path through a stroke. `error` is the allowed deviation
 * (mm); sharp turns (more than `cornerDeg`) stay corners.
 */
export function fitPath(raw: Vec2[], error: number, closed = false, cornerDeg = 70, cornerReach = Math.max(error * 2, 0.6), opts: FitOptions = {}): SubPath {
  const { lines = true, merge = true } = opts;
  const pts: Vec2[] = [];
  for (const p of raw) if (!pts.length || vdist(pts[pts.length - 1], p) > 1e-6) pts.push(p);
  if (pts.length < 2) return { closed: false, nodes: pts.map((p) => ({ p })) };
  if (closed && vdist(pts[0], pts[pts.length - 1]) > 1e-6) pts.push(pts[0]);
  const corners = cornerIndices(pts, cornerDeg, cornerReach);
  const cuts = [0, ...corners, pts.length - 1];
  const reach = Math.max(error * 3, 0.5);
  // a closed loop without corners: one shared direction at the seam (no kink)
  const seam = closed && !corners.length ? norm(add(tangentAt(pts, 0, true, reach), mul(tangentAt(pts, pts.length - 1, false, reach), -1))) : null;
  const curves: Cubic[] = [];
  // joints that are corners (by index into curves: the joint after curve k)
  const cornerJoints = new Set<number>();
  for (let k = 0; k < cuts.length - 1; k++) {
    const part = pts.slice(cuts[k], cuts[k + 1] + 1);
    if (part.length < 2) continue;
    // pieces: straight runs as lines, the rest as curves meeting them smoothly
    // a straight run must be long: short arcs look straight over a millimetre or two
    const runs = lines ? straightRuns(part, error * 0.8, Math.max(error * 10, 3)) : [];
    const pieces: { a: number; b: number; line: boolean }[] = [];
    let at = 0;
    for (const [i, j] of runs) {
      if (i > at) pieces.push({ a: at, b: i, line: false });
      pieces.push({ a: i, b: j, line: true });
      at = j;
    }
    if (at < part.length - 1) pieces.push({ a: at, b: part.length - 1, line: false });
    pieces.forEach((pc, n) => {
      const seg = part.slice(pc.a, pc.b + 1);
      if (pc.line || seg.length < 3) {
        curves.push(lineCubic(seg[0], seg[seg.length - 1]));
        return;
      }
      const prev = pieces[n - 1];
      const next = pieces[n + 1];
      // tangents: along a neighbouring line, the seam, or estimated over a window
      const t1 = prev?.line ? norm(sub(part[prev.b], part[prev.a])) : !prev && k === 0 && seam ? seam : tangentAt(seg, 0, true, reach);
      const t2 = next?.line ? norm(sub(part[next.a], part[next.b])) : !next && k === cuts.length - 2 && seam ? mul(seam, -1) : tangentAt(seg, seg.length - 1, false, reach);
      fitCubic(seg, t1, t2, error, curves);
    });
    cornerJoints.add(curves.length - 1);
  }
  const fitted = merge ? mergeCurves(curves, error * 0.6, cornerJoints) : curves;
  curves.length = 0;
  curves.push(...fitted);
  const nodes: PathNode[] = [];
  curves.forEach((c, k) => {
    if (k === 0) nodes.push({ p: c[0] });
    nodes[nodes.length - 1].o = c[1];
    nodes.push({ p: c[3], i: c[2] });
  });
  if (closed && nodes.length > 2) {
    // the last node coincides with the first
    const last = nodes.pop()!;
    nodes[0].i = last.i;
  }
  // straight segments don't need handles
  for (let k = 0; k < nodes.length; k++) {
    const a = nodes[k];
    const b = nodes[(k + 1) % nodes.length];
    if (k === nodes.length - 1 && !closed) break;
    if (a.o && b.i) {
      const chord = sub(b.p, a.p);
      const l = len(chord);
      const off = (q: Vec2) => (l < 1e-9 ? 0 : Math.abs((q[0] - a.p[0]) * chord[1] - (q[1] - a.p[1]) * chord[0]) / l);
      if (off(a.o) < error * 0.05 && off(b.i) < error * 0.05) {
        delete a.o;
        delete b.i;
      }
    }
  }
  return { closed: closed && nodes.length > 2, nodes };
}
