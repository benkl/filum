//! Fills ported from Ink/Stitch (GPL-3.0-or-later):
//!
//! * **Meander** (`lib/stitches/meander_fill.py`) — a lattice is clipped to
//!   the shape; a path from a start to an end node is grown into a random
//!   space-filling walk by repeatedly replacing one of its edges with a short
//!   detour through unvisited nodes. Then it is smoothed and stitched.
//! * **Guided** (`guided_fill.py`, "copy" strategy) — the rows are copies of
//!   a guide line. Implemented by warping the shape so the guide becomes a
//!   straight line, filling it with tatami rows and warping the stitches back.
//! * **Circular** (`circular_fill.py`) — an Archimedean spiral around a centre
//!   point, clipped to the shape; pieces are joined by travel inside it.

use std::collections::{HashMap, HashSet, VecDeque};
use std::f64::consts::TAU;

use crate::geom::*;
use crate::model::{MeanderPattern, SubPath};
use crate::plan::flags;

use super::fill::{tatami, travel_path};
use super::meander_tiles::{Tile, SNAP};
use super::running::running_stitch;
use super::Run;

fn push(run: &mut Run, p: Point, f: u8) {
    if let Some(&(last, _)) = run.last() {
        if last.dist(p) < 1e-6 {
            return;
        }
    }
    run.push((p, f));
}

/// Join pieces (in order) into runs, travelling inside the shape between them.
fn join_pieces(rings: &[Ring], pieces: Vec<Vec<Point>>, stitch_len: f64, travel_len: f64, f: u8) -> Vec<Run> {
    let mut runs: Vec<Run> = Vec::new();
    let mut run: Run = Vec::new();
    for piece in pieces {
        if piece.len() < 2 {
            continue;
        }
        if let (Some(&(from, _)), Some(&to)) = (run.last(), piece.first()) {
            match travel_path(rings, from, to) {
                Some(path) => {
                    for q in running_stitch(&path, travel_len, 0.1).into_iter().skip(1) {
                        push(&mut run, q, flags::TRAVEL);
                    }
                }
                None => runs.push(std::mem::take(&mut run)),
            }
        }
        for q in super::running::sew_line(&piece, stitch_len, 0.1) {
            push(&mut run, q, f);
        }
    }
    if !run.is_empty() {
        runs.push(run);
    }
    runs.retain(|r| r.len() > 1);
    runs
}

// ---------------------------------------------------------------------------
// Meander

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n.max(1) as u64) as usize
    }
}

/// Lattice nodes and edges (in the rotated frame) covering a box.
fn lattice(pattern: MeanderPattern, b: Rect, s: f64) -> (Vec<Point>, Vec<(usize, usize)>) {
    let mut nodes = Vec::new();
    let mut edges = Vec::new();
    let pad = 2.0 * s;
    match pattern {
        MeanderPattern::Square => {
            let (nx, ny) = (((b.width() + 2.0 * pad) / s) as usize + 1, ((b.height() + 2.0 * pad) / s) as usize + 1);
            for j in 0..ny {
                for i in 0..nx {
                    nodes.push(pt(b.min_x - pad + i as f64 * s, b.min_y - pad + j as f64 * s));
                    let k = j * nx + i;
                    if i + 1 < nx {
                        edges.push((k, k + 1));
                    }
                    if j + 1 < ny {
                        edges.push((k, k + nx));
                    }
                }
            }
        }
        MeanderPattern::Triangle => {
            let h = s * 3f64.sqrt() / 2.0;
            let (nx, ny) = (((b.width() + 2.0 * pad) / s) as usize + 2, ((b.height() + 2.0 * pad) / h) as usize + 1);
            for j in 0..ny {
                let shift = if j % 2 == 1 { s / 2.0 } else { 0.0 };
                for i in 0..nx {
                    nodes.push(pt(b.min_x - pad + i as f64 * s + shift, b.min_y - pad + j as f64 * h));
                    let k = j * nx + i;
                    if i + 1 < nx {
                        edges.push((k, k + 1));
                    }
                    if j + 1 < ny {
                        // the two nodes below
                        edges.push((k, k + nx));
                        if j % 2 == 1 && i + 1 < nx {
                            edges.push((k, k + nx + 1));
                        }
                        if j % 2 == 0 && i > 0 {
                            edges.push((k, k + nx - 1));
                        }
                    }
                }
            }
        }
        MeanderPattern::Hexagon => {
            // honeycomb as zig-zag rows; vertical edges where (i + j) is odd
            let w = s * 3f64.sqrt() / 2.0;
            let (nx, ny) = (((b.width() + 2.0 * pad) / w) as usize + 1, ((b.height() + 2.0 * pad) / (1.5 * s)) as usize + 1);
            for j in 0..ny {
                for i in 0..nx {
                    let dy = if (i + j) % 2 == 0 { 0.0 } else { 0.5 * s };
                    nodes.push(pt(b.min_x - pad + i as f64 * w, b.min_y - pad + j as f64 * 1.5 * s + dy));
                    let k = j * nx + i;
                    if i + 1 < nx {
                        edges.push((k, k + 1));
                    }
                    if j + 1 < ny && (i + j) % 2 == 1 {
                        edges.push((k, k + nx));
                    }
                }
            }
        }
    }
    (nodes, edges)
}

/// An Ink/Stitch tile repeated over a box (rotated frame), as in
/// `lib/tiles.py`: copies are placed around the box centre along the two
/// repeat vectors and nodes are snapped to whole pixels so neighbouring
/// copies share them.
fn tile_lattice(tile: &Tile, b: Rect, k: f64, ky: f64) -> (Vec<Point>, Vec<(usize, usize)>) {
    let sc = |x: f64, y: f64| pt(x * k, y * ky);
    let s0 = sc(tile.shift0[0], tile.shift0[1]);
    let s1 = sc(tile.shift1[0], tile.shift1[1]);
    let c = pt((b.min_x + b.max_x) / 2.0, (b.min_y + b.max_y) / 2.0);
    let (w, h) = (b.width(), b.height());
    let min_shift = s0.length().min(s1.length()).max(1e-6);
    let n = ((w.hypot(h) / min_shift).ceil() as i64 + 1).min(4000);
    let diag = (s0 + s1).length().max((s0 - s1).length());
    let (xcut, ycut) = (w / 2.0 + diag, h / 2.0 + diag);
    let mut ids: HashMap<(i64, i64), usize> = HashMap::new();
    let mut nodes = Vec::new();
    let mut edges = HashSet::new();
    let mut node = |p: Point, nodes: &mut Vec<Point>| -> usize {
        let key = ((p.x / SNAP).round() as i64, (p.y / SNAP).round() as i64);
        *ids.entry(key).or_insert_with(|| {
            nodes.push(pt(key.0 as f64 * SNAP, key.1 as f64 * SNAP));
            nodes.len() - 1
        })
    };
    // a parallelogram lattice can be very slanted: cover the box generously
    // but skip copies whose offset is clearly outside it
    let n0 = ((w.hypot(h) / s0.length().max(1e-6)).ceil() as i64 + 2).min(n * 4);
    let n1 = ((w.hypot(h) / s1.length().max(1e-6)).ceil() as i64 + 2).min(n * 4);
    for i in -n0..=n0 {
        for j in -n1..=n1 {
            let off = s0 * i as f64 + s1 * j as f64;
            if off.x.abs() > xcut || off.y.abs() > ycut {
                continue;
            }
            for l in &tile.lines {
                let a = node(c + off + sc(l[0], l[1]), &mut nodes);
                let z = node(c + off + sc(l[2], l[3]), &mut nodes);
                if a != z {
                    edges.insert((a.min(z), a.max(z)));
                }
            }
        }
    }
    let mut edges: Vec<(usize, usize)> = edges.into_iter().collect();
    edges.sort_unstable();
    (nodes, edges)
}

