// Issues: the places too dense for the fabric, as the density map finds
// them (engine density.rs), and whether fills there lie on top of each other.

import type { DesignObject, PlanData, StitchDocument, Vec2 } from "../types";
import { defaultDesignOptions, flatten } from "./geometry";
import type { Issue } from "./issues";
import { insideRings } from "./regions";

/** At most this many too-dense places in the list (the largest, one per object; the density map shows them all). */
const MAX_DENSE_ISSUES = 6;
/** Smaller places are left to the density map (mm²). */
const MIN_DENSE_AREA = 0.25;

/** A fill's outline as rings (once per object). */
const ringCache = new WeakMap<DesignObject, Vec2[][]>();
function fillRings(o: DesignObject): Vec2[][] {
  let r = ringCache.get(o);
  if (!r) ringCache.set(o, (r = o.paths.filter((p) => p.closed && p.nodes.length >= 3).map((p) => flatten(p))));
  return r;
}

/**
 * Whether fills lie on top of each other in a place (most of a 3 × 3 grid
 * over its box inside two or more of them), rather than meeting at their
 * edges: only then does Remove hidden stitching thin it out.
 */
export function fillsStackAt(objs: DesignObject[], box: { x: number; y: number; w: number; h: number }): boolean {
  const fills = objs.filter((o) => o.stitch.type === "fill" && o.visible);
  if (fills.length < 2) return false;
  let n = 0;
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) {
      const q: Vec2 = [box.x + ((i + 0.5) / 3) * box.w, box.y + ((j + 0.5) / 3) * box.h];
      if (fills.filter((o) => insideRings(fillRings(o), q)).length >= 2) n++;
    }
  return n >= 5;
}

/**
 * The places too dense for the fabric, as the density map finds them
 * (engine density.rs: thread layers or needle holes beyond what the fabric
 * takes). Where a needle-hole issue already points at the same place, that
 * one says it.
 */
export function denseIssues(doc: StitchDocument, plan: PlanData | null, before: Issue[]): Issue[] {
  const d = plan?.dense;
  const lim = d?.limits;
  if (!d || !lim) return [];
  const spots = d.hotspots.filter((h) => h.area >= MIN_DENSE_AREA);
  const holes = before.filter((i) => i.id.startsWith("holes:"));
  const seen = new Set<number>();
  const out: Issue[] = [];
  const stacked = !doc.options?.removeOverlaps;
  for (const h of spots) {
    if (out.length >= MAX_DENSE_ISSUES) break;
    const objs = h.objects.map((i) => doc.objects[i]).filter((o): o is DesignObject => !!o);
    const o = objs[0];
    if (!o || seen.has(h.objects[0])) continue;
    const at: Vec2 = [h.x + h.w / 2, h.y + h.h / 2];
    if (holes.some((i) => Math.abs(i.at[0] - at[0]) <= h.w / 2 + 1 && Math.abs(i.at[1] - at[1]) <= h.h / 2 + 1)) continue;
    seen.add(h.objects[0]);
    const what =
      h.peakLayers > lim.layersMax
        ? `${h.peakLayers.toFixed(1)} layers of thread here; ${doc.fabric} takes ${lim.layersMax}`
        : `${Math.round(h.peakHoles)} needle holes per mm² here; ${doc.fabric} takes ${Math.round(lim.holesMax)}`;
    const names = (xs: DesignObject[]) => xs.slice(0, 3).map((x) => x.name).join(", ");
    const layered = stacked && fillsStackAt(objs, h);
    const why = layered
      ? `${names(objs.filter((x) => x.stitch.type === "fill"))} lie on top of each other: Remove hidden stitching leaves out what the objects on top cover.`
      : objs.length >= 2
        ? `${names(objs)} meet here: their rows end along the same edges, and the thread stacks up where they come together. Less overlap or pull compensation, or a wider spacing in one of them, thins it out.`
        : `${o.name}'s stitches pile up here: a wider spacing spreads them.`;
    out.push({
      id: `dense:${o.id}`,
      objId: o.id,
      level: "warning",
      title: "Too dense for the fabric",
      detail: `${what}. The embroidery turns stiff, the thread frays and needles break. ${why}`,
      at,
      ...(layered
        ? { fix: { label: "Remove hidden stitching", doc: (x: StitchDocument) => ({ ...x, options: { ...(x.options ?? defaultDesignOptions()), removeOverlaps: true } }) } }
        : {}),
    });
  }
  const more = spots.length - out.length;
  if (out.length && more > 0) out[out.length - 1].detail += ` ${more} more place${more === 1 ? "" : "s"}: the density map (Shift+D) shows them all.`;
  return out;
}
