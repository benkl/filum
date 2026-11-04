// Context bar while a drawing tool is active: what the tool will create and
// how it behaves.

import { AlignHorizontalJustifyCenter, Combine, AlignVerticalJustifyCenter, CircleDashed, Hexagon, Link2, PenLine, PenTool, Scissors, Spline, Square, Star, Trash2 } from "lucide-react";
import { MoveHorizontal } from "lucide-react";
import { GradientTool, StitchAngle, StitchLength, StitchSatin } from "../icons/stitch";
import { alignSelected, breakNodes, deleteNodes, joinSelected, nodeType, segmentType, toggleClosedSelected } from "../lib/nodeActions";
import { combineShapes } from "../lib/arrange";
import { divideSelection, builderTargets } from "../lib/shapeBuilder";
import { RAMP_PROFILES, rampMembers, rampOf, removeRamp, selectedRamp, updateRamp } from "../lib/ramp";
import { useStore } from "../store";
import { is2D, selectedGradient } from "../lib/gradient";
import { GradientBarCompact, KindPicker, RowStylePicker } from "./GradientPanel";
import { Num } from "./ui";
import { GuideActions } from "./SatinGuides";

type DrawTool = "pen" | "freehand" | "satin";

function Seg<T extends string>({ value, options, onChange, label }: { value: T; options: [T, string, string?][]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map(([id, text, title]) => (
        <button key={id} className={value === id ? "on" : ""} title={title} onClick={() => onChange(id)}>
          {text}
        </button>
      ))}
    </div>
  );
}

export function ToolOptionsBar({ tool }: { tool: DrawTool }) {
  const opts = useStore((s) => s.toolOptions);
  const set = useStore((s) => s.setToolOptions);
  if (tool === "pen")
    return (
      <div className="contextbar">
        <span className="obj-name">
          <PenTool size={14} />
          <span>Pen</span>
        </span>
        <Seg
          label="Stitch"
          value={opts.pen.stitch}
          options={[
            ["running", "Run", "Single running stitch"],
            ["triple", "Triple", "Triple (bean) stitch: bold outlines"],
          ]}
          onChange={(v) => set("pen", { stitch: v })}
        />
        <label className="ctx-field" title="Stitch length">
          <StitchLength size={13} />
          <span className="sr-only">Stitch length</span>
          <Num value={opts.pen.length} unit="mm" step={0.1} min={0.5} max={8} onChange={(v) => set("pen", { length: v })} />
        </label>
        <span className="ctx-label">Closed shapes</span>
        <Seg
          label="Closed shapes"
          value={opts.pen.closed}
          options={[
            ["run", "Outline", "A closed path stays a running-stitch outline"],
            ["fill", "Fill", "A closed path becomes a filled area"],
          ]}
          onChange={(v) => set("pen", { closed: v })}
        />
        <span className="ctx-help">Drag for curves · Alt breaks handles · Space moves the point · points snap to existing points (Ctrl: off) · ending on another path's end joins them · Alt-click a point to delete</span>
      </div>
    );
  if (tool === "freehand")
    return (
      <div className="contextbar">
        <span className="obj-name">
          <PenLine size={14} />
          <span>Freehand</span>
        </span>
        <Seg
          label="Output"
          value={opts.freehand.output}
          options={[
            ["running", "Run"],
            ["triple", "Triple"],
            ["satin", "Satin", "A satin column along the stroke"],
          ]}
          onChange={(v) => set("freehand", { output: v })}
        />
        {opts.freehand.output === "satin" && (
          <label className="ctx-field" title="Column width">
            <MoveHorizontal size={13} />
            <span className="sr-only">Column width</span>
            <Num value={opts.freehand.width} unit="mm" step={0.1} min={0.5} max={12} onChange={(v) => set("freehand", { width: v })} />
          </label>
        )}
        <label className="ctx-field ctx-slider" title="Stabiliser: the line trails the pointer and is fitted with smooth curves">
          Smoothing
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={opts.freehand.smoothing}
            onChange={(e) => set("freehand", { smoothing: +e.target.value })}
          />
          <span className="ctx-val">{Math.round(opts.freehand.smoothing * 100)}%</span>
        </label>
        <label className="ctx-field" title="Curve fitting: turns sharper than this stay corners">
          Corners
          <Num value={opts.freehand.corners ?? 65} unit="°" step={5} min={10} max={170} digits={0} onChange={(v) => set("freehand", { corners: v })} />
        </label>
        <label className="ctx-field" title="Curve fitting: straight runs of the stroke become straight lines">
          <input type="checkbox" checked={opts.freehand.lines ?? true} onChange={(e) => set("freehand", { lines: e.target.checked })} />
          Lines
        </label>
        <span className="ctx-label">Loops</span>
        <Seg
          label="Closed loops"
          value={opts.freehand.closed}
          options={[
            ["run", "Outline"],
            ["fill", "Fill", "A stroke that ends at its start becomes a filled area"],
          ]}
          onChange={(v) => set("freehand", { closed: v })}
        />
        <span className="ctx-help">The result is a clean Bézier path — edit it with the node tool (A)</span>
      </div>
    );
  return (
    <div className="contextbar">
      <span className="obj-name">
        <StitchSatin size={14} />
        <span>Satin column</span>
      </span>
      <label className="ctx-field" title="Width of the next point (scroll or [ ])">
        <MoveHorizontal size={13} />
        <span className="sr-only">Width of the next point (scroll or [ ])</span>
        <Num value={opts.satin.width} unit="mm" step={0.1} min={0.3} max={15} onChange={(v) => set("satin", { width: v })} />
      </label>
      <span className="ctx-help">
        Drag for curves · scroll over a point to change its width · click a segment to add a point · Alt-click to delete · click the first point to close
      </span>
    </div>
  );
}

