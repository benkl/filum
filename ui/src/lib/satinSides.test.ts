// A satin's two sides and its orientation lines (npm run test:match).
import type { DesignObject, StitchDocument, SubPath, Vec2 } from "../types";
import { clearOrientation, followGuides, freeSides, orientationLines, pairRungs, removeOrientationLine, toCentreLine, toTwoSides } from "./satinSides";
import { deleteSelectedNodes } from "./nodeOps";

function ok(c: unknown, msg: string) {
  if (!c) throw new Error(msg);
  console.log("ok  ", msg);
}
const line = (...pts: Vec2[]): SubPath => ({ closed: false, nodes: pts.map((p) => ({ p })) });
const satin = (paths: SubPath[], extra: Record<string, unknown> = {}) =>
  ({ id: "s", name: "Satin", thread: "t", visible: true, locked: false, trimAfter: false, stopAfter: false, paths, stitch: { type: "satin", width: 4, ...extra } }) as unknown as DesignObject;
const st = (o: DesignObject) => o.stitch as { guides?: [Vec2, Vec2][]; nodeRungs?: boolean };

// two sides of four points each: the two inner pairs are rungs
const rails = satin([line([0, 0], [10, 0], [20, 0], [30, 0]), line([0, 4], [12, 4], [20, 4], [30, 4])]);
ok(pairRungs(rails).length === 2, "the inner point pairs act as rungs (the column's ends don't)");
ok(orientationLines(rails).pairs && orientationLines(rails).lines.length === 2, "they are the satin's orientation lines");
ok(pairRungs(satin([line([0, 0], [30, 0]), line([0, 4], [10, 4], [30, 4])])).length === 0, "rails of different lengths don't pair");

// freeing the sides keeps the stitch angle: the pairs become guides, the pairing stops
const free = freeSides(rails);
ok(st(free).nodeRungs === false && st(free).guides?.length === 2, "freed: two guides, no pairing");
const g = st(free).guides![0];
ok(g[0][1] < 0 && g[1][1] > 4 && Math.abs(g[0][0] - 10) < 0.2 && Math.abs(g[1][0] - 12) < 0.2, "a guide runs along its pair, a little past both sides");
ok(freeSides(free) === free, "freeing twice changes nothing");
ok(orientationLines(free).lines.length === 2 && !orientationLines(free).pairs, "the guides are now the orientation lines");

// deleting one orientation line
const one = removeOrientationLine(rails, 0);
ok(st(one).guides?.length === 1 && st(one).nodeRungs === false, "a deleted pair stays deleted; the other one is kept");
const none = removeOrientationLine(one, 0);
ok(st(none).guides === undefined && st(none).nodeRungs === false && orientationLines(none).lines.length === 0, "the last line deleted: none left, and the pairs don't come back");
ok(orientationLines(clearOrientation(rails)).lines.length === 0, "remove all: no orientation line at all");
const guided = satin([line([0, 0], [30, 0])], { guides: [[[5, -3], [5, 3]], [[9, -3], [9, 3]]] });
ok(st(removeOrientationLine(guided, 1)).guides?.length === 1, "a centre-line satin's guide can be deleted too");

// a centre line becomes two sides, point for point
const centre = satin([line([0, 0], [10, 0], [20, 5])], { guides: [[[5, -3], [5, 3]]] });
const two = toTwoSides(centre);
ok(two.paths.length === 2 && two.paths.every((sp) => sp.nodes.length === 3), "two sides with the centre line's points");
ok(Math.abs(two.paths[0].nodes[0].p[1] - two.paths[1].nodes[0].p[1]) === 4, "half the width to each side");
ok(st(two).guides?.length === 1, "its guides are kept");
ok(toTwoSides(two) === two, "two sides stay as they are");

// deleting a point on one side only
const doc = { objects: [rails] } as unknown as StitchDocument;
const after = deleteSelectedNodes(doc, [{ id: "s", sp: 1, ni: 1 }], false).doc.objects[0];
ok(after.paths[0].nodes.length === 4 && after.paths[1].nodes.length === 3, "the other side keeps its points");
ok(st(after).guides?.length === 2, "the stitch angle stays: the pairs became guides first");
const short = satin([line([0, 0], [30, 0]), line([0, 4], [30, 4])]);
ok(deleteSelectedNodes({ objects: [short] } as unknown as StitchDocument, [{ id: "s", sp: 0, ni: 0 }], false).doc.objects[0] === short, "a side keeps at least two points");

