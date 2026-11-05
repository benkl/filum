//! Fill stitches.
//!
//! * **Tatami** — follows Ink/Stitch's fill (`lib/stitches/fill.py`,
//!   `tatami_fill.py`, GPL-3.0-or-later): the region is intersected with a
//!   grating of parallel rows, rows are stitched with staggered needle
//!   positions (`adjust_stagger`), and connected rows are grouped into
//!   sections. Sections are visited greedily and joined with running-stitch
//!   travel that goes *under* the fill (straight, if it stays inside the
//!   shape) or along the boundary — so normally no jumps are needed.
//! * **Contour** / **Spiral** — concentric inset rings; spiral blends ring k
//!   into ring k+1 for a single continuous path.
//! * **Radial** (new) — sunburst rays from a centre with bit-reversed ray
//!   start radii so density stays constant from the centre to the edge.
//! * **Hilbert** (new) — space-filling-curve texture clipped to the shape.
//! * **Stipple** (new) — Poisson-disk points joined by a nearest-neighbour +
//!   2-opt tour (TSP art), constrained to the inside of the shape.

use std::f64::consts::TAU;

use crate::geom::*;
use crate::model::{FillMethod, FillParams, GradientParams, SubPath};
use crate::plan::flags;

use super::gradient::LayerMask;
use super::running::running_stitch;
use super::Run;

/// Closed, flattened rings of an object (open sub-paths are closed implicitly).
pub fn fill_rings(paths: &[SubPath]) -> Vec<Ring> {
    let mut out = Vec::new();
    for sp in paths {
        let mut pts = sp.flatten(0.05);
        dedup(&mut pts, 1e-6);
        if pts.len() > 2 && pts[0].dist(*pts.last().unwrap()) < 1e-6 {
            pts.pop();
        }
        if pts.len() >= 3 && signed_area(&pts).abs() > 1e-4 {
            out.push(pts);
        }
    }
    out
}

fn offset_resolution(rings: &[Ring]) -> f64 {
    let b = rings_bounds(rings);
    (b.width().max(b.height()) / 1200.0).clamp(0.03, 0.25)
}

fn push(run: &mut Run, p: Point, f: u8) {
    if let Some(&(last, _)) = run.last() {
        if last.dist(p) < 1e-6 {
            return;
        }
    }
    run.push((p, f));
}

/// Route from `a` to `b` without leaving the region: straight if possible,
/// otherwise along the nearest boundary ring. Returns None if impossible.
pub fn travel_path(rings: &[Ring], a: Point, b: Point) -> Option<Vec<Point>> {
    if a.dist(b) < 1e-6 {
        return Some(vec![a, b]);
    }
    if segment_inside(rings, a, b) {
        return Some(vec![a, b]);
    }
    let (ra, da) = nearest_ring(rings, a)?;
    let (rb, db) = nearest_ring(rings, b)?;
    if ra == rb && da < 0.5 && db < 0.5 {
        return Some(ring_path(&rings[ra], a, b));
    }
    // try: walk to ring of b straight, then along it
    if db < 0.5 {
        let ring = &rings[rb];
        // nearest vertex of ring b that a can see
        let mut best: Option<(f64, Point)> = None;
        for p in ring.iter() {
            let d = a.dist(*p);
            if best.map_or(true, |(bd, _)| d < bd) && segment_inside(rings, a, a.lerp(*p, 0.98)) {
                best = Some((d, *p));
            }
        }
        if let Some((_, p)) = best {
            let mut path = vec![a];
            path.extend(ring_path(ring, p, b));
            return Some(path);
        }
    }
    None
}

// ---------------------------------------------------------------------------
// Tatami
// ---------------------------------------------------------------------------

#[derive(Clone)]
struct Section {
    /// (y, x0, x1, row_number) in rotated space
    rows: Vec<(f64, f64, f64, i64)>,
}

struct Grating {
    sections: Vec<Section>,
}

/// Rows of the fill. With an end spacing the row spacing changes from
/// `spacing` to `end_spacing` across the shape: linearly in spacing
/// (Ink/Stitch), or linearly in density when `density_gradient` is set.
/// A density ramp in the rotated frame: its start and end row positions.
#[derive(Clone, Copy)]
pub struct RampFrame<'a> {
    pub ramp: &'a crate::model::DensityRamp,
    /// Spacing scale (fabric density).
    pub k: f64,
    y0: f64,
    y1: f64,
}

