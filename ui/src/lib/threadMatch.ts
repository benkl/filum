// Thread colour matching: which spool each design thread gets when it is
// fitted to a chart or to My threads.
//
// Every option is a term of one cost, solved in three steps:
//  1. a cost per thread and spool — CIEDE2000 with weights for lightness,
//     chroma (saturation) and hue, the original colour boosted in saturation,
//     and penalties for spools close to the fabric, not owned or of another
//     brand;
//  2. a spool budget (the best N spools for the whole design) and an initial
//     assignment — nearest spool, or one spool per colour (Hungarian method);
//  3. a local search over each thread's best candidates that keeps fitted
//     colours apart (minimum separation), keeps their light-to-dark order and
//     the contrast between neighbouring colours. Locked threads keep their
//     spool and are respected by the others.

import { deltaE, lab, type Lab } from "./colorMath";
import type { ChartEntry } from "./threads";

export type MatchPreset = "faithful" | "hue" | "vivid" | "distinct" | "few" | "custom";

export interface MatchOptions {
  preset: MatchPreset;
  /** Importance of lightness, chroma (saturation) and hue (1 = CIEDE2000). */
  weights: { l: number; c: number; h: number };
  /** Boost the saturation of the original colours before matching (0..0.6). */
  saturationBias: number;
  /** Avoid spools within \`fabricMinDelta\` of the fabric colour. */
  fabricAware: boolean;
  fabricMinDelta: number;
  /** Different colours get different spools (when there are enough). */
  unique: boolean;
  /** Fitted colours stay at least this far apart (ΔE, 0 = off). */
  minSeparation: number;
  /** Keep the light-to-dark order of the colours. */
  keepLightOrder: boolean;
  /** Keep the contrast between colours that touch in the design. */
  keepContrast: boolean;
  /** Use at most this many spools (0 = no limit). */
  budget: number;
  /** Prefer spools in My threads (charts as target). */
  preferOwned: boolean;
  /** Prefer this brand ("" = any). */
  preferBrand: string;
}

export const DEFAULT_MATCH: MatchOptions = {
  preset: "faithful",
  weights: { l: 1, c: 1, h: 1 },
  saturationBias: 0,
  fabricAware: true,
  fabricMinDelta: 8,
  unique: false,
  minSeparation: 0,
  keepLightOrder: false,
  keepContrast: false,
  budget: 0,
  preferOwned: false,
  preferBrand: "",
};

export const MATCH_PRESETS: { id: Exclude<MatchPreset, "custom">; label: string; hint: string; opts: Partial<MatchOptions> }[] = [
  { id: "faithful", label: "Faithful", hint: "The closest spool for every colour (CIEDE2000)", opts: { weights: { l: 1, c: 1, h: 1 }, saturationBias: 0, unique: false, minSeparation: 0, keepLightOrder: false, keepContrast: false, budget: 0 } },
  { id: "hue", label: "Keep hue", hint: "Hue shifts cost most: orange stays orange, it may get lighter or darker instead", opts: { weights: { l: 0.7, c: 1, h: 2.2 }, saturationBias: 0, unique: false, minSeparation: 0, budget: 0 } },
  { id: "vivid", label: "Vivid", hint: "Keeps colours saturated: thread on fabric reads duller than a screen", opts: { weights: { l: 0.8, c: 1.8, h: 1.4 }, saturationBias: 0.25, unique: false, budget: 0 } },
  { id: "distinct", label: "Distinct", hint: "Every colour its own spool, kept apart, light-to-dark order and contrast kept", opts: { weights: { l: 1, c: 1, h: 1 }, saturationBias: 0, unique: true, minSeparation: 8, keepLightOrder: true, keepContrast: true, budget: 0 } },
  { id: "few", label: "Few spools", hint: "The best 6 spools for the whole design — fewer colour changes", opts: { weights: { l: 1, c: 1, h: 1 }, saturationBias: 0, unique: false, minSeparation: 0, keepLightOrder: true, keepContrast: false, budget: 6 } },
];

/** Lightness, chroma and hue (degrees) of a Lab colour. */
export function lch([L, a, b]: Lab): [number, number, number] {
  const h = (Math.atan2(b, a) * 180) / Math.PI;
  return [L, Math.hypot(a, b), h < 0 ? h + 360 : h];
}

/** Signed hue difference b − a in degrees (−180..180). */
export function hueShift(a: Lab, b: Lab): number {
  let d = lch(b)[2] - lch(a)[2];
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}

