//! Rebuild shapes from stitches (Ink/Stitch `outline.py`): the stitch lines of
//! an object (e.g. one colour of an imported machine file) are thickened by a
//! buffer until neighbouring rows merge, shrunk back by an inset, small bits
//! are dropped and the outlines are smoothed into Bézier paths — shapes that
//! can be stitched again with any fill or satin.

use serde::Deserialize;

use crate::assemble::Engine;
use crate::clip;
use crate::geom::{signed_area, Point};
use crate::model::{Document, SubPath};

/// Ink/Stitch's outline options (mm).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct OutlineParams {
    /// Enlarge the stitch lines by this much (Ink/Stitch `buffer`): half the
    /// row spacing or more merges the rows of a fill.
    pub buffer: f64,
    /// Shrink the result back (Ink/Stitch `inset`), to counteract the buffer.
    pub inset: f64,
    /// Smooth the outline by this much (Ink/Stitch `smoothness`).
    pub smoothness: f64,
    /// Drop shapes (and holes) smaller than this (mm², Ink/Stitch `threshold`).
    pub threshold: f64,
}

impl Default for OutlineParams {
    fn default() -> Self {
        // Ink/Stitch: buffer 0.001, inset 0 — only closed loops of stitches
        // make shapes; a buffer that merges fill rows works on any design
        OutlineParams { buffer: 0.3, inset: 0.3, smoothness: 0.3, threshold: 10.0 }
    }
}

/// Outline rings of stitch lines.
pub fn outline_runs(runs: &[Vec<Point>], p: &OutlineParams) -> Vec<Vec<Point>> {
    // a non-finite or absurd buffer / inset (it would exhaust memory) is
    // brought back to a sane range
    let buffer = if p.buffer.is_finite() { p.buffer.clamp(0.001, 100.0) } else { OutlineParams::default().buffer };
    let inset = if p.inset.is_finite() { p.inset.clamp(0.0, 100.0) } else { 0.0 };
    let bands: Vec<clip::Region> = runs.iter().filter(|r| r.len() >= 2).map(|r| clip::band(r, buffer)).collect();
    let mut region = clip::union_all(bands.iter());
    if inset > 0.0 {
        region = clip::offset(&region, -inset);
    }
    clip::rings(&region).into_iter().filter(|r| signed_area(r).abs() >= p.threshold.max(0.0)).collect()
}

/// Shapes rebuilt from the stitches of object `index` as closed, smoothed
/// sub-paths (outer outlines and holes, even-odd).
pub fn object_outline(doc: &Document, engine: &mut Engine, index: usize, p: &OutlineParams) -> Vec<SubPath> {
    let runs: Vec<Vec<Point>> = engine.object_runs(doc, index).into_iter().map(|r| r.into_iter().map(|(q, _)| q).collect()).collect();
    let corner = 40.0;
    outline_runs(&runs, p).iter().map(|r| clip::fit_ring(r, p.smoothness.clamp(0.005, 5.0), corner)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geom::pt;

    /// A 10 × 10 mm square filled with back-and-forth rows 0.4 mm apart.
    fn rows() -> Vec<Point> {
        let mut v = Vec::new();
        let mut y = 0.0;
        let mut k = 0;
        while y <= 10.0 + 1e-9 {
            let (a, b) = if k % 2 == 0 { (0.0, 10.0) } else { (10.0, 0.0) };
            v.push(pt(a, y));
            v.push(pt(b, y));
            y += 0.4;
            k += 1;
        }
        v
    }

    #[test]
    fn rows_become_one_shape() {
        let rings = outline_runs(&[rows()], &OutlineParams::default());
        assert_eq!(rings.len(), 1);
        let a = signed_area(&rings[0]).abs();
        assert!((a - 100.0).abs() < 3.0, "area {a}");
    }

    #[test]
    fn a_tiny_buffer_keeps_only_closed_loops() {
        let p = OutlineParams { buffer: 0.001, inset: 0.0, smoothness: 0.3, threshold: 10.0 };
        assert!(outline_runs(&[rows()], &p).is_empty());
        // a closed running stitch: its outer and inner outline
        let sq = vec![pt(0.0, 0.0), pt(10.0, 0.0), pt(10.0, 10.0), pt(0.0, 10.0), pt(0.0, 0.0)];
        assert_eq!(outline_runs(&[sq], &p).len(), 2);
    }

    #[test]
    fn absurd_buffers_do_not_exhaust_memory() {
        for b in [1e300, f64::INFINITY, f64::NAN, -1e300] {
            for i in [1e300, f64::INFINITY, f64::NAN] {
                let p = OutlineParams { buffer: b, inset: i, smoothness: 0.3, threshold: 10.0 };
                let _ = outline_runs(&[rows()], &p);
            }
        }
    }
}
