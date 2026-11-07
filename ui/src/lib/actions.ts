import { engine, type SvgText } from "../engine/client";
import { machineById, presetById } from "./machines";
import { conjugate, makeClone } from "./clones";
import { emptyDoc, useStore } from "../store";
import type { DesignObject, ExportOptions, StitchDocument } from "../types";
import { objectBounds, transformObject, translateMat, unionBoxes, uid } from "./geometry";
import { dec, enc, isTauri, openFile, saveFile } from "./platform";
import { pendingThreadList, THREAD_LIST_EXT } from "./threadList";
import { freshCopies } from "./copies";
import { checkDoc } from "./docCheck";

// every embroidery format the engine reads (crates/formats), extension aliases included
export const MACHINE_EXT = [
  ...["dst", "pes", "pec", "jef", "exp", "vp3", "xxx", "u01", "u00", "u02", "tbf", "sew"],
  ...["hus", "shv", "pcs", "pcd", "pcq", "pcm", "ksm", "max", "spx", "phb", "phc", "jpx"],
  ...["dsb", "dsz", "zxy", "tap", "dat", "stx", "emd", "exy", "e00", "e01", "e02", "fxy", "f00", "f01", "f02"],
  ...["zhs", "10o", "100", "bro", "gt", "inb", "mit", "new", "stc"],
];
const IMAGE_EXT = ["png", "jpg", "jpeg", "webp", "bmp", "gif"];

export const fit = (what: "hoop" | "design" | number = "hoop") =>
  window.dispatchEvent(new CustomEvent("filum:fit", { detail: what }));

function loadDoc(doc: StitchDocument, path: string | null) {
  const s = useStore.getState();
  // a design from a file: the fields every part of the app reads are there
  const checked = checkDoc(doc, emptyDoc());
  if (!checked) throw new Error("not a Filum design");
  if (checked.dropped) s.toast(`${checked.dropped} damaged object${checked.dropped === 1 ? " was" : "s were"} left out`, "error");
  s.setDoc(checked.doc);
  s.set({ filePath: path, saved: true, past: [], future: [], selection: [], nodeSel: [], gradNodes: [], activeThread: null, anim: { ...s.anim, index: null, playing: false } });
  setTimeout(() => fit("hoop"), 0);
}

/** Whether the design may be replaced: saved, empty, or the user says so. */
export function confirmDiscard(): boolean {
  const s = useStore.getState();
  return s.saved || !s.doc.objects.length || confirm("Discard unsaved changes?");
}

export function newDocument() {
  if (!confirmDiscard()) return;
  loadDoc(newDesign(), null);
}

/** An empty design on the machine and hoop chosen for new designs (Preferences ▸ Export). */
export function newDesign() {
  const doc = emptyDoc();
  const preset = presetById(localStorage.getItem("filum.machine") ?? "");
  if (!preset) return doc;
  const m = machineById(preset.id);
  const f = m.frames.find((x) => x.id === localStorage.getItem("filum.frame"));
  return {
    ...doc,
    machine: { ...preset.values, profile: preset.id },
    ...(f ? { hoop: { name: `${m.brand} ${f.name}`.trim(), width: f.width, height: f.height, ...(f.shape ? { shape: f.shape } : {}) } } : {}),
  };
}

/** `launch`: a file Filum was opened with replaces the design (once it has loaded; the user was asked already). */
async function handleBytes(name: string, path: string | null, bytes: Uint8Array, mode: "open" | "import" | "launch") {
  const s = useStore.getState();
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  try {
    if (IMAGE_EXT.includes(ext)) {
      pending.image = { name, bytes };
      s.setDialog("digitize");
      return;
    }
    // thread lists: apply their colours to the design (Ink/Stitch apply thread list)
    if (THREAD_LIST_EXT.includes(ext)) {
      Object.assign(pendingThreadList, { name, bytes });
      s.setDialog("threadlist");
      return;
    }
    let doc: StitchDocument;
    let warnings: string[] = [];
    if (ext === "svg") {
      const r = await engine.importSvg(dec.decode(bytes));
      doc = await withSvgTexts(r.document, r.texts ?? []);
      warnings = r.warnings;
      doc.name = name.replace(/\.[^.]+$/, "");
    } else if (ext === "filum" || ext === "json") {
      doc = JSON.parse(dec.decode(bytes));
    } else {
      doc = await engine.importEmbroidery(bytes, name);
    }
    if (mode === "launch" || (mode === "open" && (ext === "filum" || ext === "json" || !s.doc.objects.length))) {
      if (mode !== "launch" && !confirmDiscard()) return;
      loadDoc(doc, ext === "filum" ? path : null);
    } else {
      // merge into the current design, centred in the hoop
      const box = unionBoxes(doc.objects.map(objectBounds));
      const dx = box ? s.doc.hoop.width / 2 - (box.x + box.w / 2) : 0;
      const dy = box ? s.doc.hoop.height / 2 - (box.y + box.h / 2) : 0;
      const m = translateMat(dx, dy);
      // its groups, letterings, gradients and blends get new ids (it may be the same file again);
      // threads of a colour the design has are shared (addObjects)
      const fresh = freshCopies(doc, doc.objects);
      const objs = fresh.objects.map((o) => {
        const t = transformObject(o, m);
        // a clone moved with its original keeps its place relative to it
        return o.clone ? { ...t, clone: { ...conjugate(o.clone, m), of: fresh.ids.get(o.clone.of) ?? o.clone.of } } : t;
      });
      s.addObjects(objs, doc.threads, fresh.parents, fresh.names);
      s.select(objs.map((o) => o.id));
    }
    for (const w of warnings) s.toast(w);
    s.toast(`Loaded ${name}`, "success");
  } catch (e) {
    s.toast(`Could not open ${name}: ${(e as Error).message}`, "error");
  }
}

