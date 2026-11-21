// The parts of a fill shape (an outline and the counters inside it) and
// cutting them along a drawn segment: only where the segment runs inside the
// shape (a chord) is it cut, so a short cut across one stroke of a letter
// leaves its other strokes whole. A chord from the outline into a counter
// opens the counter. After the NOVAstitch Designer fork
// (effepol/NOVAstitch-designer, module m, «Dividi e dirigi»).

import type { DesignObject, SubPath, Vec2 } from "../types";
import { flatten } from "./geometry";

export type Line = [Vec2, Vec2];

const sub = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]];
const add = (a: Vec2, b: Vec2): Vec2 => [a[0] + b[0], a[1] + b[1]];
const mul = (a: Vec2, k: number): Vec2 => [a[0] * k, a[1] * k];
const cross = (a: Vec2, b: Vec2) => a[0] * b[1] - a[1] * b[0];
const len = (a: Vec2) => Math.hypot(a[0], a[1]);
export const midOf = (a: Vec2, b: Vec2): Vec2 => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];

/** A vertex of a ring; `tag` marks where a cut crosses the outline. */
interface V {
  p: Vec2;
  tag?: number;
}
type Ring = V[];
/** A part of a shape: one outline (counter-clockwise) and its counters (clockwise). */
export interface Region {
  outer: Ring;
  holes: Ring[];
}

export function signedArea(r: Vec2[]): number {
  let s = 0;
  for (let i = 0; i < r.length; i++) s += cross(r[i], r[(i + 1) % r.length]);
  return s / 2;
}

/** Even-odd test against rings. */
export function insideRings(rings: Vec2[][], q: Vec2): boolean {
  let c = false;
  for (const r of rings)
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const [a, b] = [r[i], r[j]];
      if (a[1] > q[1] !== b[1] > q[1] && q[0] < ((b[0] - a[0]) * (q[1] - a[1])) / (b[1] - a[1]) + a[0]) c = !c;
    }
  return c;
}
export const ringPoints = (r: Ring): Vec2[] => r.map((v) => v.p);
export const regionRings = (g: Region): Vec2[][] => [g.outer, ...g.holes].map(ringPoints);
export const insideRegion = (g: Region, q: Vec2) => insideRings(regionRings(g), q);
export const regionArea = (g: Region) => Math.abs(signedArea(ringPoints(g.outer))) - g.holes.reduce((s, h) => s + Math.abs(signedArea(ringPoints(h))), 0);

/** The region's rings as closed sub-paths (straight segments). */
export const regionPaths = (g: Region): SubPath[] => [g.outer, ...g.holes].map((r) => ({ closed: true, nodes: r.map((v) => ({ p: v.p })) }));

/** A point well inside the region (the middle of its widest horizontal span through the outline's centre height). */
export function pointInside(g: Region): Vec2 {
  const rings = regionRings(g);
  const ys = ringPoints(g.outer).map((p) => p[1]);
  const lo = Math.min(...ys);
  const hi = Math.max(...ys);
  let best: Vec2 = ringPoints(g.outer)[0];
  let bestW = -1;
  for (const f of [0.5, 0.3, 0.7, 0.15, 0.85]) {
    const y = lo + (hi - lo) * f;
    const xs: number[] = [];
    for (const r of rings)
      for (let i = 0; i < r.length; i++) {
        const a = r[i];
        const b = r[(i + 1) % r.length];
        if (a[1] > y !== b[1] > y) xs.push(a[0] + ((y - a[1]) * (b[0] - a[0])) / (b[1] - a[1]));
      }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2)
      if (xs[k + 1] - xs[k] > bestW) {
        bestW = xs[k + 1] - xs[k];
        best = [(xs[k] + xs[k + 1]) / 2, y];
      }
    if (bestW > 0) break;
  }
  return best;
}

