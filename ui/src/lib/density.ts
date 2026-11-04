// Density map: the engine's density model (crates/core/src/density.rs; see
// docs/density-model.md) shown on the canvas. Three views of the same plan:
//
// - Coverage: layers of thread (1 = the fabric just covered). Blue where a
//   covering fill or satin is too open and the fabric shows, green normal,
//   amber heavy, red / magenta beyond what the fabric takes.
// - Needle holes per mm²: perforation (the common 10 / 17 / 25 tiers,
//   Ink/Stitch's 0.5 mm neighbourhood), what tears sheer fabric and leather.
// - Stiffness: thread weight added to the fabric (g/m²) against the fabric's
//   own weight — where a light fabric turns into a board.
//
// Every scale comes from the fabric's limits, so switching the fabric
// re-judges the same stitches.

import type { DensityField, DensityStats, FabricLimits, Vec2 } from "../types";

export type DensityMode = "coverage" | "holes" | "stiffness";

export const DENSITY_MODES: { id: DensityMode; label: string; title: string }[] = [
  { id: "coverage", label: "Coverage", title: "Layers of thread: 1 = the fabric just covered (40 wt rows every 0.25 mm, Ink/Stitch's default fill)" },
  { id: "holes", label: "Needle holes", title: "Needle penetrations per mm² — what perforates and tears delicate fabric" },
  { id: "stiffness", label: "Stiffness", title: "Weight of thread added to the fabric (top + bobbin) against the fabric's own weight" },
];

type RGBA = [number, number, number, number];
/** A colour scale: value stops with colours (alpha 0..1). */
export interface DensityScale {
  stops: [number, RGBA][];
  unit: string;
  /** Labelled marks on the legend bar. */
  ticks: { v: number; label: string }[];
  max: number;
}

const GREEN: [number, number, number] = [34, 197, 94];
const AMBER: [number, number, number] = [245, 158, 11];
const RED: [number, number, number] = [239, 68, 68];
const MAGENTA: [number, number, number] = [192, 38, 211];
export const THIN_BLUE: [number, number, number] = [59, 130, 246];

const DEFAULT_LIMITS: FabricLimits = { gsm: 130, holesHeavy: 10, holesMax: 17, layersHeavy: 2.4, layersMax: 3.8, layersMin: 0.6, stiffRatio: 1.5 };

const fmt = (v: number) => (v >= 10 ? v.toFixed(0) : v.toFixed(1).replace(/\.0$/, ""));

/** The colour scale of a mode on a fabric. */
export function densityScale(mode: DensityMode, limits: FabricLimits | null): DensityScale {
  const l = limits ?? DEFAULT_LIMITS;
  const ramp = (heavy: number, max: number, unit: string, okFrom = 0.3): DensityScale => ({
    stops: [
      [0, [...GREEN, 0]],
      [heavy * okFrom, [...GREEN, 0.2]],
      [heavy * 0.75, [...GREEN, 0.38]],
      [heavy, [...AMBER, 0.55]],
      [max, [...RED, 0.68]],
      [max * 1.5, [...MAGENTA, 0.82]],
    ],
    unit,
    ticks: [
      { v: heavy, label: fmt(heavy) },
      { v: max, label: fmt(max) },
    ],
    max: max * 1.5,
  });
  switch (mode) {
    case "coverage": {
      const s = ramp(l.layersHeavy, l.layersMax, "layers", 0.15);
      s.ticks.unshift({ v: 1, label: "1" });
      return s;
    }
    case "holes":
      return ramp(l.holesHeavy, l.holesMax, "holes/mm²");
    case "stiffness":
      // added weight as a share of the fabric's weight
      return ramp(l.stiffRatio, l.stiffRatio * 2, "× fabric");
  }
}

/** The colour of a value on a scale. */
export function colorAt(s: DensityScale, v: number): RGBA {
  const st = s.stops;
  if (!(v > st[0][0])) return st[0][1];
  for (let i = 1; i < st.length; i++) {
    if (v <= st[i][0]) {
      const [a, ca] = st[i - 1];
      const [b, cb] = st[i];
      const t = (v - a) / (b - a || 1);
      return [0, 1, 2, 3].map((k) => ca[k] + (cb[k] - ca[k]) * t) as RGBA;
    }
  }
  return st[st.length - 1][1];
}

