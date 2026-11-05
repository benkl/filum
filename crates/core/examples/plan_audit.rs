//! Checks stitch plans and the machine files written from them against the
//! conventions of machine embroidery: where trims go, tie-ins and tie-offs,
//! what is left as a connecting stitch, stitch lengths, and how each format
//! carries trims, jumps and colour changes.
//!
//! ```text
//! cargo run --release -p filum-core --example plan_audit -- <dir of .filum designs> [--verbose]
//! ```
//! Designs can be made with `plan_bench --dump DIR`.

use std::path::PathBuf;

use filum_core::geom::{pt, Point};
use filum_core::plan::{flags, StitchPlan};
use filum_core::{io, Document, Engine};
use filum_formats as fmts;

/// A connecting stitch between two objects counts from this length (mm).
const CONNECT_MIN: f64 = 1.0;
/// Covered: within this of a stitch sewn later (mm).
const COVER: f64 = 0.45;
/// Long stitches: snag on garments (mm).
const LONG: f64 = 7.0;
/// Short stitches: thread breaks and bird nests (mm); ties are exempt.
const SHORT: f64 = 0.3;

#[derive(Default)]
struct Report {
    trims: usize,
    trims_no_tie_off: usize,
    restarts_no_tie_in: usize,
    trims_needless: usize,
    trims_inside_object: usize,
    /// Of those, where the straight way lies inside the object (a travel could do it).
    trims_inside_travelable: usize,
    colour_changes: usize,
    colour_changes_no_trim: usize,
    end_no_trim: bool,
    connections: usize,
    connections_exposed: Vec<f64>,
    connections_covered: usize,
    travel_mm: f64,
    travel_exposed_mm: f64,
    /// Of that, more than 0.6 mm inside the object's outline (on top of its own rows).
    travel_exposed_inside_mm: f64,
    /// Of that, crossing the rows under it (more than 25° off them): it shows.
    travel_across_mm: f64,
    long: usize,
    longest: f64,
    short: usize,
    jumps_untrimmed: usize,
}

/// Segments of the plan's sewn stitches by grid cell, with their index.
struct SegGrid {
    cell: f64,
    map: filum_core::geom::CellMap<Vec<(usize, Point, Point)>>,
}

impl SegGrid {
    fn new(plan: &StitchPlan) -> SegGrid {
        let mut g = SegGrid { cell: 1.0, map: Default::default() };
        let s = &plan.stitches;
        for i in 1..s.len() {
            if !s[i].is_stitch() || !s[i - 1].is_stitch() {
                continue;
            }
            let (a, b) = (s[i - 1].pos(), s[i].pos());
            let n = (a.dist(b) / g.cell).ceil().max(1.0) as usize;
            let mut seen = std::collections::HashSet::new();
            for k in 0..=n {
                let p = a + (b - a) * (k as f64 / n as f64);
                let key = ((p.x / g.cell).floor() as i64, (p.y / g.cell).floor() as i64);
                if seen.insert(key) {
                    g.map.entry(key).or_default().push((i, a, b));
                }
            }
        }
        g
    }

    /// Does a direction `d` at `p` cross the stitches sewn before `before`
    /// near it (the nearest within 0.6 mm more than 25° off)?
    fn across_before(&self, p: Point, d: Point, before: usize) -> bool {
        let (kx, ky) = ((p.x / self.cell).floor() as i64, (p.y / self.cell).floor() as i64);
        let mut best: Option<(f64, Point)> = None;
        for y in ky - 1..=ky + 1 {
            for x in kx - 1..=kx + 1 {
                for &(i, a, b) in self.map.get(&(x, y)).into_iter().flatten() {
                    let dd = seg_dist(p, a, b);
                    if i < before && dd < 0.6 && a.dist(b) > 0.3 && best.is_none_or(|q| dd < q.0) {
                        best = Some((dd, b - a));
                    }
                }
            }
        }
        best.is_some_and(|(_, e)| {
            let c = (d.dot(e) / (d.length() * e.length()).max(1e-12)).abs();
            c < 25f64.to_radians().cos()
        })
    }

    /// Is `p` within `r` of a stitch sewn after index `after`?
    fn covered_after(&self, p: Point, r: f64, after: usize) -> bool {
        let (kx, ky) = ((p.x / self.cell).floor() as i64, (p.y / self.cell).floor() as i64);
        for y in ky - 1..=ky + 1 {
            for x in kx - 1..=kx + 1 {
                for &(i, a, b) in self.map.get(&(x, y)).into_iter().flatten() {
                    if i > after && seg_dist(p, a, b) < r {
                        return true;
                    }
                }
            }
        }
        false
    }
}

