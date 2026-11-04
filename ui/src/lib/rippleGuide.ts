// Ripple guides (Ink/Stitch guide lines and satin guides for ripple
// stitch): making a guide from another object, a default straight guide,
// and what a guide is. Shared by the Properties panel and the canvas.

import type { DesignObject, StitchDocument, SubPath, Vec2 } from "../types";
import { flatten } from "./geometry";

export type RippleObject = DesignObject & { stitch: Extract<DesignObject["stitch"], { type: "running" }> & { ripple: NonNullable<Extract<DesignObject["stitch"], { type: "running" }>["ripple"]> } };

export const isRipple = (o: DesignObject | undefined): o is RippleObject => !!o && o.stitch.type === "running" && !!o.stitch.ripple;

/** Paths that can guide a ripple: open lines (one: a guide line; two or more: satin rails and rungs). */
export function guidePaths(o: DesignObject): SubPath[] | null {
  const open = o.paths.filter((p) => !p.closed && p.nodes.length >= 2);
  if (!open.length) return null;
  // a satin column guides with its rails; any other line with its first path
  if (o.stitch.type === "satin" && open.length >= 2) return open;
  return [open[0]];
}

/** Of two selected objects, the ripple and the object that can guide it. */
export function guidePair(objects: DesignObject[]): { ripple: RippleObject; guide: DesignObject } | null {
  if (objects.length !== 2) return null;
  const [a, b] = objects;
  if (isRipple(a) && !isRipple(b) && guidePaths(b)) return { ripple: a, guide: b };
  if (isRipple(b) && !isRipple(a) && guidePaths(a)) return { ripple: b, guide: a };
  return null;
}

/** The document with `guideId`'s lines as the guide of ripple `rippleId` (the guide object removed). */
export function useAsRippleGuide(doc: StitchDocument, rippleId: string, guideId: string): StitchDocument {
  const g = doc.objects.find((o) => o.id === guideId);
  const paths = g && guidePaths(g);
  if (!paths) return doc;
  return {
    ...doc,
    objects: doc.objects
      .filter((o) => o.id !== guideId)
      .map((o) =>
        o.id === rippleId && isRipple(o)
          ? {
              ...o,
              stitch: {
                ...o.stitch,
                // Ink/Stitch's guided ripples scale down to nothing by default; keep the size here
                ripple: { ...o.stitch.ripple, guide: paths.map((p) => ({ ...p, nodes: p.nodes.map((n) => ({ ...n })) })), anchor: undefined },
              },
            }
          : o,
      ),
  };
}

const node = (p: Vec2): SubPath["nodes"][number] => ({ p });

/** A straight guide for a ripple: across an open line from its middle, or from a closed shape's centre to its edge. */
export function defaultRippleGuide(o: DesignObject): SubPath | null {
  const pts = o.paths[0] ? flatten(o.paths[0], 16) : [];
  if (pts.length < 2) return null;
  const a = pts[0];
  const b = pts[pts.length - 1];
  const r = isRipple(o) ? o.stitch.ripple : undefined;
  const mid: Vec2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  let n: Vec2 = [-(b[1] - a[1]), b[0] - a[0]];
  const l = Math.hypot(n[0], n[1]) || 1;
  n = [n[0] / l, n[1] / l];
  const len = Math.max(5, (r?.spacing ?? 2) * Math.max(1, (r?.lines ?? 10) - 1));
  const end: Vec2 = [mid[0] + n[0] * len, mid[1] + n[1] * len];
  return { closed: false, nodes: [node(mid), node(end)] };
}
