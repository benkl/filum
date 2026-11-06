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

const HEX = /^#?[0-9a-f]{6}$/i;
const norm = (c: string) => {
  const s = c.trim().toLowerCase();
  if (HEX.test(s)) return s.startsWith("#") ? s : `#${s}`;
  if (typeof document !== "undefined") {
    const ctx = document.createElement("canvas").getContext("2d");
    if (ctx) {
      ctx.fillStyle = "#000000";
      ctx.fillStyle = s;
      return ctx.fillStyle;
    }
  }
  return s;
};

/** Parse Ink/Stitch's palette code: warp and weft stripes, and whether the sett is symmetric. */
export function parsePalette(code: string): { warp: TartanStripe[]; weft: TartanStripe[]; symmetric: boolean; equal: boolean } {
  const parse = (part: string): TartanStripe[] =>
    [...part.matchAll(/\(([^)]+)\)\s*\/?\s*([?*])?\s*([0-9.]+)/g)].map((m) => ({
      color: norm(m[1]),
      width: Number(m[3]) || 0,
      render: m[2] === "?" ? 0 : m[2] === "*" ? 2 : 1,
    }));
  const [a, b] = code.split("|");
  const warp = parse(a ?? "");
  return { warp, weft: b != null ? parse(b) : warp, symmetric: code.includes("/"), equal: b == null };
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
export function swatchCss(code: string, px = 3): string {
  const { warp, weft, symmetric } = parsePalette(code);
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
 * thread of its colour.
 */
export function syncTartan(doc: StitchDocument, group: string, params: Omit<TartanParams, "layer" | "group">): StitchDocument {
  const layers = tartanLayers(doc, group);
  const base = layers[0];
  if (!base || base.stitch.type !== "fill") return doc;
  const colors = tartanColors(params.palette);
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
