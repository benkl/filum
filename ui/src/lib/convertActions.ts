// The Path menu's shape conversions as previewable plans: each builder reads
// the selection and returns what replaces which object; the Convert dialog
// previews a plan on the canvas and applies it as one undo step.
//
// Ink/Stitch counterparts: fill_to_satin, fill_to_stroke, satin_to_stroke,
// stroke_to_satin, zigzag_line_to_satin, stroke_to_lpe_satin, break_apart,
// remove_duplicated_points (lib/extensions/*.py).

import { engine } from "../engine/client";
import type { DesignObject, SatinParams, StitchDocument, StitchParams, SubPath, Vec2 } from "../types";
import { fitPath, flattenSubPath } from "./bezier";
import {
  centreLineToRails,
  DEFAULT_DEDUPE,
  DEFAULT_PATTERN,
  DEFAULT_ZIGZAG,
  duplicateNodes,
  dropNodes,
  patternSatin,
  railPath,
  satinPaths,
  zigzagToSatin,
  type DedupeOptions,
  type PatternOptions,
  type ZigzagOptions,
} from "./convert";
import { defaultStitch, uid } from "./geometry";
import { withParent } from "./groups";
import { pruneGroups } from "./layerRows";

export type ConvertId = "fillToSatin" | "fillToStroke" | "satinToStroke" | "satinToRails" | "zigzagToSatin" | "patternSatin" | "breakApart" | "dedupe";

/** What a conversion does to the document. */
export interface ConvertPlan {
  /** Object id → the objects that take its place (empty: removed; may include itself: kept). */
  replace: Record<string, DesignObject[]>;
  /** Objects selected afterwards. */
  select: string[];
  /** One line for the dialog / toast. */
  summary: string;
}

export type UnderlayPreset = "auto" | "none" | "centre" | "edges" | "full";

export interface FillToSatinOptions {
  /** Start and end at the first and last rung (Ink/Stitch "Start / end at rung"). */
  skipEndSection: boolean;
  pullComp: number;
  underlay: UnderlayPreset;
  /** none: remove fills and rungs · fills · all: keep fills and rungs · unused: keep the parts no rung crosses. */
  keep: "none" | "fills" | "all" | "unused";
}

export interface FillToStrokeOptions {
  /** Dead ends shorter than this are removed (mm). */
  deadEnd: number;
  keepOriginal: boolean;
  /** Bridge the line ends left at cut lines. */
  closeGaps: boolean;
  /** Stitch the lines as running stitch, or as satins of the shape's width. */
  output: "running" | "satin";
}

export interface ConvertOptions {
  fillToSatin: FillToSatinOptions;
  fillToStroke: FillToStrokeOptions;
  satinToStroke: { keepSatin: boolean };
  satinToRails: { width: number };
  zigzagToSatin: ZigzagOptions;
  patternSatin: PatternOptions;
  breakApart: { method: "simple" | "complex"; minArea: number };
  dedupe: DedupeOptions;
}

export const DEFAULT_CONVERT: ConvertOptions = {
  fillToSatin: { skipEndSection: false, pullComp: 0, underlay: "auto", keep: "unused" },
  fillToStroke: { deadEnd: 10, keepOriginal: false, closeGaps: false, output: "running" },
  satinToStroke: { keepSatin: false },
  satinToRails: { width: 3 },
  zigzagToSatin: DEFAULT_ZIGZAG,
  patternSatin: DEFAULT_PATTERN,
  // Ink/Stitch: 20 px² ≈ 1.4 mm²
  breakApart: { method: "simple", minArea: 1.4 },
  dedupe: DEFAULT_DEDUPE,
};

export const UNDERLAYS: [UnderlayPreset, string, Partial<SatinParams>, string][] = [
  ["auto", "Auto", { underlayAuto: true }, "Chosen by the column's width and the fabric"],
  ["none", "None", { underlayAuto: false, centerWalk: false, contourUnderlay: false, zigzagUnderlay: false }, "No underlay — thin columns"],
  ["centre", "Centre", { underlayAuto: false, centerWalk: true, contourUnderlay: false, zigzagUnderlay: false }, "Centre walk — narrow columns"],
  ["edges", "Edges", { underlayAuto: false, centerWalk: false, contourUnderlay: true, zigzagUnderlay: false }, "Contour underlay — crisp edges"],
  ["full", "Full", { underlayAuto: false, centerWalk: false, contourUnderlay: true, zigzagUnderlay: true }, "Contour + zig-zag — wide columns"],
];

// ---------------------------------------------------------------------------
// What the selection holds

