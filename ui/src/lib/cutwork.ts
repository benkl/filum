// Cutwork segmentation (Ink/Stitch extensions/cutwork_segmentation.py):
// cutwork needles are knives that each cut in a range of directions, so a
// cut line is split by direction into one line per needle (overlapping
// ranges give overlapping pieces — wanted where a knife struggles at the
// edge of its range). Each needle sews in its own colour.

import type { DesignObject, StitchDocument, Vec2 } from "../types";
import { flattenSubPath } from "./bezier";
import { uid } from "./geometry";

export interface CutworkSector {
  /** Direction range in degrees (0..180, may wrap: start > end). */
  start: number;
  end: number;
  color: string;
}

/** Ink/Stitch's four needles (start = end leaves a needle out). */
export const CUTWORK_SECTORS: CutworkSector[] = [
  { start: 112, end: 157, color: "#990000" },
  { start: 158, end: 23, color: "#e5a50a" },
  { start: 22, end: 68, color: "#009900" },
  { start: 67, end: 113, color: "#000099" },
];

/** Direction of a segment, 0..180 degrees (Ink/Stitch _get_angle). */
export function segmentAngle(a: Vec2, b: Vec2): number {
  let ang = Math.round((((Math.atan2(a[1] - b[1], a[0] - b[0]) * 180) / Math.PI) % 360 + 360) % 360);
  if (ang > 180) ang -= 180;
  return ang;
}

export const inSector = (ang: number, s: CutworkSector) => (s.start > s.end + 1 ? ang >= s.start || ang <= s.end : ang >= s.start && ang <= s.end);

/** One polyline split into the pieces each needle cuts: [needle index, points][]. */
export function segmentLine(pts: Vec2[], sectors: CutworkSector[]): [number, Vec2[]][] {
  const active = sectors.map((s, i) => [s, i] as const).filter(([s]) => s.start !== s.end);
  const open = new Map<number, Vec2[]>();
  const out: [number, Vec2[]][] = [];
  for (let k = 1; k < pts.length; k++) {
    if (pts[k][0] === pts[k - 1][0] && pts[k][1] === pts[k - 1][1]) continue;
    const ang = segmentAngle(pts[k], pts[k - 1]);
    const now = new Set(active.filter(([s]) => inSector(ang, s)).map(([, i]) => i));
    // pieces that end here
    for (const [i, piece] of [...open]) {
      if (!now.has(i)) {
        out.push([i, piece]);
        open.delete(i);
      }
    }
    for (const i of now) {
      const piece = open.get(i) ?? [pts[k - 1]];
      piece.push(pts[k]);
      open.set(i, piece);
    }
  }
  for (const [i, piece] of open) out.push([i, piece]);
  return out.filter(([, p]) => p.length >= 2);
}

/**
 * The document with `ids` (running lines) split for the cutwork needles:
 * each piece a running line (1 mm stitches, no locks) in its needle's
 * colour, sorted by needle; the originals removed or kept hidden.
 */
export function cutworkSegmentation(doc: StitchDocument, ids: string[], sectors: CutworkSector[] = CUTWORK_SECTORS, opts: { sortByNeedle?: boolean; keepOriginals?: boolean } = {}): StitchDocument {
  const { sortByNeedle = true, keepOriginals = false } = opts;
  const sel = doc.objects.filter((o) => ids.includes(o.id) && o.paths.length);
  if (!sel.length) return doc;
  const threads = [...doc.threads];
  const threadFor = (color: string, needle: number) => {
    let t = threads.find((x) => x.color.toLowerCase() === color.toLowerCase());
    if (!t) {
      t = { id: uid("t"), name: `Cutwork needle ${needle + 1}`, color, brand: "", code: "" };
      threads.push(t);
    }
    return t.id;
  };
  let pieces: { needle: number; obj: DesignObject }[] = [];
  for (const o of sel)
    for (const sp of o.paths) {
      const pts = flattenSubPath(sp, 0.2);
      const [f, l] = [pts[0], pts[pts.length - 1]];
      if (sp.closed && pts.length > 2 && (f[0] !== l[0] || f[1] !== l[1])) pts.push(f);
      for (const [needle, piece] of segmentLine(pts, sectors))
        pieces.push({
          needle,
          obj: {
            ...o,
            id: uid(),
            name: `${o.name} · needle ${needle + 1}`,
            thread: threadFor(sectors[needle].color, needle),
            paths: [{ closed: false, nodes: piece.map((p) => ({ p })) }],
            stitch: { type: "running", length: 1, tolerance: 0.2, repeats: 1, beanRepeats: 0, cutworkNeedle: needle + 1 },
            ties: "none",
            start: undefined,
            end: undefined,
            text: undefined,
            clone: undefined,
          },
        });
    }
  if (sortByNeedle) pieces = pieces.map((p, k) => ({ ...p, k })).sort((a, b) => a.needle - b.needle || a.k - b.k);
  const made = pieces.map((p) => p.obj);
  const idset = new Set(sel.map((o) => o.id));
  const at = doc.objects.findIndex((o) => idset.has(o.id));
  const rest = keepOriginals ? doc.objects.map((o) => (idset.has(o.id) ? { ...o, visible: false } : o)) : doc.objects.filter((o) => !idset.has(o.id));
  const pos = keepOriginals ? at + sel.length : Math.min(at, rest.length);
  rest.splice(pos, 0, ...made);
  return { ...doc, objects: rest, threads };
}
