// Changing objects in a document without touching the others: the document
// keeps every other object as it is (same identity), so caches keyed by
// object stay valid.

import type { DesignObject, StitchDocument } from "../types";

/** The document with `next` in place of the object `id`. */
export function replaceObject(d: StitchDocument, id: string, next: DesignObject): StitchDocument {
  return { ...d, objects: d.objects.map((x) => (x.id === id ? next : x)) };
}

/** The document with the objects `ids` (one id or several) changed by `fn`. */
export function mapObjects(d: StitchDocument, ids: string | Iterable<string>, fn: (o: DesignObject) => DesignObject): StitchDocument {
  const set = typeof ids === "string" ? null : ids instanceof Set ? (ids as Set<string>) : new Set(ids);
  return { ...d, objects: d.objects.map((x) => ((set ? set.has(x.id) : x.id === ids) ? fn(x) : x)) };
}
