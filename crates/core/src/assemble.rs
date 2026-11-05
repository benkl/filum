//! Turn a document into a machine stitch plan: generate every object (with a
//! per-object cache), apply the design options (hidden-stitch removal,
//! basting), then connect runs with lock stitches, trims, jumps, stops and
//! colour changes.

use std::borrow::Cow;
use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};

use crate::geom::{point_in_ring, pt, Point, Rect, Ring};
use crate::model::{thread_density_scale, Basting, CoverMode, DesignOptions, Document, Fabric, FillMethod, MachineSettings, Object, StitchParams, SubPath, Thread, Ties};
use crate::plan::{flags, Stitch, StitchPlan};
use crate::region::{object_cover, outline, subtract_min, Cover};
use crate::stitches::applique::is_stop;
use crate::stitches::fill::fill_rings;
use crate::stitches::running::running_stitch;
use crate::stitches::{self, Run};

/// Caches generated runs keyed by a hash of the object's geometry + params +
/// fabric + thread weight, and clipped fill shapes keyed by the objects stacked on top.
#[derive(Default)]
pub struct Engine {
    cache: HashMap<u64, Vec<Run>>,
    clips: HashMap<u64, Option<Vec<Ring>>>,
    lines: HashMap<u64, Option<Vec<Vec<Point>>>>,
    /// Whether an object's shape has a part at least so wide (cover width test).
    wide: HashMap<u64, bool>,
}

fn key(json: &str, fabric: Fabric, weight: u32) -> u64 {
    let mut h = DefaultHasher::new();
    json.hash(&mut h);
    (fabric as u8).hash(&mut h);
    weight.hash(&mut h);
    h.finish()
}

/// Objects whose stitching hides what lies underneath.
fn covers_others(o: &Object) -> bool {
    o.visible && matches!(o.stitch, StitchParams::Fill(_) | StitchParams::Satin(_) | StitchParams::Applique(_))
}

fn cover_mode(o: &Object) -> CoverMode {
    o.hidden.map(|h| h.covers).unwrap_or_default()
}

/// Textured fills: open by nature, whatever their spacing.
fn textured(o: &Object) -> bool {
    matches!(&o.stitch, StitchParams::Fill(f) if matches!(f.method, FillMethod::Stipple | FillMethod::Meander | FillMethod::Hilbert | FillMethod::Cross))
}

/// Whether an object may hide what lies under it, by its kind and settings
/// (the width test needs its shape and comes after).
fn may_cover(o: &Object, opts: &DesignOptions) -> bool {
    if !covers_others(o) {
        return false;
    }
    let open = |spacing: f64| opts.cover_max_spacing > 0.0 && spacing > opts.cover_max_spacing + 1e-9;
    match cover_mode(o) {
        CoverMode::Never => false,
        CoverMode::Always => true,
        CoverMode::Auto => match &o.stitch {
            StitchParams::Fill(f) => !see_through(o) && (opts.textured_covers || !textured(o)) && !open(f.row_spacing),
            StitchParams::Satin(p) => !open(p.spacing),
            StitchParams::Applique(_) => opts.applique_covers,
            _ => false,
        },
    }
}

/// The colour layers an object is one of: the layers of a multi-colour
/// gradient or a tartan share one shape and interleave their rows, so none of
/// them hides another. Together they cover the shape like any fill.
fn layer_group(o: &Object) -> Option<&str> {
    match &o.stitch {
        StitchParams::Fill(f) => f.gradient.as_ref().map(|g| g.group.as_str()).or(f.tartan.as_ref().map(|t| t.group.as_str())),
        _ => None,
    }
}

/// Fills that leave gaps for what's under them: a density ramp (colour
/// blending puts two of them over each other) or rows that open up towards
/// the end (end row spacing).
fn see_through(o: &Object) -> bool {
    matches!(&o.stitch, StitchParams::Fill(f) if f.ramp.is_some() || f.end_row_spacing > 0.0)
}

impl Engine {
    pub fn new() -> Engine {
        Engine::default()
    }

    /// Runs of an object on the design's fabric, with its thread's weight
    /// (the thread's own, else the design's).
    fn runs_for(&mut self, obj: &Object, doc: &Document) -> Vec<Run> {
        let (fabric, weight) = (doc.fabric, doc.thread(&obj.thread).and_then(|t| t.weight).unwrap_or(doc.options.thread_weight));
        crate::prof!("runs_for (incl. generate)");
        let json = {
            crate::prof!("runs_for: json key");
            serde_json::to_string(&(&obj.paths, &obj.stitch, &obj.start, &obj.end)).unwrap_or_default()
        };
        let knockdown = doc.options.knockdown;
        let k = key(&json, fabric, weight) ^ (knockdown as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15);
        if let Some(r) = self.cache.get(&k) {
            return r.clone();
        }
        let mut profile = fabric.profile();
        profile.density_scale *= thread_density_scale(weight);
        profile.knockdown = knockdown;
        let r = stitches::generate(obj, &profile);
        if self.cache.len() > 4000 {
            self.cache.clear();
        }
        self.cache.insert(k, r.clone());
        r
    }

    /// Whether an object has a part at least `width` mm wide (cached).
    fn is_wide(&mut self, o: &Object, width: f64) -> bool {
        if width <= 0.0 {
            return true;
        }
        crate::prof!("hidden: is_wide (incl. key)");
        let json = serde_json::to_string(&(&o.paths, &o.stitch, width)).unwrap_or_default();
        let k = key(&json, Fabric::Cotton, 0);
        if let Some(&w) = self.wide.get(&k) {
            return w;
        }
        let w = {
            crate::prof!("hidden: has_width (miss)");
            crate::region::has_width(&object_cover(o), width)
        };
        if self.wide.len() > 4000 {
            self.wide.clear();
        }
        self.wide.insert(k, w);
        w
    }

    /// Runs of one object as drawn (without design options).
    pub fn object_runs(&mut self, doc: &Document, index: usize) -> Vec<Run> {
        self.runs_for(&doc.objects[index], doc)
    }

