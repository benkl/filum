//! Routing a network of lines (outlines of a logo, the strokes of a
//! drawing) so it sews in one go, without trims.
//!
//! The lines are cut where they meet (an end on another line, two lines
//! crossing) into the edges of a graph. Every connected part is sewn by a
//! depth-first walk: going out along an edge the needle lays a running
//! stitch along its centre, which the column sewn on the way back covers
//! (Ink/Stitch's auto-routing of satins places its underpaths the same way).
//! An edge to a dead end, or to a point already reached, is one satin that
//! walks out under itself and covers on the way back (an odd centre-walk).
//! Every edge is covered once and no travel shows.

use crate::geom::{polyline_length, Point};
use crate::model::{Object, RunningParams, SatinParams, StitchParams, SubPath};

/// A line to route: its centre line and how it is sewn.
#[derive(Clone)]
struct Line {
    pts: Vec<Point>,
    closed: bool,
}

fn seg_project(p: Point, a: Point, b: Point) -> (f64, Point) {
    let d = b - a;
    let l2 = d.dot(d);
    let t = if l2 < 1e-12 { 0.0 } else { ((p - a).dot(d) / l2).clamp(0.0, 1.0) };
    (t, a + d * t)
}

fn seg_cross(a: Point, b: Point, c: Point, d: Point) -> Option<(f64, f64)> {
    let r = b - a;
    let s = d - c;
    let den = r.cross(s);
    if den.abs() < 1e-12 {
        return None;
    }
    let t = (c - a).cross(s) / den;
    let u = (c - a).cross(r) / den;
    ((0.0..=1.0).contains(&t) && (0.0..=1.0).contains(&u)).then_some((t, u))
}

/// Arc position of every vertex.
fn arcs(pts: &[Point]) -> Vec<f64> {
    let mut a = vec![0.0; pts.len()];
    for i in 1..pts.len() {
        a[i] = a[i - 1] + pts[i].dist(pts[i - 1]);
    }
    a
}

/// The point at arc position `s` (with its segment index).
fn at_arc(pts: &[Point], arc: &[f64], s: f64) -> (usize, Point) {
    let k = arc.partition_point(|&x| x < s).clamp(1, pts.len() - 1);
    let seg = (arc[k] - arc[k - 1]).max(1e-12);
    let f = ((s - arc[k - 1]) / seg).clamp(0.0, 1.0);
    (k - 1, pts[k - 1] + (pts[k] - pts[k - 1]) * f)
}

/// Cut a line at the given arc positions (sorted, inside the line).
fn cut(line: &Line, mut at: Vec<f64>, keep: f64) -> Vec<Line> {
    let arc = arcs(&line.pts);
    let total = *arc.last().unwrap();
    at.retain(|&s| s > keep && s < total - keep || line.closed);
    at.sort_by(|a, b| a.partial_cmp(b).unwrap());
    at.dedup_by(|a, b| (*a - *b).abs() < keep);
    if at.is_empty() {
        return vec![line.clone()];
    }
    let piece = |s0: f64, s1: f64| -> Vec<Point> {
        let (i0, p0) = at_arc(&line.pts, &arc, s0);
        let (i1, p1) = at_arc(&line.pts, &arc, s1);
        let mut v = vec![p0];
        v.extend(line.pts[i0 + 1..=i1].iter().copied());
        v.push(p1);
        v.dedup_by(|a, b| a.dist(*b) < 1e-6);
        v
    };
    let mut out = Vec::new();
    if line.closed {
        // a loop cut at k points: k pieces, the last one through the start
        for w in at.windows(2) {
            out.push(Line { pts: piece(w[0], w[1]), closed: false });
        }
        let mut wrap = piece(*at.last().unwrap(), total);
        wrap.extend(piece(0.0, at[0]).into_iter().skip(1));
        out.push(Line { pts: wrap, closed: false });
    } else {
        let mut s0 = 0.0;
        for &s in &at {
            out.push(Line { pts: piece(s0, s), closed: false });
            s0 = s;
        }
        out.push(Line { pts: piece(s0, total), closed: false });
    }
    out.into_iter().filter(|l| l.pts.len() >= 2).collect()
}

