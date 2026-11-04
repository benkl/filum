import type { DesignObject, StitchDocument, TartanParams } from "../types";
import { makeTartan, paletteCode, parsePalette, removeTartan, syncTartan, tartanColors, tartanLayers } from "./tartan";

function ok(c: unknown, msg: string) {
  if (!c) throw new Error(msg);
  console.log("ok  ", msg);
}

const p = parsePalette("(#0000FF)/2.4 (#FFFFFF)0.4 (#ff0000)?1 (#006400)/2.4");
ok(p.symmetric && p.equal && p.warp.length === 4 && p.warp[2].render === 0, "palette parsed");
ok(paletteCode(p.warp, true) === "(#0000ff)/2.4 (#ffffff)0.4 (#ff0000)?1 (#006400)/2.4", "and written back");
ok(JSON.stringify(tartanColors("(#0000FF)/2.4 (#FFFFFF)0.4 (#0000ff)1 (#006400)/2.4")) === JSON.stringify(["#0000ff", "#ffffff", "#006400"]), "colours once each, sewn ones only");

const sq: DesignObject = {
  id: "a",
  name: "Patch",
  thread: "t0",
  visible: true,
  locked: false,
  paths: [{ closed: true, nodes: [{ p: [0, 0] }, { p: [10, 0] }, { p: [10, 10] }, { p: [0, 10] }] }],
  stitch: { type: "fill", method: "tatami", angle: 0 } as DesignObject["stitch"],
  trimAfter: false,
  stopAfter: false,
};
const doc = { objects: [sq], threads: [{ id: "t0", name: "x", color: "#123456", brand: "", code: "" }] } as unknown as StitchDocument;
const d1 = makeTartan(doc, "a", { palette: "(#ff0000)/4 (#00ff00)/4", rotate: 0, offset: [0, 0], symmetry: true, scale: 100, minStripeWidth: 1, angle: -45, rowsPerThread: 2, herringbone: 0 });
const group = (d1.objects[0].stitch as { tartan?: { group: string } }).tartan!.group;
ok(tartanLayers(d1, group).length === 2 && d1.threads.some((t) => t.color === "#00ff00"), "a layer and a thread per colour");
const t1 = (d1.objects[0].stitch as unknown as { tartan: TartanParams }).tartan;
const d2 = syncTartan(d1, group, { ...t1, palette: "(#ff0000)/4 (#00ff00)2 (#0000ff)/4" });
ok(tartanLayers(d2, group).length === 3 && tartanLayers(d2, group)[0].id === "a", "a colour added: a layer added, the first stays");
const d3 = removeTartan(d2, group);
ok(d3.objects.length === 1 && d3.objects[0].stitch.type === "fill" && d3.objects[0].stitch.method === "tatami", "back to a plain fill");
