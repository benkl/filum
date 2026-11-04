//! Document model shared by the engine, the file formats and the UI (via JSON).
//!
//! Everything is in millimetres, y pointing down. Serialized as camelCase JSON.

use serde::{Deserialize, Serialize};

use crate::geom::{pt, Point, Rect};

/// A cubic-bezier node: anchor plus optional absolute in/out handles.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Node {
    pub p: [f64; 2],
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub i: Option<[f64; 2]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub o: Option<[f64; 2]>,
}

impl Node {
    pub fn corner(x: f64, y: f64) -> Node {
        Node { p: [x, y], i: None, o: None }
    }
    pub fn point(&self) -> Point {
        Point::from_arr(self.p)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct SubPath {
    pub nodes: Vec<Node>,
    #[serde(default)]
    pub closed: bool,
}

impl SubPath {
    pub fn polyline(points: &[Point], closed: bool) -> SubPath {
        SubPath { nodes: points.iter().map(|p| Node::corner(p.x, p.y)).collect(), closed }
    }

    /// Flatten beziers into a polyline (closed paths repeat the first point at the end).
    pub fn flatten(&self, tolerance: f64) -> Vec<Point> {
        let n = self.nodes.len();
        let mut out = Vec::new();
        if n == 0 {
            return out;
        }
        out.push(self.nodes[0].point());
        let seg_count = if self.closed { n } else { n - 1 };
        for s in 0..seg_count {
            let a = &self.nodes[s];
            let b = &self.nodes[(s + 1) % n];
            if a.o.is_none() && b.i.is_none() {
                out.push(b.point());
                continue;
            }
            let p0 = a.point();
            let p3 = b.point();
            let p1 = a.o.map(Point::from_arr).unwrap_or(p0);
            let p2 = b.i.map(Point::from_arr).unwrap_or(p3);
            let cubic = kurbo::CubicBez::new(
                kurbo::Point::new(p0.x, p0.y),
                kurbo::Point::new(p1.x, p1.y),
                kurbo::Point::new(p2.x, p2.y),
                kurbo::Point::new(p3.x, p3.y),
            );
            let mut path = kurbo::BezPath::new();
            path.move_to(cubic.p0);
            path.curve_to(cubic.p1, cubic.p2, cubic.p3);
            let mut first = true;
            kurbo::flatten(path, tolerance.max(0.005), |el| {
                if let kurbo::PathEl::LineTo(p) = el {
                    out.push(pt(p.x, p.y));
                } else if let kurbo::PathEl::MoveTo(_) = el {
                    first = false;
                }
            });
            let _ = first;
        }
        out.dedup_by(|b, a| (a.x - b.x).abs() < 1e-9 && (a.y - b.y).abs() < 1e-9);
        out
    }

    pub fn transform(&mut self, f: &impl Fn(Point) -> Point) {
        for n in &mut self.nodes {
            n.p = f(Point::from_arr(n.p)).arr();
            if let Some(i) = n.i {
                n.i = Some(f(Point::from_arr(i)).arr());
            }
            if let Some(o) = n.o {
                n.o = Some(f(Point::from_arr(o)).arr());
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Stitch parameters
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RunningParams {
    /// Stitch length (mm).
    pub length: f64,
    /// Curve tolerance (mm) for the sleeve fitting algorithm.
    pub tolerance: f64,
    /// Number of passes along the path (1 = single, 2 = there and back, ...).
    pub repeats: u32,
    /// Bean stitch: each stitch is repeated this many extra times back and forth (0, 2, 4..).
    pub bean_repeats: u32,
    /// Ripple stitch (Ink/Stitch): the line is repeated as ripples.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ripple: Option<RippleParams>,
    /// Stem stitch: slanted stitches that overlap by half — a rope.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stem: Option<StemParams>,
    /// Motif run: a small pattern repeated along the line.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub motif: Option<MotifParams>,
    /// Zig-zag line (Ink/Stitch `stroke_method=zigzag_stitch`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub zigzag: Option<ZigzagParams>,
    /// Several stitch lengths used in turn (Ink/Stitch "2 1"); overrides
    /// `length` when set.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub length_pattern: Vec<f64>,
    /// Bean repeats per stitch in turn (passes, like `bean_repeats`);
    /// overrides `bean_repeats` when set.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub bean_pattern: Vec<u32>,
    /// Random stitch length: each stitch varies by up to this % (0 = even
    /// stitches). Ink/Stitch `random_stitch_length_jitter_percent`.
    pub random_length: f64,
    pub random_seed: u32,
    /// Cutwork: the needle (knife, 1–4) that cuts this line, 0 = none.
    /// Ink/Stitch `cutwork_needle`.
    pub cutwork_needle: u32,
}

/// Zig-zag line: the line sewn as a simple zig-zag of its stroke width.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ZigzagParams {
    /// Width of the zig-zag (mm).
    pub width: f64,
    /// Length of one zig and zag together (mm).
    pub spacing: f64,
    /// Extra width on each side (mm).
    pub pull_comp: f64,
    /// Turn the zig-zags by this angle (degrees, ±89): spokes on curves.
    pub angle: f64,
}

impl Default for ZigzagParams {
    fn default() -> Self {
        ZigzagParams { width: 2.0, spacing: 0.4, pull_comp: 0.0, angle: 0.0 }
    }
}

/// Manual stitch: every node is a needle penetration.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ManualParams {
    /// Split stitches longer than this (mm, 0 = keep them).
    /// Ink/Stitch `max_stitch_length_mm`.
    pub max_length: f64,
    /// Bean repeats per stitch (passes; several values are used in turn).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub bean_pattern: Vec<u32>,
}

/// Stem stitch (hand embroidery's stem / outline stitch).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct StemParams {
    /// Width of the rope (mm): how far the stitches slant across the line.
    pub width: f64,
}

impl Default for StemParams {
    fn default() -> Self {
        StemParams { width: 0.8 }
    }
}

/// Patterns of a motif run.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum MotifKind {
    #[default]
    Wave,
    Zigzag,
    Scallop,
    Loop,
    Diamond,
    Cross,
}

/// Motif run: a pattern repeated along the line.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct MotifParams {
    pub kind: MotifKind,
    /// Length of one motif along the line (mm); its height is half of it.
    pub size: f64,
}

impl Default for MotifParams {
    fn default() -> Self {
        MotifParams { kind: MotifKind::Wave, size: 4.0 }
    }
}

impl Default for RunningParams {
    fn default() -> Self {
        RunningParams {
            length: 2.5,
            tolerance: 0.2,
            repeats: 1,
            bean_repeats: 0,
            ripple: None,
            stem: None,
            motif: None,
            zigzag: None,
            length_pattern: vec![],
            bean_pattern: vec![],
            random_length: 0.0,
            random_seed: 1,
            cutwork_needle: 0,
        }
    }
}

/// Ripple stitch (Ink/Stitch `ripple_stitch.py`): closed shapes become a
/// spiral of shrinking copies of the outline (circular ripples), open lines
/// are stitched back and forth as parallel copies (linear ripples).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RippleParams {
    /// Number of ripple lines.
    pub lines: u32,
    /// Closed shapes: size of the innermost ripple (0..1 of the outline).
    pub min_scale: f64,
    /// Open lines: distance between the copies (mm).
    pub spacing: f64,
    /// Total rotation from the first to the last ripple (degrees).
    pub rotation: f64,
    /// Start in the middle (closed) / at the far copy (open).
    pub reverse: bool,
    /// Centre of the ripples (closed) or the direction to ripple towards (open). Default: the shape's centre.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<[f64; 2]>,
    /// Lines at least this far apart instead of a fixed count (mm, 0 = use
    /// `lines`). Ink/Stitch `min_line_dist_mm`.
    pub min_line_dist: f64,
    /// Leave out this many ripples at the start / end.
    pub skip_start: u32,
    pub skip_end: u32,
    /// Sew every other copy backwards (back and forth); off: all one way.
    pub flip_copies: bool,
    /// Bunch the ripples towards one end (> 1) or the other (< 1), and flip it.
    pub exponent: f64,
    pub flip_exponent: bool,
    /// Rows of needle points staggered over this many lines (0 = even stitches).
    pub staggers: u32,
    /// Copies meet in points (Ink/Stitch join style "point") instead of
    /// flat connections.
    pub join_point: bool,
    /// A grid across the ripples, its points this far apart (mm, 0 = none),
    /// sewn after the ripples or first.
    pub grid_size: f64,
    pub grid_first: bool,
    /// Copies along a guide: scaled on these axes, from `scale_start` to
    /// `scale_end` % (Ink/Stitch's default end is 0 %; here 100 %), turned
    /// with the guide.
    pub scale_axis: RippleScaleAxis,
    pub scale_start: f64,
    pub scale_end: f64,
    pub rotate_ripples: bool,
    /// The outline's own points are the stitches (no running stitch).
    pub manual: bool,
    /// Open lines without a guide: fanned towards the target (Ink/Stitch)
    /// instead of parallel copies `spacing` apart.
    pub fan: bool,
    /// The guide the copies follow: one line, or a satin (two rails and
    /// rungs) the copies are fitted between.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub guide: Vec<SubPath>,
    /// Satin guide: the line of the outline fitted between the rails
    /// (default: from its first to its last point).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub anchor: Option<[[f64; 2]; 2]>,
    /// Satin guide: copies by line count, at the rungs, or as many as fit.
    pub guide_position: RippleGuidePosition,
}

