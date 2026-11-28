// Calibrate the screen: stretch the ruler on screen until it matches a real
// ruler (or a bank card) held against the glass, or type what a ruler reads
// along it. Then 1× on the canvas is the size the design is sewn at.

import { RotateCcw } from "lucide-react";
import { useState } from "react";
import { CARD_WIDTH_MM, CSS_PX_PER_MM, calibrationFrom, dpiOf, pxPerMm, validCalibration } from "../lib/screen";
import { useStore } from "../store";
import { Dialog, Num } from "./ui";

/** The ruler on screen is this long (mm at the scale being tried). */
const RULER_MM = 100;
/** The stretch slider's range around 96 dpi (CSS px per mm). */
const MIN_PX = 2;
const MAX_PX = 8;
/** Room for the first and last label (CSS px). */
const PAD = 16;

export function ScreenDialog({ onClose }: { onClose: () => void }) {
  const saved = useStore((s) => s.prefs.screenPxPerMm);
  const [px, setPx] = useState(() => pxPerMm(saved));
  const width = RULER_MM * px;
  const fitsWindow = width + 80 < window.innerWidth;

  const save = () => {
    const v = calibrationFrom(width, RULER_MM);
    if (!validCalibration(v)) return;
    useStore.getState().setPrefs({ screenPxPerMm: v });
    useStore.getState().toast(`Screen calibrated: ${dpiOf(px)} dpi. 1× is now actual size.`, "success");
    window.dispatchEvent(new CustomEvent("filum:fit", { detail: 1 }));
    onClose();
  };
  const reset = () => {
    useStore.getState().setPrefs({ screenPxPerMm: undefined });
    setPx(CSS_PX_PER_MM);
  };

  // tick marks: every mm, longer every 5 and 10
  const ticks = [];
  for (let k = 0; k <= RULER_MM; k++) {
    const h = k % 10 === 0 ? 18 : k % 5 === 0 ? 12 : 7;
    ticks.push(<line key={k} x1={k * px} x2={k * px} y1={0} y2={h} />);
    if (k % 10 === 0)
      ticks.push(
        <text key={`t${k}`} x={k * px} y={30}>
          {k === RULER_MM ? `${k / 10} cm` : k / 10}
        </text>,
      );
  }

  return (
    <Dialog
      wide
      title="Calibrate the screen"
      onClose={onClose}
      footer={
        <>
          {validCalibration(saved) && (
            <button className="btn ghost" onClick={reset} title="Go back to the 96 dpi browsers assume">
              <RotateCcw size={14} /> Forget the calibration
            </button>
          )}
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={save}>
            Save
          </button>
        </>
      }
    >
      <div className="screen-cal">
        <p>Hold a ruler against the screen and stretch the ruler below until its centimetres match. A bank card works too: it is {CARD_WIDTH_MM} mm wide.</p>
        <div className="screen-cal-ruler" style={{ width: fitsWindow ? width + 2 * PAD : undefined }}>
          <svg width={width + 2 * PAD} height={36} aria-label="Ruler, 10 cm">
            <g transform={`translate(${PAD},0)`}>{ticks}</g>
          </svg>
          <div className="screen-cal-card" style={{ width: CARD_WIDTH_MM * px, height: 53.98 * px, marginLeft: PAD }} title="A bank card at this scale">
            <span>Bank card</span>
          </div>
        </div>
        <label className="screen-cal-stretch">
          <span>Stretch</span>
          <input type="range" min={MIN_PX} max={MAX_PX} step={0.005} value={px} onChange={(e) => setPx(Number(e.target.value))} />
          <button className="btn sm ghost" onClick={() => setPx((v) => Math.max(MIN_PX, v - 0.005))} title="A little shorter">
            −
          </button>
          <button className="btn sm ghost" onClick={() => setPx((v) => Math.min(MAX_PX, v + 0.005))} title="A little longer">
            +
          </button>
        </label>
        <div className="screen-cal-measure">
          <span>Or measure it: the ruler above is</span>
          <Num
            value={RULER_MM}
            unit="mm"
            step={0.5}
            min={20}
            max={400}
            onChange={(v) => {
              // it measured v mm: a mm is (v / 100) of what was tried
              if (!(v > 0)) return;
              setPx((p) => Math.min(MAX_PX, Math.max(MIN_PX, (p * RULER_MM) / v)));
            }}
          />
          <span>long on my ruler</span>
        </div>
        <p className="hint">
          {dpiOf(px)} dpi{validCalibration(saved) ? ` · saved: ${dpiOf(pxPerMm(saved))} dpi` : " · not calibrated yet: Filum assumes 96 dpi, like the browser"}.
          Kept for this computer; calibrate again after changing the screen.
        </p>
      </div>
    </Dialog>
  );
}
