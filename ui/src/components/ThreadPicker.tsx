// Thread picking: the design's threads as swatches, plus a popover with the
// thread charts (search by name, code or #hex, nearest matches by
// CIEDE2000), a custom colour and recently used threads.

import { Check, ChevronDown, Download, Focus, Plus, Search, SlidersHorizontal, Trash2, X } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Grip, useMovable } from "./ui";
import {
  DEFAULT_CHART,
  SOURCE_LABEL,
  chartLabel,
  chartsToDownload,
  deltaLabel,
  inkOn,
  installPalette,
  loadChart,
  MY_CHART,
  ownedKey,
  useMyThreads,
  nearest,
  normHex,
  recentThreads,
  removeInstalledChart,
  searchChart,
  threadFor,
  threadUsage,
  useCharts,
  type ChartEntry,
  type ChartMeta,
  type RecentThread,
} from "../lib/threads";
import { useStore } from "../store";
import type { Thread } from "../types";

const CHART_KEY = "filum.chart";
export const lastChart = () => localStorage.getItem(CHART_KEY) ?? DEFAULT_CHART;
export const setLastChart = (c: string) => localStorage.setItem(CHART_KEY, c);

const RECENT_CHARTS_KEY = "filum.recentCharts";
function recentCharts(): string[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_CHARTS_KEY) ?? "[]");
  } catch {
    return [];
  }
}
const touchChart = (id: string) => localStorage.setItem(RECENT_CHARTS_KEY, JSON.stringify([id, ...recentCharts().filter((x) => x !== id)].slice(0, 6)));

const SOURCE_TAG: Record<ChartMeta["source"], string> = { mine: "MY", inkstitch: "IS", embroiderynerd: "EN", madeira: "MD", custom: "★" };

/**
 * Choose a thread chart: a button with the chart's name; the menu searches
 * all charts (name, brand, collection), lists recently used ones first and
 * the rest by brand, and installs .gpl palettes.
 */