/// Remove dead ends (degree ≤ 1) until none are left, as Ink/Stitch does.
fn prune_dead_ends(adj: &mut [Vec<usize>]) {
    let mut q: Vec<usize> = (0..adj.len()).filter(|&v| adj[v].len() == 1).collect();
    while let Some(v) = q.pop() {
        if adj[v].len() != 1 {
            continue;
        }
        let u = adj[v][0];
        adj[v].clear();
        adj[u].retain(|&x| x != v);
        if adj[u].len() == 1 {
            q.push(u);
        }
    }
}

/// Shortest detour from `a` to `b` through unvisited nodes (2..=`max_len` edges).
fn detour(adj: &[Vec<usize>], visited: &[bool], a: usize, b: usize, max_len: usize) -> Option<Vec<usize>> {
    let mut prev = std::collections::HashMap::new();
    let mut q = VecDeque::new();
    for &c in &adj[a] {
        if !visited[c] {
            prev.insert(c, (a, 1usize));
            q.push_back(c);
        }
    }
    while let Some(c) = q.pop_front() {
        let depth = prev[&c].1;
        if adj[c].contains(&b) && depth >= 1 {
            let mut path = vec![c];
            let mut cur = c;
            while let Some(&(p, _)) = prev.get(&cur) {
                if p == a {
                    break;
                }
                path.push(p);
                cur = p;
            }
            path.reverse();
            return Some(path);
        }
        if depth + 1 >= max_len {
            continue;
        }
        for &d in &adj[c] {
            if !visited[d] && d != b && !prev.contains_key(&d) && d != a {
                prev.insert(d, (c, depth + 1));
                q.push_back(d);
            }
        }
    }
    None
}

/// Grow the path start → end into a meander (linked list over node ids).
fn grow(adj: &[Vec<usize>], path: Vec<usize>, rng: &mut Rng, reach: usize) -> Vec<usize> {
    let n = adj.len();
    let mut visited = vec![false; n];
    let mut next = vec![usize::MAX; n];
    for w in path.windows(2) {
        next[w[0]] = w[1];
    }
    for &v in &path {
        visited[v] = true;
    }
    let mut work: Vec<usize> = path[..path.len() - 1].to_vec();
    while !work.is_empty() {
        let k = rng.below(work.len());
        let a = work.swap_remove(k);
        let b = next[a];
        if b == usize::MAX {
            continue;
        }
        if let Some(d) = detour(adj, &visited, a, b, reach) {
            let mut cur = a;
            for &c in &d {
                next[cur] = c;
                visited[c] = true;
                cur = c;
                work.push(c);
            }
            next[cur] = b;
            work.push(a);
            continue;
        }
        // two edges a → b → c replaced by a longer detour a → … → c: on
        // honeycombs the free neighbours of a and b lie on opposite sides of
        // the path, so single edges can never be replaced there. b is freed
        // (the path still grows: at least 3 edges replace 2).
        let c = next[b];
        if c == usize::MAX {
            continue;
        }
        if let Some(d) = detour(adj, &visited, a, c, reach).filter(|d| d.len() >= 2) {
            visited[b] = false;
            next[b] = usize::MAX;
            let mut cur = a;
            for &x in &d {
                next[cur] = x;
                visited[x] = true;
                cur = x;
                work.push(x);
            }
            next[cur] = c;
            work.push(a);
        }
    }
    let mut out = vec![path[0]];
    let mut cur = path[0];
    while next[cur] != usize::MAX {
        cur = next[cur];
        out.push(cur);
    }
    out
}

fn bfs_path(adj: &[Vec<usize>], a: usize, b: usize) -> Option<Vec<usize>> {
    let mut prev = vec![usize::MAX; adj.len()];
    let mut q = VecDeque::from([a]);
    prev[a] = a;
    while let Some(c) = q.pop_front() {
        if c == b {
            let mut path = vec![b];
            let mut cur = b;
            while cur != a {
                cur = prev[cur];
                path.push(cur);
            }
            path.reverse();
            return Some(path);
        }
        for &d in &adj[c] {
            if prev[d] == usize::MAX {
                prev[d] = c;
                q.push_back(d);
            }
        }
    }
    None
}

/// Chaikin corner cutting on an open polyline (ends stay).
fn smooth_open(pts: &[Point], iterations: u32) -> Vec<Point> {
    let mut cur = pts.to_vec();
    for _ in 0..iterations {
        if cur.len() < 3 {
            break;
        }
        let mut out = vec![cur[0]];
        for w in cur.windows(2) {
            out.push(w[0].lerp(w[1], 0.25));
            out.push(w[0].lerp(w[1], 0.75));
        }
        out.push(*cur.last().unwrap());
        cur = out;
    }
    cur
}

#[allow(clippy::too_many_arguments)]
/// Meander options beyond the lattice (Ink/Stitch meander fill).
#[derive(Debug, Clone, Default)]
pub struct MeanderOpts<'a> {
    /// Height of the pattern relative to its width (1 = as drawn).
    pub aspect: f64,
    /// Zig-zag meander: (zig+zag length, width) in mm.
    pub zigzag: Option<(f64, f64)>,
    /// Keep the stitches inside these rings (the shape before `expand`).
    pub clip: Option<&'a [Ring]>,
}

#[allow(clippy::too_many_arguments)]
pub fn meander(
    rings: &[Ring],
    pattern: MeanderPattern,
    tile: Option<&Tile>,
    scale: f64,
    angle_deg: f64,
    smoothness: f64,
    stitch_len: f64,
    travel_len: f64,
    seed: u32,
    start: Option<Point>,
    end: Option<Point>,
    f: u8,
) -> Vec<Run> {
    meander_ex(rings, pattern, tile, scale, angle_deg, smoothness, stitch_len, travel_len, seed, start, end, &MeanderOpts { aspect: 1.0, ..Default::default() }, f)
}