export const isFillObj = (o: DesignObject) => !o.text && (o.stitch.type === "fill" || o.stitch.type === "none") && o.paths.some((sp) => sp.closed && sp.nodes.length >= 3);
export const openLines = (o: DesignObject) => o.paths.filter((sp) => sp.nodes.length >= 2 && !sp.closed);
/** Lines: running stitch (or unstitched) objects, every sub-path a line. */
export const isLineObj = (o: DesignObject) => !o.text && (o.stitch.type === "running" || o.stitch.type === "manual" || o.stitch.type === "none") && o.paths.some((sp) => sp.nodes.length >= 2);
export const isSatinObj = (o: DesignObject) => !o.text && o.stitch.type === "satin" && o.paths.some((sp) => sp.nodes.length >= 2);
/** Centre-line satins: one line (or one line per sub-path) and a width. */
export const isCentreSatin = (o: DesignObject) => isSatinObj(o) && o.stitch.type === "satin" && (o.stitch.multi || o.paths.filter((sp) => sp.nodes.length >= 2).length === 1);

/** Whether a conversion has something to work on in the selection. */
export function applies(id: ConvertId, sel: DesignObject[]): boolean {
  switch (id) {
    case "fillToSatin":
      return sel.some(isFillObj) && sel.some((o) => !isFillObj(o) && openLines(o).length > 0);
    case "fillToStroke":
    case "breakApart":
      return sel.some(isFillObj);
    case "satinToStroke":
      return sel.some(isSatinObj);
    case "satinToRails":
      return sel.some((o) => isCentreSatin(o) || isLineObj(o));
    case "zigzagToSatin":
      return sel.some((o) => !o.text && openLines(o).some((sp) => sp.nodes.length >= 4));
    case "patternSatin":
      return sel.some((o) => isLineObj(o) || isCentreSatin(o));
    case "dedupe":
      return sel.some((o) => !o.text && o.paths.length > 0);
  }
}

// ---------------------------------------------------------------------------
// Helpers

const ring = (pts: Vec2[]): SubPath => fitPath(pts, 0.02, true, 30, 0.4);
const line = (pts: Vec2[], closed = false): SubPath => fitPath(pts, 0.05, closed, 50, 0.6);
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

function derived(from: DesignObject, name: string, paths: SubPath[], stitch: StitchParams, group?: string): DesignObject {
  return {
    id: uid(),
    name,
    thread: from.thread,
    visible: true,
    locked: false,
    paths,
    stitch,
    trimAfter: false,
    stopAfter: false,
    ...(group ? { group } : from.group ? { group: from.group } : {}),
  };
}

function satinStitch(from: DesignObject, patch: Partial<SatinParams> = {}): StitchParams {
  const base = from.stitch.type === "satin" ? from.stitch : (defaultStitch("satin") as StitchParams & { type: "satin" });
  return { ...base, multi: false, guides: undefined, swapRails: false, reverse: false, ...patch, type: "satin" };
}

/** Apply a plan to a document. */
export function applyPlan(d: StitchDocument, plan: ConvertPlan): StitchDocument {
  const objects: DesignObject[] = [];
  const known = new Set(d.objects.map((o) => o.group).filter(Boolean));
  let parents = d.groupParents;
  for (const o of d.objects) {
    const r = plan.replace[o.id];
    if (!r) {
      objects.push(o);
      continue;
    }
    objects.push(...r);
    // a new group for the parts sits in the group the source was in
    if (o.group) for (const x of r) if (x.group && !known.has(x.group) && !parents?.[x.group]) parents = withParent(parents, x.group, o.group);
  }
  // groups left with one thing (or nothing) dissolve
  return pruneGroups({ ...d, objects, groupParents: parents });
}

// ---------------------------------------------------------------------------
// The conversions

interface FillToSatinOut {
  satins: { rails: [Vec2[], Vec2[]]; rungs: Vec2[][] }[];
  unused: Vec2[][][];
  used_rungs: number[];
}

