// Troubleshoot (Ink/Stitch "Troubleshoot objects", extended): finds problems
// in the design and the generated stitches, locates them on the canvas and
// offers one-click fixes.

import type { DesignObject, PlanData, StitchDocument, Vec2 } from "../types";
import { FLAG } from "../types";
import { objectBoundsCached, transformObject, translateMat } from "./geometry";
import { rowAngleFor, rowsAlongGradient } from "./gradient";
import { ovalNorm, threadWeightInfo } from "./materials";
import { shapeProblems } from "./shapeCheck";

export interface Issue {
  id: string;
  objId: string;
  level: "error" | "warning" | "info";
  title: string;
  detail: string;
  at: Vec2;
  /** A one-click fix: `apply` to the object, or to every object `scope` picks
   *  (all the layers of a gradient). */
  fix?: { label: string; apply: (o: DesignObject) => DesignObject; scope?: (o: DesignObject) => boolean };
}

const cache = new WeakMap<StitchDocument, { plan: PlanData | null; issues: Issue[] }>();

/** Per-object statistics of a plan (by object index). */
interface PlanStats {
  stitches: Uint32Array;
  /** Oval hoops: how far each object reaches (1 = on the ellipse); empty otherwise. */
  reach: Float32Array;
  longest: Float32Array;
  /** Middle of each object's longest stitch (x, y). */
  longestAt: Float32Array;
}
const planStats = new WeakMap<PlanData, { key: string; stats: PlanStats }>();

/** The plan's per-object statistics: once per plan (a move only changes the document). */
function statsOf(plan: PlanData, n: number, hw: number, hh: number, oval: boolean): PlanStats {
  const key = `${n}:${hw}:${hh}:${oval}`;
  const hit = planStats.get(plan);
  if (hit && hit.key === key) return hit.stats;
  const { coords, flags, objects } = plan;
  let size = n;
  for (let i = 0; i < objects.length; i++) if (objects[i] !== 0xffffffff && objects[i] >= size) size = objects[i] + 1;
  const st: PlanStats = { stitches: new Uint32Array(size), reach: new Float32Array(oval ? size : 0), longest: new Float32Array(size), longestAt: new Float32Array(size * 2) };
  let pen = false;
  let px = 0;
  let py = 0;
  for (let i = 0; i < flags.length; i++) {
    const f = flags[i];
    const x = coords[2 * i];
    const y = coords[2 * i + 1];
    if (f & (FLAG.COLOR_CHANGE | FLAG.TRIM | FLAG.STOP | FLAG.END)) {
      pen = false;
      continue;
    }
    if (f & FLAG.JUMP) {
      pen = false;
      px = x;
      py = y;
      continue;
    }
    const o = objects[i];
    if (o < size) {
      st.stitches[o]++;
      if (oval) st.reach[o] = Math.max(st.reach[o], ovalNorm(hw / 2, hh / 2, hw, hh, x, y));
      if (pen) {
        const l = Math.hypot(x - px, y - py);
        if (l > st.longest[o]) {
          st.longest[o] = l;
          st.longestAt[2 * o] = (x + px) / 2;
          st.longestAt[2 * o + 1] = (y + py) / 2;
        }
      }
    }
    pen = true;
    px = x;
    py = y;
  }
  planStats.set(plan, { key, stats: st });
  return st;
}

/** Shape geometry problems, once per object (unchanged objects keep their identity while another one moves). */
const shapeCache = new WeakMap<DesignObject, ReturnType<typeof shapeProblems>>();
function shapeProblemsCached(o: DesignObject) {
  let r = shapeCache.get(o);
  if (!r) shapeCache.set(o, (r = shapeProblems(o)));
  return r;
}

