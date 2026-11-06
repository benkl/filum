// The workspace layout: two docked side panels (fixed but resizable panels
// are faster to work in than floating ones), their widths, which side the
// layers sit on and which panels are shown. Remembered across sessions.
import { safeSetItem } from "./storage";

export interface Layout {
  /** Layers & issues panel width (px). */
  outlineW: number;
  /** Properties panel width (px). */
  inspectorW: number;
  /** Layers on the left of the canvas, or stacked above the properties on the right. */
  outlineSide: "left" | "right";
  /** The share of the right column the layers take when stacked. */
  split: number;
  showOutline: boolean;
  showInspector: boolean;
}

export const DEFAULT_LAYOUT: Layout = {
  outlineW: 248,
  inspectorW: 320,
  outlineSide: "left",
  split: 0.42,
  showOutline: true,
  showInspector: true,
};

export const LIMITS = {
  outlineW: [180, 460],
  inspectorW: [248, 560],
  split: [0.15, 0.8],
} as const;

export const clamp = (v: number, [lo, hi]: readonly [number, number]) => Math.max(lo, Math.min(hi, v));

const KEY = "filum.layout";

export function loadLayout(): Layout {
  try {
    const l = { ...DEFAULT_LAYOUT, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") } as Layout;
    return { ...l, outlineW: clamp(l.outlineW, LIMITS.outlineW), inspectorW: clamp(l.inspectorW, LIMITS.inspectorW), split: clamp(l.split, LIMITS.split) };
  } catch {
    return DEFAULT_LAYOUT;
  }
}

export function saveLayout(l: Layout) {
  safeSetItem(KEY, JSON.stringify(l));
}
