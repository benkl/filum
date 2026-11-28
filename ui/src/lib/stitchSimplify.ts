// Simplify for stitching: a path as the needle can sew it. Every sharp turn
// of a path is a needle drop, so a traced or digitized outline that steps
// pixel by pixel sews in stitches of half a millimetre, all in a row
// (docs/STITCH_QUALITY_PLAN.md, phase 4). The plain Simplify effect keeps
// those steps as corners; this one smooths them out first:
//
// 1. the real corners are found over 1.5 mm of the path (a pixel step is
//    much shorter, so it doesn't count) and stay where they are;
// 2. between them the path is resampled every 0.1 mm and averaged over 1 mm,
//    which evens out the steps (a curve of 2 mm radius moves by ~0.02 mm);
// 3. curves are fitted within the running stitch's tolerance (0.25 mm).

import type { SubPath, Vec2 } from "../types";
import { cornerIndices, fitPath, flattenSubPath, resample, vdist } from "./bezier";

/** How far the path may move: about Ink/Stitch's running stitch tolerance (mm). */
export const STITCH_SIMPLIFY_TOLERANCE = 0.25;
/** A corner must turn by this much, measured over `CORNER_REACH` (degrees). */
const CORNER_DEG = 60;
/** Corners are measured over this much of the path (mm): longer than a pixel step. */
const CORNER_REACH = 1.5;
/** The path is resampled this finely before averaging (mm). */
const STEP = 0.1;
/** Half the averaging window (mm). */
const HALF_WINDOW = 0.5;

/** Average a run of points over the window, its ends fixed (they are corners or the path's ends). */
function smoothRun(run: Vec2[]): Vec2[] {
  const pts = resample(run, STEP);
  const k = Math.round(HALF_WINDOW / STEP);
  const out = pts.map((p) => p);
  for (let i = 1; i < pts.length - 1; i++) {
    // the window shrinks near the ends, so they stay put
    const w = Math.min(k, i, pts.length - 1 - i);
    let x = 0;
    let y = 0;
    for (let j = i - w; j <= i + w; j++) {
      x += pts[j][0];
      y += pts[j][1];
    }
    out[i] = [x / (2 * w + 1), y / (2 * w + 1)];
  }
  return out;
}

/** The same, around a closed loop without corners. */
function smoothLoop(loop: Vec2[]): Vec2[] {
  const pts = resample([...loop, loop[0]], STEP).slice(0, -1);
  const n = pts.length;
  const k = Math.min(Math.round(HALF_WINDOW / STEP), Math.floor((n - 1) / 2));
  return pts.map((_, i) => {
    let x = 0;
    let y = 0;
    for (let j = i - k; j <= i + k; j++) {
      const q = pts[((j % n) + n) % n];
      x += q[0];
      y += q[1];
    }
    return [x / (2 * k + 1), y / (2 * k + 1)] as Vec2;
  });
}

/** One sub-path, simplified for stitching (`tolerance` in mm). */
export function simplifyForStitching(sp: SubPath, tolerance = STITCH_SIMPLIFY_TOLERANCE): SubPath {
  let pts = flattenSubPath(sp, 0.05).filter((p, i, a) => i === 0 || vdist(p, a[i - 1]) > 1e-6);
  if (sp.closed && pts.length > 1 && vdist(pts[0], pts[pts.length - 1]) < 1e-6) pts.pop();
  if (pts.length < 3) return sp;
  let smooth: Vec2[];
  if (sp.closed) {
    // start at a corner when there is one, so the loop opens there
    const corners = cornerIndices([...pts, ...pts.slice(0, 2)], CORNER_DEG, CORNER_REACH).filter((i) => i < pts.length);
    if (!corners.length) {
      smooth = smoothLoop(pts);
    } else {
      pts = [...pts.slice(corners[0]), ...pts.slice(0, corners[0])];
      const loop = [...pts, pts[0]];
      const cuts = [0, ...cornerIndices(loop, CORNER_DEG, CORNER_REACH), loop.length - 1];
      smooth = [];
      for (let c = 0; c < cuts.length - 1; c++) smooth.push(...smoothRun(loop.slice(cuts[c], cuts[c + 1] + 1)).slice(c ? 1 : 0));
      smooth.pop();
    }
  } else {
    const cuts = [0, ...cornerIndices(pts, CORNER_DEG, CORNER_REACH), pts.length - 1];
    smooth = [];
    for (let c = 0; c < cuts.length - 1; c++) smooth.push(...smoothRun(pts.slice(cuts[c], cuts[c + 1] + 1)).slice(c ? 1 : 0));
  }
  const fit = fitPath(smooth, tolerance, sp.closed, CORNER_DEG, CORNER_REACH, { lines: true });
  // fewer nodes or nothing: a path that is already clean stays as it is
  return fit.nodes.length >= 2 && fit.nodes.length < sp.nodes.length ? { ...fit, closed: sp.closed } : sp;
}

/** How many of a path's nodes Simplify for stitching would leave (for the hint). */
export const nodeCount = (paths: SubPath[]) => paths.reduce((n, p) => n + p.nodes.length, 0);
