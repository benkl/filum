// Generated from the engine by crates/core/src/engine_types.rs: do not edit.
// `UPDATE_ENGINE_TYPES=1 cargo test -p filum-core --lib engine_types` writes it
// anew; the test fails while it is out of date.

export type Node = { p: [number, number], i?: [number, number] | null, o?: [number, number] | null, };

export type SubPath = { nodes: Array<Node>, closed: boolean, };

export type RunningParams = { 
/**
 * Stitch length (mm).
 */
length: number, 
/**
 * Curve tolerance (mm) for the sleeve fitting algorithm.
 */
tolerance: number, 
/**
 * Number of passes along the path (1 = single, 2 = there and back, ...).
 */
repeats: number, 
/**
 * Bean stitch: each stitch is repeated this many extra times back and forth (0, 2, 4..).
 */
beanRepeats: number, 
/**
 * Ripple stitch (Ink/Stitch): the line is repeated as ripples.
 */
ripple: RippleParams | null, 
/**
 * Stem stitch: slanted stitches that overlap by half — a rope.
 */
stem: StemParams | null, 
/**
 * Motif run: a small pattern repeated along the line.
 */
motif: MotifParams | null, 
/**
 * Zig-zag line (Ink/Stitch `stroke_method=zigzag_stitch`).
 */
zigzag: ZigzagParams | null, 
/**
 * Several stitch lengths used in turn (Ink/Stitch "2 1"); overrides
 * `length` when set.
 */
lengthPattern: Array<number>, 
/**
 * Bean repeats per stitch in turn (passes, like `bean_repeats`);
 * overrides `bean_repeats` when set.
 */
beanPattern: Array<number>, 
/**
 * Random stitch length: each stitch varies by up to this % (0 = even
 * stitches). Ink/Stitch `random_stitch_length_jitter_percent`.
 */
randomLength: number, randomSeed: number, 
/**
 * Cutwork: the needle (knife, 1–4) that cuts this line, 0 = none.
 * Ink/Stitch `cutwork_needle`.
 */
cutworkNeedle: number, };

export type ZigzagParams = { 
/**
 * Width of the zig-zag (mm).
 */
width: number, 
/**
 * Length of one zig and zag together (mm).
 */
spacing: number, 
/**
 * Extra width on each side (mm).
 */
pullComp: number, 
/**
 * Turn the zig-zags by this angle (degrees, ±89): spokes on curves.
 */
angle: number, };

export type ManualParams = { 
/**
 * Split stitches longer than this (mm, 0 = keep them).
 * Ink/Stitch `max_stitch_length_mm`.
 */
maxLength: number, 
/**
 * Bean repeats per stitch (passes; several values are used in turn).
 */
beanPattern: Array<number>, };

export type StemParams = { 
/**
 * Width of the rope (mm): how far the stitches slant across the line.
 */
width: number, };

export type MotifKind = "wave" | "zigzag" | "scallop" | "loop" | "diamond" | "cross";

export type MotifParams = { kind: MotifKind, 
/**
 * Length of one motif along the line (mm); its height is half of it.
 */
size: number, };

export type RippleParams = { 
/**
 * Number of ripple lines.
 */
lines: number, 
/**
 * Closed shapes: size of the innermost ripple (0..1 of the outline).
 */
minScale: number, 
/**
 * Open lines: distance between the copies (mm).
 */
spacing: number, 
/**
 * Total rotation from the first to the last ripple (degrees).
 */
rotation: number, 
/**
 * Start in the middle (closed) / at the far copy (open).
 */
reverse: boolean, 
/**
 * Centre of the ripples (closed) or the direction to ripple towards (open). Default: the shape's centre.
 */
target: [number, number] | null, 
/**
 * Lines at least this far apart instead of a fixed count (mm, 0 = use
 * `lines`). Ink/Stitch `min_line_dist_mm`.
 */
minLineDist: number, 
/**
 * Leave out this many ripples at the start / end.
 */
skipStart: number, skipEnd: number, 
/**
 * Sew every other copy backwards (back and forth); off: all one way.
 */
flipCopies: boolean, 
/**
 * Bunch the ripples towards one end (> 1) or the other (< 1), and flip it.
 */
exponent: number, flipExponent: boolean, 
/**
 * Rows of needle points staggered over this many lines (0 = even stitches).
 */
staggers: number, 
/**
 * Copies meet in points (Ink/Stitch join style "point") instead of
 * flat connections.
 */
joinPoint: boolean, 
/**
 * A grid across the ripples, its points this far apart (mm, 0 = none),
 * sewn after the ripples or first.
 */
gridSize: number, gridFirst: boolean, 
/**
 * Copies along a guide: scaled on these axes, from `scale_start` to
 * `scale_end` % (Ink/Stitch's default end is 0 %; here 100 %), turned
 * with the guide.
 */
scaleAxis: RippleScaleAxis, scaleStart: number, scaleEnd: number, rotateRipples: boolean, 
/**
 * The outline's own points are the stitches (no running stitch).
 */
manual: boolean, 
/**
 * Open lines without a guide: fanned towards the target (Ink/Stitch)
 * instead of parallel copies `spacing` apart.
 */
fan: boolean, 
/**
 * The guide the copies follow: one line, or a satin (two rails and
 * rungs) the copies are fitted between.
 */
guide: Array<SubPath>, 
/**
 * Satin guide: the line of the outline fitted between the rails
 * (default: from its first to its last point).
 */
anchor: [[number, number], [number, number]] | null, 
/**
 * Satin guide: copies by line count, at the rungs, or as many as fit.
 */
guidePosition: RippleGuidePosition, };

