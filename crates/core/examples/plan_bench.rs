//! Stitch-calculation benchmark.
//!
//! ```text
//! cargo run --release -p filum-core --features prof --example plan_bench -- \
//!     [crates/core/tests/suite] [--only NAME] [--no-suite] [--no-synth] [--phases] [--dump DIR]
//! ```
//!
//! Every picture of the digitizer suite (with its sidecar json, as
//! `digitize_suite` reads it) is digitized, and a few synthetic heavy designs
//! are built (many fills, curved fills, gradient groups, satins, a pile of
//! overlapping objects). Each design is planned
//!
//! * cold (a new engine) without and with hidden-stitch removal,
//! * warm: the same document again on the same engine (all cached),
//! * after an edit: the first object moved by 0.3 mm, then re-planned
//!   ("regen": objects generated again with removal on),
//! * as the editor does it per edit with removal on: the plan, plus the
//!   hidden-stitching report (a plan without removal, one with it and the
//!   stitched shapes, see ui/src/lib/hiddenStitching.ts).
//!
//! With `--features prof` the engine's scope timers break every cold plan
//! down into its phases (stitch generation by type, hidden-stitch removal,
//! streamline tracing, travel and ordering, assembly); `--phases` prints them.

use std::path::PathBuf;
use std::time::Instant;

use filum_core::digitize::{decode_image, digitize_rgba, DigitizeOptions};
use filum_core::geom::{pt, Point};
use filum_core::model::*;
use filum_core::{prof, Document, Engine};

struct Case {
    name: String,
    doc: Document,
    digitize_s: Option<f64>,
}

