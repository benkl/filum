import type { DesignObject, GradientParams, StitchDocument } from "../types";
import { gradientLayers, gradientRefusal, layeredRefusal, oneLayerEach, plainGroupOf, plainLayerStitch, removeRampDoc, repairGradients, reverseStops } from "./fillLayers";

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
const doc = (objects: DesignObject[], more: Partial<StitchDocument> = {}) => ({ objects, threads: [], ...more }) as unknown as StitchDocument;

// ---- colour blends: Remove keeps a layer
const ramp = { from: [0, 0], to: [10, 0], dense: 0.25, sparse: 2, profile: "linear", additive: true, group: "B" };
const fwd = obj("f", { ramp, underlay: false });
const rev = obj("r", { ramp: { ...ramp, reverse: true }, underlay: false }, { thread: "t1" });
const both = removeRampDoc(doc([fwd, rev]), "r");
ok(both.doc.objects.length === 1 && both.doc.objects[0].id === "f" && both.keep[0] === "f", "removing a blend keeps its first layer");
ok(both.doc.objects[0].stitch.type === "fill" && !both.doc.objects[0].stitch.ramp && both.doc.objects[0].stitch.underlay, "as a plain fill with underlay");
const onlyRev = removeRampDoc(doc([rev]), "r");
ok(onlyRev.doc.objects.length === 1 && onlyRev.keep[0] === "r" && onlyRev.doc.objects[0].stitch.type === "fill" && !onlyRev.doc.objects[0].stitch.ramp, "the fading-in layer left alone stays, as a plain fill");

// ---- reversing stops: a midpoint belongs to the lower stop of a pair
const weights = (stops: { pos: number; mid: number }[], t: number) => {
  // the core maths for two stops (gradient.ts `weights`, linear curve)
  const [a, b] = stops[0].pos <= stops[1].pos ? [0, 1] : [1, 0];
  let u = (t - stops[a].pos) / (stops[b].pos - stops[a].pos);
  const mid = stops[a].mid;
  if (Math.abs(mid - 0.5) > 1e-6) u = Math.pow(u, Math.log(0.5) / Math.log(mid));
  const w = [0, 0];
  w[a] = 1 - u;
  w[b] = u;
  return w;
};
const two = [
  { pos: 0, mid: 0.25, thread: "A" },
  { pos: 1, mid: 0.5, thread: "B" },
];
const r2 = reverseStops(two);
ok(r2[0].thread === "B" && r2[0].pos === 0 && r2[1].thread === "A" && r2[1].pos === 1, "reversed: colours swapped");
ok(Math.abs(weights(two, 0.25)[0] - weights(r2, 0.75)[1]) < 1e-9, "and the 50 % mix mirrored (midpoint of the pair moves to its new lower stop)");
const three = [
  { pos: 0, mid: 0.2, thread: "A" },
  { pos: 0.4, mid: 0.7, thread: "B" },
  { pos: 1, mid: 0.5, thread: "C" },
];
const r3 = reverseStops(three);
ok(r3.map((x) => x.thread).join("") === "CBA" && Math.abs(r3[0].mid - 0.3) < 1e-9 && Math.abs(r3[1].mid - 0.8) < 1e-9, "three stops: each pair keeps its mirrored midpoint");
const back = (xs: { pos: number; mid: number; thread: string }[]) => JSON.stringify(xs.map((x) => [x.thread, +x.pos.toFixed(6), +x.mid.toFixed(6)]).slice(0, 2));
ok(back(reverseStops(r3)) === back(three), "reversing twice gives the stops back");

// ---- deleting a colour layer of a gradient
const gp = (layer: number, extra: Partial<GradientParams> = {}): GradientParams =>
  ({
    kind: "linear",
    from: [0, 5],
    to: [10, 5],
    stops: [
      { pos: 0, mid: 0.5 },
      { pos: 0.5, mid: 0.4 },
      { pos: 1, mid: 0.5 },
    ],
    curve: "linear",
    steps: 4,
    dither: "rows",
    cell: 3,
    layer,
    group: "G",
    seed: 1,
    ...extra,
  }) as GradientParams;