fn seg_dist(p: Point, a: Point, b: Point) -> f64 {
    let d = b - a;
    let l2 = d.length_sq();
    let t = if l2 < 1e-12 { 0.0 } else { ((p - a).dot(d) / l2).clamp(0.0, 1.0) };
    (a + d * t).dist(p)
}

fn exposed(grid: &SegGrid, a: Point, b: Point, i: usize) -> bool {
    // a stretch of it more than a millimetre long that nothing sewn later covers
    let n = (a.dist(b) / 0.25).ceil().max(1.0) as usize;
    let mut run = 0.0;
    for k in 0..=n {
        let p = a + (b - a) * (k as f64 / n as f64);
        if grid.covered_after(p, COVER, i) {
            run = 0.0;
        } else {
            run += a.dist(b) / n as f64;
            if run > 1.0 {
                return true;
            }
        }
    }
    false
}

fn audit(doc: &Document, plan: &StitchPlan, trim_distance: f64) -> Report {
    let s = &plan.stitches;
    let rings: Vec<Vec<filum_core::geom::Ring>> = doc.objects.iter().map(|o| o.paths.iter().filter(|p| p.closed).map(|p| p.flatten(0.1)).filter(|r| r.len() >= 3).collect()).collect();
    let grid = SegGrid::new(plan);
    let mut r = Report::default();
    let last_stitch_before = |i: usize| s[..i].iter().rposition(|x| x.is_stitch());
    for i in 0..s.len() {
        let st = s[i];
        if st.is(flags::TRIM) {
            r.trims += 1;
            // a tie-off: tie stitches right before the trim
            let ties = s[..i].iter().rev().take_while(|x| !x.is(flags::COMMANDS) && x.is(flags::TIE)).count();
            if ties < 2 && last_stitch_before(i).is_some() {
                r.trims_no_tie_off += 1;
            }
            // what follows: the next stitch and how far it is
            if let Some(j) = s[i + 1..].iter().position(|x| x.is_stitch()).map(|k| k + i + 1) {
                let cmd_between = s[i + 1..j].iter().any(|x| x.is(flags::COLOR_CHANGE | flags::STOP));
                // a trim on a gap under 2 mm (sewn through by convention)
                let _ = trim_distance;
                if !cmd_between && st.pos().dist(s[j].pos()) <= 2.0 {
                    r.trims_needless += 1;
                }
                let before = last_stitch_before(i).map(|k| s[k].object);
                if !cmd_between && st.object != u32::MAX && before == Some(s[j].object) {
                    r.trims_inside_object += 1;
                    if let Some(rr) = rings.get(st.object as usize).filter(|r| !r.is_empty()) {
                        let (a, b) = (st.pos(), s[j].pos());
                        let n = (a.dist(b) / 0.3).ceil().max(1.0) as usize;
                        if (1..n).all(|k| filum_core::geom::point_in_rings(a + (b - a) * (k as f64 / n as f64), rr)) {
                            r.trims_inside_travelable += 1;
                        }
                    }
                }
                // a tie-in: tie stitches right after the restart
                let tie_in = s[j + 1..].iter().take_while(|x| x.is_stitch() && x.is(flags::TIE)).count();
                if tie_in < 2 {
                    r.restarts_no_tie_in += 1;
                }
            }
        }
        if st.is(flags::COLOR_CHANGE) {
            r.colour_changes += 1;
            // the machine cuts at a colour change: it needs a tie-off before it
            let ties = s[..i].iter().rev().take_while(|x| !x.is(flags::COMMANDS) && x.is(flags::TIE)).count();
            if ties < 2 {
                r.colour_changes_no_trim += 1;
            }
        }
        if st.is(flags::END) && !s[..i].iter().rev().take_while(|x| !x.is_stitch()).any(|x| x.is(flags::TRIM)) {
            r.end_no_trim = true;
        }
        if st.is(flags::JUMP) && !s[..i].iter().rev().take_while(|x| !x.is_stitch()).any(|x| x.is(flags::TRIM | flags::COLOR_CHANGE | flags::STOP)) && last_stitch_before(i).is_some() {
            r.jumps_untrimmed += 1;
        }
        if i == 0 || !st.is_stitch() || !s[i - 1].is_stitch() {
            continue;
        }
        let (a, b) = (s[i - 1].pos(), st.pos());
        let len = a.dist(b);
        if !st.is(flags::TIE) && !s[i - 1].is(flags::TIE) {
            if len > LONG {
                r.long += 1;
            }
            if len < SHORT && len > 1e-9 {
                r.short += 1;
            }
        }
        r.longest = r.longest.max(len);
        // a connecting stitch: from one object to the next without a trim
        if s[i - 1].object != st.object && st.object != u32::MAX && len >= CONNECT_MIN {
            r.connections += 1;
            if exposed(&grid, a, b, i) {
                r.connections_exposed.push(len);
            } else {
                r.connections_covered += 1;
            }
        }
        if st.is(flags::TRAVEL) {
            r.travel_mm += len;
            if exposed(&grid, a, b, i) {
                r.travel_exposed_mm += len;
                let m = a + (b - a) * 0.5;
                if let Some(rr) = rings.get(st.object as usize).filter(|r| !r.is_empty()) {
                    if filum_core::geom::point_in_rings(m, rr) && filum_core::geom::dist_to_boundary(rr, m) > 0.6 {
                        r.travel_exposed_inside_mm += len;
                        if grid.across_before(m, b - a, i) {
                            r.travel_across_mm += len;
                        }
                    }
                }
            }
        }
    }
    r
}