/** Context bar of the gradient tool. */
export function GradientToolBar() {
  useStore((s) => s.selection);
  useStore((s) => s.doc);
  const mode = useStore((s) => s.toolOptions.gradient.kind);
  const setOpts = useStore((s) => s.setToolOptions);
  const sg = selectedGradient();
  const kind = sg?.params.kind;
  const gmode = useStore((s) => s.toolOptions.gradient.mode) ?? "colour";
  const ramped = selectedRamp();
  const modeSeg = (
    <div className="seg" role="group" aria-label="Gradient type">
      {(
        [
          ["colour", "Colour", "Multi-colour gradients with dithering (linear, radial, mesh, points)"],
          ["density", "Density", "Gradient fill: one colour, dense rows opening up along the drag"],
          ["blend", "Blend", "Colour blending: this colour fades out while a second fades in"],
        ] as const
      ).map(([id, label, title]) => (
        <button key={id} title={title} className={gmode === id ? "on" : ""} onClick={() => setOpts("gradient", { mode: id })}>
          {label}
        </button>
      ))}
    </div>
  );
  if (ramped || gmode !== "colour") return <RampToolBar modeSeg={modeSeg} />;
  const help =
    kind === "mesh"
      ? "Click inside to add mesh lines (on a line: one crossing line) · drag nodes · Shift-click to select several · Alt-click / Del removes lines · pick a thread to colour the selection"
      : kind === "freeform"
        ? "Click the shape to add a point · drag points · drag the ring square to set the spread · Alt-click / Del deletes · pick a thread to colour the selection"
        : "Drag the ends · drag stops along the line · click the line to add a stop · Alt-click a stop to remove it";
  return (
    <div className="contextbar">
      <span className="obj-name">
        <GradientTool size={14} />
        <span>Gradient</span>
      </span>
      {modeSeg}
      {sg ? (
        <>
          <GradientBarCompact group={sg.group} />
          <span className="ctx-help">{help}</span>
        </>
      ) : (
        <>
          <span className="ctx-label">New</span>
          <KindPicker value={mode} compact onChange={(k) => setOpts("gradient", { kind: k })} />
          <span className="ctx-help">
            {is2D(mode)
              ? mode === "mesh"
                ? "Click a closed shape: a gradient mesh with a new colour node where you click"
                : "Click a closed shape: freeform colour points, the new colour where you click"
              : "Select a closed shape, then drag across it to set the direction (Shift: 45° steps)"}
          </span>
        </>
      )}
    </div>
  );
}

