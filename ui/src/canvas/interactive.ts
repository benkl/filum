// Overlay painting for the interactive tools: handles, live previews,
// satin drafting, cutter feedback, troubleshoot markers and the density map.
// Everything here is drawn in mm space on the top (overlay) canvas.

import { densityCanvas, type DensityMode } from "../lib/density";
import type { Issue } from "../lib/issues";
import { objectOutline, objectPath, shade } from "../lib/geometry";
import type { DensityField, DesignObject, PathNode, PlanData, Vec2 } from "../types";
import { FLAG } from "../types";
import { cubicAt, type Cubic } from "../lib/bezier";
import { rowDir, type Handle } from "./handles";
import type { PenHover } from "./penTool";
import { railMap } from "../lib/nodeOps";

export interface InteractiveOverlay {
  handles?: Handle[];
  activeHandle?: Handle | null;
  hoverHandle?: Handle | null;
  satin?: {
    left: Vec2[];
    right: Vec2[];
    center: Vec2[];
    zig: [Vec2, Vec2][];
    nodes: Vec2[];
    color: string;
    closing: boolean;
  } | null;
  /** Pen / satin draft: full Bézier path with every handle. */
  pen?: {
    nodes: PathNode[];
    rubber: Cubic | null;
    hover: PenHover;
    /** Point being dragged. */
    active?: number | null;
    color: string;
    /** Needle points of the running-stitch preview. */
    stitches?: Vec2[] | null;
    /** Draw the path itself (the satin draft draws its column instead). */
    drawPath: boolean;
    closable: boolean;
    closing: boolean;
  } | null;
  /** Freehand stroke: raw pointer trail and the stabilised line. */
  freehand?: { raw: Vec2[]; smooth: Vec2[]; color: string; stitches?: Vec2[] | null; width?: number; closing: boolean } | null;
  /** Node tool: where a click inserts a point. */
  insertAt?: Vec2 | null;
  /** Live corner widgets (node tool). */
  corners?: { p: Vec2 }[] | null;
  /** Rotation / scaling pivot of the selection. */
  pivot?: Vec2 | null;
  /** Smart guides while moving / scaling. */
  guides?: { axis: "x" | "y"; v: number; a: number; b: number }[] | null;
  /** Gradient annotator of the selected gradient. */
  gradient?: {
    from: Vec2;
    to: Vec2;
    kind: string;
    stops: { pos: number; color: string }[];
    active?: number | null;
    /** Mesh gradient: node grid with colours. */
    mesh?: { rows: number; cols: number; nodes: { p: Vec2; color: string }[] } | null;
    /** Freeform gradient: colour points. */
    points?: { p: Vec2; color: string; spread: number }[] | null;
    /** Selected nodes / points. */
    selected?: number[];
  } | null;
  /** Gradient vector being dragged. */
  gradDraft?: { a: Vec2; b: Vec2 } | null;
  tooltip?: { p: Vec2; text: string } | null;
  cutLine?: { a: Vec2; b: Vec2 } | null;
  cutPoint?: Vec2 | null;
  issues?: Issue[];
}

interface Ctx {
  ctx: CanvasRenderingContext2D;
  scale: number;
  dpr: number;
  ox: number;
  oy: number;
  select: string;
  dark: boolean;
}

/** The stitches of the selected objects, by object (once per plan and selection). */
const selCache = new WeakMap<PlanData, { key: string; byObj: Map<number, Path2D> }>();
function selectionStitches(plan: PlanData, selectedIndex: number[]): Map<number, Path2D> {
  const key = selectedIndex.join(",");
  const hit = selCache.get(plan);
  if (hit && hit.key === key) return hit.byObj;
  const want = new Set(selectedIndex);
  const { coords, flags, objects } = plan;
  const byObj = new Map<number, Path2D>();
  let pen = false;
  for (let i = 0; i < flags.length; i++) {
    const f = flags[i];
    if (f & FLAG.COMMANDS) {
      pen = false;
      continue;
    }
    const ob = objects[i];
    if (!want.has(ob)) {
      pen = false;
      continue;
    }
    let p = byObj.get(ob);
    if (!p) byObj.set(ob, (p = new Path2D()));
    const x = coords[2 * i];
    const y = coords[2 * i + 1];
    if (pen) p.lineTo(x, y);
    else p.moveTo(x, y);
    pen = true;
  }
  selCache.set(plan, { key, byObj });
  return byObj;
}