/// Which axes ripple copies are scaled on (Ink/Stitch `scale_axis`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum RippleScaleAxis {
    #[default]
    Both,
    X,
    Y,
    None,
}

/// Where copies sit along a satin guide (Ink/Stitch `satin_guide_pattern_position`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum RippleGuidePosition {
    #[default]
    LineCount,
    Rungs,
    Adaptive,
}

impl RunningParams {
    /// The stitch lengths of this line (pattern, randomness).
    pub fn stitch_length(&self) -> crate::stitches::running::StitchLength {
        crate::stitches::running::StitchLength::new(self.length, &self.length_pattern, self.random_length, self.random_seed)
    }
    /// Bean repeats per stitch.
    pub fn beans(&self) -> Vec<u32> {
        if self.bean_pattern.is_empty() {
            vec![self.bean_repeats]
        } else {
            self.bean_pattern.clone()
        }
    }
}

impl Default for RippleParams {
    fn default() -> Self {
        RippleParams {
            lines: 10,
            min_scale: 0.0,
            spacing: 2.0,
            rotation: 0.0,
            reverse: false,
            target: None,
            min_line_dist: 0.0,
            skip_start: 0,
            skip_end: 0,
            flip_copies: true,
            exponent: 1.0,
            flip_exponent: false,
            staggers: 0,
            join_point: false,
            grid_size: 0.0,
            grid_first: false,
            scale_axis: RippleScaleAxis::Both,
            scale_start: 100.0,
            scale_end: 100.0,
            rotate_ripples: true,
            manual: false,
            fan: false,
            guide: vec![],
            anchor: None,
            guide_position: RippleGuidePosition::LineCount,
        }
    }
}

