// Mirrors crates/core/src/model.rs (camelCase JSON). Units: millimetres, y down.

export type Vec2 = [number, number];

export interface PathNode {
  p: Vec2;
  i?: Vec2;
  o?: Vec2;
}

export interface SubPath {
  nodes: PathNode[];
  closed: boolean;
}

export interface RunningParams {
  length: number;
  tolerance: number;
  repeats: number;
  beanRepeats: number;
  /** Ripple stitch: the line repeated as ripples (Ink/Stitch). */
  ripple?: RippleParams;
  /** Stem stitch: slanted, half-overlapping stitches — a rope (width mm). */
  stem?: { width: number };
  /** Motif run: a pattern repeated along the line. */
  motif?: { kind: MotifKind; size: number };
  /** Zig-zag line (Ink/Stitch zig-zag stroke): width, zig+zag length, pull comp. each side (mm), angle (°). */
  zigzag?: { width: number; spacing: number; pullComp: number; angle: number };
  /** Several stitch lengths used in turn (Ink/Stitch "2 1"); overrides length. */
  lengthPattern?: number[];
  /** Bean repeats (passes) per stitch in turn; overrides beanRepeats. */
  beanPattern?: number[];
  /** Random stitch length: ± this % (0 = even). */
  randomLength?: number;
  randomSeed?: number;
  /** Cutwork: the needle (knife, 1..4) that cuts this line (Ink/Stitch cutwork_needle). */
  cutworkNeedle?: number;
}

export type MotifKind = "wave" | "zigzag" | "scallop" | "loop" | "diamond" | "cross";
export type CarvePattern = "none" | "diamonds" | "waves" | "chevrons" | "bricks" | "circles";
export type CrossKind = "cross" | "half" | "upright" | "double" | "smyrna";

/** Ripple stitch: closed shapes spiral inwards, open lines go back and forth. */
export interface RippleParams {
  lines: number;
  /** Closed shapes: size of the innermost ripple (0..1). */
  minScale: number;
  /** Open lines: distance between the copies (mm). */
  spacing: number;
  /** Rotation from the first to the last ripple (°). */
  rotation: number;
  reverse: boolean;
  /** Centre (closed) / side to ripple towards (open); default: the shape's centre. */
  target?: Vec2;
  /** Lines at least this far apart instead of a count (mm, 0 = use lines). */
  minLineDist?: number;
  skipStart?: number;
  skipEnd?: number;
  /** Every other copy sewn backwards (default on). */
  flipCopies?: boolean;
  /** Bunch the ripples to one end (> 1) or the other (< 1). */
  exponent?: number;
  flipExponent?: boolean;
  staggers?: number;
  /** Copies meet in points (Ink/Stitch join style "point"). */
  joinPoint?: boolean;
  /** A grid across the ripples, points this far apart (mm, 0 = none), sewn last or first. */
  gridSize?: number;
  gridFirst?: boolean;
  /** Copies along a guide: scaled on these axes from scaleStart to scaleEnd %, turned with it. */
  scaleAxis?: "both" | "x" | "y" | "none";
  scaleStart?: number;
  scaleEnd?: number;
  rotateRipples?: boolean;
  /** The outline's own points are the stitches. */
  manual?: boolean;
  /** Open lines without a guide: fanned towards the target instead of parallel copies. */
  fan?: boolean;
  /** Guide: one line, or a satin's rails (and rungs). */
  guide?: SubPath[];
  /** Satin guide: the line of the outline fitted between the rails. */
  anchor?: [Vec2, Vec2];
  /** Satin guide: copies by line count, at the rungs, or as many as fit. */
  guidePosition?: "lineCount" | "rungs" | "adaptive";
}

export type SatinMethod = "satin" | "eStitch" | "sStitch" | "zigzag";

