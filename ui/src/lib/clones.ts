// Linked clones (Ink/Stitch / Inkscape clones): an object that follows
// another one — its shape and stitch settings — through its own transform.
// The engine sees ordinary objects: the store re-derives every clone from
// its original after each change. A clone can keep its own fill angle
// (Ink/Stitch's clone `angle`) and be unlinked into a plain copy.
//
// Shared: the SVG importer's <use> clones, the Edit menu and lettering can
// make clones the same way.

import type { DesignObject, StitchDocument } from "../types";
import { mulMat, transformObject, translateMat, uid, type Mat } from "./geometry";

export interface CloneLink {
  /** The original's id. */
  of: string;
  /** Original → clone transform, and the rotation it contains (degrees, rotateAbout's sign). */
  m: Mat;
  rot: number;
  /** Own fill angle (Ink/Stitch clone `angle`), instead of the original's turned with the clone. */
  angle?: number;
}

export { mulMat };

// derived shapes, cached per original object (unchanged originals give the same objects)
const cache = new WeakMap<DesignObject, Map<string, Pick<DesignObject, "paths" | "stitch" | "thread">>>();

function derive(src: DesignObject, link: CloneLink): Pick<DesignObject, "paths" | "stitch" | "thread"> {
  const key = JSON.stringify([link.m, link.rot, link.angle]);
  let m = cache.get(src);
  if (!m) cache.set(src, (m = new Map()));
  const hit = m.get(key);
  if (hit) return hit;
  const t = transformObject({ ...src, clone: undefined }, link.m, link.rot);
  let stitch = t.stitch;
  if (stitch.type === "fill" && link.angle != null) stitch = { ...stitch, angle: link.angle };
  const out = { paths: t.paths, stitch, thread: src.thread };
  m.set(key, out);
  return out;
}

export function invMat(m: Mat): Mat {
  const det = m[0] * m[3] - m[1] * m[2] || 1e-12;
  const [a, b, c, d] = [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det];
  return [a, b, c, d, -(a * m[4] + c * m[5]), -(b * m[4] + d * m[5])];
}

/** The link after the original and the clone were both transformed by `t` (they keep their relation). */
export function conjugate(link: CloneLink, t: Mat): CloneLink {
  return { ...link, m: mulMat(mulMat(t, link.m), invMat(t)) };
}

/**
 * Every clone made to follow its original again; clones of deleted
 * originals become plain objects. With `prev` (the document before the
 * change): a clone transformed together with its original keeps its place
 * relative to it.
 */
export function syncClones(doc: StitchDocument, prev?: StitchDocument): StitchDocument {
  if (!doc.objects.some((o) => o.clone)) return doc;
  if (prev) {
    const before = new Map(prev.objects.map((o) => [o.id, o]));
    const now = new Map(doc.objects.map((o) => [o.id, o]));
    let fixed = false;
    const objects = doc.objects.map((o) => {
      const was = before.get(o.id);
      const src = o.clone && now.get(o.clone.of);
      if (!o.clone || !was?.clone || !src || src === before.get(o.clone.of)) return o;
      if (was.clone.m.every((v, i) => Math.abs(v - o.clone!.m[i]) < 1e-12)) return o;
      // both changed: the clone was transformed by t (m = t · m_old) together with its original
      const t = mulMat(o.clone.m, invMat(was.clone.m));
      fixed = true;
      return { ...o, clone: { ...o.clone, m: mulMat(o.clone.m, invMat(t)) } };
    });
    if (fixed) doc = { ...doc, objects };
  }
  const byId = new Map(doc.objects.map((o) => [o.id, o]));
  let changed = false;
  const resolve = (o: DesignObject, depth = 0): DesignObject => {
    const link = o.clone;
    if (!link) return o;
    const src0 = byId.get(link.of);
    if (!src0 || depth > 8 || src0.id === o.id) {
      changed = true;
      const { clone: _c, ...rest } = o;
      void _c;
      return rest;
    }
    // a clone of a clone follows the resolved one
    const src = src0.clone ? resolve(src0, depth + 1) : src0;
    const d = derive(src, link);
    if (o.paths === d.paths && o.stitch === d.stitch && o.thread === d.thread) return o;
    changed = true;
    return { ...o, ...d };
  };
  const objects = doc.objects.map((o) => resolve(o));
  return changed ? { ...doc, objects } : doc;
}

/** A linked clone of `o`, shifted by `offset` mm. */
export function makeClone(o: DesignObject, offset = 5): DesignObject {
  const link: CloneLink = o.clone ? { ...o.clone, m: mulMat(translateMat(offset, offset), o.clone.m) } : { of: o.id, m: translateMat(offset, offset), rot: 0 };
  const base = { ...o, id: uid(), name: `${o.name.replace(/ clone( \d+)?$/, "")} clone`, clone: link, start: undefined, end: undefined, text: undefined, group: undefined };
  const src = o.clone ? undefined : o;
  return src ? { ...base, ...derive(src, link) } : { ...base, ...transformObject({ ...o, clone: undefined }, translateMat(offset, offset)) };
}

/** The clone as a plain object (it stops following its original). */
export function unlinkClone(o: DesignObject): DesignObject {
  const { clone: _c, ...rest } = o;
  void _c;
  return rest;
}

/** How many clones follow `id`. */
export const clonesOf = (doc: StitchDocument, id: string) => doc.objects.filter((o) => o.clone?.of === id);
