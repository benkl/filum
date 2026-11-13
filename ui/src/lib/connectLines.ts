// Connect line pieces into as few continuous lines as possible (Path ▸
// Convert ▸ Connect lines). Typical input: an imported drawing whose strokes
// arrive as many short pieces, end to end, some doubled.
//
// * Every open sub-path is a piece. Pieces lying on top of another (doubled
//   strokes) can be left out first.
// * Piece ends closer than `join` meet at one point (a junction).
// * Loose ends close to each other (up to `bridge`) are bridged by a short
//   straight line, a few millimetres of stitches instead of a trim.
// * Then the pieces are walked as Euler trails: each piece once, never twice,
//   the fewest lines a network allows (a part with 2k odd junctions needs k
//   lines). At a junction the walk goes on along the piece that continues
//   straightest, so crossing strokes stay straight.
// * The lines are ordered nearest first, each turned the way that starts
//   closest to where the last one ended.
//
// Curves keep their Bézier handles; only the joined ends move (to their
// average point, at most half of `join`).

import type { PathNode, SubPath, Vec2 } from "../types";
import { cubicAt, flattenSubPath, segmentOf } from "./bezier";

export interface ConnectOptions {
  /** Piece ends closer than this meet (mm). */
  join: number;
  /** Loose ends up to this far apart are bridged by a straight line (mm; 0: never). */
  bridge: number;
  /** At a junction, go on along the straightest piece (else: the first free one). */
  straight: boolean;
  /** Leave out pieces that lie on top of another piece. */
  dropDoubled: boolean;
}

export const DEFAULT_CONNECT: ConnectOptions = { join: 0.5, bridge: 2, straight: true, dropDoubled: true };

export interface ConnectResult {
  paths: SubPath[];
  pieces: number;
  lines: number;
  bridged: number;
  doubled: number;
}

const d2 = (a: Vec2, b: Vec2) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;
const dist = (a: Vec2, b: Vec2) => Math.sqrt(d2(a, b));
const sub = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]];
const norm = (v: Vec2): Vec2 => {
  const l = Math.hypot(v[0], v[1]);
  return l > 1e-12 ? [v[0] / l, v[1] / l] : [0, 0];
};

/** A piece turned round: nodes in reverse order, in and out handles swapped. */
export function reversePiece(sp: SubPath): SubPath {
  return { ...sp, nodes: [...sp.nodes].reverse().map((n) => ({ ...n, i: n.o, o: n.i })) };
}

/** The direction a piece leaves its first node (along its first curve). */
function startDir(sp: SubPath): Vec2 {
  const seg = segmentOf(sp, 0);
  const a = sp.nodes[0].p;
  const q = cubicAt(seg, 0.05);
  const d = sub(q, a);
  return Math.hypot(d[0], d[1]) > 1e-9 ? norm(d) : norm(sub(sp.nodes[1].p, a));
}

/** Every pair among this many points is compared; above it, only each point's
 *  nearest neighbours (all pairs of thousands of loose ends ran out of memory). */
const ALL_PAIRS_UP_TO = 1500;
const NEIGHBOURS = 8;

/** The points `ids` (into `pos`) paired up, nearest pairs first and each point
 *  once (one is left over when their number is odd). */
