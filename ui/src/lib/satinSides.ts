// A satin's two sides and its orientation lines.
//
// A satin is drawn as a centre line with a width, or as two sides that are
// each shaped on their own; it can be switched either way at any time.
//
// A two-sided satin whose sides have the same number of points uses the point
// pairs as rungs (Ink/Stitch's convention): they set the stitch angle, and
// adding or deleting a point keeps the pairs. Freeing the sides turns those
// pairs into direction guides (the stitches stay as they are) and switches
// the pairing off, so each side can then be shaped on its own and every
// orientation line can be moved or deleted.

import type { DesignObject, SatinParams, StitchDocument, SubPath, Vec2 } from "../types";
import { cubicAt, fitPath, flattenSubPath, vdist } from "./bezier";
import { satinRailIndices } from "./geometry";
import { isRailSatin, railMap } from "./nodeOps";
import { buildSatin, satinOutlineOf } from "./satinDraw";

export type Line = [Vec2, Vec2];
type Satin = DesignObject & { stitch: { type: "satin" } & SatinParams };

const isSatin = (o: DesignObject): o is Satin => o.stitch.type === "satin";

/** The rungs the engine makes from point pairs (none once the satin has guides or the pairing is off). */
export function pairRungs(o: DesignObject): Line[] {
  if (!isSatin(o) || !isRailSatin(o) || o.stitch.guides?.length || o.stitch.nodeRungs === false) return [];
  const [a, b] = o.paths;
  const map = railMap(a, b);
  if (!map || a.nodes.length <= 2) return [];
  // the inner pairs: the first (and on an open column the last) are its ends
  const out: Line[] = [];
  for (let i = 1; i < (a.closed ? a.nodes.length : a.nodes.length - 1); i++) out.push([a.nodes[i].p, b.nodes[map.at(i)].p]);
  return out;
}

/** What sets the satin's stitch angle: its guides, or else its point pairs. */
export function orientationLines(o: DesignObject | undefined): { lines: Line[]; pairs: boolean } {
  if (!o || !isSatin(o)) return { lines: [], pairs: false };
  if (o.stitch.guides?.length) return { lines: o.stitch.guides, pairs: false };
  const lines = pairRungs(o);
  return { lines, pairs: lines.length > 0 };
}

/** A rung lengthened a little at both ends, so it crosses the rails it joins. */
function across([a, b]: Line, by = 0.3): Line {
  const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  const u: Vec2 = [((b[0] - a[0]) / l) * by, ((b[1] - a[1]) / l) * by];
  return [
    [a[0] - u[0], a[1] - u[1]],
    [b[0] + u[0], b[1] + u[1]],
  ];
}

/**
 * The satin with its sides free: point pairs become guides (in the same
 * order as `orientationLines`) and stop pairing. The same object when there
 * is nothing to free.
 */
export function freeSides(o: DesignObject): DesignObject {
  if (!isSatin(o) || !isRailSatin(o) || o.stitch.nodeRungs === false) return o;
  const guides = o.stitch.guides?.length ? o.stitch.guides : pairRungs(o).map((r) => across(r));
  return { ...o, stitch: { ...o.stitch, guides: guides.length ? guides : undefined, nodeRungs: false } };
}

/** The satin without one of its orientation lines (an index into `orientationLines`). */
export function removeOrientationLine(o: DesignObject, index: number): DesignObject {
  const f = freeSides(o);
  if (!isSatin(f)) return o;
  const rest = (f.stitch.guides ?? []).filter((_, i) => i !== index);
  return { ...f, stitch: { ...f.stitch, guides: rest.length ? rest : undefined } };
}

/** The satin without any orientation line: stitches straight across, matched along both sides. */
export function clearOrientation(o: DesignObject): DesignObject {
  if (!isSatin(o)) return o;
  return { ...o, stitch: { ...o.stitch, guides: undefined, ...(isRailSatin(o) ? { nodeRungs: false } : {}) } };
}

/** A centre-line satin: one path and a width. */
export const isCentreLineSatin = (o: DesignObject) => isSatin(o) && !o.stitch.multi && o.paths.length === 1 && o.paths[0].nodes.length >= 2;

