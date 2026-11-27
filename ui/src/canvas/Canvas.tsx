import { useCallback, useEffect, useRef, useState } from "react";
import { Menu } from "../components/MenuBar";
import { useDismiss } from "../components/ui";
import { contextMenu, type MenuItem } from "../components/menuModel";
import { connectionAt, describeConnection } from "../lib/links";
import { clipFromText, copySelection, pasteClipboard } from "../lib/arrange";
import { setDensityHover } from "../lib/density";
import { ImagePlus } from "lucide-react";
import { Digitize } from "../icons/stitch";
import { applyMat, dist, objectBounds, transformObject, uid, unionBoxes, defaultStitch, type Box } from "../lib/geometry";
import { activeThreadOf, useStore } from "../store";
import type { DesignObject, NodeRef, ReferenceImage, StitchDocument, StitchParams, SubPath, Vec2 } from "../types";
import { isRailSatin, joinNodes, nodeKey } from "../lib/nodeOps";
import { addReference, refCenter, refContains, refCorners, refRotateKnob } from "../lib/references";
import { ReferenceBar } from "../components/ReferenceBar";
import { rampMembers, rampOf, rampRows, selectedRamp } from "../lib/ramp";
import { builderRefusal } from "../lib/shapeBuilder";
import { guideHit, pickedLine, selectedSatin } from "../lib/satinGuides";
import { freeSides, orientationLines } from "../lib/satinSides";
import { engine, type ShapeRegion } from "../engine/client";
import { handlePoints, readTheme, Renderer, rotateHandle, type Overlay, type Theme } from "./render";
import { StitchGL } from "./gl";
import { threadWidth } from "../lib/materials";
import { computeHandles, computeTextHandles, handleAt, type Handle } from "./handles";
import { createTextAt, selectedTextGroup, textSpec } from "../lib/textOps";
import { members } from "../lib/text";
import type { InteractiveOverlay } from "./interactive";
import { buildSatin, satinOutlineOf, zigzagPreview } from "../lib/satinDraw";
import { addPoint, canClose, continueFrom, deleteFromDraft, insertInDraft, newDraft, PEN_HINTS, CURVE_HINTS, penHitTest, placePoint, removeLast, rubberBand, toggleSmoothInDraft, type PenDraft, type PenHover, addCurvePoint, curvePreview, smoothDraft } from "./penTool";
import { isClosedStroke, type FreehandStroke } from "./freehand";
import { flattenSubPath, insertNode, resample } from "../lib/bezier";
import { ROTATE_CURSOR, SKEW_CURSOR, rotateZone, unitIds } from "./transform";
import { finishedPlan } from "../lib/cuts";
import { commit2D, meshInsert, meshLineHit, meshLocate, meshValid, nodeHit, removeNodes, selectedGradient, stopsOf, weightsAt } from "../lib/gradient";
import { pxPerMm } from "../lib/screen";
import { nearestOnPaths } from "../lib/cut";
import { computeIssues } from "../lib/issues";
import { issuesShown } from "../lib/panelActions";
import { displayPlan } from "../lib/threads";
import { cornerWidgets } from "../lib/shapeOps";
import { openDroppedFile } from "../lib/actions";
import { normAngle } from "../lib/geometry";
import { freshCopies } from "../lib/copies";
import { replaceObject } from "../lib/docEdit";
import { fitView, zoomAt } from "../lib/view";
import { transformBox, hitObject, isPathObject, nextName } from "./hit";
import { Drag, HANDLE_HINTS } from "./drag";
import { splitOverlay, liveFrame } from "./overlays";
import { AutoFit, keepInView, layers, captureFrame } from "./viewport";
import { downSelect, moveTransform, upTransform } from "./gestures/transform";
import type { CanvasCtx } from "./ctx";
import { downGradient, moveGradient, upGradient } from "./gestures/gradient";
import { penState } from "./drag";
import { cornerWidgetHit, downNode, movePen, nodeInsertTarget, railPair, upPen } from "./gestures/pen";
import { downDraw, moveDraw, upDraw } from "./gestures/draw";
import { runStitch } from "./gestures/draw";
import { downGuides, moveHandles, upHandles } from "./gestures/handles";

