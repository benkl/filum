//! Satin columns.
//!
//! Follows Ink/Stitch's model (`lib/elements/satin_column/*`, GPL-3.0-or-later):
//! a satin is two *rails* plus optional *rungs* that split the rails into
//! corresponding sections. Stitch pairs are plotted along both rails with the
//! spacing measured perpendicular to the previous stitch (`plot_points_on_rails`).
//! Supports centre-walk / contour / zig-zag underlay, pull compensation,
//! short-stitch inset in tight curves and satin / E-stitch / S-stitch / zig-zag.
//!
//! Extension over Ink/Stitch: a single open sub-path is treated as a satin
//! *centre line* of `width`, so the "satin column" draw tool needs only one stroke.

use crate::geom::{cumulative_lengths, offset_closed, offset_polyline, polyline_length, project, segment_intersection, substring, point_at, Point};
use crate::model::{SatinMethod, SatinParams, SubPath};
use crate::plan::flags;

use super::running::running_stitch;
use super::Run;

const FLATTEN_TOL: f64 = 0.05;

pub struct SatinGeometry {
    /// Corresponding sections (rail0 part, rail1 part).
    pub sections: Vec<(Vec<Point>, Vec<Point>)>,
}

fn flatten_with_nodes(sp: &SubPath) -> (Vec<Point>, Vec<usize>) {
    // Flatten segment by segment, recording the point index of every node.
    let n = sp.nodes.len();
    let mut pts: Vec<Point> = Vec::new();
    let mut node_idx = Vec::with_capacity(n);
    if n == 0 {
        return (pts, node_idx);
    }
    pts.push(sp.nodes[0].point());
    node_idx.push(0);
    let segs = if sp.closed { n } else { n - 1 };
    for s in 0..segs {
        let one = SubPath { nodes: vec![sp.nodes[s], sp.nodes[(s + 1) % n]], closed: false };
        let f = one.flatten(FLATTEN_TOL);
        pts.extend(f.into_iter().skip(1));
        node_idx.push(pts.len() - 1);
    }
    (pts, node_idx)
}

fn rails_should_reverse(r0: &[Point], r1: &[Point]) -> bool {
    let (c0, c1) = (cumulative_lengths(r0), cumulative_lengths(r1));
    let (l0, l1) = (*c0.last().unwrap_or(&0.0), *c1.last().unwrap_or(&0.0));
    let (mut same, mut rev) = (0.0, 0.0);
    for i in 0..10 {
        let t = i as f64 / 10.0;
        let p0 = point_at(r0, &c0, t * l0);
        same += p0.dist(point_at(r1, &c1, t * l1));
        rev += p0.dist(point_at(r1, &c1, (1.0 - t) * l1));
    }
    same > rev
}

/// Which two sub-paths (flattened) are the rails, in path order — Ink/Stitch
/// `SatinColumn.rail_indices`. A rung crosses exactly two other paths: with
/// three paths the rails are the two crossing exactly one (one rung, which
/// may well be longer than short rails), with more the two crossing more
/// than two; otherwise (a "#" or no ladder at all) the two longest.
pub fn rail_indices(paths: &[Vec<Point>]) -> (usize, usize) {
    let n = paths.len();
    if n <= 2 {
        return (0, 1.min(n.saturating_sub(1)));
    }
    let crosses = |a: &[Point], b: &[Point]| a.windows(2).any(|u| b.windows(2).any(|v| segment_intersection(u[0], u[1], v[0], v[1]).is_some()));
    let counts: Vec<usize> = (0..n).map(|i| (0..n).filter(|&j| j != i && crosses(&paths[i], &paths[j])).count()).collect();
    let lens: Vec<f64> = paths.iter().map(|p| polyline_length(p)).collect();
    // 0.1 px in Ink/Stitch
    let min_len = 0.1 * 25.4 / 96.0;
    let possible: Vec<usize> = (0..n).filter(|&i| lens[i] > min_len && if n == 3 { counts[i] == 1 } else { counts[i] > 2 }).collect();
    if possible.len() == 2 {
        return (possible[0], possible[1]);
    }
    let mut idx: Vec<usize> = (0..n).collect();
    idx.sort_by(|a, b| lens[*b].partial_cmp(&lens[*a]).unwrap_or(std::cmp::Ordering::Equal));
    (idx[0].min(idx[1]), idx[0].max(idx[1]))
}