/// The largest move along one axis in a written file read back (the formats'
/// limits are per axis), and its trims, colour changes and jumps.
fn file_check(plan: &StitchPlan, doc: &Document, f: fmts::Format) -> Result<(f64, f64, usize, usize, usize), String> {
    let pat = io::plan_to_pattern_at(plan, &doc.name, doc.options.origin);
    let bytes = fmts::write(&pat, f).map_err(|e| format!("{e:?}"))?;
    let back = fmts::read(&bytes, f).map_err(|e| format!("{e:?}"))?;
    let (mut st_max, mut jump_max) = (0.0f64, 0.0f64);
    let mut prev: Option<(f64, f64)> = None;
    let (mut trims, mut changes, mut jumps) = (0, 0, 0);
    for x in &back.stitches {
        if x.flags & fmts::cmd::TRIM != 0 {
            trims += 1;
        }
        if x.flags & (fmts::cmd::COLOR_CHANGE) != 0 {
            changes += 1;
        }
        if x.flags & (fmts::cmd::TRIM | fmts::cmd::COLOR_CHANGE | fmts::cmd::STOP | fmts::cmd::END) != 0 {
            continue;
        }
        if let Some(p) = prev {
            let d = (x.x - p.0).abs().max((x.y - p.1).abs());
            if x.flags & fmts::cmd::JUMP != 0 {
                jumps += 1;
                jump_max = jump_max.max(d);
            } else {
                st_max = st_max.max(d);
            }
        }
        prev = Some((x.x, x.y));
    }
    Ok((st_max, jump_max, trims, changes, jumps))
}

/// The plan as SVG: sewn stitches grey, travel blue, exposed travel and
/// exposed connecting stitches red.
fn svg_of(plan: &StitchPlan, path: &str) {
    let s = &plan.stitches;
    let grid = SegGrid::new(plan);
    let (mut x0, mut y0, mut x1, mut y1) = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
    for x in s {
        x0 = x0.min(x.x);
        y0 = y0.min(x.y);
        x1 = x1.max(x.x);
        y1 = y1.max(x.y);
    }
    let mut out = format!("<svg xmlns='http://www.w3.org/2000/svg' viewBox='{} {} {} {}' width='1400' style='background:#fff'>", x0 - 2.0, y0 - 2.0, x1 - x0 + 4.0, y1 - y0 + 4.0);
    for i in 1..s.len() {
        if !s[i].is_stitch() || !s[i - 1].is_stitch() {
            continue;
        }
        let (a, b) = (s[i - 1].pos(), s[i].pos());
        let connect = s[i - 1].object != s[i].object && a.dist(b) >= CONNECT_MIN;
        let (col, w) = if s[i].is(flags::TRAVEL) || connect {
            if exposed(&grid, a, b, i) { ("#e0182d", 0.35) } else { ("#3a7bd5", 0.2) }
        } else {
            ("#bbbbbb", 0.12)
        };
        out += &format!("<line x1='{:.2}' y1='{:.2}' x2='{:.2}' y2='{:.2}' stroke='{col}' stroke-width='{w}'/>", a.x, a.y, b.x, b.y);
    }
    out += "</svg>";
    let _ = std::fs::write(path, out);
}

