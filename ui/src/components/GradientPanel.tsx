// Gradient editing: the stop bar (drag stops and midpoints, click to add),
// colours per stop, geometry, transition and dither with live previews.
// Mesh and freeform-point gradients get a 2D preview, colour chips, node
// colouring, mesh rows / columns and point spreads.

import { ArrowLeftRight, Trash2 } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { flattenSubPath } from "../lib/bezier";
import {
  colorNodes,
  commit2D,
  CURVES,
  DITHERS,
  ditherCells,
  ditherGrid,
  gradientBox,
  gradientLayers,
  is2D,
  meshResample,
  meshValid,
  removeGradient,
  removeNodes,
  setGradientKind,
  setStops,
  stopsOf,
  updateGradient,
  weightsAt,
  type GradientFill,
  type StopEdit,
  canFlow,
  flowSource,
  setFlowAcross,
  rowStyleOf,
  setRowStyle,
} from "../lib/gradient";
import { useStore } from "../store";
import type { DitherMethod, GradientKind, GradientParams, DesignObject } from "../types";
import { ThreadPicker } from "./ThreadPicker";
import { Num, Row, Section, Slider } from "./ui";

/** Paint a dithered preview of the gradient into a canvas. */
function paintDither(c: HTMLCanvasElement | null, g: Pick<GradientParams, "stops" | "curve" | "steps" | "dither">, colors: string[], cols: number, rows: number) {
  if (!c) return;
  const dpr = window.devicePixelRatio || 1;
  const w = c.clientWidth || 200;
  const h = c.clientHeight || 24;
  c.width = Math.round(w * dpr);
  c.height = Math.round(h * dpr);
  const ctx = c.getContext("2d")!;
  const grid = ditherGrid(g, cols, rows);
  const cw = c.width / cols;
  const rh = c.height / rows;
  for (let r = 0; r < rows; r++)
    for (let k = 0; k < cols; k++) {
      ctx.fillStyle = colors[grid[r * cols + k]] ?? "#888";
      ctx.fillRect(Math.floor(k * cw), Math.floor(r * rh), Math.ceil(cw) + 1, Math.ceil(rh) + 1);
    }
}

/**
 * Paint a 2D gradient (any kind) over its shape: dithered cells clipped to
 * the outline, optionally with the mesh / points on top.
 */
function paintShape(
  c: HTMLCanvasElement | null,
  g: GradientParams,
  colors: string[],
  shape: { paths: Path2D; box: { x: number; y: number; w: number; h: number } },
  cell: number,
  marks?: { selected: number[] },
) {
  if (!c) return;
  const dpr = window.devicePixelRatio || 1;
  const W = c.clientWidth || 200;
  const H = c.clientHeight || 100;
  c.width = Math.round(W * dpr);
  c.height = Math.round(H * dpr);
  const ctx = c.getContext("2d")!;
  ctx.scale(dpr, dpr);
  const { box } = shape;
  const sc = Math.min(W / Math.max(box.w, 1e-6), H / Math.max(box.h, 1e-6)) * 0.94;
  const ox = (W - box.w * sc) / 2 - box.x * sc;
  const oy = (H - box.h * sc) / 2 - box.y * sc;
  const cols = Math.max(6, Math.round((box.w * sc) / cell));
  const rows = Math.max(3, Math.round((box.h * sc) / cell));
  const grid = ditherCells((ci, ri) => weightsAt(g, [box.x + ((ci + 0.5) / cols) * box.w, box.y + ((ri + 0.5) / rows) * box.h]), Math.max(1, g.stops.length), g.dither, cols, rows);
  ctx.save();
  ctx.setTransform(dpr * sc, 0, 0, dpr * sc, dpr * ox, dpr * oy);
  ctx.clip(shape.paths, "evenodd");
  const cw = box.w / cols;
  const rh = box.h / rows;
  for (let r = 0; r < rows; r++)
    for (let k = 0; k < cols; k++) {
      ctx.fillStyle = colors[grid[r * cols + k]] ?? "#888";
      ctx.fillRect(box.x + k * cw, box.y + r * rh, cw * 1.04, rh * 1.04);
    }
  ctx.restore();
  ctx.save();
  ctx.setTransform(dpr * sc, 0, 0, dpr * sc, dpr * ox, dpr * oy);
  ctx.lineWidth = 1 / sc;
  ctx.strokeStyle = "rgba(0,0,0,.35)";
  ctx.stroke(shape.paths);
  ctx.restore();
  if (!marks) return;
  const sel = new Set(marks.selected);
  const tp = (p: [number, number]) => [p[0] * sc + ox, p[1] * sc + oy];
  ctx.lineWidth = 1;
  if (g.kind === "mesh" && meshValid(g.mesh)) {
    const m = g.mesh;
    ctx.strokeStyle = "rgba(255,255,255,.75)";
    ctx.beginPath();
    for (let r = 0; r < m.rows; r++)
      for (let k = 0; k < m.cols; k++) {
        const [x, y] = tp(m.nodes[r * m.cols + k].p);
        if (k) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
      }
    for (let k = 0; k < m.cols; k++)
      for (let r = 0; r < m.rows; r++) {
        const [x, y] = tp(m.nodes[r * m.cols + k].p);
        if (r) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
      }
    ctx.stroke();
  }
  const pts = g.kind === "mesh" ? g.mesh?.nodes ?? [] : g.kind === "freeform" ? g.points ?? [] : [];
  pts.forEach((q, i) => {
    const [x, y] = tp(q.p);
    ctx.beginPath();
    ctx.arc(x, y, sel.has(i) ? 4 : 3, 0, Math.PI * 2);
    ctx.fillStyle = colors[Math.min(colors.length - 1, q.c)] ?? "#888";
    ctx.fill();
    ctx.strokeStyle = sel.has(i) ? "#3b82f6" : "#fff";
    ctx.lineWidth = sel.has(i) ? 2 : 1.2;
    ctx.stroke();
  });
}

