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
// leading; letter and word spacing are added at the font's size, so they
// scale with the text. Then, like Font.render_text: lines are aligned by
// their letters' bounding box, Block alignment spreads each line to the
// widest one, back-and-forth lines are stitched in alternate directions with
// the font's reversed variant, the font's auto-satin routes the satins,
// trims follow letters / words / lines and sortable fonts sort their colours
// by colour sort index. Along a path every letter is placed whole and turned
// (TextAlongPath).

import { defaultFill, defaultRunning, defaultSatin, fillMethodDefaults, flatten, transformFlow, uid, type Mat as Affine } from "./geometry";
import { autoSatin } from "./autoSatin";
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

/**
 * Radius of the arc a straight layout `width` mm wide is bent along. The
 * letters reach `extent` mm towards the centre (their height above the
 * baseline for a dip, below it — lower lines, descenders — for an arch): the
 * circle stays that far plus a margin away, else short text with a strong
 * arc would wrap round the centre and turn its letters inside out.
 */
export function arcRadius(arcDeg: number, width: number, extent = 0): number {
  const R = width / ((Math.abs(arcDeg) * Math.PI) / 180);
  const ext = Math.max(0, extent);
  return Math.max(R, ext + Math.max(1, ext * 0.25));
}

/** Bend a straight layout (baseline y = 0, centred on x = 0 for the arc) along a circle. */
function arcMap(arcDeg: number, width: number, extent = 0): Mat | null {
  if (Math.abs(arcDeg) < 0.5 || width <= 0) return null;
  const R = arcRadius(arcDeg, width, extent);
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

/** The local affine approximation of a map at `c` (exact for affine maps). */
function localAffine(f: Mat, c: Vec2): Affine {
  const h = 0.01;
  const o = f(c);
  const ex = f([c[0] + h, c[1]]);
  const ey = f([c[0], c[1] + h]);
  const a = (ex[0] - o[0]) / h;
  const b = (ex[1] - o[1]) / h;
  const cc = (ey[0] - o[0]) / h;
  const d = (ey[1] - o[1]) / h;
  return [a, b, cc, d, o[0] - a * c[0] - cc * c[1], o[1] - b * c[0] - d * c[1]];
}

/** A fill angle turned by `deg` (as transformObject turns them), in (−90, 90]. */
function turnAngle(angle: number, deg: number): number {
  let v = (angle - deg) % 180;
  if (v > 90) v -= 180;
  if (v <= -90) v += 180;
  return Math.abs(v) < 1e-9 ? 0 : v;
}

/** The lines of an object that aren't sewn but shape it: guide lines (guided
 *  fill, ripples) and pattern lines (Ink/Stitch markers). */
export function markerPaths(o: DesignObject): SubPath[] {
  const st = o.stitch;
  return [
    ...(o.patterns ?? []).flatMap((p) => p.paths),
    ...(st.type === "fill" && st.guide ? [st.guide] : []),
    ...(st.type === "running" && st.ripple?.guide ? st.ripple.guide : []),
  ];
}

/**
 * An object mapped by `f` (a glyph's place in a lettering): its paths and
 * every point that belongs to them — start and end points, guide, anchor
 * and pattern lines, ripple targets, satin direction lines, gradient and
 * density-ramp points, flow fields. Fill angles turn with the map (`turn`:
 * by this many degrees instead; null: not at all) and centre-line satins
 * scale with it, as transformObject does.
 */
export function mapGeometry(o: DesignObject, f: Mat, turn?: number | null): DesignObject {
  // the map's rotation and scale where the object is
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const sp of o.paths)
    for (const n of sp.nodes) {
      x0 = Math.min(x0, n.p[0]);
      y0 = Math.min(y0, n.p[1]);
      x1 = Math.max(x1, n.p[0]);
      y1 = Math.max(y1, n.p[1]);
    }
  const m = localAffine(f, isFinite(x0) ? [(x0 + x1) / 2, (y0 + y1) / 2] : [0, 0]);
  const deg = turn === undefined ? (Math.atan2(m[1], m[0]) * 180) / Math.PI : (turn ?? 0);
  const scale = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
  const pt = (p: Vec2): Vec2 => f(p);
  let st = o.stitch;
  if (st.type === "fill") {
    const g = st.gradient;
    st = {
      ...st,
      angle: Math.abs(deg) > 1e-9 ? turnAngle(st.angle, deg) : st.angle,
      ...(st.guide ? { guide: mapNodes([st.guide], f)[0] } : {}),
      ...(st.flow ? { flow: transformFlow(st.flow, m) } : {}),
      ...(st.ramp ? { ramp: { ...st.ramp, from: pt(st.ramp.from), to: pt(st.ramp.to) } } : {}),
      ...(g
        ? {
            gradient: {
              ...g,
              from: pt(g.from),
              to: pt(g.to),
              ...(g.mesh ? { mesh: { ...g.mesh, nodes: g.mesh.nodes.map((n) => ({ ...n, p: pt(n.p) })) } } : {}),
              ...(g.points ? { points: g.points.map((q) => ({ ...q, p: pt(q.p), spread: Math.max(0.5, q.spread * scale) })) } : {}),
            },
          }
        : {}),
    };
  } else if (st.type === "running" && st.ripple) {
    const r = st.ripple;
    st = {
      ...st,
      ripple: {
        ...r,
        ...(r.target ? { target: pt(r.target) } : {}),
        ...(r.guide ? { guide: mapNodes(r.guide, f) } : {}),
        ...(r.anchor ? { anchor: [pt(r.anchor[0]), pt(r.anchor[1])] as [Vec2, Vec2] } : {}),
      },
    };
  } else if (st.type === "satin") {
    st = {
      ...st,
      ...(st.guides ? { guides: st.guides.map(([a, b]) => [pt(a), pt(b)] as [Vec2, Vec2]) } : {}),
      // a centre-line column's width is drawn, not sewn: it scales
      ...((o.paths.length === 1 || st.multi) && Math.abs(scale - 1) > 1e-6 ? { width: Math.max(0.3, +(st.width * scale).toFixed(2)) } : {}),
    };
  }
  const out: DesignObject = { ...o, paths: mapNodes(o.paths, f), stitch: st };
  if (o.patterns?.length) out.patterns = o.patterns.map((p) => ({ ...p, paths: mapNodes(p.paths, f) }));
  if (o.start) out.start = pt(o.start);
  if (o.end) out.end = pt(o.end);
  return out;
}

