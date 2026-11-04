//! Multi-colour gradient fills.
//!
//! A gradient is sewn as one tatami layer per colour stop. All layers share
//! the same shape, angle and row grid; every row of the grid is cut into
//! cells along the rows and each cell is given to exactly one layer. So the
//! layers tile the area: the stitch density stays even everywhere while the
//! colour mix follows the gradient.
//!
//! * The gradient position `t` of a point comes from the gradient geometry
//!   (linear, reflected, radial, conic).
//! * Between two stops the mix follows a transition curve (linear, smooth,
//!   ease in/out, sharp, posterised steps) and the stop's midpoint.
//! * Which layer gets a cell is decided by a dither: error diffusion
//!   (Floyd–Steinberg, vector form for any number of colours), interleaved
//!   rows, an ordered Bayer matrix, noise, or hard bands.

use std::f64::consts::TAU;

use crate::geom::{point_in_rings, pt, rings_bounds, Point, Ring};
use crate::model::{DitherMethod, GradientKind, GradientParams, TransitionCurve};

fn ease(curve: TransitionCurve, steps: u32, u: f64) -> f64 {
    let u = u.clamp(0.0, 1.0);
    let smooth = |x: f64| x * x * (3.0 - 2.0 * x);
    match curve {
        TransitionCurve::Linear => u,
        TransitionCurve::Smooth => smooth(u),
        TransitionCurve::EaseIn => u * u,
        TransitionCurve::EaseOut => 1.0 - (1.0 - u) * (1.0 - u),
        TransitionCurve::Sharp => smooth(smooth(u)),
        TransitionCurve::Steps => {
            let n = steps.max(2) as f64;
            ((u * n).floor().min(n - 1.0)) / (n - 1.0)
        }
    }
}

/// Weight of every stop at gradient position `t` (they sum to 1).
pub fn weights(g: &GradientParams, t: f64) -> Vec<f64> {
    let n = g.stops.len().max(1);
    let mut w = vec![0.0; n];
    if g.stops.len() < 2 {
        w[0] = 1.0;
        return w;
    }
    let mut order: Vec<usize> = (0..g.stops.len()).collect();
    order.sort_by(|a, b| g.stops[*a].pos.partial_cmp(&g.stops[*b].pos).unwrap_or(std::cmp::Ordering::Equal));
    let first = order[0];
    let last = *order.last().unwrap();
    if t <= g.stops[first].pos {
        w[first] = 1.0;
        return w;
    }
    if t >= g.stops[last].pos {
        w[last] = 1.0;
        return w;
    }
    for k in 0..order.len() - 1 {
        let (a, b) = (order[k], order[k + 1]);
        let (pa, pb) = (g.stops[a].pos, g.stops[b].pos);
        if t >= pa && t <= pb {
            let mut u = if pb - pa < 1e-9 { 1.0 } else { (t - pa) / (pb - pa) };
            // midpoint: the 50 % mix sits at `mid` of the way
            let mid = g.stops[a].mid.clamp(0.05, 0.95);
            if (mid - 0.5).abs() > 1e-6 {
                u = u.powf(0.5f64.ln() / mid.ln());
            }
            let u = ease(g.curve, g.steps, u);
            w[a] = 1.0 - u;
            w[b] += u;
            return w;
        }
    }
    w[last] = 1.0;
    w
}

/// Weight of every stop (colour layer) at a point of the design (they sum to 1).
pub fn weights_at(g: &GradientParams, p: Point) -> Vec<f64> {
    match g.kind {
        GradientKind::Mesh => match &g.mesh {
            Some(m) if m.rows >= 2 && m.cols >= 2 && m.nodes.len() == (m.rows * m.cols) as usize => mesh_weights(g, m, p),
            _ => one_hot(g.stops.len().max(1), 0),
        },
        GradientKind::Freeform if !g.points.is_empty() => free_weights(g, p),
        GradientKind::Freeform => one_hot(g.stops.len().max(1), 0),
        _ => weights(g, position(g, p)),
    }
}

fn one_hot(n: usize, k: usize) -> Vec<f64> {
    let mut w = vec![0.0; n];
    w[k.min(n - 1)] = 1.0;
    w
}

/// Sharpen / posterise a weight mix with the transition curve.
fn shape_mix(g: &GradientParams, w: &mut [f64]) {
    if g.curve == TransitionCurve::Linear {
        return;
    }
    let mut sum = 0.0;
    for x in w.iter_mut() {
        *x = ease(g.curve, g.steps, *x);
        sum += *x;
    }
    if sum < 1e-9 {
        let best = (0..w.len()).max_by(|a, b| w[*a].partial_cmp(&w[*b]).unwrap()).unwrap_or(0);
        w.iter_mut().for_each(|x| *x = 0.0);
        w[best] = 1.0;
    } else {
        w.iter_mut().for_each(|x| *x /= sum);
    }
}

