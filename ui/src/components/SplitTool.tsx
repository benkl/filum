// Split into satins, the tool: pick a fill, drag cut lines across it and
// Alt-drag (or switch to) direction lines; the canvas shows the parts and the
// way each will be sewn; Enter makes the satins (one undo step). The work is
// in lib/splitSatins.

import { Split, Undo2, X } from "lucide-react";
import { applySplit, planSplit, type SplitPlan } from "../lib/splitSatins";
import { EMPTY_SPLIT, useStore, type SplitDraft } from "../store";
import type { DesignObject, StitchDocument, Vec2 } from "../types";
import { Seg } from "./ui";

/** A fill the tool can split. */
export const splittable = (o: DesignObject | undefined | null): o is DesignObject => !!o && !o.locked && !o.text && o.stitch.type === "fill" && o.paths.some((sp) => sp.closed);

/** The plan for the draft (memoised on the document and the draft). */
let memo: { doc: StitchDocument; draft: SplitDraft; plan: SplitPlan | null } | null = null;
export function draftPlan(doc: StitchDocument, draft: SplitDraft): SplitPlan | null {
  if (memo && memo.doc === doc && memo.draft === draft) return memo.plan;
  const plan = draft.id ? planSplit(doc, { id: draft.id, cuts: draft.cuts, directions: draft.directions }) : null;
  memo = { doc, draft, plan };
  return plan;
}

export function setDraft(patch: Partial<SplitDraft>): void {
  const s = useStore.getState();
  s.set({ splitDraft: { ...s.splitDraft, ...patch } });
}

/** Take back the last line drawn; true if there was one. */
export function undoSplitLine(): boolean {
  const d = useStore.getState().splitDraft;
  const last = d.order[d.order.length - 1];
  if (!last) return false;
  const order = d.order.slice(0, -1);
  if (last === "direction") setDraft({ directions: d.directions.slice(0, -1), order });
  else setDraft({ cuts: d.cuts.slice(0, -1), order });
  return true;
}

/** Add a line of the kind given. */
export function addSplitLine(line: [Vec2, Vec2], direction: boolean): void {
  const d = useStore.getState().splitDraft;
  if (direction) setDraft({ directions: [...d.directions, line], order: [...d.order, "direction"] });
  else setDraft({ cuts: [...d.cuts, line], order: [...d.order, "cut"] });
}

/** Clear the lines (then the shape); false when there was nothing to clear. */
export function clearSplit(): boolean {
  const d = useStore.getState().splitDraft;
  if (d.cuts.length || d.directions.length) setDraft({ cuts: [], directions: [], order: [] });
  else if (d.id) setDraft({ id: null });
  else return false;
  return true;
}

/** Make the satins: the shape replaced in its place, the satins selected, back to the Select tool. */
export function applySplitDraft(): void {
  const s = useStore.getState();
  const d = s.splitDraft;
  if (!d.id) return s.toast("Click a fill shape to split first");
  const r = applySplit(s.doc, { id: d.id, cuts: d.cuts, directions: d.directions });
  if (!r) return s.toast("Nothing to split here: the shape has no closed outline", "error");
  s.commit(() => r.doc);
  s.select(r.made);
  const auto = r.plan.parts.filter((p) => p.auto).length;
  const many = r.plan.parts.filter((p) => p.notOneColumn).length;
  const n = r.made.length;
  s.toast(`${n} satin${n > 1 ? "s" : ""} made${n > 1 ? ` (overlapping ${r.plan.overlap} mm at the cuts)` : ""}`, "success");
  if (auto && d.directions.length) s.toast(`${auto} part${auto > 1 ? "s" : ""} without a direction line: sewn across the long side`);
  if (many) s.toast(`${many} part${many > 1 ? "s are" : " is"} not one column across its direction: only the longest stretch is sewn. Add a cut there`, "error");
  s.set({ splitDraft: { ...EMPTY_SPLIT, draw: d.draw } });
  s.setTool("select");
}

export function SplitToolBar() {
  const draft = useStore((s) => s.splitDraft);
  const doc = useStore((s) => s.doc);
  const shape = draft.id ? doc.objects.find((o) => o.id === draft.id) : undefined;
  const plan = shape ? draftPlan(doc, draft) : null;
  const parts = plan?.parts.length ?? 0;
  const auto = plan?.parts.filter((p) => p.auto).length ?? 0;
  const lines = draft.cuts.length + draft.directions.length;
  return (
    <div className="contextbar">
      <span className="obj-name">
        <Split size={14} />
        <span>{shape ? `Split ${shape.name}` : "Split into satins"}</span>
      </span>
      <Seg label="A drag draws" value={draft.draw} options={[["cut", "Cut lines", "A drag draws a cut line: the shape is cut where it crosses it"], ["direction", "Direction lines", "A drag draws a direction line: the part it lies in is sewn that way (or hold Alt)"]] as const} onChange={(v) => setDraft({ draw: v })} />
      {shape && (
        <span className="stat" title={auto ? "A part without a direction line is sewn across its long side" : undefined}>
          {parts} part{parts === 1 ? "" : "s"}
          {auto ? ` · ${auto} automatic` : ""}
        </span>
      )}
      <div className="vsep" />
      <button className="icon-btn" title="Take back the last line (Backspace)" disabled={!lines} onClick={() => undoSplitLine()}>
        <Undo2 size={15} />
      </button>
      <button className="icon-btn" title="Clear the lines (Esc)" disabled={!lines} onClick={() => setDraft({ cuts: [], directions: [], order: [] })}>
        <X size={15} />
      </button>
      <button className="btn sm primary" disabled={!plan} onClick={applySplitDraft} title="Replace the shape with the satins (Enter)">
        Make {parts > 1 ? `${parts} satins` : "satin"}
      </button>
      <span className="ctx-help">
        {shape ? "Drag across the shape to cut it · Alt-drag the way to sew a part · Enter makes the satins" : "Click a fill shape: you'll draw where to cut it and which way to sew each part"}
      </span>
    </div>
  );
}
