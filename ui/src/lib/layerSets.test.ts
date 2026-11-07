// Gradient / tartan layer sets kept consistent through clones, copies,
// pasted properties, style changes, the cutter and cleanup; thread merging
// and loading checks (npm run test:match).

import type { DesignObject, GradientParams, StitchDocument, Thread } from "../types";
import { makeClone, syncClones, unlinkClone } from "./clones";
import { freshCopies, mergeThreads } from "./copies";
import { cutFills } from "./cut";
import { checkDoc } from "./docCheck";
import { collapseLayers, gradientLayers, pastedStitch, pastedStitchDoc, repairLayers, repairTartans } from "./fillLayers";
import { defaultDesignOptions } from "./geometry";
import { liveGroups } from "./groups";
import { cleanupDocument } from "./shapeCheck";
import { makeTartan, paletteWithout, tartanColors, tartanLayers } from "./tartan";

function ok(c: unknown, msg: string) {
  if (!c) throw new Error(msg);
  console.log("ok  ", msg);
}

const square = [{ closed: true, nodes: [{ p: [0, 0] }, { p: [10, 0] }, { p: [10, 10] }, { p: [0, 10] }] }] as DesignObject["paths"];
const obj = (id: string, stitch: Record<string, unknown> = {}, extra: Partial<DesignObject> = {}): DesignObject =>
  ({
    id,
    name: id,
    thread: "t0",
    visible: true,
    locked: false,
    paths: square,
    stitch: { type: "fill", method: "tatami", angle: 0, rowSpacing: 0.4, underlay: true, ...stitch },
    trimAfter: false,
    stopAfter: false,
    ...extra,
  }) as DesignObject;
const threads = [{ id: "t0", name: "x", color: "#123456", brand: "", code: "" }];
const doc = (objects: DesignObject[], more: Partial<StitchDocument> = {}) => ({ objects, threads, ...more }) as unknown as StitchDocument;
const gst = (o: DesignObject) => (o.stitch as { gradient?: GradientParams }).gradient;
const tst = (o: DesignObject) => (o.stitch as { tartan?: { group: string; layer: number; palette: string } }).tartan;

// a three-colour gradient in group G (inside U) and a tartan
const grad = (group = "G", n = 3) => {
  const stops = Array.from({ length: n }, (_, k) => ({ pos: k / (n - 1), mid: 0.5 }));
  return Array.from({ length: n }, (_, layer) =>
    obj(`${group}${layer}`, { gradient: { kind: "linear", from: [0, 0], to: [10, 0], stops, curve: "linear", layer, group } }, { group, name: `Shape · colour ${layer + 1}`, thread: "t0" }),
  );
};
const tartanDoc = () => {
  const t = makeTartan(doc([obj("a", {}, { name: "Patch" }), obj("z")]), "a");
  const g = tst(t.objects.find((o) => tst(o))!)!.group;
  return { t, g, layers: tartanLayers(t, g) };
};

// ---- 1. a clone of a clone: an object of its own, following the same original
const orig = obj("o");
const c1 = makeClone(orig);
const c2 = makeClone(c1);
ok(c2.id !== c1.id && c2.id !== orig.id, "a clone of a clone has its own id");
ok(c2.clone?.of === "o", "and follows the original");
ok(Math.abs(c2.paths[0].nodes[0].p[0] - 10) < 1e-9 && Math.abs(c2.clone!.m[4] - 10) < 1e-9, "5 mm further on than the clone it was made from");
const synced = syncClones(doc([orig, c1, c2]));
ok(new Set(synced.objects.map((o) => o.id)).size === 3, "the three stay three objects");

// ---- 4. unlinking a clone of a gradient layer: a plain fill, not one more layer
const g3 = grad();
const lc = makeClone(g3[1]);
const un = unlinkClone(lc);
ok(!gst(un) && !un.clone, "an unlinked clone of a gradient layer is a plain fill");
const gIn = { ...g3[0], id: "cg", clone: { of: "G0", m: [1, 0, 0, 1, 5, 5], rot: 0 } } as DesignObject;
ok(unlinkClone(gIn).group === undefined, "and leaves the gradient's own group");
ok(unlinkClone(gIn, doc(g3, { groupParents: { G: "U" } })).group === "U", "for the group around it");
const { layers: tl0 } = tartanDoc();
ok(!tst(unlinkClone(makeClone(tl0[2]))), "an unlinked clone of a tartan layer is a plain fill too");

