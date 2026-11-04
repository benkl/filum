// Node tool operations: npm run test:match (bundled with esbuild, run in Node).

import { cubicAt, flattenSubPath, segmentOf } from "./bezier";
import { alignNodes, breakAtNodes, deleteSelectedNodes, joinNodes, moveNodes, removeNodes, setNodeType, setSegmentType, toggleClosed } from "./nodeOps";
import type { DesignObject, StitchDocument, SubPath, Vec2 } from "../types";
import { cutSatinObject } from "./cut";

let failed = 0;
const check = (ok: boolean, msg: string) => {
  console.log((ok ? "ok   " : "FAIL ") + msg);
  if (!ok) failed++;
};
const obj = (id: string, paths: SubPath[]): DesignObject =>
  ({ id, name: id, thread: "t", visible: true, locked: false, paths, stitch: { type: "running" }, trimAfter: false, stopAfter: false }) as unknown as DesignObject;
const docOf = (...objects: DesignObject[]) => ({ objects }) as unknown as StitchDocument;
const line = (...pts: Vec2[]): SubPath => ({ nodes: pts.map((p) => ({ p })), closed: false });
/** Largest distance from points of a to the polyline of b. */
const maxGap = (a: SubPath, b: SubPath) => {
  const pb = flattenSubPath(b, 0.05);
  let worst = 0;
  for (const q of flattenSubPath(a, 0.2)) {
    let best = Infinity;
    for (const r of pb) best = Math.min(best, Math.hypot(q[0] - r[0], q[1] - r[1]));
    worst = Math.max(worst, best);
  }
  return worst;
};

// a smooth arc in three cubic pieces: deleting a middle point keeps the arc
const arc: SubPath = { nodes: [], closed: false };
{
  const R = 20;
  const k = (4 / 3) * Math.tan(Math.PI / 12); // 60° pieces
  for (let i = 0; i <= 3; i++) {
    const a = (i * Math.PI) / 3;
    const p: Vec2 = [R * Math.cos(a), R * Math.sin(a)];
    const t: Vec2 = [-Math.sin(a), Math.cos(a)];
    const node: SubPath["nodes"][number] = { p };
    if (i > 0) node.i = [p[0] - t[0] * R * k, p[1] - t[1] * R * k];
    if (i < 3) node.o = [p[0] + t[0] * R * k, p[1] + t[1] * R * k];
    arc.nodes.push(node);
  }
}
const kept = removeNodes(arc, [1], true)!;
check(kept.nodes.length === 3, "delete: one point less");
check(maxGap(kept, arc) < 0.6, `delete keeps the shape (gap ${maxGap(kept, arc).toFixed(2)} mm)`);
const plain = removeNodes(arc, [1], false)!;
check(maxGap(plain, arc) > maxGap(kept, arc), "plain delete changes the shape more");
check(removeNodes(line([0, 0], [1, 0]), [0], true) === null, "a path keeps two points");
const sq: SubPath = { nodes: [{ p: [0, 0] }, { p: [10, 0] }, { p: [10, 10] }, { p: [0, 10] }], closed: true };
const sq2 = removeNodes(sq, [1, 2], true)!;
check(sq2.nodes.length === 2 && !sq2.closed, "closed path with two points left becomes open");
const sq3 = removeNodes(sq, [0], true)!;
check(sq3.closed && sq3.nodes.length === 3 && !sq3.nodes.some((n) => n.i || n.o), "straight neighbours stay straight");

{
  const d = docOf(obj("a", [line([0, 0], [5, 0], [10, 0])]), obj("b", [line([0, 5], [5, 5])]));
  const r = deleteSelectedNodes(d, [{ id: "a", sp: 0, ni: 1 }, { id: "b", sp: 0, ni: 0 }, { id: "b", sp: 0, ni: 1 }], true);
  check(r.doc.objects.length === 1 && r.doc.objects[0].paths[0].nodes.length === 2 && r.removedObjects === 1, "delete in several objects at once");
}

// node and segment types
{
  const d = docOf(obj("a", [line([0, 0], [10, 0], [20, 10])]));
  const smooth = setNodeType(d, [{ id: "a", sp: 0, ni: 1 }], "smooth");
  const s1 = smooth.objects[0].paths[0].nodes[1];
  check(!!s1.i && !!s1.o, "smooth: handles on both sides");
  const c1 = setNodeType(smooth, [{ id: "a", sp: 0, ni: 1 }], "corner").objects[0].paths[0].nodes[1];
  check(!c1.i && !c1.o, "corner: no handles");
  const curved = setSegmentType(d, [{ id: "a", sp: 0, ni: 0 }, { id: "a", sp: 0, ni: 1 }], "curve").objects[0].paths[0];
  check(!!curved.nodes[0].o && !!curved.nodes[1].i && !curved.nodes[1].o, "curve: only the segment between the selected points");
  const mid = cubicAt(segmentOf(curved, 0), 0.5);
  check(Math.abs(mid[1]) < 1e-9 && Math.abs(mid[0] - 5) < 1e-9, "a new curve keeps the straight shape until edited");
  const straight = setSegmentType(docOf(obj("a", [curved])), [{ id: "a", sp: 0, ni: 1 }], "line").objects[0].paths[0];
  check(!straight.nodes[0].o && !straight.nodes[1].i, "line: a lone point straightens its segments");
}

