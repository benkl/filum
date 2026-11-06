// Auto-route running stitch on the selection (see ./route for the routing).

import type { DesignObject, Vec2 } from "../types";
import { useStore } from "../store";
import { flattenSubPath } from "./bezier";
import { uid } from "./geometry";
import { routeRunning } from "./route";
import { autoSatin } from "./autoSatin";
import { withParent } from "./groups";
import { pruneGroups } from "./layerRows";
import { safeSetItem } from "./storage";

// ---------------------------------------------------------------------------
// The action on the selection


/** Running-stitch objects among the selection that can be routed together. */
export function routableSelection(): DesignObject[] {
  const s = useStore.getState();
  return s.doc.objects.filter((o) => s.selection.includes(o.id) && o.stitch.type === "running" && !o.stitch.ripple);
}

/**
 * Route the selected running-stitch lines into one object (Ink/Stitch
 * "Auto-route running stitch"): placed where the first of them was, in its
 * thread and stitch settings; lines sewn twice where the route travels.
 */
export function autoRouteSelection(redwork = false): string | null {
  const s = useStore.getState();
  const objs = routableSelection();
  if (objs.length < 1) return "Select running-stitch lines";
  const lines = objs.flatMap((o) => o.paths.map((sp) => flattenSubPath(sp, 0.1)));
  const paths = routeRunning(lines, { start: objs[0].start ?? lines[0]?.[0], redwork });
  if (!paths.length) return "Nothing to route";
  const first = objs[0];
  const routed: DesignObject = {
    ...first,
    id: uid(),
    name: `${first.name} (${redwork ? "redwork" : "routed"})`,
    paths: paths.map((pts) => ({ closed: false, nodes: pts.map((p) => ({ p })) })),
    start: undefined,
    end: undefined,
  };
  const ids = new Set(objs.map((o) => o.id));
  const at = s.doc.objects.findIndex((o) => ids.has(o.id));
  s.commit((d) => {
    const rest = d.objects.filter((o) => !ids.has(o.id));
    rest.splice(Math.min(at, rest.length), 0, routed);
    return { ...d, objects: rest };
  });
  s.select([routed.id]);
  const jumps = paths.length - 1;
  if (redwork) {
    s.toast(`Redwork: ${lines.length} line${lines.length > 1 ? "s" : ""} sewn out and back${paths.length > 1 ? ` in ${paths.length} separate parts` : " — one path, no jumps"}`);
    return null;
  }
  s.toast(`Routed ${lines.length} line${lines.length > 1 ? "s" : ""} into ${paths.length} path${paths.length > 1 ? "s" : ""}${jumps ? ` (${jumps} jump${jumps > 1 ? "s" : ""} between separate parts)` : " — no jumps"}`);
  return null;
}

/**
 * Jump to stroke (Ink/Stitch): where the plan jumps from one object to the
 * next one in the same thread, a running-stitch connector is inserted
 * between them instead (between `min` and `max` mm long; longer jumps stay
 * jumps and get trimmed). Applies to the selection, or the whole design.
 */
