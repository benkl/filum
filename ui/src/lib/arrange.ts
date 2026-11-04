// Arranging and object commands: align / distribute, mirror,
// wreath and kaleidoscope copies, mirror-merge, copy / paste stitch
// properties, select similar, colour blending, appliqué and outlines.
// A lettering (objects sharing a text group) always acts as one unit.

import { engine } from "../engine/client";
import { useStore } from "../store";
import type { DesignObject, StitchDocument, StitchParams, SubPath, Vec2 } from "../types";
import { defaultApplique, defaultFill, defaultRunning, defaultSatin, normAngle, objectBounds, rotateAbout, scaleAbout, transformObject, translateMat, uid, unionBoxes, type Box } from "./geometry";

type Mat = [number, number, number, number, number, number];

const store = () => useStore.getState();

/** Selected objects grouped into units (a lettering is one unit). */
function units(doc: StitchDocument, ids: string[]): DesignObject[][] {
  const out = new Map<string, DesignObject[]>();
  for (const o of doc.objects) {
    if (!ids.includes(o.id) || o.locked) continue;
    const k = o.group ?? o.text?.group ?? o.id;
    if (!out.has(k)) out.set(k, []);
    out.get(k)!.push(o);
  }
  return [...out.values()];
}

const boxOf = (objs: DesignObject[]) => unionBoxes(objs.map(objectBounds));

function applyToUnits(moves: Map<DesignObject[], Mat>, label: string) {
  const s = store();
  const byId = new Map<string, Mat>();
  for (const [u, m] of moves) for (const o of u) byId.set(o.id, m);
  if (!byId.size) return;
  s.commit((d) => ({ ...d, objects: d.objects.map((o) => (byId.has(o.id) ? transformObject(o, byId.get(o.id)!) : o)) }));
  void label;
}

// ---------------------------------------------------------------------------
// Align & distribute

export type AlignMode = "left" | "hcenter" | "right" | "top" | "vcenter" | "bottom";

/**
 * Align the selected units. With one unit (or `toHoop`) they align to the
 * hoop, otherwise to the selection's bounding box.
 */
export function align(mode: AlignMode, toHoop = false) {
  const s = store();
  const us = units(s.doc, s.selection);
  if (!us.length) return;
  const ref: Box = toHoop || us.length === 1 ? { x: 0, y: 0, w: s.doc.hoop.width, h: s.doc.hoop.height } : boxOf(us.flat())!;
  const moves = new Map<DesignObject[], Mat>();
  for (const u of us) {
    const b = boxOf(u);
    if (!b) continue;
    let dx = 0;
    let dy = 0;
    if (mode === "left") dx = ref.x - b.x;
    if (mode === "hcenter") dx = ref.x + ref.w / 2 - (b.x + b.w / 2);
    if (mode === "right") dx = ref.x + ref.w - (b.x + b.w);
    if (mode === "top") dy = ref.y - b.y;
    if (mode === "vcenter") dy = ref.y + ref.h / 2 - (b.y + b.h / 2);
    if (mode === "bottom") dy = ref.y + ref.h - (b.y + b.h);
    if (Math.abs(dx) > 1e-9 || Math.abs(dy) > 1e-9) moves.set(u, translateMat(dx, dy) as Mat);
  }
  applyToUnits(moves, "Align");
}

/** Equal gaps between the selected units (needs three or more). */
export function distribute(axis: "h" | "v") {
  const s = store();
  const us = units(s.doc, s.selection)
    .map((u) => ({ u, b: boxOf(u)! }))
    .filter((x) => x.b);
  if (us.length < 3) {
    s.toast("Select three or more objects to distribute");
    return;
  }
  const pos = (b: Box) => (axis === "h" ? b.x : b.y);
  const size = (b: Box) => (axis === "h" ? b.w : b.h);
  us.sort((a, b) => pos(a.b) - pos(b.b));
  const first = us[0].b;
  const last = us[us.length - 1].b;
  const total = pos(last) + size(last) - pos(first);
  const gap = (total - us.reduce((n, x) => n + size(x.b), 0)) / (us.length - 1);
  const moves = new Map<DesignObject[], Mat>();
  let cursor = pos(first);
  for (const { u, b } of us) {
    const d = cursor - pos(b);
    if (Math.abs(d) > 1e-9) moves.set(u, (axis === "h" ? translateMat(d, 0) : translateMat(0, d)) as Mat);
    cursor += size(b) + gap;
  }
  applyToUnits(moves, "Distribute");
}