/** Start mirroring every rendered frame into a canvas (for MediaRecorder). */
/** Corner style of the live corner widgets (Alt-click a widget to cycle). */

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
  /** Split into satins: the line being dragged. */
  const splitLiveRef = useRef<{ a: Vec2; b: Vec2; dir: boolean } | null>(null);
  const handlesRef = useRef<Handle[]>([]);
  const spaceRef = useRef(false);
  const rafRef = useRef(0);
  /** The hoop was zoomed out to fit a shrinking canvas: the zoom to return to, and the view set then. */
  const autoFitRef = useRef<AutoFit | null>(null);
  const rendererRef = useRef<Renderer>(new Renderer());
  // layers, bottom to top: background (2D) · stitches (WebGL2) · overlays + input (2D)
  const bgRef = useRef<HTMLCanvasElement>(null);
  const glCanvasRef = useRef<HTMLCanvasElement>(null);
  const glRef = useRef<StitchGL | null | undefined>(undefined);
  const glDirtyRef = useRef(false);

  /** Paint now (a resized canvas is blank until it is painted again). */
  const paint = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    {
      const c = canvasRef.current;
      const bg = bgRef.current;
      if (!c || !bg) return;
      const s = useStore.getState();
      if (!themeRef.current) themeRef.current = readTheme(c);
      const { w, h, dpr } = sizeRef.current;
      if (glRef.current === undefined && glCanvasRef.current) glRef.current = StitchGL.create(glCanvasRef.current);
      // the GPU dropped the context: the 2D drawing takes over until it is back
      const gl = glRef.current && !glRef.current.isLost() ? glRef.current : null;
      const shownPlan = displayPlan(s.plan && s.finished && s.viewMode !== "vector" ? finishedPlan(s.plan) : s.plan, s.stitchColors, s.colorFocus ? activeThreadOf(s) : null, s.fabricColor);
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
      const threadColor = s.doc.threads.find((t) => t.id === (activeThreadOf(s) ?? s.doc.threads[0]?.id))?.color ?? "#b3203a";
      const pd = (s.tool === "pen" || s.tool === "satin" || s.tool === "curve") && penRef.current?.nodes.length ? penRef.current : null;
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
        // curvature: the curve bends towards the cursor as if a point were there
        const cp = s.tool === "curve" && withCursor ? curvePreview(pd) : null;
        penOv = {
          nodes: cp?.nodes ?? pd.nodes,
          rubber: cp ? cp.rubber : pd.kind === "run" && (withCursor || closing) ? rubberBand(pd, closing) : null,
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
        const sb = transformBox(s.doc, s.selection);
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
        split: s.tool === "split" ? splitOverlay(s.doc, s.splitDraft, splitLiveRef.current) : undefined,
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
        // while the stitch-out plays, the selection isn't drawn: its outline
        // would cover what is still to sew (and an imported design's outline is
        // every stitch, redrawn every frame). Paused, it shows what the
        // timeline selects
        selection: s.anim.index == null || !s.anim.playing ? s.selection : [],
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
    }
  }, []);
  const draw = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(paint);
  }, [paint]);

  // size
  useEffect(() => {
    const el = wrapRef.current!;
    const resize = () => {
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
      const prev = sizeRef.current;
      const first = prev.w === 800 && prev.h === 600;
      sizeRef.current = { w: r.width, h: r.height, dpr };
      if (first) {
        const d = useStore.getState().doc;
        useStore.getState().setView(fitView(r.width, r.height, { x: 0, y: 0, w: d.hoop.width, h: d.hoop.height }));
      } else if (prev.w !== r.width || prev.h !== r.height) keepInView(prev, r.width, r.height, autoFitRef);
      // in the same frame: no blank canvas while a panel slides or a sash moves
      paint();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    // moved to a screen with another scaling: same size in CSS pixels, new backing size
    let mq: MediaQueryList | null = null;
    const watchDpr = () => {
      mq?.removeEventListener("change", onDpr);
      mq = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
      mq.addEventListener("change", onDpr);
    };
    const onDpr = () => {
      resize();
      watchDpr();
    };
    watchDpr();
    // the GPU context: lost (driver reset, sleep) and given back
    const glc = glCanvasRef.current;
    const lost = (e: Event) => {
      e.preventDefault(); // lets the browser restore it
      paint();
    };
    const restored = () => {
      glRef.current = undefined; // made again on the next paint
      paint();
    };
    glc?.addEventListener("webglcontextlost", lost);
    glc?.addEventListener("webglcontextrestored", restored);
    return () => {
      ro.disconnect();
      mq?.removeEventListener("change", onDpr);
      glc?.removeEventListener("webglcontextlost", lost);
      glc?.removeEventListener("webglcontextrestored", restored);
    };
  }, [draw]);

  // a drag that ends outside the canvas (or loses the window) still ends: the plan follows again
  useEffect(() => {
    const end = () => {
      if (useStore.getState().live) useStore.getState().liveTransform(null);
    };
    const blur = () => {
      end();
      spaceRef.current = false;
      if (canvasRef.current) canvasRef.current.style.cursor = "";
    };
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      window.removeEventListener("blur", blur);
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
        // zoom to a factor of "actual size" around the centre (the screen's calibration, else 96 dpi)
        const actual = pxPerMm(s.prefs.screenPxPerMm) * which;
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
  /** The document before a click on a point pair turned the pairs into guides (undone when nothing moved). */
  const guideFreedFrom = useRef<StitchDocument | null>(null);
  const guidesOverlay = () => {
    const o = selectedSatin();
    const draft = overlayRef.current.guideDraft ?? null;
    const pl = pickedLine();
    return { lines: orientationLines(o).lines, hover: guideHover.current, picked: o && pl?.id === o.id ? pl.index : null, draft };
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
    // the old faces don't fit the new design: none until the engine answers
    b.regions = null;
    if (!ids.length) return;
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
    // faces of another design or selection would cut the wrong pieces
    if (!b.regions || !faces.length || b.doc !== s.doc) return;
    const ids = b.ids;
    const first = b.regions[faces[0]];
    if (!first) return;
    const no = builderRefusal(s.doc.objects.filter((o) => ids.includes(o.id)));
    if (no) return s.toast(no, "error");
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
    let thread = activeThreadOf(s) ?? s.doc.threads[0]?.id;
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
        if (o.id === skip || !o.visible || o.locked || o.clone || o.stitch.type !== "running") continue;
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

  /** Finish the pen / satin draft into an object (or update the continued one). */
  const finishPen = (closed: boolean) => {
    const s = useStore.getState();
    const d = penRef.current;
    penRef.current = null;
    penHoverRef.current = { kind: "none" };
    iRef.current.tooltip = null;
    if (!d || d.nodes.length < 2) return draw();
    const isClosed = closed && canClose(d);
    // curvature: closed, the first and last points curve through each other
    if (isClosed) smoothDraft(d, true);
    let o: DesignObject;
    if (d.kind === "satin") {
      const { paths, width } = buildSatin(d.nodes, d.widths, isClosed, !!s.toolOptions.satin.twoSides);
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
      s.commit((doc) => replaceObject(doc, old.id, next));
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
    let c = transformObject(o, m as never, rot);
    const det = m[0] * m[3] - m[1] * m[2];
    // a flip, skew or stretch turns the fill rows with the shape (a row runs along (cos a, −sin a))
    if (!rot && c.stitch.type === "fill") {
      const a = (c.stitch.angle * Math.PI) / 180;
      const dx = Math.cos(a);
      const dy = -Math.sin(a);
      const ex = m[0] * dx + m[2] * dy;
      const ey = m[1] * dx + m[3] * dy;
      if (Math.hypot(ex, ey) > 1e-9) c = { ...c, stitch: { ...c.stitch, angle: normAngle(+((Math.atan2(-ey, ex) * 180) / Math.PI).toFixed(3)) } };
    }
    const similarity = Math.abs(m[0] - m[3]) < 1e-9 && Math.abs(m[1] + m[2]) < 1e-9;
    return o.text && (det < 0 || !similarity) ? { ...c, text: undefined } : c;
  };

  /** Copies of objects beside the originals (in their groups; whole groups, letterings and gradients new). */
  const cloneObjects = (objs: DesignObject[]) => freshCopies(useStore.getState().doc, objs, { inPlace: true });


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


  /** An end of a selected open path the pen can continue from. */
  const continuable = (p: Vec2, tol: number, kind: PenDraft["kind"]) => {
    const s = useStore.getState();
    for (const o of s.doc.objects.filter((x) => s.selection.includes(x.id) && !x.locked && !x.clone)) {
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
    if (s.tool === "curve") addCurvePoint(d, q);
    else addPoint(d, q);
    d.cursor = null;
    dragRef.current = { kind: "pen-new", idx: d.nodes.length - 1, moved: false, last: p };
    draw();
  };



  // A two-rail satin's sides are shaped one at a time: the point pairs turn
  // into guides first (the stitches keep their angle). `both` (Ctrl): a pair
  // on both rails, as long as the rails still pair up.
  const insertIntoObject = (o: DesignObject, si: number, seg: number, t: number, both = false) => {
    const pair = both ? railPair(o) : null;
    const base = isRailSatin(o) && !pair ? freeSides(o) : o;
    const paths = [...base.paths];
    const r = insertNode(paths[si], seg, t);
    paths[si] = r.sp;
    if (pair) {
      // the same rung on the other rail (the pairing is its own inverse)
      paths[1 - si] = insertNode(paths[1 - si], pair.seg(seg), pair.rev ? 1 - t : t).sp;
    }
    return { obj: { ...base, paths }, index: r.index };
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
      if (st.dialog || document.querySelector(".backdrop")) return;
      if (st.tool === "satin" && (e.key === "[" || e.key === "]")) {
        setSatinWidth(st.toolOptions.satin.width + (e.key === "]" ? 1 : -1) * (e.shiftKey ? 0.5 : 0.1));
        e.preventDefault();
        return;
      }
      const pd = penRef.current;
      if (pd && (st.tool === "pen" || st.tool === "satin" || st.tool === "curve")) {
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
        const o = st.doc.objects.find((x) => x.id === st.selection[0] && !x.locked);
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
      case "guides":
        return downGuides(ctx, s.tool, s, e, p, tol);
      case "select":
        return downSelect(ctx, s.tool, s, e, p, tol);
      case "node":
        return downNode(ctx, s.tool, s, e, p, tol);
      case "ruler":
      case "rect":
      case "ellipse":
      case "freehand":
      case "cut":
      case "split":
      case "builder":
        return downDraw(ctx, s.tool, s, e, p);
      case "pen":
      case "curve":
      case "satin":
        penDown(e, p, Math.max(tol, 7 / s.view.scale));
        return;
      case "gradient":
        return downGradient(ctx, s.tool, s, e, p, tol);
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
      if (s.tool === "satin" || s.tool === "pen" || s.tool === "curve") {
        const tol = Math.max(6, 7) / s.view.scale;
        const pd = penRef.current;
        const c = canvasRef.current;
        if (pd && pd.nodes.length) {
          const hover = penHitTest(pd, p, tol);
          penHoverRef.current = hover;
          const snap = hover.kind === "none" && !e.shiftKey && !e.ctrlKey && s.prefs.snapPoints ? snapToNode(p, tol) : null;
          overlayRef.current.snap = snap;
          pd.cursor = hover.kind === "none" ? (snap ?? placePoint(pd, p, e.shiftKey)) : null;
          const hints = s.tool === "curve" ? CURVE_HINTS : PEN_HINTS;
          let text = hints[hover.kind];
          if (hover.kind === "none" && pd.kind === "satin") text = `${pd.width.toFixed(2)} mm · scroll or [ ] for width · ${text}`;
          if (hover.kind === "anchor" && pd.kind === "satin") text = `${pd.widths[hover.index].toFixed(2)} mm · scroll to change · ${text}`;
          if (hover.kind === "close" && !canClose(pd)) text = hints.none;
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
          iRef.current.tooltip = { p, text: `Drag to round this corner (${penState.cornerStyle}) · Shift-drag: all corners · Alt-click: corner style` };
          draw();
          return;
        }
        const ins = nodeInsertTarget(p, 8 / s.view.scale);
        iRef.current.insertAt = ins?.p ?? null;
        iRef.current.tooltip = ins ? { p, text: "Drag to bend the curve · click to add a point · Alt-click a point to delete · double-click: smooth ↔ corner" } : null;
        if (canvasRef.current) canvasRef.current.style.cursor = ins ? "copy" : "";
        draw();
        return;
      }
      if (s.tool === "guides") {
        const hit = guideHit(orientationLines(selectedSatin()).lines, p, Math.max(6, 8) / s.view.scale);
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
        const hh = handleAt(handlesRef.current, p, s.view.scale);
        const changed = hh?.kind !== iRef.current.hoverHandle?.kind || hh?.objId !== iRef.current.hoverHandle?.objId;
        iRef.current.hoverHandle = hh;
        iRef.current.tooltip = hh ? { p: hh.p, text: HANDLE_HINTS[hh.kind] } : null;
        if (canvasRef.current) canvasRef.current.style.cursor = hh ? (hh.kind === "reverse" ? "pointer" : "grab") : "";
        if (changed) draw();
        if (hh) return;
        // transform box: resize / skew / rotate / pivot cursors
        const sb = transformBox(s.doc, s.selection);
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
        // with the jumps shown: the line between two objects offers Trim / Jump / Sew (right on it, even over an object)
        const conn = s.showJumps ? (connectionAt(s.plan, p, 4 / s.view.scale) ?? null) : null;
        const hov = conn ? null : (pick(p)?.id ?? null);
        if (hov !== overlayRef.current.hoverId) {
          overlayRef.current.hoverId = hov;
          draw();
        }
        if (conn !== (iRef.current.connHover ?? null)) {
          iRef.current.connHover = conn;
          iRef.current.tooltip = conn ? { p, text: `After ${s.doc.objects[conn.from]?.name ?? "it"}: ${describeConnection(conn)} · click to change` } : null;
          if (canvasRef.current) canvasRef.current.style.cursor = conn ? "pointer" : "";
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
      case "corner":
      case "node":
      case "pen-new":
      case "pen-close":
      case "pen-last":
      case "bend":
      case "pen-anchor":
      case "pen-handle":
      case "nodes":
      case "nodemarquee":
        return movePen(ctx, s, d, p, e);
      case "guideend":
      case "guidemove":
      case "guidedraw":
      case "ref":
      case "texthandle":
      case "handle":
        return moveHandles(ctx, s, d, p, e);
      case "gradvec":
      case "gradend":
      case "gradnode":
      case "gradspread":
      case "gradstop":
      case "rampend":
      case "rampvec":
        return moveGradient(ctx, d, p, e);
      case "build":
      case "marquee":
      case "shape":
      case "freehand":
      case "ruler":
      case "split":
      case "cut":
        return moveDraw(ctx, s, d, p, e);
      case "move":
      case "scale":
      case "rotate":
      case "skew":
      case "pivot":
        return moveTransform(ctx, s, d, p, e);
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const s = useStore.getState();
    const d = dragRef.current;
    dragRef.current = null;
    // the drag's transform is done: the plan follows the document again
    if (s.live) s.liveTransform(null);
    if (!d) return;
    // a click or a drag that changed nothing: no undo step, the redo steps stay.
    // A lettering handle that moved keeps it: its new layout may land only
    // after the release (the font loads first), and that change needs the step.
    if (!(d.kind === "texthandle" && d.moved)) s.dropCheckpoint();
    if (d.kind === "move" || d.kind === "scale" || d.kind === "rotate" || d.kind === "skew" || d.kind === "pivot") {
      upTransform(ctx, d);
      if (d.kind !== "move") return;
    }
    if (d.kind === "gradvec" || d.kind === "gradend" || d.kind === "gradstop" || d.kind === "gradnode" || d.kind === "gradspread" || d.kind === "rampend" || d.kind === "rampvec") return upGradient(ctx, s, d, e);
    if (d.kind === "corner" || d.kind === "nodes" || d.kind === "nodemarquee" || d.kind === "pen-new" || d.kind === "pen-anchor" || d.kind === "pen-handle" || d.kind === "bend" || d.kind === "pen-close" || d.kind === "pen-last") return upPen(ctx, s, d, e);
    if (d.kind === "guideend" || d.kind === "guidemove" || d.kind === "guidedraw" || d.kind === "ref" || d.kind === "texthandle" || d.kind === "handle") return upHandles(ctx, s, d);
    if (d.kind === "build" || d.kind === "marquee" || d.kind === "shape" || d.kind === "freehand" || d.kind === "ruler" || d.kind === "split" || d.kind === "cut") return upDraw(ctx, s, d, e);
    switch (d.kind) {
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
      s.setView(zoomAt(s.view, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)), mx, my));
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
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; onObject: boolean; items?: MenuItem[] } | null>(null);
  // the menu closes on any click elsewhere, and on Escape (which leaves the selection)
  useDismiss(!!ctxMenu, () => setCtxMenu(null), [".menu"]);

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

  // what the gesture modules (canvas/gestures/) use of the component; the
  // handlers above read it when an event comes, after this render
  const ctx: CanvasCtx = { draw, iRef, pivotRef, xform, cloneObjects, selKey, overlayRef, pick, toMm, penRef, spaceRef, snapToNode, finishPen, insertIntoObject, fhRef, splitLiveRef, builderRef, faceAt, applyBuild, newObject, replaceObjects, guideFreedFrom, dragRef, refreshRegions, rampDown, gradient2DDown, guideHover, handlesRef, pivotOf, setCtxMenu };

  return (
    <>
    {ctxMenu && <Menu items={ctxMenu.items ?? contextMenu(ctxMenu.onObject)} x={ctxMenu.x} y={ctxMenu.y} onClose={() => setCtxMenu(null)} />}
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
        // the pointer is gone (cancelled, or the window lost it): the drag ends where it is
        onPointerCancel={onPointerUp}
        onLostPointerCapture={(e) => dragRef.current && onPointerUp(e)}
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
