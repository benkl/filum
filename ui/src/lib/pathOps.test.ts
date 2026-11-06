// Path commands: join, compound paths, bending a segment, averaging points,
// the curvature tool's smooth points (npm run test:match).

import type { DesignObject, StitchDocument, SubPath, Vec2 } from "../types";
import { joinObjects, makeCompound, releaseCompound } from "./pathOps";
import { averageNodes, bendSegment } from "./nodeOps";
import { cubicAt, segmentOf } from "./bezier";
import { autoSmooth } from "../canvas/penTool";

let failed = 0;
const check = (ok: boolean, msg: string) => {
  if (!ok) {
    failed++;
    console.log("FAIL", msg);
  } else console.log("ok  ", msg);
};
const near = (a: Vec2, b: Vec2, eps = 1e-6) => Math.hypot(a[0] - b[0], a[1] - b[1]) < eps;
const line = (pts: Vec2[], closed = false): SubPath => ({ nodes: pts.map((p) => ({ p })), closed });
const obj = (id: string, paths: SubPath[], extra: Partial<DesignObject> = {}): DesignObject =>
  ({ id, name: id, thread: "t", visible: true, locked: false, paths, stitch: { type: "running" }, trimAfter: false, stopAfter: false, ...extra }) as unknown as DesignObject;
const doc = (objects: DesignObject[]) => ({ objects }) as unknown as StitchDocument;

// join
const two = doc([obj("a", [line([[0, 0], [10, 0]])]), obj("b", [line([[30, 0], [11, 0]])])]);
const j = joinObjects(two, ["a", "b"]);
check(!j.error && j.doc.objects.length === 1, "two open paths join into one object");
check(j.doc.objects[0].paths[0].nodes.map((n) => n.p[0]).join() === "0,10,11,30", "at their nearest ends, the second one turned round");
const one = joinObjects(doc([obj("a", [line([[0, 0], [10, 0], [10, 10]])])]), ["a"]);
check(one.doc.objects[0].paths[0].closed, "one open path: join closes it");
check(!!joinObjects(doc([obj("a", [line([[0, 0], [10, 0], [10, 10]], true)])]), ["a"]).error, "a closed path can't be joined");

// compound paths
const outer = obj("o", [line([[0, 0], [20, 0], [20, 20], [0, 20]], true)], { stitch: { type: "fill" } as DesignObject["stitch"] });
const hole = obj("h", [line([[5, 5], [15, 5], [15, 15], [5, 15]], true)]);
const c = makeCompound(doc([outer, hole]), ["o", "h"]);
check(c.doc.objects.length === 1 && c.doc.objects[0].paths.length === 2 && c.doc.objects[0].stitch.type === "fill", "make: one object with both paths, the bottom one's style");
const r = releaseCompound(c.doc, ["o"]);
check(r.doc.objects.length === 2 && r.doc.objects.every((o) => o.paths.length === 1) && r.ids.length === 2, "release: a path per object again");
check(!!releaseCompound(doc([hole]), ["h"]).error, "nothing to release in a single path");

// bending a segment: its point at t moves by d, the ends stay
const seg = line([[0, 0], [30, 0]]);
const bent = bendSegment(seg, 0, 0.5, [0, 6]);
const mid = cubicAt(segmentOf(bent, 0), 0.5);
check(near(mid, [15, 6]), "the dragged point of the segment follows the pointer");
check(near(bent.nodes[0].p, [0, 0]) && near(bent.nodes[1].p, [30, 0]), "the end points stay");
const smooth: SubPath = { nodes: [{ p: [0, 0], i: [-10, 0], o: [10, 0] }, { p: [30, 0] }], closed: false };
const turned = bendSegment(smooth, 0, 0.4, [0, 5]).nodes[0];
const dirO = Math.atan2(turned.o![1], turned.o![0]);
const dirI = Math.atan2(turned.i![1] - 0, turned.i![0] - 0);
check(Math.abs(Math.abs(dirO - dirI) - Math.PI) < 1e-6 && Math.abs(Math.hypot(...turned.i!) - 10) < 1e-6, "a smooth end point turns its other handle with it, keeping its length");

// average points
const avg = averageNodes(doc([obj("a", [line([[0, 0], [10, 4], [20, 8]])])]), [
  { id: "a", sp: 0, ni: 0 },
  { id: "a", sp: 0, ni: 2 },
]);
const ap = avg.objects[0].paths[0].nodes;
check(near(ap[0].p, [10, 4]) && near(ap[2].p, [10, 4]) && near(ap[1].p, [10, 4]), "average: the selected points meet at their mean");

// curvature: the path runs through the points, smooth at the middle one
const sm = autoSmooth([{ p: [0, 0] }, { p: [10, 10] }, { p: [20, 0] }], [true, true, true], false);
const m = sm[1];
check(!!m.i && !!m.o && Math.abs(m.i[1] - 10) < 1e-9 && Math.abs(m.o[1] - 10) < 1e-9, "the middle point's handles lie along the line from its neighbours");
check(near(cubicAt(segmentOf({ nodes: sm, closed: false }, 0), 1), [10, 10]), "the curve passes through the point");
const corner = autoSmooth([{ p: [0, 0] }, { p: [10, 10] }, { p: [20, 0] }], [true, false, true], false);
check(!corner[1].i && !corner[1].o, "a corner keeps no handles");

console.log(failed ? `${failed} FAILED` : "all passed");
if (failed) throw new Error(`${failed} path checks failed`);
