// Fabric and thread of the design: the fabric preset with what its makers
// recommend underneath and on top, the thread weight, and the hoop's shape.

import { Circle, Square, TriangleAlert } from "lucide-react";
import { Fabric, Knockdown } from "../icons/stitch";
import { defaultDesignOptions } from "../lib/geometry";
import { FABRICS, fabricInfo, THREAD_WEIGHTS, threadWeightInfo } from "../lib/materials";
import { PILE } from "../lib/underlay";
import { useStore } from "../store";
import type { HoopShape, ThreadWeight } from "../types";
import { Row } from "./ui";

/** Rectangle / oval switch for the design hoop. */
export function HoopShapeRow() {
  const hoop = useStore((s) => s.doc.hoop);
  const commit = useStore((s) => s.commit);
  const shape = hoop.shape ?? "rect";
  const set = (v: HoopShape) => commit((d) => ({ ...d, hoop: { ...d.hoop, shape: v === "rect" ? undefined : v, name: "Custom" } }));
  return (
    <Row label="Shape" title="Oval and round hoops: the stitchable area is the ellipse inside width × height">
      <div className="seg mt-shape">
        <button className={shape === "rect" ? "on" : ""} onClick={() => set("rect")} title="Rectangle">
          <Square size={12} /> Rectangle
        </button>
        <button className={shape === "oval" ? "on" : ""} onClick={() => set("oval")} title="Oval (round when width = height)">
          <Circle size={12} /> {Math.abs(hoop.width - hoop.height) < 0.01 ? "Round" : "Oval"}
        </button>
      </div>
    </Row>
  );
}

/** Fabric preset, thread weight and the stabiliser / needle advice for both. */
export function MaterialSection() {
  const doc = useStore((s) => s.doc);
  const commit = useStore((s) => s.commit);
  const fabric = fabricInfo(doc.fabric);
  const weight = threadWeightInfo(doc.options?.threadWeight);
  const setWeight = (w: ThreadWeight) => commit((d) => ({ ...d, options: { ...(d.options ?? defaultDesignOptions()), threadWeight: w } }));
  return (
    <>
      <Row label="Fabric" title="Adjusts pull compensation, density and underlay for every object">
        <select className="select" style={{ width: "100%" }} value={doc.fabric} onChange={(e) => useStore.getState().setFabric(e.target.value as never)}>
          {FABRICS.map((f) => (
            <option key={f.id} value={f.id}>
              {f.label}
            </option>
          ))}
        </select>
      </Row>
      <Row label="Thread" title="Top thread weight — finer thread stitches denser, heavier thread wider (Madeira's density guide)">
        <div className="seg mt-weights">
          {THREAD_WEIGHTS.map((t) => (
            <button key={t.weight} className={weight.weight === t.weight ? "on" : ""} title={`${t.label}: ${t.spacing.toFixed(2)} mm satin spacing, needle ${t.needle}`} onClick={() => setWeight(t.weight)}>
              {t.weight}
            </button>
          ))}
        </div>
      </Row>
      <div className="mt-card">
        <p className="mt-effect">
          <Fabric size={12} /> {fabric.effect}
          {weight.weight !== 40 && ` · spacing ×${(weight.spacing / 0.4).toFixed(2)} for No. ${weight.weight}`}
        </p>
        <dl className="mt-advice">
          <dt>Backing</dt>
          <dd>{fabric.backing}</dd>
          <dt>Topping</dt>
          <dd>{fabric.topping}</dd>
          <dt>Needle</dt>
          <dd>
            {fabric.needle}
            {weight.weight !== 40 && <span className="mt-sub"> · No. {weight.weight} thread: {weight.needle}</span>}
          </dd>
          <dt>Smallest text</dt>
          <dd title={weight.minTextSource}>
            {weight.minText} mm cap height
            {doc.fabric === "cap" && weight.weight === 40 && <span className="mt-sub"> · 6.4 mm on caps</span>}
          </dd>
        </dl>
        {fabric.confidence !== "agreed" && (
          <p className={`mt-note ${fabric.confidence}`}>
            <TriangleAlert size={12} /> {fabric.note}
          </p>
        )}
      </div>
      {PILE.includes(doc.fabric) && <KnockdownSuggestion />}
    </>
  );
}

/** Pile fabrics: offer the knockdown that keeps the embroidery on top of the loops. */
function KnockdownSuggestion() {
  const on = useStore((s) => !!s.doc.options?.knockdown);
  const fabricColor = useStore((s) => s.fabricColor);
  const commit = useStore((s) => s.commit);
  const turnOn = () =>
    commit((d) => ({ ...d, options: { ...(d.options ?? defaultDesignOptions()), knockdown: true, knockdownColor: d.options?.knockdownColor || fabricColor } }));
  return (
    <div className={`mt-suggest ${on ? "done" : ""}`}>
      <Knockdown size={12} />
      {on ? (
        <span>Knockdown is on — the net flattens the pile first (Stitch processing).</span>
      ) : (
        <>
          <span>Pile fabric: a knockdown net sewn first keeps the embroidery from sinking into the loops.</span>
          <button className="btn sm primary" onClick={turnOn}>
            Add knockdown
          </button>
        </>
      )}
    </div>
  );
}
