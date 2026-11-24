// Which jumps leave a thread on the fabric. A trim command is only a request:
// Brother and Baby Lock home machines cut a jump only when it is longer than
// their jump stitch trimming length (5 mm by default), some machines have no
// thread cutter at all; and a jump without a trim (Jump after an object, or in
// an imported design) is cut only by a machine that cuts long jumps by itself.
// The jump threads they leave are drawn as thread in every view; the trims left
// uncut are counted as hand trims.

import type { MachineSettings, PlanData } from "../types";
import { FLAG } from "../types";

export type CutterKind = "trims" | "jumps" | "none";

export interface Cutter {
  kind: CutterKind;
  /** "jumps": the machine cuts jumps longer than this (mm). */
  over: number;
}

/** Brother's default jump stitch trimming length (5–50 mm). */
export const DEFAULT_CUT_OVER = 5;

export const cutterOf = (m: Pick<MachineSettings, "cutter" | "cutOver">): Cutter => ({ kind: m.cutter ?? "trims", over: m.cutOver ?? DEFAULT_CUT_OVER });

export interface Uncut {
  /** 1 on every jump record that leaves a thread (and on a trim the machine leaves uncut). */
  mask: Uint8Array;
  /** How many trims you snip by hand. */
  count: number;
  /** Jumps without a trim that leave a thread (not counted in `count`). */
  jumps?: number;
}

const cache = new WeakMap<Uint8Array, { key: string; uncut: Uncut | null }>();
const finishedCache = new WeakMap<PlanData, PlanData>();
/** Plan records outside any object (basting, knockdown). */
const NO_OBJECT = 0xffffffff;

/**
 * The plan as the finished piece shows it: the jump threads you snip by hand
 * are cut and the basting is pulled out. The same record indices (the
 * stitch-out still counts every record); the plan itself when nothing goes.
 */
export function finishedPlan(plan: PlanData): PlanData {
  if (!plan.uncut && !plan.basting) return plan;
  const hit = finishedCache.get(plan);
  if (hit) return hit;
  let hide: Uint8Array | null = null;
  if (plan.basting) {
    const { flags, objects } = plan;
    // the basting, then its tie-off, trim and jump away (no object either)
    let end = Math.min(plan.basting[1], flags.length);
    while (end < flags.length && objects[end] === NO_OBJECT && flags[end] & (FLAG.TIE | FLAG.TRIM)) end++;
    while (end < flags.length && objects[end] === NO_OBJECT && flags[end] & FLAG.JUMP) end++;
    hide = new Uint8Array(flags.length);
    hide.fill(1, plan.basting[0], end);
  }
  const out = { ...plan, uncut: null, hide };
  finishedCache.set(plan, out);
  return out;
}

/**
 * The jump threads left on the fabric: a trim followed by a jump the machine
 * doesn't cut (no cutter, or a jump no longer than its trimming length), and
 * a jump without a trim from a stitch (cut only by a machine that cuts jumps
 * longer than its trimming length, when it is longer). A
 * trim right before a colour change, a stop or the end isn't counted: the
 * thread is cut there with the change. Null when no thread is left.
 */
export function uncutTrims(flags: Uint8Array, coords: Float32Array, cutter: Cutter): Uncut | null {
  const key = `${cutter.kind}:${cutter.over}`;
  const hit = cache.get(flags);
  if (hit && hit.key === key) return hit.uncut;
  const n = flags.length;
  const mask = new Uint8Array(n);
  let count = 0;
  let jumps = 0;
  // a thread runs from the last needle penetration (none before the first stitch, after a cut or a colour change)
  let attached = false;
  for (let i = 0; i < n; i++) {
    const f = flags[i];
    if (f & (FLAG.COLOR_CHANGE | FLAG.END)) {
      attached = false;
      continue;
    }
    if (!(f & FLAG.TRIM)) {
      if (f & FLAG.JUMP && attached) {
        // the run of jump records, from the last penetration to where it lands
        let j = i;
        while (j < n && flags[j] & FLAG.JUMP && !(flags[j] & (FLAG.TRIM | FLAG.COLOR_CHANGE | FLAG.STOP | FLAG.END))) j++;
        const len = Math.hypot(coords[(j - 1) * 2] - coords[(i - 1) * 2], coords[(j - 1) * 2 + 1] - coords[(i - 1) * 2 + 1]);
        if (cutter.kind === "jumps" && len > cutter.over) attached = false;
        else {
          for (let k = i; k < j; k++) mask[k] = 1;
          jumps++;
        }
        i = j - 1;
      } else if (!(f & (FLAG.JUMP | FLAG.STOP))) attached = true;
      continue;
    }
    if (cutter.kind === "trims") {
      attached = false;
      continue;
    }
    // the jump records after the trim, and where they land
    let j = i + 1;
    while (j < n && flags[j] & FLAG.TRIM) j++;
    const first = j;
    while (j < n && flags[j] & FLAG.JUMP && !(flags[j] & (FLAG.COLOR_CHANGE | FLAG.STOP | FLAG.END))) j++;
    if (j === first || (j < n && flags[j] & (FLAG.COLOR_CHANGE | FLAG.STOP | FLAG.END))) {
      attached = false;
      i = j - 1;
      continue;
    }
    const len = Math.hypot(coords[(j - 1) * 2] - coords[i * 2], coords[(j - 1) * 2 + 1] - coords[i * 2 + 1]);
    if (cutter.kind === "none" || len <= cutter.over) {
      for (let k = i; k < j; k++) mask[k] = 1;
      count++;
    } else attached = false;
    i = j - 1;
  }
  const uncut = count || jumps ? { mask, count, jumps } : null;
  cache.set(flags, { key, uncut });
  return uncut;
}
