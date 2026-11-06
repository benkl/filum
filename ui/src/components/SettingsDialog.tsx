// Preferences: every setting of the app in one place, by section — look,
// canvas and editing, the machine of this design, export defaults, threads,
// the digitizer, optional downloads and files.

import { Brush, Cpu, Download, FileDown, FolderCog, Keyboard, MousePointer2 } from "lucide-react";
import { Digitize, Spool } from "../icons/stitch";
import { useState, type ReactNode } from "react";
import { machineById } from "../lib/machines";
import { MachineOptions } from "./MachineOptions";
import { DownloadsPanel } from "./DownloadsPanel";
import { ACCENTS, APP_COLOR, DEFAULT_PREFS } from "../lib/prefs";
import { loadMatchOptions, saveMatchOptions, useMyThreads } from "../lib/threads";
import { MATCH_PRESETS } from "../lib/threadMatch";
import { DEFAULT_TOOL_OPTIONS, useStore } from "../store";
import { Dialog, Num, Row, Toggle } from "./ui";
import { safeSetItem } from "../lib/storage";

type Tab = "appearance" | "canvas" | "export" | "threads" | "digitizer" | "downloads" | "files" | "keys";
const TABS: { id: Tab; label: string; icon: ReactNode }[] = [
  { id: "appearance", label: "Appearance", icon: <Brush size={15} /> },
  { id: "canvas", label: "Editing", icon: <MousePointer2 size={15} /> },
  { id: "export", label: "Export", icon: <FileDown size={15} /> },
  { id: "threads", label: "Threads", icon: <Spool size={15} /> },
  { id: "digitizer", label: "Digitizer", icon: <Digitize size={15} /> },
  { id: "downloads", label: "Downloads", icon: <Download size={15} /> },
  { id: "files", label: "Files & data", icon: <FolderCog size={15} /> },
  { id: "keys", label: "Keyboard", icon: <Keyboard size={15} /> },
];

function Seg<T extends string | number>({ value, options, onChange }: { value: T; options: [T, string, string?][]; onChange: (v: T) => void }) {
  return (
    <div className="seg">
      {options.map(([id, label, title]) => (
        <button key={String(id)} className={value === id ? "on" : ""} title={title} onClick={() => onChange(id)}>
          {label}
        </button>
      ))}
    </div>
  );
}

function Section({ title, hint, children }: { title: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <section className="st-sec">
      <h4>{title}</h4>
      {children}
      {hint && <p className="hint">{hint}</p>}
    </section>
  );
}

/** A remembered choice in local storage (export dialog defaults and the like). */
function useStored(key: string, fallback: string): [string, (v: string) => void] {
  const [v, setV] = useState(() => localStorage.getItem(key) ?? fallback);
  return [
    v,
    (x) => {
      safeSetItem(key, x);
      setV(x);
    },
  ];
}

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const stored = useStore((s) => s.settingsTab) as Tab;
  const tab: Tab = TABS.some((t) => t.id === stored) ? stored : "appearance";
  const setTab = (t: Tab) => useStore.setState({ settingsTab: t });
  return (
    <Dialog wide live title="Preferences" onClose={onClose}>
      <div className="st">
        <nav className="st-nav">
          {TABS.map((t) => (
            <button key={t.id} className={tab === t.id ? "on" : ""} onClick={() => setTab(t.id)}>
              {t.icon}
              {t.label}
            </button>
          ))}
        </nav>
        <div className="st-body">
          {tab === "appearance" && <Appearance />}
          {tab === "canvas" && <CanvasPrefs />}
          {tab === "export" && <ExportPrefs />}
          {tab === "threads" && <ThreadPrefs />}
          {tab === "digitizer" && <DigitizerPrefs />}
          {tab === "downloads" && <DownloadsPanel />}
          {tab === "files" && <FilePrefs />}
          {tab === "keys" && <KeyPrefs />}
        </div>
      </div>
    </Dialog>
  );
}

