//! The stitches don't change: a hash of the stitch plan for one object of
//! every stitch type and method, for all of them sewn together, and for the
//! designs the digitizer makes from some of the suite pictures — compared to
//! the record in `tests/plan_hashes/<os>.txt`.
//!
//! A refactor of the engine must leave every line as it is. A change that
//! means to alter stitches records the new hashes in the same commit:
//!
//!   UPDATE_PLAN_HASHES=1 cargo test -p filum-core --test plan_hashes
//!
//! Floating point can differ in the last bit between operating systems (their
//! maths libraries), so each OS keeps its own record; a missing record is
//! written and the test passes.

use filum_core::digitize::{decode_image, digitize_rgba, DigitizeOptions};
use filum_core::*;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::PathBuf;

/// FNV-1a over the stitches: positions to 1 µm, flags and objects.
fn plan_hash(plan: &StitchPlan) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    let mut eat = |v: i64| {
        for b in v.to_le_bytes() {
            h ^= b as u64;
            h = h.wrapping_mul(0x0000_0100_0000_01b3);
        }
    };
    for s in &plan.stitches {
        eat((s.x * 1000.0).round() as i64);
        eat((s.y * 1000.0).round() as i64);
        eat(s.flags as i64);
        eat(s.object as i64);
    }
    h
}

fn text_hash(s: &str) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in s.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    h
}

fn ring(pts: &[(f64, f64)]) -> Value {
    json!({ "closed": true, "nodes": pts.iter().map(|(x, y)| json!({ "p": [x, y] })).collect::<Vec<_>>() })
}
fn line(pts: &[(f64, f64)]) -> Value {
    json!({ "closed": false, "nodes": pts.iter().map(|(x, y)| json!({ "p": [x, y] })).collect::<Vec<_>>() })
}
fn circle(cx: f64, cy: f64, r: f64, n: usize) -> Vec<(f64, f64)> {
    (0..n).map(|i| {
        let a = i as f64 / n as f64 * std::f64::consts::TAU;
        (cx + r * a.cos(), cy + r * a.sin())
    })
    .collect()
}
/// A concave blob with a round hole: rows break, travel has to go round.
fn blob() -> Vec<Value> {
    let outer = [(0.0, 0.0), (34.0, 0.0), (34.0, 12.0), (16.0, 14.0), (16.0, 22.0), (34.0, 24.0), (30.0, 36.0), (0.0, 36.0)];
    vec![ring(&outer), ring(&circle(7.0, 28.0, 3.0, 24))]
}
fn wave(y: f64, amp: f64) -> Vec<(f64, f64)> {
    (0..=40).map(|i| (i as f64, y + amp * (i as f64 * 0.3).sin())).collect()
}
/// Two rails of a satin column.
fn rails() -> Vec<Value> {
    vec![line(&wave(0.0, 3.0)), line(&wave(4.0, 3.0))]
}

fn object(id: &str, thread: &str, paths: Vec<Value>, stitch: Value) -> Object {
    serde_json::from_value(json!({ "id": id, "name": id, "thread": thread, "paths": paths, "stitch": stitch })).unwrap_or_else(|e| panic!("{id}: {e}"))
}

fn doc(objects: Vec<Object>) -> Document {
    let threads: Vec<Thread> = serde_json::from_value(json!([
        { "id": "a", "name": "Red", "color": "#c8102e" },
        { "id": "b", "name": "Navy", "color": "#1f2a56" },
    ]))
    .unwrap();
    Document { threads, objects, ..Document::default() }
}

