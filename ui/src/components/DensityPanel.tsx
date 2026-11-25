// The density map's legend: what the colours mean on this fabric, how much
// of the design is thin / normal / heavy / too dense, a readout under the
// pointer, and the places that are too dense, one after the other.

import { useState, useSyncExternalStore } from "react";
import { AlertTriangle, Check, ChevronRight } from "lucide-react";
import { classShares, CLASS_LABELS, colorAt, DENSITY_MODES, densityAt, densityHover, densityScale, THIN_BLUE } from "../lib/density";
import { defaultDesignOptions } from "../lib/geometry";
import { fabricInfo } from "../lib/materials";
import { fillsStackAt } from "../lib/denseIssues";
import { useStore } from "../store";
import { focus } from "../lib/focus";

const pct = (v: number) => (v > 0 && v < 0.005 ? "<1" : Math.round(v * 100).toString());

export function DensityLegend() {
  const on = useStore((s) => s.showDensity);
  const f = useStore((s) => s.density);
  const mode = useStore((s) => s.densityMode);
  const fabric = useStore((s) => s.doc.fabric);
  const objects = useStore((s) => s.doc.objects);
  const removeOverlaps = useStore((s) => !!s.doc.options?.removeOverlaps);
  const set = useStore((s) => s.set);
  const hover = useSyncExternalStore(densityHover.subscribe, densityHover.get);
  const [hot, setHot] = useState(-1);
  if (!on) return null;
  const scale = densityScale(mode, f?.limits ?? null);
  // the bar: the scale's colours, a little stronger than on the canvas
  const steps = 24;
  const grad = Array.from({ length: steps + 1 }, (_, k) => {
    const c = colorAt(scale, (scale.max * k) / steps);
    return `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${Math.min(1, c[3] * 1.35 + 0.08).toFixed(2)}) ${((k / steps) * 100).toFixed(1)}%`;
  }).join(",");
  const read = hover ? densityAt(f, hover) : null;
  const shares = f ? classShares(f.stats) : null;
  const spots = f?.hotspots ?? [];
  const fab = fabricInfo(fabric);
  // fills stacked on fills (not just meeting at their edges): Remove hidden stitching takes the layers out
  const stacked = !removeOverlaps && spots.some((h) => fillsStackAt(h.objects.map((i) => objects[i]).filter((o) => !!o), h));

  const showHot = (k: number) => {
    const h = spots[k];
    if (!h) return;
    setHot(k);
    const objs = useStore.getState().doc.objects;
    focus({ ids: h.objects.map((i) => objs[i]?.id).filter((x): x is string => !!x), box: h, minSize: 16 });
  };

  return (
    <div className="density-legend" role="region" aria-label="Density map">
      <div className="dmap-head">
        <b>Density</b>
        <span className="stat" title={`Limits for ${fab.label.toLowerCase()} — change the fabric in Design ▸ Fabric & thread`}>
          on {fab.label.toLowerCase()}
        </span>
        <button className="mini-x" onClick={() => set({ showDensity: false })} aria-label="Hide density map" title="Hide (Shift+D)">
          ×
        </button>
      </div>
      <div className="seg dmap-modes">
        {DENSITY_MODES.map((m) => (
          <button key={m.id} className={mode === m.id ? "on" : ""} title={m.title} onClick={() => set({ densityMode: m.id })}>
            {m.label}
          </button>
        ))}
      </div>
      <div className="dmap-scale">
        {mode === "coverage" && (
          <span className="dmap-thin" title="A fill or satin so open the fabric shows through">
            <i style={{ background: `rgb(${THIN_BLUE.join(",")})` }} /> thin
          </span>
        )}
        <div className="dmap-bar" style={{ background: `linear-gradient(90deg, ${grad})` }}>
          {scale.ticks.map((t) => (
            <span key={t.label} className="dmap-tick" style={{ left: `${(t.v / scale.max) * 100}%` }}>
              {t.label}
            </span>
          ))}
        </div>
        <span className="stat dmap-unit">{scale.unit}</span>
      </div>
      {shares && f!.stats.area > 0 ? (
        <div className="dmap-shares" title="Share of the stitched area">
          <div className="dmap-stack">
            {mode === "coverage" && <i className="c-thin" style={{ width: `${shares.thin * 100}%` }} />}
            <i className="c-ok" style={{ width: `${(shares.ok + (mode === "coverage" ? 0 : shares.thin)) * 100}%` }} />
            <i className="c-heavy" style={{ width: `${shares.heavy * 100}%` }} />
            <i className="c-risk" style={{ width: `${shares.risk * 100}%` }} />
          </div>
          <span className="stat">
            {shares.thin > 0.005 && <>{pct(shares.thin)}% thin · </>}
            {pct(shares.ok)}% ok · {pct(shares.heavy)}% heavy · <b className={shares.risk > 0 ? "lvl-error" : ""}>{pct(shares.risk)}% too dense</b>
          </span>
        </div>
      ) : (
        <span className="stat">{f ? "No stitches" : "Measuring…"}</span>
      )}
      <div className="dmap-read">
        {read ? (
          <>
            <span title="Layers of thread (1 = just covered)">
              <b>{read.layers.toFixed(1)}</b> layers
            </span>
            <span title="Needle holes per mm²">
              <b>{read.holes.toFixed(0)}</b> holes/mm²
            </span>
            <span title={`Thread added to the fabric (top + bobbin); the fabric weighs about ${f?.limits?.gsm ?? "?"} g/m²`}>
              +<b>{read.added.toFixed(0)}</b> g/m²
            </span>
            <span className={`dmap-cls k${read.cls}`}>{CLASS_LABELS[read.cls]}</span>
          </>
        ) : f && f.stats.area > 0 ? (
          <span className="stat">
            Peak {f.stats.maxLayers.toFixed(1)} layers · {f.stats.maxHoles.toFixed(0)} holes/mm² · +{f.stats.meanAdded.toFixed(0)} g/m² on average
          </span>
        ) : null}
      </div>
      {f && f.stats.area > 0 && (
        <div className={`dmap-hot ${spots.length ? "bad" : "good"}`}>
          {spots.length ? (
            <>
              <AlertTriangle size={13} />
              <span>
                {spots.length} place{spots.length === 1 ? "" : "s"} too dense for {fab.label.toLowerCase()}
                {hot >= 0 && spots[hot] && (
                  <span className="stat">
                    {" "}
                    · {hot + 1}/{spots.length}: {spots[hot].objects.map((i) => objects[i]?.name).filter(Boolean).slice(0, 3).join(", ")}
                  </span>
                )}
              </span>
              {stacked && (
                <button
                  className="btn sm primary"
                  title="Fills stack on top of each other here: leave out what lies hidden under the objects on top (Stitch ▸ Remove hidden stitching)"
                  onClick={() => useStore.getState().commit((d) => ({ ...d, options: { ...(d.options ?? defaultDesignOptions()), removeOverlaps: true } }))}
                >
                  Remove hidden
                </button>
              )}
              <button className="btn sm" onClick={() => showHot((hot + 1) % spots.length)} title="Zoom to the next place and select what stitches there">
                {hot < 0 ? "Show" : "Next"} <ChevronRight size={12} />
              </button>
            </>
          ) : (
            <>
              <Check size={13} />
              <span>Nothing beyond what {fab.label.toLowerCase()} takes</span>
            </>
          )}
        </div>
      )}
    </div>
  );
}
