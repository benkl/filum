// A part of a shape as one satin column: its two rails are the two sides of
// its outline between the column's ends, and the rungs (node pairs, one on
// each rail) lie across the column point by point, so a curved part is sewn
// along its curve. Split into satins uses it for every part without a counter.
//
// The ends: the cut lines the part lies on (two cuts: the sides between them;
// one cut: the other end halfway round the rest of the outline, a flat end
// there taken whole, which the fork leaves a point). Without
// cuts, or when the cuts run along a side (a branch cut off a stroke), the
// two ends that make the most slender column, a flat end taken whole. The
// rungs are an optimal alignment of the two rails that never goes back on
// either, weighing each rung's length and how much it leans along the
// column; a direction line is a rung where it lies. Every corner of the
// outline is a node, so the satin covers the part; only slivers a cut leaves
// on a side are closed.
//
// After the NOVAstitch Designer fork (effepol/NOVAstitch-designer, module m,
// «Dividi e dirigi» following curved parts, 25 Nov 2026).

import type { Vec2 } from "../types";
import { cumulative, pointAt, segmentsCross } from "./polyline";
import { insideRegion, midOf, ringPoints, type Line, type Region } from "./regions";
import { add, cross, dist, dot, len, mul, norm as unit, sub } from "./vec";

export type Rails = [Vec2[], Vec2[]];

/** A closed outline walked by arc length. */
class Outline {
  readonly c: number[];
  readonly L: number;
  constructor(readonly p: Vec2[]) {
    this.c = cumulative(p, true);
    this.L = this.c[this.c.length - 1];
  }
  /** Wraps around. */
  at(d: number): Vec2 {
    return pointAt(this.p, this.c, ((d % this.L) + this.L) % this.L);
  }
  /** The outline from `from` forward to `to` (`to` may pass the start), with its corners. */
  arc(from: number, to: number): Vec2[] {
    while (to < from) to += this.L;
    const out: Vec2[] = [this.at(from)];
    for (let lap = 0; lap < 2; lap++)
      for (let i = 0; i < this.p.length; i++) {
        const d = this.c[i] + lap * this.L;
        if (d > from + 1e-9 && d < to - 1e-9) out.push(this.p[i]);
      }
    out.push(this.at(to));
    return out.filter((q, i) => i === 0 || dist(q, out[i - 1]) > 1e-9);
  }
}

/**
 * A column given as point pairs at fractions 0..1 along it: its mean width
 * and the length of its middle line.
 */
function measure(pairAt: (f: number) => [Vec2, Vec2], K = 24): { width: number; along: number } {
  let w = 0;
  let along = 0;
  let prev: Vec2 | null = null;
  for (let k = 0; k <= K; k++) {
    const [p, q] = pairAt(k / K);
    w += dist(p, q);
    const m = midOf(p, q);
    if (prev) along += dist(m, prev);
    prev = m;
  }
  return { width: w / (K + 1), along };
}

/** Two rails matched by share of their length. */
function byShare([a, b]: Rails): (f: number) => [Vec2, Vec2] {
  const ca = cumulative(a);
  const cb = cumulative(b);
  return (f) => [pointAt(a, ca, ca[ca.length - 1] * f), pointAt(b, cb, cb[cb.length - 1] * f)];
}

/** Width over length: a column is narrow and long. */
function slenderness(r: Rails): number {
  const { width, along } = measure(byShare(r));
  return width / Math.max(along, 1e-9);
}

