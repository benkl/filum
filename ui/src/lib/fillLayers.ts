// Fills sewn as several layer objects of one shape: the colour layers of a
// gradient or a tartan and the two layers of a colour blend. Pure helpers
// that keep such a set whole when commands reshape, combine or delete its
// objects (no store here, so they can be tested in Node).

import type { DensityRamp, DesignObject, FillParams, GradientParams, GradientStop, StitchDocument, StitchParams } from "../types";
import { parentOf } from "./groups";
import { pruneGroups } from "./layerRows";
import { tartanLayers } from "./tartan";

type GradientFill = FillParams & { gradient: GradientParams };

export const rampOf = (o: DesignObject | undefined): DensityRamp | undefined => (o?.stitch.type === "fill" ? o.stitch.ramp : undefined);

/** The objects of a ramp: one, or both layers of a colour blend. */
export function rampMembers(doc: StitchDocument, id: string): DesignObject[] {
  const o = doc.objects.find((x) => x.id === id);
  const r = rampOf(o);
  if (!o || !r) return [];
  if (!r.group) return [o];
  return doc.objects.filter((x) => rampOf(x)?.group === r.group);
}

/** Layers of a gradient group, in stop order. */
export function gradientLayers(doc: StitchDocument, group: string): DesignObject[] {
  // linked clones of a layer follow their original: not layers of this gradient
  return doc.objects
    .filter((o) => !o.clone && o.stitch.type === "fill" && o.stitch.gradient?.group === group)
    .sort((a, b) => (a.stitch as GradientFill).gradient.layer - (b.stitch as GradientFill).gradient.layer);
}

/** The set of layers an object belongs to (a gradient, a tartan or a colour blend), if any. A linked clone of a layer is a shape of its own. */
export function layerSetOf(o: DesignObject): string | undefined {
  if (o.clone || o.stitch.type !== "fill") return undefined;
  const st = o.stitch;
  if (st.gradient) return `gradient:${st.gradient.group}`;
  if (st.tartan) return `tartan:${st.tartan.group}`;
  if (st.ramp?.group) return `blend:${st.ramp.group}`;
  return undefined;
}

/**
 * Why commands that rewrite or split the shapes of these objects must not
 * touch them: linked clones (their paths follow the original) and the layers
 * of gradients, tartans and colour blends (one shape for all their colours).
 */
export function layeredRefusal(objs: DesignObject[]): string | null {
  if (objs.some((o) => o.clone)) return "Linked clones follow their original: unlink them first";
  if (objs.some((o) => layerSetOf(o))) return "Gradients, tartans and colour blends keep one shape for all their colours: remove the gradient, tartan or blend first";
  return null;
}

/**
 * Why `o` can't be made into a gradient: a linked clone (its own gradient
 * would be undone by its original), a gradient already, or one layer of a
 * tartan / colour blend that has more (they would be left behind).
 */
export function gradientRefusal(doc: StitchDocument, o: DesignObject): string | null {
  if (o.clone) return "Linked clones follow their original: unlink the clone first";
  if (o.stitch.type !== "fill") return null;
  if (o.stitch.gradient) return "This is a gradient already: drag across it with the gradient tool to change it";
  if (o.stitch.tartan && tartanLayers(doc, o.stitch.tartan.group).length > 1) return "Tartans sew a layer per colour: switch the tartan to another fill first";
  if (o.stitch.ramp?.group && rampMembers(doc, o.id).length > 1) return "Colour blends have two layers: remove the blend first";
  return null;
}

