// Nested groups. An object's `group` is the innermost group it is in;
// `doc.groupParents` says which group a group sits in (none: the top level).
// A group is alive while some object is in it or in a group inside it.
// Pure functions on the document.

import type { DesignObject, StitchDocument } from "../types";

export type GroupDoc = Pick<StitchDocument, "objects"> & Partial<Pick<StitchDocument, "groupParents" | "groupNames">>;

/** The group a group sits in (none at the top level). */
export const parentOf = (doc: GroupDoc, g: string): string | undefined => doc.groupParents?.[g];

/** `g` and the groups it sits in, innermost first (safe against loops). */
export function chainOf(doc: GroupDoc, g: string | undefined): string[] {
  const out: string[] = [];
  for (let x = g; x && !out.includes(x); x = parentOf(doc, x)) out.push(x);
  return out;
}

/** The groups an object is in, innermost first. */
export const groupsOf = (doc: GroupDoc, o: DesignObject) => chainOf(doc, o.group);

/** The outermost group an object is in. */
export function topGroupOf(doc: GroupDoc, o: DesignObject): string | undefined {
  const c = groupsOf(doc, o);
  return c[c.length - 1];
}

/** Is the object in `g`, directly or through groups inside it? */
export const isIn = (doc: GroupDoc, o: DesignObject, g: string) => groupsOf(doc, o).includes(g);

/** Every object in `g` (and the groups inside it), in stitch order. */
export const objectsIn = (doc: GroupDoc, g: string) => doc.objects.filter((o) => isIn(doc, o, g));

/** The groups directly inside `g` (or at the top level for undefined) that hold objects. */
export function childGroups(doc: GroupDoc, g: string | undefined): string[] {
  return [...liveGroups(doc)].filter((x) => parentOf(doc, x) === g);
}

/** Every group that holds an object, directly or through a group inside it. */
export function liveGroups(doc: GroupDoc): Set<string> {
  const live = new Set<string>();
  for (const o of doc.objects) for (const g of groupsOf(doc, o)) live.add(g);
  return live;
}

/** How deep `g` sits (0: the top level). */
export const depthOf = (doc: GroupDoc, g: string) => chainOf(doc, g).length - 1;

/** Is `inner` the same group as `outer` or inside it? */
export const within = (doc: GroupDoc, inner: string, outer: string) => chainOf(doc, inner).includes(outer);

/** The parents map with `g` put inside `parent` (none: the top level); undefined when empty. */
export function withParent(parents: Record<string, string> | undefined, g: string, parent: string | undefined): Record<string, string> | undefined {
  const { [g]: _, ...rest } = parents ?? {};
  const out = parent ? { ...rest, [g]: parent } : rest;
  return Object.keys(out).length ? out : undefined;
}

/**
 * What a click on `o` selects: the outermost group's objects; a lettering's
 * letters; else the object itself.
 */
export function unitOf(doc: GroupDoc, o: DesignObject): string[] {
  const top = topGroupOf(doc, o);
  if (top) return objectsIn(doc, top).map((x) => x.id);
  if (o.text) return doc.objects.filter((x) => x.text?.group === o.text!.group).map((x) => x.id);
  return [o.id];
}

/**
 * The selection as units: for each selected object, the outermost group that
 * is selected whole (a group), or the object itself.
 */
export function selectedUnits(doc: GroupDoc, sel: ReadonlySet<string>): { groups: string[]; objects: DesignObject[] } {
  const whole = new Map<string, boolean>();
  const isWhole = (g: string) => {
    if (!whole.has(g)) whole.set(g, objectsIn(doc, g).every((x) => sel.has(x.id)));
    return whole.get(g)!;
  };
  const groups = new Set<string>();
  const objects: DesignObject[] = [];
  for (const o of doc.objects) {
    if (!sel.has(o.id)) continue;
    let unit: string | undefined;
    for (const g of groupsOf(doc, o)) {
      if (isWhole(g)) unit = g;
      else break;
    }
    if (unit) groups.add(unit);
    else objects.push(o);
  }
  return { groups: [...groups], objects };
}

/**
 * The nesting of copied groups: for every copied object, each group it is in
 * gets the new id `re(g)`, sitting in the new id of the group around it.
 */
export function copiedParents(doc: GroupDoc, objs: DesignObject[], re: (g: string) => string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const o of objs) {
    const c = groupsOf(doc, o);
    for (let k = 0; k + 1 < c.length; k++) out[re(c[k])] = re(c[k + 1]);
  }
  return out;
}

/** The parents map of the groups `objs` are in (for the clipboard). */
export function parentsOf(doc: GroupDoc, objs: DesignObject[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const o of objs) {
    const c = groupsOf(doc, o);
    for (let k = 0; k + 1 < c.length; k++) out[c[k]] = c[k + 1];
  }
  return out;
}

/** The deepest group holding all of `chains` (each innermost first), none when they only share the top level. */
export function commonGroup(chains: string[][]): string | undefined {
  if (!chains.length) return undefined;
  const outer = chains.map((c) => [...c].reverse());
  let common: string | undefined;
  for (let k = 0; ; k++) {
    const g = outer[0][k];
    if (!g || !outer.every((c) => c[k] === g)) return common;
    common = g;
  }
}