export type RippleScaleAxis = "both" | "x" | "y" | "none";

export type RippleGuidePosition = "lineCount" | "rungs" | "adaptive";

export type RailReverse = "automatic" | "none" | "first" | "second" | "both";

export type SatinMethod = "satin" | "eStitch" | "sStitch" | "zigzag";

export type SatinParams = { method: SatinMethod, 
/**
 * Distance between zigzags (mm).
 */
spacing: number, 
/**
 * Width when the satin is defined by a single centre line (mm).
 */
width: number, 
/**
 * Pull compensation in mm (added to the total width).
 */
pullComp: number, 
/**
 * Pull compensation as percentage of the local width.
 */
pullCompPct: number, 
/**
 * Split stitches longer than this (mm). 0 = never.
 */
maxStitchLength: number, 
/**
 * Shorten every other stitch in tight curves (0..1 fraction inset).
 */
shortStitchInset: number, centerWalk: boolean, contourUnderlay: boolean, 
/**
 * Contour underlay passes, each the first side forward and the second back
 * (a file without it reads 1; foam takes 2).
 */
contourUnderlayRepeats: number, contourInset: number, zigzagUnderlay: boolean, zigzagUnderlaySpacing: number, zigzagUnderlayInset: number, 
/**
 * Underlay chosen by the column's width and the fabric (automatic
 * underlay); the manual underlay switches are ignored then.
 */
underlayAuto: boolean, 
/**
 * Centre walk: passes along the centre (2 = there and back), and where
 * across the column (0 = first rail, 0.5 = centre, 1 = second rail).
 * Ink/Stitch `center_walk_underlay_repeats` / `_position`.
 */
centerWalkRepeats: number, centerWalkPosition: number, 
/**
 * Stitch length of the centre-walk and contour underlay (mm).
 */
underlayStitchLength: number, 
/**
 * Contour / zig-zag underlay inset as a share of the column width, each
 * side (Ink/Stitch `*_underlay_inset_percent`, here 0..1).
 */
contourInsetPct: number, zigzagInsetPct: number, 
/**
 * Zig-zag underlay: split stitches longer than this (mm, 0 = never).
 */
zigzagUnderlayMaxStitch: number, 
/**
 * Stitches in tight curves closer than this get shortened (mm;
 * Ink/Stitch `short_stitch_distance_mm`).
 */
shortStitchDistance: number, 
/**
 * Shortens the column at both ends: satins push the fabric out where
 * they start and end (mm; Ink/Stitch `push_compensation_mm`).
 */
pushComp: number, 
/**
 * Random texture: every stitch up to this much wider / narrower (share of
 * the width, each side) — Ink/Stitch `random_width_increase/decrease_percent`.
 */
randomWider: number, randomNarrower: number, randomSeed: number, 
/**
 * Long stitches split at staggered points (rows of needle points would
 * line up otherwise): every `split_staggers` stitches the pattern repeats
 * (0 = split evenly; Ink/Stitch `split_method` staggered).
 */
splitStaggers: number, 
/**
 * Direction guides: lines across the column that set the stitch angle
 * there (Ink/Stitch rungs); between two guides the angle turns evenly.
 * Kept apart from the paths so editing the outline keeps them.
 */
guides: Array<[[number, number], [number, number]]>, 
/**
 * Two rails with the same number of points: the point pairs act as
 * rungs (Ink/Stitch's convention). Off once the orientation lines have
 * been edited, so the rails can be shaped freely and a deleted line
 * stays deleted.
 */
nodeRungs: boolean, swapRails: boolean, 
/**
 * Which rail runs the wrong way (Ink/Stitch `reverse_rails`):
 * detected automatically, or set when a satin renders strangely.
 */
reverseRails: RailReverse, 
/**
 * Random zig-zag spacing: each stitch's distance to the next varies by
 * up to this share (0..1). Ink/Stitch `random_zigzag_spacing_percent`.
 */
randomSpacing: number, 
/**
 * Split stitches: positions (or, with a random phase, lengths) vary by
 * up to this share (0..1). Ink/Stitch `random_split_jitter_percent`.
 */
splitJitter: number, 
/**
 * Split stitches with a random phase instead of centred (no lines of
 * split points). Ink/Stitch `random_split_phase`.
 */
splitRandomPhase: boolean, 
/**
 * With a random phase: stitches longer than this are split already
 * (mm, 0 = the max stitch length). Ink/Stitch `min_random_split_length_mm`.
 */
splitMinLength: number, 
/**
 * Every sub-path is its own centre-line column (e.g. satin borders around letters).
 */
multi: boolean, 
/**
 * Bisatin: the cover in two columns half as wide, split along the
 * middle, the first sewn to the far end and the second back to the
 * start, over the whole column's underlay; each half has its own pull
 * compensation, so they overlap in the middle. For columns too wide for
 * one stitch (not in Ink/Stitch; effepol/NOVAstitch-designer, module n).
 * Not with 3D.
 */
bisatin: boolean, reverse: boolean, 
/**
 * The second rail's own values where Ink/Stitch gives two ("0.2 0.5").
 */
secondRail: SecondRail | null, 
/**
 * Sewn over 3D foam (absent: a normal satin).
 */
foam: FoamOptions | null, 
/**
 * Layered 3D: inner layers under the column (absent: a normal satin).
 */
layered: LayeredOptions | null, };

export type FillMethod = "tatami" | "contour" | "spiral" | "radial" | "hilbert" | "stipple" | "meander" | "guided" | "circular" | "flow" | "curved" | "cross" | "tartan";

