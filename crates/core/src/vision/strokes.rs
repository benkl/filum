//! Line networks → strokes.
//!
//! A one-pixel skeleton of a line mask becomes a graph (end points and
//! junctions are nodes, the curves between them are edges), cleaned and read
//! back as long strokes, following the topology-driven line-drawing
//! vectorisers (Noris et al. 2013, "Topology-driven vectorization of clean
//! line drawings"; Favreau et al. 2016, "Fidelity vs. simplicity"):
//!
//! 1. nodes by crossing number (Rutovitz): 1 = end, ≥ 3 = junction; adjacent
//!    junction pixels form one node;
//! 2. spur pruning: short branches from a junction to a free end are thinning
//!    artefacts of corners and blobs, not lines;
//! 3. good continuation: at a junction the two branches that continue each
//!    other most straightly are one stroke (the gestalt rule), the others end
//!    at the junction centre so nothing leaves a gap;
//! 4. gap closing: a free end that points at another line (or another end)
//!    within reach is bridged to it;
//! 5. the line width along every stroke from the distance transform.
//!
//! Coordinates are pixel centres of the mask (x + 0.5, y + 0.5).

use crate::geom::{pt, Point};

#[derive(Debug, Clone)]
pub struct StrokeOpts {
    /// Branches shorter than this (px) that end freely are pruned; strokes
    /// shorter than this are dropped.
    pub min_len: f64,
    /// Bridge free ends to lines within this distance (px). 0 = off.
    pub gap: f64,
    /// Two branches continue through a junction when they bend less than
    /// this (degrees). 0 = every junction ends the strokes.
    pub continue_deg: f64,
}

#[derive(Debug, Clone)]
pub struct Stroke {
    pub pts: Vec<Point>,
    /// Full line width (px) at every point.
    pub widths: Vec<f64>,
    pub closed: bool,
    /// Start / end are free (a line end), not at a junction.
    pub free: [bool; 2],
}

const N8: [(i64, i64); 8] = [(0, -1), (1, -1), (1, 0), (1, 1), (0, 1), (-1, 1), (-1, 0), (-1, -1)];

struct Graph {
    /// Node centre and the pixels of the node.
    nodes: Vec<(Point, Vec<usize>)>,
    /// Edge: end nodes (usize::MAX for a loop without nodes) and its pixels in order.
    edges: Vec<Edge>,
}

#[derive(Clone)]
struct Edge {
    a: usize,
    b: usize,
    pix: Vec<usize>,
    alive: bool,
}

const NONE: usize = usize::MAX;

