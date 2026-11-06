// Shape conversions (Path menu · context bar "Convert"): fill → satin,
// fill → centre line, satin → centre line, centre line → rails, zig-zag line
// → satin, patterned satin, break apart, remove duplicated points. One live
// dialog in the style of Shape effects: pick a conversion, tune it while the
// result previews on the canvas, Apply commits one undo step.

import { ArrowRightLeft, ChevronDown } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../store";
import type { DesignObject, SubPath, Vec2 } from "../types";
import { flattenSubPath } from "../lib/bezier";
import { patternSatin, SATIN_PATTERNS, type SatinPattern, type ZigzagPattern } from "../lib/convert";
import { applies, applyPlan, DEFAULT_CONVERT, planConversion, UNDERLAYS, type ConvertId, type ConvertOptions, type ConvertPlan } from "../lib/convertActions";
import { Dialog, Num, Row, Slider, Toggle } from "./ui";
import { safeSetItem } from "../lib/storage";

const KEY = "filum.convert";
let pending: ConvertId | null = null;

/** Open the Convert dialog on one conversion. */
export function openConvert(id: ConvertId) {
  pending = id;
  useStore.getState().setDialog("convert");
}


type Icon = { d: string; fill?: boolean; thin?: boolean }[];

export const CONVERSIONS: { id: ConvertId; label: string; menu: string; title: string; icon: Icon }[] = [
  {
    id: "fillToSatin",
    label: "Fill → satin",
    menu: "Fill to satin…",
    title: "Satin columns from a fill shape and rung lines drawn across it — the outline becomes the rails",
    icon: [{ d: "M5 9 C9 3 23 3 27 9 L27 23 C23 29 9 29 5 23 Z", fill: true }, { d: "M2 12 L30 12 M2 20 L30 20", thin: true }],
  },
  {
    id: "fillToStroke",
    label: "Centre line",
    menu: "Fill to centre line…",
    title: "The centre line (skeleton) of a fill shape, as running stitch or a satin of the shape's width",
    icon: [{ d: "M4 22 C6 8 12 6 16 6 C22 6 28 12 28 18 L22 20 C21 15 19 12 16 12 C13 12 10 16 10 24 Z", fill: true }, { d: "M7 23 C8 13 12 9 16 9 C21 9 24 14 25 19", thin: true }],
  },
  {
    id: "satinToStroke",
    label: "Satin → run",
    menu: "Satin to centre line…",
    title: "A running stitch along the middle of a satin column",
    icon: [{ d: "M4 20 C10 8 22 8 28 20 L24 23 C20 14 12 14 8 23 Z", fill: true }, { d: "M6 21.5 C11 11 21 11 26 21.5", thin: true }],
  },
  {
    id: "satinToRails",
    label: "Centre → rails",
    menu: "Satin centre line to rails…",
    title: "A centre-line satin (or a line) as two editable rails with rungs",
    icon: [{ d: "M4 20 C10 8 22 8 28 20 M8 23 C12 14 20 14 24 23 M7 15 L10 19 M16 9 L16 15 M25 15 L22 19", thin: true }],
  },
  {
    id: "zigzagToSatin",
    label: "Zig-zag → satin",
    menu: "Zig-zag line to satin…",
    title: "A line drawn back and forth across a column (square, sawtooth or zig-zag) becomes a satin",
    icon: [{ d: "M4 22 L4 10 L10 10 L10 22 L16 22 L16 10 L22 10 L22 22 L28 22 L28 10", thin: true }],
  },
  {
    id: "patternSatin",
    label: "Patterned satin",
    menu: "Patterned satin along a line…",
    title: "A satin along a line in a pattern: pearls, diamonds, squares, triangles, waves, arches",
    icon: [{ d: "M3 16 L8 11 L13 16 L8 21 Z M13 16 L18 11 L23 16 L18 21 Z M23 16 L28 11 L33 16 L28 21 Z", fill: true }],
  },
  {
    id: "breakApart",
    label: "Break apart",
    menu: "Break apart fill…",
    title: "Repair a fill (crossing outlines, stray loops) and split it into its separate shapes",
    icon: [{ d: "M4 6 L14 6 L14 16 L4 16 Z M18 16 L28 16 L28 26 L18 26 Z", fill: true }, { d: "M14 6 L28 26", thin: true }],
  },
  {
    id: "dedupe",
    label: "Duplicates",
    menu: "Remove duplicated points…",
    title: "Remove points that repeat (or nearly repeat) an earlier point of the path",
    icon: [{ d: "M4 24 L12 8 L20 20 L28 6", thin: true }, { d: "M10.5 6.5 h3 v3 h-3 Z M18.5 18.5 h3 v3 h-3 Z", fill: true }],
  },
];

