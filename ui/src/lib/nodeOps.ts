// Node tool operations on selected path points: delete (keeping the curve's
// shape), corner / smooth, straight / curved segments, break, join, open /
// close, align, and moving several points at once. Pure functions on the
// document; the canvas and the node tool bar call them.

import type { DesignObject, NodeRef, PathNode, StitchDocument, SubPath, Vec2 } from "../types";
import { cubicAt, segmentOf, vdist } from "./bezier";

const sub = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]];
const add = (a: Vec2, b: Vec2): Vec2 => [a[0] + b[0], a[1] + b[1]];
const mul = (a: Vec2, k: number): Vec2 => [a[0] * k, a[1] * k];
const dot = (a: Vec2, b: Vec2) => a[0] * b[0] + a[1] * b[1];
const norm = (a: Vec2): Vec2 => {
  const l = Math.hypot(a[0], a[1]);
  return l < 1e-12 ? [0, 0] : [a[0] / l, a[1] / l];
};
const clone = (n: PathNode): PathNode => ({ p: n.p, ...(n.i ? { i: n.i } : {}), ...(n.o ? { o: n.o } : {}) });

export const nodeKey = (n: NodeRef) => `${n.id}/${n.sp}/${n.ni}`;

/** Selected node indices per object and sub-path. */
function grouped(sel: NodeRef[]): Map<string, Map<number, number[]>> {
  const m = new Map<string, Map<number, number[]>>();
  for (const n of sel) {
    if (!m.has(n.id)) m.set(n.id, new Map());
    const g = m.get(n.id)!;
    if (!g.has(n.sp)) g.set(n.sp, []);
    g.get(n.sp)!.push(n.ni);
  }
  for (const g of m.values()) for (const [k, v] of g) g.set(k, [...new Set(v)].sort((a, b) => a - b));
  return m;
}

/** Two-rail satins pair their nodes as rungs: point edits there would break the pairs. */
export const isRailSatin = (o: DesignObject) => o.stitch.type === "satin" && !o.stitch.multi && o.paths.length === 2;

function mapObjects(doc: StitchDocument, sel: NodeRef[], fn: (o: DesignObject, per: Map<number, number[]>) => DesignObject | null): StitchDocument {
  const g = grouped(sel);
  return {
    ...doc,
    objects: doc.objects.flatMap((o) => {
      const per = g.get(o.id);
      if (!per) return [o];
      const r = fn(o, per);
      return r ? [r] : [];
    }),
  };
}

// ---------------------------------------------------------------------------
// delete

/** Least-squares cubic through `pts` with fixed end points and end tangents (Schneider). */
function fitCubic(pts: Vec2[], t0: Vec2, t1: Vec2): [Vec2, Vec2] {
  const p0 = pts[0];
  const p3 = pts[pts.length - 1];
  const chord = vdist(p0, p3);
  // chord-length parameters
  const u = [0];
  for (let i = 1; i < pts.length; i++) u.push(u[i - 1] + vdist(pts[i], pts[i - 1]));
  const total = u[u.length - 1] || 1;
  let c00 = 0, c01 = 0, c11 = 0, x0 = 0, x1 = 0;
  for (let i = 0; i < pts.length; i++) {
    const t = u[i] / total;
    const s = 1 - t;
    const b0 = s * s * s, b1 = 3 * t * s * s, b2 = 3 * t * t * s, b3 = t * t * t;
    const a1 = mul(t0, b1);
    const a2 = mul(t1, b2);
    c00 += dot(a1, a1);
    c01 += dot(a1, a2);
    c11 += dot(a2, a2);
    const tmp = sub(pts[i], add(mul(p0, b0 + b1), mul(p3, b2 + b3)));
    x0 += dot(a1, tmp);
    x1 += dot(a2, tmp);
  }
  const det = c00 * c11 - c01 * c01;
  let al = det !== 0 ? (x0 * c11 - x1 * c01) / det : 0;
  let ar = det !== 0 ? (c00 * x1 - c01 * x0) / det : 0;
  // degenerate fits: the classic one-third heuristic
  if (!(al > chord * 1e-3) || !(ar > chord * 1e-3) || al > chord * 3 || ar > chord * 3) al = ar = chord / 3;
  return [add(p0, mul(t0, al)), add(p3, mul(t1, ar))];
}

