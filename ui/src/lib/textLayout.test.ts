// Lettering layout (npm run test:match): word spacing, Block alignment,
// back-and-forth lines and stitch-direction variants, as Ink/Stitch's
// Font.render_text lays them out.

import opentype from "opentype.js";
import { arcRadius, bidiLevels, blockOffsets, clampToFont, layoutText, lineVariant, placeGlyphs, reversedVariant, reverseLine, sizeForFont, visualOrder } from "./textLayout";
import { defaultFill, defaultSatin, transformObject, type Mat } from "./geometry";
import { buildFont, collectColors, extractGlyphs, fontMetrics, variantId } from "./inkFontPack.mjs";
import type { EmbroideryFont, EmbroideryGlyph, OutlineFont } from "./fonts";
import type { TextSpec } from "./text";
import type { DesignObject, FillParams, SubPath } from "../types";

let failed = 0;
const check = (ok: boolean, msg: string) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${msg}`);
  if (!ok) failed++;
};
const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;

// a fake font: every glyph a 4 mm wide box; the variant shows in the stitch length
const LEN: Record<string, number> = { ltr: 3, rtl: 2, ttb: 4, btt: 5 };
function fakeFont(variant = "ltr", variants = ["ltr", "rtl"], reversible = true, own: Partial<DesignObject> = {}): EmbroideryFont {
  const names = new Set("ABCDEFGHIJKLMNOPQRSTUVWXYZ".split(""));
  const box = (w: number, h: number): SubPath => ({ closed: true, nodes: [{ p: [0, -h] }, { p: [w, -h] }, { p: [w, 0] }, { p: [0, 0] }] });
  return {
    kind: "embroidery",
    key: "emb:test",
    name: "Test",
    size: 10,
    minScale: 1,
    maxScale: 1,
    leading: 15,
    space: 3,
    advDefault: null,
    adv: {},
    kerning: {},
    letterCase: "",
    defaultGlyph: "�",
    direction: "ltr",
    colors: ["#000000"],
    names,
    variant,
    variants,
    reversible,
    namesOf: () => names,
    glyph: async (name: string, v?: string): Promise<EmbroideryGlyph> => {
      const used = v && variants.includes(v) ? v : variant;
      const o: DesignObject = {
        id: name,
        name,
        thread: "t",
        visible: true,
        locked: false,
        paths: [box(4, 10)],
        stitch: { type: "running", length: LEN[used], tolerance: 0.2, repeats: 0, beanRepeats: 0, method: "running" } as unknown as DesignObject["stitch"],
        trimAfter: false,
        stopAfter: false,
        ...own,
      };
      return { name, objects: [o], colors: [0], width: 4, minX: 0 };
    },
  };
}

const spec = (p: Partial<TextSpec>): TextSpec => ({
  group: "g",
  content: "A",
  font: "emb:test",
  size: 10,
  letterSpacing: 0,
  lineSpacing: 1,
  align: "left",
  arc: 0,
  rotation: 0,
  anchor: [0, 0],
  style: "fill",
  borderWidth: 1,
  fillAngle: 45,
  thread: "t",
  borderThread: "t",
  ...p,
});
const minX = (o: DesignObject) => Math.min(...o.paths.flatMap((sp) => sp.nodes.map((n) => n.p[0])));
const minY = (o: DesignObject) => Math.min(...o.paths.flatMap((sp) => sp.nodes.map((n) => n.p[1])));
const len = (o: DesignObject) => (o.stitch as unknown as { length: number }).length;
/** Letters in stitch order as "name@x". */
const order = (objs: DesignObject[]) => objs.map((o) => `${o.name.split(" · ")[1]}@${Math.round(minX(o))}`).join(" ");

// --- pure rules --------------------------------------------------------------
check(reversedVariant("ltr") === "rtl" && reversedVariant("ttb") === "btt" && reversedVariant("btt") === "ttb", "reversed variants pair up");
check(lineVariant("ltr", true, 1) === "rtl" && lineVariant("ltr", true, 2) === "ltr" && lineVariant("ltr", false, 1) === "ltr", "back and forth: every second line reversed");
check(!reverseLine("ltr", false, 1) && reverseLine("ltr", true, 1) && !reverseLine("ltr", true, 0), "ltr: second lines run backwards");
check(reverseLine("rtl", false, 0) && !reverseLine("rtl", true, 1) && reverseLine("rtl", true, 2), "rtl: runs backwards except turned lines");
check(!reverseLine("ttb", true, 1) && !reverseLine("btt", false, 0), "ttb/btt: reading order kept");
const off = blockOffsets([7, 8, 9], 10);
check(off.get(7) === 0 && off.get(8) === 5 && off.get(9) === 10, "block offsets spread evenly over the gaps");
check(blockOffsets([1], 10).size === 0 && blockOffsets([1, 2], 0).size === 0, "block: nothing for one unit or no distance");
check(variantId("→") === "ltr" && variantId("↓") === "ttb" && variantId("btt") === "btt", "legacy arrow variant names");

(async () => {
  const f = fakeFont();
  // --- word spacing ----------------------------------------------------------
  let objs = await layoutText(spec({ content: "A B" }), f);
  check(order(objs) === "A@0 B@7", `no word spacing: B after advance + space (${order(objs)})`);
  objs = await layoutText(spec({ content: "A B", wordSpacing: 2 }), f);
  check(order(objs) === "A@0 B@9", `word spacing adds to every space (${order(objs)})`);
  objs = await layoutText(spec({ content: "AB", wordSpacing: 2 }), f);
  check(order(objs) === "A@0 B@4", "word spacing leaves letters alone");
  objs = await layoutText(spec({ content: "A B", wordSpacing: 2, align: "right" }), f);
  check(near(minX(objs[0]), -13), `right alignment includes the word spacing (${minX(objs[0])})`);

  // --- Block alignment -------------------------------------------------------
  objs = await layoutText(spec({ content: "A B C\nAAAAAAA", align: "block" }), f);
  check(order(objs.slice(0, 3)) === "A@0 B@12 C@24", `block: words spread to the widest line (${order(objs.slice(0, 3))})`);
  check(near(minX(objs[objs.length - 1]) + 4, 28), "block: the widest line stays");
  objs = await layoutText(spec({ content: "AB\nAAAA", align: "block" }), f);
  check(order(objs.slice(0, 2)) === "A@0 B@4", "block: a one-word line keeps its letters");
  objs = await layoutText(spec({ content: "AB\nAAAA", align: "blockLetters" }), f);
  check(order(objs.slice(0, 2)) === "A@0 B@12", `block (letter spacing): a one-word line spreads its letters (${order(objs.slice(0, 2))})`);
  objs = await layoutText(spec({ content: "A B\nAAAA", align: "blockLetters" }), f);
  check(order(objs.slice(0, 2)) === "A@0 B@12", "block (letter spacing): lines of several words spread between words");

  // --- back and forth --------------------------------------------------------
  objs = await layoutText(spec({ content: "AB\nCD" }), f);
  check(order(objs) === "A@0 B@4 C@0 D@4" && objs.every((o) => len(o) === 3), `default: every line left to right (${order(objs)})`);
  objs = await layoutText(spec({ content: "AB\nCD\nEF", backAndForth: true }), f);
  check(order(objs) === "A@0 B@4 D@4 C@0 E@0 F@4", `back and forth: the second line runs backwards (${order(objs)})`);
  check(len(objs[2]) === 2 && len(objs[0]) === 3 && len(objs[4]) === 3, "back and forth: the turned line uses the reversed (rtl) glyphs");
  check(minY(objs[2]) > minY(objs[0]), "back and forth: lines keep their place");
  objs = await layoutText(spec({ content: "AB\nCD", backAndForth: true, trims: "letter" }), f);
  check(objs.every((o) => o.trimAfter), "back and forth: trims follow the stitch order (after every letter, the last too, as Ink/Stitch)");
  objs = await layoutText(spec({ content: "AB CD\nEF", trims: "word" }), f);
  check(objs.map((o) => +o.trimAfter).join("") === "010100", `word trims: after a word's last letter, not after the text's last word (${objs.map((o) => +o.trimAfter).join("")})`);
  objs = await layoutText(spec({ content: "AB\nCD", trims: "line" }), f);
  check(objs.map((o) => +o.trimAfter).join("") === "0100", "line trims: after every line but the last");
  objs = await layoutText(spec({ content: "AB\nCD", backAndForth: true }), fakeFont("ltr", ["ltr", "rtl"], false));
  check(order(objs) === "A@0 B@4 C@0 D@4", "non-reversible fonts ignore back and forth");
  objs = await layoutText(spec({ content: "AB\nCD", backAndForth: true }), fakeFont("ltr", ["ltr"]));
  check(order(objs) === "A@0 B@4 D@4 C@0" && objs.every((o) => len(o) === 3), "no reversed variant: the default glyphs, turned order (Ink/Stitch's fallback)");

  // --- stitch-direction variants ---------------------------------------------
  objs = await layoutText(spec({ content: "AB" }), fakeFont("rtl", ["rtl", "ltr"]));
  check(order(objs) === "B@4 A@0" && len(objs[0]) === 2, `rtl variant: stitched right to left (${order(objs)})`);
  objs = await layoutText(spec({ content: "AB", variant: "rtl" }), f);
  check(order(objs) === "B@4 A@0" && len(objs[0]) === 2, "chosen rtl variant: its glyphs, right to left");
  objs = await layoutText(spec({ content: "AB", variant: "ttb" }), f);
  check(order(objs) === "A@0 B@4" && len(objs[0]) === 3, "a variant the font lacks: the default");
  const vert = fakeFont("ttb", ["ttb", "btt", "ltr"]);
  objs = await layoutText(spec({ content: "AB\nCD", backAndForth: true }), vert);
  check(order(objs) === "A@0 B@4 C@0 D@4", "ttb back and forth: reading order kept");
  check(len(objs[0]) === 4 && len(objs[2]) === 5, "ttb back and forth: the second line uses the btt glyphs");

  // --- font packing ------------------------------------------------------------
  const svg = (label: string) =>
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" width="100" height="100" viewBox="0 0 100 100"><g inkscape:label="GlyphLayer-${label}"><path d="M0 0 L10 0" style="stroke:#ff0000;fill:none"/></g></svg>`;
  const pack = buildFont({ name: "T", default_variant: "ltr" }, [svg("A")], "ltr", { "←": [svg("A")], ltr: [svg("A")] });
  check(pack.font.chunks.length === 1 && !!pack.font.variants?.rtl && !pack.font.variants?.ltr, "buildFont packs the other variants alongside");
  check(!!pack.data["rtl-glyphs-0.json"] && !!pack.data["glyphs-0.json"], "variant chunks get their own files");
  check(pack.font.reversible === true && pack.font.sortable === false, "reversible by default, not sortable (Ink/Stitch defaults)");
  const m = fontMetrics({ name: "X", reversible: false, horiz_adv_x_space: 30, kerning_pairs: { "A V": -2, "A B": 0 } });
  check(m.reversible === false && m.horiz_adv_x_space === 30 && Object.keys(m.kerning_pairs).length === 1, "font metrics from font.json (zero kerning dropped)");

  // --- the font's own commands per glyph object ---------------------------------
  const cmdFont = fakeFont("ltr", ["ltr"], true, { ties: "none", forceLock: true, minStitch: 0.5, minJump: 2, stopAfter: true, start: [1, -5], end: [3, -1] });
  objs = await layoutText(spec({ content: "AB", anchor: [10, 20] }), cmdFont);
  const b = objs[1];
  check(b.ties === "none" && b.forceLock === true && b.minStitch === 0.5 && b.minJump === 2 && b.stopAfter === true, "glyph objects keep the font's ties, force lock, min stitch / jump and stop");
  check(!!b.start && near(b.start[0], 15) && near(b.start[1], 15) && !!b.end && near(b.end[0], 17) && near(b.end[1], 19), `start / end points move with the letter (${b.start} ${b.end})`);
  objs = await layoutText(spec({ content: "A", anchor: [0, 0], size: 20, rotation: 90 }), cmdFont);
  check(!!objs[0].start && near(objs[0].start[0], 10) && near(objs[0].start[1], 2), `start point scaled and turned with the letter (${objs[0].start})`);
  objs = await layoutText(spec({ content: "A B\nAAAAAAA", align: "block" }), cmdFont);
  check(minX(objs[1]) > 7 && !!objs[1].start && near(objs[1].start[0], minX(objs[1]) + 1), `start point follows Block alignment (${objs[1].start})`);
  objs = await layoutText(spec({ content: "AB" }), f);
  check(objs.every((o) => o.start === undefined && o.ties === undefined && !o.stopAfter), "glyphs without commands get none");

  // --- arcs on short text ----------------------------------------------------------
  check(near(arcRadius(90, 10), 10 / (Math.PI / 2)), "arc radius: the width over the angle");
  check(arcRadius(-300, 4, 10) >= 12.5 && arcRadius(-300, 4, 0) >= 1, "arc radius stays above the letters' height and a margin");
  objs = await layoutText(spec({ content: "A", align: "center", arc: -300 }), f);
  const nodes = objs[0].paths[0].nodes.map((n) => n.p);
  // box: top-left, top-right, bottom-right, bottom-left
  check(nodes[0][0] < nodes[1][0] && nodes[0][1] < nodes[3][1] && nodes.every((p) => isFinite(p[0]) && isFinite(p[1])), `a strong dip on one letter keeps it the right way round (${JSON.stringify(nodes)})`);
  objs = await layoutText(spec({ content: "A\nA", align: "center", arc: 300 }), f);
  const low = objs[1].paths[0].nodes.map((n) => n.p);
  check(low[0][0] < low[1][0] && low[0][1] < low[3][1], `a strong arch keeps the lower line the right way round (${JSON.stringify(low)})`);

  // --- bidi (outline fonts) --------------------------------------------------------
  check(visualOrder("abc") === "abc" && visualOrder("12 ab") === "12 ab", "left-to-right lines stay");
  check(visualOrder("אבג") === "גבא", "Hebrew is drawn right to left");
  check(visualOrder("אבג 123") === "123 גבא", "numbers keep their order in right-to-left lines");
  check(visualOrder("אבג abc def") === "abc def גבא", "Latin runs keep their order in right-to-left lines");
  check(visualOrder("abc אבג def") === "abc גבא def", "a Hebrew run inside a left-to-right line turns round in place");
  check(visualOrder("שלום (עולם)") === "(םלוע) םולש", `brackets mirror in right-to-left text (${visualOrder("שלום (עולם)")})`);
  check(visualOrder("בָּא") === "אבָּ", "marks stay with their letter");
  check(bidiLevels("אב").rtl && !bidiLevels("ab אב").rtl, "the line's direction is its first strong letter's");

  // a real (in-memory) outline font: boxes of different heights, a kerning pair
  const box = (name: string, unicode: number, w: number, h: number) => {
    const p = new opentype.Path();
    if (h) {
      p.moveTo(50, 0);
      p.lineTo(w - 50, 0);
      p.lineTo(w - 50, h);
      p.lineTo(50, h);
      p.close();
    }
    return new opentype.Glyph({ name, unicode, advanceWidth: w, path: p });
  };
  const notdefPath = new opentype.Path();
  notdefPath.moveTo(0, 0);
  notdefPath.lineTo(500, 0);
  notdefPath.lineTo(500, 700);
  notdefPath.close();
  const notdef = new opentype.Glyph({ name: ".notdef", advanceWidth: 500, path: notdefPath });
  const ot = opentype.parse(
    new opentype.Font({
      familyName: "T",
      styleName: "R",
      unitsPerEm: 1000,
      ascender: 800,
      descender: -200,
      glyphs: [
        notdef,
        box("space", 32, 250, 0),
        box("A", 65, 600, 700),
        box("B", 66, 600, 650),
        box("alefhe", 0x5d0, 500, 600),
        box("bethe", 0x5d1, 500, 400),
        box("alef", 0x627, 300, 700),
        box("beh", 0x628, 500, 300),
        box("teh", 0x62a, 500, 350),
        box("one", 0x31, 500, 690),
        box("two", 0x32, 500, 680),
      ],
    }).toArrayBuffer(),
  );
  const iA = ot.charToGlyphIndex("A");
  const iB = ot.charToGlyphIndex("B");
  (ot as unknown as { kerningPairs: Record<string, number> }).kerningPairs = { [`${iA},${iB}`]: -80 };
  const names = (line: string) =>
    placeGlyphs(ot, line, 10, { kerning: true })
      .glyphs.map((g) => g.glyph.name)
      .join(" ");
  // left to right: the same positions as opentype.js's own getPaths
  const opts = { kerning: true, letterSpacing: 0.05 } as opentype.RenderOptions;
  const mine = placeGlyphs(ot, "AB A", 10, opts);
  const theirs = ot.getPaths("AB A", 0, 0, 10, opts);
  const samePos = mine.glyphs.every((g, i) => {
    const a = g.glyph.getPath(g.x, 0, 10, opts, ot).getBoundingBox();
    const t = theirs[i].getBoundingBox();
    return a.isEmpty() ? t.isEmpty() : near(a.x1, t.x1);
  });
  check(mine.glyphs.length === theirs.length && samePos && near(mine.width, ot.getAdvanceWidth("AB A", 10, opts)), "left-to-right glyph positions match opentype.js (kerning, letter spacing)");
  check(near(mine.glyphs[1].x - mine.glyphs[0].x, 6 - 0.8 + 0.5), `the kerning pair applies (${mine.glyphs[1].x})`);
  check(names("אב") === "bethe alefhe", `Hebrew glyphs right to left (${names("אב")})`);
  check(names("ابت") === "teh beh alef", `Arabic glyphs right to left, not reversed twice (${names("ابت")})`);
  check(names("ابت 12") === "one two space teh beh alef", `Arabic with numbers (${names("ابت 12")})`);
  check(names("AB אב") === "A B space bethe alefhe", `mixed line: Latin, then Hebrew turned (${names("AB אב")})`);
  const outline: OutlineFont = { kind: "outline", key: "ttf:test", font: ot };
  const ospec = (content: string) => spec({ content, font: "ttf:test", style: "fill", size: 7, align: "left" });
  objs = await layoutText(ospec("אב"), outline);
  const tops = objs[0].paths.map((sp) => ({ x: Math.min(...sp.nodes.map((n) => n.p[0])), top: Math.min(...sp.nodes.map((n) => n.p[1])) }));
  const alefBox = tops.reduce((a, c) => (c.top < a.top ? c : a));
  const betBox = tops.reduce((a, c) => (c.top > a.top ? c : a));
  check(tops.length === 2 && alefBox.x > betBox.x, "outline lettering: Hebrew stitched in visual order (alef on the right)");
  objs = await layoutText(ospec("A一"), outline);
  check(objs.length === 1 && objs[0].paths.length === 1, "missing characters: no .notdef box stitched");
  objs = await layoutText(ospec("一丁"), outline);
  check(objs.length === 0, "only missing characters: nothing (so another font can be used)");

  // --- transforms keep the lettering parametric ---------------------------------------
  {
    const o = (await layoutText(spec({ content: "A", path: [[0, 0], [10, 0]], wordSpacing: 2 }), f))[0];
    const m: Mat = [2, 0, 0, 2, 5, 5];
    const t = transformObject({ ...o, start: [1, 1] }, m);
    // word spacing: an embroidery font keeps it at its own size (it scales with the letters), an outline font's is mm
    check(JSON.stringify(t.text!.path) === JSON.stringify([[5, 5], [25, 5]]) && t.text!.wordSpacing === (t.text!.font.startsWith("emb:") || t.text!.font.startsWith("inkfont:") ? 2 : 4), "text on a path: the path follows a move / scale, word spacing as the font measures it");
    check(!!t.start && t.start[0] === 7 && t.start[1] === 7, "a letter's start point follows the transform");
  }

  // --- a font of real objects: alignment, spacing, colour sort, paths, auto-satin ---------
  {
    const rect = (x0: number, y0: number, x1: number, y1: number): SubPath => ({ closed: true, nodes: [{ p: [x0, y0] }, { p: [x1, y0] }, { p: [x1, y1] }, { p: [x0, y1] }] });
    const line = (a: [number, number], b: [number, number]): SubPath => ({ closed: false, nodes: [{ p: a }, { p: b }] });
    const base = (p: Partial<DesignObject>): DesignObject => ({ id: "x", name: "x", thread: "t", visible: true, locked: false, paths: [rect(0, -10, 4, 0)], stitch: { type: "fill", ...defaultFill(), angle: 0 }, trimAfter: false, stopAfter: false, ...p });
    /** A font whose every glyph is `objs` (glyph space: left edge 0, baseline 0). */
    const objFont = (objs: () => DesignObject[], extra: Partial<EmbroideryFont> = {}): EmbroideryFont => {
      const f = fakeFont();
      return {
        ...f,
        colors: ["#000000", "#ff0000"],
        glyph: async (name: string) => {
          const os = objs();
          return { name, objects: os, colors: os.map((o) => (o.thread === "red" ? 1 : 0)), width: 4, minX: 0 };
        },
        ...extra,
      };
    };
    const ink = objFont(() => [base({})], { adv: { A: 8, B: 8 } });
    // advance 8 mm, ink 4 mm: Ink/Stitch aligns by the letters' bounding box
    let o = await layoutText(spec({ content: "A", align: "center" }), ink);
    check(near(minX(o[0]), -2), `centre alignment by the letters' ink, not their advance (${minX(o[0])})`);
    o = await layoutText(spec({ content: "AB", align: "right" }), ink);
    check(near(minX(o[1]) + 4, 0), `right alignment: the last letter's ink ends at the anchor (${minX(o[1]) + 4})`);
    // letter / word spacing at the font's size: they scale with the letters (Ink/Stitch)
    o = await layoutText(spec({ content: "AB", size: 20, letterSpacing: 1 }), f);
    check(near(minX(o[1]), 10), `letter spacing scales with the text (${minX(o[1])})`);
    o = await layoutText(spec({ content: "A B", size: 20, wordSpacing: 1 }), f);
    check(near(minX(o[1]), (4 + 3 + 1) * 2), `word spacing scales with the text (${minX(o[1])})`);

    // colour sort: Ink/Stitch's colour sort index, sortable fonts only
    const two = () => [base({ name: "b", colorSortIndex: 2 }), base({ name: "a", thread: "red", colorSortIndex: 1 }), base({ name: "n" })];
    const idx = (objs: DesignObject[]) => objs.map((x) => x.colorSortIndex ?? 404).join(" ");
    o = await layoutText(spec({ content: "AB", colorSort: "all" }), objFont(two));
    check(idx(o) === "2 1 404 2 1 404", `a font that isn't sortable keeps its order (${idx(o)})`);
    const sortable = objFont(two, { sortable: true });
    o = await layoutText(spec({ content: "AB", colorSort: "all" }), sortable);
    check(idx(o) === "1 1 2 2 404 404" && minX(o[0]) < minX(o[1]), `sortable: by colour sort index, none last, letters in order (${idx(o)})`);
    o = await layoutText(spec({ content: "AB\nAB", colorSort: "line" }), sortable);
    check(idx(o) === "1 1 2 2 404 404 1 1 2 2 404 404", `sorted line by line (${idx(o)})`);
    o = await layoutText(spec({ content: "AB", colorSort: "all", trims: "letter" }), sortable);
    check(o.every((x) => x.trimAfter), "sorted letter trims: every colour of every letter ends with a trim (Ink/Stitch)");
    o = await layoutText(spec({ content: "AB", colorSort: "off", trims: "letter" }), sortable);
    check(o.map((x) => +x.trimAfter).join("") === "001001", "unsorted letter trims: the letter's last object only");
    o = await layoutText(spec({ content: "AB", colorSort: "all" }), objFont(two, { sortable: true, combineAtSortIndices: [1] }));
    check(idx(o) === "1 2 2 404 404" && o[0].paths.length === 2, `combine_at_sort_indices: one object per index (${idx(o)})`);

    // the glyph objects' own settings and geometry come along, placed like the letter
    const rich = objFont(() => [
      base({
        lock: { start: "star", startScale: 50 },
        colorSortIndex: 3,
        patterns: [{ paths: [line([0, -5], [4, -5])], add: true, remove: false, offset: 0 }],
        stitch: { type: "fill", ...defaultFill(), method: "guided", angle: 0, guide: line([0, -1], [4, -9]) },
      }),
      base({ paths: [line([0, 0], [4, -10])], stitch: { type: "running", length: 2, tolerance: 0.2, repeats: 1, beanRepeats: 0, ripple: { lines: 3, minScale: 0, spacing: 1, rotation: 0, reverse: false, target: [2, -5], guide: [line([0, 0], [0, -10])] } } }),
    ]);
    o = await layoutText(spec({ content: "A", size: 20, anchor: [100, 50] }), rich);
    const st = o[0].stitch as FillParams;
    check(o[0].lock?.start === "star" && o[0].colorSortIndex === 3, "lock stitches and the colour sort index come from the font");
    check(!!o[0].patterns && near(o[0].patterns[0].paths[0].nodes[1].p[0], 108) && near(o[0].patterns[0].paths[0].nodes[1].p[1], 40), `pattern lines placed with the letter (${JSON.stringify(o[0].patterns?.[0].paths[0].nodes)})`);
    check(!!st.guide && near(st.guide.nodes[1].p[0], 108) && near(st.guide.nodes[1].p[1], 32), "a guided fill's guide line placed with the letter");
    const rp = (o[1].stitch as { ripple: { target: [number, number]; guide: SubPath[] } }).ripple;
    check(near(rp.target[0], 104) && near(rp.target[1], 40) && near(rp.guide[0].nodes[1].p[1], 30), "ripple target and guide placed with the letter");

    // text on a path: every letter placed whole, turned along the path
    const arc: [number, number][] = Array.from({ length: 41 }, (_, i) => {
      const a = Math.PI - (i / 40) * Math.PI;
      return [50 + 50 * Math.cos(a), 50 - 50 * Math.sin(a)];
    });
    o = await layoutText(spec({ content: "AAA", path: arc, pathAlign: "start" }), ink);
    const side = (sp: SubPath, i: number, j: number) => Math.hypot(sp.nodes[i].p[0] - sp.nodes[j].p[0], sp.nodes[i].p[1] - sp.nodes[j].p[1]);
    check(o.every((x) => near(side(x.paths[0], 0, 1), 4) && near(side(x.paths[0], 1, 2), 10) && near(side(x.paths[0], 0, 2), Math.hypot(4, 10))), "on a path: letters keep their shape (not bent)");
    const turned = o.map((x) => (x.stitch as FillParams).angle);
    check(turned[0] > 45 && turned[1] < turned[0] && turned[2] < turned[1], `on a path: every letter's fill turns with it (${turned.map((a) => a.toFixed(1))})`);
    check(near(o[0].paths[0].nodes[3].p[0], 0) && near(o[0].paths[0].nodes[3].p[1], 50), `start: the first letter's left edge and baseline at the path's start (${o[0].paths[0].nodes[3].p})`);
    o = await layoutText(spec({ content: "AA", path: [[0, 0], [100, 0]], pathAlign: "center" }), ink);
    check(near(minX(o[0]), 50 - 6), `centre on a path: by the letters' ink width (${minX(o[0])})`);
    o = await layoutText(spec({ content: "AA A", path: [[0, 0], [100, 0]], pathAlign: "stretch" }), ink);
    const w = (x: DesignObject) => Math.max(...x.paths[0].nodes.map((n) => n.p[0])) - minX(x);
    // 3 letters (12 mm ink) and gaps: 2 between letters + 1 more between words share the rest
    check(o.every((x) => near(w(x), 4)) && near(minX(o[0]), 0) && near(minX(o[2]) + 4, 100), `stretch: letters keep their size, spread over the path (${o.map(minX)})`);
    // Ink/Stitch: the letters' own gaps stay; a word gap gets the stretch twice
    check(near(minX(o[2]) - (minX(o[1]) + 4) - 7, 2 * (minX(o[1]) - (minX(o[0]) + 4) - 4)), "stretch: a word gap widened twice as much as a letter gap");
    o = await layoutText(spec({ content: "A\nA", path: [[0, 0], [100, 0]], pathAlign: "start" }), ink);
    check(near(minY(o[1]) - minY(o[0]), 15), "on a path: the next line follows the path a line lower");

    // cross-stitch fonts: the font says whether the crosses scale
    const cross = (extra: Partial<EmbroideryFont>) => objFont(() => [base({ stitch: { type: "fill", ...defaultFill(), method: "cross", angle: 0, crossSize: 2 } })], extra);
    o = await layoutText(spec({ content: "A", size: 20 }), cross({}));
    check((o[0].stitch as FillParams).crossSize === 2, "crosses keep their size by default (Ink/Stitch)");
    o = await layoutText(spec({ content: "A", size: 20 }), cross({ scaleCrossStitch: true }));
    check((o[0].stitch as FillParams).crossSize === 4, "scale_cross_stitch_pattern: the crosses grow with the letters");
    o = await layoutText(spec({ content: "A", size: 20, crossScale: false }), cross({ scaleCrossStitch: true }));
    check((o[0].stitch as FillParams).crossSize === 2, "the lettering's own choice wins over the font's");

    // auto-satin (fonts with auto_satin): the satins routed in order, no trims
    const satin = (y: number): DesignObject => base({ paths: [line([0, y], [4, y]), line([0, y - 1], [4, y - 1])], stitch: { type: "satin", ...defaultSatin(), centerWalkRepeats: 1 } });
    const satins = () => [satin(0), satin(-9)];
    o = await layoutText(spec({ content: "AB" }), objFont(satins, { autoSatin: false }));
    check(o.length === 4 && o.every((x) => (x.stitch as { centerWalkRepeats?: number }).centerWalkRepeats === 1), "auto_satin off: the font's objects as they are");
    o = await layoutText(spec({ content: "AB", trims: "letter" }), objFont(satins, { autoSatin: true }));
    const walked = o.filter((x) => x.stitch.type === "satin").every((x) => (x.stitch as { centerWalkRepeats?: number }).centerWalkRepeats === 2);
    check(walked && o.every((x) => x.text?.role === "glyph"), "auto_satin: the satins routed (even centre walks)");
    check(o[o.length - 1].trimAfter && o.filter((x) => x.trimAfter).length === 2 && minX(o.find((x) => x.trimAfter)!) < 4.5, "auto_satin: the lettering's trims still end each letter");
  }

  // --- sizes in the font's range (Ink/Stitch's scale range) ------------------------------
  {
    const ranged = { ...fakeFont(), size: 20, minScale: 0.8, maxScale: 1.5 };
    check(clampToFont(10, ranged) === 16 && clampToFont(40, ranged) === 30 && clampToFont(25, ranged) === 25, "sizes are kept in the font's range");
    check(sizeForFont(15, { ...fakeFont(), size: 10 }, ranged) === 30, "switching font keeps the scale (150 %)");
    check(sizeForFont(5, { ...fakeFont(), size: 10 }, ranged) === 16, "… within the new font's range");
    check(sizeForFont(12, null, ranged) === 16 && sizeForFont(12, null, outline) === 12, "from an outline font: the size in mm, in range");
  }

  // --- font packing: commands, markers and clips survive -------------------------------
  {
    const svgText = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:inkstitch="http://inkstitch.org/namespace" width="100" height="100" viewBox="0 0 100 100">
      <defs><clipPath id="clip1" clipPathUnits="userSpaceOnUse"><path id="cp" d="M0 0 H50 V50 Z" style="fill:#123456"/></clipPath><symbol id="inkstitch_trim"><path d="M0 0"/></symbol></defs>
      <g inkscape:label="GlyphLayer-A" id="layer" style="display:none">
        <g clip-path="url(#clip1)"><path id="fill7" d="M0 0 H10 V10 Z" style="fill:#ff0000;stroke:none" inkstitch:color_sort_index="2"/></g>
        <path id="guide9" d="M0 5 L10 5" style="fill:none;stroke:#00ff00;marker-start:url(#inkstitch-guide-line-marker-3)"/>
        <g id="command_group1"><path id="command_connector1" d="M 1,1 5,5" inkscape:connection-start="#use1" inkscape:connection-end="#fill7" style="stroke:#000"/><use id="use1" xlink:href="#inkstitch_trim" x="1" y="1" width="100%" height="100%"/></g>
        <use xlink:href="#other" x="3" y="3"/>
      </g></svg>`;
    const g = extractGlyphs(svgText).glyphs.A;
    check(g.includes('id="fill7"') && g.includes('inkscape:connection-start="#use1" inkscape:connection-end="#fill7"') && g.includes('<use id="use1" xlink:href="#inkstitch_trim" x="1" y="1"/>'), `commands: the symbol, its connector and the id they link (${g})`);
    check(!g.includes('id="guide9"') && !g.includes('id="layer"') && !g.includes("#other"), "ids nothing refers to are dropped, and clones");
    check(g.includes("marker-start:url(#inkstitch-guide-line-marker-3)"), "guide-line markers kept (not sewn)");
    check(g.startsWith('<defs><clipPath') && g.includes('id="clip1"') && g.includes('clip-path="url(#clip1)"') && !g.includes("<symbol"), "clip paths travel with the glyph");
    check(collectColors({ A: g }, []).join() === "#ff0000", `colours: not the clip's, marker's or connector's (${collectColors({ A: g }, [])})`);
    const fm = fontMetrics({ name: "X" });
    check(fm.auto_satin === true && fm.scale_cross_stitch_pattern === false && fm.combine_at_sort_indices.length === 0, "auto_satin on, crosses unscaled by default (Ink/Stitch)");
    const fm2 = fontMetrics({ name: "X", auto_satin: false, scale_cross_stitch_pattern: true, combine_at_sort_indices: [0, 2], sortable: true });
    check(fm2.auto_satin === false && fm2.scale_cross_stitch_pattern === true && fm2.combine_at_sort_indices.join() === "0,2" && fm2.sortable === true, "font.json flags kept");
  }

  if (failed) throw new Error(`${failed} lettering layout check(s) failed`);
  console.log("all passed");
})().catch((e) => {
  // fail the run (an uncaught error ends Node with an error code)
  setTimeout(() => {
    throw e;
  });
});
