// Embroidery machine profiles: the embroidery field, the frames, the formats
// the machine reads, its data limits and how fast it stitches. Limits are
// either documented (Brother support / manuals: a hard error) or reported by
// users (a warning). "Design hoop" checks against the design's own hoop.
//
// The profiles double as settings presets for the design (Design ▸
// Machine): speed and the trim / colour-change times for the estimates, next
// to two general presets — Filum's own defaults and Ink/Stitch's.

import type { MachineSettings, PlanStats } from "../types";

export interface Frame {
  id: string;
  name: string;
  /** mm, as the frame is mounted (width × height). */
  width: number;
  height: number;
  /** Round / oval frames: the field is the ellipse inside width × height. */
  shape?: "oval";
  /** A special-purpose frame (cap, cylinder, sleeve, clamp …) or one that
   *  needs an accessory: never picked automatically. */
  note?: string;
}

export interface Limit {
  value: number;
  /** Where the number comes from. */
  source: string;
  /** Documented by the manufacturer (error) or reported by users (warning). */
  documented: boolean;
}

export interface MachineProfile {
  id: string;
  name: string;
  brand: string;
  /** What it is for (models). */
  models: string;
  /** Formats the machine reads, preferred first. */
  formats: string[];
  /** Largest embroidery field (mm). */
  field: { width: number; height: number };
  frames: Frame[];
  /** Needles: 1 = you rethread at every colour change. */
  needles?: number;
  /** Rated top embroidery speed (stitches per minute). */
  speed?: { spm: number; source: string };
  maxStitches?: Limit;
  maxColorChanges?: Limit;
  /** File names: Brother machines hide names with other characters. */
  fileNames?: "brother";
  notes?: string;
}

const BROTHER_FAQ = "Brother support FAQ (embroidery data not recognized)";
const BROTHER_MANUALS = "Brother manuals (data above this cannot be displayed)";
const COLOR_CHANGES: Limit = {
  value: 127,
  source: BROTHER_FAQ,
  documented: true,
};
const BROTHER_NOTE = "Brother machines ignore a design that is larger than the field, even by 0.1 mm. They also trim jumps themselves (Jump stitch trim, 5–50 mm).";

// frames shared by several profiles (embroidery area, as mounted)
const F = {
  bS: { id: "s", name: "S frame 2 × 6 cm (EF82)", width: 60, height: 20 },
  bM: { id: "m", name: "M frame 10 × 10 cm", width: 100, height: 100 },
  bL: { id: "l", name: "L frame 13 × 18 cm", width: 130, height: 180 },
  b1626: { id: "16x26", name: "16 × 26 cm", width: 160, height: 260 },
  bXL: { id: "xl", name: "20 × 30 cm", width: 200, height: 300 },
  prS: { id: "pr-s", name: "Small 6 × 4 cm", width: 60, height: 40 },
  prM: { id: "pr-m", name: "Medium 10 × 10 cm", width: 100, height: 100 },
  prL: { id: "pr-l", name: "Large 18 × 13 cm", width: 180, height: 130 },
  prXL: {
    id: "pr-xl",
    name: "Extra large 30 × 20 cm",
    width: 300,
    height: 200,
  },
  // optional PR frames (PR680W / PR1055X / PR670E / PR1000e manuals)
  prQuilt: {
    id: "pr-quilt",
    name: "Quilt frame 20 × 20 cm",
    width: 200,
    height: 200,
  },
  prBorder: {
    id: "pr-border",
    name: "Border frame 30 × 10 cm",
    width: 300,
    height: 100,
  },
  prSleeve: {
    id: "pr-sleeve",
    name: "Sleeve frame 7 × 20 cm",
    width: 70,
    height: 200,
    note: "sleeves and tubular items",
  },
  prR100: {
    id: "pr-r100",
    name: "Round frame Ø 10 cm",
    width: 100,
    height: 100,
    shape: "oval",
  },
  prR130: {
    id: "pr-r130",
    name: "Round frame Ø 13 cm",
    width: 130,
    height: 130,
    shape: "oval",
  },
  prR160: {
    id: "pr-r160",
    name: "Round frame Ø 16 cm",
    width: 160,
    height: 160,
    shape: "oval",
  },
  prClampS: {
    id: "pr-clamp-s",
    name: "Clamp frame S 4.5 × 2.4 cm",
    width: 45,
    height: 24,
    note: "clamp frame for thick items",
  },
  prCompact: {
    id: "pr-compact",
    name: "Compact frame 5 × 5 cm",
    width: 50,
    height: 50,
    note: "compact frame for pockets and small items",
  },
  prCap: {
    id: "pr-cap",
    name: "Cap frame 13 × 6 cm",
    width: 130,
    height: 60,
    note: "cap driver",
  },
  prCylinder: {
    id: "pr-cylinder",
    name: "Cylinder frame 9 × 8 cm",
    width: 90,
    height: 80,
    note: "cylinder frame for bags and shoes",
  },
  jSQ14: { id: "sq14", name: "SQ14 14 × 14 cm", width: 140, height: 140 },
  jSQ20: { id: "sq20", name: "SQ20 20 × 20 cm", width: 200, height: 200 },
  jRE28: { id: "re28", name: "RE28 20 × 28 cm", width: 200, height: 280 },
  beS: { id: "small", name: "Small oval 72 × 50 mm", width: 72, height: 50 },
  beM: { id: "medium", name: "Medium 100 × 130 mm", width: 100, height: 130 },
  beL: {
    id: "large",
    name: "Large oval 145 × 255 mm",
    width: 145,
    height: 255,
  },
  beMidi: { id: "midi", name: "Midi 165 × 265 mm", width: 165, height: 265 },
  beMaxi: { id: "maxi", name: "Maxi 210 × 400 mm", width: 210, height: 400 },
} satisfies Record<string, Frame>;

