//! Exact polygon booleans and offsets on rings (mm), built on
//! [clipper2-rust](https://github.com/larsbrubaker/clipper2-rust) (a pure
//! Rust port of Angus Johnson's Clipper2, Boost Software License 1.0), and
//! curve fitting of polygon results back to smooth Béziers with
//! [kurbo](https://github.com/linebender/kurbo) (Apache-2.0 / MIT).
//!
//! Regions are `PathsD` normalised to Clipper's orientation (outers and holes
//! wound oppositely), so they combine with the non-zero rule.

use clipper2_rust::{self as c2, EndType, FillRule, JoinType, PathD, PathsD};

use crate::geom::{pt, signed_area, Point, Ring};
use crate::model::{Node, SubPath};

/// Decimal places Clipper keeps (µm).
const PREC: i32 = 3;
/// Arc tolerance of round joins (mm).
const ARC_TOL: f64 = 0.01;

pub type Region = PathsD;

fn path_of(r: &[Point]) -> PathD {
    r.iter().map(|p| c2::Point::new(p.x, p.y)).collect()
}

/// Rings → a normalised region (even-odd, so overlapping sub-paths make holes).
pub fn region(rings: &[Ring]) -> Region {
    let paths: PathsD = rings.iter().filter(|r| r.len() >= 3).map(|r| path_of(r)).collect();
    if paths.is_empty() {
        return vec![];
    }
    c2::union_subjects_d(&paths, FillRule::EvenOdd, PREC)
}

/// Simple polygons, each filled on its own (their union).
pub fn polygons(polys: &[Ring]) -> Region {
    let paths: PathsD = polys
        .iter()
        .filter(|r| r.len() >= 3)
        .map(|r| {
            let mut r = r.clone();
            if signed_area(&r) < 0.0 {
                r.reverse();
            }
            path_of(&r)
        })
        .collect();
    if paths.is_empty() {
        return vec![];
    }
    c2::union_subjects_d(&paths, FillRule::NonZero, PREC)
}

/// A band of half-width `half` around a polyline (round caps and joins).
pub fn band(pts: &[Point], half: f64) -> Region {
    if pts.len() < 2 || !half.is_finite() || half <= 0.0 {
        return vec![];
    }
    let path = path_of(pts);
    let size = extent(&vec![path.clone()]);
    if !size.is_finite() {
        return vec![];
    }
    let half = half.min(MAX_GROW.max(size));
    c2::inflate_paths_d(&vec![path], half, JoinType::Round, EndType::Round, 2.0, PREC, ARC_TOL)
}

/// Furthest a region grows in one offset (mm), unless the region is larger:
/// round joins take points in proportion to √delta, so an absurd offset
/// (1e300, ∞) would exhaust memory.
const MAX_GROW: f64 = 1000.0;

/// The extent of a region (its bounding box's larger side).
fn extent(r: &Region) -> f64 {
    let (mut x0, mut y0, mut x1, mut y1) = (f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
    for p in r.iter().flatten() {
        x0 = x0.min(p.x);
        y0 = y0.min(p.y);
        x1 = x1.max(p.x);
        y1 = y1.max(p.y);
    }
    if x1 < x0 { 0.0 } else { (x1 - x0).max(y1 - y0) }
}

/// A usable offset distance for a region: `None` for a non-finite one,
/// shrinking past the whole region stops at its size (empty either way),
/// growing is capped at [`MAX_GROW`] or the region's own size.
fn sane_delta(r: &Region, delta: f64) -> Option<f64> {
    if !delta.is_finite() {
        return None;
    }
    let size = extent(r);
    if !size.is_finite() {
        return None;
    }
    Some(delta.clamp(-(size + 1.0), MAX_GROW.max(size)))
}

/// Grow (positive) or shrink (negative) a region with round corners.
/// A non-finite offset leaves the region as it is.
pub fn offset(r: &Region, delta: f64) -> Region {
    if delta.abs() < 1e-9 || r.is_empty() {
        return r.clone();
    }
    let Some(delta) = sane_delta(r, delta) else { return r.clone() };
    c2::inflate_paths_d(r, delta, JoinType::Round, EndType::Polygon, 2.0, PREC, ARC_TOL)
}

/// Corner style of [`offset_joined`] (Ink/Stitch's knockdown join styles).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Join {
    Round,
    Mitre,
    Bevel,
}

