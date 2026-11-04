// Font registry for lettering.
//
//  • Embroidery fonts: the Ink/Stitch embroidery-fonts collection is bundled
//    (see scripts/bundle-fonts.mjs). Every glyph is pre-digitized (satin
//    columns with rungs and underlay, running stitch, fills). Fonts whose
//    licence doesn't allow bundling are listed too (`download` in the index)
//    and load from the optional downloads once the user has fetched them.
//  • Outline fonts (TTF/OTF): bundled, imported (kept in IndexedDB) or the
//    system's fonts via the Local Font Access API. Stitched as fill, satin
//    border or outline.

import opentype from "opentype.js";
import { buildFont, fontMetrics, variantId, VARIANTS, type PackedFont } from "./inkFontPack.mjs";
import { engine } from "../engine/client";
import { installedItems, onDownloadsChange, storedFont } from "./downloadStore";
import { flatten, unionBoxes } from "./geometry";
import { fontNameFromFiles, letterOfFile, wrapGlyphLayer } from "./letteringTools";
import type { DesignObject, StitchDocument, Vec2 } from "../types";

export type FontKind = "embroidery" | "outline";

export interface FontEntry {
  key: string; // stable id stored in documents
  name: string;
  kind: FontKind;
  source: "bundled" | "imported" | "system" | "download";
  /** Optional download (Preferences ▸ Downloads): the pack it comes in, and whether it is installed. */
  download?: string;
  installed?: boolean;
  description?: string;
  preview?: string; // image url
  keywords?: string[];
  license?: string;
  /** Embroidery fonts: size in mm at 100 % and the recommended scale range. */
  size?: number;
  minScale?: number;
  maxScale?: number;
  glyphs?: number;
  direction?: string;
  original?: string;
  url?: string;
}

const BASE = "/embroidery-fonts";
const PX = 25.4 / 96;

/** Row of embroidery-fonts/index.json (written by scripts/bundle-fonts.mjs). */
export interface IndexRow {
  id: string;
  name: string;
  description: string;
  keywords: string[];
  license: string;
  original: string;
  url: string;
  size: number;
  minScale: number;
  maxScale: number;
  glyphs: number;
  direction: string;
  preview: boolean;
  hasLicenseFile: boolean;
  /** Not bundled: comes in this download pack (public/downloads/<pack>.json). */
  download?: string;
}
export interface EmbroideryIndex {
  source: string;
  commit: string;
  fonts: IndexRow[];
}

let indexP: Promise<EmbroideryIndex> | null = null;
export function embroideryIndex(): Promise<EmbroideryIndex> {
  if (!indexP) {
    indexP = fetch(`${BASE}/index.json`)
      .then((r) => r.json() as Promise<EmbroideryIndex>)
      .then((ix) => {
        for (const f of ix.fonts) fontNames.set(`emb:${f.id}`, f.name);
        return ix;
      });
    indexP.catch(() => (indexP = null));
  }
  return indexP;
}

/** Object URLs of the previews of downloaded fonts. */
const previewUrls = new Map<string, string>();
onDownloadsChange(() => {
  for (const u of previewUrls.values()) URL.revokeObjectURL(u);
  previewUrls.clear();
  for (const k of [...loaded.keys()]) if (k.startsWith("emb:")) loaded.delete(k);
});

/** The embroidery font collection: bundled fonts, and the optional downloads (installed or not). */
export async function embroideryFonts(): Promise<FontEntry[]> {
  const ix = await embroideryIndex();
  const have = ix.fonts.some((f) => f.download) ? await installedItems() : new Set<string>();
  return Promise.all(
    ix.fonts.map(async (f) => {
      const installed = f.download ? have.has(f.id) : undefined;
      let preview = f.preview ? `${BASE}/${f.id}/preview.png` : undefined;
      if (f.download && installed) {
        let u = previewUrls.get(f.id);
        const png = u ? null : (await storedFont(f.id))?.preview;
        if (png) previewUrls.set(f.id, (u = URL.createObjectURL(png)));
        preview = u;
      }
      return {
        key: `emb:${f.id}`,
        name: f.name,
        kind: "embroidery" as const,
        source: f.download ? ("download" as const) : ("bundled" as const),
        ...(f.download ? { download: f.download, installed } : {}),
        description: f.description,
        preview,
        keywords: f.keywords,
        license: f.license,
        size: f.size,
        minScale: f.minScale,
        maxScale: f.maxScale,
        glyphs: f.glyphs,
        direction: f.direction,
        original: f.original,
        url: f.url,
      };
    }),
  );
}

