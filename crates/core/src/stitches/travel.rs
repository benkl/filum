//! Travel routing inside a fill, after Ink/Stitch's tatami fill
//! (`lib/stitches/tatami_fill.py`: `build_travel_graph`, `build_travel_edges`,
//! `process_travel_edges`, `path_to_stitches`).
//!
//! * The shape is covered with a lattice of travel edges at +45°, −45° and
//!   +90° to the rows — never along them, so a travel does not read as a row
//!   (Ink/Stitch: three gratings, 2 mm and √2 mm apart, half that in small
//!   shapes). Where the lattice meets the outline it is joined to it.
//! * Weights as in Ink/Stitch: an outline edge costs 3 × its length; an
//!   interior edge its length divided by its distance from the outline
//!   (+ 0.1 px), so travel keeps to the middle of the shape, where the rows
//!   sewn later cover it.
//! * Hard rule: once a row (or a streamline) is sewn, every travel edge that
//!   crosses it is removed — a later travel never lies on it. With no route
//!   left the caller jumps.
//! * Open rows (a weak blended colour, the sparse end of a density ramp):
//!   travel inside shows through them, so interior edges cost more with the
//!   square of the local row distance, and above about 2.5 × the normal
//!   spacing the outline wins — travel on the edges (trapunto) for open
//!   stitching. The outline stays open to every colour.
//! * A sewn line becomes a travel path itself: travel along it lies on the
//!   same thread and hardly shows. That reaches the pockets streamlines leave
//!   between sewn lines (rows of a tatami always end at the outline; streamlines
//!   can end inside, closer to their neighbours than the lattice is fine).

use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashMap};

use crate::geom::*;

/// Ink/Stitch works in pixels (96 dpi).
const PX: f64 = 96.0 / 25.4;

#[derive(Clone, Copy)]
struct Edge {
    a: u32,
    b: u32,
    w: f64,
    alive: bool,
    /// along the outline (always allowed, see `forbid`; never reweighted)
    outline: bool,
}

pub struct TravelGraph {
    rings: Vec<Ring>,
    pts: Vec<Point>,
    adj: Vec<Vec<(u32, u32)>>,
    edges: Vec<Edge>,
    cell: f64,
    /// edges by grid cell (for removing those a sewn segment crosses)
    egrid: HashMap<(i64, i64), Vec<u32>>,
    /// lattice and outline nodes by grid cell (for joining a point to the lattice)
    ngrid: HashMap<(i64, i64), Vec<u32>>,
    /// nodes on sewn lines by grid cell
    lgrid: HashMap<(i64, i64), Vec<u32>>,
    /// sewn segments by grid cell (joins to the lattice must not cross them)
    sewn: HashMap<(i64, i64), Vec<(Point, Point)>>,
    /// lattice step (mm)
    step: f64,
    /// open rows: interior cost factor sampled on the node grid (see `open`)
    open: Option<(Point, f64, usize, usize, Vec<f32>)>,
    /// nodes on sewn lines (see `sewn`), as opposed to lattice and outline nodes
    on_line: Vec<bool>,
    /// outline segments by grid cell (quick inside tests for short joins)
    rgrid: HashMap<(i64, i64), Vec<(Point, Point)>>,
    /// distance to the outline (interior weights)
    bdist: BoundaryDist,
}

/// Cost of an interior stretch (Ink/Stitch: length / (distance to outline + 0.1 px)).
fn interior_weight(outline: &BoundaryDist, a: Point, b: Point) -> f64 {
    a.dist(b) / (outline.dist(a.lerp(b, 0.5)) + 0.1 / PX)
}

