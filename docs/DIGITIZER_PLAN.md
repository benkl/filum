# Auto-digitizer and stitch speed: findings and plan

November 2026. This covers what we found about the auto-digitizer (how clean its files are out of the box, where the process is weak) and about stitch calculation speed, what has been done, and what comes next, in order. It follows the main [implementation plan](IMPLEMENTATION_PLAN.md).

How it was measured:
- **Digitizer quality:** the visual suite (`cargo run --release -p filum-core --example digitize_suite -- crates/core/tests/suite <out>`) reports stitches per cm², trims, colour blocks, short and long stitches, density layers, colour difference, gaps and spill for each test picture. Every preset was run on every picture.
- **Speed:** `cargo run --release -p filum-core --features prof --example plan_bench -- crates/core/tests/suite --phases` times the cold plan, the cached plan, a re-plan after a small edit and the per-edit work of the editor, with a stitch hash so speed-ups can be shown not to change a single stitch.

---

## 1. Where things stood

### 1.1 A logo with outlines did not digitize cleanly

A typical cartoon logo was the test: thin black outlines, white faces inside them, a narrow coloured strip between two outlines, and short brush dashes. At 90 mm wide the default settings:
- **Lost the strip.** It was found as a line, merged with the outlines on both sides into one blob too wide for a line, and dropped together with its pixels.
- **Left the white faces open.** An area enclosed by a single shape counts as a hole that shows the fabric.
- **Sewed the 0.9 mm outlines as single running stitch.**
- **Needed 23 trims and 6 colour blocks** for 4 threads.

### 1.2 Ten presets that overlapped
Several presets differed only in one or two settings: Cartoon was Logo with edge outlines, Patch was Logo with a border, Sketch was Line art with a drawing on top. Others were not presets at all: Zig-zag photo is a different output, and Stipple art is just a fill type. On the wrong kind of picture they gave poor files:
- Logo on thin line art spills thread far past the lines.
- Pixel art on a JPEG badge makes 284 trims.

### 1.3 Stitch calculation had slowed down
- **Gradient groups:** every colour traced the full set of shared rows, so an n-colour gradient traced them n times.
- **Hidden-stitch removal:** it was quadratic over objects even when everything was cached.
- **The editor:** it planned the whole design up to three times per edit while hidden stitching was on.
- **Tatami (an older cost):** about 75 % of fill time went into building the travel graph, even for fills that never travel.

---

## 2. Done

### Digitizer
- **Even outlines.** Dark lines become satin of one set width, whatever their width in the picture. Below 1 mm they become triple stitch, because a narrower column does not sew cleanly.
- **Outlines sewn as one network.** Lines are cut at their T and X junctions and walked depth-first: a running path goes out along each edge, and the column covers it on the way back. The walk starts at a free end and sews the deepest branch last, forward, so it ends there instead of coming back. A lone line is sewn once.
- **Satin centre walk with an odd number of passes** ends at the far end, and the cover comes back, as in Ink/Stitch. The column begins and ends at its start, which is what the out-and-back steps use.
- **Lines found per kind.** Ink and each colour's narrow strips are traced apart, so a strip between two outlines keeps its own stroke.
- **Fewer stray strokes.**
  - A dark stroke inside a dark filled area, or along its edge, is dropped: the fill already sews it.
  - A pen line darker than the area it is drawn on stays.
  - Specks the lines leave behind are dropped.
- **Small marks become satin.** A mark narrower than 2 mm (a dash, a tick) becomes a short satin rather than a fill that has no room for its rows.
- **No double sewing under strips.** Fills reach under a coloured strip only to its edge, not twice under its middle.
- **Fewer colour changes.** An object joins the last earlier block of its thread when nothing sewn in between lies on it. This is tested on a 0.2 mm raster of each object's core, so edge overlaps don't count.
- **Background scope "border".** Only the background touching the picture's edge is left out.

The test logo now keeps its strip and stitches its white faces. Its outlines are 1.2 mm satin. It needs 14 trims and 4 colour blocks. Across the 13 suite pictures the default settings give the same or fewer trims and colour blocks, except two pictures with one more trim each.

