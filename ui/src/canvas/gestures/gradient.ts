// Gradients and density ramps on the canvas: dragging a new one across a
// shape, its ends, colour stops, mesh nodes and spread.

import { dist } from "../../lib/geometry";
import type { Vec2 } from "../../types";
import { applyRamp, updateRamp } from "../../lib/ramp";
import { constrainAngle } from "../../lib/bezier";
import { unitIds } from "../transform";
import { makeGradient, selectedGradient, setStops, updateGradient } from "../../lib/gradient";
import type { GradientParams } from "../../types";
import type { PointerEvent as RPointerEvent } from "react";
import type { CanvasCtx, Drag, StoreState } from "../ctx";
import { is2D, makeGradient2D } from "../../lib/gradient";
import { useStore } from "../../store";
import { stopsOf } from "../../lib/gradient";

/** The move of a gradient or density-ramp drag. */
export function moveGradient(c: CanvasCtx, d: Extract<Drag, { kind: "gradvec" | "gradend" | "gradnode" | "gradspread" | "gradstop" | "rampend" | "rampvec" }>, p: Vec2, e: RPointerEvent) {
  const { draw, iRef, overlayRef } = c;
  switch (d.kind) {
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
  }
}

/** The release of a gradient or density-ramp drag. */
export function upGradient(c: CanvasCtx, s: StoreState, d: Extract<Drag, { kind: "gradvec" | "gradend" | "gradstop" | "gradnode" | "gradspread" | "rampend" | "rampvec" }>, e: RPointerEvent) {
  const { draw, iRef, overlayRef, pick, toMm } = c;
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
      makeGradient(d.target, draft.a, draft.b); // says why when it can't
    } else s.toast("Select a closed shape, then drag across it");
    draw();
    return;
  }
  if (d.kind === "gradend" || d.kind === "gradstop" || d.kind === "gradnode" || d.kind === "gradspread") {
    iRef.current.tooltip = null;
    draw();
    return;
  }
  if (d.kind === "rampend") {
    iRef.current.tooltip = null;
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
}

/** A press with the gradient tool: which drag it starts. */
export function downGradient(c: CanvasCtx, tool: "gradient", s: StoreState, e: RPointerEvent, p: Vec2, tol: number) {
  const { dragRef, draw, gradient2DDown, pick, rampDown } = c;
  switch (tool) {
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
        makeGradient2D(target.id, p, mode as "mesh" | "freeform");
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
  }
}

/** Gradient annotator hit: an end handle, a stop, or the line itself. */
export const gradientHit = (p: Vec2, tol: number) => {
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