impl TravelGraph {
    /// The travel graph of a shape whose rows run at `angle` (radians, the
    /// rotation that lays the rows horizontal: frame = p.rotate(angle)).
    pub fn new(rings: &[Ring], angle: f64) -> TravelGraph {
        crate::prof!("travel: TravelGraph::new");
        let rr = rotate_rings(rings, angle);
        let b = rings_bounds(&rr);
        // Ink/Stitch: denser grid in small shapes (area < 10000 px²)
        let area = rings_area(rings).abs() * PX * PX;
        let step = if area < 10000.0 { 0.5 } else { 1.0 } * std::f64::consts::SQRT_2;
        let mut g = TravelGraph {
            rings: rings.to_vec(),
            pts: Vec::new(),
            adj: Vec::new(),
            edges: Vec::new(),
            cell: step * 2.0,
            egrid: HashMap::new(),
            ngrid: HashMap::new(),
            lgrid: HashMap::new(),
            sewn: HashMap::new(),
            step,
            open: None,
            on_line: Vec::new(),
            rgrid: HashMap::new(),
            bdist: BoundaryDist::new(rings),
        };
        for ring in rings {
            let n = ring.len();
            for k in 0..n {
                let (a, c) = (ring[k], ring[(k + 1) % n]);
                for cell in g.cells(a, c) {
                    g.rgrid.entry(cell).or_default().push((a, c));
                }
            }
        }
        if !(b.width() > 0.0 && b.height() > 0.0) {
            return g;
        }
        let back = |q: Point| q.rotate(-angle);
        // lattice nodes (i·s, j·s) with i + j even: the ±45° diagonals and the
        // vertical (90°) lines all pass through them
        let (i0, i1) = ((b.min_x / step).floor() as i64 - 1, (b.max_x / step).ceil() as i64 + 1);
        let (j0, j1) = ((b.min_y / step).floor() as i64 - 1, (b.max_y / step).ceil() as i64 + 1);
        let mut node_at: HashMap<(i64, i64), u32> = HashMap::new();
        for j in j0..=j1 {
            for i in i0..=i1 {
                if (i + j).rem_euclid(2) != 0 {
                    continue;
                }
                let q = pt(i as f64 * step, j as f64 * step);
                if point_in_rings(q, &rr) {
                    node_at.insert((i, j), g.add_node(back(q)));
                }
            }
        }
        // where the lattice leaves the shape: a node on the outline
        // (ring index, edge index, t) for chaining the outline
        let mut on_ring: Vec<Vec<(usize, f64, u32)>> = vec![Vec::new(); rings.len()];
        let mut keys: Vec<(i64, i64)> = node_at.keys().copied().collect();
        keys.sort_unstable();
        for (i, j) in keys {
            let a = node_at[&(i, j)];
            let qa = pt(i as f64 * step, j as f64 * step);
            for (di, dj) in [(1, 1), (1, -1), (0, 2), (-1, 1), (-1, -1), (0, -2)] {
                let (ni, nj) = (i + di, j + dj);
                let qb = pt(ni as f64 * step, nj as f64 * step);
                match node_at.get(&(ni, nj)) {
                    // both inside: once per pair
                    Some(&bn) if (ni, nj) > (i, j) => {
                        if segment_inside(&rr, qa, qb) {
                            let w = interior_weight(&g.bdist, g.pts[a as usize], g.pts[bn as usize]);
                            g.add_edge(a, bn, w);
                        }
                    }
                    Some(_) => {}
                    // towards the outside: stop at the outline
                    None => {
                        let mut hit: Option<(f64, usize, usize, f64)> = None;
                        for (ri, ring) in rr.iter().enumerate() {
                            let n = ring.len();
                            for k in 0..n {
                                if let Some((t, _)) = segment_intersection(qa, qb, ring[k], ring[(k + 1) % n]) {
                                    let u = {
                                        let e = ring[(k + 1) % n] - ring[k];
                                        let l2 = e.length_sq().max(1e-18);
                                        ((qa + (qb - qa) * t - ring[k]).dot(e) / l2).clamp(0.0, 1.0)
                                    };
                                    if t > 1e-9 && hit.is_none_or(|h| t < h.0) {
                                        hit = Some((t, ri, k, u));
                                    }
                                }
                            }
                        }
                        if let Some((t, ri, k, u)) = hit {
                            let q = qa + (qb - qa) * t;
                            let bn = g.add_node(back(q));
                            let w = interior_weight(&g.bdist, g.pts[a as usize], g.pts[bn as usize]);
                            g.add_edge(a, bn, w);
                            on_ring[ri].push((k, u, bn));
                        }
                    }
                }
            }
        }
        // the outline: ring vertices and the lattice's outline nodes in order
        for (ri, ring) in rings.iter().enumerate() {
            let n = ring.len();
            if n < 2 {
                continue;
            }
            let mut chain: Vec<(usize, f64, u32)> = (0..n).map(|k| (k, 0.0, u32::MAX)).collect();
            chain.extend(on_ring[ri].iter().copied());
            chain.sort_by(|x, y| (x.0, x.1).partial_cmp(&(y.0, y.1)).unwrap());
            let ids: Vec<u32> = chain.iter().map(|&(k, _, id)| if id == u32::MAX { g.add_node(ring[k]) } else { id }).collect();
            for w in 0..ids.len() {
                let (a, c) = (ids[w], ids[(w + 1) % ids.len()]);
                let l = g.pts[a as usize].dist(g.pts[c as usize]);
                if l > 1e-9 {
                    g.add_edge(a, c, 3.0 * l * PX);
                    let last = g.edges.len() - 1;
                    g.edges[last].outline = true;
                }
            }
        }
        g
    }