/** Under the selection: density map, stitch preview of the selection, fill hatching. */
export function paintUnderlays(
  c: Ctx,
  o: { plan: PlanData | null; mode: string; density: DensityField | null; densityMode: DensityMode; live?: { ids: string[]; m: number[] } | null; selected: DesignObject[]; selectedIndex: number[]; colors: Map<string, string>; overlay: InteractiveOverlay },
) {
  const { ctx, scale } = c;
  if (o.density) {
    const f = o.density;
    const img = densityCanvas(f, o.densityMode);
    if (img) {
      // the field is smooth (Gaussian): interpolate between cells
      ctx.save();
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(img, f.x0, f.y0, f.cols * f.cell, f.rows * f.cell);
      ctx.restore();
    }
  }
  // live stitch preview of the selected objects in vector mode
  if (o.mode === "vector" && o.plan && o.selectedIndex.length) {
    const byObj = selectionStitches(o.plan, o.selectedIndex);
    ctx.save();
    ctx.lineWidth = Math.max(0.08, 1 / scale);
    ctx.lineJoin = "round";
    for (const [ob, p] of byObj) {
      const obj = o.selected[o.selectedIndex.indexOf(ob)];
      const col = o.colors.get(obj?.thread ?? "") ?? "#333";
      ctx.strokeStyle = shade(col, c.dark ? 0.55 : -0.55);
      ctx.globalAlpha = 0.5;
      // a drag moves the stitches it has until the plan follows
      const m = o.live && obj && o.live.ids.includes(obj.id) ? o.live.m : null;
      if (m) {
        ctx.save();
        ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
        ctx.stroke(p);
        ctx.restore();
      } else ctx.stroke(p);
    }
    ctx.restore();
  }
  // fill rows preview while the angle / density handle is used
  const h = o.overlay.activeHandle ?? o.overlay.hoverHandle;
  if (h && (h.kind === "angle" || h.kind === "spacing")) {
    const obj = o.selected.find((x) => x.id === h.objId);
    if (obj && obj.stitch.type === "fill") {
      const st = obj.stitch;
      const d = st.method === "tatami" ? rowDir(st.angle) : [1, 0];
      const n: Vec2 = [-d[1], d[0]];
      let step = st.rowSpacing;
      while (step * scale < 5) step *= 2;
      const path = objectPath(obj);
      const ring = obj.paths.flatMap((sp) => sp.nodes.map((nd) => nd.p));
      let lo = Infinity;
      let hi = -Infinity;
      let a0 = Infinity;
      let a1 = -Infinity;
      for (const p of ring) {
        const v = p[0] * n[0] + p[1] * n[1];
        const u = p[0] * d[0] + p[1] * d[1];
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
        a0 = Math.min(a0, u);
        a1 = Math.max(a1, u);
      }
      ctx.save();
      ctx.clip(path, "evenodd");
      ctx.beginPath();
      for (let v = Math.floor(lo / step) * step; v <= hi + 2; v += step) {
        ctx.moveTo(n[0] * v + d[0] * (a0 - 5), n[1] * v + d[1] * (a0 - 5));
        ctx.lineTo(n[0] * v + d[0] * (a1 + 5), n[1] * v + d[1] * (a1 + 5));
      }
      ctx.strokeStyle = c.select;
      ctx.globalAlpha = 0.55;
      ctx.lineWidth = 1 / scale;
      ctx.stroke();
      ctx.restore();
    }
  }
}

