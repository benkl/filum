// Split into satins: parts from cut lines, stitch direction from direction lines (npm run test:match).

import type { DesignObject, StitchDocument, SubPath, Vec2 } from "../types";
import { segmentsCross } from "./polyline";
import { insideRings, type Line } from "./regions";
import { applySplit, overlapFor, planSplit } from "./splitSatins";

let failed = 0;
const check = (ok: boolean, msg: string) => {
  if (!ok) {
    failed++;
    console.log("FAIL", msg);
  } else console.log("ok  ", msg);
};
const near = (a: number, b: number, e = 1e-6) => Math.abs(a - b) < e;
const ring = (pts: Vec2[]): SubPath => ({ closed: true, nodes: pts.map((p) => ({ p })) });
const obj = (id: string, paths: SubPath[], extra: Partial<DesignObject> = {}): DesignObject =>
  ({
    id,
    name: id,
    thread: "t",
    visible: true,
    locked: false,
    paths,
    stitch: { type: "fill" },
    trimAfter: false,
    stopAfter: false,
    ...extra,
  }) as unknown as DesignObject;
// an L: a bar 4 wide going down (x 0..4, y 0..20) and a foot going right (y 16..20, x 0..20)
const L = obj(
  "L",
  [
    ring([
      [0, 0],
      [4, 0],
      [4, 16],
      [20, 16],
      [20, 20],
      [0, 20],
    ]),
  ],
  { trimAfter: true },
);
const doc = (o: DesignObject[], options?: StitchDocument["options"]) => ({ objects: o, fabric: "cotton", options }) as unknown as StitchDocument;
const angleOf = (r: [Vec2[], Vec2[]], k: number) => {
  const [a, b] = [r[0][k], r[1][k]];
  return Math.abs(Math.atan2(b[1] - a[1], b[0] - a[0]) * (180 / Math.PI)) % 180;
};

// cut across the bar just above the foot; bar sewn across (horizontal), foot sewn up and down
const input = {
  id: "L",
  cuts: [
    [
      [-1, 15],
      [5, 15],
    ],
  ] as [Vec2, Vec2][],
  directions: [
    [
      [0.5, 8],
      [3.5, 8],
    ],
    [
      [12, 16.5],
      [12, 19.5],
    ],
  ] as [Vec2, Vec2][],
};
const plan = planSplit(doc([L]), input)!;
check(!!plan && plan.parts.length === 2, "one cut: two parts");
check(near(plan.overlap, 0.2), "no preset: 0.2 mm overlap");
const bar = plan.parts.find((p) => p.outline.flat().every((q) => q[1] < 15.5))!;
const foot = plan.parts.find((p) => p !== bar)!;
check(!!bar && bar.rails[0].every((_, k) => near(angleOf(bar.rails, k), 0, 1e-6)), "the bar's rungs follow its direction line (across)");
check(
  !!foot && foot.rails[0].every((q, k) => q[0] < 5 || near(angleOf(foot.rails, k), 90, 1)),
  "the foot's rungs, past the corner, follow its direction line (up and down, within 1°)",
);
check(!!foot && foot.rails[0].some((q, k) => near(q[0], 12) && near(foot.rails[1][k][0], 12)), "the direction line is a rung where it lies");
check(bar.rails[0].length === 3, "the bar: its cut, its direction line and its flat top as rungs, nothing else");
check(!bar.auto && !foot.auto && !bar.notOneColumn && !foot.notOneColumn, "both directions drawn, both one column");
// the overlap: each part reaches 0.1 mm over the cut
check(near(Math.max(...bar.outline.flat().map((p) => p[1])), 15.1), "the bar reaches 0.1 mm past the cut");
check(near(Math.min(...foot.outline.flat().map((p) => p[1])), 14.9), "the foot reaches 0.1 mm back over it");

// no direction line: across the long side, and said so
const auto = planSplit(doc([L]), { ...input, directions: [] })!;
check(
  auto.parts.every((p) => p.auto),
  "parts without a line are marked automatic",
);
const autoBar = auto.parts.find((p) => p.outline.flat().every((q) => q[1] < 15.5))!;
check(near(angleOf(autoBar.rails, 0), 0, 1e-6), "the bar sewn across its long side");

