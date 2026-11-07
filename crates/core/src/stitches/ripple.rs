//! Ripple stitch, ported from Ink/Stitch (`lib/stitches/ripple_stitch.py`,
//! GPL-3.0-or-later): a running stitch that repeats its line as ripples.
//!
//! Ink/Stitch builds *helper lines*: for every point of the outline, the
//! positions of that point in each ripple. Read across, they give the ripple
//! lines, which are stitched one after the other.
//!
//! * Closed shapes: copies shrink towards a target point and blend into one
//!   continuous spiral (circular ripples).
//! * Open lines: copies along a guide line (moved, turned and scaled), along
//!   a satin guide (fitted between its rails), fanned towards a target, or —
//!   Filum's default without a guide — parallel copies.
//! * Two rails (a satin): lines from one rail to the other (satin ripples).
//!
//! Options: line count or minimum line distance, skipped lines, exponent,
//! flipped copies, flat or pointed joins, staggers, a grid, manual pattern
//! placement, scaling and rotation along the guide.

use crate::geom::*;
use crate::model::{RippleGuidePosition, RippleParams, RippleScaleAxis, RunningParams, SatinParams, SubPath};

use super::running::{running_stitch, running_stitch_with, StitchLength};

fn centroid(ring: &[Point]) -> Point {
    let mut a = 0.0;
    let (mut cx, mut cy) = (0.0, 0.0);
    for i in 0..ring.len() {
        let p = ring[i];
        let q = ring[(i + 1) % ring.len()];
        let c = p.x * q.y - q.x * p.y;
        a += c;
        cx += (p.x + q.x) * c;
        cy += (p.y + q.y) * c;
    }
    if a.abs() < 1e-9 {
        let n = ring.len().max(1) as f64;
        return pt(ring.iter().map(|p| p.x).sum::<f64>() / n, ring.iter().map(|p| p.y).sum::<f64>() / n);
    }
    pt(cx / (3.0 * a), cy / (3.0 * a))
}

/// Centroid of an open line (shapely's `LineString.centroid`, what Ink/Stitch
/// fans an open ripple towards): segment midpoints weighted by length. The
/// area centroid of an open S-curve can land far outside it.
fn line_centroid(line: &[Point]) -> Point {
    let (mut len, mut cx, mut cy) = (0.0, 0.0, 0.0);
    for w in line.windows(2) {
        let d = w[0].dist(w[1]);
        len += d;
        cx += (w[0].x + w[1].x) * 0.5 * d;
        cy += (w[0].y + w[1].y) * 0.5 * d;
    }
    if len < 1e-12 {
        return line.first().copied().unwrap_or(pt(0.0, 0.0));
    }
    pt(cx / len, cy / len)
}

/// Ink/Stitch `_get_steps`: `n` values from `start` to `end`, raised to
/// `exponent`, optionally flipped (1 − reversed).
fn steps(n: usize, start: f64, end: f64, exponent: f64, flip: bool) -> Vec<f64> {
    let n = n.max(1);
    let mut s: Vec<f64> = (0..n)
        .map(|i| {
            let t = if n > 1 { start + (end - start) * i as f64 / (n - 1) as f64 } else { start };
            if exponent == 1.0 {
                t
            } else {
                t.max(0.0).powf(exponent)
            }
        })
        .collect();
    if flip {
        s.reverse();
        for v in &mut s {
            *v = 1.0 - *v;
        }
    }
    s
}

/// Point at `t` (0..1) of the polyline's length.
fn at(pts: &[Point], cum: &[f64], t: f64) -> Point {
    point_at(pts, cum, t.clamp(0.0, 1.0) * cum.last().copied().unwrap_or(0.0))
}

struct Ctx<'a> {
    p: &'a RippleParams,
    len: StitchLength,
    tol: f64,
    closed: bool,
}