/// Cut the lines where they meet: an end on another line (a T) and two
/// lines crossing (an X). `tol`: how near an end must come to count.
fn split_at_junctions(lines: Vec<Line>, tol: f64) -> Vec<Line> {
    let mut cuts: Vec<Vec<f64>> = vec![Vec::new(); lines.len()];
    let arcs_of: Vec<Vec<f64>> = lines.iter().map(|l| arcs(&l.pts)).collect();
    for (i, a) in lines.iter().enumerate() {
        // ends of `a` on another line (or on itself, away from that end)
        if !a.closed {
            for end in [a.pts[0], *a.pts.last().unwrap()] {
                for (j, b) in lines.iter().enumerate() {
                    let arc = &arcs_of[j];
                    let total = *arc.last().unwrap();
                    let mut best: Option<(f64, f64)> = None;
                    for k in 0..b.pts.len() - 1 {
                        let (t, q) = seg_project(end, b.pts[k], b.pts[k + 1]);
                        let d = q.dist(end);
                        if d < tol && best.is_none_or(|x| d < x.0) {
                            best = Some((d, arc[k] + t * (arc[k + 1] - arc[k])));
                        }
                    }
                    if let Some((_, s)) = best {
                        // not the end itself (its own line) nor one of b's ends
                        let own = i == j && (s < 2.0 * tol || s > total - 2.0 * tol);
                        if !own && (b.closed || (s > tol && s < total - tol)) {
                            cuts[j].push(s);
                        }
                    }
                }
            }
        }
        // crossings with the lines after it
        for (j, b) in lines.iter().enumerate().skip(i + 1) {
            for ka in 0..a.pts.len() - 1 {
                for kb in 0..b.pts.len() - 1 {
                    if let Some((t, u)) = seg_cross(a.pts[ka], a.pts[ka + 1], b.pts[kb], b.pts[kb + 1]) {
                        let sa = arcs_of[i][ka] + t * (arcs_of[i][ka + 1] - arcs_of[i][ka]);
                        let sb = arcs_of[j][kb] + u * (arcs_of[j][kb + 1] - arcs_of[j][kb]);
                        cuts[i].push(sa);
                        cuts[j].push(sb);
                    }
                }
            }
        }
    }
    lines.into_iter().zip(cuts).flat_map(|(l, c)| cut(&l, c, tol * 0.5)).collect()
}

/// One step of the walk: an edge sewn from `from` to its other end.
enum Step {
    /// A running stitch along the edge (covered later).
    Path(usize, bool),
    /// The edge sewn (its column, or its running line).
    Sew(usize, bool),
    /// Out along the edge under itself and sewn back: ends where it began.
    OutBack(usize, bool),
}

