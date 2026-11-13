// A design read from a file or the autosave, made safe to load: the fields
// every part of the app reads are there and of the right kind. Objects that
// can't be drawn at all are left out (and counted).

import type { DesignObject, StitchDocument } from "../types";
import { defaultDesignOptions } from "./geometry";

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const finite2 = (v: unknown) => Array.isArray(v) && v.length >= 2 && Number.isFinite(v[0]) && Number.isFinite(v[1]);

function usable(o: unknown): o is DesignObject {
  if (!isObj(o) || typeof o.id !== "string" || !o.id) return false;
  if (!Array.isArray(o.paths) || !isObj(o.stitch) || typeof o.stitch.type !== "string") return false;
  return o.paths.every((sp) => isObj(sp) && Array.isArray(sp.nodes) && sp.nodes.every((n) => isObj(n) && finite2(n.p)));
}

/**
 * `raw` on top of `base` (an empty design): null when it isn't a design at
 * all, else the design and how many objects were left out.
 */
export function checkDoc(raw: unknown, base: StitchDocument): { doc: StitchDocument; dropped: number } | null {
  if (!isObj(raw) || !Array.isArray(raw.objects)) return null;
  const objects = raw.objects.filter(usable).map((o) => ({
    ...o,
    name: typeof o.name === "string" ? o.name : "Object",
    visible: o.visible !== false,
    locked: !!o.locked,
  }));
  // unique ids (a hand-edited or merged file may repeat one)
  const seen = new Set<string>();
  const unique = objects.filter((o) => !seen.has(o.id) && !!seen.add(o.id));
  const threads = Array.isArray(raw.threads) ? raw.threads.filter((t) => isObj(t) && typeof t.id === "string" && typeof t.color === "string") : [];
  const doc = {
    ...base,
    ...raw,
    objects: unique,
    threads: threads as StitchDocument["threads"],
    machine: { ...base.machine, ...(isObj(raw.machine) ? raw.machine : {}) },
    hoop: isObj(raw.hoop) && Number.isFinite(raw.hoop.width) && Number.isFinite(raw.hoop.height) ? (raw.hoop as unknown as StitchDocument["hoop"]) : base.hoop,
  } as StitchDocument;
  // options: as saved over the defaults (an older file lacks newer ones); none saved: left out,
  // so the panels show the defaults (`d.options ?? defaultDesignOptions()`)
  if (isObj(raw.options)) doc.options = { ...defaultDesignOptions(), ...base.options, ...raw.options } as StitchDocument["options"];
  else if (base.options) doc.options = base.options;
  else delete doc.options;
  // every object's thread exists (a missing one gets the first, or a default)
  if (!doc.threads.length && unique.length) doc.threads = [{ id: "t1", name: "Thread", color: "#1f2a56", brand: "", code: "" } as StitchDocument["threads"][number]];
  const ids = new Set(doc.threads.map((t) => t.id));
  const known = (id: unknown): id is string => typeof id === "string" && ids.has(id);
  doc.objects = doc.objects.map((o) => {
    const fixed = known(o.thread) ? o : { ...o, thread: doc.threads[0].id };
    const t = fixed.text;
    if (!isObj(t)) return fixed;
    // a lettering's threads too: its colour, its edge colour, its font colours
    const thread = known(t.thread) ? t.thread : fixed.thread;
    const borderThread = known(t.borderThread) ? t.borderThread : thread;
    const palette = Array.isArray(t.palette) ? t.palette.map((id) => (known(id) ? id : thread)) : t.palette;
    if (thread === t.thread && borderThread === t.borderThread && (!Array.isArray(t.palette) || palette!.every((id, i) => id === t.palette![i]))) return fixed;
    return { ...fixed, text: { ...t, thread, borderThread, ...(palette ? { palette } : {}) } };
  });
  // a design from Filum 0.2.0 or earlier: its embroidery-font letterings keep
  // their spacing in mm until they are laid out again (then it is converted)
  const version = typeof raw.version === "number" ? raw.version : 1;
  if (version < 2) {
    doc.objects = doc.objects.map((o) => {
      const t = o.text;
      const emb = !!t && typeof t.font === "string" && (t.font.startsWith("emb:") || t.font.startsWith("inkfont:"));
      return emb && (t.letterSpacing || t.wordSpacing) ? { ...o, text: { ...t, legacySpacing: true } } : o;
    });
  }
  doc.version = Math.max(version, DOC_VERSION);
  return { doc, dropped: raw.objects.length - unique.length };
}

/** The version of the designs this Filum writes. 2: embroidery-font lettering
 *  spacing at the font's own size (`TextSpec.legacySpacing` marks older ones). */
export const DOC_VERSION = 2;