impl Ctx<'_> {
    /// Ink/Stitch `_line_count_adjust`.
    fn adjust(&self, mut n: i64) -> usize {
        let lc = self.p.lines.max(1) as i64;
        if self.p.min_line_dist > 0.0 && lc % 2 != n % 2 {
            n -= 1;
        }
        let mut n = n.max(1) as usize;
        if self.closed || self.p.join_point {
            n += 1;
        }
        n
    }
    /// Line count from pairs (satin rails, or outline → target).
    fn pair_count(&self, pairs: &[(Point, Point)]) -> usize {
        if self.p.min_line_dist <= 0.0 {
            return self.adjust(self.p.lines.max(1) as i64);
        }
        let shortest = pairs.iter().map(|(a, b)| a.dist(*b)).filter(|d| *d > 0.0).fold(f64::INFINITY, f64::min);
        let shortest = if shortest.is_finite() { shortest } else { 0.0 };
        self.adjust((shortest / self.p.min_line_dist).ceil() as i64)
    }
    /// Line count along a guide of `length` mm.
    fn guided_count(&self, length: f64) -> usize {
        if self.p.min_line_dist <= 0.0 {
            return self.adjust(self.p.lines.max(1) as i64);
        }
        self.adjust((length / self.p.min_line_dist).ceil() as i64)
    }
    fn steps(&self, n: usize) -> Vec<f64> {
        steps(n, 0.0, 1.0, self.p.exponent, self.p.flip_exponent)
    }
}

/// Ink/Stitch `_converge_helper_line_points`: blend each copy into the next
/// one along the outline (a spiral), or meet in points.
fn converge(helper: Vec<Vec<Point>>, point_edge: bool, flip_copies: bool) -> Vec<Vec<Point>> {
    let n = helper.len();
    let s = steps(n, 0.0, 1.0, 1.0, false);
    helper
        .into_iter()
        .enumerate()
        .map(|(i, line)| {
            (0..line.len().saturating_sub(1))
                .map(|j| {
                    let k = if point_edge && j % 2 == 1 && flip_copies { n - 1 - i } else { i };
                    line[j].lerp(line[j + 1], s[k])
                })
                .collect()
        })
        .collect()
}

/// Move, turn (about `origin`) and scale (about `origin`, on the chosen axes) an outline.
fn transform(outline: &[Point], translation: Point, rotation: f64, scaling: f64, origin: Point, axis: RippleScaleAxis) -> Vec<Point> {
    let (sx, sy) = match axis {
        RippleScaleAxis::Both => (scaling, scaling),
        RippleScaleAxis::X => (scaling, 1.0),
        RippleScaleAxis::Y => (1.0, scaling),
        RippleScaleAxis::None => (1.0, 1.0),
    };
    outline
        .iter()
        .map(|q| {
            let r = (*q + translation - origin).rotate(rotation);
            origin + pt(r.x * sx, r.y * sy)
        })
        .collect()
}

/// Copies (rows) to helper lines (one per outline point).
fn copies_to_helper(copies: &[Vec<Point>]) -> Vec<Vec<Point>> {
    let n = copies.first().map_or(0, |c| c.len());
    (0..n).map(|j| copies.iter().filter_map(|c| c.get(j).copied()).collect()).collect()
}

fn angle_of(a: Point, b: Point) -> f64 {
    (b.y - a.y).atan2(b.x - a.x)
}

/// The rail pairs of a satin made of `paths` (two rails, optional rungs), every `spacing` mm.
fn satin_pairs(paths: &[SubPath], spacing: f64) -> Option<Vec<(Point, Point)>> {
    let geo = super::satin::satin_geometry(paths, &SatinParams { width: 1.0, ..Default::default() })?;
    let pairs = super::satin::plot_points_on_rails(&geo, spacing.max(0.05), 0.0, 0.0);
    (pairs.len() >= 2).then_some(pairs)
}

/// The rung pairs of a satin: where its sections end (Ink/Stitch "render at rungs").
fn satin_rungs(paths: &[SubPath]) -> Vec<(Point, Point)> {
    let Some(geo) = super::satin::satin_geometry(paths, &SatinParams { width: 1.0, ..Default::default() }) else { return vec![] };
    let mut out = Vec::new();
    if let Some((a, b)) = geo.sections.first() {
        if let (Some(x), Some(y)) = (a.first(), b.first()) {
            out.push((*x, *y));
        }
    }
    for (a, b) in &geo.sections {
        if let (Some(x), Some(y)) = (a.last(), b.last()) {
            out.push((*x, *y));
        }
    }
    out
}

/// Separating-axis test for two convex quadrilaterals.
fn quads_overlap(a: &[Point; 4], b: &[Point; 4]) -> bool {
    for poly in [a, b] {
        for i in 0..4 {
            let e = poly[(i + 1) % 4] - poly[i];
            let n = pt(-e.y, e.x);
            let proj = |q: &[Point; 4]| q.iter().map(|p| p.dot(n)).fold((f64::INFINITY, f64::NEG_INFINITY), |(lo, hi), v| (lo.min(v), hi.max(v)));
            let (a0, a1) = proj(a);
            let (b0, b1) = proj(b);
            if a1 < b0 || b1 < a0 {
                return false;
            }
        }
    }
    true
}

