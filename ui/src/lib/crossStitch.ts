// Cross stitch (Ink/Stitch extensions/cross_stitch_assistant.py): pictures
// become a grid of cells, one thread colour each — the digitizer's colour
// stage decides the colours (palette, thread chart, background, left-out
// areas), `cellsFromRegions` lays them on the grid; fill shapes are snapped
// to the grid (pixelated) and get cross stitch settings. Cells of one colour
// are traced into outlines with holes, so every colour is one fill object
// whose crosses land exactly on the grid.

import type { CrossKind, DesignObject, FillParams, SubPath, Thread, Vec2 } from "../types";
import { defaultFill } from "./geometry";

export interface CrossGrid {
  /** Cell size (mm). */
  sx: number;
  sy: number;
  /** Top-left of the grid (mm), on whole cells of the page grid. */
  x0: number;
  y0: number;
  cols: number;
  rows: number;
}

/** Each cell's colour index (-1: empty), row by row. */
export type Cells = Int32Array;

/** What the digitizer's colour stage made of a picture (DigitizePreview). */
export interface ColourRegions {
  regionWidth: number;
  regionHeight: number;
  /** Region id per pixel. */
  regions: Uint32Array;
  /** Per region: colour index (≥ `colours`: transparent / gradient). */
  regionLabel: Uint8Array;
  /** Per region: 0 = stitched, else why not (background, left-out colour, edit, mask). */
  regionReason: Uint8Array;
  /** Number of colours. */
  colours: number;
  /** Size of the picture (mm). */
  widthMm: number;
  heightMm: number;
}

/**
 * The picture's colours on a grid of cells: a cell gets a cross when at
 * least `coverage` of it is stitched, in the colour most of it has. Every
 * decision of the colour stage carries over — palette and thread chart,
 * background, left-out colours, clicked areas and object masks.
 */
export function cellsFromRegions(p: ColourRegions, grid: CrossGrid, coverage: number): Cells {
  const cells = new Int32Array(grid.cols * grid.rows).fill(-1);
  const W = p.regionWidth;
  const H = p.regionHeight;
  if (!W || !H || !p.widthMm || !p.heightMm) return cells;
  const kx = W / p.widthMm;
  const ky = H / p.heightMm;
  const count = new Float64Array(Math.max(1, p.colours));
  for (let r = 0; r < grid.rows; r++)
    for (let c = 0; c < grid.cols; c++) {
      const x0 = (grid.x0 + c * grid.sx) * kx;
      const x1 = (grid.x0 + (c + 1) * grid.sx) * kx;
      const y0 = (grid.y0 + r * grid.sy) * ky;
      const y1 = (grid.y0 + (r + 1) * grid.sy) * ky;
      // pixels whose centre lies in the cell (at least the one under its centre)
      let px0 = Math.max(0, Math.ceil(x0 - 0.5));
      let px1 = Math.min(W - 1, Math.ceil(x1 - 0.5) - 1);
      let py0 = Math.max(0, Math.ceil(y0 - 0.5));
      let py1 = Math.min(H - 1, Math.ceil(y1 - 0.5) - 1);
      if (px1 < px0) px0 = px1 = Math.min(W - 1, Math.max(0, Math.floor((x0 + x1) / 2)));
      if (py1 < py0) py0 = py1 = Math.min(H - 1, Math.max(0, Math.floor((y0 + y1) / 2)));
      // the whole cell counts, also where it reaches past the picture
      const total = Math.max((px1 - px0 + 1) * (py1 - py0 + 1), (x1 - x0) * (y1 - y0));
      count.fill(0);
      for (let y = py0; y <= py1; y++)
        for (let x = px0; x <= px1; x++) {
          const reg = p.regions[y * W + x];
          if (p.regionReason[reg] !== 0) continue;
          const lab = p.regionLabel[reg];
          if (lab < p.colours) count[lab]++;
        }
      let best = -1;
      let n = 0;
      let stitched = 0;
      for (let k = 0; k < p.colours; k++) {
        stitched += count[k];
        if (count[k] > n) [best, n] = [k, count[k]];
      }
      if (best >= 0 && stitched >= coverage * total - 1e-9) cells[r * grid.cols + c] = best;
    }
  return cells;
}