fn build_graph(skel: &[bool], w: usize, h: usize) -> Graph {
    let at = |x: i64, y: i64| x >= 0 && y >= 0 && (x as usize) < w && (y as usize) < h && skel[y as usize * w + x as usize];
    // crossing number: 0→1 transitions around the 8-neighbourhood
    let cn = |i: usize| {
        let (x, y) = ((i % w) as i64, (i / w) as i64);
        let ring: Vec<bool> = N8.iter().map(|(dx, dy)| at(x + dx, y + dy)).collect();
        (0..8).filter(|&k| !ring[k] && ring[(k + 1) % 8]).count()
    };
    let n = w * h;
    let mut node_of = vec![NONE; n];
    let mut nodes: Vec<(Point, Vec<usize>)> = Vec::new();
    // junctions (clustered) and ends
    for i in 0..n {
        if !skel[i] || node_of[i] != NONE {
            continue;
        }
        let c = cn(i);
        if c == 2 {
            continue;
        }
        let id = nodes.len();
        let mut members = vec![i];
        node_of[i] = id;
        if c >= 3 {
            // flood the 8-connected junction pixels into one node
            let mut k = 0;
            while k < members.len() {
                let p = members[k];
                k += 1;
                let (x, y) = ((p % w) as i64, (p / w) as i64);
                for (dx, dy) in N8 {
                    if at(x + dx, y + dy) {
                        let q = (y + dy) as usize * w + (x + dx) as usize;
                        if node_of[q] == NONE && cn(q) >= 3 {
                            node_of[q] = id;
                            members.push(q);
                        }
                    }
                }
            }
        }
        let (sx, sy) = members.iter().fold((0.0, 0.0), |a, &p| (a.0 + (p % w) as f64, a.1 + (p / w) as f64));
        let m = members.len() as f64;
        nodes.push((pt(sx / m + 0.5, sy / m + 0.5), members));
    }
    // edges: walk from every node pixel along unvisited skeleton pixels
    let mut seen = vec![false; n];
    let mut edges = Vec::new();
    let nbrs = |i: usize| -> Vec<usize> {
        let (x, y) = ((i % w) as i64, (i / w) as i64);
        // 4-neighbours first: the walk follows staircases without skipping
        let order = [0usize, 2, 4, 6, 1, 3, 5, 7];
        order.iter().filter_map(|&k| {
            let (dx, dy) = N8[k];
            at(x + dx, y + dy).then(|| (y + dy) as usize * w + (x + dx) as usize)
        }).collect()
    };
    let walk = |start_node: usize, first: usize, seen: &mut Vec<bool>| -> (usize, Vec<usize>) {
        let mut pix = Vec::new();
        let mut prev = NONE;
        let mut cur = first;
        loop {
            if node_of[cur] != NONE {
                return (node_of[cur], pix);
            }
            seen[cur] = true;
            pix.push(cur);
            let next = nbrs(cur).into_iter().find(|&q| q != prev && !seen[q] && (node_of[q] == NONE || node_of[q] != start_node || pix.len() > 2));
            // prefer a node when one is adjacent (the edge ends there)
            let node_next = nbrs(cur).into_iter().find(|&q| node_of[q] != NONE && q != prev && (node_of[q] != start_node || pix.len() > 2));
            match node_next.or(next) {
                Some(q) => {
                    prev = cur;
                    cur = q;
                }
                None => {
                    // a dead end right next to a junction (its connecting pixel
                    // went to another branch): it belongs to that junction
                    let (x, y) = ((cur % w) as i64, (cur / w) as i64);
                    let mut best: Option<(i64, usize)> = None;
                    for dy in -2..=2i64 {
                        for dx in -2..=2i64 {
                            if at(x + dx, y + dy) {
                                let q = (y + dy) as usize * w + (x + dx) as usize;
                                let nq = node_of[q];
                                if nq != NONE && (nq != start_node || pix.len() > 4) && best.is_none_or(|b| dx * dx + dy * dy < b.0) {
                                    best = Some((dx * dx + dy * dy, nq));
                                }
                            }
                        }
                    }
                    return (best.map_or(NONE, |b| b.1), pix);
                }
            }
        }
    };
    for id in 0..nodes.len() {
        let members = nodes[id].1.clone();
        for &p in &members {
            for q in nbrs(p) {
                if node_of[q] == id || seen[q] {
                    continue;
                }
                if node_of[q] != NONE {
                    // two nodes side by side: a zero-length edge, once
                    if node_of[q] > id {
                        edges.push(Edge { a: id, b: node_of[q], pix: vec![], alive: true });
                    }
                    continue;
                }
                let (end, pix) = walk(id, q, &mut seen);
                if pix.is_empty() {
                    continue;
                }
                let b = if end == NONE {
                    // a dead end without an end pixel: make it a node
                    let last = *pix.last().unwrap();
                    nodes.push((pt((last % w) as f64 + 0.5, (last / w) as f64 + 0.5), vec![last]));
                    nodes.len() - 1
                } else {
                    end
                };
                edges.push(Edge { a: id, b, pix, alive: true });
            }
        }
    }
    // loops without any node
    for i in 0..n {
        if skel[i] && !seen[i] && node_of[i] == NONE {
            let mut pix = vec![i];
            seen[i] = true;
            let mut prev = NONE;
            let mut cur = i;
            loop {
                let next = nbrs(cur).into_iter().find(|&q| q != prev && !seen[q]);
                match next {
                    Some(q) => {
                        seen[q] = true;
                        pix.push(q);
                        prev = cur;
                        cur = q;
                    }
                    None => break,
                }
            }
            if pix.len() >= 3 {
                edges.push(Edge { a: NONE, b: NONE, pix, alive: true });
            }
        }
    }
    Graph { nodes, edges }
}

fn cell_pt(i: usize, w: usize) -> Point {
    pt((i % w) as f64 + 0.5, (i / w) as f64 + 0.5)
}

