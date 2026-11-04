// Bundle the digitizer's AI models and their runtimes into ui/public, so the
// app works offline and never downloads models at run time:
//
//   public/models/mobile-sam/   MobileSAM image encoder + SAM mask decoder (ONNX, MIT / Apache-2.0)
//   public/models/dexined/      DexiNed edge detector (ONNX, MIT, OpenCV model zoo;
//                               re-quantized at build time so ONNX Runtime can run it)
//   public/models/informative-drawings/  Informative Drawings line-art generator
//                               (Chan, Durand, Isola 2022; ONNX export by J. Rocca; MIT)
//   public/ocr/                 Tesseract worker + core (WASM) + English LSTM data (Apache-2.0)
//   public/ort/                 ONNX Runtime Web WASM binaries (MIT)
//
// Runs before every build (npm run build) and can be run alone
// (npm run models). Downloads are cached: files with the expected size are
// kept. The model files are not committed to git.

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { fixQuantizedModel } from "./fix-onnx.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ui = path.resolve(here, "..");
const pub = path.join(ui, "public");
// raw downloads that are converted before shipping
const cache = path.join(ui, ".model-cache");

const HF = "https://huggingface.co";
const MODELS = [
  {
    dir: "models/mobile-sam",
    files: [
      { name: "encoder.onnx", url: `${HF}/Acly/MobileSAM/resolve/main/mobile_sam_image_encoder.onnx`, size: 28157093 },
      { name: "decoder.onnx", url: `${HF}/Acly/MobileSAM/resolve/main/sam_mask_decoder_single.onnx`, size: 16501323 },
      { name: "README.md", url: `${HF}/Acly/MobileSAM/raw/main/README.md` },
    ],
  },
  {
    dir: "models/dexined",
    files: [
      { name: "dexined-opencv.onnx", url: `${HF}/opencv/edge_detection_dexined/resolve/main/edge_detection_dexined_2024sep.onnx`, size: 47235563, cache: true },
      { name: "LICENSE", url: `${HF}/opencv/edge_detection_dexined/raw/main/LICENSE` },
    ],
  },
  {
    dir: "models/informative-drawings",
    files: [
      { name: "model.onnx", url: `${HF}/rocca/informative-drawings-line-art-onnx/resolve/main/model.onnx`, size: 17193338 },
      { name: "LICENSE", url: "https://raw.githubusercontent.com/carolineec/informative-drawings/main/LICENSE" },
    ],
  },
  {
    dir: "ocr",
    files: [
      { name: "eng.traineddata.gz", url: "https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng@1.0.0/4.0.0_best_int/eng.traineddata.gz" },
    ],
  },
];

async function download(url, dest, size) {
  if (fs.existsSync(dest) && (!size || fs.statSync(dest).size === size)) return false;
  process.stdout.write(`  ↓ ${path.relative(pub, dest)} … `);
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (size && buf.length !== size) throw new Error(`${url}: expected ${size} bytes, got ${buf.length}`);
  fs.writeFileSync(dest, buf);
  console.log(`${(buf.length / 1e6).toFixed(1)} MB`);
  return true;
}

function copy(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  if (!fs.existsSync(to) || fs.statSync(to).size !== fs.statSync(from).size) fs.copyFileSync(from, to);
}

console.log("Bundling digitizer models →", pub);
for (const m of MODELS) {
  const dir = path.join(pub, m.dir);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of m.files) {
    const dest = f.cache ? path.join(cache, f.name) : path.join(dir, f.name);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    await download(f.url, dest, f.size);
  }
}
// DexiNed: OpenCV-only quantization layout → standard int8 per channel
const dexOut = path.join(pub, "models/dexined/dexined.onnx");
const dexIn = path.join(cache, "dexined-opencv.onnx");
if (!fs.existsSync(dexOut) || fs.statSync(dexOut).mtimeMs < fs.statSync(dexIn).mtimeMs) {
  process.stdout.write("  ⚙ re-quantizing DexiNed … ");
  console.log(`${fixQuantizedModel(dexIn, dexOut)} tensors, ${(fs.statSync(dexOut).size / 1e6).toFixed(1)} MB`);
}

// ONNX Runtime Web: the WASM backends (plain and SIMD-threaded)
const ortDist = path.join(ui, "node_modules/onnxruntime-web/dist");
for (const f of fs.readdirSync(ortDist).filter((f) => /^ort-wasm.*\.(wasm|mjs)$/.test(f) && !f.includes("jsep"))) copy(path.join(ortDist, f), path.join(pub, "ort", f));

// Tesseract: worker script and WASM cores
copy(path.join(ui, "node_modules/tesseract.js/dist/worker.min.js"), path.join(pub, "ocr/worker.min.js"));
const core = path.join(ui, "node_modules/tesseract.js-core");
for (const f of fs.readdirSync(core).filter((f) => /^tesseract-core.*\.(js|wasm)$/.test(f))) copy(path.join(core, f), path.join(pub, "ocr/core", f));
// tesseract.js loads the language as eng.traineddata.gz; keep a check it is valid gzip
zlib.gunzipSync(fs.readFileSync(path.join(pub, "ocr/eng.traineddata.gz"))).length;

const total = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).reduce((a, e) => a + (e.isDirectory() ? total(path.join(dir, e.name)) : fs.statSync(path.join(dir, e.name)).size), 0);
console.log(`Models and runtimes: ${(["models", "ort", "ocr"].reduce((a, d) => a + total(path.join(pub, d)), 0) / 1e6).toFixed(1)} MB`);
