// Cross stitch for shapes (Ink/Stitch cross-stitch assistant): fill shapes
// get cross stitch settings and can be snapped to the grid, and the canvas
// grid goes on the cells. Pictures become cross stitch in the digitizer
// (Cross stitch output), which shares the colour work of every other style.

import { ImageUp } from "lucide-react";
import { useState } from "react";
import { crossParams, gridOver, pixelate, ringsToPaths } from "../lib/crossStitch";
import { openDigitizer } from "../lib/actions";
import { flatten, objectBounds, unionBoxes } from "../lib/geometry";
import { useStore } from "../store";
import type { CrossKind, DesignObject, FillParams } from "../types";
import { Dialog, Num, Row, Slider, Toggle } from "./ui";

export const CROSS_KINDS: [CrossKind, string, string][] = [
  ["cross", "×", "Both diagonals"],
  ["half", "/", "Half cross"],
  ["upright", "+", "Upright cross"],
  ["double", "✳", "Double cross"],
  ["smyrna", "⁜", "Smyrna cross"],
];

export function CrossStitchDialog({ onClose }: { onClose: () => void }) {
  const doc = useStore((s) => s.doc);
  const selection = useStore((s) => s.selection);
  const fills = doc.objects.filter((o) => selection.includes(o.id) && o.stitch.type === "fill" && o.paths.some((p) => p.closed));
  const [sx, setSx] = useState(2.5);
  const [sy, setSy] = useState(2.5);
  const [square, setSquare] = useState(true);
  const [kind, setKind] = useState<CrossKind>("cross");
  const [coverage, setCoverage] = useState(0.5);
  const [pixel, setPixel] = useState(true);
  const [noOverlap, setNoOverlap] = useState(true);
  const [grid, setGrid] = useState(true);
  const cellY = square ? sx : sy;
  const params: Partial<FillParams> = crossParams(sx, cellY, kind, coverage);

  const apply = () => {
    const s = useStore.getState();
    const ids = fills.map((o) => o.id);
    if (!pixel) {
      s.commit((d) => ({ ...d, objects: d.objects.map((o) => (ids.includes(o.id) && o.stitch.type === "fill" ? { ...o, stitch: { ...o.stitch, ...params } } : o)) }));
    } else {
      const b = unionBoxes(fills.map(objectBounds));
      if (!b) return;
      const g = gridOver(b.x, b.y, b.w, b.h, sx, cellY);
      const shapes = fills.map((o) => ({ rings: o.paths.filter((p) => p.closed).map((p) => flatten(p, 12)) }));
      const cut = pixelate(shapes, g, coverage, noOverlap);
      s.commit((d) => ({
        ...d,
        objects: d.objects
          .map((o) => {
            const k = ids.indexOf(o.id);
            if (k < 0 || o.stitch.type !== "fill") return o;
            return cut[k].length ? { ...o, paths: ringsToPaths(cut[k]), stitch: { ...o.stitch, ...params } } : null;
          })
          .filter((o): o is DesignObject => !!o),
      }));
    }
    if (grid) s.set({ showGrid: true, gridStep: sx });
    s.toast(`${fills.length} shape${fills.length === 1 ? "" : "s"} set as cross stitch${pixel ? ", snapped to the grid" : ""}`);
    onClose();
  };

  return (
    <Dialog
      title="Cross stitch shapes"
      onClose={onClose}
      footer={
        <>
          <button
            className="btn ghost"
            title="Pictures become cross stitch in the digitizer"
            onClick={() => {
              onClose();
              openDigitizer("cross");
            }}
          >
            <ImageUp size={14} /> From a picture…
          </button>
          <div className="spacer" />
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!fills.length} onClick={apply}>
            Make cross stitch
          </button>
        </>
      }
    >
      {!fills.length && <p className="hint">Select fill shapes to stitch as crosses — or make cross stitch from a picture in the digitizer.</p>}
      <Row label="Cell" title="Size of one cross (Ink/Stitch pattern size)">
        <span className="dz-inline">
          <Num value={sx} step={0.1} min={0.8} max={12} unit="mm" onChange={setSx} />
          {!square && <Num value={sy} step={0.1} min={0.8} max={12} unit="mm" onChange={setSy} />}
          <Toggle on={square} onChange={setSquare} title="Square cells" />
        </span>
      </Row>
      <Row label="Stitches">
        <div className="seg">
          {CROSS_KINDS.map(([k, l, t]) => (
            <button key={k} title={t} className={kind === k ? "on" : ""} onClick={() => setKind(k)}>
              {l}
            </button>
          ))}
        </div>
      </Row>
      <Row label="Coverage" title="How much of a cell must be inside a shape to get a cross">
        <Slider min={10} max={100} step={5} digits={0} unit="%" value={Math.round(coverage * 100)} onChange={(v) => setCoverage(v / 100)} />
      </Row>
      <Row label="Snap to grid" title="Replace the outlines by the grid cells they cover — what will be sewn, editable as shapes (Ink/Stitch pixelize)">
        <Toggle on={pixel} onChange={setPixel} />
      </Row>
      {pixel && (
        <Row label="No overlaps" title="A cell covered by several shapes goes to the one in front">
          <Toggle on={noOverlap} onChange={setNoOverlap} />
        </Row>
      )}
      <Row label="Grid on the cells" title="Show the canvas grid at the cell size">
        <Toggle on={grid} onChange={setGrid} />
      </Row>
    </Dialog>
  );
}
