//! Region operations on stitched areas: what an object covers, the
//! difference of a fill and the objects stacked on top of it (remove
//! overlaps), outward offsets of a union of objects (outlines,
//! appliqué backing, basting contours) and shape booleans.
//!
//! The operations are exact polygon booleans and round-join offsets
//! ([`crate::clip`], Clipper2), robust for self-intersections, holes and
//! overlapping sub-paths.

use crate::clip;
use crate::geom::{point_in_ring, rings_bounds, signed_area, Point, Rect, Ring};
use crate::model::{Object, StitchParams, SubPath};
use crate::stitches::{fill::fill_rings, satin::satin_geometry};

/// Area an object puts thread on.
#[derive(Debug, Clone)]
pub enum Cover {
    /// Even-odd filled region.
    Area(Vec<Ring>),
    /// Simple polygons, each filled on its own (satin sections).
    Polys(Vec<Ring>),
    /// A line of stitches with a half-width.
    Band { pts: Vec<Point>, half: f64 },
}

impl Cover {
    fn bounds(&self) -> Rect {
        match self {
            Cover::Area(r) | Cover::Polys(r) => rings_bounds(r),
            Cover::Band { pts, half } => {
                let mut b = Rect::EMPTY;
                for p in pts {
                    b.include(*p);
                }
                if !b.is_empty() {
                    b.min_x -= half;
                    b.min_y -= half;
                    b.max_x += half;
                    b.max_y += half;
                }
                b
            }
        }
    }
}

/// What an object covers. Running stitch counts as a thin band.
pub fn object_cover(obj: &Object) -> Vec<Cover> {
    match &obj.stitch {
        StitchParams::Fill(_) | StitchParams::None => {
            let rings = fill_rings(&obj.paths);
            if rings.is_empty() {
                vec![]
            } else {
                vec![Cover::Area(rings)]
            }
        }
        StitchParams::Applique(a) => {
            let rings = fill_rings(&obj.paths);
            let mut out = vec![];
            if !rings.is_empty() {
                for r in &rings {
                    let mut pts = r.clone();
                    pts.push(r[0]);
                    out.push(Cover::Band { pts, half: (a.cover_width * 0.5 + a.cover_offset.abs()).max(0.2) });
                }
                out.push(Cover::Area(rings));
            }
            out
        }
        StitchParams::Satin(p) => {
            let subpaths: Vec<SubPath> = if p.multi { obj.paths.clone() } else { vec![] };
            let groups: Vec<Vec<SubPath>> = if p.multi { subpaths.into_iter().map(|s| vec![s]).collect() } else { vec![obj.paths.clone()] };
            let mut polys = Vec::new();
            for g in groups {
                let single = crate::model::SatinParams { multi: false, ..p.clone() };
                if let Some(geo) = satin_geometry(&g, &single) {
                    for (a, b) in geo.sections {
                        let mut ring = a.clone();
                        ring.extend(b.iter().rev());
                        if ring.len() >= 3 {
                            polys.push(ring);
                        }
                    }
                }
            }
            if polys.is_empty() {
                vec![]
            } else {
                vec![Cover::Polys(polys)]
            }
        }
        StitchParams::Running(_) | StitchParams::Manual(_) => {
            // a zig-zag line covers its width
            let half = match &obj.stitch {
                StitchParams::Running(r) => r.zigzag.as_ref().map_or(0.3, |z| (z.width * 0.5 + z.pull_comp).max(0.3)),
                _ => 0.3,
            };
            obj.paths
                .iter()
                .map(|sp| {
                    let mut pts = sp.flatten(0.05);
                    if sp.closed && pts.len() > 2 {
                        pts.push(pts[0]);
                    }
                    Cover::Band { pts, half }
                })
                .collect()
        }
    }
}

pub fn covers_bounds(covers: &[Cover]) -> Rect {
    covers.iter().fold(Rect::EMPTY, |r, c| r.union(&c.bounds()))
}

/// The region a cover puts thread on.
fn cover_region(c: &Cover) -> clip::Region {
    match c {
        Cover::Area(r) => clip::region(r),
        Cover::Polys(p) => clip::polygons(p),
        Cover::Band { pts, half } => clip::band(pts, *half),
    }
}

fn covers_region(covers: &[Cover]) -> clip::Region {
    let parts: Vec<clip::Region> = covers.iter().map(cover_region).collect();
    clip::union_all(&parts)
}

/// Visible parts narrower than twice this (mm) are slivers of the clipping
/// (two outlines drawn along the same edge), not something to sew.
const SLIVER: f64 = 0.15;

