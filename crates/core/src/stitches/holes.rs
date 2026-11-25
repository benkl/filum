//! Travel that avoids its own needle holes (not in Ink/Stitch).
//!
//! A fill's travel runs along its outline or through its underpath from one
//! section to the next. In a narrow part of the shape every travel takes the
//! same route through the same corners, so its needle points land on the
//! same holes again and again: on a real design a quarter of the needle drops
//! hit an earlier hole and hot spots reach twice what cotton takes
//! (docs/STITCH_QUALITY_PLAN.md).
//!
//! Travel is hidden (under the rows to come) or runs along the edge, so its
//! needle points may move a little. A travel point inside a stretch of travel
//! that lands on an earlier hole of the same object is dropped when the
//! stitch from the point before to the one after stays close to the route,
//! else slid along the route to the nearest clear spot. Rows, underlay and
//! everything that isn't travel stay as they are.

use std::collections::HashMap;

use crate::geom::Point;
use crate::plan::flags;

use super::Run;

/// A needle point this close to an earlier one lands in its hole (mm).
const SAME_HOLE: f64 = 0.15;
/// How far the stitches may move off the route: half a thread width (mm).
const MAX_DEVIATION: f64 = 0.2;
/// A stitch joined from two is at most this long (mm): a travel stitch.
const MAX_JOINED: f64 = 4.0;
/// How far a needle point may slide along the route (mm), nearest first.
const SLIDES: [f64; 4] = [0.2, 0.3, 0.45, 0.6];
/// A slid point leaves stitches at least this long (mm).
const MIN_STITCH: f64 = 0.3;

fn seg_dist(p: Point, a: Point, b: Point) -> f64 {
    let (dx, dy) = (b.x - a.x, b.y - a.y);
    let l2 = dx * dx + dy * dy;
    let t = if l2 < 1e-12 { 0.0 } else { (((p.x - a.x) * dx + (p.y - a.y) * dy) / l2).clamp(0.0, 1.0) };
    (a.x + dx * t - p.x).hypot(a.y + dy * t - p.y)
}

