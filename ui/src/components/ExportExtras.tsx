// Export dialog building blocks: frame out on stops (Ink/Stitch stop
// position), repeats (Ink/Stitch ZIP "panelization"), picture options (PNG
// realistic / simple) with a live preview, and the file list of a ZIP.

import { FileArchive, Image as ImageIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { engine } from "../engine/client";
import { isPicture, targetFileName, type PictureSettings } from "../lib/exportFiles";
import { defaultDesignOptions } from "../lib/geometry";
import { pictureSize, renderPicture } from "../lib/planImage";
import { useStore } from "../store";
import type { ExportOptions, PlanData } from "../types";
import { Num } from "./ui";
import "../output.css";

/** Ink/Stitch "stop position": where the frame moves before every stop. */
export function StopPositionChoice({ stops }: { stops: number }) {
  const at = useStore((s) => s.doc.options?.stopPosition);
  const hoop = useStore((s) => s.doc.hoop);
  const commit = useStore((s) => s.commit);
  const set = (p: [number, number] | undefined) => commit((d) => ({ ...d, options: { ...(d.options ?? defaultDesignOptions()), stopPosition: p } }));
  return (
    <>
      <h4 title="Ink/Stitch stop position (frame out): before every stop the frame moves the design away from the needle, so you can place appliqué fabric or foam, then it comes back">
        Frame out on stops
      </h4>
      <div className="seg seg-full">
        <button className={!at ? "on" : ""} onClick={() => set(undefined)} title="The frame stays where the stop happens">
          Stay
        </button>
        <button
          className={at ? "on" : ""}
          onClick={() => set(at ?? [+(hoop.width / 2).toFixed(1), 0])}
          title="The needle goes to this point of the hoop before every stop: by default the top centre, which brings the design towards you"
        >
          Move to point
        </button>
      </div>
      {at && (
        <div className="xp-origin">
          <label className="ctx-field">
            X <Num value={at[0]} unit="mm" step={1} onChange={(v) => set([v, at[1]])} />
          </label>
          <label className="ctx-field">
            Y <Num value={at[1]} unit="mm" step={1} onChange={(v) => set([at[0], v])} />
          </label>
        </div>
      )}
      {at && <p className="hint">{stops ? `${stops} stop${stops === 1 ? "" : "s"}: the needle goes to ${at[0].toFixed(0)}, ${at[1].toFixed(0)} mm (hoop coordinates) before each.` : "The design has no stops yet (Stop after, appliqué) — nothing changes."}</p>}
    </>
  );
}

/** Ink/Stitch ZIP "panelization": the design repeated in a grid. */
export function RepeatOptions({ opts, set, width, height }: { opts: ExportOptions; set: (o: ExportOptions) => void; width: number; height: number }) {
  const xr = opts.xRepeats ?? 1;
  const yr = opts.yRepeats ?? 1;
  const on = xr > 1 || yr > 1;
  return (
    <>
      <h4 title="Ink/Stitch panelization: the design several times side by side and below each other in one file — for patches and labels sewn in one hooping">Repeats</h4>
      <div className="xp-repeat">
        <label className="ctx-field" title="Copies side by side (Ink/Stitch horizontal repeats)">
          ↔ <Num value={xr} step={1} min={1} max={20} digits={0} onChange={(v) => set({ ...opts, xRepeats: Math.round(v) })} />
        </label>
        <label className="ctx-field" title="Distance from one copy to the next, left edge to left edge (Ink/Stitch horizontal spacing)">
          <Num value={opts.xSpacing ?? 100} unit="mm" step={1} min={-1000} max={1000} onChange={(v) => set({ ...opts, xSpacing: v })} />
        </label>
        <label className="ctx-field" title="Copies below each other (Ink/Stitch vertical repeats)">
          ↕ <Num value={yr} step={1} min={1} max={20} digits={0} onChange={(v) => set({ ...opts, yRepeats: Math.round(v) })} />
        </label>
        <label className="ctx-field" title="Distance from one copy to the next, top edge to top edge (Ink/Stitch vertical spacing)">
          <Num value={opts.ySpacing ?? 100} unit="mm" step={1} min={-1000} max={1000} onChange={(v) => set({ ...opts, ySpacing: v })} />
        </label>
      </div>
      <p className="hint">
        {on ? (
          <>
            {xr * yr} copies · each colour sews all copies before the next colour
            {(Math.abs(opts.xSpacing ?? 100) < width && xr > 1) || (Math.abs(opts.ySpacing ?? 100) < height && yr > 1) ? " · the copies overlap: spacing below the design size" : ""}
            {" · "}
            <button className="link" onClick={() => set({ ...opts, xRepeats: 1, yRepeats: 1 })}>
              Reset
            </button>
          </>
        ) : (
          "1 × 1: the design once."
        )}
      </p>
    </>
  );
}

/** PNG options (Ink/Stitch: DPI, simple line width) and the background. */
export function PictureOptionsPanel({ kinds, pics, set }: { kinds: string[]; pics: PictureSettings; set: (p: PictureSettings) => void }) {
  const realistic = kinds.includes("png_realistic");
  const simple = kinds.includes("png_simple");
  const dpis: [number, string][] = [
    [150, "150"],
    [300, "300"],
    [600, "600"],
  ];
  const dpiRow = (value: number, put: (v: number) => void, label: string) => (
    <label className="xp-dpi" title="Pixels per inch: 300 prints sharp at the real size; 150 for screens and e-mail (Ink/Stitch DPI, 100–2000)">
      <span>{label}</span>
      <div className="seg">
        {dpis.map(([v, l]) => (
          <button key={v} className={value === v ? "on" : ""} onClick={() => put(v)}>
            {l}
          </button>
        ))}
      </div>
      <Num value={value} unit="dpi" step={50} min={100} max={2000} digits={0} onChange={put} />
    </label>
  );
  return (
    <>
      <h4>Picture</h4>
      {realistic && dpiRow(pics.dpiRealistic, (v) => set({ ...pics, dpiRealistic: v }), simple ? "Realistic" : "Resolution")}
      {simple && dpiRow(pics.dpiSimple, (v) => set({ ...pics, dpiSimple: v }), realistic ? "Simple" : "Resolution")}
      {simple && (
        <label className="xp-dpi" title="Width of the stitch lines in the simple picture (Ink/Stitch line width, 0.3 mm)">
          <span>Line width</span>
          <Num value={pics.lineWidth} unit="mm" step={0.05} min={0.01} max={5} onChange={(v) => set({ ...pics, lineWidth: v })} />
        </label>
      )}
      <div className="seg seg-full" title="Behind the stitches">
        {(
          [
            ["transparent", "Transparent", "No background — place it on anything (Ink/Stitch)"],
            ["white", "White", "A white background"],
            ["fabric", "Fabric", "The fabric colour of the realistic view"],
          ] as const
        ).map(([v, l, t]) => (
          <button key={v} className={pics.background === v ? "on" : ""} title={t} onClick={() => set({ ...pics, background: v })}>
            {l}
          </button>
        ))}
      </div>
    </>
  );
}

/** A live preview of the picture and its size in pixels. */
export function PicturePreview({ kind, pics, opts }: { kind: string; pics: PictureSettings; opts: ExportOptions }) {
  const doc = useStore((s) => s.doc);
  const fabricColor = useStore((s) => s.fabricColor);
  const ref = useRef<HTMLDivElement>(null);
  const [plan, setPlan] = useState<PlanData | null>(null);
  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      engine
        .exportPlan(doc, opts)
        .then((p) => live && setPlan(p))
        .catch(() => live && setPlan(null));
    }, 150);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [doc, opts]);
  const realistic = kind === "png_realistic";
  const dpi = realistic ? pics.dpiRealistic : pics.dpiSimple;
  const size = plan ? pictureSize(plan, { dpi }) : null;
  useEffect(() => {
    const box = ref.current;
    if (!box || !plan || !size) return;
    // the preview at about the box size, line width to scale
    const f = Math.min(1, 560 / Math.max(size.w, size.h));
    const c = renderPicture(plan, {
      kind: realistic ? "realistic" : "simple",
      dpi: dpi * f,
      lineWidth: pics.lineWidth,
      background: pics.background,
      fabricColor,
      threadWeight: doc.options?.threadWeight,
    });
    c.className = "xp-pic-canvas";
    box.replaceChildren(c);
  }, [plan, kind, dpi, pics.lineWidth, pics.background, fabricColor, doc.options?.threadWeight, realistic, size?.w, size?.h]);
  return (
    <div className="xp-pic">
      <div className={`xp-pic-box ${pics.background === "transparent" ? "checker" : ""}`} ref={ref} />
      <p className="hint">
        <ImageIcon size={12} /> {size ? `${size.w.toLocaleString()} × ${size.h.toLocaleString()} px at ${dpi} dpi` : "Nothing to show yet"}
        {size && Math.max(size.w, size.h) > 16000 && " — scaled down to 16,000 px"}
      </p>
    </div>
  );
}

/** What the ZIP will hold. */
export function ZipFileList({ targets, name, onRemove }: { targets: string[]; name: string; onRemove: (t: string) => void }) {
  return (
    <div className="xp-zip">
      <div className="exp-colours-head">
        <b>
          <FileArchive size={14} /> {name}.zip
        </b>
        <span className="stat">{targets.length ? `${targets.length} file${targets.length === 1 ? "" : "s"} — pick formats on the left` : "Pick the files to include on the left"}</span>
      </div>
      <div className="xp-zip-list">
        {targets.map((t) => (
          <div key={t} className="xp-zip-file">
            <span>{targetFileName(t, name, true)}</span>
            <span className="stat">{isPicture(t) ? "picture" : t === "threadlist" ? "thread list" : t === "svg" ? "Ink/Stitch SVG" : t === "filum" ? "project" : "stitch file"}</span>
            <button className="mini" title="Leave out" onClick={() => onRemove(t)}>
              ×
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
