//! Visual test suite for the auto-digitizer.
//!
//! ```text
//! cargo run --release -p filum-core --example digitize_suite -- \
//!     crates/core/tests/suite target/digitize-suite [--only NAME]
//! ```
//!
//! Every image in the input directory (png, jpg, webp, gif, bmp) is digitized
//! with the default options, merged with an optional sidecar `NAME.json`
//! (a partial `DigitizeOptions`), planned and rendered. The output directory
//! gets per image a thread render, a plan view (travel and jumps in red, trims
//! as crosses), a colour-difference map against the source, a JSON with the
//! numbers, and `index.html` with everything side by side.
//!
//! The numbers are the ones digitizers judge a design by: stitch count and
//! stitches per cm², trims, jumps and colour changes, short (< 0.5 mm) and long
//! (> 7 mm satin, > 12 mm anything) stitches, density hotspots (layers), and
//! how close the stitched colours come to the picture (mean ΔE, gaps where
//! the picture has colour but no thread lies, spill where thread lies on
//! background).
//!
//! A stitch file next to an image named `NAME.ref-WHO.pes` (or `.dst`, `.exp`, …)
//! is a reference digitized by hand: the image is digitized at its size, and its
//! numbers and render are shown in the same row. `SUITE_DUMP=1` lists the colours
//! and objects of every result.

use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::path::{Path, PathBuf};
use std::time::Instant;

use image::{Rgb, RgbImage};
use serde::Serialize;
use filum_core::density::{density_field, DensityOptions};
use filum_core::digitize::{decode_image, digitize_rgba, DigitizeOptions};
use filum_core::plan::{flags, StitchPlan};
use filum_core::threads::{delta_e, rgb_to_lab};
use filum_core::{io, Document, Engine, StitchParams};

const PX_MM: f64 = 8.0;
const FABRIC: [u8; 3] = [236, 233, 226];

#[derive(Serialize, Default)]
struct Metrics {
    name: String,
    seconds: f64,
    objects: usize,
    fills: usize,
    satins: usize,
    runs: usize,
    width_mm: f64,
    height_mm: f64,
    stitches: usize,
    per_cm2: f64,
    colors: usize,
    color_changes: usize,
    trims: usize,
    jumps: usize,
    travel_mm: f64,
    short_stitches: usize,
    long_satin: usize,
    long_stitches: usize,
    mean_len: f64,
    stitched_area_mm2: f64,
    max_layers: f64,
    risk_share: f64,
    hotspots: usize,
    mean_de: f64,
    wrong_px: f64,
    gap_px: f64,
    spill_px: f64,
    tiny_objects: usize,
}

