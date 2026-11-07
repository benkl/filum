import { Ban, Brush, Clipboard, Contrast, Eye, EyeOff, Grid3x3, Image as ImageIcon, ImageUp, Lock, Maximize2, MousePointerClick, Palette, PenLine, Pipette, RotateCcw, ScanEye, ScanLine, ScanText, Shapes, Sparkle, Sparkles, Trash2, Unlock, Waves, Rainbow, Disc3, Grid2x2, type LucideIcon } from "lucide-react";
import { StitchContour, StitchCross, StitchFill, StitchMeander, StitchRadial, StitchSatin, StitchSpiral } from "../icons/stitch";
import { edgeMapImage, toBase64, type EdgeMapData, type SamPoint, type TextLine } from "../lib/mlUtil";
import type { SamImage } from "../lib/ml";

// the model runtime (ONNX Runtime, Tesseract) loads only when the digitizer uses it
const ml = () => import("../lib/ml");
import { createLettering } from "../lib/textOps";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { engine } from "../engine/client";
import { pending } from "../lib/actions";
import { fillMethodDefaults, objectBounds, transformObject, translateMat, uid, unionBoxes } from "../lib/geometry";
import { openFile } from "../lib/platform";
import { DesignView } from "../canvas/DesignView";
import {
  backdropOf,
  backdropPatch,
  DETAIL,
  detailOf,
  DIGITIZE_DEFAULTS,
  DIGITIZE_PRESETS,
  migrateSettings,
  OUTLINE_DEFAULT_MM,
  outlinesOf,
  outlinesPatch,
  presetOf,
  presetSettings,
  type Backdrop,
  type Detail,
  type DigitizeSettings,
  type Outlines,
  type PresetId,
} from "../lib/digitizePresets";
import { CROSS_DEFAULTS, crossStitchDesign, type CrossSettings } from "../lib/crossStitch";
import { CROSS_KINDS } from "./CrossStitchAssistant";
import { emptyDoc, useStore } from "../store";
import { REGION_REASON, type ColorInfo, type DigitizeOptions, type DigitizePreview, type DigitizeResult, type FillMethod, type PaletteEntry, type PlanData, type RegionEdit, type SegMask } from "../types";
import { ChartSelect } from "./ThreadPicker";
import { RegionEditor, regionAt } from "./RegionEditor";
import { chartLabel, loadChart } from "../lib/threads";
import { Dialog, fmtTime, Num, Row, Slider, Toggle } from "./ui";
import { safeSetItem } from "../lib/storage";

type Rgb = [number, number, number];

type Settings = DigitizeSettings;
const DEFAULTS = DIGITIZE_DEFAULTS;

/** What a colour becomes: decided from the picture, or chosen. */
type Role = "auto" | "fill" | "line" | "omit";
const ROLES: { id: Role; icon: ReactNode; label: string; hint: string }[] = [
  { id: "auto", icon: <Sparkles size={12} />, label: "Auto", hint: "Decided from the picture: thin, long shapes and ink become lines, the rest fills" },
  { id: "fill", icon: <StitchFill size={12} />, label: "Fill", hint: "Always a fill — never lines, also not as ink" },
  { id: "line", icon: <PenLine size={12} />, label: "Line", hint: "Always lines along the centre (outlines, details), whatever their width" },
  { id: "omit", icon: <EyeOff size={12} />, label: "Omit", hint: "Leave this colour out" },
];

const PRESET_ICONS: Record<PresetId, ReactNode> = {
  logo: <Shapes size={16} />,
  illustration: <Brush size={16} />,
  drawing: <PenLine size={16} />,
  photo: <ImageIcon size={16} />,
  pixel: <Grid3x3 size={16} />,
};

const FILL_METHODS: { id: FillMethod; icon: LucideIcon; label: string; hint: string }[] = [
  { id: "tatami", icon: StitchFill, label: "Tatami", hint: "Parallel staggered rows — the classic, even fill" },
  { id: "flow", icon: Waves, label: "Flow", hint: "Rows bend with the picture — streamlines along its edges and shading" },
  { id: "curved", icon: Rainbow, label: "Curved", hint: "Rows follow the outline of each shape" },
  { id: "contour", icon: StitchContour, label: "Contour", hint: "Rings that follow the outline of each shape" },
  { id: "spiral", icon: StitchSpiral, label: "Spiral", hint: "One continuous spiral from the outline inwards" },
  { id: "radial", icon: StitchRadial, label: "Sunburst", hint: "Rays from the centre of each shape" },
  { id: "circular", icon: Disc3, label: "Circular", hint: "A spiral around the centre (Ink/Stitch circular fill)" },
  { id: "meander", icon: StitchMeander, label: "Meander", hint: "A quilted random walk — light, few stitches" },
  { id: "hilbert", icon: Grid2x2, label: "Hilbert", hint: "A space-filling curve texture" },
  { id: "stipple", icon: Sparkle, label: "Stipple", hint: "Scattered points joined into one sketchy line" },
];

/** Row direction: per region, from the picture, or one fixed angle. Flow fills lean to it. */
type Direction = "axis" | "image" | "fixed";
const DIRECTIONS: [Direction, string, string][] = [
  ["axis", "Per shape", "Rows run along the long axis of each shape"],
  ["image", "Picture", "Rows follow the dominant direction of the picture in each shape"],
  ["fixed", "Fixed", "One angle for every shape"],
];
/** Lines added on top of the fills: colour edges or a line drawing of the picture. */
type ExtraLines = "none" | "colour" | "coherent" | "edges" | "drawing";
const EXTRA: [ExtraLines, ReactNode, string, string][] = [
  ["none", <Ban key="n" size={15} />, "None", "Only the lines found in the picture itself (Lines in the picture)."],
  ["colour", <Contrast key="c" size={15} />, "Colour edges", "A line along every edge between contrasting colours."],
  ["coherent", <Waves key="w" size={15} />, "Coherent", "A drawing that follows the picture's flow (flow-based difference of Gaussians)."],
  ["edges", <ScanLine key="e" size={15} />, "AI edges", "Learned edges (DexiNed, on-device): both sides of strong edges — shown on the Original tab."],
  ["drawing", <Brush key="d" size={15} />, "AI drawing", "A learned line drawing (Informative Drawings, on-device): single clean lines for photos and illustrations — shown on the Original tab."],
];

/** Fills whose rows have a direction (meander: the pattern's rotation). */
const DIRECTED: FillMethod[] = ["tatami", "flow", "curved", "meander"];

const MASK_MODES: [SegMask["mode"], string, string][] = [
  ["keep", "Keep", "Stitch only the selected objects"],
  ["remove", "Remove", "Never stitch this — leaves a gap"],
  ["erase", "Erase", "Remove it and fill the area from its surroundings"],
  ["separate", "Separate", "Its own objects, even where colours continue outside"],
];

type Pane = "style" | "colours" | "shapes" | "lines" | "stitches" | "cross" | "ai";
const PANES: { id: Pane; label: string; hint: string; icon: ReactNode }[] = [
  { id: "style", label: "Style", hint: "Output, preset, the look and the size", icon: <Sparkles size={15} /> },
  { id: "colours", label: "Colours", hint: "Palette, thread chart and background", icon: <Palette size={15} /> },
  { id: "shapes", label: "Shapes", hint: "Tracing and cleanup", icon: <Shapes size={15} /> },
  { id: "lines", label: "Lines", hint: "Satin strokes, line art and outlines", icon: <StitchSatin size={15} /> },
  { id: "stitches", label: "Stitches", hint: "Fill method, density and direction", icon: <StitchFill size={15} /> },
  { id: "cross", label: "Crosses", hint: "Cell size, kind of cross and coverage", icon: <StitchCross size={15} /> },
  { id: "ai", label: "AI", hint: "Select objects and find text (on-device)", icon: <ScanEye size={15} /> },
];

/** The tab of every remembered option (the compiler checks that none is missing). */
const PANE_OF: Record<keyof Settings, Pane> = {
  maxPixels: "shapes",
  denoise: "shapes",
  pixelArt: "shapes",
  colors: "colours",
  mergeDeltaE: "colours",
  removeBackground: "colours",
  backgroundScope: "colours",
  seamless: "shapes",
  cornerAngle: "shapes",
  gradients: "shapes",
  smoothing: "shapes",
  minRegionMm2: "shapes",
  simplifyMm: "shapes",
  overlapMm: "shapes",
  allowSatin: "lines",
  satinMaxWidthMm: "lines",
  allowRunning: "lines",
  runningMaxWidthMm: "lines",
  lineArt: "lines",
  lineStrength: "lines",
  lineNetworks: "lines",
  lineMaxWidthMm: "lines",
  inkSensitivity: "lines",
  lineGapMm: "lines",
  lineMinMm: "lines",
  lineContinuity: "lines",
  lineTaper: "lines",
  thinTriple: "lines",
  lineSubpixel: "lines",
  outlineLineMm: "lines",
  routeLines: "lines",
  photoZigzag: "style",
  photoSpacing: "style",
  photoAngle: "style",
  photoContrast: "style",
  photoMin: "style",
  edgeOutlines: "lines",
  edgeContrast: "lines",
  outline: "style",
  outlineWidthMm: "style",
  outlineColor: "lines",
  fillMethod: "stitches",
  fillAngle: "stitches",
  rowSpacing: "stitches",
  underlay: "stitches",
  fillDirection: "stitches",
  flowDetail: "stitches",
  flowSmoothing: "stitches",
  flowStrength: "stitches",
  gradientFlow: "shapes",
};
const PANE_KEY = "filum.digitize.pane";

/** What the picture becomes: traced shapes (fills, satins, lines) or cross stitch on a grid. */
type Output = "shapes" | "cross";
const OUTPUT_KEY = "filum.digitize.output";
const CROSS_KEY = "filum.digitize.cross";
/** Panes of each output (cross stitch: no tracing, lines or fill methods). */
const PANES_OF: Record<Output, Pane[]> = { shapes: ["style", "colours", "shapes", "lines", "stitches", "ai"], cross: ["style", "colours", "cross", "ai"] };
const loadCross = (): CrossSettings => {
  try {
    return { ...CROSS_DEFAULTS, ...JSON.parse(localStorage.getItem(CROSS_KEY) ?? "{}") };
  } catch {
    return CROSS_DEFAULTS;
  }
};
/** Cross stitch preset: the colour stage's settings that suit a grid of crosses. */
const CROSS_PRESET: Partial<Settings> = { photoZigzag: false, gradients: false, colors: 8, denoise: 1, mergeDeltaE: 3, removeBackground: true };

