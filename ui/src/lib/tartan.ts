// Tartan fills (Ink/Stitch tartan fill and its palette code): the stripes
// of a sett, its colours, and the layer objects that sew them — one object
// per colour, kept in step like the layers of a gradient. The engine sews
// each layer (crates/core/src/stitches/tartan.rs).

import type { DesignObject, StitchDocument, TartanParams } from "../types";
import { defaultFill, uid } from "./geometry";
import { parentOf, withParent } from "./groups";
import { pruneGroups } from "./layerRows";

export interface TartanStripe {
  color: string;
  /** Width in mm. */
  width: number;
  /** 1 sewn, 0 left out, 2 in the previous colour. */
  render: 0 | 1 | 2;
}

export const DEFAULT_TARTAN: Omit<TartanParams, "layer" | "group"> = {
  // a Royal Stewart-like sett, symmetric
  palette: "(#b71c1c)/6 (#0d1b2a)1.5 (#b71c1c)1 (#0d1b2a)0.5 (#f5f5f5)0.6 (#0d1b2a)0.5 (#ffd600)/0.6",
  rotate: 0,
  offset: [0, 0],
  symmetry: true,
  scale: 100,
  minStripeWidth: 1,
  angle: -45,
  rowsPerThread: 2,
  herringbone: 0,
};

// The named colours the engine knows (svgtypes, CSS 3), as rrggbb.
const NAMED: Record<string, string> = Object.fromEntries(
  (
    "aliceblue:f0f8ff antiquewhite:faebd7 aqua:00ffff aquamarine:7fffd4 azure:f0ffff beige:f5f5dc bisque:ffe4c4 black:000000 blanchedalmond:ffebcd " +
    "blue:0000ff blueviolet:8a2be2 brown:a52a2a burlywood:deb887 cadetblue:5f9ea0 chartreuse:7fff00 chocolate:d2691e coral:ff7f50 cornflowerblue:6495ed " +
    "cornsilk:fff8dc crimson:dc143c cyan:00ffff darkblue:00008b darkcyan:008b8b darkgoldenrod:b8860b darkgray:a9a9a9 darkgreen:006400 darkgrey:a9a9a9 " +
    "darkkhaki:bdb76b darkmagenta:8b008b darkolivegreen:556b2f darkorange:ff8c00 darkorchid:9932cc darkred:8b0000 darksalmon:e9967a darkseagreen:8fbc8f " +
    "darkslateblue:483d8b darkslategray:2f4f4f darkslategrey:2f4f4f darkturquoise:00ced1 darkviolet:9400d3 deeppink:ff1493 deepskyblue:00bfff dimgray:696969 " +
    "dimgrey:696969 dodgerblue:1e90ff firebrick:b22222 floralwhite:fffaf0 forestgreen:228b22 fuchsia:ff00ff gainsboro:dcdcdc ghostwhite:f8f8ff gold:ffd700 " +
    "goldenrod:daa520 gray:808080 green:008000 greenyellow:adff2f grey:808080 honeydew:f0fff0 hotpink:ff69b4 indianred:cd5c5c indigo:4b0082 ivory:fffff0 " +
    "khaki:f0e68c lavender:e6e6fa lavenderblush:fff0f5 lawngreen:7cfc00 lemonchiffon:fffacd lightblue:add8e6 lightcoral:f08080 lightcyan:e0ffff " +
    "lightgoldenrodyellow:fafad2 lightgray:d3d3d3 lightgreen:90ee90 lightgrey:d3d3d3 lightpink:ffb6c1 lightsalmon:ffa07a lightseagreen:20b2aa " +
    "lightskyblue:87cefa lightslategray:778899 lightslategrey:778899 lightsteelblue:b0c4de lightyellow:ffffe0 lime:00ff00 limegreen:32cd32 linen:faf0e6 " +
    "magenta:ff00ff maroon:800000 mediumaquamarine:66cdaa mediumblue:0000cd mediumorchid:ba55d3 mediumpurple:9370db mediumseagreen:3cb371 " +
    "mediumslateblue:7b68ee mediumspringgreen:00fa9a mediumturquoise:48d1cc mediumvioletred:c71585 midnightblue:191970 mintcream:f5fffa mistyrose:ffe4e1 " +
    "moccasin:ffe4b5 navajowhite:ffdead navy:000080 oldlace:fdf5e6 olive:808000 olivedrab:6b8e23 orange:ffa500 orangered:ff4500 orchid:da70d6 " +
    "palegoldenrod:eee8aa palegreen:98fb98 paleturquoise:afeeee palevioletred:db7093 papayawhip:ffefd5 peachpuff:ffdab9 peru:cd853f pink:ffc0cb plum:dda0dd " +
    "powderblue:b0e0e6 purple:800080 red:ff0000 rosybrown:bc8f8f royalblue:4169e1 saddlebrown:8b4513 salmon:fa8072 sandybrown:f4a460 seagreen:2e8b57 " +
    "seashell:fff5ee sienna:a0522d silver:c0c0c0 skyblue:87ceeb slateblue:6a5acd slategray:708090 slategrey:708090 snow:fffafa springgreen:00ff7f " +
    "steelblue:4682b4 tan:d2b48c teal:008080 thistle:d8bfd8 tomato:ff6347 transparent:000000 turquoise:40e0d0 violet:ee82ee wheat:f5deb3 white:ffffff " +
    "whitesmoke:f5f5f5 yellow:ffff00 yellowgreen:9acd32"
  )
    .split(" ")
    .map((x) => x.split(":") as [string, string]),
);

