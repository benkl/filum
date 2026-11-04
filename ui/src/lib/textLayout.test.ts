// Lettering layout (npm run test:match): word spacing, Block alignment,
// back-and-forth lines and stitch-direction variants, as Ink/Stitch's
// Font.render_text lays them out.

import { blockOffsets, layoutText, lineVariant, reversedVariant, reverseLine } from "./textLayout";
import { buildFont, fontMetrics, variantId } from "./inkFontPack.mjs";
import type { EmbroideryFont, EmbroideryGlyph } from "./fonts";
import type { TextSpec } from "./text";
import type { DesignObject, SubPath } from "../types";

let failed = 0;
const check = (ok: boolean, msg: string) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${msg}`);
  if (!ok) failed++;
};
const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;

// a fake font: every glyph a 4 mm wide box; the variant shows in the stitch length
const LEN: Record<string, number> = { ltr: 3, rtl: 2, ttb: 4, btt: 5 };
function fakeFont(variant = "ltr", variants = ["ltr", "rtl"], reversible = true): EmbroideryFont {
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
  check(objs.slice(0, -1).every((o) => o.trimAfter) && !objs[objs.length - 1].trimAfter, "back and forth: trims follow the stitch order");
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

  if (failed) throw new Error(`${failed} lettering layout check(s) failed`);
  console.log("all passed");
})().catch((e) => {
  // fail the run (an uncaught error ends Node with an error code)
  setTimeout(() => {
    throw e;
  });
});
