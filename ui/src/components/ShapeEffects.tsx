// Shape effects (Path ▸ Effects): round corners, pucker &
// bloat, zig zag, roughen, twist, warp, simplify, smooth, add anchor points.
// Live preview on the real stitches; Apply commits one undo step, Cancel
// restores the shapes.

import { useEffect, useMemo, useRef, useState } from "react";
import { syncGradientGeometry } from "../lib/gradient";
import { flattenSubPath } from "../lib/bezier";
import { objectBounds, unionBoxes } from "../lib/geometry";
import { applyEffect, DEFAULT_EFFECTS, WARPS, type Box, type EffectId, type EffectParams } from "../lib/shapeOps";
import { useStore } from "../store";
import type { DesignObject, StitchDocument, SubPath } from "../types";
import { Dialog, Row, Slider, Toggle } from "./ui";

const KEY = "filum.effects";
let pending: EffectId | null = null;

/** Open the effects dialog on one effect. */
export function openEffect(id: EffectId) {
  pending = id;
  useStore.getState().setDialog("effects");
}

export const EFFECTS: { id: EffectId; label: string; title: string }[] = [
  { id: "corners", label: "Round corners", title: "Round, inverted (scalloped) or chamfered corners" },
  { id: "pucker", label: "Pucker & bloat", title: "Pull anchors in and push curves out (bloat), or the reverse (pucker)" },
  { id: "zigzag", label: "Zig-zag", title: "Ridges along the path — sharp or wavy" },
  { id: "roughen", label: "Roughen", title: "Random jagged or wobbly edges" },
  { id: "twist", label: "Twist", title: "Rotate more at the centre than at the edges" },
  { id: "warp", label: "Warp", title: "Envelope warps: arc, arch, bulge, flag, wave, fish, rise, inflate, squeeze" },
  { id: "simplify", label: "Simplify", title: "Fit clean curves: fewer anchor points, straight runs as lines, corners kept (tidy up traced or imported paths)" },
  { id: "smooth", label: "Smooth", title: "Turn corners into smooth curves" },
  { id: "anchors", label: "Add anchors", title: "Split every segment (more points to edit or distort)" },
];

function loadParams(): EffectParams {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    const out = { ...DEFAULT_EFFECTS } as EffectParams;
    for (const k of Object.keys(DEFAULT_EFFECTS) as EffectId[]) (out as unknown as Record<string, unknown>)[k] = { ...DEFAULT_EFFECTS[k], ...(raw[k] ?? {}) };
    return out;
  } catch {
    return DEFAULT_EFFECTS;
  }
}

/** Sample shape for the effect thumbnails: a rounded-ish square with a notch. */
const SAMPLE: SubPath = {
  closed: true,
  nodes: [{ p: [4, 4] }, { p: [20, 4] }, { p: [28, 4] }, { p: [28, 20] }, { p: [16, 28] }, { p: [4, 20] }],
};
const SAMPLE_BOX: Box = { x: 4, y: 4, w: 24, h: 24 };

function thumbPath<K extends EffectId>(id: K, p: EffectParams[K]): string {
  // scale size-like parameters to the 32-unit thumbnail
  const q = { ...p } as Record<string, unknown>;
  if (id === "corners") q.radius = Math.min(8, (p as EffectParams["corners"]).radius * 1.2);
  if (id === "zigzag") q.size = Math.min(3, (p as EffectParams["zigzag"]).size);
  if (id === "roughen") q.size = Math.min(2.5, (p as EffectParams["roughen"]).size * 1.2);
  const [sp] = applyEffect([SAMPLE], id, q as EffectParams[K], SAMPLE_BOX);
  const pts = flattenSubPath(sp, 0.4);
  return pts.map((v, i) => `${i ? "L" : "M"}${v[0].toFixed(2)} ${v[1].toFixed(2)}`).join("") + (sp.closed ? "Z" : "");
}

function NodesPreview({ id, p }: { id: EffectId; p: EffectParams[EffectId] }) {
  const [sp] = applyEffect([SAMPLE], id, p as never, SAMPLE_BOX);
  return (
    <>
      {sp.nodes.map((n, i) => (
        <rect key={i} x={n.p[0] - 0.8} y={n.p[1] - 0.8} width={1.6} height={1.6} fill="var(--select)" />
      ))}
    </>
  );
}

