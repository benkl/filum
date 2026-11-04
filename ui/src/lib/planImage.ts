// Pictures of a stitch plan at a chosen resolution — Ink/Stitch's PNG export
// (png_realistic: shaded threads; png_simple: flat lines of a set width) and
// the pictures of the print sheet. The realistic picture uses the editor's
// WebGL thread renderer, drawn in tiles so large designs at high DPI fit the
// GPU's limits; without WebGL it falls back to the 2D renderer.

import { StitchGL } from "../canvas/gl";
import { getChunks, renderPlanPreview, type Theme } from "../canvas/render";
import { FLAG, type PlanData, type ThreadWeight } from "../types";
import { threadWidth } from "./materials";
import { crc32 } from "./zip";

export type PictureKind = "realistic" | "simple";
export type PictureBackground = "transparent" | "white" | "fabric";

export interface PictureOptions {
  kind: PictureKind;
  /** Pixels per inch (Ink/Stitch `dpi`, 300). */
  dpi: number;
  /** Line width of the simple picture (mm, Ink/Stitch `line_width`, 0.3). */
  lineWidth?: number;
  background?: PictureBackground;
  /** Colour of the "fabric" background. */
  fabricColor?: string;
  /** Thread weight: the realistic thread width. */
  threadWeight?: ThreadWeight;
  /** Margin around the stitches (mm). */
  margin?: number;
  /** Largest side in pixels (the picture is scaled down to fit). */
  maxSide?: number;
}

/** Ink/Stitch's defaults. */
export const PICTURE_DEFAULTS = { dpi: 300, lineWidth: 0.3 };

const THEME: Theme = { canvas: "", grid: "", gridStrong: "", axis: "", ruler: "", rulerText: "", rulerLine: "", hoop: "", select: "", dark: false };

