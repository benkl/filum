import { copyProperties, groupSelection, pasteProperties, ungroupSelection } from "./lib/arrange";
import { zoomBy } from "./components/menuModel";
import { hideSelection, lockSelection, orderSelection, showAll, unlockAll } from "./lib/arrange";
import { DensityLegend } from "./components/DensityPanel";
import { is2D, removeNodes, selectedGradient } from "./lib/gradient";
import { TextEditorOverlay } from "./components/Lettering";
import { Box, Mountain, Spline, Type, Upload } from "lucide-react";
import { Digitize, StitchRunning } from "./icons/stitch";
import { useEffect } from "react";
import { Canvas } from "./canvas/Canvas";
import { BottomBar } from "./components/BottomBar";
import { StitchOutPanel, seek, stepBlock, stepStitch } from "./components/StitchOut";
import { ContextBar, TitleBar, ToolRail } from "./components/Bars";
import { Dialogs } from "./components/Dialogs";
import { Workspace } from "./components/Panels";
import { togglePanels } from "./lib/panelActions";
import { MenuBar } from "./components/MenuBar";
import { fit, importFile, newDocument, nudge, openDocument, saveDocument, selectAll, cloneSelection } from "./lib/actions";
import { loadSample } from "./sample";
import { useStore } from "./store";
import { nodeToolKey } from "./lib/nodeActions";
import { referenceKey } from "./lib/references";
import { applyAccent } from "./lib/prefs";
import { StatusHints } from "./components/StatusHints";
import type { Tool } from "./types";

const TOOL_KEYS: Record<string, Tool> = {
  v: "select",
  a: "node",
  c: "cut",
  h: "pan",
  m: "ruler",
  p: "pen",
  f: "freehand",
  s: "satin",
  r: "rect",
  e: "ellipse",
  t: "text",
  g: "gradient",
  b: "builder",
  d: "guides",
};