// the NOVAstitch preset's overlap
check(near(overlapFor({ fabric: "knit", options: { presetSet: "nova" } } as never), 0.4), "NOVAstitch on knit: 0.4 mm overlap");

// the document: satins in the shape's place, grouped, what followed it after the last one
const before = obj("before", [
  ring([
    [50, 0],
    [60, 0],
    [60, 10],
  ]),
]);
const after = obj("after", [
  ring([
    [70, 0],
    [80, 0],
    [80, 10],
  ]),
]);
const r = applySplit(doc([before, L, after]), input)!;
check(r.doc.objects.length === 4 && r.doc.objects[0].id === "before" && r.doc.objects[3].id === "after", "the satins where the shape was");
const sat = r.doc.objects.slice(1, 3);
check(
  sat.every((o) => o.stitch.type === "satin" && o.paths.length === 2 && o.paths[0].nodes.length === o.paths[1].nodes.length),
  "two-rail satins with as many points on each rail (rungs)",
);
check(sat[0].group !== undefined && sat[0].group === sat[1].group, "grouped together");
check(!sat[0].trimAfter && sat[1].trimAfter, "the shape's trim after goes to the last satin");
check(r.made.join() === sat.map((o) => o.id).join(), "the new satins reported");
check(planSplit(doc([L]), { ...input, id: "nope" }) === null, "no such shape: nothing");

// a curved part: a lowercase «a» (mm, y up) cut between belly and stem, as in
// the fork's test m.9; each part is a column along its outline
const arc = (c: Vec2, r: number, a0: number, a1: number, n: number): Vec2[] =>
  Array.from({ length: n + 1 }, (_, i) => {
    const a = ((a0 + ((a1 - a0) * i) / n) * Math.PI) / 180;
    return [c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)] as Vec2;
  });
const BOWL = (Math.acos(2 / 3.5) * 180) / Math.PI;
const A_OUT: Vec2[] = [
  [10, 0],
  [10, 9],
  ...arc([6, 9], 4, 0, 160, 32).slice(1),
  ...arc([6, 9], 2, 160, 0, 24),
  ...arc([6, 3.5], 3.5, BOWL, 360 - BOWL, 64),
  [8, 0],
];
const A_HOLE: Vec2[] = arc([6, 3.5], 1.8, 0, 360, 48).slice(0, -1);
const A_CUTS: Line[] = [
  [
    [7.0, 4.6],
    [7.6, 7.3],
  ],
  [
    [7.0, 2.4],
    [7.6, -0.3],
  ],
];
const letterA = obj("a", [ring(A_OUT), ring(A_HOLE)]);
const ap = planSplit(doc([letterA]), { id: "a", cuts: A_CUTS, directions: [] })!;
check(!!ap && ap.parts.length === 2 && ap.parts.every((p) => !p.notOneColumn), "the «a»: two columns");
const shapeOf = (r: [Vec2[], Vec2[]]) => [...r[0], ...[...r[1]].reverse()];
const holds = (r: [Vec2[], Vec2[]], q: Vec2) => insideRings([shapeOf(r)], q);
const aBelly = ap.parts.find((p) => holds(p.rails, [3.3, 3.5]));
const aStem = ap.parts.find((p) => p !== aBelly);
check(!!aBelly && !!aStem && holds(aStem.rails, [5, 11.5]) && holds(aStem.rails, [9, 8]), "the belly, and the arch and stem as one column");
let tried = 0;
let hit = 0;
for (let x = 0.0123; x < 10.5; x += 0.1)
  for (let y = 0.0171; y < 13.5; y += 0.1) {
    if (!insideRings([A_OUT, A_HOLE], [x, y])) continue;
    tried++;
    if (ap.parts.some((p) => holds(p.rails, [x, y]))) hit++;
  }