/// Build satin geometry (rails split into sections) from object sub-paths.
pub fn satin_geometry(paths: &[SubPath], p: &SatinParams) -> Option<SatinGeometry> {
    let usable: Vec<&SubPath> = paths.iter().filter(|s| s.nodes.len() >= 2).collect();
    if usable.is_empty() {
        return None;
    }
    if usable.len() == 1 {
        // centre line → rails by offsetting
        let mut c = usable[0].flatten(FLATTEN_TOL);
        if c.len() < 2 {
            return None;
        }
        if p.reverse {
            c.reverse();
        }
        let w = p.width.max(0.1) * 0.5;
        let (mut r0, mut r1) = if usable[0].closed {
            (offset_closed(&c, -w), offset_closed(&c, w))
        } else {
            (offset_polyline(&c, -w), offset_polyline(&c, w))
        };
        if p.swap_rails {
            std::mem::swap(&mut r0, &mut r1);
        }
        if !p.guides.is_empty() {
            // direction guides: they cut both rails, the stitches turn evenly between them
            let (c0, c1) = (cumulative_lengths(&r0), cumulative_lengths(&r1));
            let cuts = guide_cuts(&p.guides, &r0, &c0, &r1, &c1, p.width.max(0.1) * 2.0);
            if !cuts.is_empty() {
                return Some(SatinGeometry { sections: sections_from_cuts(&r0, &c0, &r1, &c1, cuts, false) });
            }
        }
        // every vertex pair is a natural rung
        let sections = (1..c.len()).map(|i| (vec![r0[i - 1], r0[i]], vec![r1[i - 1], r1[i]])).collect();
        return Some(SatinGeometry { sections });
    }

    let flat: Vec<Vec<Point>> = usable.iter().map(|s| s.flatten(0.2)).collect();
    let (ia, ib) = rail_indices(&flat);
    let (mut r0, mut n0) = flatten_with_nodes(usable[ia]);
    let (mut r1, mut n1) = flatten_with_nodes(usable[ib]);
    if p.swap_rails {
        std::mem::swap(&mut r0, &mut r1);
        std::mem::swap(&mut n0, &mut n1);
    }
    let (rev0, rev1) = match p.reverse_rails {
        crate::model::RailReverse::Automatic => (false, rails_should_reverse(&r0, &r1)),
        crate::model::RailReverse::None => (false, false),
        crate::model::RailReverse::First => (true, false),
        crate::model::RailReverse::Second => (false, true),
        crate::model::RailReverse::Both => (true, true),
    };
    if rev0 {
        r0.reverse();
        let last = r0.len() - 1;
        n0 = n0.iter().rev().map(|i| last - i).collect();
    }
    if rev1 {
        r1.reverse();
        let last = r1.len() - 1;
        n1 = n1.iter().rev().map(|i| last - i).collect();
    }
    let (c0, c1) = (cumulative_lengths(&r0), cumulative_lengths(&r1));
    let (l0, l1) = (*c0.last().unwrap(), *c1.last().unwrap());

    // rungs → cut positions
    let mut cuts: Vec<(f64, f64)> = Vec::new();
    for (k, sp) in usable.iter().enumerate() {
        if k == ia || k == ib {
            continue;
        }
        let rung = sp.flatten(0.1);
        if rung.len() < 2 {
            continue;
        }
        let hit = |rail: &[Point], cum: &[f64]| -> Option<f64> {
            for w in rung.windows(2) {
                // extend rung slightly so it reliably crosses
                let dir = (w[1] - w[0]).unit() * 0.5;
                let (a, b) = (w[0] - dir, w[1] + dir);
                for i in 1..rail.len() {
                    if let Some((_, q)) = segment_intersection(a, b, rail[i - 1], rail[i]) {
                        return Some(project(rail, cum, q).0);
                    }
                }
            }
            None
        };
        if let (Some(d0), Some(d1)) = (hit(&r0, &c0), hit(&r1, &c1)) {
            cuts.push((d0, d1));
        }
    }
    // direction guides are rungs too
    let width = (0..10).map(|k| point_at(&r0, &c0, l0 * k as f64 / 9.0).dist(point_at(&r1, &c1, l1 * k as f64 / 9.0))).fold(0.0, f64::max);
    cuts.extend(guide_cuts(&p.guides, &r0, &c0, &r1, &c1, width.max(1.0) * 1.5));
    if cuts.is_empty() && n0.len() == n1.len() && n0.len() > 2 {
        // Ink/Stitch convention: equal node counts → nodes act as rungs
        for k in 1..n0.len() - 1 {
            cuts.push((c0[n0[k]], c1[n1[k]]));
        }
    }
    Some(SatinGeometry { sections: sections_from_cuts(&r0, &c0, &r1, &c1, cuts, p.reverse) })
}

/// Rails split at the cuts (arc positions on both rails), in rail order.
fn sections_from_cuts(r0: &[Point], c0: &[f64], r1: &[Point], c1: &[f64], mut cuts: Vec<(f64, f64)>, reverse: bool) -> Vec<(Vec<Point>, Vec<Point>)> {
    let (l0, l1) = (*c0.last().unwrap_or(&0.0), *c1.last().unwrap_or(&0.0));
    cuts.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
    let mut sections = Vec::new();
    let (mut s0, mut s1) = (0.0, 0.0);
    for (d0, d1) in cuts.into_iter().chain(std::iter::once((l0, l1))) {
        if d0 - s0 < 1e-6 && d1 - s1 < 1e-6 {
            continue;
        }
        // a guide that would turn back along the second rail is held at the last cut
        let d1c = d1.max(s1);
        sections.push((substring(r0, c0, s0, d0), substring(r1, c1, s1, d1c)));
        s0 = d0;
        s1 = d1c;
    }
    if reverse {
        sections.reverse();
        for (a, b) in sections.iter_mut() {
            a.reverse();
            b.reverse();
        }
    }
    sections
}

