// Lettering layout: a TextSpec and a loaded font → design objects. Pure (no
// font loading, no engine), so every rule can be checked in tests and reused
// by other tools (font sample sheets, batch lettering, the font editor's
// preview).
//
// Embroidery fonts are laid out exactly like Ink/Stitch's Font._render_glyph:
//   x += glyph.min_x − kerning + letter_spacing   (not for the first letter)
//   place glyph (moved so min_x → 0 and baseline → 0) at x
//   x += horiz_adv_x[char] − glyph.min_x
// Spaces advance by horiz_adv_x_space (+ word spacing); lines by the font's
// leading. Then, like Font.render_text: Block alignment spreads each line to
// the widest one, and back-and-forth lines are stitched in alternate
// directions with the font's reversed variant.

import { defaultFill, defaultRunning, defaultSatin, fillMethodDefaults, uid } from "./geometry";
import type { EmbroideryFont, LoadedFont, OutlineFont } from "./fonts";
import type { TextSpec } from "./text";
import type { DesignObject, FillParams, PathNode, StitchParams, SubPath, Vec2 } from "../types";

/** A polyline as a map: arc length → point and direction (for text on a path). */
export function pathMap(pts: Vec2[]) {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const total = cum[cum.length - 1];
  const at = (s: number): { p: Vec2; t: Vec2 } => {
    // beyond the ends: straight on along the end direction
    const k = s <= 0 ? 1 : s >= total ? pts.length - 1 : Math.max(1, cum.findIndex((c) => c >= s));
    const a = pts[k - 1];
    const b = pts[k];
    const l = cum[k] - cum[k - 1] || 1e-9;
    const t: Vec2 = [(b[0] - a[0]) / l, (b[1] - a[1]) / l];
    const u = s - cum[k - 1];
    return { p: [a[0] + t[0] * u, a[1] + t[1] * u], t };
  };
  return { total, at };
}

type Mat = (p: Vec2) => Vec2;

/** Bend a straight layout (baseline y = 0, centred on x = 0 for the arc) along a circle. */
function arcMap(arcDeg: number, width: number): Mat | null {
  if (Math.abs(arcDeg) < 0.5 || width <= 0) return null;
  const R = width / ((Math.abs(arcDeg) * Math.PI) / 180);
  if (arcDeg > 0) {
    // centre below the text: ends drop, letters fan outwards
    return ([x, y]) => {
      const phi = x / R;
      const r = R - y;
      return [r * Math.sin(phi), R - r * Math.cos(phi)];
    };
  }
  // centre above the text: a smile, letter tops point to the centre
  return ([x, y]) => {
    const phi = x / R;
    const r = R + y;
    return [r * Math.sin(phi), -R + r * Math.cos(phi)];
  };
}

function mapNodes(paths: SubPath[], f: Mat): SubPath[] {
  return paths.map((sp) => ({
    closed: sp.closed,
    nodes: sp.nodes.map((n): PathNode => ({ p: f(n.p), ...(n.i ? { i: f(n.i) } : {}), ...(n.o ? { o: f(n.o) } : {}) })),
  }));
}

const shiftX = (paths: SubPath[], dx: number) => (dx ? mapNodes(paths, ([x, y]) => [x + dx, y]) : paths);

/** Which letter, word and line (all counted through the whole text) a piece belongs to. */
export interface Unit {
  letter: number;
  word: number;
  line: number;
}

interface Piece {
  paths: SubPath[];
  stitch: StitchParams;
  role: TextSpec["role"];
  name: string;
  thread: string;
  colorIndex?: number;
  unit?: Unit;
  /** The glyph's own trim (from the font). */
  trimAfter?: boolean;
}

/** One laid-out line: its pieces, advance width and ink width (mm). */
interface Line<T> {
  items: T[];
  width: number;
  ink: number;
}

// ---------------------------------------------------------------------------
// Shared rules (Ink/Stitch Font.render_text)

const OPPOSITE: Record<string, string> = { ltr: "rtl", rtl: "ltr", ttb: "btt", btt: "ttb" };
/** The variant stitched the other way round (FontVariant.reversed_variant). */
export const reversedVariant = (v: string) => OPPOSITE[v] ?? v;

/**
 * The variant (glyph set) of line `line` (0-based): back and forth, every
 * second line uses the reversed variant.
 */
