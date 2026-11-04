// The Tartan section of a tartan fill: the stripes of its sett (colour,
// width, sewn or left out), a live swatch, and how the pattern lies and is
// sewn. Every change keeps the colour layers in step (lib/tartan).

import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { parsePalette, paletteCode, swatchCss, syncTartan, tartanColors, type TartanStripe } from "../lib/tartan";
import { useStore } from "../store";
import type { TartanParams } from "../types";
import { Num, Row, Section, Slider, Toggle } from "./ui";

export function TartanSection({ t }: { t: TartanParams }) {
  const set = (patch: Partial<TartanParams>) => {
    const { layer: _l, group, ...rest } = { ...t, ...patch };
    void _l;
    useStore.getState().commit((d) => syncTartan(d, group, rest));
  };
  const { warp, weft, symmetric, equal } = parsePalette(t.palette);
  const [side, setSide] = useState<"warp" | "weft">("warp");
  const stripes = side === "weft" && !equal ? weft : warp;
  const setStripes = (next: TartanStripe[], sym = symmetric) =>
    set({ palette: equal ? paletteCode(next, sym) : side === "warp" ? paletteCode(next, sym, weft) : paletteCode(warp, sym, next) });
  const colours = tartanColors(t.palette);
  return (
    <Section title="Tartan">
      <div className="tartan-swatch" style={{ background: swatchCss(t.palette), height: 46, borderRadius: 6, border: "1px solid var(--border)", marginBottom: 8, transform: `rotate(${t.rotate}deg)` }} title="The sett: warp stripes across, weft stripes down" />
      <p className="hint" style={{ margin: "0 0 6px" }}>
        {colours.length} thread colour{colours.length === 1 ? "" : "s"}, each sewn as its own layer.
      </p>
      {!equal && (
        <div className="seg" style={{ marginBottom: 6 }}>
          <button className={side === "warp" ? "on" : ""} onClick={() => setSide("warp")}>
            Warp
          </button>
          <button className={side === "weft" ? "on" : ""} onClick={() => setSide("weft")}>
            Weft
          </button>
        </div>
      )}
      <div className="tartan-stripes">
        {stripes.map((s, i) => (
          <div key={i} className="dz-inline" style={{ marginBottom: 4 }}>
            <input type="color" value={s.color} title="Stripe colour" onChange={(e) => setStripes(stripes.map((x, k) => (k === i ? { ...x, color: e.target.value } : x)))} />
            <Num value={s.width} step={0.1} min={0.1} max={50} unit="mm" onChange={(v) => setStripes(stripes.map((x, k) => (k === i ? { ...x, width: v } : x)))} />
            <select className="select" value={s.render} title="Sewn, left out (the fabric shows), or in the colour before it" onChange={(e) => setStripes(stripes.map((x, k) => (k === i ? { ...x, render: Number(e.target.value) as 0 | 1 | 2 } : x)))}>
              <option value={1}>Sewn</option>
              <option value={0}>Left out</option>
              <option value={2}>As before</option>
            </select>
            <button className="icon-btn" title="Remove the stripe" disabled={stripes.length <= 1} onClick={() => setStripes(stripes.filter((_, k) => k !== i))}>
              <Trash2 size={13} />
            </button>
          </div>
        ))}
        <button className="btn sm ghost" onClick={() => setStripes([...stripes, { color: stripes[stripes.length - 1]?.color ?? "#000000", width: 2, render: 1 }])}>
          <Plus size={12} /> Stripe
        </button>
      </div>
      <Row label="Mirrored" title="A symmetric sett: the stripes reflect at the first and the last one (the usual tartan)">
        <Toggle on={symmetric} onChange={(v) => setStripes(stripes, v)} />
      </Row>
      <Row label="Warp ≠ weft" title="Different stripes across and down">
        <Toggle on={!equal} onChange={(v) => set({ palette: v ? paletteCode(warp, symmetric, warp) : paletteCode(warp, symmetric) })} />
      </Row>
      <Row label="Size" title="Scale of the whole pattern">
        <Slider min={25} max={400} step={5} digits={0} unit="%" value={t.scale} onChange={(v) => set({ scale: v })} />
      </Row>
      <Row label="Turn" title="Rotation of the pattern">
        <Slider min={-90} max={90} step={1} digits={0} unit="°" value={t.rotate} onChange={(v) => set({ rotate: v })} />
      </Row>
      <Section title="Weave" defaultOpen={false}>
        <Row label="Twill angle" title="Angle of the rows to the stripes (Ink/Stitch tartan angle; -45° is a twill)">
          <Slider min={-90} max={90} step={5} digits={0} unit="°" value={t.angle} onChange={(v) => set({ angle: v })} />
        </Row>
        <Row label="Rows / thread" title="Rows of one direction before warp and weft change over">
          <Num value={t.rowsPerThread} step={1} min={1} max={8} digits={0} onChange={(v) => set({ rowsPerThread: Math.round(v) })} />
        </Row>
        <Row label="Herringbone" title="The twill turns every this many mm (0 = a plain twill)">
          <Num value={t.herringbone} step={0.5} min={0} max={30} unit="mm" onChange={(v) => set({ herringbone: v })} />
        </Row>
        <Row label="Lines below" title="Stripes this narrow or narrower are sewn as running-stitch lines">
          <Num value={t.minStripeWidth} step={0.1} min={0} max={5} unit="mm" onChange={(v) => set({ minStripeWidth: v })} />
        </Row>
        <Row label="Offset" title="Shift the stripes across and down (mm)">
          <span className="dz-inline">
            <Num value={t.offset[0]} step={0.5} unit="x" onChange={(v) => set({ offset: [v, t.offset[1]] })} />
            <Num value={t.offset[1]} step={0.5} unit="y" onChange={(v) => set({ offset: [t.offset[0], v] })} />
          </span>
        </Row>
        <Row label="Code" title="Ink/Stitch palette code — paste one from Ink/Stitch's tartan editor">
          <input className="input" style={{ width: "100%", fontSize: 11 }} defaultValue={t.palette} key={t.palette} onBlur={(e) => e.target.value.trim() && e.target.value !== t.palette && set({ palette: e.target.value.trim() })} />
        </Row>
      </Section>
    </Section>
  );
}
