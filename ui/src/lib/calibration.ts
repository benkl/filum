// Fabric calibration: a test swatch sewn without pull compensation, measured
// by hand, turned into the starting numbers new objects get on that fabric.
//
// The swatch: two tatami discs (rows across, rows up and down) and two satin
// bars (lying, standing), each labelled in running stitch. Thread pulls a
// shape in along its stitches and pushes it out across them; the measurements
// give both, per stitch type:
//
//   satin  along: sewn narrower → pull compensation (in total, as the satin's own)
//          across: sewn longer → column ends pulled in (each end)
//   fill   across: sewn bigger → the shape drawn smaller (expand < 0, each side)
//          along: sewn narrower → pull compensation (each side), plus what the
//                 smaller shape takes away along the rows
//
// The swatch is sewn on the fabric's own settings, so what the fabric preset
// already adds is in the measurement: the result is what the objects add.

import { defaultFill, defaultSatin, ellipsePath, uid } from "./geometry";
import type { DesignObject, Fabric, FillParams, MachineSettings, SatinParams, StitchDocument, SubPath, ThreadWeight, Vec2 } from "../types";

export type PieceId = "a" | "b" | "c" | "d";
export type Direction = "along" | "across";

export interface Piece {
  id: PieceId;
  letter: string;
  name: string;
  kind: "fill" | "satin";
  /** Drawn size along and across the stitches (mm). */
  along: number;
  across: number;
  /** Which way the stitches run on the swatch. */
  stitches: "horizontal" | "vertical";
}

export const DISC = 24;
export const BAR_W = 4;
export const BAR_L = 30;

export const PIECES: Piece[] = [
  { id: "a", letter: "A", name: "Disc, rows across", kind: "fill", along: DISC, across: DISC, stitches: "horizontal" },
  { id: "b", letter: "B", name: "Disc, rows up and down", kind: "fill", along: DISC, across: DISC, stitches: "vertical" },
  { id: "c", letter: "C", name: "Bar lying", kind: "satin", along: BAR_W, across: BAR_L, stitches: "vertical" },
  { id: "d", letter: "D", name: "Bar standing", kind: "satin", along: BAR_W, across: BAR_L, stitches: "horizontal" },
];

/** Where the pieces sit in the 100 × 100 mm swatch (mm): a box per piece. */
export const LAYOUT: Record<PieceId, { x: number; y: number; w: number; h: number }> = {
  a: { x: 14, y: 18, w: DISC, h: DISC },
  b: { x: 62, y: 18, w: DISC, h: DISC },
  c: { x: 11, y: 68, w: BAR_L, h: BAR_W },
  d: { x: 72, y: 55, w: BAR_W, h: BAR_L },
};
/** Label positions (top-left of a 3.5 × 5 mm letter). */
const LABEL_AT: Record<PieceId, Vec2> = { a: [7, 9], b: [55, 9], c: [11, 58], d: [62, 55] };

/** Running-stitch letters, 3.5 × 5 mm, one stroke each (retracing where needed). */
const LETTERS: Record<PieceId, Vec2[][]> = {
  a: [
    [
      [0, 5],
      [1.75, 0],
      [3.5, 5],
    ],
    [
      [0.75, 3],
      [2.75, 3],
    ],
  ],
  b: [
    [
      [0, 5],
      [0, 0],
      [2.2, 0],
      [3, 0.6],
      [3, 1.9],
      [2.2, 2.5],
      [0, 2.5],
      [2.3, 2.5],
      [3.3, 3.1],
      [3.3, 4.4],
      [2.5, 5],
      [0, 5],
    ],
  ],
  c: [
    [
      [3.3, 0.8],
      [2.4, 0],
      [1, 0],
      [0, 1],
      [0, 4],
      [1, 5],
      [2.4, 5],
      [3.3, 4.2],
    ],
  ],
  d: [
    [
      [0, 0],
      [0, 5],
      [1.9, 5],
      [3.2, 3.8],
      [3.2, 1.2],
      [1.9, 0],
      [0, 0],
    ],
  ],
};

