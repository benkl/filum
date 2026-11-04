import { MoveHorizontal, Route, SlidersHorizontal } from "lucide-react";
import { Digitize, Fabric as FabricIcon, Hoop, PullCompensation, RowSpacing, SewOrder, Spool, StitchAngle, StitchFill, StitchLength, StitchRunning, StitchSatin, Underlay } from "../icons/stitch";
import { TOOL_ICONS } from "../icons/toolIcons";
import { autoRouteSatins, autoRouteSelection } from "../lib/autoRoute";
import { openRoute } from "./RouteDialog";
import { textOnPath } from "../lib/textOps";
import { GradientToolBar, ShapeToolBar } from "./ToolOptions";
import { ArrangeButtons } from "./ArrangeTools";
import { BuilderToolBar, GuidesToolBar, NodeToolBar, ToolOptionsBar } from "./ToolOptions";
import { TextBar, useSelectedTextGroup } from "./Lettering";
import { ConvertMenuButton } from "./ConvertTools";
import { ArrowLeftRight, Circle, CircleCheck, Import, Layers3 } from "lucide-react";
import { importFile, optimizeOrder } from "../lib/actions";
import { normAngle } from "../lib/geometry";
import { FABRICS } from "../lib/materials";
import { HOOP_GROUPS, HOOPS, hoopIndex, hoopOf } from "../lib/hoops";
import { useStore } from "../store";
import type { Fabric, StitchType, Tool } from "../types";
import { Num } from "./ui";

/** Hoop presets grouped by brand (option values are indices into HOOPS). */
export function HoopOptions() {
  return (
    <>
      {HOOP_GROUPS.map((g) => (
        <optgroup key={g} label={g}>
          {HOOPS.map((h, i) =>
            h.brand === g ? (
              <option key={h.name} value={i} title={`${h.width} × ${h.height} mm (width × height)`}>
                {h.name}
              </option>
            ) : null,
          )}
        </optgroup>
      ))}
    </>
  );
}

export { FABRICS } from "../lib/materials";

export function TitleBar() {
  const doc = useStore((s) => s.doc);
  const saved = useStore((s) => s.saved);
  const commit = useStore((s) => s.commit);
  const setDialog = useStore((s) => s.setDialog);
  const hoopIdx = hoopIndex(doc.hoop);
  return (
    <div className="titlebar">
      <input className="docname" value={doc.name} onChange={(e) => useStore.getState().liveUpdate((d) => ({ ...d, name: e.target.value }))} spellCheck={false} aria-label="Design name" />
      <span className={`saved ${saved ? "" : "dirty"}`}>
        {saved ? <CircleCheck size={13} /> : <Circle size={11} />}
        {saved ? "Saved" : "Edited"}
      </span>
      <label className="sel-icon" title="Fabric — adjusts pull compensation, density and underlay">
        <FabricIcon size={14} />
        <select
          className="select"
          aria-label="Fabric preset"
          title="Fabric — adjusts pull compensation, density and underlay"
          value={doc.fabric}
          onChange={(e) => useStore.getState().setFabric(e.target.value as Fabric)}
        >
          {FABRICS.map((f) => (
            <option key={f.id} value={f.id}>
              {f.label}
            </option>
          ))}
        </select>
      </label>
      <label className="sel-icon" title={`Hoop: ${doc.hoop.name} — ${doc.hoop.width} × ${doc.hoop.height} mm`}>
        <Hoop size={14} />
        <select
          className="select"
          aria-label="Hoop"
          title={`Hoop: ${doc.hoop.name} — ${doc.hoop.width} × ${doc.hoop.height} mm`}
          value={hoopIdx >= 0 ? hoopIdx : "custom"}
          onChange={(e) => {
            const h = HOOPS[+e.target.value];
            if (h) commit((d) => ({ ...d, hoop: hoopOf(h) }));
          }}
        >
          {hoopIdx < 0 && <option value="custom">{`${doc.hoop.width} × ${doc.hoop.height} mm`}</option>}
          <HoopOptions />
        </select>
      </label>
      <div className="spacer" />
      <button className="btn ghost" onClick={optimizeOrder} title="Reorder to minimise colour changes and jumps (keeps stacking)">
        <SewOrder size={14} /> Optimise
      </button>
      <button className="btn primary" onClick={() => setDialog("export")}>
        Export
      </button>
    </div>
  );
}