fn main() -> Result<(), String> {
    let args: Vec<String> = std::env::args().collect();
    let dir = PathBuf::from(args.get(1).map(String::as_str).unwrap_or("crates/core/tests/suite"));
    let out = PathBuf::from(args.get(2).map(String::as_str).unwrap_or("target/digitize-suite"));
    let only = args.iter().position(|a| a == "--only").and_then(|i| args.get(i + 1)).cloned();
    std::fs::create_dir_all(&out).map_err(|e| e.to_string())?;

    let mut images: Vec<PathBuf> = std::fs::read_dir(&dir)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| matches!(ext(p).as_str(), "png" | "jpg" | "jpeg" | "webp" | "gif" | "bmp"))
        .filter(|p| only.as_deref().is_none_or(|o| stem(p).contains(o)))
        .collect();
    images.sort();

    let mut rows = Vec::new();
    for path in &images {
        let name = stem(path);
        let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
        let mut opts = DigitizeOptions::default();
        let side = path.with_extension("json");
        let mut note = String::new();
        if side.exists() {
            let text = std::fs::read_to_string(&side).map_err(|e| e.to_string())?;
            let v: serde_json::Value = serde_json::from_str(&text).map_err(|e| format!("{}: {e}", side.display()))?;
            note = v.get("_note").and_then(|n| n.as_str()).unwrap_or("").to_string();
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
        if !side.exists() {
            // as wide as the first reference, so the numbers compare
            if let Some((_, p)) = reference_files(path).first() {
                let rb = std::fs::read(p).map_err(|er| er.to_string())?;
                let rdoc = io::import(&rb, p.file_name().and_then(|f| f.to_str()))?;
                let b = Engine::new().plan(&rdoc).bounds();
                opts.width_mm = (b.max_x - b.min_x).max(b.max_y - b.min_y) * w as f64 / w.max(h) as f64;
            }
        }
        let t0 = Instant::now();
        let r = digitize_rgba(&rgba, w, h, &opts);
        let seconds = t0.elapsed().as_secs_f64();
        let doc = Document { name: name.clone(), threads: r.threads.clone(), objects: r.objects.clone(), ..Document::default() };
        if std::env::var("SUITE_DUMP").is_ok() {
            for c in &r.colors {
                println!("  colour {} {:<14} cover {:>5.1}% bg {} removed {:>5.1}% lines {:>5.1}%", c.hex, c.name, c.coverage * 100.0, c.background, c.removed * 100.0, c.lines * 100.0);
            }
            for (i, o) in doc.objects.iter().enumerate() {
                let a: f64 = o.paths.iter().map(|p| filum_core::geom::signed_area(&p.flatten(0.05))).sum();
                let kind = match &o.stitch { StitchParams::Fill(_) => "fill", StitchParams::Satin(_) => "satin", StitchParams::Running(_) => "run", _ => "other" };
                let b = o.bounds();
                println!("  #{i:<3} {kind:<6} {:<22} {:<10} paths {:<3} area {a:>8.1} box {:.1},{:.1}–{:.1},{:.1}", o.name, o.thread, o.paths.len(), b.min_x, b.min_y, b.max_x, b.max_y);
            }
        }
        let mut engine = Engine::new();
        let plan = engine.plan(&doc);

        let mut m = measure(&doc, &plan);
        m.name = name.clone();
        m.seconds = seconds;
        m.width_mm = r.width_mm;
        m.height_mm = r.height_mm;

        // renders on the picture's own frame (0..width_mm × 0..height_mm)
        let (cw, ch) = ((r.width_mm * PX_MM).ceil() as u32, (r.height_mm * PX_MM).ceil() as u32);
        let render = render_threads(&plan, cw, ch, 0.0, 0.0);
        let planview = render_plan(&plan, cw, ch);
        let src = source_at(&rgba, w, h, cw, ch);
        let (diff, de, wrong, gap, spill) = compare(&src, &plan, cw, ch);
        m.mean_de = de;
        m.wrong_px = wrong;
        m.gap_px = gap;
        m.spill_px = spill;
        save(&render, &out.join(format!("{name}.render.png")))?;
        save(&planview, &out.join(format!("{name}.plan.png")))?;
        save(&diff, &out.join(format!("{name}.diff.png")))?;
        save(&src.0, &out.join(format!("{name}.src.png")))?;

        // references digitized by hand: "<stem>.ref-<who>.<pes|dst|…>"
        let mut references = Vec::new();
        for (who, p) in reference_files(path) {
            let rb = std::fs::read(&p).map_err(|er| er.to_string())?;
            let rdoc = io::import(&rb, p.file_name().and_then(|f| f.to_str())).map_err(|er| format!("{}: {er}", p.display()))?;
            let rplan = Engine::new().plan(&rdoc);
            let mut rm = measure(&rdoc, &rplan);
            rm.name = who.clone();
            let b = rplan.bounds();
            rm.width_mm = b.max_x - b.min_x;
            rm.height_mm = b.max_y - b.min_y;
            let (rw, rh) = ((rm.width_mm * PX_MM).ceil() as u32 + 8, (rm.height_mm * PX_MM).ceil() as u32 + 8);
            let rr = render_threads(&rplan, rw, rh, b.min_x - 0.5, b.min_y - 0.5);
            save(&rr, &out.join(format!("{name}.ref-{who}.png")))?;
            println!("  reference {who:<14} {:>6} st {:>5.0}/cm² {:>2} col {:>3} trims {:>3} jumps short {:>4} long {:>3}/{:<3} layers {:>4.1}  {:.0}×{:.0} mm", rm.stitches, rm.per_cm2, rm.colors, rm.trims, rm.jumps, rm.short_stitches, rm.long_satin, rm.long_stitches, rm.max_layers, rm.width_mm, rm.height_mm);
            references.push(rm);
        }
        std::fs::write(out.join(format!("{name}.json")), serde_json::to_string_pretty(&m).unwrap()).map_err(|e| e.to_string())?;
        println!(
            "{:<24} {:>6} st {:>5.0}/cm² {:>2} col {:>3} trims {:>3} jumps short {:>4} long {:>3}/{:<3} layers {:>4.1} ΔE {:>5.1} gap {:>5.1}% spill {:>5.1}% {:>5.2}s",
            name, m.stitches, m.per_cm2, m.colors, m.trims, m.jumps, m.short_stitches, m.long_satin, m.long_stitches, m.max_layers, m.mean_de, m.gap_px, m.spill_px, m.seconds
        );
        rows.push((m, references, note));
    }
    std::fs::write(out.join("index.html"), html(&rows)).map_err(|e| e.to_string())?;
    println!("→ {}", out.join("index.html").display());
    Ok(())
}

