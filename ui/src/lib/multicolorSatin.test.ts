// Multicolour satin (npm run test:match).

import { splitSatin } from "./multicolorSatin";
import type { DesignObject } from "../types";

let failed = 0;
const check = (ok: boolean, msg: string) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${msg}`);
  if (!ok) failed++;
};
const sat = {
  id: "s", name: "S", thread: "a", visible: true, locked: false, trimAfter: false, stopAfter: false,
  paths: [{ closed: false, nodes: [{ p: [0, 0] }, { p: [30, 0] }] }],
  stitch: { type: "satin", width: 6, centerWalk: true, contourUnderlay: true, zigzagUnderlay: false, swapRails: false },
} as unknown as DesignObject;
const parts = splitSatin(sat, [{ thread: "a", width: 1 }, { thread: "b", width: 2 }], 0)!;
check(parts.length === 2, "two stripes");
const ys = (o: DesignObject) => o.paths.map((sp) => sp.nodes[0].p[1]).sort((x, y) => x - y);
const [a, b] = parts.map(ys);
// 6 mm wide from y = -3 to 3: one third, then two thirds
check(Math.abs(a[0] + 3) < 0.05 && Math.abs(a[1] + 1) < 0.05, `stripe 1: ${a}`);
check(Math.abs(b[0] + 1) < 0.05 && Math.abs(b[1] - 3) < 0.05, `stripe 2: ${b}`);
check(parts[1].thread === "b", "stripe 2 in its own thread");
const st1 = parts[1].stitch as unknown as Record<string, unknown>;
check(st1.centerWalk === false && st1.contourUnderlay === false, "only the first stripe has underlay");
const withOverlap = splitSatin(sat, [{ thread: "a", width: 1 }, { thread: "b", width: 1 }], 0.3)!;
check(ys(withOverlap[0])[1] > 0.2 && ys(withOverlap[1])[0] < -0.2, "the stripes overlap");

console.log(failed ? `${failed} FAILED` : "all passed");
if (failed) throw new Error(`${failed} multicolour satin checks failed`);
