// The bytes of a .filum project. Numbers are written with at most six decimals
// (11.399999999999999 → 11.4): a millionth of a millimetre or of a degree is far
// below anything a machine sews, and the file gets smaller and readable.

import type { StitchDocument } from "../types";

/** A number with at most six decimals; whole numbers stay as they are. */
export function tidyNumber(x: number): number {
  if (Number.isInteger(x) || !Number.isFinite(x)) return x;
  const r = Number(x.toFixed(6));
  return r === 0 ? 0 : r; // no -0
}

/** The project as JSON text, every number tidied. */
export const projectJson = (doc: StitchDocument) => JSON.stringify(doc, (_k, v) => (typeof v === "number" ? tidyNumber(v) : v), 1);

export const projectBytes = (doc: StitchDocument) => new TextEncoder().encode(projectJson(doc));