/**
 * `#rrggbb` of a palette colour, or null when the engine can't read it
 * (crates/core/src/stitches/tartan.rs `parse_color`: svgtypes — #rgb,
 * #rgba, #rrggbb, #rrggbbaa or a CSS colour name; rgb() / hsl() can't be
 * written in a palette, whose colours end at the first ")").
 */
export function paletteColor(c: string): string | null {
  const s = c.trim();
  if (s.startsWith("#")) {
    const h = s.slice(1);
    if (!/^[0-9a-f]*$/i.test(h)) return null;
    const x = h.toLowerCase();
    if (x.length === 3 || x.length === 4) return `#${x[0]}${x[0]}${x[1]}${x[1]}${x[2]}${x[2]}`;
    if (x.length === 6 || x.length === 8) return `#${x.slice(0, 6)}`;
    return null;
  }
  if (!/^[A-Za-z0-9_-]+$/.test(s)) return null;
  const hex = NAMED[s.toLowerCase()];
  return hex ? `#${hex}` : null;
}

/**
 * The stripes of one side of a palette code, read exactly like the engine
 * (tartan.rs `parse_palette`): "(colour)" then "/", " ", "?" and "*" marks
 * and the width; a stripe without a readable width is skipped, and one whose
 * colour can't be read is left out (black, not sewn).
 */
function parseStripes(part: string): TartanStripe[] {
  const out: TartanStripe[] = [];
  let rest = part;
  for (;;) {
    const open = rest.indexOf("(");
    if (open < 0) break;
    const close = rest.indexOf(")", open);
    if (close < 0) break;
    const raw = rest.slice(open + 1, close).trim();
    const after = rest.slice(close + 1);
    let render: 0 | 1 | 2 = 1;
    let width = "";
    let i = 0;
    for (; i < after.length; i++) {
      const ch = after[i];
      if ((ch === "/" || ch === " ") && !width) continue;
      if (ch === "?" && !width) render = 0;
      else if (ch === "*" && !width) render = 2;
      else if ((ch >= "0" && ch <= "9") || ch === ".") width += ch;
      else break;
    }
    // what Rust's f64 parsing takes of digits and dots
    if (/^(\d+\.?\d*|\.\d+)$/.test(width)) {
      const color = paletteColor(raw);
      out.push({ color: color ?? "#000000", width: Number(width), render: color ? render : 0 });
    }
    rest = after.slice(i);
  }
  return out;
}

