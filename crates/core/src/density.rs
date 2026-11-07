//! Density model: what the stitches lay on the fabric, cell by cell, judged
//! against what the fabric and the thread can take.
//!
//! Three physical fields are built from the stitch plan (all thread really
//! sewn: top stitches, underlay, travel and locks):
//!
//! * **Layers** — thread area per fabric area: every stitch lays its length ×
//!   the thread's width as it spreads on the fabric. One layer is the
//!   fabric just covered: Ink/Stitch's defaults lay a 40 wt thread line every
//!   0.25 mm in fills (row spacing) and every 0.2 mm in satins (zig-zag
//!   spacing 0.4 peak to peak, two passes) — a 40 wt thread (≈ 0.2 mm round,
//!   27 tex polyester) spread to ≈ 0.25 mm. A default fill is one layer, its
//!   underlay adds about a third, two layers is a fill over a fill.
//! * **Needle holes** per mm² — every penetration, the perforation that tears
//!   delicate fabric and deflects needles (the commonly used tiers:
//!   light ≤ 10, dense ≤ 17, very dense ≤ 25 points/mm²; Ink/Stitch's
//!   density map counts points within 0.5 mm).
//! * **Added weight** in g/m² — thread length × linear density (tex), top
//!   thread and the bobbin's share (Dutta & Chatterjee 2020, JTATM 11(4):
//!   the embroidered fabric's areal density from stitch geometry); relative
//!   to the fabric's own weight it shows where embroidery turns a light
//!   fabric stiff ("bulletproof").
//!
//! The fields are smoothed with a Gaussian of about a thread's width (the
//! scale at which stacked thread deflects the needle) and classified with
//! limits that come from the fabric. Where a covering fill or satin lies, too
//! few layers mean the fabric shows through.

use serde::{Deserialize, Serialize};

use crate::geom::{Point, Ring};
use crate::model::{Document, Fabric, FillMethod, StitchParams};
use crate::plan::{flags, StitchPlan};
use crate::region::{object_cover, Cover};

/// A thread's size for the model.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadSpec {
    /// Weight number (No. 40 …).
    pub weight: u32,
    /// Linear density (g per km). Weight numbers count km per kg of the
    /// finished thread only roughly: Madeira Polyneon's data sheets (75 / 60 /
    /// 40) and Schmetz's table (30 / 12), else 1080 / weight like No. 40.
    pub tex: f64,
    /// Width the thread covers on the fabric (mm): the spacing of thread
    /// lines that just covers it — 0.25 mm for No. 40 (Ink/Stitch's fill
    /// default), scaled like the engine's spacing (Madeira's density guide).
    pub width: f64,
}

/// The size of a thread of weight number `weight`.
pub fn thread_spec(weight: u32) -> ThreadSpec {
    let w = if weight == 0 { 40 } else { weight };
    let tex = match w {
        75 => 11.0,
        60 => 17.0,
        40 => 27.0,
        30 => 40.0,
        12 => 100.0,
        w => 1080.0 / w as f64,
    };
    ThreadSpec { weight: w, tex, width: 0.25 * crate::model::thread_density_scale(w) }
}

/// The bobbin thread: a fine 60 wt polyester, about a third of the top
/// thread's length (the 1/3 bobbin, 2/3 top balance of a satin).
pub const BOBBIN_TEX: f64 = 17.0;
pub const BOBBIN_SHARE: f64 = 0.33;

/// What a fabric takes.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FabricLimits {
    /// The fabric's own weight (g/m²), typical for the kind.
    pub gsm: f64,
    /// Needle holes per mm²: heavy above `holes_heavy`, a risk above `holes_max`.
    pub holes_heavy: f64,
    pub holes_max: f64,
    /// Thread layers: heavy above `layers_heavy`, a risk above `layers_max`.
    pub layers_heavy: f64,
    pub layers_max: f64,
    /// Covering fills and satins below this many layers let the fabric show.
    pub layers_min: f64,
    /// Added weight relative to the fabric's: stiff above this.
    pub stiff_ratio: f64,
}

