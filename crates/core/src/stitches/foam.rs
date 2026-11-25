//! A satin over 3D foam (Punch; from the NOVAstitch Designer fork): a satin
//! with its `foam` block.
//!
//! The operator lays a foam sheet on the fabric at a machine stop; the needle
//! perforates it along the satin's edges and the rest is torn away. So:
//!
//! - a machine stop before the object (to lay the foam);
//! - no fill underlay: only a straight-stitch contour, 1 pass (2 at most), and
//!   on wide columns (from 4 mm) a centre walk too;
//! - a denser satin (× 1.45: 0.40 → 0.28 mm);
//! - caps on the open ends (T, L, E): short satins across the end, their outer
//!   side on the shape's edge, their inner side uneven so they blend into the
//!   column; in the plan: contour, caps, main satin.

use super::applique::stop_here;
use super::satin::{plot_points_on_rails, satin_geometry, satin_on};
use super::Run;
use crate::geom::{point_in_ring, Point, Ring};
use crate::model::{FabricProfile, FoamOptions, SatinParams, SubPath, FOAM_DENSITY_FACTOR, FOAM_MAX_CONTOUR_PASSES, FOAM_WIDE};
use crate::plan::flags;

/// Depth of a cap, from the end's edge inwards (mm; the fork's value, to check
/// at a stitch-out).
pub const CAP_DEPTH: f64 = 2.0;
/// The cap's inner side is uneven: each stitch up to this much shorter
/// (2 mm → between 1.4 and 2 mm).
pub const CAP_UNEVEN: f64 = 0.6;

/// One column: its pairs plotted every 0.5 mm.
struct Column {
    pairs: Vec<(Point, Point)>,
}

impl Column {
    fn width(&self) -> f64 {
        super::satin::mean_width(&self.pairs)
    }
    /// The column's outline as a ring.
    fn ring(&self) -> Ring {
        self.pairs.iter().map(|x| x.0).chain(self.pairs.iter().rev().map(|x| x.1)).collect()
    }
    /// The two ends: the edge across (rail 0 → rail 1) and the outward direction.
    fn ends(&self) -> Vec<(Point, Point, Point)> {
        let n = self.pairs.len();
        if n < 2 {
            return vec![];
        }
        let mid = |i: usize| self.pairs[i].0.lerp(self.pairs[i].1, 0.5);
        let k = 2.min(n - 1);
        let out = |end: usize, inner: usize| {
            let (a, b) = self.pairs[end];
            let d = (mid(end) - mid(inner)).unit();
            let d = if d.length() > 0.5 { d } else { (b - a).perp().unit() };
            (a, b, d)
        };
        vec![out(0, k), out(n - 1, n - 1 - k)]
    }
}

/// A cap on an open end: a satin across the end, from rail to rail, every
/// stitch from the edge (`a`–`b`, the shape's own edge) inwards; uneven depth.
fn cap(a: Point, b: Point, out: Point, spacing: f64) -> Run {
    let n = ((a.dist(b) / spacing.max(0.1)).ceil() as usize).max(1);
    let mut run: Run = Vec::with_capacity(2 * n + 2);
    for i in 0..=n {
        let e = a.lerp(b, i as f64 / n as f64);
        // a fixed, irregular pattern (no randomness: the same plan every time)
        let r = ((i as f64 * 12.9898).sin() * 43758.5453).rem_euclid(1.0);
        let depth = CAP_DEPTH - CAP_UNEVEN * r;
        run.push((e, 0));
        run.push((e - out * depth, 0));
    }
    run
}

/// The column's satin params for foam: contour (and centre walk when wide), no fill underlay, denser.
fn foam_satin(satin: &SatinParams, f: &FoamOptions, width: f64) -> SatinParams {
    let factor = if f.density_factor.is_finite() && f.density_factor > 0.0 { f.density_factor } else { FOAM_DENSITY_FACTOR };
    SatinParams {
        multi: false,
        underlay_auto: false,
        contour_underlay: true,
        contour_underlay_repeats: f.contour_passes.clamp(1, FOAM_MAX_CONTOUR_PASSES),
        center_walk: width >= FOAM_WIDE - 1e-9,
        zigzag_underlay: false,
        spacing: satin.spacing / factor,
        foam: None,
        layered: None,
        ..satin.clone()
    }
}

