//! Running / bean stitch.
//!
//! Port of Ink/Stitch `lib/stitches/running_stitch.py` (GPL-3.0-or-later):
//! even stitch distribution with Zhao–Saalfeld "sleeve" curve fitting so that
//! stitches hug curves within a tolerance, plus corner splitting.

use std::f64::consts::TAU;

use crate::geom::{Point, pt};

/// Modular interval of angles (whole circle or less than half of it).
#[derive(Clone, Copy, Debug)]
struct AngleInterval {
    a: f64,
    b: f64,
    all: bool,
}

impl AngleInterval {
    fn all() -> Self {
        AngleInterval { a: 0.0, b: TAU, all: true }
    }

    fn from_ball(p: Point, eps: f64) -> Self {
        let d = p.length();
        if d <= eps {
            return Self::all();
        }
        let c = p.angle();
        let delta = (eps / d).asin();
        AngleInterval { a: c - delta, b: c + delta, all: false }
    }

    fn from_segment(a: Point, b: Point) -> Option<Self> {
        let (aa, ab) = (a.angle(), b.angle());
        let diff = (ab - aa).rem_euclid(TAU);
        if diff == 0.0 || diff == std::f64::consts::PI {
            None
        } else if diff < std::f64::consts::PI {
            Some(AngleInterval { a: aa - 1e-6, b: ab + 1e-6, all: false })
        } else {
            Some(AngleInterval { a: ab - 1e-6, b: aa + 1e-6, all: false })
        }
    }

    fn contains_angle(&self, ang: f64) -> bool {
        self.all || (ang - self.a).rem_euclid(TAU) <= (self.b - self.a).rem_euclid(TAU)
    }

    fn contains_point(&self, p: Point) -> bool {
        self.contains_angle(p.y.atan2(p.x))
    }

    fn intersect(&self, other: Option<Self>) -> Option<Self> {
        let other = other?;
        if self.all {
            return Some(other);
        }
        if other.all {
            return Some(*self);
        }
        if self.contains_angle(other.a) {
            if other.contains_angle(self.b) {
                Some(AngleInterval { a: other.a, b: self.b, all: false })
            } else {
                Some(other)
            }
        } else if other.contains_angle(self.a) {
            if self.contains_angle(other.b) {
                Some(AngleInterval { a: self.a, b: other.b, all: false })
            } else {
                Some(*self)
            }
        } else {
            None
        }
    }

    fn cut_segment(&self, origin: Point, a: Point, b: Point) -> Option<Point> {
        if self.all {
            return None;
        }
        let arc = match AngleInterval::from_segment(a - origin, b - origin) {
            None => return Some(a),
            Some(x) => x,
        };
        if arc.contains_angle(self.a) {
            Some(cut_with_angle(origin, self.a, a, b))
        } else if arc.contains_angle(self.b) {
            Some(cut_with_angle(origin, self.b, a, b))
        } else {
            None
        }
    }
}

fn cut_with_angle(origin: Point, angle: f64, a: Point, b: Point) -> Point {
    let p = a - origin;
    let d = b - a;
    let c = pt(angle.cos(), angle.sin());
    let denom = d.x * c.y - d.y * c.x;
    if denom.abs() < 1e-15 {
        return a;
    }
    let t = ((p.y * c.x - p.x * c.y) / denom).clamp(0.0, 1.0);
    a + d * t
}

fn cut_with_circle(origin: Point, r: f64, a: Point, b: Point) -> Point {
    let p = a - origin;
    let d = b - a;
    let p2 = p.dot(p);
    let d2 = d.dot(d);
    if d2 < 1e-18 {
        return a;
    }
    let pd = p.dot(d);
    let disc = (pd * pd + r * r * d2 - p2 * d2).max(0.0);
    let t = ((disc.sqrt() - pd) / d2).clamp(0.0, 1.0);
    a + d * t
}

