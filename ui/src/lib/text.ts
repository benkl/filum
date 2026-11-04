// Parametric lettering. A lettering is a group of design objects that share a
// TextSpec; whenever the spec changes the group is regenerated, so text stays
// editable (content, font, size, spacing, arc, style) after it is placed.
// The layout itself (Ink/Stitch's rules) is in textLayout.ts.

import { loadFont } from "./fonts";
import { layoutText } from "./textLayout";
import type { DesignObject, FillParams, Vec2 } from "../types";

export type TextStyle = "fill" | "border" | "fillBorder" | "outline";

export interface TextSpec {
  group: string;
  content: string;
  font: string;
  /** Cap height in mm. */
  size: number;
  /** Extra space between letters, mm. */
  letterSpacing: number;
  /** Extra space between words, mm (Ink/Stitch word spacing). */
  wordSpacing?: number;
  /** Multiplier of the font's line height. */
  lineSpacing: number;
  /** "block": every line spread to the widest one by widening the gaps
   *  between words (Ink/Stitch Block); "blockLetters": a line of one word
   *  is spread between its letters instead (Block, letter spacing). */
  align: "left" | "center" | "right" | "block" | "blockLetters";
  /** Bend in degrees: > 0 arches up (top of a badge), < 0 dips down. */
  arc: number;
  rotation: number;
  /** Alignment point of the first baseline (mm). */
  anchor: Vec2;
  /** Outline fonts only. */
  style: TextStyle;
  borderWidth: number;
  fillAngle: number;
  thread: string;
  borderThread: string;
  /** Embroidery fonts with several colours: thread per font colour. */
  palette?: string[];
  /** Which part of the lettering this object is. */
  role?: "fill" | "border" | "outline" | "glyph";
  /** Font colour index of a glyph object. */
  colorIndex?: number;
  /** Embroidery fonts: the fill of the letters' filled areas — "font" (as
   *  the font is digitized, the default) or a fill method instead. */
  fill?: "font" | FillParams["method"];
  /** Cross-stitch fonts: crosses grow with the letters (the designed pattern
   *  at every size) instead of keeping the font's cross size. */
  crossScale?: boolean;
  /** The fill the font is digitized with (set when generated, for the panel). */
  fontFill?: FillParams["method"];
  /** Embroidery fonts: trim after every letter, word or line (Ink/Stitch's
   *  lettering trims); the font's own trims are always kept. */
  trims?: "never" | "letter" | "word" | "line";
  /** Multicolour fonts: sew each colour in one go within the whole text, each
   *  line or each word (Ink/Stitch colour sort) — fewer colour changes. */
  colorSort?: "off" | "all" | "line" | "word";
  /** Lettering along a path (Ink/Stitch "Lettering along path"): the path in
   *  design mm; it replaces the anchor, rotation and arc. */
  path?: Vec2[];
  /** Along the path: from its start, centred, to its end, or stretched over it. */
  pathAlign?: "start" | "center" | "end" | "stretch";
  /** Which side of the path the letters stand on (flip: below, upside down). */
  pathFlip?: boolean;
  /** Embroidery fonts: stitch every second line the other way round, with
   *  the font's reversed variant (Ink/Stitch "Stitch lines of text back and
   *  forth") — less travel between lines. Fonts can forbid it ("reversible"). */
  backAndForth?: boolean;
  /** Embroidery fonts with several variants: the direction the glyphs are
   *  stitched in — "ltr", "rtl", "ttb" (top to bottom) or "btt" (bottom to
   *  top); unset: the font's default variant. */
  variant?: string;
}

export const DEFAULT_TEXT: Omit<TextSpec, "group" | "anchor" | "thread" | "borderThread" | "font"> = {
  content: "Text",
  size: 10,
  letterSpacing: 0,
  lineSpacing: 1,
  align: "center",
  arc: 0,
  rotation: 0,
  style: "fill",
  borderWidth: 1.2,
  fillAngle: 45,
};

/** Generate the objects of a lettering for its spec. */
export async function generateText(spec: TextSpec): Promise<DesignObject[]> {
  return layoutText(spec, await loadFont(spec.font));
}

export const groupOf = (o: DesignObject) => o.text?.group;

/** Members of a lettering, in document order. */
export function members(objects: DesignObject[], group: string) {
  return objects.filter((o) => o.text?.group === group);
}