/** Direction leaving a segment's start (into the curve). */
function startTangent(c: [Vec2, Vec2, Vec2, Vec2]): Vec2 {
  return norm(sub(cubicAt(c, 1e-3), c[0]));
}
function endTangent(c: [Vec2, Vec2, Vec2, Vec2]): Vec2 {
  return norm(sub(cubicAt(c, 1 - 1e-3), c[3]));
}

/**
 * Remove nodes `idx` (sorted) from a sub-path. With `keepShape`, each run of
 * removed nodes is replaced by one curve fitted to the old shape between its
 * neighbours (a shape-preserving delete); otherwise the neighbours keep their
 * handles.
 */
export function removeNodes(sp: SubPath, idx: number[], keepShape: boolean): SubPath | null {
  const n = sp.nodes.length;
  const del = new Set(idx);
  const left = n - del.size;
  if (left < 2) return null;
  const nodes = sp.nodes.map(clone);
  if (keepShape) {
    // runs of consecutive removed nodes between two kept ones (cyclic when closed)
    const runs: { prev: number; next: number }[] = [];
    let run = 0;
    if (sp.closed) {
      const s0 = sp.nodes.findIndex((_, k) => !del.has(k));
      let prev = s0;
      for (let step = 1; step <= n; step++) {
        const k = (s0 + step) % n;
        if (del.has(k)) run++;
        else {
          if (run) runs.push({ prev, next: k });
          run = 0;
          prev = k;
        }
      }
    } else {
      let prev = -1;
      for (let k = 0; k < n; k++) {
        if (del.has(k)) run++;
        else {
          if (run && prev >= 0) runs.push({ prev, next: k });
          run = 0;
          prev = k;
        }
      }
    }
    for (const { prev, next } of runs) {
      // the old shape from prev to next
      const segs: [Vec2, Vec2, Vec2, Vec2][] = [];
      for (let k = prev; k !== next; k = (k + 1) % n) segs.push(segmentOf(sp, k));
      const straight = segs.every((c) => vdist(c[0], c[1]) < 1e-9 && vdist(c[2], c[3]) < 1e-9);
      if (straight) {
        delete nodes[prev].o;
        delete nodes[next].i;
        continue;
      }
      const pts: Vec2[] = [];
      for (const c of segs) for (let k = pts.length ? 1 : 0; k <= 16; k++) pts.push(cubicAt(c, k / 16));
      const t0 = startTangent(segs[0]);
      const t1 = endTangent(segs[segs.length - 1]);
      const [c1, c2] = fitCubic(pts, t0, t1);
      nodes[prev].o = c1;
      nodes[next].i = c2;
    }
  }
  const out = nodes.filter((_, k) => !del.has(k));
  return { ...sp, nodes: out, closed: sp.closed && out.length >= 3 };
}

