// Optimise and what it may change: a split button in the top bar. The button
// runs the optimiser (lib/actions optimizeOrder) with the steps ticked in the
// flyout under its arrow; the steps stay ticked across designs (Preferences).

import { Check, ChevronDown } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { SewOrder } from "../icons/stitch";
import { optimizeOrder } from "../lib/actions";
import { optimizeSteps } from "../lib/prefs";
import { useStore } from "../store";
import type { OptimizeSteps } from "../types";
import { placeNear, useDismiss } from "./ui";

type Step = { id: keyof OptimizeSteps; label: string; hint: string };

/** What the order may change. */
const ORDER_STEPS: Step[] = [
  {
    id: "colors",
    label: "Group colours",
    hint: "Sew each thread's objects together: fewer colour changes",
  },
  {
    id: "travel",
    label: "Shortest way",
    hint: "Within a thread, the object the needle reaches soonest next: shorter jumps, fewer trims",
  },
  {
    id: "centerOut",
    label: "Centre out",
    hint: "The middle of the design first, then outwards, so the fabric is pushed towards the edges instead of bunching; on caps also from the bottom up. On by default for caps and stretchy fabrics",
  },
  {
    id: "foamLast",
    label: "3D foam last",
    hint: "Satins over 3D foam as late as the stacking allows: anything sewn after the foam flattens it",
  },
];
/** What it may change on the objects. */
const OBJECT_STEPS: Step[] = [
  {
    id: "ends",
    label: "End points",
    hint: "Each object ends on the side towards the next one in its thread, when that saves more than 1 mm of travel",
  },
  {
    id: "links",
    label: "Reset moved connections",
    hint: "A Sew or Jump set by hand goes back to Automatic when the object sewn next changes",
  },
];
/** Which objects may move. */
const SCOPE_STEPS: Step[] = [
  {
    id: "locked",
    label: "Move locked objects",
    hint: "Off: locked objects keep their place, and the others are optimised before and after them",
  },
  {
    id: "selectionOnly",
    label: "Only the selection",
    hint: "Only the selected objects move, among their neighbours in the sewing order",
  },
];

export function OptimizeButton() {
  const [at, setAt] = useState<DOMRect | null>(null);
  const caret = useRef<HTMLButtonElement>(null);
  const close = (focus = false) => {
    setAt(null);
    if (focus) caret.current?.focus();
  };
  // Escape is the menu's own (the focus goes back to the caret)
  useDismiss(!!at, () => setAt(null), [".optimize-menu", ".optimize-split"], { escape: false });
  return (
    <div className="split-btn optimize-split">
      <button
        className="btn ghost"
        onClick={optimizeOrder}
        title="Reorder for fewer colour changes, jumps and trims, with the steps chosen in the menu beside it (stacking stays as drawn)"
      >
        <SewOrder size={14} /> Optimise
      </button>
      <button
        ref={caret}
        className={`btn ghost split-caret ${at ? "open" : ""}`}
        aria-label="What Optimise may change"
        aria-haspopup="menu"
        aria-expanded={!!at}
        title="What Optimise may change"
        onClick={(e) => (at ? close() : setAt(e.currentTarget.parentElement!.getBoundingClientRect()))}
      >
        <ChevronDown size={13} />
      </button>
      {at && <OptimizeMenu anchor={at} onClose={close} />}
    </div>
  );
}

function OptimizeMenu({ anchor, onClose }: { anchor: DOMRect; onClose: (focus?: boolean) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const prefs = useStore((s) => s.prefs);
  const selected = useStore((s) => s.selection.length);
  const fabric = useStore((s) => s.doc.fabric);
  const steps = optimizeSteps(prefs, fabric);
  const [place, setPlace] = useState({ x: anchor.right, y: anchor.bottom + 4 });
  // under the button, its right edge on the button's, kept on screen
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const p = placeNear(anchor, el.offsetWidth, { align: "end", margin: 4, height: el.offsetHeight, flip: false });
    setPlace({ x: p.left, y: p.top });
  }, [anchor]);
  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>(".menu-item:not(:disabled)")?.focus({ preventScroll: true });
  }, []);
  const toggle = (id: keyof OptimizeSteps) => useStore.getState().setPrefs({ optimize: { ...prefs.optimize, [id]: !steps[id] } });
  const none = !steps.colors && !steps.travel && !steps.centerOut && !steps.foamLast && !steps.ends && !steps.links;
  const item = (st: Step, disabled = false) => (
    <button
      key={st.id}
      role="menuitemcheckbox"
      aria-checked={steps[st.id]}
      className="menu-item"
      title={st.hint}
      disabled={disabled}
      onClick={() => toggle(st.id)}
    >
      <span className="check">{steps[st.id] && <Check size={13} />}</span>
      {st.label}
    </button>
  );
  return (
    <div
      ref={ref}
      className="menu optimize-menu"
      role="menu"
      aria-label="What Optimise may change"
      style={{ left: place.x, top: place.y }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          return onClose(true);
        }
        if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
        e.preventDefault();
        e.stopPropagation();
        const f = [...(ref.current?.querySelectorAll<HTMLButtonElement>(".menu-item:not(:disabled)") ?? [])];
        const k = f.indexOf(document.activeElement as HTMLButtonElement);
        f[(k + (e.key === "ArrowDown" ? 1 : f.length - 1)) % f.length]?.focus();
      }}
    >
      <div className="menu-label">Order</div>
      {ORDER_STEPS.map((st) => item(st))}
      <div className="menu-label">Objects</div>
      {OBJECT_STEPS.map((st) => item(st))}
      <div className="menu-sep" role="separator" />
      {item(SCOPE_STEPS[0])}
      {item(
        {
          ...SCOPE_STEPS[1],
          label: selected ? `Only the selection (${selected})` : SCOPE_STEPS[1].label,
        },
        !selected,
      )}
      <div className="menu-sep" role="separator" />
      <button
        role="menuitem"
        className="menu-item"
        disabled={none}
        title={none ? "Tick at least one step above" : "Optimise now with these steps"}
        onClick={() => {
          onClose();
          optimizeOrder();
        }}
      >
        <span className="check">
          <SewOrder size={14} />
        </span>
        Optimise now
      </button>
      <p className="menu-note">What overlaps keeps its stacking whatever is ticked.</p>
    </div>
  );
}
