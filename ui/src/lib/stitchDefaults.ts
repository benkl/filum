// Ink/Stitch's defaults per stitch type, applied to an object's settings
// without touching its style (width, method, angle, triple / bean …): the
// panel's "Ink/Stitch" defaults button, and whether an object holds them.
// The values themselves are in lib/inkDefaults.ts (new objects start there).

import { INK_FILL_METHODS, INK_RUNNING, INK_SATIN, INK_TATAMI } from "./inkDefaults";
import type { FillParams, StitchParams } from "../types";

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

const pick = (src: Record<string, unknown>, keys: readonly string[]) => Object.fromEntries(keys.filter((k) => k in src).map((k) => [k, src[k]]));

/** The values Ink/Stitch gives this object's stitch type (null: it has none, e.g. a fill method it lacks). */
export function inkDefaults(st: StitchParams): Record<string, unknown> | null {
  switch (st.type) {
    case "running":
      if (st.ripple || st.motif) return null;
      return pick(INK_RUNNING, RUNNING_KEYS);
    case "satin":
      return pick(INK_SATIN, SATIN_KEYS);
    case "fill": {
      if (st.gradient || st.ramp) return null;
      const m = INK_FILL_METHODS[st.method];
      return m ? pick({ ...INK_TATAMI, ...m }, [...FILL_KEYS, ...(FILL_EXTRA[st.method] ?? [])]) : null;
    }
    default:
      return null;
  }
}

const same = (a: unknown, b: unknown) => (typeof a === "number" && typeof b === "number" ? Math.abs(a - b) < 1e-6 : a === b);

/** Does the object hold exactly Ink/Stitch's values? */
export function holdsInkDefaults(st: StitchParams): boolean {
  const v = inkDefaults(st);
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

/** "row spacing 0.25, underlay off …": what the Ink/Stitch defaults would change on this object. */
export function inkChanges(st: StitchParams): string[] {
  const v = inkDefaults(st);
  if (!v) return [];
  const cur = st as unknown as Record<string, unknown>;
  return Object.entries(v)
    .filter(([k, x]) => !same(cur[k] ?? (typeof x === "number" ? 0 : false), x))
    .map(([k, x]) => `${LABELS[k] ?? k} ${fmt(x)}`);
}