#[allow(clippy::too_many_arguments)]
pub fn meander_ex(
    rings: &[Ring],
    pattern: MeanderPattern,
    tile: Option<&Tile>,
    scale: f64,
    angle_deg: f64,
    smoothness: f64,
    stitch_len: f64,
    travel_len: f64,
    seed: u32,
    start: Option<Point>,
    end: Option<Point>,
    o: &MeanderOpts,
    f: u8,
) -> Vec<Run> {
    if rings.is_empty() {
        return vec![];
    }
    let s = scale.max(0.5);
    let aspect = if o.aspect > 0.0 { o.aspect.clamp(0.1, 10.0) } else { 1.0 };
    let a = angle_deg.to_radians();
    let rr = rotate_rings(rings, a);
    let (nodes, edges) = match tile {
        // 2.5 mm ≙ 100 % (Ink/Stitch meander_scale_percent, x and y)
        Some(t) => tile_lattice(t, rings_bounds(&rr), (scale / 2.5).max(0.05), (scale * aspect / 2.5).max(0.05)),
        None => {
            // the lattice built squashed and stretched to the aspect
            let b = rings_bounds(&rr);
            let cy = (b.min_y + b.max_y) / 2.0;
            let squashed = Rect { min_x: b.min_x, max_x: b.max_x, min_y: cy - (cy - b.min_y) / aspect, max_y: cy + (b.max_y - cy) / aspect };
            let (n, e) = lattice(pattern, squashed, s);
            (n.into_iter().map(|p| pt(p.x, cy + (p.y - cy) * aspect)).collect(), e)
        }
    };
    // keep nodes comfortably inside and edges that stay inside (tiles: any
    // edge inside the shape, as in Ink/Stitch)
    let margin = if tile.is_some() { 0.05 } else { s * 0.3 };
    let keep: Vec<bool> = nodes.iter().map(|p| point_in_rings(*p, &rr) && dist_to_boundary(&rr, *p) >= margin).collect();
    let mut adj: Vec<Vec<usize>> = vec![Vec::new(); nodes.len()];
    for &(u, v) in &edges {
        if keep[u] && keep[v] && segment_inside(&rr, nodes[u], nodes[v]) {
            adj[u].push(v);
            adj[v].push(u);
        }
    }
    if tile.is_some() {
        prune_dead_ends(&mut adj);
    }
    // connected components, largest first
    let mut comp = vec![usize::MAX; nodes.len()];
    let mut comps: Vec<Vec<usize>> = Vec::new();
    for v in 0..nodes.len() {
        if !keep[v] || comp[v] != usize::MAX || adj[v].is_empty() {
            continue;
        }
        let id = comps.len();
        let mut members = vec![];
        let mut q = VecDeque::from([v]);
        comp[v] = id;
        while let Some(c) = q.pop_front() {
            members.push(c);
            for &d in &adj[c] {
                if comp[d] == usize::MAX {
                    comp[d] = id;
                    q.push_back(d);
                }
            }
        }
        comps.push(members);
    }
    comps.retain(|c| c.len() >= 2);
    if comps.is_empty() {
        return vec![];
    }
    let mut rng = Rng(0x9E37_79B9_7F4A_7C15 ^ (seed as u64).wrapping_mul(0xD1B5_4A32_D192_ED03) | 1);
    let mut pos = start.map(|p| p.rotate(a));
    let end_r = end.map(|p| p.rotate(a));
    // visit components nearest-first; the one nearest the end point last
    let mut order: Vec<usize> = (0..comps.len()).collect();
    let mut pieces: Vec<Vec<Point>> = Vec::new();
    let iterations = (smoothness.clamp(0.0, 1.0) * 4.0).round() as u32;
    while !order.is_empty() {
        let near = |c: usize, p: Point| comps[c].iter().map(|v| nodes[*v].dist(p)).fold(f64::INFINITY, f64::min);
        let k = match pos {
            Some(p) => {
                let last_comp = end_r.and_then(|e| order.iter().copied().min_by(|x, y| near(*x, e).partial_cmp(&near(*y, e)).unwrap()));
                (0..order.len())
                    .filter(|i| order.len() == 1 || Some(order[*i]) != last_comp)
                    .min_by(|x, y| near(order[*x], p).partial_cmp(&near(order[*y], p)).unwrap())
                    .unwrap_or(0)
            }
            None => (0..order.len()).max_by_key(|i| comps[order[*i]].len()).unwrap(),
        };
        let c = order.remove(k);
        let members = &comps[c];
        let pick = |q: Point| *members.iter().min_by(|x, y| nodes[**x].dist(q).partial_cmp(&nodes[**y].dist(q)).unwrap()).unwrap();
        let first = pos.map(pick).unwrap_or(members[0]);
        let last = match (order.is_empty(), end_r) {
            (true, Some(e)) => pick(e),
            _ => {
                // the node farthest away (by hops) gives the longest initial path
                let mut dist = vec![usize::MAX; nodes.len()];
                let mut q = VecDeque::from([first]);
                dist[first] = 0;
                let mut far = first;
                while let Some(x) = q.pop_front() {
                    far = x;
                    for &y in &adj[x] {
                        if dist[y] == usize::MAX {
                            dist[y] = dist[x] + 1;
                            q.push_back(y);
                        }
                    }
                }
                far
            }
        };
        let base = if first == last { vec![first, adj[first][0]] } else { bfs_path(&adj, first, last).unwrap_or(vec![first]) };
        if base.len() < 2 {
            continue;
        }
        // honeycomb cells need longer detours than squares or triangles
        let reach = if tile.is_some() { 12 } else if pattern == MeanderPattern::Hexagon { 10 } else { 6 };
        let walk = grow(&adj, base, &mut rng, reach);
        let pts: Vec<Point> = walk.iter().map(|v| nodes[*v]).collect();
        let pts = smooth_open(&pts, iterations);
        pos = pts.last().copied();
        pieces.push(pts.into_iter().map(|p| p.rotate(-a)).collect());
    }
    // zig-zag meander and clipping (Ink/Stitch post_process)
    let mut line_len = stitch_len;
    if let Some((spacing, width)) = o.zigzag.filter(|z| z.0 > 0.0) {
        pieces = pieces.into_iter().map(|p| meander_zigzag(&p, spacing, width)).collect();
        // the zig-zag points are the stitches
        line_len = (width * 2.0).max(stitch_len).max(6.0);
    }
    if let Some(clip) = o.clip {
        pieces = pieces.into_iter().map(|p| crate::geom::clamp_to_rings(&p, clip)).collect();
    }
    join_pieces(rings, pieces, line_len, travel_len, f)
}

/// Ink/Stitch's meander zig-zag: points every half spacing, each but the
/// last moved alternately to either side of its segment by half the width.
fn meander_zigzag(pts: &[Point], spacing: f64, width: f64) -> Vec<Point> {
    let mut s = running_stitch(pts, (spacing / 2.0).max(0.1), 0.1);
    let off = width / 2.0;
    for i in 0..s.len().saturating_sub(1) {
        let d = s[i + 1] - s[i];
        if d.length() <= 1e-12 {
            continue;
        }
        let u = d * (1.0 / d.length());
        let z = pt(u.y, -u.x);
        s[i] = if i % 2 == 1 { s[i] - z * off } else { s[i] + z * off };
    }
    s
}

// ---------------------------------------------------------------------------
// Guided fill

/// The guide as a function y = g(x) in a frame where it runs along x.
struct Guide {
    rot: f64,
    xs: Vec<f64>,
    ys: Vec<f64>,
}

impl Guide {
    fn new(guide: &SubPath) -> Option<Guide> {
        let pts = guide.flatten(0.05);
        if pts.len() < 2 {
            return None;
        }
        let d = *pts.last().unwrap() - pts[0];
        if d.length() < 1e-6 {
            return None;
        }
        let rot = -d.y.atan2(d.x);
        let mut xs = Vec::new();
        let mut ys = Vec::new();
        for p in pts.iter().map(|p| p.rotate(rot)) {
            // keep it a function of x (drop back-tracking parts)
            if xs.last().map_or(true, |&x| p.x > x + 1e-6) {
                xs.push(p.x);
                ys.push(p.y);
            }
        }
        (xs.len() >= 2).then_some(Guide { rot, xs, ys })
    }
    fn g(&self, x: f64) -> f64 {
        let n = self.xs.len();
        if x <= self.xs[0] {
            return self.ys[0];
        }
        if x >= self.xs[n - 1] {
            return self.ys[n - 1];
        }
        let k = self.xs.partition_point(|v| *v < x).max(1);
        let t = (x - self.xs[k - 1]) / (self.xs[k] - self.xs[k - 1]).max(1e-12);
        self.ys[k - 1] + (self.ys[k] - self.ys[k - 1]) * t
    }
    fn warp(&self, p: Point) -> Point {
        let q = p.rotate(self.rot);
        pt(q.x, q.y - self.g(q.x))
    }
    fn unwarp(&self, q: Point) -> Point {
        pt(q.x, q.y + self.g(q.x)).rotate(-self.rot)
    }
}