/// Where direction guides cross the rails: each guide is taken as a line
/// (lengthened by `reach` both ways, so a short guide still meets both rails)
/// and cut at the crossing nearest its middle on each rail.
fn guide_cuts(guides: &[[[f64; 2]; 2]], r0: &[Point], c0: &[f64], r1: &[Point], c1: &[f64], reach: f64) -> Vec<(f64, f64)> {
    let mut cuts = Vec::new();
    for g in guides {
        let (a, b) = (Point::from_arr(g[0]), Point::from_arr(g[1]));
        let d = b - a;
        if d.length() < 1e-6 {
            continue;
        }
        let u = d.unit();
        let (ea, eb) = (a - u * reach, b + u * reach);
        let mid = a.lerp(b, 0.5);
        let hit = |rail: &[Point], cum: &[f64]| -> Option<f64> {
            let mut best: Option<(f64, f64)> = None;
            for i in 1..rail.len() {
                if let Some((_, q)) = segment_intersection(ea, eb, rail[i - 1], rail[i]) {
                    let dm = q.dist(mid);
                    if best.is_none_or(|bb| dm < bb.0) {
                        best = Some((dm, project(rail, cum, q).0));
                    }
                }
            }
            best.map(|x| x.1)
        };
        if let (Some(d0), Some(d1)) = (hit(r0, c0), hit(r1, c1)) {
            cuts.push((d0, d1));
        }
    }
    cuts
}

fn stitch_distance(p0: Point, p1: Point, prev0: Point, prev1: Point) -> f64 {
    let prev = prev1 - prev0;
    if prev.length() < 0.01 {
        // distance of prev0 to segment p0p1
        let ab = p1 - p0;
        let l2 = ab.length_sq();
        let t = if l2 < 1e-18 { 0.0 } else { ((prev0 - p0).dot(ab) / l2).clamp(0.0, 1.0) };
        return (p0 + ab * t).dist(prev0);
    }
    let normal = prev.unit().perp();
    let d0 = p0 - prev0;
    let d1 = p1 - prev1;
    d0.dot(normal).abs().max(d1.dot(normal).abs())
}

/// Port of Ink/Stitch `plot_points_on_rails`. `offset` grows (+) or shrinks (−)
/// each pair: absolute mm per side plus a proportion of the local width.
pub fn plot_points_on_rails(geo: &SatinGeometry, spacing: f64, offset_mm: f64, offset_prop: f64) -> Vec<(Point, Point)> {
    plot_points_on_rails_ex(geo, spacing, offset_mm, offset_prop, None)
}

/// With `random` = (share, seed): every stitch's spacing varies by up to
/// that share (Ink/Stitch `SatinProcessor.get_stitch_spacing_multiple`).
pub fn plot_points_on_rails_ex(geo: &SatinGeometry, spacing: f64, offset_mm: f64, offset_prop: f64, random: Option<(f64, u32)>) -> Vec<(Point, Point)> {
    let spacing = spacing.max(0.05);
    let mut rng = random.map(|(_, seed)| crate::prng::Stream::new(seed, 0x5a71));
    let mut multiple = move || match (&mut rng, random) {
        (Some(r), Some((share, _))) => (1.0 + (r.next() - 0.5) * 2.0 * share).max(0.01),
        _ => 1.0,
    };
    let process = |a: Point, b: Point| -> (Point, Point) {
        let d = b - a;
        let w = d.length();
        if w < 1e-9 {
            return (a, b);
        }
        let u = d / w;
        let mut off = offset_mm + offset_prop * w;
        // never let an inset collapse/invert the pair
        if off < 0.0 && -2.0 * off > w * 0.9 {
            off = -w * 0.45;
        }
        (a - u * off, b + u * off)
    };
    let mut pairs = Vec::new();
    let (mut old0, mut old1) = (Point::ZERO, Point::ZERO);
    for (i, (s0, s1)) in geo.sections.iter().enumerate() {
        if s0.len() < 2 || s1.len() < 2 {
            continue;
        }
        if i == 0 || pairs.is_empty() {
            old0 = s0[0];
            old1 = s1[0];
            pairs.push(process(old0, old1));
        }
        let (c0, c1) = (cumulative_lengths(s0), cumulative_lengths(s1));
        let (l0, l1) = (*c0.last().unwrap(), *c1.last().unwrap());
        let num_points = l0.max(l1).max(0.01) / spacing;
        let step = 1.0 / num_points;
        let mut m = multiple();
        let mut current = spacing * m;
        let dist = stitch_distance(s0[0], s1[0], old0, old1);
        let mut to_travel = (1.0 - (dist / spacing).min(1.0)) * step * m;
        let mut cursor = 0.0;
        let mut iterations = 0;
        let mut guard = 0;
        while cursor + to_travel <= 1.0 && guard < 100_000 {
            guard += 1;
            iterations += 1;
            let t = cursor + to_travel;
            let p0 = point_at(s0, &c0, t * l0);
            let p1 = point_at(s1, &c1, t * l1);
            if iterations <= 2 {
                let d = stitch_distance(p0, p1, old0, old1);
                if d > 0.01 && ((current - d) / current).abs() > 0.05 {
                    to_travel *= current / d;
                    if iterations == 1 {
                        to_travel = to_travel.min(1.0 - cursor);
                    }
                    continue;
                }
            }
            cursor += to_travel;
            m = multiple();
            to_travel = step * m;
            current = spacing * m;
            old0 = p0;
            old1 = p1;
            pairs.push(process(p0, p1));
            iterations = 0;
        }
    }
    if let Some((s0, s1)) = geo.sections.last() {
        if let (Some(e0), Some(e1)) = (s0.last(), s1.last()) {
            if stitch_distance(*e0, *e1, old0, old1) > 0.1 {
                pairs.push(process(*e0, *e1));
            }
        }
    }
    pairs
}