    fn key(&self, p: Point) -> (i64, i64) {
        ((p.x / self.cell).floor() as i64, (p.y / self.cell).floor() as i64)
    }

    /// Every grid cell a segment touches: the boxes of its pieces of at most
    /// half a cell (sampling points alone misses a cell whose corner it clips).
    fn cells(&self, a: Point, b: Point) -> Vec<(i64, i64)> {
        let n = (a.dist(b) / (self.cell * 0.5)).ceil().max(1.0) as usize;
        let mut out: Vec<(i64, i64)> = Vec::with_capacity(n * 2 + 2);
        let mut prev = a;
        for k in 1..=n {
            let q = a + (b - a) * (k as f64 / n as f64);
            let (k0, k1) = (self.key(prev), self.key(q));
            for x in k0.0.min(k1.0)..=k0.0.max(k1.0) {
                for y in k0.1.min(k1.1)..=k0.1.max(k1.1) {
                    out.push((x, y));
                }
            }
            prev = q;
        }
        out.sort_unstable();
        out.dedup();
        out
    }

    fn add_node(&mut self, p: Point) -> u32 {
        let id = self.pts.len() as u32;
        self.pts.push(p);
        self.adj.push(Vec::new());
        self.on_line.push(false);
        let k = self.key(p);
        self.ngrid.entry(k).or_default().push(id);
        id
    }

    fn add_edge(&mut self, a: u32, b: u32, w: f64) {
        let id = self.edges.len() as u32;
        self.edges.push(Edge { a, b, w, alive: true, outline: false });
        self.adj[a as usize].push((b, id));
        self.adj[b as usize].push((a, id));
        for c in self.cells(self.pts[a as usize], self.pts[b as usize]) {
            self.egrid.entry(c).or_default().push(id);
        }
    }

    /// Remove the interior edges where travel must not go (`ok` false
    /// somewhere along them). The outline stays: travel at the very edge.
    pub fn forbid(&mut self, ok: &dyn Fn(Point) -> bool) {
        for e in self.edges.iter_mut().filter(|e| !e.outline) {
            let (a, b) = (self.pts[e.a as usize], self.pts[e.b as usize]);
            let n = (a.dist(b) / 0.5).ceil().max(1.0) as usize;
            if !(0..=n).all(|k| ok(a + (b - a) * (k as f64 / n as f64))) {
                e.alive = false;
            }
        }
    }

    /// Open rows: `row_factor` is the local row distance over the normal
    /// one (1 = dense). Interior travel costs that squared — through open
    /// rows it shows — so the outline takes over where rows are far apart.
    pub fn open(&mut self, row_factor: &dyn Fn(Point) -> f64) {
        if self.pts.is_empty() {
            return;
        }
        let b = self.pts.iter().fold(Rect::EMPTY, |mut r, p| { r.include(*p); r });
        let cell = self.step;
        let (w, h) = ((b.width() / cell).ceil() as usize + 2, (b.height() / cell).ceil() as usize + 2);
        let o = pt(b.min_x - cell * 0.5, b.min_y - cell * 0.5);
        let mut v = Vec::with_capacity(w * h);
        for j in 0..h {
            for i in 0..w {
                v.push(row_factor(pt(o.x + i as f64 * cell, o.y + j as f64 * cell)).clamp(1.0, 10.0) as f32);
            }
        }
        self.open = Some((o, cell, w, h, v));
        for k in 0..self.edges.len() {
            let e = self.edges[k];
            if !e.outline {
                let (a, b) = (self.pts[e.a as usize], self.pts[e.b as usize]);
                self.edges[k].w = self.opened(e.w, a, b);
            }
        }
    }

