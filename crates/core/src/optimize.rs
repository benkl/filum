//! Global stitch-order optimisation (not available in Ink/Stitch).
//!
//! Builds a precedence DAG — object *A* must stay before *B* when they overlap
//! and use different spools (so stacking is preserved), or the same spool
//! where the order shows (a detail, border or appliqué on top of a fill,
//! see [`order_shows`]) — then performs a topological sort that greedily
//! keeps the current spool (minimising colour changes) and, within a spool,
//! picks the object the needle reaches soonest (minimising jumps/trims).
//! Other same-spool objects may be freely reordered.
//! A spool is a thread colour + brand + code: threads fitted or merged onto
//! the same spool count as one colour. A layered 3D satin starts on its inner
//! thread's spool and ends on its own.
//!
//! Every step is optional ([`OptimizeOptions`]): grouping colours, the
//! shorter way within a colour, 3D foam last, which objects may move (locked
//! ones, the selection: the others stay put and split the order into
//! stretches optimised one by one), hand-set connections that no longer join
//! the same objects, and end points moved towards the next object.

use serde::{Deserialize, Serialize};

use crate::assemble::{starts_near, Engine};
use crate::geom::{Point, Rect};
use crate::model::{Document, Object, SatinParams, StitchParams};
use crate::plan::{flags, StitchPlan};
use crate::region::{covers_overlap, object_cover, Cover};
use crate::stitches::layered3d::start_thread;

/// What the optimiser may change. Absent fields: the defaults.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct OptimizeOptions {
    /// Sew each thread's objects together: fewer colour changes.
    pub colors: bool,
    /// Within a thread, the object the needle reaches soonest next: shorter jumps, fewer trims.
    pub travel: bool,
    /// 3D foam as late as the stacking allows (anything sewn after it flattens it).
    pub foam_last: bool,
    /// Locked objects may move too (else they stay where they are).
    pub locked: bool,
    /// Only these objects may move (by id; none: all).
    pub selection: Option<Vec<String>>,
    /// A Sew or Jump set by hand goes back to Automatic when the next object changes.
    pub links: bool,
    /// Each object ends towards the next one in its thread when that saves travel.
    pub ends: bool,
    /// Centre out: objects near the middle of the design first, so the fabric
    /// is pushed towards the edges; on caps also bottom up (the brim first).
    pub center_out: bool,
}

impl Default for OptimizeOptions {
    fn default() -> Self {
        OptimizeOptions { colors: true, travel: true, foam_last: true, locked: false, selection: None, links: true, ends: true, center_out: false }
    }
}

impl OptimizeOptions {
    /// The defaults on a fabric: centre out on caps and the fabrics that
    /// stretch (as the editor's Optimise menu starts).
    pub fn for_fabric(fabric: crate::model::Fabric) -> Self {
        use crate::model::Fabric::*;
        OptimizeOptions { center_out: matches!(fabric, Cap | Knit | Fleece | Towel | Pique), ..Default::default() }
    }
}

/// An end point the optimiser set.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct EndPoint {
    pub id: String,
    pub end: [f64; 2],
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OptimizeReport {
    pub order: Vec<String>,
    pub color_changes_before: usize,
    pub color_changes_after: usize,
    pub trims_before: usize,
    pub trims_after: usize,
    /// The length of the jumps (mm).
    pub travel_before_mm: f64,
    pub travel_after_mm: f64,
    /// End points moved towards the next object.
    pub ends: Vec<EndPoint>,
    /// Objects whose Sew or Jump went back to Automatic.
    pub links_reset: Vec<String>,
}

/// Does it show which of two overlapping objects in the same thread is sewn
/// first (`lower` before `upper` as drawn)? When they are stitched
/// differently, or the upper one is a line or detail sewn on top (running,
/// satin, manual, appliqué), or either stops the machine: a border sewn
/// before the fill under it disappears under the fill.
fn order_shows(lower: &Object, upper: &Object) -> bool {
    std::mem::discriminant(&lower.stitch) != std::mem::discriminant(&upper.stitch)
        || matches!(upper.stitch, StitchParams::Running(_) | StitchParams::Satin(_) | StitchParams::Manual(_) | StitchParams::Applique(_))
        || lower.stop_after
        || upper.stop_after
}

fn is_foam(o: &Object) -> bool {
    matches!(o.stitch, StitchParams::Satin(SatinParams { foam: Some(_), .. }))
}

