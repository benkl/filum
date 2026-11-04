//! Lock stitches, after Ink/Stitch (`lib/stitch_plan/lock_stitch.py`).
//!
//! * Half stitch (Ink/Stitch's default): back and forth half a stitch along
//!   the path — "0 0.5 1 0.5 0" of a stitch length kept within 0.5–1.5 mm.
//! * Back and forth: "1 1 −1 −1" times a fixed length along the path.
//! * Arrow, bowtie, cross, star, simple, triangle, zig-zag: small shapes
//!   (SVG paths in mm, scaled by a percentage) turned so their last segment —
//!   the direction mark — points along the first stitch.
//!
//! `path` is the stitching from the lock point on: for a start lock the
//! stitches ahead, for an end lock the stitches behind, nearest first.

use crate::geom::{pt, Point};
use crate::model::LockStyle;

/// The SVG path of a shape lock (`None`: not a shape lock).
fn shape(style: LockStyle) -> Option<&'static str> {
    Some(match style {
        LockStyle::Arrow => "M 0.5,0.3 0.3,1.31 -0.11,0.68 H 0.9 L 0.5,1.31 0.4,0.31 V 0.31 1.3",
        LockStyle::Bowtie => "M 0,0 -0.39,0.97 0.3,0.03 0.14,1.02 0,0 V 0.15",
        LockStyle::Cross => "M 0,0 -0.7,-0.7 0.7,0.7 0,0 -0.7,0.7 0.7,-0.7 0,0 -0,-0.7",
        LockStyle::Star => "M 0.67,-0.2 C 0.27,-0.06 -0.22,0.11 -0.67,0.27 L 0.57,0.33 -0.5,-0.27 0,0.67 V 0 -0.5",
        LockStyle::Simple => "M -0.03,0 0.09,0.81 0,1.49 V 0 0.48",
        LockStyle::Triangle => "M -0.26,0.33 H 0.55 L 0,0.84 V 0 L 0.34,0.82",
        LockStyle::Zigzag => "M -0.25,0.2 0.17,0.77 -0.22,1.45 0.21,2.05 -0.03,3 0,0",
        LockStyle::HalfStitch | LockStyle::BackForth => return None,
    })
}

/// The end points of a simple absolute SVG path (M, L, H, V, C).
fn end_points(d: &str) -> Vec<Point> {
    let mut out: Vec<Point> = Vec::new();
    let mut cur = pt(0.0, 0.0);
    let mut cmd = 'M';
    let mut nums: Vec<f64> = Vec::new();
    let flush = |cmd: char, nums: &mut Vec<f64>, cur: &mut Point, out: &mut Vec<Point>| {
        match cmd {
            'M' | 'L' => {
                for c in nums.chunks(2).filter(|c| c.len() == 2) {
                    *cur = pt(c[0], c[1]);
                    out.push(*cur);
                }
            }
            'H' => {
                for x in nums.iter() {
                    *cur = pt(*x, cur.y);
                    out.push(*cur);
                }
            }
            'V' => {
                for y in nums.iter() {
                    *cur = pt(cur.x, *y);
                    out.push(*cur);
                }
            }
            'C' => {
                for c in nums.chunks(6).filter(|c| c.len() == 6) {
                    *cur = pt(c[4], c[5]);
                    out.push(*cur);
                }
            }
            _ => {}
        }
        nums.clear();
    };
    for tok in d.replace(',', " ").split_whitespace() {
        match tok.chars().next() {
            Some(c) if c.is_ascii_alphabetic() => {
                flush(cmd, &mut nums, &mut cur, &mut out);
                cmd = c.to_ascii_uppercase();
            }
            _ => {
                if let Ok(v) = tok.parse::<f64>() {
                    nums.push(v);
                }
            }
        }
    }
    flush(cmd, &mut nums, &mut cur, &mut out);
    out
}

/// A point `d` along the path (negative: back along its first stitch).
fn along(path: &[Point], d: f64) -> Point {
    if path.len() < 2 {
        return path[0];
    }
    if d <= 0.0 {
        let u = (path[1] - path[0]).unit();
        return path[0] + u * d;
    }
    let mut left = d;
    for w in path.windows(2) {
        let l = w[0].dist(w[1]);
        if left <= l {
            return w[0] + (w[1] - w[0]) * (left / l.max(1e-12));
        }
        left -= l;
    }
    path[path.len() - 1]
}