check(hit / tried >= 0.99, `the columns cover ${((100 * hit) / tried).toFixed(2)} % of the «a» (≥ 99 %)`);
/** The largest angle between a rung and the square to the middle line, a column width away from the ends. */
const worstLean = ([a, b]: [Vec2[], Vec2[]]) => {
  const mid = a.map((p, k) => [(p[0] + b[k][0]) / 2, (p[1] + b[k][1]) / 2] as Vec2);
  const along = [0];
  for (let k = 1; k < mid.length; k++) along.push(along[k - 1] + Math.hypot(mid[k][0] - mid[k - 1][0], mid[k][1] - mid[k - 1][1]));
  const total = along[along.length - 1];
  const ws = a.map((p, k) => Math.hypot(b[k][0] - p[0], b[k][1] - p[1])).sort((x, y) => x - y);
  const width = ws[Math.floor(ws.length / 2)];
  let worst = 0;
  let n = 0;
  for (let k = 0; k < a.length; k++) {
    const r: Vec2 = [b[k][0] - a[k][0], b[k][1] - a[k][1]];
    const w = Math.hypot(r[0], r[1]);
    if (w < 0.3 || along[k] < width || along[k] > total - width) continue;
    let i = k;
    while (i > 0 && along[k] - along[i] < width / 2) i--;
    let j = k;
    while (j < a.length - 1 && along[j] - along[k] < width / 2) j++;
    const t: Vec2 = [mid[j][0] - mid[i][0], mid[j][1] - mid[i][1]];
    const tl = Math.hypot(t[0], t[1]);
    if (tl < 1e-6) continue;
    worst = Math.max(worst, 90 - (Math.acos(Math.min(1, Math.abs((t[0] * r[0] + t[1] * r[1]) / (tl * w)))) * 180) / Math.PI);
    n++;
  }
  return { worst, n };
};
for (const [p, name] of [
  [aBelly, "belly"],
  [aStem, "arch and stem"],
] as const) {
  if (!p) continue;
  const [r0, r1] = p.rails;
  let railCross = 0;
  for (let i = 1; i < r0.length; i++) for (let j = 1; j < r1.length; j++) if (segmentsCross(r0[i - 1], r0[i], r1[j - 1], r1[j])) railCross++;
  let rungCross = 0;
  for (let k = 1; k < r0.length; k++) if (segmentsCross(r0[k - 1], r1[k - 1], r0[k], r1[k])) rungCross++;
  check(!railCross && !rungCross, `${name}: rails and rungs do not cross (${railCross}, ${rungCross})`);
  const { worst, n } = worstLean(p.rails);
  check(n > 20 && worst <= 15, `${name}: ${n} rungs within 15° of square to the column (worst ${worst.toFixed(1)}°)`);
  const out = r0.filter(
    (q, k) => Math.hypot(r1[k][0] - q[0], r1[k][1] - q[1]) > 0.05 && !insideRings([A_OUT, A_HOLE], [(q[0] + r1[k][0]) / 2, (q[1] + r1[k][1]) / 2]),
  ).length;
  check(!out, `${name}: every rung inside the «a» (${out} outside)`);
}
// a direction line is a rung of the belly where it lies
const DIR: Line = [
  [2.7, 3.3],
  [4.0, 3.5],
];
const ad = planSplit(doc([letterA]), { id: "a", cuts: A_CUTS, directions: [DIR] })!;
const b2 = ad.parts.find((p) => holds(p.rails, [3.3, 3.5]));
const want = Math.atan2(DIR[1][1] - DIR[0][1], DIR[1][0] - DIR[0][0]);
const offDeg = (p: Vec2, q: Vec2) => {
  const d = (((((Math.atan2(q[1] - p[1], q[0] - p[0]) - want) * 180) / Math.PI) % 180) + 180) % 180;
  return Math.min(d, 180 - d);
};
const best = b2
  ? Math.min(
      ...b2.rails[0].map((p, k) =>
        Math.hypot((p[0] + b2.rails[1][k][0]) / 2 - 3.35, (p[1] + b2.rails[1][k][1]) / 2 - 3.4) < 0.6 ? offDeg(p, b2.rails[1][k]) : Infinity,
      ),
    )
  : NaN;
check(best < 0.5, `the direction line is a rung of the belly (${best.toFixed(2)}° off)`);

console.log(failed ? `${failed} FAILED` : "all passed");
if (failed) throw new Error(`${failed} split checks failed`);
