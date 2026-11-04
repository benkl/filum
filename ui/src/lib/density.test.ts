// Density map (npm run test:match): the colour scales follow the fabric's
// limits, thin covering fills show blue, and the readout finds the cell.

import { classShares, colorAt, densityAt, densityPixels, densityScale, modeValue } from "./density";
import type { DensityField, FabricLimits } from "../types";

let failed = 0;
const check = (ok: boolean, msg: string) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${msg}`);
  if (!ok) failed++;
};

const cotton: FabricLimits = { gsm: 130, holesHeavy: 10, holesMax: 17, layersHeavy: 2, layersMax: 3, layersMin: 0.8, stiffRatio: 1 };
const silk: FabricLimits = { ...cotton, gsm: 70, holesHeavy: 6, holesMax: 11, layersHeavy: 1.5, layersMax: 2.2, stiffRatio: 1.5 };

const c = densityScale("coverage", cotton);
const g = colorAt(c, 1);
const r = colorAt(c, 3.2);
check(g[1] > g[0] && g[3] > 0.2, "one layer is green");
check(r[0] > r[1] && r[3] > 0.6, "past the fabric's maximum is red");
check(colorAt(c, 0)[3] === 0, "nothing is transparent");
check(c.ticks.some((t) => t.v === 1) && c.ticks.some((t) => t.v === 3), "coverage marks 1 layer and the maximum");
// the same 2.4 layers: heavy on cotton, past the maximum on silk
const s = densityScale("coverage", silk);
check(colorAt(s, 2.4)[1] < colorAt(c, 2.4)[1], "silk judges the same stitches denser");
check(densityScale("holes", cotton).ticks.map((t) => t.v).join() === "10,17", "needle holes: the common tiers on cotton");

// a 3 × 1 field: thin, ok, risk
const f: DensityField = {
  x0: 0,
  y0: 0,
  cell: 1,
  cols: 3,
  rows: 1,
  layers: new Float32Array([0.3, 1, 3.5]),
  holes: new Float32Array([2, 6, 20]),
  added: new Float32Array([20, 65, 260]),
  cls: new Uint8Array([1, 2, 4]),
  limits: cotton,
  stats: { area: 3, thin: 1, ok: 1, heavy: 0, risk: 1, maxLayers: 3.5, maxHoles: 20, maxAdded: 260, meanAdded: 115, topM: 1, bobbinM: 0.3 },
  hotspots: [],
};
const px = densityPixels(f, "coverage");
check(px[2] > px[0] && px[2] > px[1], "thin cells are blue");
check(px[4 * 2] > px[4 * 2 + 1], "risk cells are red");
check(densityPixels(f, "holes")[2] < densityPixels(f, "holes")[1], "needle holes have no thin colour");
check(Math.abs(modeValue(f, "stiffness", 1) - 0.5) < 1e-6, "stiffness: added weight over the fabric's weight");
const at = densityAt(f, [2.5, 0.5]);
check(!!at && at.cls === 4 && at.holes === 20, "readout of the cell under the pointer");
check(densityAt(f, [5, 0.5]) === null, "no readout outside");
const sh = classShares(f.stats);
check(Math.abs(sh.risk - 1 / 3) < 1e-9 && Math.abs(sh.thin + sh.ok + sh.heavy + sh.risk - 1) < 1e-9, "class shares add up");

if (failed) throw new Error(`${failed} density check(s) failed`);
