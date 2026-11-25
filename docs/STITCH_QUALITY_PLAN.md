# Stitch quality and optimisation plan

Short stitches, needle holes that pile up, and the optimiser's next steps: what a real design shows, what embroidery practice says, and the work in the order it pays off.

Companion documents: [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) (the whole app), [DIGITIZER_PLAN.md](DIGITIZER_PLAN.md) (the auto-digitizer) and [density-model.md](density-model.md) (layers, needle holes and weight per mm²).

---

## 1. What a real design shows: the Koi test

`Koitest.filum`: 72 objects in 5 threads on cotton, mostly curved, flow and guided fills, a few running and bean-stitch lines. Machine: Ink/Stitch's defaults (minimum stitch 0.1 mm). 10,225 needle drops.

### 1.1 Stitch lengths

| Length | Stitches |
|---|---|
| under 0.1 mm | 92 |
| 0.1 – 0.2 mm | 358 |
| 0.2 – 0.3 mm | 555 |
| 0.3 – 0.5 mm | 1,192 |
| 0.5 – 0.8 mm | 1,701 |
| 0.8 – 1.0 mm | 724 |
| 1.0 – 1.5 mm | 1,502 |
| 1.5 mm and more | 4,101 |

About a fifth of the stitches are under 0.5 mm. Of those, **over half are fill travel**, about a fifth underlay, about a seventh top stitching and the rest lock stitches.

The objects' outlines are not the cause: they have 3 to 79 Bézier nodes each. The running stitch ignores a dense smooth curve: a circle of 2,000 nodes gives 26 even stitches, a ±0.08 mm noisy one 30. **Jagged** node runs are a cause elsewhere (traced and digitized lines): a pixel staircase gives 44 stitches under 1 mm out of 69, because every 90° pixel corner is a corner the running stitch keeps (Ink/Stitch's `path_to_curves` does the same).

Most short top and travel stitches in the Koi's fills are the step from one row to the next along the edge (0.3 mm at a 0.3 mm row spacing, then a 2–3.5 mm row stitch). Every fill has them; dropping them leaves a saw-tooth edge (see `assemble.rs`, `redundant`).

### 1.2 Needle holes in the same place

The real problem is where the needle goes, not how long the stitches are:

- **2,428 of 10,225 needle drops (24 %) land within 0.15 mm of an earlier drop.** Leaving out the two bean-stitch lines (which hit their own holes on purpose) and lock stitches, **fill travel alone accounts for about 930 re-hits inside its own object**.
- Hot spots reach **25–32 needle drops per mm²**. Cotton takes 17 (`density.rs`, `Fabric::limits`). In the eight worst spots the travel stitches of one fill dominate: 13 of Caramel 9's travel stitches lie within 0.5 mm of one point; Red 1 adds 12 at another.

Why: a fill's travel runs along its outline or through its underpath lattice from one section to the next. In a narrow part of the shape every travel takes the same route, through the same lattice corners, so its needle points fall on the same holes again and again.

---

## 2. What embroidery practice says

From digitizing guides and the manuals of commercial digitizing programs (November 2026):

