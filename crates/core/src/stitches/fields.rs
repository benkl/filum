//! Direction fields for streamline fills that do not come from a picture:
//! rows that follow the outline of the shape (curved fills) and rows that
//! follow the grid of a gradient mesh (curved mesh gradients), and rows that
//! follow the colour bands of any gradient (flow gradients).
//!
//! Directions are averaged as doubled angles (a direction and its reverse
//! are the same row), weighted by inverse squared distance — the field turns
//! smoothly from one part of the outline to the next. Where the outline gives
//! no clear direction (opposite sides cancel out) the rows lean towards the
//! fill angle.

use crate::geom::{pt, rings_bounds, Point, Ring};
use crate::model::{FlowField, FreePoint, GradientMesh, GradientParams};

/// Cells across the longer side of the shape.
const CELLS: f64 = 40.0;

/// Field grid over the bounds of the rings.
fn grid(rings: &[Ring]) -> (Point, f64, u32, u32) {
    let b = rings_bounds(rings);
    let cell = (b.width().max(b.height()) / CELLS).max(0.3);
    let cols = ((b.width() / cell).ceil() as u32 + 1).max(1);
    let rows = ((b.height() / cell).ceil() as u32 + 1).max(1);
    (pt(b.min_x - cell * 0.5, b.min_y - cell * 0.5), cell, cols, rows)
}

/// Blend a doubled-angle vector (c, s) of total weight `w` with the base
/// direction: clear directions keep theirs, unclear ones lean to the base.
fn settle(c: f64, s: f64, w: f64, base: f64, strength: f64) -> f32 {
    let clarity = if w > 1e-12 { ((c * c + s * s).sqrt() / w).clamp(0.0, 1.0) } else { 0.0 };
    // a clear tangent wins fully; a cancelled one gives way to the base
    let k = strength.clamp(0.0, 1.0) * ((clarity - 0.05) / 0.35).clamp(0.0, 1.0);
    let (bc, bs) = ((2.0 * base).cos(), (2.0 * base).sin());
    let (uc, us) = if w > 1e-12 && c.abs() + s.abs() > 1e-12 {
        let l = (c * c + s * s).sqrt();
        (c / l, s / l)
    } else {
        (bc, bs)
    };
    let (rc, rs) = (k * uc + (1.0 - k) * bc, k * us + (1.0 - k) * bs);
    (0.5 * rs.atan2(rc)) as f32
}

/// Rows that follow the outline: at every point the direction of the nearby
/// boundary. `base` (radians, y down) is the fill angle; `strength` 0 gives
/// straight rows along it, 1 rows that follow the shape fully.
pub fn shape_field(rings: &[Ring], base: f64, strength: f64) -> FlowField {
    let (origin, cell, cols, rows) = grid(rings);
    // boundary samples with their tangents
    let step = cell * 0.5;
    let mut samples: Vec<(Point, f64, f64)> = Vec::new(); // point, cos 2θ, sin 2θ
    for r in rings {
        let n = r.len();
        if n < 2 {
            continue;
        }
        for i in 0..n {
            let a = r[i];
            let b = r[(i + 1) % n];
            let d = b - a;
            let len = d.length();
            if len < 1e-9 {
                continue;
            }
            let th = d.y.atan2(d.x);
            let (c2, s2) = ((2.0 * th).cos(), (2.0 * th).sin());
            let k = (len / step).ceil().max(1.0) as usize;
            for j in 0..k {
                samples.push((a + d * ((j as f64 + 0.5) / k as f64), c2 * len / k as f64, s2 * len / k as f64));
            }
        }
    }
    let mut angles = Vec::with_capacity((cols * rows) as usize);
    for gy in 0..rows {
        for gx in 0..cols {
            let q = pt(origin.x + (gx as f64 + 0.5) * cell, origin.y + (gy as f64 + 0.5) * cell);
            let (mut c, mut s, mut w) = (0.0, 0.0, 0.0);
            for (p, c2, s2) in &samples {
                let d2 = p.dist(q).powi(2) + cell * cell * 0.25;
                let k = 1.0 / d2;
                c += c2 * k;
                s += s2 * k;
                // weight of the sample length, for the clarity ratio
                w += (c2 * c2 + s2 * s2).sqrt() * k;
            }
            angles.push(settle(c, s, w, base, strength));
        }
    }
    FlowField { origin: [origin.x, origin.y], cell, cols, rows, angles }
}

