//! Whole-design stitch-out quality: minimum stitch at fill row turns, lock
//! stitches (manual stitch, imported files, per-object locks), the stitch
//! order optimiser keeping details on top, hidden-stitch removal keeping
//! routed underpaths and gaps between covers, "keep underlay" and basting.

use filum_core::geom::{pt, Point};
use filum_core::optimize::optimize_order;
use filum_core::*;

fn obj(id: &str, thread: &str, paths: Vec<SubPath>, stitch: StitchParams) -> Object {
    Object {
        id: id.into(),
        name: id.into(),
        thread: thread.into(),
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

fn rect(x: f64, y: f64, w: f64, h: f64) -> Vec<SubPath> {
    vec![SubPath::polyline(&[pt(x, y), pt(x + w, y), pt(x + w, y + h), pt(x, y + h)], true)]
}

fn line(pts: &[(f64, f64)]) -> Vec<SubPath> {
    let p: Vec<Point> = pts.iter().map(|&(x, y)| pt(x, y)).collect();
    vec![SubPath::polyline(&p, false)]
}

fn thread(id: &str, color: &str) -> Thread {
    Thread { id: id.into(), name: id.into(), color: color.into(), brand: String::new(), code: String::new(), weight: None }
}

fn doc(objects: Vec<Object>) -> Document {
    Document { threads: vec![thread("r", "#c8102e"), thread("b", "#1f4e9c"), thread("w", "#ffffff"), thread("k", "#111111")], objects, ..Default::default() }
}

fn fill() -> StitchParams {
    StitchParams::Fill(FillParams { underlay: false, ..Default::default() })
}

fn satin(width: f64) -> StitchParams {
    StitchParams::Satin(SatinParams { width, center_walk: true, ..Default::default() })
}

fn count(p: &StitchPlan, f: u8) -> usize {
    p.stitches.iter().filter(|s| s.is(f)).count()
}

/// 1. The minimum stitch (0.3 mm on the machine) must not drop the 0.25 mm
/// step from one tatami row to the next: every other row would start with a
/// slanted stitch (a saw-tooth edge, fabric showing between the rows).
#[test]
fn min_stitch_keeps_the_step_to_the_next_row() {
    let dense = StitchParams::Fill(FillParams { underlay: false, angle: 0.0, row_spacing: 0.25, ..Default::default() });
    let d = doc(vec![obj("a", "r", rect(0.0, 0.0, 20.0, 20.0), dense)]);
    assert!(d.machine.min_stitch >= 0.3, "the test needs a minimum stitch over the row spacing");
    let p = Engine::new().plan(&d);
    let sewn: Vec<&Stitch> = p.stitches.iter().filter(|s| s.object == 0 && s.is_stitch()).collect();
    assert!(sewn.len() > 500);
    let mut slanted = 0;
    let mut steps = 0;
    // the rows (not the locks, nor a travel to where the rows begin)
    for w in sewn.windows(2).filter(|w| !w.iter().any(|s| s.is(flags::TIE | flags::TRAVEL))) {
        let (dx, dy) = ((w[1].x - w[0].x).abs(), (w[1].y - w[0].y).abs());
        if dy > 0.01 && dx > 0.05 {
            slanted += 1;
        }
        if dy > 0.2 && dy < 0.3 && dx < 0.05 {
            steps += 1;
        }
    }
    assert_eq!(slanted, 0, "every row starts straight above the end of the one before");
    assert!(steps > 60, "the 0.25 mm steps between rows are sewn: {steps}");

    // short stitches along a line still go (Ink/Stitch drops them too)
    let run = StitchParams::Running(RunningParams { length: 0.2, ..Default::default() });
    let d = doc(vec![obj("l", "r", line(&[(0.0, 0.0), (10.0, 0.0)]), run)]);
    let p = Engine::new().plan(&d);
    let short = p
        .stitches
        .windows(2)
        .filter(|w| w[0].is_stitch() && w[1].is_stitch() && !w[1].is(flags::TIE) && !w[0].is(flags::TIE) && w[0].pos().dist(w[1].pos()) < 0.3)
        .count();
    assert_eq!(short, 0, "0.2 mm stitches along a line are merged");
}

/// 2a. Manual stitch places every needle drop itself: no lock stitches on
/// top, unless it forces them (Ink/Stitch `force_lock_stitches`).
#[test]
fn manual_stitch_gets_no_locks_unless_forced() {
    let pts = [(0.0, 0.0), (3.0, 0.0), (6.0, 0.0), (9.0, 0.0), (12.0, 0.0)];
    let manual = obj("m", "r", line(&pts), StitchParams::Manual(Default::default()));
    let p = Engine::new().plan(&doc(vec![manual.clone()]));
    assert_eq!(count(&p, flags::TIE), 0, "no locks on a manual stitch");
    let forced = Object { force_lock: true, ..manual };
    let p = Engine::new().plan(&doc(vec![forced]));
    assert!(count(&p, flags::TIE) >= 6, "forced: locked at both ends");
}

/// 2b. A machine file's stitches already hold its locks: importing it adds
/// none, and round trips don't grow the design.
#[test]
fn imported_files_keep_their_own_locks() {
    let mut d = doc(vec![
        obj("a", "r", line(&[(0.0, 0.0), (30.0, 0.0)]), StitchParams::Running(RunningParams::default())),
        obj("b", "r", line(&[(0.0, 20.0), (30.0, 20.0)]), StitchParams::Running(RunningParams::default())),
        obj("c", "b", rect(40.0, 0.0, 15.0, 15.0), fill()),
    ]);
    d.objects[0].trim_after = true;
    let mut e = Engine::new();
    let stitches = |p: &StitchPlan| p.stitches.iter().filter(|s| s.is_stitch()).count();
    let p0 = Engine::new().plan(&d);
    let ties0 = count(&p0, flags::TIE);
    assert!(ties0 > 0);

    let back = filum_core::io::plan_to_document(&p0, "back");
    assert!(back.objects.iter().all(|o| o.ties == Ties::None));
    let p1 = e.plan(&back);
    assert_eq!(count(&p1, flags::TIE), 0, "no locks added on top of the file's");

    // DST round trips: the stitch count stays put
    let mut doc_now = d.clone();
    let mut counts = vec![];
    for _ in 0..3 {
        let bytes = filum_core::io::export_with(&doc_now, &mut e, "dst", &Default::default()).unwrap();
        doc_now = filum_core::io::import(&bytes, Some("x.dst")).unwrap();
        counts.push(stitches(&e.plan(&doc_now)));
    }
    assert!(counts[2] <= counts[0] && counts[1] <= counts[0], "round trips add no locks: {counts:?}");
}

/// An object's own lock stitches win over the machine's.
#[test]
fn an_objects_own_locks_are_used() {
    let run = StitchParams::Running(RunningParams::default());
    let plain = obj("a", "r", line(&[(0.0, 0.0), (30.0, 0.0)]), run);
    let reach = |o: Object| {
        let p = Engine::new().plan(&doc(vec![o]));
        let start = p.stitches.iter().find(|s| s.is_stitch()).unwrap().pos();
        p.stitches.iter().take_while(|s| !s.is_stitch() || s.is(flags::TIE) || s.pos().dist(start) < 1e-9).map(|s| s.pos().dist(start)).fold(0.0, f64::max)
    };
    let machine = reach(plain.clone());
    assert!(machine <= 1.6, "half stitch: {machine}");
    let own = Object { lock: Some(LockOverride { start: Some(LockStyle::BackForth), start_length: Some(2.0), ..Default::default() }), ..plain };
    let mine = reach(own);
    assert!((mine - 4.0).abs() < 0.05, "back and forth over 2 mm twice: {mine}");
}

/// 3. The optimiser keeps a detail in the same thread on top of the fill
/// under it (a border sewn first would vanish under the fill).
#[test]
fn optimiser_keeps_same_colour_details_on_top() {
    for detail in [
        obj("B", "r", line(&[(29.0, 1.0), (29.0, 29.0), (1.0, 29.0)]), StitchParams::Running(RunningParams::default())),
        obj("B", "r", line(&[(0.0, 0.0), (30.0, 0.0), (30.0, 30.0), (0.0, 30.0), (0.0, 0.0)]), StitchParams::Satin(SatinParams { width: 2.5, ..Default::default() })),
    ] {
        let d = doc(vec![obj("X", "r", rect(32.0, 0.0, 4.0, 4.0), fill()), obj("A", "r", rect(0.0, 0.0, 30.0, 30.0), fill()), detail]);
        let r = optimize_order(&d, &mut Engine::new());
        let pos = |id: &str| r.order.iter().position(|x| x == id).unwrap();
        assert!(pos("A") < pos("B"), "the detail stays on top: {:?}", r.order);
    }
    // two fills in one thread may still swap (nothing shows)
    let d = doc(vec![obj("X", "r", rect(60.0, 0.0, 4.0, 4.0), fill()), obj("A", "r", rect(0.0, 0.0, 30.0, 30.0), fill()), obj("B", "r", rect(50.0, 0.0, 12.0, 12.0), fill())]);
    let r = optimize_order(&d, &mut Engine::new());
    assert_eq!(r.order, vec!["X", "B", "A"], "nearest first among same-thread fills");
}

/// 4. "Remove running stitches under covers" keeps a routed underpath (the
/// line the next satin sews back over): taking it out brings the trims back.
#[test]
fn routed_underpaths_stay() {
    let mut d = doc(vec![
        obj("S1", "k", line(&[(0.0, 0.0), (20.0, 0.0)]), satin(3.0)),
        obj("P", "k", line(&[(20.0, 0.0), (20.0, 20.0)]), StitchParams::Running(RunningParams { length: 2.0, ..Default::default() })),
        obj("S2", "k", line(&[(20.0, 20.0), (20.0, 0.0)]), satin(3.0)),
        obj("S3", "k", line(&[(20.0, 0.0), (40.0, 0.0)]), satin(3.0)),
    ]);
    d.options.remove_overlaps = true;
    let plain = count(&Engine::new().plan(&d), flags::TRIM);
    d.options.trim_running = true;
    let trimmed = count(&Engine::new().plan(&d), flags::TRIM);
    assert_eq!(trimmed, plain, "no trims where the path was");
    assert!(Engine::new().stitched_object(&d, 1).is_some());

    // the router marks its paths as kept
    // a spine with a branch off it that forks: the way out along the branch is a path
    let tree = [[(0.0, 0.0), (40.0, 0.0)], [(10.0, 0.0), (10.0, 10.0)], [(10.0, 10.0), (5.0, 15.0)], [(10.0, 10.0), (15.0, 15.0)]];
    let lines: Vec<Object> = tree.iter().map(|l| obj("a", "k", line(l), satin(1.2))).collect();
    let routed = filum_core::outline_route::route_lines(lines, pt(0.0, 0.0));
    let paths: Vec<&Object> = routed.iter().filter(|o| o.name.contains("path")).collect();
    assert!(!paths.is_empty(), "{:?}", routed.iter().map(|o| &o.name).collect::<Vec<_>>());
    assert!(paths.iter().all(|o| o.hidden.is_some_and(|h| h.keep)));
    let mut d = doc(routed);
    d.options.remove_overlaps = true;
    let plain = count(&Engine::new().plan(&d), flags::TRIM);
    d.options.trim_running = true;
    assert_eq!(count(&Engine::new().plan(&d), flags::TRIM), plain, "the routed network still sews without trims");
}

/// 5. "Keep underlay": the full underlay and the top of what's left of the
/// fill are joined by a travel inside the shape, not a tie-off, trim and jump.
#[test]
fn keep_underlay_travels_to_the_top_stitching() {
    let under = StitchParams::Fill(FillParams { underlay: true, underlay_auto: false, ..Default::default() });
    for top in [rect(8.0, 8.0, 14.0, 14.0), rect(-1.0, 12.0, 32.0, 6.0)] {
        let mut d = doc(vec![obj("A", "b", rect(0.0, 0.0, 30.0, 30.0), under.clone()), obj("B", "w", top, fill())]);
        d.options.remove_overlaps = true;
        d.options.keep_underlay = true;
        let p = Engine::new().plan(&d);
        let s = &p.stitches;
        // from the end of the underlay to the first stitch of the top: a travel, no break
        let u = s.iter().rposition(|x| x.object == 0 && x.is(flags::UNDERLAY)).unwrap();
        let t = u + s[u..].iter().position(|x| x.object == 0 && x.is_stitch() && !x.is(flags::UNDERLAY | flags::TRAVEL | flags::TIE)).unwrap();
        assert!(s[u..t].iter().all(|x| x.is_stitch() && !x.is(flags::TIE)), "no tie-off, trim or jump from the underlay to the top");
        assert!(s[u..t].iter().any(|x| x.is(flags::TRAVEL)) || s[u].pos().dist(s[t].pos()) < 3.0, "a travel to the top");
        let a: Vec<&Stitch> = s.iter().filter(|s| s.object == 0).collect();
        // the underlay under the cover is still there
        let ul = a.iter().filter(|s| s.is(flags::UNDERLAY) && s.x > 9.0 && s.x < 21.0 && s.y > 13.0 && s.y < 17.0).count();
        assert!(ul > 0, "underlay under the cover");
    }
}

/// 6. Basting is pulled out after sewing: it is tied off and cut before the
/// knockdown starts.
#[test]
fn basting_is_cut_before_the_knockdown() {
    for basting in [Basting::Contour, Basting::Box] {
        let mut d = doc(vec![obj("A", "b", rect(10.0, 10.0, 30.0, 30.0), fill()), obj("B", "r", rect(20.0, 20.0, 10.0, 10.0), fill())]);
        d.options.basting = basting;
        d.options.basting_margin = 2.0;
        d.options.knockdown = true;
        d.options.knockdown_offset = 2.0;
        let p = Engine::new().plan(&d);
        let (_, end) = p.basting.expect("basting");
        assert!(p.stitches[end - 1].is(flags::TRIM), "{basting:?}: a trim after the basting");
        assert!(p.stitches[end - 2].is(flags::TIE), "{basting:?}: tied off before it");
        // the knockdown starts with a jump and a tie-in
        let next = &p.stitches[end..];
        assert!(next[0].is(flags::JUMP));
        assert!(next.iter().take(6).filter(|s| s.is(flags::TIE)).count() >= 3, "{basting:?}: tied in");
    }
}

/// 7. Hidden-stitch removal keeps the lower fill under a narrow gap between
/// two covers (it shows there), but not a sliver along its own outline.
#[test]
fn a_narrow_gap_between_two_covers_keeps_the_fill_under_it() {
    let area = |d: &Document| {
        Engine::new().stitched_object(d, 0).map_or(0.0, |o| filum_core::geom::rings_area(&filum_core::stitches::fill::fill_rings(&o.paths)))
    };
    let two_covers = |gap: f64| {
        let mut d = doc(vec![
            obj("A", "b", rect(0.0, 0.0, 30.0, 30.0), fill()),
            obj("B", "w", rect(-1.0, -1.0, 32.0, 16.0 - gap / 2.0), fill()),
            obj("C", "w", rect(-1.0, 15.0 + gap / 2.0, 32.0, 16.0), fill()),
        ]);
        d.options.remove_overlaps = true;
        d
    };
    // two outlines drawn along each other (a hair apart) leave no gap
    assert!(area(&two_covers(0.06)) < 1.0, "{}", area(&two_covers(0.06)));
    for gap in [0.15, 0.2, 0.28] {
        let d = two_covers(gap);
        let m = d.options.overlap_margin;
        assert!(m > 0.0);
        let a = area(&d);
        let want = 30.0 * (gap + 2.0 * m);
        assert!((a - want).abs() < 0.1 * want, "gap {gap}: {a} mm² of the fill under it (want {want})");
    }
    // a sliver along the fill's own edge goes
    let mut d = doc(vec![obj("A", "b", rect(0.0, 0.0, 30.0, 30.0), fill()), obj("B", "w", rect(-1.0, 0.1, 32.0, 31.0), fill())]);
    d.options.remove_overlaps = true;
    assert!(area(&d) < 1.0, "{}", area(&d));
}
