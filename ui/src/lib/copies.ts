// Copies of objects that stand on their own: duplicate, paste, Alt-drag,
// repeat and importing a design into another. The copies' groups, letterings,
// gradients, tartans and colour blends get new ids, so editing a copy never
// reaches back into the original (and the original's edits never delete the copy).

import type { DesignObject, Thread } from "../types";
import { conjugate } from "./clones";
import { transformObject, uid, type Mat } from "./geometry";
import { layerFixes } from "./fillLayers";
import { copiedParents, objectsIn, type GroupDoc } from "./groups";

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
    // the same colour of the same thread (a Madeira red and an Isacord red stay two threads);
    // a thread without a brand or code (a DST's, a colour picked by hand) matches any of its colour
    const color = (x: Thread) => x.color.toLowerCase() === t.color.toLowerCase();
    const fits = (a?: string, b?: string) => !a || !b || a.trim().toLowerCase() === b.trim().toLowerCase();
    const exact = (x: Thread) => color(x) && (x.code ?? "") === (t.code ?? "") && (x.brand ?? "") === (t.brand ?? "");
    const loose = (x: Thread) => color(x) && fits(x.brand, t.brand) && fits(x.code, t.code);
    const same = all.find((x) => x.id === t.id && exact(x)) ?? all.find(exact) ?? all.find((x) => x.id === t.id && loose(x)) ?? all.find(loose);
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
 * the groups they belong to. `inPlace` (duplicate, Alt-drag, repeat): a
 * group copied only in part keeps the copies (they stay beside the
 * originals); without it (paste, import) every group is new. Gradients,
 * tartans, blends and letterings are always new. A linked clone whose
 * original is copied too follows that copy. `parents` is the nesting of the
 * new groups, `names` their names, `ids` how the object ids map.
 */
export function freshCopies(
  doc: GroupDoc,
  objs: DesignObject[],
  opts: { inPlace?: boolean } = {},
): { objects: DesignObject[]; parents: Record<string, string>; names: Record<string, string>; ids: Map<string, string> } {
  const map = new Map<string, string>();
  const re = (k: string, prefix: string) => {
    if (!map.has(k)) map.set(k, uid(prefix));
    return map.get(k)!;
  };
  const ids = new Map(objs.map((o) => [o.id, uid()]));
  const fixed = new Set(doc.objects.flatMap((o) => (o.stitch.type === "fill" ? [o.stitch.gradient?.group, o.stitch.tartan?.group].filter((g): g is string => !!g) : [])));
  const whole = (g: string) => objectsIn(doc, g).every((o) => ids.has(o.id));
  const reGroup = (g: string) => (!opts.inPlace || fixed.has(g) || whole(g) ? re(g, "g") : g);
  const parents = copiedParents(doc, objs, reGroup);
  // groups kept as they are already have their parents
  const made = new Set(map.values());
  for (const k of Object.keys(parents)) if (!made.has(k)) delete parents[k];
  const objects = objs.map((o) => {
    const c: DesignObject = { ...structuredClone(o), id: ids.get(o.id)! };
    if (c.clone && ids.has(c.clone.of)) c.clone = { ...c.clone, of: ids.get(c.clone.of)! };
    if (c.group) c.group = reGroup(c.group);
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
  // only some layers of a gradient / tartan copied: renumbered (one layer: a plain fill)
  const fixes = layerFixes({ objects, groupParents: { ...doc.groupParents, ...parents } });
  if (fixes.size) {
    for (const [id, f] of fixes) {
      const was = objects.find((o) => o.id === id)?.group;
      if (was && was !== f.group && !objects.some((o) => o.id !== id && o.group === was)) {
        // the layer's own group is left empty
        for (const [k, v] of Object.entries(parents)) if (v === was && f.group) parents[k] = f.group;
        delete parents[was];
        delete names[was];
      }
    }
    return { objects: objects.map((o) => fixes.get(o.id) ?? o), parents, names, ids };
  }
  return { objects, parents, names, ids };
}

/**
 * Copies moved by `m` (and turned by `rot`): a linked clone that follows a
 * copy moved with it keeps its place relative to that copy.
 */
export function placeCopies(copies: DesignObject[], m: Mat, rot = 0, tf: (o: DesignObject, m: Mat, rot: number) => DesignObject = transformObject): DesignObject[] {
  const copied = new Set(copies.map((c) => c.id));
  return copies.map((c) => {
    const t = tf(c, m, rot);
    if (!c.clone || !copied.has(c.clone.of) || !t.clone) return t;
    // the original moved too: the link turns with the move (not on top of it)
    return { ...t, clone: { ...conjugate(c.clone, m), of: c.clone.of } };
  });
}
