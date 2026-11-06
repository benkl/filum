// A design read from a file or the autosave, made safe to load: the fields
// every part of the app reads are there and of the right kind. Objects that
// can't be drawn at all are left out (and counted).

import type { DesignObject, StitchDocument } from "../types";

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const finite2 = (v: unknown) => Array.isArray(v) && v.length >= 2 && Number.isFinite(v[0]) && Number.isFinite(v[1]);

function usable(o: unknown): o is DesignObject {
  if (!isObj(o) || typeof o.id !== "string" || !o.id) return false;
  if (!Array.isArray(o.paths) || !isObj(o.stitch) || typeof o.stitch.type !== "string") return false;
  return o.paths.every((sp) => isObj(sp) && Array.isArray(sp.nodes) && sp.nodes.every((n) => isObj(n) && finite2(n.p)));
}

/**
 * `raw` on top of `base` (an empty design): null when it isn't a design at
 * all, else the design and how many objects were left out.
 */
export function checkDoc(raw: unknown, base: StitchDocument): { doc: StitchDocument; dropped: number } | null {
  if (!isObj(raw) || !Array.isArray(raw.objects)) return null;
  const objects = raw.objects.filter(usable).map((o) => ({
    ...o,
    name: typeof o.name === "string" ? o.name : "Object",
    visible: o.visible !== false,
    locked: !!o.locked,
  }));
  // unique ids (a hand-edited or merged file may repeat one)
  const seen = new Set<string>();
  const unique = objects.filter((o) => !seen.has(o.id) && !!seen.add(o.id));
  const threads = Array.isArray(raw.threads) ? raw.threads.filter((t) => isObj(t) && typeof t.id === "string" && typeof t.color === "string") : [];
  const doc = {
    ...base,
    ...raw,
    objects: unique,
    threads: threads as StitchDocument["threads"],
    machine: { ...base.machine, ...(isObj(raw.machine) ? raw.machine : {}) },
    hoop: isObj(raw.hoop) && Number.isFinite(raw.hoop.width) && Number.isFinite(raw.hoop.height) ? (raw.hoop as unknown as StitchDocument["hoop"]) : base.hoop,
    options: { ...base.options, ...(isObj(raw.options) ? raw.options : {}) },
  } as StitchDocument;
  // every object's thread exists (a missing one gets the first, or a default)
  if (!doc.threads.length && unique.length) doc.threads = [{ id: "t1", name: "Thread", color: "#1f2a56", brand: "", code: "" } as StitchDocument["threads"][number]];
  const ids = new Set(doc.threads.map((t) => t.id));
  doc.objects = doc.objects.map((o) => (typeof o.thread === "string" && ids.has(o.thread) ? o : { ...o, thread: doc.threads[0].id }));
  return { doc, dropped: raw.objects.length - unique.length };
}