// ---------------------------------------------------------------------------
// Mirror, wreath, kaleidoscope, mirror-merge

/** Reflection across the line through `c` at `deg` degrees. */
function reflectMat(c: Vec2, deg: number): Mat {
  const t = (2 * deg * Math.PI) / 180;
  const [a, b, d] = [Math.cos(t), Math.sin(t), -Math.cos(t)];
  // x' = a·(x−cx) + b·(y−cy) + cx ; y' = b·(x−cx) + d·(y−cy) + cy
  return [a, b, b, d, c[0] - a * c[0] - b * c[1], c[1] - b * c[0] - d * c[1]];
}

function rotateMat(c: Vec2, deg: number): Mat {
  const r = (deg * Math.PI) / 180;
  const [co, si] = [Math.cos(r), Math.sin(r)];
  return [co, si, -si, co, c[0] - co * c[0] + si * c[1], c[1] - si * c[0] - co * c[1]];
}

const det = (m: Mat) => m[0] * m[3] - m[1] * m[2];

/**
 * Transform a copy of an object. Mirroring flips the fill angle and turns a
 * lettering into plain shapes (letters can't be mirrored and stay text).
 */
function transformedCopy(o: DesignObject, m: Mat, rotationDeg: number, groupMap: Map<string, string>, axisDeg = 0): DesignObject {
  let c = transformObject({ ...o, id: uid() }, m, rotationDeg);
  if (det(m) < 0) {
    // a reflection across an axis at θ turns a fill angle a into −a − 2θ
    if (c.stitch.type === "fill") c = { ...c, stitch: { ...c.stitch, angle: normAngle(-c.stitch.angle - 2 * axisDeg) } };
    if (c.text) c = { ...c, text: undefined };
  } else if (c.text) {
    let g = groupMap.get(c.text.group);
    if (!g) groupMap.set(c.text.group, (g = uid("txt")));
    c = { ...c, text: { ...c.text, group: g } };
  }
  return c;
}

/** Mirror the selection in place. */
export function mirrorSelection(axis: "h" | "v") {
  const s = store();
  const sel = s.doc.objects.filter((o) => s.selection.includes(o.id) && !o.locked);
  const b = boxOf(sel);
  if (!b) return;
  const m = (axis === "h" ? scaleAbout(-1, 1, b.x + b.w / 2, b.y + b.h / 2) : scaleAbout(1, -1, b.x + b.w / 2, b.y + b.h / 2)) as Mat;
  const groups = new Map<string, string>();
  s.commit((d) => ({
    ...d,
    objects: d.objects.map((o) => {
      if (!sel.includes(o)) return o;
      const c = transformedCopy(o, m, 0, groups, axis === "h" ? 90 : 0);
      return { ...c, id: o.id };
    }),
  }));
}

export type RepeatMode = "wreath" | "kaleidoscope" | "mirrorH" | "mirrorV" | "mirrorHV";

export interface RepeatOptions {
  mode: RepeatMode;
  copies: number;
  /** Centre of the arrangement. */
  center: Vec2;
}

/** The transforms (besides the identity) a repeat creates. */
export function repeatTransforms(opt: RepeatOptions): { m: Mat; rot: number; axis: number }[] {
  const c = opt.center;
  const n = Math.max(2, Math.round(opt.copies));
  const out: { m: Mat; rot: number; axis: number }[] = [];
  const mirror = (axis: number) => out.push({ m: reflectMat(c, axis), rot: 0, axis });
  if (opt.mode === "wreath" || opt.mode === "kaleidoscope") {
    for (let k = 1; k < n; k++) out.push({ m: rotateMat(c, (360 * k) / n), rot: (360 * k) / n, axis: 0 });
    // mirror images across the axes between the copies (dihedral symmetry)
    if (opt.mode === "kaleidoscope") for (let k = 0; k < n; k++) mirror(90 + (180 * k) / n);
  } else {
    if (opt.mode === "mirrorH" || opt.mode === "mirrorHV") mirror(90);
    if (opt.mode === "mirrorV" || opt.mode === "mirrorHV") mirror(0);
    if (opt.mode === "mirrorHV") out.push({ m: rotateMat(c, 180), rot: 180, axis: 0 });
  }
  return out;
}

