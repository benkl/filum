// Rebuild shapes from stitches (Ink/Stitch "Outline"): the stitches of the
// selected objects — typically the colour blocks of an imported machine file —
// are thickened until neighbouring rows merge, shrunk back, cleaned of small
// bits and smoothed into paths that can be stitched again as fills.

import { useEffect, useRef, useState } from "react";
import { engine } from "../engine/client";
import { defaultStitch, pathsToPath2D, uid } from "../lib/geometry";
import { useStore } from "../store";
import type { DesignObject, StitchParams, SubPath } from "../types";
import { Dialog, Num, Row, Toggle } from "./ui";
import "../output.css";

/** Ink/Stitch's outline options (mm, threshold mm²). */
interface OutlineParams {
  buffer: number;
  inset: number;
  smoothness: number;
  threshold: number;
}

const PRESETS: { id: string; label: string; hint: string; p: OutlineParams }[] = [
  { id: "fill", label: "Filled areas", hint: "Merges the rows of fills and satins (rows up to 0.6 mm apart) into solid shapes", p: { buffer: 0.3, inset: 0.3, smoothness: 0.3, threshold: 10 } },
  { id: "open", label: "Open fills", hint: "Light fills and wide rows (up to 1.2 mm apart)", p: { buffer: 0.6, inset: 0.6, smoothness: 0.4, threshold: 10 } },
  { id: "loops", label: "Closed lines", hint: "Ink/Stitch's defaults: only closed loops of stitches make shapes (outlines, running stitch)", p: { buffer: 0.001, inset: 0, smoothness: 0.3, threshold: 10 } },
];
const KEY = "filum.rebuild";

