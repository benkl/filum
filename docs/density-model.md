# Density model

How Filum judges stitch density: what the stitches put on the fabric
and how much of it the fabric and thread can take. The engine code is
`crates/core/src/density.rs`. The canvas map and legend are
`ui/src/lib/density.ts` and `ui/src/components/DensityPanel.tsx`.

## How density is usually judged

| Tool | What it measures | Thresholds |
|---|---|---|
| Ink/Stitch density map (`lib/extensions/density_map.py`) | Stitch points within a radius of each stitch | Red at ≥ 6 neighbours within 0.5 mm, yellow at ≥ 3 within 0.5 mm |
| Common stitch-point tiers | Stitch points per mm² | Light ≤ 10, dense ≤ 17, very dense ≤ 25, super dense > 25 |
| False-colour density maps | Density per area, shown as colours | Blue → green → yellow → red; layered areas stand out |
| US 6,732,008 | Density value per grid section, shown as colours | — |
| Thread makers and digitizing guides | Spacing guidance per stitch type and fabric | See below |

All of these count either points or spacing. None of them account for:

- **the thread**: a 12 wt thread covers about twice the width of a 40 wt;
- **the fabric**: silk tears where denim doesn't notice;
- **stacking**: underlay plus a fill plus a satin border plus a second fill;
- **coverage that is too thin**: the fabric showing through.

## Recommendations from the literature and thread makers

Spacing (40 wt polyester or rayon):

