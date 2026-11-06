//! Bézier path simplification that always terminates.
//!
//! A port of kurbo 0.13's `simplify_bezpath` / `fit_to_bezpath`
//! (<https://github.com/linebender/kurbo>, Apache-2.0 / MIT) with the
//! failure modes that can make kurbo's version run forever removed:
//!
//! * kurbo's cubic fit has no limit on the control-arm length. When an end
//!   tangent lines up with the chord to within rounding (th ≈ 1e-13) while the
//!   source still encloses area, the quartic yields a candidate whose arm is
//!   ~1e12 chord lengths long. On "spicy" ranges kurbo then measures that
//!   candidate by arc length (`arclen(1e-9)` + `inv_arclen`), whose ITP root
//!   finder gets an epsilon far below f64 resolution (and a `1 << 66` shift)
//!   and never leaves its loop. Here candidates with arms longer than
//!   [`D_MAX`] chords are dropped (their length penalty already rules them out
//!   of kurbo's own choice), and arc-length sampling uses a fixed-size table.
//! * Recursive subdivision is capped by depth and by a total work budget, so
//!   degenerate or non-finite input degrades to straight chords instead of
//!   recursing ~2^52 times.
//!
//! Results match kurbo's for ordinary input.

use core::ops::Range;

use kurbo::common::{factor_quartic_inner, solve_cubic, solve_quadratic};
use kurbo::simplify::SimplifyBezPath;
use kurbo::{
    Affine, BezPath, CubicBez, CurveFitSample, Line, ParamCurve, ParamCurveFit, ParamCurveNearest,
    PathEl, PathSeg, Point, QuadBez, Vec2,
};

/// Longest control arm a fitted candidate may have, in chord lengths.
const D_MAX: f64 = 10.0;
/// Deepest midpoint subdivision of one smooth run.
const MAX_DEPTH: u32 = 30;
/// Points of the arc-length table of a candidate cubic.
const ARC_TABLE: usize = 256;

/// Simplify a Bézier path: runs between corners (joins turning more than
/// `atan(angle_thresh)`) are refitted with as few cubics as `accuracy` allows.
pub fn simplify_bezpath(path: impl IntoIterator<Item = PathEl>, accuracy: f64, angle_thresh: f64) -> BezPath {
    let accuracy = if accuracy.is_finite() && accuracy > 0.0 { accuracy } else { 1e-3 };
    let mut last_pt: Option<Point> = None;
    let mut last_seg: Option<PathSeg> = None;
    let mut state = State::default();
    for el in path {
        let mut this_seg = None;
        match el {
            PathEl::MoveTo(p) => {
                state.flush(accuracy);
                state.needs_moveto = true;
                last_pt = Some(p);
            }
            PathEl::LineTo(p) => {
                let Some(last) = last_pt else { continue };
                if last == p {
                    continue;
                }
                this_seg = Some(PathSeg::Line(Line::new(last, p)));
            }
            PathEl::QuadTo(p1, p2) => {
                let Some(last) = last_pt else { continue };
                if last == p1 && last == p2 {
                    continue;
                }
                this_seg = Some(PathSeg::Quad(QuadBez::new(last, p1, p2)));
            }
            PathEl::CurveTo(p1, p2, p3) => {
                let Some(last) = last_pt else { continue };
                if last == p1 && last == p2 && last == p3 {
                    continue;
                }
                this_seg = Some(PathSeg::Cubic(CubicBez::new(last, p1, p2, p3)));
            }
            PathEl::ClosePath => {
                state.flush(accuracy);
                state.result.close_path();
                state.needs_moveto = true;
                last_seg = None;
                continue;
            }
        }
        if let Some(seg) = this_seg {
            if let Some(last) = last_seg {
                let last_tan = tangents(&last).1;
                let this_tan = tangents(&seg).0;
                // a reversal (cusp) is a corner too; kurbo only compares |dot|
                if last_tan.cross(this_tan).abs() > last_tan.dot(this_tan).abs() * angle_thresh
                    || last_tan.dot(this_tan) < 0.0
                {
                    state.flush(accuracy);
                }
            }
            last_pt = Some(seg.end());
            state.add_seg(seg);
        }
        last_seg = this_seg;
    }
    state.flush(accuracy);
    state.result
}

