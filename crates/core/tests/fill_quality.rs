//! Fill quality against Ink/Stitch (the reference implementation): no trims
//! or jumps inside a connected fill, travel hidden under rows sewn later,
//! contour fills without masses of tiny stitches, circular fills without the
//! outline sewn over and over, and shapes of several islands sewn island by
//! island (underlay, then top).
//!
//! The bounds come from Ink/Stitch 3.1.0 on the same shapes (row spacing
//! 0.25 mm, stitch length 3 mm, running stitch 2.5 mm), with some margin.

use std::f64::consts::TAU;

use filum_core::geom::{dist_to_boundary, point_in_rings, pt, Point, Ring};
use filum_core::model::{FillMethod, FillParams, SubPath, TatamiRoute};
use filum_core::plan::flags;
use filum_core::stitches::fill::fill;
use filum_core::stitches::Run;

fn circ(cx: f64, cy: f64, r: f64, n: usize, ccw: bool) -> Ring {
    let mut v: Ring = (0..n).map(|i| { let a = TAU * i as f64 / n as f64; pt(cx + r * a.cos(), cy + r * a.sin()) }).collect();
    if ccw {
        v.reverse();
    }
    v
}

fn rect(x: f64, y: f64, w: f64, h: f64) -> Ring {
    vec![pt(x, y), pt(x + w, y), pt(x + w, y + h), pt(x, y + h)]
}

fn arc(cx: f64, cy: f64, r: f64, a0: f64, a1: f64, n: usize) -> Vec<Point> {
    (0..=n).map(|i| { let a = (a0 + (a1 - a0) * i as f64 / n as f64).to_radians(); pt(cx + r * a.cos(), cy + r * a.sin()) }).collect()
}

fn star() -> Ring {
    (0..10).map(|i| { let r = if i % 2 == 0 { 30.0 } else { 12.0 }; let a = -TAU / 4.0 + TAU / 2.0 * i as f64 / 5.0; pt(50.0 + r * a.cos(), 50.0 + r * a.sin()) }).collect()
}

/// A thick S: two arcs of a centre line, 6 mm wide.
fn s_shape() -> Ring {
    let mut cl = arc(50.0, 38.0, 10.0, -30.0, -270.0, 60);
    cl.extend(arc(50.0, 58.0, 10.0, -90.0, 150.0, 60).into_iter().skip(1));
    let (mut left, mut right) = (Vec::new(), Vec::new());
    for i in 0..cl.len() {
        let (a, b) = (cl[i.saturating_sub(1)], cl[(i + 1).min(cl.len() - 1)]);
        let d = (b - a).unit();
        let nrm = pt(-d.y, d.x);
        left.push(cl[i] + nrm * 3.0);
        right.push(cl[i] - nrm * 3.0);
    }
    right.reverse();
    left.extend(right);
    left
}

fn holes16() -> Vec<Ring> {
    let mut v = vec![rect(30.0, 30.0, 40.0, 40.0)];
    for i in 0..4 {
        for j in 0..4 {
            v.push(circ(35.0 + 10.0 * i as f64, 35.0 + 10.0 * j as f64, 2.5, 48, true));
        }
    }
    v
}

fn cshape() -> Vec<Ring> {
    let mut r = arc(50.0, 50.0, 22.0, 40.0, 320.0, 60);
    r.extend(arc(50.0, 50.0, 12.0, 320.0, 40.0, 60));
    vec![r]
}

fn neck() -> Vec<Ring> {
    vec![[(20., 30.), (45., 30.), (49., 48.), (51., 48.), (55., 30.), (80., 30.), (80., 70.), (55., 70.), (51., 52.), (49., 52.), (45., 70.), (20., 70.)].iter().map(|&(x, y)| pt(x, y)).collect()]
}

fn ring_shape() -> Vec<Ring> {
    vec![circ(50.0, 50.0, 20.0, 180, false), circ(50.0, 50.0, 10.0, 180, true)]
}

