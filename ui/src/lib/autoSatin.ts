// Auto-route satin columns, after Ink/Stitch (lib/stitches/auto_satin.py,
// lib/stitches/utils/autoroute.py): satins are diced into 1 mm pieces and
// joined into a graph; the fewest and shortest jumps connect its parts; a
// walk from the start to the end visits every piece, going down side
// branches and back. A piece walked twice is sewn as a running stitch the
// first time (hidden under the satin sewn over it on the way back).
// Consecutive pieces of one satin are merged again, so the result is a few
// satins cut where the route turns, with running-stitch underpaths between.
//
// Shared: plain functions on objects, so lettering and the digitizer can
// route their satins too.

import type { DesignObject, SubPath, Vec2 } from "../types";
import { flattenSubPath } from "./bezier";
import { satinRailIndices, uid } from "./geometry";

export interface AutoSatinOptions {
  /** Keep the order of the objects (only split them and add underpaths). */
  preserveOrder?: boolean;
  /** Trim instead of jumping between parts; underpaths right after a trim are left out. */
  trim?: boolean;
  /** Keep the original objects (hidden, so they are not sewn twice). */
  keepOriginals?: boolean;
  /** Where to begin and end (default: the left- and rightmost points). */
  start?: Vec2;
  end?: Vec2;
}

const dist = (a: Vec2, b: Vec2) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const lerp = (a: Vec2, b: Vec2, t: number): Vec2 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

function cumulative(pts: Vec2[]): number[] {
  const c = [0];
  for (let i = 1; i < pts.length; i++) c.push(c[i - 1] + dist(pts[i - 1], pts[i]));
  return c;
}
function at(pts: Vec2[], cum: number[], d: number): Vec2 {
  const total = cum[cum.length - 1];
  d = Math.max(0, Math.min(total, d));
  let k = 1;
  while (k < cum.length - 1 && cum[k] < d) k++;
  const l = cum[k] - cum[k - 1];
  return l <= 1e-12 ? pts[k] : lerp(pts[k - 1], pts[k], (d - cum[k - 1]) / l);
}
/** The part of a polyline between fractions f0 < f1 of its length. */
function substring(pts: Vec2[], f0: number, f1: number): Vec2[] {
  const cum = cumulative(pts);
  const total = cum[cum.length - 1];
  const [d0, d1] = [f0 * total, f1 * total];
  const out: Vec2[] = [at(pts, cum, d0)];
  for (let i = 1; i < pts.length - 1; i++) if (cum[i] > d0 + 1e-9 && cum[i] < d1 - 1e-9) out.push(pts[i]);
  out.push(at(pts, cum, d1));
  return out;
}

/** Fewer points on the same line (Douglas–Peucker within `tol` mm). */
function simplify(pts: Vec2[], tol = 0.02): Vec2[] {
  if (pts.length < 3) return pts;
  const keep = new Array(pts.length).fill(false);
  keep[0] = keep[pts.length - 1] = true;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop()!;
    const [a, b] = [pts[i], pts[j]];
    const l = dist(a, b) || 1e-12;
    let best = -1;
    let bd = tol;
    for (let k = i + 1; k < j; k++) {
      const d = Math.abs((b[0] - a[0]) * (a[1] - pts[k][1]) - (a[0] - pts[k][0]) * (b[1] - a[1])) / l;
      if (d > bd) [bd, best] = [d, k];
    }
    if (best >= 0) {
      keep[best] = true;
      stack.push([i, best], [best, j]);
    }
  }
  return pts.filter((_, k) => keep[k]);
}

/** A satin's geometry for routing: its centre line, and its rails (two-rail satins). */
interface SatinShape {
  obj: DesignObject;
  center: Vec2[];
  cum: number[];
  /** Two-rail satins: rails sampled at the same fractions as `center`. */
  rails?: [Vec2[], Vec2[]];
  /** Other sub-paths (rungs) with their centre fraction. */
  rungs: { sp: SubPath; f: number }[];
  half: number;
}

function railsOf(o: DesignObject): { r: [number, number]; rest: number[] } | null {
  const r = satinRailIndices(o.paths);
  if (!r) return null;
  return { r, rest: o.paths.map((_, i) => i).filter((i) => i !== r[0] && i !== r[1]) };
}