/// `area` minus the covers, reaching `margin` mm under the upper objects
/// next to what stays visible (no gaps when the fabric moves). Only next to
/// it: where the lower and the upper object share an outline nothing of the
/// lower one shows, and a margin-wide strip along that edge would be sewn
/// for nothing — its underlay and travel piling up in a strip too narrow to
/// fill. `None` when nothing overlaps (keep the original shape). `_res` is
/// kept for API compatibility (the operations are exact).
pub fn subtract(area: &[Ring], covers: &[Cover], margin: f64, _res: f64) -> Option<Vec<Ring>> {
    subtract_min(area, covers, margin, 0.0)
}

/// `subtract`, without the leftover pieces and holes smaller than
/// `min_fragment` mm²: a piece that small isn't worth a jump, and a hole that
/// small isn't worth cutting (the stitches under it stay).
pub fn subtract_min(area: &[Ring], covers: &[Cover], margin: f64, min_fragment: f64) -> Option<Vec<Ring>> {
    let a = clip::region(area);
    let total = clip::area(&a);
    if total <= 1e-9 {
        return None;
    }
    let covered = covers_region(covers);
    let margin = margin.max(0.0);
    let rest = if margin > 0.0 {
        // what shows, without slivers, grown back by the margin under the covers
        let visible = clip::difference(&a, &covered);
        let opened = clip::offset(&clip::offset(&visible, -SLIVER), SLIVER);
        clip::intersect(&a, &clip::offset(&opened, margin))
    } else {
        clip::difference(&a, &covered)
    };
    if total - clip::area(&rest) < 1e-4 {
        return None;
    }
    let mut rings = clip::rings(&rest);
    if min_fragment > 0.0 {
        rings.retain(|g| g.len() >= 3 && signed_area(g).abs() >= min_fragment);
        // nothing left to cut after all
        if !rings.is_empty() && (total - clip::area(&clip::region(&rings))).abs() < 1e-4 {
            return None;
        }
    }
    Some(rings)
}

/// Does any part of the covers reach this wide (mm)? An outline or a thin
/// border has no part as wide as a fill.
pub fn has_width(covers: &[Cover], width: f64) -> bool {
    if width <= 0.0 {
        return true;
    }
    let r = covers_region(covers);
    clip::area(&clip::offset(&r, -width / 2.0)) > 1e-6
}

/// Lines with the parts under the covers taken out; they still reach
/// `margin` mm under a cover. Pieces shorter than `min_len` mm are dropped.
/// `None` when nothing is hidden.
pub fn clip_lines(lines: &[Vec<Point>], covers: &[Cover], margin: f64, min_len: f64) -> Option<Vec<Vec<Point>>> {
    let hidden = clip::rings(&clip::offset(&covers_region(covers), -margin.max(0.0)));
    if hidden.is_empty() {
        return None;
    }
    let inside = |p: Point| crate::geom::point_in_rings(p, &hidden);
    let mut out: Vec<Vec<Point>> = Vec::new();
    let mut cut = false;
    for line in lines {
        let mut piece: Vec<Point> = Vec::new();
        let flush = |piece: &mut Vec<Point>, out: &mut Vec<Vec<Point>>| {
            if piece.len() >= 2 && crate::geom::polyline_length(piece) >= min_len {
                out.push(std::mem::take(piece));
            } else {
                piece.clear();
            }
        };
        for w in line.windows(2) {
            let (a, b) = (w[0], w[1]);
            let n = ((a.dist(b) / 0.2).ceil() as usize).max(1);
            for k in 0..=n {
                if k == 0 && !piece.is_empty() {
                    continue;
                }
                let p = a.lerp(b, k as f64 / n as f64);
                if inside(p) {
                    cut = true;
                    flush(&mut piece, &mut out);
                } else {
                    piece.push(p);
                }
            }
        }
        flush(&mut piece, &mut out);
    }
    if !cut {
        return None;
    }
    // back to the drawn corners: drop the 0.2 mm samples on straight stretches
    Some(out.into_iter().map(|l| simplify(&l)).collect())
}

/// Collinear points removed (the samples `clip_lines` adds).
fn simplify(pts: &[Point]) -> Vec<Point> {
    let mut out: Vec<Point> = Vec::with_capacity(pts.len());
    for &p in pts {
        if out.len() >= 2 {
            let (a, b) = (out[out.len() - 2], out[out.len() - 1]);
            let cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
            if cross.abs() < 1e-6 && (b.x - a.x) * (p.x - b.x) + (b.y - a.y) * (p.y - b.y) >= 0.0 {
                out.pop();
            }
        }
        out.push(p);
    }
    out
}