function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest("input,textarea,select,[contenteditable]")) return;
      const s = useStore.getState();
      // a picture being adjusted, then the node tool's point selection
      if (!s.dialog && (referenceKey(e) || nodeToolKey(e))) {
        e.preventDefault();
        return;
      }
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      if (mod && k === "g") {
        e.preventDefault();
        if (e.shiftKey) ungroupSelection();
        else groupSelection();
        return;
      }
      if (mod && e.shiftKey && (k === "c" || k === "v")) {
        e.preventDefault();
        if (k === "c") copyProperties();
        else pasteProperties(false);
        return;
      }
      if (mod) {
        const map: Record<string, () => void> = {
          ",": () => s.openSettings(),
          "\\": togglePanels,
          "]": () => orderSelection(e.shiftKey ? "front" : "forward"),
          "}": () => orderSelection("front"),
          "[": () => orderSelection(e.shiftKey ? "back" : "backward"),
          "{": () => orderSelection("back"),
          "3": () => (e.altKey ? showAll() : hideSelection()),
          "2": () => (e.altKey ? unlockAll() : lockSelection()),
          k: () => s.setDialog("palette"),
          z: () => (e.shiftKey ? s.redo() : s.undo()),
          y: s.redo,
          d: s.duplicateSelection,
          a: selectAll,
          s: () => saveDocument(e.shiftKey),
          o: openDocument,
          i: importFile,
          e: () => s.setDialog("export"),
          p: () => s.setDialog(e.shiftKey ? "palette" : "production"),
          n: newDocument,
        };
        if (map[k]) {
          e.preventDefault();
          map[k]();
        }
        return;
      }
      if (s.dialog) return;
      if (k === "delete" || k === "backspace") {
        if (s.tool === "gradient" && s.gradNodes.length) {
          const sg = selectedGradient();
          if (sg && is2D(sg.params.kind)) {
            if (!removeNodes(sg.group, s.gradNodes)) s.toast(sg.params.kind === "mesh" ? "The mesh border stays — select an inner node" : "A gradient keeps at least one colour point");
            return;
          }
        }
        if (s.tool !== "pen" && s.tool !== "satin") s.deleteSelection();
        return;
      }
      if (k === "escape") {
        if (s.tool === "gradient" && s.gradNodes.length) s.set({ gradNodes: [] });
        else if (s.anim.index != null) s.set({ anim: { ...s.anim, playing: false, index: null } });
        else if (s.tool !== "select") s.setTool("select");
        else s.select([]);
        return;
      }
      // the stitch-out player takes the arrows while it is open
      if (s.anim.index != null && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const dir = k === "arrowleft" ? -1 : k === "arrowright" ? 1 : 0;
        if (dir) return (e.preventDefault(), e.shiftKey ? stepBlock(dir) : stepStitch(dir));
        if (k === "home") return (e.preventDefault(), seek(0));
        if (k === "end") return (e.preventDefault(), seek(Infinity));
      }
      const step = e.shiftKey ? s.prefs.nudgeBig : s.prefs.nudge;
      if (k === "arrowleft") return (e.preventDefault(), nudge(-step, 0));
      if (k === "arrowright") return (e.preventDefault(), nudge(step, 0));
      if (k === "arrowup") return (e.preventDefault(), nudge(0, -step));
      if (k === "arrowdown") return (e.preventDefault(), nudge(0, step));
      if (k === "1") return s.setViewMode("vector");
      if (k === "2") return s.setViewMode("stitch");
      if (k === "3") return s.setViewMode("realistic");
      if (k === "0" || k === ")") return fit(e.shiftKey ? "design" : "hoop");
      if (k === "?") return s.setDialog("shortcuts");
      if (k === "d" && e.altKey) return (e.preventDefault(), cloneSelection());
      if (k === "d" && e.shiftKey) return s.set({ showDensity: !s.showDensity });
      if (k === "+" || k === "=") return zoomBy(1.25);
      if (k === "-") return zoomBy(0.8);
      if (TOOL_KEYS[k] && !e.altKey) {
        if (k === "t") s.setTool("text");
        else s.setTool(TOOL_KEYS[k]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

function ViewModes() {
  const mode = useStore((s) => s.viewMode);
  const set = useStore((s) => s.setViewMode);
  return (
    <div className="viewmodes" role="group" aria-label="View mode">
      <button className={`icon-btn ${mode === "vector" ? "on" : ""}`} title="Vector view (1)" onClick={() => set("vector")}>
        <Spline size={15} />
      </button>
      <button className={`icon-btn ${mode === "stitch" ? "on" : ""}`} title="Stitch view (2)" onClick={() => set("stitch")}>
        <StitchRunning size={15} />
      </button>
      <button className={`icon-btn ${mode === "realistic" ? "on" : ""}`} title="Realistic view (3)" onClick={() => set("realistic")}>
        <Box size={15} />
      </button>
    </div>
  );
}

function EmptyHint() {
  const n = useStore((s) => s.doc.objects.length);
  const setDialog = useStore((s) => s.setDialog);
  if (n) return null;
  return (
    <div className="empty-hint">
      <div style={{ fontSize: 15, fontWeight: 600, color: "var(--text)" }}>Start a design</div>
      <div>Draw with the tools on the left, or drop an SVG, image or embroidery file here.</div>
      <div className="cards">
        <button className="card" onClick={() => setDialog("digitize")}>
          <Digitize size={18} />
          <b>Auto-digitize</b>Turn a logo or picture into stitches.
        </button>
        <button className="card" onClick={importFile}>
          <Upload size={18} />
          <b>Import</b>Ink/Stitch SVG, PES, DST, JEF, EXP, VP3…
        </button>
        <button className="card" onClick={() => useStore.getState().setTool("text")}>
          <Type size={18} />
          <b>Lettering</b>Click to type: stitched embroidery fonts, TTF/OTF, arcs.
        </button>
        <button className="card" onClick={loadSample}>
          <Mountain size={18} />
          <b>Sample</b>Open the mountain badge demo.
        </button>
      </div>
    </div>
  );
}

function PlanningIndicator() {
  const planning = useStore((s) => s.planning);
  const err = useStore((s) => s.planError);
  if (err) return <div className="planning" style={{ color: "var(--accent)" }}>Engine: {err}</div>;
  if (!planning) return null;
  return (
    <div className="planning">
      <span className="dot-pulse" /> generating stitches…
    </div>
  );
}

function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind ?? ""}`}>
          {t.text}
        </div>
      ))}
    </div>
  );
}

export default function App() {
  const theme = useStore((s) => s.theme);
  useShortcuts();
  const accent = useStore((s) => s.prefs.accent);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    applyAccent(accent, theme);
  }, [theme, accent]);
  return (
    <div className="app">
      <MenuBar />
      <TitleBar />
      <ContextBar />
      <Workspace
        rail={<ToolRail />}
        center={
          <div className="center">
            <div style={{ position: "relative", minHeight: 0, display: "grid" }}>
              <Canvas />
              <TextEditorOverlay />
              <ViewModes />
              <DensityLegend />
              <PlanningIndicator />
              <EmptyHint />
            </div>
            <StitchOutPanel />
            <BottomBar />
          </div>
        }
      />
      <StatusHints />
      <Dialogs />
      <Toasts />
    </div>
  );
}
