// Auto-route running stitch, after Ink/Stitch's "Auto-route running stitch"
// (lib/extensions/auto_run.py + lib/stitches/auto_run.py): many lines become
// as few continuous paths as possible.
//
// * The lines are broken where they cross or touch (Ink/Stitch "add nodes at
//   intersections"), giving a graph of nodes and edges.
// * In every connected part, the nodes with an odd number of edges are paired
//   up (nearest first) and joined by travelling along existing lines — those
//   stretches are sewn twice, on top of each other (Ink/Stitch's underpath).
//   Then one walk covers every edge (Hierholzer).
// * Separate parts are sewn one after the other, nearest first (a jump or
//   trim between them).
//
// Shared: it takes and returns plain polylines, so lettering, redwork and
// the digitizer can route with it too.

import type { Vec2 } from "../types";

const d2 = (a: Vec2, b: Vec2) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;
const dist = (a: Vec2, b: Vec2) => Math.sqrt(d2(a, b));

/** Where two segments cross (parameters on both), if they do. */
function cross(a: Vec2, b: Vec2, c: Vec2, d: Vec2): [number, number] | null {
  const r: Vec2 = [b[0] - a[0], b[1] - a[1]];
  const s: Vec2 = [d[0] - c[0], d[1] - c[1]];
  const den = r[0] * s[1] - r[1] * s[0];
  if (Math.abs(den) < 1e-12) return null;
  const t = ((c[0] - a[0]) * s[1] - (c[1] - a[1]) * s[0]) / den;
  const u = ((c[0] - a[0]) * r[1] - (c[1] - a[1]) * r[0]) / den;
  return t >= -1e-9 && t <= 1 + 1e-9 && u >= -1e-9 && u <= 1 + 1e-9 ? [t, u] : null;
}

interface Edge {
  a: number;
  b: number;
  pts: Vec2[];
  len: number;
}

export interface RouteOptions {
  /** Points closer than this are one node (mm). */
  snap?: number;
  /** Where to begin (the first part starts at its node nearest to it). */
  start?: Vec2;
  /** Redwork (Ink/Stitch): every line exactly twice — out and back — so
   *  each part is one closed walk ending where it began, with no jumps inside. */
  redwork?: boolean;
}

/**
 * Route polylines into as few continuous paths as possible. Returns the
 * paths in sewing order; parts of a path that repeat a line are travel.
 */
