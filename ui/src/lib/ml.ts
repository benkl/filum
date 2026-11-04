// On-device AI for the digitizer. Every model is bundled with the app
// (scripts/bundle-models.mjs → public/models, public/ort, public/ocr) and runs
// locally in WebAssembly: nothing is downloaded or uploaded at run time.
//
// • MobileSAM (Zhang et al. 2023, MIT; Segment Anything, Kirillov et al.
//   2023, Apache-2.0): click an object to get its mask. The image encoder runs
//   once per image, the mask decoder per click.
// • DexiNed (Soria et al., MIT; OpenCV model zoo): a learned edge map for line
//   art and outlines.
// • Informative Drawings (Chan, Durand & Isola, CVPR 2022, MIT): a learned
//   line drawing — single lines, not both sides of an edge — for photos and
//   illustrations.
// • Tesseract (Apache-2.0): finds text so it can become real lettering.

import type * as Ort from "onnxruntime-web";
// Builds: the plain WASM runtime, which loads its engine from /ort/ (bundled)
// so its worker threads start from that file — the all-in-one bundle would be
// inlined into the app bundle, whose workers then crash ("document is not
// defined"). The dev server does not serve /public files as modules, so
// development keeps the all-in-one bundle.
const ort: typeof Ort = import.meta.env.DEV ? await import("onnxruntime-web") : await import("onnxruntime-web/wasm");
import { toBase64, type EdgeMapData, type SamPoint, type TextLine } from "./mlUtil";

export { toBase64, edgeMapImage, type EdgeMapData, type SamPoint, type TextLine } from "./mlUtil";

ort.env.wasm.wasmPaths = "/ort/";
ort.env.wasm.numThreads = typeof crossOriginIsolated !== "undefined" && crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 2) : 1;
ort.env.logLevel = "error";

const sessions = new Map<string, Promise<Ort.InferenceSession>>();
function session(url: string): Promise<Ort.InferenceSession> {
  let s = sessions.get(url);
  if (!s) {
    s = ort.InferenceSession.create(url, { executionProviders: ["wasm"], graphOptimizationLevel: "all" });
    s.catch(() => sessions.delete(url));
    sessions.set(url, s);
  }
  return s;
}

/** Decode image bytes to a bitmap. */
export async function bitmapOf(bytes: Uint8Array): Promise<ImageBitmap> {
  return createImageBitmap(new Blob([bytes as BlobPart]));
}

function canvasOf(w: number, h: number) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c.getContext("2d", { willReadFrequently: true })!;
}


// ---------------------------------------------------------------------------
// Segmentation (MobileSAM)

export interface SamImage {
  /** Working frame (long side 1024): click coordinates and masks use it. */
  w: number;
  h: number;
  embedding: Ort.Tensor;
}

/** Encode an image (about 1–4 s, once per image). */
export async function samEncode(bmp: ImageBitmap): Promise<SamImage> {
  const k = 1024 / Math.max(bmp.width, bmp.height);
  const w = Math.max(1, Math.round(bmp.width * k));
  const h = Math.max(1, Math.round(bmp.height * k));
  const g = canvasOf(w, h);
  g.drawImage(bmp, 0, 0, w, h);
  const px = g.getImageData(0, 0, w, h).data;
  const input = new Float32Array(w * h * 3);
  for (let i = 0, j = 0; i < px.length; i += 4, j += 3) {
    input[j] = px[i];
    input[j + 1] = px[i + 1];
    input[j + 2] = px[i + 2];
  }
  const enc = await session("/models/mobile-sam/encoder.onnx");
  const out = await enc.run({ input_image: new ort.Tensor("float32", input, [h, w, 3]) });
  return { w, h, embedding: out.image_embeddings };
}


/** Mask (0 / 255 per working-frame pixel) for the clicked points. */
export async function samMask(img: SamImage, points: SamPoint[]): Promise<Uint8Array> {
  const dec = await session("/models/mobile-sam/decoder.onnx");
  const n = points.length + 1;
  const coords = new Float32Array(n * 2);
  const labels = new Float32Array(n);
  points.forEach((p, i) => {
    coords[i * 2] = p.x;
    coords[i * 2 + 1] = p.y;
    labels[i] = p.label;
  });
  // padding point (no box prompt)
  labels[n - 1] = -1;
  const out = await dec.run({
    image_embeddings: img.embedding,
    point_coords: new ort.Tensor("float32", coords, [1, n, 2]),
    point_labels: new ort.Tensor("float32", labels, [1, n]),
    mask_input: new ort.Tensor("float32", new Float32Array(256 * 256), [1, 1, 256, 256]),
    has_mask_input: new ort.Tensor("float32", new Float32Array([0]), [1]),
    orig_im_size: new ort.Tensor("float32", new Float32Array([img.h, img.w]), [2]),
  });
  const logits = out.masks.data as Float32Array;
  const m = new Uint8Array(img.w * img.h);
  for (let i = 0; i < m.length; i++) m[i] = logits[i] > 0 ? 255 : 0;
  return m;
}

