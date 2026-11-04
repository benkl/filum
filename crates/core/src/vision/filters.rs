//! Image filters for the digitizer:
//!
//! * edge-preserving **bilateral** smoothing in CIE Lab (flattens photo
//!   texture and JPEG noise before colour quantisation, keeps edges);
//! * the **edge tangent flow** (ETF) and **flow-based difference of
//!   Gaussians** (FDoG) of Kang, Lee & Chui, "Coherent Line Drawing" (NPAR
//!   2007) / "Flow-Based Image Abstraction" (TVCG 2009): a smooth direction
//!   field following the image's edges, and clean, coherent line art;
//! * direction statistics of a region (the dominant flow and how coherent
//!   it is) for stitch directions that follow the picture.

use crate::geom::{pt, Point};

/// A float image with `c` channels.
#[derive(Clone)]
pub struct Img {
    pub w: usize,
    pub h: usize,
    pub c: usize,
    pub data: Vec<f32>,
}

impl Img {
    pub fn new(w: usize, h: usize, c: usize) -> Img {
        Img { w, h, c, data: vec![0.0; w * h * c] }
    }
    #[inline]
    pub fn at(&self, x: usize, y: usize, k: usize) -> f32 {
        self.data[(y * self.w + x) * self.c + k]
    }
    /// Bilinear sample of channel `k` (clamped).
    pub fn sample(&self, x: f64, y: f64, k: usize) -> f32 {
        let x = x.clamp(0.0, (self.w - 1) as f64);
        let y = y.clamp(0.0, (self.h - 1) as f64);
        let (x0, y0) = (x.floor() as usize, y.floor() as usize);
        let (x1, y1) = ((x0 + 1).min(self.w - 1), (y0 + 1).min(self.h - 1));
        let (fx, fy) = ((x - x0 as f64) as f32, (y - y0 as f64) as f32);
        let a = self.at(x0, y0, k) * (1.0 - fx) + self.at(x1, y0, k) * fx;
        let b = self.at(x0, y1, k) * (1.0 - fx) + self.at(x1, y1, k) * fx;
        a * (1.0 - fy) + b * fy
    }
}

/// Bilateral filter on a Lab image (spatial radius `r`, range sigma in ΔE).
pub fn bilateral(lab: &Img, r: usize, sigma_s: f32, sigma_r: f32, alpha: &[bool]) -> Img {
    let (w, h) = (lab.w, lab.h);
    let mut out = lab.clone();
    let ri = r as i64;
    let mut spatial = Vec::with_capacity((2 * r + 1) * (2 * r + 1));
    for dy in -ri..=ri {
        for dx in -ri..=ri {
            spatial.push((dx, dy, (-((dx * dx + dy * dy) as f32) / (2.0 * sigma_s * sigma_s)).exp()));
        }
    }
    let inv_r = 1.0 / (2.0 * sigma_r * sigma_r);
    for y in 0..h {
        for x in 0..w {
            let i = y * w + x;
            if !alpha[i] {
                continue;
            }
            let c0 = [lab.data[i * 3], lab.data[i * 3 + 1], lab.data[i * 3 + 2]];
            let (mut acc, mut wsum) = ([0f32; 3], 0f32);
            for &(dx, dy, ws) in &spatial {
                let (nx, ny) = (x as i64 + dx, y as i64 + dy);
                if nx < 0 || ny < 0 || nx >= w as i64 || ny >= h as i64 {
                    continue;
                }
                let j = ny as usize * w + nx as usize;
                if !alpha[j] {
                    continue;
                }
                let c = [lab.data[j * 3], lab.data[j * 3 + 1], lab.data[j * 3 + 2]];
                let d2 = (c[0] - c0[0]).powi(2) + (c[1] - c0[1]).powi(2) + (c[2] - c0[2]).powi(2);
                let wgt = ws * (-d2 * inv_r).exp();
                for k in 0..3 {
                    acc[k] += c[k] * wgt;
                }
                wsum += wgt;
            }
            if wsum > 0.0 {
                for k in 0..3 {
                    out.data[i * 3 + k] = acc[k] / wsum;
                }
            }
        }
    }
    out
}

/// Luminance (0..1) of a Lab image.
pub fn luminance(lab: &Img) -> Img {
    let mut out = Img::new(lab.w, lab.h, 1);
    for i in 0..lab.w * lab.h {
        out.data[i] = lab.data[i * 3] / 100.0;
    }
    out
}

