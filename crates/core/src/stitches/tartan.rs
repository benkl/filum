//! Tartan fill, after Ink/Stitch (`lib/stitches/tartan_fill.py`,
//! `lib/tartan/`, GPL-3.0-or-later): a woven plaid in thread colours.
//!
//! The palette (Ink/Stitch's code, e.g. `(#0000FF)/2.4 (#FFFFFF)0.4 …`) lays
//! stripes across the shape — warp stripes one way, weft stripes the other,
//! reflected at the pivots of a symmetric sett. Rows run at the tartan angle
//! (a twill, -45° by default) and alternate between warp and weft every
//! `rows_per_thread` rows; a warp row takes the colour of the warp stripe it
//! crosses, a weft row that of the weft stripe. Stripes thinner than the
//! minimum width are sewn as running stitch lines. Herringbone: the twill
//! turns every `herringbone_width` mm.
//!
//! One object sews one colour (`layer`): every colour of a tartan is a layer
//! object, like the layers of a gradient.

use super::{Run, running::running_stitch};
use crate::geom::*;
use crate::model::{FillParams, TartanParams};
use crate::plan::flags;
use crate::stitches::fill::{stitch_row_pub, travel_path};

/// One stripe of a sett: a colour (None: a gap) and its width (mm), or a
/// running-stitch line (`stroke`, no width).
#[derive(Debug, Clone, PartialEq)]
pub struct Stripe {
    pub color: Option<String>,
    pub width: f64,
    pub stroke: bool,
}

/// A palette stripe as written in the code: colour, width (mm) and render
/// mode (0: not sewn, 1: sewn, 2: in the previous fill colour).
#[derive(Debug, Clone, PartialEq)]
pub struct CodeStripe {
    pub color: String,
    pub width: f64,
    pub render: u8,
}

/// Parse Ink/Stitch's palette code: warp and weft stripes (equal when there
/// is no `|`), and whether the sett is symmetric (`/` marks).
pub fn parse_palette(code: &str) -> (Vec<CodeStripe>, Vec<CodeStripe>, bool) {
    let symmetric = code.contains('/');
    let parse = |part: &str| -> Vec<CodeStripe> {
        let mut out = Vec::new();
        let mut rest = part;
        while let Some(open) = rest.find('(') {
            let Some(close) = rest[open..].find(')') else { break };
            let color = rest[open + 1..open + close].trim().to_string();
            let after = &rest[open + close + 1..];
            // render marks and the width
            let mut chars = after.chars().peekable();
            let mut render = 1u8;
            let mut width = String::new();
            let mut consumed = 0;
            while let Some(&c) = chars.peek() {
                match c {
                    '/' | ' ' if width.is_empty() => {}
                    '?' if width.is_empty() => render = 0,
                    '*' if width.is_empty() => render = 2,
                    c if c.is_ascii_digit() || c == '.' => width.push(c),
                    _ => break,
                }
                consumed += c.len_utf8();
                chars.next();
            }
            if let Ok(w) = width.parse::<f64>() {
                let ok = parse_color(&color).is_some();
                out.push(CodeStripe { color: if ok { color } else { "#000000".into() }, width: w, render: if ok { render } else { 0 } });
            }
            rest = &after[consumed..];
        }
        out
    };
    let mut parts = code.split('|');
    let warp = parse(parts.next().unwrap_or(""));
    let weft = parts.next().map(parse).unwrap_or_else(|| warp.clone());
    (warp, weft, symmetric)
}

/// `#rrggbb` of a colour written in the palette (hex or a CSS name).
pub fn parse_color(s: &str) -> Option<String> {
    use std::str::FromStr;
    let c = svgtypes::Color::from_str(s.trim()).ok()?;
    Some(format!("#{:02x}{:02x}{:02x}", c.red, c.green, c.blue))
}

