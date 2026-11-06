// Store-level operations for parametric lettering.

import { activeThreadOf, useStore } from "../store";
import type { DesignObject, StitchDocument, Vec2 } from "../types";
import { DEFAULT_FONT, fontLabel, loadFont } from "./fonts";
import { uid } from "./geometry";
import { flattenSubPath } from "./bezier";
import { DEFAULT_TEXT, generateText, members, type TextSpec } from "./text";
import { batchFileName, fontSampleText } from "./letteringTools";
import { carryOver } from "./textSettle";
import type { ZipEntry } from "./zip";
import { engine } from "../engine/client";
import { safeSetItem } from "./storage";

const LAST_KEY = "filum.textDefaults";

/** Last used font / size / style become the defaults for new text. */
function defaults(): Partial<TextSpec> {
  try {
    return JSON.parse(localStorage.getItem(LAST_KEY) ?? "{}");
  } catch {
    return {};
  }
}
function remember(s: TextSpec) {
  // per-lettering layout (spacing, arc, rotation) is not carried over to new text
  const { font, size, style, borderWidth, lineSpacing, align, fillAngle } = s;
  safeSetItem(LAST_KEY, JSON.stringify({ font, size, style, borderWidth, lineSpacing, align, fillAngle }));
}

/** The lettering group of the current selection (all selected objects in one group). */
export function selectedTextGroup(): string | null {
  const s = useStore.getState();
  if (!s.selection.length) return null;
  const objs = s.doc.objects.filter((o) => s.selection.includes(o.id));
  const g = objs[0]?.text?.group;
  return g && objs.every((o) => o.text?.group === g) ? g : null;
}

export function textSpec(group: string): TextSpec | null {
  return useStore.getState().doc.objects.find((o) => o.text?.group === group)?.text ?? null;
}

export function selectGroup(group: string) {
  const s = useStore.getState();
  s.select(members(s.doc.objects, group).map((o) => o.id));
}

/**
 * Multi-colour embroidery fonts keep their own colours by default: one thread
 * per font colour (reused when the design already has that colour).
 */
async function withPalette(spec: TextSpec): Promise<TextSpec> {
  const f = await loadFont(spec.font);
  if (f.kind !== "embroidery" || f.colors.length < 2) return { ...spec, palette: undefined };
  if (spec.palette && spec.palette.length >= f.colors.length) return spec;
  const s = useStore.getState();
  const palette = f.colors.map((c, i) =>
    spec.palette?.[i] ?? (/^#[0-9a-f]{6}$/i.test(c) ? s.ensureThread(c, `${f.name} ${i + 1}`) : spec.thread),
  );
  return { ...spec, palette };
}

/** New lettering at `p` with the last used settings (and `patch`); returns its group. */
export async function createTextAt(p: Vec2, content = "Text", patch: Partial<TextSpec> = {}): Promise<string> {
  const s = useStore.getState();
  let thread = activeThreadOf(s) ?? s.doc.threads[0]?.id;
  if (!thread) thread = s.ensureThread("#1f2a56", "Navy");
  const d = defaults();
  const spec: TextSpec = {
    ...DEFAULT_TEXT,
    ...d,
    letterSpacing: 0,
    font: d.font ?? DEFAULT_FONT,
    content,
    group: uid("txt"),
    anchor: p,
    rotation: 0,
    arc: 0,
    thread,
    borderThread: thread,
    ...patch,
  };
  let objs = await generateText(await withPalette(spec));
  if (!objs.length && spec.font !== DEFAULT_FONT) {
    // the remembered font has no glyphs for this text (e.g. a Hebrew-only font)
    useStore.getState().toast(`${fontLabel(spec.font)} has no letters for “${content}” — using ${fontLabel(DEFAULT_FONT)}`);
    objs = await generateText(await withPalette({ ...spec, font: DEFAULT_FONT, palette: undefined }));
  }
  useStore.getState().addObjects(objs);
  useStore.getState().select(objs.map((o) => o.id));
  return spec.group;
}

/** Is a lettering locked (any of its letters)? Locked letterings are not regenerated. */
export function textLocked(group: string): boolean {
  return members(useStore.getState().doc.objects, group).some((o) => o.locked);
}

let lockToastAt = 0;
/** Tell that a lettering is locked (once in a while: sliders and typing ask many times). */
export function lockedToast() {
  const now = Date.now();
  if (now - lockToastAt < 2000) return;
  lockToastAt = now;
  useStore.getState().toast("The lettering is locked — unlock it in Layers to edit it", "error");
}

/** A spec as a key (the per-letter fields left out). */
function specKey(spec: TextSpec): string {
  const rest: Record<string, unknown> = { ...spec };
  delete rest.role;
  delete rest.colorIndex;
  delete rest.fontFill;
  return JSON.stringify(rest, Object.keys(rest).sort());
}

/** The last layout of each lettering, by its spec: what the font gave its letters (see carryOver). */
const lastLayout = new Map<string, { key: string; objs: DesignObject[] }>();

/** A lettering's current spec laid out again (null if its font can't be loaded). */
async function layoutOf(group: string, spec: TextSpec): Promise<DesignObject[] | null> {
  const key = specKey(spec);
  const hit = lastLayout.get(group);
  if (hit?.key === key) return hit.objs;
  try {
    const objs = await generateText({ ...spec, role: undefined, colorIndex: undefined });
    lastLayout.set(group, { key, objs });
    return objs;
  } catch {
    return null;
  }
}

interface Edit {
  patch: Partial<TextSpec>;
  live: boolean;
  /** More changes in the same undo step (applied after the lettering's). */
  also?: (d: StitchDocument) => StitchDocument;
  done: ((applied: boolean) => void)[];
}
/** Edits waiting while one of the same lettering is generated: merged into one. */
const waiting = new Map<string, Edit>();
const busy = new Set<string>();

/**
 * Regenerate a lettering with a changed spec. `live` updates without adding
 * an undo step (call `useStore.getState().checkpoint()` once before a live
 * edit session). Edits of one lettering run one after the other: edits made
 * while one is generated (a font loading) are merged into one, which starts
 * from the lettering as it is then. A result whose lettering changed
 * meanwhile (undo, another document) is dropped. Locked letterings are
 * refused. Resolves to whether the edit was applied.
 */
export function updateText(group: string, patch: Partial<TextSpec>, live = false): Promise<boolean> {
  return queueEdit(group, patch, live);
}

function queueEdit(group: string, patch: Partial<TextSpec>, live: boolean, also?: Edit["also"]): Promise<boolean> {
  if (textLocked(group)) {
    lockedToast();
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    const w = waiting.get(group);
    if (w) {
      w.patch = { ...w.patch, ...patch };
      w.live = w.live && live;
      if (also) {
        const prev = w.also;
        w.also = prev ? (d) => also(prev(d)) : also;
      }
      w.done.push(resolve);
    } else waiting.set(group, { patch, live, also, done: [resolve] });
    if (!busy.has(group)) void drain(group);
  });
}

