// Shape conversions that work on the paths alone (no engine round trip),
// ported from Ink/Stitch's extensions (GPL-3.0-or-later):
//
// - removeDuplicatePoints  (remove_duplicated_points.py)
// - centreLineToRails      (stroke_to_satin.py / elements/utils/stroke_to_satin.py)
// - zigzagToSatin          (zigzag_line_to_satin.py)
// - patternSatin           (stroke_to_lpe_satin.py, Inkscape's pattern-along-path baked)
//
// Polygon work (fill → satin, centre lines, break apart, knockdown) runs in
// the Rust engine: crates/core/src/convert.rs.

import type { PathNode, SubPath, Vec2 } from "../types";
import { cubicAt, fitPath, flattenSubPath, segmentOf, vdist } from "./bezier";
import { offsetPolyline } from "./geometry";

const sub = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]];
const add = (a: Vec2, b: Vec2): Vec2 => [a[0] + b[0], a[1] + b[1]];
const mul = (a: Vec2, k: number): Vec2 => [a[0] * k, a[1] * k];
const lerp = (a: Vec2, b: Vec2, t: number): Vec2 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
const unit = (a: Vec2): Vec2 => {
  const l = Math.hypot(a[0], a[1]);
  return l < 1e-12 ? [0, 0] : [a[0] / l, a[1] / l];
};
const crossZ = (a: Vec2, b: Vec2) => a[0] * b[1] - a[1] * b[0];

/** Intersection of segments p1p2 and q1q2 (parameter on p, point), if any. */
export function segmentHit(p1: Vec2, p2: Vec2, q1: Vec2, q2: Vec2): { t: number; p: Vec2 } | null {
  const r = sub(p2, p1);
  const s = sub(q2, q1);
  const d = crossZ(r, s);
  if (Math.abs(d) < 1e-14) return null;
  const t = crossZ(sub(q1, p1), s) / d;
  const u = crossZ(sub(q1, p1), r) / d;
  if (t < -1e-9 || t > 1 + 1e-9 || u < -1e-9 || u > 1 + 1e-9) return null;
  return { t, p: add(p1, mul(r, t)) };
}

/** Crossings of a segment with a polyline. */
function hitsOn(a: Vec2, b: Vec2, line: Vec2[]): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 1; i < line.length; i++) {
    const h = segmentHit(a, b, line[i - 1], line[i]);
    if (h && !out.some((q) => vdist(q, h.p) < 1e-6)) out.push(h.p);
  }
  return out;
}

const lengthOf = (pts: Vec2[]) => pts.reduce((s, p, i) => (i ? s + vdist(pts[i - 1], p) : 0), 0);

/** Point at a share (0..1) of a polyline's length, and the direction there. */
function along(pts: Vec2[], t: number): { p: Vec2; dir: Vec2 } {
  const total = lengthOf(pts);
  let want = Math.max(0, Math.min(1, t)) * total;
  for (let i = 1; i < pts.length; i++) {
    const l = vdist(pts[i - 1], pts[i]);
    if (want <= l || i === pts.length - 1) {
      const k = l < 1e-12 ? 0 : Math.min(1, want / l);
      return { p: lerp(pts[i - 1], pts[i], k), dir: unit(sub(pts[i], pts[i - 1])) };
    }
    want -= l;
  }
  return { p: pts[0], dir: [1, 0] };
}

