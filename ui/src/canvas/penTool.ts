// The Bézier pen, shared by the Pen (running stitch) and the
// Satin tool. The draft keeps full Bézier nodes; every node and handle stays
// editable while drawing:
//
//   click                 corner point          drag      smooth point (symmetric handles)
//   Alt while dragging    break the handles     Space     move the point while dragging
//   Shift                 45° (pen) / 15° (satin) steps for points and handles
//   drag the last point   pull only its out-handle (cusp)   click it: finish
//   click the first point close the path (drag: shape the closing curve)
//   hover a segment       "+" inserts a point on the curve (shape preserved)
//   drag a point/handle   reshape (Alt: break symmetry)
//   Alt-click a point     delete it             double-click a point: smooth ↔ corner
//   Enter / Esc           finish                Backspace: remove the last point

import type { PathNode, SubPath, Vec2 } from "../types";
import { constrainAngle, deleteNode, insertNode, nearestOnSubPath, toggleSmooth, vdist, type Cubic } from "../lib/bezier";

export interface PenDraft {
  kind: "run" | "satin";
  nodes: PathNode[];
  /** Satin: column width at every node (mm). */
  widths: number[];
  /** Satin: width for the next point (mm). */
  width: number;
  cursor: Vec2 | null;
  /** Object being continued (replaced when the draft is finished). */
  replaces?: string;
}

export type PenHover =
  | { kind: "none" }
  | { kind: "close" }
  | { kind: "last" }
  | { kind: "anchor"; index: number }
  | { kind: "handle"; index: number; part: "i" | "o" }
  | { kind: "segment"; seg: number; t: number; p: Vec2 };

export const newDraft = (kind: PenDraft["kind"], width = 3): PenDraft => ({ kind, nodes: [], widths: [], width, cursor: null });

export const draftPath = (d: PenDraft): SubPath => ({ nodes: d.nodes, closed: false });

/** What is under the pointer. Handles win over points, points over segments. */
export function penHitTest(d: PenDraft, p: Vec2, tol: number): PenHover {
  const n = d.nodes.length;
  // the closest point or handle wins (points get a slightly larger target)
  let best: PenHover = { kind: "none" };
  let bd = Infinity;
  const consider = (h: PenHover, at: Vec2, reach: number) => {
    const dd = vdist(at, p) / reach;
    if (dd < 1 && dd < bd) {
      bd = dd;
      best = h;
    }
  };
  for (let i = 0; i < n; i++) {
    for (const part of ["o", "i"] as const) {
      const h = d.nodes[i][part];
      if (h) consider({ kind: "handle", index: i, part }, h, tol);
    }
    const at = d.nodes[i].p;
    if (i === 0 && n >= 2) consider({ kind: "close" }, at, tol * 1.3);
    else if (i === n - 1) consider({ kind: "last" }, at, tol * 1.3);
    else consider({ kind: "anchor", index: i }, at, tol * 1.3);
  }
  if (best.kind !== "none") return best;
  if (n >= 2) {
    const hit = nearestOnSubPath(draftPath(d), p);
    if (hit && hit.d < tol && hit.t > 0.04 && hit.t < 0.96) return { kind: "segment", seg: hit.seg, t: hit.t, p: hit.p };
  }
  return { kind: "none" };
}

export const canClose = (d: PenDraft) => d.nodes.length >= 3 || (d.nodes.length === 2 && d.nodes.some((x) => x.i || x.o));

/** Constrained position of a new point (Shift). */
export function placePoint(d: PenDraft, p: Vec2, shift: boolean): Vec2 {
  const last = d.nodes[d.nodes.length - 1];
  return shift && last ? constrainAngle(last.p, p, d.kind === "satin" ? 15 : 45) : p;
}

export function addPoint(d: PenDraft, p: Vec2) {
  d.nodes.push({ p });
  if (d.kind === "satin") d.widths.push(d.width);
}

