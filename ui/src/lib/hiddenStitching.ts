// Hidden stitching: what removing the stitching under objects on top does to
// a design (stitches saved per object, the shapes as they are stitched), the
// rules for what hides what (mirroring crates/core/src/assemble.rs, without the
// width test, which needs the engine), and overlap suggestions per fabric.

import { useEffect, useState } from "react";
import { engine } from "../engine/client";
import { planOf, useStore } from "../store";
import { FLAG, type DesignObject, type DesignOptions, type Fabric, type PlanData, type StitchDocument, type SubPath } from "../types";
import { defaultDesignOptions } from "./geometry";

/** The options with every hidden-stitching setting filled in. */
export const hiddenOptions = (o: Partial<DesignOptions> | undefined): Required<Pick<DesignOptions, "removeOverlaps" | "overlapMargin" | "coverMinWidth" | "coverMaxSpacing" | "texturedCovers" | "appliqueCovers" | "minFragment" | "keepUnderlay" | "trimRunning">> => {
  const d = defaultDesignOptions();
  return {
    removeOverlaps: o?.removeOverlaps ?? d.removeOverlaps,
    overlapMargin: o?.overlapMargin ?? d.overlapMargin,
    coverMinWidth: o?.coverMinWidth ?? d.coverMinWidth!,
    coverMaxSpacing: o?.coverMaxSpacing ?? d.coverMaxSpacing!,
    texturedCovers: o?.texturedCovers ?? d.texturedCovers!,
    appliqueCovers: o?.appliqueCovers ?? d.appliqueCovers!,
    minFragment: o?.minFragment ?? d.minFragment!,
    keepUnderlay: o?.keepUnderlay ?? d.keepUnderlay!,
    trimRunning: o?.trimRunning ?? d.trimRunning!,
  };
};

/** The removal settings back to their defaults (the switch and the overlap stay). */
export const RULE_DEFAULTS: Partial<DesignOptions> = (() => {
  const d = defaultDesignOptions();
  return {
    coverMinWidth: d.coverMinWidth,
    coverMaxSpacing: d.coverMaxSpacing,
    texturedCovers: d.texturedCovers,
    appliqueCovers: d.appliqueCovers,
    minFragment: d.minFragment,
    keepUnderlay: d.keepUnderlay,
    trimRunning: d.trimRunning,
  };
})();

const TEXTURES = new Set(["stipple", "meander", "hilbert", "cross"]);

/**
 * Whether an object hides what's under it, by the rules that don't need its
 * shape: `yes`, `no` with the reason, or `wide` (yes, if any part of it is at
 * least the cover width wide — the engine checks that).
 */
export function coverVerdict(o: DesignObject, opts: Partial<DesignOptions> | undefined): { hides: "yes" | "no" | "wide"; why: string } {
  const h = hiddenOptions(opts);
  const mode = o.hidden?.covers ?? "auto";
  const st = o.stitch;
  if (st.type !== "fill" && st.type !== "satin" && st.type !== "applique") return { hides: "no", why: "Lines never hide what's under them." };
  if (!o.visible) return { hides: "no", why: "Hidden objects aren't stitched." };
  if (mode === "never") return { hides: "no", why: "Set to never hide." };
  if (mode === "always") return { hides: "yes", why: "Set to always hide, even when thin or open." };
  const wide = `if any part is at least ${h.coverMinWidth} mm wide`;
  const open = (sp: number) => h.coverMaxSpacing > 0 && sp > h.coverMaxSpacing + 1e-9;
  if (st.type === "applique") return h.appliqueCovers ? { hides: "wide", why: `The appliqué fabric hides what's under it, ${wide}.` } : { hides: "no", why: "Appliqué fabric is set not to hide." };
  if (st.type === "satin") return open(st.spacing) ? { hides: "no", why: `Open: rows ${st.spacing} mm apart (the limit is ${h.coverMaxSpacing} mm).` } : { hides: "wide", why: `Dense satin: hides ${wide}.` };
  if (st.gradient || st.tartan) return { hides: "wide", why: "One colour of a gradient: the colours together hide what's under them, not each other." };
  if (st.ramp || (st.endRowSpacing ?? 0) > 0) return { hides: "no", why: "Its rows open up towards one end, so it shows what's under it." };
  if (TEXTURES.has(st.method) && !h.texturedCovers) return { hides: "no", why: "A texture (stipple, meander, Hilbert, cross stitch) shows what's under it." };
  if (open(st.rowSpacing)) return { hides: "no", why: `Open: rows ${st.rowSpacing} mm apart (the limit is ${h.coverMaxSpacing} mm).` };
  return { hides: "wide", why: `Dense fill: hides ${wide}.` };
}

