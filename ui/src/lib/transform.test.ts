// transformObject: what is stored next to the paths travels with them.
import type { DesignObject, Vec2 } from "../types";
import { rotateAbout, scaleAbout, transformObject, translateMat } from "./geometry";

function ok(c: unknown, msg: string) {
  if (!c) throw new Error(msg);
  console.log("ok  ", msg);
}
const near = (a: readonly number[] | undefined, b: number[]) => !!a && a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < 1e-9);

const base = { name: "x", thread: "t", visible: true, locked: false, trimAfter: false, stopAfter: false };

// a satin's direction guides (rungs) move, turn and mirror with its rails
const satin = {
  ...base,
  id: "s",
  paths: [
    { closed: false, nodes: [{ p: [0, 0] }, { p: [40, 0] }] },
    { closed: false, nodes: [{ p: [0, 8] }, { p: [40, 8] }] },
  ],
  stitch: { type: "satin", width: 8, guides: [[[10, -1], [14, 9]]] },
} as unknown as DesignObject;
const guide = (o: DesignObject) => (o.stitch.type === "satin" ? o.stitch.guides?.[0] : undefined);
const moved = transformObject(satin, translateMat(10, 5));
ok(near(guide(moved)?.flat(), [20, 4, 24, 14]), "a moved satin's guide moves with it");
const mirrored = transformObject(satin, scaleAbout(-1, 1, 20, 4));
ok(near(guide(mirrored)?.flat(), [30, -1, 26, 9]), "a mirrored satin's guide is mirrored too");
const turned = guide(transformObject(satin, rotateAbout(90, 20, 4)))!;
ok(near(turned[0] as Vec2, [25, -6]), `a turned satin's guide turns with it (got ${JSON.stringify(turned)})`);
ok(near(guide(satin)?.flat(), [10, -1, 14, 9]), "the original satin is left as it was");

// a radial fill's centre (relative to the shape's box) stays on the same point of the shape
const radial = {
  ...base,
  id: "f",
  paths: [{ closed: true, nodes: [{ p: [10, 10] }, { p: [50, 10] }, { p: [50, 30] }, { p: [10, 30] }] }],
  stitch: { type: "fill", method: "radial", angle: 0, rowSpacing: 0.4, maxStitchLength: 3, center: [0.2, 0.25] },
} as unknown as DesignObject;
const centre = (o: DesignObject) => (o.stitch.type === "fill" ? o.stitch.center : undefined);
ok(near(centre(transformObject(radial, translateMat(10, 5))), [0.2, 0.25]), "moving keeps the relative centre");
ok(near(centre(transformObject(radial, scaleAbout(2, 2, 0, 0))), [0.2, 0.25]), "scaling keeps it");
ok(near(centre(transformObject(radial, scaleAbout(-1, 1, 30, 20))), [0.8, 0.25]), "a horizontal mirror puts the centre on the mirrored point");
ok(near(centre(transformObject(radial, scaleAbout(1, -1, 30, 20))), [0.2, 0.75]), "a vertical mirror too");
// a quarter turn of the 40 × 20 box about its centre: the point (18, 15) lands at (35, 8) in a 20 × 40 box at (20, 0)
ok(near(centre(transformObject(radial, rotateAbout(90, 30, 20))), [0.75, 0.2]), "a quarter turn keeps the centre on the same point of the shape");
ok(near(centre(radial), [0.2, 0.25]), "the original fill is left as it was");