function useGradient(group: string) {
  const doc = useStore((s) => s.doc);
  const stops = stopsOf(doc, group);
  const first = doc.objects.find((o) => o.stitch.type === "fill" && o.stitch.gradient?.group === group);
  const g = first ? (first.stitch as GradientFill).gradient : null;
  const fill = first?.stitch as GradientFill | undefined;
  const colors = stops.map((s) => doc.threads.find((t) => t.id === s.thread)?.color ?? "#888");
  return { doc, stops, g, fill, colors, first };
}

/** Outline of the gradient's shape for previews. */
function useShape(group: string) {
  const doc = useStore((s) => s.doc);
  const layer = gradientLayers(doc, group)[0];
  if (!layer) return null;
  const paths = new Path2D();
  for (const sp of layer.paths) {
    if (!sp.closed) continue;
    const pts = flattenSubPath(sp, 0.5);
    pts.forEach((p, i) => (i ? paths.lineTo(p[0], p[1]) : paths.moveTo(p[0], p[1])));
    paths.closePath();
  }
  return { paths, box: gradientBox(group) };
}

/** The stop bar: drag stops / midpoints, click empty space to add a stop. */
export function GradientBar({ group, selected, onSelect }: { group: string; selected: number; onSelect: (i: number) => void }) {
  const { stops, g, colors } = useGradient(group);
  const ref = useRef<HTMLCanvasElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (g) paintDither(ref.current, { ...g, stops }, colors, 96, 10);
  });
  if (!g) return null;
  const posAt = (clientX: number) => {
    const r = bar.current!.getBoundingClientRect();
    return Math.min(1, Math.max(0, (clientX - r.left) / r.width));
  };
  const drag = (e: React.PointerEvent, apply: (pos: number) => StopEdit[]) => {
    e.preventDefault();
    e.stopPropagation();
    useStore.getState().checkpoint();
    const move = (ev: PointerEvent) => setStops(group, apply(posAt(ev.clientX)), true);
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const order = stops.map((_, i) => i).sort((a, b) => stops[a].pos - stops[b].pos);
  return (
    <div className="grad-bar-wrap">
      <div
        className="grad-bar"
        ref={bar}
        title="Click to add a colour stop"
        onPointerDown={(e) => {
          if (e.target !== e.currentTarget && e.target !== ref.current) return;
          const pos = posAt(e.clientX);
          // new stop takes the colour of the nearest stop
          const near = stops.reduce((b, s, i) => (Math.abs(s.pos - pos) < Math.abs(stops[b].pos - pos) ? i : b), 0);
          const next = [...stops, { pos, mid: 0.5, thread: stops[near].thread }].sort((a, b) => a.pos - b.pos);
          setStops(group, next);
          onSelect(next.findIndex((s) => s.pos === pos));
        }}
      >
        <canvas ref={ref} />
      </div>
      {stops.map((s, i) => (
        <button
          key={`s${i}`}
          className={`grad-stop ${i === selected ? "on" : ""}`}
          style={{ left: `${s.pos * 100}%`, background: colors[i] }}
          title={`Colour stop ${i + 1} at ${Math.round(s.pos * 100)} % · drag to move`}
          onPointerDown={(e) => {
            onSelect(i);
            drag(e, (pos) => stops.map((x, k) => (k === i ? { ...x, pos } : x)));
          }}
        />
      ))}
      {order.slice(0, -1).map((a, k) => {
        const b = order[k + 1];
        const p = stops[a].pos + (stops[b].pos - stops[a].pos) * stops[a].mid;
        return (
          <button
            key={`m${a}`}
            className="grad-mid"
            style={{ left: `${p * 100}%` }}
            title={`Midpoint ${Math.round(stops[a].mid * 100)} % · drag to move the 50 % mix`}
            onPointerDown={(e) =>
              drag(e, (pos) => {
                const span = stops[b].pos - stops[a].pos || 1;
                const mid = Math.min(0.95, Math.max(0.05, (pos - stops[a].pos) / span));
                return stops.map((x, i) => (i === a ? { ...x, mid } : x));
              })
            }
          />
        );
      })}
    </div>
  );
}

