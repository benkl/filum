// The menu actions of lib/pathOps.ts: on the selection, as one undo step.

import { useStore } from "../store";
import { joinObjects, makeCompound, releaseCompound } from "./pathOps";

const store = () => useStore.getState();

export function joinSelection() {
  const s = store();
  const r = joinObjects(s.doc, s.selection);
  if (r.error) return s.toast(r.error);
  s.commit(() => r.doc);
  s.select(s.selection.filter((id) => r.doc.objects.some((o) => o.id === id)));
}

export function compoundSelection() {
  const s = store();
  const r = makeCompound(s.doc, s.selection);
  if (r.error) return s.toast(r.error);
  s.commit(() => r.doc);
  s.select(s.selection.filter((id) => r.doc.objects.some((o) => o.id === id)));
}

export function releaseSelection() {
  const s = store();
  const r = releaseCompound(s.doc, s.selection);
  if (r.error) return s.toast(r.error);
  s.commit(() => r.doc);
  s.select(r.ids);
}