/** Context bar of the rectangle tool: rectangle / polygon / star, corner radius. */
export function ShapeToolBar() {
  const o = useStore((s) => s.toolOptions.shape);
  const set = useStore((s) => s.setToolOptions);
  const up = (p: Partial<typeof o>) => set("shape", p);
  return (
    <div className="contextbar">
      <span className="obj-name">
        <Square size={14} />
        <span>Shape</span>
      </span>
      <div className="seg">
        {(
          [
            ["rect", "Rectangle", <Square key="r" size={14} />],
            ["polygon", "Polygon", <Hexagon key="p" size={14} />],
            ["star", "Star", <Star key="s" size={14} />],
          ] as const
        ).map(([k, label, icon]) => (
          <button key={k} title={label} className={o.kind === k ? "on" : ""} onClick={() => up({ kind: k })}>
            {icon}
          </button>
        ))}
      </div>
      {o.kind !== "rect" && (
        <label className="ctx-field" title={o.kind === "star" ? "Points" : "Sides"}>
          {o.kind === "star" ? "points" : "sides"}
          <Num value={o.sides} min={3} max={40} step={1} digits={0} onChange={(v) => up({ sides: Math.round(v) })} />
        </label>
      )}
      {o.kind === "star" && (
        <label className="ctx-field" title="Inner radius (share of the outer radius)">
          inner
          <Num value={Math.round(o.inner * 100)} min={5} max={95} step={5} digits={0} unit="%" onChange={(v) => up({ inner: v / 100 })} />
        </label>
      )}
      <label className="ctx-field" title="Corner radius (0 = sharp)">
        corners
        <Num value={o.radius} min={0} max={50} step={0.5} unit="mm" onChange={(v) => up({ radius: Math.max(0, v) })} />
      </label>
      <span className="ctx-help">Drag to draw · Shift: square / regular · round corners later with the node tool's corner widgets or Path ▸ Round corners</span>
    </div>
  );
}

/** Small node-type icons (lucide has none for these). */
function NodeIcon({ kind }: { kind: "corner" | "smooth" | "symmetric" | "line" | "curve" }) {
  const st = { fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
      {kind === "corner" && (
        <>
          <path d="M2 13 L8 4 L14 13" {...st} />
          <rect x="6" y="2" width="4" height="4" fill="currentColor" />
        </>
      )}
      {(kind === "smooth" || kind === "symmetric") && (
        <>
          <path d="M2 13 C4 4 12 4 14 13" {...st} />
          <path d={kind === "symmetric" ? "M3 6.3 H13" : "M5 6.3 H14.5"} {...st} strokeWidth={1} />
          <circle cx={kind === "symmetric" ? 8 : 9.5} cy="6.3" r="2" fill="currentColor" />
          <circle cx={kind === "symmetric" ? 3 : 5} cy="6.3" r="1.1" fill="currentColor" />
          <circle cx={kind === "symmetric" ? 13 : 14.5} cy="6.3" r="1.1" fill="currentColor" />
        </>
      )}
      {kind === "line" && (
        <>
          <path d="M3 12 L13 4" {...st} />
          <rect x="1.5" y="10.5" width="3" height="3" fill="currentColor" />
          <rect x="11.5" y="2.5" width="3" height="3" fill="currentColor" />
        </>
      )}
      {kind === "curve" && (
        <>
          <path d="M3 12 C3 4 13 12 13 4" {...st} />
          <rect x="1.5" y="10.5" width="3" height="3" fill="currentColor" />
          <rect x="11.5" y="2.5" width="3" height="3" fill="currentColor" />
        </>
      )}
    </svg>
  );
}