fn main() -> Result<(), String> {
    let args: Vec<String> = std::env::args().collect();
    let dir = PathBuf::from(args.get(1).ok_or("usage: plan_audit <dir of .filum designs>")?);
    let verbose = args.iter().any(|a| a == "--verbose");
    let mut files: Vec<PathBuf> = std::fs::read_dir(&dir).map_err(|e| e.to_string())?.filter_map(|e| e.ok().map(|e| e.path())).filter(|p| p.extension().is_some_and(|e| e == "filum")).collect();
    files.sort();
    println!(
        "{:<20} {:>5} | {:>5} {:>6} {:>6} {:>6} {:>4} {:>6} | {:>4} {:>4} | {:>5} {:>7} {:>7} | {:>6} {:>6} {:>6} | {:>4} {:>5} {:>5} {:>6}",
        "design", "trims", "noOff", "noIn", "needl", "inObj", "trvl", "untrJ", "CC", "CCnoTie", "conn", "exposed", "max mm", "trav", "exp", "inside", "long", "short", "max", "across"
    );
    for path in files {
        let doc: Document = serde_json::from_str(&std::fs::read_to_string(&path).map_err(|e| e.to_string())?).map_err(|e| format!("{}: {e}", path.display()))?;
        let plan = Engine::new().plan(&doc);
        let r = audit(&doc, &plan, doc.machine.trim_distance);
        let name = path.file_stem().and_then(|s| s.to_str()).unwrap_or("").to_string();
        let exp_max = r.connections_exposed.iter().copied().fold(0.0, f64::max);
        println!(
            "{:<20} {:>5} | {:>5} {:>6} {:>6} {:>6} {:>4} {:>6} | {:>4} {:>4} | {:>5} {:>7} {:>7.1} | {:>6.0} {:>6.0} {:>6.0} | {:>4} {:>5} {:>5.1} {:>6.0}{}",
            name,
            r.trims,
            r.trims_no_tie_off,
            r.restarts_no_tie_in,
            r.trims_needless,
            r.trims_inside_object,
            r.trims_inside_travelable,
            r.jumps_untrimmed,
            r.colour_changes,
            r.colour_changes_no_trim,
            r.connections,
            r.connections_exposed.len(),
            exp_max,
            r.travel_mm,
            r.travel_exposed_mm,
            r.travel_exposed_inside_mm,
            r.long,
            r.short,
            r.longest,
            r.travel_across_mm,
            if r.end_no_trim { "  END without trim" } else { "" }
        );
        if let Some(dir) = args.iter().position(|a| a == "--svg").and_then(|i| args.get(i + 1)) {
            svg_of(&plan, &format!("{dir}/{name}.svg"));
        }
        if verbose {
            let mut v = r.connections_exposed.clone();
            v.sort_by(|a, b| b.partial_cmp(a).unwrap());
            println!("    exposed connections (mm): {:?}", v.iter().map(|x| (x * 10.0).round() / 10.0).collect::<Vec<_>>());
        }
        // per-axis limits: DST 12.1 mm, EXP and JEF 12.7 mm (one signed byte);
        // PES (PEC long form) and VP3 carry long moves
        for (ext, f, limit) in [("dst", fmts::Format::Dst, 12.1), ("pes", fmts::Format::Pes, 204.7), ("exp", fmts::Format::Exp, 12.7), ("jef", fmts::Format::Jef, 12.7), ("vp3", fmts::Format::Vp3, 3276.7)] {
            match file_check(&plan, &doc, f) {
                Ok((st, jm, trims, changes, jumps)) => {
                    let flag = if st > limit + 1e-3 || jm > limit + 1e-3 { "  OVER LIMIT" } else { "" };
                    if verbose || !flag.is_empty() {
                        println!("    {ext}: largest stitch move {st:5.2} mm, jump move {jm:5.2} mm per axis, {trims:>3} trims, {changes:>3} colour changes, {jumps:>4} jump records read back{flag}");
                    }
                }
                Err(e) => println!("    {ext}: {e}"),
            }
        }
    }
    let _ = pt(0.0, 0.0);
    Ok(())
}