impl<'a> RampFrame<'a> {
    pub(crate) fn new(ramp: &'a crate::model::DensityRamp, k: f64, a: f64) -> RampFrame<'a> {
        let y0 = crate::geom::pt(ramp.from[0], ramp.from[1]).rotate(a).y;
        let y1 = crate::geom::pt(ramp.to[0], ramp.to[1]).rotate(a).y;
        RampFrame { ramp, k, y0, y1 }
    }
    pub(crate) fn spacing(&self, y: f64) -> f64 {
        let span = self.y1 - self.y0;
        let t = if span.abs() < 1e-6 { 0.0 } else { (y - self.y0) / span };
        self.ramp.spacing_at(t, self.k)
    }
}

#[cfg(test)]
fn build_grating(rr: &[Ring], spacing: f64, end_spacing: f64, density_gradient: bool, pull: f64) -> Grating {
    build_grating_ramp(rr, spacing, end_spacing, density_gradient, pull, None)
}

fn build_grating_ramp(rr: &[Ring], spacing: f64, end_spacing: f64, density_gradient: bool, pull: f64, ramp: Option<RampFrame>) -> Grating {
    let b = rings_bounds(rr);
    let spacing = spacing.max(0.05);
    let mut sections: Vec<Section> = Vec::new();
    // previous row spans with their section index
    let mut prev: Vec<(f64, f64, usize)> = Vec::new();
    let mut y = (b.min_y / spacing).floor() * spacing + spacing * 0.5;
    let h = b.height().max(1e-9);
    let mut guard = 0usize;
    while y < b.max_y && guard < 200_000 {
        guard += 1;
        let row_num = (y / spacing).round() as i64;
        let pct = PULL_PCT.with(|c| c.get());
        let spans: Vec<(f64, f64)> = scanline(rr, y).into_iter().map(|(a, c)| (a - pull - pct * (c - a), c + pull + pct * (c - a))).collect();
        let mut cur: Vec<(f64, f64, usize)> = Vec::with_capacity(spans.len());
        for &(x0, x1) in &spans {
            let overl: Vec<usize> = prev.iter().enumerate().filter(|(_, p)| p.0 < x1 && x0 < p.1).map(|(i, _)| i).collect();
            let mut target = None;
            if overl.len() == 1 {
                let p = prev[overl[0]];
                let back = spans.iter().filter(|(a, c)| p.0 < *c && *a < p.1).count();
                if back == 1 {
                    target = Some(p.2);
                }
            }
            let idx = match target {
                Some(i) => i,
                None => {
                    sections.push(Section { rows: vec![] });
                    sections.len() - 1
                }
            };
            sections[idx].rows.push((y, x0, x1, row_num));
            cur.push((x0, x1, idx));
        }
        prev = cur;
        let t = ((y - b.min_y) / h).clamp(0.0, 1.0);
        y += if let Some(r) = ramp {
            r.spacing(y)
        } else if end_spacing <= 0.0 {
            spacing
        } else if density_gradient {
            let (d0, d1) = (1.0 / spacing, 1.0 / end_spacing.max(0.05));
            1.0 / (d0 + (d1 - d0) * t)
        } else {
            spacing + (end_spacing - spacing) * t
        };
    }
    Grating { sections }
}

/// A carved pattern in the rotated frame (pattern, size, centre).
#[derive(Clone, Copy)]
pub(crate) struct Carve {
    pub pattern: crate::model::CarvePattern,
    pub size: f64,
    pub centre: Point,
}

thread_local! {
    /// The carving of the tatami being sewn (set around one fill).
    static CARVE: std::cell::Cell<Option<Carve>> = const { std::cell::Cell::new(None) };
    /// The tatami being sewn starts in the middle (set around one fill).
    static CENTER_OUT: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    /// The tatami being sewn leaves out the last stitch of every row.
    static SKIP_LAST: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    /// Pull compensation of the tatami being sewn as a share of each row's length.
    static PULL_PCT: std::cell::Cell<f64> = const { std::cell::Cell::new(0.0) };
    /// The tatami being sewn travels along the outline only (no underpath).
    static NO_UNDERPATH: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    /// Extra rows sewn into the gap at the end of each section before
    /// travelling on (Ink/Stitch `gap_fill_rows`, an even number).
    static GAP_ROWS: std::cell::Cell<u32> = const { std::cell::Cell::new(0) };
}

/// Alternate rows: the colour of every row (by row number). Each row takes
/// its mean colour mix (sampled along all its pieces); an error diffusion
/// down the rows then gives every row one colour, so through a transition
/// the colours alternate rows, the runs of one colour getting shorter towards
/// the other — Ink/Stitch's linear gradient fill (`_get_color_lines`), for any
/// gradient. `a`: the row frame's rotation.
fn row_colours(g: &GradientParams, grating: &Grating, a: f64) -> std::collections::HashMap<i64, u8> {
    let n = g.stops.len().max(1);
    let mut mix: std::collections::BTreeMap<i64, Vec<f64>> = Default::default();
    for sec in &grating.sections {
        for &(y, x0, x1, rn) in &sec.rows {
            let k = ((x1 - x0) / 1.0).ceil().max(1.0) as usize;
            let acc = mix.entry(rn).or_insert_with(|| vec![0.0; n]);
            for i in 0..k {
                let x = x0 + (x1 - x0) * ((i as f64 + 0.5) / k as f64);
                for (j, w) in super::gradient::weights_at(g, pt(x, y).rotate(-a)).iter().take(n).enumerate() {
                    acc[j] += w;
                }
            }
        }
    }
    let mut err = vec![0.0; n];
    let mut out = std::collections::HashMap::new();
    for (rn, acc) in mix {
        let sum: f64 = acc.iter().sum::<f64>().max(1e-12);
        let v: Vec<f64> = (0..n).map(|j| acc[j] / sum + err[j]).collect();
        let best = (0..n).max_by(|x, y| v[*x].partial_cmp(&v[*y]).unwrap()).unwrap_or(0);
        for j in 0..n {
            err[j] = v[j] - if j == best { 1.0 } else { 0.0 };
        }
        out.insert(rn, best as u8);
    }
    out
}

/// [`stitch_row`] for other fills (tartan): grid-aligned needle points along a row.
#[allow(clippy::too_many_arguments)]
pub(crate) fn stitch_row_pub(out: &mut Run, y: f64, x0: f64, x1: f64, row_num: i64, max_len: f64, staggers: u32, ltr: bool, f: u8) {
    stitch_row(out, y, x0, x1, row_num, max_len, staggers, ltr, f)
}

/// Stitch positions along one row (Ink/Stitch `stitch_row` with `adjust_stagger`).
fn stitch_row(out: &mut Run, y: f64, x0: f64, x1: f64, row_num: i64, max_len: f64, staggers: u32, ltr: bool, f: u8) {
    if let Some(c) = CARVE.with(|c| c.get()) {
        // carved: the needle points on the pattern's lines
        let (beg, end) = if ltr { (x0, x1) } else { (x1, x0) };
        push(out, pt(beg, y), f);
        let phase = (row_num as f64 / staggers.max(1) as f64).rem_euclid(1.0) * max_len;
        let mut xs = super::decor::carve_row(c.pattern, c.size, c.centre, y, x0, x1, max_len, phase);
        if !ltr {
            xs.reverse();
        }
        for x in xs {
            push(out, pt(x, y), f);
        }
        push(out, pt(end, y), f);
        return;
    }
    let (beg, end) = if ltr { (x0, x1) } else { (x1, x0) };
    push(out, pt(beg, y), f);
    if let Some((jitter, seed)) = super::running::line_random() {
        // random phase and lengths (Ink/Stitch split_segment_random_phase):
        // no grid, so no stagger pattern and no moiré
        let dist = (end - beg).abs();
        let dir = if ltr { 1.0 } else { -1.0 };
        let min_gap = 0.25_f64.min(max_len * 0.3);
        let stream = (row_num as u64).wrapping_mul(0x9E37_79B9) ^ ((x0 * 64.0).round() as i64 as u64);
        let mut rng = crate::prng::Stream::new(seed, stream);
        let mut d = min_gap + (max_len - min_gap) * rng.next();
        while d < dist - 0.05 {
            push(out, pt(beg + dir * d, y), f);
            d += max_len * (1.0 + jitter * (rng.next() - 0.5) * 2.0).max(0.1);
        }
        if !SKIP_LAST.with(|c| c.get()) {
            push(out, pt(end, y), f);
        }
        return;
    }
    let staggers = staggers.max(1) as f64;
    let phase = (row_num as f64 / staggers).rem_euclid(1.0) * max_len;
    // grid positions x = phase + k*max_len
    let min_gap = 0.25_f64.min(max_len * 0.3);
    if ltr {
        let mut x = ((beg - phase) / max_len).floor() * max_len + phase;
        while x <= beg + min_gap {
            x += max_len;
        }
        while x < end - min_gap {
            push(out, pt(x, y), f);
            x += max_len;
        }
    } else {
        let mut x = ((beg - phase) / max_len).ceil() * max_len + phase;
        while x >= beg - min_gap {
            x -= max_len;
        }
        while x > end + min_gap {
            push(out, pt(x, y), f);
            x -= max_len;
        }
    }
    if !SKIP_LAST.with(|c| c.get()) {
        push(out, pt(end, y), f);
    }
}

fn section_entries(s: &Section) -> [(Point, bool, bool); 4] {
    // (entry point, start_at_top, first row left-to-right)
    let f = s.rows.first().unwrap();
    let l = s.rows.last().unwrap();
    [
        (pt(f.1, f.0), true, true),
        (pt(f.2, f.0), true, false),
        (pt(l.1, l.0), false, true),
        (pt(l.2, l.0), false, false),
    ]
}

/// Where a section is left when it is entered through entry `k` of `section_entries`.
fn section_exit(s: &Section, k: usize) -> Point {
    let (_, top, ltr0) = section_entries(s)[k];
    let row = if top { s.rows.last().unwrap() } else { s.rows.first().unwrap() };
    // rows alternate direction; the last row runs like the first when the count is odd
    let last_ltr = if s.rows.len() % 2 == 1 { ltr0 } else { !ltr0 };
    pt(if last_ltr { row.2 } else { row.1 }, row.0)
}

#[allow(clippy::too_many_arguments)]
pub fn tatami(
    rings: &[Ring],
    angle_deg: f64,
    spacing: f64,
    end_spacing: f64,
    density_gradient: bool,
    max_len: f64,
    staggers: u32,
    pull: f64,
    travel_len: f64,
    start: Option<Point>,
    end: Option<Point>,
    gradient: Option<&GradientParams>,
    f: u8,
) -> Vec<Run> {
    tatami_ramp(rings, angle_deg, spacing, end_spacing, density_gradient, max_len, staggers, pull, travel_len, start, end, gradient, None, f)
}

/// Tatami with an optional density ramp along a vector.
#[allow(clippy::too_many_arguments)]
pub fn tatami_ramp(
    rings: &[Ring],
    angle_deg: f64,
    spacing: f64,
    end_spacing: f64,
    density_gradient: bool,
    max_len: f64,
    staggers: u32,
    pull: f64,
    travel_len: f64,
    start: Option<Point>,
    end: Option<Point>,
    gradient: Option<&GradientParams>,
    ramp: Option<(&crate::model::DensityRamp, f64)>,
    f: u8,
) -> Vec<Run> {
    crate::prof!("tatami (rows + travel)");
    if rings.is_empty() {
        return vec![];
    }
    let a = angle_deg.to_radians();
    let rr = rotate_rings(rings, a);
    let frame = ramp.map(|(r, k)| RampFrame::new(r, k, a));
    let mut grating = build_grating_ramp(&rr, spacing, end_spacing, density_gradient, pull, frame);
    // sewn from the middle: every section split at the middle row into two
    // halves, each sewn from the middle outwards; the fill starts there
    let mut middle: Option<Point> = None;
    if CENTER_OUT.with(|c| c.get()) {
        let ys: Vec<f64> = grating.sections.iter().flat_map(|s| s.rows.iter().map(|r| r.0)).collect();
        if let (Some(lo), Some(hi)) = (ys.iter().copied().reduce(f64::min), ys.iter().copied().reduce(f64::max)) {
            let ymid = (lo + hi) / 2.0;
            let mut secs = Vec::new();
            for sec in std::mem::take(&mut grating.sections) {
                let (up, down): (Vec<_>, Vec<_>) = sec.rows.into_iter().partition(|r| r.0 < ymid);
                if !up.is_empty() {
                    secs.push(Section { rows: up.into_iter().rev().collect() });
                }
                if !down.is_empty() {
                    secs.push(Section { rows: down });
                }
            }
            // the start: the widest row at the middle
            middle = secs
                .iter()
                .filter_map(|s| s.rows.first())
                .filter(|r| (r.0 - ymid).abs() <= spacing * 1.5)
                .max_by(|a, b| (a.2 - a.1).partial_cmp(&(b.2 - b.1)).unwrap())
                .map(|r| pt(r.1, r.0));
            grating.sections = secs;
        }
    }
    // gradient layer: only the cells of the row grid given to this colour,
    // or (alternate rows) only its rows
    let rows_mix = gradient.filter(|g| g.mix == crate::model::GradientMix::Rows);
    let mask = gradient.filter(|g| g.mix != crate::model::GradientMix::Rows).map(|g| LayerMask::new(g, &rr, a, spacing));
    let own_rows = rows_mix.map(|g| row_colours(g, &grating, a));
    let owns_row = |rn: i64| own_rows.as_ref().is_none_or(|m| m.get(&rn).copied() == Some(rows_mix.map_or(0, |g| g.layer.min(255) as u8)));
    let max_len = max_len.max(0.5);
    let mut remaining: Vec<usize> = (0..grating.sections.len()).filter(|i| !grating.sections[*i].rows.is_empty()).collect();
    let mut runs: Vec<Run> = Vec::new();
    let mut run: Run = Vec::new();
    let mut pos = middle.or(start.map(|p| p.rotate(a)));
    // travel between sections: Ink/Stitch's travel graph (rows horizontal
    // in this frame); sewn rows close the edges across them. Built when a
    // travel first needs it (a fill of one section never does), with the
    // rows sewn until then
    let no_underpath = rows_mix.is_some() || NO_UNDERPATH.with(|c| c.get());
    let mut graph: Option<super::travel::TravelGraph> = None;
    let mut sewn_before: Vec<(Point, Point)> = Vec::new();
    let travel_graph = |graph: &mut Option<super::travel::TravelGraph>, sewn_before: &mut Vec<(Point, Point)>| {
        if graph.is_none() {
            let mut g = super::travel::TravelGraph::new(&rr, 0.0);
            // alternate rows: every colour travels along the outline only (Ink/Stitch's
            // linear gradient fill sews its colours with underpath off); so does a
            // fill with underpath switched off
            if no_underpath {
                g.forbid(&|_| false);
            }
            // a density ramp's open end: travel keeps to the edge there
            if let Some(rf) = frame {
                g.open(&|q: Point| rf.spacing(q.y) / spacing.max(0.05));
            }
            for (a, b) in sewn_before.drain(..) {
                g.sewn(&[a, b], false);
            }
            *graph = Some(g);
        }
    };
    // with an end point, the section that can finish closest to it is sewn last
    let end_r = end.map(|p| p.rotate(a));
    let last_section = end_r.and_then(|e| {
        remaining.iter().copied().min_by(|x, y| {
            let dx = (0..4).map(|k| section_exit(&grating.sections[*x], k).dist(e)).fold(f64::INFINITY, f64::min);
            let dy = (0..4).map(|k| section_exit(&grating.sections[*y], k).dist(e)).fold(f64::INFINITY, f64::min);
            dx.partial_cmp(&dy).unwrap()
        })
    });
    while !remaining.is_empty() {
        let mut best = (0usize, 0usize, f64::INFINITY);
        if remaining.len() == 1 && last_section == Some(remaining[0]) {
            // final section: enter so that the exit lands next to the end point
            let e = end_r.unwrap();
            let sec = &grating.sections[remaining[0]];
            for k in 0..4 {
                // the start point wins ties; the end is then reached by travelling inside the shape
                let d = 0.5 * section_exit(sec, k).dist(e) + pos.map_or(0.0, |p| p.dist(section_entries(sec)[k].0));
                if d < best.2 - 1e-9 {
                    best = (0, k, d);
                }
            }
        } else {
            // choose nearest section entry
            for (ri, &si) in remaining.iter().enumerate() {
                if Some(si) == last_section {
                    continue;
                }
                for (k, e) in section_entries(&grating.sections[si]).iter().enumerate() {
                    let d = pos.map_or(0.0, |p| p.dist(e.0));
                    if d < best.2 - 1e-9 {
                        best = (ri, k, d);
                    }
                }
                if pos.is_none() {
                    break;
                }
            }
        }
        let si = remaining.remove(best.0);
        let sec = &grating.sections[si];
        let (entry, top, ltr0) = section_entries(sec)[best.1];
        // connect (into the first run there is nothing to travel from)
        if let Some(p) = pos.filter(|_| !run.is_empty()) {
            travel_graph(&mut graph, &mut sewn_before);
            let graph = graph.as_ref().unwrap();
            match graph.route(p, entry).or_else(|| travel_path(&rr, p, entry).filter(|path| path.windows(2).all(|w| !graph.crosses_sewn(w[0], w[1])))) {
                // every corner of the route kept (it goes round sewn rows)
                Some(path) if !run.is_empty() => {
                    for q in resample_max(&path, travel_len.max(0.5)).into_iter().skip(1) {
                        push(&mut run, q, f | flags::TRAVEL);
                    }
                }
                _ => {
                    if !run.is_empty() {
                        runs.push(std::mem::take(&mut run));
                    }
                }
            }
        }
        let rows: Vec<_> = if top { sec.rows.clone() } else { sec.rows.iter().rev().cloned().collect() };
        let mut ltr = ltr0;
        let row_gap = (spacing * 3.0).max(0.8);
        for (y, x0, x1, rn) in rows {
            if !owns_row(rn) {
                continue;
            }
            let pieces: Vec<(f64, f64)> = match &mask {
                Some(m) => m.pieces(y, x0, x1),
                None => vec![(x0, x1)],
            };
            if pieces.is_empty() {
                continue;
            }
            let (x0, x1) = (pieces[0].0, pieces[pieces.len() - 1].1);
            let start = pt(if ltr { x0 } else { x1 }, y);
            if mask.is_some() {
                // gradient layers skip rows: travel along the previous row line and
                // step across, or start a new run when that would cross the outside
                if let Some(&(prev, _)) = run.last() {
                    if prev.dist(start) > spacing * 3.0 {
                        let corner = pt(start.x, prev.y);
                        let m = mask.as_ref().unwrap();
                        let hidden = m.hidden_along_row(prev.y, prev.x, corner.x) && m.hidden_across_rows(corner.x, prev.y, start.y);
                        if hidden && (start.y - prev.y).abs() < 2.0 && segment_inside(&rr, prev, corner) && segment_inside(&rr, corner, start) {
                            for q in running_stitch(&[prev, corner], travel_len, 0.1).into_iter().skip(1) {
                                push(&mut run, q, f | flags::TRAVEL);
                            }
                        } else {
                            runs.push(std::mem::take(&mut run));
                        }
                    }
                }
            }
            // where boundary runs almost parallel to the rows, consecutive row
            // ends can be far apart: follow the outline instead of a long stitch
            if let Some(&(prev, _)) = run.last() {
                if prev.dist(start) > row_gap {
                    let mut followed = false;
                    if let Some((ri, d0)) = nearest_ring(&rr, prev) {
                        let d1 = nearest_ring(&rr, start).map(|x| x.1).unwrap_or(f64::INFINITY);
                        if d0 < 0.5 + pull && d1 < 0.5 + pull {
                            let path = ring_path(&rr[ri], prev, start);
                            for q in running_stitch(&path, travel_len.min(max_len), 0.1).into_iter().skip(1) {
                                push(&mut run, q, f | flags::TRAVEL);
                            }
                            followed = true;
                        }
                    }
                    // alternate rows: never straight across the other colours' rows
                    if !followed && rows_mix.is_some() {
                        travel_graph(&mut graph, &mut sewn_before);
                        match graph.as_ref().unwrap().route(prev, start) {
                            Some(path) => {
                                for q in resample_max(&path, travel_len.max(0.5)).into_iter().skip(1) {
                                    push(&mut run, q, f | flags::TRAVEL);
                                }
                            }
                            None => runs.push(std::mem::take(&mut run)),
                        }
                    }
                }
            }
            if pieces.len() == 1 {
                stitch_row(&mut run, y, x0, x1, rn, max_len, staggers, ltr, f);
            } else {
                // several pieces in one row: travel along the row line between them
                let ordered: Vec<(f64, f64)> = if ltr { pieces.clone() } else { pieces.iter().rev().cloned().collect() };
                for (k, &(p0, p1)) in ordered.iter().enumerate() {
                    if k > 0 {
                        let from = run.last().map(|x| x.0).unwrap_or(pt(p0, y));
                        let to = pt(if ltr { p0 } else { p1 }, y);
                        // travel only where later colours will cover it; otherwise a new run
                        if mask.as_ref().is_some_and(|m| m.hidden_along_row(y, from.x, to.x)) {
                            // hidden under a later colour: long stitches are enough
                            for q in running_stitch(&[from, to], max_len.max(travel_len), 0.1).into_iter().skip(1) {
                                push(&mut run, q, f | flags::TRAVEL);
                            }
                        } else if !run.is_empty() {
                            runs.push(std::mem::take(&mut run));
                        }
                    }
                    stitch_row(&mut run, y, p0, p1, rn, max_len, staggers, ltr, f);
                }
            }
            ltr = !ltr;
        }
        // gap filling (Ink/Stitch fill_gaps): before travelling on to another
        // section, repeat the last row a few times beyond it, into the gap
        // that fabric distortion opens between sections, and come back
        let gap_rows = GAP_ROWS.with(|c| c.get());
        if gap_rows > 0 && !remaining.is_empty() && sec.rows.len() > 3 && mask.is_none() && rows_mix.is_none() {
            let order: Vec<_> = if top { sec.rows.clone() } else { sec.rows.iter().rev().cloned().collect() };
            let (last, prev) = (order[order.len() - 1], order[order.len() - 2]);
            let step = last.0 - prev.0;
            if let Some(&(original_end, _)) = run.last() {
                // the last row ran the other way than the one before it
                let mut dir = !ltr;
                let mut rn = last.3;
                for k in 1..=gap_rows {
                    dir = !dir;
                    rn += if step >= 0.0 { 1 } else { -1 };
                    stitch_row(&mut run, last.0 + step * k as f64, last.1, last.2, rn, max_len, staggers, dir, f);
                }
                if let Some(&(back, _)) = run.last() {
                    for q in running_stitch(&[back, original_end], max_len, 0.1).into_iter().skip(1) {
                        push(&mut run, q, f);
                    }
                }
            }
        }
        for (y, x0, x1, rn) in &sec.rows {
            if !owns_row(*rn) {
                continue;
            }
            let pieces = match &mask {
                Some(m) => m.pieces(*y, *x0, *x1),
                None => vec![(*x0, *x1)],
            };
            for (p0, p1) in pieces {
                match graph.as_mut() {
                    Some(g) => g.sewn(&[pt(p0, *y), pt(p1, *y)], false),
                    None => sewn_before.push((pt(p0, *y), pt(p1, *y))),
                }
            }
        }
        pos = run.last().map(|x| x.0);
    }
    if !run.is_empty() {
        runs.push(run);
    }
    for r in runs.iter_mut() {
        for (p, _) in r.iter_mut() {
            *p = p.rotate(-a);
        }
    }
    runs
}

// ---------------------------------------------------------------------------
// Contour & spiral
// ---------------------------------------------------------------------------

fn inset_levels(rings: &[Ring], spacing: f64) -> Vec<Vec<Ring>> {
    let res = offset_resolution(rings).min(spacing * 0.3);
    let mut levels = Vec::new();
    let spacing = spacing.max(0.2);
    let Some(field) = DistanceField::new(rings, res, 0.0) else { return levels };
    for k in 0..400 {
        let d = spacing * 0.5 + k as f64 * spacing;
        let lv = field.contours(d);
        if lv.is_empty() {
            break;
        }
        levels.push(lv);
    }
    levels
}

fn rotate_ring_to(ring: &[Point], p: Point) -> Vec<Point> {
    let mut best = (0usize, f64::INFINITY);
    for (i, q) in ring.iter().enumerate() {
        let d = q.dist(p);
        if d < best.1 {
            best = (i, d);
        }
    }
    let mut out: Vec<Point> = ring[best.0..].iter().chain(ring[..best.0].iter()).copied().collect();
    if let Some(f) = out.first().copied() {
        out.push(f);
    }
    out
}

fn orient_ccw(ring: &mut Ring) {
    if signed_area(ring) < 0.0 {
        ring.reverse();
    }
}

pub fn contour(rings: &[Ring], spacing: f64, length: f64, spiral: bool, start: Option<Point>, f: u8) -> Vec<Run> {
    contour_ex(rings, spacing, length, spiral, false, false, start, f)
}

/// Contour fill with Ink/Stitch's strategies: a double spiral goes in on
/// every other ring and back out on the rest (ending next to its start);
/// `clockwise` turns the direction round.
#[allow(clippy::too_many_arguments)]
pub fn contour_ex(rings: &[Ring], spacing: f64, length: f64, spiral: bool, double: bool, clockwise: bool, start: Option<Point>, f: u8) -> Vec<Run> {
    let all = inset_levels(rings, spacing);
    let levels: Vec<Vec<Ring>> = if double && spiral {
        let inward = all.iter().step_by(2).cloned();
        let outward: Vec<Vec<Ring>> = all.iter().skip(1).step_by(2).cloned().collect();
        inward.chain(outward.into_iter().rev()).collect()
    } else {
        all
    };
    let orient = |r: &mut Ring| {
        orient_ccw(r);
        if clockwise {
            r.reverse();
        }
    };
    let mut runs = Vec::new();
    let mut run: Run = Vec::new();
    let mut pos: Option<Point> = start;
    let mut k = 0;
    while k < levels.len() {
        let mut lv = levels[k].clone();
        for r in lv.iter_mut() {
            orient(r);
        }
        // order rings at this level by proximity
        let mut rem: Vec<Ring> = lv;
        while !rem.is_empty() {
            let i = match pos {
                Some(p) => (0..rem.len())
                    .min_by(|a, b| {
                        let da = rem[*a].iter().map(|q| q.dist(p)).fold(f64::INFINITY, f64::min);
                        let db = rem[*b].iter().map(|q| q.dist(p)).fold(f64::INFINITY, f64::min);
                        da.partial_cmp(&db).unwrap()
                    })
                    .unwrap(),
                None => 0,
            };
            let ring = rem.remove(i);
            let start = pos.unwrap_or(ring[0]);
            let mut path = rotate_ring_to(&ring, start);
            // spiral blending into the single ring of the next level
            if spiral && rem.is_empty() && k + 1 < levels.len() && levels[k + 1].len() == 1 && levels[k].len() == 1 {
                let mut next = levels[k + 1][0].clone();
                orient(&mut next);
                let mut closed = next.clone();
                closed.push(next[0]);
                let cum = cumulative_lengths(&closed);
                let total = polyline_length(&path).max(1e-9);
                let pc = cumulative_lengths(&path);
                path = path
                    .iter()
                    .zip(pc.iter())
                    .map(|(q, d)| {
                        let t = d / total;
                        let (s, _) = project(&closed, &cum, *q);
                        q.lerp(point_at(&closed, &cum, s), t)
                    })
                    .collect();
                path.pop();
            }
            let gap = pos.map_or(0.0, |p| p.dist(path[0]));
            if gap > spacing * 2.5 && !run.is_empty() {
                runs.push(std::mem::take(&mut run));
            }
            for q in super::running::sew_line(&path, length, 0.1) {
                push(&mut run, q, f);
            }
            pos = run.last().map(|x| x.0);
        }
        k += 1;
    }
    if !run.is_empty() {
        runs.push(run);
    }
    runs
}

// ---------------------------------------------------------------------------
// Radial (sunburst) — new
// ---------------------------------------------------------------------------

fn ray_intervals(rings: &[Ring], c: Point, u: Point, rmax: f64) -> Vec<(f64, f64)> {
    let far = c + u * rmax;
    let mut ts = Vec::new();
    for ring in rings {
        let n = ring.len();
        for i in 0..n {
            if let Some((t, _)) = segment_intersection(c, far, ring[i], ring[(i + 1) % n]) {
                ts.push(t * rmax);
            }
        }
    }
    ts.sort_by(|a, b| a.partial_cmp(b).unwrap());
    ts.dedup_by(|a, b| (*a - *b).abs() < 1e-7);
    let mut inside = point_in_rings(c, rings);
    let mut out = Vec::new();
    let mut last = 0.0;
    for t in ts {
        if inside {
            out.push((last, t));
        }
        inside = !inside;
        last = t;
    }
    out
}

pub fn radial(rings: &[Ring], center_rel: [f64; 2], spacing: f64, max_len: f64, f: u8) -> Vec<Run> {
    let b = rings_bounds(rings);
    if b.is_empty() {
        return vec![];
    }
    let c = pt(b.min_x + b.width() * center_rel[0], b.min_y + b.height() * center_rel[1]);
    let rmax = rings.iter().flatten().map(|p| p.dist(c)).fold(0.0, f64::max) + 0.5;
    let spacing = spacing.max(0.15);
    let m = ((TAU * rmax / spacing).log2().round() as u32).clamp(3, 14);
    let n = 1usize << m;
    let mut runs = Vec::new();
    let mut run: Run = Vec::new();
    let mut outward = true;
    for i in 0..n {
        let level = if i == 0 { m } else { (i as u32).trailing_zeros() };
        let r_start = if level + 2 >= m { 0.0 } else { rmax / (1u64 << level) as f64 };
        let th = TAU * i as f64 / n as f64;
        let u = pt(th.cos(), th.sin());
        let iv = ray_intervals(rings, c, u, rmax + 1.0);
        let Some(&(t0, t1)) = iv.iter().find(|(_, t1)| *t1 > r_start + 0.2) else { continue };
        let t0 = t0.max(r_start);
        if t1 - t0 < 0.3 {
            continue;
        }
        let (a, z) = (c + u * t0, c + u * t1);
        let seg = if outward { vec![a, z] } else { vec![z, a] };
        if let Some(&(last, _)) = run.last() {
            if !segment_inside(rings, last, seg[0]) && last.dist(seg[0]) > spacing * 3.0 {
                runs.push(std::mem::take(&mut run));
            }
        }
        for q in running_stitch(&seg, max_len, 0.1) {
            push(&mut run, q, f);
        }
        outward = !outward;
    }
    if !run.is_empty() {
        runs.push(run);
    }
    runs
}

// ---------------------------------------------------------------------------
// Hilbert curve — new
// ---------------------------------------------------------------------------

fn hilbert_d2xy(n: u32, d: u64) -> (u32, u32) {
    let (mut x, mut y) = (0u32, 0u32);
    let mut t = d;
    let mut s = 1u32;
    while s < n {
        let rx = (1 & (t / 2)) as u32;
        let ry = (1 & (t ^ rx as u64)) as u32;
        if ry == 0 {
            if rx == 1 {
                x = s - 1 - x;
                y = s - 1 - y;
            }
            std::mem::swap(&mut x, &mut y);
        }
        x += s * rx;
        y += s * ry;
        t /= 4;
        s *= 2;
    }
    (x, y)
}

pub fn hilbert(rings: &[Ring], cell: f64, max_len: f64, f: u8) -> Vec<Run> {
    let b = rings_bounds(rings);
    if b.is_empty() {
        return vec![];
    }
    let cell = cell.max(0.4);
    let side = b.width().max(b.height());
    let order = ((side / cell).log2().ceil() as u32).clamp(1, 11);
    let n = 1u32 << order;
    let cell = side / n as f64;
    let mut runs = Vec::new();
    let mut run: Run = Vec::new();
    let mut last_inside: Option<Point> = None;
    for d in 0..(n as u64 * n as u64) {
        let (x, y) = hilbert_d2xy(n, d);
        let p = pt(b.min_x + (x as f64 + 0.5) * cell, b.min_y + (y as f64 + 0.5) * cell);
        if !point_in_rings(p, rings) {
            continue;
        }
        if let Some(l) = last_inside {
            let adjacent = l.dist(p) < cell * 1.01;
            if !(adjacent || segment_inside(rings, l, p)) {
                if run.len() > 1 {
                    runs.push(std::mem::take(&mut run));
                } else {
                    run.clear();
                }
            } else if l.dist(p) > max_len {
                for q in running_stitch(&[l, p], max_len, 0.1).into_iter().skip(1) {
                    push(&mut run, q, f);
                }
                last_inside = Some(p);
                continue;
            }
        }
        push(&mut run, p, f);
        last_inside = Some(p);
    }
    if run.len() > 1 {
        runs.push(run);
    }
    runs
}

// ---------------------------------------------------------------------------
// Stipple (TSP art) — new
// ---------------------------------------------------------------------------

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> f64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        (self.0 >> 11) as f64 / (1u64 << 53) as f64
    }
}

