// Handles on the canvas: a stitch's handles (angle, spacing, width, start and
// end), a lettering's arch and spacing, satin guides, reference pictures.

import { dist } from "../../lib/geometry";
import type { ReferenceImage, Vec2 } from "../../types";
import { refCenter, toLocal, toWorld } from "../../lib/references";
import { guideAcross, guidesOf, setGuides } from "../../lib/satinGuides";
import { freeSides } from "../../lib/satinSides";
import { dragHandle } from "../handles";
import { updateText } from "../../lib/textOps";
import { constrainAngle } from "../../lib/bezier";
import { replaceObject } from "../../lib/docEdit";
import type { PointerEvent as RPointerEvent } from "react";
import type { CanvasCtx, Drag, StoreState } from "../ctx";
import { guideHit, pickLine, selectedSatin } from "../../lib/satinGuides";
import { orientationLines, removeOrientationLine } from "../../lib/satinSides";
import { unitIds } from "../transform";

/** The move of a handle drag. */
export function moveHandles(c: CanvasCtx, s: StoreState, d: Extract<Drag, { kind: "guideend" | "guidemove" | "guidedraw" | "ref" | "texthandle" | "handle" }>, p: Vec2, e: RPointerEvent) {
  const { draw, iRef, overlayRef } = c;
  switch (d.kind) {
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
        const sc = d.spacingScale || 1;
        let ls = d.spec.letterSpacing + (v * k) / gaps / sc;
        ls = Math.max((-d.spec.size * 0.5) / sc, Math.min((d.spec.size * 3) / sc, e.shiftKey ? Math.round(ls * 2) / 2 : Math.round(ls * 20) / 20));
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
      s.liveUpdate((doc) => replaceObject(doc, res.object.id, res.object));
      iRef.current.tooltip = { p, text: res.label };
      draw();
      return;
    }
  }
}

/** The release of a handle drag. */
export function upHandles(c: CanvasCtx, s: StoreState, d: Extract<Drag, { kind: "guideend" | "guidemove" | "guidedraw" | "ref" | "texthandle" | "handle" }>) {
  const { draw, guideFreedFrom, iRef, overlayRef } = c;
  if (d.kind === "guideend" || d.kind === "guidemove") {
    // a click on a point pair: it is picked, the pairs stay pairs
    if (!d.moved && guideFreedFrom.current) {
      s.set({ doc: guideFreedFrom.current });
      s.dropCheckpoint();
    } else if (!d.moved) s.dropCheckpoint();
    guideFreedFrom.current = null;
    iRef.current.tooltip = null;
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
      // added to the point pairs, which become guides too (a guide alone would replace them)
      const f = freeSides(o);
      if (g) s.commit((doc) => ({ ...doc, objects: doc.objects.map((x) => (x.id === o.id && f.stitch.type === "satin" ? { ...f, stitch: { ...f.stitch, guides: [...(f.stitch.guides ?? []), g] } } : x)) }));
    }
    draw();
    return;
  }
  if (d.kind === "ref") {
    overlayRef.current.snap = null;
    iRef.current.tooltip = null;
    draw();
    return;
  }
  switch (d.kind) {
    case "texthandle":
    case "handle":
      iRef.current.activeHandle = null;
      iRef.current.tooltip = null;
      draw();
      return;
  }
}

/** A press with the satin guides tool: which drag it starts. */
export function downGuides(c: CanvasCtx, tool: "guides", s: StoreState, e: RPointerEvent, p: Vec2, tol: number) {
  const { dragRef, draw, guideFreedFrom, guideHover, pick } = c;
  switch (tool) {
    case "guides": {
      const gtol = Math.max(tol, 8 / s.view.scale);
      const sat = selectedSatin();
      if (sat) {
        // the satin's orientation lines: its guides, or the point pairs of its rails
        const hit = guideHit(orientationLines(sat).lines, p, gtol);
        if (hit) {
          if (e.altKey) {
            const next = removeOrientationLine(sat, hit.index);
            s.commit((doc) => replaceObject(doc, sat.id, next));
            guideHover.current = null;
            pickLine(null);
            draw();
            return;
          }
          pickLine({ id: sat.id, index: hit.index });
          s.checkpoint();
          // point pairs become guides first (in the same order): then they move like any guide
          const freed = freeSides(sat);
          guideFreedFrom.current = freed !== sat ? s.doc : null;
          if (freed !== sat) s.liveUpdate((doc) => replaceObject(doc, sat.id, freed));
          dragRef.current =
            hit.end === null
              ? { kind: "guidemove", id: sat.id, index: hit.index, start: p, orig: guidesOf(freed)[hit.index], moved: false }
              : { kind: "guideend", id: sat.id, index: hit.index, end: hit.end, moved: false };
          return;
        }
      }
      pickLine(null);
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
  }
}