/** Part of a polyline between two shares of its length. */
function substring(pts: Vec2[], t0: number, t1: number): Vec2[] {
  const total = lengthOf(pts);
  const [a, b] = [t0 * total, t1 * total];
  const out: Vec2[] = [];
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const l = vdist(pts[i - 1], pts[i]);
    const s0 = acc;
    const s1 = acc + l;
    if (s1 >= a && s0 <= b) {
      if (!out.length) out.push(lerp(pts[i - 1], pts[i], l < 1e-12 ? 0 : Math.max(0, (a - s0) / l)));
      if (s1 <= b) out.push(pts[i]);
      else {
        out.push(lerp(pts[i - 1], pts[i], l < 1e-12 ? 1 : (b - s0) / l));
        break;
      }
    }
    acc = s1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Remove duplicated points

export interface DedupeOptions {
  /** Points closer than this to an earlier point are removed (mm). */
  distance: number;
  /** Compared with this many points before it. */
  window: number;
}

export const DEFAULT_DEDUPE: DedupeOptions = { distance: 0.01, window: 10 };

/** Indices of the nodes Ink/Stitch's "Remove duplicated points" would drop. */
export function duplicateNodes(sp: SubPath, o: DedupeOptions = DEFAULT_DEDUPE): number[] {
  const kept: Vec2[] = [];
  const drop: number[] = [];
  const w = Math.max(1, Math.round(o.window));
  sp.nodes.forEach((n, i) => {
    const recent = kept.slice(-w);
    if (recent.length && recent.some((q) => vdist(q, n.p) <= o.distance)) drop.push(i);
    else kept.push(n.p);
  });
  // a closed path ending on its first point
  const n = sp.nodes.length;
  if (sp.closed && n - drop.length > 2 && !drop.includes(n - 1) && vdist(sp.nodes[n - 1].p, sp.nodes[0].p) <= o.distance) drop.push(n - 1);
  return drop;
}

/** The sub-path without the given nodes; the curve handles of a dropped duplicate pass to the node it duplicates. */
export function dropNodes(sp: SubPath, drop: number[]): SubPath {
  if (!drop.length) return sp;
  const gone = new Set(drop);
  const nodes: PathNode[] = [];
  const n = sp.nodes.length;
  sp.nodes.forEach((nd, i) => {
    if (!gone.has(i)) {
      nodes.push({ ...nd });
      return;
    }
    // the dropped node's outgoing handle continues the curve from the kept one before it
    const prev = nodes[nodes.length - 1];
    if (prev && nd.o && vdist(prev.p, nd.p) < 0.5) prev.o = nd.o;
  });
  // closing duplicate: its incoming handle becomes the first node's
  if (sp.closed && gone.has(n - 1) && sp.nodes[n - 1].i && nodes.length && !nodes[0].i) nodes[0].i = sp.nodes[n - 1].i;
  return { ...sp, nodes };
}

export function removeDuplicatePoints(sp: SubPath, o: DedupeOptions = DEFAULT_DEDUPE): { sp: SubPath; removed: number } {
  const drop = duplicateNodes(sp, o);
  if (sp.nodes.length - drop.length < 2) return { sp, removed: 0 };
  return { sp: dropNodes(sp, drop), removed: drop.length };
}

// ---------------------------------------------------------------------------
// Centre line → rails and rungs (Ink/Stitch "Stroke to satin")

export interface RailsAndRungs {
  rails: [Vec2[], Vec2[]];
  rungs: [Vec2, Vec2][];
}

/** Whether a polyline crosses itself (segments meeting inside both, not at shared ends). */
function selfCrosses(pts: Vec2[]): boolean {
  for (let i = 0; i + 1 < pts.length; i++)
    for (let j = i + 2; j + 1 < pts.length; j++) {
      const h = segmentHit(pts[i], pts[i + 1], pts[j], pts[j + 1]);
      if (h && h.t > 1e-6 && h.t < 1 - 1e-6) return true;
    }
  return false;
}

/**
 * Where to put rungs along a line (Ink/Stitch `generate_rungs`): the line is
 * scored by how sharply it turns at every percent of its length (squared
 * degrees, blurred), and rungs go at the local minima — away from corners,
 * at least 2 mm apart, and only where they cross both rails once.
 */
function generateRungs(path: Vec2[], width: number, left: Vec2[], right: Vec2[]): [Vec2, Vec2][] {
  const total = lengthOf(path);
  if (total < 1e-9) return [];
  const scores = new Array(101).fill(0);
  let acc = 0;
  let prevDir: Vec2 | null = null;
  for (let i = 1; i < path.length; i++) {
    const d = unit(sub(path[i], path[i - 1]));
    if (prevDir) {
      const cos = Math.max(-1, Math.min(1, prevDir[0] * d[0] + prevDir[1] * d[1]));
      const deg = (Math.acos(cos) * 180) / Math.PI;
      scores[Math.round((acc / total) * 100)] += Math.round(deg * deg);
    }
    acc += vdist(path[i - 1], path[i]);
    prevDir = d;
  }
  const kernel = [1, 2, 4, 8, 16, 8, 4, 2, 1];
  const blurred = scores.map((_, i) => kernel.reduce((s, k, j) => s + k * (scores[i + j - 4] ?? 0), 0));
  // local minima: where the slope turns from falling to rising
  const sign = (x: number) => (x > 0 ? 1 : x < 0 ? -1 : 0);
  const d1 = blurred.slice(1).map((v, i) => sign(v - blurred[i]));
  let locations: number[] = [];
  for (let i = 0; i + 1 < d1.length; i++) if (d1[i + 1] - d1[i] > 0) locations.push(i + 1);
  locations = [...new Set(locations)].filter((l) => l !== 0 && l !== 100).sort((a, b) => a - b);
  if (!locations.length) locations = [50];
  const rungs: [Vec2, Vec2][] = [];
  let last: Vec2 | null = null;
  for (const loc of locations) {
    const { p: centre } = along(path, loc / 100);
    if (last && vdist(centre, last) < 2) continue;
    last = centre;
    const ahead = along(path, loc / 100 + 0.001).p;
    const t = unit(sub(ahead, centre));
    const n: Vec2 = [t[1], -t[0]];
    const off = mul(n, (width / 2) * 1.2);
    const a = add(centre, off);
    const b = sub(centre, off);
    if (hitsOn(a, b, left).length === 1 && hitsOn(a, b, right).length === 1) rungs.push([a, b]);
  }
  return rungs;
}

function pathToSatin(path: Vec2[], width: number): RailsAndRungs | null {
  if (vdist(path[0], path[path.length - 1]) < 0.25) return null;
  const left = offsetPolyline(path, -width / 2);
  const right = offsetPolyline(path, width / 2);
  if (selfCrosses(left) || selfCrosses(right)) return null;
  return { rails: [left, right], rungs: generateRungs(path, width, left, right) };
}

function halves(path: Vec2[]): [Vec2[], Vec2[]] {
  return [substring(path, 0, 0.5), substring(path, 0.5, 1)];
}

function convertSections(path: Vec2[], width: number, depth = 0): RailsAndRungs[] {
  const s = pathToSatin(path, width);
  if (s) return [s];
  // the path crosses itself at this width: try the halves on their own
  if (depth >= 8 || lengthOf(path) < width) {
    const left = offsetPolyline(path, -width / 2);
    const right = offsetPolyline(path, width / 2);
    return left.length >= 2 ? [{ rails: [left, right], rungs: [] }] : [];
  }
  return halves(path).flatMap((h) => convertSections(h, width, depth + 1));
}

/** A rung from a to b, lengthened about its middle by `k`. */
function scaled(a: Vec2, b: Vec2, k: number): [Vec2, Vec2] {
  const m = lerp(a, b, 0.5);
  return [add(m, mul(sub(a, m), k)), add(m, mul(sub(b, m), k))];
}

/** Start a closed line at a straight stretch away from crossings (Ink/Stitch `set_first_node`). */
function rollToGoodStart(pts: Vec2[], width: number): Vec2[] {
  const ring = vdist(pts[0], pts[pts.length - 1]) < 1e-9 ? pts.slice(0, -1) : pts.slice();
  const n = ring.length;
  let best = 0;
  let bestLen = -1;
  for (let i = 0; i < n; i++) {
    const l = vdist(ring[i], ring[(i + 1) % n]);
    if (l > bestLen && l > width * 0.5) {
      best = i;
      bestLen = l;
      if (l > width * 2) break;
    }
  }
  const rolled = [...ring.slice(best), ...ring.slice(0, best)];
  return [...rolled, rolled[0]];
}

/**
 * A centre line of the given width as two rails and rungs (Ink/Stitch
 * "Stroke to satin"): the line offset to both sides; where it crosses itself
 * at that width it is converted in halves joined by a rung. Closed lines
 * start and end in the middle of a straight stretch.
 */
export function centreLineToRails(sp: SubPath, width: number): RailsAndRungs | null {
  let path = flattenSubPath(sp, 0.25).filter((p, i, a) => !i || vdist(p, a[i - 1]) > 1e-6);
  if (path.length < 2) return null;
  if (sp.closed) {
    path = rollToGoodStart([...path, path[0]], width);
    // fix_loop: begin and end half way along the first segment
    const mid = lerp(path[0], path[1], 0.5);
    path = [mid, ...path.slice(1), mid];
  }
  const sections = convertSections(path, width);
  if (!sections.length) return null;
  const out: RailsAndRungs = { rails: [sections[0].rails[0].slice(), sections[0].rails[1].slice()], rungs: sections[0].rungs.slice() };
  for (const s of sections.slice(1)) {
    if (s.rails[0].length < 2 || s.rails[1].length < 2) continue;
    out.rails[0].push(...s.rails[0].slice(1));
    out.rails[1].push(...s.rails[1].slice(1));
    // a rung where the two parts meet
    out.rungs.push(scaled(s.rails[0][0], s.rails[1][0], 1.2));
    out.rungs.push(...s.rungs);
  }
  // only rungs that cross the rails exactly twice
  out.rungs = out.rungs.filter(([a, b]) => hitsOn(a, b, out.rails[0]).length + hitsOn(a, b, out.rails[1]).length === 2);
  return out;
}

/** Rails as editable curves (corners kept), each with at least three nodes so they read as rails, not rungs. */
export function railPath(pts: Vec2[], closed = false): SubPath {
  const sp = fitPath(pts, 0.03, closed, 50, 0.6);
  if (!closed && sp.nodes.length === 2) {
    const [a, b] = sp.nodes;
    if (!a.o && !b.i) sp.nodes.splice(1, 0, { p: lerp(a.p, b.p, 0.5) });
    else {
      const c = segmentOf(sp, 0);
      const m = cubicAt(c, 0.5);
      // split the curve in half (de Casteljau) to keep its shape
      const ab = lerp(c[0], c[1], 0.5);
      const bc = lerp(c[1], c[2], 0.5);
      const cd = lerp(c[2], c[3], 0.5);
      const abc = lerp(ab, bc, 0.5);
      const bcd = lerp(bc, cd, 0.5);
      sp.nodes = [
        { p: a.p, o: ab },
        { p: m, i: abc, o: bcd },
        { p: b.p, i: cd },
      ];
    }
  }
  return sp;
}

/** Satin paths (rails first, then rungs) from rails and rungs. */
export function satinPaths(r: RailsAndRungs): SubPath[] {
  return [railPath(r.rails[0]), railPath(r.rails[1]), ...r.rungs.map(([a, b]): SubPath => ({ closed: false, nodes: [{ p: a }, { p: b }] }))];
}

// ---------------------------------------------------------------------------
// Zig-zag line to satin

export type ZigzagPattern = "square" | "sawtooth" | "zigzag";

export interface ZigzagOptions {
  pattern: ZigzagPattern;
  /** Smooth curves through the rail points instead of straight lines. */
  smoothing: boolean;
  /** Add rungs (the stitch direction follows the drawing). */
  rungs: boolean;
  /** Every other rung only. */
  reduceRungs: boolean;
}

export const DEFAULT_ZIGZAG: ZigzagOptions = { pattern: "square", smoothing: true, rungs: true, reduceRungs: false };

/** Ink/Stitch: a node pair closer than this marks a sharp corner (0.3 px). */
const SHARP = 0.08;

/**
 * Ink/Stitch "Zig-zag line to satin": a line drawn as a zig-zag between the
 * two edges of a column becomes a satin. Square |_|▔|_|: four points per
 * period; sawtooth |/|/|: points alternate between the rails; zigzag VVV:
 * the stitches run along the drawn line. Doubled points keep a sharp corner.
 */
export function zigzagToSatin(points: Vec2[], o: ZigzagOptions = DEFAULT_ZIGZAG): SubPath[] | null {
  // doubled points: corners not to smooth
  const pts: Vec2[] = [];
  const sharp: Vec2[] = [];
  let skip = false;
  for (let i = 0; i + 1 < points.length; i++) {
    if (skip) {
      skip = false;
      continue;
    }
    pts.push(points[i]);
    if (vdist(points[i], points[i + 1]) < SHARP) {
      sharp.push(points[i]);
      skip = true;
    }
  }
  if (points.length) pts.push(points[points.length - 1]);
  if (pts.length < 3) return null;
  let { rails, rungs } = railsAndRungs(pts, o.pattern);
  if (rails[0].length < 2 || rails[1].length < 2) return null;
  let railPaths: SubPath[];
  if (o.smoothing) {
    const sm = smoothRails(rails, rungs, sharp, o);
    railPaths = sm.paths;
    rungs = sm.rungs;
  } else railPaths = rails.map((r): SubPath => ({ closed: false, nodes: r.map((p) => ({ p })) }));
  // the rail detector wants rails of three or more nodes
  railPaths = railPaths.map((sp) => (sp.nodes.length === 2 ? railPath(flattenSubPath(sp, 0.25)) : sp));
  const out = [...railPaths];
  if (o.rungs) {
    if (o.pattern !== "zigzag" && o.reduceRungs && rungs.length > 2) rungs = rungs.filter((_, i) => i % 2 === 0);
    if (rungs.length >= 3) {
      for (const [a, b] of rungs.slice(1, -1)) {
        const d = unit(sub(b, a));
        out.push({ closed: false, nodes: [{ p: sub(a, mul(d, 0.25)) }, { p: add(b, mul(d, 0.25)) }] });
      }
    }
  }
  return out;
}

function railsAndRungs(pts: Vec2[], pattern: ZigzagPattern): { rails: [Vec2[], Vec2[]]; rungs: [Vec2, Vec2][] } {
  const even = pts.filter((_, i) => i % 2 === 0);
  const odd = pts.filter((_, i) => i % 2 === 1);
  if (pattern === "sawtooth") {
    // |/|/|/| : odd points with the even point before them
    const rungs: [Vec2, Vec2][] = odd.map((p, i) => [p, even[i]]);
    return { rails: [even, odd], rungs };
  }
  if (pattern === "zigzag") {
    // VVVV: a rung from every rail point and from half way between rail points
    const rails: [Vec2[], Vec2[]] = [even, odd];
    const railPts: [Vec2[], Vec2[]] = [[], []];
    const rungPts: [Vec2[], Vec2[]] = [[], []];
    const special = pts.length > 3 ? [pts[2], pts[pts.length - 1]] : [];
    rails.forEach((rail, i) => {
      rail.forEach((p, j) => {
        railPts[i].push(p);
        if (j === 0 || special.some((q) => q === p)) {
          rungPts[i].push(p);
          return;
        }
        rungPts[i].push(lerp(rail[j - 1], p, 0.5));
        rungPts[i].push(p);
      });
    });
    const n = Math.min(rungPts[0].length, rungPts[1].length);
    const rungs: [Vec2, Vec2][] = [];
    for (let k = 0; k < n; k++) rungs.push([rungPts[0][k], rungPts[1][k]]);
    return { rails: railPts, rungs };
  }
  // square |_|▔|_|▔| : groups of four points
  const rails: [Vec2[], Vec2[]] = [[], []];
  const rungs: [Vec2, Vec2][] = [];
  for (let i = 0; i < pts.length; i += 4) {
    const g = pts.slice(i, i + 4);
    if (g.length <= 1) break;
    if (g.length < 4) {
      rails[0].push(g[0]);
      rails[1].push(g[1]);
      rungs.push([g[0], g[1]]);
      break;
    }
    rails[0].push(g[0], g[3]);
    rails[1].push(g[1], g[2]);
    rungs.push([g[0], g[1]], [g[2], g[3]]);
  }
  return { rails, rungs };
}

/** Smooth rails (Ink/Stitch `_smooth_path`): Catmull-Rom-like handles at 0.4 of the segment, none at sharp points. */
function smoothRails(rails: [Vec2[], Vec2[]], rungs: [Vec2, Vec2][], sharp: Vec2[], o: ZigzagOptions): { paths: SubPath[]; rungs: [Vec2, Vec2][] } {
  const isSharp = (p: Vec2) => sharp.some((q) => q === p);
  const handle = (p: Vec2, from: Vec2, to: Vec2, length: number): Vec2 => {
    if (isSharp(p)) return p;
    const d = sub(to, from);
    if (Math.hypot(d[0], d[1]) <= 1e-4) return from;
    return add(p, mul(unit(d), length));
  };
  const paths: SubPath[] = [];
  const newRungs: [Vec2, Vec2][] = [];
  const k = [1, 0];
  rails.forEach((rail, j) => {
    const r = rungs.filter((_, i) => i % 2 === j);
    const nodes: PathNode[] = [{ p: rail[0] }];
    for (let i = 1; i < rail.length; i++) {
      const point = rail[i];
      const prevPrev = i < 2 ? rail[i - 1] : rail[i - 2];
      const prev = rail[i - 1];
      const next = i > rail.length - 2 ? point : rail[i + 1];
      const length = vdist(point, prev) * 0.4;
      const c1 = handle(prev, prevPrev, point, length);
      const c2 = handle(point, next, prev, length);
      nodes[nodes.length - 1].o = c1;
      nodes.push({ p: point, i: c2 });
      // zigzag: the smoothed rail may miss the rung — move its end onto the curve
      if (o.pattern === "zigzag" && i <= r.length && (!o.reduceRungs || j === 0)) {
        const rung = r[i - 1];
        if (!rung || vdist(rung[0], rung[1]) === 0) continue;
        const d = unit(sub(rung[1], rung[0]));
        const a = sub(rung[0], mul(d, 50));
        const b = add(rung[1], mul(d, 50));
        const curve: Vec2[] = [];
        for (let s = 0; s <= 24; s++) curve.push(cubicAt([prev, c1, c2, point], s / 24));
        const hit = hitsOn(a, b, curve)[0];
        newRungs.push(hit ? [rung[k[j]], hit] : rung);
      }
    }
    paths.push({ closed: false, nodes: nodes.map((n) => ({ p: n.p, ...(n.i && vdist(n.i, n.p) > 1e-9 ? { i: n.i } : {}), ...(n.o && vdist(n.o, n.p) > 1e-9 ? { o: n.o } : {}) })) });
  });
  return { paths, rungs: o.pattern === "zigzag" && newRungs.length ? newRungs : rungs };
}

// ---------------------------------------------------------------------------
// Patterned satin along a line (Ink/Stitch "Stroke to live path effect satin")

export type SatinPattern = "normal" | "pearl" | "diamond" | "square" | "triangle" | "wave" | "arch";

export interface PatternOptions {
  pattern: SatinPattern;
  /** Narrowest and widest point of the column (mm). */
  minWidth: number;
  maxWidth: number;
  /** Length of one repeat (mm). */
  length: number;
  /** Stretch the repeats to fill the line exactly (otherwise whole repeats, the rest of the line stays free). */
  stretched: boolean;
  /** A rung in every repeat (the stitch angle follows the pattern). */
  rungs: boolean;
}

export const DEFAULT_PATTERN: PatternOptions = { pattern: "normal", minWidth: 4, maxWidth: 7, length: 15, stretched: false, rungs: true };

/** The pattern shapes: one edge of the column, as cubic segments (Ink/Stitch's SatinPattern paths, mm). */
type Seg = [Vec2, Vec2, Vec2, Vec2];
const L = (a: Vec2, b: Vec2): Seg => [a, lerp(a, b, 1 / 3), lerp(a, b, 2 / 3), b];
const PATTERNS: Record<SatinPattern, { segs: Seg[]; flip: boolean }> = {
  normal: { segs: [L([0, 0], [4, 0]), L([4, 0], [8, 0])], flip: true },
  pearl: {
    segs: [
      [[0, 0], [0, 0.22], [0.18, 0.4], [0.4, 0.4]],
      [[0.4, 0.4], [0.62, 0.4], [0.8, 0.22], [0.8, 0]],
    ],
    flip: true,
  },
  diamond: { segs: [L([0, 0], [0.4, 0.2]), L([0.4, 0.2], [0.8, 0])], flip: true },
  triangle: { segs: [L([0, 0], [0.4, 0.1]), L([0.4, 0.1], [0.78, 0.2]), L([0.78, 0.2], [0.8, 0])], flip: true },
  square: { segs: [L([0, 0], [0.2, 0]), L([0.2, 0], [0.4, 0]), L([0.4, 0], [0.47, 0.2]), L([0.47, 0.2], [0.8, 0.2]), L([0.8, 0.2], [0.86, 0])], flip: true },
  wave: {
    segs: [
      [[0, 0], [0.2, 0.01], [0.29, 0.2], [0.4, 0.2]],
      [[0.4, 0.2], [0.51, 0.2], [0.58, 0.01], [0.8, 0]],
    ],
    flip: true,
  },
  arch: {
    segs: [
      [[0, 0.25], [0, 0.25], [0.07, 0.05], [0.4, 0.05]],
      [[0.4, 0.05], [0.7, 0.05], [0.8, 0.25], [0.8, 0.25]],
    ],
    flip: false,
  },
};

export const SATIN_PATTERNS: { id: SatinPattern; label: string }[] = [
  { id: "normal", label: "Plain" },
  { id: "pearl", label: "Pearls" },
  { id: "diamond", label: "Diamonds" },
  { id: "square", label: "Squares" },
  { id: "triangle", label: "Triangles" },
  { id: "wave", label: "Wave" },
  { id: "arch", label: "Arch" },
];

function bbox(segs: Seg[]): { x0: number; x1: number; y0: number; y1: number } {
  let [x0, x1, y0, y1] = [Infinity, -Infinity, Infinity, -Infinity];
  for (const s of segs)
    for (let k = 0; k <= 32; k++) {
      const p = cubicAt(s, k / 32);
      x0 = Math.min(x0, p[0]);
      x1 = Math.max(x1, p[0]);
      y0 = Math.min(y0, p[1]);
      y1 = Math.max(y1, p[1]);
    }
  return { x0, x1, y0, y1 };
}

/** The two edges of one repeat, scaled to the options (Ink/Stitch `SatinPattern.get_path`), and the rung. */
export function patternTile(o: PatternOptions): { edges: [Seg[], Seg[]]; rung: [Vec2, Vec2]; width: number } {
  const def = PATTERNS[o.pattern];
  const minW = Math.max(o.minWidth, 0.5);
  const maxW = Math.max(o.maxWidth, 0.5);
  const b = bbox(def.segs);
  const sx = o.length / Math.max(b.x1 - b.x0, 0.1);
  const h = b.y1 - b.y0;
  const sy = h === 0 ? 1 : (maxW - minW) / (h * 2);
  const e1 = def.segs.map((s) => s.map((p) => [p[0] * sx, p[1] * sy] as Vec2) as Seg);
  const e2 = e1.map((s) => s.map((p) => (def.flip ? [p[0], -(p[1] + minW)] : [p[0], p[1] - minW]) as Vec2) as Seg);
  const rung: [Vec2, Vec2] = [e1[0][3], e2[0][3]];
  return { edges: [e1, e2], rung, width: o.length };
}

/** Polyline with arc lengths, for mapping pattern space onto it. */
function skeleton(pts: Vec2[]) {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + vdist(pts[i - 1], pts[i]));
  const total = cum[cum.length - 1];
  const frame = (s: number): { p: Vec2; n: Vec2 } => {
    const x = Math.max(0, Math.min(total, s));
    let i = 1;
    while (i < pts.length - 1 && cum[i] < x) i++;
    const l = cum[i] - cum[i - 1];
    const t = l < 1e-12 ? 0 : (x - cum[i - 1]) / l;
    const d = unit(sub(pts[i], pts[i - 1]));
    // beyond the ends: straight on
    const over = s < 0 ? s : s > total ? s - total : 0;
    return { p: add(lerp(pts[i - 1], pts[i], t), mul(d, over)), n: [-d[1], d[0]] };
  };
  return { total, frame };
}