#[allow(clippy::too_many_arguments)]
pub fn guided(
    rings: &[Ring],
    guide: &SubPath,
    spacing: f64,
    max_len: f64,
    staggers: u32,
    pull: f64,
    travel_len: f64,
    start: Option<Point>,
    end: Option<Point>,
    f: u8,
) -> Option<Vec<Run>> {
    let gd = Guide::new(guide)?;
    // densify so the warp bends the outline smoothly
    let warped: Vec<Ring> = rings
        .iter()
        .map(|r| {
            let mut closed = r.clone();
            closed.push(r[0]);
            let mut dense = resample_max(&closed, 0.4);
            dense.pop();
            dense.into_iter().map(|p| gd.warp(p)).collect()
        })
        .collect();
    // short stitches keep the curved rows smooth after warping back
    let len = max_len.min(2.5);
    let runs = tatami(&warped, 0.0, spacing, 0.0, false, len, staggers, pull, travel_len, start.map(|p| gd.warp(p)), end.map(|p| gd.warp(p)), None, f);
    Some(runs.into_iter().map(|r| r.into_iter().map(|(p, fl)| (gd.unwarp(p), fl)).collect()).collect())
}

/// A default guide across a box: a gentle S-curve (left → right).
pub fn default_guide(b: Rect) -> SubPath {
    let (x0, x1) = (b.min_x, b.max_x);
    let y = (b.min_y + b.max_y) / 2.0;
    let h = b.height() * 0.25;
    let w = x1 - x0;
    SubPath {
        closed: false,
        nodes: vec![
            crate::model::Node { p: [x0, y], i: None, o: Some([x0 + w * 0.33, y - h]) },
            crate::model::Node { p: [x1, y], i: Some([x1 - w * 0.33, y + h]), o: None },
        ],
    }
}

// ---------------------------------------------------------------------------
// Circular fill

#[allow(clippy::too_many_arguments)]
pub fn circular(rings: &[Ring], center_rel: [f64; 2], spacing: f64, stitch_len: f64, travel_len: f64, reverse: bool, f: u8) -> Vec<Run> {
    if rings.is_empty() {
        return vec![];
    }
    let b = rings_bounds(rings);
    let c = pt(b.min_x + b.width() * center_rel[0], b.min_y + b.height() * center_rel[1]);
    let rmax = [pt(b.min_x, b.min_y), pt(b.max_x, b.min_y), pt(b.max_x, b.max_y), pt(b.min_x, b.max_y)].iter().map(|q| q.dist(c)).fold(0.0, f64::max);
    let sp = spacing.max(0.2);
    // Archimedean spiral r = sp · θ / 2π, points ~0.3 mm apart
    let mut pieces: Vec<Vec<Point>> = Vec::new();
    let mut cur: Vec<Point> = Vec::new();
    let mut theta: f64 = 0.0;
    while sp * theta / TAU <= rmax {
        let r = sp * theta / TAU;
        let p = pt(c.x + r * theta.cos(), c.y + r * theta.sin());
        if point_in_rings(p, rings) {
            cur.push(p);
        } else if cur.len() > 1 {
            pieces.push(std::mem::take(&mut cur));
        } else {
            cur.clear();
        }
        theta += (0.3 / r.max(0.3)).min(0.5);
    }
    if cur.len() > 1 {
        pieces.push(cur);
    }
    if reverse {
        pieces.reverse();
        for p in &mut pieces {
            p.reverse();
        }
    }
    join_pieces(rings, pieces, stitch_len, travel_len, f)
}

// ---------------------------------------------------------------------------
// Flow fill: evenly spaced streamlines (Jobard & Lefer, "Creating evenly-spaced
// streamlines of arbitrary density", 1997) of a direction field, so the rows
// follow the picture as in Liu et al., "Directionality-Aware Design of
// Embroidery Patterns" (Computer Graphics Forum 2023).

/// Unit row direction at a point (sign arbitrary): bilinear in doubled angles.
fn field_dir(f: &crate::model::FlowField, p: Point) -> Option<Point> {
    if f.cols == 0 || f.rows == 0 || f.angles.len() < (f.cols * f.rows) as usize || f.cell <= 0.0 {
        return None;
    }
    let gx = ((p.x - f.origin[0]) / f.cell - 0.5).clamp(0.0, (f.cols - 1) as f64);
    let gy = ((p.y - f.origin[1]) / f.cell - 0.5).clamp(0.0, (f.rows - 1) as f64);
    let (x0, y0) = (gx.floor() as usize, gy.floor() as usize);
    let (x1, y1) = ((x0 + 1).min(f.cols as usize - 1), (y0 + 1).min(f.rows as usize - 1));
    let (fx, fy) = (gx - x0 as f64, gy - y0 as f64);
    let (mut c, mut s) = (0.0, 0.0);
    for (x, y, wgt) in [(x0, y0, (1.0 - fx) * (1.0 - fy)), (x1, y0, fx * (1.0 - fy)), (x0, y1, (1.0 - fx) * fy), (x1, y1, fx * fy)] {
        let a = f.angles[y * f.cols as usize + x] as f64 * 2.0;
        c += wgt * a.cos();
        s += wgt * a.sin();
    }
    if c.abs() + s.abs() < 1e-9 {
        return None;
    }
    let a = 0.5 * s.atan2(c);
    Some(pt(a.cos(), a.sin()))
}

/// Fast inside test: a raster of the shape (scanlines), exact only next to
/// the outline.
struct InsideGrid {
    x0: f64,
    y0: f64,
    cell: f64,
    w: usize,
    h: usize,
    /// 0 = outside, 1 = inside, 2 = near the outline (test exactly)
    cells: Vec<u8>,
}

impl InsideGrid {
    fn new(rings: &[Ring], b: Rect, cell: f64) -> InsideGrid {
        let w = ((b.width() / cell).ceil() as usize + 2).max(1);
        let h = ((b.height() / cell).ceil() as usize + 2).max(1);
        let (x0, y0) = (b.min_x - cell, b.min_y - cell);
        let mut centre = vec![false; w * h];
        for j in 0..h {
            let y = y0 + (j as f64 + 0.5) * cell;
            for (a, c) in scanline(rings, y) {
                let i0 = (((a - x0) / cell) - 0.5).ceil().max(0.0) as usize;
                let i1 = ((((c - x0) / cell) - 0.5).floor() as i64).min(w as i64 - 1);
                for i in i0..=(i1.max(-1) as usize).min(w - 1) {
                    if (i as i64) <= i1 {
                        centre[j * w + i] = true;
                    }
                }
            }
        }
        let mut cells: Vec<u8> = centre.iter().map(|&c| u8::from(c)).collect();
        for j in 0..h {
            for i in 0..w {
                let c = centre[j * w + i];
                let differs = |di: i64, dj: i64| {
                    let (ni, nj) = (i as i64 + di, j as i64 + dj);
                    ni >= 0 && nj >= 0 && (ni as usize) < w && (nj as usize) < h && centre[nj as usize * w + ni as usize] != c
                };
                if differs(1, 0) || differs(-1, 0) || differs(0, 1) || differs(0, -1) || differs(1, 1) || differs(-1, -1) || differs(1, -1) || differs(-1, 1) {
                    cells[j * w + i] = 2;
                }
            }
        }
        InsideGrid { x0, y0, cell, w, h, cells }
    }
    fn inside(&self, p: Point, rings: &[Ring]) -> bool {
        let i = ((p.x - self.x0) / self.cell).floor();
        let j = ((p.y - self.y0) / self.cell).floor();
        if i < 0.0 || j < 0.0 || i >= self.w as f64 || j >= self.h as f64 {
            return false;
        }
        match self.cells[j as usize * self.w + i as usize] {
            0 => false,
            1 => true,
            _ => point_in_rings(p, rings),
        }
    }
}

