//! Thread colour helpers: naming, CIE Lab distance, GIMP palette (.gpl) parsing
//! (Ink/Stitch ships its thread charts as .gpl files, which we can load directly).

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PaletteEntry {
    pub name: String,
    pub code: String,
    pub rgb: [u8; 3],
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Palette {
    pub name: String,
    pub entries: Vec<PaletteEntry>,
}

/// Parse a GIMP palette file as used by Ink/Stitch (`palettes/InkStitch *.gpl`).
/// Lines look like `  0   0   0	Black 1000` (rgb, then "name code").
pub fn parse_gpl(text: &str) -> Palette {
    let mut name = String::new();
    let mut entries = Vec::new();
    for line in text.lines() {
        let l = line.trim();
        if l.is_empty() || l.starts_with('#') || l == "GIMP Palette" || l.starts_with("Columns:") {
            continue;
        }
        if let Some(n) = l.strip_prefix("Name:") {
            name = n.trim().to_string();
            continue;
        }
        let mut parts = l.split_whitespace();
        let (Some(r), Some(g), Some(b)) = (parts.next(), parts.next(), parts.next()) else { continue };
        let (Ok(r), Ok(g), Ok(b)) = (r.parse::<u8>(), g.parse::<u8>(), b.parse::<u8>()) else { continue };
        let rest: Vec<&str> = parts.collect();
        let (n, code) = match rest.split_last() {
            Some((last, init)) if !init.is_empty() && last.chars().any(|c| c.is_ascii_digit()) => {
                (init.join(" "), last.to_string())
            }
            _ => (rest.join(" "), String::new()),
        };
        entries.push(PaletteEntry { name: n, code, rgb: [r, g, b] });
    }
    Palette { name, entries }
}

fn srgb_to_linear(c: u8) -> f64 {
    let c = c as f64 / 255.0;
    if c <= 0.04045 {
        c / 12.92
    } else {
        ((c + 0.055) / 1.055).powf(2.4)
    }
}

/// sRGB → CIE L*a*b* (D65).
pub fn rgb_to_lab(c: [u8; 3]) -> [f64; 3] {
    let (r, g, b) = (srgb_to_linear(c[0]), srgb_to_linear(c[1]), srgb_to_linear(c[2]));
    let x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
    let y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    let z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
    let f = |t: f64| if t > 0.008856 { t.cbrt() } else { 7.787 * t + 16.0 / 116.0 };
    let (fx, fy, fz) = (f(x), f(y), f(z));
    [116.0 * fy - 16.0, 500.0 * (fx - fy), 200.0 * (fy - fz)]
}

pub fn lab_to_rgb(lab: [f64; 3]) -> [u8; 3] {
    let fy = (lab[0] + 16.0) / 116.0;
    let fx = fy + lab[1] / 500.0;
    let fz = fy - lab[2] / 200.0;
    let finv = |t: f64| if t.powi(3) > 0.008856 { t.powi(3) } else { (t - 16.0 / 116.0) / 7.787 };
    let (x, y, z) = (finv(fx) * 0.95047, finv(fy), finv(fz) * 1.08883);
    let r = 3.2406 * x - 1.5372 * y - 0.4986 * z;
    let g = -0.9689 * x + 1.8758 * y + 0.0415 * z;
    let b = 0.0557 * x - 0.2040 * y + 1.0570 * z;
    [srgb_encode(r), srgb_encode(g), srgb_encode(b)]
}

/// Linear light (0..1) to an sRGB byte: the byte whose band holds `c`. The
/// 255 band edges (where the rounded encoding steps up) are worked out once,
/// so a pixel costs a binary search, not three `powf` calls (a software
/// routine in WebAssembly: most of the digitizer's colour conversion time).
fn srgb_encode(c: f64) -> u8 {
    static EDGES: std::sync::OnceLock<Vec<f64>> = std::sync::OnceLock::new();
    let edges = EDGES.get_or_init(|| {
        let enc = |c: f64| if c <= 0.0031308 { 12.92 * c } else { 1.055 * c.powf(1.0 / 2.4) - 0.055 };
        // the edge below byte k+1: the smallest c that rounds up to it (bisection on
        // the exact encoding, so the bytes match the direct formula)
        (0..255)
            .map(|k| {
                let target = k as f64 + 0.5;
                let (mut lo, mut hi) = (0.0f64, 1.0f64);
                for _ in 0..80 {
                    let mid = 0.5 * (lo + hi);
                    if (enc(mid).clamp(0.0, 1.0) * 255.0) >= target {
                        hi = mid;
                    } else {
                        lo = mid;
                    }
                }
                hi
            })
            .collect()
    });
    edges.partition_point(|&e| e <= c) as u8
}

/// Perceptual colour distance (CIE76 ΔE; cheap and good enough for thread matching).
pub fn delta_e(a: [u8; 3], b: [u8; 3]) -> f64 {
    let (la, lb) = (rgb_to_lab(a), rgb_to_lab(b));
    ((la[0] - lb[0]).powi(2) + (la[1] - lb[1]).powi(2) + (la[2] - lb[2]).powi(2)).sqrt()
}

pub fn nearest_in_palette(c: [u8; 3], palette: &[[u8; 3]]) -> usize {
    let mut best = (0usize, f64::INFINITY);
    for (i, p) in palette.iter().enumerate() {
        let d = delta_e(c, *p);
        if d < best.1 {
            best = (i, d);
        }
    }
    best.0
}

const NAMED: &[(&str, [u8; 3])] = &[
    ("Black", [0x1c, 0x1c, 0x1c]),
    ("Charcoal", [0x36, 0x45, 0x4f]),
    ("Grey", [0x8a, 0x8d, 0x8f]),
    ("Silver", [0xc0, 0xc0, 0xc0]),
    ("Snow", [0xfa, 0xfa, 0xf7]),
    ("Cream", [0xf3, 0xe9, 0xc6]),
    ("Ivory", [0xe8, 0xe2, 0xd0]),
    ("Cherry", [0xd2, 0x1f, 0x3c]),
    ("Red", [0xc8, 0x10, 0x2e]),
    ("Crimson", [0x9e, 0x1b, 0x32]),
    ("Burgundy", [0x6d, 0x1a, 0x2a]),
    ("Coral", [0xff, 0x6f, 0x61]),
    ("Salmon", [0xf4, 0x9a, 0x8a]),
    ("Blush", [0xf2, 0xd6, 0xd4]),
    ("Rose Quartz", [0xd9, 0xb8, 0xbb]),
    ("Pink", [0xf4, 0x8f, 0xb1]),
    ("Fuchsia", [0xc2, 0x18, 0x7b]),
    ("Dusty Mauve", [0xa8, 0x8a, 0x8c]),
    ("Plum", [0x6a, 0x2c, 0x5e]),
    ("Lavender", [0xb6, 0xa6, 0xd6]),
    ("Violet", [0x6f, 0x42, 0xc1]),
    ("Navy", [0x1f, 0x2a, 0x56]),
    ("Royal Blue", [0x23, 0x4f, 0xb5]),
    ("Sky", [0x7e, 0xc8, 0xe3]),
    ("Turquoise", [0x1f, 0xb5, 0xb0]),
    ("Teal", [0x11, 0x6d, 0x6e]),
    ("Mint", [0xa8, 0xe6, 0xc5]),
    ("Kelly Green", [0x2e, 0x9b, 0x45]),
    ("Forest", [0x22, 0x5b, 0x34]),
    ("Olive", [0x76, 0x7a, 0x2c]),
    ("Lime", [0xb5, 0xd3, 0x3d]),
    ("Lemon", [0xf7, 0xe0, 0x4b]),
    ("Gold", [0xd4, 0xa0, 0x17]),
    ("Mustard", [0xc9, 0x9a, 0x2e]),
    ("Orange", [0xf2, 0x7a, 0x1a]),
    ("Tangerine", [0xff, 0x9a, 0x3c]),
    ("Peach", [0xf8, 0xc4, 0x9c]),
    ("Tan", [0xc8, 0xa2, 0x7a]),
    ("Caramel", [0xa8, 0x6b, 0x32]),
    ("Cocoa", [0x7a, 0x55, 0x48]),
    ("Chocolate", [0x4e, 0x2e, 0x22]),
    ("Taupe", [0x8b, 0x7d, 0x70]),
];

/// A friendly colour name for UI display.
pub fn nearest_name(c: [u8; 3]) -> String {
    let palette: Vec<[u8; 3]> = NAMED.iter().map(|(_, c)| *c).collect();
    NAMED[nearest_in_palette(c, &palette)].0.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn srgb_bytes_match_the_formula() {
        let direct = |c: f64| {
            let c = if c <= 0.0031308 { 12.92 * c } else { 1.055 * c.powf(1.0 / 2.4) - 0.055 };
            (c.clamp(0.0, 1.0) * 255.0).round() as u8
        };
        let mut rng = 0x2545_f491_4f6c_dd1du64;
        for i in 0..400_000u32 {
            let c = if i < 200_000 {
                i as f64 / 200_000.0 * 1.2 - 0.1
            } else {
                rng ^= rng << 13;
                rng ^= rng >> 7;
                rng ^= rng << 17;
                (rng >> 11) as f64 / (1u64 << 53) as f64
            };
            assert_eq!(srgb_encode(c), direct(c), "{c}");
        }
    }

    #[test]
    fn gpl() {
        let p = parse_gpl("GIMP Palette\nName: Test\nColumns: 4\n#\n  0   0   0\tBlack 1000\n255 255 255 White 1001\n");
        assert_eq!(p.name, "Test");
        assert_eq!(p.entries.len(), 2);
        assert_eq!(p.entries[0].name, "Black");
        assert_eq!(p.entries[0].code, "1000");
    }

    #[test]
    fn lab_roundtrip() {
        let c = [120, 40, 200];
        let back = lab_to_rgb(rgb_to_lab(c));
        assert!((back[0] as i32 - c[0] as i32).abs() <= 1);
    }
}