/** Licence text shipped with an embroidery font (downloaded fonts: once downloaded). */
export async function embroideryLicense(id: string): Promise<string> {
  const row = (await embroideryIndex()).fonts.find((f) => f.id === id);
  if (row?.download) return (await storedFont(id))?.license ?? "";
  const r = await fetch(`${BASE}/${id}/LICENSE`);
  return r.ok ? r.text() : "";
}

export const BUNDLED_OUTLINE: FontEntry[] = [
  { key: "ttf:/fonts/Nunito-Variable.ttf", name: "Nunito", kind: "outline", source: "bundled", description: "Rounded sans", license: "SIL Open Font License 1.1" },
  { key: "ttf:/fonts/BebasNeue-Regular.ttf", name: "Bebas Neue", kind: "outline", source: "bundled", description: "Block capitals", license: "SIL Open Font License 1.1" },
  { key: "ttf:/fonts/Pacifico-Regular.ttf", name: "Pacifico", kind: "outline", source: "bundled", description: "Script", license: "SIL Open Font License 1.1" },
];

export const DEFAULT_FONT = "emb:amitaclo";

/** Display names of known fonts (filled in as the index and fonts load). */
const fontNames = new Map<string, string>(BUNDLED_OUTLINE.map((f) => [f.key, f.name]));
export const fontLabel = (key: string) =>
  fontNames.get(key) ??
  (key.startsWith("emb:")
    ? key.slice(4).replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
    : key.replace(/^(file|local|ttf):/, "").replace(/\.(ttf|otf)$/i, "").replace(/^.*\//, ""));

/** Fetch JSON that may be gzipped (a server may or may not have decoded it already). */
async function fetchJsonGz<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  const buf = new Uint8Array(await r.arrayBuffer());
  if (buf[0] === 0x1f && buf[1] === 0x8b) {
    const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"));
    return JSON.parse(await new Response(stream).text()) as T;
  }
  return JSON.parse(new TextDecoder().decode(buf)) as T;
}

// ---------------------------------------------------------------------------
// IndexedDB storage for imported fonts

const DB = "filum-fonts";
function idb(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 2);
    r.onupgradeneeded = () => {
      if (!r.result.objectStoreNames.contains("fonts")) r.result.createObjectStore("fonts");
      // imported Ink/Stitch embroidery fonts: { font, data } by id
      if (!r.result.objectStoreNames.contains("inkfonts")) r.result.createObjectStore("inkfonts");
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function idbAll(): Promise<{ name: string; bytes: ArrayBuffer }[]> {
  const db = await idb();
  return new Promise((res) => {
    const out: { name: string; bytes: ArrayBuffer }[] = [];
    const cur = db.transaction("fonts").objectStore("fonts").openCursor();
    cur.onsuccess = () => {
      const c = cur.result;
      if (!c) return res(out);
      out.push({ name: String(c.key), bytes: c.value });
      c.continue();
    };
    cur.onerror = () => res(out);
  });
}

export async function importedFonts(): Promise<FontEntry[]> {
  try {
    const outline: FontEntry[] = (await idbAll()).map((f) => ({ key: `file:${f.name}`, name: f.name.replace(/\.(ttf|otf)$/i, ""), kind: "outline", source: "imported" }));
    const packs = await inkPacks();
    return [...outline, ...packs.map(([id, p]) => ({ key: `inkfont:${id}`, name: p.font.name, kind: "embroidery" as const, source: "imported" as const, description: typeof p.info?.description === "string" ? p.info.description : undefined, size: p.font.size, minScale: p.font.min_scale, maxScale: p.font.max_scale, glyphs: p.font.chunks.reduce((n, c) => n + c.glyphs.length, 0), direction: p.font.text_direction }))];
  } catch {
    return [];
  }
}

/** An installed Ink/Stitch font: the packed record, its glyph chunks and
 *  the font.json it came with (kept for editing and export). */
export type InkPack = { font: PackedFont; data: Record<string, Record<string, string>>; info?: Record<string, unknown> };

async function putPack(id: string, pack: InkPack) {
  const db = await idb();
  await new Promise<void>((res, rej) => {
    const t = db.transaction("inkfonts", "readwrite");
    t.objectStore("inkfonts").put(pack, id);
    t.oncomplete = () => res();
    t.onerror = () => rej(t.error);
  });
}

const packId = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") + "_" + Date.now().toString(36);

async function inkPacks(): Promise<[string, InkPack][]> {
  const db = await idb();
  return new Promise((res) => {
    const out: [string, InkPack][] = [];
    const cur = db.transaction("inkfonts").objectStore("inkfonts").openCursor();
    cur.onsuccess = () => {
      const c = cur.result;
      if (!c) return res(out);
      out.push([String(c.key), c.value as InkPack]);
      c.continue();
    };
    cur.onerror = () => res(out);
  });
}

/**
 * Pack an Ink/Stitch embroidery font folder (font.json + the Inkscape files of
 * its variants, e.g. "→.svg" or a "→" folder) like the bundled collection
 * (lib/inkFontPack.mjs). Used by Import Ink/Stitch font and by the optional
 * downloads (Preferences ▸ Downloads).
 */
export async function packInkFolder(files: { path: string; text: () => Promise<string> }[]): Promise<InkPack & { info: Record<string, unknown>; root: string }> {
  const meta = files.find((f) => /(^|[\\/])font\.json$/i.test(f.path));
  if (!meta) throw new Error("no font.json in the folder");
  const info = JSON.parse(await meta.text()) as Record<string, unknown>;
  const root = meta.path.replace(/font\.json$/i, "");
  const rel = (f: { path: string }) => f.path.slice(root.length);
  const wanted = String(info.default_variant ?? "ltr");
  // every variant's files: "ltr.svg" / "→.svg" next to font.json, or every SVG in a "ltr" / "→" folder
  const texts: Record<string, string[]> = {};
  for (const v of VARIANTS) {
    const pick = files.filter((f) => v.some((n) => rel(f) === `${n}.svg` || (rel(f).startsWith(`${n}/`) && rel(f).endsWith(".svg")))).sort((a, b) => a.path.localeCompare(b.path));
    if (pick.length) texts[v[0]] = await Promise.all(pick.map((f) => f.text()));
  }
  // the default variant, else any variant with glyphs (like Ink/Stitch)
  const order = [variantId(wanted), ...VARIANTS.map((v) => v[0])];
  for (const v of order) {
    if (!texts[v]) continue;
    const pack = buildFont(info, texts[v], v, texts);
    if (pack.font.chunks.length) return { ...pack, info, root };
  }
  throw new Error("no glyph files (ltr.svg, →.svg or such a folder) next to font.json");
}

/** Import an Ink/Stitch embroidery font folder: packed and stored; returns its font key. */
export async function importInkFont(files: { path: string; text: () => Promise<string> }[]): Promise<string> {
  const { root, ...pack } = await packInkFolder(files);
  const id = packId(String(pack.info.name ?? root.split(/[\\/]/).filter(Boolean).pop() ?? "font"));
  await putPack(id, pack);
  return `inkfont:${id}`;
}

// ---------------------------------------------------------------------------
// Font info (Ink/Stitch's font.json) of installed fonts: edit, export, copy

/** font.json of a pack imported before the original was kept: from the record. */
function infoFromRecord(f: PackedFont): Record<string, unknown> {
  const { variant, colors: _c, chunks: _ch, variants: _v, ...metrics } = f;
  return { ...metrics, default_variant: variant };
}

/** The font.json of an installed (imported or copied) font, or null. */
export async function inkFontInfo(key: string): Promise<Record<string, unknown> | null> {
  if (!key.startsWith("inkfont:")) return null;
  const pack = (await inkPacks()).find(([id]) => id === key.slice(8))?.[1];
  if (!pack) return null;
  const names = [...new Set(pack.font.chunks.flatMap((c) => c.glyphs))];
  return { ...infoFromRecord(pack.font), ...(pack.info ?? {}), glyphs: names };
}

/**
 * Store edited font.json values of an installed font (Ink/Stitch's "Edit
 * JSON"): the metrics are applied to the font right away; letterings using
 * it pick them up when they are regenerated.
 */
export async function saveInkFontInfo(key: string, info: Record<string, unknown>): Promise<void> {
  const id = key.slice(8);
  const pack = (await inkPacks()).find(([k]) => k === id)?.[1];
  if (!pack) throw new Error("The font is not installed");
  const font: PackedFont = { ...pack.font, ...fontMetrics(info) };
  await putPack(id, { ...pack, font, info });
  loaded.delete(key);
  fontNames.set(key, font.name);
}

/** Remove an installed Ink/Stitch font. */
export async function removeInkFont(key: string): Promise<void> {
  const db = await idb();
  await new Promise<void>((res, rej) => {
    const t = db.transaction("inkfonts", "readwrite");
    t.objectStore("inkfonts").delete(key.slice(8));
    t.oncomplete = () => res();
    t.onerror = () => rej(t.error);
  });
  loaded.delete(key);
}

/**
 * An editable copy of a bundled embroidery font (all its variants), installed
 * like an imported font: kerning, spacing and metadata can then be changed.
 */
export async function copyBundledFont(key: string): Promise<string> {
  const id = key.slice(4);
  const meta = await fetchJsonGz<PackedFont>(`${BASE}/${id}/font.json.gz`);
  const row = (await embroideryIndex()).fonts.find((f) => f.id === id);
  const files = [...meta.chunks, ...Object.values(meta.variants ?? {}).flat()].map((c) => c.file);
  const data: Record<string, Record<string, string>> = {};
  await Promise.all(files.map(async (f) => (data[f] = await fetchJsonGz<Record<string, string>>(`${BASE}/${id}/${f}`))));
  const info: Record<string, unknown> = {
    ...infoFromRecord(meta),
    name: `${meta.name} (copy)`,
    ...(row ? { description: row.description, keywords: row.keywords, font_license: row.license, original_font: row.original, original_font_url: row.url } : {}),
  };
  const nid = packId(meta.name + " copy");
  await putPack(nid, { font: { ...meta, ...fontMetrics(info) }, data, info });
  return `inkfont:${nid}`;
}

/** Store an uploaded TTF/OTF; returns its font key. Throws if it isn't a usable font. */
export async function importFontFile(name: string, bytes: Uint8Array): Promise<string> {
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  opentype.parse(buf); // validate
  const db = await idb();
  await new Promise<void>((res, rej) => {
    const t = db.transaction("fonts", "readwrite");
    t.objectStore("fonts").put(buf, name);
    t.oncomplete = () => res();
    t.onerror = () => rej(t.error);
  });
  return `file:${name}`;
}

/**
 * Letters to font (Ink/Stitch's "Letters to font"): a folder of embroidery
 * files (or SVGs), one letter each, named so that the letter ends the name
 * ("Example_Font_A.pes"), becomes an installed embroidery font. Every letter
 * sits on the baseline with its lowest stitch, a small side bearing to the
 * left; spacing and kerning can be adjusted in the font editor afterwards.
 */
export async function lettersToFont(files: { path: string; bytes: () => Promise<Uint8Array>; text: () => Promise<string> }[]): Promise<{ key: string; letters: number }> {
  const picked = files
    .map((f) => ({ f, letter: letterOfFile(f.path), ext: f.path.split(".").pop()?.toLowerCase() ?? "" }))
    .filter((x) => x.letter && x.letter.trim())
    .sort((a, b) => a.f.path.localeCompare(b.f.path));
  const svgs: string[] = [];
  const baselines = new Map<string, number>();
  const heights = new Map<string, number>();
  for (const { f, letter, ext } of picked) {
    let doc: StitchDocument;
    try {
      doc = ext === "svg" ? (await engine.importSvg(await f.text())).document : await engine.importEmbroidery(await f.bytes(), f.path.split(/[\\/]/).pop() ?? f.path);
    } catch {
      continue; // not a design file
    }
    const b = pathBounds(doc.objects);
    if (!b || !doc.objects.length) continue;
    heights.set(letter!, b.h);
    // the design as Ink/Stitch SVG (mm user units), its left edge moved to x = 0
    svgs.push(wrapGlyphLayer(await engine.exportSvg(doc), letter!, -b.x));
    baselines.set(letter!, (b.y + b.h) / PX);
  }
  if (!svgs.length) throw new Error("no letter files (e.g. Font_A.pes, Font_B.pes …) in the folder");
  // size: the cap height of H, else of the tallest capital, else the tallest letter
  const caps = [...heights.entries()].filter(([g]) => /\p{Lu}/u.test(g)).map(([, h]) => h);
  const size = heights.get("H") ?? (caps.length ? Math.max(...caps) : Math.max(...heights.values()));
  const name = fontNameFromFiles(picked.map((x) => x.f.path));
  const info: Record<string, unknown> = {
    name,
    description: `Made from ${svgs.length} letter files`,
    size: Math.round(size * 10) / 10,
    min_scale: 1,
    max_scale: 1,
    leading: Math.round((size * 1.5) / PX),
    horiz_adv_x_space: Math.round((size * 0.35) / PX),
    // a side bearing on the left of every letter: the gap between letters
    horiz_adv_x_default: null,
    auto_satin: false,
  };
  const pack = buildFont(info, svgs, "ltr");
  const bearing = (size * 0.08) / PX;
  for (const c of pack.font.chunks) {
    const b = baselines.get(c.glyphs[0]);
    if (b !== undefined) c.baseline = b;
  }
  // every letter starts `bearing` from its origin: Ink/Stitch adds a glyph's min_x before it
  for (const glyphs of Object.values(pack.data))
    for (const g of Object.keys(glyphs)) glyphs[g] = `<g transform="translate(${Math.round(bearing * 1000) / 1000} 0)">${glyphs[g]}</g>`;
  const id = packId(name);
  await putPack(id, { ...pack, info: { ...info, glyphs: pack.font.chunks.flatMap((c) => c.glyphs) } });
  return { key: `inkfont:${id}`, letters: pack.font.chunks.length };
}

// ---------------------------------------------------------------------------
// System fonts (Local Font Access API, Chromium / WebView2)

interface LocalFontData {
  family: string;
  fullName: string;
  postscriptName: string;
  style: string;
  blob(): Promise<Blob>;
}
let localFonts: LocalFontData[] | null = null;

export const systemFontsSupported = () => typeof (window as unknown as { queryLocalFonts?: unknown }).queryLocalFonts === "function";

export async function systemFonts(): Promise<FontEntry[]> {
  const q = (window as unknown as { queryLocalFonts?: () => Promise<LocalFontData[]> }).queryLocalFonts;
  if (!q) return [];
  localFonts = await q();
  return localFonts
    .filter((f) => /regular|bold|book|normal|medium/i.test(f.style) || f.style === "")
    .map((f) => ({ key: `local:${f.postscriptName}`, name: f.fullName, kind: "outline" as const, source: "system" as const, description: f.family }));
}

// ---------------------------------------------------------------------------
// Loading

export interface EmbroideryGlyph {
  name: string;
  /** Index into the font's colour palette, per object. */
  colors: number[];
  objects: DesignObject[]; // glyph space, mm, baseline at y = 0, left edge at x = 0
  width: number; // mm
  /** Left edge in the font file (Ink/Stitch glyph.min_x), mm. */
  minX: number;
}

export interface EmbroideryFont {
  kind: "embroidery";
  key: string;
  name: string;
  size: number; // mm at 100 %
  minScale: number;
  maxScale: number;
  leading: number; // mm
  space: number; // mm
  advDefault: number | null; // mm
  adv: Record<string, number>; // mm, by glyph name
  kerning: Record<string, number>; // mm, "a b" or legacy "ab"
  letterCase: string;
  defaultGlyph: string;
  direction: "ltr" | "rtl";
  /** Thread colours used by the font, in order of first use. */
  colors: string[];
  /** Every glyph name of the font (default variant). */
  names: Set<string>;
  /** The default variant: "ltr", "rtl", "ttb" or "btt" — the direction its
   *  glyphs are stitched in (Ink/Stitch font variants). */
  variant: string;
  /** Every variant the font has, the default first. */
  variants: string[];
  /** Ink/Stitch "reversible": lines may be stitched back and forth. */
  reversible: boolean;
  /** Glyph names of a variant (the default variant's when it is missing). */
  namesOf(variant?: string): Set<string>;
  /** A glyph of the default variant, or of `variant` (falling back to the default, like Ink/Stitch). */
  glyph(name: string, variant?: string): Promise<EmbroideryGlyph | null>;
}

export interface OutlineFont {
  kind: "outline";
  key: string;
  font: opentype.Font;
}

export type LoadedFont = EmbroideryFont | OutlineFont;

const loaded = new Map<string, Promise<LoadedFont>>();

export function fontKind(key: string): FontKind {
  return key.startsWith("emb:") || key.startsWith("inkfont:") ? "embroidery" : "outline";
}

export function loadFont(key: string): Promise<LoadedFont> {
  let p = loaded.get(key);
  if (!p) {
    p = key.startsWith("emb:") || key.startsWith("inkfont:") ? loadEmbroidery(key) : loadOutline(key);
    p.catch(() => loaded.delete(key));
    loaded.set(key, p);
  }
  return p;
}

async function loadOutline(key: string): Promise<OutlineFont> {
  let buf: ArrayBuffer;
  if (key.startsWith("ttf:")) buf = await (await fetch(key.slice(4))).arrayBuffer();
  else if (key.startsWith("file:")) {
    const hit = (await idbAll()).find((f) => f.name === key.slice(5));
    if (!hit) throw new Error(`Font ${key.slice(5)} is not installed`);
    buf = hit.bytes;
  } else if (key.startsWith("local:")) {
    if (!localFonts) await systemFonts();
    const f = localFonts?.find((x) => x.postscriptName === key.slice(6));
    if (!f) throw new Error(`System font ${key.slice(6)} is not available`);
    buf = await (await f.blob()).arrayBuffer();
  } else throw new Error(`Unknown font ${key}`);
  return { kind: "outline", key, font: opentype.parse(buf) };
}

/** font.json.gz as written by scripts/bundle-fonts.mjs (px units). */
type FontFile = PackedFont;

// no size / viewBox: one user unit is one px, exactly as Ink/Stitch treats glyphs
const SVG_HEAD =
  '<svg xmlns="http://www.w3.org/2000/svg" xmlns:svg="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:inkstitch="http://inkstitch.org/namespace" xmlns:filum="https://github.com/benkl/filum#namespace">';

/** Bounds of the raw path geometry (like Ink/Stitch's glyph bbox), mm. */
function pathBounds(objs: DesignObject[]) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const o of objs)
    for (const sp of o.paths)
      for (const [x, y] of flatten(sp, 12)) {
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x);
        y1 = Math.max(y1, y);
      }
  return isFinite(x0) ? unionBoxes([{ x: x0, y: y0, w: x1 - x0, h: y1 - y0 }]) : null;
}