/** Node tool: what the selected points become. */
export function NodeToolBar() {
  const nodeSel = useStore((s) => s.nodeSel);
  const selection = useStore((s) => s.selection);
  const n = nodeSel.length;
  const none = !n;
  const B = ({ title, onClick, children, disabled }: { title: string; onClick: () => void; children: React.ReactNode; disabled?: boolean }) => (
    <button className="icon-btn" title={title} onClick={onClick} disabled={disabled ?? none}>
      {children}
    </button>
  );
  return (
    <div className="contextbar">
      <span className="obj-name">
        <Spline size={14} />
        <span>{n ? `${n} point${n > 1 ? "s" : ""}` : selection.length ? "Points" : "Edit nodes"}</span>
      </span>
      <div className="vsep" />
      <B title="Corner: no handles (Shift+C)" onClick={() => nodeType("corner")}>
        <NodeIcon kind="corner" />
      </B>
      <B title="Smooth: handles in line (Shift+S)" onClick={() => nodeType("smooth")}>
        <NodeIcon kind="smooth" />
      </B>
      <B title="Symmetric: handles in line and of equal length (Shift+Y)" onClick={() => nodeType("symmetric")}>
        <NodeIcon kind="symmetric" />
      </B>
      <div className="vsep" />
      <B title="Straight segments between the selected points (Shift+L)" onClick={() => segmentType("line")}>
        <NodeIcon kind="line" />
      </B>
      <B title="Curved segments between the selected points (Shift+U)" onClick={() => segmentType("curve")}>
        <NodeIcon kind="curve" />
      </B>
      <div className="vsep" />
      <B title="Break the path at the selected points (Shift+B)" onClick={breakNodes}>
        <Scissors size={15} />
      </B>
      <B title="Join two selected end points (Shift+J)" onClick={joinSelected} disabled={n !== 2}>
        <Link2 size={15} />
      </B>
      <B title="Close the path / open it at the selected point" onClick={toggleClosedSelected}>
        <CircleDashed size={15} />
      </B>
      <div className="vsep" />
      <B title="Align the selected points horizontally" onClick={() => alignSelected("h")} disabled={n < 2}>
        <AlignVerticalJustifyCenter size={15} />
      </B>
      <B title="Align the selected points vertically" onClick={() => alignSelected("v")} disabled={n < 2}>
        <AlignHorizontalJustifyCenter size={15} />
      </B>
      <div className="vsep" />
      <B title="Delete, keeping the shape (Del) · Shift+Del: plain delete" onClick={() => deleteNodes(true)}>
        <Trash2 size={15} />
      </B>
      <span className="ctx-help">
        {n
          ? "Drag to move · arrows nudge 0.1 mm (Shift 1 mm) · Shift-drag: straight · points snap to other points (Ctrl: off)"
          : "Click or drag a box to select points · Shift adds · Ctrl+A all · click a path to add a point · Alt-click deletes"}
      </span>
    </div>
  );
}

/** Gradient tool, Density / Blend: the ramp of the selection and the defaults for new ones. */
function RampToolBar({ modeSeg }: { modeSeg: React.ReactNode }) {
  useStore((s) => s.doc);
  useStore((s) => s.selection);
  const opts = useStore((s) => s.toolOptions.gradient);
  const set = useStore((s) => s.setToolOptions);
  const o = selectedRamp();
  const r = rampOf(o);
  const members = o ? rampMembers(useStore.getState().doc, o.id) : [];
  const profile = r?.profile ?? opts.profile ?? "linear";
  const dense = r?.dense ?? opts.dense ?? 0.25;
  const sparse = r?.sparse ?? opts.sparse ?? 2;
  // edits go to the selected ramp (and are the defaults for the next one)
  const change = (patch: { profile?: typeof profile; dense?: number; sparse?: number }) => {
    set("gradient", patch);
    if (o) updateRamp(o.id, patch);
  };
  return (
    <div className="contextbar">
      <span className="obj-name">
        <GradientTool size={14} />
        <span>Gradient</span>
      </span>
      {modeSeg}
      <div className="vsep" />
      <label className="ctx-field" title="How the density changes along the drag">
        Profile
        <select className="select" value={profile} onChange={(e) => change({ profile: e.target.value as typeof profile })}>
          {RAMP_PROFILES.map((p) => (
            <option key={p.id} value={p.id} title={p.hint}>
              {p.label}
            </option>
          ))}
        </select>
      </label>
      <label className="ctx-field" title="Row spacing where the fill is densest">
        Dense
        <Num value={dense} unit="mm" step={0.05} min={0.1} max={2} onChange={(v) => change({ dense: v })} />
      </label>
      <label className="ctx-field" title="Row spacing where the fill is most open">
        Open
        <Num value={sparse} unit="mm" step={0.1} min={0.3} max={8} onChange={(v) => change({ sparse: v })} />
      </label>
      {o && <RowStylePicker objects={members} />}
      {o && (
        <button className="btn sm ghost" title="Back to a plain fill (a blend keeps its first colour)" onClick={() => removeRamp(o.id)}>
          <Trash2 size={13} /> Remove
        </button>
      )}
      <span className="ctx-help">
        {o
          ? `${members.length > 1 ? "Colour blend" : "Density gradient"} · drag the dot (dense) or the ring (open) · drag across the shape again for a new direction`
          : opts.mode === "blend"
            ? "Drag across a fill: its colour fades out, the next colour (the active one) fades in"
            : "Drag across a fill: dense where you start, open where you end · Shift: 45° steps"}
      </span>
    </div>
  );
}

