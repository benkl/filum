// A .filum project: numbers with at most six decimals, nothing else changed.
import type { StitchDocument } from "../types";
import { projectJson, tidyNumber } from "./projectFile";

function ok(c: unknown, msg: string) {
  if (!c) throw new Error(msg);
  console.log("ok  ", msg);
}

ok(tidyNumber(11.399999999999999) === 11.4, "computing noise is taken away");
ok(tidyNumber(0.1234567) === 0.123457 && tidyNumber(-2.0000004) === -2, "six decimals at most, rounded");
ok(tidyNumber(42) === 42 && tidyNumber(4294967295) === 4294967295, "whole numbers (seeds) stay as they are");
ok(Object.is(tidyNumber(-0.0000001), 0), "no -0");

const doc = {
  version: 2,
  name: "x 1.0000001",
  objects: [{ id: "a", paths: [{ closed: true, nodes: [{ p: [10.000000000000002, 1 / 3] }] }], stitch: { type: "fill", angle: 45.00000000001, seed: 7 } }],
} as unknown as StitchDocument;
const back = JSON.parse(projectJson(doc));
ok(back.name === "x 1.0000001", "text is untouched");
ok(back.objects[0].paths[0].nodes[0].p[0] === 10 && back.objects[0].paths[0].nodes[0].p[1] === 0.333333, "coordinates are tidied");
ok(back.objects[0].stitch.angle === 45 && back.objects[0].stitch.seed === 7, "parameters are tidied, whole ones kept");
ok(projectJson(doc).length < JSON.stringify(doc, null, 1).length, "the file is smaller");