/// Freeform: inverse-distance blend of the colour points, each point's
/// distance measured in units of its spread.
fn free_weights(g: &GradientParams, p: Point) -> Vec<f64> {
    let n = g.stops.len().max(1);
    let mut w = vec![0.0; n];
    for fp in &g.points {
        let d = Point::from_arr(fp.p).dist(p) / fp.spread.max(0.1);
        let k = (fp.c as usize).min(n - 1);
        if d < 1e-4 {
            return one_hot(n, k);
        }
        w[k] += 1.0 / (d * d);
    }
    let sum: f64 = w.iter().sum();
    w.iter_mut().for_each(|x| *x /= sum.max(1e-12));
    shape_mix(g, &mut w);
    w
}

/// (u, v) of `p` in the quad a (0,0) → b (1,0) → c (1,1) → d (0,1); the
/// root nearest the unit square.
pub fn inv_bilinear(p: Point, a: Point, b: Point, c: Point, d: Point) -> Option<(f64, f64)> {
    let e = b - a;
    let f = d - a;
    let g = a - b + c - d;
    let h = p - a;
    let k2 = g.cross(f);
    let k1 = e.cross(f) + h.cross(g);
    let k0 = h.cross(e);
    let u_of = |v: f64| {
        let (dx, dy) = (e.x + g.x * v, e.y + g.y * v);
        if dx.abs() > dy.abs() {
            (h.x - f.x * v) / dx
        } else if dy.abs() > 1e-12 {
            (h.y - f.y * v) / dy
        } else {
            f64::NAN
        }
    };
    let scale = e.length_sq().max(f.length_sq()).max(1e-12);
    let cands: Vec<f64> = if k2.abs() < 1e-9 * scale {
        if k1.abs() < 1e-12 {
            return None;
        }
        vec![-k0 / k1]
    } else {
        let disc = k1 * k1 - 4.0 * k0 * k2;
        if disc < 0.0 {
            return None;
        }
        let s = disc.sqrt();
        vec![(-k1 - s) / (2.0 * k2), (-k1 + s) / (2.0 * k2)]
    };
    let out = |u: f64, v: f64| (-u).max(u - 1.0).max(-v).max(v - 1.0).max(0.0);
    cands
        .into_iter()
        .map(|v| (u_of(v), v))
        .filter(|(u, v)| u.is_finite() && v.is_finite())
        .min_by(|x, y| out(x.0, x.1).partial_cmp(&out(y.0, y.1)).unwrap())
}

fn catmull_rom(t: f64) -> [f64; 4] {
    let (t2, t3) = (t * t, t * t * t);
    [(-t3 + 2.0 * t2 - t) * 0.5, (3.0 * t3 - 5.0 * t2 + 2.0) * 0.5, (-3.0 * t3 + 4.0 * t2 + t) * 0.5, (t3 - t2) * 0.5]
}

