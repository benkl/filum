// Screen calibration: actual size from a ruler, kept across interface zoom (npm run test:match).

import { CSS_PX_PER_MM, calibrationFrom, dpiOf, pxPerMm, validCalibration } from "./screen";

let failed = 0;
const check = (ok: boolean, msg: string) => {
  if (!ok) {
    failed++;
    console.log("FAIL", msg);
  } else console.log("ok  ", msg);
};
const near = (a: number | undefined, b: number, e = 1e-6) => typeof a === "number" && Math.abs(a - b) < e;

check(near(pxPerMm(undefined, 1), 96 / 25.4), "not calibrated: 96 dpi");
check(near(pxPerMm(Number.NaN, 2), CSS_PX_PER_MM) && near(pxPerMm(500, 1), CSS_PX_PER_MM), "nonsense calibrations are ignored");

// a bar of 400 CSS px measured 85.6 mm at a pixel ratio of 1.25
const cal = calibrationFrom(400, 85.6, 1.25);
check(near(cal, (400 * 1.25) / 85.6, 1e-3), "the calibration is kept in device px per mm");
check(near(pxPerMm(cal, 1.25), 400 / 85.6, 1e-3), "at the same ratio: the measured CSS px per mm");
check(near(pxPerMm(cal, 1.5), (400 * 1.25) / 85.6 / 1.5, 1e-3), "the interface zoomed in: fewer CSS px per mm, the same real size");
check(calibrationFrom(0, 85.6, 1) === undefined && calibrationFrom(400, 0, 1) === undefined, "nothing measured: no calibration");
check(calibrationFrom(10, 85.6, 1) === undefined, "a typing error (3 dpi) is refused");
check(validCalibration(4.5) && !validCalibration(0.5) && !validCalibration("4"), "valid range");
check(dpiOf(CSS_PX_PER_MM, 1) === 96 && dpiOf(CSS_PX_PER_MM, 2) === 192, "shown as dpi");

console.log(failed ? `${failed} FAILED` : "all passed");
if (failed) throw new Error(`${failed} screen checks failed`);
