// Shape Builder commands that act on the whole selection (the on-canvas
// merging and deleting of regions lives in the canvas).

import { engine } from "../engine/client";
import { useStore } from "../store";
import type { DesignObject } from "../types";
import { layeredRefusal } from "./fillLayers";
import { uid } from "./geometry";

/** The selected objects the Shape Builder works on: visible closed fills. */
export function builderTargets(): DesignObject[] {
  const s = useStore.getState();
  return s.doc.objects.filter((o) => s.selection.includes(o.id) && o.visible && o.stitch.type === "fill" && o.paths.some((sp) => sp.closed));
}

/**
 * Why the Shape Builder can't work on these objects: its pieces copy the
 * style of a shape, which would split the colour layers of a gradient,
 * tartan or colour blend apart, and linked clones would snap back to their
 * original.
 */
export const builderRefusal = (objs: DesignObject[]): string | null => layeredRefusal(objs);

/** Divide: every overlap region becomes its own shape, in the style of the shape on top there. */
export async function divideSelection() {
  const s = useStore.getState();
  const targets = builderTargets();
  if (!targets.length) return s.toast("Select overlapping fills to divide");
  const no = builderRefusal(targets);
  if (no) return s.toast(no, "error");
  const ids = targets.map((o) => o.id);
  const r = await engine.shapeBuild(s.doc, ids, [], "divide");
  const byOwner = new Map<string, DesignObject[]>();
  for (const part of r.parts) {
    const style = s.doc.objects.find((o) => o.id === part.owner);
    if (!style) continue;
    const list = byOwner.get(part.owner) ?? [];
    list.push({ ...style, id: uid(), name: `${style.name} ${list.length + 1}`, paths: part.paths, start: undefined, end: undefined });
    byOwner.set(part.owner, list);
  }
  const made = [...byOwner.values()].flat();
  s.commit((d) => ({ ...d, objects: d.objects.flatMap((o) => (ids.includes(o.id) ? byOwner.get(o.id) ?? [] : [o])) }));
  s.select(made.map((o) => o.id));
  s.toast(`Divided into ${made.length} shapes`, "success");
}