    /// The weight of an interior stretch through open rows: Ink/Stitch's
    /// bonus for keeping off the outline assumes rows sewn later cover the
    /// travel, which open rows do not; at 2.5 × the row distance a millimetre
    /// inside costs what one along the outline does, beyond that more.
    fn opened(&self, w: f64, a: Point, b: Point) -> f64 {
        let f = self.open_at(a.lerp(b, 0.5));
        if f <= 1.05 {
            return w;
        }
        (w * f * f).max(a.dist(b) * 3.0 * PX * (f / 2.5).powi(2))
    }

    fn open_at(&self, p: Point) -> f64 {
        match &self.open {
            None => 1.0,
            Some((o, cell, w, h, v)) => {
                let i = (((p.x - o.x) / cell).round().max(0.0) as usize).min(w - 1);
                let j = (((p.y - o.y) / cell).round().max(0.0) as usize).min(h - 1);
                v[j * w + i] as f64
            }
        }
    }

    /// A row or line was sewn: no travel may cross it any more. With `walk`,
    /// travel may also run along it (streamlines; tatami rows always end at
    /// the outline and need not).
    pub fn sewn(&mut self, line: &[Point], walk: bool) {
        for w in line.windows(2) {
            let (a, b) = (w[0], w[1]);
            for c in self.cells(a, b) {
                if let Some(ids) = self.egrid.get(&c) {
                    for &id in ids {
                        let e = self.edges[id as usize];
                        if e.alive && segments_intersect(a, b, self.pts[e.a as usize], self.pts[e.b as usize]) {
                            self.edges[id as usize].alive = false;
                        }
                    }
                }
                self.sewn.entry(c).or_default().push((a, b));
            }
        }
        // the line as a travel path: nodes about 2 mm apart, joined along it
        // and to the nearest lattice nodes reached across nothing sewn
        if !walk || line.len() < 2 {
            return;
        }
        let cum = cumulative_lengths(line);
        let total = cum[cum.len() - 1];
        let n = (total / 2.0).ceil().max(1.0) as usize;
        let ids: Vec<u32> = (0..=n)
            .map(|k| {
                let id = self.add_node(point_at(line, &cum, total * k as f64 / n as f64));
                self.on_line[id as usize] = true;
                // move it from the lattice grid to the line grid
                let key = self.key(self.pts[id as usize]);
                if let Some(v) = self.ngrid.get_mut(&key) {
                    v.retain(|x| *x != id);
                }
                self.lgrid.entry(key).or_default().push(id);
                id
            })
            .collect();
        for w in ids.windows(2) {
            let l = self.pts[w[0] as usize].dist(self.pts[w[1] as usize]);
            self.add_edge(w[0], w[1], l);
        }
        let reach = self.step * 2.5;
        // joined to the lattice at its ends and about every 8 mm (pockets
        // between lines are at line ends; the rest is reached along the line)
        let every = 4;
        let last = ids.len() - 1;
        for (k, &id) in ids.iter().enumerate() {
            if k != 0 && k != last && k % every != 0 {
                continue;
            }
            let p = self.pts[id as usize];
            let (kx, ky) = self.key(p);
            let r = (reach / self.cell).ceil() as i64;
            let mut near: Vec<(f64, u32)> = Vec::new();
            for y in ky - r..=ky + r {
                for x in kx - r..=kx + r {
                    if let Some(v) = self.ngrid.get(&(x, y)) {
                        near.extend(v.iter().map(|&o| (self.pts[o as usize].dist(p), o)));
                    }
                }
            }
            near.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
            let mut joined = 0;
            for (d, o) in near {
                if joined == 3 || d > reach {
                    break;
                }
                let q = self.pts[o as usize];
                if d < 1e-9 || self.adj[o as usize].iter().all(|(_, e)| !self.edges[*e as usize].alive) {
                    continue;
                }
                if self.join_inside(p, q, true) && !self.crosses_sewn(p, q) {
                    joined += 1;
                    let w = self.opened(interior_weight(&self.bdist, p, q).max(d), p, q);
                    self.add_edge(id, o, w);
                }
            }
        }
    }