/// One object of every stitch type and method.
fn cases() -> Vec<(String, Object)> {
    let mut out = Vec::new();
    let fills = ["tatami", "contour", "spiral", "radial", "hilbert", "stipple", "meander", "guided", "circular", "flow", "curved", "cross", "tartan"];
    for m in fills {
        out.push((format!("fill-{m}"), object(m, "a", blob(), json!({ "type": "fill", "method": m }))));
    }
    let more_fills = [
        ("fill-auto-underlay", json!({ "type": "fill", "underlayAuto": true })),
        ("fill-gradient-spacing", json!({ "type": "fill", "endRowSpacing": 1.2 })),
        ("fill-angle-pull", json!({ "type": "fill", "angle": 35, "pullCompensation": 0.3 })),
        ("fill-guided-line", json!({ "type": "fill", "method": "guided", "guide": line(&[(0.0, 5.0), (17.0, 18.0), (34.0, 30.0)]) })),
    ];
    for (name, st) in more_fills {
        out.push((name.into(), object(name, "a", blob(), st)));
    }
    for m in ["satin", "eStitch", "sStitch", "zigzag"] {
        out.push((format!("satin-{m}"), object(m, "b", rails(), json!({ "type": "satin", "method": m }))));
    }
    out.push(("satin-centre-line".into(), object("cl", "b", vec![line(&wave(0.0, 4.0))], json!({ "type": "satin", "width": 3.0 }))));
    out.push(("satin-ring".into(), object("ring", "b", vec![ring(&circle(20.0, 20.0, 15.0, 48)), ring(&circle(20.0, 20.0, 19.0, 48))], json!({ "type": "satin" }))));
    out.push(("satin-foam".into(), object("foam", "b", rails(), json!({ "type": "satin", "foam": {} }))));
    out.push(("satin-layered".into(), object("layered", "b", vec![line(&wave(0.0, 3.0)), line(&wave(9.0, 3.0))], json!({ "type": "satin", "layered": {} }))));
    out.push(("satin-random".into(), object("rnd", "b", rails(), json!({ "type": "satin", "randomWider": 20, "randomSeed": 7 }))));
    let runs = [
        ("running", json!({ "type": "running" })),
        ("running-bean", json!({ "type": "running", "beanRepeats": 2 })),
        ("running-random", json!({ "type": "running", "randomLength": 0.3, "randomSeed": 3 })),
        ("running-zigzag", json!({ "type": "running", "zigzag": {} })),
        ("running-motif", json!({ "type": "running", "motif": {} })),
    ];
    for (name, st) in runs {
        out.push((name.into(), object(name, "b", vec![line(&wave(0.0, 6.0))], st)));
    }
    out.push(("running-ripple".into(), object("ripple", "b", vec![ring(&circle(20.0, 20.0, 15.0, 48))], json!({ "type": "running", "ripple": {} }))));
    out.push(("applique".into(), object("applique", "a", vec![ring(&circle(20.0, 20.0, 15.0, 48))], json!({ "type": "applique" }))));
    out.push(("manual".into(), object("manual", "a", vec![line(&wave(0.0, 6.0))], json!({ "type": "manual" }))));
    out
}

/// A few suite pictures through the digitizer: its objects and their plan.
fn digitized() -> Vec<(String, Document)> {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/suite");
    let mut out = Vec::new();
    for name in ["01-badge-text", "03-line-art", "05-tiny-details"] {
        let bytes = std::fs::read(dir.join(format!("{name}.png"))).unwrap();
        let side: Value = serde_json::from_str(&std::fs::read_to_string(dir.join(format!("{name}.json"))).unwrap()).unwrap();
        let mut base = serde_json::to_value(DigitizeOptions::default()).unwrap();
        for (k, v) in side.as_object().unwrap() {
            if !k.starts_with('_') {
                base[k] = v.clone();
            }
        }
        let opts: DigitizeOptions = serde_json::from_value(base).unwrap();
        let (rgba, w, h) = decode_image(&bytes).unwrap();
        let r = digitize_rgba(&rgba, w, h, &opts);
        out.push((name.to_string(), Document { threads: r.threads, objects: r.objects, ..Document::default() }));
    }
    out
}

fn record_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/plan_hashes").join(format!("{}.txt", std::env::consts::OS))
}

#[test]
fn stitch_plans_are_unchanged() {
    let mut now: BTreeMap<String, String> = BTreeMap::new();
    let mut engine = Engine::new();
    let all = cases();
    for (name, o) in &all {
        let plan = engine.plan(&doc(vec![o.clone()]));
        now.insert(name.clone(), format!("{} {:016x}", plan.stitches.len(), plan_hash(&plan)));
    }
    let together = doc(all.into_iter().map(|(_, o)| o).collect());
    let plan = engine.plan(&together);
    now.insert("all-together".into(), format!("{} {:016x}", plan.stitches.len(), plan_hash(&plan)));
    for (name, d) in digitized() {
        let objects = serde_json::to_string(&d.objects).unwrap();
        now.insert(format!("digitize-{name}"), format!("{} {:016x}", d.objects.len(), text_hash(&objects)));
        let plan = Engine::new().plan(&d);
        now.insert(format!("digitize-{name}-plan"), format!("{} {:016x}", plan.stitches.len(), plan_hash(&plan)));
    }

    let text: String = now.iter().map(|(k, v)| format!("{k} {v}\n")).collect();
    let path = record_path();
    let update = std::env::var("UPDATE_PLAN_HASHES").is_ok();
    if update || !path.exists() {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, &text).unwrap();
        eprintln!("recorded {} plan hashes in {}", now.len(), path.display());
        return;
    }
    let was: BTreeMap<String, String> = std::fs::read_to_string(&path)
        .unwrap()
        .lines()
        .filter_map(|l| l.split_once(' ').map(|(k, v)| (k.to_string(), v.trim().to_string())))
        .collect();
    let changed: Vec<String> = now
        .iter()
        .filter(|(k, v)| was.get(*k) != Some(v))
        .map(|(k, v)| format!("  {k}: {} → {v}", was.get(k).map(String::as_str).unwrap_or("(new)")))
        .chain(was.keys().filter(|k| !now.contains_key(*k)).map(|k| format!("  {k}: gone")))
        .collect();
    assert!(
        changed.is_empty(),
        "stitch plans changed (stitches, hash):\n{}\nIf that is meant, record them: UPDATE_PLAN_HASHES=1 cargo test -p filum-core --test plan_hashes",
        changed.join("\n")
    );
}
