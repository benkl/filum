// Auto underlay: what the engine chooses (crates/core/src/stitches/underlay.rs),
// described for the panel. The widths and fabric kinds come from the engine
// (generated/engine.ts).

import { FABRICS } from "../generated/engine";
import type { Fabric } from "../types";

const fabrics = Object.keys(FABRICS) as Fabric[];
/** Soft, stretchy or pile fabrics: heavier auto underlay. */
export const STRETCH: Fabric[] = fabrics.filter((f) => FABRICS[f].stretch);
/** Delicate or firm fabrics where every needle hole shows: lighter. */
export const DELICATE: Fabric[] = fabrics.filter((f) => FABRICS[f].delicate);
/** Pile fabrics: a knockdown keeps the embroidery from sinking in. */
export const PILE: Fabric[] = ["towel", "fleece"];

const mm = (v: number) => `${v} mm`;

/** Automatic fill underlay on a fabric (crates/core/src/stitches/underlay.rs): none under the first width (mm), an edge run only under the second. */
export function autoFillWidths(fabric: Fabric): [number, number] {
  const [none, edge] = FABRICS[fabric].autoFill;
  return [none, edge];
}

/** What auto underlay does to a fill on this fabric. */
export function autoFillHint(fabric: Fabric, knockdown: boolean): string {
  if (knockdown) return "Knockdown is on: the net is the underlay, so shapes only get an edge run.";
  const [tiny, narrow] = autoFillWidths(fabric);
  const big = STRETCH.includes(fabric) ? "edge run + cross-hatched tatami" : "edge run + tatami";
  return `None under ${mm(tiny)} wide, an edge run up to ${mm(narrow)}, then ${big}.`;
}

/** What auto underlay does to a satin column on this fabric. */
export function autoSatinHint(fabric: Fabric, knockdown: boolean): string {
  const [none, center, contour] = FABRICS[fabric].autoSatin;
  if (knockdown) return `None under ${mm(none)}, centre walk up to ${mm(center)}, then contour (the knockdown carries the rest).`;
  return `None under ${mm(none)}, centre walk up to ${mm(center)}, contour up to ${mm(contour)}, then contour + zig-zag.`;
}