/** Ink/Stitch "Fill to satin": the selected fill shapes cut into satins by the selected rung lines. */
export async function planFillToSatin(sel: DesignObject[], o: FillToSatinOptions): Promise<ConvertPlan | string> {
  const fills = sel.filter(isFillObj);
  const rungObjs = sel.filter((x) => !x.text && !fills.includes(x) && openLines(x).length > 0);
  if (!fills.length) return "Select a fill shape — its outline becomes the satin's edges";
  if (!rungObjs.length) return "Also select the rungs: lines drawn across the shape that set the stitch direction";
  const rungs = rungObjs.flatMap((x) => openLines(x).map((sp) => flattenSubPath(sp, 0.1)));
  const replace: Record<string, DesignObject[]> = {};
  const select: string[] = [];
  let satins = 0;
  let missed = 0;
  const usedAny = new Set<number>();
  const underlay = UNDERLAYS.find((u) => u[0] === o.underlay)?.[2] ?? {};
  for (const f of fills) {
    const r = await engine.convertShapes<FillToSatinOut>("fillToSatin", { paths: f.paths.filter((sp) => sp.closed), rungs, skipEndSection: o.skipEndSection });
    if (!r.satins.length) {
      missed++;
      continue;
    }
    r.used_rungs.forEach((k) => usedAny.add(k));
    const group = r.satins.length > 1 ? uid("g") : undefined;
    const made = r.satins.map((s, i) =>
      derived(
        f,
        r.satins.length > 1 ? `${f.name} satin ${i + 1}` : `${f.name} (satin)`,
        [railPath(s.rails[0]), railPath(s.rails[1]), ...s.rungs.map((g): SubPath => ({ closed: false, nodes: g.map((p) => ({ p })) }))],
        satinStitch(f, { ...underlay, pullComp: o.pullComp }),
        group,
      ),
    );
    satins += made.length;
    select.push(...made.map((m) => m.id));
    const rest: DesignObject[] = [];
    if (o.keep === "fills" || o.keep === "all") rest.push(f);
    else if (o.keep === "unused" && r.unused.length) {
      const part = { ...f, id: uid(), name: `${f.name} (not converted)`, paths: r.unused.flatMap((poly) => poly.map((rg) => ring(rg))) };
      rest.push(part);
    }
    replace[f.id] = [...rest, ...made];
  }
  if (!satins) return "No rung crosses a fill outline exactly twice — draw the rungs right across the shape";
  if (o.keep !== "all") for (const x of rungObjs) replace[x.id] = [];
  const unusedRungs = rungs.length - usedAny.size;
  return {
    replace,
    select,
    summary: `${plural(satins, "satin")} from ${plural(fills.length - missed, "fill")}${missed ? ` · ${missed} without rungs left as they are` : ""}${unusedRungs ? ` · ${plural(unusedRungs, "rung")} not crossing the outline twice` : ""}`,
  };
}

interface CentreLineOut {
  pts: Vec2[];
  widths: number[];
  closed: boolean;
}

/** Ink/Stitch "Fill to stroke": the centre lines of the selected fills (selected lines cut them first). */
export async function planFillToStroke(sel: DesignObject[], o: FillToStrokeOptions): Promise<ConvertPlan | string> {
  const fills = sel.filter(isFillObj);
  if (!fills.length) return "Select one or more fill shapes";
  const cutObjs = sel.filter((x) => !x.text && !fills.includes(x) && openLines(x).length > 0);
  const cutLines = cutObjs.flatMap((x) => openLines(x).map((sp) => flattenSubPath(sp, 0.1)));
  const replace: Record<string, DesignObject[]> = {};
  const select: string[] = [];
  let n = 0;
  for (const f of fills) {
    const lines = await engine.convertShapes<CentreLineOut[]>("centreLines", { paths: f.paths.filter((sp) => sp.closed), cutLines, deadEnd: o.deadEnd, closeGaps: o.closeGaps });
    if (!lines.length) continue;
    const group = lines.length > 1 ? uid("g") : undefined;
    const made = lines.map((l, i) => {
      const name = lines.length > 1 ? `${f.name} centre line ${i + 1}` : `${f.name} (centre line)`;
      const path = line(l.pts, l.closed);
      if (o.output === "satin") {
        const ws = [...l.widths].sort((a, b) => a - b);
        const width = Math.max(0.5, +ws[Math.floor(ws.length / 2)].toFixed(2));
        return derived(f, name, [path], satinStitch(f, { width }), group);
      }
      return derived(f, name, [path], defaultStitch("running"), group);
    });
    n += made.length;
    select.push(...made.map((m) => m.id));
    replace[f.id] = o.keepOriginal ? [f, ...made] : made;
  }
  if (!n) return "No centre line found — lower the dead-end threshold for small shapes";
  if (!o.keepOriginal) for (const x of cutObjs) replace[x.id] = [];
  return { replace, select, summary: `${plural(n, "line")}${o.output === "running" && n > 1 ? " · Path → Auto-route joins them into one" : ""}` };
}