/// Shorten every other stitch where the rail is tightly curved (avoids
/// thread build-up on the inside of curves).
fn inset_short_stitches(pairs: &[(Point, Point)], inset: f64, min_dist: f64) -> Vec<(Point, Point)> {
    if inset <= 0.0 {
        return pairs.to_vec();
    }
    let mut out = pairs.to_vec();
    for i in 1..pairs.len() {
        if i % 2 == 0 {
            continue;
        }
        let (a, b) = pairs[i];
        let (pa, pb) = pairs[i - 1];
        let w = b - a;
        if a.dist(pa) < min_dist {
            out[i].0 = a + w * inset;
        }
        if b.dist(pb) < min_dist {
            out[i].1 = b - w * inset;
        }
    }
    out
}

fn split_points(a: Point, b: Point, max_len: f64) -> Vec<Point> {
    split_points_staggered(a, b, max_len, 0, 0)
}

/// Split points of a long stitch: evenly, or staggered — shifted by a share
/// of a section from stitch to stitch (repeating every `staggers` stitches)
/// so the split points do not line up into a visible line.
fn split_points_staggered(a: Point, b: Point, max_len: f64, row: usize, staggers: u32) -> Vec<Point> {
    if max_len <= 0.0 {
        return vec![];
    }
    let d = a.dist(b);
    if d <= max_len {
        return vec![];
    }
    let n = (d / max_len).ceil() as usize;
    if staggers < 2 {
        return (1..n).map(|k| a.lerp(b, k as f64 / n as f64)).collect();
    }
    // an extra section, the points moved along it row by row
    let n = n + 1;
    let shift = (row % staggers as usize) as f64 / staggers as f64;
    (0..n - 1).map(|k| (k as f64 + 0.5 + shift * 0.5) / n as f64).filter(|t| *t > 0.02 && *t < 0.98).map(|t| a.lerp(b, t)).collect()
}

/// How long satin stitches are split (Ink/Stitch `split_method` default
/// with random jitter / random phase, or staggered).
#[derive(Debug, Clone, Copy)]
struct Splitter {
    max_len: f64,
    staggers: u32,
    jitter: f64,
    random_phase: bool,
    min_len: f64,
    seed: u32,
}

impl Splitter {
    fn new(p: &SatinParams) -> Self {
        Splitter {
            max_len: p.max_stitch_length,
            staggers: p.split_staggers,
            jitter: p.split_jitter.clamp(0.0, 1.0),
            random_phase: p.split_random_phase,
            min_len: if p.split_min_length > 0.0 { p.split_min_length.min(p.max_stitch_length) } else { p.max_stitch_length },
            seed: p.random_seed,
        }
    }

    /// Split points of stitch `row` from a to b.
    fn points(&self, a: Point, b: Point, row: usize) -> Vec<Point> {
        if self.max_len <= 0.0 || self.staggers >= 2 || (self.jitter <= 0.0 && !self.random_phase) {
            return split_points_staggered(a, b, self.max_len, row, self.staggers);
        }
        let d = a.dist(b);
        if self.random_phase {
            if d <= self.min_len {
                return vec![];
            }
            // Ink/Stitch split_segment_random_phase: a random start, then
            // lengths varied by the jitter; none right next to the ends
            let mut rng = crate::prng::Stream::new(self.seed, 0x5011_7000 + row as u64);
            let mut t = self.max_len * rng.next();
            let mut out = Vec::new();
            while t < d {
                out.push(a.lerp(b, t / d));
                t += self.max_len * (1.0 + self.jitter * (rng.next() - 0.5) * 2.0);
            }
            let min_stitch = 0.25;
            if out.len() > 1 && out[0].dist(a) <= min_stitch {
                out.remove(0);
            }
            if out.len() > 1 && out.last().unwrap().dist(b) <= min_stitch {
                out.pop();
            }
            return out;
        }
        if d <= self.max_len {
            return vec![];
        }
        // even parts, each split point moved by up to the jitter (Ink/Stitch split_segment_even_n)
        let n = (d / self.max_len).ceil() as usize;
        let mut ts: Vec<f64> = (1..n)
            .map(|k| {
                let j = crate::prng::uniform(self.seed, 0x5011_7001 + row as u64, k as u64) * 2.0 - 1.0;
                (k as f64 + j * self.jitter) / n as f64
            })
            .collect();
        ts.sort_by(|x, y| x.partial_cmp(y).unwrap());
        ts.into_iter().map(|t| a.lerp(b, t.clamp(0.0, 1.0))).collect()
    }
}

/// A small deterministic random number (0..1) for stitch `i`.
fn jitter(seed: u32, i: usize) -> f64 {
    let mut x = (i as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15) ^ (seed as u64).wrapping_mul(0xC2B2_AE3D_27D4_EB4F);
    x ^= x >> 31;
    x = x.wrapping_mul(0xBF58_476D_1CE4_E5B9);
    x ^= x >> 29;
    (x >> 11) as f64 / (1u64 << 53) as f64
}