const SWATCH_THREAD = { id: "swatch", name: "Swatch", color: "#2b3442", brand: "", code: "" };

const obj = (name: string, paths: SubPath[], stitch: DesignObject["stitch"]): DesignObject => ({
  id: uid(),
  name,
  thread: SWATCH_THREAD.id,
  visible: true,
  locked: false,
  paths,
  stitch,
  trimAfter: true,
  stopAfter: false,
});

const line = (pts: Vec2[], at: Vec2 = [0, 0]): SubPath => ({ closed: false, nodes: pts.map(([x, y]) => ({ p: [x + at[0], y + at[1]] as Vec2 })) });

/** The 100 × 100 mm swatch on a fabric, with no pull compensation of its own. */
export function swatchDocument(fabric: Fabric, machine: MachineSettings, threadWeight?: ThreadWeight): StitchDocument {
  const satin = (): DesignObject["stitch"] => ({ type: "satin", ...defaultSatin(), width: BAR_W, pullComp: 0, pullCompPct: 0, pushComp: 0 });
  const fill = (angle: number): DesignObject["stitch"] => ({ type: "fill", ...defaultFill(), angle, pullComp: 0, pullCompPct: 0, expand: 0 });
  const objects: DesignObject[] = [];
  for (const p of PIECES) {
    const b = LAYOUT[p.id];
    objects.push(obj(`${p.letter} label`, LETTERS[p.id].map((s) => line(s, LABEL_AT[p.id])), { type: "running", length: 1.2, tolerance: 0.1, repeats: 1, beanRepeats: 0 }));
    if (p.kind === "fill") objects.push(obj(`${p.letter} · ${p.name}`, [ellipsePath(b.x + b.w / 2, b.y + b.h / 2, b.w / 2, b.h / 2)], fill(p.stitches === "horizontal" ? 0 : 90)));
    else {
      const centre: Vec2[] = b.w > b.h ? [[b.x, b.y + b.h / 2], [b.x + b.w, b.y + b.h / 2]] : [[b.x + b.w / 2, b.y], [b.x + b.w / 2, b.y + b.h]];
      objects.push(obj(`${p.letter} · ${p.name}`, [line(centre)], satin()));
    }
  }
  return {
    version: 1,
    name: `Calibration swatch (${fabric})`,
    threads: [SWATCH_THREAD],
    objects,
    hoop: { name: "100 × 100 mm", width: 100, height: 100 },
    fabric,
    machine,
    options: threadWeight ? ({ threadWeight } as StitchDocument["options"]) : undefined,
  };
}

// ---------------------------------------------------------------------------
// From measurements to settings

export type Measurements = Partial<Record<`${PieceId}${"Along" | "Across"}`, number>>;

export const fieldKey = (id: PieceId, dir: Direction) => `${id}${dir === "along" ? "Along" : "Across"}` as keyof Measurements;

export interface CalibrationResult {
  satin: { pullComp: number; pushComp: number; /** Sewn narrower than drawn (mm). */ shrink: number; /** Sewn longer than drawn (mm). */ grow: number } | null;
  fill: { pullComp: number; expand: number; shrink: number; grow: number } | null;
  notes: string[];
}

