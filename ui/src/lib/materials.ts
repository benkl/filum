// Materials: fabrics with the stabiliser and needle their makers recommend,
// and thread weights with spacing, needle and the smallest lettering.
//
// Sources (manufacturer guides):
// - Stabilisers: OESD Stabilizer Guide, Floriani Stabilizer Recommendation,
//   Madeira FAQ + backing selector ("cut-away for flexible fabrics, tear-away
//   for strong ones; a thin topping on terry, T-shirts, piqué and knits").
// - Needles: SCHMETZ Embroidery (01/2024), Groz-Beckert embroidery needles,
//   Organ needle size chart.
// - Thread: Madeira USA "Threads & Digitizing" (stitch density guide, needle
//   per thread), Madeira Polyneon / Classic pages (smallest lettering), Melco
//   small-lettering guide (0.20″ / 0.25″ on caps).
// Where makers disagree or none publishes a value, the entry says so.

import type { Fabric, Hoop, ThreadWeight } from "../types";

export type Confidence = "agreed" | "conflict" | "inferred";

export interface FabricInfo {
  id: Fabric;
  label: string;
  /** What the fabric preset does to the stitches (Settings ▸ fabric profile). */
  effect: string;
  backing: string;
  topping: string;
  needle: string;
  /** Do the makers agree? */
  confidence: Confidence;
  note?: string;
}

export const FABRICS: FabricInfo[] = [
  {
    id: "cotton",
    label: "Cotton",
    effect: "Standard settings",
    backing: "Tear-away (cut-away for dense designs on garments)",
    topping: "None",
    needle: "Sharp 75/11",
    confidence: "agreed",
  },
  {
    id: "polyester",
    label: "Polyester",
    effect: "A little more pull compensation",
    backing: "Tear-away; cut-away for dense designs",
    topping: "None",
    needle: "Sharp / Microtex 65/9–75/11",
    confidence: "inferred",
    note: "No maker lists woven polyester by name — taken from their densely woven / microfibre advice.",
  },
  {
    id: "denim",
    label: "Denim",
    effect: "Wider spacing, minimal compensation (denim / heavy twill)",
    backing: "Tear-away (Madeira, Floriani) or medium cut-away (OESD)",
    topping: "None",
    needle: "Sharp 80/12–90/14",
    confidence: "conflict",
    note: "The makers disagree on the backing; cut-away is the safer choice for garments that are washed often.",
  },
  {
    id: "knit",
    label: "Knit / Jersey",
    effect: "More pull compensation (0.35 mm for T-shirt knits), slightly looser, underlay always on",
    backing: "Cut-away (no-show mesh for light designs, medium cut-away for dense ones)",
    topping: "Water-soluble film",
    needle: "Ballpoint 70/10–75/11",
    confidence: "agreed",
  },
  {
    id: "pique",
    label: "Piqué / Polo",
    effect: "Slightly looser, extra edge + zigzag underlay",
    backing: "Light cut-away mesh",
    topping: "Water-soluble film (keeps stitches above the texture)",
    needle: "Ballpoint 70/10–75/11",
    confidence: "agreed",
  },
  {
    id: "fleece",
    label: "Fleece",
    effect: "More pull compensation, wider spacing, heavy underlay",
    backing: "Heavy cut-away",
    topping: "Water-soluble film or a permanent cover",
    needle: "Ballpoint 75/11",
    confidence: "agreed",
  },
  {
    id: "towel",
    label: "Towel / Terry",
    effect: "More pull compensation, denser, underlay always on",
    backing: "Tear-away",
    topping: "Water-soluble film — essential, or the loops swallow the stitches",
    needle: "75/11",
    confidence: "agreed",
  },
  {
    id: "sheer",
    label: "Organza / Sheer",
    effect: "Lighter density and underlay",
    backing: "Wash-away (fibrous or film)",
    topping: "Optional water-soluble film",
    needle: "Ballpoint / fine 65/9",
    confidence: "agreed",
  },
  {
    id: "silk",
    label: "Silk / Satin",
    effect: "Less density and compensation, minimal underlay",
    backing: "Fusible woven interfacing + tear-away",
    topping: "Optional water-soluble film",
    needle: "Fine sharp (Microtex) 65/9–75/11",
    confidence: "agreed",
  },
  {
    id: "canvas",
    label: "Canvas",
    effect: "Wider spacing, little compensation",
    backing: "Tear-away",
    topping: "None",
    needle: "Sharp 80/12",
    confidence: "agreed",
  },
  {
    id: "leather",
    label: "Leather / Vinyl",
    effect: "Lower density, minimal underlay — every needle hole stays",
    backing: "Sticky cut-away, floated instead of hooped (or tear-away)",
    topping: "None",
    needle: "Sharp 75/11–90/14",
    confidence: "conflict",
    note: "Makers disagree on cutting (wedge) points: Groz-Beckert advises against them, Organ offers a narrow wedge.",
  },
  {
    id: "felt",
    label: "Felt",
    effect: "Slightly lighter density and underlay",
    backing: "Tear-away",
    topping: "None",
    needle: "Sharp 75/11",
    confidence: "inferred",
    note: "No stabiliser maker gives felt its own recommendation.",
  },
  {
    id: "cap",
    label: "Cap / Structured",
    effect: "Most pull compensation, underlay always on",
    backing: "Cap tear-away",
    topping: "Optional",
    needle: "Sharp 75/11–80/12",
    confidence: "agreed",
  },
];