/// Which satin rail to reverse (Ink/Stitch `reverse_rails`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum RailReverse {
    /// Reverse the second rail when it runs against the first.
    #[default]
    Automatic,
    None,
    First,
    Second,
    Both,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum SatinMethod {
    #[default]
    Satin,
    EStitch,
    SStitch,
    Zigzag,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SatinParams {
    pub method: SatinMethod,
    /// Distance between zigzags (mm).
    pub spacing: f64,
    /// Width when the satin is defined by a single centre line (mm).
    pub width: f64,
    /// Pull compensation in mm (added to the total width).
    pub pull_comp: f64,
    /// Pull compensation as percentage of the local width.
    pub pull_comp_pct: f64,
    /// Split stitches longer than this (mm). 0 = never.
    pub max_stitch_length: f64,
    /// Shorten every other stitch in tight curves (0..1 fraction inset).
    pub short_stitch_inset: f64,
    pub center_walk: bool,
    pub contour_underlay: bool,
    pub contour_inset: f64,
    pub zigzag_underlay: bool,
    pub zigzag_underlay_spacing: f64,
    pub zigzag_underlay_inset: f64,
    /// Underlay chosen by the column's width and the fabric (automatic
    /// underlay); the manual underlay switches are ignored then.
    pub underlay_auto: bool,
    /// Centre walk: passes along the centre (2 = there and back), and where
    /// across the column (0 = first rail, 0.5 = centre, 1 = second rail).
    /// Ink/Stitch `center_walk_underlay_repeats` / `_position`.
    pub center_walk_repeats: u32,
    pub center_walk_position: f64,
    /// Stitch length of the centre-walk and contour underlay (mm).
    pub underlay_stitch_length: f64,
    /// Contour / zig-zag underlay inset as a share of the column width, each
    /// side (Ink/Stitch `*_underlay_inset_percent`, here 0..1).
    pub contour_inset_pct: f64,
    pub zigzag_inset_pct: f64,
    /// Zig-zag underlay: split stitches longer than this (mm, 0 = never).
    pub zigzag_underlay_max_stitch: f64,
    /// Stitches in tight curves closer than this get shortened (mm;
    /// Ink/Stitch `short_stitch_distance_mm`).
    pub short_stitch_distance: f64,
    /// Shortens the column at both ends: satins push the fabric out where
    /// they start and end (mm; Ink/Stitch `push_compensation_mm`).
    pub push_comp: f64,
    /// Random texture: every stitch up to this much wider / narrower (share of
    /// the width, each side) — Ink/Stitch `random_width_increase/decrease_percent`.
    pub random_wider: f64,
    pub random_narrower: f64,
    pub random_seed: u32,
    /// Long stitches split at staggered points (rows of needle points would
    /// line up otherwise): every `split_staggers` stitches the pattern repeats
    /// (0 = split evenly; Ink/Stitch `split_method` staggered).
    pub split_staggers: u32,
    /// Direction guides: lines across the column that set the stitch angle
    /// there (Ink/Stitch rungs); between two guides the angle turns evenly.
    /// Kept apart from the paths so editing the outline keeps them.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub guides: Vec<[[f64; 2]; 2]>,
    pub swap_rails: bool,
    /// Which rail runs the wrong way (Ink/Stitch `reverse_rails`):
    /// detected automatically, or set when a satin renders strangely.
    pub reverse_rails: RailReverse,
    /// Random zig-zag spacing: each stitch's distance to the next varies by
    /// up to this share (0..1). Ink/Stitch `random_zigzag_spacing_percent`.
    pub random_spacing: f64,
    /// Split stitches: positions (or, with a random phase, lengths) vary by
    /// up to this share (0..1). Ink/Stitch `random_split_jitter_percent`.
    pub split_jitter: f64,
    /// Split stitches with a random phase instead of centred (no lines of
    /// split points). Ink/Stitch `random_split_phase`.
    pub split_random_phase: bool,
    /// With a random phase: stitches longer than this are split already
    /// (mm, 0 = the max stitch length). Ink/Stitch `min_random_split_length_mm`.
    pub split_min_length: f64,
    /// Every sub-path is its own centre-line column (e.g. satin borders around letters).
    pub multi: bool,
    pub reverse: bool,
}

impl Default for SatinParams {
    fn default() -> Self {
        SatinParams {
            method: SatinMethod::Satin,
            spacing: 0.4,
            width: 3.0,
            pull_comp: 0.2,
            pull_comp_pct: 0.0,
            max_stitch_length: 0.0,
            short_stitch_inset: 0.15,
            center_walk: true,
            contour_underlay: false,
            contour_inset: 0.4,
            zigzag_underlay: false,
            zigzag_underlay_spacing: 3.0,
            zigzag_underlay_inset: 0.6,
            underlay_auto: false,
            center_walk_repeats: 2,
            center_walk_position: 0.5,
            underlay_stitch_length: 2.5,
            contour_inset_pct: 0.0,
            zigzag_inset_pct: 0.0,
            zigzag_underlay_max_stitch: 0.0,
            short_stitch_distance: 0.25,
            push_comp: 0.0,
            random_wider: 0.0,
            random_narrower: 0.0,
            random_seed: 1,
            split_staggers: 0,
            guides: Vec::new(),
            swap_rails: false,
            reverse_rails: RailReverse::Automatic,
            random_spacing: 0.0,
            split_jitter: 0.0,
            split_random_phase: false,
            split_min_length: 0.0,
            multi: false,
            reverse: false,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum FillMethod {
    /// Ink/Stitch "tatami fill" (auto fill): parallel staggered rows.
    #[default]
    Tatami,
    /// Concentric inset rings (Ink/Stitch contour fill, inner-to-outer).
    Contour,
    /// Continuous spiral built from inset rings.
    Spiral,
    /// New: sunburst rays from a centre with density-preserving short rays.
    Radial,
    /// New: Hilbert space-filling curve texture.
    Hilbert,
    /// New: tonal stipple (Poisson-disk points joined by a TSP tour).
    Stipple,
    /// Ink/Stitch meander fill: a random space-filling walk over a lattice.
    Meander,
    /// Ink/Stitch guided fill: rows follow a guide line.
    Guided,
    /// Ink/Stitch circular fill: a spiral around a centre point.
    Circular,
    /// Streamline fill: evenly spaced rows following a direction field
    /// (from the digitizer: the flow of the picture; without one, the shape).
    Flow,
    /// Curved fill: streamline rows that follow the outline of the shape
    /// (with a mesh gradient: the rows of the mesh); `curve` sets how much.
    Curved,
    /// Cross stitch: a grid of crosses over the shape (Ink/Stitch cross stitch).
    Cross,
    /// Tartan: a woven plaid, one colour per layer (Ink/Stitch tartan fill).
    Tartan,
}

/// A tartan (Ink/Stitch `inkstitch:tartan` settings and tartan fill parameters).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TartanParams {
    /// Ink/Stitch's palette code: `(colour)width` stripes, `/` a symmetric
    /// sett, `?` not sewn, `*` in the previous colour, `warp|weft`.
    pub palette: String,
    /// Turn of the whole pattern (degrees).
    pub rotate: f64,
    /// Shift of the stripes (mm, x y).
    pub offset: [f64; 2],
    /// Reflect the sett at its pivots (also when the code has no `/`).
    pub symmetry: bool,
    /// Size of the pattern (%).
    pub scale: f64,
    /// Stripes this narrow or narrower are sewn as running stitch lines (mm).
    pub min_stripe_width: f64,
    /// The rows' angle to the stripes (degrees; Ink/Stitch `tartan_angle`, -45).
    pub angle: f64,
    /// Rows of one thread before warp and weft change over.
    pub rows_per_thread: u32,
    /// Herringbone: the twill turns every this many mm (0 = a plain twill).
    pub herringbone: f64,
    /// Which colour of the palette this layer sews.
    pub layer: u32,
    /// Shared id of the layers of one tartan.
    pub group: String,
}

impl Default for TartanParams {
    fn default() -> Self {
        TartanParams {
            palette: "(#101010)/5.0 (#FFFFFF)/?5.0".into(),
            rotate: 0.0,
            offset: [0.0, 0.0],
            symmetry: true,
            scale: 100.0,
            min_stripe_width: 1.0,
            angle: -45.0,
            rows_per_thread: 2,
            herringbone: 0.0,
            layer: 0,
            group: String::new(),
        }
    }
}

/// Penetration patterns carved into a tatami fill (program split /
/// carving): the needle points line up into a pattern that catches the light.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum CarvePattern {
    #[default]
    None,
    Diamonds,
    Waves,
    Chevrons,
    Bricks,
    Circles,
}

/// Stitches of a cross-stitch cell.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum CrossKind {
    /// Both diagonals (×).
    #[default]
    Cross,
    /// One diagonal (/).
    Half,
    /// Upright cross (+).
    Upright,
    /// × and + together: one diagonal, the upright cross, the other
    /// diagonal on top (Ink/Stitch double cross).
    Double,
    /// Smyrna cross: the diagonal cross, then the upright cross on top.
    Smyrna,
}

/// A direction field on a grid (design mm): row directions in radians
/// (y down, defined modulo π), row-major `cols × rows` cells of `cell` mm.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct FlowField {
    pub origin: [f64; 2],
    pub cell: f64,
    pub cols: u32,
    pub rows: u32,
    pub angles: Vec<f32>,
}

/// How a guided fill's rows follow its guide line (Ink/Stitch `guided_fill_strategy`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum GuidedStrategy {
    /// Every row a copy of the guide, shifted across (rows bunch where it bends).
    #[default]
    Copy,
    /// Rows parallel to the guide at an even distance (offset curves).
    Parallel,
    /// Like parallel, and round the guide's ends.
    Buffer,
}