/// Route the line objects of one thread (each a single centre line: satin
/// columns by width, or running lines) so the network sews without trims.
/// Objects of other kinds come back as they are, first. `cursor`: where the
/// needle is. Returns the objects in sewing order.
pub fn route_lines(objects: Vec<Object>, cursor: Point) -> Vec<Object> {
    let routable = |o: &Object| o.paths.len() == 1 && matches!(o.stitch, StitchParams::Satin(_) | StitchParams::Running(_));
    let (mine, rest): (Vec<Object>, Vec<Object>) = objects.into_iter().partition(routable);
    if mine.len() < 2 {
        return rest.into_iter().chain(mine).collect();
    }
    // the widest column sets how near lines must come to meet
    let width = mine
        .iter()
        .map(|o| match &o.stitch {
            StitchParams::Satin(p) => p.width,
            _ => 0.3,
        })
        .fold(0.3f64, f64::max);
    let tol = (width * 0.75).max(0.5);
    let template = mine[0].clone();
    let satin = mine.iter().find_map(|o| match &o.stitch {
        StitchParams::Satin(p) => Some(p.clone()),
        _ => None,
    });
    let running = mine.iter().find_map(|o| match &o.stitch {
        StitchParams::Running(p) => Some(p.clone()),
        _ => None,
    });
    // satin and running lines are routed apart (one network each)
    let mut out: Vec<Object> = rest;
    let mut pos = cursor;
    let mut k = 0;
    for want_satin in [false, true] {
        let lines: Vec<Line> = mine
            .iter()
            .filter(|o| matches!(o.stitch, StitchParams::Satin(_)) == want_satin)
            .map(|o| Line { pts: o.paths[0].flatten(0.05), closed: o.paths[0].closed })
            .filter(|l| l.pts.len() >= 2)
            .collect();
        if lines.is_empty() {
            continue;
        }
        let edges = split_at_junctions(lines, tol);
        let make = |pts: Vec<Point>, closed: bool, step: &str, k: usize| -> Object {
            let stitch = match (step, &satin, &running) {
                ("path", _, _) => StitchParams::Running(RunningParams { length: 2.0, ..Default::default() }),
                ("outback", Some(sp), _) if want_satin => StitchParams::Satin(SatinParams { center_walk: true, center_walk_repeats: 1, ..sp.clone() }),
                (_, Some(sp), _) if want_satin => StitchParams::Satin(SatinParams { center_walk: true, center_walk_repeats: 2, ..sp.clone() }),
                (_, _, Some(rp)) => StitchParams::Running(rp.clone()),
                _ => StitchParams::Running(RunningParams::default()),
            };
            let name = match step {
                "path" => format!("{} · path {k}", template.name.split(" line").next().unwrap_or("Line")),
                _ => format!("{} line {k}", template.name.split(" line").next().unwrap_or("Line")),
            };
            Object { id: format!("{}r{k}", template.id), name, paths: vec![SubPath::polyline(&pts, closed)], stitch, ..template.clone() }
        };
        let steps = walk(&edges, tol, &mut pos);
        for st in steps {
            k += 1;
            let (e, fwd, kind) = match st {
                Step::Path(e, f) => (e, f, "path"),
                Step::Sew(e, f) => (e, f, "sew"),
                Step::OutBack(e, f) => (e, f, "outback"),
            };
            let mut pts = edges[e].pts.clone();
            if !fwd {
                pts.reverse();
            }
            let closed = edges[e].closed;
            if kind == "outback" && !want_satin {
                // a running line: a plain path out, the line itself sewn back
                // (a triple stitch would lay six passes going out and back)
                out.push(make(pts.clone(), closed, "path", k));
                pts.reverse();
                k += 1;
                out.push(make(pts, closed, "sew", k));
                continue;
            }
            if kind != "path" || polyline_length(&pts) > 0.5 {
                out.push(make(pts, closed, kind, k));
            }
        }
    }
    out
}