/// Mesh: find the patch under the point and blend its nodes' colours —
/// bicubic (Catmull-Rom over the whole node grid) for the smooth
/// transition, bilinear with the transition curve otherwise. Outside the
/// mesh the nearest border colour continues.
fn mesh_weights(g: &GradientParams, m: &crate::model::GradientMesh, p: Point) -> Vec<f64> {
    let n = g.stops.len().max(1);
    let (rows, cols) = (m.rows as usize, m.cols as usize);
    let at = |r: usize, c: usize| Point::from_arr(m.nodes[r * cols + c].p);
    let col = |r: usize, c: usize| (m.nodes[r * cols + c].c as usize).min(n - 1);
    for r in 0..rows - 1 {
        for c in 0..cols - 1 {
            let q = [at(r, c), at(r, c + 1), at(r + 1, c + 1), at(r + 1, c)];
            let eps = 1e-6;
            if q.iter().all(|x| x.x < p.x - eps) || q.iter().all(|x| x.x > p.x + eps) || q.iter().all(|x| x.y < p.y - eps) || q.iter().all(|x| x.y > p.y + eps) {
                continue;
            }
            let Some((u, v)) = inv_bilinear(p, q[0], q[1], q[2], q[3]) else { continue };
            if !(-1e-9..=1.0 + 1e-9).contains(&u) || !(-1e-9..=1.0 + 1e-9).contains(&v) {
                continue;
            }
            let (u, v) = (u.clamp(0.0, 1.0), v.clamp(0.0, 1.0));
            let mut w = vec![0.0; n];
            if g.curve == TransitionCurve::Smooth {
                let (bu, bv) = (catmull_rom(u), catmull_rom(v));
                for (i, wv) in bv.iter().enumerate() {
                    let rr = (r as i64 + i as i64 - 1).clamp(0, rows as i64 - 1) as usize;
                    for (j, wu) in bu.iter().enumerate() {
                        let cc = (c as i64 + j as i64 - 1).clamp(0, cols as i64 - 1) as usize;
                        w[col(rr, cc)] += wu * wv;
                    }
                }
                // the cubic overshoots a little: clamp and renormalise
                let mut sum = 0.0;
                for x in w.iter_mut() {
                    *x = x.max(0.0);
                    sum += *x;
                }
                w.iter_mut().for_each(|x| *x /= sum.max(1e-12));
            } else {
                let (eu, ev) = (ease(g.curve, g.steps, u), ease(g.curve, g.steps, v));
                w[col(r, c)] += (1.0 - eu) * (1.0 - ev);
                w[col(r, c + 1)] += eu * (1.0 - ev);
                w[col(r + 1, c + 1)] += eu * ev;
                w[col(r + 1, c)] += (1.0 - eu) * ev;
            }
            return w;
        }
    }
    // outside: the colour of the nearest point on the mesh border
    let mut border: Vec<(usize, usize)> = Vec::new();
    border.extend((0..cols).map(|c| (0, c)));
    border.extend((1..rows).map(|r| (r, cols - 1)));
    border.extend((0..cols - 1).rev().map(|c| (rows - 1, c)));
    border.extend((1..rows - 1).rev().map(|r| (r, 0)));
    let mut best = (f64::INFINITY, 0usize, 0usize, 0.0);
    for i in 0..border.len() {
        let (a, b) = (border[i], border[(i + 1) % border.len()]);
        let (pa, pb) = (at(a.0, a.1), at(b.0, b.1));
        let d = pb - pa;
        let t = ((p - pa).dot(d) / d.length_sq().max(1e-12)).clamp(0.0, 1.0);
        let dist = pa.lerp(pb, t).dist(p);
        if dist < best.0 {
            best = (dist, col(a.0, a.1), col(b.0, b.1), t);
        }
    }
    let mut w = vec![0.0; n];
    let t = ease(g.curve, g.steps, best.3);
    w[best.1] += 1.0 - t;
    w[best.2] += t;
    w
}

/// Gradient position of a point (0 at the start, 1 at the end).
pub fn position(g: &GradientParams, p: Point) -> f64 {
    let a = Point::from_arr(g.from);
    let b = Point::from_arr(g.to);
    let d = b - a;
    let l2 = d.dot(d).max(1e-12);
    let v = p - a;
    match g.kind {
        GradientKind::Linear => v.dot(d) / l2,
        GradientKind::Reflected => (v.dot(d) / l2).abs(),
        GradientKind::Radial => v.length() / l2.sqrt(),
        GradientKind::Conic => ((v.y.atan2(v.x) - d.y.atan2(d.x)).rem_euclid(TAU)) / TAU,
        // 2D gradients have no single position (see `weights_at`)
        GradientKind::Mesh | GradientKind::Freeform => (v.dot(d) / l2).clamp(0.0, 1.0),
    }
}

const BAYER8: [[u8; 8]; 8] = [
    [0, 32, 8, 40, 2, 34, 10, 42],
    [48, 16, 56, 24, 50, 18, 58, 26],
    [12, 44, 4, 36, 14, 46, 6, 38],
    [60, 28, 52, 20, 62, 30, 54, 22],
    [3, 35, 11, 43, 1, 33, 9, 41],
    [51, 19, 59, 27, 49, 17, 57, 25],
    [15, 47, 7, 39, 13, 45, 5, 37],
    [63, 31, 55, 23, 61, 29, 53, 21],
];

fn hash01(a: i64, b: i64, seed: u32) -> f64 {
    let mut x = (a as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15) ^ (b as u64).wrapping_mul(0xC2B2_AE3D_27D4_EB4F) ^ (seed as u64).wrapping_mul(0x1656_67B1_9E37_79F9);
    x ^= x >> 33;
    x = x.wrapping_mul(0xFF51_AFD7_ED55_8CCD);
    x ^= x >> 33;
    x = x.wrapping_mul(0xC4CE_B9FE_1A85_EC53);
    x ^= x >> 33;
    (x >> 11) as f64 / (1u64 << 53) as f64
}