// break, join, open / close
{
  const d = docOf(obj("a", [line([0, 0], [5, 0], [10, 0], [15, 0])]));
  const b = breakAtNodes(d, [{ id: "a", sp: 0, ni: 1 }, { id: "a", sp: 0, ni: 2 }]).objects[0].paths;
  check(b.length === 3 && b.map((p) => p.nodes.length).join() === "2,2,2", "break an open path at two points: three pieces");
  const opened = breakAtNodes(docOf(obj("r", [sq])), [{ id: "r", sp: 0, ni: 2 }]).objects[0].paths[0];
  check(!opened.closed && opened.nodes.length === 5 && opened.nodes[0].p.join() === "10,10" && opened.nodes[4].p.join() === "10,10", "break a closed path: it opens at that point");
  check(toggleClosed(d, [{ id: "a", sp: 0, ni: 0 }]).objects[0].paths[0].closed, "close an open path");
  check(!toggleClosed(docOf(obj("r", [sq])), [{ id: "r", sp: 0, ni: 1 }]).objects[0].paths[0].closed, "open a closed path");
  const two = docOf(obj("a", [line([0, 0], [5, 0])]), obj("b", [line([5, 0], [5, 5])]));
  const j = joinNodes(two, [{ id: "a", sp: 0, ni: 1 }, { id: "b", sp: 0, ni: 0 }]);
  check(!j.error && j.doc.objects.length === 1 && j.doc.objects[0].paths[0].nodes.length === 3, "join two paths: coincident ends merge");
  const two2 = docOf(obj("a", [line([0, 0], [5, 0])]), obj("b", [line([0, 1], [0, 6])]));
  const j2 = joinNodes(two2, [{ id: "a", sp: 0, ni: 0 }, { id: "b", sp: 0, ni: 0 }]).doc.objects[0].paths[0];
  check(j2.nodes.length === 4 && j2.nodes[0].p.join() === "5,0" && j2.nodes[3].p.join() === "0,6", "join start to start: one path reversed, a straight bridge");
  check(joinNodes(d, [{ id: "a", sp: 0, ni: 0 }, { id: "a", sp: 0, ni: 3 }]).doc.objects[0].paths[0].closed, "join the two ends of one path: it closes");
  check(!!joinNodes(d, [{ id: "a", sp: 0, ni: 1 }, { id: "a", sp: 0, ni: 3 }]).error, "inner points cannot be joined");
}

// move, align
{
  const d = docOf(obj("a", [line([0, 0], [10, 3], [20, 7])]));
  const m = moveNodes(d, [{ id: "a", sp: 0, ni: 1 }], [1, 2]).objects[0].paths[0].nodes;
  check(m[1].p.join() === "11,5" && m[0].p.join() === "0,0", "move only the selected points");
  const a = alignNodes(d, [{ id: "a", sp: 0, ni: 1 }, { id: "a", sp: 0, ni: 2 }], "h").objects[0].paths[0].nodes;
  check(a[1].p[1] === 5 && a[2].p[1] === 5 && a[0].p[1] === 0, "align horizontally on the average");
}

// ---- cutting a two-rail satin across (both rails, rungs and guides follow their half)
{
  const rail = (y: number) => ({ closed: false, nodes: [{ p: [0, y] as Vec2 }, { p: [10, y] as Vec2 }, { p: [20, y] as Vec2 }] });
  const sat = {
    id: "s", name: "S", thread: "t", visible: true, locked: false, trimAfter: false, stopAfter: false,
    paths: [rail(0), rail(4), { closed: false, nodes: [{ p: [15, -1] as Vec2 }, { p: [15, 5] as Vec2 }] }],
    stitch: { type: "satin", guides: [[[5, -1], [5, 5]]] } as unknown as DesignObject["stitch"],
  } as DesignObject;
  const parts = cutSatinObject(sat, [10, 0.1]);
  check(!!parts && parts.length === 2, "satin cut: two halves");
  if (parts) {
    const xs = (o: DesignObject) => o.paths.slice(0, 2).flatMap((sp) => sp.nodes.map((n) => n.p[0]));
    check(Math.max(...xs(parts[0])) <= 10.01 && Math.min(...xs(parts[1])) >= 9.99, "satin cut: both rails split at x = 10");
    check(parts[0].paths.length === 2 && parts[1].paths.length === 3, "satin cut: the rung goes with its half");
    check(((parts[0].stitch as { guides?: unknown[] }).guides ?? []).length === 1 && ((parts[1].stitch as { guides?: unknown[] }).guides ?? []).length === 0, "satin cut: the guide goes with its half");
  }
}

console.log(failed ? `${failed} FAILED` : "all passed");
if (failed) throw new Error(`${failed} node-operation checks failed`);

