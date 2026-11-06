//! File I/O: bridges documents/stitch plans to machine formats
//! (`filum-formats`), Ink/Stitch SVG and the native JSON project format.

use serde::Serialize;
use filum_formats as fmts;

use crate::assemble::Engine;
use crate::model::{Document, Object, StitchParams, SubPath, Thread};
use crate::plan::{flags, Stitch, StitchPlan};
use crate::svg;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FormatDescriptor {
    pub extension: String,
    pub name: String,
    pub can_read: bool,
    pub can_write: bool,
    pub machine: bool,
}

pub fn formats() -> Vec<FormatDescriptor> {
    let mut v: Vec<FormatDescriptor> = fmts::formats()
        .iter()
        .map(|f| FormatDescriptor {
            extension: f.extension.to_string(),
            name: f.name.to_string(),
            can_read: f.can_read,
            can_write: f.can_write,
            machine: true,
        })
        .collect();
    v.push(FormatDescriptor { extension: "svg".into(), name: "Ink/Stitch SVG".into(), can_read: true, can_write: true, machine: false });
    v.push(FormatDescriptor { extension: "threadlist".into(), name: "Thread list (Ink/Stitch TXT)".into(), can_read: false, can_write: true, machine: false });
    v.push(FormatDescriptor { extension: "filum".into(), name: "Filum project".into(), can_read: true, can_write: true, machine: false });
    v
}

pub fn plan_to_pattern(plan: &StitchPlan, name: &str) -> fmts::Pattern {
    plan_to_pattern_at(plan, name, None)
}

/// The plan as a machine pattern with `origin` (design mm) at 0,0, or
/// centred on the design.
pub fn plan_to_pattern_at(plan: &StitchPlan, name: &str, origin: Option<[f64; 2]>) -> fmts::Pattern {
    let plan = match origin {
        Some([x, y]) => {
            let mut p = plan.clone();
            for s in &mut p.stitches {
                s.x -= x;
                s.y -= y;
            }
            p
        }
        None => plan.centered(),
    };
    fmts::Pattern {
        name: name.to_string(),
        stitches: plan.stitches.iter().map(|s| fmts::Stitch { x: s.x, y: s.y, flags: s.flags }).collect(),
        threads: plan
            .threads
            .iter()
            .map(|t| fmts::Thread { rgb: t.rgb(), name: t.name.clone(), code: t.code.clone(), brand: t.brand.clone() })
            .collect(),
    }
}

pub fn pattern_to_plan(p: &fmts::Pattern) -> StitchPlan {
    StitchPlan {
        stitches: p.stitches.iter().map(|s| Stitch { x: s.x, y: s.y, flags: s.flags, object: u32::MAX }).collect(),
        threads: p
            .threads
            .iter()
            .enumerate()
            .map(|(i, t)| Thread {
                id: format!("t{}", i + 1),
                name: if t.name.is_empty() { crate::threads::nearest_name(t.rgb) } else { t.name.clone() },
                color: crate::model::hex_color(t.rgb),
                brand: t.brand.clone(),
                code: t.code.clone(),
                weight: None,
            })
            .collect(),
        basting: None,
    }
}