// ---- 4. copies of some layers of a gradient: a consistent gradient (or a plain fill)
const gd = doc([...g3, obj("x", {}, { group: "U" })], { groupParents: { G: "U" } });
const two = freshCopies(gd, [g3[0], g3[2]], { inPlace: true });
const tg = gst(two.objects[0])!;
ok(
  two.objects.every((o) => gst(o)!.group === tg.group && o.group === tg.group) && tg.group !== "G",
  "two layers of three copied: a gradient of their own",
);
ok(
  two.objects.map((o) => gst(o)!.layer).join() === "0,1" && two.objects.every((o) => gst(o)!.stops.length === 2),
  "numbered 0, 1 with two stops",
);
const one = freshCopies(gd, [g3[1]], { inPlace: true });
ok(!gst(one.objects[0]) && one.objects[0].group === "U" && one.objects[0].name === "Shape", "one layer copied: a plain fill in the group around");
ok(!Object.keys(one.parents).some((k) => k !== "U" && !one.objects.some((o) => o.group === k)), "no parents left for the dissolved layer group");
const all = freshCopies(gd, g3, { inPlace: true });
ok(all.objects.map((o) => gst(o)!.layer).join() === "0,1,2" && gst(all.objects[0])!.stops.length === 3, "a whole gradient copied stays whole");
// added to the design: still consistent (and the original untouched)
const added = repairLayers({ ...gd, objects: [...gd.objects, ...two.objects], groupParents: { ...gd.groupParents, ...two.parents } });
ok(gradientLayers(added, "G").length === 3, "the original keeps its three layers");

// ---- 4. tartans: some layers copied or deleted
const { t: td, g: tgroup, layers: tls } = tartanDoc();
const colors = tartanColors(tst(tls[0])!.palette);
ok(tls.length === colors.length && colors.length >= 3, "the tartan sews a layer per colour");
const tp = freshCopies(td, [tls[0], tls[2]], { inPlace: true });
const np = tst(tp.objects[0])!.palette;
ok(tp.objects.map((o) => tst(o)!.layer).join() === "0,1", "two tartan layers copied: numbered 0, 1");
ok(tp.objects.every((o) => tst(o)!.palette === np) && tst(tp.objects[0])!.group !== tgroup, "with one palette, in a tartan of their own");
ok(JSON.stringify(tartanColors(np)) === JSON.stringify([colors[0], colors[2]]), "the palette sews only their colours, in order");
const tone = freshCopies(td, [tls[1]], { inPlace: true });
ok(!tst(tone.objects[0]) && tone.objects[0].stitch.type === "fill" && tone.objects[0].stitch.method === "tatami", "one tartan layer copied: a plain fill");
const deleted = repairTartans({ ...td, objects: td.objects.filter((o) => o.id !== tls[1].id) });
const left = tartanLayers(deleted, tgroup);
ok(left.length === colors.length - 1 && left.map((o) => tst(o)!.layer).join() === left.map((_, i) => i).join(), "a tartan layer deleted: the rest renumbered");
ok(!tartanColors(tst(left[0])!.palette).includes(colors[1]), "and the deleted colour is left out of the palette");
ok(repairTartans(td) === td, "a whole tartan is left alone");
ok(paletteWithout("(#ff0000)/2 (#00ff00)1 (red)*3 (#0000ff)/2", ["#ff0000"]) === "(#ff0000)?/2 (#00ff00)1 (red)*3 (#0000ff)/2", "paletteWithout marks only sewn stripes of the colour");

// ---- 2. a style for one layer: the set becomes one plain fill first
const cg = collapseLayers(gd, "G2");
ok(cg.id === "G0" && cg.doc.objects.filter((o) => o.id.startsWith("G")).length === 1 && !gst(cg.doc.objects.find((o) => o.id === "G0")!), "collapsing a gradient from its last layer keeps the first as a plain fill");
const ct = collapseLayers(td, tls[2].id);
ok(ct.id === tls[0].id && !tst(ct.doc.objects.find((o) => o.id === ct.id)!) && tartanLayers(ct.doc, tgroup).length === 0, "collapsing a tartan from a later layer");
ok(collapseLayers(gd, "x").doc === gd && collapseLayers(gd, "nope").id === undefined, "plain objects and missing ids: unchanged");

// ---- 3. pasted stitch properties: no gradient / tartan / blend membership
const satinClip = { stitch: { type: "satin", width: 3, method: "satin", spacing: 0.4 } as unknown as DesignObject["stitch"], thread: "t0" };
const fromGrad = { stitch: structuredClone(g3[1].stitch), thread: "t0" };
const plainTarget = obj("p");
const ps = pastedStitch(plainTarget, fromGrad.stitch);
ok(ps.type === "fill" && !ps.gradient, "a gradient layer's settings pasted on a plain fill: no gradient");
const onTartan = pastedStitch(tls[1], fromGrad.stitch);
ok(onTartan.type === "fill" && !onTartan.gradient && onTartan.tartan?.group === tgroup && onTartan.method === "tartan", "pasted on a tartan layer: it keeps its tartan");
const blendRamp = { from: [0, 0], to: [10, 0], dense: 0.25, sparse: 2, profile: "linear", group: "B" };
const fromBlend = pastedStitch(plainTarget, obj("b", { ramp: blendRamp, underlay: false }).stitch);
ok(fromBlend.type === "fill" && !fromBlend.ramp, "a blend layer's settings: no blend");
const pd = pastedStitchDoc(gd, ["G1", "G2"], satinClip);
ok(pd.n === 1 && pd.selection.join() === "G0", "a satin pasted on gradient layers: the gradient collapses, the layer left takes it");
ok(pd.doc.objects.find((o) => o.id === "G0")!.stitch.type === "satin" && !gradientLayers(pd.doc, "G").length, "one object, a satin");
const pf = pastedStitchDoc(gd, ["G1"], { stitch: obj("q", { angle: 45 }).stitch, thread: "t0" });
ok(gst(pf.doc.objects.find((o) => o.id === "G1")!)?.layer === 1 && gradientLayers(pf.doc, "G").length === 3, "a fill pasted on a gradient layer keeps the gradient");

