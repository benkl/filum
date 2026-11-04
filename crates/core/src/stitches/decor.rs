//! Decorative stitches: stem stitch and motif runs along lines, carved
//! (program split) tatami rows and cross stitch.

use crate::geom::{point_in_rings, pt, rings_bounds, rotate_rings, Point, Ring};
use crate::model::{CarvePattern, CrossKind, MotifKind};
use crate::plan::flags;

use super::running::running_stitch;
use super::Run;

/// A point at arc length `d` along a polyline and the unit direction there.
fn at_length(pts: &[Point], cum: &[f64], d: f64) -> (Point, Point) {
    let n = pts.len();
    let d = d.clamp(0.0, cum[n - 1]);
    let mut i = cum.partition_point(|&c| c <= d).saturating_sub(1).min(n - 2);
    while i + 1 < n - 1 && cum[i + 1] <= d {
        i += 1;
    }
    let seg = (cum[i + 1] - cum[i]).max(1e-12);
    let t = ((d - cum[i]) / seg).clamp(0.0, 1.0);
    let dir = (pts[i + 1] - pts[i]).unit();
    (pts[i] + (pts[i + 1] - pts[i]) * t, dir)
}

fn cumulative(pts: &[Point]) -> Vec<f64> {
    let mut cum = vec![0.0; pts.len()];
    for i in 1..pts.len() {
        cum[i] = cum[i - 1] + pts[i].dist(pts[i - 1]);
    }
    cum
}

/// Stem stitch: every stitch slants across the line and starts half way
/// back along the one before, so the stitches overlap into a rope.
pub fn stem(pts: &[Point], length: f64, width: f64) -> Vec<Point> {
    if pts.len() < 2 {
        return pts.to_vec();
    }
    let cum = cumulative(pts);
    let total = cum[cum.len() - 1];
    let half = (length.max(0.6)) / 2.0;
    let n = (total / half).ceil().max(2.0) as usize;
    let step = total / n as f64;
    let side = width.max(0.0) / 2.0;
    // positions every half stitch; a stitch goes from k (one side) to k + 2 (the other)
    let pos = |k: usize, s: f64| {
        let (p, d) = at_length(pts, &cum, k as f64 * step);
        p + d.perp() * s
    };
    let mut out = vec![pos(0, -side)];
    let mut k = 0;
    while k + 2 <= n {
        out.push(pos(k + 2, side));
        if k + 3 <= n {
            out.push(pos(k + 1, -side));
        }
        k += 1;
    }
    out
}

/// One motif in local coordinates: x along the line 0..1, y across it -0.5..0.5.
fn motif_shape(kind: MotifKind) -> Vec<(f64, f64)> {
    match kind {
        MotifKind::Wave => (0..=12).map(|i| {
            let t = i as f64 / 12.0;
            (t, 0.35 * (t * std::f64::consts::TAU).sin())
        }).collect(),
        MotifKind::Zigzag => vec![(0.0, 0.0), (0.25, 0.4), (0.75, -0.4), (1.0, 0.0)],
        MotifKind::Scallop => (0..=10).map(|i| {
            let t = i as f64 / 10.0;
            (t, -0.45 * (t * std::f64::consts::PI).sin())
        }).collect(),
        MotifKind::Loop => (0..=16).map(|i| {
            let a = i as f64 / 16.0 * std::f64::consts::TAU;
            // a loop over the line, moving forward
            (i as f64 / 16.0 + 0.3 * a.sin(), -0.35 * (1.0 - a.cos()))
        }).collect(),
        MotifKind::Diamond => vec![(0.0, 0.0), (0.5, -0.4), (1.0, 0.0), (0.5, 0.4), (0.0, 0.0), (1.0, 0.0)],
        MotifKind::Cross => vec![(0.0, 0.0), (0.3, 0.0), (0.7, 0.4), (0.5, 0.0), (0.3, 0.4), (0.7, 0.0), (1.0, 0.0)],
    }
}

/// Motif run: the motif repeated along the line, every point a penetration.
pub fn motif(pts: &[Point], kind: MotifKind, size: f64, length: f64) -> Vec<Point> {
    if pts.len() < 2 {
        return pts.to_vec();
    }
    let cum = cumulative(pts);
    let total = cum[cum.len() - 1];
    let size = size.max(1.0);
    let n = (total / size).round().max(1.0) as usize;
    let span = total / n as f64;
    let shape = motif_shape(kind);
    let mut path: Vec<Point> = Vec::new();
    for m in 0..n {
        for (k, &(x, y)) in shape.iter().enumerate() {
            if m > 0 && k == 0 {
                continue;
            }
            let (p, d) = at_length(pts, &cum, (m as f64 + x.clamp(-0.5, 1.5)) * span);
            path.push(p + d.perp() * (y * size));
        }
    }
    // long motif segments are split, short ones kept: the corners stay sharp
    let mut out = vec![path[0]];
    for w in path.windows(2) {
        let l = w[0].dist(w[1]);
        let k = (l / length.max(0.8)).ceil().max(1.0) as usize;
        for j in 1..=k {
            out.push(w[0] + (w[1] - w[0]) * (j as f64 / k as f64));
        }
    }
    out
}