/** Copies of the selection arranged around a centre (wreath / kaleidoscope / mirror-merge). */
export function repeatSelection(opt: RepeatOptions): number {
  const s = store();
  const sel = s.doc.objects.filter((o) => s.selection.includes(o.id));
  if (!sel.length) return 0;
  const created: DesignObject[] = [];
  for (const { m, rot, axis } of repeatTransforms(opt)) {
    const groups = new Map<string, string>();
    for (const o of sel) created.push(transformedCopy(o, m, rot, groups, axis));
  }
  s.commit((d) => ({ ...d, objects: [...d.objects, ...created] }));
  s.select([...sel.map((o) => o.id), ...created.map((o) => o.id)]);
  return created.length;
}

// ---------------------------------------------------------------------------
// Properties clipboard and select similar

let clip: { stitch: StitchParams; thread: string } | null = null;

export const hasCopiedProperties = () => !!clip;

export function copyProperties() {
  const s = store();
  const o = s.doc.objects.find((x) => x.id === s.selection[0]);
  if (!o) return;
  clip = { stitch: structuredClone(o.stitch), thread: o.thread };
  s.toast(`Copied ${o.stitch.type} settings of “${o.name}”`);
}

const hasClosed = (o: DesignObject) => o.paths.some((p) => p.closed && p.nodes.length >= 3);

/** Apply the copied stitch settings (and optionally the colour) to the selection. */
export function pasteProperties(withColor = false) {
  const s = store();
  if (!clip) return s.toast("Copy an object's properties first");
  const c = clip;
  let n = 0;
  let skipped = 0;
  s.commit((d) => ({
    ...d,
    objects: d.objects.map((o) => {
      if (!s.selection.includes(o.id) || o.locked || o.text) return o;
      if ((c.stitch.type === "fill" || c.stitch.type === "applique") && !hasClosed(o)) {
        skipped++;
        return o;
      }
      n++;
      let stitch = structuredClone(c.stitch);
      // a satin keeps its own width when it is a centre line
      if (stitch.type === "satin" && o.stitch.type === "satin" && o.paths.length === 1) stitch = { ...stitch, width: o.stitch.width };
      return { ...o, stitch, ...(withColor ? { thread: c.thread } : {}) };
    }),
  }));
  s.toast(`Applied to ${n} object${n === 1 ? "" : "s"}${skipped ? ` · ${skipped} open path${skipped > 1 ? "s" : ""} skipped` : ""}`);
}

export function selectSimilar(by: "color" | "type" | "both") {
  const s = store();
  const ref = s.doc.objects.find((x) => x.id === s.selection[0]);
  if (!ref) return;
  const ids = s.doc.objects
    .filter((o) => o.visible && !o.locked)
    .filter((o) => (by !== "type" ? o.thread === ref.thread : true) && (by !== "color" ? o.stitch.type === ref.stitch.type : true))
    .map((o) => o.id);
  s.select(ids);
  s.toast(`${ids.length} object${ids.length === 1 ? "" : "s"} selected`);
}

// ---------------------------------------------------------------------------
// Appliqué, outlines (colour blending: the gradient tool, lib/ramp.ts)

/** Turn the selected closed shapes into appliqués (automatic appliqué). */
export function makeApplique() {
  const s = store();
  const ids = s.doc.objects.filter((o) => s.selection.includes(o.id) && !o.text && hasClosed(o)).map((o) => o.id);
  if (!ids.length) return s.toast("Select a closed shape (fill or outline) to turn into an appliqué");
  s.commit((d) => ({
    ...d,
    objects: d.objects.map((o) =>
      ids.includes(o.id)
        ? { ...o, paths: o.paths.filter((p) => p.closed && p.nodes.length >= 3), stitch: { type: "applique", ...defaultApplique() } }
        : o,
    ),
  }));
  s.toast(`${ids.length} appliqué${ids.length > 1 ? "s" : ""}: placement → stop → tack-down → stop → cover`, "success");
}