const layer = (i: number, thread: string, extra: Partial<GradientParams> = {}) => obj(`g${i}`, { gradient: gp(i, extra) }, { name: `Shape · colour ${i + 1}`, thread, group: "G" });
const whole = doc([layer(0, "A"), layer(1, "B"), layer(2, "C")], { groupParents: { G: "U" } });
ok(repairGradients(whole) === whole, "a whole gradient is left as it is");
const holed = doc([layer(0, "A"), layer(2, "C")], { groupParents: { G: "U" } });
const fixed = repairGradients(holed);
const fl = gradientLayers(fixed, "G");
const g0 = fl[0].stitch.type === "fill" ? fl[0].stitch.gradient! : null;
ok(fl.length === 2 && fl.map((o) => (o.stitch.type === "fill" ? o.stitch.gradient!.layer : -1)).join() === "0,1", "the layers left are numbered again");
ok(g0 && g0.stops.length === 2 && g0.stops[1].pos === 1 && fl[1].thread === "C" && fl[1].name === "Shape · colour 2", "the deleted layer's stop goes, the others keep their colour");
const mesh = { rows: 2, cols: 2, nodes: [0, 1, 2, 1].map((c, i) => ({ p: [i, i] as [number, number], c })) };
const meshFixed = repairGradients(doc([layer(0, "A", { kind: "mesh", mesh }), layer(2, "C", { kind: "mesh", mesh })]));
const m0 = meshFixed.objects[0].stitch.type === "fill" ? meshFixed.objects[0].stitch.gradient!.mesh! : null;
ok(m0 && m0.nodes.every((n) => n.c === 0 || n.c === 1) && m0.nodes[2].c === 1, "mesh nodes follow the new numbers");
const lone = repairGradients(doc([layer(1, "B"), obj("x", {}, { group: "U" })], { groupParents: { G: "U" } }));
const lo = lone.objects[0];
ok(lo.stitch.type === "fill" && !lo.stitch.gradient && lo.group === "U" && lo.name === "Shape", "a gradient left with one layer becomes a plain fill in the group around it");

// ---- what reshaping commands refuse, and booleans' inputs
const tartan = { palette: "(#ff0000)4 (#00ff00)4", rotate: 0, offset: [0, 0], symmetry: false, scale: 100, minStripeWidth: 1, angle: -45, rowsPerThread: 2, herringbone: 0, group: "T" };
const t0 = obj("t0", { method: "tartan", tartan: { ...tartan, layer: 0 } }, { group: "T" });
const t1 = obj("t1", { method: "tartan", tartan: { ...tartan, layer: 1 } }, { group: "T" });
const clone = obj("c", {}, { clone: { of: "x" } as unknown as DesignObject["clone"] });
ok(layeredRefusal([obj("p")]) === null, "plain fills can be reshaped");
ok(!!layeredRefusal([obj("p"), clone]) && !!layeredRefusal([t0]) && !!layeredRefusal([fwd]) && !!layeredRefusal([layer(0, "A")]), "clones, tartans, blends and gradients are refused");
ok(oneLayerEach([layer(0, "A"), layer(1, "B"), obj("p"), t0, t1, fwd, rev]).map((o) => o.id).join() === "g0,p,t0,f", "booleans see one shape per gradient / tartan / blend");
const layerClone = { ...layer(1, "B"), id: "lc", clone: { of: "g1" } as unknown as DesignObject["clone"] };
ok(oneLayerEach([layer(0, "A"), layerClone]).length === 2, "a linked clone of a layer is a shape of its own");
const ps = plainLayerStitch(t1.stitch);
ok(ps.type === "fill" && !ps.tartan && ps.method === "tatami", "a boolean result of a tartan is a plain tatami fill");
const pb = plainLayerStitch(rev.stitch);
ok(pb.type === "fill" && !pb.ramp && !pb.gradient, "and of a blend, no ramp");
const pd = plainLayerStitch(obj("d", { ramp: { ...ramp, group: undefined } }).stitch);
ok(pd.type === "fill" && !!pd.ramp, "a lone density ramp stays");
ok(plainGroupOf(doc([t0], { groupParents: { T: "U" } }), t0) === "U" && plainGroupOf(doc([]), obj("p", {}, { group: "U" })) === "U", "the result stays in its group");

// ---- making a gradient
ok(!!gradientRefusal(doc([clone]), clone), "no gradient on a linked clone");
ok(!!gradientRefusal(doc([t0, t1]), t0) && gradientRefusal(doc([t0]), t0) === null, "nor on a layer of a tartan with more layers");
ok(!!gradientRefusal(doc([fwd, rev]), fwd), "nor on a layer of a colour blend");
