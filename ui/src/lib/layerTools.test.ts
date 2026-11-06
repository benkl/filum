// Organising the Layers tab (npm run test:match).

import type { DesignObject, StitchDocument } from "../types";
import { buildLayerRows } from "./layerRows";
import { filterRows, groupByKind, groupByThread, moveToGroup, rangeIds, solo, ungroupAll } from "./layerTools";

let failed = 0;
const check = (ok: boolean, msg: string) => {
  if (!ok) {
    failed++;
    console.log("FAIL", msg);
  } else console.log("ok  ", msg);
};
const obj = (id: string, thread: string, type: string, extra: Partial<DesignObject> = {}): DesignObject =>
  ({ id, name: id, thread, visible: true, locked: false, paths: [], stitch: { type }, trimAfter: false, stopAfter: false, ...extra }) as unknown as DesignObject;
const doc = (objects: DesignObject[], extra: Partial<StitchDocument> = {}) =>
  ({ objects, threads: [{ id: "red", name: "Cherry", color: "#c00", brand: "", code: "" }, { id: "blue", name: "Navy", color: "#00c", brand: "", code: "" }], ...extra }) as unknown as StitchDocument;

// stitch order: sky (fill, blue), sun (fill, red), ring (satin, blue), birds (running, blue), in group "g": petal1, petal2 (fill, red)
const d = doc(
  [obj("sky", "blue", "fill"), obj("sun", "red", "fill"), obj("ring", "blue", "satin"), obj("birds", "blue", "running"), obj("petal1", "red", "fill", { group: "g" }), obj("petal2", "red", "fill", { group: "g" })],
  { groupNames: { g: "Flower" } },
);
const rows = buildLayerRows(d.objects, new Set(), d.groupNames, d.groupParents);
const names = (rs: typeof rows) => rs.map((r) => (r.kind === "group" ? `[${r.name}]` : r.o.id)).join(" ");

// filtering
check(names(filterRows(rows, d, "su", "all")) === "sun", "a name search shows the matching objects");
check(names(filterRows(rows, d, "cherry", "all")) === "[Flower] petal2 petal1 sun", "a thread name finds its objects, with the groups they are in");
check(names(filterRows(rows, d, "flower", "all")) === "[Flower] petal2 petal1", "a group's name shows the whole group");
check(names(filterRows(rows, d, "", "satin")) === "ring", "the type filter");
check(filterRows(rows, d, "", "all") === rows, "no filter: the rows as they are");

// range and solo
check(rangeIds(rows, "o:birds", "o:sun").join() === "birds,ring,sun", "Shift-click selects the rows in between");
const s1 = solo(d, ["sun"]);
check(s1.objects.filter((o) => o.visible).map((o) => o.id).join() === "sun", "Alt-click an eye: only that row shows");
check(solo(s1, ["sun"]).objects.every((o) => o.visible), "again: everything shows");

// grouping
const byThread = groupByThread(d);
check(byThread.made === 1, "by thread: blue has three loose objects, red one loose (the petals are grouped already)");
const blue = byThread.doc.objects.filter((o) => o.thread === "blue");
check(new Set(blue.map((o) => o.group)).size === 1 && !!blue[0].group && byThread.doc.groupNames![blue[0].group!] === "Navy", "one group per thread, named after it");
check(byThread.doc.objects.map((o) => o.id).join() === d.objects.map((o) => o.id).join(), "the stitch order stays");
const byKind = groupByKind(d);
check(byKind.made === 1 && byKind.doc.groupNames![byKind.doc.objects[0].group!] === "Fills", "by stitch type: the two loose fills");
check(ungroupAll(byThread.doc).objects.every((o) => !o.group), "ungroup all");

// moving into a group
const moved = moveToGroup(d, ["sun"], "g");
check(moved.objects.find((o) => o.id === "sun")!.group === "g", "move to group");
check(moveToGroup(moved, ["sun"], undefined).objects.find((o) => o.id === "sun")!.group === undefined, "move out to the top level");

console.log(failed ? `${failed} FAILED` : "all passed");
if (failed) throw new Error(`${failed} layer tool checks failed`);