const BL = {
  f4x4: { id: "4x4", name: "4 × 4″", width: 100, height: 100 },
  f5x7: { id: "5x7", name: "5 × 7″", width: 130, height: 180 },
  f6x10: { id: "6x10", name: "6.25 × 10.25″", width: 160, height: 260 },
  f8x12: { id: "8x12", name: "8 × 12″", width: 200, height: 300 },
} satisfies Record<string, Frame>;

function babyLock(id: string, name: string, models: string, width: number, height: number, needles: number, spm: number, frames: Frame[]): MachineProfile {
  return {
    id,
    name,
    brand: "Baby Lock",
    models,
    formats: ["pes", "dst"],
    field: { width, height },
    frames,
    needles,
    speed: { spm, source: "babylock.com specifications" },
    fileNames: "brother",
  };
}

export const MACHINES: MachineProfile[] = [
  {
    id: "doc",
    name: "Design hoop",
    brand: "",
    models: "Checks against the hoop set in the document",
    formats: ["pes", "dst", "jef", "exp", "vp3", "xxx"],
    field: { width: 0, height: 0 },
    frames: [],
  },
  // Brother / Baby Lock — domestic, one needle
  {
    id: "brother-10x10",
    name: "Brother 10 × 10 cm",
    brand: "Brother",
    models: "SE / PE series, Innov-is F420 / F440E / F540E / F580",
    formats: ["pes", "dst"],
    field: { width: 100, height: 100 },
    frames: [{ ...F.bS, name: "S frame 2 × 6 cm (EF82)" }, F.bM],
    needles: 1,
    speed: { spm: 400, source: "SE600 specification (embroidery)" },
    maxStitches: {
      value: 30000,
      source: "reported by users (SE600, Ink/Stitch discussion #1699)",
      documented: false,
    },
    maxColorChanges: COLOR_CHANGES,
    fileNames: "brother",
    notes: BROTHER_NOTE,
  },
  {
    // Brother Australia spec page + Brother UK leaflet: 100 × 100 mm area,
    // one 10 × 10 cm frame in the box, embroidery speed 400 (sewing 850 spm),
    // automatic thread cutter, USB and WLAN (Artspira / Design Database Transfer).
    id: "brother-m380d",
    name: "Brother Innov-is M380D",
    brand: "Brother",
    models: "Innov-is M380D sewing & embroidery machine (10 × 10 cm, USB / WLAN)",
    formats: ["pes", "dst"],
    field: { width: 100, height: 100 },
    frames: [
      { ...F.bS, name: "S frame 2 × 6 cm (EF61 / EF82, optional)" },
      { ...F.bM, name: "M frame 10 × 10 cm (included)" },
    ],
    needles: 1,
    speed: {
      spm: 400,
      source: "Brother Australia M380D specification (embroidery speed max.)",
    },
    maxColorChanges: COLOR_CHANGES,
    fileNames: "brother",
    notes: `${BROTHER_NOTE} Send designs by USB stick or over WLAN with Artspira / Design Database Transfer.`,
  },
  {
    id: "brother-13x18",
    name: "Brother 13 × 18 cm",
    brand: "Brother",
    models: "Innov-is NV / 1250 / M240ED, PE800, SE1900",
    formats: ["pes", "dst"],
    field: { width: 130, height: 180 },
    frames: [{ ...F.bS, name: "S frame 2 × 6 cm" }, F.bM, F.bL],
    needles: 1,
    speed: { spm: 650, source: "PE800 / SE1900 specification (embroidery)" },
    maxStitches: { value: 500000, source: BROTHER_MANUALS, documented: true },
    maxColorChanges: COLOR_CHANGES,
    fileNames: "brother",
    notes: BROTHER_NOTE,
  },
  {
    id: "brother-16x26",
    name: "Brother 16 × 26 cm",
    brand: "Brother",
    models: "Innov-is NV1800Q and other 6 × 10″ machines",
    formats: ["pes", "dst"],
    field: { width: 160, height: 260 },
    frames: [F.bM, F.bL, F.b1626],
    needles: 1,
    maxStitches: { value: 500000, source: BROTHER_MANUALS, documented: true },
    maxColorChanges: COLOR_CHANGES,
    fileNames: "brother",
    notes: BROTHER_NOTE,
  },
  {
    id: "brother-20x30",
    name: "Brother 20 × 30 cm",
    brand: "Brother",
    models: "Innov-is V3 / V5 / XV, NQ3550W",
    formats: ["pes", "dst"],
    field: { width: 200, height: 300 },
    frames: [{ ...F.bM, name: "10 × 10 cm" }, { ...F.bL, name: "13 × 18 cm" }, F.bXL],
    needles: 1,
    speed: { spm: 1050, source: "Brother 20 × 30 cm class, dealer listings" },
    maxStitches: { value: 500000, source: BROTHER_MANUALS, documented: true },
    maxColorChanges: COLOR_CHANGES,
    fileNames: "brother",
    notes: BROTHER_NOTE,
  },
  {
    id: "brother-stellaire",
    name: "Brother 24 × 36 cm",
    brand: "Brother",
    models: "Stellaire XE1 / XE2 / XJ1 / XJ2",
    formats: ["pes", "dst"],
    field: { width: 240, height: 360 },
    frames: [
      { ...F.bM, name: "10 × 10 cm (EF74S)" },
      { ...F.bL, name: "13 × 18 cm (EF75S)" },
      { ...F.bXL, name: "20 × 30 cm (EF92)" },
      { id: "xxl", name: "24 × 36 cm (EF95S)", width: 240, height: 360 },
    ],
    needles: 1,
    speed: { spm: 1050, source: "Stellaire XE2, dealer listings" },
    maxStitches: { value: 500000, source: BROTHER_MANUALS, documented: true },
    maxColorChanges: COLOR_CHANGES,
    fileNames: "brother",
    notes: BROTHER_NOTE,
  },
  {
    id: "brother-xp",
    name: "Brother 27.2 × 40.8 cm",
    brand: "Brother",
    models: "Luminaire XP1 / XP2 / XP3",
    formats: ["pes", "dst"],
    field: { width: 272, height: 408 },
    frames: [{ ...F.bL, name: "13 × 18 cm" }, F.bXL, { id: "xxl", name: "27.2 × 40.8 cm (EF99)", width: 272, height: 408 }],
    needles: 1,
    speed: { spm: 1050, source: "Luminaire XP3, dealer listings" },
    maxStitches: { value: 750000, source: BROTHER_FAQ, documented: true },
    maxColorChanges: COLOR_CHANGES,
    fileNames: "brother",
    notes: BROTHER_NOTE,
  },
  // Brother PR — multi-needle, frames mounted landscape
  {
    id: "brother-pr6",
    name: "Brother PR 6-needle",
    brand: "Brother",
    models: "PR680W and other 6-needle PR machines (20 × 30 cm)",
    formats: ["pes", "dst"],
    field: { width: 300, height: 200 },
    frames: [F.prClampS, F.prS, F.prCompact, F.prCylinder, F.prM, F.prR100, F.prR130, F.prCap, F.prR160, F.prL, F.prSleeve, F.prQuilt, F.prBorder, F.prXL],
    needles: 6,
    speed: { spm: 1000, source: "Brother PR specification" },
    maxColorChanges: COLOR_CHANGES,
    fileNames: "brother",
  },
  {
    id: "brother-pr10",
    name: "Brother PR 10-needle",
    brand: "Brother",
    models: "PR1055X, PR1000e and other 10-needle PR machines (36 × 20 cm; 36 × 36 cm with the Jumbo frame)",
    formats: ["pes", "dst"],
    field: { width: 360, height: 360 },
    frames: [
      F.prClampS,
      F.prS,
      F.prCompact,
      F.prCylinder,
      F.prM,
      F.prR100,
      F.prR130,
      F.prCap,
      F.prR160,
      F.prL,
      F.prSleeve,
      F.prQuilt,
      F.prBorder,
      F.prXL,
      {
        id: "pr-xl360",
        name: "Extra large 36 × 20 cm",
        width: 360,
        height: 200,
      },
      {
        id: "pr-widecap",
        name: "Wide cap frame 36 × 6 cm",
        width: 360,
        height: 60,
        note: "wide cap driver",
      },
      {
        id: "pr-jumbo",
        name: "Jumbo frame 36 × 36 cm",
        width: 360,
        height: 360,
        note: "needs the wide table",
      },
    ],
    needles: 10,
    speed: { spm: 1000, source: "Brother PR1055X specification" },
    maxColorChanges: COLOR_CHANGES,
    fileNames: "brother",
  },
  // Baby Lock (made by Brother, reads PES): fields and speeds from the spec
  // pages on babylock.com (inches there; mm = the matching Brother frame).
  babyLock("babylock-100x100", "Baby Lock 4 × 4″", "Aurora, Verve", 100, 100, 1, 400, [BL.f4x4]),
  babyLock("babylock-160x260", "Baby Lock 6.25 × 10.25″", "Flare, Vesta", 160, 260, 1, 850, [BL.f4x4, BL.f5x7, BL.f6x10]),
  babyLock("babylock-200x200", "Baby Lock Alliance 8 × 8″", "Alliance (embroidery only)", 200, 200, 1, 1000, [BL.f4x4, BL.f5x7, { id: "8x8", name: "8 × 8″", width: 200, height: 200 }]),
  babyLock("babylock-180x300", "Baby Lock 7 × 12″", "Journey, Unity, Spirit", 180, 300, 1, 1050, [BL.f4x4, BL.f5x7, { id: "7x12", name: "7 × 12″", width: 180, height: 300 }]),
  babyLock("babylock-200x300", "Baby Lock 8 × 12″", "Pathfinder, Aerial (Capella: 1000 spm)", 200, 300, 1, 1050, [BL.f4x4, BL.f5x7, BL.f8x12]),
  babyLock("babylock-240x360", "Baby Lock 9.5 × 14″", "Destiny II, Meridian 2, Reflection, Altair 2", 240, 360, 1, 1050, [
    BL.f4x4,
    BL.f5x7,
    BL.f8x12,
    { id: "9.5x14", name: "9.5 × 14″", width: 240, height: 360 },
  ]),
  babyLock("babylock-solaris", "Baby Lock Solaris", "Solaris Vision, Solaris 2", 272, 408, 1, 1050, [BL.f5x7, BL.f8x12, { id: "10.6x16", name: "10.6 × 16″", width: 272, height: 408 }]),
  babyLock("babylock-array", "Baby Lock Array (6 needles)", "Array, 7⅞ × 11¾″", 300, 200, 6, 1000, []),
  babyLock("babylock-valiant", "Baby Lock Valiant / Venture (10 needles)", "Valiant, Venture, 7⅞ × 14″", 360, 200, 10, 1000, []),
  // Janome / Elna
  {
    id: "janome-14x20",
    name: "Janome 14 × 20 cm",
    brand: "Janome",
    models: "Memory Craft 400E / 500E (SQ14 / SQ20 frames)",
    formats: ["jef", "dst"],
    field: { width: 140, height: 200 },
    frames: [F.jSQ14, { id: "rc", name: "RE20 14 × 20 cm", width: 140, height: 200 }],
    needles: 1,
    speed: {
      spm: 860,
      source: "Janome specification (400–860 spm embroidery)",
    },
  },
  {
    id: "janome-20x28",
    name: "Janome 20 × 28 cm",
    brand: "Janome",
    models: "Memory Craft 500E, 9850",
    formats: ["jef", "dst"],
    field: { width: 200, height: 280 },
    frames: [F.jSQ14, F.jSQ20, F.jRE28],
    needles: 1,
    speed: {
      spm: 860,
      source: "Janome specification (400–860 spm embroidery)",
    },
  },
  {
    id: "janome-20x36",
    name: "Janome 20 × 36 cm",
    brand: "Janome",
    models: "Memory Craft 550E",
    formats: ["jef", "dst"],
    field: { width: 200, height: 360 },
    frames: [F.jSQ14, F.jSQ20, F.jRE28, { id: "re36", name: "RE36 20 × 36 cm", width: 200, height: 360 }],
    needles: 1,
    speed: {
      spm: 860,
      source: "Janome specification (400–860 spm embroidery)",
    },
  },
  {
    id: "janome-m17",
    name: "Janome 28 × 46 cm",
    brand: "Janome",
    models: "Continental M17",
    formats: ["jef", "dst"],
    field: { width: 280, height: 460 },
    frames: [F.jSQ14, F.jSQ20, F.jRE28, { id: "re46", name: "RE46 28 × 46 cm", width: 280, height: 460 }],
    needles: 1,
    speed: {
      spm: 860,
      source: "Janome specification (400–860 spm embroidery)",
    },
  },
  {
    id: "janome-mb7",
    name: "Janome MB-7 (7 needles)",
    brand: "Janome",
    models: "MB-7 multi-needle, 24 × 20 cm",
    formats: ["jef", "dst"],
    field: { width: 240, height: 200 },
    frames: [],
    needles: 7,
    speed: { spm: 800, source: "MB-7 specification" },
  },
  // Bernina (.EXP, also .DST)
  {
    id: "bernina-7",
    name: "Bernina 7 series",
    brand: "Bernina",
    models: "B 735 / B 770 QE / B 790 PRO",
    formats: ["exp", "dst"],
    field: { width: 210, height: 400 },
    frames: [F.beS, F.beM, F.beL, F.beMidi, F.beMaxi],
    needles: 1,
    speed: { spm: 1000, source: "B 790 PRO specification (embroidery)" },
  },
  {
    id: "bernina-8",
    name: "Bernina 8 series",
    brand: "Bernina",
    models: "B 880 PLUS (Jumbo hoop)",
    formats: ["exp", "dst"],
    field: { width: 260, height: 400 },
    frames: [F.beS, F.beM, F.beL, F.beMidi, F.beMaxi, { id: "jumbo", name: "Jumbo 260 × 400 mm", width: 260, height: 400 }],
    needles: 1,
  },
  {
    id: "bernina-e16",
    name: "Bernina E 16 PRO (16 needles)",
    brand: "Bernina",
    models: "E 16 PRO multi-needle, 43 × 50 cm",
    formats: ["dst", "exp"],
    field: { width: 430, height: 500 },
    frames: [],
    needles: 16,
    speed: { spm: 1400, source: "E 16 PRO specification" },
  },
  // Pfaff / Husqvarna Viking (.VP3): hoops are named long side first, mounted portrait
  {
    id: "vp3-generic",
    name: "Pfaff / Viking 20 × 36 cm",
    brand: "Pfaff / Viking",
    models: "Pfaff creative 4.5 / Viking Designer Ruby and other VP3 machines",
    formats: ["vp3", "dst"],
    field: { width: 200, height: 360 },
    frames: [
      { id: "120", name: "120 × 115 mm", width: 120, height: 115 },
      { id: "240", name: "240 × 150 mm", width: 150, height: 240 },
      { id: "360", name: "360 × 200 mm", width: 200, height: 360 },
    ],
    needles: 1,
  },
  {
    id: "pfaff-icon",
    name: "Pfaff / Viking 36 × 35 cm",
    brand: "Pfaff / Viking",
    models: "Pfaff creative icon 2, Viking Designer Epic 3",
    formats: ["vp3", "dst"],
    field: { width: 350, height: 360 },
    frames: [
      { id: "120", name: "120 × 120 mm", width: 120, height: 120 },
      { id: "260", name: "260 × 200 mm", width: 200, height: 260 },
      { id: "360", name: "360 × 200 mm", width: 200, height: 360 },
      { id: "360x350", name: "360 × 350 mm", width: 350, height: 360 },
    ],
    needles: 1,
    speed: {
      spm: 1050,
      source: "creative icon 2 / Designer Epic 3, dealer listings",
    },
  },
  // Singer (.XXX)
  {
    id: "singer-15x26",
    name: "Singer 15 × 26 cm",
    brand: "Singer",
    models: "Legacy SE300 / SE340, SE9180",
    formats: ["xxx", "dst"],
    field: { width: 150, height: 260 },
    frames: [
      { id: "100", name: "100 × 100 mm", width: 100, height: 100 },
      { id: "260", name: "150 × 260 mm", width: 150, height: 260 },
    ],
    needles: 1,
  },
  // commercial multi-needle (.DST)
  {
    id: "commercial-15",
    name: "Commercial 15-needle",
    brand: "Commercial",
    models: "Tajima TMEZ, Ricoma MT-1501 and similar (36 × 50 cm)",
    formats: ["dst", "exp"],
    field: { width: 360, height: 500 },
    frames: [],
    needles: 15,
    speed: { spm: 1200, source: "Tajima TMEZ-SC specification" },
  },
];

