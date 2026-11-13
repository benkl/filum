import { objectBoundsCached, objectOutline, objectPath, pathsToPath2D, shade, unionBoxes, type Box } from "../lib/geometry";
import type { DensityField, DesignObject, NodeRef, PlanData, ReferenceImage, StitchDocument, SubPath, ThreadWeight, Vec2, ViewMode } from "../types";
import { referenceBitmap, referencesLoaded, refCorners, refRotateKnob } from "../lib/references";
import { FLAG } from "../types";
import type { View } from "../store";
import { threadWidth } from "../lib/materials";
import { paintInteractive, paintUnderlays, type InteractiveOverlay } from "./interactive";
import { colourGroup, groupPicture } from "./vectorGradient";
import { transformable } from "../lib/textSettle";
import type { DensityMode } from "../lib/density";

// Rendering model
// ---------------
// The stitch plan is split once per plan into fixed *chunks* (CHUNK needle
// penetrations, never spanning a colour change), each with a prebuilt Path2D.
// Chunks are always painted with the full shading passes in sewing order, so
// a chunk is the unit of layering for both the still image and the stitch-out
// animation — the two are pixel-identical.
//
// The renderer keeps a *base layer* (an offscreen canvas holding background,
// grid, hoop and every completed chunk). Each frame it only:
//   1. paints chunks completed since the last frame onto the base layer,
//   2. blits the base layer,
//   3. paints the single in-progress chunk (≤ CHUNK stitches) on top,
//   4. paints overlays (needle, selection, tool feedback, rulers).
// So an animation frame costs O(new stitches + CHUNK) instead of O(all stitches),
// and hover/marquee/selection redraws never touch the stitches at all.

export const RULER = 22;
export const CHUNK = 384;

export interface Overlay {
  marquee?: Box | null;
  shape?: { kind: "rect" | "ellipse"; box: Box; path?: SubPath } | null;
  ruler?: { a: Vec2; b: Vec2 } | null;
  nodes?: boolean;
  /** Selected nodes (node tool). */
  nodeSel?: NodeRef[];
  /** Node marquee (node tool). */
  nodeMarquee?: Box | null;
  /** Reference picture being adjusted. */
  refEdit?: string | null;
  /** Snap target of the pen (an existing point). */
  snap?: Vec2 | null;
  /** Density ramp being dragged out (gradient tool). */
  rampDraft?: { a: Vec2; b: Vec2 } | null;
  /** Direction guide being drawn (stitch direction tool). */
  guideDraft?: [Vec2, Vec2] | null;
  /** Density ramp of the selection: its vector and where the rows fall (per layer). */
  ramp?: { from: Vec2; to: Vec2; combs: { rows: number[]; color: string; side: number }[]; draft: boolean } | null;
  /** Shape Builder: the overlap regions, the one under the pointer, the ones dragged across. */
  builder?: { faces: [number, number][][][]; hover: number | null; picked: number[]; del: boolean } | null;
  /** Satin direction guides of the selected satin, the one under the pointer and a draft. */
  guides?: { lines: [Vec2, Vec2][]; hover: number | null; draft: [Vec2, Vec2] | null } | null;
  hoverId?: string | null;
}

export interface Theme {
  canvas: string;
  grid: string;
  gridStrong: string;
  axis: string;
  ruler: string;
  rulerText: string;
  rulerLine: string;
  hoop: string;
  select: string;
  dark: boolean;
}

export function readTheme(el: HTMLElement): Theme {
  const cs = getComputedStyle(el);
  const v = (n: string) => cs.getPropertyValue(n).trim();
  return {
    canvas: v("--canvas"),
    grid: v("--grid"),
    gridStrong: v("--grid-strong"),
    axis: v("--axis"),
    ruler: v("--ruler"),
    rulerText: v("--ruler-text"),
    rulerLine: v("--ruler-line"),
    hoop: v("--hoop"),
    select: v("--select"),
    dark: v("--is-dark") === "1",
  };
}

export interface RenderInput {
  doc: StitchDocument;
  plan: PlanData | null;
  view: View;
  mode: ViewMode;
  selection: string[];
  theme: Theme;
  overlay: Overlay;
  showGrid: boolean;
  /** Grid spacing (mm; 0 = automatic 5 / 10 mm), e.g. the cross stitch cells. */
  gridStep?: number;
  showJumps: boolean;
  showUnderlay: boolean;
  /** What hidden-stitch removal takes out: the cut objects as they are stitched. */
  hiddenShapes?: { index: number; paths: SubPath[] }[] | null;
  animIndex: number | null;
  fabricColor: string;
  width: number;
  height: number;
  dpr: number;
  /** Stitches are drawn by the WebGL renderer: paint background/overlays only. */
  glStitches?: boolean;
  /** Handles, satin drafting, cutter, troubleshoot markers, tooltip. */
  interactive?: InteractiveOverlay;
  showDensity?: boolean;
  density?: DensityField | null;
  densityMode?: DensityMode;
  /** A drag transforming objects (their stitches follow it until the plan does). */
  live?: { ids: string[]; m: number[] } | null;
  /** A preview of a design outside the editor (dialogs): no rulers, no hoop. */
  preview?: boolean;
  /** Where the fabric lies (mm) when it is not the hoop (previews). */
  fabricArea?: Box;
  /** The fabric also in the vector and stitch views (flat colour; default on). */
  fabricAll?: boolean;
}

// ---------------------------------------------------------------------------
// Chunked stitch geometry

interface Chunk {
  start: number; // first record index (inclusive)
  end: number; // last record index (exclusive)
  /** Colour block (thread) index: chunks of one block are shaded together. */
  block: number;
  color: string;
  /** The thread's own weight (No. 40 …), when it has one. */
  weight?: number;
  penIn: boolean; // pen state entering the chunk
  x: number; // needle position entering the chunk
  y: number;
  path: Path2D;
  jumps: Path2D;
  dots: Float32Array; // penetration coordinates (for zoomed-in stitch view)
  /** Bounding box of everything the chunk draws (mm), for viewport culling. */
  bx0: number;
  by0: number;
  bx1: number;
  by1: number;
}

interface Traced {
  path: Path2D;
  jumps: Path2D;
  dots: number[];
  pen: boolean;
  x: number;
  y: number;
  bbox: [number, number, number, number];
}

/** Trace records [start, end) into paths. Mirrors exactly what chunk building does. */
function trace(plan: PlanData, start: number, end: number, pen: boolean, x: number, y: number, showUnderlay: boolean, wantDots: boolean): Traced {
  const { coords, flags } = plan;
  // jumps the machine doesn't cut stay on the fabric: drawn as thread
  const uncut = plan.uncut?.mask;
  const hide = plan.hide;
  const path = new Path2D();
  const jumps = new Path2D();
  const dots: number[] = [];
  let bx0 = Infinity;
  let by0 = Infinity;
  let bx1 = -Infinity;
  let by1 = -Infinity;
  const inc = (px: number, py: number) => {
    if (px < bx0) bx0 = px;
    if (py < by0) by0 = py;
    if (px > bx1) bx1 = px;
    if (py > by1) by1 = py;
  };
  if (pen) {
    path.moveTo(x, y);
    inc(x, y);
  }
  for (let i = start; i < end; i++) {
    const f = flags[i];
    const nx = coords[i * 2];
    const ny = coords[i * 2 + 1];
    if (hide?.[i]) {
      pen = false;
      x = nx;
      y = ny;
      continue;
    }
    if (f & (FLAG.COLOR_CHANGE | FLAG.TRIM | FLAG.STOP | FLAG.END)) {
      if (!uncut?.[i]) pen = false;
      continue;
    }
    if (f & FLAG.JUMP && uncut?.[i]) {
      if (!pen) path.moveTo(x, y);
      path.lineTo(nx, ny);
      inc(x, y);
      inc(nx, ny);
      pen = true;
      x = nx;
      y = ny;
      continue;
    }
    if (f & FLAG.JUMP) {
      jumps.moveTo(x, y);
      jumps.lineTo(nx, ny);
      inc(x, y);
      inc(nx, ny);
      pen = false;
      x = nx;
      y = ny;
      continue;
    }
    if (!showUnderlay && f & FLAG.UNDERLAY) {
      pen = false;
      x = nx;
      y = ny;
      continue;
    }
    if (pen) path.lineTo(nx, ny);
    else path.moveTo(nx, ny);
    inc(nx, ny);
    if (wantDots) dots.push(nx, ny);
    pen = true;
    x = nx;
    y = ny;
  }
  return { path, jumps, dots, pen, x, y, bbox: [bx0, by0, bx1, by1] };
}

