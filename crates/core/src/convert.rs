//! Shape conversions behind the Path menu's conversion tools. Ports of
//! Ink/Stitch's extensions (GPL-3.0-or-later), on Clipper2 polygons instead of
//! Shapely:
//!
//! - [`fill_to_satin`]: a fill shape cut by rung lines into satin columns
//!   (`fill_to_satin.py`);
//! - [`centre_lines`]: the centre lines (medial axis) of a shape, with their
//!   widths (`fill_to_stroke.py`) — a shared building block for anything that
//!   needs a shape's skeleton;
//! - [`satin_centre_line`]: the centre line of a two-rail satin
//!   (`satin_to_stroke.py`);
//! - [`break_apart`]: repair a fill and split it into its separate shapes
//!   (`break_apart.py`);
//! - [`knockdown_shape`]: the area around a selection for a knockdown fill
//!   (`knockdown_fill.py`).
//!
//! Coordinates are millimetres; outputs use `[x, y]` arrays for the UI.

use std::collections::HashMap;

use serde::Serialize;

use crate::clip;
use crate::geom::{cumulative_lengths, point_in_ring, pt, segment_intersection, signed_area, simplify, substring, Point, Rect, Ring};
use crate::model::{SatinParams, SubPath};
use crate::region::{components, Cover};

pub type V2 = [f64; 2];

fn arr(p: &[Point]) -> Vec<V2> {
    p.iter().map(|q| q.arr()).collect()
}

/// Append a polyline, skipping its first point when it repeats the last one.
fn extend(dst: &mut Vec<Point>, src: &[Point]) {
    for (i, p) in src.iter().enumerate() {
        if i == 0 && dst.last().is_some_and(|l| l.dist(*p) < 1e-6) {
            continue;
        }
        dst.push(*p);
    }
}

