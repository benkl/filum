// Collect the licences of everything Filum ships into
// ui/public/licenses/third-party.json (shown in Help → Licences).
//
//   node ui/scripts/gen-licenses.mjs
//
//  • npm: the production dependency tree of ui/package.json (type-only
//    @types/* packages are skipped), with each package's licence file.
//  • Rust: every crate compiled into the WebAssembly engine, the CLI or the
//    desktop app (normal dependencies, all target platforms), with its
//    licence files from the cargo registry.
//  • Fonts and ported code / data, with their licence texts.
// Embroidery-font licences are read from public/embroidery-fonts at runtime.
// Identical licence texts are stored once.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ui = path.resolve(here, "..");
const root = path.resolve(ui, "..");
const outDir = path.join(ui, "public", "licenses");

const texts = {};
const addText = (t) => {
  if (!t || !t.trim()) return null;
  const norm = t.replace(/\r\n/g, "\n").trim();
  const id = crypto.createHash("sha1").update(norm).digest("hex").slice(0, 12);
  texts[id] = norm;
  return id;
};
const LICENSE_FILE = /^(licen[cs]e|copying|notice|unlicense)([-._].*)?$/i;
function licenseFiles(dir) {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => LICENSE_FILE.test(f) && fs.statSync(path.join(dir, f)).isFile())
      .sort()
      .map((f) => ({ file: f, text: addText(fs.readFileSync(path.join(dir, f), "utf8")) }))
      .filter((x) => x.text);
  } catch {
    return [];
  }
}
const repoUrl = (r) => {
  const u = typeof r === "string" ? r : r?.url;
  return u ? u.replace(/^git\+/, "").replace(/\.git$/, "").replace(/^git:\/\//, "https://") : "";
};

// ---------------------------------------------------------------------------
// npm

function npmPackages() {
  const seen = new Map();
  const pkgJson = (dir) => JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  const resolve = (name, from) => {
    // walk up node_modules folders like Node's resolver
    let dir = from;
    for (;;) {
      const cand = path.join(dir, "node_modules", name);
      if (fs.existsSync(path.join(cand, "package.json"))) return cand;
      const up = path.dirname(dir);
      if (up === dir) return null;
      dir = up;
    }
  };
  const visit = (name, from) => {
    if (name.startsWith("@types/")) return;
    const dir = resolve(name, from);
    if (!dir) return;
    const p = pkgJson(dir);
    const key = `${p.name}@${p.version}`;
    if (seen.has(key)) return;
    const license = typeof p.license === "string" ? p.license : p.license?.type ?? (p.licenses ?? []).map((l) => l.type).join(" OR ");
    seen.set(key, {
      name: p.name,
      version: p.version,
      license: license || "see licence file",
      author: typeof p.author === "string" ? p.author : p.author?.name ?? "",
      url: p.homepage || repoUrl(p.repository),
      files: licenseFiles(dir),
    });
    for (const dep of Object.keys({ ...p.dependencies, ...p.optionalDependencies })) visit(dep, dir);
  };
  const top = pkgJson(ui);
  for (const dep of Object.keys(top.dependencies ?? {})) visit(dep, ui);
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// Rust

function cargoBin() {
  if (process.env.CARGO) return process.env.CARGO;
  const home = path.join(os.homedir(), ".cargo", "bin", process.platform === "win32" ? "cargo.exe" : "cargo");
  return fs.existsSync(home) ? home : "cargo";
}

function cargoPackages() {
  const meta = JSON.parse(
    execFileSync(cargoBin(), ["metadata", "--format-version", "1", "--locked"], { cwd: root, maxBuffer: 1 << 28 }).toString(),
  );
  const byId = new Map(meta.packages.map((p) => [p.id, p]));
  const nodes = new Map(meta.resolve.nodes.map((n) => [n.id, n]));
  const shipped = new Set();
  const stack = [...meta.workspace_members];
  while (stack.length) {
    const id = stack.pop();
    if (shipped.has(id)) continue;
    shipped.add(id);
    for (const d of nodes.get(id)?.deps ?? []) {
      // normal dependencies only (build scripts and dev-dependencies are not shipped)
      if (d.dep_kinds.some((k) => k.kind === null)) stack.push(d.pkg);
    }
  }
  const members = new Set(meta.workspace_members);
  return [...shipped]
    .filter((id) => !members.has(id))
    .map((id) => byId.get(id))
    .map((p) => ({
      name: p.name,
      version: p.version,
      license: p.license ?? (p.license_file ? "see licence file" : "unknown"),
      author: (p.authors ?? []).join(", "),
      url: p.repository || p.homepage || `https://crates.io/crates/${p.name}`,
      files: licenseFiles(path.dirname(p.manifest_path)),
    }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

// ---------------------------------------------------------------------------
// Fonts, ported code and data

const read = (p) => fs.readFileSync(p, "utf8");
const outlineFonts = [
  ["Nunito", "nunito-OFL.txt", "https://github.com/googlefonts/nunito"],
  ["Bebas Neue", "bebasneue-OFL.txt", "https://github.com/dharmatype/Bebas-Neue"],
  ["Pacifico", "pacifico-OFL.txt", "https://github.com/googlefonts/Pacifico"],
].map(([name, file, url]) => ({
  name,
  version: "",
  license: "OFL-1.1",
  author: read(path.join(ui, "public", "fonts", file)).split("\n")[0].trim(),
  url,
  files: [{ file, text: addText(read(path.join(ui, "public", "fonts", file))) }],
}));

async function fetchText(url) {
  try {
    const r = await fetch(url);
    return r.ok ? await r.text() : "";
  } catch {
    return "";
  }
}
const gpl = addText(read(path.join(root, "LICENSE")));
const pystitchLicense = await fetchText("https://raw.githubusercontent.com/inkstitch/pystitch/main/LICENSE");
const mit = (who) => `MIT License

Copyright (c) ${who}

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.`;
const apache = await fetchText("https://www.apache.org/licenses/LICENSE-2.0.txt");
const models = [
  {
    name: "MobileSAM (ONNX)",
    version: "Acly/MobileSAM",
    license: "MIT AND Apache-2.0",
    author: "Chaoning Zhang et al. (MobileSAM); Meta AI (Segment Anything); ONNX export by Acly",
    url: "https://github.com/ChaoningZhang/MobileSAM",
    note: "Bundled segmentation model: click objects in the digitizer to keep, remove or separate them. Runs on the device (ONNX Runtime Web).",
    files: [{ file: "LICENSE (MobileSAM ONNX, MIT)", text: addText(mit("2023 Chaoning Zhang")) }, ...(apache ? [{ file: "LICENSE (Segment Anything, Apache-2.0)", text: addText(apache) }] : [])],
  },
  {
    name: "DexiNed (ONNX)",
    version: "2024sep",
    license: "MIT",
    author: "Xavier Soria Poma; OpenCV model zoo",
    url: "https://github.com/xavysp/DexiNed",
    note: "Bundled edge detection model for line art in the digitizer.",
    files: [{ file: "LICENSE", text: addText(mit("2019 Xavier Soria Poma")) }],
  },
  {
    name: "Informative Drawings (ONNX)",
    version: "rocca/informative-drawings-line-art-onnx",
    license: "MIT",
    author: "Caroline Chan, Frédo Durand, Phillip Isola (Learning to generate line drawings that convey geometry and semantics, CVPR 2022); ONNX export by Joseph Rocca",
    url: "https://github.com/carolineec/informative-drawings",
    note: "Bundled line-drawing model: turns photos and illustrations into line art for the digitizer. Runs on the device (ONNX Runtime Web).",
    files: [{ file: "LICENSE", text: addText(mit("2022 Caroline Chan")) }],
  },
  {
    name: "Tesseract OCR + English data",
    version: "tesseract.js 5, tessdata 4.0.0_best_int",
    license: "Apache-2.0",
    author: "Tesseract contributors; tesseract.js contributors",
    url: "https://github.com/tesseract-ocr/tesseract",
    note: "Bundled text recognition: text in a picture becomes real embroidery lettering.",
    files: apache ? [{ file: "LICENSE", text: addText(apache) }] : [],
  },
  {
    name: "Research the digitizer builds on",
    version: "",
    license: "algorithms (no code)",
    author: "",
    url: "https://www.cs.ubc.ca/labs/imager/tr/2018/PerceptionDrivenVectorization/",
    note: "Hoshyari et al., Perception-Driven Semi-Structured Boundary Vectorization (SIGGRAPH 2018); Kopf & Lischinski, Depixelizing Pixel Art (SIGGRAPH 2011); Kang, Lee & Chui, Coherent Line Drawing / Flow-Based Image Abstraction (NPAR 2007, TVCG 2009); Du et al., Image Vectorization via Linear Gradient Layer Decomposition (SIGGRAPH 2023); Liu et al., Directionality-Aware Design of Embroidery Patterns (CGF 2023); Jobard & Lefer, Evenly-Spaced Streamlines (1997); Noris et al., Topology-Driven Vectorization of Clean Line Drawings (TOG 2013) and Favreau et al., Fidelity vs. Simplicity (SIGGRAPH 2016) for the line strokes; Steger, An Unbiased Detector of Curvilinear Structures (TPAMI 1998) for sub-pixel line centres; VTracer (MIT) for the shared-boundary idea.",
    files: [],
  },
];
const ported = [
  ...models,
  {
    name: "Ink/Stitch",
    version: "",
    license: "GPL-3.0-or-later",
    author: "Ink/Stitch authors",
    url: "https://github.com/inkstitch/inkstitch",
    note: "Stitch algorithms (running, ripple, satin, tatami, contour, meander, guided and circular fills, underlay, lettering layout) and the SVG parameter dialect with commands and markers are ported from Ink/Stitch. Bundled resources: 75 thread charts (palettes/), 75 meander tiles (tiles/), command symbols and markers (symbols/) and the embroidery fonts whose licences allow it (the non-commercial ones are an optional download, Preferences ▸ Downloads).",
    files: [{ file: "LICENSE", text: gpl }],
  },
  {
    name: "Madeira Cotona colour charts",
    version: "",
    license: "colours sampled from published colour cards",
    author: "Madeira Garnfabrik; Madeira USA / Quilting Thread",
    url: "https://garne.madeira.de/fileadmin/user_upload/home/Farbkarten_2024/Colour_Card_COTONA.pdf",
    note: "Madeira Cotona 50 / 30 / 80 charts (120 colours) sampled from Madeira's Cotona colour card and the Madeira USA Cotona colour card by scripts/bundle-cotona.mjs. Screen colours are approximate; Madeira and Cotona are trademarks of Madeira Garnfabrik.",
    files: [],
  },
  {
    name: "Embroidery Nerds thread charts",
    version: "",
    license: "none stated · not included",
    author: "Matthew Enderle, The Embroidery Nerds, LLC",
    url: "https://github.com/Matthewenderle/Embroidery-Thread-Palette-Converter",
    note: "164 thread charts (corel-swatches, from the embroiderynerd.io thread database). No licence is stated, so they are not included: Preferences ▸ Downloads fetches them from the author's repository and converts them to .gpl on the user's device. Thread names may be trademarks of their owners and are used for description only.",
    files: [],
  },
  {
    name: "pystitch (Ink/Stitch)",
    version: "",
    license: "MIT",
    author: "Tatarize and contributors",
    url: "https://github.com/inkstitch/pystitch",
    note: "Embroidery file encoders and decoders (DST, PES, PEC, JEF, EXP, VP3, XXX, U01, TBF, SEW, HUS and the other pystitch formats, CSV, TXT, G-code, COL/EDR/INF) are ported from pystitch, the file library Ink/Stitch writes machine files with (a fork of pyembroidery by Tatarize).",
    files: pystitchLicense ? [{ file: "LICENSE", text: addText(pystitchLicense) }] : [],
  },
];

const npm = npmPackages();
const cargo = cargoPackages();

// Packages that ship no licence file get the standard SPDX texts of their
// declared licences (with the authors as copyright holders).
const spdx = new Map();
for (const p of [...npm, ...cargo].filter((x) => !x.files.length)) {
  const ids = [...new Set(p.license.split(/\s+OR\s+|\s+AND\s+|\/|[()]/).map((s) => s.trim()).filter(Boolean))];
  for (const id of ids) {
    if (!spdx.has(id)) spdx.set(id, await fetchText(`https://raw.githubusercontent.com/spdx/license-list-data/main/text/${id}.txt`));
    const text = spdx.get(id);
    if (!text) continue;
    const header = p.author ? `Copyright (c) ${p.author}\n\n` : "";
    p.files.push({ file: `${id} (standard text)`, text: addText(header + text) });
  }
}
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(
  path.join(outDir, "third-party.json"),
  JSON.stringify({ generated: new Date().toISOString().slice(0, 10), app: { license: "GPL-3.0-or-later", text: gpl }, ported, fonts: outlineFonts, npm, cargo, texts }),
);
console.log(`${npm.length} npm packages, ${cargo.length} crates, ${Object.keys(texts).length} distinct licence texts`);
const missing = [...npm, ...cargo].filter((p) => !p.files.length).map((p) => `${p.name}@${p.version} (${p.license})`);
if (missing.length) console.log(`no licence file shipped by: ${missing.join(", ")}`);