/** Stretches of the outline lying on a cut line (the part's cut ends), as arc positions [start, end]. */
function cutRuns(o: Outline, cutLines: Line[]): [number, number][] {
  const n = o.p.length;
  const onCut = (i: number) => {
    const p = o.p[i];
    const q = o.p[(i + 1) % n];
    if (dist(p, q) < 1e-9) return false;
    return cutLines.some(([a, b]) => {
      const d = sub(b, a);
      const l = len(d);
      if (l < 1e-9) return false;
      const off = (r: Vec2) => Math.abs(cross(d, sub(r, a))) / l;
      const t = dot(sub(midOf(p, q), a), d) / (l * l);
      return off(p) < 1e-6 && off(q) < 1e-6 && t > -1e-6 && t < 1 + 1e-6;
    });
  };
  const flags = Array.from({ length: n }, (_, i) => onCut(i));
  if (flags.every(Boolean) || !flags.some(Boolean)) return [];
  // walk from the start of a run
  const first = flags.findIndex((f, i) => f && !flags[(i - 1 + n) % n]);
  const runs: [number, number][] = [];
  for (let k = 0; k < n; k++) {
    const i = (first + k) % n;
    if (!flags[i]) continue;
    const [s, e] = [o.c[i], o.c[i + 1]];
    const last = runs[runs.length - 1];
    if (last && k > 0 && flags[(i - 1 + n) % n]) last[1] = e < last[1] ? e + o.L : e;
    else runs.push([s, e]);
  }
  return runs;
}

/**
 * The end of a column near the outline point at `d`: a flat end (a side
 * between two corners turning more than 45°) no longer than `reach`, within
 * `reach / 2` of the point, lying across the column (at least 60° from the
 * way to `inner`, a point of the middle line a little way in) and not
 * `banned` (on a cut along a side); else the point itself.
 */
function endStretch(o: Outline, d: number, reach: number, inner: Vec2, banned: (d: number) => boolean): [number, number] {
  const n = o.p.length;
  const corner = (i: number) => {
    const u = unit(sub(o.p[i], o.p[(i - 1 + n) % n]));
    const v = unit(sub(o.p[(i + 1) % n], o.p[i]));
    return Math.acos(Math.max(-1, Math.min(1, dot(u, v)))) > Math.PI / 4;
  };
  const cs = o.p.flatMap((_, i) => (corner(i) ? [o.c[i]] : []));
  if (cs.length < 2) return [d, d];
  const x = ((d % o.L) + o.L) % o.L;
  let best: { r: [number, number]; across: number } | null = null;
  for (let k = 0; k < cs.length; k++) {
    const s0 = cs[k];
    let s1 = cs[(k + 1) % cs.length];
    if (s1 <= s0) s1 += o.L;
    if (s1 - s0 > reach || banned((s0 + s1) / 2)) continue;
    const into = (((x - s0) % o.L) + o.L) % o.L;
    const gap = into <= s1 - s0 ? 0 : Math.min(into - (s1 - s0), o.L - into);
    if (gap > reach / 2) continue;
    const across = Math.abs(dot(unit(sub(o.at(s1), o.at(s0))), unit(sub(inner, midOf(o.at(s0), o.at(s1))))));
    if (across < 0.5 && (!best || across < best.across)) best = { r: [s0, s1], across };
  }
  if (!best) return [d, d];
  // the side as positions around the point
  let [r0, r1] = best.r;
  while (r0 - x > o.L / 2) {
    r0 -= o.L;
    r1 -= o.L;
  }
  while (x - r0 > o.L / 2) {
    r0 += o.L;
    r1 += o.L;
  }
  return [r0 + d - x, r1 + d - x];
}

/** Rail 1 from the first end to the second along one side, rail 2 along the other (ends as [start, end] in the outline's direction). */
const railsBetween = (o: Outline, e1: [number, number], e2: [number, number]): Rails => [o.arc(e1[1], e2[0]), o.arc(e2[1], e1[0] + o.L).reverse()];

