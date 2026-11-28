// Troubleshoot (Ink/Stitch "Troubleshoot objects", extended): finds problems
// in the design and the generated stitches, locates them on the canvas and
// offers one-click fixes.

import type { DesignObject, PlanData, StitchDocument, Vec2 } from "../types";
import { FLAG, NO_OBJECT } from "../types";
import { objectBoundsCached, transformObject, translateMat } from "./geometry";
import { denseIssues } from "./denseIssues";
import { rowAngleFor, rowsAlongGradient } from "./gradient";
import { ovalNorm, threadWeightInfo } from "./materials";
import { shapeProblems } from "./shapeCheck";
import { lineOverlaps } from "./lineOverlaps";
import { withLinkChoice } from "./links";
import { satinRails } from "./multicolorSatin";
import { simplifyForStitching } from "./stitchSimplify";
import { autoFillWidths } from "./underlay";

/** A layered 3D narrower than this has no room for its layers (mm; Punch). */
export const LAYERED3D_MIN_WIDTH = 6;

/** A satin's mean width: its width with one centre line, else between its two rails. */
function satinWidth(o: DesignObject): number | null {
  if (o.stitch.type !== "satin") return null;
  if (o.paths.filter((p) => p.nodes.length >= 2).length === 1) return o.stitch.width;
  const rails = satinRails(o);
  if (!rails) return null;
  const [a, b] = rails;
  return a.length ? a.reduce((s, p, i) => s + Math.hypot(p[0] - b[i][0], p[1] - b[i][1]), 0) / a.length : null;
}