/// Where the needle goes into a carved tatami row at `y` (rotated frame):
/// on the lines of the pattern, the gaps split evenly to at most `max_len`.
/// `phase` is the row's tatami stagger: the needle points between the pattern
/// lines keep the usual staggered texture, so only the pattern lines line up
/// into grooves.
pub fn carve_row(pattern: CarvePattern, size: f64, centre: Point, y: f64, x0: f64, x1: f64, max_len: f64, phase: f64) -> Vec<f64> {
    let p = size.max(1.0);
    let (a, b) = (x0.min(x1), x0.max(x1));
    let mut cuts: Vec<f64> = Vec::new();
    let mut family = |offset: f64| {
        // x = offset + k·p within (a, b)
        let k0 = ((a - offset) / p).ceil() as i64;
        let k1 = ((b - offset) / p).floor() as i64;
        for k in k0..=k1 {
            cuts.push(offset + k as f64 * p);
        }
    };
    match pattern {
        CarvePattern::None => {}
        CarvePattern::Diamonds => {
            family(y);
            family(-y);
        }
        CarvePattern::Waves => family(0.25 * p * (y / p * std::f64::consts::TAU).sin()),
        CarvePattern::Chevrons => family((y.rem_euclid(p) - p / 2.0).abs()),
        CarvePattern::Bricks => {
            let band = (y / (p / 2.0)).floor() as i64;
            family(if band.rem_euclid(2) == 1 { p / 2.0 } else { 0.0 });
        }
        CarvePattern::Circles => {
            let dy = y - centre.y;
            let kmax = (((b - centre.x).abs().max((a - centre.x).abs()).powi(2) + dy * dy).sqrt() / p).ceil() as i64;
            for k in 1..=kmax {
                let r = k as f64 * p;
                if r > dy.abs() {
                    let h = (r * r - dy * dy).sqrt();
                    for x in [centre.x - h, centre.x + h] {
                        if x > a && x < b {
                            cuts.push(x);
                        }
                    }
                }
            }
        }
    }
    cuts.retain(|x| *x > a + 0.3 && *x < b - 0.3);
    cuts.sort_by(|u, v| u.partial_cmp(v).unwrap());
    cuts.dedup_by(|u, v| (*u - *v).abs() < 0.3);
    // between the pattern lines: the staggered tatami grid, kept clear of the
    // lines (a point right beside a groove would blur it); gaps still longer
    // than a stitch are split evenly
    let len = max_len.max(0.5);
    let clear = (0.3 * len).clamp(0.4, 1.0);
    let mut stops = vec![a];
    stops.extend(cuts);
    stops.push(b);
    let mut out = Vec::new();
    for w in stops.windows(2) {
        let (g0, g1) = (w[0], w[1]);
        let mut pts = vec![g0];
        let mut x = ((g0 + clear - phase) / len).ceil() * len + phase;
        while x < g1 - clear {
            pts.push(x);
            x += len;
        }
        pts.push(g1);
        for v in pts.windows(2) {
            let k = ((v[1] - v[0]) / len - 1e-9).ceil().max(1.0) as usize;
            for j in 1..k {
                out.push(v[0] + (v[1] - v[0]) * (j as f64 / k as f64));
            }
            if v[1] < g1 {
                out.push(v[1]);
            }
        }
        if g1 < b {
            out.push(g1);
        }
    }
    out
}

/// Travel routes between the pieces of a cross stitch fill, on a lattice of
/// half cells (corners, edge middles and centres). Along a cross's own
/// stitches (its diagonals, an upright cross's bars) the travel lies on top
/// of the same thread and hardly shows; along a bare cell edge it shows; it
/// never leaves the stitched cells.
struct CrossRoutes {
    i0: i64,
    j0: i64,
    w: i64,
    h: i64,
    kind: CrossKind,
    flip: bool,
    cells: Vec<bool>,
}

