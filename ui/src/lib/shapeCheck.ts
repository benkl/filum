// Shape checks (Ink/Stitch "Troubleshoot": fill and satin validation) and
// cleanup of tiny objects (Ink/Stitch "Cleanup document"). Shared: the Issues
// panel, the cleanup action and the export checks use them.

import type { DesignObject, StitchDocument, SubPath, Vec2 } from "../types";
import { flattenSubPath } from "./bezier";
import { satinRailIndices } from "./geometry";

const sub = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]];
const crossZ = (a: Vec2, b: Vec2) => a[0] * b[1] - a[1] * b[0];

function properCross(p1: Vec2, p2: Vec2, q1: Vec2, q2: Vec2): boolean {
  const d1 = crossZ(sub(p2, p1), sub(q1, p1));
  const d2 = crossZ(sub(p2, p1), sub(q2, p1));
  const d3 = crossZ(sub(q2, q1), sub(p1, q1));
  const d4 = crossZ(sub(q2, q1), sub(p2, q1));
  return ((d1 > 1e-9 && d2 < -1e-9) || (d1 < -1e-9 && d2 > 1e-9)) && ((d3 > 1e-9 && d4 < -1e-9) || (d3 < -1e-9 && d4 > 1e-9));
}

/** Where a closed outline crosses itself (the first point found), if it does. */
export function selfCrossing(sp: SubPath): Vec2 | null {
  const pts = flattenSubPath(sp, 0.3);
  const n = pts.length;
  if (n < 4) return null;
  const segs = sp.closed ? n : n - 1;
  const at = (i: number) => pts[i % n];
  for (let i = 0; i < segs && i < 600; i++)
    for (let j = i + 2; j < segs && j < 600; j++) {
      if (sp.closed && i === 0 && j === segs - 1) continue;
      if (properCross(at(i), at(i + 1), at(j), at(j + 1))) return at(i + 1);
    }
  return null;
}

/** Area of the closed sub-paths (even-odd), mm². */
export function fillArea(o: DesignObject): number {
  let a = 0;
  for (const sp of o.paths) {
    if (!sp.closed) continue;
    const pts = flattenSubPath(sp, 0.3);
    let s = 0;
    for (let i = 0; i < pts.length; i++) s += crossZ(pts[i], pts[(i + 1) % pts.length]);
    a += s / 2;
  }
  return Math.abs(a);
}

/** Length of all sub-paths, mm. */
export function pathLength(o: DesignObject): number {
  let l = 0;
  for (const sp of o.paths) {
    const pts = flattenSubPath(sp, 0.3);
    for (let i = 1; i < pts.length; i++) l += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    if (sp.closed && pts.length > 2) l += Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]);
  }
  return l;
}

export interface ShapeProblem {
  level: "error" | "warning" | "info";
  title: string;
  detail: string;
  at?: Vec2;
}

/** Geometry problems of one object (Ink/Stitch's fill and satin validation). */
export function shapeProblems(o: DesignObject): ShapeProblem[] {
  const out: ShapeProblem[] = [];
  const st = o.stitch;
  if (st.type === "fill") {
    const closed = o.paths.filter((sp) => sp.closed && sp.nodes.length >= 3);
    if (!closed.length) out.push({ level: "error", title: "Not a closed shape", detail: "A fill needs a closed outline — close the path or use a running stitch." });
    else if (fillArea(o) < 0.05) out.push({ level: "error", title: "Invalid shape", detail: "The outline encloses no area." });
    for (const sp of closed) {
      const x = selfCrossing(sp);
      if (x) {
        out.push({ level: "warning", title: "Border crosses itself", detail: "Parts of the shape may be left out or sewn twice — untangle the outline (Path ▸ Shape builder can split it).", at: x });
        break;
      }
    }
    if (st.method === "guided" && !st.guide) out.push({ level: "warning", title: "Guided fill without a guide line", detail: "Draw a guide line, or the rows fall back to straight ones." });
    if (st.method === "cross") {
      const cell = st.crossSize ?? 2.5;
      if (fillArea(o) < cell * cell * 0.5) out.push({ level: "warning", title: "Shape too small for its crosses", detail: `Smaller than half a ${cell} mm cell — no cross fits. Use a smaller cell.` });
    }
  }
  if (st.type === "satin") {
    const rails = o.paths.filter((sp) => sp.nodes.length >= 2);
    if (rails.length >= 2) {
      const ri = satinRailIndices(o.paths)!;
      const [r0, r1] = [o.paths[ri[0]], o.paths[ri[1]]];
      const rungs = rails.filter((sp) => sp !== r0 && sp !== r1);
      // a rung must cross both rails
      const crosses = (rung: SubPath, rail: SubPath) => {
        const a = flattenSubPath(rung, 0.2);
        const b = flattenSubPath(rail, 0.2);
        for (let i = 1; i < a.length; i++) for (let j = 1; j < b.length; j++) if (properCross(a[i - 1], a[i], b[j - 1], b[j])) return true;
        return false;
      };
      const dangling = rungs.find((r) => !(crosses(r, r0) && crosses(r, r1)));
      if (dangling) out.push({ level: "warning", title: "Rung misses a rail", detail: "A rung that doesn't cross both rails is ignored — lengthen it across the column.", at: dangling.nodes[0].p });
      if (!rungs.length && !(st.guides?.length) && r0.nodes.length !== r1.nodes.length)
        out.push({ level: "info", title: "Rails with unequal points", detail: "The rails pair up by length only. Add direction guides (D) to control the stitch angle." });
    }
  }
  return out;
}

export interface CleanupOptions {
  /** Fills smaller than this are removed (mm²). */
  minFillArea: number;
  /** Lines and satins shorter than this are removed (mm). */
  minLength: number;
}

export const DEFAULT_CLEANUP: CleanupOptions = { minFillArea: 3, minLength: 1.5 };

/** Objects a cleanup would remove: tiny fills, tiny lines and satins, empty objects. */
export function cleanupCandidates(doc: StitchDocument, opts: CleanupOptions = DEFAULT_CLEANUP): DesignObject[] {
  return doc.objects.filter((o) => {
    if (o.locked) return false;
    if (!o.paths.some((sp) => sp.nodes.length >= 2)) return true;
    if (o.text) return false;
    if (o.stitch.type === "fill") return fillArea(o) < opts.minFillArea;
    if (o.stitch.type === "running" || o.stitch.type === "satin") return pathLength(o) < opts.minLength;
    return false;
  });
}

/** Remove the cleanup candidates in one undo step; returns how many went. */
export function cleanupDocument(commit: (fn: (d: StitchDocument) => StitchDocument) => void, doc: StitchDocument, opts: CleanupOptions = DEFAULT_CLEANUP): number {
  const ids = new Set(cleanupCandidates(doc, opts).map((o) => o.id));
  if (ids.size) commit((d) => ({ ...d, objects: d.objects.filter((o) => !ids.has(o.id)) }));
  return ids.size;
}