/** Where the column's ends are: the cuts, or the most slender column the outline makes. */
function endsOf(o: Outline, runs: [number, number][]): Rails {
  const onRun = (d: number) =>
    runs.some(([a, b]) => {
      const x = (((d - a) % o.L) + o.L) % o.L;
      return x <= b - a + 1 || x >= o.L - 1;
    });
  // rails between two ends, an end given as a point taken as the flat end there if there is one
  const settle = (e1: [number, number], e2: [number, number]): Rails => {
    const at = byShare(railsBetween(o, e1, e2));
    const { width, along } = measure(at);
    const f = Math.max(0.02, Math.min(0.25, width / Math.max(along, 1e-9)));
    const flat = (e: [number, number], inner: Vec2) => (e[0] === e[1] ? endStretch(o, e[0], 1.5 * width, inner, onRun) : e);
    return railsBetween(o, flat(e1, midOf(...at(f))), flat(e2, midOf(...at(1 - f))));
  };
  const free = (): Rails => {
    // every pair of end points, coarse then finer; an end is never on a cut
    const N = 72;
    const score = (s: number, t: number) => {
      const span = (((t - s) % o.L) + o.L) % o.L;
      const { width, along } = measure((f) => [o.at(s + span * f), o.at(s - (o.L - span) * f)], 16);
      return width / Math.max(along, 1e-9);
    };
    let best = { s: 0, t: o.L / 2, v: Infinity };
    const consider = (s: number, t: number) => {
      if (onRun(s) || onRun(t)) return;
      const v = score(s, t);
      if (v < best.v) best = { s, t, v };
    };
    for (let i = 0; i < N; i++) for (let j = Math.ceil(N * 0.2); j <= Math.floor(N * 0.8); j++) consider((o.L * i) / N, (o.L * (i + j)) / N);
    for (let round = 0; round < 3; round++) {
      const h = o.L / N / 4 ** round;
      const b0 = best;
      for (let i = -4; i <= 4; i++) for (let j = -4; j <= 4; j++) consider(b0.s + (i * h) / 2, b0.t + (j * h) / 2);
    }
    return settle([best.s, best.s], [best.t, best.t]);
  };
  let cut: Rails | null = null;
  if (runs.length === 2) cut = railsBetween(o, runs[0], runs[1]);
  else if (runs.length === 1) {
    // the other end halfway round the rest of the outline (a flat end there taken whole)
    const [s, e] = runs[0];
    const far = e + (s + o.L - e) / 2;
    cut = settle(runs[0], [far, far]);
  }
  if (!cut) return free();
  // cuts along a side are not the column's ends
  const alt = free();
  return slenderness(cut) > 1.5 * slenderness(alt) ? alt : cut;
}

/** Where the line through m along n meets a polyline: arc position on it, and distance along the line. */
function lineHits(m: Vec2, n: Vec2, p: Vec2[], c: number[]): { d: number; s: number }[] {
  const out: { d: number; s: number }[] = [];
  for (let i = 1; i < p.length; i++) {
    const e = sub(p[i], p[i - 1]);
    const den = cross(n, e);
    if (Math.abs(den) < 1e-12) continue;
    const w = sub(p[i - 1], m);
    const u = cross(w, n) / den;
    if (u >= -1e-9 && u <= 1 + 1e-9) out.push({ d: c[i - 1] + u * (c[i] - c[i - 1]), s: cross(w, e) / den });
  }
  return out;
}

/** Arc positions along a polyline: evenly about `step` apart, and every corner. */
function samples(c: number[], step: number): number[] {
  const L = c[c.length - 1];
  const n = Math.max(2, Math.min(1200, Math.ceil(L / step)));
  const out = new Set(c);
  for (let k = 0; k <= n; k++) out.add((L * k) / n);
  return [...out].sort((x, y) => x - y).filter((d, i, arr) => i === 0 || d - arr[i - 1] > 1e-7);
}

/**
 * Rungs as arc positions on both rails: the cheapest way to pair the rails
 * from end to end without going back on either (a rung costs its squared
 * length, more when it leans along `middle`, times the stretch of rail it
 * moves along), through a rung at each direction line. `coarse`: a quarter
 * of the samples, enough to find the middle line.
 */
