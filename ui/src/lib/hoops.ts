// Hoop presets: the stitchable field of popular frames, grouped by brand.
// Width × height as the frame sits on the machine (height = front to back):
// domestic flat-bed machines take most frames portrait, Brother PR
// multi-needle frames are landscape. Sizes are the embroidery area (not the
// outer frame) from the manufacturers' manuals / product pages, cross-checked
// with Embird's hoop list, the KDE Liberty hoop table and dealer charts.
// Oval and round hoops carry shape "oval": the field is the ellipse inside
// width × height.

import type { Hoop, HoopShape } from "../types";

export interface HoopPreset extends Hoop {
  /** Name without the brand prefix. */
  label: string;
  brand: string;
}

const group = (brand: string, prefix: string, list: [label: string, width: number, height: number, shape?: HoopShape][]): HoopPreset[] =>
  list.map(([label, width, height, shape]) => ({ brand, label, width, height, ...(shape && shape !== "rect" ? { shape } : {}), name: prefix ? `${prefix} ${label}` : label }));

export const HOOPS: HoopPreset[] = [
  ...group("Generic", "", [
    ["100 × 100 mm", 100, 100],
    ["130 × 180 mm", 130, 180],
    ["160 × 260 mm", 160, 260],
    ["200 × 200 mm", 200, 200],
    ["200 × 300 mm", 200, 300],
    ["360 × 200 mm", 360, 200],
    ["Cap 130 × 60 mm", 130, 60],
    ["Mini 70 × 70 mm", 70, 70],
  ]),
  // Brother / Baby Lock domestic (SE, PE, Innov-is, Stellaire, Luminaire).
  // Manuals give "H × W": the 13 × 18 cm frame is 18 cm front to back.
  ...group("Brother / Baby Lock", "Brother", [
    ["S 2 × 6 cm (EF61 / EF82 / SA431)", 60, 20],
    ["M 10 × 10 cm (EF74 / SA432)", 100, 100],
    ["Super hoop 10 × 17 cm (SA434)", 100, 170],
    ["L 13 × 18 cm (EF84 / SA444)", 130, 180],
    ["Square 15 × 15 cm (SA448)", 150, 150],
    ["16 × 26 cm", 160, 260],
    ["Border 10 × 30 cm (BF3)", 100, 300],
    ["13 × 30 cm (EF85, F series)", 130, 300],
    ["18 × 30 cm (EF76)", 180, 300],
    ["Square 20 × 20 cm", 200, 200],
    ["20 × 30 cm (EF92 / SA447)", 200, 300],
    ["Square 24 × 24 cm", 240, 240],
    ["24 × 36 cm (EF95S, Stellaire)", 240, 360],
    ["Square 25.4 × 25.4 cm", 254, 254],
    ["27.2 × 40.8 cm (EF99, Luminaire)", 272, 408],
    ["29.7 × 46.5 cm (Luminaire XP3)", 297, 465],
  ]),
  // Brother PR multi-needle, from the PR680W / PR1055X / PR670E / PR1000e
  // manuals (embroidering area, W × H as mounted — landscape). Wide cap and
  // Jumbo frames are 10-needle only.
  ...group("Brother PR (multi-needle)", "Brother PR", [
    ["Small 6 × 4 cm", 60, 40],
    ["Medium 10 × 10 cm", 100, 100],
    ["Large 18 × 13 cm", 180, 130],
    ["Extra large 30 × 20 cm", 300, 200],
    ["Extra large 36 × 20 cm", 360, 200],
    ["Quilt frame 20 × 20 cm", 200, 200],
    ["Border frame 30 × 10 cm", 300, 100],
    ["Jumbo frame 36 × 36 cm (10-needle)", 360, 360],
    ["Sleeve frame 7 × 20 cm", 70, 200],
    ["Round frame Ø 10 cm", 100, 100, "oval"],
    ["Round frame Ø 13 cm", 130, 130, "oval"],
    ["Round frame Ø 16 cm", 160, 160, "oval"],
    ["Clamp frame S 4.5 × 2.4 cm", 45, 24],
    ["Compact frame 5 × 5 cm", 50, 50],
    ["Compact frame 7 × 4.1 cm", 70, 41],
    ["Compact frame 4.4 × 3.8 cm", 44, 38],
    ["Cap frame 13 × 6 cm", 130, 60],
    ["Wide cap frame 36 × 6 cm (10-needle)", 360, 60],
    ["Cylinder frame 9 × 8 cm", 90, 80],
  ]),
  ...group("Janome / Elna", "Janome", [
    ["C 50 × 50 mm", 50, 50],
    ["FA10 100 × 40 mm (free arm)", 100, 40],
    ["SQ10 100 × 100 mm", 100, 100],
    ["A 126 × 110 mm", 126, 110],
    ["SQ14 140 × 140 mm", 140, 140],
    ["RE20 140 × 200 mm", 140, 200],
    ["RE20a 170 × 200 mm", 170, 200],
    ["SQ20 200 × 200 mm", 200, 200],
    ["RE28 200 × 280 mm", 200, 280],
    ["RE36 200 × 360 mm", 200, 360],
    ["SQ23 230 × 230 mm", 230, 230],
    ["GR 230 × 300 mm", 230, 300],
    ["SQ28 280 × 280 mm", 280, 280],
    ["RE46 280 × 460 mm (Continental M17)", 280, 460],
  ]),
  ...group("Bernina", "Bernina", [
    ["Small oval 72 × 50 mm", 72, 50, "oval"],
    ["Medium 100 × 130 mm", 100, 130],
    ["Large oval 145 × 255 mm", 145, 255, "oval"],
    ["Midi 165 × 265 mm", 165, 265],
    ["Mega 150 × 400 mm", 150, 400],
    ["Maxi 210 × 400 mm", 210, 400],
    ["Jumbo 260 × 400 mm", 260, 400],
  ]),
  // Pfaff names the long side first ("360 × 200"); on the machine it runs front to back.
  ...group("Pfaff / Husqvarna Viking", "Pfaff/Viking", [
    ["Petite 50 × 80 mm", 50, 80],
    ["Round 80 mm", 80, 80, "oval"],
    ["Round 120 mm", 120, 120, "oval"],
    ["Standard 100 × 100 mm", 100, 100],
    ["120 × 115 mm", 120, 115],
    ["Square 120 × 120 mm", 120, 120],
    ["All fabric 150 × 150 mm", 150, 150],
    ["Endless 180 × 100 mm", 100, 180],
    ["Square / Quilters 200 × 200 mm", 200, 200],
    ["Large 225 × 140 mm", 140, 225],
    ["Master / Designer 240 × 150 mm", 150, 240],
    ["Elite / Crown 260 × 200 mm", 200, 260],
    ["Deluxe / Royal 360 × 200 mm", 200, 360],
    ["Grand Dream / Majestic 360 × 350 mm", 350, 360],
  ]),
  ...group("Singer", "Singer", [
    ["Mini 40 × 40 mm", 40, 40],
    ["Futura small 79 × 121 mm", 79, 121],
    ["4 × 4 in (100 × 100 mm)", 100, 100],
    ["Futura large 114 × 171 mm", 114, 171],
    ["5 × 7 in (130 × 180 mm)", 130, 180],
    ["Large 150 × 260 mm (SE300 / SE9180)", 150, 260],
  ]),
];

export const HOOP_GROUPS: string[] = [...new Set(HOOPS.map((h) => h.brand))];

const sameShape = (a: Hoop, b: Hoop) => (a.shape ?? "rect") === (b.shape ?? "rect");
const sameSize = (a: Hoop, b: Hoop) => a.width === b.width && a.height === b.height && sameShape(a, b);

/** The preset a document hoop came from: same name first, else the first with the same size and shape (-1: custom). */
export function hoopIndex(hoop: Hoop): number {
  const byName = HOOPS.findIndex((h) => h.name === hoop.name && sameSize(h, hoop));
  return byName >= 0 ? byName : HOOPS.findIndex((h) => sameSize(h, hoop));
}

/** The document's copy of a preset (no menu fields). */
export const hoopOf = (h: HoopPreset): Hoop => ({ name: h.name, width: h.width, height: h.height, ...(h.shape ? { shape: h.shape } : {}) });