/** Drag from a node: symmetric handles (or only the out-handle). */
export function pullHandles(node: PathNode, to: Vec2, opts: { shift: boolean; onlyOut: boolean; keepIn?: Vec2 }) {
  const q = opts.shift ? constrainAngle(node.p, to, 45) : to;
  if (vdist(q, node.p) < 1e-6) {
    delete node.o;
    if (!opts.onlyOut) delete node.i;
    return;
  }
  node.o = q;
  if (opts.onlyOut) {
    if (opts.keepIn) node.i = opts.keepIn;
  } else node.i = [2 * node.p[0] - q[0], 2 * node.p[1] - q[1]];
}

/** Move one handle; the opposite one mirrors its direction unless `free`. */
export function moveHandle(orig: PathNode, part: "i" | "o", to: Vec2, free: boolean, shift: boolean): PathNode {
  const q = shift ? constrainAngle(orig.p, to, 45) : to;
  const n: PathNode = { ...orig, [part]: q };
  const other = part === "i" ? "o" : "i";
  const oh = orig[other];
  if (oh && !free) {
    const l = vdist(oh, orig.p);
    const d = vdist(q, orig.p) || 1;
    n[other] = [orig.p[0] - ((q[0] - orig.p[0]) / d) * l, orig.p[1] - ((q[1] - orig.p[1]) / d) * l];
  }
  return n;
}

/** Move a point with its handles. */
export function moveAnchor(orig: PathNode, to: Vec2): PathNode {
  const dx = to[0] - orig.p[0];
  const dy = to[1] - orig.p[1];
  const sh = (h?: Vec2): Vec2 | undefined => (h ? [h[0] + dx, h[1] + dy] : undefined);
  const n: PathNode = { p: to };
  if (orig.i) n.i = sh(orig.i);
  if (orig.o) n.o = sh(orig.o);
  return n;
}

/** Insert a point on a segment of the draft; returns its index. */
export function insertInDraft(d: PenDraft, seg: number, t: number): number {
  const r = insertNode(draftPath(d), seg, t);
  d.nodes = r.sp.nodes;
  if (d.kind === "satin") {
    const w = d.widths[seg] + (d.widths[seg + 1] - d.widths[seg]) * t;
    d.widths.splice(r.index, 0, w);
  }
  return r.index;
}

export function deleteFromDraft(d: PenDraft, i: number) {
  d.nodes = deleteNode(draftPath(d), i).nodes;
  if (d.kind === "satin") d.widths.splice(i, 1);
}

export function toggleSmoothInDraft(d: PenDraft, i: number) {
  d.nodes = toggleSmooth(draftPath(d), i).nodes;
}

export function removeLast(d: PenDraft) {
  d.nodes.pop();
  if (d.kind === "satin") d.widths.pop();
}

/** Rubber band from the last point to the cursor. */
export function rubberBand(d: PenDraft, closing: boolean): Cubic | null {
  const last = d.nodes[d.nodes.length - 1];
  if (!last || !d.cursor) return null;
  if (closing) {
    const first = d.nodes[0];
    return [last.p, last.o ?? last.p, first.i ?? first.p, first.p];
  }
  return [last.p, last.o ?? last.p, d.cursor, d.cursor];
}

/** Continue an open path from one of its ends (reversed when starting at the start). */
export function continueFrom(sp: SubPath, atStart: boolean): PathNode[] {
  const nodes = sp.nodes.map((n) => ({ ...n }));
  if (!atStart) return nodes;
  return nodes.reverse().map((n) => {
    const r: PathNode = { p: n.p };
    if (n.o) r.i = n.o;
    if (n.i) r.o = n.i;
    return r;
  });
}

export const PEN_HINTS: Record<PenHover["kind"], string> = {
  none: "Click for a corner, drag for a curve · Shift: angles · snaps to points (Ctrl: off) · Enter to finish",
  close: "Click to close the path · drag to shape the closing curve",
  last: "Click to finish · drag to pull out a new direction",
  anchor: "Drag to move · Alt-click to delete · double-click: smooth ↔ corner",
  handle: "Drag to reshape · Alt: move this handle alone",
  segment: "Click to add a point here",
};