    /// The object as it is stitched: with "remove overlaps" a fill loses the
    /// parts hidden under objects stacked on top of it. `None` = fully hidden.
    pub fn stitched_object<'a>(&mut self, doc: &'a Document, i: usize) -> Option<Cow<'a, Object>> {
        self.stitched_in(doc, i, &mut Scan::new(doc))
    }

    /// Every object as it is stitched (see `stitched_object`), in one pass
    /// over the document.
    pub fn stitched_objects<'a>(&mut self, doc: &'a Document) -> Vec<Option<Cow<'a, Object>>> {
        let mut scan = Scan::new(doc);
        (0..doc.objects.len()).map(|i| self.stitched_in(doc, i, &mut scan)).collect()
    }

    /// `stitched_object` with what is known of the objects on top (their
    /// bounds, width test and key, worked out once per document).
    fn stitched_in<'a>(&mut self, doc: &'a Document, i: usize, scan: &mut Scan) -> Option<Cow<'a, Object>> {
        let obj = &doc.objects[i];
        let opts = &doc.options;
        let lines = matches!(obj.stitch, StitchParams::Running(_)) && opts.trim_running;
        if !opts.remove_overlaps || !(matches!(obj.stitch, StitchParams::Fill(_)) || lines) || obj.hidden.is_some_and(|h| h.keep) {
            return Some(Cow::Borrowed(obj));
        }
        crate::prof!("hidden: stitched_object");
        let b = scan.bounds(doc, i);
        // a colour layer isn't hidden by its own group, and a group covers once (by its first layer)
        let own = layer_group(obj);
        let mut groups: Vec<&str> = Vec::new();
        let mut above: Vec<usize> = Vec::new();
        for j in i + 1..doc.objects.len() {
            if !(scan.may_cover(doc, j) && scan.bounds(doc, j).intersects(&b)) {
                continue;
            }
            match layer_group(&doc.objects[j]) {
                Some(g) if Some(g) == own || groups.contains(&g) => continue,
                Some(g) => groups.push(g),
                None => {}
            }
            above.push(j);
        }
        // thin objects (outlines, borders, narrow satins) don't hide what lies under them
        let min_w = opts.cover_min_width;
        above.retain(|&j| cover_mode(&doc.objects[j]) == CoverMode::Always || *scan.wide[j].get_or_insert_with(|| self.is_wide(&doc.objects[j], min_w)));
        if above.is_empty() {
            return Some(Cow::Borrowed(obj));
        }
        crate::prof!("hidden: key + clip");
        let above_keys: Vec<u64> = above.iter().map(|&j| scan.key(doc, j)).collect();
        let above: Vec<&Object> = above.iter().map(|&j| &doc.objects[j]).collect();
        let json = serde_json::to_string(&(&obj.paths, lines, above_keys, opts.overlap_margin, opts.min_fragment)).unwrap_or_default();
        let k = key(&json, doc.fabric, 0);
        if lines {
            if !self.lines.contains_key(&k) {
                let polys: Vec<Vec<Point>> = obj
                    .paths
                    .iter()
                    .map(|sp| {
                        let mut pts = sp.flatten(0.05);
                        if sp.closed && pts.len() > 2 {
                            pts.push(pts[0]);
                        }
                        pts
                    })
                    .collect();
                let covers: Vec<Cover> = above.iter().flat_map(|o| object_cover(o)).collect();
                crate::prof!("hidden: clip_lines (miss)");
                let cut = crate::region::clip_lines(&polys, &covers, opts.overlap_margin, 0.8);
                if self.lines.len() > 2000 {
                    self.lines.clear();
                }
                self.lines.insert(k, cut);
            }
            return match &self.lines[&k] {
                None => Some(Cow::Borrowed(obj)),
                Some(l) if l.is_empty() => None,
                Some(l) => Some(Cow::Owned(Object { paths: l.iter().map(|p| SubPath::polyline(p, false)).collect(), ..obj.clone() })),
            };
        }
        if !self.clips.contains_key(&k) {
            crate::prof!("hidden: subtract_min (miss)");
            let area = fill_rings(&obj.paths);
            let covers: Vec<Cover> = above.iter().flat_map(|o| object_cover(o)).collect();
            let clipped = subtract_min(&area, &covers, opts.overlap_margin.max(0.0), opts.min_fragment.max(0.0));
            if self.clips.len() > 2000 {
                self.clips.clear();
            }
            self.clips.insert(k, clipped);
        }
        match &self.clips[&k] {
            None => Some(Cow::Borrowed(obj)),
            Some(r) if r.is_empty() => None,
            Some(r) => Some(Cow::Owned(Object { paths: r.iter().map(|ring| SubPath::polyline(ring, true)).collect(), ..obj.clone() })),
        }
    }

    pub fn plan(&mut self, doc: &Document) -> StitchPlan {
        crate::prof!("plan");
        let mut items: Vec<(usize, Vec<Run>)> = Vec::new();
        // where the previous object ended: an object without a start point
        // begins as near to it as it can (Ink/Stitch passes every element the
        // previous stitch) — shorter jumps, fewer trims. Snapped to half a
        // millimetre, so small edits upstream keep the cached stitches.
        let mut prev: Option<Point> = None;
        let mut scan = Scan::new(doc);
        for i in 0..doc.objects.len() {
            if !doc.objects[i].visible {
                continue;
            }
            let Some(obj) = self.stitched_in(doc, i, &mut scan) else { continue };
            // cut by what lies on top: with "keep underlay" the full underlay stays under it
            let keep_under = doc.options.keep_underlay && matches!(obj, Cow::Owned(_)) && matches!(obj.stitch, StitchParams::Fill(_));
            let obj = match (obj.start, prev) {
                (None, Some(p)) if starts_near(&obj.stitch) => {
                    let mut o = obj.into_owned();
                    o.start = Some([(p.x * 2.0).round() / 2.0, (p.y * 2.0).round() / 2.0]);
                    Cow::Owned(o)
                }
                _ => obj,
            };
            let mut runs: Vec<Run> = self.runs_for(&obj, doc).into_iter().filter(|r| !r.is_empty()).collect();
            if keep_under {
                let full = Object { start: obj.start, ..doc.objects[i].clone() };
                let (under, _) = split_underlay(self.runs_for(&full, doc));
                let (_, top) = split_underlay(runs);
                runs = under.into_iter().chain(top).filter(|r| !r.is_empty()).collect();
            }
            if let Some(&(q, _)) = runs.last().and_then(|r| r.last()) {
                prev = Some(q);
            }
            if !runs.is_empty() {
                items.push((i, runs));
            }
        }
        // first the basting (holding fabric and stabiliser), then the
        // knockdown (flattening the nap) — both in the knockdown's colour
        // when there is one
        crate::prof!("plan: basting/knockdown/assemble");
        let mut prefix = basting_runs(doc, &items);
        let knock = knockdown_runs(doc, &items);
        let thread = (!knock.is_empty()).then(|| knockdown_thread(doc));
        prefix.extend(knock);
        assemble_prefixed(doc, &items, &prefix, thread)
    }
}

/// What hidden-stitch removal asks of every object on top of a fill, worked
/// out once per document instead of once per fill under it: its bounds,
/// whether it may hide what's under it, its width test and a key of its
/// shape and stitching.
struct Scan {
    bounds: Vec<Option<Rect>>,
    covers: Vec<Option<bool>>,
    wide: Vec<Option<bool>>,
    keys: Vec<Option<u64>>,
}

impl Scan {
    fn new(doc: &Document) -> Scan {
        let n = doc.objects.len();
        Scan { bounds: vec![None; n], covers: vec![None; n], wide: vec![None; n], keys: vec![None; n] }
    }
    fn bounds(&mut self, doc: &Document, j: usize) -> Rect {
        *self.bounds[j].get_or_insert_with(|| doc.objects[j].bounds())
    }
    fn may_cover(&mut self, doc: &Document, j: usize) -> bool {
        *self.covers[j].get_or_insert_with(|| may_cover(&doc.objects[j], &doc.options))
    }
    fn key(&mut self, doc: &Document, j: usize) -> u64 {
        *self.keys[j].get_or_insert_with(|| {
            let o = &doc.objects[j];
            key(&serde_json::to_string(&(&o.paths, &o.stitch)).unwrap_or_default(), Fabric::Cotton, 0)
        })
    }
}

