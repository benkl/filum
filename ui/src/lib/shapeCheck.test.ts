// Shape checks and cleanup (npm run test:match).

import { cleanupCandidates, selfCrossing, shapeProblems } from "./shapeCheck";
import type { DesignObject, StitchDocument, SubPath, Vec2 } from "../types";

let failed = 0;
const check = (ok: boolean, msg: string) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${msg}`);
  if (!ok) failed++;
};
const poly = (pts: Vec2[], closed = true): SubPath => ({ closed, nodes: pts.map((p) => ({ p })) });
const obj = (id: string, paths: SubPath[], stitch: object): DesignObject =>
  ({ id, name: id, thread: "t", visible: true, locked: false, trimAfter: false, stopAfter: false, paths, stitch }) as unknown as DesignObject;

const bowtie = poly([[0, 0], [10, 10], [10, 0], [0, 10]]);
check(!!selfCrossing(bowtie), "bowtie: the border crosses itself");
check(!selfCrossing(poly([[0, 0], [10, 0], [10, 10], [0, 10]])), "square: no crossing");
const fill = { type: "fill", method: "tatami" };
check(shapeProblems(obj("b", [bowtie], fill)).some((p) => p.title === "Border crosses itself"), "fill check reports it");
check(shapeProblems(obj("o", [poly([[0, 0], [10, 0], [10, 10]], false)], fill)).some((p) => p.title === "Not a closed shape"), "open fill: not closed");
// satin rung that misses a rail
const rails = [poly([[0, 0], [10, 0], [20, 0]], false), poly([[0, 4], [10, 4], [20, 4]], false)];
const shortRung = poly([[5, -1], [5, 2]], false);
check(shapeProblems(obj("s", [...rails, shortRung], { type: "satin" })).some((p) => p.title === "Rung misses a rail"), "satin: dangling rung");
check(!shapeProblems(obj("s2", [...rails, poly([[5, -1], [5, 5]], false)], { type: "satin" })).some((p) => p.title === "Rung misses a rail"), "satin: a good rung is fine");
// cleanup: tiny fill and short line go, the rest stays
const doc = {
  objects: [obj("tiny", [poly([[0, 0], [1, 0], [1, 1], [0, 1]])], fill), obj("big", [poly([[0, 0], [20, 0], [20, 20], [0, 20]])], fill), obj("dot", [poly([[0, 0], [0.5, 0]], false)], { type: "running" }), obj("line", [poly([[0, 0], [30, 0]], false)], { type: "running" })],
} as unknown as StitchDocument;
const gone = cleanupCandidates(doc).map((o) => o.id).sort();
check(JSON.stringify(gone) === JSON.stringify(["dot", "tiny"]), `cleanup: ${gone.join(",")}`);

console.log(failed ? `${failed} FAILED` : "all passed");
if (failed) throw new Error(`${failed} shape checks failed`);
