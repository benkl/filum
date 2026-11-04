// The digitizer's region editor: the reduced colours as they will be
// stitched, with everything that is left out shown hatched (background,
// dropped colours, areas clicked away). Hover tells what an area is and why;
// a click stitches it or leaves it out, Alt-click does it for the whole colour.

import { useEffect, useMemo, useRef, useState } from "react";
import { REGION_REASON, type DigitizePreview, type RegionEdit } from "../types";

type Rgb = [number, number, number];

/** The region under a point (0..1 of the image). */
export function regionAt(p: DigitizePreview, fx: number, fy: number): number {
  const x = Math.min(p.regionWidth - 1, Math.max(0, Math.floor(fx * p.regionWidth)));
  const y = Math.min(p.regionHeight - 1, Math.max(0, Math.floor(fy * p.regionHeight)));
  return p.regions[y * p.regionWidth + x];
}

const REASON_TEXT: Record<number, [string, string]> = {
  [REGION_REASON.stitched]: ["Stitched", "Click to leave this area out"],
  [REGION_REASON.background]: ["Left out · background", "Click to stitch this area"],
  [REGION_REASON.colour]: ["Left out · colour switched off", "Click to stitch this area · Alt-click: the whole colour"],
  [REGION_REASON.edit]: ["Left out by you", "Click to stitch it again"],
  [REGION_REASON.transparent]: ["Transparent in the picture or masked", "Not editable here — use Select objects (AI)"],
};

function canvasOf(w: number, h: number) {
  const c = document.createElement("canvas");
  c.width = Math.max(1, w);
  c.height = Math.max(1, h);
  return c;
}

/** Diagonal hatching for left-out areas (screen space). */
function hatch(ctx: CanvasRenderingContext2D, dpr: number) {
  const n = Math.round(9 * dpr);
  const t = canvasOf(n, n);
  const g = t.getContext("2d")!;
  g.strokeStyle = "rgba(214, 48, 64, 0.85)";
  g.lineWidth = 1.4 * dpr;
  g.beginPath();
  for (const o of [-n, 0, n]) {
    g.moveTo(o, n);
    g.lineTo(o + n, 0);
  }
  g.stroke();
  return ctx.createPattern(t, "repeat")!;
}