/// Bridson Poisson-disk sampling inside the region.
fn poisson_disk(rings: &[Ring], r: f64, seed: u64) -> Vec<Point> {
    let b = rings_bounds(rings);
    let cs = r / std::f64::consts::SQRT_2;
    let gw = (b.width() / cs).ceil() as usize + 1;
    let gh = (b.height() / cs).ceil() as usize + 1;
    let mut grid: Vec<Option<usize>> = vec![None; gw * gh];
    let mut pts: Vec<Point> = Vec::new();
    let mut active: Vec<usize> = Vec::new();
    let mut rng = Rng(seed | 1);
    let gi = |p: Point| -> (usize, usize) {
        (((p.x - b.min_x) / cs) as usize, ((p.y - b.min_y) / cs) as usize)
    };
    // seed points: try several random starting points (multiple components)
    for _ in 0..200 {
        let p = pt(b.min_x + rng.next() * b.width(), b.min_y + rng.next() * b.height());
        if point_in_rings(p, rings) {
            let (x, y) = gi(p);
            if grid[y * gw + x].is_none() {
                grid[y * gw + x] = Some(pts.len());
                active.push(pts.len());
                pts.push(p);
            }
        }
        if pts.len() > 8 {
            break;
        }
    }
    while let Some(&ai) = active.last() {
        if pts.len() > 20_000 {
            break;
        }
        let base = pts[ai];
        let mut found = false;
        for _ in 0..24 {
            let ang = rng.next() * TAU;
            let rad = r * (1.0 + rng.next());
            let p = base + pt(ang.cos(), ang.sin()) * rad;
            if p.x < b.min_x || p.y < b.min_y || p.x > b.max_x || p.y > b.max_y || !point_in_rings(p, rings) {
                continue;
            }
            let (x, y) = gi(p);
            let mut ok = true;
            'outer: for yy in y.saturating_sub(2)..(y + 3).min(gh) {
                for xx in x.saturating_sub(2)..(x + 3).min(gw) {
                    if let Some(j) = grid[yy * gw + xx] {
                        if pts[j].dist(p) < r {
                            ok = false;
                            break 'outer;
                        }
                    }
                }
            }
            if ok {
                grid[y * gw + x] = Some(pts.len());
                active.push(pts.len());
                pts.push(p);
                found = true;
                break;
            }
        }
        if !found {
            active.pop();
        }
    }
    pts
}

