// The canvas view (scale and offset, px per mm): fitting a box into it and
// zooming about a point. The canvas, its panels and the previews share these
// instead of each doing the maths (lib/focus.ts brings something into view).

import type { Box } from "./geometry";

export interface View {
  /** px per mm */
  scale: number;
  /** Screen position (px) of the mm origin. */
  ox: number;
  oy: number;
}

/** The editor canvas's zoom range (px per mm). */
export const MIN_SCALE = 0.3;
export const MAX_SCALE = 400;
/** The rulers along the editor canvas's top and left edge (px; canvas/render.ts). */
export const RULER = 22;

/**
 * The view that shows `box` whole and centred in a `width` × `height` area,
 * `pad` px clear of its edges, after `inset` px taken at the top and left
 * (the rulers). `minScale` keeps a huge box from zooming out to nothing.
 */
export function fitBox(box: Box, width: number, height: number, { pad = 40, inset = 0, minScale = 0 }: { pad?: number; inset?: number; minScale?: number } = {}): View {
  const w = Math.max(10, width - inset - pad * 2);
  const h = Math.max(10, height - inset - pad * 2);
  const scale = Math.max(minScale, Math.min(w / box.w, h / box.h));
  return { scale, ox: inset + pad + (w - box.w * scale) / 2 - box.x * scale, oy: inset + pad + (h - box.h * scale) / 2 - box.y * scale };
}

/** Zoom by `k` about the point (mx, my) (px), which stays where it is; the scale within [min, max]. */
export function zoomAt(v: View, k: number, mx: number, my: number, min = MIN_SCALE, max = MAX_SCALE): View {
  const scale = Math.max(min, Math.min(max, v.scale * k));
  const f = scale / v.scale;
  return { scale, ox: mx - (mx - v.ox) * f, oy: my - (my - v.oy) * f };
}

/** The editor canvas's size (px), or null before it is laid out. */
export function canvasSize(): { w: number; h: number } | null {
  const r = document.querySelector(".canvas-wrap")?.getBoundingClientRect();
  return r ? { w: r.width, h: r.height } : null;
}

/** The editor canvas's view fitting `box` (the rulers left clear). */
export const fitView = (width: number, height: number, box: Box) => fitBox(box, width, height, { inset: RULER });
