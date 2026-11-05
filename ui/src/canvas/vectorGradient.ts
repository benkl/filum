// Gradients in the vector view. A multi-colour gradient is a group of fill
// layers with one shape, and a colour blend two fills with opposite density
// ramps; drawn one by one, the top layer would hide the others and the shape
// would show a single colour. Instead the group is painted once, as a picture
// of its colour mix (the same weights the stitches follow), clipped to the shape.

import { weightsAt } from "../lib/gradient";
import { objectBoundsCached, type Box } from "../lib/geometry";
import type { DesignObject, Vec2 } from "../types";

type Rgb = [number, number, number];

const rgb = (hex: string): Rgb => {
  const h = hex.replace("#", "");
  const v = parseInt(h.length === 3 ? h.replace(/./g, "$&$&") : h.slice(0, 6), 16) || 0;
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
};

/** Cells across the longer side of the picture: smooth enough once scaled up, cheap to redo. */
const RES = 96;
const cache = new Map<string, HTMLCanvasElement>();

function picture(key: string, box: Box, mix: (p: Vec2) => Rgb): HTMLCanvasElement | null {
  const hit = cache.get(key);
  if (hit) return hit;
  if (typeof document === "undefined" || box.w <= 0 || box.h <= 0) return null;
  const s = RES / Math.max(box.w, box.h);
  const w = Math.max(2, Math.round(box.w * s));
  const h = Math.max(2, Math.round(box.h * s));
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d");
  if (!g) return null;
  const img = g.createImageData(w, h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const [r, gg, b] = mix([box.x + ((x + 0.5) / w) * box.w, box.y + ((y + 0.5) / h) * box.h]);
      const i = 4 * (y * w + x);
      img.data[i] = r;
      img.data[i + 1] = gg;
      img.data[i + 2] = b;
      img.data[i + 3] = 255;
    }
  g.putImageData(img, 0, 0);
  if (cache.size > 64) cache.clear();
  cache.set(key, c);
  return c;
}

const mixOf = (colors: Rgb[], w: number[]): Rgb => {
  const out: Rgb = [0, 0, 0];
  w.forEach((k, i) => {
    const c = colors[i] ?? colors[colors.length - 1];
    out[0] += k * c[0];
    out[1] += k * c[1];
    out[2] += k * c[2];
  });
  return out;
};

/** The group an object paints with (a gradient or a colour blend), if any. */
export const colourGroup = (o: DesignObject): string | null =>
  o.stitch.type === "fill" ? (o.stitch.gradient ? `g:${o.stitch.gradient.group}` : o.stitch.ramp?.group ? `b:${o.stitch.ramp.group}` : null) : null;

/**
 * The colour mix of a group as a picture over its shape's box, or null when it
 * can't be drawn (the caller falls back to plain colours).
 */
export function groupPicture(layers: DesignObject[], color: (o: DesignObject) => string): { image: HTMLCanvasElement; box: Box } | null {
  const first = layers[0];
  const box = first && objectBoundsCached(first);
  if (!first || !box || first.stitch.type !== "fill") return null;
  const st = first.stitch;
  const key = JSON.stringify([box, layers.map((o) => [color(o), o.stitch.type === "fill" ? (o.stitch.gradient ?? o.stitch.ramp) : null])]);
  if (st.gradient) {
    const g = st.gradient;
    // colours in stop order: the layer that sews stop i
    const colors: Rgb[] = g.stops.map((_, i) => rgb(color(layers.find((o) => o.stitch.type === "fill" && o.stitch.gradient?.layer === i) ?? first)));
    const image = picture(key, box, (p) => mixOf(colors, weightsAt(g, p)));
    return image ? { image, box } : null;
  }
  if (st.ramp) {
    // a colour blend: each layer is densest where the other is open
    const r = st.ramp;
    const a = layers.find((o) => o.stitch.type === "fill" && !o.stitch.ramp?.reverse) ?? first;
    const b = layers.find((o) => o.stitch.type === "fill" && !!o.stitch.ramp?.reverse) ?? first;
    const ca = rgb(color(a));
    const cb = rgb(color(b));
    const dx = r.to[0] - r.from[0];
    const dy = r.to[1] - r.from[1];
    const len2 = dx * dx + dy * dy || 1;
    const image = picture(key, box, (p) => {
      const t = Math.min(1, Math.max(0, ((p[0] - r.from[0]) * dx + (p[1] - r.from[1]) * dy) / len2));
      return mixOf([ca, cb], [1 - t, t]);
    });
    return image ? { image, box } : null;
  }
  return null;
}