impl Fabric {
    /// Density limits of the fabric. Needle holes follow the common tiers for
    /// ordinary wovens (10 / 17 points per mm²), tighter for fabrics a line of
    /// holes tears (sheer, silk, leather, knits) and looser for heavy ones;
    /// layers: a default fill with its underlay is about 1.3, two stacked 2.6,
    /// three about 4 — heavy
    /// from about two fills, a risk from three on ordinary wovens; pile
    /// (towel, fleece) needs more cover to keep the loops down. Stiffness:
    /// added weight against the fabric's (a default fill adds ≈ 170 g/m²).
    pub fn limits(self) -> FabricLimits {
        let l = |gsm, holes_heavy, holes_max, layers_heavy, layers_max, layers_min, stiff_ratio| FabricLimits { gsm, holes_heavy, holes_max, layers_heavy, layers_max, layers_min, stiff_ratio };
        match self {
            Fabric::Cotton => l(130.0, 10.0, 17.0, 2.4, 3.8, 0.6, 1.5),
            Fabric::Polyester => l(110.0, 10.0, 17.0, 2.4, 3.8, 0.6, 1.5),
            Fabric::Denim => l(400.0, 14.0, 25.0, 2.8, 4.4, 0.6, 0.8),
            Fabric::Knit => l(160.0, 8.0, 14.0, 2.1, 3.2, 0.6, 1.2),
            Fabric::Sheer => l(40.0, 5.0, 9.0, 1.6, 2.4, 0.5, 3.0),
            Fabric::Felt => l(300.0, 12.0, 22.0, 2.8, 4.4, 0.5, 1.0),
            Fabric::Towel => l(450.0, 12.0, 22.0, 2.8, 4.4, 0.8, 0.7),
            Fabric::Cap => l(300.0, 14.0, 25.0, 3.0, 4.8, 0.6, 1.0),
            Fabric::Fleece => l(250.0, 10.0, 18.0, 2.6, 4.0, 0.7, 1.0),
            Fabric::Pique => l(200.0, 9.0, 16.0, 2.4, 3.8, 0.65, 1.0),
            Fabric::Leather => l(600.0, 5.0, 9.0, 1.8, 2.8, 0.5, 0.5),
            Fabric::Canvas => l(350.0, 14.0, 25.0, 2.8, 4.4, 0.6, 0.8),
            Fabric::Silk => l(70.0, 6.0, 11.0, 1.7, 2.6, 0.6, 2.0),
        }
    }
}

/// How a cell is judged.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[repr(u8)]
pub enum DensityClass {
    Empty = 0,
    /// A covering fill or satin with too few layers: the fabric shows.
    Thin = 1,
    Ok = 2,
    /// Heavy: stiff, slower, more thread breaks.
    Heavy = 3,
    /// Beyond what the fabric takes: puckers, holes, needle breaks.
    Risk = 4,
}

/// A place beyond what the fabric takes.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Hotspot {
    /// Box (mm) and its centre.
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub area: f64,
    pub peak_layers: f64,
    pub peak_holes: f64,
    /// Objects stitching there, most stitches first (document indices).
    pub objects: Vec<u32>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DensityStats {
    /// Stitched area (mm²) and the share of it in each class.
    pub area: f64,
    pub thin: f64,
    pub ok: f64,
    pub heavy: f64,
    pub risk: f64,
    pub max_layers: f64,
    pub max_holes: f64,
    /// Added weight: the heaviest place and the average over the stitched area (g/m²).
    pub max_added: f64,
    pub mean_added: f64,
    /// Thread used (m): top and bobbin.
    pub top_m: f64,
    pub bobbin_m: f64,
}