/// The depth-first walk over the edges, part by part from the nearest.
fn walk(edges: &[Line], tol: f64, pos: &mut Point) -> Vec<Step> {
    // nodes: the ends of the edges, merged within `tol`
    let mut nodes: Vec<Point> = Vec::new();
    let node_of = |p: Point, nodes: &mut Vec<Point>| -> usize {
        if let Some(i) = nodes.iter().position(|q| q.dist(p) < tol) {
            i
        } else {
            nodes.push(p);
            nodes.len() - 1
        }
    };
    let ends: Vec<(usize, usize)> = edges
        .iter()
        .map(|e| {
            let a = node_of(e.pts[0], &mut nodes);
            let b = if e.closed { a } else { node_of(*e.pts.last().unwrap(), &mut nodes) };
            (a, b)
        })
        .collect();
    let mut adj: Vec<Vec<usize>> = vec![Vec::new(); nodes.len()];
    for (e, &(a, b)) in ends.iter().enumerate() {
        adj[a].push(e);
        if b != a {
            adj[b].push(e);
        }
    }
    let mut used = vec![false; edges.len()];
    let mut seen = vec![false; nodes.len()];
    let mut steps: Vec<Step> = Vec::new();
    let degree = |n: usize| adj[n].iter().map(|&e| if ends[e].0 == ends[e].1 { 2 } else { 1 }).sum::<usize>();
    let len_of = |e: usize| polyline_length(&edges[e].pts);
    // part by part: a free end nearest the needle starts it (else the nearest node)
    while let Some(start) = (0..nodes.len()).filter(|&n| adj[n].iter().any(|&e| !used[e])).min_by(|&a, &b| {
        let key = |n: usize| (degree(n) != 1, nodes[n].dist(*pos));
        key(a).partial_cmp(&key(b)).unwrap()
    }) {
        // the depth-first tree: at every node its loops, its edges back to a
        // node already reached (sewn out and back) and its children
        let mut items: std::collections::HashMap<usize, Vec<Item>> = Default::default();
        let mut order: Vec<usize> = vec![start];
        seen[start] = true;
        let mut stack = vec![start];
        while let Some(&u) = stack.last() {
            let next = adj[u].iter().copied().filter(|&e| !used[e]).min_by(|&a, &b| len_of(a).partial_cmp(&len_of(b)).unwrap());
            let Some(e) = next else {
                stack.pop();
                continue;
            };
            used[e] = true;
            let (a, b) = ends[e];
            let fwd = a == u;
            let v = if fwd { b } else { a };
            let item = if v == u {
                Item::Loop(e)
            } else if seen[v] {
                Item::Back(e, fwd, v)
            } else {
                seen[v] = true;
                order.push(v);
                stack.push(v);
                Item::Child(e, fwd, v)
            };
            items.entry(u).or_default().push(item);
        }
        // the deepest branch of every node last: the walk ends down it
        let mut depth: std::collections::HashMap<usize, f64> = Default::default();
        for &u in order.iter().rev() {
            let list = items.entry(u).or_default();
            let d = list.iter().map(|it| if let Item::Child(e, _, v) = it { len_of(*e) + depth.get(v).copied().unwrap_or(0.0) } else { 0.0 }).fold(0.0, f64::max);
            if let Some(i) = list
                .iter()
                .enumerate()
                .filter_map(|(i, it)| if let Item::Child(e, _, v) = it { Some((i, len_of(*e) + depth.get(v).copied().unwrap_or(0.0))) } else { None })
                .max_by(|x, y| x.1.partial_cmp(&y.1).unwrap())
                .map(|x| x.0)
            {
                let it = list.remove(i);
                list.push(it);
            }
            depth.insert(u, d);
        }
        let end = emit(start, true, &items, &mut steps);
        *pos = nodes[end];
    }
    steps
}

/// What hangs off a node of the walk's tree.
#[derive(Clone, Copy)]
enum Item {
    /// An edge from the node back to itself.
    Loop(usize),
    /// An edge to a node reached already (that node): out under itself and back.
    Back(usize, bool, usize),
    /// A tree edge to a child node.
    Child(usize, bool, usize),
}