/** Which letter, word and line (all counted through the whole text) a piece belongs to. */
export interface Unit {
  letter: number;
  word: number;
  line: number;
}

interface Piece {
  /** The object as laid out: geometry, stitch and (embroidery fonts) the
   *  glyph object's own settings — Ink/Stitch commands and params (ties,
   *  lock stitches, min stitch / jump, trim, stop, start / end point),
   *  colour sort index, pattern lines. */
  obj: DesignObject;
  role: TextSpec["role"];
  name: string;
  thread: string;
  colorIndex?: number;
  unit?: Unit;
}

/** One laid-out line: its pieces, advance width, ink width (the letters'
 *  bounding box, Ink/Stitch's line width) and baseline (mm). */
interface Line<T> {
  items: T[];
  width: number;
  ink: number;
  y: number;
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

/** Spread the lines of a Block-aligned text to the widest one (in place); `shift` moves an item. */
function justify<T extends { unit?: Unit }>(lines: Line<T>[], letters: boolean, shift: (it: T, dx: number) => void) {
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
    for (const it of line.items) {
      const dx = it.unit ? (off.get(it.unit[by]) ?? 0) : 0;
      if (dx) shift(it, dx);
    }
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
  // letter and word spacing are added in the font's own size and scale with
  // the letters, as in Ink/Stitch (mm at 100 %)
  const ls = spec.letterSpacing;
  const ws = spec.wordSpacing ?? 0;
  const crossScale = spec.crossScale ?? !!font.scaleCrossStitch;
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
    // the letters' bounding box (Ink/Stitch's line width)
    let inkL = Infinity;
    let inkR = -Infinity;
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
        if (g.objects.length) {
          inkL = Math.min(inkL, dx);
          inkR = Math.max(inkR, dx + g.width);
        }
        const at: Mat = ([px, py]) => [(px + dx) * scale, (py + y) * scale];
        g.objects.forEach((o, oi) => {
          const ci = g.colors[oi] ?? 0;
          if (o.stitch.type === "fill") fills.set(o.stitch.method, (fills.get(o.stitch.method) ?? 0) + 1);
          const obj = mapGeometry(o, at, null);
          line.push({
            obj: { ...obj, stitch: letterFill(obj.stitch, spec, scale, crossScale) },
            unit: { letter: letterNo, word: wordNo, line: li },
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
    lines.push({ items: line, width: x * scale, ink: inkR > inkL ? (inkR - inkL) * scale : 0, y: y * scale });
  }
  if (isBlock(spec.align)) justify(lines, spec.align === "blockLetters", (it, dx) => (it.obj = mapGeometry(it.obj, ([px, py]) => [px + dx, py], null)));
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
 *  grid on the letter (as the font's own cross-stitch fills do). The font's
 *  crosses grow with the letters when `crossScale` (the lettering's choice,
 *  by default the font's: Ink/Stitch scale_cross_stitch_pattern). */
export function letterFill(st: StitchParams, spec: TextSpec, scale: number, crossScale = !!spec.crossScale): StitchParams {
  if (st.type !== "fill") return st;
  if (!spec.fill || spec.fill === "font") {
    if (st.method === "cross" && crossScale && Math.abs(scale - 1) > 1e-9)
      return { ...st, crossSize: (st.crossSize ?? 3) * scale, ...(st.crossSizeY ? { crossSizeY: st.crossSizeY * scale } : {}) };
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

// ---------------------------------------------------------------------------
// Bidirectional text for outline fonts. opentype.js shapes (Arabic forms,
// ligatures) but does not reorder: Hebrew comes out reversed, and lines that
// mix scripts keep their runs in typing order. A small subset of the Unicode
// bidi algorithm puts them in visual order: the line's direction from its
// first strong letter, numbers and Latin runs keep their own order inside
// right-to-left text, neutrals (spaces, punctuation) take the direction
// around them, and brackets are mirrored in right-to-left runs.

/** Hebrew, Arabic, Syriac, Thaana, NKo … and their presentation forms. */
const RTL_CHAR = /[\u0590-\u05ff\u0600-\u065f\u066a-\u06ef\u06fa-\u08ff\ufb1d-\ufdff\ufe70-\ufeff]/;
const DIGIT = /[0-9\u0660-\u0669\u06f0-\u06f9]/;
const MIRROR: Record<string, string> = { "(": ")", ")": "(", "[": "]", "]": "[", "{": "}", "}": "{", "<": ">", ">": "<", "«": "»", "»": "«", "‹": "›", "›": "‹" };

type BidiType = "L" | "R" | "EN" | "N";
function bidiType(cluster: string): BidiType {
  const c = String.fromCodePoint(cluster.codePointAt(0)!);
  if (RTL_CHAR.test(c)) return "R";
  if (DIGIT.test(c)) return "EN";
  return /\p{L}/u.test(c) ? "L" : "N";
}

/** Characters with their combining marks (one unit when reordering). */
function clustersOf(text: string): string[] {
  const out: string[] = [];
  for (const ch of text) {
    if (out.length && /[\p{M}\u200d]/u.test(ch)) out[out.length - 1] += ch;
    else out.push(ch);
  }
  return out;
}

/**
 * Embedding levels of a line's clusters (Unicode bidi, simplified: W7, N1–N2,
 * I1–I2, L1): even runs left to right, odd runs right to left. Lines whose
 * first strong letter is right-to-left are right-to-left paragraphs.
 */
export function bidiLevels(text: string): { clusters: string[]; levels: number[]; rtl: boolean } {
  const clusters = clustersOf(text);
  const types = clusters.map(bidiType);
  const rtl = types.find((t) => t === "L" || t === "R") === "R";
  const sos = rtl ? "R" : "L";
  // W7: numbers after left-to-right text (or at the start of a left-to-right line) are left to right
  let strong = sos;
  for (let i = 0; i < types.length; i++) {
    if (types[i] === "L" || types[i] === "R") strong = types[i];
    else if (types[i] === "EN" && strong === "L") types[i] = "L";
  }
  // N1, N2: neutrals between the same direction take it (numbers count as right to left), else the line's
  const dirOf = (t: BidiType) => (t === "L" ? "L" : "R");
  for (let i = 0; i < types.length; ) {
    if (types[i] !== "N") {
      i++;
      continue;
    }
    let j = i;
    while (j < types.length && types[j] === "N") j++;
    const before = i > 0 ? dirOf(types[i - 1]) : sos;
    const after = j < types.length ? dirOf(types[j]) : sos;
    const t = before === after ? before : sos;
    for (let k = i; k < j; k++) types[k] = t;
    i = j;
  }
  // I1, I2
  const levels = types.map((t) => (rtl ? (t === "R" ? 1 : 2) : t === "L" ? 0 : t === "R" ? 1 : 2));
  // L1: trailing white space at the line's own level
  for (let i = clusters.length - 1; i >= 0 && /^\s+$/u.test(clusters[i]); i--) levels[i] = rtl ? 1 : 0;
  return { clusters, levels, rtl };
}

/** L2: reverse every run at level ≥ k, from the highest level down to 1. */
export function reorderLevels<T>(items: T[], levels: number[]): T[] {
  const out = items.slice();
  const lv = levels.slice();
  const max = Math.max(0, ...lv);
  for (let k = max; k >= 1; k--) {
    for (let i = 0; i < out.length; ) {
      if (lv[i] < k) {
        i++;
        continue;
      }
      let j = i;
      while (j < out.length && lv[j] >= k) j++;
      const a = out.slice(i, j).reverse();
      const b = lv.slice(i, j).reverse();
      out.splice(i, j - i, ...a);
      lv.splice(i, j - i, ...b);
      i = j;
    }
  }
  return out;
}

/** Mirror brackets of right-to-left clusters (L4). */
const mirrored = (c: string, level: number) => (level % 2 && MIRROR[c[0]] ? MIRROR[c[0]] + c.slice(1) : c);

/** A line in visual order (left to right as drawn); characters keep their marks. */
export function visualOrder(text: string): string {
  const { clusters, levels } = bidiLevels(text);
  return reorderLevels(
    clusters.map((c, i) => mirrored(c, levels[i])),
    levels,
  ).join("");
}

/** Logical runs of one level (shaped separately: Arabic needs its typing order). */
function bidiRuns(text: string): { text: string; level: number }[] {
  const { clusters, levels } = bidiLevels(text);
  const runs: { text: string; level: number }[] = [];
  clusters.forEach((c, i) => {
    const last = runs[runs.length - 1];
    const m = mirrored(c, levels[i]);
    if (last && last.level === levels[i]) last.text += m;
    else runs.push({ text: m, level: levels[i] });
  });
  return runs;
}

// opentype.js reverses every Arabic "sentence" itself after shaping (its char classes)
const OT_ARABIC = /[\u0600-\u065f\u066a-\u06d2\u06fa-\u06ff\u0610-\u061b\u061e\u0670\u06d6-\u06dc\u06df-\u06e4\u06e7\u06e8\u06ea-\u06ed]/;

type RenderOpts = opentype.RenderOptions & { tracking?: number; script?: string; language?: string };
type Positioning = { getDefaultScriptName(): string; getKerningTables(script: string, language?: string): unknown; getKerningValue(tables: unknown, left: number, right: number): number };

function toGlyphs(f: opentype.Font, s: string, o: RenderOpts): opentype.Glyph[] {
  return (f.stringToGlyphs as (this: opentype.Font, s: string, o?: RenderOpts) => opentype.Glyph[]).call(f, s, o);
}

/** The glyphs of a run in typing order (ligatures and Arabic forms applied). */
function shapeRun(f: opentype.Font, text: string, o: RenderOpts): opentype.Glyph[] {
  const out: opentype.Glyph[] = [];
  let seg = "";
  let arabic = false;
  const flush = () => {
    if (!seg) return;
    const gs = toGlyphs(f, seg, o);
    // undo opentype.js's own reversal: the runs are ordered here
    out.push(...(arabic ? gs.reverse() : gs));
    seg = "";
  };
  for (const ch of text) {
    const a = OT_ARABIC.test(ch);
    if (a !== arabic) flush();
    arabic = a;
    seg += ch;
  }
  flush();
  return out;
}

/** A glyph line as drawn: glyphs left to right with their pen positions (opentype.js's forEachGlyph rules). */
export function placeGlyphs(f: opentype.Font, line: string, size: number, opts: RenderOpts): { glyphs: { glyph: opentype.Glyph; x: number }[]; width: number } {
  const o: RenderOpts = { ...(f as unknown as { defaultRenderOptions: RenderOpts }).defaultRenderOptions, ...opts };
  const scale = size / f.unitsPerEm;
  const pos = (f as unknown as { position?: Positioning }).position;
  const script = (s: string) => (/[\u0590-\u05ff\ufb1d-\ufb4f]/.test(s) ? "hebr" : /[\u0600-\u08ff\ufb50-\ufeff]/.test(s) ? "arab" : (o.script ?? pos?.getDefaultScriptName() ?? "latn"));
  type Item = { g: opentype.Glyph; level: number; run: number; i: number; kern: number };
  const items: Item[] = [];
  bidiRuns(line).forEach((r, ri) => {
    const gs = shapeRun(f, r.text, o);
    const tables = o.kerning && pos ? pos.getKerningTables(script(r.text), o.language) : undefined;
    const kern = (a: opentype.Glyph, b: opentype.Glyph) => (tables && pos ? pos.getKerningValue(tables, a.index, b.index) : f.getKerningValue(a, b));
    gs.forEach((g, i) => items.push({ g, level: r.level, run: ri, i, kern: o.kerning && i < gs.length - 1 ? kern(g, gs[i + 1]) : 0 }));
  });
  // marks (no advance) stay after their letter when a run turns round
  const clusters: Item[][] = [];
  for (const it of items) {
    const last = clusters[clusters.length - 1];
    if (last && !it.g.advanceWidth && last[0].run === it.run) last.push(it);
    else clusters.push([it]);
  }
  const visual = reorderLevels(
    clusters,
    clusters.map((c) => c[0].level),
  ).flatMap((c) => c);
  const glyphs: { glyph: opentype.Glyph; x: number }[] = [];
  let x = 0;
  visual.forEach((it, k) => {
    glyphs.push({ glyph: it.g, x });
    if (it.g.advanceWidth) x += it.g.advanceWidth * scale;
    const next = visual[k + 1];
    // kerning between neighbours in typing order (either way round on the line)
    if (next && next.run === it.run) {
      if (next.i === it.i + 1) x += it.kern * scale;
      else if (next.i === it.i - 1) x += next.kern * scale;
    }
    if (o.letterSpacing) x += o.letterSpacing * size;
    else if (o.tracking) x += (o.tracking / 1000) * size;
  });
  return { glyphs, width: x };
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
    // glyph by glyph, in visual order: spaces separate words (word spacing, Block alignment)
    const placed = placeGlyphs(f, line, size, opts);
    const items: { paths: SubPath[]; unit: Unit }[] = [];
    let words = 0;
    let inWord = false;
    let inkR = 0;
    for (const { glyph: g, x } of placed.glyphs) {
      const space = g.unicode === 32 || (g.unicodes ?? []).includes(32);
      if (space) {
        if (inWord) words++;
        inWord = false;
        continue;
      }
      // a character the font lacks (.notdef): not stitched — no box — but it keeps its place
      if (g.index === 0) continue;
      if (!inWord) wordNo++;
      inWord = true;
      letterNo++;
      const path = g.getPath(x, li * lineH, size, opts, f);
      const subs = shiftX(commandsToSubPaths(path.commands), words * ws);
      if (!subs.length) continue;
      const bb = path.getBoundingBox();
      inkR = Math.max(inkR, bb.x2 + words * ws);
      items.push({ paths: subs, unit: { letter: letterNo, word: wordNo, line: li } });
    }
    const gaps = Math.max(0, line.trim().split(/ +/).length - 1);
    out.push({ items, width: placed.width + gaps * ws, ink: inkR, y: li * lineH });
  });
  return out;
}

// ---------------------------------------------------------------------------
// Auto-satin, trims and colour sort (Ink/Stitch Font.render_text)

const SOURCE = Symbol("piece");
type Tagged = DesignObject & { [SOURCE]?: number };

/** A running line auto-satin may travel along: one open path, plain running stitch. */
function travelLine(o: DesignObject): boolean {
  const st = o.stitch;
  if (st.type !== "running" || o.paths.length !== 1 || o.paths[0].closed) return false;
  return !st.ripple && !st.stem && !st.motif && !st.zigzag && !st.cutworkNeedle && !st.beanRepeats && !st.beanPattern?.length && !st.lengthPattern?.length;
}

/**
 * Ink/Stitch's auto-satin over a lettering (fonts with auto_satin,
 * Font._apply_auto_satin): the satins and running lines of the whole text
 * routed in their order, without trims. The routed pieces stay with their
 * letter, where its last routed object was (Ink/Stitch puts them back into
 * the glyph's group); fills and other stitches stay as they are. Nothing
 * changes without a satin.
 */
export function routeLetters<T extends { obj: DesignObject; unit?: Unit }>(pieces: T[]): T[] {
  const routable = (p: T) => p.obj.stitch.type === "satin" || travelLine(p.obj);
  const idx = pieces.flatMap((p, i) => (routable(p) ? [i] : []));
  if (!idx.some((i) => pieces[i].obj.stitch.type === "satin")) return pieces;
  let routed: DesignObject[] | null = null;
  try {
    routed = autoSatin(
      idx.map((i): Tagged => ({ ...pieces[i].obj, [SOURCE]: i })),
      { preserveOrder: true, trim: false },
    );
  } catch {
    // degenerate geometry (e.g. a zero size): the letters as the font has them
  }
  if (!routed) return pieces;
  const byLetter = new Map<number | undefined, T[]>();
  for (const r of routed as Tagged[]) {
    const src = pieces[r[SOURCE] ?? idx[0]];
    const obj: Tagged = { ...r };
    delete obj[SOURCE];
    const k = src.unit?.letter;
    if (!byLetter.has(k)) byLetter.set(k, []);
    byLetter.get(k)!.push({ ...src, obj });
  }
  const lastRouted = new Map<number | undefined, number>();
  for (const i of idx) lastRouted.set(pieces[i].unit?.letter, i);
  const out: T[] = [];
  pieces.forEach((p, i) => {
    if (!routable(p)) out.push(p);
    if (lastRouted.get(p.unit?.letter) === i) out.push(...(byLetter.get(p.unit?.letter) ?? []));
  });
  return out;
}

/** An object's colour sort index (Ink/Stitch color_sort_index; none: 404, last). */
const sortIndex = (o: DesignObject) => o.colorSortIndex ?? 404;

/**
 * Ink/Stitch's lettering trims (Font._add_trims) on pieces in stitch order:
 * after every letter, or after the letter that ends a word or a line (not
 * the text's last word or line). The trim goes on the letter's last object;
 * when its colours are sorted, on its last object of every colour sort
 * index (each colour of the letter ends with a trim). The font's own trims
 * stay.
 */
export function letterTrims<T extends { obj: DesignObject; unit?: Unit }>(pieces: T[], trims: TextSpec["trims"], sorted: boolean) {
  const level = trims && trims !== "never" ? trims : null;
  if (!level) return;
  for (let i = 0; i < pieces.length; ) {
    const u = pieces[i].unit;
    let j = i + 1;
    while (j < pieces.length && u && pieces[j].unit?.letter === u.letter) j++;
    const next = pieces[j]?.unit;
    if (u && (level === "letter" || (!!next && next[level] !== u[level]))) {
      const letter = pieces.slice(i, j);
      if (sorted) {
        const last = new Map<number, T>();
        for (const p of letter) last.set(sortIndex(p.obj), p);
        for (const p of last.values()) p.obj = { ...p.obj, trimAfter: true };
      } else {
        const p = letter[letter.length - 1];
        p.obj = { ...p.obj, trimAfter: true };
      }
    }
    i = j;
  }
}

/**
 * Ink/Stitch's colour sort (Font.do_color_sort, sortable fonts): within the
 * whole text, each line or each word, the objects sewn by their colour sort
 * index (404 — none — last), otherwise in order. The objects of the font's
 * `combine` indices become one per index (their paths joined).
 */
export function colorSort(objs: DesignObject[], units: (Unit | undefined)[], scope: "all" | "line" | "word", combine: number[] = []): DesignObject[] {
  // scopes in stitch order (a turned back-and-forth line keeps its words together)
  let g = -1;
  let prev: number | undefined = NaN;
  const keys = objs.map((o, i) => {
    const k = scope === "all" ? 0 : units[i]?.[scope];
    if (k !== prev) {
      g++;
      prev = k;
    }
    return [g, sortIndex(o)];
  });
  const order = objs.map((_, i) => i).sort((a, b) => keys[a][0] - keys[b][0] || keys[a][1] - keys[b][1] || a - b);
  const joined = new Set(combine);
  const firstOf = new Map<string, DesignObject>();
  const out: DesignObject[] = [];
  for (const i of order) {
    const [sg, idx] = keys[i];
    if (!joined.has(idx)) {
      out.push(objs[i]);
      continue;
    }
    const k = `${sg}:${idx}`;
    const first = firstOf.get(k);
    if (first) {
      first.paths.push(...objs[i].paths);
      continue;
    }
    const copy = { ...objs[i], paths: [...objs[i].paths] };
    firstOf.set(k, copy);
    out.push(copy);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Text along a path (Ink/Stitch's Lettering along path)

/** A letter's left and right edge on its line (mm). */
export interface LetterBox {
  letter: number;
  word: number;
  l: number;
  r: number;
}

/** The letters of a line with their extent, left to right. */
function letterBoxes<T extends { unit?: Unit }>(items: T[], pathsOf: (t: T) => SubPath[]): LetterBox[] {
  const m = new Map<number, LetterBox>();
  for (const it of items) {
    if (!it.unit) continue;
    let b = m.get(it.unit.letter);
    for (const sp of pathsOf(it))
      for (const [x] of flatten(sp, 8)) {
        if (!b) m.set(it.unit.letter, (b = { letter: it.unit.letter, word: it.unit.word, l: x, r: x }));
        b.l = Math.min(b.l, x);
        b.r = Math.max(b.r, x);
      }
  }
  return [...m.values()].sort((a, b) => a.l - b.l);
}

/** A polyline offset by `d` to the right of its direction (below, for a line running left to right). */
export function offsetLine(pts: Vec2[], d: number): Vec2[] {
  if (!d || pts.length < 2) return pts;
  const normal = (a: Vec2, b: Vec2): Vec2 => {
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1e-9;
    return [-(b[1] - a[1]) / l, (b[0] - a[0]) / l];
  };
  return pts.map((p, i) => {
    const a = i > 0 ? normal(pts[i - 1], p) : normal(p, pts[i + 1]);
    const b = i < pts.length - 1 ? normal(p, pts[i + 1]) : a;
    const s = Math.hypot(a[0] + b[0], a[1] + b[1]);
    const m: Vec2 = s < 1e-9 ? a : [(a[0] + b[0]) / s, (a[1] + b[1]) / s];
    // mitred corners, limited
    const k = d / Math.max(0.25, m[0] * a[0] + m[1] * a[1]);
    return [p[0] + m[0] * k, p[1] + m[1] * k];
  });
}

/**
 * Where every letter goes on a path (Ink/Stitch TextAlongPath): placed
 * whole and turned along the path — the line from where it starts to where
 * it ends on the path — its left edge at its distance along the path, its
 * baseline on the path. Later lines follow the path offset by their
 * baseline. Start / centre / end place a line's letters (their bounding box,
 * Ink/Stitch's text width) on the path; stretch keeps the letters' size and
 * spreads them over the whole path, every gap between letters widened the
 * same and the gaps between words twice that.
 */
export function placeAlong(path: Vec2[], lines: { boxes: LetterBox[]; y: number }[], align: TextSpec["pathAlign"] = "center"): Map<number, { f: Mat; deg: number }> {
  const out = new Map<number, { f: Mat; deg: number }>();
  const clean = path.filter((p, i) => i === 0 || Math.hypot(p[0] - path[i - 1][0], p[1] - path[i - 1][1]) > 1e-9);
  if (clean.length < 2) return out;
  for (const line of lines) {
    const boxes = line.boxes;
    if (!boxes.length) continue;
    const along = pathMap(offsetLine(clean, line.y));
    const width = Math.max(...boxes.map((b) => b.r)) - Math.min(...boxes.map((b) => b.l));
    const words = new Set(boxes.map((b) => b.word)).size;
    const gaps = boxes.length - 1 + words - 1;
    const stretch = align === "stretch" && gaps > 0 ? (along.total - width) / gaps : 0;
    let dist = align === "center" ? (along.total - width) / 2 : align === "end" ? along.total - width : 0;
    let prev: LetterBox | null = null;
    for (const b of boxes) {
      if (prev) dist += b.l - prev.r + stretch + (b.word !== prev.word ? stretch : 0);
      const first = along.at(dist);
      const last = along.at(dist + (b.r - b.l)).p;
      const dx = last[0] - first.p[0];
      const dy = last[1] - first.p[1];
      const ang = Math.hypot(dx, dy) > 1e-9 ? Math.atan2(dy, dx) : Math.atan2(first.t[1], first.t[0]);
      const c = Math.cos(ang);
      const s = Math.sin(ang);
      const [px, py] = first.p;
      const ox = b.l;
      const oy = line.y;
      out.set(b.letter, {
        f: ([x, y]) => {
          const u = x - ox;
          const v = y - oy;
          return [px + u * c - v * s, py + u * s + v * c];
        },
        deg: (ang * 180) / Math.PI,
      });
      dist += b.r - b.l;
      prev = b;
    }
  }
  return out;
}

/** The sizes an embroidery font is made for (mm; its size × min / max scale), or null. */
export function fontSizeRange(font: LoadedFont | null | undefined): [number, number] | null {
  if (!font || font.kind !== "embroidery" || !(font.size > 0)) return null;
  const a = font.size * (font.minScale || 1);
  const b = font.size * (font.maxScale || 1);
  return [Math.min(a, b), Math.max(a, b)];
}

/** A size kept in an embroidery font's range (Ink/Stitch's scale range), to 0.1 mm. */
export function clampToFont(size: number, font: LoadedFont | null | undefined): number {
  const r = fontSizeRange(font);
  const v = r ? Math.min(r[1], Math.max(r[0], size)) : size;
  return Math.round(v * 10) / 10;
}

/**
 * The size after switching a lettering from font `from` to font `to`: like
 * Ink/Stitch, the scale (size over the font's own size) stays, within the
 * new font's scale range; from an outline font the size in mm stays (kept
 * in the range).
 */
export function sizeForFont(size: number, from: LoadedFont | null | undefined, to: LoadedFont): number {
  const scaled = from?.kind === "embroidery" && from.size > 0 && to.kind === "embroidery" ? (size / from.size) * to.size : size;
  return clampToFont(scaled, to);
}

/** Lay out a lettering with its (loaded) font. */
export async function layoutText(spec: TextSpec, font: LoadedFont): Promise<DesignObject[]> {
  let lines: Line<Piece>[];
  let fontFill: FillParams["method"] | undefined;
  const label = spec.content.split("\n")[0].slice(0, 18) || "Text";
  const emb = font.kind === "embroidery" ? font : null;
  const pathPts = spec.path && spec.path.length >= 2 ? (spec.pathFlip ? [...spec.path].reverse() : spec.path) : null;
  // on a path: every letter placed whole
  let placed: Map<number, { f: Mat; deg: number }> | null = null;
  if (font.kind === "embroidery") {
    const l = await layoutEmbroidery(spec, font);
    lines = l.lines;
    fontFill = l.fontFill;
    // the font's auto-satin, over the whole text (Ink/Stitch: before trims and colour sort)
    if (font.autoSatin) {
      const routed = routeLetters(lines.flatMap((ln) => ln.items));
      lines.forEach((ln, li) => (ln.items = routed.filter((p) => p.unit?.line === li)));
    }
    if (pathPts) placed = placeAlong(pathPts, lines.map((ln) => ({ boxes: letterBoxes(ln.items, (p) => [...p.obj.paths, ...markerPaths(p.obj)]), y: ln.y })), spec.pathAlign);
  } else {
    const glyphLines = layoutOutline(spec, font);
    if (isBlock(spec.align)) justify(glyphLines, spec.align === "blockLetters", (it, dx) => (it.paths = shiftX(it.paths, dx)));
    if (pathPts) {
      // the letters are merged per line below: placed on the path first
      const at = placeAlong(pathPts, glyphLines.map((gl) => ({ boxes: letterBoxes(gl.items, (it) => it.paths), y: gl.y })), spec.pathAlign);
      for (const gl of glyphLines)
        for (const it of gl.items) {
          const t = at.get(it.unit.letter);
          if (t) it.paths = mapNodes(it.paths, t.f);
        }
      placed = new Map();
    }
    const obj = (paths: SubPath[], stitch: StitchParams, thread: string): DesignObject => ({ id: "", name: "", thread, visible: true, locked: false, paths, stitch, trimAfter: false, stopAfter: false });
    lines = glyphLines.map((gl) => {
      const ps: Piece[] = [];
      const paths = gl.items.flatMap((it) => it.paths);
      if (paths.length) {
        if (spec.style === "fill" || spec.style === "fillBorder")
          ps.push({ obj: obj(paths, { type: "fill", ...defaultFill(), angle: spec.fillAngle, underlayInset: 0.2 }, spec.thread), role: "fill", name: "fill", thread: spec.thread });
        if (spec.style === "border" || spec.style === "fillBorder") {
          const t = spec.style === "fillBorder" ? spec.borderThread : spec.thread;
          ps.push({ obj: obj(paths, { type: "satin", ...defaultSatin(), width: spec.borderWidth, multi: true, centerWalk: true, shortStitchInset: 0.25 }, t), role: "border", name: "border", thread: t });
        }
        if (spec.style === "outline") ps.push({ obj: obj(paths, { type: "running", ...defaultRunning(), length: 1.6, beanRepeats: 2 }, spec.thread), role: "outline", name: "outline", thread: spec.thread });
      }
      return { items: ps, width: gl.width, ink: gl.ink, y: gl.y };
    });
  }
  // Ink/Stitch's colour sort: sortable fonts only, by the objects' colour sort index
  const sorting = !!emb?.sortable && !!spec.colorSort && spec.colorSort !== "off";
  // trims: after every letter / word / line (Ink/Stitch _add_trims); the font's own stay
  if (emb) letterTrims(lines.flatMap((l) => l.items), spec.trims, sorting);
  // alignment: embroidery fonts by the letters' bounding box (Ink/Stitch's
  // line width), outline fonts by the advance; x = 0 is the alignment point
  // of every line (Block: like left)
  const widths = lines.map((l) => (emb ? l.ink : l.width));
  const blockW = Math.max(0, ...widths);
  const shiftFor = (w: number) => (spec.align === "center" ? -w / 2 : spec.align === "right" ? -w : 0);
  // arc: bend around the centre of the widest line
  const arcShift = spec.align === "center" ? 0 : spec.align === "right" ? blockW / 2 : -blockW / 2;
  // how far the letters reach towards the arc's centre: above the baseline for a dip, below it for an arch
  let reach = 0;
  if (Math.abs(spec.arc) >= 0.5 && !pathPts)
    for (const l of lines)
      for (const it of l.items)
        for (const sp of it.obj.paths) for (const n of sp.nodes) reach = Math.max(reach, spec.arc > 0 ? n.p[1] : -n.p[1]);
  const bend = pathPts ? null : arcMap(spec.arc, blockW, reach);
  const rad = (spec.rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const [ax, ay] = spec.anchor;
  const out: DesignObject[] = [];
  const units: (Unit | undefined)[] = [];
  const objectOf = (piece: Piece, f: Mat, turn?: number | null): DesignObject => {
    const o: DesignObject = {
      ...mapGeometry(piece.obj, f, turn),
      id: uid(),
      name: emb ? `${label} · ${piece.name}` : `${label} (${piece.name})`,
      thread: piece.thread,
      visible: true,
      locked: false,
      trimAfter: !!piece.obj.trimAfter,
      stopAfter: !!piece.obj.stopAfter,
      text: { ...spec, role: piece.role, ...(piece.colorIndex !== undefined ? { colorIndex: piece.colorIndex } : {}), ...(fontFill ? { fontFill } : {}) },
    };
    delete o.group;
    delete o.clone;
    return o;
  };
  const identity: Mat = (p) => p;
  lines.forEach((line, li) => {
    const sx = shiftFor(widths[li]);
    const f: Mat = ([x, y]) => {
      let p: Vec2 = [x + sx, y];
      if (bend) {
        const q = bend([p[0] + arcShift, p[1]]);
        p = [q[0] - arcShift, q[1]];
      }
      return [ax + p[0] * cos - p[1] * sin, ay + p[0] * sin + p[1] * cos];
    };
    for (const piece of line.items) {
      units.push(piece.unit);
      if (placed) {
        // on a path: an embroidery letter turns as a whole, its fills with it;
        // outline letters are placed already
        const t = emb && piece.unit ? placed.get(piece.unit.letter) : undefined;
        out.push(objectOf(piece, t?.f ?? identity, t ? t.deg : null));
      } else out.push(objectOf(piece, f, emb ? undefined : spec.rotation));
    }
  });
  if (emb && sorting) return colorSort(out, units, spec.colorSort as "all" | "line" | "word", emb.combineAtSortIndices);
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
