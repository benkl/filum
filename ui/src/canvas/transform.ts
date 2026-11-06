// Direct transforms on the canvas: smart guides with
// snapping, skew, rotation zones outside the corners and a movable pivot.

import { objectBoundsCached, type Box } from "../lib/geometry";
import type { DesignObject, StitchDocument, Vec2 } from "../types";
import { unitOf } from "../lib/groups";

type Mat = [number, number, number, number, number, number];

/** Shear about (cx, cy): x' = x + kx·(y − cy), y' = y + ky·(x − cx). */
export function skewAbout(kx: number, ky: number, cx: number, cy: number): Mat {
  return [1, ky, kx, 1, -kx * cy, -ky * cx];
}

/** A line objects can snap to: a coordinate and the span it was found on (for drawing). */
interface Target {
  v: number;
  a: number;
  b: number;
}
export interface SnapTargets {
  xs: Target[];
  ys: Target[];
}
export interface Guide {
  axis: "x" | "y";
  v: number;
  a: number;
  b: number;
}

/** Edges and centres of the other objects and the hoop. */
export function snapTargets(doc: StitchDocument, exclude: Set<string>): SnapTargets {
  const xs: Target[] = [];
  const ys: Target[] = [];
  const add = (b: Box) => {
    for (const v of [b.x, b.x + b.w / 2, b.x + b.w]) xs.push({ v, a: b.y, b: b.y + b.h });
    for (const v of [b.y, b.y + b.h / 2, b.y + b.h]) ys.push({ v, a: b.x, b: b.x + b.w });
  };
  let n = 0;
  for (const o of doc.objects) {
    if (exclude.has(o.id) || !o.visible) continue;
    const b = objectBoundsCached(o);
    if (b && n++ < 600) add(b);
  }
  add({ x: 0, y: 0, w: doc.hoop.width, h: doc.hoop.height });
  return { xs, ys };
}

/**
 * Snap a moving box: the closest of its left / centre / right (top / middle
 * / bottom) to a target within `tol`. Returns the correction and guides.
 */
export function snapBox(b: Box, t: SnapTargets, tol: number, which: { x?: number[]; y?: number[] } = {}): { dx: number; dy: number; guides: Guide[] } {
  const xs = which.x ?? [b.x, b.x + b.w / 2, b.x + b.w];
  const ys = which.y ?? [b.y, b.y + b.h / 2, b.y + b.h];
  let best: { d: number; t: Target } | null = null;
  let bestY: { d: number; t: Target } | null = null;
  for (const x of xs)
    for (const c of t.xs) {
      const d = c.v - x;
      if (Math.abs(d) <= tol && (!best || Math.abs(d) < Math.abs(best.d))) best = { d, t: c };
    }
  for (const y of ys)
    for (const c of t.ys) {
      const d = c.v - y;
      if (Math.abs(d) <= tol && (!bestY || Math.abs(d) < Math.abs(bestY.d))) bestY = { d, t: c };
    }
  const dx = best?.d ?? 0;
  const dy = bestY?.d ?? 0;
  const guides: Guide[] = [];
  if (best) {
    // every target on the snapped line, spanning the moving box too
    const v = best.t.v;
    const span = t.xs.filter((c) => Math.abs(c.v - v) < 1e-6);
    const a = Math.min(b.y + dy, ...span.map((c) => c.a));
    const z = Math.max(b.y + b.h + dy, ...span.map((c) => c.b));
    guides.push({ axis: "x", v, a, b: z });
  }
  if (bestY) {
    const v = bestY.t.v;
    const span = t.ys.filter((c) => Math.abs(c.v - v) < 1e-6);
    const a = Math.min(b.x + dx, ...span.map((c) => c.a));
    const z = Math.max(b.x + b.w + dx, ...span.map((c) => c.b));
    guides.push({ axis: "y", v, a, b: z });
  }
  return { dx, dy, guides };
}

/** Corner whose rotation zone (just outside the box) contains `p`, or -1. */
export function rotateZone(b: Box, p: Vec2, scale: number): number {
  const corners: Vec2[] = [
    [b.x, b.y],
    [b.x + b.w, b.y],
    [b.x + b.w, b.y + b.h],
    [b.x, b.y + b.h],
  ];
  const inside = p[0] > b.x && p[0] < b.x + b.w && p[1] > b.y && p[1] < b.y + b.h;
  if (inside) return -1;
  for (let i = 0; i < 4; i++) {
    const d = Math.hypot(p[0] - corners[i][0], p[1] - corners[i][1]) * scale;
    if (d > 7 && d < 24) return i;
  }
  return -1;
}

const svgCursor = (svg: string, x: number, y: number, fallback: string) =>
  `url("data:image/svg+xml;utf8,${encodeURIComponent(svg)}") ${x} ${y}, ${fallback}`;

export const ROTATE_CURSOR = svgCursor(
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path d="M5 12a7 7 0 1 1 3 5.7" fill="none" stroke="white" stroke-width="4" stroke-linecap="round"/><path d="M5 12a7 7 0 1 1 3 5.7" fill="none" stroke="black" stroke-width="1.8" stroke-linecap="round"/><path d="M2 15l3-4 4 3z" fill="black" stroke="white" stroke-width="1"/></svg>',
  12,
  12,
  "crosshair",
);

export const SKEW_CURSOR = svgCursor(
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path d="M3 9h14l4-4M21 15H7l-4 4" fill="none" stroke="white" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M3 9h14l4-4M21 15H7l-4 4" fill="none" stroke="black" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  12,
  12,
  "ew-resize",
);

/** Group-aware selection unit of an object (group, lettering or itself). */
export function unitIds(doc: StitchDocument, o: DesignObject): string[] {
  // the outermost group (groups nest), a lettering, or the object
  return unitOf(doc, o);
}