/// Rows that follow the rows of a gradient mesh: warping the mesh bends the
/// stitches with it.
pub fn mesh_field(rings: &[Ring], mesh: &GradientMesh, base: f64) -> Option<FlowField> {
    let (r, c) = (mesh.rows as usize, mesh.cols as usize);
    if r < 2 || c < 2 || mesh.nodes.len() < r * c {
        return None;
    }
    let node = |i: usize, j: usize| pt(mesh.nodes[i * c + j].p[0], mesh.nodes[i * c + j].p[1]);
    // tangent of the mesh row through every node
    let mut samples: Vec<(Point, f64, f64)> = Vec::new();
    for i in 0..r {
        for j in 0..c {
            let a = node(i, j.saturating_sub(1));
            let b = node(i, (j + 1).min(c - 1));
            let d = b - a;
            if d.length() < 1e-9 {
                continue;
            }
            let th = d.y.atan2(d.x);
            samples.push((node(i, j), (2.0 * th).cos(), (2.0 * th).sin()));
            // the middle of each patch edge too: a denser, smoother field
            if j + 1 < c {
                let m = (node(i, j) + node(i, j + 1)) * 0.5;
                let e = node(i, j + 1) - node(i, j);
                let th = e.y.atan2(e.x);
                samples.push((m, (2.0 * th).cos(), (2.0 * th).sin()));
            }
        }
    }
    let (origin, cell, cols, rows) = grid(rings);
    let mut angles = Vec::with_capacity((cols * rows) as usize);
    for gy in 0..rows {
        for gx in 0..cols {
            let q = pt(origin.x + (gx as f64 + 0.5) * cell, origin.y + (gy as f64 + 0.5) * cell);
            let (mut cc, mut ss, mut w) = (0.0, 0.0, 0.0);
            for (p, c2, s2) in &samples {
                let k = 1.0 / (p.dist(q).powi(2) + cell * cell);
                cc += c2 * k;
                ss += s2 * k;
                w += k;
            }
            angles.push(settle(cc, ss, w, base, 1.0));
        }
    }
    Some(FlowField { origin: [origin.x, origin.y], cell, cols, rows, angles })
}

/// Rows around the colour points of a freeform gradient: inside a point's
/// spread they circle it (every colour blob gets its own swirl); further out
/// they follow the outline of the shape.
pub fn points_field(rings: &[Ring], points: &[FreePoint], base: f64) -> FlowField {
    let mut f = shape_field(rings, base, 1.0);
    if points.is_empty() {
        return f;
    }
    for gy in 0..f.rows {
        for gx in 0..f.cols {
            let q = pt(f.origin[0] + (gx as f64 + 0.5) * f.cell, f.origin[1] + (gy as f64 + 0.5) * f.cell);
            let i = (gy * f.cols + gx) as usize;
            // the shape's direction, as the background
            let a0 = f.angles[i] as f64;
            let (mut c, mut s) = ((2.0 * a0).cos() * 0.15, (2.0 * a0).sin() * 0.15);
            let mut reach = 0.0f64;
            for pnt in points {
                let d = q - pt(pnt.p[0], pnt.p[1]);
                let r = d.length();
                if r < 1e-6 {
                    continue;
                }
                let spread = pnt.spread.max(1.0);
                let w = (-(r / spread).powi(2)).exp();
                // tangential: around the point
                let th = d.y.atan2(d.x) + std::f64::consts::FRAC_PI_2;
                c += w * (2.0 * th).cos();
                s += w * (2.0 * th).sin();
                reach = reach.max(w);
            }
            if reach > 0.02 {
                f.angles[i] = (0.5 * s.atan2(c)) as f32;
            }
        }
    }
    f
}

/// Cells across the longer side of a colour field.
const COLOUR_CELLS: f64 = 64.0;