export function lineVariant(variant: string, backAndForth: boolean, line: number): string {
  return backAndForth && line % 2 === 1 ? reversedVariant(variant) : variant;
}

/**
 * Whether the glyphs of a line are stitched in reverse order (from the end
 * of the line): right-to-left variants run backwards, and back and forth
 * every second line turns round. Top-to-bottom / bottom-to-top variants keep
 * the reading order — their glyphs turn round instead.
 */
export function reverseLine(variant: string, backAndForth: boolean, line: number): boolean {
  const odd = backAndForth && line % 2 === 1;
  return (variant === "ltr" && odd) || (variant === "rtl" && !odd);
}

/**
 * Block alignment (Ink/Stitch text_align 3 and 4): a line's extra space
 * (`distance`, to the widest line) spread evenly over the gaps between its
 * units — words, or the letters of a one-word line. Returns each unit's
 * shift; nothing for a single unit.
 */
export function blockOffsets(units: number[], distance: number): Map<number, number> {
  const out = new Map<number, number>();
  if (units.length < 2 || !(distance > 0)) return out;
  const per = distance / (units.length - 1);
  units.forEach((u, i) => out.set(u, per * i));
  return out;
}

const firstSeen = (ids: number[]) => [...new Set(ids)];

/** Spread the lines of a Block-aligned text to the widest one (in place). */
function justify<T extends { paths: SubPath[]; unit?: Unit }>(lines: Line<T>[], letters: boolean) {
  const widest = Math.max(0, ...lines.map((l) => l.ink));
  for (const line of lines) {
    const withUnit = line.items.filter((it) => it.unit);
    let units = firstSeen(withUnit.map((it) => it.unit!.word));
    let by: "word" | "letter" = "word";
    if (letters && units.length === 1) {
      units = firstSeen(withUnit.map((it) => it.unit!.letter));
      by = "letter";
    }
    const distance = widest - line.ink;
    const off = blockOffsets(units, distance);
    if (!off.size) continue;
    for (const it of line.items) if (it.unit) it.paths = shiftX(it.paths, off.get(it.unit[by]) ?? 0);
    line.width += distance;
    line.ink = widest;
  }
}

/** Reverse the letter order of a line, keeping each letter's own order. */
function reverseLetters<T extends { unit?: Unit }>(items: T[]): T[] {
  const groups: T[][] = [];
  for (const it of items) {
    const g = groups[groups.length - 1];
    if (g && g[0].unit?.letter === it.unit?.letter) g.push(it);
    else groups.push([it]);
  }
  return groups.reverse().flat();
}

const isBlock = (a: TextSpec["align"]) => a === "block" || a === "blockLetters";

// ---------------------------------------------------------------------------
// Glyph selection, ported from Ink/Stitch's FontVariant: the longest glyph name
// matching at the current position wins (ligatures), and Arabic-style shaped
// glyphs ("x.init", "x.medi", "x.fina", "x.isol") are picked by position.

const cps = (s: string) => Array.from(s);
const isLetter = (c: string) => /\p{L}/u.test(c);
const isMark = (c: string) => /\p{M}/u.test(c);
const NON_BINDING = new Set(["ا", "أ", "ﺇ", "آ", "ٱ", "د", "ذ", "ر", "ز", "و", "ؤ"].map((c) => c.normalize("NFC")));
const isBinding = (c: string) => !NON_BINDING.has(c);
const SHAPES = new Set(["isol", "init", "medi", "fina"]);

const startsCache = new WeakMap<Set<string>, Map<string, string[]>>();
/** Glyph names starting with `ch`, longest base name first. */
function glyphsStartWith(names: Set<string>, ch: string): string[] {
  let m = startsCache.get(names);
  if (!m) startsCache.set(names, (m = new Map()));
  let hit = m.get(ch);
  if (!hit) {
    const key = (g: string) => [cps(g.split(".")[0]).length, cps(g).length];
    hit = [...names]
      .filter((g) => g.startsWith(ch))
      .sort((a, b) => {
        const [a0, a1] = key(a);
        const [b0, b1] = key(b);
        return b0 - a0 || b1 - a1;
      });
    m.set(ch, hit);
  }
  return hit;
}