/// Edge tangent flow: unit tangents (2 channels) and normalised gradient
/// magnitude (channel 2). `radius` ~ 5 px, `iterations` 2–3.
pub fn edge_tangent_flow(lum: &Img, radius: usize, iterations: usize) -> Img {
    let (w, h) = (lum.w, lum.h);
    let mut t = Img::new(w, h, 3);
    let g = |x: i64, y: i64| lum.at(x.clamp(0, w as i64 - 1) as usize, y.clamp(0, h as i64 - 1) as usize, 0);
    let mut gmax = 1e-6f32;
    for y in 0..h as i64 {
        for x in 0..w as i64 {
            // Sobel
            let gx = (g(x + 1, y - 1) + 2.0 * g(x + 1, y) + g(x + 1, y + 1)) - (g(x - 1, y - 1) + 2.0 * g(x - 1, y) + g(x - 1, y + 1));
            let gy = (g(x - 1, y + 1) + 2.0 * g(x, y + 1) + g(x + 1, y + 1)) - (g(x - 1, y - 1) + 2.0 * g(x, y - 1) + g(x + 1, y - 1));
            let m = (gx * gx + gy * gy).sqrt();
            gmax = gmax.max(m);
            let i = (y as usize * w + x as usize) * 3;
            // tangent = gradient rotated by 90°
            let (tx, ty) = if m > 1e-6 { (-gy / m, gx / m) } else { (0.0, 0.0) };
            t.data[i] = tx;
            t.data[i + 1] = ty;
            t.data[i + 2] = m;
        }
    }
    for i in 0..w * h {
        t.data[i * 3 + 2] /= gmax;
    }
    // smoothing: separable passes (x then y), Kang 2009
    let r = radius as i64;
    for _ in 0..iterations {
        for pass in 0..2 {
            let src = t.clone();
            for y in 0..h as i64 {
                for x in 0..w as i64 {
                    let i = (y as usize * w + x as usize) * 3;
                    let (tx, ty, mx) = (src.data[i], src.data[i + 1], src.data[i + 2]);
                    let (mut ax, mut ay) = (0f32, 0f32);
                    for d in -r..=r {
                        let (nx, ny) = if pass == 0 { (x + d, y) } else { (x, y + d) };
                        if nx < 0 || ny < 0 || nx >= w as i64 || ny >= h as i64 {
                            continue;
                        }
                        let j = (ny as usize * w + nx as usize) * 3;
                        let (sx, sy, my) = (src.data[j], src.data[j + 1], src.data[j + 2]);
                        let dot = tx * sx + ty * sy;
                        let phi = if dot >= 0.0 { 1.0 } else { -1.0 };
                        let wm = 0.5 * (1.0 + (my - mx).tanh());
                        let wd = dot.abs().max(if tx == 0.0 && ty == 0.0 { 1.0 } else { 0.0 });
                        let wgt = phi * wm * wd;
                        ax += sx * wgt;
                        ay += sy * wgt;
                    }
                    let l = (ax * ax + ay * ay).sqrt();
                    if l > 1e-6 {
                        t.data[i] = ax / l;
                        t.data[i + 1] = ay / l;
                    }
                }
            }
        }
    }
    t
}

fn gauss(x: f32, s: f32) -> f32 {
    (-(x * x) / (2.0 * s * s)).exp() / (s * (2.0 * std::f32::consts::PI).sqrt())
}

/// Flow-based DoG line drawing (Kang et al.): black lines along the flow.
/// Returns a boolean line mask. `sigma_c` ≈ 1, `sigma_m` ≈ 3, `tau` ≈ 0.5.
pub fn fdog_lines(lum: &Img, etf: &Img, sigma_c: f32, sigma_m: f32, rho: f32, tau: f32) -> Vec<bool> {
    let (w, h) = (lum.w, lum.h);
    let sigma_s = 1.6 * sigma_c;
    let t_len = (3.0 * sigma_s).ceil() as i64;
    let s_len = (3.0 * sigma_m).ceil() as i64;
    // 1D DoG across the flow
    let mut f = vec![0f32; w * h];
    for y in 0..h {
        for x in 0..w {
            let i = y * w + x;
            let (tx, ty) = (etf.data[i * 3], etf.data[i * 3 + 1]);
            let (nx, ny) = (ty, -tx); // gradient direction
            let mut sum = 0f32;
            for k in -t_len..=t_len {
                let kf = k as f32;
                let v = lum.sample(x as f64 + (nx * kf) as f64, y as f64 + (ny * kf) as f64, 0);
                sum += v * (gauss(kf, sigma_c) - rho * gauss(kf, sigma_s));
            }
            f[i] = sum;
        }
    }
    let fimg = Img { w, h, c: 1, data: f };
    // integrate along the flow curve
    let mut out = vec![false; w * h];
    for y in 0..h {
        for x in 0..w {
            let mut sum = gauss(0.0, sigma_m) * fimg.at(x, y, 0);
            let mut norm = gauss(0.0, sigma_m);
            for dir in [1.0f64, -1.0] {
                let (mut px, mut py) = (x as f64, y as f64);
                let (mut lx, mut ly) = (0f64, 0f64);
                for s in 1..=s_len {
                    let tx = etf.sample(px, py, 0) as f64;
                    let ty = etf.sample(px, py, 1) as f64;
                    let (mut dx, mut dy) = (tx * dir, ty * dir);
                    // keep going the same way through sign flips of the tangent field
                    if s > 1 && dx * lx + dy * ly < 0.0 {
                        dx = -dx;
                        dy = -dy;
                    }
                    if dx == 0.0 && dy == 0.0 {
                        break;
                    }
                    px += dx;
                    py += dy;
                    if px < 0.0 || py < 0.0 || px > (w - 1) as f64 || py > (h - 1) as f64 {
                        break;
                    }
                    lx = dx;
                    ly = dy;
                    let g = gauss(s as f32, sigma_m);
                    sum += g * fimg.sample(px, py, 0);
                    norm += g;
                }
            }
            // luminance is 0..1: scale the response so tau keeps the paper's meaning
            let hval = 25.0 * sum / norm;
            out[y * w + x] = hval < 0.0 && 1.0 + hval.tanh() < tau;
        }
    }
    out
}

