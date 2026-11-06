// Keeping letterings consistent. Pure functions on design objects:
//
//  • settleTexts: a lettering whose letters no longer share one placement
//    (one letter moved, turned or scaled on its own) can't be regenerated
//    from its spec without undoing that — it becomes plain shapes.
//  • carryOver: when a lettering is regenerated (text, font, size … changed)
//    the new letters keep what was set on the old ones — their group, lock,
//    visibility, sewing commands, hidden-stitch rules, and their ids (so
//    linked clones keep following them).

import type { DesignObject, Vec2 } from "../types";
import type { TextSpec } from "./text";

// ---------------------------------------------------------------------------
// settleTexts

/** Spec fields that differ per letter of one lettering. */
const PER_MEMBER = new Set(["role", "colorIndex", "fontFill"]);

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a));
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => sameValue(x, b[i]));
  return false;
}

/** Do two letters' specs describe the same lettering (all but the per-letter fields)? */
export function sameTextSpec(a: TextSpec, b: TextSpec): boolean {
  if (a === b) return true;
  const ra = a as unknown as Record<string, unknown>;
  const rb = b as unknown as Record<string, unknown>;
  for (const k in ra) if (!PER_MEMBER.has(k) && !sameValue(ra[k], rb[k])) return false;
  for (const k in rb) if (!PER_MEMBER.has(k) && !(k in ra) && rb[k] !== undefined) return false;
  return true;
}

/**
 * Letterings whose letters no longer share one spec (e.g. one letter was
 * moved or rotated on its own) become plain shapes: their `text` is dropped
 * from every letter, as Convert to shapes does — regenerating them would
 * snap that letter back (or move the whole lettering after it). With `prev`
 * (the document before the change) only letterings with changed letters are
 * checked, so this is cheap enough for every edit. Returns `doc` itself when
 * nothing changes.
 */
export function settleTexts<D extends { objects: DesignObject[] }>(doc: D, prev?: D): D {
  if (prev && doc.objects === prev.objects) return doc;
  let check: Set<string> | null = null;
  if (prev) {
    check = new Set();
    const before = prev.objects;
    let had: Set<DesignObject> | null = null;
    for (let i = 0; i < doc.objects.length; i++) {
      const o = doc.objects[i];
      if (!o.text || before[i] === o) continue;
      had ??= new Set(before);
      if (!had.has(o)) check.add(o.text.group);
    }
    if (!check.size) return doc;
  }
  const first = new Map<string, TextSpec>();
  const broken = new Set<string>();
  for (const o of doc.objects) {
    const t = o.text;
    if (!t || (check && !check.has(t.group)) || broken.has(t.group)) continue;
    const f = first.get(t.group);
    if (!f) first.set(t.group, t);
    else if (!sameTextSpec(f, t)) broken.add(t.group);
  }
  if (!broken.size) return doc;
  return { ...doc, objects: doc.objects.map((o) => (o.text && broken.has(o.text.group) ? { ...o, text: undefined } : o)) };
}

// ---------------------------------------------------------------------------
// carryOver

/** Settings that apply to a lettering as a whole when they are the same on all its letters. */
const UNIFORM = ["ties", "forceLock", "minStitch", "minJump", "hidden", "locked"] as const;
/** Everything carried letter by letter when the letters stay the same. */
const ALL = [...UNIFORM, "start", "end", "stopAfter", "trimAfter", "visible"] as const;
type Key = (typeof ALL)[number];

/** Start / end points closer than this are the same (a regenerated lettering lands within rounding). */
const POINT_TOL = 0.2;

function norm(k: Key, v: unknown): unknown {
  if (k === "ties") return v ?? "both";
  if (k === "forceLock" || k === "stopAfter" || k === "trimAfter" || k === "locked") return !!v;
  if (k === "visible") return v !== false;
  return v ?? undefined;
}

function same(k: Key, a: unknown, b: unknown): boolean {
  const x = norm(k, a);
  const y = norm(k, b);
  if (x === y) return true;
  if (x == null || y == null) return false;
  if (k === "start" || k === "end") {
    const p = x as Vec2;
    const q = y as Vec2;
    return Math.hypot(p[0] - q[0], p[1] - q[1]) <= POINT_TOL;
  }
  if (typeof x === "number" && typeof y === "number") return Math.abs(x - y) < 1e-9;
  if (typeof x === "object") return JSON.stringify(x) === JSON.stringify(y);
  return false;
}

const get = (o: DesignObject, k: Key) => (o as unknown as Record<string, unknown>)[k];
const put = (o: DesignObject, k: Key, v: unknown) => ((o as unknown as Record<string, unknown>)[k] = v);