// one entry per plan object (the editor and dialog previews keep their own)
const chunkCache = new WeakMap<PlanData, Map<boolean, Chunk[]>>();

export function getChunks(plan: PlanData, showUnderlay: boolean): Chunk[] {
  const cached = chunkCache.get(plan)?.get(showUnderlay);
  if (cached) return cached;
  const { flags, threads } = plan;
  const n = flags.length;
  const chunks: Chunk[] = [];
  let block = 0;
  let pen = false;
  let x = 0;
  let y = 0;
  let start = 0;
  let count = 0;
  const close = (end: number) => {
    if (end <= start) return;
    const t = trace(plan, start, end, pen, x, y, showUnderlay, true);
    chunks.push({
      start,
      end,
      block,
      color: threads[block]?.color ?? "#222",
      weight: threads[block]?.weight,
      penIn: pen,
      x,
      y,
      path: t.path,
      jumps: t.jumps,
      dots: new Float32Array(t.dots),
      bx0: t.bbox[0],
      by0: t.bbox[1],
      bx1: t.bbox[2],
      by1: t.bbox[3],
    });
    pen = t.pen;
    x = t.x;
    y = t.y;
    start = end;
    count = 0;
  };
  for (let i = 0; i < n; i++) {
    const f = flags[i];
    if (f & FLAG.COLOR_CHANGE) {
      close(i); // chunk ends before the colour change record
      block++;
      continue;
    }
    if (!(f & FLAG.COMMANDS) && ++count >= CHUNK) close(i + 1);
  }
  close(n);
  if (!chunkCache.has(plan)) chunkCache.set(plan, new Map());
  chunkCache.get(plan)!.set(showUnderlay, chunks);
  return chunks;
}

// ---------------------------------------------------------------------------
// Painting primitives (all in mm space)

/** Thread width without a design (dialog previews): No. 40. */
const THREAD_W0 = 0.4;