/**
 * A patterned satin along a line: Ink/Stitch's pattern-along-path satins
 * (pearls, diamonds, waves …) baked into two rails with matching nodes (each
 * node pair is a rung) and, optionally, a rung in every repeat.
 */
export function patternSatin(sp: SubPath, o: PatternOptions = DEFAULT_PATTERN): SubPath[] | null {
  const pts = flattenSubPath(sp, 0.1).filter((p, i, a) => !i || vdist(p, a[i - 1]) > 1e-6);
  if (sp.closed && pts.length > 1 && vdist(pts[0], pts[pts.length - 1]) > 1e-6) pts.push(pts[0]);
  if (pts.length < 2) return null;
  const sk = skeleton(pts);
  const tile = patternTile(o);
  const all = [...tile.edges[0], ...tile.edges[1]];
  const b = bbox(all);
  const yMid = (Math.min(b.y0, tile.rung[1][1]) + Math.max(b.y1, tile.rung[0][1])) / 2;
  const tileLen = b.x1 - b.x0;
  if (tileLen <= 1e-6) return null;
  const copies = Math.max(1, Math.floor(sk.total / tileLen + 1e-9));
  const scale = o.stretched ? sk.total / (copies * tileLen) : 1;
  // pattern space (x along, y across) → the line
  const map = (q: Vec2, k: number): Vec2 => {
    const s = (q[0] - b.x0 + k * tileLen) * scale;
    const f = sk.frame(s);
    return add(f.p, mul(f.n, q[1] - yMid));
  };
  const rails: [PathNode[], PathNode[]] = [[], []];
  const rungs: SubPath[] = [];
  for (let k = 0; k < copies; k++) {
    tile.edges.forEach((edge, e) => {
      const rail = rails[e];
      edge.forEach((seg, j) => {
        if (j === 0) {
          const start = map(seg[0], k);
          const last = rail[rail.length - 1];
          // fuse with the end of the previous repeat
          if (!last || vdist(last.p, start) > 0.2) rail.push({ p: start });
        }
        const prev = rail[rail.length - 1];
        const straight = vdist(seg[1], lerp(seg[0], seg[3], 1 / 3)) < 1e-9 && vdist(seg[2], lerp(seg[0], seg[3], 2 / 3)) < 1e-9;
        if (!straight) prev.o = map(seg[1], k);
        rail.push(straight ? { p: map(seg[3], k) } : { p: map(seg[3], k), i: map(seg[2], k) });
      });
    });
    if (o.rungs) {
      const a = map([tile.rung[0][0], tile.rung[0][1] + 0.1 * Math.sign(tile.rung[0][1] - tile.rung[1][1] || 1)], k);
      const c = map([tile.rung[1][0], tile.rung[1][1] - 0.2 * Math.sign(tile.rung[0][1] - tile.rung[1][1] || 1)], k);
      rungs.push({ closed: false, nodes: [{ p: a }, { p: c }] });
    }
  }
  if (rails[0].length < 2 || rails[1].length < 2) return null;
  const railPaths = rails.map((nodes): SubPath => ({ closed: false, nodes }));
  return [...railPaths.map((r) => (r.nodes.length === 2 ? railPath(flattenSubPath(r, 0.25)) : r)), ...rungs];
}
