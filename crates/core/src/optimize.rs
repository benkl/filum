//! Global stitch-order optimisation (not available in Ink/Stitch).
//!
//! Builds a precedence DAG — object *A* must stay before *B* when they overlap
//! and use different spools (so stacking is preserved) — then performs a
//! topological sort that greedily keeps the current spool (minimising colour
//! changes) and, within a spool, picks the nearest available object
//! (minimising jumps/trims). Same-spool objects may be freely reordered.
//! A spool is a thread colour + brand + code: threads fitted or merged onto
//! the same spool count as one colour.

use serde::Serialize;

use crate::assemble::Engine;
use crate::geom::{Point, Rect};
use crate::model::Document;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OptimizeReport {
    pub order: Vec<String>,
    pub color_changes_before: usize,
    pub color_changes_after: usize,
    pub travel_before_mm: f64,
    pub travel_after_mm: f64,
}

fn color_changes(doc: &Document, order: &[usize]) -> usize {
    let mut n = 0;
    let mut last: Option<String> = None;
    for &i in order {
        let t = doc.spool_of(&doc.objects[i].thread);
        if last.as_ref().is_some_and(|l| *l != t) {
            n += 1;
        }
        last = Some(t);
    }
    n
}

fn travel(ends: &[(Point, Point)], order: &[usize]) -> f64 {
    order.windows(2).map(|w| ends[w[0]].1.dist(ends[w[1]].0)).sum()
}

/// Compute an optimised order. Hidden objects keep their relative position at the end.
pub fn optimize_order(doc: &Document, engine: &mut Engine) -> OptimizeReport {
    let n = doc.objects.len();
    let bounds: Vec<Rect> = doc.objects.iter().map(|o| o.bounds()).collect();
    // objects without geometry sew nothing: they go to the end with the hidden ones
    let sews = |i: usize| doc.objects[i].visible && !bounds[i].is_empty() && bounds[i].center().x.is_finite() && bounds[i].center().y.is_finite();
    let visible: Vec<usize> = (0..n).filter(|i| sews(*i)).collect();
    // objects on the same spool count as one colour
    let spool: Vec<String> = doc.objects.iter().map(|o| doc.spool_of(&o.thread)).collect();
    // first / last needle position of every object
    let ends: Vec<(Point, Point)> = (0..n)
        .map(|i| {
            let runs = engine.object_runs(doc, i);
            let first = runs.first().and_then(|r| r.first()).map(|x| x.0);
            let last = runs.last().and_then(|r| r.last()).map(|x| x.0);
            let c = if bounds[i].is_empty() { Point { x: 0.0, y: 0.0 } } else { bounds[i].center() };
            (first.unwrap_or(c), last.unwrap_or(c))
        })
        .collect();

    // precedence: preds[j] = number of unresolved predecessors
    let mut succ: Vec<Vec<usize>> = vec![vec![]; n];
    let mut preds = vec![0usize; n];
    for (a, &i) in visible.iter().enumerate() {
        for &j in visible.iter().skip(a + 1) {
            if spool[i] != spool[j] && bounds[i].intersects(&bounds[j]) {
                succ[i].push(j);
                preds[j] += 1;
            }
        }
    }
    let mut available: Vec<usize> = visible.iter().copied().filter(|i| preds[*i] == 0).collect();
    let mut order = Vec::with_capacity(n);
    let mut cur_thread: Option<String> = None;
    let mut pos: Option<Point> = None;
    while !available.is_empty() {
        let same: Vec<usize> = match &cur_thread {
            Some(t) => available.iter().copied().filter(|i| &spool[*i] == t).collect(),
            None => vec![],
        };
        let pick = if !same.is_empty() {
            *same
                .iter()
                .min_by(|a, b| {
                    let da = pos.map_or(0.0, |p| p.dist(ends[**a].0));
                    let db = pos.map_or(0.0, |p| p.dist(ends[**b].0));
                    da.total_cmp(&db).then(a.cmp(b))
                })
                .unwrap()
        } else {
            // switch thread: prefer the thread with the earliest original object
            *available.iter().min().unwrap()
        };
        available.retain(|x| *x != pick);
        order.push(pick);
        cur_thread = Some(spool[pick].clone());
        pos = Some(ends[pick].1);
        for &s in &succ[pick] {
            preds[s] -= 1;
            if preds[s] == 0 {
                available.push(s);
            }
        }
    }
    let before: Vec<usize> = visible.clone();
    let report = OptimizeReport {
        color_changes_before: color_changes(doc, &before),
        color_changes_after: color_changes(doc, &order),
        travel_before_mm: travel(&ends, &before),
        travel_after_mm: travel(&ends, &order),
        order: order
            .iter()
            .copied()
            .chain((0..n).filter(|i| !sews(*i)))
            .map(|i| doc.objects[i].id.clone())
            .collect(),
    };
    report
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geom::pt;
    use crate::model::*;

    fn sq(id: &str, thread: &str, x: f64, y: f64) -> Object {
        Object {
            id: id.into(),
            name: id.into(),
            thread: thread.into(),
            visible: true,
            locked: false,
            paths: vec![SubPath::polyline(&[pt(x, y), pt(x + 5.0, y), pt(x + 5.0, y + 5.0), pt(x, y + 5.0)], true)],
            stitch: StitchParams::Fill(FillParams { underlay: false, ..Default::default() }),
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
}