/// Convert a machine stitch plan into an editable document: one object per
/// colour block, each continuous run becomes a manual-stitch sub-path.
pub fn plan_to_document(plan: &StitchPlan, name: &str) -> Document {
    let mut doc = Document { name: name.to_string(), ..Document::default() };
    let b = plan.bounds();
    let (ox, oy) = if b.is_empty() { (0.0, 0.0) } else { (b.min_x - 5.0, b.min_y - 5.0) };
    doc.hoop.width = (b.width() + 10.0).max(50.0).ceil();
    doc.hoop.height = (b.height() + 10.0).max(50.0).ceil();
    let mut block = 0usize;
    let mut runs: Vec<Vec<crate::geom::Point>> = vec![vec![]];
    let flush = |doc: &mut Document, block: usize, runs: &mut Vec<Vec<crate::geom::Point>>| {
        let paths: Vec<SubPath> = runs.drain(..).filter(|r| r.len() >= 2).map(|r| SubPath::polyline(&r, false)).collect();
        runs.push(vec![]);
        if paths.is_empty() {
            return;
        }
        let t = plan.threads.get(block).cloned().unwrap_or(Thread {
            id: format!("t{}", block + 1),
            name: "Thread".into(),
            color: "#1c1c1c".into(),
            brand: String::new(),
            code: String::new(),
            weight: None,
        });
        let tid = if doc.threads.iter().any(|x| x.id == t.id) {
            format!("t{}", doc.threads.len() + 1)
        } else {
            t.id.clone()
        };
        doc.threads.push(Thread { id: tid.clone(), ..t.clone() });
        doc.objects.push(Object {
            id: format!("imp{}", doc.objects.len() + 1),
            name: format!("{} {}", t.name, block + 1),
            thread: tid,
            visible: true,
            locked: false,
            paths,
            stitch: StitchParams::Manual(Default::default()),
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
        });
    };
    for s in &plan.stitches {
        if s.is(flags::COLOR_CHANGE) {
            flush(&mut doc, block, &mut runs);
            block += 1;
            continue;
        }
        if s.is(flags::JUMP) || s.is(flags::TRIM) || s.is(flags::STOP) {
            if runs.last().map_or(false, |r| !r.is_empty()) {
                runs.push(vec![]);
            }
            continue;
        }
        if s.is(flags::END) {
            continue;
        }
        runs.last_mut().unwrap().push(crate::geom::pt(s.x - ox, s.y - oy));
    }
    flush(&mut doc, block, &mut runs);
    doc
}

/// Export options (machine formats).
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ExportOptions {
    /// PES version: 1 (default, as Ink/Stitch) or 6 (with the exact thread list).
    pub pes_version: u32,
    /// Repeats of the design side by side and below each other, and their
    /// distance (mm) — Ink/Stitch ZIP export "panelization" (`x-repeats`,
    /// `y-repeats`, `x-spacing`, `y-spacing`).
    pub x_repeats: u32,
    pub y_repeats: u32,
    pub x_spacing: f64,
    pub y_spacing: f64,
}

impl Default for ExportOptions {
    fn default() -> Self {
        ExportOptions { pes_version: 1, x_repeats: 1, y_repeats: 1, x_spacing: 100.0, y_spacing: 100.0 }
    }
}

/// The stitch plan as it goes into a file: repeated (panelization) and with
/// the frame moving out to the stop position before every stop.
pub fn export_plan(doc: &Document, engine: &mut Engine, opts: &ExportOptions) -> StitchPlan {
    let mut plan = engine.plan(doc);
    // the machine's longest stitch (Settings → Machine): longer ones are split
    let max = doc.machine.max_stitch;
    if max.is_finite() && max > 0.0 {
        plan = plan.split_long_moves(max.max(1.0));
    }
    if opts.x_repeats > 1 || opts.y_repeats > 1 {
        let (x, y) = (opts.x_repeats.clamp(1, 20), opts.y_repeats.clamp(1, 20));
        plan = plan.make_offsets(&StitchPlan::grid_offsets(x, y, opts.x_spacing, opts.y_spacing));
    }
    if let Some([x, y]) = doc.options.stop_position {
        plan = plan.with_stop_position(crate::geom::pt(x, y));
    }
    plan
}

impl ExportOptions {
    fn write_options(&self) -> fmts::WriteOptions {
        fmts::WriteOptions { pes_version: if self.pes_version == 6 { fmts::PesVersion::V6 } else { fmts::PesVersion::V1 }, ..Default::default() }
    }
}

/// A colour of the thread-table entry a file stores for a block.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShownColor {
    pub color: String,
    pub name: String,
    pub code: String,
    pub brand: String,
    /// 1-based slot in the machine's thread table.
    pub slot: Option<usize>,
}