/// Van der Corput sequence: well spread thresholds for consecutive rows.
fn vdc(n: i64) -> f64 {
    let mut n = n.rem_euclid(1 << 20) as u32;
    let mut r = 0.0;
    let mut f = 0.5;
    while n > 0 {
        if n & 1 == 1 {
            r += f;
        }
        n >>= 1;
        f *= 0.5;
    }
    r
}

/// The layer whose cumulative weight passes the threshold.
fn pick(w: &[f64], thr: f64) -> u8 {
    let mut acc = 0.0;
    for (k, x) in w.iter().enumerate() {
        acc += x;
        if thr < acc {
            return k as u8;
        }
    }
    (w.len() - 1) as u8
}

/// One colour's share of a gradient over a shape, sampled on a grid (the
/// streamline fill asks for it at every step).
pub struct ShareGrid {
    x0: f64,
    y0: f64,
    cell: f64,
    w: usize,
    h: usize,
    v: Vec<f32>,
    /// The share of the colours sewn after this one (they cover it).
    later: Vec<f32>,
}

impl ShareGrid {
    pub fn new(g: &GradientParams, rings: &[Ring], spacing: f64) -> ShareGrid {
        let b = rings_bounds(rings);
        let cell = (b.width().max(b.height()) / 160.0).max(spacing.max(0.1));
        let (w, h) = ((b.width() / cell).ceil() as usize + 2, (b.height() / cell).ceil() as usize + 2);
        let (x0, y0) = (b.min_x - cell * 0.5, b.min_y - cell * 0.5);
        let k = g.layer as usize;
        let mut v = Vec::with_capacity(w * h);
        let mut later = Vec::with_capacity(w * h);
        for j in 0..h {
            for i in 0..w {
                let wt = weights_at(g, pt(x0 + i as f64 * cell, y0 + j as f64 * cell));
                v.push(wt.get(k).copied().unwrap_or(0.0) as f32);
                later.push(wt.iter().skip(k + 1).sum::<f64>() as f32);
            }
        }
        ShareGrid { x0, y0, cell, w, h, v, later }
    }

    /// The share at a point (bilinear).
    pub fn at(&self, q: Point) -> f64 {
        self.sample(&self.v, q)
    }

    /// The share of the colours sewn later at a point.
    pub fn later_at(&self, q: Point) -> f64 {
        self.sample(&self.later, q)
    }

    fn sample(&self, grid: &[f32], q: Point) -> f64 {
        let gx = ((q.x - self.x0) / self.cell).clamp(0.0, (self.w - 1) as f64);
        let gy = ((q.y - self.y0) / self.cell).clamp(0.0, (self.h - 1) as f64);
        let (i, j) = (gx.floor() as usize, gy.floor() as usize);
        let (i1, j1) = ((i + 1).min(self.w - 1), (j + 1).min(self.h - 1));
        let (fx, fy) = (gx - i as f64, gy - j as f64);
        let v = |a: usize, b: usize| grid[b * self.w + a] as f64;
        (v(i, j) * (1.0 - fx) + v(i1, j) * fx) * (1.0 - fy) + (v(i, j1) * (1.0 - fx) + v(i1, j1) * fx) * fy
    }
}

/// Which layer sews each cell of the row grid (rows along x, in the
/// rotated frame of the tatami fill).
pub struct LayerMask {
    layer: u8,
    spacing: f64,
    cell: f64,
    r0: i64,
    c0: i64,
    rows: usize,
    cols: usize,
    assign: Vec<u8>,
}