export interface SatinParams {
  method: SatinMethod;
  spacing: number;
  width: number;
  pullComp: number;
  pullCompPct: number;
  maxStitchLength: number;
  shortStitchInset: number;
  centerWalk: boolean;
  contourUnderlay: boolean;
  contourInset: number;
  zigzagUnderlay: boolean;
  zigzagUnderlaySpacing: number;
  zigzagUnderlayInset: number;
  /** Underlay chosen by the column width and the fabric (the switches above are ignored then). */
  underlayAuto?: boolean;
  /** Centre walk passes (2 = there and back) and position across the column (0..1). */
  centerWalkRepeats?: number;
  centerWalkPosition?: number;
  /** Centre-walk and contour underlay stitch length (mm). */
  underlayStitchLength?: number;
  /** Underlay insets as a share of the column width, each side (0..1). */
  contourInsetPct?: number;
  zigzagInsetPct?: number;
  /** Split zig-zag underlay stitches longer than this (mm, 0 = never). */
  zigzagUnderlayMaxStitch?: number;
  /** Short stitches in tight curves: below this distance (mm). */
  shortStitchDistance?: number;
  /** Column ends pulled in (mm). */
  pushComp?: number;
  /** Random width texture (share each side) and its seed. */
  randomWider?: number;
  randomNarrower?: number;
  randomSeed?: number;
  /** Long stitches split at staggered points, repeating every n (0 = evenly). */
  splitStaggers?: number;
  /** Split points moved (or, with a random phase, lengths varied) by up to this share (0..1). */
  splitJitter?: number;
  /** Split points at a random phase instead of centred. */
  splitRandomPhase?: boolean;
  /** With a random phase: split stitches longer than this already (mm, 0 = max stitch length). */
  splitMinLength?: number;
  /** Each stitch's spacing varies by up to this share (0..1). */
  randomSpacing?: number;
  /** Which rail runs the wrong way (default automatic). */
  reverseRails?: "automatic" | "none" | "first" | "second" | "both";
  /** Direction guides: lines across the column setting the stitch angle (Ink/Stitch rungs). */
  guides?: [Vec2, Vec2][];
  swapRails: boolean;
  reverse: boolean;
  /** Every sub-path is its own centre-line column (letter borders). */
  multi?: boolean;
  /** The second rail's own values where Ink/Stitch gives two ("0.2 0.5"). */
  secondRail?: {
    pullComp?: number;
    pullCompPct?: number;
    contourInset?: number;
    contourInsetPct?: number;
    zigzagUnderlayInset?: number;
    zigzagInsetPct?: number;
    randomWider?: number;
    randomNarrower?: number;
  };
}

export type FillMethod = "tatami" | "contour" | "spiral" | "radial" | "hilbert" | "stipple" | "meander" | "guided" | "circular" | "flow" | "curved" | "cross" | "tartan";

/** Direction field (design mm) for flow fills: row angles in radians, row-major. */
export interface FlowField {
  origin: Vec2;
  cell: number;
  cols: number;
  rows: number;
  angles: number[];
}
export type MeanderPattern = "square" | "triangle" | "hexagon";

/** How the density changes along a ramp (0 = densest, 1 = sparsest). */
export type RampProfile = "linear" | "easeIn" | "easeOut" | "smooth" | "middle" | "ends";

/** Density gradient along a vector (design mm). */
export interface DensityRamp {
  from: Vec2;
  to: Vec2;
  /** Row spacing where densest / most open (mm). */
  dense: number;
  sparse: number;
  profile: RampProfile;
  /** Sparse at `from` (the second layer of a colour blend). */
  reverse?: boolean;
  /** Interpolate density, not spacing (blend layers add up evenly). */
  additive?: boolean;
  /** The two layers of a colour blend share a group. */
  group?: string;
}