function glyphShape(word: string[], starting: number, ending: number, previousIsBinding: boolean): string {
  let last = word.length - 1;
  let first = 0;
  while (last > 0 && !isLetter(word[last])) last--;
  while (first < word.length - 1 && !isLetter(word[first])) first++;
  if (starting === first) return !isBinding(word[ending]) || word.length === 1 ? "isol" : "init";
  if (ending === last || !isBinding(word[ending])) return previousIsBinding ? "fina" : "isol";
  return previousIsBinding ? "medi" : "init";
}

/** Glyph names for a word (null = render as a space), like Ink/Stitch's _get_word_glyphs. */
function wordGlyphs(font: EmbroideryFont, names: Set<string>, text: string): (string | null)[] {
  let word = text;
  if (font.letterCase === "upper") word = word.toUpperCase();
  else if (font.letterCase === "lower") word = word.toLowerCase();
  const w = cps(word);
  const out: (string | null)[] = [];
  let previousIsBinding = true;
  let i = 0;
  while (i < w.length) {
    const rest = w.slice(i).join("");
    let found: string | null = null;
    let n = 1;
    let binding = true;
    for (const g of glyphsStartWith(names, w[i])) {
      const parts = g.split(".");
      if (parts.length === 2 && SHAPES.has(parts[1])) {
        const base = cps(parts[0]);
        if (w.length < i + base.length) continue;
        const shape = glyphShape(w, i, i + base.length - 1, previousIsBinding);
        if (parts[1] === shape && rest.startsWith(parts[0])) {
          found = g;
          n = base.length;
          binding = isBinding(base[base.length - 1]);
          break;
        }
      } else if (rest.startsWith(g)) {
        found = g;
        n = cps(g).length;
        binding = isMark(w[i]) ? previousIsBinding : true;
        break;
      }
    }
    previousIsBinding = binding;
    if (!found && font.defaultGlyph === " ") out.push(null);
    else out.push(found ?? (names.has(font.defaultGlyph) ? font.defaultGlyph : null));
    i += n;
  }
  return out;
}

/** The variant a lettering's glyphs are stitched in: its choice if the font has it, else the font's default. */
export const textVariant = (spec: Pick<TextSpec, "variant">, font: EmbroideryFont) =>
  spec.variant && font.variants.includes(spec.variant) ? spec.variant : font.variant;