/// The colours a tartan sews, in palette order (one layer each).
pub fn tartan_colors(code: &str) -> Vec<String> {
    let (warp, weft, _) = parse_palette(code);
    let mut out: Vec<String> = Vec::new();
    for s in warp.iter().chain(weft.iter()) {
        if s.render == 1 {
            if let Some(c) = parse_color(&s.color) {
                if !out.contains(&c) {
                    out.push(c);
                }
            }
        }
    }
    out
}

/// Ink/Stitch `_stripes_to_sett`: widths scaled, thin stripes as lines
/// between halves of the neighbouring colour, mirrored for a symmetric sett.
pub fn sett(stripes: &[CodeStripe], symmetric: bool, scale_pct: f64, min_width: f64) -> Vec<Stripe> {
    let scale = scale_pct / 100.0;
    // the colour that fills in where the code starts with a line or a "*" stripe
    let mut last_fill: Option<String> = stripes.iter().rev().find(|s| s.render == 1 && s.width * scale > min_width).map(|s| s.color.clone());
    if symmetric {
        last_fill = stripes.iter().find(|s| s.render == 1 && s.width * scale > min_width).map(|s| s.color.clone()).or(last_fill);
    }
    let (mut first_was_stroke, mut last_was_stroke, mut add) = (false, false, 0.0);
    let mut out: Vec<Stripe> = Vec::new();
    for s in stripes {
        let mut width = s.width * scale;
        let stroke = width <= min_width;
        match s.render {
            0 => {
                out.push(Stripe { color: None, width: width + add, stroke: false });
                last_fill = None;
                add = 0.0;
                last_was_stroke = false;
            }
            2 => {
                out.push(Stripe { color: last_fill.clone(), width: width + add, stroke: false });
                add = 0.0;
                last_was_stroke = false;
            }
            _ if stroke => {
                if out.is_empty() {
                    first_was_stroke = true;
                }
                width /= 2.0;
                out.push(Stripe { color: last_fill.clone(), width: width + add, stroke: false });
                out.push(Stripe { color: parse_color(&s.color), width: 0.0, stroke: true });
                add = width;
                last_was_stroke = true;
            }
            _ => {
                let c = parse_color(&s.color);
                out.push(Stripe { color: c.clone(), width: width + add, stroke: false });
                last_fill = c;
                add = 0.0;
                last_was_stroke = false;
            }
        }
    }
    if add > 0.0 {
        out.push(Stripe { color: last_fill, width: add, stroke: false });
    }
    if symmetric && out.len() > 2 {
        let mut rev: Vec<Stripe> = out[1..out.len() - 1].iter().rev().cloned().collect();
        if first_was_stroke && !rev.is_empty() {
            rev.pop();
        }
        if last_was_stroke && !rev.is_empty() {
            rev.remove(0);
        }
        out.extend(rev);
    }
    out
}

/// The bands (from, to) of `color` and its lines across [lo, hi], the sett
/// laid from `lo` on and repeated.
fn bands(sett: &[Stripe], color: &str, lo: f64, hi: f64) -> (Vec<(f64, f64)>, Vec<f64>) {
    let total: f64 = sett.iter().map(|s| s.width).sum();
    let (mut b, mut l) = (Vec::new(), Vec::new());
    if total <= 1e-6 {
        return (b, l);
    }
    let mut left = lo;
    let mut guard = 0;
    while left <= hi && guard < 100_000 {
        for s in sett {
            guard += 1;
            if left > hi {
                break;
            }
            if s.stroke {
                if s.color.as_deref() == Some(color) {
                    l.push(left);
                }
                continue;
            }
            if s.color.as_deref() == Some(color) && s.width > 0.0 {
                // neighbouring bands of one colour merge
                match b.last_mut() {
                    Some(last) if (last.1 - left).abs() < 1e-9 => last.1 = left + s.width,
                    _ => b.push((left, left + s.width)),
                }
            }
            left += s.width;
        }
    }
    (b, l)
}