/**
 * A centre-line satin as two sides that can each be shaped: the centre line
 * offset by half the width to both sides, point for point (the pairs keep the
 * stitch angle as it was). The same object when it is not a centre-line satin.
 */
export function toTwoSides(o: DesignObject): DesignObject {
  if (!isCentreLineSatin(o) || !isSatin(o)) return o;
  const sp = o.paths[0];
  const { paths } = buildSatin(sp.nodes, sp.nodes.map(() => o.stitch.width), sp.closed, true);
  return { ...o, paths };
}

/**
 * Two sides back to a centre line with a width. Sides with the same number
 * of points keep them (the middle of each pair, handles too); others are
 * matched along their length and fitted with a smooth curve. The width is
 * the column's average. The same object when it has no two sides.
 */
export function toCentreLine(o: DesignObject): DesignObject {
  if (!isSatin(o) || !isRailSatin(o)) return o;
  const [a, b] = o.paths;
  const map = railMap(a, b);
  const mid = (p: Vec2, q: Vec2): Vec2 => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
  let centre: SubPath;
  let widths: number[];
  if (map) {
    centre = {
      closed: a.closed,
      nodes: a.nodes.map((n, i) => {
        const m = b.nodes[map.at(i)];
        // a side walked the other way has its handles the other way round
        const [mi, mo] = map.rev ? [m.o, m.i] : [m.i, m.o];
        return { p: mid(n.p, m.p), ...(n.i || mi ? { i: mid(n.i ?? n.p, mi ?? m.p) } : {}), ...(n.o || mo ? { o: mid(n.o ?? n.p, mo ?? m.p) } : {}) };
      }),
    };
    widths = a.nodes.map((n, i) => vdist(n.p, b.nodes[map.at(i)].p));
  } else {
    const pa = flattenSubPath(a, 0.2);
    let pb = flattenSubPath(b, 0.2);
    if (vdist(pa[0], pb[0]) + vdist(pa[pa.length - 1], pb[pb.length - 1]) > vdist(pa[0], pb[pb.length - 1]) + vdist(pa[pa.length - 1], pb[0])) pb = [...pb].reverse();
    const pts: Vec2[] = [];
    widths = [];
    for (let k = 0; k <= 80; k++) {
      const p = alongPolyline(pa, k / 80);
      const q = alongPolyline(pb, k / 80);
      pts.push(mid(p, q));
      widths.push(vdist(p, q));
    }
    centre = fitPath(a.closed ? pts.slice(0, -1) : pts, 0.05, a.closed);
  }
  const width = Math.max(0.3, +(widths.reduce((s, w) => s + w, 0) / Math.max(1, widths.length)).toFixed(2));
  const { nodeRungs: _drop, ...stitch } = o.stitch;
  return { ...o, paths: [centre], stitch: { ...stitch, width } };
}

// ---------------------------------------------------------------------------
// Orientation lines follow their satin
//
// Guides are stored where they lie (the engine and Ink/Stitch read them so).
// Each guides list is remembered with the column it was drawn on; when the
// column changes under it (a point moved, a side bent, the width changed,
// the sides split or joined) every guide is put back where it crossed the two
// sides: the same spot of the same segment (or the nearest spot when the side
// gained or lost points), reaching as far past the sides as before, relative
// to the width there.

interface Rail {
  pts: Vec2[];
  /** Where each node is in `pts` (a closed side ends with its first node again). */
  nodeIdx: number[];
}
interface Crossing {
  p: Vec2;
  seg: number;
  /** Arc share within the segment. */
  t: number;
}

/** A side as points, curves sampled, with its nodes marked. */
function sampleSide(sp: SubPath): Rail {
  const n = sp.nodes.length;
  const pts: Vec2[] = [sp.nodes[0].p];
  const nodeIdx = [0];
  for (let s = 0; s < (sp.closed ? n : n - 1); s++) {
    const a = sp.nodes[s];
    const b = sp.nodes[(s + 1) % n];
    const k = a.o || b.i ? 16 : 1;
    for (let j = 1; j <= k; j++) pts.push(k === 1 ? b.p : cubicAt([a.p, a.o ?? a.p, b.i ?? b.p, b.p], j / k));
    nodeIdx.push(pts.length - 1);
  }
  return { pts, nodeIdx };
}