export function deleteSelectedNodes(doc: StitchDocument, sel: NodeRef[], keepShape: boolean): { doc: StitchDocument; removedObjects: number } {
  let removedObjects = 0;
  const next = mapObjects(doc, sel, (o, per) => {
    if (isRailSatin(o)) {
      // keep the rung pairs: delete the same rung on both rails
      const [a, b] = o.paths;
      const n = a.nodes.length;
      if (n !== b.nodes.length) return o;
      const rev = vdist(a.nodes[0].p, b.nodes[0].p) > vdist(a.nodes[0].p, b.nodes[n - 1].p);
      const rungs = new Set<number>();
      for (const [si, list] of per) for (const ni of list) rungs.add(si === 0 || !rev ? ni : n - 1 - ni);
      const ra = removeNodes(a, [...rungs].sort((x, y) => x - y), keepShape);
      const rb = removeNodes(b, [...rungs].map((k) => (rev ? n - 1 - k : k)).sort((x, y) => x - y), keepShape);
      if (!ra || !rb) return o;
      return { ...o, paths: [ra, rb] };
    }
    const paths: SubPath[] = [];
    o.paths.forEach((sp, si) => {
      const list = per.get(si);
      if (!list) return paths.push(sp);
      const r = removeNodes(sp, list, keepShape);
      if (r) paths.push(r);
    });
    if (!paths.length) {
      removedObjects++;
      return null;
    }
    return { ...o, paths };
  });
  return { doc: next, removedObjects };
}

// ---------------------------------------------------------------------------
// node and segment types

function neighbours(sp: SubPath, i: number): [Vec2 | null, Vec2 | null] {
  const m = sp.nodes.length;
  const prev = i > 0 ? sp.nodes[i - 1].p : sp.closed ? sp.nodes[m - 1].p : null;
  const next = i < m - 1 ? sp.nodes[i + 1].p : sp.closed ? sp.nodes[0].p : null;
  return [prev, next];
}

/** Corner: no handles. Smooth: collinear handles along the neighbours (Catmull-Rom). */
export function setNodeType(doc: StitchDocument, sel: NodeRef[], type: "corner" | "smooth" | "symmetric"): StitchDocument {
  return mapObjects(doc, sel, (o, per) => ({
    ...o,
    paths: o.paths.map((sp, si) => {
      const list = per.get(si);
      if (!list) return sp;
      const nodes = sp.nodes.map(clone);
      for (const i of list) {
        const n = nodes[i];
        if (type === "corner") {
          delete n.i;
          delete n.o;
          continue;
        }
        const [prev, next] = neighbours(sp, i);
        // keep the current direction of an existing handle, else the neighbours'
        const cur = n.o && n.i ? norm(sub(n.o, n.i)) : n.o ? norm(sub(n.o, n.p)) : n.i ? norm(sub(n.p, n.i)) : null;
        const dir = cur && (cur[0] || cur[1]) ? cur : norm(sub(next ?? n.p, prev ?? n.p));
        if (!dir[0] && !dir[1]) continue;
        let li = prev ? vdist(prev, n.p) / 3 : 0;
        let lo = next ? vdist(next, n.p) / 3 : 0;
        if (type === "symmetric") li = lo = (li && lo ? (li + lo) / 2 : li || lo);
        if (prev) n.i = sub(n.p, mul(dir, li));
        if (next) n.o = add(n.p, mul(dir, lo));
      }
      return { ...sp, nodes };
    }),
  }));
}

/** Segments between selected nodes (or both segments of a lone selected node). */
function selectedSegments(sp: SubPath, list: number[]): number[] {
  const m = sp.nodes.length;
  const set = new Set(list);
  const segs = new Set<number>();
  const count = sp.closed ? m : m - 1;
  for (let s = 0; s < count; s++) if (set.has(s) && set.has((s + 1) % m)) segs.add(s);
  if (!segs.size)
    for (const i of list) {
      if (i < count) segs.add(i);
      const before = sp.closed ? (i - 1 + m) % m : i - 1;
      if (before >= 0) segs.add(before);
    }
  return [...segs];
}

/** Straight (handles removed on that segment) or curved (handles at a third). */
export function setSegmentType(doc: StitchDocument, sel: NodeRef[], type: "line" | "curve"): StitchDocument {
  return mapObjects(doc, sel, (o, per) => ({
    ...o,
    paths: o.paths.map((sp, si) => {
      const list = per.get(si);
      if (!list) return sp;
      const nodes = sp.nodes.map(clone);
      const m = nodes.length;
      for (const s of selectedSegments(sp, list)) {
        const a = nodes[s];
        const b = nodes[(s + 1) % m];
        if (type === "line") {
          delete a.o;
          delete b.i;
        } else if (!a.o && !b.i) {
          a.o = add(a.p, mul(sub(b.p, a.p), 1 / 3));
          b.i = add(a.p, mul(sub(b.p, a.p), 2 / 3));
        }
      }
      return { ...sp, nodes };
    }),
  }));
}