/// Helper lines of copies of `outline` along a satin `guide`.
fn satin_guide_helper(c: &Ctx, outline: &[Point], guide: &[SubPath]) -> Vec<Vec<Point>> {
    let p = c.p;
    let center: Vec<Point> = satin_pairs(guide, 0.5).unwrap_or_default().iter().map(|(a, b)| a.lerp(*b, 0.5)).collect();
    let center_len = polyline_length(&center);
    let (o0, o1) = match p.anchor {
        Some([a, b]) => (Point::from_arr(a), Point::from_arr(b)),
        None => (outline[0], *outline.last().unwrap()),
    };
    let count = c.guided_count(center_len);
    if o0.dist(o1) < 1e-9 {
        // a closed outline: centred on the column, scaled by its width
        let spacing = center_len / (count.max(2) - 1) as f64;
        let mut pairs = if p.guide_position == RippleGuidePosition::Rungs { satin_rungs(guide) } else { vec![] };
        if pairs.len() > 1 {
            pairs.pop();
        } else {
            pairs = satin_pairs(guide, spacing).unwrap_or_default();
        }
        let Some(&(a0, a1)) = pairs.first() else { return vec![] };
        let start_rot = angle_of(a0, a1);
        let start_scale = a0.dist(a1).max(1e-9);
        let oc = centroid(outline);
        let copies: Vec<Vec<Point>> = pairs
            .iter()
            .map(|&(q0, q1)| {
                let gc = q0.lerp(q1, 0.5);
                let rot = if p.rotate_ripples { angle_of(q0, q1) - start_rot } else { 0.0 };
                transform(outline, gc - oc, rot, q0.dist(q1) / start_scale, gc, p.scale_axis)
            })
            .collect();
        return copies_to_helper(&copies);
    }
    let width = o0.dist(o1).max(1e-9);
    let o_rot = angle_of(o0, o1);
    let copies: Vec<Vec<Point>> = if p.guide_position == RippleGuidePosition::Adaptive {
        // as many copies as fit without overlapping (plus the minimum distance)
        let flat = transform(outline, Point::ZERO, -o_rot, 1.0, o0, RippleScaleAxis::Both);
        let b = flat.iter().fold(Rect::EMPTY, |mut r, q| {
            r.include(*q);
            r
        });
        let quad = |r: &Rect, dy: f64| [pt(r.min_x, r.min_y - dy), pt(r.min_x, r.max_y - dy), pt(r.max_x, r.max_y - dy), pt(r.max_x, r.min_y - dy)];
        let bbox = quad(&b, 0.0);
        let min_d = if p.min_line_dist > 0.0 { p.min_line_dist } else { 0.1 };
        let spaced = quad(&b, min_d);
        let mut last: Option<[Point; 4]> = None;
        let mut out = Vec::new();
        for (q0, q1) in satin_pairs(guide, 0.1).unwrap_or_default() {
            let s = q0.dist(q1) / width;
            let rot = angle_of(q0, q1);
            let tq = |quad: &[Point; 4]| -> [Point; 4] {
                let v = transform(quad, q0 - o0, rot, s, q0, RippleScaleAxis::Both);
                [v[0], v[1], v[2], v[3]]
            };
            let this = tq(&bbox);
            if last.is_some_and(|l| quads_overlap(&l, &this)) {
                continue;
            }
            out.push(transform(&flat, q0 - o0, rot, s, q0, RippleScaleAxis::Both));
            last = Some(tq(&spaced));
        }
        out
    } else {
        let mut pairs = if p.guide_position == RippleGuidePosition::Rungs { satin_rungs(guide) } else { vec![] };
        if pairs.len() < 2 {
            let spacing = center_len / (count.max(2) - 1) as f64;
            pairs = satin_pairs(guide, spacing).unwrap_or_default();
        }
        if pairs.len() > 1 && pairs[0].0.dist(pairs.last().unwrap().0) < 1e-9 && pairs[0].1.dist(pairs.last().unwrap().1) < 1e-9 {
            pairs.pop();
        }
        pairs.iter().map(|&(q0, q1)| transform(outline, q0 - o0, angle_of(q0, q1) - o_rot, q0.dist(q1) / width, q0, RippleScaleAxis::Both)).collect()
    };
    copies_to_helper(&copies)
}