/// Where a horizontal line at `y` lies inside the rings (even-odd).
fn scan(rings: &[Ring], y: f64) -> Vec<(f64, f64)> {
    let mut xs = Vec::new();
    for r in rings {
        let n = r.len();
        for i in 0..n {
            let (a, b) = (r[i], r[(i + 1) % n]);
            if (a.y <= y && b.y > y) || (b.y <= y && a.y > y) {
                xs.push(a.x + (y - a.y) / (b.y - a.y) * (b.x - a.x));
            }
        }
    }
    xs.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    xs.chunks(2).filter(|c| c.len() == 2 && c[1] - c[0] > 1e-6).map(|c| (c[0], c[1])).collect()
}

fn intersect(a: &[(f64, f64)], b: &[(f64, f64)]) -> Vec<(f64, f64)> {
    let mut out = Vec::new();
    for &(a0, a1) in a {
        for &(b0, b1) in b {
            let (lo, hi) = (a0.max(b0), a1.min(b1));
            if hi - lo > 1e-6 {
                out.push((lo, hi));
            }
        }
    }
    out.sort_by(|x, y| x.0.partial_cmp(&y.0).unwrap_or(std::cmp::Ordering::Equal));
    out
}

/// Bands in u = a·x + c mapped to x.
fn map_bands(bands: &[(f64, f64)], a: f64, c: f64, x_lo: f64, x_hi: f64) -> Vec<(f64, f64)> {
    if a.abs() < 1e-9 {
        return if bands.iter().any(|&(u0, u1)| c >= u0 && c < u1) { vec![(x_lo, x_hi)] } else { vec![] };
    }
    let mut out: Vec<(f64, f64)> = bands
        .iter()
        .map(|&(u0, u1)| {
            let (p, q) = ((u0 - c) / a, (u1 - c) / a);
            (p.min(q), p.max(q))
        })
        .collect();
    out.sort_by(|x, y| x.0.partial_cmp(&y.0).unwrap_or(std::cmp::Ordering::Equal));
    out
}

