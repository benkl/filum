// A design shown outside the editor (digitizer, lettering tools, dialogs),
// drawn by the editor's own renderers: the 2D Renderer for the vector view
// and the background, StitchGL for the stitch and realistic views — the same
// shading, thread widths and fabric as the canvas. Wheel zooms around the
// pointer, dragging pans, double-click fits.

import { Maximize2 } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { objectBounds, unionBoxes, type Box } from "../lib/geometry";
import { threadWidth } from "../lib/materials";
import { useStore, type View } from "../store";
import { useShallow } from "zustand/react/shallow";
import type { PlanData, StitchDocument, ViewMode } from "../types";
import { FLAG } from "../types";
import { StitchGL } from "./gl";
import { readTheme, Renderer, type Theme } from "./render";

/** What a design covers: its stitches in the stitch views, else its shapes. */
function contentBox(doc: StitchDocument, plan: PlanData | null, mode: ViewMode): Box | null {
  if (mode !== "vector" && plan) {
    let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
    for (let i = 0; i < plan.flags.length; i++) {
      if (plan.flags[i] & FLAG.COMMANDS) continue;
      const x = plan.coords[2 * i];
      const y = plan.coords[2 * i + 1];
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;
    }
    if (x1 >= x0) return { x: x0, y: y0, w: Math.max(x1 - x0, 0.1), h: Math.max(y1 - y0, 0.1) };
  }
  return unionBoxes(doc.objects.filter((o) => o.visible).map(objectBounds));
}

const fitTo = (b: Box, w: number, h: number, pad: number): View => {
  const scale = Math.max(0.05, Math.min((w - 2 * pad) / b.w, (h - 2 * pad) / b.h));
  return { scale, ox: (w - b.w * scale) / 2 - b.x * scale, oy: (h - b.h * scale) / 2 - b.y * scale };
};

export interface DesignViewProps {
  /** The design (threads, objects, fabric, thread weight). */
  doc: StitchDocument;
  /** Its stitch plan (stitch and realistic views). */
  plan: PlanData | null;
  mode: ViewMode;
  fabricColor: string;
  /** Show the underlay (default on). */
  showUnderlay?: boolean;
  /** A grid at this step (mm), e.g. cross stitch cells. */
  gridStep?: number;
  /** Space around the design (CSS px). */
  pad?: number;
  className?: string;
  style?: React.CSSProperties;
}

