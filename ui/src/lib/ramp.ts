// Density gradients on the canvas: a fill whose rows get more
// open along a vector (gradient fill), and colour blending — two layers of
// one shape with opposite density ramps that add up to an even coverage.

import { useStore } from "../store";
import type { DensityRamp, DesignObject, FillParams, RampProfile, StitchDocument, Vec2 } from "../types";
import { uid } from "./geometry";

export const RAMP_PROFILES: { id: RampProfile; label: string; hint: string }[] = [
  { id: "linear", label: "Linear", hint: "Even change from dense to open" },
  { id: "easeIn", label: "Ease in", hint: "Stays dense, then opens up quickly" },
  { id: "easeOut", label: "Ease out", hint: "Opens up quickly, then stays open" },
  { id: "smooth", label: "S-curve", hint: "Dense and open ends with a soft transition" },
  { id: "middle", label: "Centre dense", hint: "Dense in the middle, open at both ends" },
  { id: "ends", label: "Centre open", hint: "Open in the middle, dense at both ends" },
];

/** 0 = densest, 1 = sparsest (mirrors the engine). */
export function profileAt(p: RampProfile, t: number): number {
  t = Math.min(1, Math.max(0, t));
  switch (p) {
    case "easeIn":
      return t * t;
    case "easeOut":
      return 1 - (1 - t) * (1 - t);
    case "smooth":
      return t * t * (3 - 2 * t);
    case "middle":
      return Math.abs(2 * t - 1);
    case "ends":
      return 1 - Math.abs(2 * t - 1);
    default:
      return t;
  }
}

/** Row spacing at t (0 at `from`, 1 at `to`). */
export function rampSpacing(r: DensityRamp, t: number): number {
  const f = profileAt(r.profile, r.reverse ? 1 - t : t);
  const dense = Math.max(0.08, r.dense);
  const sparse = Math.max(dense, r.sparse);
  const s = r.additive ? 1 / (1 / dense + (1 / sparse - 1 / dense) * f) : dense + (sparse - dense) * f;
  return Math.max(0.05, s);
}

/** Where the rows fall along the ramp (fractions 0..1), for the density comb. */
export function rampRows(r: DensityRamp, max = 400): number[] {
  const len = Math.hypot(r.to[0] - r.from[0], r.to[1] - r.from[1]);
  if (len < 1e-6) return [];
  const out: number[] = [];
  let d = 0;
  while (d <= len && out.length < max) {
    out.push(d / len);
    d += rampSpacing(r, d / len);
  }
  return out;
}

/** Fill angle (degrees) whose rows run across the vector a → b. */
export function angleAcross(a: Vec2, b: Vec2): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  // rows run along (cos θ, −sin θ); across the vector: (−dy, dx)
  const deg = (Math.atan2(-dx, -dy) * 180) / Math.PI;
  return Math.round((((deg % 180) + 180) % 180) * 10) / 10;
}

export const rampOf = (o: DesignObject | undefined): DensityRamp | undefined => (o?.stitch.type === "fill" ? o.stitch.ramp : undefined);

/** The objects of a ramp: one, or both layers of a colour blend. */
export function rampMembers(doc: StitchDocument, id: string): DesignObject[] {
  const o = doc.objects.find((x) => x.id === id);
  const r = rampOf(o);
  if (!o || !r) return [];
  if (!r.group) return [o];
  return doc.objects.filter((x) => rampOf(x)?.group === r.group);
}

/** The selected object that has a ramp (or the first selected closed fill). */
export function selectedRamp(): DesignObject | undefined {
  const s = useStore.getState();
  return s.doc.objects.find((o) => s.selection.includes(o.id) && rampOf(o));
}

const isClosedFill = (o: DesignObject) => o.paths.some((sp) => sp.closed) && !(o.stitch.type === "fill" && o.stitch.gradient);

/**
 * Put a density gradient on a closed shape along a → b; with `blend`, a
 * second layer in the next colour fades in the other way. An existing ramp
 * (and its blend partner) just gets the new vector.
 */