/// Starts where the previous object ended (no start point of its own).
fn starts_after(o: &Object) -> bool {
    o.start.is_none() && starts_near(&o.stitch)
}

/// Snapped to half a millimetre, as the plan does (the stitches stay cached).
fn snap(p: Point) -> [f64; 2] {
    [(p.x * 2.0).round() / 2.0, (p.y * 2.0).round() / 2.0]
}

fn rect_dist(r: &Rect, p: Point) -> f64 {
    let dx = (r.min_x - p.x).max(0.0).max(p.x - r.max_x);
    let dy = (r.min_y - p.y).max(0.0).max(p.y - r.max_y);
    dx.hypot(dy)
}

/// An object's outline as points at most 1 mm apart.
fn outline(o: &Object) -> Vec<Point> {
    let mut out = Vec::new();
    for sp in &o.paths {
        let pts = sp.flatten(0.1);
        for w in pts.windows(2) {
            let n = (w[0].dist(w[1]).ceil() as usize).clamp(1, 10_000);
            for k in 0..n {
                let t = k as f64 / n as f64;
                out.push(Point { x: w[0].x + (w[1].x - w[0].x) * t, y: w[0].y + (w[1].y - w[0].y) * t });
            }
        }
        if let Some(&l) = pts.last() {
            out.push(l);
        }
    }
    out.retain(|p| p.x.is_finite() && p.y.is_finite());
    out
}

/// What the optimiser knows of every object: where it can be reached, its spools.
struct Geo<'a> {
    doc: &'a Document,
    bounds: Vec<Rect>,
    outlines: Vec<Option<Vec<Point>>>,
    firsts: Vec<Option<Point>>,
}

impl<'a> Geo<'a> {
    fn new(doc: &'a Document) -> Self {
        let n = doc.objects.len();
        Geo { doc, bounds: doc.objects.iter().map(|o| o.bounds()).collect(), outlines: vec![None; n], firsts: vec![None; n] }
    }
    fn outline(&mut self, i: usize) -> &[Point] {
        let doc: &'a Document = self.doc;
        self.outlines[i].get_or_insert_with(|| outline(&doc.objects[i]))
    }
    /// Where an object with its own start begins.
    fn first(&mut self, engine: &mut Engine, i: usize) -> Point {
        if let Some(p) = self.firsts[i] {
            return p;
        }
        let doc: &'a Document = self.doc;
        let p = engine.runs_as_sewn(doc, &doc.objects[i], true).first().and_then(|r| r.first()).map(|s| s.0).unwrap_or_else(|| self.bounds[i].center());
        self.firsts[i] = Some(p);
        p
    }
    /// How far the needle goes from `p` to object `i`: to the nearest point
    /// of its outline when it starts near the previous object, else to its
    /// first stitch. `limit`: stop looking once it can't be nearer.
    fn reach(&mut self, engine: &mut Engine, p: Point, i: usize, limit: f64) -> f64 {
        if !starts_after(&self.doc.objects[i]) {
            return p.dist(self.first(engine, i));
        }
        if rect_dist(&self.bounds[i], p) >= limit {
            return f64::INFINITY;
        }
        self.outline(i).iter().map(|q| q.dist(p)).fold(f64::INFINITY, f64::min)
    }
    /// The point of object `i` nearest to object `j` (where `j` will start).
    fn towards(&mut self, engine: &mut Engine, i: usize, j: usize) -> Option<Point> {
        let a: Vec<Point> = self.outline(i).to_vec();
        if starts_after(&self.doc.objects[j]) {
            let b: Vec<Point> = self.outline(j).to_vec();
            let bj = self.bounds[j];
            let mut best = (f64::INFINITY, None);
            for &p in &a {
                if rect_dist(&bj, p) >= best.0 {
                    continue;
                }
                for &q in &b {
                    let d = p.dist(q);
                    if d < best.0 {
                        best = (d, Some(p));
                    }
                }
            }
            best.1
        } else {
            let f = self.first(engine, j);
            a.into_iter().min_by(|p, q| p.dist(f).total_cmp(&q.dist(f)))
        }
    }
}

