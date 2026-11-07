//! Stitch generators. Each produces one or more *runs*: continuous sequences
//! of needle penetrations (with informational flags). Runs are joined into a
//! machine plan by [`crate::assemble`].

pub mod applique;
pub mod decor;
pub mod fields;
pub mod travel;
pub mod underlay;
pub mod fill;
pub mod gradient;
pub mod inkfills;
pub mod meander_tiles;
pub mod ripple;
pub mod running;
pub mod satin;
pub mod tartan;

use crate::geom::Point;
use crate::model::{FabricProfile, Object, StitchParams};

pub type Run = Vec<(Point, u8)>;

/// Orient one running-stitch polyline for the object's start/end points
/// (Ink/Stitch "starting point" / "ending point" commands).
fn orient_polyline(mut pts: Vec<Point>, closed: bool, start: Option<Point>, end: Option<Point>) -> Vec<Point> {
    if pts.len() < 2 {
        return pts;
    }
    if closed {
        // begin at the vertex nearest the start (or opposite the end)
        let target = start.or(end);
        if let Some(t) = target {
            let mut ring = pts.clone();
            if ring.len() > 2 && ring[0].dist(*ring.last().unwrap()) < 1e-9 {
                ring.pop();
            }
            let k = (0..ring.len()).min_by(|a, b| ring[*a].dist(t).partial_cmp(&ring[*b].dist(t)).unwrap()).unwrap_or(0);
            ring.rotate_left(k);
            let first = ring[0];
            ring.push(first);
            pts = ring;
        }
        return pts;
    }
    let (a, b) = (pts[0], *pts.last().unwrap());
    let flip = match (start, end) {
        (Some(s), _) => s.dist(b) < s.dist(a),
        (None, Some(e)) => e.dist(a) < e.dist(b),
        _ => false,
    };
    if flip {
        pts.reverse();
    }
    pts
}

/// Generate the runs for one object.
pub fn generate(obj: &Object, fabric: &FabricProfile) -> Vec<Run> {
    #[cfg(feature = "prof")]
    let _prof_guard = crate::prof::Guard::new(prof_kind(obj));
    let runs = generate_plain(obj, fabric);
    if obj.patterns.is_empty() {
        runs
    } else {
        apply_patterns(runs, &obj.patterns)
    }
}

/// The generator an object goes to, for the profiler.
#[cfg(feature = "prof")]
fn prof_kind(obj: &Object) -> &'static str {
    use crate::model::FillMethod as M;
    match &obj.stitch {
        StitchParams::Fill(f) if f.gradient.is_some() => match f.method {
            M::Tatami => "gen fill gradient tatami",
            M::Curved => "gen fill gradient curved",
            M::Flow => "gen fill gradient flow",
            _ => "gen fill gradient other",
        },
        StitchParams::Fill(f) if f.ramp.is_some() => "gen fill ramp/blend",
        StitchParams::Fill(f) => match f.method {
            M::Tatami => "gen fill tatami",
            M::Contour | M::Spiral => "gen fill contour/spiral",
            M::Curved => "gen fill curved",
            M::Flow => "gen fill flow",
            M::Guided => "gen fill guided",
            M::Stipple | M::Meander | M::Hilbert => "gen fill texture",
            _ => "gen fill other",
        },
        StitchParams::Satin(_) => "gen satin",
        StitchParams::Running(_) => "gen running",
        StitchParams::Applique(_) => "gen applique",
        _ => "gen other",
    }
}