function Group({ title, hint, extra, children }: { title: string; hint?: ReactNode; extra?: ReactNode; children: ReactNode }) {
  return (
    <section className="dz-group">
      <header>
        <h4>{title}</h4>
        {extra}
      </header>
      {children}
      {hint && <p className="dz-hint">{hint}</p>}
    </section>
  );
}

function Seg<T extends string>({ value, options, onChange, full, disabled }: { value: T; options: [T, string][]; onChange: (v: T) => void; full?: boolean; disabled?: boolean }) {
  return (
    <div className={`seg ${full ? "seg-full" : ""} ${disabled ? "disabled" : ""}`}>
      {options.map(([k, label]) => (
        <button key={k} className={value === k ? "on" : ""} disabled={disabled} onClick={() => onChange(k)}>
          {label}
        </button>
      ))}
    </div>
  );
}

/** Paint the image with the current mask and click points (object selection). */
function drawSam(ctx: CanvasRenderingContext2D, dpr: number, bmp: ImageBitmap, sam: SamImage | null, mask: Uint8Array | null, pts: SamPoint[], masks: { mode: string; px: Uint8Array; w: number; h: number }[]) {
  const W = ctx.canvas.width;
  const H = ctx.canvas.height;
  const k = Math.min((W - 24 * dpr) / bmp.width, (H - 24 * dpr) / bmp.height);
  const x0 = (W - bmp.width * k) / 2;
  const y0 = (H - bmp.height * k) / 2;
  ctx.drawImage(bmp, x0, y0, bmp.width * k, bmp.height * k);
  const overlay = (px: Uint8Array, w: number, h: number, rgb: [number, number, number], a: number) => {
    const id = new ImageData(w, h);
    for (let i = 0; i < px.length; i++) if (px[i]) id.data.set([rgb[0], rgb[1], rgb[2], a], i * 4);
    const t = document.createElement("canvas");
    t.width = w;
    t.height = h;
    t.getContext("2d")!.putImageData(id, 0, 0);
    ctx.drawImage(t, x0, y0, bmp.width * k, bmp.height * k);
  };
  const col: Record<string, [number, number, number]> = { keep: [40, 160, 90], remove: [200, 50, 60], separate: [230, 150, 30] };
  for (const m of masks) overlay(m.px, m.w, m.h, col[m.mode] ?? [120, 120, 120], 90);
  if (mask && sam) overlay(mask, sam.w, sam.h, [40, 120, 230], 120);
  if (sam)
    for (const q of pts) {
      const cx = x0 + (q.x / sam.w) * bmp.width * k;
      const cy = y0 + (q.y / sam.h) * bmp.height * k;
      ctx.beginPath();
      ctx.arc(cx, cy, 6 * dpr, 0, Math.PI * 2);
      ctx.fillStyle = q.label ? "#2e9d5b" : "#c8323c";
      ctx.fill();
      ctx.lineWidth = 2 * dpr;
      ctx.strokeStyle = "#fff";
      ctx.stroke();
    }
}

const SETTINGS_KEY = "filum.digitize.v2";
const loadSettings = (): Settings => {
  try {
    return migrateSettings(JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}"));
  } catch {
    return DEFAULTS;
  }
};

const hexToRgb = (h: string): Rgb => {
  const v = parseInt(h.replace("#", ""), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
};
const rgbToHex = (c: number[]) => "#" + c.map((x) => x.toString(16).padStart(2, "0")).join("");
const sameRgb = (a: number[], b: number[]) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];

interface Img {
  name: string;
  bytes: Uint8Array;
  url: string;
}

type Tab = "original" | "colours" | "stitches" | "vector";

