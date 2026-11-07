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

// what the engine's SVG import reads: colours and visibility, stroke dashes
// (running stitch in old files), Ink/Stitch markers (guide, anchor and
// pattern lines) and clips
const KEEP_STYLE = new Set(["fill", "stroke", "stroke-width", "stroke-dasharray", "display", "visibility", "marker-start", "clip-path"]);
function cleanStyle(s) {
  const kept = s
    .split(";")
    .map((d) => d.split(":").map((x) => x.trim()))
    .filter(([k, v]) => k && v !== undefined && KEEP_STYLE.has(k))
    .map(([k, v]) => `${k}:${k === "stroke-width" ? roundNums(v) : v}`);
  return kept.join(";");
}

/** Ink/Stitch command connector attributes (a command reaches its object through them). */
const CONNECTION = new Set(["inkscape:connection-start", "inkscape:connection-end"]);
const q = (v) => v.replace(/"/g, "&quot;");

/**
 * Minify one element's attribute list. Ids are kept only where something
 * refers to them (`keepIds`: command connectors, clips); a connector keeps
 * just its two ends.
 */
function cleanAttrs(tag, body, isGlyphRoot, keepIds, connector = false) {
  const out = [];
  for (const a of body.matchAll(/([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) {
    const name = a[1];
    let v = a[3] ?? a[4];
    if (connector) {
      if (CONNECTION.has(name)) out.push(`${name}="${q(v)}"`);
      continue;
    }
    if (name === "id") {
      if (keepIds.has(decode(v))) out.push(`id="${q(v)}"`);
      continue;
    }
    if (name === "class" || name === "xml:space" || name === "mask") continue;
    if (name.startsWith("sodipodi:") || name.startsWith("inkscape:") || name.startsWith("xmlns")) continue;
    // command symbols: what they are (href) and where they sit (x, y, transform)
    if (tag === "use" && (name === "width" || name === "height")) continue;
    if (name === "style") {
      v = cleanStyle(v);
      if (isGlyphRoot) v = v.replace(/(^|;)display:[^;]*/g, "").replace(/^;|;$/g, "");
      if (!v) continue;
    }
    if (isGlyphRoot && name === "display") continue;
    if (name === "d" || name === "transform" || name === "points") v = roundNums(v).replace(/\s+/g, " ").trim();
    else if (/^(x|y|x1|x2|y1|y2|cx|cy|r|rx|ry|width|height|stroke-width)$/.test(name)) v = roundNums(v);
    out.push(`${name}="${q(v)}"`);
  }
  return out.length ? " " + out.join(" ") : "";
}

/** Clip-path ids an element refers to (attribute or style). */
const clipRefs = (body) => [...body.matchAll(/clip-path\s*[:=]\s*["']?\s*url\(\s*["']?#([^"')\s]+)/g)].map((m) => decode(m[1]));

const DROP = new Set(["metadata", "title", "desc", "sodipodi:namedview", "use", "clipPath", "mask", "style", "script", "symbol", "marker", "pattern", "linearGradient", "radialGradient"]);
const TOKEN = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[\s\S]*?>|<(\/?)([\w:.-]+)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>|([^<]+)/g;

/** An Ink/Stitch command symbol (`<use xlink:href="#inkstitch_trim">`). */
const isCommand = (a) => /^#inkstitch_/.test(a.get("xlink:href") ?? a.get("href") ?? "");

/**
 * Extract and minify all GlyphLayer groups of one Inkscape file. Kept for the
 * engine's SVG import, as Ink/Stitch's Glyph keeps them: command symbols
 * with their connectors and the ids these link (start / end points, trims,
 * stops of the glyph's objects), marker paths (guide, anchor and pattern
 * lines, which are not sewn) and clip paths (copied into every glyph that
 * uses them).
 */
export function extractGlyphs(text) {
  // ids something refers to: command connector ends and clip paths
  const keepIds = new Set();
  for (const m of text.matchAll(/inkscape:connection-(?:start|end)\s*=\s*["']#([^"']+)["']/g)) keepIds.add(decode(m[1]));
  for (const id of clipRefs(text)) keepIds.add(id);
  const glyphs = {};
  const glyphClips = {}; // glyph name → ids of the clips it uses
  const clips = new Map(); // clip id → markup
  let root = null;
  let baselineGuide = null;
  const stack = []; // { tag, transform }
  let dropDepth = 0; // inside a dropped element
  let glyph = null; // { name, depth, parts, wrap, clips }
  let clip = null; // { id, depth, parts }: a clip path being copied
  let page = null; // viewport transform as an SVG matrix
  const drop = (tag, selfClose) => {
    if (selfClose) return;
    stack.push({ tag, transform: null });
    dropDepth = stack.length;
  };
  for (const m of text.matchAll(TOKEN)) {
    const [, close, tag, body = "", selfClose, textNode] = m;
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
      if (clip) {
        clip.parts.push(`</${top.tag}>`);
        if (stack.length < clip.depth) {
          clips.set(clip.id, clip.parts.join(""));
          clip = null;
        }
        continue;
      }
      if (glyph) {
        if (stack.length < glyph.depth) {
          glyph.parts.push("</g>");
          const inner = glyph.parts.join("");
          glyphs[glyph.name] = glyph.wrap.length ? `<g transform="${glyph.wrap.join(" ")}">${inner}</g>` : inner;
          if (glyph.clips.size) glyphClips[glyph.name] = glyph.clips;
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
    if (clip) {
      // the clip's shapes as drawn (their own transforms kept)
      if (DROP.has(tag)) drop(tag, selfClose);
      else {
        if (!selfClose) stack.push({ tag, transform: null });
        clip.parts.push(`<${tag}${cleanAttrs(tag, body, false, keepIds)}${selfClose ? "/" : ""}>`);
      }
      continue;
    }
    if (tag === "clipPath" && a.has("id") && !selfClose) {
      stack.push({ tag, transform: null });
      clip = { id: decode(a.get("id")), depth: stack.length, parts: [`<clipPath${cleanAttrs(tag, body, false, keepIds)}>`] };
      continue;
    }
    // definitions: only their clip paths are of use
    if (tag === "defs") {
      if (!selfClose) stack.push({ tag, transform: null });
      continue;
    }
    const label = a.get("inkscape:label") ?? "";
    const isConnector = a.has("inkscape:connection-start") || a.has("inkscape:connection-end") || a.has("inkscape:connector-type");
    const command = tag === "use" && isCommand(a);
    if ((DROP.has(tag) && !command) || (isConnector && !glyph)) {
      drop(tag, selfClose);
      continue;
    }
    if (!glyph && tag === "g" && label.startsWith("GlyphLayer-") && !selfClose) {
      const name = decode(label.slice("GlyphLayer-".length)).normalize("NFC");
      stack.push({ tag, transform: a.get("transform") ?? null });
      const wrap = [page, ...stack.slice(1, -1).map((s) => s.transform)]
        .filter(Boolean)
        .map((t) => roundNums(t).replace(/\s+/g, " ").trim());
      glyph = { name, depth: stack.length, parts: [`<g${cleanAttrs(tag, body, true, keepIds)}>`], wrap, clips: new Set(clipRefs(body)) };
      continue;
    }
    if (isConnector) {
      // a command's connector: its two ends only (its line isn't sewn)
      drop(tag, selfClose);
      if (a.has("inkscape:connection-start") && a.has("inkscape:connection-end")) glyph.parts.push(`<path${cleanAttrs(tag, body, false, keepIds, true)}/>`);
      continue;
    }
    if (!selfClose) stack.push({ tag, transform: a.get("transform") ?? null });
    if (glyph) {
      for (const c of clipRefs(body)) glyph.clips.add(c);
      glyph.parts.push(`<${tag}${cleanAttrs(tag, body, false, keepIds)}${selfClose ? "/" : ""}>`);
    }
  }
  if (!root) throw new Error("no <svg> root");
  // the clip paths a glyph uses travel with it
  for (const [name, ids] of Object.entries(glyphClips)) {
    const defs = [...ids].map((id) => clips.get(id)).filter(Boolean);
    if (defs.length) glyphs[name] = `<defs>${defs.join("")}</defs>${glyphs[name]}`;
  }
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
 * of first use. Clip paths, marker lines (guides, patterns) and command
 * connectors aren't sewn: their colours don't count.
 */
export function collectColors(glyphs, colors) {
  for (const frag of Object.values(glyphs))
    for (const el of frag.replace(/<defs>[\s\S]*?<\/defs>/g, "").matchAll(/<[\w:.-]+(?:[^>"']|"[^"]*"|'[^']*')*>/g)) {
      if (/marker-start|connection-(?:start|end)/.test(el[0])) continue;
      for (const m of el[0].matchAll(/(?:fill|stroke)(?::|=")\s*(#[0-9a-f]{6}|#[0-9a-f]{3})\b/gi)) {
        let c = m[1].toLowerCase();
        if (c.length === 4) c = "#" + [...c.slice(1)].map((h) => h + h).join("");
        if (!colors.includes(c)) colors.push(c);
      }
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
    /** Colour sort indices whose objects become one each (Ink/Stitch combine_at_sort_indices). */
    combine_at_sort_indices: Array.isArray(meta.combine_at_sort_indices) ? meta.combine_at_sort_indices.map(Number).filter(Number.isFinite) : [],
    /** Route the lettering's satins (Ink/Stitch auto_satin, on unless the font says no). */
    auto_satin: pick("auto_satin", true) !== false,
    /** Cross-stitch fonts: the crosses scale with the lettering (Ink/Stitch scale_cross_stitch_pattern). */
    scale_cross_stitch_pattern: pick("scale_cross_stitch_pattern", false) === true,
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