async function drain(group: string) {
  busy.add(group);
  try {
    for (let e = waiting.get(group); e; e = waiting.get(group)) {
      waiting.delete(group);
      let ok = false;
      try {
        ok = await applyEdit(group, e);
      } catch (err) {
        useStore.getState().toast(`Lettering: ${(err as Error).message}`, "error");
      }
      for (const f of e.done) f(ok);
    }
  } finally {
    busy.delete(group);
  }
}

async function applyEdit(group: string, { patch, live, also }: Edit): Promise<boolean> {
  const before = members(useStore.getState().doc.objects, group);
  if (!before.length) return false;
  if (before.some((o) => o.locked)) {
    lockedToast();
    return false;
  }
  // the spec as it is now (earlier edits applied)
  const cur = before[0].text!;
  let spec: TextSpec = { ...cur, ...patch, role: undefined, colorIndex: undefined };
  // another font has other colours
  if (patch.font && patch.font !== cur.font && !patch.palette) spec.palette = undefined;
  let objs: DesignObject[];
  let base: DesignObject[] | null;
  try {
    spec = await withPalette(spec);
    [objs, base] = await Promise.all([generateText(spec), layoutOf(group, cur)]);
  } catch (e) {
    useStore.getState().toast(`Lettering: ${(e as Error).message}`, "error");
    return false;
  }
  const s = useStore.getState();
  const old = members(s.doc.objects, group);
  // undone, replaced or changed otherwise while the font loaded: the result is out of date
  if (old.length !== before.length || old.some((o, i) => o !== before[i])) return false;
  if (!objs.length) {
    // nothing to stitch (font lacks these letters): keep the current lettering
    if (spec.content.trim() && !live) s.toast(`${fontLabel(spec.font)} has no letters for this text`, "error");
    return false;
  }
  lastLayout.set(group, { key: specKey(spec), objs });
  // what was set on the old letters (group, commands, lock, ids for clones …) stays
  const next = carryOver(old, base, objs);
  const wasSelected = old.some((o) => s.selection.includes(o.id));
  const apply = (d: StitchDocument) => {
    const at = d.objects.findIndex((o) => o.text?.group === group);
    const rest = d.objects.filter((o) => o.text?.group !== group);
    const out = { ...d, objects: [...rest.slice(0, at), ...next, ...rest.slice(at)] };
    return also ? also(out) : out;
  };
  if (live) s.liveUpdate(apply);
  else s.commit(apply);
  if (wasSelected) useStore.getState().select(next.map((o) => o.id));
  remember(spec);
  return true;
}