export interface FillParams {
  method: FillMethod;
  angle: number;
  rowSpacing: number;
  endRowSpacing: number;
  maxStitchLength: number;
  staggers: number;
  pullComp: number;
  underlay: boolean;
  underlayAngle: number;
  underlaySpacing: number;
  underlayInset: number;
  underlayStitchLength: number;
  /** Underlay chosen by the shape's size and the fabric (the settings above are ignored then). */
  underlayAuto?: boolean;
  /** An edge run (running stitch just inside the outline) before the tatami underlay. */
  underlayEdge?: boolean;
  /** Two tatami underlay passes crossing at ±45° to the underlay angle. */
  underlayCross?: boolean;
  /** Underlay passes at these angles (relative); replaces the angle and the cross-hatch. */
  underlayAngles?: number[];
  /** Running-style fills: the path sewn this many times, bean stitch repeats. */
  repeats?: number;
  beanRepeats?: number;
  /** Spiral: in on every other ring, out on the rest. */
  contourDouble?: boolean;
  /** Contour / spiral: clockwise on screen (Ink/Stitch's default; absent = clockwise). */
  contourClockwise?: boolean;
  /** Older designs: the contour direction with the opposite meaning (true = counter-clockwise). Read only. */
  clockwise?: boolean;
  /** Tatami: pull compensation as a share of each row's length, each side (0..1). */
  pullCompPct?: number;
  /** Tatami: leave out the last stitch of every row. */
  skipLast?: boolean;
  /** Underlay: leave out the last stitch of every row. */
  underlaySkipLast?: boolean;
  /** Travel inside the shape between sections (off: along the outline only). */
  underpath?: boolean;
  /** Guided fill: copies of the guide, rows parallel to it, or also round its ends. */
  guidedStrategy?: "copy" | "parallel" | "buffer";
  /** Tatami: start in the middle and sew outwards to either side. */
  centerOut?: boolean;
  travelLength: number;
  center: Vec2;
  /** With an end row spacing: interpolate density instead of spacing (colour blending). */
  gradientDensity?: boolean;
  /** This fill is one colour layer of a multi-colour gradient. */
  gradient?: GradientParams;
  /** Tatami: extra rows into the gap at the end of each section (Ink/Stitch gap_fill_rows, even). */
  gapFillRows?: number;
  /** Random stitch length in the rows: ± this % (0 = even; not meander / cross). */
  randomLength?: number;
  /** Meander fill: lattice, cell size (mm), smoothness (0..1), random seed. */
  meanderPattern?: MeanderPattern;
  /** Meander fill: an Ink/Stitch tile id instead of the lattice (meanderScale 2.5 mm ≙ 100 %). */
  meanderTile?: string;
  meanderScale?: number;
  /** Meander: height relative to width (1 = as drawn). */
  meanderAspect?: number;
  /** Meander as a zig-zag: zig+zag length (0 = plain line) and width (mm). */
  meanderZigzag?: number;
  meanderZigzagWidth?: number;
  /** Meander: keep stitches inside the shape. */
  meanderClip?: boolean;
  smoothness?: number;
  seed?: number;
  /** Guided fill: the line the rows follow. */
  guide?: SubPath;
  /** Flow fill: the direction field the rows follow. */
  flow?: FlowField;
  /** Density gradient along a vector (gradient fill / colour blending). */
  ramp?: DensityRamp;
  /** Tartan: this fill is one colour layer of it. */
  tartan?: TartanParams;
  /** Tatami: needle points carved into a pattern (program split). */
  carve?: CarvePattern;
  carveSize?: number;
  /** Cross stitch: cell size (mm), share of a cell inside the shape, stitches per cell. */
  crossSize?: number;
  crossCoverage?: number;
  crossKind?: CrossKind;
  /** Cross stitch grid on the page (default) or on the shape's own corner (stitches the same anywhere). */
  crossGridCanvas?: boolean;
  /** The other diagonal first (Ink/Stitch's flipped methods). */
  crossFlip?: boolean;
  /** Every diagonal sewn this many times (1, 3, 5). */
  crossThreads?: number;
  /** Cell height, mm (0 / unset = square cells). */
  crossSizeY?: number;
  /** Upright crosses: a second grid shifted by half a cell (dense upright). */
  crossDense?: boolean;
  /** Split cross stitches longer than this, mm (0 = never; default 11). */
  crossMaxLength?: number;
  /** Shift of the cross stitch grid, mm (x, y). */
  crossOffset?: [number, number];
  /** Grow (or shrink, < 0) the shape before fill stitching, mm (Ink/Stitch "expand"). */
  expand?: number;
  /** Curved fill: 0 = straight rows along the angle, 1 = rows follow the outline. */
  curve?: number;
  /** Flow fill of a gradient: rows run across the colour bands instead of along them. */
  flowAcross?: boolean;
}

/** How a gradient's colours share the shape. */
export type GradientMix = "blend" | "rows" | "dither";

export type GradientKind = "linear" | "reflected" | "radial" | "conic" | "mesh" | "freeform";

/** A node of a gradient mesh: position and colour layer. */
export interface MeshNode {
  p: Vec2;
  c: number;
}

/** `rows` × `cols` nodes, row by row; four neighbours span a patch. */
export interface GradientMesh {
  rows: number;
  cols: number;
  nodes: MeshNode[];
}

/** A colour point of a freeform gradient. */
export interface FreePoint {
  p: Vec2;
  c: number;
  /** Reach of the colour (mm). */
  spread: number;
}
export type TransitionCurve = "linear" | "smooth" | "easeIn" | "easeOut" | "sharp" | "steps";
export type DitherMethod = "diffusion" | "rows" | "ordered" | "noise" | "bands";