/// Ink/Stitch `apply_patterns`: fill (shape) patterns first, then stroke (line) patterns.
pub fn apply_patterns(mut runs: Vec<Run>, patterns: &[crate::model::StitchPattern]) -> Vec<Run> {
    use crate::geom::{point_in_rings, segment_intersection, Ring};
    for p in patterns.iter().filter(|p| p.remove) {
        let rings: Vec<Ring> = p.paths.iter().filter(|s| s.closed || s.nodes.len() >= 3).map(|s| s.flatten(0.05)).filter(|r| r.len() >= 3).collect();
        if rings.is_empty() {
            continue;
        }
        for run in &mut runs {
            let n = run.len();
            let keep: Vec<bool> = (0..n)
                .map(|i| {
                    let (q, f) = run[i];
                    if i == 0 || i + 1 == n || f != 0 || !point_in_rings(q, &rings) {
                        // ends, underlay, travel and locks, and points outside stay
                        return true;
                    }
                    // row ends and satin edges: where the stitching turns (by 70° or more)
                    let (a, b) = (q - run[i - 1].0, run[i + 1].0 - q);
                    let (la, lb) = (a.length(), b.length());
                    la > 1e-9 && lb > 1e-9 && a.dot(b) <= 0.35 * la * lb
                })
                .collect();
            let mut k = 0;
            run.retain(|_| {
                k += 1;
                keep[k - 1]
            });
        }
    }
    for p in patterns.iter().filter(|p| p.add) {
        let lines: Vec<Vec<Point>> = p.paths.iter().map(|s| {
            let mut v = s.flatten(0.05);
            if s.closed && v.len() > 2 {
                v.push(v[0]);
            }
            v
        }).filter(|v| v.len() >= 2).collect();
        let interval: Vec<u32> = if p.interval.iter().any(|v| *v > 0) { p.interval.iter().map(|v| (*v).max(1)).collect() } else { vec![1] };
        for run in &mut runs {
            let mut out: Run = Vec::with_capacity(run.len());
            let (mut count, mut idx, mut in_interval) = (0u32, 0usize, interval[0]);
            for i in 0..run.len() {
                out.push(run[i]);
                if i + 1 == run.len() {
                    continue;
                }
                let (a, b) = (run[i].0, run[i + 1].0);
                let mut hits: Vec<(f64, Point)> = Vec::new();
                for l in &lines {
                    for w in l.windows(2) {
                        if let Some((t, q)) = segment_intersection(a, b, w[0], w[1]) {
                            if t > 1e-6 && t < 1.0 - 1e-6 {
                                hits.push((t, q));
                            }
                        }
                    }
                }
                hits.sort_by(|x, y| x.0.partial_cmp(&y.0).unwrap_or(std::cmp::Ordering::Equal));
                for (_, q) in hits {
                    count += 1;
                    if count <= p.offset {
                        continue;
                    }
                    if in_interval == interval[idx] {
                        out.push((q, run[i + 1].1));
                        in_interval = 1;
                        idx = (idx + 1) % interval.len();
                    } else {
                        in_interval += 1;
                    }
                }
            }
            *run = out;
        }
    }
    runs
}

