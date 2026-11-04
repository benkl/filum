// Bundle the Ink/Stitch embroidery-fonts collection into ui/public/embroidery-fonts.
//
//   git clone --depth 1 https://github.com/inkstitch/embroidery-fonts
//   node ui/scripts/bundle-fonts.mjs <path-to>/embroidery-fonts/src
//
// Every font keeps its licence and preview. Glyph layers are extracted from the
// Inkscape files of the font's variants (the default variant, then the other
// directions as "<variant>-glyphs-N"; one file or a directory of
// files), editor-only data is stripped (ids, sodipodi/inkscape attributes,
// metadata, command symbols and connectors, unused style properties),
// coordinates are rounded to 0.001 px, metrics go to font.json.gz, and each
// source file becomes one gzipped JSON chunk ({ glyph name: SVG fragment })
// that is loaded on demand.
// Positions follow Ink/Stitch: glyph coordinates are px (page scale and
// ancestor transforms are baked into a wrapper group), the baseline comes from
// the "baseline" guide (measured from the bottom of the page) or is null when
// the font has none (the app then derives it from a capital letter).
//
// Fonts whose licence does not allow redistribution in a product anyone may
// sell (non-commercial licences) are not bundled: they are listed in
// public/downloads/nc-fonts.json with their upstream files (pinned to the
// commit of the checkout), and the app downloads and packs them on the user's
// device when they accept the licence (Preferences ▸ Downloads). Their rows in
// index.json carry `download: "nc-fonts"`.

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { VARIANTS, collectColors, extractGlyphs, fontMetrics, pruneEmpty } from "../src/lib/inkFontPack.mjs";

const src = process.argv[2];
if (!src || !fs.existsSync(src)) {
  console.error("usage: node ui/scripts/bundle-fonts.mjs <embroidery-fonts/src>");
  process.exit(1);
}
const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(here, "../public/embroidery-fonts");

function variantFiles(dir, v) {
  for (const name of v) {
    const file = path.join(dir, `${name}.svg`);
    if (fs.existsSync(file)) return [file];
    const sub = path.join(dir, name);
    if (fs.existsSync(sub) && fs.statSync(sub).isDirectory())
      return fs
        .readdirSync(sub)
        .filter((f) => f.endsWith(".svg"))
        .sort()
        .map((f) => path.join(sub, f));
  }
  return [];
}

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
let commit = "";
try {
  commit = execSync("git rev-parse HEAD", { cwd: src }).toString().trim();
} catch {
  /* not a git checkout */
}

/** May the font be shipped inside Filum? Not under a non-commercial licence. */
const redistributable = (license) => !/\bNC\b|non.?commercial/i.test(license ?? "");
const LICENSE_URLS = { "CC BY-NC-SA 4.0": "https://creativecommons.org/licenses/by-nc-sa/4.0/" };
const downloads = [];