/// Lattice the meander fill walks on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum MeanderPattern {
    /// Square grid: classic meander with right-angle turns.
    #[default]
    Square,
    /// Triangular grid: zig-zagging, angular wandering.
    Triangle,
    /// Honeycomb: hexagonal, organic wandering.
    Hexagon,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct FillParams {
    pub method: FillMethod,
    /// Row direction in degrees (counter-clockwise on screen).
    pub angle: f64,
    pub row_spacing: f64,
    /// Optional gradient: row spacing at the end of the fill (0 = disabled).
    pub end_row_spacing: f64,
    pub max_stitch_length: f64,
    /// Rows repeat their stitch pattern every N rows (tatami stagger).
    pub staggers: u32,
    pub pull_comp: f64,
    pub underlay: bool,
    /// Underlay angle relative to the fill angle (degrees).
    pub underlay_angle: f64,
    pub underlay_spacing: f64,
    pub underlay_inset: f64,
    pub underlay_stitch_length: f64,
    /// Underlay chosen by the object's size and the fabric (automatic
    /// underlay); the manual underlay settings are ignored then.
    pub underlay_auto: bool,
    /// An edge run (running stitch just inside the outline) before the
    /// tatami underlay: crisp, stable edges.
    pub underlay_edge: bool,
    /// A second tatami underlay pass, the two crossing at ±45° to the
    /// underlay angle (Ink/Stitch: a list of underlay angles; a double
    /// tatami underlay) — for soft and stretchy fabrics.
    pub underlay_cross: bool,
    /// Underlay passes at these angles (relative to the fill angle); when
    /// set, they replace the underlay angle and the cross-hatch. Ink/Stitch
    /// `fill_underlay_angle` with several values.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub underlay_angles: Vec<f64>,
    /// Running-style fills (meander, circular, contour, spiral): the path sewn
    /// this many times, and every stitch as a bean stitch (Ink/Stitch
    /// `repeats`, `bean_stitch_repeats`).
    pub repeats: u32,
    pub bean_repeats: u32,
    /// Spiral contour: in on every other ring and out on the rest, ending
    /// next to the start (Ink/Stitch `contour_strategy` = double spiral).
    pub contour_double: bool,
    /// Contour / spiral: go round clockwise (on screen).
    pub clockwise: bool,
    /// Tatami: pull compensation as a share of each row's length, each side
    /// (Ink/Stitch `pull_compensation_percent`, here 0..1).
    pub pull_comp_pct: f64,
    /// Tatami: leave out the last stitch of every row (it sits next to the
    /// first of the next one). Ink/Stitch `skip_last`.
    pub skip_last: bool,
    /// Underlay: leave out the last stitch of every row too.
    pub underlay_skip_last: bool,
    /// Tatami: extra rows sewn past the end of each section before it
    /// travels on, against gaps between sections on stretchy fabric
    /// (Ink/Stitch `gap_fill_rows`; rounded up to an even number).
    pub gap_fill_rows: u32,
    /// Travel inside the shape between sections (off: along the outline
    /// only). Ink/Stitch `underpath`.
    pub underpath: bool,
    /// Guided fill: copies of the guide, or rows parallel to it.
    pub guided_strategy: GuidedStrategy,
    /// Tatami: start in the middle and sew outwards to either side, so the
    /// fabric is pushed out evenly rather than all towards one end.
    pub center_out: bool,
    /// Stitch length for travel/underpath running stitches.
    pub travel_length: f64,
    /// Radial fill centre relative to the shape bounding box (0..1).
    pub center: [f64; 2],
    /// With an end row spacing: interpolate the stitch *density* (rows per
    /// mm) instead of the spacing, so two overlapping fills with opposite
    /// gradients add up to an even coverage (colour blending).
    pub gradient_density: bool,
    /// Multi-colour gradient: this fill is one colour layer of it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gradient: Option<GradientParams>,
    /// Tartan: this fill is one colour layer of it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tartan: Option<TartanParams>,
    /// Meander fill: lattice, cell size (mm), smoothness (0..1) and seed.
    pub meander_pattern: MeanderPattern,
    /// Meander fill: an Ink/Stitch tile (`tiles/<id>`) instead of the lattice;
    /// `meander_scale` 2.5 mm ≙ the tile at 100 %.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub meander_tile: Option<String>,
    pub meander_scale: f64,
    /// Meander: height of the pattern relative to its width (Ink/Stitch's
    /// separate x / y `meander_scale_percent`; 1 = as drawn).
    pub meander_aspect: f64,
    /// Meander: sewn as a zig-zag of this zig+zag length (mm, 0 = a plain
    /// line) and width. Ink/Stitch `zigzag_spacing_mm`, `zigzag_width_mm`.
    pub meander_zigzag: f64,
    pub meander_zigzag_width: f64,
    /// Meander: keep the stitches inside the shape (with smoothing or
    /// expand they can leave it). Ink/Stitch `clip`.
    pub meander_clip: bool,
    pub smoothness: f64,
    /// Seed of the meander and of random stitch lengths.
    pub seed: u32,
    /// Random stitch length in the rows (tatami, contour, guided, circular,
    /// spiral): each stitch varies by up to this % (0 = even). Ink/Stitch
    /// `random_stitch_length_jitter_percent`.
    pub random_length: f64,
    /// Guided fill: the guide line the rows follow (design coordinates).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub guide: Option<SubPath>,
    /// Flow fill: the direction field the rows follow.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub flow: Option<FlowField>,
    /// Curved fill: 0 = straight rows along the fill angle, 1 = rows follow
    /// the outline fully.
    pub curve: f64,
    /// Flow fill of a gradient: rows run across the colour bands (through
    /// the colours) instead of along them.
    pub flow_across: bool,
    /// Tatami: a pattern carved into the needle points.
    pub carve: CarvePattern,
    /// Size of the carved pattern (mm).
    pub carve_size: f64,
    /// Cross stitch: cell size (mm), how much of a cell must be inside the
    /// shape (0..1) and the stitches of a cell.
    pub cross_size: f64,
    pub cross_coverage: f64,
    pub cross_kind: CrossKind,
    /// Cross stitch grid on the page (true: neighbouring areas line up), or
    /// on the shape's own corner (false: the shape stitches the same wherever
    /// it is — Ink/Stitch's cross-stitch fonts). Ink/Stitch `canvas_grid_origin`.
    pub cross_grid_canvas: bool,
    /// Cross stitch: the other diagonal first (Ink/Stitch's "flipped" methods).
    pub cross_flip: bool,
    /// Cross stitch: every diagonal sewn this many times (odd: 1, 3, 5).
    pub cross_threads: u32,
    /// Cross stitch: cell height (mm; 0 = square). Ink/Stitch `pattern_size_mm` "x y".
    pub cross_size_y: f64,
    /// Upright crosses: a second grid shifted by half a cell (dense upright).
    pub cross_dense: bool,
    /// Cross stitch: split stitches longer than this (mm, 0 = never).
    pub cross_max_length: f64,
    /// Shift of the cross stitch grid (mm, x y). Ink/Stitch `cross_offset_mm`.
    pub cross_offset: [f64; 2],
    /// Grow (or with < 0 shrink) the shape before fill stitching, against
    /// gaps between shapes (mm). Ink/Stitch `expand_mm`.
    pub expand: f64,
    /// Density gradient along a vector (a gradient fill and, as two
    /// layers with opposite ramps, colour blending). Tatami, flow and curved.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ramp: Option<DensityRamp>,
}

