// Lettering tools built on the layout: batch lettering (Ink/Stitch's
// batch_lettering.py), font sample sheets (lettering_font_sample.py) and the
// font-info editor's live metrics (Edit JSON). Pure — the store-level
// actions are in textOps.ts.

import { fontMetrics } from "./inkFontPack.mjs";
import type { EmbroideryFont } from "./fonts";

const PX = 25.4 / 96;

// ---------------------------------------------------------------------------
// Batch lettering

/**
 * The texts of a batch (Ink/Stitch: split at the separator, a new line by
 * default; "\n" typed in a text is a line break). Empty texts are skipped
 * but keep their place in the numbering, like Ink/Stitch's file names.
 */
export function batchTexts(input: string, separator = ""): { index: number; text: string }[] {
  const sep = separator ? separator.replace(/\\n/g, "\n") : "\n";
  return input
    .replace(/\r\n/g, "\n")
    .replace(/\\n/g, "\n")
    .split(sep)
    .map((text, index) => ({ index, text }))
    .filter((t) => t.text.trim() !== "");
}

/**
 * Ink/Stitch's batch file names: the number (3 digits) and a dash with the
 * first ASCII letters and digits of the text, 8 characters at most.
 */
export function batchFileName(index: number, text: string, ext: string): string {
  const letters = text.replace(/[^A-Za-z0-9]/g, "");
  const tail = letters ? `-${letters}`.slice(0, 8) : "";
  return `${String(index).padStart(3, "0")}${tail}.${ext}`;
}

// ---------------------------------------------------------------------------
// Font sample sheet

const SHAPED = /\.(isol|init|medi|fina)$/;

/** A font's glyph names for a sample sheet: in code-point order, without the
 *  positional (Arabic) forms, which the layout picks itself. */
export function sampleGlyphNames(names: Iterable<string>): string[] {
  const cmp = (a: string, b: string) => {
    const x = Array.from(a).map((c) => c.codePointAt(0)!);
    const y = Array.from(b).map((c) => c.codePointAt(0)!);
    for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] - y[i];
    return x.length - y.length;
  };
  return [...names].filter((n) => n && !SHAPED.test(n) && !/\s/.test(n)).sort(cmp);
}

/**
 * Every glyph of a font as lettering text, broken into lines no wider than
 * `maxWidth` mm at cap height `size` (Ink/Stitch's Font Sampling).
 */
export async function fontSampleText(font: EmbroideryFont, size: number, maxWidth: number, variant = font.variant): Promise<string> {
  const scale = size / font.size;
  let text = "";
  let width = 0;
  let last: string | null = null;
  for (const name of sampleGlyphNames(font.namesOf(variant))) {
    const g = await font.glyph(name, variant);
    if (!g || !g.objects.length) continue;
    if (last !== null) width += (g.minX - (font.kerning[`${last} ${name}`] ?? font.kerning[last + name] ?? 0)) * scale;
    const add = ((font.adv[name] ?? font.advDefault ?? g.width + g.minX) - g.minX) * scale;
    if (text && width + add > maxWidth) {
      text += "\n";
      width = 0;
      last = null;
    } else last = name;
    text += name;
    width += add;
  }
  return text;
}

// ---------------------------------------------------------------------------
// Font info (font.json) editing

/** Ink/Stitch's font.json fields the font editor offers, with their defaults. */
export const FONT_INFO_DEFAULTS = {
  name: "",
  description: "",
  font_license: "SIL Open Font License v1.1",
  keywords: [] as string[],
  original_font: "",
  original_font_url: "",
  text_direction: "ltr",
  default_variant: "ltr",
  default_glyph: "�",
  letter_case: "",
  reversible: true,
  sortable: false,
  auto_satin: true,
  size: 0,
  min_scale: 1,
  max_scale: 1,
  leading: 100,
  horiz_adv_x_default: null as number | null,
  horiz_adv_x_space: 20,
  horiz_adv_x: {} as Record<string, number>,
  kerning_pairs: {} as Record<string, number>,
};