impl LayerMask {
    /// `rr`: rings rotated into the row frame; `angle`: their rotation (rad).
    pub fn new(g: &GradientParams, rr: &[Ring], angle: f64, spacing: f64) -> LayerMask {
        let b = rings_bounds(rr);
        let spacing = spacing.max(0.05);
        let mut cell = g.cell.max(0.3);
        let r0 = (b.min_y / spacing).floor() as i64 - 1;
        let rows = ((b.max_y / spacing).ceil() as i64 + 1 - r0).max(1) as usize;
        let (mut c0, mut cols);
        loop {
            c0 = (b.min_x / cell).floor() as i64 - 1;
            cols = ((b.max_x / cell).ceil() as i64 + 1 - c0).max(1) as usize;
            if rows * cols <= 3_000_000 {
                break;
            }
            cell *= 1.5;
        }
        let n = g.stops.len().max(1);
        let mut assign = vec![0u8; rows * cols];
        let centre = |ri: usize, ci: usize| pt((c0 + ci as i64) as f64 * cell + cell * 0.5, ((r0 + ri as i64) as f64 + 0.5) * spacing);
        let mix_at = |q: Point| weights_at(g, q.rotate(-angle));
        if g.dither == DitherMethod::Diffusion && n > 1 {
            // vector Floyd–Steinberg on a serpentine scan
            let mut cur = vec![0.0f64; cols * n];
            let mut next = vec![0.0f64; cols * n];
            for ri in 0..rows {
                let rev = ri % 2 == 1;
                for step in 0..cols {
                    let ci = if rev { cols - 1 - step } else { step };
                    let q = centre(ri, ci);
                    let w = mix_at(q);
                    if !point_in_rings(q, rr) {
                        assign[ri * cols + ci] = pick(&w, 0.5);
                        continue;
                    }
                    let v: Vec<f64> = (0..n).map(|k| w[k] + cur[ci * n + k]).collect();
                    let best = (0..n).max_by(|a, b| v[*a].partial_cmp(&v[*b]).unwrap()).unwrap();
                    assign[ri * cols + ci] = best as u8;
                    let fwd = if rev { ci.checked_sub(1) } else { (ci + 1 < cols).then_some(ci + 1) };
                    let back = if rev { (ci + 1 < cols).then_some(ci + 1) } else { ci.checked_sub(1) };
                    for k in 0..n {
                        let e = v[k] - if k == best { 1.0 } else { 0.0 };
                        if let Some(c) = fwd {
                            cur[c * n + k] += e * 7.0 / 16.0;
                            next[c * n + k] += e / 16.0;
                        }
                        if let Some(c) = back {
                            next[c * n + k] += e * 3.0 / 16.0;
                        }
                        next[ci * n + k] += e * 5.0 / 16.0;
                    }
                }
                std::mem::swap(&mut cur, &mut next);
                next.iter_mut().for_each(|x| *x = 0.0);
            }
        } else {
            for ri in 0..rows {
                for ci in 0..cols {
                    let (r, c) = (r0 + ri as i64, c0 + ci as i64);
                    let w = mix_at(centre(ri, ci));
                    let thr = match g.dither {
                        DitherMethod::Bands | DitherMethod::Diffusion => 0.5,
                        DitherMethod::Rows => (vdc(r) + hash01(0, 0, g.seed)).fract(),
                        DitherMethod::Ordered => (BAYER8[r.rem_euclid(8) as usize][c.rem_euclid(8) as usize] as f64 + 0.5) / 64.0,
                        DitherMethod::Noise => hash01(r, c, g.seed),
                    };
                    assign[ri * cols + ci] = pick(&w, thr);
                }
            }
        }
        LayerMask { layer: g.layer.min(255) as u8, spacing, cell, r0, c0, rows, cols, assign }
    }

    fn at(&self, r: i64, c: i64) -> Option<u8> {
        let (ri, ci) = (r - self.r0, c - self.c0);
        if ri < 0 || ci < 0 || ri as usize >= self.rows || ci as usize >= self.cols {
            return None;
        }
        Some(self.assign[ri as usize * self.cols + ci as usize])
    }

    /// Can this layer travel along the row at `y` from `x0` to `x1` hidden?
    /// Only cells of layers sewn later cover the travel stitches.
    pub fn hidden_along_row(&self, y: f64, x0: f64, x1: f64) -> bool {
        let r = (y / self.spacing).floor() as i64;
        let (a, b) = (x0.min(x1), x0.max(x1));
        let c0 = (a / self.cell).floor() as i64;
        let c1 = ((b - 1e-9) / self.cell).floor() as i64;
        (c0..=c1).all(|c| {
            let cc = c.clamp(self.c0, self.c0 + self.cols as i64 - 1);
            self.at(r, cc).map_or(false, |l| l >= self.layer)
        })
    }

    /// Can this layer step across rows at `x` from `y0` to `y1` hidden?
    pub fn hidden_across_rows(&self, x: f64, y0: f64, y1: f64) -> bool {
        let c = ((x / self.cell).floor() as i64).clamp(self.c0, self.c0 + self.cols as i64 - 1);
        let (a, b) = (y0.min(y1), y0.max(y1));
        let r0 = (a / self.spacing).floor() as i64 + 1;
        let r1 = (b / self.spacing).floor() as i64 - 1;
        (r0..=r1).all(|r| self.at(r, c).map_or(false, |l| l > self.layer))
    }

