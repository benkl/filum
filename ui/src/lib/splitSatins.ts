// Split into satins: on a fill shape you draw cut lines (where to cut it) and
// direction lines (which way to sew each part); every part becomes a two-rail
// satin whose stitches follow its direction line. Nothing is guessed except
// a part without a direction line: it is sewn across its long side (and the
// tool says so). The parts overlap across each cut by the preset's overlap
// (0.2 mm without one), half on each side, so no gap opens when the fabric
// pulls. After the NOVAstitch Designer fork (effepol/NOVAstitch-designer,
// module m, «Dividi e dirigi»); Ink/Stitch's Fill → satin, with rung objects
// drawn across the shape, stays as it is.
//
// The satin of a part: two rails with as many points, each pair a rung (node
// rungs, Ink/Stitch's convention). The rungs are slices of the part along its
// direction at every corner of its outline, so every stitch has the direction
// line's angle; rails never reversed by the engine (reverseRails "none").

import type { DesignObject, SatinParams, StitchDocument, SubPath, Vec2 } from "../types";
import { presetSetOf, presetValues } from "./fabricPresets";
import { defaultSatin, uid } from "./geometry";
import { withParent } from "./groups";
import { pruneGroups } from "./layerRows";
import { cutParts, insideRegion, regionRings, regionsOf, ringPoints, type Line, type Region } from "./regions";
import { add, cross, dot, len, mul, norm as unit, sub } from "./vec";

export type { Line } from "./regions";

/** What the tool collects on one shape. */
export interface SplitInput {
  /** The fill to split. */
  id: string;
  /** Cut lines, each a segment, applied in order. */
  cuts: Line[];
  /** Direction lines: each sets the stitch direction of the part it lies in. */
  directions: Line[];
}

/** A part as the preview draws it. */
export interface SplitPart {
  outline: Vec2[][];
  /** Rail 1 and rail 2: point k of each make a rung (the stitch direction there). */
  rails: [Vec2[], Vec2[]];
  /** No direction line in it: sewn across its long side. */
  auto: boolean;
  /** The direction meets the outline more than twice somewhere: sewn along the longest stretch only. */
  notOneColumn: boolean;
}

export interface SplitPlan {
  parts: SplitPart[];
  /** Overlap used at the cuts (mm). */
  overlap: number;
}


/** Overlap between neighbouring parts: the fabric preset's (NOVAstitch), else 0.2 mm. */
export function overlapFor(doc: Pick<StitchDocument, "options" | "fabric">): number {
  const v = presetValues(presetSetOf(doc), doc.fabric, { type: "fill", method: "tatami" } as DesignObject["stitch"]).expand;
  return typeof v === "number" && v > 0 ? v : 0.2;
}

/** Stitch direction across the part's long side: the narrowest box around it (rotating calipers on the hull). */
function autoDirection(g: Region): Vec2 {
  const P = [...ringPoints(g.outer)].sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  const half = (list: Vec2[]) => {
    const h: Vec2[] = [];
    for (const p of list) {
      while (h.length >= 2 && cross(sub(h[h.length - 1], h[h.length - 2]), sub(p, h[h.length - 2])) <= 0) h.pop();
      h.push(p);
    }
    h.pop();
    return h;
  };
  const hull = [...half(P), ...half([...P].reverse())];
  let best = { area: Infinity, long: [1, 0] as Vec2 };
  for (let i = 0; i < hull.length; i++) {
    const e = unit(sub(hull[(i + 1) % hull.length], hull[i]));
    if (!e[0] && !e[1]) continue;
    const nrm: Vec2 = [-e[1], e[0]];
    const us = hull.map((p) => dot(p, e));
    const vs = hull.map((p) => dot(p, nrm));
    const du = Math.max(...us) - Math.min(...us);
    const dv = Math.max(...vs) - Math.min(...vs);
    if (du * dv < best.area - 1e-9) best = { area: du * dv, long: du >= dv ? e : nrm };
  }
  return [-best.long[1], best.long[0]];
}

/** The part a direction line belongs to: the one holding most of it. */
function partOfLine(parts: Region[], l: Line): number {
  let best = -1;
  let most = 0;
  parts.forEach((g, k) => {
    let n = 0;
    for (let i = 0; i <= 20; i++) if (insideRegion(g, add(l[0], mul(sub(l[1], l[0]), i / 20)))) n++;
    if (n > most) {
      most = n;
      best = k;
    }
  });
  return best;
}

const EPS = 1e-7;

/**
 * Rails of a part sewn along `dir`: slices of the part parallel to it at
 * every corner of its outline (a hair before and after, so a step in the
 * outline keeps the rails on it); rail 1 the start of each slice, rail 2 its
 * end. Slices on a straight stretch of both rails are dropped.
 */