/// Take one stitch from `start` along `points[idx..]` (Zhao–Saalfeld sleeve fitting).
fn take_stitch(start: Point, points: &[Point], idx: usize, len: f64, tol: f64) -> (Option<Point>, Option<usize>) {
    if idx >= points.len() {
        return (None, None);
    }
    let mut sleeve = Some(AngleInterval::all());
    let mut last = start;
    for (i, &p) in points.iter().enumerate().skip(idx) {
        let sl = match sleeve {
            Some(s) => s,
            None => return (Some(last), Some(i)),
        };
        if sl.contains_point(p - start) {
            if start.dist(p) < len {
                sleeve = sl.intersect(Some(AngleInterval::from_ball(p - start, tol)));
                last = p;
                continue;
            }
            return (Some(cut_with_circle(start, len, last, p)), Some(i));
        }
        let mut cut = sl.cut_segment(start, last, p).unwrap_or(last);
        if start.dist(cut) > len {
            cut = cut_with_circle(start, len, last, p);
        }
        if cut.dist(start) < 1e-9 {
            // degenerate; advance to avoid infinite loops
            return (Some(p), Some(i + 1));
        }
        return (Some(cut), Some(i));
    }
    (Some(*points.last().unwrap()), None)
}

/// Split a polyline into even-length stitches. Includes the end point, not the start.
pub fn stitch_curve_evenly(points: &[Point], length: f64, tol: f64) -> Vec<Point> {
    if points.len() < 2 {
        return vec![];
    }
    let n = points.len();
    let mut dist_left = vec![0.0; n];
    for j in (0..n - 1).rev() {
        dist_left[j] = dist_left[j + 1] + points[j].dist(points[j + 1]);
    }
    let mut i = Some(1usize);
    let mut last = points[0];
    let mut out = Vec::new();
    let mut guard = 0;
    while let Some(ii) = i {
        if ii >= n || guard > 1_000_000 {
            break;
        }
        guard += 1;
        let d = last.dist(points[ii]) + dist_left[ii];
        if d <= 1e-9 {
            break;
        }
        let stitch_len = d / (d / length).ceil() + 1e-6;
        let (s, ni) = take_stitch(last, points, ii, stitch_len, tol);
        i = ni;
        if let Some(s) = s {
            if s.dist(last) > 1e-9 {
                out.push(s);
                last = s;
            }
        }
    }
    if let Some(l) = points.last() {
        if out.last().map_or(true, |o| o.dist(*l) > 1e-6) {
            out.push(*l);
        }
    }
    out
}

/// Split a path at sharp corners (> 45°) so corners are stitched exactly.
pub fn path_to_curves(points: &[Point], min_len: f64) -> Vec<Vec<Point>> {
    if points.len() < 3 {
        return vec![points.to_vec()];
    }
    let mut curves = Vec::new();
    let mut last = 0usize;
    let mut last_seg = points[1] - points[0];
    let mut seg_len = last_seg.length();
    for i in 1..points.len() - 1 {
        let a = last_seg;
        let b = points[i + 1] - points[i];
        let aabb = a.dot(a) * b.dot(b);
        let abab = a.dot(b) * a.dot(b).abs();
        if aabb > 0.0 && abab <= 0.5 * aabb {
            if seg_len >= min_len {
                curves.push(points[last..=i].to_vec());
                last = i;
            }
            seg_len = 0.0;
        }
        if b.dot(b) > 0.0 {
            last_seg = b;
        }
        seg_len += b.length();
    }
    curves.push(points[last..].to_vec());
    curves
}

/// Full running stitch along a polyline; output includes the first point.
pub fn running_stitch(points: &[Point], length: f64, tol: f64) -> Vec<Point> {
    let mut pts: Vec<Point> = points.to_vec();
    pts.dedup_by(|b, a| a.dist(*b) < 1e-6);
    if pts.len() < 2 {
        return pts;
    }
    let length = length.max(0.3);
    let tol = tol.clamp(0.01, length);
    let mut out = vec![pts[0]];
    for curve in path_to_curves(&pts, 2.0 * tol) {
        out.extend(stitch_curve_evenly(&curve, length, tol));
    }
    out.dedup_by(|b, a| a.dist(*b) < 1e-6);
    out
}

/// Bean stitch: repeat every stitch back and forth `repeats` extra times.
pub fn bean_stitch(stitches: &[Point], repeats: u32) -> Vec<Point> {
    if repeats == 0 || stitches.len() < 2 {
        return stitches.to_vec();
    }
    let mut out = vec![stitches[0]];
    for w in stitches.windows(2) {
        out.push(w[1]);
        for k in 0..repeats {
            out.push(if k % 2 == 0 { w[0] } else { w[1] });
        }
        if repeats % 2 == 1 {
            out.push(w[1]);
        }
    }
    out
}

