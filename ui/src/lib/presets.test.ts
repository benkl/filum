// Presets: hoops, machine profiles and settings, frames, JEF hoop codes,
// materials and stitch default sets (npm run test:match).

import { defaultFill, defaultRunning, defaultSatin } from "./geometry";
import { HOOPS, hoopIndex, hoopOf } from "./hoops";
import { areaFits, currentPreset, exportChecks, INKSTITCH_DEFAULTS, jefHoop, MACHINES, machineById, pickFrame, presetById, FILUM_DEFAULTS } from "./machines";
import { FABRICS, inHoop, threadWeightInfo } from "./materials";
import { defaultValues, matchesSet, setChanges } from "./stitchDefaults";
import type { PlanStats, StitchParams } from "../types";

let failed = 0;
const check = (ok: boolean, msg: string) => {
  console.log((ok ? "ok   " : "FAIL ") + msg);
  if (!ok) failed++;
};
const unique = (xs: string[]) => new Set(xs).size === xs.length;

// hoops
check(unique(HOOPS.map((h) => h.name)), "hoop preset names are unique");
check(HOOPS[hoopIndex({ name: "Janome SQ20 200 × 200 mm", width: 200, height: 200 })].name === "Janome SQ20 200 × 200 mm", "same-size hoops: the named one is kept");
check(HOOPS[hoopIndex({ name: "old name", width: 60, height: 20 })].name.startsWith("Brother S"), "renamed preset still found by size");
check(hoopIndex({ name: "?", width: 145, height: 255 }) === -1, "a rectangle does not match the Bernina oval");
const oval = HOOPS[hoopIndex({ name: "?", width: 145, height: 255, shape: "oval" })];
check(oval?.name === "Bernina Large oval 145 × 255 mm" && hoopOf(oval).shape === "oval", "oval preset keeps its shape");
check(inHoop({ name: "", width: 100, height: 100, shape: "oval" }, 50, 2) && !inHoop({ name: "", width: 100, height: 100, shape: "oval" }, 5, 5), "points in a round hoop");

// machine profiles and settings presets
check(unique(MACHINES.map((m) => m.id)), "machine ids are unique");
check(MACHINES.every((m) => m.id === "doc" || m.formats.length > 0), "every machine reads a format");
check(currentPreset({ ...FILUM_DEFAULTS }).preset?.id === "filum", "new designs hold the Filum default");
check(currentPreset({ ...INKSTITCH_DEFAULTS }).preset?.id === "inkstitch", "Ink/Stitch values are recognised");
const pr10 = presetById("brother-pr10")!;
check(pr10.values.spm === 1000 && pr10.values.colorChangeSeconds === 4, "multi-needle: rated speed, automatic colour change");
check(currentPreset({ ...pr10.values, profile: pr10.id, spm: 600 }).modified, "an edited preset shows as edited");
check(presetById("brother-m380d")!.values.spm === 400, "M380D: 400 spm embroidery");

// frames
const prof = machineById("brother-pr10");
check(pickFrame(prof, { width: 120, height: 50 })?.name === "Large 18 × 13 cm", "flat designs get a flat frame, not the cap frame");
check(pickFrame(prof, { width: 350, height: 350 })?.name === "Jumbo frame 36 × 36 cm", "a special frame when only it fits");
const round = { name: "Ø100", width: 100, height: 100, shape: "oval" };
check(areaFits(round, 80, 80, (w) => 40 / (w / 2)) && !areaFits(round, 80, 80), "round frames: by the stitches, else by the corners");

// JEF hoop codes (pystitch get_jef_hoop_size)
check(
  [[40, 40], [120, 100], [130, 190], [190, 190], [220, 150]].map(([w, h]) => jefHoop(w, h).name.split(" ")[0]).join() === "C,A,B,SQ20,110",
  "JEF hoop codes follow pystitch",
);
const stats = { stitches: 1000, width: 220, height: 150, colorChanges: 0 } as PlanStats;
const jef = exportChecks({ machine: machineById("doc"), frame: null, format: "jef", stats, hoop: { name: "x", width: 300, height: 300 }, outsideHoop: false, machineFormat: true, distinctColours: 1 });
check(jef.some((c) => c.id === "jef" && c.level === "warn"), "JEF over 200 × 200 mm warns about the 110 × 110 code");

// materials
check(FABRICS.every((f) => f.backing && f.topping && f.needle), "every fabric has backing, topping and needle");
check(FABRICS.filter((f) => f.confidence !== "agreed").every((f) => !!f.note), "disputed advice says why");
check(threadWeightInfo(undefined).weight === 40 && threadWeightInfo(60).minText === 3, "thread weights: No. 40 default, No. 60 letters from 3 mm");

// stitch default sets
const satin = { type: "satin", ...defaultSatin() } as StitchParams;
check(matchesSet("filum", satin) && !matchesSet("inkstitch", satin), "satin: Filum default is not Ink/Stitch's");
check(setChanges("inkstitch", satin).includes("centre-walk underlay off"), "Ink/Stitch satin has no centre-walk underlay");
const fill = { type: "fill", ...defaultFill() } as StitchParams;
check(defaultValues("inkstitch", fill)?.maxStitchLength === 4, "Ink/Stitch tatami: 4 mm stitches");
check(defaultValues("inkstitch", { ...fill, method: "radial" } as StitchParams) === null, "no Ink/Stitch set for fills it lacks");
const run = { type: "running", ...defaultRunning() } as StitchParams;
check(matchesSet("filum", run) && matchesSet("inkstitch", run), "running stitch: both sets agree");

console.log(failed ? `${failed} FAILED` : "all passed");
if (failed) throw new Error(`${failed} preset checks failed`);