/// Direction leaving node `nd` along edge `e` (unit). The skeleton near a
/// junction is bent towards it (the junction zone, `zone` px): the direction
/// is measured beyond it, over `reach` px of the branch.
fn leave_dir(g: &Graph, e: &Edge, nd: usize, w: usize, zone: f64, reach: f64) -> Point {
    let c = g.nodes[nd].0;
    let pts: Vec<Point> = if e.a == nd { e.pix.iter().map(|&i| cell_pt(i, w)).collect() } else { e.pix.iter().rev().map(|&i| cell_pt(i, w)).collect() };
    if pts.is_empty() {
        let d = g.nodes[if e.a == nd { e.b } else { e.a }].0 - c;
        let l = d.length();
        return if l < 1e-9 { pt(0.0, 0.0) } else { d * (1.0 / l) };
    }
    let near = pts.iter().position(|p| p.dist(c) >= zone);
    let (from, far) = match near {
        Some(k) => {
            let p1 = pts[k];
            let p2 = *pts[k..].iter().find(|p| p.dist(p1) >= reach).unwrap_or(pts.last().unwrap());
            if p2.dist(p1) < 2.0 { (c, p2) } else { (p1, p2) }
        }
        None => (c, *pts.last().unwrap()),
    };
    let d = far - from;
    let l = d.length();
    if l < 1e-9 { pt(0.0, 0.0) } else { d * (1.0 / l) }
}

