//! Small, dependency-light 2D geometry toolkit used by every stitch generator.
//!
//! All coordinates are millimetres in a y-down coordinate system (same as SVG).

use std::ops::{Add, AddAssign, Div, Mul, Neg, Sub};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

#[inline]
pub const fn pt(x: f64, y: f64) -> Point {
    Point { x, y }
}

impl Point {
    pub const ZERO: Point = pt(0.0, 0.0);

    #[inline]
    pub fn length(self) -> f64 {
        self.x.hypot(self.y)
    }
    #[inline]
    pub fn length_sq(self) -> f64 {
        self.x * self.x + self.y * self.y
    }
    #[inline]
    pub fn dist(self, o: Point) -> f64 {
        (self - o).length()
    }
    #[inline]
    pub fn dot(self, o: Point) -> f64 {
        self.x * o.x + self.y * o.y
    }
    #[inline]
    pub fn cross(self, o: Point) -> f64 {
        self.x * o.y - self.y * o.x
    }
    #[inline]
    pub fn unit(self) -> Point {
        let l = self.length();
        if l < 1e-12 {
            Point::ZERO
        } else {
            self / l
        }
    }
    /// Rotate 90° counter-clockwise in a y-up system (clockwise on screen).
    #[inline]
    pub fn perp(self) -> Point {
        pt(-self.y, self.x)
    }
    #[inline]
    pub fn rotate(self, angle: f64) -> Point {
        let (s, c) = angle.sin_cos();
        pt(self.x * c - self.y * s, self.x * s + self.y * c)
    }
    #[inline]
    pub fn lerp(self, o: Point, t: f64) -> Point {
        self + (o - self) * t
    }
    #[inline]
    pub fn angle(self) -> f64 {
        self.y.atan2(self.x)
    }
    pub fn from_arr(a: [f64; 2]) -> Point {
        pt(a[0], a[1])
    }
    pub fn arr(self) -> [f64; 2] {
        [self.x, self.y]
    }
}

impl Add for Point {
    type Output = Point;
    #[inline]
    fn add(self, o: Point) -> Point {
        pt(self.x + o.x, self.y + o.y)
    }
}
impl AddAssign for Point {
    #[inline]
    fn add_assign(&mut self, o: Point) {
        self.x += o.x;
        self.y += o.y;
    }
}
impl Sub for Point {
    type Output = Point;
    #[inline]
    fn sub(self, o: Point) -> Point {
        pt(self.x - o.x, self.y - o.y)
    }
}
impl Mul<f64> for Point {
    type Output = Point;
    #[inline]
    fn mul(self, s: f64) -> Point {
        pt(self.x * s, self.y * s)
    }
}
impl Div<f64> for Point {
    type Output = Point;
    #[inline]
    fn div(self, s: f64) -> Point {
        pt(self.x / s, self.y / s)
    }
}
impl Neg for Point {
    type Output = Point;
    #[inline]
    fn neg(self) -> Point {
        pt(-self.x, -self.y)
    }
}

/// Axis aligned bounding box.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Rect {
    pub min_x: f64,
    pub min_y: f64,
    pub max_x: f64,
    pub max_y: f64,
}

impl Rect {
    pub const EMPTY: Rect = Rect {
        min_x: f64::INFINITY,
        min_y: f64::INFINITY,
        max_x: f64::NEG_INFINITY,
        max_y: f64::NEG_INFINITY,
    };
    pub fn is_empty(&self) -> bool {
        self.min_x > self.max_x || self.min_y > self.max_y
    }
    pub fn include(&mut self, p: Point) {
        self.min_x = self.min_x.min(p.x);
        self.min_y = self.min_y.min(p.y);
        self.max_x = self.max_x.max(p.x);
        self.max_y = self.max_y.max(p.y);
    }
    pub fn union(&self, o: &Rect) -> Rect {
        Rect {
            min_x: self.min_x.min(o.min_x),
            min_y: self.min_y.min(o.min_y),
            max_x: self.max_x.max(o.max_x),
            max_y: self.max_y.max(o.max_y),
        }
    }
    pub fn intersects(&self, o: &Rect) -> bool {
        !(self.is_empty() || o.is_empty())
            && self.min_x <= o.max_x
            && o.min_x <= self.max_x
            && self.min_y <= o.max_y
            && o.min_y <= self.max_y
    }
    pub fn width(&self) -> f64 {
        (self.max_x - self.min_x).max(0.0)
    }
    pub fn height(&self) -> f64 {
        (self.max_y - self.min_y).max(0.0)
    }
    pub fn center(&self) -> Point {
        pt((self.min_x + self.max_x) * 0.5, (self.min_y + self.max_y) * 0.5)
    }
    pub fn of_points<'a>(pts: impl IntoIterator<Item = &'a Point>) -> Rect {
        let mut r = Rect::EMPTY;
        for p in pts {
            r.include(*p);
        }
        r
    }
}

