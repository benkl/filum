// Default sets per stitch type: Filum's own and Ink/Stitch's, applied
// to an object's settings without touching its style (width, method, angle,
// triple / bean …).
//
// Ink/Stitch values from inkstitch/inkstitch main (d225262):
// lib/elements/satin_column/satin_column.py, fill_stitch.py, stroke.py —
// converted to our units: Ink/Stitch's satin pull compensation is per side
// (ours: in total), so 0 stays 0; its zig-zag underlay inset defaults to half
// the contour inset (0.2 mm); fill underlay stitch length follows the fill's
// maximum stitch length (4 mm); underlay is on for every fill but cross stitch.

import { defaultFill, defaultRunning, defaultSatin, fillMethodDefaults } from "./geometry";
import type { FillParams, StitchParams } from "../types";

export type DefaultSetId = "filum" | "inkstitch";

export const DEFAULT_SETS: { id: DefaultSetId; label: string; hint: string }[] = [
  { id: "filum", label: "Filum", hint: "Filum's defaults" },
  { id: "inkstitch", label: "Ink/Stitch", hint: "Ink/Stitch's defaults (from its source)" },
];

const RUNNING_KEYS = ["length", "tolerance"] as const;
const SATIN_KEYS = [
  "spacing",
  "pullComp",
  "pullCompPct",
  "maxStitchLength",
  "shortStitchInset",
  "centerWalk",
  "contourUnderlay",
  "contourInset",
  "zigzagUnderlay",
  "zigzagUnderlaySpacing",
  "zigzagUnderlayInset",
  "underlayAuto",
] as const;
const FILL_KEYS = [
  "rowSpacing",
  "endRowSpacing",
  "maxStitchLength",
  "staggers",
  "pullComp",
  "underlay",
  "underlayAngle",
  "underlaySpacing",
  "underlayInset",
  "underlayStitchLength",
  "underlayAuto",
  "travelLength",
] as const;
const FILL_EXTRA: Partial<Record<FillParams["method"], string[]>> = {
  meander: ["meanderScale", "smoothness"],
  cross: ["crossSize", "crossCoverage"],
};

const INK_RUNNING = { length: 2.5, tolerance: 0.2 };
const INK_SATIN = {
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
const INK_TATAMI = {
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
/** Ink/Stitch fill methods we share; others have no Ink/Stitch default. */
const INK_FILL: Partial<Record<FillParams["method"], Record<string, unknown>>> = {
  tatami: {},
  contour: { rowSpacing: 0.25, maxStitchLength: 4 },
  spiral: { rowSpacing: 0.25, maxStitchLength: 4 },
  guided: { rowSpacing: 0.25, maxStitchLength: 4 },
  circular: { rowSpacing: 0.25, maxStitchLength: 2.5 },
  meander: { maxStitchLength: 2.5, meanderScale: 2.5, smoothness: 0, underlay: true },
  cross: { crossSize: 3, crossCoverage: 0.5, underlay: false },
};

const pick = (src: Record<string, unknown>, keys: readonly string[]) => Object.fromEntries(keys.filter((k) => k in src).map((k) => [k, src[k]]));

/** The values a default set gives this object's stitch type (null: the set has none). */
export function defaultValues(set: DefaultSetId, st: StitchParams): Record<string, unknown> | null {
  switch (st.type) {
    case "running":
      if (st.ripple || st.motif) return null;
      return pick(set === "inkstitch" ? INK_RUNNING : defaultRunning(), RUNNING_KEYS);
    case "satin":
      return pick((set === "inkstitch" ? INK_SATIN : defaultSatin()) as unknown as Record<string, unknown>, SATIN_KEYS);
    case "fill": {
      if (st.gradient || st.ramp) return null;
      const keys = [...FILL_KEYS, ...(FILL_EXTRA[st.method] ?? [])];
      if (set === "inkstitch") {
        const m = INK_FILL[st.method];
        return m ? pick({ ...INK_TATAMI, ...m }, keys) : null;
      }
      return pick({ ...defaultFill(), ...fillMethodDefaults(st.method) }, keys);
    }
    default:
      return null;
  }
}

const same = (a: unknown, b: unknown) => (typeof a === "number" && typeof b === "number" ? Math.abs(a - b) < 1e-6 : a === b);

/** Does the object hold exactly this set's values? */
export function matchesSet(set: DefaultSetId, st: StitchParams): boolean {
  const v = defaultValues(set, st);
  if (!v) return false;
  const cur = st as unknown as Record<string, unknown>;
  return Object.entries(v).every(([k, x]) => same(cur[k] ?? (typeof x === "number" ? 0 : false), x));
}

const LABELS: Record<string, string> = {
  length: "stitch length",
  tolerance: "tolerance",
  spacing: "spacing",
  pullComp: "pull compensation",
  pullCompPct: "pull compensation %",
  maxStitchLength: "max. stitch length",
  shortStitchInset: "short stitch inset",
  centerWalk: "centre-walk underlay",
  contourUnderlay: "contour underlay",
  contourInset: "contour inset",
  zigzagUnderlay: "zig-zag underlay",
  zigzagUnderlaySpacing: "zig-zag underlay spacing",
  zigzagUnderlayInset: "zig-zag underlay inset",
  rowSpacing: "row spacing",
  endRowSpacing: "end row spacing",
  staggers: "staggers",
  underlay: "underlay",
  underlayAngle: "underlay angle",
  underlaySpacing: "underlay spacing",
  underlayInset: "underlay inset",
  underlayStitchLength: "underlay stitch length",
  underlayAuto: "auto underlay",
  travelLength: "travel length",
  meanderScale: "meander scale",
  smoothness: "smoothness",
  crossSize: "cross size",
  crossCoverage: "coverage",
};

const fmt = (v: unknown) => (typeof v === "boolean" ? (v ? "on" : "off") : typeof v === "number" ? String(+v.toFixed(3)) : String(v));

/** "row spacing 0.25, underlay off …": what applying the set changes on this object. */
export function setChanges(set: DefaultSetId, st: StitchParams): string[] {
  const v = defaultValues(set, st);
  if (!v) return [];
  const cur = st as unknown as Record<string, unknown>;
  return Object.entries(v)
    .filter(([k, x]) => !same(cur[k] ?? (typeof x === "number" ? 0 : false), x))
    .map(([k, x]) => `${LABELS[k] ?? k} ${fmt(x)}`);
}