export function nearestPairs(pos: Vec2[], ids: number[]): [number, number][] {
  const out: [number, number][] = [];
  const used = new Set<number>();
  let left = ids;
  // every round pairs at least its nearest candidate pair; with all pairs
  // compared, one round pairs every point
  while (left.length > 1) {
    const cand: [number, number, number][] = [];
    if (left.length <= ALL_PAIRS_UP_TO) {
      for (let i = 0; i < left.length; i++) for (let j = i + 1; j < left.length; j++) cand.push([d2(pos[left[i]], pos[left[j]]), left[i], left[j]]);
    } else {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const v of left) {
        const [x, y] = pos[v];
        x0 = Math.min(x0, x); y0 = Math.min(y0, y);
        x1 = Math.max(x1, x); y1 = Math.max(y1, y);
      }
      // about one point per cell
      const cell = Math.max(x1 - x0, y1 - y0, 1e-6) / Math.sqrt(left.length);
      const cols = Math.floor((x1 - x0) / cell) + 1;
      const rows = Math.floor((y1 - y0) / cell) + 1;
      const cellOf = (p: Vec2): [number, number] => [Math.floor((p[0] - x0) / cell), Math.floor((p[1] - y0) / cell)];
      const grid = new Map<number, number[]>();
      for (const v of left) {
        const [cx, cy] = cellOf(pos[v]);
        const k = cy * cols + cx;
        const list = grid.get(k);
        if (list) list.push(v);
        else grid.set(k, [v]);
      }
      for (const u of left) {
        const [cx, cy] = cellOf(pos[u]);
        const found: [number, number][] = [];
        // rings of cells outwards, one more ring after enough are found
        let enoughAt = -1;
        for (let r = 0; r <= Math.max(cols, rows); r++) {
          for (let dy = -r; dy <= r; dy++) {
            const y = cy + dy;
            if (y < 0 || y >= rows) continue;
            const step = Math.abs(dy) === r ? 1 : 2 * r;
            for (let dx = -r; dx <= r; dx += Math.max(step, 1)) {
              const x = cx + dx;
              if (x < 0 || x >= cols) continue;
              for (const v of grid.get(y * cols + x) ?? []) if (v !== u) found.push([d2(pos[u], pos[v]), v]);
            }
          }
          if (enoughAt < 0 && found.length >= NEIGHBOURS) enoughAt = r;
          if (enoughAt >= 0 && r > enoughAt) break;
        }
        found.sort((a, b) => a[0] - b[0]);
        for (const [dd, v] of found.slice(0, NEIGHBOURS)) cand.push([dd, u, v]);
      }
    }
    cand.sort((x, y) => x[0] - y[0]);
    for (const [, u, v] of cand) {
      if (used.has(u) || used.has(v)) continue;
      used.add(u);
      used.add(v);
      out.push([u, v]);
    }
    left = left.filter((v) => !used.has(v));
  }
  return out;
}

/** Pieces whose every point lies within `tol` of an earlier piece (doubled strokes). */
export function doubledPieces(pieces: SubPath[], tol = 0.3): Set<number> {
  const cell = Math.max(tol, 0.25) * 2;
  const grid = new Map<string, Vec2[]>();
  const key = (x: number, y: number) => `${Math.floor(x / cell)},${Math.floor(y / cell)}`;
  const near = (p: Vec2) => {
    const cx = Math.floor(p[0] / cell);
    const cy = Math.floor(p[1] / cell);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (const q of grid.get(`${cx + dx},${cy + dy}`) ?? []) if (d2(p, q) <= tol * tol) return true;
    return false;
  };
  const out = new Set<number>();
  pieces.forEach((sp, k) => {
    const pts = resample(flattenSubPath(sp, 0.05), 0.25);
    // checked against the kept pieces before it
    if (pts.length && pts.every(near)) {
      out.add(k);
      return;
    }
    for (const p of pts) {
      const kk = key(p[0], p[1]);
      grid.set(kk, [...(grid.get(kk) ?? []), p]);
    }
  });
  return out;
}

/** Points along a polyline at most `step` apart (its own points kept). */
export function resample(line: Vec2[], step: number): Vec2[] {
  if (line.length < 2) return line.slice();
  const out: Vec2[] = [line[0]];
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1];
    const b = line[i];
    const n = Math.max(1, Math.ceil(dist(a, b) / step));
    for (let k = 1; k <= n; k++) out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
  }
  return out;
}

interface Edge {
  a: number;
  b: number;
  /** The piece from a to b (null: a bridge, a straight line). */
  sp: SubPath | null;
  /** Leaves a / leaves b (unit vectors). */
  da: Vec2;
  db: Vec2;
}

