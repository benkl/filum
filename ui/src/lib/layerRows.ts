// The rows of the Layers tab, and moving objects and groups in stitch order.
//
// The list runs top = stitched last. A group shows as one foldable header row
// at the place of its topmost object, with what is in it indented under it
// while it is unfolded: its objects and the groups inside it (groups nest, see
// lib/groups.ts), each at the place of its topmost object. Members need not be
// next to each other in stitch order: their own index numbers show where each
// one is sewn. Grouping (Ctrl+G) gathers the members at the topmost one, so
// new groups are contiguous.
//
// Dragging:
// - a group header moves the whole group (gathered, in its order) next to the
//   row it is dropped on, into the group that row is in (never into itself);
// - an object dropped on a member of a group joins that group;
// - a member dropped on a row outside its group leaves the group (on a group
//   header: next to that group, in the group the header is in);
// - gradient and tartan colour layers (whose `group` is their gradient's or
//   tartan's) keep their group whatever happens: they are one fill.

import type { DesignObject, StitchDocument } from "../types";
import { chainOf, liveGroups, objectsIn, parentOf, withParent, within, type GroupDoc } from "./groups";

/** What a group is: one the user made, or the colour layers of one gradient or tartan fill. */
export type GroupRole = "group" | "gradient" | "tartan";

export interface ObjectLayerRow {
  kind: "object";
  key: string;
  /** The first object of the row (a lettering shows as one row). */
  o: DesignObject;
  /** Its index in stitch order. */
  i: number;
  /** Every object of the row: the lettering's, or just `o`. */
  ids: string[];
  /** The group whose rows it is shown under (its innermost group). */
  member?: string;
  /** How many groups it is in (its indent). */
  depth: number;
}

export interface GroupLayerRow {
  kind: "group";
  key: string;
  group: string;
  name: string;
  role: GroupRole;
  /** The group it is in (none at the top level). */
  parent?: string;
  /** How many groups it is in (its indent). */
  depth: number;
  /** Every object in it (and in the groups inside it), in stitch order. */
  ids: string[];
  /** Rows under it (a lettering counts once). */
  count: number;
  /** Thread ids of its members, each once, in stitch order. */
  threads: string[];
  /** Stitch index of its topmost member (where the header shows). */
  top: number;
  folded: boolean;
  visible: "all" | "some" | "none";
  locked: "all" | "some" | "none";
}

export type LayerListRow = ObjectLayerRow | GroupLayerRow;

/** A gradient's or tartan's colour layer kept together by its group. */
export function isFixedMember(o: DesignObject): boolean {
  if (!o.group || o.stitch.type !== "fill") return false;
  return o.stitch.gradient?.group === o.group || o.stitch.tartan?.group === o.group;
}

function roleOf(members: DesignObject[]): GroupRole {
  const g = members[0].group;
  const all = (f: (o: DesignObject) => boolean) => members.every(f);
  if (all((o) => o.stitch.type === "fill" && o.stitch.gradient?.group === g)) return "gradient";
  if (all((o) => o.stitch.type === "fill" && o.stitch.tartan?.group === g)) return "tartan";
  return "group";
}

const baseName = (o: DesignObject) => o.name.replace(/ · colour \d+$/, "");

/** Each live group's objects (all of them, stitch order), role and shown name. */
export function groupInfo(objects: DesignObject[], names: Record<string, string> = {}, parents?: Record<string, string>) {
  const doc: GroupDoc = { objects, groupParents: parents };
  const taken = new Set(Object.values(names));
  const info = new Map<string, { members: DesignObject[]; role: GroupRole; name: string }>();
  let n = 0;
  for (const g of liveGroups(doc)) {
    const ms = objectsIn(doc, g);
    const direct = ms.filter((o) => o.group === g);
    const role = direct.length === ms.length ? roleOf(direct) : "group";
    let name = names[g];
    if (!name) {
      if (role === "group") {
        do name = `Group ${++n}`;
        while (taken.has(name));
      } else name = baseName(ms[0]);
    }
    info.set(g, { members: ms, role, name });
  }
  return info;
}

/** A name for a new group, unlike the names shown. */
export function nextGroupName(doc: Pick<StitchDocument, "objects" | "groupNames"> & Partial<Pick<StitchDocument, "groupParents">>): string {
  const shown = new Set([...groupInfo(doc.objects, doc.groupNames, doc.groupParents).values()].map((x) => x.name));
  let n = 1;
  while (shown.has(`Group ${n}`)) n++;
  return `Group ${n}`;
}

const tri = (k: number, n: number) => (k === n ? "all" : k ? "some" : "none");