/// Runs split into the underlay and the rest (a run that changes over is cut there).
fn split_underlay(runs: Vec<Run>) -> (Vec<Run>, Vec<Run>) {
    let (mut under, mut top) = (Vec::new(), Vec::new());
    for run in runs {
        let mut cur: Run = Vec::new();
        let mut is_under = None;
        for s in run {
            let u = s.1 & flags::UNDERLAY != 0;
            if is_under.is_some_and(|x| x != u) {
                let done = std::mem::take(&mut cur);
                if is_under == Some(true) {
                    under.push(done)
                } else {
                    top.push(done)
                }
            }
            is_under = Some(u);
            cur.push(s);
        }
        if !cur.is_empty() {
            if is_under == Some(true) {
                under.push(cur)
            } else {
                top.push(cur)
            }
        }
    }
    (under, top)
}

/// Stitch types that start where they are told (running, satins, fills).
fn starts_near(st: &StitchParams) -> bool {
    matches!(st, StitchParams::Running(_) | StitchParams::Satin(_) | StitchParams::Fill(_))
}

/// The knockdown's thread: its colour, else the fabric's (a light neutral).
fn knockdown_thread(doc: &Document) -> Thread {
    let c = doc.options.knockdown_color.trim();
    let color = if c.starts_with('#') && c.len() == 7 { c.to_string() } else { "#f4f1ea".to_string() };
    Thread { id: "knockdown".into(), name: "Knockdown".into(), color, brand: String::new(), code: String::new(), weight: None }
}

/// Knockdown (laydown stitch): a light net over the area of the whole
/// design, reaching `knockdown_offset` beyond it, sewn before everything else
/// to flatten the nap of towels, fleece and fur. One layer, or two crossing at
/// 90° (the usual angle for the second); long stitches at a wide spacing.
fn knockdown_runs(doc: &Document, items: &[(usize, Vec<Run>)]) -> Vec<Run> {
    let o = &doc.options;
    if !o.knockdown || items.is_empty() {
        return vec![];
    }
    let covers: Vec<Cover> = items.iter().flat_map(|(i, _)| object_cover(&doc.objects[*i])).collect();
    let b = crate::region::covers_bounds(&covers);
    let res = ((b.width().max(b.height()) + 2.0 * o.knockdown_offset) / 1500.0).clamp(0.05, 0.3);
    let all = outline(&covers, o.knockdown_offset.max(0.0), res);
    // without holes: only the outer boundaries (the net goes over counters and gaps)
    let rings: Vec<Ring> = if o.knockdown_holes {
        all
    } else {
        all.iter().filter(|r| !all.iter().any(|q| !std::ptr::eq(*r, q) && point_in_ring(r[0], q))).cloned().collect()
    };
    if rings.is_empty() {
        return vec![];
    }
    let (spacing, len) = (o.knockdown_spacing.clamp(0.5, 8.0), o.knockdown_length.clamp(1.0, 10.0));
    let mut runs: Vec<Run> = Vec::new();
    for k in 0..o.knockdown_layers.clamp(1, 2) {
        let from = runs.last().and_then(|r| r.last()).map(|x| x.0);
        runs.extend(crate::stitches::fill::tatami(&rings, o.knockdown_angle + 90.0 * k as f64, spacing, 0.0, false, len, 2, 0.0, 3.0, from, None, None, 0));
    }
    crate::stitches::fill::chain(&rings, runs, 3.0, 0)
}

/// Basting stitched before the design (box or contour around it).
fn basting_runs(doc: &Document, items: &[(usize, Vec<Run>)]) -> Vec<Run> {
    let o = &doc.options;
    let len = o.basting_length.max(1.0);
    let rings: Vec<Ring> = match o.basting {
        Basting::None => return vec![],
        Basting::Box => {
            let mut b = Rect::EMPTY;
            for (_, runs) in items {
                for r in runs {
                    for (p, _) in r {
                        b.include(*p);
                    }
                }
            }
            if b.is_empty() {
                return vec![];
            }
            let m = o.basting_margin.max(0.0);
            vec![vec![
                Point { x: b.min_x - m, y: b.min_y - m },
                Point { x: b.max_x + m, y: b.min_y - m },
                Point { x: b.max_x + m, y: b.max_y + m },
                Point { x: b.min_x - m, y: b.max_y + m },
            ]]
        }
        Basting::Contour => {
            let covers: Vec<Cover> = items.iter().flat_map(|(i, _)| object_cover(&doc.objects[*i])).collect();
            let b = crate::region::covers_bounds(&covers);
            let res = ((b.width().max(b.height()) + 2.0 * o.basting_margin) / 1500.0).clamp(0.05, 0.3);
            let rings = outline(&covers, o.basting_margin.max(0.5), res);
            // only the outer boundaries
            rings.iter().filter(|r| !rings.iter().any(|q| !std::ptr::eq(*r, q) && point_in_ring(r[0], q))).cloned().collect()
        }
    };
    rings
        .iter()
        .filter(|r| r.len() >= 3)
        .map(|r| {
            let mut pts = r.clone();
            pts.push(r[0]);
            running_stitch(&pts, len, 0.2).into_iter().map(|p| (p, 0u8)).collect()
        })
        .collect()
}


/// A connecting stitch between two objects (a gap up to the trim distance,
/// sewn through) is trimmed instead when it stays visible over this length:
/// commercial auto-trim cuts from 2 mm (Ink/Stitch sews up to 3 mm).
const VISIBLE_CONNECTION: f64 = 2.0;
/// Visible: a stretch longer than this that nothing sewn later lies within
/// `COVERED_WITHIN` of.
const VISIBLE_STRETCH: f64 = 1.0;
const COVERED_WITHIN: f64 = 0.45;

/// The stitches still to be sewn (every run of the design, in sewing
/// order), indexed by grid cell on first use: does a connecting stitch end
/// up under them?
struct Ahead<'a> {
    runs: Vec<&'a Run>,
    grid: Option<crate::geom::CellMap<Vec<(u32, Point, Point)>>>,
}