fn reference_files(image: &Path) -> Vec<(String, PathBuf)> {
    let (dir, st) = (image.parent().unwrap_or(Path::new(".")), stem(image));
    let mut v: Vec<(String, PathBuf)> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| matches!(ext(p).as_str(), "pes" | "dst" | "exp" | "jef" | "vp3" | "xxx" | "pec"))
        .filter_map(|p| {
            let s = stem(&p);
            let who = s.strip_prefix(&format!("{st}.ref"))?.trim_start_matches('-').to_string();
            Some((if who.is_empty() { "reference".into() } else { who }, p))
        })
        .collect();
    v.sort();
    v
}

fn ext(p: &Path) -> String {
    p.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase()
}
fn stem(p: &Path) -> String {
    p.file_stem().and_then(|e| e.to_str()).unwrap_or("").to_string()
}
fn save(img: &RgbImage, p: &Path) -> Result<(), String> {
    img.save(p).map_err(|e| format!("{}: {e}", p.display()))
}

/// Needle segments: consecutive penetrations not separated by a jump, trim or colour change.
fn segments(plan: &StitchPlan) -> Vec<(usize, [f64; 4], u8, u32)> {
    let mut out = Vec::new();
    let mut block = 0usize;
    let mut prev: Option<(f64, f64)> = None;
    for s in &plan.stitches {
        if s.is(flags::COLOR_CHANGE) {
            block += 1;
            prev = None;
            continue;
        }
        if s.is(flags::JUMP) || s.is(flags::TRIM) {
            prev = if s.is(flags::JUMP) { Some((s.x, s.y)) } else { prev };
            if s.is(flags::TRIM) {
                prev = None;
            }
            continue;
        }
        if !s.is_stitch() {
            continue;
        }
        if let Some(p) = prev {
            out.push((block, [p.0, p.1, s.x, s.y], s.flags, s.object));
        }
        prev = Some((s.x, s.y));
    }
    out
}

fn measure(doc: &Document, plan: &StitchPlan) -> Metrics {
    let mut m = Metrics { objects: doc.objects.len(), ..Metrics::default() };
    for o in &doc.objects {
        match &o.stitch {
            StitchParams::Fill(_) => m.fills += 1,
            StitchParams::Satin(_) => m.satins += 1,
            _ => m.runs += 1,
        }
        let a: f64 = o.paths.iter().map(|p| filum_core::geom::signed_area(&p.flatten(0.05)).abs()).sum();
        if matches!(o.stitch, StitchParams::Fill(_)) && a < 4.0 {
            m.tiny_objects += 1;
        }
    }
    let st = plan.stats(800.0, 6.0, 20.0);
    m.stitches = st.stitches;
    m.trims = st.trims;
    m.jumps = st.jumps;
    m.color_changes = st.color_changes;
    m.colors = plan.threads.len();
    let mut total = 0.0;
    let mut n = 0usize;
    for (_, [x0, y0, x1, y1], fl, obj) in segments(plan) {
        let l = ((x1 - x0).powi(2) + (y1 - y0).powi(2)).sqrt();
        if fl & flags::TRAVEL != 0 {
            m.travel_mm += l;
        }
        if fl & flags::TIE != 0 {
            continue;
        }
        total += l;
        n += 1;
        if l < 0.5 && l > 0.0 {
            m.short_stitches += 1;
        }
        let satin = doc.objects.get(obj as usize).is_some_and(|o| matches!(o.stitch, StitchParams::Satin(_)));
        if satin && l > 7.0 {
            m.long_satin += 1;
        }
        if l > 12.0 {
            m.long_stitches += 1;
        }
    }
    m.mean_len = if n > 0 { total / n as f64 } else { 0.0 };
    let d = density_field(doc, plan, &DensityOptions::default());
    m.stitched_area_mm2 = d.stats.area;
    m.per_cm2 = if d.stats.area > 0.0 { m.stitches as f64 / d.stats.area * 100.0 } else { 0.0 };
    m.max_layers = d.stats.max_layers;
    m.risk_share = d.stats.risk;
    m.hotspots = d.hotspots.len();
    m
}

