// Drawing, cutting and picking on the canvas: the selection marquee, shapes,
// freehand lines, the ruler, Split into satins' lines, the knife, the shape builder.

import { addSplitLine, splittable } from "../../components/SplitTool";
import { dist, ellipsePath, objectBounds, rectPath, defaultStitch } from "../../lib/geometry";
import { useStore } from "../../store";
import type { StitchParams, Vec2 } from "../../types";
import { extendStroke, finishStroke, isClosedStroke, ropeLength, strokeToPath } from "../freehand";
import { cutChords, cutFills, cutPathObject, cutSatinObject } from "../../lib/cut";
import { shapeToolPath } from "../../lib/shapeOps";
import { isPathObject, crossesObject } from "../hit";
import type { PointerEvent as RPointerEvent } from "react";
import type { CanvasCtx, Drag, StoreState } from "../ctx";
import { defaultRunning } from "../../lib/geometry";
import { startStroke } from "../freehand";
import { unitIds } from "../transform";

/** A running or triple running stitch of this length (pen and freehand lines). */
export const runStitch = (kind: "running" | "triple", length: number): StitchParams => ({
  type: "running",
  ...defaultRunning(),
  length,
  beanRepeats: kind === "triple" ? 2 : 0,
});

/** The move of a drawing, cutting or selecting drag. */
export function moveDraw(
  c: CanvasCtx,
  s: StoreState,
  d: Extract<Drag, { kind: "build" | "marquee" | "shape" | "freehand" | "ruler" | "split" | "cut" }>,
  p: Vec2,
  e: RPointerEvent,
) {
  const { builderRef, draw, faceAt, fhRef, iRef, overlayRef, splitLiveRef } = c;
  switch (d.kind) {
    case "build": {
      const f = faceAt(p);
      if (f != null && !d.faces.includes(f)) d.faces.push(f);
      builderRef.current.hover = f;
      draw();
      return;
    }
    case "marquee": {
      overlayRef.current.marquee = { x: Math.min(d.a[0], p[0]), y: Math.min(d.a[1], p[1]), w: Math.abs(p[0] - d.a[0]), h: Math.abs(p[1] - d.a[1]) };
      draw();
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
    case "ruler":
      overlayRef.current.ruler = { a: d.a, b: p };
      draw();
      return;
    case "split": {
      if (!d.moved && dist(d.a, p) * s.view.scale < 4) return;
      d.moved = true;
      splitLiveRef.current = { a: d.a, b: p, dir: d.dir };
      iRef.current.tooltip = { p, text: d.dir ? "The part under this line is sewn this way" : "Cuts where the line is solid: start and end outside the shape" };
      draw();
      return;
    }
    case "cut": {
      if (!d.moved && dist(d.a, p) * s.view.scale < 4) return;
      d.moved = true;
      // the stretches that will cut: inside a fill from edge to edge
      const chords = s.doc.objects
        .filter((o) => o.visible && !o.locked && o.stitch.type === "fill" && crossesObject(o, d.a, p))
        .flatMap((o) => cutChords(o, d.a, p));
      iRef.current.cutLine = { a: d.a, b: p, chords };
      iRef.current.cutPoint = null;
      iRef.current.tooltip = { p, text: chords.length ? "Release to cut where the line is solid" : "Drag all the way across a fill to cut it" };
      draw();
      return;
    }
  }
}

/** The release of a drawing, cutting or selecting drag. */
export function upDraw(
  c: CanvasCtx,
  s: StoreState,
  d: Extract<Drag, { kind: "build" | "marquee" | "shape" | "freehand" | "ruler" | "split" | "cut" }>,
  e: RPointerEvent,
) {
  const { applyBuild, draw, fhRef, iRef, newObject, overlayRef, pick, replaceObjects, splitLiveRef, toMm } = c;
  if (d.kind === "build") {
    void applyBuild(d.faces, d.del || e.altKey);
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
        const path =
          sh.kind === "rect"
            ? so.kind !== "rect" || so.radius > 0
              ? shapeToolPath(so.kind, b, so)
              : rectPath(b.x, b.y, b.w, b.h)
            : ellipsePath(b.x + b.w / 2, b.y + b.h / 2, b.w / 2, b.h / 2);
        const name =
          sh.kind === "ellipse"
            ? "Ellipse"
            : so.kind === "polygon"
              ? `${so.sides}-gon`
              : so.kind === "star"
                ? `${so.sides}-point star`
                : so.radius > 0
                  ? "Rounded rectangle"
                  : "Rectangle";
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
    case "ruler":
      return;
    case "split": {
      const p = toMm(e);
      splitLiveRef.current = null;
      iRef.current.tooltip = null;
      if (d.moved && dist(d.a, p) > 0.3) {
        if (!s.splitDraft.id) {
          // no shape yet: the fill the line crosses
          const f = s.doc.objects.find((o) => splittable(o) && o.visible && cutChords(o, d.a, p).length);
          if (f) s.set({ splitDraft: { ...s.splitDraft, id: f.id } });
        }
        if (useStore.getState().splitDraft.id) addSplitLine([d.a, p], d.dir);
        else s.toast("Draw across a fill shape");
      }
      draw();
      return;
    }
    case "cut": {
      const p = toMm(e);
      iRef.current.cutLine = null;
      iRef.current.cutPoint = null;
      iRef.current.tooltip = null;
      if (d.moved) {
        const targets = s.doc.objects.filter((o) => o.visible && !o.locked && o.stitch.type === "fill" && crossesObject(o, d.a, p));
        // gradients, tartans and colour blends: cut as one, each half a set of its own
        const { doc, n, left } = cutFills(s.doc, targets, d.a, p);
        if (n) {
          s.setDoc(doc, { keepSelection: false });
          s.toast(`Cut ${n} fill${n > 1 ? "s" : ""} in two`, "success");
        }
        if (left) s.toast(`${left} gradient${left > 1 ? "s, tartans or blends" : ", tartan or blend"} left whole: a layer is locked or hidden`, "error");
        if (!n && !left && targets.length) s.toast("Nothing cut: drag all the way across the shape", "info");
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
  }
}

/** A press with the ruler, shape, freehand, knife, Split or builder tool: which drag it starts. */
export function downDraw(
  c: CanvasCtx,
  tool: "ruler" | "rect" | "ellipse" | "freehand" | "cut" | "split" | "builder",
  s: StoreState,
  e: RPointerEvent,
  p: Vec2,
) {
  const { dragRef, draw, faceAt, fhRef, iRef, pick, refreshRegions } = c;
  switch (tool) {
    case "ruler":
      dragRef.current = { kind: "ruler", a: p };
      return;
    case "rect":
    case "ellipse":
      dragRef.current = { kind: "shape", shape: tool, a: p };
      return;
    case "freehand":
      fhRef.current = startStroke(p);
      dragRef.current = { kind: "freehand" };
      iRef.current.tooltip = null;
      return;
    case "cut":
      dragRef.current = { kind: "cut", a: p, moved: false };
      return;
    case "split": {
      const dft = s.splitDraft;
      const h = pick(p);
      const cur = dft.id ? s.doc.objects.find((o) => o.id === dft.id) : undefined;
      // the shape: the one clicked (while no line is drawn yet), else the one being split, else the selected fill
      const lone = s.selection.length === 1 ? s.doc.objects.find((o) => o.id === s.selection[0]) : undefined;
      const next =
        splittable(h) && (!cur || (!dft.cuts.length && !dft.directions.length)) ? h : cur && splittable(cur) ? cur : splittable(lone) ? lone : undefined;
      if (next && next.id !== dft.id) {
        // not selected: its stitches and handles would cover the preview of the parts
        s.set({ splitDraft: { ...dft, id: next.id, cuts: [], directions: [], order: [] } });
        if (s.selection.length) s.select([]);
      } else if (!next && h) s.toast("Split into satins works on fill shapes");
      dragRef.current = { kind: "split", a: p, dir: e.altKey || dft.draw === "direction", moved: false };
      return;
    }
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
  }
}
