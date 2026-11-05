// Auto-digitize presets and the quick controls over them.
//
// Five presets, each a complete, sewable starting point (they set every
// option they care about, from the defaults), and four quick controls that
// move several low-level options together: outlines, detail, background and
// border. The detailed settings stay in their tabs; a quick control shows
// "custom" when they no longer match one of its steps.

import type { DigitizeOptions } from "../types";

/** Options remembered between sessions (image-specific colour edits are not). */
export type DigitizeSettings = Required<
  Omit<DigitizeOptions, "palette" | "paletteBrand" | "fixedColors" | "skipColors" | "lineColors" | "fillColors" | "edgeColors" | "colorOrder" | "widthMm" | "masks" | "edgeMap" | "regionEdits">
>;

export const DIGITIZE_DEFAULTS: DigitizeSettings = {
  colors: 6,
  removeBackground: true,
  backgroundScope: "outside",
  minRegionMm2: 1.5,
  smoothing: 2,
  simplifyMm: 0.12,
  overlapMm: 0.2,
  satinMaxWidthMm: 6,
  runningMaxWidthMm: 0.9,
  maxPixels: 640,
  allowSatin: true,
  allowRunning: true,
  fillMethod: "tatami",
  fillAngle: null,
  // commercial practice: 0.4 mm rows for 40 wt (an auto-digitizer stacks
  // overlap, underlay and outlines on top, so denser rows pile up)
  rowSpacing: 0.4,
  underlay: true,
  outline: "none",
  outlineWidthMm: 1.5,
  outlineColor: [28, 28, 28],
  denoise: 1,
  mergeDeltaE: 3,
  seamless: true,
  cornerAngle: 50,
  fillDirection: "axis",
  flowDetail: 40,
  flowSmoothing: 2,
  flowStrength: 1,
  gradientFlow: false,
  edgeOutlines: "none",
  edgeContrast: 30,
  lineArt: "none",
  lineStrength: 0.5,
  lineNetworks: true,
  lineMaxWidthMm: 3,
  inkSensitivity: 50,
  lineGapMm: 1,
  lineMinMm: 2,
  lineContinuity: 35,
  lineTaper: true,
  thinTriple: false,
  lineSubpixel: true,
  outlineLineMm: 0,
  routeLines: true,
  photoZigzag: false,
  photoSpacing: 1,
  photoAngle: 45,
  photoContrast: 1.2,
  photoMin: 0.12,
  pixelArt: "auto",
  gradients: false,
};

export type PresetId = "logo" | "illustration" | "drawing" | "photo" | "pixel";

export interface DigitizePreset {
  id: PresetId;
  label: string;
  hint: string;
  opts: Partial<DigitizeSettings>;
}

/** The narrowest even outline; below 1 mm it is a triple running stitch, not a satin. */
export const OUTLINE_MIN_MM = 0.5;
export const OUTLINE_DEFAULT_MM = 1.2;

export const DIGITIZE_PRESETS: DigitizePreset[] = [
  {
    id: "logo",
    label: "Logo",
    hint: "Flat colours, outlines as even satin on top, every enclosed area stitched, the outlines sewn as one network",
    opts: {
      colors: 6,
      denoise: 1,
      smoothing: 2,
      minRegionMm2: 1.5,
      simplifyMm: 0.12,
      maxPixels: 800,
      overlapMm: 0.3,
      removeBackground: true,
      backgroundScope: "border",
      lineNetworks: true,
      outlineLineMm: OUTLINE_DEFAULT_MM,
      routeLines: true,
      allowSatin: true,
      satinMaxWidthMm: 6,
      allowRunning: true,
      fillMethod: "tatami",
      rowSpacing: 0.4,
      underlay: true,
      pixelArt: "off",
    },
  },
  {
    id: "illustration",
    label: "Illustration",
    hint: "More colours and finer detail; lines keep the width they are drawn with",
    opts: { colors: 10, denoise: 1, smoothing: 1, minRegionMm2: 0.8, removeBackground: true, backgroundScope: "outside", simplifyMm: 0.1, maxPixels: 900, satinMaxWidthMm: 5, lineNetworks: true, outlineLineMm: 0, fillMethod: "tatami", rowSpacing: 0.4, underlay: true, pixelArt: "off" },
  },
  {
    id: "drawing",
    label: "Line art",
    hint: "Drawings and sketches: few colours, the lines as satin or running stitch along their centre",
    opts: {
      colors: 3,
      denoise: 1,
      removeBackground: true,
      backgroundScope: "outside",
      smoothing: 1,
      minRegionMm2: 0.5,
      simplifyMm: 0.08,
      maxPixels: 1000,
      satinMaxWidthMm: 8,
      runningMaxWidthMm: 1.2,
      lineNetworks: true,
      outlineLineMm: 0,
      lineGapMm: 1.5,
      pixelArt: "off",
    },
  },
  {
    id: "photo",
    label: "Photo",
    hint: "Smoothed colours, gradient fills, rows that follow the picture",
    opts: {
      colors: 10,
      smoothing: 1,
      denoise: 2,
      removeBackground: true,
      backgroundScope: "outside",
      mergeDeltaE: 4,
      minRegionMm2: 2,
      gradients: true,
      gradientFlow: true,
      fillDirection: "axis",
      fillMethod: "flow",
      flowStrength: 1,
      rowSpacing: 0.4,
      lineNetworks: false,
      pixelArt: "off",
      allowSatin: false,
      allowRunning: false,
    },
  },
  {
    id: "pixel",
    label: "Pixel art",
    hint: "Sprites and icons: smooth, depixelized shapes",
    opts: { colors: 16, removeBackground: true, backgroundScope: "outside", smoothing: 0, denoise: 0, mergeDeltaE: 0, minRegionMm2: 0, pixelArt: "on", allowSatin: false, allowRunning: false, fillMethod: "tatami" },
  },
];

