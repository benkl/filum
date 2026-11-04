// How the fabric looks on the canvas (a view setting, not part of the
// design): its colour, its texture — the design's fabric or another weave —
// whether the weave stays visible when zoomed out, and whether the vector and
// stitch views show it too. Used by the Scene panel and Preferences.

import { fabricInfo } from "../lib/materials";
import { useStore } from "../store";
import type { Fabric } from "../types";
import { Row, Toggle } from "./ui";

/** Fabric colours to pick at a glance. */
const SWATCHES: [string, string][] = [
  ["#f4f1ea", "Natural"],
  ["#ffffff", "White"],
  ["#d6d4cf", "Light grey"],
  ["#5b5f66", "Charcoal"],
  ["#1d1d1f", "Black"],
  ["#1f2a44", "Navy"],
  ["#7a1f27", "Burgundy"],
  ["#2f4a35", "Forest"],
];

/** Textures (the realistic view's weaves, by the fabric that has them). */
const TEXTURES: [Fabric | "none", string][] = [
  ["cotton", "Plain weave"],
  ["silk", "Fine weave"],
  ["canvas", "Canvas"],
  ["sheer", "Organza"],
  ["denim", "Twill"],
  ["knit", "Jersey"],
  ["pique", "Piqué"],
  ["fleece", "Fleece"],
  ["felt", "Felt"],
  ["towel", "Terry"],
  ["leather", "Leather"],
  ["none", "None (plain colour)"],
];

export function FabricLookRows() {
  const color = useStore((s) => s.fabricColor);
  const texture = useStore((s) => s.fabricTexture);
  const all = useStore((s) => s.fabricAll);
  const weave = useStore((s) => s.fabricWeave);
  const fabric = useStore((s) => s.doc.fabric);
  const set = useStore((s) => s.set);
  return (
    <>
      <Row label="Fabric colour" title="The fabric on the canvas (only the view — not exported)">
        <span className="fl-swatches">
          {SWATCHES.map(([hex, name]) => (
            <button
              key={hex}
              className={`fl-swatch ${color.toLowerCase() === hex ? "on" : ""}`}
              style={{ background: hex }}
              title={name}
              aria-label={name}
              onClick={() => set({ fabricColor: hex })}
            />
          ))}
          <input type="color" className="fl-custom" value={color} onChange={(e) => set({ fabricColor: e.target.value })} title="Any colour" aria-label="Custom fabric colour" />
        </span>
      </Row>
      <Row label="Texture" title="The weave in the realistic view">
        <select className="select" style={{ width: "100%" }} value={texture} onChange={(e) => set({ fabricTexture: e.target.value as typeof texture })}>
          <option value="auto">Auto — {fabricInfo(fabric).label}</option>
          {TEXTURES.map(([id, label]) => (
            <option key={id} value={id}>
              {label}
            </option>
          ))}
        </select>
      </Row>
      <Row label="Visible weave" title="Draw the weave coarse enough to see when zoomed out (off: true thread size, visible only close up)">
        <Toggle on={weave} onChange={(v) => set({ fabricWeave: v })} />
      </Row>
      <Row label="In every view" title="Show the fabric colour in the vector and stitch views too">
        <Toggle on={all} onChange={(v) => set({ fabricAll: v })} />
      </Row>
    </>
  );
}