// ---------------------------------------------------------------------------
// break, join, open / close

/** Break at the selected nodes: a closed path opens there, an open one splits in two. */
export function breakAtNodes(doc: StitchDocument, sel: NodeRef[]): StitchDocument {
  return mapObjects(doc, sel, (o, per) => {
    if (isRailSatin(o)) return o;
    const paths: SubPath[] = [];
    o.paths.forEach((sp, si) => {
      const list = per.get(si);
      if (!list) return paths.push(sp);
      let cur = sp;
      let idx = [...list];
      if (cur.closed) {
        // open at the first selected point: the path starts and ends there
        const i = idx[0];
        const m = cur.nodes.length;
        const ring = [...cur.nodes.slice(i), ...cur.nodes.slice(0, i)].map(clone);
        const end = clone(ring[0]);
        delete ring[0].i;
        delete end.o;
        cur = { ...cur, nodes: [...ring, end], closed: false };
        idx = idx.slice(1).map((k) => (k - i + m) % m);
      }
      // split the open path at the others (from the end, so indices stay valid)
      let parts: SubPath[] = [cur];
      for (const i of idx.sort((a, b) => b - a)) {
        const head = parts[0];
        if (i <= 0 || i >= head.nodes.length - 1) continue;
        const a = head.nodes.slice(0, i + 1).map(clone);
        const b = head.nodes.slice(i).map(clone);
        delete a[a.length - 1].o;
        delete b[0].i;
        parts = [{ ...head, nodes: a, closed: false }, { ...head, nodes: b, closed: false }, ...parts.slice(1)];
      }
      paths.push(...parts);
    });
    return { ...o, paths };
  });
}

const isEnd = (sp: SubPath, i: number) => !sp.closed && (i === 0 || i === sp.nodes.length - 1);

/**
 * Join two selected end points: the ends of one path close it; ends of two
 * paths (also of two objects) become one path. Points closer than 0.05 mm
 * merge, others are joined by a straight segment.
 */