/**
 * A loaded embroidery font with (edited) font.json metrics: the font editor's
 * live preview. Lengths in font.json are px; the font works in mm.
 */
export function withFontInfo(font: EmbroideryFont, info: Record<string, unknown>): EmbroideryFont {
  const m = fontMetrics(info);
  const mm = (o: Record<string, number>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v * PX]));
  return {
    ...font,
    name: m.name,
    size: m.size || 20,
    minScale: m.min_scale || 1,
    maxScale: m.max_scale || 1,
    leading: (m.leading || 100) * PX,
    space: (m.horiz_adv_x_space ?? 20) * PX,
    advDefault: m.horiz_adv_x_default == null ? null : m.horiz_adv_x_default * PX,
    adv: mm(m.horiz_adv_x),
    kerning: mm(m.kerning_pairs),
    letterCase: m.letter_case ?? "",
    defaultGlyph: m.default_glyph ?? "�",
    direction: m.text_direction === "rtl" ? "rtl" : "ltr",
    reversible: m.reversible !== false,
  };
}

/** Kerning pairs as rows ("A V" keys; legacy two-letter keys split), sorted. */
export function kerningRows(pairs: Record<string, number>): { key: string; left: string; right: string; value: number }[] {
  return Object.entries(pairs)
    .map(([key, value]) => {
      const sp = key.split(" ");
      const [left, right] = sp.length === 2 && sp[0] && sp[1] ? sp : [Array.from(key)[0] ?? "", Array.from(key).slice(1).join("")];
      return { key, left, right, value };
    })
    .sort((a, b) => a.left.localeCompare(b.left) || a.right.localeCompare(b.right));
}

/** font.json text as Ink/Stitch writes it (indented, UTF-8). */
export function fontJsonText(info: Record<string, unknown>): string {
  return JSON.stringify(info, null, 4) + "\n";
}

// ---------------------------------------------------------------------------
// Letters to font (Ink/Stitch's letters_to_font.py)

const baseName = (path: string) => path.split(/[\/]/).pop() ?? path;

/** The glyph a letter file holds: the last character of its name before the
 *  first dot ("Example_Font_A.pes" → "A"), as Ink/Stitch reads it. */
export function letterOfFile(path: string): string | null {
  const stem = Array.from(baseName(path).split(".")[0]);
  return stem.length ? stem[stem.length - 1] : null;
}

/** A font name from letter files: their common name prefix ("Example_Font_A.pes" … → "Example Font"). */
export function fontNameFromFiles(paths: string[]): string {
  const stems = paths.map((p) => Array.from(baseName(p).split(".")[0]));
  if (!stems.length) return "Letters";
  let n = Math.min(...stems.map((s) => s.length - 1));
  for (let i = 0; i < n; i++)
    if (stems.some((s) => s[i] !== stems[0][i])) {
      n = i;
      break;
    }
  const name = stems[0].slice(0, Math.max(0, n)).join("").replace(/[_\-\s.]+/g, " ").trim();
  return name || "Letters";
}

const xmlAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** An SVG document's content as one Ink/Stitch glyph layer ("GlyphLayer-A"),
 *  moved by `dx` user units (to its left side bearing). */
export function wrapGlyphLayer(svg: string, name: string, dx = 0): string {
  const open = /<svg\b[^>]*>/i.exec(svg);
  const close = svg.lastIndexOf("</svg>");
  if (!open || close < 0) throw new Error("not an SVG document");
  const at = open.index + open[0].length;
  const tr = dx ? ` transform="translate(${Math.round(dx * 1000) / 1000} 0)"` : "";
  return `${svg.slice(0, at)}<g inkscape:label="GlyphLayer-${xmlAttr(name)}" inkscape:groupmode="layer"${tr}>${svg.slice(at, close)}</g></svg>`;
}