function pairRails(a: Vec2[], b: Vec2[], directions: Line[], middle: Vec2[] | null, coarse = false): { pairs: [number, number][]; forced: [number, number][] } {
  const ca = cumulative(a);
  const cb = cumulative(b);
  const LA = ca[ca.length - 1];
  const LB = cb[cb.length - 1];
  const step = (coarse ? 4 : 1) * Math.max(0.15, Math.max(LA, LB) / 1000);
  const forced: [number, number][] = [];
  for (const l of directions) {
    const mid = midOf(l[0], l[1]);
    const dir = unit(sub(l[1], l[0]));
    const near = (hits: { d: number; s: number }[]) => (hits.length ? hits.reduce((p, q) => (Math.abs(q.s) < Math.abs(p.s) ? q : p)).d : null);
    const x = near(lineHits(mid, dir, a, ca));
    const y = near(lineHits(mid, dir, b, cb));
    // lines that would cross one another: the first stays
    if (x !== null && y !== null && forced.every(([p, q]) => (p - x) * (q - y) > 0)) forced.push([x, y]);
  }
  const sa = [...new Set([...samples(ca, step), ...forced.map((f) => f[0])])].sort((p, q) => p - q);
  const sb = [...new Set([...samples(cb, step), ...forced.map((f) => f[1])])].sort((p, q) => p - q);
  const fixed = forced.map(([x, y]) => [sa.indexOf(x), sb.indexOf(y)] as [number, number]);
  // the path goes through each such rung: every cell wholly before or after it, no diagonal step past it
  const barred = (i: number, j: number) => fixed.some(([fi, fj]) => !((i <= fi && j <= fj) || (i >= fi && j >= fj)));
  const jumps = (i: number, j: number) =>
    fixed.some(([fi, fj]) => i - 1 <= fi && j - 1 <= fj && !(i - 1 === fi && j - 1 === fj) && i >= fi && j >= fj && !(i === fi && j === fj));
  const pa = sa.map((d) => pointAt(a, ca, d));
  const pb = sb.map((d) => pointAt(b, cb, d));
  const [n, m] = [sa.length, sb.length];
  // the column's direction where a rung would be (no middle line: rungs weighed by length only)
  const mc = middle ? cumulative(middle) : [0];
  const ML = mc[mc.length - 1];
  const reach = Math.max(0.5, ML / 40);
  const T = 1024;
  const table = Array.from({ length: T + 1 }, (_, k): Vec2 =>
    middle ? unit(sub(pointAt(middle, mc, (k / T) * ML + reach), pointAt(middle, mc, (k / T) * ML - reach))) : [0, 0],
  );
  // where along the column each sample is, as half a table index
  const fa = sa.map((d) => (d / Math.max(LA, 1e-12)) * (T / 2));
  const fb = sb.map((d) => (d / Math.max(LB, 1e-12)) * (T / 2));
  const cost = new Float64Array(n * m);
  const from = new Uint8Array(n * m); // 0 diagonal, 1 from i-1, 2 from j-1
  const pinned = fixed.length > 0;
  for (let i = 0; i < n; i++)
    for (let j = 0; j < m; j++) {
      if (!i && !j) continue;
      if (pinned && barred(i, j)) {
        cost[i * m + j] = Infinity;
        continue;
      }
      const rx = pb[j][0] - pa[i][0];
      const ry = pb[j][1] - pa[i][1];
      const w2 = rx * rx + ry * ry;
      let here = w2;
      if (middle && w2 > 1e-18) {
        const t = table[Math.max(0, Math.min(T, Math.round(fa[i] + fb[j])))];
        const along = (rx * t[0] + ry * t[1]) ** 2 / w2;
        here = w2 * (1 + 8 * along);
      }
      const da = i ? sa[i] - sa[i - 1] : 0;
      const db = j ? sb[j] - sb[j - 1] : 0;
      let best = Infinity;
      let way = 0;
      if (i && j && !(pinned && jumps(i, j))) {
        const c = cost[(i - 1) * m + j - 1] + here * (da + db);
        if (c < best) {
          best = c;
          way = 0;
        }
      }
      if (i) {
        const c = cost[(i - 1) * m + j] + here * da;
        if (c < best) {
          best = c;
          way = 1;
        }
      }
      if (j) {
        const c = cost[i * m + j - 1] + here * db;
        if (c < best) {
          best = c;
          way = 2;
        }
      }
      cost[i * m + j] = best;
      from[i * m + j] = way;
    }
  const pairs: [number, number][] = [];
  for (let i = n - 1, j = m - 1; ;) {
    pairs.push([sa[i], sb[j]]);
    if (!i && !j) break;
    const w = from[i * m + j];
    if (w === 0) {
      i--;
      j--;
    } else if (w === 1) i--;
    else j--;
  }
  return { pairs: pairs.reverse(), forced };
}