const TYPES: { id: StitchType; icon: React.ReactNode; title: string }[] = [
  { id: "running", icon: <StitchRunning size={14} />, title: "Running stitch" },
  { id: "satin", icon: <StitchSatin size={14} />, title: "Satin column" },
  { id: "fill", icon: <StitchFill size={14} />, title: "Fill" },
];

export function ContextBar() {
  const doc = useStore((s) => s.doc);
  const selection = useStore((s) => s.selection);
  const updateStitch = useStore((s) => s.updateStitch);
  const textGroup = useSelectedTextGroup();
  const tool = useStore((s) => s.tool);
  // the stitch count follows the plan as it is recomputed
  useStore((s) => s.plan);
  if (tool === "pen" || tool === "freehand" || tool === "satin") return <ToolOptionsBar tool={tool} />;
  if (tool === "gradient") return <GradientToolBar />;
  if (tool === "node") return <NodeToolBar />;
  if (tool === "builder") return <BuilderToolBar />;
  if (tool === "guides") return <GuidesToolBar />;
  if (tool === "rect") return <ShapeToolBar />;
  if (textGroup) return <TextBar group={textGroup} />;
  const sel = doc.objects.filter((o) => selection.includes(o.id));
  if (!sel.length) return <div className="contextbar">Select an object to edit its stitch settings</div>;
  if (sel.length > 1)
    return (
      <div className="contextbar">
        <span className="obj-name">
          <Layers3 size={14} />
          <span>{sel.length} objects selected</span>
        </span>
        <div className="vsep" />
        <ArrangeButtons count={sel.length} />
        <div className="vsep" />
        {sel.some((o) => o.text) && sel.some((o) => !o.text) && (
          <>
            <button
              className="btn sm"
              title="Lay the lettering along the selected line (Ink/Stitch lettering along path)"
              onClick={() => {
                void textOnPath().then((err) => err && useStore.getState().toast(err, "error"));
              }}
            >
              Text on path
            </button>
            <div className="vsep" />
          </>
        )}
        {sel.some((o) => o.stitch.type === "satin") && sel.every((o) => o.stitch.type === "satin" || o.stitch.type === "running") && <AutoSatinBar />}
        {sel.every((o) => o.stitch.type === "running") && (
          <>
            <button
              className="btn sm"
              title="Auto-route: join the lines into as few continuous paths as possible, travelling along lines already sewn (Ink/Stitch auto-route running stitch)"
              onClick={() => {
                const err = autoRouteSelection();
                if (err) useStore.getState().toast(err, "error");
              }}
            >
              <Route size={13} /> Auto-route
            </button>
            <button
              className="btn sm ghost"
              title="Redwork: every line sewn exactly twice, out and back — one path without jumps that ends where it began (Ink/Stitch redwork)"
              onClick={() => {
                const err = autoRouteSelection(true);
                if (err) useStore.getState().toast(err, "error");
              }}
            >
              Redwork
            </button>
            <div className="vsep" />
          </>
        )}
        <ConvertMenuButton objects={sel} />
        <div className="seg" role="group" aria-label="Stitch type">
          {TYPES.map((t) => (
            <button
              key={t.id}
              title={`Make all ${t.title.toLowerCase()}`}
              className={sel.every((o) => o.stitch.type === t.id) ? "on" : ""}
              onClick={() => {
                useStore.getState().checkpoint();
                for (const o of sel) useStore.getState().updateStitch(o.id, { type: t.id }, true);
              }}
            >
              {t.icon}
            </button>
          ))}
        </div>
      </div>
    );
  const o = sel[0];
  const st = o.stitch;
  const thread = doc.threads.find((t) => t.id === o.thread);
  return (
    <div className="contextbar">
      <span className="obj-name">
        <span className="swatch" style={{ background: thread?.color }} />
        <span>{o.name}</span>
      </span>
      <div className="seg" role="group" aria-label="Stitch type">
        {TYPES.map((t) => (
          <button key={t.id} title={t.title} className={st.type === t.id ? "on" : ""} onClick={() => updateStitch(o.id, { type: t.id })}>
            {t.icon}
          </button>
        ))}
      </div>
      {st.type === "fill" && (
        <>
          <label className="ctx-field" title="Fill angle">
            <StitchAngle size={13} />
            <span className="sr-only">Fill angle</span>
            <Num value={st.angle} onChange={(v) => updateStitch(o.id, { angle: normAngle(v) })} unit="°" step={5} digits={1} />
          </label>
          <label className="ctx-field" title="Row spacing">
            <RowSpacing size={13} />
            <span className="sr-only">Row spacing</span>
            <Num value={st.rowSpacing} onChange={(v) => updateStitch(o.id, { rowSpacing: v })} unit="mm" step={0.05} min={0.1} />
          </label>
          <div className="vsep" />
          <div className="seg" title={st.underlayAuto ? "Underlay: automatic (by the shape and the fabric)" : "Underlay"}>
            <button
              className={st.underlay || st.underlayAuto ? "on" : ""}
              onClick={() => updateStitch(o.id, st.underlay || st.underlayAuto ? { underlay: false, underlayAuto: false } : { underlay: true })}
            >
              <Underlay size={13} /> Underlay
            </button>
          </div>
        </>
      )}
      {st.type === "satin" && (
        <>
          {o.paths.length === 1 && (
            <label className="ctx-field" title="Column width">
              <MoveHorizontal size={13} />
              <span className="sr-only">Column width</span>
              <Num value={st.width} onChange={(v) => updateStitch(o.id, { width: v })} unit="mm" step={0.2} min={0.5} max={12} />
            </label>
          )}
          <label className="ctx-field" title="Zig-zag spacing">
            <RowSpacing size={13} />
            <span className="sr-only">Zig-zag spacing</span>
            <Num value={st.spacing} onChange={(v) => updateStitch(o.id, { spacing: v })} unit="mm" step={0.05} min={0.1} />
          </label>
          <label className="ctx-field" title="Pull compensation">
            <PullCompensation size={13} />
            <span className="sr-only">Pull compensation</span>
            <Num value={st.pullComp} onChange={(v) => updateStitch(o.id, { pullComp: v })} unit="mm" step={0.05} />
          </label>
          <button
            className={`icon-btn ${st.reverse ? "on" : ""}`}
            title={st.reverse ? "Direction reversed (click to restore)" : "Reverse direction"}
            aria-pressed={!!st.reverse}
            onClick={() => updateStitch(o.id, { reverse: !st.reverse })}
          >
            <ArrowLeftRight size={14} />
          </button>
        </>
      )}
      {st.type === "running" && (
        <>
          <label className="ctx-field" title="Stitch length">
            <StitchLength size={13} />
            <span className="sr-only">Stitch length</span>
            <Num value={st.length} onChange={(v) => updateStitch(o.id, { length: v })} unit="mm" step={0.1} min={0.5} max={6} />
          </label>
          <div className="seg" title="Passes along the line">
            <button className={st.beanRepeats < 2 ? "on" : ""} title="Single running stitch" onClick={() => updateStitch(o.id, { beanRepeats: 0 })}>
              Run
            </button>
            <button className={st.beanRepeats >= 2 && st.beanRepeats < 4 ? "on" : ""} title="Triple (bean) stitch" onClick={() => updateStitch(o.id, { beanRepeats: 2 })}>
              Triple
            </button>
            <button className={st.beanRepeats >= 4 ? "on" : ""} title="Five passes — very bold line" onClick={() => updateStitch(o.id, { beanRepeats: 4 })}>
              Heavy
            </button>
          </div>
        </>
      )}
      <ConvertMenuButton objects={sel} />
      <div className="spacer" />
      <span className="stat">{statFor(o.id)}</span>
    </div>
  );
}

