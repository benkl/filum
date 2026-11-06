import type { DesignObject, StitchDocument, TartanParams } from "../types";
import { makeTartan, paletteCode, paletteProblem, parsePalette, patchTartan, removeTartan, syncTartan, tartanColors, tartanLayers, tartanMirrored } from "./tartan";

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

// a palette with nothing to sew is refused: the layers stay
const t2 = (d2.objects[0].stitch as unknown as { tartan: TartanParams }).tartan;
const allOut = syncTartan(d2, group, { ...t2, palette: "(#ff0000)?4 (#00ff00)?2" });
ok(allOut === d2 && paletteProblem("(#ff0000)?4 (#00ff00)?2") !== null, "every stripe left out: refused, the layers stay");
ok(syncTartan(d2, group, { ...t2, palette: "#ff0000 4" }) === d2 && paletteProblem("#ff0000 4") !== null, "a code without stripes: refused");
ok(paletteProblem("(#ff0000)4") === null, "a sewn stripe is fine");

// colours read exactly like the engine (tartan.rs parse_palette / parse_color)
const bad = parsePalette("(foo)4 (#00ff00)2 (rgb(255,0,0))4 (#abc)1 (Navy)/2 (#11223344)1 (#12345)1 (#ff0000)1.2.3");
ok(bad.warp.length === 6, "a stripe without a readable width is skipped (rgb(…) and 1.2.3)");
ok(bad.warp[0].color === "#000000" && bad.warp[0].render === 0, "an unknown colour is left out, in black");
ok(bad.warp[2].color === "#aabbcc" && bad.warp[3].color === "#000080" && bad.warp[4].color === "#112233", "#rgb, names and #rrggbbaa read as #rrggbb");
ok(bad.warp[5].render === 0, "a 5-digit hex colour is not a colour");
ok(JSON.stringify(tartanColors("(foo)4 (#00ff00)2 (#ff0000)?1")) === JSON.stringify(["#00ff00"]), "only readable sewn colours make layers");
ok(parsePalette("(#ff0000) ? / 4").warp[0]?.render === 0, "marks and spaces in any order before the width");

// the Mirrored switch sets what the engine reads
const flat = patchTartan({ palette: "(#ff0000)/4 (#00ff00)/4", symmetry: true }, { palette: "(#ff0000)4 (#00ff00)4" });
ok(!flat.symmetry && !tartanMirrored(flat), "a code without pivots is not mirrored");
ok(patchTartan(flat, { palette: "(#ff0000)/4 (#00ff00)/4" }).symmetry, "pivots mirror it again");
ok(tartanMirrored({ palette: "(#ff0000)4 (#00ff00)4", symmetry: true }), "an old tartan with only the flag still shows as mirrored");