// ---------------------------------------------------------------------------
// Polylines
// ---------------------------------------------------------------------------

pub fn polyline_length(pts: &[Point]) -> f64 {
    pts.windows(2).map(|w| w[0].dist(w[1])).sum()
}

/// Cumulative arc length at each vertex.
pub fn cumulative_lengths(pts: &[Point]) -> Vec<f64> {
    let mut out = Vec::with_capacity(pts.len());
    let mut acc = 0.0;
    for (i, p) in pts.iter().enumerate() {
        if i > 0 {
            acc += pts[i - 1].dist(*p);
        }
        out.push(acc);
    }
    out
}

/// Point at arc length `d` along a polyline (clamped).
pub fn point_at(pts: &[Point], cum: &[f64], d: f64) -> Point {
    if pts.is_empty() {
        return Point::ZERO;
    }
    if d <= 0.0 {
        return pts[0];
    }
    let total = *cum.last().unwrap();
    if d >= total {
        return *pts.last().unwrap();
    }
    // binary search the segment
    let idx = match cum.binary_search_by(|v| v.partial_cmp(&d).unwrap()) {
        Ok(i) => return pts[i],
        Err(i) => i,
    };
    let (a, b) = (pts[idx - 1], pts[idx]);
    let seg = cum[idx] - cum[idx - 1];
    if seg <= 1e-12 {
        return a;
    }
    a.lerp(b, (d - cum[idx - 1]) / seg)
}

/// Sub-polyline between arc lengths `d0` and `d1` (d0 <= d1).
pub fn substring(pts: &[Point], cum: &[f64], d0: f64, d1: f64) -> Vec<Point> {
    let mut out = vec![point_at(pts, cum, d0)];
    for (i, p) in pts.iter().enumerate() {
        if cum[i] > d0 && cum[i] < d1 {
            out.push(*p);
        }
    }
    out.push(point_at(pts, cum, d1));
    out
}

/// Project point onto polyline, returning (arc length, distance).
pub fn project(pts: &[Point], cum: &[f64], p: Point) -> (f64, f64) {
    let mut best = (0.0, f64::INFINITY);
    for i in 1..pts.len() {
        let (a, b) = (pts[i - 1], pts[i]);
        let ab = b - a;
        let l2 = ab.length_sq();
        let t = if l2 < 1e-18 { 0.0 } else { ((p - a).dot(ab) / l2).clamp(0.0, 1.0) };
        let q = a + ab * t;
        let d = q.dist(p);
        if d < best.1 {
            best = (cum[i - 1] + t * (cum[i] - cum[i - 1]), d);
        }
    }
    best
}

/// Remove consecutive duplicate points.
pub fn dedup(pts: &mut Vec<Point>, eps: f64) {
    pts.dedup_by(|b, a| a.dist(*b) < eps);
}