function loadOptions(): ConvertOptions {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    const out = { ...DEFAULT_CONVERT } as Record<string, unknown>;
    for (const k of Object.keys(DEFAULT_CONVERT)) out[k] = { ...(DEFAULT_CONVERT as unknown as Record<string, object>)[k], ...(raw[k] ?? {}) };
    return out as unknown as ConvertOptions;
  } catch {
    return DEFAULT_CONVERT;
  }
}

function IconSvg({ icon, size = 52 }: { icon: Icon; size?: number }) {
  return (
    <svg viewBox="0 0 32 32" style={{ width: size, height: size }}>
      {icon.map((p, i) => (
        <path key={i} d={p.d} style={p.thin ? { fill: "none" } : p.fill ? undefined : { fill: "none" }} />
      ))}
    </svg>
  );
}

const outlineOf = (paths: SubPath[]) => {
  // a satin's rails as one closed outline for a thumbnail
  if (paths.length < 2) return "";
  const a = flattenSubPath(paths[0], 0.3);
  const b = flattenSubPath(paths[1], 0.3).reverse();
  return [...a, ...b].map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(2)} ${p[1].toFixed(2)}`).join("") + "Z";
};
const polyline = (pts: Vec2[]) => pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(2)} ${p[1].toFixed(2)}`).join("");

const ZIGZAGS: { id: ZigzagPattern; label: string; pts: Vec2[]; title: string }[] = [
  { id: "square", label: "Square", title: "|_|▔|_| — four points per stitch block", pts: [[3, 22], [3, 10], [9, 10], [9, 22], [15, 22], [15, 10], [21, 10], [21, 22], [27, 22], [27, 10]] },
  { id: "sawtooth", label: "Sawtooth", title: "|/|/| — every point on the other rail", pts: [[3, 22], [6, 10], [10, 22], [13, 10], [17, 22], [20, 10], [24, 22], [27, 10]] },
  { id: "zigzag", label: "Zig-zag", title: "VVV — the stitches follow the drawn line", pts: [[3, 22], [7, 10], [11, 22], [15, 10], [19, 22], [23, 10], [27, 22]] },
];

