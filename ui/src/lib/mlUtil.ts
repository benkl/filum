// Small helpers and types of the on-device AI (no model runtime imported),
// so the editor can use them without loading ONNX Runtime.

export const toBase64 = (bytes: Uint8Array): string => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

export interface EdgeMapData {
  width: number;
  height: number;
  data: string;
}

/** Edge map as an image (for the preview): dark lines on white. */
export function edgeMapImage(e: EdgeMapData): ImageData {
  const raw = atob(e.data);
  const out = new ImageData(e.width, e.height);
  for (let i = 0; i < raw.length; i++) {
    const v = 255 - raw.charCodeAt(i);
    out.data.set([v, v, v, 255], i * 4);
  }
  return out;
}

export interface SamPoint {
  /** Working-frame pixels. */
  x: number;
  y: number;
  /** 1 = object, 0 = background. */
  label: 0 | 1;
}

export interface TextLine {
  text: string;
  confidence: number;
  /** Original-image pixels. */
  bbox: { x0: number; y0: number; x1: number; y1: number };
}
