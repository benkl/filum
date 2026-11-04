//! Gradient regions: areas whose colour changes smoothly across space (sky,
//! shading, airbrush) are found and fitted with a linear colour ramp, after
//! the idea of Du et al., "Image Vectorization and Editing via Linear
//! Gradient Layer Decomposition" (SIGGRAPH 2023). Each becomes one of
//! Filum's dithered multi-colour gradient fills instead of being
//! posterised into colour bands.

use super::filters::Img;

#[derive(Debug, Clone, PartialEq)]
pub struct GradientRegion {
    /// Pixel indices.
    pub pixels: Vec<u32>,
    /// Ramp in pixel coordinates: colour (sRGB 0..255) at `from` and at `to`.
    pub from: [f64; 2],
    pub to: [f64; 2],
    pub rgb_from: [f64; 3],
    pub rgb_to: [f64; 3],
}

fn de(a: &[f32], b: &[f32]) -> f32 {
    ((a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2) + (a[2] - b[2]).powi(2)).sqrt()
}

/// Solve the 3×3 system m · x = v (Cramer's rule).
fn solve3(m: [[f64; 3]; 3], v: [f64; 3]) -> Option<[f64; 3]> {
    let det = |m: [[f64; 3]; 3]| {
        m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
    };
    let d = det(m);
    if d.abs() < 1e-9 {
        return None;
    }
    let mut out = [0.0; 3];
    for k in 0..3 {
        let mut mk = m;
        for r in 0..3 {
            mk[r][k] = v[r];
        }
        out[k] = det(mk) / d;
    }
    Some(out)
}

