// How threads are matched to spools when fitting: presets and every option of
// lib/threadMatch.ts, with a live preview of the result (nothing changes
// until "Fit all").

import { ChevronDown, SlidersHorizontal } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { fitTargetId, loadMatchOptions, myLines, previewFit, saveMatchOptions, useMyThreads, type FitTarget } from "../lib/threads";
import { MATCH_PRESETS, type MatchOptions } from "../lib/threadMatch";
import { useStore } from "../store";
import { Grip, Num, Row, Slider, Toggle, useMovable } from "./ui";

/** The match options, shared by the panel and the fit (localStorage). */
export function useMatchOptions(): [MatchOptions, (p: Partial<MatchOptions>, preset?: MatchOptions["preset"]) => void] {
  const [o, setO] = useState(loadMatchOptions);
  const set = (p: Partial<MatchOptions>, preset: MatchOptions["preset"] = "custom") => {
    setO((cur) => {
      const next = { ...cur, ...p, weights: { ...cur.weights, ...(p.weights ?? {}) }, preset };
      saveMatchOptions(next);
      return next;
    });
  };
  return [o, set];
}

const presetLabel = (id: MatchOptions["preset"]) => MATCH_PRESETS.find((p) => p.id === id)?.label ?? "Custom";

export function MatchButton({ target, opts, set }: { target: FitTarget; opts: MatchOptions; set: (p: Partial<MatchOptions>, preset?: MatchOptions["preset"]) => void }) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={btn} className={`btn sm ${open ? "on" : ""}`} onClick={() => setOpen((v) => !v)} title="How threads are matched to spools">
        <SlidersHorizontal size={13} /> {presetLabel(opts.preset)}
        <ChevronDown size={12} />
      </button>
      {open && btn.current && <MatchPanel anchor={btn.current} target={target} opts={opts} set={set} onClose={() => setOpen(false)} />}
    </>
  );
}

function MatchPanel({ anchor, target, opts, set, onClose }: { anchor: HTMLElement; target: FitTarget; opts: MatchOptions; set: (p: Partial<MatchOptions>, preset?: MatchOptions["preset"]) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: 0, top: 0 });
  const doc = useStore((s) => s.doc);
  const mine = useMyThreads();
  const brands = myLines(mine).map((b) => b.brand);
  const [preview, setPreview] = useState<Awaited<ReturnType<typeof previewFit>>>(null);
  const mv = useMovable("match");
  useLayoutEffect(() => {
    const r = anchor.getBoundingClientRect();
    const w = 360;
    setPos({ left: Math.max(8, Math.min(window.innerWidth - w - 8, r.left)), top: Math.min(r.bottom + 4, window.innerHeight - 560) });
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
  // live preview of the fit with these options
  useEffect(() => {
    let live = true;
    const t = setTimeout(() => previewFit(target, opts).then((p) => live && setPreview(p)), 200);
    return () => {
      live = false;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitTargetId(target), opts, doc]);
  return createPortal(
    <div className="match-panel" ref={ref} style={{ ...pos, transform: mv.moved ? `translate(${mv.off[0]}px, ${mv.off[1]}px)` : undefined }} data-movable>
      <Grip grip={mv.grip} label="Thread matching" />
      <div className="mp-presets">
        {MATCH_PRESETS.map((p) => (
          <button key={p.id} className={opts.preset === p.id ? "on" : ""} title={p.hint} onClick={() => set(p.opts, p.id)}>
            {p.label}
          </button>
        ))}
      </div>
      <p className="hint">{MATCH_PRESETS.find((p) => p.id === opts.preset)?.hint ?? "Your own settings."}</p>

      <div className="mp-sec">Colour difference</div>
      <Row label="Lightness" title="How much lightness differences count">
        <Slider min={0.25} max={3} step={0.05} value={opts.weights.l} onChange={(v) => set({ weights: { ...opts.weights, l: v } })} />
      </Row>
      <Row label="Saturation" title="How much saturation (chroma) differences count">
        <Slider min={0.25} max={3} step={0.05} value={opts.weights.c} onChange={(v) => set({ weights: { ...opts.weights, c: v } })} />
      </Row>
      <Row label="Hue" title="How much hue shifts count (orange turning red)">
        <Slider min={0.25} max={3} step={0.05} value={opts.weights.h} onChange={(v) => set({ weights: { ...opts.weights, h: v } })} />
      </Row>
      <Row label="Saturation boost" title="Match against more saturated colours: thread on fabric reads duller than a screen">
        <Slider min={0} max={0.6} step={0.05} value={opts.saturationBias} onChange={(v) => set({ saturationBias: v })} />
      </Row>

      <div className="mp-sec">Keep colours apart</div>
      <Row label="One spool each" title="Different colours get different spools (when there are enough)">
        <Toggle on={opts.unique} onChange={(v) => set({ unique: v })} />
      </Row>
      <Row label="Min. distance" title="Fitted colours stay at least this far apart (ΔE; colours that were closer to begin with may share)">
        <Slider min={0} max={20} step={1} digits={0} unit="ΔE" value={opts.minSeparation} onChange={(v) => set({ minSeparation: v })} />
      </Row>
      <Row label="Light order" title="A lighter colour never gets a darker spool than a darker one (shading stays shading)">
        <Toggle on={opts.keepLightOrder} onChange={(v) => set({ keepLightOrder: v })} />
      </Row>
      <Row label="Neighbour contrast" title="Colours that touch in the design keep about their contrast">
        <Toggle on={opts.keepContrast} onChange={(v) => set({ keepContrast: v })} />
      </Row>

      <div className="mp-sec">Spools</div>
      <Row label="Spool budget" title="Use at most this many spools for the whole design (0 = no limit) — fewer colour changes">
        <span className="dz-inline">
          <Num value={opts.budget} min={0} max={64} step={1} digits={0} onChange={(v) => set({ budget: Math.round(v) })} />
          <span className="stat">{opts.budget ? "spools" : "no limit"}</span>
        </span>
      </Row>
      <Row label="Prefer owned" title="With a chart as target: spools in My threads win close calls">
        <Toggle on={opts.preferOwned} onChange={(v) => set({ preferOwned: v })} />
      </Row>
      <Row label="Prefer brand" title="Spools of this brand win close calls">
        <select className="select" value={opts.preferBrand} onChange={(e) => set({ preferBrand: e.target.value })}>
          <option value="">Any</option>
          {brands.map((b) => (
            <option key={b} value={b}>
              {b}
            </option>
          ))}
        </select>
      </Row>
      <Row label="Fabric aware" title="Avoid spools that almost match the fabric colour (they vanish)">
        <span className="dz-inline">
          <Toggle on={opts.fabricAware} onChange={(v) => set({ fabricAware: v })} />
          {opts.fabricAware && <Num value={opts.fabricMinDelta} min={2} max={30} step={1} digits={0} unit="ΔE" onChange={(v) => set({ fabricMinDelta: v })} />}
        </span>
      </Row>

      <div className="mp-preview">
        {preview ? (
          <>
            <span>
              ΔE avg <b>{preview.mean.toFixed(1)}</b> · worst <b className={preview.worst > 6 ? "far" : ""}>{preview.worst.toFixed(1)}</b>
            </span>
            <span>
              <b>{preview.spools}</b> spools{preview.merged ? ` · ${preview.merged} merged` : ""}
              {preview.poor ? ` · ${preview.poor} poor` : ""}
            </span>
          </>
        ) : (
          <span className="stat">{target.kind === "mine" && !mine.length ? "My threads is empty" : "Preview…"}</span>
        )}
      </div>
    </div>,
    document.body,
  );
}
