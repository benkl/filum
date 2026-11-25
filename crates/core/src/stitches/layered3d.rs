//! Layered 3D (Punch; from the NOVAstitch Designer fork): a satin with its
//! `layered` block.
//!
//! From the satin column the inner layers are made by themselves, growing:
//! first the core (the narrowest layer, over two underlay layers — the zig-zag
//! there and back — and a contour), then the wider layers, and last the layer
//! that wraps them all: the column itself. 2 to 4 inner layers plus the final one.
//!
//! The edges are staggered: each inner layer is `shrink_per_layer` narrower
//! than the next (half of it on each side), so no needle point of a layer falls
//! within 0.3 mm of one of the layer before — in the same holes the thread
//! would break.
//!
//! The inner layers can be sewn with another thread (`base_thread`, the one in
//! the machine: polyester under a metallic): a one-point run flagged
//! `COLOR_CHANGE` before the final layer asks the assembler for the object's
//! own thread there.

use super::satin::{plot_points_on_rails, satin_geometry, satin_on};
use super::Run;
use crate::geom::Point;
use crate::model::{Document, FabricProfile, Object, SatinParams, StitchParams, SubPath, LAYERED3D_MAX_LAYERS, LAYERED3D_MIN_LAYERS, LAYERED3D_SHRINK};
use crate::plan::flags;

/// A layer narrower than this is left out (mm): nothing to sew.
const MIN_LAYER_WIDTH: f64 = 0.5;

/// One-point run: from here on the object's own thread (the final layer).
pub fn thread_switch(at: Point) -> Run {
    vec![(at, flags::COLOR_CHANGE)]
}

pub fn is_thread_switch(run: &Run) -> bool {
    run.len() == 1 && run[0].1 & flags::COLOR_CHANGE != 0
}

/// The thread an object starts with: a layered 3D's base thread when the design has it, else its own.
pub fn start_thread<'a>(obj: &'a Object, doc: &Document) -> &'a str {
    match &obj.stitch {
        StitchParams::Satin(SatinParams { layered: Some(l), .. }) => l.base_thread.as_deref().filter(|t| doc.thread(t).is_some()).unwrap_or(&obj.thread),
        _ => &obj.thread,
    }
}

/// The column's (narrowest, for several sub-paths) mean width.
fn width(paths: &[SubPath], p: &SatinParams) -> f64 {
    let groups: Vec<Vec<SubPath>> = if p.multi && paths.len() > 1 { paths.iter().map(|s| vec![s.clone()]).collect() } else { vec![paths.to_vec()] };
    let single = SatinParams { multi: false, ..p.clone() };
    groups
        .iter()
        .filter_map(|g| {
            let pairs = plot_points_on_rails(&satin_geometry(g, &single)?, 0.5, 0.0, 0.0);
            (!pairs.is_empty()).then(|| pairs.iter().map(|(a, b)| a.dist(*b)).sum::<f64>() / pairs.len() as f64)
        })
        .fold(f64::INFINITY, f64::min)
}