/// Nearest-neighbour tour + bounded 2-opt. Edges leaving the region are penalised.
pub fn tsp_tour(pts: &[Point], rings: &[Ring], start: Point) -> Vec<usize> {
    let n = pts.len();
    if n == 0 {
        return vec![];
    }
    let mut used = vec![false; n];
    let mut order = Vec::with_capacity(n);
    let mut cur = (0..n).min_by(|a, b| pts[*a].dist(start).partial_cmp(&pts[*b].dist(start)).unwrap()).unwrap();
    // bucket grid for NN queries
    let b = Rect::of_points(pts.iter());
    let cs = ((b.width() * b.height()) / n as f64).sqrt().max(0.1) * 1.5;
    let gw = (b.width() / cs) as usize + 1;
    let gh = (b.height() / cs) as usize + 1;
    let mut buckets: Vec<Vec<usize>> = vec![vec![]; gw * gh];
    let cell = |p: Point| (((p.x - b.min_x) / cs) as usize).min(gw - 1) + (((p.y - b.min_y) / cs) as usize).min(gh - 1) * gw;
    for (i, p) in pts.iter().enumerate() {
        buckets[cell(*p)].push(i);
    }
    for _ in 0..n {
        used[cur] = true;
        order.push(cur);
        let p = pts[cur];
        let (cx, cy) = ((((p.x - b.min_x) / cs) as isize), (((p.y - b.min_y) / cs) as isize));
        let mut best: Option<(usize, f64)> = None;
        let mut ring = 0isize;
        while ring < (gw.max(gh) as isize + 1) {
            for y in (cy - ring)..=(cy + ring) {
                for x in (cx - ring)..=(cx + ring) {
                    if (y - cy).abs() != ring && (x - cx).abs() != ring {
                        continue;
                    }
                    if x < 0 || y < 0 || x >= gw as isize || y >= gh as isize {
                        continue;
                    }
                    for &j in &buckets[y as usize * gw + x as usize] {
                        if used[j] {
                            continue;
                        }
                        let mut d = p.dist(pts[j]);
                        if d > cs && !segment_inside(rings, p, pts[j]) {
                            d *= 8.0;
                        }
                        if best.map_or(true, |(_, bd)| d < bd) {
                            best = Some((j, d));
                        }
                    }
                }
            }
            if let Some((_, bd)) = best {
                if bd < ring as f64 * cs {
                    break;
                }
            }
            ring += 1;
        }
        match best {
            Some((j, _)) => cur = j,
            None => break,
        }
    }
    // 2-opt with a window (keeps it near-linear)
    let window = 40usize;
    for _pass in 0..3 {
        let mut improved = false;
        for i in 1..order.len().saturating_sub(2) {
            for j in (i + 1)..(i + window).min(order.len() - 1) {
                let (a, bb, c, d) = (pts[order[i - 1]], pts[order[i]], pts[order[j]], pts[order[j + 1]]);
                if a.dist(c) + bb.dist(d) + 1e-9 < a.dist(bb) + c.dist(d) {
                    order[i..=j].reverse();
                    improved = true;
                }
            }
        }
        if !improved {
            break;
        }
    }
    order
}