fn paths(rings: &[Ring]) -> Vec<SubPath> {
    rings.iter().map(|r| SubPath::polyline(r, true)).collect()
}

fn params(method: FillMethod, underlay: bool) -> FillParams {
    FillParams { method, underlay, underlay_inset: 0.0, row_spacing: 0.25, max_stitch_length: 3.0, travel_length: 2.5, ..FillParams::default() }
}

fn sew(rings: &[Ring], p: &FillParams) -> Vec<Run> {
    fill(&paths(rings), p, 0.0, 1.0, false, 1.0, None, None)
}

/// Stitches (segments) of the runs with the flags of their end.
fn segments(runs: &[Run]) -> Vec<(Point, Point, u8)> {
    runs.iter().flat_map(|r| r.windows(2).map(|w| (w[0].0, w[1].0, w[1].1))).collect()
}

fn travel_mm(runs: &[Run]) -> f64 {
    segments(runs).iter().filter(|s| s.2 & flags::TRAVEL != 0).map(|s| s.0.dist(s.1)).sum()
}

fn thread_mm(runs: &[Run]) -> f64 {
    segments(runs).iter().map(|s| s.0.dist(s.1)).sum()
}

fn seg_dist(p: Point, a: Point, b: Point) -> f64 {
    let e = b - a;
    let l2 = e.length_sq();
    let t = if l2 > 1e-18 { ((p - a).dot(e) / l2).clamp(0.0, 1.0) } else { 0.0 };
    (a + e * t).dist(p)
}

/// Segments by grid cell (1 mm) with their index in sewing order.
struct Grid(std::collections::HashMap<(i64, i64), Vec<usize>>);

impl Grid {
    fn new(segs: &[(Point, Point, u8)], keep: impl Fn(&(Point, Point, u8)) -> bool) -> Grid {
        let mut m: std::collections::HashMap<(i64, i64), Vec<usize>> = Default::default();
        for (i, s) in segs.iter().enumerate().filter(|(_, s)| keep(s)) {
            let n = (s.0.dist(s.1) / 0.5).ceil().max(1.0) as usize;
            let mut cells: Vec<(i64, i64)> = (0..=n).map(|k| { let q = s.0.lerp(s.1, k as f64 / n as f64); (q.x.floor() as i64, q.y.floor() as i64) }).collect();
            cells.sort_unstable();
            cells.dedup();
            for c in cells {
                m.entry(c).or_default().push(i);
            }
        }
        Grid(m)
    }
    fn near(&self, p: Point) -> impl Iterator<Item = usize> + '_ {
        let (x, y) = (p.x.floor() as i64, p.y.floor() as i64);
        (x - 1..=x + 1).flat_map(move |i| (y - 1..=y + 1).filter_map(move |j| self.0.get(&(i, j)))).flatten().copied()
    }
}

/// Travel that shows: lying on rows (within 0.3 mm) sewn before it and
/// covered by none sewn after it (the comparison's "visible travel").
fn visible_travel_mm(runs: &[Run]) -> f64 {
    let segs = segments(runs);
    let is_row = |s: &(Point, Point, u8)| s.2 & (flags::TRAVEL | flags::UNDERLAY) == 0 && s.0.dist(s.1) > 0.8 && (s.1.y - s.0.y).abs() < 0.05 * s.0.dist(s.1);
    let grid = Grid::new(&segs, is_row);
    let mut vis = 0.0;
    for (i, s) in segs.iter().enumerate() {
        if s.2 & flags::TRAVEL == 0 || s.0.dist(s.1) < 0.3 {
            continue;
        }
        let n = (s.0.dist(s.1) / 0.2).ceil().max(1.0) as usize;
        for k in 0..n {
            let p = s.0.lerp(s.1, (k as f64 + 0.5) / n as f64);
            let (mut before, mut after) = (false, false);
            for j in grid.near(p) {
                if seg_dist(p, segs[j].0, segs[j].1) < 0.3 {
                    if j < i { before = true } else { after = true }
                }
            }
            if before && !after {
                vis += s.0.dist(s.1) / n as f64;
            }
        }
    }
    vis
}

