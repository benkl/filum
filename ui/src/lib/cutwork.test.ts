import type { DesignObject, StitchDocument } from "../types";
import { CUTWORK_SECTORS, cutworkSegmentation, segmentAngle, segmentLine } from "./cutwork";

function ok(c: unknown, msg: string) {
  if (!c) throw new Error(msg);
  console.log("ok  ", msg);
}

ok(segmentAngle([10, 0], [0, 0]) === 0 && segmentAngle([0, 0], [10, 0]) === 180 && segmentAngle([0, 10], [0, 0]) === 90, "directions 0..180");
// a square: horizontal sides cut by needle 2 (158..23), vertical by needle 4 (67..113)
const sq: [number, number][] = [
  [0, 0],
  [10, 0],
  [10, 10],
  [0, 10],
  [0, 0],
];
const parts = segmentLine(sq, CUTWORK_SECTORS);
ok(parts.length === 4 && parts.every(([n]) => n === 1 || n === 3), `a square: four pieces for two needles (${parts.map((p) => p[0]).join(",")})`);
// a diagonal at 45°: needle 3 (22..68)
ok(segmentLine([[0, 0], [10, 10]], CUTWORK_SECTORS)[0][0] === 2, "45° goes to needle 3");
// overlapping ranges: 112/113 belong to needles 1 and 4
const steep = segmentLine([[0, 0], [-4, 10]], CUTWORK_SECTORS).map((p) => p[0]).sort();
ok(steep.length === 2, `an edge angle is cut by both needles (${steep})`);

const line: DesignObject = { id: "l", name: "Cut", thread: "t", visible: true, locked: false, paths: [{ closed: true, nodes: sq.slice(0, 4).map((p) => ({ p })) }], stitch: { type: "running", length: 2.5, tolerance: 0.2, repeats: 1, beanRepeats: 0 }, trimAfter: false, stopAfter: false };
const d = cutworkSegmentation({ objects: [line], threads: [] } as unknown as StitchDocument, ["l"]);
ok(d.objects.length === 4 && d.threads.length === 2, `pieces in a thread per needle (${d.objects.length} pieces, ${d.threads.length} threads)`);
const needles = d.objects.map((o) => (o.stitch.type === "running" ? o.stitch.cutworkNeedle : 0));
ok(JSON.stringify(needles) === JSON.stringify([2, 2, 4, 4]), `sorted by needle (${needles})`);