/// Union of the covers grown by `offset` mm (outline / backing / basting shape).
pub fn outline(covers: &[Cover], offset: f64, _res: f64) -> Vec<Ring> {
    clip::rings(&clip::offset(&covers_region(covers), offset))
}

/// How an outline around objects is drawn (patch borders, backings).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct OutlineOptions {
    /// Distance from the design (mm; negative = inside).
    pub offset: f64,
    /// Join pieces closer than twice this and fill notches narrower than it
    /// (a morphological closing before the offset; 0 = follow every gap).
    pub bridge: f64,
    /// Only the outer edge: no outlines around holes.
    pub outer_only: bool,
    /// Pieces and holes smaller than this (mm²) are dropped: too small to sew.
    pub min_area: f64,
}

impl Default for OutlineOptions {
    fn default() -> Self {
        OutlineOptions { offset: 1.5, bridge: 0.0, outer_only: false, min_area: 0.0 }
    }
}

/// The outline of the covers with patch-border options (offset
/// outlines: join gaps, outer edge only, no specks).
pub fn outline_with(covers: &[Cover], o: &OutlineOptions) -> Vec<Ring> {
    let mut r = covers_region(covers);
    if o.bridge > 0.0 {
        // closing: grow, then shrink back — gaps narrower than 2 × bridge close
        r = clip::offset(&clip::offset(&r, o.bridge), -o.bridge);
    }
    let mut rings = clip::rings(&clip::offset(&r, o.offset));
    rings.retain(|g| g.len() >= 3 && signed_area(g).abs() >= o.min_area.max(1e-6));
    if o.outer_only {
        // a ring inside another (a hole, or an island in a hole) is not the outer edge
        let all = rings.clone();
        rings = all
            .iter()
            .enumerate()
            .filter(|(i, g)| !all.iter().enumerate().any(|(j, h)| j != *i && point_in_ring(g[0].lerp(g[1], 0.5), h)))
            .map(|(_, g)| g.clone())
            .collect();
    }
    rings
}

/// Boolean shape operation on objects (unite, minus front, intersect, exclude).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BoolOp {
    /// Everything together.
    Unite,
    /// The bottom object minus everything on top of it.
    MinusFront,
    /// Only where all objects overlap.
    Intersect,
    /// Where an odd number of objects overlap.
    Exclude,
}

/// One region of the overlap arrangement of several objects: the connected
/// area covered by exactly the objects in `owners` (indices, bottom first).
#[derive(Debug, Clone)]
pub struct Face {
    pub rings: Vec<Ring>,
    pub owners: Vec<usize>,
}

/// Faces smaller than this (mm²) are slivers of the clipping, not regions.
const FACE_MIN_AREA: f64 = 0.02;

/// Split the covers of several objects into the regions of their overlap
/// arrangement (the faces a shape builder works with): every
/// connected area covered by one particular set of objects.
pub fn arrangement(objects: &[Vec<Cover>]) -> Vec<Face> {
    let regions: Vec<clip::Region> = objects.iter().map(|c| covers_region(c)).collect();
    let mut pieces: Vec<(clip::Region, Vec<usize>)> = Vec::new();
    for (i, r) in regions.iter().enumerate() {
        let mut next = Vec::new();
        for (p, owners) in pieces {
            let inter = clip::intersect(&p, r);
            let diff = clip::difference(&p, r);
            if clip::area(&inter) > FACE_MIN_AREA {
                let mut o = owners.clone();
                o.push(i);
                next.push((inter, o));
            }
            if clip::area(&diff) > FACE_MIN_AREA {
                next.push((diff, owners));
            }
        }
        let rest = if i == 0 { r.clone() } else { clip::difference(r, &clip::union_all(regions[..i].iter())) };
        if clip::area(&rest) > FACE_MIN_AREA {
            next.push((rest, vec![i]));
        }
        pieces = next;
    }
    pieces
        .into_iter()
        .flat_map(|(reg, owners)| components(clip::rings(&reg)).into_iter().map(move |rings| Face { rings, owners: owners.clone() }))
        .filter(|f| crate::geom::rings_area(&f.rings) > FACE_MIN_AREA)
        .collect()
}