function Appearance() {
  const theme = useStore((s) => s.theme);
  const prefs = useStore((s) => s.prefs);
  const { setTheme, setPrefs } = useStore.getState();
  const custom = !ACCENTS.some((a) => a.color === prefs.accent);
  return (
    <>
      <Section title="Theme">
        <Row label="Interface">
          <Seg
            value={theme}
            onChange={setTheme}
            options={[
              ["light", "Light"],
              ["dark", "Dark"],
            ]}
          />
        </Row>
      </Section>
      <Section title="Highlight colour" hint="Selections, active tools, buttons and handles. The default is the Filum colour.">
        <div className="st-accents">
          {ACCENTS.map((a) => (
            <button key={a.color} className={prefs.accent === a.color ? "on" : ""} title={a.label} style={{ ["--c" as string]: a.color }} onClick={() => setPrefs({ accent: a.color })}>
              <i />
              <span>{a.color === APP_COLOR ? "Filum" : a.label}</span>
            </button>
          ))}
          <label className={`st-custom ${custom ? "on" : ""}`} title="Your own colour">
            <input type="color" value={prefs.accent} onChange={(e) => setPrefs({ accent: e.target.value })} />
            <span>Custom</span>
          </label>
        </div>
      </Section>
    </>
  );
}

function CanvasPrefs() {
  const s = useStore();
  const p = s.prefs;
  return (
    <>
      <Section title="Snapping" hint="Smart guides and point snapping are also in View ▸ Snapping; grid, jumps, underlay and stitch colours in the View menu; the fabric's look in the Design tab.">
        <Row label="Smart guides" title="Snap to other objects and the hoop while moving and scaling (Ctrl while dragging: off)">
          <Toggle on={s.smartGuides} onChange={(v) => s.set({ smartGuides: v })} />
        </Row>
        <Row label="Snap to points" title="Pen and node tool: new and moved points snap to existing points (hold Ctrl to ignore)">
          <Toggle on={p.snapPoints} onChange={(v) => s.setPrefs({ snapPoints: v })} />
        </Row>
      </Section>
      <Section title="Arrow keys" hint="Shift moves by the larger step.">
        <Row label="Objects">
          <span className="dz-inline">
            <Num value={p.nudge} unit="mm" step={0.1} min={0.05} max={20} onChange={(v) => s.setPrefs({ nudge: v })} />
            <span className="stat">Shift</span>
            <Num value={p.nudgeBig} unit="mm" step={0.5} min={0.1} max={100} onChange={(v) => s.setPrefs({ nudgeBig: v })} />
          </span>
        </Row>
        <Row label="Points">
          <span className="dz-inline">
            <Num value={p.nodeNudge} unit="mm" step={0.05} min={0.01} max={10} onChange={(v) => s.setPrefs({ nodeNudge: v })} />
            <span className="stat">Shift</span>
            <Num value={p.nodeNudgeBig} unit="mm" step={0.1} min={0.05} max={50} onChange={(v) => s.setPrefs({ nodeNudgeBig: v })} />
          </span>
        </Row>
      </Section>
      <Section title="Drawing tools" hint="Each tool remembers its settings from the tool bar.">
        <button
          className="btn sm"
          onClick={() => {
            for (const k of Object.keys(DEFAULT_TOOL_OPTIONS) as (keyof typeof DEFAULT_TOOL_OPTIONS)[]) s.setToolOptions(k, DEFAULT_TOOL_OPTIONS[k]);
          }}
        >
          Reset every tool's settings
        </button>
      </Section>
    </>
  );
}