impl Ahead<'_> {
    const CELL: f64 = 1.0;

    fn grid(&mut self) -> &crate::geom::CellMap<Vec<(u32, Point, Point)>> {
        let runs = &self.runs;
        self.grid.get_or_insert_with(|| {
            let mut g: crate::geom::CellMap<Vec<(u32, Point, Point)>> = Default::default();
            for (k, run) in runs.iter().enumerate() {
                for w in run.windows(2) {
                    let (a, b) = (w[0].0, w[1].0);
                    let (lo, hi) = (pt(a.x.min(b.x), a.y.min(b.y)), pt(a.x.max(b.x), a.y.max(b.y)));
                    for y in (lo.y / Self::CELL).floor() as i64..=(hi.y / Self::CELL).floor() as i64 {
                        for x in (lo.x / Self::CELL).floor() as i64..=(hi.x / Self::CELL).floor() as i64 {
                            g.entry((x, y)).or_default().push((k as u32, a, b));
                        }
                    }
                }
            }
            g
        })
    }

    /// Does the stitch `a → b`, sewn before run `next`, stay visible: a
    /// stretch of it longer than `VISIBLE_STRETCH` that no stitch of run
    /// `next` or later lies on?
    fn visible(&mut self, a: Point, b: Point, next: usize) -> bool {
        let grid = self.grid();
        let near = |p: Point| {
            let (kx, ky) = ((p.x / Self::CELL).floor() as i64, (p.y / Self::CELL).floor() as i64);
            (ky - 1..=ky + 1).any(|y| {
                (kx - 1..=kx + 1).any(|x| grid.get(&(x, y)).is_some_and(|v| v.iter().any(|&(k, s0, s1)| k as usize >= next && seg_dist(p, s0, s1) < COVERED_WITHIN)))
            })
        };
        let len = a.dist(b);
        let n = (len / 0.2).ceil().max(1.0) as usize;
        let step = len / n as f64;
        let mut open = 0.0;
        for k in 0..=n {
            if near(a + (b - a) * (k as f64 / n as f64)) {
                open = 0.0;
            } else {
                open += step;
                if open > VISIBLE_STRETCH {
                    return true;
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

fn fallback_thread(i: usize) -> Thread {
    Thread { id: format!("auto{i}"), name: "Black".into(), color: "#1c1c1c".into(), brand: String::new(), code: String::new(), weight: None }
}

/// Machine-level stitch list under construction.
struct Builder<'a> {
    m: &'a MachineSettings,
    out: Vec<Stitch>,
    pos: Option<Point>,
    needs_tie_in: bool,
    /// Where the object being sewn is locked (its `ties`), and the one sewn before.
    ties: Ties,
    prev_ties: Ties,
    /// The object the last stitches belong to (its tie-off is its own).
    last_obj: u32,
    /// The current object's minimum stitch and jump (mm), and the jump
    /// limit of the object sewn last: a longer gap after it is locked and trimmed.
    min_stitch: f64,
    min_jump: f64,
    last_min_jump: f64,
    /// The current object's and the last object's jump limit were set on the
    /// object (they win over the visible-connection trim).
    min_jump_set: bool,
    last_min_jump_set: bool,
    /// The runs still to come, and the index among them of the run being sewn.
    ahead: Ahead<'a>,
    at: usize,
}

impl Builder<'_> {
    /// The end lock at `at`, along the stitches sewn before it.
    fn tie_off(&mut self, at: Point, o: u32) {
        if !matches!(self.prev_ties, Ties::Both | Ties::End) {
            return;
        }
        let behind: Vec<Point> = self.out.iter().rev().filter(|s| s.is_stitch()).take(20).map(|s| s.pos()).collect();
        let behind = if behind.first().is_some_and(|p| p.dist(at) < 1e-6) { behind } else { std::iter::once(at).chain(behind).collect() };
        for p in crate::locks::lock_points(self.m.lock_end, &behind, self.m.lock_scale, self.m.lock_length, true) {
            self.out.push(Stitch::new(p, flags::TIE, o));
        }
    }

    /// The start lock at the run's first point, along the run.
    fn tie_in(&mut self, run: &Run, o: u32) {
        if !matches!(self.ties, Ties::Both | Ties::Start) {
            return;
        }
        let ahead: Vec<Point> = run.iter().take(20).map(|x| x.0).collect();
        for p in crate::locks::lock_points(self.m.lock_start, &ahead, self.m.lock_scale, self.m.lock_length, false) {
            if self.out.last().is_some_and(|s| s.pos().dist(p) < 1e-6) {
                continue;
            }
            self.out.push(Stitch::new(p, flags::TIE, o));
        }
    }

    /// Force lock (Ink/Stitch `force_lock_stitches`): lock the end here and the
    /// next start, even though no trim follows.
    fn force_lock(&mut self, o: u32) {
        if let Some(p) = self.pos {
            if self.m.ties {
                self.tie_off(p, o);
            }
            self.needs_tie_in = true;
        }
    }

    /// Tie off and trim (and stop the machine).
    fn cut(&mut self, o: u32, stop: bool, color_change: bool) {
        if let Some(p) = self.pos {
            if self.m.ties && !self.needs_tie_in {
                let owner = self.last_obj;
                self.tie_off(p, owner);
            }
            // a colour change cuts the thread itself (the machine trims there;
            // Ink/Stitch writes no trim before it): no trim of our own
            if !color_change {
                self.out.push(Stitch::new(p, flags::TRIM, o));
            }
            if stop {
                self.out.push(Stitch::new(p, flags::STOP, o));
            }
            if color_change {
                self.out.push(Stitch::new(p, flags::COLOR_CHANGE, o));
            }
        }
        self.needs_tie_in = true;
    }

    fn run(&mut self, run: &Run, o: u32) {
        let m = self.m;
        let start = run[0].0;
        match self.pos {
            Some(p) => {
                let gap = p.dist(start);
                // a short connection to the next object is sewn through, unless
                // it would show: nothing sewn later covers it
                let shows = || gap > VISIBLE_CONNECTION && o != self.last_obj && o != u32::MAX && !self.last_min_jump_set;
                if !self.needs_tie_in && (gap > self.last_min_jump || (shows() && self.ahead.visible(p, start, self.at))) {
                    self.cut(o, false, false);
                }
                if self.needs_tie_in && gap > 1e-6 {
                    self.out.push(Stitch::new(start, flags::JUMP, o));
                }
            }
            None => self.out.push(Stitch::new(start, flags::JUMP, o)),
        }
        if self.needs_tie_in {
            self.out.push(Stitch::new(start, 0, o));
            if m.ties {
                self.tie_in(run, o);
            }
            self.needs_tie_in = false;
        }
        let mut last = self.out.iter().rev().find(|s| s.is_stitch()).map(|s| s.pos()).unwrap_or(start);
        let k = run.len();
        for (j, &(q, f)) in run.iter().enumerate() {
            // drop too-short stitches, but always land on the run's final point
            if q.dist(last) < self.min_stitch && j + 1 < k {
                continue;
            }
            if q.dist(last) < 1e-6 {
                continue;
            }
            self.out.push(Stitch::new(q, f, o));
            last = q;
        }
        self.pos = Some(last);
        self.last_obj = o;
        self.last_min_jump = self.min_jump;
        self.last_min_jump_set = self.min_jump_set;
        self.prev_ties = self.ties;
    }
}

pub fn assemble(doc: &Document, items: &[(usize, Vec<Run>)]) -> StitchPlan {
    assemble_with(doc, items, &[])
}

/// Assemble with `prefix` runs (basting) sewn first in the first colour.
pub fn assemble_with(doc: &Document, items: &[(usize, Vec<Run>)], prefix: &[Run]) -> StitchPlan {
    assemble_prefixed(doc, items, prefix, None)
}

/// Assemble with stitches sewn before the design (basting, knockdown): in
/// `prefix_thread`, or in the first object's thread.
pub fn assemble_prefixed(doc: &Document, items: &[(usize, Vec<Run>)], prefix: &[Run], prefix_thread: Option<Thread>) -> StitchPlan {
    let ahead = Ahead { runs: items.iter().flat_map(|(_, runs)| runs.iter()).collect(), grid: None };
    let mut b = Builder {
        m: &doc.machine,
        out: Vec::new(),
        pos: None,
        needs_tie_in: true,
        ties: Ties::Both,
        prev_ties: Ties::Both,
        last_obj: u32::MAX,
        min_stitch: doc.machine.min_stitch,
        min_jump: doc.machine.trim_distance,
        last_min_jump: doc.machine.trim_distance,
        min_jump_set: false,
        last_min_jump_set: false,
        ahead,
        at: 0,
    };
    let mut at = 0usize;
    let mut threads: Vec<Thread> = Vec::new();
    let mut cur_thread: Option<&str> = None;

    if let (Some((first, _)), false) = (items.first(), prefix.is_empty()) {
        match &prefix_thread {
            // its own colour: a colour change follows before the design
            Some(t) => threads.push(t.clone()),
            None => {
                let t = &doc.objects[*first].thread;
                threads.push(doc.thread(t).cloned().unwrap_or_else(|| fallback_thread(0)));
                cur_thread = Some(t.as_str());
            }
        }
        for run in prefix.iter().filter(|r| !r.is_empty()) {
            b.run(run, u32::MAX);
        }
        // in its own colour the colour change before the design trims
        if prefix_thread.is_none() {
            b.cut(u32::MAX, false, false);
        }
    }
    let own_prefix = prefix_thread.is_some() && !prefix.is_empty();
    let mut first_object = true;

    for (n, (oi, runs)) in items.iter().enumerate() {
        let obj = &doc.objects[*oi];
        let o = *oi as u32;
        // a colour change only when the spool changes (threads fitted or
        // merged onto the same spool are sewn as one colour)
        let after_prefix = std::mem::replace(&mut first_object, false) && own_prefix;
        if after_prefix || cur_thread.map_or(true, |c| !doc.same_spool(c, &obj.thread)) {
            if cur_thread.is_some() || after_prefix {
                // the tie-off and colour change end the prefix when it has its own colour
                b.cut(if after_prefix { u32::MAX } else { o }, false, true);
            }
            threads.push(doc.thread(&obj.thread).cloned().unwrap_or_else(|| fallback_thread(threads.len())));
            cur_thread = Some(obj.thread.as_str());
        }
        b.ties = obj.ties;
        b.min_stitch = obj.min_stitch.unwrap_or(doc.machine.min_stitch).max(0.0);
        b.min_jump = obj.min_jump.unwrap_or(doc.machine.trim_distance).max(0.0);
        b.min_jump_set = obj.min_jump.is_some();
        for run in runs {
            b.at = at;
            at += 1;
            if is_stop(run) {
                // stop inside the object (appliqué steps)
                if b.pos.is_some() {
                    b.cut(o, true, false);
                }
                continue;
            }
            b.run(run, o);
        }
        let is_last = n + 1 == items.len();
        if (obj.trim_after || obj.stop_after) && !is_last {
            b.cut(o, obj.stop_after, false);
        } else if obj.force_lock && !is_last {
            b.force_lock(o);
        }
    }
    if let Some(p) = b.pos {
        if b.m.ties && !b.needs_tie_in {
            let owner = b.last_obj;
            b.tie_off(p, owner);
        }
        b.out.push(Stitch::new(p, flags::TRIM, u32::MAX));
        b.out.push(Stitch::new(p, flags::END, u32::MAX));
    }
    StitchPlan { stitches: b.out, threads }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geom::pt;
    use crate::model::*;

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
            clone: None,
            hidden: None,
            patterns: vec![],
            start: None,
            end: None,
        }
    }
    fn square(x: f64, y: f64, s: f64) -> Vec<SubPath> {
        vec![SubPath::polyline(&[pt(x, y), pt(x + s, y), pt(x + s, y + s), pt(x, y + s)], true)]
    }
    fn doc(objects: Vec<Object>) -> Document {
        Document {
            threads: vec![Thread { id: "t".into(), name: "x".into(), color: "#000000".into(), brand: "".into(), code: "".into(), weight: None }],
            objects,
            ..Default::default()
        }
    }
    fn count(plan: &StitchPlan, f: u8) -> usize {
        plan.stitches.iter().filter(|s| s.is(f)).count()
    }

    #[test]
    fn threads_on_the_same_spool_need_no_colour_change() {
        let th = |id: &str, color: &str, code: &str| Thread { id: id.into(), name: id.into(), color: color.into(), brand: "Madeira".into(), code: code.into(), weight: None };
        let fill = StitchParams::Fill(FillParams { underlay: false, ..Default::default() });
        let mk = |a: &str, b: &str| {
            let mut d = doc(vec![Object { thread: "a".into(), ..obj("1", square(0.0, 0.0, 10.0), fill.clone()) }, Object { thread: "b".into(), ..obj("2", square(20.0, 0.0, 10.0), fill.clone()) }]);
            d.threads = vec![th("a", a, "1621"), th("b", b, if a.eq_ignore_ascii_case(b) { "1621" } else { "1800" })];
            d
        };
        let same = Engine::new().plan(&mk("#b8521c", "#B8521C"));
        assert_eq!(count(&same, flags::COLOR_CHANGE), 0, "one spool, one colour");
        assert_eq!(same.threads.len(), 1);
        let other = Engine::new().plan(&mk("#b8521c", "#1c1c1c"));
        assert_eq!(count(&other, flags::COLOR_CHANGE), 1);
        assert_eq!(other.threads.len(), 2);
    }

    #[test]
    fn thread_weight_scales_density() {
        let fill = StitchParams::Fill(FillParams { underlay: false, ..Default::default() });
        let mut d = doc(vec![obj("a", square(0.0, 0.0, 30.0), fill)]);
        let n = |d: &Document| Engine::new().plan(d).stitches.iter().filter(|s| s.is_stitch()).count() as f64;
        let std = n(&d);
        d.options.thread_weight = 60; // 0.35 / 0.40 spacing: more rows
        let fine = n(&d);
        d.options.thread_weight = 12; // 0.80 / 0.40: half the rows
        let heavy = n(&d);
        assert!(fine > std * 1.08 && heavy < std * 0.65, "{fine} / {std} / {heavy}");
    }

    #[test]
    fn thread_use_follows_madeira() {
        let fill = StitchParams::Fill(FillParams { underlay: false, ..Default::default() });
        let d = doc(vec![obj("a", square(0.0, 0.0, 30.0), fill)]);
        let st = Engine::new().plan(&d).stats(800.0, 6.0, 12.0);
        // at least 5 m per 1,000 stitches, bobbin 0.65 of the top thread
        assert!(st.thread_m * 1000.0 / st.stitches as f64 >= 4.99);
        assert!((st.bobbin_m / st.thread_m - 0.65).abs() < 1e-9);
    }

    #[test]
    fn remove_overlaps_saves_stitches() {
        let fill = StitchParams::Fill(FillParams { underlay: false, ..Default::default() });
        let mut d = doc(vec![obj("a", square(0.0, 0.0, 30.0), fill.clone()), obj("b", square(5.0, 5.0, 20.0), fill)]);
        // the lower 30 mm square loses the 20 mm square on top (minus the margin)
        let lower = |p: &StitchPlan| p.stitches.iter().filter(|s| s.is_stitch() && s.object == 0).count();
        let full = lower(&Engine::new().plan(&d));
        d.options.remove_overlaps = true;
        let mut eng = Engine::new();
        let clipped = lower(&eng.plan(&d));
        assert!(clipped < full * 8 / 10, "{clipped} vs {full}");
        // 900 mm² minus the cover shrunk by the 0.6 mm margin (18.8² mm²)
        let shape = eng.stitched_object(&d, 0).unwrap();
        let area = crate::geom::rings_area(&fill_rings(&shape.paths));
        assert!((area - (900.0 - 18.8 * 18.8)).abs() < 12.0, "area {area}");
    }

    #[test]
    fn colour_layers_do_not_hide_each_other() {
        use crate::model::GradientParams;
        let layer = |n: u32, group: &str| StitchParams::Fill(FillParams { underlay: false, gradient: Some(GradientParams { layer: n, group: group.into(), ..Default::default() }), ..Default::default() });
        // a two-colour gradient over a plain fill, then a second gradient over the first
        let base = StitchParams::Fill(FillParams { underlay: false, ..Default::default() });
        let mut d = doc(vec![
            obj("under", square(5.0, 5.0, 10.0), base),
            obj("g1", square(0.0, 0.0, 30.0), layer(0, "g")),
            obj("g2", square(0.0, 0.0, 30.0), layer(1, "g")),
        ]);
        d.options.remove_overlaps = true;
        d.options.overlap_margin = 0.0;
        let mut eng = Engine::new();
        // every layer of the gradient is stitched in full
        for i in 1..3 {
            let shape = eng.stitched_object(&d, i).unwrap();
            assert!(matches!(shape, Cow::Borrowed(_)), "layer {i} is not clipped");
        }
        // what lies under the whole gradient is still hidden
        assert!(eng.stitched_object(&d, 0).is_none(), "the fill under the gradient is hidden");

        // colour blending: two fills with opposite ramps over each other
        let ramp = |a: f64| StitchParams::Fill(FillParams { underlay: false, ramp: Some(crate::model::DensityRamp { from: [0.0, 0.0], to: [a, 0.0], ..Default::default() }), ..Default::default() });
        let d2 = Document { options: d.options.clone(), ..doc(vec![obj("a", square(0.0, 0.0, 30.0), ramp(30.0)), obj("b", square(0.0, 0.0, 30.0), ramp(-30.0))]) };
        assert!(matches!(Engine::new().stitched_object(&d2, 0), Some(Cow::Borrowed(_))), "a blend layer keeps its stitches");
    }

    /// A 30 mm fill under `top`, hidden stitching removed without a margin.
    fn under(top: Object) -> Document {
        let fill = StitchParams::Fill(FillParams { underlay: false, ..Default::default() });
        let mut d = doc(vec![obj("under", square(0.0, 0.0, 30.0), fill), top]);
        d.options.remove_overlaps = true;
        d.options.overlap_margin = 0.0;
        d
    }
    fn is_cut(d: &Document) -> bool {
        matches!(Engine::new().stitched_object(d, 0), Some(Cow::Owned(_)) | None)
    }

    #[test]
    fn thin_objects_do_not_hide_what_is_under_them() {
        // a 1 mm wide strip of fill over the square: an outline, not a cover
        let strip = vec![SubPath::polyline(&[pt(5.0, 5.0), pt(25.0, 5.0), pt(25.0, 6.0), pt(5.0, 6.0)], true)];
        let fill = StitchParams::Fill(FillParams { underlay: false, ..Default::default() });
        let mut d = under(obj("strip", strip, fill));
        assert!(!is_cut(&d), "1 mm is under the 1.5 mm cover width");
        d.options.cover_min_width = 0.5;
        assert!(is_cut(&d), "with a 0.5 mm cover width it hides");
    }

    #[test]
    fn open_and_textured_fills_do_not_hide_what_is_under_them() {
        let open = StitchParams::Fill(FillParams { underlay: false, row_spacing: 2.0, ..Default::default() });
        let mut d = under(obj("open", square(5.0, 5.0, 20.0), open));
        assert!(!is_cut(&d), "rows 2 mm apart are open");
        d.options.cover_max_spacing = 3.0;
        assert!(is_cut(&d), "unless open rows are allowed to hide");

        let stipple = StitchParams::Fill(FillParams { underlay: false, method: FillMethod::Stipple, ..Default::default() });
        let mut d = under(obj("stipple", square(5.0, 5.0, 20.0), stipple));
        assert!(!is_cut(&d), "a texture shows what is under it");
        d.options.textured_covers = true;
        assert!(is_cut(&d));
    }

    #[test]
    fn an_object_can_always_or_never_hide_and_can_keep_its_stitches() {
        let fill = StitchParams::Fill(FillParams { underlay: false, ..Default::default() });
        let mut top = obj("top", square(5.0, 5.0, 20.0), fill.clone());
        let d = under(top.clone());
        assert!(is_cut(&d));
        top.hidden = Some(HiddenRule { covers: CoverMode::Never, keep: false });
        assert!(!is_cut(&under(top.clone())), "never hides");

        // a thin strip told to hide anyway
        let strip = vec![SubPath::polyline(&[pt(5.0, 5.0), pt(25.0, 5.0), pt(25.0, 6.0), pt(5.0, 6.0)], true)];
        let mut thin = obj("strip", strip, fill.clone());
        thin.hidden = Some(HiddenRule { covers: CoverMode::Always, keep: false });
        assert!(is_cut(&under(thin)), "always hides");

        // the fill underneath keeps everything
        let mut d = under(obj("top", square(5.0, 5.0, 20.0), fill));
        d.objects[0].hidden = Some(HiddenRule { covers: CoverMode::Auto, keep: true });
        assert!(!is_cut(&d), "keeps its stitches");
    }

    #[test]
    fn small_leftovers_are_not_worth_a_jump() {
        // the cover leaves a 1 x 30 mm strip on the left (30 mm²) and, through a hole in it, a 3 x 3 mm island
        let fill = StitchParams::Fill(FillParams { underlay: false, ..Default::default() });
        let mut cover = vec![SubPath::polyline(&[pt(1.0, -1.0), pt(31.0, -1.0), pt(31.0, 31.0), pt(1.0, 31.0)], true)];
        cover.extend(square(15.0, 15.0, 3.0));
        let mut d = under(obj("top", cover, fill));
        d.options.min_fragment = 0.0;
        let all = crate::geom::rings_area(&fill_rings(&Engine::new().stitched_object(&d, 0).unwrap().paths));
        assert!((all - 39.0).abs() < 2.0, "the strip and the island: {all}");
        d.options.min_fragment = 20.0;
        let mut eng = Engine::new();
        let kept = eng.stitched_object(&d, 0).unwrap();
        let area = crate::geom::rings_area(&fill_rings(&kept.paths));
        assert!((area - 30.0).abs() < 2.0, "only the strip is left: {area}");
        d.options.min_fragment = 40.0;
        assert!(Engine::new().stitched_object(&d, 0).is_none(), "and not even that");
    }

    #[test]
    fn keep_underlay_sews_the_whole_underlay() {
        let under_fill = StitchParams::Fill(FillParams { underlay: true, underlay_auto: false, ..Default::default() });
        let top = StitchParams::Fill(FillParams { underlay: false, ..Default::default() });
        let mut d = doc(vec![obj("under", square(0.0, 0.0, 30.0), under_fill), obj("top", square(0.0, 0.0, 25.0), top)]);
        d.options.remove_overlaps = true;
        let ul = |d: &Document| Engine::new().plan(d).stitches.iter().filter(|s| s.object == 0 && s.is_stitch() && s.flags & flags::UNDERLAY != 0).count();
        let cut = ul(&d);
        d.options.keep_underlay = true;
        let kept = ul(&d);
        assert!(kept > cut * 2, "the underlay under the cover stays: {kept} vs {cut}");
    }

    #[test]
    fn running_stitches_under_a_cover_can_go_too() {
        let line = vec![SubPath::polyline(&[pt(0.0, 15.0), pt(40.0, 15.0)], false)];
        let fill = StitchParams::Fill(FillParams { underlay: false, ..Default::default() });
        let mut d = doc(vec![obj("line", line, StitchParams::Running(RunningParams::default())), obj("top", square(10.0, 0.0, 20.0), fill)]);
        d.options.remove_overlaps = true;
        d.options.overlap_margin = 0.5;
        assert!(matches!(Engine::new().stitched_object(&d, 0), Some(Cow::Borrowed(_))), "lines stay unless asked");
        d.options.trim_running = true;
        let cut = Engine::new().stitched_object(&d, 0).unwrap().into_owned();
        assert_eq!(cut.paths.len(), 2, "a piece on each side of the cover");
        let xs: Vec<f64> = cut.paths.iter().flat_map(|p| p.nodes.iter().map(|n| n.p[0])).collect();
        assert!(xs.iter().all(|&x| x <= 10.6 || x >= 29.4), "reaching 0.5 mm under the cover: {xs:?}");
    }

    #[test]
    fn fully_hidden_fill_is_dropped() {
        let fill = StitchParams::Fill(FillParams { underlay: false, ..Default::default() });
        let mut d = doc(vec![obj("a", square(5.0, 5.0, 10.0), fill.clone()), obj("b", square(0.0, 0.0, 30.0), fill)]);
        d.options.remove_overlaps = true;
        d.options.overlap_margin = 0.0;
        let plan = Engine::new().plan(&d);
        assert!(plan.stitches.iter().all(|s| s.object != 0), "object a is hidden");
    }

    #[test]
    fn applique_emits_stops() {
        let d = doc(vec![obj("a", square(0.0, 0.0, 30.0), StitchParams::Applique(AppliqueParams::default()))]);
        let plan = Engine::new().plan(&d);
        assert_eq!(count(&plan, flags::STOP), 2);
    }

    #[test]
    fn objects_start_near_where_the_last_one_ended() {
        let line = |a: [f64; 2], b: [f64; 2]| vec![SubPath::polyline(&[pt(a[0], a[1]), pt(b[0], b[1])], false)];
        let run = StitchParams::Running(RunningParams::default());
        // the second line is drawn from its far end
        let d = doc(vec![obj("a", line([0.0, 0.0], [30.0, 0.0]), run.clone()), obj("b", line([60.0, 10.0], [32.0, 10.0]), run)]);
        let plan = Engine::new().plan(&d);
        let first_b = plan.stitches.iter().find(|s| s.object == 1 && s.is_stitch()).unwrap();
        assert!(first_b.x < 35.0, "starts at the near end: {first_b:?}");
        // a fill starts on the side facing the previous object
        let fill = StitchParams::Fill(FillParams { underlay: false, ..Default::default() });
        let d = doc(vec![obj("a", line([0.0, 0.0], [10.0, 0.0]), StitchParams::Running(RunningParams::default())), obj("b", square(12.0, -5.0, 20.0), fill)]);
        let plan = Engine::new().plan(&d);
        let first_b = plan.stitches.iter().find(|s| s.object == 1 && s.is_stitch()).unwrap();
        assert!(first_b.x < 17.0, "fill starts near: {first_b:?}");
    }

    #[test]
    fn knockdown_comes_first_in_its_own_colour() {
        let fill = StitchParams::Fill(FillParams { underlay: false, ..Default::default() });
        let mut d = doc(vec![obj("a", square(10.0, 10.0, 20.0), fill.clone()), obj("b", square(40.0, 10.0, 10.0), fill)]);
        d.options.knockdown = true;
        d.options.knockdown_offset = 2.0;
        d.options.knockdown_color = "#ffffff".into();
        let plan = Engine::new().plan(&d);
        // the net first, in its own thread, then a colour change to the design
        assert_eq!(plan.threads[0].color, "#ffffff");
        assert_eq!(plan.threads.len(), 2);
        assert_eq!(count(&plan, flags::COLOR_CHANGE), 1);
        let net: Vec<_> = plan.stitches.iter().take_while(|s| !s.is(flags::COLOR_CHANGE)).filter(|s| s.is_stitch()).collect();
        assert!(net.iter().all(|s| s.object == u32::MAX));
        assert!(net.len() > 50, "{} stitches", net.len());
        // it reaches beyond the design (2 mm) and covers both objects
        let (minx, maxx) = net.iter().fold((f64::MAX, f64::MIN), |(a, b), s| (a.min(s.x), b.max(s.x)));
        assert!(minx < 9.0 && minx > 7.0 && maxx > 50.5, "{minx} {maxx}");
        // the trim before the colour change is not doubled
        let i = plan.stitches.iter().position(|s| s.is(flags::COLOR_CHANGE)).unwrap();
        assert!(!(plan.stitches[i - 1].is(flags::TRIM) && plan.stitches[i - 2].is(flags::TRIM)));
        // auto underlay is lighter on top of it: edge runs only
        let auto = StitchParams::Fill(FillParams { underlay_auto: true, ..Default::default() });
        let mut d2 = doc(vec![obj("a", square(10.0, 10.0, 30.0), auto)]);
        let ul = |d: &Document| Engine::new().plan(d).stitches.iter().filter(|s| s.is(flags::UNDERLAY)).count();
        let without = ul(&d2);
        d2.options.knockdown = true;
        assert!(ul(&d2) * 2 < without, "{} vs {}", ul(&d2), without);
    }

    #[test]
    fn basting_box_comes_first() {
        let mut d = doc(vec![obj("a", square(10.0, 10.0, 20.0), StitchParams::Running(RunningParams::default()))]);
        d.options.basting = Basting::Box;
        d.options.basting_margin = 5.0;
        let plan = Engine::new().plan(&d);
        let first = plan.stitches.iter().find(|s| s.is_stitch()).unwrap();
        assert_eq!(first.object, u32::MAX);
        assert!((first.x - 5.0).abs() < 0.01 && (first.y - 5.0).abs() < 0.01, "{first:?}");
        assert!(count(&plan, flags::TRIM) >= 2);
    }

    #[test]
    fn basting_contour_hugs_the_design() {
        let mut d = doc(vec![obj("a", square(0.0, 0.0, 20.0), StitchParams::Fill(FillParams::default()))]);
        d.options.basting = Basting::Contour;
        d.options.basting_margin = 3.0;
        let plan = Engine::new().plan(&d);
        let bast: Vec<_> = plan.stitches.iter().filter(|s| s.object == u32::MAX && s.is_stitch()).collect();
        assert!(bast.len() > 10);
        for s in bast.iter().filter(|s| !s.is(flags::TIE)) {
            let dx = (s.x - 10.0).abs() - 10.0;
            let dy = (s.y - 10.0).abs() - 10.0;
            let d = dx.max(dy);
            assert!(d > 2.0 && d < 4.0, "basting {} mm from the edge", d);
        }
    }

    #[test]
    fn an_objects_min_jump_sews_through_short_gaps() {
        let run = StitchParams::Running(RunningParams::default());
        let line = |x: f64| vec![SubPath::polyline(&[pt(x, 0.0), pt(x + 10.0, 0.0)], false)];
        let mut d = doc(vec![obj("a", line(0.0), run.clone()), obj("b", line(15.0), run)]);
        d.machine.trim_distance = 3.0;
        let base = count(&Engine::new().plan(&d), flags::TRIM);
        d.objects[0].min_jump = Some(8.0);
        assert_eq!(count(&Engine::new().plan(&d), flags::TRIM), base - 1, "the first object's 8 mm minimum jump sews through the 5 mm gap");
        d.objects[0].min_jump = None;
        d.objects[1].min_jump = Some(8.0);
        assert_eq!(count(&Engine::new().plan(&d), flags::TRIM), base, "the limit of the object before the gap counts");
    }

    #[test]
    fn an_objects_min_stitch_drops_short_stitches() {
        let run = StitchParams::Running(RunningParams { length: 1.0, ..Default::default() });
        let mut d = doc(vec![obj("a", vec![SubPath::polyline(&[pt(0.0, 0.0), pt(20.0, 0.0)], false)], run)]);
        let n = |d: &Document| Engine::new().plan(d).stitches.iter().filter(|s| s.is_stitch() && !s.is(flags::TIE)).count();
        let all = n(&d);
        d.objects[0].min_stitch = Some(1.5);
        assert!(n(&d) < all * 2 / 3, "1 mm stitches dropped below a 1.5 mm minimum: {} of {all}", n(&d));
    }
}