/** The value a mode shows in cell `i`. */
export function modeValue(f: DensityField, mode: DensityMode, i: number): number {
  if (mode === "coverage") return f.layers[i];
  if (mode === "holes") return f.holes[i];
  return f.added[i] / (f.limits?.gsm ?? DEFAULT_LIMITS.gsm);
}

/** RGBA pixels of the field in a mode (one pixel per cell). */
export function densityPixels(f: DensityField, mode: DensityMode): Uint8ClampedArray {
  const s = densityScale(mode, f.limits);
  const out = new Uint8ClampedArray(f.cols * f.rows * 4);
  const min = f.limits?.layersMin ?? DEFAULT_LIMITS.layersMin;
  for (let i = 0; i < f.cols * f.rows; i++) {
    if (f.cls[i] === 0) continue;
    let c: RGBA;
    if (mode === "coverage" && f.cls[i] === 1) {
      // thin: the more open, the bluer
      c = [...THIN_BLUE, 0.3 + 0.4 * Math.max(0, Math.min(1, 1 - f.layers[i] / min))];
    } else c = colorAt(s, modeValue(f, mode, i));
    out[i * 4] = c[0];
    out[i * 4 + 1] = c[1];
    out[i * 4 + 2] = c[2];
    out[i * 4 + 3] = Math.round(c[3] * 255);
  }
  return out;
}

const images = new WeakMap<DensityField, Map<DensityMode, HTMLCanvasElement>>();

/** The field as a canvas (one pixel per cell) to draw scaled. */
export function densityCanvas(f: DensityField, mode: DensityMode): HTMLCanvasElement | null {
  if (!f.cols || !f.rows) return null;
  let m = images.get(f);
  if (!m) images.set(f, (m = new Map()));
  const hit = m.get(mode);
  if (hit) return hit;
  const c = document.createElement("canvas");
  c.width = f.cols;
  c.height = f.rows;
  const g = c.getContext("2d")!;
  const img = g.createImageData(f.cols, f.rows);
  img.data.set(densityPixels(f, mode));
  g.putImageData(img, 0, 0);
  m.set(mode, c);
  return c;
}

/** What the model says at a point (null outside the stitches). */
export interface DensityReading {
  layers: number;
  holes: number;
  added: number;
  ratio: number;
  cls: number;
}
export function densityAt(f: DensityField | null, p: Vec2): DensityReading | null {
  if (!f || !f.cols) return null;
  const gx = Math.floor((p[0] - f.x0) / f.cell);
  const gy = Math.floor((p[1] - f.y0) / f.cell);
  if (gx < 0 || gy < 0 || gx >= f.cols || gy >= f.rows) return null;
  const i = gy * f.cols + gx;
  if (!f.cls[i]) return null;
  return { layers: f.layers[i], holes: f.holes[i], added: f.added[i], ratio: f.added[i] / (f.limits?.gsm ?? DEFAULT_LIMITS.gsm), cls: f.cls[i] };
}

export const CLASS_LABELS = ["", "Thin", "OK", "Heavy", "Too dense"];

/** Shares of the stitched area per class (0..1). */
export function classShares(st: DensityStats): { thin: number; ok: number; heavy: number; risk: number } {
  const a = st.area || 1;
  return { thin: st.thin / a, ok: st.ok / a, heavy: st.heavy / a, risk: st.risk / a };
}

// ---- the pointer's place, for the legend's readout (outside the store: it
// changes on every mouse move) ----------------------------------------------

let hover: Vec2 | null = null;
const listeners = new Set<() => void>();
export function setDensityHover(p: Vec2 | null) {
  if (hover === p || (hover && p && hover[0] === p[0] && hover[1] === p[1])) return;
  hover = p;
  listeners.forEach((l) => l());
}
export const densityHover = {
  get: () => hover,
  subscribe: (l: () => void) => {
    listeners.add(l);
    return () => listeners.delete(l);
  },
};
