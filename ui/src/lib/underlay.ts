// Auto underlay: what the engine chooses (crates/core/src/stitches/underlay.rs),
// described for the panel. Keep the widths in step with the engine.

import type { Fabric } from "../types";

/** Soft, stretchy or pile fabrics: heavier auto underlay. */
export const STRETCH: Fabric[] = ["knit", "fleece", "towel", "pique", "sheer"];
/** Delicate or firm fabrics where every needle hole shows: lighter. */
export const DELICATE: Fabric[] = ["silk", "leather"];
/** Pile fabrics: a knockdown keeps the embroidery from sinking in. */
export const PILE: Fabric[] = ["towel", "fleece"];

const mm = (v: number) => `${v} mm`;

/** What auto underlay does to a fill on this fabric. */
export function autoFillHint(fabric: Fabric, knockdown: boolean): string {
  if (knockdown) return "Knockdown is on: the net is the underlay, so shapes only get an edge run.";
  const [tiny, narrow] = DELICATE.includes(fabric) ? [3, 12] : STRETCH.includes(fabric) ? [2, 6] : [2.5, 8];
  const big = STRETCH.includes(fabric) ? "edge run + cross-hatched tatami" : "edge run + tatami";
  return `None under ${mm(tiny)} wide, an edge run up to ${mm(narrow)}, then ${big}.`;
}

/** What auto underlay does to a satin column on this fabric. */
export function autoSatinHint(fabric: Fabric, knockdown: boolean): string {
  const [none, center, contour] = DELICATE.includes(fabric) ? [1.5, 3, 5] : STRETCH.includes(fabric) ? [1, 2, 3] : [1.2, 2.5, 4];
  if (knockdown) return `None under ${mm(none)}, centre walk up to ${mm(center)}, then contour (the knockdown carries the rest).`;
  return `None under ${mm(none)}, centre walk up to ${mm(center)}, contour up to ${mm(contour)}, then contour + zig-zag.`;
}