/// Traverse a running stitch path `repeats` times (there and back).
pub fn repeat_path(stitches: &[Point], repeats: u32) -> Vec<Point> {
    let mut out = stitches.to_vec();
    for k in 1..repeats.max(1) {
        let mut seg: Vec<Point> = stitches.to_vec();
        if k % 2 == 1 {
            seg.reverse();
        }
        out.extend(seg.into_iter().skip(1));
    }
    out
}

thread_local! {
    /// Random stitch length of the fill being sewn: (jitter 0..1, seed), and
    /// a counter that gives each of its lines its own random sequence.
    static LINE_RANDOM: std::cell::Cell<Option<(f64, u32)>> = const { std::cell::Cell::new(None) };
    static LINE_STREAM: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
}

/// Sew the lines of fills with random stitch lengths (Ink/Stitch
/// `enable_random_stitch_length` on fills) while `f` runs: `pct` % jitter.
pub fn with_line_random<T>(pct: f64, seed: u32, f: impl FnOnce() -> T) -> T {
    let on = pct > 0.0;
    if on {
        LINE_RANDOM.with(|c| c.set(Some(((pct / 100.0).clamp(0.0, 0.95), seed))));
        LINE_STREAM.with(|c| c.set(0));
    }
    let r = f();
    if on {
        LINE_RANDOM.with(|c| c.set(None));
    }
    r
}

/// The random stitch length of the fill being sewn, if any.
pub fn line_random() -> Option<(f64, u32)> {
    LINE_RANDOM.with(|c| c.get())
}

/// One sewn line of a fill: a running stitch, with random lengths when the
/// fill asks for them (see [`with_line_random`]).
pub fn sew_line(points: &[Point], length: f64, tol: f64) -> Vec<Point> {
    match line_random() {
        Some((jitter, seed)) => {
            let k = LINE_STREAM.with(|c| {
                let k = c.get();
                c.set(k + 1);
                k
            });
            running_stitch_with(points, &StitchLength { lengths: vec![length.max(0.3)], jitter, seed }, tol, k)
        }
        None => running_stitch(points, length, tol),
    }
}

/// Split a polyline into stitches following a repeating pattern of lengths
/// (Ink/Stitch "2 1"), each adapted so the curve ends on a whole stitch.
/// `pos` is the position in the pattern; returns stitches (end point, not
/// start) and the next position.
fn stitch_curve_pattern(points: &[Point], lengths: &[f64], tol: f64, mut pos: usize) -> (Vec<Point>, usize) {
    if points.len() < 2 {
        return (vec![], pos);
    }
    let n = points.len();
    let mut dist_left = vec![0.0; n];
    for j in (0..n - 1).rev() {
        dist_left[j] = dist_left[j + 1] + points[j].dist(points[j + 1]);
    }
    let mut i = Some(1usize);
    let mut last = points[0];
    let mut out = Vec::new();
    let mut guard = 0;
    while let Some(ii) = i {
        if ii >= n || guard > 1_000_000 {
            break;
        }
        guard += 1;
        let d = last.dist(points[ii]) + dist_left[ii];
        if d <= 1e-9 {
            break;
        }
        let stitch_len = d / (d / lengths[pos]).ceil() + 1e-6;
        let (s, ni) = take_stitch(last, points, ii, stitch_len, tol);
        i = ni;
        if let Some(s) = s {
            if s.dist(last) > 1e-9 {
                out.push(s);
                last = s;
                pos = (pos + 1) % lengths.len();
            }
        }
    }
    if let Some(l) = points.last() {
        if out.last().map_or(true, |o| o.dist(*l) > 1e-6) {
            out.push(*l);
        }
    }
    (out, pos)
}

/// Ink/Stitch `stitch_curve_randomly`: stitch lengths drawn from
/// length × (1 ± jitter), with a random phase after shortened stitches so
/// that parallel lines don't line up (no moiré).
fn stitch_curve_random(points: &[Point], lengths: &[f64], tol: f64, jitter: f64, rng: &mut crate::prng::Stream, mut pos: usize) -> (Vec<Point>, usize) {
    if points.len() < 2 {
        return (vec![], pos);
    }
    let lerp = |a: f64, b: f64, t: f64| a + (b - a) * t;
    let mut i = Some(1usize);
    let mut last = points[0];
    let mut last_shortened = 0.0;
    let mut out = Vec::new();
    let mut guard = 0;
    while let Some(ii) = i {
        if ii >= points.len() || guard > 1_000_000 {
            break;
        }
        guard += 1;
        let l = lengths[pos];
        pos = (pos + 1) % lengths.len();
        let (lo, hi) = ((l * (1.0 - jitter)).max(0.0), l * (1.0 + jitter));
        let r = rng.next();
        let len = (lerp(last_shortened, 1.0, r) * lerp(lo, hi, r)).max(0.05);
        let (s, ni) = take_stitch(last, points, ii, len, tol);
        i = ni;
        if let Some(s) = s {
            if s.dist(last) > 1e-9 {
                last_shortened = (last.dist(s) / len).min(1.0);
                out.push(s);
                last = s;
            }
        }
    }
    if let Some(l) = points.last() {
        if out.last().map_or(true, |o| o.dist(*l) > 1e-6) {
            out.push(*l);
        }
    }
    (out, pos)
}