fn thread_rgb(plan: &StitchPlan, block: usize) -> [u8; 3] {
    plan.threads.get(block).map(|t| t.rgb()).unwrap_or([0, 0, 0])
}

/// Anti-aliased capsule from a to b, `w` px wide; `shade` gives the thread a round look.
fn capsule(img: &mut RgbImage, a: (f64, f64), b: (f64, f64), w: f64, c: [u8; 3], shade: bool) {
    let r = w / 2.0;
    let (x0, x1) = ((a.0.min(b.0) - r - 1.0).floor().max(0.0) as i64, (a.0.max(b.0) + r + 1.0).ceil() as i64);
    let (y0, y1) = ((a.1.min(b.1) - r - 1.0).floor().max(0.0) as i64, (a.1.max(b.1) + r + 1.0).ceil() as i64);
    let (dx, dy) = (b.0 - a.0, b.1 - a.1);
    let ll = dx * dx + dy * dy;
    for y in y0..y1.min(img.height() as i64) {
        for x in x0..x1.min(img.width() as i64) {
            let (px, py) = (x as f64 + 0.5, y as f64 + 0.5);
            let t = if ll > 0.0 { (((px - a.0) * dx + (py - a.1) * dy) / ll).clamp(0.0, 1.0) } else { 0.0 };
            let d = ((px - a.0 - t * dx).powi(2) + (py - a.1 - t * dy).powi(2)).sqrt();
            let cov = (r - d + 0.5).clamp(0.0, 1.0);
            if cov <= 0.0 {
                continue;
            }
            let k = if shade { 0.72 + 0.4 * (1.0 - (d / r).min(1.0).powi(2)) } else { 1.0 };
            let p = img.get_pixel_mut(x as u32, y as u32);
            for i in 0..3 {
                let v = (c[i] as f64 * k).min(255.0);
                p.0[i] = (p.0[i] as f64 * (1.0 - cov) + v * cov).round() as u8;
            }
        }
    }
}

fn render_threads(plan: &StitchPlan, w: u32, h: u32, ox: f64, oy: f64) -> RgbImage {
    let mut img = RgbImage::from_pixel(w, h, Rgb(FABRIC));
    for (block, [x0, y0, x1, y1], _, _) in segments(plan) {
        let a = ((x0 - ox) * PX_MM, (y0 - oy) * PX_MM);
        let b = ((x1 - ox) * PX_MM, (y1 - oy) * PX_MM);
        capsule(&mut img, a, b, 0.4 * PX_MM, thread_rgb(plan, block), true);
    }
    img
}