function pin(ctx: CanvasRenderingContext2D, p: Vec2, scale: number, color: string, letter: string, faded: boolean) {
  const r = 8 / scale;
  ctx.save();
  ctx.globalAlpha = faded ? 0.75 : 1;
  ctx.fillStyle = color;
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = 1.5 / scale;
  // teardrop pin with its tip on the point
  ctx.beginPath();
  ctx.moveTo(p[0], p[1]);
  ctx.bezierCurveTo(p[0] - r * 1.1, p[1] - r * 0.9, p[0] - r * 0.9, p[1] - r * 2.4, p[0], p[1] - r * 2.4);
  ctx.bezierCurveTo(p[0] + r * 0.9, p[1] - r * 2.4, p[0] + r * 1.1, p[1] - r * 0.9, p[0], p[1]);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = "#fff";
  ctx.font = `700 ${10 / scale}px Inter, system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(letter, p[0], p[1] - r * 1.55);
  ctx.restore();
}

/** Rungs, handles, satin draft, cutter, issues, tooltip. */
export function paintInteractive(c: Ctx, o: { selected: DesignObject[]; overlay: InteractiveOverlay; onIssue?: (i: Issue) => boolean }) {
  const { ctx, scale } = c;
  const ov = o.overlay;
  // rungs of two-rail satins (node pairs act as rungs)
  for (const obj of o.selected) {
    if (obj.stitch.type !== "satin" || obj.paths.length !== 2) continue;
    const [a, b] = obj.paths;
    const map = railMap(a, b);
    if (!map) continue;
    ctx.save();
    ctx.strokeStyle = c.select;
    ctx.globalAlpha = 0.7;
    ctx.lineWidth = 1 / scale;
    ctx.setLineDash([3 / scale, 2 / scale]);
    ctx.beginPath();
    a.nodes.forEach((n, i) => {
      const m = b.nodes[map.at(i)];
      ctx.moveTo(n.p[0], n.p[1]);
      ctx.lineTo(m.p[0], m.p[1]);
    });
    ctx.stroke();
    ctx.restore();
  }

  // handles
  for (const h of ov.handles ?? []) {
    const active = ov.activeHandle && ov.activeHandle.kind === h.kind && ov.activeHandle.objId === h.objId;
    const hover = ov.hoverHandle && ov.hoverHandle.kind === h.kind && ov.hoverHandle.objId === h.objId;
    const s = (active || hover ? 1.25 : 1) / scale;
    ctx.save();
    ctx.lineWidth = 1.5 / scale;
    ctx.strokeStyle = c.select;
    ctx.fillStyle = "#fff";
    switch (h.kind) {
      case "angle": {
        const a = h.anchor!;
        const R = Math.hypot(h.p[0] - a[0], h.p[1] - a[1]);
        ctx.globalAlpha = 0.9;
        ctx.setLineDash([3 / scale, 3 / scale]);
        ctx.beginPath();
        ctx.arc(a[0], a[1], R, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
        // row direction through the dial
        ctx.beginPath();
        ctx.moveTo(a[0] - (h.p[0] - a[0]), a[1] - (h.p[1] - a[1]));
        ctx.lineTo(h.p[0], h.p[1]);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(a[0], a[1], 2.5 / scale, 0, Math.PI * 2);
        ctx.fillStyle = c.select;
        ctx.fill();
        ctx.fillStyle = c.select;
        ctx.beginPath();
        ctx.arc(h.p[0], h.p[1], 6 * s, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = "#fff";
        ctx.stroke();
        break;
      }
      case "spacing": {
        const a = h.anchor!;
        ctx.globalAlpha = 0.8;
        ctx.setLineDash([2 / scale, 3 / scale]);
        ctx.beginPath();
        ctx.moveTo(a[0], a[1]);
        ctx.lineTo(h.p[0], h.p[1]);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
        const k = 5.5 * s;
        ctx.beginPath();
        ctx.rect(h.p[0] - k, h.p[1] - k, 2 * k, 2 * k);
        ctx.fill();
        ctx.stroke();
        // density glyph: three short rows
        ctx.beginPath();
        for (const dy of [-2.2, 0, 2.2]) {
          ctx.moveTo(h.p[0] - 3 / scale, h.p[1] + dy / scale);
          ctx.lineTo(h.p[0] + 3 / scale, h.p[1] + dy / scale);
        }
        ctx.lineWidth = 1 / scale;
        ctx.stroke();
        break;
      }
      case "guide": {
        if (h.curve) {
          // the guide line itself
          ctx.save();
          ctx.lineWidth = 2.2 / scale;
          ctx.strokeStyle = "rgba(255,255,255,.85)";
          ctx.beginPath();
          h.curve.forEach((q, i) => (i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1])));
          ctx.stroke();
          ctx.setLineDash([5 / scale, 3 / scale]);
          ctx.lineWidth = 1.2 / scale;
          ctx.strokeStyle = c.select;
          ctx.stroke();
          ctx.restore();
        }
        if (h.part === "p") {
          const k = 4.5 * s;
          ctx.beginPath();
          ctx.rect(h.p[0] - k, h.p[1] - k, 2 * k, 2 * k);
          ctx.fill();
          ctx.stroke();
        } else {
          const a = h.anchor!;
          ctx.save();
          ctx.globalAlpha = 0.8;
          ctx.lineWidth = 1 / scale;
          ctx.beginPath();
          ctx.moveTo(a[0], a[1]);
          ctx.lineTo(h.p[0], h.p[1]);
          ctx.stroke();
          ctx.restore();
          ctx.beginPath();
          ctx.arc(h.p[0], h.p[1], 3.5 * s, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        }
        break;
      }
      case "ripple": {
        const r = 7 * s;
        ctx.beginPath();
        ctx.arc(h.p[0], h.p[1], r, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(h.p[0], h.p[1], r * 0.5, 0, Math.PI * 2);
        ctx.moveTo(h.p[0] - r * 1.5, h.p[1]);
        ctx.lineTo(h.p[0] - r, h.p[1]);
        ctx.moveTo(h.p[0] + r, h.p[1]);
        ctx.lineTo(h.p[0] + r * 1.5, h.p[1]);
        ctx.moveTo(h.p[0], h.p[1] - r * 1.5);
        ctx.lineTo(h.p[0], h.p[1] - r);
        ctx.moveTo(h.p[0], h.p[1] + r);
        ctx.lineTo(h.p[0], h.p[1] + r * 1.5);
        ctx.stroke();
        break;
      }
      case "center": {
        const k = 6.5 * s;
        ctx.beginPath();
        ctx.moveTo(h.p[0], h.p[1] - k);
        ctx.lineTo(h.p[0] + k, h.p[1]);
        ctx.lineTo(h.p[0], h.p[1] + k);
        ctx.lineTo(h.p[0] - k, h.p[1]);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        break;
      }
      case "width-l":
      case "width-r": {
        const a = h.anchor!;
        ctx.globalAlpha = 0.8;
        ctx.beginPath();
        ctx.moveTo(a[0], a[1]);
        ctx.lineTo(h.p[0], h.p[1]);
        ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.beginPath();
        ctx.arc(h.p[0], h.p[1], 5.5 * s, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        break;
      }
      case "reverse": {
        const d = h.dir ?? [1, 0];
        const n = [-d[1], d[0]];
        const L = 9 / scale;
        const k = (active || hover ? 1.2 : 1) * L;
        ctx.fillStyle = c.select;
        ctx.beginPath();
        ctx.arc(h.p[0], h.p[1], 10 * s, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 1.8 / scale;
        ctx.beginPath();
        ctx.moveTo(h.p[0] - d[0] * k * 0.55, h.p[1] - d[1] * k * 0.55);
        ctx.lineTo(h.p[0] + d[0] * k * 0.55, h.p[1] + d[1] * k * 0.55);
        ctx.moveTo(h.p[0] + d[0] * k * 0.55 - (d[0] - n[0]) * k * 0.35, h.p[1] + d[1] * k * 0.55 - (d[1] - n[1]) * k * 0.35);
        ctx.lineTo(h.p[0] + d[0] * k * 0.55, h.p[1] + d[1] * k * 0.55);
        ctx.lineTo(h.p[0] + d[0] * k * 0.55 - (d[0] + n[0]) * k * 0.35, h.p[1] + d[1] * k * 0.55 - (d[1] + n[1]) * k * 0.35);
        ctx.stroke();
        break;
      }
      case "text-arc": {
        // a pill with a little arch: drag up/down to bend the text
        const k = 9 * s;
        const u = h.dir ?? [0, -1];
        ctx.fillStyle = c.select;
        ctx.beginPath();
        ctx.arc(h.p[0], h.p[1], k, 0, Math.PI * 2);
        ctx.fill();
        ctx.translate(h.p[0], h.p[1]);
        ctx.rotate(Math.atan2(u[0], -u[1]));
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 1.7 / scale;
        ctx.beginPath();
        ctx.arc(0, 4.5 / scale, 6 / scale, Math.PI * 1.2, Math.PI * 1.8);
        ctx.stroke();
        break;
      }
      case "text-spacing": {
        const k = 9 * s;
        const d = h.dir ?? [1, 0];
        ctx.fillStyle = c.select;
        ctx.beginPath();
        ctx.arc(h.p[0], h.p[1], k, 0, Math.PI * 2);
        ctx.fill();
        ctx.translate(h.p[0], h.p[1]);
        ctx.rotate(Math.atan2(d[1], d[0]));
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 1.6 / scale;
        const a = 4.5 / scale;
        const b = 2.2 / scale;
        ctx.beginPath();
        ctx.moveTo(-a, 0);
        ctx.lineTo(a, 0);
        ctx.moveTo(-a + b, -b);
        ctx.lineTo(-a, 0);
        ctx.lineTo(-a + b, b);
        ctx.moveTo(a - b, -b);
        ctx.lineTo(a, 0);
        ctx.lineTo(a - b, b);
        ctx.stroke();
        break;
      }
      case "start":
        pin(ctx, h.p, scale, "#1f9d55", "S", !!h.auto);
        break;
      case "end":
        pin(ctx, h.p, scale, "#d64545", "E", !!h.auto);
        break;
    }
    ctx.restore();
  }

  // satin draft: live column, zig-zag preview and nodes
  if (ov.satin) {
    const s = ov.satin;
    if (s.left.length >= 2) {
      const poly = new Path2D();
      poly.moveTo(s.left[0][0], s.left[0][1]);
      for (const p of s.left.slice(1)) poly.lineTo(p[0], p[1]);
      for (const p of [...s.right].reverse()) poly.lineTo(p[0], p[1]);
      poly.closePath();
      ctx.save();
      ctx.fillStyle = s.color;
      ctx.globalAlpha = 0.45;
      ctx.fill(poly);
      ctx.globalAlpha = 0.9;
      ctx.strokeStyle = shade(s.color, -0.45);
      ctx.lineWidth = Math.max(0.06, 0.8 / scale);
      ctx.beginPath();
      for (const [a, b] of s.zig) {
        ctx.moveTo(a[0], a[1]);
        ctx.lineTo(b[0], b[1]);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = c.select;
      ctx.lineWidth = 1.2 / scale;
      ctx.stroke(poly);
      ctx.setLineDash([4 / scale, 3 / scale]);
      ctx.beginPath();
      s.center.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
      ctx.stroke();
      ctx.restore();
    }
    ctx.save();
    ctx.fillStyle = "#fff";
    ctx.strokeStyle = c.select;
    ctx.lineWidth = 1.5 / scale;
    s.nodes.forEach((p, i) => {
      const k = (i === 0 && s.closing ? 6 : 3.5) / scale;
      ctx.beginPath();
      ctx.rect(p[0] - k, p[1] - k, 2 * k, 2 * k);
      ctx.fill();
      ctx.stroke();
    });
    ctx.restore();
  }

  if (ov.guides) paintGuides(c, ov.guides);
  if (ov.pivot) paintPivot(c, ov.pivot);
  if (ov.gradient) paintGradient(c, ov.gradient);
  if (ov.gradDraft) paintGradient(c, { from: ov.gradDraft.a, to: ov.gradDraft.b, kind: "linear", stops: [] });
  if (ov.freehand) paintFreehand(c, ov.freehand);
  if (ov.pen) paintPen(c, ov.pen);
  if (ov.insertAt) plusMarker(c, ov.insertAt, 1);
  if (ov.corners) for (const w of ov.corners) cornerWidget(c, w.p);

  // cutter
  if (ov.cutLine) {
    const { a, b } = ov.cutLine;
    ctx.save();
    ctx.strokeStyle = "#d64545";
    ctx.lineWidth = 1.6 / scale;
    ctx.setLineDash([6 / scale, 4 / scale]);
    ctx.beginPath();
    ctx.moveTo(a[0], a[1]);
    ctx.lineTo(b[0], b[1]);
    ctx.stroke();
    ctx.restore();
  }
  if (ov.cutPoint) {
    const p = ov.cutPoint;
    const k = 6 / scale;
    ctx.save();
    ctx.strokeStyle = "#d64545";
    ctx.lineWidth = 2 / scale;
    ctx.beginPath();
    ctx.moveTo(p[0] - k, p[1] - k);
    ctx.lineTo(p[0] + k, p[1] + k);
    ctx.moveTo(p[0] + k, p[1] - k);
    ctx.lineTo(p[0] - k, p[1] + k);
    ctx.stroke();
    ctx.restore();
  }

  // troubleshoot markers
  for (const is of ov.issues ?? []) {
    const p = is.at;
    const k = 7 / scale;
    ctx.save();
    ctx.fillStyle = is.level === "error" ? "#d64545" : is.level === "warning" ? "#e0a106" : "#3d93f0";
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 1.2 / scale;
    ctx.beginPath();
    ctx.moveTo(p[0], p[1] - k * 1.1);
    ctx.lineTo(p[0] + k, p[1] + k * 0.75);
    ctx.lineTo(p[0] - k, p[1] + k * 0.75);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#fff";
    ctx.font = `800 ${9 / scale}px Inter, system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("!", p[0], p[1] + k * 0.12);
    ctx.restore();
  }

  // value read-out next to the cursor
  if (ov.tooltip) {
    const { p, text } = ov.tooltip;
    ctx.save();
    ctx.setTransform(c.dpr, 0, 0, c.dpr, 0, 0);
    ctx.font = "600 12px Inter, system-ui, sans-serif";
    const tw = ctx.measureText(text).width;
    // keep the tip inside the view: flip to the left / below near the edges
    const vw = ctx.canvas.width / c.dpr;
    const px = c.ox + p[0] * scale;
    const py = c.oy + p[1] * scale;
    const sx = px + 14 + tw + 10 > vw ? Math.max(8, px - 14 - tw) : px + 14;
    const sy = py - 14 < 40 ? py + 30 : py - 14;
    ctx.fillStyle = c.dark ? "rgba(20,20,20,.92)" : "rgba(30,30,30,.88)";
    ctx.beginPath();
    ctx.roundRect(sx - 7, sy - 15, tw + 14, 22, 6);
    ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.fillText(text, sx, sy);
    ctx.restore();
  }
  void objectOutline;
}

