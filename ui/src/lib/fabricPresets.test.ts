// Fabric presets: off by default, Filum's and NOVAstitch's values per fabric,
// the calibration on top, and putting them on a design's objects (npm run test:match).

import type { DesignObject, Fabric, StitchDocument, StitchParams, SubPath } from "../types";
import { INK_SATIN, INK_TATAMI } from "./inkDefaults";
import { applyPresetToObjects, newObjectDefaults, objectsOffPreset, presetValues } from "./fabricPresets";

let failed = 0;
const check = (ok: boolean, msg: string) => {
  if (!ok) {
    failed++;
    console.log("FAIL", msg);
  } else console.log("ok  ", msg);
};
const near = (a: unknown, b: number) => typeof a === "number" && Math.abs(a - b) < 1e-6;
const line: SubPath = { closed: false, nodes: [{ p: [0, 0] }, { p: [20, 0] }] };
const satin = (width: number): StitchParams => ({ type: "satin", method: "satin", width, swapRails: false, reverse: false, ...INK_SATIN }) as StitchParams;
const tatami = (): StitchParams => ({ type: "fill", method: "tatami", angle: 0, ...INK_TATAMI }) as StitchParams;
const obj = (id: string, stitch: StitchParams, extra: Partial<DesignObject> = {}): DesignObject =>
  ({ id, name: id, thread: "t", visible: true, locked: false, paths: [line], stitch, trimAfter: false, stopAfter: false, ...extra }) as DesignObject;
const docOf = (fabric: Fabric, presetSet?: "filum" | "nova", objects: DesignObject[] = []) =>
  ({ version: 1, objects, threads: [], fabric, hoop: { name: "", width: 100, height: 100 }, options: presetSet ? { presetSet } : undefined }) as unknown as StitchDocument;

// off by default: Ink/Stitch's values, no pull compensation
check(JSON.stringify(newObjectDefaults(docOf("knit"), {})) === "{}", "no preset: new objects keep Ink/Stitch's values");
check(near(newObjectDefaults(docOf("knit"), { satin: { pullComp: 0.3 } }).satin?.pullComp, 0.3), "no preset: a calibration still gives its pull compensation");

// Filum
const f = newObjectDefaults(docOf("knit", "filum"), {});
check(near(f.satin?.pullComp, 0.35) && f.satin?.centerWalk === true, "Filum on knit: satins 0.35 mm pull compensation, centre-walk underlay");
check(near(f.fill?.pullComp, 0.15) && near(f.fill?.rowSpacing, 0.4), "Filum on knit: fills 0.15 mm, 0.4 mm rows");
check(near(newObjectDefaults(docOf("cotton", "filum"), {}).satin?.pullComp, 0.2), "Filum on cotton: 0.2 mm on satins");
check(!("rowSpacing" in presetValues("filum", "cotton", { ...tatami(), method: "contour" } as StitchParams)), "Filum: row spacing only on tatami");

// NOVAstitch
const n = newObjectDefaults(docOf("knit", "nova"), {});
check(near(n.satin?.pullComp, 1) && n.satin?.contourUnderlay === true && near(n.satin?.contourInset, 0.5), "NOVAstitch on knit: 1 mm pull compensation, contour underlay 0.5 mm in");
check(near(n.fill?.pullComp, 1) && near(n.fill?.expand, 0.4), "NOVAstitch on knit: fills 1 mm, 0.4 mm overlap");
check(presetValues("nova", "knit", satin(1.5)).contourUnderlay === false, "NOVAstitch: no contour underlay on satins under 2 mm");
check(near(newObjectDefaults(docOf("cotton", "nova"), {}).fill?.expand, 0.2), "NOVAstitch on cotton: 0.2 mm overlap");

// the calibration on top
const c = newObjectDefaults(docOf("knit", "nova"), { satin: { pullComp: 0.4 }, fill: { pullComp: 0.3, expand: -0.1 } as never });
check(near(c.satin?.pullComp, 0.4) && near(c.fill?.pullComp, 0.3), "a calibration's pull compensation replaces the preset's");
check(near(c.fill?.expand, 0.3), "a calibration's expand adds to the preset's overlap");

// the objects already in a design
const objs = [obj("s", satin(3)), obj("t", tatami()), obj("r", { type: "running", length: 2.5, tolerance: 0.2, repeats: 1, beanRepeats: 0 } as StitchParams), obj("l", satin(3), { locked: true })];
const nova = docOf("pique", "nova", objs);
check(objectsOffPreset(nova, {}).join() === "s,t", "the satin and the fill differ from the preset; lines and locked objects don't count");
const applied = applyPresetToObjects(nova, {});
const st = (d: StitchDocument, id: string) => d.objects.find((o) => o.id === id)!.stitch as unknown as Record<string, unknown>;
check(near(st(applied, "s").pullComp, 1) && st(applied, "s").contourUnderlay === true, "applied: the satin holds the preset's values");
check(near(st(applied, "t").expand, 0.4) && near(st(applied, "t").rowSpacing, 0.25), "applied: the fill gets the overlap and keeps Ink/Stitch's rows");
check(near(st(applied, "l").pullComp, 0), "a locked object stays as it is");
check(!objectsOffPreset(applied, {}).length && applyPresetToObjects(applied, {}) === applied, "applied twice: nothing more to do");
const back = applyPresetToObjects({ ...applied, options: undefined }, {});
check(near(st(back, "s").pullComp, 0) && st(back, "s").contourUnderlay === false && near(st(back, "t").expand, 0), "back to no preset: Ink/Stitch's values again");

console.log(failed ? `${failed} FAILED` : "all passed");
if (failed) throw new Error(`${failed} fabric preset checks failed`);