/// Grow or shrink a region with the given corner style; mitres reaching
/// further than `mitre_limit` × the offset are cut off.
pub fn offset_joined(r: &Region, delta: f64, join: Join, mitre_limit: f64) -> Region {
    if delta.abs() < 1e-9 || r.is_empty() {
        return r.clone();
    }
    let Some(delta) = sane_delta(r, delta) else { return r.clone() };
    let jt = match join {
        Join::Round => JoinType::Round,
        Join::Mitre => JoinType::Miter,
        Join::Bevel => JoinType::Bevel,
    };
    c2::inflate_paths_d(r, delta, jt, EndType::Polygon, mitre_limit.max(1.0), PREC, ARC_TOL)
}

pub fn union(a: &Region, b: &Region) -> Region {
    if a.is_empty() {
        return b.clone();
    }
    if b.is_empty() {
        return a.clone();
    }
    c2::union_d(a, b, FillRule::NonZero, PREC)
}

pub fn union_all<'a>(rs: impl IntoIterator<Item = &'a Region>) -> Region {
    let all: PathsD = rs.into_iter().flatten().cloned().collect();
    if all.is_empty() {
        return vec![];
    }
    c2::union_subjects_d(&all, FillRule::NonZero, PREC)
}

pub fn difference(a: &Region, b: &Region) -> Region {
    if a.is_empty() || b.is_empty() {
        return a.clone();
    }
    c2::difference_d(a, b, FillRule::NonZero, PREC)
}

pub fn intersect(a: &Region, b: &Region) -> Region {
    if a.is_empty() || b.is_empty() {
        return vec![];
    }
    c2::intersect_d(a, b, FillRule::NonZero, PREC)
}

pub fn xor(a: &Region, b: &Region) -> Region {
    if a.is_empty() {
        return b.clone();
    }
    if b.is_empty() {
        return a.clone();
    }
    c2::xor_d(a, b, FillRule::NonZero, PREC)
}

/// Area of a region (holes subtract).
pub fn area(r: &Region) -> f64 {
    r.iter().map(|p| c2::area(p)).sum::<f64>().abs()
}

/// Region → rings (even-odd: holes are separate rings).
pub fn rings(r: &Region) -> Vec<Ring> {
    r.iter()
        .map(|p| p.iter().map(|q| pt(q.x, q.y)).collect::<Ring>())
        .filter(|ring: &Ring| ring.len() >= 3 && signed_area(ring).abs() > 1e-6)
        .collect()
}

// ---------------------------------------------------------------------------
// Polygon → smooth Bézier sub-path (kurbo)

/// A ring the curve fitter can take: finite points only, no (near-)duplicate
/// neighbours, and no zero-width spikes (a vertex the outline doubles back
/// through, which would put a cusp in the fitted curve).
fn clean_ring(ring: &[Point]) -> Vec<Point> {
    const EPS: f64 = 1e-6;
    let mut r: Vec<Point> = Vec::with_capacity(ring.len());
    for &q in ring {
        if q.x.is_finite() && q.y.is_finite() && r.last().map_or(true, |l: &Point| l.dist(q) > EPS) {
            r.push(q);
        }
    }
    while r.len() > 2 && r[0].dist(*r.last().unwrap()) <= EPS {
        r.pop();
    }
    // each pass removes at least one point or stops, so this terminates
    loop {
        let n = r.len();
        if n < 3 {
            return r;
        }
        let spike = (0..n).find(|&i| {
            let (a, b, c) = (r[(i + n - 1) % n], r[i], r[(i + 1) % n]);
            let (u, v) = (b - a, c - b);
            let (lu, lv) = (u.length(), v.length());
            // collinear and reversing: c lies back along a→b
            a.dist(c) <= EPS || (u.cross(v).abs() <= 1e-9 * lu * lv && u.dot(v) < 0.0)
        });
        let Some(i) = spike else { return r };
        let (a, c) = (r[(i + n - 1) % n], r[(i + 1) % n]);
        r.remove(i);
        // the spike's two sides may now meet in a duplicate
        if a.dist(c) <= EPS && r.len() > 2 {
            let j = i % r.len();
            r.remove(j);
        }
    }
}