/// Push compensation (column ends pulled in) and random width texture.
fn shape_pairs(pairs: Vec<(Point, Point)>, p: &SatinParams) -> Vec<(Point, Point)> {
    let mut pairs = pairs;
    if p.push_comp > 0.0 && pairs.len() > 2 {
        // drop the stitches within push_comp of either end of the column
        let mid: Vec<Point> = pairs.iter().map(|(a, b)| a.lerp(*b, 0.5)).collect();
        let mut s = vec![0.0];
        for i in 1..mid.len() {
            s.push(s[i - 1] + mid[i].dist(mid[i - 1]));
        }
        let total = s[s.len() - 1];
        if total > 3.0 * p.push_comp {
            pairs = pairs.into_iter().zip(s).filter(|(_, d)| *d >= p.push_comp && *d <= total - p.push_comp).map(|(x, _)| x).collect();
        }
    }
    if p.random_wider > 0.0 || p.random_narrower > 0.0 {
        pairs = pairs
            .into_iter()
            .enumerate()
            .map(|(i, (a, b))| {
                let r = jitter(p.random_seed, i);
                // one side at a time, so the edges get the texture
                let f = -p.random_narrower + r * (p.random_wider + p.random_narrower);
                let d = (b - a) * f;
                if i % 2 == 0 { (a - d, b) } else { (a, b + d) }
            })
            .collect();
    }
    pairs
}

fn push(run: &mut Run, p: Point, f: u8) {
    if let Some(&(last, _)) = run.last() {
        if last.dist(p) < 1e-6 {
            return;
        }
    }
    run.push((p, f));
}

fn underlay(geo: &SatinGeometry, p: &SatinParams, which: super::underlay::SatinUnderlay, run: &mut Run, density: f64) {
    let u = flags::UNDERLAY;
    let len = p.underlay_stitch_length.clamp(0.5, 8.0);
    if which.center {
        let pairs = plot_points_on_rails(geo, 0.5, 0.0, 0.0);
        let pos = p.center_walk_position.clamp(0.0, 1.0);
        let center: Vec<Point> = pairs.iter().map(|(a, b)| a.lerp(*b, pos)).collect();
        let fwd = running_stitch(&center, len, 0.1);
        // there and back, as often as asked: an even count ends at the start,
        // where the cover begins; an odd one at the end, and the cover comes
        // back (Ink/Stitch: the column begins and ends at its start)
        let n = p.center_walk_repeats.max(1);
        for k in 0..n {
            let pass: Box<dyn Iterator<Item = &Point>> = if k % 2 == 0 { Box::new(fwd.iter()) } else { Box::new(fwd.iter().rev()) };
            for q in pass {
                push(run, *q, u);
            }
        }
    }
    if which.contour {
        let pairs = plot_points_on_rails(geo, 0.5, -p.contour_inset, -p.contour_inset_pct);
        let left: Vec<Point> = pairs.iter().map(|x| x.0).collect();
        let right: Vec<Point> = pairs.iter().rev().map(|x| x.1).collect();
        for q in running_stitch(&left, len, 0.1) {
            push(run, q, u);
        }
        for q in running_stitch(&right, len, 0.1) {
            push(run, q, u);
        }
        if let Some(f) = left.first() {
            push(run, *f, u);
        }
    }
    if which.zigzag {
        let sp = (p.zigzag_underlay_spacing * density).max(0.5);
        let pairs = plot_points_on_rails(geo, sp / 2.0, -p.zigzag_underlay_inset, -p.zigzag_inset_pct);
        // forward: alternate sides; back: the other alternation (ends at start)
        let fwd: Vec<Point> = pairs.iter().enumerate().map(|(i, (a, b))| if i % 2 == 0 { *a } else { *b }).collect();
        let back: Vec<Point> = pairs.iter().enumerate().rev().map(|(i, (a, b))| if i % 2 == 0 { *b } else { *a }).collect();
        let all: Vec<Point> = fwd.into_iter().chain(back).collect();
        // long zig-zags split (Ink/Stitch zigzag_underlay_max_stitch_length_mm)
        let all = if p.zigzag_underlay_max_stitch > 0.0 { crate::geom::resample_max(&all, p.zigzag_underlay_max_stitch.max(0.5)) } else { all };
        for q in all {
            push(run, q, u);
        }
    }
}

/// Generate satin stitches. `extra_pull` comes from the fabric profile,
/// `density` scales the zig-zag spacing (fabric profile).
pub fn satin(paths: &[SubPath], p: &SatinParams, extra_pull: f64, density: f64) -> Vec<Run> {
    let fabric = crate::model::FabricProfile { pull_comp: extra_pull, density_scale: density, ..crate::model::Fabric::Cotton.profile() };
    satin_on(paths, p, &fabric)
}