### Presets and controls
- **Five presets:** *Logo* (even satin outlines on top, every enclosed area stitched, outlines routed), *Illustration*, *Line art*, *Photo* and *Pixel art*. Each one is a complete set of settings that starts from the defaults, and each says what happens to the background.
- **Output:** *Shapes*, *Zig-zag photo* or *Cross stitch*.
- **Look:** four quick controls, each moving several detailed settings together and showing *Custom* once those are changed by hand.
  - *Outlines*: none, as drawn, or even, with a width.
  - *Detail*: bold, normal or fine.
  - *Background*: left out, enclosed areas stitched, or stitched.
  - *Border*: none, running or satin.
- **Reorganised tabs.** Working resolution, denoise and pixel art moved to *Shapes*; the border moved to *Look*; the outline width and the one-network switch are in *Lines*.

### Speed
In native release builds, a cold plan across all 18 benchmark designs went from 5.1 s to 2.9 s, with every stitch identical.
- **Gradient groups:** the shared rows are traced once per group (colour blends too) and cached. Six three-colour gradients went from 2.25 to 1.17 s.
- **Tatami:** the travel graph is built only when a travel needs it, and a grid index answers "distance to the outline". 144 circles went from 0.121 to 0.012 s.
- **Hidden-stitch removal:** one scan per document instead of per pair, with nothing re-serialised. A cached re-plan of 300 overlapping fills went from 0.159 to 0.006 s.
- **Editor:** the hidden-stitching report reuses the editor's own plan, so only the "without removal" plan is extra. Report and preview requests run latest-wins in lanes of their own, so edits no longer pile requests up in front of the editor's plan. The canvas preview asks only for the cut shapes.

### Layers
- Groups fold under a header row: name, count and threads; select, hide and lock for the whole group; rename; drag a group as one.
- Expand all and collapse all; arrow keys fold and unfold.
- Grouping makes the members contiguous in stitch order.

### Row spacing
- Fills now use commercial practice: **0.4 mm rows** for 40 wt thread, in the digitizer, its presets and Filum's own stitch defaults. Before, they used Ink/Stitch's 0.25 mm. A digitizer stacks overlap, underlay and outlines on top of the fill, so denser rows pile up.
- The *Ink/Stitch* default set keeps 0.25 mm, and files from Ink/Stitch keep their own values.
- On the suite this sews 10–25 % fewer stitches on most pictures, with the densest spots easing or level, gaps unchanged and the colour match the same or slightly closer. The test logo goes from 12,812 to 11,065 stitches, and its densest spot from 7.3 to 6.9 layers.

---

## 3. Weaknesses still in the process

1. **"Enclosed" is a guess about meaning.** A white face inside an outline and the inside of a monogram's frame look the same to the digitizer. *Logo* stitches both; the monogram then gets a white fill it doesn't want. The *Background* control and clicking regions in Review fix it, but nothing points the user there.
2. **Nothing recommends a preset.** Each preset gives a clean file on its own kind of picture and a poor one on the others.
3. **Density piles up where outlines cross fills.** The fill runs to the outline's centre, its underlay runs there too, and the satin and its own underlay go on top. The test logo reaches 7.4 layers where 6 is the usual warning level.
4. **Only centre-line satins are routed.** Satins that follow the drawn width (two rails) and fills are not, so their trims remain. Between fills of one colour, a travel under the next fill would often replace a trim.
5. **Small closed letters and loops** in low-resolution pictures can become one blob: the "B" of a small JPEG badge.
6. **Tiny dark blobs (under about 3 mm²) still become fills** when no centre line fits them.
7. **The suite has no logo with even outlines**, so regressions in routing and outline width would go unnoticed.

---

## 4. Plan

Ordered by impact over effort. Each step names how we'll know it worked.