/** Profile groups in menu order ("" = Design hoop). */
export const MACHINE_BRANDS: string[] = [...new Set(MACHINES.map((m) => m.brand))];

// ---- settings presets -----------------------------------------------------

export type MachineValues = Omit<MachineSettings, "profile">;

export interface SettingsPreset {
  id: string;
  name: string;
  group: string;
  hint: string;
  values: MachineValues;
}

/** Filum's own defaults (a new design starts with these). */
export const FILUM_DEFAULTS: MachineValues = {
  trimDistance: 3,
  ties: true,
  minStitch: 0.3,
  maxStitch: 12.1,
  spm: 800,
  trimSeconds: 6,
  colorChangeSeconds: 12,
};

/**
 * Ink/Stitch: minimum jump stitch length 3 mm and minimum stitch length
 * 0.1 mm (lib/utils/settings.py), lock stitches on, 12.1 mm the longest DST
 * stitch pystitch writes, and the print preview's estimate defaults
 * (700 spm, 10 s per trim and colour change).
 */
export const INKSTITCH_DEFAULTS: MachineValues = {
  trimDistance: 3,
  ties: true,
  minStitch: 0.1,
  maxStitch: 12.1,
  spm: 700,
  trimSeconds: 10,
  colorChangeSeconds: 10,
};