fn generate_plain(obj: &Object, fabric: &FabricProfile) -> Vec<Run> {
    let start = obj.start.map(Point::from_arr);
    let end = obj.end.map(Point::from_arr);
    match &obj.stitch {
        StitchParams::None => vec![],
        StitchParams::Manual(m) => obj
            .paths
            .iter()
            .filter(|sp| !sp.nodes.is_empty())
            .map(|sp| {
                let pts: Vec<Point> = sp.nodes.iter().map(|n| n.point()).collect();
                let pts = running::split_long(&pts, m.max_length);
                running::bean_stitch_pattern(&pts, &m.bean_pattern).into_iter().map(|q| (q, 0u8)).collect()
            })
            .collect(),
        StitchParams::Running(p) if p.ripple.is_some() => {
            // ripples: the whole object at once (two rails make a satin ripple)
            let beans = p.beans();
            ripple::ripple_stitches(&obj.paths, p.ripple.as_ref().unwrap(), p)
                .into_iter()
                .map(|s| running::bean_stitch_pattern(&s, &beans).into_iter().map(|q| (q, 0u8)).collect())
                .collect()
        }
        StitchParams::Running(p) => {
            let n = obj.paths.len();
            obj.paths
                .iter()
                .enumerate()
                .filter_map(|(k, sp)| {
                    let pts = sp.flatten(0.02);
                    if pts.len() < 2 {
                        return None;
                    }
                    let len = p.stitch_length();
                    let beans = p.beans();
                    // start applies to the first sub-path, end to the last
                    let pts = orient_polyline(pts, sp.closed, if k == 0 { start } else { None }, if k + 1 == n { end } else { None });
                    let mut s = match (&p.zigzag, &p.stem, &p.motif) {
                        (Some(z), _, _) => running::zigzag_stitch(&pts, z.spacing, z.width, z.pull_comp, z.angle, p.tolerance, sp.closed),
                        (None, Some(st), _) => decor::stem(&pts, p.length, st.width),
                        (None, None, Some(m)) => decor::motif(&pts, m.kind, m.size, p.length),
                        _ => running::running_stitch_with(&pts, &len, p.tolerance, k as u64),
                    };
                    s = running::repeat_path(&s, p.repeats);
                    s = running::bean_stitch_pattern(&s, &beans);
                    Some(s.into_iter().map(|q| (q, 0u8)).collect())
                })
                .collect()
        }
        StitchParams::Satin(p) => {
            let mut p = p.clone();
            if start.is_some() || end.is_some() {
                if let Some(geo) = satin::satin_geometry(&obj.paths, &p) {
                    let ends = (|| {
                        let (f0, f1) = geo.sections.first()?;
                        let (l0, l1) = geo.sections.last()?;
                        let a = f0.first()?.lerp(*f1.first()?, 0.5);
                        let b = l0.last()?.lerp(*l1.last()?, 0.5);
                        Some((a, b))
                    })();
                    if let Some((a, b)) = ends {
                        let flip = match (start, end) {
                            (Some(s), _) => s.dist(b) < s.dist(a),
                            (None, Some(e)) => e.dist(a) < e.dist(b),
                            _ => false,
                        };
                        if flip {
                            p.reverse = !p.reverse;
                        }
                    }
                }
            }
            satin::satin_on(&obj.paths, &p, fabric)
        }
        StitchParams::Applique(p) => applique::applique(&obj.paths, p, fabric.pull_comp, fabric.density_scale),
        StitchParams::Fill(p) => fill::fill_on(&obj.paths, p, fabric, start, end),
    }
}


#[cfg(test)]
mod tests {
    use super::*;
    use crate::geom::pt;
    use crate::model::*;

    fn obj(paths: Vec<SubPath>, stitch: StitchParams, start: Option<[f64; 2]>, end: Option<[f64; 2]>) -> Object {
        Object {
            id: "o".into(),
            name: "o".into(),
            thread: "t".into(),
            visible: true,
            locked: false,
            paths,
            stitch,
            trim_after: false,
            stop_after: false,
            ties: Default::default(),
            force_lock: false,
            min_stitch: None,
            min_jump: None,
            clone: None,
            hidden: None,
            patterns: vec![],
            start,
            end,
            lock: None,
            color_sort_index: None,
        }
    }

    fn first_last(runs: &[Run]) -> (Point, Point) {
        (runs.first().unwrap().first().unwrap().0, runs.last().unwrap().last().unwrap().0)
    }

    #[test]
    fn running_respects_start_and_end() {
        let line = vec![SubPath::polyline(&[pt(0.0, 0.0), pt(20.0, 0.0)], false)];
        let st = StitchParams::Running(RunningParams::default());
        let (a, _) = first_last(&generate(&obj(line.clone(), st.clone(), Some([19.0, 0.0]), None), &Fabric::Cotton.profile()));
        assert!(a.dist(pt(20.0, 0.0)) < 1e-6, "starts at the end nearest the start point");
        let (_, b) = first_last(&generate(&obj(line, st, None, Some([1.0, 0.0])), &Fabric::Cotton.profile()));
        assert!(b.dist(pt(0.0, 0.0)) < 1e-6, "ends at the end nearest the end point");
    }

    #[test]
    fn satin_reverses_for_start() {
        let line = vec![SubPath::polyline(&[pt(0.0, 0.0), pt(30.0, 0.0)], false)];
        let st = StitchParams::Satin(SatinParams { center_walk: false, ..Default::default() });
        let (a, _) = first_last(&generate(&obj(line, st, Some([30.0, 0.0]), None), &Fabric::Cotton.profile()));
        assert!(a.x > 28.0, "satin starts at the far end: {a:?}");
    }

