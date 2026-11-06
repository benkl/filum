// Thread manager: the colour sequence (sew order), the design's threads with
// usage and chart matching, a thread chart browser, and bulk tools (match to
// chart, merge similar, remove unused, sort, import / export palettes).

import { ArrowDownUp, Check, ChevronDown, ChevronUp, Copy, Crosshair, Download, Link2, ListPlus, Lock, RotateCcw, Search, Trash2, Undo2, Unlock, Upload, Replace, X } from "lucide-react";
import { SewOrder, Spool } from "../icons/stitch";
import { THREAD_WEIGHTS } from "../lib/materials";
import { MatchButton, useMatchOptions } from "./MatchPanel";
import { quality as qualityOf, type MatchCandidate } from "../lib/threadMatch";
import { useEffect, useMemo, useRef, useState } from "react";
import { optimizeOrder } from "../lib/actions";
import {
  assignChart,
  chartLabel,
  colorSequence,
  deleteThread,
  deltaE,
  lab,
  deltaLabel,
  duplicateThread,
  exportPalette,
  importPalette,
  inkOn,
  mergeSimilarColours,
  mergeTolerance,
  setMergeTolerance,
  mergeThreads,
  moveThread,
  nearest,
  normHex,
  removeUnused,
  sortBySewOrder,
  threadUsage,
  updateThread,
  addDesignThreadsToMine,
  clearMyThreads,
  exportMyThreads,
  fitSequence,
  fitTargetId,
  fitThreads,
  myLines,
  needOf,
  parseFitTarget,
  revertFit,
  isLocked,
  threadCandidates,
  toggleLock,
  spoolKey,
  importMyThreads,
  MY_CHART,
  ownedKey,
  removeMyThread,
  toggleMyThread,
  useMyThreads,
  type ChartEntry,
  type FitReport,
  type FitTarget,
} from "../lib/threads";
import { useStore } from "../store";
import type { Thread, ThreadSource } from "../types";
import { ChartBrowser, lastChart, setLastChart, threadTitle, useChart } from "./ThreadPicker";
import { Dialog, Num } from "./ui";
import { safeSetItem } from "../lib/storage";

const fmtK = (n: number) => (n >= 10000 ? `${(n / 1000).toFixed(1)}k` : n.toLocaleString());

/**
 * The sew order: one block per colour change (width ∝ stitches), the spool
 * sewn on top and, underneath, the original colours (needs) it carries —
 * several needs in one block are threads fitted or merged onto one spool.
 */