export function ShapeEffectsDialog({ onClose }: { onClose: () => void }) {
  const [id, setId] = useState<EffectId>(pending ?? (localStorage.getItem(KEY + ".last") as EffectId) ?? "corners");
  const [params, setParams] = useState<EffectParams>(loadParams);
  const [preview, setPreview] = useState(true);
  // the shapes as they were when the dialog opened
  const orig = useMemo(() => {
    const s = useStore.getState();
    return s.doc.objects.filter((o) => s.selection.includes(o.id) && !o.text && o.paths.some((sp) => sp.nodes.length >= 2));
  }, []);
  const skipped = useMemo(() => {
    const s = useStore.getState();
    return s.doc.objects.filter((o) => s.selection.includes(o.id) && o.text).length;
  }, []);
  const box = useMemo<Box>(() => unionBoxes(orig.map(objectBounds)) ?? { x: 0, y: 0, w: 10, h: 10 }, [orig]);
  const applied = useRef(false);
  useEffect(() => {
    pending = null;
  }, []);

  const transform = (d: StitchDocument, withEffect: boolean): StitchDocument => {
    const map = new Map<string, DesignObject>(orig.map((o) => [o.id, withEffect ? { ...o, paths: applyEffect(o.paths, id, params[id] as never, box) } : o]));
    let next: StitchDocument = { ...d, objects: d.objects.map((o) => map.get(o.id) ?? o) };
    for (const o of map.values()) next = syncGradientGeometry(next, o);
    return next;
  };

  // live preview
  useEffect(() => {
    if (!orig.length) return;
    useStore.getState().liveUpdate((d) => transform(d, preview));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, params, preview]);
  // closing without Apply restores the shapes
  useEffect(
    () => () => {
      if (!applied.current && orig.length) useStore.getState().liveUpdate((d) => transform(d, false));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const set = <K extends EffectId>(k: K, patch: Partial<EffectParams[K]>) =>
    setParams((p) => {
      const next = { ...p, [k]: { ...p[k], ...patch } };
      localStorage.setItem(KEY, JSON.stringify(next));
      return next;
    });
  const choose = (k: EffectId) => {
    setId(k);
    localStorage.setItem(KEY + ".last", k);
  };
  const apply = () => {
    const s = useStore.getState();
    applied.current = true;
    s.liveUpdate((d) => transform(d, false));
    s.commit((d) => transform(d, true));
    onClose();
  };
  const nodesBefore = orig.reduce((a, o) => a + o.paths.reduce((b, sp) => b + sp.nodes.length, 0), 0);
  const nodesAfter = orig.reduce((a, o) => a + applyEffect(o.paths, id, params[id] as never, box).reduce((b, sp) => b + sp.nodes.length, 0), 0);
  const p = params;

  return (
    <Dialog
      live
      title="Shape effects"
      onClose={onClose}
      wide
      footer={
        <>
          <label className="fx-preview">
            <Toggle on={preview} onChange={setPreview} /> Preview
          </label>
          <span className="stat">
            {orig.length} object{orig.length === 1 ? "" : "s"} · {nodesBefore} → {nodesAfter} anchor points
          </span>
          <div className="spacer" />
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!orig.length} onClick={apply}>
            Apply
          </button>
        </>
      }
    >
      {!orig.length ? (
        <p className="hint">Select one or more shapes first{skipped ? " (lettering is edited in the lettering panel)" : ""}.</p>
      ) : (
        <div className="fx">
          <div className="fx-list">
            {EFFECTS.map((e) => (
              <button key={e.id} className={`fx-card ${id === e.id ? "on" : ""}`} title={e.title} onClick={() => choose(e.id)}>
                <svg viewBox="0 0 32 32">
                  <path d={thumbPath(e.id, params[e.id] as never)} />
                  {id === e.id && <NodesPreview id={e.id} p={params[e.id]} />}
                </svg>
                <span>{e.label}</span>
              </button>
            ))}
          </div>
          <div className="fx-params">
            <h3>{EFFECTS.find((e) => e.id === id)?.label}</h3>
            <p className="hint">{EFFECTS.find((e) => e.id === id)?.title}.</p>
            {id === "corners" && (
              <>
                <Row label="Style">
                  <div className="seg">
                    {(["round", "inverted", "chamfer"] as const).map((k) => (
                      <button key={k} className={p.corners.style === k ? "on" : ""} onClick={() => set("corners", { style: k })}>
                        {k === "round" ? "Round" : k === "inverted" ? "Inverted" : "Chamfer"}
                      </button>
                    ))}
                  </div>
                </Row>
                <Row label="Radius">
                  <Slider min={0} max={30} step={0.1} unit="mm" value={p.corners.radius} onChange={(v) => set("corners", { radius: v })} />
                </Row>
                <Row label="Only corners over" title="Corners that turn less than this stay as they are">
                  <Slider min={1} max={170} step={1} digits={0} unit="°" value={p.corners.minTurn} onChange={(v) => set("corners", { minTurn: v })} />
                </Row>
                <p className="hint">Tip: with the node tool (A), drag the corner widgets to round single corners.</p>
              </>
            )}
            {id === "pucker" && (
              <>
                <Row label="Amount" title="Negative: pucker (star-like) · positive: bloat (puffy)">
                  <Slider min={-100} max={100} step={1} digits={0} unit="%" value={p.pucker.amount} onChange={(v) => set("pucker", { amount: v })} />
                </Row>
                <Row label="Extra points" title="Anchor points added per segment first (more petals)">
                  <Slider min={0} max={6} step={1} digits={0} value={p.pucker.detail} onChange={(v) => set("pucker", { detail: Math.round(v) })} />
                </Row>
              </>
            )}
            {id === "zigzag" && (
              <>
                <Row label="Size">
                  <Slider min={0.1} max={10} step={0.1} unit="mm" value={p.zigzag.size} onChange={(v) => set("zigzag", { size: v })} />
                </Row>
                <Row label="Ridges / segment">
                  <Slider min={1} max={40} step={1} digits={0} value={p.zigzag.ridges} onChange={(v) => set("zigzag", { ridges: Math.round(v) })} />
                </Row>
                <Row label="Points">
                  <div className="seg">
                    <button className={p.zigzag.smooth ? "on" : ""} onClick={() => set("zigzag", { smooth: true })}>
                      Smooth
                    </button>
                    <button className={!p.zigzag.smooth ? "on" : ""} onClick={() => set("zigzag", { smooth: false })}>
                      Corner
                    </button>
                  </div>
                </Row>
              </>
            )}
            {id === "roughen" && (
              <>
                <Row label="Size">
                  <Slider min={0.1} max={6} step={0.1} unit="mm" value={p.roughen.size} onChange={(v) => set("roughen", { size: v })} />
                </Row>
                <Row label="Detail" title="Points per centimetre">
                  <Slider min={0.5} max={20} step={0.5} unit="/cm" value={p.roughen.detail} onChange={(v) => set("roughen", { detail: v })} />
                </Row>
                <Row label="Points">
                  <div className="seg">
                    <button className={p.roughen.smooth ? "on" : ""} onClick={() => set("roughen", { smooth: true })}>
                      Smooth
                    </button>
                    <button className={!p.roughen.smooth ? "on" : ""} onClick={() => set("roughen", { smooth: false })}>
                      Corner
                    </button>
                  </div>
                </Row>
                <Row label="Variation">
                  <button className="btn sm" onClick={() => set("roughen", { seed: (p.roughen.seed % 9973) + 1 })}>
                    Shuffle
                  </button>
                </Row>
              </>
            )}
            {id === "twist" && (
              <Row label="Angle">
                <Slider min={-360} max={360} step={1} digits={0} unit="°" value={p.twist.angle} onChange={(v) => set("twist", { angle: v })} />
              </Row>
            )}
            {id === "warp" && (
              <>
                <div className="fx-warps">
                  {WARPS.map((w) => (
                    <button key={w.id} className={p.warp.style === w.id ? "on" : ""} onClick={() => set("warp", { style: w.id })}>
                      <svg viewBox="0 0 32 32">
                        <path d={thumbPath("warp", { ...p.warp, style: w.id, bend: 50 })} />
                      </svg>
                      <span>{w.label}</span>
                    </button>
                  ))}
                </div>
                <Row label="Bend">
                  <Slider min={-100} max={100} step={1} digits={0} unit="%" value={p.warp.bend} onChange={(v) => set("warp", { bend: v })} />
                </Row>
                <Row label="Direction">
                  <div className="seg">
                    <button className={!p.warp.vertical ? "on" : ""} onClick={() => set("warp", { vertical: false })}>
                      Horizontal
                    </button>
                    <button className={p.warp.vertical ? "on" : ""} onClick={() => set("warp", { vertical: true })}>
                      Vertical
                    </button>
                  </div>
                </Row>
              </>
            )}
            {id === "simplify" && (
              <>
                <Row label="Tolerance" title="How far the curve may move (mm)">
                  <Slider min={0.02} max={3} step={0.02} unit="mm" value={p.simplify.tolerance} onChange={(v) => set("simplify", { tolerance: v })} />
                </Row>
                <Row label="Corner angle" title="Turns sharper than this stay corners">
                  <Slider min={10} max={170} step={1} digits={0} unit="°" value={p.simplify.corner} onChange={(v) => set("simplify", { corner: v })} />
                </Row>
                <Row label="Straight lines" title="Straight runs become straight segments (logos, lettering)">
                  <Toggle on={p.simplify.lines ?? true} onChange={(v) => set("simplify", { lines: v })} />
                </Row>
              </>
            )}
            {id === "smooth" && (
              <>
                <Row label="Tension">
                  <Slider min={0.2} max={1.6} step={0.05} value={p.smooth.tension} onChange={(v) => set("smooth", { tension: v })} />
                </Row>
                <Row label="Keep corners over" title="Corners turning more than this stay sharp (180° = smooth all)">
                  <Slider min={10} max={180} step={1} digits={0} unit="°" value={p.smooth.keep} onChange={(v) => set("smooth", { keep: v })} />
                </Row>
              </>
            )}
            {id === "anchors" && (
              <Row label="Times" title="Each pass splits every segment in half">
                <Slider min={1} max={4} step={1} digits={0} value={p.anchors.times} onChange={(v) => set("anchors", { times: Math.round(v) })} />
              </Row>
            )}
            {skipped > 0 && <p className="hint">{skipped} lettering object{skipped === 1 ? "" : "s"} left out — lettering stays editable text.</p>}
          </div>
        </div>
      )}
    </Dialog>
  );
}

/** Run a path operation on every selected shape (one undo step). */
export function pathCommand(fn: (sp: SubPath) => SubPath, label: string) {
  const s = useStore.getState();
  const ids = new Set(s.doc.objects.filter((o) => s.selection.includes(o.id) && !o.text).map((o) => o.id));
  if (!ids.size) return s.toast("Select one or more shapes first");
  s.commit((d) => {
    let next: StitchDocument = { ...d, objects: d.objects.map((o) => (ids.has(o.id) ? { ...o, paths: o.paths.map((sp) => (sp.nodes.length >= 2 ? fn(sp) : sp)) } : o)) };
    for (const o of next.objects) if (ids.has(o.id)) next = syncGradientGeometry(next, o);
    return next;
  });
  s.toast(`${label}: ${ids.size} object${ids.size === 1 ? "" : "s"}`);
}

/** Guided fill: the selected open line becomes the guide of the selected fill (and is removed). */
export function lineAsFillGuide() {
  const s = useStore.getState();
  const sel = s.doc.objects.filter((o) => s.selection.includes(o.id));
  const fill = sel.find((o) => o.stitch.type === "fill" && !o.stitch.gradient && o.paths.some((sp) => sp.closed));
  const line = sel.find((o) => o !== fill && o.paths.some((sp) => !sp.closed && sp.nodes.length >= 2));
  if (!fill || !line) return s.toast("Select a fill shape and an open line together (Shift-click)");
  const guide = line.paths.find((sp) => !sp.closed && sp.nodes.length >= 2)!;
  s.commit((d) => ({
    ...d,
    objects: d.objects
      .filter((o) => o.id !== line.id)
      .map((o) => (o.id === fill.id && o.stitch.type === "fill" ? { ...o, stitch: { ...o.stitch, method: "guided" as const, guide } } : o)),
  }));
  s.select([fill.id]);
  s.toast("Guided fill: the rows follow the line");
}