export type TartanParams = { 
/**
 * Ink/Stitch's palette code: `(colour)width` stripes, `/` a symmetric
 * sett, `?` not sewn, `*` in the previous colour, `warp|weft`.
 */
palette: string, 
/**
 * Turn of the whole pattern (degrees).
 */
rotate: number, 
/**
 * Shift of the stripes (mm, x y).
 */
offset: [number, number], 
/**
 * Reflect the sett at its pivots (also when the code has no `/`).
 */
symmetry: boolean, 
/**
 * Size of the pattern (%).
 */
scale: number, 
/**
 * Stripes this narrow or narrower are sewn as running stitch lines (mm).
 */
minStripeWidth: number, 
/**
 * The rows' angle to the stripes (degrees; Ink/Stitch `tartan_angle`, -45).
 */
angle: number, 
/**
 * Rows of one thread before warp and weft change over.
 */
rowsPerThread: number, 
/**
 * Herringbone: the twill turns every this many mm (0 = a plain twill).
 */
herringbone: number, 
/**
 * Which colour of the palette this layer sews.
 */
layer: number, 
/**
 * Shared id of the layers of one tartan.
 */
group: string, };

export type CarvePattern = "none" | "diamonds" | "waves" | "chevrons" | "bricks" | "circles";

export type CrossKind = "cross" | "half" | "upright" | "double" | "smyrna";

export type FlowField = { origin: [number, number], cell: number, cols: number, rows: number, angles: Array<number>, };

export type GuidedStrategy = "copy" | "parallel" | "buffer";

export type TatamiRoute = "oneWay" | "inkStitch";

export type MeanderPattern = "square" | "triangle" | "hexagon";

