// Satin direction guides: the actions shared by the Properties panel and the
// stitch direction tool's context bar.

import { Sparkles, Trash2 } from "lucide-react";
import { StitchAngle } from "../icons/stitch";
import { autoGuides, guidesOf, selectedSatin, setGuides } from "../lib/satinGuides";
import { useStore } from "../store";

export function GuideActions({ compact = false }: { compact?: boolean }) {
  // re-render with the document
  useStore((s) => s.doc);
  const tool = useStore((s) => s.tool);
  const o = selectedSatin();
  if (!o) return <span className="stat">{compact ? "Choose a satin column" : ""}</span>;
  const n = guidesOf(o).length;
  const auto = () => {
    const g = autoGuides(o);
    if (!g.length) useStore.getState().toast("No sharp corners on this column");
    else setGuides(o.id, g);
  };
  return (
    <div className="guide-actions">
      <span className="stat">{n ? `${n} guide${n > 1 ? "s" : ""}` : "Across"}</span>
      {!compact && tool !== "guides" && (
        <button className="btn sm" title="Edit the guides on the canvas (D)" onClick={() => useStore.getState().setTool("guides")}>
          <StitchAngle size={12} /> Edit
        </button>
      )}
      <button className="btn sm ghost" title="Guides along the mitre of every corner sharper than 30°: the stitches fan evenly round it" onClick={auto}>
        <Sparkles size={12} /> Corners
      </button>
      {n > 0 && (
        <button className="btn sm ghost" title="Remove all guides: stitches straight across the column again" onClick={() => setGuides(o.id, [])}>
          <Trash2 size={12} />
        </button>
      )}
    </div>
  );
}