impl CrossRoutes {
    fn new(i0: i64, i1: i64, j0: i64, j1: i64, kind: CrossKind, flip: bool, inside: impl Fn(i64, i64) -> bool) -> CrossRoutes {
        let (w, h) = ((i1 - i0).max(0), (j1 - j0).max(0));
        let mut cells = Vec::with_capacity((w * h) as usize);
        for j in j0..j1 {
            for i in i0..i1 {
                cells.push(inside(i, j));
            }
        }
        CrossRoutes { i0, j0, w, h, kind, flip, cells }
    }

    fn stitched(&self, i: i64, j: i64) -> bool {
        let (x, y) = (i - self.i0, j - self.j0);
        x >= 0 && y >= 0 && x < self.w && y < self.h && self.cells[(y * self.w + x) as usize]
    }

    /// Cost of the half-cell step from lattice node a to its neighbour b
    /// (lattice units: half cells), or None where the travel may not go.
    fn step(&self, a: (i64, i64), b: (i64, i64)) -> Option<f64> {
        let (dx, dy) = (b.0 - a.0, b.1 - a.1);
        if dx != 0 && dy != 0 {
            // half a diagonal: inside one cell, corner to centre
            let (ci, cj) = (a.0.min(b.0).div_euclid(2), a.1.min(b.1).div_euclid(2));
            if !self.stitched(ci, cj) {
                return None;
            }
            // the "\" diagonal when dx and dy have the same sign
            let back = dx.signum() == dy.signum();
            let sewn = match self.kind {
                CrossKind::Cross | CrossKind::Double | CrossKind::Smyrna => true,
                CrossKind::Half => back == self.flip,
                CrossKind::Upright => false,
            };
            return Some(std::f64::consts::SQRT_2 * if sewn { 0.1 } else { 1.5 });
        }
        // a straight half step: along a cell edge, or along a bar through a centre
        let along_x = dy == 0;
        let line = if along_x { a.1 } else { a.0 };
        let cell_along = if along_x { a.0.min(b.0) } else { a.1.min(b.1) }.div_euclid(2);
        if line.rem_euclid(2) == 1 {
            // through the middle of a cell: an upright cross's bar
            let c = line.div_euclid(2);
            let (ci, cj) = if along_x { (cell_along, c) } else { (c, cell_along) };
            if !self.stitched(ci, cj) {
                return None;
            }
            let sewn = matches!(self.kind, CrossKind::Upright | CrossKind::Double | CrossKind::Smyrna);
            return Some(if sewn { 0.1 } else { 1.5 });
        }
        // on a cell edge: only beside a stitched cell, and it shows
        let c = line.div_euclid(2);
        let beside = if along_x {
            self.stitched(cell_along, c - 1) || self.stitched(cell_along, c)
        } else {
            self.stitched(c - 1, cell_along) || self.stitched(c, cell_along)
        };
        beside.then_some(1.0)
    }

