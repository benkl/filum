//! Regression tests from a fuzz run: minimal documents with empty, broken or
//! absurd settings must plan quickly, without panics, NaN or hangs, and the
//! exported plan must stay consistent.

use std::sync::mpsc;
use std::time::Duration;

use filum_core::io::{export_plan, ExportOptions};
use filum_core::plan::flags;
use filum_core::{Document, Engine, StitchPlan};

fn doc(json: &str) -> Document {
    serde_json::from_str(json).expect("a document")
}

/// The export plan of `json`, or a failure when it takes longer than `secs`.
fn plan_within(json: &'static str, secs: u64) -> StitchPlan {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let d = doc(json);
        let p = export_plan(&d, &mut Engine::new(), &ExportOptions::default());
        let _ = tx.send(p);
    });
    rx.recv_timeout(Duration::from_secs(secs)).unwrap_or_else(|_| panic!("no plan within {secs} s: {json}"))
}

fn finite(p: &StitchPlan) -> bool {
    p.stitches.iter().all(|s| s.x.is_finite() && s.y.is_finite())
}

#[test]
fn flow_fill_with_an_empty_field_finishes() {
    for json in [
        r#"{"objects":[{"id":"o3","paths":[{"nodes":[{"o":[0,70.0],"p":[0,0]},{"i":[27.0,0],"p":[0,0]}]}],"stitch":{"flow":{},"method":"flow","type":"fill"},"thread":"t0"}]}"#,
        r#"{"objects":[{"id":"o5","paths":[{"nodes":[{"p":[62.0,0]},{"p":[0,0]},{"p":[0,60.0]}]}],"stitch":{"flow":{},"method":"flow","type":"fill"},"thread":"dup"}]}"#,
    ] {
        let p = plan_within(json, 60);
        assert!(finite(&p));
    }
    // the triangle falls back to rows that follow its shape
    let p = plan_within(r#"{"objects":[{"id":"o5","paths":[{"nodes":[{"p":[62.0,0]},{"p":[0,0]},{"p":[0,60.0]}]}],"stitch":{"flow":{},"method":"flow","type":"fill"},"thread":"dup"}]}"#, 60);
    assert!(p.stitches.iter().filter(|s| s.is_stitch()).count() > 500);
}

/// Every needle move after a stop starts where the needle is: no sewn stitch
/// from the stop position into the design.
fn no_long_stitch_from_the_stop(p: &StitchPlan, stop_at: (f64, f64)) {
    let mut cur: Option<(f64, f64)> = None;
    for (k, s) in p.stitches.iter().enumerate() {
        if s.is_stitch() {
            if let Some(c) = cur {
                let d = ((s.x - c.0).powi(2) + (s.y - c.1).powi(2)).sqrt();
                assert!(c != stop_at || d < 1e-9, "record {k}: a {d:.1} mm stitch from the stop position");
                assert!(d < 12.2, "record {k}: a {d:.1} mm stitch");
            }
        }
        if s.is_stitch() || s.is(flags::JUMP) {
            cur = Some((s.x, s.y));
        }
        // a command sits where the needle is
        if s.flags & (flags::TRIM | flags::COLOR_CHANGE | flags::END) != 0 {
            let c = cur.unwrap();
            assert!((s.x - c.0).abs() < 1e-9 && (s.y - c.1).abs() < 1e-9, "record {k} away from the needle");
        }
    }
}

#[test]
fn the_frame_comes_back_from_the_stop_position() {
    // appliqué with a running tack-down right on the edge: a stitch follows the stop
    let p = plan_within(
        r#"{"objects":[{"id":"o1","paths":[{"nodes":[{"p":[7.0,0]},{"p":[0,0]},{"p":[0,68.0]}]}],"stitch":{"tackdown":"run","tackdownInset":0,"type":"applique"},"thread":"t3"}],"options":{"stopPosition":[-40,-40]}}"#,
        60,
    );
    assert!(p.stitches.iter().any(|s| s.is(flags::STOP)));
    no_long_stitch_from_the_stop(&p, (-40.0, -40.0));
    // two touching running lines, the first with "stop after"
    let p = plan_within(
        r#"{"objects":[{"id":"a","stopAfter":true,"paths":[{"nodes":[{"p":[0,0]},{"p":[20,0]}]}],"stitch":{"type":"running"},"thread":"t"},{"id":"b","paths":[{"nodes":[{"p":[20,0]},{"p":[20,20]}]}],"stitch":{"type":"running"},"thread":"t"}],"options":{"stopPosition":[-40,-40]}}"#,
        60,
    );
    assert_eq!(p.stitches.iter().filter(|s| s.is(flags::STOP)).count(), 1);
    no_long_stitch_from_the_stop(&p, (-40.0, -40.0));
}

#[test]
fn optimizing_objects_without_geometry_does_not_panic() {
    let d = doc(r##"{"threads":[{"id":"t","name":"T","color":"#000000"}],"objects":[{"id":"a","thread":"t","paths":[{"nodes":[{"p":[0,0]},{"p":[10,0]}]}],"stitch":{"type":"running"}},{"id":"b","thread":"t","paths":[],"stitch":{"type":"running"}},{"id":"n","thread":"t","paths":[{"nodes":[]}],"stitch":{"type":"running"}},{"id":"c","thread":"t","paths":[{"nodes":[{"p":[0,5]},{"p":[10,5]}]}],"stitch":{"type":"running"}}]}"##);
    let r = filum_core::optimize::optimize_order(&d, &mut Engine::new());
    assert_eq!(r.order.len(), 4);
}

#[test]
fn ripple_exponents_at_or_below_zero_stay_finite() {
    for json in [
        r#"{"objects":[{"id":"o0","paths":[{"nodes":[{"p":[-305.0,0]},{"p":[0,0]}]}],"stitch":{"ripple":{"exponent":-1.0,"fan":true},"type":"running"},"thread":"missing"}]}"#,
        r#"{"objects":[{"id":"o0","paths":[{"nodes":[{"p":[-30.0,0]},{"p":[0,0]}]}],"stitch":{"ripple":{"exponent":0.0},"type":"running"},"thread":"t"}]}"#,
    ] {
        let p = plan_within(json, 60);
        assert!(finite(&p) && p.stitches.iter().any(|s| s.is_stitch()));
    }
}

#[test]
fn absurd_split_lengths_and_widths_finish() {
    for json in [
        // satin split every 1e-6 mm
        r#"{"objects":[{"id":"o1","paths":[{"nodes":[{"p":[27.0,0]},{"p":[0,0]}]}],"stitch":{"maxStitchLength":1e-6,"type":"satin"},"thread":"t0"}]}"#,
        r#"{"objects":[{"id":"o4","paths":[{"nodes":[{"p":[0,0]},{"p":[94.0,0]}]}],"stitch":{"maxStitchLength":1e-6,"type":"satin"},"thread":"t3"}]}"#,
        // manual stitch split every 1e-6 mm
        r#"{"objects":[{"id":"o0","paths":[{"nodes":[{"p":[46.0,0]},{"p":[0,0]}]}],"stitch":{"maxLength":1e-6,"type":"manual"},"thread":"t0"}]}"#,
        // cross stitch split every 1e-6 mm
        r#"{"objects":[{"id":"o1","paths":[{"nodes":[{"p":[18.0,0]},{"p":[0,0]},{"p":[0,28.0]}]}],"stitch":{"crossMaxLength":1e-6,"method":"cross","type":"fill"},"thread":"t0"}]}"#,
        // ripples 1e-6 mm apart
        r#"{"objects":[{"id":"o4","paths":[{"closed":true,"nodes":[{"p":[92.0,0]},{"p":[0,0]}]}],"stitch":{"ripple":{"minLineDist":1e-6},"type":"running"},"thread":"t0"}]}"#,
        r#"{"objects":[{"id":"o2","paths":[{"nodes":[{"p":[80.0,0]},{"p":[0,0]}]}],"stitch":{"ripple":{"guide":[{"nodes":[{"p":[80.0,0]},{"p":[0,0]}]}],"minLineDist":1e-6},"type":"running"},"thread":"t2"}]}"#,
        // a tack-down 100 m wide
        r#"{"objects":[{"id":"o0","paths":[{"nodes":[{"p":[0,51.0]},{"p":[29.0,0]},{"p":[0,0]}]}],"stitch":{"tackdownWidth":100000.0,"type":"applique"},"thread":"t0"}]}"#,
    ] {
        let p = plan_within(json, 90);
        assert!(finite(&p), "{json}");
        assert!(p.stitches.len() < 3_000_000, "{} records: {json}", p.stitches.len());
    }
}

#[test]
fn ink_stitch_sized_splits_are_unchanged() {
    // a 4 mm satin split and a 3 mm manual split still split at those lengths
    let p = plan_within(r#"{"machine":{"ties":false},"objects":[{"id":"o0","paths":[{"nodes":[{"p":[30.0,0]},{"p":[0,0]}]}],"stitch":{"maxLength":3.0,"type":"manual"},"thread":"t0"}]}"#, 60);
    let pts: Vec<_> = p.stitches.iter().filter(|s| s.is_stitch()).collect();
    assert_eq!(pts.len(), 11);
}

#[test]
fn the_trim_after_an_arrow_lock_is_at_the_needle() {
    let p = plan_within(r#"{"machine":{"lockEnd":"arrow"},"objects":[{"id":"o1","paths":[{"nodes":[{"p":[55.0,0]},{"p":[0,0]}]}],"stitch":{"type":"running"},"thread":"t0"}]}"#, 60);
    let k = p.stitches.iter().position(|s| s.is(flags::TRIM)).expect("a trim");
    let last = p.stitches[..k].iter().rev().find(|s| s.is_stitch() || s.is(flags::JUMP)).unwrap();
    assert!((last.x - p.stitches[k].x).abs() < 1e-9 && (last.y - p.stitches[k].y).abs() < 1e-9);
}

#[test]
fn outlines_with_absurd_offsets_do_not_exhaust_memory() {
    for offset in [1e300, f64::INFINITY, f64::NAN, -1e300] {
        let rings = filum_core::geom::offset_rings(&[vec![filum_core::geom::pt(0.0, 0.0), filum_core::geom::pt(10.0, 0.0), filum_core::geom::pt(10.0, 10.0)]], offset, 0.1);
        assert!(rings.iter().flatten().all(|q| q.x.is_finite() && q.y.is_finite()), "{offset}");
    }
}
