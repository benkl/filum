import type { DesignObject, StitchDocument } from "../types";
import { defaultRippleGuide, guidePair, guidePaths, useAsRippleGuide } from "./rippleGuide";

function ok(c: unknown, msg: string) {
  if (!c) throw new Error(msg);
  console.log("ok  ", msg);
}

const line = (id: string, y: number, stitch: DesignObject["stitch"]): DesignObject => ({
  id,
  name: id,
  thread: "t",
  visible: true,
  locked: false,
  paths: [{ closed: false, nodes: [{ p: [0, y] }, { p: [20, y] }] }],
  stitch,
  trimAfter: false,
  stopAfter: false,
});
const ripple = line("r", 0, { type: "running", length: 2.5, tolerance: 0.2, repeats: 1, beanRepeats: 0, ripple: { lines: 5, minScale: 0, spacing: 2, rotation: 0, reverse: false } });
const guide = line("g", 10, { type: "running", length: 2.5, tolerance: 0.2, repeats: 1, beanRepeats: 0 });
const satin: DesignObject = { ...line("s", 30, { type: "satin" } as DesignObject["stitch"]), paths: [line("a", 30, guide.stitch).paths[0], line("b", 40, guide.stitch).paths[0]] };

ok(guidePair([ripple, guide])?.guide.id === "g", "a ripple and a line make a pair");
ok(guidePair([guide, ripple])?.ripple.id === "r", "in either order");
ok(!guidePair([guide, satin]), "no ripple, no pair");
ok(guidePaths(satin)?.length === 2, "a satin guides with its rails");
ok(guidePaths(guide)?.length === 1, "a line with itself");

const doc = { objects: [ripple, guide] } as unknown as StitchDocument;
const next = useAsRippleGuide(doc, "r", "g");
ok(next.objects.length === 1, "the guide object is taken into the ripple");
const r = next.objects[0].stitch;
ok(r.type === "running" && r.ripple?.guide?.length === 1 && r.ripple.guide[0].nodes[0].p[1] === 10, "with its line");

const g = defaultRippleGuide(ripple);
ok(!!g && g.nodes.length === 2 && Math.abs(Math.hypot(g.nodes[1].p[0] - g.nodes[0].p[0], g.nodes[1].p[1] - g.nodes[0].p[1]) - 8) < 1e-9, "a straight guide as long as the copies' spread");
