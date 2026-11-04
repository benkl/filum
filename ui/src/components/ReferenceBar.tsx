// Floating bar while a reference picture is adjusted on the canvas: opacity,
// behind / over the stitches, grey, mirror, size, fit, lock, digitize, delete.

import { Check, FlipHorizontal2, Lock, Maximize, RotateCcw, Trash2 } from "lucide-react";
import { Digitize } from "../icons/stitch";
import { pending } from "../lib/actions";
import { fitReferenceToHoop, referenceBytes, removeReference, updateReference } from "../lib/references";
import { useStore } from "../store";
import { Grip, Num, useMovable } from "./ui";

export function ReferenceBar({ id }: { id: string }) {
  const r = useStore((s) => s.doc.references?.find((x) => x.id === id));
  const mv = useMovable("refbar");
  if (!r) return null;
  const set = (patch: Parameters<typeof updateReference>[1]) => updateReference(id, patch);
  const done = () => useStore.getState().set({ refEdit: null });
  // live while dragging the slider, one undo step at the end
  const opacityLive = (v: number) => updateReference(id, { opacity: v / 100 }, true);
  const aspect = r.width / r.height;
  return (
    <div className="ref-bar" onPointerDown={(e) => e.stopPropagation()} style={{ transform: mv.moved ? `translate(${mv.off[0]}px, ${mv.off[1]}px)` : undefined }} data-movable>
      <Grip grip={mv.grip} vertical />
      <span className="ref-name" title={r.name}>
        {r.name}
      </span>
      <label className="ref-field" title="Opacity">
        <input
          type="range"
          min={5}
          max={100}
          step={1}
          value={Math.round(r.opacity * 100)}
          onPointerDown={() => useStore.getState().checkpoint()}
          onChange={(e) => opacityLive(+e.target.value)}
        />
        <span className="stat">{Math.round(r.opacity * 100)} %</span>
      </label>
      <div className="seg" role="group" aria-label="Placement">
        <button className={r.placement === "behind" ? "on" : ""} onClick={() => set({ placement: "behind" })} title="Behind the stitches">
          Behind
        </button>
        <button className={r.placement === "over" ? "on" : ""} onClick={() => set({ placement: "over" })} title="Over the stitches, like tracing paper">
          Over
        </button>
      </div>
      <button className={`icon-btn ${r.grayscale ? "on" : ""}`} onClick={() => set({ grayscale: !r.grayscale })} title="Grey: thread colours stand out against it">
        <span className="ref-grey" />
      </button>
      <button className={`icon-btn ${r.flip ? "on" : ""}`} onClick={() => set({ flip: !r.flip })} title="Mirror">
        <FlipHorizontal2 size={15} />
      </button>
      <div className="vsep" />
      <label className="ref-field" title="Width (keeps the proportions)">
        W
        <Num
          value={r.width}
          unit="mm"
          step={1}
          min={1}
          digits={1}
          onChange={(w) => set({ width: w, height: w / aspect, x: r.x + (r.width - w) / 2, y: r.y + (r.height - w / aspect) / 2 })}
        />
      </label>
      <label className="ref-field" title="Height (keeps the proportions)">
        H
        <Num
          value={r.height}
          unit="mm"
          step={1}
          min={1}
          digits={1}
          onChange={(h) => set({ height: h, width: h * aspect, x: r.x + (r.width - h * aspect) / 2, y: r.y + (r.height - h) / 2 })}
        />
      </label>
      <button className="icon-btn" onClick={() => fitReferenceToHoop(id)} title="Fit the hoop">
        <Maximize size={15} />
      </button>
      <button className="icon-btn" onClick={() => set({ rotation: 0 })} disabled={!r.rotation} title={`Straighten (${r.rotation}°)`}>
        <RotateCcw size={15} />
      </button>
      <div className="vsep" />
      <button
        className="icon-btn"
        title="Auto-digitize this picture"
        onClick={async () => {
          pending.image = await referenceBytes(r);
          useStore.getState().set({ refEdit: null });
          useStore.getState().setDialog("digitize");
        }}
      >
        <Digitize size={15} />
      </button>
      <button
        className="icon-btn"
        title="Lock: the picture stays put (unlock it in Layers ▸ References)"
        onClick={() => {
          set({ locked: true });
          done();
        }}
      >
        <Lock size={15} />
      </button>
      <button className="icon-btn" title="Remove the picture (Del)" onClick={() => removeReference(id)}>
        <Trash2 size={15} />
      </button>
      <button className="btn sm primary" onClick={done} title="Done (Enter)">
        <Check size={14} /> Done
      </button>
    </div>
  );
}