function paintStitches(
  ctx: CanvasRenderingContext2D,
  color: string,
  weight: number | undefined,
  path: Path2D,
  jumps: Path2D,
  dots: ArrayLike<number>,
  r: RenderInput,
  vp: { x0: number; y0: number; x1: number; y1: number },
) {
  const scale = r.view.scale;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  if (r.mode === "stitch") {
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(0.12, 1.1 / scale);
    ctx.stroke(path);
    if (scale > 14 && dots.length) {
      ctx.fillStyle = r.theme.dark ? "rgba(255,255,255,.55)" : "rgba(0,0,0,.45)";
      const s = 1.6 / scale;
      for (let k = 0; k < dots.length; k += 2) {
        const x = dots[k];
        const y = dots[k + 1];
        if (x < vp.x0 || x > vp.x1 || y < vp.y0 || y > vp.y1) continue;
        ctx.fillRect(x - s / 2, y - s / 2, s, s);
      }
    }
  } else {
    // realistic: soft shadow, dark rim, body, specular highlight
    // the thread's own weight, else the design's
    const THREAD_W = weight ? threadWidth(weight as ThreadWeight) : r.doc ? threadWidth(r.doc.options?.threadWeight) : THREAD_W0;
    // the thread ends at the needle hole: no rounded end or corner reaching past it
    // (a satin's turns are its edges — round ones made narrow columns a thread wider)
    ctx.lineCap = "butt";
    ctx.lineJoin = "bevel";
    ctx.save();
    ctx.translate(0.05, 0.07);
    ctx.strokeStyle = "rgba(0,0,0,0.28)";
    ctx.lineWidth = THREAD_W * 1.25;
    ctx.stroke(path);
    ctx.restore();
    ctx.strokeStyle = shade(color, -0.32);
    ctx.lineWidth = THREAD_W;
    ctx.stroke(path);
    ctx.strokeStyle = color;
    ctx.lineWidth = THREAD_W * 0.66;
    ctx.stroke(path);
    ctx.save();
    ctx.translate(-0.045, -0.045);
    ctx.strokeStyle = shade(color, 0.5);
    ctx.globalAlpha = 0.55;
    ctx.lineWidth = THREAD_W * 0.22;
    ctx.stroke(path);
    ctx.restore();
  }
  if (r.showJumps) {
    ctx.save();
    ctx.setLineDash([3.6 / scale, 3.6 / scale]);
    ctx.lineWidth = 1 / scale;
    ctx.strokeStyle = r.theme.dark ? "rgba(255,255,255,.5)" : "rgba(0,0,0,.45)";
    ctx.stroke(jumps);
    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// Trim marks

interface TrimMark {
  /** The trim's record (marks up to the stitch-out's limit are drawn). */
  i: number;
  x: number;
  y: number;
  /** Where the jump after it lands (none before a colour change, stop or the end). */
  to: [number, number] | null;
  /** The machine leaves this jump uncut (lib/cuts.ts). */
  uncut: boolean;
}

const trimMarkCache = new WeakMap<PlanData, TrimMark[]>();

function trimMarks(plan: PlanData): TrimMark[] {
  const hit = trimMarkCache.get(plan);
  if (hit) return hit;
  const { flags, coords } = plan;
  const out: TrimMark[] = [];
  for (let i = 0; i < flags.length; i++) {
    if (!(flags[i] & FLAG.TRIM) || plan.hide?.[i]) continue;
    let j = i + 1;
    while (j < flags.length && flags[j] & FLAG.TRIM) j++;
    while (j < flags.length && flags[j] & FLAG.JUMP && !(flags[j] & (FLAG.COLOR_CHANGE | FLAG.STOP | FLAG.END))) j++;
    out.push({ i, x: coords[2 * i], y: coords[2 * i + 1], to: j > i + 1 ? [coords[2 * (j - 1)], coords[2 * (j - 1) + 1]] : null, uncut: !!plan.uncut?.mask[i] });
  }
  trimMarkCache.set(plan, out);
  return out;
}

/** A cut mark (a small triangle) at every trim and a ring where its jump
 *  lands; the trims the machine leaves uncut in the warning colour. Literal
 *  colours: the canvas can't read the CSS tokens (--text, --warning). */
function paintTrimMarks(ctx: CanvasRenderingContext2D, plan: PlanData, limit: number, scale: number, dark: boolean) {
  const marks = trimMarks(plan);
  if (!marks.length) return;
  const s = 4.5 / scale;
  const cut = dark ? "#e6e6e6" : "#303231";
  const warn = dark ? "#e0a106" : "#d98a1e";
  ctx.save();
  ctx.lineWidth = 1.2 / scale;
  ctx.lineJoin = "round";
  for (const m of marks) {
    if (m.i >= limit) break;
    const c = m.uncut ? warn : cut;
    ctx.strokeStyle = dark ? "rgba(0,0,0,.6)" : "rgba(255,255,255,.85)";
    ctx.fillStyle = c;
    ctx.beginPath();
    ctx.moveTo(m.x, m.y - s);
    ctx.lineTo(m.x + s * 0.87, m.y + s * 0.5);
    ctx.lineTo(m.x - s * 0.87, m.y + s * 0.5);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    if (m.to) {
      ctx.strokeStyle = c;
      ctx.beginPath();
      ctx.arc(m.to[0], m.to[1], s * 0.6, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Fabric texture for realistic mode

let fabricPattern: { color: string; pat: CanvasPattern | null } | null = null;
function fabric(ctx: CanvasRenderingContext2D, color: string): CanvasPattern | null {
  if (fabricPattern && fabricPattern.color === color) return fabricPattern.pat;
  const c = document.createElement("canvas");
  c.width = c.height = 8;
  const g = c.getContext("2d")!;
  g.fillStyle = color;
  g.fillRect(0, 0, 8, 8);
  g.fillStyle = "rgba(0,0,0,0.045)";
  for (let i = 0; i < 8; i += 2) g.fillRect(i, 0, 1, 8);
  g.fillStyle = "rgba(255,255,255,0.05)";
  for (let j = 0; j < 8; j += 2) g.fillRect(0, j, 8, 1);
  const pat = ctx.createPattern(c, "repeat");
  fabricPattern = { color, pat };
  return pat;
}

/** Fabric pattern anchored at (ox, oy) CSS px, so the weave moves with the design. */
function anchoredFabric(ctx: CanvasRenderingContext2D, color: string, ox: number, oy: number): CanvasPattern | string {
  const pat = fabric(ctx, color);
  if (!pat) return color;
  pat.setTransform(new DOMMatrix([1, 0, 0, 1, ox, oy]));
  return pat;
}

let hatch: { dark: boolean; p: CanvasPattern } | null = null;

/** The removed part of each cut object (its shape minus what is stitched), hatched; lines dashed. */
function paintHidden(ctx: CanvasRenderingContext2D, doc: StitchDocument, shapes: { index: number; paths: SubPath[] }[], scale: number, dark: boolean) {
  if (!hatch || hatch.dark !== dark) {
    const c = document.createElement("canvas");
    c.width = c.height = 8;
    const g = c.getContext("2d")!;
    g.strokeStyle = dark ? "rgba(255, 120, 90, 0.75)" : "rgba(214, 64, 32, 0.7)";
    g.lineWidth = 1.5;
    g.beginPath();
    g.moveTo(-2, 10);
    g.lineTo(10, -2);
    g.moveTo(-2, 2);
    g.lineTo(2, -2);
    g.moveTo(6, 10);
    g.lineTo(10, 6);
    g.stroke();
    hatch = { dark, p: ctx.createPattern(c, "repeat")! };
  }
  const edge = dark ? "rgba(255, 120, 90, 0.9)" : "rgba(214, 64, 32, 0.85)";
  ctx.save();
  for (const h of shapes) {
    const o = doc.objects[h.index];
    if (!o) continue;
    const full = objectPath(o);
    if (o.stitch.type === "running") {
      // the whole line dashed, what's left of it solid on top
      ctx.strokeStyle = edge;
      ctx.lineWidth = 2 / scale;
      ctx.setLineDash([4 / scale, 3 / scale]);
      ctx.stroke(full);
      ctx.setLineDash([]);
      continue;
    }
    const removed = new Path2D();
    removed.addPath(full);
    if (h.paths.length) removed.addPath(pathsToPath2D(h.paths));
    // the pattern in screen pixels, however far zoomed in
    hatch.p.setTransform(new DOMMatrix().scaleSelf(1 / scale, 1 / scale));
    ctx.fillStyle = hatch.p;
    ctx.fill(removed, "evenodd");
    ctx.strokeStyle = edge;
    ctx.lineWidth = 1 / scale;
    ctx.setLineDash([3 / scale, 2 / scale]);
    if (h.paths.length) ctx.stroke(pathsToPath2D(h.paths));
    else ctx.stroke(full);
    ctx.setLineDash([]);
  }
  ctx.restore();
}

function drawVectorObject(ctx: CanvasRenderingContext2D, o: DesignObject, color: string, scale: number) {
  const st = o.stitch;
  const outline = shade(color, -0.35);
  const hair = 1 / scale;
  if (st.type === "fill" || st.type === "none") {
    const p = objectPath(o);
    ctx.globalAlpha = st.type === "none" ? 0.35 : 1;
    ctx.fillStyle = color;
    ctx.fill(p, "evenodd");
    ctx.globalAlpha = 1;
    ctx.strokeStyle = outline;
    ctx.lineWidth = hair;
    ctx.stroke(p);
  } else if (st.type === "applique") {
    // the fabric patch, its cover edge and the placement line
    const p = objectPath(o);
    ctx.globalAlpha = 0.28;
    ctx.fillStyle = color;
    ctx.fill(p, "evenodd");
    ctx.globalAlpha = 1;
    if (st.cover !== "none") {
      ctx.strokeStyle = color;
      ctx.lineWidth = st.coverWidth;
      ctx.lineJoin = "round";
      ctx.stroke(p);
    }
    ctx.strokeStyle = outline;
    ctx.lineWidth = hair;
    ctx.setLineDash([3 * hair, 2 * hair]);
    ctx.stroke(p);
    ctx.setLineDash([]);
  } else if (st.type === "satin") {
    const p = objectOutline(o);
    if (p) {
      ctx.fillStyle = color;
      ctx.fill(p, "evenodd");
      ctx.strokeStyle = outline;
      ctx.lineWidth = hair;
      ctx.stroke(p);
    }
  } else {
    const p = objectPath(o);
    const w = st.type === "running" ? (st.beanRepeats > 0 ? 0.6 : 0.35) : 0.3;
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(w, 1.4 / scale);
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.stroke(p);
  }
}

function niceStep(scale: number): number {
  // mm per labelled tick so that labels are at least ~70px apart
  const steps = [1, 2, 5, 10, 20, 50, 100, 200, 500];
  for (const s of steps) if (s * scale >= 70) return s;
  return 1000;
}

/** Restore every piece of drawing state we touch, so a frame never depends on the previous one. */
function resetState(ctx: CanvasRenderingContext2D) {
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  ctx.lineCap = "butt";
  ctx.lineJoin = "miter";
  ctx.miterLimit = 10;
  ctx.setLineDash([]);
  ctx.lineDashOffset = 0;
  ctx.textAlign = "start";
  ctx.textBaseline = "alphabetic";
  ctx.imageSmoothingEnabled = true;
}
const mmTransform = (ctx: CanvasRenderingContext2D, r: RenderInput) =>
  ctx.setTransform(r.dpr * r.view.scale, 0, 0, r.dpr * r.view.scale, r.dpr * r.view.ox, r.dpr * r.view.oy);

interface MmRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** A device-pixel rectangle expressed in mm, grown by a margin for line widths. */
function mmRectOf(r: RenderInput, px0: number, py0: number, px1: number, py1: number): MmRect {
  const { scale, ox, oy } = r.view;
  const m = Math.max(0.8, 4 / scale);
  return {
    x0: (px0 / r.dpr - ox) / scale - m,
    y0: (py0 / r.dpr - oy) / scale - m,
    x1: (px1 / r.dpr - ox) / scale + m,
    y1: (py1 / r.dpr - oy) / scale + m,
  };
}

const hits = (a: MmRect, x0: number, y0: number, x1: number, y1: number) => x1 >= a.x0 && x0 <= a.x1 && y1 >= a.y0 && y0 <= a.y1;

/** Background, fabric, grid, hoop (and vector artwork in vector mode), limited to `area`. */
function paintBackground(ctx: CanvasRenderingContext2D, r: RenderInput, area: MmRect, opts: { fabric?: boolean; hoop?: boolean } = {}) {
  resetState(ctx);
  const { doc, view, theme, dpr } = r;
  const { scale, ox, oy } = view;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = theme.canvas;
  ctx.fillRect(0, 0, r.width, r.height);
  const hw = doc.hoop.width;
  const hh = doc.hoop.height;
  const cx = hw / 2;
  const cy = hh / 2;
  // the fabric in the hoop: textured in the realistic view (by WebGL when it
  // draws the stitches — this layer then lays its shadow), flat in the others
  const realistic = r.mode === "realistic";
  if (realistic || r.fabricAll !== false) {
    const fabricPath = () => {
      ctx.beginPath();
      const fa = r.fabricArea;
      if (fa) ctx.roundRect(ox + fa.x * scale, oy + fa.y * scale, fa.w * scale, fa.h * scale, Math.min(12, 6 * scale));
      else if (doc.hoop.shape === "oval") ctx.ellipse(ox + (hw * scale) / 2, oy + (hh * scale) / 2, (hw * scale) / 2, (hh * scale) / 2, 0, 0, Math.PI * 2);
      else ctx.roundRect(ox, oy, hw * scale, hh * scale, Math.min(12, 6 * scale));
    };
    // a soft shadow lifts the fabric off the canvas
    ctx.save();
    ctx.shadowColor = theme.dark ? "rgba(0,0,0,0.5)" : "rgba(40,30,20,0.22)";
    ctx.shadowBlur = 14;
    ctx.shadowOffsetY = 3;
    ctx.fillStyle = r.fabricColor;
    fabricPath();
    ctx.fill();
    ctx.restore();
    if (realistic && (opts.fabric !== false || hasBehind(r))) {
      ctx.fillStyle = anchoredFabric(ctx, r.fabricColor, ox, oy);
      fabricPath();
      ctx.fill();
    }
  }
  mmTransform(ctx, r);
  paintReferences(ctx, r, "behind");
  mmTransform(ctx, r);
  if (r.showGrid && r.mode !== "realistic") {
    // grid lines are anchored to the hoop and drawn across the whole canvas
    // (so pixels shifted out from under the rulers stay correct)
    const g = mmRectOf(r, 0, 0, Math.round(r.width * dpr), Math.round(r.height * dpr));
    const x0 = Math.max(g.x0, area.x0);
    const x1 = Math.min(g.x1, area.x1);
    const y0 = Math.max(g.y0, area.y0);
    const y1 = Math.min(g.y1, area.y1);
    const step = r.gridStep && r.gridStep * scale >= 4 ? r.gridStep : scale > 12 ? 5 : 10;
    ctx.lineWidth = 1 / scale;
    ctx.strokeStyle = theme.grid;
    ctx.beginPath();
    for (let x = Math.floor((x0 - cx) / step) * step + cx; x <= x1; x += step) {
      ctx.moveTo(x, g.y0);
      ctx.lineTo(x, g.y1);
    }
    for (let y = Math.floor((y0 - cy) / step) * step + cy; y <= y1; y += step) {
      ctx.moveTo(g.x0, y);
      ctx.lineTo(g.x1, y);
    }
    ctx.stroke();
    // the hoop's centre lines (a preview has no hoop)
    if (!r.preview) {
      ctx.strokeStyle = theme.axis;
      ctx.beginPath();
      ctx.moveTo(cx, g.y0);
      ctx.lineTo(cx, g.y1);
      ctx.moveTo(g.x0, cy);
      ctx.lineTo(g.x1, cy);
      ctx.stroke();
    }
  }
  if (opts.hoop !== false) paintHoop(ctx, r);
  if (r.mode === "vector" || !r.plan) {
    const colors = new Map(doc.threads.map((t) => [t.id, t.color]));
    const color = (o: DesignObject) => colors.get(o.thread) ?? "#222";
    // gradients and colour blends: the whole group once, as its colour mix
    const painted = new Set<string>();
    for (const o of doc.objects) {
      if (!o.visible) continue;
      const b = objectBoundsCached(o);
      if (b && !hits(area, b.x, b.y, b.x + b.w, b.y + b.h)) continue;
      const group = colourGroup(o);
      if (group) {
        if (painted.has(group)) continue;
        painted.add(group);
        const layers = doc.objects.filter((x) => x.visible && colourGroup(x) === group);
        const pic = groupPicture(layers, color);
        if (pic) {
          const p = objectPath(o);
          ctx.save();
          ctx.clip(p, "evenodd");
          ctx.imageSmoothingEnabled = true;
          ctx.drawImage(pic.image, pic.box.x, pic.box.y, pic.box.w, pic.box.h);
          ctx.restore();
          ctx.strokeStyle = shade(color(o), -0.35);
          ctx.lineWidth = 1 / scale;
          ctx.stroke(p);
          continue;
        }
      }
      drawVectorObject(ctx, o, color(o), scale);
    }
  }
}

function paintHoop(ctx: CanvasRenderingContext2D, r: RenderInput) {
  if (r.preview) return;
  mmTransform(ctx, r);
  ctx.save();
  ctx.strokeStyle = r.theme.hoop;
  ctx.lineWidth = 1.25 / r.view.scale;
  ctx.setLineDash([5 / r.view.scale, 4 / r.view.scale]);
  const { width: w, height: h, shape } = r.doc.hoop;
  if (shape === "oval") {
    // the field is the ellipse; the box stays as a faint guide
    ctx.beginPath();
    ctx.ellipse(w / 2, h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 0.25;
    ctx.setLineDash([2 / r.view.scale, 4 / r.view.scale]);
    ctx.strokeRect(0, 0, w, h);
  } else ctx.strokeRect(0, 0, w, h);
  ctx.restore();
}

/**
 * Paint chunks [from, to). Consecutive chunks of one colour block are shaded
 * as one path: each shading pass (shadow, rim, body, highlight) runs over the
 * whole block, so a chunk's shadow never darkens the rows of the chunk before
 * it (that left a seam every CHUNK stitches).
 */
function paintChunks(ctx: CanvasRenderingContext2D, r: RenderInput, chunks: Chunk[], from: number, to: number, area: MmRect): number {
  mmTransform(ctx, r);
  let painted = 0;
  let k = from;
  while (k < to) {
    const block = chunks[k].block;
    const color = chunks[k].color;
    const weight = chunks[k].weight;
    const path = new Path2D();
    const jumps = new Path2D();
    const dots: number[] = [];
    let any = false;
    for (; k < to && chunks[k].block === block; k++) {
      const c = chunks[k];
      if (!hits(area, c.bx0, c.by0, c.bx1, c.by1)) continue;
      path.addPath(c.path);
      jumps.addPath(c.jumps);
      for (let i = 0; i < c.dots.length; i++) dots.push(c.dots[i]);
      any = true;
      painted++;
    }
    if (any) paintStitches(ctx, color, weight, path, jumps, dots, r, area);
  }
  return painted;
}

// ---------------------------------------------------------------------------
// Layered renderer
//
// A layer is an offscreen canvas holding background + the first `chunks`
// chunks for one content key and one view. Frames reuse it:
//   - same view            -> blit (+ paint newly sewn chunks for animation)
//   - pan (same scale)     -> shift the pixels by whole device pixels and repaint
//                             only the exposed strips (culled to those strips)
//   - zoom                 -> show the old layer scaled at once while a second
//                             layer is rebuilt for the new view in ~8 ms slices,
//                             then swap: the settled frame is a full-quality render
//   - content change       -> synchronous rebuild (culled to the canvas)
// Views are snapped to whole device pixels so shifting is exact.

interface Layer {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  content: unknown[];
  view: View | null;
  chunks: number;
}

const newLayer = (): Layer => {
  const canvas = document.createElement("canvas");
  return { canvas, ctx: canvas.getContext("2d")!, content: [], view: null, chunks: 0 };
};

const sameArr = (a: unknown[], b: unknown[]) => a.length === b.length && a.every((v, i) => v === b[i]);
const sameView = (a: View | null, b: View) => !!a && a.scale === b.scale && a.ox === b.ox && a.oy === b.oy;

export class Renderer {
  private base: Layer | null = null;
  private back: Layer | null = null;
  private scratch: HTMLCanvasElement | null = null;
  /** Time budget per frame for progressive rebuilds (ms). */
  budgetMs = 8;
  /** Counters for profiling/tests. */
  stats = { fullRenders: 0, shifts: 0, progressiveSteps: 0, swaps: 0, chunksPainted: 0 };

  private contentKey(r: RenderInput): unknown[] {
    const stitched = r.mode !== "vector" && !!r.plan;
    return [
      r.mode,
      !!r.glStitches,
      stitched ? r.plan : r.doc,
      r.doc.hoop.width,
      r.doc.hoop.height,
      r.doc.hoop.shape,
      r.theme,
      r.showGrid,
      r.gridStep,
      r.showJumps,
      r.showUnderlay,
      r.fabricColor,
      r.fabricAll,
      r.width,
      r.height,
      r.dpr,
      r.doc.references,
      referencesLoaded(),
    ];
  }

  private sized(layer: Layer, pw: number, ph: number) {
    if (layer.canvas.width !== pw || layer.canvas.height !== ph) {
      layer.canvas.width = pw;
      layer.canvas.height = ph;
      layer.content = [];
      layer.view = null;
    }
  }

  private full(layer: Layer, r: RenderInput, key: unknown[], chunks: Chunk[], done: number) {
    const area = mmRectOf(r, 0, 0, layer.canvas.width, layer.canvas.height);
    paintBackground(layer.ctx, r, area);
    this.stats.chunksPainted += paintChunks(layer.ctx, r, chunks, 0, done, area);
    layer.content = key;
    layer.view = { ...r.view };
    layer.chunks = done;
    this.stats.fullRenders++;
  }

  /** Shift layer pixels for a pan and repaint the exposed strips. False if not possible. */
  private shift(layer: Layer, r: RenderInput, chunks: Chunk[]): boolean {
    const v = layer.view!;
    const fx = (r.view.ox - v.ox) * r.dpr;
    const fy = (r.view.oy - v.oy) * r.dpr;
    const dx = Math.round(fx);
    const dy = Math.round(fy);
    const pw = layer.canvas.width;
    const ph = layer.canvas.height;
    if (Math.abs(fx - dx) > 1e-6 || Math.abs(fy - dy) > 1e-6 || Math.abs(dx) >= pw || Math.abs(dy) >= ph) return false;
    if (!this.scratch) this.scratch = document.createElement("canvas");
    const sc = this.scratch;
    if (sc.width !== pw || sc.height !== ph) {
      sc.width = pw;
      sc.height = ph;
    }
    const sctx = sc.getContext("2d")!;
    sctx.setTransform(1, 0, 0, 1, 0, 0);
    sctx.globalCompositeOperation = "copy";
    sctx.drawImage(layer.canvas, 0, 0);
    sctx.globalCompositeOperation = "source-over";
    const lctx = layer.ctx;
    resetState(lctx);
    lctx.setTransform(1, 0, 0, 1, 0, 0);
    lctx.globalCompositeOperation = "copy";
    lctx.drawImage(sc, dx, dy);
    lctx.globalCompositeOperation = "source-over";
    // exposed strips (device px): a vertical band and a horizontal band
    const strips: [number, number, number, number][] = [];
    if (dx > 0) strips.push([0, 0, dx, ph]);
    if (dx < 0) strips.push([pw + dx, 0, pw, ph]);
    if (dy > 0) strips.push([0, 0, pw, dy]);
    if (dy < 0) strips.push([0, ph + dy, pw, ph]);
    layer.view = { ...r.view };
    for (const [x0, y0, x1, y1] of strips) {
      lctx.save();
      lctx.setTransform(1, 0, 0, 1, 0, 0);
      lctx.beginPath();
      lctx.rect(x0, y0, x1 - x0, y1 - y0);
      lctx.clip();
      const area = mmRectOf(r, x0, y0, x1, y1);
      paintBackground(lctx, r, area);
      this.stats.chunksPainted += paintChunks(lctx, r, chunks, 0, layer.chunks, area);
      lctx.restore();
    }
    this.stats.shifts++;
    return true;
  }

  /** Advance the rebuild for the current view. True when complete (and swapped in). */
  private progress(r: RenderInput, key: unknown[], chunks: Chunk[], done: number, pw: number, ph: number): boolean {
    const back = (this.back ??= newLayer());
    this.sized(back, pw, ph);
    const t0 = performance.now();
    const area = mmRectOf(r, 0, 0, pw, ph);
    const restart = () => {
      paintBackground(back.ctx, r, area);
      back.content = key;
      back.view = { ...r.view };
      back.chunks = 0;
    };
    if (!sameArr(back.content, key) || back.view === null || back.chunks > done) restart();
    else if (!sameView(back.view, r.view) && (back.view.scale !== r.view.scale || !this.shift(back, r, chunks))) restart();
    mmTransform(back.ctx, r);
    while (back.chunks < done && performance.now() - t0 < this.budgetMs) {
      const c = chunks[back.chunks++];
      if (hits(area, c.bx0, c.by0, c.bx1, c.by1)) {
        paintStitches(back.ctx, c.color, c.weight, c.path, c.jumps, c.dots, r, area);
        this.stats.chunksPainted++;
      }
    }
    this.stats.progressiveSteps++;
    if (back.chunks < done) return false;
    // the finished layer becomes the base
    this.back = this.base;
    this.base = back;
    this.stats.swaps++;
    return true;
  }

  /** Render one frame. Returns true if another frame is needed to finish refining. */
  render(ctx: CanvasRenderingContext2D, input: RenderInput, overlayCtx?: CanvasRenderingContext2D): boolean {
    // snap the view to whole device pixels: pans become exact pixel shifts
    const r: RenderInput = {
      ...input,
      view: {
        scale: input.view.scale,
        ox: Math.round(input.view.ox * input.dpr) / input.dpr,
        oy: Math.round(input.view.oy * input.dpr) / input.dpr,
      },
    };
    const pw = Math.round(r.width * r.dpr);
    const ph = Math.round(r.height * r.dpr);
    if (r.glStitches && overlayCtx) {
      // stitches and fabric come from WebGL: the 2D layers are cheap enough to
      // repaint directly every frame (no caching, no copies)
      paintBackground(ctx, r, mmRectOf(r, 0, 0, pw, ph), { fabric: false, hoop: false });
      const total = r.plan ? r.plan.flags.length : 0;
      const limit = r.animIndex == null ? total : Math.max(0, Math.min(total, r.animIndex));
      resetState(overlayCtx);
      overlayCtx.setTransform(1, 0, 0, 1, 0, 0);
      overlayCtx.clearRect(0, 0, overlayCtx.canvas.width, overlayCtx.canvas.height);
      paintHoop(overlayCtx, r);
      this.paintOverlays(overlayCtx, r, limit);
      return false;
    }
    const base = (this.base ??= newLayer());
    this.sized(base, pw, ph);
    const key = this.contentKey(r);
    const stitched = r.mode !== "vector" && !!r.plan && !r.glStitches;
    const chunks = stitched ? getChunks(r.plan!, r.showUnderlay) : [];
    const total = r.plan && r.mode !== "vector" ? r.plan.flags.length : 0;
    const limit = r.animIndex == null ? total : Math.max(0, Math.min(total, r.animIndex));
    let done = 0;
    {
      let lo = 0;
      let hi = chunks.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (chunks[mid].end <= limit) lo = mid + 1;
        else hi = mid;
      }
      done = lo;
    }

    let interim = false;
    if (!sameArr(base.content, key) || base.view === null || base.chunks > done) {
      this.full(base, r, key, chunks, done);
      this.back = null;
    } else if (!sameView(base.view, r.view)) {
      const shifted = base.view.scale === r.view.scale && this.shift(base, r, chunks);
      if (shifted) {
        if (this.back) this.back.content = [];
      } else {
        interim = !this.progress(r, key, chunks, done, pw, ph);
      }
    }
    const cur = this.base!;
    if (!interim && cur.chunks < done) {
      // newly sewn chunks (stitch-out animation)
      this.stats.chunksPainted += paintChunks(cur.ctx, r, chunks, cur.chunks, done, mmRectOf(r, 0, 0, pw, ph));
      cur.chunks = done;
    }

    // composite
    resetState(ctx);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (interim) {
      // stale layer scaled into the new view while the sharp one is built
      const v = cur.view!;
      const k = r.view.scale / v.scale;
      ctx.fillStyle = r.theme.canvas;
      ctx.fillRect(0, 0, pw, ph);
      ctx.setTransform(k, 0, 0, k, r.dpr * (r.view.ox - v.ox * k), r.dpr * (r.view.oy - v.oy * k));
      ctx.drawImage(cur.canvas, 0, 0);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      if (stitched && cur.chunks < done) {
        // keep a running stitch-out complete while the sharp layer is built
        paintChunks(ctx, r, chunks, cur.chunks, done, mmRectOf(r, 0, 0, pw, ph));
        resetState(ctx);
      }
    } else ctx.drawImage(cur.canvas, 0, 0);
    mmTransform(ctx, r);
    if (stitched && done < chunks.length && limit > chunks[done].start) {
      const c = chunks[done];
      const t = trace(r.plan!, c.start, limit, c.penIn, c.x, c.y, r.showUnderlay, r.mode === "stitch" && r.view.scale > 14);
      paintStitches(ctx, c.color, c.weight, t.path, t.jumps, t.dots, r, mmRectOf(r, 0, 0, pw, ph));
      resetState(ctx);
    }
    if (overlayCtx) {
      resetState(overlayCtx);
      overlayCtx.setTransform(1, 0, 0, 1, 0, 0);
      overlayCtx.clearRect(0, 0, overlayCtx.canvas.width, overlayCtx.canvas.height);
      this.paintOverlays(overlayCtx, r, limit);
    } else this.paintOverlays(ctx, r, limit);
    return interim;
  }

  private paintOverlays(ctx: CanvasRenderingContext2D, r: RenderInput, limit: number) {
    const { doc, plan, view, mode, theme, overlay, dpr } = r;
    const { scale, ox, oy } = view;
    mmTransform(ctx, r);
    paintReferences(ctx, r, "over");
    mmTransform(ctx, r);

    // what hidden-stitch removal takes out: the part of each cut object that isn't stitched, hatched
    if (r.hiddenShapes?.length) paintHidden(ctx, doc, r.hiddenShapes, scale, theme.dark);

    // with the jump stitches shown: where the machine cuts, and where each jump lands
    if (plan && mode !== "vector" && r.showJumps) paintTrimMarks(ctx, plan, limit, scale, theme.dark);

    // needle marker while animating
    if (plan && mode !== "vector" && r.animIndex != null && limit > 0) {
      const i = limit - 1;
      const x = plan.coords[2 * i];
      const y = plan.coords[2 * i + 1];
      ctx.fillStyle = theme.select;
      ctx.beginPath();
      ctx.arc(x, y, 4 / scale, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 1.5 / scale;
      ctx.stroke();
    }

    const sel = doc.objects.filter((o) => r.selection.includes(o.id));
    const ictx = { ctx, scale, dpr, ox, oy, select: theme.select, dark: theme.dark };
    const interactive = r.interactive ?? {};
    paintUnderlays(ictx, {
      plan,
      mode,
      density: r.showDensity ? (r.density ?? null) : null,
      densityMode: r.densityMode ?? "coverage",
      live: r.live ?? null,
      selected: sel,
      selectedIndex: sel.map((o) => doc.objects.indexOf(o)),
      colors: new Map(doc.threads.map((t) => [t.id, t.color])),
      overlay: interactive,
    });
    mmTransform(ctx, r);

    // selection
    if (sel.length) {
      ctx.save();
      ctx.strokeStyle = theme.select;
      for (const o of sel) {
        const p =
          mode === "vector" && o.stitch.type === "satin" && o.paths.length === 1
            ? objectPath(o)
            : o.stitch.type === "satin"
              ? objectOutline(o)
              : objectPath(o);
        if (!p) continue;
        ctx.lineWidth = (mode === "vector" ? 1.6 : 1.4) / scale;
        ctx.stroke(p);
      }
      // the handles go round what a drag transforms (locked objects, and
      // letterings with a locked letter, stay put), as the pointer hit-tests them
      const box = unionBoxes(transformable(sel, doc.objects).objects.map(objectBoundsCached));
      if (box && !overlay.nodes) drawHandles(ctx, box, scale, theme.select);
      if (overlay.nodes) {
        const picked = new Set((overlay.nodeSel ?? []).map((n) => `${n.id}/${n.sp}/${n.ni}`));
        for (const o of sel) drawNodes(ctx, o, scale, theme.select, picked);
      }
      ctx.restore();
    }
    if (overlay.hoverId && !r.selection.includes(overlay.hoverId)) {
      const o = doc.objects.find((x) => x.id === overlay.hoverId);
      if (o) {
        const p = o.stitch.type === "satin" ? objectOutline(o) : objectPath(o);
        if (p) {
          ctx.strokeStyle = theme.select;
          ctx.globalAlpha = 0.6;
          ctx.lineWidth = 1 / scale;
          ctx.stroke(p);
          ctx.globalAlpha = 1;
        }
      }
    }

    // tool overlays
    if (overlay.marquee) {
      const m = overlay.marquee;
      ctx.fillStyle = theme.select + "22";
      ctx.strokeStyle = theme.select;
      ctx.lineWidth = 1 / scale;
      ctx.fillRect(m.x, m.y, m.w, m.h);
      ctx.strokeRect(m.x, m.y, m.w, m.h);
    }
    if (overlay.nodeMarquee) {
      const m = overlay.nodeMarquee;
      ctx.fillStyle = theme.select + "18";
      ctx.strokeStyle = theme.select;
      ctx.lineWidth = 1 / scale;
      ctx.setLineDash([3 / scale, 3 / scale]);
      ctx.fillRect(m.x, m.y, m.w, m.h);
      ctx.strokeRect(m.x, m.y, m.w, m.h);
      ctx.setLineDash([]);
    }
    if (overlay.snap) {
      const [x, y] = overlay.snap;
      const k = 7 / scale;
      ctx.strokeStyle = theme.select;
      ctx.lineWidth = 1.5 / scale;
      ctx.beginPath();
      ctx.moveTo(x - k, y);
      ctx.lineTo(x, y - k);
      ctx.lineTo(x + k, y);
      ctx.lineTo(x, y + k);
      ctx.closePath();
      ctx.stroke();
    }
    if (overlay.builder) drawBuilder(ctx, overlay.builder, scale, theme.select);
    if (overlay.guides) drawGuides(ctx, overlay.guides, scale, theme.select);
    if (overlay.ramp) drawRamp(ctx, overlay.ramp, scale, theme.select);
    const re = overlay.refEdit ? doc.references?.find((x) => x.id === overlay.refEdit) : null;
    if (re) drawReferenceFrame(ctx, re, scale, theme.select);
    if (overlay.shape) {
      const b = overlay.shape.box;
      ctx.strokeStyle = theme.select;
      ctx.lineWidth = 1.2 / scale;
      ctx.setLineDash([4 / scale, 3 / scale]);
      ctx.beginPath();
      if (overlay.shape.path) ctx.stroke(pathsToPath2D([overlay.shape.path]));
      else if (overlay.shape.kind === "rect") ctx.rect(b.x, b.y, b.w, b.h);
      else ctx.ellipse(b.x + b.w / 2, b.y + b.h / 2, Math.abs(b.w / 2), Math.abs(b.h / 2), 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (overlay.ruler) {
      const { a, b } = overlay.ruler;
      ctx.strokeStyle = theme.select;
      ctx.lineWidth = 1.5 / scale;
      ctx.beginPath();
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(b[0], b[1]);
      ctx.stroke();
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const ang = (Math.atan2(-(b[1] - a[1]), b[0] - a[0]) * 180) / Math.PI;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const sx = ox + b[0] * scale + 10;
      const sy = oy + b[1] * scale - 10;
      const label = `${len.toFixed(1)} mm  ${ang.toFixed(0)}°`;
      ctx.font = "600 12px Inter, system-ui, sans-serif";
      const tw = ctx.measureText(label).width;
      ctx.fillStyle = theme.select;
      ctx.beginPath();
      ctx.roundRect(sx - 6, sy - 15, tw + 12, 21, 5);
      ctx.fill();
      ctx.fillStyle = "#fff";
      ctx.fillText(label, sx, sy);
    }

    mmTransform(ctx, r);
    paintInteractive(ictx, { selected: sel, overlay: interactive });
    if (!r.preview) drawRulers(ctx, r, doc.hoop.width / 2, doc.hoop.height / 2);
  }
}

/** Paint a stitch plan fitted into a canvas (dialog previews). Same shading as the editor. */
export function renderPlanPreview(
  ctx: CanvasRenderingContext2D,
  plan: PlanData,
  opts: { width: number; height: number; dpr: number; mode: "stitch" | "realistic"; fabricColor: string; theme: Theme; showUnderlay?: boolean },
) {
  const { width, height, dpr } = opts;
  resetState(ctx);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (let i = 0; i < plan.flags.length; i++) {
    if (plan.flags[i] & FLAG.COMMANDS) continue;
    const x = plan.coords[2 * i];
    const y = plan.coords[2 * i + 1];
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  if (!(x1 > x0) || !(y1 > y0)) return;
  const pad = 14;
  const scale = Math.min((width - 2 * pad) / (x1 - x0), (height - 2 * pad) / (y1 - y0));
  const view = { scale, ox: (width - (x1 - x0) * scale) / 2 - x0 * scale, oy: (height - (y1 - y0) * scale) / 2 - y0 * scale };
  if (opts.mode === "realistic") {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = anchoredFabric(ctx, opts.fabricColor, 0, 0);
    ctx.fillRect(0, 0, width, height);
  }
  const r = {
    view,
    mode: opts.mode,
    theme: opts.theme,
    showJumps: false,
    dpr,
    width,
    height,
  } as unknown as RenderInput;
  ctx.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * view.ox, dpr * view.oy);
  const vp = { x0: -Infinity, y0: -Infinity, x1: Infinity, y1: Infinity };
  for (const c of getChunks(plan, opts.showUnderlay ?? true)) paintStitches(ctx, c.color, c.weight, c.path, c.jumps, c.dots, r, vp);
  resetState(ctx);
}

// Shared instance for callers that don't keep their own (benchmarks, tests).
const shared = new Renderer();
export function render(ctx: CanvasRenderingContext2D, r: RenderInput) {
  shared.render(ctx, r);
}

function drawHandles(ctx: CanvasRenderingContext2D, b: Box, scale: number, color: string) {
  ctx.strokeStyle = color;
  ctx.lineWidth = 1 / scale;
  ctx.setLineDash([4 / scale, 3 / scale]);
  ctx.strokeRect(b.x, b.y, b.w, b.h);
  ctx.setLineDash([]);
  const s = 7 / scale;
  ctx.fillStyle = "#fff";
  for (const [hx, hy] of handlePoints(b)) {
    ctx.fillRect(hx - s / 2, hy - s / 2, s, s);
    ctx.strokeRect(hx - s / 2, hy - s / 2, s, s);
  }
  const [rx, ry] = rotateHandle(b, scale);
  ctx.beginPath();
  ctx.moveTo(b.x + b.w / 2, b.y);
  ctx.lineTo(rx, ry);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(rx, ry, 4.5 / scale, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
}

export function handlePoints(b: Box): Vec2[] {
  const { x, y, w, h } = b;
  return [
    [x, y],
    [x + w / 2, y],
    [x + w, y],
    [x + w, y + h / 2],
    [x + w, y + h],
    [x + w / 2, y + h],
    [x, y + h],
    [x, y + h / 2],
  ];
}

export const rotateHandle = (b: Box, scale: number): Vec2 => [b.x + b.w / 2, b.y - 22 / scale];

function drawNodes(ctx: CanvasRenderingContext2D, o: DesignObject, scale: number, color: string, picked: Set<string>) {
  const s = 6 / scale;
  ctx.lineWidth = 1 / scale;
  ctx.strokeStyle = color;
  o.paths.forEach((sp, si) => {
    sp.nodes.forEach((n, ni) => {
      for (const h of [n.i, n.o]) {
        if (!h) continue;
        ctx.beginPath();
        ctx.moveTo(n.p[0], n.p[1]);
        ctx.lineTo(h[0], h[1]);
        ctx.stroke();
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(h[0], h[1], s * 0.42, 0, Math.PI * 2);
        ctx.fill();
      }
      const on = picked.has(`${o.id}/${si}/${ni}`);
      const k = on ? s * 1.25 : s;
      ctx.fillStyle = on ? color : "#fff";
      // smooth points are round, corners square
      if (n.i || n.o) {
        ctx.beginPath();
        ctx.arc(n.p[0], n.p[1], k * 0.58, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      } else {
        ctx.fillRect(n.p[0] - k / 2, n.p[1] - k / 2, k, k);
        ctx.strokeRect(n.p[0] - k / 2, n.p[1] - k / 2, k, k);
      }
      // the start of an open path
      if (ni === 0 && !sp.closed) {
        ctx.beginPath();
        ctx.arc(n.p[0], n.p[1], k * 1.05, 0, Math.PI * 2);
        ctx.stroke();
      }
    });
  });
}

const hasBehind = (r: RenderInput) => !!r.doc.references?.some((x) => x.visible && x.placement === "behind");

/** Reference pictures of one placement (mm transform set by the caller). */
function paintReferences(ctx: CanvasRenderingContext2D, r: RenderInput, placement: ReferenceImage["placement"]) {
  const refs = r.doc.references;
  if (!refs?.length) return;
  for (const ref of refs) {
    if (!ref.visible || ref.placement !== placement) continue;
    const img = referenceBitmap(ref.src);
    if (!img) continue;
    ctx.save();
    ctx.globalAlpha = Math.max(0.05, Math.min(1, ref.opacity));
    if (ref.grayscale) ctx.filter = "grayscale(1)";
    ctx.translate(ref.x + ref.width / 2, ref.y + ref.height / 2);
    ctx.rotate((ref.rotation * Math.PI) / 180);
    if (ref.flip) ctx.scale(-1, 1);
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, -ref.width / 2, -ref.height / 2, ref.width, ref.height);
    ctx.restore();
  }
}

/** Adjust frame of a reference picture: outline, corner handles, rotation knob. */
function drawReferenceFrame(ctx: CanvasRenderingContext2D, ref: ReferenceImage, scale: number, color: string) {
  const c = refCorners(ref);
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5 / scale;
  ctx.beginPath();
  c.forEach((q, i) => (i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1])));
  ctx.closePath();
  ctx.stroke();
  const top: Vec2 = [(c[0][0] + c[1][0]) / 2, (c[0][1] + c[1][1]) / 2];
  const knob = refRotateKnob(ref, scale);
  ctx.lineWidth = 1 / scale;
  ctx.beginPath();
  ctx.moveTo(top[0], top[1]);
  ctx.lineTo(knob[0], knob[1]);
  ctx.stroke();
  ctx.fillStyle = "#fff";
  ctx.beginPath();
  ctx.arc(knob[0], knob[1], 5 / scale, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  const s = 9 / scale;
  for (const q of c) {
    ctx.fillRect(q[0] - s / 2, q[1] - s / 2, s, s);
    ctx.strokeRect(q[0] - s / 2, q[1] - s / 2, s, s);
  }
  ctx.restore();
}

function drawRulers(ctx: CanvasRenderingContext2D, r: RenderInput, cx: number, cy: number) {
  const { theme, view, dpr } = r;
  const { scale, ox, oy } = view;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = theme.ruler;
  ctx.fillRect(0, 0, r.width, RULER);
  ctx.fillRect(0, 0, RULER, r.height);
  ctx.strokeStyle = theme.rulerLine;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, RULER + 0.5);
  ctx.lineTo(r.width, RULER + 0.5);
  ctx.moveTo(RULER + 0.5, 0);
  ctx.lineTo(RULER + 0.5, r.height);
  ctx.stroke();
  const step = niceStep(scale);
  const minor = step / (step >= 10 ? 10 : 5);
  ctx.font = "500 9.5px 'JetBrains Mono', ui-monospace, monospace";
  ctx.fillStyle = theme.rulerText;
  ctx.strokeStyle = theme.rulerLine;
  ctx.textBaseline = "middle";
  const xa = (RULER - ox) / scale - cx;
  const xb = (r.width - ox) / scale - cx;
  ctx.beginPath();
  for (let v = Math.floor(xa / minor) * minor; v <= xb; v += minor) {
    const sx = Math.round(ox + (v + cx) * scale) + 0.5;
    const major = Math.abs(v / step - Math.round(v / step)) < 1e-6;
    ctx.moveTo(sx, major ? RULER - 9 : RULER - 4);
    ctx.lineTo(sx, RULER);
    if (major && sx > RULER + 4) ctx.fillText(`${(v / 10).toFixed(step < 10 ? 1 : 0)} cm`, sx + 3, 8);
  }
  ctx.stroke();
  const ya = (RULER - oy) / scale - cy;
  const yb = (r.height - oy) / scale - cy;
  ctx.beginPath();
  for (let v = Math.floor(ya / minor) * minor; v <= yb; v += minor) {
    const sy = Math.round(oy + (v + cy) * scale) + 0.5;
    const major = Math.abs(v / step - Math.round(v / step)) < 1e-6;
    ctx.moveTo(major ? RULER - 9 : RULER - 4, sy);
    ctx.lineTo(RULER, sy);
    if (major && sy > RULER + 4) {
      ctx.save();
      ctx.translate(8, sy + 3);
      ctx.rotate(-Math.PI / 2);
      ctx.textAlign = "right";
      ctx.fillText(`${(v / 10).toFixed(step < 10 ? 1 : 0)} cm`, 0, 0);
      ctx.restore();
    }
  }
  ctx.stroke();
  ctx.fillStyle = theme.ruler;
  ctx.fillRect(0, 0, RULER, RULER);
}

/** Shape Builder regions: all outlined, the hovered one and the picked ones filled. */
/** Satin direction guides: a line with round ends, the hovered one stronger, the draft dashed. */
function drawGuides(ctx: CanvasRenderingContext2D, g: NonNullable<Overlay["guides"]>, scale: number, color: string) {
  ctx.save();
  const line = (a: Vec2, b: Vec2, w: number, dash: number[]) => {
    ctx.setLineDash(dash.map((d) => d / scale));
    ctx.lineWidth = w / scale;
    ctx.beginPath();
    ctx.moveTo(a[0], a[1]);
    ctx.lineTo(b[0], b[1]);
    ctx.stroke();
  };
  const dot = (p: Vec2, r: number) => {
    ctx.beginPath();
    ctx.arc(p[0], p[1], r / scale, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  };
  g.lines.forEach(([a, b], i) => {
    const hot = i === g.hover;
    ctx.strokeStyle = "rgba(255,255,255,0.9)";
    line(a, b, hot ? 5 : 4, []);
    ctx.strokeStyle = color;
    line(a, b, hot ? 2.5 : 1.6, []);
    ctx.fillStyle = "#fff";
    ctx.lineWidth = 1.5 / scale;
    ctx.setLineDash([]);
    dot(a, hot ? 4.5 : 3.5);
    dot(b, hot ? 4.5 : 3.5);
  });
  if (g.draft) {
    ctx.strokeStyle = color;
    line(g.draft[0], g.draft[1], 1.6, [5, 4]);
  }
  ctx.restore();
}

function drawBuilder(ctx: CanvasRenderingContext2D, b: NonNullable<Overlay["builder"]>, scale: number, color: string) {
  const path = (rings: [number, number][][]) => {
    const p = new Path2D();
    for (const r of rings) {
      r.forEach(([x, y], i) => (i ? p.lineTo(x, y) : p.moveTo(x, y)));
      p.closePath();
    }
    return p;
  };
  ctx.save();
  const paths = b.faces.map(path);
  const tint = b.del ? "#d0453a" : color;
  for (const i of b.picked) {
    ctx.fillStyle = tint + "66";
    ctx.fill(paths[i], "evenodd");
  }
  if (b.hover != null && !b.picked.includes(b.hover)) {
    ctx.fillStyle = tint + "33";
    ctx.fill(paths[b.hover], "evenodd");
  }
  ctx.lineWidth = 1 / scale;
  ctx.setLineDash([3 / scale, 3 / scale]);
  ctx.strokeStyle = color + "99";
  for (const p of paths) ctx.stroke(p);
  ctx.setLineDash([]);
  if (b.hover != null) {
    ctx.lineWidth = 1.6 / scale;
    ctx.strokeStyle = tint;
    ctx.stroke(paths[b.hover]);
  }
  ctx.restore();
}

/** A density ramp: its vector, the dense / open ends, and a comb of where the rows fall. */
function drawRamp(ctx: CanvasRenderingContext2D, r: NonNullable<Overlay["ramp"]>, scale: number, color: string) {
  const [ax, ay] = r.from;
  const [bx, by] = r.to;
  const len = Math.hypot(bx - ax, by - ay);
  ctx.save();
  if (len > 1e-6) {
    const ux = (bx - ax) / len;
    const uy = (by - ay) / len;
    // combs: one per layer, on either side of the line
    for (const c of r.combs) {
      ctx.beginPath();
      const k = (9 / scale) * c.side;
      for (const t of c.rows) {
        const x = ax + (bx - ax) * t;
        const y = ay + (by - ay) * t;
        ctx.moveTo(x - uy * 2 / scale * c.side, y + ux * 2 / scale * c.side);
        ctx.lineTo(x - uy * k, y + ux * k);
      }
      // a dark edge under the thread colour: visible on any fill
      ctx.strokeStyle = "rgba(0, 0, 0, 0.55)";
      ctx.lineWidth = 3 / scale;
      ctx.stroke();
      ctx.strokeStyle = c.color;
      ctx.lineWidth = 1.5 / scale;
      ctx.stroke();
    }
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.6 / scale;
  if (r.draft) ctx.setLineDash([5 / scale, 4 / scale]);
  ctx.beginPath();
  ctx.moveTo(ax, ay);
  ctx.lineTo(bx, by);
  ctx.stroke();
  ctx.setLineDash([]);
  // dense end: filled; open end: ring
  const s = 5.5 / scale;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(ax, ay, s, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#fff";
  ctx.lineWidth = 2 / scale;
  ctx.beginPath();
  ctx.arc(bx, by, s, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}
