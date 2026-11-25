// Bringing something into view on the editor canvas (Issues, the density
// legend): select it and zoom or pan to it.

import type { Box } from "./geometry";
import type { Vec2 } from "../types";
import { useStore } from "../store";
import { canvasSize, fitView, RULER } from "./view";

/**
 * Shows something on the editor canvas: selects `ids` (when given), then
 * zooms to `box` (no closer than `minSize` mm across) or pans to centre
 * `at` at the current zoom.
 */
export function focus({ ids, box, at, minSize = 0 }: { ids?: string[]; box?: Box; at?: Vec2; minSize?: number }) {
  const s = useStore.getState();
  if (ids?.length) s.select(ids);
  const size = canvasSize();
  if (!size) return;
  if (box) {
    const pad = Math.max(0, minSize - Math.max(box.w, box.h)) / 2;
    s.setView(fitView(size.w, size.h, { x: box.x - pad, y: box.y - pad, w: box.w + 2 * pad, h: box.h + 2 * pad }));
  } else if (at) {
    const cx = (RULER + size.w) / 2;
    const cy = (RULER + size.h) / 2;
    s.setView({ ox: cx - at[0] * s.view.scale, oy: cy - at[1] * s.view.scale });
  }
}