function DitherCard({
  id,
  label,
  title,
  active,
  g,
  colors,
  shape,
  onClick,
}: {
  id: DitherMethod;
  label: string;
  title: string;
  active: boolean;
  g: GradientParams;
  colors: string[];
  shape: ReturnType<typeof useShape>;
  onClick: () => void;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (is2D(g.kind) && shape) paintShape(ref.current, { ...g, dither: id }, colors, shape, 2);
    else paintDither(ref.current, { ...g, dither: id }, colors, 40, 8);
  });
  return (
    <button className={`dither-card ${active ? "on" : ""} ${is2D(g.kind) ? "tall" : ""}`} title={title} onClick={onClick}>
      <canvas ref={ref} />
      <span>{label}</span>
    </button>
  );
}

const ICON: Record<GradientKind, ReactNode> = {
  linear: (
    <svg viewBox="0 0 24 16">
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <rect key={i} x={i * 4} y={0} width={4} height={16} fill="currentColor" opacity={0.12 + i * 0.17} />
      ))}
    </svg>
  ),
  reflected: (
    <svg viewBox="0 0 24 16">
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <rect key={i} x={i * 4} y={0} width={4} height={16} fill="currentColor" opacity={0.95 - Math.min(i, 5 - i) * 0.35} />
      ))}
    </svg>
  ),
  radial: (
    <svg viewBox="0 0 24 16">
      {[8, 6, 4, 2].map((r, i) => (
        <circle key={r} cx={12} cy={8} r={r} fill="currentColor" opacity={0.2 + i * 0.22} />
      ))}
    </svg>
  ),
  conic: (
    <svg viewBox="0 0 24 16">
      <circle cx={12} cy={8} r={7.5} fill="currentColor" opacity={0.2} />
      <path d="M12 8 L19.5 8 A7.5 7.5 0 0 1 12 15.5 Z" fill="currentColor" opacity={0.95} />
      <path d="M12 8 L12 15.5 A7.5 7.5 0 0 1 4.5 8 Z" fill="currentColor" opacity={0.6} />
    </svg>
  ),
  mesh: (
    <svg viewBox="0 0 24 16" fill="none" stroke="currentColor" strokeWidth={1}>
      <path d="M2 2 H22 M2 8 C8 5 15 11 22 8 M2 14 H22 M2 2 V14 M9 2 C11 6 7 10 9 14 M15 2 C13 6 17 10 15 14 M22 2 V14" />
      {[
        [9, 7.3],
        [15, 8.6],
      ].map(([x, y]) => (
        <rect key={x} x={x - 1.6} y={y - 1.6} width={3.2} height={3.2} transform={`rotate(45 ${x} ${y})`} fill="currentColor" stroke="none" />
      ))}
    </svg>
  ),
  freeform: (
    <svg viewBox="0 0 24 16">
      <circle cx={6} cy={10} r={5} fill="currentColor" opacity={0.25} />
      <circle cx={17} cy={6} r={5} fill="currentColor" opacity={0.25} />
      <circle cx={6} cy={10} r={2} fill="currentColor" />
      <circle cx={17} cy={6} r={2} fill="currentColor" />
      <circle cx={14} cy={13} r={1.5} fill="currentColor" opacity={0.7} />
    </svg>
  ),
};