    /// The cheapest route between two lattice points (half cells, snapped),
    /// when the part of it that shows is at most `max_visible` cells long.
    fn route(&self, from: (f64, f64), to: (f64, f64), max_visible: f64) -> Option<Vec<(i64, i64)>> {
        use std::cmp::Reverse;
        use std::collections::BinaryHeap;
        let snap = |p: (f64, f64)| (p.0.round() as i64, p.1.round() as i64);
        let (a, b) = (snap(from), snap(to));
        if a == b {
            return Some(vec![a, b]);
        }
        let (x0, y0) = (self.i0 * 2, self.j0 * 2);
        let (nw, nh) = (self.w * 2 + 1, self.h * 2 + 1);
        let idx = |p: (i64, i64)| -> Option<usize> {
            let (x, y) = (p.0 - x0, p.1 - y0);
            (x >= 0 && y >= 0 && x < nw && y < nh).then_some((y * nw + x) as usize)
        };
        let node = |u: usize| ((u as i64 % nw) + x0, (u as i64 / nw) + y0);
        let (ia, ib) = (idx(a)?, idx(b)?);
        let mut dist = vec![f64::INFINITY; (nw * nh) as usize];
        let mut prev = vec![usize::MAX; (nw * nh) as usize];
        let mut heap = BinaryHeap::new();
        let key = |d: f64| (d * 1000.0) as u64;
        dist[ia] = 0.0;
        heap.push(Reverse((0u64, ia)));
        while let Some(Reverse((dk, u))) = heap.pop() {
            if u == ib {
                break;
            }
            if dk > key(dist[u]) {
                continue;
            }
            let p = node(u);
            for (dx, dy) in [(1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (1, -1), (-1, 1), (-1, -1)] {
                let q = (p.0 + dx, p.1 + dy);
                let Some(v) = idx(q) else { continue };
                let Some(c) = self.step(p, q) else { continue };
                let nd = dist[u] + c;
                if nd < dist[v] - 1e-9 {
                    dist[v] = nd;
                    prev[v] = u;
                    heap.push(Reverse((key(nd), v)));
                }
            }
        }
        if !dist[ib].is_finite() {
            return None;
        }
        let mut path = vec![b];
        let mut u = ib;
        while u != ia {
            u = prev[u];
            path.push(node(u));
        }
        path.reverse();
        // what shows: the steps off the crosses' own stitches (half cells to cells)
        let visible: f64 = path.windows(2).filter_map(|w| self.step(w[0], w[1])).filter(|c| *c > 0.5).sum::<f64>() / 2.0;
        (visible <= max_visible).then_some(path)
    }
}

/// Cross stitch over the shape: a grid of cells (rotated by `angle_deg`),
/// every cell at least `coverage` inside gets its cross; rows are sewn one
/// way and back (the second diagonals on the way back).
pub fn cross(rings: &[Ring], angle_deg: f64, size: f64, coverage: f64, kind: CrossKind, travel_len: f64, start: Option<Point>, f: u8) -> Vec<Run> {
    cross_grid(rings, angle_deg, size, coverage, kind, true, [0.0, 0.0], travel_len, start, f)
}

/// Cross stitch with Ink/Stitch's grid placement: on the page (`canvas`) or
/// on the shape's own top-left corner, shifted by `offset` (mm; Ink/Stitch
/// `CrossGeometries._get_offset_values`: x to the left, y down).
#[allow(clippy::too_many_arguments)]
pub fn cross_grid(rings: &[Ring], angle_deg: f64, size: f64, coverage: f64, kind: CrossKind, canvas: bool, offset: [f64; 2], travel_len: f64, start: Option<Point>, f: u8) -> Vec<Run> {
    cross_full(rings, angle_deg, size, coverage, kind, canvas, offset, false, 1, travel_len, start, f)
}

/// Cross stitch with Ink/Stitch's flipped variants (the other diagonal
/// first) and thread count (every diagonal sewn 1, 3, 5 … times).
#[allow(clippy::too_many_arguments)]
pub fn cross_full(rings: &[Ring], angle_deg: f64, size: f64, coverage: f64, kind: CrossKind, canvas: bool, offset: [f64; 2], flip: bool, threads: u32, travel_len: f64, start: Option<Point>, f: u8) -> Vec<Run> {
    cross_full_ex(rings, angle_deg, size, coverage, kind, canvas, offset, flip, threads, travel_len, start, &CrossOpts::default(), f)
}

/// Cross stitch options beyond the grid (Ink/Stitch cross stitch fill).
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct CrossOpts {
    /// Cell height (mm; 0 = square cells). Ink/Stitch `pattern_size_mm` "x y".
    pub size_y: f64,
    /// Upright crosses on a second grid shifted by half a cell too
    /// (Ink/Stitch's dense upright cross).
    pub dense: bool,
    /// Split stitches longer than this (mm; 0 = never). Ink/Stitch
    /// `max_cross_stitch_length_mm`.
    pub max_len: f64,
}

/// One row piece of crosses, in cell units (u = column, v = row): the
/// stitches of cells `first..=last` of row `j`, sewn there and back.
fn cross_row(kind: CrossKind, flip: bool, first: f64, last: f64, j: f64) -> Vec<(f64, f64)> {
    let mut pts: Vec<(f64, f64)> = Vec::new();
    // flipped: the corners top and bottom swapped (the other diagonal first)
    let (y0, y1) = if flip { (1.0, 0.0) } else { (0.0, 1.0) };
    let n = (last - first).round() as i64;
    let cells = || (0..=n).map(move |k| first + k as f64);
    let c = |u: f64, x: f64, y: f64| (u + x, j + y);
    match kind {
        CrossKind::Cross | CrossKind::Smyrna => {
            // there: one diagonal, up the cell edges; back: the other diagonal
            pts.push(c(first, 0.0, y0));
            for k in cells() {
                pts.push(c(k, 1.0, y1));
                pts.push(c(k, 1.0, y0));
            }
            for k in cells().rev() {
                pts.push(c(k, 0.0, y1));
                pts.push(c(k, 0.0, y0));
            }
            if kind == CrossKind::Smyrna {
                // the upright cross on top (Ink/Stitch's smyrna cross)
                pts.push(c(first, 0.0, 0.5));
                for k in cells() {
                    pts.push(c(k, 1.0, 0.5));
                }
                for k in cells().rev() {
                    pts.push(c(k, 0.5, 0.5));
                    pts.push(c(k, 0.5, 0.0));
                    pts.push(c(k, 0.5, 1.0));
                    pts.push(c(k, 0.5, 0.5));
                }
            }
        }
        CrossKind::Half => {
            pts.push(c(first, 0.0, y1));
            for k in cells() {
                pts.push(c(k, 1.0, y0));
                pts.push(c(k, 1.0, y1));
            }
        }
        CrossKind::Upright => {
            // the bars across, then the uprights on the way back
            pts.push(c(first, 0.0, 0.5));
            for k in cells() {
                pts.push(c(k, 1.0, 0.5));
            }
            for k in cells().rev() {
                pts.push(c(k, 0.5, 0.5));
                pts.push(c(k, 0.5, 0.0));
                pts.push(c(k, 0.5, 1.0));
                pts.push(c(k, 0.5, 0.5));
            }
        }
        CrossKind::Double => {
            // Ink/Stitch's double cross, cell by cell: one diagonal, the bar
            // across, the upright, then the other diagonal on top
            pts.push(c(first, 0.0, y0));
            for k in cells() {
                pts.push(c(k, 1.0, y1));
                pts.push(c(k, 0.5, 0.5));
                pts.push(c(k, 0.0, 0.5));
                pts.push(c(k, 1.0, 0.5));
                pts.push(c(k, 0.5, 0.5));
                pts.push(c(k, 0.5, 0.0));
                pts.push(c(k, 0.5, 1.0));
                pts.push(c(k, 0.5, 0.5));
                pts.push(c(k, 0.0, y1));
                pts.push(c(k, 1.0, y0));
            }
        }
    }
    pts
}

/// Cross stitch with every option: see [`cross_full`] and [`CrossOpts`].
#[allow(clippy::too_many_arguments)]
pub fn cross_full_ex(rings: &[Ring], angle_deg: f64, size: f64, coverage: f64, kind: CrossKind, canvas: bool, offset: [f64; 2], flip: bool, threads: u32, travel_len: f64, start: Option<Point>, o: &CrossOpts, f: u8) -> Vec<Run> {
    if rings.is_empty() {
        return vec![];
    }
    let a = angle_deg.to_radians();
    let shape_b = rings_bounds(&rotate_rings(rings, a));
    // the grid origin: whole cells from the page origin, or the shape's corner
    let origin = if canvas { pt(-offset[0], offset[1]) } else { pt(shape_b.min_x - offset[0], shape_b.min_y + offset[1]) };
    // work in a frame where the grid starts at 0
    let rr: Vec<Ring> = rotate_rings(rings, a).into_iter().map(|r| r.into_iter().map(|q| q - origin).collect()).collect();
    let b = rings_bounds(&rr);
    let sx = size.max(0.8);
    let sy = if o.size_y > 0.0 { o.size_y.max(0.8) } else { sx };
    let (i0, i1) = ((b.min_x / sx).floor() as i64, (b.max_x / sx).ceil() as i64);
    let (j0, j1) = ((b.min_y / sy).floor() as i64, (b.max_y / sy).ceil() as i64);
    let cov = coverage.clamp(0.05, 1.0);
    // a cell at (u, v) cell units (its top-left corner)
    let inside_at = |u: f64, v: f64| {
        let mut n = 0;
        for p in 0..3 {
            for q in 0..3 {
                if point_in_rings(pt((u + (p as f64 + 0.5) / 3.0) * sx, (v + (q as f64 + 0.5) / 3.0) * sy), &rr) {
                    n += 1;
                }
            }
        }
        n as f64 / 9.0 >= cov - 1e-9
    };
    let inside = |i: i64, j: i64| inside_at(i as f64, j as f64);
    let back = |q: Point| (q + origin).rotate(-a);
    let world = |(u, v): (f64, f64)| back(pt(u * sx, v * sy));
    // thread count: every diagonal sewn back and forth (odd counts keep the direction)
    let n = threads.max(1) | 1;
    let thicken = |pts: Vec<(f64, f64)>| -> Vec<(f64, f64)> {
        if n == 1 || pts.len() < 2 {
            return pts;
        }
        let mut out = vec![pts[0]];
        for w in pts.windows(2) {
            let (du, dv) = (w[1].0 - w[0].0, w[1].1 - w[0].1);
            if (du.abs() - dv.abs()).abs() < 1e-6 && du.abs() > 1e-6 {
                for _ in 0..(n - 1) / 2 {
                    out.push(w[1]);
                    out.push(w[0]);
                }
            }
            out.push(w[1]);
        }
        out
    };
    // the grids: the cells, and for dense upright crosses a second grid
    // shifted by half a cell
    let mut grids = vec![(0.0, 0.0)];
    if o.dense && kind == CrossKind::Upright {
        grids.push((-0.5, -0.5));
    }
    // every run of neighbouring cells in a row is one piece
    let mut pieces: Vec<Vec<Point>> = Vec::new();
    for &(ou, ov) in &grids {
        let extra = if ou != 0.0 { 1 } else { 0 };
        for j in j0..j1 + extra {
            let v = j as f64 + ov;
            let mut i = i0;
            while i < i1 + extra {
                if !inside_at(i as f64 + ou, v) {
                    i += 1;
                    continue;
                }
                let first = i;
                while i < i1 + extra && inside_at(i as f64 + ou, v) {
                    i += 1;
                }
                let last = i - 1;
                let cells = thicken(cross_row(kind, flip, first as f64 + ou, last as f64 + ou, v));
                let mut pts: Vec<Point> = cells.into_iter().map(world).collect();
                if o.max_len > 0.0 {
                    pts = super::running::split_long(&pts, o.max_len);
                }
                if pts.len() >= 2 {
                    pieces.push(pts);
                }
            }
        }
    }
    // sew order: the nearest piece next, joined by travel over the crosses'
    // own stitches (see CrossRoutes), or by a jump
    let routes = CrossRoutes::new(i0, i1, j0, j1, kind, flip, inside);
    let lattice = |q: Point| {
        let r = q.rotate(a) - origin;
        (r.x / sx * 2.0, r.y / sy * 2.0)
    };
    let mut runs: Vec<Run> = Vec::new();
    let mut run: Run = Vec::new();
    let mut pos = start;
    let mut left = pieces;
    while !left.is_empty() {
        let k = match pos {
            Some(p) => (0..left.len()).min_by(|&x, &y| left[x][0].dist(p).partial_cmp(&left[y][0].dist(p)).unwrap()).unwrap(),
            None => 0,
        };
        let piece = left.remove(k);
        if let Some(&(from, _)) = run.last() {
            match routes.route(lattice(from), lattice(piece[0]), 2.0) {
                Some(path) => {
                    let pts: Vec<Point> = path.iter().map(|&(u, v)| world((u as f64 / 2.0, v as f64 / 2.0))).collect();
                    for q in running_stitch(&pts, travel_len, 0.1).into_iter().skip(1) {
                        run.push((q, flags::TRAVEL));
                    }
                }
                None => runs.push(std::mem::take(&mut run)),
            }
        }
        for q in &piece {
            if run.last().is_none_or(|(l, _)| l.dist(*q) > 1e-6) {
                run.push((*q, f));
            }
        }
        pos = run.last().map(|x| x.0);
    }
    if !run.is_empty() {
        runs.push(run);
    }
    runs.retain(|r| r.len() > 1);
    runs
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line() -> Vec<Point> {
        vec![pt(0.0, 0.0), pt(40.0, 0.0)]
    }

    #[test]
    fn stem_overlaps_and_slants() {
        let s = stem(&line(), 3.0, 1.0);
        // stitches go forward two half-steps and come back one: more points than a run
        assert!(s.len() > 2 * (40.0f64 / 3.0) as usize, "{}", s.len());
        // both sides of the line are used
        assert!(s.iter().any(|p| p.y > 0.4) && s.iter().any(|p| p.y < -0.4));
        // every forward stitch is about one stitch length
        let fwd = s[0].dist(s[1]);
        assert!((2.5..4.0).contains(&fwd), "{fwd}");
    }

    #[test]
    fn motifs_repeat_along_the_line() {
        for kind in [MotifKind::Wave, MotifKind::Zigzag, MotifKind::Scallop, MotifKind::Loop, MotifKind::Diamond, MotifKind::Cross] {
            let m = motif(&line(), kind, 4.0, 2.0);
            let xmax = m.iter().map(|p| p.x).fold(f64::MIN, f64::max);
            let ymax = m.iter().map(|p| p.y.abs()).fold(0.0, f64::max);
            assert!(xmax > 38.0 && ymax > 0.8 && ymax < 3.0, "{kind:?}: {xmax} {ymax}");
            assert!(m.windows(2).all(|w| w[0].dist(w[1]) <= 2.0 + 1e-6), "{kind:?}: stitches at most the length");
        }
    }

    #[test]
    fn carved_rows_put_needles_on_the_pattern() {
        // diamonds of 6 mm: on the row at y = 2 the lines x = 2 + 6k and x = −2 + 6k
        let xs = carve_row(CarvePattern::Diamonds, 6.0, pt(0.0, 0.0), 2.0, 0.0, 30.0, 4.0, 1.3);
        for want in [2.0, 4.0, 8.0, 10.0, 14.0, 16.0] {
            assert!(xs.iter().any(|x| (x - want).abs() < 1e-9), "{want} in {xs:?}");
        }
        assert!(xs.windows(2).all(|w| w[1] - w[0] <= 4.0 + 1e-9));
    }

    #[test]
    fn cross_stitch_travels_over_its_own_diagonals() {
        // a ring: rows break at the hole, so pieces need joining
        let outer: Vec<Point> = (0..64).map(|k| { let a = k as f64 / 64.0 * std::f64::consts::TAU; pt(20.0 + 18.0 * a.cos(), 20.0 + 14.0 * a.sin()) }).collect();
        let inner: Vec<Point> = (0..32).rev().map(|k| { let a = k as f64 / 32.0 * std::f64::consts::TAU; pt(20.0 + 6.0 * a.cos(), 20.0 + 5.0 * a.sin()) }).collect();
        let rings = vec![outer, inner];
        let runs = cross(&rings, 0.0, 2.5, 0.5, CrossKind::Cross, 2.5, None, 0);
        let (mut diag, mut other) = (0.0, 0.0);
        for r in &runs {
            for w in r.windows(2).filter(|w| w[1].1 & flags::TRAVEL != 0) {
                let d = w[1].0 - w[0].0;
                if (d.x.abs() - d.y.abs()).abs() < 1e-6 { diag += d.length() } else { other += d.length() }
            }
        }
        assert!(diag > 0.0 && other <= 0.25 * (diag + other), "on the diagonals {diag:.1} mm, elsewhere {other:.1} mm");
        // nothing outside the stitched cells
        let pts: Vec<Point> = runs.iter().flatten().map(|x| x.0).collect();
        assert!(pts.iter().all(|q| q.x > 0.0 && q.x < 40.0 && q.y > 3.0 && q.y < 37.0));
    }

    #[test]
    fn a_shape_grid_stitches_the_same_anywhere() {
        // Ink/Stitch canvas_grid_origin = False: moved by a fraction of a cell,
        // the crosses move with the shape (cross-stitch fonts)
        let sq = |x: f64| vec![vec![pt(x, 0.0), pt(x + 10.0, 0.0), pt(x + 10.0, 10.0), pt(x, 10.0)]];
        let pts = |x: f64, canvas: bool| -> Vec<Point> { cross_grid(&sq(x), 0.0, 2.0, 0.5, CrossKind::Cross, canvas, [0.0, 0.0], 2.5, None, 0).iter().flatten().map(|s| s.0 - pt(x, 0.0)).collect() };
        let (a, b) = (pts(0.0, false), pts(0.7, false));
        assert_eq!(a.len(), b.len());
        assert!(a.iter().zip(&b).all(|(p, q)| p.dist(*q) < 1e-6), "shape grid: same stitches");
        // on the page grid the pattern shifts against the shape
        let (c, d) = (pts(0.0, true), pts(0.7, true));
        assert!(c.len() != d.len() || c.iter().zip(&d).any(|(p, q)| p.dist(*q) > 0.1));
        // the shape grid starts at the shape's corner: 5 × 5 whole cells
        let n = cross_grid(&sq(0.7), 0.0, 2.0, 0.5, CrossKind::Cross, false, [0.0, 0.0], 2.5, None, 0).iter().flatten().filter(|s| s.1 & flags::TRAVEL == 0).count();
        assert!(n > 0);
    }

    #[test]
    fn cross_stitch_fills_the_cells_inside() {
        let sq = vec![vec![pt(0.0, 0.0), pt(20.0, 0.0), pt(20.0, 20.0), pt(0.0, 20.0)]];
        let runs = cross(&sq, 0.0, 2.5, 0.5, CrossKind::Cross, 2.5, None, 0);
        let pts: Vec<Point> = runs.iter().flatten().map(|x| x.0).collect();
        assert!(!pts.is_empty());
        // all on the grid, all inside
        assert!(pts.iter().all(|p| (p.x / 1.25).fract().abs() < 1e-6 && p.x >= -1e-6 && p.x <= 20.0 + 1e-6));
        // 8 × 8 cells, two diagonals each
        let diag = runs.iter().flat_map(|r| r.windows(2)).filter(|w| w[1].1 == 0 && (w[0].0.dist(w[1].0) - 2.5 * 2f64.sqrt()).abs() < 1e-6).count();
        assert_eq!(diag, 128);
    }
}

#[cfg(test)]
mod cross_variant_tests {
    use super::*;

