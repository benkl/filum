// Copies that stand on their own, threads merged by colour, groups kept
// through tartans and conversions (npm run test:match).

import type { DesignObject, StitchDocument, SubPath, Thread } from "../types";
import { freshCopies, mergeThreads, placeCopies } from "./copies";
import { railMap } from "./nodeOps";
import { checkDoc } from "./docCheck";
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


// duplicate / Alt-drag / repeat: copies stay in a group copied only in part; a whole group is new, in the same place
const nest = { objects: [obj("p", { group: "In" }), obj("q", { group: "In" }), obj("r", { group: "Out" })], groupParents: { In: "Out" } };
const part = freshCopies(nest, [nest.objects[0]], { inPlace: true });
check(part.objects[0].group === "In" && !Object.keys(part.parents).length, "a copy of one member stays in its group");
const inner = freshCopies(nest, nest.objects.slice(0, 2), { inPlace: true });
check(inner.objects[0].group !== "In" && inner.parents[inner.objects[0].group!] === "Out", "a whole inner group copied: a new group in the same outer group");
check(freshCopies(nest, [nest.objects[0]]).objects[0].group !== "In", "a paste makes groups of its own");

// a clone copied with its original follows the copy, offset like the original pair
const orig = obj("o0");
const cl = obj("c0", { clone: { of: "o0", m: [1, 0, 0, 1, 20, 0], rot: 0 } } as Partial<DesignObject>);
const both = freshCopies({ objects: [orig, cl] }, [orig, cl]);
const moved = placeCopies(both.objects, [1, 0, 0, 1, 5, 5]);
check(moved[1].clone!.of === moved[0].id, "a clone copied with its original links to the copy");
check(Math.abs(moved[1].clone!.m[4] - 20) < 1e-9 && Math.abs(moved[1].clone!.m[5]) < 1e-9, "and keeps its offset from it");
const alone = freshCopies({ objects: [orig, cl] }, [cl]);
check(alone.objects[0].clone!.of === "o0", "a clone copied alone still follows the original");

// threads: a red of another brand is another thread
const madeira = { id: "m", name: "Red", color: "#ff0000", brand: "Madeira", code: "1147" } as Thread;
const isacord = { id: "i", name: "Red", color: "#ff0000", brand: "Isacord", code: "1903" } as Thread;
check(mergeThreads([madeira], [isacord]).add.length === 1, "the same colour from another brand stays its own thread");

// satin rails: the engine's rungs (a reversed closed rail keeps node 0 with node 0)
const ring = (pts: number[][]): SubPath => ({ closed: true, nodes: pts.map((p) => ({ p: p as [number, number] })) });
const ra = ring([[0, 0], [10, 0], [10, 10], [0, 10]]);
const rb = ring([[-1, -1], [-1, 11], [11, 11], [11, -1]]);
const rm = railMap(ra, rb)!;
check(rm.rev && rm.at(0) === 0 && rm.at(1) === 3 && rm.at(3) === 1, "a reversed closed rail pairs node i with node (n − i) mod n");
const ol = (pts: number[][]): SubPath => ({ closed: false, nodes: pts.map((p) => ({ p: p as [number, number] })) });
const om = railMap(ol([[0, 0], [10, 0], [20, 0]]), ol([[20, 2], [10, 2], [0, 2]]))!;
check(om.rev && om.at(0) === 2 && om.seg(0) === 1, "a reversed open rail pairs node i with node n − 1 − i");

// a design from a file or the autosave: what can't load is left out, the rest is safe
const base = { objects: [], threads: [], machine: { spm: 800 }, hoop: { width: 100, height: 100 }, options: {} } as unknown as StitchDocument;
check(checkDoc({ nope: 1 }, base) === null && checkDoc(null, base) === null, "not a design: refused");
const bad = checkDoc({ objects: [obj("ok"), { id: "x" }, obj("ok")], threads: null }, base)!;
check(bad.doc.objects.length === 1 && bad.dropped === 2, "damaged and repeated objects are left out");
check(bad.doc.threads.length === 1 && bad.doc.objects[0].thread === bad.doc.threads[0].id, "objects without their thread get one");

console.log(failed ? `${failed} FAILED` : "all passed");
if (failed) throw new Error(`${failed} copy checks failed`);
