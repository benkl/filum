// Export targets beyond a single machine file: pictures (Ink/Stitch PNG
// realistic / simple), Ink/Stitch's thread list, and several files at once in
// a ZIP (Ink/Stitch zip.py, with its file names and "panelization" repeats).

import { engine } from "../engine/client";
import { useStore } from "../store";
import type { ExportOptions, StitchDocument } from "../types";
import { PICTURE_DEFAULTS, planPng, type PictureBackground } from "./planImage";
import { saveFile } from "./platform";
import { zip } from "./zip";
import { projectBytes } from "./projectFile";

/** Picture targets and Ink/Stitch's thread list (not engine formats). */
export const PNG_TARGETS = ["png_realistic", "png_simple"] as const;
export const isPicture = (t: string) => (PNG_TARGETS as readonly string[]).includes(t);

export interface PictureSettings {
  /** Ink/Stitch `dpi-realistic` / `dpi-simple` (300). */
  dpiRealistic: number;
  dpiSimple: number;
  /** Ink/Stitch `png-simple-line-width` (mm, 0.3). */
  lineWidth: number;
  background: PictureBackground;
}

export const PICTURE_SETTINGS: PictureSettings = {
  dpiRealistic: PICTURE_DEFAULTS.dpi,
  dpiSimple: PICTURE_DEFAULTS.dpi,
  lineWidth: PICTURE_DEFAULTS.lineWidth,
  background: "transparent",
};

/** The file extension a target is saved with. */
export const targetExtension = (t: string) => (isPicture(t) ? "png" : t === "threadlist" ? "txt" : t);

/**
 * File name of a target. In a ZIP every file follows Ink/Stitch: `name.ext`,
 * `name_threadlist.txt`, `name_realistic.png`, `name_simple.png`; on its own a
 * picture is just `name.png`.
 */
export function targetFileName(t: string, name: string, inZip: boolean): string {
  if (t === "threadlist") return `${name}${inZip ? "_threadlist" : ""}.txt`;
  if (t === "png_realistic") return `${name}${inZip ? "_realistic" : ""}.png`;
  if (t === "png_simple") return `${name}${inZip ? "_simple" : ""}.png`;
  return `${name}.${t}`;
}

/** Bytes of one target. */
export async function targetBytes(doc: StitchDocument, t: string, opts: ExportOptions, pics: PictureSettings): Promise<Uint8Array> {
  if (isPicture(t)) {
    const plan = await engine.exportPlan(doc, opts);
    if (!plan.flags.length) throw new Error("nothing to export — the design has no stitches");
    const realistic = t === "png_realistic";
    return planPng(plan, {
      kind: realistic ? "realistic" : "simple",
      dpi: realistic ? pics.dpiRealistic : pics.dpiSimple,
      lineWidth: pics.lineWidth,
      background: pics.background,
      fabricColor: useStore.getState().fabricColor,
      threadWeight: doc.options?.threadWeight,
    });
  }
  if (t === "filum") return projectBytes(doc);
  return engine.export(doc, t, opts);
}

/** Save one target as a file. */
export async function exportTarget(t: string, opts: ExportOptions, pics: PictureSettings, name: string) {
  const s = useStore.getState();
  const file = targetFileName(t, name, false);
  try {
    const bytes = await targetBytes(s.doc, t, opts, pics);
    const ext = targetExtension(t);
    const path = await saveFile(file, bytes, [{ name: ext.toUpperCase(), extensions: [ext] }]);
    if (path) s.toast(`Exported ${file}`, "success");
  } catch (e) {
    s.toast(`Export failed: ${(e as Error).message}`, "error");
  }
}

/** Ink/Stitch ZIP export: every chosen target in one archive. */
export async function exportZip(targets: string[], opts: ExportOptions, pics: PictureSettings, name: string) {
  const s = useStore.getState();
  if (!targets.length) return s.toast("No file formats selected", "error");
  try {
    const entries = [];
    for (const t of targets) entries.push({ name: targetFileName(t, name, true), bytes: await targetBytes(s.doc, t, opts, pics) });
    const path = await saveFile(`${name}.zip`, zip(entries), [{ name: "ZIP archive", extensions: ["zip"] }]);
    if (path) s.toast(`Exported ${name}.zip · ${entries.length} file${entries.length === 1 ? "" : "s"}`, "success");
  } catch (e) {
    s.toast(`Export failed: ${(e as Error).message}`, "error");
  }
}