/// The density of a design, cell by cell (row-major, `cols × rows` cells of
/// `cell` mm from `x0`, `y0`).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DensityField {
    pub x0: f64,
    pub y0: f64,
    pub cell: f64,
    pub cols: usize,
    pub rows: usize,
    pub layers: Vec<f32>,
    pub holes: Vec<f32>,
    /// Added weight (g/m²).
    pub added: Vec<f32>,
    pub class: Vec<u8>,
    pub limits: Option<FabricLimits>,
    pub stats: DensityStats,
    pub hotspots: Vec<Hotspot>,
}

/// Options of the density model.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DensityOptions {
    /// Smoothing (mm, Gaussian sigma): the scale density is judged at.
    pub sigma: f64,
    /// Upper bound on the number of cells (the cell grows for big designs).
    pub max_cells: usize,
}

impl Default for DensityOptions {
    fn default() -> Self {
        DensityOptions { sigma: 0.35, max_cells: 400_000 }
    }
}

/// Fill methods meant to cover the fabric (others are open on purpose).
fn covers_fabric(st: &StitchParams) -> bool {
    match st {
        StitchParams::Satin(_) => true,
        StitchParams::Fill(f) => {
            f.ramp.is_none()
                && matches!(f.method, FillMethod::Tatami | FillMethod::Contour | FillMethod::Spiral | FillMethod::Guided | FillMethod::Flow | FillMethod::Curved | FillMethod::Radial | FillMethod::Circular | FillMethod::Tartan)
        }
        _ => false,
    }
}

/// Separable Gaussian blur in place.
fn blur(v: &mut [f32], cols: usize, rows: usize, sigma_cells: f64) {
    if sigma_cells < 0.3 {
        return;
    }
    let r = (sigma_cells * 2.5).ceil() as isize;
    let k: Vec<f32> = (-r..=r).map(|i| (-(i * i) as f64 / (2.0 * sigma_cells * sigma_cells)).exp() as f32).collect();
    let sum: f32 = k.iter().sum();
    let k: Vec<f32> = k.iter().map(|x| x / sum).collect();
    let mut tmp = vec![0f32; v.len()];
    for y in 0..rows {
        for x in 0..cols {
            let mut acc = 0f32;
            for (j, w) in k.iter().enumerate() {
                let xx = x as isize + j as isize - r;
                if xx >= 0 && (xx as usize) < cols {
                    acc += v[y * cols + xx as usize] * w;
                }
            }
            tmp[y * cols + x] = acc;
        }
    }
    for y in 0..rows {
        for x in 0..cols {
            let mut acc = 0f32;
            for (j, w) in k.iter().enumerate() {
                let yy = y as isize + j as isize - r;
                if yy >= 0 && (yy as usize) < rows {
                    acc += tmp[yy as usize * cols + x] * w;
                }
            }
            v[y * cols + x] = acc;
        }
    }
}

/// Cells whose centre lies in the rings (even-odd), set to 1.
fn fill_rings(mask: &mut [u8], rings: &[Ring], f: &DensityField) {
    for gy in 0..f.rows {
        let y = f.y0 + (gy as f64 + 0.5) * f.cell;
        let mut xs: Vec<f64> = Vec::new();
        for r in rings {
            let n = r.len();
            for i in 0..n {
                let (a, b) = (r[i], r[(i + 1) % n]);
                if (a.y <= y && b.y > y) || (b.y <= y && a.y > y) {
                    xs.push(a.x + (y - a.y) / (b.y - a.y) * (b.x - a.x));
                }
            }
        }
        xs.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        for pair in xs.chunks(2) {
            if pair.len() < 2 {
                break;
            }
            let c0 = (((pair[0] - f.x0) / f.cell) - 0.5).ceil().max(0.0) as usize;
            let c1 = (((pair[1] - f.x0) / f.cell) - 0.5).floor();
            if c1 < 0.0 {
                continue;
            }
            for gx in c0..=(c1 as usize).min(f.cols.saturating_sub(1)) {
                mask[gy * f.cols + gx] = 1;
            }
        }
    }
}