/// Rows along the colour bands of a gradient (or across them): the gradient
/// is rendered as an image of its colour mix — two pixels per field cell,
/// over the bounds of the shape — and the rows follow the image's structure
/// tensor, as the digitizer reads a photo. Where the colour does not change
/// (past the last stop, inside a flat band) the tensor is summed over ever
/// larger windows, so the direction comes from the nearest colour change.
/// `None` when the gradient has no colour change at all.
pub fn colour_field(rings: &[Ring], g: &GradientParams, base: f64, across: bool) -> Option<FlowField> {
    let b = rings_bounds(rings);
    if !(b.width() > 0.0 && b.height() > 0.0) {
        return None;
    }
    let cell = (b.width().max(b.height()) / COLOUR_CELLS).max(0.2);
    let cols = ((b.width() / cell).ceil() as usize + 1).max(1);
    let rows = ((b.height() / cell).ceil() as usize + 1).max(1);
    let origin = pt(b.min_x - cell * 0.5, b.min_y - cell * 0.5);
    // the image: colour mix per pixel, one extra pixel all round for the differences
    let px = cell * 0.5;
    let (w, h) = (cols * 2 + 2, rows * 2 + 2);
    let n = g.stops.len().max(1);
    let mut img = vec![0f32; w * h * n];
    for y in 0..h {
        for x in 0..w {
            let q = pt(origin.x + (x as f64 - 0.5) * px, origin.y + (y as f64 - 0.5) * px);
            let wt = super::gradient::weights_at(g, q);
            for (k, v) in wt.iter().take(n).enumerate() {
                img[(y * w + x) * n + k] = *v as f32;
            }
        }
    }
    // structure tensor per field cell: the sum over its 2 × 2 pixels
    let (cw, ch) = (cols, rows);
    let mut t = vec![[0f64; 3]; cw * ch];
    for y in 1..h - 1 {
        for x in 1..w - 1 {
            let (gx, gy) = (((x - 1) / 2).min(cw - 1), ((y - 1) / 2).min(ch - 1));
            let cell_t = &mut t[gy * cw + gx];
            for k in 0..n {
                let dx = (img[(y * w + x + 1) * n + k] - img[(y * w + x - 1) * n + k]) as f64;
                let dy = (img[((y + 1) * w + x) * n + k] - img[((y - 1) * w + x) * n + k]) as f64;
                cell_t[0] += dx * dx;
                cell_t[1] += dx * dy;
                cell_t[2] += dy * dy;
            }
        }
    }
    let peak = t.iter().map(|v| v[0] + v[2]).fold(0.0, f64::max);
    if peak < 1e-12 {
        return None;
    }
    // summed-area table: any window sum in O(1)
    let sw = cw + 1;
    let mut sat = vec![[0f64; 3]; sw * (ch + 1)];
    for y in 0..ch {
        for x in 0..cw {
            for c in 0..3 {
                sat[(y + 1) * sw + x + 1][c] = t[y * cw + x][c] + sat[y * sw + x + 1][c] + sat[(y + 1) * sw + x][c] - sat[y * sw + x][c];
            }
        }
    }
    let window = |x: usize, y: usize, r: usize| -> [f64; 3] {
        let (x0, y0) = (x.saturating_sub(r), y.saturating_sub(r));
        let (x1, y1) = ((x + r + 1).min(cw), (y + r + 1).min(ch));
        let mut o = [0.0; 3];
        for (c, v) in o.iter_mut().enumerate() {
            *v = sat[y1 * sw + x1][c] - sat[y0 * sw + x1][c] - sat[y1 * sw + x0][c] + sat[y0 * sw + x0][c];
        }
        o
    };
    // enough colour change in a window to read a direction from
    let enough = peak * 1e-3;
    let rmax = cw.max(ch);
    let turn = if across { 0.0 } else { std::f64::consts::FRAC_PI_2 };
    let mut angles = Vec::with_capacity(cw * ch);
    for y in 0..ch {
        for x in 0..cw {
            // a little smoothing always; wider until there is colour change
            let mut r = 1;
            let mut s = window(x, y, r);
            while s[0] + s[2] < enough && r < rmax {
                r *= 2;
                s = window(x, y, r);
            }
            let (a, c2, s2) = (s[0], s[1], s[2]);
            let a = if a + s2 > 1e-15 {
                // the colours change along φ; their bands run across it
                0.5 * (2.0 * c2).atan2(a - s2) + turn
            } else {
                base
            };
            angles.push(a as f32);
        }
    }
    Some(FlowField { origin: [origin.x, origin.y], cell, cols: cols as u32, rows: rows as u32, angles })
}