/// Fit a closed polygon with smooth cubic Béziers, keeping corners that turn
/// more than `corner_deg`. `accuracy` is the allowed deviation (mm).
pub fn fit_ring(ring: &[Point], accuracy: f64, corner_deg: f64) -> SubPath {
    use kurbo::{BezPath, PathEl};
    let accuracy = if accuracy.is_finite() && accuracy > 0.0 { accuracy } else { 0.02 };
    let ring = clean_ring(ring);
    let ring = &ring[..];
    let n = ring.len();
    if n < 3 {
        return SubPath::polyline(ring, true);
    }
    // Catmull-Rom through the smooth vertices; corners keep one-sided
    // tangents so kurbo sees the tangent break and keeps them sharp
    let cos_corner = corner_deg.to_radians().cos();
    let dir = |a: Point, b: Point| {
        let d = b - a;
        let l = d.length();
        if l < 1e-12 { pt(0.0, 0.0) } else { d * (1.0 / l) }
    };
    let corner: Vec<bool> = (0..n)
        .map(|i| {
            let a = ring[(i + n - 1) % n];
            let b = ring[i];
            let c = ring[(i + 1) % n];
            dir(a, b).dot(dir(b, c)) < cos_corner
        })
        .collect();
    let tangent = |i: usize| -> (Point, Point) {
        let a = ring[(i + n - 1) % n];
        let b = ring[i];
        let c = ring[(i + 1) % n];
        if corner[i] {
            // handles along the adjoining edges (a sharp joint)
            ((a - b) * (1.0 / 3.0), (c - b) * (1.0 / 3.0))
        } else {
            let t = (c - a) * (1.0 / 6.0);
            let lin = b.dist(a) / (b.dist(a) + b.dist(c)).max(1e-12);
            (t * (-2.0 * lin), t * (2.0 * (1.0 - lin)))
        }
    };
    let k = |p: Point| kurbo::Point::new(p.x, p.y);
    let mut path = BezPath::new();
    path.move_to(k(ring[0]));
    for i in 0..n {
        let j = (i + 1) % n;
        let (_, out_i) = tangent(i);
        let (in_j, _) = tangent(j);
        path.push(PathEl::CurveTo(k(ring[i] + out_i), k(ring[j] + in_j), k(ring[j])));
    }
    path.close_path();
    // our port of kurbo's simplifier: kurbo's own can loop forever (bezfit.rs)
    let simple = crate::bezfit::simplify_bezpath(path, accuracy, 0.2);
    let mut nodes: Vec<Node> = Vec::new();
    let mut last_out: Option<[f64; 2]> = None;
    for el in simple.elements() {
        match *el {
            PathEl::MoveTo(p) => nodes.push(Node::corner(p.x, p.y)),
            PathEl::LineTo(p) => {
                if let (Some(o), Some(prev)) = (last_out.take(), nodes.last_mut()) {
                    prev.o = Some(o);
                }
                nodes.push(Node::corner(p.x, p.y));
            }
            PathEl::CurveTo(c1, c2p, p) => {
                if let Some(prev) = nodes.last_mut() {
                    prev.o = Some([c1.x, c1.y]);
                }
                nodes.push(Node { p: [p.x, p.y], i: Some([c2p.x, c2p.y]), o: None });
            }
            PathEl::QuadTo(c, p) => {
                let p0 = nodes.last().map(|n| n.p).unwrap_or([p.x, p.y]);
                if let Some(prev) = nodes.last_mut() {
                    prev.o = Some([p0[0] + (c.x - p0[0]) * 2.0 / 3.0, p0[1] + (c.y - p0[1]) * 2.0 / 3.0]);
                }
                nodes.push(Node { p: [p.x, p.y], i: Some([p.x + (c.x - p.x) * 2.0 / 3.0, p.y + (c.y - p.y) * 2.0 / 3.0]), o: None });
            }
            PathEl::ClosePath => {}
        }
    }
    // the closing point repeats the first: fold its in-handle into node 0
    if nodes.len() > 1 {
        let last = *nodes.last().unwrap();
        if (last.p[0] - nodes[0].p[0]).abs() < 1e-7 && (last.p[1] - nodes[0].p[1]).abs() < 1e-7 {
            nodes.pop();
            nodes[0].i = last.i;
        }
    }
    // guard: a runaway fit falls back to the polygon itself
    let near = |q: [f64; 2]| {
        let q = Point::from_arr(q);
        (0..n).any(|i| {
            let (a, b) = (ring[i], ring[(i + 1) % n]);
            let d = b - a;
            let t = ((q - a).dot(d) / d.length_sq().max(1e-12)).clamp(0.0, 1.0);
            (a + d * t).dist(q) <= accuracy * 6.0 + 0.5
        })
    };
    let fitted = SubPath { nodes: nodes.clone(), closed: true };
    if fitted.flatten(0.1).iter().any(|q| !q.x.is_finite() || !near(q.arr())) {
        return SubPath::polyline(ring, true);
    }
    // straight segments become plain lines (corner nodes without handles)
    let m = nodes.len();
    for s in 0..m {
        let t = (s + 1) % m;
        let (a, b) = (Point::from_arr(nodes[s].p), Point::from_arr(nodes[t].p));
        let chord = b - a;
        let l = chord.length();
        let off = |q: Option<[f64; 2]>| q.map_or(0.0, |q| if l < 1e-9 { 0.0 } else { (Point::from_arr(q) - a).cross(chord).abs() / l });
        if off(nodes[s].o) < 1e-3 && off(nodes[t].i) < 1e-3 {
            nodes[s].o = None;
            nodes[t].i = None;
        }
    }
    SubPath { nodes, closed: true }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn square(x: f64, y: f64, s: f64) -> Ring {
        vec![pt(x, y), pt(x + s, y), pt(x + s, y + s), pt(x, y + s)]
    }

    #[test]
    fn exact_booleans() {
        let a = region(&[square(0.0, 0.0, 20.0)]);
        let b = region(&[square(10.0, 0.0, 20.0)]);
        assert!((area(&union(&a, &b)) - 600.0).abs() < 1e-3);
        assert!((area(&difference(&a, &b)) - 200.0).abs() < 1e-3);
        assert!((area(&intersect(&a, &b)) - 200.0).abs() < 1e-3);
        assert!((area(&xor(&a, &b)) - 400.0).abs() < 1e-3);
    }

    #[test]
    fn even_odd_holes() {
        let r = region(&[square(0.0, 0.0, 20.0), square(5.0, 5.0, 10.0)]);
        assert!((area(&r) - 300.0).abs() < 1e-3);
        assert_eq!(rings(&r).len(), 2);
    }

    #[test]
    fn absurd_offsets_are_refused_or_clamped() {
        let sq = region(&[square(0.0, 0.0, 10.0)]);
        // non-finite: the region as it is
        for d in [f64::INFINITY, f64::NEG_INFINITY, f64::NAN] {
            assert_eq!(offset(&sq, d), sq);
            assert_eq!(offset_joined(&sq, d, Join::Mitre, 4.0), sq);
            assert!(band(&[pt(0.0, 0.0), pt(10.0, 0.0)], d).is_empty());
        }
        // huge: grows by at most MAX_GROW, shrinks to nothing
        let big = offset(&sq, 1e300);
        assert!(!big.is_empty() && area(&big) < (2.0 * MAX_GROW + 20.0).powi(2));
        assert!(offset(&sq, -1e300).is_empty());
        assert!(!offset_joined(&sq, 1e300, Join::Round, 4.0).is_empty());
        assert!(!band(&[pt(0.0, 0.0), pt(10.0, 0.0)], 1e300).is_empty());
    }

    #[test]
    fn round_offset() {
        let r = offset(&region(&[square(0.0, 0.0, 10.0)]), 2.0);
        let want = 100.0 + 4.0 * 20.0 + std::f64::consts::PI * 4.0;
        assert!((area(&r) - want).abs() < 0.15, "{}", area(&r));
        let s = offset(&region(&[square(0.0, 0.0, 10.0)]), -2.0);
        assert!((area(&s) - 36.0).abs() < 1e-3);
    }

    #[test]
    fn fitted_circle_is_few_curves() {
        let ring: Ring = (0..200).map(|i| {
            let a = i as f64 / 200.0 * std::f64::consts::TAU;
            pt(10.0 * a.cos(), 10.0 * a.sin())
        }).collect();
        let sp = fit_ring(&ring, 0.02, 30.0);
        assert!(sp.nodes.len() <= 12, "{} nodes", sp.nodes.len());
        for p in sp.flatten(0.01) {
            assert!((p.length() - 10.0).abs() < 0.05, "{p:?}");
        }
        // a square keeps its four corners
        let sq = fit_ring(&square(0.0, 0.0, 10.0), 0.02, 30.0);
        assert_eq!(sq.nodes.len(), 4, "{:?}", sq.nodes);
    }
}