### Phase A: make the clean result the obvious one (small)
1. **Recommend a preset.** Compute a few numbers from the picture: colour count after reduction, the share of the picture that is lines, edge sharpness and noise, how blocky it is (pixel-art detection exists), and whether it has gradients. Highlight the matching preset and say why in a line. *Check:* the suite pictures each get the preset that scores best on them.
2. **Point at enclosed areas.** When *Enclosed* stitches an area larger than about a third of the design, mark it in the preview with a one-click "leave out". *Check:* the monogram picture shows the hint; the test logo doesn't.
3. **Show sewability warnings in the summary.** Flag satins under 1 mm, fills under 1.4 mm², stitches under 0.3 mm, more than 6 layers, and outlines wider than the picture's lines by more than 50 % (spill). Each warning has a one-click fix where there is one.
4. **Add an outlined logo to the public suite**, drawn by us so its licence is clear, and fail the suite run when its trims, colour blocks or layers grow.

### Phase B: cleaner files (medium)
1. **Density under outlines.**
   - With an even outline, fills stop 0.3 mm inside the outline's outer edge instead of at its centre.
   - Fill underlay keeps out of outline bands.
   - Outlines under 2 mm get no underlay of their own beyond the centre walk the routing already lays.

   *Check:* the test logo's peak layers drop under 6, with no gaps in the realistic view.
2. **Route tapered satins and fills.**
   - Two-rail satins join the network through their centre line.
   - Fills of one colour chain through travel under the next fill of that colour where it covers the path.

   *Check:* trims on the suite down by a quarter.
3. **Small marks.** For a dark blob under 3 mm² with no centre line, use a satin along its principal axis. For small closed letters, keep the counter by tracing each loop as its own closed column.
4. **A density quick control.** *Light / Standard / Dense* drives row and satin spacing, pull compensation, overlap and underlay strength, with the fabric profile underneath. *Standard* is today's 0.4 mm rows and *Dense* is 0.3 mm. Ink/Stitch's 0.25 mm stays available through its default set.

### Phase C: speed (medium)
1. **Travel routes.** `order_lines` (about 1 s of the 3.6 s cold total with removal on) gets the grid distance index in its route check and reuses the Dijkstra buffers between calls. The output stays identical.
2. **Flow and curved fills.** Streamline tracing uses flat arrays instead of hash maps, and each shape's direction field is cached.
3. **Run cache.** Evict least recently used entries instead of emptying the whole cache at 4,000 entries, which regenerates everything at once on large designs.
4. **Clipped outlines.** Hidden-stitch removal returns outlines with many round-join points, which makes their fills slower. A coarser arc tolerance would help, but it changes stitches, so it needs a decision and a suite run.
5. ~~Measure in the browser.~~ Done, see 4.1.
6. **Flow, curved and gradient fills on first load** are now the slowest thing in the browser: 0.5 s for 16 curved fills and 0.9 s for six 3-colour gradients, cold. Items 1 and 2 address them. If that isn't enough, generate objects in parallel (a worker pool, or wasm threads where the platform allows them) and show the visible objects first.
7. **The digitize dialog** costs about 0.4 s for the stitches plus 0.2 s for the colour preview per change of a setting. A third of that is the denoise filter's 7×7 window. Run the preview and the stitches in parallel, or skip the stitches until the user looks at that tab.
8. **Very large designs on the canvas.** With 140,000 stitches, panning the stitch and realistic views drops to 15–30 frames per second in a software-rendered browser. Draw the cached layer scaled while the view moves, and repaint sharply only once it stops, as zooming already does.

### 4.1 Browser profile (November 2026)
The editor was profiled as a production build in a headless browser on eight designs, from a 14-object badge to 300 overlapping fills with 142,000 stitches. Two scripts measure it:
- `ui/scripts/wasm-bench.mjs` times the engine's wasm module directly.
- A browser script times startup, the cold plan, an edit until its plan and its repaint, panning and zooming in the three views, and the density map, and records a CPU profile of the main thread.