function boostChroma([L, a, b]: Lab, k: number): Lab {
  return [L, a * (1 + k), b * (1 + k)];
}

export const quality = (d: number): "good" | "fair" | "poor" => (d < 3 ? "good" : d < 6 ? "fair" : "poor");

export interface MatchThread {
  id: string;
  /** The colour wanted (the thread's original, before any fit). */
  need: string;
  /** Importance (e.g. share of stitches). */
  weight: number;
  /** Locked: this spool stays (index into the candidates, or null to keep it unchanged). */
  locked?: boolean;
  /** The current colour (for locked threads that are not a candidate). */
  current?: ChartEntry;
}

export interface MatchContext {
  fabric?: string;
  /** Pairs of thread ids that touch in the design. */
  neighbours?: [string, string][];
  /** Spool keys in My threads (for preferOwned). */
  owned?: Set<string>;
  ownedKey?: (e: ChartEntry) => string;
  brandOf?: (e: ChartEntry) => string;
}

export interface MatchCandidate {
  entry: ChartEntry;
  /** Option-aware cost. */
  cost: number;
  /** Plain CIEDE2000 between the original colour and the spool. */
  d: number;
  hue: number;
  /** Relative chroma change (−1..). */
  chroma: number;
  lightness: number;
}

export interface MatchResult {
  /** The chosen spool per thread id. */
  pick: Map<string, MatchCandidate>;
  /** Threads with different original colours that ended up on the same spool. */
  shared: { a: string; b: string; d: number }[];
}

const SAME_NEED = 1.0; // ΔE: needs this close are one colour

function metrics(need: Lab, e: ChartEntry, cost: number): MatchCandidate {
  const n = lch(need);
  const s = lch(e.lab);
  return { entry: e, cost, d: deltaE(need, e.lab), hue: hueShift(need, e.lab), chroma: n[1] > 1 ? s[1] / n[1] - 1 : 0, lightness: s[0] - n[0] };
}

/** Candidates for one colour, best first. */
export function rankCandidates(need: string, entries: ChartEntry[], opts: MatchOptions, ctx: MatchContext = {}, n = 5): MatchCandidate[] {
  const cost = costFn(opts, ctx);
  const L = lab(need);
  return entries
    .map((e) => metrics(L, e, cost(L, e)))
    .sort((a, b) => a.cost - b.cost)
    .slice(0, n);
}

function costFn(opts: MatchOptions, ctx: MatchContext) {
  const w = opts.weights;
  const [kL, kC, kH] = [1 / Math.max(0.1, w.l), 1 / Math.max(0.1, w.c), 1 / Math.max(0.1, w.h)];
  const fabric = opts.fabricAware && ctx.fabric ? lab(ctx.fabric) : null;
  return (need: Lab, e: ChartEntry) => {
    const target = opts.saturationBias > 0 ? boostChroma(need, opts.saturationBias) : need;
    let c = deltaE(target, e.lab, kL, kC, kH);
    if (fabric) {
      const df = deltaE(fabric, e.lab);
      if (df < opts.fabricMinDelta) c += (opts.fabricMinDelta - df) * 3;
    }
    if (opts.preferOwned && ctx.owned && ctx.ownedKey && !ctx.owned.has(ctx.ownedKey(e))) c += 4;
    if (opts.preferBrand && ctx.brandOf && ctx.brandOf(e) !== opts.preferBrand) c += 4;
    return c;
  };
}