    #[test]
    fn flipped_and_thread_count() {
        let sq = vec![vec![pt(0.0, 0.0), pt(10.0, 0.0), pt(10.0, 10.0), pt(0.0, 10.0)]];
        let run = |flip: bool, n: u32| cross_full(&sq, 0.0, 2.5, 0.5, CrossKind::Cross, true, [0.0, 0.0], flip, n, 2.5, None, 0);
        let first_diag = |r: &Vec<Run>| { let p: Vec<Point> = r.iter().flatten().map(|x| x.0).collect(); p.windows(2).map(|w| w[1] - w[0]).find(|d| (d.x.abs() - d.y.abs()).abs() < 1e-6 && d.length() > 1e-6).unwrap() };
        let (a, b) = (first_diag(&run(false, 1)), first_diag(&run(true, 1)));
        assert!(a.x * a.y > 0.0 && b.x * b.y < 0.0, "plain first, then flipped: {a:?} {b:?}");
        let count = |r: &Vec<Run>| r.iter().map(|x| x.len()).sum::<usize>();
        // each cell: two diagonals (tripled) and two edge moves — about twice the stitches
        assert!(count(&run(false, 3)) as f64 > count(&run(false, 1)) as f64 * 1.6, "three threads");
    }
}

#[cfg(test)]
mod cross_option_tests {
    use super::*;

