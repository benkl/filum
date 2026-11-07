// Keeping letterings consistent (npm run test:match): a lettering with one
// letter transformed on its own becomes plain shapes; a regenerated
// lettering keeps what was set on its letters.

import type { DesignObject, Vec2 } from "../types";
import type { TextSpec } from "./text";
import { carryOver, historyJump, matchMembers, sameTextSpec, setObjectsThread, settleTexts, syncTextThreads, threadSlot, transformable } from "./textSettle";

let failed = 0;
const check = (ok: boolean, msg: string) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${msg}`);
  if (!ok) failed++;
};

const spec = (group: string, p: Partial<TextSpec> = {}): TextSpec => ({
  group,
  content: "AB",
  font: "emb:test",
  size: 10,
  letterSpacing: 0,
  lineSpacing: 1,
  align: "left",
  arc: 0,
  rotation: 0,
  anchor: [0, 0],
  style: "fill",
  borderWidth: 1,
  fillAngle: 45,
  thread: "t",
  borderThread: "t",
  role: "glyph",
  ...p,
});
const letter = (id: string, x: number, p: Partial<DesignObject> = {}, t?: TextSpec): DesignObject =>
  ({
    id,
    name: id,
    thread: "t",
    visible: true,
    locked: false,
    paths: [{ closed: true, nodes: [{ p: [x, 0] }, { p: [x + 4, 0] }, { p: [x + 4, -10] }] }],
    stitch: { type: "running" },
    trimAfter: false,
    stopAfter: false,
    text: t ?? spec("g"),
    ...p,
  }) as unknown as DesignObject;

// --- settleTexts ------------------------------------------------------------------
{
  const a = letter("a", 0, {}, spec("g", { colorIndex: 0 }));
  const b = letter("b", 4, {}, spec("g", { colorIndex: 1, fontFill: "tatami" }));
  const other = letter("x", 0, {}, spec("h"));
  const plain = letter("p", 0, { text: undefined });
  const doc = { objects: [a, b, other, plain] };
  check(sameTextSpec(a.text!, b.text!), "letters differing only in colour index / font fill share one spec");
  check(settleTexts(doc) === doc && settleTexts(doc, doc) === doc, "consistent letterings: the document itself");
  // one letter moved on its own (Ctrl-click): its spec moved, the others' not
  const moved = { ...b, text: { ...b.text!, anchor: [5, 5] as Vec2 } };
  const doc2 = { objects: [a, moved, other, plain] };
  const s2 = settleTexts(doc2, doc);
  check(s2.objects[0].text === undefined && s2.objects[1].text === undefined, "a letter transformed alone: the lettering becomes plain shapes");
  check(s2.objects[2] === other && s2.objects[3] === plain, "other objects untouched");
  check(settleTexts(doc2).objects[0].text === undefined, "without the previous document every lettering is checked");
  // the whole lettering transformed: still one lettering
  const doc3 = { objects: [{ ...a, text: { ...a.text!, anchor: [5, 5] as Vec2, size: 12 } }, moved && { ...b, text: { ...b.text!, anchor: [5, 5] as Vec2, size: 12 } }, other, plain] };
  check(settleTexts(doc3, doc) === doc3, "the whole lettering transformed: stays a lettering");
  const pathed = { objects: [{ ...a, text: { ...a.text!, path: [[0, 0], [1, 1]] as Vec2[] } }, { ...b, text: { ...b.text!, path: [[0, 0], [1, 2]] as Vec2[] } }] };
  check(settleTexts(pathed).objects.every((o) => !o.text), "different paths: not one lettering");
  // only changed letterings are checked against the previous document (cheap)
  const broken = { objects: [a, moved] };
  const later = { objects: [...broken.objects, plain] };
  check(settleTexts(later, broken) === later, "unchanged letterings are not re-checked");
}

// --- matchMembers -----------------------------------------------------------------
{
  const base = [letter("1", 0), letter("2", 4), letter("3", 8)];
  const old = [letter("c", 8), letter("a", 0), letter("b", 4)];
  check(matchMembers(old, base).join() === "2,0,1", "old letters match the regenerated ones by place (reordered)");
  const fill = letter("f", 0, {}, spec("g", { role: "fill" }));
  check(matchMembers([fill], base)[0] === -1, "a part of another role has no match");
}

// --- carryOver ----------------------------------------------------------------------
{
  const base = [letter("1", 0), letter("2", 4)];
  // the user set locks on B, a stop after the lettering, and the lettering is in a group
  const old = [letter("a", 0, { group: "grp" }), letter("b", 4, { group: "grp", ties: "none", stopAfter: true })];
  // the same letters again (e.g. a new colour)
  let out = carryOver(old, base, [letter("n1", 0), letter("n2", 4)]);
  check(out[1].ties === "none" && out[1].stopAfter && out[0].ties === undefined && !out[0].stopAfter, "same letters: settings letter by letter");
  check(out.every((o) => o.group === "grp"), "the lettering stays in its group");
  check(out[0].id === "a" && out[1].id === "b", "the letters keep their ids (selection, linked clones)");
  // other text: more letters
  out = carryOver(old, base, [letter("n1", 0), letter("n2", 4), letter("n3", 8)]);
  check(out[2].stopAfter && !out[1].stopAfter, "other letters: stop after the last letter");
  check(out[0].ties === undefined && out[2].ties === undefined, "other letters: a lock set on one letter is not spread");
  check(out[0].id === "a" && out[1].id === "b" && out[2].id === "n3", "other letters: ids in place, new letters get new ones");
  // set on all letters: the whole lettering
  const all = [letter("a", 0, { minStitch: 0.8, forceLock: true, hidden: { keep: true } }), letter("b", 4, { minStitch: 0.8, forceLock: true, hidden: { keep: true } })];
  out = carryOver(all, base, [letter("n1", 0), letter("n2", 4), letter("n3", 8)]);
  check(out.every((o) => o.minStitch === 0.8 && o.forceLock && o.hidden?.keep), "the same setting on every letter applies to all new letters");
  // the font's own values are not the user's: not carried to other letters
  const fontBase = [letter("1", 0, { start: [1, -5], minStitch: 0.4 }), letter("2", 4, { start: [5, -5] })];
  const fromFont = [letter("a", 0, { start: [1, -5], minStitch: 0.4 }), letter("b", 4, { start: [5, -5] })];
  out = carryOver(fromFont, fontBase, [letter("n1", 0, { start: [2, -2] }), letter("n2", 4)]);
  check(out[0].start![0] === 2 && out[0].minStitch === undefined, "the old font's start points and settings are not carried");
  // the font's spacing changed since (Font info): the letters moved, their points with them — still the font's
  const shifted = [letter("a", 2, { start: [3, -5] }), letter("b", 6, { start: [7, -5] })];
  out = carryOver(shifted, fontBase, [letter("n1", 0, { start: [1, -5] }), letter("n2", 4, { start: [5, -5] })]);
  check(out[0].start![0] === 1 && out[1].start![0] === 5, "start points that moved with their letter are the font's");
  // a start point the user moved: carried to the first letter
  const moved = [letter("a", 0, { start: [-3, 3] }), letter("b", 4, { end: [9, 1] })];
  out = carryOver(moved, fontBase, [letter("n1", 0, { start: [2, -2] }), letter("n2", 4), letter("n3", 8)]);
  check(out[0].start![0] === -3 && out[2].end![0] === 9, "a moved start point stays on the first letter, an end point on the last");
  // locks reset to "both" on every letter override the new font's own
  const lockBase = [letter("1", 0, { ties: "none" }), letter("2", 4)];
  const reset = [letter("a", 0), letter("b", 4)];
  out = carryOver(reset, lockBase, [letter("n1", 0, { ties: "start" }), letter("n2", 4, { ties: "none" }), letter("n3", 8)]);
  check(out.every((o) => (o.ties ?? "both") === "both"), "locks set back to Both on the whole lettering stay");
  // hidden and locked letters
  out = carryOver([letter("a", 0, { visible: false }), letter("b", 4, { visible: false })], base, [letter("n1", 0), letter("n2", 4), letter("n3", 8)]);
  check(out.every((o) => !o.visible), "a hidden lettering stays hidden");
  out = carryOver([letter("a", 0, { locked: true }), letter("b", 4, { locked: true })], base, [letter("n1", 0), letter("n2", 4), letter("n3", 8)]);
  check(out.every((o) => o.locked), "a locked lettering stays locked");
  // without a regenerated old layout: every non-default value counts
  out = carryOver([letter("a", 0, { ties: "end" }), letter("b", 4, { ties: "end" })], null, [letter("n1", 0), letter("n2", 4), letter("n3", 8)]);
  check(out.every((o) => o.ties === "end"), "without the old layout, set values are kept");
  // fresh objects are not changed in place
  const fresh = [letter("n1", 0)];
  carryOver([letter("a", 0, { group: "grp" })], [letter("1", 0)], fresh);
  check(fresh[0].group === undefined && fresh[0].id === "n1", "the generated objects stay as they are");
}

// --- a lettering with a locked letter ---------------------------------------------
{
  const a = letter("a", 0, { locked: true });
  const b = letter("b", 4);
  const c = letter("c", 8);
  const shape = letter("s", 20, { text: undefined });
  const doc = { objects: [a, b, c, shape] };
  // a drag moved the unlocked letters (and a shape), not the locked one
  const nudged = (o: DesignObject) => ({ ...o, paths: o.paths.map((sp) => ({ ...sp, nodes: sp.nodes.map((n) => ({ ...n, p: [n.p[0] + 5, n.p[1]] as Vec2 })) })), ...(o.text ? { text: { ...o.text, anchor: [5, 0] as Vec2 } } : {}) });
  const moved = { objects: [a, nudged(b), nudged(c), nudged(shape)] };
  const s = settleTexts(moved, doc);
  check(s.objects.slice(0, 3).every((o) => !!o.text), "locked letter: the lettering keeps its text (none of its letters become shapes)");
  check(s.objects[1] === b && s.objects[2] === c, "locked letter: the moved letters are taken back");
  check(s.objects[3] === moved.objects[3], "locked letter: other objects still move");
  check(!!settleTexts(moved).objects[0].text === false, "without the previous document: as before (shapes)");
  // what a drag may move
  const t = transformable([b, c, shape], doc.objects);
  check(t.objects.length === 1 && t.objects[0] === shape && t.held === 1, "transformable: no letter of a lettering with a locked letter");
  const free = transformable([letter("x", 0, {}, spec("h")), letter("l", 0, { locked: true, text: undefined })], doc.objects);
  check(free.objects.length === 1 && free.held === 0, "transformable: unlocked letterings move, locked objects don't");
}

// --- lettering threads --------------------------------------------------------------
{
  // a two-colour embroidery font: glyph letters of colour 0 and 1
  const pal = (p: Partial<TextSpec> = {}) => spec("g", { palette: ["p0", "p1"], thread: "p0", ...p });
  const g0 = letter("g0", 0, { thread: "p0" }, pal({ colorIndex: 0 }));
  const g1 = letter("g1", 0, { thread: "p1" }, pal({ colorIndex: 1 }));
  const h0 = letter("h0", 4, { thread: "p0" }, pal({ colorIndex: 0 }));
  const h1 = letter("h1", 4, { thread: "p1" }, pal({ colorIndex: 1 }));
  const shape = letter("s", 20, { text: undefined, thread: "q" });
  const objs = [g0, g1, h0, h1, shape];
  check(threadSlot(g1.text!) === 1 && threadSlot(spec("g", { role: "border", style: "fillBorder" })) === "borderThread" && threadSlot(spec("g", { role: "border", style: "border" })) === "thread", "slots: palette index, border thread, main thread");
  check(threadSlot(spec("g", { colorIndex: 3 })) === "thread", "slot: a font colour without a palette thread is the main thread");
  // a mixed selection (letter g1 + the shape) given thread "n"
  const out = setObjectsThread(objs, ["g1", "s"], "n");
  check(out[4].thread === "n", "mixed selection: the shape takes the thread");
  check(out[1].thread === "n" && out[3].thread === "n", "mixed selection: every letter of that font colour takes it");
  check(out[0].thread === "p0" && out[2].thread === "p0", "mixed selection: the other font colour stays");
  check(out.slice(0, 4).every((o) => o.text?.palette?.[1] === "n" && o.text.palette[0] === "p0" && o.text.thread === "p0"), "mixed selection: the lettering's palette keeps the colour for the next layout");
  check(settleTexts({ objects: out }, { objects: objs }).objects.every((o, i) => i === 4 || !!o.text), "mixed selection: still one lettering");
  // main and border threads of an outline font
  const fill = letter("f", 0, { thread: "t" }, spec("k", { style: "fillBorder", role: "fill", borderThread: "b" }));
  const border = letter("b", 0, { thread: "b" }, spec("k", { style: "fillBorder", role: "border", borderThread: "b" }));
  const ob = setObjectsThread([fill, border], ["b"], "n");
  check(ob[0].thread === "t" && ob[0].text?.thread === "t" && ob.every((o) => o.text?.borderThread === "n"), "border letter: the spec's border thread changes, the fill stays");
  const of = setObjectsThread([fill, border], ["f", "b"], "n");
  check(of.every((o) => o.thread === "n" && o.text?.thread === "n" && o.text.borderThread === "n"), "fill and border picked: both spec threads change");
  // threads given from outside (a thread list)
  const listed = objs.map((o) => (o.id === "g0" || o.id === "h0" ? { ...o, thread: "z" } : o));
  const r = syncTextThreads(listed);
  check(r.shapes === 0 && r.objects.slice(0, 4).every((o) => o.text?.palette?.[0] === "z"), "thread list: one new thread per font colour goes into the spec");
  const split = objs.map((o) => (o.id === "g0" ? { ...o, thread: "z" } : o));
  const rs = syncTextThreads(split);
  check(rs.shapes === 1 && rs.objects.slice(0, 4).every((o) => !o.text) && rs.objects[0].thread === "z", "thread list: one font colour split in two: the lettering becomes shapes, colours kept");
  check(syncTextThreads(split, new Set(["other"])).objects === split, "only the named letterings are looked at");
  check(syncTextThreads(objs).objects === objs, "nothing to change: the same objects");
}

// --- history jumps (an edit generated while the font loads) ------------------------
{
  const [d0, d1, d2] = [{ n: 0 }, { n: 1 }, { n: 2 }];
  const st = (doc: object, past: object[], future: object[] = [], filePath: string | null = null) => ({ doc, past, future, filePath });
  const p0 = [d0];
  const now = st(d1, p0);
  check(!historyJump(now, st(d2, [...p0, d1])), "an edit (commit) is no jump");
  check(!historyJump(now, st(d2, p0)), "a live edit is no jump");
  check(!historyJump(now, st(d1, [...p0, d1])), "a checkpoint is no jump");
  check(!historyJump(st(d1, [...p0, d1]), st(d1, p0)), "a checkpoint taken back is no jump");
  check(historyJump(now, st(d0, [], [d1])), "undo is a jump");
  check(historyJump(st(d0, [], [d1]), st(d1, [d0], [])), "redo is a jump");
  check(historyJump(now, st(d1, [])), "the history cleared (a design opened) is a jump");
  check(historyJump(now, st(d2, [...p0, d1], [], "other.filum")), "another file is a jump");
}

console.log(failed ? `${failed} FAILED` : "all passed");
if (failed) throw new Error(`${failed} lettering settle checks failed`);