    /// A short straight join: inside when it crosses no outline segment
    /// (looked up near it only) and, unless `a` is known to be inside (a
    /// point on a sewn line), its middle is inside.
    fn join_inside(&self, a: Point, b: Point, a_inside: bool) -> bool {
        self.cells(a, b).iter().all(|c| self.rgrid.get(c).is_none_or(|v| v.iter().all(|(p, q)| !segments_intersect(a, b, *p, *q))))
            && (a_inside || point_in_rings(a.lerp(b, 0.5), &self.rings))
    }

    /// Does the straight segment a–b cross a sewn row or line?
    pub fn crosses_sewn(&self, a: Point, b: Point) -> bool {
        self.cells(a, b).iter().any(|c| self.sewn.get(c).is_some_and(|v| v.iter().any(|(p, q)| segments_intersect(a, b, *p, *q))))
    }

    /// Lattice nodes a point can be joined to: near, straight inside, across
    /// no sewn line; with the cost of the join.
    fn joins(&self, p: Point) -> Vec<(u32, f64)> {
        let reach = self.step * 2.5;
        let (kx, ky) = self.key(p);
        let r = (reach / self.cell).ceil() as i64;
        let mut out = Vec::new();
        for y in ky - r..=ky + r {
            for x in kx - r..=kx + r {
                let both = self.ngrid.get(&(x, y)).into_iter().chain(self.lgrid.get(&(x, y)));
                for ids in both {
                    for &id in ids {
                        let q = self.pts[id as usize];
                        let d = q.dist(p);
                        if d > reach || self.adj[id as usize].iter().all(|(_, e)| !self.edges[*e as usize].alive) {
                            continue;
                        }
                        if d < 1e-9 || (self.join_inside(p, q, false) && !self.crosses_sewn(p, q)) {
                            out.push((id, self.opened(interior_weight(&self.bdist, p, q).max(d), p, q)));
                        }
                    }
                }
            }
        }
        out
    }

    /// Routes from `from` to the `targets` (cheapest by the travel weights);
    /// for every target its route, or None where none is left.
    pub fn routes(&self, from: Point, targets: &[Point]) -> Vec<Option<Vec<Point>>> {
        crate::prof!("travel: routes (dijkstra)");
        let n = self.pts.len();
        let mut out = vec![None; targets.len()];
        if n == 0 || targets.is_empty() {
            return out;
        }
        let starts = self.joins(from);
        if starts.is_empty() {
            return out;
        }
        let ends: Vec<Vec<(u32, f64)>> = targets.iter().map(|t| self.joins(*t)).collect();
        // which targets end at a node
        let mut wanted: HashMap<u32, Vec<(usize, f64)>> = HashMap::new();
        for (ti, js) in ends.iter().enumerate() {
            for &(id, c) in js {
                wanted.entry(id).or_default().push((ti, c));
            }
        }
        let mut left = ends.iter().filter(|e| !e.is_empty()).count();
        let mut dist = vec![f64::INFINITY; n];
        let mut prev = vec![u32::MAX; n];
        let mut best: Vec<(f64, u32)> = vec![(f64::INFINITY, u32::MAX); targets.len()];
        let mut heap = BinaryHeap::new();
        let key = |d: f64| (d * 1e4) as u64;
        for &(id, c) in &starts {
            if c < dist[id as usize] {
                dist[id as usize] = c;
                heap.push(Reverse((key(c), id)));
            }
        }
        let mut settled = vec![false; n];
        while let Some(Reverse((dk, u))) = heap.pop() {
            let ui = u as usize;
            if settled[ui] || dk > key(dist[ui]) {
                continue;
            }
            settled[ui] = true;
            if let Some(ts) = wanted.get(&u) {
                for &(ti, c) in ts {
                    let tot = dist[ui] + c;
                    if tot < best[ti].0 {
                        if best[ti].1 == u32::MAX {
                            left -= 1;
                        }
                        best[ti] = (tot, u);
                    }
                }
                if left == 0 {
                    break;
                }
            }
            for &(v, e) in &self.adj[ui] {
                let edge = self.edges[e as usize];
                if !edge.alive {
                    continue;
                }
                let nd = dist[ui] + edge.w;
                if nd < dist[v as usize] {
                    dist[v as usize] = nd;
                    prev[v as usize] = u;
                    heap.push(Reverse((key(nd), v)));
                }
            }
        }
        for (ti, &(_, end)) in best.iter().enumerate() {
            if end == u32::MAX {
                continue;
            }
            let mut path = vec![targets[ti]];
            let mut u = end;
            loop {
                path.push(self.pts[u as usize]);
                if prev[u as usize] == u32::MAX {
                    break;
                }
                u = prev[u as usize];
            }
            path.push(from);
            path.reverse();
            dedup(&mut path, 1e-9);
            out[ti] = Some(path);
        }
        out
    }