/// Endpoint tangents, robust to coincident control points.
fn tangents(seg: &PathSeg) -> (Vec2, Vec2) {
    const EPS: f64 = 1e-12;
    match seg {
        PathSeg::Line(l) => {
            let d = l.p1 - l.p0;
            (d, d)
        }
        PathSeg::Quad(q) => {
            let d01 = q.p1 - q.p0;
            let d0 = if d01.hypot2() > EPS { d01 } else { q.p2 - q.p0 };
            let d12 = q.p2 - q.p1;
            let d1 = if d12.hypot2() > EPS { d12 } else { q.p2 - q.p0 };
            (d0, d1)
        }
        PathSeg::Cubic(c) => {
            let d01 = c.p1 - c.p0;
            let d0 = if d01.hypot2() > EPS {
                d01
            } else {
                let d02 = c.p2 - c.p0;
                if d02.hypot2() > EPS { d02 } else { c.p3 - c.p0 }
            };
            let d23 = c.p3 - c.p2;
            let d1 = if d23.hypot2() > EPS {
                d23
            } else {
                let d13 = c.p3 - c.p1;
                if d13.hypot2() > EPS { d13 } else { c.p3 - c.p0 }
            };
            (d0, d1)
        }
    }
}

#[derive(Default)]
struct State {
    queue: BezPath,
    result: BezPath,
    needs_moveto: bool,
}

impl State {
    fn add_seg(&mut self, seg: PathSeg) {
        if self.queue.is_empty() {
            self.queue.move_to(seg.start());
        }
        match seg {
            PathSeg::Line(l) => self.queue.line_to(l.p1),
            PathSeg::Quad(q) => self.queue.quad_to(q.p1, q.p2),
            PathSeg::Cubic(c) => self.queue.curve_to(c.p1, c.p2, c.p3),
        }
    }

    fn flush(&mut self, accuracy: f64) {
        if self.queue.is_empty() {
            return;
        }
        let skip = !self.needs_moveto as usize;
        if self.queue.elements().len() == 2 {
            // a single segment: nothing to simplify
            self.result.extend(self.queue.iter().skip(skip));
        } else {
            let segs = self.queue.elements().len() - 1;
            let s = SimplifyBezPath::new(&self.queue);
            let mut fit = BezPath::new();
            // every segment may split a few dozen times before the budget
            // turns the rest into chords
            let mut budget = 64 * segs + 4096;
            fit_rec(&s, 0.0..1.0, accuracy, &mut fit, 0, &mut budget);
            self.result.extend(fit.iter().skip(skip));
        }
        self.needs_moveto = false;
        self.queue.truncate(0);
    }
}

fn finite(p: Point) -> bool {
    p.x.is_finite() && p.y.is_finite()
}

fn push_chord(path: &mut BezPath, a: Point, b: Point) {
    if path.is_empty() {
        path.move_to(a);
    }
    path.curve_to(a.lerp(b, 1.0 / 3.0), b.lerp(a, 1.0 / 3.0), b);
}

fn fit_rec(
    source: &SimplifyBezPath,
    range: Range<f64>,
    accuracy: f64,
    path: &mut BezPath,
    depth: u32,
    budget: &mut usize,
) {
    let (start, end) = (range.start, range.end);
    let start_p = source.sample_pt_tangent(start, 1.0).p;
    let end_p = source.sample_pt_tangent(end, -1.0).p;
    if !finite(start_p) || !finite(end_p) || depth >= MAX_DEPTH || *budget == 0 {
        push_chord(path, start_p, end_p);
        return;
    }
    *budget -= 1;
    if start_p.distance_squared(end_p) <= accuracy * accuracy {
        if let Some(c) = try_fit_line(source, accuracy, range.clone(), start_p, end_p) {
            if path.is_empty() {
                path.move_to(c.p0);
            }
            path.curve_to(c.p1, c.p2, c.p3);
            return;
        }
    }
    if let Some(c) = fit_to_cubic(source, range, accuracy) {
        if path.is_empty() {
            path.move_to(c.p0);
        }
        path.curve_to(c.p1, c.p2, c.p3);
        return;
    }
    let t = 0.5 * (start + end);
    if t <= start || t >= end {
        push_chord(path, start_p, end_p);
        return;
    }
    fit_rec(source, start..t, accuracy, path, depth + 1, budget);
    fit_rec(source, t..end, accuracy, path, depth + 1, budget);
}

const N_SAMPLE: usize = 20;

/// Samples of the source for measuring a candidate's distance.
struct CurveDist {
    samples: Vec<CurveFitSample>,
    arcparams: Vec<f64>,
    range: Range<f64>,
    /// Large tangent changes inside the range: measure by arc length.
    spicy: bool,
}

