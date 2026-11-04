// Cutter tool: Ink/Stitch "Cut satin column", generalised.
//  • paths (running, satin centre lines, manual) are split exactly at a point
//    on the curve (de Casteljau), keeping the Bézier shape
//  • fills are cut along a straight line into two objects (half-plane clip)

import type { DesignObject, PathNode, SubPath, Vec2 } from "../types";
import { flatten, satinRailIndices, uid } from "./geometry";

type Hit = { sp: number; seg: number; t: number; p: Vec2; d: number };

const lerp = (a: Vec2, b: Vec2, t: number): Vec2 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

function segPoint(sp: SubPath, s: number, t: number): Vec2 {
  const n = sp.nodes.length;
  const a = sp.nodes[s];
  const b = sp.nodes[(s + 1) % n];
  if (!a.o && !b.i) return lerp(a.p, b.p, t);
  const c1 = a.o ?? a.p;
  const c2 = b.i ?? b.p;
  const ab = lerp(a.p, c1, t);
  const bc = lerp(c1, c2, t);
  const cd = lerp(c2, b.p, t);
  return lerp(lerp(ab, bc, t), lerp(bc, cd, t), t);
}

/** Nearest point on an object's sub-paths. */
export function nearestOnPaths(o: DesignObject, q: Vec2): Hit | null {
  let best: Hit | null = null;
  o.paths.forEach((sp, si) => {
    const n = sp.nodes.length;
    const segs = sp.closed ? n : n - 1;
    for (let s = 0; s < segs; s++) {
      // coarse sampling, then refine by bisection on t
      let bt = 0;
      let bd = Infinity;
      const K = 24;
      for (let k = 0; k <= K; k++) {
        const p = segPoint(sp, s, k / K);
        const d = Math.hypot(p[0] - q[0], p[1] - q[1]);
        if (d < bd) {
          bd = d;
          bt = k / K;
        }
      }
      let lo = Math.max(0, bt - 1 / K);
      let hi = Math.min(1, bt + 1 / K);
      for (let it = 0; it < 24; it++) {
        const m1 = lo + (hi - lo) / 3;
        const m2 = hi - (hi - lo) / 3;
        const d1 = Math.hypot(...(segPoint(sp, s, m1).map((v, i) => v - q[i]) as [number, number]));
        const d2 = Math.hypot(...(segPoint(sp, s, m2).map((v, i) => v - q[i]) as [number, number]));
        if (d1 < d2) hi = m2;
        else lo = m1;
      }
      const t = (lo + hi) / 2;
      const p = segPoint(sp, s, t);
      const d = Math.hypot(p[0] - q[0], p[1] - q[1]);
      if (!best || d < best.d) best = { sp: si, seg: s, t, p, d };
    }
  });
  return best;
}

/** Split sub-path `sp` at segment `seg`, parameter `t`. */
function splitSubPath(sp: SubPath, seg: number, t: number): SubPath[] {
  const n = sp.nodes.length;
  const nodes = sp.nodes.map((x) => ({ ...x }));
  const a = nodes[seg];
  const b = nodes[(seg + 1) % n];
  let mid: PathNode;
  if (!a.o && !b.i) {
    mid = { p: lerp(a.p, b.p, t) };
  } else {
    const c1 = a.o ?? a.p;
    const c2 = b.i ?? b.p;
    const ab = lerp(a.p, c1, t);
    const bc = lerp(c1, c2, t);
    const cd = lerp(c2, b.p, t);
    const abc = lerp(ab, bc, t);
    const bcd = lerp(bc, cd, t);
    mid = { p: lerp(abc, bcd, t), i: abc, o: bcd };
    if (a.o) a.o = ab;
    if (b.i) b.i = cd;
  }
  const before: PathNode = { p: mid.p, ...(mid.i ? { i: mid.i } : {}) };
  const after: PathNode = { p: mid.p, ...(mid.o ? { o: mid.o } : {}) };
  if (sp.closed) {
    // opening a closed path: it starts and ends at the cut
    const rest = [...nodes.slice(seg + 1), ...nodes.slice(0, seg + 1)];
    return [{ closed: false, nodes: [after, ...rest, before] }];
  }
  return [
    { closed: false, nodes: [...nodes.slice(0, seg + 1), before] },
    { closed: false, nodes: [after, ...nodes.slice(seg + 1)] },
  ];
}

/** Cut a path object at the nearest point to `q`. Returns the replacement objects. */
/**
 * Cut a two-rail satin across: both rails split at matching points (the
 * clicked rail where clicked, the other rail where it comes nearest), the
 * rungs and direction guides go with the half they lie in. (Ink/Stitch
 * "Cut satin column".) Null when the object is not a two-rail satin.
 */