export function applyRamp(id: string, a: Vec2, b: Vec2, mode: "density" | "blend"): string | null {
  const s = useStore.getState();
  const o = s.doc.objects.find((x) => x.id === id);
  if (!o || !isClosedFill(o)) return "Density gradients need a closed shape (not one with a colour gradient)";
  const opts = s.toolOptions.gradient;
  const angle = angleAcross(a, b);
  const existing = rampOf(o);
  if (existing) {
    const members = rampMembers(s.doc, id);
    s.commit((d) => ({
      ...d,
      objects: d.objects.map((x) =>
        members.some((m) => m.id === x.id) && x.stitch.type === "fill" ? { ...x, stitch: { ...x.stitch, angle, ramp: { ...x.stitch.ramp!, from: a, to: b } } } : x,
      ),
    }));
    return null;
  }
  const base: DensityRamp = { from: a, to: b, dense: opts.dense ?? 0.25, sparse: opts.sparse ?? 2, profile: opts.profile ?? "linear" };
  const fill = (stitch: DesignObject["stitch"], ramp: DensityRamp): FillParams => ({
    ...(stitch.type === "fill" ? stitch : (defaultFill() as FillParams)),
    // a flow fill keeps flowing (the ramp sets its streamline distance)
    method: stitch.type === "fill" && ((stitch.method === "flow" && stitch.flow) || stitch.method === "curved") ? stitch.method : "tatami",
    angle,
    endRowSpacing: 0,
    gradientDensity: false,
    // no underlay under a gradient (it would show through the open part)
    underlay: false,
    ramp,
  });
  if (mode === "density") {
    s.commit((d) => ({ ...d, objects: d.objects.map((x) => (x.id === id ? { ...x, stitch: { type: "fill", ...fill(x.stitch, base) } as DesignObject["stitch"] } : x)) }));
    return null;
  }
  // colour blend: this colour fades out, the second fades in
  const group = uid("blend");
  const second = secondThread(o.thread);
  const a1: DesignObject = { ...o, stitch: { type: "fill", ...fill(o.stitch, { ...base, additive: true, group }) } as DesignObject["stitch"] };
  const b1: DesignObject = {
    ...o,
    id: uid(),
    name: `${o.name} · blend`,
    thread: second,
    stitch: { type: "fill", ...fill(o.stitch, { ...base, additive: true, reverse: true, group }) } as DesignObject["stitch"],
  };
  s.commit((d) => ({ ...d, objects: d.objects.flatMap((x) => (x.id === id ? [a1, b1] : [x])) }));
  s.select([o.id, b1.id]);
  return null;
}

/** The colour that fades in: the active thread if it differs, else the next one. */
function secondThread(first: string): string {
  const s = useStore.getState();
  if (s.activeThread && s.activeThread !== first) return s.activeThread;
  const others = s.doc.threads.filter((t) => t.id !== first);
  if (others.length) return others[0].id;
  return s.ensureThread("#3a7bd5", "Blue");
}

function defaultFill(): Partial<FillParams> {
  return { type: "fill", method: "tatami", angle: 0, rowSpacing: 0.25, maxStitchLength: 3 } as Partial<FillParams>;
}

/** Change the ramp of an object and its blend partner (the partner keeps its direction). */
export function updateRamp(id: string, patch: Partial<DensityRamp>, live = false) {
  const s = useStore.getState();
  const members = rampMembers(s.doc, id);
  if (!members.length) return;
  const angle = patch.from || patch.to ? (() => {
    const r = rampOf(members[0])!;
    return angleAcross(patch.from ?? r.from, patch.to ?? r.to);
  })() : undefined;
  const fn = (d: StitchDocument) => ({
    ...d,
    objects: d.objects.map((x) =>
      members.some((m) => m.id === x.id) && x.stitch.type === "fill" && x.stitch.ramp
        ? { ...x, stitch: { ...x.stitch, ...(angle != null ? { angle } : {}), ramp: { ...x.stitch.ramp, ...patch, reverse: x.stitch.ramp.reverse, group: x.stitch.ramp.group } } }
        : x,
    ),
  });
  if (live) s.liveUpdate(fn);
  else s.commit(fn);
}

/** Remove the ramp: a plain fill again (a blend keeps its first layer). */
export function removeRamp(id: string) {
  const s = useStore.getState();
  const members = rampMembers(s.doc, id);
  const drop = new Set(members.filter((m) => rampOf(m)?.reverse).map((m) => m.id));
  s.commit((d) => ({
    ...d,
    objects: d.objects
      .filter((x) => !drop.has(x.id))
      .map((x) => (members.some((m) => m.id === x.id) && x.stitch.type === "fill" ? { ...x, stitch: { ...x.stitch, ramp: undefined, underlay: true } } : x)),
  }));
  s.select(members.filter((m) => !drop.has(m.id)).map((m) => m.id));
}