fn main() -> Result<(), String> {
    let args: Vec<String> = std::env::args().collect();
    let dir = PathBuf::from(args.iter().skip(1).find(|a| !a.starts_with("--")).map(String::as_str).unwrap_or("crates/core/tests/suite"));
    let only = args.iter().position(|a| a == "--only").and_then(|i| args.get(i + 1)).cloned();
    let phases = args.iter().any(|a| a == "--phases");
    let mut cases: Vec<Case> = Vec::new();
    if !args.iter().any(|a| a == "--no-suite") {
        cases.extend(suite(&dir, only.as_deref())?);
    }
    if !args.iter().any(|a| a == "--no-synth") {
        cases.extend(synthetic().into_iter().filter(|c| only.as_deref().is_none_or(|o| c.name.contains(o))));
    }

    // --dump DIR: every design as a .filum file (to load in the editor and time it there)
    if let Some(dir) = args.iter().position(|a| a == "--dump").and_then(|i| args.get(i + 1)) {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        for c in &cases {
            let json = serde_json::to_string(&c.doc).map_err(|e| e.to_string())?;
            std::fs::write(PathBuf::from(dir).join(format!("{}.filum", c.name)), json).map_err(|e| e.to_string())?;
        }
        println!("{} designs written to {dir}", cases.len());
    }
    println!(
        "{:<22} {:>4} {:>7} | {:>8} {:>8} | {:>8} {:>8} | {:>8} {:>8} {:>5} | {:>9} | {:>7} {:>16}",
        "design", "objs", "digit s", "cold off", "cold on", "warm off", "warm on", "edit off", "edit on", "regen", "UI/edit", "stitches", "plan hash (off^on)"
    );
    let mut totals: std::collections::BTreeMap<&'static str, (f64, u64)> = Default::default();
    for c in &cases {
        let mut off = c.doc.clone();
        off.options.remove_overlaps = false;
        let mut on = c.doc.clone();
        on.options.remove_overlaps = true;
        let _ = prof::take();

        // cold, without and with removal
        let (cold_off, plan_off) = time(|| Engine::new().plan(&off));
        let t_off = prof::take();
        let mut eng_on = Engine::new();
        let (cold_on, plan_on) = time(|| eng_on.plan(&on));
        let t_on = prof::take();
        // warm: everything cached
        let mut eng_off = Engine::new();
        eng_off.plan(&off);
        let (warm_off, _) = time(|| eng_off.plan(&off));
        let (warm_on, _) = time(|| eng_on.plan(&on));
        let _ = prof::take();
        // an edit: the first object nudged
        let (off2, on2) = (nudge(&off), nudge(&on));
        let (edit_off, _) = time(|| eng_off.plan(&off2));
        let _ = prof::take();
        let (edit_on, _) = time(|| eng_on.plan(&on2));
        let regen: u64 = prof::take().iter().filter(|x| x.0.starts_with("gen ")).map(|x| x.2).sum();
        // the editor, per edit with removal on: the plan, then the report's
        // two plans and the stitched shapes on the same (warm) engine
        let mut ui = Engine::new();
        ui.plan(&on);
        ui.plan(&off);
        let _ = ui.stitched_objects(&on);
        let (on3, off3) = (nudge(&nudge(&on)), nudge(&nudge(&off)));
        let (ui_edit, _) = time(|| {
            ui.plan(&on3);
            ui.plan(&off3);
            ui.plan(&on3);
            // the stitched shapes (crates/wasm stitchedShapes)
            let _ = ui.stitched_objects(&on3);
        });
        let _ = prof::take();

        let stitches = plan_on.stitches.iter().filter(|s| s.is_stitch()).count();
        println!(
            "{:<22} {:>4} {:>7} | {:>8.3} {:>8.3} | {:>8.3} {:>8.3} | {:>8.3} {:>8.3} {:>5} | {:>9.3} | {:>7} {:016x}",
            c.name,
            c.doc.objects.len(),
            c.digitize_s.map_or("-".to_string(), |s| format!("{s:.2}")),
            cold_off,
            cold_on,
            warm_off,
            warm_on,
            edit_off,
            edit_on,
            regen,
            ui_edit,
            stitches,
            plan_hash(&plan_off) ^ plan_hash(&plan_on).rotate_left(1)
        );
        if phases {
            print_phases("  cold off", &t_off);
            print_phases("  cold on", &t_on);
        }
        for (k, s, n) in t_on {
            let e = totals.entry(k).or_default();
            e.0 += s;
            e.1 += n;
        }
    }
    if !totals.is_empty() {
        println!("\nPhases over all cold plans with removal on (inclusive seconds, calls):");
        let mut v: Vec<_> = totals.into_iter().collect();
        v.sort_by(|a, b| b.1 .0.partial_cmp(&a.1 .0).unwrap());
        for (k, (s, n)) in v {
            println!("  {k:<38} {s:>9.3} s {n:>9}");
        }
    }
    Ok(())
}

/// Every stitch (position bits, flags, object) and thread, hashed.
fn plan_hash(p: &filum_core::StitchPlan) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    for s in &p.stitches {
        (s.x.to_bits(), s.y.to_bits(), s.flags, s.object).hash(&mut h);
    }
    for t in &p.threads {
        t.color.hash(&mut h);
    }
    h.finish()
}

fn time<T>(f: impl FnOnce() -> T) -> (f64, T) {
    let t = Instant::now();
    let r = f();
    (t.elapsed().as_secs_f64(), r)
}

