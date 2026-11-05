import { useCallback, useEffect, useRef, useState } from "react";
import { Menu } from "../components/MenuBar";
import { contextMenu } from "../components/menuModel";
import { clipFromText, copySelection, pasteClipboard } from "../lib/arrange";
import { setDensityHover } from "../lib/density";
import { ImagePlus } from "lucide-react";
import { Digitize } from "../icons/stitch";
import {
  applyMat,
  dist,
  ellipsePath,
  objectBounds,
  objectBoundsCached,
  objectOutline,
  objectPath,
  rectPath,
  rotateAbout,
  scaleAbout,
  transformObject,
  translateMat,
  uid,
  unionBoxes,
  defaultStitch,
  type Box,
} from "../lib/geometry";
import { useStore } from "../store";
import type { DesignObject, NodeRef, PathNode, ReferenceImage, StitchDocument, StitchParams, SubPath, Vec2 } from "../types";
import { handlesCollinear, joinNodes, moveNodes, nodeKey, nodesInBox } from "../lib/nodeOps";
import { syncAll } from "../lib/nodeActions";
import { addReference, refCenter, refContains, refCorners, referenceAt, refRotateKnob, toLocal, toWorld } from "../lib/references";
import { ReferenceBar } from "../components/ReferenceBar";
import { applyRamp, rampMembers, rampOf, rampRows, selectedRamp, updateRamp } from "../lib/ramp";
import { guideAcross, guideHit, guidesOf, selectedSatin, setGuides } from "../lib/satinGuides";
import { engine, type ShapeRegion } from "../engine/client";
import { handlePoints, readTheme, Renderer, rotateHandle, RULER, type Overlay, type Theme } from "./render";
import { StitchGL } from "./gl";
import { threadWidth } from "../lib/materials";
import { computeHandles, computeTextHandles, dragHandle, HANDLE_HIT_PX, reverseObject, type Handle } from "./handles";
import { createTextAt, selectedTextGroup, textSpec, updateText } from "../lib/textOps";
import { members, type TextSpec } from "../lib/text";
import type { InteractiveOverlay } from "./interactive";
import { buildSatin, satinOutlineOf, zigzagPreview } from "../lib/satinDraw";
import {
  addPoint,
  canClose,
  continueFrom,
  deleteFromDraft,
  insertInDraft,
  moveAnchor,
  moveHandle,
  newDraft,
  PEN_HINTS,
  penHitTest,
  placePoint,
  pullHandles,
  removeLast,
  rubberBand,
  toggleSmoothInDraft,
  type PenDraft,
  type PenHover,
} from "./penTool";
import { extendStroke, finishStroke, isClosedStroke, ropeLength, startStroke, strokeToPath, type FreehandStroke } from "./freehand";
import { constrainAngle, deleteNode, flattenSubPath, insertNode, nearestOnSubPath, resample, toggleSmooth } from "../lib/bezier";
import { defaultRunning, type Mat } from "../lib/geometry";
import { ROTATE_CURSOR, SKEW_CURSOR, rotateZone, skewAbout, snapBox, snapTargets, unitIds, type SnapTargets } from "./transform";
import {
  commit2D,
  is2D,
  makeGradient,
  makeGradient2D,
  meshInsert,
  meshLineHit,
  meshLocate,
  meshValid,
  nodeHit,
  removeNodes,
  selectedGradient,
  setStops,
  stopsOf,
  syncGradientGeometry,
  updateGradient,
  weightsAt,
  type StopEdit,
} from "../lib/gradient";
import type { GradientParams } from "../types";
import { cutFillObject, cutPathObject, cutSatinObject, nearestOnPaths } from "../lib/cut";
import { computeIssues } from "../lib/issues";
import { issuesShown } from "../lib/panelActions";
import { displayPlan } from "../lib/threads";
import { cornerWidgets, radiusFromWidget, roundCorners, shapeToolPath, type CornerStyle } from "../lib/shapeOps";
import { openDroppedFile } from "../lib/actions";
import { flatten as flattenSub, normAngle } from "../lib/geometry";

const hitCtx = (() => {
  const c = document.createElement("canvas");
  c.width = c.height = 1;
  return c.getContext("2d")!;
})();

function hitObject(o: DesignObject, p: Vec2, tol: number): boolean {
  const st = o.stitch;
  if (st.type === "satin") {
    const path = objectOutline(o);
    if (path && hitCtx.isPointInPath(path, p[0], p[1], "evenodd")) return true;
    hitCtx.lineWidth = tol * 2;
    return !!path && hitCtx.isPointInStroke(path, p[0], p[1]);
  }
  const path = objectPath(o);
  if ((st.type === "fill" || st.type === "none" || st.type === "applique") && hitCtx.isPointInPath(path, p[0], p[1], "evenodd")) return true;
  hitCtx.lineWidth = Math.max(tol * 2, 0.6);
  return hitCtx.isPointInStroke(path, p[0], p[1]);
}

type Drag =
  | { kind: "pan"; sx: number; sy: number; ox: number; oy: number }
  | { kind: "marquee"; a: Vec2; add: boolean }
  | { kind: "move"; start: Vec2; orig: DesignObject[]; moved: boolean; targets: SnapTargets | null }
  | { kind: "scale"; handle: number; box: Box; orig: DesignObject[]; uniform: boolean; targets: SnapTargets | null; pivot: Vec2 }
  | { kind: "rotate"; center: Vec2; a0: number; orig: DesignObject[] }
  | { kind: "skew"; handle: number; box: Box; orig: DesignObject[]; start: Vec2; pivot: Vec2 }
  | { kind: "pivot"; key: string }
  | { kind: "gradvec"; a: Vec2; target: string | null; group: string | null }
  | { kind: "gradend"; which: "from" | "to"; group: string }
  | { kind: "gradstop"; index: number; group: string; stops: StopEdit[]; g: GradientParams }
  | { kind: "gradnode"; group: string; idx: number[]; orig: Vec2[]; start: Vec2; moved: boolean }
  | { kind: "gradspread"; group: string; idx: number }
  | { kind: "corner"; id: string; sp: number; k: number; orig: DesignObject; all: boolean; p: Vec2; dir: Vec2; phi: number }
  | { kind: "node"; id: string; sp: number; ni: number; part: "p" | "i" | "o"; orig: DesignObject }
  | { kind: "shape"; shape: "rect" | "ellipse"; a: Vec2 }
  | { kind: "freehand" }
  | { kind: "ruler"; a: Vec2 }
  | { kind: "handle"; h: Handle; orig: DesignObject; moved: boolean }
  | { kind: "texthandle"; h: Handle; group: string; spec: TextSpec; start: Vec2; moved: boolean }
  | { kind: "pen-new"; idx: number; moved: boolean; last: Vec2 }
  | { kind: "pen-close"; moved: boolean }
  | { kind: "pen-last"; moved: boolean; keepIn?: Vec2 }
  | { kind: "pen-anchor"; idx: number; orig: PathNode; start: Vec2; moved: boolean }
  | { kind: "pen-handle"; idx: number; part: "i" | "o"; orig: PathNode }
  | { kind: "cut"; a: Vec2; moved: boolean }
  | { kind: "nodes"; start: Vec2; orig: StitchDocument; sel: NodeRef[]; moved: boolean; anchor: Vec2 }
  | { kind: "nodemarquee"; a: Vec2; add: boolean; hit: DesignObject | null }
  | { kind: "ref"; mode: "move" | "scale" | "rotate"; orig: ReferenceImage; start: Vec2; corner: number; a0: number; moved: boolean }
  | { kind: "rampend"; id: string; which: "from" | "to"; moved: boolean }
  | { kind: "rampvec"; a: Vec2; target: string | null; mode: "density" | "blend" }
  | { kind: "build"; faces: number[]; del: boolean }
  | { kind: "guideend"; id: string; index: number; end: 0 | 1; moved: boolean }
  | { kind: "guidemove"; id: string; index: number; start: Vec2; orig: [Vec2, Vec2]; moved: boolean }
  | { kind: "guidedraw"; id: string; a: Vec2 };

const HANDLE_HINTS: Record<string, string> = {
  angle: "Drag to set the fill angle (Shift: 15° steps)",
  spacing: "Drag to change the density",
  center: "Drag to move the radial centre",
  "width-l": "Drag to change the column width",
  "width-r": "Drag to change the column width",
  reverse: "Click to sew the other way",
  start: "Drag to move the start · double-click for auto",
  end: "Drag to move the end · double-click for auto",
  "text-arc": "Drag up or down to bend the text (Shift: 15° steps) · double-click to straighten",
  "text-spacing": "Drag to change the letter spacing · double-click to reset",
};

const isPathObject = (o: DesignObject) =>
  o.stitch.type === "running" || o.stitch.type === "manual" || (o.stitch.type === "satin" && o.paths.length === 1);

function segmentsCross(a: Vec2, b: Vec2, c: Vec2, d: Vec2) {
  const o = (p: Vec2, q: Vec2, r: Vec2) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  return o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0;
}

/** Does the segment a→b cross the object's outline? */
function crossesObject(o: DesignObject, a: Vec2, b: Vec2) {
  return o.paths.some((sp) => {
    const pts = flattenSub(sp);
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const q = pts[(i + 1) % pts.length];
      if (segmentsCross(a, b, p, q)) return true;
    }
    return false;
  });
}

function nextName(objs: DesignObject[], base: string) {
  let n = 1;
  while (objs.some((o) => o.name === `${base} ${n}`)) n++;
  return `${base} ${n}`;
}

/** The GL view of a drag transform: which objects (by index) and the matrix; the mask is kept while the set is the same. */
let liveMask: { key: string; n: number; mask: Uint8Array } | null = null;
function liveFrame(doc: StitchDocument, live: { ids: string[]; m: Mat } | null) {
  if (!live) return null;
  const key = live.ids.join(",");
  if (!liveMask || liveMask.key !== key || liveMask.n !== doc.objects.length) {
    const ids = new Set(live.ids);
    const mask = new Uint8Array(doc.objects.length);
    doc.objects.forEach((o, i) => {
      if (ids.has(o.id)) mask[i] = 255;
    });
    liveMask = { key, n: doc.objects.length, mask };
  }
  return { key, mask: liveMask.mask, m: live.m };
}

export function fitView(width: number, height: number, box: Box) {
  const pad = 40;
  const w = Math.max(10, width - RULER - pad * 2);
  const h = Math.max(10, height - RULER - pad * 2);
  const scale = Math.min(w / box.w, h / box.h);
  return {
    scale,
    ox: RULER + pad + (w - box.w * scale) / 2 - box.x * scale,
    oy: RULER + pad + (h - box.h * scale) / 2 - box.y * scale,
  };
}

// The viewport is three stacked canvases; these helpers flatten them for
// screenshots (production sheet) and the stitch-out video recorder.
const layers: { bg: HTMLCanvasElement | null; gl: HTMLCanvasElement | null; top: HTMLCanvasElement | null } = { bg: null, gl: null, top: null };
let capture: HTMLCanvasElement | null = null;

function flatten(into: HTMLCanvasElement) {
  const { bg, gl, top } = layers;
  if (!bg || !top) return;
  if (into.width !== bg.width || into.height !== bg.height) {
    into.width = bg.width;
    into.height = bg.height;
  }
  const g = into.getContext("2d")!;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.drawImage(bg, 0, 0);
  if (gl) g.drawImage(gl, 0, 0);
  g.drawImage(top, 0, 0);
}

function captureFrame() {
  if (capture) flatten(capture);
}

/** A flattened copy of the current viewport. */
export function snapshotViewport(): HTMLCanvasElement {
  const c = document.createElement("canvas");
  flatten(c);
  return c;
}

/** Start mirroring every rendered frame into a canvas (for MediaRecorder). */
/** Corner style of the live corner widgets (Alt-click a widget to cycle). */
let cornerStyle: CornerStyle = "round";

export function startCapture(): HTMLCanvasElement {
  capture = document.createElement("canvas");
  flatten(capture);
  return capture;
}

export function stopCapture() {
  capture = null;
}

