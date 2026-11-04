//! Colour matching: sRGB -> CIE L*a*b* (D65) and ΔE76 for reports, and
//! pystitch's red-mean distance for picking thread-table entries.

/// Converts an 8-bit sRGB colour to CIE L*a*b* (D65 white point).
pub fn srgb_to_lab(rgb: [u8; 3]) -> [f64; 3] {
    fn lin(c: u8) -> f64 {
        let c = c as f64 / 255.0;
        if c <= 0.04045 {
            c / 12.92
        } else {
            ((c + 0.055) / 1.055).powf(2.4)
        }
    }
    let (r, g, b) = (lin(rgb[0]), lin(rgb[1]), lin(rgb[2]));
    let x = 0.4124564 * r + 0.3575761 * g + 0.1804375 * b;
    let y = 0.2126729 * r + 0.7151522 * g + 0.0721750 * b;
    let z = 0.0193339 * r + 0.1191920 * g + 0.9503041 * b;
    // D65 reference white.
    let (xn, yn, zn) = (0.95047, 1.0, 1.08883);
    fn f(t: f64) -> f64 {
        const D: f64 = 6.0 / 29.0;
        if t > D * D * D {
            t.cbrt()
        } else {
            t / (3.0 * D * D) + 4.0 / 29.0
        }
    }
    let (fx, fy, fz) = (f(x / xn), f(y / yn), f(z / zn));
    [116.0 * fy - 16.0, 500.0 * (fx - fy), 200.0 * (fy - fz)]
}

/// CIE76 colour difference (Euclidean distance in L*a*b*).
pub fn delta_e76(a: [u8; 3], b: [u8; 3]) -> f64 {
    let la = srgb_to_lab(a);
    let lb = srgb_to_lab(b);
    ((la[0] - lb[0]).powi(2) + (la[1] - lb[1]).powi(2) + (la[2] - lb[2]).powi(2)).sqrt()
}

/// pystitch's `color_distance_red_mean` (compuphase.com/cmetric.htm): the
/// weighted RGB distance Ink/Stitch matches thread-table colours with.
pub fn red_mean_distance(a: [u8; 3], b: [u8; 3]) -> i64 {
    let (r1, g1, b1) = (a[0] as i64, a[1] as i64, a[2] as i64);
    let (r2, g2, b2) = (b[0] as i64, b[1] as i64, b[2] as i64);
    // int(round((r1 + r2) / 2)): Python rounds halves to even
    let sum = r1 + r2;
    let red_mean = if sum % 2 == 0 { sum / 2 } else if (sum / 2) % 2 == 0 { sum / 2 } else { sum / 2 + 1 };
    let (r, g, bb) = (r1 - r2, g1 - g2, b1 - b2);
    (((512 + red_mean) * r * r) >> 8) + 4 * g * g + (((767 - red_mean) * bb * bb) >> 8)
}

/// Index of the nearest colour among the `Some` slots, by pystitch's
/// red-mean distance (as Ink/Stitch picks Brother / Janome table colours).
/// Ties resolve to the later slot, matching pystitch's `<=` comparison.
pub fn nearest_index(rgb: [u8; 3], slots: &[Option<[u8; 3]>]) -> Option<usize> {
    let mut best: Option<(usize, i64)> = None;
    for (i, s) in slots.iter().enumerate() {
        if let Some(c) = s {
            let d = red_mean_distance(rgb, *c);
            if best.is_none_or(|(_, bd)| d <= bd) {
                best = Some((i, d));
            }
        }
    }
    best.map(|(i, _)| i)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lab_reference_values() {
        let w = srgb_to_lab([255, 255, 255]);
        assert!((w[0] - 100.0).abs() < 0.01 && w[1].abs() < 0.01 && w[2].abs() < 0.01);
        let k = srgb_to_lab([0, 0, 0]);
        assert!(k[0].abs() < 1e-9);
        let r = srgb_to_lab([255, 0, 0]);
        assert!(
            (r[0] - 53.24).abs() < 0.05 && (r[1] - 80.09).abs() < 0.1 && (r[2] - 67.20).abs() < 0.1
        );
    }

    #[test]
    fn nearest_picks_exact_and_skips_none() {
        let slots = [None, Some([0, 0, 0]), Some([255, 0, 0]), Some([0, 0, 255])];
        assert_eq!(nearest_index([250, 10, 10], &slots), Some(2));
        assert_eq!(nearest_index([0, 0, 0], &slots), Some(1));
        assert_eq!(nearest_index([1, 2, 3], &[None, None]), None);
        assert!(delta_e76([10, 20, 30], [10, 20, 30]) == 0.0);
    }
}
