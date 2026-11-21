// Split into satins: parts from cut lines, stitch direction from direction lines (npm run test:match).

import type { DesignObject, StitchDocument, SubPath, Vec2 } from "../types";
import { applySplit, overlapFor, planSplit } from "./splitSatins";

let failed = 0;
const check = (ok: boolean, msg: string) => {
  if (!ok) {
    failed++;
    console.log("FAIL", msg);
  } else console.log("ok  ", msg);
};
const near = (a: number, b: number, e = 1e-6) => Math.abs(a - b) < e;
const ring = (pts: Vec2[]): SubPath => ({ closed: true, nodes: pts.map((p) => ({ p })) });
const obj = (id: string, paths: SubPath[], extra: Partial<DesignObject> = {}): DesignObject =>
  ({ id, name: id, thread: "t", visible: true, locked: false, paths, stitch: { type: "fill" }, trimAfter: false, stopAfter: false, ...extra }) as unknown as DesignObject;
// an L: a bar 4 wide going down (x 0..4, y 0..20) and a foot going right (y 16..20, x 0..20)
const L = obj("L", [ring([[0, 0], [4, 0], [4, 16], [20, 16], [20, 20], [0, 20]])], { trimAfter: true });
const doc = (o: DesignObject[], options?: StitchDocument["options"]) => ({ objects: o, fabric: "cotton", options }) as unknown as StitchDocument;
const angleOf = (r: [Vec2[], Vec2[]], k: number) => {
  const [a, b] = [r[0][k], r[1][k]];
  return Math.abs(Math.atan2(b[1] - a[1], b[0] - a[0]) * (180 / Math.PI)) % 180;
};

// cut across the bar just above the foot; bar sewn across (horizontal), foot sewn up and down
const input = { id: "L", cuts: [[[-1, 15], [5, 15]]] as [Vec2, Vec2][], directions: [[[0.5, 8], [3.5, 8]], [[12, 16.5], [12, 19.5]]] as [Vec2, Vec2][] };
const plan = planSplit(doc([L]), input)!;
check(!!plan && plan.parts.length === 2, "one cut: two parts");
check(near(plan.overlap, 0.2), "no preset: 0.2 mm overlap");
const bar = plan.parts.find((p) => p.outline.flat().every((q) => q[1] < 15.5))!;
const foot = plan.parts.find((p) => p !== bar)!;
check(!!bar && bar.rails[0].every((_, k) => near(angleOf(bar.rails, k), 0, 1e-6)), "the bar's rungs follow its direction line (across)");
check(!!foot && foot.rails[0].every((_, k) => near(angleOf(foot.rails, k), 90, 1e-6)), "the foot's rungs follow its direction line (up and down)");
check(!bar.auto && !foot.auto && !bar.notOneColumn && !foot.notOneColumn, "both directions drawn, both one column");
// the overlap: each part reaches 0.1 mm over the cut
check(near(Math.max(...bar.outline.flat().map((p) => p[1])), 15.1), "the bar reaches 0.1 mm past the cut");
check(near(Math.min(...foot.outline.flat().map((p) => p[1])), 14.9), "the foot reaches 0.1 mm back over it");

// no direction line: across the long side, and said so
const auto = planSplit(doc([L]), { ...input, directions: [] })!;
check(auto.parts.every((p) => p.auto), "parts without a line are marked automatic");
const autoBar = auto.parts.find((p) => p.outline.flat().every((q) => q[1] < 15.5))!;
check(near(angleOf(autoBar.rails, 0), 0, 1e-6), "the bar sewn across its long side");

// the NOVAstitch preset's overlap
check(near(overlapFor({ fabric: "knit", options: { presetSet: "nova" } } as never), 0.4), "NOVAstitch on knit: 0.4 mm overlap");

// the document: satins in the shape's place, grouped, what followed it after the last one
const before = obj("before", [ring([[50, 0], [60, 0], [60, 10]])]);
const after = obj("after", [ring([[70, 0], [80, 0], [80, 10]])]);
const r = applySplit(doc([before, L, after]), input)!;
check(r.doc.objects.length === 4 && r.doc.objects[0].id === "before" && r.doc.objects[3].id === "after", "the satins where the shape was");
const sat = r.doc.objects.slice(1, 3);
check(sat.every((o) => o.stitch.type === "satin" && o.paths.length === 2 && o.paths[0].nodes.length === o.paths[1].nodes.length), "two-rail satins with as many points on each rail (rungs)");
check(sat[0].group !== undefined && sat[0].group === sat[1].group, "grouped together");
check(!sat[0].trimAfter && sat[1].trimAfter, "the shape's trim after goes to the last satin");
check(r.made.join() === sat.map((o) => o.id).join(), "the new satins reported");
check(planSplit(doc([L]), { ...input, id: "nope" }) === null, "no such shape: nothing");

console.log(failed ? `${failed} FAILED` : "all passed");
if (failed) throw new Error(`${failed} split checks failed`);