/// The runs of a layered 3D satin (`p.layered` set; absent, its defaults).
pub fn layered3d(paths: &[SubPath], p: &SatinParams, fabric: &FabricProfile) -> Vec<Run> {
    let l = p.layered.clone().unwrap_or_default();
    let n = l.layers.clamp(LAYERED3D_MIN_LAYERS, LAYERED3D_MAX_LAYERS);
    let shrink = if l.shrink_per_layer.is_finite() && l.shrink_per_layer >= 0.0 { l.shrink_per_layer } else { LAYERED3D_SHRINK };
    let column = SatinParams { layered: None, foam: None, ..p.clone() };
    let w = width(paths, &column);
    if !w.is_finite() {
        return vec![];
    }
    // every layer: the column's satin, no underlay of its own
    let plain = SatinParams { underlay_auto: false, center_walk: false, contour_underlay: false, zigzag_underlay: false, ..column.clone() };
    let mut runs: Vec<Run> = Vec::new();
    let mut core = true;
    let mut reverse = column.reverse;
    for k in 1..=n {
        // narrower by `inset` in all (half each side) than the column
        let inset = (n - k + 1) as f64 * shrink;
        if w + column.pull_comp - inset < MIN_LAYER_WIDTH {
            continue;
        }
        let mut sp = SatinParams { pull_comp: column.pull_comp - inset, reverse, ..plain.clone() };
        if let Some(sr) = sp.second_rail.as_mut() {
            sr.pull_comp = sr.pull_comp.map(|c| c - inset);
        }
        if std::mem::replace(&mut core, false) {
            // the core: contour and zig-zag (there and back: two layers) inside it
            sp.contour_underlay = true;
            sp.contour_underlay_repeats = 1;
            sp.zigzag_underlay = true;
            sp.zigzag_underlay_spacing = l.underlay_zigzag_spacing;
            sp.contour_inset = column.contour_inset + inset / 2.0;
            sp.zigzag_underlay_inset = column.zigzag_underlay_inset + inset / 2.0;
            sp.contour_inset_pct = 0.0;
            sp.zigzag_inset_pct = 0.0;
            sp.second_rail = sp.second_rail.map(|sr| crate::model::SecondRail { contour_inset: None, contour_inset_pct: None, zigzag_underlay_inset: None, zigzag_inset_pct: None, ..sr });
        }
        runs.extend(satin_on(paths, &sp, fabric));
        // each layer starts where the last one ended
        reverse = !reverse;
    }
    // the final layer, the whole column, in the object's own thread
    let last = SatinParams { reverse, ..plain };
    let wrap = satin_on(paths, &last, fabric);
    if let Some(at) = wrap.first().and_then(|r| r.first()).map(|x| x.0) {
        runs.push(thread_switch(at));
    }
    runs.extend(wrap);
    runs.retain(|r| !r.is_empty());
    runs
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::assemble::Engine;
    use crate::geom::pt;
    use crate::model::*;

    fn line(a: Point, b: Point) -> SubPath {
        SubPath::polyline(&[a, b], false)
    }
    fn column(width: f64, layers: u32) -> SatinParams {
        SatinParams { width, layered: Some(LayeredOptions { layers, ..Default::default() }), ..Default::default() }
    }
    fn obj(id: &str, thread: &str, paths: Vec<SubPath>, stitch: StitchParams) -> Object {
        let mut o: Object = serde_json::from_value(serde_json::json!({ "id": id, "thread": thread, "paths": [] })).unwrap();
        o.paths = paths;
        o.stitch = stitch;
        o
    }
    fn thread(id: &str) -> Thread {
        // each its own colour (threads of one colour share a spool)
        let color = format!("#{:06x}", id.bytes().fold(7u32, |h, c| h.wrapping_mul(31).wrapping_add(c as u32)) & 0xff_ffff);
        Thread::new(id, id, color)
    }
    fn doc(objects: Vec<Object>, threads: &[&str]) -> Document {
        Document { threads: threads.iter().map(|t| thread(t)).collect(), objects, ..Default::default() }
    }

    #[test]
    fn four_layers_and_the_final_one_staggered() {
        // a 12 mm column, 4 layers → 4 layers and the final one; no point of a
        // layer within 0.3 mm of a point of the layer before
        let runs = layered3d(&[line(pt(0.0, 0.0), pt(40.0, 0.0))], &column(12.0, 4), &Fabric::Cotton.profile());
        let layers: Vec<&Run> = runs.iter().filter(|r| !is_thread_switch(r)).collect();
        assert_eq!(layers.len(), 5, "4 inner layers and the final one");
        assert_eq!(runs.iter().filter(|r| is_thread_switch(r)).count(), 1);
        // growing: the edges at 4.8, 5.1, 5.4, 5.7 and 6 mm from the centre line
        let edge = |r: &Run| r.iter().filter(|x| x.1 & flags::UNDERLAY == 0).map(|x| x.0.y.abs()).fold(0.0, f64::max);
        let edges: Vec<f64> = layers.iter().map(|r| edge(r)).collect();
        for (e, want) in edges.iter().zip([4.8, 5.1, 5.4, 5.7, 6.0]) {
            assert!((e - want).abs() < 1e-6, "edges {edges:?}");
        }
        // only the core has underlay (contour and zig-zag), inside it
        assert!(layers[0].iter().any(|x| x.1 & flags::UNDERLAY != 0) && layers[1..].iter().all(|r| r.iter().all(|x| x.1 & flags::UNDERLAY == 0)));
        assert!(layers[0].iter().filter(|x| x.1 & flags::UNDERLAY != 0).all(|x| x.0.y.abs() < 4.8 - 0.3));
        for k in 1..layers.len() {
            let min = layers[k].iter().flat_map(|a| layers[k - 1].iter().map(move |b| a.0.dist(b.0))).fold(f64::INFINITY, f64::min);
            assert!(min >= LAYERED3D_MIN_GAP - 1e-9, "layer {} to layer {}: {min} mm", k + 1, k);
        }
        // each layer starts near where the last one ended
        for k in 1..layers.len() {
            let (a, b) = (layers[k - 1].last().unwrap().0, layers[k].first().unwrap().0);
            assert!(a.dist(b) < 13.0, "layer {} starts {} mm away", k + 1, a.dist(b));
        }
    }

    #[test]
    fn five_layers_are_refused() {
        // 2 to 4 layers
        let read = |n: u32| serde_json::from_value::<StitchParams>(serde_json::json!({ "type": "satin", "layered": { "layers": n } }));
        let err = read(5).unwrap_err().to_string();
        assert!(err.contains("layers 5"), "{err}");
        assert!(read(1).is_err());
        let StitchParams::Satin(s) = read(4).unwrap() else { panic!() };
        assert_eq!(s.layered.unwrap().layers, 4);
        let StitchParams::Satin(s) = serde_json::from_value(serde_json::json!({ "type": "satin", "width": 8.0, "layered": {} })).unwrap() else { panic!() };
        let l = s.layered.unwrap();
        assert_eq!((l.layers, l.shrink_per_layer, l.underlay_zigzag_spacing), (2, 0.6, 3.0), "the block's defaults");
        assert!(l.base_thread.is_none() && !serde_json::to_string(&l).unwrap().contains("baseThread"));
        // no block: a plain satin, and nothing written
        let StitchParams::Satin(s) = serde_json::from_value(serde_json::json!({ "type": "satin" })).unwrap() else { panic!() };
        assert!(s.layered.is_none() && !serde_json::to_string(&s).unwrap().contains("layered"));
    }

    #[test]
    fn inner_layers_in_the_base_thread_metallic_only_on_top() {
        // a layered 3D in metallic thread, the inner layers in the polyester chosen
        let mut p = column(8.0, 3);
        p.layered.as_mut().unwrap().base_thread = Some("poly".into());
        let d = doc(vec![obj("l", "metal", vec![line(pt(0.0, 0.0), pt(30.0, 0.0))], StitchParams::Satin(p))], &["poly", "metal"]);
        let plan = Engine::new().plan(&d);
        let ids: Vec<&str> = plan.threads.iter().map(|t| t.id.as_str()).collect();
        assert_eq!(ids, ["poly", "metal"], "the polyester first, the metallic after");
        let cc: Vec<usize> = plan.stitches.iter().enumerate().filter(|(_, s)| s.is(flags::COLOR_CHANGE)).map(|(i, _)| i).collect();
        assert_eq!(cc.len(), 1, "one colour change, before the final layer");
        let needle = |s: &&crate::plan::Stitch| s.flags & flags::COMMANDS == 0 && s.flags & flags::TIE == 0;
        // the final layer's edges (4 mm out) only after it, the inner layers (narrower) only before
        assert!(plan.stitches[..cc[0]].iter().filter(needle).all(|s| s.y.abs() < 4.0 - 0.1), "nothing of the final layer in polyester");
        assert!(plan.stitches[cc[0]..].iter().filter(needle).all(|s| s.y.abs() > 4.0 - 0.1 || s.flags & flags::JUMP != 0), "only the final layer in metallic");
        assert!(plan.stitches[cc[0]..].iter().filter(needle).count() > 50);
        // no base thread: one thread, no colour change
        let d = doc(vec![obj("l", "metal", vec![line(pt(0.0, 0.0), pt(30.0, 0.0))], StitchParams::Satin(column(8.0, 3)))], &["poly", "metal"]);
        let plan = Engine::new().plan(&d);
        assert_eq!(plan.threads.len(), 1);
        assert!(!plan.stitches.iter().any(|s| s.is(flags::COLOR_CHANGE)));
    }
}
