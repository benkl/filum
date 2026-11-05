// Auto-digitize presets and quick controls (npm run test:match).

import {
  backdropOf,
  backdropPatch,
  DETAIL,
  detailOf,
  DIGITIZE_DEFAULTS,
  DIGITIZE_PRESETS,
  migrateSettings,
  outlinesOf,
  outlinesPatch,
  presetOf,
  presetSettings,
  type Backdrop,
  type Detail,
  type Outlines,
} from "./digitizePresets";

let failed = 0;
const check = (ok: boolean, msg: string) => {
  console.log((ok ? "ok   " : "FAIL ") + msg);
  if (!ok) failed++;
};

check(new Set(DIGITIZE_PRESETS.map((p) => p.id)).size === DIGITIZE_PRESETS.length, "preset ids are unique");
check(DIGITIZE_PRESETS.length <= 6, "a handful of presets, not a wall of them");
for (const p of DIGITIZE_PRESETS) {
  const s = presetSettings(p.id);
  check(presetOf(s) === p.id, `${p.label}: its own settings are recognised as it`);
  check(Object.keys(p.opts).every((k) => k in DIGITIZE_DEFAULTS), `${p.label}: only known options`);
}
// a preset starts from the defaults: nothing leaks from the last one
const drawn = presetSettings("drawing", { photoAngle: 30 });
check(drawn.outlineLineMm === 0 && drawn.backgroundScope === "outside" && drawn.outline === "none", "line art: no even outlines, no enclosed fills, no border");
check(drawn.photoAngle === 30, "a kept option the preset does not set stays");
check(DIGITIZE_PRESETS.every((p) => p.opts.backgroundScope !== undefined), "every preset says what happens to the background");
// logo: even satin outlines, enclosed areas stitched, routed
const logo = presetSettings("logo");
check(outlinesOf(logo) === "even" && logo.outlineLineMm >= 0.8, "logo: outlines as even satin");
check(backdropOf(logo) === "enclosed", "logo: every enclosed area is stitched");
check(logo.routeLines, "logo: outlines routed as one network");
check(detailOf(logo) === "normal", "logo: normal detail");

// quick controls round-trip
for (const o of ["off", "drawn", "even"] as Outlines[]) check(outlinesOf({ ...logo, ...outlinesPatch(o, 1.5) }) === o, `outlines ${o} round-trips`);
check({ ...logo, ...outlinesPatch("even", 0.3) }.outlineLineMm >= 0.8, "an even outline is at least a sewable satin");
for (const d of Object.keys(DETAIL) as Detail[]) check(detailOf({ ...logo, ...DETAIL[d] }) === d, `detail ${d} round-trips`);
check(detailOf({ ...logo, smoothing: 5 }) === null, "a changed detail setting shows as custom");
for (const b of ["fabric", "enclosed", "all"] as Backdrop[]) check(backdropOf({ ...logo, ...backdropPatch(b) }) === b, `background ${b} round-trips`);
// a changed quick control leaves the preset
check(presetOf({ ...logo, ...DETAIL.fine }) === null, "logo with fine detail is custom");

// old saved settings load
const old = migrateSettings({ colors: 9, fillDirection: "flow" } as never);
check(old.colors === 9 && old.fillMethod === "flow" && old.fillDirection === "axis" && old.routeLines === true && old.outlineLineMm === 0, "old settings: the flow direction becomes a flow fill, new options default");

console.log(failed ? `${failed} FAILED` : "all passed");
if (failed) throw new Error(`${failed} digitize preset checks failed`);