export function RegionEditor({
  preview: p,
  overrides,
  edits,
  w,
  h,
  onToggle,
}: {
  preview: DigitizePreview;
  overrides: Record<string, string>;
  edits: RegionEdit[];
  w: number;
  h: number;
  onToggle: (fx: number, fy: number, region: number, wholeColour: boolean) => void;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [hover, setHover] = useState<{ region: number; x: number; y: number } | null>(null);
  const [alt, setAlt] = useState(false);

  // where the image sits in the canvas (css px)
  const rect = useMemo(() => {
    const m = 12;
    const k = Math.min((w - 2 * m) / p.width, (h - 2 * m) / p.height);
    return { x: (w - p.width * k) / 2, y: (h - p.height * k) / 2, w: p.width * k, h: p.height * k, k };
  }, [p, w, h]);

  // the stitched colours (thread recolouring applied)
  const stitched = useMemo(() => {
    const px = new Uint8ClampedArray(p.rgba);
    const map = new Map<number, Rgb>();
    for (const [from, to] of Object.entries(overrides)) {
      const f = parseInt(from.slice(1), 16);
      const v = parseInt(to.slice(1), 16);
      map.set(f, [(v >> 16) & 255, (v >> 8) & 255, v & 255]);
    }
    if (map.size)
      for (let i = 0; i < px.length; i += 4) {
        const t = px[i + 3] ? map.get((px[i] << 16) | (px[i + 1] << 8) | px[i + 2]) : undefined;
        if (t) [px[i], px[i + 1], px[i + 2]] = t;
      }
    const c = canvasOf(p.width, p.height);
    if (p.width && p.height) c.getContext("2d")!.putImageData(new ImageData(px, p.width, p.height), 0, 0);
    return c;
  }, [p, overrides]);

  // left-out areas in their own colour (ghosted) and as a mask (for the hatch)
  const removed = useMemo(() => {
    const { regionWidth: rw, regionHeight: rh } = p;
    const ghost = new Uint8ClampedArray(rw * rh * 4);
    const mask = new Uint8ClampedArray(rw * rh * 4);
    let any = false;
    for (let i = 0; i < rw * rh; i++) {
      const r = p.regions[i];
      const why = p.regionReason[r];
      if (why === REGION_REASON.stitched || why === REGION_REASON.transparent) continue;
      const c = p.colors[p.regionLabel[r]]?.rgb ?? [150, 150, 150];
      ghost.set([c[0], c[1], c[2], 255], i * 4);
      mask[i * 4 + 3] = 255;
      any = true;
    }
    const g = canvasOf(rw, rh);
    const m = canvasOf(rw, rh);
    if (any && rw && rh) {
      g.getContext("2d")!.putImageData(new ImageData(ghost, rw, rh), 0, 0);
      m.getContext("2d")!.putImageData(new ImageData(mask, rw, rh), 0, 0);
    }
    return any ? { ghost: g, mask: m } : null;
  }, [p]);

  // the hovered region (or all regions of its colour with Alt)
  const highlight = useMemo(() => {
    if (!hover) return null;
    const { regionWidth: rw, regionHeight: rh } = p;
    const label = p.regionLabel[hover.region];
    const px = new Uint8ClampedArray(rw * rh * 4);
    for (let i = 0; i < rw * rh; i++) {
      const r = p.regions[i];
      if (r === hover.region || (alt && p.regionLabel[r] === label && label < p.colors.length)) px[i * 4 + 3] = 255;
    }
    const c = canvasOf(rw, rh);
    c.getContext("2d")!.putImageData(new ImageData(px, rw, rh), 0, 0);
    return c;
  }, [p, hover, alt]);

  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
    const ctx = cv.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.imageSmoothingEnabled = rect.k < 1;
    ctx.drawImage(stitched, rect.x, rect.y, rect.w, rect.h);
    // a layer at screen resolution: tinted by a mask drawn with source-in
    const layer = (mask: HTMLCanvasElement, paint: string | CanvasPattern, alpha = 1) => {
      const t = canvasOf(cv.width, cv.height);
      const g = t.getContext("2d")!;
      g.imageSmoothingEnabled = false;
      g.drawImage(mask, rect.x * dpr, rect.y * dpr, rect.w * dpr, rect.h * dpr);
      g.globalCompositeOperation = "source-in";
      g.fillStyle = paint;
      g.fillRect(0, 0, t.width, t.height);
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = alpha;
      ctx.drawImage(t, 0, 0);
      ctx.restore();
    };
    if (removed) {
      ctx.save();
      ctx.globalAlpha = 0.35;
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(removed.ghost, rect.x, rect.y, rect.w, rect.h);
      ctx.restore();
      layer(removed.mask, hatch(ctx, dpr));
    }
    if (highlight) layer(highlight, getComputedStyle(cv).getPropertyValue("--select").trim() || "#3d93f0", 0.38);
    // where the user clicked
    for (const e of edits) {
      const x = rect.x + e.x * rect.w;
      const y = rect.y + e.y * rect.h;
      ctx.beginPath();
      ctx.arc(x, y, 6, 0, Math.PI * 2);
      ctx.fillStyle = e.keep ? "#2e9d5b" : "#d63040";
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 2;
      ctx.fill();
      ctx.stroke();
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      if (e.keep) {
        ctx.moveTo(x - 2.8, y);
        ctx.lineTo(x - 0.6, y + 2.2);
        ctx.lineTo(x + 3, y - 2.2);
      } else {
        ctx.moveTo(x - 2.4, y - 2.4);
        ctx.lineTo(x + 2.4, y + 2.4);
        ctx.moveTo(x + 2.4, y - 2.4);
        ctx.lineTo(x - 2.4, y + 2.4);
      }
      ctx.stroke();
    }
  }, [w, h, rect, stitched, removed, highlight, edits]);

  const at = (e: React.PointerEvent | React.MouseEvent) => {
    const r = ref.current!.getBoundingClientRect();
    const cx = e.clientX - r.left;
    const cy = e.clientY - r.top;
    const fx = (cx - rect.x) / rect.w;
    const fy = (cy - rect.y) / rect.h;
    return { cx, cy, fx, fy, inside: fx >= 0 && fy >= 0 && fx < 1 && fy < 1 };
  };
  const label = hover ? p.regionLabel[hover.region] : -1;
  const why = hover ? p.regionReason[hover.region] : 0;
  const colour = label >= 0 ? p.colors[label] : undefined;
  return (
    <div className="region-editor" style={{ width: w, height: h }}>
      <canvas
        ref={ref}
        style={{ width: w, height: h, cursor: hover && why !== REGION_REASON.transparent ? "pointer" : "default" }}
        onPointerMove={(e) => {
          setAlt(e.altKey);
          const a = at(e);
          setHover(a.inside ? { region: regionAt(p, a.fx, a.fy), x: a.cx, y: a.cy } : null);
        }}
        onPointerLeave={() => setHover(null)}
        onClick={(e) => {
          const a = at(e);
          if (!a.inside) return;
          const region = regionAt(p, a.fx, a.fy);
          if (p.regionReason[region] !== REGION_REASON.transparent) onToggle(a.fx, a.fy, region, e.altKey);
        }}
      />
      {hover && (
        <div className="region-tip" style={{ left: Math.min(hover.x + 14, w - 230), top: Math.min(hover.y + 14, h - 64) }}>
          <div className="rt-head">
            {colour ? <i style={{ background: colour.hex }} /> : <i className="none" />}
            <b>{colour ? colour.name : label > p.colors.length ? "Gradient" : "Transparent"}</b>
            <span className={`rt-state ${why === REGION_REASON.stitched ? "on" : "off"}`}>{REASON_TEXT[why]?.[0]}</span>
          </div>
          <span className="stat">{alt && colour ? (why === REGION_REASON.stitched ? "Alt-click: leave out the whole colour" : "Alt-click: stitch the whole colour") : REASON_TEXT[why]?.[1]}</span>
        </div>
      )}
    </div>
  );
}
