// User-drawn stitch patterns (Ink/Stitch "selection to pattern"): lines
// drawn over an object add a needle point wherever a stitch crosses them,
// shapes drawn over it leave the needle points inside them out. The
// pattern objects move into the stitched object.

import type { DesignObject, StitchDocument, StitchPattern } from "../types";
import { objectBounds } from "./geometry";

const area = (o: DesignObject) => {
  const b = objectBounds(o);
  return b ? b.w * b.h : 0;
};

/** Of several selected objects: the one to stitch (the largest) and the patterns drawn over it. */
export function patternPair(objects: DesignObject[]): { target: DesignObject; patterns: DesignObject[] } | null {
  const usable = objects.filter((o) => o.paths.some((p) => p.nodes.length >= 2));
  if (usable.length < 2) return null;
  const target = [...usable].sort((a, b) => area(b) - area(a))[0];
  return { target, patterns: usable.filter((o) => o !== target) };
}

/** A pattern from an object: closed shapes leave points out, lines add them. */
export function patternOf(o: DesignObject): StitchPattern {
  const closed = o.paths.every((p) => p.closed);
  return { paths: o.paths.map((p) => ({ ...p, nodes: p.nodes.map((n) => ({ ...n })) })), add: !closed, remove: closed, interval: [], offset: 0 };
}

/** The document with `patternIds` turned into stitch patterns of `targetId`. */
export function applyPatterns(doc: StitchDocument, targetId: string, patternIds: string[]): StitchDocument {
  const ids = new Set(patternIds);
  const pats = doc.objects.filter((o) => ids.has(o.id)).map(patternOf);
  if (!pats.length) return doc;
  return {
    ...doc,
    objects: doc.objects.filter((o) => !ids.has(o.id)).map((o) => (o.id === targetId ? { ...o, patterns: [...(o.patterns ?? []), ...pats] } : o)),
  };
}
