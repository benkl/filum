// Multicolour satin: split the selected satin into colour stripes across its
// width (Ink/Stitch "Satin multicolor"), from its Properties section.

import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { splitSatin, type Stripe } from "../lib/multicolorSatin";
import { useStore } from "../store";
import type { DesignObject } from "../types";
import { ThreadPicker } from "./ThreadPicker";
import { Num, Row } from "./ui";

export function MulticolorSatin({ o }: { o: DesignObject }) {
  const threads = useStore((s) => s.doc.threads);
  const other = threads.find((t) => t.id !== o.thread)?.id ?? o.thread;
  const [stripes, setStripes] = useState<Stripe[]>([
    { thread: o.thread, width: 1 },
    { thread: other, width: 1 },
  ]);
  const [overlap, setOverlap] = useState(0.2);
  const set = (i: number, p: Partial<Stripe>) => setStripes(stripes.map((s, k) => (k === i ? { ...s, ...p } : s)));
  const split = () => {
    const parts = splitSatin(o, stripes, overlap);
    if (!parts) return;
    const s = useStore.getState();
    s.commit((d) => {
      const i = d.objects.findIndex((x) => x.id === o.id);
      const objects = [...d.objects];
      objects.splice(i, 1, ...parts);
      return { ...d, objects };
    });
    s.select(parts.map((p) => p.id));
    s.toast(`Split into ${parts.length} stripes`);
  };
  return (
    <div className="mc-satin">
      {stripes.map((st, i) => (
        <div key={i} className="mc-stripe">
          <span className="stat">{i + 1}</span>
          <ThreadPicker value={st.thread} onPick={(t) => set(i, { thread: t })} />
          <Num value={st.width} step={0.5} min={0.1} max={10} digits={1} unit="×" onChange={(v) => set(i, { width: v })} />
          {stripes.length > 2 && (
            <button className="btn sm ghost" title="Remove this stripe" onClick={() => setStripes(stripes.filter((_, k) => k !== i))}>
              <Trash2 size={12} />
            </button>
          )}
        </div>
      ))}
      <div className="mc-actions">
        <button className="btn sm ghost" onClick={() => setStripes([...stripes, { thread: threads[(stripes.length + 1) % Math.max(1, threads.length)]?.id ?? o.thread, width: 1 }])}>
          <Plus size={12} /> Stripe
        </button>
        <Row label="Overlap" title="How far each stripe reaches under its neighbour, so no gap opens">
          <Num value={overlap} step={0.1} min={0} max={1.5} unit="mm" onChange={setOverlap} />
        </Row>
        <button className="btn sm primary" onClick={split} title="Replace the column by one satin per stripe (the first keeps the underlay)">
          Split into stripes
        </button>
      </div>
    </div>
  );
}