Findings and what was done:
- **Wasm ran 4–9× slower than native.** Normally the gap is under 2×. 58 % of the engine's time in wasm went into two software math routines, `hypot` (used for every distance) and the fused multiply-add it calls. With `sqrt(x² + y²)`, plus a multiply hash for grid cells instead of the default SipHash, cold plans got 4–42× faster in the browser (a 70-object logo 396 → 44 ms, 300 fills 1,499 → 36 ms, gradients 6,009 → 894 ms), and wasm now runs at about native speed. Natively, curved fills got 32 % faster and gradients 23 %. Every stitch is identical.
- **Digitizing** in wasm went from 536 to 382 ms, and its colour preview from 296 to 187 ms:
  - The denoise filter's exponential comes from a table.
  - Lab-to-RGB finds each byte in a table of 255 band edges instead of calling `pow`; a test checks 400,000 values byte for byte.
  - The ink detection's grey closing uses a sliding max and min that takes the same time whatever the radius.
  - Line stamping skips cells already marked.

  The suite's quality numbers are identical, and natively the digitizer is 10–47 % faster.
- **An edit's plan** used to wait a fixed 40 ms before planning. It now plans on the next frame, and the client's latest-wins queue still merges bursts. Edit to new plan went from 48–129 ms to 25–60 ms, and edit to repaint from 65–144 ms to 48–91 ms.
- **The Properties panel's section tracker** rescanned all sections and forced a layout on every value change inside them. It now rescans only when sections are added or removed, or while searching.
- **What's left on the main thread** is mostly canvas compositing (`drawImage`, 14 %), garbage collection (7 %) and building the stitch geometry for the canvas (11 %). None of these is wasteful, and all three scale with the stitch count.

### 4.2 Machine conventions check (November 2026)
`cargo run --release -p filum-core --example plan_audit -- <dir of .filum designs>` checks plans and the machine files written from them. It found the trim logic sound:
- a tie-off before and a tie-in after every trim
- the order tie-off → trim → jump → tie-in
- no untrimmed jumps
- DST, PES, EXP, JEF and VP3 within their per-axis limits, with their trims read back

Three things were changed:
- **No trim before a colour change.** The machine cuts there itself, Ink/Stitch writes none, and the trim count and time estimate counted it twice.
- **A connecting stitch over 2 mm between objects that nothing sewn later covers is trimmed**, the threshold of commercial auto-trim. Before, every gap up to 3 mm was sewn through, leaving threads of up to 2.9 mm across the fabric between letters and lines.
- **The PES export warns about trims on jumps under 5 mm**, which Brother machines don't cut by default.

Still open:
- **Gradient colours trim inside their shape** (#3). The trims come from rows that run *along* the gradient: every row is split between the colours, and a colour's pieces 3–5 mm apart can't be joined without lying on an earlier colour. Travelling hidden under the later colours' stretches of the shared lines was tried and saved 2 of 98. With rows *across* the gradient the three straight-row gradients of the test design drop from 51 trims inside their shapes to 3. Done: rows follow the gradient line when it is redrawn, and the Issues list flags straight rows along a gradient with a one-click fix. Curved and flow gradients keep their trims (their rows follow the shape).
- **Travel crossing the rows on top** (#4). Done: the line order now routes to any line left before it gives up, and the straight travel out of a walled-in pocket may cross sewn rows for at most 2 mm, else it is a trim. In the 16 curved fills: crossing travel 114 → 58 mm, trims 1 → 13. The 13 test pictures are unchanged.
- **A trim with no jump after it** (#5) was lost in PES. Done: written as a zero-length trim-jump.
- **What the machine cuts** (#1, #2). Done: a thread cutter setting (every trim, jumps over a length, none), uncut jumps drawn as thread and counted as hand trims, trim marks with *View → Show → Jump stitches*.

### Phase D: later
- Tell a face from a frame's inside by learned segmentation (the on-device model the AI tab already uses), not by geometry alone.
- Let the user pick a region's role (fill, line, leave out) right in the stitch preview, not only by colour.

---

## 5. How to check a change

- `cargo test -p filum-core --release`, `npm run test:match` and `npm run typecheck` in `ui/`.
- The digitizer suite before and after: no picture may gain trims, colour blocks, gap or spill without a reason given in the commit.
- The plan benchmark before and after: the stitch hashes must match unless the change is meant to alter stitches.
