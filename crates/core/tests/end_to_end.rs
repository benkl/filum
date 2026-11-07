//! Document → stitch plan → machine files → re-import, and Ink/Stitch SVG → plan.

use filum_core::geom::pt;
use filum_core::*;

fn circle(cx: f64, cy: f64, r: f64) -> SubPath {
    let pts: Vec<_> = (0..48)
        .map(|i| {
            let a = i as f64 / 48.0 * std::f64::consts::TAU;
            pt(cx + r * a.cos(), cy + r * a.sin())
        })
        .collect();
    SubPath::polyline(&pts, true)
}

fn obj(id: &str, thread: &str, paths: Vec<SubPath>, stitch: StitchParams) -> Object {
    Object { id: id.into(), name: id.into(), thread: thread.into(), visible: true, locked: false, paths, stitch, trim_after: false, stop_after: false, ties: Default::default(), force_lock: false, min_stitch: None, min_jump: None, clone: None, lock: None, color_sort_index: None ,
            hidden: None, patterns: vec![], start: None, end: None }
}

fn sample() -> Document {
    let mut d = Document::default();
    d.threads = vec![
        Thread { id: "a".into(), name: "Red".into(), color: "#c8102e".into(), brand: String::new(), code: String::new(), weight: None },
        Thread { id: "b".into(), name: "Navy".into(), color: "#1f2a56".into(), brand: String::new(), code: String::new(), weight: None },
    ];
    d.objects = vec![
        obj("fill", "a", vec![circle(50.0, 50.0, 20.0), circle(50.0, 50.0, 8.0)], StitchParams::Fill(FillParams::default())),
        obj("ring", "b", vec![circle(50.0, 50.0, 20.0), circle(50.0, 50.0, 23.0)], StitchParams::Satin(SatinParams::default())),
        obj(
            "line",
            "b",
            vec![SubPath::polyline(&[pt(10.0, 90.0), pt(90.0, 90.0)], false)],
            StitchParams::Running(RunningParams { bean_repeats: 2, ..Default::default() }),
        ),
    ];
    d
}

#[test]
fn plan_is_sane() {
    let d = sample();
    let mut e = Engine::new();
    let p = e.plan(&d);
    let st = p.stats(800.0, 6.0, 12.0);
    assert_eq!(p.threads.len(), 2);
    assert_eq!(st.color_changes, 1);
    assert!(st.stitches > 3000, "{}", st.stitches);
    // no penetration-to-penetration move longer than the satin width + margin
    let mut last: Option<geom::Point> = None;
    for s in &p.stitches {
        if s.is_stitch() {
            if let Some(l) = last {
                assert!(l.dist(s.pos()) < 8.0, "long stitch {} at {:?}", l.dist(s.pos()), s.pos());
            }
            last = Some(s.pos());
        } else {
            last = None;
        }
    }
    assert!(p.stitches.last().unwrap().is(flags::END));
}

#[test]
fn every_machine_format_roundtrips() {
    let d = sample();
    let mut e = Engine::new();
    let n = e.plan(&d).stats(800.0, 6.0, 12.0).stitches;
    for f in io::formats().into_iter().filter(|f| f.machine && f.can_write && f.can_read) {
        let bytes = io::export(&d, &mut e, &f.extension).unwrap_or_else(|err| panic!("{}: {err}", f.extension));
        let back = io::import(&bytes, Some(&format!("x.{}", f.extension))).unwrap_or_else(|err| panic!("{}: {err}", f.extension));
        let mut e2 = Engine::new();
        let m = e2.plan(&back).stats(800.0, 6.0, 12.0).stitches;
        // re-planning adds ties; counts must be close
        let ratio = m as f64 / n as f64;
        assert!((0.95..1.1).contains(&ratio), "{}: {n} → {m}", f.extension);
        assert_eq!(back.objects.len(), 2, "{}: one manual object per colour block", f.extension);
    }
}

#[test]
fn inkstitch_svg_to_dst() {
    let svg = r##"<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkstitch="http://inkstitch.org/namespace" width="60mm" height="60mm" viewBox="0 0 60 60">
      <path d="M 10 10 H 50 V 50 H 10 Z" fill="#336699" inkstitch:angle="30"/>
      <path d="M 5 55 L 55 55 M 5 58 L 55 58" style="fill:none;stroke:#000" inkstitch:satin_column="True"/>
    </svg>"##;
    let d = svg::import_svg(svg).unwrap().document;
    let mut e = Engine::new();
    let dst = io::export(&d, &mut e, "dst").unwrap();
    assert_eq!(&dst[0..3], b"LA:");
    assert!(dst.len() > 512 + 3 * 1000);
}