#[cfg(test)]
mod fit_tests {
    use super::*;

    #[test]
    fn straight_edges_have_no_handles() {
        let sq: Ring = vec![pt(0.0, 0.0), pt(10.0, 0.0), pt(10.0, 10.0), pt(0.0, 10.0)];
        let sp = fit_ring(&sq, 0.02, 30.0);
        assert!(sp.nodes.iter().all(|n| n.i.is_none() && n.o.is_none()), "{:?}", sp.nodes);
    }

    /// From auto-digitizing a 97×97 noise image: kurbo 0.13's simplifier
    /// never returned on this ring (a 1e12-long candidate arm sent its
    /// arc-length root finder into an endless loop).
    #[test]
    fn fit_ring_terminates_on_degenerate_tangents() {
        let r = [
            (0.066, 48.471000000000004), (0.089, 48.481), (1.738, 49.306000000000004), (1.776, 49.343),
            (1.817, 49.377), (1.821, 49.388), (1.827, 49.394), (1.829, 49.408), (1.846, 49.452),
            (2.6710000000000003, 54.4), (2.652, 54.524), (2.564, 54.612), (2.474, 54.633), (0.0, 54.633),
            (-0.11900000000000001, 54.594), (-0.191, 54.492000000000004), (-0.2, 54.433), (-0.2, 51.959),
            (-0.161, 51.84), (-0.059000000000000004, 51.768), (-0.02, 51.76), (0.716, 51.686),
            (1.036, 51.583), (1.208, 51.441), (1.325, 51.218), (1.41, 50.774), (1.439, 49.813),
            (0.089, 50.488), (-0.034, 50.506), (-0.14400000000000002, 50.447), (-0.198, 50.335),
            (-0.2, 50.309), (-0.2, 48.660000000000004), (-0.161, 48.541000000000004),
            (-0.059000000000000004, 48.469),
        ];
        let ring: Ring = r.iter().map(|&(x, y)| pt(x, y)).collect();
        let t = std::time::Instant::now();
        let sp = fit_ring(&ring, 0.02, 35.0);
        assert!(t.elapsed().as_secs_f64() < 2.0, "{:?}", t.elapsed());
        assert!(sp.nodes.len() >= 3);
        // the fit stays on the outline
        for q in sp.flatten(0.01) {
            let d = (0..ring.len())
                .map(|i| {
                    let (a, b) = (ring[i], ring[(i + 1) % ring.len()]);
                    let e = b - a;
                    let t = ((q - a).dot(e) / e.length_sq()).clamp(0.0, 1.0);
                    (a + e * t).dist(q)
                })
                .fold(f64::INFINITY, f64::min);
            assert!(d < 0.1, "{q:?} is {d} off");
        }
    }

    #[test]
    fn fit_ring_survives_bad_points() {
        let nan = f64::NAN;
        let rings: Vec<Ring> = vec![
            vec![pt(0.0, 0.0), pt(nan, 1.0), pt(10.0, 0.0), pt(10.0, 10.0), pt(0.0, 10.0)],
            // a zero-width spike and repeated points
            vec![pt(0.0, 0.0), pt(10.0, 0.0), pt(15.0, 0.0), pt(10.0, 0.0), pt(10.0, 0.0), pt(10.0, 10.0), pt(0.0, 10.0)],
            vec![pt(0.0, 0.0), pt(1.0, 0.0), pt(0.0, 0.0)],
            vec![pt(1.0, 1.0); 5],
            vec![],
        ];
        for r in &rings {
            let sp = fit_ring(r, 0.02, 35.0);
            assert!(sp.nodes.iter().all(|n| n.p[0].is_finite() && n.p[1].is_finite()), "{:?}", sp.nodes);
        }
        assert!(fit_ring(&rings[0], f64::NAN, 35.0).nodes.len() >= 3);
    }
}
