// Overlays the canvas works out from the document: Split into satins' lines and
// parts, and the GL view of a transform being dragged.

import { draftPlan } from "../components/SplitTool";
import { regionRings, regionsOf } from "../lib/regions";
import type { SplitDraft } from "../store";
import type { StitchDocument, Vec2 } from "../types";
import type { InteractiveOverlay } from "./interactive";
import { type Mat } from "../lib/geometry";
import { cutChords } from "../lib/cut";

/** Split into satins on the canvas: the shape, the lines, where the cuts cut, and the parts with their rungs (the line being dragged included). */
export function splitOverlay(doc: StitchDocument, draft: SplitDraft, live: { a: Vec2; b: Vec2; dir: boolean } | null): InteractiveOverlay["split"] {
  const shape = draft.id ? doc.objects.find((o) => o.id === draft.id) : undefined;
  const d = live && shape ? { ...draft, ...(live.dir ? { directions: [...draft.directions, [live.a, live.b] as [Vec2, Vec2]] } : { cuts: [...draft.cuts, [live.a, live.b] as [Vec2, Vec2]] }) } : draft;
  const plan = shape ? draftPlan(doc, d) : null;
  return {
    outline: shape ? regionsOf(shape).flatMap(regionRings) : null,
    cuts: d.cuts,
    directions: d.directions,
    live: live && !shape ? live : null,
    chords: shape ? d.cuts.flatMap(([a, b]) => cutChords(shape, a, b)) : [],
    parts: plan?.parts ?? [],
  };
}

/** The GL view of a drag transform: which objects (by index) and the matrix; the mask is kept while the set is the same. */
export let liveMask: { key: string; n: number; mask: Uint8Array } | null = null;
export function liveFrame(doc: StitchDocument, live: { ids: string[]; m: Mat } | null) {
  if (!live) return null;
  const key = live.ids.join(",");
  if (!liveMask || liveMask.key !== key || liveMask.n !== doc.objects.length) {
    const ids = new Set(live.ids);
    const mask = new Uint8Array(doc.objects.length);
    doc.objects.forEach((o, i) => {
      if (ids.has(o.id)) mask[i] = 255;
    });
    liveMask = { key, n: doc.objects.length, mask };
  }
  return { key, mask: liveMask.mask, m: live.m };
}