- **Madeira:** average density 4.0 (0.40 mm) for No. 40, 3.5 for No. 60/75, about 8 for No. 12. Madeira also recommends 60 or 75 wt thread (under 200 dtex) on delicate or stretchy fabric, and a 1/3 bobbin, 2/3 top balance on the back of a satin ([puckering guide](https://www.madeira.com/embroidery-solutions/service/support/embroidery-best-practice/how-to-avoid-puckering-during-embroidery)).
- **Common digitizing guidance:** tatami and satin spacing about 0.38–0.40 mm, with a risk of puckering and needle breaks below about 0.35.
- **By fabric:** knits, terry and fleece run about 0.45–0.55 mm. Sheer fabric runs 0.5–0.6 mm or more. Leather sources conflict. Under heavy underlay the top layer opens to 0.42–0.45 ([Echidna](https://www.echidnasewing.com.au/article/embroidery/understanding-density/), [Kimberbell](https://kimberbell.com/blogs/thekimberbellablog/understanding-embroidery-stitch-density-and-how-to-adjust-it)).
- **Ink/Stitch defaults:**
  - fill row spacing 0.25 mm;
  - satin zig-zag spacing 0.4 mm peak to peak, so two thread passes 0.2 mm apart;
  - fill underlay at three times the row spacing.

  Ink/Stitch counts satin spacing per zig-zag and fill spacing per row. So a fill row every 0.25 mm and a satin pass every 0.2 mm are the same full cover.

**Thread size.** The weight number counts km per kg, roughly, so tex ≈ 1000–1080 / weight. Madeira's Polyneon data sheets give 75 → 11, 60 → 17 and 40 → 27 tex; Schmetz gives 30 → 40 and 12 → 100. The round diameter follows from the tex:

d = √(4·tex / (1000·π·ρ·φ))

where ρ is the fibre density (1.38 g/cm³ for polyester) and φ is the packing (about 0.6). For a 40 wt thread, d ≈ 0.2 mm. On the fabric, a multifilament thread spreads under tension to about 0.25 mm. That is exactly the line spacing of Ink/Stitch's full cover.

**Fabric loading.** Dutta & Chatterjee (JTATM, 2020; [PDF](https://jtatm.textiles.ncsu.edu/index.php/JTATM/article/download/15835/8205/67273)) model the areal density of embroidered fabric from the thread per stitch:

- needle thread per stitch: CE = 0.0195(2D₁ + D₂) + L + t;
- added mass: W = S·(CE·D₁ + CB·D₂)·10⁻⁶/9.

Stitch density was the most significant factor. In regression studies, stiffness rises with stitch density ([Springer, Fashion and Textiles 2020](https://link.springer.com/article/10.1186/s40691-020-00225-6)). Puckering depends on fabric thickness and weight, stitch density and thread tenacity.

**Bobbin.** The bobbin takes about a quarter to a third of the top thread.

## The model

Every stitch in the plan counts: top stitching, underlay, travel and ties. Each one deposits three quantities on a 0.2 mm grid (coarser for big designs):

1. **Layers**, thread area per fabric area: length × the thread's spread width.
   - The width is 0.25 mm for No. 40, scaled like the engine's spacing (Madeira's table; √tex otherwise).
   - One layer is Ink/Stitch's default fill: the fabric just covered.
   - Calibration:

     | Stitching | Layers |
     |---|---|
     | Default fill with its underlay | ≈ 1.3 |
     | Two fills stacked | ≈ 2.6 |
     | Three fills stacked | ≈ 4 |

2. **Needle holes per mm²**: perforation, on the scale of the common stitch-point tiers.
3. **Added weight (g/m²)**: length × (top tex + 0.33 × bobbin tex, with a 17 tex bobbin), since 1 mm of thread per mm² is 1 km per m². A default fill adds about 170 g/m². The ratio to the fabric's own weight shows stiffness, the "bulletproof" patch.

Each thread has a size: a thread's own `weight` overrides the design-wide weight, both for the engine's spacing and for the model.

The fields are smoothed with a Gaussian of σ = 0.35 mm, the scale at which stacked thread deflects the needle. Ink/Stitch's 0.5 mm radius plays the same role.

**Thin cover.** Fill methods meant to cover (tatami, contour, spiral, guided, flow, curved, radial, circular, tartan, without a density ramp) and satins are rasterised. That mask is eroded by the smoothing radius so edges don't read as thin. Inside it, too few layers means the fabric shows through. Open fills, running stitches, gradients and ramps are open on purpose and are never judged thin.

**Classes**: thin / ok / heavy / too dense. A cell is too dense when layers or holes exceed the fabric's maximum. Connected too-dense cells become **hotspots**, each listing the objects that stitch there.

### Fabric limits

| Fabric | g/m² | Holes heavy / max | Layers heavy / max | Thin below | Stiff at (× fabric) |
|---|---|---|---|---|---|
| Cotton | 130 | 10 / 17 | 2.4 / 3.8 | 0.6 | 1.5 |
| Polyester | 110 | 10 / 17 | 2.4 / 3.8 | 0.6 | 1.5 |
| Denim | 400 | 14 / 25 | 2.8 / 4.4 | 0.6 | 0.8 |
| Knit | 160 | 8 / 14 | 2.1 / 3.2 | 0.6 | 1.2 |
| Sheer | 40 | 5 / 9 | 1.6 / 2.4 | 0.5 | 3.0 |
| Felt | 300 | 12 / 22 | 2.8 / 4.4 | 0.5 | 1.0 |
| Towel | 450 | 12 / 22 | 2.8 / 4.4 | 0.8 | 0.7 |
| Cap | 300 | 14 / 25 | 3.0 / 4.8 | 0.6 | 1.0 |
| Fleece | 250 | 10 / 18 | 2.6 / 4.0 | 0.7 | 1.0 |
| Piqué | 200 | 9 / 16 | 2.4 / 3.8 | 0.65 | 1.0 |
| Leather | 600 | 5 / 9 | 1.8 / 2.8 | 0.5 | 0.5 |
| Canvas | 350 | 14 / 25 | 2.8 / 4.4 | 0.6 | 0.8 |
| Silk | 70 | 6 / 11 | 1.7 / 2.6 | 0.6 | 2.0 |

Where the numbers come from:

- **Holes:** woven fabrics follow the common tiers. Fabrics that a line of holes cuts (sheer, silk, leather, knits) are tighter; heavy fabrics are looser.
- **Layers:** heavy starts at about a fill over a fill, too dense at about three. Pile fabrics need more cover to keep the loops down.
- **Weights:** typical weights for each kind of fabric.

These are judgement calls anchored to the sources above, not measurements. Test stitch-outs on your machine and fabric should tune them.

## In the app

**View ▸ Density map (D)** shows the map and a legend with:

- **Three views:**
  - **Coverage:** blue where too thin; green, amber, red and magenta by layers.
  - **Needle holes.**
  - **Stiffness.**
- A colour bar marked with the fabric's limits.
- The share of the stitched area in each class.
- A readout under the pointer: layers, holes/mm², +g/m² and the class.
- **Show / Next**, which zooms to each too-dense place and selects what stitches there.
- When fills stack on fills, **Hidden stitching** (Design ▸ Hidden stitching) leaves out what's under them, with rules for what hides (width, row spacing, textures, appliqué) and per-object overrides.

Changing the fabric or a thread's weight (Threads ▸ manager, "wt") re-judges the same stitches.
