// Moving, scaling, rotating and skewing the selection, and moving its pivot:
// what a drag does on the canvas.

import { dist, objectBoundsCached, rotateAbout, scaleAbout, transformObject, translateMat, unionBoxes } from "../../lib/geometry";
import { useStore } from "../../store";
import type { Vec2 } from "../../types";
import { handlePoints } from "../render";
import { skewAbout, snapBox, snapTargets } from "../transform";
import { pruneGroups } from "../../lib/layerRows";
import { transformBox } from "../hit";
import type { PointerEvent as RPointerEvent } from "react";
import type { CanvasCtx, Drag, StoreState } from "../ctx";
import { linkMenu } from "../../components/linkMenu";
import { connectionAt } from "../../lib/links";
import { objectBounds } from "../../lib/geometry";
import { referenceAt } from "../../lib/references";
import { rotateHandle } from "../render";
import { handleAt, reverseObject } from "../handles";
import { modernSpacing, textSpec, updateText } from "../../lib/textOps";
import { rotateZone, unitIds } from "../transform";
import { computeIssues } from "../../lib/issues";
import { issuesShown } from "../../lib/panelActions";
import { transformable } from "../../lib/textSettle";
import { loadFont } from "../../lib/fonts";
import { mapObjects } from "../../lib/docEdit";

/** The move of a selection transform (move, scale, rotate, skew, pivot) drag. */
export function moveTransform(c: CanvasCtx, s: StoreState, d: Extract<Drag, { kind: "move" | "scale" | "rotate" | "skew" | "pivot" }>, p: Vec2, e: RPointerEvent) {
  const { cloneObjects, draw, iRef, pivotRef, xform } = c;
  switch (d.kind) {
    case "move": {
      let dx = p[0] - d.start[0];
      let dy = p[1] - d.start[1];
      if (e.shiftKey) Math.abs(dx) > Math.abs(dy) ? (dy = 0) : (dx = 0);
      if (!d.moved && Math.hypot(dx, dy) * s.view.scale < 3) return;
      if (!d.moved) {
        s.checkpoint();
        if (e.altKey) {
          // Alt-drag: move a copy, leave the original
          const { objects: copies, parents, names } = cloneObjects(d.all);
          s.liveUpdate((doc) =>
            pruneGroups({
              ...doc,
              objects: [...doc.objects, ...copies],
              ...(Object.keys(parents).length ? { groupParents: { ...doc.groupParents, ...parents } } : {}),
              ...(Object.keys(names).length ? { groupNames: { ...doc.groupNames, ...names } } : {}),
            }),
          );
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
      // a flat box (a straight horizontal or vertical line) keeps that axis
      const flatX = Math.abs(hp[0] - ax) < 1e-6;
      const flatY = Math.abs(hp[1] - ay) < 1e-6;
      let sx = d.handle === 1 || d.handle === 5 || flatX ? 1 : (q[0] - ax) / (hp[0] - ax);
      let sy = d.handle === 3 || d.handle === 7 || flatY ? 1 : (q[1] - ay) / (hp[1] - ay);
      if ((e.shiftKey || d.uniform) && flatX !== flatY) {
        // uniform on a flat box: the other axis sets the factor
        const k = flatX ? sy : sx;
        sx = flatX ? Math.abs(k) : k;
        sy = flatY ? Math.abs(k) : k;
      } else if (e.shiftKey || d.uniform) {
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
      const sb = transformBox(s.doc, s.selection);
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
  }
}

/** The release of a selection transform (move, scale, rotate, skew, pivot) drag. */
export function upTransform(c: CanvasCtx, d: Extract<Drag, { kind: "move" | "scale" | "rotate" | "skew" | "pivot" }>) {
  const { draw, iRef, pivotRef, selKey } = c;
    iRef.current.guides = null;
    iRef.current.tooltip = null;
    if (d.kind !== "pivot" && d.kind !== "move") pivotRef.current = pivotRef.current?.key === selKey() ? pivotRef.current : null;
    draw();
}

/** A press with the selection tool: which drag it starts. */
export function downSelect(c: CanvasCtx, tool: "select", s: StoreState, e: RPointerEvent, p: Vec2, tol: number) {
  const { dragRef, draw, handlesRef, iRef, pick, pivotOf, pivotRef, selKey, setCtxMenu } = c;
  switch (tool) {
    case "select": {
      // parameter handles (reverse order: pins are drawn on top)
      const hh = handleAt(handlesRef.current, p, s.view.scale);
      if (hh?.group) {
        const spec = textSpec(hh.group);
        if (!spec) return;
        if (e.detail === 2) {
          updateText(hh.group, hh.kind === "text-arc" ? { arc: 0 } : { letterSpacing: 0 });
          return;
        }
        s.checkpoint();
        const drag = { kind: "texthandle" as const, h: hh, group: hh.group, spec, start: p, moved: false, spacingScale: 1 };
        dragRef.current = drag;
        // embroidery fonts: spacing is at the font's own size, so the handle follows the pointer at the text's scale
        void loadFont(spec.font).then((f) => {
          if (f.kind === "embroidery" && f.size > 0) drag.spacingScale = spec.size / f.size;
        });
        // an older design's spacing (mm): the drag starts from it in today's terms
        if (spec.legacySpacing) void modernSpacing(spec).then((m) => (drag.spec = m));
        iRef.current.activeHandle = hh;
        return;
      }
      if (hh) {
        const o = s.doc.objects.find((x) => x.id === hh.objId)!;
        if (hh.kind === "reverse") {
          s.commit((d) => mapObjects(d, o.id, (x) => reverseObject(x, hh)));
          return;
        }
        if ((hh.kind === "start" || hh.kind === "end") && e.detail === 2) {
          s.commit((d) => mapObjects(d, o.id, (x) => ({ ...x, [hh.kind]: undefined })));
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
      const sel = transformable(s.doc.objects.filter((o) => s.selection.includes(o.id)), s.doc.objects).objects;
      const box = unionBoxes(sel.map(objectBounds));
      if (box && sel.length && sel.every((o) => !o.locked)) {
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
      // with the jumps shown, a click right on the line between two objects: Trim / Jump / Sew (Shift: select as usual)
      const conn = s.showJumps && !e.shiftKey ? connectionAt(s.plan, p, 4 / s.view.scale) : undefined;
      const from = conn && s.doc.objects[conn.from];
      if (from) {
        iRef.current.connHover = null;
        iRef.current.tooltip = null;
        // after this pointer event: the menu's outside-click listener would close it at once
        const at = { x: e.clientX, y: e.clientY };
        setTimeout(() => setCtxMenu({ ...at, onObject: false, items: linkMenu(from.id) }), 0);
        draw();
        return;
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
          // locked objects stay put; an Alt-drag copy takes them along
          // a lettering with locked letters stays in place with them
          orig: (() => {
            const t = transformable(s.doc.objects.filter((o) => ids.includes(o.id)), s.doc.objects);
            if (t.held) s.toast("A lettering with locked letters stays in place: unlock it in Layers to move it");
            return t.objects;
          })(),
          all: s.doc.objects.filter((o) => ids.includes(o.id)),
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
  }
}