export interface GradientStop {
  /** 0..1 along the gradient. */
  pos: number;
  /** Where the 50 % mix to the next stop sits (0..1). */
  mid: number;
}

/** Multi-colour gradient: one fill layer per stop sharing one row grid. */
export interface GradientParams {
  kind: GradientKind;
  from: Vec2;
  to: Vec2;
  stops: GradientStop[];
  curve: TransitionCurve;
  steps: number;
  dither: DitherMethod;
  /** Blend the colours by density (default); straight rows can also alternate whole rows or dither cell by cell. */
  mix?: GradientMix;
  /** Dither cell length along the rows (mm). */
  cell: number;
  /** Which stop this layer sews. */
  layer: number;
  /** Shared by the layers of one gradient. */
  group: string;
  seed: number;
  /** Mesh gradient nodes (kind "mesh"). */
  mesh?: GradientMesh;
  /** Freeform colour points (kind "freeform"). */
  points?: FreePoint[];
}

export type TackdownKind = "none" | "run" | "zigzag" | "eStitch";
export type CoverKind = "none" | "satin" | "eStitch";

/** Appliqué: placement line → stop → tack-down → stop → cover stitch. */
export interface AppliqueParams {
  placement: boolean;
  placementLength: number;
  tackdown: TackdownKind;
  tackdownWidth: number;
  tackdownInset: number;
  tackdownSpacing: number;
  cover: CoverKind;
  coverWidth: number;
  coverSpacing: number;
  coverOffset: number;
  coverUnderlay: boolean;
  pullComp: number;
  flip: boolean;
  stops: boolean;
}

export type StitchParams =
  | { type: "none" }
  | { type: "manual"; maxLength?: number; beanPattern?: number[] }
  | ({ type: "running" } & RunningParams)
  | ({ type: "satin" } & SatinParams)
  | ({ type: "fill" } & FillParams)
  | ({ type: "applique" } & AppliqueParams);

export type StitchType = StitchParams["type"];

/** Whether an object hides the stitching under it: by the design's rules, always or never. */
export type CoverMode = "auto" | "always" | "never";
/** An object's own setting for hidden stitching. */
export interface HiddenRule {
  covers?: CoverMode;
  /** Keep all of its own stitches, even where something hides them. */
  keep?: boolean;
}

export interface DesignObject {
  id: string;
  name: string;
  thread: string;
  visible: boolean;
  locked: boolean;
  paths: SubPath[];
  stitch: StitchParams;
  trimAfter: boolean;
  stopAfter: boolean;
  /** Lock stitches at this object's start and end (default both). */
  ties?: "both" | "start" | "end" | "none";
  /** Lock even where the next object follows without a trim. */
  forceLock?: boolean;
  /** This object's minimum stitch length (mm; default: the machine's). */
  minStitch?: number;
  /** Gaps after this object up to this long are sewn through without a trim (mm; default: the trim distance). */
  minJump?: number;
  /** Where stitching begins (Ink/Stitch starting point / fill start command), mm. */
  start?: Vec2;
  /** Where stitching ends (Ink/Stitch ending point / fill end command), mm. */
  end?: Vec2;
  /** This object's own lock stitches (Ink/Stitch per-element lock settings); left out: the machine's. */
  lock?: { start?: LockStyle; end?: LockStyle; startScale?: number; endScale?: number; startLength?: number; endLength?: number };
  /** Ink/Stitch `color_sort_index` (lettering fonts): this colour's place when sewn colour by colour. */
  colorSortIndex?: number;
  /** An auto-routed line: it travels back over itself on purpose (its underpaths). */
  routed?: boolean;
  /** Parametric lettering this object belongs to (regenerated when edited). */
  text?: import("./lib/text").TextSpec;
  /** Objects with the same group are selected and transformed together. */
  group?: string;
  /** Stitch patterns drawn over the object (Ink/Stitch pattern markers). */
  patterns?: StitchPattern[];
  /** How it takes part in removing hidden stitching (none: automatic). */
  hidden?: HiddenRule;
  /** Linked clone: follows another object through its own transform (see lib/clones). */
  clone?: import("./lib/clones").CloneLink;
}

export interface Thread {
  id: string;
  name: string;
  color: string;
  brand: string;
  code: string;
  /** Weight number (No. 40 …) when it differs from the design's thread weight. */
  weight?: number;
}