    fn sq(s: f64) -> Vec<Ring> {
        vec![vec![pt(0.0, 0.0), pt(s, 0.0), pt(s, s), pt(0.0, s)]]
    }
    fn sewn(kind: CrossKind, o: &CrossOpts) -> Vec<Point> {
        cross_full_ex(&sq(12.0), 0.0, 3.0, 0.5, kind, true, [0.0, 0.0], false, 1, 2.5, None, o, 0).into_iter().flatten().filter(|x| x.1 & flags::TRAVEL == 0).map(|x| x.0).collect()
    }

    #[test]
    fn cells_can_be_taller_than_wide() {
        let tall = sewn(CrossKind::Cross, &CrossOpts { size_y: 6.0, ..Default::default() });
        let ys: std::collections::BTreeSet<i64> = tall.iter().map(|p| (p.y * 100.0).round() as i64).collect();
        assert_eq!(ys.into_iter().collect::<Vec<_>>(), vec![0, 600, 1200], "rows every 6 mm");
        let xs: std::collections::BTreeSet<i64> = tall.iter().map(|p| (p.x * 100.0).round() as i64).collect();
        assert_eq!(xs.len(), 5, "columns every 3 mm");
    }

    #[test]
    fn dense_upright_adds_a_shifted_grid() {
        let plain = sewn(CrossKind::Upright, &CrossOpts::default());
        let dense = sewn(CrossKind::Upright, &CrossOpts { dense: true, ..Default::default() });
        assert!(dense.len() > plain.len() * 3 / 2, "{} vs {}", dense.len(), plain.len());
        // the second grid's centres sit on the first grid's corners
        assert!(dense.iter().any(|p| (p.x - 3.0).abs() < 1e-6 && (p.y - 3.0).abs() < 1e-6));
    }