/// The plan's colour changes, trims and jump length (mm).
fn measure(plan: &StitchPlan) -> (usize, usize, f64) {
    let (mut cc, mut trims, mut jump) = (0, 0, 0.0);
    let mut prev: Option<Point> = None;
    for s in &plan.stitches {
        let p = Point { x: s.x, y: s.y };
        if s.flags & flags::COLOR_CHANGE != 0 {
            cc += 1;
        }
        if s.flags & flags::TRIM != 0 {
            trims += 1;
        }
        if s.flags & flags::JUMP != 0 {
            if let Some(q) = prev {
                jump += q.dist(p);
            }
        }
        prev = Some(p);
    }
    (cc, trims, jump)
}

/// [`optimize`] with the default options.
pub fn optimize_order(doc: &Document, engine: &mut Engine) -> OptimizeReport {
    optimize(doc, engine, &OptimizeOptions::default())
}

/// Compute an optimised order (and the end points and connections that go
/// with it). Objects that sew nothing go to the end of their stretch.
pub fn optimize(doc: &Document, engine: &mut Engine, opts: &OptimizeOptions) -> OptimizeReport {
    let n = doc.objects.len();
    let mut geo = Geo::new(doc);
    let bounds = geo.bounds.clone();
    // objects without geometry sew nothing
    let sews = |i: usize| doc.objects[i].visible && !bounds[i].is_empty() && bounds[i].center().x.is_finite() && bounds[i].center().y.is_finite();
    // objects on the same spool count as one colour; a layered 3D begins on its inner thread
    let spool_in: Vec<String> = doc.objects.iter().map(|o| doc.spool_of(start_thread(o, doc))).collect();
    let spool_out: Vec<String> = doc.objects.iter().map(|o| doc.spool_of(&o.thread)).collect();
    let movable: Vec<bool> = doc.objects.iter().map(|o| (opts.locked || !o.locked) && opts.selection.as_ref().map_or(true, |s| s.contains(&o.id))).collect();

    // stretches: an object that stays put is a stretch of its own; without
    // grouping colours every colour block is one too
    let mut stretch = vec![0usize; n];
    let mut b = 0usize;
    let mut last_out: Option<&str> = None;
    for i in 0..n {
        if !movable[i] {
            b += 1;
            stretch[i] = b;
            b += 1;
            last_out = None;
            continue;
        }
        if sews(i) {
            if !opts.colors && last_out.is_some_and(|l| l != spool_in[i]) {
                b += 1;
            }
            last_out = Some(&spool_out[i]);
        }
        stretch[i] = b;
    }

    // precedence within a stretch: preds[j] = number of unresolved predecessors
    let sewing: Vec<usize> = (0..n).filter(|i| sews(*i)).collect();
    let mut succ: Vec<Vec<usize>> = vec![vec![]; n];
    let mut preds = vec![0usize; n];
    let mut covers: Vec<Option<Vec<Cover>>> = vec![None; n];
    for (a, &i) in sewing.iter().enumerate() {
        for &j in sewing.iter().skip(a + 1) {
            if stretch[i] != stretch[j] || !bounds[i].intersects(&bounds[j]) {
                continue;
            }
            let keep = spool_out[i] != spool_in[j] || spool_in[i] != spool_out[j] || {
                order_shows(&doc.objects[i], &doc.objects[j]) && {
                    for k in [i, j] {
                        covers[k].get_or_insert_with(|| object_cover(&doc.objects[k]));
                    }
                    covers_overlap(covers[i].as_deref().unwrap_or_default(), covers[j].as_deref().unwrap_or_default())
                }
            };
            if keep {
                succ[i].push(j);
                preds[j] += 1;
            }
        }
    }

    let mut order: Vec<usize> = Vec::with_capacity(n);
    let mut cur: Option<String> = None;
    // centre out: how far each object lies from where sewing should begin (mm); else the original order decides
    let key: Vec<f64> = if opts.center_out {
        let all = sewing.iter().fold(Rect::EMPTY, |r, &i| r.union(&bounds[i]));
        let c = all.center();
        let cap = doc.fabric == crate::model::Fabric::Cap;
        bounds
            .iter()
            .map(|b| if b.is_empty() { f64::INFINITY } else if cap { (b.center().x - c.x).abs() + (all.max_y - b.center().y) } else { b.center().dist(c) })
            .collect()
    } else {
        (0..n).map(|i| i as f64).collect()
    };
    let first = |v: &[usize]| *v.iter().min_by(|a, b| key[**a].total_cmp(&key[**b]).then(a.cmp(b))).unwrap();
    let mut pos: Option<Point> = None;
    let mut i0 = 0;
    while i0 < n {
        let s = stretch[i0];
        let members: Vec<usize> = (i0..n).take_while(|i| stretch[*i] == s).collect();
        i0 += members.len();
        let mut available: Vec<usize> = members.iter().copied().filter(|i| sews(*i) && preds[*i] == 0).collect();
        while !available.is_empty() {
            let mut cand: Vec<usize> = available.clone();
            if opts.foam_last && cand.iter().any(|i| !is_foam(&doc.objects[*i])) {
                cand.retain(|i| !is_foam(&doc.objects[*i]));
            }
            // the thread to sew: the current one while it has objects, else the one whose object comes
            // first (in the drawing's order, or nearest the middle with centre out)
            let mut pool: Vec<usize> = if opts.colors {
                let t = match &cur {
                    Some(t) if cand.iter().any(|i| &spool_in[*i] == t) => t.clone(),
                    _ => spool_in[first(&cand)].clone(),
                };
                cand.iter().copied().filter(|i| spool_in[*i] == t).collect()
            } else {
                cand
            };
            // the objects that stay on the thread before one that leaves it (a layered 3D)
            if pool.iter().any(|i| spool_in[*i] == spool_out[*i]) {
                pool.retain(|i| spool_in[*i] == spool_out[*i]);
            }
            // centre out weighs the distance from the middle against the way there
            let weight = |i: usize| if opts.center_out { key[i] } else { 0.0 };
            let pick = match (opts.travel, pos) {
                (true, Some(p)) => {
                    // nearest first, the bounds telling which ones can't win
                    let mut by: Vec<(f64, usize)> = pool.iter().map(|&i| (rect_dist(&bounds[i], p) + weight(i), i)).collect();
                    by.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.cmp(&b.1)));
                    let mut best = (f64::INFINITY, usize::MAX);
                    for (lower, i) in by {
                        // the first stitch and the outline lie within the bounds
                        if lower > best.0 {
                            break;
                        }
                        let d = geo.reach(engine, p, i, best.0 - weight(i) + 1e-9) + weight(i);
                        if d < best.0 || (d == best.0 && i < best.1) {
                            best = (d, i);
                        }
                    }
                    if best.1 == usize::MAX { first(&pool) } else { best.1 }
                }
                _ => first(&pool),
            };
            available.retain(|x| *x != pick);
            order.push(pick);
            cur = Some(spool_out[pick].clone());
            // where the needle ends, starting where the plan would start it
            let o = &doc.objects[pick];
            let runs = match pos {
                Some(p) if starts_after(o) => engine.runs_as_sewn(doc, &Object { start: Some(snap(p)), ..o.clone() }, false),
                _ => engine.runs_as_sewn(doc, o, true),
            };
            pos = runs.last().and_then(|r| r.last()).map(|x| x.0).or(pos);
            for &s in &succ[pick] {
                preds[s] -= 1;
                if preds[s] == 0 {
                    available.push(s);
                }
            }
        }
        // what sews nothing ends the stretch
        order.extend(members.iter().copied().filter(|i| !sews(*i)));
    }

    // the design in the new order
    let mut after = doc.clone();
    after.objects = order.iter().map(|&i| doc.objects[i].clone()).collect();

    // a Sew or Jump chosen by hand joined two objects: when the next one changes, it goes back to Automatic
    let next_of = |seq: &[usize]| -> Vec<Option<usize>> {
        let mut next = vec![None; n];
        let s: Vec<usize> = seq.iter().copied().filter(|i| sews(*i)).collect();
        for w in s.windows(2) {
            next[w[0]] = Some(w[1]);
        }
        next
    };
    let mut links_reset = Vec::new();
    if opts.links {
        let (was, now) = (next_of(&(0..n).collect::<Vec<_>>()), next_of(&order));
        for (k, &i) in order.iter().enumerate() {
            if movable[i] && doc.objects[i].link.is_some() && was[i] != now[i] {
                after.objects[k].link = None;
                links_reset.push(doc.objects[i].id.clone());
            }
        }
    }

    // end points: each object ends towards the next one in its thread, when that saves more than a millimetre
    let mut ends = Vec::new();
    if opts.ends {
        let seq: Vec<usize> = (0..n).filter(|k| sews(order[*k])).collect();
        let mut pos: Option<Point> = None;
        for (w, &k) in seq.iter().enumerate() {
            let i = order[k];
            let o = after.objects[k].clone();
            let (sewn, pinned) = match pos {
                Some(p) if starts_after(&o) => (Object { start: Some(snap(p)), ..o.clone() }, false),
                _ => (o.clone(), true),
            };
            let runs = engine.runs_as_sewn(&after, &sewn, pinned);
            let mut exit = runs.last().and_then(|r| r.last()).map(|x| x.0).or(pos);
            if let (Some(&nk), Some(ex)) = (seq.get(w + 1), exit) {
                let j = order[nk];
                if movable[i] && starts_near(&o.stitch) && spool_out[i] == spool_in[j] {
                    let now = geo.reach(engine, ex, j, f64::INFINITY);
                    if let Some(t) = geo.towards(engine, i, j) {
                        let end = [(t.x * 10.0).round() / 10.0, (t.y * 10.0).round() / 10.0];
                        if o.end != Some(end) {
                            let moved = engine.runs_as_sewn(&after, &Object { end: Some(end), ..sewn.clone() }, pinned);
                            if let Some(ex2) = moved.last().and_then(|r| r.last()).map(|x| x.0) {
                                if geo.reach(engine, ex2, j, f64::INFINITY) < now - 1.0 {
                                    after.objects[k].end = Some(end);
                                    ends.push(EndPoint { id: o.id.clone(), end });
                                    exit = Some(ex2);
                                }
                            }
                        }
                    }
                }
            }
            pos = exit;
        }
    }

    let (cc0, tr0, tv0) = measure(&engine.plan(doc));
    let (mut cc1, mut tr1, mut tv1) = measure(&engine.plan(&after));
    // the end points are worked out from the objects as drawn: the plan has the last word
    if !ends.is_empty() {
        let mut plain = after.clone();
        for (k, o) in plain.objects.iter_mut().enumerate() {
            o.end = doc.objects[order[k]].end;
        }
        let (cc, tr, tv) = measure(&engine.plan(&plain));
        // kept when they save a trim, or half a millimetre of jumps without costing one
        let better = tr1 < tr || (tr1 == tr && tv1 < tv - 0.5);
        if !better {
            ends.clear();
            (cc1, tr1, tv1) = (cc, tr, tv);
        }
    }
    OptimizeReport {
        order: order.iter().map(|&i| doc.objects[i].id.clone()).collect(),
        color_changes_before: cc0,
        color_changes_after: cc1,
        trims_before: tr0,
        trims_after: tr1,
        travel_before_mm: tv0,
        travel_after_mm: tv1,
        ends,
        links_reset,
    }
}