/// The lock stitches at `path[0]` (see the module docs), without the lock
/// point itself where the path already holds it.
pub fn lock_points(style: LockStyle, path: &[Point], scale_pct: f64, length_mm: f64, end: bool) -> Vec<Point> {
    let path: Vec<Point> = {
        let mut p: Vec<Point> = Vec::with_capacity(path.len());
        for q in path {
            if p.last().is_none_or(|l: &Point| l.dist(*q) > 1e-6) {
                p.push(*q);
            }
        }
        p
    };
    if path.is_empty() {
        return vec![];
    }
    let origin = path[0];
    match style {
        LockStyle::HalfStitch => {
            // the direction of the first stitch longer than 0.5 mm, 0.5–1.5 mm long
            let (dir, len) = path
                .iter()
                .skip(1)
                .take(15)
                .find(|q| q.dist(origin) > 0.5)
                .map(|q| ((*q - origin).unit(), q.dist(origin).clamp(0.5, 1.5)))
                .unwrap_or((pt(1.0, 0.0), 0.5));
            let deltas: &[f64] = if end { &[0.5, 1.0, 0.5, 0.0] } else { &[0.0, 0.5, 1.0, 0.5, 0.0] };
            deltas.iter().map(|d| origin + dir * (d * len)).collect()
        }
        LockStyle::BackForth => {
            let a = length_mm.max(0.1);
            let ds: &[f64] = if end { &[a, 2.0 * a, a, 0.0] } else { &[0.0, a, 2.0 * a, a] };
            ds.iter().map(|d| along(&path, *d)).collect()
        }
        _ => {
            let Some(d) = shape(style) else { return vec![] };
            let k = scale_pct.max(1.0) / 100.0;
            let pts: Vec<Point> = end_points(d).into_iter().map(|q| q * k).collect();
            if pts.len() < 3 || path.len() < 2 {
                return vec![];
            }
            // the direction mark (last segment) along the first stitch, its start on the lock point
            let (m0, m1) = (pts[pts.len() - 2], pts[pts.len() - 1]);
            let turn = (path[1] - path[0]).y.atan2((path[1] - path[0]).x) - (m1 - m0).y.atan2((m1 - m0).x);
            let (c, s) = (turn.cos(), turn.sin());
            let mut out: Vec<Point> = pts[..pts.len() - 2]
                .iter()
                .map(|q| {
                    let v = *q - m0;
                    origin + pt(v.x * c - v.y * s, v.x * s + v.y * c)
                })
                .collect();
            if end {
                out.reverse();
            }
            out
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn half_stitch_goes_half_way_and_back() {
        let path = [pt(0.0, 0.0), pt(2.0, 0.0), pt(4.0, 0.0)];
        let p = lock_points(LockStyle::HalfStitch, &path, 100.0, 0.7, false);
        let xs: Vec<f64> = p.iter().map(|q| q.x).collect();
        assert_eq!(xs, vec![0.0, 0.75, 1.5, 0.75, 0.0]);
    }

    #[test]
    fn shape_locks_point_along_the_stitch() {
        // the direction mark turned onto the first stitch: the lock ends next to the path
        for style in [LockStyle::Arrow, LockStyle::Bowtie, LockStyle::Cross, LockStyle::Star, LockStyle::Simple, LockStyle::Triangle, LockStyle::Zigzag] {
            let path = [pt(10.0, 10.0), pt(10.0, 15.0)];
            let p = lock_points(style, &path, 100.0, 0.7, false);
            assert!(p.len() >= 3, "{style:?}");
            // every lock stitch stays within a few mm of the lock point
            assert!(p.iter().all(|q| q.dist(path[0]) < 3.5), "{style:?}: {p:?}");
        }
        // scaled
        let big = lock_points(LockStyle::Cross, &[pt(0.0, 0.0), pt(5.0, 0.0)], 200.0, 0.7, false);
        let small = lock_points(LockStyle::Cross, &[pt(0.0, 0.0), pt(5.0, 0.0)], 100.0, 0.7, false);
        let reach = |v: &Vec<Point>| v.iter().map(|q| q.length()).fold(0.0, f64::max);
        assert!((reach(&big) / reach(&small) - 2.0).abs() < 1e-6);
    }

    #[test]
    fn back_and_forth_follows_the_path() {
        let path = [pt(0.0, 0.0), pt(0.0, 3.0)];
        let p = lock_points(LockStyle::BackForth, &path, 100.0, 0.5, false);
        let ys: Vec<f64> = p.iter().map(|q| q.y).collect();
        assert_eq!(ys, vec![0.0, 0.5, 1.0, 0.5]);
    }
}
