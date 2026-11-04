import { cellsFromRegions, CROSS_DEFAULTS, crossStitchDesign, gridOver, pixelate, traceCells, type ColourRegions } from "./crossStitch";

function ok(c: unknown, msg: string) {
  if (!c) throw new Error(msg);
  console.log("ok  ", msg);
}

const grid = gridOver(1, 1, 9, 6, 3, 3);
ok(grid.x0 === 0 && grid.y0 === 0 && grid.cols === 4 && grid.rows === 3, "a grid of whole page cells");

// an L of cells traces to one ring of 6 corners
const L = new Set(["0,0", "0,1", "1,1"]);
const rings = traceCells({ sx: 2, sy: 2, x0: 0, y0: 0, cols: 2, rows: 2 }, (c, r) => L.has(`${c},${r}`));
ok(rings.length === 1 && rings[0].length === 6, `an L: one outline with six corners (${rings.map((r) => r.length)})`);
// a ring of cells has a hole
const ringCells = (c: number, r: number) => !(c === 1 && r === 1);
const withHole = traceCells({ sx: 1, sy: 1, x0: 0, y0: 0, cols: 3, rows: 3 }, ringCells);
ok(withHole.length === 2, "a ring of cells: an outline and a hole");

// the digitizer's colour stage: an 8 × 4 px picture of 8 × 4 mm — left half
// red (colour 0), right half blue (colour 1); the top right 2 × 2 px are left
// out (background region), one blue pixel in the red half
const W = 8;
const H = 4;
const regions = new Uint32Array(W * H);
for (let y = 0; y < H; y++)
  for (let x = 0; x < W; x++) regions[y * W + x] = x < 4 ? 0 : x >= 6 && y < 2 ? 2 : 1;
regions[1 * W + 1] = 1;
const p: ColourRegions = { regionWidth: W, regionHeight: H, regions, regionLabel: new Uint8Array([0, 1, 1]), regionReason: new Uint8Array([0, 0, 1]), colours: 2, widthMm: 8, heightMm: 4 };
const g2 = gridOver(0, 0, 8, 4, 2, 2);
const cells = cellsFromRegions(p, g2, 0.5);
ok(g2.cols === 4 && g2.rows === 2, "a 4 × 2 grid of 2 mm cells");
ok(cells[0] === 0 && cells[1] === 0, "a cell takes the colour most of it has (one blue pixel in red)");
ok(cells[2] === 1 && cells[4 + 3] === 1, "blue cells");
ok(cells[3] === -1, "a cell left out by the colour stage (background) gets no cross");
// coverage: a cell half left out needs at most 50 %
regions[0] = 2;
regions[1] = 2;
ok(cellsFromRegions(p, g2, 0.5)[0] === 0 && cellsFromRegions(p, g2, 0.8)[0] === -1, "coverage decides half-stitched cells");
// cells smaller than a pixel take the pixel under their centre
const fine = cellsFromRegions(p, gridOver(0, 0, 8, 4, 0.5, 0.5), 0.5);
ok(fine.length === 16 * 8 && fine[6 * 16 + 15] === 1 && fine[2 * 16 + 15] === -1, "cells smaller than a pixel take the one under their centre");

// the design: one thread and one cross-stitch fill per colour with cells
let n = 0;
const d = crossStitchDesign({ ...p, colors: [{ hex: "#ff0000", name: "Red", code: "1147" }, { hex: "#0000ff", name: "", code: "" }] }, CROSS_DEFAULTS, "Madeira", "Pic", () => `o${n++}`);
ok(d.objects.length === 2 && d.threads.length === 2, "two colours → two fills and two threads");
ok(d.objects.every((o) => o.stitch.type === "fill" && o.stitch.method === "cross" && o.stitch.crossGridCanvas), "cross stitch on the canvas grid");
ok(d.threads[0].brand === "Madeira" && d.threads[0].code === "1147" && d.threads[1].brand === "" && d.threads[1].name === "#0000FF", "thread chart names and codes carry over");
ok(d.crosses > 0 && d.cols === 4 && d.rows === 2, "cross count");

// pixelate: a square shape covering most of a 2×2 grid; a later one takes a cell
const a = { rings: [[[0, 0], [4, 0], [4, 4], [0, 4]] as [number, number][]] };
const b = { rings: [[[2, 2], [4, 2], [4, 4], [2, 4]] as [number, number][]] };
const px = pixelate([a, b], { sx: 2, sy: 2, x0: 0, y0: 0, cols: 2, rows: 2 }, 0.5, true);
ok(px[0].length === 1 && px[0][0].length === 6 && px[1][0].length === 4, "later shapes take their cells from earlier ones");
