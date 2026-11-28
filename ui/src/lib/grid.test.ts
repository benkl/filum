// Grid repeat: cells, sewing order, colour runs and the document it makes (npm run test:match).

import type { DesignObject, StitchDocument, SubPath } from "../types";
import { colourChanges, gridCells, gridDoc, gridSequence } from "./grid";
import { objectBounds } from "./geometry";

let failed = 0;
const check = (ok: boolean, msg: string) => {
  if (!ok) {
    failed++;
    console.log("FAIL", msg);
  } else console.log("ok  ", msg);
};
const square = (x: number, y: number, s = 10): SubPath => ({
  closed: true,
  nodes: [{ p: [x, y] }, { p: [x + s, y] }, { p: [x + s, y + s] }, { p: [x, y + s] }],
});
const obj = (id: string, thread: string, extra: Partial<DesignObject> = {}): DesignObject =>
  ({
    id,
    name: id,
    thread,
    visible: true,
    locked: false,
    paths: [square(10, 10)],
    stitch: { type: "fill", angle: 0, rowSpacing: 0.4, maxStitchLength: 3 },
    trimAfter: false,
    stopAfter: false,
    ...extra,
  }) as unknown as DesignObject;

// cells
const cells = (o: "rows" | "serpentine") =>
  gridCells(2, 3, o)
    .map((c) => `${c.row}${c.col}`)
    .join(" ");
check(cells("rows") === "00 01 02 10 11 12", "row by row: every row from the left");
check(cells("serpentine") === "00 01 02 12 11 10", "serpentine: every second row goes back");

// colour runs: red base, blue detail, red outline on top
const piece = [obj("base", "red"), obj("detail", "blue"), obj("outline", "red")];
const pieces = [0, 1, 2].map((k) => piece.map((o) => ({ ...o, id: `${o.id}${k}` })));
const byPiece = gridSequence(pieces, "byPiece")
  .map((o) => o.id)
  .join(" ");
const byColour = gridSequence(pieces, "byColour")
  .map((o) => o.id)
  .join(" ");
check(byPiece === "base0 detail0 outline0 base1 detail1 outline1 base2 detail2 outline2", "piece by piece: one whole piece after the other");
check(byColour === "base0 base1 base2 detail0 detail1 detail2 outline0 outline1 outline2", "one colour at a time: each run on every piece, layering kept");
check(
  colourChanges(gridSequence(pieces, "byPiece")) === 6 && colourChanges(gridSequence(pieces, "byColour")) === 2,
  "colour changes: 6 piece by piece (an outline runs into the next base), 2 one at a time",
);

// the document
const other = obj("other", "green", { paths: [square(100, 100)] });
const doc = {
  objects: [obj("before", "green", { paths: [square(150, 150)] }), ...piece, other],
  threads: [],
  hoop: { width: 200, height: 200 },
} as unknown as StitchDocument;
const r = gridDoc(doc, ["base", "detail", "outline"], { rows: 2, cols: 2, gap: [5, 3], order: "serpentine", colours: "byColour" });
check(r.created.length === 9, "three copies of three objects");
check(r.doc.objects.length === 14, "every object kept, the copies added");
check(r.doc.objects[0].id === "before" && r.doc.objects[13].id === "other", "the grid is sewn where the original was");
const ids = r.doc.objects.slice(1, 13);
check(ids.slice(0, 4).every((o) => o.thread === "red") && ids.slice(4, 8).every((o) => o.thread === "blue"), "base on every piece, then the detail");
check(ids[0].id === "base", "the original is the first piece");
const at = (o: DesignObject) => objectBounds(o)!;
check(at(ids[1]).x === 25 && at(ids[1]).y === 10, "the second piece one width and the gap to the right");
check(at(ids[2]).x === 25 && at(ids[2]).y === 23, "serpentine: the third piece below the second");
check(at(ids[3]).x === 10 && at(ids[3]).y === 23, "and the fourth back on the left");
check(new Set(r.doc.objects.map((o) => o.id)).size === 14, "the copies have ids of their own");

const moved = gridDoc(doc, ["base"], { rows: 1, cols: 2, gap: [0, 0], order: "rows", colours: "byPiece" }, [5, 5]);
check(at(moved.doc.objects.find((o) => o.id === "base")!).x === 15, "a shift moves the original too");
check(gridDoc(doc, ["base"], { rows: 1, cols: 1, gap: [0, 0], order: "rows", colours: "byPiece" }).doc === doc, "one piece: nothing to do");
check(gridDoc(doc, [], { rows: 2, cols: 2, gap: [0, 0], order: "rows", colours: "byPiece" }).doc === doc, "nothing selected: nothing to do");

console.log(failed ? `${failed} FAILED` : "all passed");
if (failed) throw new Error(`${failed} grid checks failed`);
