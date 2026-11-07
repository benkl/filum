import type { DesignObject, Vec2 } from "../types";
import { autoSatin } from "./autoSatin";

function ok(c: unknown, msg: string) {
  if (!c) throw new Error(msg);
  console.log("ok  ", msg);
}

const satin = (id: string, pts: Vec2[], width = 3): DesignObject => ({
  id,
  name: id,
  thread: "t",
  visible: true,
  locked: false,
  paths: [{ closed: false, nodes: pts.map((p) => ({ p })) }],
  stitch: { type: "satin", method: "satin", width, spacing: 0.4, pullComp: 0, flip: false, stops: false, swapRails: false, reverse: false } as unknown as DesignObject["stitch"],
  trimAfter: false,
  stopAfter: false,
});
const ends = (o: DesignObject): [Vec2, Vec2] => {
  const n = o.paths[0].nodes;
  const a = n[0].p;
  const b = n[n.length - 1].p;
  const rev = o.stitch.type === "satin" && o.stitch.reverse;
  return rev ? [b, a] : [a, b];
};
const d = (a: Vec2, b: Vec2) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const satins = (os: DesignObject[]) => os.filter((o) => o.stitch.type === "satin");
const length = (os: DesignObject[]) =>
  satins(os).reduce((l, o) => {
    const n = o.paths[0].nodes;
    return l + n.slice(1).reduce((s, x, k) => s + d(x.p, n[k].p), 0);
  }, 0);

// a T: a bar and a stem that meets its middle
const bar = satin("bar", [
  [0, 0],
  [40, 0],
]);
const stem = satin("stem", [
  [20, 0],
  [20, 30],
]);
const t = autoSatin([bar, stem])!;
ok(Math.abs(length(t) - 70) < 0.5, `every satin sewn once (${length(t).toFixed(1)} mm of 70)`);
// consecutive objects join up: no jumps inside the T
let gaps = 0;
for (let i = 1; i < t.length; i++) {
  const prev = t[i - 1];
  const prevEnd = prev.stitch.type === "satin" ? ends(prev)[1] : prev.paths[0].nodes[prev.paths[0].nodes.length - 1].p;
  const start = t[i].stitch.type === "satin" ? ends(t[i])[0] : t[i].paths[0].nodes[0].p;
  if (d(prevEnd, start) > 0.01) gaps++;
}
ok(gaps === 0, `one continuous path through the T (${t.length} objects)`);
ok(t.some((o) => o.stitch.type === "running"), "a running underpath where the route goes down a branch and back");
ok(t.every((o) => o.id !== "bar" && o.id !== "stem"), "new objects replace the originals");

// two satins apart: one jump, a trim with the option
const far = [satin("a", [
  [0, 0],
  [20, 0],
]), satin("b", [
  [40, 10],
  [60, 10],
])];
const plain = autoSatin(far)!;
ok(satins(plain).length === 2 && !plain.some((o) => o.trimAfter), "two satins, no trim by default");
const trimmed = autoSatin(far, { trim: true })!;
ok(trimmed[0].trimAfter, "with trims: the jump between them is trimmed");

// keep the order: the first object comes first
const ordered = autoSatin([far[1], far[0]], { preserveOrder: true })!;
ok(ends(satins(ordered)[0])[0][0] >= 40, "preserve order: the first selected satin is sewn first");

ok(autoSatin([{ ...bar, stitch: { type: "running", length: 2.5, tolerance: 0.2, repeats: 1, beanRepeats: 0 } }]) === null, "no satin, nothing to route");

// two-rail satins are cut across at a stitch pair (Ink/Stitch find_cut_points),
// their rails keep their own nodes: a U whose nodes correspond (node rungs),
// outer rail much longer than the inner one, and a stem meeting it
const arc = (cx: number, cy: number, r: number, n: number): Vec2[] =>
  Array.from({ length: n + 1 }, (_, i) => {
    const a = -Math.PI / 2 + (Math.PI * i) / n;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  });
const twoRail = (id: string, r0: Vec2[], r1: Vec2[]): DesignObject => ({ ...satin(id, r0), thread: id, paths: [r0, r1].map((pts) => ({ closed: false, nodes: pts.map((p) => ({ p })) })) });
const outer: Vec2[] = [[20, 30], ...arc(60, 45, 15, 8), [20, 60]];
const inner: Vec2[] = [[20, 34], ...arc(60, 45, 11, 8), [20, 56]];
const u = twoRail("u", outer, inner);
const stemR = twoRail("stem", [
  [30, 10],
  [30, 31],
], [
  [33, 10],
  [33, 31],
]);
const routed = autoSatin([u, stemR])!;
const original = [...outer, ...inner];
const uPieces = satins(routed).filter((o) => o.thread === "u");
ok(uPieces.length >= 2, `the U is cut (${uPieces.length} pieces)`);
for (const o of uPieces) {
  const [a, b] = [o.paths[0].nodes, o.paths[1].nodes];
  ok(a.length === b.length && o.paths.length === 2, `${o.name}: as many nodes on both rails, no rung needed (${a.length} / ${b.length})`);
  ok(a.slice(1, -1).every((n) => original.some((q) => d(q, n.p) < 1e-9)) && b.slice(1, -1).every((n) => original.some((q) => d(q, n.p) < 1e-9)), `${o.name}: the rails keep the original nodes`);
  // cuts on the straight parts run straight across (they slanted 17° when cut at equal shares of each rail)
  for (const [p, q] of [
    [a[0].p, b[0].p],
    [a[a.length - 1].p, b[b.length - 1].p],
  ] as [Vec2, Vec2][]) {
    if (p[0] < 59 && q[0] < 59) ok(Math.abs(p[0] - q[0]) < 0.02, `${o.name}: cut at x ${p[0].toFixed(2)} / ${q[0].toFixed(2)} is square to the column`);
  }
}
// the pieces cover the U once: the rails' lengths add up
const railLen = (pts: Vec2[]) => pts.slice(1).reduce((s, p, k) => s + d(p, pts[k]), 0);
const sumOuter = uPieces.reduce((s, o) => s + railLen(o.paths[0].nodes.map((n) => n.p)), 0);
ok(Math.abs(sumOuter - railLen(outer)) < 0.05, `the outer rail sewn once (${sumOuter.toFixed(2)} of ${railLen(outer).toFixed(2)} mm)`);

// rails with nodes that do not correspond: the pieces get a rung, so the
// engine does not pair nodes up by count
const loose = twoRail("loose", [
  [0, 0],
  [10, 0],
  [20, 0],
  [30, 0],
  [40, 0],
], [
  [0, 4],
  [40, 4],
]);
const cross = twoRail("cross", [
  [20, -10],
  [20, 0.5],
], [
  [22, -10],
  [22, 0.5],
]);
const loosePieces = satins(autoSatin([loose, cross])!).filter((o) => o.thread === "loose");
ok(loosePieces.length >= 2 && loosePieces.every((o) => o.paths.length === 3), `pieces of a satin without node rungs get one rung (${loosePieces.map((o) => o.paths.length).join(",")})`);