    #[test]
    fn double_puts_the_second_diagonal_on_top_and_smyrna_the_upright() {
        let one = |kind| cross_row(kind, false, 0.0, 0.0, 0.0);
        let d = one(CrossKind::Double);
        let last = (d[d.len() - 2], d[d.len() - 1]);
        assert!((last.0 .0 - last.1 .0).abs() == 1.0 && (last.0 .1 - last.1 .1).abs() == 1.0, "double ends with a diagonal: {last:?}");
        let s = one(CrossKind::Smyrna);
        let tail = &s[s.len() - 3..];
        assert!(tail.iter().all(|p| (p.0 - 0.5).abs() < 1e-9), "smyrna ends with the upright bar: {tail:?}");
    }

    #[test]
    fn long_cross_stitches_are_split() {
        let big = |m: f64| cross_full_ex(&sq(30.0), 0.0, 10.0, 0.5, CrossKind::Cross, true, [0.0, 0.0], false, 1, 2.5, None, &CrossOpts { max_len: m, ..Default::default() }, 0);
        let longest = |runs: Vec<Run>| runs.iter().flat_map(|r| r.windows(2).filter(|w| (w[0].1 | w[1].1) & flags::TRAVEL == 0).map(|w| w[0].0.dist(w[1].0)).collect::<Vec<_>>()).fold(0.0, f64::max);
        assert!(longest(big(0.0)) > 14.0);
        assert!(longest(big(5.0)) <= 5.0 + 1e-9);
    }
}