/**
 * Outlines of the cells where `inside(c, r)` (grid corners, mm): closed
 * rings, outer ones and holes, traced along the cell edges.
 */
export function traceCells(grid: CrossGrid, inside: (c: number, r: number) => boolean): Vec2[][] {
  const { cols, rows, sx, sy, x0, y0 } = grid;
  const at = (c: number, r: number) => c >= 0 && r >= 0 && c < cols && r < rows && inside(c, r);
  // directed edges with the cell on the left (clockwise on screen with y down)
  const next = new Map<string, string[]>();
  const key = (x: number, y: number) => `${x},${y}`;
  const edge = (a: [number, number], b: [number, number]) => {
    const k = key(...a);
    if (!next.has(k)) next.set(k, []);
    next.get(k)!.push(key(...b));
  };
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      if (!at(c, r)) continue;
      if (!at(c, r - 1)) edge([c, r], [c + 1, r]);
      if (!at(c + 1, r)) edge([c + 1, r], [c + 1, r + 1]);
      if (!at(c, r + 1)) edge([c + 1, r + 1], [c, r + 1]);
      if (!at(c - 1, r)) edge([c, r + 1], [c, r]);
    }
  const rings: Vec2[][] = [];
  for (const start of [...next.keys()]) {
    while ((next.get(start) ?? []).length) {
      const ring: [number, number][] = [];
      let cur = start;
      let guard = 0;
      do {
        const [x, y] = cur.split(",").map(Number) as [number, number];
        ring.push([x, y]);
        const outs = next.get(cur)!;
        const nx = outs.pop()!;
        cur = nx;
      } while (cur !== start && (next.get(cur) ?? []).length && guard++ < 1e6);
      // straight runs merged
      const pts = ring.filter((p, i) => {
        const a = ring[(i + ring.length - 1) % ring.length];
        const b = ring[(i + 1) % ring.length];
        return (b[0] - p[0]) * (p[1] - a[1]) - (b[1] - p[1]) * (p[0] - a[0]) !== 0;
      });
      if (pts.length >= 3) rings.push(pts.map(([x, y]) => [x0 + x * sx, y0 + y * sy] as Vec2));
    }
  }
  return rings;
}

/** Cross stitch settings for a grid (Ink/Stitch set_element_cross_stitch_params). */
export function crossParams(sx: number, sy: number, kind: FillParams["crossKind"], coverage: number): Partial<FillParams> {
  return {
    method: "cross",
    crossSize: sx,
    crossSizeY: Math.abs(sx - sy) > 1e-9 ? sy : 0,
    crossKind: kind ?? "cross",
    crossCoverage: coverage,
    crossGridCanvas: true,
    crossOffset: [0, 0],
    expand: 0.1,
    underlay: false,
  };
}

/** A grid of whole page cells covering a box (mm). */
export function gridOver(x: number, y: number, w: number, h: number, sx: number, sy: number): CrossGrid {
  const x0 = Math.floor(x / sx) * sx;
  const y0 = Math.floor(y / sy) * sy;
  return { sx, sy, x0, y0, cols: Math.max(1, Math.ceil((x + w - x0) / sx)), rows: Math.max(1, Math.ceil((y + h - y0) / sy)) };
}

const ring = (pts: Vec2[]): SubPath => ({ closed: true, nodes: pts.map((p) => ({ p })) });
export const ringsToPaths = (rings: Vec2[][]): SubPath[] => rings.map(ring);

/** Even-odd containment of a point in polygons (fills with holes). */
export function insidePaths(rings: Vec2[][], p: Vec2): boolean {
  let inside = false;
  for (const r of rings)
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const [a, b] = [r[i], r[j]];
      if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1] || 1e-12) + a[0]) inside = !inside;
    }
  return inside;
}

/**
 * Pixelate shapes onto the grid (Ink/Stitch pixelate): a cell belongs to a
 * shape when at least `coverage` of it is inside (sampled 3 × 3). With
 * `removeOverlaps`, later shapes take the cells they cover from earlier ones.
 */
