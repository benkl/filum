// Satin rails (npm run test:match): the UI picks the same rails as the
// engine and Ink/Stitch — a rung crosses two paths, a rail one (with one rung).

import { satinRailIndices } from "./geometry";
import type { SubPath, Vec2 } from "../types";

let failed = 0;
const check = (ok: boolean, msg: string) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${msg}`);
  if (!ok) failed++;
};
const line = (a: Vec2, b: Vec2): SubPath => ({ closed: false, nodes: [{ p: a }, { p: b }] });

// Barstitch's "t" crossbar: short rails, a longer rung (listed first here)
const bar = [line([9.55, 15], [9.55, 21.88]), line([11.88, 16.4], [7.37, 16.35]), line([11.88, 20.37], [7.48, 20.37])];
check(satinRailIndices(bar)?.join() === "1,2", "a rung longer than the rails stays a rung");
// "#": two rails, two rungs → the longest
const hash = [line([5, -1], [5, 5]), line([0, 0], [20, 0]), line([15, -1], [15, 5]), line([0, 4], [20, 4])];
check(satinRailIndices(hash)?.join() === "1,3", "a # takes the longest as rails");
// many rungs: the rails cross more than two paths
const ladder = [line([0, 0], [10, 0]), line([2, -1], [2, 3]), line([0, 2], [10, 2]), line([5, -1], [5, 3]), line([8, -1], [8, 3])];
check(satinRailIndices(ladder)?.join() === "0,2", "a ladder's rails cross every rung");
check(satinRailIndices([line([0, 0], [1, 0]), line([0, 1], [1, 1])])?.join() === "0,1", "two paths are the rails");
check(satinRailIndices([line([0, 0], [1, 0])]) === null, "one path: a centre line, no rails");

if (failed) throw new Error(`${failed} satin rail check(s) failed`);
