//! Element info (Ink/Stitch `element_info.py`): per object its type, method,
//! size, stitches, small stitches removed, jumps and the longest / shortest
//! stitch — and the same for the whole selection (colours, colour changes,
//! trims, stops).

use serde::Serialize;

use crate::assemble::Engine;
use crate::geom::{Point, Rect};
use crate::model::{Document, StitchParams};
use crate::plan::{flags, StitchPlan};

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectInfo {
    pub id: String,
    pub name: String,
    /// Thread colour `#rrggbb`.
    pub color: String,
    /// The stitch type ("fill", "satin", "running", "applique", "manual", "none").
    pub kind: String,
    /// Fill / satin method, or the running stitch's variant ("bean", "ripple", …).
    pub method: String,
    pub width: f64,
    pub height: f64,
    pub stitches: usize,
    /// Stitches shorter than the minimum stitch length, left out (Ink/Stitch
    /// "Small stitches (removed)").
    pub small_removed: usize,
    /// Jumps inside the object (not the one that brings the needle to it).
    pub jumps: usize,
    pub max_stitch: f64,
    pub min_stitch: f64,
    /// The object is not stitched (hidden, or fully covered with "remove hidden stitching").
    pub hidden: bool,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TotalInfo {
    pub objects: usize,
    pub width: f64,
    pub height: f64,
    /// Distinct thread colours.
    pub colors: usize,
    pub color_changes: usize,
    pub jumps: usize,
    pub trims: usize,
    pub stops: usize,
    pub stitches: usize,
    pub small_removed: usize,
    pub max_stitch: f64,
    pub min_stitch: f64,
    /// Ink/Stitch "Filter stitches smaller than (mm)": the machine setting.
    pub min_stitch_filter: f64,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ElementInfo {
    pub objects: Vec<ObjectInfo>,
    pub total: TotalInfo,
}

/// Type and method of an object's stitching, as ids.
fn kind_method(st: &StitchParams) -> (&'static str, String) {
    match st {
        StitchParams::None => ("none", String::new()),
        StitchParams::Manual(_) => ("manual", String::new()),
        StitchParams::Applique(_) => ("applique", String::new()),
        StitchParams::Fill(p) => ("fill", enum_id(&p.method)),
        StitchParams::Satin(p) => ("satin", enum_id(&p.method)),
        StitchParams::Running(p) => (
            "running",
            if p.ripple.is_some() {
                "ripple".into()
            } else if p.stem.is_some() {
                "stem".into()
            } else if p.motif.is_some() {
                "motif".into()
            } else if p.bean_repeats > 0 {
                "bean".into()
            } else {
                "running".into()
            },
        ),
    }
}

/// The serde name of a unit enum variant.
fn enum_id<T: Serialize>(v: &T) -> String {
    serde_json::to_value(v).ok().and_then(|x| x.as_str().map(str::to_string)).unwrap_or_default()
}

/// Lengths of the needle movements of `plan` belonging to `want` (object
/// indices), and the counts of jumps / trims / stops / stitches.
struct Tally {
    bounds: Rect,
    stitches: usize,
    jumps: usize,
    trims: usize,
    stops: usize,
    max: f64,
    min: f64,
}

fn tally(plan: &StitchPlan, want: impl Fn(u32) -> bool) -> Tally {
    let mut t = Tally { bounds: Rect::EMPTY, stitches: 0, jumps: 0, trims: 0, stops: 0, max: 0.0, min: f64::INFINITY };
    // the previous needle position and whether it was a penetration of this set
    let mut prev: Option<(Point, bool)> = None;
    // the jump that brings the needle to an object is not its own
    let mut started = false;
    let mut last_obj = u32::MAX;
    for s in &plan.stitches {
        let mine = want(s.object);
        if s.is(flags::COLOR_CHANGE) {
            prev = None;
            continue;
        }
        if s.is(flags::TRIM) {
            if mine {
                t.trims += 1;
            }
            continue;
        }
        if s.is(flags::STOP) {
            if mine {
                t.stops += 1;
            }
            continue;
        }
        if s.is(flags::END) {
            continue;
        }
        if s.is(flags::JUMP) {
            if mine && started && s.object == last_obj {
                t.jumps += 1;
            }
            prev = Some((s.pos(), false));
            continue;
        }
        if mine {
            if !started || s.object != last_obj {
                started = true;
                last_obj = s.object;
            }
            t.stitches += 1;
            t.bounds.include(s.pos());
            if let Some((p, true)) = prev {
                let l = p.dist(s.pos());
                if l > 1e-9 {
                    t.max = t.max.max(l);
                    t.min = t.min.min(l);
                }
            }
        }
        prev = Some((s.pos(), mine));
    }
    if !t.min.is_finite() {
        t.min = 0.0;
    }
    t
}

/// Stitches the minimum stitch length removes from an object's runs (as the
/// plan assembly drops them).
fn small_removed(engine: &mut Engine, doc: &Document, i: usize) -> usize {
    // the object's own minimum wins, as in the assembly
    let min = doc.objects[i].min_stitch.unwrap_or(doc.machine.min_stitch).max(0.0);
    let mut n = 0;
    for run in engine.object_runs(doc, i) {
        let Some(&(first, _)) = run.first() else { continue };
        let mut last = first;
        let k = run.len();
        for (j, &(q, _)) in run.iter().enumerate().skip(1) {
            let d = q.dist(last);
            if d < 1e-6 {
                continue;
            }
            if d < min && j + 1 < k && crate::assemble::redundant(last, q, run[j + 1].0) {
                n += 1;
                continue;
            }
            last = q;
        }
    }
    n
}

/// Info on the objects `ids` (all visible objects when empty), from the
/// design's stitch plan.
pub fn element_info(doc: &Document, engine: &mut Engine, ids: &[String]) -> ElementInfo {
    let plan = engine.plan(doc);
    let chosen: Vec<usize> = (0..doc.objects.len()).filter(|&i| if ids.is_empty() { doc.objects[i].visible } else { ids.contains(&doc.objects[i].id) }).collect();
    let mut objects = Vec::new();
    for &i in &chosen {
        let o = &doc.objects[i];
        let t = tally(&plan, |k| k as usize == i);
        let (kind, method) = kind_method(&o.stitch);
        let color = doc.threads.iter().find(|x| x.id == o.thread).map(|x| x.color.clone()).unwrap_or_default();
        objects.push(ObjectInfo {
            id: o.id.clone(),
            name: o.name.clone(),
            color,
            kind: kind.into(),
            method,
            width: if t.stitches > 0 { t.bounds.width() } else { 0.0 },
            height: if t.stitches > 0 { t.bounds.height() } else { 0.0 },
            stitches: t.stitches,
            small_removed: if o.visible { small_removed(engine, doc, i) } else { 0 },
            jumps: t.jumps,
            max_stitch: t.max,
            min_stitch: t.min,
            hidden: t.stitches == 0,
        });
    }
    let set: std::collections::HashSet<u32> = chosen.iter().map(|&i| i as u32).collect();
    // with every object: the plan's own counts (basting and knockdown too)
    let all = ids.is_empty();
    let t = tally(&plan, |k| all || set.contains(&k));
    // colour blocks with stitches of the selection
    let blocks = crate::threadlist::block_objects(&plan);
    let mut sel_blocks: Vec<usize> = Vec::new();
    for (k, objs) in blocks.iter().enumerate() {
        if all || objs.iter().any(|o| set.contains(&(*o as u32))) {
            sel_blocks.push(k);
        }
    }
    let mut colors: Vec<String> = sel_blocks.iter().filter_map(|&k| plan.threads.get(k)).map(|t| t.color.to_ascii_lowercase()).collect();
    colors.sort();
    colors.dedup();
    let total = TotalInfo {
        objects: chosen.len(),
        width: if t.stitches > 0 { t.bounds.width() } else { 0.0 },
        height: if t.stitches > 0 { t.bounds.height() } else { 0.0 },
        colors: colors.len(),
        color_changes: sel_blocks.len().saturating_sub(1),
        jumps: if all { plan.stitches.iter().filter(|s| s.is(flags::JUMP)).count().saturating_sub(1) } else { t.jumps },
        trims: t.trims,
        stops: t.stops,
        stitches: t.stitches,
        small_removed: objects.iter().map(|o| o.small_removed).sum(),
        max_stitch: t.max,
        min_stitch: t.min,
        min_stitch_filter: doc.machine.min_stitch,
    };
    ElementInfo { objects, total }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geom::pt;
    use crate::model::{Object, SubPath, Thread};

    fn obj(id: &str, thread: &str, pts: &[Point]) -> Object {
        Object {
            id: id.into(),
            name: id.into(),
            thread: thread.into(),
            visible: true,
            locked: false,
            paths: vec![SubPath::polyline(pts, false)],
            stitch: StitchParams::Manual(Default::default()),
            trim_after: false,
            stop_after: false,
            ties: Default::default(),
            force_lock: false,
            min_stitch: None,
            min_jump: None,
            patterns: vec![],
            clone: None,
            hidden: None,
            start: None,
            end: None,
            lock: None,
            color_sort_index: None,
        }
    }

    #[test]
    fn counts_per_object_and_total() {
        let t = |id: &str, c: &str| Thread { id: id.into(), name: id.into(), color: c.into(), brand: String::new(), code: String::new(), weight: None };
        let mut doc = Document {
            threads: vec![t("a", "#ff0000"), t("b", "#00ff00")],
            objects: vec![
                // 0.1 mm step: below the minimum stitch length
                obj("o1", "a", &[pt(0.0, 0.0), pt(2.0, 0.0), pt(2.1, 0.0), pt(6.0, 0.0)]),
                obj("o2", "b", &[pt(0.0, 10.0), pt(3.0, 10.0), pt(3.0, 14.0)]),
            ],
            ..Document::default()
        };
        doc.machine.ties = false;
        let mut e = Engine::new();
        let info = element_info(&doc, &mut e, &[]);
        assert_eq!(info.objects.len(), 2);
        let a = &info.objects[0];
        assert_eq!((a.kind.as_str(), a.stitches, a.small_removed), ("manual", 3, 1));
        assert!((a.max_stitch - 4.0).abs() < 1e-9 && (a.min_stitch - 2.0).abs() < 1e-9, "{a:?}");
        assert!((a.width - 6.0).abs() < 1e-9 && a.height.abs() < 1e-9);
        let b = &info.objects[1];
        assert_eq!(b.stitches, 3);
        assert!((b.max_stitch - 4.0).abs() < 1e-9 && (b.min_stitch - 3.0).abs() < 1e-9);
        assert_eq!((info.total.colors, info.total.color_changes, info.total.stitches), (2, 1, 6));
        assert!((info.total.height - 14.0).abs() < 1e-9);
        // only the second object
        let one = element_info(&doc, &mut e, &["o2".to_string()]);
        assert_eq!((one.objects.len(), one.total.colors, one.total.color_changes, one.total.stitches), (1, 1, 0, 3));
        assert_eq!(enum_id(&crate::model::FillMethod::Tatami), "tatami");
    }

    #[test]
    fn small_stitches_follow_the_objects_own_minimum() {
        let t = Thread { id: "a".into(), name: "a".into(), color: "#ff0000".into(), brand: String::new(), code: String::new(), weight: None };
        let mut o = obj("o1", "a", &[pt(0.0, 0.0), pt(2.0, 0.0), pt(2.1, 0.0), pt(6.0, 0.0)]);
        o.min_stitch = Some(0.0);
        let mut doc = Document { threads: vec![t], objects: vec![o], ..Document::default() };
        doc.machine.ties = false;
        let mut e = Engine::new();
        let info = element_info(&doc, &mut e, &[]);
        // the object keeps its 0.1 mm stitch: none removed, all four sewn
        assert_eq!((info.objects[0].stitches, info.objects[0].small_removed), (4, 0));
        // a larger minimum of its own drops the 2 mm and the 2.1 mm stitch too
        doc.objects[0].min_stitch = Some(2.2);
        let info = element_info(&doc, &mut e, &[]);
        assert_eq!((info.objects[0].stitches, info.objects[0].small_removed), (2, 2));
    }
}