    /// Does this layer sew at `q` (rotated frame)? Looked up in square cells
    /// (the dither cell), so a streamline crossing the rows is not broken
    /// into row-sized pieces (flow fills).
    pub fn owns(&self, q: Point) -> bool {
        // blocks half a cell high: a finer mix, pieces still long enough to sew
        let hgt = (self.cell * 0.5).max(self.spacing);
        let r = ((q.y / hgt).floor() * hgt / self.spacing).floor() as i64;
        let r = r.clamp(self.r0, self.r0 + self.rows as i64 - 1);
        let c = ((q.x / self.cell).floor() as i64).clamp(self.c0, self.c0 + self.cols as i64 - 1);
        self.at(r, c).unwrap_or(0) == self.layer
    }

    /// Is `q` (rotated frame) sewn by a layer after this one?
    pub fn later(&self, q: Point) -> bool {
        // blocks half a cell high: a finer mix, pieces still long enough to sew
        let hgt = (self.cell * 0.5).max(self.spacing);
        let r = ((q.y / hgt).floor() * hgt / self.spacing).floor() as i64;
        let r = r.clamp(self.r0, self.r0 + self.rows as i64 - 1);
        let c = ((q.x / self.cell).floor() as i64).clamp(self.c0, self.c0 + self.cols as i64 - 1);
        self.at(r, c).unwrap_or(0) > self.layer
    }