export function cutSatinObject(o: DesignObject, q: Vec2): DesignObject[] | null {
  if (o.stitch.type !== "satin") return null;
  const rails = o.paths.map((sp, i) => ({ sp, i })).filter((x) => x.sp.nodes.length >= 2);
  if (rails.length < 2) return null;
  // the rails as the engine picks them
  const ri = satinRailIndices(o.paths);
  if (!ri) return null;
  const [r0, r1] = [{ sp: o.paths[ri[0]], i: ri[0] }, { sp: o.paths[ri[1]], i: ri[1] }];
  const one = (i: number) => ({ ...o, paths: [o.paths[i]] });
  const h0 = nearestOnPaths(one(r0.i), q);
  const h1 = nearestOnPaths(one(r1.i), q);
  if (!h0 || !h1) return null;
  // the clicked rail is the nearer one; the other is cut where it is nearest to that point
  const [hitA, ia, ib] = h0.d <= h1.d ? [h0, r0.i, r1.i] : [h1, r1.i, r0.i];
  const pa = segPoint(o.paths[ia], hitA.seg, hitA.t);
  const hitB = nearestOnPaths(one(ib), pa);
  if (!hitB) return null;
  const pa2 = splitSubPath(o.paths[ia], hitA.seg, hitA.t);
  const pb2 = splitSubPath(o.paths[ib], hitB.seg, hitB.t);
  if (pa2.length < 2 || pb2.length < 2) return null;
  const pb = segPoint(o.paths[ib], hitB.seg, hitB.t);
  // which half a point belongs to: the side of the cut line it lies on, like the first half
  const firstSide = (() => {
    const ref = pa2[0].nodes[0].p;
    return Math.sign((pb[0] - pa[0]) * (ref[1] - pa[1]) - (pb[1] - pa[1]) * (ref[0] - pa[0])) || 1;
  })();
  const inFirst = (p: Vec2) => Math.sign((pb[0] - pa[0]) * (p[1] - pa[1]) - (pb[1] - pa[1]) * (p[0] - pa[0])) === firstSide;
  const mid = (sp: SubPath): Vec2 => {
    const f = sp.nodes[0].p;
    const l = sp.nodes[sp.nodes.length - 1].p;
    return [(f[0] + l[0]) / 2, (f[1] + l[1]) / 2];
  };
  const rungs = o.paths.filter((_, i) => i !== ia && i !== ib);
  const guides = o.stitch.guides ?? [];
  const half = (k: 0 | 1): DesignObject => {
    const keep = (p: Vec2) => (k === 0 ? inFirst(p) : !inFirst(p));
    const railsK = [pa2[k], pb2[k]];
    const st = { ...o.stitch, guides: guides.filter((g) => keep([(g[0][0] + g[1][0]) / 2, (g[0][1] + g[1][1]) / 2])) };
    return { ...o, id: uid(), name: `${o.name} ${k ? "b" : "a"}`, start: undefined, end: undefined, paths: [...railsK, ...rungs.filter((r) => keep(mid(r)))], stitch: st };
  };
  return [half(0), half(1)];
}

export function cutPathObject(o: DesignObject, q: Vec2): DesignObject[] | null {
  const hit = nearestOnPaths(o, q);
  if (!hit) return null;
  const sp = o.paths[hit.sp];
  const parts = splitSubPath(sp, hit.seg, hit.t);
  const strip = (x: DesignObject): DesignObject => ({ ...x, start: undefined, end: undefined });
  if (parts.length === 1) {
    // a closed path was opened: still one object
    return [strip({ ...o, paths: o.paths.map((p, i) => (i === hit.sp ? parts[0] : p)) })];
  }
  const before = o.paths.slice(0, hit.sp);
  const after = o.paths.slice(hit.sp + 1);
  return [
    strip({ ...o, id: uid(), name: `${o.name} a`, paths: [...before, parts[0]] }),
    strip({ ...o, id: uid(), name: `${o.name} b`, paths: [parts[1], ...after] }),
  ];
}

/** Sutherland–Hodgman clip of a ring against the half-plane side(p) ≥ 0. */
function clipRing(ring: Vec2[], side: (p: Vec2) => number): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const sa = side(a);
    const sb = side(b);
    if (sa >= 0) out.push(a);
    if ((sa >= 0) !== (sb >= 0)) out.push(lerp(a, b, sa / (sa - sb)));
  }
  return out;
}

const area = (r: Vec2[]) => {
  let s = 0;
  for (let i = 0; i < r.length; i++) {
    const a = r[i];
    const b = r[(i + 1) % r.length];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return Math.abs(s / 2);
};

/** Cut a fill object along the infinite line through a→b. Null if the line misses it. */
export function cutFillObject(o: DesignObject, a: Vec2, b: Vec2): DesignObject[] | null {
  const d = [b[0] - a[0], b[1] - a[1]];
  if (Math.hypot(d[0], d[1]) < 1e-6) return null;
  const side = (p: Vec2) => (p[0] - a[0]) * d[1] - (p[1] - a[1]) * d[0];
  const rings = o.paths.map((sp) => {
    const pts = flatten(sp, 16);
    if (pts.length > 2 && Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]) < 1e-9) pts.pop();
    return pts;
  });
  const half = (sgn: number) =>
    rings
      .map((r) => clipRing(r, (p) => sgn * side(p)))
      .filter((r) => r.length >= 3 && area(r) > 0.05)
      .map((r): SubPath => ({ closed: true, nodes: r.map((p) => ({ p })) }));
  const left = half(1);
  const right = half(-1);
  if (!left.length || !right.length) return null;
  const strip = { start: undefined, end: undefined };
  return [
    { ...o, ...strip, id: uid(), name: `${o.name} a`, paths: left },
    { ...o, ...strip, id: uid(), name: `${o.name} b`, paths: right },
  ];
}