/** The middle line of paired rails, evened out over about a millimetre. */
function middleLine(a: Vec2[], b: Vec2[], pairs: [number, number][]): Vec2[] {
  const ca = cumulative(a);
  const cb = cumulative(b);
  const raw = pairs.map(([x, y]) => midOf(pointAt(a, ca, x), pointAt(b, cb, y))).filter((q, i, arr) => i === 0 || dist(q, arr[i - 1]) > 1e-9);
  const rc = cumulative(raw);
  const L = rc[rc.length - 1];
  if (raw.length < 2 || L < 1e-9) return raw.length ? raw : [a[0], a[a.length - 1]];
  const N = Math.max(10, Math.min(400, Math.ceil(L / 0.2)));
  const even = Array.from({ length: N + 1 }, (_, k) => pointAt(raw, rc, (L * k) / N));
  const w = Math.max(1, Math.round(N / L));
  return even.map((_, k) => {
    let [sx, sy, c] = [0, 0, 0];
    for (let i = Math.max(0, k - w); i <= Math.min(N, k + w); i++) {
      sx += even[i][0];
      sy += even[i][1];
      c++;
    }
    return [sx / c, sy / c] as Vec2;
  });
}

/**
 * A rail without its folds: where it turns back along the column (a sliver a
 * cut left on the side, no deeper than `deepest`) no rung could lie across,
 * so the fold is closed with a short chord across its tip or its hollow,
 * whichever lies inside the part.
 */
function unfold(rail: Vec2[], mids: Vec2[], inside: (q: Vec2) => boolean, deepest: number): Vec2[] {
  // the column's direction near a point: that of the nearest stretch of the middle line
  const towards = (q: Vec2): Vec2 => {
    let best = Infinity;
    let dir: Vec2 = [0, 0];
    for (let i = 1; i < mids.length; i++) {
      const e = sub(mids[i], mids[i - 1]);
      const l2 = dot(e, e);
      if (l2 < 1e-18) continue;
      const t = Math.max(0, Math.min(1, dot(sub(q, mids[i - 1]), e) / l2));
      const d = dist(q, add(mids[i - 1], mul(e, t)));
      if (d < best) {
        best = d;
        dir = mul(e, 1 / Math.sqrt(l2));
      }
    }
    return dir;
  };
  const progress = (r: Vec2[]) => {
    const u = [0];
    for (let i = 1; i < r.length; i++) u.push(u[i - 1] + dot(sub(r[i], r[i - 1]), towards(midOf(r[i], r[i - 1]))));
    return u;
  };
  let r = [...rail];
  let from = 1;
  for (let round = 0; round < 200; round++) {
    const u = progress(r);
    // the next turn back: the peak P, down to the hollow V, up past P again
    let p = -1;
    for (let i = from; i < u.length; i++)
      if (u[i] < u[i - 1] - 1e-6) {
        p = i - 1;
        break;
      }
    if (p < 0) return r;
    let v = p + 1;
    while (v + 1 < u.length && u[v + 1] <= u[v]) v++;
    let k = v + 1;
    while (k < u.length && u[k] < u[p]) k++;
    if (u[p] - u[v] > deepest) {
      // a real part of the shape (a foot, a branch): it stays
      from = v + 1;
      continue;
    }
    const level = (i: number, j: number, h: number): Vec2 => add(r[i], mul(sub(r[j], r[i]), (h - u[i]) / (u[j] - u[i] || 1)));
    let j = p;
    while (j > 0 && u[j - 1] > u[v]) j--;
    const ok = (a: Vec2, b: Vec2) => inside(midOf(a, b));
    if (k < u.length && ok(r[p], level(k - 1, k, u[p]))) r = [...r.slice(0, p + 1), level(k - 1, k, u[p]), ...r.slice(k)];
    else if (j > 0 && ok(level(j - 1, j, u[v]), r[v])) r = [...r.slice(0, j), level(j - 1, j, u[v]), ...r.slice(v)];
    else from = v + 1; // cannot be closed inside the part: left as it is
  }
  return r;
}

