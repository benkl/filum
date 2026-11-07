// Which objects the stitch panels edit. One object normally; with several
// selected, the multi-selection inspector shows each stitch type's panel once
// and every change goes to all selected objects of that type.

import { createContext, useContext } from "react";
import type { DesignObject } from "../types";

export const EditTargets = createContext<string[] | null>(null);

/** The ids a panel shown for `o` applies its changes to. */
export const useEditTargets = (o: DesignObject): string[] => useContext(EditTargets) ?? [o.id];

/**
 * Several objects edited together: the settings whose values differ between
 * them (the panel shows the first one's; a change sets it on all).
 */
export function differingSettings(objects: DesignObject[]): string[] {
  if (objects.length < 2) return [];
  const first = objects[0].stitch as unknown as Record<string, unknown>;
  const keys = new Set(objects.flatMap((o) => Object.keys(o.stitch)));
  const out: string[] = [];
  for (const k of keys) {
    if (k === "type" || k === "guides") continue;
    const v = JSON.stringify(first[k]);
    if (objects.some((o) => JSON.stringify((o.stitch as unknown as Record<string, unknown>)[k]) !== v)) out.push(k);
  }
  return out;
}

/** "rowSpacing" → "row spacing". */
export const settingLabel = (k: string) => k.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