/// Share of the shape (more than 0.5 mm inside) within `reach` of a top stitch.
fn coverage(rings: &[Ring], runs: &[Run], reach: f64) -> f64 {
    let segs = segments(runs);
    let grid = Grid::new(&segs, |s| s.2 & flags::UNDERLAY == 0);
    let b = rings.iter().flatten().fold((f64::MAX, f64::MAX, f64::MIN, f64::MIN), |b, p| (b.0.min(p.x), b.1.min(p.y), b.2.max(p.x), b.3.max(p.y)));
    let (mut n, mut hit) = (0, 0);
    let mut y = b.1;
    while y < b.3 {
        let mut x = b.0;
        while x < b.2 {
            let p = pt(x, y);
            if point_in_rings(p, rings) && dist_to_boundary(rings, p) > 0.5 {
                n += 1;
                if grid.near(p).any(|j| seg_dist(p, segs[j].0, segs[j].1) <= reach) {
                    hit += 1;
                }
            }
            x += 0.37;
        }
        y += 0.37;
    }
    hit as f64 / n.max(1) as f64
}

fn short_share(runs: &[Run]) -> f64 {
    let segs = segments(runs);
    let short = segs.iter().filter(|s| { let l = s.0.dist(s.1); l > 0.05 && l < 0.5 }).count();
    short as f64 / segs.len().max(1) as f64
}

#[test]
fn tatami_sews_a_connected_shape_in_one_run() {
    // pockets between holes and arms stay reachable along the outline
    let shapes: Vec<(&str, Vec<Ring>)> = vec![
        ("16 holes", holes16()),
        ("star", vec![star()]),
        ("C", cshape()),
        ("neck", neck()),
        ("S", vec![s_shape()]),
        ("ring", ring_shape()),
    ];
    for (name, rings) in &shapes {
        for underlay in [false, true] {
            for angle in [0.0, 45.0, 90.0] {
                let p = FillParams { angle, ..params(FillMethod::Tatami, underlay) };
                let runs = sew(rings, &p);
                assert_eq!(runs.len(), 1, "{name} (underlay {underlay}, {angle}°): one run, no jump or trim; got {}", runs.len());
                assert!(coverage(rings, &runs, 0.3) > 0.995, "{name}: covered");
            }
        }
    }
}

#[test]
fn tatami_travel_hides_under_later_rows() {
    // Ink/Stitch: ~10 mm of travel shows on the S, ~0 on the square
    let ink = FillParams { tatami_route: TatamiRoute::InkStitch, ..params(FillMethod::Tatami, false) };
    for (name, rings, max_vis, max_travel) in [("S", vec![s_shape()], 20.0, 200.0), ("square", vec![rect(30.0, 30.0, 40.0, 40.0)], 1.0, 150.0), ("star", vec![star()], 10.0, 150.0)] {
        let runs = sew(&rings, &ink);
        let vis = visible_travel_mm(&runs);
        let travel = travel_mm(&runs);
        assert!(vis < max_vis, "{name}: travel on top of sewn rows {vis:.1} mm");
        assert!(travel < max_travel, "{name}: travel {travel:.1} mm");
    }
    // one way: a branch left behind (the star's second leg) is reached back
    // up along the outline, never across sewn rows
    for (name, rings, max_vis, max_travel) in [("S", vec![s_shape()], 25.0, 200.0), ("square", vec![rect(30.0, 30.0, 40.0, 40.0)], 1.0, 150.0), ("star", vec![star()], 25.0, 150.0)] {
        let runs = sew(&rings, &params(FillMethod::Tatami, false));
        let vis = visible_travel_mm(&runs);
        let travel = travel_mm(&runs);
        assert!(vis < max_vis, "one way, {name}: travel on top of sewn rows {vis:.1} mm");
        assert!(travel < max_travel, "one way, {name}: travel {travel:.1} mm");
    }
}

