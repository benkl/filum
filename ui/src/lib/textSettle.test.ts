// Keeping letterings consistent (npm run test:match): a lettering with one
// letter transformed on its own becomes plain shapes; a regenerated
// lettering keeps what was set on its letters.

import type { DesignObject, Vec2 } from "../types";
import type { TextSpec } from "./text";
import { carryOver, matchMembers, sameTextSpec, settleTexts } from "./textSettle";

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

console.log(failed ? `${failed} FAILED` : "all passed");
if (failed) throw new Error(`${failed} lettering settle checks failed`);