/// Rings of a region grouped into connected parts: every outer ring with the
/// holes inside it (islands in holes are parts of their own).
pub fn components(rings: Vec<Ring>) -> Vec<Vec<Ring>> {
    use crate::geom::{point_in_ring, signed_area};
    if rings.is_empty() {
        return vec![];
    }
    // the outer rings share the orientation of the largest ring
    let big = rings.iter().map(|r| signed_area(r)).fold(0.0f64, |a, b| if b.abs() > a.abs() { b } else { a });
    let (outers, holes): (Vec<Ring>, Vec<Ring>) = rings.into_iter().partition(|r| signed_area(r).signum() == big.signum());
    let mut parts: Vec<Vec<Ring>> = outers.into_iter().map(|o| vec![o]).collect();
    for h in holes {
        let Some(&p) = h.first() else { continue };
        // the smallest outer ring around the hole
        let host = parts
            .iter()
            .enumerate()
            .filter(|(_, part)| point_in_ring(p, &part[0]))
            .min_by(|a, b| signed_area(&a.1[0]).abs().partial_cmp(&signed_area(&b.1[0]).abs()).unwrap())
            .map(|(i, _)| i);
        if let Some(i) = host {
            parts[i].push(h);
        }
    }
    parts
}

/// The covers of several objects minus a region (Shape Builder: what is left
/// of every object after regions were merged or deleted).
pub fn subtract_region(object: &[Cover], cut: &[Ring]) -> Vec<Ring> {
    clip::rings(&clip::difference(&covers_region(object), &clip::region(cut)))
}

/// The union of several rings sets (merged faces).
pub fn union_rings(parts: &[Vec<Ring>]) -> Vec<Ring> {
    let regions: Vec<clip::Region> = parts.iter().map(|r| clip::region(r)).collect();
    clip::rings(&clip::union_all(regions.iter()))
}