/// Dominant direction (radians, screen space, y down; defined modulo π) and
/// coherence (0..1) of the flow over a set of pixels, weighted by edge
/// strength — the structure tensor of the tangents.
pub fn flow_direction(etf: &Img, pixels: impl Iterator<Item = usize>) -> (f64, f64) {
    let (mut jxx, mut jyy, mut jxy) = (0f64, 0f64, 0f64);
    for i in pixels {
        let (tx, ty, m) = (etf.data[i * 3] as f64, etf.data[i * 3 + 1] as f64, etf.data[i * 3 + 2] as f64);
        let wgt = m + 0.02;
        jxx += wgt * tx * tx;
        jyy += wgt * ty * ty;
        jxy += wgt * tx * ty;
    }
    let tr = jxx + jyy;
    if tr < 1e-9 {
        return (0.0, 0.0);
    }
    let theta = 0.5 * (2.0 * jxy).atan2(jxx - jyy);
    let disc = ((jxx - jyy).powi(2) + 4.0 * jxy * jxy).sqrt();
    (theta, (disc / tr).clamp(0.0, 1.0))
}

/// The tangent angle (radians, mod π) at a pixel position, averaged over a
/// small window as doubled-angle vectors.
pub fn angle_at(etf: &Img, x: f64, y: f64, r: i64) -> f32 {
    flow_at(etf, x, y, r).0
}

/// The tangent angle at a pixel position (as `angle_at`) and how clear it
/// is there: 0 = no edges or tangents in every direction, 1 = all aligned.
pub fn flow_at(etf: &Img, x: f64, y: f64, r: i64) -> (f32, f32) {
    let (cx, cy) = (x.round() as i64, y.round() as i64);
    let (mut c2, mut s2, mut wsum) = (0f32, 0f32, 0f32);
    for dy in -r..=r {
        for dx in -r..=r {
            let (nx, ny) = (cx + dx, cy + dy);
            if nx < 0 || ny < 0 || nx >= etf.w as i64 || ny >= etf.h as i64 {
                continue;
            }
            let i = (ny as usize * etf.w + nx as usize) * 3;
            let (tx, ty, m) = (etf.data[i], etf.data[i + 1], etf.data[i + 2] + 0.02);
            c2 += m * (tx * tx - ty * ty);
            s2 += m * 2.0 * tx * ty;
            wsum += m;
        }
    }
    let clarity = if wsum > 1e-9 { ((c2 * c2 + s2 * s2).sqrt() / wsum).clamp(0.0, 1.0) } else { 0.0 };
    (0.5 * s2.atan2(c2), clarity)
}

pub fn to_point(x: usize, y: usize) -> Point {
    pt(x as f64 + 0.5, y as f64 + 0.5)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn etf_follows_edges_and_fdog_draws_them() {
        // a dark disc on white
        let (w, h) = (48, 48);
        let mut lum = Img::new(w, h, 1);
        for y in 0..h {
            for x in 0..w {
                let d = ((x as f64 - 24.0).powi(2) + (y as f64 - 24.0).powi(2)).sqrt();
                lum.data[y * w + x] = if d < 14.0 { 0.2 } else { 0.9 };
            }
        }
        let etf = edge_tangent_flow(&lum, 4, 2);
        // on the right edge of the disc the tangent is vertical
        let i = (24 * w + 38) * 3;
        assert!(etf.data[i + 1].abs() > 0.9, "{:?}", &etf.data[i..i + 3]);
        let lines = fdog_lines(&lum, &etf, 1.0, 3.0, 0.99, 0.5);
        let on: usize = lines.iter().filter(|b| **b).count();
        let ring = (0..w * h).filter(|&i| lines[i]).all(|i| {
            let (x, y) = ((i % w) as f64, (i / w) as f64);
            ((x - 24.0).powi(2) + (y - 24.0).powi(2)).sqrt() > 9.0
        });
        assert!(on > 40 && ring, "{on} line pixels");
    }
}