/** Typical speed of a single-needle machine whose rated speed is unknown. */
const TYPICAL_SPM = 800;

/**
 * Settings for a machine: its rated speed; a one-needle machine needs you to
 * rethread at every colour change (~40 s) and trims in ~6 s, a multi-needle
 * one changes colour (~4 s) and trims (~3 s) by itself. 0.3 mm shortest
 * stitch (Ink/Stitch's advice for machines that choke on tiny stitches),
 * 12.1 mm longest (what DST holds — every format reads it).
 */
export function profileValues(m: MachineProfile): MachineValues {
  const multi = (m.needles ?? 1) > 1;
  return {
    trimDistance: 3,
    ties: true,
    minStitch: 0.3,
    maxStitch: 12.1,
    spm: m.speed?.spm ?? TYPICAL_SPM,
    trimSeconds: multi ? 3 : 6,
    colorChangeSeconds: multi ? 4 : 40,
  };
}

export const SETTINGS_PRESETS: SettingsPreset[] = [
  {
    id: "filum",
    name: "Filum default",
    group: "General",
    hint: "Balanced settings for any machine — what a new design starts with.",
    values: FILUM_DEFAULTS,
  },
  {
    id: "inkstitch",
    name: "Ink/Stitch",
    group: "General",
    hint: "Ink/Stitch's defaults: 0.1 mm shortest stitch, 3 mm jumps, 700 spm and 10 s per trim / colour change.",
    values: INKSTITCH_DEFAULTS,
  },
  ...MACHINES.filter((m) => m.id !== "doc").map((m) => ({
    id: m.id,
    name: m.name,
    group: m.brand,
    hint: m.models,
    values: profileValues(m),
  })),
];