function plusMarker(c: Ctx, p: Vec2, k: number) {
  const { ctx, scale } = c;
  const r = (7 * k) / scale;
  ctx.save();
  ctx.fillStyle = c.select;
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = 1.6 / scale;
  ctx.beginPath();
  ctx.arc(p[0], p[1], r, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(p[0] - r * 0.5, p[1]);
  ctx.lineTo(p[0] + r * 0.5, p[1]);
  ctx.moveTo(p[0], p[1] - r * 0.5);
  ctx.lineTo(p[0], p[1] + r * 0.5);
  ctx.stroke();
  ctx.restore();
}

function stitchDots(c: Ctx, pts: Vec2[], color: string) {
  const { ctx, scale } = c;
  if (pts.length < 2) return;
  ctx.save();
  // the stitches themselves, then the needle points
  ctx.strokeStyle = color;
  ctx.globalAlpha = 0.9;
  ctx.lineWidth = Math.max(0.25, 2.2 / scale);
  ctx.lineCap = "round";
  ctx.beginPath();
  pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.fillStyle = shade(color, -0.5);
  const r = Math.max(0.1, 1.3 / scale);
  ctx.beginPath();
  for (const p of pts) {
    ctx.moveTo(p[0] + r, p[1]);
    ctx.arc(p[0], p[1], r, 0, Math.PI * 2);
  }
  ctx.fill();
  ctx.restore();
}

function paintFreehand(c: Ctx, f: NonNullable<InteractiveOverlay["freehand"]>) {
  const { ctx, scale } = c;
  ctx.save();
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  // raw pointer trail, faint
  if (f.raw.length > 1) {
    ctx.strokeStyle = c.select;
    ctx.globalAlpha = 0.25;
    ctx.lineWidth = 1 / scale;
    ctx.beginPath();
    f.raw.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
  if (f.width && f.smooth.length > 1) {
    ctx.strokeStyle = f.color;
    ctx.globalAlpha = 0.4;
    ctx.lineWidth = f.width;
    ctx.beginPath();
    f.smooth.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
  if (f.stitches && f.stitches.length > 1) stitchDots(c, f.stitches, f.color);
  else if (f.smooth.length > 1) {
    ctx.strokeStyle = f.color;
    ctx.lineWidth = 2 / scale;
    ctx.beginPath();
    f.smooth.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
    ctx.stroke();
  }
  // the brush tip lags behind the pointer (stabiliser)
  const tip = f.smooth[f.smooth.length - 1];
  const ptr = f.raw[f.raw.length - 1];
  if (tip && ptr) {
    ctx.strokeStyle = c.select;
    ctx.lineWidth = 1 / scale;
    ctx.setLineDash([2 / scale, 2 / scale]);
    ctx.beginPath();
    ctx.moveTo(tip[0], tip[1]);
    ctx.lineTo(ptr[0], ptr[1]);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "#fff";
    ctx.beginPath();
    ctx.arc(tip[0], tip[1], 3 / scale, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
  if (f.closing && f.smooth.length) {
    const p0 = f.smooth[0];
    ctx.strokeStyle = c.select;
    ctx.lineWidth = 1.6 / scale;
    ctx.beginPath();
    ctx.arc(p0[0], p0[1], 7 / scale, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

function paintPen(c: Ctx, pen: NonNullable<InteractiveOverlay["pen"]>) {
  const { ctx, scale } = c;
  const nodes = pen.nodes;
  ctx.save();
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  const pathOf = () => {
    const p = new Path2D();
    nodes.forEach((n, i) => {
      if (!i) return p.moveTo(n.p[0], n.p[1]);
      const a = nodes[i - 1];
      if (a.o || n.i) p.bezierCurveTo((a.o ?? a.p)[0], (a.o ?? a.p)[1], (n.i ?? n.p)[0], (n.i ?? n.p)[1], n.p[0], n.p[1]);
      else p.lineTo(n.p[0], n.p[1]);
    });
    return p;
  };
  if (pen.drawPath && nodes.length > 1) {
    if (pen.stitches && pen.stitches.length > 1) stitchDots(c, pen.stitches, pen.color);
    ctx.strokeStyle = c.select;
    ctx.lineWidth = 1.2 / scale;
    ctx.stroke(pathOf());
  }
  // rubber band to the cursor (or the closing curve)
  if (pen.rubber) {
    const [a, b, d, e] = pen.rubber;
    ctx.strokeStyle = c.select;
    ctx.lineWidth = 1.2 / scale;
    ctx.setLineDash([5 / scale, 4 / scale]);
    ctx.beginPath();
    ctx.moveTo(a[0], a[1]);
    ctx.bezierCurveTo(b[0], b[1], d[0], d[1], e[0], e[1]);
    ctx.stroke();
    ctx.setLineDash([]);
    if (pen.drawPath) {
      // curvature hint: the middle of the next segment
      const m = cubicAt(pen.rubber, 0.5);
      ctx.fillStyle = c.select;
      ctx.globalAlpha = 0.5;
      ctx.beginPath();
      ctx.arc(m[0], m[1], 1.8 / scale, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
  }
  // handles of every point
  ctx.lineWidth = 1 / scale;
  nodes.forEach((n, i) => {
    for (const part of ["i", "o"] as const) {
      const h = n[part];
      if (!h) continue;
      const hot = pen.hover.kind === "handle" && pen.hover.index === i && pen.hover.part === part;
      ctx.strokeStyle = c.select;
      ctx.globalAlpha = 0.85;
      ctx.beginPath();
      ctx.moveTo(n.p[0], n.p[1]);
      ctx.lineTo(h[0], h[1]);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillStyle = hot ? c.select : "#fff";
      ctx.beginPath();
      ctx.arc(h[0], h[1], (hot ? 4.2 : 3.2) / scale, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  });
  // points: squares for corners, circles for smooth points
  nodes.forEach((n, i) => {
    const first = i === 0;
    const last = i === nodes.length - 1;
    const hot =
      (pen.hover.kind === "anchor" && pen.hover.index === i) ||
      (pen.hover.kind === "close" && first) ||
      (pen.hover.kind === "last" && last) ||
      pen.active === i;
    const k = (hot ? 5 : first && pen.closable ? 4.5 : 3.6) / scale;
    ctx.fillStyle = hot || last ? c.select : "#fff";
    ctx.strokeStyle = c.select;
    ctx.lineWidth = 1.4 / scale;
    ctx.beginPath();
    if (n.i || n.o) ctx.arc(n.p[0], n.p[1], k, 0, Math.PI * 2);
    else ctx.rect(n.p[0] - k, n.p[1] - k, 2 * k, 2 * k);
    ctx.fill();
    ctx.stroke();
    if (first && (pen.closing || pen.hover.kind === "close")) {
      ctx.beginPath();
      ctx.arc(n.p[0], n.p[1], 8 / scale, 0, Math.PI * 2);
      ctx.stroke();
    }
  });
  if (pen.hover.kind === "segment") plusMarker(c, pen.hover.p, 0.85);
  ctx.restore();
}

const GUIDE = "#e0368c";

function paintGuides(c: Ctx, guides: NonNullable<InteractiveOverlay["guides"]>) {
  const { ctx, scale } = c;
  ctx.save();
  ctx.strokeStyle = GUIDE;
  ctx.lineWidth = 1.5 / scale;
  const ext = 12 / scale;
  ctx.beginPath();
  for (const g of guides) {
    if (g.axis === "x") {
      ctx.moveTo(g.v, g.a - ext);
      ctx.lineTo(g.v, g.b + ext);
    } else {
      ctx.moveTo(g.a - ext, g.v);
      ctx.lineTo(g.b + ext, g.v);
    }
  }
  ctx.stroke();
  // small crosses at the ends
  ctx.beginPath();
  const k = 3 / scale;
  for (const g of guides)
    for (const e of [g.a - ext, g.b + ext]) {
      const [x, y] = g.axis === "x" ? [g.v, e] : [e, g.v];
      ctx.moveTo(x - k, y - k);
      ctx.lineTo(x + k, y + k);
      ctx.moveTo(x + k, y - k);
      ctx.lineTo(x - k, y + k);
    }
  ctx.stroke();
  ctx.restore();
}

function paintPivot(c: Ctx, p: Vec2) {
  const { ctx, scale } = c;
  const r = 5 / scale;
  ctx.save();
  ctx.lineWidth = 1.2 / scale;
  ctx.strokeStyle = c.select;
  ctx.fillStyle = "#fff";
  ctx.beginPath();
  ctx.arc(p[0], p[1], r, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(p[0] - r * 1.8, p[1]);
  ctx.lineTo(p[0] + r * 1.8, p[1]);
  ctx.moveTo(p[0], p[1] - r * 1.8);
  ctx.lineTo(p[0], p[1] + r * 1.8);
  ctx.stroke();
  ctx.restore();
}

/** Mesh lines and nodes, or freeform points with their spread. */
function paintGradient2D(c: Ctx, g: NonNullable<InteractiveOverlay["gradient"]>) {
  const { ctx, scale } = c;
  const sel = new Set(g.selected ?? []);
  ctx.save();
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  if (g.mesh) {
    const { rows, cols, nodes } = g.mesh;
    const at = (r: number, k: number) => nodes[r * cols + k].p;
    // mesh lines: dark halo + light core so they read on any thread
    for (const [w, col] of [
      [3, "rgba(0,0,0,.45)"],
      [1.2, "rgba(255,255,255,.95)"],
    ] as const) {
      ctx.strokeStyle = col;
      ctx.lineWidth = w / scale;
      ctx.beginPath();
      for (let r = 0; r < rows; r++) {
        ctx.moveTo(at(r, 0)[0], at(r, 0)[1]);
        for (let k = 1; k < cols; k++) ctx.lineTo(at(r, k)[0], at(r, k)[1]);
      }
      for (let k = 0; k < cols; k++) {
        ctx.moveTo(at(0, k)[0], at(0, k)[1]);
        for (let r = 1; r < rows; r++) ctx.lineTo(at(r, k)[0], at(r, k)[1]);
      }
      ctx.stroke();
    }
    // nodes: diamonds in their thread colour
    nodes.forEach((n, i) => {
      const on = sel.has(i);
      const k = (on ? 7 : 5.5) / scale;
      ctx.beginPath();
      ctx.moveTo(n.p[0], n.p[1] - k);
      ctx.lineTo(n.p[0] + k, n.p[1]);
      ctx.lineTo(n.p[0], n.p[1] + k);
      ctx.lineTo(n.p[0] - k, n.p[1]);
      ctx.closePath();
      ctx.fillStyle = n.color;
      ctx.fill();
      ctx.strokeStyle = on ? c.select : "#fff";
      ctx.lineWidth = (on ? 2.4 : 1.8) / scale;
      ctx.stroke();
      ctx.strokeStyle = "rgba(0,0,0,.6)";
      ctx.lineWidth = 0.8 / scale;
      const k2 = k + 1.6 / scale;
      ctx.beginPath();
      ctx.moveTo(n.p[0], n.p[1] - k2);
      ctx.lineTo(n.p[0] + k2, n.p[1]);
      ctx.lineTo(n.p[0], n.p[1] + k2);
      ctx.lineTo(n.p[0] - k2, n.p[1]);
      ctx.closePath();
      ctx.stroke();
    });
  }
  if (g.points) {
    // spread rings of the selected points, with a handle to resize
    g.points.forEach((q, i) => {
      if (!sel.has(i)) return;
      ctx.setLineDash([4 / scale, 3 / scale]);
      ctx.strokeStyle = "rgba(0,0,0,.45)";
      ctx.lineWidth = 2.2 / scale;
      ctx.beginPath();
      ctx.arc(q.p[0], q.p[1], q.spread, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 1 / scale;
      ctx.stroke();
      ctx.setLineDash([]);
      const h: Vec2 = [q.p[0] + q.spread, q.p[1]];
      const k = 4 / scale;
      ctx.fillStyle = "#fff";
      ctx.strokeStyle = c.select;
      ctx.lineWidth = 1.5 / scale;
      ctx.beginPath();
      ctx.rect(h[0] - k, h[1] - k, 2 * k, 2 * k);
      ctx.fill();
      ctx.stroke();
    });
    g.points.forEach((q, i) => {
      const on = sel.has(i);
      const r = (on ? 8.5 : 7) / scale;
      ctx.fillStyle = q.color;
      ctx.strokeStyle = on ? c.select : "#fff";
      ctx.lineWidth = (on ? 3 : 2.4) / scale;
      ctx.beginPath();
      ctx.arc(q.p[0], q.p[1], r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.strokeStyle = "rgba(0,0,0,.6)";
      ctx.lineWidth = 0.8 / scale;
      ctx.beginPath();
      ctx.arc(q.p[0], q.p[1], r + 1.5 / scale, 0, Math.PI * 2);
      ctx.stroke();
    });
  }
  ctx.restore();
}

function paintGradient(c: Ctx, g: NonNullable<InteractiveOverlay["gradient"]>) {
  if (g.mesh || g.points) return paintGradient2D(c, g);
  const { ctx, scale } = c;
  const [a, b] = [g.from, g.to];
  ctx.save();
  ctx.lineCap = "round";
  // radial / conic: show the reach around the start
  if (g.kind === "radial" || g.kind === "conic") {
    const r = Math.hypot(b[0] - a[0], b[1] - a[1]);
    ctx.setLineDash([4 / scale, 3 / scale]);
    ctx.strokeStyle = c.select;
    ctx.lineWidth = 1 / scale;
    ctx.beginPath();
    ctx.arc(a[0], a[1], r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  // the vector: dark outline + light core, readable on any thread colour
  for (const [w, col] of [
    [4, "rgba(0,0,0,.55)"],
    [2, "#fff"],
  ] as const) {
    ctx.strokeStyle = col;
    ctx.lineWidth = w / scale;
    ctx.beginPath();
    ctx.moveTo(a[0], a[1]);
    ctx.lineTo(b[0], b[1]);
    ctx.stroke();
  }
  // start: circle, end: square
  ctx.fillStyle = "#fff";
  ctx.strokeStyle = "rgba(0,0,0,.7)";
  ctx.lineWidth = 1.4 / scale;
  ctx.beginPath();
  ctx.arc(a[0], a[1], 5 / scale, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  const k = 4.5 / scale;
  ctx.beginPath();
  ctx.rect(b[0] - k, b[1] - k, 2 * k, 2 * k);
  ctx.fill();
  ctx.stroke();
  // colour stops along the vector
  g.stops.forEach((s, i) => {
    const p: Vec2 = [a[0] + (b[0] - a[0]) * s.pos, a[1] + (b[1] - a[1]) * s.pos];
    const r = (i === g.active ? 8 : 6.5) / scale;
    ctx.fillStyle = s.color;
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 2.2 / scale;
    ctx.beginPath();
    ctx.arc(p[0], p[1], r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.strokeStyle = "rgba(0,0,0,.6)";
    ctx.lineWidth = 0.8 / scale;
    ctx.beginPath();
    ctx.arc(p[0], p[1], r + 1.2 / scale, 0, Math.PI * 2);
    ctx.stroke();
  });
  ctx.restore();
}

/** Live corner widget: a ring with a dot. */
function cornerWidget(c: Ctx, p: Vec2) {
  const { ctx, scale } = c;
  const r = 3.6 / scale;
  ctx.save();
  ctx.beginPath();
  ctx.arc(p[0], p[1], r, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(255,255,255,.95)";
  ctx.fill();
  ctx.lineWidth = 1.3 / scale;
  ctx.strokeStyle = c.select;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(p[0], p[1], 1.2 / scale, 0, Math.PI * 2);
  ctx.fillStyle = c.select;
  ctx.fill();
  ctx.restore();
}
