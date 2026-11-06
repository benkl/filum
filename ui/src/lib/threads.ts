// Thread colours: colour science (CIE Lab, CIEDE2000), thread charts,
// recent colours, usage / sew sequence, thread operations (merge, replace,
// merge similar, import / export palettes) and the display colouring of
// stitches (thread, sequence, monochrome, focus on one colour).

import { useEffect, useState } from "react";
import { engine } from "../engine/client";
import { useStore } from "../store";
import { FLAG, type PlanData, type StitchDocument, type Thread, type ThreadSource } from "../types";
import { objectBounds, uid } from "./geometry";
import { DEFAULT_MATCH, rankCandidates, solveMatch, type MatchCandidate, type MatchContext, type MatchOptions, type MatchThread } from "./threadMatch";
import { openFile, saveFile } from "./platform";
import { installedItems, onDownloadsChange, storedChart } from "./downloadStore";

const store = () => useStore.getState();

// ---------------------------------------------------------------------------
// Colour maths (lib/colorMath.ts)

export { hexToRgb, rgbToHex, normHex, lab, deltaE } from "./colorMath";
export type { Lab } from "./colorMath";
import { hexToRgb, rgbToHex, normHex, lab, deltaE, type Lab } from "./colorMath";
import { remapThreads, threadsOf } from "./copies";
import { safeSetItem } from "./storage";

export const hexDeltaE = (a: string, b: string) => deltaE(lab(a), lab(b));

/** Black or white text on a colour. */
export function inkOn(hex: string): string {
  const [r, g, b] = hexToRgb(hex);
  return r * 0.299 + g * 0.587 + b * 0.114 > 150 ? "#111" : "#fff";
}

/** Human description of a colour difference. */
export function deltaLabel(d: number): string {
  if (d < 1) return "identical";
  if (d < 3) return "very close";
  if (d < 6) return "close";
  if (d < 12) return "similar";
  return "different";
}

// ---------------------------------------------------------------------------
// Thread charts: the Ink/Stitch collection (public/palettes/index.json, made by
// scripts/bundle-inkstitch.mjs), charts sampled from manufacturer colour cards
// (scripts/bundle-cotona.mjs), the Embroidery Nerds collection once the user
// has downloaded it (Preferences ▸ Downloads: charts with `download` in the
// index are listed only when installed) and palettes the user installs
// (Ink/Stitch "Install custom palette").

export type ChartSource = "mine" | "inkstitch" | "embroiderynerd" | "madeira" | "custom";
export interface ChartMeta {
  /** Path under /palettes without .gpl ("Madeira-Polyneon", "en/Madeira_Classic_40"), or "custom/…". */
  id: string;
  name: string;
  brand: string;
  source: ChartSource;
  count: number;
  /** Not bundled: comes in this download pack (Preferences ▸ Downloads). */
  download?: string;
}
export const SOURCE_LABEL: Record<ChartSource, string> = { mine: "My threads", inkstitch: "Ink/Stitch", embroiderynerd: "Embroidery Nerds", madeira: "Madeira colour card", custom: "Installed" };

// until the index has loaded
const BUILTIN: ChartMeta[] = [
  ["Madeira-Rayon", "Madeira Rayon", "Madeira"],
  ["Isacord-Polyester", "Isacord Polyester", "Isacord"],
  ["Brother-Embroidery", "Brother Embroidery", "Brother"],
  ["Janome", "Janome", "Janome"],
  ["Robison-Anton-Rayon", "Robison-Anton Rayon", "Robison-Anton"],
  ["Gunold-Polyester", "Gunold Polyester", "Gunold"],
  ["Marathon-Polyester", "Marathon Polyester", "Marathon"],
  ["DMC", "DMC", "DMC"],
].map(([id, name, brand]) => ({ id, name, brand, source: "inkstitch" as const, count: 0 }));
export const DEFAULT_CHART = "Madeira-Rayon";

const CUSTOM_KEY = "filum.customCharts";
interface CustomChart {
  id: string;
  name: string;
  entries: { name: string; code: string; color: string }[];
}
function customCharts(): CustomChart[] {
  try {
    return JSON.parse(localStorage.getItem(CUSTOM_KEY) ?? "[]");
  } catch {
    return [];
  }
}
const customMeta = (): ChartMeta[] => customCharts().map((c) => ({ id: c.id, name: c.name, brand: "Installed", source: "custom", count: c.entries.length }));

// ---------------------------------------------------------------------------
// My threads: the spools the user owns, kept in the app across designs. They
// are a chart too ("mine"), so every chart tool works with them.

