// The rows of the Layers tab, and moving objects and groups in stitch order.
//
// The list runs top = stitched last. Objects sharing `group` show as one
// foldable header row at the place of their topmost member, with the members
// indented under it (in stitch order) while it is unfolded. Members need not
// be next to each other in stitch order: their own index numbers show where
// each one is sewn. Grouping (Ctrl+G) gathers the members at the topmost one,
// so new groups are contiguous.
//
// Dragging:
// - a group header moves the whole group (gathered, in its order) next to the
//   row it is dropped on; dropped on a member of another group, it goes next
//   to that whole group (groups never nest);
// - an object dropped on a member of a group joins that group;
// - a member dropped on a row outside its group leaves the group (on a group
//   header: next to that group, outside it);
// - gradient and tartan colour layers (whose `group` is their gradient's or
//   tartan's) keep their group whatever happens: they are one fill.

import type { DesignObject, StitchDocument } from "../types";

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
  /** The group whose rows it is shown under. */
  member?: string;
}

export interface GroupLayerRow {
  kind: "group";
  key: string;
  group: string;
  name: string;
  role: GroupRole;
  /** Its members in stitch order. */
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

/** Each group's members (stitch order), role and shown name. */
export function groupInfo(objects: DesignObject[], names: Record<string, string> = {}) {
  const members = new Map<string, DesignObject[]>();
  for (const o of objects) {
    if (!o.group) continue;
    if (!members.has(o.group)) members.set(o.group, []);
    members.get(o.group)!.push(o);
  }
  const taken = new Set(Object.values(names));
  const info = new Map<string, { members: DesignObject[]; role: GroupRole; name: string }>();
  let n = 0;
  for (const [g, ms] of members) {
    const role = roleOf(ms);
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
export function nextGroupName(doc: Pick<StitchDocument, "objects" | "groupNames">): string {
  const shown = new Set([...groupInfo(doc.objects, doc.groupNames).values()].map((x) => x.name));
  let n = 1;
  while (shown.has(`Group ${n}`)) n++;
  return `Group ${n}`;
}

const tri = (k: number, n: number) => (k === n ? "all" : k ? "some" : "none");

/** The rows of the Layers tab, top (stitched last) first. */
export function buildLayerRows(objects: DesignObject[], folded: ReadonlySet<string>, names: Record<string, string> = {}): LayerListRow[] {
  const info = groupInfo(objects, names);
  const index = new Map(objects.map((o, i) => [o.id, i]));
  const textIds = new Map<string, string[]>();
  for (const o of objects) if (o.text) textIds.set(o.text.group, [...(textIds.get(o.text.group) ?? []), o.id]);
  const seenText = new Set<string>();
  const seenGroup = new Set<string>();
  const rows: LayerListRow[] = [];
  const objectRow = (o: DesignObject, member?: string): ObjectLayerRow | null => {
    if (o.text) {
      if (seenText.has(o.text.group)) return null;
      seenText.add(o.text.group);
    }
    return { kind: "object", key: `o:${o.id}`, o, i: index.get(o.id)!, ids: o.text ? textIds.get(o.text.group)! : [o.id], member };
  };
  for (let i = objects.length - 1; i >= 0; i--) {
    const o = objects[i];
    if (!o.group) {
      const r = objectRow(o);
      if (r) rows.push(r);
      continue;
    }
    if (seenGroup.has(o.group)) continue;
    seenGroup.add(o.group);
    const g = info.get(o.group)!;
    const memberRows = [...g.members].reverse().map((m) => objectRow(m, o.group)).filter((r): r is ObjectLayerRow => !!r);
    const isFolded = folded.has(o.group);
    rows.push({
      kind: "group",
      key: `g:${o.group}`,
      group: o.group,
      name: g.name,
      role: g.role,
      ids: g.members.map((m) => m.id),
      count: memberRows.length,
      threads: [...new Set(g.members.map((m) => m.thread))],
      top: i,
      folded: isFolded,
      visible: tri(g.members.filter((m) => m.visible).length, g.members.length),
      locked: tri(g.members.filter((m) => m.locked).length, g.members.length),
    });
    if (!isFolded) rows.push(...memberRows);
  }
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
 * Plain groups left with one object are dissolved; names of groups that are
 * gone are dropped.
 */
export function pruneGroups(doc: StitchDocument): StitchDocument {
  const count = new Map<string, number>();
  for (const o of doc.objects) if (o.group) count.set(o.group, (count.get(o.group) ?? 0) + 1);
  const lone = (o: DesignObject) => !!o.group && count.get(o.group) === 1 && !isFixedMember(o);
  const objects = doc.objects.some(lone) ? doc.objects.map((o) => (lone(o) ? { ...o, group: undefined } : o)) : doc.objects;
  const live = new Set(objects.map((o) => o.group).filter(Boolean));
  const names = doc.groupNames;
  if (!names) return objects === doc.objects ? doc : { ...doc, objects };
  const kept = Object.entries(names).filter(([g]) => live.has(g));
  if (objects === doc.objects && kept.length === Object.keys(names).length) return doc;
  return { ...doc, objects, groupNames: kept.length ? Object.fromEntries(kept) : undefined };
}

/** The objects after dropping the row `drag` on the row `target` in the Layers tab (see the top of this file). */
export function dropRow(objects: DesignObject[], drag: LayerListRow, target: LayerListRow): DesignObject[] {
  if (drag.key === target.key) return objects;
  const groupIds = (g: string) => objects.filter((o) => o.group === g).map((o) => o.id);
  if (drag.kind === "group") {
    if (target.kind === "object" && target.member === drag.group) return objects;
    const to = target.kind === "object" && target.member ? groupIds(target.member) : target.ids;
    return moveBlock(objects, drag.ids, to);
  }
  const from = drag.member;
  const into = target.kind === "object" ? target.member : undefined;
  // dropped on its own group's header: it stays in, at the top of the group
  if (target.kind === "group" && target.group === from) return moveBlock(objects, drag.ids, groupIds(from), "above");
  const moved = moveBlock(objects, drag.ids, target.ids);
  if (into === from) return moved;
  const dragged = new Set(drag.ids);
  // into a group the user made, or out of any
  const group = into && groupInfo(objects).get(into)?.role === "group" ? into : undefined;
  let changed = false;
  const out = moved.map((o) => {
    if (!dragged.has(o.id) || isFixedMember(o)) return o;
    if (group === o.group) return o;
    changed = true;
    return { ...o, group };
  });
  return changed ? out : moved;
}