/** Parse Ink/Stitch's palette code: warp and weft stripes, and whether the sett is symmetric. */
export function parsePalette(code: string): { warp: TartanStripe[]; weft: TartanStripe[]; symmetric: boolean; equal: boolean } {
  const [a, b] = code.split("|");
  const warp = parseStripes(a ?? "");
  return { warp, weft: b != null ? parseStripes(b) : warp, symmetric: code.includes("/"), equal: b == null };
}

/**
 * Is the sett mirrored? The engine mirrors when the code has "/" pivots or
 * `symmetry` is set (tartans saved before the Mirrored switch wrote both
 * may have only the flag).
 */
export const tartanMirrored = (t: Pick<TartanParams, "palette" | "symmetry">) => t.palette.includes("/") || t.symmetry;

/**
 * `t` changed by `patch`. A new palette code sets `symmetry` too: the code's
 * "/" pivots say whether the sett is mirrored (as in Ink/Stitch), and the
 * engine reads both.
 */
export function patchTartan<T extends Pick<TartanParams, "palette" | "symmetry">>(t: T, patch: Partial<T>): T {
  const next = { ...t, ...patch };
  return patch.palette !== undefined && patch.symmetry === undefined ? { ...next, symmetry: next.palette.includes("/") } : next;
}

/** Why a palette code can't be a tartan (nothing to sew), or null. */
export function paletteProblem(code: string): string | null {
  const { warp, weft } = parsePalette(code);
  if (!warp.length && !weft.length) return "No stripes in the code: write each as (colour)width, e.g. (#b71c1c)4";
  if (!tartanColors(code).length) return "A tartan needs at least one sewn stripe";
  return null;
}

/** The palette code of stripes (Ink/Stitch's format). */
export function paletteCode(warp: TartanStripe[], symmetric: boolean, weft?: TartanStripe[]): string {
  const one = (s: TartanStripe[]) =>
    s
      .map((x, i) => {
        const pivot = symmetric && (i === 0 || i === s.length - 1) ? "/" : "";
        const mark = x.render === 0 ? "?" : x.render === 2 ? "*" : "";
        return `(${x.color})${pivot}${mark}${+x.width.toFixed(2)}`;
      })
      .join(" ");
  return weft ? `${one(warp)}|${one(weft)}` : one(warp);
}

/** The colours a tartan sews (one layer each), in palette order. */
export function tartanColors(code: string): string[] {
  const { warp, weft } = parsePalette(code);
  const out: string[] = [];
  for (const s of [...warp, ...weft]) if (s.render === 1 && !out.includes(s.color)) out.push(s.color);
  return out;
}

/** The full sett as CSS stops for a swatch (warp across, weft down). */
export function settStops(stripes: TartanStripe[], symmetric: boolean): { color: string | null; width: number }[] {
  const seq = stripes.map((s) => ({ color: s.render === 0 ? null : s.color, width: s.width }));
  return symmetric && seq.length > 2 ? [...seq, ...seq.slice(1, -1).reverse()] : seq;
}

/** A small CSS background of the tartan (two crossing layers of stripes). */
export function swatchCss(code: string, px = 3, mirrored?: boolean): string {
  const p = parsePalette(code);
  const { warp, weft } = p;
  const symmetric = mirrored ?? p.symmetric;
  const grad = (dir: string, stops: { color: string | null; width: number }[]) => {
    let at = 0;
    const parts = stops.map((s) => {
      const a = at;
      at += s.width * px;
      return `${s.color ?? "transparent"} ${a}px ${at}px`;
    });
    return { css: `repeating-linear-gradient(${dir}, ${parts.join(", ")})`, size: at };
  };
  const w = grad("90deg", settStops(warp, symmetric));
  const f = grad("180deg", settStops(weft, symmetric));
  // the weft half transparent over the warp: the woven mix
  return `${f.css.replace(/(#[0-9a-f]{6})/g, "$180")}, ${w.css}`;
}