    #[test]
    fn fill_starts_and_ends_near_points() {
        let sq = vec![SubPath::polyline(&[pt(0.0, 0.0), pt(20.0, 0.0), pt(20.0, 20.0), pt(0.0, 20.0)], true)];
        let st = StitchParams::Fill(FillParams { underlay: false, ..Default::default() });
        let runs = generate(&obj(sq, st, Some([19.0, 19.0]), Some([1.0, 1.0])), &Fabric::Cotton.profile());
        let (a, b) = first_last(&runs);
        assert!(a.dist(pt(20.0, 20.0)) < 2.0, "start {a:?}");
        assert!(b.dist(pt(1.0, 1.0)) < 0.5, "end {b:?}");
    }
}

#[cfg(test)]
mod pattern_tests {
    use super::*;
    use crate::geom::pt;
    use crate::model::*;

    fn obj(paths: Vec<SubPath>, stitch: StitchParams, patterns: Vec<StitchPattern>) -> Object {
        Object {
            id: "o".into(),
            name: "o".into(),
            thread: "t".into(),
            visible: true,
            locked: false,
            paths,
            stitch,
            trim_after: false,
            stop_after: false,
            ties: Default::default(),
            force_lock: false,
            min_stitch: None,
            min_jump: None,
            patterns,
            clone: None,
            hidden: None,
            start: None,
            end: None,
            lock: None,
            color_sort_index: None,
        }
    }
    fn pts(o: &Object) -> Vec<Point> {
        generate(o, &Fabric::Cotton.profile()).into_iter().flatten().map(|x| x.0).collect()
    }

    #[test]
    fn line_patterns_add_points_where_stitches_cross_them() {
        let line = vec![SubPath::polyline(&[pt(0.0, 0.0), pt(20.0, 0.0)], false)];
        let run = StitchParams::Running(RunningParams { length: 5.0, ..Default::default() });
        let marks = |interval: Vec<u32>, offset: u32| StitchPattern {
            paths: (1..8).map(|k| SubPath::polyline(&[pt(k as f64 * 2.3, -1.0), pt(k as f64 * 2.3, 1.0)], false)).collect(),
            add: true,
            remove: false,
            interval,
            offset,
        };
        let plain = pts(&obj(line.clone(), run.clone(), vec![]));
        let all = pts(&obj(line.clone(), run.clone(), vec![marks(vec![], 0)]));
        assert_eq!(all.len(), plain.len() + 7, "a point at every crossing");
        assert!(all.iter().any(|p| (p.x - 2.3).abs() < 1e-9));
        let every_other = pts(&obj(line.clone(), run.clone(), vec![marks(vec![2], 0)]));
        assert_eq!(every_other.len(), plain.len() + 4, "every second crossing, the first included (Ink/Stitch)");
        let skipped = pts(&obj(line, run, vec![marks(vec![], 3)]));
        assert_eq!(skipped.len(), plain.len() + 4, "the first three skipped");
    }

    #[test]
    fn shape_patterns_leave_out_points_inside_but_keep_row_ends() {
        let sq = vec![SubPath::polyline(&[pt(0.0, 0.0), pt(30.0, 0.0), pt(30.0, 30.0), pt(0.0, 30.0)], true)];
        let fill = StitchParams::Fill(FillParams { underlay: false, ..Default::default() });
        let hole = StitchPattern { paths: vec![SubPath::polyline(&[pt(10.0, 10.0), pt(20.0, 10.0), pt(20.0, 20.0), pt(10.0, 20.0)], true)], add: false, remove: true, interval: vec![], offset: 0 };
        let inside = |v: &[Point]| v.iter().filter(|p| p.x > 10.5 && p.x < 19.5 && p.y > 10.5 && p.y < 19.5).count();
        let plain = pts(&obj(sq.clone(), fill.clone(), vec![]));
        let holed = pts(&obj(sq, fill, vec![hole]));
        assert!(inside(&plain) > 20);
        assert_eq!(inside(&holed), 0, "no needle points inside the pattern");
        assert!(holed.len() < plain.len());
    }
}