#[cfg(test)]
mod trim_tests {
    use super::*;
    use crate::model::*;

    fn line(id: &str, thread: &str, pts: &[(f64, f64)]) -> Object {
        let p: Vec<Point> = pts.iter().map(|&(x, y)| pt(x, y)).collect();
        Object {
            id: id.into(),
            name: id.into(),
            thread: thread.into(),
            visible: true,
            locked: false,
            paths: vec![SubPath::polyline(&p, false)],
            stitch: StitchParams::Running(RunningParams::default()),
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
        }
    }
    fn thread(id: &str, color: &str) -> Thread {
        Thread { id: id.into(), name: id.into(), color: color.into(), brand: "".into(), code: "".into(), weight: None }
    }
    fn plan(objects: Vec<Object>) -> StitchPlan {
        let d = Document { threads: vec![thread("a", "#000000"), thread("b", "#ff0000")], objects, ..Default::default() };
        crate::Engine::new().plan(&d)
    }
    fn trims(p: &StitchPlan) -> usize {
        p.stitches.iter().filter(|s| s.is(flags::TRIM)).count()
    }

    #[test]
    fn a_colour_change_cuts_without_a_trim_of_its_own() {
        // the machine trims at a colour change (Ink/Stitch writes no trim there)
        let p = plan(vec![line("1", "a", &[(0.0, 0.0), (20.0, 0.0)]), line("2", "b", &[(0.0, 10.0), (20.0, 10.0)])]);
        let cc = p.stitches.iter().position(|s| s.is(flags::COLOR_CHANGE)).unwrap();
        assert!(!p.stitches[cc - 1].is(flags::TRIM), "no trim right before the colour change");
        // tied off before it, tied in after it
        assert!(p.stitches[cc - 1].is(flags::TIE) && p.stitches[cc - 2].is(flags::TIE));
        let next = cc + p.stitches[cc..].iter().position(|s| s.is_stitch()).unwrap();
        assert!(p.stitches[next + 1].is(flags::TIE), "tie-in after the colour change");
        // only the end trims
        assert_eq!(trims(&p), 1);
    }