export type FillParams = { method: FillMethod, 
/**
 * Row direction in degrees (counter-clockwise on screen).
 */
angle: number, rowSpacing: number, 
/**
 * Optional gradient: row spacing at the end of the fill (0 = disabled).
 */
endRowSpacing: number, maxStitchLength: number, 
/**
 * Rows repeat their stitch pattern every N rows (tatami stagger).
 */
staggers: number, 
/**
 * Tatami rows: stitch lengths used in turn along a row (mm, e.g. 4, 2:
 * long and short; empty: every stitch the max stitch length). Not in
 * Ink/Stitch (effepol/NOVAstitch-designer, module n).
 */
lengthPattern: Array<number>, 
/**
 * Tatami rows: where each row's pattern begins, as shares of the
 * pattern's length, used in turn row after row (e.g. 0, ⅓, ⅔; empty:
 * the staggers). Not in Ink/Stitch.
 */
rowOffsets: Array<number>, pullComp: number, underlay: boolean, 
/**
 * Underlay angle relative to the fill angle (degrees).
 */
underlayAngle: number, underlaySpacing: number, underlayInset: number, underlayStitchLength: number, 
/**
 * Underlay chosen by the object's size and the fabric (automatic
 * underlay); the manual underlay settings are ignored then.
 */
underlayAuto: boolean, 
/**
 * An edge run (running stitch just inside the outline) before the
 * tatami underlay: crisp, stable edges.
 */
underlayEdge: boolean, 
/**
 * A second tatami underlay pass, the two crossing at ±45° to the
 * underlay angle (Ink/Stitch: a list of underlay angles; a double
 * tatami underlay) — for soft and stretchy fabrics.
 */
underlayCross: boolean, 
/**
 * Underlay passes at these angles (relative to the fill angle); when
 * set, they replace the underlay angle and the cross-hatch. Ink/Stitch
 * `fill_underlay_angle` with several values.
 */
underlayAngles: Array<number>, 
/**
 * Running-style fills (meander, circular, contour, spiral): the path sewn
 * this many times, and every stitch as a bean stitch (Ink/Stitch
 * `repeats`, `bean_stitch_repeats`).
 */
repeats: number, beanRepeats: number, 
/**
 * Spiral contour: in on every other ring and out on the rest, ending
 * next to the start (Ink/Stitch `contour_strategy` = double spiral).
 */
contourDouble: boolean, 
/**
 * Contour / spiral: go round clockwise on screen (Ink/Stitch
 * `clockwise`, default true). Stored as `contourClockwise`: documents
 * before it stored `clockwise` with the opposite meaning (true went
 * round counter-clockwise on screen); they are read flipped, so they
 * sew as before (see [`FillParams`]'s `Deserialize`).
 */
contourClockwise: boolean, 
/**
 * Tatami: pull compensation as a share of each row's length, each side
 * (Ink/Stitch `pull_compensation_percent`, here 0..1).
 */
pullCompPct: number, 
/**
 * Tatami: leave out the last stitch of every row (it sits next to the
 * first of the next one). Ink/Stitch `skip_last`.
 */
skipLast: boolean, 
/**
 * Underlay: leave out the last stitch of every row too.
 */
underlaySkipLast: boolean, 
/**
 * Tatami: extra rows sewn past the end of each section before it
 * travels on, against gaps between sections on stretchy fabric
 * (Ink/Stitch `gap_fill_rows`; rounded up to an even number).
 */
gapFillRows: number, 
/**
 * Travel inside the shape between sections (off: along the outline
 * only). Ink/Stitch `underpath`.
 */
underpath: boolean, 
/**
 * Guided fill: copies of the guide, or rows parallel to it.
 */
guidedStrategy: GuidedStrategy, 
/**
 * Tatami: start in the middle and sew outwards to either side, so the
 * fabric is pushed out evenly rather than all towards one end.
 */
centerOut: boolean, 
/**
 * Tatami (rows and underlay): one way from top to bottom, or Ink/Stitch's
 * stitch path. Centre out goes first.
 */
tatamiRoute: TatamiRoute, 
/**
 * Stitch length for travel/underpath running stitches.
 */
travelLength: number, 
/**
 * Radial fill centre relative to the shape bounding box (0..1).
 */
center: [number, number], 
/**
 * With an end row spacing: interpolate the stitch *density* (rows per
 * mm) instead of the spacing, so two overlapping fills with opposite
 * gradients add up to an even coverage (colour blending).
 */
gradientDensity: boolean, 
/**
 * Multi-colour gradient: this fill is one colour layer of it.
 */
gradient: GradientParams | null, 
/**
 * Tartan: this fill is one colour layer of it.
 */
tartan: TartanParams | null, 
/**
 * Meander fill: lattice, cell size (mm), smoothness (0..1) and seed.
 */
meanderPattern: MeanderPattern, 
/**
 * Meander fill: an Ink/Stitch tile (`tiles/<id>`) instead of the lattice;
 * `meander_scale` 2.5 mm ≙ the tile at 100 %.
 */
meanderTile: string | null, meanderScale: number, 
/**
 * Meander: height of the pattern relative to its width (Ink/Stitch's
 * separate x / y `meander_scale_percent`; 1 = as drawn).
 */
meanderAspect: number, 
/**
 * Meander: sewn as a zig-zag of this zig+zag length (mm, 0 = a plain
 * line) and width. Ink/Stitch `zigzag_spacing_mm`, `zigzag_width_mm`.
 */
meanderZigzag: number, meanderZigzagWidth: number, 
/**
 * Meander: keep the stitches inside the shape (with smoothing or
 * expand they can leave it). Ink/Stitch `clip`.
 */
meanderClip: boolean, smoothness: number, 
/**
 * Seed of the meander and of random stitch lengths.
 */
seed: number, 
/**
 * Random stitch length in the rows (tatami, contour, guided, circular,
 * spiral): each stitch varies by up to this % (0 = even). Ink/Stitch
 * `random_stitch_length_jitter_percent`.
 */
randomLength: number, 
/**
 * Guided fill: the guide line the rows follow (design coordinates).
 */
guide: SubPath | null, 
/**
 * Flow fill: the direction field the rows follow.
 */
flow: FlowField | null, 
/**
 * Curved fill: 0 = straight rows along the fill angle, 1 = rows follow
 * the outline fully.
 */
curve: number, 
/**
 * Flow fill of a gradient: rows run across the colour bands (through
 * the colours) instead of along them.
 */
flowAcross: boolean, 
/**
 * Tatami: a pattern carved into the needle points.
 */
carve: CarvePattern, 
/**
 * Size of the carved pattern (mm).
 */
carveSize: number, 
/**
 * Cross stitch: cell size (mm), how much of a cell must be inside the
 * shape (0..1) and the stitches of a cell.
 */
crossSize: number, crossCoverage: number, crossKind: CrossKind, 
/**
 * Cross stitch grid on the page (true: neighbouring areas line up), or
 * on the shape's own corner (false: the shape stitches the same wherever
 * it is — Ink/Stitch's cross-stitch fonts). Ink/Stitch `canvas_grid_origin`.
 */
crossGridCanvas: boolean, 
/**
 * Cross stitch: the other diagonal first (Ink/Stitch's "flipped" methods).
 */
crossFlip: boolean, 
/**
 * Cross stitch: every diagonal sewn this many times (odd: 1, 3, 5).
 */
crossThreads: number, 
/**
 * Cross stitch: cell height (mm; 0 = square). Ink/Stitch `pattern_size_mm` "x y".
 */
crossSizeY: number, 
/**
 * Upright crosses: a second grid shifted by half a cell (dense upright).
 */
crossDense: boolean, 
/**
 * Cross stitch: split stitches longer than this (mm, 0 = never).
 */
crossMaxLength: number, 
/**
 * Shift of the cross stitch grid (mm, x y). Ink/Stitch `cross_offset_mm`.
 */
crossOffset: [number, number], 
/**
 * Grow (or with < 0 shrink) the shape before fill stitching, against
 * gaps between shapes (mm). Ink/Stitch `expand_mm`.
 */
expand: number, 
/**
 * Density gradient along a vector (a gradient fill and, as two
 * layers with opposite ramps, colour blending). Tatami, flow and curved.
 */
ramp: DensityRamp | null, };

export type RampProfile = "linear" | "easeIn" | "easeOut" | "smooth" | "middle" | "ends";

export type DensityRamp = { from: [number, number], to: [number, number], 
/**
 * Row spacing where the fill is densest (mm).
 */
dense: number, 
/**
 * Row spacing where it is most open (mm).
 */
sparse: number, profile: RampProfile, 
/**
 * Sparse at `from`, dense at `to` (the other layer of a colour blend).
 */
reverse: boolean, 
/**
 * Interpolate the density (rows per mm), not the spacing: two layers
 * with opposite ramps add up to an even coverage (colour blending).
 */
additive: boolean, 
/**
 * The two layers of a colour blend share a group.
 */
group: string | null, };

export type GradientKind = "linear" | "reflected" | "radial" | "conic" | "mesh" | "freeform";

export type MeshNode = { p: [number, number], 
/**
 * Colour layer (stop index) of this node.
 */
c: number, };

export type GradientMesh = { rows: number, cols: number, nodes: Array<MeshNode>, };

export type FreePoint = { p: [number, number], 
/**
 * Colour layer (stop index).
 */
c: number, 
/**
 * Reach of the colour (mm): a larger spread carries it further before it blends.
 */
spread: number, };

export type TransitionCurve = "linear" | "smooth" | "easeIn" | "easeOut" | "sharp" | "steps";

export type GradientMix = "blend" | "dither" | "rows";

