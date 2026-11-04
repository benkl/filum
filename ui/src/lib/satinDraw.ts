// Satin column drawing: variable-width centre line → live column preview and
// the final object. Uniform width produces a centre-line satin (editable with
// width handles); varying widths produce a true two-rail satin whose rails
// have matching nodes, so every node pair acts as a rung (Ink/Stitch's
// convention) and the stitch angle follows the drawing.

import type { PathNode, SubPath, Vec2 } from "../types";

const unit = (x: number, y: number): Vec2 => {
  const l = Math.hypot(x, y);
  return l < 1e-12 ? [0, 0] : [x / l, y / l];
};

function cubic(a: Vec2, c1: Vec2, c2: Vec2, b: Vec2, t: number): Vec2 {
  const u = 1 - t;
  return [
    u * u * u * a[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * b[0],
    u * u * u * a[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * b[1],
  ];
}

/** Centre line samples with interpolated widths, and both column edges. */
export function satinOutlineOf(nodes: PathNode[], widths: number[], closed = false, steps = 14) {
  const center: Vec2[] = [];
  const w: number[] = [];
  const n = nodes.length;
  if (!n) return { center, w, left: [] as Vec2[], right: [] as Vec2[] };
  center.push(nodes[0].p);
  w.push(widths[0]);
  const segs = closed ? n : n - 1;
  for (let s = 0; s < segs; s++) {
    const a = nodes[s];
    const b = nodes[(s + 1) % n];
    const wa = widths[s];
    const wb = widths[(s + 1) % n];
    const curved = !!(a.o || b.i);
    const k = curved ? steps : 1;
    for (let j = 1; j <= k; j++) {
      const t = j / k;
      center.push(curved ? cubic(a.p, a.o ?? a.p, b.i ?? b.p, b.p, t) : [a.p[0] + (b.p[0] - a.p[0]) * t, a.p[1] + (b.p[1] - a.p[1]) * t]);
      w.push(wa + (wb - wa) * t);
    }
  }
  const left: Vec2[] = [];
  const right: Vec2[] = [];
  const m = center.length;
  for (let i = 0; i < m; i++) {
    const prev = i > 0 ? center[i - 1] : closed ? center[m - 2] ?? center[i] : center[i];
    const next = i < m - 1 ? center[i + 1] : closed ? center[1] ?? center[i] : center[i];
    const t0 = i > 0 || closed ? unit(center[i][0] - prev[0], center[i][1] - prev[1]) : unit(next[0] - center[i][0], next[1] - center[i][1]);
    const t1 = i < m - 1 || closed ? unit(next[0] - center[i][0], next[1] - center[i][1]) : t0;
    let nx = -(t0[1] + t1[1]);
    let ny = t0[0] + t1[0];
    const l = Math.hypot(nx, ny);
    if (l < 1e-9) {
      nx = -t0[1];
      ny = t0[0];
    } else {
      nx /= l;
      ny /= l;
    }
    // mitre, limited so sharp corners don't spike
    const cos = Math.max(0.35, nx * -t1[1] + ny * t1[0]);
    const h = w[i] / 2 / cos;
    left.push([center[i][0] - nx * h, center[i][1] - ny * h]);
    right.push([center[i][0] + nx * h, center[i][1] + ny * h]);
  }
  return { center, w, left, right };
}

/** Zig-zag preview: (a, b) pairs across the column every `spacing` mm along it. */
export function zigzagPreview(left: Vec2[], right: Vec2[], center: Vec2[], spacing: number): [Vec2, Vec2][] {
  const out: [Vec2, Vec2][] = [];
  if (center.length < 2) return out;
  let acc = 0;
  let next = 0;
  for (let i = 1; i < center.length; i++) {
    const l = Math.hypot(center[i][0] - center[i - 1][0], center[i][1] - center[i - 1][1]);
    while (next <= acc + l && l > 0) {
      const t = (next - acc) / l;
      const a: Vec2 = [left[i - 1][0] + (left[i][0] - left[i - 1][0]) * t, left[i - 1][1] + (left[i][1] - left[i - 1][1]) * t];
      const b: Vec2 = [right[i - 1][0] + (right[i][0] - right[i - 1][0]) * t, right[i - 1][1] + (right[i][1] - right[i - 1][1]) * t];
      out.push(out.length % 2 ? [b, a] : [a, b]);
      next += spacing;
    }
    acc += l;
  }
  return out;
}

/** Tangent at node i of a sub-path (uses handles when present). */
function nodeTangent(nodes: PathNode[], i: number, closed: boolean): Vec2 {
  const n = nodes.length;
  const p = nodes[i].p;
  if (nodes[i].o) return unit(nodes[i].o![0] - p[0], nodes[i].o![1] - p[1]);
  if (nodes[i].i) return unit(p[0] - nodes[i].i![0], p[1] - nodes[i].i![1]);
  const prev = i > 0 ? nodes[i - 1].p : closed ? nodes[n - 1].p : p;
  const next = i < n - 1 ? nodes[i + 1].p : closed ? nodes[0].p : p;
  const a = unit(p[0] - prev[0], p[1] - prev[1]);
  const b = unit(next[0] - p[0], next[1] - p[1]);
  const t = unit(a[0] + b[0], a[1] + b[1]);
  return t[0] || t[1] ? t : a[0] || a[1] ? a : b;
}

/** Final geometry: centre line + width, or two rails for a varying width. */
export function buildSatin(nodes: PathNode[], widths: number[], closed: boolean): { paths: SubPath[]; width: number } {
  const w0 = widths[0];
  if (widths.every((w) => Math.abs(w - w0) < 0.01)) return { paths: [{ nodes, closed }], width: w0 };
  const left: PathNode[] = [];
  const right: PathNode[] = [];
  nodes.forEach((nd, i) => {
    const t = nodeTangent(nodes, i, closed);
    const n: Vec2 = [-t[1], t[0]];
    const h = widths[i] / 2;
    const off = (q: Vec2 | undefined, s: number): Vec2 | undefined => (q ? [q[0] + n[0] * h * s, q[1] + n[1] * h * s] : undefined);
    const mk = (s: number): PathNode => {
      const node: PathNode = { p: off(nd.p, s)! };
      if (nd.i) node.i = off(nd.i, s);
      if (nd.o) node.o = off(nd.o, s);
      return node;
    };
    left.push(mk(-1));
    right.push(mk(1));
  });
  return { paths: [{ nodes: left, closed }, { nodes: right, closed }], width: Math.max(...widths) };
}
