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
//! * Hard rule: once a row (or a streamline) is sewn, every interior travel
//!   edge that crosses it is removed — a later travel never lies on it. The
//!   outline stays (as in Ink/Stitch), so every part of the shape stays
//!   reachable; with no route left the caller jumps.
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

use crate::geom::CellMap;

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
    egrid: CellMap<Vec<u32>>,
    /// lattice and outline nodes by grid cell (for joining a point to the lattice)
    ngrid: CellMap<Vec<u32>>,
    /// nodes on sewn lines by grid cell
    lgrid: CellMap<Vec<u32>>,
    /// sewn segments by grid cell (joins to the lattice must not cross them)
    sewn: CellMap<Vec<(Point, Point)>>,
    /// lattice step (mm)
    step: f64,
    /// open rows: interior cost factor sampled on the node grid (see `open`)
    open: Option<(Point, f64, usize, usize, Vec<f32>)>,
    /// nodes on sewn lines (see `sewn`), as opposed to lattice and outline nodes
    on_line: Vec<bool>,
    /// outline segments by grid cell (quick inside tests for short joins)
    rgrid: CellMap<Vec<(Point, Point)>>,
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
        Self::with_outline_nodes(rings, angle, &[]).0
    }

    /// [`TravelGraph::new`] with extra nodes on the outline (row ends: Ink/Stitch
    /// puts the fill graph's nodes in its travel graph), chained into it in
    /// order; returns their node ids.
    pub fn with_outline_nodes(rings: &[Ring], angle: f64, extra: &[OutlinePos]) -> (TravelGraph, Vec<u32>) {
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
            egrid: CellMap::default(),
            ngrid: CellMap::default(),
            lgrid: CellMap::default(),
            sewn: CellMap::default(),
            step,
            open: None,
            on_line: Vec::new(),
            rgrid: CellMap::default(),
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
        let mut on_ring: Vec<Vec<(usize, f64, u32)>> = vec![Vec::new(); rings.len()];
        let extra_ids: Vec<u32> = extra
            .iter()
            .map(|e| {
                let id = g.add_node(e.at);
                if let Some(r) = on_ring.get_mut(e.ring) {
                    r.push((e.edge, e.u, id));
                }
                id
            })
            .collect();
        if !(b.width() > 0.0 && b.height() > 0.0) {
            g.chain_outline(on_ring);
            return (g, extra_ids);
        }
        let back = |q: Point| q.rotate(-angle);
        // lattice nodes (i·s, j·s) with i + j even: the ±45° diagonals and the
        // vertical (90°) lines all pass through them
        let (i0, i1) = ((b.min_x / step).floor() as i64 - 1, (b.max_x / step).ceil() as i64 + 1);
        let (j0, j1) = ((b.min_y / step).floor() as i64 - 1, (b.max_y / step).ceil() as i64 + 1);
        let mut node_at: CellMap<u32> = CellMap::default();
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
        g.chain_outline(on_ring);
        (g, extra_ids)
    }

    /// The outline: ring vertices and the nodes on it (lattice ends, row
    /// ends) in order, each joined to the next (Ink/Stitch: 3 × the length).
    fn chain_outline(&mut self, on_ring: Vec<Vec<(usize, f64, u32)>>) {
        let rings = self.rings.clone();
        for (ri, ring) in rings.iter().enumerate() {
            let n = ring.len();
            if n < 2 {
                continue;
            }
            let mut chain: Vec<(usize, f64, u32)> = (0..n).map(|k| (k, 0.0, u32::MAX)).collect();
            chain.extend(on_ring[ri].iter().copied());
            chain.sort_by(|x, y| (x.0, x.1, x.2 != u32::MAX).partial_cmp(&(y.0, y.1, y.2 != u32::MAX)).unwrap());
            let ids: Vec<u32> = chain.iter().map(|&(k, _, id)| if id == u32::MAX { self.add_node(ring[k]) } else { id }).collect();
            for w in 0..ids.len() {
                let (a, c) = (ids[w], ids[(w + 1) % ids.len()]);
                if a == c {
                    continue;
                }
                // nodes at the same place (row ends meeting) stay joined
                let l = self.pts[a as usize].dist(self.pts[c as usize]);
                self.add_edge(a, c, 3.0 * l * PX);
                let last = self.edges.len() - 1;
                self.edges[last].outline = true;
            }
        }
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
                        // the outline stays open (Ink/Stitch removes only the
                        // interior travel edges a row crosses)
                        if e.alive && !e.outline && segments_intersect(a, b, self.pts[e.a as usize], self.pts[e.b as usize]) {
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

    /// The cheapest route between two nodes of the graph (Ink/Stitch
    /// `networkx.shortest_path` on its travel graph), and whether it goes
    /// inside the shape (else it follows the outline).
    pub fn route_nodes(&self, a: u32, b: u32) -> Option<(Vec<Point>, bool)> {
        let n = self.pts.len() as u32;
        if a >= n || b >= n {
            return None;
        }
        if a == b {
            return Some((vec![self.pts[a as usize]], false));
        }
        let key = |d: f64| (d * 1e4) as u64;
        let mut dist: HashMap<u32, f64> = HashMap::new();
        let mut prev: HashMap<u32, (u32, u32)> = HashMap::new();
        let mut heap = BinaryHeap::new();
        dist.insert(a, 0.0);
        heap.push(Reverse((0u64, a)));
        let mut found = false;
        while let Some(Reverse((dk, u))) = heap.pop() {
            let du = dist[&u];
            if dk > key(du) {
                continue;
            }
            if u == b {
                found = true;
                break;
            }
            for &(v, e) in &self.adj[u as usize] {
                let edge = self.edges[e as usize];
                if !edge.alive {
                    continue;
                }
                let nd = du + edge.w;
                if dist.get(&v).is_none_or(|d| nd < *d) {
                    dist.insert(v, nd);
                    prev.insert(v, (u, e));
                    heap.push(Reverse((key(nd), v)));
                }
            }
        }
        if !found {
            return None;
        }
        let mut path = vec![self.pts[b as usize]];
        let mut inside = false;
        let mut u = b;
        while let Some(&(p, e)) = prev.get(&u) {
            inside |= !self.edges[e as usize].outline;
            path.push(self.pts[p as usize]);
            u = p;
            if u == a {
                break;
            }
        }
        path.reverse();
        dedup(&mut path, 1e-9);
        Some((path, inside))
    }
}

// ---------------------------------------------------------------------------
// The stitch path of a fill (Ink/Stitch `auto_fill.py`: `build_fill_stitch_graph`,
// `find_stitch_path`, `fill_gaps`, `collapse_sequential_outline_edges`,
// `path_to_stitches`)
//
// The rows (or any sewn pieces whose ends lie on the outline) are the edges of
// a graph whose nodes are their ends; the outline between neighbouring ends is
// an edge too, every other one doubled, so every node has an even degree and
// an Eulerian circuit exists. Hierholzer's algorithm, always taking a row when
// one is left, walks it like mowing a lawn; read backwards, the circuit travels
// to a place *before* the rows there are sewn, so travel hides under them, and
// every pocket stays reachable along the outline. The fill ends where it
// started unless it has an end point.

/// Where a point lies on the outline: ring, edge, parameter on the edge,
/// distance along the ring from its first vertex, and the point on it.
#[derive(Clone, Copy, Debug)]
pub struct OutlinePos {
    pub ring: usize,
    pub edge: usize,
    pub u: f64,
    pub s: f64,
    pub at: Point,
}

/// The nearest place on the outline (Ink/Stitch `which_outline` + `project`).
pub fn outline_pos(rings: &[Ring], p: Point) -> Option<OutlinePos> {
    let mut best: Option<(f64, OutlinePos)> = None;
    for (ri, ring) in rings.iter().enumerate() {
        let n = ring.len();
        let mut s = 0.0;
        for k in 0..n {
            let (a, b) = (ring[k], ring[(k + 1) % n]);
            let e = b - a;
            let l2 = e.length_sq();
            let l = l2.sqrt();
            let u = if l2 > 1e-18 { ((p - a).dot(e) / l2).clamp(0.0, 1.0) } else { 0.0 };
            let q = a + e * u;
            let d = q.dist(p);
            if best.is_none_or(|(bd, _)| d < bd) {
                best = Some((d, OutlinePos { ring: ri, edge: k, u, s: s + l * u, at: q }));
            }
            s += l;
        }
    }
    best.map(|b| b.1)
}

fn dist_to_seg(p: Point, a: Point, b: Point) -> f64 {
    let e = b - a;
    let l2 = e.length_sq();
    let t = if l2 > 1e-18 { ((p - a).dot(e) / l2).clamp(0.0, 1.0) } else { 0.0 };
    (a + e * t).dist(p)
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Kind {
    Segment,
    Outline,
    Extra,
    /// added to make the graph Eulerian (not a neighbour along the outline)
    Euler,
}

/// A step of a fill's stitch path.
#[derive(Clone, Copy, Debug)]
pub enum PathStep {
    /// Sew from `from` to `to`: piece `seg` of the fill (None: an extra row
    /// of gap filling, Ink/Stitch `fill_gap`).
    Segment { seg: Option<usize>, from: Point, to: Point },
    /// Travel between two points; `from_node` / `to_node` index
    /// [`StitchPath::nodes`] (None: not a node). `adjacent`: neighbours along
    /// the outline (one row to the next; Ink/Stitch's "outline" edge).
    Travel { from: Point, to: Point, from_node: Option<usize>, to_node: Option<usize>, adjacent: bool },
}

/// A fill's stitch path: rows to sew and travel between them.
#[derive(Clone, Debug, Default)]
pub struct StitchPath {
    pub steps: Vec<PathStep>,
    /// The graph's nodes: the pieces' ends, the start and end points.
    pub nodes: Vec<Point>,
    /// Where the nodes lie on the outline (None: the start, off it).
    pub pos: Vec<Option<OutlinePos>>,
}

/// One edge of the path before travel runs are collapsed.
#[derive(Clone, Copy, Debug)]
struct RawEdge {
    a: Point,
    b: Point,
    na: Option<usize>,
    nb: Option<usize>,
    seg: Option<usize>,
    segment: bool,
}

type GEdge = (usize, usize, Kind, usize);

/// Ink/Stitch `insert_node`: a start or end point as a new node splitting
/// the outline edge it lies on.
fn insert_node(rings: &[Ring], perim: &[f64], p: Point, nodes: &mut Vec<Point>, pos: &mut Vec<OutlinePos>, edges: &mut Vec<GEdge>, alive: &mut Vec<bool>) -> Option<usize> {
    let op = outline_pos(rings, p)?;
    let id = nodes.len();
    nodes.push(op.at);
    pos.push(op);
    let len = perim[op.ring].max(1e-9);
    let split = (0..edges.len()).find(|&e| {
        let (x, y, k, _) = edges[e];
        if !alive[e] || k != Kind::Outline || pos[x].ring != op.ring || pos[y].ring != op.ring {
            return false;
        }
        let span = (pos[y].s - pos[x].s).rem_euclid(len);
        let at = (op.s - pos[x].s).rem_euclid(len);
        at <= span + 1e-9 || span < 1e-12
    });
    let (x, y, kind) = match split {
        Some(e) => {
            alive[e] = false;
            (edges[e].0, edges[e].1, Kind::Outline)
        }
        // no row ends on this outline: joined to the ends of the nearest outline edge
        None => {
            let near = (0..edges.len()).filter(|&e| alive[e] && edges[e].2 == Kind::Outline).min_by(|&e, &f| {
                let d = |e: usize| dist_to_seg(op.at, nodes[edges[e].0], nodes[edges[e].1]);
                d(e).partial_cmp(&d(f)).unwrap()
            });
            let e = near.or_else(|| (0..edges.len()).find(|&e| alive[e]))?;
            (edges[e].0, edges[e].1, Kind::Euler)
        }
    };
    edges.push((x, id, kind, op.ring));
    alive.push(true);
    edges.push((id, y, kind, op.ring));
    alive.push(true);
    Some(id)
}

/// The stitch path through pieces whose ends lie on the outline of `rings`
/// (Ink/Stitch `build_fill_stitch_graph` + `graph_make_valid` +
/// `find_stitch_path` + `fill_gaps` + `collapse_sequential_outline_edges`).
/// `ends`: each piece's first and last point. `gap_rows`: Ink/Stitch
/// `gap_fill_rows` (rounded up to even; straight rows only).
pub fn find_stitch_path(rings: &[Ring], ends: &[(Point, Point)], start: Option<Point>, end: Option<Point>, gap_rows: u32) -> StitchPath {
    let mut out = StitchPath::default();
    if ends.is_empty() || rings.is_empty() {
        return out;
    }
    // nodes: the pieces' ends (one node per place)
    let mut nodes: Vec<Point> = Vec::new();
    let mut index: HashMap<(u64, u64), usize> = HashMap::new();
    let mut edges: Vec<GEdge> = Vec::new();
    for (i, &(a, b)) in ends.iter().enumerate() {
        let mut node_of = |p: Point| {
            *index.entry((p.x.to_bits(), p.y.to_bits())).or_insert_with(|| {
                nodes.push(p);
                nodes.len() - 1
            })
        };
        let na = node_of(a);
        let nb = node_of(b);
        edges.push((na, nb, Kind::Segment, i));
    }
    let Some(mut pos) = nodes.iter().map(|p| outline_pos(rings, *p)).collect::<Option<Vec<_>>>() else { return out };
    let perim: Vec<f64> = rings.iter().map(|r| (0..r.len()).map(|k| r[k].dist(r[(k + 1) % r.len()])).sum()).collect();
    // the outline between neighbouring nodes, every other edge doubled
    let mut order: Vec<usize> = (0..nodes.len()).collect();
    order.sort_by(|&x, &y| (pos[x].ring, pos[x].s).partial_cmp(&(pos[y].ring, pos[y].s)).unwrap());
    let mut i0 = 0;
    while i0 < order.len() {
        let ring = pos[order[i0]].ring;
        let mut i1 = i0;
        while i1 < order.len() && pos[order[i1]].ring == ring {
            i1 += 1;
        }
        let group = &order[i0..i1];
        let k = group.len();
        if k >= 2 {
            for i in 0..k {
                let (x, y) = (group[i], group[(i + 1) % k]);
                edges.push((x, y, Kind::Outline, ring));
                if i % 2 == 0 {
                    edges.push((x, y, Kind::Extra, ring));
                }
            }
        }
        i0 = i1;
    }
    let mut alive = vec![true; edges.len()];
    if let Some(p) = start {
        insert_node(rings, &perim, p, &mut nodes, &mut pos, &mut edges, &mut alive);
    }
    if let Some(p) = end {
        insert_node(rings, &perim, p, &mut nodes, &mut pos, &mut edges, &mut alive);
    }
    let n = nodes.len();
    let degree = |edges: &[GEdge], alive: &[bool]| {
        let mut d = vec![0usize; n];
        for (e, &(a, b, _, _)) in edges.iter().enumerate() {
            if alive[e] {
                d[a] += 1;
                d[b] += 1;
            }
        }
        d
    };
    // Eulerian: pair the odd nodes (networkx `eulerize`)
    let deg = degree(&edges, &alive);
    let mut odd: Vec<usize> = (0..n).filter(|&v| deg[v] % 2 == 1).collect();
    while let Some(v) = odd.pop() {
        let Some(k) = (0..odd.len()).min_by(|&x, &y| nodes[odd[x]].dist(nodes[v]).partial_cmp(&nodes[odd[y]].dist(nodes[v])).unwrap()) else { break };
        let w = odd.swap_remove(k);
        edges.push((v, w, Kind::Euler, 0));
        alive.push(true);
    }
    // adjacency as networkx keeps it: by neighbour in the order first met,
    // then by edge in insertion order
    let mut adj: Vec<Vec<usize>> = vec![Vec::new(); n];
    for (e, &(a, b, _, _)) in edges.iter().enumerate() {
        if alive[e] {
            adj[a].push(e);
            if b != a {
                adj[b].push(e);
            }
        }
    }
    for (v, list) in adj.iter_mut().enumerate() {
        let other = |e: usize| if edges[e].0 == v { edges[e].1 } else { edges[e].0 };
        let mut first: Vec<usize> = Vec::new();
        for &e in list.iter() {
            if !first.contains(&other(e)) {
                first.push(other(e));
            }
        }
        list.sort_by_key(|&e| first.iter().position(|&o| o == other(e)).unwrap_or(0));
    }
    let neighbours: std::collections::HashSet<(usize, usize)> =
        edges.iter().enumerate().filter(|(e, x)| alive[*e] && matches!(x.2, Kind::Outline | Kind::Extra)).map(|(_, x)| (x.0.min(x.1), x.0.max(x.1))).collect();
    let nearest = |p: Point| (0..n).min_by(|&x, &y| nodes[x].dist(p).partial_cmp(&nodes[y].dist(p)).unwrap()).unwrap();
    let starting = nearest(start.unwrap_or(nodes[0]));
    let ending = end.map_or(starting, nearest);
    // Hierholzer (networkx `eulerian_circuit`), taking a row when there is one
    let mut deg = degree(&edges, &alive);
    let mut used: Vec<bool> = alive.iter().map(|a| !a).collect();
    let circuit = |from: usize, deg: &mut Vec<usize>, used: &mut Vec<bool>, raw: &mut Vec<RawEdge>| {
        let mut stack: Vec<(usize, Option<usize>)> = vec![(from, None)];
        let mut last: Option<(usize, Option<usize>)> = None;
        while let Some(&(v, k)) = stack.last() {
            if deg[v] == 0 {
                if let Some((lv, lk)) = last {
                    let seg = lk.filter(|&e| edges[e].2 == Kind::Segment).map(|e| edges[e].3);
                    raw.push(RawEdge { a: nodes[lv], b: nodes[v], na: Some(lv), nb: Some(v), seg, segment: seg.is_some() });
                }
                last = Some((v, k));
                stack.pop();
            } else {
                let mut pick = None;
                for &e in &adj[v] {
                    if used[e] {
                        continue;
                    }
                    if pick.is_none() {
                        pick = Some(e);
                    }
                    if edges[e].2 == Kind::Segment {
                        pick = Some(e);
                        break;
                    }
                }
                let Some(e) = pick else {
                    deg[v] = 0;
                    continue;
                };
                used[e] = true;
                let (a, b) = (edges[e].0, edges[e].1);
                deg[a] -= 1;
                deg[b] -= 1;
                stack.push((if a == v { b } else { a }, Some(e)));
            }
        }
    };
    let mut raw: Vec<RawEdge> = Vec::new();
    circuit(ending, &mut deg, &mut used, &mut raw);
    // pieces the circuit could not reach (a graph in parts): their own
    // circuits, from the nearest node, after the rest
    loop {
        let left: Vec<usize> = (0..edges.len()).filter(|&e| !used[e] && edges[e].2 == Kind::Segment).collect();
        if left.is_empty() {
            break;
        }
        let here = raw.last().map_or(nodes[ending], |r| r.b);
        let v = left.iter().flat_map(|&e| [edges[e].0, edges[e].1]).min_by(|&x, &y| nodes[x].dist(here).partial_cmp(&nodes[y].dist(here)).unwrap()).unwrap();
        let mut more = Vec::new();
        circuit(v, &mut deg, &mut used, &mut more);
        if more.is_empty() {
            break;
        }
        if let Some(r) = raw.last().copied() {
            raw.push(RawEdge { a: r.b, b: nodes[v], na: r.nb, nb: Some(v), seg: None, segment: false });
        }
        raw.extend(more);
    }
    if starting != ending {
        raw.insert(0, RawEdge { a: nodes[starting], b: nodes[ending], na: Some(starting), nb: Some(ending), seg: None, segment: false });
    }
    // a start inside the shape: travel from there (Ink/Stitch starts at the
    // travel graph's node nearest the start, which may be inside)
    let mut pos: Vec<Option<OutlinePos>> = pos.into_iter().map(Some).collect();
    if let Some(p) = start.filter(|p| point_in_rings(*p, rings) && p.dist(nodes[starting]) > 1e-6) {
        nodes.push(p);
        pos.push(None);
        raw.insert(0, RawEdge { a: p, b: nodes[starting], na: Some(nodes.len() - 1), nb: Some(starting), seg: None, segment: false });
    }
    if gap_rows > 0 {
        raw = fill_gaps(raw, gap_rows.div_ceil(2) * 2);
    }
    // runs of travel collapse into one travel each
    let travel = |from: (Point, Option<usize>), to: (Point, Option<usize>)| {
        let adjacent = matches!((from.1, to.1), (Some(x), Some(y)) if neighbours.contains(&(x.min(y), x.max(y))));
        PathStep::Travel { from: from.0, to: to.0, from_node: from.1, to_node: to.1, adjacent }
    };
    let mut run: Option<(Point, Option<usize>)> = None;
    for e in &raw {
        if e.segment {
            if let Some(r) = run.take() {
                if r.0.dist(e.a) > 1e-9 {
                    out.steps.push(travel(r, (e.a, e.na)));
                }
            }
            out.steps.push(PathStep::Segment { seg: e.seg, from: e.a, to: e.b });
        } else if run.is_none() {
            run = Some((e.a, e.na));
        }
    }
    if let (Some(r), Some(e)) = (run, raw.last()) {
        if r.0.dist(e.b) > 1e-9 {
            out.steps.push(travel(r, (e.b, e.nb)));
        }
    }
    out.nodes = nodes;
    out.pos = pos;
    out
}

/// Ink/Stitch `fill_gaps`: where back-and-forth rows end and the path
/// travels on, the last row is repeated `rows` times beyond it (into the gap
/// fabric distortion opens there) and the path comes back.
fn fill_gaps(path: Vec<RawEdge>, rows: u32) -> Vec<RawEdge> {
    let path = remove_loops(path);
    if path.len() < 3 {
        return path;
    }
    let mut out: Vec<RawEdge> = Vec::new();
    let mut last: Option<RawEdge> = None;
    let mut in_section = 0;
    for e in path {
        if let Some(l) = last {
            if e.segment && !l.segment {
                in_section += 1;
            }
            if !e.segment && !l.segment {
                if in_section > 3 && out.len() >= 4 {
                    let next = out.pop().unwrap();
                    fill_gap(&mut out, rows);
                    out.push(next);
                }
                in_section = 0;
            }
        }
        last = Some(e);
        out.push(e);
    }
    out
}

fn remove_loops(path: Vec<RawEdge>) -> Vec<RawEdge> {
    if path.len() < 2 {
        return path;
    }
    let mut out: Vec<RawEdge> = Vec::new();
    let mut seen: HashMap<(u64, u64), usize> = HashMap::new();
    for e in path {
        if e.segment {
            out.push(e);
            seen.clear();
            continue;
        }
        let k = (e.b.x.to_bits(), e.b.y.to_bits());
        if let Some(&i) = seen.get(&k) {
            out.truncate(i);
            seen.clear();
            continue;
        }
        out.push(e);
        seen.insert(k, out.len());
    }
    out
}

/// Ink/Stitch `fill_gap`: the last row repeated, offset by the row spacing.
fn fill_gap(path: &mut Vec<RawEdge>, rows: u32) {
    let n = path.len();
    let original_end = path[n - 1].b;
    let mut last = (path[n - 1].a, path[n - 1].b);
    let penultimate = (path[n - 3].a, path[n - 3].b);
    let mut off = (last.1 - last.0).unit().perp();
    if (last.1 - penultimate.0).dot(off) < 0.0 {
        off = off * -1.0;
    }
    let off = off * (last.1 - penultimate.0).dot(off);
    let seg = |a: Point, b: Point| RawEdge { a, b, na: None, nb: None, seg: None, segment: true };
    for _ in 0..rows {
        let (end, start) = last;
        let (start, end) = (start + off, end + off);
        path.push(seg(last.1, start));
        path.push(seg(start, end));
        last = (start, end);
    }
    path.push(seg(last.1, original_end));
}

/// Sewing a [`StitchPath`]: its travel graph, with the path's nodes on the
/// outline (Ink/Stitch `build_travel_graph`).
pub struct PathTravel {
    pub graph: TravelGraph,
    ids: Vec<Option<u32>>,
}

impl PathTravel {
    /// `angle`: the rows' rotation (see [`TravelGraph::new`]).
    pub fn new(rings: &[Ring], angle: f64, path: &StitchPath) -> PathTravel {
        let on: Vec<(usize, OutlinePos)> = path.pos.iter().enumerate().filter_map(|(i, p)| p.map(|p| (i, p))).collect();
        let extra: Vec<OutlinePos> = on.iter().map(|x| x.1).collect();
        let (graph, gids) = TravelGraph::with_outline_nodes(rings, angle, &extra);
        let mut ids = vec![None; path.nodes.len()];
        for ((i, _), g) in on.iter().zip(gids) {
            ids[*i] = Some(g);
        }
        PathTravel { graph, ids }
    }

    /// The way of a travel step from `from` to `to` (the step's own points
    /// at its ends), and whether it goes inside the shape (else along the
    /// outline); None where no route is left (Ink/Stitch then jumps).
    pub fn route(&self, from: Point, from_node: Option<usize>, to: Point, to_node: Option<usize>) -> Option<(Vec<Point>, bool)> {
        let id = |n: Option<usize>| n.and_then(|i| self.ids.get(i).copied().flatten());
        let (mut path, inside) = match (id(from_node), id(to_node)) {
            (Some(a), Some(b)) => self.graph.route_nodes(a, b)?,
            _ => (self.graph.route(from, to)?, true),
        };
        if path.len() < 2 {
            return Some((vec![from, to], false));
        }
        path[0] = from;
        let last = path.len() - 1;
        path[last] = to;
        dedup(&mut path, 1e-9);
        Some((path, inside))
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
        // a full wall of rows: no way through the inside; the outline stays
        // open (Ink/Stitch never takes its outline edges out of the travel
        // graph), so a route may only cross the wall on the outline
        let wall = [pt(19.5, 0.0), pt(19.5, 40.0)];
        for y in [12.0, 20.0, 28.0] {
            g.sewn(&wall, false);
            g.sewn(&[pt(0.0, y), pt(40.0, y)], false);
        }
        if let Some(r) = g.route(pt(5.0, 18.0), pt(35.0, 18.0)) {
            for w in r.windows(2) {
                if let Some((_, q)) = segment_intersection(w[0], w[1], wall[0], wall[1]) {
                    assert!(dist_to_boundary(&rings, q) < 0.05, "crosses the wall inside at {q:?}");
                }
            }
        }
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