function statFor(id: string) {
  const s = useStore.getState();
  const idx = s.doc.objects.findIndex((o) => o.id === id);
  const plan = s.plan;
  if (!plan || idx < 0) return "";
  let n = 0;
  for (let i = 0; i < plan.objects.length; i++) if (plan.objects[i] === idx && !(plan.flags[i] & 31)) n++;
  return `${n.toLocaleString()} stitches`;
}

const RAIL: ({ tool: Tool; title: string } | "-")[] = [
  { tool: "select", title: "Select (V)" },
  { tool: "pan", title: "Pan (H / Space)" },
  { tool: "ruler", title: "Ruler (M)" },
  { tool: "node", title: "Edit nodes (A)" },
  { tool: "cut", title: "Cutter (C) — click a line to split it, drag across a fill to cut it" },
  "-",
  { tool: "pen", title: "Pen (P) — click for corners, drag for curves; click first point to close" },
  { tool: "freehand", title: "Freehand (F)" },
  { tool: "satin", title: "Satin column (S) — click / drag for curves, scroll or [ ] for width, Enter to finish" },
  { tool: "guides", title: "Stitch direction (D): drag across a satin to guide its stitch angle, drag an end to turn it, Alt-click to delete" },
  { tool: "rect", title: "Rectangle (R)" },
  { tool: "ellipse", title: "Ellipse (E)" },
  "-",
  { tool: "text", title: "Lettering (T): click to place, type, then drag the handles" },
  { tool: "gradient", title: "Gradient (G): colour gradients, density gradients and colour blends — drag across a shape" },
  { tool: "builder", title: "Shape builder (B): drag across overlapping regions to merge them, Alt to delete" },
];

