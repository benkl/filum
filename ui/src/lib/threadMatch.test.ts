// Thread matching checks: npm run test:match (bundled with esbuild, run in Node).

import { lab, deltaE } from "./colorMath";
import { DEFAULT_MATCH, MATCH_PRESETS, solveMatch, rankCandidates, type MatchOptions, type MatchThread } from "./threadMatch";

const e = (color: string, code: string) => ({ name: code, code, color, brand: "Test", lab: lab(color) });
let failed = 0;
const check = (ok: boolean, msg: string) => {
  console.log((ok ? "ok   " : "FAIL ") + msg);
  if (!ok) failed++;
};
const opts = (p: Partial<MatchOptions>): MatchOptions => ({ ...DEFAULT_MATCH, fabricAware: false, ...p });
const preset = (id: string) => opts(MATCH_PRESETS.find((x) => x.id === id)!.opts);
const T = (id: string, need: string, weight = 1): MatchThread => ({ id, need, weight });

// a small chart: one pink, one rose far away, reds, blues, greys
const chart = [e("#e3d6c2", "beige"), e("#f2a3b6", "pink"), e("#c2185b", "rose"), e("#d32f2f", "red"), e("#8e1b1b", "darkred"), e("#1e4fb0", "blue"), e("#909090", "grey60"), e("#9e9e9e", "grey65"), e("#f6f1ea", "cream"), e("#111111", "black")];
const pinks = [T("a", "#f4a7b9", 3), T("b", "#e78aa0", 1)];

// faithful: both pinks on the one close pink
const f = solveMatch(pinks, chart, opts({}));
check(f.pick.get("a")!.entry.code === "pink" && f.pick.get("b")!.entry.code === "pink", "faithful: two pinks share the nearest pink");
check(f.shared.length === 1, "faithful: the shared spool is reported");

// distinct: one spool per colour; the heavier thread keeps the close pink
const u = solveMatch(pinks, chart, opts({ unique: true }));
check(u.pick.get("a")!.entry.code !== u.pick.get("b")!.entry.code, "distinct: different spools");
check(u.pick.get("a")!.entry.code === "pink", "distinct: the heavier thread keeps the best spool");

// minimum separation
const dn = deltaE(lab("#f4a7b9"), lab("#e78aa0"));
const minSep = Math.floor(dn);
const sep = solveMatch(pinks, chart, opts({ minSeparation: minSep }));
const ds = deltaE(sep.pick.get("a")!.entry.lab, sep.pick.get("b")!.entry.lab);
check(ds >= minSep, `separation: originals ${dn.toFixed(1)} apart, spools ${ds.toFixed(1)} apart (≥ ${minSep})`);
const loose = solveMatch(pinks, chart, opts({ minSeparation: Math.ceil(dn) + 2 }));
check(loose.pick.get("a")!.entry.code === loose.pick.get("b")!.entry.code, "separation: colours already closer than the minimum may share");

// budget: three colours, two spools
const three = [T("r", "#d0302e", 2), T("dr", "#901c1c", 1), T("bl", "#1f50b2", 2)];
const bud = solveMatch(three, chart, opts({ budget: 2 }));
const used = new Set([...bud.pick.values()].map((c) => c.entry.code));
check(used.size === 2 && used.has("blue"), `budget: 2 spools (${[...used].join(", ")})`);

// locks: a locked thread keeps its spool, the others avoid it under "distinct"
const locked = solveMatch([{ ...T("a", "#f4a7b9"), locked: true, current: e("#c2185b", "rose") }, T("b", "#c3195c")], chart, opts({ unique: true }));
check(locked.pick.get("a")!.entry.code === "rose", "lock: kept");
check(locked.pick.get("b")!.entry.code !== "rose", "lock: respected by distinct");

// light-to-dark order: a lighter need never gets the darker spool
const greys = [T("g1", "#8f8f8f"), T("g2", "#9a9a9a")];
const ord = solveMatch(greys, [e("#9c9c9c", "light"), e("#959595", "mid")], opts({ unique: true, keepLightOrder: true }));
check(ord.pick.get("g1")!.entry.lab[0] <= ord.pick.get("g2")!.entry.lab[0], "light order kept");

// fabric: a spool almost the fabric colour is avoided for a cream need
const fab = solveMatch([T("c", "#f3eee6")], chart, opts({ fabricAware: true, fabricMinDelta: 8 }), { fabric: "#f6f1ea" });
check(fab.pick.get("c")!.entry.code !== "cream", `fabric-aware: avoids the fabric colour (${fab.pick.get("c")!.entry.code})`);

// vivid: between a dull and a saturated candidate at similar distance, vivid picks the saturated one
const vchart = [e("#c96a5a", "dull"), e("#e8553f", "vivid")];
const faithfulPick = solveMatch([T("o", "#d8634f")], vchart, opts({})).pick.get("o")!.entry.code;
const vividPick = solveMatch([T("o", "#d8634f")], vchart, preset("vivid")).pick.get("o")!.entry.code;
check(vividPick === "vivid", `vivid prefers saturation (faithful: ${faithfulPick}, vivid: ${vividPick})`);

// candidates: sorted by cost, with metrics
const cands = rankCandidates("#f4a7b9", chart, opts({}), {}, 3);
check(cands.length === 3 && cands[0].entry.code === "pink" && cands[0].cost <= cands[1].cost, "candidates ranked");

// neighbour contrast: touching colours keep contrast
const cchart = [e("#f2a3b6", "pink"), e("#e07f97", "pink2"), e("#c2185b", "rose")];
const cneeds = [T("x", "#f4a7b9", 3), T("y", "#ea98ab", 1)];
check(solveMatch(cneeds, cchart, opts({})).pick.get("y")!.entry.code === "pink", "contrast setup: faithful merges the two");
const ctr = solveMatch(cneeds, cchart, opts({ keepContrast: true }), { neighbours: [["x", "y"]] });
check(ctr.pick.get("x")!.entry.code !== ctr.pick.get("y")!.entry.code, "neighbour contrast: touching colours not merged");

console.log(failed ? `${failed} FAILED` : "all passed");
if (failed) throw new Error(`${failed} thread-matching checks failed`);
