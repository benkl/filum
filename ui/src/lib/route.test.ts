// Auto-route running stitch (npm run test:match): crossing lines become one
// continuous path, every line sewn, as few repeats as needed.

import { routeRunning } from "./route";
import type { Vec2 } from "../types";

let failed = 0;
const check = (ok: boolean, msg: string) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${msg}`);
  if (!ok) failed++;
};
const len = (p: Vec2[]) => p.slice(1).reduce((l, q, i) => l + Math.hypot(q[0] - p[i][0], q[1] - p[i][1]), 0);
const onPath = (path: Vec2[], q: Vec2) =>
  path.slice(1).some((b, i) => {
    const a = path[i];
    const ab = [b[0] - a[0], b[1] - a[1]];
    const t = Math.max(0, Math.min(1, ((q[0] - a[0]) * ab[0] + (q[1] - a[1]) * ab[1]) / Math.max(1e-12, ab[0] ** 2 + ab[1] ** 2)));
    return Math.hypot(a[0] + ab[0] * t - q[0], a[1] + ab[1] * t - q[1]) < 0.05;
  });

// a plus sign: two crossing lines → one path (one arm sewn twice)
const plus: Vec2[][] = [
  [[-10, 0], [10, 0]],
  [[0, -10], [0, 10]],
];
const r = routeRunning(plus);
check(r.length === 1, `plus: one path (${r.length})`);
check([[-10, 0], [10, 0], [0, -10], [0, 10]].every((q) => onPath(r[0], q as Vec2)), "plus: every arm sewn");
// four line ends: the walk starts and ends at two, the other two are joined through the centre (the optimum)
check(Math.abs(len(r[0]) - 60) < 0.5, `plus: 40 mm of lines + 20 mm travelled twice (${len(r[0]).toFixed(1)})`);

// a square of four separate strokes: one closed walk, nothing repeated
const sq: Vec2[][] = [
  [[0, 0], [10, 0]],
  [[10, 0], [10, 10]],
  [[0, 10], [10, 10]],
  [[0, 0], [0, 10]],
];
const rs = routeRunning(sq);
check(rs.length === 1 && Math.abs(len(rs[0]) - 40) < 0.1, `square: one walk, no repeats (${rs.length}, ${len(rs[0]).toFixed(1)})`);

// two separate parts: two paths, nearest first
const two = routeRunning([[[0, 0], [5, 0]], [[50, 0], [55, 0]]], { start: [56, 0] });
check(two.length === 2 && two[0][0][0] > 49, "two parts: two paths, the nearer first");

// redwork: the plus sign out and back — 80 mm, ending where it began
const red = routeRunning(plus, { redwork: true });
check(red.length === 1 && Math.abs(len(red[0]) - 80) < 0.5, `redwork: every line twice (${len(red[0]).toFixed(1)})`);
check(Math.hypot(red[0][0][0] - red[0][red[0].length - 1][0], red[0][0][1] - red[0][red[0].length - 1][1]) < 0.01, "redwork: ends at the start");

console.log(failed ? `${failed} FAILED` : "all passed");
if (failed) throw new Error(`${failed} routing checks failed`);