export type DitherMethod = "diffusion" | "rows" | "ordered" | "noise" | "bands";

export type GradientStop = { 
/**
 * Position 0..1 along the gradient.
 */
pos: number, 
/**
 * Midpoint of the transition to the next stop (0..1, 0.5 = even).
 */
mid: number, };

export type GradientParams = { kind: GradientKind, 
/**
 * Start and end of the gradient vector (mm).
 */
from: [number, number], to: [number, number], stops: Array<GradientStop>, curve: TransitionCurve, steps: number, dither: DitherMethod, 
/**
 * Blend the colours by density, or dither them cell by cell.
 */
mix: GradientMix, 
/**
 * Dither cell length along the rows (mm).
 */
cell: number, 
/**
 * Which stop this layer sews.
 */
layer: number, 
/**
 * Shared id of the layers of one gradient.
 */
group: string, seed: number, 
/**
 * Nodes of a mesh gradient.
 */
mesh: GradientMesh | null, 
/**
 * Colour points of a freeform gradient.
 */
points: Array<FreePoint>, };

export type TackdownKind = "none" | "run" | "zigzag" | "eStitch";

export type CoverKind = "none" | "satin" | "eStitch";

export type FoamOptions = { 
/**
 * Straight-stitch contour passes: 1 or 2 (more is refused).
 */
contourPasses: number, 
/**
 * The satin's spacing is divided by this (denser over foam).
 */
densityFactor: number, 
/**
 * Caps on the open ends of the columns.
 */
caps: boolean, };

export type LayeredOptions = { 
/**
 * Inner layers: 2 to 4 (5 or more is refused).
 */
layers: number, 
/**
 * Spacing of the core's zig-zag underlay (mm; wider = higher).
 */
underlayZigzagSpacing: number, 
/**
 * How much narrower each inner layer is than the next (mm, both sides together).
 */
shrinkPerLayer: number, 
/**
 * Thread id of the inner layers (none: the object's thread).
 */
baseThread: string | null, };

export type AppliqueParams = { placement: boolean, placementLength: number, 
/**
 * Distance of the placement line inside the edge (mm).
 */
placementInset: number, 
/**
 * Free-edge appliqué: placement line 5 mm inside, no tack-down, one stop
 * for the spray glue and the fabric, then the cover.
 */
freeEdge: boolean, tackdown: TackdownKind, tackdownWidth: number, 
/**
 * Distance of the tack-down centre inside the edge (mm).
 */
tackdownInset: number, tackdownSpacing: number, cover: CoverKind, coverWidth: number, coverSpacing: number, 
/**
 * Shift of the cover stitch centre outwards (mm, negative = inwards).
 */
coverOffset: number, coverUnderlay: boolean, pullComp: number, 
/**
 * Swap the side E-stitch prongs point to.
 */
flip: boolean, 
/**
 * Machine stops after the placement line and after the tack-down.
 */
stops: boolean, };

export type StitchParams = { "type": "none" } | { "type": "running" } & RunningParams | { "type": "satin" } & SatinParams | { "type": "fill" } & FillParams | { "type": "applique" } & AppliqueParams | { "type": "manual" } & ManualParams;

export type Object = { id: string, name: string, 
/**
 * Thread id (see [`Thread::id`]).
 */
thread: string, visible: boolean, locked: boolean, paths: Array<SubPath>, stitch: StitchParams, 
/**
 * Insert a trim after this object even if the next one is close.
 */
trimAfter: boolean, 
/**
 * Insert a machine stop after this object (appliqué, puff, ...).
 */
stopAfter: boolean, 
/**
 * Lock stitches at this object's start and end (Ink/Stitch `ties`).
 */
ties: Ties, 
/**
 * Lock stitches even where the object joins the next one without a
 * trim (Ink/Stitch `force_lock_stitches`).
 */
forceLock: boolean, 
/**
 * Drop stitches shorter than this in this object (mm; none: the
 * machine setting). Ink/Stitch `min_stitch_length_mm`.
 */
minStitch?: number | null, 
/**
 * Gaps to the next object up to this long are sewn through without
 * locks and a trim (mm; none: the machine's trim distance).
 * Ink/Stitch `min_jump_stitch_length_mm`.
 */
minJump?: number | null, 
/**
 * Stitch patterns drawn over the object (Ink/Stitch pattern markers).
 */
patterns?: Array<StitchPattern>, 
/**
 * A linked clone (an SVG `<use>`): it follows another object through
 * its own transform; the editor keeps its shape in step.
 */
clone?: CloneLink | null, 
/**
 * How this object takes part in removing hidden stitching (none: automatic).
 */
hidden?: HiddenRule | null, 
/**
 * Where stitching should begin (Ink/Stitch "starting point" / "fill start" command).
 */
start?: [number, number] | null, 
/**
 * Where stitching should end (Ink/Stitch "ending point" / "fill end" command).
 */
end?: [number, number] | null, 
/**
 * This object's own lock stitches (Ink/Stitch per-element `lock_start`,
 * `lock_end`, `lock_*_scale_*`); what's left out comes from the machine.
 */
lock?: LockOverride | null, 
/**
 * Ink/Stitch `color_sort_index` (lettering fonts): the place of this
 * object's colour when a lettering is sewn colour by colour.
 */
colorSortIndex?: number | null, 
/**
 * How the needle goes on to the next object, chosen by hand; absent:
 * automatic (the gap against the minimum jump and whether it would
 * show). A colour change, `trim_after` and `stop_after` win over it.
 */
link?: ObjectLink | null, };

export type ObjectLink = "join" | "jump";