export const KINDS: [GradientKind, string, string][] = [
  ["linear", "Linear", "Straight from start to end"],
  ["reflected", "Reflect", "Mirrored around the start"],
  ["radial", "Radial", "Circles around the start"],
  ["conic", "Conic", "Sweeps around the start"],
  ["mesh", "Mesh", "Gradient mesh: a grid of colour nodes blended smoothly — click inside to add mesh lines, drag nodes to warp"],
  ["freeform", "Points", "Freeform colour points, each with its own spread — click the shape to add points"],
];

/** Gradient type picker with small previews. */
export function KindPicker({ value, onChange, compact }: { value: GradientKind; onChange: (k: GradientKind) => void; compact?: boolean }) {
  return (
    <div className={`grad-kinds ${compact ? "compact" : ""}`}>
      {KINDS.map(([id, label, title]) => (
        <button key={id} title={title} className={value === id ? "on" : ""} onClick={() => onChange(id)}>
          {ICON[id]}
          {!compact && <span>{label}</span>}
        </button>
      ))}
    </div>
  );
}

/** Thread swatches (plus charts / custom colours) for stops or selected nodes. */
function ThreadPick({ value, onPick, disabled }: { value?: string; onPick: (thread: string) => void; disabled?: boolean }) {
  return <ThreadPicker value={value} onPick={onPick} disabled={disabled} />;
}

/** Mesh / points editing: preview, colours, selected nodes. */
function Gradient2DEditor({ group }: { group: string }) {
  const { stops, g, colors } = useGradient(group);
  const shape = useShape(group);
  const sel = useStore((s) => s.gradNodes);
  const tool = useStore((s) => s.tool);
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (g && shape) paintShape(ref.current, g, colors, shape, 2.5, { selected: sel });
  });
  if (!g || !shape) return null;
  const nodes = g.kind === "mesh" ? g.mesh?.nodes ?? [] : g.points ?? [];
  const valid = sel.filter((i) => i < nodes.length);
  const selThread = valid.length ? stops[nodes[valid[0]].c]?.thread : undefined;
  const aspect = Math.min(1.1, Math.max(0.35, shape.box.h / Math.max(shape.box.w, 1e-6)));
  const isMesh = g.kind === "mesh";
  return (
    <>
      <canvas ref={ref} className="grad-preview" style={{ height: Math.round(220 * aspect) }} />
      <div className="grad-colors">
        {stops.map((_, i) => {
          const members = nodes.flatMap((n, k) => (n.c === i ? [k] : []));
          return (
            <button
              key={i}
              className={valid.length && valid.every((k) => nodes[k].c === i) ? "on" : ""}
              style={{ background: colors[i] }}
              title={`Colour ${i + 1}: ${members.length} ${isMesh ? "nodes" : "points"} · click to select them`}
              onClick={() => {
                const s = useStore.getState();
                s.set({ gradNodes: members });
                if (s.tool !== "gradient") s.setTool("gradient");
              }}
            >
              {members.length}
            </button>
          );
        })}
      </div>
      <div className="grad-stop-edit">
        <span className="stat">
          {valid.length ? `${valid.length} ${isMesh ? (valid.length === 1 ? "node" : "nodes") : valid.length === 1 ? "point" : "points"} selected` : `Select ${isMesh ? "nodes" : "points"} on the canvas to colour them`}
        </span>
        <ThreadPick value={selThread} disabled={!valid.length} onPick={(t) => colorNodes(group, valid, t)} />
        <div className="grad-stop-row">
          {isMesh ? (
            <>
              <label className="ctx-field" title="Mesh rows (keeps the warp, resamples the colours)">
                rows
                <Num value={g.mesh?.rows ?? 2} step={1} min={2} max={16} digits={0} onChange={(v) => { const m = meshResample(g, Math.round(v), g.mesh!.cols); if (m) commit2D(group, { mesh: m }); }} />
              </label>
              <label className="ctx-field" title="Mesh columns">
                cols
                <Num value={g.mesh?.cols ?? 2} step={1} min={2} max={16} digits={0} onChange={(v) => { const m = meshResample(g, g.mesh!.rows, Math.round(v)); if (m) commit2D(group, { mesh: m }); }} />
              </label>
            </>
          ) : (
            <label className="ctx-field" title="How far the colour of the selected points (or all points) reaches before it blends">
              spread
              <Num
                value={+(valid.length ? g.points![valid[0]].spread : (g.points ?? []).reduce((a, q) => a + q.spread, 0) / Math.max(1, g.points?.length ?? 1)).toFixed(1)}
                unit="mm"
                step={1}
                min={0.5}
                max={500}
                onChange={(v) => {
                  const on = new Set(valid.length ? valid : nodes.map((_, i) => i));
                  updateGradient(group, { points: (g.points ?? []).map((q, i) => (on.has(i) ? { ...q, spread: Math.max(0.5, v) } : q)) });
                }}
              />
            </label>
          )}
          <button
            className="btn sm ghost"
            disabled={!valid.length}
            title={isMesh ? "Remove the mesh lines through the selected node" : "Delete the selected points"}
            onClick={() => {
              if (!removeNodes(group, valid)) useStore.getState().toast(isMesh ? "The mesh border stays — select an inner node" : "A gradient keeps at least one colour point");
            }}
          >
            <Trash2 size={12} />
          </button>
        </div>
      </div>
      {tool !== "gradient" && (
        <button className="btn sm" style={{ marginBottom: 6 }} onClick={() => useStore.getState().setTool("gradient")}>
          Edit {isMesh ? "mesh" : "points"} on canvas (G)
        </button>
      )}
    </>
  );
}