/** The rows of the Layers tab, top (stitched last) first. */
export function buildLayerRows(objects: DesignObject[], folded: ReadonlySet<string>, names: Record<string, string> = {}, parents?: Record<string, string>): LayerListRow[] {
  const doc: GroupDoc = { objects, groupParents: parents };
  const info = groupInfo(objects, names, parents);
  const index = new Map(objects.map((o, i) => [o.id, i]));
  const textIds = new Map<string, string[]>();
  for (const o of objects) if (o.text) textIds.set(o.text.group, [...(textIds.get(o.text.group) ?? []), o.id]);
  const seenText = new Set<string>();
  // what sits directly in each group (undefined: the top level), at the stitch index it shows at
  type Item = { at: number; o?: DesignObject; g?: string };
  const items = new Map<string | undefined, Item[]>();
  const push = (k: string | undefined, it: Item) => (items.has(k) ? items.get(k)!.push(it) : items.set(k, [it]));
  objects.forEach((o, i) => push(o.group, { at: i, o }));
  for (const [g, x] of info) push(parentOf(doc, g), { at: Math.max(...x.members.map((m) => index.get(m.id)!)), g });
  const rows: LayerListRow[] = [];
  const emit = (container: string | undefined, depth: number) => {
    // top first; a group shows above the object it shares its place with
    const list = (items.get(container) ?? []).sort((a, b) => b.at - a.at || (a.g ? -1 : 1));
    for (const it of list) {
      if (it.o) {
        const o = it.o;
        if (o.text) {
          if (seenText.has(o.text.group)) continue;
          seenText.add(o.text.group);
        }
        rows.push({ kind: "object", key: `o:${o.id}`, o, i: it.at, ids: o.text ? textIds.get(o.text.group)! : [o.id], member: o.group, depth });
        continue;
      }
      const g = it.g!;
      const x = info.get(g)!;
      // the rows right under it: a lettering counts once
      const count = new Set((items.get(g) ?? []).map((c) => (c.o ? (c.o.text ? `t:${c.o.text.group}` : c.o.id) : `g:${c.g}`))).size;
      const isFolded = folded.has(g);
      rows.push({
        kind: "group",
        key: `g:${g}`,
        group: g,
        name: x.name,
        role: x.role,
        parent: parentOf(doc, g),
        depth,
        ids: x.members.map((m) => m.id),
        count,
        threads: [...new Set(x.members.map((m) => m.thread))],
        top: it.at,
        folded: isFolded,
        visible: tri(x.members.filter((m) => m.visible).length, x.members.length),
        locked: tri(x.members.filter((m) => m.locked).length, x.members.length),
      });
      if (!isFolded) emit(g, depth + 1);
    }
  };
  emit(undefined, 0);
  return rows;
}

/**
 * The objects with `ids` taken out and put back together, in their order,
 * next to `target` (the objects of the row they are dropped on).
 * `where`: above (after it in stitch order), below, or — `auto` — on the far
 * side from where they come from (taking the target's place, as dragging does).
 */
export function moveBlock(objects: DesignObject[], ids: Iterable<string>, target: Iterable<string>, where: "above" | "below" | "auto" = "auto"): DesignObject[] {
  const set = new Set(ids);
  const index = new Map(objects.map((o, i) => [o.id, i]));
  const tset = new Set([...target].filter((id) => !set.has(id) && index.has(id)));
  const block = objects.filter((o) => set.has(o.id));
  if (!block.length || !tset.size) return objects;
  const blockMax = Math.max(...block.map((o) => index.get(o.id)!));
  const t = [...tset].map((id) => index.get(id)!);
  const above = where === "auto" ? Math.max(...t) > blockMax : where === "above";
  const rest = objects.filter((o) => !set.has(o.id));
  let at: number;
  if (above) {
    at = 0;
    rest.forEach((o, k) => tset.has(o.id) && (at = k + 1));
  } else at = rest.findIndex((o) => tset.has(o.id));
  const out = [...rest.slice(0, at), ...block, ...rest.slice(at)];
  return out.every((o, k) => o === objects[k]) ? objects : out;
}

/** The objects with `ids` gathered (in their order) at the place of the topmost one. */
export function gatherAtTop(objects: DesignObject[], ids: Iterable<string>): DesignObject[] {
  const set = new Set(ids);
  let top = -1;
  objects.forEach((o, k) => set.has(o.id) && (top = k));
  if (top < 0) return objects;
  const block = objects.filter((o) => set.has(o.id));
  const below = objects.slice(0, top).filter((o) => !set.has(o.id));
  const above = objects.slice(top + 1);
  const out = [...below, ...block, ...above];
  return out.every((o, k) => o === objects[k]) ? objects : out;
}