function shapeOf(o: DesignObject): SatinShape | null {
  if (o.stitch.type !== "satin") return null;
  const st = o.stitch;
  const two = o.paths.length >= 2 ? railsOf(o) : null;
  if (!two) {
    const c = flattenSubPath(o.paths[0], 0.2);
    if (c.length < 2) return null;
    return { obj: o, center: c, cum: cumulative(c), rungs: [], half: st.width / 2 };
  }
  let r0 = flattenSubPath(o.paths[two.r[0]], 0.2);
  let r1 = flattenSubPath(o.paths[two.r[1]], 0.2);
  if (st.swapRails) [r0, r1] = [r1, r0];
  // the second rail runs like the first (as the engine orients it)
  if (dist(r0[0], r1[0]) + dist(r0[r0.length - 1], r1[r1.length - 1]) > dist(r0[0], r1[r1.length - 1]) + dist(r0[r0.length - 1], r1[0])) r1 = [...r1].reverse();
  const n = Math.max(8, Math.ceil(Math.max(cumulative(r0).at(-1)!, cumulative(r1).at(-1)!) / 0.25));
  const c0 = cumulative(r0);
  const c1 = cumulative(r1);
  const s0: Vec2[] = [];
  const s1: Vec2[] = [];
  for (let i = 0; i <= n; i++) {
    s0.push(at(r0, c0, (c0.at(-1)! * i) / n));
    s1.push(at(r1, c1, (c1.at(-1)! * i) / n));
  }
  const center = s0.map((p, i) => lerp(p, s1[i], 0.5));
  const cum = cumulative(center);
  const project = (q: Vec2) => {
    let best = 0;
    let bd = Infinity;
    center.forEach((p, i) => {
      const d = dist(p, q);
      if (d < bd) [bd, best] = [d, i];
    });
    return cum[best] / (cum.at(-1)! || 1);
  };
  const rungs = two.rest.map((i) => {
    const sp = o.paths[i];
    const a = sp.nodes[0].p;
    const b = sp.nodes[sp.nodes.length - 1].p;
    return { sp, f: project(lerp(a, b, 0.5)) };
  });
  const half = Math.max(...s0.map((p, i) => dist(p, s1[i]))) / 2;
  return { obj: o, center, cum, rails: [s0, s1], rungs, half };
}

/** A piece of a satin (fractions of its centre line). */
interface Segment {
  kind: "satin";
  shape: number;
  start: number;
  end: number;
  reverse: boolean;
}
interface Run {
  kind: "run";
  pts: Vec2[];
  from: number;
}
interface Jump {
  kind: "jump";
  a: Vec2;
  b: Vec2;
}
type Op = Segment | Run | Jump;

/** Where a satin piece starts / ends. */
function pointAt(s: SatinShape, f: number): Vec2 {
  return at(s.center, s.cum, f * s.cum[s.cum.length - 1]);
}

/** Does point `q` lie on the satin (within its width)? */
function onSatin(s: SatinShape, q: Vec2): boolean {
  for (let i = 1; i < s.center.length; i++) {
    const a = s.center[i - 1];
    const b = s.center[i];
    const ab: Vec2 = [b[0] - a[0], b[1] - a[1]];
    const l2 = ab[0] ** 2 + ab[1] ** 2 || 1e-12;
    const t = Math.max(0, Math.min(1, ((q[0] - a[0]) * ab[0] + (q[1] - a[1]) * ab[1]) / l2));
    if (dist(q, lerp(a, b, t)) <= s.half + 1e-6) return true;
  }
  return false;
}

/**
 * Route satin columns (and running-stitch lines that show where to travel)
 * into a sewing order: new objects replacing `objects`. Returns null when
 * there is no satin.
 */
