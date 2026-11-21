// How big a millimetre is on this screen. Browsers assume 96 dpi (3.78 CSS px
// per mm), which few screens are, so "actual size" is only actual once the
// screen is calibrated against a ruler. The calibration is kept in device
// pixels per mm: a change of the interface zoom (devicePixelRatio) changes
// the CSS pixels a millimetre takes, not the device pixels.

/** CSS pixels per mm the browser assumes (96 dpi). */
export const CSS_PX_PER_MM = 96 / 25.4;

/** A bank card's width (ISO/IEC 7810 ID-1), a ruler everyone has (mm). */
export const CARD_WIDTH_MM = 85.6;

/** Calibrations outside this range are typing errors (device px per mm: ~40 to ~2400 dpi). */
export const MIN_DEVICE_PX_PER_MM = 1.5;
export const MAX_DEVICE_PX_PER_MM = 95;

const dpr = () => (typeof window !== "undefined" && window.devicePixelRatio > 0 ? window.devicePixelRatio : 1);

/** A calibration (device px per mm) worth keeping: a finite number in range. */
export const validCalibration = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= MIN_DEVICE_PX_PER_MM && v <= MAX_DEVICE_PX_PER_MM;

/** CSS px per mm: from the calibration (device px per mm) at the current pixel ratio, else 96 dpi. */
export function pxPerMm(calibrated: number | undefined, ratio = dpr()): number {
  return validCalibration(calibrated) ? calibrated / ratio : CSS_PX_PER_MM;
}

/** The calibration (device px per mm) for `cssPx` CSS pixels measuring `mm` on screen. */
export function calibrationFrom(cssPx: number, mm: number, ratio = dpr()): number | undefined {
  if (!(cssPx > 0) || !(mm > 0)) return undefined;
  const v = (cssPx * ratio) / mm;
  return validCalibration(v) ? +v.toFixed(4) : undefined;
}

/** The screen's density in dots per inch, for showing (CSS px at the current ratio). */
export const dpiOf = (cssPxPerMm: number, ratio = dpr()) => Math.round(cssPxPerMm * ratio * 25.4);
