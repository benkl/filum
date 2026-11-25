// The pen and the node tool on the canvas: drawing a path's points and
// handles, bending segments, moving and rounding points, boxing points.

import { dist } from "../../lib/geometry";
import type { Vec2 } from "../../types";
import { bendSegment, handlesCollinear, moveNodes, nodeKey } from "../../lib/nodeOps";
import { syncAll } from "../../lib/nodeActions";
import { moveAnchor, moveHandle, pullHandles, smoothDraft } from "../penTool";
import { constrainAngle } from "../../lib/bezier";
import { syncGradientGeometry } from "../../lib/gradient";
import { radiusFromWidget, roundCorners } from "../../lib/shapeOps";
import { replaceObject } from "../../lib/docEdit";
import { boxedNodes } from "../hit";
import { penState } from "../drag";
import type { PointerEvent as RPointerEvent } from "react";
import type { CanvasCtx, Drag, StoreState } from "../ctx";
import { guideHit } from "../../lib/satinGuides";
import { orientationLines, removeOrientationLine } from "../../lib/satinSides";
import { toggleSmooth } from "../../lib/bezier";
import { useStore } from "../../store";
import type { DesignObject } from "../../types";
import { isRailSatin, railMap } from "../../lib/nodeOps";
import { nearestOnSubPath } from "../../lib/bezier";
import { cornerWidgets } from "../../lib/shapeOps";
import { freeSides } from "../../lib/satinSides";
import { deleteNode } from "../../lib/bezier";