/// How the density changes along a ramp: 0 = densest, 1 = sparsest.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum RampProfile {
    #[default]
    Linear,
    /// Stays dense, then opens up quickly.
    EaseIn,
    /// Opens up quickly, then stays open.
    EaseOut,
    /// An S-curve: dense and open ends, a soft transition.
    Smooth,
    /// Dense in the middle, open at both ends.
    Middle,
    /// Open in the middle, dense at both ends.
    Ends,
}

impl RampProfile {
    pub fn at(self, t: f64) -> f64 {
        let t = t.clamp(0.0, 1.0);
        match self {
            RampProfile::Linear => t,
            RampProfile::EaseIn => t * t,
            RampProfile::EaseOut => 1.0 - (1.0 - t) * (1.0 - t),
            RampProfile::Smooth => t * t * (3.0 - 2.0 * t),
            RampProfile::Middle => (2.0 * t - 1.0).abs(),
            RampProfile::Ends => 1.0 - (2.0 * t - 1.0).abs(),
        }
    }
}

/// A density gradient along a vector (design mm): row spacing `dense` at
/// `from`, `sparse` at `to` (shaped by the profile), constant beyond.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DensityRamp {
    pub from: [f64; 2],
    pub to: [f64; 2],
    /// Row spacing where the fill is densest (mm).
    pub dense: f64,
    /// Row spacing where it is most open (mm).
    pub sparse: f64,
    pub profile: RampProfile,
    /// Sparse at `from`, dense at `to` (the other layer of a colour blend).
    pub reverse: bool,
    /// Interpolate the density (rows per mm), not the spacing: two layers
    /// with opposite ramps add up to an even coverage (colour blending).
    pub additive: bool,
    /// The two layers of a colour blend share a group.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
}

impl Default for DensityRamp {
    fn default() -> Self {
        DensityRamp { from: [0.0, 0.0], to: [10.0, 0.0], dense: 0.25, sparse: 2.0, profile: RampProfile::Linear, reverse: false, additive: false, group: None }
    }
}

impl DensityRamp {
    /// Row spacing at position `t` (0 at `from`, 1 at `to`), scaled by `k`.
    pub fn spacing_at(&self, t: f64, k: f64) -> f64 {
        let t = t.clamp(0.0, 1.0);
        let f = self.profile.at(if self.reverse { 1.0 - t } else { t });
        let dense = (self.dense * k).max(0.08);
        let sparse = (self.sparse * k).max(dense);
        let s = if self.additive {
            let (d0, d1) = (1.0 / dense, 1.0 / sparse);
            1.0 / (d0 + (d1 - d0) * f)
        } else {
            dense + (sparse - dense) * f
        };
        s.max(0.05)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum GradientKind {
    #[default]
    Linear,
    /// Mirrored around the start point.
    Reflected,
    Radial,
    /// Sweeps around the start point.
    Conic,
    /// Gradient mesh: a grid of coloured nodes, blended
    /// smoothly inside every patch.
    Mesh,
    /// Freeform colour points, each with its own spread.
    Freeform,
}

/// A node of a gradient mesh.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct MeshNode {
    pub p: [f64; 2],
    /// Colour layer (stop index) of this node.
    pub c: u32,
}

/// `rows` × `cols` nodes, row by row; four neighbouring nodes span a patch.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct GradientMesh {
    pub rows: u32,
    pub cols: u32,
    pub nodes: Vec<MeshNode>,
}

/// A colour point of a freeform gradient.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct FreePoint {
    pub p: [f64; 2],
    /// Colour layer (stop index).
    pub c: u32,
    /// Reach of the colour (mm): a larger spread carries it further before it blends.
    pub spread: f64,
}

impl Default for FreePoint {
    fn default() -> Self {
        FreePoint { p: [0.0, 0.0], c: 0, spread: 10.0 }
    }
}

/// How a colour changes into the next between two stops.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum TransitionCurve {
    #[default]
    Linear,
    Smooth,
    EaseIn,
    EaseOut,
    /// Steep S-curve: short transitions, long solid areas.
    Sharp,
    /// Posterised into `steps` hard bands.
    Steps,
}

/// How a gradient's colours share the shape.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum GradientMix {
    /// Every colour sews its own rows, closer together where it is stronger;
    /// the colours add up to the full density (colour blending). Few
    /// jumps: the rows of a colour run on unbroken.
    #[default]
    Blend,
    /// The rows are cut into cells, each sewn in one colour (dithered): a
    /// crisp pixel mix, at the cost of a jump at most cell borders of the
    /// last colour. Straight rows only.
    Dither,
    /// Every row in one colour, the colours alternating rows through the
    /// transition (Ink/Stitch's linear gradient fill); every colour travels
    /// along the outline only. Straight rows only; best across the gradient.
    Rows,
}

/// How the colours are mixed where they overlap in the transition (dithered gradients).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum DitherMethod {
    /// Error diffusion (Floyd–Steinberg): the most even mix.
    #[default]
    Diffusion,
    /// Whole rows interleave in an ordered pattern.
    Rows,
    /// Bayer matrix: a regular woven / pixel look.
    Ordered,
    /// Random blue-ish noise: organic, painterly.
    Noise,
    /// No mixing: hard edges at the middle of each transition.
    Bands,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct GradientStop {
    /// Position 0..1 along the gradient.
    pub pos: f64,
    /// Midpoint of the transition to the next stop (0..1, 0.5 = even).
    pub mid: f64,
}

impl Default for GradientStop {
    fn default() -> Self {
        GradientStop { pos: 0.0, mid: 0.5 }
    }
}

/// A gradient over several fill layers (one object per colour stop, all
/// with the same shape and stitch grid); the layers share every row of the
/// grid between them, so the total density stays even.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct GradientParams {
    pub kind: GradientKind,
    /// Start and end of the gradient vector (mm).
    pub from: [f64; 2],
    pub to: [f64; 2],
    pub stops: Vec<GradientStop>,
    pub curve: TransitionCurve,
    pub steps: u32,
    pub dither: DitherMethod,
    /// Blend the colours by density, or dither them cell by cell.
    pub mix: GradientMix,
    /// Dither cell length along the rows (mm).
    pub cell: f64,
    /// Which stop this layer sews.
    pub layer: u32,
    /// Shared id of the layers of one gradient.
    pub group: String,
    pub seed: u32,
    /// Nodes of a mesh gradient.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mesh: Option<GradientMesh>,
    /// Colour points of a freeform gradient.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub points: Vec<FreePoint>,
}

impl Default for GradientParams {
    fn default() -> Self {
        GradientParams {
            kind: GradientKind::Linear,
            from: [0.0, 0.0],
            to: [10.0, 0.0],
            stops: vec![GradientStop { pos: 0.0, mid: 0.5 }, GradientStop { pos: 1.0, mid: 0.5 }],
            curve: TransitionCurve::Linear,
            steps: 4,
            dither: DitherMethod::Diffusion,
            mix: GradientMix::Blend,
            cell: 3.0,
            layer: 0,
            group: String::new(),
            seed: 1,
            mesh: None,
            points: Vec::new(),
        }
    }
}