export const MY_CHART = "mine";
export interface OwnedThread {
  name: string;
  code: string;
  /** Chart / product line, e.g. "Madeira Polyneon". */
  brand: string;
  color: string;
}
const MINE_KEY = "filum.myThreads";
/** Identity of a spool: brand, code and colour. */
export const ownedKey = (t: { brand?: string; code?: string; color: string }) => `${(t.brand ?? "").toLowerCase()}|${(t.code ?? "").toLowerCase()}|${t.color.toLowerCase()}`;
export function myThreads(): OwnedThread[] {
  try {
    return JSON.parse(localStorage.getItem(MINE_KEY) ?? "[]");
  } catch {
    return [];
  }
}
const mineMeta = (): ChartMeta => ({ id: MY_CHART, name: "My threads", brand: "My threads", source: "mine", count: myThreads().length });
const localMeta = () => [mineMeta(), ...customMeta()];
const mineListeners = new Set<() => void>();
function saveMine(list: OwnedThread[]) {
  safeSetItem(MINE_KEY, JSON.stringify(list));
  chartCache.delete(MY_CHART);
  setCharts([...localMeta(), ...charts.filter((c) => c.source !== "custom" && c.source !== "mine")]);
  mineListeners.forEach((f) => f());
}

/** The collection, kept up to date. */
export function useMyThreads(): OwnedThread[] {
  const [list, setList] = useState(myThreads);
  useEffect(() => {
    const f = () => setList(myThreads());
    mineListeners.add(f);
    return () => {
      mineListeners.delete(f);
    };
  }, []);
  return list;
}

/** Add spools (duplicates are skipped); returns how many were new. */
export function addMyThreads(add: OwnedThread[]): number {
  const list = myThreads();
  const have = new Set(list.map(ownedKey));
  const fresh = add.filter((t) => {
    const k = ownedKey(t);
    if (have.has(k)) return false;
    have.add(k);
    return true;
  });
  if (fresh.length) saveMine([...list, ...fresh.map((t) => ({ name: t.name, code: t.code, brand: t.brand, color: t.color.toLowerCase() }))]);
  return fresh.length;
}
export function removeMyThread(t: OwnedThread) {
  const k = ownedKey(t);
  saveMine(myThreads().filter((x) => ownedKey(x) !== k));
}
/** Own it or not; returns whether it is owned now. */
export function toggleMyThread(t: OwnedThread): boolean {
  const k = ownedKey(t);
  if (myThreads().some((x) => ownedKey(x) === k)) {
    removeMyThread(t);
    return false;
  }
  addMyThreads([t]);
  return true;
}
export function clearMyThreads() {
  saveMine([]);
}
/** The design's threads into the collection. */
export function addDesignThreadsToMine(): number {
  return addMyThreads(store().doc.threads.map((t) => ({ name: t.name, code: t.code, brand: t.brand, color: t.color })));
}
export async function importMyThreads(): Promise<number> {
  const f = await openFile([{ name: "GIMP palette", extensions: ["gpl"] }]);
  if (!f) return 0;
  const pal = await engine.parsePalette(new TextDecoder().decode(f.bytes));
  const brand = (pal.name || f.name).replace(/^(Ink\/Stitch|InkStitch|Embroidery Nerds|Filum):\s*/, "").replace(/\.gpl$/i, "").trim();
  return addMyThreads(pal.entries.map((e) => ({ name: e.name || rgbToHex(e.rgb).toUpperCase(), code: e.code, brand: brand === "My threads" ? "" : brand, color: rgbToHex(e.rgb) })));
}
export async function exportMyThreads() {
  const lines = ["GIMP Palette", "Name: My threads", "Columns: 4", "# RGB Value\tColor Name Number"];
  for (const t of myThreads()) {
    const [r, g, b] = hexToRgb(t.color);
    lines.push(`${String(r).padStart(3)} ${String(g).padStart(3)} ${String(b).padStart(3)}\t${[t.brand, t.name].filter(Boolean).join(" ")} ${t.code}`.trimEnd());
  }
  await saveFile("my-threads.gpl", new TextEncoder().encode(lines.join("\n") + "\n"), [{ name: "GIMP palette", extensions: ["gpl"] }]);
}

let charts: ChartMeta[] = [...localMeta(), ...BUILTIN];
const chartListeners = new Set<() => void>();
const setCharts = (list: ChartMeta[]) => {
  charts = list;
  chartListeners.forEach((f) => f());
};
let indexLoad: Promise<ChartMeta[]> | null = null;

/** Every chart of the index, downloadable ones included (filtered by what is installed). */
let indexCharts: ChartMeta[] | null = null;
async function listIndexCharts() {
  if (!indexCharts) return;
  const have = indexCharts.some((c) => c.download) ? await installedItems() : new Set<string>();
  setCharts([...localMeta(), ...indexCharts.filter((c) => !c.download || have.has(c.id))]);
}
onDownloadsChange(() => {
  for (const c of indexCharts ?? []) if (c.download) chartCache.delete(c.id);
  void listIndexCharts();
});

/** Charts that can be downloaded in Preferences ▸ Downloads but aren't installed. */
export async function chartsToDownload(): Promise<number> {
  await loadChartIndex();
  const have = await installedItems();
  return (indexCharts ?? []).filter((c) => c.download && !have.has(c.id)).length;
}