function useBoxSize(ref: React.RefObject<HTMLDivElement | null>) {
  const [size, setSize] = useState({ w: 600, h: 420 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return size;
}

function PreviewCanvas({ draw, w, h }: { draw: (ctx: CanvasRenderingContext2D, dpr: number) => void; w: number; h: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current!;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.max(1, Math.round(w * dpr));
    c.height = Math.max(1, Math.round(h * dpr));
    draw(c.getContext("2d")!, dpr);
  }, [draw, w, h]);
  return <canvas ref={ref} style={{ width: w, height: h }} />;
}

export function DigitizeDialog({ onClose }: { onClose: () => void }) {
  const doc = useStore((s) => s.doc);
  const fabricColor = useStore((s) => s.fabricColor);
  const [img, setImg] = useState<Img | null>(() => {
    const p = pending.image;
    pending.image = null;
    return p ? { ...p, url: URL.createObjectURL(new Blob([p.bytes as BlobPart])) } : null;
  });
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [output, setOutputState] = useState<Output>(() => {
    const o = pending.output ?? (localStorage.getItem(OUTPUT_KEY) as Output | null);
    pending.output = null;
    return o === "cross" ? "cross" : "shapes";
  });
  const [cross, setCrossState] = useState<CrossSettings>(loadCross);
  const setCross = (p: Partial<CrossSettings>) => setCrossState((c) => ({ ...c, ...p }));
  useEffect(() => void safeSetItem(CROSS_KEY, JSON.stringify(cross)), [cross]);
  const [widthMm, setWidthMm] = useState(() => Math.round(doc.hoop.width * 0.8));
  const [fixedColors, setFixedColors] = useState<Rgb[]>([]);
  const [skipColors, setSkipColors] = useState<Rgb[]>([]);
  const [lineColors, setLineColors] = useState<Rgb[]>([]);
  const [fillColors, setFillColors] = useState<Rgb[]>([]);
  /** Colours with a satin edge in their own thread (where they meet the background). */
  const [edgeColors, setEdgeColors] = useState<Rgb[]>([]);
  /** The sew order by colour (empty: the digitizer's own, largest colour first). */
  const [colorOrder, setColorOrder] = useState<Rgb[]>([]);
  /** Areas clicked in the region editor (stitch / leave out), for this image. */
  const [regionEdits, setRegionEdits] = useState<RegionEdit[]>([]);
  /** Thread recolouring: quantised colour (hex) → chosen thread colour (hex). */
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [chart, setChart] = useState("");
  const [chartEntries, setChartEntries] = useState<PaletteEntry[]>([]);
  const [preview, setPreview] = useState<DigitizePreview | null>(null);
  /** The traced result (shapes output). */
  const [traced, setTraced] = useState<DigitizeResult | null>(null);
  const [plan, setPlan] = useState<PlanData | null>(null);
  const [tab, setTab] = useState<Tab>("stitches");
  const [stitchLook, setStitchLook] = useState<"realistic" | "stitch">("realistic");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Picking colours on the picture: the role a click gives. */
  const [pickRole, setPickRole] = useState<Exclude<Role, "auto"> | null>(null);
  const eyedropper = pickRole !== null;
  const [placement, setPlacement] = useState<"add" | "replace">("add");
  // the preset the settings still match (any change makes them custom)
  const preset = presetOf(settings);
  // recognition (on-device AI): object masks, edges, text
  const [bmp, setBmp] = useState<ImageBitmap | null>(null);
  const [sam, setSam] = useState<SamImage | null>(null);
  const [samMode, setSamMode] = useState(false);
  const [samPts, setSamPts] = useState<SamPoint[]>([]);
  const [curMask, setCurMask] = useState<Uint8Array | null>(null);
  const [masks, setMasks] = useState<{ mode: SegMask["mode"]; px: Uint8Array; w: number; h: number }[]>([]);
  const [edgeMap, setEdgeMap] = useState<EdgeMapData | null>(null);
  /** Which model made the edge map (learned edges or a learned line drawing). */
  const [edgeKind, setEdgeKind] = useState<"edges" | "drawing" | null>(null);
  const [textLines, setTextLines] = useState<TextLine[] | null>(null);
  const [textPick, setTextPick] = useState<boolean[]>([]);
  const boxRef = useRef<HTMLDivElement>(null);
  const box = useBoxSize(boxRef);
  const imgRef = useRef<HTMLImageElement>(null);
  const runId = useRef(0);
  // the picture now (async work checks it is still the one it started on)
  const picRef = useRef(img);
  picRef.current = img;
  const mounted = useRef(false);

  const set = (p: Partial<Settings>) => {
    setSettings((s) => ({ ...s, ...p }));
  };
  const [paneState, setPaneState] = useState<Pane>(() => {
    const v = localStorage.getItem(PANE_KEY);
    return PANES.some((p) => p.id === v) ? (v as Pane) : "style";
  });
  const panes = PANES.filter((p) => PANES_OF[output].includes(p.id));
  // a pane the output does not have shows its closest one
  const pane: Pane = PANES_OF[output].includes(paneState) ? paneState : output === "cross" && ["shapes", "lines", "stitches"].includes(paneState) ? "cross" : output === "shapes" && paneState === "cross" ? "stitches" : "style";
  const setPane = (p: Pane) => {
    setPaneState(p);
    safeSetItem(PANE_KEY, p);
  };
  const setOutput = (o: Output) => {
    setOutputState(o);
    safeSetItem(OUTPUT_KEY, o);
  };
  const direction: Direction = settings.fillAngle != null ? "fixed" : settings.fillDirection === "image" ? "image" : "axis";

  useEffect(() => void safeSetItem(SETTINGS_KEY, JSON.stringify(settings)), [settings]);

  useEffect(() => {
    setSam(null);
    setSamPts([]);
    setCurMask(null);
    setMasks([]);
    setEdgeMap(null);
    setTextLines(null);
    setTextPick([]);
    setSamMode(false);
    // the old picture's bitmap is closed below: nothing may use it meanwhile
    setBmp(null);
    if (!img) return;
    let live = true;
    let made: ImageBitmap | null = null;
    createImageBitmap(new Blob([img.bytes as BlobPart])).then((b) => {
      made = b;
      if (live) setBmp(b);
      else b.close();
    });
    return () => {
      live = false;
      made?.close();
      // the picture is replaced or the dialog closes: its memory goes (checked a
      // moment later: a development re-run of this effect keeps the same picture)
      setTimeout(() => {
        if (picRef.current !== img || !mounted.current) URL.revokeObjectURL(img.url);
      }, 0);
    };
  }, [img]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // learned edges for line art
  const wantMap = settings.lineArt === "edges" || settings.lineArt === "drawing" ? settings.lineArt : null;
  useEffect(() => {
    if (!wantMap || !bmp || (edgeMap && edgeKind === wantMap)) return;
    let live = true;
    setBusy(wantMap === "drawing" ? "Drawing lines (AI)…" : "Detecting edges (AI)…");
    ml()
      .then((m) => (wantMap === "drawing" ? m.drawLines(bmp) : m.detectEdges(bmp)))
      .then((e) => {
        if (!live) return;
        setEdgeMap(e);
        setEdgeKind(wantMap);
      })
      .catch((e: Error) => live && setError((wantMap === "drawing" ? "Line drawing model: " : "Edge model: ") + e.message))
      .finally(() => live && setBusy(null));
    return () => {
      live = false;
    };
  }, [wantMap, bmp, edgeMap, edgeKind]);

  // text to replace: removed from the stitched shapes (becomes lettering on add)
  const textMask = useMemo<SegMask | null>(() => {
    if (!bmp || !textLines || !textPick.some(Boolean)) return null;
    const k = 512 / Math.max(bmp.width, bmp.height);
    const w = Math.max(1, Math.round(bmp.width * k));
    const h = Math.max(1, Math.round(bmp.height * k));
    const px = new Uint8Array(w * h);
    textLines.forEach((l, i) => {
      if (!textPick[i]) return;
      const pad = (l.bbox.y1 - l.bbox.y0) * 0.15;
      for (let y = Math.max(0, Math.floor((l.bbox.y0 - pad) * k)); y < Math.min(h, Math.ceil((l.bbox.y1 + pad) * k)); y++)
        for (let x = Math.max(0, Math.floor((l.bbox.x0 - pad) * k)); x < Math.min(w, Math.ceil((l.bbox.x1 + pad) * k)); x++) px[y * w + x] = 255;
    });
    return { mode: "erase", width: w, height: h, data: toBase64(px) };
  }, [bmp, textLines, textPick]);

  const segMasks = useMemo<SegMask[]>(
    () => [...masks.map((m) => ({ mode: m.mode, width: m.w, height: m.h, data: toBase64(m.px) })), ...(textMask ? [textMask] : [])],
    [masks, textMask],
  );

  const startSam = async () => {
    if (!bmp) return;
    setTab("original");
    setSamMode(true);
    if (sam) return;
    const forImg = picRef.current;
    try {
      setBusy("Analysing objects (AI)…");
      const enc = await (await ml()).samEncode(bmp);
      // another picture was loaded meanwhile: this analysis is of the old one
      if (picRef.current !== forImg) return;
      setSam(enc);
    } catch (e) {
      setError("Segmentation model: " + (e as Error).message);
      setSamMode(false);
    } finally {
      setBusy(null);
    }
  };
  const samClick = async (pt: SamPoint) => {
    if (!sam) return;
    const pts = [...samPts, pt];
    setSamPts(pts);
    const forImg = picRef.current;
    try {
      const mask = await (await ml()).samMask(sam, pts);
      if (picRef.current === forImg) setCurMask(mask);
    } catch (e) {
      setError("Segmentation model: " + (e as Error).message);
    }
  };
  const useMask = (mode: SegMask["mode"]) => {
    if (!sam || !curMask) return;
    setMasks([...masks, { mode, px: curMask, w: sam.w, h: sam.h }]);
    setSamPts([]);
    setCurMask(null);
  };
  const runOcr = async () => {
    if (!img) return;
    const forImg = img;
    try {
      setBusy("Reading text (AI)…");
      const lines = await (await ml()).findText(img.bytes);
      if (picRef.current !== forImg) return;
      setTextLines(lines);
      setTextPick(lines.map(() => false));
      if (!lines.length) useStore.getState().toast("No text found");
    } catch (e) {
      setError("Text recognition: " + (e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const opts = useMemo<Partial<DigitizeOptions>>(
    () => ({
      ...settings,
      widthMm,
      fixedColors,
      skipColors,
      lineColors,
      fillColors,
      edgeColors,
      colorOrder,
      palette: chartEntries,
      paletteBrand: chart ? chartLabel(chart) : "",
      masks: segMasks,
      edgeMap: wantMap && edgeKind === wantMap ? edgeMap : null,
      regionEdits,
      // cross stitch: flat colours only (gradients and zig-zag photos are shapes)
      ...(output === "cross" ? { gradients: false, photoZigzag: false } : {}),
    }),
    [output, settings, widthMm, fixedColors, skipColors, lineColors, fillColors, edgeColors, colorOrder, chartEntries, chart, segMasks, edgeMap, edgeKind, wantMap, regionEdits],
  );

  // live pipeline: colour preview (fast) → digitize → stitch plan
  useEffect(() => {
    if (!img) return;
    const id = ++runId.current;
    // busy from the change on: Add can't take the result of the settings before
    setBusy("Reducing colours…");
    const t = setTimeout(async () => {
      try {
        setError(null);
        setBusy("Reducing colours…");
        const p = await engine.digitizePreview(img.bytes, opts);
        if (id !== runId.current) return;
        setPreview(p);
        // cross stitch is laid on the grid from the colours (below): no tracing
        if (output === "cross") {
          setTraced(null);
          setBusy(null);
          return;
        }
        setBusy("Building stitches…");
        const r = await engine.digitize(img.bytes, opts);
        if (id !== runId.current) return;
        setTraced(r);
        if (!r.objects.length) setBusy(null);
      } catch (e) {
        if (id === runId.current) {
          setError((e as Error).message);
          setBusy(null);
        }
      }
    }, 220);
    return () => clearTimeout(t);
  }, [img, opts, output]);

  // cross stitch: the colour stage's regions on a grid of cells
  const crossed = useMemo(() => {
    if (output !== "cross" || !preview) return null;
    return crossStitchDesign(
      { ...preview, colours: preview.colors.length, colors: preview.colors },
      cross,
      chart ? chartLabel(chart) : "",
      img?.name.replace(/\.[^.]+$/, "") || "Cross stitch",
      () => uid(),
    );
  }, [output, preview, cross, chart, img]);
  const result = useMemo<DigitizeResult | null>(
    () => (output === "cross" ? (crossed && preview ? { threads: crossed.threads, objects: crossed.objects, colors: preview.colors, widthMm: preview.widthMm, heightMm: preview.heightMm } : null) : traced),
    [output, crossed, preview, traced],
  );

  // thread recolouring is applied on top of the engine result (shapes stay put)
  const recoloured = useMemo<DigitizeResult | null>(() => {
    if (!result) return null;
    const ov = (hex: string) => overrides[hex.toLowerCase()];
    return {
      ...result,
      threads: result.threads.map((t) => (ov(t.color) ? { ...t, color: ov(t.color), name: ov(t.color).toUpperCase(), code: "", brand: "" } : t)),
    };
  }, [result, overrides]);

  // the result as a design: what the previews show and the plan is made of
  const previewDoc = useMemo(
    () => (recoloured ? { ...emptyDoc(), fabric: doc.fabric, options: doc.options, threads: recoloured.threads, objects: recoloured.objects } : null),
    [recoloured, doc.fabric, doc.options],
  );
  // stitch plan of the (recoloured) result — object geometry is cached by the engine
  const planRun = useRef(0);
  useEffect(() => {
    if (!recoloured?.objects.length) {
      // a plan still being made for the previous result is dropped
      planRun.current++;
      setPlan(null);
      return;
    }
    const id = ++planRun.current;
    // a settings change meanwhile starts a new run, which owns the busy state
    const run = runId.current;
    setBusy("Building stitches…");
    engine
      .planDetached(previewDoc!)
      .then((pl) => id === planRun.current && setPlan(pl))
      .catch((e: Error) => id === planRun.current && setError(e.message))
      .finally(() => id === planRun.current && run === runId.current && setBusy(null));
  }, [previewDoc]);

  // inputs: file picker, drag & drop, paste
  const loadBytes = useCallback((name: string, bytes: Uint8Array) => {
    // the colour choices belong to the old picture
    setOverrides({});
    setFixedColors([]);
    setSkipColors([]);
    setLineColors([]);
    setFillColors([]);
    setEdgeColors([]);
    setColorOrder([]);
    setRegionEdits([]);
    setTraced(null);
    setPlan(null);
    setPreview(null);
    setImg({ name, bytes, url: URL.createObjectURL(new Blob([bytes as BlobPart])) });
    setTab("stitches");
  }, []);
  const pick = async () => {
    const f = await openFile([{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "bmp", "gif"] }]);
    if (f) loadBytes(f.name, f.bytes);
  };
  const pasteFromClipboard = async () => {
    try {
      const items = await navigator.clipboard.read();
      for (const it of items) {
        const type = it.types.find((t) => t.startsWith("image/"));
        if (type) {
          const blob = await it.getType(type);
          return loadBytes("pasted image", new Uint8Array(await blob.arrayBuffer()));
        }
      }
      useStore.getState().toast("No image on the clipboard");
    } catch {
      useStore.getState().toast("Clipboard access was denied — press Ctrl+V instead");
    }
  };
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const f = [...(e.clipboardData?.files ?? [])].find((x) => x.type.startsWith("image/"));
      if (f) f.arrayBuffer().then((b) => loadBytes(f.name || "pasted image", new Uint8Array(b)));
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [loadBytes]);
  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    const f = [...e.dataTransfer.files].find((x) => x.type.startsWith("image/"));
    if (f) loadBytes(f.name, new Uint8Array(await f.arrayBuffer()));
  };

  // thread chart
  useEffect(() => {
    if (!chart) return setChartEntries([]);
    let cancel = false;
    loadChart(chart)
      .then((es) => !cancel && setChartEntries(es.map((e) => ({ name: e.name, code: e.code, rgb: hexToRgb(e.color) }))))
      .catch(() => useStore.getState().toast("Could not load thread chart", "error"));
    return () => {
      cancel = true;
    };
  }, [chart]);

  const colors: ColorInfo[] = result?.colors ?? preview?.colors ?? [];
  const aspect = preview ? preview.heightMm / Math.max(preview.widthMm, 1e-9) : 0.75;
  const heightMm = widthMm * aspect;

  /** Whether a picked colour stands for this quantised colour. */
  const isColour = (x: Rgb, c: ColorInfo) => sameRgb(nearestSkipTarget(x), c.rgb);
  const roleOf = (c: ColorInfo): Role =>
    c.background ? "omit" : lineColors.some((x) => isColour(x, c)) ? "line" : fillColors.some((x) => isColour(x, c)) ? "fill" : "auto";
  const setRole = (c: ColorInfo, role: Role) => {
    const without = (list: Rgb[]) => list.filter((x) => !isColour(x, c));
    // the auto-detected background is left out by the background switch, not a list
    const autoBackground = c.background && !skipColors.some((x) => isColour(x, c));
    setLineColors(role === "line" ? [...without(lineColors), c.rgb] : without(lineColors));
    setFillColors(role === "fill" ? [...without(fillColors), c.rgb] : without(fillColors));
    setSkipColors(role === "omit" && !autoBackground ? [...without(skipColors), c.rgb] : without(skipColors));
    if (role !== "omit" && autoBackground) set({ removeBackground: false });
  };
  const toggleColour = (c: ColorInfo) => setRole(c, c.background ? "auto" : "omit");
  const hasEdge = (c: ColorInfo) => edgeColors.some((x) => isColour(x, c));
  const toggleEdge = (c: ColorInfo) => setEdgeColors(hasEdge(c) ? edgeColors.filter((x) => !isColour(x, c)) : [...edgeColors, c.rgb]);
  /** Move a thread of the result one place earlier (-1) or later (+1) in the sew order. */
  const moveThread = (i: number, by: -1 | 1) => {
    const list = (result?.threads ?? []).map((t) => hexToRgb(t.color));
    const j = i + by;
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    setColorOrder(list);
  };
  // which quantised colour a skip entry hits (mirrors the engine's nearest match)
  const nearestSkipTarget = (s: Rgb): Rgb => {
    let best = colors[0]?.rgb ?? s;
    let bd = Infinity;
    for (const c of colors) {
      const d = (c.rgb[0] - s[0]) ** 2 + (c.rgb[1] - s[1]) ** 2 + (c.rgb[2] - s[2]) ** 2;
      if (d < bd) {
        bd = d;
        best = c.rgb;
      }
    }
    return best;
  };
  // Choosing a different thread colour recolours that region; the palette is
  // locked so the regions themselves stay exactly where they are.
  const editColour = (i: number, hex: string) => {
    if (!fixedColors.length) lockPalette();
    setOverrides({ ...overrides, [colors[i].hex.toLowerCase()]: hex.toLowerCase() });
  };
  const removeColour = (i: number) => {
    const base = fixedColors.length ? fixedColors : colors.map((c) => c.rgb);
    if (base.length <= 2) return;
    setFixedColors(base.filter((_, k) => k !== i));
  };
  const lockPalette = () => setFixedColors(colors.map((c) => c.rgb));
  /** Click in the region editor: flip one area (a single edit per area), or the whole colour. */
  const toggleRegion = (fx: number, fy: number, region: number, wholeColour: boolean) => {
    if (!preview) return;
    const label = preview.regionLabel[region];
    if (wholeColour && colors[label]) return toggleColour(colors[label]);
    if (pickRole && colors[label]) return setRole(colors[label], pickRole);
    const stitched = preview.regionReason[region] === REGION_REASON.stitched;
    const rest = regionEdits.filter((e) => regionAt(preview, e.x, e.y) !== region);
    setRegionEdits([...rest, { x: fx, y: fy, keep: !stitched }]);
  };
  const removedShare = colors.reduce((a, c) => a + (c.removed ?? 0), 0);
  const resetColours = () => {
    setFixedColors([]);
    setSkipColors([]);
    setLineColors([]);
    setFillColors([]);
    setEdgeColors([]);
    setColorOrder([]);
    setPickRole(null);
    setOverrides({});
    set({ removeBackground: true });
  };

  /** Extra lines: colour edges or one line-art source (they are alternatives). */
  const extra: ExtraLines = settings.edgeOutlines !== "none" ? "colour" : settings.lineArt;
  const chooseExtra = (v: ExtraLines) =>
    v === "colour" ? set({ edgeOutlines: settings.edgeOutlines !== "none" ? settings.edgeOutlines : "running", lineArt: "none" }) : set({ edgeOutlines: "none", lineArt: v });
  const outlineColourRow = (
    <Row label="Colour" title="Thread of the colour edges and the border">
      <span className="dz-inline">
        <input type="color" className="color-big" value={rgbToHex(settings.outlineColor)} onChange={(e) => set({ outlineColor: hexToRgb(e.target.value) })} />
        <span className="stat mono">{rgbToHex(settings.outlineColor).toUpperCase()}</span>
      </span>
    </Row>
  );

  /** Settings of a tab that differ from the defaults (AI: masks and picked text lines). */
  const paneChanges = (p: Pane): number => {
    if (p === "ai") return masks.length + textPick.filter(Boolean).length;
    if (p === "cross") return (Object.keys(CROSS_DEFAULTS) as (keyof CrossSettings)[]).filter((k) => cross[k] !== CROSS_DEFAULTS[k]).length;
    let n = (Object.keys(PANE_OF) as (keyof Settings)[]).filter((k) => PANE_OF[k] === p && JSON.stringify(settings[k]) !== JSON.stringify(DEFAULTS[k])).length;
    if (p === "colours") n += (chart ? 1 : 0) + (fixedColors.length || skipColors.length || lineColors.length || fillColors.length || edgeColors.length || colorOrder.length || Object.keys(overrides).length ? 1 : 0) + regionEdits.length;
    return n;
  };
  const resetPane = (p: Pane) => {
    if (p === "cross") return setCrossState(CROSS_DEFAULTS);
    if (p === "ai") {
      setMasks([]);
      setTextPick(textPick.map(() => false));
      setSamPts([]);
      setCurMask(null);
      return;
    }
    const back: Partial<Settings> = {};
    for (const k of Object.keys(PANE_OF) as (keyof Settings)[]) if (PANE_OF[k] === p) (back as Record<string, unknown>)[k] = DEFAULTS[k];
    set(back);
    if (p === "colours") {
      setChart("");
      resetColours();
      setRegionEdits([]);
    }
  };

  const onOriginalClick = (e: React.MouseEvent<HTMLImageElement>) => {
    if (!eyedropper || !imgRef.current) return;
    const el = imgRef.current;
    const r = el.getBoundingClientRect();
    const x = Math.floor(((e.clientX - r.left) / r.width) * el.naturalWidth);
    const y = Math.floor(((e.clientY - r.top) / r.height) * el.naturalHeight);
    const c = document.createElement("canvas");
    c.width = el.naturalWidth;
    c.height = el.naturalHeight;
    const g = c.getContext("2d")!;
    g.drawImage(el, 0, 0);
    const d = g.getImageData(x, y, 1, 1).data;
    // the quantised colour under the click gets the role
    const target = nearestSkipTarget([d[0], d[1], d[2]]);
    const ci = colors.find((c) => sameRgb(c.rgb, target));
    if (ci && pickRole) setRole(ci, pickRole);
  };

  const fitHoop = () => {
    const w = Math.min(doc.hoop.width * 0.9, (doc.hoop.height * 0.9) / Math.max(aspect, 1e-6));
    setWidthMm(Math.floor(w));
  };

  const counts = useMemo(() => {
    const c = { fill: 0, satin: 0, running: 0 };
    for (const o of result?.objects ?? []) if (o.stitch.type in c) c[o.stitch.type as keyof typeof c]++;
    return c;
  }, [result]);
  const stats = plan?.stats;
  const tooBig = widthMm > doc.hoop.width || heightMm > doc.hoop.height;

  const add = () => {
    if (!recoloured?.objects.length) return;
    const result = recoloured;
    const s = useStore.getState();
    const box = unionBoxes(result.objects.map(objectBounds));
    let dx = box ? doc.hoop.width / 2 - (box.x + box.w / 2) : 0;
    let dy = box ? doc.hoop.height / 2 - (box.y + box.h / 2) : 0;
    if (output === "cross") {
      // whole cells: the crosses stay on the canvas grid the shapes were cut to
      const sy = cross.square ? cross.cell : cross.cellY;
      dx = Math.round(dx / cross.cell) * cross.cell;
      dy = Math.round(dy / sy) * sy;
    }
    const m = translateMat(dx, dy);
    const remap = new Map<string, string>();
    const threads = result.threads.map((t) => {
      const id = uid("t");
      remap.set(t.id, id);
      return { ...t, id };
    });
    const objs = result.objects.map((o) => ({ ...transformObject(o, m), id: uid(), thread: remap.get(o.thread)! }));
    if (placement === "replace") {
      s.commit((d) => ({ ...d, name: img?.name.replace(/\.[^.]+$/, "") || d.name, threads, objects: objs }));
    } else s.addObjects(objs, threads);
    s.select(objs.map((o) => o.id));
    if (output === "cross") {
      if (cross.grid) s.set({ showGrid: true, gridStep: cross.cell });
      s.toast(`${(crossed?.crosses ?? 0).toLocaleString()} crosses in ${threads.length} colours`, "success");
    } else s.toast(`Digitized ${objs.length} objects in ${threads.length} colours`, "success");
    // recognised text becomes real lettering, placed and sized like the original
    if (bmp && textLines && textPick.some(Boolean)) {
      const mmPerPx = widthMm / bmp.width;
      const g = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
      g.canvas.width = bmp.width;
      g.canvas.height = bmp.height;
      g.drawImage(bmp, 0, 0);
      const picked = textLines.filter((_, i) => textPick[i]);
      void (async () => {
        const made = [];
        for (const l of picked) {
          // the darkest colour in the box is the ink
          const bw = Math.max(1, l.bbox.x1 - l.bbox.x0);
          const bh = Math.max(1, l.bbox.y1 - l.bbox.y0);
          const d = g.getImageData(l.bbox.x0, l.bbox.y0, bw, bh).data;
          let best = [0, 0, 0];
          let lum = Infinity;
          for (let i = 0; i < d.length; i += 16) {
            const v = d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11;
            if (v < lum) {
              lum = v;
              best = [d[i], d[i + 1], d[i + 2]];
            }
          }
          const thread = useStore.getState().ensureThread(rgbToHex(best));
          const anchor = transformObject({ ...objs[0], paths: [{ closed: false, nodes: [{ p: [((l.bbox.x0 + l.bbox.x1) / 2) * mmPerPx, l.bbox.y1 * mmPerPx] }] }] }, m).paths[0].nodes[0].p;
          made.push(...(await createLettering(l.text, anchor, bh * mmPerPx * 0.72, thread)));
        }
        if (made.length) {
          useStore.getState().addObjects(made);
          useStore.getState().toast(`Added ${picked.length} lettering object${picked.length === 1 ? "" : "s"}`, "success");
        }
      })();
    }
    onClose();
  };

  const pw = Math.max(200, box.w);
  const ph = Math.max(160, box.h);

  return (
    <Dialog
      live
      xwide
      title="Auto-digitize image"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={pick}>
            <ImageUp size={14} /> Choose image…
          </button>
          <button className="btn ghost" onClick={pasteFromClipboard} title="Paste an image (Ctrl+V works too)">
            <Clipboard size={14} /> Paste
          </button>
          <div className="spacer" />
          <select className="select" value={placement} onChange={(e) => setPlacement(e.target.value as "add" | "replace")} aria-label="Placement">
            <option value="add">Add to design (centred)</option>
            <option value="replace">Replace current design</option>
          </select>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!result?.objects.length || !!busy} onClick={add}>
            {placement === "replace" ? "Replace design" : "Add to design"}
          </button>
        </>
      }
    >
      <div className="dz" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
        <div className="dz-side">
          <div className="dz-steps" role="tablist">
            {panes.map((p) => {
              const n = paneChanges(p.id);
              return (
                <button key={p.id} role="tab" aria-selected={pane === p.id} className={pane === p.id ? "on" : ""} title={p.hint} onClick={() => setPane(p.id)}>
                  {p.icon}
                  <span>{p.label}</span>
                  {n > 0 && <i className={p.id === "ai" ? "count" : "dot"}>{p.id === "ai" ? n : ""}</i>}
                </button>
              );
            })}
          </div>

          <div className="dz-pane" key={pane}>
            {pane === "style" && (
              <>
                <Group
                  title="Output"
                  hint={
                    output === "cross"
                      ? "The picture's colours on a grid of crosses — every colour setting (palette, thread chart, background, left-out areas, AI masks) applies."
                      : settings.photoZigzag
                        ? "One colour, rows of zigzags: wider and denser where the picture is darker, nothing where it is light."
                        : "Traced shapes: fills, satin columns and lines."
                  }
                >
                  <Seg
                    full
                    value={output === "cross" ? "cross" : settings.photoZigzag ? "zigzag" : "shapes"}
                    onChange={(v) => {
                      if (v === "cross") {
                        setOutput("cross");
                        setSettings((s) => ({ ...s, ...CROSS_PRESET }));
                      } else {
                        setOutput("shapes");
                        set({ photoZigzag: v === "zigzag" });
                      }
                    }}
                    options={[
                      ["shapes", "Shapes"],
                      ["zigzag", "Zig-zag photo"],
                      ["cross", "Cross stitch"],
                    ]}
                  />
                </Group>
                {output === "shapes" && !settings.photoZigzag && (
                  <Group title="Preset" hint={DIGITIZE_PRESETS.find((p) => p.id === preset)?.hint ?? "Custom settings — pick a preset to start from"}>
                    <div className="dz-presets">
                      {DIGITIZE_PRESETS.map((p) => (
                        <button
                          key={p.id}
                          className={preset === p.id ? "on" : ""}
                          title={p.hint}
                          aria-pressed={preset === p.id}
                          // a preset starts from the defaults: nothing leaks from the last one
                          onClick={() => setSettings((s) => presetSettings(p.id, { outlineColor: s.outlineColor }))}
                        >
                          {PRESET_ICONS[p.id]}
                          <span>{p.label}</span>
                        </button>
                      ))}
                    </div>
                  </Group>
                )}
                {output === "shapes" && !settings.photoZigzag && (
                  <Group title="Look" hint="Each control moves several settings of the tabs together; it shows Custom once those are changed by hand.">
                    <Row label="Outlines" title="Lines of the picture: none, as wide as drawn, or one even satin width (clean logo outlines, sewn as one network; below 1 mm a triple running stitch)">
                      <Seg<Outlines>
                        full
                        value={outlinesOf(settings)}
                        onChange={(v) => set(outlinesPatch(v, settings.outlineLineMm || OUTLINE_DEFAULT_MM))}
                        options={[
                          ["off", "None"],
                          ["drawn", "As drawn"],
                          ["even", "Even"],
                        ]}
                      />
                    </Row>
                    {outlinesOf(settings) === "even" && (
                      <Row label="Outline width" title="Every dark line becomes a satin of this width (below 1 mm: a triple running stitch)">
                        <Slider min={0.5} max={4} step={0.1} unit="mm" value={settings.outlineLineMm} onChange={(v) => set({ outlineLineMm: v })} />
                      </Row>
                    )}
                    <Row label="Detail" title="Bold: fewer, simpler shapes. Fine: small shapes and close tracing (more stitches, more trims)">
                      <Seg<Detail | "custom">
                        full
                        value={detailOf(settings) ?? "custom"}
                        onChange={(v) => v !== "custom" && set(DETAIL[v])}
                        options={[
                          ["bold", "Bold"],
                          ["normal", "Normal"],
                          ["fine", "Fine"],
                          ...(detailOf(settings) ? [] : [["custom", "Custom"] as ["custom", string]]),
                        ]}
                      />
                    </Row>
                    <Row label="Background" title="The background colour: left out around the design and in plain holes (letter counters), left out only around it (every enclosed area stitched: a logo's white faces), or stitched everywhere">
                      <Seg<Backdrop>
                        full
                        value={backdropOf(settings)}
                        onChange={(v) => set(backdropPatch(v))}
                        options={[
                          ["fabric", "Left out"],
                          ["enclosed", "Enclosed"],
                          ["all", "Stitched"],
                        ]}
                      />
                    </Row>
                    <Row label="Border" title="An outline around the whole design (patches, stickers)">
                      <Seg
                        full
                        value={settings.outline}
                        onChange={(v) => set({ outline: v })}
                        options={[
                          ["none", "None"],
                          ["running", "Running"],
                          ["satin", "Satin"],
                        ]}
                      />
                    </Row>
                    {settings.outline === "satin" && (
                      <Row label="Border width">
                        <Slider min={0.8} max={6} step={0.1} unit="mm" value={settings.outlineWidthMm} onChange={(v) => set({ outlineWidthMm: v })} />
                      </Row>
                    )}
                  </Group>
                )}
                {output === "shapes" && settings.photoZigzag && (
                  <Group title="Zig-zag photo">
                    <Row label="Row spacing" title="Distance between the rows — wider: lighter, more graphic">
                      <Slider min={0.5} max={3} step={0.1} unit="mm" value={settings.photoSpacing} onChange={(v) => set({ photoSpacing: v })} />
                    </Row>
                    <Row label="Angle" title="Direction of the rows">
                      <Slider min={-90} max={90} step={5} digits={0} unit="°" value={settings.photoAngle} onChange={(v) => set({ photoAngle: v })} />
                    </Row>
                    <Row label="Contrast" title="Higher: darker darks, lighter lights">
                      <Slider min={0.5} max={3} step={0.1} value={settings.photoContrast} onChange={(v) => set({ photoContrast: v })} />
                    </Row>
                    <Row label="Leave light" title="Parts lighter than this stay empty (the fabric shows)">
                      <Slider min={0} max={60} step={1} digits={0} unit="%" value={Math.round(settings.photoMin * 100)} onChange={(v) => set({ photoMin: v / 100 })} />
                    </Row>
                  </Group>
                )}
                <Group
                  title="Size"
                  extra={
                    preview && (
                      <span className={`badge ${tooBig ? "warn" : ""}`} title={tooBig ? `Larger than the ${doc.hoop.name} hoop` : `Fits the ${doc.hoop.name} hoop`}>
                        {tooBig ? "larger than hoop" : "fits hoop"}
                      </span>
                    )
                  }
                >
                  <div className="dz-size">
                    <label>
                      <span>W</span>
                      <Num value={widthMm} unit="mm" step={5} min={10} max={1000} digits={1} onChange={setWidthMm} />
                    </label>
                    <label>
                      <span>H</span>
                      <Num value={heightMm} unit="mm" step={5} min={10} max={1000} digits={1} onChange={(v) => setWidthMm(v / Math.max(aspect, 1e-6))} />
                    </label>
                    <button className="btn sm" onClick={fitHoop} disabled={!preview} title={`Scale to 90 % of the ${doc.hoop.name} hoop`}>
                      <Maximize2 size={12} /> Fit hoop
                    </button>
                  </div>
                </Group>
              </>
            )}

            {pane === "colours" && (
              <>
                <Group title="Palette">
                  <Row label="Colours">
                    {fixedColors.length ? (
                      <span className="badge" title="The palette is locked: regions stay where they are">
                        <Lock size={11} /> Locked · {fixedColors.length}
                      </span>
                    ) : (
                      <Slider min={2} max={16} step={1} digits={0} value={settings.colors} onChange={(v) => set({ colors: v })} />
                    )}
                  </Row>
                  <Row label="Merge similar" title="Merge colours closer than this (CIEDE2000; 0 = off)">
                    <Slider min={0} max={12} step={0.5} digits={1} unit="ΔE" value={settings.mergeDeltaE} onChange={(v) => set({ mergeDeltaE: v })} />
                  </Row>
                  <Row label="Thread chart" title="Snap colours to real threads">
                    <ChartSelect value={chart} onChange={setChart} none="Exact colours" />
                  </Row>
                </Group>
                <Group
                  title="Background & left-out areas"
                  hint={
                    settings.backgroundScope === "outside"
                      ? "The border colour is left out where it reaches the edge of the picture, and in plain holes (letter counters, the inside of rings and outlines). Small enclosed areas (highlights) and ones with shapes on them (a badge face) are stitched."
                      : settings.backgroundScope === "border"
                        ? "The border colour is left out only where it reaches the edge of the picture: every area enclosed by the design is stitched (a logo's white faces inside its outlines)."
                        : "The border colour is left out everywhere, also inside shapes (letter counters, holes)."
                  }
                >
                  <Row label="Background" title="Leave out the colour that dominates the image border">
                    <Toggle on={settings.removeBackground} onChange={(v) => set({ removeBackground: v })} />
                  </Row>
                  {/* the three choices need the panel's full width */}
                  <Seg
                    full
                    disabled={!settings.removeBackground}
                    value={settings.backgroundScope}
                    onChange={(v) => set({ backgroundScope: v })}
                    options={[
                      ["border", "At the edge"],
                      ["outside", "Outside & holes"],
                      ["everywhere", "Everywhere"],
                    ]}
                  />
                  <div className="dz-removed">
                    <span>
                      <b>{(removedShare * 100).toFixed(removedShare < 0.1 ? 1 : 0)}%</b> of the picture left out
                      {regionEdits.length > 0 && <span className="stat"> · {regionEdits.length} area{regionEdits.length === 1 ? "" : "s"} edited</span>}
                    </span>
                    <div className="dz-inline">
                      <button className={`btn sm ${tab === "colours" ? "primary" : ""}`} disabled={!preview} onClick={() => setTab("colours")} title="Show what is left out — click areas to stitch them or leave them out">
                        <Eye size={12} /> Review
                      </button>
                      {regionEdits.length > 0 && (
                        <button className="btn sm ghost" onClick={() => setRegionEdits([])} title="Forget the areas you clicked">
                          Clear
                        </button>
                      )}
                    </div>
                  </div>
                </Group>
                <Group
                  title={`Colours${colors.length ? ` · ${colors.filter((c) => !c.background).length} stitched` : ""}`}
                  extra={
                    <span className="dz-head-actions">
                      <button className="icon-btn" title={fixedColors.length ? "Unlock palette (re-quantise)" : "Lock this palette"} onClick={fixedColors.length ? () => (setFixedColors([]), setOverrides({})) : lockPalette} disabled={!colors.length}>
                        {fixedColors.length ? <Lock size={13} /> : <Unlock size={13} />}
                      </button>
                      <button className="icon-btn" title="Reset colour edits" onClick={resetColours}>
                        <RotateCcw size={13} />
                      </button>
                    </span>
                  }
                >
                  <div className="dz-pick">
                    <span className="dz-pick-label">
                      <Pipette size={12} /> Pick on picture
                    </span>
                    <div className="seg" role="group" aria-label="Pick a colour on the picture as">
                      {ROLES.filter((r) => r.id !== "auto").map((r) => (
                        <button
                          key={r.id}
                          className={pickRole === r.id ? "on" : ""}
                          disabled={!img}
                          title={`Click colours in the picture (or in Review) to make them: ${r.label.toLowerCase()} — click again to stop`}
                          onClick={() => {
                            const next = pickRole === r.id ? null : (r.id as Exclude<Role, "auto">);
                            setPickRole(next);
                            if (next && tab !== "original" && tab !== "colours") setTab("original");
                          }}
                        >
                          {r.icon} {r.label}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="dz-colours">
                    {colors.map((c, i) => (
                      <div key={i} className={`dz-colour ${c.background ? "off" : ""}`}>
                        <input type="color" value={overrides[c.hex] ?? c.hex} onChange={(e) => editColour(i, e.target.value)} title="Choose the thread colour for this region" />
                        <span className="dz-cname" title={c.code ? `${c.name} ${c.code}` : c.name}>
                          {overrides[c.hex] ? overrides[c.hex].toUpperCase() : c.name}
                          {c.code && <span className="stat"> {c.code}</span>}
                          {c.background && c.coverage - (c.removed ?? 0) > 0.0005 && <span className="stat"> · partly stitched</span>}
                          {roleOf(c) === "auto" && (c.lines ?? 0) > 0.5 * Math.max(1e-9, c.coverage - (c.removed ?? 0)) && <span className="dz-auto"> lines</span>}
                        </span>
                        <span
                          className="dz-cover"
                          title={`${((c.coverage - (c.removed ?? 0)) * 100).toFixed(1)} % of the picture stitched${c.removed ? `, ${(c.removed * 100).toFixed(1)} % left out` : ""}`}
                        >
                          <i style={{ width: `${Math.min(100, c.coverage * 100)}%` }} className="all" />
                          <i style={{ width: `${Math.min(100, Math.max(0, c.coverage - (c.removed ?? 0)) * 100)}%` }} />
                          <b>{(c.coverage * 100).toFixed(c.coverage < 0.1 ? 1 : 0)}%</b>
                        </span>
                        <div className="dz-role" role="group" aria-label={`${c.name}: sew as`}>
                          {ROLES.map((r) => (
                            <button key={r.id} className={roleOf(c) === r.id ? "on" : ""} title={`${r.label} — ${r.hint}`} onClick={() => setRole(c, r.id)}>
                              {r.icon}
                            </button>
                          ))}
                        </div>
                        <div className="dz-role" role="group">
                          <button
                            className={hasEdge(c) ? "on" : ""}
                            disabled={c.background}
                            aria-pressed={hasEdge(c)}
                            aria-label={`${c.name}: satin edge`}
                            title="Satin edge — a satin in this colour's thread where its shapes meet the background (as wide as the border's satin)"
                            onClick={() => toggleEdge(c)}
                          >
                            <StitchSatin size={12} />
                          </button>
                        </div>
                        {fixedColors.length > 2 ? (
                          <button className="mini" onClick={() => removeColour(i)} title="Merge into the nearest remaining colour">
                            ×
                          </button>
                        ) : (
                          <span />
                        )}
                      </div>
                    ))}
                    {!colors.length && <div className="hint">Colours appear here after loading an image.</div>}
                  </div>
                </Group>
                {output === "shapes" && (result?.threads.length ?? 0) > 1 && (
                  <Group
                    title="Sew order"
                    hint="First sewn first: a later colour lies on top. Each colour's fills, lines and edges are sewn together."
                    extra={
                      colorOrder.length ? (
                        <button className="btn sm ghost" onClick={() => setColorOrder([])} title="Back to the digitizer's order (largest colour first)">
                          <RotateCcw size={12} /> Auto
                        </button>
                      ) : undefined
                    }
                  >
                    <ol className="dz-order" aria-label="Sew order">
                      {(recoloured ?? result)!.threads.map((t, i, all) => (
                        <li key={t.id}>
                          <span className="dz-order-n">{i + 1}</span>
                          <i className="dz-order-sw" style={{ background: t.color }} />
                          <span className="dz-cname" title={t.name}>
                            {t.name}
                          </span>
                          <button className="mini" disabled={i === 0} onClick={() => moveThread(i, -1)} aria-label={`Sew ${t.name} earlier`} title="Sew earlier (underneath)">
                            ↑
                          </button>
                          <button className="mini" disabled={i === all.length - 1} onClick={() => moveThread(i, 1)} aria-label={`Sew ${t.name} later`} title="Sew later (on top)">
                            ↓
                          </button>
                        </li>
                      ))}
                    </ol>
                  </Group>
                )}
              </>
            )}

            {pane === "shapes" && (
              <>
                <Group title="Picture">
                  <Row label="Resolution" title="Working resolution — more is slower but keeps finer shapes">
                    <Slider min={200} max={1600} step={20} digits={0} unit="px" value={settings.maxPixels} onChange={(v) => set({ maxPixels: v })} />
                  </Row>
                  <Row label="Denoise" title="Edge-preserving smoothing before colours are reduced (photos, JPEG noise)">
                    <Slider min={0} max={4} step={1} digits={0} value={settings.denoise} onChange={(v) => set({ denoise: v })} />
                  </Row>
                  <Row label="Pixel art" title="Depixelize sprites and icons into smooth shapes (Kopf & Lischinski)">
                    <Seg value={settings.pixelArt} onChange={(v) => set({ pixelArt: v })} options={[["auto", "Auto"], ["on", "On"], ["off", "Off"]]} />
                  </Row>
                </Group>
                <Group title="Tracing">
                  <Row label="Seamless" title="Neighbouring shapes share one traced boundary (no gaps, no overlaps); corners stay sharp, pixel steps become smooth curves">
                    <Toggle on={settings.seamless} onChange={(v) => set({ seamless: v })} />
                  </Row>
                  {settings.seamless && (
                    <Row label="Corners over" title="Boundary turns sharper than this stay corners">
                      <Slider min={20} max={120} step={5} digits={0} unit="°" value={settings.cornerAngle} onChange={(v) => set({ cornerAngle: v })} />
                    </Row>
                  )}
                  <Row label="Gradients" title="Smooth colour ramps become dithered gradient fills instead of bands">
                    <Toggle on={settings.gradients} onChange={(v) => set({ gradients: v })} />
                  </Row>
                  {settings.gradients && (
                    <Row label="Gradient rows" title="Straight rows, or streamlines that follow the picture (the colours share them and interleave) — uses the flow settings under Stitches">
                      <Seg
                        value={settings.gradientFlow ? "flow" : "straight"}
                        onChange={(v) => set({ gradientFlow: v === "flow" })}
                        options={[
                          ["straight", "Straight"],
                          ["flow", "Flow"],
                        ]}
                      />
                    </Row>
                  )}
                </Group>
                <Group title="Cleanup">
                  <Row label="Smoothing" title="Majority-filter passes that remove noise">
                    <Slider min={0} max={6} step={1} digits={0} value={settings.smoothing} onChange={(v) => set({ smoothing: v })} />
                  </Row>
                  <Row label="Min. region" title="Smaller specks merge into their neighbour">
                    <Slider min={0} max={10} step={0.25} unit="mm²" value={settings.minRegionMm2} onChange={(v) => set({ minRegionMm2: v })} />
                  </Row>
                  <Row label="Simplify" title="Contour simplification tolerance">
                    <Slider min={0.02} max={0.5} step={0.01} unit="mm" value={settings.simplifyMm} onChange={(v) => set({ simplifyMm: v })} />
                  </Row>
                  <Row label="Overlap" title="Grow fills so neighbouring colours don't gap after pull">
                    <Slider min={0} max={0.8} step={0.05} unit="mm" value={settings.overlapMm} onChange={(v) => set({ overlapMm: v })} />
                  </Row>
                </Group>
              </>
            )}

            {pane === "lines" && (
              <>
                <Group
                  title="Lines in the picture"
                  hint="Outlines, ink strokes and narrow shapes become stitched lines along their centre — through junctions, small gaps bridged — and the fills continue under them, so nothing gapes."
                  extra={<Toggle on={settings.lineNetworks} onChange={(v) => set({ lineNetworks: v })} />}
                >
                  {settings.lineNetworks && (
                    <>
                      <Row label="Ink lines" title="Dark lines found on the picture itself, even where the colour reduction merged them into a neighbour (0 = off)">
                        <Slider min={0} max={100} step={5} digits={0} unit="%" value={settings.inkSensitivity} onChange={(v) => set({ inkSensitivity: v })} />
                      </Row>
                      <Row label="Max. width" title="Lines up to this width become stitched lines; wider shapes stay fills">
                        <Slider min={0.5} max={8} step={0.1} digits={1} unit="mm" value={settings.lineMaxWidthMm} onChange={(v) => set({ lineMaxWidthMm: v })} />
                      </Row>
                      <Row label="Bridge gaps" title="Join line ends that point at each other (or at another line) across a gap up to this size">
                        <Slider min={0} max={4} step={0.1} digits={1} unit="mm" value={settings.lineGapMm} onChange={(v) => set({ lineGapMm: v })} />
                      </Row>
                      <Row label="Min. length" title="Shorter lines and side branches (corners, specks) are left out">
                        <Slider min={0.5} max={10} step={0.5} digits={1} unit="mm" value={settings.lineMinMm} onChange={(v) => set({ lineMinMm: v })} />
                      </Row>
                      <Row label="Through junctions" title="A line continues through a junction when it bends less than this — fewer, longer lines (0: every junction ends the lines)">
                        <Slider min={0} max={60} step={5} digits={0} unit="°" value={settings.lineContinuity} onChange={(v) => set({ lineContinuity: v })} />
                      </Row>
                      <Row label="Outline width" title="Dark lines (outlines, ink) as satin of one even width — 0: as wide as drawn">
                        <span className="dz-inline">
                          <Toggle on={settings.outlineLineMm > 0} onChange={(v) => set({ outlineLineMm: v ? OUTLINE_DEFAULT_MM : 0 })} />
                          {settings.outlineLineMm > 0 && <Num value={settings.outlineLineMm} unit="mm" step={0.1} min={0.5} max={4} digits={1} onChange={(v) => set({ outlineLineMm: v })} />}
                        </span>
                      </Row>
                      {settings.outlineLineMm <= 0 && (
                        <Row label="Follow width" title="Satin lines get wider and narrower like the drawn line">
                          <Toggle on={settings.lineTaper} onChange={(v) => set({ lineTaper: v })} />
                        </Row>
                      )}
                      <Row label="One network" title="Lines that meet are sewn in one go: each walks out under a running path its column covers on the way back — no trims between them">
                        <Toggle on={settings.routeLines} onChange={(v) => set({ routeLines: v })} />
                      </Row>
                      <Row label="Sub-pixel" title="Line centres follow the drawn line (its darkness profile), not the pixel grid — thin, smoothed lines stay straight and smooth">
                        <Toggle on={settings.lineSubpixel} onChange={(v) => set({ lineSubpixel: v })} />
                      </Row>
                      <Row label="Thin lines" title="Lines narrower than the hairline width">
                        <Seg
                          value={settings.thinTriple ? "triple" : "running"}
                          onChange={(v) => set({ thinTriple: v === "triple" })}
                          options={[
                            ["running", "Running"],
                            ["triple", "Triple"],
                          ]}
                        />
                      </Row>
                    </>
                  )}
                </Group>
                <Group title="Stitch types" hint="Lines narrower than the hairline width are running stitch, wider ones satin.">
                  <Row label="Satin strokes" title="Narrow, elongated regions become satin columns along their medial axis">
                    <span className="dz-inline">
                      <Toggle on={settings.allowSatin} onChange={(v) => set({ allowSatin: v })} />
                      {settings.allowSatin && (
                        <>
                          <span className="stat">up to</span>
                          <Num value={settings.satinMaxWidthMm} unit="mm" step={0.5} min={1} max={12} onChange={(v) => set({ satinMaxWidthMm: v })} />
                        </>
                      )}
                    </span>
                  </Row>
                  <Row label="Hairlines" title="Very thin lines become running stitch">
                    <span className="dz-inline">
                      <Toggle on={settings.allowRunning} onChange={(v) => set({ allowRunning: v })} />
                      {settings.allowRunning && (
                        <>
                          <span className="stat">up to</span>
                          <Num value={settings.runningMaxWidthMm} unit="mm" step={0.1} min={0.2} max={3} onChange={(v) => set({ runningMaxWidthMm: v })} />
                        </>
                      )}
                    </span>
                  </Row>
                </Group>
                <Group title="Extra lines" hint={EXTRA.find((x) => x[0] === extra)?.[3]}>
                  <div className="dz-sources" role="radiogroup" aria-label="Extra lines">
                    {EXTRA.map(([id, icon, label, hint]) => (
                      <button key={id} role="radio" aria-checked={extra === id} className={extra === id ? "on" : ""} title={hint} onClick={() => chooseExtra(id)}>
                        {icon}
                        <span>{label}</span>
                      </button>
                    ))}
                  </div>
                  {extra === "colour" && (
                    <>
                      {!settings.seamless && <p className="dz-hint warn">Colour edges need seamless tracing — turn it on under Shapes.</p>}
                      <Row label="Contrast" title="Only edges between colours at least this different (CIEDE2000) — higher: fewer lines">
                        <Slider min={5} max={80} step={1} digits={0} unit="ΔE" value={settings.edgeContrast} onChange={(v) => set({ edgeContrast: v })} />
                      </Row>
                      <Row label="Stitch">
                        <Seg
                          value={settings.edgeOutlines === "satin" ? "satin" : "running"}
                          onChange={(v) => set({ edgeOutlines: v })}
                          options={[
                            ["running", "Running"],
                            ["satin", "Satin"],
                          ]}
                        />
                      </Row>
                      {settings.edgeOutlines === "satin" && (
                        <Row label="Width" title="Satin width (the border uses it too)">
                          <Slider min={0.8} max={6} step={0.1} unit="mm" value={settings.outlineWidthMm} onChange={(v) => set({ outlineWidthMm: v })} />
                        </Row>
                      )}
                      {outlineColourRow}
                    </>
                  )}
                  {extra !== "none" && extra !== "colour" && (
                    <Row label="Amount" title="More lines, and fainter ones, with higher values">
                      <Slider min={0} max={1} step={0.05} value={settings.lineStrength} onChange={(v) => set({ lineStrength: v })} />
                    </Row>
                  )}
                  {extra !== "none" && <p className="dz-hint">One line per place: the lines in the picture come first, then the border, then these.</p>}
                </Group>
              </>
            )}

            {pane === "cross" && (
              <>
                <Group title="Cells" hint="One cross per cell; the cells line up with the canvas grid, so crosses of different colours meet exactly.">
                  <Row label="Cell" title="Size of one cross (Ink/Stitch pattern size)">
                    <span className="dz-inline">
                      <Num value={cross.cell} step={0.1} min={0.8} max={12} unit="mm" onChange={(v) => setCross({ cell: v })} />
                      {!cross.square && <Num value={cross.cellY} step={0.1} min={0.8} max={12} unit="mm" onChange={(v) => setCross({ cellY: v })} />}
                      <Toggle on={cross.square} onChange={(v) => setCross({ square: v, cellY: cross.cell })} title="Square cells" />
                    </span>
                  </Row>
                  <Row label="Coverage" title="How much of a cell must be stitched to get a cross">
                    <Slider min={10} max={100} step={5} digits={0} unit="%" value={Math.round(cross.coverage * 100)} onChange={(v) => setCross({ coverage: v / 100 })} />
                  </Row>
                  {crossed && (
                    <p className="dz-hint">
                      {crossed.cols} × {crossed.rows} cells · <b>{crossed.crosses.toLocaleString()}</b> crosses in {crossed.threads.length} colour{crossed.threads.length === 1 ? "" : "s"}
                    </p>
                  )}
                </Group>
                <Group title="Stitches" hint={CROSS_KINDS.find((k) => k[0] === cross.kind)?.[2]}>
                  <div className="seg seg-full">
                    {CROSS_KINDS.map(([k, l, t]) => (
                      <button key={k} title={t} className={cross.kind === k ? "on" : ""} onClick={() => setCross({ kind: k })}>
                        {l}
                      </button>
                    ))}
                  </div>
                  <Row label="Grid on the cells" title="After adding, show the canvas grid at the cell size">
                    <Toggle on={cross.grid} onChange={(v) => setCross({ grid: v })} />
                  </Row>
                </Group>
              </>
            )}

            {pane === "stitches" && (
              <>
                <Group title="Fill" hint={FILL_METHODS.find((m) => m.id === settings.fillMethod)?.hint}>
                  <div className="dz-methods">
                    {FILL_METHODS.map((m) => (
                      <button
                        key={m.id}
                        className={settings.fillMethod === m.id ? "on" : ""}
                        title={m.hint}
                        onClick={() => {
                          const d = fillMethodDefaults(m.id);
                          set({ fillMethod: d.method!, rowSpacing: d.rowSpacing ?? settings.rowSpacing, underlay: d.underlay ?? settings.underlay });
                        }}
                      >
                        <m.icon size={15} />
                        {m.label}
                      </button>
                    ))}
                  </div>
                  <Row label="Density" title="Row spacing — smaller is denser">
                    <Slider min={0.15} max={settings.fillMethod === "hilbert" || settings.fillMethod === "stipple" || settings.fillMethod === "meander" ? 3 : 1} step={0.01} unit="mm" value={settings.rowSpacing} onChange={(v) => set({ rowSpacing: v })} />
                  </Row>
                  <Row label="Underlay" title="A light foundation layer under each fill">
                    <Toggle on={settings.underlay} onChange={(v) => set({ underlay: v })} />
                  </Row>
                </Group>
                {settings.fillMethod === "flow" && (
                  <Group title="Flow" hint="Lower strength straightens the rows towards the base direction.">
                    <Row label="Strength" title="How much rows follow the picture (100 %) instead of the base direction (0 %)">
                      <Slider min={0} max={100} step={5} digits={0} unit="%" value={Math.round(settings.flowStrength * 100)} onChange={(v) => set({ flowStrength: v / 100 })} />
                    </Row>
                    <Row label="Detail" title="Field cells across each shape — more follow smaller features, fewer give long sweeping rows">
                      <Slider min={8} max={100} step={2} digits={0} value={settings.flowDetail} onChange={(v) => set({ flowDetail: v })} />
                    </Row>
                    <Row label="Smoothing" title="Smoothing passes of the picture's edge flow — more give calmer curves">
                      <Slider min={1} max={8} step={1} digits={0} value={settings.flowSmoothing} onChange={(v) => set({ flowSmoothing: v })} />
                    </Row>
                  </Group>
                )}
                {DIRECTED.includes(settings.fillMethod) && (
                  <Group
                    title={settings.fillMethod === "flow" ? "Base direction" : "Direction"}
                    hint={settings.fillMethod === "flow" ? "Where the picture has no clear flow, and at lower strength, rows lean this way." : DIRECTIONS.find((d) => d[0] === direction)?.[2]}
                  >
                    <Seg
                      full
                      value={direction}
                      onChange={(v) => (v === "fixed" ? set({ fillAngle: settings.fillAngle ?? 45 }) : set({ fillAngle: null, fillDirection: v }))}
                      options={DIRECTIONS.map(([id, label]) => [id, label])}
                    />
                    {direction === "fixed" && (
                      <Row label="Angle">
                        <Slider min={-90} max={90} step={5} digits={0} unit="°" value={settings.fillAngle ?? 45} onChange={(v) => set({ fillAngle: v })} />
                      </Row>
                    )}
                  </Group>
                )}
              </>
            )}

            {pane === "ai" && (
              <>
                <p className="dz-hint">
                  <span className="badge">on-device</span> The models are bundled with Filum and run on this computer.
                </p>
                <Group title="Objects" hint="MobileSAM: click an object in the picture, then decide what happens to it.">
                  <button className={`btn sm ${samMode ? "primary" : ""}`} style={{ width: "100%" }} disabled={!bmp} onClick={() => (samMode ? setSamMode(false) : startSam())}>
                    <MousePointerClick size={13} /> {samMode ? "Done selecting" : "Select objects"}
                  </button>
                  {samMode && (
                    <>
                      <p className="dz-hint">Click to add · Alt- or right-click to exclude a part.</p>
                      <div className="dz-mask-actions">
                        {MASK_MODES.map(([mode, label, hint]) => (
                          <button key={mode} className={`btn sm ${mode}`} disabled={!curMask} onClick={() => useMask(mode)} title={hint}>
                            {label}
                          </button>
                        ))}
                        <button className="btn sm ghost" disabled={!samPts.length} onClick={() => (setSamPts([]), setCurMask(null))}>
                          Clear
                        </button>
                      </div>
                    </>
                  )}
                  {masks.length > 0 && (
                    <div className="dz-masks">
                      {masks.map((m, i) => (
                        <span key={i} className={`chip ${m.mode}`} title={MASK_MODES.find((x) => x[0] === m.mode)?.[2]}>
                          {MASK_MODES.find((x) => x[0] === m.mode)?.[1]} {i + 1}
                          <button className="mini" onClick={() => setMasks(masks.filter((_, k) => k !== i))} title="Delete">
                            <Trash2 size={11} />
                          </button>
                        </span>
                      ))}
                    </div>
                  )}
                </Group>
                <Group title="Text" hint="Tesseract: ticked lines are erased from the picture and added as real lettering.">
                  <button className="btn sm" style={{ width: "100%" }} disabled={!img || !!busy} onClick={runOcr}>
                    <ScanText size={13} /> {textLines ? "Find text again" : "Find text"}
                  </button>
                  {textLines && textLines.length > 0 && (
                    <div className="dz-text">
                      {textLines.map((l, i) => (
                        <label key={i} className="dz-textline" title={`${Math.round(l.confidence)}% confident`}>
                          <input type="checkbox" checked={!!textPick[i]} onChange={(e) => setTextPick(textPick.map((v, k) => (k === i ? e.target.checked : v)))} />
                          <span>{l.text}</span>
                          <i className="stat">{Math.round(l.confidence)}%</i>
                        </label>
                      ))}
                    </div>
                  )}
                  {textLines && !textLines.length && <p className="dz-hint">No text found.</p>}
                </Group>
              </>
            )}
          </div>

          <div className="dz-side-foot">
            <button className="btn sm ghost" disabled={!paneChanges(pane)} onClick={() => resetPane(pane)} title="Back to the defaults of this tab">
              <RotateCcw size={12} /> Reset {PANES.find((p) => p.id === pane)?.label.toLowerCase()}
            </button>
            <div className="spacer" />
            <button className="btn sm ghost" onClick={() => setSettings(presetSettings("logo"))} title="All settings back to the defaults">
              Reset all
            </button>
          </div>
        </div>

        <div className="dz-main">
          <div className="dz-tabs">
            <div className="seg">
              {(
                [
                  ["original", "Original"],
                  ["colours", "Regions"],
                  ["vector", "Shapes"],
                  ["stitches", "Stitches"],
                ] as [Tab, string][]
              ).map(([id, label]) => (
                <button key={id} className={tab === id ? "on" : ""} onClick={() => setTab(id)}>
                  {label}
                </button>
              ))}
            </div>
            {tab === "stitches" && (
              <div className="seg">
                <button className={stitchLook === "realistic" ? "on" : ""} onClick={() => setStitchLook("realistic")}>
                  Realistic
                </button>
                <button className={stitchLook === "stitch" ? "on" : ""} onClick={() => setStitchLook("stitch")}>
                  Stitch
                </button>
              </div>
            )}
            <div className="spacer" />
            {busy && (
              <span className="stat" style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <span className="dot-pulse" /> {busy}
              </span>
            )}
          </div>
          <div ref={boxRef} className={`dz-box ${tab === "colours" ? "checker" : ""}`}>
            {pickRole && img && (tab === "original" || tab === "colours") && (
              <div className="dz-pickbar">
                <Pipette size={13} /> Click colours to make them <b>{ROLES.find((r) => r.id === pickRole)?.label.toLowerCase()}</b>
                <button className="btn sm" onClick={() => setPickRole(null)}>
                  Done
                </button>
              </div>
            )}
            {!img ? (
              <button className="dz-empty" onClick={pick}>
                <ImageUp size={28} />
                <b>Drop, paste or choose an image</b>
                <span>PNG, JPG, WebP, BMP or GIF — logos and flat artwork work best</span>
              </button>
            ) : error ? (
              <span className="hint" style={{ color: "var(--accent)" }}>
                {error}
              </span>
            ) : tab === "original" && samMode && bmp ? (
              <SamCanvas bmp={bmp} sam={sam} mask={curMask} pts={samPts} masks={masks} w={pw} h={ph} onPick={samClick} />
            ) : tab === "original" && wantMap && edgeKind === wantMap && edgeMap && !eyedropper ? (
              <PreviewCanvas
                draw={(ctx, dpr) => {
                  const t = document.createElement("canvas");
                  t.width = edgeMap.width;
                  t.height = edgeMap.height;
                  t.getContext("2d")!.putImageData(edgeMapImage(edgeMap), 0, 0);
                  const W = ctx.canvas.width;
                  const H = ctx.canvas.height;
                  const ar = bmp ? bmp.height / bmp.width : 0.75;
                  const k = Math.min((W - 24 * dpr) / 1, (H - 24 * dpr) / ar);
                  ctx.drawImage(t, (W - k) / 2, (H - k * ar) / 2, k, k * ar);
                }}
                w={pw}
                h={ph}
              />
            ) : tab === "original" ? (
              <img
                ref={imgRef}
                src={img.url}
                alt={img.name}
                onClick={onOriginalClick}
                style={{ cursor: eyedropper ? "crosshair" : "default", maxWidth: "100%", maxHeight: "100%" }}
              />
            ) : tab === "colours" ? (
              preview && <RegionEditor preview={preview} overrides={overrides} edits={regionEdits} w={pw} h={ph} onToggle={toggleRegion} />
            ) : tab === "stitches" ? (
              plan && previewDoc ? (
                <DesignView doc={previewDoc} plan={plan} mode={stitchLook} fabricColor={fabricColor} />
              ) : (
                !busy && <span className="hint">Nothing to stitch — every colour is left out.</span>
              )
            ) : (
              previewDoc && <DesignView doc={previewDoc} plan={plan} mode="vector" fabricColor={fabricColor} gridStep={output === "cross" ? cross.cell : undefined} />
            )}
          </div>
          {tab === "colours" && preview && (
            <div className="dz-legend">
              <span>
                <i className="hatch" /> left out
              </span>
              <span>
                <i className="keep" /> you stitched
              </span>
              <span>
                <i className="drop" /> you left out
              </span>
              <span className="stat">Click an area to flip it · Alt-click: the whole colour</span>
            </div>
          )}
          <div className="dz-stats">
            {preview && removedShare > 0.002 && tab !== "colours" && (
              <button className="dz-notice" onClick={() => setTab("colours")} title="Show what is left out and edit it">
                <b>{(removedShare * 100).toFixed(0)}%</b> left out · review
              </button>
            )}
            {result && (
              <>
                <span>
                  <b>{result.objects.length}</b> objects
                </span>
                <span className="stat">
                  {output === "cross" && crossed
                    ? `${crossed.crosses.toLocaleString()} crosses · ${crossed.cols} × ${crossed.rows} cells`
                    : `${counts.fill} fills · ${counts.satin} satins · ${counts.running} running`}
                </span>
                <span>
                  <b>{result.threads.length}</b> threads
                </span>
              </>
            )}
            {stats && (
              <>
                <span>
                  <b>{stats.stitches.toLocaleString()}</b> stitches
                </span>
                <span>
                  <b>{fmtTime(stats.seconds)}</b> min
                </span>
              </>
            )}
            {preview && (
              <span className={tooBig ? "warn" : ""} title={tooBig ? `Larger than the ${doc.hoop.name} hoop` : undefined}>
                <b>
                  {widthMm.toFixed(0)} × {heightMm.toFixed(0)}
                </b>{" "}
                mm{tooBig ? " ⚠" : ""}
              </span>
            )}
          </div>
        </div>
      </div>
    </Dialog>
  );
}

/** The original picture with click-to-select objects (MobileSAM). */
function SamCanvas({
  bmp,
  sam,
  mask,
  pts,
  masks,
  w,
  h,
  onPick,
}: {
  bmp: ImageBitmap;
  sam: SamImage | null;
  mask: Uint8Array | null;
  pts: SamPoint[];
  masks: { mode: string; px: Uint8Array; w: number; h: number }[];
  w: number;
  h: number;
  onPick: (p: SamPoint) => void;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
    drawSam(c.getContext("2d")!, dpr, bmp, sam, mask, pts, masks);
  }, [bmp, sam, mask, pts, masks, w, h]);
  const click = (e: React.MouseEvent<HTMLCanvasElement>, negative: boolean) => {
    if (!sam || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    const k = Math.min((r.width - 24) / bmp.width, (r.height - 24) / bmp.height);
    const x0 = (r.width - bmp.width * k) / 2;
    const y0 = (r.height - bmp.height * k) / 2;
    const ix = (e.clientX - r.left - x0) / k;
    const iy = (e.clientY - r.top - y0) / k;
    if (ix < 0 || iy < 0 || ix > bmp.width || iy > bmp.height) return;
    onPick({ x: (ix / bmp.width) * sam.w, y: (iy / bmp.height) * sam.h, label: negative || e.altKey ? 0 : 1 });
  };
  return (
    <canvas
      ref={ref}
      style={{ width: w, height: h, cursor: sam ? "crosshair" : "progress" }}
      onClick={(e) => click(e, false)}
      onContextMenu={(e) => {
        e.preventDefault();
        click(e, true);
      }}
    />
  );
}
