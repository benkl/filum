import type {
  AppliqueParams,
  DesignOptions,
  DesignObject,
  FillParams,
  PathNode,
  RunningParams,
  SatinParams,
  StitchParams,
  SubPath,
  Vec2,
  FlowField,
} from "../types";

export const uid = (p = "o") => `${p}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export const defaultRunning = (): RunningParams => ({ length: 2.5, tolerance: 0.2, repeats: 1, beanRepeats: 0 });

/** Per-fabric starting numbers for new objects (fabric calibration); set once by the app. */
let fabricDefaults: () => { satin?: Partial<SatinParams>; fill?: Partial<FillParams> } = () => ({});
export const setFabricDefaults = (f: typeof fabricDefaults) => {
  fabricDefaults = f;
};

export const defaultSatin = (): SatinParams => ({ ...baseSatin(), ...fabricDefaults().satin });
const baseSatin = (): SatinParams => ({
  method: "satin",
  spacing: 0.4,
  width: 3,
  pullComp: 0.2,
  pullCompPct: 0,
  maxStitchLength: 0,
  shortStitchInset: 0.15,
  centerWalk: true,
  contourUnderlay: false,
  contourInset: 0.4,
  zigzagUnderlay: false,
  zigzagUnderlaySpacing: 3,
  zigzagUnderlayInset: 0.6,
  underlayAuto: true,
  swapRails: false,
  reverse: false,
});

export const defaultFill = (): FillParams => ({ ...baseFill(), ...fabricDefaults().fill });
const baseFill = (): FillParams => ({
  method: "tatami",
  angle: 0,
  rowSpacing: 0.25,
  endRowSpacing: 0,
  maxStitchLength: 3,
  staggers: 4,
  pullComp: 0,
  underlay: true,
  underlayAngle: 90,
  underlaySpacing: 0.75,
  underlayInset: 0.3,
  underlayStitchLength: 3,
  underlayAuto: true,
  travelLength: 2.5,
  center: [0.5, 0.5],
});

export const defaultApplique = (): AppliqueParams => ({
  placement: true,
  placementLength: 2,
  tackdown: "zigzag",
  tackdownWidth: 1.6,
  tackdownInset: 0.6,
  tackdownSpacing: 1.2,
  cover: "satin",
  coverWidth: 3,
  coverSpacing: 0.4,
  coverOffset: 0,
  coverUnderlay: true,
  pullComp: 0.2,
  flip: false,
  stops: true,
});

export const defaultDesignOptions = (): DesignOptions => ({
  removeOverlaps: false,
  overlapMargin: 0.6,
  basting: "none",
  bastingMargin: 6,
  bastingLength: 5,
  threadWeight: 40,
  knockdown: false,
  knockdownOffset: 2,
  knockdownSpacing: 2,
  knockdownLength: 4,
  knockdownLayers: 2,
  knockdownAngle: 45,
  knockdownColor: "",
  knockdownHoles: false,
});

export function defaultStitch(type: StitchParams["type"], prev?: StitchParams): StitchParams {
  switch (type) {
    case "running":
      return { type, ...defaultRunning() };
    case "satin":
      return { type, ...defaultSatin(), ...(prev?.type === "running" ? {} : {}) };
    case "fill":
      return { type, ...defaultFill() };
    case "applique":
      return { type, ...defaultApplique() };
    default:
      return { type } as StitchParams;
  }
}

/** Sensible spacing default when switching fill methods. */
export function fillMethodDefaults(method: FillParams["method"]): Partial<FillParams> {
  switch (method) {
    case "meander":
      return { method, maxStitchLength: 2.5, underlay: false, meanderScale: 2.5, smoothness: 0.5 };
    case "guided":
      return { method, rowSpacing: 0.25, maxStitchLength: 3 };
    case "circular":
      return { method, rowSpacing: 0.35, maxStitchLength: 2.5, center: [0.5, 0.5] };
    case "flow":
      return { method, rowSpacing: 0.3, maxStitchLength: 2.5 };
    case "curved":
      return { method, rowSpacing: 0.35, maxStitchLength: 2.5, curve: 1 };
    case "cross":
      return { method, crossSize: 2.5, crossCoverage: 0.5, crossKind: "cross", underlay: false };
    case "tartan":
      return { method, rowSpacing: 0.35, maxStitchLength: 3 };
    case "tatami":
      return { method, rowSpacing: 0.25, maxStitchLength: 3 };
    case "contour":
    case "spiral":
      return { method, rowSpacing: 0.35, maxStitchLength: 2.5 };
    case "radial":
      return { method, rowSpacing: 0.3, maxStitchLength: 4, underlay: true };
    case "hilbert":
      return { method, rowSpacing: 1.2, maxStitchLength: 2.5, underlay: false };
    case "stipple":
      return { method, rowSpacing: 1.5, maxStitchLength: 2.5, underlay: false };
  }
}

// ---------------------------------------------------------------------------

export function addSubpathToPath(path: Path2D, sp: SubPath) {
  const n = sp.nodes.length;
  if (n === 0) return;
  path.moveTo(sp.nodes[0].p[0], sp.nodes[0].p[1]);
  const segs = sp.closed ? n : n - 1;
  for (let s = 0; s < segs; s++) {
    const a = sp.nodes[s];
    const b = sp.nodes[(s + 1) % n];
    if (!a.o && !b.i) path.lineTo(b.p[0], b.p[1]);
    else {
      const c1 = a.o ?? a.p;
      const c2 = b.i ?? b.p;
      path.bezierCurveTo(c1[0], c1[1], c2[0], c2[1], b.p[0], b.p[1]);
    }
  }
  if (sp.closed) path.closePath();
}

export function pathsToPath2D(paths: SubPath[]): Path2D {
  const p = new Path2D();
  for (const sp of paths) addSubpathToPath(p, sp);
  return p;
}

function cubicPoint(a: Vec2, c1: Vec2, c2: Vec2, b: Vec2, t: number): Vec2 {
  const u = 1 - t;
  return [
    u * u * u * a[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * b[0],
    u * u * u * a[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * b[1],
  ];
}

export function flatten(sp: SubPath, steps = 12): Vec2[] {
  const n = sp.nodes.length;
  const out: Vec2[] = [];
  if (!n) return out;
  out.push(sp.nodes[0].p);
  const segs = sp.closed ? n : n - 1;
  for (let s = 0; s < segs; s++) {
    const a = sp.nodes[s];
    const b = sp.nodes[(s + 1) % n];
    if (!a.o && !b.i) out.push(b.p);
    else for (let k = 1; k <= steps; k++) out.push(cubicPoint(a.p, a.o ?? a.p, b.i ?? b.p, b.p, k / steps));
  }
  return out;
}

/** Whether two polylines cross or touch. */
function polylinesMeet(a: Vec2[], b: Vec2[]): boolean {
  const cross = (o: Vec2, p: Vec2, q: Vec2) => (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0]);
  const eps = 1e-9;
  for (let i = 1; i < a.length; i++)
    for (let j = 1; j < b.length; j++) {
      const [p1, p2, q1, q2] = [a[i - 1], a[i], b[j - 1], b[j]];
      const d1 = cross(q1, q2, p1);
      const d2 = cross(q1, q2, p2);
      const d3 = cross(p1, p2, q1);
      const d4 = cross(p1, p2, q2);
      if (((d1 > eps && d2 < -eps) || (d1 < -eps && d2 > eps)) && ((d3 > eps && d4 < -eps) || (d3 < -eps && d4 > eps))) return true;
      // an end touching the other segment
      const on = (o: Vec2, p: Vec2, q: Vec2, d: number) => Math.abs(d) <= eps * Math.max(1, Math.hypot(p[0] - o[0], p[1] - o[1])) && Math.min(o[0], p[0]) - eps <= q[0] && q[0] <= Math.max(o[0], p[0]) + eps && Math.min(o[1], p[1]) - eps <= q[1] && q[1] <= Math.max(o[1], p[1]) + eps;
      if (on(q1, q2, p1, d1) || on(q1, q2, p2, d2) || on(p1, p2, q1, d3) || on(p1, p2, q2, d4)) return true;
    }
  return false;
}

/**
 * Which two sub-paths of a satin are its rails (indices into `paths`, in
 * path order), as the engine picks them (stitches/satin.rs rail_indices,
 * Ink/Stitch SatinColumn.rail_indices): a rung crosses exactly two other
 * paths, so with three paths the rails are the two crossing exactly one
 * (a rung may be longer than short rails), with more the two crossing more
 * than two; otherwise the two longest. Null with fewer than two sub-paths.
 */
export function satinRailIndices(paths: SubPath[]): [number, number] | null {
  const idx = paths.map((_, i) => i).filter((i) => paths[i].nodes.length >= 2);
  if (idx.length < 2) return null;
  if (idx.length === 2) return [idx[0], idx[1]];
  const flat = idx.map((i) => flatten(paths[i], 12));
  const len = flat.map((f) => f.slice(1).reduce((l, p, k) => l + dist(p, f[k]), 0));
  const n = flat.length;
  const counts = flat.map((f, i) => flat.filter((g, j) => j !== i && polylinesMeet(f, g)).length);
  const minLen = (0.1 * 25.4) / 96;
  const possible = counts.map((_, i) => i).filter((i) => len[i] > minLen && (n === 3 ? counts[i] === 1 : counts[i] > 2));
  if (possible.length === 2) return [idx[possible[0]], idx[possible[1]]];
  const byLen = flat.map((_, i) => i).sort((a, b) => len[b] - len[a]);
  const [a, b] = [idx[byLen[0]], idx[byLen[1]]];
  return [Math.min(a, b), Math.max(a, b)];
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function boundsOfPoints(pts: Vec2[]): Box | null {
  if (!pts.length) return null;
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, y] of pts) {
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export function objectBounds(o: DesignObject): Box | null {
  const pts = o.paths.flatMap((p) => flatten(p, 8));
  const b = boundsOfPoints(pts);
  if (b && o.stitch.type === "satin" && (o.paths.length === 1 || o.stitch.multi)) {
    const w = o.stitch.width / 2;
    return { x: b.x - w, y: b.y - w, w: b.w + 2 * w, h: b.h + 2 * w };
  }
  if (b && o.stitch.type === "running" && o.stitch.zigzag) {
    const w = o.stitch.zigzag.width / 2 + Math.max(0, o.stitch.zigzag.pullComp);
    return { x: b.x - w, y: b.y - w, w: b.w + 2 * w, h: b.h + 2 * w };
  }
  if (b && o.stitch.type === "applique" && o.stitch.cover !== "none") {
    const w = o.stitch.coverWidth / 2 + Math.max(0, o.stitch.coverOffset);
    return { x: b.x - w, y: b.y - w, w: b.w + 2 * w, h: b.h + 2 * w };
  }
  return b;
}

export function unionBoxes(boxes: (Box | null)[]): Box | null {
  const v = boxes.filter(Boolean) as Box[];
  if (!v.length) return null;
  const x0 = Math.min(...v.map((b) => b.x));
  const y0 = Math.min(...v.map((b) => b.y));
  const x1 = Math.max(...v.map((b) => b.x + b.w));
  const y1 = Math.max(...v.map((b) => b.y + b.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export type Mat = [number, number, number, number, number, number]; // a b c d e f

/** a ∘ b: first b, then a. */
export const mulMat = (a: Mat, b: Mat): Mat => [
  a[0] * b[0] + a[2] * b[1],
  a[1] * b[0] + a[3] * b[1],
  a[0] * b[2] + a[2] * b[3],
  a[1] * b[2] + a[3] * b[3],
  a[0] * b[4] + a[2] * b[5] + a[4],
  a[1] * b[4] + a[3] * b[5] + a[5],
];

export const applyMat = (m: Mat, p: Vec2): Vec2 => [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]];

export function translateMat(dx: number, dy: number): Mat {
  return [1, 0, 0, 1, dx, dy];
}

export function scaleAbout(sx: number, sy: number, cx: number, cy: number): Mat {
  return [sx, 0, 0, sy, cx - sx * cx, cy - sy * cy];
}

export function rotateAbout(deg: number, cx: number, cy: number): Mat {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return [c, s, -s, c, cx - c * cx + s * cy, cy - s * cx - c * cy];
}

export function transformPaths(paths: SubPath[], m: Mat): SubPath[] {
  const f = (n: PathNode): PathNode => ({
    p: applyMat(m, n.p),
    ...(n.i ? { i: applyMat(m, n.i) } : {}),
    ...(n.o ? { o: applyMat(m, n.o) } : {}),
  });
  return paths.map((sp) => ({ closed: sp.closed, nodes: sp.nodes.map(f) }));
}

/** Apply an affine transform. `rotationDeg` is the rotation contained in `m`
 * (same sign as rotateAbout) so fill angles and lettering follow the shape. */
export function transformObject(o: DesignObject, m: Mat, rotationDeg = 0): DesignObject {
  let stitch = o.stitch;
  const scale = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
  if (stitch.type === "fill" && rotationDeg) stitch = { ...stitch, angle: normAngle(stitch.angle - rotationDeg) };
  if (stitch.type === "fill" && stitch.gradient)
    stitch = {
      ...stitch,
      gradient: {
        ...stitch.gradient,
        from: applyMat(m, stitch.gradient.from),
        to: applyMat(m, stitch.gradient.to),
        // mesh nodes and freeform points travel with the shape
        ...(stitch.gradient.mesh ? { mesh: { ...stitch.gradient.mesh, nodes: stitch.gradient.mesh.nodes.map((n) => ({ ...n, p: applyMat(m, n.p) })) } } : {}),
        ...(stitch.gradient.points ? { points: stitch.gradient.points.map((q) => ({ ...q, p: applyMat(m, q.p), spread: Math.max(0.5, q.spread * scale) })) } : {}),
      },
    };
  if (stitch.type === "fill" && stitch.guide) stitch = { ...stitch, guide: transformPaths([stitch.guide], m)[0] };
  if (stitch.type === "fill" && stitch.flow) stitch = { ...stitch, flow: transformFlow(stitch.flow, m) };
  if (stitch.type === "running" && stitch.ripple?.target) stitch = { ...stitch, ripple: { ...stitch.ripple, target: applyMat(m, stitch.ripple.target) } };
  if (stitch.type === "running" && stitch.ripple?.guide?.length) stitch = { ...stitch, ripple: { ...stitch.ripple, guide: transformPaths(stitch.ripple.guide, m) } };
  if (stitch.type === "running" && stitch.ripple?.anchor)
    stitch = { ...stitch, ripple: { ...stitch.ripple, anchor: [applyMat(m, stitch.ripple.anchor[0]), applyMat(m, stitch.ripple.anchor[1])] } };
  if (stitch.type === "satin" && (o.paths.length === 1 || stitch.multi) && Math.abs(scale - 1) > 1e-6)
    stitch = { ...stitch, width: Math.max(0.3, +(stitch.width * scale).toFixed(2)) };
  const out: DesignObject = { ...o, paths: transformPaths(o.paths, m), stitch };
  if (o.patterns?.length) out.patterns = o.patterns.map((p) => ({ ...p, paths: transformPaths(p.paths, m) }));
  // a linked clone keeps following its original, through the new transform
  if (o.clone) out.clone = { ...o.clone, m: mulMat(m, o.clone.m), rot: o.clone.rot + rotationDeg };
  if (o.text) {
    // keep the lettering parametric: its spec follows the transform
    const t = o.text;
    out.text = {
      ...t,
      anchor: applyMat(m, t.anchor),
      size: +(t.size * scale).toFixed(3),
      letterSpacing: t.letterSpacing * scale,
      borderWidth: +(t.borderWidth * scale).toFixed(3),
      rotation: +(t.rotation + rotationDeg).toFixed(3),
    };
  }
  return out;
}

export const normAngle = (a: number) => {
  let v = a % 180;
  if (v > 90) v -= 180;
  if (v <= -90) v += 180;
  return +v.toFixed(1);
};

export const nodeCount = (o: DesignObject) => o.paths.reduce((n, p) => n + p.nodes.length, 0);

// ---------------------------------------------------------------------------
// Shape builders (mm)

export function rectPath(x: number, y: number, w: number, h: number): SubPath {
  return {
    closed: true,
    nodes: [
      { p: [x, y] },
      { p: [x + w, y] },
      { p: [x + w, y + h] },
      { p: [x, y + h] },
    ],
  };
}

export function ellipsePath(cx: number, cy: number, rx: number, ry: number): SubPath {
  const k = 0.5522847498;
  const pts: Vec2[] = [
    [1, 0],
    [0, 1],
    [-1, 0],
    [0, -1],
  ];
  return {
    closed: true,
    nodes: pts.map(([x, y]) => {
      const p: Vec2 = [cx + rx * x, cy + ry * y];
      const t: Vec2 = [-y * rx * k, x * ry * k];
      return { p, i: [p[0] - t[0], p[1] - t[1]], o: [p[0] + t[0], p[1] + t[1]] };
    }),
  };
}

/** Catmull-Rom spline through points → smooth bezier sub-path. */
export function smoothPath(pts: Vec2[], closed = false, tension = 0.5): SubPath {
  const n = pts.length;
  if (n < 3) return { closed, nodes: pts.map((p) => ({ p })) };
  const get = (i: number) => (closed ? pts[(i + n) % n] : pts[Math.max(0, Math.min(n - 1, i))]);
  const nodes: PathNode[] = pts.map((p, i) => {
    const a = get(i - 1);
    const b = get(i + 1);
    const t: Vec2 = [((b[0] - a[0]) * tension) / 3, ((b[1] - a[1]) * tension) / 3];
    const node: PathNode = { p };
    if (closed || i > 0) node.i = [p[0] - t[0], p[1] - t[1]];
    if (closed || i < n - 1) node.o = [p[0] + t[0], p[1] + t[1]];
    return node;
  });
  return { closed, nodes };
}

/** Douglas–Peucker. */
export function simplifyPts(pts: Vec2[], tol: number): Vec2[] {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop()!;
    const [ax, ay] = pts[s];
    const [bx, by] = pts[e];
    const len = Math.hypot(bx - ax, by - ay) || 1e-9;
    let best = -1;
    let bi = -1;
    for (let i = s + 1; i < e; i++) {
      const d = Math.abs((pts[i][0] - ax) * (by - ay) - (pts[i][1] - ay) * (bx - ax)) / len;
      if (d > best) {
        best = d;
        bi = i;
      }
    }
    if (best > tol) {
      keep[bi] = 1;
      stack.push([s, bi], [bi, e]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

export const dist = (a: Vec2, b: Vec2) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** Offset a polyline sideways (for drawing satin centre lines as columns). */
export function offsetPolyline(pts: Vec2[], d: number): Vec2[] {
  const n = pts.length;
  if (n < 2) return pts;
  const unit = (x: number, y: number): Vec2 => {
    const l = Math.hypot(x, y) || 1;
    return [x / l, y / l];
  };
  // directions come from the nearest neighbour that is not (almost) coincident:
  // near-zero segments (curve joins, font contours) have meaningless directions
  const eps = 0.02;
  const far = (i: number, step: 1 | -1): Vec2 | null => {
    const p = pts[i];
    for (let j = i + step; j >= 0 && j < n; j += step) {
      const q = pts[j];
      if (Math.hypot(q[0] - p[0], q[1] - p[1]) > eps) return q;
    }
    return null;
  };
  return pts.map((p, i) => {
    const a = far(i, -1);
    const b = far(i, 1);
    const prev = a ? unit(p[0] - a[0], p[1] - a[1]) : b ? unit(b[0] - p[0], b[1] - p[1]) : ([1, 0] as Vec2);
    const next = b ? unit(b[0] - p[0], b[1] - p[1]) : prev;
    const n0: Vec2 = [-prev[1], prev[0]];
    const n1: Vec2 = [-next[1], next[0]];
    let m = unit(n0[0] + n1[0], n0[1] + n1[1]);
    if (!isFinite(m[0])) m = n0;
    const cos = Math.max(0.25, m[0] * n1[0] + m[1] * n1[1]);
    return [p[0] + (m[0] * d) / cos, p[1] + (m[1] * d) / cos];
  });
}

/** Outline polygon of a satin (for vector preview + hit testing). */
export function satinOutline(o: DesignObject): Path2D | null {
  if (o.stitch.type !== "satin") return null;
  const path = new Path2D();
  if (o.paths.length === 1 || o.stitch.multi) {
    // centre-line column(s): open ones as a band, closed ones as a ring
    for (const sp of o.paths) {
      const c = flatten(sp, 24);
      if (c.length < 2) continue;
      if (sp.closed) {
        for (const d of [-o.stitch.width / 2, o.stitch.width / 2]) {
          const r = offsetPolyline([c[c.length - 1], ...c, c[0]], d).slice(1, -1);
          path.moveTo(r[0][0], r[0][1]);
          for (const p of r.slice(1)) path.lineTo(p[0], p[1]);
          path.closePath();
        }
        continue;
      }
      const a = offsetPolyline(c, -o.stitch.width / 2);
      const b = offsetPolyline(c, o.stitch.width / 2).reverse();
      const ring = a.concat(b);
      path.moveTo(ring[0][0], ring[0][1]);
      for (const p of ring.slice(1)) path.lineTo(p[0], p[1]);
      path.closePath();
    }
    return path;
  }
  const ri = satinRailIndices(o.paths);
  const rails = ri ? [o.paths[ri[0]], o.paths[ri[1]]] : [];
  const [r0, r1] = rails.map((r) => flatten(r, 24));
  if (!r0 || !r1) return null;
  const same = dist(r0[0], r1[0]) + dist(r0[r0.length - 1], r1[r1.length - 1]);
  const rev = dist(r0[0], r1[r1.length - 1]) + dist(r0[r0.length - 1], r1[0]);
  const b = same <= rev ? r1.slice().reverse() : r1.slice();
  const closedRails = rails[0].closed && rails[1].closed;
  if (closedRails) {
    // ring between two closed rails: draw both with even-odd
    for (const r of [r0, r1]) {
      path.moveTo(r[0][0], r[0][1]);
      for (const p of r.slice(1)) path.lineTo(p[0], p[1]);
      path.closePath();
    }
    return path;
  }
  const ring = r0.concat(b);
  path.moveTo(ring[0][0], ring[0][1]);
  for (const p of ring.slice(1)) path.lineTo(p[0], p[1]);
  path.closePath();
  return path;
}

export function shade(hex: string, amt: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const v = parseInt(m[1], 16);
  const ch = (s: number) => {
    const c = (v >> s) & 255;
    const r = amt >= 0 ? c + (255 - c) * amt : c * (1 + amt);
    return Math.max(0, Math.min(255, Math.round(r)));
  };
  return `rgb(${ch(16)},${ch(8)},${ch(0)})`;
}

export function luminance(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return 0.5;
  const v = parseInt(m[1], 16);
  return (0.2126 * ((v >> 16) & 255) + 0.7152 * ((v >> 8) & 255) + 0.0722 * (v & 255)) / 255;
}

// ---------------------------------------------------------------------------
// Per-object caches. Design objects are immutable (every edit creates a new
// object), so derived geometry can be cached by identity.

interface ObjectCache {
  path?: Path2D;
  outline?: Path2D | null;
  bounds?: Box | null;
}
const objectCache = new WeakMap<DesignObject, ObjectCache>();
const cacheOf = (o: DesignObject) => {
  let c = objectCache.get(o);
  if (!c) objectCache.set(o, (c = {}));
  return c;
};

/** Cached Path2D of an object's sub-paths. */
export function objectPath(o: DesignObject): Path2D {
  const c = cacheOf(o);
  return (c.path ??= pathsToPath2D(o.paths));
}

/** Cached satin column outline (null for non-satins). */
export function objectOutline(o: DesignObject): Path2D | null {
  const c = cacheOf(o);
  if (c.outline === undefined) c.outline = satinOutline(o);
  return c.outline;
}

/** Cached bounding box. */
export function objectBoundsCached(o: DesignObject): Box | null {
  const c = cacheOf(o);
  if (c.bounds === undefined) c.bounds = objectBounds(o);
  return c.bounds;
}

/** A default guide line across a box: a gentle S-curve, left to right (mirrors the core). */
export function defaultGuide(b: Box): SubPath {
  const y = b.y + b.h / 2;
  const h = b.h * 0.25;
  return {
    closed: false,
    nodes: [
      { p: [b.x, y], o: [b.x + b.w * 0.33, y - h] },
      { p: [b.x + b.w, y], i: [b.x + b.w * 0.67, y + h] },
    ],
  };
}

/**
 * A flow fill's direction field after an affine transform: resampled on a
 * new axis-aligned grid over the transformed area, with every direction
 * mapped through the transform (doubled-angle interpolation, mod π).
 */
export function transformFlow(f: FlowField, m: Mat): FlowField {
  const [a, b, c, d, e, g] = m;
  const det = a * d - b * c;
  if (Math.abs(det) < 1e-12 || !f.cols || !f.rows) return f;
  // pure translation: just move the grid
  if (Math.abs(a - 1) < 1e-12 && Math.abs(d - 1) < 1e-12 && Math.abs(b) < 1e-12 && Math.abs(c) < 1e-12) {
    return { ...f, origin: [f.origin[0] + e, f.origin[1] + g] };
  }
  const inv = (q: Vec2): Vec2 => {
    const x = q[0] - e;
    const y = q[1] - g;
    return [(d * x - c * y) / det, (-b * x + a * y) / det];
  };
  const sample = (p: Vec2): number => {
    const gx = Math.min(f.cols - 1, Math.max(0, (p[0] - f.origin[0]) / f.cell - 0.5));
    const gy = Math.min(f.rows - 1, Math.max(0, (p[1] - f.origin[1]) / f.cell - 0.5));
    const x0 = Math.floor(gx);
    const y0 = Math.floor(gy);
    const x1 = Math.min(x0 + 1, f.cols - 1);
    const y1 = Math.min(y0 + 1, f.rows - 1);
    const fx = gx - x0;
    const fy = gy - y0;
    let cs = 0;
    let sn = 0;
    for (const [x, y, w] of [
      [x0, y0, (1 - fx) * (1 - fy)],
      [x1, y0, fx * (1 - fy)],
      [x0, y1, (1 - fx) * fy],
      [x1, y1, fx * fy],
    ] as const) {
      const t = f.angles[y * f.cols + x] * 2;
      cs += w * Math.cos(t);
      sn += w * Math.sin(t);
    }
    return 0.5 * Math.atan2(sn, cs);
  };
  // the transformed grid's bounding box
  const W = f.cols * f.cell;
  const H = f.rows * f.cell;
  const corners: Vec2[] = [f.origin, [f.origin[0] + W, f.origin[1]], [f.origin[0], f.origin[1] + H], [f.origin[0] + W, f.origin[1] + H]].map((p) => applyMat(m, p as Vec2));
  const xs = corners.map((p) => p[0]);
  const ys = corners.map((p) => p[1]);
  const x0 = Math.min(...xs);
  const y0 = Math.min(...ys);
  const scale = Math.sqrt(Math.abs(det));
  const cell = f.cell * scale;
  const cols = Math.max(1, Math.ceil((Math.max(...xs) - x0) / cell));
  const rows = Math.max(1, Math.ceil((Math.max(...ys) - y0) / cell));
  const angles: number[] = [];
  for (let r = 0; r < rows; r++)
    for (let k = 0; k < cols; k++) {
      const q: Vec2 = [x0 + (k + 0.5) * cell, y0 + (r + 0.5) * cell];
      const t = sample(inv(q));
      // direction through the linear part
      const vx = a * Math.cos(t) + c * Math.sin(t);
      const vy = b * Math.cos(t) + d * Math.sin(t);
      angles.push(Math.atan2(vy, vx));
    }
  return { origin: [x0, y0], cell, cols, rows, angles };
}
