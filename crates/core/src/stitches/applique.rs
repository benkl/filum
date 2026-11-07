//! Automatic appliqué: one object that sews the three steps of
//! an appliqué on its closed outline(s):
//!
//! 1. placement line (running stitch) → stop, the operator lays the fabric;
//! 2. tack-down (zig-zag, E-stitch or running stitch, slightly inside the
//!    edge) → stop, the operator trims the fabric along the stitching;
//! 3. cover stitch (satin or E-stitch / blanket) over the raw edge.
//!
//! Stops are emitted as one-point "command runs" flagged `STOP`, which the
//! assembler turns into tie-off + trim + machine stop.

use super::fill::fill_rings;
use super::running::running_stitch;
use super::satin::satin;
use super::Run;
use crate::geom::{offset_rings, point_in_ring, point_in_rings, rings_bounds, signed_area, Point, Ring};
use crate::model::{AppliqueParams, CoverKind, SatinMethod, SatinParams, SubPath, TackdownKind};
use crate::plan::flags;

/// One-point run asking the assembler for a trim + machine stop here.
pub fn stop_here(at: Point) -> Run {
    vec![(at, flags::STOP)]
}

pub fn is_stop(run: &Run) -> bool {
    run.len() == 1 && run[0].1 & flags::STOP != 0
}

/// Outer rings counter-clockwise, holes clockwise (consistent rail sides).
fn oriented(rings: Vec<Ring>) -> Vec<Ring> {
    let all = rings.clone();
    rings
        .into_iter()
        .enumerate()
        .map(|(i, mut r)| {
            let depth = all.iter().enumerate().filter(|(j, o)| *j != i && point_in_ring(r[0], o)).count();
            if (signed_area(&r) > 0.0) != (depth % 2 == 0) {
                r.reverse();
            }
            r
        })
        .collect()
}

fn closed(r: &Ring) -> Vec<Point> {
    let mut v = r.clone();
    v.push(r[0]);
    v
}

fn as_paths(rings: &[Ring]) -> Vec<SubPath> {
    rings.iter().map(|r| SubPath::polyline(r, true)).collect()
}

/// Satin / zig-zag / E-stitch along rings. E-stitch keeps its baseline
/// outside the `outside_of` region (blanket stitch on the fabric edge, prongs
/// pointing into the appliqué) unless `flip`.
fn column(rings: &[Ring], p: SatinParams, extra_pull: f64, density: f64, outside_of: &[Ring], flip: bool) -> Vec<Run> {
    let mut runs = satin(&as_paths(rings), &p, extra_pull, density);
    if p.method == SatinMethod::EStitch {
        let base_inside = runs
            .iter()
            .filter_map(|r| r.iter().find(|x| x.1 & flags::UNDERLAY == 0))
            .next()
            .map(|x| point_in_rings(x.0, outside_of))
            .unwrap_or(false);
        if base_inside != flip {
            runs = satin(&as_paths(rings), &SatinParams { swap_rails: !p.swap_rails, ..p }, extra_pull, density);
        }
    }
    runs
}