export async function openDocument() {
  const f = await pickFile([
    { name: "All supported", extensions: ["filum", "svg", ...MACHINE_EXT, ...IMAGE_EXT] },
    { name: "Filum project", extensions: ["filum"] },
    { name: "Ink/Stitch SVG", extensions: ["svg"] },
    { name: "Embroidery files", extensions: MACHINE_EXT },
  ]);
  if (f) await handleBytes(f.name, f.path, f.bytes, "open");
}

/** The file picker; a file that can't be read says so. */
async function pickFile(filters: Parameters<typeof openFile>[0]) {
  try {
    return await openFile(filters);
  } catch (e) {
    useStore.getState().toast(`Could not open the file: ${(e as Error)?.message ?? e}`, "error");
    return null;
  }
}

export async function importFile() {
  const f = await pickFile([
    { name: "Artwork & embroidery", extensions: ["svg", ...MACHINE_EXT, ...IMAGE_EXT] },
  ]);
  if (f) await handleBytes(f.name, f.path, f.bytes, "import");
}

/**
 * Desktop: open the file Filum was started with ("Open with Filum",
 * a double-clicked design or picture), and on macOS the files the system hands
 * over while it runs. A file opened at launch replaces the restored design
 * instead of being merged into it.
 */
export async function openLaunchFiles() {
  if (!isTauri) return;
  const [{ invoke }, { listen }, { readFile }] = await Promise.all([
    import("@tauri-apps/api/core"),
    import("@tauri-apps/api/event"),
    import("@tauri-apps/plugin-fs"),
  ]);
  const openQueued = async () => {
    const [path, ...rest] = await invoke<string[]>("startup_files");
    if (!path) return;
    const s = useStore.getState();
    // a restored design with unsaved changes is asked about at launch too
    if (!confirmDiscard()) return;
    const name = path.split(/[\\/]/).pop() ?? path;
    let bytes: Uint8Array;
    try {
      bytes = await readFile(path);
    } catch (e) {
      s.toast(`Could not open ${name}: ${(e as Error).message ?? e}`, "error");
      return;
    }
    // replaced only once the file has loaded (a broken file leaves the design as it was)
    await handleBytes(name, path, bytes, "launch");
    if (rest.length) s.toast(`Opened ${name}. Open the other ${rest.length === 1 ? "file" : `${rest.length} files`} with File → Open…`);
  };
  await listen("open-files", () => void openQueued());
  await openQueued();
}

export async function openDroppedFile(file: File) {
  await handleBytes(file.name, null, new Uint8Array(await file.arrayBuffer()), "import");
}

export async function saveDocument(saveAs = false): Promise<boolean> {
  const s = useStore.getState();
  const doc = s.doc;
  const bytes = enc.encode(JSON.stringify(doc, null, 1));
  let path: string | null;
  try {
    path = await saveFile(`${doc.name || "design"}.filum`, bytes, [{ name: "Filum project", extensions: ["filum"] }], saveAs ? null : s.filePath);
  } catch (e) {
    s.toast(`Could not save: ${(e as Error)?.message ?? e}`, "error");
    return false;
  }
  if (!path) return false;
  // saved is what was written: edits made while the file was written stay unsaved
  s.set({ saved: useStore.getState().doc === doc, filePath: path.includes("/") || path.includes("\\") ? path : s.filePath });
  s.toast("Saved", "success");
  return true;
}

/** Export; `fileName` (without extension) defaults to the document name. */
export async function exportDesign(format: string, opts: ExportOptions = {}, fileName?: string) {
  const s = useStore.getState();
  try {
    const bytes = await engine.export(s.doc, format, opts);
    const name = `${fileName || s.doc.name || "design"}.${format}`;
    const path = await saveFile(name, bytes, [{ name: format.toUpperCase(), extensions: [format] }]);
    if (path) s.toast(`Exported ${name}`, "success");
  } catch (e) {
    s.toast(`Export failed: ${(e as Error).message}`, "error");
  }
}

