// Path conversions: npm run test:match (bundled with esbuild, run in Node).

import { flattenSubPath } from "./bezier";
import { centreLineToRails, patternSatin, patternTile, removeDuplicatePoints, satinPaths, segmentHit, zigzagToSatin } from "./convert";
import type { SubPath, Vec2 } from "../types";

let failed = 0;
const check = (ok: boolean, msg: string) => {
  console.log((ok ? "ok   " : "FAIL ") + msg);
  if (!ok) failed++;
};
const line = (...pts: Vec2[]): SubPath => ({ nodes: pts.map((p) => ({ p })), closed: false });
const lengthOf = (sp: SubPath) => {
  const pts = flattenSubPath(sp, 0.1);
  return pts.reduce((s, p, i) => (i ? s + Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) : 0), 0);
};
/** Crossings of a rung with a rail. */
const crossings = (rung: SubPath, rail: SubPath) => {
  const r = flattenSubPath(rail, 0.1);
  const [a, b] = [rung.nodes[0].p, rung.nodes[rung.nodes.length - 1].p];
  const seen: Vec2[] = [];
  for (let i = 1; i < r.length; i++) {
    const h = segmentHit(a, b, r[i - 1], r[i]);
    if (h && !seen.some((q) => Math.hypot(q[0] - h.p[0], q[1] - h.p[1]) < 1e-6)) seen.push(h.p);
  }
  return seen.length;
};

// --- remove duplicated points
{
  const sp = line([0, 0], [5, 0], [5, 0.001], [10, 0], [10, 0]);
  const r = removeDuplicatePoints(sp);
  check(r.removed === 2 && r.sp.nodes.length === 3, `duplicates removed (${r.removed})`);
  const far = removeDuplicatePoints(line([0, 0], [5, 0], [10, 0], [5, 0]), { distance: 0.01, window: 1 });
  check(far.removed === 0, "a revisit beyond the window stays");
  const near = removeDuplicatePoints(line([0, 0], [5, 0], [10, 0], [5, 0]), { distance: 0.01, window: 10 });
  check(near.removed === 1, "a revisit within the window goes");
  const curve: SubPath = { closed: false, nodes: [{ p: [0, 0], o: [2, 2] }, { p: [5, 0], i: [3, 2] }, { p: [5, 0], o: [7, -2] }, { p: [10, 0], i: [8, -2] }] };
  const c = removeDuplicatePoints(curve).sp;
  check(c.nodes.length === 3 && c.nodes[1].i?.[0] === 3 && c.nodes[1].o?.[0] === 7, "curve handles survive at the merged node");
  const closed: SubPath = { closed: true, nodes: [{ p: [0, 0] }, { p: [10, 0] }, { p: [10, 10] }, { p: [0, 0] }] };
  check(removeDuplicatePoints(closed).sp.nodes.length === 3, "closing duplicate of a closed path goes");
}

// --- centre line → rails and rungs
{
  const r = centreLineToRails(line([0, 0], [40, 0]), 4);
  check(!!r && r.rungs.length >= 1, `straight line: rails and ${r?.rungs.length} rung(s)`);
  if (r) {
    const ys = [...r.rails[0], ...r.rails[1]].map((p) => Math.abs(p[1]));
    check(ys.every((y) => Math.abs(y - 2) < 1e-6), "rails at half the width");
    const paths = satinPaths(r);
    check(paths[0].nodes.length >= 3 && paths[1].nodes.length >= 3, "rails have three or more nodes (read as rails)");
    check(paths.slice(2).every((g) => crossings(g, paths[0]) === 1 && crossings(g, paths[1]) === 1), "every rung crosses both rails once");
  }
  // an L: the rungs stay away from the corner
  const l = centreLineToRails(line([0, 0], [30, 0], [30, 30]), 4);
  check(!!l && l.rungs.every(([a, b]) => Math.hypot((a[0] + b[0]) / 2 - 30, (a[1] + b[1]) / 2) > 2), "no rung at the corner (rungs ±5 % around it)");
  // a closed square
  const sq: SubPath = { closed: true, nodes: [{ p: [0, 0] }, { p: [30, 0] }, { p: [30, 30] }, { p: [0, 30] }] };
  const s = centreLineToRails(sq, 3);
  check(!!s && s.rungs.length >= 1, "closed loop converts with a joining rung");
  if (s) {
    const inner = Math.min(lengthOf(line(...s.rails[0])), lengthOf(line(...s.rails[1])));
    const outer = Math.max(lengthOf(line(...s.rails[0])), lengthOf(line(...s.rails[1])));
    check(Math.abs(inner - 108) < 2 && Math.abs(outer - 132) < 2, `loop rails ${inner.toFixed(1)} / ${outer.toFixed(1)}`);
  }
}