/** The objects with each gradient / tartan / blend reduced to its first layer (its layers share one shape). */
export function oneLayerEach(objs: DesignObject[]): DesignObject[] {
  const seen = new Set<string>();
  return objs.filter((o) => {
    const k = layerSetOf(o);
    if (!k) return true;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** The stitch of a layer as a plain fill of its own: no gradient, tartan or blend. A lone density ramp stays. */
export function plainLayerStitch(st: StitchParams): StitchParams {
  if (st.type !== "fill") return st;
  const { gradient: _g, tartan: _t, ...rest } = st;
  void _g;
  void _t;
  const out: FillParams = { ...rest };
  if (st.tartan || out.method === "tartan") out.method = "tatami";
  if (st.ramp?.group) {
    out.ramp = undefined;
    out.underlay = true;
  }
  return { ...out, type: "fill" };
}

/** The group a plain object made from `o` sits in: a layer's own gradient / tartan group is left for the group around it. */
export function plainGroupOf(doc: StitchDocument, o: DesignObject): string | undefined {
  if (!o.group) return undefined;
  const st = o.stitch;
  const own = st.type === "fill" && (st.gradient?.group === o.group || st.tartan?.group === o.group);
  return own ? parentOf(doc, o.group) : o.group;
}

/**
 * Remove the ramp of `id` (and its blend partner): a plain fill again. A
 * blend keeps its first (fading out) layer; when only the fading-in layer is
 * left, that one stays.
 */
export function removeRampDoc(doc: StitchDocument, id: string): { doc: StitchDocument; keep: string[] } {
  const members = rampMembers(doc, id);
  if (!members.length) return { doc, keep: [] };
  const forward = members.filter((m) => !rampOf(m)?.reverse);
  const kept = forward.length ? forward : members.slice(0, 1);
  const keep = new Set(kept.map((m) => m.id));
  const all = new Set(members.map((m) => m.id));
  return {
    doc: {
      ...doc,
      objects: doc.objects
        .filter((x) => !all.has(x.id) || keep.has(x.id))
        .map((x) => (keep.has(x.id) && x.stitch.type === "fill" ? { ...x, stitch: { ...x.stitch, ramp: undefined, underlay: true } } : x)),
    },
    keep: [...keep],
  };
}

/**
 * The stops in reverse: positions mirrored, the colours in the other order.
 * A midpoint belongs to the lower stop of each pair (by position), so after
 * reversing, the new lower stop of a pair takes the mirrored midpoint of the
 * pair it came from.
 */
export function reverseStops<T extends GradientStop>(stops: T[]): T[] {
  const order = stops.map((_, i) => i).sort((a, b) => stops[a].pos - stops[b].pos);
  const mid = new Map<number, number>();
  for (let k = 0; k + 1 < order.length; k++) mid.set(order[k + 1], 1 - stops[order[k]].mid);
  return stops.map((x, i) => ({ ...x, pos: 1 - x.pos, mid: mid.get(i) ?? 0.5 })).reverse();
}

const stripColour = (name: string) => name.replace(/ · colour \d+$/, "");

/**
 * After colour layers of gradients were deleted: the stops of the deleted
 * layers go and the layers left are numbered 0, 1, … again (2D gradients'
 * nodes follow); a gradient with one layer left becomes a plain fill.
 * Returns `doc` itself when every gradient is whole.
 */
export function repairGradients(doc: StitchDocument): StitchDocument {
  const groups = new Map<string, DesignObject[]>();
  for (const o of doc.objects) {
    if (o.clone || o.stitch.type !== "fill" || !o.stitch.gradient) continue;
    const g = o.stitch.gradient.group;
    groups.set(g, [...(groups.get(g) ?? []), o]);
  }
  const replace = new Map<string, DesignObject>();
  for (const [group, list] of groups) {
    const layers = [...list].sort((a, b) => (a.stitch as GradientFill).gradient.layer - (b.stitch as GradientFill).gradient.layer);
    const g = (layers[0].stitch as GradientFill).gradient;
    const n = g.stops.length;
    const idx = layers.map((l) => (l.stitch as GradientFill).gradient.layer);
    if (idx.length === n && idx.every((k, i) => k === i)) continue;
    // numbers we can't map to stops (duplicates, out of range): left alone
    if (new Set(idx).size !== idx.length || idx.some((k) => !Number.isInteger(k) || k < 0 || k >= n)) continue;
    const remap = new Map(idx.map((k, i) => [k, i]));
    // a node of a deleted colour takes the nearest colour left
    const nearest = (c: number) => {
      if (remap.has(c)) return remap.get(c)!;
      let best = 0;
      idx.forEach((k, i) => {
        if (Math.abs(k - c) < Math.abs(idx[best] - c)) best = i;
      });
      return best;
    };
    if (layers.length === 1) {
      const o = layers[0];
      const { gradient: _g, ...fill } = o.stitch as GradientFill;
      void _g;
      replace.set(o.id, { ...o, group: o.group === group ? parentOf(doc, group) : o.group, name: stripColour(o.name), stitch: { ...fill, type: "fill" } });
      continue;
    }
    const stops = idx.map((k) => g.stops[k]);
    const mesh = g.mesh ? { ...g.mesh, nodes: g.mesh.nodes.map((x) => ({ ...x, c: nearest(x.c) })) } : undefined;
    let points = g.points;
    if (points) {
      const left = points.filter((x) => remap.has(x.c));
      points = (left.length ? left : points).map((x) => ({ ...x, c: nearest(x.c) }));
    }
    const base = stripColour(layers[0].name);
    layers.forEach((o, i) => {
      const st = o.stitch as GradientFill;
      replace.set(o.id, {
        ...o,
        name: `${base} · colour ${i + 1}`,
        stitch: { ...st, type: "fill", gradient: { ...st.gradient, stops, layer: i, ...(mesh ? { mesh } : {}), ...(points ? { points } : {}) } },
      });
    });
  }
  if (!replace.size) return doc;
  return pruneGroups({ ...doc, objects: doc.objects.map((o) => replace.get(o.id) ?? o) });
}
