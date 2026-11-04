// Thread lists (npm run test:match): lines without colours are matched by
// catalogue number in a chart, as Ink/Stitch's "other thread list".

import { matchCatalog, needsChart } from "./threadList";

let failed = 0;
const check = (ok: boolean, msg: string) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${msg}`);
  if (!ok) failed++;
};

const chart = [
  { code: "1147", color: "#C8102E", name: "Red", brand: "Madeira Rayon" },
  { code: "1800", color: "#000000", name: "Black", brand: "Madeira Rayon" },
  { code: "1147", color: "#ff0000", name: "Duplicate", brand: "Madeira Rayon" },
];
const entries = [
  { color: null, name: "", code: "", brand: "", tokens: ["Madeira", "1147", "red"] },
  { color: "#00ff00", name: "Green", code: "", brand: "", tokens: [] },
  { color: null, name: "", code: "", brand: "", tokens: ["9999"] },
  { color: null, name: "", code: "", brand: "", tokens: ["1800"] },
];
check(needsChart(entries), "a list without colours needs a chart");
const m = matchCatalog(entries, chart);
check(m[0].color === "#c8102e" && m[0].name === "Red" && m[0].code === "1147", `catalogue number found: ${m[0].color} ${m[0].name}`);
check(m[1].color === "#00ff00" && m[1].name === "Green", "a colour on the line wins");
check(m[2].color === null, "unknown numbers stay without colour");
check(m[3].color === "#000000", "second line matched");
check(!needsChart([{ color: "#123456", name: "", code: "", brand: "" }]), "a list with colours needs no chart");

if (failed) throw new Error(`${failed} thread list check(s) failed`);
console.log("all passed");
