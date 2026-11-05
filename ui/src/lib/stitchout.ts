// The stitch-out timeline: where each colour block starts and ends in the
// stitch plan, the trims and stops inside it, and the machine clock at every
// record (the same time model as the engine's plan stats).

import { FLAG, type PlanData } from "../types";

export interface TimelineBlock {
  /** Colour block (index into plan.threads). */
  index: number;
  /** First record of the block. */
  start: number;
  /** One past its last record (the colour change record, or the plan end). */
  end: number;
  /** Real stitches (no jumps or commands). */
  stitches: number;
  /** Records where the thread is cut inside the block. */
  trims: number[];
  /** Records where the machine pauses inside the block. */
  stops: number[];
  /** How the block ends: a colour change, a stop, or the end of the design. */
  ending: "color" | "stop" | "end";
}

export interface Timeline {
  total: number;
  blocks: TimelineBlock[];
  /** Real stitches sewn up to (not including) record i; length total + 1. */
  stitchAt: Uint32Array;
  /** Machine seconds up to (not including) record i; length total + 1. */
  secondsAt: Float64Array;
}

export interface MachineTimes {
  spm: number;
  trimSeconds: number;
  colorChangeSeconds: number;
}

/** Seconds a jump takes (the engine's plan stats). */
const JUMP_S = 0.05;

export function buildTimeline(plan: Pick<PlanData, "flags">, m: MachineTimes): Timeline {
  const { flags } = plan;
  const n = flags.length;
  const stitchAt = new Uint32Array(n + 1);
  const secondsAt = new Float64Array(n + 1);
  const perStitch = 60 / Math.max(1, m.spm);
  const blocks: TimelineBlock[] = [];
  let cur: TimelineBlock = { index: 0, start: 0, end: n, stitches: 0, trims: [], stops: [], ending: "end" };
  let st = 0;
  let sec = 0;
  for (let i = 0; i < n; i++) {
    const f = flags[i];
    stitchAt[i] = st;
    secondsAt[i] = sec;
    if (f & FLAG.COLOR_CHANGE) {
      sec += m.colorChangeSeconds;
      cur.end = i + 1;
      cur.ending = "color";
      // a stop just before the change is the change's own pause
      if (cur.stops.length && cur.stops[cur.stops.length - 1] >= i - 1) cur.stops.pop();
      blocks.push(cur);
      cur = { index: cur.index + 1, start: i + 1, end: n, stitches: 0, trims: [], stops: [], ending: "end" };
      continue;
    }
    if (f & FLAG.TRIM) {
      sec += m.trimSeconds;
      cur.trims.push(i);
    } else if (f & FLAG.STOP) cur.stops.push(i);
    else if (f & FLAG.END) continue;
    else if (f & FLAG.JUMP) sec += JUMP_S;
    else {
      st++;
      cur.stitches++;
      sec += perStitch;
    }
  }
  stitchAt[n] = st;
  secondsAt[n] = sec;
  if (cur.start < n || !blocks.length) {
    cur.end = n;
    // a stop on the last record ends the design with a pause
    if (cur.stops.length && cur.stops[cur.stops.length - 1] >= n - 2) {
      cur.stops.pop();
      cur.ending = "stop";
    }
    blocks.push(cur);
  }
  // a trim right before a colour change is part of the change
  for (const b of blocks) if (b.ending !== "end") b.trims = b.trims.filter((t) => t < b.end - 2);
  return { total: n, blocks, stitchAt, secondsAt };
}

/** The block a record belongs to (the last one at the end). */
export function blockAt(tl: Timeline, i: number): number {
  const bs = tl.blocks;
  let lo = 0;
  let hi = bs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (bs[mid].start <= i) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Tick spacing for a ruler: 1, 2 or 5 × 10ⁿ with at least `minGap` px between ticks. */
export function tickStep(total: number, width: number, minGap = 70): number {
  if (total <= 0 || width <= 0) return 1;
  const raw = (total * minGap) / width;
  const p = 10 ** Math.floor(Math.log10(Math.max(1, raw)));
  for (const m of [1, 2, 5, 10]) if (m * p >= raw) return m * p;
  return 10 * p;
}

/** Playback speeds: stitches per second; 0 sews the whole design in about twelve seconds. */
export const SPEEDS = [0, 50, 100, 200, 500, 1000, 2000, 5000];

export const speedLabel = (v: number) => (v === 0 ? "Auto" : `${v.toLocaleString()}/s`);

/** Stitches per second for a speed setting and a plan of `total` records. */
export const playRate = (speed: number, total: number) => (speed > 0 ? speed : Math.max(300, total / 12));