export type LockOverride = { start: LockStyle | null, end: LockStyle | null, 
/**
 * Size of the shape locks (%), Ink/Stitch `lock_start_scale_percent` / `lock_end_scale_percent`.
 */
startScale: number | null, endScale: number | null, 
/**
 * Length of the back-and-forth lock (mm), Ink/Stitch `lock_start_scale_mm` / `lock_end_scale_mm`.
 */
startLength: number | null, endLength: number | null, };

export type SecondRail = { pullComp: number | null, pullCompPct: number | null, contourInset: number | null, contourInsetPct: number | null, zigzagUnderlayInset: number | null, zigzagInsetPct: number | null, randomWider: number | null, randomNarrower: number | null, };

export type StitchPattern = { paths: Array<SubPath>, 
/**
 * Lines: add needle points where stitches cross them.
 */
add: boolean, 
/**
 * Shapes: leave out the needle points inside them.
 */
remove: boolean, 
/**
 * Which crossings get a point, in turn (1 = every one, "2 1" …).
 */
interval?: Array<number>, offset: number, };

export type CloneLink = { 
/**
 * The original's id.
 */
of: string, 
/**
 * Original → clone transform (a b c d e f, mm) and the rotation in it (degrees).
 */
m: [number, number, number, number, number, number], rot: number, 
/**
 * The clone's own fill angle (Ink/Stitch clone `angle`).
 */
angle?: number | null, };

export type Thread = { id: string, name: string, 
/**
 * "#rrggbb"
 */
color: string, brand: string, code: string, 
/**
 * Weight number (No. 40 …) when it differs from the design's thread
 * weight: sizes the thread in the density model.
 */
weight?: number | null, 
/**
 * Shortest stitch for this thread (mm; none: the machine's): metallics
 * and thick threads fray and break on short stitches. An object's own
 * minimum wins over it.
 */
minStitch?: number | null, };

export type Fabric = "cotton" | "polyester" | "denim" | "knit" | "sheer" | "felt" | "towel" | "cap" | "fleece" | "pique" | "leather" | "canvas" | "silk";

export type FabricProfile = { 
/**
 * Extra pull compensation (mm) added to satins and fills: none from the
 * fabric itself (it comes from the objects, or a fabric calibration).
 */
pullComp: number, 
/**
 * Multiplier for row/zigzag spacing (>1 = less dense).
 */
densityScale: number, 
/**
 * Force underlay on.
 */
forceUnderlay: boolean, 
/**
 * Underlay spacing multiplier.
 */
underlayDensity: number, 
/**
 * Soft, stretchy or pile fabric (knits, fleece, towels, piqué): auto
 * underlay is heavier (cross-hatched tatami, zig-zag earlier).
 */
stretch: boolean, 
/**
 * Delicate or firm fabric where every needle hole shows (silk, leather):
 * auto underlay is lighter.
 */
delicate: boolean, 
/**
 * A knockdown (laydown) layer is sewn under the design: it is the
 * underlay, so auto underlay keeps to edge runs.
 */
knockdown: boolean, };

export type HoopShape = "rect" | "oval";

export type Hoop = { name: string, width: number, height: number, shape?: HoopShape, };

export type Ties = "both" | "start" | "end" | "none";

export type LockStyle = "halfStitch" | "arrow" | "backForth" | "bowtie" | "cross" | "star" | "simple" | "triangle" | "zigzag";

export type MachineSettings = { 
/**
 * Jumps longer than this become trims (mm).
 */
trimDistance: number, 
/**
 * Add tie-in/tie-off lock stitches.
 */
ties: boolean, 
/**
 * Lock stitch shapes at the start and the end of a stitch run
 * (Ink/Stitch `lock_start` / `lock_end`).
 */
lockStart: LockStyle, lockEnd: LockStyle, 
/**
 * Size of the shape locks (%, Ink/Stitch `lock_*_scale_percent`).
 */
lockScale: number, 
/**
 * Length of the back-and-forth lock (mm, Ink/Stitch `lock_*_scale_mm`).
 */
lockLength: number, 
/**
 * Minimum stitch length; shorter stitches are dropped (mm).
 */
minStitch: number, 
/**
 * Maximum single needle movement before splitting (mm).
 */
maxStitch: number, 
/**
 * Machine speed for time estimates (stitches per minute).
 */
spm: number, 
/**
 * Seconds per trim / colour change for time estimates.
 */
trimSeconds: number, colorChangeSeconds: number, 
/**
 * The machine / settings preset these came from (UI id; informational).
 */
profile: string | null, 
/**
 * The thread cutter: which trims the machine really cuts (the UI's
 * preview and hand-trim count, `ui/src/lib/cuts.ts`; the plan and the
 * files are the same either way).
 */
cutter: Cutter | null, 
/**
 * `Cutter::Jumps`: the machine's jump trimming length (mm).
 */
cutOver: number | null, };

export type Cutter = "trims" | "jumps" | "none";

export type Basting = "none" | "box" | "contour";

export type CoverMode = "auto" | "always" | "never";

export type HiddenRule = { 
/**
 * Does it hide what's under it?
 */
covers: CoverMode, 
/**
 * Keep all of its own stitches, even where something hides them.
 */
keep: boolean, };

export type PresetSet = "filum" | "nova";