/** Overlap under the object on top that practitioners suggest for a fabric (mm). */
export function suggestedOverlap(fabric: Fabric): { value: number; why: string } {
  if (fabric === "towel" || fabric === "fleece") return { value: 1.0, why: "pile fabrics move the most" };
  if (fabric === "knit" || fabric === "pique") return { value: 0.9, why: "knits stretch: 0.8–1.0 mm" };
  if (fabric === "sheer" || fabric === "silk") return { value: 0.4, why: "fine fabrics: every needle hole shows" };
  return { value: 0.5, why: "stable fabrics: 0.3–0.5 mm" };
}

// ---------------------------------------------------------------------------
// The report: stitches with and without removal, per object

export interface HiddenObject {
  index: number;
  before: number;
  after: number;
  /** Cut away completely. */
  gone: boolean;
}
export interface HiddenReport {
  before: number;
  after: number;
  objects: HiddenObject[];
  shapes: { index: number; paths: SubPath[] }[];
}

const perObject = (plan: PlanData) => {
  const n = new Map<number, number>();
  for (let i = 0; i < plan.flags.length; i++) {
    if (plan.flags[i] & (FLAG.COMMANDS | FLAG.JUMP)) continue;
    n.set(plan.objects[i], (n.get(plan.objects[i]) ?? 0) + 1);
  }
  return n;
};

const reports = new WeakMap<StitchDocument, Promise<HiddenReport>>();

export function hiddenReport(doc: StitchDocument): Promise<HiddenReport> {
  const hit = reports.get(doc);
  if (hit) return hit;
  const opts = { ...defaultDesignOptions(), ...doc.options };
  const on = { ...doc, options: { ...opts, removeOverlaps: true } };
  // with removal: the editor's own plan of this document when it has one
  // (removal is on whenever the report is asked for), else one of its own
  const own = hiddenOptions(doc.options).removeOverlaps ? planOf.get(doc) : undefined;
  const p = Promise.all([
    engine.planLatest("hidden-without", { ...doc, options: { ...opts, removeOverlaps: false } }),
    own ? Promise.resolve(own) : engine.planLatest("hidden-with", on),
    engine.stitchedShapesLatest("hidden-shapes", on),
  ]).then(
    ([without, withIt, shapes]) => {
      const a = perObject(without);
      const b = perObject(withIt);
      const objects: HiddenObject[] = [];
      for (const [index, before] of a) {
        const after = b.get(index) ?? 0;
        if (after < before) objects.push({ index, before, after, gone: shapes.some((s) => s.index === index && !s.paths.length) });
      }
      objects.sort((x, y) => y.before - y.after - (x.before - x.after));
      return { before: without.stats.stitches, after: withIt.stats.stitches, objects, shapes };
    },
  );
  reports.set(doc, p);
  // a superseded request (a newer document came) is not remembered
  p.catch(() => reports.delete(doc));
  return p;
}

/** The report for the current design (null while it is worked out, or when removal is off). */
export function useHiddenReport(): HiddenReport | null {
  const doc = useStore((s) => s.doc);
  const on = hiddenOptions(doc.options).removeOverlaps;
  const [r, setR] = useState<HiddenReport | null>(null);
  useEffect(() => {
    if (!on) return setR(null);
    let live = true;
    const t = setTimeout(() => {
      hiddenReport(doc)
        .then((x) => live && setR(x))
        .catch(() => {});
    }, 400);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [doc, on]);
  return r;
}

// the canvas preview: the cut shapes follow the design while "show" is on
let timer: ReturnType<typeof setTimeout> | null = null;
useStore.subscribe((s, p) => {
  if (s.doc === p.doc && s.showHidden === p.showHidden) return;
  if (timer) clearTimeout(timer);
  if (!s.showHidden || !hiddenOptions(s.doc.options).removeOverlaps) {
    if (s.hiddenShapes) useStore.setState({ hiddenShapes: null });
    return;
  }
  const doc = s.doc;
  timer = setTimeout(() => {
    // the preview needs only the cut shapes, not the report's plans
    engine
      .stitchedShapesLatest("hidden-preview", { ...doc, options: { ...defaultDesignOptions(), ...doc.options, removeOverlaps: true } })
      .then((shapes) => useStore.getState().doc === doc && useStore.setState({ hiddenShapes: shapes }))
      .catch(() => {});
  }, 300);
});