/// A satin column on a fabric (its compensation, density and auto underlay rules).
pub fn satin_on(paths: &[SubPath], p: &SatinParams, fabric: &crate::model::FabricProfile) -> Vec<Run> {
    let (extra_pull, density) = (fabric.pull_comp, fabric.density_scale);
    if p.multi && paths.len() > 1 {
        let single = SatinParams { multi: false, ..p.clone() };
        return paths.iter().flat_map(|sp| satin_on(std::slice::from_ref(sp), &single, fabric)).collect();
    }
    let Some(geo) = satin_geometry(paths, p) else { return vec![] };
    let mut run: Run = Vec::new();
    // auto underlay: by the column's mean width
    let which = if p.underlay_auto {
        let pairs = plot_points_on_rails(&geo, 1.0, 0.0, 0.0);
        let w = pairs.iter().map(|(a, b)| a.dist(*b)).sum::<f64>() / pairs.len().max(1) as f64;
        super::underlay::satin_underlay(w, p, fabric)
    } else {
        super::underlay::satin_underlay(0.0, p, fabric)
    };
    // an odd centre walk ends at the far end: the cover runs back from there
    let back = which.center && p.center_walk_repeats.max(1) % 2 == 1;
    if back {
        // the other underlays first (they return to the start), the walk last
        underlay(&geo, p, super::underlay::SatinUnderlay { center: false, ..which }, &mut run, density);
        underlay(&geo, p, super::underlay::SatinUnderlay { center: true, contour: false, zigzag: false }, &mut run, density);
    } else {
        underlay(&geo, p, which, &mut run, density);
    }
    let geo = if back {
        SatinGeometry { sections: geo.sections.into_iter().rev().map(|(mut a, mut b)| { a.reverse(); b.reverse(); (a, b) }).collect() }
    } else {
        geo
    };

    let pc = (p.pull_comp + extra_pull) * 0.5;
    let pct = p.pull_comp_pct / 100.0 * 0.5;
    let spacing = (p.spacing * density).max(0.1);
    let max_len = p.max_stitch_length;
    let random = (p.random_spacing > 0.0).then_some((p.random_spacing.clamp(0.0, 1.0), p.random_seed));
    match p.method {
        SatinMethod::Satin => {
            let pairs = shape_pairs(plot_points_on_rails_ex(&geo, spacing, pc, pct, random), p);
            let pairs = inset_short_stitches(&pairs, p.short_stitch_inset, p.short_stitch_distance.max(0.0));
            let split = Splitter::new(p);
            let mut last_b: Option<Point> = None;
            for (row, (a, b)) in pairs.into_iter().enumerate() {
                if let Some(lb) = last_b {
                    for q in split.points(lb, a, row * 2 + 1) {
                        push(&mut run, q, 0);
                    }
                }
                push(&mut run, a, 0);
                for q in split.points(a, b, row * 2) {
                    push(&mut run, q, 0);
                }
                push(&mut run, b, 0);
                last_b = Some(b);
            }
        }
        SatinMethod::Zigzag => {
            let pairs = shape_pairs(plot_points_on_rails_ex(&geo, spacing / 2.0, pc, pct, random), p);
            for (i, (a, b)) in pairs.iter().enumerate() {
                push(&mut run, if i % 2 == 0 { *a } else { *b }, 0);
            }
        }
        SatinMethod::EStitch => {
            let pairs = plot_points_on_rails(&geo, spacing, pc, pct);
            for (a, b) in pairs {
                push(&mut run, a, 0);
                push(&mut run, b, 0);
                push(&mut run, a, 0);
            }
        }
        SatinMethod::SStitch => {
            let pairs = plot_points_on_rails(&geo, spacing, pc, pct);
            for (i, (a, b)) in pairs.iter().enumerate() {
                let mut pts = vec![*a];
                pts.extend(split_points(*a, *b, max_len));
                pts.push(*b);
                if i % 2 == 0 {
                    pts.reverse();
                }
                for q in pts {
                    push(&mut run, q, 0);
                }
            }
        }
    }
    vec![run]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_rung_longer_than_short_rails_stays_a_rung() {
        // Barstitch's "t" crossbar: two 4.5 mm rails, one 6.9 mm rung across both
        let line = |a: (f64, f64), b: (f64, f64)| SubPath { closed: false, nodes: vec![crate::model::Node::corner(a.0, a.1), crate::model::Node::corner(b.0, b.1)] };
        let paths = vec![line((11.88, 16.40), (7.37, 16.35)), line((11.88, 20.37), (7.48, 20.37)), line((9.55, 15.0), (9.55, 21.88))];
        let flat: Vec<Vec<Point>> = paths.iter().map(|s| s.flatten(0.2)).collect();
        assert_eq!(rail_indices(&flat), (0, 1));
        let geo = satin_geometry(&paths, &SatinParams { width: 3.0, pull_comp: 0.0, ..Default::default() }).unwrap();
        for (a, b) in plot_points_on_rails(&geo, 0.4, 0.0, 0.0) {
            assert!(a.dist(b) < 4.5, "stitch {a:?} → {b:?} leaves the 4 mm column");
            assert!(a.y.min(b.y) > 16.0 && a.y.max(b.y) < 20.6, "stitch {a:?} → {b:?} reaches the rung's ends");
        }
        // a "#": two rails and two rungs, all crossing two others → the longest are the rails
        let hash = vec![line((0.0, 0.0), (20.0, 0.0)), line((0.0, 4.0), (20.0, 4.0)), line((5.0, -1.0), (5.0, 5.0)), line((15.0, -1.0), (15.0, 5.0))];
        let flat: Vec<Vec<Point>> = hash.iter().map(|s| s.flatten(0.2)).collect();
        assert_eq!(rail_indices(&flat), (0, 1));
    }

    #[test]
    fn direction_guides_turn_the_stitches() {
        // a straight centre-line satin: stitches across (vertical) unless guided
        let line = vec![SubPath { closed: false, nodes: vec![crate::model::Node::corner(0.0, 0.0), crate::model::Node::corner(30.0, 0.0)] }];
        let plain = SatinParams { width: 4.0, center_walk: false, pull_comp: 0.0, short_stitch_inset: 0.0, ..Default::default() };
        let angle_at = |p: &SatinParams, x: f64| -> f64 {
            let geo = satin_geometry(&line, p).unwrap();
            let pairs = plot_points_on_rails(&geo, 0.4, 0.0, 0.0);
            let (a, b) = pairs.iter().min_by(|u, v| ((u.0.x + u.1.x) / 2.0 - x).abs().partial_cmp(&((v.0.x + v.1.x) / 2.0 - x).abs()).unwrap()).copied().unwrap();
            (b - a).y.atan2((b - a).x).to_degrees().abs()
        };
        assert!((angle_at(&plain, 15.0) - 90.0).abs() < 2.0);
        // two guides slanted at 45°: the stitches between them slant too
        let guided = SatinParams { guides: vec![[[8.0, -2.0], [12.0, 2.0]], [[18.0, -2.0], [22.0, 2.0]]], ..plain.clone() };
        let a = angle_at(&guided, 15.0);
        assert!((a - 45.0).abs() < 8.0 || (a - 135.0).abs() < 8.0, "{a}");
        // a guide works on two-rail satins as a rung
        let rails = vec![
            SubPath { closed: false, nodes: vec![crate::model::Node::corner(0.0, -2.0), crate::model::Node::corner(30.0, -2.0)] },
            SubPath { closed: false, nodes: vec![crate::model::Node::corner(0.0, 2.0), crate::model::Node::corner(30.0, 2.0)] },
        ];
        let geo = satin_geometry(&rails, &guided).unwrap();
        assert!(geo.sections.len() >= 3, "{} sections", geo.sections.len());
    }
    use crate::geom::pt;

    fn line(a: Point, b: Point) -> SubPath {
        SubPath::polyline(&[a, b], false)
    }

    #[test]
    fn two_rails_density() {
        let paths = vec![line(pt(0.0, 0.0), pt(20.0, 0.0)), line(pt(0.0, 4.0), pt(20.0, 4.0))];
        let p = SatinParams { center_walk: false, pull_comp: 0.0, short_stitch_inset: 0.0, ..Default::default() };
        let runs = satin(&paths, &p, 0.0, 1.0);
        let n = runs[0].len();
        // 20mm / 0.4mm spacing → ~51 pairs → ~102 stitches
        assert!((95..=110).contains(&n), "got {n}");
    }

    #[test]
    fn centerline_width() {
        let paths = vec![line(pt(0.0, 0.0), pt(10.0, 0.0))];
        let p = SatinParams { width: 4.0, center_walk: false, pull_comp: 0.0, short_stitch_inset: 0.0, ..Default::default() };
        let runs = satin(&paths, &p, 0.0, 1.0);
        for (q, _) in &runs[0] {
            assert!((q.y.abs() - 2.0).abs() < 1e-6);
        }
    }

    #[test]
    fn reversed_rail_detected() {
        let paths = vec![line(pt(0.0, 0.0), pt(20.0, 0.0)), line(pt(20.0, 4.0), pt(0.0, 4.0))];
        let p = SatinParams { center_walk: false, short_stitch_inset: 0.0, pull_comp: 0.0, ..Default::default() };
        let runs = satin(&paths, &p, 0.0, 1.0);
        // consecutive stitches should be roughly vertical (cross the column), not diagonal
        let (a, b) = (runs[0][0].0, runs[0][1].0);
        assert!((a.x - b.x).abs() < 0.5);
    }
}