/** Full gradient editor for the Properties panel. */
export function GradientSection({ group }: { group: string }) {
  const { stops, g, fill, colors } = useGradient(group);
  const shape = useShape(group);
  const [sel, setSel] = useState(0);
  if (!g || !fill) return null;
  const s = Math.min(sel, stops.length - 1);
  const stop = stops[s];
  const up = (p: Parameters<typeof updateGradient>[1]) => updateGradient(group, p);
  const flat = !is2D(g.kind);
  // flow and curved rows always blend the colours by density; straight rows
  // can also alternate whole rows or dither cell by cell
  const straight = fill.method !== "flow" && fill.method !== "curved";
  const mix = straight ? (g.mix ?? "blend") : "blend";
  const blended = mix === "blend";
  return (
    <div className="grad-panel">
      <KindPicker value={g.kind} onChange={(k) => setGradientKind(group, k)} />
      <RowStylePicker objects={useStore.getState().doc.objects.filter((o) => o.stitch.type === "fill" && o.stitch.gradient?.group === group)} kind={g.kind} />
      {flat ? (
        <>
          <GradientBar group={group} selected={s} onSelect={setSel} />
          <div className="grad-stop-edit">
            <span className="stat">Stop {s + 1}</span>
            <ThreadPick value={stop.thread} onPick={(t) => setStops(group, stops.map((x, i) => (i === s ? { ...x, thread: t } : x)))} />
            <div className="grad-stop-row">
              <label className="ctx-field" title="Position of this stop">
                at
                <Num value={Math.round(stop.pos * 100)} unit="%" step={5} min={0} max={100} digits={0} onChange={(v) => setStops(group, stops.map((x, i) => (i === s ? { ...x, pos: v / 100 } : x)))} />
              </label>
              <button className="btn sm ghost" title="Reverse the colours" onClick={() => setStops(group, stops.map((x) => ({ ...x, pos: 1 - x.pos, mid: 1 - x.mid })).reverse())}>
                <ArrowLeftRight size={12} />
              </button>
              <button className="btn sm ghost" disabled={stops.length <= 2} title="Delete this stop" onClick={() => setStops(group, stops.filter((_, i) => i !== s))}>
                <Trash2 size={12} />
              </button>
            </div>
          </div>
        </>
      ) : (
        <Gradient2DEditor group={group} />
      )}
      <Row label="Transition" title={g.kind === "mesh" ? "Smooth blends bicubically across the whole mesh; the others per patch" : undefined}>
        <select className="select" value={g.curve} onChange={(e) => up({ curve: e.target.value as GradientParams["curve"] })}>
          {CURVES.map((c) => (
            <option key={c.id} value={c.id}>
              {c.id === "smooth" && g.kind === "mesh" ? "Smooth (bicubic)" : c.label}
            </option>
          ))}
        </select>
        {g.curve === "steps" && <Num value={g.steps} step={1} min={2} max={12} digits={0} onChange={(v) => up({ steps: Math.round(v) })} />}
      </Row>
      {straight && (
        <div className="grad-rows">
          <span className="stat">Mix</span>
          <div className="seg" role="group" aria-label="Mix">
            <button className={mix === "blend" ? "on" : ""} title="Every colour sews its own rows, closer together where it is stronger (few jumps)" onClick={() => up({ mix: "blend" })}>
              Blend
            </button>
            <button
              className={mix === "rows" ? "on" : ""}
              title="Every row in one colour, the colours alternating rows through the transition (as Ink/Stitch's linear gradient fill); travel along the outline only"
              onClick={() => up({ mix: "rows" })}
            >
              Rows
            </button>
            <button className={mix === "dither" ? "on" : ""} title="The rows are cut into cells, each in one colour: a crisp pixel mix, with a jump at many cell borders" onClick={() => up({ mix: "dither" })}>
              Dither
            </button>
          </div>
        </div>
      )}
      {mix === "rows" ? (
        <p className="hint grad-blend-note">
          <b>Alternate rows.</b> Every row is sewn in one colour; through the transition the colours take turns, the runs of one colour getting
          shorter towards the next. Smoothest with the rows across the gradient{flat ? "" : " (2D gradients: by each row's average colour)"}.
        </p>
      ) : blended ? (
        <p className="hint grad-blend-note">
          <b>Blended by density.</b> Every colour sews its own rows, closer together where it is stronger, and the colours add up to the full
          density. {straight ? "Rows or Dither for a crisper mix." : "Flow and curved rows always blend."}
        </p>
      ) : (
        <div className="dither-cards">
          {DITHERS.map((d) => (
            <DitherCard key={d.id} {...d} active={g.dither === d.id} g={{ ...g, stops }} colors={colors} shape={shape} onClick={() => up({ dither: d.id })} />
          ))}
        </div>
      )}
      <Section title="Stitching" defaultOpen={false}>
        {mix === "dither" && (
          <Row label="Cell length" title="Length of the dither cells along the rows. Shorter mixes finer but adds stitches.">
            <Slider min={1} max={8} step={0.5} unit="mm" value={g.cell} onChange={(v) => up({ cell: v })} />
          </Row>
        )}
        <Row label="Row angle">
          <Slider min={-90} max={90} step={1} digits={0} unit="°" value={fill.angle} onChange={(v) => up({ angle: v })} />
        </Row>
        <Row label="Row spacing">
          <Slider min={0.15} max={1} step={0.01} unit="mm" value={fill.rowSpacing} onChange={(v) => up({ rowSpacing: v })} />
        </Row>
        {g.dither === "noise" && mix === "dither" && (
          <Row label="Variation">
            <button className="btn sm" onClick={() => up({ seed: (g.seed % 9973) + 1 })}>
              Shuffle
            </button>
          </Row>
        )}
      </Section>
      <p className="hint">
        {g.kind === "mesh"
          ? "Gradient tool (G): click inside the mesh to add a row and a column (on a line: just the crossing line), drag nodes to warp, Shift-click to select several, Alt-click a node to remove its lines."
          : g.kind === "freeform"
            ? "Gradient tool (G): click the shape to add a colour point, drag points to move them, drag the square on the ring to change the spread, Alt-click to delete."
            : "Drag the gradient on the canvas with the gradient tool (G)."}{" "}
        Every colour is its own layer; together they keep an even density.
      </p>
      <button className="btn sm ghost" onClick={() => removeGradient(group)}>
        Remove gradient
      </button>
    </div>
  );
}

