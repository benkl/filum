// Organising the Layers tab: filtering the rows, selecting a range, showing
// one row only, grouping by thread or stitch type, moving into a group.
// Pure functions on the document and the rows.

import type { DesignObject, StitchDocument } from "../types";
import { chainOf, liveGroups, withParent } from "./groups";
import { groupInfo, isFixedMember, pruneGroups, type LayerListRow } from "./layerRows";

/** What the type filter offers. */
export type KindFilter = "all" | "fill" | "satin" | "line" | "text";

export const KIND_FILTERS: [KindFilter, string][] = [
  ["all", "All types"],
  ["fill", "Fills"],
  ["satin", "Satins"],
  ["line", "Lines"],
  ["text", "Lettering"],
];

/** The kind an object counts as in the filter. */
export function kindOf(o: DesignObject): Exclude<KindFilter, "all"> {
  if (o.text) return "text";
  const t = o.stitch.type;
  if (t === "satin") return "satin";
  if (t === "running" || t === "manual" || t === "none") return "line";
  return "fill";
}

/**
 * The rows that match a name search and a type filter: an object row by its
 * name or its thread's; a group row by its name (then all of it shows) or by
 * anything inside it that matches. Build the rows unfolded while filtering.
 */
export function filterRows(rows: LayerListRow[], doc: StitchDocument, query: string, kind: KindFilter): LayerListRow[] {
  const q = query.trim().toLowerCase();
  if (!q && kind === "all") return rows;
  const threads = new Map(doc.threads.map((t) => [t.id, `${t.name} ${t.brand} ${t.code}`.toLowerCase()]));
  const named = new Set(rows.filter((r) => r.kind === "group" && q && r.name.toLowerCase().includes(q)).map((r) => (r as { group: string }).group));
  const objectHit = (o: DesignObject) =>
    (kind === "all" || kindOf(o) === kind) && (!q || o.name.toLowerCase().includes(q) || (threads.get(o.thread) ?? "").includes(q) || chainOf(doc, o.group).some((g) => named.has(g)));
  const hits = new Set(doc.objects.filter(objectHit).map((o) => o.id));
  return rows.filter((r) => r.ids.some((id) => hits.has(id)));
}

/** The objects of the rows from `a` to `b` (both included), in list order. */
export function rangeIds(rows: LayerListRow[], a: string, b: string): string[] {
  const i = rows.findIndex((r) => r.key === a);
  const j = rows.findIndex((r) => r.key === b);
  if (i < 0 || j < 0) return [];
  const [lo, hi] = i < j ? [i, j] : [j, i];
  return [...new Set(rows.slice(lo, hi + 1).flatMap((r) => r.ids))];
}

/**
 * Show only `ids` (Alt-click an eye): everything else is hidden. Already
 * like that: everything shows again.
 */
export function solo(doc: StitchDocument, ids: string[]): StitchDocument {
  const set = new Set(ids);
  const already = doc.objects.every((o) => (set.has(o.id) ? o.visible : !o.visible));
  const objects = doc.objects.map((o) => {
    const visible = already || set.has(o.id);
    return o.visible === visible ? o : { ...o, visible };
  });
  return { ...doc, objects };
}

/**
 * Put objects into group `g` (none: out of every group, to the top level).
 * A gradient's or tartan's colour layer moves with its whole fill: its fill's
 * group goes into `g` instead.
 */
export function moveToGroup(doc: StitchDocument, ids: string[], g: string | undefined): StitchDocument {
  const set = new Set(ids);
  let parents = doc.groupParents;
  const fills = new Set<string>();
  const objects = doc.objects.map((o) => {
    if (!set.has(o.id)) return o;
    if (isFixedMember(o)) {
      fills.add(o.group!);
      return o;
    }
    return o.group === g ? o : { ...o, group: g };
  });
  for (const f of fills) if (f !== g && !(g && chainOf(doc, g).includes(f))) parents = withParent(parents, f, g);
  return pruneGroups({ ...doc, objects, groupParents: parents });
}

/** The plain groups to offer as "move to" targets: [id, name], top of the list first. */
export function groupTargets(doc: StitchDocument): [string, string][] {
  const info = groupInfo(doc.objects, doc.groupNames, doc.groupParents);
  const top = (g: string) => Math.max(...info.get(g)!.members.map((m) => doc.objects.indexOf(m)));
  return [...info]
    .filter(([, x]) => x.role === "group")
    .sort(([a], [b]) => top(b) - top(a))
    .map(([g, x]) => [g, x.name]);
}

const uidOf = (k: string) => `g${k}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

/**
 * Organise the loose objects (those in no group) into groups by a key — their
 * thread, their stitch type — without changing the stitch order. A key with
 * one object stays loose. A lettering moves as one.
 */
function groupLooseBy(doc: StitchDocument, key: (o: DesignObject) => string, name: (k: string) => string): { doc: StitchDocument; made: number } {
  const loose = doc.objects.filter((o) => !o.group);
  const units = new Map<string, DesignObject[]>();
  for (const o of loose) {
    const u = o.text ? `t:${o.text.group}` : o.id;
    if (!units.has(u)) units.set(u, []);
    units.get(u)!.push(o);
  }
  const byKey = new Map<string, string[]>();
  for (const objs of units.values()) {
    const k = key(objs[0]);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k)!.push(...objs.map((o) => o.id));
  }
  const groupOf = new Map<string, string>();
  const names: Record<string, string> = { ...doc.groupNames };
  let made = 0;
  for (const [k, ids] of byKey) {
    const units = new Set(ids.map((id) => doc.objects.find((o) => o.id === id)!).map((o) => (o.text ? `t:${o.text.group}` : o.id)));
    if (units.size < 2) continue;
    const g = uidOf(String(made));
    names[g] = name(k);
    for (const id of ids) groupOf.set(id, g);
    made++;
  }
  if (!made) return { doc, made };
  const objects = doc.objects.map((o) => (groupOf.has(o.id) ? { ...o, group: groupOf.get(o.id) } : o));
  return { doc: { ...doc, objects, groupNames: names }, made };
}

/** Group the loose objects by thread colour (named after the thread). */
export function groupByThread(doc: StitchDocument) {
  const names = new Map(doc.threads.map((t) => [t.id, t.name || t.color.toUpperCase()]));
  return groupLooseBy(doc, (o) => o.thread, (k) => names.get(k) ?? "Thread");
}

const KIND_NAMES: Record<Exclude<KindFilter, "all">, string> = { fill: "Fills", satin: "Satins", line: "Lines", text: "Lettering" };

/** Group the loose objects by stitch type (fills, satins, lines, lettering). */
export function groupByKind(doc: StitchDocument) {
  return groupLooseBy(doc, kindOf, (k) => KIND_NAMES[k as Exclude<KindFilter, "all">]);
}

/** Dissolve every group the user made (gradients and tartans stay one fill). */
export function ungroupAll(doc: StitchDocument): StitchDocument {
  const info = groupInfo(doc.objects, doc.groupNames, doc.groupParents);
  const plain = new Set([...info].filter(([, x]) => x.role === "group").map(([g]) => g));
  if (!plain.size) return doc;
  const objects = doc.objects.map((o) => (o.group && plain.has(o.group) ? { ...o, group: undefined } : o));
  // what stays (gradient and tartan fills) goes to the top level
  let parents = doc.groupParents;
  for (const g of liveGroups({ objects, groupParents: parents })) parents = withParent(parents, g, undefined);
  return pruneGroups({ ...doc, objects, groupParents: parents });
}
