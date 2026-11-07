//! Shared-boundary vectorisation of a label image.
//!
//! Every pixel carries a region id. The boundary between two regions is
//! traced **once** as a *chain* of pixel-corner vertices running from one
//! junction (where three or more regions meet) to the next, and fitted once —
//! so neighbouring shapes share exactly the same curve: no gaps, no overlaps
//! (the "cutout" idea of VTracer, MIT).
//!
//! Chains are vectorised perception-first, after Hoshyari et al.,
//! "Perception-Driven Semi-Structured Boundary Vectorization" (SIGGRAPH
//! 2018): corners a viewer expects are detected at several scales and kept
//! sharp; the pixel staircase between them is treated as rasterisation noise
//! and replaced by the simplest smooth curve (kurbo's curve fitting), or a
//! straight line where the run is straight.

use crate::geom::{pt, Point};

/// Id used for "outside the image".
pub const OUTSIDE: u32 = u32::MAX;

/// A boundary between two regions: `left` lies on the left of the walking
/// direction (y down, so "left" is the counter-clockwise side on screen).
#[derive(Debug, Clone)]
pub struct Chain {
    pub left: u32,
    pub right: u32,
    /// Pixel-corner vertices (grid coordinates).
    pub pts: Vec<Point>,
    pub closed: bool,
}

/// A fitted piece of a chain (grid coordinates).
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Seg {
    Line(Point, Point),
    Cubic(Point, Point, Point, Point),
}

impl Seg {
    pub fn start(&self) -> Point {
        match *self {
            Seg::Line(a, _) | Seg::Cubic(a, _, _, _) => a,
        }
    }
    pub fn end(&self) -> Point {
        match *self {
            Seg::Line(_, b) | Seg::Cubic(_, _, _, b) => b,
        }
    }
    pub fn reversed(&self) -> Seg {
        match *self {
            Seg::Line(a, b) => Seg::Line(b, a),
            Seg::Cubic(a, b, c, d) => Seg::Cubic(d, c, b, a),
        }
    }
    pub fn map(&self, f: impl Fn(Point) -> Point) -> Seg {
        match *self {
            Seg::Line(a, b) => Seg::Line(f(a), f(b)),
            Seg::Cubic(a, b, c, d) => Seg::Cubic(f(a), f(b), f(c), f(d)),
        }
    }
}

struct Grid<'a> {
    ids: &'a [u32],
    w: usize,
    h: usize,
}

impl Grid<'_> {
    fn id(&self, x: i64, y: i64) -> u32 {
        if x < 0 || y < 0 || x >= self.w as i64 || y >= self.h as i64 {
            OUTSIDE
        } else {
            self.ids[y as usize * self.w + x as usize]
        }
    }
    /// Horizontal edge (x, y)–(x+1, y): between pixel (x, y-1) and (x, y).
    fn h_edge(&self, x: i64, y: i64) -> bool {
        x >= 0 && (x as usize) < self.w && y >= 0 && (y as usize) <= self.h && self.id(x, y - 1) != self.id(x, y)
    }
    /// Vertical edge (x, y)–(x, y+1): between pixel (x-1, y) and (x, y).
    fn v_edge(&self, x: i64, y: i64) -> bool {
        y >= 0 && (y as usize) < self.h && x >= 0 && (x as usize) <= self.w && self.id(x - 1, y) != self.id(x, y)
    }
    /// Boundary edges leaving vertex (x, y) as unit steps.
    fn steps(&self, x: i64, y: i64) -> Vec<(i64, i64)> {
        let mut out = Vec::with_capacity(4);
        if self.h_edge(x, y) {
            out.push((1, 0));
        }
        if self.h_edge(x - 1, y) {
            out.push((-1, 0));
        }
        if self.v_edge(x, y) {
            out.push((0, 1));
        }
        if self.v_edge(x, y - 1) {
            out.push((0, -1));
        }
        out
    }
    /// Pixel on the left / right of the step from (x, y) by (dx, dy).
    fn sides(&self, x: i64, y: i64, dx: i64, dy: i64) -> (u32, u32) {
        // edge midpoint ± half the left normal (dy, -dx)
        let (mx2, my2) = (2 * x + dx, 2 * y + dy);
        let left = self.id((mx2 + dy).div_euclid(2), (my2 - dx).div_euclid(2));
        let right = self.id((mx2 - dy).div_euclid(2), (my2 + dx).div_euclid(2));
        (left, right)
    }
}

