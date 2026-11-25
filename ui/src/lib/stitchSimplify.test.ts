// Simplify for stitching: pixel staircases become curves, real corners and clean paths stay.
import type { SubPath, Vec2 } from "../types";
import { flattenSubPath } from "./bezier";
import { simplify } from "./shapeOps";
import { simplifyForStitching } from "./stitchSimplify";

let failed = 0;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failed++;
};

/** Furthest distance from any point of `a` to the polyline `b`. */
function hausdorff(a: Vec2[], b: Vec2[]): number {
  const seg = (p: Vec2, s: Vec2, e: Vec2) => {
    const dx = e[0] - s[0];
    const dy = e[1] - s[1];
    const l2 = dx * dx + dy * dy;
    const t = l2 < 1e-12 ? 0 : Math.max(0, Math.min(1, ((p[0] - s[0]) * dx + (p[1] - s[1]) * dy) / l2));
    return Math.hypot(s[0] + dx * t - p[0], s[1] + dy * t - p[1]);
  };
  let worst = 0;
  for (const p of a) {
    let d = Infinity;
    for (let i = 1; i < b.length; i++) d = Math.min(d, seg(p, b[i - 1], b[i]));
    worst = Math.max(worst, d);
  }
  return worst;
}

// a pixel staircase along a 30° line, 0.5 mm pixels
const stair: Vec2[] = [[0, 0]];
{
  let x = 0;
  let y = 0;
  while (x < 30) {
    x += 0.5;
    stair.push([x, y]);
    if (y + 0.5 <= x * 0.577) {
      y += 0.5;
      stair.push([x, y]);
    }
  }
}
const stairPath: SubPath = { closed: false, nodes: stair.map((p) => ({ p })) };
const s = simplifyForStitching(stairPath);
check(s.nodes.length <= 4, `a 95-node pixel staircase becomes ${s.nodes.length} nodes (the plain Simplify keeps ${simplify(stairPath, 0.3).nodes.length})`);
check(hausdorff(flattenSubPath(s, 0.05), stair) <= 0.45, "it stays within a pixel of the staircase");
check(Math.hypot(s.nodes[0].p[0], s.nodes[0].p[1]) < 1e-6, "the path still starts where it did");

// a 10 mm square keeps its four corners exactly
const square: SubPath = { closed: true, nodes: ([[0, 0], [10, 0], [10, 10], [0, 10]] as Vec2[]).map((p) => ({ p })) };
const sq = simplifyForStitching(square);
check(sq === square, "a clean square is left as it is");

// a square traced in 0.5 mm pixels with a 1 px jog on each side: its corners stay, the jogs go
const traced: Vec2[] = [];
for (let x = 0; x < 10; x += 0.5) traced.push([x, x === 5 ? 0.5 : 0]);
for (let y = 0; y < 10; y += 0.5) traced.push([10, y]);
for (let x = 10; x > 0; x -= 0.5) traced.push([x, 10]);
for (let y = 10; y > 0; y -= 0.5) traced.push([0, y]);
const tq = simplifyForStitching({ closed: true, nodes: traced.map((p) => ({ p })) });
const has = (c: Vec2) => tq.nodes.some((n) => Math.hypot(n.p[0] - c[0], n.p[1] - c[1]) < 0.05);
check(has([0, 0]) && has([10, 0]) && has([10, 10]) && has([0, 10]), `a traced square keeps its four corners (${tq.nodes.length} nodes)`);
check(tq.nodes.length <= 8, `and loses its pixel nodes (${traced.length} → ${tq.nodes.length})`);

// a circle of 2 mm radius stays round, within the tolerance
const circle: Vec2[] = Array.from({ length: 120 }, (_, i) => [2 * Math.cos((i / 120) * 2 * Math.PI), 2 * Math.sin((i / 120) * 2 * Math.PI)] as Vec2);
const ci = simplifyForStitching({ closed: true, nodes: circle.map((p) => ({ p })) });
const radii = flattenSubPath(ci, 0.05).map((p) => Math.hypot(p[0], p[1]));
check(ci.closed && Math.max(...radii.map((r) => Math.abs(r - 2))) < 0.25, `a 2 mm circle stays within 0.25 mm of its radius (${ci.nodes.length} nodes)`);

console.log(failed ? `${failed} FAILED` : "all passed");
if (failed) throw new Error(`${failed} simplify checks failed`);
