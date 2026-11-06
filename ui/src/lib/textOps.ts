// Store-level operations for parametric lettering.

import { activeThreadOf, useStore } from "../store";
import type { DesignObject, Vec2 } from "../types";
import { DEFAULT_FONT, fontLabel, loadFont } from "./fonts";
import { uid } from "./geometry";
import { flattenSubPath } from "./bezier";
import { DEFAULT_TEXT, generateText, members, type TextSpec } from "./text";
import { batchFileName, fontSampleText } from "./letteringTools";
import type { ZipEntry } from "./zip";
import { engine } from "../engine/client";

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
  localStorage.setItem(LAST_KEY, JSON.stringify({ font, size, style, borderWidth, lineSpacing, align, fillAngle }));
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

const seq = new Map<string, number>();

/**
 * Regenerate a lettering with a changed spec. `live` updates without adding
 * an undo step (call `useStore.getState().checkpoint()` once before a live
 * edit session). Out-of-order results of fast edits are dropped.
 */
export async function updateText(group: string, patch: Partial<TextSpec>, live = false): Promise<void> {
  const cur = textSpec(group);
  if (!cur) return;
  let spec: TextSpec = { ...cur, ...patch, role: undefined, colorIndex: undefined };
  // another font has other colours
  if (patch.font && patch.font !== cur.font && !patch.palette) spec.palette = undefined;
  const n = (seq.get(group) ?? 0) + 1;
  seq.set(group, n);
  let objs: DesignObject[];
  try {
    spec = await withPalette(spec);
    objs = await generateText(spec);
  } catch (e) {
    useStore.getState().toast(`Lettering: ${(e as Error).message}`, "error");
    return;
  }
  if (seq.get(group) !== n) return; // a newer edit is on its way
  if (!objs.length) {
    // nothing to stitch (font lacks these letters): keep the current lettering
    if (spec.content.trim() && !live) useStore.getState().toast(`${fontLabel(spec.font)} has no letters for this text`, "error");
    return;
  }
  const s = useStore.getState();
  const old = members(s.doc.objects, group);
  if (!old.length) return;
  const wasSelected = old.some((o) => s.selection.includes(o.id));
  const keepVisible = old.every((o) => o.visible);
  if (!keepVisible) for (const o of objs) o.visible = false;
  const apply = (d: typeof s.doc) => {
    const at = d.objects.findIndex((o) => o.text?.group === group);
    const rest = d.objects.filter((o) => o.text?.group !== group);
    const objects = [...rest.slice(0, at), ...objs, ...rest.slice(at)];
    return { ...d, objects };
  };
  if (live) s.liveUpdate(apply);
  else s.commit(apply);
  if (wasSelected) useStore.getState().select(objs.map((o) => o.id));
  remember(spec);
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
  s.commit((d) => ({ ...d, objects: d.objects.filter((o) => o.id !== line.id) }));
  await updateText(group, { path, pathAlign: textSpec(group)?.pathAlign ?? "center" });
  return null;
}

/** Regenerate every lettering that uses a font (after its font info changed). */
export async function refreshLetterings(fontKey: string): Promise<number> {
  const groups = [...new Set(useStore.getState().doc.objects.filter((o) => o.text?.font === fontKey).map((o) => o.text!.group))];
  for (const g of groups) await updateText(g, {});
  return groups.length;
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