/** The move of a pen or node tool drag. */
export function movePen(c: CanvasCtx, s: StoreState, d: Extract<Drag, { kind: "corner" | "node" | "pen-new" | "pen-close" | "pen-last" | "bend" | "pen-anchor" | "pen-handle" | "nodes" | "nodemarquee" }>, p: Vec2, e: RPointerEvent) {
  const { draw, iRef, overlayRef, penRef, snapToNode, spaceRef } = c;
  switch (d.kind) {
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
    case "nodemarquee": {
      const m = { x: Math.min(d.a[0], p[0]), y: Math.min(d.a[1], p[1]), w: Math.abs(p[0] - d.a[0]), h: Math.abs(p[1] - d.a[1]) };
      overlayRef.current.nodeMarquee = m;
      // the points inside light up while the box is drawn
      if (Math.max(m.w, m.h) * s.view.scale > 3) s.set({ nodeSel: boxedNodes(s.doc, s.selection, m, d) });
      draw();
      return;
    }
    case "corner": {
      const along = (p[0] - d.p[0]) * d.dir[0] + (p[1] - d.p[1]) * d.dir[1];
      const r = Math.round(radiusFromWidget(along, d.phi) * 10) / 10;
      const src = d.orig.paths[d.sp];
      const paths = d.orig.paths.map((sp, i) => {
        if (d.all) return roundCorners(sp, r, penState.cornerStyle);
        if (i !== d.sp) return sp;
        const radii = src.nodes.map((_, k) => (k === d.k ? r : 0));
        return roundCorners(sp, radii, penState.cornerStyle);
      });
      const o = { ...d.orig, paths };
      s.liveUpdate((doc) => syncGradientGeometry(replaceObject(doc, o.id, o), o));
      iRef.current.tooltip = { p, text: `${d.all ? "All corners" : "Corner"} ${r.toFixed(1)} mm · ${penState.cornerStyle}${d.all ? "" : " · Shift: all corners"} · Alt-click a widget: style` };
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
      s.liveUpdate((doc) => syncGradientGeometry(replaceObject(doc, o.id, o), o));
      return;
    }
    case "pen-new": {
      const pd = penRef.current;
      if (!pd) return;
      const n = pd.nodes[d.idx];
      if (s.tool === "curve") {
        // curvature: dragging moves the point, the curve follows
        if (!d.moved && dist(n.p, p) * s.view.scale < 3) return;
        d.moved = true;
        pd.nodes[d.idx] = { p };
        smoothDraft(pd);
      } else if (spaceRef.current) {
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
      if (s.tool === "curve") {
        pd.nodes[pd.nodes.length - 1] = { p };
        smoothDraft(pd);
      } else pullHandles(n, p, { shift: e.shiftKey, onlyOut: true, keepIn: d.keepIn });
      draw();
      return;
    }
    case "bend": {
      // drag a segment: it bends through the pointer, the end points stay
      if (!d.moved && dist(d.start, p) * s.view.scale < 3) return;
      if (!d.moved) s.checkpoint();
      d.moved = true;
      const paths = [...d.o.paths];
      paths[d.sp] = bendSegment(d.o.paths[d.sp], d.seg, d.t, [p[0] - d.start[0], p[1] - d.start[1]]);
      const o = { ...d.o, paths };
      s.liveUpdate((doc) => syncGradientGeometry(replaceObject(doc, o.id, o), o));
      return;
    }
    case "pen-anchor": {
      const pd = penRef.current;
      if (!pd) return;
      if (!d.moved && dist(d.start, p) * s.view.scale < 3) return;
      d.moved = true;
      const to = e.shiftKey ? constrainAngle(d.orig.p, p, 45) : p;
      pd.nodes[d.idx] = moveAnchor(d.orig, [d.orig.p[0] + to[0] - d.start[0], d.orig.p[1] + to[1] - d.start[1]]);
      smoothDraft(pd);
      draw();
      return;
    }
    case "pen-handle": {
      const pd = penRef.current;
      if (!pd) return;
      pd.nodes[d.idx] = moveHandle(d.orig, d.part, p, e.altKey, e.shiftKey);
      // a handle set by hand no longer follows the neighbours
      if (pd.auto) pd.auto[d.idx] = false;
      draw();
      return;
    }
  }
}

/** The release of a pen or node tool drag. */
export function upPen(c: CanvasCtx, s: StoreState, d: Extract<Drag, { kind: "corner" | "nodes" | "nodemarquee" | "pen-new" | "pen-anchor" | "pen-handle" | "bend" | "pen-close" | "pen-last" }>, e: RPointerEvent) {
  const { draw, finishPen, iRef, insertIntoObject, overlayRef, pick, toMm } = c;
  if (d.kind === "corner") {
    iRef.current.tooltip = null;
    draw();
    return;
  }
  if (d.kind === "nodes") {
    overlayRef.current.snap = null;
    iRef.current.tooltip = null;
    draw();
    return;
  }
  if (d.kind === "nodemarquee") {
    const m = overlayRef.current.nodeMarquee;
    overlayRef.current.nodeMarquee = null;
    // a box (a thin one too: points along a straight line); else a click
    const boxed = !!m && Math.max(m.w, m.h) * s.view.scale > 3;
    // a box that shrank back to a click: the points as they were
    if (!boxed && s.nodeSel !== d.base) s.set({ nodeSel: d.base });
    if (boxed) {
      s.set({ nodeSel: boxedNodes(s.doc, s.selection, m!, d) });
    } else if (d.hit) {
      // a click on another object: edit its points (Shift: as well)
      s.select(e.shiftKey ? [...s.selection, d.hit.id] : [d.hit.id]);
    } else if (!d.add && !d.sub) {
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
    case "pen-new":
    case "pen-anchor":
    case "pen-handle":
      draw();
      return;
    case "bend": {
      if (d.moved) return draw();
      // a click on a segment adds a point there
      s.checkpoint();
      const r = insertIntoObject(d.o, d.sp, d.seg, d.t, d.both);
      s.liveUpdate((doc) => syncGradientGeometry(replaceObject(doc, r.obj.id, r.obj), r.obj));
      s.set({ nodeSel: [{ id: r.obj.id, sp: d.sp, ni: r.index }] });
      draw();
      return;
    }
    case "pen-close":
      finishPen(true);
      return;
    case "pen-last":
      if (!d.moved) finishPen(false);
      else draw();
      return;
  }
}

/** A press with the node tool: which drag it starts. */
export function downNode(c: CanvasCtx, tool: "node", s: StoreState, e: RPointerEvent, p: Vec2, tol: number) {
  const { dragRef, iRef, pick } = c;
  switch (tool) {
    case "node": {
      for (const o of s.doc.objects.filter((x) => s.selection.includes(x.id) && !x.locked)) {
        for (let si = 0; si < o.paths.length; si++)
          for (let ni = 0; ni < o.paths[si].nodes.length; ni++) {
            const n = o.paths[si].nodes[ni];
            for (const part of ["i", "o", "p"] as const) {
              const q = n[part];
              if (q && dist(q, p) < tol) {
                if (part === "p" && e.altKey) {
                  // Alt-click: delete the point (Ctrl too: the pair on both rails of a satin)
                  const next = deleteFromObject(o, si, ni, e.ctrlKey || e.metaKey);
                  if (next) s.commit((doc) => syncGradientGeometry(replaceObject(doc, o.id, next), next));
                  else s.toast("A path needs at least two points");
                  s.set({ nodeSel: [] });
                  return;
                }
                if (part === "p" && e.detail === 2) {
                  const paths = o.paths.map((x, k) => (k === si ? toggleSmooth(x, ni) : x));
                  s.commit((doc) => syncGradientGeometry(replaceObject(doc, o.id, { ...o, paths }), { ...o, paths }));
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
      if (e.altKey) {
        // Alt-click a satin's orientation line (a guide or a point pair): delete it
        for (const o of s.doc.objects.filter((x) => s.selection.includes(x.id) && !x.locked && x.stitch.type === "satin")) {
          const hit = guideHit(orientationLines(o).lines, p, Math.max(tol, 6 / s.view.scale));
          if (hit && hit.end === null) {
            const next = removeOrientationLine(o, hit.index);
            s.commit((doc) => replaceObject(doc, o.id, next));
            return;
          }
        }
      }
      const cw = cornerWidgetHit(p, Math.max(tol, 6 / s.view.scale));
      if (cw) {
        if (e.altKey) {
          penState.cornerStyle = penState.cornerStyle === "round" ? "inverted" : penState.cornerStyle === "inverted" ? "chamfer" : "round";
          s.toast(`Corner style: ${penState.cornerStyle === "round" ? "round" : penState.cornerStyle === "inverted" ? "inverted round" : "chamfer"}`);
          return;
        }
        s.checkpoint();
        dragRef.current = { kind: "corner", id: cw.o.id, sp: cw.sp, k: cw.w.k, orig: cw.o, all: e.shiftKey, p: cw.w.p, dir: cw.w.dir, phi: cw.w.phi };
        return;
      }
      const ins = nodeInsertTarget(p, Math.max(tol, 7 / s.view.scale));
      if (ins) {
        // on a segment: drag to bend it, click to add a point there
        dragRef.current = { kind: "bend", o: ins.o, sp: ins.sp, seg: ins.seg, t: ins.t, start: p, moved: false, both: e.ctrlKey || e.metaKey };
        iRef.current.insertAt = null;
        return;
      }
      // anywhere else: a box selects points (a click decides on release)
      const hit = pick(p);
      // Shift: add to the selected points, Alt: take away from them
      dragRef.current = { kind: "nodemarquee", a: p, add: e.shiftKey, sub: e.altKey && !e.shiftKey, base: s.nodeSel, hit: hit && !s.selection.includes(hit.id) ? hit : null };
      return;
    }
  }
}

/** Two-rail satin whose nodes pair up as rungs (inserting / deleting keeps the pairs). */
export const railPair = (o: DesignObject) => (isRailSatin(o) ? railMap(o.paths[0], o.paths[1]) : null);

/** A live corner widget of a selected shape near `p` (node tool). */
export const cornerWidgetHit = (p: Vec2, tol: number) => {
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

/** Where a node-tool click would add a point (on a selected path, away from nodes). */
export const nodeInsertTarget = (p: Vec2, tol: number) => {
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

export const deleteFromObject = (o: DesignObject, si: number, ni: number, both = false): DesignObject | null => {
  const sp = o.paths[si];
  if (sp.nodes.length <= 2) return null;
  const pair = both ? railPair(o) : null;
  const base = isRailSatin(o) && !pair ? freeSides(o) : o;
  const paths = [...base.paths];
  paths[si] = deleteNode(sp, ni);
  if (pair) paths[1 - si] = deleteNode(paths[1 - si], pair.at(ni));
  return { ...base, paths };
};