pub fn stipple(rings: &[Ring], spacing: f64, max_len: f64, f: u8) -> Vec<Run> {
    let area = rings_area(rings);
    let mut r = spacing.max(0.6);
    // keep the point count bounded
    while area / (r * r * 0.8) > 12_000.0 {
        r *= 1.2;
    }
    let pts = poisson_disk(rings, r, 0x9E3779B97F4A7C15);
    if pts.len() < 2 {
        return vec![];
    }
    let b = rings_bounds(rings);
    let order = tsp_tour(&pts, rings, pt(b.min_x, b.min_y));
    let mut runs = Vec::new();
    let mut run: Run = Vec::new();
    let mut last: Option<Point> = None;
    for i in order {
        let p = pts[i];
        if let Some(l) = last {
            if !segment_inside(rings, l, p) {
                match travel_path(rings, l, p) {
                    Some(path) => {
                        for q in running_stitch(&path, max_len, 0.1).into_iter().skip(1) {
                            push(&mut run, q, f);
                        }
                    }
                    None => {
                        if run.len() > 1 {
                            runs.push(std::mem::take(&mut run));
                        } else {
                            run.clear();
                        }
                    }
                }
            } else if l.dist(p) > max_len {
                for q in running_stitch(&[l, p], max_len, 0.1).into_iter().skip(1) {
                    push(&mut run, q, f);
                }
            }
        }
        push(&mut run, p, f);
        last = Some(p);
    }
    if run.len() > 1 {
        runs.push(run);
    }
    runs
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/// The field of a curved fill: the rows of its mesh gradient, around the
/// points of a freeform gradient, else along the outline.
fn curved_field(rings: &[Ring], p: &FillParams, strength: f64) -> crate::model::FlowField {
    use crate::model::GradientKind;
    let base = -p.angle.to_radians();
    match p.gradient.as_ref() {
        Some(g) if g.kind == GradientKind::Mesh => {
            if let Some(f) = g.mesh.as_ref().and_then(|m| super::fields::mesh_field(rings, m, base)) {
                return f;
            }
        }
        Some(g) if g.kind == GradientKind::Freeform && !g.points.is_empty() => return super::fields::points_field(rings, &g.points, base),
        _ => {}
    }
    super::fields::shape_field(rings, base, strength)
}

/// Where a colour's share falls below this its rows count as open (travel
/// keeps to the edge there).
const MIN_SHARE: f64 = 0.08;

/// A streamline fill along a field, with a density ramp's row distance.
///
/// The colours of a gradient (and the two of a colour blend) share one set
/// of full-density lines: every point of a line is sewn by exactly one
/// colour, picked by an ordered dither across the lines, so each colour
/// takes about its share of the lines and the colours together sew every
/// line once. The density stays even however the colours mix. A colour
/// travels along its line under the parts a later colour sews.
fn streamlines(rings: &[Ring], field: &crate::model::FlowField, p: &FillParams, spacing: f64, density: f64, start: Option<Point>) -> Vec<Run> {
    streamlines_sewn(rings, field, p, spacing, density, start, None)
}

/// Straight rows of a blended gradient or colour blend: streamlines of a
/// field that points along the fill angle everywhere (parallel rows shared
/// by the colours), their needle points staggered like tatami rows.
fn straight_blend(rings: &[Ring], p: &FillParams, spacing: f64, density: f64, start: Option<Point>) -> Vec<Run> {
    let a = p.angle.to_radians();
    let b = rings_bounds(rings);
    let field = crate::model::FlowField { origin: [b.min_x, b.min_y], cell: b.width().max(b.height()).max(1.0), cols: 1, rows: 1, angles: vec![(-a) as f32] };
    let (max_len, staggers) = (p.max_stitch_length, p.staggers);
    let sew = move |pts: &[Point]| -> Vec<Point> {
        let (s0, s1) = (pts[0].rotate(a), pts[pts.len() - 1].rotate(a));
        let y = (s0.y + s1.y) * 0.5;
        let mut row: Run = Vec::new();
        stitch_row(&mut row, y, s0.x.min(s1.x), s0.x.max(s1.x), (y / spacing).round() as i64, max_len, staggers, s1.x >= s0.x, 0);
        row.into_iter().map(|(q, _)| q.rotate(-a)).collect()
    };
    streamlines_sewn(rings, &field, p, spacing, density, start, Some(&sew))
}

#[allow(clippy::too_many_arguments)]
fn streamlines_sewn(rings: &[Ring], field: &crate::model::FlowField, p: &FillParams, spacing: f64, density: f64, start: Option<Point>, sew: Option<&dyn Fn(&[Point]) -> Vec<Point>>) -> Vec<Run> {
    let a = p.angle.to_radians();
    let frame = p.ramp.as_ref().map(|r| RampFrame::new(r, density, a));
    let share = p.gradient.as_ref().map(|g| super::gradient::ShareGrid::new(g, rings, spacing));
    // a colour blend: this layer's ramp and the other layer's opposite one,
    // sewn as one set of lines at their summed density
    let other = p.ramp.as_ref().filter(|r| r.additive && r.group.is_some() && share.is_none()).map(|r| crate::model::DensityRamp { reverse: !r.reverse, ..r.clone() });
    let other_frame = other.as_ref().map(|r| RampFrame::new(r, density, a));
    // the full row distance (all colours together)
    let row = move |q: Point| {
        let y = q.rotate(a).y;
        match (frame, other_frame) {
            (Some(f), Some(g)) => 1.0 / (1.0 / f.spacing(y) + 1.0 / g.spacing(y)),
            (Some(f), None) => f.spacing(y),
            _ => spacing,
        }
    };
    // this colour's share of the lines
    let mine = |q: Point| match (&share, frame, other_frame) {
        (Some(s), _, _) => s.at(q),
        (None, Some(f), Some(_)) => row(q) / f.spacing(q.rotate(a).y),
        _ => 1.0,
    };
    // the blend's first colour fades out (it is sewn first)
    let blend_layer = usize::from(p.ramp.as_ref().is_some_and(|r| r.reverse));
    let pick = |q: Point, tau: f64| match &share {
        Some(s) => s.colour(q, tau),
        None => {
            let first = if blend_layer == 0 { mine(q) } else { 1.0 - mine(q) };
            usize::from(tau >= first)
        }
    };
    let shared = share.is_some() || other_frame.is_some();
    // travel never on the colours sewn before this one (it would lie on top
    // of them): under later colours or over its own it hardly shows; the
    // order of the lines keeps it off its own sewn lines where it can
    let travel = |q: Point| share.as_ref().is_none_or(|s| 1.0 - s.at(q) - s.later_at(q) <= 0.4);
    // open rows (this colour's row distance over the normal one): travel keeps to the edge there
    let open = |q: Point| row(q) / mine(q).max(MIN_SHARE) / spacing.max(0.05);
    // the shared lines depend on the shape, the field and the full row
    // distance only (a blend's two ramps add up the same either way round)
    let lines_key = shared.then(|| {
        use std::hash::{Hash, Hasher};
        let mut h = std::collections::hash_map::DefaultHasher::new();
        for ring in rings {
            ring.len().hash(&mut h);
            for q in ring {
                (q.x.to_bits(), q.y.to_bits()).hash(&mut h);
            }
        }
        (field.origin[0].to_bits(), field.origin[1].to_bits(), field.cell.to_bits(), field.cols, field.rows).hash(&mut h);
        field.angles.iter().for_each(|x| x.to_bits().hash(&mut h));
        (spacing.to_bits(), density.to_bits(), a.to_bits(), share.is_some(), other_frame.is_some()).hash(&mut h);
        let ramp = p.ramp.as_ref().map(|r| crate::model::DensityRamp { reverse: r.reverse && other_frame.is_none(), ..r.clone() });
        serde_json::to_string(&ramp).unwrap_or_default().hash(&mut h);
        h.finish()
    });
    let o = super::inkfills::FlowOpts {
        lines_key,
        sep: (frame.is_some() || shared).then_some(&row as &dyn Fn(Point) -> f64),
        pick: shared.then_some(&pick as &dyn Fn(Point, f64) -> usize),
        layer: p.gradient.as_ref().map_or(blend_layer, |g| g.layer as usize),
        // a gradient's layers are sewn in order; a blend's may be reordered
        hide_later: share.is_some(),
        travel: share.is_some().then_some(&travel as &dyn Fn(Point) -> bool),
        sew,
        angle: a,
        open: (frame.is_some() || shared).then_some(&open as &dyn Fn(Point) -> f64),
        ..Default::default()
    };
    super::inkfills::flow_ex(rings, field, spacing, p.max_stitch_length, p.travel_length, start, &o, 0)
}

#[allow(clippy::too_many_arguments)]
pub fn fill(
    paths: &[SubPath],
    p: &FillParams,
    extra_pull: f64,
    density: f64,
    force_underlay: bool,
    underlay_density: f64,
    start: Option<Point>,
    end: Option<Point>,
) -> Vec<Run> {
    let fabric = crate::model::FabricProfile { pull_comp: extra_pull, density_scale: density, force_underlay, underlay_density, ..crate::model::Fabric::Cotton.profile() };
    fill_on(paths, p, &fabric, start, end)
}

/// Join runs one after another by travelling inside the shape where it can
/// (a jump where it cannot); the travel takes `flag`.
pub(crate) fn chain(rings: &[Ring], runs: Vec<Run>, travel_len: f64, flag: u8) -> Vec<Run> {
    let mut out: Vec<Run> = Vec::new();
    for r in runs.into_iter().filter(|r| !r.is_empty()) {
        if let Some(last) = out.last_mut() {
            let (a, b) = (last[last.len() - 1].0, r[0].0);
            if let Some(path) = travel_path(rings, a, b) {
                for q in resample_max(&path, travel_len.max(0.5)).into_iter().skip(1) {
                    push(last, q, flag);
                }
                for &(q, f) in &r {
                    push(last, q, f);
                }
                continue;
            }
        }
        out.push(r);
    }
    out
}

/// Edge run: a running stitch around every ring (the outline first), each
/// starting where it comes nearest the previous position.
fn edge_run(rings: &[Ring], stitch_len: f64, start: Option<Point>, f: u8) -> Vec<Run> {
    let mut pos = start;
    let mut out = Vec::new();
    for ring in rings.iter().filter(|r| r.len() >= 3) {
        let k = pos.map_or(0, |p| (0..ring.len()).min_by(|&a, &b| ring[a].dist(p).partial_cmp(&ring[b].dist(p)).unwrap()).unwrap_or(0));
        let mut pts: Vec<Point> = ring[k..].iter().chain(ring[..k].iter()).copied().collect();
        pts.push(pts[0]);
        let run: Run = running_stitch(&pts, stitch_len.max(1.0), 0.1).into_iter().map(|q| (q, f)).collect();
        pos = run.last().map(|x| x.0);
        out.push(run);
    }
    out
}

/// A fill with its underlay on a fabric (the fabric's compensation, density
/// and auto underlay rules).
pub fn fill_on(paths: &[SubPath], p: &FillParams, fabric: &crate::model::FabricProfile, start: Option<Point>, end: Option<Point>) -> Vec<Run> {
    let (extra_pull, density, underlay_density) = (fabric.pull_comp, fabric.density_scale, fabric.underlay_density);
    let mut rings = fill_rings(paths);
    let original = rings.clone();
    // Ink/Stitch "expand": the shape grows (or shrinks) before it is filled
    if p.expand.abs() > 1e-6 && !rings.is_empty() {
        let grown = offset_rings(&rings, p.expand, offset_resolution(&rings));
        if !grown.is_empty() {
            rings = grown;
        }
    }
    if rings.is_empty() {
        return vec![];
    }
    let mut runs: Vec<Run> = Vec::new();
    let spacing = (p.row_spacing * density).max(0.1);
    // a gradient's underlay is sewn once, by its first layer
    let plan = super::underlay::fill_underlay(&rings, p, fabric);
    let underlay_on = !plan.is_empty() && p.gradient.as_ref().map_or(true, |g| g.layer == 0) && p.tartan.as_ref().map_or(true, |t| t.layer == 0);
    if underlay_on && matches!(p.method, FillMethod::Tatami | FillMethod::Radial | FillMethod::Contour | FillMethod::Spiral | FillMethod::Meander | FillMethod::Guided | FillMethod::Circular | FillMethod::Flow | FillMethod::Curved | FillMethod::Tartan) {
        let res = offset_resolution(&rings);
        let inset = if p.underlay_inset > 0.0 { offset_rings(&rings, -p.underlay_inset, res) } else { rings.clone() };
        if !inset.is_empty() {
            // edge run first (an edge run under tatami), then the tatami passes
            SKIP_LAST.with(|c| c.set(p.underlay_skip_last));
            NO_UNDERPATH.with(|c| c.set(!p.underpath));
            let mut ul: Vec<Run> = Vec::new();
            if plan.edge {
                ul.extend(edge_run(&inset, p.underlay_stitch_length.min(3.0), start, flags::UNDERLAY));
            }
            for a in &plan.passes {
                let from = ul.last().and_then(|r| r.last()).map(|x| x.0).or(start);
                ul.extend(tatami(
                    &inset,
                    p.angle + a,
                    (p.underlay_spacing * underlay_density).max(0.3),
                    0.0,
                    false,
                    p.underlay_stitch_length,
                    1,
                    0.0,
                    p.travel_length,
                    from,
                    None,
                    None,
                    flags::UNDERLAY,
                ));
            }
            SKIP_LAST.with(|c| c.set(false));
            runs.extend(chain(&rings, ul, p.travel_length, flags::UNDERLAY));
        }
    }
    let top_start = runs.last().and_then(|r| r.last()).map(|x| x.0).or(start);
    // gradients and density ramps need rows: other fills fall back to tatami
    let method = if (p.gradient.is_some() || p.ramp.is_some()) && !matches!(p.method, FillMethod::Tatami | FillMethod::Flow | FillMethod::Curved) {
        FillMethod::Tatami
    } else {
        p.method
    };
    CENTER_OUT.with(|c| c.set(p.center_out && method == FillMethod::Tatami));
    SKIP_LAST.with(|c| c.set(p.skip_last && method == FillMethod::Tatami));
    NO_UNDERPATH.with(|c| c.set(!p.underpath));
    GAP_ROWS.with(|c| c.set(if method == FillMethod::Tatami { p.gap_fill_rows.div_ceil(2) * 2 } else { 0 }));
    PULL_PCT.with(|c| c.set(if method == FillMethod::Tatami { p.pull_comp_pct.clamp(0.0, 1.0) } else { 0.0 }));
    let random = if method == FillMethod::Meander || method == FillMethod::Cross { 0.0 } else { p.random_length };
    let top = super::running::with_line_random(random, p.seed, || match method {
        FillMethod::Tatami if p.carve != crate::model::CarvePattern::None && p.gradient.is_none() => {
            // the pattern in the row frame, centred on the shape
            let a = p.angle.to_radians();
            let b = rings_bounds(&rotate_rings(&rings, a));
            let carve = Carve { pattern: p.carve, size: p.carve_size, centre: pt((b.min_x + b.max_x) / 2.0, (b.min_y + b.max_y) / 2.0) };
            CARVE.with(|c| c.set(Some(carve)));
            let r = tatami_ramp(
                &rings,
                p.angle,
                spacing,
                if p.end_row_spacing > 0.0 { p.end_row_spacing * density } else { 0.0 },
                p.gradient_density,
                p.max_stitch_length,
                p.staggers,
                p.pull_comp + extra_pull * 0.5,
                p.travel_length,
                top_start,
                end,
                None,
                p.ramp.as_ref().map(|r| (r, density)),
                0,
            );
            CARVE.with(|c| c.set(None));
            r
        }
        // a blended gradient in straight rows
        // (and a colour blend: its two colours share the rows)
        FillMethod::Tatami
            if p.gradient.as_ref().is_some_and(|g| g.mix == crate::model::GradientMix::Blend) || (p.gradient.is_none() && p.ramp.as_ref().is_some_and(|r| r.additive && r.group.is_some())) =>
        {
            straight_blend(&rings, p, spacing, density, top_start)
        }
        FillMethod::Cross => super::decor::cross_full_ex(
            &rings,
            p.angle,
            p.cross_size,
            p.cross_coverage,
            p.cross_kind,
            p.cross_grid_canvas,
            p.cross_offset,
            p.cross_flip,
            p.cross_threads,
            p.travel_length,
            top_start,
            &super::decor::CrossOpts { size_y: p.cross_size_y, dense: p.cross_dense, max_len: p.cross_max_length },
            0,
        ),
        FillMethod::Tatami => tatami_ramp(
            &rings,
            p.angle,
            spacing,
            if p.end_row_spacing > 0.0 { p.end_row_spacing * density } else { 0.0 },
            p.gradient_density,
            p.max_stitch_length,
            p.staggers,
            p.pull_comp + extra_pull * 0.5,
            p.travel_length,
            top_start,
            end,
            p.gradient.as_ref(),
            p.ramp.as_ref().map(|r| (r, density)),
            0,
        ),
        FillMethod::Contour => contour_ex(&rings, spacing, p.max_stitch_length.min(3.0), false, false, p.clockwise, top_start, 0),
        FillMethod::Spiral => contour_ex(&rings, spacing, p.max_stitch_length.min(3.0), true, p.contour_double, p.clockwise, top_start, 0),
        FillMethod::Radial => radial(&rings, p.center, spacing, p.max_stitch_length, 0),
        FillMethod::Hilbert => hilbert(&rings, spacing, p.max_stitch_length, 0),
        FillMethod::Stipple => stipple(&rings, spacing, p.max_stitch_length, 0),
        FillMethod::Meander => super::inkfills::meander_ex(
            &rings,
            p.meander_pattern,
            p.meander_tile.as_deref().and_then(super::meander_tiles::tile),
            p.meander_scale,
            p.angle,
            p.smoothness,
            p.max_stitch_length,
            p.travel_length,
            p.seed,
            top_start,
            end,
            &super::inkfills::MeanderOpts {
                aspect: p.meander_aspect,
                zigzag: (p.meander_zigzag > 0.0).then_some((p.meander_zigzag, p.meander_zigzag_width)),
                clip: p.meander_clip.then_some(original.as_slice()),
            },
            0,
        ),
        // parallel offset / buffer: streamlines along the guide's direction
        FillMethod::Guided if p.guided_strategy != crate::model::GuidedStrategy::Copy && p.guide.is_some() => {
            let gpts = p.guide.as_ref().unwrap().flatten(0.1);
            match super::fields::guide_field(&rings, &gpts, p.guided_strategy == crate::model::GuidedStrategy::Buffer) {
                Some(field) => streamlines(&rings, &field, p, spacing, density, top_start),
                None => tatami(&rings, p.angle, spacing, 0.0, false, p.max_stitch_length, p.staggers, p.pull_comp, p.travel_length, top_start, end, None, 0),
            }
        }
        FillMethod::Guided => p
            .guide
            .as_ref()
            .and_then(|g| {
                super::inkfills::guided(&rings, g, spacing, p.max_stitch_length, p.staggers, p.pull_comp + extra_pull * 0.5, p.travel_length, top_start, end, 0)
            })
            .unwrap_or_else(|| {
                tatami(&rings, p.angle, spacing, 0.0, false, p.max_stitch_length, p.staggers, p.pull_comp + extra_pull * 0.5, p.travel_length, top_start, end, None, 0)
            }),
        // the picture's flow; without one the rows follow the shape
        FillMethod::Flow => match &p.flow {
            Some(field) => streamlines(&rings, field, p, spacing, density, top_start),
            // a gradient: the rows follow its colour bands (or cross them)
            None => {
                let field = p.gradient.as_ref().and_then(|g| super::fields::colour_field(&rings, g, -p.angle.to_radians(), p.flow_across)).unwrap_or_else(|| curved_field(&rings, p, 1.0));
                streamlines(&rings, &field, p, spacing, density, top_start)
            }
        },
        FillMethod::Curved => streamlines(&rings, &curved_field(&rings, p, p.curve), p, spacing, density, top_start),
        // after an underlay (which ends at the outline) the spiral runs outside-in,
        // so no travel line crosses the open spiral rows
        FillMethod::Circular => super::inkfills::circular(&rings, p.center, spacing, p.max_stitch_length, p.travel_length, underlay_on, 0),
        FillMethod::Tartan => super::tartan::tartan(&rings, p, &p.tartan.clone().unwrap_or_default(), spacing, top_start, 0),
    });
    CENTER_OUT.with(|c| c.set(false));
    SKIP_LAST.with(|c| c.set(false));
    PULL_PCT.with(|c| c.set(0.0));
    NO_UNDERPATH.with(|c| c.set(false));
    GAP_ROWS.with(|c| c.set(0));
    // running-style fills: the path repeated and bean-stitched (Ink/Stitch)
    let top: Vec<Run> = if matches!(method, FillMethod::Meander | FillMethod::Circular | FillMethod::Contour | FillMethod::Spiral) && (p.repeats > 1 || p.bean_repeats > 0) {
        top.into_iter()
            .map(|r| {
                let pts: Vec<Point> = r.iter().map(|x| x.0).collect();
                let pts = super::running::repeat_path(&pts, p.repeats.max(1));
                let pts = super::running::bean_stitch(&pts, p.bean_repeats);
                pts.into_iter().map(|q| (q, 0u8)).collect()
            })
            .collect()
    } else {
        top
    };
    // join underlay end with top start by travelling inside the shape
    if let (Some(last_run), Some(first_top)) = (runs.last_mut(), top.first()) {
        if let (Some(&(a, _)), Some(&(b, _))) = (last_run.last(), first_top.first()) {
            if let Some(path) = travel_path(&rings, a, b) {
                for q in running_stitch(&path, p.travel_length, 0.1).into_iter().skip(1) {
                    push(last_run, q, flags::TRAVEL);
                }
                let mut it = top.into_iter();
                let first = it.next().unwrap();
                for (q, f) in first {
                    push(last_run, q, f);
                }
                runs.extend(it);
                return finish_at(runs, &rings, end, p.travel_length);
            }
        }
    }
    runs.extend(top);
    finish_at(runs, &rings, end, p.travel_length)
}

/// Ink/Stitch "fill end" command: finish exactly at the end point, travelling inside the shape.
fn finish_at(mut runs: Vec<Run>, rings: &[Ring], end: Option<Point>, travel: f64) -> Vec<Run> {
    let (Some(e), Some(last)) = (end, runs.last_mut()) else { return runs };
    let Some(&(from, _)) = last.last() else { return runs };
    if from.dist(e) < 0.3 {
        return runs;
    }
    if let Some(path) = travel_path(rings, from, e) {
        for q in running_stitch(&path, travel, 0.1).into_iter().skip(1) {
            push(last, q, flags::TRAVEL);
        }
    }
    runs
}

#[cfg(test)]
mod tests {
    use super::*;

    fn square(s: f64) -> SubPath {
        SubPath::polyline(&[pt(0.0, 0.0), pt(s, 0.0), pt(s, s), pt(0.0, s)], true)
    }

    fn donut() -> Vec<SubPath> {
        let circle = |r: f64| {
            let pts: Vec<Point> = (0..64).map(|i| {
                let a = i as f64 / 64.0 * TAU;
                pt(20.0 + r * a.cos(), 20.0 + r * a.sin())
            }).collect();
            SubPath::polyline(&pts, true)
        };
        vec![circle(15.0), circle(6.0)]
    }

    #[test]
    fn density_ramp_along_a_vector() {
        // a 40 mm square, rows across; dense at the top, open at the bottom
        let sq = vec![vec![pt(0.0, 0.0), pt(40.0, 0.0), pt(40.0, 40.0), pt(0.0, 40.0)]];
        let ramp = crate::model::DensityRamp { from: [20.0, 0.0], to: [20.0, 40.0], dense: 0.3, sparse: 3.0, ..Default::default() };
        let runs = tatami_ramp(&sq, 0.0, 0.3, 0.0, false, 3.0, 4, 0.0, 2.5, None, None, None, Some((&ramp, 1.0)), 0);
        let ys: Vec<f64> = runs.iter().flatten().map(|(p, _)| p.y).collect();
        let top = ys.iter().filter(|y| **y < 20.0).count();
        let bottom = ys.len() - top;
        assert!(top > 2 * bottom, "dense half {top} vs open half {bottom}");
        // reversed: the other way round
        let rev = crate::model::DensityRamp { reverse: true, ..ramp.clone() };
        let runs = tatami_ramp(&sq, 0.0, 0.3, 0.0, false, 3.0, 4, 0.0, 2.5, None, None, None, Some((&rev, 1.0)), 0);
        let ys: Vec<f64> = runs.iter().flatten().map(|(p, _)| p.y).collect();
        assert!(ys.iter().filter(|y| **y < 20.0).count() * 2 < ys.len());
        // profiles: dense in the middle
        assert!(crate::model::RampProfile::Middle.at(0.5) < 0.01 && crate::model::RampProfile::Middle.at(0.0) > 0.99);
    }

    /// A 40 mm square with a gently bending direction field.
    fn flow_square() -> (SubPath, crate::model::FlowField) {
        let sq = SubPath::polyline(&[pt(0.0, 0.0), pt(40.0, 0.0), pt(40.0, 40.0), pt(0.0, 40.0)], true);
        let mut angles = Vec::new();
        for _ in 0..10 {
            for x in 0..10 {
                angles.push(x as f32 * 0.05);
            }
        }
        (sq, crate::model::FlowField { origin: [0.0, 0.0], cell: 4.0, cols: 10, rows: 10, angles })
    }

    #[test]
    fn flow_gradient_layers_share_the_lines() {
        let (sq, field) = flow_square();
        let layer = |l: u32| {
            let g = GradientParams { from: [0.0, 20.0], to: [40.0, 20.0], layer: l, group: "g".into(), ..Default::default() };
            let p = FillParams { method: FillMethod::Flow, angle: 90.0, row_spacing: 0.5, underlay: false, flow: Some(field.clone()), gradient: Some(g), ..Default::default() };
            fill(std::slice::from_ref(&sq), &p, 0.0, 1.0, false, 1.0, None, None)
        };
        let side = |runs: &Vec<Run>| {
            // sewn stitches only (the first layer travels hidden under the second)
            let xs: Vec<f64> = runs.iter().flatten().filter(|(_, f)| *f == 0).map(|(p, _)| p.x).collect();
            (xs.iter().filter(|x| **x < 20.0).count(), xs.iter().filter(|x| **x >= 20.0).count())
        };
        let (l0, r0) = side(&layer(0));
        let (l1, r1) = side(&layer(1));
        assert!(l0 as f64 > 1.5 * r0 as f64, "the first colour on the left: {l0} / {r0}");
        assert!(r1 as f64 > 1.5 * l1 as f64, "the second on the right: {l1} / {r1}");
    }

    #[test]
    fn flow_gradients_follow_their_colour_bands() {
        // a radial gradient without a picture field: the rows circle the centre
        let sq = square(40.0);
        let layer = |l: u32| {
            let g = GradientParams { kind: crate::model::GradientKind::Radial, from: [20.0, 20.0], to: [38.0, 20.0], layer: l, group: "g".into(), ..Default::default() };
            let p = FillParams { method: FillMethod::Flow, angle: 0.0, row_spacing: 0.5, underlay: false, gradient: Some(g), ..Default::default() };
            fill(std::slice::from_ref(&sq), &p, 0.0, 1.0, false, 1.0, None, None)
        };
        let t = std::time::Instant::now();
        let (a, b) = (layer(0), layer(1));
        let ms = t.elapsed().as_millis();
        // sewn stitches east of the centre run north–south
        let steep = |runs: &Vec<Run>| {
            let seg: Vec<_> = runs.iter().flat_map(|r| r.windows(2)).filter(|w| w[1].1 == 0 && (w[0].0.x - 32.0).abs() < 3.0 && (w[0].0.y - 20.0).abs() < 3.0 && w[0].0.dist(w[1].0) > 0.5).collect();
            seg.iter().filter(|w| (w[1].0.y - w[0].0.y).abs() > (w[1].0.x - w[0].0.x).abs()).count() as f64 / seg.len().max(1) as f64
        };
        assert!(steep(&a) + steep(&b) > 1.4, "{} {}", steep(&a), steep(&b));
        // the inner colour in the middle, the outer one outside
        let mid = |runs: &Vec<Run>| { let v: Vec<_> = runs.iter().flatten().filter(|x| x.1 == 0).collect(); v.iter().filter(|x| x.0.dist(pt(20.0, 20.0)) < 9.0).count() as f64 / v.len().max(1) as f64 };
        assert!(mid(&a) > mid(&b) * 2.0, "{} {}", mid(&a), mid(&b));
        assert!(ms < 2000, "{ms} ms");
        eprintln!("two flow gradient layers: {ms} ms");
    }

    #[test]
    fn flow_follows_a_density_ramp() {
        let (sq, field) = flow_square();
        let ramp = crate::model::DensityRamp { from: [20.0, 0.0], to: [20.0, 40.0], dense: 0.4, sparse: 3.0, ..Default::default() };
        let p = FillParams { method: FillMethod::Flow, angle: 0.0, row_spacing: 0.4, underlay: false, flow: Some(field), ramp: Some(ramp), ..Default::default() };
        let runs = fill(std::slice::from_ref(&sq), &p, 0.0, 1.0, false, 1.0, None, None);
        let len = |top: bool| -> f64 {
            runs.iter().map(|r| r.windows(2).filter(|w| w[1].1 == 0 && ((w[0].0.y < 20.0) == top)).map(|w| w[0].0.dist(w[1].0)).sum::<f64>()).sum()
        };
        assert!(len(true) > 2.0 * len(false), "more thread where dense: {} vs {}", len(true), len(false));
    }

    #[test]
    fn curved_fill_follows_the_shape() {
        let p = FillParams { method: FillMethod::Curved, row_spacing: 0.5, underlay: false, ..Default::default() };
        let runs = fill(&donut(), &p, 0.0, 1.0, false, 1.0, None, None);
        let n: usize = runs.iter().map(|r| r.len()).sum();
        assert!(n > 200, "{n}");
        // without a picture field, a flow fill follows the shape too
        let p = FillParams { method: FillMethod::Flow, ..p };
        assert!(!fill(&donut(), &p, 0.0, 1.0, false, 1.0, None, None).is_empty());
    }

    #[test]
    fn gradients_on_other_fills_fall_back_to_rows() {
        // a contour fill cannot split colours: the layers sew rows instead,
        // each its own part (not the whole shape twice)
        let layer = |l: u32| {
            let g = GradientParams { from: [0.0, 0.0], to: [20.0, 0.0], layer: l, group: "g".into(), ..Default::default() };
            let p = FillParams { method: FillMethod::Contour, row_spacing: 0.5, underlay: false, gradient: Some(g), ..Default::default() };
            fill(&[square(20.0)], &p, 0.0, 1.0, false, 1.0, None, None)
        };
        let xs = |runs: Vec<Run>| runs.into_iter().flatten().filter(|(_, f)| *f == 0).map(|(p, _)| p.x).collect::<Vec<_>>();
        let (a, b) = (xs(layer(0)), xs(layer(1)));
        let left = |v: &Vec<f64>| v.iter().filter(|x| **x < 10.0).count() as f64 / v.len().max(1) as f64;
        assert!(left(&a) > 0.6 && left(&b) < 0.4, "{} {}", left(&a), left(&b));
    }

    #[test]
    fn curved_mesh_gradient_layers_follow_the_mesh() {
        let mut nodes = Vec::new();
        for i in 0..3 {
            for j in 0..3 {
                nodes.push(crate::model::MeshNode { p: [j as f64 * 10.0, i as f64 * 10.0 - if i == 1 && j == 1 { 4.0 } else { 0.0 }], c: if j == 0 { 0 } else { 1 } });
            }
        }
        let mesh = crate::model::GradientMesh { rows: 3, cols: 3, nodes };
        for l in 0..2 {
            let g = GradientParams { kind: crate::model::GradientKind::Mesh, mesh: Some(mesh.clone()), layer: l, group: "m".into(), ..Default::default() };
            let p = FillParams { method: FillMethod::Curved, row_spacing: 0.5, underlay: false, gradient: Some(g), ..Default::default() };
            let n: usize = fill(&[square(20.0)], &p, 0.0, 1.0, false, 1.0, None, None).iter().map(|r| r.len()).sum();
            assert!(n > 50, "layer {l}: {n}");
        }
    }

    #[test]
    fn tatami_square_single_run() {
        let p = FillParams { underlay: false, ..Default::default() };
        let runs = fill(&[square(10.0)], &p, 0.0, 1.0, false, 1.0, None, None);
        assert_eq!(runs.len(), 1);
        // 40 rows
        let pts = &runs[0];
        assert!(pts.len() > 40 * 4);
        for (q, _) in pts {
            assert!(q.x > -0.01 && q.x < 10.01 && q.y > -0.01 && q.y < 10.01);
        }
    }

    #[test]
    fn tatami_donut_is_connected_and_inside() {
        let p = FillParams { underlay: true, angle: 30.0, ..Default::default() };
        let rings = fill_rings(&donut());
        let runs = fill(&donut(), &p, 0.0, 1.0, false, 1.0, None, None);
        assert!(runs.len() <= 2, "too many jumps: {}", runs.len());
        for r in &runs {
            for w in r.windows(2) {
                let m = w[0].0.lerp(w[1].0, 0.5);
                // every stitch midpoint should be inside (or on the boundary of) the donut
                assert!(point_in_rings(m, &rings) || dist_to_boundary(&rings, m) < 0.05, "outside at {m:?}");
            }
        }
    }

    #[test]
    fn new_fills_produce_stitches() {
        for method in [FillMethod::Contour, FillMethod::Spiral, FillMethod::Radial, FillMethod::Hilbert, FillMethod::Stipple] {
            let p = FillParams { method, row_spacing: 1.0, underlay: false, ..Default::default() };
            let runs = fill(&donut(), &p, 0.0, 1.0, false, 1.0, None, None);
            let n: usize = runs.iter().map(|r| r.len()).sum();
            assert!(n > 50, "{method:?} produced {n}");
        }
    }

    #[test]
    fn hilbert_curve_adjacent() {
        let n = 8;
        let mut last = hilbert_d2xy(n, 0);
        for d in 1..64 {
            let c = hilbert_d2xy(n, d);
            let dd = (c.0 as i32 - last.0 as i32).abs() + (c.1 as i32 - last.1 as i32).abs();
            assert_eq!(dd, 1);
            last = c;
        }
    }

    #[test]
    fn complementary_density_gradients_cover_evenly() {
        // rows per mm of two fills with opposite density gradients add up to a constant
        let sq = vec![vec![pt(0.0, 0.0), pt(40.0, 0.0), pt(40.0, 40.0), pt(0.0, 40.0)]];
        let rows = |s0: f64, s1: f64| -> Vec<f64> {
            let g = build_grating(&sq, s0, s1, true, 0.0);
            let mut ys: Vec<f64> = g.sections.iter().flat_map(|s| s.rows.iter().map(|r| r.0)).collect();
            ys.sort_by(|a, b| a.partial_cmp(b).unwrap());
            ys
        };
        let a = rows(0.25, 2.5);
        let b = rows(2.5, 0.25);
        let band = |ys: &[f64], y0: f64, y1: f64| ys.iter().filter(|y| **y >= y0 && **y < y1).count() as f64 / (y1 - y0);
        let (top, mid, bottom) = (band(&a, 0.0, 8.0) + band(&b, 0.0, 8.0), band(&a, 16.0, 24.0) + band(&b, 16.0, 24.0), band(&a, 32.0, 40.0) + band(&b, 32.0, 40.0));
        for v in [mid, bottom] {
            assert!((v - top).abs() / top < 0.15, "rows/mm {top:.2} {mid:.2} {bottom:.2}");
        }
    }

    /// How evenly the colour layers of a fill cover it together: the share of
    /// the inside further than `gap` from every sewn stitch, and the share of
    /// sewn points with another layer's stitch closer than `crowd`.
    fn coverage(layers: &[Vec<Run>], rings: &[Ring], gap: f64, crowd: f64) -> (f64, f64) {
        let cell = 0.5;
        let mut hash: std::collections::HashMap<(i64, i64), Vec<(Point, usize)>> = Default::default();
        let key = |p: Point| ((p.x / cell).floor() as i64, (p.y / cell).floor() as i64);
        for (l, runs) in layers.iter().enumerate() {
            for w in runs.iter().flat_map(|r| r.windows(2)).filter(|w| w[1].1 == 0) {
                let n = (w[0].0.dist(w[1].0) / 0.1).ceil().max(1.0) as usize;
                for k in 0..=n {
                    let q = w[0].0 + (w[1].0 - w[0].0) * (k as f64 / n as f64);
                    hash.entry(key(q)).or_default().push((q, l));
                }
            }
        }
        let near = |q: Point, r: f64, skip: Option<usize>| {
            let (kx, ky) = key(q);
            (kx - 1..=kx + 1).any(|x| (ky - 1..=ky + 1).any(|y| hash.get(&(x, y)).is_some_and(|v| v.iter().any(|(p, l)| Some(*l) != skip && p.dist(q) < r))))
        };
        let b = rings_bounds(rings);
        let (mut inside, mut holes) = (0usize, 0usize);
        let mut y = b.min_y;
        while y < b.max_y {
            let mut x = b.min_x;
            while x < b.max_x {
                let q = pt(x, y);
                if point_in_rings(q, rings) && dist_to_boundary(rings, q) > 1.5 {
                    inside += 1;
                    holes += usize::from(!near(q, gap, None));
                }
                x += 0.13;
            }
            y += 0.13;
        }
        let (mut sewn, mut crowded) = (0usize, 0usize);
        for v in hash.values() {
            for &(q, l) in v.iter().step_by(5) {
                if dist_to_boundary(rings, q) > 1.5 {
                    sewn += 1;
                    crowded += usize::from(near(q, crowd, Some(l)));
                }
            }
        }
        (holes as f64 / inside.max(1) as f64, crowded as f64 / sewn.max(1) as f64)
    }

    #[test]
    fn colours_take_the_shared_lines_as_traced() {
        // a colour whose lines come from the cache sews what it sews traced from scratch
        let oval: Ring = (0..72).map(|k| { let a = k as f64 / 72.0 * TAU; pt(20.0 + 18.0 * a.cos(), 15.0 + 12.0 * a.sin()) }).collect();
        let paths = vec![SubPath::polyline(&oval, true)];
        let run = |p: &FillParams, start: Option<Point>| fill(&paths, p, 0.0, 1.0, false, 1.0, start, None);
        let grad = |l: u32| GradientParams { from: [2.0, 15.0], to: [38.0, 15.0], layer: l, group: "g".into(), stops: (0..3).map(|k| crate::model::GradientStop { pos: k as f64 / 2.0, mid: 0.5 }).collect(), ..Default::default() };
        let ramp = |reverse: bool| crate::model::DensityRamp { from: [2.0, 15.0], to: [38.0, 15.0], dense: 0.4, sparse: 4.0, additive: true, reverse, group: Some("b".into()), ..Default::default() };
        for method in [FillMethod::Curved, FillMethod::Tatami] {
            let base = FillParams { method, row_spacing: 0.4, underlay: false, angle: 70.0, ..Default::default() };
            let layers: Vec<Vec<FillParams>> = vec![
                (0..3).map(|l| FillParams { gradient: Some(grad(l)), ..base.clone() }).collect(),
                [false, true].iter().map(|&r| FillParams { ramp: Some(ramp(r)), ..base.clone() }).collect(),
            ];
            for group in layers {
                for (k, p) in group.iter().enumerate() {
                    let start = Some(pt(3.0 + k as f64, 15.0));
                    super::super::inkfills::forget_shared_lines();
                    let fresh = run(p, start);
                    // every other colour first: this one finds the lines traced
                    super::super::inkfills::forget_shared_lines();
                    for q in group.iter().filter(|q| *q != p) {
                        run(q, None);
                    }
                    assert_eq!(run(p, start), fresh, "{method:?} colour {k}");
                }
            }
        }
    }

    #[test]
    fn gradient_colours_together_cover_evenly() {
        // the colours share one set of rows: no row left out, none on another
        let oval: Ring = (0..72).map(|k| { let a = k as f64 / 72.0 * TAU; pt(20.0 + 18.0 * a.cos(), 15.0 + 12.0 * a.sin()) }).collect();
        let paths = vec![SubPath::polyline(&oval, true)];
        let rings = vec![oval];
        let sp = 0.4;
        let run = |p: FillParams| fill(&paths, &p, 0.0, 1.0, false, 1.0, None, None);
        for method in [FillMethod::Curved, FillMethod::Tatami] {
            // a two-colour gradient across the oval
            let grad = |l: u32| GradientParams { from: [2.0, 15.0], to: [38.0, 15.0], layer: l, group: "g".into(), ..Default::default() };
            let layers: Vec<Vec<Run>> = (0..2).map(|l| run(FillParams { method, row_spacing: sp, underlay: false, angle: 90.0, gradient: Some(grad(l)), ..Default::default() })).collect();
            let (holes, crowded) = coverage(&layers, &rings, sp * 0.8, sp * 0.35);
            assert!(holes < 0.005 && crowded < 0.02, "{method:?} gradient: holes {holes:.3}, crowded {crowded:.3}");
            // both colours sew: each takes its side
            assert!(layers.iter().all(|l| l.iter().flatten().filter(|x| x.1 == 0).count() > 200), "{method:?}");
            // a colour blend: two opposite density ramps
            let ramp = |reverse: bool| crate::model::DensityRamp { from: [2.0, 15.0], to: [38.0, 15.0], dense: sp, sparse: 4.0, additive: true, reverse, group: Some("b".into()), ..Default::default() };
            let layers: Vec<Vec<Run>> = [false, true].iter().map(|&r| run(FillParams { method, row_spacing: sp, underlay: false, angle: 90.0, ramp: Some(ramp(r)), ..Default::default() })).collect();
            let full = 1.0 / (1.0 / sp + 1.0 / 4.0);
            let (holes, crowded) = coverage(&layers, &rings, full * 0.8, full * 0.35);
            assert!(holes < 0.005 && crowded < 0.02, "{method:?} blend: holes {holes:.3}, crowded {crowded:.3}");
            // the first colour where it is dense, the second where it fades in
            let left = |runs: &Vec<Run>| { let xs: Vec<f64> = runs.iter().flatten().filter(|x| x.1 == 0).map(|x| x.0.x).collect(); xs.iter().filter(|x| **x < 20.0).count() as f64 / xs.len().max(1) as f64 };
            assert!(left(&layers[0]) > 0.6 && left(&layers[1]) < 0.4, "{method:?} blend sides: {} {}", left(&layers[0]), left(&layers[1]));
        }
    }
}

#[cfg(test)]
mod travel_tests {
    use super::*;

    /// An oval with a hole: rows break, so sections and lines must be joined.
    fn ring_shape() -> (Vec<SubPath>, Vec<Ring>) {
        let outer: Vec<Point> = (0..64).map(|k| { let a = k as f64 / 64.0 * TAU; pt(20.0 + 18.0 * a.cos(), 20.0 + 14.0 * a.sin()) }).collect();
        let inner: Vec<Point> = (0..32).rev().map(|k| { let a = k as f64 / 32.0 * TAU; pt(20.0 + 6.0 * a.cos(), 20.0 + 5.0 * a.sin()) }).collect();
        (vec![SubPath::polyline(&outer, true), SubPath::polyline(&inner, true)], vec![outer, inner])
    }

    /// Travel stitches crossing a stitch sewn before them (at a real angle,
    /// away from the outline where rows end).
    fn crossings(runs: &[Run], rings: &[Ring]) -> usize {
        let mut sewn: Vec<(Point, Point)> = Vec::new();
        let mut n = 0;
        for r in runs {
            for w in r.windows(2) {
                let (a, b) = (w[0].0, w[1].0);
                if w[1].1 & flags::TRAVEL != 0 {
                    n += sewn
                        .iter()
                        .filter(|(p, q)| {
                            segments_intersect(a, b, *p, *q)
                                && (b - a).unit().cross((*q - *p).unit()).abs() > 0.42
                                && segment_intersection(a, b, *p, *q).is_some_and(|(_, x)| dist_to_boundary(rings, x) > 0.3)
                        })
                        .count();
                } else {
                    sewn.push((a, b));
                }
            }
        }
        n
    }

    #[test]
    fn travel_never_crosses_sewn_rows() {
        // Ink/Stitch's rule: tatami, flow and curved fills route their travel
        // around what is already sewn, and need no jumps for it
        let (shape, rings) = ring_shape();
        for method in [FillMethod::Tatami, FillMethod::Flow, FillMethod::Curved] {
            let p = FillParams { method, row_spacing: 0.4, underlay: false, angle: 30.0, ..Default::default() };
            let runs = fill(&shape, &p, 0.0, 1.0, false, 1.0, None, None);
            // a pocket walled in by sewn lines is left by a short straight
            // travel (as Ink/Stitch does when no route is left), not a jump
            assert!(crossings(&runs, &rings) <= 2, "{method:?}: {} crossings", crossings(&runs, &rings));
            assert_eq!(runs.len(), 1, "{method:?}: no jumps");
        }
    }

    #[test]
    fn alternate_rows_give_every_row_one_colour() {
        let (shape, rings) = ring_shape();
        let layer = |l: u32| {
            let g = GradientParams { from: [5.0, 20.0], to: [35.0, 20.0], layer: l, group: "g".into(), mix: crate::model::GradientMix::Rows, ..Default::default() };
            // rows across the gradient (vertical)
            let p = FillParams { row_spacing: 0.4, underlay: false, angle: 90.0, gradient: Some(g), ..Default::default() };
            fill(&shape, &p, 0.0, 1.0, false, 1.0, None, None)
        };
        let (a, b) = (layer(0), layer(1));
        // sewn x positions: the first colour on the left, the second on the right
        let xs = |runs: &Vec<Run>| runs.iter().flatten().filter(|s| s.1 & flags::TRAVEL == 0).map(|s| s.0.x).collect::<Vec<_>>();
        let left = |v: Vec<f64>| v.iter().filter(|x| **x < 20.0).count() as f64 / v.len().max(1) as f64;
        assert!(left(xs(&a)) > 0.7 && left(xs(&b)) < 0.3, "{} {}", left(xs(&a)), left(xs(&b)));
        // whole rows, no overlap: together about one fill's worth of stitches
        // and no travel across the other colour's rows
        for runs in [&a, &b] {
            assert!(crossings(runs, &rings) == 0);
            assert!(runs.len() <= 3, "{} runs", runs.len());
        }
    }

    #[test]
    fn center_out_starts_in_the_middle() {
        let sq = SubPath::polyline(&[pt(0.0, 0.0), pt(30.0, 0.0), pt(30.0, 40.0), pt(0.0, 40.0)], true);
        let p = FillParams { row_spacing: 0.4, underlay: false, center_out: true, ..Default::default() };
        let runs = fill(std::slice::from_ref(&sq), &p, 0.0, 1.0, false, 1.0, None, None);
        let sewn: Vec<Point> = runs.iter().flatten().filter(|s| s.1 & flags::TRAVEL == 0).map(|s| s.0).collect();
        // the first rows in the middle, the last at an edge
        assert!((sewn[0].y - 20.0).abs() < 1.0, "first {:?}", sewn[0]);
        let last = sewn[sewn.len() - 1];
        assert!(last.y < 1.0 || last.y > 39.0, "last {last:?}");
        // the first half goes one way, then the other half from the middle again
        let i = sewn.iter().position(|q| q.y < 1.0 || q.y > 39.0).unwrap();
        let after = sewn[i..].iter().position(|q| (q.y - 20.0).abs() < 1.0).map(|k| k + i);
        assert!(after.is_some(), "back to the middle for the other half");
        // all rows still there: the same stitches as from the top, give or take
        let plain = fill(std::slice::from_ref(&sq), &FillParams { center_out: false, ..p.clone() }, 0.0, 1.0, false, 1.0, None, None);
        let n = |r: &Vec<Run>| r.iter().flatten().filter(|s| s.1 & flags::TRAVEL == 0).count() as f64;
        assert!((n(&runs) / n(&plain) - 1.0).abs() < 0.05, "{} vs {}", n(&runs), n(&plain));
        assert!(crossings(&runs, &fill_rings(std::slice::from_ref(&sq))) == 0);
    }

    #[test]
    fn edge_run_goes_round_before_the_fill() {
        let sq = SubPath::polyline(&[pt(0.0, 0.0), pt(30.0, 0.0), pt(30.0, 20.0), pt(0.0, 20.0)], true);
        let p = FillParams { underlay: true, underlay_edge: true, underlay_cross: true, ..Default::default() };
        let runs = fill(std::slice::from_ref(&sq), &p, 0.0, 1.0, false, 1.0, None, None);
        let ul: Vec<Point> = runs.iter().flatten().take_while(|s| s.1 & flags::UNDERLAY != 0).map(|s| s.0).collect();
        // first an outline just inside the edge, all round
        let near_edge = ul.iter().take(20).all(|q| dist_to_boundary(&fill_rings(std::slice::from_ref(&sq)), *q) < 0.6);
        assert!(near_edge, "edge run first");
        assert!(ul.len() > 60, "then the tatami passes");
        // the cross-hatch: underlay stitches at two directions
        let dirs: Vec<f64> = ul.windows(2).filter(|w| w[0].dist(w[1]) > 1.0).map(|w| (w[1] - w[0]).y.atan2((w[1] - w[0]).x).to_degrees().rem_euclid(180.0)).collect();
        let near = |a: f64| dirs.iter().filter(|d| (**d - a).abs() < 8.0).count();
        assert!(near(45.0) > 5 && near(135.0) > 5, "45: {} 135: {}", near(45.0), near(135.0));
    }

    #[test]
    fn blended_colours_travel_off_the_earlier_ones() {
        let (shape, rings) = ring_shape();
        for method in [FillMethod::Tatami, FillMethod::Flow] {
            for l in 0..2u32 {
                let g = GradientParams { from: [5.0, 20.0], to: [35.0, 20.0], layer: l, group: "g".into(), ..Default::default() };
                let p = FillParams { method, row_spacing: 0.4, underlay: false, angle: 30.0, gradient: Some(g), ..Default::default() };
                let runs = fill(&shape, &p, 0.0, 1.0, false, 1.0, None, None);
                assert!(crossings(&runs, &rings) <= 8, "{method:?} L{l}: {}", crossings(&runs, &rings));
                // the first colour can always travel hidden under the later one
                if l == 0 {
                    assert!(runs.len() <= 2, "{method:?} L0: {} runs", runs.len());
                }
            }
        }
    }
}

#[cfg(test)]
mod ink_param_tests {
    use super::*;
    use crate::model::FillMethod as M;

    fn sq(s: f64) -> Vec<SubPath> {
        vec![SubPath::polyline(&[pt(0.0, 0.0), pt(s, 0.0), pt(s, s), pt(0.0, s)], true)]
    }
    fn sewn(runs: &[Run]) -> usize {
        runs.iter().flatten().filter(|x| x.1 & flags::TRAVEL == 0).count()
    }

    #[test]
    fn running_fills_repeat_and_bean() {
        let p = FillParams { method: M::Contour, row_spacing: 1.0, underlay: false, ..Default::default() };
        let once = sewn(&fill(&sq(20.0), &p, 0.0, 1.0, false, 1.0, None, None));
        let twice = sewn(&fill(&sq(20.0), &FillParams { repeats: 2, ..p.clone() }, 0.0, 1.0, false, 1.0, None, None));
        let bean = sewn(&fill(&sq(20.0), &FillParams { bean_repeats: 2, ..p.clone() }, 0.0, 1.0, false, 1.0, None, None));
        assert!(twice as f64 > once as f64 * 1.8, "{once} {twice}");
        assert!(bean as f64 > once as f64 * 2.5, "{once} {bean}");
    }

    #[test]
    fn a_double_spiral_ends_near_its_start() {
        let p = FillParams { method: M::Spiral, row_spacing: 1.0, underlay: false, contour_double: true, ..Default::default() };
        let runs = fill(&sq(20.0), &p, 0.0, 1.0, false, 1.0, None, None);
        let pts: Vec<Point> = runs.iter().flatten().map(|x| x.0).collect();
        let (a, b) = (pts[0], pts[pts.len() - 1]);
        let rings = fill_rings(&sq(20.0));
        assert!(dist_to_boundary(&rings, a) < 1.5 && dist_to_boundary(&rings, b) < 2.5, "{a:?} {b:?}");
    }

    #[test]
    fn tatami_skip_last_and_percent_pull() {
        let p = FillParams { row_spacing: 0.5, underlay: false, ..Default::default() };
        let all = sewn(&fill(&sq(20.0), &p, 0.0, 1.0, false, 1.0, None, None));
        let skip = sewn(&fill(&sq(20.0), &FillParams { skip_last: true, ..p.clone() }, 0.0, 1.0, false, 1.0, None, None));
        assert!(skip < all, "{skip} {all}");
        // 10 % of the row each side: rows reach 2 mm beyond a 20 mm square
        let wide = fill(&sq(20.0), &FillParams { pull_comp_pct: 0.1, ..p.clone() }, 0.0, 1.0, false, 1.0, None, None);
        let maxx = wide.iter().flatten().map(|x| x.0.x).fold(f64::MIN, f64::max);
        assert!((maxx - 22.0).abs() < 0.3, "{maxx}");
    }

    #[test]
    fn underlay_angle_list() {
        let p = FillParams { row_spacing: 0.5, underlay: true, underlay_angles: vec![30.0, 90.0, 150.0], ..Default::default() };
        let runs = fill(&sq(20.0), &p, 0.0, 1.0, false, 1.0, None, None);
        let dirs: Vec<f64> = runs.iter().flatten().collect::<Vec<_>>().windows(2).filter(|w| w[0].1 & flags::UNDERLAY != 0 && w[1].1 & flags::UNDERLAY != 0 && w[0].0.dist(w[1].0) > 1.5).map(|w| (w[1].0 - w[0].0).y.atan2((w[1].0 - w[0].0).x).to_degrees().rem_euclid(180.0)).collect();
        // three directions (on screen: angle a → rows at −a)
        for a in [150.0, 90.0, 30.0] {
            assert!(dirs.iter().any(|d| (d - a).abs() < 6.0), "{a}: {:?}", &dirs[..dirs.len().min(12)]);
        }
    }

#[cfg(test)]
mod random_length_tests {
    use super::*;

    #[test]
    fn random_lengths_break_the_tatami_grid() {
        let sq = vec![SubPath::polyline(&[pt(0.0, 0.0), pt(30.0, 0.0), pt(30.0, 30.0), pt(0.0, 30.0)], true)];
        let lens = |p: &FillParams| -> Vec<f64> {
            let runs = fill(&sq, p, 0.0, 1.0, false, 1.0, None, None);
            runs.iter().flat_map(|r| r.windows(2).filter(|w| w[0].1 == 0 && w[1].1 == 0 && (w[0].0.y - w[1].0.y).abs() < 1e-6).map(|w| w[0].0.dist(w[1].0)).collect::<Vec<_>>()).filter(|d| *d > 1.0).collect()
        };
        let base = FillParams { underlay: false, angle: 0.0, max_stitch_length: 3.0, ..Default::default() };
        let even = lens(&base);
        let full = even.iter().filter(|d| (**d - 3.0).abs() < 1e-6).count();
        assert!(full as f64 > even.len() as f64 * 0.6, "a plain tatami is mostly full stitches");
        let rnd = lens(&FillParams { random_length: 20.0, ..base.clone() });
        let full_r = rnd.iter().filter(|d| (**d - 3.0).abs() < 1e-6).count();
        assert!((full_r as f64) < rnd.len() as f64 * 0.1, "random: hardly any exactly 3 mm ({full_r} of {})", rnd.len());
        let big: Vec<&f64> = rnd.iter().filter(|d| **d > 3.6 + 1e-6).collect();
        assert!(big.is_empty(), "{big:?}");
    }
}
}

#[cfg(test)]
mod gap_fill_tests {
    use super::*;

    #[test]
    fn gap_rows_repeat_the_last_row_of_a_section_before_travelling() {
        // a U: two arms, sewn as separate sections
        let u = vec![SubPath::polyline(&[pt(0.0, 0.0), pt(30.0, 0.0), pt(30.0, 30.0), pt(20.0, 30.0), pt(20.0, 10.0), pt(10.0, 10.0), pt(10.0, 30.0), pt(0.0, 30.0)], true)];
        let base = FillParams { underlay: false, angle: 0.0, row_spacing: 0.5, ..Default::default() };
        let n = |p: &FillParams| fill(&u, p, 0.0, 1.0, false, 1.0, None, None).iter().map(|r| r.len()).sum::<usize>();
        let plain = n(&base);
        let gaps = n(&FillParams { gap_fill_rows: 3, ..base.clone() });
        assert!(gaps > plain, "extra rows: {plain} → {gaps}");
        // not on a single section
        let sq = vec![SubPath::polyline(&[pt(0.0, 0.0), pt(20.0, 0.0), pt(20.0, 20.0), pt(0.0, 20.0)], true)];
        let m = |p: &FillParams| fill(&sq, p, 0.0, 1.0, false, 1.0, None, None).iter().map(|r| r.len()).sum::<usize>();
        assert_eq!(m(&base), m(&FillParams { gap_fill_rows: 4, ..base.clone() }), "one section: nothing to fill");
    }
}

#[cfg(test)]
mod meander_option_tests {
    use super::*;

    fn sq(s: f64) -> Vec<SubPath> {
        vec![SubPath::polyline(&[pt(0.0, 0.0), pt(s, 0.0), pt(s, s), pt(0.0, s)], true)]
    }
    fn pts(p: &FillParams) -> Vec<Point> {
        fill(&sq(30.0), p, 0.0, 1.0, false, 1.0, None, None).into_iter().flatten().filter(|x| x.1 == 0).map(|x| x.0).collect()
    }

    #[test]
    fn clip_keeps_an_expanded_meander_inside_the_shape() {
        let base = FillParams { method: FillMethod::Meander, underlay: false, meander_tile: None, expand: 2.0, smoothness: 0.0, ..Default::default() };
        let out = |v: &[Point]| v.iter().filter(|p| p.x < -0.05 || p.y < -0.05 || p.x > 30.05 || p.y > 30.05).count();
        assert!(out(&pts(&base)) > 0, "expand lets the meander out");
        assert_eq!(out(&pts(&FillParams { meander_clip: true, ..base })), 0, "clip keeps it in");
    }

    #[test]
    fn zigzag_meander_has_more_points_and_aspect_changes_the_pattern() {
        let base = FillParams { method: FillMethod::Meander, underlay: false, meander_tile: None, ..Default::default() };
        let plain = pts(&base);
        let zz = pts(&FillParams { meander_zigzag: 1.0, meander_zigzag_width: 2.0, ..base.clone() });
        assert!(zz.len() > plain.len(), "{} vs {}", zz.len(), plain.len());
        let tall = pts(&FillParams { meander_aspect: 2.0, ..base.clone() });
        assert_ne!(tall, plain);
    }
}
