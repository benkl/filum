// Nested groups (npm run test:match).

import type { DesignObject } from "../types";
import { chainOf, commonGroup, copiedParents, selectedUnits, topGroupOf, unitOf } from "./groups";

let failed = 0;
const check = (ok: boolean, msg: string) => {
  if (!ok) {
    failed++;
    console.log("FAIL", msg);
  } else console.log("ok  ", msg);
};
const obj = (id: string, group?: string) => ({ id, group, name: id, thread: "t", visible: true, locked: false, paths: [], stitch: { type: "running" } }) as unknown as DesignObject;

// "in" (b, c) sits in "out" (with d); a stands alone
const doc = { objects: [obj("a"), obj("b", "in"), obj("c", "in"), obj("d", "out")], groupParents: { in: "out" } };
check(chainOf(doc, "in").join() === "in,out", "a group's chain runs outwards");
check(topGroupOf(doc, doc.objects[1]) === "out", "the outermost group of an object");
check(unitOf(doc, doc.objects[1]).join("") === "bcd", "a click selects the outermost group");
check(unitOf(doc, doc.objects[0]).join("") === "a", "an object outside groups is its own unit");
const u = selectedUnits(doc, new Set(["b", "c"]));
check(u.groups.join() === "in" && !u.objects.length, "the inner group selected whole is one unit");
const v = selectedUnits(doc, new Set(["b", "c", "d"]));
check(v.groups.join() === "out", "the outer group selected whole is the unit, not the inner one");
const w = selectedUnits(doc, new Set(["b"]));
check(!w.groups.length && w.objects[0].id === "b", "an object picked inside a group is a unit of its own");
check(commonGroup([["in", "out"], ["out"]]) === "out" && commonGroup([["in", "out"], ["x"]]) === undefined, "the deepest group around everything");
const re = (g: string) => `new-${g}`;
check(JSON.stringify(copiedParents(doc, [doc.objects[1]], re)) === JSON.stringify({ "new-in": "new-out" }), "copies keep their nesting under new ids");
check(chainOf({ objects: [], groupParents: { x: "y", y: "x" } }, "x").join() === "x,y", "a loop in the parents doesn't hang");

console.log(failed ? `${failed} FAILED` : "all passed");
if (failed) throw new Error(`${failed} group checks failed`);
