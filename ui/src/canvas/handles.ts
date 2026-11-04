// On-canvas parameter handles: the interactive replacement for Ink/Stitch's
// parameter dialogs and command symbols. Each handle edits one stitch
// parameter by direct manipulation; the stitch plan regenerates live.

import { flatten, normAngle, objectBoundsCached } from "../lib/geometry";
import type { DesignObject, PlanData, Vec2 } from "../types";
import { FLAG } from "../types";

export type HandleKind = "angle" | "spacing" | "center" | "width-l" | "width-r" | "reverse" | "start" | "end" | "text-arc" | "text-spacing" | "guide" | "ripple";

export interface Handle {
  kind: HandleKind;
  objId: string;
  /** Handle position (mm). */
  p: Vec2;
  /** Pivot the handle relates to (mm), drawn as a guide. */
  anchor?: Vec2;
  /** Unit direction used by the handle (rows, normals, travel direction). */
  dir?: Vec2;
  /** The start/end pin is the engine's automatic choice (not set by the user). */
  auto?: boolean;
  /** Lettering group (text handles). */
  group?: string;
  /** Guide line node and which part of it (anchor or Bézier handle). */
  index?: number;
  part?: "p" | "i" | "o";
  /** The guide line (drawn with its first handle). */
  curve?: Vec2[];
}

const unit = (v: Vec2): Vec2 => {
  const l = Math.hypot(v[0], v[1]) || 1;
  return [v[0] / l, v[1] / l];
};

/** Fill rows run along (cos(-a), sin(-a)) in y-down coordinates. */
export const rowDir = (deg: number): Vec2 => [Math.cos((-deg * Math.PI) / 180), Math.sin((-deg * Math.PI) / 180)];

/** Screen distance of the density handle from the dial centre (CSS px). */
const spacingToPx = (s: number) => 34 + s * 110;
const pxToSpacing = (px: number) => (px - 34) / 110;

/** Point and tangent at the middle (by arc length) of a polyline. */
export function midOf(pts: Vec2[]): { p: Vec2; t: Vec2 } {
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (acc + l >= total / 2 && l > 0) {
      const k = (total / 2 - acc) / l;
      return { p: [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k], t: unit([b[0] - a[0], b[1] - a[1]]) };
    }
    acc += l;
  }
  return { p: pts[0] ?? [0, 0], t: [1, 0] };
}

// first / last needle penetration of every object, cached per plan
const endsCache = new WeakMap<PlanData, Map<number, [Vec2, Vec2]>>();
export function stitchEnds(plan: PlanData, index: number): [Vec2, Vec2] | null {
  let m = endsCache.get(plan);
  if (!m) {
    m = new Map();
    const { coords, flags, objects } = plan;
    for (let i = 0; i < flags.length; i++) {
      if (flags[i] & FLAG.COMMANDS || flags[i] & FLAG.TIE) continue;
      const o = objects[i];
      const p: Vec2 = [coords[2 * i], coords[2 * i + 1]];
      const e = m.get(o);
      if (e) e[1] = p;
      else m.set(o, [p, p]);
    }
    endsCache.set(plan, m);
  }
  return m.get(index) ?? null;
}

