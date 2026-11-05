# Filum implementation plan

Filum is a cross-platform machine-embroidery editor built around Ink/Stitch: its algorithms, its SVG dialect and its thread charts. The engine is written in Rust; the editor is a web UI shared by the browser, desktop and mobile builds.

This document covers:
- what Filum builds on
- the architecture and why it was chosen
- what is already built (v0.1)
- the phased plan to a complete, stitching-focused tool

The companion [ALGORITHMS_RESEARCH.md](ALGORITHMS_RESEARCH.md) lists stitching algorithms that Ink/Stitch does not have yet, with sources.

---

## 1. Inputs

### 1.1 Ink/Stitch (github.com/inkstitch/inkstitch, GPL-3.0)
- **How it's built:** an Inkscape extension written in Python (shapely, networkx, numpy, wxPython, inkex). Designs are SVG files. Stitch parameters live on elements as `inkstitch:*` attributes in the `http://inkstitch.org/namespace` namespace.
- **Core modules studied:**
  - `lib/stitches/running_stitch.py`: Zhao–Saalfeld "sleeve" curve fitting, even stitch distribution, splitting at corners, bean stitch.
  - `lib/elements/satin_column/*`: rails and rungs, `plot_points_on_rails` with perpendicular spacing correction, pull/push compensation, short-stitch inset, centre-walk/contour/zig-zag underlay, E-, S- and zig-zag methods.
  - `lib/stitches/fill.py` and `tatami_fill.py`: grating intersection, `adjust_stagger`, run grouping, travel graph with underpath.
  - `lib/stitch_plan/*`: colour blocks, lock stitches, trims and jumps.
  - Palettes: more than 60 GIMP `.gpl` thread charts.
- **Weak spots for a modern tool:**
  - It depends on Inkscape, so there is no standalone app, mobile or web version.
  - Stitch previews are slow (Python plus shapely).
  - No raster auto-digitizing.
  - No global order optimisation.
  - Appliqué and multi-hoop are manual workflows.

### 1.2 The editor
The window, top to bottom: a menu bar with quick icons (save, undo, redo), a title bar (design name, saved state, fabric and hoop presets, Optimise, Export), a context bar for the current tool or selection, a tool rail, the canvas (cm rulers centred on the hoop, grid, the hoop outline, a floating Vector / Stitch / Realistic switch), docked layers and properties panels, and a bottom bar (thread swatches in sew order, Fit, zoom presets, stitch count and run time, Animate, Video). Light and dark themes.

---

## 2. Architecture

```
┌──────────────────────────────── ui/ (React + TypeScript + Vite) ───────────────────────────────┐
│ MenuBar · TitleBar · ContextBar · ToolRail · Canvas (2D renderer + tools) · Dock · BottomBar   │
│ zustand store (document, selection, undo/redo, view) ── engine client (latest-wins RPC)        │
└───────────────────────────────────────────┬────────────────────────────────────────────────────┘
                                            │ postMessage (JSON in, typed arrays out)
                         ┌──────────────────▼──────────────────┐
                         │ Web Worker: filum-wasm         │   same code in every target
                         └──────────────────┬──────────────────┘
        ┌───────────────────────────────────▼──────────────────────────────────────┐
        │ crates/core  (filum-core)                                            │
        │  model · geom (scanline, EDT offsets, contours) · stitches/{running,     │
        │  satin, fill} · assemble (cache, ties, trims, colour changes) · optimize │
        │  · svg (Ink/Stitch import/export) · digitize (raster→objects) · io        │
        └───────────────┬───────────────────────────────────────────┬───────────────┘
                        │                                           │
        ┌───────────────▼──────────────┐              ┌─────────────▼─────────────┐
        │ crates/formats               │              │ crates/cli (`filum`) │
        │ DST PES PEC JEF EXP VP3 XXX  │              │ convert · info · digitize │
        │ CSV — std-only, wasm-safe    │              │ · optimize · formats      │
        └──────────────────────────────┘              └───────────────────────────┘
  src-tauri/ (Tauri 2): native window + dialog/fs plugins + native export command
  → Windows · macOS · Linux desktop, and iOS · Android through Tauri mobile
```

### Why these choices
- **One Rust engine compiled to WebAssembly and run inside the UI.** The browser build, the desktop app and the mobile apps run the same code, and stitch output is identical everywhere. The CLI and the Tauri backend link the same crate natively for batch work.
- **Tauri 2 rather than Electron:** a small binary, the system webview, one codebase for desktop and mobile, and Rust on the native side.
- **React with a hand-written Canvas2D renderer:**
  - A dense desktop-style editor interface is fastest to build in HTML/CSS.
  - The canvas draws stitches from typed arrays sent by the worker, so the main thread never blocks.
  - A wgpu/WebGPU renderer is planned (Phase 3) for 3D thread shading.
