// The Trim / Jump / Sew / Automatic menu of a connection: on the canvas (a
// click on the line between two objects), in the layer list and in the
// right-click menus. One undo step per choice.

import { LINK_CHOICES, connectionAfter, describeConnection, linkChoiceOf, withLinkChoice, type LinkChoice } from "../lib/links";
import { useStore } from "../store";
import type { MenuItem } from "./menuModel";

/** Give the objects (by id) this choice, as one undo step. */
export function setLinkChoice(ids: string[], c: LinkChoice): void {
  const set = new Set(ids);
  useStore.getState().commit((d) => ({ ...d, objects: d.objects.map((o) => (set.has(o.id) ? withLinkChoice(o, c) : o)) }));
}

/** The menu for what follows the object `id`: what the plan does there now, the four choices, stop after. */
export function linkMenu(id: string): MenuItem[] {
  const s = useStore.getState();
  const o = s.doc.objects.find((x) => x.id === id);
  if (!o) return [];
  const cur = linkChoiceOf(o);
  const conn = connectionAfter(s.plan, s.doc, id);
  const now = conn ? describeConnection(conn) : "the last object, nothing follows";
  return [
    { label: `After ${o.name}: ${now}`, disabled: true },
    ...LINK_CHOICES.map((c): MenuItem => ({ label: c.label, hint: c.hint, checked: cur === c.id, run: () => setLinkChoice([id], c.id) })),
    "-",
    { label: "Stop after", hint: "A machine stop after it (appliqué, puff foam…); it trims too", checked: o.stopAfter, run: () => s.updateObject(id, { stopAfter: !o.stopAfter }) },
  ];
}

/** The last of the objects (by id) in sewing order: what "after them" means for a selection. */
export function lastInOrder(ids: string[]): string | undefined {
  const objs = useStore.getState().doc.objects;
  for (let i = objs.length - 1; i >= 0; i--) if (ids.includes(objs[i].id)) return objs[i].id;
  return undefined;
}