/** Handles for one selected object. `scale` = CSS px per mm. */
export function computeHandles(o: DesignObject, index: number, plan: PlanData | null, scale: number): Handle[] {
  if (o.locked || !o.visible) return [];
  const out: Handle[] = [];
  const st = o.stitch;
  const b = objectBoundsCached(o);
  if (!b) return out;
  const c: Vec2 = [b.x + b.w / 2, b.y + b.h / 2];
  if (st.type === "fill") {
    if (st.method === "radial" || st.method === "circular") {
      out.push({ kind: "center", objId: o.id, p: [b.x + b.w * st.center[0], b.y + b.h * st.center[1]] });
    }
    // guided fill: the guide line, its anchors and Bézier handles
    if (st.method === "guided" && st.guide && st.guide.nodes.length >= 2) {
      const curve = flatten(st.guide, 24);
      st.guide.nodes.forEach((n, k) => {
        out.push({ kind: "guide", objId: o.id, p: n.p, index: k, part: "p", curve: k === 0 ? curve : undefined });
        if (n.i) out.push({ kind: "guide", objId: o.id, p: n.i, index: k, part: "i", anchor: n.p });
        if (n.o) out.push({ kind: "guide", objId: o.id, p: n.o, index: k, part: "o", anchor: n.p });
      });
    }
    if (st.method === "tatami" || st.method === "contour" || st.method === "spiral" || st.method === "radial") {
      const R = 30 / scale;
      if (st.method === "tatami") {
        const d = rowDir(st.angle);
        out.push({ kind: "angle", objId: o.id, p: [c[0] + d[0] * R, c[1] + d[1] * R], anchor: c, dir: d });
      }
      const n: Vec2 = st.method === "tatami" ? [-rowDir(st.angle)[1], rowDir(st.angle)[0]] : [0, 1];
      const L = spacingToPx(st.rowSpacing) / scale;
      out.push({ kind: "spacing", objId: o.id, p: [c[0] + n[0] * L, c[1] + n[1] * L], anchor: c, dir: n });
    }
  } else if (st.type === "satin" && o.paths.length === 1) {
    const pts = flatten(o.paths[0], 16);
    if (pts.length >= 2) {
      const { p, t } = midOf(pts);
      const n: Vec2 = [-t[1], t[0]];
      const half = Math.max(st.width / 2, 6 / scale);
      out.push({ kind: "width-l", objId: o.id, p: [p[0] - n[0] * half, p[1] - n[1] * half], anchor: p, dir: n });
      out.push({ kind: "width-r", objId: o.id, p: [p[0] + n[0] * half, p[1] + n[1] * half], anchor: p, dir: n });
    }
  }
  // stitch patterns drawn over the object
  for (const pat of o.patterns ?? []) for (const sp of pat.paths) {
    const curve = flatten(sp, 16);
    if (sp.closed && curve.length) curve.push(curve[0]);
    if (curve.length >= 2) out.push({ kind: "guide", objId: o.id, p: curve[0], curve });
  }
  // ripple stitch: the centre the ripples shrink towards, and its guide
  if (st.type === "running" && st.ripple) {
    const g = st.ripple.guide ?? [];
    if (g.length === 1 && g[0].nodes.length >= 2) {
      const curve = flatten(g[0], 24);
      g[0].nodes.forEach((n, k) => {
        out.push({ kind: "guide", objId: o.id, p: n.p, index: k, part: "p", curve: k === 0 ? curve : undefined });
        if (n.i) out.push({ kind: "guide", objId: o.id, p: n.i, index: k, part: "i", anchor: n.p });
        if (n.o) out.push({ kind: "guide", objId: o.id, p: n.o, index: k, part: "o", anchor: n.p });
      });
    } else if (g.length >= 2) {
      // a satin guide: its rails drawn (replace it from the Properties panel)
      g.forEach((sp) => {
        const curve = flatten(sp, 24);
        if (curve.length >= 2) out.push({ kind: "guide", objId: o.id, p: curve[0], curve });
      });
    }
    if (!g.length || o.paths.some((sp) => sp.closed) || st.ripple.fan) out.push({ kind: "ripple", objId: o.id, p: st.ripple.target ?? c });
  }
  // sewing direction toggle for paths
  if ((st.type === "satin" && o.paths.length === 1) || st.type === "running") {
    const pts = flatten(o.paths[0], 16);
    if (pts.length >= 2) {
      const { p, t } = midOf(pts);
      const n: Vec2 = [-t[1], t[0]];
      const off = (st.type === "satin" ? st.width / 2 : 0) + 16 / scale;
      // arrow points the way the stitches currently travel
      const ends = plan ? stitchEnds(plan, index) : null;
      let dir = t;
      if (ends) {
        const along = (ends[1][0] - ends[0][0]) * t[0] + (ends[1][1] - ends[0][1]) * t[1];
        if (along < 0) dir = [-t[0], -t[1]];
      }
      out.push({ kind: "reverse", objId: o.id, p: [p[0] + n[0] * off, p[1] + n[1] * off], dir });
    }
  }
  // start / end pins: user-set, or where the engine currently starts/ends
  const ends = plan ? stitchEnds(plan, index) : null;
  if (st.type !== "none" && st.type !== "manual") {
    const s = o.start ?? ends?.[0];
    const e = o.end ?? ends?.[1];
    if (s) out.push({ kind: "start", objId: o.id, p: s, auto: !o.start });
    if (e) out.push({ kind: "end", objId: o.id, p: e, auto: !o.end });
  }
  return out;
}