/// The tartan's colour `layer` over the shape: its fill rows, then its lines.
pub fn tartan(rings: &[Ring], p: &FillParams, t: &TartanParams, spacing: f64, start: Option<Point>, f: u8) -> Vec<Run> {
    if rings.is_empty() {
        return vec![];
    }
    let colors = tartan_colors(&t.palette);
    let Some(color) = colors.get(t.layer as usize) else { return vec![] };
    let (warp_code, weft_code, symmetric) = parse_palette(&t.palette);
    let sym = symmetric || t.symmetry;
    let warp = sett(&warp_code, sym, t.scale, t.min_stripe_width);
    let weft = sett(&weft_code, sym, t.scale, t.min_stripe_width);
    // the centre and a radius that covers any rotation
    let b = rings_bounds(rings);
    let c = pt((b.min_x + b.max_x) / 2.0, (b.min_y + b.max_y) / 2.0);
    let radius = rings.iter().flatten().map(|q| q.dist(c)).fold(0.0, f64::max);
    let warp_w: f64 = warp.iter().map(|s| s.width).sum();
    let weft_w: f64 = weft.iter().map(|s| s.width).sum();
    let extra = warp_w.max(weft_w).max(2.0 * spacing * t.rows_per_thread.max(1) as f64);
    let (lo, hi) = (-radius - extra, radius + extra);
    // Ink/Stitch lays the sett from the top left of a box round the centre, shifted by the offset
    let (warp_bands, warp_lines) = bands(&warp, color, lo - t.offset[0].abs(), hi);
    let (weft_bands, weft_lines) = bands(&weft, color, lo - t.offset[1].abs(), hi);
    let rot = t.rotate.to_radians();
    let rpt = t.rows_per_thread.max(1) as i64;
    let max_len = p.max_stitch_length.max(0.5);

    // rows at the twill angle (herringbone: +angle and −angle in alternate columns)
    let passes: Vec<(f64, Option<(f64, bool)>)> = if t.herringbone > 0.0 { vec![(t.angle, Some((t.herringbone, false))), (-t.angle, Some((t.herringbone, true)))] } else { vec![(t.angle, None)] };
    let mut pieces: Vec<(i64, f64, f64, f64, f64)> = Vec::new(); // (row, y, x0, x1, row angle)
    for &(angle, herring) in &passes {
        let a = angle.to_radians();
        let row_angle = rot + a;
        // the shape in the row frame (rows horizontal)
        let rr: Vec<Ring> = rings.iter().map(|r| r.iter().map(|q| (*q - c).rotate(-row_angle)).collect()).collect();
        let (ca, sa) = (a.cos(), a.sin());
        let n = ((hi - lo) / spacing).ceil() as i64;
        for i in 0..=n {
            let y = lo + i as f64 * spacing;
            let inside = scan(&rr, y);
            if inside.is_empty() {
                continue;
            }
            let (x_lo, x_hi) = (inside[0].0, inside[inside.len() - 1].1);
            // tartan frame along this row: ux = x·cos a − y·sin a, uy = x·sin a + y·cos a
            let warp_row = (i.rem_euclid(2 * rpt) < rpt) != herring.is_some_and(|h| h.1);
            let mut runs = if warp_row { map_bands(&warp_bands, ca, -y * sa, x_lo, x_hi) } else { map_bands(&weft_bands, sa, y * ca, x_lo, x_hi) };
            if let Some((w, odd)) = herring {
                // only the columns of this direction (column k: ux in [k·w, (k+1)·w))
                let k0 = ((lo - hi.abs()) / w).floor() as i64;
                let k1 = ((hi + hi.abs()) / w).ceil() as i64;
                let cols: Vec<(f64, f64)> = (k0..k1).filter(|k| (k.rem_euclid(2) == 1) == odd).map(|k| (k as f64 * w, (k + 1) as f64 * w)).collect();
                runs = intersect(&runs, &map_bands(&cols, ca, -y * sa, x_lo, x_hi));
            }
            for (x0, x1) in intersect(&runs, &inside) {
                pieces.push((i, y, x0, x1, row_angle));
            }
        }
    }
    // sew the pieces: along each row in turn, short hops inside the shape
    // stitched, longer ones as travel inside the shape
    let back = |q: Point, ang: f64| c + q.rotate(ang);
    let mut out: Vec<Run> = Vec::new();
    let mut run: Run = Vec::new();
    let mut left: Vec<(i64, f64, f64, f64, f64)> = pieces;
    let mut pos = start;
    let hop = spacing * (2 * rpt) as f64 * 1.6 + max_len;
    while !left.is_empty() {
        // the nearest piece end
        let (mut best, mut ltr, mut bd) = (0usize, true, f64::INFINITY);
        for (k, &(_, y, x0, x1, ang)) in left.iter().enumerate() {
            let ends = [(back(pt(x0, y), ang), true), (back(pt(x1, y), ang), false)];
            for (q, l) in ends {
                let d = pos.map_or(0.0, |p| p.dist(q));
                if d < bd {
                    (best, ltr, bd) = (k, l, d);
                }
            }
            if pos.is_none() {
                break;
            }
        }
        let (row, y, x0, x1, ang) = left.swap_remove(best);
        let entry = back(pt(if ltr { x0 } else { x1 }, y), ang);
        if let Some(prev) = run.last().map(|x| x.0) {
            if prev.dist(entry) <= hop && segment_inside(rings, prev, entry) {
                for q in running_stitch(&[prev, entry], max_len, 0.1).into_iter().skip(1) {
                    run.push((q, f));
                }
            } else if let Some(path) = travel_path(rings, prev, entry).filter(|path| polyline_length(path) <= 15.0) {
                for q in running_stitch(&path, p.travel_length.max(1.0), 0.1).into_iter().skip(1) {
                    run.push((q, f | flags::TRAVEL));
                }
            } else {
                out.push(std::mem::take(&mut run));
            }
        }
        let mut seg: Run = Vec::new();
        stitch_row_pub(&mut seg, y, x0, x1, row, max_len, p.staggers, ltr, f);
        for (q, fl) in seg {
            let q = back(q, ang);
            if run.last().is_none_or(|(l, _)| l.dist(q) > 1e-6) {
                run.push((q, fl));
            }
        }
        pos = run.last().map(|x| x.0);
    }
    if !run.is_empty() {
        out.push(run);
    }
    // the lines of this colour, after the fill (Ink/Stitch sews runs last)
    let lines_of = |positions: &[f64], weft_dir: bool| -> Vec<Vec<Point>> {
        positions
            .iter()
            .flat_map(|&u| {
                // a line across the tartan frame, clipped to the shape
                let (a0, a1) = if weft_dir { (pt(lo, u), pt(hi, u)) } else { (pt(u, lo), pt(u, hi)) };
                let line = [c + a0.rotate(rot), c + a1.rotate(rot)];
                clip_polyline(&line, rings)
            })
            .collect()
    };
    for l in lines_of(&warp_lines, false).into_iter().chain(lines_of(&weft_lines, true)) {
        if polyline_length(&l) > 0.5 {
            out.push(running_stitch(&l, p.travel_length.max(1.0), 0.1).into_iter().map(|q| (q, f)).collect());
        }
    }
    out.retain(|r| r.len() > 1);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_inkstitch_palette_code() {
        let (warp, weft, sym) = parse_palette("(#0000FF)/2.4 (#FFFFFF)0.4 (#0000ff)2.4 (#FF0000)?0.2 (black)*1 (#006400)/2.4");
        assert!(sym);
        assert_eq!(warp.len(), 6);
        assert_eq!(warp, weft);
        assert_eq!((warp[3].render, warp[4].render, warp[4].color.as_str()), (0, 2, "black"));
        assert_eq!(tartan_colors("(#0000FF)/2.4 (#FFFFFF)0.4 (#0000ff)2.4 (#006400)/2.4"), vec!["#0000ff", "#ffffff", "#006400"]);
        let (w2, f2, _) = parse_palette("(#ff0000)4 (#00ff00)4|(#0000ff)2");
        assert_eq!((w2.len(), f2.len()), (2, 1));
    }

    #[test]
    fn a_symmetric_sett_is_mirrored_and_thin_stripes_become_lines() {
        let (warp, _, sym) = parse_palette("(#ff0000)/4 (#ffffff)0.5 (#0000ff)/4");
        let s = sett(&warp, sym, 100.0, 1.0);
        // red 4, (red 0.25 + white line), blue 4.25, then mirrored without the pivots
        assert!(s.iter().any(|x| x.stroke && x.color.as_deref() == Some("#ffffff")));
        let total: f64 = s.iter().map(|x| x.width).sum();
        assert!(total > 8.0, "{total}");
    }

    #[test]
    fn every_colour_layer_sews_its_own_stripes() {
        let sq: Vec<Ring> = vec![vec![pt(0.0, 0.0), pt(40.0, 0.0), pt(40.0, 40.0), pt(0.0, 40.0)]];
        let p = FillParams::default();
        let code = "(#ff0000)/5 (#0000ff)/5";
        let n = |layer: u32| -> usize { tartan(&sq, &p, &TartanParams { palette: code.into(), layer, ..Default::default() }, 0.4, None, 0).iter().map(|r| r.len()).sum() };
        let (red, blue) = (n(0), n(1));
        assert!(red > 300 && blue > 300, "{red} {blue}");
        assert_eq!(n(2), 0, "no third colour");
        // all inside the shape
        let pts: Vec<Point> = tartan(&sq, &p, &TartanParams { palette: code.into(), layer: 0, ..Default::default() }, 0.4, None, 0).into_iter().flatten().map(|x| x.0).collect();
        assert!(pts.iter().all(|q| q.x > -0.6 && q.x < 40.6 && q.y > -0.6 && q.y < 40.6));
        // herringbone too
        let h: usize = tartan(&sq, &p, &TartanParams { palette: code.into(), layer: 0, herringbone: 6.0, ..Default::default() }, 0.4, None, 0).iter().map(|r| r.len()).sum();
        assert!(h > 300);
    }
}