/// Stitch lengths along a line: one length or a repeating pattern, optionally
/// randomised (Ink/Stitch `running_stitch_length_mm` with several values,
/// `enable_random_stitch_length` / `random_stitch_length_jitter_percent`).
/// Shared by running stitch, ripples and the line-based fills.
#[derive(Debug, Clone, PartialEq)]
pub struct StitchLength {
    /// One or more lengths (mm), used in turn.
    pub lengths: Vec<f64>,
    /// Random variation of each length (0..1, 0 = even stitches).
    pub jitter: f64,
    pub seed: u32,
}

impl StitchLength {
    pub fn even(length: f64) -> Self {
        StitchLength { lengths: vec![length], jitter: 0.0, seed: 0 }
    }
    /// `length`, or `pattern` when it has values, randomised by `jitter_pct` %.
    pub fn new(length: f64, pattern: &[f64], jitter_pct: f64, seed: u32) -> Self {
        let lengths = if pattern.iter().any(|l| *l > 0.0) { pattern.iter().filter(|l| **l > 0.0).map(|l| l.max(0.3)).collect() } else { vec![length.max(0.3)] };
        StitchLength { lengths, jitter: (jitter_pct / 100.0).clamp(0.0, 0.95), seed }
    }
    pub fn is_plain(&self) -> bool {
        self.lengths.len() == 1 && self.jitter <= 0.0
    }
    /// The first (main) length.
    pub fn main(&self) -> f64 {
        self.lengths.first().copied().unwrap_or(2.5)
    }
}

/// Running stitch with a length pattern and/or random lengths; output
/// includes the first point. `stream` separates the random sequences of
/// several lines of one object.
pub fn running_stitch_with(points: &[Point], len: &StitchLength, tol: f64, stream: u64) -> Vec<Point> {
    if len.is_plain() {
        return running_stitch(points, len.main(), tol);
    }
    let mut pts: Vec<Point> = points.to_vec();
    pts.dedup_by(|b, a| a.dist(*b) < 1e-6);
    if pts.len() < 2 {
        return pts;
    }
    let lengths: Vec<f64> = len.lengths.iter().map(|l| l.max(0.3)).collect();
    let tol = tol.clamp(0.01, lengths.iter().cloned().fold(f64::INFINITY, f64::min));
    let mut out = vec![pts[0]];
    let mut pos = 0;
    let mut rng = crate::prng::Stream::new(len.seed, stream);
    for curve in path_to_curves(&pts, 2.0 * tol) {
        let (s, p) = if len.jitter > 0.0 { stitch_curve_random(&curve, &lengths, tol, len.jitter, &mut rng, pos) } else { stitch_curve_pattern(&curve, &lengths, tol, pos) };
        pos = p;
        out.extend(s);
    }
    out.dedup_by(|b, a| a.dist(*b) < 1e-6);
    out
}

/// Bean stitch with a pattern: stitch `i` is sewn back and forth
/// `pattern[i % len]` extra times (Ink/Stitch `bean_stitch_repeats` "0 1 3",
/// counted in passes here: Ink/Stitch's 1 is 2).
pub fn bean_stitch_pattern(stitches: &[Point], pattern: &[u32]) -> Vec<Point> {
    if pattern.is_empty() || pattern.iter().all(|r| *r == 0) || stitches.len() < 2 {
        return stitches.to_vec();
    }
    if pattern.len() == 1 {
        return bean_stitch(stitches, pattern[0]);
    }
    let mut out = vec![stitches[0]];
    for (i, w) in stitches.windows(2).enumerate() {
        let repeats = pattern[i % pattern.len()];
        out.push(w[1]);
        for k in 0..repeats {
            out.push(if k % 2 == 0 { w[0] } else { w[1] });
        }
        if repeats % 2 == 1 {
            out.push(w[1]);
        }
    }
    out
}