/// Find gradient regions: grown over gentle steps of the (smoothed) Lab
/// image, fitted in `rgb` (sRGB, 0..255) — design tools blend in sRGB. `step` = largest ΔE
/// between neighbouring pixels inside a ramp, `min_frac` = smallest region
/// (fraction of the image), `min_range` = smallest colour change (ΔE) along
/// the ramp, `max_rms` = largest misfit of the linear model (ΔE).
pub fn find(lab: &Img, rgb: &Img, alpha: &[bool], step: f32, min_frac: f64, min_range: f64, max_rms: f64) -> Vec<GradientRegion> {
    let (w, h) = (lab.w, lab.h);
    let n = w * h;
    let px = |i: usize| &lab.data[i * 3..i * 3 + 3];
    let mut seen = vec![false; n];
    let mut out = Vec::new();
    let min_px = ((n as f64) * min_frac).max(64.0) as usize;
    for s in 0..n {
        if seen[s] || !alpha[s] {
            continue;
        }
        // region growing over gentle colour steps
        let mut region = vec![s as u32];
        seen[s] = true;
        let mut head = 0;
        while head < region.len() {
            let p = region[head] as usize;
            head += 1;
            let (x, y) = (p % w, p / w);
            let nb = [(x > 0).then(|| p - 1), (x + 1 < w).then(|| p + 1), (y > 0).then(|| p - w), (y + 1 < h).then(|| p + w)];
            for q in nb.into_iter().flatten() {
                if !seen[q] && alpha[q] && de(px(p), px(q)) < step {
                    seen[q] = true;
                    region.push(q as u32);
                }
            }
        }
        if region.len() < min_px {
            continue;
        }
        // least squares: colour = a + b·x + c·y per channel
        let (mut sxx, mut sxy, mut syy, mut sx, mut sy) = (0f64, 0f64, 0f64, 0f64, 0f64);
        let cnt = region.len() as f64;
        let mut rx = [0f64; 3];
        let mut ry = [0f64; 3];
        let mut r1 = [0f64; 3];
        for &p in &region {
            let (x, y) = ((p as usize % w) as f64, (p as usize / w) as f64);
            let c = &rgb.data[p as usize * 3..p as usize * 3 + 3];
            sxx += x * x;
            sxy += x * y;
            syy += y * y;
            sx += x;
            sy += y;
            for k in 0..3 {
                rx[k] += x * c[k] as f64;
                ry[k] += y * c[k] as f64;
                r1[k] += c[k] as f64;
            }
        }
        let m = [[cnt, sx, sy], [sx, sxx, sxy], [sy, sxy, syy]];
        let mut coef = [[0f64; 3]; 3]; // per channel: a, b, c
        let mut ok = true;
        for k in 0..3 {
            match solve3(m, [r1[k], rx[k], ry[k]]) {
                Some(v) => coef[k] = v,
                None => ok = false,
            }
        }
        if !ok {
            continue;
        }
        // misfit
        let mut err = 0f64;
        for &p in &region {
            let (x, y) = ((p as usize % w) as f64, (p as usize / w) as f64);
            let c = &rgb.data[p as usize * 3..p as usize * 3 + 3];
            for k in 0..3 {
                err += (coef[k][0] + coef[k][1] * x + coef[k][2] * y - c[k] as f64).powi(2);
            }
        }
        // misfit and range in sRGB scaled to about ΔE units
        let rms = (err / cnt).sqrt() * (100.0 / 255.0);
        // ramp direction: the direction of steepest colour change (G^T G)
        let (mut gxx, mut gyy, mut gxy) = (0f64, 0f64, 0f64);
        for k in 0..3 {
            gxx += coef[k][1] * coef[k][1];
            gyy += coef[k][2] * coef[k][2];
            gxy += coef[k][1] * coef[k][2];
        }
        let theta = 0.5 * (2.0 * gxy).atan2(gxx - gyy);
        let (ux, uy) = (theta.cos(), theta.sin());
        let (mut tmin, mut tmax) = (f64::INFINITY, f64::NEG_INFINITY);
        for &p in &region {
            let (x, y) = ((p as usize % w) as f64, (p as usize / w) as f64);
            let t = x * ux + y * uy;
            tmin = tmin.min(t);
            tmax = tmax.max(t);
        }
        let (cx, cy) = (sx / cnt, sy / cnt);
        let tc = cx * ux + cy * uy;
        let from = [cx + ux * (tmin - tc), cy + uy * (tmin - tc)];
        let to = [cx + ux * (tmax - tc), cy + uy * (tmax - tc)];
        let eval = |q: [f64; 2]| [0, 1, 2].map(|k| coef[k][0] + coef[k][1] * q[0] + coef[k][2] * q[1]);
        let (lf, lt) = (eval(from), eval(to));
        let range = ((lf[0] - lt[0]).powi(2) + (lf[1] - lt[1]).powi(2) + (lf[2] - lt[2]).powi(2)).sqrt() * (100.0 / 255.0);
        if range < min_range || rms > max_rms {
            continue;
        }
        let clamp = |c: [f64; 3]| c.map(|v| v.clamp(0.0, 255.0));
        out.push(GradientRegion { pixels: region, from, to, rgb_from: clamp(lf), rgb_to: clamp(lt) });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_a_ramp() {
        let (w, h) = (60, 40);
        let mut lab = Img::new(w, h, 3);
        let mut rgb = Img::new(w, h, 3);
        for y in 0..h {
            for x in 0..w {
                let i = (y * w + x) * 3;
                lab.data[i] = 30.0 + 50.0 * x as f32 / w as f32;
                lab.data[i + 1] = 10.0;
                lab.data[i + 2] = -20.0;
                rgb.data[i] = 40.0 + 180.0 * x as f32 / w as f32;
                rgb.data[i + 1] = 90.0;
                rgb.data[i + 2] = 200.0;
            }
        }
        let alpha = vec![true; w * h];
        let g = find(&lab, &rgb, &alpha, 3.0, 0.05, 15.0, 3.0);
        assert_eq!(g.len(), 1);
        let r = &g[0];
        let (a, b) = if r.rgb_from[0] < r.rgb_to[0] { (r.rgb_from, r.rgb_to) } else { (r.rgb_to, r.rgb_from) };
        assert!((a[0] - 40.0).abs() < 3.0 && (b[0] - 217.0).abs() < 3.0, "{r:?}");
        assert!((r.to[0] - r.from[0]).abs() > 50.0);
    }
}
