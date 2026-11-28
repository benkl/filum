// Regions and cutting along a drawn segment (the Cutter on fills; npm run test:match).

import type { DesignObject, SubPath, Vec2 } from "../types";
import { cutChords, cutFillObject } from "./cut";
import { cutParts, regionArea, regionsOf, splitRegion } from "./regions";

let failed = 0;
const check = (ok: boolean, msg: string) => {
  if (!ok) {
    failed++;
    console.log("FAIL", msg);
  } else console.log("ok  ", msg);
};
const near = (a: number, b: number, e = 1e-6) => Math.abs(a - b) < e;
const ring = (pts: Vec2[]): SubPath => ({ closed: true, nodes: pts.map((p) => ({ p })) });
const obj = (paths: SubPath[]): DesignObject =>
  ({
    id: "f",
    name: "F",
    thread: "t",
    visible: true,
    locked: false,
    paths,
    stitch: { type: "fill" },
    trimAfter: false,
    stopAfter: false,
  }) as unknown as DesignObject;
const areaOf = (o: DesignObject) => regionsOf(o).reduce((s, g) => s + regionArea(g), 0);

// a U: two legs 4 wide, 20 high, joined at the bottom (y 16..20)
const U = obj([
  ring([
    [0, 0],
    [4, 0],
    [4, 16],
    [12, 16],
    [12, 0],
    [16, 0],
    [16, 20],
    [0, 20],
  ]),
]);
check(regionsOf(U).length === 1 && near(areaOf(U), 4 * 16 * 2 + 16 * 4), "a U is one region");

// a cut across the left leg only
const leg = cutFillObject(U, [-2, 8], [6, 8])!;
check(!!leg && leg.length === 2, "a cut across one leg: two objects");
check(near(areaOf(leg[0]) + areaOf(leg[1]), areaOf(U), 1e-6), "nothing lost");
check(
  leg.some((o) => near(areaOf(o), 4 * 8, 1e-6)),
  "the tip of the left leg comes off; the right leg stays whole",
);

// the same cut drawn across both legs: both tips come off, into one object (the same side)
const both = cutFillObject(U, [-2, 8], [18, 8])!;
check(
  both.length === 2 && both.some((o) => regionsOf(o).length === 2 && near(areaOf(o), 2 * 4 * 8, 1e-6)),
  "across both legs: the two tips together on one side",
);

// a drag that ends inside the shape cuts nothing
check(cutFillObject(U, [-2, 8], [2, 8]) === null, "a cut that stops inside the shape: nothing");
check(cutChords(U, [-2, 8], [18, 8]).length === 2, "the preview shows both stretches that cut");

// a square: as the old cutter did
const sq = obj([
  ring([
    [0, 0],
    [10, 0],
    [10, 10],
    [0, 10],
  ]),
]);
const halves = cutFillObject(sq, [5, -5], [5, 15])!;
check(halves.length === 2 && halves.every((o) => near(areaOf(o), 50, 1e-6)), "a square cut in half");

// an O: a ring with a counter. Across the whole O: two halves, each a C
const O = obj([
  ring([
    [0, 0],
    [10, 0],
    [10, 10],
    [0, 10],
  ]),
  ring([
    [3, 3],
    [7, 3],
    [7, 7],
    [3, 7],
  ]),
]);
check(regionsOf(O).length === 1 && regionsOf(O)[0].holes.length === 1, "an O: one outline, one counter");
const oh = cutFillObject(O, [5, -1], [5, 11])!;
check(!!oh && oh.every((o) => near(areaOf(o), (100 - 16) / 2, 1e-6)), "across the O: two halves");
// into the counter only: the O opens but stays one piece
const g = regionsOf(O)[0];
const opened = splitRegion(g, [5, -1], [5, 4]);
check(opened.length === 1 && opened[0].holes.length === 0 && near(regionArea(opened[0]), 84, 1e-6), "a cut from the edge into the counter opens it");

// overlap: the parts reach over the cut by half the overlap each
const lap = cutParts(
  regionsOf(sq),
  [
    [5, -5],
    [5, 15],
  ],
  0.4,
);
check(lap.length === 2 && lap.every((r) => near(regionArea(r), 52, 1e-6)), "with 0.4 mm overlap each half is 0.2 mm wider");

console.log(failed ? `${failed} FAILED` : "all passed");
if (failed) throw new Error(`${failed} region checks failed`);