    /// The parts of the row at `y` between `x0` and `x1` this layer sews.
    pub fn pieces(&self, y: f64, x0: f64, x1: f64) -> Vec<(f64, f64)> {
        let r = (y / self.spacing).floor() as i64;
        let c_first = (x0 / self.cell).floor() as i64;
        let c_last = (x1 / self.cell).floor() as i64;
        let mut out: Vec<(f64, f64)> = Vec::new();
        for c in c_first..=c_last {
            // cells beyond the grid belong to the nearest edge cell
            let cc = c.clamp(self.c0, self.c0 + self.cols as i64 - 1);
            if self.at(r, cc).unwrap_or(0) != self.layer {
                continue;
            }
            let a = (c as f64 * self.cell).max(x0);
            let b = ((c + 1) as f64 * self.cell).min(x1);
            if b <= a {
                continue;
            }
            match out.last_mut() {
                Some(last) if (a - last.1).abs() < 1e-9 => last.1 = b,
                _ => out.push((a, b)),
            }
        }
        out.retain(|(a, b)| b - a > 0.3);
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::GradientStop;

    fn grad(n: usize, dither: DitherMethod) -> GradientParams {
        GradientParams {
            from: [0.0, 0.0],
            to: [40.0, 0.0],
            stops: (0..n).map(|k| GradientStop { pos: k as f64 / (n - 1) as f64, mid: 0.5 }).collect(),
            dither,
            ..Default::default()
        }
    }

    #[test]
    fn shares_follow_the_gradient() {
        let sq = vec![vec![pt(0.0, 0.0), pt(40.0, 0.0), pt(40.0, 10.0), pt(0.0, 10.0)]];
        let first = ShareGrid::new(&grad(2, DitherMethod::Diffusion), &sq, 0.4);
        let second = ShareGrid::new(&GradientParams { layer: 1, ..grad(2, DitherMethod::Diffusion) }, &sq, 0.4);
        for x in [0.0, 10.0, 20.0, 35.0] {
            let (a, b) = (first.at(pt(x, 5.0)), second.at(pt(x, 5.0)));
            assert!((a + b - 1.0).abs() < 0.02 && (b - x / 40.0).abs() < 0.03, "{x}: {a} {b}");
        }
    }

    #[test]
    fn weights_sum_to_one() {
        for curve in [TransitionCurve::Linear, TransitionCurve::Smooth, TransitionCurve::EaseIn, TransitionCurve::Sharp, TransitionCurve::Steps] {
            let g = GradientParams { curve, ..grad(3, DitherMethod::Diffusion) };
            for k in 0..=20 {
                let w = weights(&g, k as f64 / 20.0);
                assert!((w.iter().sum::<f64>() - 1.0).abs() < 1e-9);
            }
            assert_eq!(weights(&g, 0.0)[0], 1.0);
            assert_eq!(weights(&g, 1.0)[2], 1.0);
        }
    }

    #[test]
    fn midpoint_moves_the_half_mix() {
        let mut g = grad(2, DitherMethod::Diffusion);
        g.stops[0].mid = 0.25;
        let w = weights(&g, 0.25);
        assert!((w[1] - 0.5).abs() < 1e-6, "{w:?}");
    }

    #[test]
    fn layers_tile_every_row() {
        let sq: Vec<Ring> = vec![vec![pt(0.0, 0.0), pt(40.0, 0.0), pt(40.0, 20.0), pt(0.0, 20.0)]];
        for dither in [DitherMethod::Diffusion, DitherMethod::Rows, DitherMethod::Ordered, DitherMethod::Noise, DitherMethod::Bands] {
            let masks: Vec<LayerMask> = (0..3)
                .map(|layer| LayerMask::new(&GradientParams { layer, ..grad(3, dither) }, &sq, 0.0, 0.4))
                .collect();
            for r in 0..50 {
                let y = (r as f64 + 0.5) * 0.4;
                let mut cover = 0.0;
                for m in &masks {
                    cover += m.pieces(y, 0.0, 40.0).iter().map(|(a, b)| b - a).sum::<f64>();
                }
                // pieces under 0.3 mm are dropped, everything else is covered exactly once
                assert!(cover <= 40.0 + 1e-6 && cover > 36.0, "{dither:?} row {r}: {cover}");
            }
        }
    }

    #[test]
    fn mix_follows_the_gradient() {
        let sq: Vec<Ring> = vec![vec![pt(0.0, 0.0), pt(40.0, 0.0), pt(40.0, 20.0), pt(0.0, 20.0)]];
        for dither in [DitherMethod::Diffusion, DitherMethod::Ordered, DitherMethod::Noise, DitherMethod::Rows] {
            let m = LayerMask::new(&grad(2, dither), &sq, 0.0, 0.4);
            let share = |x0: f64, x1: f64| {
                let mut s = 0.0;
                for r in 0..50 {
                    s += m.pieces((r as f64 + 0.5) * 0.4, x0, x1).iter().map(|(a, b)| b - a).sum::<f64>();
                }
                s / (50.0 * (x1 - x0))
            };
            let (left, mid, right) = (share(0.0, 8.0), share(16.0, 24.0), share(32.0, 40.0));
            assert!(left > 0.75 && right < 0.25 && (mid - 0.5).abs() < 0.15, "{dither:?}: {left:.2} {mid:.2} {right:.2}");
        }
    }

    fn mesh_grad(curve: TransitionCurve) -> GradientParams {
        use crate::model::{GradientMesh, MeshNode};
        // 3 × 3 nodes over 40 × 20 mm: left column colour 0, the rest colour 1,
        // the middle node colour 2
        let mut nodes = Vec::new();
        for r in 0..3 {
            for c in 0..3 {
                let col = if r == 1 && c == 1 { 2 } else if c == 0 { 0 } else { 1 };
                nodes.push(MeshNode { p: [c as f64 * 20.0, r as f64 * 10.0], c: col });
            }
        }
        GradientParams { kind: GradientKind::Mesh, curve, mesh: Some(GradientMesh { rows: 3, cols: 3, nodes }), ..grad(3, DitherMethod::Diffusion) }
    }

    #[test]
    fn inverse_bilinear_round_trips() {
        let (a, b, c, d) = (pt(0.0, 0.0), pt(10.0, 1.0), pt(12.0, 9.0), pt(-1.0, 8.0));
        for (u, v) in [(0.2, 0.3), (0.9, 0.1), (0.5, 0.5), (0.0, 1.0)] {
            let p = a.lerp(b, u).lerp(d.lerp(c, u), v);
            let (uu, vv) = inv_bilinear(p, a, b, c, d).unwrap();
            assert!((uu - u).abs() < 1e-6 && (vv - v).abs() < 1e-6, "{u},{v} -> {uu},{vv}");
        }
    }

    #[test]
    fn mesh_nodes_carry_their_colours() {
        for curve in [TransitionCurve::Linear, TransitionCurve::Smooth, TransitionCurve::Sharp] {
            let g = mesh_grad(curve);
            let w = |x: f64, y: f64| weights_at(&g, pt(x, y));
            assert!(w(0.0, 0.0)[0] > 0.99, "{curve:?}");
            assert!(w(20.0, 10.0)[2] > 0.99, "{curve:?}");
            assert!(w(40.0, 20.0)[1] > 0.99, "{curve:?}");
            for (x, y) in [(5.0, 3.0), (31.0, 17.0), (19.0, 11.0), (60.0, -5.0)] {
                let s: f64 = w(x, y).iter().sum();
                assert!((s - 1.0).abs() < 1e-9 && w(x, y).iter().all(|v| *v >= 0.0), "{curve:?} {x},{y}");
            }
            // halfway between a colour-0 and colour-1 node on the border
            let h = w(10.0, 0.0);
            assert!((h[0] - 0.5).abs() < 0.12, "{curve:?} {h:?}");
            // outside: the nearest border colour
            assert!(w(-10.0, 0.0)[0] > 0.99 && w(50.0, 10.0)[1] > 0.99);
        }
    }

    #[test]
    fn mesh_and_freeform_layers_tile() {
        use crate::model::FreePoint;
        let sq: Vec<Ring> = vec![vec![pt(0.0, 0.0), pt(40.0, 0.0), pt(40.0, 20.0), pt(0.0, 20.0)]];
        let free = GradientParams {
            kind: GradientKind::Freeform,
            points: vec![
                FreePoint { p: [5.0, 5.0], c: 0, spread: 10.0 },
                FreePoint { p: [35.0, 5.0], c: 1, spread: 10.0 },
                FreePoint { p: [20.0, 18.0], c: 2, spread: 6.0 },
            ],
            ..grad(3, DitherMethod::Diffusion)
        };
        assert!(weights_at(&free, pt(5.2, 5.0))[0] > 0.98);
        assert!(weights_at(&free, pt(20.0, 18.0))[2] > 0.999);
        for g in [mesh_grad(TransitionCurve::Smooth), free] {
            for dither in [DitherMethod::Diffusion, DitherMethod::Ordered, DitherMethod::Bands] {
                let masks: Vec<LayerMask> = (0..3).map(|layer| LayerMask::new(&GradientParams { layer, dither, ..g.clone() }, &sq, 0.3, 0.4)).collect();
                for r in -10..60 {
                    let y = (r as f64 + 0.5) * 0.4;
                    let mut cover = 0.0;
                    for m in &masks {
                        cover += m.pieces(y, 0.0, 40.0).iter().map(|(a, b)| b - a).sum::<f64>();
                    }
                    assert!(cover <= 40.0 + 1e-6 && cover > 36.0, "{:?} {dither:?} row {r}: {cover}", g.kind);
                }
            }
        }
    }

    #[test]
    fn radial_and_conic_positions() {
        let g = GradientParams { kind: GradientKind::Radial, from: [0.0, 0.0], to: [10.0, 0.0], ..Default::default() };
        assert!((position(&g, pt(0.0, 5.0)) - 0.5).abs() < 1e-9);
        let c = GradientParams { kind: GradientKind::Conic, ..g.clone() };
        assert!((position(&c, pt(0.0, 5.0)) - 0.25).abs() < 1e-9);
    }

    #[test]
    fn layers_sew_like_one_fill() {
        use crate::model::{FillParams, SubPath};
        let sq = vec![SubPath::polyline(&[pt(0.0, 0.0), pt(40.0, 0.0), pt(40.0, 20.0), pt(0.0, 20.0)], true)];
        let plain = FillParams { underlay: false, ..Default::default() };
        let count = |p: &FillParams| -> (usize, f64) {
            let runs = crate::stitches::fill::fill(&sq, p, 0.0, 1.0, false, 1.0, None, None);
            // every needle penetration, travel included
            let pts: Vec<Point> = runs.iter().flatten().map(|x| x.0).collect();
            (pts.len(), pts.iter().map(|q| q.x).sum::<f64>() / pts.len().max(1) as f64)
        };
        let (n_plain, _) = count(&plain);
        let (n0, x0) = count(&FillParams { gradient: Some(GradientParams { layer: 0, ..grad(2, DitherMethod::Diffusion) }), ..plain.clone() });
        let (n1, x1) = count(&FillParams { gradient: Some(GradientParams { layer: 1, ..grad(2, DitherMethod::Diffusion) }), ..plain.clone() });
        let total = (n0 + n1) as f64;
        // dithered cells add a penetration at every boundary
        // fine dithering costs penetrations at cell boundaries and hidden travel
        assert!(total < n_plain as f64 * 2.1 && total > n_plain as f64 * 0.9, "{n0}+{n1} vs {n_plain}");
        assert!(x0 < 17.0 && x1 > 23.0, "layer centres {x0:.1} {x1:.1}");
        // rows perpendicular to the gradient + row interleaving: whole rows, almost no extra stitches
        let rows = |layer| FillParams {
            angle: 90.0,
            gradient: Some(GradientParams { layer, ..grad(2, DitherMethod::Rows) }),
            ..plain.clone()
        };
        let plain90 = count(&FillParams { angle: 90.0, ..plain.clone() }).0 as f64;
        let (r0, _) = count(&rows(0));
        let (r1, _) = count(&rows(1));
        assert!(((r0 + r1) as f64) < plain90 * 1.15, "rows {r0}+{r1} vs {plain90}");
    }
}
