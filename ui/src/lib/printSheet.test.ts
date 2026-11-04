// Print sheet (npm run test:match): per-colour counts and estimates, and the
// pages the chosen layouts make.

import { FLAG, type PlanData } from "../types";
import { blockStats, duration, jobSeconds, PRINT_DEFAULTS, sheetHtml } from "./printSheet";

let failed = 0;
const check = (ok: boolean, msg: string) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${msg}`);
  if (!ok) failed++;
};

const recs: [number, number, number][] = [
  [0, 0, FLAG.JUMP],
  [0, 0, 0],
  [1, 0, 0],
  [2, 0, 0],
  [2, 0, FLAG.TRIM],
  [2, 0, FLAG.STOP],
  [5, 5, FLAG.JUMP],
  [5, 5, 0],
  [5, 5, FLAG.TRIM],
  [5, 5, FLAG.COLOR_CHANGE],
  [9, 9, FLAG.JUMP],
  [9, 9, 0],
  [10, 9, 0],
  [10, 9, FLAG.END],
];
const plan: PlanData = {
  coords: new Float32Array(recs.flatMap(([x, y]) => [x, y])),
  flags: new Uint8Array(recs.map((r) => r[2])),
  objects: new Uint32Array(recs.length),
  threads: [
    { id: "a", name: "Red <b>", color: "#ff0000", brand: "Madeira", code: "1147" },
    { id: "b", name: "White", color: "#ffffff", brand: "", code: "" },
  ],
  stats: { stitches: 6, jumps: 3, trims: 2, colorChanges: 1, stops: 1, width: 10, height: 9, threadM: 0.03, bobbinM: 0.02, seconds: 1, threadPerColorM: [0.02, 0.01], stitchesPerColor: [4, 2] },
};
const b = blockStats(plan);
check(b.length === 2, "two colour blocks");
check(b[0].stitches === 4 && b[0].trims === 2 && b[0].stops === 1, `block 1: ${b[0].stitches} stitches, ${b[0].trims} trims, ${b[0].stops} stops`);
check(b[1].stitches === 2 && b[1].trims === 0, "block 2");
const s = { ...PRINT_DEFAULTS, spm: 600, timeTrim: 10, timeColorChange: 30, timeAdditional: 60 };
// 6 stitches at 600 spm = 0.6 s, 2 trims = 20 s, 1 colour change = 30 s, + 60 s
check(Math.abs(jobSeconds(b, s) - 110.6) < 1e-9, `job time ${jobSeconds(b, s)}`);
check(duration(3725) === "1 h 02 min" && duration(75) === "1 min 15 s" && duration(9) === "9 s", "durations");

const input = { name: "Rose", width: 10, height: 9, blocks: b, threadM: 0.03, bobbinM: 0.02, overview: "data:,", blockPictures: ["data:,", "data:,"], materials: [] };
const job = { title: "", client: "ACME & Co", purchaseOrder: "", notes: ["use the <b>red</b>", ""], date: new Date(2026, 0, 2) };
const html = sheetHtml(input, job, s);
check((html.match(/<section class="page/g) ?? []).length === 2, "operator overview and detailed view by default");
check(html.includes("ACME &amp; Co") && html.includes("use the &lt;b&gt;red&lt;/b&gt;") && html.includes("Red &lt;b&gt;"), "user text escaped");
check(html.includes("<h1>Rose</h1>"), "the design name as title");
const all = sheetHtml(input, job, { ...s, views: { clientOverview: true, clientDetailed: true, operatorOverview: true, operatorDetailed: true, pattern: true, info: true } });
check((all.match(/<section class="page/g) ?? []).length === 1 + 2 + 1 + 1 + 1 + 1, "every layout: one detailed page per colour");
check(all.includes("size: A4") || all.includes("size: letter"), "paper size");

if (failed) throw new Error(`${failed} print sheet check(s) failed`);
console.log("all passed");
