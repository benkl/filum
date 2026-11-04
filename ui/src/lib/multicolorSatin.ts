// Multicolour satin (Ink/Stitch "Satin multicolor"): one satin column split
// across its width into stripes of different threads. Every stripe is its
// own satin between two interpolated rails; neighbouring stripes overlap a
// little so no gap opens; only the first keeps the underlay.

import type { DesignObject, SatinParams, SubPath, Vec2 } from "../types";
import { flattenSubPath } from "./bezier";
import { satinRailIndices, uid } from "./geometry";

const lerp = (a: Vec2, b: Vec2, t: number): Vec2 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

/** A polyline resampled to n points evenly along its length. */
function resample(pts: Vec2[], n: number): Vec2[] {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const total = cum[cum.length - 1] || 1;
  const out: Vec2[] = [];
  let k = 1;
  for (let i = 0; i < n; i++) {
    const s = (total * i) / (n - 1);
    while (k < pts.length - 1 && cum[k] < s) k++;
    const l = cum[k] - cum[k - 1] || 1;
    out.push(lerp(pts[k - 1], pts[k], Math.min(1, Math.max(0, (s - cum[k - 1]) / l))));
  }
  return out;
}

/** The satin's two rails, matched point by point. */
export function satinRails(o: DesignObject): [Vec2[], Vec2[]] | null {
  if (o.stitch.type !== "satin") return null;
  const st = o.stitch as SatinParams;
  const usable = o.paths.filter((sp) => sp.nodes.length >= 2);
  const N = 120;
  if (usable.length === 1) {
    // a centre line: rails half the width to either side
    const c = resample(flattenSubPath(usable[0], 0.1), N);
    const half = st.width / 2;
    const nrm = (i: number): Vec2 => {
      const a = c[Math.max(0, i - 1)];
      const b = c[Math.min(c.length - 1, i + 1)];
      const d = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      return [-(b[1] - a[1]) / d, (b[0] - a[0]) / d];
    };
    const r0 = c.map((p, i) => [p[0] - nrm(i)[0] * half, p[1] - nrm(i)[1] * half] as Vec2);
    const r1 = c.map((p, i) => [p[0] + nrm(i)[0] * half, p[1] + nrm(i)[1] * half] as Vec2);
    return st.swapRails ? [r1, r0] : [r0, r1];
  }
  if (usable.length < 2) return null;
  const ri = satinRailIndices(o.paths)!;
  const sorted = [o.paths[ri[0]], o.paths[ri[1]]];
  const r0 = resample(flattenSubPath(sorted[0], 0.1), N);
  let r1 = resample(flattenSubPath(sorted[1], 0.1), N);
  const d = (a: Vec2, b: Vec2) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  if (d(r0[0], r1[0]) + d(r0[N - 1], r1[N - 1]) > d(r0[0], r1[N - 1]) + d(r0[N - 1], r1[0])) r1 = [...r1].reverse();
  return st.swapRails ? [r1, r0] : [r0, r1];
}

export interface Stripe {
  thread: string;
  /** Share of the column width (the shares are normalised). */
  width: number;
}

/**
 * The satin split into stripes (across, from the first rail to the second);
 * \`overlap\` mm reaches into the neighbouring stripe so none opens a gap.
 */
export function splitSatin(o: DesignObject, stripes: Stripe[], overlap = 0.2): DesignObject[] | null {
  const rails = satinRails(o);
  if (!rails || stripes.length < 2) return null;
  const [r0, r1] = rails;
  const width = Math.max(...r0.map((p, i) => Math.hypot(p[0] - r1[i][0], p[1] - r1[i][1])), 0.1);
  const total = stripes.reduce((a, s) => a + Math.max(0, s.width), 0) || 1;
  const ov = overlap / width;
  let at = 0;
  return stripes.map((s, k) => {
    const share = Math.max(0, s.width) / total;
    const t0 = Math.max(0, at - (k > 0 ? ov : 0));
    const t1 = Math.min(1, at + share + (k < stripes.length - 1 ? ov : 0));
    at += share;
    const a = r0.map((p, i) => lerp(p, r1[i], t0));
    const b = r0.map((p, i) => lerp(p, r1[i], t1));
    const rail = (pts: Vec2[]): SubPath => ({ closed: false, nodes: pts.map((p) => ({ p })) });
    const st = o.stitch as SatinParams & { type: "satin" };
    return {
      ...o,
      id: uid(),
      name: `${o.name} · stripe ${k + 1}`,
      thread: s.thread,
      paths: [rail(a), rail(b)],
      start: undefined,
      end: undefined,
      // the first stripe carries the underlay for the whole column
      stitch: {
        ...st,
        swapRails: false,
        ...(k > 0 ? { underlayAuto: false, centerWalk: false, contourUnderlay: false, zigzagUnderlay: false } : {}),
      },
    } as DesignObject;
  });
}
