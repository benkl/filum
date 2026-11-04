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
