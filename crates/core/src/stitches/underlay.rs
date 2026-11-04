//! Which underlay an object gets: as set by hand, or chosen by its size and
//! the fabric (automatic underlay).
//!
//! The rules follow common digitizing practice for the underlay types (sources disagree on exact widths; these are the
//! middle of the published ranges):
//!
//! * Satin columns — center run for narrow columns (about 2–3 mm),
//!   edge run (contour) for somewhat wider ones, edge run + zig-zag for wide
//!   columns ("zig-zag supports wide columns and can be combined with center
//!   run or edge run"). Columns under about 1.2 mm get none: an underlay would
//!   show and thicken them.
//! * Fills — "a typical combination is edge run with tatami for larger
//!   objects"; "for very soft or elastic fabrics, double tatami with edge
//!   run". Narrow shapes (lettering, thin areas) get an edge run only, tiny
//!   ones none.
//! * Delicate or firm fabrics (silk, leather: every needle hole shows) get one
//!   step less; stretchy and pile fabrics (knits, fleece, towels, piqué) one
//!   step more.
//! * Under a knockdown (laydown) the net is the underlay: edge runs only
//!   ("on a knockdown stitch, the mesh is the underlay").

use crate::geom::{dist_to_boundary, point_in_rings, pt, rings_bounds, Ring};
use crate::model::{FabricProfile, FillParams, SatinParams};

/// The underlay of a fill.
#[derive(Debug, Clone, PartialEq)]
pub struct FillUnderlay {
    /// A running stitch just inside the outline, first.
    pub edge: bool,
    /// Tatami underlay passes: angles relative to the fill angle (degrees).
    pub passes: Vec<f64>,
}

impl FillUnderlay {
    pub fn none() -> FillUnderlay {
        FillUnderlay { edge: false, passes: vec![] }
    }
    pub fn is_empty(&self) -> bool {
        !self.edge && self.passes.is_empty()
    }
}

/// The underlay of a satin column: centre walk, contour, zig-zag.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SatinUnderlay {
    pub center: bool,
    pub contour: bool,
    pub zigzag: bool,
}

/// The width of a shape: twice the radius of the largest circle inside it
/// (sampled), so a long thin shape counts as thin.
pub fn shape_width(rings: &[Ring]) -> f64 {
    let b = rings_bounds(rings);
    if !(b.width() > 0.0 && b.height() > 0.0) {
        return 0.0;
    }
    let n = 24;
    let mut best: f64 = 0.0;
    for j in 0..n {
        for i in 0..n {
            let q = pt(b.min_x + b.width() * (i as f64 + 0.5) / n as f64, b.min_y + b.height() * (j as f64 + 0.5) / n as f64);
            if point_in_rings(q, rings) {
                best = best.max(dist_to_boundary(rings, q));
            }
        }
    }
    2.0 * best
}

/// Tatami passes as set by hand: one at the underlay angle, or two crossing
/// at ±45° to it.
fn manual_passes(p: &FillParams) -> Vec<f64> {
    if !p.underlay_angles.is_empty() {
        return p.underlay_angles.clone();
    }
    if p.underlay_cross {
        vec![p.underlay_angle - 45.0, p.underlay_angle + 45.0]
    } else {
        vec![p.underlay_angle]
    }
}

/// The underlay of a fill on a fabric.
pub fn fill_underlay(rings: &[Ring], p: &FillParams, fabric: &FabricProfile) -> FillUnderlay {
    if !p.underlay_auto {
        if !(p.underlay || fabric.force_underlay) {
            return FillUnderlay::none();
        }
        return FillUnderlay { edge: p.underlay_edge, passes: manual_passes(p) };
    }
    let w = shape_width(rings);
    // one step lighter on delicate fabrics, heavier on stretchy ones
    let (tiny, narrow) = match (fabric.delicate, fabric.stretch) {
        (true, _) => (3.0, 12.0),
        (_, true) => (2.0, 6.0),
        _ => (2.5, 8.0),
    };
    if w < tiny {
        return FillUnderlay::none();
    }
    if w < narrow || fabric.knockdown {
        return FillUnderlay { edge: true, passes: vec![] };
    }
    let passes = if fabric.stretch { vec![45.0, -45.0] } else { vec![90.0] };
    FillUnderlay { edge: true, passes }
}