// ---- orientation lines follow their satin
const near = (a: Vec2, b: Vec2, tol = 0.05) => Math.hypot(a[0] - b[0], a[1] - b[1]) < tol;
const docOf = (o: DesignObject) => ({ objects: [o] }) as unknown as StitchDocument;
const first = (d: StitchDocument) => d.objects[0];

// a centre line 4 mm wide, one guide straight across at x = 10, 1 mm past each side
const col = satin([line([0, 0], [20, 0])], { guides: [[[10, -3], [10, 3]]] });
followGuides(docOf(col));
const wider = first(followGuides(docOf({ ...col, stitch: { ...col.stitch, width: 8 } as DesignObject["stitch"] })));
const gw = st(wider).guides![0];
ok(near(gw[0], [10, -6]) && near(gw[1], [10, 6]), `the guide scales with the width (got ${JSON.stringify(gw)})`);
const bent = first(followGuides(docOf({ ...col, paths: [line([0, 0], [20, 10])] })));
const gb = st(bent).guides![0];
const mid: Vec2 = [(gb[0][0] + gb[1][0]) / 2, (gb[0][1] + gb[1][1]) / 2];
ok(near(mid, [10, 5], 0.1) && Math.abs((gb[1][0] - gb[0][0]) * 2 + (gb[1][1] - gb[0][1]) * 1) < 0.05 * Math.hypot(gb[1][0] - gb[0][0], gb[1][1] - gb[0][1]) * 3, "turning the line turns the guide: still across the middle");
// a guide drawn anew (a moved satin has new guides) is not moved again
const fresh = satin([line([5, 0], [25, 0])], { guides: [[[15, -3], [15, 3]]] });
ok(first(followGuides(docOf(fresh))) === fresh, "new guides stay where they were drawn");

// two sides: a guide follows the side it crosses when a point moves
const sides = satin([line([0, 0], [10, 0], [20, 0]), line([0, 4], [10, 4], [20, 4])], { guides: [[[5, -1], [5, 5]]], nodeRungs: false });
followGuides(docOf(sides));
const pulled = { ...sides, paths: [line([0, 0], [10, -4], [20, 0]), sides.paths[1]] };
const gp = st(first(followGuides(docOf(pulled)))).guides![0];
ok(near(gp[0], [5, -3.5]) && near(gp[1], [5, 5.5]), `a point pulled out takes the guide's end with it, reaching past the sides by the same share of the width (got ${JSON.stringify(gp)})`);
const unmoved = st(first(followGuides(docOf({ ...sides, paths: [...sides.paths] })))).guides![0];
ok(near(unmoved[0], [5, -1]) && near(unmoved[1], [5, 5]), "the same column: the guide stays put");

// both editing modes, back and forth
const curve = satin([{ closed: false, nodes: [{ p: [0, 0], o: [5, -4] }, { p: [20, 0], i: [15, -4] }] }], { width: 3 });
const back = toCentreLine(toTwoSides(curve));
ok(back.paths.length === 1 && (back.stitch as { width: number }).width === 3, "two sides back to a centre line: one line, the same width");
ok(back.paths[0].nodes.every((n, i) => near(n.p, curve.paths[0].nodes[i].p, 0.01)), "the centre line's points come back");
ok(near(back.paths[0].nodes[0].o!, [5, -4], 0.3), "and its curve");
const uneven = toCentreLine(satin([line([0, 0], [10, 1], [20, 0]), line([0, 4], [20, 4])], { nodeRungs: false }));
ok(uneven.paths.length === 1 && Math.abs((uneven.stitch as { width: number }).width - 3.7) < 0.4 && st(uneven).nodeRungs === undefined, "sides with different points become a fitted centre line");
// a piece of a cut satin shares the list: its guides stay where they are
const piece = { ...sides, id: "s2", paths: [line([0, 0], [10, 0]), line([0, 4], [10, 4])] };
ok(first(followGuides(docOf(piece))) === piece, "a cut piece keeps its guides where they lie");
// a point added on one side (same shape): the guide stays
const added = { ...sides, paths: [line([0, 0], [5, 0], [10, 0], [20, 0]), sides.paths[1]] };
const ga = st(first(followGuides(docOf(added)))).guides![0];
ok(near(ga[0], [5, -1]) && near(ga[1], [5, 5]), "adding a point leaves the guide where it was");