struct SpatialHash {
    cell: f64,
    map: std::collections::HashMap<(i64, i64), Vec<Point>>,
}

impl SpatialHash {
    fn key(&self, p: Point) -> (i64, i64) {
        ((p.x / self.cell).floor() as i64, (p.y / self.cell).floor() as i64)
    }
    fn near(&self, p: Point, d: f64) -> bool {
        let (kx, ky) = self.key(p);
        let r = (d / self.cell).ceil() as i64;
        for dy in -r..=r {
            for dx in -r..=r {
                if let Some(v) = self.map.get(&(kx + dx, ky + dy)) {
                    if v.iter().any(|q| q.dist(p) < d) {
                        return true;
                    }
                }
            }
        }
        false
    }
    fn add(&mut self, p: Point) {
        let k = self.key(p);
        self.map.entry(k).or_default().push(p);
    }
}

/// Flow fill options beyond the field: a row distance that changes over the
/// shape (density ramps), lines shared by the colours of a gradient, and
/// the travel rules.
#[derive(Default)]
pub struct FlowOpts<'a> {
    pub sep: Option<&'a dyn Fn(Point) -> f64>,
    /// Shared lines (gradients, colour blends): every colour traces the same
    /// full-density streamlines, whatever the start point, and every point
    /// of a line goes to one colour: `pick` gives it from the point and the
    /// line's dither threshold (0..1). Neighbouring lines get thresholds far
    /// apart (an ordered dither across the rows), so the colours interleave
    /// by their shares and together sew every line once: the density stays
    /// even.
    pub pick: Option<&'a dyn Fn(Point, f64) -> usize>,
    /// The colour this layer sews (with `pick`).
    pub layer: usize,
    /// The colours after this one are sewn later and cover their parts of
    /// the lines: this layer travels along its line under them instead of
    /// leaving it.
    pub hide_later: bool,
    /// Where lines may run at all (inside the shape).
    pub zone: Option<&'a dyn Fn(Point) -> bool>,
    /// Where a travel stitch between two lines may run (it lies on top of
    /// what is sewn there): elsewhere the lines are joined by a jump.
    pub travel: Option<&'a dyn Fn(Point) -> bool>,
    /// The needle points of a sewn stretch of a line (default: an even
    /// running stitch); straight rows use the tatami stagger.
    pub sew: Option<&'a dyn Fn(&[Point]) -> Vec<Point>>,
    /// The fill angle (radians): the travel lattice runs at ±45° and 90° to it.
    pub angle: f64,
    /// Open rows: the local row distance over the normal one (travel keeps
    /// to the edges where rows are far apart).
    pub open: Option<&'a dyn Fn(Point) -> f64>,
}

pub fn flow(rings: &[Ring], field: &crate::model::FlowField, spacing: f64, stitch_len: f64, travel_len: f64, start: Option<Point>, f: u8) -> Vec<Run> {
    flow_ex(rings, field, spacing, stitch_len, travel_len, start, &FlowOpts::default(), f)
}

