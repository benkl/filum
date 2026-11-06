// Path commands on whole objects (the select tool): join open paths at their
// nearest ends, make a compound path from several objects and release it
// again. Pure functions on the document (the menu actions: lib/pathActions.ts).

import type { DesignObject, NodeRef, StitchDocument, SubPath } from "../types";
import { vdist } from "./bezier";
import { isRailSatin, joinNodes } from "./nodeOps";
import { pruneGroups } from "./layerRows";
import { uid } from "./geometry";

type End = { ref: NodeRef; p: [number, number] };

/** Objects whose paths these commands must not rewrite: a gradient's or tartan's colour layers (they share one shape) and linked clones (their paths follow the original). */
function untouchable(objs: DesignObject[]): string | null {
  if (objs.some((o) => o.clone)) return "Linked clones follow their original: unlink them first";
  if (objs.some((o) => o.stitch.type === "fill" && (o.stitch.gradient || o.stitch.tartan))) return "Gradients and tartans keep one shape for all their colours: remove the gradient or tartan first";
  return null;
}

/** The ends of the open paths of an object. */
function endsOf(o: DesignObject): End[] {
  const out: End[] = [];
  o.paths.forEach((sp, si) => {
    if (sp.closed || sp.nodes.length < 2) return;
    out.push({ ref: { id: o.id, sp: si, ni: 0 }, p: sp.nodes[0].p });
    out.push({ ref: { id: o.id, sp: si, ni: sp.nodes.length - 1 }, p: sp.nodes[sp.nodes.length - 1].p });
  });
  return out;
}

/**
 * Join (Ctrl+J): one object with an open path closes it; several objects are
 * joined into one path, each time at the two nearest ends of different paths
 * (into the first object, in stitch order).
 */
export function joinObjects(doc: StitchDocument, ids: string[]): { doc: StitchDocument; error?: string } {
  const objs = doc.objects.filter((o) => ids.includes(o.id) && !o.locked);
  const no = untouchable(objs);
  if (no) return { doc, error: no };
  if (objs.some(isRailSatin)) return { doc, error: "Satin rails are joined in pairs: use the satin tool" };
  if (objs.length === 1) {
    const o = objs[0];
    const open = o.paths.findIndex((sp) => !sp.closed && sp.nodes.length >= 2);
    if (open < 0) return { doc, error: "The path is closed already" };
    const sp = o.paths[open];
    return joinNodes(doc, [
      { id: o.id, sp: open, ni: 0 },
      { id: o.id, sp: open, ni: sp.nodes.length - 1 },
    ]);
  }
  if (objs.length < 2) return { doc, error: "Select open paths to join" };
  let d = doc;
  const into = objs[0].id;
  let left = objs.slice(1).map((o) => o.id);
  while (left.length) {
    const a = d.objects.find((o) => o.id === into)!;
    let best: { x: End; y: End; dist: number } | null = null;
    for (const id of left) {
      const b = d.objects.find((o) => o.id === id)!;
      for (const x of endsOf(a))
        for (const y of endsOf(b)) {
          const dd = vdist(x.p, y.p);
          if (!best || dd < best.dist) best = { x, y, dist: dd };
        }
    }
    if (!best) return { doc, error: "Only open paths can be joined" };
    const r = joinNodes(d, [best.x.ref, best.y.ref]);
    if (r.error) return { doc, error: r.error };
    d = r.doc;
    // the other object is taken in (a path of it that is left stays an object of its own)
    left = left.filter((id) => id !== best!.y.ref.id);
  }
  return { doc: pruneGroups(d) };
}

/**
 * Make compound path (Ctrl+8): the paths of the selected objects become one
 * object (a fill sews the inner ones as holes), with the style of the bottom
 * one (sewn first), at its place.
 */
export function makeCompound(doc: StitchDocument, ids: string[]): { doc: StitchDocument; error?: string } {
  const objs = doc.objects.filter((o) => ids.includes(o.id) && !o.locked && !o.text);
  const no = untouchable(objs);
  if (no) return { doc, error: no };
  if (objs.length < 2) return { doc, error: "Select two or more shapes" };
  if (objs.some(isRailSatin)) return { doc, error: "Satin columns can't be combined into one path" };
  const base = objs[0];
  const paths: SubPath[] = objs.flatMap((o) => o.paths);
  const merged: DesignObject = { ...base, paths, name: base.name };
  const gone = new Set(objs.slice(1).map((o) => o.id));
  const objects = doc.objects.filter((o) => !gone.has(o.id)).map((o) => (o.id === base.id ? merged : o));
  return { doc: pruneGroups({ ...doc, objects }) };
}

/**
 * Release compound path (Ctrl+Alt+Shift+8): every path of the selected
 * objects becomes an object of its own, with the same style, in the same
 * group, in their place in stitch order.
 */
export function releaseCompound(doc: StitchDocument, ids: string[]): { doc: StitchDocument; ids: string[]; error?: string } {
  const no = untouchable(doc.objects.filter((o) => ids.includes(o.id)));
  if (no) return { doc, ids, error: no };
  const out: string[] = [];
  let changed = false;
  const objects = doc.objects.flatMap((o) => {
    if (!ids.includes(o.id) || o.locked || o.text || o.paths.length < 2 || isRailSatin(o)) {
      if (ids.includes(o.id)) out.push(o.id);
      return [o];
    }
    changed = true;
    return o.paths.map((sp, k) => {
      const id = k === 0 ? o.id : uid();
      out.push(id);
      return { ...o, id, name: k === 0 ? o.name : `${o.name} ${k + 1}`, paths: [sp], start: k === 0 ? o.start : undefined, end: undefined };
    });
  });
  if (!changed) return { doc, ids, error: "Nothing to release: select an object made of several paths" };
  return { doc: { ...doc, objects }, ids: out };
}