/// Thin coloured stitches, travel in red, jumps as red lines, trims as black crosses.
fn render_plan(plan: &StitchPlan, w: u32, h: u32) -> RgbImage {
    let mut img = RgbImage::from_pixel(w, h, Rgb([255, 255, 255]));
    for (block, [x0, y0, x1, y1], fl, _) in segments(plan) {
        let c = thread_rgb(plan, block);
        let lite = [(c[0] as u16 * 2 / 3 + 85) as u8, (c[1] as u16 * 2 / 3 + 85) as u8, (c[2] as u16 * 2 / 3 + 85) as u8];
        let (col, wd) = if fl & flags::TRAVEL != 0 { ([230, 30, 30], 1.6) } else { (lite, 1.0) };
        capsule(&mut img, (x0 * PX_MM, y0 * PX_MM), (x1 * PX_MM, y1 * PX_MM), wd, col, false);
    }
    let mut prev: Option<(f64, f64)> = None;
    for s in &plan.stitches {
        let p = (s.x * PX_MM, s.y * PX_MM);
        if s.is(flags::JUMP) {
            if let Some(q) = prev {
                capsule(&mut img, q, p, 1.2, [255, 0, 0], false);
            }
        }
        if s.is(flags::TRIM) {
            capsule(&mut img, (p.0 - 5.0, p.1 - 5.0), (p.0 + 5.0, p.1 + 5.0), 2.0, [0, 0, 0], false);
            capsule(&mut img, (p.0 - 5.0, p.1 + 5.0), (p.0 + 5.0, p.1 - 5.0), 2.0, [0, 0, 0], false);
        }
        prev = Some(p);
    }
    img
}

/// The picture resampled onto the render (box filter); transparent pixels become `None`.
fn source_at(rgba: &[u8], w: u32, h: u32, cw: u32, ch: u32) -> (RgbImage, Vec<Option<[u8; 3]>>) {
    let mut img = RgbImage::new(cw, ch);
    let mut px = vec![None; (cw * ch) as usize];
    for y in 0..ch {
        for x in 0..cw {
            let sx = ((x as f64 + 0.5) / cw as f64 * w as f64) as u32;
            let sy = ((y as f64 + 0.5) / ch as f64 * h as f64) as u32;
            let i = ((sy.min(h - 1) * w + sx.min(w - 1)) * 4) as usize;
            let c = [rgba[i], rgba[i + 1], rgba[i + 2]];
            if rgba[i + 3] >= 128 {
                img.put_pixel(x, y, Rgb(c));
                px[(y * cw + x) as usize] = Some(c);
            } else {
                img.put_pixel(x, y, Rgb([255, 255, 255]));
            }
        }
    }
    (img, px)
}

/// Background of the picture: transparent, or the most common border colour.
fn background(src: &[Option<[u8; 3]>], w: u32, h: u32) -> Option<[u8; 3]> {
    let mut count: BTreeMap<[u8; 3], usize> = BTreeMap::new();
    let mut transparent = 0;
    for y in 0..h {
        for x in 0..w {
            if x == 0 || y == 0 || x == w - 1 || y == h - 1 {
                match src[(y * w + x) as usize] {
                    Some(c) => *count.entry([c[0] & 0xf0, c[1] & 0xf0, c[2] & 0xf0]).or_default() += 1,
                    None => transparent += 1,
                }
            }
        }
    }
    let best = count.iter().max_by_key(|(_, n)| **n)?;
    if transparent > *best.1 {
        return None;
    }
    // the average of the pixels in that bucket
    let key = *best.0;
    let (mut s, mut n) = ([0u64; 3], 0u64);
    for c in src.iter().flatten() {
        if [c[0] & 0xf0, c[1] & 0xf0, c[2] & 0xf0] == key {
            for i in 0..3 {
                s[i] += c[i] as u64;
            }
            n += 1;
        }
    }
    Some([(s[0] / n) as u8, (s[1] / n) as u8, (s[2] / n) as u8])
}

