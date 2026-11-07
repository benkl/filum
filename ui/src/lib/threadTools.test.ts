// Thread logic without app state (npm run test:match): the My threads palette
// file, ids of installed charts, editing a spool's colour, merging similar
// colours, the sew order of threads.

import type { DesignObject } from "../types";
import type { TextSpec } from "./text";
import { bySewOrder, chartIdFor, colourEdit, FILUM_ENTRY, myThreadsGpl, ownedKey, similarMerges, spoolsOfPalette, type ParsedPalette } from "./threadTools";

let failed = 0;
const check = (ok: boolean, msg: string) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${msg}`);
  if (!ok) failed++;
};

// --- My threads: export → import ---------------------------------------------------
{
  const mine = [
    { name: "Red", code: "1147", brand: "Madeira Polyneon", color: "#c8102e" },
    { name: "Sky", code: "", brand: "Gunold 12", color: "#7ec8e3" },
    { name: "Red 2", code: "", brand: "", color: "#d21623" },
    { name: "Gold", code: "GLD", brand: "Isacord 40", color: "#d4a017" },
    { name: "Tab\tname", code: "7", brand: "A\tB", color: "#000000" },
  ];
  const text = myThreadsGpl(mine);
  const lines = text.split("\n");
  check(lines[0] === "GIMP Palette" && lines[1] === "Name: My threads", "export: a GIMP palette named My threads");
  check(lines.includes(`${FILUM_ENTRY}\tRed\t1147\tMadeira Polyneon`) && lines.includes("200\t 16\t 46\tRed 1147"), "export: the entry as Ink/Stitch writes it, its exact fields in a comment before it");
  check(lines.includes(`${FILUM_ENTRY}\tTab name\t7\tA B`), "export: tabs in a field become spaces");

  // what the engine's parse_gpl gives for this text (crates/core/src/threads.rs, gpl_my_threads_round_trip)
  const parsed: ParsedPalette = {
    name: "My threads",
    entries: mine.map((t) => ({ name: t.name.replace(/\t/g, " "), code: t.code, rgb: [0, 0, 0] as [number, number, number] })).map((e, i) => {
      const h = mine[i].color.slice(1);
      return { ...e, rgb: [0, 2, 4].map((k) => parseInt(h.slice(k, k + 2), 16)) as [number, number, number] };
    }),
    brands: mine.map((t) => t.brand.replace(/\t/g, " ")),
  };
  const back = spoolsOfPalette(parsed, "my-threads.gpl");
  check(back.length === mine.length, "import: every spool");
  check(back.slice(0, 4).every((t, i) => ownedKey(t) === ownedKey(mine[i]) && t.name === mine[i].name), "import: brand, code, name and colour as exported (no duplicates)");
  check(back[1].brand === "Gunold 12" && back[1].code === "", "import: a brand with digits, no code");
  check(back[2].brand === "" && back[2].name === "Red 2", "import: no brand stays no brand");

  // a plain palette (Ink/Stitch chart, older export): the palette's name is the brand
  const plain = spoolsOfPalette({ name: "Ink/Stitch: Madeira Rayon", entries: [{ name: "", code: "1000", rgb: [40, 41, 42] }] }, "x.gpl");
  check(plain[0].brand === "Madeira Rayon" && plain[0].name === "#28292A", "import: a plain palette's brand is its name, a nameless colour its hex");
  check(spoolsOfPalette({ name: "My threads", entries: [{ name: "Red", code: "1", rgb: [1, 2, 3] }] }, "x.gpl")[0].brand === "", "import: an old My threads export has no brand");
}

// --- installed chart ids ------------------------------------------------------------
{
  check(chartIdFor("Madeira Classic", []) === "custom/madeira-classic", "chart id: from the name");
  check(chartIdFor("Madeira Classic", [{ id: "custom/x", name: "Madeira Classic" }]) === "custom/x", "chart id: installed again keeps its id (replaced)");
  const ru = chartIdFor("Нитки Гамма", []);
  const jp = chartIdFor("刺繍糸", [{ id: ru, name: "Нитки Гамма" }]);
  check(ru !== "custom/-" && ru.startsWith("custom/palette-") && jp !== ru, `chart id: names without Latin letters get distinct ids (${ru}, ${jp})`);
  const taken = chartIdFor("Foo!", [{ id: "custom/foo", name: "Foo?" }]);
  check(taken !== "custom/foo" && taken.startsWith("custom/foo-"), "chart id: an id another name has is not taken over");
  check(chartIdFor("刺繍糸", [{ id: jp, name: "other" }]) !== jp, "chart id: even a hash another chart has is not reused");
}

// --- editing a spool's colour ---------------------------------------------------------
{
  const t = { color: "#c8102e", brand: "Madeira", code: "1147" };
  check(colourEdit(t, "#c8102f").code === "1147", "colour edit: within ΔE 1 the spool stays");
  const far = colourEdit(t, "#2050c0");
  check(far.code === "" && far.brand === "" && far.color === "#2050c0", "colour edit: further away, brand and code go");
  check(colourEdit(t, "#c8102e", "#c8102e").brand === "Madeira", "colour edit: back to the spool's colour, they come back");
  check(colourEdit(t, "#c8102e", "#2050c0").code === "", "colour edit: measured from the chart's colour of the spool");
  check(!("code" in colourEdit({ color: "#000000", brand: "", code: "" }, "#ffffff")), "colour edit: a thread without a spool only changes colour");
}

// --- merging similar colours ------------------------------------------------------------
{
  const th = (id: string, color: string, p: Partial<{ brand: string; code: string }> = {}) => ({ id, name: id, color, brand: "", code: "", ...p });
  const threads = [th("a", "#c8102e"), th("b", "#c9112f"), th("c", "#ca1230"), th("d", "#2050c0")];
  const uses = (id: string) => ({ a: 5, b: 1, c: 1, d: 3 })[id] ?? 0;
  const m = similarMerges(threads, uses, new Set(), 6);
  check(m.get("b") === "a" && m.get("c") === "a" && m.size === 2, "merge: the most used red keeps, the others join it");
  const locked = similarMerges(threads, uses, new Set(["b"]), 6);
  check(!locked.has("b") && locked.get("c") === "a", "merge: a locked thread keeps its spool");
  const lockedKeeper = similarMerges(threads, uses, new Set(["a"]), 6);
  check(lockedKeeper.get("b") === "a", "merge: a locked thread can still be the one kept");
  const same = [th("a", "#c8102e", { code: "1" }), th("b", "#c8102e", { code: "1" }), th("c", "#c9112f")];
  const ms = similarMerges(same, (id) => (id === "a" ? 2 : 1), new Set(), 6);
  check(!ms.has("b") && ms.get("c") === "a" && ms.size === 1, "merge: threads already on the spool are not counted as merged");
}

// --- sew order ------------------------------------------------------------------------------
{
  const obj = (id: string, thread: string, text?: Partial<TextSpec>) => ({ id, thread, text }) as unknown as DesignObject;
  const threads = [{ id: "unused" }, { id: "p1" }, { id: "s" }, { id: "p0" }, { id: "x" }];
  // the lettering's second font colour isn't sewn by any letter here, but it's the lettering's
  const objects = [obj("s1", "s"), obj("l1", "p0", { thread: "p0", borderThread: "p0", palette: ["p0", "p1"] }), obj("x1", "x")];
  const order = bySewOrder(threads, objects).map((t) => t.id);
  check(order.join(",") === "s,p0,p1,x,unused", `sew order: lettering palette threads with their lettering, unused last (${order.join(",")})`);
}

console.log(failed ? `${failed} FAILED` : "all passed");
if (failed) throw new Error(`${failed} thread tool checks failed`);