/// What the machine shows for one colour block of an export.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MachineColorInfo {
    pub block: usize,
    /// The design's thread.
    pub color: String,
    pub name: String,
    pub code: String,
    pub brand: String,
    /// The table entry the file stores (`None`: the file has no colours).
    pub shown: Option<ShownColor>,
    /// The file also stores the exact thread (VP3, XXX, PES v6).
    pub exact: bool,
    /// CIEDE2000 between the thread and the shown table colour.
    pub delta_e: Option<f64>,
}

/// The colours a machine will show for each colour block of `format`.
pub fn machine_colors(doc: &Document, engine: &mut Engine, format: &str, opts: &ExportOptions) -> Result<Vec<MachineColorInfo>, String> {
    let f = format.trim_start_matches('.').to_ascii_lowercase();
    let Some(fmt) = fmts::format_from_extension(&f) else { return Ok(vec![]) };
    let plan = engine.plan(doc);
    if plan.stitches.is_empty() {
        return Ok(vec![]);
    }
    let lab = |c: [u8; 3]| crate::threads::rgb_to_lab(c);
    Ok(fmts::machine_colors(&plan_to_pattern_at(&plan, &doc.name, doc.options.origin), fmt, &opts.write_options())
        .into_iter()
        .enumerate()
        .map(|(i, m)| MachineColorInfo {
            block: i,
            color: crate::model::hex_color(m.thread.rgb),
            name: m.thread.name.clone(),
            code: m.thread.code.clone(),
            brand: m.thread.brand.clone(),
            delta_e: m.shown.as_ref().map(|s| crate::vision::delta_e(lab(m.thread.rgb), lab(s.rgb))),
            shown: m.shown.map(|s| ShownColor { color: crate::model::hex_color(s.rgb), name: s.name, code: s.code, brand: s.brand, slot: m.slot }),
            exact: m.exact,
        })
        .collect())
}

pub fn export(doc: &Document, engine: &mut Engine, format: &str) -> Result<Vec<u8>, String> {
    export_with(doc, engine, format, &ExportOptions::default())
}

pub fn export_with(doc: &Document, engine: &mut Engine, format: &str, opts: &ExportOptions) -> Result<Vec<u8>, String> {
    let f = format.trim_start_matches('.').to_ascii_lowercase();
    match f.as_str() {
        "svg" => return Ok(svg::export_svg(doc).into_bytes()),
        "json" | "filum" => return serde_json::to_vec_pretty(doc).map_err(|e| e.to_string()),
        _ => {}
    }
    let fmt = if f == "threadlist" { None } else { Some(fmts::format_from_extension(&f).ok_or_else(|| format!("unknown format .{f}"))?) };
    let plan = export_plan(doc, engine, opts);
    if plan.stitches.is_empty() {
        return Err("nothing to export — the design has no stitches".into());
    }
    // Ink/Stitch's thread list (TXT)
    let Some(fmt) = fmt else { return Ok(crate::threadlist::thread_list_text(&plan, &doc.name).into_bytes()) };
    fmts::write_with_options(&plan_to_pattern_at(&plan, &doc.name, doc.options.origin), fmt, &opts.write_options()).map_err(|e| e.to_string())
}

pub fn import(bytes: &[u8], filename: Option<&str>) -> Result<Document, String> {
    let lower = filename.unwrap_or("").to_ascii_lowercase();
    let stem = filename
        .map(|n| n.rsplit(['/', '\\']).next().unwrap_or(n))
        .map(|n| n.rsplit_once('.').map(|x| x.0).unwrap_or(n))
        .unwrap_or("Imported")
        .to_string();
    let head = String::from_utf8_lossy(&bytes[..bytes.len().min(512)]).to_string();
    if lower.ends_with(".svg") || head.contains("<svg") {
        let text = std::str::from_utf8(bytes).map_err(|e| e.to_string())?;
        let mut d = svg::import_svg(text)?.document;
        d.name = stem;
        return Ok(d);
    }
    if lower.ends_with(".filum") || lower.ends_with(".json") || head.trim_start().starts_with('{') {
        return serde_json::from_slice(bytes).map_err(|e| e.to_string());
    }
    let fmt = fmts::detect(bytes, filename).ok_or("unrecognised file format")?;
    let pattern = fmts::read(bytes, fmt).map_err(|e| e.to_string())?;
    Ok(plan_to_document(&pattern_to_plan(&pattern), &stem))
}

