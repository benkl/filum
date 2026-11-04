// Satin direction guides: lines across a satin column that set the stitch
// angle there (Ink/Stitch rungs); between two guides the angle turns evenly.
// They live on the satin's stitch params (apart from its nodes, so editing
// the outline keeps them) and work on centre-line and two-rail satins alike.
// Shared: the canvas tool, the Properties panel and anything that generates
// satins (lettering, the auto-digitizer, shape conversions) use these helpers.

import { useStore } from "../store";
import type { DesignObject, SatinParams, StitchDocument, SubPath, Vec2 } from "../types";
import { flattenSubPath } from "./bezier";

export type Guide = [Vec2, Vec2];

const sub = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]];
const add = (a: Vec2, b: Vec2): Vec2 => [a[0] + b[0], a[1] + b[1]];
const mul = (a: Vec2, k: number): Vec2 => [a[0] * k, a[1] * k];
const len = (a: Vec2) => Math.hypot(a[0], a[1]);
const norm = (a: Vec2): Vec2 => {
  const l = len(a);
  return l < 1e-12 ? [0, 0] : [a[0] / l, a[1] / l];
};

export const isSatin = (o: DesignObject | undefined): o is DesignObject & { stitch: { type: "satin" } & SatinParams } => o?.stitch.type === "satin";

export const guidesOf = (o: DesignObject | undefined): Guide[] => (isSatin(o) ? (o.stitch.guides ?? []) : []);

/** The selected satin (the first one selected). */
export function selectedSatin(): DesignObject | undefined {
  const s = useStore.getState();
  return s.doc.objects.find((o) => s.selection.includes(o.id) && isSatin(o));
}

/** Replace a satin's guides (live: during a drag, without an undo step). */
export function setGuides(id: string, guides: Guide[], live = false) {
  const s = useStore.getState();
  const fn = (d: StitchDocument) => ({
    ...d,
    objects: d.objects.map((x) => (x.id === id && x.stitch.type === "satin" ? { ...x, stitch: { ...x.stitch, guides: guides.length ? guides : undefined } } : x)),
  });
  if (live) s.liveUpdate(fn);
  else s.commit(fn);
}

/** The guide (and end) under a point. */
export function guideHit(guides: Guide[], p: Vec2, tol: number): { index: number; end: 0 | 1 | null } | null {
  for (let i = guides.length - 1; i >= 0; i--) {
    const [a, b] = guides[i];
    if (len(sub(a, p)) < tol) return { index: i, end: 0 };
    if (len(sub(b, p)) < tol) return { index: i, end: 1 };
  }
  for (let i = guides.length - 1; i >= 0; i--) {
    const [a, b] = guides[i];
    const ab = sub(b, a);
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1]) / Math.max(1e-12, ab[0] * ab[0] + ab[1] * ab[1])));
    if (len(sub(add(a, mul(ab, t)), p)) < tol) return { index: i, end: null };
  }
  return null;
}

/** The satin's centre line and its width (two-rail satins: the middle of the rails). */
function centreOf(o: DesignObject & { stitch: SatinParams }): { pts: Vec2[]; width: number } | null {
  const usable = o.paths.filter((sp) => sp.nodes.length >= 2);
  if (usable.length === 1) return { pts: flattenSubPath(usable[0], 0.2), width: o.stitch.width };
  if (usable.length < 2) return null;
  const [a, b] = [...usable].sort((x, y) => y.nodes.length - x.nodes.length || flatLen(y) - flatLen(x)).slice(0, 2).map((sp) => flattenSubPath(sp, 0.2));
  const n = 80;
  const at = (pts: Vec2[], t: number) => pointAt(pts, t);
  const rev = len(sub(a[0], b[0])) + len(sub(a[a.length - 1], b[b.length - 1])) > len(sub(a[0], b[b.length - 1])) + len(sub(a[a.length - 1], b[0]));
  const bb = rev ? [...b].reverse() : b;
  const pts: Vec2[] = [];
  let width = 0;
  for (let k = 0; k <= n; k++) {
    const p = at(a, k / n);
    const q = at(bb, k / n);
    pts.push(mul(add(p, q), 0.5));
    width = Math.max(width, len(sub(p, q)));
  }
  return { pts, width };
}

const flatLen = (sp: SubPath) => polyLen(flattenSubPath(sp, 0.5));
function polyLen(pts: Vec2[]) {
  let l = 0;
  for (let i = 1; i < pts.length; i++) l += len(sub(pts[i], pts[i - 1]));
  return l;
}
function pointAt(pts: Vec2[], t: number): Vec2 {
  const total = polyLen(pts);
  let target = t * total;
  for (let i = 1; i < pts.length; i++) {
    const l = len(sub(pts[i], pts[i - 1]));
    if (target <= l || i === pts.length - 1) return add(pts[i - 1], mul(sub(pts[i], pts[i - 1]), l < 1e-12 ? 0 : Math.min(1, target / l)));
    target -= l;
  }
  return pts[pts.length - 1];
}

/**
 * Guides at the column's corners: where the centre line turns by more than
 * `minTurnDeg`, a guide along the bisector (the mitre). The stitches then
 * fan evenly round the corner instead of bunching on its inside.
 */
export function autoGuides(o: DesignObject, minTurnDeg = 30): Guide[] {
  if (!isSatin(o)) return [];
  const c = centreOf(o);
  if (!c || c.pts.length < 3) return [];
  // look a little way along so curve flattening does not count as corners
  const reach = Math.max(0.8, c.width * 0.6);
  const pts = c.pts;
  const out: Guide[] = [];
  let last = -Infinity;
  let s = 0;
  const arc = [0];
  for (let i = 1; i < pts.length; i++) arc.push((s += len(sub(pts[i], pts[i - 1]))));
  for (let i = 1; i < pts.length - 1; i++) {
    let a = i - 1;
    while (a > 0 && arc[i] - arc[a] < reach) a--;
    let b = i + 1;
    while (b < pts.length - 1 && arc[b] - arc[i] < reach) b++;
    const u = norm(sub(pts[i], pts[a]));
    const v = norm(sub(pts[b], pts[i]));
    const turn = (Math.acos(Math.max(-1, Math.min(1, u[0] * v[0] + u[1] * v[1]))) * 180) / Math.PI;
    if (turn < minTurnDeg || arc[i] - last < c.width * 1.5) continue;
    // the mitre: across both directions' normals
    const nrm = norm(add([-u[1], u[0]], [-v[1], v[0]]));
    const half = (c.width / 2) / Math.max(0.35, Math.cos((turn * Math.PI) / 360));
    out.push([sub(pts[i], mul(nrm, half)), add(pts[i], mul(nrm, half))]);
    last = arc[i];
  }
  return out;
}

/** A new guide across the satin at a point: perpendicular to the column there. */
export function guideAcross(o: DesignObject, p: Vec2): Guide | null {
  if (!isSatin(o)) return null;
  const c = centreOf(o);
  if (!c) return null;
  let best = 0;
  for (let i = 1; i < c.pts.length; i++) if (len(sub(c.pts[i], p)) < len(sub(c.pts[best], p))) best = i;
  const a = c.pts[Math.max(0, best - 1)];
  const b = c.pts[Math.min(c.pts.length - 1, best + 1)];
  const t = norm(sub(b, a));
  const nrm: Vec2 = [-t[1], t[0]];
  const h = c.width / 2 + 0.6;
  return [sub(c.pts[best], mul(nrm, h)), add(c.pts[best], mul(nrm, h))];
}