/// Split stitches longer than `max` into even parts (Ink/Stitch manual
/// stitch `max_stitch_length_mm`).
pub fn split_long(stitches: &[Point], max: f64) -> Vec<Point> {
    if !(max > 0.0) || stitches.len() < 2 {
        return stitches.to_vec();
    }
    // a 1e-6 mm maximum would make millions of stitches (a hang)
    let max = max.max(MIN_SPLIT);
    let mut out = vec![stitches[0]];
    for w in stitches.windows(2) {
        let n = (w[0].dist(w[1]) / max).ceil().max(1.0) as usize;
        for k in 1..=n {
            out.push(w[0].lerp(w[1], k as f64 / n as f64));
        }
    }
    out
}

/// Shortest length [`split_long`] splits to (mm).
pub const MIN_SPLIT: f64 = 0.05;

/// Ink/Stitch's zig-zag stroke (`stroke_method=zigzag_stitch`, `zigzag_stitch`):
/// points evenly along the line (an even number of half-spacings), moved
/// alternately to each side by `width / 2 + pull_comp`, the sideways
/// direction rotated by `angle` degrees (spoke effects, clamped to ±89°).
pub fn zigzag_stitch(points: &[Point], spacing: f64, width: f64, pull_comp: f64, angle: f64, tol: f64, closed: bool) -> Vec<Point> {
    let half = spacing.max(0.01) / 2.0;
    // the line, as a running stitch at half the spacing
    let line = running_stitch(points, half.max(0.3), tol);
    if line.len() < 2 {
        return line;
    }
    let mut cum = vec![0.0];
    for w in line.windows(2) {
        cum.push(cum.last().unwrap() + w[0].dist(w[1]));
    }
    let total = *cum.last().unwrap();
    if total <= 1e-9 {
        return line;
    }
    let mut segs = ((total / half).round() as usize).max(2);
    if segs % 2 == 1 {
        segs += 1;
    }
    let at = |d: f64| -> Point {
        let k = cum.partition_point(|c| *c < d).clamp(1, line.len() - 1);
        let (a, b) = (line[k - 1], line[k]);
        let l = cum[k] - cum[k - 1];
        if l <= 1e-12 {
            b
        } else {
            a.lerp(b, ((d - cum[k - 1]) / l).clamp(0.0, 1.0))
        }
    };
    let pos: Vec<Point> = (0..=segs).map(|i| at(i as f64 / segs as f64 * total)).collect();
    let off = width / 2.0 + pull_comp;
    let a = angle.clamp(-89.0, 89.0).to_radians();
    let (ca, sa) = (a.cos(), a.sin());
    let mut out = Vec::with_capacity(pos.len());
    for i in 0..pos.len() {
        let dir = if i == 0 {
            pos[1] - pos[0]
        } else if i + 1 == pos.len() {
            pos[i] - pos[i - 1]
        } else {
            let (inc, outg) = (pos[i] - pos[i - 1], pos[i + 1] - pos[i]);
            if inc.length() > 0.0 && outg.length() > 0.0 {
                (inc * (1.0 / inc.length()) + outg * (1.0 / outg.length())) * 0.5
            } else if inc.length() > 0.0 {
                inc
            } else {
                outg
            }
        };
        if dir.length() <= 1e-12 {
            out.push(pos[i]);
            continue;
        }
        let u = dir * (1.0 / dir.length());
        // sideways (Ink/Stitch rotate_left), then turned by the angle
        let z = pt(u.y, -u.x);
        let z = pt(z.x * ca - z.y * sa, z.x * sa + z.y * ca);
        out.push(if i % 2 == 1 { pos[i] - z * off } else { pos[i] + z * off });
    }
    if closed && out.len() >= 2 {
        let f = out[0];
        *out.last_mut().unwrap() = f;
    }
    out
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn straight_line_even() {
        let s = running_stitch(&[pt(0.0, 0.0), pt(10.0, 0.0)], 2.5, 0.2);
        assert_eq!(s.len(), 5);
        for w in s.windows(2) {
            assert!((w[0].dist(w[1]) - 2.5).abs() < 0.01);
        }
    }

    #[test]
    fn circle_follows_curve() {
        let pts: Vec<Point> = (0..=200)
            .map(|i| {
                let a = i as f64 / 200.0 * TAU;
                pt(10.0 * a.cos(), 10.0 * a.sin())
            })
            .collect();
        let s = running_stitch(&pts, 2.0, 0.1);
        for p in &s {
            assert!((p.length() - 10.0).abs() < 0.2);
        }
        for w in s.windows(2) {
            assert!(w[0].dist(w[1]) <= 2.05);
        }
    }

    #[test]
    fn bean_triples() {
        let s = bean_stitch(&[pt(0.0, 0.0), pt(1.0, 0.0)], 2);
        assert_eq!(s, vec![pt(0.0, 0.0), pt(1.0, 0.0), pt(0.0, 0.0), pt(1.0, 0.0)]);
    }
}