export interface Issue {
  id: string;
  objId: string;
  level: "error" | "warning" | "info";
  title: string;
  detail: string;
  at: Vec2;
  /** A one-click fix: `apply` to the object, or to every object `scope` picks
   *  (all the layers of a gradient); or `doc`, a change to the whole design. */
  fix?: { label: string; apply?: (o: DesignObject) => DesignObject | null; scope?: (o: DesignObject) => boolean; doc?: (d: StitchDocument) => StitchDocument };
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
  for (let i = 0; i < objects.length; i++) if (objects[i] !== NO_OBJECT && objects[i] >= size) size = objects[i] + 1;
  const st: PlanStats = {
    stitches: new Uint32Array(size),
    reach: new Float32Array(oval ? size : 0),
    longest: new Float32Array(size),
    longestAt: new Float32Array(size * 2),
  };
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

/** A satin with this share of stitches under 0.5 mm, a running stitch with this share under 1 mm (and at least `SHORT_MIN`), turns too often. */
const SHORT_SHARE = 0.2;
const SHORT_LINE_SHARE = 0.3;
const SHORT_MIN = 10;
/** At most this many hot spots in the list (the worst of each object). */
const MAX_HOT_ISSUES = 8;

/**
 * What the stitches themselves show (engine quality.rs): needle holes that
 * pile up, and lines that turn so often their stitches are short. Fills are
 * judged by their holes only: every fill steps 0.2-0.4 mm from row to row.
 */
export function qualityIssues(doc: StitchDocument, plan: PlanData | null): Issue[] {
  const q = plan?.quality;
  if (!q) return [];
  const out: Issue[] = [];
  const seen = new Set<number>();
  // a fill there with an underlay too heavy for its width: that is the cause to fix first
  const [none] = autoFillWidths(doc.fabric);
  const thinWidth = new Map((q.narrowFills ?? []).filter((n) => n.width < none).map((n) => [n.index, n.width]));
  const heavyUnderlay = (i: number) => {
    const x = doc.objects[i];
    return thinWidth.has(i) && x?.stitch.type === "fill" && x.stitch.underlay && !x.stitch.underlayAuto;
  };
  for (const h of q.hotSpots) {
    const o = doc.objects[h.objects[0]];
    if (!o || seen.has(h.objects[0]) || out.length >= MAX_HOT_ISSUES) continue;
    seen.add(h.objects[0]);
    const most = Math.max(h.top, h.underlay, h.travel, h.ties);
    const thin = h.objects.slice(0, 2).find(heavyUnderlay);
    const other = h.objects.length > 1 && h.shares[1] >= 0.3 * h.shares.reduce((a, b) => a + b, 0) ? doc.objects[h.objects[1]] : undefined;
    let why: string;
    if (thin !== undefined) {
      why = `${doc.objects[thin].name} is only ${thinWidth.get(thin)!.toFixed(1)} mm wide and sews an underlay that can't fit under its rows: automatic underlay leaves it out.`;
    } else if (most === h.ties) {
      why =
        Math.max(objectBoundsCached(o)?.w ?? 0, objectBoundsCached(o)?.h ?? 0) < 5
          ? `Most are lock stitches: ${o.name} is too small to keep its lock-in and lock-off apart. A smaller lock shape (Design ▸ Stitch-out) puts fewer holes here.`
          : "Most are lock stitches: objects start or end here. Move a start or end point away.";
    } else if (other) {
      why = `The edges of ${o.name} and ${other.name} meet here: both end their rows along it${most === h.travel ? `, and ${o.name}'s travel runs along this stretch of its edge again and again` : ""}.`;
    } else if (most === h.travel) {
      why = `Most are ${o.name}'s travel stitches: it travels along this stretch again and again.`;
    } else {
      why = `Most are ${o.name}'s ${most === h.underlay ? "underlay" : "rows"}, meeting here. A wider spacing or another angle spreads them.`;
    }
    out.push({
      id: `holes:${o.id}`,
      objId: (thin !== undefined ? doc.objects[thin] : o).id,
      level: "warning",
      title: "Needle holes pile up",
      detail: `${Math.round(h.perMm2)} needle drops per mm² here; ${doc.fabric} takes ${Math.round(q.holeLimit)}. The fabric tears and needles break. ${why}`,
      at: h.at,
      ...(thin !== undefined
        ? {
            fix: {
              label: "Automatic underlay",
              apply: (x: DesignObject) => (x.stitch.type === "fill" ? { ...x, stitch: { ...x.stitch, underlayAuto: true } } : x),
            },
          }
        : {}),
    });
  }
  out.push(...underlayIssues(doc, q.narrowFills));
  for (const r of q.objects) {
    const o = doc.objects[r.index];
    if (!o || o.stitch.type === "fill") continue;
    // a running stitch set under 1 mm has its own issue ("Very short running stitches")
    const line = o.stitch.type === "running";
    if (o.stitch.type === "running" && o.stitch.length < 1) continue;
    const [n, under] = line ? [r.under1mm, "1 mm"] : [r.short, "0.5 mm"];
    if (n < SHORT_MIN || n < r.drops * (line ? SHORT_LINE_SHARE : SHORT_SHARE)) continue;
    const b = objectBoundsCached(o);
    out.push({
      id: `short:${o.id}`,
      objId: o.id,
      level: "info",
      title: "Many short stitches",
      detail: `${n} of ${r.drops} stitches are under ${under}: the path turns very often, as a traced or jagged outline does, and every sharp turn is a needle drop. Short stitches pile thread up and break it.${(o.minStitch ?? doc.machine.minStitch) < 0.3 && o.stitch.type === "running" ? ` The shortest stitch is ${o.minStitch ?? doc.machine.minStitch} mm: with Min. stitch at 0.3–0.5 mm (Design ▸ Stitch-out, or the object's Commands) its fine steps are left out too.` : ""}`,
      at: b ? [b.x + b.w / 2, b.y + b.h / 2] : [0, 0],
      ...(o.text
        ? {}
        : {
            fix: {
              label: "Simplify for stitching",
              apply: (x: DesignObject) => ({ ...x, paths: x.paths.map((sp) => (sp.nodes.length >= 3 ? simplifyForStitching(sp) : sp)) }),
            },
          }),
    });
  }
  return out;
}

/** The names of a few objects, then how many more. */
const someNames = (xs: { o: DesignObject; width: number }[]) =>
  xs
    .slice(0, 3)
    .map(({ o, width }) => `${o.name} ${width.toFixed(1)} mm`)
    .join(", ") + (xs.length > 3 ? ` and ${xs.length - 3} more` : "");

/**
 * Fills whose underlay is set by hand but too heavy for their width
 * (engine quality.rs measures it as automatic underlay does): under the
 * first width of automatic underlay none fits under the rows, and it only
 * adds needle holes along both edges (a warning); up to the second an edge
 * run is enough (a suggestion). One issue each, for all such fills, with a
 * fix for all of them: Automatic underlay.
 */
function underlayIssues(doc: StitchDocument, narrow: { index: number; width: number }[] | undefined): Issue[] {
  const [none, edge] = autoFillWidths(doc.fabric);
  const set = (narrow ?? [])
    .map(({ index, width }) => ({ o: doc.objects[index], width }))
    .filter(({ o }) => o?.stitch.type === "fill" && o.stitch.underlay && !o.stitch.underlayAuto && !o.locked)
    .sort((a, b) => a.width - b.width);
  const out: Issue[] = [];
  const auto = (ids: Set<string>) => ({
    apply: (x: DesignObject) => (x.stitch.type === "fill" ? { ...x, stitch: { ...x.stitch, underlayAuto: true } } : x),
    scope: (x: DesignObject) => ids.has(x.id),
  });
  const at = (o: DesignObject): Vec2 => {
    const b = objectBoundsCached(o);
    return b ? [b.x + b.w / 2, b.y + b.h / 2] : [0, 0];
  };
  const thin = set.filter((x) => x.width < none);
  if (thin.length) {
    const one = thin.length === 1;
    out.push({
      id: `underlayThin:${thin[0].o.id}`,
      objId: thin[0].o.id,
      level: "warning",
      title: one ? "Underlay in a narrow fill" : "Underlay in narrow fills",
      detail: `${one ? "This fill is" : `${thin.length} fills are`} narrower than ${none} mm (${someNames(thin)}). An underlay can't sit under rows that short: it adds needle holes along both edges and stiffens the line. Automatic underlay leaves it out there.`,
      at: at(thin[0].o),
      fix: { label: one ? "Automatic underlay" : `Automatic underlay (${thin.length})`, ...auto(new Set(thin.map((x) => x.o.id))) },
    });
  }
  const mid = set.filter((x) => x.width >= none && x.width < edge);
  if (mid.length) {
    const one = mid.length === 1;
    out.push({
      id: `underlayEdge:${mid[0].o.id}`,
      objId: mid[0].o.id,
      level: "info",
      title: one ? "Lighter underlay for a narrow fill" : "Lighter underlay for narrow fills",
      detail: `${one ? "This fill is" : `${mid.length} fills are`} narrower than ${edge} mm (${someNames(mid)}) and sew${one ? "s" : ""} a full underlay. An edge run holds a shape that narrow, with fewer stitches and needle holes: automatic underlay sews just that.`,
      at: at(mid[0].o),
      fix: { label: one ? "Automatic underlay" : `Automatic underlay (${mid.length})`, ...auto(new Set(mid.map((x) => x.o.id))) },
    });
  }
  return out;
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

  // lines lying on top of each other (auto-routed lines travel back on purpose)
  const overlaps = new Map(lineOverlaps(doc.objects, { skipSelf: (o) => !!o.routed }).map((x) => [x.id, x]));
  const nameOf = (id: string) => doc.objects.find((o) => o.id === id)?.name ?? "another line";

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

    const ov = overlaps.get(o.id);
    if (ov) {
      const mm = ov.length.toFixed(ov.length < 10 ? 1 : 0);
      if (ov.other && ov.share >= 0.95)
        add({
          level: "warning",
          title: "Line on top of another line",
          detail: `It lies on “${nameOf(ov.other)}”: the thread is sewn twice there (${mm} mm).`,
          at: ov.at,
          fix: { label: "Delete it", apply: () => null },
        });
      else
        add({
          level: ov.other ? "warning" : "info",
          title: ov.other ? "Lines on top of each other" : "Line runs over itself",
          detail: ov.other
            ? `${mm} mm of it lies on “${nameOf(ov.other)}” and is sewn twice.`
            : `${mm} mm of it goes back over itself and is sewn twice (fine for an underpath you meant).`,
          at: ov.at,
          fix: { label: "Cut out the doubled part", apply: () => ov.cut() },
        });
    }

    const outsideBox = b.x < -0.01 || b.y < -0.01 || b.x + b.w > hw + 0.01 || b.y + b.h > hh + 0.01;
    const outsideOval =
      oval &&
      !outsideBox &&
      (reachOf(index) ??
        Math.max(
          ...[
            [b.x, b.y],
            [b.x + b.w, b.y],
            [b.x, b.y + b.h],
            [b.x + b.w, b.y + b.h],
          ].map(([x, y]) => ovalNorm(hw / 2, hh / 2, hw, hh, x, y)),
        )) > 1.0005;
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
      // a bisatin's stitches are half the width; 3D satins are wide on purpose
      const wide = st.foam || st.layered ? null : satinWidth(o);
      if (wide != null && wide / (st.bisatin ? 2 : 1) > 9 && st.maxStitchLength === 0) {
        add({
          level: "warning",
          title: "Satin too wide",
          detail: `${(wide / (st.bisatin ? 2 : 1)).toFixed(1)} mm stitches can snag and loop. Split them${st.bisatin ? "" : ", sew it as a bisatin (two columns half as wide)"} or use a fill.`,
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
          detail:
            "Every row is split between the colours, so each colour sews short pieces joined by trims. Rows across the gradient give each colour whole rows.",
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
          fix: { label: "Set 0.25 mm (Ink/Stitch)", apply: (x) => (x.stitch.type === "fill" ? { ...x, stitch: { ...x.stitch, rowSpacing: 0.25 } } : x) },
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
  // 3D: foam goes last (anything sewn after it flattens it), layers need width
  const sewn = doc.objects.filter((o) => o.visible && o.stitch.type !== "none");
  const lastFlat = sewn.reduce((k, o, i) => (o.stitch.type === "satin" && o.stitch.foam ? k : i), -1);
  sewn.forEach((o, i) => {
    if (o.stitch.type !== "satin") return;
    const b = objectBoundsCached(o);
    if (!b) return;
    const at: Vec2 = [b.x + b.w / 2, b.y + b.h / 2];
    if (o.stitch.foam && i < lastFlat)
      out.push({
        id: `foamLast:${o.id}`,
        objId: o.id,
        level: "warning",
        title: "3D foam goes last",
        detail: `${o.name} is sewn over foam, but other objects are sewn after it: they would run over the foam and flatten it. Move it to the end of the sewing order.`,
        at,
      });
    const w = o.stitch.layered ? satinWidth(o) : null;
    if (w != null && w < LAYERED3D_MIN_WIDTH)
      out.push({
        id: `layeredThin:${o.id}`,
        objId: o.id,
        level: "warning",
        title: "Layered 3D under 6 mm",
        detail: `The column is ${w.toFixed(1)} mm wide: under ${LAYERED3D_MIN_WIDTH} mm the layers have no room to rise. Widen it or use a plain satin.`,
        at,
      });
  });
  // a connection sewn through by hand that nothing sewn later covers
  for (const c of plan?.links ?? []) {
    const o = doc.objects[c.from];
    if (!o || !c.manual || !c.visible || c.kind !== "sew" || o.trimAfter) continue;
    const len = Math.hypot(c.end[0] - c.start[0], c.end[1] - c.start[1]);
    out.push({
      id: `link:${o.id}`,
      objId: o.id,
      level: "warning",
      title: "Sewn-through connection shows",
      detail: `After ${o.name} the needle sews ${len.toFixed(1)} mm to the next object and nothing sewn later covers it. Trim or jump there, or sew a later object over it.`,
      at: [(c.start[0] + c.end[0]) / 2, (c.start[1] + c.end[1]) / 2],
      fix: { label: "Trim instead", apply: (x) => withLinkChoice(x, "trim") },
    });
  }
  const quality = qualityIssues(doc, plan);
  out.push(...quality, ...denseIssues(doc, plan, quality));
  const total = plan?.stats.stitches ?? 0;
  if (total > 100000)
    out.push({ id: "big", objId: "", level: "info", title: "Very large design", detail: `${total.toLocaleString()} stitches.`, at: [hw / 2, hh / 2] });
  cache.set(doc, { plan, issues: out });
  return out;
}