export function joinNodes(doc: StitchDocument, sel: NodeRef[]): { doc: StitchDocument; error?: string } {
  if (sel.length !== 2) return { doc, error: "Select two end points to join" };
  const [a, b] = sel;
  const oa = doc.objects.find((o) => o.id === a.id);
  const ob = doc.objects.find((o) => o.id === b.id);
  if (!oa || !ob) return { doc };
  if (isRailSatin(oa) || isRailSatin(ob)) return { doc, error: "Satin rails are joined in pairs — use the satin tool" };
  const spa = oa.paths[a.sp];
  const spb = ob.paths[b.sp];
  if (!spa || !spb || !isEnd(spa, a.ni) || !isEnd(spb, b.ni)) return { doc, error: "Only end points of open paths can be joined" };
  const merge = (x: PathNode, y: PathNode): PathNode => ({ p: x.p, ...(x.i ? { i: x.i } : {}), ...(y.o ? { o: y.o } : {}) });
  if (oa.id === ob.id && a.sp === b.sp) {
    // close this path
    const nodes = spa.nodes.map(clone);
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    if (vdist(first.p, last.p) < 0.05 && nodes.length > 2) {
      nodes[0] = merge(last, first);
      nodes.pop();
    }
    const paths = oa.paths.map((sp, k) => (k === a.sp ? { ...sp, nodes, closed: true } : sp));
    return { doc: { ...doc, objects: doc.objects.map((o) => (o.id === oa.id ? { ...oa, paths } : o)) } };
  }
  // orient: path A ends at the joint, path B starts there
  const rev = (sp: SubPath): PathNode[] => [...sp.nodes].reverse().map((n) => ({ p: n.p, ...(n.o ? { i: n.o } : {}), ...(n.i ? { o: n.i } : {}) }));
  const na = a.ni === 0 ? rev(spa) : spa.nodes.map(clone);
  const nb = b.ni === 0 ? spb.nodes.map(clone) : rev(spb);
  let nodes: PathNode[];
  if (vdist(na[na.length - 1].p, nb[0].p) < 0.05) nodes = [...na.slice(0, -1), merge(na[na.length - 1], nb[0]), ...nb.slice(1)];
  else nodes = [...na, ...nb];
  const joined: SubPath = { nodes, closed: false };
  if (oa.id === ob.id) {
    const paths = oa.paths.filter((_, k) => k !== a.sp && k !== b.sp);
    paths.splice(Math.min(a.sp, b.sp), 0, joined);
    return { doc: { ...doc, objects: doc.objects.map((o) => (o.id === oa.id ? { ...oa, paths } : o)) } };
  }
  // two objects: the second one's path moves into the first
  const paths = oa.paths.map((sp, k) => (k === a.sp ? joined : sp));
  const rest = ob.paths.filter((_, k) => k !== b.sp);
  return {
    doc: {
      ...doc,
      objects: doc.objects.flatMap((o) => (o.id === oa.id ? [{ ...oa, paths }] : o.id === ob.id ? (rest.length ? [{ ...ob, paths: rest }] : []) : [o])),
    },
  };
}

/** Close the open paths of the selected nodes, or open the closed ones (at their first selected node). */
export function toggleClosed(doc: StitchDocument, sel: NodeRef[]): StitchDocument {
  const g = grouped(sel);
  const anyOpen = doc.objects.some((o) => {
    const per = g.get(o.id);
    return per && [...per.keys()].some((si) => o.paths[si] && !o.paths[si].closed);
  });
  if (!anyOpen) return breakAtNodes(doc, [...g].flatMap(([id, per]) => [...per].map(([sp, list]) => ({ id, sp, ni: list[0] }))));
  // a satin's two rails close together (or not at all)
  return mapObjects(doc, sel, (o, per) =>
    isRailSatin(o)
      ? o.paths.every((sp) => sp.nodes.length >= 3)
        ? { ...o, paths: o.paths.map((sp) => ({ ...sp, closed: true })) }
        : o
      : { ...o, paths: o.paths.map((sp, si) => (per.has(si) && sp.nodes.length >= 3 ? { ...sp, closed: true } : sp)) },
  );
}

// ---------------------------------------------------------------------------
// move, align

/** Move the selected nodes (with their handles) by d, from the original document. */
export function moveNodes(doc: StitchDocument, sel: NodeRef[], d: Vec2): StitchDocument {
  return mapObjects(doc, sel, (o, per) => ({
    ...o,
    paths: o.paths.map((sp, si) => {
      const list = per.get(si);
      if (!list) return sp;
      const set = new Set(list);
      return {
        ...sp,
        nodes: sp.nodes.map((n, k) =>
          set.has(k) ? { p: add(n.p, d), ...(n.i ? { i: add(n.i, d) } : {}), ...(n.o ? { o: add(n.o, d) } : {}) } : n,
        ),
      };
    }),
  }));
}