export const presetById = (id?: string) => SETTINGS_PRESETS.find((p) => p.id === id);

const KEYS = Object.keys(FILUM_DEFAULTS) as (keyof MachineValues)[];
export const sameValues = (a: MachineValues, b: MachineValues) => KEYS.every((k) => a[k] === b[k]);

/** The preset the design's settings come from (by id, else by equal values) and whether they were changed since. */
export function currentPreset(m: MachineSettings): {
  preset?: SettingsPreset;
  modified: boolean;
} {
  const byId = presetById(m.profile);
  if (byId) return { preset: byId, modified: !sameValues(m, byId.values) };
  const byValues = SETTINGS_PRESETS.find((p) => p.group === "General" && sameValues(m, p.values));
  return { preset: byValues, modified: false };
}

export const machineById = (id: string) => MACHINES.find((m) => m.id === id) ?? MACHINES[0];

/** Brother: file names with letters, digits, "-" and "_" only (others are hidden on the machine). */
export function cleanFileName(name: string, rule?: "brother"): string {
  const base = name.trim() || "design";
  if (rule !== "brother") return base.replace(/[\\/:*?"<>|]+/g, "_");
  const ascii = base.normalize("NFKD").replace(/[̀-ͯ]/g, "");
  const clean = ascii
    .replace(/\s+/g, "_")
    .replace(/[^A-Za-z0-9_-]+/g, "")
    .replace(/_+/g, "_")
    .replace(/^[_-]+|[_-]+$/g, "");
  return clean || "design";
}

export type CheckLevel = "ok" | "warn" | "error";
export interface ExportCheck {
  id: string;
  level: CheckLevel;
  title: string;
  detail: string;
}

const fmtMm = (w: number, h: number) => `${w.toFixed(1)} × ${h.toFixed(1)} mm`;

/** Everything that would make the machine reject or misplace the export. */
/** How far the design reaches into a w × h ellipse it is centred in (≤ 1 = inside). */
export type OvalReach = (w: number, h: number) => number;

interface Area {
  name: string;
  width: number;
  height: number;
  shape?: string;
}

/** Does a w × h design fit the area (oval areas: by its stitches, else its corners)? */
export function areaFits(a: Area, w: number, h: number, reach?: OvalReach): boolean {
  if (w > a.width + 1e-6 || h > a.height + 1e-6) return false;
  if (a.shape !== "oval") return true;
  return reach ? reach(a.width, a.height) <= 1.001 : (w / a.width) ** 2 + (h / a.height) ** 2 <= 1.001;
}

/**
 * The frame to suggest: the smallest everyday rectangular frame that fits,
 * then a round one, then a special frame that fits (Jumbo, wide cap …),
 * else the largest everyday frame.
 */
export function pickFrame(m: MachineProfile, size?: { width: number; height: number } | null, reach?: OvalReach): Frame | undefined {
  const everyday = m.frames.filter((f) => !f.note);
  const fits = (f: Frame) => !!size && areaFits(f, size.width, size.height, reach);
  return everyday.find((f) => f.shape !== "oval" && fits(f)) ?? everyday.find(fits) ?? m.frames.find(fits) ?? everyday.filter((f) => f.shape !== "oval").at(-1) ?? m.frames.at(-1);
}

// The hoop code a JEF file carries (pystitch get_jef_hoop_size, also our
// writer): the Janome machine asks for this hoop. Designs over 200 × 200 mm
// get the 110 × 110 code.
const JEF_HOOPS = [
  { max: [50, 50], name: "C 50 × 50 mm", frames: ["C "] },
  { max: [126, 110], name: "A 126 × 110 mm", frames: ["A "] },
  { max: [140, 200], name: "B / RE20 140 × 200 mm", frames: ["B ", "RE20 "] },
  { max: [200, 200], name: "SQ20 200 × 200 mm", frames: ["SQ20 "] },
];

/** The hoop named in a JEF for a w × h mm design; `frames`: Janome frame names that are that hoop. */
export function jefHoop(w: number, h: number): { name: string; frames: string[]; fallback: boolean } {
  const [W, H] = [Math.round(w * 10), Math.round(h * 10)];
  for (const j of JEF_HOOPS) if (W < j.max[0] * 10 && H < j.max[1] * 10) return { ...j, fallback: false };
  return { name: "110 × 110 mm", frames: [], fallback: true };
}

export function exportChecks(opts: {
  machine: MachineProfile;
  frame: Frame | null;
  format: string;
  stats: PlanStats | null | undefined;
  hoop: { name: string; width: number; height: number; shape?: string };
  outsideHoop: boolean;
  /** Oval frames / hoops: the design's reach (from its stitches). */
  reach?: OvalReach;
  machineFormat: boolean;
  distinctColours: number;
}): ExportCheck[] {
  const { machine, frame, format, stats, hoop } = opts;
  const out: ExportCheck[] = [];
  if (!opts.machineFormat) return out;
  if (!stats?.stitches) {
    out.push({
      id: "empty",
      level: "error",
      title: "No stitches",
      detail: "The design has nothing to stitch yet.",
    });
    return out;
  }
  const [w, h] = [stats.width, stats.height];
  // frame / field
  const area: Area =
    frame ??
    (machine.id === "doc"
      ? {
          name: hoop.name + " hoop",
          width: hoop.width,
          height: hoop.height,
          shape: hoop.shape,
        }
      : {
          name: "embroidery field",
          width: machine.field.width,
          height: machine.field.height,
        });
  const oval = area.shape === "oval";
  const fits = areaFits(area, w, h, opts.reach);
  const fitsRotated = areaFits(area, h, w, opts.reach && ((W, H) => opts.reach!(H, W)));
  const where = oval ? `the ${Math.abs(area.width - area.height) < 0.01 ? "round" : "oval"} ${fmtMm(area.width, area.height)}` : fmtMm(area.width, area.height);
  if (fits)
    out.push({
      id: "size",
      level: "ok",
      title: "Fits the " + area.name,
      detail: `${fmtMm(w, h)} in ${where} · the machine centres it in the frame`,
    });
  else if (fitsRotated)
    out.push({
      id: "size",
      level: "warn",
      title: "Fits only turned by 90°",
      detail: `${fmtMm(w, h)} — rotate the design (or on the machine) for the ${area.name}`,
    });
  else if (oval && w <= area.width + 1e-6 && h <= area.height + 1e-6)
    out.push({
      id: "size",
      level: "error",
      title: "Outside the " + area.name,
      detail: `${fmtMm(w, h)} fits the box but reaches past the edge of ${where}`,
    });
  else
    out.push({
      id: "size",
      level: "error",
      title: "Larger than the " + area.name,
      detail: `${fmtMm(w, h)} in ${fmtMm(area.width, area.height)} — the machine rejects or ignores it`,
    });
  if (frame?.note)
    out.push({
      id: "frame",
      level: "ok",
      title: `Special frame: ${frame.note}`,
      detail: `${frame.name} — hoop the item as the manual shows`,
    });
  if (format === "jef") {
    const j = jefHoop(w, h);
    if (j.fallback)
      out.push({
        id: "jef",
        level: "warn",
        title: "The JEF names the 110 × 110 mm hoop",
        detail: "Ink/Stitch's writer gives designs over 200 × 200 mm that code — choose the larger hoop on the machine",
      });
    else {
      const differs = machine.brand === "Janome" && !!frame && !j.frames.some((f) => frame.name.startsWith(f));
      out.push({
        id: "jef",
        level: "ok",
        title: `The machine asks for the ${j.name} hoop`,
        detail: differs ? `The JEF names the smallest Janome hoop that fits; to use the ${frame!.name}, choose it on the machine` : "The hoop code in the JEF file (as Ink/Stitch writes it)",
      });
    }
  }
  if (frame && machine.field.width && (w > machine.field.width || h > machine.field.height))
    out.push({
      id: "field",
      level: "error",
      title: "Larger than the machine's field",
      detail: `${fmtMm(machine.field.width, machine.field.height)} at most`,
    });
  if (opts.outsideHoop)
    out.push({
      id: "hoop",
      level: "warn",
      title: "Outside the design hoop",
      detail: `Parts of the design are outside the ${hoop.name} hoop in the editor (the export is centred anyway)`,
    });
  // limits
  const lim = (id: string, label: string, value: number, l?: Limit) => {
    if (!l) return;
    if (value > l.value)
      out.push({
        id,
        level: l.documented ? "error" : "warn",
        title: `${value.toLocaleString()} ${label} (limit ${l.value.toLocaleString()})`,
        detail: `${l.documented ? "Documented" : "Reported"}: ${l.source}`,
      });
    else
      out.push({
        id,
        level: "ok",
        title: `${value.toLocaleString()} ${label}`,
        detail: `Limit ${l.value.toLocaleString()} (${l.documented ? "documented" : "reported"})`,
      });
  };
  lim("stitches", "stitches", stats.stitches, machine.maxStitches);
  lim("colours", "colour changes", stats.colorChanges, machine.maxColorChanges);
  // format
  if (machine.id !== "doc" && !machine.formats.includes(format))
    out.push({
      id: "format",
      level: "warn",
      title: `${machine.brand} machines read ${machine.formats.map((f) => "." + f.toUpperCase()).join(" / ")}`,
      detail: `.${format.toUpperCase()} may not be recognised`,
    });
  if (format === "pes" && opts.distinctColours > 61)
    out.push({
      id: "table",
      level: "warn",
      title: `${opts.distinctColours} different threads`,
      detail: "Brother's thread table has 61 colours: some threads are shown with the same colour on the machine",
    });
  if (["dst", "exp", "u01", "gcode"].includes(format))
    out.push({
      id: "nocolours",
      level: "warn",
      title: "No colours in the file",
      detail: "The machine stops at every change; load the threads in the order listed below",
    });
  return out;
}
