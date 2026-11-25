// The editor's types against the engine's (generated/engine-types.ts, from
// the Rust serde shapes): the typecheck fails when a field or a choice is on
// one side only, and the error names it. A field only the editor keeps is
// listed with its pair (the third argument), with why.

import type * as E from "../generated/engine-types";
import type * as U from "../types";

/** The fields of an object type (of every member of a union). */
type Fields<T> = T extends unknown ? keyof T & string : never;
/** true when both have the same fields, the editor's own `EditorOnly` aside; else the fields on one side. */
type SameFields<Ui, Engine, EditorOnly extends string = never> = [Exclude<Fields<Ui>, Fields<Engine> | EditorOnly>, Exclude<Fields<Engine>, Fields<Ui>>] extends [never, never]
  ? true
  : { onlyInEditor: Exclude<Fields<Ui>, Fields<Engine> | EditorOnly>; onlyInEngine: Exclude<Fields<Engine>, Fields<Ui>> };
/** true when both unions have the same members; else the members on one side. */
type SameUnion<Ui, Engine> = [Exclude<Ui, Engine>, Exclude<Engine, Ui>] extends [never, never] ? true : { onlyInEditor: Exclude<Ui, Engine>; onlyInEngine: Exclude<Engine, Ui> };

/** Compiles only when its check is `true` (the error shows the fields on one side). */
const ok = <T extends true>(): T => true as T;

/** Every pair matches. */
export const engineTypesMatch = {
  appliqueParams: ok<SameFields<U.AppliqueParams, E.AppliqueParams>>(),
  basting: ok<SameUnion<U.Basting, E.Basting>>(),
  carvePattern: ok<SameUnion<U.CarvePattern, E.CarvePattern>>(),
  connection: ok<SameFields<U.Connection, E.Connection>>(),
  coverKind: ok<SameUnion<U.CoverKind, E.CoverKind>>(),
  coverMode: ok<SameUnion<U.CoverMode, E.CoverMode>>(),
  crossKind: ok<SameUnion<U.CrossKind, E.CrossKind>>(),
  // the worker hands the cell classes over as `cls` (engine/worker.ts)
  densityField: ok<SameFields<Omit<U.DensityField, "cls"> & { class: unknown }, E.DensityField>>(),
  densityRamp: ok<SameFields<U.DensityRamp, E.DensityRamp>>(),
  densityStats: ok<SameFields<U.DensityStats, E.DensityStats>>(),
  designOptions: ok<SameFields<U.DesignOptions, E.DesignOptions>>(),
  ditherMethod: ok<SameUnion<U.DitherMethod, E.DitherMethod>>(),
  elementInfo: ok<SameFields<U.ElementInfo, E.ElementInfo>>(),
  fabric: ok<SameUnion<U.Fabric, E.Fabric>>(),
  fabricLimits: ok<SameFields<U.FabricLimits, E.FabricLimits>>(),
  fillMethod: ok<SameUnion<U.FillMethod, E.FillMethod>>(),
  // `clockwise`: older documents' contour direction, which the engine reads and turns into contourClockwise
  fillParams: ok<SameFields<U.FillParams, E.FillParams, "clockwise">>(),
  flowField: ok<SameFields<U.FlowField, E.FlowField>>(),
  foamOptions: ok<SameFields<U.FoamOptions, E.FoamOptions>>(),
  freePoint: ok<SameFields<U.FreePoint, E.FreePoint>>(),
  gradientKind: ok<SameUnion<U.GradientKind, E.GradientKind>>(),
  gradientMesh: ok<SameFields<U.GradientMesh, E.GradientMesh>>(),
  gradientMix: ok<SameUnion<U.GradientMix, E.GradientMix>>(),
  gradientParams: ok<SameFields<U.GradientParams, E.GradientParams>>(),
  gradientStop: ok<SameFields<U.GradientStop, E.GradientStop>>(),
  hiddenRule: ok<SameFields<U.HiddenRule, E.HiddenRule>>(),
  hoop: ok<SameFields<U.Hoop, E.Hoop>>(),
  hoopShape: ok<SameUnion<U.HoopShape, E.HoopShape>>(),
  layeredOptions: ok<SameFields<U.LayeredOptions, E.LayeredOptions>>(),
  lockStyle: ok<SameUnion<U.LockStyle, E.LockStyle>>(),
  machineSettings: ok<SameFields<U.MachineSettings, E.MachineSettings>>(),
  meanderPattern: ok<SameUnion<U.MeanderPattern, E.MeanderPattern>>(),
  meshNode: ok<SameFields<U.MeshNode, E.MeshNode>>(),
  motifKind: ok<SameUnion<U.MotifKind, E.MotifKind>>(),
  objectInfo: ok<SameFields<U.ObjectInfo, E.ObjectInfo>>(),
  optimizeReport: ok<SameFields<U.OptimizeReport, E.OptimizeReport>>(),
  planStats: ok<SameFields<U.PlanStats, E.PlanStats>>(),
  rampProfile: ok<SameUnion<U.RampProfile, E.RampProfile>>(),
  rippleParams: ok<SameFields<U.RippleParams, E.RippleParams>>(),
  runningParams: ok<SameFields<U.RunningParams, E.RunningParams>>(),
  satinMethod: ok<SameUnion<U.SatinMethod, E.SatinMethod>>(),
  satinParams: ok<SameFields<U.SatinParams, E.SatinParams>>(),
  stitch_none: ok<SameFields<Extract<U.StitchParams, { type: "none" }>, Extract<E.StitchParams, { type: "none" }>>>(),
  stitch_running: ok<SameFields<Extract<U.StitchParams, { type: "running" }>, Extract<E.StitchParams, { type: "running" }>>>(),
  stitch_satin: ok<SameFields<Extract<U.StitchParams, { type: "satin" }>, Extract<E.StitchParams, { type: "satin" }>>>(),
  stitch_fill: ok<SameFields<Extract<U.StitchParams, { type: "fill" }>, Extract<E.StitchParams, { type: "fill" }>, "clockwise">>(),
  stitch_applique: ok<SameFields<Extract<U.StitchParams, { type: "applique" }>, Extract<E.StitchParams, { type: "applique" }>>>(),
  stitch_manual: ok<SameFields<Extract<U.StitchParams, { type: "manual" }>, Extract<E.StitchParams, { type: "manual" }>>>(),
  stitchPattern: ok<SameFields<U.StitchPattern, E.StitchPattern>>(),
  stitchQuality: ok<SameFields<U.StitchQuality, E.StitchQuality>>(),
  subPath: ok<SameFields<U.SubPath, E.SubPath>>(),
  tackdownKind: ok<SameUnion<U.TackdownKind, E.TackdownKind>>(),
  tartanParams: ok<SameFields<U.TartanParams, E.TartanParams>>(),
  thread: ok<SameFields<U.Thread, E.Thread>>(),
  threadSource: ok<SameFields<U.ThreadSource, E.ThreadSource>>(),
  transitionCurve: ok<SameUnion<U.TransitionCurve, E.TransitionCurve>>(),
  // the editor's own: reference pictures (never sent to the engine) and the layer groups' names and nesting
  stitchDocument: ok<SameFields<U.StitchDocument, E.Document, "references" | "groupNames" | "groupParents">>(),
  // the editor's own: the object's layer group, the lettering it belongs to, a line made by Auto-route
  designObject: ok<SameFields<U.DesignObject, E.Object, "group" | "text" | "routed">>(),
  pathNode: ok<SameFields<U.PathNode, E.Node>>(),
  densityHotspot: ok<SameFields<U.DensityHotspot, E.Hotspot>>(),
};