/// Rows along a guide line at an even distance from it (Ink/Stitch guided
/// fill, parallel offset / buffer): the direction at every point is the
/// guide's direction where it comes nearest — the offset curves of the guide.
/// Beyond the guide's ends the rows run on straight (`buffer` off) or turn
/// round the end (`buffer` on).
pub fn guide_field(rings: &[Ring], guide: &[Point], buffer: bool) -> Option<FlowField> {
    if guide.len() < 2 {
        return None;
    }
    let b = rings_bounds(rings);
    let cell = (b.width().max(b.height()) / 64.0).max(0.2);
    let cols = ((b.width() / cell).ceil() as u32 + 1).max(1);
    let rows = ((b.height() / cell).ceil() as u32 + 1).max(1);
    let origin = pt(b.min_x - cell * 0.5, b.min_y - cell * 0.5);
    let mut angles = Vec::with_capacity((cols * rows) as usize);
    let last = guide.len() - 1;
    for gy in 0..rows {
        for gx in 0..cols {
            let q = pt(origin.x + (gx as f64 + 0.5) * cell, origin.y + (gy as f64 + 0.5) * cell);
            // nearest point of the guide (segment and parameter)
            let (mut best, mut seg, mut tt) = (f64::INFINITY, 0usize, 0.0);
            for i in 0..last {
                let (a, c) = (guide[i], guide[i + 1]);
                let ab = c - a;
                let l2 = ab.length_sq().max(1e-12);
                let t = ((q - a).dot(ab) / l2).clamp(0.0, 1.0);
                let d = (a + ab * t).dist(q);
                if d < best {
                    best = d;
                    seg = i;
                    tt = t;
                }
            }
            let dir = guide[seg + 1] - guide[seg];
            let at_end = (seg == 0 && tt <= 1e-9) || (seg == last - 1 && tt >= 1.0 - 1e-9);
            let a = if buffer && at_end {
                // round the end: across the line from the end point
                let e = if tt <= 1e-9 { guide[0] } else { guide[last] };
                let v = q - e;
                if v.length() < 1e-9 { dir.y.atan2(dir.x) } else { v.y.atan2(v.x) + std::f64::consts::FRAC_PI_2 }
            } else {
                dir.y.atan2(dir.x)
            };
            angles.push(a as f32);
        }
    }
    Some(FlowField { origin: [origin.x, origin.y], cell, cols, rows, angles })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir_at(f: &FlowField, x: f64, y: f64) -> f64 {
        let gx = ((x - f.origin[0]) / f.cell).floor() as usize;
        let gy = ((y - f.origin[1]) / f.cell).floor() as usize;
        f.angles[gy * f.cols as usize + gx] as f64
    }

    #[test]
    fn a_ring_field_runs_around() {
        // a circle: near the rim the rows run along it (tangential)
        let ring: Ring = (0..72).map(|k| {
            let a = k as f64 / 72.0 * std::f64::consts::TAU;
            pt(20.0 + 15.0 * a.cos(), 20.0 + 15.0 * a.sin())
        }).collect();
        let f = shape_field(&[ring], 0.0, 1.0);
        // right of the centre (east rim): rows vertical
        let a = dir_at(&f, 33.0, 20.0);
        assert!((a.abs() - std::f64::consts::FRAC_PI_2).abs() < 0.25, "east: {a}");
        // top rim: rows horizontal
        let a = dir_at(&f, 20.0, 7.0);
        assert!(a.abs() < 0.25 || (a.abs() - std::f64::consts::PI).abs() < 0.25, "north: {a}");
    }

    #[test]
    fn rows_circle_a_colour_point() {
        let sq: Ring = vec![pt(0.0, 0.0), pt(40.0, 0.0), pt(40.0, 40.0), pt(0.0, 40.0)];
        let f = points_field(&[sq], &[FreePoint { p: [20.0, 20.0], c: 0, spread: 8.0 }], 0.0);
        // east of the point the rows run north–south, north of it east–west
        let e = dir_at(&f, 25.0, 20.0);
        let n = dir_at(&f, 20.0, 15.0);
        assert!((e.abs() - std::f64::consts::FRAC_PI_2).abs() < 0.2, "east {e}");
        assert!(n.abs() < 0.2 || (n.abs() - std::f64::consts::PI).abs() < 0.2, "north {n}");
    }

    fn grad(kind: crate::model::GradientKind) -> GradientParams {
        use crate::model::GradientStop;
        GradientParams {
            kind,
            from: [20.0, 20.0],
            to: [35.0, 20.0],
            stops: vec![GradientStop { pos: 0.0, ..Default::default() }, GradientStop { pos: 1.0, ..Default::default() }],
            ..Default::default()
        }
    }

    #[test]
    fn colour_fields_follow_the_bands() {
        use crate::model::GradientKind;
        use std::f64::consts::FRAC_PI_2;
        let sq: Ring = vec![pt(0.0, 0.0), pt(40.0, 0.0), pt(40.0, 40.0), pt(0.0, 40.0)];
        let vertical = |a: f64| (a.rem_euclid(std::f64::consts::PI) - FRAC_PI_2).abs() < 0.12;
        let horizontal = |a: f64| { let m = a.rem_euclid(std::f64::consts::PI); m < 0.12 || m > std::f64::consts::PI - 0.12 };
        // linear left → right: the bands (and rows) are vertical, also past the end
        let f = colour_field(&[sq.clone()], &grad(GradientKind::Linear), 0.0, false).unwrap();
        for x in [5.0, 25.0, 38.0] {
            assert!(vertical(dir_at(&f, x, 20.0)), "linear at {x}: {}", dir_at(&f, x, 20.0));
        }
        // across: horizontal rows through the colours
        let f = colour_field(&[sq.clone()], &grad(GradientKind::Linear), 0.0, true).unwrap();
        assert!(horizontal(dir_at(&f, 25.0, 20.0)));
        // radial: circles around the centre
        let f = colour_field(&[sq.clone()], &grad(GradientKind::Radial), 0.0, false).unwrap();
        assert!(vertical(dir_at(&f, 28.0, 20.0)), "east {}", dir_at(&f, 28.0, 20.0));
        assert!(horizontal(dir_at(&f, 20.0, 12.0)), "north {}", dir_at(&f, 20.0, 12.0));
        // one colour: nothing to follow
        let mut one = grad(GradientKind::Linear);
        one.stops.truncate(1);
        assert!(colour_field(&[sq], &one, 0.0, false).is_none());
    }

    #[test]
    fn a_guide_field_runs_along_the_guide() {
        let sq: Ring = vec![pt(0.0, 0.0), pt(40.0, 0.0), pt(40.0, 40.0), pt(0.0, 40.0)];
        // an L-shaped guide: along x, then down
        let guide = [pt(5.0, 5.0), pt(30.0, 5.0), pt(30.0, 35.0)];
        let f = guide_field(&[sq.clone()], &guide, false).unwrap();
        let horiz = |a: f64| { let m = a.rem_euclid(std::f64::consts::PI); m < 0.15 || m > std::f64::consts::PI - 0.15 };
        let vert = |a: f64| (a.rem_euclid(std::f64::consts::PI) - std::f64::consts::FRAC_PI_2).abs() < 0.15;
        assert!(horiz(dir_at(&f, 15.0, 12.0)), "near the first leg: along x");
        assert!(vert(dir_at(&f, 22.0, 25.0)), "near the second leg: along y");
        // buffer: past the start the rows turn round the end
        let fb = guide_field(&[sq], &guide, true).unwrap();
        assert!(vert(dir_at(&fb, 1.0, 5.0)), "left of the start: round it (vertical)");
    }

    #[test]
    fn strength_zero_is_straight() {
        let sq: Ring = vec![pt(0.0, 0.0), pt(30.0, 0.0), pt(30.0, 10.0), pt(0.0, 10.0)];
        let f = shape_field(&[sq], 0.7, 0.0);
        assert!(f.angles.iter().all(|a| (*a as f64 - 0.7).abs() < 1e-4));
    }

    #[test]
    fn a_mesh_field_follows_the_rows() {
        // a 3 × 3 mesh whose middle row bends up
        let mut nodes = Vec::new();
        for i in 0..3 {
            for j in 0..3 {
                let y = i as f64 * 10.0 - if i == 1 && j == 1 { 4.0 } else { 0.0 };
                nodes.push(crate::model::MeshNode { p: [j as f64 * 10.0, y], c: 0 });
            }
        }
        let mesh = GradientMesh { rows: 3, cols: 3, nodes };
        let sq: Ring = vec![pt(0.0, 0.0), pt(20.0, 0.0), pt(20.0, 20.0), pt(0.0, 20.0)];
        let f = mesh_field(&[sq], &mesh, 1.2).unwrap();
        // left of the bump the row rises (negative y), right of it falls
        let l = dir_at(&f, 5.0, 8.0);
        let r = dir_at(&f, 15.0, 8.0);
        assert!(l < -0.05 && r > 0.05, "{l} {r}");
    }
}