export function autoSatin(objects: DesignObject[], opts: AutoSatinOptions = {}): DesignObject[] | null {
  const shapes: SatinShape[] = [];
  const elemOf: number[] = []; // shape index → element index
  const runs: { obj: DesignObject; pts: Vec2[]; el: number }[] = [];
  objects.forEach((o, el) => {
    const s = shapeOf(o);
    if (s) {
      shapes.push(s);
      elemOf.push(el);
    } else if (o.stitch.type === "running" && o.paths[0]) {
      const pts = flattenSubPath(o.paths[0], 0.2);
      if (pts.length >= 2) runs.push({ obj: o, pts, el });
    }
  });
  if (!shapes.length) return null;

  // 1. the graph: every satin in 1 mm pieces, every running line as one edge
  const key = (p: Vec2) => `${Math.round(p[0] * 1000)},${Math.round(p[1] * 1000)}`;
  const nodes = new Map<string, { p: Vec2; els: Set<number> }>();
  const addNode = (p: Vec2, el: number) => {
    const k = key(p);
    if (!nodes.has(k)) nodes.set(k, { p, els: new Set() });
    nodes.get(k)!.els.add(el);
    return k;
  };
  type Edge = { a: string; b: string; op: Op; el: number; dir?: "fwd" };
  const edges: Edge[] = [];
  shapes.forEach((s, si) => {
    const n = Math.max(1, Math.ceil(s.cum[s.cum.length - 1] / 1));
    for (let i = 0; i < n; i++) {
      const seg: Segment = { kind: "satin", shape: si, start: i / n, end: (i + 1) / n, reverse: false };
      edges.push({ a: addNode(pointAt(s, seg.start), elemOf[si]), b: addNode(pointAt(s, seg.end), elemOf[si]), op: seg, el: elemOf[si] });
    }
  });
  for (const r of runs) edges.push({ a: addNode(r.pts[0], r.el), b: addNode(r.pts[r.pts.length - 1], r.el), op: { kind: "run", pts: r.pts, from: r.el }, el: r.el });

  // adjacency (undirected; with preserve order, jumps only go forward)
  const adj = new Map<string, { to: string; e: number; jumpDir?: boolean }[]>();
  const link = (a: string, b: string, e: number, oneWay = false) => {
    if (!adj.has(a)) adj.set(a, []);
    if (!adj.has(b)) adj.set(b, []);
    adj.get(a)!.push({ to: b, e, jumpDir: oneWay || undefined });
    if (!oneWay) adj.get(b)!.push({ to: a, e });
  };
  edges.forEach((e, i) => link(e.a, e.b, i));
  // one-way jumps, by their end (the walk after the main path may use them backwards)
  const jumpIn = new Map<string, { to: string; e: number }[]>();
  const addJump = (a: string, b: string, oneWay = false) => {
    edges.push({ a, b, op: { kind: "jump", a: nodes.get(a)!.p, b: nodes.get(b)!.p }, el: -1 });
    link(a, b, edges.length - 1, oneWay);
    if (oneWay) {
      if (!jumpIn.has(b)) jumpIn.set(b, []);
      jumpIn.get(b)!.push({ to: a, e: edges.length - 1 });
    }
  };
  const nodesOf = (el: number) => [...nodes].filter(([, v]) => v.els.has(el)).map(([k]) => k);

  // 2. jumps: the fewest and shortest that connect everything
  if (opts.preserveOrder) {
    // between consecutive objects, the shortest jump from one to the next
    for (let el = 0; el + 1 < objects.length; el++) {
      const a = nodesOf(el);
      const b = nodesOf(el + 1);
      let best: [string, string, number] | null = null;
      for (const x of a) for (const y of b) {
        const d = dist(nodes.get(x)!.p, nodes.get(y)!.p);
        if (!best || d < best[2]) best = [x, y, d];
      }
      if (best && best[0] !== best[1]) addJump(best[0], best[1], true);
    }
  } else {
    // a minimum spanning tree over the connected parts (Ink/Stitch k-edge augmentation)
    const comp = new Map<string, number>();
    let nc = 0;
    for (const k of nodes.keys()) {
      if (comp.has(k)) continue;
      const stack = [k];
      comp.set(k, nc);
      while (stack.length) {
        const u = stack.pop()!;
        for (const { to } of adj.get(u) ?? []) if (!comp.has(to)) (comp.set(to, nc), stack.push(to));
      }
      nc++;
    }
    const members: string[][] = Array.from({ length: nc }, () => []);
    for (const [k, c] of comp) members[c].push(k);
    const cand: [number, number, string, string, number][] = [];
    for (let i = 0; i < nc; i++)
      for (let j = i + 1; j < nc; j++) {
        let best: [string, string, number] | null = null;
        for (const x of members[i]) for (const y of members[j]) {
          const d = dist(nodes.get(x)!.p, nodes.get(y)!.p);
          if (!best || d < best[2]) best = [x, y, d];
        }
        if (best) cand.push([i, j, best[0], best[1], best[2]]);
      }
    cand.sort((x, y) => x[4] - y[4]);
    const parent = Array.from({ length: nc }, (_, i) => i);
    const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])));
    for (const [i, j, a, b] of cand) {
      const [ri, rj] = [find(i), find(j)];
      if (ri === rj) continue;
      parent[ri] = rj;
      addJump(a, b);
    }
  }

  // 3. start and end nodes (on the first / last object with preserve order)
  const pick = (p: Vec2 | undefined, el: number | null, extreme: 1 | -1) => {
    const pool = el != null ? nodesOf(el) : [...nodes.keys()];
    const list = pool.length ? pool : [...nodes.keys()];
    return list.reduce((best, k) => {
      const q = nodes.get(k)!.p;
      const b = nodes.get(best)!.p;
      if (p) return dist(q, p) < dist(b, p) ? k : best;
      return q[0] * extreme > b[0] * extreme ? k : best;
    }, list[0]);
  };
  const startNode = pick(opts.start, opts.preserveOrder ? 0 : null, -1);
  const endNode = pick(opts.end, opts.preserveOrder ? objects.length - 1 : null, 1);

  // 4. the walk (Ink/Stitch find_path): shortest path start → end (fewest
  // edges), then from each of its nodes a depth-first search down the rest,
  // every branch walked back again
  const removed = new Set<number>();
  const bfs = (): number[] | null => {
    const prev = new Map<string, [string, number]>();
    const q = [startNode];
    const seen = new Set([startNode]);
    while (q.length) {
      const u = q.shift()!;
      if (u === endNode) break;
      for (const { to, e } of adj.get(u) ?? []) {
        if (seen.has(to)) continue;
        seen.add(to);
        prev.set(to, [u, e]);
        q.push(to);
      }
    }
    if (startNode !== endNode && !prev.has(endNode)) return null;
    const path: number[] = [];
    let cur = endNode;
    while (cur !== startNode) {
      const [p, e] = prev.get(cur)!;
      path.unshift(e);
      cur = p;
    }
    return path;
  };
  let main = bfs();
  if (!main) {
    addJump(startNode, endNode);
    main = bfs() ?? [];
  }
  // the walk as (edge, from node) steps
  const steps: [number, string][] = [];
  const nodeSeq = [startNode];
  for (const e of main) {
    const ed = edges[e];
    const from = nodeSeq[nodeSeq.length - 1];
    nodeSeq.push(ed.a === from ? ed.b : ed.a);
    removed.add(e);
  }
  const undirected = (u: string) => {
    // every edge at u, both ways (jump directions only matter for the main path)
    return [...(adj.get(u) ?? []).map((x) => ({ to: x.to, e: x.e })), ...(jumpIn.get(u) ?? [])];
  };
  nodeSeq.forEach((node, i) => {
    if (i > 0) steps.push([main![i - 1], nodeSeq[i - 1]]);
    // DFS from `node` over the edges not walked yet (networkx dfs_labeled_edges)
    const events: [string, string, number, "forward" | "reverse" | "nontree"][] = [];
    const visited = new Set([node]);
    const stack: { u: string; it: { to: string; e: number }[]; k: number; via: number }[] = [{ u: node, it: undirected(node).filter((x) => !removed.has(x.e)), k: 0, via: -1 }];
    while (stack.length) {
      const top = stack[stack.length - 1];
      if (top.k < top.it.length) {
        const { to, e } = top.it[top.k++];
        if (visited.has(to)) events.push([top.u, to, e, "nontree"]);
        else {
          events.push([top.u, to, e, "forward"]);
          visited.add(to);
          stack.push({ u: to, it: undirected(to).filter((x) => !removed.has(x.e)), k: 0, via: e });
        }
      } else {
        stack.pop();
        if (stack.length) events.push([stack[stack.length - 1].u, top.u, top.via, "reverse"]);
      }
    }
    for (const [n1, n2, e, kind] of events) {
      if (kind === "forward") {
        steps.push([e, n1]);
        removed.add(e);
      } else if (kind === "reverse") {
        steps.push([e, n2]);
      } else if (!removed.has(e)) {
        steps.push([e, n1], [e, n2]);
        removed.add(e);
      }
    }
  });

  // 5. operations: pieces in their direction; a piece walked twice is a
  // running stitch the first time
  const ops: Op[] = steps.map(([e, from]) => {
    const ed = edges[e];
    if (ed.op.kind === "satin") return { ...ed.op, reverse: ed.a !== from };
    if (ed.op.kind === "run") return ed.a === from ? ed.op : { ...ed.op, pts: [...ed.op.pts].reverse() };
    return ed.a === from ? ed.op : { kind: "jump", a: ed.op.b, b: ed.op.a };
  });
  const seen = new Set<string>();
  for (let i = ops.length - 1; i >= 0; i--) {
    const op = ops[i];
    if (op.kind !== "satin") continue;
    const k = `${op.shape}:${op.start}:${op.end}`;
    if (seen.has(k)) {
      const s = shapes[op.shape];
      const pts = substring(s.center, op.start, op.end);
      ops[i] = { kind: "run", pts: op.reverse ? pts.reverse() : pts, from: elemOf[op.shape] };
    } else seen.add(k);
  }
  // 6. consecutive pieces merged
  const merged: Op[] = [];
  for (const op of ops) {
    const last = merged[merged.length - 1];
    if (last?.kind === "satin" && op.kind === "satin" && last.shape === op.shape && last.reverse === op.reverse && Math.abs(last.reverse ? last.start - op.end : last.end - op.start) < 1e-9) {
      merged[merged.length - 1] = last.reverse ? { ...last, start: op.start } : { ...last, end: op.end };
    } else if (last?.kind === "run" && op.kind === "run" && last.from === op.from && dist(last.pts[last.pts.length - 1], op.pts[0]) < 0.5 && !(dist(last.pts[0], op.pts[op.pts.length - 1]) < 1e-6 && dist(last.pts[last.pts.length - 1], op.pts[0]) < 1e-6 && op.pts.length === last.pts.length)) {
      merged[merged.length - 1] = { ...last, pts: [...last.pts, ...op.pts.slice(1)] };
    } else merged.push(op);
  }

  // 7. objects; a jump that shows (more than 1 mm off both satins) is a trim
  const out: DesignObject[] = [];
  const trims = new Set<number>();
  let n = 1;
  for (const op of merged) {
    if (op.kind === "jump") {
      if (!out.length) continue;
      const len = dist(op.a, op.b);
      const steps = Math.max(1, Math.ceil(len / 0.1));
      let shows = 0;
      for (let k = 0; k < steps; k++) {
        const q = lerp(op.a, op.b, (k + 0.5) / steps);
        if (!shapes.some((s) => onSatin(s, q))) shows += len / steps;
      }
      if (shows > 1) trims.add(out.length - 1);
      continue;
    }
    if (op.kind === "run") {
      const src = objects[op.from];
      const len = src.stitch.type === "satin" ? (src.stitch.underlayStitchLength ?? 2.5) : src.stitch.type === "running" ? src.stitch.length : 2.5;
      out.push({
        ...src,
        id: uid(),
        name: `AutoSatin Running Stitch ${n++}`,
        paths: [{ closed: false, nodes: simplify(op.pts).map((p) => ({ p })) }],
        stitch: { type: "running", length: len, tolerance: 0.2, repeats: 1, beanRepeats: 0 },
        start: undefined,
        end: undefined,
        trimAfter: false,
        stopAfter: false,
        text: undefined,
        group: undefined,
      });
      continue;
    }
    const s = shapes[op.shape];
    const src = s.obj;
    if (src.stitch.type !== "satin") continue;
    const whole = op.start <= 1e-9 && op.end >= 1 - 1e-9;
    let paths: SubPath[];
    if (whole) paths = src.paths;
    else if (s.rails) {
      const poly = (pts: Vec2[]): SubPath => ({ closed: false, nodes: simplify(pts).map((p) => ({ p })) });
      paths = [poly(substring(s.rails[0], op.start, op.end)), poly(substring(s.rails[1], op.start, op.end)), ...s.rungs.filter((r) => r.f > op.start && r.f < op.end).map((r) => r.sp)];
    } else paths = [{ closed: false, nodes: simplify(substring(s.center, op.start, op.end)).map((p) => ({ p })) }];
    const st = src.stitch;
    // the centre walk underlay sewn an even number of times, so the column ends where it began its underlay
    const walk = st.centerWalkRepeats ?? 2;
    out.push({
      ...src,
      id: uid(),
      name: `AutoSatin ${n++}`,
      paths,
      stitch: { ...st, reverse: op.reverse, swapRails: whole || !s.rails ? st.swapRails : false, centerWalkRepeats: walk % 2 ? Math.max(2, walk - 1) : walk, guides: whole ? st.guides : undefined },
      start: undefined,
      end: undefined,
      trimAfter: false,
      stopAfter: false,
      text: undefined,
      group: undefined,
    });
  }
  // 8. trims: on the object before each trimmed jump, and the underpath right after it left out
  if (opts.trim) {
    const kept: DesignObject[] = [];
    let justTrimmed = false;
    out.forEach((o, i) => {
      if (justTrimmed && o.stitch.type === "running") return;
      justTrimmed = trims.has(i);
      kept.push(justTrimmed ? { ...o, trimAfter: true } : o);
    });
    if (kept.length) kept[kept.length - 1] = { ...kept[kept.length - 1], trimAfter: true };
    return kept;
  }
  return out;
}