export function pixelate(shapes: { rings: Vec2[][] }[], grid: CrossGrid, coverage: number, removeOverlaps: boolean): Vec2[][][] {
  const owner = new Int32Array(grid.cols * grid.rows).fill(-1);
  const cellsOf: Set<number>[] = shapes.map(() => new Set());
  shapes.forEach((s, k) => {
    for (let r = 0; r < grid.rows; r++)
      for (let c = 0; c < grid.cols; c++) {
        let n = 0;
        for (let u = 0; u < 3; u++)
          for (let v = 0; v < 3; v++) if (insidePaths(s.rings, [grid.x0 + (c + (u + 0.5) / 3) * grid.sx, grid.y0 + (r + (v + 0.5) / 3) * grid.sy])) n++;
        if (n / 9 < coverage - 1e-9) continue;
        const i = r * grid.cols + c;
        if (removeOverlaps && owner[i] >= 0) cellsOf[owner[i]].delete(i);
        owner[i] = k;
        cellsOf[k].add(i);
      }
  });
  return cellsOf.map((set) => traceCells(grid, (c, r) => set.has(r * grid.cols + c)));
}

/** New objects from cells: one cross-stitch fill per colour (`colours` of them). */
export function cellsToObjects(grid: CrossGrid, cells: Cells, colours: number, threadFor: (k: number) => string, base: FillParams, nameOf: (k: number) => string, makeId: () => string): DesignObject[] {
  const out: DesignObject[] = [];
  for (let k = 0; k < colours; k++) {
    const rings = traceCells(grid, (c, r) => cells[r * grid.cols + c] === k);
    if (!rings.length) continue;
    out.push({
      id: makeId(),
      name: nameOf(k),
      thread: threadFor(k),
      visible: true,
      locked: false,
      paths: ringsToPaths(rings),
      stitch: { type: "fill", ...base },
      trimAfter: false,
      stopAfter: false,
    });
  }
  return out;
}

// ---- the digitizer's cross stitch output ----------------------------------

/** Cross stitch settings of the digitizer. */
export interface CrossSettings {
  /** Cell size (mm); \`cellY\` when the cells are not square. */
  cell: number;
  cellY: number;
  square: boolean;
  kind: CrossKind;
  /** Share of a cell that must be stitched to get a cross. */
  coverage: number;
  /** Show the canvas grid on the cells after adding. */
  grid: boolean;
}

export const CROSS_DEFAULTS: CrossSettings = { cell: 2.5, cellY: 2.5, square: true, kind: "cross", coverage: 0.5, grid: true };

/** A thread colour of the colour stage. */
export interface CrossColour {
  hex: string;
  name: string;
  code: string;
}

/**
 * The picture as cross stitch: one thread and one cross-stitch fill per
 * colour that has cells, on a grid whose corner is the picture's (0, 0).
 */
export function crossStitchDesign(
  p: ColourRegions & { colors: CrossColour[] },
  s: CrossSettings,
  brand: string,
  name: string,
  makeId: () => string,
): { threads: Thread[]; objects: DesignObject[]; cols: number; rows: number; crosses: number } {
  const sy = s.square ? s.cell : s.cellY;
  const grid = gridOver(0, 0, p.widthMm, p.heightMm, s.cell, sy);
  const cells = cellsFromRegions(p, grid, s.coverage);
  const base: FillParams = { ...defaultFill(), ...crossParams(s.cell, sy, s.kind, s.coverage) };
  const threads: Thread[] = p.colors.map((c, k) => ({ id: `x${k}`, name: c.name || c.hex.toUpperCase(), color: c.hex, brand: c.code ? brand : "", code: c.code }));
  const objects = cellsToObjects(grid, cells, p.colors.length, (k) => threads[k].id, base, (k) => `${name} · ${threads[k].name}`, makeId);
  const used = new Set(objects.map((o) => o.thread));
  let crosses = 0;
  for (const v of cells) if (v >= 0) crosses++;
  return { threads: threads.filter((t) => used.has(t.id)), objects, cols: grid.cols, rows: grid.rows, crosses };
}
