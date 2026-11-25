# Code quality plan: less duplication, fewer hand-kept copies

A review of the whole code base (about 111,000 lines: 43,000 Rust, 59,000 TypeScript, 7,800 CSS) for code that exists twice, copies that have to be kept in step by hand, and files that grew too large to work in. This plan orders the work so each step is small, checked, and leaves the app working.

Companion documents: [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) (the whole app), [STITCH_QUALITY_PLAN.md](STITCH_QUALITY_PLAN.md).

## Rules for this work

1. **The stitches don't change.** A refactor of the engine must give byte-identical stitch plans. Phase 0 adds the test that proves it; every engine step runs it. Where a step changes output on purpose (a bug fix), it says so and updates the recorded hashes in the same change.
2. **Ink/Stitch and pystitch ports stay ports.** Code that follows Ink/Stitch (or pystitch for the machine formats) keeps its structure where merging would change results or hide where it came from: different tolerances, different end handling, a reader per file format.
3. **One step, one check.** Each step ends with `npm test` passing (cargo tests, typecheck, the UI logic tests, the wording and design checks).
4. **No new behaviour mixed in.** Bug fixes found by the review are their own steps (phase 1), not folded into a refactor.

## Phase 0 — a safety net for the engine

- [x] **Plan hashes** (`crates/core/tests/plan_hashes.rs`): a stitch plan for one object of every stitch type and method (14 fill methods, 4 satin methods, running stitch with beans, patterns and random lengths, appliqué, foam, layered 3D, ripple, gradients, cross stitch, tartan) and for designs the digitizer makes from the suite pictures. Each plan is reduced to a hash of its stitches (positions to 1 µm, flags, objects) and compared to `tests/plan_hashes/<os>.txt`. `UPDATE_PLAN_HASHES=1` records them anew. Floating point can differ in the last bit between operating systems (the maths library), so each OS keeps its own record; a missing record is written and the test passes, so CI on another OS records rather than fails.

## Phase 1 — bugs the review found

