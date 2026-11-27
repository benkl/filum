// Polylines walked by arc length: the running lengths, the point at a length,
// whether two segments cross.

import type { Vec2 } from "../types";
import { dist, lerp } from "./vec";

/** Running arc length at each point (closed: one more entry, back to the first point). */
export function cumulative(p: Vec2[], closed = false): number[] {
  const c = [0];
  for (let i = 1; i < p.length; i++) c.push(c[i - 1] + dist(p[i - 1], p[i]));
  if (closed && p.length) c.push(c[c.length - 1] + dist(p[p.length - 1], p[0]));
  return c;
}

/** The point at arc length `d` (clamped) along a polyline with running lengths `c` (closed: `c` has the closing entry). */
export function pointAt(p: Vec2[], c: number[], d: number): Vec2 {
  const x = Math.max(0, Math.min(c[c.length - 1], d));
  let lo = 0;
  let hi = c.length - 1;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (c[m] < x) lo = m;
    else hi = m;
  }
  const seg = c[hi] - c[lo];
  const q = p[hi % p.length];
  return seg <= 1e-12 ? q : lerp(p[lo], q, (x - c[lo]) / seg);
}

/** Whether segments a→b and c→d cross (touching at an end does not count). */
export function segmentsCross(a: Vec2, b: Vec2, c: Vec2, d: Vec2) {
  const o = (p: Vec2, q: Vec2, r: Vec2) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  return o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0;
}