#[cfg(test)]
mod origin_tests {
    use super::*;
    use crate::plan::{Stitch, StitchPlan};

    #[test]
    fn the_origin_becomes_zero() {
        let plan = StitchPlan { stitches: vec![Stitch { x: 10.0, y: 20.0, flags: 0, object: 0 }, Stitch { x: 30.0, y: 40.0, flags: 0, object: 0 }], threads: vec![], ..Default::default() };
        let at = plan_to_pattern_at(&plan, "t", Some([10.0, 20.0]));
        assert_eq!((at.stitches[0].x, at.stitches[0].y), (0.0, 0.0));
        let centred = plan_to_pattern_at(&plan, "t", None);
        assert_eq!((centred.stitches[0].x, centred.stitches[0].y), (-10.0, -10.0));
    }

    #[test]
    fn global_commands_round_trip_through_svg() {
        let mut doc = Document::default();
        doc.options.origin = Some([12.5, 7.0]);
        doc.options.stop_position = Some([50.0, -3.0]);
        let svg = svg::export_svg(&doc);
        assert!(svg.contains("xlink:href=\"#inkstitch_stop_position\"") && svg.contains("id=\"inkstitch_stop_position\""));
        let back = svg::import_svg(&svg).unwrap();
        assert_eq!(back.document.options.origin, Some([12.5, 7.0]));
        assert_eq!(back.document.options.stop_position, Some([50.0, -3.0]));
        assert!(back.warnings.iter().all(|w| !w.contains("stop position")));
    }

    #[test]
    fn exports_repeats_and_thread_lists() {
        use crate::model::{Object, StitchParams, SubPath};
        let mut doc = Document::default();
        doc.threads = vec![Thread { id: "a".into(), name: "Red".into(), color: "#ff0000".into(), brand: "Madeira".into(), code: "1147".into(), weight: None }];
        doc.objects = vec![Object {
            id: "o".into(),
            name: "o".into(),
            thread: "a".into(),
            visible: true,
            locked: false,
            paths: vec![SubPath::polyline(&[crate::geom::pt(0.0, 0.0), crate::geom::pt(3.0, 0.0), crate::geom::pt(6.0, 0.0)], false)],
            stitch: StitchParams::Manual(Default::default()),
            trim_after: false,
            stop_after: true,
            ties: Default::default(),
            force_lock: false,
            min_stitch: None,
            min_jump: None,
            patterns: vec![],
            clone: None,
            hidden: None,
            start: None,
            end: None,
        }];
        let mut e = Engine::new();
        let one = export_plan(&doc, &mut e, &ExportOptions::default());
        let four = export_plan(&doc, &mut e, &ExportOptions { x_repeats: 2, y_repeats: 2, x_spacing: 20.0, y_spacing: 10.0, ..Default::default() });
        let n = |p: &StitchPlan| p.stitches.iter().filter(|s| s.is_stitch()).count();
        assert_eq!(n(&four), 4 * n(&one));
        let b = four.bounds();
        assert!((b.width() - 26.0).abs() < 1e-9 && (b.height() - 10.0).abs() < 1e-9);
        let txt = String::from_utf8(export_with(&doc, &mut e, "threadlist", &ExportOptions::default()).unwrap()).unwrap();
        assert!(txt.contains("1 Red #1147 - Madeira (#ff0000)"));
        // the frame moves out before the stop
        doc.options.stop_position = Some([3.0, -40.0]);
        let p = export_plan(&doc, &mut e, &ExportOptions::default());
        let k = p.stitches.iter().position(|s| s.is(flags::STOP));
        if let Some(k) = k {
            assert!(p.stitches[k - 1].is(flags::JUMP) && p.stitches[k - 1].y == -40.0);
        }
    }
}