/** Compact controls for the context bar while the gradient tool is active. */
export function GradientBarCompact({ group }: { group: string }) {
  const { g, stops, fill } = useGradient(group);
  const [sel, setSel] = useState(0);
  const nodeSel = useStore((s) => s.gradNodes);
  const blended = fill?.method === "flow" || fill?.method === "curved" || (g?.mix ?? "blend") !== "dither";
  if (!g) return null;
  const nodes = g.kind === "mesh" ? g.mesh?.nodes ?? [] : g.points ?? [];
  const valid = nodeSel.filter((i) => i < nodes.length);
  return (
    <>
      {is2D(g.kind) ? (
        <div style={{ maxWidth: 260, overflow: "hidden" }}>
          <ThreadPick value={valid.length ? stops[nodes[valid[0]].c]?.thread : undefined} disabled={!valid.length} onPick={(t) => colorNodes(group, valid, t)} />
        </div>
      ) : (
        <div style={{ width: 220 }}>
          <GradientBar group={group} selected={sel} onSelect={setSel} />
        </div>
      )}
      <KindPicker value={g.kind} compact onChange={(k) => setGradientKind(group, k)} />
      <select className="select" style={{ width: 96 }} value={g.curve} onChange={(e) => updateGradient(group, { curve: e.target.value as GradientParams["curve"] })}>
        {CURVES.map((c) => (
          <option key={c.id} value={c.id}>
            {c.label}
          </option>
        ))}
      </select>
      {!blended && (
        <select className="select" style={{ width: 104 }} value={g.dither} onChange={(e) => updateGradient(group, { dither: e.target.value as DitherMethod })}>
          {DITHERS.map((d) => (
            <option key={d.id} value={d.id}>
              {d.label}
            </option>
          ))}
        </select>
      )}
    </>
  );
}

