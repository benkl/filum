// Ink/Stitch's own default values: every new fill, satin and line starts from
// these, and the panel's "Ink/Stitch defaults" button puts an object back to
// them.
//
// From inkstitch/inkstitch main (d225262): lib/elements/satin_column/
// satin_column.py, fill_stitch.py, stroke.py — in Filum's units: Ink/Stitch's
// satin pull compensation is per side (ours: in total), so 0 stays 0; its
// zig-zag underlay inset defaults to half the contour inset (0.2 mm); fill
// underlay stitch length follows the fill's maximum stitch length (4 mm);
// underlay is on for every fill but cross stitch, off for satins.

import type { FillParams } from "../types";

export const INK_RUNNING = { length: 2.5, tolerance: 0.2, repeats: 1, beanRepeats: 0 };

export const INK_SATIN = {
  spacing: 0.4,
  pullComp: 0,
  pullCompPct: 0,
  maxStitchLength: 0,
  shortStitchInset: 0.15,
  centerWalk: false,
  contourUnderlay: false,
  contourInset: 0.4,
  zigzagUnderlay: false,
  zigzagUnderlaySpacing: 3,
  zigzagUnderlayInset: 0.2,
  underlayAuto: false,
};

export const INK_TATAMI = {
  rowSpacing: 0.25,
  endRowSpacing: 0,
  maxStitchLength: 4,
  staggers: 4,
  pullComp: 0,
  underlay: true,
  underlayAngle: 90,
  underlaySpacing: 0.75,
  underlayInset: 0,
  underlayStitchLength: 4,
  underlayAuto: false,
  travelLength: 2.5,
};

/** Ink/Stitch's own values for the fill methods it shares with Filum (on top of tatami's). */
export const INK_FILL_METHODS: Partial<Record<FillParams["method"], Partial<FillParams>>> = {
  tatami: {},
  contour: { rowSpacing: 0.25, maxStitchLength: 4 },
  spiral: { rowSpacing: 0.25, maxStitchLength: 4 },
  guided: { rowSpacing: 0.25, maxStitchLength: 4 },
  circular: { rowSpacing: 0.25, maxStitchLength: 2.5 },
  meander: { maxStitchLength: 2.5, meanderScale: 2.5, smoothness: 0, underlay: true },
  cross: { crossSize: 3, crossCoverage: 0.5, underlay: false },
};
