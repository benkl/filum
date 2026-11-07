// Thread logic without app state (lib/threads.ts has the store-level
// operations): the My threads palette file, ids of installed charts, editing a
// spool's colour, merging similar colours and the sew order of threads.

import type { DesignObject } from "../types";
import { deltaE, hexToRgb, lab, rgbToHex } from "./colorMath";
import { threadsOf } from "./copies";

/** Identity of a spool: brand, code and colour. */
export const ownedKey = (t: { brand?: string; code?: string; color: string }) => `${(t.brand ?? "").toLowerCase()}|${(t.code ?? "").toLowerCase()}|${t.color.toLowerCase()}`;

// ---------------------------------------------------------------------------
// My threads as a GIMP palette

interface Spool {
  name: string;
  code: string;
  brand: string;
  color: string;
}

/**
 * Before each entry: its exact name, code and brand, tab-separated (read by
 * the engine's parse_gpl, crates/core/src/threads.rs). The collection mixes
 * brands, and the entry line alone ("name code", as Ink/Stitch writes it)
 * can't tell a name ending in a number from a code; GIMP and Ink/Stitch skip
 * it as a comment.
 */
export const FILUM_ENTRY = "# Filum:";

const field = (s: string | undefined) => (s ?? "").replace(/[\t\r\n]+/g, " ").trim();
const pad = (n: number) => String(n).padStart(3);

/** The My threads collection as a .gpl file that reads back as it was. */
export function myThreadsGpl(list: Spool[]): string {
  const lines = ["GIMP Palette", "Name: My threads", "Columns: 4", "# RGB Value\tColor Name Number"];
  for (const t of list) {
    const [r, g, b] = hexToRgb(t.color);
    const [name, code, brand] = [field(t.name), field(t.code), field(t.brand)];
    lines.push(`${FILUM_ENTRY}\t${name}\t${code}\t${brand}`);
    // the entry as Ink/Stitch writes its charts: rgb, then "name code"
    lines.push(`${pad(r)}\t${pad(g)}\t${pad(b)}\t${[name, code].filter(Boolean).join(" ")}`);
  }
  return lines.join("\n") + "\n";
}

/** A palette as the engine parses it (parsePalette). */
export interface ParsedPalette {
  name: string;
  entries: { name: string; code: string; rgb: [number, number, number] }[];
  /** Per entry: the brand a Filum export names (null: none — the palette's name is the brand). */
  brands?: (string | null)[];
}

/** The brand a palette file stands for: its name without the collection prefix. */
export const paletteBrand = (name: string) =>
  name
    .replace(/^(Ink\/Stitch|InkStitch|Embroidery Nerds|Filum):\s*/, "")
    .replace(/\.gpl$/i, "")
    .trim();

/** The spools of a palette file for My threads. */
export function spoolsOfPalette(pal: ParsedPalette, fileName: string): Spool[] {
  const named = paletteBrand(pal.name || fileName);
  const fallback = named === "My threads" ? "" : named;
  return pal.entries.map((e, i) => {
    const color = rgbToHex(e.rgb);
    const brand = pal.brands?.[i];
    // a Filum entry is taken as written (a spool may have only a code)
    if (brand != null) return { name: e.name, code: e.code, brand, color };
    return { name: e.name || color.toUpperCase(), code: e.code, brand: fallback, color };
  });
}

// ---------------------------------------------------------------------------
// Installed charts

/** FNV-1a of a string, base 36. */
function hashOf(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/**
 * The id of an installed chart named `name`: the id it already has (installed
 * again: replaced), else from its name — made unique when the name gives none
 * (e.g. Cyrillic or Japanese only) or another chart has it.
 */
export function chartIdFor(name: string, installed: { id: string; name: string }[]): string {
  const same = installed.find((c) => c.name === name);
  if (same) return same.id;
  const taken = new Set(installed.map((c) => c.id));
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const base = `custom/${slug || "palette"}`;
  if (slug && !taken.has(base)) return base;
  const hashed = `${base}-${hashOf(name)}`;
  let id = hashed;
  for (let n = 2; taken.has(id); n++) id = `${hashed}-${n}`;
  return id;
}

// ---------------------------------------------------------------------------
// Editing a thread's colour

/** How far (CIEDE2000) a colour may move from its spool's and still be that spool. */
export const SPOOL_DELTA = 1;

/**
 * A thread's colour changed to `color`: the brand and code name a catalogue
 * spool, so they stay only while the colour is within ΔE 1 of that spool's
 * (`spool`: the chart colour, else the colour before the edit). `orig` is the
 * thread before the edit, so moving back restores them.
 */
export function colourEdit(orig: { color: string; brand: string; code: string }, color: string, spool = orig.color): { color: string; brand?: string; code?: string } {
  if (!orig.brand && !orig.code) return { color };
  const keep = deltaE(lab(spool), lab(color)) <= SPOOL_DELTA;
  return { color, brand: keep ? orig.brand : "", code: keep ? orig.code : "" };
}

// ---------------------------------------------------------------------------
// Merging similar colours

/**
 * Threads to put on a closer thread's spool (closer than `threshold` ΔE): the
 * most used thread of each cluster is kept. Locked threads keep their spool
 * (they can be kept, never merged), and threads already on their keeper's
 * spool are not merges. Returns thread id → keeper id.
 */
export function similarMerges(threads: (Spool & { id: string })[], uses: (id: string) => number, locked: ReadonlySet<string>, threshold: number): Map<string, string> {
  const order = [...threads].sort((a, b) => uses(b.id) - uses(a.id));
  const labs = new Map(order.map((t) => [t.id, lab(t.color)]));
  const taken = new Set<string>();
  const out = new Map<string, string>();
  for (const keep of order) {
    if (taken.has(keep.id)) continue;
    taken.add(keep.id);
    for (const t of order) {
      if (taken.has(t.id) || locked.has(t.id) || deltaE(labs.get(keep.id)!, labs.get(t.id)!) >= threshold) continue;
      taken.add(t.id);
      if (ownedKey(t) !== ownedKey(keep)) out.set(t.id, keep.id);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Sew order

/** Threads in the order objects first use them — a lettering's own threads (main, border, font colours) with its letters — unused ones last. */
export function bySewOrder<T extends { id: string }>(threads: T[], objects: DesignObject[]): T[] {
  // an object's own thread first, then its lettering's (main, border, font colours in order)
  const first = new Map<string, number>();
  let k = 0;
  for (const o of objects) for (const id of threadsOf(o)) if (!first.has(id)) first.set(id, k++);
  return [...threads].sort((a, b) => (first.get(a.id) ?? Infinity) - (first.get(b.id) ?? Infinity) || 0);
}