export type DesignOptions = { 
/**
 * Remove fill stitching hidden under objects stacked on top (remove overlaps).
 */
removeOverlaps: boolean, 
/**
 * How far a lower fill still reaches under the object above (mm).
 */
overlapMargin: number, 
/**
 * Objects with no part at least this wide don't hide what's under
 * them (outlines, thin borders, narrow satins), mm.
 */
coverMinWidth: number, 
/**
 * Fills and satins with rows further apart than this are open and
 * don't hide what's under them, mm.
 */
coverMaxSpacing: number, 
/**
 * Textured fills (stipple, meander, Hilbert, cross stitch) hide what's under them.
 */
texturedCovers: boolean, 
/**
 * An appliqué's fabric hides what's under it.
 */
appliqueCovers: boolean, 
/**
 * Leftover pieces (and holes) smaller than this are not worth a
 * jump: pieces are dropped, holes stitched over, mm².
 */
minFragment: number, 
/**
 * Keep the full underlay under the parts that are removed (steadier
 * fabric under the object on top).
 */
keepUnderlay: boolean, 
/**
 * Running stitches under a cover are removed too.
 */
trimRunning: boolean, 
/**
 * Basting stitched first to hold fabric and stabiliser together.
 */
basting: Basting, 
/**
 * Distance of the basting from the design (mm).
 */
bastingMargin: number, bastingLength: number, 
/**
 * Thread weight of the top thread (No. 40 = the standard); scales
 * satin and fill spacing (`thread_density_scale`).
 */
threadWeight: number, 
/**
 * Travel stitches keep off the needle holes their object made before
 * (`stitches::holes`; not in Ink/Stitch). Off: stitch for stitch as Ink/Stitch.
 */
avoidHoles: boolean, 
/**
 * A gap to the next object up to 12 mm that what is sewn later covers
 * all along is sewn through instead of trimmed (branching; not in
 * Ink/Stitch). Off: trimmed as Ink/Stitch does.
 */
hiddenTravel: boolean, 
/**
 * The editor's starting values for new satins and fills on this fabric
 * (ui/src/lib/fabricPresets.ts); none: Ink/Stitch's. The engine only
 * keeps it, so a document it returns still has it.
 */
presetSet: PresetSet | null, 
/**
 * Knockdown (laydown stitch): a light net sewn first under the
 * whole design to flatten the nap of towels, fleece and fur, so the
 * embroidery does not sink in.
 */
knockdown: boolean, 
/**
 * How far the knockdown reaches beyond the design (mm).
 */
knockdownOffset: number, 
/**
 * Row distance of the net (mm) and its stitch length (mm).
 */
knockdownSpacing: number, knockdownLength: number, 
/**
 * One layer, or two crossing at 90° (denser nap).
 */
knockdownLayers: number, 
/**
 * Angle of the first layer (degrees).
 */
knockdownAngle: number, 
/**
 * Thread colour (#rrggbb): usually the fabric's, so it disappears.
 */
knockdownColor: string, 
/**
 * Leave the design's holes (letter counters, gaps) unflattened.
 */
knockdownHoles: boolean, 
/**
 * The point that becomes 0,0 in machine files (Ink/Stitch "origin"
 * command); none: the centre of the design.
 */
origin: [number, number] | null, 
/**
 * Where the frame moves before every stop (Ink/Stitch "stop position",
 * a.k.a. frame out), so the operator can reach the fabric; none: it stays.
 */
stopPosition: [number, number] | null, };

export type Document = { version: number, name: string, threads: Array<Thread>, objects: Array<Object>, hoop: Hoop, fabric: Fabric, machine: MachineSettings, options: DesignOptions, 
/**
 * The colours threads had before they were fitted to a chart or to the
 * user's spools (thread id → original): fitting and merging stay reversible.
 */
threadSources?: { [key in string]: ThreadSource }, 
/**
 * Threads that keep their spool when fitting.
 */
threadLocks?: Array<string>, };

export type ThreadSource = { name: string, color: string, brand: string, code: string, };

export type ObjectQuality = { 
/**
 * Index of the object in the document.
 */
index: number, drops: number, 
/**
 * Stitches shorter than [`SHORT_STITCH`].
 */
short: number, 
/**
 * Stitches shorter than [`SHORT_LINE_STITCH`].
 */
under1mm: number, 
/**
 * Needle drops on a hole the object made before.
 */
rehits: number, 
/**
 * Of those, travel stitches.
 */
travelRehits: number, };

export type HotSpot = { at: [number, number], 
/**
 * Needle drops per mm² within [`HOT_RADIUS`].
 */
perMm2: number, 
/**
 * The object with most drops there (index), then the others.
 */
objects: Array<number>, 
/**
 * Each one's drops there, in the same order.
 */
shares: Array<number>, 
/**
 * Drops there by kind.
 */
top: number, underlay: number, travel: number, ties: number, };

export type NarrowFill = { index: number, 
/**
 * Twice the radius of the largest circle inside it (mm).
 */
width: number, };

export type StitchQuality = { 
/**
 * Needle drops of the design's objects.
 */
drops: number, short: number, rehits: number, travelRehits: number, 
/**
 * The fabric's needle holes per mm² (`Fabric::limits().holes_max`).
 */
holeLimit: number, 
/**
 * The objects with short stitches or re-hit holes.
 */
objects: Array<ObjectQuality>, 
/**
 * Worst first.
 */
hotSpots: Array<HotSpot>, 
/**
 * Visible fills narrower than [`EDGE_RUN_FILL`], with their width.
 */
narrowFills: Array<NarrowFill>, };

export type ThreadSpec = { 
/**
 * Weight number (No. 40 …).
 */
weight: number, 
/**
 * Linear density (g per km). Weight numbers count km per kg of the
 * finished thread only roughly: Madeira Polyneon's data sheets (75 / 60 /
 * 40) and Schmetz's table (30 / 12), else 1080 / weight like No. 40.
 */
tex: number, 
/**
 * Width the thread covers on the fabric (mm): the spacing of thread
 * lines that just covers it — 0.25 mm for No. 40 (Ink/Stitch's fill
 * default), scaled like the engine's spacing (Madeira's density guide).
 */
width: number, };