export type Fabric = "cotton" | "polyester" | "denim" | "knit" | "sheer" | "felt" | "towel" | "cap" | "fleece" | "pique" | "leather" | "canvas" | "silk";

export type HoopShape = "rect" | "oval";

export interface Hoop {
  name: string;
  width: number;
  height: number;
  /** Rectangle (default) or an ellipse in the width × height box (round when equal). */
  shape?: HoopShape;
}

/** Lock stitch shapes (Ink/Stitch). */
export type LockStyle = "halfStitch" | "arrow" | "backForth" | "bowtie" | "cross" | "star" | "simple" | "triangle" | "zigzag";

export interface MachineSettings {
  trimDistance: number;
  ties: boolean;
  lockStart?: LockStyle;
  lockEnd?: LockStyle;
  /** Size of the shape locks (%). */
  lockScale?: number;
  /** Length of the back-and-forth lock (mm). */
  lockLength?: number;
  minStitch: number;
  maxStitch: number;
  spm: number;
  trimSeconds: number;
  colorChangeSeconds: number;
  /** The preset these came from: a machine profile id, "filum" or "inkstitch". */
  profile?: string;
  /** The thread cutter: cuts every trim (the default), cuts only jumps
   *  longer than `cutOver`, or none (you snip every jump by hand). */
  cutter?: "trims" | "jumps" | "none";
  /** "jumps": the machine's jump trimming length (mm, 5 on Brother). */
  cutOver?: number;
}

export type Basting = "none" | "box" | "contour";

/** Design-wide processing applied when the stitch plan is built. */
export interface DesignOptions {
  /** Remove stitching hidden under objects stacked on top. */
  removeOverlaps: boolean;
  /** How far a lower fill (or line) still reaches under the object on top, mm. */
  overlapMargin: number;
  /** Objects with no part this wide don't hide what's under them (outlines, thin borders), mm. */
  coverMinWidth?: number;
  /** Fills and satins with rows further apart than this are open and don't hide, mm (0: any). */
  coverMaxSpacing?: number;
  /** Textured fills (stipple, meander, Hilbert, cross stitch) hide what's under them. */
  texturedCovers?: boolean;
  /** An appliqué's fabric hides what's under it. */
  appliqueCovers?: boolean;
  /** Leftover pieces and holes smaller than this are dropped / stitched over, mm². */
  minFragment?: number;
  /** Keep the full underlay under the removed parts. */
  keepUnderlay?: boolean;
  /** Running stitches under a cover are removed too. */
  trimRunning?: boolean;
  basting: Basting;
  bastingMargin: number;
  bastingLength: number;
  /** Top thread weight (No. 40 = standard): scales satin and fill spacing. */
  threadWeight?: ThreadWeight;
  /** Knockdown (laydown): a light net sewn first under the whole design to flatten pile. */
  knockdown?: boolean;
  knockdownOffset?: number;
  knockdownSpacing?: number;
  knockdownLength?: number;
  knockdownLayers?: number;
  knockdownAngle?: number;
  /** #rrggbb, usually the fabric colour. */
  knockdownColor?: string;
  /** Leave the design's holes unflattened. */
  knockdownHoles?: boolean;
  /** The point that becomes 0,0 in machine files (Ink/Stitch origin); none: the design centre. */
  origin?: [number, number];
  /** Where the frame moves before every stop (Ink/Stitch stop position, "frame out"); none: it stays. */
  stopPosition?: [number, number];
}

/** Thread weight numbers (higher = finer). */
export type ThreadWeight = 75 | 60 | 40 | 30 | 12;

export interface StitchDocument {
  version: number;
  name: string;
  threads: Thread[];
  objects: DesignObject[];
  hoop: Hoop;
  fabric: Fabric;
  machine: MachineSettings;
  options?: DesignOptions;
  /** Thread id → its colour before fitting (fits and merges stay reversible). */
  threadSources?: Record<string, ThreadSource>;
  /** Threads that keep their spool when fitting. */
  threadLocks?: string[];
  /** Pictures to trace over (never stitched, never sent to the engine). */
  references?: ReferenceImage[];
  /** Names of object groups (`DesignObject.group` → name); unnamed groups show as "Group n". */
  groupNames?: Record<string, string>;
  /** Nested groups: the group each group sits in (absent: the top level). */
  groupParents?: Record<string, string>;
}