const index = [];
let rawBytes = 0;
let outBytes = 0;
for (const id of fs.readdirSync(src).sort()) {
  const dir = path.join(src, id);
  if (!fs.statSync(dir).isDirectory() || !fs.existsSync(path.join(dir, "font.json"))) continue;
  const meta = JSON.parse(fs.readFileSync(path.join(dir, "font.json"), "utf8"));
  const wanted = String(meta.default_variant ?? "ltr");
  const order = [VARIANTS.find((v) => v.includes(wanted)) ?? VARIANTS[0], ...VARIANTS];
  let files = [];
  let variant = "ltr";
  for (const v of order) {
    files = variantFiles(dir, v);
    if (files.length) {
      variant = v[0];
      break;
    }
  }
  if (!files.length) {
    console.warn(`skip ${id}: no glyph files`);
    continue;
  }
  const license = meta.font_license ?? "SIL Open Font License v1.1";
  if (!redistributable(license)) {
    // listed for download: font.json, licence, preview and every variant's glyph files
    const rel = (f) => path.relative(src, f).split(path.sep).join("/");
    const list = [path.join(dir, "font.json")];
    for (const l of ["LICENSE", "license", "LICENSE.txt", "license.txt"])
      if (fs.existsSync(path.join(dir, l))) {
        list.push(path.join(dir, l));
        break;
      }
    if (fs.existsSync(path.join(dir, "preview.png"))) list.push(path.join(dir, "preview.png"));
    for (const v of VARIANTS) list.push(...variantFiles(dir, v));
    const name = String(meta.name ?? id);
    // glyph and colour counts for the font picker, from the default variant
    const ncColors = [];
    let ncGlyphs = 0;
    for (const f of files) {
      const { glyphs } = extractGlyphs(fs.readFileSync(f, "utf8"));
      ncGlyphs += Object.keys(glyphs).length;
      collectColors(glyphs, ncColors);
    }
    const m = fontMetrics({ name: id, ...meta });
    downloads.push({ id, name, license, files: [...new Set(list)].map((f) => [rel(f), fs.statSync(f).size]) });
    index.push({
      id,
      name,
      description: typeof meta.description === "string" ? meta.description : "",
      keywords: Array.isArray(meta.keywords) ? meta.keywords : [],
      license,
      original: meta.original_font ?? "",
      url: meta.original_font_url ?? "",
      size: m.size,
      minScale: m.min_scale,
      maxScale: m.max_scale,
      glyphs: ncGlyphs,
      colors: ncColors.length,
      direction: m.text_direction,
      preview: false,
      hasLicenseFile: false,
      download: "nc-fonts",
    });
    process.stdout.write("↓");
    continue;
  }
  const fdir = path.join(out, id);
  fs.mkdirSync(fdir, { recursive: true });
  let glyphCount = 0;
  const colors = []; // thread colours in order of first use
  // one gzipped chunk per source file; `prefix` tells the variants apart
  const pack = (list, prefix, count) => {
    const chunks = [];
    list.forEach((file, i) => {
      const text = fs.readFileSync(file, "utf8");
      rawBytes += text.length;
      const { glyphs, baseline } = extractGlyphs(text);
      for (const k of Object.keys(glyphs)) glyphs[k] = pruneEmpty(glyphs[k]);
      const names = Object.keys(glyphs);
      if (!names.length) return;
      if (count) glyphCount += names.length;
      const name = `${prefix}glyphs-${i}.json.gz`;
      const gz = zlib.gzipSync(JSON.stringify(glyphs), { level: 9 });
      outBytes += gz.length;
      fs.writeFileSync(path.join(fdir, name), gz);
      chunks.push({ file: name, baseline, glyphs: names });
      collectColors(glyphs, colors);
    });
    return chunks;
  };
  const chunks = pack(files, "", true);
  // the font's other variants (glyphs stitched in the other directions):
  // back-and-forth lines and the stitch-direction choice
  const variants = {};
  for (const v of VARIANTS) {
    if (v[0] === variant) continue;
    const more = variantFiles(dir, v);
    const c = more.length ? pack(more, `${v[0]}-`, false) : [];
    if (c.length) variants[v[0]] = c;
  }
  const font = {
    ...fontMetrics({ name: id, ...meta }),
    variant,
    colors,
    chunks,
    ...(Object.keys(variants).length ? { variants } : {}),
  };
  const fontGz = zlib.gzipSync(JSON.stringify(font), { level: 9 });
  outBytes += fontGz.length;
  fs.writeFileSync(path.join(fdir, "font.json.gz"), fontGz);
  let licenseText = "";
  for (const l of ["LICENSE", "license", "LICENSE.txt", "license.txt"])
    if (fs.existsSync(path.join(dir, l))) {
      licenseText = fs.readFileSync(path.join(dir, l), "utf8");
      fs.writeFileSync(path.join(fdir, "LICENSE"), licenseText);
      break;
    }
  const preview = fs.existsSync(path.join(dir, "preview.png"));
  if (preview) fs.copyFileSync(path.join(dir, "preview.png"), path.join(fdir, "preview.png"));
  index.push({
    id,
    name: font.name,
    description: typeof meta.description === "string" ? meta.description : "",
    keywords: Array.isArray(meta.keywords) ? meta.keywords : [],
    license,
    original: meta.original_font ?? "",
    url: meta.original_font_url ?? "",
    size: font.size,
    minScale: font.min_scale,
    maxScale: font.max_scale,
    glyphs: glyphCount,
    colors: colors.length,
    direction: font.text_direction,
    preview,
    hasLicenseFile: !!licenseText,
  });
  process.stdout.write(".");
}
fs.writeFileSync(
  path.join(out, "index.json"),
  JSON.stringify({ source: "https://github.com/inkstitch/embroidery-fonts", commit, fonts: index }, null, 0),
);
// the download pack for the fonts that can't be bundled
const dlDir = path.resolve(here, "../public/downloads");
fs.mkdirSync(dlDir, { recursive: true });
const licenses = [...new Set(downloads.map((d) => d.license))];
const ncBytes = downloads.reduce((n, d) => n + d.files.reduce((m, f) => m + f[1], 0), 0);
fs.writeFileSync(
  path.join(dlDir, "nc-fonts.json"),
  JSON.stringify(
    {
      id: "nc-fonts",
      kind: "fonts",
      title: "Non-commercial embroidery fonts",
      summary: `${downloads.length} more fonts from the Ink/Stitch community collection (${downloads.map((d) => d.name).join(", ")}). Their authors allow only non-commercial use, so Filum doesn't include them.`,
      license: {
        name: licenses.join(" / "),
        url: LICENSE_URLS[licenses[0]] ?? "https://github.com/inkstitch/embroidery-fonts",
        terms: "Free for personal and other non-commercial use. Give the font's author credit and share changes to the font under the same licence. Designs stitched with these fonts may not be sold or used commercially.",
      },
      source: { label: "inkstitch/embroidery-fonts", url: `https://github.com/inkstitch/embroidery-fonts/tree/${commit}/src` },
      base: `https://raw.githubusercontent.com/inkstitch/embroidery-fonts/${commit}/src/`,
      version: commit,
      bytes: ncBytes,
      items: downloads,
    },
    null,
    1,
  ) + "\n",
);
console.log(`\n${downloads.length} fonts listed for download (${(ncBytes / 1e6).toFixed(1)} MB) → public/downloads/nc-fonts.json`);
console.log(`\n${index.length} fonts · glyph SVG ${(rawBytes / 1e6).toFixed(1)} MB → ${(outBytes / 1e6).toFixed(1)} MB`);