- **Per-object caching:**
  - The engine hashes each object's geometry, parameters and the fabric. Editing one object only regenerates that object.
  - Assembly (ties, trims, colour changes) is cheap and runs on every edit.
  - The UI coalesces plan requests so the latest edit wins.
- **Units:** millimetres throughout, y axis pointing down (as in SVG). Machine files are centred on the hoop when written.
- **Licence:** GPL-3.0-or-later, required because the stitch algorithms are ports from Ink/Stitch. The file encoders are ported from Ink/Stitch's pystitch (MIT) with attribution.

### How Filum builds on Ink/Stitch
1. **Algorithm ports** (Python → Rust):
   - running stitch: sleeve fitting and corner splitting
   - satin: rails/rungs model, `plot_points_on_rails`, underlays, compensation, satin/E/S/zig-zag methods
   - tatami: grating, staggers, run grouping, travel inside the shape, pull compensation, gradient row spacing
2. **SVG dialect compatibility:**
   - Import reads `inkstitch:satin_column`, `fill_method`, `angle`, `row_spacing_mm`, `max_stitch_length_mm`, `staggers`, `fill_underlay*`, `stroke_method`, `running_stitch_length_mm`, `bean_stitch_repeats`, `repeats`, `zigzag_spacing_mm`, `pull_compensation_*`, the `*_underlay*` flags, `trim_after` and `stop_after`.
   - Export writes the same attributes, so a design can go Filum → Inkscape + Ink/Stitch → Filum. A `filum:params` attribute keeps the round trip lossless for features Ink/Stitch lacks.
3. **Thread charts:** Ink/Stitch's `.gpl` palettes are bundled and parsed natively (`threads::parse_gpl`). The UI offers "Match to chart" using CIE Lab ΔE.
4. **Planned:**
   - An optional "Ink/Stitch parity" mode that calls an installed `inkstitch` CLI on the exported SVG, so stitch plans can be compared side by side (regression oracle; see §6).
   - Importing Ink/Stitch lettering fonts. They are SVG glyph libraries with pre-digitized satins and are distributed separately from the main repository.

---

## 3. What exists today (v0.1)

### Engine (`crates/core`, 29 unit and integration tests)
- [x] Document model: bezier sub-paths, threads, hoop, fabric, machine settings; serde JSON.
- [x] Geometry:
  - polyline utilities, Douglas–Peucker, mitred offsets, even-odd scanline
  - exact Euclidean distance transform (Felzenszwalb) for robust inset/outset and contour levels
  - crack-following contour tracer
- [x] **Running / bean / repeat** (Ink/Stitch port).
- [x] **Satin column:**
  - two rails with rungs, or equal node counts acting as rungs
  - automatic rail reversal
  - extension: a single centre line plus a width
  - underlays: centre-walk, contour, zig-zag
  - pull compensation in mm and %
  - short-stitch inset; splitting long stitches
  - methods: satin, E-stitch, S-stitch, zig-zag
- [x] **Tatami fill:**
  - staggers, gradient row spacing, pull compensation, underlay at a relative angle with inset
  - boustrophedon sections visited greedily
  - travel under the shape, or along the outline if that fails
- [x] **Contour** and **spiral** fills, using EDT inset levels with spiral blending.
- [x] **New fills:**
  - **radial sunburst**: density-preserving ray start radii
  - **Hilbert curve** texture
  - **TSP stipple**: Bridson Poisson-disk sampling, then nearest neighbour + 2-opt, kept inside the shape
- [x] **Plan assembly:** tie-in/tie-off, trims above a distance threshold, colour changes, trim/stop-after commands, minimum stitch length.
- [x] **Statistics:** stitches, jumps, trims, colour changes, size, top and bobbin thread length, run time, per-colour breakdown.
- [x] **Fabric profiles** (cotton, polyester, denim, knit, sheer, felt, towel, cap). Each adjusts pull compensation, density and underlay.
- [x] **Global order optimiser:** a stacking-aware DAG, then a topological sort that minimises colour changes, with nearest-neighbour travel inside each colour.
- [x] **Ink/Stitch SVG** import/export with a lossless round trip.
- [x] **Auto-digitizer:**
  - Lab k-means with over-clustering and Ward merge
  - anti-aliasing fringe removal, specks merged into neighbours
  - contour vectorisation
  - automatic stitch type: running for hairlines, **medial-axis satin** (Zhang–Suen skeleton, longest path) for strokes, tatami at the PCA angle for areas
  - colour-grouped ordering
  - about 100 ms for a 640×480 image