pub fn applique(paths: &[SubPath], p: &AppliqueParams, extra_pull: f64, density: f64) -> Vec<Run> {
    let rings = fill_rings(paths);
    if rings.is_empty() {
        return vec![];
    }
    let rings = oriented(rings);
    let b = rings_bounds(&rings);
    let res = (b.width().max(b.height()) / 1500.0).clamp(0.03, 0.15);
    let mut runs: Vec<Run> = Vec::new();
    let last = |runs: &Vec<Run>| runs.last().and_then(|r| r.last()).map(|x| x.0);

    // 1. placement line
    if p.placement {
        for r in &rings {
            let s = running_stitch(&closed(r), p.placement_length.max(0.5), 0.1);
            runs.push(s.into_iter().map(|q| (q, 0u8)).collect());
        }
        if p.stops && (p.tackdown != TackdownKind::None || p.cover != CoverKind::None) {
            if let Some(at) = last(&runs) {
                runs.push(stop_here(at));
            }
        }
    }

    // 2. tack-down, a little inside the edge
    let tack = if p.tackdown_inset > 1e-6 { oriented(offset_rings(&rings, -within(p.tackdown_inset, 0.0, MAX_WIDTH, 0.0), res)) } else { rings.clone() };
    let tack = if tack.is_empty() { rings.clone() } else { tack };
    match p.tackdown {
        TackdownKind::None => {}
        TackdownKind::Run => {
            for r in &tack {
                let s = running_stitch(&closed(r), 2.0, 0.1);
                runs.push(s.into_iter().map(|q| (q, 0u8)).collect());
            }
        }
        TackdownKind::Zigzag | TackdownKind::EStitch => {
            let sp = SatinParams {
                method: if p.tackdown == TackdownKind::Zigzag { SatinMethod::Zigzag } else { SatinMethod::EStitch },
                width: within(p.tackdown_width, 0.3, MAX_WIDTH, 1.6),
                spacing: within(p.tackdown_spacing, 0.3, MAX_WIDTH, 1.2),
                pull_comp: 0.0,
                short_stitch_inset: 0.0,
                center_walk: false,
                multi: true,
                ..Default::default()
            };
            runs.extend(column(&tack, sp, 0.0, 1.0, &rings, p.flip));
        }
    }
    if p.tackdown != TackdownKind::None && p.stops && p.cover != CoverKind::None {
        if let Some(at) = last(&runs) {
            runs.push(stop_here(at));
        }
    }

    // 3. cover stitch over the raw edge
    if p.cover != CoverKind::None {
        let cover = if p.cover_offset.abs() > 1e-6 { oriented(offset_rings(&rings, within(p.cover_offset, -MAX_WIDTH, MAX_WIDTH, 0.0), res)) } else { rings.clone() };
        let cover = if cover.is_empty() { rings.clone() } else { cover };
        let sp = SatinParams {
            method: if p.cover == CoverKind::Satin { SatinMethod::Satin } else { SatinMethod::EStitch },
            width: within(p.cover_width, 0.5, MAX_WIDTH, 3.0),
            spacing: within(p.cover_spacing, 0.15, MAX_WIDTH, 0.4),
            pull_comp: p.pull_comp,
            center_walk: p.cover_underlay,
            multi: true,
            ..Default::default()
        };
        runs.extend(column(&cover, sp, extra_pull, density, &rings, p.flip));
    }
    runs.retain(|r| !r.is_empty());
    runs
}

/// Widest tack-down / cover column and furthest inset or offset (mm): far
/// beyond any appliqué edge, and a 1e5 mm column would take forever.
const MAX_WIDTH: f64 = 20.0;

/// `v` brought into `lo..=hi` (`fallback` when it is not a number).
fn within(v: f64, lo: f64, hi: f64, fallback: f64) -> f64 {
    if v.is_finite() { v.clamp(lo, hi) } else if v.is_nan() { fallback } else if v > 0.0 { hi } else { lo }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geom::pt;

    fn square() -> Vec<SubPath> {
        vec![SubPath::polyline(&[pt(0.0, 0.0), pt(30.0, 0.0), pt(30.0, 30.0), pt(0.0, 30.0)], true)]
    }

    #[test]
    fn three_steps_with_two_stops() {
        let runs = applique(&square(), &AppliqueParams::default(), 0.0, 1.0);
        let stops = runs.iter().filter(|r| is_stop(r)).count();
        assert_eq!(stops, 2);
        // placement first, cover last; cover stitches straddle the edge
        let first = &runs[0];
        assert!(first.iter().all(|x| x.0.x.abs() < 1e-6 || (x.0.x - 30.0).abs() < 1e-6 || x.0.y.abs() < 1e-6 || (x.0.y - 30.0).abs() < 1e-6));
        let cover = runs.last().unwrap();
        let outside = cover.iter().filter(|x| x.0.x < -0.5 || x.0.x > 30.5 || x.0.y < -0.5 || x.0.y > 30.5).count();
        assert!(outside > 50, "cover reaches outside the edge: {outside}");
    }

    #[test]
    fn no_stops_when_disabled() {
        let p = AppliqueParams { stops: false, ..Default::default() };
        assert_eq!(applique(&square(), &p, 0.0, 1.0).iter().filter(|r| is_stop(r)).count(), 0);
    }

    #[test]
    fn blanket_baseline_outside() {
        let p = AppliqueParams { cover: CoverKind::EStitch, tackdown: TackdownKind::None, placement: false, ..Default::default() };
        let runs = applique(&square(), &p, 0.0, 1.0);
        let base = runs[0].iter().find(|x| x.1 & flags::UNDERLAY == 0).unwrap().0;
        let r = [vec![pt(0.0, 0.0), pt(30.0, 0.0), pt(30.0, 30.0), pt(0.0, 30.0)]];
        assert!(!point_in_rings(base, &r), "baseline {base:?} outside");
    }
}