export function routeRunning(lines: Vec2[][], opts: RouteOptions = {}): Vec2[][] {
  const snap = opts.snap ?? 0.3;
  const polys = lines.filter((l) => l.length >= 2);
  if (!polys.length) return [];
  // 1. cut every polyline where any segment crosses it (and at the other lines' ends)
  const cuts: number[][] = polys.map(() => []); // arc-free: segment index + t, as k + t
  const segs: { li: number; k: number; a: Vec2; b: Vec2 }[] = [];
  polys.forEach((l, li) => {
    for (let k = 0; k + 1 < l.length; k++) segs.push({ li, k, a: l[k], b: l[k + 1] });
  });
  // a grid of segments for the crossing search
  const cell = 5;
  const grid = new Map<string, number[]>();
  const keyOf = (x: number, y: number) => `${Math.floor(x / cell)},${Math.floor(y / cell)}`;
  segs.forEach((sg, si) => {
    const [x0, x1] = [Math.min(sg.a[0], sg.b[0]), Math.max(sg.a[0], sg.b[0])];
    const [y0, y1] = [Math.min(sg.a[1], sg.b[1]), Math.max(sg.a[1], sg.b[1])];
    for (let gx = Math.floor(x0 / cell); gx <= Math.floor(x1 / cell); gx++)
      for (let gy = Math.floor(y0 / cell); gy <= Math.floor(y1 / cell); gy++) {
        const k = `${gx},${gy}`;
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k)!.push(si);
      }
  });
  const seen = new Set<string>();
  for (const ids of grid.values())
    for (let i = 0; i < ids.length; i++)
      for (let j = i + 1; j < ids.length; j++) {
        const [p, q] = [segs[ids[i]], segs[ids[j]]];
        if (p.li === q.li && Math.abs(p.k - q.k) <= 1) continue;
        const pair = ids[i] < ids[j] ? `${ids[i]}:${ids[j]}` : `${ids[j]}:${ids[i]}`;
        if (seen.has(pair)) continue;
        seen.add(pair);
        const x = cross(p.a, p.b, q.a, q.b);
        if (x) {
          cuts[p.li].push(p.k + x[0]);
          cuts[q.li].push(q.k + x[1]);
        }
      }
  // a line ending on another one (a T-junction) cuts it there too
  polys.forEach((l) => {
    for (const end of [l[0], l[l.length - 1]]) {
      const k = keyOf(end[0], end[1]);
      for (const si of grid.get(k) ?? []) {
        const sg = segs[si];
        const ab: Vec2 = [sg.b[0] - sg.a[0], sg.b[1] - sg.a[1]];
        const t = Math.max(0, Math.min(1, ((end[0] - sg.a[0]) * ab[0] + (end[1] - sg.a[1]) * ab[1]) / Math.max(1e-12, ab[0] ** 2 + ab[1] ** 2)));
        const q: Vec2 = [sg.a[0] + ab[0] * t, sg.a[1] + ab[1] * t];
        if (dist(q, end) < snap && t > 1e-6 && t < 1 - 1e-6) cuts[sg.li].push(sg.k + t);
      }
    }
  });
  // 2. pieces between the cuts, their ends snapped into nodes
  const nodes: Vec2[] = [];
  const nodeAt = (p: Vec2) => {
    for (let i = 0; i < nodes.length; i++) if (d2(nodes[i], p) < snap * snap) return i;
    nodes.push(p);
    return nodes.length - 1;
  };
  const edges: Edge[] = [];
  polys.forEach((l, li) => {
    const at = (s: number): Vec2 => {
      const k = Math.min(Math.floor(s), l.length - 2);
      const t = s - k;
      return [l[k][0] + (l[k + 1][0] - l[k][0]) * t, l[k][1] + (l[k + 1][1] - l[k][1]) * t];
    };
    const marks = [0, ...cuts[li].sort((x, y) => x - y), l.length - 1];
    for (let m = 0; m + 1 < marks.length; m++) {
      const [s0, s1] = [marks[m], marks[m + 1]];
      if (s1 - s0 < 1e-9) continue;
      const pts: Vec2[] = [at(s0)];
      for (let k = Math.floor(s0) + 1; k <= Math.ceil(s1) - 1; k++) if (k > s0 && k < s1) pts.push(l[k]);
      pts.push(at(s1));
      let len = 0;
      for (let i = 1; i < pts.length; i++) len += dist(pts[i - 1], pts[i]);
      if (len < 1e-6) continue;
      edges.push({ a: nodeAt(pts[0]), b: nodeAt(pts[pts.length - 1]), pts, len });
    }
  });
  // 3. connected parts
  const adj: number[][] = nodes.map(() => []);
  edges.forEach((e, i) => {
    adj[e.a].push(i);
    adj[e.b].push(i);
  });
  const part = new Array(nodes.length).fill(-1);
  let nparts = 0;
  for (let s = 0; s < nodes.length; s++) {
    if (part[s] >= 0 || !adj[s].length) continue;
    const stack = [s];
    part[s] = nparts;
    while (stack.length) {
      const u = stack.pop()!;
      for (const ei of adj[u]) {
        const v = edges[ei].a === u ? edges[ei].b : edges[ei].a;
        if (part[v] < 0) {
          part[v] = nparts;
          stack.push(v);
        }
      }
    }
    nparts++;
  }
  // shortest paths along the lines (for pairing odd nodes)
  const dijkstra = (src: number): { dist: number[]; via: number[] } => {
    const dd = new Array(nodes.length).fill(Infinity);
    const via = new Array(nodes.length).fill(-1);
    dd[src] = 0;
    const open = new Set([src]);
    while (open.size) {
      let u = -1;
      for (const x of open) if (u < 0 || dd[x] < dd[u]) u = x;
      open.delete(u);
      for (const ei of adj[u]) {
        const e = edges[ei];
        const v = e.a === u ? e.b : e.a;
        if (dd[u] + e.len < dd[v]) {
          dd[v] = dd[u] + e.len;
          via[v] = ei;
          open.add(v);
        }
      }
    }
    return { dist: dd, via };
  };
  // 4. per part: pair the odd nodes (nearest first), double their connecting edges, walk
  const out: Vec2[][] = [];
  const done = new Array(nparts).fill(false);
  let pos = opts.start ?? polys[0][0];
  for (let n = 0; n < nparts; n++) {
    // the nearest part next, entered at its node nearest to where we are
    let bestNode = -1;
    for (let i = 0; i < nodes.length; i++) if (part[i] >= 0 && !done[part[i]] && (bestNode < 0 || d2(nodes[i], pos) < d2(nodes[bestNode], pos))) bestNode = i;
    if (bestNode < 0) break;
    const pid = part[bestNode];
    done[pid] = true;
    const mine = edges.map((_, i) => i).filter((i) => part[edges[i].a] === pid);
    const deg = new Map<number, number>();
    for (const i of mine) {
      deg.set(edges[i].a, (deg.get(edges[i].a) ?? 0) + 1);
      deg.set(edges[i].b, (deg.get(edges[i].b) ?? 0) + 1);
    }
    // redwork: every edge twice — all degrees even, a closed walk
    let odd = opts.redwork ? [] : [...deg.entries()].filter(([, k]) => k % 2 === 1).map(([v]) => v);
    // an open walk may start and end on odd nodes: keep the start's (or the nearest odd node) unpaired
    const startNode = odd.length ? odd.reduce((a, b) => (d2(nodes[a], pos) <= d2(nodes[b], pos) ? a : b)) : bestNode;
    odd = odd.filter((v) => v !== startNode);
    const extra: number[] = [];
    let endNode: number | null = null;
    if (odd.length % 2 === 1) {
      // the other end of the open walk: the odd node farthest along
      const { dist: dd } = dijkstra(startNode);
      endNode = odd.reduce((a, b) => (dd[a] >= dd[b] ? a : b));
      odd = odd.filter((v) => v !== endNode);
    }
    while (odd.length >= 2) {
      const u = odd.shift()!;
      const { dist: dd, via } = dijkstra(u);
      const k = odd.reduce((bi, v, i) => (dd[v] < dd[odd[bi]] ? i : bi), 0);
      let v = odd.splice(k, 1)[0];
      while (v !== u && via[v] >= 0) {
        extra.push(via[v]);
        const e = edges[via[v]];
        v = e.a === v ? e.b : e.a;
      }
    }
    // Hierholzer over the part's edges plus the doubled ones
    const multi = opts.redwork ? [...mine, ...mine] : [...mine, ...extra];
    const used = new Array(multi.length).fill(false);
    const inc = new Map<number, number[]>();
    multi.forEach((ei, j) => {
      for (const v of [edges[ei].a, edges[ei].b]) {
        if (!inc.has(v)) inc.set(v, []);
        inc.get(v)!.push(j);
      }
    });
    const stack: { v: number; j: number }[] = [{ v: startNode, j: -1 }];
    const walk: { v: number; j: number }[] = [];
    while (stack.length) {
      const top = stack[stack.length - 1];
      const list = inc.get(top.v) ?? [];
      const nextJ = list.find((j) => !used[j]);
      if (nextJ === undefined) {
        walk.push(stack.pop()!);
        continue;
      }
      used[nextJ] = true;
      const e = edges[multi[nextJ]];
      stack.push({ v: e.a === top.v ? e.b : e.a, j: nextJ });
    }
    walk.reverse();
    const path: Vec2[] = [nodes[startNode]];
    for (let w = 1; w < walk.length; w++) {
      const e = edges[multi[walk[w].j]];
      const forward = e.a === walk[w - 1].v;
      const pts = forward ? e.pts : [...e.pts].reverse();
      for (const p of pts.slice(1)) path.push(p);
    }
    if (path.length >= 2) out.push(path);
    pos = path[path.length - 1];
    void endNode;
  }
  return out;
}