export function FitStrip({ onPick, active }: { onPick?: (threadId: string) => void; active?: string | null }) {
  const doc = useStore((s) => s.doc);
  const plan = useStore((s) => s.plan);
  const blocks = useMemo(() => fitSequence(doc, plan), [doc, plan]);
  const total = blocks.reduce((a, b) => a + b.stitches, 0) || 1;
  const fitted = Object.keys(doc.threadSources ?? {}).length > 0;
  const showNeeds = fitted || blocks.some((b) => b.needs.length > 1);
  if (!blocks.length) return <div className="seq-strip empty">No stitches yet</div>;
  return (
    <div className={`fit-strip ${showNeeds ? "two" : ""}`}>
      {showNeeds && (
        <div className="fs-labels">
          <span>Sewn</span>
          <span>Needs</span>
        </div>
      )}
      <div className="fs-blocks">
        {blocks.map((b) => {
          const on = !!active && (b.threadId === active || b.needs.some((n) => n.threadId === active));
          return (
            <div key={b.index} className={`fs-block ${on ? "on" : ""}`} style={{ flexGrow: Math.max(0.6, (b.stitches / total) * blocks.length) }}>
              <button
                type="button"
                className="fs-spool"
                style={{ background: b.thread.color, color: inkOn(b.thread.color) }}
                title={`${b.index + 1}. ${threadTitle(b.thread)}\n${b.stitches.toLocaleString()} stitches · ${b.metres.toFixed(1)} m${b.needs.length > 1 ? `\n${b.needs.length} threads on this spool` : ""}`}
                onClick={() => b.threadId && onPick?.(b.threadId)}
              >
                {b.index + 1}
                {b.needs.length > 1 && (
                  <i className="fs-merged">
                    <Link2 size={10} />
                    {b.needs.length}
                  </i>
                )}
              </button>
              {showNeeds && (
                <span className="fs-needs">
                  {b.needs.map((n, i) => (
                    <button
                      type="button"
                      key={i}
                      className={`${n.threadId === active ? "on" : ""} ${n.d > 6 ? "far" : ""}`}
                      style={{ flexGrow: n.stitches, background: n.need.color }}
                      title={`Needs ${[n.need.name, n.need.brand, n.need.code].filter(Boolean).join(" ")} ${n.need.color.toUpperCase()}\nSewn with ${threadTitle(b.thread)} · ΔE ${n.d.toFixed(1)} (${deltaLabel(n.d)})`}
                      onClick={() => onPick?.(n.threadId)}
                    />
                  ))}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ThreadRow({
  t,
  index,
  count,
  selected,
  usage,
  match,
  others,
  onSelect,
  matchLabel = "chart",
  need,
  shared,
  locked,
}: {
  locked?: boolean;
  matchLabel?: string;
  /** The original colour, when the thread is fitted. */
  need?: ThreadSource;
  /** Other threads on the same spool. */
  shared?: number;
  t: Thread;
  index: number;
  count: number;
  selected: boolean;
  usage: { objects: number; stitches: number; metres: number; blocks: number[] };
  match: (ChartEntry & { d: number }) | null;
  others: Thread[];
  onSelect: () => void;
}) {
  const colorRef = useRef<HTMLInputElement>(null);
  const [hex, setHex] = useState(t.color.toUpperCase());
  useEffect(() => setHex(t.color.toUpperCase()), [t.color]);
  const used = usage.objects > 0;
  const exact = match && match.d < 0.5 && (t.code === match.code || !t.code);
  return (
    <div className={`tm-row ${selected ? "on" : ""}`} onClick={onSelect}>
      <button
        type="button"
        className="tm-swatch"
        style={{ background: t.color, color: inkOn(t.color) }}
        title="Edit colour"
        onClick={(e) => {
          e.stopPropagation();
          onSelect();
          useStore.getState().checkpoint();
          colorRef.current?.click();
        }}
      >
        {usage.blocks.length ? usage.blocks.slice(0, 3).join(" ") : ""}
        <input ref={colorRef} type="color" value={t.color} onChange={(e) => updateThread(t.id, { color: e.target.value }, true)} tabIndex={-1} />
      </button>
      <div className="tm-main">
        <input className="input tm-name" defaultValue={t.name} key={t.name} onBlur={(e) => e.target.value !== t.name && updateThread(t.id, { name: e.target.value })} />
        <div className="tm-meta">
          <input
            className="input mono tm-hex"
            value={hex}
            spellCheck={false}
            onChange={(e) => setHex(e.target.value)}
            onBlur={() => {
              const h = normHex(hex);
              if (h && h !== t.color) updateThread(t.id, { color: h });
              else setHex(t.color.toUpperCase());
            }}
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          />
          <input className="input tm-brand" placeholder="Brand" defaultValue={t.brand} key={`b${t.brand}`} onBlur={(e) => e.target.value !== t.brand && updateThread(t.id, { brand: e.target.value })} />
          <input className="input tm-code" placeholder="Code" defaultValue={t.code} key={`c${t.code}`} onBlur={(e) => e.target.value !== t.code && updateThread(t.id, { code: e.target.value })} />
          <select
            className="input tm-weight"
            value={t.weight ?? ""}
            title="Thread weight — a heavier or finer thread than the design's gets its own spacing and counts by its thickness in the density map"
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => updateThread(t.id, { weight: e.target.value ? Number(e.target.value) : undefined })}
          >
            <option value="">wt</option>
            {THREAD_WEIGHTS.map((w) => (
              <option key={w.weight} value={w.weight}>
                {w.weight}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="tm-usage">
        {used ? (
          <>
            <b>{fmtK(usage.stitches)}</b> st · {usage.metres.toFixed(1)} m
            <span className="stat">
              {usage.objects} object{usage.objects === 1 ? "" : "s"}
            </span>
          </>
        ) : (
          <span className="stat">unused</span>
        )}
      </div>
      <div className="tm-match">
        {need ? (
          <span className="tm-fit" title={`Originally ${[need.name, need.brand, need.code].filter(Boolean).join(" ")} ${need.color.toUpperCase()}`}>
            <i style={{ background: need.color }} />
            <span className="stat">→</span>
            <b className={`q-${qualityOf(deltaE(lab(need.color), lab(t.color)))}`} title={`${qualityOf(deltaE(lab(need.color), lab(t.color)))} match`}>
              ΔE {deltaE(lab(need.color), lab(t.color)).toFixed(1)}
            </b>
            {!!shared && (
              <span className="badge" title={`${shared} more thread${shared === 1 ? "" : "s"} on this spool — sewn as one colour`}>
                <Link2 size={10} /> {shared + 1}
              </span>
            )}
            <button
              type="button"
              className="icon-btn"
              title="Back to the original colour"
              onClick={(e) => {
                e.stopPropagation();
                revertFit([t.id]);
              }}
            >
              <Undo2 size={12} />
            </button>
          </span>
        ) : (
          match &&
          (exact ? (
            <span className="badge ok" title={`${match.brand} ${match.code}`}>
              {matchLabel} ✓
            </span>
          ) : (
            <button
              type="button"
              className="tm-snap"
              title={`Snap to ${match.brand} ${match.code} ${match.name} (ΔE ${match.d.toFixed(1)}, ${deltaLabel(match.d)})`}
              onClick={(e) => {
                e.stopPropagation();
                assignChart(t.id, match);
              }}
            >
              <i style={{ background: match.color }} />
              {match.code} <span className="stat">ΔE {match.d.toFixed(1)}</span>
            </button>
          ))
        )}
      </div>
      <div className="tm-actions" onClick={(e) => e.stopPropagation()}>
        <button type="button" className={`icon-btn ${locked ? "on" : ""}`} title={locked ? "Locked: fitting keeps this spool — click to unlock" : "Lock: fitting keeps this spool"} onClick={() => toggleLock(t.id)}>
          {locked ? <Lock size={13} /> : <Unlock size={13} />}
        </button>
        <button
          type="button"
          className="icon-btn"
          title="Select its objects"
          disabled={!used}
          onClick={() => {
            const s = useStore.getState();
            s.select(s.doc.objects.filter((o) => o.thread === t.id).map((o) => o.id));
            s.set({ activeThread: t.id });
          }}
        >
          <Crosshair size={14} />
        </button>
        <button type="button" className="icon-btn" title="Move up" disabled={index === 0} onClick={() => moveThread(t.id, -1)}>
          <ChevronUp size={14} />
        </button>
        <button type="button" className="icon-btn" title="Move down" disabled={index === count - 1} onClick={() => moveThread(t.id, 1)}>
          <ChevronDown size={14} />
        </button>
        <button type="button" className="icon-btn" title="Duplicate" onClick={() => duplicateThread(t.id)}>
          <Copy size={14} />
        </button>
        <select
          className="select tm-merge"
          value=""
          title="Merge into another thread: its objects take that thread"
          disabled={!others.length}
          onChange={(e) => e.target.value && mergeThreads([t.id], e.target.value)}
        >
          <option value="">Merge…</option>
          {others.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </select>
        <button type="button" className="icon-btn" title={used ? "In use: merge it into another thread instead" : "Delete"} disabled={used} onClick={() => deleteThread(t.id)}>
          <Trash2 size={14} />
        </button>
      </div>
    </div>
  );
}

/**
 * My threads: the spools the user owns. Add them from any chart (click to
 * own / un-own), import or export a palette, then fit the design to them.
 */
function MyThreadsPanel({ selected }: { selected: Thread | null }) {
  const mine = useMyThreads();
  const doc = useStore((s) => s.doc);
  const toast = useStore.getState().toast;
  const [mode, setMode] = useState<"collection" | "add">(() => (mine.length ? "collection" : "add"));
  const [q, setQ] = useState("");
  const entries = useChart(MY_CHART);
  const inDesign = useMemo(() => new Set(doc.threads.map(ownedKey)), [doc.threads]);
  const closest = useMemo(() => (entries && selected ? nearest(entries, selected.color, 4) : []), [entries, selected]);
  const groups = useMemo(() => {
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const hit = (t: (typeof mine)[number]) => words.every((w) => `${t.brand} ${t.name} ${t.code} ${t.color}`.toLowerCase().includes(w));
    const by = new Map<string, typeof mine>();
    for (const t of mine.filter(hit)) by.set(t.brand || "Other", [...(by.get(t.brand || "Other") ?? []), t]);
    return [...by].sort((a, b) => a[0].localeCompare(b[0]));
  }, [mine, q]);
  return (
    <div className="mine">
      <div className="mine-head">
        <div className="seg">
          <button className={mode === "collection" ? "on" : ""} onClick={() => setMode("collection")}>
            My collection · {mine.length}
          </button>
          <button className={mode === "add" ? "on" : ""} onClick={() => setMode("add")}>
            <ListPlus size={13} /> Add from charts
          </button>
        </div>
        <div className="spacer" />
        <button
          className="icon-btn"
          title="Add the design's threads to My threads"
          disabled={!doc.threads.length}
          onClick={() => {
            const n = addDesignThreadsToMine();
            toast(n ? `Added ${n} thread${n === 1 ? "" : "s"} to My threads` : "They are all in My threads already");
          }}
        >
          <Spool size={14} />
        </button>
        <button className="icon-btn" title="Import spools from a .gpl palette" onClick={async () => toast(`Added ${await importMyThreads()} spools`)}>
          <Upload size={14} />
        </button>
        <button className="icon-btn" title="Export My threads as a .gpl palette" disabled={!mine.length} onClick={() => exportMyThreads()}>
          <Download size={14} />
        </button>
        <button className="icon-btn" title="Remove every spool from My threads" disabled={!mine.length} onClick={() => window.confirm(`Remove all ${mine.length} spools from My threads?`) && clearMyThreads()}>
          <Trash2 size={14} />
        </button>
      </div>

      {mode === "add" ? (
        <>
          <p className="hint">Click the colours you own — they get a check mark; click again to take them out. Search by code or name.</p>
          <ChartBrowser markOwned near={selected?.color} height={290} onPick={(e) => toggleMyThread({ name: e.name, code: e.code, brand: e.brand, color: e.color })} />
        </>
      ) : !mine.length ? (
        <div className="mine-empty">
          <b>No spools yet</b>
          <span>Add the threads you own, then fit any design to them.</span>
          <div className="dz-inline">
            <button className="btn sm primary" onClick={() => setMode("add")}>
              <ListPlus size={13} /> Add from charts
            </button>
            <button className="btn sm" disabled={!doc.threads.length} onClick={() => addDesignThreadsToMine()}>
              Add the design's threads
            </button>
            <button className="btn sm" onClick={() => importMyThreads()}>
              Import .gpl
            </button>
          </div>
        </div>
      ) : (
        <>
          {selected && closest.length > 0 && (
            <div className="chart-near">
              <span className="chart-cap">Closest for {selected.name}</span>
              {closest.map((e) => (
                <button key={ownedKey(e)} type="button" className="chart-near-item" title={`${e.brand} ${e.code} ${e.name} · ΔE ${e.d.toFixed(1)} (${deltaLabel(e.d)})`} onClick={() => assignChart(selected.id, e)}>
                  <i style={{ background: e.color }} />
                  <span>{e.d.toFixed(1)}</span>
                </button>
              ))}
            </div>
          )}
          <label className="chart-search">
            <Search size={13} />
            <input className="input" placeholder={`Search ${mine.length} spools`} value={q} onChange={(e) => setQ(e.target.value)} />
          </label>
          <div className="mine-list">
            {groups.map(([brand, list]) => (
              <div key={brand}>
                <div className="cm-head">
                  {brand} · {list.length}
                </div>
                {list.map((t) => (
                  <div
                    key={ownedKey(t)}
                    className="mine-row"
                    role="button"
                    tabIndex={0}
                    title={selected ? `Give ${selected.name} this spool` : "Select a design thread to give it this spool"}
                    onClick={() => (selected ? assignChart(selected.id, { ...t, lab: [0, 0, 0] }) : toast("Select a thread first"))}
                  >
                    <i style={{ background: t.color }} />
                    <span className="mr-name">{t.name}</span>
                    <span className="stat mono">{t.code}</span>
                    {inDesign.has(ownedKey(t)) && <span className="badge ok">in design</span>}
                    <button
                      className="icon-btn"
                      title="Remove from My threads"
                      onClick={(e) => {
                        e.stopPropagation();
                        removeMyThread(t);
                      }}
                    >
                      <X size={12} />
                    </button>
                  </div>
                ))}
              </div>
            ))}
            {!groups.length && <p className="hint">No spool matches “{q}”.</p>}
          </div>
        </>
      )}
    </div>
  );
}

/** The best spools of the fit target for the selected thread, with what changes. */
function CandidateStrip({ target, thread, matchKey }: { target: FitTarget; thread: Thread; matchKey: string }) {
  const doc = useStore((s) => s.doc);
  const [cands, setCands] = useState<MatchCandidate[] | null>(null);
  const need = needOf(doc, thread);
  useEffect(() => {
    let live = true;
    threadCandidates(target, thread.id, 5).then((c) => live && setCands(c));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitTargetId(target), thread.id, need.color, matchKey]);
  if (!cands?.length) return null;
  const sign = (v: number, unit: string) => `${v > 0 ? "+" : ""}${v.toFixed(0)}${unit}`;
  return (
    <div className="tm-cands">
      <span className="tm-cands-need" title={`${need.name} ${need.color.toUpperCase()} — the colour wanted`}>
        <i style={{ background: need.color }} />
        <b>{need.name}</b>
      </span>
      {cands.map((c) => {
        const on = spoolKey(c.entry) === spoolKey(thread);
        return (
          <button
            key={spoolKey(c.entry)}
            className={`tm-cand ${on ? "on" : ""}`}
            title={`${[c.entry.brand, c.entry.code, c.entry.name].filter(Boolean).join(" ")}\nΔE ${c.d.toFixed(1)} (${qualityOf(c.d)}) · hue ${sign(c.hue, "°")} · saturation ${sign(c.chroma * 100, "%")} · lightness ${sign(c.lightness, "")}`}
            onClick={() => assignChart(thread.id, c.entry)}
          >
            <i style={{ background: c.entry.color }} />
            <span className="tc-code">{c.entry.code || c.entry.name}</span>
            <b className={`q-${qualityOf(c.d)}`}>{c.d.toFixed(1)}</b>
            <span className="stat">
              {Math.abs(c.hue) >= 3 ? sign(c.hue, "°") : ""} {Math.abs(c.chroma) >= 0.05 ? sign(c.chroma * 100, "%") : ""}
            </span>
          </button>
        );
      })}
    </div>
  );
}

export function ThreadManager({ onClose }: { onClose: () => void }) {
  const doc = useStore((s) => s.doc);
  const plan = useStore((s) => s.plan);
  const activeThread = useStore((s) => s.activeThread);
  const [sel, setSel] = useState<string | null>(activeThread ?? doc.threads[0]?.id ?? null);
  const [chart, setChart] = useState(lastChart);
  const [similar, setSimilarState] = useState(mergeTolerance);
  const setSimilar = (v: number) => {
    setSimilarState(v);
    setMergeTolerance(v);
  };
  const [side, setSide] = useState<"charts" | "mine">(() => (localStorage.getItem("filum.tm.side") === "mine" ? "mine" : "charts"));
  const pickSide = (v: "charts" | "mine") => {
    setSide(v);
    safeSetItem("filum.tm.side", v);
  };
  const mineCount = useMyThreads().length;
  const chartEntries = useChart(chart);
  const mineEntries = useChart(MY_CHART);
  const entries = side === "mine" ? mineEntries : chartEntries;
  const usage = useMemo(() => threadUsage(doc, plan), [doc, plan]);
  const seq = colorSequence(doc, plan);
  const changes = Math.max(0, seq.length - 1);
  const metres = seq.reduce((a, b) => a + b.metres, 0);
  const selected = doc.threads.find((t) => t.id === sel) ?? null;
  const toast = useStore.getState().toast;
  const matches = useMemo(() => new Map(entries ? doc.threads.map((t) => [t.id, nearest(entries, t.color, 1)[0] ?? null]) : []), [entries, doc.threads]);
  // fitting
  const mine = useMyThreads();
  const lines = useMemo(() => myLines(mine), [mine]);
  const [target, setTargetState] = useState<string>(() => localStorage.getItem("filum.tm.fit") ?? "mine");
  const setTarget = (v: string) => {
    setTargetState(v);
    safeSetItem("filum.tm.fit", v);
  };
  const fitTarget: FitTarget = parseFitTarget(target).kind === "chart" ? { kind: "chart", chart } : parseFitTarget(target);
  const [report, setReport] = useState<FitReport | null>(null);
  const [match, setMatch] = useMatchOptions();
  const sources = doc.threadSources ?? {};
  const fittedIds = doc.threads.filter((t) => sources[t.id]).map((t) => t.id);
  const quality = useMemo(() => {
    const ds = doc.threads.filter((t) => sources[t.id]).map((t) => deltaE(lab(sources[t.id].color), lab(t.color)));
    return ds.length ? { mean: ds.reduce((a, b) => a + b, 0) / ds.length, worst: Math.max(...ds) } : null;
  }, [doc.threads, sources]);
  const spoolCount = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of doc.threads) m.set(spoolKey(t), (m.get(spoolKey(t)) ?? 0) + 1);
    return m;
  }, [doc.threads]);
  const runFit = async (only?: string[]) => {
    const r = await fitThreads(fitTarget, { only, match });
    if (!r) return toast(fitTarget.kind === "mine" ? "No spools in My threads for this choice — add some first" : "The chart is empty", "info");
    setReport(r);
    toast(`Fitted ${r.fitted} thread${r.fitted === 1 ? "" : "s"} to ${r.target}${r.shared ? ` · ${r.shared} sharing a spool` : ""}`, "success");
  };
  return (
    <Dialog
      live
      title="Thread colours"
      onClose={onClose}
      xwide
      footer={
        <>
          <span className="tm-similar" title="Merge threads whose colours differ by less than this ΔE (CIEDE2000; 2–3 is barely visible)">
            <button
              className="btn"
              onClick={mergeSimilarColours}
            >
              Merge similar
            </button>
            <span className="stat">ΔE &lt;</span>
            <Num value={similar} min={1} max={30} step={1} digits={0} onChange={setSimilar} />
          </span>
          <button
            className="btn"
            onClick={() => {
              const n = removeUnused();
              toast(n ? `Removed ${n} unused thread${n === 1 ? "" : "s"}` : "Every thread is in use");
            }}
          >
            Remove unused
          </button>
          <div className="spacer" />
          <button className="icon-btn" title="Import a .gpl palette as threads" onClick={async () => toast(`Added ${await importPalette()} threads`)}>
            <Upload size={15} />
          </button>
          <button className="icon-btn" title="Export the threads as a .gpl palette" onClick={() => exportPalette()}>
            <Download size={15} />
          </button>
          <button className="btn primary" onClick={onClose}>
            Done
          </button>
        </>
      }
    >
      <div className="tm-top">
        <div className="tm-stats">
          <span>
            <b>{doc.threads.length}</b> threads
          </span>
          <span>
            <b>{seq.length}</b> colour blocks
          </span>
          <span>
            <b>{changes}</b> colour change{changes === 1 ? "" : "s"}
          </span>
          <span>
            <b>{metres.toFixed(1)}</b> m top thread
          </span>
          {fittedIds.length > 0 && (
            <span className="fitted">
              <b>{fittedIds.length}</b> fitted
            </span>
          )}
        </div>
        <button className="btn sm" title="Reorder objects to minimise colour changes and jumps (keeps stacking)" onClick={optimizeOrder}>
          <SewOrder size={13} /> Optimise stitch order
        </button>
        <button className="btn sm ghost" title="List threads in the order they are sewn" onClick={sortBySewOrder}>
          <ArrowDownUp size={13} /> Sort by sew order
        </button>
      </div>
      <FitStrip active={sel} onPick={setSel} />
      <div className="tm-fitbar">
        <span className="tm-fit-label">Fit threads to</span>
        <select className="select" value={target} onChange={(e) => setTarget(e.target.value)} title="Fit to all your spools, one brand or one product line of My threads, or the chart chosen on the right">
          <optgroup label="My threads">
            <option value="mine">All my threads ({mine.length})</option>
            {lines.map((b) => [
              <option key={b.brand} value={fitTargetId({ kind: "mine", brand: b.brand })}>
                {b.brand} ({b.count})
              </option>,
              ...(b.lines.length > 1 || b.lines[0]?.line !== b.brand
                ? b.lines.map((l) => (
                    <option key={l.line} value={fitTargetId({ kind: "mine", line: l.line })}>
                      {"\u00a0\u00a0\u00a0"}
                      {l.line} ({l.count})
                    </option>
                  ))
                : []),
            ])}
          </optgroup>
          <optgroup label="Chart">
            <option value="chart:">{chartLabel(chart)} (chart on the right)</option>
          </optgroup>
        </select>
        <MatchButton target={fitTarget} opts={match} set={setMatch} />
        <button className="btn sm primary" disabled={!doc.threads.length} onClick={() => runFit()} title="Fit every unlocked thread with the matching options, starting from its original colour">
          <Replace size={13} /> Fit all
        </button>
        <button className="btn sm" disabled={!selected} onClick={() => selected && runFit([selected.id])} title="Fit only the selected thread">
          Fit selected
        </button>
        <div className="spacer" />
        {quality && (
          <span className="tm-quality" title="Colour difference between the original colours and the spools (CIEDE2000)">
            ΔE avg <b>{quality.mean.toFixed(1)}</b> · worst <b className={quality.worst > 6 ? "far" : ""}>{quality.worst.toFixed(1)}</b>
          </span>
        )}
        <button className="btn sm ghost" disabled={!fittedIds.length} onClick={() => (revertFit(), setReport(null))} title="All threads back to their original colours (also undoes merges)">
          <RotateCcw size={13} /> Revert all{fittedIds.length ? ` (${fittedIds.length})` : ""}
        </button>
      </div>
      {report && (
        <div className={`tm-report ${report.far.length ? "warn" : ""}`}>
          <button className="icon-btn" title="Close" onClick={() => setReport(null)}>
            <X size={12} />
          </button>
          <span>
            <Check size={12} /> {report.fitted} fitted to {report.target} · ΔE avg {report.mean.toFixed(1)}
            {report.shared ? ` · ${report.shared} sharing a spool (sewn as one colour)` : ""}
          </span>
          {report.merged.length > 0 && (
            <span className="tm-far">
              Merged colours:{" "}
              {report.merged.map((m, i) => (
                <span key={i}>
                  {m.a} + {m.b} <b>ΔE {m.d.toFixed(1)}</b>
                </span>
              ))}
              <span className="stat">— use “Distinct” or lock one to keep them apart</span>
            </span>
          )}
          {report.far.length > 0 && (
            <span className="tm-far">
              No close spool (ΔE &gt; 6):{" "}
              {report.far.map((f, i) => (
                <span key={i}>
                  {f.name} → {f.spool} <b>{f.d.toFixed(1)}</b>
                </span>
              ))}
            </span>
          )}
        </div>
      )}
      {selected && <CandidateStrip target={fitTarget} thread={selected} matchKey={JSON.stringify(match)} />}
      <div className="tm-body">
        <div className="tm-list">
          {doc.threads.map((t, i) => (
            <ThreadRow
              key={t.id}
              t={t}
              index={i}
              count={doc.threads.length}
              selected={t.id === sel}
              usage={usage.get(t.id) ?? { objects: 0, stitches: 0, metres: 0, blocks: [] }}
              match={matches.get(t.id) ?? null}
              others={doc.threads.filter((x) => x.id !== t.id)}
              onSelect={() => setSel(t.id)}
              matchLabel={side === "mine" ? "owned" : "chart"}
              need={sources[t.id] ? needOf(doc, t) : undefined}
              locked={isLocked(doc, t.id)}
              shared={(spoolCount.get(spoolKey(t)) ?? 1) - 1}
            />
          ))}
          {!doc.threads.length && <p className="hint">No threads yet — pick colours from the chart.</p>}
        </div>
        <div className="tm-chart">
          <div className="seg seg-full tm-side">
            <button className={side === "charts" ? "on" : ""} onClick={() => pickSide("charts")}>
              Thread charts
            </button>
            <button className={side === "mine" ? "on" : ""} onClick={() => pickSide("mine")}>
              My threads{mineCount ? ` · ${mineCount}` : ""}
            </button>
          </div>
          {side === "mine" ? (
            <MyThreadsPanel selected={selected} />
          ) : (
            <>
          <div className="tm-chart-head">
            {selected ? (
              <>
                <span className="tm-cur" style={{ background: selected.color }} />
                <span>
                  Replace <b>{selected.name}</b> with a chart colour
                </span>
              </>
            ) : (
              <span className="stat">Select a thread to recolour it</span>
            )}
          </div>
          <ChartBrowser
            chart={chart}
            onChart={(c) => {
              setChart(c);
              setLastChart(c);
            }}
            near={selected?.color}
            height={300}
            markOwned
            onPick={(e) => {
              if (selected) assignChart(selected.id, e);
              else toast("Select a thread first");
            }}
          />
          <p className="hint">Checked colours are in My threads. Matching uses CIEDE2000 (ΔE &lt; 1 is invisible, &lt; 3 barely visible in thread).</p>
            </>
          )}
        </div>
      </div>
    </Dialog>
  );
}