/// The density field of a design's stitch plan on its fabric.
pub fn density_field(doc: &Document, plan: &StitchPlan, opts: &DensityOptions) -> DensityField {
    let limits = doc.fabric.limits();
    let pts: Vec<&crate::plan::Stitch> = plan.stitches.iter().filter(|s| s.flags & flags::COMMANDS == 0).collect();
    if pts.is_empty() {
        return DensityField { limits: Some(limits), ..Default::default() };
    }
    let (mut x0, mut y0, mut x1, mut y1) = (f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
    for s in &pts {
        x0 = x0.min(s.x);
        y0 = y0.min(s.y);
        x1 = x1.max(s.x);
        y1 = y1.max(s.y);
    }
    let margin = opts.sigma * 3.0 + 0.5;
    (x0, y0, x1, y1) = (x0 - margin, y0 - margin, x1 + margin, y1 + margin);
    let mut cell = 0.2f64;
    while ((x1 - x0) / cell).ceil() * ((y1 - y0) / cell).ceil() > opts.max_cells as f64 {
        cell *= 1.25;
    }
    let cols = ((x1 - x0) / cell).ceil() as usize + 1;
    let rows = ((y1 - y0) / cell).ceil() as usize + 1;
    let mut f = DensityField { x0, y0, cell, cols, rows, limits: Some(limits), ..Default::default() };
    let n = cols * rows;
    let (mut area, mut holes, mut mass) = (vec![0f32; n], vec![0f32; n], vec![0f32; n]);
    let idx = |p: Point| -> Option<usize> {
        let gx = ((p.x - x0) / cell).floor();
        let gy = ((p.y - y0) / cell).floor();
        (gx >= 0.0 && gy >= 0.0 && (gx as usize) < cols && (gy as usize) < rows).then(|| gy as usize * cols + gx as usize)
    };
    // every object's thread
    let spec_of = |o: u32| -> ThreadSpec {
        let w = doc.objects.get(o as usize).and_then(|obj| doc.thread(&obj.thread)).and_then(|t| t.weight).unwrap_or(doc.options.thread_weight);
        thread_spec(w)
    };
    let mut specs: std::collections::HashMap<u32, ThreadSpec> = std::collections::HashMap::new();
    let (mut top_mm, mut bobbin_mm) = (0.0, 0.0);
    let mut prev: Option<Point> = None;
    for s in &plan.stitches {
        if s.flags & (flags::COLOR_CHANGE | flags::TRIM | flags::STOP | flags::END) != 0 {
            prev = None;
            continue;
        }
        let p = s.pos();
        if s.flags & flags::JUMP != 0 {
            prev = None;
            continue;
        }
        let spec = *specs.entry(s.object).or_insert_with(|| spec_of(s.object));
        if let Some(i) = idx(p) {
            holes[i] += 1.0;
        }
        if let Some(a) = prev {
            let len = a.dist(p);
            top_mm += len;
            bobbin_mm += len * BOBBIN_SHARE;
            // the length laid along the segment, a sample every half cell
            let k = ((len / (cell * 0.5)).ceil() as usize).max(1);
            let share = len / k as f64;
            for j in 0..k {
                if let Some(i) = idx(a.lerp(p, (j as f64 + 0.5) / k as f64)) {
                    area[i] += (share * spec.width) as f32;
                    mass[i] += (share * (spec.tex + BOBBIN_SHARE * BOBBIN_TEX)) as f32;
                }
            }
        }
        prev = Some(p);
    }
    let sigma_cells = opts.sigma / cell;
    blur(&mut area, cols, rows, sigma_cells);
    blur(&mut holes, cols, rows, sigma_cells);
    blur(&mut mass, cols, rows, sigma_cells);
    let ca = (cell * cell) as f32;
    // per mm²: layers (area / area), holes / mm², and mm of thread × tex per mm² = g/m²
    f.layers = area.iter().map(|v| v / ca).collect();
    f.holes = holes.iter().map(|v| v / ca).collect();
    f.added = mass.iter().map(|v| v / ca).collect();

    // where covering fills and satins lie (eroded by the smoothing, whose
    // edge would read as thin)
    let mut intent = vec![0u8; n];
    for o in doc.objects.iter().filter(|o| o.visible && covers_fabric(&o.stitch)) {
        for c in object_cover(o) {
            match c {
                Cover::Area(r) => fill_rings(&mut intent, &r, &f),
                Cover::Polys(polys) => {
                    for p in polys {
                        fill_rings(&mut intent, std::slice::from_ref(&p), &f);
                    }
                }
                Cover::Band { .. } => {}
            }
        }
    }
    let erode = (opts.sigma * 2.0 / cell).ceil() as isize;
    let inside: Vec<bool> = (0..n)
        .map(|i| {
            if intent[i] == 0 {
                return false;
            }
            let (x, y) = ((i % cols) as isize, (i / cols) as isize);
            [(-erode, 0), (erode, 0), (0, -erode), (0, erode)].iter().all(|(dx, dy)| {
                let (xx, yy) = (x + dx, y + dy);
                xx >= 0 && yy >= 0 && (xx as usize) < cols && (yy as usize) < rows && intent[yy as usize * cols + xx as usize] == 1
            })
        })
        .collect();

    // classes and statistics
    f.class = vec![0u8; n];
    let mut st = DensityStats { top_m: top_mm / 1000.0, bobbin_m: bobbin_mm / 1000.0, ..Default::default() };
    let a1 = cell * cell;
    let mut added_sum = 0.0;
    for i in 0..n {
        let (l, h, m) = (f.layers[i] as f64, f.holes[i] as f64, f.added[i] as f64);
        let c = if l > limits.layers_max || h > limits.holes_max {
            DensityClass::Risk
        } else if l > limits.layers_heavy || h > limits.holes_heavy {
            DensityClass::Heavy
        } else if inside[i] && l < limits.layers_min {
            DensityClass::Thin
        } else if l > 0.05 {
            DensityClass::Ok
        } else {
            DensityClass::Empty
        };
        f.class[i] = c as u8;
        if c != DensityClass::Empty {
            st.area += a1;
            added_sum += m * a1;
            match c {
                DensityClass::Thin => st.thin += a1,
                DensityClass::Ok => st.ok += a1,
                DensityClass::Heavy => st.heavy += a1,
                DensityClass::Risk => st.risk += a1,
                DensityClass::Empty => {}
            }
        }
        st.max_layers = st.max_layers.max(l);
        st.max_holes = st.max_holes.max(h);
        st.max_added = st.max_added.max(m);
    }
    st.mean_added = if st.area > 0.0 { added_sum / st.area } else { 0.0 };
    f.stats = st;
    f.hotspots = hotspots(&f, plan);
    f
}

/// Connected places of risk, largest first, with the objects stitching there.
fn hotspots(f: &DensityField, plan: &StitchPlan) -> Vec<Hotspot> {
    let (cols, rows) = (f.cols, f.rows);
    let mut seen = vec![false; cols * rows];
    let mut out: Vec<Hotspot> = Vec::new();
    for start in 0..cols * rows {
        if seen[start] || f.class[start] != DensityClass::Risk as u8 {
            continue;
        }
        let mut stack = vec![start];
        seen[start] = true;
        let (mut gx0, mut gy0, mut gx1, mut gy1) = (usize::MAX, usize::MAX, 0, 0);
        let (mut cells, mut pl, mut ph) = (0usize, 0f64, 0f64);
        while let Some(i) = stack.pop() {
            let (x, y) = (i % cols, i / cols);
            (gx0, gy0, gx1, gy1) = (gx0.min(x), gy0.min(y), gx1.max(x), gy1.max(y));
            cells += 1;
            pl = pl.max(f.layers[i] as f64);
            ph = ph.max(f.holes[i] as f64);
            let mut push = |j: usize| {
                if !seen[j] && f.class[j] == DensityClass::Risk as u8 {
                    seen[j] = true;
                    stack.push(j);
                }
            };
            if x > 0 {
                push(i - 1);
            }
            if x + 1 < cols {
                push(i + 1);
            }
            if y > 0 {
                push(i - cols);
            }
            if y + 1 < rows {
                push(i + cols);
            }
        }
        let (x, y) = (f.x0 + gx0 as f64 * f.cell, f.y0 + gy0 as f64 * f.cell);
        let (w, h) = ((gx1 - gx0 + 1) as f64 * f.cell, (gy1 - gy0 + 1) as f64 * f.cell);
        out.push(Hotspot { x, y, w, h, area: cells as f64 * f.cell * f.cell, peak_layers: pl, peak_holes: ph, objects: vec![] });
    }
    out.sort_by(|a, b| b.area.partial_cmp(&a.area).unwrap_or(std::cmp::Ordering::Equal));
    out.truncate(30);
    // the objects stitching in each hotspot
    for h in &mut out {
        let mut count: std::collections::HashMap<u32, usize> = std::collections::HashMap::new();
        for s in &plan.stitches {
            if s.flags & flags::COMMANDS == 0 && s.object != u32::MAX && s.x >= h.x && s.x <= h.x + h.w && s.y >= h.y && s.y <= h.y + h.h {
                *count.entry(s.object).or_default() += 1;
            }
        }
        let mut v: Vec<(u32, usize)> = count.into_iter().collect();
        v.sort_by(|a, b| b.1.cmp(&a.1));
        h.objects = v.into_iter().take(6).map(|x| x.0).collect();
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geom::pt;
    use crate::model::*;

    fn square(x: f64, y: f64, s: f64) -> Vec<SubPath> {
        vec![SubPath::polyline(&[pt(x, y), pt(x + s, y), pt(x + s, y + s), pt(x, y + s)], true)]
    }
    fn obj(id: &str, paths: Vec<SubPath>, stitch: StitchParams) -> Object {
        Object {
            id: id.into(),
            name: id.into(),
            thread: "t".into(),
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
            patterns: vec![],
            clone: None,
            hidden: None,
            start: None,
            end: None,
            lock: None,
            color_sort_index: None,
        }
    }
    fn doc(objects: Vec<Object>) -> Document {
        Document { threads: vec![Thread { id: "t".into(), name: "x".into(), color: "#000000".into(), brand: "".into(), code: "".into(), weight: None }], objects, ..Default::default() }
    }
    fn field(d: &Document) -> DensityField {
        let plan = crate::Engine::new().plan(d);
        density_field(d, &plan, &DensityOptions::default())
    }
    fn at(f: &DensityField, x: f64, y: f64) -> usize {
        ((y - f.y0) / f.cell) as usize * f.cols + ((x - f.x0) / f.cell) as usize
    }
    /// A cell of the 20 mm squares away from the travel a fill sews under its
    /// rows (from its start back to it, as Ink/Stitch does: it adds a layer
    /// along that line).
    const PX: f64 = 15.0;
    const PY: f64 = 5.0;

    #[test]
    fn threads_are_sized_by_weight() {
        let (t40, t12, t60) = (thread_spec(40), thread_spec(12), thread_spec(60));
        assert!((t40.tex - 27.0).abs() < 1e-9 && (t40.width - 0.25).abs() < 1e-9);
        assert!(t12.width > 0.45 && t60.width < 0.25 && t12.tex > t40.tex * 3.0);
    }

    #[test]
    fn a_fill_at_full_cover_is_about_one_layer_per_spacing() {
        // Ink/Stitch's 0.25 mm rows of 40 wt: one layer; 0.125 mm: two
        let fill = |s: f64| StitchParams::Fill(FillParams { underlay: false, row_spacing: s, ..Default::default() });
        let one = field(&doc(vec![obj("a", square(0.0, 0.0, 20.0), fill(0.25))]));
        let two = field(&doc(vec![obj("a", square(0.0, 0.0, 20.0), fill(0.125))]));
        let (l1, l2) = (one.layers[at(&one, PX, PY)], two.layers[at(&two, PX, PY)]);
        assert!((l1 - 1.0).abs() < 0.2, "0.25 mm rows: {l1} layers");
        assert!((l2 - 2.0).abs() < 0.35, "0.125 mm rows: {l2} layers");
        assert_eq!(one.class[at(&one, PX, PY)], DensityClass::Ok as u8);
    }

    #[test]
    fn overlaps_are_risk_and_sparse_covering_fills_are_thin() {
        let fill = |s: f64| StitchParams::Fill(FillParams { underlay: false, row_spacing: s, ..Default::default() });
        let stacked = field(&doc(vec![obj("a", square(0.0, 0.0, 20.0), fill(0.18)), obj("b", square(5.0, 5.0, 10.0), fill(0.18)), obj("c", square(7.0, 7.0, 6.0), fill(0.18))]));
        assert_eq!(stacked.class[at(&stacked, 12.0, 8.0)], DensityClass::Risk as u8, "three dense fills on top of each other");
        // two default fills with their underlay: heavy, not a risk
        let dflt = || StitchParams::Fill(FillParams::default());
        let two = field(&doc(vec![obj("a", square(0.0, 0.0, 20.0), dflt()), obj("b", square(5.0, 5.0, 10.0), dflt())]));
        let i = at(&two, 12.0, 8.0);
        assert_eq!(two.class[i], DensityClass::Heavy as u8, "a fill over a fill: {} layers", two.layers[i]);
        let one = field(&doc(vec![obj("a", square(0.0, 0.0, 20.0), dflt())]));
        let l1 = one.layers[at(&one, PX, PY)];
        // (the underlay and its travel under the rows: up to about 1.75)
        assert!(l1 > 1.1 && l1 < 1.8 && one.class[at(&one, PX, PY)] == DensityClass::Ok as u8, "a default fill with underlay: {l1} layers");
        assert!(!stacked.hotspots.is_empty() && stacked.hotspots[0].objects.len() >= 3);
        let sparse = field(&doc(vec![obj("a", square(0.0, 0.0, 20.0), fill(0.9))]));
        assert_eq!(sparse.class[at(&sparse, PX, PY)], DensityClass::Thin as u8, "0.9 mm rows let the fabric show");
        assert!(sparse.stats.thin > 100.0);
    }

    #[test]
    fn the_fabric_sets_the_limits() {
        let fill = StitchParams::Fill(FillParams { underlay: false, row_spacing: 0.1, ..Default::default() });
        let mut d = doc(vec![obj("a", square(0.0, 0.0, 20.0), fill)]);
        d.fabric = Fabric::Denim;
        let denim = field(&d);
        d.fabric = Fabric::Silk;
        let silk = field(&d);
        let i = at(&denim, 10.0, 10.0);
        assert!(silk.class[i] > denim.class[i], "silk takes less than denim: {} vs {}", silk.class[i], denim.class[i]);
        // added weight: thread length × tex
        assert!(denim.added[i] > 100.0 && denim.added[i] < 400.0, "{}", denim.added[i]);
    }

    #[test]
    fn a_threads_own_weight_sets_its_spacing_and_width() {
        let fill = StitchParams::Fill(FillParams { underlay: false, row_spacing: 0.4, ..Default::default() });
        let mut d = doc(vec![obj("a", square(0.0, 0.0, 20.0), fill)]);
        let base = field(&d).layers[at(&field(&d), PX, PY)];
        d.threads[0].weight = Some(12);
        // a 12 wt thread is sewn at twice the spacing by the engine and covers each row twice as wide
        let f = field(&d);
        let heavy = f.layers[at(&f, PX, PY)];
        assert!((base - 0.625).abs() < 0.12 && (heavy - base).abs() < 0.12, "{base} → {heavy}");
    }
}