export type FabricLimits = { 
/**
 * The fabric's own weight (g/m²), typical for the kind.
 */
gsm: number, 
/**
 * Needle holes per mm²: heavy above `holes_heavy`, a risk above `holes_max`.
 */
holesHeavy: number, holesMax: number, 
/**
 * Thread layers: heavy above `layers_heavy`, a risk above `layers_max`.
 */
layersHeavy: number, layersMax: number, 
/**
 * Covering fills and satins below this many layers let the fabric show.
 */
layersMin: number, 
/**
 * Added weight relative to the fabric's: stiff above this.
 */
stiffRatio: number, };

export type DensityClass = "empty" | "thin" | "ok" | "heavy" | "risk";

export type Hotspot = { 
/**
 * Box (mm) and its centre.
 */
x: number, y: number, w: number, h: number, area: number, peakLayers: number, peakHoles: number, 
/**
 * Objects stitching there, most stitches first (document indices).
 */
objects: Array<number>, };

export type DensityStats = { 
/**
 * Stitched area (mm²) and the share of it in each class.
 */
area: number, thin: number, ok: number, heavy: number, risk: number, maxLayers: number, maxHoles: number, 
/**
 * Added weight: the heaviest place and the average over the stitched area (g/m²).
 */
maxAdded: number, meanAdded: number, 
/**
 * Thread used (m): top and bobbin.
 */
topM: number, bobbinM: number, };

export type DensityField = { x0: number, y0: number, cell: number, cols: number, rows: number, layers: Array<number>, holes: Array<number>, 
/**
 * Added weight (g/m²).
 */
added: Array<number>, class: Array<number>, limits: FabricLimits | null, stats: DensityStats, hotspots: Array<Hotspot>, };

export type DensityOptions = { 
/**
 * Smoothing (mm, Gaussian sigma): the scale density is judged at.
 */
sigma: number, 
/**
 * Upper bound on the number of cells (the cell grows for big designs).
 */
maxCells: number, };

export type EndPoint = { id: string, end: [number, number], };

export type OptimizeReport = { order: Array<string>, colorChangesBefore: number, colorChangesAfter: number, trimsBefore: number, trimsAfter: number, 
/**
 * The length of the jumps (mm).
 */
travelBeforeMm: number, travelAfterMm: number, 
/**
 * End points moved towards the next object.
 */
ends: Array<EndPoint>, 
/**
 * Objects whose Sew or Jump went back to Automatic.
 */
linksReset: Array<string>, };

export type Stitch = { x: number, y: number, flags: number, 
/**
 * Index of the source object in the document (u32::MAX for none).
 */
object: number, };

export type StitchPlan = { stitches: Array<Stitch>, 
/**
 * Thread for each colour block, in sewing order.
 */
threads: Array<Thread>, 
/**
 * The records of the basting, `[start, end)`: stitched first and pulled
 * out after sewing (the finished view leaves them out).
 */
basting?: [number, number] | null, 
/**
 * Every connection between consecutive objects, in sewing order: what
 * the plan does there (the editor draws them and lets you choose).
 */
links?: Array<Connection>, };

export type ConnectionKind = "trim" | "jump" | "sew" | "colorChange";

export type Connection = { 
/**
 * The objects (indices in the document) it goes from and to.
 */
from: number, to: number, kind: ConnectionKind, 
/**
 * Chosen by hand (the object's link, trim after or stop after), not automatic.
 */
manual: boolean, 
/**
 * The straight line from `start` to `end` would stay on the fabric
 * visibly: nothing sewn later covers a stretch of it longer than 1 mm.
 */
visible: boolean, 
/**
 * Where the first object ends and the next starts (mm).
 */
start: [number, number], end: [number, number], };

export type PlanStats = { stitches: number, jumps: number, trims: number, colorChanges: number, stops: number, width: number, height: number, 
/**
 * Top thread length in metres (incl. penetration allowance).
 */
threadM: number, 
/**
 * Bobbin thread length in metres (estimate).
 */
bobbinM: number, 
/**
 * Estimated sewing time in seconds.
 */
seconds: number, 
/**
 * Per colour block top-thread metres.
 */
threadPerColorM: Array<number>, stitchesPerColor: Array<number>, };

export type ObjectInfo = { id: string, name: string, 
/**
 * Thread colour `#rrggbb`.
 */
color: string, 
/**
 * The stitch type ("fill", "satin", "running", "applique", "manual", "none").
 */
kind: string, 
/**
 * Fill / satin method, or the running stitch's variant ("bean", "ripple", …).
 */
method: string, width: number, height: number, stitches: number, 
/**
 * Stitches shorter than the minimum stitch length, left out (Ink/Stitch
 * "Small stitches (removed)").
 */
smallRemoved: number, 
/**
 * Jumps inside the object (not the one that brings the needle to it).
 */
jumps: number, maxStitch: number, minStitch: number, 
/**
 * The object is not stitched (hidden, or fully covered with "remove hidden stitching").
 */
hidden: boolean, };

export type TotalInfo = { objects: number, width: number, height: number, 
/**
 * Distinct thread colours.
 */
colors: number, colorChanges: number, jumps: number, trims: number, stops: number, stitches: number, smallRemoved: number, maxStitch: number, minStitch: number, 
/**
 * Ink/Stitch "Filter stitches smaller than (mm)": the machine setting.
 */
minStitchFilter: number, };

export type ElementInfo = { objects: Array<ObjectInfo>, total: TotalInfo, };
