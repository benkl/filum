// Lines lying on top of each other (Troubleshoot): a stroke imported twice, a
// piece drawn over another, a line that runs back over itself. Sewn twice,
// the thread piles up and the line looks heavier than the rest.
//
// Every line (running stitch, manual stitch, a satin's centre line) is
// sampled every STEP mm; a stretch of at least MIN mm within TOL of an earlier
// line (or of an earlier pass of the same line) is doubled. The later one —
// the one that sews it a second time — is reported, with what to do about it.

import type { DesignObject, SubPath, Vec2 } from "../types";
import { fitPath, flattenSubPath } from "./bezier";
import { resample } from "./connectLines";

const STEP = 0.25;
/** Closer than this: on top of each other (about a thread's width) (mm). */
const TOL = 0.3;
/** Doubled stretches shorter than this are left alone (crossings, joins) (mm). */
const MIN = 2;
/** Along the same line, points closer than this are neighbours, not a second pass (mm). */
const SELF_GAP = 1.5;

/** The objects whose paths are sewn as lines. */
export function isSewnLine(o: DesignObject): boolean {
  if (o.text || !o.visible || o.clone) return false;
  const st = o.stitch;
  if (st.type === "running") return !st.ripple;
  if (st.type === "manual") return true;
  if (st.type === "satin") return !!st.multi || o.paths.filter((sp) => sp.nodes.length >= 2).length === 1;
  return false;
}

interface Sampled {
  /** Per sub-path: points STEP apart, and how far along the sub-path each is. */
  lines: { pts: Vec2[]; along: number[] }[];
}

const sampledCache = new WeakMap<DesignObject, Sampled>();
function sampled(o: DesignObject): Sampled {
  const hit = sampledCache.get(o);
  if (hit) return hit;
  const lines = o.paths
    .filter((sp) => sp.nodes.length >= 2)
    .map((sp) => {
      const raw = flattenSubPath(sp, 0.05);
      const pts = resample(sp.closed ? [...raw, raw[0]] : raw, STEP);
      const along = [0];
      for (let i = 1; i < pts.length; i++) along.push(along[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
      return { pts, along };
    });
  const s = { lines };
  sampledCache.set(o, s);
  return s;
}

export interface LineOverlap {
  id: string;
  /** The earlier line it lies on (null: itself, an earlier pass). */
  other: string | null;
  /** How much of it is doubled (mm), and its share of the line. */
  length: number;
  share: number;
  /** The middle of the longest doubled stretch. */
  at: Vec2;
  /** The object with the doubled stretches cut out (null: nothing would be left). */
  cut: () => DesignObject | null;
}

/** Doubled stretches between lines (in sewing order) and within a line. */
export function lineOverlaps(objects: DesignObject[], opts: { skipSelf?: (o: DesignObject) => boolean } = {}): LineOverlap[] {
  const cell = TOL * 2;
  const grid = new Map<string, { k: number; l: number; i: number; along: number }[]>();
  const key = (x: number, y: number) => `${Math.floor(x / cell)},${Math.floor(y / cell)}`;
  const out: LineOverlap[] = [];
  const lines = objects.map((o, k) => ({ o, k, s: isSewnLine(o) ? sampled(o) : null }));
  for (const { o, k, s } of lines) {
    if (!s) continue;
    const skipSelf = opts.skipSelf?.(o) ?? false;
    const satin = o.stitch.type === "satin";
    // per sample: covered by another line (its index) or by itself
    const byOther = new Map<number, number>();
    let selfLen = 0;
    const covered = s.lines.map((ln) => new Uint8Array(ln.pts.length));
    s.lines.forEach((ln, l) => {
      ln.pts.forEach((p, i) => {
        const cx = Math.floor(p[0] / cell);
        const cy = Math.floor(p[1] / cell);
        let other = -1;
        let self = false;
        for (let dx = -1; dx <= 1 && other < 0; dx++)
          for (let dy = -1; dy <= 1 && other < 0; dy++)
            for (const q of grid.get(`${cx + dx},${cy + dy}`) ?? []) {
              const qp = lines[q.k].s!.lines[q.l].pts[q.i];
              if ((qp[0] - p[0]) ** 2 + (qp[1] - p[1]) ** 2 > TOL * TOL) continue;
              // a running stitch sewn first and covered by a satin is its
              // underpath (Auto-route satins lays them so), not a doubled line
              if (q.k !== k && satin && lines[q.k].o.stitch.type === "running") continue;
              if (q.k !== k) {
                other = q.k;
                break;
              }
              // the same line: an earlier pass, not the stretch just before this point
              if (!skipSelf && (q.l !== l || ln.along[i] - q.along > SELF_GAP)) self = true;
            }
        if (other >= 0) {
          covered[l][i] = 1;
          byOther.set(other, (byOther.get(other) ?? 0) + 1);
        } else if (self) {
          covered[l][i] = 2;
          selfLen += STEP;
        }
        // the point joins the grid as it is sewn: later points (of this line too) see it
        const kk = key(p[0], p[1]);
        const list = grid.get(kk) ?? [];
        list.push({ k, l, i, along: ln.along[i] });
        grid.set(kk, list);
      });
    });
    // doubled stretches: runs of covered points at least MIN long
    let total = 0;
    let doubled = 0;
    let longest = 0;
    let at: Vec2 = [0, 0];
    s.lines.forEach((ln, l) => {
      total += ln.along[ln.along.length - 1] ?? 0;
      let start = -1;
      for (let i = 0; i <= ln.pts.length; i++) {
        const c = i < ln.pts.length && covered[l][i] > 0;
        if (c && start < 0) start = i;
        if (!c && start >= 0) {
          const len = ln.along[i - 1] - ln.along[start];
          if (len >= MIN) {
            doubled += len;
            if (len > longest) [longest, at] = [len, ln.pts[(start + i - 1) >> 1]];
          } else for (let j = start; j < i; j++) covered[l][j] = 0;
          start = -1;
        }
      }
    });
    if (doubled < MIN) continue;
    const best = [...byOther].sort((a, b) => b[1] - a[1])[0];
    const other = best && best[1] * STEP >= selfLen ? lines[best[0]].o.id : null;
    out.push({ id: o.id, other, length: doubled, share: total > 0 ? doubled / total : 0, at, cut: () => cutDoubled(o, s, covered) });
  }
  return out;
}

/** The object without its doubled stretches; each part left a path of its own. */
function cutDoubled(o: DesignObject, s: Sampled, covered: Uint8Array[]): DesignObject | null {
  const paths: SubPath[] = [];
  s.lines.forEach((ln, l) => {
    let part: Vec2[] = [];
    // a part left over shorter than half a millimetre is dropped
    const flush = () => {
      let len = 0;
      for (let i = 1; i < part.length; i++) len += Math.hypot(part[i][0] - part[i - 1][0], part[i][1] - part[i - 1][1]);
      if (part.length >= 2 && len >= 0.5) paths.push(fitPath(part, 0.05, false, 50, 0.6));
      part = [];
    };
    ln.pts.forEach((p, i) => {
      if (covered[l][i]) flush();
      else part.push(p);
    });
    flush();
  });
  return paths.length ? { ...o, paths, start: undefined, end: undefined } : null;
}