/** Ink/Stitch "Satin to stroke": a running stitch along the middle of every selected satin. */
export async function planSatinToStroke(sel: DesignObject[], o: { keepSatin: boolean }): Promise<ConvertPlan | string> {
  const satins = sel.filter(isSatinObj);
  if (!satins.length) return "Select one or more satin columns";
  const replace: Record<string, DesignObject[]> = {};
  const select: string[] = [];
  for (const s of satins) {
    let paths: SubPath[];
    if (isCentreSatin(s)) paths = s.paths.filter((sp) => sp.nodes.length >= 2).map((sp) => ({ ...sp, nodes: sp.nodes.map((n) => ({ ...n })) }));
    else {
      const pts = await engine.convertShapes<Vec2[]>("satinCentreLine", { object: s });
      if (pts.length < 2) continue;
      paths = [line(pts)];
    }
    const run = derived(s, `${s.name} (centre run)`, paths, defaultStitch("running"));
    select.push(run.id);
    replace[s.id] = o.keepSatin ? [run, s] : [run];
  }
  if (!select.length) return "These satins have no usable rails";
  return { replace, select, summary: `${plural(select.length, "running stitch line")} along the satin centre${o.keepSatin ? " (satins kept)" : ""}` };
}

/** Ink/Stitch "Stroke to satin": centre-line satins (and lines) as two editable rails with rungs. */
export async function planSatinToRails(sel: DesignObject[], o: { width: number }): Promise<ConvertPlan | string> {
  const objs = sel.filter((x) => isCentreSatin(x) || isLineObj(x));
  if (!objs.length) return "Select centre-line satins or lines";
  const replace: Record<string, DesignObject[]> = {};
  const select: string[] = [];
  for (const x of objs) {
    const width = x.stitch.type === "satin" ? x.stitch.width : o.width;
    const subs = x.paths.filter((sp) => sp.nodes.length >= 2);
    const made: DesignObject[] = [];
    subs.forEach((sp, i) => {
      const r = centreLineToRails(sp, width);
      if (!r) return;
      made.push(derived(x, subs.length > 1 ? `${x.name} ${i + 1}` : x.name, satinPaths(r), satinStitch(x, { width })));
    });
    if (!made.length) continue;
    select.push(...made.map((m) => m.id));
    replace[x.id] = made;
  }
  if (!select.length) return "Nothing to convert";
  return { replace, select, summary: `${plural(select.length, "satin")} with editable rails — drag the rails and rungs with the node tool (A)` };
}

/** Ink/Stitch "Zig-zag line to satin". */
export async function planZigzagToSatin(sel: DesignObject[], o: ZigzagOptions): Promise<ConvertPlan | string> {
  const objs = sel.filter((x) => !x.text && openLines(x).some((sp) => sp.nodes.length >= 4));
  if (!objs.length) return "Select a zig-zag line: a line drawn back and forth between the two edges of the column";
  const replace: Record<string, DesignObject[]> = {};
  const select: string[] = [];
  for (const x of objs) {
    const lines = openLines(x).filter((sp) => sp.nodes.length >= 4);
    const made: DesignObject[] = [];
    lines.forEach((sp, i) => {
      const paths = zigzagToSatin(sp.nodes.map((n) => n.p), o);
      if (paths) made.push(derived(x, lines.length > 1 ? `${x.name} ${i + 1}` : `${x.name} (satin)`, paths, satinStitch(x)));
    });
    if (!made.length) continue;
    select.push(...made.map((m) => m.id));
    replace[x.id] = made;
  }
  if (!select.length) return "Too few points for a column";
  return { replace, select, summary: `${plural(select.length, "satin")} from zig-zag lines` };
}

/** Ink/Stitch "Stroke to live path effect satin", baked: a patterned satin along every selected line. */
export async function planPatternSatin(sel: DesignObject[], o: PatternOptions): Promise<ConvertPlan | string> {
  const objs = sel.filter((x) => isLineObj(x) || isCentreSatin(x));
  if (!objs.length) return "Select lines (running stitch) or centre-line satins";
  const replace: Record<string, DesignObject[]> = {};
  const select: string[] = [];
  for (const x of objs) {
    const subs = x.paths.filter((sp) => sp.nodes.length >= 2);
    const made: DesignObject[] = [];
    subs.forEach((sp, i) => {
      const paths = patternSatin(sp, o);
      if (paths) made.push(derived(x, subs.length > 1 ? `${x.name} ${i + 1}` : `${x.name} (${o.pattern})`, paths, satinStitch(x, { width: o.maxWidth })));
    });
    if (!made.length) continue;
    select.push(...made.map((m) => m.id));
    replace[x.id] = made;
  }
  if (!select.length) return "The lines are shorter than one repeat";
  return { replace, select, summary: `${plural(select.length, "patterned satin")}` };
}

type BreakOut = { kind: "valid" } | { kind: "removed" } | { kind: "parts"; parts: { rings: Vec2[][]; source: (number | null)[] }[] };