export type OutlineKind = "running" | "triple" | "satin" | "fill" | "applique";

export interface OutlineOptions {
  offset: number;
  kind: OutlineKind;
  width: number;
  thread: string;
  /** Behind the selection (sewn first) or on top. */
  behind: boolean;
  /** Join pieces closer than twice this and fill narrow notches (mm; 0 = follow every gap). */
  bridge?: number;
  /** Only the outer edge — no outlines around holes. */
  outerOnly?: boolean;
}

/** Pieces and holes smaller than this (mm²) are not outlined: too small to sew. */
const MIN_OUTLINE_AREA = 1;

/**
 * The outline object for objects `ids` (outlines & offsets;
 * patch borders: bridge gaps, outer edge only). Null when there is nothing to outline.
 */
export async function outlineObject(doc: StitchDocument, ids: string[], opt: OutlineOptions): Promise<DesignObject | null> {
  if (!ids.length) return null;
  const shapes: SubPath[] = await engine.outlineShapes(doc, ids, opt.offset, { bridge: opt.bridge ?? 0, outerOnly: !!opt.outerOnly, minArea: MIN_OUTLINE_AREA });
  if (!shapes.length) return null;
  const stitch: StitchParams =
    opt.kind === "fill"
      ? { type: "fill", ...defaultFill() }
      : opt.kind === "applique"
        ? { type: "applique", ...defaultApplique(), coverWidth: opt.width }
        : opt.kind === "satin"
          ? { type: "satin", ...defaultSatin(), width: opt.width, multi: true }
          : { type: "running", ...defaultRunning(), beanRepeats: opt.kind === "triple" ? 2 : 0 };
  const name = { running: "Outline", triple: "Outline", satin: "Border", fill: "Backing", applique: "Appliqué" }[opt.kind];
  return {
    id: uid(),
    name: `${name} ${opt.offset >= 0 ? "+" : ""}${opt.offset} mm`,
    thread: opt.thread,
    visible: true,
    locked: false,
    paths: shapes,
    stitch,
    trimAfter: false,
    stopAfter: false,
  };
}

/** The design with the outline object placed behind (sewn first) or on top of objects `ids`. */
export function withOutline(d: StitchDocument, ids: string[], o: DesignObject, behind: boolean): StitchDocument {
  const idx = d.objects.map((x, i) => (ids.includes(x.id) ? i : -1)).filter((i) => i >= 0);
  if (!idx.length) return d;
  const at = behind ? Math.min(...idx) : Math.max(...idx) + 1;
  const objects = [...d.objects];
  objects.splice(at, 0, o);
  return { ...d, objects };
}

/** Create the outline around the selection (one undo step). Returns its number of rings. */
export async function createOutline(opt: OutlineOptions): Promise<number> {
  const s = store();
  const ids = s.selection;
  const o = await outlineObject(s.doc, ids, opt);
  if (!o) {
    s.toast("Nothing to outline", "error");
    return 0;
  }
  store().commit((d) => withOutline(d, ids, o, opt.behind));
  store().select([o.id]);
  return o.paths.length;
}

/** Stitch counts with and without hidden-stitch removal (for the savings readout). */
export async function overlapSavings(doc: StitchDocument): Promise<{ before: number; after: number }> {
  const on = { ...doc, options: { ...(doc.options ?? {}), removeOverlaps: true } } as StitchDocument;
  const off = { ...doc, options: { ...(doc.options ?? {}), removeOverlaps: false } } as StitchDocument;
  const [a, b] = await Promise.all([engine.planDetached(off), engine.planDetached(on)]);
  return { before: a.stats.stitches, after: b.stats.stitches };
}

// ---------------------------------------------------------------------------
// Groups and shape booleans

/** Group the selection: it is then picked, moved and transformed as one (Ctrl+G). */
export function groupSelection() {
  const s = store();
  if (s.selection.length < 2) return s.toast("Select two or more objects to group");
  const g = uid("g");
  s.commit((d) => ({ ...d, objects: d.objects.map((o) => (s.selection.includes(o.id) ? { ...o, group: g } : o)) }));
  s.toast(`Grouped ${s.selection.length} objects · Ctrl-click picks one inside`);
}

