//! Turn a document into a machine stitch plan: generate every object (with a
//! per-object cache), apply the design options (hidden-stitch removal,
//! basting), then connect runs with lock stitches, trims, jumps, stops and
//! colour changes.

use std::borrow::Cow;
use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};

use crate::geom::{point_in_ring, pt, Point, Rect, Ring};
use crate::model::{thread_density_scale, Basting, CoverMode, DesignOptions, Document, Fabric, FillMethod, LockOverride, MachineSettings, Object, ObjectLink, StitchParams, SubPath, Thread, Ties};
use crate::plan::{flags, Connection, ConnectionKind, Stitch, StitchPlan};
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
        self.runs_from(obj, doc, true)
    }

    /// `pinned`: the object's start point is the user's own, not just where
    /// the previous object ended.
    fn runs_from(&mut self, obj: &Object, doc: &Document, pinned: bool) -> Vec<Run> {
        let (fabric, weight) = (doc.fabric, doc.thread(&obj.thread).and_then(|t| t.weight).unwrap_or(doc.options.thread_weight));
        crate::prof!("runs_for (incl. generate)");
        let pinned = pinned || obj.start.is_none();
        let json = {
            crate::prof!("runs_for: json key");
            // everything stitches::generate reads, stitch patterns included
            serde_json::to_string(&(&obj.paths, &obj.stitch, &obj.start, &obj.end, &obj.patterns, pinned)).unwrap_or_default()
        };
        let (knockdown, avoid_holes) = (doc.options.knockdown, doc.options.avoid_holes);
        let k = key(&json, fabric, weight) ^ (knockdown as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15) ^ (avoid_holes as u64).wrapping_mul(0xC2B2_AE3D_27D4_EB4F);
        if let Some(r) = self.cache.get(&k) {
            return r.clone();
        }
        let mut profile = fabric.profile();
        profile.density_scale *= thread_density_scale(weight);
        profile.knockdown = knockdown;
        stitches::fill::START_PINNED.with(|c| c.set(pinned));
        let mut r = stitches::generate(obj, &profile);
        stitches::fill::START_PINNED.with(|c| c.set(true));
        if avoid_holes {
            stitches::holes::avoid_own_holes(&mut r);
        }
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

    /// Runs of an object as the plan sews it: `obj.start` may be where the
    /// previous object ended (`pinned` false) rather than the user's own pin.
    pub fn runs_as_sewn(&mut self, doc: &Document, obj: &Object, pinned: bool) -> Vec<Run> {
        self.runs_from(obj, doc, pinned).into_iter().filter(|r| !r.is_empty()).collect()
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
        // a line the next line (a satin column or running line in the same
        // thread) sews over right away is its way there, under it (a routed
        // underpath): taking it out would leave a jump and a trim in its place
        let next = (i + 1..doc.objects.len()).find(|&j| doc.objects[j].visible);
        let underpath = |j: usize| {
            lines && Some(j) == next && matches!(doc.objects[j].stitch, StitchParams::Satin(_) | StitchParams::Running(_)) && doc.same_spool(&obj.thread, &doc.objects[j].thread)
        };
        for j in i + 1..doc.objects.len() {
            if underpath(j) || !(scan.may_cover(doc, j) && scan.bounds(doc, j).intersects(&b)) {
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
            let pinned = obj.start.is_some();
            let obj = match (obj.start, prev) {
                (None, Some(p)) if starts_near(&obj.stitch) => {
                    let mut o = obj.into_owned();
                    o.start = Some([(p.x * 2.0).round() / 2.0, (p.y * 2.0).round() / 2.0]);
                    Cow::Owned(o)
                }
                _ => obj,
            };
            let mut runs: Vec<Run> = self.runs_from(&obj, doc, pinned).into_iter().filter(|r| !r.is_empty()).collect();
            if keep_under {
                let full = Object { start: obj.start, ..doc.objects[i].clone() };
                let (under, _) = split_underlay(self.runs_from(&full, doc, pinned));
                let (_, top) = split_underlay(runs);
                runs = splice_underlay(&full, under, top);
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
        let basting = prefix.iter().filter(|r| !r.is_empty()).count();
        let knock = knockdown_runs(doc, &items);
        let thread = (!knock.is_empty()).then(|| knockdown_thread(doc));
        prefix.extend(knock);
        assemble_basted(doc, &items, &prefix, thread, basting)
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

/// The full underlay of a fill and the top stitching of what's left of it
/// ("keep underlay"), sewn as one: the clipped fill's own way from its
/// (clipped) underlay to the top goes, and the needle travels from the end
/// of the full underlay to the first top stitch inside the full shape,
/// under the stitching to come — no tie-off, trim and jump inside the object.
fn splice_underlay(full: &Object, mut under: Vec<Run>, mut top: Vec<Run>) -> Vec<Run> {
    under.retain(|r| !r.is_empty());
    if under.is_empty() {
        return top.into_iter().filter(|r| !r.is_empty()).collect();
    }
    // the clipped fill's travel from its own underlay's end
    if let Some(first) = top.first_mut() {
        let lead = first.iter().take_while(|s| s.1 & flags::TRAVEL != 0).count();
        if lead < first.len() {
            first.drain(..lead);
        }
    }
    top.retain(|r| !r.is_empty());
    let (Some(last), Some(first)) = (under.last_mut(), top.first()) else { return under.into_iter().chain(top).collect() };
    let (a, b) = (last[last.len() - 1].0, first[0].0);
    let travel = match &full.stitch {
        StitchParams::Fill(f) => f.travel_length,
        _ => 3.0,
    };
    let rings = fill_rings(&full.paths);
    if let Some(path) = crate::stitches::fill::travel_path(&rings, a, b) {
        for q in running_stitch(&path, travel.max(0.5), 0.1).into_iter().skip(1) {
            if last.last().is_some_and(|s| s.0.dist(q) < 1e-6) {
                continue;
            }
            last.push((q, flags::TRAVEL));
        }
        let mut it = top.into_iter();
        let first = it.next().unwrap_or_default();
        for s in first {
            if last.last().is_some_and(|x| x.0.dist(s.0) < 1e-6) {
                continue;
            }
            last.push(s);
        }
        under.extend(it);
        return under;
    }
    under.into_iter().chain(top).collect()
}

/// Stitch types that start where they are told (running, satins, fills).
pub(crate) fn starts_near(st: &StitchParams) -> bool {
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
/// A connection sewn through by hand (`ObjectLink::Join`) is sewn in running
/// stitches this long at most (mm).
const JOIN_STITCH: f64 = 2.5;
/// Hidden travel (`DesignOptions::hidden_travel`): a gap up to this long that
/// what is sewn later covers all along is sewn through instead of trimmed (mm).
const HIDDEN_TRAVEL: f64 = 12.0;

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
    /// The object's own lock stitches (what it leaves out: the machine's),
    /// and those of the object sewn before (its tie-off is its own).
    lock: LockOverride,
    prev_lock: LockOverride,
    /// The object the last stitches belong to (its tie-off is its own).
    last_obj: u32,
    /// The current object's minimum stitch and jump (mm), and the jump
    /// limit of the object sewn last: a longer gap after it is locked and trimmed.
    min_stitch: f64,
    /// A running stitch: a short stitch at a turn may go too, when the
    /// stitch past it stays within half a thread of it (see `redundant`).
    loose_turns: bool,
    min_jump: f64,
    last_min_jump: f64,
    /// The current object's and the last object's jump limit were set on the
    /// object (they win over the visible-connection trim).
    min_jump_set: bool,
    last_min_jump_set: bool,
    /// Sew through a longer gap that later stitching covers (`DesignOptions::hidden_travel`).
    hidden_travel: bool,
    /// The runs still to come, and the index among them of the run being sewn.
    ahead: Ahead<'a>,
    at: usize,
    /// The current object's link to the next one, and that of the object sewn last.
    link: Option<ObjectLink>,
    last_link: Option<ObjectLink>,
    /// Where the object sewn last ended (before any lock), and what was
    /// already decided after it (a colour change, a trim or stop set by hand,
    /// a forced lock) and whether by hand.
    end_pos: Option<Point>,
    pending: Option<(ConnectionKind, bool)>,
    /// The connections between consecutive objects, for the plan.
    links: Vec<Connection>,
}

impl Builder<'_> {
    /// The end lock at `at`, along the stitches sewn before it.
    fn tie_off(&mut self, at: Point, o: u32) {
        if !matches!(self.prev_ties, Ties::Both | Ties::End) {
            return;
        }
        let behind: Vec<Point> = self.out.iter().rev().filter(|s| s.is_stitch()).take(20).map(|s| s.pos()).collect();
        let behind = if behind.first().is_some_and(|p| p.dist(at) < 1e-6) { behind } else { std::iter::once(at).chain(behind).collect() };
        let l = self.prev_lock;
        let (style, scale, length) = (l.end.unwrap_or(self.m.lock_end), l.end_scale.unwrap_or(self.m.lock_scale), l.end_length.unwrap_or(self.m.lock_length));
        for p in crate::locks::lock_points(style, &behind, scale, length, true) {
            self.out.push(Stitch::new(p, flags::TIE, o));
            // a shape lock (arrow, star…) ends away from the lock point:
            // the trim that follows is where the needle is
            self.pos = Some(p);
        }
    }

    /// The start lock at the run's first point, along the run.
    fn tie_in(&mut self, run: &Run, o: u32) {
        if !matches!(self.ties, Ties::Both | Ties::Start) {
            return;
        }
        let ahead: Vec<Point> = run.iter().take(20).map(|x| x.0).collect();
        let l = self.lock;
        let (style, scale, length) = (l.start.unwrap_or(self.m.lock_start), l.start_scale.unwrap_or(self.m.lock_scale), l.start_length.unwrap_or(self.m.lock_length));
        for p in crate::locks::lock_points(style, &ahead, scale, length, false) {
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

    /// Locked as before a trim, but no trim (`ObjectLink::Jump`): the jump
    /// and the next object's start lock follow in `run`.
    fn jump_cut(&mut self) {
        if let Some(p) = self.pos {
            if self.m.ties && !self.needs_tie_in {
                let owner = self.last_obj;
                self.tie_off(p, owner);
            }
        }
        self.needs_tie_in = true;
    }

    /// Tie off and trim (and stop the machine).
    fn cut(&mut self, o: u32, stop: bool, color_change: bool) {
        if let Some(p) = self.pos {
            if self.m.ties && !self.needs_tie_in {
                let owner = self.last_obj;
                self.tie_off(p, owner);
            }
            let p = self.pos.unwrap_or(p);
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
                // a connection between two objects of the design (not within one, not the basting)
                let between = o != self.last_obj && o != u32::MAX && self.last_obj != u32::MAX;
                let from = self.end_pos.unwrap_or(p);
                let (kind, manual) = match (self.needs_tie_in, if between { self.last_link } else { None }) {
                    // a colour change, a trim or stop set by hand, a forced lock: already done
                    (true, _) => self.pending.unwrap_or((ConnectionKind::Jump, false)),
                    // sewn through by hand whatever the distance: running stitches, no locks
                    (false, Some(ObjectLink::Join)) => {
                        let n = (gap / JOIN_STITCH).ceil().max(1.0) as usize;
                        for k in 1..n {
                            self.out.push(Stitch::new(p + (start - p) * (k as f64 / n as f64), 0, self.last_obj));
                        }
                        (ConnectionKind::Sew, true)
                    }
                    // a jump by hand: locked, a jump, locked; no trim
                    (false, Some(ObjectLink::Jump)) => {
                        self.jump_cut();
                        (ConnectionKind::Jump, true)
                    }
                    (false, None) => {
                        // a short connection to the next object is sewn through, unless
                        // it would show: nothing sewn later covers it
                        let shows = gap > VISIBLE_CONNECTION && o != self.last_obj && o != u32::MAX && !self.last_min_jump_set;
                        // a longer gap that what is sewn later covers all along: travel under it
                        // (branching; not in Ink/Stitch, which trims there)
                        let hidden = gap > self.last_min_jump
                            && gap <= HIDDEN_TRAVEL
                            && self.hidden_travel
                            && !self.last_min_jump_set
                            && o != u32::MAX
                            && self.last_obj != u32::MAX
                            && !self.ahead.visible(p, start, self.at);
                        if hidden {
                            let n = (gap / JOIN_STITCH).ceil().max(1.0) as usize;
                            for k in 1..n {
                                self.out.push(Stitch::new(p + (start - p) * (k as f64 / n as f64), flags::TRAVEL, self.last_obj));
                            }
                            (ConnectionKind::Sew, false)
                        } else if gap > self.last_min_jump || (shows && self.ahead.visible(p, start, self.at)) {
                            self.cut(o, false, false);
                            (ConnectionKind::Trim, false)
                        } else {
                            (ConnectionKind::Sew, false)
                        }
                    }
                };
                if between {
                    // a thread left on the fabric (sewn through or jumped): does it show?
                    let stays = matches!(kind, ConnectionKind::Sew | ConnectionKind::Jump);
                    let visible = stays && from.dist(start) > VISIBLE_STRETCH && self.ahead.visible(from, start, self.at);
                    self.links.push(Connection { from: self.last_obj, to: o, kind, manual, visible, start: [from.x, from.y], end: [start.x, start.y] });
                }
                self.pending = None;
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
            let d = q.dist(last);
            if d < 1e-6 {
                continue;
            }
            // drop too-short stitches that change nothing, but always land
            // on the run's final point and keep every turn (a fill's step to
            // its next row)
            if d < self.min_stitch && j + 1 < k && (redundant(last, q, run[j + 1].0) || self.loose_turns && f & flags::TIE == 0 && loose_turn(last, q, run[j + 1].0)) {
                continue;
            }
            self.out.push(Stitch::new(q, f, o));
            last = q;
        }
        self.pos = Some(last);
        self.end_pos = Some(last);
        self.last_link = self.link;
        self.last_obj = o;
        self.last_min_jump = self.min_jump;
        self.last_min_jump_set = self.min_jump_set;
        self.prev_ties = self.ties;
        self.prev_lock = self.lock;
    }
}

/// Ink/Stitch's own minimum stitch (`filter_duplicate_stitches`): a stitch
/// this short is a duplicate whatever the setting.
const DUPLICATE_STITCH: f64 = 0.1;
/// A short stitch is redundant when the needle passes within this of its
/// end anyway (mm).
const ON_THE_WAY: f64 = 0.05;

/// May the short stitch `last → q` go, sewing `last → next` instead? When it
/// is a duplicate (Ink/Stitch's 0.1 mm), or `q` lies on the way to `next`
/// (a short stitch along a line or a gentle curve). A turn stays: the step
/// from a fill row to the next (0.25 mm at a dense spacing) dropped would
/// start every other row with a slanted stitch — a saw-tooth edge with
/// fabric showing between the rows.
pub(crate) fn redundant(last: Point, q: Point, next: Point) -> bool {
    q.dist(last) <= DUPLICATE_STITCH || seg_dist(q, last, next) < ON_THE_WAY
}

/// How far a running stitch may cut a corner when a short stitch at a turn
/// goes (mm): about its own tolerance and half a thread's width, so a fine
/// jagged line loses its steps and a real corner stays (not in Ink/Stitch,
/// which keeps every turn). Coarse steps are for Simplify for stitching.
const LOOSE_TURN: f64 = 0.25;

/// A running stitch's short stitch at a turn (a pixel step of a traced
/// line) may go when the stitch on to `next` passes within half a thread of
/// its end. Not for fills (the step to the next row) or satins (their edge):
/// see [`redundant`].
pub(crate) fn loose_turn(last: Point, q: Point, next: Point) -> bool {
    seg_dist(q, last, next) < LOOSE_TURN
}

/// Where an object is locked: its `ties`, but manual stitch only when it
/// forces lock stitches (Ink/Stitch: manual stitch places every needle
/// drop itself, locks included).
fn object_ties(obj: &Object) -> Ties {
    match obj.stitch {
        StitchParams::Manual(_) if !obj.force_lock => Ties::None,
        _ => obj.ties,
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
    assemble_basted(doc, items, prefix, prefix_thread, 0)
}

/// [`assemble_prefixed`] whose first `basting` prefix runs are the basting:
/// the plan records where it ends.
fn assemble_basted(doc: &Document, items: &[(usize, Vec<Run>)], prefix: &[Run], prefix_thread: Option<Thread>, basting: usize) -> StitchPlan {
    let mut basting_end = None;
    let ahead = Ahead { runs: items.iter().flat_map(|(_, runs)| runs.iter()).collect(), grid: None };
    let mut b = Builder {
        m: &doc.machine,
        out: Vec::new(),
        pos: None,
        needs_tie_in: true,
        ties: Ties::Both,
        prev_ties: Ties::Both,
        lock: LockOverride::default(),
        prev_lock: LockOverride::default(),
        last_obj: u32::MAX,
        min_stitch: doc.machine.min_stitch,
        loose_turns: false,
        min_jump: doc.machine.trim_distance,
        last_min_jump: doc.machine.trim_distance,
        min_jump_set: false,
        last_min_jump_set: false,
        hidden_travel: doc.options.hidden_travel,
        ahead,
        at: 0,
        link: None,
        last_link: None,
        end_pos: None,
        pending: None,
        links: Vec::new(),
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
        let prefix: Vec<&Run> = prefix.iter().filter(|r| !r.is_empty()).collect();
        let mut cut_after_prefix = prefix_thread.is_none();
        for (k, run) in prefix.iter().enumerate() {
            b.run(run, u32::MAX);
            if k + 1 == basting {
                // the basting is pulled out after sewing: tied off and cut
                // on its own, whatever comes next (the knockdown); its tie-off
                // and trim are part of it
                if k + 1 < prefix.len() {
                    b.cut(u32::MAX, false, false);
                } else if cut_after_prefix {
                    b.cut(u32::MAX, false, false);
                    cut_after_prefix = false;
                }
                basting_end = Some(b.out.len());
            }
        }
        // in its own colour the colour change before the design trims
        if cut_after_prefix {
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
        // a layered 3D starts in its base thread
        let first_thread = crate::stitches::layered3d::start_thread(obj, doc);
        if after_prefix || cur_thread.map_or(true, |c| !doc.same_spool(c, first_thread)) {
            if cur_thread.is_some() || after_prefix {
                // the tie-off and colour change end the prefix when it has its own colour
                b.cut(if after_prefix { u32::MAX } else { o }, false, true);
                b.pending = Some((ConnectionKind::ColorChange, false));
            }
            threads.push(doc.thread(first_thread).cloned().unwrap_or_else(|| fallback_thread(threads.len())));
            cur_thread = Some(first_thread);
        }
        b.ties = object_ties(obj);
        b.lock = obj.lock.unwrap_or_default();
        b.min_stitch = obj.min_stitch.unwrap_or(doc.machine.min_stitch).max(0.0);
        b.loose_turns = matches!(&obj.stitch, StitchParams::Running(p) if p.beans().iter().all(|r| *r == 0));
        b.min_jump = obj.min_jump.unwrap_or(doc.machine.trim_distance).max(0.0);
        b.min_jump_set = obj.min_jump.is_some();
        b.link = obj.link;
        for run in runs {
            b.at = at;
            at += 1;
            if crate::stitches::layered3d::is_thread_switch(run) {
                // a layered 3D's top layer in the object's own thread
                if cur_thread.map_or(true, |c| !doc.same_spool(c, &obj.thread)) {
                    b.cut(o, false, true);
                    b.pending = Some((ConnectionKind::ColorChange, false));
                    threads.push(doc.thread(&obj.thread).cloned().unwrap_or_else(|| fallback_thread(threads.len())));
                    cur_thread = Some(obj.thread.as_str());
                }
                continue;
            }
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
            b.pending = Some((ConnectionKind::Trim, true));
        } else if obj.force_lock && !is_last {
            b.force_lock(o);
            b.pending = Some((ConnectionKind::Jump, false));
        }
    }
    if let Some(p) = b.pos {
        if b.m.ties && !b.needs_tie_in {
            let owner = b.last_obj;
            b.tie_off(p, owner);
        }
        let p = b.pos.unwrap_or(p);
        b.out.push(Stitch::new(p, flags::TRIM, u32::MAX));
        b.out.push(Stitch::new(p, flags::END, u32::MAX));
    }
    StitchPlan { stitches: b.out, threads, basting: basting_end.map(|e| (0, e)), links: b.links }
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
            lock: None,
            color_sort_index: None,
            link: None,
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
        // (61 % of the area: the frame's four sections turn twice as often)
        assert!(clipped < full * 85 / 100, "{clipped} vs {full}");
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
        // underlay stitches well under the 25 mm cover
        let ul = |d: &Document| {
            let under = |s: &&Stitch| s.x > 3.0 && s.x < 22.0 && s.y > 3.0 && s.y < 22.0;
            Engine::new().plan(d).stitches.iter().filter(|s| s.object == 0 && s.is_stitch() && s.flags & flags::UNDERLAY != 0).filter(under).count()
        };
        let cut = ul(&d);
        d.options.keep_underlay = true;
        let kept = ul(&d);
        assert!(cut == 0 && kept > 50, "the underlay under the cover stays: {kept} vs {cut}");
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
    fn a_start_point_set_turns_a_one_way_fill_round() {
        // the previous line ends low: the fill still sews from its top row down
        let line = vec![SubPath::polyline(&[pt(0.0, 0.0), pt(10.0, 20.0)], false)];
        let run = StitchParams::Running(RunningParams::default());
        let fill = StitchParams::Fill(FillParams { underlay: false, ..Default::default() });
        let first_of = |d: &Document| *Engine::new().plan(d).stitches.iter().find(|s| s.object == 1 && s.is_stitch()).unwrap();
        let d = doc(vec![obj("a", line.clone(), run.clone()), obj("b", square(12.0, 0.0, 20.0), fill.clone())]);
        let s = first_of(&d);
        assert!(s.y < 2.0, "near the last object, top row first: {s:?}");
        // a start pin at the bottom: it begins there
        let mut b = obj("b", square(12.0, 0.0, 20.0), fill);
        b.start = Some([30.0, 19.0]);
        let s = first_of(&doc(vec![obj("a", line, run), b]));
        assert!(s.y > 18.0 && s.x > 28.0, "starts at the pin: {s:?}");
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

    #[test]
    fn a_running_stitch_loses_its_pixel_steps_under_the_minimum() {
        // a 0.3 mm pixel staircase along a 30° line: every step is a corner the running stitch keeps
        let mut st = vec![pt(0.0, 0.0)];
        let (mut x, mut y) = (0.0, 0.0);
        while x < 30.0 {
            x += 0.3;
            st.push(pt(x, y));
            if y + 0.3 <= x * 0.577 {
                y += 0.3;
                st.push(pt(x, y));
            }
        }
        let mut d = doc(vec![obj("a", vec![SubPath::polyline(&st, false)], StitchParams::Running(RunningParams::default()))]);
        let short = |d: &Document| {
            let s: Vec<Point> = Engine::new().plan(d).stitches.iter().filter(|s| s.is_stitch() && !s.is(flags::TIE)).map(|s| s.pos()).collect();
            s.windows(2).filter(|w| w[0].dist(w[1]) < 0.6).count()
        };
        let before = short(&d);
        assert!(before > 20, "{before}");
        d.machine.min_stitch = 0.6;
        assert!(short(&d) * 4 <= before, "{} short stitches left of {before}", short(&d));
        // a real corner stays: an L of two 10 mm legs
        let mut l = doc(vec![obj("l", vec![SubPath::polyline(&[pt(0.0, 0.0), pt(10.0, 0.0), pt(10.0, 10.0)], false)], StitchParams::Running(RunningParams::default()))]);
        l.machine.min_stitch = 0.6;
        assert!(Engine::new().plan(&l).stitches.iter().any(|s| s.pos().dist(pt(10.0, 0.0)) < 1e-6), "the corner of the L is sewn");
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
            lock: None,
            color_sort_index: None,
            link: None,
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
    fn a_gap_that_a_later_fill_covers_is_travelled_not_trimmed() {
        // two lines 8 mm apart in one thread, then a fill in another thread over both and the gap
        let cover = || {
            let mut f = line("f", "b", &[(-2.0, 0.0), (32.0, 0.0), (32.0, 10.0), (-2.0, 10.0)]);
            f.paths[0].closed = true;
            f.stitch = StitchParams::Fill(FillParams::default());
            f
        };
        let lines = || vec![line("1", "a", &[(0.0, 5.0), (10.0, 5.0)]), line("2", "a", &[(18.0, 5.0), (30.0, 5.0)])];
        let with = |objs: Vec<Object>, hidden: bool| {
            let mut d = Document { threads: vec![thread("a", "#000000"), thread("b", "#ff0000")], objects: objs, ..Default::default() };
            d.options.hidden_travel = hidden;
            crate::Engine::new().plan(&d)
        };
        let covered = with([lines(), vec![cover()]].concat(), true);
        let trimmed = with([lines(), vec![cover()]].concat(), false);
        assert_eq!(trims(&covered) + 1, trims(&trimmed), "the 8 mm gap under the fill is travelled");
        let link = covered.links.iter().find(|c| c.from == 0).unwrap();
        assert!(link.kind == ConnectionKind::Sew && !link.visible, "{link:?}");
        // the travel's stitches are at most 2.5 mm and flagged as travel
        let travel: Vec<&Stitch> = covered.stitches.iter().filter(|s| s.object == 0 && s.is(flags::TRAVEL)).collect();
        assert!(!travel.is_empty() && travel.iter().all(|s| s.y == 5.0 && s.x > 10.0 && s.x < 18.0), "{travel:?}");
        // nothing over the gap: trimmed as before
        assert_eq!(trims(&with(lines(), true)), trims(&with(lines(), false)));
        // longer than 12 mm: trimmed even under the fill
        let far = vec![line("1", "a", &[(0.0, 5.0), (5.0, 5.0)]), line("2", "a", &[(20.0, 5.0), (30.0, 5.0)]), cover()];
        assert_eq!(trims(&with(far.clone(), true)), trims(&with(far, false)));
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
    /// Every command record (trim, stop, colour change, end) sits where the needle is.
    fn commands_at_the_needle(p: &StitchPlan) {
        let mut cur: Option<Point> = None;
        for (k, s) in p.stitches.iter().enumerate() {
            if s.flags & (flags::TRIM | flags::STOP | flags::COLOR_CHANGE | flags::END) != 0 {
                let c = cur.expect("a command before any stitch");
                assert!(c.dist(s.pos()) < 1e-9, "record {k} ({:#x}) at {:?}, the needle at {c:?}", s.flags, s.pos());
            } else {
                cur = Some(s.pos());
            }
        }
    }

    #[test]
    fn the_trim_after_a_shape_lock_is_at_the_needle() {
        for style in [LockStyle::Arrow, LockStyle::Star, LockStyle::Zigzag, LockStyle::HalfStitch, LockStyle::BackForth] {
            let d = Document {
                threads: vec![thread("a", "#000000"), thread("b", "#ff0000")],
                objects: vec![line("1", "a", &[(55.0, 0.0), (0.0, 0.0)]), line("2", "a", &[(0.0, 30.0), (55.0, 30.0)]), line("3", "b", &[(0.0, 60.0), (55.0, 60.0)])],
                machine: MachineSettings { lock_end: style, ..Default::default() },
                ..Default::default()
            };
            let p = crate::Engine::new().plan(&d);
            commands_at_the_needle(&p);
            assert_eq!(trims(&p), 2, "{style:?}");
        }
    }

    #[test]
    fn the_plan_knows_where_the_basting_ends() {
        let objects = vec![line("1", "a", &[(0.0, 0.0), (20.0, 0.0)])];
        assert_eq!(plan(objects.clone()).basting, None, "no basting");
        let d = Document {
            threads: vec![thread("a", "#000000")],
            objects,
            options: DesignOptions { basting: Basting::Box, ..Default::default() },
            ..Default::default()
        };
        let p = crate::Engine::new().plan(&d);
        let (a, b) = p.basting.expect("basting");
        assert_eq!(a, 0);
        // the basting has no object; the line's stitches come after it
        assert!(p.stitches[a..b].iter().all(|s| s.object == u32::MAX));
        assert!(p.stitches[b..].iter().any(|s| s.object == 0 && s.is_stitch()));
        assert!(p.stitches[a..b].iter().filter(|s| s.is_stitch()).count() > 10, "the box around the design");
        // nothing follows it in the prefix: its tie-off and trim are still its own
        assert!(p.stitches[a..b].iter().any(|s| s.is(flags::TRIM)), "the basting ends cut");
        assert!(!p.stitches[b..].iter().take_while(|s| !s.is_stitch()).any(|s| s.is(flags::TRIM)), "no second trim after it");
    }
}

/// The object's `link` to the next one (Trim / Jump / Sew chosen by hand)
/// and the connections the plan reports to the editor.
#[cfg(test)]
mod link_tests {
    use super::*;
    use crate::geom::pt;
    use crate::model::*;
    use crate::Engine;

    fn line(id: &str, thread: &str, a: [f64; 2], b: [f64; 2]) -> Object {
        let mut o: Object = serde_json::from_value(serde_json::json!({ "id": id, "name": id, "thread": thread, "paths": [], "stitch": { "type": "running" } })).unwrap();
        o.paths = vec![SubPath::polyline(&[pt(a[0], a[1]), pt(b[0], b[1])], false)];
        o
    }
    fn fill(id: &str, x: f64, y: f64, s: f64) -> Object {
        let mut o = line(id, "t", [0.0, 0.0], [1.0, 0.0]);
        o.paths = vec![SubPath::polyline(&[pt(x, y), pt(x + s, y), pt(x + s, y + s), pt(x, y + s)], true)];
        o.stitch = StitchParams::Fill(FillParams { underlay: false, ..Default::default() });
        o
    }
    fn doc(objects: Vec<Object>) -> Document {
        let th = |id: &str, c: &str| Thread { id: id.into(), name: id.into(), color: c.into(), brand: "".into(), code: "".into(), weight: None };
        Document { threads: vec![th("t", "#000000"), th("u", "#cc1219")], objects, ..Default::default() }
    }
    /// Two lines 10 mm apart on one row: a ends at (30, 0), b starts at (40, 0).
    fn pair(link: Option<ObjectLink>, b_thread: &str) -> Document {
        let mut a = line("a", "t", [0.0, 0.0], [30.0, 0.0]);
        a.link = link;
        doc(vec![a, line("b", b_thread, [40.0, 0.0], [70.0, 0.0])])
    }
    fn count(plan: &StitchPlan, f: u8) -> usize {
        plan.stitches.iter().filter(|s| s.is(f)).count()
    }
    /// The records from a's last stitch at (30, 0) to b's first at (40, 0).
    fn between(plan: &StitchPlan) -> Vec<Stitch> {
        let s = &plan.stitches;
        let i = s.iter().rposition(|x| x.object == 0 && x.is_stitch() && (x.x - 30.0).abs() < 1e-6).unwrap();
        let j = s.iter().position(|x| x.object == 1 && x.is_stitch() && (x.x - 40.0).abs() < 1e-6).unwrap();
        s[i..=j].to_vec()
    }

    #[test]
    fn link_is_absent_unless_chosen() {
        let o = line("a", "t", [0.0, 0.0], [1.0, 0.0]);
        assert_eq!(o.link, None);
        assert!(serde_json::to_value(&o).unwrap().get("link").is_none(), "absent stays absent");
        for (s, l) in [("join", ObjectLink::Join), ("jump", ObjectLink::Jump)] {
            let j: Object = serde_json::from_value(serde_json::json!({ "id": "x", "name": "x", "thread": "t", "paths": [], "link": s })).unwrap();
            assert_eq!(j.link, Some(l));
        }
    }

    #[test]
    fn automatic_trims_a_long_gap() {
        let plan = Engine::new().plan(&pair(None, "t"));
        assert_eq!(count(&plan, flags::TRIM), 2, "a trim between the two and the final one");
    }

    #[test]
    fn join_sews_through_whatever_the_distance() {
        let plan = Engine::new().plan(&pair(Some(ObjectLink::Join), "t"));
        assert_eq!(count(&plan, flags::TRIM), 1, "only the final trim");
        let mid = between(&plan);
        assert!(mid.iter().all(|s| s.flags == 0), "no jump, trim or lock stitches between: {mid:?}");
        assert!(mid.windows(2).all(|w| w[0].pos().dist(w[1].pos()) <= JOIN_STITCH + 1e-9), "running stitches of 2.5 mm at most");
        assert!(mid.len() >= 5, "10 mm in stitches of 2.5 mm: {}", mid.len());
    }

    #[test]
    fn jump_skips_the_trim_and_keeps_the_locks() {
        let auto = Engine::new().plan(&pair(None, "t"));
        let plan = Engine::new().plan(&pair(Some(ObjectLink::Jump), "t"));
        assert_eq!(count(&plan, flags::TRIM), 1, "no trim after a, only the final one");
        assert!(plan.stitches.iter().any(|s| s.is(flags::JUMP) && (s.x - 40.0).abs() < 1e-6), "a jump to b's start");
        assert_eq!(count(&plan, flags::TIE), count(&auto, flags::TIE), "the locks of a trim: a's tie-off, b's tie-in");
    }

    #[test]
    fn a_colour_change_wins_over_link() {
        for link in [ObjectLink::Join, ObjectLink::Jump] {
            let plan = Engine::new().plan(&pair(Some(link), "u"));
            assert_eq!(count(&plan, flags::COLOR_CHANGE), 1, "{link:?}: the colour changes");
            assert!(between(&plan).iter().any(|s| s.is(flags::JUMP)), "{link:?}: nothing sewn between the colours");
            assert_eq!(plan.links[0].kind, ConnectionKind::ColorChange);
        }
    }

    #[test]
    fn trim_after_wins_over_link() {
        let mut d = pair(Some(ObjectLink::Join), "t");
        d.objects[0].trim_after = true;
        let plan = Engine::new().plan(&d);
        assert_eq!(count(&plan, flags::TRIM), 2);
        assert_eq!((plan.links[0].kind, plan.links[0].manual), (ConnectionKind::Trim, true));
    }

    #[test]
    fn the_plan_reports_each_connection() {
        let kind = |d: &Document| {
            let p = Engine::new().plan(d);
            assert_eq!(p.links.len(), 1, "one connection between two objects");
            (p.links[0].kind, p.links[0].manual, p.links[0].visible, p.links[0].from, p.links[0].to)
        };
        assert_eq!(kind(&pair(None, "t")), (ConnectionKind::Trim, false, false, 0, 1), "automatic: a trim (nothing stays)");
        assert_eq!(kind(&pair(Some(ObjectLink::Join), "t")), (ConnectionKind::Sew, true, true, 0, 1), "sewn by hand, and it shows (nothing covers it)");
        assert_eq!(kind(&pair(Some(ObjectLink::Jump), "t")), (ConnectionKind::Jump, true, true, 0, 1));
        // a short gap is sewn through: automatic, and too short to show
        let near = doc(vec![line("a", "t", [0.0, 0.0], [30.0, 0.0]), line("b", "t", [30.8, 0.0], [60.0, 0.0])]);
        assert_eq!(kind(&near), (ConnectionKind::Sew, false, false, 0, 1));
        // sewn by hand under a fill sewn later: it doesn't show
        let mut a = line("a", "t", [0.0, 0.0], [30.0, 0.0]);
        a.link = Some(ObjectLink::Join);
        let covered = Engine::new().plan(&doc(vec![a, line("b", "t", [40.0, 0.0], [70.0, 0.0]), fill("c", 28.0, -3.0, 14.0)]));
        assert!(!covered.links[0].visible, "covered by c: {:?}", covered.links[0]);
        let p = &covered.links[0];
        assert!((p.start[0] - 30.0).abs() < 1e-6 && (p.end[0] - 40.0).abs() < 1e-6, "from a's end to b's start: {p:?}");
    }
}
