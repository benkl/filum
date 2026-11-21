// Grid repeat: copies of the selection in rows and columns, for sewing many
// patches or badges in one hoop. The selection stays where it is as the top
// left piece. The pieces are sewn row by row or in a serpentine, and either
// one whole piece after the other or one colour at a time across all the
// pieces: each run of one colour in the original is sewn on every piece
// before the next run, so every piece keeps its own layering.
// After the grid in the NOVAstitch Designer fork (effepol/NOVAstitch-designer).

import type { DesignObject, StitchDocument, Vec2 } from "../types";
import { objectBounds, translateMat, unionBoxes, type Box } from "./geometry";
import { freshCopies, placeCopies } from "./copies";
import { pruneGroups } from "./layerRows";
import { repairLayers } from "./fillLayers";

export type GridOrder = "rows" | "serpentine";
export type GridColours = "byColour" | "byPiece";

export interface GridOptions {
  rows: number;
  cols: number;
  /** Gap between the edges of neighbouring pieces (mm), across and down. */
  gap: Vec2;
  order: GridOrder;
  colours: GridColours;
}

/** More pieces than this are refused. */
export const MAX_PIECES = 400;

/** The cells in sewing order: row by row; a serpentine goes back along every second row. */
export function gridCells(rows: number, cols: number, order: GridOrder): { row: number; col: number }[] {
  const out: { row: number; col: number }[] = [];
  for (let row = 0; row < rows; row++)
    for (let k = 0; k < cols; k++) out.push({ row, col: order === "serpentine" && row % 2 ? cols - 1 - k : k });
  return out;
}

/** The runs of one colour in a piece, as index ranges [start, end). */
function colourRuns(piece: DesignObject[]): [number, number][] {
  const runs: [number, number][] = [];
  piece.forEach((o, k) => {
    if (k && o.thread === piece[k - 1].thread) runs[runs.length - 1][1] = k + 1;
    else runs.push([k, k + 1]);
  });
  return runs;
}

/**
 * The pieces (each in the original's order, cells in sewing order) as one
 * sewing sequence: one piece after the other, or each run of one colour on
 * every piece before the next run.
 */
export function gridSequence(pieces: DesignObject[][], colours: GridColours): DesignObject[] {
  if (colours === "byPiece" || !pieces.length) return pieces.flat();
  return colourRuns(pieces[0]).flatMap(([a, b]) => pieces.flatMap((p) => p.slice(a, b)));
}

/** Colour changes in a sewing sequence. */
export const colourChanges = (seq: DesignObject[]) => seq.reduce((n, o, k) => n + (k && o.thread !== seq[k - 1].thread ? 1 : 0), 0);

/** The box of the whole grid. */
export function gridBox(box: Box, opt: Pick<GridOptions, "rows" | "cols" | "gap">): Box {
  return { x: box.x, y: box.y, w: opt.cols * box.w + (opt.cols - 1) * opt.gap[0], h: opt.rows * box.h + (opt.rows - 1) * opt.gap[1] };
}

const valid = (opt: GridOptions) =>
  [opt.rows, opt.cols].every((n) => Number.isInteger(n) && n >= 1) && opt.rows * opt.cols >= 2 && opt.rows * opt.cols <= MAX_PIECES && opt.gap.every(Number.isFinite);

/**
 * The document with the grid made from the objects `ids`: the copies are
 * independent objects (their own groups, letterings and gradients), and the
 * whole grid is sewn, in its order, where the first of the objects was.
 * `shift` moves the whole grid (the original too), e.g. into the middle of the
 * hoop. Returns the same document when there is nothing to do.
 */
export function gridDoc(doc: StitchDocument, ids: string[], opt: GridOptions, shift: Vec2 = [0, 0]): { doc: StitchDocument; created: DesignObject[] } {
  const want = new Set(ids);
  const sources = doc.objects.filter((o) => want.has(o.id) && !o.locked);
  const box = unionBoxes(sources.map(objectBounds));
  if (!sources.length || !box || !valid(opt)) return { doc, created: [] };
  const [px, py] = [box.w + opt.gap[0], box.h + opt.gap[1]];
  const moved = shift[0] || shift[1];
  const parents: Record<string, string> = {};
  const names: Record<string, string> = {};
  const created: DesignObject[] = [];
  const pieces = gridCells(opt.rows, opt.cols, opt.order).map(({ row, col }) => {
    if (!row && !col) return moved ? placeCopies(sources, translateMat(shift[0], shift[1])) : sources;
    const fresh = freshCopies(doc, sources, { inPlace: true });
    Object.assign(parents, fresh.parents);
    Object.assign(names, fresh.names);
    const placed = placeCopies(fresh.objects, translateMat(col * px + shift[0], row * py + shift[1]));
    created.push(...placed);
    return placed;
  });
  const seq = gridSequence(pieces, opt.colours);
  const taken = new Set(sources.map((o) => o.id));
  const first = doc.objects.findIndex((o) => taken.has(o.id));
  const rest = doc.objects.filter((o) => !taken.has(o.id));
  const objects = [...rest.slice(0, first), ...seq, ...rest.slice(first)];
  const next = pruneGroups(
    repairLayers({
      ...doc,
      objects,
      ...(Object.keys(parents).length ? { groupParents: { ...doc.groupParents, ...parents } } : {}),
      ...(Object.keys(names).length ? { groupNames: { ...doc.groupNames, ...names } } : {}),
    }),
  );
  return { doc: next, created };
}