impl Default for FillParams {
    fn default() -> Self {
        FillParams {
            method: FillMethod::Tatami,
            angle: 0.0,
            row_spacing: 0.25,
            end_row_spacing: 0.0,
            max_stitch_length: 3.0,
            staggers: 4,
            pull_comp: 0.0,
            underlay: true,
            underlay_angle: 90.0,
            underlay_spacing: 0.75,
            underlay_inset: 0.3,
            underlay_stitch_length: 3.0,
            underlay_auto: false,
            underlay_edge: false,
            underlay_cross: false,
            underlay_angles: Vec::new(),
            repeats: 1,
            bean_repeats: 0,
            contour_double: false,
            clockwise: false,
            pull_comp_pct: 0.0,
            skip_last: false,
            underlay_skip_last: false,
            gap_fill_rows: 0,
            underpath: true,
            guided_strategy: GuidedStrategy::Copy,
            center_out: false,
            travel_length: 2.5,
            center: [0.5, 0.5],
            gradient_density: false,
            tartan: None,
            gradient: None,
            curve: 1.0,
            flow_across: false,
            carve: CarvePattern::None,
            carve_size: 6.0,
            cross_size: 2.5,
            cross_coverage: 0.5,
            cross_size_y: 0.0,
            cross_dense: false,
            cross_max_length: 11.0,
            cross_kind: CrossKind::Cross,
            cross_grid_canvas: true,
            cross_flip: false,
            cross_threads: 1,
            cross_offset: [0.0, 0.0],
            expand: 0.0,
            ramp: None,
            meander_pattern: MeanderPattern::Square,
            meander_tile: None,
            meander_scale: 2.5,
            meander_aspect: 1.0,
            meander_zigzag: 0.0,
            meander_zigzag_width: 3.0,
            meander_clip: false,
            smoothness: 0.5,
            seed: 1,
            random_length: 0.0,
            guide: None,
            flow: None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum TackdownKind {
    None,
    Run,
    #[default]
    Zigzag,
    EStitch,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum CoverKind {
    None,
    #[default]
    Satin,
    EStitch,
}

/// Automatic appliqué: placement line → stop (lay the fabric)
/// → tack-down → stop (trim the fabric) → cover stitch along the edge.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AppliqueParams {
    pub placement: bool,
    pub placement_length: f64,
    pub tackdown: TackdownKind,
    pub tackdown_width: f64,
    /// Distance of the tack-down centre inside the edge (mm).
    pub tackdown_inset: f64,
    pub tackdown_spacing: f64,
    pub cover: CoverKind,
    pub cover_width: f64,
    pub cover_spacing: f64,
    /// Shift of the cover stitch centre outwards (mm, negative = inwards).
    pub cover_offset: f64,
    pub cover_underlay: bool,
    pub pull_comp: f64,
    /// Swap the side E-stitch prongs point to.
    pub flip: bool,
    /// Machine stops after the placement line and after the tack-down.
    pub stops: bool,
}

impl Default for AppliqueParams {
    fn default() -> Self {
        AppliqueParams {
            placement: true,
            placement_length: 2.0,
            tackdown: TackdownKind::Zigzag,
            tackdown_width: 1.6,
            tackdown_inset: 0.6,
            tackdown_spacing: 1.2,
            cover: CoverKind::Satin,
            cover_width: 3.0,
            cover_spacing: 0.4,
            cover_offset: 0.0,
            cover_underlay: true,
            pull_comp: 0.2,
            flip: false,
            stops: true,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum StitchParams {
    /// Shape is shown but not stitched (e.g. appliqué artwork reference).
    None,
    Running(RunningParams),
    Satin(SatinParams),
    Fill(FillParams),
    Applique(AppliqueParams),
    /// Every node is a needle penetration (imported embroidery files).
    Manual(ManualParams),
}

impl Default for StitchParams {
    fn default() -> Self {
        StitchParams::Fill(FillParams::default())
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Object {
    pub id: String,
    #[serde(default)]
    pub name: String,
    /// Thread id (see [`Thread::id`]).
    pub thread: String,
    #[serde(default = "yes")]
    pub visible: bool,
    #[serde(default)]
    pub locked: bool,
    pub paths: Vec<SubPath>,
    #[serde(default)]
    pub stitch: StitchParams,
    /// Insert a trim after this object even if the next one is close.
    #[serde(default)]
    pub trim_after: bool,
    /// Insert a machine stop after this object (appliqué, puff, ...).
    #[serde(default)]
    pub stop_after: bool,
    /// Lock stitches at this object's start and end (Ink/Stitch `ties`).
    #[serde(default)]
    pub ties: Ties,
    /// Lock stitches even where the object joins the next one without a
    /// trim (Ink/Stitch `force_lock_stitches`).
    #[serde(default)]
    pub force_lock: bool,
    /// Drop stitches shorter than this in this object (mm; none: the
    /// machine setting). Ink/Stitch `min_stitch_length_mm`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_stitch: Option<f64>,
    /// Gaps to the next object up to this long are sewn through without
    /// locks and a trim (mm; none: the machine's trim distance).
    /// Ink/Stitch `min_jump_stitch_length_mm`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_jump: Option<f64>,
    /// Stitch patterns drawn over the object (Ink/Stitch pattern markers).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub patterns: Vec<StitchPattern>,
    /// A linked clone (an SVG `<use>`): it follows another object through
    /// its own transform; the editor keeps its shape in step.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub clone: Option<CloneLink>,
    /// Where stitching should begin (Ink/Stitch "starting point" / "fill start" command).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start: Option<[f64; 2]>,
    /// Where stitching should end (Ink/Stitch "ending point" / "fill end" command).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end: Option<[f64; 2]>,
}

/// A user-drawn stitch pattern (Ink/Stitch "selection to pattern"):
/// lines add a needle point wherever a stitch crosses them (every
/// `interval`-th crossing, after skipping `offset`), shapes leave out the
/// needle points inside them (row ends and satin edges stay).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StitchPattern {
    pub paths: Vec<SubPath>,
    /// Lines: add needle points where stitches cross them.
    #[serde(default)]
    pub add: bool,
    /// Shapes: leave out the needle points inside them.
    #[serde(default)]
    pub remove: bool,
    /// Which crossings get a point, in turn (1 = every one, "2 1" …).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub interval: Vec<u32>,
    #[serde(default)]
    pub offset: u32,
}

/// A clone's link to its original (see [`Object::clone`]).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloneLink {
    /// The original's id.
    pub of: String,
    /// Original → clone transform (a b c d e f, mm) and the rotation in it (degrees).
    pub m: [f64; 6],
    pub rot: f64,
    /// The clone's own fill angle (Ink/Stitch clone `angle`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub angle: Option<f64>,
}

fn yes() -> bool {
    true
}

impl Object {
    pub fn bounds(&self) -> Rect {
        let mut r = Rect::EMPTY;
        for sp in &self.paths {
            for p in sp.flatten(0.2) {
                r.include(p);
            }
        }
        if let StitchParams::Satin(s) = &self.stitch {
            if self.paths.len() == 1 {
                let w = s.width * 0.5;
                r.min_x -= w;
                r.min_y -= w;
                r.max_x += w;
                r.max_y += w;
            }
        }
        r
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Thread {
    pub id: String,
    pub name: String,
    /// "#rrggbb"
    pub color: String,
    #[serde(default)]
    pub brand: String,
    #[serde(default)]
    pub code: String,
    /// Weight number (No. 40 …) when it differs from the design's thread
    /// weight: sizes the thread in the density model.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub weight: Option<u32>,
}

impl Thread {
    pub fn rgb(&self) -> [u8; 3] {
        parse_hex_color(&self.color).unwrap_or([0, 0, 0])
    }
}

pub fn parse_hex_color(s: &str) -> Option<[u8; 3]> {
    let s = s.trim().trim_start_matches('#');
    let v = match s.len() {
        6 => u32::from_str_radix(s, 16).ok()?,
        3 => {
            let v = u32::from_str_radix(s, 16).ok()?;
            let (r, g, b) = ((v >> 8) & 0xf, (v >> 4) & 0xf, v & 0xf);
            (r * 17) << 16 | (g * 17) << 8 | (b * 17)
        }
        _ => return None,
    };
    Some([(v >> 16) as u8, (v >> 8) as u8, v as u8])
}

pub fn hex_color(c: [u8; 3]) -> String {
    format!("#{:02x}{:02x}{:02x}", c[0], c[1], c[2])
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum Fabric {
    #[default]
    Cotton,
    Polyester,
    Denim,
    Knit,
    Sheer,
    Felt,
    Towel,
    Cap,
    Fleece,
    Pique,
    Leather,
    Canvas,
    Silk,
}

/// Fabric-aware defaults: how a fabric modifies compensation, density and underlay.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FabricProfile {
    /// Extra pull compensation (mm) added to satins and fills.
    pub pull_comp: f64,
    /// Multiplier for row/zigzag spacing (>1 = less dense).
    pub density_scale: f64,
    /// Force underlay on.
    pub force_underlay: bool,
    /// Underlay spacing multiplier.
    pub underlay_density: f64,
    /// Soft, stretchy or pile fabric (knits, fleece, towels, piqué): auto
    /// underlay is heavier (cross-hatched tatami, zig-zag earlier).
    pub stretch: bool,
    /// Delicate or firm fabric where every needle hole shows (silk, leather):
    /// auto underlay is lighter.
    pub delicate: bool,
    /// A knockdown (laydown) layer is sewn under the design: it is the
    /// underlay, so auto underlay keeps to edge runs.
    pub knockdown: bool,
}

impl Fabric {
    pub fn profile(self) -> FabricProfile {
        let p = |pull_comp, density_scale, force_underlay, underlay_density| FabricProfile {
            pull_comp,
            density_scale,
            force_underlay,
            underlay_density,
            stretch: matches!(self, Fabric::Knit | Fabric::Fleece | Fabric::Towel | Fabric::Pique | Fabric::Sheer),
            delicate: matches!(self, Fabric::Silk | Fabric::Leather),
            knockdown: false,
        };
        match self {
            Fabric::Cotton => p(0.0, 1.0, false, 1.0),
            Fabric::Polyester => p(0.1, 1.0, false, 1.0),
            // Denim / heavy twill: minimal pull compensation, reduced density
            // (wider spacing) — like canvas.
            Fabric::Denim => p(0.0, 1.05, false, 1.0),
            // T-shirt knit: 0.35 mm pull compensation in total (our
            // satin default holds 0.2), slightly reduced density, extra underlay.
            Fabric::Knit => p(0.15, 1.05, true, 0.8),
            Fabric::Sheer => p(0.1, 1.2, false, 1.3),
            Fabric::Felt => p(0.05, 1.05, false, 1.2),
            Fabric::Towel => p(0.25, 0.9, true, 0.7),
            Fabric::Cap => p(0.35, 1.0, true, 0.8),
            // Starting points from published digitizing guidance (pull
            // compensation: fleece 0.40 mm, T-shirt 0.35 mm in total
            // against 0.20 mm for cotton — our satin default already holds
            // 0.2 mm, so the extra here is the difference).
            // Fleece: more pull compensation, wider spacing, heavy underlay.
            Fabric::Fleece => p(0.2, 1.1, true, 0.8),
            // Piqué / polo knit: slightly looser, extra edge + zigzag underlay.
            Fabric::Pique => p(0.15, 1.05, true, 0.85),
            // Leather / vinyl: lower density, minimal underlay (every needle hole stays).
            Fabric::Leather => p(0.0, 1.15, false, 1.3),
            // Canvas (like denim): minimal compensation, wider spacing.
            Fabric::Canvas => p(0.0, 1.05, false, 1.0),
            // Silk / satin: reduced compensation and density, minimal underlay.
            Fabric::Silk => p(0.0, 1.1, false, 1.3),
        }
    }
}

/// Thread weight (No. 75 / 60 / 40 / 30 / 12): satin and fill spacing scale
/// with the thread's thickness. Madeira USA's stitch density guide: 0.20 mm
/// for No. 75, 0.35 for No. 60, 0.40 for No. 40 (the standard every default
/// is made for), 0.50 for No. 30 and 0.80 for No. 12.
pub fn thread_density_scale(weight: u32) -> f64 {
    match weight {
        0 | 40 => 1.0,
        75 => 0.5,
        60 => 0.875,
        30 => 1.25,
        12 => 2.0,
        // other numbers: spacing grows with the thread's diameter, √tex,
        // and the weight number is inversely proportional to tex
        w => (40.0 / w as f64).sqrt().clamp(0.5, 2.0),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum HoopShape {
    #[default]
    Rect,
    /// An ellipse in the width × height box (round when they are equal).
    Oval,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Hoop {
    pub name: String,
    pub width: f64,
    pub height: f64,
    #[serde(default, skip_serializing_if = "is_rect")]
    pub shape: HoopShape,
}

fn is_rect(s: &HoopShape) -> bool {
    *s == HoopShape::Rect
}

impl Default for Hoop {
    fn default() -> Self {
        Hoop { name: "100 × 100 mm".into(), width: 100.0, height: 100.0, shape: HoopShape::Rect }
    }
}

/// Where an object is locked (Ink/Stitch `ties`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum Ties {
    #[default]
    Both,
    Start,
    End,
    None,
}

/// Lock stitch shapes (Ink/Stitch `lib/stitch_plan/lock_stitch.py`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum LockStyle {
    /// Half a stitch back and forth along the path (Ink/Stitch's default).
    #[default]
    HalfStitch,
    Arrow,
    /// Back and forth over a fixed length (`lock_length`).
    BackForth,
    Bowtie,
    Cross,
    Star,
    Simple,
    Triangle,
    Zigzag,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct MachineSettings {
    /// Jumps longer than this become trims (mm).
    pub trim_distance: f64,
    /// Add tie-in/tie-off lock stitches.
    pub ties: bool,
    /// Lock stitch shapes at the start and the end of a stitch run
    /// (Ink/Stitch `lock_start` / `lock_end`).
    pub lock_start: LockStyle,
    pub lock_end: LockStyle,
    /// Size of the shape locks (%, Ink/Stitch `lock_*_scale_percent`).
    pub lock_scale: f64,
    /// Length of the back-and-forth lock (mm, Ink/Stitch `lock_*_scale_mm`).
    pub lock_length: f64,
    /// Minimum stitch length; shorter stitches are dropped (mm).
    pub min_stitch: f64,
    /// Maximum single needle movement before splitting (mm).
    pub max_stitch: f64,
    /// Machine speed for time estimates (stitches per minute).
    pub spm: f64,
    /// Seconds per trim / colour change for time estimates.
    pub trim_seconds: f64,
    pub color_change_seconds: f64,
    /// The machine / settings preset these came from (UI id; informational).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profile: Option<String>,
}

impl Default for MachineSettings {
    fn default() -> Self {
        MachineSettings {
            trim_distance: 3.0,
            ties: true,
            lock_start: LockStyle::HalfStitch,
            lock_end: LockStyle::HalfStitch,
            lock_scale: 100.0,
            lock_length: 0.7,
            min_stitch: 0.3,
            max_stitch: 12.1,
            spm: 800.0,
            trim_seconds: 6.0,
            color_change_seconds: 12.0,
            profile: None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum Basting {
    #[default]
    None,
    /// A rectangle around the design.
    Box,
    /// Follows the outline of the design.
    Contour,
}

/// Design-wide stitch processing applied when the plan is built
/// (non-destructive: the objects themselves are not changed).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DesignOptions {
    /// Remove fill stitching hidden under objects stacked on top (remove overlaps).
    pub remove_overlaps: bool,
    /// How far a lower fill still reaches under the object above (mm).
    pub overlap_margin: f64,
    /// Basting stitched first to hold fabric and stabiliser together.
    pub basting: Basting,
    /// Distance of the basting from the design (mm).
    pub basting_margin: f64,
    pub basting_length: f64,
    /// Thread weight of the top thread (No. 40 = the standard); scales
    /// satin and fill spacing (`thread_density_scale`).
    pub thread_weight: u32,
    /// Knockdown (laydown stitch): a light net sewn first under the
    /// whole design to flatten the nap of towels, fleece and fur, so the
    /// embroidery does not sink in.
    pub knockdown: bool,
    /// How far the knockdown reaches beyond the design (mm).
    pub knockdown_offset: f64,
    /// Row distance of the net (mm) and its stitch length (mm).
    pub knockdown_spacing: f64,
    pub knockdown_length: f64,
    /// One layer, or two crossing at 90° (denser nap).
    pub knockdown_layers: u32,
    /// Angle of the first layer (degrees).
    pub knockdown_angle: f64,
    /// Thread colour (#rrggbb): usually the fabric's, so it disappears.
    pub knockdown_color: String,
    /// Leave the design's holes (letter counters, gaps) unflattened.
    pub knockdown_holes: bool,
    /// The point that becomes 0,0 in machine files (Ink/Stitch "origin"
    /// command); none: the centre of the design.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub origin: Option<[f64; 2]>,
    /// Where the frame moves before every stop (Ink/Stitch "stop position",
    /// a.k.a. frame out), so the operator can reach the fabric; none: it stays.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stop_position: Option<[f64; 2]>,
}

impl Default for DesignOptions {
    fn default() -> Self {
        DesignOptions {
            remove_overlaps: false,
            overlap_margin: 0.6,
            basting: Basting::None,
            basting_margin: 6.0,
            basting_length: 5.0,
            thread_weight: 40,
            knockdown: false,
            knockdown_offset: 2.0,
            knockdown_spacing: 2.0,
            knockdown_length: 4.0,
            knockdown_layers: 2,
            knockdown_angle: 45.0,
            knockdown_color: String::new(),
            knockdown_holes: false,
            origin: None,
            stop_position: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Document {
    #[serde(default = "doc_version")]
    pub version: u32,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub threads: Vec<Thread>,
    #[serde(default)]
    pub objects: Vec<Object>,
    #[serde(default)]
    pub hoop: Hoop,
    #[serde(default)]
    pub fabric: Fabric,
    #[serde(default)]
    pub machine: MachineSettings,
    #[serde(default)]
    pub options: DesignOptions,
    /// The colours threads had before they were fitted to a chart or to the
    /// user's spools (thread id → original): fitting and merging stay reversible.
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub thread_sources: std::collections::BTreeMap<String, ThreadSource>,
    /// Threads that keep their spool when fitting.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub thread_locks: Vec<String>,
}

/// A thread's original colour (its "need") before fitting.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadSource {
    pub name: String,
    pub color: String,
    #[serde(default)]
    pub brand: String,
    #[serde(default)]
    pub code: String,
}

fn doc_version() -> u32 {
    1
}

impl Default for Document {
    fn default() -> Self {
        Document {
            version: 1,
            name: "Untitled".into(),
            threads: vec![],
            objects: vec![],
            hoop: Hoop::default(),
            fabric: Fabric::Cotton,
            machine: MachineSettings::default(),
            options: DesignOptions::default(),
            thread_sources: Default::default(),
            thread_locks: Vec::new(),
        }
    }
}

impl Document {
    /// The spool a thread is (colour, brand and code): threads on the same
    /// spool are sewn without a colour change.
    pub fn spool_of(&self, thread_id: &str) -> String {
        match self.thread(thread_id) {
            Some(t) => format!("{}|{}|{}", t.color.to_ascii_lowercase(), t.brand.to_ascii_lowercase(), t.code.to_ascii_lowercase()),
            None => format!("?{thread_id}"),
        }
    }

    pub fn same_spool(&self, a: &str, b: &str) -> bool {
        a == b || self.spool_of(a) == self.spool_of(b)
    }

    pub fn thread(&self, id: &str) -> Option<&Thread> {
        self.threads.iter().find(|t| t.id == id)
    }

    /// Ensure a thread with the given colour exists, returning its id.
    pub fn ensure_thread(&mut self, color: [u8; 3], name: Option<&str>) -> String {
        let hex = hex_color(color);
        if let Some(t) = self.threads.iter().find(|t| t.color.eq_ignore_ascii_case(&hex)) {
            return t.id.clone();
        }
        let id = format!("t{}", self.threads.len() + 1);
        let name = name.map(|s| s.to_string()).unwrap_or_else(|| crate::threads::nearest_name(color));
        self.threads.push(Thread { id: id.clone(), name, color: hex, brand: String::new(), code: String::new(), weight: None });
        id
    }

    pub fn bounds(&self) -> Rect {
        let mut r = Rect::EMPTY;
        for o in &self.objects {
            r = r.union(&o.bounds());
        }
        r
    }
}