/// The underlay of a satin column of (mean) width `w` on a fabric.
pub fn satin_underlay(w: f64, p: &SatinParams, fabric: &FabricProfile) -> SatinUnderlay {
    if !p.underlay_auto {
        return SatinUnderlay { center: p.center_walk, contour: p.contour_underlay, zigzag: p.zigzag_underlay };
    }
    let (none, center, contour) = match (fabric.delicate, fabric.stretch) {
        (true, _) => (1.5, 3.0, 5.0),
        (_, true) => (1.0, 2.0, 3.0),
        _ => (1.2, 2.5, 4.0),
    };
    let s = |center, contour, zigzag| SatinUnderlay { center, contour, zigzag };
    if w < none {
        s(false, false, false)
    } else if w < center {
        s(true, false, false)
    } else if w < contour || fabric.knockdown {
        s(false, true, false)
    } else {
        s(false, true, true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Fabric;

    fn rect(w: f64, h: f64) -> Vec<Ring> {
        vec![vec![pt(0.0, 0.0), pt(w, 0.0), pt(w, h), pt(0.0, h)]]
    }

    #[test]
    fn width_is_the_thickness() {
        let w = shape_width(&rect(60.0, 4.0));
        assert!((w - 4.0).abs() < 0.5, "{w}");
        let w = shape_width(&rect(30.0, 30.0));
        assert!((w - 30.0).abs() < 2.0, "{w}");
    }

    #[test]
    fn auto_fill_underlay_follows_size_and_fabric() {
        let p = FillParams { underlay_auto: true, ..Default::default() };
        let cotton = Fabric::Cotton.profile();
        assert!(fill_underlay(&rect(30.0, 1.5), &p, &cotton).is_empty(), "tiny: none");
        assert_eq!(fill_underlay(&rect(40.0, 5.0), &p, &cotton), FillUnderlay { edge: true, passes: vec![] }, "narrow: edge run");
        assert_eq!(fill_underlay(&rect(40.0, 30.0), &p, &cotton), FillUnderlay { edge: true, passes: vec![90.0] }, "large: edge run + tatami");
        let knit = Fabric::Knit.profile();
        assert_eq!(fill_underlay(&rect(40.0, 30.0), &p, &knit).passes.len(), 2, "stretchy: cross-hatched");
        let mut towel = Fabric::Towel.profile();
        towel.knockdown = true;
        assert_eq!(fill_underlay(&rect(40.0, 30.0), &p, &towel), FillUnderlay { edge: true, passes: vec![] }, "knockdown: the net is the underlay");
        // by hand: as set
        let manual = FillParams { underlay: true, underlay_edge: true, underlay_cross: true, ..Default::default() };
        assert_eq!(fill_underlay(&rect(40.0, 30.0), &manual, &cotton), FillUnderlay { edge: true, passes: vec![45.0, 135.0] });
    }

    #[test]
    fn auto_satin_underlay_follows_width() {
        let p = SatinParams { underlay_auto: true, ..Default::default() };
        let f = Fabric::Cotton.profile();
        let u = |w| satin_underlay(w, &p, &f);
        assert_eq!(u(1.0), SatinUnderlay { center: false, contour: false, zigzag: false });
        assert_eq!(u(2.0), SatinUnderlay { center: true, contour: false, zigzag: false });
        assert_eq!(u(3.0), SatinUnderlay { center: false, contour: true, zigzag: false });
        assert_eq!(u(6.0), SatinUnderlay { center: false, contour: true, zigzag: true });
        // stretchy fabric: zig-zag from 3 mm
        assert!(satin_underlay(3.5, &p, &Fabric::Fleece.profile()).zigzag);
    }
}