/// Top thread per pixel (coverage drawn wide enough to close the gaps between rows)
/// against the picture: mean ΔE over the design, wrong-colour, gap and spill shares.
fn compare(src: &(RgbImage, Vec<Option<[u8; 3]>>), plan: &StitchPlan, w: u32, h: u32) -> (RgbImage, f64, f64, f64, f64) {
    let mut top = RgbImage::from_pixel(w, h, Rgb([1, 2, 3]));
    for (block, [x0, y0, x1, y1], fl, _) in segments(plan) {
        if fl & flags::TRAVEL != 0 {
            continue;
        }
        capsule(&mut top, (x0 * PX_MM, y0 * PX_MM), (x1 * PX_MM, y1 * PX_MM), 0.7 * PX_MM, thread_rgb(plan, block), false);
    }
    let bg = background(&src.1, w, h);
    let like_bg = |c: Option<[u8; 3]>| match (c, bg) {
        (None, _) => true,
        (Some(c), Some(b)) => delta_e(c, b) < 6.0,
        _ => false,
    };
    // background = background-coloured pixels connected to the border; enclosed ones
    // (counters, highlights, a cream badge face) may or may not be stitched: neutral
    let mut outside = vec![false; (w * h) as usize];
    let mut stack: Vec<(u32, u32)> = Vec::new();
    for x in 0..w {
        stack.push((x, 0));
        stack.push((x, h - 1));
    }
    for y in 0..h {
        stack.push((0, y));
        stack.push((w - 1, y));
    }
    while let Some((x, y)) = stack.pop() {
        let i = (y * w + x) as usize;
        if outside[i] || !like_bg(src.1[i]) {
            continue;
        }
        outside[i] = true;
        if x > 0 { stack.push((x - 1, y)); }
        if y > 0 { stack.push((x, y - 1)); }
        if x + 1 < w { stack.push((x + 1, y)); }
        if y + 1 < h { stack.push((x, y + 1)); }
    }
    let mut diff = RgbImage::from_pixel(w, h, Rgb([255, 255, 255]));
    let (mut de_sum, mut de_n, mut wrong, mut gap, mut spill, mut fg) = (0.0, 0usize, 0usize, 0usize, 0usize, 0usize);
    for y in 0..h {
        for x in 0..w {
            let s = src.1[(y * w + x) as usize];
            let t = top.get_pixel(x, y).0;
            let covered = t != [1, 2, 3];
            let i = (y * w + x) as usize;
            let sb = outside[i];
            if !sb && like_bg(s) {
                // enclosed background colour: fine either way, judged only for colour if stitched
                let px = if covered {
                    let d = delta_e(s.unwrap_or([255, 255, 255]), t);
                    if d > 25.0 { [255, 120, 120] } else { [215, 225, 240] }
                } else {
                    [235, 240, 250]
                };
                diff.put_pixel(x, y, Rgb(px));
                continue;
            }
            if !sb {
                fg += 1;
            }
            let px = match (sb, covered) {
                (true, false) => {
                    let g = s.map(|c| rgb_to_lab(c)[0]).unwrap_or(100.0);
                    let v = (200.0 + g * 0.5).min(255.0) as u8;
                    [v, v, v]
                }
                (false, false) => {
                    gap += 1;
                    [0, 160, 255]
                }
                (true, true) => {
                    spill += 1;
                    [255, 150, 0]
                }
                (false, true) => {
                    let d = delta_e(s.unwrap(), t);
                    de_sum += d;
                    de_n += 1;
                    if d > 25.0 {
                        wrong += 1;
                    }
                    let k = (d / 50.0).min(1.0);
                    [(255.0) as u8, (255.0 * (1.0 - k)) as u8, (255.0 * (1.0 - k)) as u8]
                }
            };
            diff.put_pixel(x, y, Rgb(px));
        }
    }
    let fg = fg.max(1) as f64;
    (diff, if de_n > 0 { de_sum / de_n as f64 } else { 0.0 }, wrong as f64 / fg * 100.0, gap as f64 / fg * 100.0, spill as f64 / fg * 100.0)
}