/// Douglas-Peucker simplification.
pub fn simplify(pts: &[Point], tol: f64) -> Vec<Point> {
    if pts.len() < 3 {
        return pts.to_vec();
    }
    let mut keep = vec![false; pts.len()];
    keep[0] = true;
    keep[pts.len() - 1] = true;
    let mut stack = vec![(0usize, pts.len() - 1)];
    while let Some((s, e)) = stack.pop() {
        if e <= s + 1 {
            continue;
        }
        let (a, b) = (pts[s], pts[e]);
        let ab = b - a;
        let len = ab.length();
        let mut best = (0usize, -1.0f64);
        for (i, p) in pts.iter().enumerate().take(e).skip(s + 1) {
            let d = if len < 1e-12 { p.dist(a) } else { ((*p - a).cross(ab) / len).abs() };
            if d > best.1 {
                best = (i, d);
            }
        }
        if best.1 > tol {
            keep[best.0] = true;
            stack.push((s, best.0));
            stack.push((best.0, e));
        }
    }
    pts.iter().zip(keep).filter(|(_, k)| *k).map(|(p, _)| *p).collect()
}

/// Chaikin-free light smoothing: resample to a maximum segment length.
pub fn resample_max(pts: &[Point], max_len: f64) -> Vec<Point> {
    let mut out = Vec::with_capacity(pts.len());
    for (i, p) in pts.iter().enumerate() {
        if i > 0 {
            let a = pts[i - 1];
            let d = a.dist(*p);
            let n = (d / max_len).ceil() as usize;
            for k in 1..n {
                out.push(a.lerp(*p, k as f64 / n as f64));
            }
        }
        out.push(*p);
    }
    out
}

/// Offset an open polyline sideways by `d` (positive = left of travel direction
/// in screen space). Uses mitred joins with a miter limit.
pub fn offset_polyline(pts: &[Point], d: f64) -> Vec<Point> {
    offset_polyline_impl(pts, d, false)
}

/// Offset a closed polyline (first point == last point, or implicitly closed):
/// joins are mitred cyclically so there is no seam. Output repeats the first
/// point at the end when the input did.
pub fn offset_closed(pts: &[Point], d: f64) -> Vec<Point> {
    let mut ring: Vec<Point> = pts.to_vec();
    let dup = ring.len() > 2 && ring[0].dist(*ring.last().unwrap()) < 1e-9;
    if dup {
        ring.pop();
    }
    let mut out = offset_polyline_impl(&ring, d, true);
    if dup {
        if let Some(f) = out.first().copied() {
            out.push(f);
        }
    }
    out
}

fn offset_polyline_impl(pts: &[Point], d: f64, closed: bool) -> Vec<Point> {
    let n = pts.len();
    if n < 2 {
        return pts.to_vec();
    }
    let mut out = Vec::with_capacity(n);
    for i in 0..n {
        let prev = if i > 0 {
            (pts[i] - pts[i - 1]).unit()
        } else if closed {
            (pts[0] - pts[n - 1]).unit()
        } else {
            (pts[1] - pts[0]).unit()
        };
        let next = if i + 1 < n {
            (pts[i + 1] - pts[i]).unit()
        } else if closed {
            (pts[0] - pts[i]).unit()
        } else {
            prev
        };
        let n0 = prev.perp();
        let n1 = next.perp();
        let mut m = (n0 + n1).unit();
        if m.length_sq() < 1e-12 {
            m = n0;
        }
        let cos_half = m.dot(n1).max(0.25); // miter limit 4
        out.push(pts[i] + m * (d / cos_half));
    }
    out
}

// ---------------------------------------------------------------------------
// Polygons (rings) — even-odd filled regions
// ---------------------------------------------------------------------------

pub type Ring = Vec<Point>;

pub fn signed_area(ring: &[Point]) -> f64 {
    let n = ring.len();
    if n < 3 {
        return 0.0;
    }
    let mut a = 0.0;
    for i in 0..n {
        let (p, q) = (ring[i], ring[(i + 1) % n]);
        a += p.x * q.y - q.x * p.y;
    }
    a * 0.5
}

pub fn rings_area(rings: &[Ring]) -> f64 {
    // even-odd: assumes holes are nested inside outers; sign is arbitrary per ring.
    let mut total = 0.0;
    for (i, r) in rings.iter().enumerate() {
        let a = signed_area(r).abs();
        let depth = rings
            .iter()
            .enumerate()
            .filter(|(j, o)| *j != i && !r.is_empty() && point_in_ring(r[0], o))
            .count();
        if depth % 2 == 0 {
            total += a
        } else {
            total -= a
        }
    }
    total.max(0.0)
}