/** A preset's full settings: the defaults with its options (nothing leaks from the last one). */
export function presetSettings(id: PresetId, keep: Partial<DigitizeSettings> = {}): DigitizeSettings {
  const p = DIGITIZE_PRESETS.find((x) => x.id === id)!;
  return { ...DIGITIZE_DEFAULTS, ...keep, ...p.opts };
}

/** The preset the settings still match, if any. */
export function presetOf(s: DigitizeSettings): PresetId | null {
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  return DIGITIZE_PRESETS.find((p) => (Object.keys(p.opts) as (keyof DigitizeSettings)[]).every((k) => same(s[k], p.opts[k])))?.id ?? null;
}

// ---- quick controls -------------------------------------------------------

/** Outlines: none, as drawn in the picture, or even satin of one width. */
export type Outlines = "off" | "drawn" | "even";

export function outlinesOf(s: DigitizeSettings): Outlines {
  if (!s.lineNetworks) return "off";
  return s.outlineLineMm > 0 ? "even" : "drawn";
}

export function outlinesPatch(v: Outlines, widthMm: number): Partial<DigitizeSettings> {
  switch (v) {
    case "off":
      return { lineNetworks: false };
    case "drawn":
      return { lineNetworks: true, outlineLineMm: 0 };
    case "even":
      return { lineNetworks: true, outlineLineMm: Math.max(OUTLINE_MIN_MM, widthMm || OUTLINE_DEFAULT_MM), allowSatin: true };
  }
}

/** Detail: how small a shape survives and how closely outlines are traced. */
export type Detail = "bold" | "normal" | "fine";

export const DETAIL: Record<Detail, Pick<DigitizeSettings, "smoothing" | "minRegionMm2" | "simplifyMm" | "maxPixels">> = {
  bold: { smoothing: 3, minRegionMm2: 3, simplifyMm: 0.15, maxPixels: 500 },
  normal: { smoothing: 2, minRegionMm2: 1.5, simplifyMm: 0.12, maxPixels: 800 },
  fine: { smoothing: 1, minRegionMm2: 0.6, simplifyMm: 0.08, maxPixels: 1100 },
};

export function detailOf(s: DigitizeSettings): Detail | null {
  return (Object.keys(DETAIL) as Detail[]).find((d) => (Object.keys(DETAIL[d]) as (keyof typeof DETAIL.bold)[]).every((k) => s[k] === DETAIL[d][k])) ?? null;
}

/** Background: what happens to the colour around the design. */
export type Backdrop = "fabric" | "enclosed" | "all";

export function backdropOf(s: DigitizeSettings): Backdrop {
  if (!s.removeBackground) return "all";
  return s.backgroundScope === "border" ? "enclosed" : "fabric";
}

export function backdropPatch(v: Backdrop): Partial<DigitizeSettings> {
  switch (v) {
    case "fabric":
      return { removeBackground: true, backgroundScope: "outside" };
    case "enclosed":
      return { removeBackground: true, backgroundScope: "border" };
    case "all":
      return { removeBackground: false };
  }
}

/** Settings remembered under an older key or version: missing options take their defaults. */
export function migrateSettings(saved: Partial<DigitizeSettings> & { fillDirection?: string }): DigitizeSettings {
  const s = { ...DIGITIZE_DEFAULTS, ...saved } as DigitizeSettings;
  // direction "flow" used to switch every fill to a flow fill
  return (s.fillDirection as string) === "flow" ? { ...s, fillMethod: "flow", fillDirection: "axis" } : s;
}