function railsOf(g: Region, dir: Vec2): { rails: [Vec2[], Vec2[]]; oneColumn: boolean } | null {
  const d = unit(dir);
  const u: Vec2 = [-d[1], d[0]];
  const rings = regionRings(g);
  const ss = [...new Set(rings.flat().map((p) => dot(p, u)))].sort((x, y) => x - y);
  const s0 = ss[0];
  const s1 = ss[ss.length - 1];
  if (!(s1 - s0 > 1e-6)) return null;
  const at: number[] = [];
  for (const s of ss) {
    if (s > s0) at.push(s - EPS);
    if (s < s1) at.push(s + EPS);
  }
  let oneColumn = true;
  const left: Vec2[] = [];
  const right: Vec2[] = [];
  for (const s of at) {
    const vs: number[] = [];
    for (const r of rings)
      for (let i = 0; i < r.length; i++) {
        const p = r[i];
        const q = r[(i + 1) % r.length];
        const [ps, qs] = [dot(p, u), dot(q, u)];
        if ((ps <= s && s < qs) || (qs <= s && s < ps)) {
          const t = (s - ps) / (qs - ps);
          vs.push(dot(add(p, mul(sub(q, p), t)), d));
        }
      }
    vs.sort((x, y) => x - y);
    let spans: [number, number][] = [];
    for (let k = 0; k + 1 < vs.length; k += 2) spans.push([vs[k], vs[k + 1]]);
    const real = spans.filter(([x, y]) => y - x > 1e-6);
    if (real.length > 1) oneColumn = false;
    if (real.length) spans = real;
    if (!spans.length) continue;
    const [v0, v1] = spans.reduce((m, x) => (x[1] - x[0] > m[1] - m[0] ? x : m));
    left.push(add(mul(u, s), mul(d, v0)));
    right.push(add(mul(u, s), mul(d, v1)));
  }
  const offLine = (p: Vec2, a: Vec2, b: Vec2) => {
    const e = sub(b, a);
    const l = len(e);
    return l < 1e-12 ? len(sub(p, a)) : Math.abs(cross(e, sub(p, a))) / l;
  };
  for (let k = 1; k < left.length - 1; ) {
    if (offLine(left[k], left[k - 1], left[k + 1]) < 1e-5 && offLine(right[k], right[k - 1], right[k + 1]) < 1e-5) {
      left.splice(k, 1);
      right.splice(k, 1);
    } else k++;
  }
  if (left.length < 2) return null;
  return { rails: [left, right], oneColumn };
}

/** The parts the lines make of the shape, each with its rails (null: no closed shape there). */
export function planSplit(doc: Pick<StitchDocument, "objects" | "options" | "fabric">, input: SplitInput): SplitPlan | null {
  const o = doc.objects.find((x) => x.id === input.id);
  if (!o || o.text) return null;
  let parts = regionsOf(o);
  if (!parts.length) return null;
  const overlap = overlapFor(doc);
  for (const cut of input.cuts) parts = cutParts(parts, cut, overlap);
  const dirs: (Line | null)[] = parts.map(() => null);
  for (const l of input.directions) {
    if (!(len(sub(l[1], l[0])) > 1e-9)) continue;
    const k = partOfLine(parts, l);
    if (k >= 0 && !dirs[k]) dirs[k] = l;
  }
  const out: SplitPart[] = [];
  parts.forEach((g, k) => {
    const l = dirs[k];
    const r = railsOf(g, l ? sub(l[1], l[0]) : autoDirection(g));
    if (r) out.push({ outline: regionRings(g), rails: r.rails, auto: !l, notOneColumn: !r.oneColumn });
  });
  return out.length ? { parts: out, overlap } : null;
}

const path = (p: Vec2[]): SubPath => ({ closed: false, nodes: p.map((q) => ({ p: q })) });

/** The document with the shape replaced by its satins (in its place in the sewing order), and their ids. */
export function applySplit(doc: StitchDocument, input: SplitInput): { doc: StitchDocument; made: string[]; plan: SplitPlan } | null {
  const o = doc.objects.find((x) => x.id === input.id);
  const plan = planSplit(doc, input);
  if (!o || !plan) return null;
  const base = { type: "satin", ...defaultSatin(), multi: false, guides: undefined, reverseRails: "none" } as SatinParams & { type: "satin" };
  const several = plan.parts.length > 1;
  const group = several ? uid("g") : undefined;
  const made: DesignObject[] = plan.parts.map((p, k) => ({
    id: uid(),
    name: several ? `${o.name} ${k + 1}` : o.name,
    thread: o.thread,
    visible: o.visible,
    locked: false,
    paths: [path(p.rails[0]), path(p.rails[1])],
    stitch: { ...base },
    trimAfter: false,
    stopAfter: false,
    ...(group ? { group } : o.group ? { group: o.group } : {}),
  }));
  // what came after the shape comes after the last satin
  const last = made[made.length - 1];
  made[made.length - 1] = { ...last, trimAfter: o.trimAfter, stopAfter: o.stopAfter, ...(o.link ? { link: o.link } : {}) };
  let out: StitchDocument = { ...doc, objects: doc.objects.flatMap((x) => (x.id === o.id ? made : [x])) };
  if (group && o.group) out = { ...out, groupParents: withParent(out.groupParents, group, o.group) };
  return { doc: pruneGroups(out), made: made.map((m) => m.id), plan };
}
