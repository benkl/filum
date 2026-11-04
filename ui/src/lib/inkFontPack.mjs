// Ink/Stitch embroidery font packing: glyph layers extracted from the
// Inkscape files of a font (GlyphLayer-<char> groups), editor-only data
// stripped, coordinates rounded, metrics collected. Shared by the bundling
// script (scripts/bundle-fonts.mjs, the bundled collection) and the app
// (importing a font folder). Plain JS so both Node and the browser load it.

export const VARIANTS = [
  ["ltr", "→"],
  ["rtl", "←"],
  ["ttb", "↓"],
  ["btt", "↑"],
];
export const PX_PER = { px: 1, mm: 96 / 25.4, cm: 96 / 2.54, in: 96, pt: 96 / 72, pc: 16, q: 96 / 101.6 };

export const round = (v, k = 1000) => {
  const r = Math.round(v * k) / k;
  return Object.is(r, -0) ? 0 : r;
};
const roundNums = (s) => s.replace(/-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi, (m) => String(round(parseFloat(m))));
const decode = (s) =>
  s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

function attrs(tagBody) {
  const m = new Map();
  for (const a of tagBody.matchAll(/([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) m.set(a[1], a[3] ?? a[4]);
  return m;
}
const len = (v) => {
  const m = /^\s*(-?[\d.]+(?:e[-+]?\d+)?)\s*([a-z%]*)\s*$/i.exec(v ?? "");
  if (!m) return null;
  return { v: parseFloat(m[1]), unit: m[2].toLowerCase() || "px" };
};

/**
 * Page transform from user units to px (viewBox → width/height). Fonts drawn
 * in mm or inch documents are scaled to px like everything else.
 */
function viewport(root) {
  const vb = (root.get("viewBox") ?? "").trim().split(/[\s,]+/).map(Number);
  if (vb.length !== 4 || !vb[2] || !vb[3]) return { s: 1, tx: 0, ty: 0 };
  const px = (v, fallback) => {
    const l = len(v);
    return !l || l.unit === "%" ? fallback : l.v * (PX_PER[l.unit] ?? 1);
  };
  const s = Math.min(px(root.get("width"), vb[2]) / vb[2], px(root.get("height"), vb[3]) / vb[3]);
  return { s, tx: -vb[0] * s, ty: -vb[1] * s };
}

function pageHeightUU(root) {
  const vb = (root.get("viewBox") ?? "").trim().split(/[\s,]+/).map(Number);
  if (vb.length === 4 && vb[3]) return vb[3];
  const h = len(root.get("height"));
  return h && h.unit !== "%" ? h.v * (PX_PER[h.unit] ?? 1) : null; // unknown page height
}

const KEEP_STYLE = new Set(["fill", "stroke", "stroke-width", "display", "visibility"]);
function cleanStyle(s) {
  const kept = s
    .split(";")
    .map((d) => d.split(":").map((x) => x.trim()))
    .filter(([k, v]) => k && v !== undefined && KEEP_STYLE.has(k))
    .map(([k, v]) => `${k}:${k === "stroke-width" ? roundNums(v) : v}`);
  return kept.join(";");
}

/** Minify one element's attribute list. */
function cleanAttrs(tag, body, isGlyphRoot) {
  const out = [];
  for (const a of body.matchAll(/([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) {
    const name = a[1];
    let v = a[3] ?? a[4];
    if (name === "id" || name === "class" || name === "xml:space" || name === "clip-path" || name === "mask") continue;
    if (name.startsWith("sodipodi:") || name.startsWith("inkscape:") || name.startsWith("xmlns")) continue;
    if (name === "style") {
      v = cleanStyle(v);
      if (isGlyphRoot) v = v.replace(/(^|;)display:[^;]*/g, "").replace(/^;|;$/g, "");
      if (!v) continue;
    }
    if (isGlyphRoot && name === "display") continue;
    if (name === "d" || name === "transform" || name === "points") v = roundNums(v).replace(/\s+/g, " ").trim();
    else if (/^(x|y|x1|x2|y1|y2|cx|cy|r|rx|ry|width|height|stroke-width)$/.test(name)) v = roundNums(v);
    out.push(`${name}="${v.replace(/"/g, "&quot;")}"`);
  }
  return out.length ? " " + out.join(" ") : "";
}

const DROP = new Set(["metadata", "title", "desc", "defs", "sodipodi:namedview", "use", "clipPath", "mask", "style", "script"]);
const TOKEN = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[\s\S]*?>|<(\/?)([\w:.-]+)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>|([^<]+)/g;

/** Extract and minify all GlyphLayer groups of one Inkscape file. */
export function extractGlyphs(text) {
  const glyphs = {};
  let root = null;
  let baselineGuide = null;
  const stack = []; // { tag, transform }
  let dropDepth = 0; // inside a dropped element
  let glyph = null; // { name, depth, parts, wrap }
  let page = null; // viewport transform as an SVG matrix
  for (const m of text.matchAll(TOKEN)) {
    const [whole, close, tag, body = "", selfClose, textNode] = m;
    if (textNode !== undefined || !tag) continue; // comments, text, PIs
    if (tag === "sodipodi:guide" && !close) {
      const a = attrs(body);
      if (a.get("inkscape:label") === "baseline" && baselineGuide === null) baselineGuide = a.get("position");
    }
    if (close) {
      const top = stack.pop();
      if (dropDepth) {
        if (stack.length < dropDepth) dropDepth = 0;
        continue;
      }
      if (glyph) {
        if (stack.length < glyph.depth) {
          glyph.parts.push("</g>");
          const inner = glyph.parts.join("");
          glyphs[glyph.name] = glyph.wrap.length ? `<g transform="${glyph.wrap.join(" ")}">${inner}</g>` : inner;
          glyph = null;
        } else glyph.parts.push(`</${top.tag}>`);
      }
      continue;
    }
    const a = attrs(body);
    if (tag === "svg" && !root) {
      root = a;
      const v = viewport(root);
      page = Math.abs(v.s - 1) > 1e-9 || v.tx || v.ty ? `matrix(${round(v.s, 1e6)} 0 0 ${round(v.s, 1e6)} ${round(v.tx)} ${round(v.ty)})` : null;
      stack.push({ tag, transform: null });
      continue;
    }
    if (dropDepth) {
      if (!selfClose) stack.push({ tag, transform: null });
      continue;
    }
    const label = a.get("inkscape:label") ?? "";
    const isConnector = a.has("inkscape:connection-start") || a.has("inkscape:connector-type");
    if (DROP.has(tag) || isConnector) {
      if (!selfClose) {
        stack.push({ tag, transform: null });
        dropDepth = stack.length;
      }
      continue;
    }
    if (!glyph && tag === "g" && label.startsWith("GlyphLayer-") && !selfClose) {
      const name = decode(label.slice("GlyphLayer-".length)).normalize("NFC");
      stack.push({ tag, transform: a.get("transform") ?? null });
      const wrap = [page, ...stack.slice(1, -1).map((s) => s.transform)]
        .filter(Boolean)
        .map((t) => roundNums(t).replace(/\s+/g, " ").trim());
      glyph = { name, depth: stack.length, parts: [`<g${cleanAttrs(tag, body, true)}>`], wrap };
      continue;
    }
    if (!selfClose) stack.push({ tag, transform: a.get("transform") ?? null });
    if (glyph) glyph.parts.push(`<${tag}${cleanAttrs(tag, body, false)}${selfClose ? "/" : ""}>`);
  }
  if (!root) throw new Error("no <svg> root");
  // Inkscape guides are measured from the bottom of the page in user units;
  // without a "baseline" guide the loader derives one from a capital letter
  let baseline = null;
  const pageH = pageHeightUU(root);
  if (baselineGuide && pageH !== null) {
    const y = parseFloat(baselineGuide.split(/[\s,]+/)[1]);
    const v = viewport(root);
    baseline = round((pageH - y) * v.s + v.ty);
  }
  return { glyphs, baseline };
}

/** Drop empty groups produced by stripping. */
export const pruneEmpty = (s) => {
  let prev;
  do {
    prev = s;
    s = s.replace(/<g(?:\s[^>]*)?><\/g>/g, "");
  } while (s !== prev);
  return s;
};

export const roundMap = (m, keepZero) => {
  const o = {};
  for (const [k, v] of Object.entries(m ?? {})) {
    const r = round(Number(v), 100);
    if (Number.isFinite(r) && (keepZero || r !== 0)) o[k.normalize("NFC")] = r;
  }
  return o;
};

/**
 * Thread colours of glyph fragments (#rrggbb), added to `colors` in order
 * of first use.
 */
export function collectColors(glyphs, colors) {
  for (const frag of Object.values(glyphs))
    for (const m of frag.matchAll(/(?:fill|stroke)(?::|=")\s*(#[0-9a-f]{6}|#[0-9a-f]{3})\b/gi)) {
      let c = m[1].toLowerCase();
      if (c.length === 4) c = "#" + [...c.slice(1)].map((h) => h + h).join("");
      if (!colors.includes(c)) colors.push(c);
    }
  return colors;
}

/** Glyph chunks of one variant's Inkscape files (text); `prefix` names the chunk files. */
function packFiles(files, prefix, data, colors) {
  const chunks = [];
  files.forEach((text, i) => {
    const { glyphs, baseline } = extractGlyphs(text);
    for (const k of Object.keys(glyphs)) glyphs[k] = pruneEmpty(glyphs[k]);
    const names = Object.keys(glyphs);
    if (!names.length) return;
    const file = `${prefix}glyphs-${i}.json`;
    data[file] = glyphs;
    chunks.push({ file, baseline, glyphs: names });
    collectColors(glyphs, colors);
  });
  return chunks;
}

/**
 * The font record's metrics from Ink/Stitch's font.json, with Ink/Stitch's
 * defaults. Also applied again when the font info of an installed font is
 * edited.
 */
export function fontMetrics(meta) {
  const pick = (k, d) => (meta[k] === undefined || meta[k] === "" ? d : meta[k]);
  return {
    name: pick("name", "Font"),
    size: pick("size", 20),
    leading: pick("leading", 100),
    horiz_adv_x_space: pick("horiz_adv_x_space", 20),
    horiz_adv_x_default: pick("horiz_adv_x_default", null),
    horiz_adv_x: roundMap(meta.horiz_adv_x, true),
    kerning_pairs: roundMap(meta.kerning_pairs, false),
    letter_case: pick("letter_case", ""),
    default_glyph: pick("default_glyph", "�"),
    text_direction: pick("text_direction", "ltr"),
    min_scale: pick("min_scale", 1),
    max_scale: pick("max_scale", 1),
    reversible: pick("reversible", true),
    sortable: pick("sortable", false),
  };
}

/** Ink/Stitch's variant id ("ltr", "rtl", "ttb", "btt") of a variant or legacy arrow name. */
export const variantId = (v) => (VARIANTS.find((x) => x.includes(v)) ?? VARIANTS[0])[0];

/**
 * A font as the app stores it: font.json metadata (Ink/Stitch's) and the
 * Inkscape files of its default variant (text) → the font record and one
 * glyph chunk per file ({ glyph name: SVG fragment }). `more` holds the
 * files of the font's other variants (glyphs stitched right to left, top to
 * bottom or bottom to top), packed alongside as `variants` for back-and-forth
 * lines and the stitch-direction choice.
 */
export function buildFont(meta, files, variant = "ltr", more = {}) {
  const data = {};
  const colors = [];
  const chunks = packFiles(files, "", data, colors);
  const variants = {};
  for (const [v, texts] of Object.entries(more)) {
    const id = variantId(v);
    if (id === variant || !texts.length) continue;
    const c = packFiles(texts, `${id}-`, data, colors);
    if (c.length) variants[id] = c;
  }
  const font = { ...fontMetrics(meta), variant, colors, chunks, ...(Object.keys(variants).length ? { variants } : {}) };
  return { font, data };
}
