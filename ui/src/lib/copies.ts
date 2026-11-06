// Copies of objects that stand on their own: duplicate, paste, Alt-drag,
// repeat and importing a design into another. The copies' groups, letterings,
// gradients, tartans and colour blends get new ids, so editing a copy never
// reaches back into the original (and the original's edits never delete the copy).

import type { DesignObject, Thread } from "../types";
import { uid } from "./geometry";
import { copiedParents, type GroupDoc } from "./groups";

/** Every thread an object refers to (its own and its lettering's). */
export const threadsOf = (o: DesignObject): string[] => [o.thread, ...(o.text ? [o.text.thread, o.text.borderThread, ...(o.text.palette ?? [])] : [])];

/** The object with its thread references passed through `f`. */
export function remapThreads(o: DesignObject, f: (id: string) => string): DesignObject {
  if (!threadsOf(o).some((id) => f(id) !== id)) return o;
  return {
    ...o,
    thread: f(o.thread),
    ...(o.text ? { text: { ...o.text, thread: f(o.text.thread), borderThread: f(o.text.borderThread), ...(o.text.palette ? { palette: o.text.palette.map(f) } : {}) } } : {}),
  };
}

/**
 * Threads coming in from another design (or the clipboard) merged into `have`:
 * a thread of the same colour is reused; an id that names another colour here
 * gets a new id. Returns the threads to add and how the incoming ids map.
 */
export function mergeThreads(have: Thread[], incoming: Thread[]): { add: Thread[]; map: Map<string, string> } {
  const map = new Map<string, string>();
  const add: Thread[] = [];
  const all = [...have];
  for (const t of incoming) {
    const sameColor = (x: Thread) => x.color.toLowerCase() === t.color.toLowerCase();
    const same = all.find((x) => x.id === t.id && sameColor(x)) ?? all.find(sameColor);
    if (same) {
      map.set(t.id, same.id);
      continue;
    }
    const id = all.some((x) => x.id === t.id) ? uid("t") : t.id;
    const nt = { ...t, id };
    add.push(nt);
    all.push(nt);
    map.set(t.id, id);
  }
  return { add, map };
}

/**
 * Copies of `objs` (taken from `doc`) with new ids for the objects and for
 * every group they belong to. `parents` is the nesting of the new groups,
 * `names` their names, `ids` how the object ids map (for linked clones).
 */
export function freshCopies(doc: GroupDoc, objs: DesignObject[]): { objects: DesignObject[]; parents: Record<string, string>; names: Record<string, string>; ids: Map<string, string> } {
  const map = new Map<string, string>();
  const re = (k: string, prefix: string) => {
    if (!map.has(k)) map.set(k, uid(prefix));
    return map.get(k)!;
  };
  const ids = new Map(objs.map((o) => [o.id, uid()]));
  const parents = copiedParents(doc, objs, (g) => re(g, "g"));
  const objects = objs.map((o) => {
    const c: DesignObject = { ...structuredClone(o), id: ids.get(o.id)! };
    if (c.group) c.group = re(c.group, "g");
    if (c.text) c.text = { ...c.text, group: re(c.text.group, "txt") };
    if (c.stitch.type === "fill") {
      const st = c.stitch;
      c.stitch = {
        ...st,
        ...(st.gradient ? { gradient: { ...st.gradient, group: re(st.gradient.group, "g") } } : {}),
        ...(st.tartan ? { tartan: { ...st.tartan, group: re(st.tartan.group, "g") } } : {}),
        ...(st.ramp?.group ? { ramp: { ...st.ramp, group: re(st.ramp.group, "blend") } } : {}),
      };
    }
    return c;
  });
  const names: Record<string, string> = {};
  for (const [old, now] of map) if (doc.groupNames?.[old]) names[now] = doc.groupNames[old];
  return { objects, parents, names, ids };
}