/** Ungroup (Ctrl+Shift+G). Gradient colour layers stay one gradient. */
export function ungroupSelection() {
  const s = store();
  let n = 0;
  s.commit((d) => ({
    ...d,
    objects: d.objects.map((o) => {
      if (!s.selection.includes(o.id) || !o.group) return o;
      if (o.stitch.type === "fill" && o.stitch.gradient?.group === o.group) return o;
      n++;
      return { ...o, group: undefined };
    }),
  }));
  if (!n) s.toast("Nothing to ungroup");
}

export type ShapeBooleanOp = "unite" | "minusFront" | "intersect" | "exclude";

/**
 * Shape booleans on the selected objects (their stitched areas).
 * The result replaces them; Minus front keeps the bottom object's style,
 * the others keep the top object's.
 */
export async function combineShapes(op: ShapeBooleanOp) {
  const s = store();
  const sel = s.doc.objects.filter((o) => s.selection.includes(o.id) && !o.locked);
  if (sel.length < 2) return s.toast("Select two or more shapes");
  const shapes = await engine.booleanShapes(s.doc, sel.map((o) => o.id), op);
  if (!shapes.length) return s.toast("The result is empty", "error");
  const style = op === "minusFront" ? sel[0] : sel[sel.length - 1];
  const stitch: StitchParams =
    style.stitch.type === "fill" ? { ...style.stitch, gradient: undefined } : style.stitch.type === "applique" ? style.stitch : { type: "fill", ...defaultFill() };
  const label = { unite: "Unite", minusFront: "Minus front", intersect: "Intersect", exclude: "Exclude" }[op];
  const result: DesignObject = {
    id: uid(),
    name: `${style.name.replace(/ · colour \d+$/, "")} (${label.toLowerCase()})`,
    thread: style.thread,
    visible: true,
    locked: false,
    paths: shapes,
    stitch,
    trimAfter: false,
    stopAfter: false,
  };
  const st = store();
  const ids = new Set(sel.map((o) => o.id));
  st.commit((d) => {
    const at = d.objects.findIndex((o) => ids.has(o.id));
    const rest = d.objects.filter((o) => !ids.has(o.id));
    return { ...d, objects: [...rest.slice(0, at), result, ...rest.slice(at)] };
  });
  st.select([result.id]);
  st.toast(`${label}: ${shapes.length} part${shapes.length > 1 ? "s" : ""}`, "success");
}

// ---- stitch order, rotation, visibility, clipboard -------------------------

/** Move the selection in the stitch order: front = sewn last (on top). */
export function orderSelection(kind: "front" | "forward" | "backward" | "back") {
  const s = store();
  const sel = new Set(s.selection);
  if (!sel.size) return;
  s.commit((d) => {
    const picked = d.objects.filter((o) => sel.has(o.id));
    const rest = d.objects.filter((o) => !sel.has(o.id));
    if (kind === "front") return { ...d, objects: [...rest, ...picked] };
    if (kind === "back") return { ...d, objects: [...picked, ...rest] };
    // one place: each selected object past its unselected neighbour
    const objs = d.objects.slice();
    if (kind === "forward") {
      for (let i = objs.length - 2; i >= 0; i--) if (sel.has(objs[i].id) && !sel.has(objs[i + 1].id)) [objs[i], objs[i + 1]] = [objs[i + 1], objs[i]];
    } else {
      for (let i = 1; i < objs.length; i++) if (sel.has(objs[i].id) && !sel.has(objs[i - 1].id)) [objs[i], objs[i - 1]] = [objs[i - 1], objs[i]];
    }
    return { ...d, objects: objs };
  });
}

/** Rotate the selection about its centre (90° steps keep satins and fills crisp). */
export function rotateSelection(deg: number) {
  const s = store();
  const sel = s.doc.objects.filter((o) => s.selection.includes(o.id) && !o.locked);
  const b = boxOf(sel);
  if (!b) return;
  const m = rotateAbout(deg, b.x + b.w / 2, b.y + b.h / 2);
  const ids = new Set(sel.map((o) => o.id));
  s.commit((d) => ({ ...d, objects: d.objects.map((o) => (ids.has(o.id) ? transformObject(o, m, deg) : o)) }));
}