export function jumpsToStrokes(min = 1, max = 15): string | null {
  const s = useStore.getState();
  const plan = s.plan;
  if (!plan) return "No stitches yet";
  const sel = new Set(s.selection);
  const objs = s.doc.objects;
  // first and last stitch of every object in the plan
  const first = new Map<number, Vec2>();
  const last = new Map<number, Vec2>();
  for (let i = 0; i < plan.objects.length; i++) {
    const o = plan.objects[i];
    if (o === 0xffffffff || plan.flags[i] & 31) continue;
    const p: Vec2 = [plan.coords[i * 2], plan.coords[i * 2 + 1]];
    if (!first.has(o)) first.set(o, p);
    last.set(o, p);
  }
  const visible = objs.map((o, i) => [o, i] as const).filter(([o, i]) => o.visible && first.has(i));
  const inserts: { after: string; obj: DesignObject }[] = [];
  for (let k = 0; k + 1 < visible.length; k++) {
    const [a, ia] = visible[k];
    const [b, ib] = visible[k + 1];
    if (sel.size && !(sel.has(a.id) && sel.has(b.id))) continue;
    if (a.thread !== b.thread || a.trimAfter || a.stopAfter) continue;
    const p = last.get(ia)!;
    const q = first.get(ib)!;
    const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (d < min || d > max) continue;
    inserts.push({
      after: a.id,
      obj: {
        id: uid(),
        name: `${a.name} → ${b.name}`,
        thread: a.thread,
        visible: true,
        locked: false,
        trimAfter: false,
        stopAfter: false,
        paths: [{ closed: false, nodes: [{ p }, { p: q }] }],
        stitch: { type: "running", length: 2.5, tolerance: 0.2, repeats: 1, beanRepeats: 0 },
      },
    });
  }
  if (!inserts.length) return `No jumps between ${min} and ${max} mm in the same thread`;
  s.commit((d) => {
    const out: DesignObject[] = [];
    for (const o of d.objects) {
      out.push(o);
      for (const ins of inserts) if (ins.after === o.id) out.push(ins.obj);
    }
    return { ...d, objects: out };
  });
  s.toast(`${inserts.length} jump${inserts.length > 1 ? "s" : ""} turned into running stitch`);
  return null;
}

// ---------------------------------------------------------------------------
// Auto-route satin columns (see ./autoSatin)

const SATIN_OPTS = "filum.autoSatin";

/** The remembered options of Auto-route satins. */
export function autoSatinOptions(): { trim: boolean; preserveOrder: boolean; keepOriginals: boolean } {
  try {
    return { trim: false, preserveOrder: false, keepOriginals: false, ...JSON.parse(localStorage.getItem(SATIN_OPTS) ?? "{}") };
  } catch {
    return { trim: false, preserveOrder: false, keepOriginals: false };
  }
}
export function setAutoSatinOptions(o: Partial<ReturnType<typeof autoSatinOptions>>) {
  safeSetItem(SATIN_OPTS, JSON.stringify({ ...autoSatinOptions(), ...o }));
}

/**
 * Route the selected satin columns (with running lines showing where to
 * travel) into one sewing order: satins cut where the route turns, running
 * underpaths between them (Ink/Stitch "Auto-route satin columns").
 */
export function autoRouteSatins(): string | null {
  const s = useStore.getState();
  const sel = s.doc.objects.filter((o) => s.selection.includes(o.id) && (o.stitch.type === "satin" || (o.stitch.type === "running" && !o.stitch.ripple)));
  if (!sel.some((o) => o.stitch.type === "satin")) return "Select satin columns";
  const opts = autoSatinOptions();
  const routed = autoSatin(sel, { ...opts, start: sel[0].start, end: sel[sel.length - 1].end });
  if (!routed?.length) return "Nothing to route";
  const ids = new Set(sel.map((o) => o.id));
  const at = s.doc.objects.findIndex((o) => ids.has(o.id));
  const group = uid("g");
  const out = routed.map((o) => ({ ...o, group }));
  // the route's group sits in the group the columns shared, if any
  const around = sel.every((o) => o.group === sel[0].group) ? sel[0].group : undefined;
  s.commit((d) => {
    // the originals: removed, or kept hidden so they are not sewn twice
    const rest = opts.keepOriginals ? d.objects.map((o) => (ids.has(o.id) ? { ...o, visible: false, name: o.name.endsWith(" (original)") ? o.name : `${o.name} (original)` } : o)) : d.objects.filter((o) => !ids.has(o.id));
    const pos = opts.keepOriginals ? Math.max(...rest.map((o, i) => (ids.has(o.id) ? i + 1 : 0))) : Math.min(at, rest.length);
    rest.splice(pos, 0, ...out);
    return pruneGroups({ ...d, objects: rest, groupParents: withParent(d.groupParents, group, around) });
  });
  s.select(out.map((o) => o.id));
  const satins = out.filter((o) => o.stitch.type === "satin").length;
  const runs = out.length - satins;
  s.toast(`Auto-routed: ${satins} satin${satins > 1 ? "s" : ""}${runs ? ` and ${runs} underpath${runs > 1 ? "s" : ""}` : ""}${opts.trim ? ", trims between parts" : ""}`);
  return null;
}
