// Lines on top of each other (npm run test:match).

import type { DesignObject, SubPath, Vec2 } from "../types";
import { lineOverlaps } from "./lineOverlaps";

let failed = 0;
const check = (ok: boolean, msg: string) => {
  if (!ok) {
    failed++;
    console.log("FAIL", msg);
  } else console.log("ok  ", msg);
};
const line = (...pts: Vec2[]): SubPath => ({ closed: false, nodes: pts.map((p) => ({ p })) });
const run = (id: string, ...paths: SubPath[]): DesignObject =>
  ({ id, name: id, thread: "t", visible: true, locked: false, paths, stitch: { type: "running", length: 2.5, tolerance: 0.2, repeats: 1, beanRepeats: 0 }, trimAfter: false, stopAfter: false }) as unknown as DesignObject;

// the same stroke twice: the second one is reported, all of it on the first
const twice = lineOverlaps([run("a", line([0, 0], [20, 0])), run("b", line([0, 0.1], [20, 0.1]))]);
check(twice.length === 1 && twice[0].id === "b" && twice[0].other === "a" && twice[0].share > 0.95, "a stroke drawn twice: the second lies wholly on the first");
check(twice[0].cut() === null, "cutting out the doubled part leaves nothing of it");

// half of a line on another: that half is cut out, the rest stays
const half = lineOverlaps([run("a", line([0, 0], [20, 0])), run("b", line([10, 0], [40, 0]))]);
check(half.length === 1 && half[0].id === "b" && Math.abs(half[0].length - 10) < 0.6 && half[0].share < 0.5, "half on another: 10 mm doubled");
const cut = half[0].cut()!;
const xs = cut.paths.flatMap((sp) => sp.nodes.map((n) => n.p[0]));
check(cut.paths.length === 1 && Math.min(...xs) > 19.5 && Math.max(...xs) > 39.9, "the doubled 10 mm cut out, 20…40 mm kept");

// a line that goes back over itself
const back = lineOverlaps([run("a", line([0, 0], [20, 0], [5, 0.05]))]);
check(back.length === 1 && back[0].other === null && back[0].length > 12, "a line back over itself: its second pass");
check(lineOverlaps([run("a", line([0, 0], [20, 0], [5, 0.05]))], { skipSelf: () => true }).length === 0, "an underpath meant that way can be left alone");

// what is not doubled
check(lineOverlaps([run("a", line([0, 0], [20, 20])), run("b", line([0, 20], [20, 0]))]).length === 0, "two crossing lines: not doubled");
check(lineOverlaps([run("a", line([0, 0], [20, 0])), run("b", line([0, 1], [20, 1]))]).length === 0, "parallel lines 1 mm apart: not doubled");
check(lineOverlaps([run("a", line([0, 0], [10, 0])), run("b", line([10, 0], [20, 0]))]).length === 0, "pieces meeting end to end: not doubled");
check(lineOverlaps([run("a", line([0, 0], [10, 0], [10, 10], [0, 10]))]).length === 0, "a line turning corners: not doubled");

console.log(failed ? `${failed} FAILED` : "all passed");
if (failed) throw new Error(`${failed} overlap checks failed`);