    /// One route (see `routes`).
    pub fn route(&self, from: Point, to: Point) -> Option<Vec<Point>> {
        self.routes(from, &[to]).pop().flatten()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ring_shape() -> Vec<Ring> {
        let outer: Ring = (0..64).map(|k| { let a = k as f64 / 64.0 * std::f64::consts::TAU; pt(20.0 + 18.0 * a.cos(), 20.0 + 14.0 * a.sin()) }).collect();
        let inner: Ring = (0..32).rev().map(|k| { let a = k as f64 / 32.0 * std::f64::consts::TAU; pt(20.0 + 6.0 * a.cos(), 20.0 + 5.0 * a.sin()) }).collect();
        vec![outer, inner]
    }

    #[test]
    fn routes_stay_inside_and_avoid_sewn_rows() {
        let rings = ring_shape();
        let mut g = TravelGraph::new(&rings, 0.0);
        let (a, b) = (pt(5.0, 20.0), pt(35.0, 20.0));
        let r = g.route(a, b).expect("a route around the hole");
        assert!(r.windows(2).all(|w| segment_inside(&rings, w[0], w[1]) || w[0].dist(w[1]) < 1e-6));
        // sew a row right across the top half: the route must not cross it
        let row = [pt(0.0, 12.0), pt(40.0, 12.0)];
        g.sewn(&row, false);
        let r = g.route(a, b).expect("still a route, below");
        assert!(r.windows(2).all(|w| !segments_intersect(w[0], w[1], row[0], row[1])));
        // a full wall of rows: no route
        for y in [12.0, 20.0, 28.0] {
            g.sewn(&[pt(19.5, 0.0), pt(19.5, 40.0)], false);
            g.sewn(&[pt(0.0, y), pt(40.0, y)], false);
        }
        let blocked = g.route(pt(5.0, 18.0), pt(35.0, 18.0));
        assert!(blocked.is_none_or(|r| r.windows(2).all(|w| !segments_intersect(w[0], w[1], pt(19.5, 0.0), pt(19.5, 40.0)))));
    }

    #[test]
    fn open_rows_send_travel_to_the_edge() {
        let sq: Vec<Ring> = vec![vec![pt(0.0, 0.0), pt(30.0, 0.0), pt(30.0, 30.0), pt(0.0, 30.0)]];
        let mut g = TravelGraph::new(&sq, 0.0);
        g.open(&|_| 6.0);
        let r = g.route(pt(0.5, 1.0), pt(29.5, 29.0)).unwrap();
        let deepest = r.iter().map(|p| dist_to_boundary(&sq, *p)).fold(0.0, f64::max);
        assert!(deepest < 2.5, "open rows: travel along the edge, deepest {deepest}");
    }

    #[test]
    fn travel_keeps_off_the_outline() {
        // a square: from corner region to corner region the route goes through the middle
        let sq: Vec<Ring> = vec![vec![pt(0.0, 0.0), pt(30.0, 0.0), pt(30.0, 30.0), pt(0.0, 30.0)]];
        let g = TravelGraph::new(&sq, 0.0);
        let r = g.route(pt(1.0, 1.0), pt(29.0, 29.0)).unwrap();
        let mid = r.iter().map(|p| dist_to_boundary(&sq, *p)).fold(0.0, f64::max);
        assert!(mid > 5.0, "deepest point {mid}");
    }
}