/// Helper lines of copies of `outline` along a guide line.
fn guided_helper(c: &Ctx, outline: &[Point], guide: &[Point], rungs: Option<&[Point]>, twist: f64) -> Vec<Vec<Point>> {
    let p = c.p;
    let gcum = cumulative_lengths(guide);
    let count = match rungs {
        Some(r) if p.guide_position == RippleGuidePosition::Rungs && r.len() >= 2 => r.len(),
        _ => c.guided_count(*gcum.last().unwrap_or(&0.0)),
    };
    let outline_steps = c.steps(count);
    let scale_steps = steps(count, p.scale_start / 100.0, p.scale_end / 100.0, 1.0, false);
    let start = guide[0];
    let start_rot = angle_of(at(guide, &gcum, 0.0), at(guide, &gcum, 0.01));
    let mut prev: Option<Point> = None;
    let mut copies = Vec::with_capacity(count);
    for i in 0..count {
        let g = match rungs {
            Some(r) if p.guide_position == RippleGuidePosition::Rungs && r.len() >= 2 => r[i],
            _ => at(guide, &gcum, outline_steps[i]),
        };
        let mut rot = match prev {
            Some(q) if p.rotate_ripples && q.dist(g) > 1e-9 => angle_of(q, g) - start_rot,
            _ => 0.0,
        };
        if count > 1 {
            rot += twist * i as f64 / (count - 1) as f64;
        }
        copies.push(transform(outline, g - start, rot, scale_steps[i], g, p.scale_axis));
        prev = Some(g);
    }
    copies_to_helper(&copies)
}

/// Ink/Stitch `_target_point_helper_lines`: every outline point towards the target.
fn target_helper(c: &Ctx, outline: &[Point], target: Point, end: f64, twist: f64) -> Vec<Vec<Point>> {
    let pairs: Vec<(Point, Point)> = outline.iter().map(|q| (*q, target)).collect();
    let count = c.pair_count(&pairs);
    let s: Vec<f64> = c.steps(count).into_iter().map(|t| t * end).collect();
    outline
        .iter()
        .map(|q| {
            s.iter()
                .enumerate()
                .map(|(k, t)| {
                    let rot = if count > 1 { twist * k as f64 / (count - 1) as f64 } else { 0.0 };
                    target + (q.lerp(target, *t) - target).rotate(rot)
                })
                .collect()
        })
        .collect()
}

/// Helper lines of one sub-path, and whether its ripples are linear.
fn single_helper(c: &Ctx, sp: &SubPath, spacing: f64) -> Option<(bool, Vec<Vec<Point>>)> {
    let p = c.p;
    let outline: Vec<Point> = if p.manual {
        let mut v: Vec<Point> = sp.nodes.iter().map(|n| n.point()).collect();
        if sp.closed && v.len() > 1 && v[0].dist(*v.last().unwrap()) > 1e-9 {
            v.push(v[0]);
        }
        v
    } else {
        let mut f = sp.flatten(0.05);
        if sp.closed && f.len() > 1 && f[0].dist(*f.last().unwrap()) > 1e-9 {
            f.push(f[0]);
        }
        let len = if p.grid_size > 0.0 { StitchLength::even(p.grid_size) } else { StitchLength { jitter: 0.0, ..c.len.clone() } };
        running_stitch_with(&f, &len, c.tol, 0)
    };
    if outline.len() < 2 {
        return None;
    }
    let twist = p.rotation.to_radians();
    if sp.closed {
        // circular ripples: towards the target, blended into a spiral
        let ring = &outline[..outline.len() - 1];
        let target = p.target.map(Point::from_arr).unwrap_or_else(|| centroid(ring));
        let end = 1.0 - p.min_scale.clamp(0.0, 0.98);
        let h = target_helper(c, &outline, target, end, twist);
        return Some((false, converge(h, false, true)));
    }
    let linear = if p.guide.len() >= 2 {
        satin_guide_helper(c, &outline, &p.guide)
    } else if let Some(g) = p.guide.first() {
        let pts = g.flatten(0.05);
        let rungs: Vec<Point> = g.nodes.iter().map(|n| n.point()).collect();
        if pts.len() < 2 {
            return None;
        }
        // Ink/Stitch resamples the outline for guided copies
        let outline = if p.manual { outline } else { running_stitch(&outline, spacing, c.tol) };
        guided_helper(c, &outline, &pts, Some(&rungs), twist)
    } else if p.fan {
        // Ink/Stitch without a guide: fanned towards the target
        let target = p.target.map(Point::from_arr).unwrap_or_else(|| line_centroid(&outline));
        target_helper(c, &outline, target, 1.0, twist)
    } else {
        // Filum's default: parallel copies `spacing` apart, towards the target side
        let (a, b) = (outline[0], *outline.last().unwrap());
        let mut normal = (b - a).perp();
        let nl = normal.length();
        normal = if nl < 1e-9 { pt(0.0, 1.0) } else { normal * (1.0 / nl) };
        if let Some(t) = p.target.map(Point::from_arr) {
            if (t - a).dot(normal) < 0.0 {
                normal = -normal;
            }
        }
        let n = c.adjust(p.lines.max(1) as i64);
        let mid = a.lerp(b, 0.5);
        let guide = [mid, mid + normal * (p.spacing.max(0.1) * (n.max(2) - 1) as f64)];
        let flat = RippleParams { rotate_ripples: false, min_line_dist: 0.0, ..p.clone() };
        let c2 = Ctx { p: &flat, len: c.len.clone(), tol: c.tol, closed: false };
        guided_helper(&c2, &outline, &guide, None, twist)
    };
    let linear = if p.join_point { converge(linear, true, true) } else { linear };
    Some((true, linear))
}