function ExportPrefs() {
  const [fmt, setFmt] = useStored("filum.format", "pes");
  const [pes, setPes] = useStored("filum.pesVersion", "1");
  const [mid, setMid] = useStored("filum.machine", "doc");
  const [frame, setFrame] = useStored("filum.frame", "");
  const machine = machineById(mid);
  return (
    <>
      <Section title="Export" hint="The export dialog starts with this format and remembers what you choose there.">
        <Row label="Format">
          <select className="select" value={fmt} onChange={(e) => setFmt(e.target.value)}>
            {["pes", "dst", "jef", "exp", "vp3", "xxx", "pec", "u01", "tbf", "sew", "gcode", "csv", "txt", "col", "edr", "inf", "svg", "filum"].map((f) => (
              <option key={f} value={f}>
                .{f.toUpperCase()}
              </option>
            ))}
          </select>
        </Row>
        <Row label="PES version">
          <Seg
            value={pes}
            onChange={setPes}
            options={[
              ["1", "v1 · Brother colours", "Most compatible (what Ink/Stitch writes)"],
              ["6", "v6 · exact threads", "Adds the exact thread list"],
            ]}
          />
        </Row>
      </Section>
      <Section title="Machine for new designs" hint="Each design keeps its own machine and hoop (Design ▸ Machine); the export dialog changes the design's.">
        <Row label="New designs" title="The machine new designs start with (each design keeps its own: Design ▸ Machine)">
          <select
            className="select"
            value={mid}
            onChange={(e) => {
              setMid(e.target.value);
              setFrame("");
            }}
          >
            <MachineOptions />
          </select>
        </Row>
        {machine.frames.length > 0 && (
          <Row label="Hoop" title="The frame new designs start in">
            <select className="select" value={frame} onChange={(e) => setFrame(e.target.value)}>
              <option value="">Default (100 × 100 mm)</option>
              {machine.frames.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          </Row>
        )}
        <p className="hint">{machine.models}</p>
      </Section>
    </>
  );
}

function ThreadPrefs() {
  const mine = useMyThreads();
  const [match, setMatch] = useState(loadMatchOptions);
  return (
    <>
      <Section title="Matching" hint={MATCH_PRESETS.find((p) => p.id === match.preset)?.hint ?? "Your own settings (Thread colours ▸ matching options)."}>
        <Row label="Fit threads">
          <select
            className="select"
            value={match.preset}
            onChange={(e) => {
              const p = MATCH_PRESETS.find((x) => x.id === e.target.value);
              if (!p) return;
              const next = { ...match, ...p.opts, weights: { ...match.weights, ...(p.opts.weights ?? {}) }, preset: p.id };
              saveMatchOptions(next);
              setMatch(next);
            }}
          >
            {MATCH_PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
            {match.preset === "custom" && <option value="custom">Custom</option>}
          </select>
        </Row>
      </Section>
      <Section title="My threads" hint="The spools you own: fit a design to them in Thread colours.">
        <Row label="Spools">
          <span className="dz-inline">
            <b>{mine.length}</b>
            <button className="btn sm" onClick={() => useStore.getState().setDialog("threads")}>
              Thread colours…
            </button>
          </span>
        </Row>
      </Section>
    </>
  );
}

function DigitizerPrefs() {
  const [done, setDone] = useState(false);
  return (
    <>
      <Section title="Settings" hint="The digitizer remembers its settings between pictures.">
        <button
          className="btn sm"
          disabled={done}
          onClick={() => {
            localStorage.removeItem("filum.digitize.v2");
            localStorage.removeItem("filum.digitize.pane");
            setDone(true);
          }}
        >
          {done ? "Back to the defaults" : "Reset digitizer settings"}
        </button>
      </Section>
      <Section title="On-device AI" hint="Bundled with Filum and run on this computer — nothing is uploaded.">
        <ul className="st-list">
          <li>
            <Cpu size={13} /> MobileSAM — select objects in a picture
          </li>
          <li>
            <Cpu size={13} /> DexiNed — learned edges for line art
          </li>
          <li>
            <Cpu size={13} /> Informative Drawings — a learned line drawing
          </li>
          <li>
            <Cpu size={13} /> Tesseract — text that becomes lettering
          </li>
        </ul>
      </Section>
    </>
  );
}

function FilePrefs() {
  const prefs = useStore((s) => s.prefs);
  const [cleared, setCleared] = useState(false);
  return (
    <>
      <Section title="Autosave" hint="Keeps the design in this app's storage while you work, restored at the next start. Use Save for real files.">
        <Row label="Autosave">
          <Toggle on={prefs.autosave} onChange={(v) => useStore.getState().setPrefs({ autosave: v })} />
        </Row>
        <button
          className="btn sm"
          disabled={cleared}
          onClick={() => {
            localStorage.removeItem("filum.autosave");
            setCleared(true);
          }}
        >
          {cleared ? "Autosave cleared" : "Clear the autosaved design"}
        </button>
      </Section>
      <Section title="Reset" hint="Look, hints, snapping and arrow-key steps back to the defaults (designs, threads and My threads stay).">
        <button className="btn sm" onClick={() => useStore.getState().setPrefs(DEFAULT_PREFS)}>
          Reset preferences
        </button>
      </Section>
    </>
  );
}

function KeyPrefs() {
  const p = useStore((s) => s.prefs);
  const s = useStore.getState();
  return (
    <Section title="Shortcuts" hint="Ctrl+K finds any command by name; ? lists every shortcut.">
      <Row label="Shortcut hints" title="The bar along the bottom shows the keys and clicks of the current tool">
        <Toggle on={p.hints} onChange={(v) => s.setPrefs({ hints: v })} />
      </Row>
      <span className="dz-inline">
        <button className="btn sm" onClick={() => s.setDialog("shortcuts")}>
          All keyboard shortcuts…
        </button>
        <button className="btn sm ghost" onClick={() => s.setDialog("palette")}>
          Command palette…
        </button>
      </span>
    </Section>
  );
}
