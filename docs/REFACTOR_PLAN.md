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
- [x] **Engine defaults ≠ Ink/Stitch defaults** for fields missing from a file (satin centre walk, zigzag underlay inset; fill max stitch length, underlay inset and stitch length). Decided: a setting a document leaves out gets Ink/Stitch's value (`FillParams::ink`, `SatinParams::ink` as the serde defaults); `Default` stays Filum's own for objects the engine makes (the digitizer); new objects in the editor keep Ink/Stitch's table plus the measured deviations. The plan hashes of the test objects (which leave settings out) were recorded anew.

## Phase 2 — cheap shared building blocks

Each removes copies without changing behaviour.

- [x] **Stitch flags once**: core `plan::flags` re-exports the formats crate's `cmd` (identical values today). TS: `FLAG.COMMANDS` instead of a literal `& 31` (Bars, RebuildShapes, autoRoute); one exported `NO_OBJECT` instead of `0xffffffff` in seven places.
- [x] **`Object::new` and `Thread::new`** in `model.rs`: the ~18 full 21-field object literals and ~20 thread literals use them (`..` for the rest). A new field then touches one place.
- [x] **`lib/vec.ts`**: `sub add mul dot cross len norm lerp dist` once, instead of in about 16 files.
- [x] **Saved settings**: `loadJson(key, defaults)` and a `useStoredJson` hook in `lib/storage.ts`, and the storage keys in one table, instead of ~40 copies of "parse, merge defaults, catch".
- [x] **Popovers**: `useDismiss(open, onClose, inside)` for eight menus and popovers, `placeNear(anchor, w, opts)` for five placements (the shared `Menu` keeps its own, with its submenus' left fallback) in `components/ui.tsx` for the thread picker, match panel, meander picker, convert menu, Optimise menu and the context menus.
- [x] **`Seg`**: one segmented control in `ui.tsx` instead of four local copies; 43 of the 81 hand-written groups use it. The other 38 are toolbars of icon actions, or groups whose buttons each disable, compute their state or carry an icon: kept as they are.
- [x] **Object updates**: `replaceObject(doc, next)` and `mapObjects(doc, ids, fn)` in lib, used by the canvas, Dock and the panels (~25 sites).
- [x] **View maths**: `lib/view.ts` with `fitBox`, `zoomAt` and `focus` (select + bring into view), used by Issues, the density legend, the player and the previews; `planBounds` with a filter instead of four rewrites.
- [x] **wasm helpers**: `opts<T>()`, `json()` and `selected()` in `crates/wasm/src/lib.rs`.

## Phase 3 — one source for what Rust and TypeScript share

- [x] **Constants from the engine**: `crates/core/tests/engine_constants.rs` writes `ui/src/generated/engine.ts` (flags, the no-object marker, jump time, per fabric: stretch, delicate, automatic underlay widths, centre out, limits; thread tex; the design options' defaults) and fails while it is stale. The JEF hoops stay in `machines.ts` (names and frames are the editor's; the sizes are pystitch's).
- [x] **Types from the engine**: `ts-rs` (a dev-dependency, derived in tests only) writes `ui/src/generated/engine-types.ts` from 83 serde types (`crates/core/src/engine_types.rs`, failing while stale). `ui/src/lib/engineTypes.check.ts` compares 60 of the editor's types with them: a field or choice on one side only fails the typecheck, by name; the editor's own fields are listed with their pair. The two drifts are fixed: the engine keeps `presetSet` (`PresetSet`), the editor knows `contourUnderlayRepeats`. `types.ts` keeps its own interfaces (richer docs, optional fields the editor fills in); moving them onto the generated ones is left for when a type is touched anyway.
- [x] **Engine calls**: the worker's operations are one table (`OPS`, JSON by default); the client calls them by `EngineOp`, so an unknown name doesn't compile; the editor's plan runs in the client's latest-wins lane instead of a copy of it; the plan meta is spread as it comes and no longer carries the unused `bounds`.

## Phase 4 — engine helpers (guarded by the plan hashes)

- [x] **Geometry**: `geom::seg_project` / `seg_dist` for eight copies; digitize's ring helpers are `geom::simplify_ring` / `chaikin_ring`; `geom::scanline_spans` for tartan's scanline; `geom::closed` for two copies.
- [ ] **`raster.rs`**: not done. The two distance transforms differ in precision (`f32` in `geom.rs`, which automatic underlay's widths come from; `f64` in the digitizer), so merging them changes stitches; the helpers other modules borrow from `digitize.rs` are only used behind the same `digitize` feature, so moving them would only relocate code.
- [x] **Run building** in `stitches/mod.rs`: `push` (three copies) and `sew_along` (eleven loops); `flip_for` for the start/end decision of lines and of fills. Tartan's and decor's loops push without the duplicate check and stay.
- [x] **Running stitch**: even and bean stitching are the one-value cases of the pattern versions.
- [x] **Satin columns**: `satin::columns` and `mean_width` for satin, foam, layered 3D and the region code (the centre lines differ in spacing and stay).
- [x] **Tatami options**: `TatamiOpts`, passed explicitly, replaces seven thread-local settings that the fill set and reset by hand (and that guided rows, blended rows and the knockdown inherited silently). The start pin (set per object by assembly) and the random split (a scoped closure) stay. The plan hashes gained a case for each setting first, recorded before the change.
- [x] **Random numbers**: `prng::Xorshift64` for three copies (the gradient's hash differs from `prng::uniform` by a constant and stays, so its patterns don't move).
- [x] **Colour**: the two `delta_e`s are `threads::delta_e76` (RGB) and `vision::delta_e2000` (Lab). The digitizer's lookup-table conversion stays (speed).
- [x] **SVG**: one name table per enum for six of them (guided strategy, satin method, rail reverse, ripple axis and guide position, locks), read and written through it, with a round-trip test. Fill method and cross kind map several values to one name and read prefixes: they stay. Splitting `export_svg` is left for Phase 5.
- [x] **Fabrics**: `FabricLimits` and `Fabric::limits` next to the profile in `model.rs`; the centre-out set is `optimize::center_out_by_default`, read by the editor from the generated constants. Also: `offset_rings` lost its unused resolution argument (and the code computing it).

## Phase 5 — large files and the stylesheet

- [x] **Canvas.tsx** (2,800 → 1,450 lines): the gestures in `canvas/gestures/` (transform, gradient, pen and node, drawing, handles), each with what a press starts, what a move does and what the release does; the component hands them its refs and helpers as one typed `CanvasCtx` (`canvas/ctx.ts`). Hit testing (`hit.ts`), the drag kinds (`drag.ts`), overlays (`overlays.ts`) and the view on resize and its captures (`viewport.ts`) are modules of their own. Checked by a recording of 26 real pointer gestures with every tool (document, selection, view after each), identical before and after every step.
- [x] **Dock.tsx** (2,300 lines): split into `Dock.tsx` (the design and properties panels, 390 lines), `LayersPanel.tsx`, `IssuesPanel.tsx` and `StitchOptions.tsx`. `StitchOptions` hands one bundle of edit helpers to one component per stitch type (fill, satin, zig-zag line, running, appliqué, manual); screenshots match.
- [x] **DigitizeDialog.tsx**: its state and actions are one hook (`useDigitize`, its return type the panes' prop type), the dialog a 200-line shell, and each pane a component of its own (style, colours, shapes, lines, crosses, stitches, AI). Screenshots of every pane with a picture loaded, and the design it adds, match before and after.
- [~] **Stylesheet**: `styles.css` is the ordered list of 33 files in `styles/` (tokens first, then base and the areas in the order they had); the production build still ships one file. The design check reads them all and `output.css` (22 raw values there, now tokens) and catches `rgb()` colours (40, now tokens: swatch outlines and shading, scrims, the digitizer's marks). The 12 unused selectors (21 rules) and an undefined `var(--warn)` are gone. Screenshots of twelve views before and after match but for the swatch outlines' transparency (several near-equal values became one token). To do: shared base classes for popovers, small icon buttons, swatches and chips; an ellipsis utility.

## Not changed, on purpose

- The hex colour parsers, `clip_to_shape` and `clip_polyline`, the per-format integer decoders: they follow different sources and differ on purpose.
- The plan-walking loops in the engine: each resets its position differently on colour changes, trims and jumps.
- The two curve flatteners (fixed steps and adaptive): merging changes output.
- The fill row generators: different algorithms.
- `digitizePresets.ts` and `inkDefaults.ts`.

## Progress

**Phase 0** (2026-11-25): `crates/core/tests/plan_hashes.rs` records 43 plans (every stitch type and method, all of them together, three digitized suite pictures) in `tests/plan_hashes/<os>.txt`; about 20 s. Every engine step since has left them unchanged.

**Phase 1** (2026-11-25): done; the engine defaults as decided above.
- The density legend's classes are `dmap-*`; its tick marks show again.
- `useDismiss` (`components/ui.tsx`) closes the Layers menu, the canvas context menu, the menu bar, the Optimise and Convert menus, the thread, chart, match and meander pickers on a click outside, and on Escape without the key going on to the app (the meander picker cleared the selection).
- `followPointer` (`components/ui.tsx`) follows five drags and ends them on `pointercancel` too.
- The Layers menu runs `showAll` / `unlockAll` and shows the platform's keys.
- `assemble::drops_short` and `loose_turns_for` decide the short stitches the plan drops and Element Info counts (a test checks that sewn and removed add up).

**Phase 2** (2026-11-25):
- Rust: `plan::flags` is the formats crate's `cmd`; `Object::new` / `Thread::new` replace 44 full literals (about 300 lines less); the wasm bridge's `opts`, `to_json`, `ids_of` and `fit_rings` replace 30 copies.
- TypeScript: `NO_OBJECT` and `FLAG.COMMANDS` instead of magic numbers; `lib/vec.ts` instead of the vector helpers in 14 files; `loadJson` / `loadMerged` (`lib/storage.ts`) for 18 of the 30 stored-settings reads (the rest check or migrate what they read); `replaceObject` / `mapObjects` (`lib/docEdit.ts`) for 21 single-object updates and a store `updateObject` for one or many objects; `lib/view.ts` (`fitBox`, `zoomAt`, `fitView`, the `View` type) and `lib/focus.ts` for the canvas, the previews, the menu's zoom, Issues and the density legend; `lib/planBounds.ts` for five copies of the stitch bounds; one `Seg`.

**Phase 2, rest, and Phase 3** (2026-11-25):
- Engine defaults as decided (phase 1).
- `placeNear` and `Seg` for 43 groups (`Seg` takes on/off choices, no current choice, extra classes and a style).
- Constants and types generated from the engine, the editor's types checked against them, the engine calls in one table.

**Phase 4** (2026-11-25): the engine helpers above, every step with the plan hashes and a hash of the Koi's whole plan (with and without Avoid holes and Hide travel) bit-identical. Not done: `raster.rs` (see above), one spatial grid type (six grids whose queries differ in small ways), one stitch-path loop for tatami and circular (they keep different runs).

**Phase 5, first part** (2026-11-25): Dock split in four, the stylesheet split by area with the design check over every file. Then the stitch options per stitch type. Still to do: the canvas's pointer handling per tool, the digitizer dialog by pane, the shared base classes in the stylesheet, `export_svg` by stitch type.