/// Combine the covers of several objects (bottom first) into one region.
pub fn boolean(objects: &[Vec<Cover>], op: BoolOp, _res: f64) -> Vec<Ring> {
    let regions: Vec<clip::Region> = objects.iter().map(|c| covers_region(c)).collect();
    let Some(first) = regions.first() else { return vec![] };
    let out = match op {
        BoolOp::Unite => clip::union_all(&regions),
        BoolOp::MinusFront => clip::difference(first, &clip::union_all(&regions[1..])),
        BoolOp::Intersect => regions[1..].iter().fold(first.clone(), |acc, r| clip::intersect(&acc, r)),
        BoolOp::Exclude => regions[1..].iter().fold(first.clone(), |acc, r| clip::xor(&acc, r)),
    };
    clip::rings(&out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geom::{pt, rings_area};

    fn square(x: f64, y: f64, s: f64) -> Ring {
        vec![pt(x, y), pt(x + s, y), pt(x + s, y + s), pt(x, y + s)]
    }

    #[test]
    fn patch_border_outline() {
        // two squares 2 mm apart and a third far away, the first with a hole
        let a = vec![square(0.0, 0.0, 10.0), square(3.0, 3.0, 4.0)];
        let covers = vec![Cover::Area(a), Cover::Area(vec![square(12.0, 0.0, 10.0)]), Cover::Area(vec![square(60.0, 0.0, 0.5)])];
        let plain = outline_with(&covers, &OutlineOptions { offset: 0.5, ..Default::default() });
        assert_eq!(plain.len(), 4, "two pieces, the hole and the speck: {}", plain.len());
        // bridging 1.5 mm joins the two squares (gap 2 mm < 2 × 1.5); outer only drops the hole; the speck goes
        let patch = outline_with(&covers, &OutlineOptions { offset: 0.5, bridge: 1.5, outer_only: true, min_area: 2.0 });
        assert_eq!(patch.len(), 1, "one border: {}", patch.len());
        let b = rings_bounds(&patch);
        assert!(b.min_x < 0.0 && b.max_x > 22.0, "around both squares");
    }

    #[test]
    fn no_margin_strip_along_a_shared_outline() {
        // the upper half covers the lower square edge to edge: the lower one
        // reaches 0.6 mm under it, but not up along the shared outline
        let upper = vec![pt(0.0, 10.0), pt(20.0, 10.0), pt(20.0, 20.0), pt(0.0, 20.0)];
        let kept = subtract(&[square(0.0, 0.0, 20.0)], &[Cover::Area(vec![upper])], 0.6, 0.1).unwrap();
        let top = kept.iter().flatten().map(|q| q.y).fold(f64::MIN, f64::max);
        assert!((top - 10.6).abs() < 0.05, "reaches {top}");
        assert!((rings_area(&kept) - 20.0 * 10.6).abs() < 0.5, "{}", rings_area(&kept));
        // an object inside: the lower one keeps a 0.6 mm ring under its edge
        let inner = kept_inside();
        assert!((inner - (400.0 - 8.8 * 8.8)).abs() < 0.5, "{inner}");
    }
    fn kept_inside() -> f64 {
        let kept = subtract(&[square(0.0, 0.0, 20.0)], &[Cover::Area(vec![square(5.0, 5.0, 10.0)])], 0.6, 0.1).unwrap();
        rings_area(&kept)
    }

    #[test]
    fn arrangement_of_two_overlapping_squares() {
        let a = vec![Cover::Area(vec![square(0.0, 0.0, 20.0)])];
        let b = vec![Cover::Area(vec![square(10.0, 10.0, 20.0)])];
        let faces = arrangement(&[a, b]);
        // a only, both, b only
        assert_eq!(faces.len(), 3, "{:?}", faces.iter().map(|f| &f.owners).collect::<Vec<_>>());
        let both = faces.iter().find(|f| f.owners == vec![0, 1]).expect("overlap");
        assert!((rings_area(&both.rings) - 100.0).abs() < 1.0);
        assert!(faces.iter().any(|f| f.owners == vec![0] && (rings_area(&f.rings) - 300.0).abs() < 1.0));
    }

    #[test]
    fn arrangement_splits_disconnected_parts() {
        // a bar across a square: the square minus the bar is two parts
        let sq = vec![Cover::Area(vec![square(0.0, 0.0, 30.0)])];
        let bar = vec![Cover::Area(vec![vec![pt(-5.0, 12.0), pt(35.0, 12.0), pt(35.0, 18.0), pt(-5.0, 18.0)]])];
        let faces = arrangement(&[sq, bar]);
        assert_eq!(faces.iter().filter(|f| f.owners == vec![0]).count(), 2);
        assert_eq!(faces.iter().filter(|f| f.owners == vec![1]).count(), 2);
        assert_eq!(faces.iter().filter(|f| f.owners == vec![0, 1]).count(), 1);
    }

    #[test]
    fn a_ring_keeps_its_hole() {
        let ring = vec![Cover::Area(vec![square(0.0, 0.0, 30.0), square(10.0, 10.0, 10.0)])];
        let faces = arrangement(&[ring]);
        assert_eq!(faces.len(), 1);
        assert_eq!(faces[0].rings.len(), 2, "outer ring and hole");
        assert!((rings_area(&faces[0].rings) - 800.0).abs() < 2.0);
    }

    #[test]
    fn subtract_half() {
        // right half of a 20 mm square is covered: about half the area remains
        let r = subtract(&[square(0.0, 0.0, 20.0)], &[Cover::Area(vec![square(10.0, -5.0, 30.0)])], 0.0, 0.05).unwrap();
        let a = rings_area(&r);
        assert!((a - 200.0).abs() < 6.0, "area {a}");
    }

    #[test]
    fn subtract_keeps_margin_under_cover() {
        let r = subtract(&[square(0.0, 0.0, 20.0)], &[Cover::Area(vec![square(10.0, -5.0, 30.0)])], 1.0, 0.05).unwrap();
        let a = rings_area(&r);
        assert!((a - 220.0).abs() < 8.0, "area {a}");
    }

    #[test]
    fn untouched_is_none() {
        assert!(subtract(&[square(0.0, 0.0, 10.0)], &[Cover::Area(vec![square(50.0, 50.0, 5.0)])], 0.5, 0.1).is_none());
    }

    #[test]
    fn outline_grows() {
        let r = outline(&[Cover::Area(vec![square(0.0, 0.0, 10.0)])], 2.0, 0.05);
        assert_eq!(r.len(), 1);
        let a = rings_area(&r);
        // 14 x 14 square with rounded corners: 196 - (4 - π)·4
        assert!((a - 192.6).abs() < 4.0, "area {a}");
    }

    #[test]
    fn boolean_ops() {
        let a = vec![Cover::Area(vec![square(0.0, 0.0, 20.0)])];
        let b = vec![Cover::Area(vec![square(10.0, 0.0, 20.0)])];
        let area = |op| rings_area(&boolean(&[a.clone(), b.clone()], op, 0.05));
        assert!((area(BoolOp::Unite) - 600.0).abs() < 10.0);
        assert!((area(BoolOp::MinusFront) - 200.0).abs() < 8.0);
        assert!((area(BoolOp::Intersect) - 200.0).abs() < 8.0);
        assert!((area(BoolOp::Exclude) - 400.0).abs() < 10.0);
    }

    #[test]
    fn band_outline() {
        let r = outline(&[Cover::Band { pts: vec![pt(0.0, 0.0), pt(20.0, 0.0)], half: 1.0 }], 0.0, 0.05);
        let a = rings_area(&r);
        assert!((a - (40.0 + std::f64::consts::PI)).abs() < 3.0, "area {a}");
    }
}