- [x] **Formats** (`crates/formats`, 31 tests, checked against Ink/Stitch's pystitch): DST, PES (v1 + PEC), PEC, JEF, EXP, VP3 and XXX read and write; CSV write-only. DST, EXP and XXX are byte-identical to pystitch.

### Editor (`ui/`)
- [x] Editor shell, light and dark themes, autosave, undo/redo (100 steps).
- [x] Tools:
  - select with move/scale/rotate handles, marquee, shift-constrain
  - node editing with mirrored handles (Alt breaks the mirror)
  - pan, ruler
  - pen with corners and curves
  - freehand that auto-closes into a fill
  - satin centre-line tool
  - rectangle, ellipse
  - lettering (opentype.js, three bundled OFL fonts, user TTF/OTF)
- [x] Views: vector, stitch (needle points when zoomed in), realistic (shaded thread on a fabric texture), jumps and underlay toggles.
- [x] Layers: drag to reorder, rename, show/hide, up/down, per-object thumbnails. Scene tab with hoop, fabric and design statistics.
- [x] Properties panel: transform, thread picker, every stitch parameter, trim/stop commands.
- [x] Stitch-out animation with a scrubber; WebM video export of the stitch-out.
- [x] Fabric calibration: a measured swatch (two fill discs, two satin bars) sets the pull compensation, column-end pull-in and fill expand new objects start from, per fabric on the device.
- [x] Stitch-out player: a timeline of the colour blocks (trims, stops, thread changes), machine-time clock, playback speeds, follow the needle, block-by-block stepping.
- [x] Dialogs:
  - Export: format grid, statistics, hoop overflow warning
  - Auto-digitize: presets, size with aspect lock and fit-to-hoop, editable colour list (coverage, hide/eyedropper, recolour, lock/merge, thread charts), fill method/density/angle/underlay, satin and running toggles, satin or running outline around fills, cleanup controls, and Original / Colours / Stitches (realistic) / Shapes previews with live stitch count and run time
  - Lettering
  - Thread colours: match to Madeira, Isacord, Brother, Janome, Robison-Anton, Gunold, Marathon or DMC
  - Machine settings, production sheet with print, shortcuts, about
- [x] Drag and drop: SVG, images (opens the digitizer), embroidery files, `.filum` projects.
- [x] Interactive Ink/Stitch tools on the canvas: fill angle dial with row preview and density handle, radial centre, satin width handles and direction arrow, start/end pins (Ink/Stitch commands, honoured by the engine), live stitch preview of the selection, Cutter (split paths exactly at a point, cut fills along a line), Troubleshoot panel with canvas markers and one-click fixes, density map.
- [x] Satin drawing tool: live column and zig-zag preview, click for corners / drag for curves, per-point width via scroll or [ ] (tapered columns become two-rail satins with node rungs), Shift angle snap, close by clicking the first point.

### Shells
- [x] Browser (static build).
- [x] Tauri 2 desktop with native dialogs, filesystem, a native export command and file associations.
- [ ] iOS/Android: configuration is ready (`tauri android init` / `tauri ios init`) but untested.

---

## 4. Roadmap

### Phase 1: Ink/Stitch parity (6–8 weeks)
| Item | Notes |
|---|---|
| Guided fill, meander (tile library), ripple stitch, circular fill, linear-gradient fill, tartan | Port from `lib/stitches/*`. Meander tiles ship as SVG in Ink/Stitch's `tiles/` folder. |
| Graph-based tatami | Port `build_fill_stitch_graph` and `find_stitch_path` (Eulerian traversal over grating plus outline) to remove the remaining short travel lines. Use `petgraph`. |
| Auto-route satin and running | Port `auto_satin.py` and `auto_run.py` (minimum spanning tree plus jumps hidden under later stitching). |
| Lettering with Ink/Stitch fonts | Read `fonts/*/→.svg` glyph layers and `font.json` kerning. Glyphs come pre-digitized as satin columns. |
| Commands | Visual start/end/fill-start/ignore markers like Ink/Stitch's command symbols. |
| Clones, groups, boolean ops | Boolean ops via `i_overlay` (union, difference, knockdown). |
| Satin editing | Rung tool, split satin, convert stroke ↔ satin, fill → satin. |
| Parity oracle | CI job that runs Ink/Stitch's CLI on reference SVGs and compares stitch counts and Hausdorff distance against Filum. |

### Phase 2: features Ink/Stitch lacks (8–10 weeks)
These are the research items marked P1/P2 (see [ALGORITHMS_RESEARCH.md](ALGORITHMS_RESEARCH.md)).
1. **Medial-axis satin for vectors** (#13): `centerline` / `boostvoronoi` skeleton, branch graph, satins with mitred joints.
2. **Connected Fermat spirals** (#6): continuous spirals for narrow and branching shapes.
3. **Appliqué wizard** (#25): placement line, stop, tack-down, stop, cover satin, plus a cut file (SVG/DXF).
4. **Multi-hoop splitting** (#29) with registration marks and overlap.
5. **Anisotropic fabric compensation** (#20): push and pull along and across the stitch direction, per fabric profile.
6. **Chinese-postman redwork** (#18): duplicate the minimum set of edges instead of every edge.
7. **Programmable fills and carving stamps** (#11); **direction-field / Perlin hatching** (#3, #8).
8. **Thread-weight aware density** (#23); **3D puff mode** (#15, #27); **sequins** (#26, DST sequin flags).
9. **Photo stitch:** weighted-Voronoi stippling (#4) from greyscale images.

### Phase 3: production quality (6 weeks)
- **GPU realistic renderer:**
  - wgpu (native) and WebGPU (browser)
  - instanced thread ribbons with Kajiya–Kay sheen and depth stacking (#24)
  - fabric normal maps, turntable
- Density heatmap and an automatic "problem finder": too dense, too short, gaps, long jumps, satins over 12 mm.
- Machine profiles: hoops, maximum stitch, trim method, colour sequence. Per-format options such as PES version, DST extended header and JEF hoop code.
- Thread inventory and per-job costing (#22). Customer-facing PDF production sheet.
- Split the WASM engine across threads (`wasm-bindgen-rayon`) to plan several objects in parallel.

### Phase 4: platforms and ecosystem
- Mobile layouts: touch tools, pinch zoom (already supported), a bottom-sheet dock. Release builds for iOS and Android.
- Plugin API: `rhai` scripts or WASM components that receive a "pen as needle" interface (#35).
- Optional cloud sync and sharing of a realistic preview link.

---

## 5. Engineering plan

### 5.1 Repository layout
```
crates/core        engine (GPL)          crates/formats   file formats (no deps, wasm-safe)
crates/wasm        wasm-bindgen API      crates/cli       `filum` command line
src-tauri          Tauri 2 shell         ui               React UI (shared by web, desktop, mobile)
docs               plans & research
```

### 5.2 Performance budgets
| Operation | Budget | Today |
|---|---|---|
| Edit one object, then redraw | < 50 ms for an object under 10k stitches | about 10–60 ms (cached assembly) |
| Re-plan everything (fabric change) | < 1.5 s for 20k stitches (WASM) | 1.3 s; target 0.4 s once offsets switch to analytic (i_overlay) for simple shapes |
| Auto-digitize 640 px image | < 500 ms | about 100 ms native, about 220 ms WASM |
| Stitch view with 50k stitches | 60 fps pan/zoom | Path2D per colour block, cached |

### 5.3 Testing strategy
- **Unit tests** per generator: geometry invariants (stitches inside the shape, maximum stitch length, density), satin pair spacing, tatami jump count on shapes with holes.
- **Integration tests:**
  - document → plan → every machine format → re-import (`tests/end_to_end.rs`)
  - Ink/Stitch SVG → DST
  - digitizer determinism
- **Format conformance:** round trips plus byte comparison with pystitch (Ink/Stitch) output (already done for DST, EXP and XXX).
- **Parity oracle** with Ink/Stitch (Phase 1).
- **UI:** typecheck in CI; Playwright smoke tests for each tool (draw → object exists → plan has stitches → export bytes).
- **Golden images** for the realistic renderer once the GPU renderer exists.

### 5.4 Risks
| Risk | Mitigation |
|---|---|
| Rare self-intersecting artwork breaks the scanline fill | Inputs are even-odd; switch to `i_overlay` simplification before filling; fuzz with random polygons. |
| PES compatibility across machines | Add PES v6 writing (with object sections) after v1; test on real Brother/Babylock machines. |
| Satin input topology is messy (open/closed rails, crossing rungs) | Port Ink/Stitch's validation warnings and show them in the UI. |
| WASM memory on mobile | Cap the distance-field size (done), stream plan buffers, release cached runs on low memory. |
| GPL obligations | The whole app is GPL-3.0-or-later; ported files keep their attribution headers. |

---

## 6. Build and run

```bash
# prerequisites: Rust stable + wasm32-unknown-unknown target, wasm-bindgen-cli 0.2.130, Node 20+
npm --prefix ui install
npm run wasm                  # build the engine to ui/src/wasm/pkg
npm run dev                   # browser at http://localhost:1420
npm run desktop:dev           # native window (Tauri)
npm run desktop:build         # installers for the current OS
cargo test --workspace --exclude filum-desktop
cargo run -p filum-cli -- convert design.svg design.pes
```