/// Helper lines of a satin-shaped ripple (two rails).
fn satin_helper(c: &Ctx, paths: &[SubPath], spacing: f64) -> Option<Vec<Vec<Point>>> {
    let pairs = satin_pairs(paths, spacing)?;
    let count = c.pair_count(&pairs).max(2);
    let s = c.steps(count);
    let h: Vec<Vec<Point>> = pairs.iter().map(|(a, b)| s.iter().map(|t| a.lerp(*b, *t)).collect()).collect();
    Some(if c.p.join_point || !c.p.flip_copies { converge(h, true, c.p.flip_copies) } else { h })
}

/// Ink/Stitch `apply_stagger`: stitches at fixed distances, the start of the
/// pattern moved by a share of the stitch length line by line.
fn stagger_line(line: &[Point], len: f64, staggers: u32, row: usize) -> Vec<Point> {
    if line.len() < 2 {
        return line.to_vec();
    }
    let start = ((row as f64 / staggers.max(1) as f64) % 1.0) * len;
    let cum = cumulative_lengths(line);
    let total = *cum.last().unwrap();
    let mut out = vec![line[0]];
    let mut d = len - start;
    let corners: Vec<usize> = (1..line.len() - 1)
        .filter(|&i| {
            let (a, b) = (line[i] - line[i - 1], line[i + 1] - line[i]);
            let (aa, bb) = (a.dot(a) * b.dot(b), a.dot(b));
            aa > 0.0 && bb * bb.abs() <= 0.5 * aa
        })
        .collect();
    let mut ci = 0;
    while d < total - 1e-6 {
        // corners are sewn exactly
        while ci < corners.len() && cum[corners[ci]] < d - 0.1 {
            out.push(line[corners[ci]]);
            ci += 1;
        }
        if ci < corners.len() && (cum[corners[ci]] - d).abs() <= 0.1 {
            d += len;
            continue;
        }
        out.push(point_at(line, &cum, d));
        d += len;
    }
    while ci < corners.len() {
        out.push(line[corners[ci]]);
        ci += 1;
    }
    out.push(*line.last().unwrap());
    out.dedup_by(|b, a| a.dist(*b) < 1e-6);
    out
}

/// Ink/Stitch `_get_staggered_stitches`.
fn staggered_stitches(c: &Ctx, lines: Vec<Vec<Point>>, skip_start: usize) -> Vec<Point> {
    let p = c.p;
    let mut out: Vec<Point> = Vec::new();
    let mut last: Option<Point> = None;
    for (i, mut line) in lines.into_iter().enumerate() {
        if line.len() < 2 {
            continue;
        }
        let mut connector: Vec<Point> = Vec::new();
        if let (Some(l), false) = (last, p.join_point) {
            let first = if i % 2 == 0 || !p.flip_copies { line[0] } else { *line.last().unwrap() };
            let run = running_stitch(&[l, first], c.len.main(), c.tol);
            if run.len() > 2 {
                connector = run[1..run.len() - 1].to_vec();
            }
        }
        let should_reverse = if p.join_point { (i + skip_start) % 2 == 1 } else { i % 2 == 1 };
        let stitched = if p.staggers == 0 {
            if should_reverse && p.flip_copies {
                line.reverse();
            }
            running_stitch_with(&line, &c.len, c.tol, i as u64)
        } else {
            let mut s = stagger_line(&line, c.len.main(), p.staggers, i);
            if should_reverse && p.flip_copies {
                s.reverse();
            }
            s
        };
        if stitched.is_empty() {
            continue;
        }
        last = stitched.last().copied();
        out.extend(connector);
        out.extend(stitched);
    }
    out
}