#[cfg(test)]
mod multi_tests {
    use super::*;
    use crate::geom::pt;

    #[test]
    fn multi_makes_one_column_per_subpath() {
        let ring = |r: f64| {
            let pts: Vec<Point> = (0..32).map(|i| {
                let a = i as f64 / 32.0 * std::f64::consts::TAU;
                pt(r * a.cos(), r * a.sin())
            }).collect();
            SubPath::polyline(&pts, true)
        };
        let p = SatinParams { multi: true, width: 1.0, center_walk: false, ..Default::default() };
        let runs = satin(&[ring(10.0), ring(4.0)], &p, 0.0, 1.0);
        assert_eq!(runs.len(), 2);
        for (run, r) in runs.iter().zip([10.0, 4.0]) {
            for (q, _) in run {
                assert!((q.length() - r).abs() < 0.8, "{} vs {r}", q.length());
            }
        }
    }
}

#[cfg(test)]
mod underlay_detail_tests {
    use super::*;

    #[test]
    fn centre_walk_repeats_and_position() {
        let line = vec![SubPath { closed: false, nodes: vec![crate::model::Node::corner(0.0, 0.0), crate::model::Node::corner(30.0, 0.0)] }];
        let ul = |p: &SatinParams| -> Vec<Point> { satin(&line, p, 0.0, 1.0).iter().flatten().filter(|x| x.1 & flags::UNDERLAY != 0).map(|x| x.0).collect() };
        let base = SatinParams { width: 4.0, center_walk: true, ..Default::default() };
        let two = ul(&base).len();
        let four = ul(&SatinParams { center_walk_repeats: 4, ..base.clone() }).len();
        assert!(four as f64 > two as f64 * 1.8, "{two} {four}");
        // off centre: towards the second rail
        let off = ul(&SatinParams { center_walk_position: 0.9, ..base.clone() });
        let y = off.iter().map(|q| q.y).sum::<f64>() / off.len() as f64;
        assert!(y.abs() > 1.2, "{y}");
    }
}

#[cfg(test)]
mod texture_tests {
    use super::*;

    fn line() -> Vec<SubPath> {
        vec![SubPath { closed: false, nodes: vec![crate::model::Node::corner(0.0, 0.0), crate::model::Node::corner(30.0, 0.0)] }]
    }
    fn top(p: &SatinParams) -> Vec<Point> {
        satin(&line(), p, 0.0, 1.0).iter().flatten().filter(|x| x.1 & flags::UNDERLAY == 0).map(|x| x.0).collect()
    }