export interface DragResult {
  object: DesignObject;
  label: string;
}

/** Apply dragging handle `h` to position `p` (mm). */
export function dragHandle(o: DesignObject, h: Handle, p: Vec2, scale: number, snap: boolean): DragResult {
  const st = o.stitch;
  const r2 = (v: number, k = 100) => Math.round(v * k) / k;
  switch (h.kind) {
    case "angle": {
      if (st.type !== "fill") break;
      const a = h.anchor!;
      let deg = (-Math.atan2(p[1] - a[1], p[0] - a[0]) * 180) / Math.PI;
      deg = snap ? Math.round(deg / 15) * 15 : Math.round(deg);
      const angle = normAngle(deg);
      return { object: { ...o, stitch: { ...st, angle } }, label: `Angle ${angle}°` };
    }
    case "spacing": {
      if (st.type !== "fill") break;
      const a = h.anchor!;
      const d = h.dir!;
      const px = ((p[0] - a[0]) * d[0] + (p[1] - a[1]) * d[1]) * scale;
      const max = st.method === "stipple" || st.method === "hilbert" ? 4 : 2;
      let s = Math.min(max, Math.max(0.1, pxToSpacing(px)));
      s = snap ? Math.round(s * 20) / 20 : r2(s);
      return { object: { ...o, stitch: { ...st, rowSpacing: s } }, label: `Spacing ${s.toFixed(2)} mm` };
    }
    case "center": {
      if (st.type !== "fill") break;
      const b = objectBoundsCached(o)!;
      const cx = Math.min(1, Math.max(0, (p[0] - b.x) / (b.w || 1)));
      const cy = Math.min(1, Math.max(0, (p[1] - b.y) / (b.h || 1)));
      return { object: { ...o, stitch: { ...st, center: [r2(cx), r2(cy)] } }, label: `Centre ${Math.round(cx * 100)}% · ${Math.round(cy * 100)}%` };
    }
    case "width-l":
    case "width-r": {
      if (st.type !== "satin") break;
      const a = h.anchor!;
      const d = h.dir!;
      let w = 2 * Math.abs((p[0] - a[0]) * d[0] + (p[1] - a[1]) * d[1]);
      w = Math.min(15, Math.max(0.3, w));
      w = snap ? Math.round(w * 2) / 2 : r2(w, 20);
      return { object: { ...o, stitch: { ...st, width: w } }, label: `Width ${w.toFixed(2)} mm` };
    }
    case "guide": {
      const line = st.type === "fill" ? st.guide : st.type === "running" && st.ripple?.guide?.length === 1 ? st.ripple.guide[0] : undefined;
      if (!line || h.index == null) break;
      const nodes = line.nodes.map((n) => ({ ...n }));
      const n = nodes[h.index];
      const q: Vec2 = [r2(p[0]), r2(p[1])];
      if (h.part === "p") {
        const dx = q[0] - n.p[0];
        const dy = q[1] - n.p[1];
        n.p = q;
        if (n.i) n.i = [n.i[0] + dx, n.i[1] + dy];
        if (n.o) n.o = [n.o[0] + dx, n.o[1] + dy];
      } else if (h.part) {
        n[h.part] = q;
        // keep the node smooth: the opposite handle mirrors the direction
        const other = h.part === "i" ? "o" : "i";
        const o2 = n[other];
        if (o2 && !snap) {
          const len = Math.hypot(o2[0] - n.p[0], o2[1] - n.p[1]);
          const d = [n.p[0] - q[0], n.p[1] - q[1]];
          const l = Math.hypot(d[0], d[1]) || 1;
          n[other] = [n.p[0] + (d[0] / l) * len, n.p[1] + (d[1] / l) * len];
        }
      }
      const label = "Guide line" + (h.part !== "p" ? " · Shift: break the curve" : "");
      if (st.type === "running" && st.ripple) return { object: { ...o, stitch: { ...st, ripple: { ...st.ripple, guide: [{ ...line, nodes }] } } }, label };
      if (st.type === "fill") return { object: { ...o, stitch: { ...st, guide: { ...line, nodes } } }, label };
      break;
    }
    case "ripple": {
      if (st.type !== "running" || !st.ripple) break;
      return { object: { ...o, stitch: { ...st, ripple: { ...st.ripple, target: [r2(p[0]), r2(p[1])] } } }, label: "Ripple centre" };
    }
    case "start":
      return { object: { ...o, start: [r2(p[0]), r2(p[1])] }, label: "Start point" };
    case "end":
      return { object: { ...o, end: [r2(p[0]), r2(p[1])] }, label: "End point" };
    case "reverse":
      break;
  }
  return { object: o, label: "" };
  void scale;
}