/// The ripple lines: each copy, read across the helper lines.
fn ripple_lines(helper: &[Vec<Point>], skip_start: usize, skip_end: usize) -> Vec<Vec<Point>> {
    let n = helper.first().map_or(0, |h| h.len());
    (skip_start..n.saturating_sub(skip_end)).map(|k| helper.iter().filter_map(|h| h.get(k).copied()).collect()).collect()
}

/// Ink/Stitch `_get_stitches`.
fn stitches_of(c: &Ctx, linear: bool, lines: Vec<Vec<Point>>, skip_start: usize) -> Vec<Point> {
    let p = c.p;
    if p.manual {
        // the outline's own points; connectors no longer than a stitch
        let mut out: Vec<Point> = Vec::new();
        for (i, mut line) in lines.into_iter().enumerate() {
            if i % 2 == 0 && p.flip_copies {
                line.reverse();
            }
            if let (Some(&l), Some(&f)) = (out.last(), line.first()) {
                let n = (l.dist(f) / c.len.main().max(0.1)).ceil() as usize;
                for k in 1..n {
                    out.push(l.lerp(f, k as f64 / n as f64));
                }
            }
            out.extend(line);
        }
        return out;
    }
    if linear && p.flip_copies {
        return staggered_stitches(c, lines, skip_start);
    }
    let all: Vec<Point> = lines.into_iter().flatten().collect();
    running_stitch_with(&all, &c.len, c.tol, 0)
}

/// Ink/Stitch `_adjust_helper_lines_for_grid`: start the grid at the corner
/// nearest the last stitch.
fn orient_grid(mut grid: Vec<Vec<Point>>, last: Point) -> Vec<Vec<Point>> {
    let (Some(f), Some(l)) = (grid.first().cloned(), grid.last().cloned()) else { return grid };
    let d = |q: Option<&Point>| q.map_or(f64::INFINITY, |q| q.dist(last));
    let ds = [d(f.first()), d(f.last()), d(l.first()), d(l.last())];
    let nearest = (0..4).min_by(|a, b| ds[*a].partial_cmp(&ds[*b]).unwrap()).unwrap();
    if nearest == 1 || nearest == 3 {
        for line in &mut grid {
            line.reverse();
        }
    }
    if nearest >= 2 {
        grid.reverse();
    }
    grid
}

/// Smallest line distance / grid size (mm): finer values would make
/// millions of lines (a hang) and sew a solid lump anyway.
const MIN_DIST: f64 = 0.05;

/// The options with values that would break the maths brought into range:
/// an exponent ≤ 0 (0^0, 0^−1 = ∞ → NaN positions) becomes 0.01, a line
/// distance or grid size below [`MIN_DIST`] becomes `MIN_DIST`.
fn sane_params(p: &RippleParams) -> RippleParams {
    let pos = |v: f64| if v.is_finite() && v > 0.0 { v.max(MIN_DIST) } else { 0.0 };
    RippleParams {
        exponent: if p.exponent.is_finite() { p.exponent.max(0.01) } else { 1.0 },
        min_line_dist: pos(p.min_line_dist),
        grid_size: pos(p.grid_size),
        ..p.clone()
    }
}