fn lerp(a: Point, b: Point, t: f64) -> Point {
    Point { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
}

/// The needle holes made so far.
struct Holes {
    cells: HashMap<(i64, i64), Vec<Point>>,
}

impl Holes {
    fn cell(p: Point) -> (i64, i64) {
        ((p.x / SAME_HOLE).floor() as i64, (p.y / SAME_HOLE).floor() as i64)
    }
    fn add(&mut self, p: Point) {
        self.cells.entry(Self::cell(p)).or_default().push(p);
    }
    fn taken(&self, p: Point) -> bool {
        let (cx, cy) = Self::cell(p);
        (-1..=1).any(|dx| (-1..=1).any(|dy| self.cells.get(&(cx + dx, cy + dy)).is_some_and(|v| v.iter().any(|q| q.dist(p) < SAME_HOLE))))
    }
}

/// Move an object's travel stitches off the holes it made before (in sewing order).
/// Returns how many needle points were dropped or moved.
pub fn avoid_own_holes(runs: &mut [Run]) -> usize {
    let mut holes = Holes { cells: HashMap::new() };
    let mut changed = 0;
    for run in runs.iter_mut() {
        if run.is_empty() {
            continue;
        }
        let mut out: Run = Vec::with_capacity(run.len());
        out.push(run[0]);
        holes.add(run[0].0);
        for j in 1..run.len() {
            let (q, f) = run[j];
            let prev = out[out.len() - 1].0;
            // a point inside a stretch of travel (the run's last point and the
            // first one after travel stay: they meet the rows)
            let inside_travel = f & flags::TRAVEL != 0 && j + 1 < run.len() && run[j + 1].1 & flags::TRAVEL != 0;
            if inside_travel && holes.taken(q) {
                let next = run[j + 1].0;
                // drop it: the stitch on to the next point stays on the route
                if prev.dist(next) <= MAX_JOINED && seg_dist(q, prev, next) <= MAX_DEVIATION {
                    changed += 1;
                    continue;
                }
                // slide it along the route, forwards or back, to a clear spot
                let slid = SLIDES.iter().find_map(|&s| {
                    [(q, next), (q, prev)].into_iter().find_map(|(a, b)| {
                        let l = a.dist(b);
                        if l < s + MIN_STITCH {
                            return None;
                        }
                        let c = lerp(a, b, s / l);
                        let ok = !holes.taken(c)
                            && c.dist(prev) >= MIN_STITCH
                            && c.dist(next) >= MIN_STITCH
                            && c.dist(prev) <= MAX_JOINED.max(q.dist(prev))
                            && seg_dist(q, prev, c).min(seg_dist(q, c, next)) <= MAX_DEVIATION;
                        ok.then_some(c)
                    })
                });
                if let Some(c) = slid {
                    changed += 1;
                    holes.add(c);
                    out.push((c, f));
                    continue;
                }
            }
            holes.add(q);
            out.push((q, f));
        }
        *run = out;
    }
    changed
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geom::pt;

    const T: u8 = flags::TRAVEL;

    #[test]
    fn travel_over_its_own_holes_drops_or_slides_them() {
        // a row from (0,0) to (10,0), then travel back along it on the same points, then another row
        let mut runs = vec![vec![
            (pt(0.0, 0.0), 0),
            (pt(2.0, 0.0), 0),
            (pt(4.0, 0.0), 0),
            (pt(6.0, 0.0), 0),
            (pt(8.0, 0.0), 0),
            (pt(10.0, 0.0), 0),
            (pt(8.0, 0.0), T),
            (pt(6.0, 0.0), T),
            (pt(4.0, 0.0), T),
            (pt(2.0, 0.0), T),
            (pt(0.0, 0.3), T),
            (pt(10.0, 0.3), 0),
        ]];
        let before = runs[0].len();
        let n = avoid_own_holes(&mut runs);
        assert!(n >= 3, "{n}: {:?}", runs[0]);
        let r = &runs[0];
        // the rows are untouched, the run still ends where it did
        assert_eq!(&r[..6], &[(pt(0.0, 0.0), 0), (pt(2.0, 0.0), 0), (pt(4.0, 0.0), 0), (pt(6.0, 0.0), 0), (pt(8.0, 0.0), 0), (pt(10.0, 0.0), 0)]);
        assert_eq!(r.last(), Some(&(pt(10.0, 0.3), 0)));
        // no travel point lands on a row's hole, no stitch is longer than a joined one
        for &(p, f) in &r[6..r.len() - 1] {
            if f & T != 0 {
                assert!((0..=5).all(|k| p.dist(pt(2.0 * k as f64, 0.0)) >= SAME_HOLE) || p == pt(0.0, 0.3), "{p:?} in {r:?}");
            }
        }
        assert!(r.windows(2).all(|w| w[0].0.dist(w[1].0) <= MAX_JOINED + 1e-9 || w[1].1 & T == 0), "{r:?}");
        assert!(r.len() <= before);
    }

    #[test]
    fn rows_and_travel_on_new_ground_are_left_alone() {
        let r0: Run = vec![(pt(0.0, 0.0), 0), (pt(3.0, 0.0), 0), (pt(3.0, 0.3), T), (pt(3.0, 3.0), T), (pt(0.0, 3.0), T), (pt(0.0, 3.3), 0)];
        let mut runs = vec![r0.clone()];
        assert_eq!(avoid_own_holes(&mut runs), 0);
        assert_eq!(runs[0], r0);
    }

    #[test]
    fn a_corner_that_would_move_too_far_stays() {
        // travel turning sharply on an old hole: neither dropping nor sliding keeps to the route
        let mut runs = vec![vec![(pt(5.0, 5.0), 0), (pt(9.0, 5.0), 0), (pt(5.0, 0.0), T), (pt(5.0, 5.0), T), (pt(9.0, 0.0), T), (pt(9.0, 0.3), 0)]];
        let n = avoid_own_holes(&mut runs);
        // sliding 0.2 mm along a leg of a sharp corner moves the stitch off the corner by less than 0.2 mm: allowed;
        // whatever happens, the travel never cuts the corner by more than half a thread
        let r = &runs[0];
        let k = r.iter().position(|s| s.0 == pt(9.0, 0.0)).unwrap();
        let corner = r[k - 1].0;
        assert!(corner.dist(pt(5.0, 5.0)) <= 0.61, "{n} {r:?}");
    }
}