#[test]
fn tatami_without_an_end_finishes_where_it_started() {
    // Ink/Stitch's stitch path is a circuit from the start back to it
    let sq = vec![rect(30.0, 30.0, 40.0, 40.0)];
    let start = pt(30.0, 30.0);
    let ink = FillParams { tatami_route: TatamiRoute::InkStitch, ..params(FillMethod::Tatami, false) };
    let runs = fill(&paths(&sq), &ink, 0.0, 1.0, false, 1.0, Some(start), None);
    let last = runs.last().unwrap().last().unwrap().0;
    assert!(last.dist(start) < 1.0, "ends at {last:?}");
    // one way: it ends on the bottom row
    let runs = fill(&paths(&sq), &params(FillMethod::Tatami, false), 0.0, 1.0, false, 1.0, Some(start), None);
    let last = runs.last().unwrap().last().unwrap().0;
    assert!(last.y > 69.5, "one way ends at the bottom: {last:?}");
    // with an end point both end there (one way: an end at the top turns it round)
    for p in [ink, params(FillMethod::Tatami, false)] {
        for end in [pt(70.0, 70.0), pt(60.0, 31.0)] {
            let runs = fill(&paths(&sq), &p, 0.0, 1.0, false, 1.0, Some(start), Some(end));
            let last = runs.last().unwrap().last().unwrap().0;
            assert!(last.dist(end) < 0.5, "{:?}: ends at {last:?}, not {end:?}", p.tatami_route);
        }
    }
}

#[test]
fn circular_fill_does_not_sew_the_outline_over_and_over() {
    // Ink/Stitch: star 4.45 m of thread, 40 mm square 6.6 m (Filum sewed 12 m and 9.7 m)
    for (name, rings, max_thread, max_travel) in [("star", vec![star()], 4900.0, 400.0), ("square", vec![rect(30.0, 30.0, 40.0, 40.0)], 7000.0, 300.0), ("ring", ring_shape(), 4400.0, 400.0)] {
        let p = FillParams { max_stitch_length: 2.5, ..params(FillMethod::Circular, false) };
        let runs = sew(&rings, &p);
        assert_eq!(runs.len(), 1, "{name}: one run");
        let (thread, travel) = (thread_mm(&runs), travel_mm(&runs));
        assert!(thread < max_thread, "{name}: {thread:.0} mm of thread");
        assert!(travel < max_travel, "{name}: {travel:.0} mm of travel");
        assert!(coverage(&rings, &runs, 0.3) > 0.99, "{name}: covered");
        assert!(short_share(&runs) < 0.2, "{name}: short stitches {:.3}", short_share(&runs));
    }
}

#[test]
fn contour_fill_has_few_short_stitches() {
    // Ink/Stitch on a 40 mm circle: 1758 stitches, 3 shorter than 0.5 mm
    let circle = vec![circ(50.0, 50.0, 20.0, 180, false)];
    for (spiral, double) in [(false, false), (true, false), (true, true)] {
        let method = if spiral { FillMethod::Spiral } else { FillMethod::Contour };
        let p = FillParams { contour_double: double, ..params(method, false) };
        let runs = sew(&circle, &p);
        assert_eq!(runs.len(), 1);
        let n = runs[0].len();
        assert!((1600..2000).contains(&n), "spiral {spiral} double {double}: {n} stitches");
        assert!(short_share(&runs) < 0.01, "spiral {spiral} double {double}: short stitches {:.3}", short_share(&runs));
        assert!(coverage(&circle, &runs, 0.3) > 0.99);
    }
}

