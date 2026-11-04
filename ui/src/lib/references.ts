// Reference pictures: images placed on the canvas to trace over. They live in
// the document (saved, undoable) but are never stitched or sent to the engine.

import { useStore } from "../store";
import type { ReferenceImage, Vec2 } from "../types";
import { uid } from "./geometry";

/** Longest side kept for a reference picture (px); larger ones are scaled down. */
const MAX_PX = 2400;

// ---------------------------------------------------------------------------
// decoded pictures (shared by the renderer)

const cache = new Map<string, HTMLImageElement>();
let loaded = 0;
/** Changes whenever another picture finished decoding (renderer cache key). */
export const referencesLoaded = () => loaded;

/** The decoded picture, or null while it loads (a redraw follows). */
export function referenceBitmap(src: string): HTMLImageElement | null {
  let img = cache.get(src);
  if (!img) {
    img = new Image();
    img.decoding = "async";
    img.onload = () => {
      loaded++;
      // any store update redraws the canvas
      useStore.setState({});
    };
    img.src = src;
    cache.set(src, img);
  }
  return img.complete && img.naturalWidth > 0 ? img : null;
}

// ---------------------------------------------------------------------------
// geometry

export const refCenter = (r: ReferenceImage): Vec2 => [r.x + r.width / 2, r.y + r.height / 2];

/** A point in the picture's own frame (unrotated, relative to its centre). */
export function toLocal(r: ReferenceImage, p: Vec2): Vec2 {
  const [cx, cy] = refCenter(r);
  const a = (-r.rotation * Math.PI) / 180;
  const dx = p[0] - cx;
  const dy = p[1] - cy;
  return [dx * Math.cos(a) - dy * Math.sin(a), dx * Math.sin(a) + dy * Math.cos(a)];
}

export function toWorld(r: ReferenceImage, q: Vec2): Vec2 {
  const [cx, cy] = refCenter(r);
  const a = (r.rotation * Math.PI) / 180;
  return [cx + q[0] * Math.cos(a) - q[1] * Math.sin(a), cy + q[0] * Math.sin(a) + q[1] * Math.cos(a)];
}

export const refContains = (r: ReferenceImage, p: Vec2) => {
  const [x, y] = toLocal(r, p);
  return Math.abs(x) <= r.width / 2 && Math.abs(y) <= r.height / 2;
};

/** Corner handles (world mm): nw, ne, se, sw. */
export function refCorners(r: ReferenceImage): Vec2[] {
  const w = r.width / 2;
  const h = r.height / 2;
  return [
    [-w, -h],
    [w, -h],
    [w, h],
    [-w, h],
  ].map((q) => toWorld(r, q as Vec2));
}

/** The rotation knob above the top edge (world mm). */
export const refRotateKnob = (r: ReferenceImage, scale: number): Vec2 => toWorld(r, [0, -r.height / 2 - 24 / scale]);

// ---------------------------------------------------------------------------
// document edits

export const references = () => useStore.getState().doc.references ?? [];

export function updateReference(id: string, patch: Partial<ReferenceImage>, live = false) {
  const s = useStore.getState();
  const fn = (d: typeof s.doc) => ({ ...d, references: (d.references ?? []).map((r) => (r.id === id ? { ...r, ...patch } : r)) });
  if (live) s.liveUpdate(fn);
  else s.commit(fn);
}

export function removeReference(id: string) {
  const s = useStore.getState();
  s.commit((d) => ({ ...d, references: (d.references ?? []).filter((r) => r.id !== id) }));
  if (s.refEdit === id) s.set({ refEdit: null });
}

export function moveReference(id: string, dir: 1 | -1) {
  const s = useStore.getState();
  const list = [...(s.doc.references ?? [])];
  const i = list.findIndex((r) => r.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j], list[i]];
  s.commit((d) => ({ ...d, references: list }));
}

/** Fit into the hoop (90 %), centred, keeping the aspect ratio. */
export function fitReferenceToHoop(id: string) {
  const s = useStore.getState();
  const r = references().find((x) => x.id === id);
  if (!r) return;
  const { width: hw, height: hh } = s.doc.hoop;
  const k = Math.min((hw * 0.9) / r.width, (hh * 0.9) / r.height);
  const width = r.width * k;
  const height = r.height * k;
  updateReference(id, { width, height, x: (hw - width) / 2, y: (hh - height) / 2, rotation: 0 });
}