/// Index of an undirected unit edge for the visited set.
fn edge_key(w: usize, x: i64, y: i64, dx: i64, dy: i64) -> usize {
    let (x0, y0) = (x.min(x + dx), y.min(y + dy));
    let cols = w + 1;
    let base = (y0 as usize) * cols + x0 as usize;
    if dy == 0 { base * 2 } else { base * 2 + 1 }
}

/// Trace all boundaries of a label image into chains.
pub fn chains(ids: &[u32], w: usize, h: usize) -> Vec<Chain> {
    let g = Grid { ids, w, h };
    let mut visited = vec![false; (w + 2) * (h + 2) * 2];
    let is_junction = |x: i64, y: i64| g.steps(x, y).len() >= 3;
    let mut out = Vec::new();
    let walk = |x0: i64, y0: i64, dx0: i64, dy0: i64, visited: &mut Vec<bool>| -> Chain {
        let (left, right) = g.sides(x0, y0, dx0, dy0);
        let mut pts = vec![pt(x0 as f64, y0 as f64)];
        let (mut x, mut y, mut dx, mut dy) = (x0, y0, dx0, dy0);
        loop {
            visited[edge_key(w, x, y, dx, dy)] = true;
            x += dx;
            y += dy;
            pts.push(pt(x as f64, y as f64));
            if (x, y) == (x0, y0) || is_junction(x, y) {
                break;
            }
            // the other boundary edge at this vertex
            let next = g.steps(x, y).into_iter().find(|&(sx, sy)| (sx, sy) != (-dx, -dy) && !visited[edge_key(w, x, y, sx, sy)]);
            match next {
                Some((sx, sy)) => {
                    dx = sx;
                    dy = sy;
                }
                None => break,
            }
        }
        let closed = pts.len() > 2 && pts[0] == *pts.last().unwrap();
        if closed {
            pts.pop();
        }
        Chain { left, right, pts, closed }
    };
    // chains starting at junctions
    for y in 0..=h as i64 {
        for x in 0..=w as i64 {
            if !is_junction(x, y) {
                continue;
            }
            for (dx, dy) in g.steps(x, y) {
                if !visited[edge_key(w, x, y, dx, dy)] {
                    out.push(walk(x, y, dx, dy, &mut visited));
                }
            }
        }
    }
    // loops without junctions (islands, holes)
    for y in 0..=h as i64 {
        for x in 0..w as i64 {
            if g.h_edge(x, y) && !visited[edge_key(w, x, y, 1, 0)] {
                out.push(walk(x, y, 1, 0, &mut visited));
            }
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Fitting

fn turn(a: Point, b: Point, c: Point) -> f64 {
    let u = b - a;
    let v = c - b;
    let (lu, lv) = (u.length(), v.length());
    if lu < 1e-9 || lv < 1e-9 {
        return 0.0;
    }
    (u.dot(v) / (lu * lv)).clamp(-1.0, 1.0).acos()
}

/// Indices (into `pts`) of perceptual corners. The staircase is removed
/// first; turns are then measured over an arc-length window (`2·scale`
/// grid units) on the smooth curve, so digital-line steps and gentle curves
/// never count while real corners do. Each corner snaps back to the pixel
/// corner that turns most, so shared junction geometry stays exact.
fn corners(pts: &[Point], closed: bool, corner_deg: f64, scale: f64) -> Vec<usize> {
    let n = pts.len();
    if n < 4 {
        return vec![];
    }
    let d = destair(pts, closed, scale);
    let m = d.len();
    let mut cum = vec![0.0; m];
    for j in 1..m {
        cum[j] = cum[j - 1] + d[j].dist(d[j - 1]);
    }
    let total = cum[m - 1] + if closed { d[m - 1].dist(d[0]) } else { 0.0 };
    if total < 1e-9 {
        return vec![];
    }
    let pos_at = |s: f64| -> Option<Point> {
        let s = if closed { s.rem_euclid(total) } else if s < 0.0 || s > total { return None } else { s };
        if s >= cum[m - 1] {
            // closing segment (closed) or the very end
            if !closed {
                return Some(d[m - 1]);
            }
            let l = (total - cum[m - 1]).max(1e-12);
            return Some(d[m - 1].lerp(d[0], (s - cum[m - 1]) / l));
        }
        let k = cum.partition_point(|&c| c <= s).max(1);
        let l = (cum[k] - cum[k - 1]).max(1e-12);
        Some(d[k - 1].lerp(d[k], (s - cum[k - 1]) / l))
    };
    // two scales: the turn over ±3 px must pass the threshold (chamfered
    // corners count), and be concentrated (±1.5 px), so small round dots
    // and gentle curves do not
    let win = 3.0 * scale;
    let thr = corner_deg.to_radians();
    let turn_at = |j: usize, r: f64| match (pos_at(cum[j] - r), pos_at(cum[j] + r)) {
        (Some(a), Some(c)) => turn(a, d[j], c),
        _ => 0.0,
    };
    let score: Vec<f64> = (0..m).map(|j| if turn_at(j, 1.5 * scale) >= 0.45 * thr { turn_at(j, win) } else { 0.0 }).collect();
    let arc = |a: usize, b: usize| {
        let x = (cum[a] - cum[b]).abs();
        if closed { x.min(total - x) } else { x }
    };
    let raw_turn = |i: usize| -> f64 {
        if closed {
            turn(pts[(i + n - 1) % n], pts[i], pts[(i + 1) % n])
        } else if i == 0 || i + 1 >= n {
            0.0
        } else {
            turn(pts[i - 1], pts[i], pts[i + 1])
        }
    };
    let mut out: Vec<usize> = Vec::new();
    for j in 0..m {
        if score[j] < thr {
            continue;
        }
        let is_max = (0..m).all(|k| k == j || arc(j, k) > win || score[k] < score[j] || (score[k] == score[j] && k > j));
        if !is_max {
            continue;
        }
        // nearest raw vertices of this smooth point, the sharpest wins
        let cands: Vec<usize> = if closed {
            vec![j % n, (j + 1) % n, (j + n - 1) % n, (j + 2) % n]
        } else {
            [j as i64 - 2, j as i64 - 1, j as i64, j as i64 + 1].into_iter().filter(|&i| i > 0 && (i as usize) < n - 1).map(|i| i as usize).collect()
        };
        if let Some(&i) = cands.iter().max_by(|a, b| raw_turn(**a).partial_cmp(&raw_turn(**b)).unwrap()) {
            if !out.contains(&i) {
                out.push(i);
            }
        }
    }
    out.sort_unstable();
    out
}

/// Staircase removal: edge midpoints between the fixed ends, then light
/// Laplacian smoothing.
/// Smoothing shrinks a closed loop (a lone pixel of pixel art would shrink to a
/// point): scale it about its centroid back to the area of the traced loop.
fn keep_area(smooth: &mut [Point], traced: &[Point]) {
    let area = |p: &[Point]| crate::geom::signed_area(p).abs();
    let (a0, a1) = (area(traced), area(smooth));
    if a1 < 1e-9 || a1 >= a0 {
        return;
    }
    let c = smooth.iter().fold(Point::ZERO, |acc, p| acc + *p) * (1.0 / smooth.len() as f64);
    let k = (a0 / a1).sqrt();
    for p in smooth.iter_mut() {
        *p = c + (*p - c) * k;
    }
}

fn destair(pts: &[Point], closed: bool, scale: f64) -> Vec<Point> {
    let n = pts.len();
    let mut out: Vec<Point> = Vec::with_capacity(n + 1);
    if closed {
        for i in 0..n {
            out.push(pts[i].lerp(pts[(i + 1) % n], 0.5));
        }
    } else {
        out.push(pts[0]);
        for i in 0..n - 1 {
            out.push(pts[i].lerp(pts[i + 1], 0.5));
        }
        out.push(pts[n - 1]);
    }
    let m = out.len();
    // diffusion length grows with sqrt(iterations): steps of `scale` units
    let iterations = (2.0 * scale * scale).round().clamp(2.0, 200.0) as usize;
    for _ in 0..iterations {
        let prev = out.clone();
        for i in 0..m {
            if !closed && (i == 0 || i == m - 1) {
                continue;
            }
            let a = prev[(i + m - 1) % m];
            let c = prev[(i + 1) % m];
            out[i] = (a + prev[i] * 2.0 + c) * 0.25;
        }
    }
    out
}

/// [`fit_smooth`] with guards: duplicate points removed, and every fitted
/// curve must stay close to its source points (kurbo's fitter can run away
/// on degenerate input); otherwise the smoothed polyline is simplified.
fn fit_checked(pts: &[Point], closed: bool, accuracy: f64) -> Vec<Seg> {
    let mut p: Vec<Point> = Vec::with_capacity(pts.len());
    for &q in pts {
        if p.last().map_or(true, |l: &Point| l.dist(q) > 1e-6) {
            p.push(q);
        }
    }
    if closed && p.len() > 2 && p[0].dist(*p.last().unwrap()) < 1e-6 {
        p.pop();
    }
    if p.len() < 2 {
        return vec![];
    }
    let segs = fit_smooth(&p, closed, accuracy);
    let ok = !segs.is_empty() && segs.iter().all(|sg| seg_near(sg, &p, accuracy * 4.0 + 1.0));
    if ok {
        return segs;
    }
    let mut line = p.clone();
    if closed {
        line.push(p[0]);
    }
    let simple = crate::geom::simplify(&line, accuracy);
    simple.windows(2).map(|w| Seg::Line(w[0], w[1])).collect()
}

/// Every sample of the segment lies within `tol` of the source polyline.
fn seg_near(sg: &Seg, pts: &[Point], tol: f64) -> bool {
    let samples: Vec<Point> = match *sg {
        Seg::Line(a, b) => vec![a, a.lerp(b, 0.5), b],
        Seg::Cubic(a, b, c, d) => (0..=8)
            .map(|k| {
                let t = k as f64 / 8.0;
                let u = 1.0 - t;
                a * (u * u * u) + b * (3.0 * u * u * t) + c * (3.0 * u * t * t) + d * (t * t * t)
            })
            .collect(),
    };
    let dist = |q: Point| {
        let mut best = f64::INFINITY;
        for w in pts.windows(2) {
            let d = w[1] - w[0];
            let l2 = d.length_sq().max(1e-12);
            let t = ((q - w[0]).dot(d) / l2).clamp(0.0, 1.0);
            best = best.min((w[0] + d * t).dist(q));
        }
        if pts.len() == 1 { pts[0].dist(q) } else { best }
    };
    samples.into_iter().all(|q| q.x.is_finite() && q.y.is_finite() && dist(q) <= tol)
}

/// Catmull-Rom through the points, simplified into few cubics.
fn fit_smooth(pts: &[Point], closed: bool, accuracy: f64) -> Vec<Seg> {
    use kurbo::{BezPath, PathEl};
    let n = pts.len();
    if n < 2 {
        return vec![];
    }
    if n == 2 && !closed {
        return vec![Seg::Line(pts[0], pts[1])];
    }
    let k = |p: Point| kurbo::Point::new(p.x, p.y);
    let get = |i: i64| -> Point {
        if closed {
            pts[i.rem_euclid(n as i64) as usize]
        } else {
            pts[i.clamp(0, n as i64 - 1) as usize]
        }
    };
    let mut path = BezPath::new();
    path.move_to(k(pts[0]));
    let segs = if closed { n } else { n - 1 };
    for i in 0..segs as i64 {
        let (p0, p1, p2, p3) = (get(i - 1), get(i), get(i + 1), get(i + 2));
        let c1 = p1 + (p2 - p0) * (1.0 / 6.0);
        let c2 = p2 - (p3 - p1) * (1.0 / 6.0);
        path.push(PathEl::CurveTo(k(c1), k(c2), k(p2)));
    }
    if closed {
        path.close_path();
    }
    let simple = crate::bezfit::simplify_bezpath(path, accuracy, 0.05);
    let mut out = Vec::new();
    let mut cur = pts[0];
    let p = |q: kurbo::Point| pt(q.x, q.y);
    for el in simple.elements() {
        match *el {
            PathEl::MoveTo(q) => cur = p(q),
            PathEl::LineTo(q) => {
                out.push(Seg::Line(cur, p(q)));
                cur = p(q);
            }
            PathEl::QuadTo(c, q) => {
                let (c, q) = (p(c), p(q));
                out.push(Seg::Cubic(cur, cur + (c - cur) * (2.0 / 3.0), q + (c - q) * (2.0 / 3.0), q));
                cur = q;
            }
            PathEl::CurveTo(c1, c2, q) => {
                out.push(Seg::Cubic(cur, p(c1), p(c2), p(q)));
                cur = p(q);
            }
            PathEl::ClosePath => {}
        }
    }
    out
}

/// Deviation from the chord, ignoring `trim` points at each end (the
/// chamfer steps next to corners).
fn inner_dev(pts: &[Point], trim: usize) -> f64 {
    if pts.len() <= 2 * trim + 2 {
        return max_dev_from_chord(pts);
    }
    let inner = &pts[trim..pts.len() - trim];
    let (a, b) = (inner[0], *inner.last().unwrap());
    let d = b - a;
    let l = d.length();
    inner.iter().map(|q| if l < 1e-9 { q.dist(a) } else { ((*q - a).cross(d) / l).abs() }).fold(0.0, f64::max)
}

fn max_dev_from_chord(pts: &[Point]) -> f64 {
    let (a, b) = (pts[0], *pts.last().unwrap());
    let d = b - a;
    let l = d.length();
    pts.iter()
        .map(|q| if l < 1e-9 { q.dist(a) } else { ((*q - a).cross(d) / l).abs() })
        .fold(0.0, f64::max)
}

/// Fit one chain: corners stay sharp, straight runs become lines, the rest
/// smooth cubics. `accuracy` and the straightness test are in grid units.
pub fn fit_chain(c: &Chain, accuracy: f64, corner_deg: f64, scale: f64) -> Vec<Seg> {
    let pts = &c.pts;
    let n = pts.len();
    if n < 2 {
        return vec![];
    }
    let mut cuts = corners(pts, c.closed, corner_deg, scale);
    // pieces between cuts (open chains: also their ends)
    let mut pieces: Vec<(Vec<Point>, bool)> = Vec::new();
    if c.closed {
        if cuts.is_empty() {
            pieces.push((pts.clone(), true));
        } else {
            for k in 0..cuts.len() {
                let (a, b) = (cuts[k], cuts[(k + 1) % cuts.len()]);
                let mut piece = Vec::new();
                let mut i = a;
                loop {
                    piece.push(pts[i]);
                    if i == b && piece.len() > 1 {
                        break;
                    }
                    i = (i + 1) % n;
                    if piece.len() > n + 1 {
                        break;
                    }
                }
                pieces.push((piece, false));
            }
        }
    } else {
        cuts.retain(|&i| i > 0 && i < n - 1);
        let mut bounds = vec![0];
        bounds.extend(cuts);
        bounds.push(n - 1);
        for w in bounds.windows(2) {
            pieces.push((pts[w[0]..=w[1]].to_vec(), false));
        }
    }
    let mut outs: Vec<Vec<Seg>> = Vec::new();
    for (piece, closed) in &pieces {
        let (piece, closed) = (piece, *closed);
        let mut o = Vec::new();
        if piece.len() < 2 {
            outs.push(o);
            continue;
        }
        let trim = (2.0 * scale).round() as usize;
        if !closed && (piece.len() <= 3 || inner_dev(piece, trim) <= 0.75 * scale) {
            o.push(Seg::Line(piece[0], *piece.last().unwrap()));
        } else {
            let mut smooth = destair(piece, closed, scale);
            if closed {
                keep_area(&mut smooth, piece);
            }
            if !closed && max_dev_from_chord(&smooth) <= 0.45 * scale {
                o.push(Seg::Line(piece[0], *piece.last().unwrap()));
            } else {
                o.extend(fit_checked(&smooth, closed, accuracy));
            }
        }
        outs.push(o);
    }
    // corners between two straight pieces: rebuild the sharp corner where
    // the lines meet (the cleanup filter shaves pixel corners into chamfers)
    let count = outs.len();
    let joints = if c.closed { count } else { count.saturating_sub(1) };
    if count > 1 {
        for k in 0..joints {
            let k2 = (k + 1) % count;
            let (Some(Seg::Line(a0, a1)), Some(Seg::Line(b0, b1))) = (outs[k].first().copied(), outs[k2].first().copied()) else { continue };
            if outs[k].len() != 1 || outs[k2].len() != 1 || a1 != b0 {
                continue;
            }
            let (pa, pb) = (&pieces[k].0, &pieces[k2].0);
            // line directions from the inner points (away from both chamfers)
            let q = |len: usize| ((3.0 * scale) as usize).min(len / 3);
            let t = |len: usize| ((2.0 * scale) as usize).min(len / 3);
            let (u0, u1) = (pa[t(pa.len())], pa[pa.len() - 1 - q(pa.len())]);
            let (v0, v1) = (pb[q(pb.len())], pb[pb.len() - 1 - t(pb.len())]);
            let (du, dv) = (u1 - u0, v1 - v0);
            let den = du.cross(dv);
            if den.abs() < 1e-9 {
                continue;
            }
            let t = (v0 - u0).cross(dv) / den;
            let x = u0 + du * t;
            if x.dist(a1) <= 3.0 * scale {
                outs[k][0] = Seg::Line(a0, x);
                outs[k2][0] = Seg::Line(x, b1);
            }
        }
    }
    let out: Vec<Seg> = outs.into_iter().flatten().collect();
    out
}

/// Fit one chain of upscaled pixel art (`up` grid units per source pixel). Pixel art
/// is drawn on purpose pixel by pixel: every 90° corner stays, except the steps of a
/// staircase (a run of one source pixel between two turns the opposite way, or the
/// one-unit steps of a diagonal the upscaler joined), which become a smooth diagonal
/// or curve. Curves stay within a quarter of a source pixel of the pixels.
pub fn fit_chain_pixel(c: &Chain, up: f64) -> Vec<Seg> {
    let pts = &c.pts;
    let n = pts.len();
    if n < 2 {
        return vec![];
    }
    // runs of equal unit steps: (first vertex, last vertex, direction, steps)
    let step = |i: usize| {
        let d = pts[(i + 1) % n] - pts[i];
        ((d.x.round() as i64).signum(), (d.y.round() as i64).signum())
    };
    let steps = if c.closed { n } else { n - 1 };
    let mut runs: Vec<(usize, usize, (i64, i64), usize)> = Vec::new();
    for i in 0..steps {
        let d = step(i);
        match runs.last_mut() {
            Some(r) if r.2 == d => {
                r.1 = (i + 1) % n;
                r.3 += 1;
            }
            _ => runs.push((i, (i + 1) % n, d, 1)),
        }
    }
    if c.closed && runs.len() > 1 && runs[0].2 == runs.last().unwrap().2 {
        let last = runs.pop().unwrap();
        runs[0].0 = last.0;
        runs[0].3 += last.3;
    }
    let m = runs.len();
    if m < 2 {
        return vec![Seg::Line(pts[0], pts[if c.closed { 0 } else { n - 1 }])];
    }
    let run_len = |k: usize| runs[k].3 as f64;
    // turn at the vertex between run k and run k+1: +1 / -1 (sense), 0 = no turn there
    let sense = |k: usize| -> i64 {
        if !c.closed && k + 1 >= m {
            return 0;
        }
        let (a, b) = (runs[k % m].2, runs[(k + 1) % m].2);
        (a.0 * b.1 - a.1 * b.0).signum()
    };
    let short = up + 0.5;
    // the vertex after run k is a corner unless one of its runs is a staircase step
    let corner_after = |k: usize| -> bool {
        let t = sense(k);
        if t == 0 {
            return false;
        }
        let before = if c.closed { (k + m - 1) % m } else if k == 0 { usize::MAX } else { k - 1 };
        let step_before = before != usize::MAX && run_len(k) <= short && sense(before) == -t;
        let step_after = run_len((k + 1) % m) <= short && (c.closed || k + 2 < m) && sense((k + 1) % m) == -t;
        !(step_before || step_after)
    };
    let mut cuts: Vec<usize> = (0..if c.closed { m } else { m - 1 }).filter(|&k| corner_after(k)).map(|k| runs[k].1).collect();
    cuts.sort_unstable();
    let acc = 0.25 * up;
    let fit_piece = |piece: &[Point], closed: bool| -> Vec<Seg> {
        if piece.len() < 2 {
            return vec![];
        }
        if !closed && (piece.len() <= 3 || max_dev_from_chord(piece) <= 0.5) {
            return vec![Seg::Line(piece[0], *piece.last().unwrap())];
        }
        let mut smooth = destair(piece, closed, up);
        if closed {
            keep_area(&mut smooth, piece);
        }
        if !closed && max_dev_from_chord(&smooth) <= acc {
            return vec![Seg::Line(piece[0], *piece.last().unwrap())];
        }
        let segs = fit_smooth(&smooth, closed, acc);
        if !segs.is_empty() && segs.iter().all(|sg| seg_near(sg, &smooth, 2.0 * acc)) {
            return segs;
        }
        let mut line = smooth.clone();
        if closed {
            line.push(smooth[0]);
        }
        crate::geom::simplify(&line, acc).windows(2).map(|w| Seg::Line(w[0], w[1])).collect()
    };
    let mut out = Vec::new();
    if c.closed {
        if cuts.is_empty() {
            return fit_piece(pts, true);
        }
        for k in 0..cuts.len() {
            let (a, b) = (cuts[k], cuts[(k + 1) % cuts.len()]);
            let mut piece = vec![pts[a]];
            let mut i = a;
            loop {
                i = (i + 1) % n;
                piece.push(pts[i]);
                if i == b || piece.len() > n + 1 {
                    break;
                }
            }
            out.extend(fit_piece(&piece, false));
        }
    } else {
        let mut bounds = vec![0];
        bounds.extend(cuts.into_iter().filter(|&i| i > 0 && i < n - 1));
        bounds.push(n - 1);
        for w in bounds.windows(2) {
            out.extend(fit_piece(&pts[w[0]..=w[1]], false));
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Rings per region

/// The closed outlines of region `id` (each a list of segments, region on
/// the left), assembled from the fitted chains it borders.
pub fn region_rings(chains: &[Chain], fitted: &[Vec<Seg>], id: u32) -> Vec<Vec<Seg>> {
    region_rings_of(chains, fitted, id, 0..chains.len())
}

/// Chain indices per region id (for many regions: build once).
pub fn chains_by_region(chains: &[Chain]) -> std::collections::HashMap<u32, Vec<usize>> {
    let mut m: std::collections::HashMap<u32, Vec<usize>> = std::collections::HashMap::new();
    for (i, c) in chains.iter().enumerate() {
        m.entry(c.left).or_default().push(i);
        if c.right != c.left {
            m.entry(c.right).or_default().push(i);
        }
    }
    m
}

/// [`region_rings`] over the given chain indices only.
pub fn region_rings_of(chains: &[Chain], fitted: &[Vec<Seg>], id: u32, idx: impl IntoIterator<Item = usize>) -> Vec<Vec<Seg>> {
    // directed pieces with the region on the left
    let mut pieces: Vec<Vec<Seg>> = Vec::new();
    let mut rings: Vec<Vec<Seg>> = Vec::new();
    for i in idx {
        let (c, f) = (&chains[i], &fitted[i]);
        if f.is_empty() {
            continue;
        }
        let segs: Vec<Seg> = if c.left == id {
            f.clone()
        } else if c.right == id {
            f.iter().rev().map(|s| s.reversed()).collect()
        } else {
            continue;
        };
        if c.closed {
            rings.push(segs);
        } else {
            pieces.push(segs);
        }
    }
    let key = |p: Point| ((p.x * 2.0).round() as i64, (p.y * 2.0).round() as i64);
    let mut used = vec![false; pieces.len()];
    for s in 0..pieces.len() {
        if used[s] {
            continue;
        }
        used[s] = true;
        let start = key(pieces[s][0].start());
        let mut ring = pieces[s].clone();
        let mut guard = 0;
        while key(ring.last().unwrap().end()) != start && guard < pieces.len() + 2 {
            guard += 1;
            let end = key(ring.last().unwrap().end());
            match (0..pieces.len()).find(|&j| !used[j] && key(pieces[j][0].start()) == end) {
                Some(j) => {
                    used[j] = true;
                    ring.extend(pieces[j].iter().copied());
                }
                None => break,
            }
        }
        rings.push(ring);
    }
    rings
}

#[cfg(test)]
mod tests {
    use super::*;

    fn img(w: usize, h: usize, f: impl Fn(usize, usize) -> u32) -> Vec<u32> {
        (0..w * h).map(|i| f(i % w, i / w)).collect()
    }

    #[test]
    fn neighbours_share_one_chain() {
        // left half 0, right half 1
        let ids = img(10, 6, |x, _| if x < 5 { 0 } else { 1 });
        let cs = chains(&ids, 10, 6);
        let shared: Vec<&Chain> = cs.iter().filter(|c| (c.left == 0 && c.right == 1) || (c.left == 1 && c.right == 0)).collect();
        assert_eq!(shared.len(), 1);
        assert_eq!(shared[0].pts.len(), 7);
        // every region gets one closed ring
        let fitted: Vec<Vec<Seg>> = cs.iter().map(|c| fit_chain(c, 0.3, 55.0, 1.0)).collect();
        for id in [0, 1] {
            let rings = region_rings(&cs, &fitted, id);
            assert_eq!(rings.len(), 1, "region {id}");
            let r = &rings[0];
            assert_eq!(r[0].start(), r.last().unwrap().end());
        }
    }

    #[test]
    fn square_keeps_corners_and_disc_is_smooth() {
        let sq = img(20, 20, |x, y| u32::from((4..16).contains(&x) && (4..16).contains(&y)));
        let cs = chains(&sq, 20, 20);
        let inner = cs.iter().find(|c| c.left == 1 || c.right == 1).unwrap();
        let segs = fit_chain(inner, 0.3, 55.0, 1.0);
        assert!(segs.iter().all(|s| matches!(s, Seg::Line(..))), "{segs:?}");
        assert_eq!(segs.len(), 4);
        let disc = img(40, 40, |x, y| u32::from(((x as f64 - 19.5).powi(2) + (y as f64 - 19.5).powi(2)).sqrt() < 14.0));
        let cs = chains(&disc, 40, 40);
        let c = cs.iter().find(|c| c.left == 1 || c.right == 1).unwrap();
        let segs = fit_chain(c, 0.3, 55.0, 1.0);
        assert!(segs.len() <= 12, "{} segments", segs.len());
        assert!(segs.iter().all(|s| matches!(s, Seg::Cubic(..))));
    }

    #[test]
    fn junctions_split_chains() {
        // three regions meeting: 0 top, 1 bottom-left, 2 bottom-right
        let ids = img(10, 10, |x, y| if y < 5 { 0 } else if x < 5 { 1 } else { 2 });
        let cs = chains(&ids, 10, 10);
        let fitted: Vec<Vec<Seg>> = cs.iter().map(|c| fit_chain(c, 0.3, 55.0, 1.0)).collect();
        for id in [0, 1, 2] {
            let rings = region_rings(&cs, &fitted, id);
            assert_eq!(rings.len(), 1, "region {id}: {rings:?}");
        }
    }
}