#[cfg(test)]
mod pattern_tests {
    use super::*;

    fn line(l: f64) -> Vec<Point> {
        vec![pt(0.0, 0.0), pt(l, 0.0)]
    }

    #[test]
    fn a_length_pattern_alternates() {
        let s = running_stitch_with(&line(30.0), &StitchLength::new(2.5, &[2.0, 1.0], 0.0, 1), 0.2, 0);
        let d: Vec<f64> = s.windows(2).map(|w| w[0].dist(w[1])).collect();
        assert!(d.len() >= 18, "{d:?}");
        // long and short in turn (each adapted to the rest of the line, as in Ink/Stitch)
        for (i, x) in d.iter().take(10).enumerate() {
            let ok = if i % 2 == 0 { *x > 1.6 && *x <= 2.0 + 1e-3 } else { *x > 0.8 && *x <= 1.0 + 1e-3 };
            assert!(ok, "stitch {i}: {x}");
        }
    }

    #[test]
    fn random_lengths_vary_within_the_jitter_and_repeat() {
        let len = StitchLength::new(3.0, &[], 20.0, 7);
        let a = running_stitch_with(&line(200.0), &len, 0.2, 0);
        let b = running_stitch_with(&line(200.0), &len, 0.2, 0);
        assert_eq!(a, b, "same seed, same stitches");
        let d: Vec<f64> = a.windows(2).map(|w| w[0].dist(w[1])).collect();
        let inner = &d[1..d.len() - 1];
        assert!(inner.iter().all(|x| *x <= 3.0 * 1.2 + 1e-6), "{inner:?}");
        let (lo, hi) = inner.iter().fold((f64::MAX, 0.0f64), |(l, h), x| (l.min(*x), h.max(*x)));
        assert!(hi - lo > 0.3, "lengths vary: {lo}..{hi}");
        let c = running_stitch_with(&line(200.0), &StitchLength::new(3.0, &[], 20.0, 8), 0.2, 0);
        assert_ne!(a, c, "another seed, other stitches");
    }

    #[test]
    fn bean_pattern_repeats_stitches_in_turn() {
        let s = vec![pt(0.0, 0.0), pt(1.0, 0.0), pt(2.0, 0.0), pt(3.0, 0.0)];
        let b = bean_stitch_pattern(&s, &[0, 2]);
        // stitch 1 plain, stitch 2 tripled, stitch 3 plain
        assert_eq!(b, vec![pt(0.0, 0.0), pt(1.0, 0.0), pt(2.0, 0.0), pt(1.0, 0.0), pt(2.0, 0.0), pt(3.0, 0.0)]);
    }

    #[test]
    fn long_manual_stitches_are_split() {
        let s = split_long(&[pt(0.0, 0.0), pt(10.0, 0.0), pt(11.0, 0.0)], 3.0);
        assert_eq!(s.len(), 6);
        assert!(s.windows(2).all(|w| w[0].dist(w[1]) <= 3.0 + 1e-9));
    }

    #[test]
    fn zigzag_alternates_sides_and_turns_by_the_angle() {
        let z = zigzag_stitch(&line(20.0), 1.0, 2.0, 0.0, 0.0, 0.2, false);
        assert!(z.len() % 2 == 1, "starts and ends on the same side");
        for (i, p) in z.iter().enumerate() {
            assert!((p.y.abs() - 1.0).abs() < 1e-6, "{i}: {p:?}");
            if i > 0 {
                assert!(p.y * z[i - 1].y < 0.0, "sides alternate");
            }
        }
        let t = zigzag_stitch(&line(20.0), 1.0, 2.0, 0.0, 45.0, 0.2, false);
        let mid = z.len() / 2;
        let along = t[mid].x - z[mid].x;
        assert!(along.abs() > 0.2, "turned zig-zags lean along the line: {along}");
    }
}
