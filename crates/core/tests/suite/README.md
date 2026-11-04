# Digitizer suite

Pictures that exercise the auto-digitizer where it usually goes wrong. Each one comes
with a sidecar `NAME.json`: the options that differ from the defaults (a partial
`DigitizeOptions`, camelCase), with `_note` saying what the picture tests.

```sh
cargo run --release -p filum-core --example digitize_suite -- \
    crates/core/tests/suite target/digitize-suite        # [--only NAME]
```

`target/digitize-suite/index.html` shows each case in one row:

- the picture
- the stitches, rendered thread by thread
- the plan: travel and jumps in red, trims as crosses
- the colour difference against the picture: blue is a gap, orange is thread on the
  background, red is the wrong colour
- the numbers digitizers judge a design by:
  - stitch count and stitches per cm²
  - trims, jumps and colour changes
  - short stitches (under 0.5 mm) and long ones (satin over 7 mm, anything over 12 mm)
  - density (layers and hotspots)
  - mean ΔE, gaps and spill

Red numbers are past the usual limits.

| case | what it tests |
| --- | --- |
| 01 badge-text | ring satin, fills, white text knocked out of a banner, a 2.4 mm sub-line |
| 02 cartoon-outline | black outlines around every shape, eye highlights |
| 03 line-art | 0.5 mm and 0.27 mm ink lines; the leaves' insides are fabric |
| 04 gradient-sunset | a gradient reduced to bands |
| 05 tiny-details | dots and text below what can be stitched |
| 06 rings | satin columns from 5.3 to 0.8 mm |
| 07 big-fill | one large fill with a hole |
| 08 pixel-art | a 16 × 16 sprite with one-pixel eyes |
| 09 stripes | abutting regions, colour changes |
| 10 lettering | 15, 7 and 3.5 mm text |
| 11 icon-transparent | a transparent PNG with a semi-transparent shadow |
| 12 monogram | bold serif letters touching a thin frame |
| 13 badge-jpeg | case 01 as a small, heavily compressed JPEG |

`src/` has the SVG sources. The PNGs are rendered with `rsvg-convert`, the JPEG and the
sprite with ImageMagick.

## References digitized by hand

A stitch file next to a picture, named `NAME.ref-WHO.pes` (or `.dst`, `.exp`, `.jef`,
`.vp3`, `.xxx`), is a reference: the picture is digitized at the reference's size, and
the reference's numbers and render go in the same row. Put references in `reference/`
(ignored by git: they are other people's work under their own licences) and run the
suite on that folder:

```sh
cargo run --release -p filum-core --example digitize_suite -- \
    crates/core/tests/suite/reference target/digitize-suite/reference
```

Good sources are openly licensed designs published together with their artwork,
ideally the same artwork digitized more than once.