export function ChartSelect({ value, onChange, none }: { value: string; onChange: (id: string) => void; none?: string }) {
  const list = useCharts();
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const meta = list.find((c) => c.id === value);
  const label = value ? (meta?.name ?? chartLabel(value)) : (none ?? "None");
  return (
    <>
      <button
        type="button"
        ref={btn}
        className={`chart-select ${open ? "on" : ""}`}
        title={meta ? `${meta.name} · ${meta.count} colours · ${SOURCE_LABEL[meta.source]}` : label}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="cs-name">{label}</span>
        {meta && meta.source !== "inkstitch" && <i className={`src-tag ${meta.source}`}>{SOURCE_TAG[meta.source]}</i>}
        <ChevronDown size={13} />
      </button>
      {open && btn.current && (
        <ChartMenu
          anchor={btn.current}
          value={value}
          none={none}
          onPick={(id) => {
            if (id) touchChart(id);
            onChange(id);
            setOpen(false);
          }}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function ChartMenu({ anchor, value, none, onPick, onClose }: { anchor: HTMLElement; value: string; none?: string; onPick: (id: string) => void; onClose: () => void }) {
  const list = useCharts();
  const ref = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState("");
  const [pos, setPos] = useState({ left: 0, top: 0, maxHeight: 360 });
  const [busy, setBusy] = useState(false);
  // charts offered in Preferences ▸ Downloads that aren't installed yet
  const [more, setMore] = useState(0);
  useEffect(() => {
    let live = true;
    chartsToDownload().then((n) => live && setMore(n));
    return () => {
      live = false;
    };
  }, [list]);
  useLayoutEffect(() => {
    const r = anchor.getBoundingClientRect();
    const w = 300;
    const left = Math.max(8, Math.min(window.innerWidth - w - 8, r.left));
    const below = window.innerHeight - r.bottom - 12;
    const above = r.top - 12;
    const maxHeight = Math.min(420, Math.max(below, above));
    const top = below >= Math.min(320, above) ? r.bottom + 4 : Math.max(8, r.top - 4 - Math.min(420, maxHeight));
    setPos({ left, top, maxHeight });
    input.current?.focus();
  }, [anchor]);
  useEffect(() => {
    const down = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node) && !anchor.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && (e.stopPropagation(), onClose());
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("keydown", key, true);
    };
  }, [anchor, onClose]);
  const groups = useMemo(() => {
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const hit = (c: ChartMeta) => words.every((w) => `${c.name} ${c.brand} ${SOURCE_LABEL[c.source]}`.toLowerCase().includes(w));
    const shown = list.filter(hit);
    const out: [string, ChartMeta[]][] = [];
    if (!words.length) {
      const recent = recentCharts()
        .map((id) => list.find((c) => c.id === id))
        .filter((c): c is ChartMeta => !!c);
      if (recent.length) out.push(["Recent", recent]);
    }
    const mine = shown.filter((c) => c.source === "mine");
    if (mine.length) out.unshift(["My threads", mine]);
    const installed = shown.filter((c) => c.source === "custom");
    if (installed.length) out.push(["Installed", installed]);
    const byBrand = new Map<string, ChartMeta[]>();
    for (const c of shown) if (c.source !== "custom" && c.source !== "mine") byBrand.set(c.brand, [...(byBrand.get(c.brand) ?? []), c]);
    for (const [b, cs] of [...byBrand].sort((x, y) => x[0].localeCompare(y[0]))) out.push([b, cs]);
    return out;
  }, [list, q]);
  const total = list.length;
  const install = async () => {
    setBusy(true);
    try {
      const m = await installPalette();
      if (m) onPick(m.id);
    } catch (e) {
      useStore.getState().toast(String((e as Error).message ?? e), "error");
    } finally {
      setBusy(false);
    }
  };
  return createPortal(
    <div className="chart-menu" ref={ref} style={{ left: pos.left, top: pos.top, maxHeight: pos.maxHeight }}>
      <label className="chart-search">
        <Search size={13} />
        <input ref={input} className="input" placeholder={`Search ${total} charts — brand, line, collection`} value={q} onChange={(e) => setQ(e.target.value)} />
        {q && (
          <button type="button" className="icon-btn" onClick={() => setQ("")} title="Clear">
            <X size={12} />
          </button>
        )}
      </label>
      <div className="cm-list">
        {none !== undefined && !q && (
          <button type="button" className={`cm-row ${value === "" ? "on" : ""}`} onClick={() => onPick("")}>
            <span className="cm-name">{none}</span>
          </button>
        )}
        {groups.map(([g, cs]) => (
          <div key={g} className="cm-group">
            <div className="cm-head">{g}</div>
            {cs.map((c) => (
              <div key={g + c.id} className={`cm-row ${c.id === value ? "on" : ""}`} role="button" tabIndex={0} title={`${c.name} · ${c.count} colours · ${SOURCE_LABEL[c.source]}`} onClick={() => onPick(c.id)} onKeyDown={(e) => e.key === "Enter" && onPick(c.id)}>
                <span className="cm-name">{c.name}</span>
                <span className="cm-count">{c.count || ""}</span>
                <i className={`src-tag ${c.source}`} title={SOURCE_LABEL[c.source]}>
                  {SOURCE_TAG[c.source]}
                </i>
                {c.source === "custom" && (
                  <button
                    type="button"
                    className="icon-btn cm-del"
                    title="Remove this installed chart"
                    onClick={(e) => {
                      e.stopPropagation();
                      removeInstalledChart(c.id);
                    }}
                  >
                    <Trash2 size={12} />
                  </button>
                )}
              </div>
            ))}
          </div>
        ))}
        {!groups.length && <p className="hint" style={{ padding: "6px 10px" }}>No chart matches “{q}”.</p>}
      </div>
      {more > 0 && (
        <button
          type="button"
          className="cm-more"
          title="Not included with Filum because no licence is stated: download them from their author"
          onClick={() => {
            onClose();
            useStore.getState().openSettings("downloads");
          }}
        >
          <Download size={12} />
          <span>
            {more} more charts from Embroidery Nerds: <b>download in Preferences…</b>
          </span>
        </button>
      )}
      <div className="cm-foot">
        <button type="button" className="btn sm" onClick={install} disabled={busy} title="Add a .gpl thread chart (Ink/Stitch “Install custom palette”); it stays available in this app">
          <Download size={12} /> Install palette (.gpl)…
        </button>
        <span className="stat">IS Ink/Stitch · EN Embroidery Nerds · MD Madeira card</span>
      </div>
    </div>,
    document.body,
  );
}

export const threadTitle = (t: Pick<Thread, "name" | "brand" | "code" | "color">) =>
  [t.name, [t.brand, t.code].filter(Boolean).join(" "), t.color.toUpperCase()].filter(Boolean).join(" · ");

/** A chart, loaded on demand. */
export function useChart(chart: string): ChartEntry[] | null {
  const [entries, setEntries] = useState<ChartEntry[] | null>(null);
  // "My threads" changes while it is shown
  const mine = useMyThreads();
  const version = chart === MY_CHART ? mine : null;
  useEffect(() => {
    let live = true;
    setEntries(null);
    loadChart(chart)
      .then((e) => live && setEntries(e))
      .catch(() => live && setEntries([]));
    return () => {
      live = false;
    };
  }, [chart, version]);
  return entries;
}

/** One colour chip: thread colour, check mark when chosen. */
export function Swatch({ color, on, title, onClick, size = 20, label }: { color: string; on?: boolean; title?: string; onClick?: () => void; size?: number; label?: string }) {
  return (
    <button type="button" className={`swatch-btn ${on ? "on" : ""}`} title={title} style={{ background: color, width: size, height: size, color: inkOn(color) }} onClick={onClick}>
      {on ? <Check size={Math.round(size * 0.6)} strokeWidth={3} /> : label}
    </button>
  );
}

/** Browse a thread chart: nearest matches to `near`, search, the full grid. */
export function ChartBrowser({
  near,
  onPick,
  height = 220,
  chart: controlled,
  onChart,
  markOwned,
}: {
  near?: string;
  onPick: (e: ChartEntry) => void;
  height?: number;
  chart?: string;
  onChart?: (c: string) => void;
  /** Check the spools that are in My threads. */
  markOwned?: boolean;
}) {
  const mineList = useMyThreads();
  const owned = useMemo(() => (markOwned ? new Set(mineList.map(ownedKey)) : null), [markOwned, mineList]);
  const [own, setOwn] = useState(lastChart);
  const chart = controlled ?? own;
  const setChart = (c: string) => {
    setOwn(c);
    onChart?.(c);
  };
  const [q, setQ] = useState("");
  const [hover, setHover] = useState<ChartEntry | null>(null);
  const entries = useChart(chart);
  const shown = useMemo(() => (entries ? searchChart(entries, q) : []), [entries, q]);
  const closest = useMemo(() => (entries && near ? nearest(entries, near, 8) : []), [entries, near]);
  const info = hover ?? null;
  return (
    <div className="chart-browser">
      <div className="chart-head">
        <ChartSelect
          value={chart}
          onChange={(c) => {
            setChart(c);
            setLastChart(c);
          }}
        />
        <label className="chart-search">
          <Search size={13} />
          <input className="input" placeholder="Name, code or #hex" value={q} onChange={(e) => setQ(e.target.value)} />
          {q && (
            <button type="button" className="icon-btn" onClick={() => setQ("")} title="Clear">
              <X size={12} />
            </button>
          )}
        </label>
      </div>
      {closest.length > 0 && !q && (
        <div className="chart-near">
          <span className="chart-cap">Nearest</span>
          {closest.map((e) => (
            <button
              type="button"
              key={e.code + e.name}
              className="chart-near-item"
              title={`${e.name} ${e.code} · ΔE ${e.d.toFixed(1)} (${deltaLabel(e.d)})`}
              onPointerEnter={() => setHover(e)}
              onPointerLeave={() => setHover(null)}
              onClick={() => onPick(e)}
            >
              <i style={{ background: e.color }} />
              <span>{e.d.toFixed(1)}</span>
            </button>
          ))}
        </div>
      )}
      <div className="chart-grid" style={{ maxHeight: height }}>
        {!entries && <span className="hint">Loading chart…</span>}
        {entries && !shown.length && <span className="hint">No match.</span>}
        {shown.map((e) => (
          <button
            type="button"
            key={e.code + e.name + e.color}
            style={{ background: e.color, color: inkOn(e.color) }}
            className={owned?.has(ownedKey(e)) ? "owned" : undefined}
            title={`${e.name} · ${e.code}${owned?.has(ownedKey(e)) ? " · in My threads" : ""}`}
            onPointerEnter={() => setHover(e)}
            onPointerLeave={() => setHover(null)}
            onClick={() => onPick(e)}
          />
        ))}
      </div>
      <div className="chart-info">
        {info ? (
          <>
            <i style={{ background: info.color }} />
            <b>{info.name}</b>
            <span className="stat">
              {info.brand} {info.code} · {info.color.toUpperCase()}
            </span>
          </>
        ) : (
          <span className="stat">{entries ? `${shown.length} of ${entries.length} colours` : ""}</span>
        )}
      </div>
    </div>
  );
}

/** Popover: chart, custom colour, recent. `onPick` gets a design thread id. */
function ThreadPopover({ anchor, current, onPick, onClose }: { anchor: HTMLElement; current?: string; onPick: (id: string) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: 0, top: 0 });
  const [custom, setCustom] = useState(current ?? "#3366cc");
  const [hexText, setHexText] = useState((current ?? "#3366cc").toUpperCase());
  const recent = useMemo(recentThreads, []);
  const mv = useMovable();
  useLayoutEffect(() => {
    const r = anchor.getBoundingClientRect();
    const w = 320;
    const h = ref.current?.offsetHeight ?? 420;
    const left = Math.max(8, Math.min(window.innerWidth - w - 8, r.left - w / 2 + r.width / 2));
    const below = r.bottom + 6;
    const top = below + h > window.innerHeight - 8 ? Math.max(8, r.top - h - 6) : below;
    setPos({ left, top });
  }, [anchor]);
  useEffect(() => {
    const down = (e: PointerEvent) => {
      if ((e.target as Element).closest?.(".chart-menu")) return;
      if (!ref.current?.contains(e.target as Node) && !anchor.contains(e.target as Node)) onClose();
    };
    // Esc closes only the popover (not the selection or the tool behind it)
    const key = (e: KeyboardEvent) => e.key === "Escape" && (e.stopPropagation(), onClose());
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("keydown", key, true);
    };
  }, [anchor, onClose]);
  const pick = (t: RecentThread) => {
    onPick(threadFor(t));
    onClose();
  };
  return createPortal(
    <div className="thread-pop" ref={ref} style={{ ...pos, transform: mv.moved ? `translate(${mv.off[0]}px, ${mv.off[1]}px)` : undefined }} data-movable>
      <Grip grip={mv.grip} label="Thread" />
      <ChartBrowser near={custom} onPick={(e) => pick({ name: e.name, color: e.color, brand: e.brand, code: e.code })} height={170} />
      <div className="pop-sec">
        <span className="chart-cap">Custom</span>
        <input
          type="color"
          className="color-big"
          value={custom}
          onChange={(e) => {
            setCustom(e.target.value);
            setHexText(e.target.value.toUpperCase());
          }}
        />
        <input
          className="input mono"
          value={hexText}
          spellCheck={false}
          onChange={(e) => {
            setHexText(e.target.value);
            const h = normHex(e.target.value);
            if (h) setCustom(h);
          }}
          style={{ width: 84 }}
        />
        <button type="button" className="btn sm primary" onClick={() => pick({ name: custom.toUpperCase(), color: custom, brand: "", code: "" })}>
          Use colour
        </button>
      </div>
      {recent.length > 0 && (
        <div className="pop-sec">
          <span className="chart-cap">Recent</span>
          <div className="swatch-row">
            {recent.map((t, i) => (
              <Swatch key={i} color={t.color} size={18} title={threadTitle(t)} onClick={() => pick(t)} />
            ))}
          </div>
        </div>
      )}
    </div>,
    document.body,
  );
}

