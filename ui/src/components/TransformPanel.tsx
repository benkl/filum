// The Transform panel for the selection: a 9-point reference
// point, X / Y / W / H (with a proportion lock), rotate, skew and flip.

import { FlipHorizontal2, FlipVertical2, Link2, Link2Off, RotateCcw, RotateCw } from "lucide-react";
import { useState } from "react";
import { mirrorSelection } from "../lib/arrange";
import { objectBounds, rotateAbout, scaleAbout, transformObject, translateMat, unionBoxes } from "../lib/geometry";
import { skewAbout } from "../canvas/transform";
import { useStore } from "../store";
import type { DesignObject, Vec2 } from "../types";
import { Num } from "./ui";

const REF_KEY = "filum.refPoint";
const LOCK_KEY = "filum.lockRatio";

/** Apply a matrix to the selection (mirrored or sheared lettering becomes shapes). */
function applyToSelection(ids: string[], m: number[], rot = 0) {
  const det = m[0] * m[3] - m[1] * m[2];
  const similarity = Math.abs(m[0] - m[3]) < 1e-9 && Math.abs(m[1] + m[2]) < 1e-9;
  useStore.getState().commit((d) => ({
    ...d,
    objects: d.objects.map((o) => {
      if (!ids.includes(o.id) || o.locked) return o;
      const c = transformObject(o, m as never, rot);
      return o.text && (det < 0 || !similarity) ? { ...c, text: undefined } : c;
    }),
  }));
}

export function TransformPanel({ objects }: { objects: DesignObject[] }) {
  const doc = useStore((s) => s.doc);
  const [ref, setRef] = useState<[number, number]>(() => {
    try {
      return JSON.parse(localStorage.getItem(REF_KEY) ?? "[0.5,0.5]");
    } catch {
      return [0.5, 0.5];
    }
  });
  const [lock, setLock] = useState(() => localStorage.getItem(LOCK_KEY) !== "0");
  const b = unionBoxes(objects.map(objectBounds));
  if (!b) return null;
  const ids = objects.map((o) => o.id);
  const locked = objects.some((o) => o.locked);
  const rp: Vec2 = [b.x + b.w * ref[0], b.y + b.h * ref[1]];
  // positions relative to the hoop centre (the machine's origin)
  const cx = doc.hoop.width / 2;
  const cy = doc.hoop.height / 2;
  const apply = (m: number[], rot = 0) => applyToSelection(ids, m, rot);
  const setW = (w: number) => {
    const k = w / (b.w || 1);
    apply(scaleAbout(k, lock ? k : 1, rp[0], rp[1]));
  };
  const setH = (h: number) => {
    const k = h / (b.h || 1);
    apply(scaleAbout(lock ? k : 1, k, rp[0], rp[1]));
  };
  const pickRef = (r: [number, number]) => {
    setRef(r);
    localStorage.setItem(REF_KEY, JSON.stringify(r));
  };
  return (
    <div className={`transform-panel ${locked ? "disabled" : ""}`}>
      <div className="tp-top">
        <div className="refgrid" role="group" aria-label="Reference point" title="Reference point for position, size and rotation">
          {[0, 0.5, 1].map((y) =>
            [0, 0.5, 1].map((x) => (
              <button key={`${x}${y}`} className={ref[0] === x && ref[1] === y ? "on" : ""} onClick={() => pickRef([x, y])} aria-label={`Reference ${x},${y}`} />
            )),
          )}
        </div>
        <div className="tp-fields">
          <label className="tp-field">
            <span>X</span>
            <Num value={rp[0] - cx} unit="mm" onChange={(v) => apply(translateMat(v - (rp[0] - cx), 0))} />
          </label>
          <label className="tp-field">
            <span>Y</span>
            <Num value={rp[1] - cy} unit="mm" onChange={(v) => apply(translateMat(0, v - (rp[1] - cy)))} />
          </label>
          <label className="tp-field">
            <span>W</span>
            <Num value={b.w} unit="mm" min={0.1} onChange={setW} />
          </label>
          <label className="tp-field">
            <span>H</span>
            <Num value={b.h} unit="mm" min={0.1} onChange={setH} />
          </label>
        </div>
        <button
          className={`icon-btn tp-lock ${lock ? "on" : ""}`}
          title={lock ? "Proportions locked" : "Proportions free"}
          onClick={() => {
            setLock(!lock);
            localStorage.setItem(LOCK_KEY, lock ? "0" : "1");
          }}
        >
          {lock ? <Link2 size={14} /> : <Link2Off size={14} />}
        </button>
      </div>
      <div className="tp-row">
        <label className="tp-field" title="Rotate by (around the reference point)">
          <span>⟲</span>
          <Num value={0} unit="°" step={15} onChange={(v) => v && apply(rotateAbout(v, rp[0], rp[1]), v)} />
        </label>
        <button className="icon-btn" title="Rotate 90° left" onClick={() => apply(rotateAbout(-90, rp[0], rp[1]), -90)}>
          <RotateCcw size={14} />
        </button>
        <button className="icon-btn" title="Rotate 90° right" onClick={() => apply(rotateAbout(90, rp[0], rp[1]), 90)}>
          <RotateCw size={14} />
        </button>
        <span className="tp-sep" />
        <button className="icon-btn" title="Mirror horizontally" onClick={() => mirrorSelection("h")}>
          <FlipHorizontal2 size={14} />
        </button>
        <button className="icon-btn" title="Mirror vertically" onClick={() => mirrorSelection("v")}>
          <FlipVertical2 size={14} />
        </button>
      </div>
      <div className="tp-row">
        <label className="tp-field" title="Skew horizontally by (around the reference point)">
          <span>⧄ H</span>
          <Num value={0} unit="°" step={5} onChange={(v) => v && Math.abs(v) < 80 && apply(skewAbout(Math.tan((v * Math.PI) / 180), 0, rp[0], rp[1]))} />
        </label>
        <label className="tp-field" title="Skew vertically by (around the reference point)">
          <span>⧄ V</span>
          <Num value={0} unit="°" step={5} onChange={(v) => v && Math.abs(v) < 80 && apply(skewAbout(0, Math.tan((v * Math.PI) / 180), rp[0], rp[1]))} />
        </label>
      </div>
    </div>
  );
}
