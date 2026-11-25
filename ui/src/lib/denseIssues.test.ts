// Issues: the places too dense for the fabric (the density map's hotspots).
// Fills stacked on each other get Remove hidden stitching; fills that only
// meet at their edges don't (it would not thin them out).

import type { DensityHotspot, DesignObject, PlanData, StitchDocument } from "../types";
import { denseIssues, fillsStackAt } from "./denseIssues";

function ok(c: unknown, msg: string) {
  if (!c) throw new Error(msg);
  console.log("ok  ", msg);
}

const rect = (x: number, y: number, w: number, h: number) =>
  [{ closed: true, nodes: [{ p: [x, y] }, { p: [x + w, y] }, { p: [x + w, y + h] }, { p: [x, y + h] }] }] as DesignObject["paths"];
const fill = (id: string, paths: DesignObject["paths"]): DesignObject =>
  ({ id, name: id, thread: "t0", visible: true, locked: false, paths, stitch: { type: "fill", method: "tatami", angle: 0, rowSpacing: 0.4, underlay: false }, trimAfter: false, stopAfter: false }) as DesignObject;
const doc = (objects: DesignObject[], removeOverlaps = false) =>
  ({ objects, threads: [], fabric: "cotton", hoop: { width: 100, height: 100, shape: "rect" }, machine: { minStitch: 0.3 }, options: { removeOverlaps } }) as unknown as StitchDocument;
const plan = (hotspots: DensityHotspot[]) =>
  ({
    coords: new Float32Array(0),
    flags: new Uint8Array(0),
    objects: new Uint32Array(0),
    threads: [],
    stats: { stitches: 0 },
    quality: null,
    dense: { hotspots, limits: { gsm: 130, holesHeavy: 10, holesMax: 17, layersHeavy: 2.5, layersMax: 3.8, layersMin: 0.8, stiffRatio: 1 } },
  }) as unknown as PlanData;
const spot = (x: number, y: number, objects: number[], layers = 4.6): DensityHotspot => ({ x, y, w: 2, h: 2, area: 3, peakLayers: layers, peakHoles: 12, objects });

// two squares on top of each other, and two side by side meeting at x = 10
const under = fill("under", rect(0, 0, 10, 10));
const over = fill("over", rect(2, 2, 6, 6));
const left = fill("left", rect(0, 20, 10, 10));
const right = fill("right", rect(10, 20, 10, 10));

ok(fillsStackAt([under, over], { x: 4, y: 4, w: 2, h: 2 }), "a fill on another fill stacks");
ok(!fillsStackAt([left, right], { x: 9, y: 24, w: 2, h: 2 }), "fills meeting at an edge don't");
ok(!fillsStackAt([under], { x: 4, y: 4, w: 2, h: 2 }), "one fill alone doesn't");

const d = doc([under, over, left, right]);
const is = denseIssues(d, plan([spot(4, 4, [0, 1]), spot(9, 24, [2, 3])]), []).filter((i) => i.title === "Too dense for the fabric");
ok(is.length === 2, "each place is listed");
const stacked = is.find((i) => i.objId === "under")!;
const edge = is.find((i) => i.objId === "left")!;
ok(stacked.fix?.doc && /4\.6 layers/.test(stacked.detail), "stacked fills: Remove hidden stitching, with the layers");
ok(stacked.fix!.doc!(d).options!.removeOverlaps === true, "the fix turns Remove hidden stitching on");
ok(!edge.fix && /meet here/.test(edge.detail), "fills meeting at an edge: no fix that wouldn't help");

// with Remove hidden stitching already on, no fix is offered
const on = denseIssues(doc([under, over], true), plan([spot(4, 4, [0, 1])]), []).filter((i) => i.title === "Too dense for the fabric");
ok(on.length === 1 && !on[0].fix, "no Remove hidden fix once it is on");

// tiny places are left to the map; the list says how many more there are
const many = Array.from({ length: 9 }, (_, k) => spot(40 + 3 * k, 40, [k % 4], 4));
const listed = denseIssues(d, plan([...many, { ...spot(0, 60, [0]), area: 0.1 }]), []).filter((i) => i.title === "Too dense for the fabric");
ok(listed.length === 4, "one place per object");
ok(/5 more places/.test(listed[listed.length - 1].detail), "the last one counts the places left out");