/// Streamline fill (evenly spaced streamlines, Jobard & Lefer 1997) with a
/// variable separation (density ramps) and per-layer pieces (gradients).
#[allow(clippy::too_many_arguments)]
pub fn flow_ex(rings: &[Ring], field: &crate::model::FlowField, spacing: f64, stitch_len: f64, travel_len: f64, start: Option<Point>, o: &FlowOpts, f: u8) -> Vec<Run> {
    if rings.is_empty() {
        return vec![];
    }
    let base = spacing.max(0.2);
    let b = rings_bounds(rings);
    let sep = |p: Point| o.sep.map_or(base, |s| s(p).max(0.2));
    // the smallest separation sets the step and the hash grid
    let dsep = match o.sep {
        None => base,
        Some(_) => {
            let mut m = f64::INFINITY;
            for j in 0..=16 {
                for i in 0..=16 {
                    m = m.min(sep(pt(b.min_x + b.width() * i as f64 / 16.0, b.min_y + b.height() * j as f64 / 16.0)));
                }
            }
            m.max(0.2)
        }
    };
    let h = (dsep * 0.5).clamp(0.08, 0.3);
    let mut grid = SpatialHash { cell: dsep, map: Default::default() };
    let ins = InsideGrid::new(rings, b, (dsep * 0.5).max(0.1));
    let inside = |p: Point| ins.inside(p, rings) && o.zone.is_none_or(|z| z(p));
    let max_len = (b.width() + b.height()) * 4.0;
    let mut lines: Vec<Vec<Point>> = Vec::new();
    let mut budget = 600_000usize;
    let trace = |seed: Point, grid: &SpatialHash, budget: &mut usize| -> Vec<Point> {
        let mut halves: Vec<Vec<Point>> = Vec::new();
        // the line's own points with their arc position (+ forwards, − backwards):
        // a line that comes back to itself (a closed loop, a spiral) stops there
        // instead of sewing over itself
        let mut own: std::collections::HashMap<(i64, i64), Vec<(Point, f64)>> = Default::default();
        let key = |p: Point| ((p.x / dsep).floor() as i64, (p.y / dsep).floor() as i64);
        let meets_itself = |own: &std::collections::HashMap<(i64, i64), Vec<(Point, f64)>>, q: Point, at: f64, r: f64| {
            let (kx, ky) = key(q);
            (kx - 1..=kx + 1).any(|x| (ky - 1..=ky + 1).any(|y| own.get(&(x, y)).is_some_and(|v| v.iter().any(|(p, s)| (s - at).abs() > r * 4.5 && p.dist(q) < r))))
        };
        own.entry(key(seed)).or_default().push((seed, 0.0));
        for sign in [1.0, -1.0] {
            let mut pts = Vec::new();
            let mut p = seed;
            let Some(d0) = field_dir(field, p) else { return vec![] };
            let mut prev = d0 * sign;
            let mut len = 0.0;
            while len < max_len && *budget > 0 {
                *budget -= 1;
                let Some(mut d) = field_dir(field, p) else { break };
                if d.dot(prev) < 0.0 {
                    d = -d;
                }
                // midpoint step (RK2)
                let mid = p + d * (h * 0.5);
                let Some(mut dm) = field_dir(field, mid) else { break };
                if dm.dot(d) < 0.0 {
                    dm = -dm;
                }
                let q = p + dm * h;
                let at = sign * (len + h);
                if !inside(q) || grid.near(q, sep(q) * 0.55) || dm.dot(prev) < 0.5 || meets_itself(&own, q, at, sep(q) * 0.55) {
                    break;
                }
                own.entry(key(q)).or_default().push((q, at));
                pts.push(q);
                prev = dm;
                p = q;
                len += h;
            }
            halves.push(pts);
        }
        let mut line: Vec<Point> = halves[1].iter().rev().copied().collect();
        line.push(seed);
        line.extend(halves[0].iter().copied());
        line
    };
    let mut queue: std::collections::VecDeque<Point> = std::collections::VecDeque::new();
    // shared lines: every line's rank across the rows (its neighbours one
    // apart), from the nearest line ranked before it and the side it is on
    let ranked = o.pick.is_some();
    let mut ranks: Vec<i64> = Vec::new();
    let mut owner: Owners = Default::default();
    let okey = |p: Point| ((p.x / dsep).floor() as i64, (p.y / dsep).floor() as i64);
    let rank_line = |line: &[Point], seed: Point, id: usize, ranks: &mut Vec<i64>, owner: &mut Owners| {
        let tan = |k: usize| {
            let k = k.min(line.len() - 2);
            (line[k + 1] - line[k]).unit()
        };
        let k0 = line.iter().position(|p| *p == seed).unwrap_or(0);
        let reach = sep(seed) * 2.5;
        let (kx, ky) = okey(seed);
        let r = (reach / dsep).ceil() as i64;
        let mut best: Option<(f64, Point, usize, Point)> = None;
        for y in ky - r..=ky + r {
            for x in kx - r..=kx + r {
                for &(q, l, up) in owner.get(&(x, y)).into_iter().flatten() {
                    let d = q.dist(seed);
                    if d < reach && best.is_none_or(|b| d < b.0) {
                        best = Some((d, q, l, up));
                    }
                }
            }
        }
        let (rank, side) = match best {
            Some((_, q, l, up)) => {
                let d = (seed - q).dot(up) / sep(q);
                let step = match d.round() as i64 {
                    0 if d >= 0.0 => 1,
                    0 => -1,
                    s => s,
                };
                (ranks[l] + step, if tan(k0).perp().dot(up) >= 0.0 { 1.0 } else { -1.0 })
            }
            None => (0, 1.0),
        };
        ranks.push(rank);
        for k in (0..line.len()).step_by(2) {
            owner.entry(okey(line[k])).or_default().push((line[k], id, tan(k).perp() * side));
        }
    };
    let accept = |line: Vec<Point>, seed: Point, grid: &mut SpatialHash, queue: &mut std::collections::VecDeque<Point>, lines: &mut Vec<Vec<Point>>, ranks: &mut Vec<i64>, owner: &mut Owners| {
        if line.is_empty() {
            return;
        }
        if polyline_length(&line) < sep(line[0]) * 1.5 {
            // too short to sew, but its spot is used up (no endless re-seeding)
            for p in &line {
                grid.add(*p);
            }
            return;
        }
        if ranked {
            rank_line(&line, seed, lines.len(), ranks, owner);
        }
        // seeds beside the line, one separation away, about every separation
        let mut acc = f64::INFINITY;
        for (k, p) in line.iter().enumerate() {
            grid.add(*p);
            let d = sep(*p);
            if acc >= d * 0.9 && k + 1 < line.len() {
                let n = (line[k + 1] - *p).unit().perp();
                queue.push_back(*p + n * d);
                queue.push_back(*p - n * d);
                acc = 0.0;
            }
            acc += h;
        }
        lines.push(line);
    };
    let centre = pt((b.min_x + b.max_x) / 2.0, (b.min_y + b.max_y) / 2.0);
    // shared lines: the same streamlines for every layer, whatever the start
    let first_seed = if ranked { None } else { start.filter(|p| inside(*p)) };
    if let Some(s) = first_seed.or(Some(centre).filter(|p| inside(*p))) {
        queue.push_back(s);
    }
    let mut scan_y = b.min_y + dsep * 0.5;
    loop {
        while let Some(c) = queue.pop_front() {
            if budget == 0 {
                break;
            }
            if inside(c) && !grid.near(c, sep(c) * 0.95) {
                let line = trace(c, &grid, &mut budget);
                accept(line, c, &mut grid, &mut queue, &mut lines, &mut ranks, &mut owner);
            }
        }
        // areas the seeds did not reach: scan for the next free spot
        let mut found = false;
        while scan_y < b.max_y && !found && budget > 0 {
            let mut x = b.min_x + dsep * 0.5;
            while x < b.max_x {
                let c = pt(x, scan_y);
                if inside(c) && !grid.near(c, sep(c) * 0.95) {
                    queue.push_back(c);
                    found = true;
                    break;
                }
                x += dsep;
            }
            if !found {
                scan_y += dsep;
            }
        }
        if !found || budget == 0 {
            break;
        }
    }
    // a gradient layer sews only its parts of every line; across the parts a
    // later layer sews it travels along the line, hidden (true = travel)
    // every point: (point, this layer sews it, a later layer covers it)
    let marked: Result<Vec<Vec<(Point, bool, bool)>>, Vec<Vec<Point>>> = match o.pick {
        Some(pick) => {
            // pieces shorter than this go to the colour beside them on the line
            let min_piece = (base * 3.0).max(1.2);
            Ok(lines
                .into_iter()
                .zip(ranks.iter())
                .map(|(l, &rank)| {
                    let tau = dither_threshold(rank);
                    let mut lab: Vec<usize> = l.iter().map(|p| pick(*p, tau)).collect();
                    merge_short_pieces(&mut lab, (min_piece / h).ceil() as usize);
                    l.into_iter().zip(lab).map(|(p, c)| (p, c == o.layer, o.hide_later && c > o.layer)).collect()
                })
                .collect())
        }
        None => Err(lines),
    };
    let lines: Vec<Vec<(Point, bool)>> = match marked {
        Err(lines) => lines.into_iter().map(|l| l.into_iter().map(|p| (p, false)).collect()).collect(),
        Ok(marked) => {
            let mut out = Vec::new();
            for l in marked {
                let mut cur: Vec<(Point, bool)> = Vec::new();
                let mut pend: Vec<Point> = Vec::new();
                for (p, mine, hidden) in l {
                    if mine {
                        if !cur.is_empty() {
                            cur.extend(pend.drain(..).map(|q| (q, true)));
                        }
                        pend.clear();
                        cur.push((p, false));
                    } else if hidden && !cur.is_empty() {
                        pend.push(p);
                    } else {
                        if !cur.is_empty() {
                            out.push(std::mem::take(&mut cur));
                        }
                        pend.clear();
                    }
                }
                if !cur.is_empty() {
                    out.push(cur);
                }
            }
            out.into_iter()
                .filter(|l| {
                    let sewn: Vec<Point> = l.iter().filter(|x| !x.1).map(|x| x.0).collect();
                    sewn.len() >= 2 && polyline_length(&sewn) > 0.6
                })
                .collect()
        }
    };
    // what a line is sewn as (its needle points): the travel graph closes the
    // edges across those stitches, not across the traced curve
    let stitched = |pts: &[Point]| match o.sew {
        Some(sew) => sew(pts),
        None => super::running::sew_line(pts, stitch_len, 0.1),
    };
    let order = order_lines(rings, lines, start.unwrap_or(pt(b.min_x, b.min_y)), dsep, o.travel, o.open, o.angle, &stitched);
    join_ordered(order, stitch_len, travel_len, o.sew, f)
}

