import type {
  DensityField,
  DigitizeOptions,
  DigitizePreview,
  DigitizeResult,
  ElementInfo,
  ExportOptions,
  FormatInfo,
  MachineColorInfo,
  MeanderTile,
  OptimizeReport,
  PlanData,
  StitchDocument,
  SubPath,
  ThreadListEntry,
} from "../types";

// Promise-based RPC to the engine worker. Plan requests are coalesced so that
// rapid edits only ever compute the latest document.

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

/** The document as the engine reads it: reference pictures stay in the UI. */
const engineJson = (doc: StitchDocument) => JSON.stringify(doc.references ? { ...doc, references: undefined } : doc);

/** A region of the Shape Builder: its rings and the objects covering it. */
export interface ShapeRegion {
  rings: [number, number][][];
  owners: string[];
}
export interface ShapeBuildResult {
  merged: SubPath[] | null;
  updates: { id: string; paths: SubPath[] }[];
  parts: { owner: string; paths: SubPath[] }[];
}

class EngineClient {
  private worker: Worker;
  private seq = 0;
  private pending = new Map<number, Pending>();
  private planBusy = false;
  private planQueued: { json: string; resolve: (p: PlanData) => void; reject: (e: Error) => void } | null = null;

  constructor() {
    this.worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    this.worker.onmessage = (e) => {
      const { id, ok, result, error } = e.data;
      const p = this.pending.get(id);
      if (!p) return;
      this.pending.delete(id);
      if (ok) p.resolve(result);
      else p.reject(new Error(error));
    };
  }

