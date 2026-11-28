// A satin in 3D (from the NOVAstitch Designer fork, after the Punch book): sewn
// over a foam sheet (the satin's `foam` block), or raised in layers (its
// `layered` block). The stitches come from the core (stitches/foam.rs,
// stitches/layered3d.rs).

import type { DesignObject, FoamOptions, LayeredOptions, SatinParams } from "../types";
import type { StitchPatch } from "../store";
import { useStore } from "../store";
import { Num, Row, Section, Toggle } from "./ui";

/** Contour passes over foam: 1 by default, 2 at most. */
export const FOAM_MAX_CONTOUR_PASSES = 2;
/** "40–50 % heavier" (Punch), read as density: 0.40 → 0.28 mm. */
export const FOAM_DENSITY_FACTOR = 1.45;
/** Inner layers of a layered 3D: 2 to 4. */
export const LAYERED3D_MIN_LAYERS = 2;
export const LAYERED3D_MAX_LAYERS = 4;
/** Each inner layer this much narrower than the next, both sides together (0.3 mm a side). */
export const LAYERED3D_SHRINK = 0.6;

export const defaultFoam = (): FoamOptions => ({ contourPasses: 1, densityFactor: FOAM_DENSITY_FACTOR, caps: true });
export const defaultLayered = (): LayeredOptions => ({ layers: LAYERED3D_MIN_LAYERS, underlayZigzagSpacing: 3, shrinkPerLayer: LAYERED3D_SHRINK });

type Mode = "none" | "foam" | "layered";
const modeOf = (st: SatinParams): Mode => (st.foam ? "foam" : st.layered ? "layered" : "none");

export function Satin3dSection({ o, st, up }: { o: DesignObject; st: SatinParams; up: (p: StitchPatch) => void }) {
  const threads = useStore((s) => s.doc.threads);
  const mode = modeOf(st);
  const foam = st.foam;
  const layered = st.layered;
  const setFoam = (p: Partial<FoamOptions>) => up({ foam: { ...(foam ?? defaultFoam()), ...p } });
  const setLayered = (p: Partial<LayeredOptions>) => up({ layered: { ...(layered ?? defaultLayered()), ...p } });
  return (
    <Section title="3D" defaultOpen={mode !== "none"}>
      <Row label="Relief" title="Foam: sewn over a foam sheet laid at a stop. Layers: growing inner layers under the column">
        <select
          className="select"
          style={{ width: "100%" }}
          value={mode}
          onChange={(e) => {
            const m = e.target.value as Mode;
            up({ foam: m === "foam" ? (foam ?? defaultFoam()) : undefined, layered: m === "layered" ? (layered ?? defaultLayered()) : undefined });
          }}
        >
          <option value="none">None</option>
          <option value="foam">Over 3D foam</option>
          <option value="layered">Layered</option>
        </select>
      </Row>
      {foam && (
        <>
          <p className="hint">
            The machine stops first so you can lay the foam. No fill underlay: a straight-stitch contour (and a centre walk from 4 mm), a denser satin (
            {+(st.spacing / (foam.densityFactor || FOAM_DENSITY_FACTOR)).toFixed(2)} mm) and caps on the open ends. Sew it last.
          </p>
          <Row label="Contour passes" title="The straight-stitch contour that perforates the foam: 1 pass, 2 at most">
            <Num
              value={foam.contourPasses}
              step={1}
              digits={0}
              min={1}
              max={FOAM_MAX_CONTOUR_PASSES}
              onChange={(v) => setFoam({ contourPasses: Math.min(FOAM_MAX_CONTOUR_PASSES, Math.max(1, Math.round(v))) })}
            />
          </Row>
          <Row label="Denser by" title="The satin's spacing is divided by this over foam (1.45: Punch's 40–50 % heavier; check it at a stitch-out)">
            <Num value={foam.densityFactor} step={0.05} digits={2} min={1} max={2} unit="×" onChange={(v) => setFoam({ densityFactor: v })} />
          </Row>
          <Row label="Caps" title="Short satins across the open ends (T, L, E) on the shape's edge, so the foam doesn't stick out">
            <Toggle on={foam.caps} onChange={(v) => setFoam({ caps: v })} />
          </Row>
        </>
      )}
      {layered && (
        <>
          <p className="hint">
            Inner layers are made from the column by themselves: a core over its underlay, then wider layers, then the column on top. Their edges are staggered,
            so no stitch falls within 0.3 mm of one in the layer below.
          </p>
          <Row label="Inner layers" title="2 to 4 inner layers, plus the column on top">
            <Num
              value={layered.layers}
              step={1}
              digits={0}
              min={LAYERED3D_MIN_LAYERS}
              max={LAYERED3D_MAX_LAYERS}
              onChange={(v) => setLayered({ layers: Math.min(LAYERED3D_MAX_LAYERS, Math.max(LAYERED3D_MIN_LAYERS, Math.round(v))) })}
            />
          </Row>
          <Row label="Core zig-zag" title="Spacing of the core's zig-zag underlay: wider is higher">
            <Num
              value={layered.underlayZigzagSpacing}
              step={0.1}
              digits={1}
              min={0.5}
              max={8}
              unit="mm"
              onChange={(v) => setLayered({ underlayZigzagSpacing: v })}
            />
          </Row>
          <Row label="Step" title="How much narrower each inner layer is than the next, both sides together (at least 0.6 mm to stagger the edges by 0.3 mm)">
            <Num
              value={layered.shrinkPerLayer}
              step={0.1}
              digits={2}
              min={0.6}
              max={3}
              unit="mm"
              onChange={(v) => setLayered({ shrinkPerLayer: Math.max(0.6, v) })}
            />
          </Row>
          <Row
            label="Inner thread"
            title="The thread for the inner layers (under a metallic: polyester below, the metallic only on top). A colour change comes before the top layer"
          >
            <select
              className="select"
              style={{ width: "100%" }}
              value={layered.baseThread ?? ""}
              onChange={(e) => setLayered({ baseThread: e.target.value || undefined })}
            >
              <option value="">The object's own</option>
              {threads
                .filter((t) => t.id !== o.thread)
                .map((t) => (
                  <option key={t.id} value={t.id}>
                    {[t.name, t.brand, t.code].filter(Boolean).join(" · ")}
                  </option>
                ))}
            </select>
          </Row>
        </>
      )}
    </Section>
  );
}