    #[test]
    fn a_visible_connection_over_2_mm_is_trimmed() {
        // 2.5 mm across bare fabric to the next object: cut
        let open = plan(vec![line("1", "a", &[(0.0, 0.0), (20.0, 0.0)]), line("2", "a", &[(22.5, 0.0), (40.0, 0.0)])]);
        assert_eq!(trims(&open), 2, "a trim between the lines, and the end");
        // 1.5 mm: sewn through
        let short = plan(vec![line("1", "a", &[(0.0, 0.0), (20.0, 0.0)]), line("2", "a", &[(21.5, 0.0), (40.0, 0.0)])]);
        assert_eq!(trims(&short), 1);
        // 2.5 mm, but the next line runs back over it: hidden, sewn through
        let covered = plan(vec![line("1", "a", &[(0.0, 0.0), (20.0, 0.0)]), line("2", "a", &[(22.5, 0.0), (15.0, 0.0), (15.0, 10.0)])]);
        assert_eq!(trims(&covered), 1);
        // an object's own minimum jump wins
        let mut first = line("1", "a", &[(0.0, 0.0), (20.0, 0.0)]);
        first.min_jump = Some(3.0);
        let set = plan(vec![first, line("2", "a", &[(22.5, 0.0), (40.0, 0.0)])]);
        assert_eq!(trims(&set), 1);
    }
}
