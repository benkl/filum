// Hit testing on the canvas: which object is under the pointer, which points a box
// picks, whether a line crosses an object; the box a transform works on.

import { objectBoundsCached, objectOutline, objectPath, unionBoxes } from "../lib/geometry";
import type { DesignObject, NodeRef, StitchDocument, Vec2 } from "../types";
import { nodeKey, nodesInBox } from "../lib/nodeOps";
import { flatten as flattenSub } from "../lib/geometry";
import { transformable } from "../lib/textSettle";

/**
 * The box a transform drag works on: round the selected objects it moves
 * (locked objects, and letterings with a locked letter, stay put). The handles
 * are drawn, hit-tested and given cursors on this one box.
 */
export function transformBox(doc: StitchDocument, selection: string[]) {
  const sel = transformable(doc.objects.filter((o) => selection.includes(o.id)), doc.objects).objects;
  return sel.length ? unionBoxes(sel.map(objectBoundsCached)) : null;
}

/**
 * The points a node-tool box picks on the selected paths: those inside it,
 * added to (Shift) or taken from (Alt) the points selected when the drag began.
 */
export function boxedNodes(doc: StitchDocument, ids: string[], m: { x: number; y: number; w: number; h: number }, d: { add: boolean; sub: boolean; base: NodeRef[] }): NodeRef[] {
  const found = nodesInBox(doc, ids, m);
  if (d.sub) {
    const out = new Set(found.map(nodeKey));
    return d.base.filter((x) => !out.has(nodeKey(x)));
  }
  if (d.add) {
    const have = new Set(d.base.map(nodeKey));
    return [...d.base, ...found.filter((x) => !have.has(nodeKey(x)))];
  }
  return found;
}

export const hitCtx = (() => {
  const c = document.createElement("canvas");
  c.width = c.height = 1;
  return c.getContext("2d")!;
})();

export function hitObject(o: DesignObject, p: Vec2, tol: number): boolean {
  const st = o.stitch;
  if (st.type === "satin") {
    const path = objectOutline(o);
    if (path && hitCtx.isPointInPath(path, p[0], p[1], "evenodd")) return true;
    hitCtx.lineWidth = tol * 2;
    return !!path && hitCtx.isPointInStroke(path, p[0], p[1]);
  }
  const path = objectPath(o);
  if ((st.type === "fill" || st.type === "none" || st.type === "applique") && hitCtx.isPointInPath(path, p[0], p[1], "evenodd")) return true;
  hitCtx.lineWidth = Math.max(tol * 2, 0.6);
  return hitCtx.isPointInStroke(path, p[0], p[1]);
}

export const isPathObject = (o: DesignObject) =>
  o.stitch.type === "running" || o.stitch.type === "manual" || (o.stitch.type === "satin" && o.paths.length === 1);

export function segmentsCross(a: Vec2, b: Vec2, c: Vec2, d: Vec2) {
  const o = (p: Vec2, q: Vec2, r: Vec2) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  return o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0;
}

/** Does the segment a→b cross the object's outline? */
export function crossesObject(o: DesignObject, a: Vec2, b: Vec2) {
  return o.paths.some((sp) => {
    const pts = flattenSub(sp);
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const q = pts[(i + 1) % pts.length];
      if (segmentsCross(a, b, p, q)) return true;
    }
    return false;
  });
}

export function nextName(objs: DesignObject[], base: string) {
  let n = 1;
  while (objs.some((o) => o.name === `${base} ${n}`)) n++;
  return `${base} ${n}`;
}