/** Line the selected nodes up on their average x ("v": one vertical line) or y. */
export function alignNodes(doc: StitchDocument, sel: NodeRef[], axis: "h" | "v"): StitchDocument {
  const pts = sel.map((n) => doc.objects.find((o) => o.id === n.id)?.paths[n.sp]?.nodes[n.ni]?.p).filter(Boolean) as Vec2[];
  if (pts.length < 2) return doc;
  const k = axis === "v" ? 0 : 1;
  const avg = pts.reduce((s, p) => s + p[k], 0) / pts.length;
  return mapObjects(doc, sel, (o, per) => ({
    ...o,
    paths: o.paths.map((sp, si) => {
      const list = per.get(si);
      if (!list) return sp;
      const set = new Set(list);
      return {
        ...sp,
        nodes: sp.nodes.map((n, ni) => {
          if (!set.has(ni)) return n;
          const d: Vec2 = k === 0 ? [avg - n.p[0], 0] : [0, avg - n.p[1]];
          return { p: add(n.p, d), ...(n.i ? { i: add(n.i, d) } : {}), ...(n.o ? { o: add(n.o, d) } : {}) };
        }),
      };
    }),
  }));
}

/** Move the selected nodes onto their average point (both axes). */
export const averageNodes = (doc: StitchDocument, sel: NodeRef[]): StitchDocument => alignNodes(alignNodes(doc, sel, "v"), sel, "h");

/**
 * Bend segment `seg` of a path so that its point at `t` moves by `d`: both of
 * its handles move (a straight segment gets handles first), the nearer one
 * more. A smooth point at either end turns its other handle with it, keeping
 * its length.
 */
export function bendSegment(sp: SubPath, seg: number, t: number, d: Vec2): SubPath {
  const n = sp.nodes.length;
  const ia = seg;
  const ib = (seg + 1) % n;
  const A = sp.nodes[ia];
  const B = sp.nodes[ib];
  const third = (k: number): Vec2 => add(A.p, mul(sub(B.p, A.p), k));
  const p1 = A.o ?? third(1 / 3);
  const p2 = B.i ?? third(2 / 3);
  const u = Math.min(0.95, Math.max(0.05, t));
  const w1 = 1 - u;
  const w2 = u;
  // B(u) moves by 3(1-u)²u·w1·k·d + 3(1-u)u²·w2·k·d = d
  const k = 1 / (3 * (1 - u) * u * ((1 - u) * w1 + u * w2));
  const o = add(p1, mul(d, w1 * k));
  const i = add(p2, mul(d, w2 * k));
  const turn = (node: PathNode, moved: Vec2, other: Vec2 | undefined): Vec2 | undefined => {
    if (!other || !handlesCollinear(node)) return other;
    const dir = norm(sub(node.p, moved));
    return add(node.p, mul(dir, Math.hypot(other[0] - node.p[0], other[1] - node.p[1])));
  };
  const nodes = sp.nodes.map(clone);
  nodes[ia] = { p: A.p, o, ...(A.i ? { i: turn(A, o, A.i) } : {}) };
  nodes[ib] = { p: B.p, i, ...(B.o ? { o: turn(B, i, B.o) } : {}) };
  if (ia === ib) return sp;
  return { ...sp, nodes };
}

/** Every node of the given objects. */
export function allNodes(doc: StitchDocument, ids: string[]): NodeRef[] {
  return doc.objects.filter((o) => ids.includes(o.id) && !o.text && !o.locked).flatMap((o) => o.paths.flatMap((sp, si) => sp.nodes.map((_, ni) => ({ id: o.id, sp: si, ni }))));
}

/** Nodes of the given objects inside a box. */
export function nodesInBox(doc: StitchDocument, ids: string[], b: { x: number; y: number; w: number; h: number }): NodeRef[] {
  return allNodes(doc, ids).filter((n) => {
    const p = doc.objects.find((o) => o.id === n.id)!.paths[n.sp].nodes[n.ni].p;
    return p[0] >= b.x && p[0] <= b.x + b.w && p[1] >= b.y && p[1] <= b.y + b.h;
  });
}

/** Handles whose directions agree (within ~3°): dragging one turns the other with it. */
export function handlesCollinear(n: PathNode): boolean {
  if (!n.i || !n.o) return false;
  const a = norm(sub(n.p, n.i));
  const b = norm(sub(n.o, n.p));
  return dot(a, b) > 0.9985;
}