fn html(rows: &[(Metrics, Vec<Metrics>, String)]) -> String {
    let mut s = String::from(
        r#"<!doctype html><meta charset=utf-8><title>Digitizer suite</title><style>
body{font:13px system-ui;margin:16px;background:#f6f5f2;color:#222}
.row{display:grid;grid-template-columns:repeat(4,1fr) minmax(260px,auto);gap:8px;margin-bottom:20px;background:#fff;padding:10px;border-radius:8px}
.row img{width:100%;image-rendering:auto;border:1px solid #ddd;background:#fff}
h2{margin:0 0 4px;font-size:15px;grid-column:1/-1}.note{color:#666;grid-column:1/-1;margin:-4px 0 4px}
table{border-collapse:collapse;font-variant-numeric:tabular-nums}td{padding:1px 6px}td:first-child{color:#777}
.bad{color:#c8102e;font-weight:600}.cap{font-size:11px;color:#888;text-align:center}
</style><h1>Digitizer suite</h1><p>source · stitches · plan (red = travel/jumps, × = trims) · colour difference (blue = gap, orange = spill, red = wrong colour)</p>"#,
    );
    for (m, r, note) in rows {
        let n = &m.name;
        let _ = write!(s, "<div class=row><h2>{n}</h2>");
        if !note.is_empty() {
            let _ = write!(s, "<div class=note>{note}</div>");
        }
        let _ = write!(
            s,
            "<a href='{n}.src.png'><img src='{n}.src.png'></a><a href='{n}.render.png'><img src='{n}.render.png'></a><a href='{n}.plan.png'><img src='{n}.plan.png'></a><a href='{n}.diff.png'><img src='{n}.diff.png'></a>"
        );
        s += &table(m, r);
        for rm in r {
            let who = &rm.name;
            let _ = write!(s, "<div><div class=cap>by hand: {who}</div><a href='{n}.ref-{who}.png'><img src='{n}.ref-{who}.png'></a></div>");
        }
        s += "</div>";
    }
    s
}

type Cell = fn(&Metrics) -> String;

fn table(m: &Metrics, refs: &[Metrics]) -> String {
    // (label, value, auto value is a problem, shown for references)
    let rows: Vec<(&str, Cell, bool, bool)> = vec![
        ("size", |m| format!("{:.0}×{:.0} mm", m.width_mm, m.height_mm), false, true),
        ("objects", |m| format!("{} ({}F {}S {}R)", m.objects, m.fills, m.satins, m.runs), false, false),
        ("stitches", |m| m.stitches.to_string(), false, true),
        ("per cm²", |m| format!("{:.0}", m.per_cm2), m.per_cm2 > 400.0, true),
        ("colours", |m| m.colors.to_string(), false, true),
        ("trims", |m| m.trims.to_string(), m.trims > 3 * m.colors.max(1) + 6, true),
        ("jumps", |m| m.jumps.to_string(), false, true),
        ("travel", |m| format!("{:.0} mm", m.travel_mm), false, true),
        ("short < 0.5", |m| format!("{} ({:.1} %)", m.short_stitches, m.short_stitches as f64 / m.stitches.max(1) as f64 * 100.0), m.short_stitches as f64 > 0.03 * m.stitches as f64, true),
        ("long satin > 7", |m| m.long_satin.to_string(), m.long_satin > 0, true),
        ("long > 12", |m| m.long_stitches.to_string(), m.long_stitches > 0, true),
        ("mean length", |m| format!("{:.2} mm", m.mean_len), false, true),
        ("max layers", |m| format!("{:.1}", m.max_layers), m.max_layers > 4.0, true),
        ("hotspots", |m| m.hotspots.to_string(), m.hotspots > 0, true),
        ("tiny fills < 4 mm²", |m| m.tiny_objects.to_string(), m.tiny_objects > 0, false),
        ("mean ΔE", |m| format!("{:.1}", m.mean_de), m.mean_de > 12.0, false),
        ("wrong colour", |m| format!("{:.1} %", m.wrong_px), m.wrong_px > 5.0, false),
        ("gaps", |m| format!("{:.1} %", m.gap_px), m.gap_px > 3.0, false),
        ("spill", |m| format!("{:.1} %", m.spill_px), m.spill_px > 6.0, false),
        ("time", |m| format!("{:.2} s", m.seconds), m.seconds > 5.0, false),
    ];
    let mut s = String::from("<table>");
    if !refs.is_empty() {
        s += "<tr><td></td><td>auto</td>";
        for r in refs {
            let _ = write!(s, "<td>{}</td>", r.name);
        }
        s += "</tr>";
    }
    for (k, f, bad, for_refs) in rows {
        let _ = write!(s, "<tr><td>{k}</td><td{}>{}</td>", if bad { " class=bad" } else { "" }, f(m));
        for r in refs {
            let _ = write!(s, "<td>{}</td>", if for_refs { f(r) } else { String::new() });
        }
        s += "</tr>";
    }
    s + "</table>"
}