// ---- 5. the cutter: a gradient cut as one, each half a gradient of its own
const cutDoc = doc(g3, { groupParents: { G: "U" } });
const cut = cutFills(cutDoc, g3, [5, -5], [5, 15]);
ok(cut.n === 1 && cut.left === 0 && cut.doc.objects.length === 6, "three layers cut: six pieces");
const halves = [...new Set(cut.doc.objects.map((o) => gst(o)!.group))];
ok(halves.length === 2 && !halves.includes("G"), "in two new gradients");
for (const h of halves) {
  const ls = gradientLayers(cut.doc, h);
  ok(ls.length === 3 && ls.map((o) => gst(o)!.layer).join() === "0,1,2" && ls.every((o) => o.group === h) && cut.doc.groupParents?.[h] === "U", `half ${h.slice(0, 2)}…: whole, in its own group inside U`);
}
const lockedOne = cutFills(cutDoc, g3.slice(0, 2), [5, -5], [5, 15]);
ok(lockedOne.n === 0 && lockedOne.left === 1 && lockedOne.doc === cutDoc, "a gradient with a layer that can't be cut is left whole");
const tcut = cutFills(td, tls, [5, -5], [5, 15]);
const tHalves = [...new Set(tcut.doc.objects.filter((o) => tst(o)).map((o) => tst(o)!.group))];
ok(tHalves.length === 2 && tHalves.every((h) => tartanLayers(tcut.doc, h).map((o) => tst(o)!.layer).join() === tls.map((_, i) => i).join()), "a tartan cut: two whole tartans");
const pcut = cutFills(doc([obj("p")]), [obj("p")], [5, -5], [5, 15]);
ok(pcut.n === 1 && pcut.doc.objects.map((o) => o.name).join() === "p a,p b", "a plain fill is cut as before");

// ---- 6. cleanup: a gradient that lost a layer is renumbered, lone groups go
let cleaned = gd;
const tiny = obj("tiny", {}, { group: "V", paths: [{ closed: true, nodes: [{ p: [0, 0] }, { p: [0.5, 0] }, { p: [0.5, 0.5] }] }] as DesignObject["paths"] });
const withTiny = { ...gd, objects: [...gd.objects, tiny, obj("v2", {}, { group: "V" })] };
cleanupDocument((fn) => (cleaned = fn(withTiny)), withTiny);
ok(!cleaned.objects.some((o) => o.id === "tiny") && !liveGroups(cleaned).has("V"), "cleanup dissolves a group left with one object");

// ---- 8. threads: a thread without a brand or code matches its colour
const madeira: Thread = { id: "m", name: "Red", color: "#ff0000", brand: "Madeira", code: "1147" } as Thread;
const isacord: Thread = { id: "i", name: "Red", color: "#ff0000", brand: "Isacord", code: "1903" } as Thread;
const dst: Thread = { id: "t1", name: "Thread 1", color: "#FF0000", brand: "", code: "" } as Thread;
ok(mergeThreads([madeira], [dst]).map.get("t1") === "m" && mergeThreads([madeira], [dst]).add.length === 0, "a DST's red reuses the design's Madeira red");
ok(mergeThreads([dst], [madeira]).add.length === 0, "and the other way round");
ok(mergeThreads([madeira], [isacord]).add.length === 1, "a Madeira red and an Isacord red stay apart");
ok(mergeThreads([madeira, dst], [{ ...dst, id: "q" }]).map.get("q") === "t1", "an exact match wins over a looser one");

// ---- 9. loading: options and lettering threads
const base = { objects: [], threads: [], machine: { spm: 800 }, hoop: { width: 100, height: 100 } } as unknown as StitchDocument;
const noOpts = checkDoc({ objects: [obj("a")], threads }, base)!.doc;
ok(noOpts.options === undefined, "a design saved without options keeps none (the panels show the defaults)");
const someOpts = checkDoc({ objects: [obj("a")], threads, options: { basting: "box" } }, base)!.doc;
ok(someOpts.options?.basting === "box" && someOpts.options.bastingMargin === defaultDesignOptions().bastingMargin, "saved options lie over the defaults");
const lettering = obj("l", {}, { text: { group: "T", thread: "gone", borderThread: "gone2", palette: ["t0", "gone3"] } as unknown as DesignObject["text"] });
const lt = checkDoc({ objects: [lettering], threads }, base)!.doc.objects[0].text!;
ok(lt.thread === "t0" && lt.borderThread === "t0" && lt.palette!.join() === "t0,t0", "a lettering's missing threads are replaced");

console.log("all passed");