/// The runs of a satin over foam (`p.foam` set; absent, its defaults).
pub fn foam(paths: &[SubPath], p: &SatinParams, fabric: &FabricProfile) -> Vec<Run> {
    let f = p.foam.unwrap_or_default();
    // the columns: every sub-path its own (multi), else the whole object
    let groups = super::satin::columns(paths, p);
    let single = SatinParams { multi: false, foam: None, layered: None, ..p.clone() };
    let columns: Vec<(Vec<SubPath>, Column)> = groups
        .into_iter()
        .filter_map(|g| {
            let geo = satin_geometry(&g, &single)?;
            let pairs = plot_points_on_rails(&geo, 0.5, 0.0, 0.0);
            (pairs.len() >= 2).then_some((g, Column { pairs }))
        })
        .collect();
    let (mut under, mut caps, mut top) = (Vec::new(), Vec::new(), Vec::new());
    let rings: Vec<Ring> = columns.iter().map(|(_, c)| c.ring()).collect();
    for (i, (g, c)) in columns.iter().enumerate() {
        let sp = foam_satin(p, &f, c.width());
        for run in satin_on(g, &sp, fabric) {
            under.push(run.iter().copied().filter(|x| x.1 & flags::UNDERLAY != 0).collect::<Run>());
            top.push(run.into_iter().filter(|x| x.1 & flags::UNDERLAY == 0).collect::<Run>());
        }
        // closed columns (a ring) have no ends; an end inside another column is not open
        let closed = g.len() == 1 && g[0].closed;
        if f.caps && !closed {
            for (a, b, out) in c.ends() {
                let m = a.lerp(b, 0.5) - out * 0.05;
                let open = !rings.iter().enumerate().any(|(j, r)| j != i && point_in_ring(m, r));
                if open {
                    caps.push(cap(a, b, out, sp.spacing * fabric.density_scale));
                }
            }
        }
    }
    let mut runs: Vec<Run> = under.into_iter().chain(caps).chain(top).filter(|r| !r.is_empty()).collect();
    // the machine stops before the object: the operator lays the foam
    if let Some(first) = runs.first().and_then(|r| r.first()).map(|x| x.0) {
        runs.insert(0, stop_here(first));
    }
    runs
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::assemble::Engine;
    use crate::geom::pt;
    use crate::model::*;
    use crate::stitches::applique::is_stop;

    fn line(a: Point, b: Point) -> SubPath {
        SubPath::polyline(&[a, b], false)
    }
    fn foam_of(paths: Vec<SubPath>, p: SatinParams) -> Vec<Run> {
        foam(&paths, &p, &Fabric::Cotton.profile())
    }
    /// A satin with the foam block.
    fn column(width: f64) -> SatinParams {
        SatinParams { width, spacing: 0.4, foam: Some(FoamOptions::default()), ..Default::default() }
    }
    fn with(f: FoamOptions, width: f64) -> SatinParams {
        SatinParams { foam: Some(f), ..column(width) }
    }
    fn obj(id: &str, paths: Vec<SubPath>, stitch: StitchParams) -> Object {
        let mut o: Object = serde_json::from_value(serde_json::json!({ "id": id, "thread": "t", "paths": [] })).unwrap();
        o.paths = paths;
        o.stitch = stitch;
        o
    }
    fn doc(objects: Vec<Object>) -> Document {
        Document {
            threads: vec![Thread::new("t", "x", "#000000")],
            objects,
            ..Default::default()
        }
    }

    #[test]
    fn denser_satin_contour_and_centre_no_fill_underlay() {
        // a 5 × 40 mm foam column, normal satin at 0.40 mm
        let runs = foam_of(vec![line(pt(0.0, 0.0), pt(40.0, 0.0))], column(5.0));
        assert!(is_stop(&runs[0]), "a stop first");
        let all: Vec<(Point, u8)> = runs[1..].iter().flatten().copied().collect();
        // stitch distance: 0.40 / 1.45 = 0.28 mm, along one rail of the cover
        let mut xs: Vec<f64> = all.iter().filter(|x| x.1 & flags::UNDERLAY == 0 && x.0.y > 2.4).map(|x| x.0.x).collect();
        xs.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let gaps: Vec<f64> = xs.windows(2).map(|w| w[1] - w[0]).filter(|g| *g > 1e-6).collect();
        let mean = gaps.iter().sum::<f64>() / gaps.len() as f64;
        assert!((mean - 0.4 / 1.45).abs() < 0.01 && (mean - 0.28).abs() < 0.01, "spacing {mean}");
        // underlay: only the contour (0.4 mm inside: |y| = 2.1) and the centre; no zig-zag
        let under: Vec<Point> = all.iter().filter(|x| x.1 & flags::UNDERLAY != 0).map(|x| x.0).collect();
        assert!(under.iter().all(|q| (q.y.abs() - 2.1).abs() < 0.05 || q.y.abs() < 0.05), "no fill underlay");
        let side = under.iter().filter(|q| (q.y - 2.1).abs() < 0.05).count();
        assert!((15..=20).contains(&side), "one contour pass: {side} points on a side");
        assert!(under.iter().filter(|q| q.y.abs() < 0.05).count() > 10, "wide (≥ 4 mm): a centre walk too");
        // narrower: the contour only
        let narrow = foam_of(vec![line(pt(0.0, 0.0), pt(40.0, 0.0))], column(3.0));
        assert!(!narrow.iter().flatten().any(|x| x.1 & flags::UNDERLAY != 0 && x.0.y.abs() < 0.05), "under 4 mm: no centre walk");
        // two passes: the contour twice
        let two = foam_of(vec![line(pt(0.0, 0.0), pt(40.0, 0.0))], with(FoamOptions { contour_passes: 2, ..Default::default() }, 5.0));
        let side2 = two.iter().flatten().filter(|x| x.1 & flags::UNDERLAY != 0 && (x.0.y - 2.1).abs() < 0.05).count();
        assert!(side2 >= 2 * side - 2, "two passes: {side2} vs {side}");
    }

    #[test]
    fn three_contour_passes_are_refused() {
        // a satin's foam block with 3 contour passes is refused
        let read = |n: u32| serde_json::from_value::<StitchParams>(serde_json::json!({ "type": "satin", "foam": { "contourPasses": n } }));
        let err = read(3).unwrap_err().to_string();
        assert!(err.contains("contourPasses 3"), "{err}");
        assert!(read(0).is_err());
        let StitchParams::Satin(s) = read(2).unwrap() else { panic!() };
        assert_eq!(s.foam.unwrap().contour_passes, 2);
        let StitchParams::Satin(s) = serde_json::from_value(serde_json::json!({ "type": "satin", "foam": {} })).unwrap() else { panic!() };
        let f = s.foam.unwrap();
        assert_eq!((f.contour_passes, f.density_factor, f.caps), (1, 1.45, true), "the block's defaults");
    }

    #[test]
    fn a_satin_without_the_block_is_a_normal_satin() {
        // no foam block: a plain satin, and the block is not written
        let StitchParams::Satin(s) = serde_json::from_value(serde_json::json!({ "type": "satin" })).unwrap() else { panic!() };
        assert!(s.foam.is_none());
        assert!(!serde_json::to_string(&s).unwrap().contains("foam"));
        let paths = vec![line(pt(0.0, 0.0), pt(30.0, 0.0))];
        let o = |s: SatinParams| obj("s", paths.clone(), StitchParams::Satin(s));
        let plain = crate::stitches::generate(&o(SatinParams::default()), &Fabric::Cotton.profile());
        assert_eq!(plain, satin_on(&paths, &SatinParams::default(), &Fabric::Cotton.profile()), "as before");
        let foamed = crate::stitches::generate(&o(column(5.0)), &Fabric::Cotton.profile());
        assert!(is_stop(&foamed[0]), "with the block: the foam's stitches (a stop first)");
    }

    #[test]
    fn letter_t_three_caps_contour_caps_satin() {
        // a T of two centre lines (5 mm): the bar's two ends and the stem's foot are open
        let paths = vec![line(pt(0.0, 20.0), pt(30.0, 20.0)), line(pt(15.0, 20.0), pt(15.0, 0.0))];
        let p = SatinParams { multi: true, ..column(5.0) };
        let runs = foam_of(paths, p);
        assert!(is_stop(&runs[0]));
        let kinds: Vec<&str> = runs[1..]
            .iter()
            .map(|r| if r.iter().all(|x| x.1 & flags::UNDERLAY != 0) { "contour" } else if r.len() < 60 { "cap" } else { "satin" })
            .collect();
        assert_eq!(kinds, ["contour", "contour", "cap", "cap", "cap", "satin", "satin"]);
        // each cap on an open end, its outer side on the shape's edge, at most 2 mm deep
        let caps = &runs[3..6];
        let near = |r: &Run, f: &dyn Fn(Point) -> f64| {
            let v: Vec<f64> = r.iter().map(|x| f(x.0)).collect();
            (v.iter().cloned().fold(f64::MAX, f64::min), v.iter().cloned().fold(f64::MIN, f64::max))
        };
        let left = caps.iter().find(|r| r[0].0.x < 3.0).expect("cap at the bar's left end");
        let (lo, hi) = near(left, &|q| q.x);
        assert!(lo.abs() < 1e-6 && hi <= CAP_DEPTH + 1e-6 && hi > CAP_DEPTH - CAP_UNEVEN - 1e-6, "left cap {lo}..{hi}");
        let right = caps.iter().find(|r| r[0].0.x > 27.0).expect("cap at the bar's right end");
        let (lo, hi) = near(right, &|q| q.x);
        assert!((hi - 30.0).abs() < 1e-6 && lo >= 30.0 - CAP_DEPTH - 1e-6, "right cap {lo}..{hi}");
        let foot = caps.iter().find(|r| r[0].0.y < 3.0).expect("cap at the stem's foot");
        let (lo, hi) = near(foot, &|q| q.y);
        assert!(lo.abs() < 1e-6 && hi <= CAP_DEPTH + 1e-6, "foot cap {lo}..{hi}");
        // caps off: none
        let none = foam_of(vec![line(pt(0.0, 0.0), pt(30.0, 0.0))], with(FoamOptions { caps: false, ..Default::default() }, 5.0));
        assert_eq!(none.len(), 3, "stop, contour, satin");
    }

    #[test]
    fn stop_right_before_the_foam() {
        // a satin, then the foam: the machine stops right before the foam's first stitch
        let d = doc(vec![
            obj("s", vec![line(pt(0.0, 0.0), pt(30.0, 0.0))], StitchParams::Satin(Default::default())),
            obj("f", vec![line(pt(0.0, 10.0), pt(30.0, 10.0))], StitchParams::Satin(column(5.0))),
        ]);
        let plan = Engine::new().plan(&d);
        let stops: Vec<usize> = plan.stitches.iter().enumerate().filter(|(_, s)| s.is(flags::STOP)).map(|(i, _)| i).collect();
        assert_eq!(stops.len(), 1, "one stop");
        // its first needle point (the trim and stop before it are its commands)
        let first_foam = plan.stitches.iter().position(|s| s.object == 1 && s.flags & flags::COMMANDS == 0).unwrap();
        assert!(stops[0] < first_foam, "the stop comes before the foam");
        assert!(plan.stitches[stops[0]..first_foam].iter().all(|s| s.flags & flags::COMMANDS != 0), "nothing but the jump between the stop and the foam");
        assert!(plan.stitches[stops[0] + 1..].iter().all(|s| s.object != 0), "nothing of the satin after the stop");
        assert!(plan.stitches[..stops[0]].iter().all(|s| s.object != 1 || s.flags & flags::COMMANDS != 0), "no foam stitch before it");
    }
}