/**
 * The design's threads as swatches plus "+" for any other thread.
 * `value`: the chosen thread id; `onPick`: a design thread id.
 */
export function ThreadPicker({ value, onPick, disabled, mixed }: { value?: string; onPick: (id: string) => void; disabled?: boolean; mixed?: boolean }) {
  const threads = useStore((s) => s.doc.threads);
  const [open, setOpen] = useState(false);
  const plus = useRef<HTMLButtonElement>(null);
  const cur = threads.find((t) => t.id === value);
  return (
    <div className={`thread-picker ${disabled ? "disabled" : ""}`}>
      {threads.map((t) => (
        <Swatch key={t.id} color={t.color} on={t.id === value && !mixed} title={threadTitle(t)} onClick={disabled ? undefined : () => onPick(t.id)} />
      ))}
      <button type="button" ref={plus} className={`swatch-add ${open ? "on" : ""}`} title="More colours: thread charts, custom, recent" disabled={disabled} onClick={() => setOpen((v) => !v)}>
        <Plus size={13} />
      </button>
      {open && plus.current && <ThreadPopover anchor={plus.current} current={cur?.color} onPick={onPick} onClose={() => setOpen(false)} />}
    </div>
  );
}

/** The current thread: colour, name, chart code, usage; open the manager. */
export function ThreadCard({ threadId }: { threadId: string }) {
  const doc = useStore((s) => s.doc);
  const plan = useStore((s) => s.plan);
  const focus = useStore((s) => s.colorFocus && s.activeThread === threadId);
  const t = doc.threads.find((x) => x.id === threadId);
  const u = useMemo(() => threadUsage(doc, plan).get(threadId), [doc, plan, threadId]);
  if (!t) return null;
  return (
    <div className="thread-card">
      <span className="tc-swatch" style={{ background: t.color }} />
      <div className="tc-text">
        <b>{t.name}</b>
        <span className="stat">
          {[t.brand, t.code].filter(Boolean).join(" ") || "custom colour"} · {t.color.toUpperCase()}
        </span>
        {u && u.stitches > 0 && (
          <span className="stat">
            {u.stitches.toLocaleString()} st · {u.metres.toFixed(1)} m · sewn {u.blocks.length === 1 ? `as colour ${u.blocks[0]}` : `in blocks ${u.blocks.join(", ")}`}
          </span>
        )}
      </div>
      <button
        type="button"
        className={`icon-btn ${focus ? "on" : ""}`}
        title="Show only this colour (dim the others)"
        onClick={() => {
          const s = useStore.getState();
          s.set(focus ? { colorFocus: false } : { colorFocus: true, activeThread: threadId });
        }}
      >
        <Focus size={14} />
      </button>
      <button type="button" className="icon-btn" title="Thread colours…" onClick={() => useStore.getState().setDialog("threads")}>
        <SlidersHorizontal size={14} />
      </button>
    </div>
  );
}
