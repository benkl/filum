/// <reference lib="webworker" />
// Runs the Rust/WASM stitch engine off the main thread.
import init, {
  StitchEngine,
  digitize,
  digitizePreview,
  exportSvg,
  formats,
  importEmbroidery,
  importSvg,
  outlineShapes,
  booleanShapes,
  shapeRegions,
  shapeBuild,
  parsePalette,
  meanderTiles,
  convertShapes,
  readThreadList,
} from "../wasm/pkg/filum_wasm.js";

type Req = { id: number; op: EngineOp; args: unknown[] };

let engine: StitchEngine | null = null;
const ready = init().then(() => {
  engine = new StitchEngine();
});

/** An operation's result and the buffers handed over with it (not copied). */
type Out = { result: unknown; transfer?: Transferable[] };
const s = (a: unknown[], i: number) => a[i] as string;
const opt = (a: unknown[], i: number) => (a[i] as string | undefined) ?? "{}";
const bytes = (a: unknown[], i: number) => a[i] as Uint8Array;
/** Most operations answer in JSON. */
const json = (f: (e: StitchEngine, a: unknown[]) => string) => (e: StitchEngine, a: unknown[]): Out => ({ result: JSON.parse(f(e, a)) });

/** A stitch plan: the records as typed arrays, the rest from the JSON meta (crates/wasm/src/lib.rs plan_js). */
function planOut(r: { coords: Float32Array; flags: Uint8Array; objects: Uint32Array; meta: string }): Out {
  const meta = JSON.parse(r.meta);
  return {
    result: { coords: r.coords, flags: r.flags, objects: r.objects, ...meta, basting: meta.basting ?? null, links: meta.links ?? [], quality: meta.quality ?? null, dense: meta.dense ?? null },
    transfer: [r.coords.buffer, r.flags.buffer, r.objects.buffer],
  };
}

/**
 * The engine's operations by name (engine/client.ts calls them by these
 * names; a name that isn't here doesn't compile there).
 */
const OPS = {
  plan: (e: StitchEngine, a: unknown[]) => planOut(e.plan(s(a, 0))),
  exportPlan: (e: StitchEngine, a: unknown[]) => planOut(e.exportPlan(s(a, 0), opt(a, 1))),
  densityField: (e: StitchEngine, a: unknown[]): Out => {
    const r = e.densityField(s(a, 0), opt(a, 1)) as { layers: Float32Array; holes: Float32Array; added: Float32Array; class: Uint8Array; meta: string };
    return { result: { ...JSON.parse(r.meta), layers: r.layers, holes: r.holes, added: r.added, cls: r.class }, transfer: [r.layers.buffer, r.holes.buffer, r.added.buffer, r.class.buffer] };
  },
  stitchedShapes: json((e, a) => e.stitchedShapes(s(a, 0))),
  elementInfo: json((e, a) => e.elementInfo(s(a, 0), s(a, 1))),
  applyThreadList: json((e, a) => e.applyThreadList(s(a, 0), s(a, 1))),
  stitchOutline: json((e, a) => e.stitchOutline(s(a, 0), s(a, 1), s(a, 2))),
  readThreadList: json((_, a) => readThreadList(bytes(a, 0), s(a, 1))),
  optimize: json((e, a) => e.optimize(s(a, 0), opt(a, 1))),
  export: (e: StitchEngine, a: unknown[]): Out => {
    const out = e.export(s(a, 0), s(a, 1), opt(a, 2));
    return { result: out, transfer: [out.buffer] };
  },
  machineColors: json((e, a) => e.machineColors(s(a, 0), s(a, 1), opt(a, 2))),
  importSvg: json((_, a) => importSvg(s(a, 0))),
  exportSvg: (_: StitchEngine, a: unknown[]): Out => ({ result: exportSvg(s(a, 0)) }),
  importEmbroidery: json((_, a) => importEmbroidery(bytes(a, 0), s(a, 1))),
  digitize: json((_, a) => digitize(bytes(a, 0), s(a, 1))),
  digitizePreview: (_: StitchEngine, a: unknown[]): Out => {
    const r = digitizePreview(bytes(a, 0), s(a, 1)) as {
      width: number;
      height: number;
      rgba: Uint8ClampedArray;
      regionWidth: number;
      regionHeight: number;
      regions: Uint32Array;
      regionLabel: Uint8Array;
      regionReason: Uint8Array;
      meta: string;
    };
    const { meta, ...rest } = r;
    return { result: { ...rest, ...JSON.parse(meta) }, transfer: [r.rgba.buffer, r.regions.buffer, r.regionLabel.buffer, r.regionReason.buffer] };
  },
  outlineShapes: json((_, a) => outlineShapes(s(a, 0), s(a, 1), a[2] as number, (a[3] as number) ?? 0, !!a[4], (a[5] as number) ?? 0)),
  booleanShapes: json((_, a) => booleanShapes(s(a, 0), s(a, 1), s(a, 2))),
  shapeRegions: json((_, a) => shapeRegions(s(a, 0), s(a, 1))),
  shapeBuild: json((_, a) => shapeBuild(s(a, 0), s(a, 1), s(a, 2), s(a, 3))),
  convertShapes: json((_, a) => convertShapes(s(a, 0), s(a, 1), s(a, 2))),
  formats: json(() => formats()),
  meanderTiles: (): Out => ({ result: JSON.parse(meanderTiles()).tiles }),
  parsePalette: json((_, a) => parsePalette(s(a, 0))),
} satisfies Record<string, (e: StitchEngine, a: unknown[]) => Out>;

/** The names of the engine's operations. */
export type EngineOp = keyof typeof OPS;

self.onmessage = async (e: MessageEvent<Req>) => {
  const { id, op, args } = e.data;
  try {
    await ready;
    const run = OPS[op];
    if (!run) throw new Error(`unknown op ${op}`);
    const { result, transfer = [] } = run(engine!, args);
    (self as unknown as Worker).postMessage({ id, ok: true, result }, transfer);
  } catch (err) {
    const error = String((err as Error)?.message ?? err);
    // a panic (a trap) leaves the engine unusable: the client starts a new worker
    const fatal = err instanceof WebAssembly.RuntimeError || /unreachable|recursive use of an object|memory access out of bounds|null pointer passed/i.test(error);
    (self as unknown as Worker).postMessage({ id, ok: false, error, fatal });
  }
};