function RailButton({ tool, title, on, onClick }: { tool: Tool; title: string; on: boolean; onClick: () => void }) {
  const Icon = TOOL_ICONS[tool];
  return (
    <button className={`icon-btn ${on ? "on" : ""}`} title={title} aria-pressed={on} onClick={onClick}>
      <Icon size={17} />
    </button>
  );
}

export function ToolRail() {
  const tool = useStore((s) => s.tool);
  const setTool = useStore((s) => s.setTool);
  const setDialog = useStore((s) => s.setDialog);
  return (
    <nav className="toolrail" aria-label="Tools">
      {RAIL.map((t, i) => (t === "-" ? <div className="grp-sep" key={i} /> : <RailButton key={t.tool} tool={t.tool} title={t.title} on={tool === t.tool} onClick={() => setTool(t.tool)} />))}
      <div className="grp-sep" />
      <button className="icon-btn" title="Import artwork or embroidery file" onClick={importFile}>
        <Import size={17} />
      </button>
      <button className="icon-btn" title="Digitize a picture" onClick={() => setDialog("digitize")}>
        <Digitize size={17} />
      </button>
      <button className="icon-btn" title="Thread colours" onClick={() => setDialog("threads")}>
        <Spool size={17} />
      </button>
    </nav>
  );
}

/** Auto-route satin columns: the quick button (the options are in Path ▸ Route). */
function AutoSatinBar() {
  return (
    <>
      <button
        className="btn sm"
        title="Auto-route satins: one sewing order through the selected satin columns — cut where the route turns, running underpaths hidden beneath them instead of jumps (Ink/Stitch auto-route satin columns). Running lines in the selection show where to travel."
        onClick={() => {
          const err = autoRouteSatins();
          if (err) useStore.getState().toast(err, "error");
        }}
      >
        <Route size={13} /> Auto-route satins
      </button>
      <button className="icon-btn" title="Options: trim, keep order, keep originals" onClick={() => openRoute("satin")}>
        <SlidersHorizontal size={14} />
      </button>
      <div className="vsep" />
    </>
  );
}