impl CurveDist {
    fn from_curve(source: &SimplifyBezPath, range: Range<f64>) -> Self {
        let step = (range.end - range.start) * (1.0 / (N_SAMPLE + 1) as f64);
        let mut last_tan: Option<Vec2> = None;
        let mut spicy = false;
        const SPICY_THRESH: f64 = 0.2;
        let mut samples = Vec::with_capacity(N_SAMPLE);
        for i in 0..N_SAMPLE + 2 {
            let sample = source.sample_pt_tangent(range.start + i as f64 * step, 1.0);
            if let Some(last_tan) = last_tan {
                let cross = sample.tangent.cross(last_tan);
                let dot = sample.tangent.dot(last_tan);
                if cross.abs() > SPICY_THRESH * dot.abs() {
                    spicy = true;
                }
            }
            last_tan = Some(sample.tangent);
            if i > 0 && i < N_SAMPLE + 1 {
                samples.push(sample);
            }
        }
        CurveDist { samples, arcparams: Vec::new(), range, spicy }
    }

    fn compute_arc_params(&mut self, source: &SimplifyBezPath) {
        const N_SUBSAMPLE: usize = 10;
        let (start, end) = (self.range.start, self.range.end);
        let dt = (end - start) * (1.0 / ((N_SAMPLE + 1) * N_SUBSAMPLE) as f64);
        let mut arclen = 0.0;
        for i in 0..N_SAMPLE + 1 {
            for j in 0..N_SUBSAMPLE {
                let t = start + dt * ((i * N_SUBSAMPLE + j) as f64 + 0.5);
                let (_, deriv) = source.sample_pt_deriv(t);
                arclen += deriv.hypot();
            }
            if i < N_SAMPLE {
                self.arcparams.push(arclen);
            }
        }
        if arclen.is_finite() && arclen > 0.0 {
            let inv = arclen.recip();
            for x in &mut self.arcparams {
                *x *= inv;
            }
        } else {
            for (i, x) in self.arcparams.iter_mut().enumerate() {
                *x = (i + 1) as f64 / (N_SAMPLE + 1) as f64;
            }
        }
    }

    /// Distance by arc-length parametrisation, from a fixed-size table of
    /// the candidate (kurbo inverts the arc length with an unbounded solver).
    fn eval_arc(&self, c: CubicBez, acc2: f64) -> Option<f64> {
        let mut pts = [Point::ZERO; ARC_TABLE + 1];
        let mut cum = [0.0f64; ARC_TABLE + 1];
        for (k, p) in pts.iter_mut().enumerate() {
            *p = c.eval(k as f64 / ARC_TABLE as f64);
        }
        for k in 1..=ARC_TABLE {
            cum[k] = cum[k - 1] + pts[k - 1].distance(pts[k]);
        }
        let total = cum[ARC_TABLE];
        if !total.is_finite() {
            return None;
        }
        let mut max_err2 = 0.0f64;
        for (sample, &s) in self.samples.iter().zip(&self.arcparams) {
            let target = total * s;
            // first table entry at or past the target
            let k = cum.partition_point(|&x| x < target).clamp(1, ARC_TABLE);
            let span = cum[k] - cum[k - 1];
            let f = if span > 0.0 { ((target - cum[k - 1]) / span).clamp(0.0, 1.0) } else { 0.0 };
            let q = pts[k - 1].lerp(pts[k], f);
            let err = sample.p.distance_squared(q);
            if !err.is_finite() {
                return None;
            }
            max_err2 = err.max(max_err2);
            if max_err2 > acc2 {
                return None;
            }
        }
        Some(max_err2)
    }

    /// Distance by rays orthogonal to the source tangent.
    fn eval_ray(&self, c: CubicBez, acc2: f64) -> Option<f64> {
        let mut max_err2 = 0.0f64;
        for sample in &self.samples {
            let mut best = acc2 + 1.0;
            for t in intersect(sample, c) {
                let err = sample.p.distance_squared(c.eval(t));
                best = best.min(err);
            }
            max_err2 = best.max(max_err2);
            if max_err2 > acc2 {
                return None;
            }
        }
        Some(max_err2)
    }

    fn eval_dist(&mut self, source: &SimplifyBezPath, c: CubicBez, acc2: f64) -> Option<f64> {
        let ray_dist = self.eval_ray(c, acc2)?;
        if !self.spicy {
            return Some(ray_dist);
        }
        if self.arcparams.is_empty() {
            self.compute_arc_params(source);
        }
        self.eval_arc(c, acc2)
    }
}

