// The canvas's view as its size changes (the hoop kept in view, the zoom given
// back), and copies of what it shows: screenshots and the stitch-out video.

import { useStore } from "../store";
import { RULER } from "./render";
import { fitView } from "../lib/view";

export interface AutoFit {
  scale: number;
  set: { scale: number; ox: number; oy: number };
}

/**
 * The canvas changed size (a panel opened or closed, the window, a sash):
 * the middle of the view stays where it was. When the hoop was all in view
 * and no longer fits, the view zooms out to fit it; as the canvas grows
 * back, the view returns to the zoom it had (unless it was changed since).
 */
export function keepInView(prev: { w: number; h: number }, w: number, h: number, auto: { current: AutoFit | null }) {
  const s = useStore.getState();
  const v = s.view;
  const hoop = { x: 0, y: 0, w: s.doc.hoop.width, h: s.doc.hoop.height };
  const inView = (q: { scale: number; ox: number; oy: number }, W: number, H: number) =>
    q.ox >= RULER - 0.5 && q.oy >= RULER - 0.5 && hoop.w * q.scale + q.ox <= W + 0.5 && hoop.h * q.scale + q.oy <= H + 0.5;
  const same = (a: { scale: number; ox: number; oy: number }, b: { scale: number; ox: number; oy: number }) =>
    Math.abs(a.scale - b.scale) < 1e-6 && Math.abs(a.ox - b.ox) < 0.5 && Math.abs(a.oy - b.oy) < 0.5;
  let next = { scale: v.scale, ox: v.ox + (w - prev.w) / 2, oy: v.oy + (h - prev.h) / 2 };
  const a = auto.current;
  if (a && same(v, a.set)) {
    const f = fitView(w, h, hoop);
    if (f.scale >= a.scale) {
      // room again: back to the zoom it had, about the middle
      const k = a.scale / f.scale;
      const [cx, cy] = [(RULER + w) / 2, (RULER + h) / 2];
      next = { scale: a.scale, ox: cx - (cx - f.ox) * k, oy: cy - (cy - f.oy) * k };
      auto.current = null;
    } else {
      next = f;
      auto.current = { scale: a.scale, set: f };
    }
  } else if (inView(v, prev.w, prev.h) && !inView(next, w, h)) {
    const f = fitView(w, h, hoop);
    if (f.scale < v.scale) {
      auto.current = { scale: v.scale, set: f };
      next = f;
    } else auto.current = null;
  } else auto.current = null;
  s.setView(next);
}

export { fitView };

// The viewport is three stacked canvases; these helpers flatten them for
// screenshots (production sheet) and the stitch-out video recorder.
export const layers: { bg: HTMLCanvasElement | null; gl: HTMLCanvasElement | null; top: HTMLCanvasElement | null } = { bg: null, gl: null, top: null };
export let capture: HTMLCanvasElement | null = null;

export function flatten(into: HTMLCanvasElement) {
  const { bg, gl, top } = layers;
  if (!bg || !top) return;
  if (into.width !== bg.width || into.height !== bg.height) {
    into.width = bg.width;
    into.height = bg.height;
  }
  const g = into.getContext("2d")!;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.drawImage(bg, 0, 0);
  if (gl) g.drawImage(gl, 0, 0);
  g.drawImage(top, 0, 0);
}

export function captureFrame() {
  if (capture) flatten(capture);
}

/** A flattened copy of the current viewport. */
export function snapshotViewport(): HTMLCanvasElement {
  const c = document.createElement("canvas");
  flatten(c);
  return c;
}

export function startCapture(): HTMLCanvasElement {
  capture = document.createElement("canvas");
  flatten(capture);
  return capture;
}

export function stopCapture() {
  capture = null;
}
