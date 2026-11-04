import type { DesignObject, StitchDocument } from "../types";
import { applyPatterns, patternPair } from "./stitchPatterns";

function ok(c: unknown, msg: string) {
  if (!c) throw new Error(msg);
  console.log("ok  ", msg);
}
const obj = (id: string, pts: [number, number][], closed: boolean): DesignObject => ({
  id,
  name: id,
  thread: "t",
  visible: true,
  locked: false,
  paths: [{ closed, nodes: pts.map((p) => ({ p })) }],
  stitch: { type: "fill" } as DesignObject["stitch"],
  trimAfter: false,
  stopAfter: false,
});
const big = obj("big", [[0, 0], [40, 0], [40, 40], [0, 40]], true);
const hole = obj("hole", [[10, 10], [20, 10], [20, 20], [10, 20]], true);
const line = obj("line", [[0, 20], [40, 25]], false);
const pair = patternPair([hole, big, line])!;
ok(pair.target.id === "big" && pair.patterns.length === 2, "the largest object is stitched, the others are patterns");
const d = applyPatterns({ objects: [big, hole, line] } as unknown as StitchDocument, "big", ["hole", "line"]);
ok(d.objects.length === 1, "the pattern objects move into it");
const p = d.objects[0].patterns!;
ok(p[0].remove && !p[0].add && p[1].add && !p[1].remove, "shapes leave points out, lines add them");
