// Where a stitch plan's needle goes down: the box around its stitches.

import type { Box } from "./geometry";
import { FLAG, type PlanData } from "../types";

/** The box (mm) around the plan's needle penetrations, only records `keep` accepts when given; null without any. */
export function planBounds(plan: PlanData, keep?: (i: number) => boolean): Box | null {
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (let i = 0; i < plan.flags.length; i++) {
    if (plan.flags[i] & FLAG.COMMANDS || (keep && !keep(i))) continue;
    const x = plan.coords[2 * i];
    const y = plan.coords[2 * i + 1];
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  return x1 >= x0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}