/** A reference picture on the canvas, for tracing. */
export interface ReferenceImage {
  id: string;
  name: string;
  /** The picture as a data URL. */
  src: string;
  /** Unrotated box (mm): top-left and size. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Degrees, clockwise around the box centre. */
  rotation: number;
  opacity: number;
  visible: boolean;
  /** Locked pictures cannot be adjusted on the canvas. */
  locked: boolean;
  /** Behind the stitches or over them (tracing paper). */
  placement: "behind" | "over";
  /** Show in grey: easier to see thread colours on top. */
  grayscale?: boolean;
  /** Mirror horizontally. */
  flip?: boolean;
}

/** A node of a path in the node tool's selection. */
export interface NodeRef {
  id: string;
  sp: number;
  ni: number;
}

/** A thread's original colour (its "need") before it was fitted to a spool. */
export interface ThreadSource {
  name: string;
  color: string;
  brand: string;
  code: string;
}

export interface PlanStats {
  stitches: number;
  jumps: number;
  trims: number;
  colorChanges: number;
  stops: number;
  width: number;
  height: number;
  threadM: number;
  bobbinM: number;
  seconds: number;
  threadPerColorM: number[];
  stitchesPerColor: number[];
}

/** What a fabric takes (core density::FabricLimits). */
export interface FabricLimits {
  gsm: number;
  holesHeavy: number;
  holesMax: number;
  layersHeavy: number;
  layersMax: number;
  layersMin: number;
  stiffRatio: number;
}
/** A place beyond what the fabric takes. */
export interface DensityHotspot {
  x: number;
  y: number;
  w: number;
  h: number;
  area: number;
  peakLayers: number;
  peakHoles: number;
  /** Document indices of the objects stitching there, most stitches first. */
  objects: number[];
}
export interface DensityStats {
  area: number;
  thin: number;
  ok: number;
  heavy: number;
  risk: number;
  maxLayers: number;
  maxHoles: number;
  maxAdded: number;
  meanAdded: number;
  topM: number;
  bobbinM: number;
}
/** Density cell by cell (row-major, `cols × rows` cells of `cell` mm from x0, y0). */
export interface DensityField {
  x0: number;
  y0: number;
  cell: number;
  cols: number;
  rows: number;
  /** Thread layers (1 = just covered). */
  layers: Float32Array;
  /** Needle holes per mm². */
  holes: Float32Array;
  /** Added weight (g/m²). */
  added: Float32Array;
  /** 0 empty, 1 thin, 2 ok, 3 heavy, 4 risk. */
  cls: Uint8Array;
  limits: FabricLimits | null;
  stats: DensityStats;
  hotspots: DensityHotspot[];
}

export interface PlanData {
  coords: Float32Array;
  flags: Uint8Array;
  objects: Uint32Array;
  threads: Thread[];
  stats: PlanStats;
  /** The trims the machine leaves uncut (lib/cuts.ts); null when it cuts all. */
  uncut?: import("./lib/cuts").Uncut | null;
  /** The basting's records [start, end): pulled out after sewing. */
  basting?: [number, number] | null;
  /** Records the canvas leaves out (the finished view), 1 = hidden. */
  hide?: Uint8Array | null;
}

export const FLAG = {
  JUMP: 1,
  TRIM: 2,
  COLOR_CHANGE: 4,
  STOP: 8,
  END: 16,
  TIE: 32,
  UNDERLAY: 64,
  TRAVEL: 128,
  COMMANDS: 1 | 2 | 4 | 8 | 16,
} as const;

/** An Ink/Stitch meander tile: segments [x1, y1, x2, y2] and repeat vectors, mm at 100 %. */
export interface MeanderTile {
  id: string;
  name: string;
  shift0: Vec2;
  shift1: Vec2;
  lines: [number, number, number, number][];
}

/** Machine export options. */
export interface ExportOptions {
  /** PES version: 1 (default, Brother thread table) or 6 (adds the exact thread list). */
  pesVersion?: 1 | 6;
  /** Repeats side by side / below each other and their distance (mm) — Ink/Stitch ZIP "panelization". */
  xRepeats?: number;
  yRepeats?: number;
  xSpacing?: number;
  ySpacing?: number;
}

/** One entry (colour block) of a thread list file. */
export interface ThreadListEntry {
  /** #rrggbb, or none: match the line's catalogue numbers in a chart. */
  color: string | null;
  name: string;
  code: string;
  brand: string;
  tokens?: string[];
}