/** Ink/Stitch "Break apart fill objects": repair and split the selected fills. */
export async function planBreakApart(sel: DesignObject[], o: { method: "simple" | "complex"; minArea: number }): Promise<ConvertPlan | string> {
  // a gradient's, tartan's or blend's layers share one shape: split together they'd fall apart
  const fills = sel.filter((x) => isFillObj(x) && !(x.stitch.type === "fill" && (x.stitch.gradient || x.stitch.tartan || x.stitch.ramp?.group)));
  if (!fills.length) return sel.some(isFillObj) ? "Gradients, tartans and colour blends can't be broken apart: remove them first" : "Select one or more fill shapes";
  const replace: Record<string, DesignObject[]> = {};
  const select: string[] = [];
  let valid = 0;
  let removed = 0;
  let parts = 0;
  for (const f of fills) {
    const closed = f.paths.filter((sp) => sp.closed && sp.nodes.length >= 3);
    const r = await engine.convertShapes<BreakOut>("breakApart", { paths: closed, method: o.method, minArea: o.minArea });
    if (r.kind === "valid") {
      valid++;
      select.push(f.id);
      continue;
    }
    if (r.kind === "removed") {
      removed++;
      replace[f.id] = [];
      continue;
    }
    // smaller parts sew last (on top), as in Ink/Stitch
    const made = r.parts.map((p, i) => ({
      ...f,
      id: uid(),
      name: r.parts.length > 1 ? `${f.name} ${i + 1}` : f.name,
      paths: p.rings.map((rg, k) => (p.source[k] != null ? closed[p.source[k]!] : ring(rg))),
      start: undefined,
      end: undefined,
      // each part is a shape of its own (a clone's link would rebuild it whole)
      clone: undefined,
    }));
    parts += made.length;
    select.push(...made.map((m) => m.id));
    replace[f.id] = made;
  }
  if (!parts && !removed) return `Nothing to repair: ${valid === 1 ? "the shape is" : "the shapes are"} already one valid outline with holes`;
  return {
    replace,
    select,
    summary: [parts ? `${plural(parts, "shape")}` : "", removed ? `${removed} too small, removed` : "", valid ? `${valid} already valid` : ""].filter(Boolean).join(" · "),
  };
}

/** Ink/Stitch "Remove duplicated points". Two-rail satins drop only node pairs, so their rungs stay matched. */
export async function planDedupe(sel: DesignObject[], o: DedupeOptions): Promise<ConvertPlan | string> {
  const objs = sel.filter((x) => !x.text);
  if (!objs.length) return "Select one or more shapes";
  const replace: Record<string, DesignObject[]> = {};
  let removed = 0;
  for (const x of objs) {
    let paths = x.paths;
    const rails = x.stitch.type === "satin" && !x.stitch.multi && x.paths.length === 2 && x.paths[0].nodes.length === x.paths[1].nodes.length;
    if (rails) {
      const [a, b] = x.paths.map((sp) => new Set(duplicateNodes(sp, o)));
      const both = [...a].filter((i) => b.has(i));
      if (both.length && x.paths[0].nodes.length - both.length >= 2) {
        paths = x.paths.map((sp) => dropNodes(sp, both));
        removed += both.length * 2;
      }
    } else {
      paths = x.paths.map((sp) => {
        const drop = duplicateNodes(sp, o);
        if (!drop.length || sp.nodes.length - drop.length < 2) return sp;
        removed += drop.length;
        return dropNodes(sp, drop);
      });
    }
    if (paths !== x.paths && paths.some((sp, i) => sp !== x.paths[i])) replace[x.id] = [{ ...x, paths }];
  }
  if (!removed) return "No duplicated points";
  return { replace, select: objs.map((x) => x.id), summary: `${plural(removed, "duplicated point")} removed` };
}

export function planConversion(id: ConvertId, sel: DesignObject[], opts: ConvertOptions): Promise<ConvertPlan | string> {
  switch (id) {
    case "fillToSatin":
      return planFillToSatin(sel, opts.fillToSatin);
    case "fillToStroke":
      return planFillToStroke(sel, opts.fillToStroke);
    case "satinToStroke":
      return planSatinToStroke(sel, opts.satinToStroke);
    case "satinToRails":
      return planSatinToRails(sel, opts.satinToRails);
    case "zigzagToSatin":
      return planZigzagToSatin(sel, opts.zigzagToSatin);
    case "patternSatin":
      return planPatternSatin(sel, opts.patternSatin);
    case "breakApart":
      return planBreakApart(sel, opts.breakApart);
    case "dedupe":
      return planDedupe(sel, opts.dedupe);
  }
}