export function Canvas() {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sizeRef = useRef({ w: 800, h: 600, dpr: 1 });
  const themeRef = useRef<Theme | null>(null);
  const overlayRef = useRef<Overlay>({});
  const dragRef = useRef<Drag | null>(null);
  /** A right-button press: a click opens the context menu, a drag pans. */
  const rightRef = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const penRef = useRef<PenDraft | null>(null);
  const penHoverRef = useRef<PenHover>({ kind: "none" });
  const fhRef = useRef<FreehandStroke | null>(null);
  /** Transform pivot of the current selection (key = selected ids). */
  const pivotRef = useRef<{ key: string; p: Vec2 } | null>(null);
  if (import.meta.env.DEV) Object.assign(window, { __pen: penRef });
  const iRef = useRef<InteractiveOverlay>({});
  const handlesRef = useRef<Handle[]>([]);
  const spaceRef = useRef(false);
  const rafRef = useRef(0);
  const rendererRef = useRef<Renderer>(new Renderer());
  // layers, bottom to top: background (2D) · stitches (WebGL2) · overlays + input (2D)
  const bgRef = useRef<HTMLCanvasElement>(null);
  const glCanvasRef = useRef<HTMLCanvasElement>(null);
  const glRef = useRef<StitchGL | null | undefined>(undefined);
  const glDirtyRef = useRef(false);

  const draw = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      const c = canvasRef.current;
      const bg = bgRef.current;
      if (!c || !bg) return;
      const s = useStore.getState();
      if (!themeRef.current) themeRef.current = readTheme(c);
      const { w, h, dpr } = sizeRef.current;
      if (glRef.current === undefined && glCanvasRef.current) glRef.current = StitchGL.create(glCanvasRef.current);
      const gl = glRef.current;
      const shownPlan = displayPlan(s.plan, s.stitchColors, s.colorFocus ? s.activeThread : null, s.fabricColor);
      const useGL = !!gl && s.viewMode !== "vector" && !!s.plan;
      // snap to device pixels once so every layer agrees exactly
      const view = { scale: s.view.scale, ox: Math.round(s.view.ox * dpr) / dpr, oy: Math.round(s.view.oy * dpr) / dpr };
      const selIndex =
        s.selection.length === 1 && s.tool === "select" && s.anim.index == null ? s.doc.objects.findIndex((o) => o.id === s.selection[0]) : -1;
      const tg = s.tool === "select" && s.anim.index == null && !s.editingText ? selectedTextGroup() : null;
      const tspec = tg ? textSpec(tg) : null;
      handlesRef.current =
        tg && tspec
          ? computeTextHandles(members(s.doc.objects, tg), tspec.rotation, s.view.scale)
          : selIndex >= 0
            ? computeHandles(s.doc.objects[selIndex], selIndex, s.plan, s.view.scale)
            : [];
      const threadColor = s.doc.threads.find((t) => t.id === (s.activeThread ?? s.doc.threads[0]?.id))?.color ?? "#b3203a";
      const pd = (s.tool === "pen" || s.tool === "satin") && penRef.current?.nodes.length ? penRef.current : null;
      // the shortcut hints follow the drawing state
      if (!!pd !== s.drafting) queueMicrotask(() => useStore.setState({ drafting: !!pd }));
      let satinOv: InteractiveOverlay["satin"] = null;
      let penOv: InteractiveOverlay["pen"] = null;
      if (pd) {
        if (pd.kind === "satin") pd.width = s.toolOptions.satin.width;
        const hover = penHoverRef.current;
        const closing = hover.kind === "close" && canClose(pd);
        const dr = dragRef.current;
        const active = dr && "idx" in dr && typeof dr.idx === "number" && dr.kind !== "gradspread" ? dr.idx : null;
        const withCursor = hover.kind === "none" && !!pd.cursor && !dragRef.current;
        if (pd.kind === "satin") {
          const nodes = withCursor ? [...pd.nodes, { p: pd.cursor! }] : pd.nodes;
          const widths = withCursor ? [...pd.widths, pd.width] : pd.widths;
          const ol = satinOutlineOf(nodes, widths, closing);
          satinOv = {
            left: ol.left,
            right: ol.right,
            center: ol.center,
            zig: zigzagPreview(ol.left, ol.right, ol.center, Math.max(0.4, 5 / s.view.scale)),
            nodes: [],
            color: threadColor,
            closing,
          };
        }
        const len = s.toolOptions.pen.length;
        penOv = {
          nodes: pd.nodes,
          rubber: pd.kind === "run" && (withCursor || closing) ? rubberBand(pd, closing) : null,
          hover,
          active,
          color: threadColor,
          stitches: pd.kind === "run" ? resample(flattenSubPath({ nodes: pd.nodes, closed: closing }, 0.2), len) : null,
          drawPath: pd.kind === "run",
          closable: canClose(pd),
          closing,
        };
      }
      const fh = s.tool === "freehand" ? fhRef.current : null;
      const fo = s.toolOptions.freehand;
      const freehandOv: InteractiveOverlay["freehand"] = fh
        ? {
            raw: fh.raw,
            smooth: fh.smooth,
            color: threadColor,
            stitches: fo.output === "satin" ? null : resample(fh.smooth, s.toolOptions.pen.length),
            width: fo.output === "satin" ? fo.width : undefined,
            closing: isClosedStroke([...fh.smooth, fh.raw[fh.raw.length - 1]], s.view.scale),
          }
        : null;
      // transform pivot of the selection
      let pivot: Vec2 | null = null;
      if (s.tool === "select" && s.selection.length && s.anim.index == null && !s.editingText) {
        const sb = unionBoxes(s.doc.objects.filter((o) => s.selection.includes(o.id)).map(objectBoundsCached));
        if (sb) pivot = pivotOf(sb);
      }
      // gradient annotator
      let gradOv: InteractiveOverlay["gradient"] = null;
      if (s.tool === "gradient") {
        const sg = selectedGradient();
        if (sg) {
          const stops = stopsOf(s.doc, sg.group);
          const colors = stops.map((st) => s.doc.threads.find((t) => t.id === st.thread)?.color ?? "#888");
          const colorOf = (c: number) => colors[Math.min(colors.length - 1, Math.max(0, c))] ?? "#888";
          const g = sg.params;
          gradOv = {
            from: g.from,
            to: g.to,
            kind: g.kind,
            stops: stops.map((st, i) => ({ pos: st.pos, color: colors[i] })),
            active: dragRef.current?.kind === "gradstop" ? dragRef.current.index : null,
            mesh: g.kind === "mesh" && meshValid(g.mesh) ? { rows: g.mesh.rows, cols: g.mesh.cols, nodes: g.mesh.nodes.map((n) => ({ p: n.p, color: colorOf(n.c) })) } : null,
            points: g.kind === "freeform" ? (g.points ?? []).map((q) => ({ p: q.p, color: colorOf(q.c), spread: q.spread })) : null,
            selected: s.gradNodes,
          };
        }
      }
      // live corner widgets of the selected shapes (node tool)
      let cornersOv: InteractiveOverlay["corners"] = null;
      if (s.tool === "node" && s.selection.length <= 12 && (!dragRef.current || dragRef.current.kind === "corner")) {
        cornersOv = [];
        const off = 13 / s.view.scale;
        for (const o of s.doc.objects.filter((x) => s.selection.includes(x.id) && !x.text && !x.locked))
          o.paths.forEach((sp) => {
            for (const w of cornerWidgets(sp)) cornersOv!.push({ p: [w.p[0] + w.dir[0] * off, w.p[1] + w.dir[1] * off] });
          });
        if (dragRef.current?.kind === "corner") cornersOv = [];
      }
      const interactive: InteractiveOverlay = {
        ...iRef.current,
        corners: cornersOv,
        pivot,
        gradient: gradOv,
        handles: handlesRef.current,
        satin: satinOv,
        pen: penOv,
        freehand: freehandOv,
        issues: issuesShown(s) ? computeIssues(s.doc, s.plan) : undefined,
      };
      const more = rendererRef.current.render(bg.getContext("2d")!, {
        interactive,
        showDensity: s.showDensity,
        density: s.density,
        densityMode: s.densityMode,
        live: s.live,
        glStitches: useGL,
        doc: s.doc,
        plan: shownPlan,
        view,
        mode: s.viewMode,
        selection: s.selection,
        theme: themeRef.current,
        overlay: {
          ...overlayRef.current,
          ramp: s.tool === "gradient" ? rampOverlay() : null,
          builder: s.tool === "builder" ? builderOverlay() : null,
          guides: s.tool === "guides" ? guidesOverlay() : null,
          nodes: s.tool === "node",
          nodeSel: s.tool === "node" ? s.nodeSel : [],
          refEdit: s.refEdit,
        },
        showGrid: s.showGrid,
        gridStep: s.gridStep,
        showJumps: s.showJumps,
        showUnderlay: s.showUnderlay,
        hiddenShapes: s.showHidden ? s.hiddenShapes : null,
        animIndex: s.anim.index,
        fabricColor: s.fabricColor,
        fabricAll: s.fabricAll,
        width: w,
        height: h,
        dpr,
      }, c.getContext("2d")!);
      if (useGL && s.plan) {
        const total = s.plan.flags.length;
        gl!.render({
          view,
          dpr,
          width: w,
          height: h,
          mode: s.viewMode as "stitch" | "realistic",
          plan: shownPlan!,
          showUnderlay: s.showUnderlay,
          showJumps: s.showJumps,
          limit: s.anim.index == null ? total : Math.max(0, Math.min(total, s.anim.index)),
          theme: themeRef.current,
          fabricColor: s.fabricColor,
          hoop: s.doc.hoop,
          fabric: s.doc.fabric,
          threadWidth: threadWidth(s.doc.options?.threadWeight),
          live: liveFrame(s.doc, s.live),
          fabricTexture: s.fabricTexture === "auto" ? undefined : s.fabricTexture,
          weaveMinPx: s.fabricWeave ? 4 : 0,
          noFabric: !!s.doc.references?.some((x) => x.visible && x.placement === "behind"),
        });
        glDirtyRef.current = true;
      } else if (gl && glDirtyRef.current) {
        gl.clear(Math.round(w * dpr), Math.round(h * dpr));
        glDirtyRef.current = false;
      }
      captureFrame();
      // zoom refinement continues over the next frames
      if (more) draw();
    });
  }, []);

  // size
  useEffect(() => {
    const el = wrapRef.current!;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      for (const c of [bgRef.current!, glCanvasRef.current!, canvasRef.current!]) {
        c.width = Math.round(r.width * dpr);
        c.height = Math.round(r.height * dpr);
        c.style.width = `${r.width}px`;
        c.style.height = `${r.height}px`;
      }
      layers.bg = bgRef.current;
      layers.gl = glCanvasRef.current;
      layers.top = canvasRef.current;
      const first = sizeRef.current.w === 800 && sizeRef.current.h === 600;
      sizeRef.current = { w: r.width, h: r.height, dpr };
      if (first) {
        const d = useStore.getState().doc;
        useStore.getState().setView(fitView(r.width, r.height, { x: 0, y: 0, w: d.hoop.width, h: d.hoop.height }));
      }
      draw();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [draw]);

  // a drag that ends outside the canvas (or loses the window) still ends: the plan follows again
  useEffect(() => {
    const end = () => {
      if (useStore.getState().live) useStore.getState().liveTransform(null);
    };
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    window.addEventListener("blur", end);
    return () => {
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      window.removeEventListener("blur", end);
    };
  }, []);

  // redraw on store changes
  useEffect(() => {
    const unsub = useStore.subscribe((s, p) => {
      if (s.theme !== p.theme || s.prefs.accent !== p.prefs.accent) themeRef.current = null;
      // shape builder: the regions follow the selection and the design
      if (s.tool === "builder" && (s.selection !== p.selection || s.doc !== p.doc || s.tool !== p.tool)) refreshRegions();
      if (s.tool !== p.tool) {
        penRef.current = null;
        penHoverRef.current = { kind: "none" };
        fhRef.current = null;
        if (s.drawHint) s.set({ drawHint: null });
        overlayRef.current = {};
        iRef.current = {};
      }
      draw();
    });
    window.addEventListener("filum:fit", fitHandler);
    return () => {
      unsub();
      window.removeEventListener("filum:fit", fitHandler);
    };
    function fitHandler(e: Event) {
      const s = useStore.getState();
      const which = (e as CustomEvent).detail as "hoop" | "design" | number;
      const { w, h } = sizeRef.current;
      if (typeof which === "number") {
        // zoom to a factor of "actual size" around the centre
        const actual = (96 / 25.4) * which;
        const cx = (w / 2 - s.view.ox) / s.view.scale;
        const cy = (h / 2 - s.view.oy) / s.view.scale;
        s.setView({ scale: actual, ox: w / 2 - cx * actual, oy: h / 2 - cy * actual });
        return;
      }
      const box =
        which === "design"
          ? unionBoxes(s.doc.objects.map(objectBounds)) ?? { x: 0, y: 0, w: s.doc.hoop.width, h: s.doc.hoop.height }
          : { x: 0, y: 0, w: s.doc.hoop.width, h: s.doc.hoop.height };
      s.setView(fitView(w, h, box));
    }
  }, [draw]);

  const toMm = (e: { clientX: number; clientY: number }): Vec2 => {
    const r = canvasRef.current!.getBoundingClientRect();
    const v = useStore.getState().view;
    return [(e.clientX - r.left - v.ox) / v.scale, (e.clientY - r.top - v.oy) / v.scale];
  };

  const pick = (p: Vec2): DesignObject | null => {
    const s = useStore.getState();
    const tol = 4 / s.view.scale;
    for (let i = s.doc.objects.length - 1; i >= 0; i--) {
      const o = s.doc.objects[i];
      if (!o.visible || o.locked) continue;
      if (hitObject(o, p, tol)) return o;
    }
    return null;
  };

  // ---- satin direction guides (stitch direction tool)
  const guideHover = useRef<number | null>(null);
  const guidesOverlay = () => {
    const o = selectedSatin();
    const draft = overlayRef.current.guideDraft ?? null;
    return { lines: guidesOf(o), hover: guideHover.current, draft };
  };

  // ---- density ramps (gradient tool, Density / Blend)
  const rampOverlay = () => {
    const s = useStore.getState();
    const o = selectedRamp();
    const draft = overlayRef.current.rampDraft ?? null;
    if (!o) return draft ? { from: draft.a, to: draft.b, combs: [], draft: true } : null;
    const r = rampOf(o)!;
    const combs = rampMembers(s.doc, o.id).map((m) => {
      const mr = rampOf(m)!;
      return { rows: rampRows(mr), color: s.doc.threads.find((t) => t.id === m.thread)?.color ?? "#888", side: mr.reverse ? -1 : 1 };
    });
    return { from: r.from, to: r.to, combs, draft: false };
  };
  const rampDown = (p: Vec2, tol: number): boolean => {
    const s = useStore.getState();
    const mode = s.toolOptions.gradient.mode ?? "colour";
    const o = selectedRamp();
    if (o) {
      const r = rampOf(o)!;
      const which = dist(r.from, p) < tol ? "from" : dist(r.to, p) < tol ? "to" : null;
      if (which) {
        s.checkpoint();
        dragRef.current = { kind: "rampend", id: o.id, which, moved: false };
        return true;
      }
    }
    if (mode === "colour") return false;
    const sel = s.doc.objects.find((x) => s.selection.includes(x.id) && x.paths.some((sp) => sp.closed));
    const hit = pick(p);
    const target = o?.id ?? sel?.id ?? (hit && hit.paths.some((sp) => sp.closed) ? hit.id : null);
    dragRef.current = { kind: "rampvec", a: p, target, mode };
    return true;
  };

  // ---- shape builder: the overlap regions of the selected fills
  const builderRef = useRef<{ doc: unknown; key: string; ids: string[]; regions: ShapeRegion[] | null; hover: number | null }>({ doc: null, key: "", ids: [], regions: null, hover: null });
  const builderIds = () => {
    const s = useStore.getState();
    return s.doc.objects.filter((o) => s.selection.includes(o.id) && o.visible && o.stitch.type === "fill" && o.paths.some((sp) => sp.closed)).map((o) => o.id);
  };
  const refreshRegions = () => {
    const s = useStore.getState();
    const b = builderRef.current;
    const ids = builderIds();
    const key = ids.join(",");
    if (b.doc === s.doc && b.key === key) return;
    b.doc = s.doc;
    b.key = key;
    b.ids = ids;
    b.hover = null;
    if (!ids.length) {
      b.regions = null;
      return;
    }
    const doc = s.doc;
    engine
      .shapeRegions(doc, ids)
      .then((r) => {
        if (builderRef.current.doc === doc && builderRef.current.key === key) {
          builderRef.current.regions = r;
          draw();
        }
      })
      .catch(() => {});
  };
  const faceAt = (p: Vec2): number | null => {
    const regions = builderRef.current.regions;
    if (!regions) return null;
    // smallest face containing p (even-odd over its rings)
    let best: number | null = null;
    regions.forEach((f, i) => {
      let inside = false;
      for (const ring of f.rings) {
        for (let a = 0, b = ring.length - 1; a < ring.length; b = a++) {
          const [xa, ya] = ring[a];
          const [xb, yb] = ring[b];
          if (ya > p[1] !== yb > p[1] && p[0] < ((xb - xa) * (p[1] - ya)) / (yb - ya) + xa) inside = !inside;
        }
      }
      if (inside && best == null) best = i;
    });
    return best;
  };
  const builderOverlay = () => {
    const b = builderRef.current;
    if (!b.regions) return null;
    const d = dragRef.current;
    return {
      faces: b.regions.map((f) => f.rings),
      hover: b.hover,
      picked: d?.kind === "build" ? d.faces : [],
      del: d?.kind === "build" ? d.del : (useStore.getState().toolOptions.builder.mode === "delete"),
    };
  };
  const applyBuild = async (faces: number[], del: boolean) => {
    const s = useStore.getState();
    const b = builderRef.current;
    if (!b.regions || !faces.length) return;
    const ids = b.ids;
    const first = b.regions[faces[0]];
    try {
      const r = await engine.shapeBuild(s.doc, ids, faces, del ? "delete" : "merge");
      const style = s.doc.objects.find((o) => o.id === first.owners[first.owners.length - 1]);
      const upd = new Map(r.updates.map((u) => [u.id, u.paths]));
      const merged: DesignObject | null =
        r.merged && style ? { ...style, id: uid(), name: nextName(s.doc.objects, "Merged"), paths: r.merged, start: undefined, end: undefined } : null;
      // the merged shape sits where its topmost source sat
      const top = Math.max(...first.owners.map((id) => s.doc.objects.findIndex((o) => o.id === id)));
      s.commit((d) => {
        const objects: DesignObject[] = [];
        d.objects.forEach((o, i) => {
          const paths = upd.get(o.id);
          if (!paths) objects.push(o);
          else if (paths.length) objects.push({ ...o, paths });
          if (i === top && merged) objects.push(merged);
        });
        return { ...d, objects };
      });
      const keep = ids.filter((id) => !upd.has(id) || upd.get(id)!.length);
      s.select(merged ? [...keep, merged.id] : keep);
    } catch (err) {
      s.toast(`Shape builder: ${(err as Error).message}`, "error");
    }
  };

  /** An existing point near p (other objects' nodes), for snapping. */
  const snapToNode = (p: Vec2, tol: number, skip?: Set<string>): Vec2 | null => {
    const s = useStore.getState();
    let best: Vec2 | null = null;
    let bd = tol;
    for (const o of s.doc.objects) {
      if (!o.visible || o.text) continue;
      o.paths.forEach((sp, si) =>
        sp.nodes.forEach((n, ni) => {
          if (skip?.has(nodeKey({ id: o.id, sp: si, ni }))) return;
          const d = dist(n.p, p);
          if (d < bd) {
            bd = d;
            best = n.p;
          }
        }),
      );
    }
    return best;
  };

  /** Where a press on the picture being adjusted lands: rotate knob, corner, inside. */
  const refZone = (r: ReferenceImage, p: Vec2): { mode: "move" | "scale" | "rotate"; corner: number } | null => {
    const sc = useStore.getState().view.scale;
    const t = 9 / sc;
    if (dist(refRotateKnob(r, sc), p) < t) return { mode: "rotate", corner: -1 };
    const ci = refCorners(r).findIndex((q) => dist(q, p) < t);
    if (ci >= 0) return { mode: "scale", corner: ci };
    return refContains(r, p) ? { mode: "move", corner: -1 } : null;
  };

  const newObject = (paths: SubPath[], stitch: StitchParams, base: string): DesignObject => {
    const s = useStore.getState();
    let thread = s.activeThread ?? s.doc.threads[0]?.id;
    if (!thread) thread = s.ensureThread("#b3203a", "Cherry");
    return {
      id: uid(),
      name: nextName(useStore.getState().doc.objects, base),
      thread,
      visible: true,
      locked: false,
      paths,
      stitch,
      trimAfter: false,
      stopAfter: false,
    };
  };

const runStitch = (kind: "running" | "triple", length: number): StitchParams => ({
    type: "running",
    ...defaultRunning(),
    length,
    beanRepeats: kind === "triple" ? 2 : 0,
  });

  /** Finish the pen / satin draft into an object (or update the continued one). */
  /**
   * A new running path that ends (or starts) on the end of another open
   * running path joins it: one path, the other's settings.
   */
  const joinPenEnds = (newId: string) => {
    const s = useStore.getState();
    let doc = s.doc;
    let id = newId;
    const endAt = (pos: Vec2, skip: string): NodeRef | null => {
      for (const o of doc.objects) {
        if (o.id === skip || !o.visible || o.locked || o.stitch.type !== "running") continue;
        for (let si = 0; si < o.paths.length; si++) {
          const sp = o.paths[si];
          if (sp.closed || sp.nodes.length < 2) continue;
          if (dist(sp.nodes[0].p, pos) < 1e-6) return { id: o.id, sp: si, ni: 0 };
          if (dist(sp.nodes[sp.nodes.length - 1].p, pos) < 1e-6) return { id: o.id, sp: si, ni: sp.nodes.length - 1 };
        }
      }
      return null;
    };
    let joined = 0;
    for (const which of ["end", "start"] as const) {
      const cur = doc.objects.find((x) => x.id === id);
      const sp = cur?.paths.find((x) => !x.closed);
      if (!cur || !sp) break;
      const si = cur.paths.indexOf(sp);
      const ni = which === "end" ? sp.nodes.length - 1 : 0;
      // after the first join the new path sits inside the other object: find its loose end again
      const pos = which === "end" ? sp.nodes[ni].p : (useStore.getState().doc.objects.find((x) => x.id === newId)?.paths[0].nodes[0].p ?? sp.nodes[0].p);
      const other = endAt(pos, id);
      if (!other) continue;
      const atStart = dist(sp.nodes[0].p, pos) < 1e-6;
      if (!atStart && dist(sp.nodes[sp.nodes.length - 1].p, pos) >= 1e-6) continue;
      const here = { id, sp: si, ni: atStart ? 0 : sp.nodes.length - 1 };
      const r = joinNodes(doc, [other, here]);
      if (r.error) continue;
      doc = r.doc;
      id = other.id;
      joined++;
    }
    if (!joined) return;
    s.setDoc(doc, { history: false });
    s.select([id]);
    s.toast(`Joined to ${doc.objects.find((x) => x.id === id)?.name ?? "the path"}`, "success");
  };

  const finishPen = (closed: boolean) => {
    const s = useStore.getState();
    const d = penRef.current;
    penRef.current = null;
    penHoverRef.current = { kind: "none" };
    iRef.current.tooltip = null;
    if (!d || d.nodes.length < 2) return draw();
    const isClosed = closed && canClose(d);
    let o: DesignObject;
    if (d.kind === "satin") {
      const { paths, width } = buildSatin(d.nodes, d.widths, isClosed);
      o = newObject(paths, { ...defaultStitch("satin"), width } as StitchParams, "Satin");
    } else {
      const opts = s.toolOptions.pen;
      const sp: SubPath = { nodes: d.nodes, closed: isClosed };
      o =
        isClosed && opts.closed === "fill"
          ? newObject([sp], defaultStitch("fill"), "Fill")
          : newObject([sp], runStitch(opts.stitch, opts.length), "Running");
    }
    const old = d.replaces ? s.doc.objects.find((x) => x.id === d.replaces) : undefined;
    if (old) {
      // continued path: keep the object, its colour and its settings
      const next: DesignObject = { ...old, paths: o.paths, stitch: o.stitch.type === old.stitch.type ? { ...old.stitch, ...(o.stitch.type === "satin" ? { width: (o.stitch as { width: number }).width } : {}) } as StitchParams : o.stitch };
      s.commit((doc) => ({ ...doc, objects: doc.objects.map((x) => (x.id === old.id ? next : x)) }));
      s.select([old.id]);
    } else {
      s.addObjects([o]);
      s.select([o.id]);
      if (d.kind === "run" && !isClosed) joinPenEnds(o.id);
    }
    draw();
  };

  const selKey = () => [...useStore.getState().selection].sort().join(",");
  /** Pivot of the selection: user-placed, or the centre of its box. */
  const pivotOf = (box: Box): Vec2 => (pivotRef.current?.key === selKey() ? pivotRef.current.p : [box.x + box.w / 2, box.y + box.h / 2]);

  /** Transform; lettering that gets mirrored or sheared turns into plain shapes. */
  const xform = (o: DesignObject, m: number[], rot = 0): DesignObject => {
    const c = transformObject(o, m as never, rot);
    const det = m[0] * m[3] - m[1] * m[2];
    const similarity = Math.abs(m[0] - m[3]) < 1e-9 && Math.abs(m[1] + m[2]) < 1e-9;
    return o.text && (det < 0 || !similarity) ? { ...c, text: undefined } : c;
  };

  /** Copies of objects (new ids; groups and letterings get new ids too). */
  const cloneObjects = (objs: DesignObject[]): DesignObject[] => {
    const map = new Map<string, string>();
    const re = (k: string, p: string) => {
      if (!map.has(k)) map.set(k, uid(p));
      return map.get(k)!;
    };
    return objs.map((o) => ({
      ...structuredClone(o),
      id: uid(),
      ...(o.group ? { group: re(o.group, "g") } : {}),
      ...(o.text ? { text: { ...o.text, group: re(o.text.group, "txt") } } : {}),
      ...(o.stitch.type === "fill" && o.stitch.gradient ? { stitch: { ...o.stitch, gradient: { ...o.stitch.gradient, group: re(o.stitch.gradient.group, "grd") } } } : {}),
    }));
  };

  /** A live corner widget of a selected shape near `p` (node tool). */
  const cornerWidgetHit = (p: Vec2, tol: number) => {
    const s = useStore.getState();
    const off = 13 / s.view.scale;
    for (const o of s.doc.objects.filter((x) => s.selection.includes(x.id) && !x.text && !x.locked))
      for (let si = 0; si < o.paths.length; si++)
        for (const w of cornerWidgets(o.paths[si])) {
          const q: Vec2 = [w.p[0] + w.dir[0] * off, w.p[1] + w.dir[1] * off];
          if (dist(q, p) < tol) return { o, sp: si, w };
        }
    return null;
  };

  /**
   * Mesh / freeform editing with the gradient tool. Nodes: click selects
   * (Shift adds), drag moves, Alt-click deletes. Mesh: a click inside adds a
   * row and a column (on a mesh line: only the crossing line). Points: a
   * click on the shape adds a point; drag the ring handle to set its spread.
   * Returns false when the click is off the gradient (to pick another shape).
   */
  const gradient2DDown = (e: React.PointerEvent, p: Vec2, tol: number, sg: NonNullable<ReturnType<typeof selectedGradient>>): boolean => {
    const s = useStore.getState();
    const g = sg.params;
    const sel = s.gradNodes;
    const pts: { p: Vec2 }[] = g.kind === "mesh" ? g.mesh?.nodes ?? [] : g.points ?? [];
    if (g.kind === "freeform" && g.points)
      for (const i of sel) {
        const q = g.points[i];
        if (q && dist([q.p[0] + q.spread, q.p[1]], p) < tol) {
          s.checkpoint();
          dragRef.current = { kind: "gradspread", group: sg.group, idx: i };
          return true;
        }
      }
    const startDrag = (idx: number[], at: Vec2[]) => {
      dragRef.current = { kind: "gradnode", group: sg.group, idx, orig: at, start: p, moved: false };
    };
    const hit = nodeHit(g, p, tol);
    if (hit != null) {
      if (e.altKey) {
        if (!removeNodes(sg.group, [hit])) s.toast(g.kind === "mesh" ? "The mesh border stays — Alt-click an inner node to remove its lines" : "A gradient keeps at least one colour point");
        draw();
        return true;
      }
      let next = sel;
      if (e.shiftKey) next = sel.includes(hit) ? sel.filter((i) => i !== hit) : [...sel, hit];
      else if (!sel.includes(hit)) next = [hit];
      s.set({ gradNodes: next });
      if (next.includes(hit)) {
        s.checkpoint();
        startDrag(next, next.map((i) => pts[i].p));
      }
      draw();
      return true;
    }
    const h = pick(p);
    const onShape = !!h && h.stitch.type === "fill" && h.stitch.gradient?.group === sg.group;
    if (g.kind === "mesh" && meshValid(g.mesh) && meshLocate(g.mesh, p)) {
      const line = meshLineHit(g.mesh, p, tol * 0.6);
      const ins = meshInsert(g, p, line === "row" ? "col" : line === "col" ? "row" : undefined);
      if (ins) {
        s.checkpoint();
        commit2D(sg.group, { mesh: ins.mesh }, undefined, true);
        s.set({ gradNodes: [ins.node] });
        startDrag([ins.node], [ins.mesh.nodes[ins.node].p]);
      }
      draw();
      return true;
    }
    if (g.kind === "freeform" && onShape) {
      const list = g.points ?? [];
      const like = list[sel[0]];
      const w = weightsAt(g, p);
      const c = like ? like.c : w.reduce((b, x, i) => (x > w[b] ? i : b), 0);
      const spread = like?.spread ?? (list.length ? list.reduce((a, q) => a + q.spread, 0) / list.length : 10);
      s.checkpoint();
      commit2D(sg.group, { points: [...list, { p, c, spread }] }, undefined, true);
      s.set({ gradNodes: [list.length] });
      startDrag([list.length], [p]);
      draw();
      return true;
    }
    if (onShape) {
      s.set({ gradNodes: [] });
      draw();
      return true;
    }
    return false;
  };

  /** Gradient annotator hit: an end handle, a stop, or the line itself. */
  const gradientHit = (p: Vec2, tol: number) => {
    const sg = selectedGradient();
    if (!sg) return null;
    const { params: g, group } = sg;
    const at = (t: number): Vec2 => [g.from[0] + (g.to[0] - g.from[0]) * t, g.from[1] + (g.to[1] - g.from[1]) * t];
    const stops = stopsOf(useStore.getState().doc, group);
    for (let i = stops.length - 1; i >= 0; i--) if (dist(at(stops[i].pos), p) < tol * 1.2) return { kind: "stop" as const, index: i, group, g, stops };
    if (dist(g.from, p) < tol * 1.4) return { kind: "from" as const, group, g, stops };
    if (dist(g.to, p) < tol * 1.4) return { kind: "to" as const, group, g, stops };
    const d = [g.to[0] - g.from[0], g.to[1] - g.from[1]];
    const l2 = d[0] * d[0] + d[1] * d[1] || 1;
    const t = ((p[0] - g.from[0]) * d[0] + (p[1] - g.from[1]) * d[1]) / l2;
    if (t > 0 && t < 1 && dist(at(t), p) < tol) return { kind: "line" as const, t, group, g, stops };
    return null;
  };

  /** An end of a selected open path the pen can continue from. */
  const continuable = (p: Vec2, tol: number, kind: PenDraft["kind"]) => {
    const s = useStore.getState();
    for (const o of s.doc.objects.filter((x) => s.selection.includes(x.id) && !x.locked)) {
      const ok = kind === "run" ? o.stitch.type === "running" : o.stitch.type === "satin" && !o.stitch.multi;
      if (!ok || o.paths.length !== 1 || o.paths[0].closed || o.paths[0].nodes.length < 2) continue;
      const nodes = o.paths[0].nodes;
      if (dist(nodes[nodes.length - 1].p, p) < tol) return { o, atStart: false };
      if (dist(nodes[0].p, p) < tol) return { o, atStart: true };
    }
    return null;
  };

  const penDown = (e: React.PointerEvent, p: Vec2, tol: number) => {
    const s = useStore.getState();
    const kind = s.tool === "satin" ? "satin" : "run";
    let d = penRef.current;
    if (!d) {
      d = penRef.current = newDraft(kind, s.toolOptions.satin.width);
      const cont = continuable(p, tol, kind);
      if (cont) {
        d.nodes = continueFrom(cont.o.paths[0], cont.atStart);
        const w = cont.o.stitch.type === "satin" ? cont.o.stitch.width : d.width;
        d.widths = d.nodes.map(() => w);
        d.replaces = cont.o.id;
        s.toast("Continuing the path — Enter to finish", "info");
        draw();
        return;
      }
    }
    const hit = penHitTest(d, p, tol);
    const n = d.nodes.length;
    if (e.altKey && (hit.kind === "anchor" || hit.kind === "last" || hit.kind === "close")) {
      deleteFromDraft(d, hit.kind === "anchor" ? hit.index : hit.kind === "last" ? n - 1 : 0);
      if (!d.nodes.length) penRef.current = null;
      penHoverRef.current = { kind: "none" };
      draw();
      return;
    }
    switch (hit.kind) {
      case "handle":
        dragRef.current = { kind: "pen-handle", idx: hit.index, part: hit.part, orig: { ...d.nodes[hit.index] } };
        return;
      case "close":
        if (canClose(d)) {
          dragRef.current = { kind: "pen-close", moved: false };
          return;
        }
        break;
      case "last":
        dragRef.current = { kind: "pen-last", moved: false, keepIn: d.nodes[n - 1].i };
        return;
      case "anchor":
        if (e.detail === 2) {
          toggleSmoothInDraft(d, hit.index);
          draw();
          return;
        }
        dragRef.current = { kind: "pen-anchor", idx: hit.index, orig: { ...d.nodes[hit.index] }, start: p, moved: false };
        return;
      case "segment": {
        const idx = insertInDraft(d, hit.seg, hit.t);
        penHoverRef.current = { kind: "anchor", index: idx };
        dragRef.current = { kind: "pen-anchor", idx, orig: { ...d.nodes[idx] }, start: p, moved: false };
        draw();
        return;
      }
    }
    const snapped = !e.shiftKey && !e.ctrlKey && s.prefs.snapPoints ? snapToNode(p, tol) : null;
    const q = snapped ?? placePoint(d, p, e.shiftKey);
    overlayRef.current.snap = null;
    if (d.kind === "satin") d.width = s.toolOptions.satin.width;
    addPoint(d, q);
    d.cursor = null;
    dragRef.current = { kind: "pen-new", idx: d.nodes.length - 1, moved: false, last: p };
    draw();
  };

  /** Two-rail satin whose nodes pair up as rungs (inserting / deleting keeps the pairs). */
  const railPair = (o: DesignObject) => {
    if (o.stitch.type !== "satin" || o.stitch.multi || o.paths.length !== 2) return null;
    const [a, b] = o.paths;
    const n = a.nodes.length;
    if (n !== b.nodes.length || n < 2) return null;
    return { rev: dist(a.nodes[0].p, b.nodes[0].p) > dist(a.nodes[0].p, b.nodes[n - 1].p), n, closed: a.closed };
  };

  /** Where a node-tool click would add a point (on a selected path, away from nodes). */
  const nodeInsertTarget = (p: Vec2, tol: number) => {
    const s = useStore.getState();
    let best: { o: DesignObject; sp: number; seg: number; t: number; p: Vec2; d: number } | null = null;
    for (const o of s.doc.objects.filter((x) => s.selection.includes(x.id) && !x.locked && !x.text)) {
      o.paths.forEach((sp, si) => {
        const hit = nearestOnSubPath(sp, p);
        if (hit && hit.d < tol && (!best || hit.d < best.d)) best = { o, sp: si, seg: hit.seg, t: hit.t, p: hit.p, d: hit.d };
      });
    }
    const b = best as { o: DesignObject; sp: number; seg: number; t: number; p: Vec2; d: number } | null;
    if (!b) return null;
    const near = b.o.paths[b.sp].nodes.some((n) => dist(n.p, b.p) < tol * 1.2 || (n.i && dist(n.i, p) < tol) || (n.o && dist(n.o, p) < tol));
    return near ? null : b;
  };

  const insertIntoObject = (o: DesignObject, si: number, seg: number, t: number) => {
    const pair = railPair(o);
    const paths = [...o.paths];
    const r = insertNode(paths[si], seg, t);
    paths[si] = r.sp;
    if (pair) {
      const other = 1 - si;
      const { n, rev, closed } = pair;
      const segO = !rev ? seg : closed ? (2 * n - seg - 1) % n : n - 2 - seg;
      paths[other] = insertNode(paths[other], segO, rev ? 1 - t : t).sp;
    }
    return { obj: { ...o, paths }, index: r.index };
  };

  const deleteFromObject = (o: DesignObject, si: number, ni: number): DesignObject | null => {
    const sp = o.paths[si];
    if (sp.nodes.length <= 2) return null;
    const pair = railPair(o);
    const paths = [...o.paths];
    paths[si] = deleteNode(sp, ni);
    if (pair) {
      const { n, rev, closed } = pair;
      const idx = !rev ? ni : closed ? (n - ni) % n : n - 1 - ni;
      paths[1 - si] = deleteNode(paths[1 - si], idx);
    }
    return { ...o, paths };
  };

  const penHint = (text: string, at: Vec2) => {
    iRef.current.tooltip = { p: at, text };
  };

  const setSatinWidth = (w: number, at?: Vec2) => {
    const v = Math.min(15, Math.max(0.3, Math.round(w * 20) / 20));
    useStore.getState().setToolOptions("satin", { width: v });
    if (penRef.current) penRef.current.width = v;
    const at2 = at ?? penRef.current?.cursor ?? penRef.current?.nodes.at(-1)?.p;
    if (at2) iRef.current.tooltip = { p: at2, text: `Width ${v.toFixed(2)} mm · scroll or [ ] to change` };
    draw();
  };

  const replaceObjects = (orig: DesignObject, parts: DesignObject[]) => {
    const s = useStore.getState();
    s.commit((d) => ({ ...d, objects: d.objects.flatMap((x) => (x.id === orig.id ? parts : [x])) }));
  };

  // keyboard handlers local to drawing tools
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest("input,textarea,select,[contenteditable]")) return;
      if (e.code === "Space") {
        spaceRef.current = true;
        if (canvasRef.current) canvasRef.current.style.cursor = "grab";
      }
      const st = useStore.getState();
      if (st.tool === "satin" && (e.key === "[" || e.key === "]")) {
        setSatinWidth(st.toolOptions.satin.width + (e.key === "]" ? 1 : -1) * (e.shiftKey ? 0.5 : 0.1));
        e.preventDefault();
        return;
      }
      const pd = penRef.current;
      if (pd && (st.tool === "pen" || st.tool === "satin")) {
        if (e.key === "Enter" || e.key === "Escape") {
          // finish the path, stay in the tool
          e.preventDefault();
          finishPen(false);
        } else if (e.key === "Backspace" || e.key === "Delete") {
          e.preventDefault();
          removeLast(pd);
          if (!pd.nodes.length) penRef.current = null;
          draw();
        }
        return;
      }
      if ((e.key === "[" || e.key === "]") && st.tool === "select" && st.selection.length === 1) {
        const o = st.doc.objects.find((x) => x.id === st.selection[0]);
        const k = (e.key === "]" ? 1 : -1) * (e.shiftKey ? 3 : 1);
        if (o?.stitch.type === "fill") st.updateStitch(o.id, { angle: normAngle(o.stitch.angle + k * 5) });
        if (o?.stitch.type === "satin" && o.paths.length === 1) st.updateStitch(o.id, { width: Math.max(0.3, +(o.stitch.width + k * 0.2).toFixed(2)) });
        e.preventDefault();
        return;
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === "Space") {
        spaceRef.current = false;
        if (canvasRef.current) canvasRef.current.style.cursor = "";
      }
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  });

  const onPointerDown = (e: React.PointerEvent) => {
    const s = useStore.getState();
    const c = canvasRef.current!;
    try {
      c.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic or already-released pointer */
    }
    const p = toMm(e);
    const tol = 6 / s.view.scale;
    if (e.button === 2) rightRef.current = { x: e.clientX, y: e.clientY, moved: false };
    if (e.button === 1 || e.button === 2 || spaceRef.current || s.tool === "pan") {
      dragRef.current = { kind: "pan", sx: e.clientX, sy: e.clientY, ox: s.view.ox, oy: s.view.oy };
      return;
    }
    if (s.anim.index != null && !s.anim.playing) s.set({ anim: { ...s.anim, index: null } });
    if (s.refEdit) {
      const r = s.doc.references?.find((x) => x.id === s.refEdit);
      const z = r ? refZone(r, p) : null;
      if (r && z) {
        s.checkpoint();
        const c = refCenter(r);
        dragRef.current = { kind: "ref", mode: z.mode, orig: r, start: p, corner: z.corner, a0: Math.atan2(p[1] - c[1], p[0] - c[0]), moved: false };
        return;
      }
      // a click elsewhere: done adjusting
      s.set({ refEdit: null });
      return;
    }
    switch (s.tool) {
      case "guides": {
        const gtol = Math.max(tol, 8 / s.view.scale);
        const sat = selectedSatin();
        if (sat) {
          const hit = guideHit(guidesOf(sat), p, gtol);
          if (hit) {
            if (e.altKey) {
              setGuides(sat.id, guidesOf(sat).filter((_, i) => i !== hit.index));
              guideHover.current = null;
              draw();
              return;
            }
            s.checkpoint();
            dragRef.current =
              hit.end === null
                ? { kind: "guidemove", id: sat.id, index: hit.index, start: p, orig: guidesOf(sat)[hit.index], moved: false }
                : { kind: "guideend", id: sat.id, index: hit.index, end: hit.end, moved: false };
            return;
          }
        }
        // on a satin (the selected one, or another): draw a new guide
        const h = pick(p);
        const target = sat && (!h || h.id === sat.id || h.stitch.type !== "satin") ? sat : h && h.stitch.type === "satin" ? h : null;
        if (target) {
          if (!s.selection.includes(target.id)) s.select([target.id]);
          dragRef.current = { kind: "guidedraw", id: target.id, a: p };
          return;
        }
        s.select(h ? unitIds(s.doc, h) : []);
        if (h) s.toast("Direction guides are for satin columns");
        return;
      }
      case "select": {
        // parameter handles (reverse order: pins are drawn on top)
        const hh = [...handlesRef.current].reverse().find((h) => dist(h.p, p) < HANDLE_HIT_PX / s.view.scale);
        if (hh?.group) {
          const spec = textSpec(hh.group);
          if (!spec) return;
          if (e.detail === 2) {
            updateText(hh.group, hh.kind === "text-arc" ? { arc: 0 } : { letterSpacing: 0 });
            return;
          }
          s.checkpoint();
          dragRef.current = { kind: "texthandle", h: hh, group: hh.group, spec, start: p, moved: false };
          iRef.current.activeHandle = hh;
          return;
        }
        if (hh) {
          const o = s.doc.objects.find((x) => x.id === hh.objId)!;
          if (hh.kind === "reverse") {
            s.commit((d) => ({ ...d, objects: d.objects.map((x) => (x.id === o.id ? reverseObject(x, hh) : x)) }));
            return;
          }
          if ((hh.kind === "start" || hh.kind === "end") && e.detail === 2) {
            s.commit((d) => ({ ...d, objects: d.objects.map((x) => (x.id === o.id ? { ...x, [hh.kind]: undefined } : x)) }));
            return;
          }
          s.checkpoint();
          dragRef.current = { kind: "handle", h: hh, orig: o, moved: false };
          iRef.current.activeHandle = hh;
          return;
        }
        if (issuesShown(s)) {
          const iss = computeIssues(s.doc, s.plan).find((i) => i.objId && dist(i.at, p) < 9 / s.view.scale);
          if (iss) {
            s.select([iss.objId]);
            return;
          }
        }
        const sel = s.doc.objects.filter((o) => s.selection.includes(o.id));
        const box = unionBoxes(sel.map(objectBounds));
        if (box && sel.every((o) => !o.locked)) {
          const pv = pivotOf(box);
          // Alt-drag the pivot to move it (Alt-double-click: back to the centre)
          if (e.altKey && dist(p, pv) < tol * 1.2) {
            if (e.detail === 2) {
              pivotRef.current = null;
              draw();
              return;
            }
            dragRef.current = { kind: "pivot", key: selKey() };
            return;
          }
          const [rx, ry] = rotateHandle(box, s.view.scale);
          const hi = handlePoints(box).findIndex((h) => dist(h, p) < tol);
          if (dist(p, [rx, ry]) < tol || (hi < 0 && rotateZone(box, p, s.view.scale) >= 0)) {
            s.checkpoint();
            dragRef.current = { kind: "rotate", center: pv, a0: Math.atan2(p[1] - pv[1], p[0] - pv[0]), orig: sel };
            return;
          }
          if (hi >= 0) {
            s.checkpoint();
            if ((e.ctrlKey || e.metaKey) && hi % 2 === 1) {
              dragRef.current = { kind: "skew", handle: hi, box, orig: sel, start: p, pivot: pv };
              return;
            }
            const targets = s.smartGuides ? snapTargets(s.doc, new Set(s.selection)) : null;
            dragRef.current = { kind: "scale", handle: hi, box, orig: sel, uniform: sel.some((o) => o.text), targets, pivot: pv };
            return;
          }
        }
        const hit = pick(p);
        if (hit) {
          // groups and letterings are picked as a whole; Ctrl / Cmd picks one object inside
          const unit = e.ctrlKey || e.metaKey ? [hit.id] : unitIds(s.doc, hit);
          let ids = s.selection;
          if (e.shiftKey) ids = ids.includes(hit.id) ? ids.filter((x) => !unit.includes(x)) : [...ids, ...unit.filter((x) => !ids.includes(x))];
          else if (e.ctrlKey || e.metaKey || !ids.includes(hit.id)) ids = unit;
          s.select(ids);
          if (e.detail === 2) {
            if (hit.text) s.set({ editingText: hit.text.group });
            else s.setTool("node");
            return;
          }
          s.set({ activeThread: hit.thread });
          dragRef.current = {
            kind: "move",
            start: p,
            orig: s.doc.objects.filter((o) => ids.includes(o.id)),
            moved: false,
            targets: s.smartGuides ? snapTargets(s.doc, new Set(ids)) : null,
          };
        } else {
          if (e.detail === 2) {
            const r = referenceAt(p);
            if (r) {
              s.set({ refEdit: r.id });
              return;
            }
          }
          if (!e.shiftKey) s.select([]);
          dragRef.current = { kind: "marquee", a: p, add: e.shiftKey };
        }
        return;
      }
      case "node": {
        for (const o of s.doc.objects.filter((x) => s.selection.includes(x.id))) {
          for (let si = 0; si < o.paths.length; si++)
            for (let ni = 0; ni < o.paths[si].nodes.length; ni++) {
              const n = o.paths[si].nodes[ni];
              for (const part of ["i", "o", "p"] as const) {
                const q = n[part];
                if (q && dist(q, p) < tol) {
                  if (part === "p" && e.altKey) {
                    // Alt-click: delete the point (both rails of a satin)
                    const next = deleteFromObject(o, si, ni);
                    if (next) s.commit((doc) => syncGradientGeometry({ ...doc, objects: doc.objects.map((x) => (x.id === o.id ? next : x)) }, next));
                    else s.toast("A path needs at least two points");
                    s.set({ nodeSel: [] });
                    return;
                  }
                  if (part === "p" && e.detail === 2) {
                    const paths = o.paths.map((x, k) => (k === si ? toggleSmooth(x, ni) : x));
                    s.commit((doc) => syncGradientGeometry({ ...doc, objects: doc.objects.map((x) => (x.id === o.id ? { ...o, paths } : x)) }, { ...o, paths }));
                    return;
                  }
                  if (part === "p") {
                    // select the point (Shift: add / remove), then drag every selected point
                    const ref = { id: o.id, sp: si, ni };
                    const key = nodeKey(ref);
                    const has = s.nodeSel.some((x) => nodeKey(x) === key);
                    let sel = s.nodeSel;
                    if (e.shiftKey) sel = has ? sel.filter((x) => nodeKey(x) !== key) : [...sel, ref];
                    else if (!has) sel = [ref];
                    s.set({ nodeSel: sel });
                    if (e.shiftKey && has) return;
                    s.checkpoint();
                    dragRef.current = { kind: "nodes", start: p, orig: s.doc, sel, moved: false, anchor: n.p };
                    return;
                  }
                  s.checkpoint();
                  dragRef.current = { kind: "node", id: o.id, sp: si, ni, part, orig: o };
                  return;
                }
              }
            }
        }
        const cw = cornerWidgetHit(p, Math.max(tol, 6 / s.view.scale));
        if (cw) {
          if (e.altKey) {
            cornerStyle = cornerStyle === "round" ? "inverted" : cornerStyle === "inverted" ? "chamfer" : "round";
            s.toast(`Corner style: ${cornerStyle === "round" ? "round" : cornerStyle === "inverted" ? "inverted round" : "chamfer"}`);
            return;
          }
          s.checkpoint();
          dragRef.current = { kind: "corner", id: cw.o.id, sp: cw.sp, k: cw.w.k, orig: cw.o, all: e.shiftKey, p: cw.w.p, dir: cw.w.dir, phi: cw.w.phi };
          return;
        }
        const ins = nodeInsertTarget(p, Math.max(tol, 7 / s.view.scale));
        if (ins) {
          // add a point on the curve and keep dragging it
          s.checkpoint();
          const r = insertIntoObject(ins.o, ins.sp, ins.seg, ins.t);
          s.liveUpdate((doc) => syncGradientGeometry({ ...doc, objects: doc.objects.map((x) => (x.id === r.obj.id ? r.obj : x)) }, r.obj));
          dragRef.current = { kind: "node", id: r.obj.id, sp: ins.sp, ni: r.index, part: "p", orig: r.obj };
          s.set({ nodeSel: [{ id: r.obj.id, sp: ins.sp, ni: r.index }] });
          iRef.current.insertAt = null;
          return;
        }
        // anywhere else: a box selects points (a click decides on release)
        const hit = pick(p);
        dragRef.current = { kind: "nodemarquee", a: p, add: e.shiftKey, hit: hit && !s.selection.includes(hit.id) ? hit : null };
        return;
      }
      case "ruler":
        dragRef.current = { kind: "ruler", a: p };
        return;
      case "rect":
      case "ellipse":
        dragRef.current = { kind: "shape", shape: s.tool, a: p };
        return;
      case "freehand":
        fhRef.current = startStroke(p);
        dragRef.current = { kind: "freehand" };
        iRef.current.tooltip = null;
        return;
      case "pen":
      case "satin":
        penDown(e, p, Math.max(tol, 7 / s.view.scale));
        return;
      case "cut":
        dragRef.current = { kind: "cut", a: p, moved: false };
        return;
      case "builder": {
        refreshRegions();
        const f = faceAt(p);
        if (f != null) {
          dragRef.current = { kind: "build", faces: [f], del: e.altKey || s.toolOptions.builder.mode === "delete" };
          draw();
          return;
        }
        // outside the regions: choose shapes (Shift adds)
        const hit = pick(p);
        if (hit) s.select(e.shiftKey ? [...new Set([...s.selection, hit.id])] : unitIds(s.doc, hit));
        else if (!e.shiftKey) s.select([]);
        return;
      }
      case "gradient": {
        const gtol = Math.max(tol, 8 / s.view.scale);
        if (rampDown(p, gtol)) return;
        const sg2 = selectedGradient();
        if (sg2 && is2D(sg2.params.kind) && gradient2DDown(e, p, gtol, sg2)) return;
        const mode = s.toolOptions.gradient.kind;
        if (is2D(mode) && !(sg2 && !is2D(sg2.params.kind))) {
          // mesh / points: one click on a closed shape makes the gradient there
          const h = pick(p);
          const target = h && h.paths.some((sp) => sp.closed) && !(h.stitch.type === "fill" && h.stitch.gradient) ? h : null;
          if (!target) {
            s.select(h ? unitIds(s.doc, h) : []);
            if (!h) s.toast(mode === "mesh" ? "Click a closed shape to add a gradient mesh" : "Click a closed shape to add colour points");
            draw();
            return;
          }
          if (!makeGradient2D(target.id, p, mode as "mesh" | "freeform")) s.toast("Gradients need a closed shape", "error");
          draw();
          return;
        }
        const gh = sg2 && is2D(sg2.params.kind) ? null : gradientHit(p, gtol);
        if (gh) {
          if (gh.kind === "from" || gh.kind === "to") {
            s.checkpoint();
            dragRef.current = { kind: "gradend", which: gh.kind, group: gh.group };
            return;
          }
          if (gh.kind === "stop") {
            if ((e.altKey || e.detail === 2) && gh.stops.length > 2) {
              setStops(gh.group, gh.stops.filter((_, i) => i !== gh.index));
              return;
            }
            s.checkpoint();
            dragRef.current = { kind: "gradstop", index: gh.index, group: gh.group, stops: gh.stops, g: gh.g };
            return;
          }
          // click on the line: a new stop there, with the colour of the nearest stop
          const near = gh.stops.reduce((b, st, i) => (Math.abs(st.pos - gh.t) < Math.abs(gh.stops[b].pos - gh.t) ? i : b), 0);
          setStops(gh.group, [...gh.stops, { pos: gh.t, mid: 0.5, thread: gh.stops[near].thread }].sort((a, b) => a.pos - b.pos));
          return;
        }
        // a new gradient vector across the selected (or clicked) shape
        const sg = sg2 && !is2D(sg2.params.kind) ? sg2 : null;
        const target =
          sg?.layers[0] ??
          s.doc.objects.find((o) => s.selection.includes(o.id) && o.paths.some((sp) => sp.closed)) ??
          (() => {
            const h = pick(p);
            return h && h.paths.some((sp) => sp.closed) ? h : null;
          })();
        if (target && !s.selection.includes(target.id)) s.select(unitIds(s.doc, target));
        dragRef.current = { kind: "gradvec", a: p, target: target?.id ?? null, group: sg?.group ?? null };
        return;
      }
      case "text": {
        if (s.editingText) {
          s.set({ editingText: null });
          return;
        }
        const hit = pick(p);
        if (hit?.text) {
          // click existing lettering: edit it
          const g = hit.text.group;
          s.select(members(s.doc.objects, g).map((o) => o.id));
          s.setTool("select");
          s.set({ editingText: g });
          return;
        }
        createTextAt(p)
          .then((g) => {
            const st = useStore.getState();
            st.setTool("select");
            st.set({ editingText: g });
          })
          .catch((err) => s.toast(`Lettering: ${(err as Error).message}`, "error"));
        return;
      }
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const s = useStore.getState();
    const p = toMm(e);
    if (s.showDensity) setDensityHover(p);
    const d = dragRef.current;
    if (!d && s.refEdit) {
      const r = s.doc.references?.find((x) => x.id === s.refEdit);
      const z = r ? refZone(r, p) : null;
      if (canvasRef.current) canvasRef.current.style.cursor = !z ? "default" : z.mode === "move" ? "move" : z.mode === "rotate" ? ROTATE_CURSOR : z.corner % 2 === 0 ? "nwse-resize" : "nesw-resize";
      iRef.current.tooltip = z ? null : { p, text: "Click outside or press Enter when done" };
      draw();
      return;
    }
    if (!d) {
      if (s.tool === "satin" || s.tool === "pen") {
        const tol = Math.max(6, 7) / s.view.scale;
        const pd = penRef.current;
        const c = canvasRef.current;
        if (pd && pd.nodes.length) {
          const hover = penHitTest(pd, p, tol);
          penHoverRef.current = hover;
          const snap = hover.kind === "none" && !e.shiftKey && !e.ctrlKey && s.prefs.snapPoints ? snapToNode(p, tol) : null;
          overlayRef.current.snap = snap;
          pd.cursor = hover.kind === "none" ? (snap ?? placePoint(pd, p, e.shiftKey)) : null;
          let text = PEN_HINTS[hover.kind];
          if (hover.kind === "none" && pd.kind === "satin") text = `${pd.width.toFixed(2)} mm · scroll or [ ] for width · ${text}`;
          if (hover.kind === "anchor" && pd.kind === "satin") text = `${pd.widths[hover.index].toFixed(2)} mm · scroll to change · ${text}`;
          if (hover.kind === "close" && !canClose(pd)) text = PEN_HINTS.none;
          penHint(text, pd.cursor ?? p);
          if (c) c.style.cursor = hover.kind === "handle" || hover.kind === "anchor" ? "move" : hover.kind === "segment" ? "copy" : hover.kind === "close" || hover.kind === "last" ? "pointer" : "";
        } else {
          penHoverRef.current = { kind: "none" };
          const cont = continuable(p, tol, s.tool === "satin" ? "satin" : "run");
          overlayRef.current.snap = !cont && !e.ctrlKey && s.prefs.snapPoints ? snapToNode(p, tol) : null;
          penHint(
            cont
              ? "Click to continue this path"
              : s.tool === "satin"
                ? `Satin ${s.toolOptions.satin.width.toFixed(2)} mm · click for corners, drag for curves`
                : "Pen · click for corners, drag for curves",
            p,
          );
          if (c) c.style.cursor = cont ? "pointer" : "";
        }
        draw();
        return;
      }
      if (s.tool === "node") {
        const cw = cornerWidgetHit(p, 7 / s.view.scale);
        if (cw) {
          iRef.current.insertAt = null;
          iRef.current.tooltip = { p, text: `Drag to round this corner (${cornerStyle}) · Shift-drag: all corners · Alt-click: corner style` };
          draw();
          return;
        }
        const ins = nodeInsertTarget(p, 8 / s.view.scale);
        iRef.current.insertAt = ins?.p ?? null;
        iRef.current.tooltip = ins ? { p, text: "Click to add a point · Alt-click a point to delete · double-click: smooth ↔ corner" } : null;
        if (canvasRef.current) canvasRef.current.style.cursor = ins ? "copy" : "";
        draw();
        return;
      }
      if (s.tool === "guides") {
        const hit = guideHit(guidesOf(selectedSatin()), p, Math.max(6, 8) / s.view.scale);
        const hv = hit?.index ?? null;
        if (hv !== guideHover.current) {
          guideHover.current = hv;
          if (canvasRef.current) canvasRef.current.style.cursor = hit ? (hit.end === null ? "move" : "grab") : "crosshair";
          draw();
        }
      }
      if (s.tool === "builder") {
        refreshRegions();
        const f = faceAt(p);
        if (f !== builderRef.current.hover) {
          builderRef.current.hover = f;
          draw();
        }
        if (canvasRef.current) canvasRef.current.style.cursor = f != null ? (e.altKey || s.toolOptions.builder.mode === "delete" ? "not-allowed" : "copy") : "";
        iRef.current.tooltip = builderRef.current.regions ? null : { p, text: "Select overlapping fills (Shift-click to add), then drag across regions to merge them" };
        return;
      }
      if (s.tool === "freehand" && !fhRef.current) {
        iRef.current.tooltip = { p, text: "Draw · the line trails the pointer for smooth curves · end at the start to close" };
        draw();
        return;
      }
      if (s.tool === "cut") {
        const hit = pick(p);
        const np = hit && isPathObject(hit) ? nearestOnPaths(hit, p) : null;
        iRef.current.cutPoint = np && np.d < 10 / s.view.scale ? np.p : null;
        iRef.current.tooltip = { p, text: iRef.current.cutPoint ? "Click to cut here" : "Click a line to split it · drag across a fill to cut it" };
        draw();
        return;
      }
      if (s.tool === "select") {
        const hh = [...handlesRef.current].reverse().find((h) => dist(h.p, p) < HANDLE_HIT_PX / s.view.scale) ?? null;
        const changed = hh?.kind !== iRef.current.hoverHandle?.kind || hh?.objId !== iRef.current.hoverHandle?.objId;
        iRef.current.hoverHandle = hh;
        iRef.current.tooltip = hh ? { p: hh.p, text: HANDLE_HINTS[hh.kind] } : null;
        if (canvasRef.current) canvasRef.current.style.cursor = hh ? (hh.kind === "reverse" ? "pointer" : "grab") : "";
        if (changed) draw();
        if (hh) return;
        // transform box: resize / skew / rotate / pivot cursors
        const sel = s.doc.objects.filter((o) => s.selection.includes(o.id));
        const sb = sel.length && sel.every((o) => !o.locked) ? unionBoxes(sel.map(objectBoundsCached)) : null;
        if (sb && canvasRef.current) {
          const t = 6 / s.view.scale;
          const hi = handlePoints(sb).findIndex((h) => dist(h, p) < t);
          const RESIZE = ["nwse-resize", "ns-resize", "nesw-resize", "ew-resize", "nwse-resize", "ns-resize", "nesw-resize", "ew-resize"];
          let cur = "";
          if (e.altKey && dist(p, pivotOf(sb)) < t * 1.2) cur = "move";
          else if (hi >= 0) cur = (e.ctrlKey || e.metaKey) && hi % 2 === 1 ? SKEW_CURSOR : RESIZE[hi];
          else if (dist(p, rotateHandle(sb, s.view.scale)) < t || rotateZone(sb, p, s.view.scale) >= 0) cur = ROTATE_CURSOR;
          canvasRef.current.style.cursor = cur;
          if (cur) return;
        }
        const hov = pick(p)?.id ?? null;
        if (hov !== overlayRef.current.hoverId) {
          overlayRef.current.hoverId = hov;
          draw();
        }
      }
      return;
    }
    switch (d.kind) {
      case "pan":
        if (rightRef.current && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) > 4) rightRef.current.moved = true;
        s.setView({ ox: d.ox + e.clientX - d.sx, oy: d.oy + e.clientY - d.sy });
        return;
      case "nodes": {
        let dv: Vec2 = [p[0] - d.start[0], p[1] - d.start[1]];
        if (!d.moved && Math.hypot(dv[0], dv[1]) * s.view.scale < 2) return;
        d.moved = true;
        // Shift: only horizontally or vertically
        if (e.shiftKey) dv = Math.abs(dv[0]) > Math.abs(dv[1]) ? [dv[0], 0] : [0, dv[1]];
        // snap the grabbed point to other points
        const target: Vec2 = [d.anchor[0] + dv[0], d.anchor[1] + dv[1]];
        const snap = !e.ctrlKey && s.prefs.snapPoints ? snapToNode(target, 7 / s.view.scale, new Set(d.sel.map(nodeKey))) : null;
        if (snap) dv = [snap[0] - d.anchor[0], snap[1] - d.anchor[1]];
        overlayRef.current.snap = snap;
        s.liveUpdate(() => syncAll(d.orig, moveNodes(d.orig, d.sel, dv)));
        iRef.current.tooltip = { p, text: `${d.sel.length > 1 ? `${d.sel.length} points · ` : ""}Δ ${dv[0].toFixed(1)}, ${dv[1].toFixed(1)} mm${snap ? " · snapped" : " · Shift: straight · Ctrl: no snapping"}` };
        draw();
        return;
      }
      case "guideend": {
        const g = guidesOf(s.doc.objects.find((o) => o.id === d.id));
        if (!g[d.index]) return;
        d.moved = true;
        const next = g.map((x, i) => (i === d.index ? ((d.end === 0 ? [p, x[1]] : [x[0], p]) as [Vec2, Vec2]) : x));
        setGuides(d.id, next, true);
        const v = next[d.index];
        iRef.current.tooltip = { p, text: `${(Math.atan2(v[1][1] - v[0][1], v[1][0] - v[0][0]) * -180 / Math.PI).toFixed(0)}°` };
        draw();
        return;
      }
      case "guidemove": {
        const g = guidesOf(s.doc.objects.find((o) => o.id === d.id));
        if (!g[d.index]) return;
        d.moved = true;
        const dv: Vec2 = [p[0] - d.start[0], p[1] - d.start[1]];
        setGuides(d.id, g.map((x, i) => (i === d.index ? ([[d.orig[0][0] + dv[0], d.orig[0][1] + dv[1]], [d.orig[1][0] + dv[0], d.orig[1][1] + dv[1]]] as [Vec2, Vec2]) : x)), true);
        draw();
        return;
      }
      case "guidedraw":
        overlayRef.current.guideDraft = [d.a, e.shiftKey ? constrainAngle(d.a, p, 15) : p];
        draw();
        return;
      case "rampend": {
        d.moved = true;
        updateRamp(d.id, { [d.which]: p }, true);
        iRef.current.tooltip = { p, text: d.which === "from" ? "Dense end" : "Open end" };
        draw();
        return;
      }
      case "rampvec":
        overlayRef.current.rampDraft = { a: d.a, b: e.shiftKey ? constrainAngle(d.a, p, 45) : p };
        draw();
        return;
      case "build": {
        const f = faceAt(p);
        if (f != null && !d.faces.includes(f)) d.faces.push(f);
        builderRef.current.hover = f;
        draw();
        return;
      }
      case "nodemarquee":
        overlayRef.current.nodeMarquee = { x: Math.min(d.a[0], p[0]), y: Math.min(d.a[1], p[1]), w: Math.abs(p[0] - d.a[0]), h: Math.abs(p[1] - d.a[1]) };
        draw();
        return;
      case "ref": {
        const o = d.orig;
        d.moved = true;
        let patch: Partial<ReferenceImage> = {};
        if (d.mode === "move") patch = { x: o.x + p[0] - d.start[0], y: o.y + p[1] - d.start[1] };
        else if (d.mode === "rotate") {
          const c = refCenter(o);
          let a = o.rotation + ((Math.atan2(p[1] - c[1], p[0] - c[0]) - d.a0) * 180) / Math.PI;
          if (e.shiftKey) a = Math.round(a / 15) * 15;
          a = ((a % 360) + 540) % 360 - 180;
          patch = { rotation: Math.round(a * 10) / 10 };
          iRef.current.tooltip = { p, text: `${patch.rotation}° · Shift: 15° steps` };
        } else {
          // the opposite corner stays put; Shift: free aspect ratio
          const sx = d.corner === 1 || d.corner === 2 ? 1 : -1;
          const sy = d.corner >= 2 ? 1 : -1;
          const opp: Vec2 = [(-sx * o.width) / 2, (-sy * o.height) / 2];
          const q = toLocal(o, p);
          let w = Math.max(1, (q[0] - opp[0]) * sx);
          let h = Math.max(1, (q[1] - opp[1]) * sy);
          if (!e.shiftKey) {
            const k = Math.max(w / o.width, h / o.height);
            w = o.width * k;
            h = o.height * k;
          }
          const c = toWorld(o, [opp[0] + (sx * w) / 2, opp[1] + (sy * h) / 2]);
          patch = { width: w, height: h, x: c[0] - w / 2, y: c[1] - h / 2 };
          iRef.current.tooltip = { p, text: `${w.toFixed(1)} × ${h.toFixed(1)} mm · Shift: free aspect` };
        }
        s.liveUpdate((doc) => ({ ...doc, references: (doc.references ?? []).map((x) => (x.id === o.id ? { ...x, ...patch } : x)) }));
        draw();
        return;
      }
      case "marquee": {
        overlayRef.current.marquee = { x: Math.min(d.a[0], p[0]), y: Math.min(d.a[1], p[1]), w: Math.abs(p[0] - d.a[0]), h: Math.abs(p[1] - d.a[1]) };
        draw();
        return;
      }
      case "move": {
        let dx = p[0] - d.start[0];
        let dy = p[1] - d.start[1];
        if (e.shiftKey) Math.abs(dx) > Math.abs(dy) ? (dy = 0) : (dx = 0);
        if (!d.moved && Math.hypot(dx, dy) * s.view.scale < 3) return;
        if (!d.moved) {
          s.checkpoint();
          if (e.altKey) {
            // Alt-drag: move a copy, leave the original
            const copies = cloneObjects(d.orig);
            s.liveUpdate((doc) => ({ ...doc, objects: [...doc.objects, ...copies] }));
            s.select(copies.map((c) => c.id));
            d.orig = copies;
            d.targets = s.smartGuides ? snapTargets(useStore.getState().doc, new Set(copies.map((c) => c.id))) : null;
          }
        }
        d.moved = true;
        // smart guides: snap edges / centres to other objects and the hoop (Ctrl: off)
        iRef.current.guides = null;
        if (d.targets && !e.ctrlKey && !e.metaKey) {
          const b0 = unionBoxes(d.orig.map(objectBoundsCached));
          if (b0) {
            const snap = snapBox({ ...b0, x: b0.x + dx, y: b0.y + dy }, d.targets, 6 / s.view.scale);
            if (!(e.shiftKey && dx === 0)) dx += snap.dx;
            if (!(e.shiftKey && dy === 0)) dy += snap.dy;
            iRef.current.guides = snap.guides;
          }
        }
        iRef.current.tooltip = { p, text: `${dx >= 0 ? "+" : ""}${dx.toFixed(1)}, ${dy >= 0 ? "+" : ""}${dy.toFixed(1)} mm${e.altKey ? " · copy" : ""}` };
        const m = translateMat(dx, dy);
        const moved = new Map(d.orig.map((o) => [o.id, transformObject(o, m)]));
        s.liveTransform({ ids: d.orig.map((o) => o.id), m }, (doc) => ({ ...doc, objects: doc.objects.map((o) => moved.get(o.id) ?? o) }));
        return;
      }
      case "scale": {
        // free by default, Shift keeps proportions, Alt scales from the centre
        const b = d.box;
        const hp = handlePoints(b)[d.handle];
        const opp = handlePoints(b)[(d.handle + 4) % 8];
        const [ax, ay] = e.altKey ? [b.x + b.w / 2, b.y + b.h / 2] : opp;
        const side = d.handle % 2 === 1;
        let q: Vec2 = p;
        iRef.current.guides = null;
        if (d.targets && !e.ctrlKey && !e.metaKey) {
          // snap the dragged edge(s)
          const snap = snapBox(
            { x: p[0], y: p[1], w: 0, h: 0 },
            d.targets,
            6 / s.view.scale,
            { x: d.handle === 1 || d.handle === 5 ? [] : [p[0]], y: d.handle === 3 || d.handle === 7 ? [] : [p[1]] },
          );
          q = [p[0] + snap.dx, p[1] + snap.dy];
          iRef.current.guides = snap.guides;
        }
        let sx = d.handle === 1 || d.handle === 5 ? 1 : (q[0] - ax) / (hp[0] - ax || 1e-9);
        let sy = d.handle === 3 || d.handle === 7 ? 1 : (q[1] - ay) / (hp[1] - ay || 1e-9);
        if (e.shiftKey || d.uniform) {
          if (side) {
            // the dragged side sets the factor, the other axis follows it
            const vertical = d.handle === 1 || d.handle === 5;
            const k = vertical ? sy : sx;
            sx = vertical ? Math.abs(k) : k;
            sy = vertical ? k : Math.abs(k);
          } else {
            const k = Math.max(Math.abs(sx), Math.abs(sy));
            sx = Math.sign(sx || 1) * k;
            sy = Math.sign(sy || 1) * k;
          }
        }
        if (Math.abs(sx) < 0.01 || Math.abs(sy) < 0.01) return;
        const m = scaleAbout(sx, sy, ax, ay);
        const next = new Map(d.orig.map((o) => [o.id, xform(o, m)]));
        s.liveTransform({ ids: d.orig.map((o) => o.id), m }, (doc) => ({ ...doc, objects: doc.objects.map((o) => next.get(o.id) ?? o) }));
        iRef.current.tooltip = {
          p,
          text: `${(b.w * Math.abs(sx)).toFixed(1)} × ${(b.h * Math.abs(sy)).toFixed(1)} mm · ${Math.round(Math.abs(sx) * 100)} % × ${Math.round(Math.abs(sy) * 100)} %`,
        };
        return;
      }
      case "rotate": {
        const a = Math.atan2(p[1] - d.center[1], p[0] - d.center[0]);
        let deg = ((a - d.a0) * 180) / Math.PI;
        if (e.shiftKey) deg = Math.round(deg / 15) * 15;
        const m = rotateAbout(deg, d.center[0], d.center[1]);
        const next = new Map(d.orig.map((o) => [o.id, transformObject(o, m, deg)]));
        s.liveTransform({ ids: d.orig.map((o) => o.id), m }, (doc) => ({ ...doc, objects: doc.objects.map((o) => next.get(o.id) ?? o) }));
        const shown = ((deg % 360) + 540) % 360 - 180;
        iRef.current.tooltip = { p, text: `${shown.toFixed(1)}°` };
        return;
      }
      case "skew": {
        // Ctrl-drag a side handle: shear parallel to that side (Alt: around the pivot)
        const b = d.box;
        const horiz = d.handle === 1 || d.handle === 5;
        const hp = handlePoints(b)[d.handle];
        const opp = handlePoints(b)[(d.handle + 4) % 8];
        const [ax, ay] = e.altKey ? d.pivot : opp;
        let k = horiz ? (p[0] - d.start[0]) / (hp[1] - ay || 1e-9) : (p[1] - d.start[1]) / (hp[0] - ax || 1e-9);
        let deg = (Math.atan(k) * 180) / Math.PI;
        if (e.shiftKey) {
          deg = Math.round(deg / 15) * 15;
          k = Math.tan((deg * Math.PI) / 180);
        }
        if (Math.abs(deg) > 80) return;
        const m = horiz ? skewAbout(k, 0, ax, ay) : skewAbout(0, k, ax, ay);
        const next = new Map(d.orig.map((o) => [o.id, xform(o, m)]));
        s.liveTransform({ ids: d.orig.map((o) => o.id), m }, (doc) => ({ ...doc, objects: doc.objects.map((o) => next.get(o.id) ?? o) }));
        iRef.current.tooltip = { p, text: `Skew ${deg.toFixed(1)}°` };
        return;
      }
      case "pivot": {
        // snap the pivot to the box's handles and centre
        const sb = unionBoxes(s.doc.objects.filter((o) => s.selection.includes(o.id)).map(objectBoundsCached));
        let q: Vec2 = p;
        if (sb) {
          const cands = [...handlePoints(sb), [sb.x + sb.w / 2, sb.y + sb.h / 2] as Vec2];
          const near = cands.find((c) => dist(c, p) * s.view.scale < 8);
          if (near) q = near;
        }
        pivotRef.current = { key: d.key, p: q };
        iRef.current.tooltip = { p, text: "Pivot for rotating and scaling · Alt-double-click to reset" };
        draw();
        return;
      }
      case "gradvec": {
        let b2: Vec2 = p;
        if (e.shiftKey) b2 = constrainAngle(d.a, p, 45);
        iRef.current.gradDraft = { a: d.a, b: b2 };
        const len = dist(d.a, b2);
        iRef.current.tooltip = { p, text: d.target ? `Gradient ${len.toFixed(1)} mm · Shift: 45° steps` : "Select or start on a closed shape" };
        draw();
        return;
      }
      case "gradend": {
        const sg = selectedGradient();
        if (!sg) return;
        const other = d.which === "from" ? sg.params.to : sg.params.from;
        const q = e.shiftKey ? constrainAngle(other, p, 45) : p;
        const patch: Partial<GradientParams> & { angle?: number } = { [d.which]: q };
        updateGradient(d.group, patch, true);
        draw();
        return;
      }
      case "gradnode": {
        const sg = selectedGradient();
        if (!sg) return;
        const g = sg.params;
        const dx = p[0] - d.start[0];
        const dy = p[1] - d.start[1];
        const moved = <T extends { p: Vec2 }>(xs: T[]) =>
          xs.map((x, i) => {
            const k = d.idx.indexOf(i);
            return k < 0 ? x : { ...x, p: [d.orig[k][0] + dx, d.orig[k][1] + dy] as Vec2 };
          });
        if (g.kind === "mesh" && g.mesh) updateGradient(d.group, { mesh: { ...g.mesh, nodes: moved(g.mesh.nodes) } }, true);
        else if (g.points) updateGradient(d.group, { points: moved(g.points) }, true);
        d.moved = true;
        draw();
        return;
      }
      case "gradspread": {
        const sg = selectedGradient();
        const q = sg?.params.points?.[d.idx];
        if (!sg || !q) return;
        const spread = Math.max(0.5, dist(q.p, p));
        updateGradient(d.group, { points: sg.params.points!.map((x, i) => (i === d.idx ? { ...x, spread } : x)) }, true);
        iRef.current.tooltip = { p, text: "Spread " + spread.toFixed(1) + " mm" };
        draw();
        return;
      }
      case "gradstop": {
        const g = d.g;
        const dv = [g.to[0] - g.from[0], g.to[1] - g.from[1]];
        const l2 = dv[0] * dv[0] + dv[1] * dv[1] || 1;
        const t = Math.min(1, Math.max(0, ((p[0] - g.from[0]) * dv[0] + (p[1] - g.from[1]) * dv[1]) / l2));
        setStops(d.group, d.stops.map((st, i) => (i === d.index ? { ...st, pos: t } : st)), true);
        iRef.current.tooltip = { p, text: `${Math.round(t * 100)} %` };
        draw();
        return;
      }
      case "corner": {
        const along = (p[0] - d.p[0]) * d.dir[0] + (p[1] - d.p[1]) * d.dir[1];
        const r = Math.round(radiusFromWidget(along, d.phi) * 10) / 10;
        const src = d.orig.paths[d.sp];
        const paths = d.orig.paths.map((sp, i) => {
          if (d.all) return roundCorners(sp, r, cornerStyle);
          if (i !== d.sp) return sp;
          const radii = src.nodes.map((_, k) => (k === d.k ? r : 0));
          return roundCorners(sp, radii, cornerStyle);
        });
        const o = { ...d.orig, paths };
        s.liveUpdate((doc) => syncGradientGeometry({ ...doc, objects: doc.objects.map((x) => (x.id === o.id ? o : x)) }, o));
        iRef.current.tooltip = { p, text: `${d.all ? "All corners" : "Corner"} ${r.toFixed(1)} mm · ${cornerStyle}${d.all ? "" : " · Shift: all corners"} · Alt-click a widget: style` };
        draw();
        return;
      }
      case "node": {
        const o = structuredClone(d.orig);
        const n = o.paths[d.sp].nodes[d.ni];
        const orig = d.orig.paths[d.sp].nodes[d.ni];
        if (d.part === "p") {
          const dx = p[0] - orig.p[0];
          const dy = p[1] - orig.p[1];
          n.p = p;
          if (orig.i) n.i = [orig.i[0] + dx, orig.i[1] + dy];
          if (orig.o) n.o = [orig.o[0] + dx, orig.o[1] + dy];
        } else {
          n[d.part] = p;
          const other = d.part === "i" ? "o" : "i";
          if (orig[other] && !e.altKey && handlesCollinear(orig)) {
            const len = dist(orig[other]!, orig.p);
            const dx = orig.p[0] - p[0];
            const dy = orig.p[1] - p[1];
            const l = Math.hypot(dx, dy) || 1;
            n[other] = [orig.p[0] + (dx / l) * len, orig.p[1] + (dy / l) * len];
          }
        }
        s.liveUpdate((doc) => syncGradientGeometry({ ...doc, objects: doc.objects.map((x) => (x.id === o.id ? o : x)) }, o));
        return;
      }
      case "shape": {
        let w = p[0] - d.a[0];
        let h = p[1] - d.a[1];
        if (e.shiftKey) {
          const k = Math.max(Math.abs(w), Math.abs(h));
          w = Math.sign(w || 1) * k;
          h = Math.sign(h || 1) * k;
        }
        const box = { x: Math.min(d.a[0], d.a[0] + w), y: Math.min(d.a[1], d.a[1] + h), w: Math.abs(w), h: Math.abs(h) };
        const so = s.toolOptions.shape;
        overlayRef.current.shape = {
          kind: d.shape,
          box,
          path: d.shape === "rect" && (so.kind !== "rect" || so.radius > 0) ? shapeToolPath(so.kind, box, so) : undefined,
        };
        draw();
        return;
      }
      case "freehand": {
        const fh = fhRef.current;
        if (!fh) return;
        extendStroke(fh, p, ropeLength(s.toolOptions.freehand.smoothing, s.view.scale), 1.5 / s.view.scale);
        draw();
        return;
      }
      case "pen-new": {
        const pd = penRef.current;
        if (!pd) return;
        const n = pd.nodes[d.idx];
        if (spaceRef.current) {
          // Space: reposition the point while placing it
          pd.nodes[d.idx] = moveAnchor(n, [n.p[0] + p[0] - d.last[0], n.p[1] + p[1] - d.last[1]]);
        } else {
          if (!d.moved && dist(n.p, p) * s.view.scale < 3) return;
          d.moved = true;
          pullHandles(n, p, { shift: e.shiftKey, onlyOut: e.altKey, keepIn: n.i });
        }
        d.last = p;
        draw();
        return;
      }
      case "pen-close": {
        const pd = penRef.current;
        if (!pd) return;
        if (!d.moved && dist(pd.nodes[0].p, p) * s.view.scale < 3) return;
        d.moved = true;
        pullHandles(pd.nodes[0], p, { shift: e.shiftKey, onlyOut: false });
        draw();
        return;
      }
      case "pen-last": {
        const pd = penRef.current;
        if (!pd) return;
        const n = pd.nodes[pd.nodes.length - 1];
        if (!d.moved && dist(n.p, p) * s.view.scale < 3) return;
        d.moved = true;
        pullHandles(n, p, { shift: e.shiftKey, onlyOut: true, keepIn: d.keepIn });
        draw();
        return;
      }
      case "pen-anchor": {
        const pd = penRef.current;
        if (!pd) return;
        if (!d.moved && dist(d.start, p) * s.view.scale < 3) return;
        d.moved = true;
        const to = e.shiftKey ? constrainAngle(d.orig.p, p, 45) : p;
        pd.nodes[d.idx] = moveAnchor(d.orig, [d.orig.p[0] + to[0] - d.start[0], d.orig.p[1] + to[1] - d.start[1]]);
        draw();
        return;
      }
      case "pen-handle": {
        const pd = penRef.current;
        if (!pd) return;
        pd.nodes[d.idx] = moveHandle(d.orig, d.part, p, e.altKey, e.shiftKey);
        draw();
        return;
      }
      case "ruler":
        overlayRef.current.ruler = { a: d.a, b: p };
        draw();
        return;
      case "texthandle": {
        const v = (p[0] - d.start[0]) * d.h.dir![0] + (p[1] - d.start[1]) * d.h.dir![1];
        if (!d.moved && Math.abs(v) * s.view.scale < 2) return;
        d.moved = true;
        let label: string;
        if (d.h.kind === "text-arc") {
          let arc = d.spec.arc + v * s.view.scale * 0.75;
          arc = Math.max(-330, Math.min(330, e.shiftKey ? Math.round(arc / 15) * 15 : Math.round(arc)));
          updateText(d.group, { arc }, true);
          label = arc ? `Arc ${arc}°` : "Straight";
        } else {
          const lines = d.spec.content.split("\n").map((l) => Array.from(l).length);
          const gaps = Math.max(1, Math.max(...lines) - 1);
          const k = d.spec.align === "center" ? 2 : 1;
          let ls = d.spec.letterSpacing + (v * k) / gaps;
          ls = Math.max(-d.spec.size * 0.5, Math.min(d.spec.size * 3, e.shiftKey ? Math.round(ls * 2) / 2 : Math.round(ls * 20) / 20));
          updateText(d.group, { letterSpacing: ls }, true);
          label = `Letter spacing ${ls.toFixed(2)} mm`;
        }
        iRef.current.tooltip = { p, text: label };
        draw();
        return;
      }
      case "handle": {
        const res = dragHandle(d.orig, d.h, p, s.view.scale, e.shiftKey);
        d.moved = true;
        s.liveUpdate((doc) => ({ ...doc, objects: doc.objects.map((o) => (o.id === res.object.id ? res.object : o)) }));
        iRef.current.tooltip = { p, text: res.label };
        draw();
        return;
      }
      case "cut": {
        if (!d.moved && dist(d.a, p) * s.view.scale < 4) return;
        d.moved = true;
        iRef.current.cutLine = { a: d.a, b: p };
        iRef.current.cutPoint = null;
        draw();
        return;
      }
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const s = useStore.getState();
    const d = dragRef.current;
    dragRef.current = null;
    // the drag's transform is done: the plan follows the document again
    if (s.live) s.liveTransform(null);
    if (!d) return;
    if (d.kind === "move" || d.kind === "scale" || d.kind === "rotate" || d.kind === "skew" || d.kind === "pivot") {
      iRef.current.guides = null;
      iRef.current.tooltip = null;
      if (d.kind !== "pivot" && d.kind !== "move") pivotRef.current = pivotRef.current?.key === selKey() ? pivotRef.current : null;
      draw();
      if (d.kind !== "move") return;
    }
    if (d.kind === "gradvec") {
      const draft = iRef.current.gradDraft;
      iRef.current.gradDraft = null;
      iRef.current.tooltip = null;
      if (!draft || dist(draft.a, draft.b) * s.view.scale < 6) {
        const h = pick(toMm(e));
        s.select(h ? unitIds(s.doc, h) : []);
        draw();
        return;
      }
      if (d.group) updateGradient(d.group, { from: draft.a, to: draft.b });
      else if (d.target) {
        if (!makeGradient(d.target, draft.a, draft.b)) s.toast("Gradients need a closed shape", "error");
      } else s.toast("Select a closed shape, then drag across it");
      draw();
      return;
    }
    if (d.kind === "gradend" || d.kind === "gradstop" || d.kind === "gradnode" || d.kind === "gradspread" || d.kind === "corner") {
      iRef.current.tooltip = null;
      draw();
      return;
    }
    if (d.kind === "guideend" || d.kind === "guidemove") {
      iRef.current.tooltip = null;
      if (!d.moved) s.undo();
      draw();
      return;
    }
    if (d.kind === "guidedraw") {
      const draft = overlayRef.current.guideDraft;
      overlayRef.current.guideDraft = null;
      const o = s.doc.objects.find((x) => x.id === d.id);
      if (o) {
        // a click: a guide across the column there; a drag: the drawn line
        const g = !draft || dist(draft[0], draft[1]) * s.view.scale < 6 ? guideAcross(o, d.a) : draft;
        if (g) setGuides(o.id, [...guidesOf(o), g]);
      }
      draw();
      return;
    }
    if (d.kind === "rampend") {
      iRef.current.tooltip = null;
      if (!d.moved) s.undo();
      draw();
      return;
    }
    if (d.kind === "rampvec") {
      const draft = overlayRef.current.rampDraft;
      overlayRef.current.rampDraft = null;
      if (!draft || dist(draft.a, draft.b) * s.view.scale < 6) {
        const h = pick(toMm(e));
        s.select(h ? unitIds(s.doc, h) : []);
      } else if (!d.target) s.toast("Select a closed shape (or start the drag on one)");
      else {
        const err = applyRamp(d.target, draft.a, draft.b, d.mode);
        if (err) s.toast(err, "error");
      }
      draw();
      return;
    }
    if (d.kind === "build") {
      void applyBuild(d.faces, d.del || e.altKey);
      draw();
      return;
    }
    if (d.kind === "nodes" || d.kind === "ref") {
      overlayRef.current.snap = null;
      iRef.current.tooltip = null;
      if (!d.moved) s.undo(); // a click: drop the checkpoint
      draw();
      return;
    }
    if (d.kind === "nodemarquee") {
      const m = overlayRef.current.nodeMarquee;
      overlayRef.current.nodeMarquee = null;
      if (m && m.w * s.view.scale > 3 && m.h * s.view.scale > 3) {
        const found = nodesInBox(s.doc, s.selection, m);
        if (d.add) {
          const have = new Set(s.nodeSel.map(nodeKey));
          s.set({ nodeSel: [...s.nodeSel, ...found.filter((x) => !have.has(nodeKey(x)))] });
        } else s.set({ nodeSel: found });
      } else if (d.hit) {
        // a click on another object: edit its points (Shift: as well)
        s.select(e.shiftKey ? [...s.selection, d.hit.id] : [d.hit.id]);
      } else if (!d.add) {
        if (s.nodeSel.length) s.set({ nodeSel: [] });
        else if (!pick(toMm(e))) {
          s.select([]);
          s.setTool("select");
        }
      }
      draw();
      return;
    }
    switch (d.kind) {
      case "marquee": {
        const m = overlayRef.current.marquee;
        overlayRef.current.marquee = null;
        if (m && m.w > 0.5 && m.h > 0.5) {
          const ids = s.doc.objects
            .filter((o) => o.visible && !o.locked)
            .filter((o) => {
              const b = objectBounds(o);
              return b && b.x >= m.x && b.y >= m.y && b.x + b.w <= m.x + m.w && b.y + b.h <= m.y + m.h;
            })
            .map((o) => o.id);
          s.select(d.add ? [...new Set([...s.selection, ...ids])] : ids);
        }
        draw();
        return;
      }
      case "shape": {
        const sh = overlayRef.current.shape;
        overlayRef.current.shape = null;
        if (sh && sh.box.w > 0.5 && sh.box.h > 0.5) {
          const b = sh.box;
          const so = s.toolOptions.shape;
          const path = sh.kind === "rect" ? (so.kind !== "rect" || so.radius > 0 ? shapeToolPath(so.kind, b, so) : rectPath(b.x, b.y, b.w, b.h)) : ellipsePath(b.x + b.w / 2, b.y + b.h / 2, b.w / 2, b.h / 2);
          const name = sh.kind === "ellipse" ? "Ellipse" : so.kind === "polygon" ? `${so.sides}-gon` : so.kind === "star" ? `${so.sides}-point star` : so.radius > 0 ? "Rounded rectangle" : "Rectangle";
          const o = newObject([path], defaultStitch("fill"), name);
          s.addObjects([o]);
          s.select([o.id]);
        }
        draw();
        return;
      }
      case "freehand": {
        const fh = fhRef.current;
        fhRef.current = null;
        if (!fh) return draw();
        const pts = finishStroke(fh);
        let length = 0;
        for (let i = 1; i < pts.length; i++) length += dist(pts[i], pts[i - 1]);
        if (length * s.view.scale < 4) return draw();
        const fo = s.toolOptions.freehand;
        const closed = isClosedStroke(pts, s.view.scale);
        const sp = strokeToPath(pts, fo.smoothing, s.view.scale, closed, fo.corners ?? 65, fo.lines ?? true);
        if (sp.nodes.length < 2) return draw();
        const o =
          closed && fo.closed === "fill"
            ? newObject([sp], defaultStitch("fill"), "Fill")
            : fo.output === "satin"
              ? newObject([sp], { ...defaultStitch("satin"), width: fo.width } as StitchParams, "Satin")
              : newObject([sp], runStitch(fo.output === "triple" ? "triple" : "running", s.toolOptions.pen.length), "Running");
        s.addObjects([o]);
        s.select([o.id]);
        draw();
        return;
      }
      case "pen-new":
      case "pen-anchor":
      case "pen-handle":
        draw();
        return;
      case "pen-close":
        finishPen(true);
        return;
      case "pen-last":
        if (!d.moved) finishPen(false);
        else draw();
        return;
      case "ruler":
        return;
      case "texthandle":
      case "handle":
        iRef.current.activeHandle = null;
        iRef.current.tooltip = null;
        if (!d.moved) s.undo(); // nothing changed: drop the checkpoint
        draw();
        return;
      case "cut": {
        const p = toMm(e);
        iRef.current.cutLine = null;
        iRef.current.cutPoint = null;
        if (d.moved) {
          const targets = s.doc.objects.filter((o) => o.visible && !o.locked && o.stitch.type === "fill" && crossesObject(o, d.a, p));
          let n = 0;
          let doc = s.doc;
          for (const o of targets) {
            const parts = cutFillObject(o, d.a, p);
            if (!parts) continue;
            doc = { ...doc, objects: doc.objects.flatMap((x) => (x.id === o.id ? parts : [x])) };
            n++;
          }
          if (n) {
            s.setDoc(doc, { keepSelection: false });
            s.toast(`Cut ${n} fill${n > 1 ? "s" : ""} in two`, "success");
          }
        } else {
          const hit = pick(p);
          if (hit && isPathObject(hit)) {
            // two-rail satins: both rails at once (a cut across the column)
            const parts = cutSatinObject(hit, p) ?? cutPathObject(hit, p);
            if (parts) {
              replaceObjects(hit, parts);
              s.select(parts.map((x) => x.id));
              s.toast(parts.length > 1 ? "Split into two objects" : "Opened the closed path at this point", "success");
            }
          }
        }
        draw();
        return;
      }
      default:
        void e;
        draw();
    }
  };

  const onWheel = (e: React.WheelEvent) => {
    const s = useStore.getState();
    if (s.tool === "satin" && !e.ctrlKey && !e.metaKey) {
      const step = -Math.sign(e.deltaY) * (e.shiftKey ? 0.5 : 0.1);
      const pd = penRef.current;
      const hv = penHoverRef.current;
      const idx = pd ? (hv.kind === "anchor" ? hv.index : hv.kind === "last" ? pd.nodes.length - 1 : hv.kind === "close" ? 0 : -1) : -1;
      if (pd && idx >= 0) {
        // width of the point under the pointer
        const w = Math.min(15, Math.max(0.3, Math.round((pd.widths[idx] + step) * 20) / 20));
        pd.widths[idx] = w;
        penHint(`Point width ${w.toFixed(2)} mm`, pd.nodes[idx].p);
        draw();
        return;
      }
      setSatinWidth(s.toolOptions.satin.width + step, toMm(e));
      return;
    }
    const r = canvasRef.current!.getBoundingClientRect();
    const mx = e.clientX - r.left;
    const my = e.clientY - r.top;
    if (e.ctrlKey || e.metaKey || !e.shiftKey) {
      const k = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015));
      const scale = Math.max(0.3, Math.min(400, s.view.scale * k));
      const f = scale / s.view.scale;
      s.setView({ scale, ox: mx - (mx - s.view.ox) * f, oy: my - (my - s.view.oy) * f });
    } else {
      s.setView({ ox: s.view.ox - e.deltaY, oy: s.view.oy - e.deltaX });
    }
  };

  const [dropping, setDropping] = useState<null | "reference" | "digitize" | "none">(null);
  const isImageDrag = (e: React.DragEvent) => [...e.dataTransfer.items].some((i) => i.kind === "file" && i.type.startsWith("image/"));
  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDropping(null);
    const f = e.dataTransfer.files?.[0];
    if (f) await openDroppedFile(f);
  };
  const dropAs = async (as: "reference" | "digitize", e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDropping(null);
    const f = [...e.dataTransfer.files].find((x) => x.type.startsWith("image/")) ?? e.dataTransfer.files?.[0];
    if (!f) return;
    if (as === "digitize") return openDroppedFile(f);
    // centred where the picture was dropped
    await addReference(f.name, new Uint8Array(await f.arrayBuffer()), toMm(e));
  };
  useEffect(() => {
    const end = () => setDropping(null);
    window.addEventListener("dragend", end);
    window.addEventListener("drop", end);
    const inField = (e: Event) => !!(e.target as HTMLElement)?.closest?.("input,textarea,select,[contenteditable]");
    // Ctrl+V: objects copied in Filum (this or another window), else a picture as a reference
    const paste = (e: ClipboardEvent) => {
      const s = useStore.getState();
      if (s.dialog || inField(e)) return;
      if (clipFromText(e.clipboardData?.getData("text/plain"))) {
        e.preventDefault();
        return pasteClipboard();
      }
      const f = [...(e.clipboardData?.files ?? [])].find((x) => x.type.startsWith("image/"));
      if (!f) return;
      e.preventDefault();
      f.arrayBuffer().then((b) => addReference(f.name || "Pasted picture.png", new Uint8Array(b)));
    };
    // Ctrl+C / Ctrl+X: the selected objects
    const copy = (cut: boolean) => (e: ClipboardEvent) => {
      const s = useStore.getState();
      if (s.dialog || inField(e) || !s.selection.length || window.getSelection()?.toString()) return;
      const text = copySelection(cut);
      if (!text) return;
      e.preventDefault();
      e.clipboardData?.setData("text/plain", text);
    };
    const onCopy = copy(false);
    const onCut = copy(true);
    window.addEventListener("paste", paste);
    window.addEventListener("copy", onCopy);
    window.addEventListener("cut", onCut);
    return () => {
      window.removeEventListener("dragend", end);
      window.removeEventListener("drop", end);
      window.removeEventListener("paste", paste);
      window.removeEventListener("copy", onCopy);
      window.removeEventListener("cut", onCut);
    };
  }, []);
  const refEdit = useStore((s) => s.refEdit);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; onObject: boolean } | null>(null);
  // the menu closes on any click elsewhere
  useEffect(() => {
    if (!ctxMenu) return;
    const close = (e: PointerEvent) => !(e.target as HTMLElement).closest(".menu") && setCtxMenu(null);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setCtxMenu(null);
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", esc);
    };
  }, [ctxMenu]);

  const tool = useStore((s) => s.tool);
  const cursor =
    tool === "pan" ? "grab" : tool === "select" ? "default" : tool === "node" ? "default" : tool === "text" ? "text" : "crosshair";

  useEffect(() => {
    // prevent browser zoom on ctrl+wheel over the canvas
    const c = canvasRef.current!;
    const h = (e: WheelEvent) => e.preventDefault();
    c.addEventListener("wheel", h, { passive: false });
    return () => c.removeEventListener("wheel", h);
  }, []);

  return (
    <>
    {ctxMenu && <Menu items={contextMenu(ctxMenu.onObject)} x={ctxMenu.x} y={ctxMenu.y} onClose={() => setCtxMenu(null)} />}
    <div
      ref={wrapRef}
      className="canvas-wrap"
      onDragOver={(e) => {
        e.preventDefault();
        if (!dropping) setDropping(isImageDrag(e) ? "none" : null);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropping(null);
      }}
      onDrop={onDrop}
    >
      <canvas ref={bgRef} className="layer-bg" aria-hidden />
      <canvas ref={glCanvasRef} className="layer-gl" aria-hidden />
      <canvas
        ref={canvasRef}
        style={{ cursor }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => {
          setDensityHover(null);
          if (overlayRef.current.hoverId) {
            overlayRef.current.hoverId = null;
            draw();
          }
        }}
        onWheel={onWheel}
        onContextMenu={(e) => {
          e.preventDefault();
          // a right-click (not a right-drag, which pans) opens the menu of what is under it
          const r = rightRef.current;
          rightRef.current = null;
          if (r && (r.moved || Math.hypot(e.clientX - r.x, e.clientY - r.y) > 4)) return;
          const s = useStore.getState();
          if (s.tool !== "select" && s.tool !== "node") return;
          const hit = pick(toMm(e));
          if (hit && !s.selection.includes(hit.id)) s.select(unitIds(s.doc, hit));
          if (!hit && s.selection.length) s.select([]);
          setCtxMenu({ x: e.clientX, y: e.clientY, onObject: !!hit });
        }}
      />
      {refEdit && <ReferenceBar id={refEdit} />}
      {dropping && (
        <div className="drop-choice">
          {(
            [
              ["reference", <ImagePlus key="i" size={26} />, "Reference picture", "Trace over it with the pen and node tools — never stitched"],
              ["digitize", <Digitize key="w" size={26} />, "Auto-digitize", "Turn the picture into stitches"],
            ] as const
          ).map(([id, icon, title, hint]) => (
            <div
              key={id}
              className={`drop-zone ${dropping === id ? "on" : ""}`}
              onDragOver={(e) => {
                e.preventDefault();
                e.stopPropagation();
                if (dropping !== id) setDropping(id);
              }}
              onDrop={(e) => dropAs(id, e)}
            >
              {icon}
              <b>{title}</b>
              <span>{hint}</span>
            </div>
          ))}
        </div>
      )}
    </div>
    </>
  );
}

// helpers re-exported for other modules
export { applyMat };