/** Bounds of the needle penetrations (mm). */
export function planBounds(plan: PlanData): { x: number; y: number; w: number; h: number } | null {
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (let i = 0; i < plan.flags.length; i++) {
    if (plan.flags[i] & FLAG.COMMANDS) continue;
    const x = plan.coords[2 * i];
    const y = plan.coords[2 * i + 1];
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  return x1 >= x0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}

/** One colour block of a plan on its own (print sheets: the detailed views). */
export function blockPlan(plan: PlanData, block: number): PlanData {
  let k = 0;
  let start = -1;
  let end = plan.flags.length;
  for (let i = 0; i < plan.flags.length; i++) {
    if (plan.flags[i] & FLAG.COLOR_CHANGE) {
      if (k === block) {
        end = i;
        break;
      }
      k++;
      continue;
    }
    if (k === block && start < 0) start = i;
  }
  if (start < 0) start = end;
  return {
    coords: plan.coords.slice(2 * start, 2 * end),
    flags: plan.flags.slice(start, end),
    objects: plan.objects.slice(start, end),
    threads: plan.threads[block] ? [plan.threads[block]] : [],
    stats: plan.stats,
  };
}

/** Size in pixels of a picture of `plan` (before `maxSide`). */
export function pictureSize(plan: PlanData, opts: Pick<PictureOptions, "dpi" | "margin">): { w: number; h: number; scale: number } | null {
  const b = planBounds(plan);
  if (!b) return null;
  const scale = opts.dpi / 25.4;
  const m = opts.margin ?? 1;
  return { w: Math.max(1, Math.ceil((b.w + 2 * m) * scale)), h: Math.max(1, Math.ceil((b.h + 2 * m) * scale)), scale };
}

let glCanvas: HTMLCanvasElement | null = null;
let gl: StitchGL | null | undefined;
function sharedGL(): StitchGL | null {
  if (gl === undefined) {
    glCanvas = document.createElement("canvas");
    gl = StitchGL.create(glCanvas);
  }
  return gl;
}

/** Paint the stitches of `plan` into a new canvas. */
export function renderPicture(plan: PlanData, opts: PictureOptions): HTMLCanvasElement {
  const out = document.createElement("canvas");
  const b = planBounds(plan);
  const size = pictureSize(plan, opts);
  if (!b || !size) {
    out.width = out.height = 1;
    return out;
  }
  let { w, h, scale } = size;
  const max = opts.maxSide ?? 16000;
  if (Math.max(w, h) > max) {
    const f = max / Math.max(w, h);
    w = Math.max(1, Math.round(w * f));
    h = Math.max(1, Math.round(h * f));
    scale *= f;
  }
  out.width = w;
  out.height = h;
  const ctx = out.getContext("2d")!;
  const bg = opts.background ?? "transparent";
  if (bg !== "transparent") {
    ctx.fillStyle = bg === "white" ? "#ffffff" : (opts.fabricColor ?? "#f4f1ea");
    ctx.fillRect(0, 0, w, h);
  }
  const m = opts.margin ?? 1;
  // screen px of the mm origin
  const ox = (m - b.x) * scale;
  const oy = (m - b.y) * scale;
  if (opts.kind === "simple") {
    // Ink/Stitch png_simple: every colour block as flat lines, no jumps
    ctx.setTransform(scale, 0, 0, scale, ox, oy);
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.lineWidth = Math.max(0.01, opts.lineWidth ?? PICTURE_DEFAULTS.lineWidth);
    for (const c of getChunks(plan, true)) {
      ctx.strokeStyle = c.color;
      ctx.stroke(c.path);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    return out;
  }
  const g = sharedGL();
  if (!g) {
    // no WebGL: the 2D realistic renderer
    const tmp = document.createElement("canvas");
    tmp.width = w;
    tmp.height = h;
    renderPlanPreview(tmp.getContext("2d")!, plan, { width: w, height: h, dpr: 1, mode: "realistic", fabricColor: opts.fabricColor ?? "#f4f1ea", theme: THEME });
    ctx.drawImage(tmp, 0, 0);
    return out;
  }
  const glc = g.gl;
  const limit = Math.min(4096, glc.getParameter(glc.MAX_RENDERBUFFER_SIZE) as number, ...(Array.from(glc.getParameter(glc.MAX_VIEWPORT_DIMS) as Int32Array) as number[]));
  const tile = Math.max(256, limit);
  const total = plan.flags.length;
  for (let ty = 0; ty < h; ty += tile) {
    for (let tx = 0; tx < w; tx += tile) {
      const tw = Math.min(tile, w - tx);
      const th = Math.min(tile, h - ty);
      g.render({
        view: { scale, ox: ox - tx, oy: oy - ty },
        dpr: 1,
        width: tw,
        height: th,
        mode: "realistic",
        plan,
        showUnderlay: true,
        showJumps: false,
        limit: total,
        theme: THEME,
        fabricColor: opts.fabricColor ?? "#f4f1ea",
        hoop: { width: 0, height: 0 },
        threadWidth: threadWidth(opts.threadWeight),
        noFabric: true,
      });
      ctx.drawImage(glCanvas!, 0, 0, tw, th, tx, ty, tw, th);
    }
  }
  return out;
}

/** The canvas as PNG bytes. */
export function canvasPng(c: HTMLCanvasElement): Promise<Uint8Array> {
  return new Promise((resolve, reject) =>
    c.toBlob((b) => (b ? b.arrayBuffer().then((a) => resolve(new Uint8Array(a)), reject) : reject(new Error("the picture is too large to encode"))), "image/png"),
  );
}

/** Store the resolution in a PNG (pHYs chunk after IHDR), as Inkscape's
 *  export does, so the picture prints at the design's real size. */
export function withDpi(png: Uint8Array, dpi: number): Uint8Array {
  if (png.length < 33 || png[12] !== 0x49 || png[13] !== 0x48) return png; // IHDR first
  const ppm = Math.round(dpi / 0.0254);
  const chunk = new Uint8Array(21);
  const v = new DataView(chunk.buffer);
  v.setUint32(0, 9);
  chunk.set([0x70, 0x48, 0x59, 0x73], 4); // "pHYs"
  v.setUint32(8, ppm);
  v.setUint32(12, ppm);
  chunk[16] = 1; // metres
  v.setUint32(17, crc32(chunk.subarray(4, 17)));
  const at = 8 + 25; // signature + IHDR (4 + 4 + 13 + 4)
  const out = new Uint8Array(png.length + chunk.length);
  out.set(png.subarray(0, at), 0);
  out.set(chunk, at);
  out.set(png.subarray(at), at + chunk.length);
  return out;
}

/** A PNG of the plan (Ink/Stitch png_realistic / png_simple). */
export async function planPng(plan: PlanData, opts: PictureOptions): Promise<Uint8Array> {
  return withDpi(await canvasPng(renderPicture(plan, opts)), opts.dpi);
}