/** Element info (Ink/Stitch element_info) of one object. */
export interface ObjectInfo {
  id: string;
  name: string;
  color: string;
  kind: string;
  method: string;
  width: number;
  height: number;
  stitches: number;
  smallRemoved: number;
  jumps: number;
  maxStitch: number;
  minStitch: number;
  hidden: boolean;
}

/** Element info of a selection (or the whole design). */
export interface ElementInfo {
  objects: ObjectInfo[];
  total: {
    objects: number;
    width: number;
    height: number;
    colors: number;
    colorChanges: number;
    jumps: number;
    trims: number;
    stops: number;
    stitches: number;
    smallRemoved: number;
    maxStitch: number;
    minStitch: number;
    minStitchFilter: number;
  };
}

/** What a machine shows for one colour block of an export. */
export interface MachineColorInfo {
  block: number;
  color: string;
  name: string;
  code: string;
  brand: string;
  /** The machine thread-table entry the file stores (null: no colours in the file). */
  shown: { color: string; name: string; code: string; brand: string; slot: number | null } | null;
  /** The file also stores the exact thread. */
  exact: boolean;
  deltaE: number | null;
}

export interface FormatInfo {
  extension: string;
  name: string;
  canRead: boolean;
  canWrite: boolean;
  machine: boolean;
}

export interface OptimizeReport {
  order: string[];
  colorChangesBefore: number;
  colorChangesAfter: number;
  travelBeforeMm: number;
  travelAfterMm: number;
}

export type OutlineKind = "none" | "running" | "satin";

export interface PaletteEntry {
  name: string;
  code: string;
  rgb: [number, number, number];
}

export interface DigitizeOptions {
  colors: number;
  widthMm: number;
  removeBackground: boolean;
  minRegionMm2: number;
  smoothing: number;
  simplifyMm: number;
  overlapMm: number;
  satinMaxWidthMm: number;
  runningMaxWidthMm: number;
  maxPixels: number;
  palette: PaletteEntry[];
  paletteBrand: string;
  allowSatin: boolean;
  allowRunning: boolean;
  fillMethod: FillMethod;
  fillAngle: number | null;
  rowSpacing: number;
  underlay: boolean;
  fixedColors: [number, number, number][];
  skipColors: [number, number, number][];
  outline: OutlineKind;
  outlineWidthMm: number;
  outlineColor: [number, number, number];
  /** Edge-preserving smoothing passes before colour reduction. */
  denoise?: number;
  /** Merge colours closer than this CIEDE2000 difference (0 = off). */
  mergeDeltaE?: number;
  /** Shared-boundary tracing with perceptual corners. */
  seamless?: boolean;
  cornerAngle?: number;
  /** Row direction; for flow fills the base direction they lean to ("flow" is legacy = flow fill). */
  fillDirection?: "axis" | "image" | "flow";
  /** Flow fill: field cells across a shape (more = finer bends). */
  flowDetail?: number;
  /** Flow fill: smoothing passes of the picture's edge flow. */
  flowSmoothing?: number;
  /** Flow fill: 0..1, follow the picture (1) or the base direction (0). */
  flowStrength?: number;
  /** Gradient fills follow the picture's flow (streamlines) instead of straight rows. */
  gradientFlow?: boolean;
  edgeOutlines?: OutlineKind;
  edgeContrast?: number;
  /** Lines drawn from the picture: coherent lines, learned edges (DexiNed) or a learned line drawing (Informative Drawings). */
  lineArt?: "none" | "coherent" | "edges" | "drawing";
  lineStrength?: number;
  /** Lines in the picture (ink, narrow shapes) become strokes; fills continue under them. */
  lineNetworks?: boolean;
  /** Lines up to this width (mm) are strokes. */
  lineMaxWidthMm?: number;
  /** Dark ink lines found on the picture itself, 0 = off .. 100. */
  inkSensitivity?: number;
  /** Bridge gaps between line ends (mm). */
  lineGapMm?: number;
  /** Shorter lines and side branches are dropped (mm). */
  lineMinMm?: number;
  /** Strokes continue through junctions that bend less than this (degrees). */
  lineContinuity?: number;
  /** Satin lines follow the drawn width. */
  lineTaper?: boolean;
  /** Thin lines as triple stitch. */
  thinTriple?: boolean;
  /** Line centres follow the drawn line, not the pixel grid. */
  lineSubpixel?: boolean;
  /** Outline width (mm): dark lines become satin of exactly this width (0 = as drawn). */
  outlineLineMm?: number;
  /** Lines that meet are routed as one network (no trims between them). */
  routeLines?: boolean;
  /** Zig-zag photo: rows of zigzags in one colour, wider where darker. */
  photoZigzag?: boolean;
  photoSpacing?: number;
  photoAngle?: number;
  photoContrast?: number;
  photoMin?: number;
  /** Colours always sewn as lines. */
  lineColors?: [number, number, number][];
  /** Colours always sewn as fills. */
  fillColors?: [number, number, number][];
  /** Colours with a satin edge in their own thread where they meet the background. */
  edgeColors?: [number, number, number][];
  /** The sew order by colour, first sewn first (each the nearest thread of the result). */
  colorOrder?: [number, number, number][];
  pixelArt?: "auto" | "on" | "off";
  gradients?: boolean;
  masks?: SegMask[];
  edgeMap?: { width: number; height: number; data: string } | null;
  /** Where the background colour is left out: outside and in plain holes, everywhere,
   *  or only where it touches the picture's border (every enclosed area is stitched). */
  backgroundScope?: "outside" | "everywhere" | "border";
  regionEdits?: RegionEdit[];
}