/** The layer objects of a tartan, by layer. */
export function tartanLayers(doc: StitchDocument, group: string): DesignObject[] {
  // linked clones of a layer follow their original: not layers of this tartan
  return doc.objects
    .filter((o) => !o.clone && o.stitch.type === "fill" && o.stitch.tartan?.group === group)
    .sort((a, b) => ((a.stitch as { tartan?: TartanParams }).tartan!.layer ?? 0) - ((b.stitch as { tartan?: TartanParams }).tartan!.layer ?? 0));
}

/**
 * The document with the tartan `group` set to `params`: one layer object per
 * colour (made from the first layer, removed when a colour goes), each in a
 * thread of its colour. A palette with nothing to sew changes nothing (see
 * `paletteProblem`): the tartan would lose every layer.
 */
export function syncTartan(doc: StitchDocument, group: string, params: Omit<TartanParams, "layer" | "group">): StitchDocument {
  const layers = tartanLayers(doc, group);
  const base = layers[0];
  if (!base || base.stitch.type !== "fill") return doc;
  const colors = tartanColors(params.palette);
  if (!colors.length) return doc;
  const threads = [...doc.threads];
  const threadFor = (color: string) => {
    let t = threads.find((x) => x.color.toLowerCase() === color.toLowerCase());
    if (!t) {
      t = { id: uid("t"), name: color, color, brand: "", code: "" };
      threads.push(t);
    }
    return t.id;
  };
  const made: DesignObject[] = colors.map((color, layer) => {
    const was = layers[layer] ?? base;
    return {
      ...was,
      id: layers[layer]?.id ?? uid(),
      name: `${base.name.replace(/ · colour \d+$/, "")}${colors.length > 1 ? ` · colour ${layer + 1}` : ""}`,
      paths: base.paths,
      thread: threadFor(color),
      group: base.group ?? group,
      start: layer === 0 ? base.start : undefined,
      end: undefined,
      stitch: { ...(base.stitch as Extract<DesignObject["stitch"], { type: "fill" }>), tartan: { ...params, layer, group } },
    };
  });
  // the layers stay where the first one is in the sewing order
  const ids = new Set(layers.map((o) => o.id));
  const at = doc.objects.findIndex((o) => ids.has(o.id));
  const rest = doc.objects.filter((o) => !ids.has(o.id));
  rest.splice(Math.min(at, rest.length), 0, ...made);
  return { ...doc, objects: rest, threads };
}

/** Make `o` a tartan (its layers added). */
export function makeTartan(doc: StitchDocument, objId: string, params: Omit<TartanParams, "layer" | "group"> = DEFAULT_TARTAN): StitchDocument {
  const o = doc.objects.find((x) => x.id === objId);
  if (!o) return doc;
  const group = uid("tartan");
  const fill = o.stitch.type === "fill" ? o.stitch : { type: "fill" as const, ...defaultFill() };
  // the layers are kept together by the tartan's own group, inside the object's group
  const first: DesignObject = {
    ...o,
    group,
    stitch: { ...fill, method: "tartan", gradient: undefined, ramp: undefined, tartan: { ...params, layer: 0, group } },
  };
  const placed = { ...doc, objects: doc.objects.map((x) => (x.id === objId ? first : x)), groupParents: withParent(doc.groupParents, group, o.group) };
  return pruneGroups(syncTartan(placed, group, params));
}

/** The tartan back to a plain fill in its first colour. */
export function removeTartan(doc: StitchDocument, group: string): StitchDocument {
  const layers = tartanLayers(doc, group);
  if (!layers.length) return doc;
  const ids = new Set(layers.slice(1).map((o) => o.id));
  // the plain fill leaves the tartan's group for the group around it
  const around = parentOf(doc, group);
  return pruneGroups({
    ...doc,
    objects: doc.objects
      .filter((o) => !ids.has(o.id))
      .map((o) =>
        o.id === layers[0].id && o.stitch.type === "fill"
          ? { ...o, group: o.group === group ? around : o.group, name: o.name.replace(/ · colour \d+$/, ""), stitch: { ...o.stitch, method: "tatami", tartan: undefined } }
          : o,
      ),
  });
}
