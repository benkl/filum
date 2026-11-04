// Freehand drawing with a stabiliser ("lazy brush"): the brush tip trails the
// pointer on a rope, so hand tremor never reaches the line. On release the
// stroke is fitted with a few clean Bézier curves (corners stay sharp) and
// becomes an ordinary, editable path.

import type { SubPath, Vec2 } from "../types";
import { fitPath, vdist } from "../lib/bezier";

export interface FreehandStroke {
  raw: Vec2[];
  smooth: Vec2[];
  tip: Vec2;
}

export const startStroke = (p: Vec2): FreehandStroke => ({ raw: [p], smooth: [p], tip: p });

/** Rope length (mm) for a smoothing amount 0..1 at the current zoom (px per mm). */
export const ropeLength = (smoothing: number, scale: number) => (smoothing * 22) / scale;

/** Move the pointer; the tip follows once the rope is taut. */
export function extendStroke(s: FreehandStroke, p: Vec2, rope: number, minStep: number) {
  s.raw.push(p);
  const d = vdist(p, s.tip);
  if (d <= rope) return;
  const k = (d - rope) / d;
  const tip: Vec2 = [s.tip[0] + (p[0] - s.tip[0]) * k, s.tip[1] + (p[1] - s.tip[1]) * k];
  s.tip = tip;
  if (vdist(tip, s.smooth[s.smooth.length - 1]) >= minStep) s.smooth.push(tip);
}

/** Points of the finished stroke: the tip catches up with the pointer. */
export function finishStroke(s: FreehandStroke): Vec2[] {
  const end = s.raw[s.raw.length - 1];
  const pts = s.smooth.slice();
  const last = pts[pts.length - 1];
  const d = vdist(last, end);
  const steps = Math.ceil(d / 0.3);
  for (let i = 1; i <= steps; i++) pts.push([last[0] + ((end[0] - last[0]) * i) / steps, last[1] + ((end[1] - last[1]) * i) / steps]);
  return pts;
}

/**
 * Where a loop closes: the point of the stroke's last third that comes
 * closest to its start, if that is within 16 px (overshooting is fine). -1 = open.
 */
function closeIndex(pts: Vec2[], scale: number): number {
  if (pts.length < 8) return -1;
  let length = 0;
  for (let i = 1; i < pts.length; i++) length += vdist(pts[i], pts[i - 1]);
  if (length * scale < 60) return -1;
  let best = -1;
  let bd = Infinity;
  for (let i = Math.floor(pts.length * 0.66); i < pts.length; i++) {
    const d = vdist(pts[i], pts[0]);
    if (d < bd) {
      bd = d;
      best = i;
    }
  }
  return bd * scale < 16 ? best : -1;
}

/** Is the stroke a closed loop? */
export const isClosedStroke = (pts: Vec2[], scale: number) => closeIndex(pts, scale) >= 0;

/**
 * Smooth along the stroke: every point becomes the weighted average of its
 * neighbours within `radius` (mm of arc length). Ends stay where they are.
 */
function smoothAlong(pts: Vec2[], radius: number, closed: boolean): Vec2[] {
  if (radius <= 0 || pts.length < 5) return pts;
  const s = [0];
  for (let i = 1; i < pts.length; i++) s.push(s[i - 1] + vdist(pts[i], pts[i - 1]));
  const out: Vec2[] = pts.map((p, i) => {
    if (!closed && (i === 0 || i === pts.length - 1)) return p;
    // shrink the window near open ends so they don't get pulled inwards
    const r = closed ? radius : Math.min(radius, s[i], s[s.length - 1] - s[i]);
    if (r <= 1e-6) return p;
    let wx = 0;
    let wy = 0;
    let wsum = 0;
    for (let j = i; j >= 0 && s[i] - s[j] <= r; j--) {
      const w = 1 - (s[i] - s[j]) / r;
      wx += pts[j][0] * w;
      wy += pts[j][1] * w;
      wsum += w;
    }
    for (let j = i + 1; j < pts.length && s[j] - s[i] <= r; j++) {
      const w = 1 - (s[j] - s[i]) / r;
      wx += pts[j][0] * w;
      wy += pts[j][1] * w;
      wsum += w;
    }
    return [wx / wsum, wy / wsum];
  });
  return out;
}

/** Fitted Bézier path. Higher smoothing allows more deviation (fewer nodes). */
export function strokeToPath(pts: Vec2[], smoothing: number, scale: number, closed: boolean, cornerDeg = 65, lines = true): SubPath {
  const px = 1 / scale; // one screen pixel in mm: everything is zoom-independent
  let p = pts;
  if (closed) {
    // cut the overshoot past the start so the loop joins cleanly
    const k = closeIndex(pts, scale);
    if (k > 3) p = pts.slice(0, k + 1);
  }
  p = smoothAlong(p, (2 + smoothing * 10) * px, closed);
  const error = Math.max(0.05, (0.8 + smoothing * 4) * px);
  const sp = fitPath(p, error, closed, cornerDeg, 12 * px, { lines });
  // merge points that ended up on top of each other
  const nodes = sp.nodes.filter((n, i) => i === 0 || i === sp.nodes.length - 1 || vdist(n.p, sp.nodes[i - 1].p) > 5 * px);
  return { ...sp, nodes };
}