/** All charts (installed first, then by brand). Loads the index once. */
export function loadChartIndex(): Promise<ChartMeta[]> {
  indexLoad ??= fetch("/palettes/index.json")
    .then((r) => r.json())
    .then(async (j: { charts: ChartMeta[] }) => {
      indexCharts = j.charts;
      await listIndexCharts();
      return charts;
    })
    .catch(() => charts);
  return indexLoad;
}

/** The chart list, kept up to date (index load, installs, removals). */
export function useCharts(): ChartMeta[] {
  const [list, setList] = useState(charts);
  useEffect(() => {
    const f = () => setList(charts);
    chartListeners.add(f);
    loadChartIndex().then(f);
    return () => {
      chartListeners.delete(f);
    };
  }, []);
  return list;
}

export const chartMeta = (id: string) => charts.find((c) => c.id === id);
export const chartLabel = (id: string) => chartMeta(id)?.name ?? id.replace(/^(en|custom)\//, "").replace(/[-_]+/g, " ");

export interface ChartEntry {
  name: string;
  code: string;
  color: string;
  lab: Lab;
  brand: string;
}

const chartCache = new Map<string, Promise<ChartEntry[]>>();

export function loadChart(chart: string): Promise<ChartEntry[]> {
  let p = chartCache.get(chart);
  if (!p) {
    const brand = chartLabel(chart);
    if (chart === MY_CHART) {
      p = Promise.resolve(myThreads().map((t) => ({ name: t.name, code: t.code, color: t.color, lab: lab(t.color), brand: t.brand })));
    } else if (chart.startsWith("custom/")) {
      const c = customCharts().find((x) => x.id === chart);
      p = Promise.resolve((c?.entries ?? []).map((e) => ({ ...e, lab: lab(e.color), brand: c?.name ?? brand })));
    } else {
      p = loadChartIndex()
        .then(async () => {
          const meta = indexCharts?.find((c) => c.id === chart);
          if (meta?.download) {
            const text = await storedChart(chart);
            if (!text) throw new Error(`${meta.name} is an optional download: get it in Preferences → Downloads`);
            return text;
          }
          const r = await fetch(`/palettes/${chart}.gpl`);
          if (!r.ok) throw new Error(`chart ${chart}: HTTP ${r.status}`);
          return r.text();
        })
        .then((t) => engine.parsePalette(t))
        .then((pal) =>
          pal.entries.map((e) => {
            const color = rgbToHex(e.rgb);
            return { name: e.name, code: e.code, color, lab: lab(color), brand: chartLabel(chart) };
          }),
        );
    }
    p.catch(() => chartCache.delete(chart));
    chartCache.set(chart, p);
  }
  return p;
}

/**
 * Install a palette file (.gpl, as Ink/Stitch "Install custom palette") as a
 * thread chart: kept in this browser / app, listed under "Installed".
 */
export async function installPalette(): Promise<ChartMeta | null> {
  const f = await openFile([{ name: "GIMP palette", extensions: ["gpl"] }]);
  if (!f) return null;
  const pal = await engine.parsePalette(new TextDecoder().decode(f.bytes));
  if (!pal.entries.length) throw new Error(`${f.name}: no colours found`);
  const name = (pal.name || f.name).replace(/^(Ink\/Stitch|InkStitch|Embroidery Nerds):\s*/, "").replace(/\.gpl$/i, "").trim() || "Palette";
  const id = `custom/${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  const entry: CustomChart = { id, name, entries: pal.entries.map((e) => ({ name: e.name || rgbToHex(e.rgb).toUpperCase(), code: e.code, color: rgbToHex(e.rgb) })) };
  safeSetItem(CUSTOM_KEY, JSON.stringify([entry, ...customCharts().filter((c) => c.id !== id)]));
  chartCache.delete(id);
  setCharts([...localMeta(), ...charts.filter((c) => c.source !== "custom" && c.source !== "mine")]);
  return chartMeta(id) ?? null;
}

export function removeInstalledChart(id: string) {
  safeSetItem(CUSTOM_KEY, JSON.stringify(customCharts().filter((c) => c.id !== id)));
  chartCache.delete(id);
  setCharts(charts.filter((c) => c.id !== id));
}

/** The `n` chart colours nearest to a colour, with their ΔE. */
export function nearest(entries: ChartEntry[], hex: string, n = 8): (ChartEntry & { d: number })[] {
  const L = lab(hex);
  return entries
    .map((e) => ({ ...e, d: deltaE(L, e.lab) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, n);
}

export function searchChart(entries: ChartEntry[], q: string): ChartEntry[] {
  const s = q.trim().toLowerCase();
  if (!s) return entries;
  const hex = normHex(s);
  if (hex && /^#?[0-9a-f]{6}$/i.test(s)) return nearest(entries, hex, 40);
  return entries.filter((e) => e.name.toLowerCase().includes(s) || e.code.toLowerCase().includes(s));
}

// ---------------------------------------------------------------------------
// Recent colours

const RECENT_KEY = "filum.recentThreads";
export type RecentThread = Pick<Thread, "name" | "color" | "brand" | "code">;

export function recentThreads(): RecentThread[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
  } catch {
    return [];
  }
}

export function pushRecent(t: RecentThread) {
  const list = [t, ...recentThreads().filter((x) => !(x.color.toLowerCase() === t.color.toLowerCase() && x.code === t.code))].slice(0, 16);
  safeSetItem(RECENT_KEY, JSON.stringify(list));
}

// ---------------------------------------------------------------------------
// Thread operations

const remapObject = remapThreads;

/** A design thread with this colour (and code, if given) — added when missing. */
export function threadFor(t: RecentThread): string {
  const s = store();
  const hit = s.doc.threads.find((x) => x.color.toLowerCase() === t.color.toLowerCase() && (!t.code || x.code === t.code));
  pushRecent(t);
  if (hit) return hit.id;
  const id = uid("t");
  s.commit((d) => ({ ...d, threads: [...d.threads, { id, name: t.name || t.color.toUpperCase(), color: t.color, brand: t.brand ?? "", code: t.code ?? "" }] }));
  return id;
}

export function updateThread(id: string, patch: Partial<Thread>, live = false) {
  const fn = (d: StitchDocument) => ({ ...d, threads: d.threads.map((t) => (t.id === id ? { ...t, ...patch } : t)) });
  if (live) store().liveUpdate(fn);
  else store().commit(fn);
}

/** Give a design thread a chart colour (colour, name, brand and code). */
export function assignChart(id: string, e: ChartEntry) {
  store().commit((d) => {
    const t = d.threads.find((x) => x.id === id);
    if (!t) return d;
    return {
      ...d,
      threads: d.threads.map((x) => (x.id === id ? { ...x, color: e.color, name: e.name || e.code, brand: e.brand, code: e.code } : x)),
      threadSources: { ...(d.threadSources ?? {}), [id]: needOf(d, t) },
    };
  });
  pushRecent({ name: e.name, color: e.color, brand: e.brand, code: e.code });
}

/** Objects using any of `from` use `into`; the `from` threads are removed. */
export function mergeThreads(from: string[], into: string) {
  const gone = new Set(from.filter((x) => x !== into));
  if (!gone.size) return;
  store().commit((d) => ({
    ...d,
    threads: d.threads.filter((t) => !gone.has(t.id)),
    objects: d.objects.map((o) => remapObject(o, (id) => (gone.has(id) ? into : id))),
  }));
}

export function duplicateThread(id: string): string | null {
  const t = store().doc.threads.find((x) => x.id === id);
  if (!t) return null;
  const nid = uid("t");
  store().commit((d) => {
    const i = d.threads.findIndex((x) => x.id === id);
    const threads = [...d.threads];
    threads.splice(i + 1, 0, { ...t, id: nid, name: `${t.name} copy` });
    return { ...d, threads };
  });
  return nid;
}

export function deleteThread(id: string, replacement?: string) {
  const used = store().doc.objects.some((o) => threadsOf(o).includes(id));
  if (used && replacement) return mergeThreads([id], replacement);
  if (used) return;
  store().commit((d) => ({ ...d, threads: d.threads.filter((t) => t.id !== id) }));
}

export function removeUnused(): number {
  const d = store().doc;
  const used = new Set(d.objects.flatMap(threadsOf));
  const n = d.threads.filter((t) => !used.has(t.id)).length;
  if (n) store().commit((x) => ({ ...x, threads: x.threads.filter((t) => used.has(t.id)) }));
  return n;
}

/** Merge threads closer than `threshold` ΔE (keeps the most used of each cluster). */
const MERGE_KEY = "filum.mergeDeltaE";
/** How close two thread colours must be to merge (CIEDE2000), remembered; one value for the menu and Thread colours. */
export function mergeTolerance(): number {
  const v = Number(localStorage.getItem(MERGE_KEY));
  return v >= 1 && v <= 30 ? v : 6;
}
export function setMergeTolerance(v: number) {
  safeSetItem(MERGE_KEY, String(Math.round(v)));
}
/** Merge similar colours at the remembered tolerance, and say what happened. */
export function mergeSimilarColours() {
  const n = mergeSimilar(mergeTolerance());
  store().toast(n ? `${n} similar thread${n === 1 ? "" : "s"} now share a spool — Revert undoes it` : `No threads closer than ΔE ${mergeTolerance()}`, n ? "success" : "info");
}

export function mergeSimilar(threshold: number): number {
  const d = store().doc;
  const use = (id: string) => d.objects.filter((o) => o.thread === id).length;
  const order = [...d.threads].sort((a, b) => use(b.id) - use(a.id));
  const labs = new Map(order.map((t) => [t.id, lab(t.color)]));
  const taken = new Set<string>();
  let merged = 0;
  const groups: [string, string[]][] = [];
  for (const keep of order) {
    if (taken.has(keep.id)) continue;
    taken.add(keep.id);
    const near = order.filter((t) => !taken.has(t.id) && deltaE(labs.get(keep.id)!, labs.get(t.id)!) < threshold).map((t) => t.id);
    near.forEach((x) => taken.add(x));
    if (near.length) groups.push([keep.id, near]);
    merged += near.length;
  }
  if (!merged) return 0;
  // reversible: the threads stay, they share the keeper's spool (sewn as one
  // colour by the engine) and remember their own colour
  const map = new Map(groups.flatMap(([k, xs]) => xs.map((x) => [x, k] as const)));
  store().commit((x) => {
    const byId = new Map(x.threads.map((t) => [t.id, t]));
    const sources = { ...(x.threadSources ?? {}) };
    const threads = x.threads.map((t) => {
      const k = map.get(t.id);
      const keep = k ? byId.get(k) : undefined;
      if (!keep) return t;
      sources[t.id] = needOf(x, t);
      return { ...t, color: keep.color, name: keep.name, brand: keep.brand, code: keep.code };
    });
    return { ...x, threads, threadSources: sources };
  });
  return merged;
}

/** Snap every thread to its nearest chart colour. */
export async function matchAll(chart: string): Promise<number> {
  return (await fitThreads({ kind: "chart", chart }))?.fitted ?? 0;
}

// ---------------------------------------------------------------------------
// Fitting: every thread takes the nearest spool of a target — My threads (all,
// one brand or one product line) or a chart. The original colour of each
// thread (its "need") is kept in doc.threadSources: fits always start from the
// needs, can be redone with another target and reverted at any time. Threads
// on the same spool are sewn as one colour by the engine, so merging needs no
// deleted threads.

export type FitTarget = { kind: "mine"; brand?: string; line?: string } | { kind: "chart"; chart: string };

export const fitTargetId = (t: FitTarget) => (t.kind === "chart" ? `chart:${t.chart}` : t.line ? `line:${t.line}` : t.brand ? `brand:${t.brand}` : "mine");
export function parseFitTarget(id: string): FitTarget {
  if (id.startsWith("chart:")) return { kind: "chart", chart: id.slice(6) };
  if (id.startsWith("line:")) return { kind: "mine", line: id.slice(5) };
  if (id.startsWith("brand:")) return { kind: "mine", brand: id.slice(6) };
  return { kind: "mine" };
}
export const fitTargetLabel = (t: FitTarget) =>
  t.kind === "chart" ? chartLabel(t.chart) : t.line ? `My ${t.line}` : t.brand ? `My ${t.brand} threads` : "All my threads";

/** Manufacturer of a product line ("Madeira Polyneon" → "Madeira"). */
export function brandOfLine(line: string): string {
  if (!line) return "Other";
  return charts.find((c) => c.name.toLowerCase() === line.toLowerCase())?.brand ?? line.split(/\s+/)[0];
}

/** My threads by brand and product line, with counts. */
export function myLines(list: OwnedThread[] = myThreads()): { brand: string; count: number; lines: { line: string; count: number }[] }[] {
  const by = new Map<string, Map<string, number>>();
  for (const t of list) {
    const b = brandOfLine(t.brand);
    const lines = by.get(b) ?? new Map<string, number>();
    lines.set(t.brand || "Other", (lines.get(t.brand || "Other") ?? 0) + 1);
    by.set(b, lines);
  }
  return [...by]
    .map(([brand, lines]) => ({ brand, count: [...lines.values()].reduce((a, c) => a + c, 0), lines: [...lines].map(([line, count]) => ({ line, count })).sort((a, c) => a.line.localeCompare(c.line)) }))
    .sort((a, c) => a.brand.localeCompare(c.brand));
}

/** The colour a thread was meant to be (before any fit). */
export const needOf = (d: StitchDocument, t: Thread): ThreadSource => d.threadSources?.[t.id] ?? { name: t.name, color: t.color, brand: t.brand, code: t.code };
export const isFitted = (d: StitchDocument, id: string) => !!d.threadSources?.[id];
/** Threads on the same spool are one colour. */
export const spoolKey = (t: { brand?: string; code?: string; color: string }) => ownedKey(t);

async function targetEntries(target: FitTarget): Promise<ChartEntry[]> {
  if (target.kind === "chart") return loadChart(target.chart);
  return myThreads()
    .filter((t) => (target.line ? t.brand.toLowerCase() === target.line.toLowerCase() : target.brand ? brandOfLine(t.brand) === target.brand : true))
    .map((t) => ({ ...t, lab: lab(t.color) }));
}

export interface FitReport {
  target: string;
  /** Threads given a spool. */
  fitted: number;
  /** Threads that share their spool with another thread (sewn as one colour). */
  shared: number;
  /** Threads whose nearest spool is far off. */
  far: { name: string; spool: string; d: number }[];
  /** Different colours (ΔE ≥ 3) that ended up on one spool. */
  merged: { a: string; b: string; d: number }[];
  mean: number;
  worst: number;
}

/** Fit every thread (or `only` these) to the target's nearest spools, from their needs. One undo step. */
/** Match options in use (remembered). */
const MATCH_KEY = "filum.match";
export function loadMatchOptions(): MatchOptions {
  try {
    const o = JSON.parse(localStorage.getItem(MATCH_KEY) ?? "{}");
    return { ...DEFAULT_MATCH, ...o, weights: { ...DEFAULT_MATCH.weights, ...(o.weights ?? {}) } };
  } catch {
    return DEFAULT_MATCH;
  }
}
export function saveMatchOptions(o: MatchOptions) {
  safeSetItem(MATCH_KEY, JSON.stringify(o));
}

/** Locked threads keep their spool when fitting. */
export const isLocked = (d: StitchDocument, id: string) => !!d.threadLocks?.includes(id);
export function toggleLock(id: string) {
  store().commit((d) => {
    const locks = new Set(d.threadLocks ?? []);
    if (locks.has(id)) locks.delete(id);
    else locks.add(id);
    return { ...d, threadLocks: locks.size ? [...locks] : undefined };
  });
}

/** Threads whose objects touch (bounding boxes overlap, 0.5 mm slack). */
export function threadNeighbours(d: StitchDocument): [string, string][] {
  const boxes = d.objects.filter((o) => o.visible).map((o) => [o.thread, objectBounds(o)] as const).filter((x) => !!x[1]);
  const out = new Set<string>();
  for (let i = 0; i < boxes.length; i++)
    for (let j = i + 1; j < boxes.length; j++) {
      const [ta, a] = boxes[i];
      const [tb, b] = boxes[j];
      if (ta === tb || !a || !b) continue;
      if (a.x - 0.5 <= b.x + b.w && b.x - 0.5 <= a.x + a.w && a.y - 0.5 <= b.y + b.h && b.y - 0.5 <= a.y + a.h) out.add(ta < tb ? ta + "|" + tb : tb + "|" + ta);
    }
  return [...out].map((k) => k.split("|") as [string, string]);
}

/** The context the matcher needs for this document. */
function matchContext(d: StitchDocument): MatchContext {
  const owned = new Set(myThreads().map(ownedKey));
  return { fabric: store().fabricColor, neighbours: threadNeighbours(d), owned, ownedKey: (e) => ownedKey(e), brandOf: (e) => brandOfLine(e.brand) };
}

/** Match threads of the document to the target (all, or `only`); locked threads and, with `only`, all others keep their spool. */
async function planFit(target: FitTarget, opts: { only?: string[]; match?: MatchOptions }) {
  const entries = await targetEntries(target);
  if (!entries.length) return null;
  const match = opts.match ?? loadMatchOptions();
  const d = store().doc;
  const usage = threadUsage(d, store().plan);
  const total = [...usage.values()].reduce((a, u) => a + u.stitches, 0) || 1;
  const input: MatchThread[] = d.threads.map((t) => {
    const fixed = isLocked(d, t.id) || (!!opts.only && !opts.only.includes(t.id));
    return {
      id: t.id,
      need: needOf(d, t).color,
      weight: (usage.get(t.id)?.stitches ?? 0) / total + 0.02,
      locked: fixed,
      current: fixed ? { name: t.name, code: t.code, color: t.color, brand: t.brand, lab: lab(t.color) } : undefined,
    };
  });
  return { d, entries, match, result: solveMatch(input, entries, match, matchContext(d)) };
}

/** What a fit would give (nothing changes): quality, spools, merges. */
export async function previewFit(target: FitTarget, match: MatchOptions): Promise<{ mean: number; worst: number; spools: number; merged: number; poor: number } | null> {
  const planned = await planFit(target, { match });
  if (!planned) return null;
  const ds = [...planned.result.pick.values()].map((c) => c.d);
  const spools = new Set([...planned.result.pick.values()].map((c) => spoolKey(c.entry))).size;
  return {
    mean: ds.reduce((a, b) => a + b, 0) / Math.max(1, ds.length),
    worst: Math.max(0, ...ds),
    spools,
    merged: planned.result.shared.filter((m) => m.d >= 3).length,
    poor: ds.filter((d) => d > 6).length,
  };
}

/** Candidates for one thread from the fit target (best first), with the match options. */
export async function threadCandidates(target: FitTarget, threadId: string, n = 5): Promise<MatchCandidate[]> {
  const entries = await targetEntries(target);
  const d = store().doc;
  const t = d.threads.find((x) => x.id === threadId);
  if (!t || !entries.length) return [];
  return rankCandidates(needOf(d, t).color, entries, loadMatchOptions(), matchContext(d), n);
}

/** Fit every thread (or `only` these) to the target with the match options, from their needs. One undo step. */
export async function fitThreads(target: FitTarget, opts: { farDelta?: number; only?: string[]; match?: MatchOptions } = {}): Promise<FitReport | null> {
  const planned = await planFit(target, opts);
  if (!planned) return null;
  const { d, result } = planned;
  const farDelta = opts.farDelta ?? 6;
  const sources = { ...(d.threadSources ?? {}) };
  const far: FitReport["far"] = [];
  const deltas: number[] = [];
  const threads = d.threads.map((t) => {
    if (isLocked(d, t.id) || (opts.only && !opts.only.includes(t.id))) return t;
    const c = result.pick.get(t.id);
    if (!c) return t;
    const need = needOf(d, t);
    deltas.push(c.d);
    if (c.d > farDelta) far.push({ name: need.name, spool: [c.entry.brand, c.entry.code, c.entry.name].filter(Boolean).join(" "), d: c.d });
    sources[t.id] = need;
    return { ...t, color: c.entry.color, name: c.entry.name || c.entry.code, brand: c.entry.brand, code: c.entry.code };
  });
  const seen = new Set<string>();
  let shared = 0;
  for (const t of threads) {
    const k = spoolKey(t);
    if (seen.has(k)) shared++;
    seen.add(k);
  }
  store().commit((x) => ({ ...x, threads, threadSources: sources }));
  const nameOf = (id: string) => needOf(d, d.threads.find((t) => t.id === id)!).name;
  return {
    target: fitTargetLabel(target),
    fitted: deltas.length,
    shared,
    merged: result.shared.filter((m) => m.d >= 3).map((m) => ({ a: nameOf(m.a), b: nameOf(m.b), d: m.d })),
    far,
    mean: deltas.reduce((a, b) => a + b, 0) / Math.max(1, deltas.length),
    worst: Math.max(0, ...deltas),
  };
}

/** Give threads (all, or `ids`) their original colours back. Returns how many. */
export function revertFit(ids?: string[]): number {
  const d = store().doc;
  const src = d.threadSources ?? {};
  const back = (ids ?? Object.keys(src)).filter((id) => src[id] && d.threads.some((t) => t.id === id));
  if (!back.length) return 0;
  store().commit((x) => {
    const rest = { ...(x.threadSources ?? {}) };
    for (const id of back) delete rest[id];
    return {
      ...x,
      threads: x.threads.map((t) => (back.includes(t.id) ? { ...t, ...src[t.id] } : t)),
      threadSources: Object.keys(rest).length ? rest : undefined,
    };
  });
  return back.length;
}

/** A sewn colour block and the design threads (needs) it carries. */
export interface FitBlock {
  index: number;
  /** The spool sewn in this block. */
  thread: Thread;
  threadId: string | null;
  stitches: number;
  metres: number;
  needs: { threadId: string; need: ThreadSource; stitches: number; d: number }[];
}

/** The sew sequence with every block split into the needs it covers (fits and merges). */
export function fitSequence(doc: StitchDocument, plan: PlanData | null): FitBlock[] {
  const blocks = colorSequence(doc, plan);
  if (!plan || !blocks.length) return [];
  const byId = new Map(doc.threads.map((t) => [t.id, t]));
  const out: FitBlock[] = blocks.map((b) => ({ ...b, needs: [] }));
  let k = 0;
  const n = plan.flags.length;
  for (let i = 0; i < n; i++) {
    const f = plan.flags[i];
    if (f & FLAG.COLOR_CHANGE) {
      k = Math.min(k + 1, out.length - 1);
      continue;
    }
    if (f & FLAG.COMMANDS) continue;
    const blk = out[k];
    const o = doc.objects[plan.objects[i]];
    let tid = o?.thread ?? blk.threadId ?? "";
    const t = byId.get(tid);
    // lettering with several colours: fall back to the block's own thread
    if (!t || spoolKey(t) !== spoolKey(blk.thread)) tid = blk.threadId ?? tid;
    const last = blk.needs[blk.needs.length - 1];
    if (last && last.threadId === tid) last.stitches++;
    else {
      const th = byId.get(tid) ?? blk.thread;
      const need = needOf(doc, th);
      blk.needs.push({ threadId: tid, need, stitches: 1, d: deltaE(lab(need.color), lab(blk.thread.color)) });
    }
  }
  return out;
}

/** Threads in the order they are first sewn (unused ones last). */
export function sortBySewOrder() {
  store().commit((d) => {
    const first = new Map<string, number>();
    d.objects.forEach((o, i) => {
      if (!first.has(o.thread)) first.set(o.thread, i);
    });
    return { ...d, threads: [...d.threads].sort((a, b) => (first.get(a.id) ?? 1e9) - (first.get(b.id) ?? 1e9)) };
  });
}

export function moveThread(id: string, delta: number) {
  store().commit((d) => {
    const i = d.threads.findIndex((t) => t.id === id);
    const j = Math.max(0, Math.min(d.threads.length - 1, i + delta));
    if (i < 0 || i === j) return d;
    const threads = [...d.threads];
    const [t] = threads.splice(i, 1);
    threads.splice(j, 0, t);
    return { ...d, threads };
  });
}

export async function exportPalette() {
  const d = store().doc;
  const lines = ["GIMP Palette", `Name: ${d.name || "Filum design"}`, "Columns: 4", "#"];
  for (const t of d.threads) {
    const [r, g, b] = hexToRgb(t.color);
    lines.push(`${String(r).padStart(3)} ${String(g).padStart(3)} ${String(b).padStart(3)}\t${t.name}\t${t.code}`);
  }
  await saveFile(`${d.name || "design"}-threads.gpl`, new TextEncoder().encode(lines.join("\n") + "\n"), [{ name: "GIMP palette", extensions: ["gpl"] }]);
}

/** Add the colours of a .gpl palette as design threads. */
export async function importPalette(): Promise<number> {
  const f = await openFile([{ name: "GIMP palette", extensions: ["gpl"] }]);
  if (!f) return 0;
  const pal = await engine.parsePalette(new TextDecoder().decode(f.bytes));
  const brand = (pal.name || f.name).replace(/^Ink\/Stitch:\s*/, "").replace(/\.gpl$/i, "");
  const d = store().doc;
  const have = new Set(d.threads.map((t) => t.color.toLowerCase()));
  const add: Thread[] = [];
  for (const e of pal.entries) {
    const color = rgbToHex(e.rgb);
    if (have.has(color)) continue;
    have.add(color);
    add.push({ id: uid("t"), name: e.name || color.toUpperCase(), color, brand, code: e.code });
  }
  if (add.length) store().commit((x) => ({ ...x, threads: [...x.threads, ...add] }));
  return add.length;
}

// ---------------------------------------------------------------------------
// Usage and sew sequence

export interface ColorBlock {
  index: number;
  thread: Thread;
  /** Id of the matching design thread (if any). */
  threadId: string | null;
  stitches: number;
  metres: number;
}

/** The colour blocks of the plan in sew order. */
export function colorSequence(doc: StitchDocument, plan: PlanData | null): ColorBlock[] {
  if (!plan) return [];
  const byId = new Map(doc.threads.map((t) => [t.id, t]));
  return plan.threads.map((t, i) => {
    const match = byId.get(t.id) ?? doc.threads.find((x) => x.color.toLowerCase() === t.color.toLowerCase());
    return {
      index: i,
      thread: match ?? t,
      threadId: match?.id ?? null,
      stitches: plan.stats.stitchesPerColor[i] ?? 0,
      metres: plan.stats.threadPerColorM[i] ?? 0,
    };
  });
}

export interface ThreadUsage {
  objects: number;
  stitches: number;
  metres: number;
  /** Sew order positions (1-based colour blocks). */
  blocks: number[];
}

export function threadUsage(doc: StitchDocument, plan: PlanData | null): Map<string, ThreadUsage> {
  const out = new Map<string, ThreadUsage>(doc.threads.map((t) => [t.id, { objects: 0, stitches: 0, metres: 0, blocks: [] }]));
  for (const o of doc.objects) {
    const u = out.get(o.thread);
    if (u) u.objects++;
  }
  for (const b of colorSequence(doc, plan)) {
    const u = b.threadId ? out.get(b.threadId) : undefined;
    if (!u) continue;
    u.stitches += b.stitches;
    u.metres += b.metres;
    u.blocks.push(b.index + 1);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Stitch display colours

export type StitchColors = "thread" | "sequence" | "mono";

export const STITCH_COLORS: { id: StitchColors; label: string; title: string }[] = [
  { id: "thread", label: "Thread colours", title: "Stitches in their thread colours" },
  { id: "sequence", label: "Colour sequence", title: "A distinct hue per colour block — check the sew order and colour changes" },
  { id: "mono", label: "Monochrome", title: "All stitches in one colour — judge coverage and density" },
];

const mix = (a: string, b: string, t: number) => {
  const A = hexToRgb(a);
  const B = hexToRgb(b);
  return rgbToHex(A.map((x, i) => x + (B[i] - x) * t));
};

function sequenceColor(i: number, n: number): string {
  // evenly spaced, well separated hues (golden-angle walk)
  const h = (i * 137.508) % 360;
  const l = 0.5 + 0.08 * Math.sin(i * 1.7);
  const s = 0.72;
  const k = (m: number) => (m + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (m: number) => l - a * Math.max(-1, Math.min(k(m) - 3, 9 - k(m), 1));
  void n;
  return rgbToHex([f(0) * 255, f(8) * 255, f(4) * 255]);
}

const displayCache = new WeakMap<PlanData, Map<string, PlanData>>();

/**
 * The plan to draw: the same stitches, with the colour blocks recoloured
 * for the display mode, and the colours other than `focus` faded towards
 * the fabric. Memoised per plan so the renderers' caches stay valid.
 */
export function displayPlan(plan: PlanData | null, mode: StitchColors, focus: string | null, fabric: string): PlanData | null {
  if (!plan || (mode === "thread" && !focus)) return plan;
  const key = `${mode}|${focus ?? ""}|${fabric}`;
  let m = displayCache.get(plan);
  if (!m) displayCache.set(plan, (m = new Map()));
  const hit = m.get(key);
  if (hit) return hit;
  const n = plan.threads.length;
  const fabricLab = lab(fabric);
  const threads = plan.threads.map((t, i) => {
    let color = t.color;
    if (mode === "sequence") color = sequenceColor(i, n);
    else if (mode === "mono") color = fabricLab[0] > 50 ? "#2b2f3a" : "#e8e4da";
    if (focus && t.id !== focus) color = mix(color, fabric, 0.82);
    return { ...t, color };
  });
  const out = { ...plan, threads };
  m.set(key, out);
  return out;
}
