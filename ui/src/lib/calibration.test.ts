// Fabric calibration (npm run test:match): the swatch, and measurements
// turned into pull compensation, column-end pull-in and fill expand.

import { BAR_L, BAR_W, DISC, calibrate, parseMm, swatchDocument } from "./calibration";
import { defaultFill, defaultSatin, setFabricDefaults } from "./geometry";

let failed = 0;
const check = (ok: boolean, msg: string) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${msg}`);
  if (!ok) failed++;
};
const near = (a: number | undefined, b: number) => a != null && Math.abs(a - b) < 1e-9;

// the swatch
const machine = { trimDistance: 3, ties: true, minStitch: 0.3, maxStitch: 12.1, spm: 800, trimSeconds: 6, colorChangeSeconds: 12 };
const sw = swatchDocument("knit", machine, 40);
const pieces = sw.objects.filter((o) => o.stitch.type !== "running");
check(sw.fabric === "knit" && sw.hoop.width === 100 && sw.hoop.height === 100, "a 100 × 100 mm swatch on the fabric being calibrated");
check(pieces.length === 4 && sw.objects.length === 8, "four pieces, each with a running-stitch letter");
check(
  pieces.every((o) => (o.stitch.type === "satin" ? o.stitch.pullComp === 0 && o.stitch.pushComp === 0 : o.stitch.type === "fill" && o.stitch.pullComp === 0 && o.stitch.expand === 0)),
  "no compensation of its own",
);
const fills = pieces.filter((o) => o.stitch.type === "fill").map((o) => (o.stitch.type === "fill" ? o.stitch.angle : -1));
check(fills.join() === "0,90", "the discs: rows across, rows up and down");

// nothing measured
const none = calibrate({});
check(!none.satin && !none.fill && !none.notes.length, "nothing measured, nothing to save");

// a satin pulled in 0.6 mm and pushed out 0.8 mm; a disc 0.5 mm narrower along and 0.4 mm longer across
const r = calibrate({ cAlong: BAR_W - 0.6, cAcross: BAR_L + 0.8, dAlong: BAR_W - 0.6, dAcross: BAR_L + 0.8, aAlong: DISC - 0.5, aAcross: DISC + 0.4, bAlong: DISC - 0.5, bAcross: DISC + 0.4 });
check(near(r.satin?.pullComp, 0.6), "satin: pull compensation in total = how much narrower it sewed");
check(near(r.satin?.pushComp, 0.4), "satin: each end pulled in by half of the extra length");
check(near(r.fill?.expand, -0.2), "fill: the shape drawn smaller by half the push on each side");
check(near(r.fill?.pullComp, 0.45), "fill: rows reach out by half the pull plus what the smaller shape lost");
check(!r.notes.length, "plausible numbers raise no notes");

// one piece of each pair is enough
const half = calibrate({ cAlong: 3.5, cAcross: 30 });
check(near(half.satin?.pullComp, 0.5) && near(half.satin?.pushComp, 0) && !half.fill, "one bar calibrates satins only");

// sewn wider than drawn: no negative compensation
const wide = calibrate({ cAlong: 4.6, cAcross: 29.2 });
check(near(wide.satin?.pullComp, 0) && near(wide.satin?.pushComp, 0) && wide.notes.length === 2, "wider and shorter bars: nothing to compensate, and a note each");

// a fabric that gives more one way
const dir = calibrate({ aAlong: 22.8, aAcross: 24, bAlong: 23.8, bAcross: 24 });
check(dir.notes.some((n) => n.startsWith("Disc A pulled in")), "discs that differ point at the fabric's direction");

// a typo
check(calibrate({ cAlong: 40, cAcross: 30 }).notes[0]?.startsWith("Check C along"), "a measurement far from the drawing is questioned");

check(parseMm("3,45") === 3.45 && parseMm(" 24 ") === 24 && parseMm("") === undefined && parseMm("abc") === undefined, "commas and spaces in numbers");

// new objects start from the calibration
setFabricDefaults(() => ({ satin: { pullComp: 0.6, pushComp: 0.4 }, fill: { pullComp: 0.45, expand: -0.2 } }));
check(defaultSatin().pullComp === 0.6 && defaultSatin().pushComp === 0.4 && defaultSatin().width === 3, "new satins take the calibrated numbers");
check(defaultFill().pullComp === 0.45 && defaultFill().expand === -0.2 && defaultFill().method === "tatami", "new fills take the calibrated numbers");
const sw2 = swatchDocument("cotton", machine);
check(sw2.objects.every((o) => (o.stitch.type === "satin" ? o.stitch.pullComp === 0 : o.stitch.type === "fill" ? o.stitch.pullComp === 0 && o.stitch.expand === 0 : true)), "the swatch itself ignores any calibration");
setFabricDefaults(() => ({}));
check(defaultSatin().pullComp === 0.2, "without a calibration: the standard numbers");

if (failed) throw new Error(`${failed} calibration check(s) failed`);
console.log("all passed");