export function computeIssues(doc: StitchDocument, plan: PlanData | null): Issue[] {
  const hit = cache.get(doc);
  if (hit && hit.plan === plan) return hit.issues;
  const out: Issue[] = [];
  const hw = doc.hoop.width;
  const hh = doc.hoop.height;

  // per-object stitch statistics from the plan
  const oval = doc.hoop.shape === "oval";
  const ps = plan ? statsOf(plan, doc.objects.length, hw, hh, oval) : null;
  const stitchesOf = (i: number) => (ps && i < ps.stitches.length ? ps.stitches[i] : 0);
  const reachOf = (i: number): number | undefined => (ps && i < ps.reach.length && ps.stitches[i] ? ps.reach[i] : undefined);
  const longestOf = (i: number): { len: number; at: Vec2 } | undefined =>
    ps && i < ps.longest.length && ps.longest[i] > 0 ? { len: ps.longest[i], at: [ps.longestAt[2 * i], ps.longestAt[2 * i + 1]] } : undefined;

  // lettering smaller than the thread weight allows (once per text group)
  const weight = threadWeightInfo(doc.options?.threadWeight);
  const smallText = new Set<string>();

  doc.objects.forEach((o, index) => {
    if (!o.visible) return;
    const b = objectBoundsCached(o);
    if (!b) return;
    const c: Vec2 = [b.x + b.w / 2, b.y + b.h / 2];
    const add = (i: Omit<Issue, "id" | "objId">) => out.push({ ...i, id: `${o.id}:${out.length}`, objId: o.id });
    const st = o.stitch;

    const outsideBox = b.x < -0.01 || b.y < -0.01 || b.x + b.w > hw + 0.01 || b.y + b.h > hh + 0.01;
    const outsideOval = oval && !outsideBox && (reachOf(index) ?? Math.max(...[[b.x, b.y], [b.x + b.w, b.y], [b.x, b.y + b.h], [b.x + b.w, b.y + b.h]].map(([x, y]) => ovalNorm(hw / 2, hh / 2, hw, hh, x, y)))) > 1.0005;
    if (outsideOval) {
      add({
        level: "error",
        title: "Outside the oval hoop",
        detail: "Part of this object lies outside the ellipse the machine can reach.",
        at: c,
        fix: { label: "Move to the centre", apply: (x) => transformObject(x, translateMat(hw / 2 - c[0], hh / 2 - c[1])) },
      });
    }
    if (outsideBox) {
      add({
        level: "error",
        title: "Outside the hoop",
        detail: "Part of this object can't be reached by the machine.",
        at: [Math.min(Math.max(c[0], 0), hw), Math.min(Math.max(c[1], 0), hh)],
        fix: {
          label: "Move inside",
          apply: (x) => {
            const dx = b.x < 0 ? -b.x : b.x + b.w > hw ? hw - (b.x + b.w) : 0;
            const dy = b.y < 0 ? -b.y : b.y + b.h > hh ? hh - (b.y + b.h) : 0;
            return transformObject(x, translateMat(dx, dy));
          },
        },
      });
    }
    if (o.text && o.text.size < weight.minText && !smallText.has(o.text.group)) {
      smallText.add(o.text.group);
      add({
        level: "warning",
        title: "Lettering too small for the thread",
        detail: `${o.text.size.toFixed(1)} mm letters — No. ${weight.weight} thread needs ${weight.minText} mm (${weight.minTextSource}). Use finer thread or larger text.`,
        at: c,
      });
    }
    if (plan && st.type !== "none" && !stitchesOf(index)) {
      add({ level: "warning", title: "Produces no stitches", detail: "The shape may be too small or invalid for this stitch type.", at: c });
    }
    if (st.type === "satin") {
      const w = o.paths.length === 1 ? st.width : undefined;
      if (w !== undefined && w > 9 && st.maxStitchLength === 0) {
        add({
          level: "warning",
          title: "Satin too wide",
          detail: `${w.toFixed(1)} mm stitches can snag and loop. Split them or use a fill.`,
          at: c,
          fix: { label: "Split at 7 mm", apply: (x) => (x.stitch.type === "satin" ? { ...x, stitch: { ...x.stitch, maxStitchLength: 7 } } : x) },
        });
      }
      if (w !== undefined && w < 0.8) {
        add({
          level: "warning",
          title: "Satin too narrow",
          detail: "Columns under 0.8 mm don't show; a running stitch looks cleaner.",
          at: c,
          fix: { label: "Use triple run", apply: (x) => ({ ...x, stitch: { type: "running", length: 1.8, tolerance: 0.2, repeats: 1, beanRepeats: 2 } }) },
        });
      }
    }
    if (st.type === "fill") {
      // once per gradient (its first colour), the fix turns every layer
      if (st.gradient?.layer === 0 && rowsAlongGradient(st)) {
        const g = st.gradient;
        const across = rowAngleFor(g.from, g.to);
        add({
          level: "warning",
          title: "Rows run along the gradient",
          detail: "Every row is split between the colours, so each colour sews short pieces joined by trims. Rows across the gradient give each colour whole rows.",
          at: c,
          fix: {
            label: "Turn rows across",
            apply: (x) => (x.stitch.type === "fill" ? { ...x, stitch: { ...x.stitch, angle: across } } : x),
            scope: (x) => x.stitch.type === "fill" && x.stitch.gradient?.group === g.group,
          },
        });
      }
      if (Math.max(b.w, b.h) < 2.5) {
        add({ level: "info", title: "Very small fill", detail: "Fills under ~2.5 mm look lumpy; consider satin or running stitch.", at: c });
      }
      if (st.rowSpacing < 0.2 && (st.method === "tatami" || st.method === "contour" || st.method === "spiral")) {
        add({
          level: "warning",
          title: "Very dense fill",
          detail: `Row spacing ${st.rowSpacing} mm can make the fabric stiff and break needles.`,
          at: c,
          fix: { label: "Set 0.4 mm", apply: (x) => (x.stitch.type === "fill" ? { ...x, stitch: { ...x.stitch, rowSpacing: 0.4 } } : x) },
        });
      }
    }
    if (st.type === "running" && st.length < 1) {
      add({
        level: "warning",
        title: "Very short running stitches",
        detail: "Stitches under 1 mm tend to break the thread.",
        at: c,
        fix: { label: "Set 1.5 mm", apply: (x) => (x.stitch.type === "running" ? { ...x, stitch: { ...x.stitch, length: 1.5 } } : x) },
      });
    }
    // shape geometry (Ink/Stitch troubleshoot)
    for (const pr of shapeProblemsCached(o)) add({ level: pr.level, title: pr.title, detail: pr.detail, at: pr.at ?? c });
    const lg = longestOf(index);
    if (lg && lg.len > 8 && st.type !== "satin") {
      add({ level: "warning", title: "Long stitches", detail: `Contains a ${lg.len.toFixed(1)} mm stitch that may snag.`, at: lg.at });
    }
  });
  const total = plan?.stats.stitches ?? 0;
  if (total > 100000) out.push({ id: "big", objId: "", level: "info", title: "Very large design", detail: `${total.toLocaleString()} stitches.`, at: [hw / 2, hh / 2] });
  cache.set(doc, { plan, issues: out });
  return out;
}