/// Apply an order (list of object ids) to a document.
pub fn apply_order(doc: &mut Document, order: &[String]) {
    let mut objs = std::mem::take(&mut doc.objects);
    let mut out = Vec::with_capacity(objs.len());
    for id in order {
        if let Some(k) = objs.iter().position(|o| &o.id == id) {
            out.push(objs.remove(k));
        }
    }
    out.extend(objs);
    doc.objects = out;
}

/// Apply a whole report: the order, the end points and the connections.
pub fn apply(doc: &mut Document, r: &OptimizeReport) {
    apply_order(doc, &r.order);
    for o in &mut doc.objects {
        if let Some(e) = r.ends.iter().find(|e| e.id == o.id) {
            o.end = Some(e.end);
        }
        if r.links_reset.contains(&o.id) {
            o.link = None;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geom::pt;
    use crate::model::*;

    fn sq(id: &str, thread: &str, x: f64, y: f64) -> Object {
        Object::new(id, thread, vec![SubPath::polyline(&[pt(x, y), pt(x + 5.0, y), pt(x + 5.0, y + 5.0), pt(x, y + 5.0)], true)], StitchParams::Fill(FillParams { underlay: false, ..Default::default() }))
    }

    #[test]
    fn merges_colors_without_breaking_stacking() {
        let mut doc = Document::default();
        // red A, blue B (on top of A), red C (separate), blue D (separate)
        doc.objects = vec![sq("A", "red", 0.0, 0.0), sq("B", "blue", 2.0, 2.0), sq("C", "red", 30.0, 0.0), sq("D", "blue", 60.0, 0.0)];
        let mut e = Engine::new();
        let r = optimize_order(&doc, &mut e);
        assert_eq!(r.color_changes_before, 3);
        assert_eq!(r.color_changes_after, 1);
        let pos = |id: &str| r.order.iter().position(|x| x == id).unwrap();
        assert!(pos("A") < pos("B"), "stacking broken: {:?}", r.order);
    }

    #[test]
    fn objects_without_geometry_do_not_panic() {
        let mut doc = Document::default();
        let mut no_paths = sq("B", "red", 0.0, 0.0);
        no_paths.paths = vec![];
        let mut no_nodes = sq("D", "red", 0.0, 0.0);
        no_nodes.paths = vec![SubPath { nodes: vec![], closed: false }];
        doc.objects = vec![sq("A", "red", 0.0, 0.0), no_paths, sq("C", "red", 0.0, 10.0), no_nodes, sq("E", "red", 20.0, 0.0)];
        let r = optimize_order(&doc, &mut Engine::new());
        assert_eq!(r.order.len(), 5);
        assert!(r.travel_after_mm.is_finite() && r.travel_before_mm.is_finite());
        // the empty ones go to the end
        assert_eq!(&r.order[3..], &["B".to_string(), "D".to_string()]);
    }

    fn ids(r: &OptimizeReport) -> String {
        r.order.join(" ")
    }

    fn thread(id: &str, color: &str) -> Thread {
        Thread::new(id, id, color)
    }

    /// A satin column along a centre line from (x, y), 20 mm long.
    fn column(id: &str, thread: &str, x: f64, y: f64, sp: SatinParams) -> Object {
        Object { paths: vec![SubPath::polyline(&[pt(x, y), pt(x + 20.0, y)], false)], stitch: StitchParams::Satin(SatinParams { width: 4.0, ..sp }), ..sq(id, thread, x, y) }
    }

    fn four() -> Document {
        let mut doc = Document::default();
        doc.objects = vec![sq("A", "red", 0.0, 0.0), sq("B", "blue", 30.0, 0.0), sq("C", "red", 60.0, 0.0), sq("D", "blue", 90.0, 0.0)];
        doc
    }

    #[test]
    fn locked_objects_stay_put() {
        let mut doc = four();
        assert_eq!(ids(&optimize_order(&doc, &mut Engine::new())), "A C B D");
        doc.objects[1].locked = true;
        // B splits the order: A before it, C and D after it
        assert_eq!(ids(&optimize_order(&doc, &mut Engine::new())), "A B D C", "D follows B in blue");
        let r = optimize(&doc, &mut Engine::new(), &OptimizeOptions { locked: true, ..Default::default() });
        assert_eq!(ids(&r), "A C B D");
    }

    #[test]
    fn only_the_selection_moves() {
        let mut doc = four();
        doc.objects.push(sq("E", "red", 120.0, 0.0));
        // C, D and E may move: A and B stay first, D follows B in blue, the red E joins C
        let r = optimize(&doc, &mut Engine::new(), &OptimizeOptions { selection: Some(vec!["C".into(), "D".into(), "E".into()]), ..Default::default() });
        assert_eq!(ids(&r), "A B D C E");
    }

    #[test]
    fn without_grouping_colours_the_blocks_stay() {
        let mut doc = Document::default();
        doc.objects = vec![sq("A", "red", 0.0, 0.0), sq("B", "red", 60.0, 0.0), sq("C", "red", 10.0, 0.0), sq("D", "blue", 100.0, 0.0), sq("E", "red", 20.0, 0.0)];
        let r = optimize(&doc, &mut Engine::new(), &OptimizeOptions { colors: false, ..Default::default() });
        // the shorter way within the first red block; blue and the last red stay where they are
        assert_eq!(ids(&r), "A C B D E");
        let r = optimize(&doc, &mut Engine::new(), &OptimizeOptions { colors: false, travel: false, ends: false, ..Default::default() });
        assert_eq!(ids(&r), "A B C D E", "nothing allowed: nothing moves");
        assert!(r.ends.is_empty() && r.links_reset.is_empty());
    }

    #[test]
    fn foam_goes_last_as_far_as_the_stacking_allows() {
        let foam = SatinParams { foam: Some(FoamOptions::default()), ..Default::default() };
        let mut doc = Document::default();
        // the foam column, then a red square elsewhere, then a blue one on top of the foam
        doc.objects = vec![column("F", "red", 0.0, 50.0, foam), sq("A", "red", 40.0, 0.0), sq("B", "blue", 5.0, 48.0)];
        let r = optimize_order(&doc, &mut Engine::new());
        assert_eq!(ids(&r), "A F B", "after A, before the square sewn on top of it");
        doc.objects.pop();
        assert_eq!(ids(&optimize_order(&doc, &mut Engine::new())), "A F");
        let r = optimize(&doc, &mut Engine::new(), &OptimizeOptions { foam_last: false, ..Default::default() });
        assert_eq!(ids(&r), "F A");
    }

    #[test]
    fn a_layered_column_follows_its_inner_thread() {
        let layered = SatinParams { layered: Some(LayeredOptions { layers: 2, base_thread: Some("blue".into()), ..Default::default() }), width: 8.0, ..Default::default() };
        let mut doc = Document::default();
        doc.threads = vec![thread("red", "#ff0000"), thread("blue", "#0000ff")];
        doc.objects = vec![sq("A", "red", 0.0, 0.0), column("L", "red", 30.0, 0.0, SatinParams { width: 8.0, ..layered }), sq("B", "blue", 60.0, 0.0), sq("C", "red", 90.0, 0.0)];
        let r = optimize_order(&doc, &mut Engine::new());
        // red A, C; blue B, then the column (blue inside, red on top)
        assert_eq!(ids(&r), "A C B L");
        assert_eq!(r.color_changes_after, 2);
    }

    #[test]
    fn a_hand_set_connection_goes_back_to_automatic_when_its_next_object_changes() {
        let mut doc = four();
        doc.objects[0].link = Some(ObjectLink::Join);
        doc.objects[2].link = Some(ObjectLink::Jump);
        let r = optimize_order(&doc, &mut Engine::new());
        assert_eq!(ids(&r), "A C B D");
        assert_eq!(r.links_reset, vec!["A".to_string(), "C".to_string()]);
        let r = optimize(&doc, &mut Engine::new(), &OptimizeOptions { links: false, ..Default::default() });
        assert!(r.links_reset.is_empty());
        let mut d = doc.clone();
        apply(&mut d, &optimize_order(&doc, &mut Engine::new()));
        assert!(d.objects.iter().all(|o| o.link.is_none()));
    }

    #[test]
    fn end_points_towards_the_next_object_shorten_the_jumps() {
        let mut doc = Document::default();
        let tall = |id: &str, x: f64| Object { paths: vec![SubPath::polyline(&[pt(x, 0.0), pt(x + 10.0, 0.0), pt(x + 10.0, 60.0), pt(x, 60.0)], true)], ..sq(id, "red", 0.0, 0.0) };
        doc.objects = vec![tall("A", 0.0), tall("B", 30.0)];
        let without = optimize(&doc, &mut Engine::new(), &OptimizeOptions { ends: false, ..Default::default() });
        let with = optimize_order(&doc, &mut Engine::new());
        // A ends on the side towards B (B is last: nothing to end towards)
        assert_eq!(with.ends.len(), 1, "{:?}", with.ends);
        assert!(with.ends[0].id == "A" && with.ends[0].end[0] > 5.0, "{:?}", with.ends);
        assert!(with.travel_after_mm < without.travel_after_mm - 10.0, "{} vs {}", with.travel_after_mm, without.travel_after_mm);
    }

    #[test]
    fn centre_out_sews_the_middle_first() {
        let mut doc = Document::default();
        // a row of red squares; the middle one (C) is drawn last
        doc.objects = vec![sq("A", "red", 0.0, 0.0), sq("B", "red", 20.0, 0.0), sq("D", "red", 60.0, 0.0), sq("E", "red", 80.0, 0.0), sq("C", "red", 40.0, 0.0)];
        assert_eq!(ids(&optimize_order(&doc, &mut Engine::new())), "A B C D E");
        let r = optimize(&doc, &mut Engine::new(), &OptimizeOptions { center_out: true, ..Default::default() });
        assert_eq!(&r.order[0], "C", "{:?}", r.order);
        // then outwards: each next object at least as far from the middle as the one before... or its neighbour
        let far = |id: &str| (["A", "B", "C", "D", "E"].iter().position(|x| *x == id).unwrap() as i32 - 2).abs();
        assert!(far(&r.order[4]) == 2, "an end last: {:?}", r.order);
        // on a cap, the bottom first: a square below the middle row goes before the row
        doc.fabric = crate::model::Fabric::Cap;
        doc.objects.push(sq("Z", "red", 40.0, 30.0));
        let r = optimize(&doc, &mut Engine::new(), &OptimizeOptions { center_out: true, ..Default::default() });
        assert_eq!(&r.order[0], "Z", "{:?}", r.order);
    }
}
