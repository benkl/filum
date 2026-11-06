// Copies that stand on their own, threads merged by colour, groups kept
// through tartans and conversions (npm run test:match).

import type { DesignObject, StitchDocument, SubPath, Thread } from "../types";
import { freshCopies, mergeThreads } from "./copies";
import { makeTartan, removeTartan, tartanLayers } from "./tartan";
import { toggleClosed } from "./nodeOps";
import { calibrate } from "./calibration";

let failed = 0;
const check = (ok: boolean, msg: string) => {
  if (!ok) {
    failed++;
    console.log("FAIL", msg);
  } else console.log("ok  ", msg);
};
const square = { closed: true, nodes: [{ p: [0, 0] }, { p: [10, 0] }, { p: [10, 10] }, { p: [0, 10] }] };
const obj = (id: string, extra: Partial<DesignObject> = {}): DesignObject =>
  ({ id, name: id, thread: "t1", visible: true, locked: false, paths: [square], stitch: { type: "fill", angle: 0, rowSpacing: 0.4, maxStitchLength: 3 }, trimAfter: false, stopAfter: false, ...extra }) as unknown as DesignObject;
const fillWith = (k: string, v: unknown) => ({ type: "fill", angle: 0, rowSpacing: 0.4, maxStitchLength: 3, [k]: v }) as unknown as DesignObject["stitch"];

// a gradient (its fill group G in group U), a colour blend and a lettering, copied
const layers = [0, 1].map((layer) => obj(`g${layer}`, { group: "G", stitch: fillWith("gradient", { group: "G", layer }) }));
const blend = obj("b", { stitch: fillWith("ramp", { group: "B", from: [0, 0], to: [1, 0], dense: 0.3, sparse: 1, profile: "linear" }) });
const text = obj("x", { text: { group: "T", thread: "t1", borderThread: "t1" } as unknown as DesignObject["text"] });
const doc = { objects: [...layers, blend, text], groupParents: { G: "U" }, groupNames: { U: "Badge" } };
const c = freshCopies(doc, doc.objects);
const st = (o: DesignObject) => o.stitch as unknown as { gradient?: { group: string }; ramp?: { group: string } };
check(c.objects.every((o, k) => o.id !== doc.objects[k].id), "every copy has a new id");
check(c.objects[0].group === c.objects[1].group && c.objects[0].group !== "G", "the gradient's layers share a new group");
check(st(c.objects[0]).gradient!.group === c.objects[0].group, "the gradient's own group follows the layers' group");
check(st(c.objects[2]).ramp!.group !== "B", "a colour blend copied is a blend of its own");
check(c.objects[3].text!.group !== "T", "a lettering copied is a lettering of its own");
const newU = c.parents[c.objects[0].group!];
check(!!newU && newU !== "U" && c.names[newU] === "Badge", "the group around them is copied with its name");
check(c.ids.get("g0") === c.objects[0].id, "the old ids map to the new ones (for linked clones)");

// threads: the same colour is shared, an id taken by another colour gets a new one
const have: Thread[] = [{ id: "t1", name: "Green", color: "#00ff00", brand: "", code: "" } as Thread];
const red = { id: "t1", name: "Red", color: "#ff0000", brand: "", code: "" } as Thread;
const green = { id: "t7", name: "Green", color: "#00FF00", brand: "", code: "" } as Thread;
const m = mergeThreads(have, [red, green]);
check(m.map.get("t1") !== "t1" && m.add.length === 1 && m.add[0].color === "#ff0000", "a red t1 pasted into a design whose t1 is green stays red");
check(m.map.get("t7") === "t1", "a thread of a colour the design has is shared");
check(mergeThreads(have, [have[0]]).add.length === 0, "the design's own thread comes back as itself");

// a tartan made from an object in a group: its own group, inside that one
const plain = { objects: [obj("a", { group: "U" }), obj("z", { group: "U" })], threads: have, groupParents: {} } as unknown as StitchDocument;
const tart = makeTartan(plain, "a");
const tl = tartanLayers(tart, (tart.objects[0].stitch as unknown as { tartan: { group: string } }).tartan.group);
const tg = tl[0]?.group;
check(tl.length > 1 && tl.every((o) => o.group === tg) && tg !== "U", "a tartan's layers are kept together by its own group");
check(tart.groupParents?.[tg!] === "U", "the tartan's group sits in the object's group");
const back = removeTartan(tart, tg!);
check(back.objects.find((o) => o.id === "a")?.group === "U", "removing the tartan puts the fill back in the group");
const cloned = { ...tart, objects: [...tart.objects, { ...tl[1], id: "cl", clone: { of: tl[1].id, m: [1, 0, 0, 1, 5, 5], rot: 0 } } as DesignObject] };
check(tartanLayers(cloned, tg!).length === tl.length, "a linked clone of a layer is not a layer of the tartan");

// closing one rail of a satin closes both
const rail = (y: number): SubPath => ({ closed: false, nodes: [{ p: [0, y] }, { p: [10, y] }, { p: [10, y + 5] }] });
const satin = obj("s", { paths: [rail(0), rail(1)], stitch: { type: "satin", width: 2 } as unknown as DesignObject["stitch"] });
const closed = toggleClosed({ objects: [satin] } as unknown as StitchDocument, [{ id: "s", sp: 0, ni: 0 }]);
check(closed.objects[0].paths.every((sp) => sp.closed), "closing a satin rail closes the other one too");

// a calibration measurement far off is flagged (and the dialog won't save it)
check(calibrate({ aAlong: 250, aAcross: 25, bAlong: 25, bAcross: 25 } as never).odd.length > 0, "a typo like 250 for 25 is flagged");

console.log(failed ? `${failed} FAILED` : "all passed");
if (failed) throw new Error(`${failed} copy checks failed`);
