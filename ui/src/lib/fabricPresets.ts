// Fabric presets: per-fabric starting values the user can switch on for a
// design. Without one (the default) new objects start from Ink/Stitch's
// values: no pull compensation unless the fabric is calibrated.
//
//   Filum       Filum's values before 0.2.1: satins with centre-walk and
//               automatic underlay and 0.2 mm pull compensation, tatami with
//               0.4 mm rows and 3 mm stitches; the fabric adds pull
//               compensation on stretchy and pile fabrics (from published
//               digitizing guidance: T-shirt knit 0.35 mm, fleece 0.4 mm in
//               total on a satin).
//   NOVAstitch  the presets of the NOVAstitch Designer fork
//               (effepol/NOVAstitch-designer, module e): pull compensation
//               1 mm on knit and piqué, 0.5 mm on fleece; fills reach 0.4 mm
//               under their neighbours on stretchy fabrics and caps, 0.2 mm on
//               the others; contour underlay (0.5 mm in) on satins 2 mm and
//               wider.
//
// A fabric calibration still wins: its measured pull compensation replaces
// the preset's, and its expand is added to the preset's overlap.

import type { Fabric, FillParams, SatinParams, StitchDocument, StitchParams } from "../types";
import { FILUM_NEW_FILL, INK_SATIN, INK_TATAMI } from "./inkDefaults";

export type PresetSet = "filum" | "nova";

export const PRESET_SETS: { id: PresetSet | "none"; label: string; hint: string }[] = [
  {
    id: "none",
    label: "Ink/Stitch (no compensation)",
    hint: "Ink/Stitch's values: no pull compensation unless you calibrate the fabric. New fills get automatic underlay (none in a fill too narrow for one)",
  },
  { id: "filum", label: "Filum", hint: "Filum's earlier values: centre-walk underlay, 0.4 mm rows, pull compensation by fabric" },
  { id: "nova", label: "NOVAstitch", hint: "The NOVAstitch Designer presets: pull compensation and fill overlap by fabric, contour underlay on satins" },
];

/** Filum: pull compensation the fabric added to satins (on top of 0.2 mm) and fills (mm). */
const FILUM_PULL: Record<Fabric, number> = {
  cotton: 0,
  polyester: 0.1,
  denim: 0,
  knit: 0.15,
  sheer: 0.1,
  felt: 0.05,
  towel: 0.25,
  cap: 0.35,
  fleece: 0.2,
  pique: 0.15,
  leather: 0,
  canvas: 0,
  silk: 0,
};
const FILUM_SATIN = { centerWalk: true, underlayAuto: true, contourInset: 0.4, zigzagUnderlayInset: 0.6 };
const FILUM_TATAMI = { rowSpacing: 0.4, maxStitchLength: 3, underlayInset: 0.3, underlayStitchLength: 3, underlayAuto: true };

/** NOVAstitch: pull compensation (satins and fills) and fill overlap (mm). */
const NOVA: Record<Fabric, { pull: number; overlap: number }> = {
  cotton: { pull: 0, overlap: 0.2 },
  polyester: { pull: 0, overlap: 0.2 },
  denim: { pull: 0, overlap: 0.2 },
  knit: { pull: 1, overlap: 0.4 },
  sheer: { pull: 0, overlap: 0.4 },
  felt: { pull: 0, overlap: 0.2 },
  towel: { pull: 0, overlap: 0.4 },
  cap: { pull: 0, overlap: 0.4 },
  fleece: { pull: 0.5, overlap: 0.4 },
  pique: { pull: 1, overlap: 0.4 },
  leather: { pull: 0, overlap: 0.2 },
  canvas: { pull: 0, overlap: 0.2 },
  silk: { pull: 0, overlap: 0.2 },
};
/** NOVAstitch: satins this wide (mm) and wider get contour underlay. */
const NOVA_CONTOUR_FROM = 2;

/** Every setting a preset may set: what "Apply" puts back to Ink/Stitch's value when the preset in force doesn't set it. */
const SATIN_KEYS = ["pullComp", "centerWalk", "underlayAuto", "contourUnderlay", "contourInset", "zigzagUnderlayInset"] as const;
const FILL_KEYS = ["pullComp", "expand"] as const;
const TATAMI_KEYS = ["rowSpacing", "maxStitchLength", "underlayInset", "underlayStitchLength", "underlayAuto"] as const;

const INK: Record<string, unknown> = { ...INK_SATIN };
const INK_FILL: Record<string, unknown> = { ...INK_TATAMI, ...FILUM_NEW_FILL, expand: 0 };

export const presetSetOf = (doc: Pick<StitchDocument, "options">): PresetSet | undefined => doc.options?.presetSet;

const isTatami = (st: StitchParams) => st.type === "fill" && (st.method ?? "tatami") === "tatami" && !st.gradient && !st.ramp;