- [x] **Density legend styled by the downloads panel**: both use `.dl-head` and `.dl-bar`; the later downloads rules restyle the density bar and clip its ticks. Rename the density legend's classes (`dmap-*`).
- [x] **Layers panel menu never closes** except by choosing an item: it now closes on a click outside and on Escape (`useDismiss`, below).
- [x] **Escape in the meander picker** also clears the selection (it lets the key reach the app's handler).
- [x] **Drags that can stick**: the gradient panel's drag and the stitch-out player's resize ignore `pointercancel`.
- [x] **Layers menu "Show all" / "Unlock all"** re-implement `showAll` / `unlockAll` (which also select what they reveal) and print "Ctrl+G" on a Mac: use the shared actions and the platform's key name.
- [x] **Element Info's removed-stitch count** uses an older copy of the minimum-stitch rule than the plan (no loose turns): one `drops_short` used by both.
- [ ] **Engine defaults ≠ Ink/Stitch defaults** for fields missing from a file (satin centre walk, zigzag underlay inset; fill max stitch length, underlay inset and stitch length). *Needs a decision*: changing the engine's defaults changes how older files missing those keys sew. Until then: documented, not changed.

## Phase 2 — cheap shared building blocks

Each removes copies without changing behaviour.

- [x] **Stitch flags once**: core `plan::flags` re-exports the formats crate's `cmd` (identical values today). TS: `FLAG.COMMANDS` instead of a literal `& 31` (Bars, RebuildShapes, autoRoute); one exported `NO_OBJECT` instead of `0xffffffff` in seven places.
- [x] **`Object::new` and `Thread::new`** in `model.rs`: the ~18 full 21-field object literals and ~20 thread literals use them (`..` for the rest). A new field then touches one place.
- [x] **`lib/vec.ts`**: `sub add mul dot cross len norm lerp dist` once, instead of in about 16 files.
- [x] **Saved settings**: `loadJson(key, defaults)` and a `useStoredJson` hook in `lib/storage.ts`, and the storage keys in one table, instead of ~40 copies of "parse, merge defaults, catch".
- [~] **Popovers**: `useDismiss(open, onClose, inside)` (done: eight menus and popovers) and `placeNear(anchor, w, h)` (to do) in `components/ui.tsx` for the thread picker, match panel, meander picker, convert menu, Optimise menu and the context menus.
- [~] **`Seg`**: one segmented control in `ui.tsx` instead of four local copies (done; the ~80 inline groups move over time).
- [x] **Object updates**: `replaceObject(doc, next)` and `mapObjects(doc, ids, fn)` in lib, used by the canvas, Dock and the panels (~25 sites).
- [x] **View maths**: `lib/view.ts` with `fitBox`, `zoomAt` and `focus` (select + bring into view), used by Issues, the density legend, the player and the previews; `planBounds` with a filter instead of four rewrites.
- [x] **wasm helpers**: `opts<T>()`, `json()` and `selected()` in `crates/wasm/src/lib.rs`.

## Phase 3 — one source for what Rust and TypeScript share

- [ ] **Constants from the engine**: a small example program writes `ui/src/generated/engine-constants.ts` (flags, automatic underlay widths, stretch and delicate fabrics, centre-out fabrics, jump time, JEF hoops, thread tex table, default design options); `npm test` fails when it is stale.
- [ ] **Types from the engine**: `ts-rs` on the document, plan meta, quality, density and optimise types, generated into `ui/src/generated/`; `types.ts` extends them with the UI-only fields (references, group names, `routed`, `text`). Two drifts already exist (`contourUnderlayRepeats` only in Rust, `presetSet` only in TS).
- [ ] **Engine calls**: one typed table of operations shared by `client.ts` and `worker.ts` (JSON by default, typed arrays where needed); the plan meta as one serde struct (and `bounds`, computed and dropped today, either used or not computed).

## Phase 4 — engine helpers (guarded by the plan hashes)

- [ ] **Geometry**: one public `seg_project` / `seg_dist` in `geom.rs` (eight copies); `simplify_closed` and `chaikin_closed` in digitize call the `geom` versions; tartan's scanline uses `geom::scanline`.
- [ ] **`raster.rs`**: the distance transform, ring rasterisation, Zhang–Suen thinning and the 4/8-neighbour iterators, out of `digitize.rs`, `geom.rs`, `convert.rs` and `density.rs`.
- [ ] **Run building** in `stitches/mod.rs`: `push`, `sew_along`, `route_along` (about 19 hand-written copies), `closed`, `roll_to_vertex`, `flip_for`.
- [ ] **Running stitch**: even and bean stitching as one-value cases of the pattern versions.
- [ ] **Satin columns**: `columns`, `mean_width`, `centre_line` in `satin.rs` for satin, foam, layered 3D, ripple and convert.
- [ ] **Tatami options**: a `TatamiOpts` struct replaces the nine thread-local settings and the 13–14 argument lists.
- [ ] **Random numbers**: one `Xorshift64` in `prng.rs`.
- [ ] **Colour**: `color.rs` with `rgb_to_lab`, `de76`, `de2000` (two different functions are both called `delta_e` today).
- [ ] **SVG**: one table per enum for import and export; export split into fill, satin and running parts next to their import twins.
- [ ] **Fabrics**: limits next to the profile in `model.rs`; the centre-out set derived or its difference documented.

## Phase 5 — large files and the stylesheet

- [ ] **Canvas.tsx** (2,800 lines): the pointer handling per tool in `canvas/tools/`, hit-testing and view fitting in their own modules.
- [ ] **Dock.tsx** (2,300 lines): one component per stitch type for the stitch options; the Layers and Issues panels in their own files.
- [ ] **DigitizeDialog.tsx**: split by pane.
- [ ] **Stylesheet**: `styles.css` keeps the tokens and imports the areas in today's order; the design check reads every CSS file (and `output.css`, unchecked today) and catches `rgb()` colours; shared base classes for popovers, small icon buttons, swatches and chips; an ellipsis utility; the 12 unused selectors removed.

## Not changed, on purpose

- The hex colour parsers, `clip_to_shape` and `clip_polyline`, the per-format integer decoders: they follow different sources and differ on purpose.
- The plan-walking loops in the engine: each resets its position differently on colour changes, trims and jumps.
- The two curve flatteners (fixed steps and adaptive): merging changes output.
- The fill row generators: different algorithms.
- `digitizePresets.ts` and `inkDefaults.ts`.

## Progress

**Phase 0** (2026-11-25): `crates/core/tests/plan_hashes.rs` records 43 plans (every stitch type and method, all of them together, three digitized suite pictures) in `tests/plan_hashes/<os>.txt`; about 20 s. Every engine step since has left them unchanged.

**Phase 1** (2026-11-25): all but the engine defaults, which wait for a decision.
- The density legend's classes are `dmap-*`; its tick marks show again.
- `useDismiss` (`components/ui.tsx`) closes the Layers menu, the canvas context menu, the menu bar, the Optimise and Convert menus, the thread, chart, match and meander pickers on a click outside, and on Escape without the key going on to the app (the meander picker cleared the selection).
- `followPointer` (`components/ui.tsx`) follows five drags and ends them on `pointercancel` too.
- The Layers menu runs `showAll` / `unlockAll` and shows the platform's keys.
- `assemble::drops_short` and `loose_turns_for` decide the short stitches the plan drops and Element Info counts (a test checks that sewn and removed add up).

**Phase 2** (2026-11-25):
- Rust: `plan::flags` is the formats crate's `cmd`; `Object::new` / `Thread::new` replace 44 full literals (about 300 lines less); the wasm bridge's `opts`, `to_json`, `ids_of` and `fit_rings` replace 30 copies.
- TypeScript: `NO_OBJECT` and `FLAG.COMMANDS` instead of magic numbers; `lib/vec.ts` instead of the vector helpers in 14 files; `loadJson` / `loadMerged` (`lib/storage.ts`) for 18 of the 30 stored-settings reads (the rest check or migrate what they read); `replaceObject` / `mapObjects` (`lib/docEdit.ts`) for 21 single-object updates and a store `updateObject` for one or many objects; `lib/view.ts` (`fitBox`, `zoomAt`, `fitView`, the `View` type) and `lib/focus.ts` for the canvas, the previews, the menu's zoom, Issues and the density legend; `lib/planBounds.ts` for five copies of the stitch bounds; one `Seg`.