export function ConvertDialog({ onClose }: { onClose: () => void }) {
  // the document and selection as they were when the dialog opened
  const base = useMemo(() => {
    const d = useStore.getState().doc;
    return { objects: d.objects, groupParents: d.groupParents, groupNames: d.groupNames };
  }, []);
  const sel = useMemo(() => {
    const s = useStore.getState();
    return s.doc.objects.filter((o) => s.selection.includes(o.id) && !o.locked);
  }, []);
  const first = CONVERSIONS.find((c) => applies(c.id, sel))?.id ?? "fillToSatin";
  const last = localStorage.getItem(KEY + ".last") as ConvertId | null;
  const [id, setId] = useState<ConvertId>(pending ?? (last && CONVERSIONS.some((c) => c.id === last) && applies(last, sel) ? last : first));
  const [opts, setOpts] = useState<ConvertOptions>(loadOptions);
  const [preview, setPreview] = useState(true);
  const [plan, setPlan] = useState<ConvertPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const applied = useRef(false);
  const run = useRef(0);
  useEffect(() => {
    pending = null;
  }, []);

  // the objects and their groups as they were (a preview may dissolve or add groups)
  const restore = () => useStore.getState().liveUpdate((d) => ({ ...d, ...base }));

  // compute the plan (debounced) and preview it on the canvas
  useEffect(() => {
    const ticket = ++run.current;
    setBusy(true);
    const t = setTimeout(async () => {
      let r: ConvertPlan | string;
      try {
        r = await planConversion(id, sel, opts);
      } catch (e) {
        r = String((e as Error)?.message ?? e);
      }
      if (ticket !== run.current) return;
      setBusy(false);
      if (typeof r === "string") {
        setPlan(null);
        setError(r);
        restore();
        return;
      }
      setPlan(r);
      setError(null);
      if (preview) useStore.getState().liveUpdate((d) => applyPlan({ ...d, ...base }, r as ConvertPlan));
      else restore();
    }, 120);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, opts, preview]);
  // closing without Apply restores the shapes
  useEffect(
    () => () => {
      // a plan still being worked out is dropped (it would land after the restore)
      run.current++;
      if (!applied.current) restore();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const set = <K extends keyof ConvertOptions>(k: K, patch: Partial<ConvertOptions[K]>) =>
    setOpts((p) => {
      const next = { ...p, [k]: { ...p[k], ...patch } };
      safeSetItem(KEY, JSON.stringify(next));
      return next;
    });
  const choose = (k: ConvertId) => {
    setId(k);
    safeSetItem(KEY + ".last", k);
  };
  const apply = () => {
    if (!plan) return;
    const s = useStore.getState();
    applied.current = true;
    restore();
    s.commit((d) => applyPlan(d, plan));
    s.select(plan.select);
    s.toast(plan.summary, "success");
    onClose();
  };
  const conv = CONVERSIONS.find((c) => c.id === id)!;
  const o = opts;
  const hasCutLines = sel.some((x) => !x.text && x.stitch.type !== "fill" && x.paths.some((sp) => !sp.closed && sp.nodes.length >= 2));
  const hasLines = sel.some((x) => !x.text && x.stitch.type !== "satin" && x.stitch.type !== "fill");

  return (
    <Dialog
      live
      title="Convert shapes"
      onClose={onClose}
      wide
      footer={
        <>
          <label className="fx-preview">
            <Toggle on={preview} onChange={setPreview} /> Preview
          </label>
          <span className="stat">{busy ? "Working…" : error ? "" : plan?.summary}</span>
          <div className="spacer" />
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!plan || busy} onClick={apply}>
            Apply
          </button>
        </>
      }
    >
      <div className="fx">
        <div className="fx-list">
          {CONVERSIONS.map((c) => (
            <button key={c.id} className={`fx-card ${id === c.id ? "on" : ""} ${applies(c.id, sel) ? "" : "dim"}`} title={c.title} onClick={() => choose(c.id)}>
              <IconSvg icon={c.icon} />
              <span>{c.label}</span>
            </button>
          ))}
        </div>
        <div className="fx-params">
          <h3>{conv.menu.replace("…", "")}</h3>
          <p className="hint">{conv.title}.</p>
          {error && <p className="hint warn">{error}</p>}
          {id === "fillToSatin" && (
            <>
              <p className="hint">Select the fill together with lines drawn right across it (rungs): each rung crosses the outline twice and sets the stitch direction there. Where more than two rungs meet one part, the satins end.</p>
              <Row label="Start / end at rung" title="Leave out the rounded ends: the satins start and end at the first and last rung (needs at least two rungs)">
                <Toggle on={o.fillToSatin.skipEndSection} onChange={(v) => set("fillToSatin", { skipEndSection: v })} />
              </Row>
              <Row label="Underlay">
                <div className="seg">
                  {UNDERLAYS.map(([k, label, , title]) => (
                    <button key={k} title={title} className={o.fillToSatin.underlay === k ? "on" : ""} onClick={() => set("fillToSatin", { underlay: k })}>
                      {label}
                    </button>
                  ))}
                </div>
              </Row>
              <Row label="Pull compensation" title="Widen the columns so they keep the shape's width once sewn">
                <Num value={o.fillToSatin.pullComp} unit="mm" step={0.05} min={-10} max={10} onChange={(v) => set("fillToSatin", { pullComp: v })} />
              </Row>
              <Row label="Keep" title="What stays of the selection besides the new satins">
                <div className="seg">
                  {(
                    [
                      ["unused", "Unconverted parts", "Parts of the fill no rung crosses stay a fill"],
                      ["none", "Nothing", "Remove the fills and the rungs"],
                      ["fills", "Fills", "Keep the fills, remove the rungs"],
                      ["all", "All", "Keep the fills and the rungs"],
                    ] as const
                  ).map(([k, label, title]) => (
                    <button key={k} title={title} className={o.fillToSatin.keep === k ? "on" : ""} onClick={() => set("fillToSatin", { keep: k })}>
                      {label}
                    </button>
                  ))}
                </div>
              </Row>
            </>
          )}
          {id === "fillToStroke" && (
            <>
              <Row label="Stitch as" title="Running stitch along the centre lines, or satins as wide as the shape">
                <div className="seg">
                  <button className={o.fillToStroke.output === "running" ? "on" : ""} onClick={() => set("fillToStroke", { output: "running" })}>
                    Running stitch
                  </button>
                  <button className={o.fillToStroke.output === "satin" ? "on" : ""} onClick={() => set("fillToStroke", { output: "satin" })}>
                    Satin
                  </button>
                </div>
              </Row>
              <Row label="Dead ends under" title="Side branches shorter than this are removed — about the line width of the shape works in most cases">
                <Slider min={0} max={30} step={0.5} unit="mm" value={o.fillToStroke.deadEnd} onChange={(v) => set("fillToStroke", { deadEnd: v })} />
              </Row>
              <Row label="Keep original" title="Keep the fill (and the cut lines)">
                <Toggle on={o.fillToStroke.keepOriginal} onChange={(v) => set("fillToStroke", { keepOriginal: v })} />
              </Row>
              {hasCutLines && (
                <Row label="Close gaps at cuts" title="Lines ending at a cut line are joined to the line beyond it">
                  <Toggle on={o.fillToStroke.closeGaps} onChange={(v) => set("fillToStroke", { closeGaps: v })} />
                </Row>
              )}
              <p className="hint">{hasCutLines ? "The selected lines cut the shape apart first — use them to split crossings or set where lines end." : "Tip: select lines with the shape to cut it apart first (where lines should end or cross)."}</p>
            </>
          )}
          {id === "satinToStroke" && (
            <Row label="Keep satin" title="Keep the satin column too (the running stitch is sewn first)">
              <Toggle on={o.satinToStroke.keepSatin} onChange={(v) => set("satinToStroke", { keepSatin: v })} />
            </Row>
          )}
          {id === "satinToRails" && (
            <>
              <p className="hint">The satin keeps its width and settings; rungs sit away from sharp corners. Edit the rails and rungs with the node tool (A).</p>
              {hasLines && (
                <Row label="Width of lines" title="Column width for selected running-stitch lines (satins keep theirs)">
                  <Num value={o.satinToRails.width} unit="mm" step={0.1} min={0.3} max={20} onChange={(v) => set("satinToRails", { width: v })} />
                </Row>
              )}
            </>
          )}
          {id === "zigzagToSatin" && (
            <>
              <div className="fx-warps">
                {ZIGZAGS.map((z) => (
                  <button key={z.id} title={z.title} className={o.zigzagToSatin.pattern === z.id ? "on" : ""} onClick={() => set("zigzagToSatin", { pattern: z.id })}>
                    <svg viewBox="0 0 30 32">
                      <path d={polyline(z.pts)} style={{ fill: "none" }} />
                    </svg>
                    <span>{z.label}</span>
                  </button>
                ))}
              </div>
              <Row label="Smoothing" title="Smooth curves through the rail points (draw a doubled point to keep a corner)">
                <Toggle on={o.zigzagToSatin.smoothing} onChange={(v) => set("zigzagToSatin", { smoothing: v })} />
              </Row>
              <Row label="Rungs" title="Keep the stitch direction of the drawing">
                <Toggle on={o.zigzagToSatin.rungs} onChange={(v) => set("zigzagToSatin", { rungs: v })} />
              </Row>
              {o.zigzagToSatin.rungs && o.zigzagToSatin.pattern !== "zigzag" && (
                <Row label="Fewer rungs" title="Every other rung only">
                  <Toggle on={o.zigzagToSatin.reduceRungs} onChange={(v) => set("zigzagToSatin", { reduceRungs: v })} />
                </Row>
              )}
            </>
          )}
          {id === "patternSatin" && (
            <>
              <div className="fx-warps">
                {SATIN_PATTERNS.map((p) => (
                  <button key={p.id} className={o.patternSatin.pattern === p.id ? "on" : ""} onClick={() => set("patternSatin", { pattern: p.id as SatinPattern })}>
                    <svg viewBox="0 0 32 32">
                      <path d={outlineOf(patternSatin({ closed: false, nodes: [{ p: [1, 16] }, { p: [31, 16] }] }, { pattern: p.id, minWidth: 5, maxWidth: 12, length: 10, stretched: true, rungs: false }) ?? [])} />
                    </svg>
                    <span>{p.label}</span>
                  </button>
                ))}
              </div>
              <Row label="Min width" title="The narrowest point of the column">
                <Slider min={0.5} max={20} step={0.1} unit="mm" value={o.patternSatin.minWidth} onChange={(v) => set("patternSatin", { minWidth: v })} />
              </Row>
              {o.patternSatin.pattern !== "normal" && (
                <Row label="Max width" title="The widest point of the column">
                  <Slider min={0.5} max={30} step={0.1} unit="mm" value={o.patternSatin.maxWidth} onChange={(v) => set("patternSatin", { maxWidth: v })} />
                </Row>
              )}
              <Row label="Repeat length" title="Length of one pattern repeat along the line">
                <Slider min={1} max={60} step={0.5} unit="mm" value={o.patternSatin.length} onChange={(v) => set("patternSatin", { length: v })} />
              </Row>
              <Row label="Stretch to fit" title="Stretch the repeats so they fill the line exactly (off: whole repeats, the rest of the line stays free)">
                <Toggle on={o.patternSatin.stretched} onChange={(v) => set("patternSatin", { stretched: v })} />
              </Row>
              <Row label="Rungs" title="A rung in every repeat: the stitch angle follows the pattern">
                <Toggle on={o.patternSatin.rungs} onChange={(v) => set("patternSatin", { rungs: v })} />
              </Row>
            </>
          )}
          {id === "breakApart" && (
            <>
              <Row label="Method" title="How overlapping sub-paths are treated">
                <div className="seg">
                  <button title="Every sub-path is a shape of its own; shapes inside others become their holes" className={o.breakApart.method === "simple" ? "on" : ""} onClick={() => set("breakApart", { method: "simple" })}>
                    Simple
                  </button>
                  <button title="Overlapping sub-paths cancel out where they overlap" className={o.breakApart.method === "complex" ? "on" : ""} onClick={() => set("breakApart", { method: "complex" })}>
                    Complex
                  </button>
                </div>
              </Row>
              <Row label="Remove smaller than" title="Shapes and holes smaller than this are removed">
                <Num value={o.breakApart.minArea} unit="mm²" step={0.5} min={0.05} max={100} onChange={(v) => set("breakApart", { minArea: v })} />
              </Row>
              <p className="hint">A shape that is already one clean outline with holes is left as it is.</p>
            </>
          )}
          {id === "dedupe" && (
            <>
              <Row label="Distance" title="A point closer than this to an earlier point is removed">
                <Num value={o.dedupe.distance} unit="mm" step={0.01} min={0} max={10} digits={3} onChange={(v) => set("dedupe", { distance: v })} />
              </Row>
              <Row label="Look back" title="Compare with this many points before it">
                <Num value={o.dedupe.window} step={1} min={1} max={5000} digits={0} onChange={(v) => set("dedupe", { window: Math.round(v) })} />
              </Row>
            </>
          )}
          {!sel.length && <p className="hint warn">Select the objects to convert first.</p>}
        </div>
      </div>
    </Dialog>
  );
}

/** Context bar: the conversions that apply to the selection. */
export function ConvertMenuButton({ objects }: { objects: DesignObject[] }) {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const items = CONVERSIONS.filter((c) => applies(c.id, objects));
  useEffect(() => {
    if (!at) return;
    const close = (e: PointerEvent) => {
      if (!(e.target as HTMLElement).closest(".convert-menu,.convert-btn")) setAt(null);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [at]);
  if (!items.length) return null;
  return (
    <>
      <button
        className="btn sm ghost convert-btn"
        title="Convert the selection: fill ↔ satin, centre lines, rails, patterned satins, repair"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setAt(at ? null : { x: r.left, y: r.bottom + 4 });
        }}
      >
        <ArrowRightLeft size={13} /> Convert <ChevronDown size={11} />
      </button>
      {at && (
        <div className="menu convert-menu" style={{ left: at.x, top: at.y }}>
          {items.map((c) => (
            <button
              key={c.id}
              className="menu-item"
              title={c.title}
              onClick={() => {
                setAt(null);
                openConvert(c.id);
              }}
            >
              <span className="check" />
              {c.menu}
            </button>
          ))}
        </div>
      )}
    </>
  );
}