export const fabricInfo = (f: Fabric) => FABRICS.find((x) => x.id === f) ?? FABRICS[0];

export interface ThreadWeightInfo {
  weight: ThreadWeight;
  label: string;
  /** Satin spacing for this weight (mm) — the density guide's value. */
  spacing: number;
  needle: string;
  /** Smallest lettering (cap height, mm). */
  minText: number;
  minTextSource: string;
  /** Linear density (tex): Madeira Polyneon data sheets (75 / 60 / 40), Schmetz's table for No. 30 / 12. */
  tex: number;
}

export const THREAD_WEIGHTS: ThreadWeightInfo[] = [
  { weight: 75, label: "No. 75 (extra fine)", spacing: 0.2, needle: "60/8", minText: 2.5, minTextSource: "Madeira Polyneon 75", tex: 11 },
  { weight: 60, label: "No. 60 (fine)", spacing: 0.35, needle: "60/8–65/9", minText: 3, minTextSource: "Madeira Polyneon / Classic 60", tex: 17 },
  { weight: 40, label: "No. 40 (standard)", spacing: 0.4, needle: "65/9–75/11", minText: 5, minTextSource: "Melco small-lettering guide (6.4 mm on caps)", tex: 27 },
  { weight: 30, label: "No. 30 (heavy)", spacing: 0.5, needle: "75/11–80/12", minText: 6.3, minTextSource: "no published minimum — scaled from No. 40 by the spacing", tex: 40 },
  { weight: 12, label: "No. 12 (very heavy)", spacing: 0.8, needle: "100/16", minText: 10, minTextSource: "no published minimum — scaled from No. 40 by the spacing", tex: 100 },
];

/**
 * How wide a stitch of this thread lies on the fabric (mm): 0.4 mm for No. 40
 * (the standard satin spacing, where neighbouring stitches just touch),
 * scaled with the thread's diameter, which grows with √tex.
 */
export const threadWidth = (w: ThreadWeight | undefined) => 0.4 * Math.sqrt(threadWeightInfo(w).tex / 27);

/**
 * How glossy a thread looks (0 matte … 1 rayon, > 1 metallic), from its brand
 * and name: rayon shines most, polyester a little less, cotton is matte.
 */
export function threadSheen(t: { brand?: string; name?: string } | undefined): number {
  const s = `${t?.brand ?? ""} ${t?.name ?? ""}`.toLowerCase();
  if (/metal|gold|silver|glitter|supertwist|lamé|lame|holo/.test(s)) return 1.4;
  if (/dmc|cotton|cotona|cotone|mako|aurifil|gütermann|gutermann|anchor|wool|burmilana|frosted|matt/.test(s)) return 0.25;
  if (/rayon|classic|sulky|marathon|robison|viscose/.test(s)) return 1;
  return 0.8; // polyester: Isacord, Polyneon, Brother, Floriani, Simthread …
}

export const threadWeightInfo = (w: ThreadWeight | undefined) => THREAD_WEIGHTS.find((x) => x.weight === (w ?? 40)) ?? THREAD_WEIGHTS[2];

// ---- hoop shapes ------------------------------------------------------------

/** Is the point (mm, document coordinates) inside the hoop? */
export function inHoop(hoop: Hoop, x: number, y: number, tol = 0.01): boolean {
  if (hoop.shape !== "oval") return x >= -tol && y >= -tol && x <= hoop.width + tol && y <= hoop.height + tol;
  const rx = hoop.width / 2 + tol;
  const ry = hoop.height / 2 + tol;
  const dx = (x - hoop.width / 2) / rx;
  const dy = (y - hoop.height / 2) / ry;
  return dx * dx + dy * dy <= 1;
}

/** How far outside an ellipse a point is, as the ellipse's own measure (≤ 1 = inside). */
export function ovalNorm(cx: number, cy: number, w: number, h: number, x: number, y: number): number {
  const dx = (x - cx) / (w / 2);
  const dy = (y - cy) / (h / 2);
  return Math.sqrt(dx * dx + dy * dy);
}

/** "oval" or "round" for the UI. */
export const shapeLabel = (h: { width: number; height: number; shape?: string }) =>
  h.shape === "oval" ? (Math.abs(h.width - h.height) < 0.01 ? "round" : "oval") : "rectangle";