export async function optimizeOrder() {
  const s = useStore.getState();
  if (!s.doc.objects.length) return;
  const r = await engine.optimize(s.doc);
  // the order applied to the design as it is now: edits made meanwhile stay, new objects go last
  s.commit((d) => {
    const byId = new Map(d.objects.map((o) => [o.id, o]));
    const ordered = r.order.map((id) => byId.get(id)).filter((o): o is DesignObject => !!o);
    const placed = new Set(ordered.map((o) => o.id));
    return { ...d, objects: [...ordered, ...d.objects.filter((o) => !placed.has(o.id))] };
  });
  s.toast(
    `Optimised: colour changes ${r.colorChangesBefore} → ${r.colorChangesAfter}, travel ${Math.round(r.travelBeforeMm)} → ${Math.round(r.travelAfterMm)} mm`,
    "success",
  );
}

export function selectAll() {
  const s = useStore.getState();
  s.select(s.doc.objects.filter((o) => o.visible && !o.locked).map((o) => o.id));
}

export function nudge(dx: number, dy: number) {
  const s = useStore.getState();
  if (!s.selection.length) return;
  const m = translateMat(dx, dy);
  s.commit((d) => ({ ...d, objects: d.objects.map((o) => (s.selection.includes(o.id) && !o.locked ? transformObject(o, m) : o)) }));
}

export function centerInHoop() {
  const s = useStore.getState();
  const ids = s.selection.length ? s.selection : s.doc.objects.map((o) => o.id);
  const box = unionBoxes(s.doc.objects.filter((o) => ids.includes(o.id)).map(objectBounds));
  if (!box) return;
  const m = translateMat(s.doc.hoop.width / 2 - (box.x + box.w / 2), s.doc.hoop.height / 2 - (box.y + box.h / 2));
  s.commit((d) => ({ ...d, objects: d.objects.map((o) => (ids.includes(o.id) ? transformObject(o, m) : o)) }));
}

/** Hand-off slots for dialogs opened by other parts of the UI. */
/** What the digitizer opens with: a picture, and the output (shapes or cross stitch). */
export const pending: { image: { name: string; bytes: Uint8Array } | null; output: "shapes" | "cross" | null } = {
  image: null,
  output: null,
};

/** Open the digitizer, optionally set to an output (cross stitch from a picture). */
export function openDigitizer(output?: "shapes" | "cross") {
  pending.output = output ?? null;
  useStore.getState().setDialog("digitize");
}

/** Linked clones of the selection (Alt+D): they follow their originals. */
export function cloneSelection() {
  const s = useStore.getState();
  const sel = s.doc.objects.filter((o) => s.selection.includes(o.id));
  if (!sel.length) return;
  const clones = sel.map((o) => makeClone(o));
  s.addObjects(clones);
  s.select(clones.map((c) => c.id));
  s.toast(`${clones.length} clone${clones.length > 1 ? "s" : ""}: they follow the original${clones.length > 1 ? "s" : ""} — edit an original to change its clones`);
}

/**
 * SVG <text> as lettering (Ink/Stitch asks to convert text to paths first):
 * each text set in the default font at its size and colour, where it was
 * in the sewing order, aligned like the SVG text.
 */
export async function withSvgTexts(doc: StitchDocument, texts: SvgText[]): Promise<StitchDocument> {
  if (!texts.length) return doc;
  const { createLettering } = await import("./textOps");
  const objects = [...doc.objects];
  const threads = [...doc.threads];
  // last first, so the sewing positions stay valid; texts at one position
  // also last first (reversed before the stable sort), so they keep document order
  for (const t of [...texts].reverse().sort((a, b) => b.index - a.index)) {
    let thread = threads.find((x) => x.color.toLowerCase() === t.color.toLowerCase());
    if (!thread) {
      thread = { id: uid("t"), name: t.color, color: t.color, brand: "", code: "" };
      threads.push(thread);
    }
    // SVG sizes are the em; lettering sizes the capitals (about 0.7 em)
    let objs = await createLettering(t.text, [t.x, t.y], Math.max(3, t.size * 0.7), thread.id);
    if (!objs.length) continue;
    const box = unionBoxes(objs.map(objectBounds));
    if (box) {
      // the SVG text starts (or is centred / ends) at x, on the baseline at y
      const ax = t.anchor === "middle" ? box.x + box.w / 2 : t.anchor === "end" ? box.x + box.w : box.x;
      const m = translateMat(t.x - ax, t.y - (box.y + box.h));
      objs = objs.map((o) => transformObject(o, m));
    }
    objects.splice(Math.min(t.index, objects.length), 0, ...objs);
  }
  return { ...doc, objects, threads };
}
