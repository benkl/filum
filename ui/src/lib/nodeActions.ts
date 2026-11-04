// Node tool commands on the store: used by the node tool bar and the keyboard.

import { useStore } from "../store";
import type { StitchDocument, Vec2 } from "../types";
import { syncGradientGeometry } from "./gradient";
import { alignNodes, allNodes, breakAtNodes, deleteSelectedNodes, joinNodes, moveNodes, setNodeType, setSegmentType, toggleClosed } from "./nodeOps";

/** Keep gradient layers on the shapes of every object that changed. */
export function syncAll(before: StitchDocument, after: StitchDocument): StitchDocument {
  let d = after;
  for (const o of after.objects) {
    const prev = before.objects.find((x) => x.id === o.id);
    if (prev && prev.paths !== o.paths) d = syncGradientGeometry(d, o);
  }
  return d;
}

const apply = (fn: (d: StitchDocument) => StitchDocument) => {
  const s = useStore.getState();
  if (!s.nodeSel.length) return s.toast("Select points first (click, Shift-click or drag a box)");
  s.commit((d) => syncAll(d, fn(d)));
};

export function deleteNodes(keepShape: boolean) {
  const s = useStore.getState();
  if (!s.nodeSel.length) return;
  const r = deleteSelectedNodes(s.doc, s.nodeSel, keepShape);
  s.commit((d) => syncAll(d, r.doc));
  s.set({ nodeSel: [] });
  if (r.removedObjects) s.toast(`${r.removedObjects} path${r.removedObjects > 1 ? "s" : ""} removed (fewer than two points left)`);
}

export const nodeType = (t: "corner" | "smooth" | "symmetric") => apply((d) => setNodeType(d, useStore.getState().nodeSel, t));
export const segmentType = (t: "line" | "curve") => apply((d) => setSegmentType(d, useStore.getState().nodeSel, t));
export const alignSelected = (axis: "h" | "v") => apply((d) => alignNodes(d, useStore.getState().nodeSel, axis));

export function breakNodes() {
  apply((d) => breakAtNodes(d, useStore.getState().nodeSel));
  useStore.getState().set({ nodeSel: [] });
}

export function joinSelected() {
  const s = useStore.getState();
  const r = joinNodes(s.doc, s.nodeSel);
  if (r.error) return s.toast(r.error);
  s.commit((d) => syncAll(d, r.doc));
  s.set({ nodeSel: [] });
  s.select(s.selection.filter((id) => r.doc.objects.some((o) => o.id === id)));
}

export function toggleClosedSelected() {
  apply((d) => toggleClosed(d, useStore.getState().nodeSel));
  useStore.getState().set({ nodeSel: [] });
}

export function nudgeNodes(d: Vec2) {
  const s = useStore.getState();
  if (!s.nodeSel.length) return;
  s.commit((doc) => syncAll(doc, moveNodes(doc, s.nodeSel, d)));
}

export function selectAllNodes() {
  const s = useStore.getState();
  s.set({ nodeSel: allNodes(s.doc, s.selection) });
}

/**
 * Keyboard of the node tool (called by the app's shortcut handler first).
 * Returns true when the key was used.
 */
export function nodeToolKey(e: KeyboardEvent): boolean {
  const s = useStore.getState();
  if (s.tool !== "node") return false;
  const k = e.key.toLowerCase();
  const mod = e.ctrlKey || e.metaKey;
  if (mod && k === "a") {
    selectAllNodes();
    return true;
  }
  if (!s.nodeSel.length || mod) return false;
  if (k === "delete" || k === "backspace") {
    // Shift: plain delete (neighbours keep their handles)
    deleteNodes(!e.shiftKey);
    return true;
  }
  if (k === "escape") {
    s.set({ nodeSel: [] });
    return true;
  }
  const step = e.shiftKey ? s.prefs.nodeNudgeBig : s.prefs.nodeNudge;
  const arrows: Record<string, Vec2> = { arrowleft: [-step, 0], arrowright: [step, 0], arrowup: [0, -step], arrowdown: [0, step] };
  if (arrows[k]) {
    nudgeNodes(arrows[k]);
    return true;
  }
  if (!e.shiftKey || e.altKey) return false;
  // Shift + letter: node type shortcuts
  const map: Record<string, () => void> = {
    c: () => nodeType("corner"),
    s: () => nodeType("smooth"),
    y: () => nodeType("symmetric"),
    l: () => segmentType("line"),
    u: () => segmentType("curve"),
    b: breakNodes,
    j: joinSelected,
  };
  if (map[k]) {
    map[k]();
    return true;
  }
  return false;
}