/** The shape's closed outlines as regions: each outline with the counters inside it. */
export function regionsOf(o: Pick<DesignObject, "paths">): Region[] {
  const rings = o.paths
    .filter((sp) => sp.closed && sp.nodes.length >= 3)
    .map((sp) => {
      const r = flatten(sp, 16);
      if (r.length > 2 && len(sub(r[0], r[r.length - 1])) < 1e-9) r.pop();
      return r.filter((p, i) => i === 0 || len(sub(p, r[i - 1])) > 1e-9);
    })
    .filter((r) => r.length >= 3 && Math.abs(signedArea(r)) > 1e-9);
  // depth: how many other outlines hold the ring; even = outline, odd = counter
  const depth = rings.map((r, i) => rings.filter((q, j) => j !== i && insideRings([q], r[0])).length);
  const orient = (r: Vec2[], ccw: boolean): Ring => (signedArea(r) > 0 === ccw ? r : [...r].reverse()).map((p) => ({ p }));
  const outers = rings.map((r, i) => ({ r, i })).filter(({ i }) => depth[i] % 2 === 0);
  const regions: Region[] = outers.map(({ r }) => ({ outer: orient(r, true), holes: [] }));
  rings.forEach((r, i) => {
    if (depth[i] % 2 === 0) return;
    // the smallest outline holding it
    let best = -1;
    outers.forEach(({ r: q }, k) => {
      if (insideRings([q], r[0]) && (best < 0 || Math.abs(signedArea(q)) < Math.abs(signedArea(outers[best].r)))) best = k;
    });
    if (best >= 0) regions[best].holes.push(orient(r, false));
  });
  return regions;
}

interface Hit {
  ring: number; // 0 = outer, 1.. = holes
  edge: number;
  te: number; // along the edge
  ts: number; // along the cut
  p: Vec2;
}

/** Where segment a→b crosses the region's outlines, along the cut. */
function hitsOf(g: Region, a: Vec2, b: Vec2): Hit[] {
  const rings = [g.outer, ...g.holes];
  const d = sub(b, a);
  const out: Hit[] = [];
  rings.forEach((r, ri) => {
    for (let i = 0; i < r.length; i++) {
      const p = r[i].p;
      const q = r[(i + 1) % r.length].p;
      const e = sub(q, p);
      const den = cross(d, e);
      if (Math.abs(den) < 1e-12) continue;
      const w = sub(p, a);
      const ts = cross(w, e) / den;
      const te = cross(w, d) / den;
      if (ts < 0 || ts > 1 || te < 0 || te >= 1) continue;
      out.push({ ring: ri, edge: i, te, ts, p: add(a, mul(d, ts)) });
    }
  });
  return out.sort((x, y) => x.ts - y.ts);
}

/** The stretches of the cut inside the region, in order along it (empty: the cut misses it). */
function chordHits(g: Region, a: Vec2, b: Vec2): [Hit, Hit][] {
  const hits = hitsOf(g, a, b);
  const out: [Hit, Hit][] = [];
  for (let k = 0; k + 1 < hits.length; k++) {
    const [h0, h1] = [hits[k], hits[k + 1]];
    if (h1.ts - h0.ts < 1e-9) continue;
    if (insideRegion(g, midOf(h0.p, h1.p))) out.push([h0, h1]);
  }
  return out;
}

/** The stretches of segment a→b that run inside the region from edge to edge: where it cuts. */
export const chordsOf = (g: Region, a: Vec2, b: Vec2): Line[] => chordHits(g, a, b).map(([h0, h1]) => [h0.p, h1.p]);