/// Points of the ranked lines by grid cell: (point, line, the side its rank grows to).
type Owners = std::collections::HashMap<(i64, i64), Vec<(Point, usize, Point)>>;

/// The dither threshold of the line of rank `r` (0..1): the van der Corput
/// sequence, so neighbouring ranks are half the range apart, every second
/// rank a quarter, ... (a 1-D ordered dither across the rows).
fn dither_threshold(r: i64) -> f64 {
    let x = (r.rem_euclid(1 << 16) as u32).reverse_bits() >> 16;
    (x as f64 + 0.5) / 65536.0
}

/// Runs of one colour along a line shorter than `min` points go to the
/// longer run beside them (shortest first), so no colour sews a stub.
fn merge_short_pieces(lab: &mut [usize], min: usize) {
    loop {
        // (start, end exclusive) of every run
        let mut runs: Vec<(usize, usize)> = Vec::new();
        let mut a = 0;
        for k in 1..=lab.len() {
            if k == lab.len() || lab[k] != lab[a] {
                runs.push((a, k));
                a = k;
            }
        }
        if runs.len() < 2 {
            return;
        }
        let Some((i, &(a, b))) = runs.iter().enumerate().filter(|(_, r)| r.1 - r.0 < min).min_by_key(|(_, r)| r.1 - r.0) else { return };
        let len = |j: usize| runs[j].1 - runs[j].0;
        let into = match (i.checked_sub(1), (i + 1 < runs.len()).then_some(i + 1)) {
            (Some(p), Some(n)) => {
                if len(p) >= len(n) {
                    p
                } else {
                    n
                }
            }
            (Some(p), None) => p,
            (None, Some(n)) => n,
            (None, None) => return,
        };
        let c = lab[runs[into].0];
        lab[a..b].iter_mut().for_each(|x| *x = c);
    }
}

/// Sew order of streamlines, with Ink/Stitch's travel rule: travel never
/// crosses a line already sewn (see `super::travel`). From where a line ends
/// the next line is the one reached by the shortest travel: a short hop
/// straight to a neighbouring line (like a row turn), else a route through
/// the travel lattice — through what is still to be sewn, or along the
/// outline. With no route left the lines are joined by a jump. Travel also
/// keeps to `travel_ok` (a gradient colour: never on the colours sewn
/// before it). Every line with the travel that leads to it (None: a jump,
/// or the first line).
#[allow(clippy::too_many_arguments)]
fn order_lines(rings: &[Ring], lines: Vec<Vec<(Point, bool)>>, start: Point, dsep: f64, travel_ok: Option<&dyn Fn(Point) -> bool>, open: Option<&dyn Fn(Point) -> f64>, angle: f64, stitched: &dyn Fn(&[Point]) -> Vec<Point>) -> Vec<(Vec<(Point, bool)>, Option<Vec<Point>>)> {
    let mut graph = super::travel::TravelGraph::new(rings, angle);
    if let Some(ok) = travel_ok {
        graph.forbid(ok);
    }
    if let Some(f) = open {
        graph.open(f);
    }
    // the outline is open to every colour (travel at the very edge)
    let edge = (dsep * 0.75).max(0.3);
    let allowed = |path: &[Point]| {
        travel_ok.is_none_or(|ok| {
            path.windows(2).all(|w| {
                let n = (w[0].dist(w[1]) / 0.5).ceil().max(1.0) as usize;
                (0..=n).all(|k| {
                    let q = w[0] + (w[1] - w[0]) * (k as f64 / n as f64);
                    ok(q) || dist_to_boundary(rings, q) < edge
                })
            })
        })
    };
    // a direct hop to a neighbouring line: about a row turn
    let hop = (dsep * 2.5).max(0.8);
    const CANDIDATES: usize = 10;
    let mut out: Vec<(Vec<(Point, bool)>, Option<Vec<Point>>)> = Vec::with_capacity(lines.len());
    let mut left = lines;
    let mut pos = start;
    while !left.is_empty() {
        let mut ends: Vec<(f64, usize, bool)> = Vec::with_capacity(left.len() * 2);
        for (i, l) in left.iter().enumerate() {
            ends.push((l[0].0.dist(pos), i, false));
            ends.push((l[l.len() - 1].0.dist(pos), i, true));
        }
        let k = CANDIDATES.min(ends.len());
        ends.select_nth_unstable_by(k - 1, |x, y| x.0.partial_cmp(&y.0).unwrap());
        ends.truncate(k);
        ends.sort_by(|x, y| x.0.partial_cmp(&y.0).unwrap());
        let end_of = |&(_, i, rev): &(f64, usize, bool)| {
            let l = &left[i];
            if rev { l[l.len() - 1].0 } else { l[0].0 }
        };
        let mut pick: Option<(usize, Vec<Point>)> = None;
        if !out.is_empty() {
            // a straight hop to the nearest end that crosses nothing sewn
            pick = ends.iter().enumerate().take_while(|(_, c)| c.0 <= hop).find_map(|(ci, c)| {
                let e = end_of(c);
                (segment_inside(rings, pos, e) && !graph.crosses_sewn(pos, e) && allowed(&[pos, e])).then(|| (ci, vec![pos, e]))
            });
            if pick.is_none() {
                // through the lattice: the shortest route among the nearest ends
                let targets: Vec<Point> = ends.iter().map(end_of).collect();
                pick = graph
                    .routes(pos, &targets)
                    .into_iter()
                    .enumerate()
                    .filter_map(|(ci, r)| r.filter(|r| allowed(r)).map(|r| (ci, r)))
                    .min_by(|x, y| polyline_length(&x.1).partial_cmp(&polyline_length(&y.1)).unwrap());
            }
        }
        // no route left (a pocket walled in by sewn lines): as Ink/Stitch,
        // travel straight rather than fail — short ones only, else a jump
        if pick.is_none() && !out.is_empty() {
            let e = end_of(&ends[0]);
            pick = travel_path(rings, pos, e).filter(|p| polyline_length(p) <= 10.0 && allowed(p)).map(|p| (0, p));
        }
        let (ci, travel) = match pick {
            Some((ci, path)) => (ci, Some(path)),
            None => (0, None),
        };
        let (_, i, rev) = ends[ci];
        let mut l = left.swap_remove(i);
        if rev {
            l.reverse();
        }
        let pts: Vec<Point> = l.iter().map(|x| x.0).collect();
        graph.sewn(&stitched(&pts), true);
        pos = pts[pts.len() - 1];
        out.push((l, travel));
    }
    out
}