pub fn point_in_ring(p: Point, ring: &[Point]) -> bool {
    let n = ring.len();
    let mut inside = false;
    let mut j = n.wrapping_sub(1);
    for i in 0..n {
        let (a, b) = (ring[i], ring[j]);
        if (a.y > p.y) != (b.y > p.y) {
            let x = (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x;
            if p.x < x {
                inside = !inside;
            }
        }
        j = i;
    }
    inside
}

/// Even-odd point-in-region test.
pub fn point_in_rings(p: Point, rings: &[Ring]) -> bool {
    rings.iter().filter(|r| point_in_ring(p, r)).count() % 2 == 1
}

pub fn rotate_rings(rings: &[Ring], angle: f64) -> Vec<Ring> {
    rings.iter().map(|r| r.iter().map(|p| p.rotate(angle)).collect()).collect()
}

pub fn rings_bounds(rings: &[Ring]) -> Rect {
    let mut r = Rect::EMPTY;
    for ring in rings {
        for p in ring {
            r.include(*p);
        }
    }
    r
}

/// Intersect a horizontal line y with the region, returning sorted
/// inside-intervals [x0,x1] (even-odd rule).
pub fn scanline(rings: &[Ring], y: f64) -> Vec<(f64, f64)> {
    let mut xs: Vec<f64> = Vec::new();
    for ring in rings {
        let n = ring.len();
        for i in 0..n {
            let a = ring[i];
            let b = ring[(i + 1) % n];
            // half-open rule avoids double counting vertices
            if (a.y <= y && b.y > y) || (b.y <= y && a.y > y) {
                let t = (y - a.y) / (b.y - a.y);
                xs.push(a.x + t * (b.x - a.x));
            }
        }
    }
    xs.sort_by(|a, b| a.partial_cmp(b).unwrap());
    xs.chunks_exact(2).map(|c| (c[0], c[1])).filter(|(a, b)| b - a > 1e-9).collect()
}

/// Do two segments properly intersect (excluding shared endpoints)?
pub fn segments_intersect(p1: Point, p2: Point, q1: Point, q2: Point) -> bool {
    let d1 = (p2 - p1).cross(q1 - p1);
    let d2 = (p2 - p1).cross(q2 - p1);
    let d3 = (q2 - q1).cross(p1 - q1);
    let d4 = (q2 - q1).cross(p2 - q1);
    ((d1 > 1e-12 && d2 < -1e-12) || (d1 < -1e-12 && d2 > 1e-12))
        && ((d3 > 1e-12 && d4 < -1e-12) || (d3 < -1e-12 && d4 > 1e-12))
}

/// Intersection point of segment p1p2 and q1q2 if any (parameter on p, point).
pub fn segment_intersection(p1: Point, p2: Point, q1: Point, q2: Point) -> Option<(f64, Point)> {
    let r = p2 - p1;
    let s = q2 - q1;
    let denom = r.cross(s);
    if denom.abs() < 1e-14 {
        return None;
    }
    let t = (q1 - p1).cross(s) / denom;
    let u = (q1 - p1).cross(r) / denom;
    if (-1e-9..=1.0 + 1e-9).contains(&t) && (-1e-9..=1.0 + 1e-9).contains(&u) {
        Some((t, p1 + r * t))
    } else {
        None
    }
}

/// True when the straight segment a→b stays inside the region (tested by
/// crossing count and midpoint containment).
pub fn segment_inside(rings: &[Ring], a: Point, b: Point) -> bool {
    for ring in rings {
        let n = ring.len();
        for i in 0..n {
            if segments_intersect(a, b, ring[i], ring[(i + 1) % n]) {
                return false;
            }
        }
    }
    point_in_rings(a.lerp(b, 0.5), rings)
}

/// Shortest path along a ring's boundary between two points lying (nearly) on it.
pub fn ring_path(ring: &[Point], a: Point, b: Point) -> Vec<Point> {
    let mut closed: Vec<Point> = ring.to_vec();
    if let Some(f) = ring.first() {
        closed.push(*f);
    }
    let cum = cumulative_lengths(&closed);
    let total = *cum.last().unwrap_or(&0.0);
    let (da, _) = project(&closed, &cum, a);
    let (db, _) = project(&closed, &cum, b);
    let forward = if db >= da { db - da } else { total - da + db };
    let mut out = vec![a];
    if forward <= total - forward {
        // walk forward
        if db >= da {
            out.extend(substring(&closed, &cum, da, db));
        } else {
            out.extend(substring(&closed, &cum, da, total));
            out.extend(substring(&closed, &cum, 0.0, db));
        }
    } else if da >= db {
        let mut s = substring(&closed, &cum, db, da);
        s.reverse();
        out.extend(s);
    } else {
        let mut s1 = substring(&closed, &cum, 0.0, da);
        s1.reverse();
        let mut s2 = substring(&closed, &cum, db, total);
        s2.reverse();
        out.extend(s1);
        out.extend(s2);
    }
    out.push(b);
    dedup(&mut out, 1e-6);
    out
}

/// The parts of a polyline inside a region (SVG clip paths on lines).
pub fn clip_polyline(path: &[Point], rings: &[Ring]) -> Vec<Vec<Point>> {
    if path.len() < 2 || rings.is_empty() {
        return vec![];
    }
    let mut out: Vec<Vec<Point>> = Vec::new();
    let mut cur: Vec<Point> = Vec::new();
    if point_in_rings(path[0], rings) {
        cur.push(path[0]);
    }
    for w in path.windows(2) {
        let mut ts: Vec<f64> = vec![0.0, 1.0];
        for ring in rings {
            let n = ring.len();
            for i in 0..n {
                if let Some((t, _)) = segment_intersection(w[0], w[1], ring[i], ring[(i + 1) % n]) {
                    ts.push(t.clamp(0.0, 1.0));
                }
            }
        }
        ts.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        ts.dedup_by(|b, a| (*a - *b).abs() < 1e-9);
        for k in 0..ts.len() - 1 {
            let (a, b) = (w[0].lerp(w[1], ts[k]), w[0].lerp(w[1], ts[k + 1]));
            if point_in_rings(a.lerp(b, 0.5), rings) {
                if cur.is_empty() {
                    cur.push(a);
                }
                cur.push(b);
            } else if cur.len() >= 2 {
                out.push(std::mem::take(&mut cur));
            } else {
                cur.clear();
            }
        }
    }
    if cur.len() >= 2 {
        out.push(cur);
    }
    for p in &mut out {
        dedup(p, 1e-6);
    }
    out.retain(|p| p.len() >= 2);
    out
}

/// Constrain a path to a region (Ink/Stitch `clamp_path_to_polygon`): where
/// it leaves the region it follows the boundary instead, to where it comes
/// back in. A path starting outside begins where it first enters.
pub fn clamp_to_rings(path: &[Point], rings: &[Ring]) -> Vec<Point> {
    if path.len() < 2 || rings.is_empty() {
        return path.to_vec();
    }
    let mut out: Vec<Point> = Vec::with_capacity(path.len());
    let mut inside = point_in_rings(path[0], rings);
    let mut exit: Option<(usize, Point)> = None;
    if inside {
        out.push(path[0]);
    }
    for w in path.windows(2) {
        let mut xs: Vec<(f64, Point, usize)> = Vec::new();
        for (ri, ring) in rings.iter().enumerate() {
            let n = ring.len();
            for i in 0..n {
                if let Some((t, p)) = segment_intersection(w[0], w[1], ring[i], ring[(i + 1) % n]) {
                    xs.push((t, p, ri));
                }
            }
        }
        xs.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
        // a crossing through a ring vertex is found on both of its edges
        xs.dedup_by(|b, a| (a.0 - b.0).abs() < 1e-9 && a.2 == b.2);
        for (_, p, ri) in xs {
            if inside {
                out.push(p);
                exit = Some((ri, p));
                inside = false;
            } else {
                match exit.take() {
                    Some((er, ep)) if er == ri => out.extend(ring_path(&rings[ri], ep, p).into_iter().skip(1)),
                    _ => out.push(p),
                }
                inside = true;
            }
        }
        if inside {
            out.push(w[1]);
        }
    }
    dedup(&mut out, 1e-6);
    if out.len() < 2 {
        path.to_vec()
    } else {
        out
    }
}

/// Index of the ring closest to point p and the distance.
pub fn nearest_ring(rings: &[Ring], p: Point) -> Option<(usize, f64)> {
    let mut best: Option<(usize, f64)> = None;
    for (i, r) in rings.iter().enumerate() {
        let mut closed = r.clone();
        if let Some(f) = r.first() {
            closed.push(*f);
        }
        let cum = cumulative_lengths(&closed);
        let (_, d) = project(&closed, &cum, p);
        if best.map_or(true, |b| d < b.1) {
            best = Some((i, d));
        }
    }
    best
}

// ---------------------------------------------------------------------------
// Polygon offsetting (inset/outset) via a signed Euclidean distance field.
// The region is rasterised at a fine resolution, an exact EDT
// (Felzenszwalb & Huttenlocher) gives distance to the boundary, and contours
// at any threshold are traced and simplified. Robust for self-touching input
// and holes, and one field serves many inset levels (contour fills).
// ---------------------------------------------------------------------------

/// Distance from point to the region boundary.
pub fn dist_to_boundary(rings: &[Ring], p: Point) -> f64 {
    let mut best = f64::INFINITY;
    for ring in rings {
        let n = ring.len();
        for i in 0..n {
            let a = ring[i];
            let b = ring[(i + 1) % n];
            let ab = b - a;
            let l2 = ab.length_sq();
            let t = if l2 < 1e-18 { 0.0 } else { ((p - a).dot(ab) / l2).clamp(0.0, 1.0) };
            best = best.min((a + ab * t).dist(p));
        }
    }
    best
}

/// 1-D squared distance transform (Felzenszwalb & Huttenlocher 2012).
fn edt_1d(f: &[f64], d: &mut [f64], v: &mut [usize], z: &mut [f64]) {
    let n = f.len();
    if n == 0 {
        return;
    }
    const INF: f64 = 1e20;
    let mut k = 0usize;
    v[0] = 0;
    z[0] = -INF;
    z[1] = INF;
    for q in 1..n {
        loop {
            let p = v[k];
            let s = ((f[q] + (q * q) as f64) - (f[p] + (p * p) as f64)) / (2.0 * (q as f64 - p as f64));
            if s <= z[k] && k > 0 {
                k -= 1;
                continue;
            }
            if s <= z[k] {
                // k == 0: replace the first parabola
                v[0] = q;
                z[0] = -INF;
                z[1] = INF;
                break;
            }
            k += 1;
            v[k] = q;
            z[k] = s;
            z[k + 1] = INF;
            break;
        }
    }
    k = 0;
    for q in 0..n {
        while z[k + 1] < q as f64 {
            k += 1;
        }
        let dq = q as f64 - v[k] as f64;
        d[q] = dq * dq + f[v[k]];
    }
}

/// Squared EDT in cell units: distance from each cell to the nearest `target` cell.
pub(crate) fn edt_2d(target: &[bool], w: usize, h: usize) -> Vec<f32> {
    let mut g: Vec<f64> = target.iter().map(|t| if *t { 0.0 } else { 1e20 }).collect();
    let n = w.max(h);
    let (mut f, mut d, mut v, mut z) = (vec![0f64; n], vec![0f64; n], vec![0usize; n], vec![0f64; n + 1]);
    for x in 0..w {
        for y in 0..h {
            f[y] = g[y * w + x];
        }
        edt_1d(&f[..h], &mut d[..h], &mut v, &mut z);
        for y in 0..h {
            g[y * w + x] = d[y];
        }
    }
    for y in 0..h {
        f[..w].copy_from_slice(&g[y * w..y * w + w]);
        edt_1d(&f[..w], &mut d[..w], &mut v, &mut z);
        g[y * w..y * w + w].copy_from_slice(&d[..w]);
    }
    g.into_iter().map(|x| x.min(1e30) as f32).collect()
}

/// Signed distance field of an even-odd region (positive inside, mm).
pub struct DistanceField {
    pub w: usize,
    pub h: usize,
    pub origin: Point,
    pub res: f64,
    pub sd: Vec<f32>,
}

impl DistanceField {
    pub fn new(rings: &[Ring], resolution: f64, pad: f64) -> Option<DistanceField> {
        let b = rings_bounds(rings);
        if b.is_empty() {
            return None;
        }
        let mut res = resolution.max(0.01);
        let pad = pad.max(0.0) + res * 2.0;
        let (mut w, mut h);
        loop {
            w = ((b.width() + 2.0 * pad) / res).ceil() as usize + 1;
            h = ((b.height() + 2.0 * pad) / res).ceil() as usize + 1;
            if w * h <= 8_000_000 {
                break;
            }
            res *= 1.5;
        }
        let ox = b.min_x - pad;
        let oy = b.min_y - pad;
        let mut inside = vec![false; w * h];
        for j in 0..h {
            let y = oy + (j as f64 + 0.5) * res;
            let spans = scanline(rings, y);
            for (a, c) in spans {
                let i0 = ((a - ox) / res - 0.5).ceil().max(0.0) as usize;
                let i1 = (((c - ox) / res - 0.5).floor().max(-1.0) + 1.0) as usize;
                for i in i0..i1.min(w) {
                    inside[j * w + i] = true;
                }
            }
        }
        let outside: Vec<bool> = inside.iter().map(|x| !x).collect();
        let d_in = edt_2d(&outside, w, h); // for inside cells: distance to outside
        let d_out = edt_2d(&inside, w, h); // for outside cells: distance to inside
        let half = 0.5f32;
        let r = res as f32;
        let sd = (0..w * h)
            .map(|k| if inside[k] { (d_in[k].sqrt() - half) * r } else { -(d_out[k].sqrt() - half) * r })
            .collect();
        Some(DistanceField { w, h, origin: pt(ox, oy), res, sd })
    }

    /// Contours of { sd > threshold } (threshold > 0 = inset, < 0 = outset).
    pub fn contours(&self, threshold: f64) -> Vec<Ring> {
        let t = threshold as f32;
        let grid: Vec<bool> = self.sd.iter().map(|v| *v > t).collect();
        let mut traced = trace_contours(&grid, self.w, self.h);
        let res = self.res;
        for ring in traced.iter_mut() {
            for p in ring.iter_mut() {
                *p = pt(self.origin.x + p.x * res, self.origin.y + p.y * res);
            }
            *ring = simplify_ring(&chaikin_ring(ring, res * 0.75), res * 0.3);
        }
        traced.retain(|r| r.len() >= 3 && signed_area(r).abs() > res * res * 4.0);
        traced
    }
}

/// One round of Chaikin corner cutting (removes raster staircase).
pub(crate) fn chaikin_ring(ring: &[Point], max_cut: f64) -> Ring {
    let n = ring.len();
    if n < 3 {
        return ring.to_vec();
    }
    let mut out = Vec::with_capacity(n * 2);
    for i in 0..n {
        let a = ring[i];
        let b = ring[(i + 1) % n];
        let len = a.dist(b).max(1e-12);
        let t = (max_cut / len).min(0.25);
        out.push(a.lerp(b, t));
        out.push(a.lerp(b, 1.0 - t));
    }
    out
}

/// Offset region by `delta` (negative = inset) with round corners. Returns
/// even-odd rings. Exact (Clipper2); `_resolution` is kept for compatibility.
pub fn offset_rings(rings: &[Ring], delta: f64, _resolution: f64) -> Vec<Ring> {
    if delta.abs() < 1e-9 {
        return rings.to_vec();
    }
    crate::clip::rings(&crate::clip::offset(&crate::clip::region(rings), delta))
}

pub(crate) fn simplify_ring(ring: &[Point], tol: f64) -> Ring {
    if ring.len() < 4 {
        return ring.to_vec();
    }
    let mut closed = ring.to_vec();
    closed.push(ring[0]);
    let mut s = simplify(&closed, tol);
    s.pop();
    s
}

/// Trace the boundaries of a boolean grid with marching squares. Returns rings
/// in grid coordinates where cell (i,j) has its centre at (i+0.5, j+0.5).
pub fn trace_contours(grid: &[bool], w: usize, h: usize) -> Vec<Ring> {
    let at = |i: isize, j: isize| -> bool {
        if i < 0 || j < 0 || i >= w as isize || j >= h as isize {
            false
        } else {
            grid[j as usize * w + i as usize]
        }
    };
    // Edges between lattice corners. We walk cell-edge boundaries (crack following),
    // producing axis-aligned rings which are then smoothed by simplification.
    // Vertices are lattice corners (i, j) meaning top-left corner of cell (i,j).
    use std::collections::HashMap;
    let mut next: HashMap<(isize, isize), Vec<(isize, isize)>> = HashMap::new();
    for j in -1..h as isize {
        for i in -1..w as isize {
            let here = at(i, j);
            // horizontal edge between cell (i,j) and (i,j+1): from corner (i, j+1) to (i+1, j+1)
            let below = at(i, j + 1);
            if here != below && i >= 0 {
                // keep inside on the left (CCW in y-down => screen clockwise); consistent orientation
                if here {
                    next.entry((i + 1, j + 1)).or_default().push((i, j + 1));
                } else {
                    next.entry((i, j + 1)).or_default().push((i + 1, j + 1));
                }
            }
            let right = at(i + 1, j);
            if here != right && j >= 0 {
                if here {
                    next.entry((i + 1, j)).or_default().push((i + 1, j + 1));
                } else {
                    next.entry((i + 1, j + 1)).or_default().push((i + 1, j));
                }
            }
        }
    }
    let mut rings = Vec::new();
    let mut starts: Vec<(isize, isize)> = next.keys().copied().collect();
    starts.sort();
    for s in starts {
        loop {
            let first_next = match next.get_mut(&s).and_then(|v| v.pop()) {
                Some(n) => n,
                None => break,
            };
            let mut ring = vec![s];
            let mut cur = first_next;
            let mut guard = 0usize;
            while cur != s && guard < 10_000_000 {
                ring.push(cur);
                cur = match next.get_mut(&cur).and_then(|v| v.pop()) {
                    Some(n) => n,
                    None => break,
                };
                guard += 1;
            }
            // remove collinear points
            let pts: Vec<Point> = ring.iter().map(|(x, y)| pt(*x as f64, *y as f64)).collect();
            let mut out: Vec<Point> = Vec::with_capacity(pts.len());
            let n = pts.len();
            for k in 0..n {
                let a = pts[(k + n - 1) % n];
                let b = pts[k];
                let c = pts[(k + 1) % n];
                if (b - a).cross(c - b).abs() > 1e-9 {
                    out.push(b);
                }
            }
            if out.len() >= 3 {
                rings.push(out);
            }
        }
    }
    rings
}

#[cfg(test)]
mod tests {
    use super::*;

    fn square(s: f64) -> Ring {
        vec![pt(0.0, 0.0), pt(s, 0.0), pt(s, s), pt(0.0, s)]
    }

    #[test]
    fn scanline_square() {
        let spans = scanline(&[square(10.0)], 5.0);
        assert_eq!(spans.len(), 1);
        assert!((spans[0].0 - 0.0).abs() < 1e-9 && (spans[0].1 - 10.0).abs() < 1e-9);
    }

    #[test]
    fn inset_square() {
        let r = offset_rings(&[square(10.0)], -1.0, 0.05);
        assert_eq!(r.len(), 1);
        let a = signed_area(&r[0]).abs();
        assert!((a - 64.0).abs() < 2.0, "area {a}");
    }

    #[test]
    fn simplify_line() {
        let pts = vec![pt(0.0, 0.0), pt(1.0, 0.001), pt(2.0, 0.0)];
        assert_eq!(simplify(&pts, 0.01).len(), 2);
    }
}