export function DesignView({ doc, plan, mode, fabricColor, showUnderlay = true, gridStep, pad = 16, className, style }: DesignViewProps) {
  const wrap = useRef<HTMLDivElement>(null);
  const bgRef = useRef<HTMLCanvasElement>(null);
  const glCanvas = useRef<HTMLCanvasElement>(null);
  const topRef = useRef<HTMLCanvasElement>(null);
  const renderer = useRef<Renderer | null>(null);
  const glRef = useRef<StitchGL | null | undefined>(undefined);
  const glDirty = useRef(false);
  const theme = useRef<Theme | null>(null);
  const raf = useRef(0);
  const [size, setSize] = useState({ w: 0, h: 0 });
  // the view: fitted to the design until the user zooms or pans
  const view = useRef<View>({ scale: 1, ox: 0, oy: 0 });
  const userView = useRef(false);
  const [, bump] = useState(0);
  // the canvas's fabric look
  const look = useStore(useShallow((s) => ({ texture: s.fabricTexture, all: s.fabricAll, weave: s.fabricWeave })));

  /** The user moved the view: keep it (and show the fit button). */
  const touched = () => {
    if (!userView.current) {
      userView.current = true;
      bump((n) => n + 1);
    }
  };

  const box = useMemo(() => contentBox(doc, plan, mode), [doc, plan, mode]);
  // the fabric under the design (realistic view): its box with a margin
  const fabricArea = useMemo(() => (box ? { x: box.x - box.w * 0.08 - 2, y: box.y - box.h * 0.08 - 2, w: box.w * 1.16 + 4, h: box.h * 1.16 + 4 } : undefined), [box]);

  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    // measured now (the first frame needs no observer round trip), then followed
    setSize({ w: el.clientWidth, h: el.clientHeight });
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const fit = useCallback(() => {
    userView.current = false;
    if (box && size.w && size.h) view.current = fitTo(box, size.w, size.h, pad);
    bump((n) => n + 1);
  }, [box, size.w, size.h, pad]);

  // a new design (or size) is fitted unless the user has moved the view
  useEffect(() => {
    if (!userView.current && box && size.w && size.h) view.current = fitTo(box, size.w, size.h, pad);
  }, [box, size.w, size.h, pad]);

  const draw = useCallback(() => {
    cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(() => {
      const bg = bgRef.current;
      const top = topRef.current;
      const { w, h } = size;
      if (!bg || !top || !w || !h) return;
      const dpr = window.devicePixelRatio || 1;
      for (const c of [bg, top]) {
        const pw = Math.round(w * dpr);
        const ph = Math.round(h * dpr);
        if (c.width !== pw || c.height !== ph) {
          c.width = pw;
          c.height = ph;
        }
      }
      theme.current ??= readTheme(wrap.current!);
      renderer.current ??= new Renderer();
      if (glRef.current === undefined && glCanvas.current) glRef.current = StitchGL.create(glCanvas.current);
      const gl = glRef.current;
      const useGL = !!gl && mode !== "vector" && !!plan;
      const v = view.current;
      const more = renderer.current.render(
        bg.getContext("2d")!,
        {
          doc,
          plan,
          view: v,
          mode,
          selection: [],
          theme: theme.current,
          overlay: {},
          showGrid: !!gridStep && mode !== "realistic",
          gridStep,
          showJumps: false,
          showUnderlay,
          animIndex: null,
          fabricColor,
          width: w,
          height: h,
          dpr,
          glStitches: useGL,
          preview: true,
          fabricArea,
          fabricAll: look.all,
        },
        top.getContext("2d")!,
      );
      if (useGL && plan) {
        gl!.render({
          view: v,
          dpr,
          width: w,
          height: h,
          mode: mode as "stitch" | "realistic",
          plan,
          showUnderlay,
          showJumps: false,
          limit: plan.flags.length,
          theme: theme.current,
          fabricColor,
          hoop: doc.hoop,
          fabric: doc.fabric,
          threadWidth: threadWidth(doc.options?.threadWeight),
          fabricArea,
          fabricTexture: look.texture === "auto" ? undefined : look.texture,
          weaveMinPx: look.weave ? 4 : 0,
        });
        glDirty.current = true;
      } else if (gl && glDirty.current) {
        gl.clear(Math.round(w * dpr), Math.round(h * dpr));
        glDirty.current = false;
      }
      if (more) draw();
    });
  }, [doc, plan, mode, fabricColor, showUnderlay, gridStep, size, fabricArea, look]);

  useEffect(() => {
    draw();
  });

  // give the GL context back when the preview goes
  useEffect(
    () => () => {
      cancelAnimationFrame(raf.current);
      glRef.current?.dispose();
      glRef.current = undefined;
    },
    [],
  );

  // wheel: zoom around the pointer
  useEffect(() => {
    const el = topRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const mx = e.clientX - r.left;
      const my = e.clientY - r.top;
      const v = view.current;
      const k = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015));
      const scale = Math.max(0.05, Math.min(400, v.scale * k));
      const f = scale / v.scale;
      view.current = { scale, ox: mx - (mx - v.ox) * f, oy: my - (my - v.oy) * f };
      touched();
      draw();
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [draw]);

  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  return (
    <div ref={wrap} className={`design-view ${className ?? ""}`} style={style}>
      <canvas ref={bgRef} />
      <canvas ref={glCanvas} />
      <canvas
        ref={topRef}
        onPointerDown={(e) => {
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
          drag.current = { x: e.clientX, y: e.clientY, ox: view.current.ox, oy: view.current.oy };
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d) return;
          view.current = { ...view.current, ox: d.ox + e.clientX - d.x, oy: d.oy + e.clientY - d.y };
          touched();
          draw();
        }}
        onPointerUp={() => (drag.current = null)}
        onDoubleClick={fit}
        title="Scroll to zoom · drag to pan · double-click to fit"
      />
      {userView.current && (
        <button className="icon-btn design-view-fit" onClick={fit} title="Fit the design (double-click)">
          <Maximize2 size={14} />
        </button>
      )}
    </div>
  );
}
