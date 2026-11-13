// Connect line pieces into continuous lines (npm run test:match).

import type { SubPath, Vec2 } from "../types";
import { connectLines, DEFAULT_CONNECT, doubledPieces, nearestPairs, reversePiece } from "./connectLines";

let failed = 0;
const check = (ok: boolean, msg: string) => {
  if (!ok) {
    failed++;
    console.log("FAIL", msg);
  } else console.log("ok  ", msg);
};
const line = (...pts: Vec2[]): SubPath => ({ closed: false, nodes: pts.map((p) => ({ p })) });
const near = (a: Vec2, b: Vec2, e = 1e-6) => Math.hypot(a[0] - b[0], a[1] - b[1]) < e;
const pts = (sp: SubPath) => sp.nodes.map((n) => n.p);

// a stroke in five pieces, shuffled and some turned round: one line, in order
const pieces = [line([0, 0], [10, 0]), line([10, 0], [20, 5]), line([20, 5], [30, 5]), line([30, 5], [40, 0]), line([40, 0], [50, 0])];
const shuffled = [pieces[3], reversePiece(pieces[0]), pieces[4], reversePiece(pieces[2]), pieces[1]];
const r = connectLines(shuffled);
check(r.lines === 1 && r.paths.length === 1, "five pieces end to end: one line");
const xs = pts(r.paths[0]).map((p) => p[0]);
check(xs.length === 6 && (xs.join() === "0,10,20,30,40,50" || xs.join() === "50,40,30,20,10,0"), "in the stroke's order, each junction one node");

// a square in four pieces: one closed path
const sq = connectLines([line([0, 0], [10, 0]), line([10, 10], [10, 0]), line([10, 10], [0, 10]), line([0, 0], [0, 10])]);
check(sq.lines === 1 && sq.paths[0].closed && sq.paths[0].nodes.length === 4, "four sides: one closed path of four corners");

// an X: four strokes meeting in the middle become two straight lines
const x = connectLines([line([0, 0], [5, 5]), line([10, 10], [5, 5]), line([0, 10], [5, 5]), line([10, 0], [5, 5])], { ...DEFAULT_CONNECT, bridge: 0 });
check(x.lines === 2, "an X of four strokes: two lines");
const straightThrough = x.paths.every((sp) => {
  const [a, , c] = pts(sp);
  return sp.nodes.length === 3 && (near([a[0] + c[0], a[1] + c[1]], [10, 10]) || near([a[0] - c[0], a[1] - c[1]], [0, 0]));
});
check(straightThrough && x.paths.every((sp) => { const [a, , c] = pts(sp); return Math.abs(a[0] - c[0]) === 10 && Math.abs(a[1] - c[1]) === 10; }), "straight through the crossing, not round the corner");

// a T: the bar stays one straight line, the stem the other
const t = connectLines([line([0, 0], [5, 0]), line([5, 0], [10, 0]), line([5, 0], [5, 8])], { ...DEFAULT_CONNECT, bridge: 0 });
check(t.lines === 2 && t.paths.some((sp) => sp.nodes.length === 3 && Math.abs(pts(sp)[0][0] - pts(sp)[2][0]) === 10), "a T: the bar goes straight on");

// a small gap: bridged (one line); without bridging: two
const gap = [line([0, 0], [10, 0]), line([11, 0], [20, 0])];
check(connectLines(gap).lines === 1 && connectLines(gap).bridged === 1, "a 1 mm gap is bridged");
check(connectLines(gap, { ...DEFAULT_CONNECT, bridge: 0 }).lines === 2, "without bridging the pieces stay two lines");
check(connectLines([line([0, 0], [10, 0]), line([15, 0], [20, 0])]).lines === 2, "a gap wider than the bridge stays a gap");
check(connectLines([line([0, 0], [10, 0]), line([10.3, 0.2], [20, 0])]).lines === 1, "ends within the join distance meet");

// a doubled stroke is left out
const dbl = [line([0, 0], [10, 0]), line([10, 0], [20, 0]), line([2, 0.1], [8, 0.1])];
check(doubledPieces(dbl).has(2) && !doubledPieces(dbl).has(0), "a piece on top of another is found");
const d = connectLines(dbl);
check(d.doubled === 1 && d.lines === 1, "doubled pieces left out, the rest one line");

// curves keep their handles
const c1: SubPath = { closed: false, nodes: [{ p: [0, 0], o: [3, 4] }, { p: [10, 0], i: [7, 4] }] };
const c2: SubPath = { closed: false, nodes: [{ p: [20, 0], o: [17, -4] }, { p: [10, 0], i: [13, -4] }] };
const cc = connectLines([c1, c2]);
const mid = cc.paths[0].nodes[1];
check(cc.lines === 1 && !!mid.i && !!mid.o && near(mid.p, [10, 0]), "curved pieces: the junction keeps the handle on both sides");

// closed paths stay as they are
check(connectLines([{ closed: true, nodes: [{ p: [0, 0] }, { p: [5, 0] }, { p: [5, 5] }] }, line([20, 0], [30, 0])]).paths.length === 2, "closed shapes are left alone");

// many loose ends (a hatching drawing): paired nearest first, quickly, without
// comparing every pair (thousands of pieces ran out of memory)
{
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const many: Vec2[] = Array.from({ length: 8001 }, () => [rnd() * 300, rnd() * 300] as Vec2);
  const ids = many.map((_, i) => i);
  const t0 = Date.now();
  const pairs = nearestPairs(many, ids);
  const seen = new Set(pairs.flat());
  check(pairs.length === 4000 && seen.size === 8000, "8,001 ends: 4,000 pairs, each end once");
  check(Date.now() - t0 < 5000, `8,001 ends paired in ${Date.now() - t0} ms`);
  const mean = pairs.reduce((s, [u, v]) => s + Math.hypot(many[u][0] - many[v][0], many[u][1] - many[v][1]), 0) / pairs.length;
  check(mean < 5, `mostly near neighbours (mean ${mean.toFixed(2)} mm)`);
  // few ends: every pair compared, the nearest pair first
  const few: Vec2[] = [[0, 0], [100, 0], [1, 0], [100, 2]];
  const fp = nearestPairs(few, [0, 1, 2, 3]);
  check(fp.length === 2 && fp[0].join() === "0,2" && fp[1].join() === "1,3", "few ends: nearest pairs first");
}

console.log(failed ? `${failed} FAILED` : "all passed");
if (failed) throw new Error(`${failed} connect checks failed`);