const round = (v: number, step = 0.05) => +(Math.round(v / step) * step).toFixed(2) + 0; // +0: no −0
const mean = (xs: (number | undefined)[]) => {
  const v = xs.filter((x): x is number => typeof x === "number" && Number.isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};

/** Settings from the measurements; a stitch type needs both of its pieces' along and across (or one piece of each pair). */
export function calibrate(m: Measurements): CalibrationResult {
  const notes: string[] = [];
  let satin: CalibrationResult["satin"] = null;
  let fill: CalibrationResult["fill"] = null;

  const fAlong = mean([m.aAlong, m.bAlong]);
  const fAcross = mean([m.aAcross, m.bAcross]);
  if (fAlong != null && fAcross != null) {
    const shrink = DISC - fAlong;
    const grow = fAcross - DISC;
    // the shape drawn smaller by the push, the rows reaching further by the pull and what the smaller shape lost
    const expand = round(-grow / 2);
    const pullComp = round(Math.max(0, (shrink + grow) / 2));
    fill = { pullComp, expand, shrink, grow };
    if (shrink < -0.3) notes.push("The discs came out wider along their rows than drawn: the fills need no pull compensation on this fabric.");
    if (m.aAlong != null && m.bAlong != null && Math.abs(m.aAlong - m.bAlong) > 0.5)
      notes.push(
        `Disc ${m.aAlong < m.bAlong ? "A" : "B"} pulled in ${Math.abs(m.aAlong - m.bAlong).toFixed(1)} mm more than the other: the fabric gives more ${m.aAlong < m.bAlong ? "across" : "up and down"} the hoop. Hoop it the same way for real designs, or use a firmer backing.`,
      );
  }

  const sAlong = mean([m.cAlong, m.dAlong]);
  const sAcross = mean([m.cAcross, m.dAcross]);
  if (sAlong != null && sAcross != null) {
    const shrink = BAR_W - sAlong;
    const grow = sAcross - BAR_L;
    satin = { pullComp: round(Math.max(0, shrink)), pushComp: round(Math.max(0, grow / 2)), shrink, grow };
    if (shrink < -0.2) notes.push("The bars came out wider than drawn: satins need no pull compensation on this fabric.");
    if (grow < -0.4) notes.push("The bars came out shorter than drawn, so their ends aren't pulled in.");
  }

  const odd = PIECES.flatMap((p) =>
    (["along", "across"] as const).filter((d) => {
      const v = m[fieldKey(p.id, d)];
      const drawn = p[d];
      return v != null && (v <= 0 || Math.abs(v - drawn) > Math.max(1.5, drawn * 0.15));
    }).map((d) => `${p.letter} ${d}`),
  );
  if (odd.length) notes.unshift(`Check ${odd.join(", ")}: that's far from what was drawn. Measure the stitched area only, without thread tails or the lettering.`);
  return { satin, fill, notes };
}

/** "3,4" and "3.4" → 3.4; empty or not a number → undefined. */
export function parseMm(s: string): number | undefined {
  const v = parseFloat(s.trim().replace(",", "."));
  return Number.isFinite(v) ? v : undefined;
}

// ---------------------------------------------------------------------------
// Saved per fabric, on this device

export interface Calibration {
  fabric: Fabric;
  /** ISO date. */
  date: string;
  measured: Measurements;
  satin?: { pullComp: number; pushComp: number };
  fill?: { pullComp: number; expand: number };
}

const KEY = "filum.calibration";

export function loadCalibrations(): Partial<Record<Fabric, Calibration>> {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

let cache: Partial<Record<Fabric, Calibration>> | null = null;
const all = () => (cache ??= typeof localStorage === "undefined" ? {} : loadCalibrations());

export const calibrationFor = (fabric: Fabric): Calibration | undefined => all()[fabric];

export function saveCalibration(c: Calibration | { fabric: Fabric; clear: true }) {
  const next = { ...all() };
  if ("clear" in c) delete next[c.fabric];
  else next[c.fabric] = c;
  cache = next;
  localStorage.setItem(KEY, JSON.stringify(next));
}

/** What new objects on a fabric start from (nothing when it isn't calibrated). */
export function calibratedDefaults(fabric: Fabric): { satin?: Partial<SatinParams>; fill?: Partial<FillParams> } {
  const c = calibrationFor(fabric);
  if (!c) return {};
  return {
    satin: c.satin ? { pullComp: c.satin.pullComp, ...(c.satin.pushComp ? { pushComp: c.satin.pushComp } : {}) } : undefined,
    fill: c.fill ? { pullComp: c.fill.pullComp, ...(c.fill.expand ? { expand: c.fill.expand } : {}) } : undefined,
  };
}