- **Minimum stitch.** About 0.5 mm reads as one hole, about 1 mm is the safe target ([Embroidery Legacy](https://www.embroiderylegacy.com/wp-content/uploads/2025/08/ELCheatSheet-1.pdf)). The minimum is raised for dense fabrics and thick threads.
- **Input points are needle holes.** Too many in a small area is a common cause of thread breaks on walk stitches.
- **Small-stitch filters run all the time.** Commercial programs remove stitches under a set length always, only on output, or never; one removes them by default under 0.8 mm.
- **Sequencing.** Centre out; on caps also bottom up.
- **Fewer trims.** Touching objects of one colour are sewn as one group, with the travel between them hidden under later stitching. Joining each object at the point closest to the next is common too, but has to be reapplied by hand after edits.
- **Satin curves.** Stitches on the inside of tight curves are shortened. Filum's satins do this already (`satin.rs`, `inset_short_stitches`).

Ink/Stitch is the reference for how stitches are made. Where it has nothing (stitch-quality checks, hole avoidance, sequencing beyond colour grouping) Filum adds it, and says so in the code.

---

## 3. The work, in order

Every phase is measured on the Koi test and the staircase probe, before and after.

### Phase 1: measure it, from the plan *(done)*

A stitch-quality report computed with every plan, from the stitches themselves rather than the settings:

- short stitches (under 0.5 mm, lock stitches and bean stitches left out), per object;
- needle drops that land on an earlier hole of the same object (within 0.15 mm);
- hot spots: needle drops per mm² within 0.5 mm, against the fabric's limit (`Fabric::limits().holes_max`), with the objects and stitch kinds that make them.

Where it shows:
- **Issues panel:** "Needle holes pile up" at each hot spot, naming the object; "Many short stitches" for an object where they are a large share.
- **`filum info`:** the same numbers.
- **The core tests:** the numbers become the yardstick for phases 2–4.

### Phase 2: travel that avoids its own holes *(first version done)*

A pass over each object's stitches, after it is generated: a **travel** stitch (hidden, so free to move a little) whose needle point lands on an earlier hole of the same object is dropped when the stitch from the point before to the point after stays within 0.2 mm of the route (half a thread width) and within the travel length, else slid along the route to the nearest clear spot. Rows, underlay, satins and lock stitches are not touched.

Goal on the Koi: travel re-hits from about 930 to under 200, no hot spot above the fabric's limit caused by travel. It's a design option (*Avoid holes*, on), so a design can still match Ink/Stitch stitch for stitch.

Result on the Koi (`stitches/holes.rs`):

| | Before | After |
|---|---|---|
| Needle drops | 10,225 | 9,785 |
| Drops on an earlier hole of the same object | 1,400 | 718 |
| of them travel | 902 | 218 |
| Stitches under 0.5 mm | 1,829 | 1,503 |
| Worst hot spot | 32 per mm² | 31 per mm² |

The hot spots barely move: they are rows, lock stitches and travel together, a little apart rather than in one hole (a wider avoidance radius of 0.25 mm made the re-hits worse, 846, and left the hot spots as they were). Next for them: lock stitches placed away from each other (phase 5) and fewer travel passes through a narrow part (route each section's travel through a different stretch), measured spot by spot.

### Phase 3: a smarter small-stitch filter *(done, in part)*

- **Done:** in a running stitch the filter (`assemble.rs`, `loose_turn`) also drops a short stitch at a turn when leaving it out cuts the corner by 0.25 mm at most (the running stitch's own tolerance, about half a thread). A 0.3 mm staircase loses three quarters of its short stitches under a 0.6 mm minimum; a real corner stays. Fills (the step to the next row), satins (their edge), bean stitch and manual stitch keep every turn. It only acts above Ink/Stitch's 0.1 mm minimum, so a design on Ink/Stitch's defaults sews as before.
- **Done:** the *Many short stitches* issue suggests a minimum of 0.3–0.5 mm when the running stitch's is under 0.3 mm.
- **Dropped:** a mode (*Always / On export / Off*). The preview has to be what the machine sews; a minimum of 0 is *Off*.
- **Deferred:** a minimum per thread for metallics and thick threads (1.5–2 mm). Threads don't record their material yet.

### Phase 4: the digitizer stitches what it can sew *(done)*

- **Measured, no change needed:** across the 13 pictures of the digitizer suite (`examples/digitize_suite.rs`, which now reports the short stitches of running stitch and satins and the holes hit again), the digitizer's lines have 0 to 7 short stitches each. Its centre lines are clean already; the short stitches it makes are fill row steps.
- **Done:** **Path → Nodes → Simplify for stitching** (`ui/src/lib/stitchSimplify.ts`) for traced, scanned and imported paths: real corners found over 1.5 mm and kept, the pixel steps between them averaged over 1 mm, curves fitted within 0.25 mm. A 95-node staircase becomes 4 nodes (the plain *Simplify* effect keeps 44), a traced square keeps its four corners and goes from 80 nodes to 5, a clean path is left as it is. It is also the fix of the *Many short stitches* issue.

### Phase 5: the optimiser *(done, in part)*

- **Done: hidden travel instead of trims (branching).** A gap to the next object longer than the trim distance and up to 12 mm that what is sewn later covers all along (every millimetre within 0.45 mm of a later stitch, the plan's own visibility test) is sewn through in running stitches of 2.5 mm, flagged as travel, instead of tied off, trimmed and tied in. A design option (*Hide travel*, on); off trims as Ink/Stitch does. Koi: 77 → 65 trims, 27:33 → 25:26 sewing time. Digitizer suite: fewer trims on three pictures (12 → 10, 11 → 8, 13 → 11), colour difference unchanged.
- **Done: centre out.** An Optimise step: the thread and the next object are chosen nearest the middle of the design first (weighed against the way there when *Shortest way* is on); on caps the distance from the bottom counts instead of the vertical one (bottom up). On by default on caps and fabrics that stretch (knit, piqué, fleece, towel), in the editor and in `filum optimize`.
- **Reconsidered: automatic end points in the plan.** They would change every design against Ink/Stitch. End points stay what Ink/Stitch makes them, commands on the object, and Optimise sets them when asked (its *End points* step, checked against the real plan).
- **Open: lock stitches.** The Koi's worst spot (31 per mm²) is two small objects that both start and end at the same tip, their locks on top of each other. Next: when an object's start, chosen near where the last one ended, lands on earlier lock stitches and the connection is cut anyway (colour change, trim, stop), start it a little further along.

---

## 4. Status

| Phase | State |
|---|---|
| 1. Stitch-quality report | done: `quality.rs`, Issues panel, `filum info` |
| 2. Travel avoids its holes | done: `stitches/holes.rs`, *Avoid holes*; hot spots still open |
| 3. Small-stitch filter | running stitch turns done; per-thread minimum deferred |
| 4. Digitizer and Simplify for stitching | done: digitizer measured clean; *Simplify for stitching* |
| 5. Optimiser | hidden travel and centre out done; lock stitches open |

## 5. The Koi, start to now

| | Ink/Stitch's way | Now (defaults) |
|---|---|---|
| Needle drops | 10,225 | 9,715 |
| Trims | 77 | 65 |
| Sewing time (700 spm) | 28:10 | 25:26 |
| Drops on an earlier hole of the same object | 1,400 | 718 |
| Worst hot spot | 32 per mm² | 31 per mm² |
