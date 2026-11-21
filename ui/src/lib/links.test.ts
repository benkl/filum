// Trim / Jump / Sew / Automatic over the object's fields, and the plan's connections (npm run test:match).

import type { Connection, DesignObject, PlanData } from "../types";
import { connectionAfter, connectionAt, describeConnection, linkChoiceOf, withLinkChoice } from "./links";

let failed = 0;
const check = (ok: boolean, msg: string) => {
  if (!ok) {
    failed++;
    console.log("FAIL", msg);
  } else console.log("ok  ", msg);
};
const o = { id: "a", trimAfter: false } as DesignObject;

check(linkChoiceOf(o) === "auto", "nothing chosen: automatic");
check(linkChoiceOf(withLinkChoice(o, "sew")) === "sew" && withLinkChoice(o, "sew").link === "join", "Sew: link join");
check(withLinkChoice(o, "jump").link === "jump" && !withLinkChoice(o, "jump").trimAfter, "Jump: link jump, no trim after");
const t = withLinkChoice(withLinkChoice(o, "sew"), "trim");
check(t.trimAfter && !("link" in t) && linkChoiceOf(t) === "trim", "Trim: trim after, the link gone");
const back = withLinkChoice(t, "auto");
check(!back.trimAfter && !("link" in back), "Automatic: neither");
check(linkChoiceOf({ trimAfter: true, link: "join" }) === "trim", "trim after wins over a link, as in the engine");
const stop = withLinkChoice({ ...o, stopAfter: true }, "sew");
check(stop.stopAfter === true, "stop after is left as it is");

const conn = (kind: Connection["kind"], from: number, start: [number, number], end: [number, number], visible = false): Connection => ({ from, to: from + 1, kind, manual: false, visible, start, end });
const plan = { links: [conn("trim", 0, [0, 0], [10, 0]), conn("sew", 1, [10, 5], [10, 9], true), conn("colorChange", 2, [0, 20], [10, 20])] } as unknown as PlanData;
const doc = { objects: [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }] as DesignObject[] };
check(connectionAfter(plan, doc, "b")?.kind === "sew" && connectionAfter(plan, doc, "d") === undefined, "the connection after an object");
check(describeConnection(plan.links![0]) === "trimmed (10.0 mm gap)" && describeConnection(plan.links![1]).endsWith("and it shows"), "said in words");
check(connectionAt(plan, [5, 0.3], 0.5)?.kind === "trim" && connectionAt(plan, [5, 2], 0.5) === undefined, "hit near the line only");
check(connectionAt(plan, [5, 20], 1) === undefined, "colour changes are not offered");

console.log(failed ? `${failed} FAILED` : "all passed");
if (failed) throw new Error(`${failed} link checks failed`);