/**
 * Plain groups left with one thing in them (an object or a group) are
 * dissolved: it moves up into the group around. Names and parents of groups
 * that are gone are dropped.
 */
export function pruneGroups(doc: StitchDocument): StitchDocument {
  let objects = doc.objects;
  let parents = doc.groupParents;
  for (let pass = 0; pass < 64; pass++) {
    const d: GroupDoc = { objects, groupParents: parents };
    const live = liveGroups(d);
    // what sits directly in each live group: its objects and its live groups
    const size = new Map<string, number>();
    for (const o of objects) if (o.group) size.set(o.group, (size.get(o.group) ?? 0) + 1);
    for (const g of live) {
      const p = parentOf(d, g);
      if (p) size.set(p, (size.get(p) ?? 0) + 1);
    }
    const fixed = new Set(objects.filter(isFixedMember).map((o) => o.group!));
    const lone = [...live].find((g) => (size.get(g) ?? 0) <= 1 && !fixed.has(g));
    if (!lone) break;
    const up = parentOf(d, lone);
    objects = objects.map((o) => (o.group === lone ? { ...o, group: up } : o));
    let next = withParent(parents, lone, undefined);
    for (const [c, p] of Object.entries(next ?? {})) if (p === lone) next = withParent(next, c, up);
    parents = next;
  }
  const live = liveGroups({ objects, groupParents: parents });
  const keptParents = Object.entries(parents ?? {}).filter(([c, p]) => live.has(c) && live.has(p));
  const groupParents = keptParents.length ? Object.fromEntries(keptParents) : undefined;
  const names = doc.groupNames;
  const keptNames = Object.entries(names ?? {}).filter(([g]) => live.has(g));
  const groupNames = keptNames.length ? Object.fromEntries(keptNames) : undefined;
  const sameParents = JSON.stringify(groupParents ?? {}) === JSON.stringify(doc.groupParents ?? {});
  const sameNames = keptNames.length === Object.keys(names ?? {}).length;
  if (objects === doc.objects && sameParents && sameNames) return doc;
  const out: StitchDocument = { ...doc, objects, groupNames, groupParents };
  if (!groupNames) delete out.groupNames;
  if (!groupParents) delete out.groupParents;
  return out;
}

/** The objects after dropping the row `drag` on the row `target` in the Layers tab (see the top of this file). */
export function dropRow(objects: DesignObject[], drag: LayerListRow, target: LayerListRow): DesignObject[] {
  return dropOnRow({ objects } as StitchDocument, drag, target).objects;
}

/** The document after dropping the row `drag` on the row `target` (see the top of this file). */
export function dropOnRow(doc: StitchDocument, drag: LayerListRow, target: LayerListRow): StitchDocument {
  const { objects } = doc;
  if (drag.key === target.key) return doc;
  const roles = groupInfo(objects, doc.groupNames, doc.groupParents);
  // the plain group a row is in (a gradient's or tartan's group passes it on to the group around it)
  const plain = (g: string | undefined): string | undefined => chainOf(doc, g).find((x) => roles.get(x)?.role === "group");
  if (drag.kind === "group") {
    const g = drag.group;
    // onto itself or onto anything inside it: nothing
    if (target.kind === "object" && target.member && within(doc, target.member, g)) return doc;
    if (target.kind === "group" && within(doc, target.group, g)) return doc;
    const into = target.kind === "object" ? plain(target.member) : plain(target.parent);
    const moved = moveBlock(objects, drag.ids, target.ids);
    const parents = withParent(doc.groupParents, g, into);
    if (moved === objects && JSON.stringify(parents ?? {}) === JSON.stringify(doc.groupParents ?? {})) return doc;
    return { ...doc, objects: moved, groupParents: parents };
  }
  const from = drag.member;
  // dropped on its own group's header: it stays in, at the top of the group
  if (from && target.kind === "group" && target.group === from) {
    const moved = moveBlock(objects, drag.ids, objectsIn(doc, from).map((o) => o.id), "above");
    return moved === objects ? doc : { ...doc, objects: moved };
  }
  const into = target.kind === "object" ? plain(target.member) : plain(target.parent);
  const moved = moveBlock(objects, drag.ids, target.ids);
  const dragged = new Set(drag.ids);
  let changed = false;
  const out = moved.map((o) => {
    if (!dragged.has(o.id) || isFixedMember(o) || o.group === into) return o;
    changed = true;
    return { ...o, group: into };
  });
  if (!changed) return moved === objects ? doc : { ...doc, objects: moved };
  return { ...doc, objects: out };
}