/** Split region g along the segment a→b: each chord splits an outline or opens a counter. */
export function splitRegion(g: Region, a: Vec2, b: Vec2): Region[] {
  const chords = chordHits(g, a, b);
  if (!chords.length) return [g];
  // put every chord end into its ring as a tagged vertex
  const rings: Ring[] = [g.outer, ...g.holes].map((r) => r.map((v) => ({ p: v.p })));
  const byRing = new Map<number, { edge: number; te: number; tag: number; p: Vec2 }[]>();
  chords.forEach(([h0, h1], k) => {
    for (const [h, tag] of [
      [h0, 2 * k],
      [h1, 2 * k + 1],
    ] as const) {
      if (!byRing.has(h.ring)) byRing.set(h.ring, []);
      byRing.get(h.ring)!.push({ edge: h.edge, te: h.te, tag, p: h.p });
    }
  });
  for (const [ri, list] of byRing) {
    list.sort((x, y) => x.edge - y.edge || x.te - y.te);
    const r = rings[ri];
    const out: Ring = [];
    let k = 0;
    for (let i = 0; i < r.length; i++) {
      out.push(r[i]);
      while (k < list.length && list[k].edge === i) {
        out.push({ p: list[k].p, tag: list[k].tag });
        k++;
      }
    }
    rings[ri] = out;
  }
  const parts: Region[] = [{ outer: rings[0], holes: rings.slice(1) }];
  chords.forEach((_, k) => {
    const [tx, ty] = [2 * k, 2 * k + 1];
    const find = (rg: Region, tag: number) => {
      const all = [rg.outer, ...rg.holes];
      for (let ri = 0; ri < all.length; ri++) {
        const vi = all[ri].findIndex((v) => v.tag === tag);
        if (vi >= 0) return { ri, vi };
      }
      return null;
    };
    const pi = parts.findIndex((rg) => find(rg, tx) && find(rg, ty));
    if (pi < 0) return;
    const rg = parts[pi];
    const X = find(rg, tx)!;
    const Y = find(rg, ty)!;
    const all = [rg.outer, ...rg.holes];
    if (X.ri === Y.ri) {
      // a chord across the outline: two parts, each counter goes with the part holding it
      if (X.ri !== 0) return;
      const r = rg.outer;
      const [i, j] = X.vi < Y.vi ? [X.vi, Y.vi] : [Y.vi, X.vi];
      const ra = r.slice(i, j + 1);
      const rb = [...r.slice(j), ...r.slice(0, i + 1)];
      const holesOf = (q: Ring) => rg.holes.filter((h) => insideRings([ringPoints(q)], h[0].p));
      parts.splice(pi, 1, { outer: ra, holes: holesOf(ra) }, { outer: rb, holes: holesOf(rb) });
      return;
    }
    // a chord from one outline to another: the two join through it (a counter opens)
    const [P, Q] = X.ri < Y.ri ? [X, Y] : [Y, X];
    const rp = all[P.ri];
    const rq = all[Q.ri];
    const joined: Ring = [...rp.slice(0, P.vi + 1), ...rq.slice(Q.vi), ...rq.slice(0, Q.vi + 1), { p: rp[P.vi].p }, ...rp.slice(P.vi + 1)];
    const rest = all.filter((_, ri) => ri !== P.ri && ri !== Q.ri);
    parts[pi] = P.ri === 0 ? { outer: joined, holes: rest.slice(0) } : { outer: rg.outer, holes: [...rg.holes.filter((h) => h !== rp && h !== rq), joined] };
  });
  return parts.filter((rg) => regionArea(rg) > 1e-4);
}

/**
 * Cut every part the segment crosses, the parts reaching over the cut by
 * half the overlap each (no gap opens when the fabric pulls): the side ahead
 * of the cut is cut a half-overlap behind it and the other way round, and of
 * each shifted cut only the parts touching the drawn cut are kept.
 */
export function cutParts(parts: Region[], cut: Line, overlap: number): Region[] {
  const [a, b] = cut;
  if (!(len(sub(b, a)) > 1e-9)) return parts;
  const n: Vec2 = (() => {
    const v: Vec2 = [-(b[1] - a[1]), b[0] - a[0]];
    const l = len(v);
    return [v[0] / l, v[1] / l];
  })();
  return parts.flatMap((g) => {
    const chords = chordHits(g, a, b);
    if (!chords.length) return [g];
    const plain = splitRegion(g, a, b);
    if (!(overlap > 0) || plain.length < 2) return plain;
    const mids = chords.map(([h0, h1]) => midOf(h0.p, h1.p));
    const h = overlap / 2;
    const side = (k: number) => {
      const off = mul(n, k * h);
      const pieces = splitRegion(g, add(a, off), add(b, off));
      return pieces.length < 2 ? null : pieces.filter((rg) => mids.some((m) => insideRegion(rg, m)));
    };
    // shifted back: the parts ahead, grown back over the cut; shifted ahead: the parts behind
    const ahead = side(-1);
    const behind = side(1);
    if (!ahead || !behind) return plain;
    return [...ahead, ...behind];
  });
}
