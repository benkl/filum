// Satin direction guides: the actions shared by the Properties panel and the
// stitch direction tool's context bar.

import { Sparkles, Trash2 } from "lucide-react";
import { StitchAngle } from "../icons/stitch";
import { autoGuides, selectedSatin, setGuides } from "../lib/satinGuides";
import { clearOrientation, freeSides, orientationLines } from "../lib/satinSides";
import { useStore } from "../store";
import { replaceObject } from "../lib/docEdit";

export function GuideActions({ compact = false }: { compact?: boolean }) {
  // re-render with the document
  useStore((s) => s.doc);
  const tool = useStore((s) => s.tool);
  const o = selectedSatin();
  if (!o) return <span className="stat">{compact ? "Choose a satin column" : ""}</span>;
  const { lines, pairs } = orientationLines(o);
  const n = lines.length;
  const replace = (next: typeof o) => useStore.getState().commit((d) => replaceObject(d, o.id, next));
  const auto = () => {
    const g = autoGuides(o);
    if (!g.length) useStore.getState().toast("No sharp corners on this column");
    else {
      const f = freeSides(o);
      if (f.stitch.type === "satin") replace({ ...f, stitch: { ...f.stitch, guides: g } });
      else setGuides(o.id, g);
    }
  };
  return (
    <div className="guide-actions">
      <span className="stat" title={pairs ? "The point pairs of the two sides set the stitch angle" : undefined}>
        {n ? `${n} ${pairs ? "point pair" : "guide"}${n > 1 ? "s" : ""}` : "Across"}
      </span>
      {!compact && tool !== "guides" && (
        <button className="btn sm" title="Edit the guides on the canvas (D)" onClick={() => useStore.getState().setTool("guides")}>
          <StitchAngle size={12} /> Edit
        </button>
      )}
      <button className="btn sm ghost" title="Guides along the mitre of every corner sharper than 30°: the stitches fan evenly round it" onClick={auto}>
        <Sparkles size={12} /> Corners
      </button>
      {n > 0 && (
        <button
          className="btn sm ghost"
          title="Remove all orientation lines: stitches straight across the column again"
          onClick={() => replace(clearOrientation(o))}
        >
          <Trash2 size={12} />
        </button>
      )}
    </div>
  );
}