/** Read an image file into a (possibly scaled-down) data URL and its size. */
async function decode(bytes: Uint8Array, type: string): Promise<{ src: string; w: number; h: number }> {
  const blob = new Blob([bytes as BlobPart], { type: type || "image/png" });
  const bmp = await createImageBitmap(blob);
  const { width: w0, height: h0 } = bmp;
  const k = Math.min(1, MAX_PX / Math.max(w0, h0));
  const w = Math.max(1, Math.round(w0 * k));
  const h = Math.max(1, Math.round(h0 * k));
  let src: string;
  if (k < 1 || bytes.length > 3_000_000) {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    c.getContext("2d")!.drawImage(bmp, 0, 0, w, h);
    // WebP keeps transparency and stays small
    src = c.toDataURL("image/webp", 0.88);
    if (!src.startsWith("data:image/webp")) src = c.toDataURL("image/png");
  } else {
    src = await new Promise<string>((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(fr.result as string);
      fr.onerror = () => rej(fr.error);
      fr.readAsDataURL(blob);
    });
  }
  bmp.close();
  return { src, w, h };
}

const MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", bmp: "image/bmp" };

/**
 * Add a picture as a reference: centred on `at` (mm) or the hoop, 80 % of the
 * hoop, then in adjust mode so it can be placed right away.
 */
export async function addReference(name: string, bytes: Uint8Array, at?: Vec2) {
  const s = useStore.getState();
  try {
    const ext = name.split(".").pop()?.toLowerCase() ?? "";
    const { src, w, h } = await decode(bytes, MIME[ext] ?? "");
    const { width: hw, height: hh } = s.doc.hoop;
    const k = Math.min((hw * 0.8) / w, (hh * 0.8) / h);
    const width = w * k;
    const height = h * k;
    const c = at ?? [hw / 2, hh / 2];
    const ref: ReferenceImage = {
      id: uid("ref"),
      name: name.replace(/\.[^.]+$/, "") || "Reference",
      src,
      x: c[0] - width / 2,
      y: c[1] - height / 2,
      width,
      height,
      rotation: 0,
      opacity: 0.6,
      visible: true,
      locked: false,
      placement: "behind",
    };
    s.commit((d) => ({ ...d, references: [...(d.references ?? []), ref] }));
    s.set({ refEdit: ref.id });
    s.toast("Reference added — drag to place, corners to scale · Enter when done", "success");
  } catch (e) {
    s.toast(`Could not read ${name}: ${(e as Error).message}`, "error");
  }
}

/** Keyboard while a picture is being adjusted. Returns true when the key was used. */
export function referenceKey(e: KeyboardEvent): boolean {
  const s = useStore.getState();
  const id = s.refEdit;
  if (!id || e.ctrlKey || e.metaKey) return false;
  const r = references().find((x) => x.id === id);
  if (!r) return false;
  const k = e.key.toLowerCase();
  if (k === "enter" || k === "escape") {
    s.set({ refEdit: null });
    return true;
  }
  if (k === "delete" || k === "backspace") {
    removeReference(id);
    return true;
  }
  const step = e.shiftKey ? 5 : 0.5;
  const d: Record<string, [number, number]> = { arrowleft: [-step, 0], arrowright: [step, 0], arrowup: [0, -step], arrowdown: [0, step] };
  if (d[k]) {
    updateReference(id, { x: r.x + d[k][0], y: r.y + d[k][1] });
    return true;
  }
  return false;
}

/** The topmost visible, unlocked picture under p. */
export function referenceAt(p: Vec2): ReferenceImage | null {
  const list = references();
  for (let i = list.length - 1; i >= 0; i--) if (list[i].visible && !list[i].locked && refContains(list[i], p)) return list[i];
  return null;
}

/** The picture as file bytes (for the auto-digitizer). */
export async function referenceBytes(r: ReferenceImage): Promise<{ name: string; bytes: Uint8Array }> {
  const buf = await (await fetch(r.src)).arrayBuffer();
  const ext = r.src.slice(5, r.src.indexOf(";")).split("/")[1] ?? "png";
  return { name: `${r.name}.${ext === "jpeg" ? "jpg" : ext}`, bytes: new Uint8Array(buf) };
}