/// Parameters where the ray through the sample, orthogonal to its tangent,
/// meets the cubic.
fn intersect(s: &CurveFitSample, c: CubicBez) -> impl Iterator<Item = f64> {
    let p1 = 3.0 * (c.p1 - c.p0);
    let p2 = 3.0 * c.p2.to_vec2() - 6.0 * c.p1.to_vec2() + 3.0 * c.p0.to_vec2();
    let p3 = (c.p3 - c.p0) - 3.0 * (c.p2 - c.p1);
    let c0 = (c.p0 - s.p).dot(s.tangent);
    let c1 = p1.dot(s.tangent);
    let c2 = p2.dot(s.tangent);
    let c3 = p3.dot(s.tangent);
    solve_cubic(c0, c1, c2, c3).into_iter().filter(|t| (0.0..=1.0).contains(t))
}

// Arm-length penalty (see kurbo's fit.rs / "Simplifying Bézier paths").
const D_PENALTY_ELBOW: f64 = 0.65;
const D_PENALTY_SLOPE: f64 = 2.0;

/// A straight cubic along the chord, if the source stays within `accuracy`.
fn try_fit_line(
    source: &SimplifyBezPath,
    accuracy: f64,
    range: Range<f64>,
    start: Point,
    end: Point,
) -> Option<CubicBez> {
    let acc2 = accuracy * accuracy;
    let chord_l = Line::new(start, end);
    const SHORT_N: usize = 7;
    let dt = (range.end - range.start) / (SHORT_N + 1) as f64;
    for i in 0..SHORT_N {
        let t = range.start + (i + 1) as f64 * dt;
        let p = source.sample_pt_deriv(t).0;
        let err2 = chord_l.nearest(p, accuracy).distance_sq;
        if !(err2 <= acc2) {
            return None;
        }
    }
    Some(CubicBez::new(start, start.lerp(end, 1.0 / 3.0), end.lerp(start, 1.0 / 3.0), end))
}

/// The best single cubic for the range, if any is within `accuracy`.
fn fit_to_cubic(source: &SimplifyBezPath, range: Range<f64>, accuracy: f64) -> Option<CubicBez> {
    let start = source.sample_pt_tangent(range.start, 1.0);
    let end = source.sample_pt_tangent(range.end, -1.0);
    let d = end.p - start.p;
    let chord2 = d.hypot2();
    let acc2 = accuracy * accuracy;
    if chord2 <= acc2 {
        return try_fit_line(source, accuracy, range, start.p, end.p);
    }
    let th = d.atan2();
    fn mod_2pi(th: f64) -> f64 {
        let th_scaled = th * core::f64::consts::FRAC_1_PI * 0.5;
        core::f64::consts::PI * 2.0 * (th_scaled - th_scaled.round())
    }
    let th0 = mod_2pi(start.tangent.atan2() - th);
    let th1 = mod_2pi(th - end.tangent.atan2());

    let (mut area, mut x, mut y) = source.moment_integrals(range.clone());
    let (x0, y0) = (start.p.x, start.p.y);
    let (dx, dy) = (d.x, d.y);
    // subtract the chord's area and moment
    area -= dx * (y0 + 0.5 * dy);
    let dy_3 = dy * (1. / 3.);
    x -= dx * (x0 * y0 + 0.5 * (x0 * dy + y0 * dx) + dy_3 * dx);
    y -= dx * (y0 * y0 + y0 * dy + dy_3 * dy);
    // start point to the origin; raw integrals to moments
    x -= x0 * area;
    y = 0.5 * y - y0 * area;
    let moment = d.x * x + d.y * y;

    let chord2_inv = chord2.recip();
    let unit_area = area * chord2_inv;
    let mx = moment * chord2_inv.powi(2);

    let chord = chord2.sqrt();
    let aff = Affine::translate(start.p.to_vec2()) * Affine::rotate(th) * Affine::scale(chord);
    let mut curve_dist = CurveDist::from_curve(source, range);
    let mut best: Option<(CubicBez, f64)> = None;
    for (cand, d0, d1) in cubic_fit(th0, th1, unit_area, mx) {
        let c = aff * cand;
        if let Some(err2) = curve_dist.eval_dist(source, c, acc2) {
            fn scale_f(d: f64) -> f64 {
                1.0 + (d - D_PENALTY_ELBOW).max(0.0) * D_PENALTY_SLOPE
            }
            let scale = scale_f(d0).max(scale_f(d1)).powi(2);
            let err2 = err2 * scale;
            if err2 < acc2 && best.map_or(true, |(_, b)| err2 < b) {
                best = Some((c, err2));
            }
        }
    }
    best.map(|(c, _)| c)
}