/** Rungs on straight stretches of both rails that turn evenly add nothing: dropped (`keep`: rungs that stay). */
function thin(a: Vec2[], b: Vec2[], keep: boolean[]): Rails {
  const [A, B, K] = [[...a], [...b], [...keep]];
  const off = (p: Vec2, s: Vec2, e: Vec2) => {
    const l = dist(s, e);
    return l < 1e-12 ? dist(p, s) : Math.abs(cross(sub(e, s), sub(p, s))) / l;
  };
  for (let k = 1; k < A.length - 1;) {
    const ta = dist(A[k], A[k - 1]) / Math.max(1e-12, dist(A[k + 1], A[k - 1]));
    const tb = dist(B[k], B[k - 1]) / Math.max(1e-12, dist(B[k + 1], B[k - 1]));
    if (!K[k] && off(A[k], A[k - 1], A[k + 1]) < 1e-4 && off(B[k], B[k - 1], B[k + 1]) < 1e-4 && Math.abs(ta - tb) < 0.02) {
      A.splice(k, 1);
      B.splice(k, 1);
      K.splice(k, 1);
    } else k++;
  }
  return [A, B];
}

/**
 * The rails of a part without counters, with as many points each (rungs);
 * null for a part with a counter, or one too small. `cutLines`: the cuts as
 * the part's outline holds them; `directions`: the direction lines in it.
 */
export function columnRails(g: Region, cutLines: Line[], directions: Line[]): Rails | null {
  if (g.holes.length) return null;
  const o = new Outline(ringPoints(g.outer));
  if (o.L < 1e-6) return null;
  const [a0, b0] = endsOf(o, cutLines.length ? cutRuns(o, cutLines) : []);
  if (a0.length < 2 || b0.length < 2) return null;
  // a first pairing by rung length gives the middle line; slivers (folds no deeper
  // than a quarter of the column's width, at most 1 mm) are closed along it
  const first = pairRails(a0, b0, [], null, true).pairs;
  const mids = middleLine(a0, b0, first);
  const [c0, c1] = [cumulative(a0), cumulative(b0)];
  const ws = first.map(([x, y]) => dist(pointAt(a0, c0, x), pointAt(b0, c1, y))).sort((x, y) => x - y);
  const deepest = Math.max(0.2, Math.min(1, 0.25 * ws[Math.floor(ws.length / 2)]));
  const inPart = (q: Vec2) => insideRegion(g, q);
  const a = unfold(a0, mids, inPart, deepest);
  const b = unfold(b0, mids, inPart, deepest);
  const [ca, cb] = [cumulative(a), cumulative(b)];
  // the middle line again on the rails without folds, then the rungs across it
  const { pairs, forced } = pairRails(a, b, directions, middleLine(a, b, pairRails(a, b, [], null, true).pairs));
  const A: Vec2[] = [];
  const B: Vec2[] = [];
  const keep: boolean[] = [];
  pairs.forEach(([x, y], k) => {
    const p = pointAt(a, ca, x);
    const q = pointAt(b, cb, y);
    const must = forced.some(([fx, fy]) => fx === x && fy === y);
    // a rung that would cross the one before (where a fold was closed) is left out
    if (A.length && !must && k < pairs.length - 1 && segmentsCross(A[A.length - 1], B[B.length - 1], p, q)) return;
    A.push(p);
    B.push(q);
    keep.push(must);
  });
  return thin(A, B, keep);
}