  private call<T>(op: string, args: unknown[], transfer: Transferable[] = []): Promise<T> {
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.worker.postMessage({ id, op, args }, transfer);
    });
  }

  /** Latest-wins plan computation. */
  plan(doc: StitchDocument): Promise<PlanData> {
    const json = engineJson(doc);
    return new Promise((resolve, reject) => {
      if (this.planBusy) {
        this.planQueued?.reject(new Error("superseded"));
        this.planQueued = { json, resolve, reject };
        return;
      }
      this.runPlan(json, resolve, reject);
    });
  }

  private runPlan(json: string, resolve: (p: PlanData) => void, reject: (e: Error) => void) {
    this.planBusy = true;
    this.call<PlanData>("plan", [json])
      .then(resolve, reject)
      .finally(() => {
        this.planBusy = false;
        const q = this.planQueued;
        this.planQueued = null;
        if (q) this.runPlan(q.json, q.resolve, q.reject);
      });
  }

  optimize(doc: StitchDocument) {
    return this.call<OptimizeReport>("optimize", [engineJson(doc)]);
  }
  export(doc: StitchDocument, format: string, opts: ExportOptions = {}) {
    return this.call<Uint8Array>("export", [engineJson(doc), format, JSON.stringify(opts)]);
  }
  /** The plan as it goes into a file (repeats, frame out on stops) — pictures of the export. */
  exportPlan(doc: StitchDocument, opts: ExportOptions = {}) {
    return this.call<PlanData>("exportPlan", [engineJson(doc), JSON.stringify(opts)]);
  }
  /** The density of the design on its fabric: layers, needle holes, added weight (see lib/density.ts). */
  densityField(doc: StitchDocument, opts: { sigma?: number; maxCells?: number } = {}) {
    return this.call<DensityField>("densityField", [engineJson(doc), JSON.stringify(opts)]);
  }
  /** The objects cut by hidden-stitch removal as they are stitched (empty paths: hidden completely). */
  stitchedShapes(doc: StitchDocument) {
    return this.call<{ index: number; paths: SubPath[] }[]>("stitchedShapes", [engineJson(doc)]);
  }
  /** Element info (Ink/Stitch): per object and in total; all visible objects when `ids` is empty. */
  elementInfo(doc: StitchDocument, ids: string[]) {
    return this.call<ElementInfo>("elementInfo", [engineJson(doc), JSON.stringify(ids)]);
  }
  /** Read a thread list file (Ink/Stitch or other TXT, COL, EDR, INF). */
  readThreadList(bytes: Uint8Array, filename: string) {
    return this.call<{ kind: string; entries: ThreadListEntry[] }>("readThreadList", [bytes, filename]);
  }
  /** Give colour block k the thread of entry k (Ink/Stitch apply thread list). */
  applyThreadList(doc: StitchDocument, entries: ThreadListEntry[]) {
    return this.call<{ document: StitchDocument; report: { blocks: number; entries: number; applied: number; unmatched: number } }>("applyThreadList", [
      engineJson(doc),
      JSON.stringify(entries),
    ]);
  }
  /** Shapes rebuilt from the stitches of objects (Ink/Stitch outline). */
  stitchOutline(doc: StitchDocument, ids: string[], params: { buffer: number; inset: number; smoothness: number; threshold: number }) {
    return this.call<{ id: string; paths: SubPath[] }[]>("stitchOutline", [engineJson(doc), JSON.stringify(ids), JSON.stringify(params)]);
  }
  /** What the machine will show for each colour block of an export. */
  machineColors(doc: StitchDocument, format: string, opts: ExportOptions = {}) {
    return this.call<MachineColorInfo[]>("machineColors", [engineJson(doc), format, JSON.stringify(opts)]);
  }
  importSvg(text: string) {
    return this.call<{ document: StitchDocument; warnings: string[]; texts?: SvgText[] }>("importSvg", [text]);
  }
  exportSvg(doc: StitchDocument) {
    return this.call<string>("exportSvg", [engineJson(doc)]);
  }
  importEmbroidery(bytes: Uint8Array, filename: string) {
    return this.call<StitchDocument>("importEmbroidery", [bytes, filename]);
  }
  digitize(bytes: Uint8Array, opts: Partial<DigitizeOptions>) {
    return this.call<DigitizeResult>("digitize", [bytes, JSON.stringify(opts)]);
  }
  digitizePreview(bytes: Uint8Array, opts: Partial<DigitizeOptions>) {
    return this.call<DigitizePreview>("digitizePreview", [bytes, JSON.stringify(opts)]);
  }
  /** One-off plan that does not take part in the editor's latest-wins queue. */
  planDetached(doc: StitchDocument) {
    return this.call<PlanData>("plan", [engineJson(doc)]);
  }
  /** Union of the objects grown by `offset` mm (negative shrinks) as closed sub-paths. */
  outlineShapes(doc: StitchDocument, ids: string[], offset: number, o: { bridge?: number; outerOnly?: boolean; minArea?: number } = {}) {
    return this.call<SubPath[]>("outlineShapes", [engineJson(doc), JSON.stringify(ids), offset, o.bridge ?? 0, !!o.outerOnly, o.minArea ?? 0]);
  }
  /** Shape booleans on the objects (stacking order): unite, minusFront, intersect, exclude. */
  booleanShapes(doc: StitchDocument, ids: string[], op: "unite" | "minusFront" | "intersect" | "exclude") {
    return this.call<SubPath[]>("booleanShapes", [engineJson(doc), JSON.stringify(ids), op]);
  }
  /** Shape Builder: the overlap regions of the objects (stacking order) and who covers each. */
  shapeRegions(doc: StitchDocument, ids: string[]) {
    return this.call<ShapeRegion[]>("shapeRegions", [engineJson(doc), JSON.stringify(ids)]);
  }
  /** Shape Builder: merge or delete regions (by index), or divide everything into its regions. */
  shapeBuild(doc: StitchDocument, ids: string[], faces: number[], mode: "merge" | "delete" | "divide") {
    return this.call<ShapeBuildResult>("shapeBuild", [engineJson(doc), JSON.stringify(ids), JSON.stringify(faces), mode]);
  }
  formats() {
    return this.call<FormatInfo[]>("formats", []);
  }
  /** The Ink/Stitch meander tiles (mm at 100 %). */
  meanderTiles() {
    return this.call<MeanderTile[]>("meanderTiles", []);
  }
  parsePalette(text: string) {
    return this.call<{ name: string; entries: { name: string; code: string; rgb: [number, number, number] }[] }>(
      "parsePalette",
      [text],
    );
  }
  /** Shape conversions (see lib/convertEngine.ts for the typed wrappers). */
  convertShapes<T>(op: string, args: object, doc?: StitchDocument) {
    return this.call<T>("convertShapes", [op, doc ? engineJson(doc) : "", JSON.stringify(args)]);
  }
}

export const engine = new EngineClient();

/** An SVG <text> the importer found (mm): set as lettering by the editor. */
export interface SvgText {
  text: string;
  x: number;
  y: number;
  /** Font size (mm). */
  size: number;
  color: string;
  font?: string | null;
  anchor: string;
  /** Where it sits in the sewing order (index in the objects). */
  index: number;
}
