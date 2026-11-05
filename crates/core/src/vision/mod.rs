//! Computer-vision building blocks of the auto-digitizer: shared-boundary
//! vectorisation, edge-preserving filters, coherent line drawing, direction
//! fields, pixel-art upscaling and gradient detection. See each module for
//! the papers they follow.

pub mod boundary;
pub mod depixel;
pub mod filters;
pub mod gradients;
pub mod strokes;

/// CIEDE2000 colour difference of two Lab colours.
pub fn delta_e(a: [f64; 3], b: [f64; 3]) -> f64 {
    let (l1, a1, b1) = (a[0], a[1], a[2]);
    let (l2, a2, b2) = (b[0], b[1], b[2]);
    let rad = std::f64::consts::PI / 180.0;
    // sqrt, not hypot: a software routine in WebAssembly (see Point::length)
    let c1 = (a1 * a1 + b1 * b1).sqrt();
    let c2 = (a2 * a2 + b2 * b2).sqrt();
    let cm = (c1 + c2) / 2.0;
    let g = 0.5 * (1.0 - (cm.powi(7) / (cm.powi(7) + 25f64.powi(7))).sqrt());
    let a1p = a1 * (1.0 + g);
    let a2p = a2 * (1.0 + g);
    let c1p = (a1p * a1p + b1 * b1).sqrt();
    let c2p = (a2p * a2p + b2 * b2).sqrt();
    let hue = |x: f64, y: f64| {
        if x == 0.0 && y == 0.0 {
            0.0
        } else {
            let t = y.atan2(x) / rad;
            if t < 0.0 { t + 360.0 } else { t }
        }
    };
    let h1p = hue(a1p, b1);
    let h2p = hue(a2p, b2);
    let dlp = l2 - l1;
    let dcp = c2p - c1p;
    let mut dhp = 0.0;
    if c1p * c2p != 0.0 {
        dhp = h2p - h1p;
        if dhp > 180.0 {
            dhp -= 360.0;
        } else if dhp < -180.0 {
            dhp += 360.0;
        }
    }
    let dhp_big = 2.0 * (c1p * c2p).sqrt() * (dhp * rad / 2.0).sin();
    let lpm = (l1 + l2) / 2.0;
    let cpm = (c1p + c2p) / 2.0;
    let mut hpm = h1p + h2p;
    if c1p * c2p != 0.0 {
        if (h1p - h2p).abs() > 180.0 {
            hpm += if h1p + h2p < 360.0 { 360.0 } else { -360.0 };
        }
        hpm /= 2.0;
    }
    let t = 1.0 - 0.17 * ((hpm - 30.0) * rad).cos() + 0.24 * (2.0 * hpm * rad).cos() + 0.32 * ((3.0 * hpm + 6.0) * rad).cos() - 0.2 * ((4.0 * hpm - 63.0) * rad).cos();
    let dtheta = 30.0 * (-((hpm - 275.0) / 25.0).powi(2)).exp();
    let rc = 2.0 * (cpm.powi(7) / (cpm.powi(7) + 25f64.powi(7))).sqrt();
    let sl = 1.0 + 0.015 * (lpm - 50.0).powi(2) / (20.0 + (lpm - 50.0).powi(2)).sqrt();
    let sc = 1.0 + 0.045 * cpm;
    let sh = 1.0 + 0.015 * cpm * t;
    let rt = -(2.0 * dtheta * rad).sin() * rc;
    ((dlp / sl).powi(2) + (dcp / sc).powi(2) + (dhp_big / sh).powi(2) + rt * (dcp / sc) * (dhp_big / sh)).sqrt()
}

/// Decode standard base64 (padding optional, whitespace ignored).
pub fn base64_decode(s: &str) -> Vec<u8> {
    let val = |c: u8| -> Option<u32> {
        Some(match c {
            b'A'..=b'Z' => (c - b'A') as u32,
            b'a'..=b'z' => (c - b'a') as u32 + 26,
            b'0'..=b'9' => (c - b'0') as u32 + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            _ => return None,
        })
    };
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    let (mut acc, mut bits) = (0u32, 0u32);
    for &c in s.as_bytes() {
        let Some(v) = val(c) else { continue };
        acc = (acc << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(((acc >> bits) & 0xFF) as u8);
        }
    }
    out
}

/// Nearest-neighbour resample of a one-byte-per-pixel map to `w × h`.
pub fn resample_u8(src: &[u8], sw: usize, sh: usize, w: usize, h: usize) -> Vec<u8> {
    if sw == 0 || sh == 0 || src.len() < sw * sh {
        return vec![0; w * h];
    }
    let mut out = vec![0u8; w * h];
    for y in 0..h {
        let sy = ((y as f64 + 0.5) * sh as f64 / h as f64) as usize;
        for x in 0..w {
            let sx = ((x as f64 + 0.5) * sw as f64 / w as f64) as usize;
            out[y * w + x] = src[sy.min(sh - 1) * sw + sx.min(sw - 1)];
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ciede2000_reference_pairs() {
        // Sharma et al. test data
        let d = delta_e([50.0, 2.6772, -79.7751], [50.0, 0.0, -82.7485]);
        assert!((d - 2.0425).abs() < 1e-3, "{d}");
        let d = delta_e([50.0, -1.3802, -84.2814], [50.0, 0.0, -82.7485]);
        assert!((d - 1.0).abs() < 1e-3, "{d}");
    }

    #[test]
    fn base64_round() {
        assert_eq!(base64_decode("TWFu"), b"Man");
        assert_eq!(base64_decode("TWE="), b"Ma");
    }
}