/** Boolean icons: two overlapping squares, the result filled. */
function BoolIcon({ op }: { op: "unite" | "minusFront" | "intersect" | "exclude" | "divide" }) {
  const a = "M2 2 H10 V10 H2 Z";
  const b = "M6 6 H14 V14 H6 Z";
  const st = { stroke: "currentColor", strokeWidth: 1.2, fill: "none" };
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
      {op === "unite" && <path d="M2 2 H10 V6 H14 V14 H6 V10 H2 Z" fill="currentColor" />}
      {op === "minusFront" && <path d="M2 2 H10 V6 H6 V10 H2 Z" fill="currentColor" />}
      {op === "intersect" && <path d="M6 6 H10 V10 H6 Z" fill="currentColor" />}
      {op === "exclude" && <path d="M2 2 H10 V6 H6 V10 H2 Z M10 6 H14 V14 H6 V10 H10 Z" fill="currentColor" />}
      {op === "divide" && <path d="M2 2 H10 V10 H2 Z M6 6 H14 V14 H6 Z" fill="none" stroke="currentColor" strokeWidth="1.2" strokeDasharray="1.6 1" />}
      <path d={a} {...st} opacity={op === "divide" ? 0 : 0.6} />
      <path d={b} {...st} opacity={op === "divide" ? 0 : 0.6} />
    </svg>
  );
}

/** Stitch direction: the selected satin's guides — auto at corners, clear. */
export function GuidesToolBar() {
  return (
    <div className="contextbar">
      <span className="ctx-title">
        <StitchAngle size={13} /> Stitch direction
      </span>
      <GuideActions compact />
      <span className="ctx-help">Drag across a satin to guide its stitch angle · drag an end to turn it · Alt-click to delete · Shift: 15° steps</span>
    </div>
  );
}

/** Shape Builder: merge / delete mode, divide and the classic booleans. */
export function BuilderToolBar() {
  useStore((s) => s.selection);
  useStore((s) => s.doc);
  const mode = useStore((s) => s.toolOptions.builder.mode);
  const set = useStore((s) => s.setToolOptions);
  const n = builderTargets().length;
  const ops: [Parameters<typeof combineShapes>[0], string][] = [
    ["unite", "Unite: one shape of all"],
    ["minusFront", "Minus front: the bottom shape minus the others"],
    ["intersect", "Intersect: only where all overlap"],
    ["exclude", "Exclude: where an odd number overlap"],
  ];
  return (
    <div className="contextbar">
      <span className="obj-name">
        <Combine size={14} />
        <span>{n ? `Shape builder · ${n} shape${n > 1 ? "s" : ""}` : "Shape builder"}</span>
      </span>
      <div className="seg" role="group" aria-label="Drag across regions to">
        <button className={mode === "merge" ? "on" : ""} title="Drag across regions to merge them into one shape" onClick={() => set("builder", { mode: "merge" })}>
          Merge
        </button>
        <button className={mode === "delete" ? "on" : ""} title="Drag across regions to delete them (or hold Alt)" onClick={() => set("builder", { mode: "delete" })}>
          Delete
        </button>
      </div>
      <div className="vsep" />
      <button className="icon-btn" title="Divide: every overlap region becomes its own shape" disabled={n < 1} onClick={() => void divideSelection()}>
        <BoolIcon op="divide" />
      </button>
      {ops.map(([op, title]) => (
        <button key={op} className="icon-btn" title={title} disabled={n < 2} onClick={() => void combineShapes(op)}>
          <BoolIcon op={op as "unite"} />
        </button>
      ))}
      <span className="ctx-help">
        {n
          ? "Drag across regions to merge them · Alt-drag deletes · click one region to make it its own shape · Shift-click adds shapes"
          : "Click a fill, Shift-click the fills overlapping it — the regions appear"}
      </span>
    </div>
  );
}