export function RebuildShapesDialog({ onClose }: { onClose: () => void }) {
  const doc = useStore((s) => s.doc);
  const selection = useStore((s) => s.selection);
  const objects = doc.objects.filter((o) => selection.includes(o.id) && o.stitch.type !== "none");
  const [p, setP] = useState<OutlineParams>(() => {
    try {
      return { ...PRESETS[0].p, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") };
    } catch {
      return PRESETS[0].p;
    }
  });
  const [keep, setKeep] = useState(false);
  const [as, setAs] = useState<"fill" | "running">("fill");
  const [result, setResult] = useState<{ id: string; paths: SubPath[] }[] | null>(null);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLCanvasElement>(null);
  const plan = useStore((s) => s.plan);

  useEffect(() => {
    let live = true;
    setBusy(true);
    const t = setTimeout(() => {
      engine
        .stitchOutline(doc, objects.map((o) => o.id), p)
        .then((r) => live && setResult(r))
        .catch(() => live && setResult([]))
        .finally(() => live && setBusy(false));
    }, 200);
    return () => {
      live = false;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, selection.join(","), p.buffer, p.inset, p.smoothness, p.threshold]);

  // preview: the stitches faint, the rebuilt shapes on top
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const W = 520;
    const H = 380;
    const dpr = window.devicePixelRatio || 1;
    c.width = W * dpr;
    c.height = H * dpr;
    c.style.width = `${W}px`;
    c.style.height = `${H}px`;
    const ctx = c.getContext("2d")!;
    ctx.clearRect(0, 0, c.width, c.height);
    const idx = new Set(objects.map((o) => doc.objects.indexOf(o)));
    let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
    if (plan)
      for (let i = 0; i < plan.flags.length; i++) {
        if (!idx.has(plan.objects[i]) || plan.flags[i] & 31) continue;
        const x = plan.coords[2 * i];
        const y = plan.coords[2 * i + 1];
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x);
        y1 = Math.max(y1, y);
      }
    if (!(x1 > x0) && !(y1 > y0)) return;
    const s = Math.min((W - 24) / Math.max(1, x1 - x0), (H - 24) / Math.max(1, y1 - y0));
    ctx.setTransform(s * dpr, 0, 0, s * dpr, dpr * ((W - (x1 - x0) * s) / 2 - x0 * s), dpr * ((H - (y1 - y0) * s) / 2 - y0 * s));
    const color = (o: DesignObject) => doc.threads.find((t) => t.id === o.thread)?.color ?? "#333";
    // stitches
    if (plan) {
      ctx.lineWidth = 0.15;
      ctx.globalAlpha = 0.35;
      let pen = false;
      ctx.beginPath();
      for (let i = 0; i < plan.flags.length; i++) {
        const f = plan.flags[i];
        if (!idx.has(plan.objects[i]) || f & 31) {
          pen = false;
          continue;
        }
        const x = plan.coords[2 * i];
        const y = plan.coords[2 * i + 1];
        if (pen) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
        pen = true;
      }
      ctx.strokeStyle = "#888";
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    for (const r of result ?? []) {
      const o = objects.find((x) => x.id === r.id);
      if (!o || !r.paths.length) continue;
      const path = pathsToPath2D(r.paths);
      ctx.fillStyle = color(o);
      ctx.globalAlpha = 0.45;
      ctx.fill(path, "evenodd");
      ctx.globalAlpha = 1;
      ctx.strokeStyle = color(o);
      ctx.lineWidth = 1.5 / s;
      ctx.stroke(path);
    }
  }, [result, plan, doc, objects.length]);

  const shapes = (result ?? []).reduce((n, r) => n + r.paths.length, 0);
  const empty = (result ?? []).filter((r) => !r.paths.length).length;
  const set = (q: Partial<OutlineParams>) => {
    const next = { ...p, ...q };
    setP(next);
    localStorage.setItem(KEY, JSON.stringify(next));
  };
  const apply = () => {
    if (!result) return;
    const s = useStore.getState();
    const stitch = (o: DesignObject): StitchParams => (as === "fill" ? (o.stitch.type === "fill" ? o.stitch : defaultStitch("fill")) : defaultStitch("running"));
    const made: string[] = [];
    s.commit((d) => {
      const out: DesignObject[] = [];
      for (const o of d.objects) {
        const r = result.find((x) => x.id === o.id);
        if (!r || !r.paths.length) {
          out.push(o);
          continue;
        }
        const rebuilt: DesignObject = { ...o, paths: r.paths, stitch: stitch(o), start: undefined, end: undefined };
        if (keep) {
          const id = uid();
          out.push(o, { ...rebuilt, id, name: `${o.name} (shape)` });
          made.push(id);
        } else {
          out.push(rebuilt);
          made.push(o.id);
        }
      }
      return { ...d, objects: out };
    });
    s.select(made);
    s.toast(`Rebuilt ${shapes} shape${shapes === 1 ? "" : "s"} from ${made.length} object${made.length === 1 ? "" : "s"}`, "success");
    onClose();
  };

  return (
    <Dialog
      wide
      live
      title="Rebuild shapes from stitches"
      onClose={onClose}
      footer={
        <>
          <span className="stat">{busy ? "Working…" : result ? `${shapes} shape${shapes === 1 ? "" : "s"}${empty ? ` · ${empty} object${empty === 1 ? "" : "s"} gave none — try a larger buffer` : ""}` : ""}</span>
          <div className="spacer" />
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!shapes} onClick={apply}>
            {keep ? "Add shapes" : "Replace with shapes"}
          </button>
        </>
      }
    >
      <div className="rb">
        <div>
          <p className="hint" style={{ marginTop: 0 }}>
            Turns stitches back into shapes (Ink/Stitch Outline) — for designs from a machine file, so they can be re-stitched, resized or given new fills.
          </p>
          {!objects.length && <p className="hint">Select the objects to rebuild (e.g. the colours of an imported DST).</p>}
          <div className="chips" style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 8 }}>
            {PRESETS.map((x) => (
              <button
                key={x.id}
                className={`chip ${x.p.buffer === p.buffer && x.p.inset === p.inset ? "on" : ""}`}
                title={x.hint}
                onClick={() => set(x.p)}
              >
                {x.label}
              </button>
            ))}
          </div>
          <Row label="Buffer" title="Thicken the stitch lines by this much (Ink/Stitch buffer): half the row spacing or more merges the rows of a fill into one shape">
            <Num value={p.buffer} unit="mm" step={0.05} min={0.001} max={2} digits={3} onChange={(v) => set({ buffer: v })} />
          </Row>
          <Row label="Inset" title="Shrink the shapes back (Ink/Stitch inset) — usually as much as the buffer, so the shapes keep their size">
            <Num value={p.inset} unit="mm" step={0.05} min={0} max={5} digits={3} onChange={(v) => set({ inset: v })} />
          </Row>
          <Row label="Smoothness" title="How far the smooth outline may leave the stitches (Ink/Stitch smoothness): more gives simpler, rounder paths">
            <Num value={p.smoothness} unit="mm" step={0.05} min={0.01} max={5} onChange={(v) => set({ smoothness: v })} />
          </Row>
          <Row label="Threshold" title="Leave out shapes and holes smaller than this area (Ink/Stitch threshold)">
            <Num value={p.threshold} unit="mm²" step={1} min={0} max={100} onChange={(v) => set({ threshold: v })} />
          </Row>
          <Row label="Stitch as" title="What the new shapes are stitched as">
            <div className="seg">
              <button className={as === "fill" ? "on" : ""} onClick={() => setAs("fill")} title="Fill stitch (a fill keeps its settings)">
                Fill
              </button>
              <button className={as === "running" ? "on" : ""} onClick={() => setAs("running")} title="A running stitch along the outlines">
                Outline
              </button>
            </div>
          </Row>
          <Row label="Keep original" title="Add the shapes and keep the stitched objects (Ink/Stitch keep original)">
            <Toggle on={keep} onChange={setKeep} />
          </Row>
        </div>
        <div className="rb-preview">
          <canvas ref={ref} />
        </div>
      </div>
    </Dialog>
  );
}