/**
 * Add a lettering object (e.g. recognised text from the digitizer): `anchor`
 * is the centre of the baseline, `size` the cap height (mm).
 */
export async function createLettering(content: string, anchor: Vec2, size: number, thread: string, font?: string): Promise<DesignObject[]> {
  const d = defaults();
  const spec: TextSpec = {
    ...DEFAULT_TEXT,
    ...d,
    font: font ?? d.font ?? DEFAULT_FONT,
    content,
    size: Math.max(3, Math.round(size * 10) / 10),
    align: "center",
    letterSpacing: 0,
    group: uid("txt"),
    anchor,
    rotation: 0,
    arc: 0,
    thread,
    borderThread: thread,
  };
  let objs = await generateText(await withPalette(spec));
  if (!objs.length && spec.font !== DEFAULT_FONT) objs = await generateText(await withPalette({ ...spec, font: DEFAULT_FONT, palette: undefined }));
  return objs;
}

/**
 * Lettering along a path: the selected lettering follows the selected line
 * (Ink/Stitch "Lettering along path"). The line becomes the lettering's
 * guide and is no longer stitched itself.
 */
export async function textOnPath(): Promise<string | null> {
  const s = useStore.getState();
  const sel = s.doc.objects.filter((o) => s.selection.includes(o.id));
  const group = sel.find((o) => o.text)?.text?.group;
  const line = sel.find((o) => !o.text && o.paths.some((sp) => sp.nodes.length >= 2));
  if (!group || !line) return "Select a lettering and a line";
  const sp = line.paths.find((p) => p.nodes.length >= 2)!;
  const path = flattenSubPath(sp, 0.1);
  // one undo step, once the lettering is on the line: the line goes with it
  await queueEdit(group, { path, pathAlign: textSpec(group)?.pathAlign ?? "center" }, false, (d) => ({ ...d, objects: d.objects.filter((o) => o.id !== line.id) }));
  return null;
}

/** Regenerate every lettering that uses a font (after its font info changed). */
export async function refreshLetterings(fontKey: string): Promise<number> {
  // locked letterings stay as they are
  const groups = [...new Set(useStore.getState().doc.objects.filter((o) => o.text?.font === fontKey).map((o) => o.text!.group))].filter((g) => !textLocked(g));
  let n = 0;
  for (const g of groups) if (await updateText(g, {})) n++;
  return n;
}

/**
 * A sample sheet of a font (Ink/Stitch's Font Sampling): every glyph as one
 * editable lettering, lines broken at `maxWidth` mm, placed at the top of
 * the hoop. Returns the lettering's group, or null if the font has no glyphs.
 */
export async function insertFontSample(fontKey: string, opts: { size: number; maxWidth: number; variant?: string }): Promise<string | null> {
  const font = await loadFont(fontKey);
  if (font.kind !== "embroidery") return null;
  const variant = opts.variant && font.variants.includes(opts.variant) ? opts.variant : font.variant;
  const content = await fontSampleText(font, opts.size, opts.maxWidth, variant);
  if (!content) return null;
  const s = useStore.getState();
  const x = Math.max(5, (s.doc.hoop.width - opts.maxWidth) / 2);
  return createTextAt([x, 5 + opts.size], content, { font: fontKey, size: opts.size, align: "left", ...(variant !== font.variant ? { variant } : {}) });
}

/**
 * Batch lettering (Ink/Stitch's batch_lettering.py): the lettering `group`
 * as the template — font, size, spacing, alignment, colours, a path it runs
 * along — filled in with each text; the rest of the design is kept. Every
 * text is exported in every format; returns the files for a ZIP.
 */
export async function batchLettering(
  group: string,
  texts: { index: number; text: string }[],
  formats: string[],
  progress?: (done: number, total: number) => void,
): Promise<{ files: ZipEntry[]; failed: string[] }> {
  const spec = textSpec(group);
  if (!spec) throw new Error("No lettering selected");
  const doc = useStore.getState().doc;
  const at = doc.objects.findIndex((o) => o.text?.group === group);
  const rest = doc.objects.filter((o) => o.text?.group !== group);
  const files: ZipEntry[] = [];
  const failed: string[] = [];
  for (let i = 0; i < texts.length; i++) {
    const { index, text } = texts[i];
    progress?.(i, texts.length);
    try {
      const objs = await generateText({ ...spec, content: text, role: undefined, colorIndex: undefined });
      if (!objs.length) throw new Error("no letters");
      const one = { ...doc, name: text.split("\n")[0], objects: [...rest.slice(0, at), ...objs, ...rest.slice(at)] };
      for (const fmt of formats) files.push({ name: batchFileName(index, text, fmt), bytes: await engine.export(one, fmt) });
    } catch (e) {
      failed.push(`${text.split("\n")[0]}: ${(e as Error).message}`);
    }
  }
  progress?.(texts.length, texts.length);
  return { files, failed };
}