/** A satin's two sides (a centre line: offset by half its width to both sides). */
function sidesOf(o: DesignObject): [Rail, Rail] | null {
  if (!isSatin(o) || o.stitch.multi) return null;
  if (o.paths.length === 1) {
    const sp = o.paths[0];
    if (sp.nodes.length < 2) return null;
    const { left, right } = satinOutlineOf(sp.nodes, sp.nodes.map(() => o.stitch.width), sp.closed, 14);
    const n = sp.nodes.length;
    const nodeIdx = [0];
    let i = 0;
    for (let s = 0; s < (sp.closed ? n : n - 1); s++) nodeIdx.push((i += sp.nodes[s].o || sp.nodes[(s + 1) % n].i ? 14 : 1));
    return [
      { pts: left, nodeIdx },
      { pts: right, nodeIdx },
    ];
  }
  const r = satinRailIndices(o.paths);
  return r ? [sampleSide(o.paths[r[0]]), sampleSide(o.paths[r[1]])] : null;
}

function arcs(pts: Vec2[]): number[] {
  const out = [0];
  for (let i = 1; i < pts.length; i++) out.push(out[i - 1] + vdist(pts[i], pts[i - 1]));
  return out;
}

/** The point at arc length `at` along a polyline (with its arc lengths). */
function atArc(pts: Vec2[], cum: number[], at: number): Vec2 {
  for (let i = 1; i < pts.length; i++)
    if (cum[i] >= at || i === pts.length - 1) {
      const l = cum[i] - cum[i - 1];
      const u = l > 1e-12 ? Math.max(0, Math.min(1, (at - cum[i - 1]) / l)) : 0;
      return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * u, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * u];
    }
  return pts[0];
}

const alongPolyline = (pts: Vec2[], t: number) => {
  const cum = arcs(pts);
  return atArc(pts, cum, cum[cum.length - 1] * t);
};

/** Where the line through a guide crosses a side, nearest to the guide's middle. */
function crossing(rail: Rail, [a, b]: Line): Crossing | null {
  const d: Vec2 = [b[0] - a[0], b[1] - a[1]];
  const m: Vec2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  let best: { p: Vec2; i: number; u: number; d: number } | null = null;
  for (let i = 1; i < rail.pts.length; i++) {
    const p = rail.pts[i - 1];
    const e: Vec2 = [rail.pts[i][0] - p[0], rail.pts[i][1] - p[1]];
    const den = d[0] * e[1] - d[1] * e[0];
    if (Math.abs(den) < 1e-12) continue;
    const u = ((p[0] - a[0]) * d[1] - (p[1] - a[1]) * d[0]) / den;
    if (u < -1e-9 || u > 1 + 1e-9) continue;
    const q: Vec2 = [p[0] + e[0] * u, p[1] + e[1] * u];
    const dm = vdist(q, m);
    if (!best || dm < best.d) best = { p: q, i, u: Math.max(0, Math.min(1, u)), d: dm };
  }
  if (!best) return null;
  const cum = arcs(rail.pts);
  const at = cum[best.i - 1] + (cum[best.i] - cum[best.i - 1]) * best.u;
  let seg = 0;
  while (seg < rail.nodeIdx.length - 2 && rail.nodeIdx[seg + 1] < best.i) seg++;
  const s0 = cum[rail.nodeIdx[seg]];
  const s1 = cum[rail.nodeIdx[seg + 1] ?? rail.pts.length - 1];
  return { p: best.p, seg, t: s1 - s0 > 1e-12 ? (at - s0) / (s1 - s0) : 0 };
}

/**
 * The point at the same spot of another version of a side: the same share of
 * the same segment while the side has the same points (they were moved), else
 * the nearest point to where it was (points were added or taken away).
 */