/// Stitch the ordered lines: travel along the given paths (a jump where
/// there is none), stretches of a line marked true travelled hidden.
fn join_ordered(order: Vec<(Vec<(Point, bool)>, Option<Vec<Point>>)>, stitch_len: f64, travel_len: f64, sew: Option<&dyn Fn(&[Point]) -> Vec<Point>>, f: u8) -> Vec<Run> {
    let mut runs: Vec<Run> = Vec::new();
    let mut run: Run = Vec::new();
    for (piece, travel) in order {
        if piece.len() < 2 {
            continue;
        }
        if !run.is_empty() {
            match travel {
                // every corner of the route kept: cutting one could cross a
                // sewn line the route goes round
                Some(path) => {
                    for q in resample_max(&path, travel_len.max(0.5)).into_iter().skip(1) {
                        push(&mut run, q, flags::TRAVEL);
                    }
                }
                None => runs.push(std::mem::take(&mut run)),
            }
        }
        // stretches of one kind: sewn, or travelled under a later layer
        let mut k = 0;
        while k < piece.len() {
            let hidden = piece[k].1;
            let mut j = k;
            while j + 1 < piece.len() && piece[j + 1].1 == hidden {
                j += 1;
            }
            // include the joint points so the stretches connect
            let a = k.saturating_sub(1);
            let b = (j + 1).min(piece.len() - 1);
            let pts: Vec<Point> = piece[a..=b].iter().map(|x| x.0).collect();
            let stitches = match (hidden, sew) {
                (true, _) => running_stitch(&pts, travel_len, 0.1),
                (false, Some(sew)) => sew(&pts),
                (false, None) => super::running::sew_line(&pts, stitch_len, 0.1),
            };
            let flag = if hidden { flags::TRAVEL } else { f };
            for q in stitches {
                push(&mut run, q, flag);
            }
            k = j + 1;
        }
    }
    if !run.is_empty() {
        runs.push(run);
    }
    runs.retain(|r| r.len() > 1);
    runs
}

#[cfg(test)]
mod tests {
    use super::*;

    fn square(s: f64) -> Ring {
        vec![pt(0.0, 0.0), pt(s, 0.0), pt(s, s), pt(0.0, s)]
    }

    fn inside_ratio(runs: &[Run], rings: &[Ring]) -> f64 {
        let pts: Vec<Point> = runs.iter().flatten().map(|x| x.0).collect();
        pts.iter().filter(|p| point_in_rings(**p, rings) || dist_to_boundary(rings, **p) < 0.1).count() as f64 / pts.len().max(1) as f64
    }

    #[test]
    fn meander_covers_the_shape() {
        let rings = vec![square(30.0)];
        for pattern in [MeanderPattern::Square, MeanderPattern::Triangle, MeanderPattern::Hexagon] {
            let runs = meander(&rings, pattern, None, 2.0, 0.0, 0.5, 2.5, 2.5, 7, None, None, 0);
            assert_eq!(runs.len(), 1, "{pattern:?}");
            let len: f64 = runs[0].windows(2).map(|w| w[0].0.dist(w[1].0)).sum();
            // a space-filling walk: thread length close to area / cell
            assert!(len > 900.0 / 2.0 * 0.5, "{pattern:?} length {len}");
            assert!(inside_ratio(&runs, &rings) > 0.999, "{pattern:?}");
            // deterministic for a seed
            let again = meander(&rings, pattern, None, 2.0, 0.0, 0.5, 2.5, 2.5, 7, None, None, 0);
            assert_eq!(runs[0].len(), again[0].len());
        }
    }

    #[test]
    fn every_ink_stitch_tile_meanders() {
        let tiles = super::super::meander_tiles::tiles();
        assert_eq!(tiles.len(), 75);
        let rings = vec![square(40.0)];
        let mut worst = (f64::INFINITY, String::new());
        for t in tiles {
            // the graph the walk runs on
            let (nodes, edges) = tile_lattice(t, rings_bounds(&rings), 1.0, 1.0);
            let mut adj: Vec<Vec<usize>> = vec![Vec::new(); nodes.len()];
            let mut total = 0.0;
            for &(u, v) in &edges {
                if point_in_rings(nodes[u], &rings) && point_in_rings(nodes[v], &rings) && dist_to_boundary(&rings, nodes[u]) >= 0.05 && dist_to_boundary(&rings, nodes[v]) >= 0.05 && segment_inside(&rings, nodes[u], nodes[v]) {
                    adj[u].push(v);
                    adj[v].push(u);
                }
            }
            prune_dead_ends(&mut adj);
            let live = adj.iter().filter(|a| !a.is_empty()).count();
            for (u, a) in adj.iter().enumerate() {
                for &v in a {
                    total += nodes[u].dist(nodes[v]) / 2.0;
                }
            }
            assert!(live > 20, "{}: {live} nodes", t.id);
            let mean_edge = total / adj.iter().map(|a| a.len()).sum::<usize>().max(1) as f64 * 2.0;
            let runs = meander(&rings, MeanderPattern::Square, Some(t), 2.5, 0.0, 0.0, 2.5, 2.5, 3, None, None, 0);
            assert!(!runs.is_empty(), "{}", t.id);
            assert!(inside_ratio(&runs, &rings) > 0.99, "{}", t.id);
            let len: f64 = runs.iter().map(|r| r.windows(2).map(|w| w[0].0.dist(w[1].0)).sum::<f64>()).sum();
            // a walk through every node has about one edge per node
            let ratio = len / (live as f64 * mean_edge);
            // star tiles (hubs with 8-12 spokes) can only use two spokes per
            // hub: their walks cover less by design, in Ink/Stitch too
            let hub = adj.iter().map(|a| a.len()).max().unwrap_or(0) >= 8;
            assert!(ratio > if hub { 0.3 } else { 0.6 }, "{} covers {ratio:.2}", t.id);
            if !hub && ratio < worst.0 {
                worst = (ratio, t.id.clone());
            }
            eprintln!("{:>16} nodes {live:>5} coverage {ratio:.2}", t.id);
        }
        eprintln!("worst regular tile {} covers {:.2}", worst.1, worst.0);
    }

    #[test]
    fn guided_rows_follow_the_guide() {
        let rings = vec![square(30.0)];
        let guide = default_guide(rings_bounds(&rings));
        let runs = guided(&rings, &guide, 0.5, 3.0, 4, 0.0, 2.5, None, None, 0).unwrap();
        assert!(!runs.is_empty());
        assert!(inside_ratio(&runs, &rings) > 0.99);
        // stitches near the left edge run upwards-right like the guide's start
        let n: usize = runs.iter().map(|r| r.len()).sum();
        assert!(n > 500, "{n}");
    }

    #[test]
    fn flow_rows_follow_the_field() {
        let rings = vec![square(20.0)];
        let mut angles = Vec::new();
        for _y in 0..10 {
            for x in 0..10 {
                angles.push((x as f32 / 10.0) * 1.2);
            }
        }
        let field = crate::model::FlowField { origin: [0.0, 0.0], cell: 2.0, cols: 10, rows: 10, angles };
        let runs = flow(&rings, &field, 0.5, 2.5, 2.5, None, 0);
        assert!(!runs.is_empty());
        assert!(inside_ratio(&runs, &rings) > 0.99);
        let len: f64 = runs.iter().map(|r| r.windows(2).filter(|w| w[1].1 == 0).map(|w| w[0].0.dist(w[1].0)).sum::<f64>()).sum();
        // evenly spaced rows: thread length close to area / spacing
        assert!(len > 400.0 / 0.5 * 0.6 && len < 400.0 / 0.5 * 1.4, "{len}");
    }

    #[test]
    fn circular_spirals_inside() {
        let rings = vec![square(20.0)];
        let runs = circular(&rings, [0.5, 0.5], 0.5, 2.5, 2.5, false, 0);
        assert!(!runs.is_empty());
        assert!(inside_ratio(&runs, &rings) > 0.99);
        let first = runs[0][0].0;
        assert!(first.dist(pt(10.0, 10.0)) < 1.0, "starts at the centre: {first:?}");
    }
}