/// All stitch groups of a ripple object (Ink/Stitch `ripple_stitch`).
pub fn ripple_stitches(paths: &[SubPath], p: &RippleParams, run: &RunningParams) -> Vec<Vec<Point>> {
    let sane = sane_params(p);
    let p = &sane;
    let usable: Vec<&SubPath> = paths.iter().filter(|s| s.nodes.len() >= 2).collect();
    if usable.is_empty() {
        return vec![];
    }
    let len = run.stitch_length();
    let tol = run.tolerance.clamp(0.01, len.main());
    let open = usable.iter().filter(|s| !s.closed).count();
    // two rails (and rungs): one satin ripple; otherwise every sub-path
    let groups: Vec<(bool, Vec<Vec<Point>>, Vec<Vec<Point>>)> = if usable.len() >= 2 && open >= 2 {
        let c = Ctx { p, len: len.clone(), tol, closed: false };
        let owned: Vec<SubPath> = usable.iter().map(|s| (*s).clone()).collect();
        let Some(h) = satin_helper(&c, &owned, tol) else { return vec![] };
        let g = if p.grid_size > 0.0 { satin_helper(&c, &owned, p.grid_size).unwrap_or_else(|| h.clone()) } else { h.clone() };
        vec![(true, h, g)]
    } else {
        usable
            .iter()
            .filter_map(|sp| {
                let c = Ctx { p, len: len.clone(), tol, closed: sp.closed };
                let spacing = if p.grid_size > 0.0 { p.grid_size } else { len.main() };
                single_helper(&c, sp, spacing).map(|(linear, h)| (linear, h.clone(), h))
            })
            .collect()
    };
    let mut out = Vec::new();
    for (linear, helper, grid_helper) in groups {
        let closed = !linear;
        let c = Ctx { p, len: len.clone(), tol, closed };
        let n = helper.first().map_or(0, |h| h.len());
        let (mut skip_start, mut skip_end) = (p.skip_start as usize, p.skip_end as usize);
        if skip_start + skip_end >= n {
            skip_start = 0;
            skip_end = 0;
        }
        let lines = ripple_lines(&helper, skip_start, skip_end);
        let mut stitches = stitches_of(&c, linear, lines, skip_start);
        if p.reverse {
            stitches.reverse();
        }
        if stitches.len() < 2 {
            continue;
        }
        let mut group = vec![super::running::repeat_path(&stitches, run.repeats.max(1))];
        if p.grid_size > 0.0 {
            // the grid: the helper lines themselves, across the ripples
            let mut grid: Vec<Vec<Point>> = grid_helper
                .iter()
                .enumerate()
                .map(|(i, h)| {
                    let end = h.len().saturating_sub(skip_end);
                    let mut pts = h[skip_start.min(end)..end].to_vec();
                    if i % 2 != 0 && linear && !p.flip_copies && !p.join_point {
                        pts.reverse();
                    }
                    pts
                })
                .collect();
            grid = orient_grid(grid, *stitches.last().unwrap());
            let g = staggered_stitches(&c, grid, 0);
            if g.len() >= 2 {
                group.push(g);
            }
            if p.grid_first {
                group = group.into_iter().rev().map(|mut s| {
                    s.reverse();
                    s
                }).collect();
            }
        }
        out.extend(group);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::RunningParams;

    fn run() -> RunningParams {
        RunningParams::default()
    }

    #[test]
    fn circular_ripples_spiral_inwards() {
        let sq = SubPath::polyline(&[pt(0.0, 0.0), pt(20.0, 0.0), pt(20.0, 20.0), pt(0.0, 20.0)], true);
        let g = ripple_stitches(&[sq], &RippleParams { lines: 5, ..Default::default() }, &run());
        let s = &g[0];
        assert!(s[0].dist(pt(0.0, 0.0)) < 0.5, "{:?}", s[0]);
        assert!(s.last().unwrap().dist(pt(10.0, 10.0)) < 0.5, "ends at the centre: {:?}", s.last());
        assert!(s.windows(2).all(|w| w[0].dist(w[1]) < 3.0), "continuous");
    }

    #[test]
    fn linear_ripples_go_back_and_forth() {
        let line = SubPath::polyline(&[pt(0.0, 0.0), pt(20.0, 0.0)], false);
        let g = ripple_stitches(&[line], &RippleParams { lines: 3, spacing: 2.0, target: Some([10.0, 10.0]), ..Default::default() }, &run());
        let s = &g[0];
        assert!(s.iter().all(|q| q.y >= -1e-9 && q.y <= 4.0 + 1e-9), "{s:?}");
        assert!(s.last().unwrap().dist(pt(20.0, 4.0)) < 1e-6, "{:?}", s.last());
    }

    #[test]
    fn guide_line_moves_the_copies_and_scales_them() {
        let line = SubPath::polyline(&[pt(0.0, 0.0), pt(10.0, 0.0)], false);
        let guide = SubPath::polyline(&[pt(5.0, 0.0), pt(5.0, 30.0)], false);
        let p = RippleParams { lines: 4, guide: vec![guide], rotate_ripples: false, scale_start: 100.0, scale_end: 50.0, ..Default::default() };
        let s = &ripple_stitches(&[line], &p, &run())[0];
        let ymax = s.iter().map(|q| q.y).fold(0.0, f64::max);
        assert!((ymax - 30.0).abs() < 1e-6, "the last copy at the end of the guide: {ymax}");
        let last: Vec<&Point> = s.iter().filter(|q| (q.y - 30.0).abs() < 1e-6).collect();
        let w = last.iter().map(|q| q.x).fold(f64::MIN, f64::max) - last.iter().map(|q| q.x).fold(f64::MAX, f64::min);
        assert!((w - 5.0).abs() < 0.3, "half size at the end: {w}");
    }

    #[test]
    fn satin_ripples_run_between_the_rails() {
        let r0 = SubPath::polyline(&[pt(0.0, 0.0), pt(30.0, 0.0)], false);
        let r1 = SubPath::polyline(&[pt(0.0, 10.0), pt(30.0, 10.0)], false);
        let s = &ripple_stitches(&[r0, r1], &RippleParams { lines: 6, ..Default::default() }, &run())[0];
        let ys: std::collections::BTreeSet<i64> = s.iter().map(|q| (q.y * 10.0).round() as i64).collect();
        assert!(ys.len() >= 6, "lines across the column: {ys:?}");
        assert!(s.iter().all(|q| q.y > -0.01 && q.y < 10.01));
    }

    #[test]
    fn skip_min_distance_exponent_and_grid() {
        let line = SubPath::polyline(&[pt(0.0, 0.0), pt(20.0, 0.0)], false);
        let base = RippleParams { lines: 6, spacing: 2.0, ..Default::default() };
        let rows = |p: &RippleParams| ripple_stitches(&[line.clone()], p, &run())[0].iter().map(|q| (q.y * 100.0).round() as i64).collect::<std::collections::BTreeSet<_>>().len();
        assert_eq!(rows(&base), 6);
        assert_eq!(rows(&RippleParams { skip_start: 1, skip_end: 2, ..base.clone() }), 3, "skipped lines");
        let fan = |p: &RippleParams| ripple_stitches(&[line.clone()], p, &run());
        let g = fan(&RippleParams { grid_size: 2.0, ..base.clone() });
        assert_eq!(g.len(), 2, "ripples and the grid");
        let steps_exp = steps(5, 0.0, 1.0, 2.0, false);
        assert!((steps_exp[2] - 0.25).abs() < 1e-9);
        let flipped = steps(5, 0.0, 1.0, 2.0, true);
        assert!((flipped[2] - 0.75).abs() < 1e-9);
    }

    #[test]
    fn bad_exponents_and_tiny_distances_stay_finite() {
        let line = SubPath::polyline(&[pt(-30.0, 0.0), pt(0.0, 0.0)], false);
        for exponent in [-1.0, 0.0, f64::NAN] {
            let p = RippleParams { exponent, fan: true, ..Default::default() };
            let g = ripple_stitches(&[line.clone()], &p, &run());
            assert!(!g.is_empty() && g.iter().flatten().all(|q| q.x.is_finite() && q.y.is_finite()), "exponent {exponent}");
        }
        // a closed shape and a guided line with a line distance of 1e-6 mm: done quickly
        let t = std::time::Instant::now();
        let closed = SubPath::polyline(&[pt(20.0, 0.0), pt(0.0, 0.0)], true);
        let _ = ripple_stitches(&[closed], &RippleParams { min_line_dist: 1e-6, ..Default::default() }, &run());
        let open = SubPath::polyline(&[pt(20.0, 0.0), pt(0.0, 0.0)], false);
        let guide = SubPath::polyline(&[pt(20.0, 0.0), pt(0.0, 0.0)], false);
        let _ = ripple_stitches(&[open.clone()], &RippleParams { min_line_dist: 1e-6, guide: vec![guide], ..Default::default() }, &run());
        let _ = ripple_stitches(&[open], &RippleParams { grid_size: 1e-6, ..Default::default() }, &run());
        assert!(t.elapsed().as_secs_f64() < 20.0);
    }

    #[test]
    fn staggers_shift_the_needle_points() {
        let line = SubPath::polyline(&[pt(0.0, 0.0), pt(20.0, 0.0)], false);
        let p = RippleParams { lines: 4, spacing: 2.0, staggers: 4, ..Default::default() };
        let s = &ripple_stitches(&[line], &p, &run())[0];
        let xs = |y: f64| -> Vec<i64> { s.iter().filter(|q| (q.y - y).abs() < 1e-6 && q.x > 0.1 && q.x < 19.9).map(|q| (q.x * 100.0).round() as i64).collect() };
        assert_ne!(xs(0.0).first(), xs(4.0).first(), "rows staggered");
    }
}