/** A gradient swatch with rows along or across its colour bands. */
function FlowDirIcon({ across }: { across: boolean }) {
  return (
    <svg width="18" height="12" viewBox="0 0 18 12" aria-hidden="true" className="flow-dir-icon">
      <defs>
        <linearGradient id={`fdg${across ? 1 : 0}`} x1="0" x2="1">
          <stop offset="0" stopColor="currentColor" stopOpacity="0.15" />
          <stop offset="1" stopColor="currentColor" stopOpacity="0.55" />
        </linearGradient>
      </defs>
      <rect x="0.5" y="0.5" width="17" height="11" rx="2.5" fill={`url(#fdg${across ? 1 : 0})`} />
      {across
        ? [3.5, 6, 8.5].map((y) => <path key={y} d={`M3 ${y} C7 ${y - 1.6}, 11 ${y + 1.6}, 15 ${y}`} stroke="currentColor" strokeWidth="1" fill="none" />)
        : [5, 9, 13].map((x) => <path key={x} d={`M${x} 2.5 C${x - 1.6} 5, ${x + 1.6} 7, ${x} 9.5`} stroke="currentColor" strokeWidth="1" fill="none" />)}
    </svg>
  );
}

/** Straight rows, curved rows (along the outline, the mesh or around the colour points) or flow (the gradient's colour bands, or the picture's flow). */
export function RowStylePicker({ objects, kind }: { objects: DesignObject[]; kind?: GradientKind }) {
  const style = rowStyleOf(objects);
  const flow = canFlow(objects);
  const curvedHint =
    kind === "mesh" ? "Rows follow the mesh: warp it and the stitches bend with it" : kind === "freeform" ? "Rows circle the colour points, and follow the outline further out" : "Rows follow the outline of the shape";
  const ids = objects.map((o) => o.id);
  const fromColours = flow && objects.every((o) => flowSource(o) === "colours");
  const across = objects[0]?.stitch.type === "fill" && !!objects[0].stitch.flowAcross;
  const flowHint = !flow
    ? "Needs a colour gradient, or a fill made by the auto-digitizer with the Flow fill (it carries the picture's direction field)"
    : fromColours
      ? kind === "radial" || kind === "reflected"
        ? "Rows follow the colour bands: rings around a radial gradient"
        : "Rows follow the colour bands of the gradient, wherever they bend"
      : "Rows follow the picture's flow";
  return (
    <div className="grad-rows">
      <span className="stat">Rows</span>
      <div className="seg" role="group" aria-label="Rows">
        <button className={style === "tatami" ? "on" : ""} title="Straight rows (tatami)" onClick={() => setRowStyle(ids, "tatami")}>
          Straight
        </button>
        <button className={style === "curved" ? "on" : ""} title={curvedHint} onClick={() => setRowStyle(ids, "curved")}>
          Curved
        </button>
        <button
          className={style === "flow" ? "on" : ""}
          disabled={!flow}
          title={flowHint}
          onClick={() => setRowStyle(ids, "flow")}
        >
          Flow
        </button>
      </div>
      {style === "flow" && fromColours && (
        <div className="seg flow-dir" role="group" aria-label="Flow direction">
          <button className={!across ? "on" : ""} title="Rows run along the colour bands: each row keeps one shade" onClick={() => setFlowAcross(ids, false)}>
            <FlowDirIcon across={false} /> Along
          </button>
          <button className={across ? "on" : ""} title="Rows run across the colour bands: from one colour into the next" onClick={() => setFlowAcross(ids, true)}>
            <FlowDirIcon across /> Across
          </button>
        </div>
      )}
    </div>
  );
}