async function loadEmbroidery(key: string): Promise<EmbroideryFont> {
  // bundled (emb:), downloaded (emb: of a download pack) or imported (inkfont:), the last two stored packed in IndexedDB
  let imported = key.startsWith("inkfont:") ? (await inkPacks()).find(([id]) => id === key.slice(8))?.[1] : null;
  if (key.startsWith("inkfont:") && !imported) throw new Error(`Font ${key.slice(8)} is not installed`);
  if (key.startsWith("emb:")) {
    const row = (await embroideryIndex()).fonts.find((f) => f.id === key.slice(4));
    if (row?.download) {
      imported = ((await storedFont(row.id))?.pack as InkPack | undefined) ?? null;
      if (!imported) throw new Error(`${row.name} is an optional download (${row.license}): get it in Preferences → Downloads`);
    }
  }
  const id = key.slice(4);
  const meta = imported ? (imported.font as FontFile) : await fetchJsonGz<FontFile>(`${BASE}/${id}/font.json.gz`);
  // every variant's chunks: the default variant's, then the others (if packed)
  const defaultVariant = variantId(meta.variant ?? "ltr");
  const chunks = [
    ...meta.chunks.map((c) => ({ ...c, variant: defaultVariant })),
    ...Object.entries(meta.variants ?? {}).flatMap(([v, cs]) => cs.map((c) => ({ ...c, variant: v }))),
  ];
  const where = new Map<string, Map<string, number>>();
  chunks.forEach((c, i) => {
    let m = where.get(c.variant);
    if (!m) where.set(c.variant, (m = new Map()));
    for (const g of c.glyphs) m.set(g, i);
  });
  const variantOf = (v?: string) => (v && where.has(v) ? v : defaultVariant);
  const chunkData = new Map<number, Promise<Record<string, string>>>();
  const chunk = (i: number) => {
    let p = chunkData.get(i);
    if (!p) {
      p = imported ? Promise.resolve(imported.data[chunks[i].file] ?? {}) : fetchJsonGz<Record<string, string>>(`${BASE}/${id}/${chunks[i].file}`);
      p.catch(() => chunkData.delete(i));
      chunkData.set(i, p);
    }
    return p;
  };
  const mmMap = (m: Record<string, number>) => {
    const o: Record<string, number> = {};
    for (const [k, v] of Object.entries(m ?? {})) o[k] = v * PX;
    return o;
  };
  const colors = [...(meta.colors ?? [])];
  const importGlyph = async (name: string, variant: string) => {
    const ci = where.get(variant)?.get(name);
    if (ci === undefined) return null;
    const frag = (await chunk(ci))[name];
    if (frag === undefined) return null;
    return { ci, r: await engine.importSvg(`${SVG_HEAD}${frag}</svg>`) };
  };
  // fonts without a baseline guide: the bottom of a flat-bottomed capital or digit
  const estimated = new Map<string, Promise<number>>();
  const baselineOf = async (ci: number): Promise<number> => {
    const b = chunks[ci].baseline;
    if (b !== null && b !== undefined) return b;
    const v = chunks[ci].variant;
    let p = estimated.get(v);
    if (!p) {
      p = (async () => {
        const names = where.get(v)!;
        const ref = ["H", "I", "E", "N", "T", "L", "M", "n", "x", "1", "0"].find((g) => names.has(g));
        const hit = ref ? await importGlyph(ref, v) : null;
        const bb = hit ? pathBounds(hit.r.document.objects) : null;
        return bb ? (bb.y + bb.h) / PX : 0;
      })();
      estimated.set(v, p);
    }
    return p;
  };
  const cache = new Map<string, Promise<EmbroideryGlyph | null>>();
  const glyph = (name: string, variant?: string): Promise<EmbroideryGlyph | null> => {
    const v = variantOf(variant);
    const ck = `${v}\u0000${name}`;
    let p = cache.get(ck);
    if (p) return p;
    p = (async () => {
      const hit = await importGlyph(name, v);
      if (!hit) return null;
      const { ci, r } = hit;
      const objs = r.document.objects;
      if (!objs.length) return { name, objects: [], colors: [], width: 0, minX: 0 };
      const threadColor = new Map(r.document.threads.map((t) => [t.id, t.color.toLowerCase()]));
      const colorIdx = objs.map((o) => {
        const c = threadColor.get(o.thread) ?? "";
        let i = colors.indexOf(c);
        if (i < 0) i = colors.push(c) - 1;
        return i;
      });
      // glyph origin: left edge and baseline, like Ink/Stitch's Glyph._move_to_origin
      const b = pathBounds(objs) ?? { x: 0, y: 0, w: 0, h: 0 };
      const dx = -b.x;
      const dy = -(await baselineOf(ci)) * PX;
      const mv = (q: Vec2): Vec2 => [q[0] + dx, q[1] + dy];
      const moved = objs.map((o) => ({
        ...o,
        paths: o.paths.map((sp) => ({
          closed: sp.closed,
          nodes: sp.nodes.map((n) => ({ p: mv(n.p), ...(n.i ? { i: mv(n.i) } : {}), ...(n.o ? { o: mv(n.o) } : {}) })),
        })),
        start: o.start ? mv(o.start) : undefined,
        end: o.end ? mv(o.end) : undefined,
      }));
      return { name, objects: moved, colors: colorIdx, width: b.w, minX: b.x };
    })();
    p.catch(() => cache.delete(ck));
    cache.set(ck, p);
    return p;
  };
  const nameSets = new Map([...where.entries()].map(([v, m]) => [v, new Set(m.keys())]));
  fontNames.set(key, meta.name);
  return {
    kind: "embroidery",
    key,
    name: meta.name,
    size: meta.size || 20,
    minScale: meta.min_scale || 1,
    maxScale: meta.max_scale || 1,
    leading: (meta.leading || 100) * PX,
    space: (meta.horiz_adv_x_space ?? 20) * PX,
    advDefault: meta.horiz_adv_x_default == null ? null : meta.horiz_adv_x_default * PX,
    adv: mmMap(meta.horiz_adv_x),
    kerning: mmMap(meta.kerning_pairs),
    letterCase: meta.letter_case ?? "",
    defaultGlyph: meta.default_glyph ?? "�",
    direction: meta.text_direction === "rtl" ? "rtl" : "ltr",
    colors,
    names: nameSets.get(defaultVariant) ?? new Set(),
    variant: defaultVariant,
    variants: [defaultVariant, ...[...where.keys()].filter((v) => v !== defaultVariant)],
    reversible: meta.reversible !== false,
    namesOf: (v) => nameSets.get(variantOf(v)) ?? new Set(),
    glyph,
  };
}