/// The steps of the subtree at `u`. On the final chain the last item is sewn
/// forward and the walk ends below it; elsewhere every branch comes back.
/// Returns the node the walk ends at.
fn emit(u: usize, chain: bool, items: &std::collections::HashMap<usize, Vec<Item>>, steps: &mut Vec<Step>) -> usize {
    let list = items.get(&u).map(|v| v.as_slice()).unwrap_or(&[]);
    let n = list.len();
    for (i, it) in list.iter().enumerate() {
        let last = chain && i + 1 == n;
        match *it {
            Item::Loop(e) => steps.push(Step::Sew(e, true)),
            Item::Back(e, fwd, v) if last => {
                // nothing left to come back for: sewn once, ending over there
                steps.push(Step::Sew(e, fwd));
                return v;
            }
            Item::Back(e, fwd, _) => steps.push(Step::OutBack(e, fwd)),
            Item::Child(e, fwd, v) if last => {
                steps.push(Step::Sew(e, fwd));
                return emit(v, true, items, steps);
            }
            Item::Child(e, fwd, v) => {
                let mark = steps.len();
                steps.push(Step::Path(e, fwd));
                emit(v, false, items, steps);
                if steps.len() == mark + 1 {
                    // a dead end: one column out under itself and back
                    steps.pop();
                    steps.push(Step::OutBack(e, fwd));
                } else {
                    steps.push(Step::Sew(e, !fwd));
                }
            }
        }
    }
    u
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geom::pt;

    fn line(pts: &[(f64, f64)], satin: bool) -> Object {
        let p: Vec<Point> = pts.iter().map(|&(x, y)| pt(x, y)).collect();
        Object {
            id: "o".into(),
            name: "Black line 1".into(),
            thread: "t".into(),
            visible: true,
            locked: false,
            paths: vec![SubPath::polyline(&p, false)],
            stitch: if satin { StitchParams::Satin(SatinParams { width: 1.2, ..Default::default() }) } else { StitchParams::Running(RunningParams::default()) },
            trim_after: false,
            stop_after: false,
            ties: Default::default(),
            force_lock: false,
            min_stitch: None,
            min_jump: None,
            clone: None,
            hidden: None,
            patterns: vec![],
            start: None,
            end: None,
            lock: None,
            color_sort_index: None,
        }
    }

    fn ends(o: &Object, doc: &crate::model::Document) -> (Point, Point) {
        let _ = doc;
        let runs = crate::stitches::generate(o, &crate::model::Fabric::Cotton.profile());
        let pts: Vec<Point> = runs.iter().flatten().map(|x| x.0).collect();
        (pts[0], *pts.last().unwrap())
    }

    #[test]
    fn a_comb_sews_without_jumps() {
        // a spine with three teeth (T junctions) and a bar across them (X)
        let objs = vec![
            line(&[(0.0, 0.0), (30.0, 0.0)], true),
            line(&[(5.0, 0.0), (5.0, 10.0)], true),
            line(&[(15.0, 0.0), (15.0, 10.0)], true),
            line(&[(25.0, 0.0), (25.0, 10.0)], true),
            line(&[(0.0, 5.0), (30.0, 5.0)], true),
        ];
        let routed = route_lines(objs, pt(0.0, 0.0));
        let doc = crate::model::Document::default();
        // every object begins near where the one before ended
        let mut prev: Option<Point> = None;
        for o in &routed {
            let (a, b) = ends(o, &doc);
            if let Some(p) = prev {
                assert!(p.dist(a) < 1.5, "{} starts {:.2} mm from the last end", o.name, p.dist(a));
            }
            prev = Some(b);
        }
        // every piece of every line is sewn as a column exactly once
        let sewn: f64 = routed.iter().filter(|o| matches!(o.stitch, StitchParams::Satin(_))).map(|o| polyline_length(&o.paths[0].flatten(0.05))).sum();
        assert!((sewn - (30.0 + 3.0 * 10.0 + 30.0)).abs() < 1.0, "sewn {sewn}");
        // and every path runs where a column covers it later
        for (i, o) in routed.iter().enumerate().filter(|(_, o)| matches!(o.stitch, StitchParams::Running(_))) {
            let p = o.paths[0].flatten(0.05);
            let mid = p[p.len() / 2];
            let covered = routed[i + 1..].iter().any(|c| matches!(c.stitch, StitchParams::Satin(_)) && c.paths[0].flatten(0.05).windows(2).any(|w| seg_project(mid, w[0], w[1]).1.dist(mid) < 0.1));
            assert!(covered, "{} is never covered", o.name);
        }
    }
}