function sameSpot(rail: Rail, c: Crossing, sameNodes: boolean): Vec2 {
  const a = rail.nodeIdx[c.seg];
  const b = rail.nodeIdx[c.seg + 1];
  if (sameNodes && a !== undefined && b !== undefined) {
    const cum = arcs(rail.pts);
    return atArc(rail.pts, cum, cum[a] + (cum[b] - cum[a]) * c.t);
  }
  let best = rail.pts[0];
  for (let i = 1; i < rail.pts.length; i++) {
    const p = rail.pts[i - 1];
    const e: Vec2 = [rail.pts[i][0] - p[0], rail.pts[i][1] - p[1]];
    const l2 = e[0] * e[0] + e[1] * e[1];
    const u = l2 > 1e-18 ? Math.max(0, Math.min(1, ((c.p[0] - p[0]) * e[0] + (c.p[1] - p[1]) * e[1]) / l2)) : 0;
    const q: Vec2 = [p[0] + e[0] * u, p[1] + e[1] * u];
    if (vdist(q, c.p) < vdist(best, c.p)) best = q;
  }
  return best;
}

/** The guides drawn on `before`, put on `after` at the same spots of its sides. */
export function refitGuides(guides: Line[], before: DesignObject, after: DesignObject): Line[] | null {
  const r0 = sidesOf(before);
  const r1 = sidesOf(after);
  if (!r0 || !r1) return null;
  const same = [r0[0].nodeIdx.length === r1[0].nodeIdx.length, r0[1].nodeIdx.length === r1[1].nodeIdx.length];
  return guides.map((g): Line => {
    const ca = crossing(r0[0], g);
    const cb = crossing(r0[1], g);
    if (!ca || !cb) return g;
    const flip = vdist(g[0], ca.p) > vdist(g[0], cb.p);
    const [ga, gb] = flip ? [g[1], g[0]] : g;
    const w0 = vdist(ca.p, cb.p);
    if (w0 < 1e-9) return g;
    const u0: Vec2 = [(cb.p[0] - ca.p[0]) / w0, (cb.p[1] - ca.p[1]) / w0];
    // how far past each side, as a share of the width there (negative: short of it)
    const oa = -((ga[0] - ca.p[0]) * u0[0] + (ga[1] - ca.p[1]) * u0[1]) / w0;
    const ob = ((gb[0] - cb.p[0]) * u0[0] + (gb[1] - cb.p[1]) * u0[1]) / w0;
    const pa = sameSpot(r1[0], ca, same[0]);
    const pb = sameSpot(r1[1], cb, same[1]);
    const w1 = vdist(pa, pb);
    if (w1 < 1e-9) return g;
    const u: Vec2 = [(pb[0] - pa[0]) / w1, (pb[1] - pa[1]) / w1];
    const na: Vec2 = [pa[0] - u[0] * oa * w1, pa[1] - u[1] * oa * w1];
    const nb: Vec2 = [pb[0] + u[0] * ob * w1, pb[1] + u[1] * ob * w1];
    return flip ? [nb, na] : [na, nb];
  });
}

/** Each guides list and the column it was drawn on, per satin (pieces of a cut satin share the list). */
const drawnOn = new WeakMap<object, Map<string, DesignObject>>();

/**
 * The document with every satin's guides on its column: a list not seen
 * before is taken as drawn on the column it comes with; a list whose column
 * has changed since is refitted. The same document when nothing moved.
 */
export function followGuides(doc: StitchDocument): StitchDocument {
  let changed = false;
  const objects = doc.objects.map((o) => {
    if (!isSatin(o) || !o.stitch.guides?.length) return o;
    const g = o.stitch.guides;
    let seen = drawnOn.get(g);
    if (!seen) drawnOn.set(g, (seen = new Map()));
    const on = seen.get(o.id);
    // a list new to this satin lies where it was drawn
    if (!on) {
      seen.set(o.id, o);
      return o;
    }
    if (on.paths === o.paths && isSatin(on) && on.stitch.width === o.stitch.width && !!on.stitch.multi === !!o.stitch.multi) return o;
    const next = refitGuides(g, on, o);
    if (!next) return o;
    const out: DesignObject = { ...o, stitch: { ...o.stitch, guides: next } };
    drawnOn.set(next, new Map([[o.id, out]]));
    changed = true;
    return out;
  });
  return changed ? { ...doc, objects } : doc;
}
