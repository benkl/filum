// Curve fitting (npm run test:match): lines stay lines, corners stay corners,
// curves stay within the tolerance with few nodes, closed loops have no seam kink.

import { fitPath, flattenSubPath } from "./bezier";
import type { Vec2 } from "../types";

let failed = 0;
const check = (ok: boolean, msg: string) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${msg}`);
  if (!ok) failed++;
};
const dist = (a: Vec2, b: Vec2) => Math.hypot(a[0] - b[0], a[1] - b[1]);
/** Distance from p to a polyline. */
const near = (pts: Vec2[], p: Vec2) => {
  let best = Infinity;
  for (let i = 1; i < pts.length; i++) {
    const [a, b] = [pts[i - 1], pts[i]];
    const ab = [b[0] - a[0], b[1] - a[1]];
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1]) / Math.max(1e-12, ab[0] ** 2 + ab[1] ** 2)));
    best = Math.min(best, dist(p, [a[0] + ab[0] * t, a[1] + ab[1] * t]));
  }
  return best;
};
const jitter = (pts: Vec2[], k: number) => pts.map(([x, y], i) => [x + Math.sin(i * 12.9898) * k, y + Math.cos(i * 78.233) * k] as Vec2);

// an L: two straight strokes meeting at a corner, hand-drawn jitter
const L: Vec2[] = [];
for (let i = 0; i <= 40; i++) L.push([0, i * 0.5]);
for (let i = 1; i <= 40; i++) L.push([i * 0.5, 20]);
const fl = fitPath(jitter(L, 0.04), 0.15, false, 65);
check(fl.nodes.length === 3, `L: three nodes (${fl.nodes.length})`);
check(fl.nodes.every((n) => !n.i && !n.o), "L: straight segments (no handles)");
check(dist(fl.nodes[1].p, [0, 20]) < 0.3, "L: the corner stays where it was");

// a circle: few nodes, within tolerance, no kink at the seam
const C: Vec2[] = [];
for (let i = 0; i <= 120; i++) {
  const a = (i / 120) * Math.PI * 2;
  C.push([10 * Math.cos(a), 10 * Math.sin(a)]);
}
const fc = fitPath(C, 0.05, true, 65);
check(fc.nodes.length <= 6, `circle: few nodes (${fc.nodes.length})`);
const flat = flattenSubPath(fc, 0.05);
check(flat.every((p) => Math.abs(Math.hypot(p[0], p[1]) - 10) < 0.1), "circle: within the tolerance");
const n0 = fc.nodes[0];
if (n0.i && n0.o) {
  const u = [n0.o[0] - n0.p[0], n0.o[1] - n0.p[1]];
  const v = [n0.p[0] - n0.i[0], n0.p[1] - n0.i[1]];
  const cos = (u[0] * v[0] + u[1] * v[1]) / (Math.hypot(u[0], u[1]) * Math.hypot(v[0], v[1]));
  check(cos > 0.99, `circle: smooth seam (cos ${cos.toFixed(3)})`);
} else check(false, "circle: seam has handles");

// a line then an arc: the line stays straight, the arc joins it smoothly
const LA: Vec2[] = [];
for (let i = 0; i <= 30; i++) LA.push([i * 0.5, 0]);
for (let i = 1; i <= 40; i++) {
  const a = (i / 40) * Math.PI;
  LA.push([15 + 5 * Math.sin(a), 5 - 5 * Math.cos(a)]);
}
const fa = fitPath(LA, 0.05, false, 65);
check(!fa.nodes[0].o, "line + arc: the line is straight");
const j = fa.nodes[1];
check(!!j.o && Math.abs(j.o[1] - j.p[1]) < 0.05, "line + arc: the arc leaves along the line (G1)");
check(flattenSubPath(fa, 0.05).every((p) => near(LA, p) < 0.12), "line + arc: within the tolerance");
// without line detection the straight part is still fitted
check(fitPath(LA, 0.05, false, 65, undefined, { lines: false }).nodes.length >= 2, "lines off: still fits");

console.log(failed ? `${failed} FAILED` : "all passed");
if (failed) throw new Error(`${failed} curve fitting checks failed`);
