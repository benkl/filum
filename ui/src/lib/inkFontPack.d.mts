// Types of inkFontPack.mjs (shared with scripts/bundle-fonts.mjs).

export const VARIANTS: [string, string][];
export const PX_PER: Record<string, number>;
export function round(v: number, k?: number): number;
export function roundMap(m: Record<string, number> | undefined, keepZero: boolean): Record<string, number>;
export function extractGlyphs(text: string): { glyphs: Record<string, string>; baseline: number | null };
export function pruneEmpty(s: string): string;
export function variantId(v: string): string;
export function collectColors(glyphs: Record<string, string>, colors: string[]): string[];

export interface PackedChunk {
  file: string;
  baseline: number | null;
  glyphs: string[];
}

/** The metrics of Ink/Stitch's font.json the app uses (px). */
export interface FontMetrics {
  name: string;
  size: number;
  leading: number;
  horiz_adv_x_space: number;
  horiz_adv_x_default: number | null;
  horiz_adv_x: Record<string, number>;
  kerning_pairs: Record<string, number>;
  letter_case: string;
  default_glyph: string;
  text_direction: string;
  min_scale: number;
  max_scale: number;
  /** Ink/Stitch "reversible": lines may be stitched back and forth (default true). */
  reversible?: boolean;
  /** Ink/Stitch "sortable": colour sort allowed. */
  sortable?: boolean;
}

export interface PackedFont extends FontMetrics {
  /** The default variant ("ltr", "rtl", "ttb", "btt"): its glyphs are `chunks`. */
  variant: string;
  colors: string[];
  chunks: PackedChunk[];
  /** The font's other variants (absent in fonts bundled before they were packed). */
  variants?: Record<string, PackedChunk[]>;
}

export function fontMetrics(meta: Record<string, unknown>): FontMetrics;
export function buildFont(
  meta: Record<string, unknown>,
  files: string[],
  variant?: string,
  more?: Record<string, string[]>,
): { font: PackedFont; data: Record<string, Record<string, string>> };