/** Rectangular Hungarian method: rows ≤ columns, minimise the total cost. Returns the column per row. */
function hungarian(cost: number[][]): number[] {
  const n = cost.length;
  const m = cost[0]?.length ?? 0;
  if (!n || !m) return [];
  const INF = 1e18;
  const u = new Array(n + 1).fill(0);
  const v = new Array(m + 1).fill(0);
  const p = new Array(m + 1).fill(0);
  const way = new Array(m + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array(m + 1).fill(INF);
    const used = new Array(m + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0];
      let delta = INF;
      let j1 = 0;
      for (let j = 1; j <= m; j++) {
        if (used[j]) continue;
        const cur = cost[i0 - 1][j - 1] - u[i0] - v[j];
        if (cur < minv[j]) {
          minv[j] = cur;
          way[j] = j0;
        }
        if (minv[j] < delta) {
          delta = minv[j];
          j1 = j;
        }
      }
      for (let j = 0; j <= m; j++) {
        if (used[j]) {
          u[p[j]] += delta;
          v[j] -= delta;
        } else minv[j] -= delta;
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while (j0);
  }
  const out = new Array(n).fill(-1);
  for (let j = 1; j <= m; j++) if (p[j]) out[p[j] - 1] = j - 1;
  return out;
}

/** Fit threads to candidate spools with all options. */
export function solveMatch(threads: MatchThread[], entries: ChartEntry[], opts: MatchOptions, ctx: MatchContext = {}): MatchResult {
  const pick = new Map<string, MatchCandidate>();
  if (!threads.length || !entries.length) return { pick, shared: [] };
  const cost = costFn(opts, ctx);
  // colours: threads with (almost) the same original colour are one colour
  const needs = threads.map((t) => lab(t.need));
  const group: number[] = [];
  const reps: number[] = [];
  threads.forEach((_, i) => {
    const g = reps.findIndex((r) => deltaE(needs[r], needs[i]) < SAME_NEED);
    if (g >= 0) group.push(g);
    else {
      group.push(reps.length);
      reps.push(i);
    }
  });
  const G = reps.length;
  const gWeight = new Array(G).fill(0);
  threads.forEach((t, i) => (gWeight[group[i]] += Math.max(0.05, t.weight)));
  // relative importance (mean 1), so colour costs and constraint penalties compare
  const meanW = gWeight.reduce((a, b) => a + b, 0) / G;
  for (let g = 0; g < G; g++) gWeight[g] /= meanW;
  // locked colours keep their spool
  const lockedSpool: (ChartEntry | null)[] = new Array(G).fill(null);
  threads.forEach((t, i) => {
    if (t.locked && t.current) lockedSpool[group[i]] = t.current;
  });

  // per colour: the candidate costs (all spools, then the best K)
  const K = Math.min(entries.length, 40);
  const costs: number[][] = reps.map((r) => entries.map((e) => cost(needs[r], e)));
  const top: number[][] = costs.map((row) =>
    row
      .map((c, j) => [c, j] as const)
      .sort((a, b) => a[0] - b[0])
      .slice(0, K)
      .map((x) => x[1]),
  );

  // 2a. budget: the best N spools for the whole design (greedy, then swaps)
  let allowed: Set<number> | null = null;
  const lockedIdx = new Set<number>();
  lockedSpool.forEach((s) => {
    if (s) {
      const j = entries.findIndex((e) => e.color === s.color && e.code === s.code && e.brand === s.brand);
      if (j >= 0) lockedIdx.add(j);
    }
  });
  if (opts.budget > 0 && opts.budget < G) {
    const pool = [...new Set(top.flatMap((t) => t.slice(0, 15)))];
    const totalWith = (set: number[]) =>
      reps.reduce((a, _, g) => a + (lockedSpool[g] ? 0 : gWeight[g] * Math.min(...set.map((j) => costs[g][j]))), 0);
    const chosen: number[] = [...lockedIdx];
    while (chosen.length < opts.budget) {
      let best = -1;
      let bestTotal = Infinity;
      for (const j of pool) {
        if (chosen.includes(j)) continue;
        const t = totalWith([...chosen, j]);
        if (t < bestTotal) {
          bestTotal = t;
          best = j;
        }
      }
      if (best < 0) break;
      chosen.push(best);
    }
    // swap improvements
    for (let pass = 0; pass < 3; pass++) {
      let improved = false;
      for (let k = 0; k < chosen.length; k++) {
        if (lockedIdx.has(chosen[k])) continue;
        let cur = totalWith(chosen);
        for (const j of pool) {
          if (chosen.includes(j)) continue;
          const trial = [...chosen];
          trial[k] = j;
          const t = totalWith(trial);
          if (t < cur - 1e-9) {
            cur = t;
            chosen[k] = j;
            improved = true;
          }
        }
      }
      if (!improved) break;
    }
    allowed = new Set(chosen);
  }
  const cands = (g: number) => (allowed ? [...allowed] : top[g]);

  // 2b. initial assignment
  const assign: number[] = new Array(G).fill(-1);
  const free = reps.map((_, g) => g).filter((g) => !lockedSpool[g]);
  if (opts.unique && (!allowed || allowed.size >= G)) {
    const cols = [...new Set(free.flatMap((g) => cands(g)))].filter((j) => !lockedIdx.has(j));
    if (cols.length >= free.length) {
      const sol = hungarian(free.map((g) => cols.map((j) => costs[g][j] * gWeight[g])));
      free.forEach((g, k) => (assign[g] = cols[sol[k]] ?? -1));
    }
  }
  for (const g of free) {
    if (assign[g] >= 0) continue;
    let best = -1;
    for (const j of cands(g)) if (best < 0 || costs[g][j] < costs[g][best]) best = j;
    assign[g] = best;
  }

  // 3. local search with the design-wide constraints
  const spoolLab = (g: number): Lab => (lockedSpool[g] ? lockedSpool[g]!.lab : entries[assign[g]].lab);
  const neighbourPairs: [number, number][] = [];
  if (opts.keepContrast && ctx.neighbours) {
    const gid = new Map(threads.map((t, i) => [t.id, group[i]]));
    for (const [a, b] of ctx.neighbours) {
      const ga = gid.get(a);
      const gb = gid.get(b);
      if (ga !== undefined && gb !== undefined && ga !== gb) neighbourPairs.push([Math.min(ga, gb), Math.max(ga, gb)]);
    }
  }
  // constraint penalties: distinct spools, separation and light order are
  // rules (they beat any colour difference), neighbour contrast is a preference
  const pairPenalty = (g: number, k: number, sg: Lab, sk: Lab, spoolSame: boolean): number => {
    let p = 0;
    const dn = deltaE(needs[reps[g]], needs[reps[k]]);
    if (opts.unique && spoolSame) p += 1000;
    if (opts.minSeparation > 0 && dn >= opts.minSeparation) {
      const ds = spoolSame ? 0 : deltaE(sg, sk);
      if (ds < opts.minSeparation) p += (opts.minSeparation - ds) * 25;
    }
    if (opts.keepLightOrder) {
      const [ln, lk] = [needs[reps[g]][0], needs[reps[k]][0]];
      if (ln + 4 < lk && sg[0] > sk[0] + 1) p += 40;
      if (lk + 4 < ln && sk[0] > sg[0] + 1) p += 40;
    }
    return p;
  };
  const sameSpool = (a: ChartEntry, b: ChartEntry) => a.color === b.color && a.code === b.code && a.brand === b.brand;
  const isNeighbour = (g: number, k: number) => neighbourPairs.some(([a, b]) => (a === Math.min(g, k) && b === Math.max(g, k)));
  const local = (g: number, j: number): number => {
    const sg = entries[j].lab;
    let c = costs[g][j] * gWeight[g];
    for (let k = 0; k < G; k++) {
      if (k === g) continue;
      const sk = spoolLab(k);
      const same = lockedSpool[k] ? sameSpool(lockedSpool[k]!, entries[j]) : assign[k] === j;
      c += pairPenalty(g, k, sg, sk, same);
      if (isNeighbour(g, k)) c += 2 * Math.max(0, deltaE(needs[reps[g]], needs[reps[k]]) * 0.7 - (same ? 0 : deltaE(sg, sk)));
    }
    return c;
  };
  const constrained = opts.unique || opts.minSeparation > 0 || opts.keepLightOrder || neighbourPairs.length > 0;
  if (constrained) {
    for (let pass = 0; pass < 8; pass++) {
      let moved = false;
      for (const g of free) {
        const options = allowed ? [...allowed] : top[g].slice(0, 15);
        let best = assign[g];
        let bestCost = local(g, best);
        for (const j of options) {
          if (j === best) continue;
          const c = local(g, j);
          if (c < bestCost - 1e-6) {
            bestCost = c;
            best = j;
          }
        }
        if (best !== assign[g]) {
          assign[g] = best;
          moved = true;
        }
      }
      if (!moved) break;
    }
  }

  // results
  threads.forEach((t, i) => {
    const g = group[i];
    const e = lockedSpool[g] ?? entries[assign[g]];
    if (e) pick.set(t.id, metrics(needs[i], e, lockedSpool[g] ? 0 : costs[g][assign[g]]));
  });
  const shared: MatchResult["shared"] = [];
  for (let a = 0; a < threads.length; a++)
    for (let b = a + 1; b < threads.length; b++) {
      if (group[a] === group[b]) continue;
      const pa = pick.get(threads[a].id)?.entry;
      const pb = pick.get(threads[b].id)?.entry;
      if (pa && pb && pa.color === pb.color && pa.code === pb.code && pa.brand === pb.brand) shared.push({ a: threads[a].id, b: threads[b].id, d: deltaE(needs[a], needs[b]) });
    }
  return { pick, shared };
}