/** Hide the selection (it is not sewn either) — or show everything again. */
export function hideSelection() {
  const s = store();
  const ids = new Set(s.selection);
  if (!ids.size) return;
  s.commit((d) => ({ ...d, objects: d.objects.map((o) => (ids.has(o.id) ? { ...o, visible: false } : o)) }));
  s.select([]);
  s.toast(`Hidden ${ids.size} object${ids.size === 1 ? "" : "s"} · Object ▸ Show all brings them back`);
}
export function showAll() {
  const s = store();
  const hidden = s.doc.objects.filter((o) => !o.visible).map((o) => o.id);
  if (!hidden.length) return;
  s.commit((d) => ({ ...d, objects: d.objects.map((o) => (o.visible ? o : { ...o, visible: true })) }));
  s.select(hidden);
}
/** Lock the selection (it can't be selected on the canvas) — or unlock everything. */
export function lockSelection() {
  const s = store();
  const ids = new Set(s.selection);
  if (!ids.size) return;
  s.commit((d) => ({ ...d, objects: d.objects.map((o) => (ids.has(o.id) ? { ...o, locked: true } : o)) }));
  s.select([]);
}
export function unlockAll() {
  const s = store();
  const locked = s.doc.objects.filter((o) => o.locked).map((o) => o.id);
  if (!locked.length) return;
  s.commit((d) => ({ ...d, objects: d.objects.map((o) => (o.locked ? { ...o, locked: false } : o)) }));
  s.select(locked);
}

/** Objects on the clipboard (with their threads); also put on the system clipboard as text. */
const CLIP_TAG = "filum/objects:";
let objectClip: { objects: DesignObject[]; threads: StitchDocument["threads"] } | null = null;
let pastes = 0;

/** The selection as clipboard text (and remembered for Paste). */
export function copySelection(cut = false): string | null {
  const s = store();
  const objects = s.doc.objects.filter((o) => s.selection.includes(o.id));
  if (!objects.length) return null;
  const used = new Set(objects.map((o) => o.thread));
  objectClip = { objects: structuredClone(objects), threads: s.doc.threads.filter((t) => used.has(t.id)) };
  pastes = 0;
  if (cut) {
    s.deleteSelection();
    s.toast(`Cut ${objects.length} object${objects.length === 1 ? "" : "s"}`);
  }
  return CLIP_TAG + JSON.stringify(objectClip);
}

/** Read clipboard text written by copySelection (another window, another design). */
export function clipFromText(text: string | undefined | null): boolean {
  if (!text?.startsWith(CLIP_TAG)) return false;
  try {
    const c = JSON.parse(text.slice(CLIP_TAG.length));
    if (!Array.isArray(c.objects)) return false;
    if (!objectClip || JSON.stringify(objectClip) !== JSON.stringify(c)) pastes = 0;
    objectClip = c;
    return true;
  } catch {
    return false;
  }
}

export const hasClipboard = () => !!objectClip?.objects.length;

/** Paste the clipboard: new objects, 5 mm further on every paste (in place: where they were). */
export function pasteClipboard(inPlace = false) {
  const s = store();
  if (!objectClip?.objects.length) return;
  const off = inPlace ? 0 : 5 * ++pastes;
  const m = translateMat(off, off);
  // pasted groups and lettering are new groups of their own
  const groups = new Map<string, string>();
  const regroup = (g: string | undefined, prefix: string) => {
    if (!g) return g;
    if (!groups.has(prefix + g)) groups.set(prefix + g, uid(prefix));
    return groups.get(prefix + g);
  };
  const ids = new Set(s.doc.objects.map((o) => o.id));
  const copies = objectClip.objects.map((o) => {
    const c = transformObject(structuredClone(o), m, 0);
    return {
      ...c,
      id: uid(),
      group: regroup(c.group, "g"),
      text: c.text ? { ...c.text, group: regroup(c.text.group, "txt")! } : undefined,
      // a clone keeps its link only to an original in this design
      clone: c.clone && ids.has(c.clone.of) ? c.clone : undefined,
    };
  });
  s.addObjects(copies, objectClip.threads);
  s.select(copies.map((c) => c.id));
}
