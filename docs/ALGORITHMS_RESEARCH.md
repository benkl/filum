# Stitching algorithms missing from Ink/Stitch

This is a research survey of open-source projects, papers, patents and practitioner literature, done in November 2026. Each item was checked against **Ink/Stitch v3.3.0** (released 31 Jul 2026): its [stitch library](https://inkstitch.org/docs/stitch-library/), [features page](https://inkstitch.org/features/), [release notes](https://inkstitch.org/en/2026-07-31-v3.3.0) and open GitHub issues.

**Already in Ink/Stitch** (so not listed below as gaps): running, bean, manual, zig-zag, ripple, circular, meander, linear-gradient, tartan, contour fill (including single and double spiral), tatami/auto-fill, guided fill, cross stitch plus the Cross Stitch Assistant, satin columns (auto-satin, underlays, E/S/zig-zag, pull and push compensation, multicolour satin), lettering, auto-route, redwork, cutwork, lock stitches, colour sort, knockdown, density map, and the realistic PDF render. Appliqué is only a manual workflow ([tutorial](https://inkstitch.org/tutorials/applique/), open request [#112](https://github.com/inkstitch/inkstitch/issues/112)).

**Legend:**
- **Difficulty:** S = days, M = weeks, L = months or research-grade.
- **Priority:** P1 to P3.
- **Status:** ✅ = done in Filum v0.1, 🟡 = partly done, ⏳ = planned (see [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md)).

## 1. Auto-digitizing from raster images

| # | Item | Description and value | Source | Diff | Status |
|---|---|---|---|---|---|
| 1 | Raster to stitch regions (P1) | Quantize colours with CIE Lab distance to thread colours, merge specks, and vectorize the regions as polygons with holes. Ink/Stitch has an open request for this ([#1952](https://github.com/inkstitch/inkstitch/issues/1952)); its cross-stitch tool only pixelates. | [vtracer](https://github.com/visioncortex/vtracer) | M | ✅ `core::digitize` (Lab k-means++ with Ward merge, fringe removal, contour tracing) |
| 2 | Automatic stitch type per region (P1) | Use the distance transform or medial axis to measure width. Hairlines become running stitch, bands narrower than about 8 mm become satin, wider areas become tatami. Fill angle comes from PCA. | [MSEmbGAN](https://csai.wtu.edu.cn/TVCG/index.html) | M | ✅ heuristic version (EDT width, Zhang–Suen skeleton, PCA angle) |
| 3 | Direction-field embroidery (P2) | A direction field drives streamlines, their spacing follows image tone, and they join into one stitch path. | [Liu et al., CGF 2023](https://diglib.eg.org:443/bitstream/handle/10.1111/cgf14770/v42i2pp397-409_cgf14770.pdf) | L | ⏳ |
| 4 | Photo stitch: tonal stippling plus TSP (P2) | Weighted-Voronoi stippling (Secord) followed by a TSP tour, giving one continuous line. | [StippleGen](https://www.evilmadscientist.com/2012/stipplegen-weighted-voronoi-stippling-and-tsp-paths-in-processing/), [Kaplan & Bosch 2005](https://cs.uwaterloo.ca/~csk/publications/Papers/kaplan_bosch_2005.pdf) | M | 🟡 uniform Poisson-disk + TSP "stipple" fill; tone weighting ⏳ |
| 5 | ML stitch-type classifier (P3) | Image-to-embroidery networks, used only as hints or previews. | [MSEmbGAN TVCG 2025](https://web.comp.polyu.edu.hk/pli/CoRR/TVCG/TVCG2025_Early_1.pdf), [arXiv 2003.02909](https://ar5iv.labs.arxiv.org/html/2003.02909) | L | ⏳ optional (`ort`/`candle`) |

## 2. Fill algorithms

| # | Item | Description and value | Source | Diff | Status |
|---|---|---|---|---|---|
| 6 | Connected Fermat spirals (P1) | One continuous, low-curvature path with no jumps. It handles the narrow and branching shapes where contour spirals fail ([#1778](https://github.com/inkstitch/inkstitch/issues/1778)). | [Zhao et al., SIGGRAPH 2016](https://www.cs.purdue.edu/homes/bbenes/papers/Zhao16ToG.pdf), [project](https://haisenzhao.github.io/CFS), [Python 2D implementation](https://ejbosia.github.io/projects/connected-fermat-spirals) | L | ⏳ (Filum's spiral fill blends EDT inset rings, so it already covers single-component shapes) |
| 7 | Space-filling curves: Hilbert, Peano, Gosper (P2) | A textured "quilted" look. | [forum thread](https://inkscape.org/forums/embroidery/meandering-patterns) | S–M | ✅ Hilbert fill (cells inside the shape, adjacency-preserving, jumps routed inside) |
| 8 | Vector-field, Perlin and "drunk-walk" hatching (P2) | Organic textures such as fur, water and wood. | [PEmbroider API](https://github.com/CreativeInquiry/PEmbroider/blob/master/API.md) | S–M | ⏳ |
| 9 | Radial and non-linear gradient fills (P2) | Open in Ink/Stitch as [#4200](https://github.com/inkstitch/inkstitch/issues/4200) and [#4437](https://github.com/inkstitch/inkstitch/issues/4437). | issues | M | 🟡 **radial sunburst fill** ✅ (ray start radii follow bit-reversal levels so density stays constant); radial density gradient ⏳ |
| 10 | Curved uniform-density fill (P3) | Map the shape to a parametric space, fill with straight rows there, and map the rows back. | [US 6587745](https://patents.justia.com/patent/6587745) | M | ⏳ |
| 11 | Programmable fills and carving stamps (P2) | Needle-point motifs repeated across rows; embossing stamps. | practitioner literature | M | ⏳ |
| 12 | Random needle offsets and checker fill (P3) | Open in Ink/Stitch as [#4433](https://github.com/inkstitch/inkstitch/issues/4433) and [#3829](https://github.com/inkstitch/inkstitch/issues/3829). | issues | S | ⏳ |

## 3. Satin

| # | Item | Description and value | Source | Diff | Status |
|---|---|---|---|---|---|
| 13 | Medial-axis satin with branches and corner treatment (P1) | More robust than detecting rails: take the skeleton, split it into branches, place rungs perpendicular to the axis, and mitre or cap the joints. | [`centerline`](https://docs.rs/crate/centerline/latest/source/README.md), [`straight-skeleton`](https://docs.rs/straight-skeleton) | M–L | 🟡 raster version in the digitizer (single longest skeleton path); vector version with branches ⏳ |
| 14 | Automatic split of wide satins with jitter (P2) | Open in Ink/Stitch as [#4207](https://github.com/inkstitch/inkstitch/issues/4207). | issue | S | 🟡 even splitting above a maximum length ✅; jitter ⏳ |
| 15 | Satin end caps for 3D puff (P2) | | practitioner literature | S | ⏳ |

## 4. Routing and ordering

| # | Item | Description and value | Source | Diff | Status |
|---|---|---|---|---|---|
| 16 | Global reorder that minimises colour changes while respecting stacking (P1) | Build a DAG from overlaps, then a topological sort that prefers the current colour. Open in Ink/Stitch as [#378](https://github.com/inkstitch/inkstitch/issues/378). | issue | M | ✅ `core::optimize` (bounding-box overlap DAG) |
| 17 | Travel and jump minimisation with entry/exit choice (P1) | Generalised TSP over objects. | [`elkai-rs`](https://docs.rs/crate/elkai-rs/latest/source), [`ibn_battuta`](https://lib.rs/crates/ibn_battuta) | M | 🟡 nearest-neighbour within a colour ✅; choosing entry and exit points ⏳ |
| 18 | Chinese-postman redwork (P2) | Duplicate only the minimum-weight set of edges. Ink/Stitch's redwork doubles every edge. | [Hierholzer in `algos`](https://docs.rs/crate/algos/latest/source/src/cs/graph/hierholzer.rs) | M | ⏳ |
| 19 | Trim minimisation and hand-trim helper (P3) | Open in Ink/Stitch as [#370](https://github.com/inkstitch/inkstitch/issues/370). | issue | S | 🟡 trims only above a configurable jump length |

## 5. Physics, simulation and estimation

| # | Item | Description and value | Source | Diff | Status |
|---|---|---|---|---|---|
| 20 | Fabric-aware push/pull compensation (P1) | Requested in Ink/Stitch as [#869](https://github.com/inkstitch/inkstitch/issues/869) and [#3395](https://github.com/inkstitch/inkstitch/issues/3395). | [Impressions](https://impressionsmagazine.com/process-technique/how-to-work-with-push-pull-compensation/16206/) | M | 🟡 fabric profiles (pull compensation, density, underlay) ✅; anisotropic compensation ⏳ |
| 21 | Fabric distortion simulation (P3) | Mass-spring model of the fabric under stitch tension. | practitioner literature only | L | ⏳ |
| 22 | Thread, bobbin and run-time estimates (P1) | | [ZSK](https://zsk.de/pdf/software/basepac/basepac-10-thread-usage-calculation.pdf), [Signwarehouse](https://signwarehouse.com/blogs/content/how-much-thread-does-an-embroidery-design-use) | S | ✅ `PlanStats` + production sheet |
| 23 | Thread-weight-aware density (P2) | Open in Ink/Stitch as [#1416](https://github.com/inkstitch/inkstitch/issues/1416). | issue | S | ⏳ |
| 24 | Realistic 3D thread rendering (P1 for user experience) | Open in Ink/Stitch as [#3935](https://github.com/inkstitch/inkstitch/issues/3935) and [#1631](https://github.com/inkstitch/inkstitch/issues/1631). | [Cui et al. 2017](https://pure.ecnu.edu.cn/en/publications/image-based-embroidery-modeling-and-rendering/) | M–L | 🟡 shaded 2D thread renderer ✅; wgpu instanced ribbons ⏳ |

## 6. Specialty techniques

| # | Item | Source | Diff | Status |
|---|---|---|---|---|
| 25 | Appliqué wizard: placement, tack-down, cover and cut file (P1) | [#112](https://github.com/inkstitch/inkstitch/issues/112) | S–M | ⏳ (stop-after command ✅) |
| 26 | Sequins (P2) | [#24](https://github.com/inkstitch/inkstitch/issues/24), [pystitch](https://github.com/inkstitch/pystitch) | M | ⏳ |
| 27 | 3D puff foam mode (P2) | practitioner literature | S–M | ⏳ |
| 28 | Free-standing lace connectivity checker and lattice (P2) | practitioner literature | M | ⏳ |
| 29 | Multi-hoop splitting with registration marks (P1) | practitioner literature | M | ⏳ |
| 30 | Chenille: moss, chain and coil (P3) | practitioner literature | L | ⏳ |
| 31 | Longarm quilting pantographs: QLI, HQF, IQP (P2) | [#2107](https://github.com/inkstitch/inkstitch/issues/2107) | M | ⏳ |
| 32 | Cutwork needle assignment by angle (P3) | [#1748](https://github.com/inkstitch/inkstitch/issues/1748) | S | ⏳ |

## 7. Formats and workflow

| # | Item | Source | Diff | Status |
|---|---|---|---|---|
| 33 | Native Rust format I/O (P1) | [pystitch](https://github.com/inkstitch/pystitch), [`rustitch`](https://docs.rs/crate/rustitch/latest), [libembroidery](https://github.com/planaria/libembroidery) | M | ✅ `crates/formats`: DST, PES, PEC, JEF, EXP, VP3 and XXX read and write; CSV write-only |
| 34 | Object-level PES sections (P3) | pystitch README | L | ⏳ |
| 35 | Scriptable / generative stitch API (P2) | [TurtleStitch](https://turtlestitch.org/about), [PEmbroider](https://github.com/CreativeInquiry/PEmbroider/blob/master/API.md) | M | ⏳ |
| 36 | Longarm and CNC formats: G-code, DXF, QLI (P3) | | S | ⏳ |

## Useful Rust crates

| Need | Crates |
|---|---|
| Polygon booleans and offsetting | `clipper2-rust`, `i_overlay`, `geo` (Buffer, booleans, simplification) |
| Bézier curves and offsets | `kurbo` (already used), `lyon_geom` |
| Tessellation for GPU | `lyon_tessellation` |
| Triangulation and Voronoi | `spade` |
| Medial axis and skeleton | `centerline` / `boostvoronoi`, `straight-skeleton` |
| Spatial index | `rstar` |
| Graphs and Euler tours | `petgraph` (Chinese postman: Blossom matching + Hierholzer, to write ourselves) |
| TSP | `elkai-rs` / LKH bindings for large instances; in-house 2-opt for interactive use (in use) |
| Space-filling curves | `fast_hilbert` (Filum has its own `d2xy`) |
| Colour quantization | `imagequant`, `quantette`, `kmeans_colors`, `palette` |
| Vectorization | `vtracer` |
| Image analysis | `imageproc`, `kornia-imgproc` |

**Caveats:**
- It is unclear whether Ink/Stitch already estimates thread length (#22) or supports multi-hoop (#29); check before marketing either as unique.
- The compensation, puff and lace guidance comes from practitioner sources, not peer-reviewed research.