/// Unit-chord cubics matching the area and moment, with their arm lengths;
/// arms longer than [`D_MAX`] (or non-finite) are left out.
fn cubic_fit(th0: f64, th1: f64, area: f64, mx: f64) -> Vec<(CubicBez, f64, f64)> {
    let (s0, c0) = th0.sin_cos();
    let (s1, c1) = th1.sin_cos();
    let a4 = -9. * c0 * (((2. * s1 * c1 * c0 + s0 * (2. * c1 * c1 - 1.)) * c0 - 2. * s1 * c1) * c0 - c1 * c1 * s0);
    let a3 = 12.
        * ((((c1 * (30. * area * c1 - s1) - 15. * area) * c0 + 2. * s0 - c1 * s0 * (c1 + 30. * area * s1)) * c0
            + c1 * (s1 - 15. * area * c1))
            * c0
            - s0 * c1 * c1);
    let a2 = 12.
        * ((((70. * mx + 15. * area) * s1 * s1 + c1 * (9. * s1 - 70. * c1 * mx - 5. * c1 * area)) * c0
            - 5. * s0 * s1 * (3. * s1 - 4. * c1 * (7. * mx + area)))
            * c0
            - c1 * (9. * s1 - 70. * c1 * mx - 5. * c1 * area));
    let a1 = 16.
        * (((12. * s0 - 5. * c0 * (42. * mx - 17. * area)) * s1
            - 70. * c1 * (3. * mx - area) * s0
            - 75. * c0 * c1 * area * area)
            * s1
            - 75. * c1 * c1 * area * area * s0);
    let a0 = 80. * s1 * (42. * s1 * mx - 25. * area * (s1 - c1 * area));
    let mut roots: Vec<f64> = Vec::with_capacity(4);
    const EPS: f64 = 1e-12;
    if a4.abs() > EPS {
        let a = a3 / a4;
        let b = a2 / a4;
        let c = a1 / a4;
        let d = a0 / a4;
        if let Some(quads) = factor_quartic_inner(a, b, c, d, false) {
            for (qc1, qc0) in quads {
                let qroots = solve_quadratic(qc0, qc1, 1.0);
                if qroots.is_empty() {
                    // real part of a complex pair
                    roots.push(-0.5 * qc1);
                } else {
                    roots.extend(qroots);
                }
            }
        }
    } else if a3.abs() > EPS {
        roots.extend(solve_cubic(a0, a1, a2, a3));
    } else if a2.abs() > EPS || a1.abs() > EPS || a0.abs() > EPS {
        roots.extend(solve_quadratic(a0, a1, a2));
    } else {
        return vec![(CubicBez::new((0.0, 0.0), (1. / 3., 0.0), (2. / 3., 0.0), (1., 0.0)), 1. / 3., 1. / 3.)];
    }

    let s01 = s0 * c1 + s1 * c0;
    roots
        .iter()
        .filter_map(|&d0| {
            let (d0, d1) = if d0 > 0.0 {
                let d1 = (d0 * s0 - area * (10. / 3.)) / (0.5 * d0 * s01 - s1);
                if d1 > 0.0 { (d0, d1) } else { (s1 / s01, 0.0) }
            } else {
                (0.0, s0 / s01)
            };
            let ok = |d: f64| d.is_finite() && (0.0..=D_MAX).contains(&d);
            if ok(d0) && ok(d1) {
                Some((CubicBez::new((0.0, 0.0), (d0 * c0, d0 * s0), (1.0 - d1 * c1, d1 * s1), (1.0, 0.0)), d0, d1))
            } else {
                None
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lines_with_a_corner_pass_through() {
        let mut path = BezPath::new();
        path.move_to((1., 2.));
        path.line_to((3., 4.));
        path.line_to((10., 5.));
        assert_eq!(simplify_bezpath(path.clone(), 1.0, 1e-3), path);
    }

    #[test]
    fn non_finite_input_terminates() {
        let mut path = BezPath::new();
        path.move_to((0., 0.));
        path.curve_to((1., f64::NAN), (2., 1.), (3., 0.));
        path.curve_to((4., -1.), (5., 0.), (6., f64::INFINITY));
        path.curve_to((7., 1.), (8., 0.), (9., 0.));
        let _ = simplify_bezpath(path, 0.01, 0.2);
    }
}