    #[test]
    fn push_comp_shortens_the_column() {
        let p = SatinParams { width: 4.0, center_walk: false, pull_comp: 0.0, short_stitch_inset: 0.0, ..Default::default() };
        let span = |v: &Vec<Point>| v.iter().map(|q| q.x).fold(f64::MIN, f64::max) - v.iter().map(|q| q.x).fold(f64::MAX, f64::min);
        let (a, b) = (span(&top(&p)), span(&top(&SatinParams { push_comp: 1.0, ..p.clone() })));
        assert!((a - b - 2.0).abs() < 0.6, "{a} {b}");
    }

    #[test]
    fn random_width_varies_and_is_repeatable() {
        let p = SatinParams { width: 4.0, center_walk: false, pull_comp: 0.0, short_stitch_inset: 0.0, random_wider: 0.2, random_narrower: 0.2, ..Default::default() };
        let ys: Vec<f64> = top(&p).iter().map(|q| q.y.abs()).collect();
        let (lo, hi) = (ys.iter().cloned().fold(f64::MAX, f64::min), ys.iter().cloned().fold(f64::MIN, f64::max));
        assert!(hi - lo > 0.3, "{lo} {hi}");
        assert_eq!(top(&p), top(&p));
    }

    #[test]
    fn staggered_splits_do_not_line_up() {
        let p = SatinParams { width: 10.0, center_walk: false, pull_comp: 0.0, short_stitch_inset: 0.0, max_stitch_length: 4.0, split_staggers: 3, ..Default::default() };
        let even = SatinParams { split_staggers: 0, ..p.clone() };
        // the y of split points (inside the column): more distinct values when staggered
        let inner = |v: Vec<Point>| { let mut ys: Vec<i64> = v.iter().filter(|q| q.y.abs() < 4.9).map(|q| (q.y * 10.0).round() as i64).collect(); ys.sort(); ys.dedup(); ys.len() };
        assert!(inner(top(&p)) > inner(top(&even)), "{} {}", inner(top(&p)), inner(top(&even)));
    }
}

#[cfg(test)]
mod random_split_tests {
    use super::*;
    use crate::geom::pt;
    use crate::model::{Fabric, RailReverse, SatinParams, SubPath};

    fn rails() -> Vec<SubPath> {
        vec![SubPath::polyline(&[pt(0.0, 0.0), pt(40.0, 0.0)], false), SubPath::polyline(&[pt(0.0, 10.0), pt(40.0, 10.0)], false)]
    }
    fn sewn(p: &SatinParams) -> Vec<Point> {
        satin_on(&rails(), p, &Fabric::Cotton.profile()).into_iter().flatten().filter(|x| x.1 == 0).map(|x| x.0).collect()
    }
    fn base() -> SatinParams {
        SatinParams { center_walk: false, contour_underlay: false, zigzag_underlay: false, underlay_auto: false, pull_comp: 0.0, short_stitch_inset: 0.0, ..Default::default() }
    }

    #[test]
    fn random_spacing_varies_the_gaps() {
        let gaps = |p: &SatinParams| -> Vec<f64> { sewn(p).iter().filter(|q| q.y.abs() < 1e-6).map(|q| q.x).collect::<Vec<_>>().windows(2).map(|w| w[1] - w[0]).collect() };
        let even = gaps(&base());
        let rnd = gaps(&SatinParams { random_spacing: 0.4, ..base() });
        let spread = |g: &[f64]| g.iter().cloned().fold(0.0, f64::max) - g.iter().cloned().fold(f64::MAX, f64::min);
        assert!(spread(&rnd[1..rnd.len() - 1]) > spread(&even[1..even.len() - 1]) + 0.1, "{:?}", &rnd[..6]);
        assert_eq!(gaps(&SatinParams { random_spacing: 0.4, ..base() }), rnd, "repeatable");
    }

    #[test]
    fn split_jitter_and_random_phase_move_the_split_points() {
        let split = SatinParams { max_stitch_length: 4.0, ..base() };
        let mids = |p: &SatinParams| -> Vec<f64> { sewn(p).iter().filter(|q| q.y > 0.5 && q.y < 9.5).map(|q| (q.y * 1000.0).round() / 1000.0).collect() };
        let even = mids(&split);
        let distinct = |v: &[f64]| v.iter().map(|y| (y * 100.0) as i64).collect::<std::collections::BTreeSet<_>>().len();
        assert!(distinct(&even) <= 4, "even splits sit on a few lines");
        assert!(distinct(&mids(&SatinParams { split_jitter: 0.5, ..split.clone() })) > 10, "jitter scatters them");
        assert!(distinct(&mids(&SatinParams { split_random_phase: true, ..split.clone() })) > 10, "a random phase too");
    }

    #[test]
    fn reversing_a_rail_by_hand() {
        let auto = sewn(&base());
        let first = sewn(&SatinParams { reverse_rails: RailReverse::First, ..base() });
        // with the first rail reversed the stitches cross the column diagonally
        let slant = |v: &[Point]| v.windows(2).map(|w| (w[1].x - w[0].x).abs()).fold(0.0, f64::max);
        assert!(slant(&first) > slant(&auto) + 10.0);
        assert_eq!(sewn(&SatinParams { reverse_rails: RailReverse::None, ..base() }), auto, "parallel rails need no reversing");
    }
}