/// Strokes of a skeleton. `radius(i)` is the inscribed radius (px) at pixel i.
pub fn strokes(skel: &[bool], w: usize, h: usize, radius: &dyn Fn(usize) -> f64, o: &StrokeOpts) -> Vec<Stroke> {
    let mut g = build_graph(skel, w, h);
    let degree = |g: &Graph, nd: usize| g.edges.iter().filter(|e| e.alive && (e.a == nd || e.b == nd)).map(|e| if e.a == e.b { 2 } else { 1 }).sum::<usize>();
    let node_r = |g: &Graph, nd: usize| g.nodes[nd].1.iter().map(|&i| radius(i)).fold(0.0f64, f64::max).max(1.0);

    // 2. spurs: a free end hanging off a junction, shorter than about one and a half
    // line widths (thinning artefacts of corners and blobs reach about one width; an
    // arm or a serif of a letter is longer), or the minimum
    let prune = |g: &mut Graph| {
    for _ in 0..3 {
        let mut changed = false;
        for k in 0..g.edges.len() {
            let e = &g.edges[k];
            if !e.alive || e.a == NONE {
                continue;
            }
            let (da, db) = (degree(g, e.a), degree(g, e.b));
            let (free, junction) = if da == 1 && db >= 3 { (e.a, e.b) } else if db == 1 && da >= 3 { (e.b, e.a) } else { continue };
            let _ = free;
            let len = e.pix.len() as f64 + 1.0;
            if len < (3.0 * node_r(g, junction)).max(o.min_len) {
                g.edges[k].alive = false;
                changed = true;
            }
        }
        if !changed {
            break;
        }
    }
    };
    prune(&mut g);
    // a junction of thick lines thins into several junctions a few pixels
    // apart: nodes joined by an edge shorter than the lines are wide are one
    loop {
        let mut merged = false;
        for k in 0..g.edges.len() {
            let e = g.edges[k].clone();
            if !e.alive || e.a == NONE || e.a == e.b {
                continue;
            }
            let (a, b) = (e.a, e.b);
            if degree(&g, a) < 2 || degree(&g, b) < 2 || (degree(&g, a) < 3 && degree(&g, b) < 3) {
                continue;
            }
            let lim = 2.0 * node_r(&g, a).max(node_r(&g, b));
            if (e.pix.len() as f64 + 1.0) >= lim {
                continue;
            }
            g.edges[k].alive = false;
            for f in g.edges.iter_mut() {
                if f.a == b {
                    f.a = a;
                }
                if f.b == b {
                    f.b = a;
                }
            }
            let moved = std::mem::take(&mut g.nodes[b].1);
            let mut pix = std::mem::take(&mut g.nodes[a].1);
            pix.extend(moved);
            pix.extend(e.pix.iter().copied());
            let (sx, sy) = pix.iter().fold((0.0, 0.0), |acc, &q| (acc.0 + (q % w) as f64, acc.1 + (q / w) as f64));
            let m = pix.len() as f64;
            g.nodes[a] = (pt(sx / m + 0.5, sy / m + 0.5), pix);
            merged = true;
        }
        if !merged {
            break;
        }
    }
    prune(&mut g);

    // 3. good continuation: pair the edge ends at every node
    // partner[(edge, end)] = (edge, end); end 0 = a, 1 = b
    let ne = g.edges.len();
    let mut partner: Vec<[Option<(usize, usize)>; 2]> = vec![[None, None]; ne];
    let cos_max = (180.0 - o.continue_deg.clamp(0.0, 180.0)).to_radians().cos();
    for nd in 0..g.nodes.len() {
        let ends: Vec<(usize, usize)> = (0..ne)
            .filter(|&k| g.edges[k].alive)
            .flat_map(|k| {
                let e = &g.edges[k];
                let mut v = Vec::new();
                if e.a == nd {
                    v.push((k, 0));
                }
                if e.b == nd {
                    v.push((k, 1));
                }
                v
            })
            .collect();
        if ends.len() < 2 {
            continue;
        }
        let r = node_r(&g, nd);
        let dirs: Vec<Point> = ends.iter().map(|&(k, _)| leave_dir(&g, &g.edges[k], nd, w, 1.5 * r, (2.5 * r).clamp(4.0, 16.0))).collect();
        if ends.len() == 2 {
            // a node of degree two (after pruning): the line simply goes on
            partner[ends[0].0][ends[0].1] = Some(ends[1]);
            partner[ends[1].0][ends[1].1] = Some(ends[0]);
            continue;
        }
        if o.continue_deg <= 0.0 {
            continue;
        }
        // greedy: straightest pairs first
        let mut pairs: Vec<(f64, usize, usize)> = Vec::new();
        for i in 0..ends.len() {
            for j in i + 1..ends.len() {
                let c = dirs[i].dot(dirs[j]); // -1 = straight through
                if c <= cos_max {
                    pairs.push((c, i, j));
                }
            }
        }
        pairs.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
        let mut used = vec![false; ends.len()];
        for (_, i, j) in pairs {
            if used[i] || used[j] || ends[i].0 == ends[j].0 {
                continue;
            }
            used[i] = true;
            used[j] = true;
            partner[ends[i].0][ends[i].1] = Some(ends[j]);
            partner[ends[j].0][ends[j].1] = Some(ends[i]);
        }
    }

    // 4. strokes: chains of paired edges
    let mut done = vec![false; ne];
    let mut out: Vec<Stroke> = Vec::new();
    let edge_pts = |g: &Graph, k: usize, from_end: usize| -> Vec<usize> {
        let e = &g.edges[k];
        if from_end == 0 { e.pix.clone() } else { e.pix.iter().rev().copied().collect() }
    };
    let mut emit = |start: usize, start_end: usize, done: &mut Vec<bool>, g: &Graph| {
        let mut pts: Vec<Point> = Vec::new();
        let mut wid: Vec<f64> = Vec::new();
        let mut k = start;
        let mut from = start_end; // the end we enter edge k at
        let mut closed = false;
        let node_at = |g: &Graph, k: usize, end: usize| if end == 0 { g.edges[k].a } else { g.edges[k].b };
        // the start node centre (when it is a junction or end)
        let n0 = node_at(g, k, from);
        let free0 = n0 == NONE || degree(g, n0) <= 1;
        let mut free1;
        if n0 != NONE {
            pts.push(g.nodes[n0].0);
            wid.push(f64::NAN);
        }
        loop {
            done[k] = true;
            for i in edge_pts(g, k, from) {
                pts.push(cell_pt(i, w));
                wid.push(2.0 * radius(i));
            }
            let exit = 1 - from;
            let nd = node_at(g, k, exit);
            free1 = nd == NONE || degree(g, nd) <= 1;
            if nd != NONE {
                pts.push(g.nodes[nd].0);
                wid.push(f64::NAN);
            }
            match partner[k][exit] {
                Some((k2, e2)) if !done[k2] => {
                    k = k2;
                    from = e2;
                }
                Some((k2, _)) if k2 == start => {
                    closed = true;
                    break;
                }
                _ => break,
            }
        }
        if g.edges[start].a == NONE {
            closed = true;
        }
        if closed && pts.len() > 2 && pts[0].dist(*pts.last().unwrap()) < 1.5 {
            pts.pop();
            wid.pop();
        }
        // junction points: the width of the nearest line point
        let valid: Vec<usize> = (0..wid.len()).filter(|&i| wid[i].is_finite()).collect();
        if valid.is_empty() {
            for v in wid.iter_mut() {
                *v = 2.0;
            }
        } else {
            for i in 0..wid.len() {
                if !wid[i].is_finite() {
                    let j = *valid.iter().min_by_key(|&&j| j.abs_diff(i)).unwrap();
                    wid[i] = wid[j];
                }
            }
        }
        if pts.len() >= 2 {
            out.push(Stroke { pts, widths: wid, closed, free: [free0 && !closed, free1 && !closed] });
        }
    };
    // open chains start at an unpaired end
    for k in 0..ne {
        if !g.edges[k].alive || done[k] {
            continue;
        }
        for end in 0..2 {
            if !done[k] && partner[k][end].is_none() {
                emit(k, end, &mut done, &g);
            }
        }
    }
    // the rest are closed chains
    for k in 0..ne {
        if g.edges[k].alive && !done[k] {
            emit(k, 0, &mut done, &g);
        }
    }
    drop(emit);

    // 5. gap closing and short strokes
    if o.gap > 0.0 {
        close_gaps(&mut out, o.gap);
    }
    out.retain(|s| crate::geom::polyline_length(&s.pts) >= o.min_len);
    // widths: a gentle running median (single noisy pixels)
    for s in &mut out {
        s.widths = median3(&s.widths);
    }
    out
}