/** A mask for the digitizer (one byte per pixel, base64; stretched over the image). */
export interface SegMask {
  mode: "keep" | "remove" | "separate" | "erase";
  width: number;
  height: number;
  data: string;
}

export interface ColorInfo {
  rgb: [number, number, number];
  hex: string;
  name: string;
  code: string;
  coverage: number;
  background: boolean;
  /** Share of the image in this colour that is not stitched. */
  removed?: number;
  /** Fraction of the picture in this colour sewn as lines. */
  lines?: number;
}

export interface DigitizeResult {
  threads: Thread[];
  objects: DesignObject[];
  colors: ColorInfo[];
  widthMm: number;
  heightMm: number;
}

export interface DigitizePreview {
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
  colors: ColorInfo[];
  widthMm: number;
  heightMm: number;
  sourceWidth: number;
  sourceHeight: number;
  /** Regions the stitched / removed decision is made on (regionWidth × regionHeight). */
  regionWidth: number;
  regionHeight: number;
  /** Region id per pixel. */
  regions: Uint32Array;
  /** Per region: colour index (index into colors; higher = transparent / gradient). */
  regionLabel: Uint8Array;
  /** Per region: why it is not stitched (see REGION_REASON). */
  regionReason: Uint8Array;
}

/** DigitizePreview.regionReason values. */
export const REGION_REASON = { stitched: 0, background: 1, colour: 2, edit: 3, transparent: 4 } as const;

/** A click on a digitizer region (0..1 of the image): stitch it or leave it out. */
export interface RegionEdit {
  x: number;
  y: number;
  keep: boolean;
}

export type ViewMode = "vector" | "stitch" | "realistic";

export type Tool =
  | "select"
  | "node"
  | "pan"
  | "ruler"
  | "pen"
  | "curve"
  | "freehand"
  | "satin"
  | "rect"
  | "ellipse"
  | "text"
  | "cut"
  | "gradient"
  | "builder"
  | "guides";

/** A user-drawn stitch pattern: lines add needle points where stitches cross them, shapes leave the points inside out. */
export interface StitchPattern {
  paths: SubPath[];
  add: boolean;
  remove: boolean;
  /** Which crossings get a point, in turn ("2 1"); empty = every one. */
  interval?: number[];
  /** Crossings skipped before the interval starts. */
  offset: number;
}

/** A tartan (Ink/Stitch tartan fill): palette code, pattern placement, rows. */
export interface TartanParams {
  /** Ink/Stitch palette code: "(colour)width" stripes, "/" symmetric, "?" left out, "*" previous colour, "warp|weft". */
  palette: string;
  rotate: number;
  offset: [number, number];
  symmetry: boolean;
  /** Pattern size (%). */
  scale: number;
  /** Stripes this narrow are sewn as lines (mm). */
  minStripeWidth: number;
  /** Angle of the rows to the stripes (degrees, -45 = twill). */
  angle: number;
  rowsPerThread: number;
  /** Herringbone column width (mm, 0 = plain twill). */
  herringbone: number;
  layer: number;
  group: string;
}