/// The even-odd region of `rings` as polygons (outer ring, then its holes),
/// cleaned of self-intersections and wound so the area lies on the same side
/// of every ring (outers positive, holes negative signed area).
pub fn polygons(rings: &[Ring]) -> Vec<Vec<Ring>> {
    let clean = clip::rings(&clip::region(rings));
    components(clean)
        .into_iter()
        .map(|mut poly| {
            for (k, r) in poly.iter_mut().enumerate() {
                let a = signed_area(r);
                if (k == 0) != (a > 0.0) {
                    r.reverse();
                }
            }
            poly
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Fill to satin

/// A satin column as two rails and the rungs between them.
#[derive(Debug, Clone, Serialize)]
pub struct SatinShape {
    pub rails: [Vec<V2>; 2],
    pub rungs: Vec<Vec<V2>>,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct FillToSatin {
    pub satins: Vec<SatinShape>,
    /// Polygons no rung crosses (rings), left as they are.
    pub unused: Vec<Vec<Vec<V2>>>,
    /// Indices of the rungs that cut a shape.
    pub used_rungs: Vec<usize>,
}

/// Where the outline round a column end is split into the two rails (shares
/// of its length). Ink/Stitch splits at 40 % / 50 %; the gap is centred here so
/// the column ends symmetrically at the tip.
const END_SPLIT: (f64, f64) = (0.45, 0.55);

/// One end of a rung on the outline: (rung, which end).
type Cut = (usize, usize);

struct Section {
    pts: Vec<Point>,
    start: Cut,
    end: Cut,
}

/// Ink/Stitch "Fill to satin": rung lines crossing the outline of a fill
/// exactly twice cut it into sections; the outline pieces between two rungs
/// become the rails, pieces with one rung (the ends) are split in two, and
/// pieces joined by rungs are chained into as few satins as possible. Where
/// more than two rungs meet one piece (a junction) the satins end, as in
/// Ink/Stitch. `skip_end_section`: start and end at the first and last rung.
pub fn fill_to_satin(rings: &[Ring], rungs: &[Vec<Point>], skip_end_section: bool) -> FillToSatin {
    let mut out = FillToSatin::default();
    let mut used = vec![false; rungs.len()];
    for poly in polygons(rings) {
        let satins = polygon_to_satins(&poly, rungs, skip_end_section, &mut used);
        if satins.is_none() {
            out.unused.push(poly.iter().map(|r| arr(r)).collect());
        }
        out.satins.extend(satins.unwrap_or_default());
    }
    out.used_rungs = (0..rungs.len()).filter(|&k| used[k]).collect();
    out
}

/// Crossings of a polyline with the rings: (ring, arc position, point, position along the line).
fn crossings(line: &[Point], rings: &[Ring], cums: &[Vec<f64>]) -> Vec<(usize, f64, Point, f64)> {
    let lc = cumulative_lengths(line);
    let mut hits: Vec<(usize, f64, Point, f64)> = Vec::new();
    for (ri, r) in rings.iter().enumerate() {
        let n = r.len();
        for i in 0..n {
            let (a, b) = (r[i], r[(i + 1) % n]);
            for j in 1..line.len() {
                if let Some((t, q)) = segment_intersection(a, b, line[j - 1], line[j]) {
                    let along = lc[j - 1] + line[j - 1].dist(q);
                    if !hits.iter().any(|h| h.2.dist(q) < 1e-6) {
                        hits.push((ri, cums[ri][i] + t * a.dist(b), q, along));
                    }
                }
            }
        }
    }
    hits
}

/// The closed ring as a polyline from `from` to `to` (arc positions), going forward.
fn ring_arc(closed: &[Point], cum: &[f64], from: f64, to: f64) -> Vec<Point> {
    let len = *cum.last().unwrap();
    if to > from + 1e-9 {
        return substring(closed, cum, from, to);
    }
    let mut a = substring(closed, cum, from, len);
    extend(&mut a, &substring(closed, cum, 0.0, to));
    a
}

fn polygon_to_satins(poly: &[Ring], rungs: &[Vec<Point>], skip_end: bool, used: &mut [bool]) -> Option<Vec<SatinShape>> {
    let closed: Vec<Vec<Point>> = poly
        .iter()
        .map(|r| {
            let mut c = r.clone();
            c.push(r[0]);
            c
        })
        .collect();
    let cums: Vec<Vec<f64>> = closed.iter().map(|c| cumulative_lengths(c)).collect();
    let inside = |p: Point| poly.iter().filter(|r| point_in_ring(p, r)).count() % 2 == 1;

    // rungs crossing the outline exactly twice, through the inside
    struct Rung {
        src: usize,
        hits: [(usize, f64, Point); 2],
        chord: Vec<Point>,
    }
    let mut cand: Vec<Rung> = Vec::new();
    for (k, line) in rungs.iter().enumerate() {
        if line.len() < 2 {
            continue;
        }
        let mut h = crossings(line, poly, &cums);
        if h.len() != 2 {
            continue;
        }
        h.sort_by(|a, b| a.3.partial_cmp(&b.3).unwrap());
        let lc = cumulative_lengths(line);
        let chord = substring(line, &lc, h[0].3, h[1].3);
        let mid = crate::geom::point_at(line, &lc, (h[0].3 + h[1].3) * 0.5);
        if !inside(mid) {
            continue;
        }
        cand.push(Rung { src: k, hits: [(h[0].0, h[0].1, h[0].2), (h[1].0, h[1].1, h[1].2)], chord });
    }
    // rungs crossing each other inside the shape would make bad sections: drop them
    let crosses = |a: &[Point], b: &[Point]| {
        a.windows(2).any(|s| b.windows(2).any(|t| segment_intersection(s[0], s[1], t[0], t[1]).is_some()))
    };
    let keep: Vec<bool> = (0..cand.len()).map(|i| !(0..cand.len()).any(|j| j != i && crosses(&cand[i].chord, &cand[j].chord))).collect();
    let valid: Vec<Rung> = cand.into_iter().zip(keep).filter(|(_, k)| *k).map(|(r, _)| r).collect();
    if valid.is_empty() {
        return None;
    }
    for r in &valid {
        used[r.src] = true;
    }

    // outline sections between the cuts
    let mut sections: Vec<Section> = Vec::new();
    for ri in 0..poly.len() {
        let mut cuts: Vec<(f64, Cut)> = Vec::new();
        for (k, r) in valid.iter().enumerate() {
            for e in 0..2 {
                if r.hits[e].0 == ri {
                    cuts.push((r.hits[e].1, (k, e)));
                }
            }
        }
        if cuts.is_empty() {
            continue;
        }
        cuts.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
        let m = cuts.len();
        for i in 0..m {
            let (from, start) = cuts[i];
            let (to, end) = cuts[(i + 1) % m];
            let pts = ring_arc(&closed[ri], &cums[ri], from, if m == 1 { from } else { to });
            sections.push(Section { pts, start, end });
        }
    }
    let start_of: HashMap<Cut, usize> = sections.iter().enumerate().map(|(i, s)| (s.start, i)).collect();
    let end_of: HashMap<Cut, usize> = sections.iter().enumerate().map(|(i, s)| (s.end, i)).collect();

    // cells: walk the outline with the area on one side, crossing over at every rung
    let mut cell_of = vec![usize::MAX; sections.len()];
    let mut cells: Vec<Vec<usize>> = Vec::new();
    for s0 in 0..sections.len() {
        if cell_of[s0] != usize::MAX {
            continue;
        }
        let id = cells.len();
        let mut cell = Vec::new();
        let mut s = s0;
        while cell_of[s] == usize::MAX {
            cell_of[s] = id;
            cell.push(s);
            let (k, e) = sections[s].end;
            match start_of.get(&(k, 1 - e)) {
                Some(&n) => s = n,
                None => break,
            }
        }
        cells.push(cell);
    }
    let nrungs = valid.len();
    let chainable = |c: usize| match cells[c].len() {
        2 => true,
        1 => !(skip_end && nrungs > 1),
        _ => false,
    };
    let cell_at_start = |cut: Cut| start_of.get(&cut).map(|&s| cell_of[s]);
    let mut done = vec![false; cells.len()];
    let mut satins: Vec<SatinShape> = Vec::new();

    // Walk a chain of cells. `entry`: the rung entered through and the end of
    // it where a section of `c` starts (the end the first rail runs from).
    let mut walk = |c0: usize, entry: Option<Cut>, done: &mut Vec<bool>| {
        let (mut left, mut right): (Vec<Point>, Vec<Point>) = (Vec::new(), Vec::new());
        let mut inner: Vec<usize> = Vec::new();
        let mut cur = c0;
        let mut p: Cut;
        match entry {
            Some(e) => p = e,
            None => {
                // an end cell: its one section runs from one end of the rung round to the other
                done[cur] = true;
                let s = &sections[cells[cur][0]];
                let cum = cumulative_lengths(&s.pts);
                let len = *cum.last().unwrap();
                let mut r = substring(&s.pts, &cum, 0.0, len * END_SPLIT.0);
                r.reverse();
                right = r;
                left = substring(&s.pts, &cum, len * END_SPLIT.1, len);
                p = s.end;
                inner.push(p.0);
                match cell_at_start(p) {
                    Some(n) => cur = n,
                    None => return,
                }
            }
        }
        loop {
            if done[cur] || !chainable(cur) {
                // the rung we came through ends the satin
                inner.pop();
                break;
            }
            done[cur] = true;
            let q: Cut = (p.0, 1 - p.1);
            let (Some(&ls), Some(&rs)) = (start_of.get(&p), end_of.get(&q)) else { break };
            if cells[cur].len() == 1 {
                let s = &sections[ls];
                let cum = cumulative_lengths(&s.pts);
                let len = *cum.last().unwrap();
                extend(&mut left, &substring(&s.pts, &cum, 0.0, len * END_SPLIT.0));
                let mut r = substring(&s.pts, &cum, len * END_SPLIT.1, len);
                r.reverse();
                extend(&mut right, &r);
                break;
            }
            extend(&mut left, &sections[ls].pts);
            let mut r = sections[rs].pts.clone();
            r.reverse();
            extend(&mut right, &r);
            p = sections[ls].end;
            inner.push(p.0);
            match cell_at_start(p) {
                Some(n) => cur = n,
                None => {
                    inner.pop();
                    break;
                }
            }
        }
        if left.len() < 2 || right.len() < 2 {
            return;
        }
        // rungs right at the start or end of the column make it misbehave (Ink/Stitch)
        let ends = [left[0], right[0], *left.last().unwrap(), *right.last().unwrap()];
        inner.sort_unstable();
        inner.dedup();
        let rungs: Vec<Vec<V2>> = inner
            .iter()
            .filter(|&&k| {
                let ch = &valid[k].chord;
                ends.iter().all(|e| ch.iter().all(|q| q.dist(*e) > 1.0))
            })
            .map(|&k| arr(&rungs[valid[k].src]))
            .collect();
        satins.push(SatinShape { rails: [arr(&left), arr(&right)], rungs });
    };

    // 1. chains from their end cells
    for c in 0..cells.len() {
        if !done[c] && cells[c].len() == 1 && chainable(c) {
            walk(c, None, &mut done);
        }
    }
    // 2. chains starting at a rung whose other side is a junction (or a skipped end)
    for c in 0..cells.len() {
        if done[c] || !chainable(c) {
            continue;
        }
        for &s in &cells[c] {
            let (k, e) = sections[s].end;
            // the other side of rung k: the cell of the section ending at its other end
            let other = end_of.get(&(k, 1 - e)).map(|&o| cell_of[o]);
            if other.is_none_or(|o| o != c && !chainable(o)) {
                walk(c, Some((k, 1 - e)), &mut done);
                break;
            }
        }
    }
    // 3. what is left are closed loops (a ring cut by rungs)
    for c in 0..cells.len() {
        if !done[c] && chainable(c) {
            let s = &sections[cells[c][0]];
            walk(c, Some(s.start), &mut done);
        }
    }
    Some(satins)
}

// ---------------------------------------------------------------------------
// Centre lines (medial axis)

/// A centre line of a shape and the shape's width along it.
#[derive(Debug, Clone, Serialize)]
pub struct CentreLine {
    pub pts: Vec<V2>,
    /// Full width of the shape at every point (mm).
    pub widths: Vec<f64>,
    pub closed: bool,
}

#[derive(Debug, Clone)]
pub struct CentreLineOpts {
    /// Dead ends (branches ending freely) shorter than this are removed (mm;
    /// Ink/Stitch's "threshold for dead ends").
    pub dead_end: f64,
    /// Lines cutting the shape apart before its centre lines are found.
    pub cut_lines: Vec<Vec<Point>>,
    /// Bridge line ends left at the cut lines to the nearest line.
    pub close_gaps: bool,
    /// Lines continue straight through a junction when they bend less than this (°).
    pub continue_deg: f64,
}

impl Default for CentreLineOpts {
    fn default() -> Self {
        CentreLineOpts { dead_end: 10.0, cut_lines: vec![], close_gaps: false, continue_deg: 35.0 }
    }
}

/// The centre lines (medial axis) of an even-odd region, as long lines with
/// the shape's width along them (Ink/Stitch "Fill to stroke"). The shape is
/// rasterised finely, thinned to a one-pixel skeleton and read back as a line
/// network by [`crate::vision::strokes`]: short spurs are pruned, lines
/// continue straight through junctions, and free ends are extended to the
/// shape's tip.
#[cfg(feature = "digitize")]
pub fn centre_lines(rings: &[Ring], o: &CentreLineOpts) -> Vec<CentreLine> {
    use crate::digitize::{edt_sq, zhang_suen};
    use crate::geom::scanline;
    use crate::vision::strokes::{strokes, StrokeOpts};

    let mut region = clip::region(rings);
    let b0 = crate::geom::rings_bounds(rings);
    if b0.is_empty() {
        return vec![];
    }
    let mut res = (b0.width().max(b0.height()) / 1000.0).clamp(0.02, 0.2);
    let cut_half = (res * 1.5).max(0.05);
    if !o.cut_lines.is_empty() {
        let bands: Vec<clip::Region> = o.cut_lines.iter().map(|l| clip::band(l, cut_half)).collect();
        region = clip::difference(&region, &clip::union_all(bands.iter()));
    }
    let rings = clip::rings(&region);
    let b = crate::geom::rings_bounds(&rings);
    if b.is_empty() {
        return vec![];
    }
    let (mut w, mut h);
    loop {
        w = (b.width() / res).ceil() as usize + 6;
        h = (b.height() / res).ceil() as usize + 6;
        if w * h <= 6_000_000 {
            break;
        }
        res *= 1.3;
    }
    let (ox, oy) = (b.min_x - 3.0 * res, b.min_y - 3.0 * res);
    let mut mask = vec![false; w * h];
    for j in 1..h - 1 {
        let y = oy + (j as f64 + 0.5) * res;
        for (a, c) in scanline(&rings, y) {
            let i0 = ((a - ox) / res - 0.5).ceil().max(1.0) as usize;
            let i1 = ((((c - ox) / res - 0.5).floor() + 1.0).max(0.0) as usize).min(w - 1);
            for i in i0..i1 {
                mask[j * w + i] = true;
            }
        }
    }
    let dt = edt_sq(&mask, w, h);
    let skel = zhang_suen(&mask, w, h);
    let found = strokes(
        &skel,
        w,
        h,
        &|i| dt[i].sqrt(),
        &StrokeOpts {
            min_len: (o.dead_end / res).max(2.0),
            gap: if o.close_gaps { (cut_half * 2.0 + 1.0) / res } else { 0.0 },
            continue_deg: o.continue_deg.clamp(0.0, 90.0),
        },
    );
    let to_mm = |p: Point| pt(ox + p.x * res, oy + p.y * res);
    let mut out = Vec::new();
    for st in found {
        let mut pts: Vec<Point> = st.pts.iter().map(|p| to_mm(*p)).collect();
        let mut wid: Vec<f64> = st.widths.iter().map(|x| (x - 1.0).max(0.5) * res).collect();
        // smooth the pixel staircase (ends stay)
        let n = pts.len();
        if n > 6 {
            let src = pts.clone();
            for i in 0..n {
                if !st.closed && (i < 2 || i + 2 >= n) {
                    continue;
                }
                let mut acc = Point::ZERO;
                for k in 0..5 {
                    acc += src[(i + n + k - 2) % n];
                }
                pts[i] = acc * 0.2;
            }
        }
        // the skeleton stops short of free ends by about the half width: reach the tip
        if !st.closed && pts.len() >= 2 {
            for at_start in [true, false] {
                if !st.free[if at_start { 0 } else { 1 }] {
                    continue;
                }
                let m = pts.len();
                let (e, q, half) = if at_start { (pts[0], pts[(m - 1).min(3)], wid[0] * 0.5) } else { (pts[m - 1], pts[m.saturating_sub(4)], wid[m - 1] * 0.5) };
                let d = e - q;
                if d.length() > 1e-9 {
                    let tip = e + d.unit() * (half * 0.9);
                    if at_start {
                        pts.insert(0, tip);
                        wid.insert(0, wid[0]);
                    } else {
                        pts.push(tip);
                        wid.push(*wid.last().unwrap());
                    }
                }
            }
        }
        // fewer points: simplify and keep the widths of the points kept
        let tol = (res * 0.4).max(0.02);
        let simple = simplify(&pts, tol);
        let mut ws = Vec::with_capacity(simple.len());
        let mut j = 0;
        for p in &simple {
            while j < pts.len() && pts[j] != *p {
                j += 1;
            }
            ws.push(wid[j.min(wid.len() - 1)]);
        }
        if simple.len() >= 2 {
            out.push(CentreLine { pts: arr(&simple), widths: ws, closed: st.closed });
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Satin to stroke

/// The centre line of a satin column (Ink/Stitch "Satin to stroke": the
/// middle of every stitch pair at the zig-zag spacing, simplified).
pub fn satin_centre_line(paths: &[SubPath], p: &SatinParams) -> Vec<Point> {
    let Some(geo) = crate::stitches::satin::satin_geometry(paths, p) else { return vec![] };
    let pairs = crate::stitches::satin::plot_points_on_rails(&geo, p.spacing.max(0.1), 0.0, 0.0);
    let mid: Vec<Point> = pairs.iter().map(|(a, b)| a.lerp(*b, 0.5)).collect();
    let mut s = simplify(&mid, 0.05);
    if s.len() == 1 {
        s.push(s[0]);
    }
    s
}

// ---------------------------------------------------------------------------
// Break apart

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BreakMethod {
    /// Every sub-path is a shape of its own (overlaps stay).
    Simple,
    /// Overlapping sub-paths cancel out where they overlap (even-odd).
    Complex,
}

/// One part of a broken-apart fill: rings, outer first. A ring that is an
/// unchanged original sub-path carries its index (to keep its curves).
#[derive(Debug, Clone, Serialize)]
pub struct Part {
    pub rings: Vec<Vec<V2>>,
    pub source: Vec<Option<usize>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum BreakApart {
    /// A valid shape: left alone.
    Valid,
    /// Smaller than the threshold: removed.
    Removed,
    Parts { parts: Vec<Part> },
}

fn ring_is_simple(r: &[Point]) -> bool {
    let n = r.len();
    for i in 0..n {
        let (a, b) = (r[i], r[(i + 1) % n]);
        for j in i + 2..n {
            if i == 0 && j == n - 1 {
                continue;
            }
            let (c, d) = (r[j], r[(j + 1) % n]);
            if crate::geom::segments_intersect(a, b, c, d) {
                return false;
            }
        }
    }
    true
}

fn rings_cross(a: &[Point], b: &[Point]) -> bool {
    let (ba, bb) = (Rect::of_points(a), Rect::of_points(b));
    if !ba.intersects(&bb) {
        return false;
    }
    let (n, m) = (a.len(), b.len());
    (0..n).any(|i| (0..m).any(|j| segment_intersection(a[i], a[(i + 1) % n], b[j], b[(j + 1) % m]).is_some()))
}

/// Ink/Stitch's validity test: the largest sub-path is the outline and all
/// others are holes inside it, nothing crosses itself or anything else.
fn shape_is_valid(rings: &[Ring]) -> bool {
    let mut idx: Vec<usize> = (0..rings.len()).collect();
    idx.sort_by(|a, b| signed_area(&rings[*b]).abs().partial_cmp(&signed_area(&rings[*a]).abs()).unwrap());
    let Some((&outer, holes)) = idx.split_first() else { return false };
    if !rings.iter().all(|r| ring_is_simple(r)) {
        return false;
    }
    for (k, &h) in holes.iter().enumerate() {
        if !point_in_ring(rings[h][0], &rings[outer]) || rings_cross(&rings[h], &rings[outer]) {
            return false;
        }
        for &g in &holes[k + 1..] {
            if rings_cross(&rings[h], &rings[g]) || point_in_ring(rings[h][0], &rings[g]) || point_in_ring(rings[g][0], &rings[h]) {
                return false;
            }
        }
    }
    true
}

fn same_ring(a: &[Point], b: &[Point]) -> bool {
    let (aa, ab) = (signed_area(a).abs(), signed_area(b).abs());
    if (aa - ab).abs() > 1e-3 * aa.max(ab).max(1e-6) {
        return false;
    }
    let (ra, rb) = (Rect::of_points(a), Rect::of_points(b));
    (ra.min_x - rb.min_x).abs() < 0.01 && (ra.max_x - rb.max_x).abs() < 0.01 && (ra.min_y - rb.min_y).abs() < 0.01 && (ra.max_y - rb.max_y).abs() < 0.01
}

/// Ink/Stitch "Break apart fill objects": a valid shape (one outline with
/// holes) is left alone; otherwise every sub-path is repaired (self-crossings
/// split into loops), overlapping sub-paths are combined (Complex: they
/// cancel where they overlap) and the pieces are regrouped — shapes inside
/// other shapes become their holes. Pieces and holes smaller than
/// `min_area` (mm²) are dropped. Largest part first.
pub fn break_apart(rings: &[Ring], method: BreakMethod, min_area: f64) -> BreakApart {
    let rings: Vec<Ring> = rings.iter().filter(|r| r.len() >= 3).cloned().collect();
    if rings.is_empty() {
        return BreakApart::Removed;
    }
    let total = clip::area(&clip::region(&rings));
    if shape_is_valid(&rings) && total > min_area {
        return BreakApart::Valid;
    }
    if total < min_area {
        return BreakApart::Removed;
    }
    // every sub-path on its own, self-crossings resolved into its loops
    let mut pieces: Vec<Ring> = Vec::new();
    for r in &rings {
        for poly in components(clip::rings(&clip::region(std::slice::from_ref(r)))) {
            pieces.push(poly[0].clone());
            // a loop sewn over twice (even-odd hole) is a shape of its own too
            pieces.extend(poly[1..].iter().cloned());
        }
    }
    let mut groups: Vec<Vec<Ring>> = match method {
        BreakMethod::Complex => components(clip::rings(&clip::region(&pieces))),
        BreakMethod::Simple => {
            pieces.retain(|r| signed_area(r).abs() > min_area);
            pieces.sort_by(|a, b| signed_area(b).abs().partial_cmp(&signed_area(a).abs()).unwrap());
            let regions: Vec<clip::Region> = pieces.iter().map(|r| clip::region(std::slice::from_ref(r))).collect();
            let mut hole = vec![false; pieces.len()];
            let mut groups = Vec::new();
            for i in 0..pieces.len() {
                if hole[i] {
                    continue;
                }
                let mut g = vec![pieces[i].clone()];
                let mut taken: Vec<usize> = Vec::new();
                for j in 0..pieces.len() {
                    if j == i || hole[j] || signed_area(&pieces[j]).abs() >= signed_area(&pieces[i]).abs() {
                        continue;
                    }
                    // inside, and clear of the holes already taken
                    let outside = clip::area(&clip::difference(&regions[j], &regions[i]));
                    if outside > 1e-4 || taken.iter().any(|&t| clip::area(&clip::intersect(&regions[t], &regions[j])) > 1e-6) {
                        continue;
                    }
                    hole[j] = true;
                    taken.push(j);
                    g.push(pieces[j].clone());
                }
                groups.push(g);
            }
            groups
        }
    };
    for g in groups.iter_mut() {
        let outer = g[0].clone();
        let rest: Vec<Ring> = g[1..].iter().filter(|h| signed_area(h).abs() > min_area).cloned().collect();
        *g = std::iter::once(outer).chain(rest).collect();
    }
    groups.retain(|g| signed_area(&g[0]).abs() > min_area.max(0.35));
    groups.sort_by(|a, b| signed_area(&b[0]).abs().partial_cmp(&signed_area(&a[0]).abs()).unwrap());
    let parts = groups
        .into_iter()
        .map(|g| {
            let source = g.iter().map(|r| rings.iter().position(|o| same_ring(o, r))).collect();
            Part { rings: g.iter().map(|r| arr(r)).collect(), source }
        })
        .collect();
    BreakApart::Parts { parts }
}

// ---------------------------------------------------------------------------
// Knockdown around a selection

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KnockdownFrame {
    /// The outline of the design itself.
    None,
    Rect,
    Circle,
}

#[derive(Debug, Clone)]
pub struct KnockdownShapeOpts {
    pub offset: f64,
    pub join: clip::Join,
    pub mitre_limit: f64,
    pub keep_holes: bool,
    pub frame: KnockdownFrame,
    pub frame_offset: f64,
    pub frame_join: clip::Join,
    /// Frame only: the design is not cut out of it.
    pub frame_only: bool,
}

impl Default for KnockdownShapeOpts {
    fn default() -> Self {
        KnockdownShapeOpts {
            offset: 1.0,
            join: clip::Join::Round,
            mitre_limit: 5.0,
            keep_holes: true,
            frame: KnockdownFrame::None,
            frame_offset: 1.0,
            frame_join: clip::Join::Round,
            frame_only: false,
        }
    }
}

/// Smallest circle around the points (Welzl, on the convex hull).
pub fn min_bounding_circle(points: &[Point]) -> Option<(Point, f64)> {
    let hull = convex_hull(points);
    let p = &hull;
    if p.is_empty() {
        return None;
    }
    let circle2 = |a: Point, b: Point| (a.lerp(b, 0.5), a.dist(b) * 0.5);
    let circle3 = |a: Point, b: Point, c: Point| -> (Point, f64) {
        let d = 2.0 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
        if d.abs() < 1e-12 {
            // collinear: the widest pair
            let (x, y) = [(a, b), (a, c), (b, c)].into_iter().max_by(|u, v| u.0.dist(u.1).partial_cmp(&v.0.dist(v.1)).unwrap()).unwrap();
            return circle2(x, y);
        }
        let (a2, b2, c2) = (a.length_sq(), b.length_sq(), c.length_sq());
        let ux = (a2 * (b.y - c.y) + b2 * (c.y - a.y) + c2 * (a.y - b.y)) / d;
        let uy = (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / d;
        let o = pt(ux, uy);
        (o, o.dist(a))
    };
    let inside = |c: &(Point, f64), q: Point| q.dist(c.0) <= c.1 + 1e-7;
    let mut c = (p[0], 0.0);
    for i in 1..p.len() {
        if inside(&c, p[i]) {
            continue;
        }
        c = (p[i], 0.0);
        for j in 0..i {
            if inside(&c, p[j]) {
                continue;
            }
            c = circle2(p[i], p[j]);
            for k in 0..j {
                if !inside(&c, p[k]) {
                    c = circle3(p[i], p[j], p[k]);
                }
            }
        }
    }
    Some(c)
}

fn convex_hull(points: &[Point]) -> Vec<Point> {
    let mut p: Vec<Point> = points.to_vec();
    p.sort_by(|a, b| a.x.partial_cmp(&b.x).unwrap().then(a.y.partial_cmp(&b.y).unwrap()));
    p.dedup_by(|a, b| a.dist(*b) < 1e-9);
    if p.len() < 3 {
        return p;
    }
    let cross = |o: Point, a: Point, b: Point| (a - o).cross(b - o);
    let mut lower: Vec<Point> = Vec::new();
    for &q in &p {
        while lower.len() >= 2 && cross(lower[lower.len() - 2], lower[lower.len() - 1], q) <= 0.0 {
            lower.pop();
        }
        lower.push(q);
    }
    let mut upper: Vec<Point> = Vec::new();
    for &q in p.iter().rev() {
        while upper.len() >= 2 && cross(upper[upper.len() - 2], upper[upper.len() - 1], q) <= 0.0 {
            upper.pop();
        }
        upper.push(q);
    }
    lower.pop();
    upper.pop();
    lower.extend(upper);
    lower
}

/// Ink/Stitch "Knockdown fill": the union of what the objects cover, grown by
/// `offset` (round, mitred or bevelled corners), with or without its holes —
/// or a rectangle / circle around it (grown by `frame_offset`) with the
/// design cut out (an embossed look), or the plain frame. Even-odd rings.
pub fn knockdown_shape(covers: &[Cover], o: &KnockdownShapeOpts) -> Vec<Ring> {
    let parts: Vec<clip::Region> = covers
        .iter()
        .map(|c| match c {
            Cover::Area(r) => clip::region(r),
            Cover::Polys(p) => clip::polygons(p),
            Cover::Band { pts, half } => clip::band(pts, *half),
        })
        .collect();
    let union = clip::union_all(parts.iter());
    let shape = clip::offset_joined(&union, o.offset, o.join, o.mitre_limit);
    let simplified: Vec<Ring> = clip::rings(&shape).iter().map(|r| crate::geom::simplify_ring(r, 0.08)).filter(|r| r.len() >= 3).collect();
    let polys = components(simplified);
    let design: Vec<Ring> = polys.iter().flat_map(|p| if o.keep_holes { p.clone() } else { vec![p[0].clone()] }).collect();
    if o.frame == KnockdownFrame::None {
        return design;
    }
    let all: Vec<Point> = polys.iter().flat_map(|p| p[0].iter().copied()).collect();
    let frame: Ring = match o.frame {
        KnockdownFrame::Rect => {
            let b = Rect::of_points(&all);
            if b.is_empty() {
                return vec![];
            }
            vec![pt(b.min_x, b.min_y), pt(b.max_x, b.min_y), pt(b.max_x, b.max_y), pt(b.min_x, b.max_y)]
        }
        _ => {
            let Some((c, r)) = min_bounding_circle(&all) else { return vec![] };
            let n = 128;
            (0..n).map(|k| {
                let a = std::f64::consts::TAU * k as f64 / n as f64;
                pt(c.x + r * a.cos(), c.y + r * a.sin())
            }).collect()
        }
    };
    let frame = clip::rings(&clip::offset_joined(&clip::region(&[frame]), o.frame_offset.max(0.0), o.frame_join, o.mitre_limit));
    if o.frame_only {
        return frame;
    }
    let mut out = frame;
    out.extend(design);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geom::rings_area;

    fn rect(x: f64, y: f64, w: f64, h: f64) -> Ring {
        vec![pt(x, y), pt(x + w, y), pt(x + w, y + h), pt(x, y + h)]
    }
    fn line(a: (f64, f64), b: (f64, f64)) -> Vec<Point> {
        vec![pt(a.0, a.1), pt(b.0, b.1)]
    }
    fn len(v: &[V2]) -> f64 {
        v.windows(2).map(|w| Point::from_arr(w[0]).dist(Point::from_arr(w[1]))).sum()
    }

    #[test]
    fn bar_with_two_rungs_is_one_satin() {
        // a 40 × 6 bar, rungs across at x = 10 and x = 30
        let bar = vec![rect(0.0, 0.0, 40.0, 6.0)];
        let r = fill_to_satin(&bar, &[line((10.0, -2.0), (10.0, 8.0)), line((30.0, -2.0), (30.0, 8.0))], false);
        assert_eq!(r.satins.len(), 1, "{:?}", r.satins.len());
        let s = &r.satins[0];
        // rails run the full length (ends split around the tips)
        assert!(len(&s.rails[0]) > 38.0 && len(&s.rails[1]) > 38.0, "{} {}", len(&s.rails[0]), len(&s.rails[1]));
        // the two rungs stay inside the column
        assert_eq!(s.rungs.len(), 2);
        assert_eq!(r.used_rungs, vec![0, 1]);
        // rails run the same way
        let (a0, a1) = (Point::from_arr(s.rails[0][0]), Point::from_arr(*s.rails[0].last().unwrap()));
        let (b0, b1) = (Point::from_arr(s.rails[1][0]), Point::from_arr(*s.rails[1].last().unwrap()));
        assert!(a0.dist(b0) + a1.dist(b1) < a0.dist(b1) + a1.dist(b0));
    }

    #[test]
    fn skip_end_sections_starts_at_the_rungs() {
        let bar = vec![rect(0.0, 0.0, 40.0, 6.0)];
        let r = fill_to_satin(&bar, &[line((10.0, -2.0), (10.0, 8.0)), line((30.0, -2.0), (30.0, 8.0))], true);
        assert_eq!(r.satins.len(), 1);
        let s = &r.satins[0];
        assert!((len(&s.rails[0]) - 20.0).abs() < 0.1, "{}", len(&s.rails[0]));
        assert!(s.rungs.is_empty());
    }

    #[test]
    fn a_ring_with_rungs_is_a_closed_satin() {
        let ring = vec![rect(0.0, 0.0, 30.0, 30.0), rect(6.0, 6.0, 18.0, 18.0)];
        let r = fill_to_satin(&ring, &[line((15.0, -2.0), (15.0, 8.0)), line((15.0, 22.0), (15.0, 32.0))], false);
        assert_eq!(r.satins.len(), 1);
        let s = &r.satins[0];
        // outer and inner ring are the rails
        let (l0, l1) = (len(&s.rails[0]), len(&s.rails[1]));
        assert!((l0.max(l1) - 120.0).abs() < 0.5 && (l0.min(l1) - 72.0).abs() < 0.5, "{l0} {l1}");
    }

    #[test]
    fn a_ring_with_one_rung() {
        let ring = vec![rect(0.0, 0.0, 30.0, 30.0), rect(6.0, 6.0, 18.0, 18.0)];
        let r = fill_to_satin(&ring, &[line((15.0, -2.0), (15.0, 8.0))], false);
        assert_eq!(r.satins.len(), 1);
    }

    #[test]
    fn a_t_junction_ends_three_satins() {
        // a T: bar 0..40 × 0..6 and a stem 17..23 × 6..30
        let t = vec![vec![pt(0.0, 0.0), pt(40.0, 0.0), pt(40.0, 6.0), pt(23.0, 6.0), pt(23.0, 30.0), pt(17.0, 30.0), pt(17.0, 6.0), pt(0.0, 6.0)]];
        let rungs = [line((14.0, -1.0), (14.0, 7.0)), line((26.0, -1.0), (26.0, 7.0)), line((16.0, 9.0), (24.0, 9.0))];
        let r = fill_to_satin(&t, &rungs, false);
        assert_eq!(r.satins.len(), 3, "{}", r.satins.len());
    }

    #[test]
    fn untouched_polygons_are_reported() {
        let two = vec![rect(0.0, 0.0, 40.0, 6.0), rect(0.0, 20.0, 10.0, 10.0)];
        let r = fill_to_satin(&two, &[line((10.0, -2.0), (10.0, 8.0))], false);
        assert_eq!(r.satins.len(), 1);
        assert_eq!(r.unused.len(), 1);
    }

    #[cfg(feature = "digitize")]
    #[test]
    fn centre_line_of_a_bar() {
        let bar = vec![rect(0.0, 0.0, 40.0, 4.0)];
        let lines = centre_lines(&bar, &CentreLineOpts { dead_end: 3.0, ..Default::default() });
        assert_eq!(lines.len(), 1, "{}", lines.len());
        let l = &lines[0];
        for p in &l.pts {
            assert!((p[1] - 2.0).abs() < 0.3, "off centre {p:?}");
        }
        let xs: Vec<f64> = l.pts.iter().map(|p| p[0]).collect();
        let (lo, hi) = (xs.iter().cloned().fold(f64::MAX, f64::min), xs.iter().cloned().fold(f64::MIN, f64::max));
        assert!(lo < 2.5 && hi > 37.5, "{lo}..{hi}");
        let mid = l.widths[l.widths.len() / 2];
        assert!((mid - 4.0).abs() < 0.5, "width {mid}");
    }

    #[cfg(feature = "digitize")]
    #[test]
    fn cut_lines_split_the_centre_line() {
        let bar = vec![rect(0.0, 0.0, 40.0, 4.0)];
        let lines = centre_lines(&bar, &CentreLineOpts { dead_end: 3.0, cut_lines: vec![line((20.0, -1.0), (20.0, 5.0))], ..Default::default() });
        assert_eq!(lines.len(), 2);
    }

    #[test]
    fn break_apart_leaves_valid_shapes() {
        let ring = vec![rect(0.0, 0.0, 30.0, 30.0), rect(6.0, 6.0, 18.0, 18.0)];
        assert!(matches!(break_apart(&ring, BreakMethod::Simple, 1.4), BreakApart::Valid));
    }

    #[test]
    fn break_apart_splits_islands_and_keeps_holes() {
        // two squares side by side, the first with a hole
        let rings = vec![rect(0.0, 0.0, 30.0, 30.0), rect(6.0, 6.0, 18.0, 18.0), rect(40.0, 0.0, 10.0, 10.0)];
        let BreakApart::Parts { parts } = break_apart(&rings, BreakMethod::Simple, 1.4) else { panic!() };
        assert_eq!(parts.len(), 2);
        assert_eq!(parts[0].rings.len(), 2, "the hole stays with its shape");
        assert_eq!(parts[0].source, vec![Some(0), Some(1)]);
        assert_eq!(parts[1].source, vec![Some(2)]);
    }

    #[test]
    fn break_apart_repairs_a_bow_tie() {
        let bow = vec![vec![pt(0.0, 0.0), pt(20.0, 20.0), pt(20.0, 0.0), pt(0.0, 20.0)]];
        let BreakApart::Parts { parts } = break_apart(&bow, BreakMethod::Simple, 1.4) else { panic!() };
        assert_eq!(parts.len(), 2);
        let a: f64 = parts.iter().map(|p| signed_area(&p.rings[0].iter().map(|q| Point::from_arr(*q)).collect::<Vec<_>>()).abs()).sum();
        assert!((a - 200.0).abs() < 0.5, "{a}");
    }

    #[test]
    fn break_apart_complex_cancels_overlaps() {
        let rings = vec![rect(0.0, 0.0, 20.0, 20.0), rect(10.0, 0.0, 20.0, 20.0)];
        let BreakApart::Parts { parts } = break_apart(&rings, BreakMethod::Complex, 1.4) else { panic!() };
        assert_eq!(parts.len(), 2);
        let BreakApart::Parts { parts } = break_apart(&rings, BreakMethod::Simple, 1.4) else { panic!() };
        assert_eq!(parts.len(), 2);
        let a: f64 = parts.iter().map(|p| signed_area(&p.rings[0].iter().map(|q| Point::from_arr(*q)).collect::<Vec<_>>()).abs()).sum();
        assert!((a - 800.0).abs() < 0.5, "simple keeps the overlap: {a}");
    }

    #[test]
    fn knockdown_shapes() {
        let covers = vec![Cover::Area(vec![rect(0.0, 0.0, 20.0, 10.0), rect(5.0, 3.0, 10.0, 4.0)])];
        let o = KnockdownShapeOpts { offset: 1.0, ..Default::default() };
        let r = knockdown_shape(&covers, &o);
        assert_eq!(r.len(), 2, "outline and hole");
        let a = rings_area(&r);
        // (22 × 12 − rounded corners) − (8 × 2)
        assert!(a > 240.0 && a < 250.0, "{a}");
        let no_holes = knockdown_shape(&covers, &KnockdownShapeOpts { keep_holes: false, ..o.clone() });
        assert_eq!(no_holes.len(), 1);
        let mitre = knockdown_shape(&covers, &KnockdownShapeOpts { keep_holes: false, join: clip::Join::Mitre, ..o.clone() });
        assert!((rings_area(&mitre) - 264.0).abs() < 0.5, "{}", rings_area(&mitre));
        // a rectangle frame with the design cut out
        let framed = knockdown_shape(&covers, &KnockdownShapeOpts { keep_holes: false, join: clip::Join::Mitre, frame: KnockdownFrame::Rect, frame_join: clip::Join::Mitre, frame_offset: 2.0, ..o.clone() });
        assert!((rings_area(&framed) - (26.0 * 16.0 - 264.0)).abs() < 1.0, "{}", rings_area(&framed));
        let circle = knockdown_shape(&covers, &KnockdownShapeOpts { frame: KnockdownFrame::Circle, frame_only: true, frame_offset: 0.0, ..o });
        assert_eq!(circle.len(), 1);
    }

    #[test]
    fn bounding_circle() {
        let (c, r) = min_bounding_circle(&[pt(0.0, 0.0), pt(10.0, 0.0), pt(5.0, 1.0), pt(5.0, -1.0)]).unwrap();
        assert!((c.x - 5.0).abs() < 1e-6 && c.y.abs() < 1e-6 && (r - 5.0).abs() < 1e-6);
    }

    #[test]
    fn satin_centre_line_of_rails() {
        let rails = vec![SubPath::polyline(&[pt(0.0, 0.0), pt(20.0, 0.0), pt(40.0, 0.0)], false), SubPath::polyline(&[pt(0.0, 4.0), pt(20.0, 4.0), pt(40.0, 4.0)], false)];
        let p = SatinParams::default();
        let c = satin_centre_line(&rails, &p);
        assert!(c.len() >= 2);
        assert!(c.iter().all(|q| (q.y - 2.0).abs() < 1e-6));
        assert!((c.last().unwrap().x - c[0].x).abs() > 39.0);
    }
}