fn median3(v: &[f64]) -> Vec<f64> {
    (0..v.len())
        .map(|i| {
            let a = v[i.saturating_sub(1)];
            let b = v[i];
            let c = v[(i + 1).min(v.len() - 1)];
            a.max(b).min(a.min(b).max(c))
        })
        .collect()
}

/// Tangent at an open end (pointing outwards), from `reach` px of the line.
fn end_dir(pts: &[Point], at_start: bool, reach: f64) -> Point {
    let (e, it): (Point, Box<dyn Iterator<Item = &Point>>) = if at_start { (pts[0], Box::new(pts.iter())) } else { (*pts.last().unwrap(), Box::new(pts.iter().rev())) };
    let mut q = e;
    for p in it {
        q = *p;
        if p.dist(e) >= reach {
            break;
        }
    }
    let d = e - q;
    let l = d.length();
    if l < 1e-9 { pt(0.0, 0.0) } else { d * (1.0 / l) }
}

/// Bridge free ends to nearby lines: end to end (one stroke), else end to the
/// nearest point of a line it points at (a T-joint).
fn close_gaps(strokes: &mut Vec<Stroke>, gap: f64) {
    // ends that are free: not touching another stroke already
    let reach = 4.0;
    let mut joined = true;
    let mut guard = 0;
    while joined && guard < 4 {
        joined = false;
        guard += 1;
        // end ↔ end
        'outer: for i in 0..strokes.len() {
            if strokes[i].closed {
                continue;
            }
            for ei in [true, false] {
                if !strokes[i].free[if ei { 0 } else { 1 }] {
                    continue;
                }
                let pi = if ei { strokes[i].pts[0] } else { *strokes[i].pts.last().unwrap() };
                let di = end_dir(&strokes[i].pts, ei, reach);
                let mut best: Option<(f64, usize, bool)> = None;
                for j in 0..strokes.len() {
                    if strokes[j].closed {
                        continue;
                    }
                    for ej in [true, false] {
                        if i == j && ei == ej || !strokes[j].free[if ej { 0 } else { 1 }] {
                            continue;
                        }
                        let pj = if ej { strokes[j].pts[0] } else { *strokes[j].pts.last().unwrap() };
                        let d = pi.dist(pj);
                        let wi = if ei { strokes[i].widths[0] } else { *strokes[i].widths.last().unwrap() };
                        let wj = if ej { strokes[j].widths[0] } else { *strokes[j].widths.last().unwrap() };
                        if d > gap + (wi + wj) / 2.0 || d < 1e-9 && i == j {
                            continue;
                        }
                        let dj = end_dir(&strokes[j].pts, ej, reach);
                        let v = if d > 1e-9 { (pj - pi) * (1.0 / d) } else { di };
                        // both ends face the gap
                        if di.dot(v) < 0.5 || dj.dot(v * -1.0) < 0.5 {
                            continue;
                        }
                        // a stroke closing on itself must be long enough to be a loop
                        if i == j && crate::geom::polyline_length(&strokes[i].pts) < 4.0 * gap {
                            continue;
                        }
                        let cost = d * (2.0 - di.dot(v) - dj.dot(v * -1.0) + 1.0);
                        if best.is_none_or(|b| cost < b.0) {
                            best = Some((cost, j, ej));
                        }
                    }
                }
                if let Some((_, j, ej)) = best {
                    if i == j {
                        strokes[i].closed = true;
                        strokes[i].free = [false, false];
                    } else {
                        let (a, b) = if i < j { (i, j) } else { (j, i) };
                        let sb = strokes.remove(b);
                        let sa = strokes.remove(a);
                        let (mut s1, mut s2) = if a == i { (sa, sb) } else { (sb, sa) };
                        let (e1, e2) = if a == i { (ei, ej) } else { (ej, ei) };
                        // s1 must end at the joint, s2 start there
                        if e1 {
                            s1.pts.reverse();
                            s1.widths.reverse();
                        }
                        if !e2 {
                            s2.pts.reverse();
                            s2.widths.reverse();
                        }
                        // the joint ends are gone; the outer ends keep their state
                        let f1 = if e1 { s1.free[1] } else { s1.free[0] };
                        let f2 = if e2 { s2.free[1] } else { s2.free[0] };
                        s1.pts.extend(s2.pts);
                        s1.widths.extend(s2.widths);
                        s1.free = [f1, f2];
                        strokes.push(s1);
                    }
                    joined = true;
                    break 'outer;
                }
            }
        }
    }
    // end → line (T-joints)
    let n = strokes.len();
    let mut ext: Vec<(usize, bool, Point, f64)> = Vec::new();
    for i in 0..n {
        if strokes[i].closed {
            continue;
        }
        for ei in [true, false] {
            if !strokes[i].free[if ei { 0 } else { 1 }] {
                continue;
            }
            let pi = if ei { strokes[i].pts[0] } else { *strokes[i].pts.last().unwrap() };
            let di = end_dir(&strokes[i].pts, ei, reach);
            let mut best: Option<(f64, Point, f64)> = None;
            for j in 0..n {
                let pts = &strokes[j].pts;
                let m = pts.len();
                for (k, &q) in pts.iter().enumerate() {
                    // not the stroke's own end region
                    if i == j && ((ei && k < (3.0 * gap) as usize + 4) || (!ei && k + (3.0 * gap) as usize + 4 >= m)) {
                        continue;
                    }
                    let d = pi.dist(q);
                    let wi = if ei { strokes[i].widths[0] } else { *strokes[i].widths.last().unwrap() };
                    if d < 0.75 || d > gap + (wi + strokes[j].widths[k]) / 2.0 {
                        continue;
                    }
                    let v = (q - pi) * (1.0 / d);
                    if di.dot(v) < 0.6 {
                        continue;
                    }
                    if best.is_none_or(|b| d < b.0) {
                        best = Some((d, q, strokes[j].widths[k]));
                    }
                }
            }
            if let Some((_, q, wq)) = best {
                ext.push((i, ei, q, wq));
            }
        }
    }
    for (i, at_start, q, wq) in ext {
        let s = &mut strokes[i];
        let wv = if at_start { s.widths[0] } else { *s.widths.last().unwrap() };
        if at_start {
            s.pts.insert(0, q);
            s.widths.insert(0, wv.min(wq.max(wv)));
        } else {
            s.pts.push(q);
            s.widths.push(wv.min(wq.max(wv)));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn skel_of(lines: &[&[(usize, usize)]], w: usize, h: usize) -> Vec<bool> {
        let mut m = vec![false; w * h];
        for l in lines {
            for &(x, y) in *l {
                m[y * w + x] = true;
            }
        }
        m
    }

    fn opts() -> StrokeOpts {
        StrokeOpts { min_len: 3.0, gap: 0.0, continue_deg: 50.0 }
    }

    #[test]
    fn a_cross_is_two_strokes_through_the_junction() {
        let (w, h) = (31, 31);
        let hline: Vec<(usize, usize)> = (2..29).map(|x| (x, 15)).collect();
        let vline: Vec<(usize, usize)> = (2..29).map(|y| (15, y)).collect();
        let s = strokes(&skel_of(&[&hline, &vline], w, h), w, h, &|_| 1.0, &opts());
        assert_eq!(s.len(), 2, "{:?}", s.iter().map(|x| x.pts.len()).collect::<Vec<_>>());
        for st in &s {
            assert!(crate::geom::polyline_length(&st.pts) > 24.0);
        }
    }

    #[test]
    fn a_t_joint_keeps_the_bar_whole_and_the_stem_touches_it() {
        let (w, h) = (31, 31);
        let bar: Vec<(usize, usize)> = (2..29).map(|x| (x, 5)).collect();
        let stem: Vec<(usize, usize)> = (6..29).map(|y| (15, y)).collect();
        let s = strokes(&skel_of(&[&bar, &stem], w, h), w, h, &|_| 1.0, &opts());
        assert_eq!(s.len(), 2);
        let long = s.iter().map(|x| crate::geom::polyline_length(&x.pts)).fold(0.0, f64::max);
        assert!(long > 25.0, "the bar runs through: {long}");
        // the stem reaches the bar
        let stem_s = s.iter().find(|x| crate::geom::polyline_length(&x.pts) < 25.0).unwrap();
        let top = stem_s.pts.iter().map(|p| p.y).fold(f64::MAX, f64::min);
        assert!(top <= 6.0, "stem top {top}");
    }

    #[test]
    fn spurs_are_pruned() {
        let (w, h) = (40, 20);
        let line: Vec<(usize, usize)> = (2..38).map(|x| (x, 10)).collect();
        let spur: Vec<(usize, usize)> = vec![(20, 9), (20, 8)];
        let s = strokes(&skel_of(&[&line, &spur], w, h), w, h, &|_| 1.5, &opts());
        assert_eq!(s.len(), 1);
    }

    #[test]
    fn a_ring_is_one_closed_stroke() {
        let (w, h) = (40, 40);
        let mut ring = Vec::new();
        for k in 0..400 {
            let a = k as f64 / 400.0 * std::f64::consts::TAU;
            ring.push(((20.0 + 12.0 * a.cos()).round() as usize, (20.0 + 12.0 * a.sin()).round() as usize));
        }
        ring.dedup();
        // thin it to a one-pixel ring
        let m = skel_of(&[&ring], w, h);
        let thin = crate::digitize::zhang_suen(&m, w, h);
        let s = strokes(&thin, w, h, &|_| 1.0, &opts());
        assert_eq!(s.len(), 1);
        assert!(s[0].closed);
    }

    #[test]
    fn ring_with_a_chord_runs_through() {
        let (w, h) = (240, 240);
        let mut m = vec![false; w * h];
        for y in 0..h {
            for x in 0..w {
                let (fx, fy) = (x as f64, y as f64);
                let d = ((fx - 120.0).powi(2) + (fy - 120.0).powi(2)).sqrt();
                let ring = (97.0..=103.0).contains(&d);
                let chord = (fy - 160.0).abs() <= 3.0 && (20.0..=220.0).contains(&fx) && d <= 103.0;
                if ring || chord {
                    m[y * w + x] = true;
                }
            }
        }
        let dt = crate::digitize::edt_sq(&m, w, h);
        let sk = crate::digitize::zhang_suen(&m, w, h);
        let s = strokes(&sk, w, h, &|i| dt[i].sqrt(), &StrokeOpts { min_len: 8.0, gap: 4.0, continue_deg: 35.0 });
        assert!(s.iter().any(|st| st.closed), "the ring runs through both junctions");
        assert_eq!(s.len(), 2);
    }

    #[test]
    fn gaps_are_bridged() {
        let (w, h) = (50, 20);
        let a: Vec<(usize, usize)> = (2..22).map(|x| (x, 10)).collect();
        let b: Vec<(usize, usize)> = (25..48).map(|x| (x, 10)).collect();
        let s = strokes(&skel_of(&[&a, &b], w, h), w, h, &|_| 1.0, &StrokeOpts { gap: 4.0, ..opts() });
        assert_eq!(s.len(), 1, "joined across the 3 px gap");
        let s = strokes(&skel_of(&[&a, &b], w, h), w, h, &|_| 1.0, &opts());
        assert_eq!(s.len(), 2, "no bridging when off");
    }
}