export function connectLines(input: SubPath[], o: ConnectOptions = DEFAULT_CONNECT): ConnectResult {
  const closed = input.filter((sp) => sp.closed && sp.nodes.length >= 2);
  let pieces = input.filter((sp) => !sp.closed && sp.nodes.length >= 2);
  const total = pieces.length;
  let doubled = 0;
  if (o.dropDoubled) {
    const drop = doubledPieces(pieces);
    doubled = drop.size;
    pieces = pieces.filter((_, k) => !drop.has(k));
  }

  // junctions: piece ends within `join` of each other (single linkage)
  const ends: Vec2[] = pieces.flatMap((sp) => [sp.nodes[0].p, sp.nodes[sp.nodes.length - 1].p]);
  const parent = ends.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const join2 = Math.max(o.join, 1e-6) ** 2;
  for (let i = 0; i < ends.length; i++) for (let j = i + 1; j < ends.length; j++) if (d2(ends[i], ends[j]) <= join2) parent[find(i)] = find(j);
  const vid = new Map<number, number>();
  const vpos: Vec2[] = [];
  const vcount: number[] = [];
  ends.forEach((p, i) => {
    const r = find(i);
    if (!vid.has(r)) {
      vid.set(r, vpos.length);
      vpos.push([0, 0]);
      vcount.push(0);
    }
    const v = vid.get(r)!;
    vpos[v] = [vpos[v][0] + p[0], vpos[v][1] + p[1]];
    vcount[v]++;
  });
  for (let v = 0; v < vpos.length; v++) vpos[v] = [vpos[v][0] / vcount[v], vpos[v][1] / vcount[v]];
  const endV = (i: number) => vid.get(find(i))!;

  const edges: Edge[] = pieces.map((sp, k) => ({ a: endV(2 * k), b: endV(2 * k + 1), sp, da: startDir(sp), db: startDir(reversePiece(sp)) }));
  const deg = () => {
    const d = vpos.map(() => 0);
    for (const e of edges) {
      d[e.a]++;
      d[e.b]++;
    }
    return d;
  };

  // bridges: odd junctions near each other, shortest first (each makes two even)
  let bridged = 0;
  if (o.bridge > 0) {
    const d = deg();
    const odd = vpos.map((_, v) => v).filter((v) => d[v] % 2 === 1);
    const pairs: [number, number, number][] = [];
    for (let i = 0; i < odd.length; i++)
      for (let j = i + 1; j < odd.length; j++) {
        const len = dist(vpos[odd[i]], vpos[odd[j]]);
        if (len <= o.bridge) pairs.push([len, odd[i], odd[j]]);
      }
    pairs.sort((x, y) => x[0] - y[0]);
    const used = new Set<number>();
    for (const [, u, v] of pairs) {
      if (used.has(u) || used.has(v)) continue;
      // (the two ends of one piece: the bridge closes a nearly closed stroke)
      used.add(u);
      used.add(v);
      const dir = norm(sub(vpos[v], vpos[u]));
      edges.push({ a: u, b: v, sp: null, da: dir, db: [-dir[0], -dir[1]] });
      bridged++;
    }
  }

  // Euler trails: odd junctions paired by virtual edges (the breaks between lines)
  const d = deg();
  const odd = vpos.map((_, v) => v).filter((v) => d[v] % 2 === 1);
  const isVirtual = new Set<number>();
  // nearest pairs first: lines that end close to where the next starts
  for (const [u, v] of nearestPairs(vpos, odd)) {
    isVirtual.add(edges.length);
    edges.push({ a: u, b: v, sp: null, da: [0, 0], db: [0, 0] });
  }

  const inc: number[][] = vpos.map(() => []);
  edges.forEach((e, k) => {
    inc[e.a].push(k);
    inc[e.b].push(k);
  });
  const usedE = new Uint8Array(edges.length);
  const other = (k: number, v: number) => (edges[k].a === v ? edges[k].b : edges[k].a);
  const leave = (k: number, v: number): Vec2 => (edges[k].a === v ? edges[k].da : edges[k].db);
  // arriving at v along k: the direction of travel there
  const arrive = (k: number, v: number): Vec2 => {
    const l = edges[k].a === v ? edges[k].da : edges[k].db;
    return [-l[0], -l[1]];
  };

  // Hierholzer with a straightest-next rule; a trail is a list of [edge, from]
  type Step = { k: number; from: number };
  const circuits: Step[][] = [];
  const comps = new Uint8Array(vpos.length);
  for (let s = 0; s < vpos.length; s++) {
    if (comps[s] || !inc[s].length) continue;
    // start at an odd junction if the part has one (its line starts at a loose end)
    const stack: { v: number; via: Step | null }[] = [{ v: s, via: null }];
    const circuit: Step[] = [];
    while (stack.length) {
      const top = stack[stack.length - 1];
      comps[top.v] = 1;
      const free = inc[top.v].filter((k) => !usedE[k]);
      if (!free.length) {
        stack.pop();
        if (top.via) circuit.push(top.via);
        continue;
      }
      let pick = free[0];
      if (o.straight && top.via && !isVirtual.has(top.via.k)) {
        const dir = arrive(top.via.k, top.v);
        let best = -Infinity;
        for (const k of free) {
          // a break between lines is taken last
          const score = isVirtual.has(k) ? -10 : dir[0] * leave(k, top.v)[0] + dir[1] * leave(k, top.v)[1];
          if (score > best) {
            best = score;
            pick = k;
          }
        }
      } else if (!top.via) {
        pick = free.find((k) => !isVirtual.has(k)) ?? free[0];
      }
      usedE[pick] = 1;
      stack.push({ v: other(pick, top.v), via: { k: pick, from: top.v } });
    }
    circuit.reverse();
    if (circuit.length) circuits.push(circuit);
  }

  // split each circuit at its virtual edges into lines
  const trails: Step[][] = [];
  for (const c of circuits) {
    const vi = c.findIndex((st) => isVirtual.has(st.k));
    if (vi < 0) {
      trails.push(c);
      continue;
    }
    const rot = [...c.slice(vi + 1), ...c.slice(0, vi + 1)];
    let cur: Step[] = [];
    for (const st of rot) {
      if (isVirtual.has(st.k)) {
        if (cur.length) trails.push(cur);
        cur = [];
      } else cur.push(st);
    }
    if (cur.length) trails.push(cur);
  }

  // each line as a path: pieces end to end, joined ends at the junction
  const build = (t: Step[]): SubPath => {
    const nodes: PathNode[] = [];
    for (const st of t) {
      const e = edges[st.k];
      const fwd = e.a === st.from;
      const to = fwd ? e.b : e.a;
      const sp = e.sp ? (fwd ? e.sp : reversePiece(e.sp)) : { closed: false, nodes: [{ p: vpos[st.from] }, { p: vpos[to] }] };
      const ns = sp.nodes.map((n) => ({ ...n }));
      ns[0] = { ...ns[0], p: vpos[st.from] };
      ns[ns.length - 1] = { ...ns[ns.length - 1], p: vpos[to] };
      if (!nodes.length) nodes.push(...ns);
      else {
        // the junction: one node, the way in from the last piece, the way out of this one
        const { o: _out, ...last } = nodes[nodes.length - 1];
        nodes[nodes.length - 1] = ns[0].o ? { ...last, o: ns[0].o } : last;
        nodes.push(...ns.slice(1));
      }
    }
    const startV = t[0].from;
    const lastStep = t[t.length - 1];
    const endV = other(lastStep.k, lastStep.from);
    if (startV === endV && nodes.length > 2) {
      // a closed line: its last node is its first
      const end = nodes.pop()!;
      nodes[0] = { ...nodes[0], ...(end.i ? { i: end.i } : {}) };
      return { closed: true, nodes };
    }
    return { closed: false, nodes };
  };
  let lines = trails.map(build);

  // nearest first, each turned to start closest to where the last ended
  const ordered: SubPath[] = [];
  let at: Vec2 | null = lines.length ? lines[0].nodes[0].p : null;
  while (lines.length) {
    let bi = 0;
    let rev = false;
    let bd = Infinity;
    lines.forEach((l, i) => {
      const s = d2(at!, l.nodes[0].p);
      const e = l.closed ? Infinity : d2(at!, l.nodes[l.nodes.length - 1].p);
      if (s < bd) [bd, bi, rev] = [s, i, false];
      if (e < bd) [bd, bi, rev] = [e, i, true];
    });
    const l = rev ? reversePiece(lines[bi]) : lines[bi];
    ordered.push(l);
    at = l.closed ? l.nodes[0].p : l.nodes[l.nodes.length - 1].p;
    lines = lines.filter((_, i) => i !== bi);
  }
  return { paths: [...ordered, ...closed], pieces: total, lines: ordered.length + closed.length, bridged, doubled };
}