fn print_phases(label: &str, t: &[(&'static str, f64, u64)]) {
    let mut v = t.to_vec();
    v.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap());
    let s: Vec<String> = v.iter().filter(|x| x.1 >= 0.005).map(|(k, s, n)| format!("{k} {s:.3}s/{n}")).collect();
    println!("{label}: {}", s.join(" · "));
}

/// The first object moved 0.3 mm to the right.
fn nudge(d: &Document) -> Document {
    let mut d = d.clone();
    if let Some(o) = d.objects.first_mut() {
        for sp in &mut o.paths {
            for n in &mut sp.nodes {
                n.p[0] += 0.3;
                if let Some(c) = n.i.as_mut() {
                    c[0] += 0.3;
                }
                if let Some(c) = n.o.as_mut() {
                    c[0] += 0.3;
                }
            }
        }
    }
    d
}

fn suite(dir: &PathBuf, only: Option<&str>) -> Result<Vec<Case>, String> {
    let mut images: Vec<PathBuf> = std::fs::read_dir(dir)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| matches!(p.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase().as_str(), "png" | "jpg" | "jpeg" | "webp" | "gif" | "bmp"))
        .filter(|p| only.is_none_or(|o| p.file_stem().and_then(|s| s.to_str()).unwrap_or("").contains(o)))
        .collect();
    images.sort();
    let mut out = Vec::new();
    for path in images {
        let name = path.file_stem().and_then(|s| s.to_str()).unwrap_or("").to_string();
        let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
        let mut opts = DigitizeOptions::default();
        let side = path.with_extension("json");
        if side.exists() {
            let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&side).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
            let mut base = serde_json::to_value(&opts).unwrap();
            if let (Some(b), Some(o)) = (base.as_object_mut(), v.as_object()) {
                for (k, x) in o {
                    if !k.starts_with('_') {
                        b.insert(k.clone(), x.clone());
                    }
                }
            }
            opts = serde_json::from_value(base).map_err(|e| format!("{}: {e}", side.display()))?;
        }
        let (rgba, w, h) = decode_image(&bytes)?;
        let (s, r) = time(|| digitize_rgba(&rgba, w, h, &opts));
        let doc = Document { name: name.clone(), threads: r.threads, objects: r.objects, ..Document::default() };
        out.push(Case { name, doc, digitize_s: Some(s) });
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// synthetic designs

fn thread(i: usize) -> Thread {
    let c = ["#c8102e", "#1f4e9c", "#f2b300", "#2e8b57", "#6b3fa0", "#e87722"][i % 6];
    Thread { id: format!("t{i}"), name: format!("T{i}"), color: c.into(), brand: String::new(), code: String::new(), weight: None }
}

fn object(id: String, thread: usize, paths: Vec<SubPath>, stitch: StitchParams) -> Object {
    Object {
        id: id.clone(),
        name: id,
        thread: format!("t{thread}"),
        visible: true,
        locked: false,
        paths,
        stitch,
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

fn ellipse(c: Point, rx: f64, ry: f64, n: usize) -> Vec<SubPath> {
    let pts: Vec<Point> = (0..n).map(|k| {
        let a = k as f64 / n as f64 * std::f64::consts::TAU;
        pt(c.x + rx * a.cos(), c.y + ry * a.sin())
    }).collect();
    vec![SubPath::polyline(&pts, true)]
}

/// A blob: an ellipse with a wavy edge (curved-fill fields bend along it).
fn blob(c: Point, r: f64, n: usize, seed: f64) -> Vec<SubPath> {
    let pts: Vec<Point> = (0..n).map(|k| {
        let a = k as f64 / n as f64 * std::f64::consts::TAU;
        let rr = r * (1.0 + 0.18 * (3.0 * a + seed).sin() + 0.08 * (5.0 * a + 2.0 * seed).cos());
        pt(c.x + rr * a.cos(), c.y + 0.8 * rr * a.sin())
    }).collect();
    vec![SubPath::polyline(&pts, true)]
}

fn doc(name: &str, objects: Vec<Object>, threads: usize) -> Case {
    Case { name: name.into(), doc: Document { name: name.into(), threads: (0..threads).map(thread).collect(), objects, ..Document::default() }, digitize_s: None }
}

fn fill(method: FillMethod, angle: f64) -> FillParams {
    FillParams { method, angle, ..Default::default() }
}

fn gradient_layers(group: &str, colours: usize, from: [f64; 2], to: [f64; 2], method: FillMethod, paths: &[SubPath], first_thread: usize) -> Vec<Object> {
    let stops: Vec<GradientStop> = (0..colours).map(|k| GradientStop { pos: k as f64 / (colours - 1) as f64, mid: 0.5 }).collect();
    (0..colours)
        .map(|l| {
            let g = GradientParams { from, to, stops: stops.clone(), layer: l as u32, group: group.into(), ..Default::default() };
            object(format!("{group}-{l}"), first_thread + l, paths.to_vec(), StitchParams::Fill(FillParams { gradient: Some(g), ..fill(method, 30.0) }))
        })
        .collect()
}

fn synthetic() -> Vec<Case> {
    let mut v = Vec::new();

    // 1. many overlapping tatami fills: 12 x 12 circles 9 mm across, 7 mm apart
    let mut objs = Vec::new();
    for j in 0..12 {
        for i in 0..12 {
            let k = j * 12 + i;
            objs.push(object(format!("f{k}"), k % 4, ellipse(pt(i as f64 * 7.0, j as f64 * 7.0), 4.5, 4.5, 48), StitchParams::Fill(fill(FillMethod::Tatami, (k * 17 % 180) as f64))));
        }
    }
    v.push(doc("synth-144-tatami", objs, 4));

    // 2. curved fills: 16 wavy blobs 30 mm across, overlapping
    let mut objs = Vec::new();
    for k in 0..16 {
        let c = pt((k % 4) as f64 * 24.0, (k / 4) as f64 * 22.0);
        objs.push(object(format!("c{k}"), k % 3, blob(c, 15.0, 120, k as f64), StitchParams::Fill(FillParams { curve: 1.0, ..fill(FillMethod::Curved, (k * 23 % 180) as f64) })));
    }
    v.push(doc("synth-16-curved", objs, 3));

    // 3. gradient groups: 3 three-colour curved gradients and 3 straight blended ones (60 x 45 mm), overlapping a base
    let mut objs = vec![object("base".into(), 0, ellipse(pt(60.0, 40.0), 70.0, 45.0, 160), StitchParams::Fill(fill(FillMethod::Tatami, 0.0)))];
    for k in 0..6 {
        let c = pt(20.0 + (k % 3) as f64 * 40.0, 20.0 + (k / 3) as f64 * 40.0);
        let paths = blob(c, 25.0, 140, k as f64);
        let method = if k < 3 { FillMethod::Curved } else { FillMethod::Tatami };
        objs.extend(gradient_layers(&format!("g{k}"), 3, [c.x - 25.0, c.y], [c.x + 25.0, c.y], method, &paths, 1));
    }
    v.push(doc("synth-6x3-gradients", objs, 4));

    // 4. satins and running stitch: 120 satin columns (wavy centre lines, 3 mm) over 30 fills
    let mut objs = Vec::new();
    for k in 0..30 {
        objs.push(object(format!("b{k}"), 0, ellipse(pt((k % 6) as f64 * 20.0, (k / 6) as f64 * 20.0), 10.0, 9.0, 64), StitchParams::Fill(fill(FillMethod::Tatami, 45.0))));
    }
    for k in 0..120 {
        let (x0, y0) = ((k % 10) as f64 * 12.0, (k / 10) as f64 * 8.0);
        let pts: Vec<Point> = (0..40).map(|j| pt(x0 + j as f64 * 0.8, y0 + 2.0 * (j as f64 * 0.3 + k as f64).sin())).collect();
        let st = if k % 4 == 3 { StitchParams::Running(RunningParams::default()) } else { StitchParams::Satin(SatinParams { width: 3.0, ..Default::default() }) };
        objs.push(object(format!("s{k}"), 1 + k % 3, vec![SubPath::polyline(&pts, false)], st));
    }
    v.push(doc("synth-120-satins", objs, 4));

    // 5. a pile: 300 fills stacked over a 100 mm square (every one overlaps many)
    let mut objs = Vec::new();
    for k in 0..300 {
        let (x, y) = ((k * 37 % 90) as f64, (k * 53 % 90) as f64);
        objs.push(object(format!("p{k}"), k % 5, ellipse(pt(x + 5.0, y + 5.0), 6.0 + (k % 7) as f64, 5.0 + (k % 5) as f64, 40), StitchParams::Fill(fill(FillMethod::Tatami, (k * 31 % 180) as f64))));
    }
    v.push(doc("synth-300-pile", objs, 5));
    v
}