/** Straight layout of embroidery-font glyph objects, mm, first baseline at y = 0. */
async function layoutEmbroidery(spec: TextSpec, font: EmbroideryFont): Promise<{ lines: Line<Piece>[]; fontFill?: FillParams["method"] }> {
  const scale = spec.size / font.size;
  const rtl = font.direction === "rtl";
  const rows = spec.content.split("\n").map((l) => l.trim());
  const ls = spec.letterSpacing / scale; // applied before scaling, like Ink/Stitch
  const ws = (spec.wordSpacing ?? 0) / scale;
  const variant = textVariant(spec, font);
  const bf = !!spec.backAndForth && font.reversible;
  const lines: Line<Piece>[] = [];
  const fills = new Map<FillParams["method"], number>();
  let letterNo = 0;
  let wordNo = 0;
  for (let li = 0; li < rows.length; li++) {
    const v = lineVariant(variant, bf, li);
    const names = font.namesOf(v);
    const y = li * font.leading * spec.lineSpacing;
    let x = 0;
    let inkR = 0;
    const line: Piece[] = [];
    // right-to-left fonts: glyphs are placed left to right in visual order
    const words = (rtl ? cps(rows[li]).reverse().join("") : rows[li]).split(" ");
    for (let wi = 0; wi < words.length; wi++) {
      if (wi > 0) x += font.space + ws;
      wordNo++;
      const glyphs = rtl ? wordGlyphs(font, names, cps(words[wi]).reverse().join("")).reverse() : wordGlyphs(font, names, words[wi]);
      let last: string | null = null;
      for (const name of glyphs) {
        const g = name === null ? null : await font.glyph(name, v);
        if (!g || name === null) {
          x += font.space;
          last = null;
          continue;
        }
        if (last !== null) {
          const pair = rtl ? [name, last] : [last, name];
          const k = font.kerning[`${pair[0]} ${pair[1]}`] ?? font.kerning[pair[0] + pair[1]] ?? 0;
          x += g.minX - k + ls;
        }
        const dx = x;
        letterNo++;
        if (g.objects.length) inkR = Math.max(inkR, dx + g.width);
        g.objects.forEach((o, oi) => {
          const ci = g.colors[oi] ?? 0;
          if (o.stitch.type === "fill") fills.set(o.stitch.method, (fills.get(o.stitch.method) ?? 0) + 1);
          line.push({
            paths: mapNodes(o.paths, ([px, py]) => [(px + dx) * scale, (py + y) * scale]),
            stitch: letterFill(o.stitch, spec, scale),
            unit: { letter: letterNo, word: wordNo, line: li },
            trimAfter: o.trimAfter,
            role: "glyph",
            name,
            thread: spec.palette?.[ci] ?? spec.thread,
            colorIndex: ci,
          });
        });
        x += (font.adv[name] ?? font.advDefault ?? g.width + g.minX) - g.minX;
        last = name;
      }
    }
    lines.push({ items: line, width: x * scale, ink: inkR * scale });
  }
  if (isBlock(spec.align)) justify(lines, spec.align === "blockLetters");
  // stitch order: right-to-left variants and every second back-and-forth line run backwards
  lines.forEach((l, li) => {
    if (reverseLine(variant, bf, li)) l.items = reverseLetters(l.items);
  });
  // the fill most of the font's filled areas use
  const fontFill = [...fills.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  return { lines, fontFill };
}

/** A letter's stitch with the lettering's fill choice: the font's own, or
 *  another fill method (keeping the font's angle); cross stitch keeps its
 *  grid on the letter (as the font's own cross-stitch fills do). */
export function letterFill(st: StitchParams, spec: TextSpec, scale: number): StitchParams {
  if (st.type !== "fill") return st;
  if (!spec.fill || spec.fill === "font") {
    if (st.method === "cross" && spec.crossScale) return { ...st, crossSize: (st.crossSize ?? 2.5) * scale };
    return st;
  }
  if (spec.fill === st.method) return st;
  const next: StitchParams = { ...st, ...defaultFill(), ...fillMethodDefaults(spec.fill), type: "fill", method: spec.fill, angle: st.angle };
  if (spec.fill === "cross") return { ...next, crossGridCanvas: false };
  return next;
}

/** opentype.js path commands → sub-paths (cubic Béziers). */
function commandsToSubPaths(commands: opentype.PathCommand[]): SubPath[] {
  const subs: SubPath[] = [];
  let cur: SubPath | null = null;
  let last: Vec2 = [0, 0];
  for (const c of commands) {
    if (c.type === "M") {
      if (cur && cur.nodes.length > 1) subs.push(cur);
      cur = { nodes: [{ p: [c.x, c.y] }], closed: false };
      last = [c.x, c.y];
    } else if (c.type === "L" && cur) {
      cur.nodes.push({ p: [c.x, c.y] });
      last = [c.x, c.y];
    } else if (c.type === "C" && cur) {
      cur.nodes[cur.nodes.length - 1].o = [c.x1, c.y1];
      cur.nodes.push({ p: [c.x, c.y], i: [c.x2, c.y2] });
      last = [c.x, c.y];
    } else if (c.type === "Q" && cur) {
      cur.nodes[cur.nodes.length - 1].o = [last[0] + (2 / 3) * (c.x1 - last[0]), last[1] + (2 / 3) * (c.y1 - last[1])];
      cur.nodes.push({ p: [c.x, c.y], i: [c.x + (2 / 3) * (c.x1 - c.x), c.y + (2 / 3) * (c.y1 - c.y)] });
      last = [c.x, c.y];
    } else if (c.type === "Z" && cur) {
      const a = cur.nodes[0];
      const b = cur.nodes[cur.nodes.length - 1];
      if (cur.nodes.length > 1 && Math.hypot(a.p[0] - b.p[0], a.p[1] - b.p[1]) < 1e-6) {
        if (b.i) a.i = b.i;
        cur.nodes.pop();
      }
      cur.closed = true;
      subs.push(cur);
      cur = null;
    }
  }
  if (cur && cur.nodes.length > 1) subs.push(cur);
  return subs;
}

/** Straight layout of outline-font glyph contours (per glyph), mm, first baseline at y = 0. */
function layoutOutline(spec: TextSpec, font: OutlineFont): Line<{ paths: SubPath[]; unit: Unit }>[] {
  const f = font.font;
  const os2 = f.tables.os2 as { sCapHeight?: number } | undefined;
  const cap = os2?.sCapHeight || f.unitsPerEm * 0.7;
  const size = (spec.size * f.unitsPerEm) / cap; // font size in mm
  const opts = { kerning: true, letterSpacing: spec.letterSpacing / size } as opentype.RenderOptions;
  const lineH = ((f.ascender - f.descender) / f.unitsPerEm) * size * 1.05 * spec.lineSpacing;
  const ws = spec.wordSpacing ?? 0;
  const out: Line<{ paths: SubPath[]; unit: Unit }>[] = [];
  let letterNo = 0;
  let wordNo = 0;
  spec.content.split("\n").forEach((line, li) => {
    // glyph by glyph: spaces separate words (word spacing, Block alignment)
    // the same glyph run getPaths renders (ligatures included)
    const glyphs = (f.stringToGlyphs as (this: opentype.Font, s: string, o?: opentype.RenderOptions) => opentype.Glyph[]).call(f, line, { ...(f as unknown as { defaultRenderOptions: object }).defaultRenderOptions, ...opts });
    const paths = f.getPaths(line, 0, li * lineH, size, opts);
    const items: { paths: SubPath[]; unit: Unit }[] = [];
    let words = 0;
    let inWord = false;
    let inkR = 0;
    glyphs.forEach((g, gi) => {
      const space = g.unicode === 32 || (g.unicodes ?? []).includes(32);
      if (space) {
        if (inWord) words++;
        inWord = false;
        return;
      }
      if (!inWord) wordNo++;
      inWord = true;
      letterNo++;
      const subs = shiftX(commandsToSubPaths(paths[gi]?.commands ?? []), words * ws);
      if (!subs.length) return;
      const bb = paths[gi].getBoundingBox();
      inkR = Math.max(inkR, bb.x2 + words * ws);
      items.push({ paths: subs, unit: { letter: letterNo, word: wordNo, line: li } });
    });
    const gaps = Math.max(0, line.trim().split(/ +/).length - 1);
    out.push({ items, width: f.getAdvanceWidth(line, size, opts) + gaps * ws, ink: inkR });
  });
  return out;
}

/** Lay out a lettering with its (loaded) font. */
export async function layoutText(spec: TextSpec, font: LoadedFont): Promise<DesignObject[]> {
  let lines: Line<Piece>[];
  let fontFill: FillParams["method"] | undefined;
  const label = spec.content.split("\n")[0].slice(0, 18) || "Text";
  if (font.kind === "embroidery") {
    const l = await layoutEmbroidery(spec, font);
    lines = l.lines;
    fontFill = l.fontFill;
  } else {
    const glyphLines = layoutOutline(spec, font);
    if (isBlock(spec.align)) justify(glyphLines, spec.align === "blockLetters");
    lines = glyphLines.map((gl) => {
      const ps: Piece[] = [];
      const paths = gl.items.flatMap((it) => it.paths);
      if (paths.length) {
        if (spec.style === "fill" || spec.style === "fillBorder")
          ps.push({ paths, stitch: { type: "fill", ...defaultFill(), angle: spec.fillAngle, underlayInset: 0.2 }, role: "fill", name: "fill", thread: spec.thread });
        if (spec.style === "border" || spec.style === "fillBorder")
          ps.push({
            paths,
            stitch: { type: "satin", ...defaultSatin(), width: spec.borderWidth, multi: true, centerWalk: true, shortStitchInset: 0.25 },
            role: "border",
            name: "border",
            thread: spec.style === "fillBorder" ? spec.borderThread : spec.thread,
          });
        if (spec.style === "outline")
          ps.push({ paths, stitch: { type: "running", ...defaultRunning(), length: 1.6, beanRepeats: 2 }, role: "outline", name: "outline", thread: spec.thread });
      }
      return { items: ps, width: gl.width, ink: gl.ink };
    });
  }
  const widths = lines.map((l) => l.width);
  // alignment: x = 0 is the alignment point of every line (Block: like left)
  const blockW = Math.max(0, ...widths);
  const shiftFor = (w: number) => (spec.align === "center" ? -w / 2 : spec.align === "right" ? -w : 0);
  // arc: bend around the centre of the widest line
  const arcShift = spec.align === "center" ? 0 : spec.align === "right" ? blockW / 2 : -blockW / 2;
  const bend = arcMap(spec.arc, blockW);
  const rad = (spec.rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const [ax, ay] = spec.anchor;
  const out: DesignObject[] = [];
  const sortKeys: [number, number][] = [];
  // trims: after the last piece of every letter / word / line (and the font's own)
  if (font.kind === "embroidery") {
    const all = lines.flatMap((l) => l.items);
    const level = spec.trims && spec.trims !== "never" ? spec.trims : null;
    all.forEach((pc, i) => {
      const next = all[i + 1];
      const ends = !!level && !!next && !!pc.unit && !!next.unit && pc.unit[level] !== next.unit[level];
      pc.trimAfter = !!pc.trimAfter || ends;
    });
  }
  const along = spec.path && spec.path.length >= 2 ? pathMap(spec.pathFlip ? [...spec.path].reverse() : spec.path) : null;
  const objectOf = (piece: Piece, paths: SubPath[], stitch: StitchParams): DesignObject => ({
    id: uid(),
    name: font.kind === "embroidery" ? `${label} · ${piece.name}` : `${label} (${piece.name})`,
    thread: piece.thread,
    visible: true,
    locked: false,
    paths,
    stitch,
    trimAfter: !!piece.trimAfter,
    stopAfter: false,
    text: { ...spec, role: piece.role, ...(piece.colorIndex !== undefined ? { colorIndex: piece.colorIndex } : {}), ...(fontFill ? { fontFill } : {}) },
  });
  const sortKey = (piece: Piece): [number, number] =>
    piece.unit ? [spec.colorSort === "line" ? piece.unit.line : spec.colorSort === "word" ? piece.unit.word : 0, piece.colorIndex ?? 0] : [0, 0];
  lines.forEach((line, li) => {
    const sx = shiftFor(widths[li]);
    // on a path: x runs along it, y off it (each line its own offset)
    if (along) {
      const w = widths[li];
      const align = spec.pathAlign ?? "center";
      const k = align === "stretch" && w > 0 ? along.total / w : 1;
      const x0 = align === "start" ? 0 : align === "end" ? along.total - w : align === "stretch" ? 0 : (along.total - w) / 2;
      const fp: Mat = ([x, y]) => {
        // every line runs from x = 0 to its width
        const { p, t } = along.at(x0 + x * k);
        // normal: to the right of the direction is "down" (y grows downwards)
        return [p[0] - t[1] * y, p[1] + t[0] * y];
      };
      for (const piece of line.items) {
        sortKeys.push(sortKey(piece));
        out.push(objectOf(piece, mapNodes(piece.paths, fp), piece.stitch));
      }
      return;
    }
    const f: Mat = ([x, y]) => {
      let p: Vec2 = [x + sx, y];
      if (bend) {
        const q = bend([p[0] + arcShift, p[1]]);
        p = [q[0] - arcShift, q[1]];
      }
      return [ax + p[0] * cos - p[1] * sin, ay + p[0] * sin + p[1] * cos];
    };
    // fill/border/outline pieces of one line are merged across lines below
    for (const piece of line.items) {
      sortKeys.push(sortKey(piece));
      let stitch = piece.stitch;
      if (stitch.type === "fill" && spec.rotation) stitch = { ...stitch, angle: stitch.angle - spec.rotation };
      out.push(objectOf(piece, mapNodes(piece.paths, f), stitch));
    }
  });
  // colour sort (embroidery fonts): stable, by scope then colour
  if (font.kind === "embroidery" && spec.colorSort && spec.colorSort !== "off") {
    const order = out.map((_, i) => i).sort((a, b) => sortKeys[a][0] - sortKeys[b][0] || sortKeys[a][1] - sortKeys[b][1] || a - b);
    const sorted = order.map((i) => out[i]);
    out.length = 0;
    out.push(...sorted);
  }
  if (font.kind === "outline") {
    // one object per role for the whole lettering (lines merged)
    const byRole = new Map<string, DesignObject>();
    for (const o of out) {
      const k = o.text!.role!;
      const prev = byRole.get(k);
      if (prev) prev.paths.push(...o.paths);
      else byRole.set(k, { ...o, paths: [...o.paths], name: `${label} (${k})` });
    }
    // fill first, border on top
    return ["fill", "border", "outline"].flatMap((k) => (byRole.has(k) ? [byRole.get(k)!] : []));
  }
  return out;
}