/** Click on the direction arrow: sew the other way round. */
export function reverseObject(o: DesignObject, h: Handle): DesignObject {
  if (o.start || o.end) return { ...o, start: o.end, end: o.start };
  // no explicit points: start from the end the arrow points to
  const pts = flatten(o.paths[0], 16);
  if (pts.length < 2) return o;
  const first = pts[0];
  const last = pts[pts.length - 1];
  const d = h.dir ?? [1, 0];
  const t = unit([last[0] - first[0], last[1] - first[1]]);
  const forward = d[0] * t[0] + d[1] * t[1] >= 0;
  return { ...o, start: forward ? last : first };
}

export const HANDLE_HIT_PX = 8;

/** Handles of a selected lettering: arc (bend) above, letter spacing on the right. */
export function computeTextHandles(objs: DesignObject[], rotation: number, scale: number): Handle[] {
  const live = objs.filter((o) => o.visible && !o.locked);
  if (!live.length) return [];
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const o of live) {
    const b = objectBoundsCached(o);
    if (!b) continue;
    x0 = Math.min(x0, b.x);
    y0 = Math.min(y0, b.y);
    x1 = Math.max(x1, b.x + b.w);
    y1 = Math.max(y1, b.y + b.h);
  }
  if (!isFinite(x0)) return [];
  const c: Vec2 = [(x0 + x1) / 2, (y0 + y1) / 2];
  const rad = (rotation * Math.PI) / 180;
  const right: Vec2 = [Math.cos(rad), Math.sin(rad)];
  const up: Vec2 = [Math.sin(rad), -Math.cos(rad)];
  const hw = (x1 - x0) / 2;
  const hh = (y1 - y0) / 2;
  const ext = (d: Vec2) => Math.abs(d[0]) * hw + Math.abs(d[1]) * hh;
  const id = live[0].id;
  const group = live[0].text?.group;
  const ua = ext(up) + 26 / scale;
  const ra = ext(right) + 26 / scale;
  return [
    { kind: "text-arc", objId: id, group, p: [c[0] + up[0] * ua, c[1] + up[1] * ua], anchor: c, dir: up },
    { kind: "text-spacing", objId: id, group, p: [c[0] + right[0] * ra, c[1] + right[1] * ra], anchor: c, dir: right },
  ];
}