/**
 * Set by the user (or since it was generated): the old letter's value
 * differs from the one its own spec generates (`base`), or — without a
 * generated letter to compare — from the default.
 */
function userSet(o: DesignObject, base: DesignObject | undefined, k: Key): boolean {
  if (base && (k === "start" || k === "end")) {
    // points relative to the letter: a letter the font's metrics moved still has the font's point
    const rel = (x: DesignObject) => {
      const p = x[k];
      const q = firstPoint(x);
      return p && q ? ([p[0] - q[0], p[1] - q[1]] as Vec2) : p;
    };
    return !same(k, rel(o), rel(base));
  }
  return !same(k, get(o, k), base ? get(base, k) : undefined);
}

const firstPoint = (o: DesignObject): Vec2 | null => o.paths[0]?.nodes[0]?.p ?? null;
const kindOf = (o: DesignObject) => `${o.text?.role ?? ""}|${o.text?.colorIndex ?? ""}|${o.stitch.type}`;

/**
 * Which generated letter (`base`: the old spec laid out again) each old
 * letter is — the same part (role, colour, stitch type) nearest to it; -1
 * for none. Robust against letters reordered in the stitch order.
 */
export function matchMembers(old: DesignObject[], base: DesignObject[]): number[] {
  const free = new Map<string, number[]>();
  base.forEach((b, j) => {
    const k = kindOf(b);
    free.set(k, [...(free.get(k) ?? []), j]);
  });
  return old.map((o) => {
    const cands = free.get(kindOf(o));
    if (!cands?.length) return -1;
    const p = firstPoint(o);
    let best = 0;
    if (p) {
      let d = Infinity;
      cands.forEach((j, ci) => {
        const q = firstPoint(base[j]);
        const dj = q ? Math.hypot(p[0] - q[0], p[1] - q[1]) : Infinity;
        if (dj < d) {
          d = dj;
          best = ci;
        }
      });
    }
    return cands.splice(best, 1)[0];
  });
}

/**
 * The regenerated letters (`fresh`, from the new spec) with what was set on
 * the old letters (`old`, in stitch order). `base` is the old spec laid out
 * again — what the font and layout gave the old letters — so only the
 * user's own settings are carried, not the old font's (null: unknown, every
 * non-default value counts as the user's).
 *
 *  • the same letters (as many, e.g. only the size or colour changed): every
 *    setting letter by letter;
 *  • otherwise: settings that are the same on all old letters go to all new
 *    ones, the start point of the first letter to the first, the end point,
 *    stop and trim of the last letter to the last; hidden letters hide all;
 *  • always: the group (nested groups), and the old ids, so selections and
 *    linked clones of the letters keep working.
 */
export function carryOver(old: DesignObject[], base: DesignObject[] | null, fresh: DesignObject[]): DesignObject[] {
  const out = fresh.map((o) => ({ ...o }));
  const n = out.length;
  if (!old.length || !n) return out;
  const match = base ? matchMembers(old, base) : old.map(() => -1);
  const baseOf = (i: number) => (base && match[i] >= 0 ? base[match[i]] : undefined);
  const sameLetters = !!base && base.length === n && old.length === n && match.every((j) => j >= 0);
  if (sameLetters) {
    old.forEach((o, i) => {
      for (const k of ALL) if (userSet(o, baseOf(i), k)) put(out[match[i]], k, get(o, k));
    });
  } else {
    const first = old[0];
    const last = old[old.length - 1];
    if (userSet(first, baseOf(0), "start")) out[0].start = first.start;
    for (const k of ["end", "stopAfter", "trimAfter"] as const) if (userSet(last, baseOf(old.length - 1), k)) put(out[n - 1], k, get(last, k));
    if (!old.every((o) => o.visible)) for (const o of out) o.visible = false;
  }
  // a setting the same on every old letter (and the user's on some) applies to the whole lettering
  for (const k of UNIFORM) {
    const v = get(old[0], k);
    if (old.every((o) => same(k, get(o, k), v)) && old.some((o, i) => userSet(o, baseOf(i), k))) for (const o of out) put(o, k, v);
  }
  const group = old[0].group;
  for (const o of out) {
    if (group) o.group = group;
    else delete o.group;
  }
  // ids: the matched letter's, else the one in the same place
  const taken = new Set<number>();
  const give = (i: number, j: number) => {
    if (j < 0 || j >= n || taken.has(j)) return false;
    taken.add(j);
    out[j].id = old[i].id;
    return true;
  };
  const left: number[] = [];
  old.forEach((_, i) => {
    if (!give(i, match[i])) left.push(i);
  });
  for (const i of left) give(i, i);
  return out;
}