#[test]
fn contour_rings_are_evenly_spaced() {
    // a single spiral on a square: neighbouring turns one row spacing apart
    // (where the +x axis from the centre crosses them)
    let sq = vec![rect(30.0, 30.0, 40.0, 40.0)];
    let runs = sew(&sq, &params(FillMethod::Spiral, false));
    let along: Vec<f64> = {
        let pts: Vec<Point> = runs[0].iter().map(|x| x.0).collect();
        let mut v = Vec::new();
        for w in pts.windows(2) {
            let (a, b) = (w[0] - pt(50.0, 50.0), w[1] - pt(50.0, 50.0));
            if a.x > 0.0 && b.x > 0.0 && (a.y < 0.0) != (b.y < 0.0) {
                let t = a.y / (a.y - b.y);
                v.push(a.x + (b.x - a.x) * t);
            }
        }
        v.sort_by(|a, b| a.partial_cmp(b).unwrap());
        v
    };
    let gaps: Vec<f64> = along.windows(2).map(|w| w[1] - w[0]).filter(|g| *g > 0.05).collect();
    let mean = gaps.iter().sum::<f64>() / gaps.len() as f64;
    assert!(gaps.len() > 60 && (mean - 0.25).abs() < 0.01, "{} turns {mean:.3} mm apart", gaps.len());
    assert!(gaps.iter().all(|g| (g - 0.25).abs() < 0.03), "{gaps:?}");
}

#[test]
fn contour_inner_to_outer_ends_on_the_outline() {
    let circle = vec![circ(50.0, 50.0, 20.0, 180, false)];
    let runs = sew(&circle, &params(FillMethod::Contour, false));
    let last = runs.last().unwrap().last().unwrap().0;
    assert!(dist_to_boundary(&circle, last) < 0.5, "ends at {last:?}");
}

#[test]
fn contour_fill_with_holes_is_one_run() {
    // Ink/Stitch: no trims on a ring or a square with 16 holes (Filum had 14 and 195)
    for (name, rings) in [("ring", ring_shape()), ("16 holes", holes16())] {
        for (spiral, double) in [(false, false), (true, false), (true, true)] {
            let method = if spiral { FillMethod::Spiral } else { FillMethod::Contour };
            let p = FillParams { contour_double: double, ..params(method, false) };
            let runs = sew(&rings, &p);
            assert_eq!(runs.len(), 1, "{name} spiral {spiral} double {double}");
        }
        let runs = sew(&rings, &params(FillMethod::Contour, false));
        // between holes close together the rings leave gaps (Ink/Stitch's too)
        let c = coverage(&rings, &runs, 0.3);
        assert!(c > if name == "ring" { 0.99 } else { 0.97 }, "{name}: covered {c:.3}");
        assert!(short_share(&runs) < 0.03, "{name}: short stitches {:.3}", short_share(&runs));
    }
}

#[test]
fn islands_are_sewn_one_after_the_other() {
    // an O with a dot in it: Ink/Stitch sews the O's underlay and top, then
    // the dot's: one jump, no going back and forth
    let rings = vec![circ(50.0, 50.0, 22.0, 180, false), circ(50.0, 50.0, 14.0, 180, true), circ(50.0, 50.0, 5.0, 180, false)];
    let runs = sew(&rings, &params(FillMethod::Tatami, true));
    assert_eq!(runs.len(), 2, "one run per island");
    for r in &runs {
        let ul = r.iter().rposition(|x| x.1 & flags::UNDERLAY != 0).expect("underlay");
        let top = r.iter().position(|x| x.1 & (flags::UNDERLAY | flags::TRAVEL) == 0).expect("top");
        assert!(ul < top, "underlay first, then the top");
    }
    // Ink/Stitch: the O ends where the dot is nearest, so the jump is short
    // (one way: the O ends at its bottom)
    let ink = sew(&rings, &FillParams { tatami_route: TatamiRoute::InkStitch, ..params(FillMethod::Tatami, true) });
    let gap = ink[0].last().unwrap().0.dist(ink[1][0].0);
    assert!(gap < 10.0, "jump {gap:.1} mm");
    // contour and circular fills too
    for method in [FillMethod::Contour, FillMethod::Circular] {
        assert_eq!(sew(&rings, &params(method, false)).len(), 2, "{method:?}");
    }
}