/** What a preset gives an object with this stitch (a satin by its width): only the settings it sets. */
export function presetValues(set: PresetSet | undefined, fabric: Fabric, st: StitchParams): Record<string, unknown> {
  if (!set) return {};
  if (st.type === "satin") {
    if (set === "filum") return { ...FILUM_SATIN, pullComp: +(0.2 + FILUM_PULL[fabric]).toFixed(2) };
    return { pullComp: NOVA[fabric].pull, contourInset: 0.5, contourUnderlay: st.width >= NOVA_CONTOUR_FROM };
  }
  if (st.type === "fill") {
    const tatami = isTatami(st);
    if (set === "filum") return { ...(tatami ? FILUM_TATAMI : {}), pullComp: FILUM_PULL[fabric] };
    return { pullComp: NOVA[fabric].pull, expand: NOVA[fabric].overlap };
  }
  return {};
}

/** In a few words, what the preset does on this fabric. */
export function presetSummary(set: PresetSet | undefined, fabric: Fabric): string {
  if (set === "filum") {
    const extra = FILUM_PULL[fabric];
    return `Filum preset: ${(0.2 + extra).toFixed(2)} mm pull compensation on satins${extra ? `, ${extra.toFixed(2)} mm on fills` : ""}, centre-walk underlay, 0.4 mm rows`;
  }
  if (set === "nova") {
    const n = NOVA[fabric];
    return `NOVAstitch preset: ${n.pull ? `${n.pull} mm pull compensation, ` : "no pull compensation, "}fills ${n.overlap} mm under their neighbours, contour underlay on satins from ${NOVA_CONTOUR_FROM} mm`;
  }
  return "";
}

type Calibrated = { satin?: Partial<SatinParams>; fill?: Partial<FillParams> };

/** The calibration on top of a preset's values: its pull compensation replaces the preset's, its expand adds to the overlap. */
function withCalibration(v: Record<string, unknown>, cal: Partial<SatinParams> | Partial<FillParams> | undefined): Record<string, unknown> {
  if (!cal) return v;
  const out: Record<string, unknown> = { ...v, ...cal };
  const exp = (cal as Record<string, unknown>).expand;
  if (typeof exp === "number" && typeof v.expand === "number") out.expand = +(v.expand + exp).toFixed(3);
  return out;
}

/** What new satins and fills start from: the preset in force, then the fabric's calibration. */
export function newObjectDefaults(doc: Pick<StitchDocument, "options" | "fabric">, calibrated: Calibrated): Calibrated {
  const set = presetSetOf(doc);
  const satin = withCalibration(presetValues(set, doc.fabric, { type: "satin", ...INK_SATIN, width: 3 } as StitchParams), calibrated.satin);
  const fill = withCalibration(presetValues(set, doc.fabric, { type: "fill", method: "tatami" } as StitchParams), calibrated.fill);
  return {
    ...(Object.keys(satin).length ? { satin: satin as Partial<SatinParams> } : {}),
    ...(Object.keys(fill).length ? { fill: fill as Partial<FillParams> } : {}),
  };
}

const same = (a: unknown, b: unknown) => (typeof a === "number" && typeof b === "number" ? Math.abs(a - b) < 1e-6 : a === b);

/** The settings an object should hold under the preset in force (calibration on top); null: none for its stitch. */
function targetOf(set: PresetSet | undefined, fabric: Fabric, st: StitchParams, calibrated: Calibrated): Record<string, unknown> | null {
  if (st.type !== "satin" && st.type !== "fill") return null;
  const keys: readonly string[] = st.type === "satin" ? SATIN_KEYS : isTatami(st) ? [...FILL_KEYS, ...TATAMI_KEYS] : FILL_KEYS;
  const base = st.type === "satin" ? INK : INK_FILL;
  const v = withCalibration(presetValues(set, fabric, st), st.type === "satin" ? calibrated.satin : calibrated.fill);
  const out: Record<string, unknown> = {};
  for (const k of keys) out[k] = k in v ? v[k] : base[k];
  // the calibration's push compensation on satins
  for (const [k, x] of Object.entries(v)) if (!(k in out)) out[k] = x;
  return out;
}

/** The satins and fills in the design that don't hold the preset's values (with the calibration on top). */
export function objectsOffPreset(doc: StitchDocument, calibrated: Calibrated): string[] {
  const set = presetSetOf(doc);
  return doc.objects
    .filter((o) => {
      if (o.locked) return false;
      const t = targetOf(set, doc.fabric, o.stitch, calibrated);
      const cur = o.stitch as unknown as Record<string, unknown>;
      return !!t && Object.entries(t).some(([k, x]) => !same(cur[k] ?? (typeof x === "number" ? 0 : false), x));
    })
    .map((o) => o.id);
}

/** Every unlocked satin and fill given the preset's values (Ink/Stitch's where it sets none), the calibration on top. */
export function applyPresetToObjects(doc: StitchDocument, calibrated: Calibrated): StitchDocument {
  const off = new Set(objectsOffPreset(doc, calibrated));
  if (!off.size) return doc;
  const set = presetSetOf(doc);
  return {
    ...doc,
    objects: doc.objects.map((o) => {
      if (!off.has(o.id)) return o;
      const t = targetOf(set, doc.fabric, o.stitch, calibrated)!;
      return { ...o, stitch: { ...o.stitch, ...t } as StitchParams };
    }),
  };
}
