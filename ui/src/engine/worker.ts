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

type Req = { id: number; op: string; args: unknown[] };

let engine: StitchEngine | null = null;
const ready = init().then(() => {
  engine = new StitchEngine();
});

self.onmessage = async (e: MessageEvent<Req>) => {
  const { id, op, args } = e.data;
  try {
    await ready;
    const eng = engine!;
    let result: unknown;
    const transfer: Transferable[] = [];
    switch (op) {
      case "plan":
      case "exportPlan": {
        const r = (op === "plan" ? eng.plan(args[0] as string) : eng.exportPlan(args[0] as string, (args[1] as string) ?? "{}")) as {
          coords: Float32Array;
          flags: Uint8Array;
          objects: Uint32Array;
          meta: string;
        };
        const meta = JSON.parse(r.meta);
        result = { coords: r.coords, flags: r.flags, objects: r.objects, threads: meta.threads, stats: meta.stats };
        transfer.push(r.coords.buffer, r.flags.buffer, r.objects.buffer);
        break;
      }
      case "densityField": {
        const r = eng.densityField(args[0] as string, (args[1] as string) ?? "{}") as { layers: Float32Array; holes: Float32Array; added: Float32Array; class: Uint8Array; meta: string };
        result = { ...JSON.parse(r.meta), layers: r.layers, holes: r.holes, added: r.added, cls: r.class };
        transfer.push(r.layers.buffer, r.holes.buffer, r.added.buffer, r.class.buffer);
        break;
      }
      case "stitchedShapes":
        result = JSON.parse(eng.stitchedShapes(args[0] as string));
        break;
      case "elementInfo":
        result = JSON.parse(eng.elementInfo(args[0] as string, args[1] as string));
        break;
      case "applyThreadList":
        result = JSON.parse(eng.applyThreadList(args[0] as string, args[1] as string));
        break;
      case "stitchOutline":
        result = JSON.parse(eng.stitchOutline(args[0] as string, args[1] as string, args[2] as string));
        break;
      case "readThreadList":
        result = JSON.parse(readThreadList(args[0] as Uint8Array, args[1] as string));
        break;
      case "optimize":
        result = JSON.parse(eng.optimize(args[0] as string));
        break;
      case "export": {
        const bytes = eng.export(args[0] as string, args[1] as string, (args[2] as string) ?? "{}");
        result = bytes;
        transfer.push(bytes.buffer);
        break;
      }
      case "machineColors":
        result = JSON.parse(eng.machineColors(args[0] as string, args[1] as string, (args[2] as string) ?? "{}"));
        break;
      case "importSvg":
        result = JSON.parse(importSvg(args[0] as string));
        break;
      case "exportSvg":
        result = exportSvg(args[0] as string);
        break;
      case "importEmbroidery":
        result = JSON.parse(importEmbroidery(args[0] as Uint8Array, args[1] as string));
        break;
      case "digitize":
        result = JSON.parse(digitize(args[0] as Uint8Array, args[1] as string));
        break;
      case "digitizePreview": {
        const r = digitizePreview(args[0] as Uint8Array, args[1] as string) as {
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
        result = { ...rest, ...JSON.parse(meta) };
        transfer.push(r.rgba.buffer, r.regions.buffer, r.regionLabel.buffer, r.regionReason.buffer);
        break;
      }
      case "outlineShapes":
        result = JSON.parse(outlineShapes(args[0] as string, args[1] as string, args[2] as number, (args[3] as number) ?? 0, !!args[4], (args[5] as number) ?? 0));
        break;
      case "booleanShapes":
        result = JSON.parse(booleanShapes(args[0] as string, args[1] as string, args[2] as string));
        break;
      case "shapeRegions":
        result = JSON.parse(shapeRegions(args[0] as string, args[1] as string));
        break;
      case "shapeBuild":
        result = JSON.parse(shapeBuild(args[0] as string, args[1] as string, args[2] as string, args[3] as string));
        break;
      case "convertShapes":
        result = JSON.parse(convertShapes(args[0] as string, args[1] as string, args[2] as string));
        break;
      case "formats":
        result = JSON.parse(formats());
        break;
      case "meanderTiles":
        result = JSON.parse(meanderTiles()).tiles;
        break;
      case "parsePalette":
        result = JSON.parse(parsePalette(args[0] as string));
        break;
      default:
        throw new Error(`unknown op ${op}`);
    }
    (self as unknown as Worker).postMessage({ id, ok: true, result }, transfer);
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, ok: false, error: String((err as Error)?.message ?? err) });
  }
};