// ---------------------------------------------------------------------------
// Edges (DexiNed)


/** Learned edge map (255 = strongest), 640 × 480, base64: the engine stretches it over the image. */
export async function detectEdges(bmp: ImageBitmap): Promise<EdgeMapData> {
  const W = 640;
  const H = 480;
  const g = canvasOf(W, H);
  g.drawImage(bmp, 0, 0, W, H);
  const px = g.getImageData(0, 0, W, H).data;
  // OpenCV blobFromImage: BGR, mean subtracted, NCHW
  const input = new Float32Array(3 * W * H);
  const mean = [103.5, 116.2, 123.6];
  for (let i = 0; i < W * H; i++) {
    input[i] = px[i * 4 + 2] - mean[0];
    input[W * H + i] = px[i * 4 + 1] - mean[1];
    input[2 * W * H + i] = px[i * 4] - mean[2];
  }
  const s = await session("/models/dexined/dexined.onnx");
  const out = await s.run({ img: new ort.Tensor("float32", input, [1, 3, H, W]) });
  const fused = out.block_cat.data as Float32Array;
  let lo = Infinity;
  let hi = -Infinity;
  const sig = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) {
    const v = 1 / (1 + Math.exp(-fused[i]));
    sig[i] = v;
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
  }
  const bytes = new Uint8Array(W * H);
  const k = 255 / Math.max(1e-6, hi - lo);
  for (let i = 0; i < W * H; i++) bytes[i] = Math.round((sig[i] - lo) * k);
  return { width: W, height: H, data: toBase64(bytes) };
}


// ---------------------------------------------------------------------------
// Line drawing (Informative Drawings)

/**
 * A learned line drawing of the picture as an edge map (255 = line), long
 * side 640: the engine vectorises it like line art.
 */
export async function drawLines(bmp: ImageBitmap): Promise<EdgeMapData> {
  const k = 640 / Math.max(bmp.width, bmp.height);
  // the network downsamples by 4 twice: sizes in multiples of 8
  const W = Math.max(8, Math.round((bmp.width * k) / 8) * 8);
  const H = Math.max(8, Math.round((bmp.height * k) / 8) * 8);
  const g = canvasOf(W, H);
  g.fillStyle = "#fff";
  g.fillRect(0, 0, W, H);
  g.drawImage(bmp, 0, 0, W, H);
  const px = g.getImageData(0, 0, W, H).data;
  const input = new Float32Array(3 * W * H);
  for (let i = 0; i < W * H; i++) {
    input[i] = px[i * 4] / 255;
    input[W * H + i] = px[i * 4 + 1] / 255;
    input[2 * W * H + i] = px[i * 4 + 2] / 255;
  }
  const s = await session("/models/informative-drawings/model.onnx");
  const out = await s.run({ input: new ort.Tensor("float32", input, [1, 3, H, W]) });
  const t = out.output;
  const [oh, ow] = [t.dims[2], t.dims[3]];
  const d = t.data as Float32Array;
  // dark lines on white → line strength
  const bytes = new Uint8Array(ow * oh);
  for (let i = 0; i < ow * oh; i++) bytes[i] = Math.round(255 * Math.min(1, Math.max(0, 1 - d[i])));
  return { width: ow, height: oh, data: toBase64(bytes) };
}


// ---------------------------------------------------------------------------
// Text (Tesseract)


/** Recognise text lines (English) in the image. */
export async function findText(bytes: Uint8Array): Promise<TextLine[]> {
  const { createWorker } = await import("tesseract.js");
  const worker = await createWorker("eng", 1, {
    workerPath: "/ocr/worker.min.js",
    corePath: "/ocr/core",
    langPath: "/ocr",
    gzip: true,
    workerBlobURL: false,
  });
  try {
    const { data } = await worker.recognize(new Blob([bytes as BlobPart]), {}, { blocks: true });
    const lines: TextLine[] = [];
    for (const b of data.blocks ?? [])
      for (const p of b.paragraphs)
        for (const l of p.lines) {
          const text = l.text.trim();
          if (text.length >= 2 && l.confidence >= 60 && /[\p{L}\p{N}]/u.test(text)) lines.push({ text, confidence: l.confidence, bbox: l.bbox });
        }
    return lines;
  } finally {
    await worker.terminate();
  }
}
