// Routing (Ink/Stitch auto-route running stitch, auto-route satin columns,
// redwork, jump to stroke): one dialog with the options of each; the quick
// buttons in the context bar run with the options remembered here.

import { type LucideIcon } from "lucide-react";
import { Jump, StitchRunning, StitchSatin } from "../icons/stitch";
import { useState } from "react";
import { autoRouteSatins, autoRouteSelection, autoSatinOptions, jumpsToStrokes, setAutoSatinOptions } from "../lib/autoRoute";
import { useStore } from "../store";
import { Dialog, Num, Row, Toggle } from "./ui";
import { safeSetItem } from "../lib/storage";

export type RouteTab = "running" | "satin" | "jumps";
let pendingTab: RouteTab | null = null;

/** Open the route dialog on one of its tabs. */
export function openRoute(tab: RouteTab) {
  pendingTab = tab;
  useStore.getState().setDialog("route");
}

const KEY = "filum.route";
interface RouteOptions {
  redwork: boolean;
  jumpMin: number;
  jumpMax: number;
}
const DEFAULTS: RouteOptions = { redwork: false, jumpMin: 1, jumpMax: 15 };
export function routeOptions(): RouteOptions {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") };
  } catch {
    return DEFAULTS;
  }
}

const TAB_ICONS: Record<RouteTab, LucideIcon> = { running: StitchRunning, satin: StitchSatin, jumps: Jump };
const TABS: [RouteTab, string, string][] = [
  ["running", "Running stitch", "One path through the selected running-stitch lines, sewn twice where it travels (Ink/Stitch auto-route running stitch)"],
  ["satin", "Satin columns", "One sewing order through the selected satins, cut where the route turns, running underpaths instead of jumps (Ink/Stitch auto-route satin columns)"],
  ["jumps", "Jumps", "Short jumps between objects of one colour become running stitches (Ink/Stitch jump to stroke)"],
];

function TabButton({ id, label, title, on, onClick }: { id: RouteTab; label: string; title: string; on: boolean; onClick: () => void }) {
  const Icon = TAB_ICONS[id];
  return (
    <button title={title} className={on ? "on" : ""} onClick={onClick}>
      <Icon size={13} /> {label}
    </button>
  );
}

export function RouteDialog({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<RouteTab>(() => {
    const t = pendingTab ?? "running";
    pendingTab = null;
    return t;
  });
  const [o, setO] = useState(routeOptions);
  const [satin, setSatin] = useState(autoSatinOptions);
  const hasSel = useStore((s) => s.selection.length > 0);
  const set = (p: Partial<RouteOptions>) =>
    setO((v) => {
      const next = { ...v, ...p };
      safeSetItem(KEY, JSON.stringify(next));
      return next;
    });
  const flip = (k: keyof typeof satin) => {
    const next = { ...satin, [k]: !satin[k] };
    setSatin(next);
    setAutoSatinOptions(next);
  };
  const run = () => {
    const err = tab === "running" ? autoRouteSelection(o.redwork) : tab === "satin" ? autoRouteSatins() : jumpsToStrokes(o.jumpMin, o.jumpMax);
    if (err) return useStore.getState().toast(err, "error");
    onClose();
  };
  return (
    <Dialog
      title="Route"
      onClose={onClose}
      footer={
        <>
          <div className="spacer" />
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={tab !== "jumps" && !hasSel} onClick={run}>
            {tab === "jumps" ? "Convert jumps" : "Route"}
          </button>
        </>
      }
    >
      <div className="seg seg-full" style={{ marginBottom: 10 }}>
        {TABS.map(([id, label, title]) => (
          <TabButton key={id} id={id} label={label} title={title} on={tab === id} onClick={() => setTab(id)} />
        ))}
      </div>
      {tab === "running" && (
        <>
          <Row label="Out and back" title="Redwork: every line sewn twice, once each way — one path, no jumps (Ink/Stitch redwork)">
            <Toggle on={o.redwork} onChange={(v) => set({ redwork: v })} />
          </Row>
          <p className="hint">{o.redwork ? "Every line is sewn out and back, so the path ends where it began." : "Lines are joined into as few paths as possible; where the route has to travel, it sews over a line twice."}</p>
        </>
      )}
      {tab === "satin" && (
        <>
          <Row label="Trim" title="Trim between parts that do not touch, instead of a jump">
            <Toggle on={satin.trim} onChange={() => flip("trim")} />
          </Row>
          <Row label="Keep order" title="Keep the order of the selection — only split satins and add underpaths">
            <Toggle on={satin.preserveOrder} onChange={() => flip("preserveOrder")} />
          </Row>
          <Row label="Keep originals" title="Keep the original satins (hidden) to edit them later">
            <Toggle on={satin.keepOriginals} onChange={() => flip("keepOriginals")} />
          </Row>
          <p className="hint">Running lines in the selection show where the route may travel.</p>
        </>
      )}
      {tab === "jumps" && (
        <>
          <Row label="Shortest" title="Jumps shorter than this stay jumps (the machine sews through them anyway)">
            <Num value={o.jumpMin} unit="mm" step={0.5} min={0} max={o.jumpMax} onChange={(v) => set({ jumpMin: v })} />
          </Row>
          <Row label="Longest" title="Longer jumps stay jumps and are trimmed">
            <Num value={o.jumpMax} unit="mm" step={1} min={o.jumpMin} max={100} onChange={(v) => set({ jumpMax: v })} />
          </Row>
          <p className="hint">{hasSel ? "Between the selected objects." : "Across the whole design (select objects to limit it)."} Only jumps within one colour.</p>
        </>
      )}
    </Dialog>
  );
}