// --- zig-zag line to satin
{
  // square pattern: up, across, down, across … between y = 0 and y = 4
  const pts: Vec2[] = [];
  for (let k = 0; k < 6; k++) {
    const x = k * 4;
    pts.push(...(k % 2 === 0 ? ([[x, 0], [x, 4]] as Vec2[]) : ([[x, 4], [x, 0]] as Vec2[])));
  }
  const sq = zigzagToSatin(pts, { pattern: "square", smoothing: false, rungs: true, reduceRungs: false });
  check(!!sq && sq.length >= 3, `square: rails and rungs (${sq?.length} paths)`);
  if (sq) {
    const r0 = sq[0].nodes.map((n) => n.p[1]);
    const r1 = sq[1].nodes.map((n) => n.p[1]);
    check(r0.every((y) => y === 0) && r1.every((y) => y === 4), "square: one rail on each edge");
  }
  const saw: Vec2[] = [];
  for (let k = 0; k < 8; k++) saw.push([k * 2, k % 2 ? 4 : 0]);
  const st = zigzagToSatin(saw, { pattern: "sawtooth", smoothing: true, rungs: true, reduceRungs: false });
  check(!!st && st[0].nodes.length === 4 && st[1].nodes.length === 4, "sawtooth: alternate points per rail");
  const zz = zigzagToSatin(saw, { pattern: "zigzag", smoothing: true, rungs: true, reduceRungs: false });
  check(!!zz && zz.length > 2, `zigzag: rungs along the drawn line (${(zz?.length ?? 2) - 2})`);
}

// --- patterned satin
{
  const t = patternTile({ pattern: "diamond", minWidth: 2, maxWidth: 6, length: 10, stretched: false, rungs: true });
  const ys = [...t.edges[0], ...t.edges[1]].flatMap((s) => [s[0][1], s[3][1]]);
  check(Math.abs(Math.max(...ys) - Math.min(...ys) - 6) < 1e-9, "diamond tile spans the max width");
  const ps = patternSatin(line([0, 0], [45, 0]), { pattern: "diamond", minWidth: 2, maxWidth: 6, length: 10, stretched: false, rungs: true });
  check(!!ps && ps.length === 2 + 4, `4 whole repeats on 45 mm, one rung each (${ps?.length})`);
  if (ps) {
    check(ps[0].nodes.length === ps[1].nodes.length, "rails have matching nodes");
    const xs = ps[0].nodes.map((n) => n.p[0]);
    check(Math.abs(Math.max(...xs) - 40) < 1e-6, "not stretched: ends after the last whole repeat");
    const ys0 = ps[0].nodes.map((n) => n.p[1]);
    const ys1 = ps[1].nodes.map((n) => n.p[1]);
    check(Math.abs(Math.max(...ys0.map(Math.abs)) - 3) < 1e-6 && Math.abs(Math.min(...ys1.map(Math.abs)) - 1) < 1e-6, "centred on the line: 2 mm narrow, 6 mm wide");
  }
  const str = patternSatin(line([0, 0], [45, 0]), { pattern: "pearl", minWidth: 2, maxWidth: 6, length: 10, stretched: true, rungs: false });
  check(!!str && str.length === 2 && Math.abs(Math.max(...str[0].nodes.map((n) => n.p[0])) - 45) < 1e-6, "stretched: fills the whole line");
}

console.log(failed ? `${failed} FAILED` : "all passed");
if (failed) throw new Error(`${failed} conversion checks failed`);
