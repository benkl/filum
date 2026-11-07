// The keys and clicks of the current situation along the bottom: what the
// active tool does now, and — while Shift,
// Ctrl or Alt is held — what that modifier changes.

import { useEffect, useState } from "react";
import { useStore } from "../store";

/** One hint: its keys (mouse: LMB, RMB, MMB, Wheel, Drag) and what it does. */
type Hint = [string[], string];

const mod = typeof navigator !== "undefined" && /Mac/.test(navigator.platform) ? "⌘" : "Ctrl";

function hintsFor(s: ReturnType<typeof useStore.getState>): Hint[] {
  if (s.dialog) return [[["Esc"], "Close"], [["Drag"], "Move by the title"]];
  if (s.refEdit)
    return [
      [["Drag"], "Move picture"],
      [["Drag", "corner"], "Scale"],
      [["Shift", "Drag"], "Scale freely"],
      [["Drag", "knob"], "Rotate"],
      [["Shift", "Drag", "knob"], "Rotate in 15° steps"],
      [["Arrows"], "Nudge"],
      [["Enter"], "Done"],
      [["Del"], "Remove picture"],
    ];
  if (s.anim.index != null)
    return [
      [["Drag", "timeline"], "Scrub"],
      [["Ctrl", "Wheel"], "Zoom"],
      [["←", "→"], "One stitch"],
      [["Shift", "←", "→"], "Colour block"],
      [["Home", "End"], "Start · end"],
      [["Esc"], "Close"],
      [["LMB"], "Back to editing"],
    ];
  if (s.editingText) return [[["Type"], "Edit the text"], [["Enter"], "New line"], [["Esc"], "Finish"], [["Drag", "handles"], "Arch · spacing"]];
  const sel = s.selection.length;
  switch (s.tool) {
    case "select":
      return sel
        ? [
            [["Drag"], "Move"],
            [["Alt", "Drag"], "Move a copy"],
            [["Shift", "LMB"], "Add / remove"],
            [["Ctrl", "LMB"], "Pick inside a group"],
            [["Drag", "corner"], "Scale"],
            [["Shift", "Drag", "corner"], "Keep proportions"],
            [["Alt", "Drag", "corner"], "Scale from the centre"],
            [["Ctrl", "Drag", "side"], "Skew"],
            [["Drag", "outside corner"], "Rotate"],
            [["Shift", "Drag", "outside corner"], "Rotate in 15° steps"],
            [["Ctrl", "Drag"], "No smart guides"],
            [["DblClick"], "Edit nodes"],
            [["Arrows"], `Nudge ${s.prefs.nudge} mm`],
            [["Shift", "Arrows"], `Nudge ${s.prefs.nudgeBig} mm`],
            [["[", "]"], "Fill angle · satin width"],
            [["Del"], "Delete"],
            [[mod, "D"], "Duplicate"],
            [[mod, "G"], "Group"],
          ]
        : [
            [["LMB"], "Select"],
            [["Drag"], "Box select"],
            [["Shift", "LMB"], "Add to the selection"],
            [["Ctrl", "LMB"], "Pick inside a group"],
            [["DblClick", "picture"], "Adjust a reference picture"],
            [[mod, "A"], "Select all"],
          ];
    case "node":
      if (!sel) return [[["LMB"], "Choose a shape to edit"], [["Esc"], "Back to select"]];
      return s.nodeSel.length
        ? [
            [["Drag"], `Move ${s.nodeSel.length} point${s.nodeSel.length > 1 ? "s" : ""}`],
            [["Shift", "Drag"], "Straight only"],
            [["Ctrl", "Drag"], "No snapping"],
            [["Shift", "LMB"], "Add / remove a point"],
            [["Shift", "Drag"], "Box: add points"],
            [["Alt", "Drag"], "Box: remove points"],
            [["Arrows"], `Nudge ${s.prefs.nodeNudge} mm`],
            [["Shift", "Arrows"], `Nudge ${s.prefs.nodeNudgeBig} mm`],
            [["Del"], "Delete, keep the shape"],
            [["Shift", "Del"], "Plain delete"],
            [["Shift", "C"], "Corner"],
            [["Shift", "S"], "Smooth"],
            [["Shift", "Y"], "Symmetric"],
            [["Shift", "L"], "Straight segments"],
            [["Shift", "U"], "Curved segments"],
            [["Shift", "B"], "Break"],
            [["Shift", "J"], "Join"],
            [[mod, "Alt", "J"], "Average"],
            [["Esc"], "Deselect points"],
          ]
        : [
            [["LMB"], "Select a point"],
            [["Drag"], "Box select points"],
            [["Shift", "Drag"], "Box: add points"],
            [["LMB", "path"], "Add a point"],
            [["Drag", "path"], "Bend the curve"],
            [["Alt", "LMB"], "Delete a point"],
            [["DblClick"], "Smooth ↔ corner"],
            [["Alt", "Drag", "handle"], "Break the handles"],
            [["Drag", "corner widget"], "Round the corner"],
            [["Shift", "Drag", "corner widget"], "Round every corner"],
            [[mod, "A"], "Every point"],
          ];
    case "pen":
    case "satin": {
      const satin = s.tool === "satin";
      const width: Hint[] = satin ? [[["Wheel"], "Width"], [["[", "]"], "Width"]] : [];
      return s.drafting
        ? [
            [["LMB"], "Corner point"],
            [["Drag"], "Curve point"],
            [["Shift", "LMB"], satin ? "Angles in 15°" : "Angles in 45°"],
            [["Alt", "Drag"], "Break the handles"],
            [["Space", "Drag"], "Move the point"],
            [["Ctrl", "LMB"], "No snapping"],
            [["LMB", "first point"], "Close"],
            [["Alt", "LMB", "point"], "Delete it"],
            ...width,
            [["Backspace"], "Remove the last point"],
            [["Enter"], "Finish"],
          ]
        : [[["LMB"], "Start with a corner"], [["Drag"], "Start with a curve"], [["LMB", "path end"], "Continue that path"], ...width];
    }
    case "curve":
      return s.drafting
        ? [
            [["LMB"], "Smooth point"],
            [["Double-click", "point"], "Corner ↔ smooth"],
            [["Drag", "point"], "Move it"],
            [["LMB", "first point"], "Close"],
            [["Alt", "LMB", "point"], "Delete it"],
            [["Backspace"], "Remove the last point"],
            [["Enter"], "Finish"],
          ]
        : [[["LMB"], "Start the path"], [["LMB", "path end"], "Continue that path"]];
    case "freehand":
      return [[["Drag"], "Draw"], [["Drag", "back to the start"], "Close"]];
    case "rect":
    case "ellipse":
      return [[["Drag"], "Draw"], [["Shift", "Drag"], "Square / regular"]];
    case "text":
      return [[["LMB"], "Place lettering"], [["LMB", "lettering"], "Edit it"]];
    case "cut":
      return [[["LMB", "line"], "Split it"], [["Drag", "across a fill"], "Cut it in two"]];
    case "gradient": {
      const m = s.toolOptions.gradient.mode ?? "colour";
      if (m !== "colour" || s.doc.objects.some((o) => s.selection.includes(o.id) && o.stitch.type === "fill" && o.stitch.ramp))
        return [
          [["Drag"], m === "blend" ? "Blend across the shape (this colour fades out)" : "Density across the shape (dense → open)"],
          [["Shift", "Drag"], "In 45° steps"],
          [["Drag", "dot"], "Move the dense end"],
          [["Drag", "ring"], "Move the open end"],
          [["LMB"], "Select a shape"],
        ];
      return [[["Drag"], "Gradient across the shape"], [["LMB", "line"], "Add a stop"], [["Alt", "LMB", "stop"], "Remove it"], [["DblClick", "stop"], "Remove it"]];
    }
    case "guides":
      return sel
        ? [
            [["Drag", "across"], "Add a direction guide"],
            [["Drag", "end"], "Turn it"],
            [["Drag", "guide"], "Move it"],
            [["Alt", "LMB", "guide"], "Delete it"],
            [["LMB", "other"], "Pick another satin"],
          ]
        : [[["LMB"], "Choose a satin column"]];
    case "builder":
      return sel
        ? [
            [["LMB", "region"], "Make it its own shape"],
            [["Drag", "across regions"], "Merge them"],
            [["Alt", "Drag"], "Delete regions"],
            [["Shift", "LMB", "shape"], "Add a shape"],
            [["LMB", "empty"], "Deselect"],
          ]
        : [
            [["LMB"], "Choose a shape"],
            [["Shift", "LMB"], "Add overlapping shapes"],
          ];
    case "ruler":
      return [[["Drag"], "Measure"]];
    case "pan":
      return [[["Drag"], "Pan"]];
    default:
      return [];
  }
}

const NAV: Hint[] = [
  [["MMB"], "Pan"],
  [["Wheel"], "Zoom"],
  [["Space", "Drag"], "Pan"],
];

const MOUSE = new Set(["LMB", "RMB", "MMB", "Wheel", "Drag", "DblClick"]);
const MODS = ["Shift", "Ctrl", "Alt", "⌘"];

/** Mouse glyph: the pressed button filled. */
function Mouse({ b }: { b: string }) {
  const fill = "currentColor";
  return (
    <svg className="mouse" width="11" height="15" viewBox="0 0 11 15" aria-label={b}>
      <rect x="0.75" y="0.75" width="9.5" height="13.5" rx="4.75" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <line x1="5.5" y1="1" x2="5.5" y2="6" stroke="currentColor" strokeWidth="1" />
      {(b === "LMB" || b === "Drag" || b === "DblClick") && <path d="M5.5 1 A4.75 4.75 0 0 0 0.75 5.75 V6 H5.5 Z" fill={fill} />}
      {b === "RMB" && <path d="M5.5 1 A4.75 4.75 0 0 1 10.25 5.75 V6 H5.5 Z" fill={fill} />}
      {(b === "MMB" || b === "Wheel") && <rect x="4.5" y="2.4" width="2" height="3" rx="1" fill={fill} />}
    </svg>
  );
}

function Keys({ keys }: { keys: string[] }) {
  return (
    <span className="sh-keys">
      {keys.map((k, i) =>
        MOUSE.has(k) ? (
          <span key={i} className="sh-mouse">
            <Mouse b={k} />
            {k === "Drag" ? <small>drag</small> : k === "DblClick" ? <small>×2</small> : k === "Wheel" ? <small>wheel</small> : null}
          </span>
        ) : /^[a-z]/.test(k) ? (
          <small key={i} className="sh-where">
            {k}
          </small>
        ) : (
          <kbd key={i}>{k}</kbd>
        ),
      )}
    </span>
  );
}

export function StatusHints() {
  const s = useStore();
  const [held, setHeld] = useState<string | null>(null);
  useEffect(() => {
    const read = (e: KeyboardEvent) => setHeld(e.shiftKey ? "Shift" : e.ctrlKey ? "Ctrl" : e.altKey ? "Alt" : e.metaKey ? "⌘" : null);
    const clear = () => setHeld(null);
    window.addEventListener("keydown", read);
    window.addEventListener("keyup", read);
    window.addEventListener("blur", clear);
    return () => {
      window.removeEventListener("keydown", read);
      window.removeEventListener("keyup", read);
      window.removeEventListener("blur", clear);
    };
  }, []);
  if (!s.prefs.hints) return null;
  let hints = hintsFor(s);
  // a held modifier: what it does here (when it does anything)
  const withMod = held ? hints.filter(([k]) => k.includes(held) || (held === "Ctrl" && k.includes(mod))) : [];
  if (withMod.length) hints = withMod;
  // nothing held: the plain hints and keyboard commands; mouse + modifier
  // variants appear while the modifier is held
  const variants = held ? [] : [...new Set(hints.filter(([k]) => k.some((x) => MOUSE.has(x)) && k.some((x) => MODS.includes(x))).map(([k]) => k.find((x) => MODS.includes(x))!))];
  if (!held) hints = hints.filter(([k]) => !(k.some((x) => MOUSE.has(x)) && k.some((x) => MODS.includes(x))));
  const nav = s.dialog || held ? [] : NAV;
  const n = s.selection.length;
  return (
    <div className="status-hints" aria-label="Shortcuts">
      <div className="sh-list">
        {held && withMod.length > 0 && <span className="sh-held">{held}</span>}
        {hints.map(([k, label], i) => (
          <span key={i} className="sh">
            <Keys keys={k} />
            {label}
          </span>
        ))}
        {variants.length > 0 && (
          <span className="sh more">
            hold
            {variants.map((v, i) => (
              <kbd key={i}>{v}</kbd>
            ))}
            for more
          </span>
        )}
        {nav.length > 0 && <span className="sh-sep" />}
        {nav.map(([k, label], i) => (
          <span key={`n${i}`} className="sh nav">
            <Keys keys={k} />
            {label}
          </span>
        ))}
      </div>
      <span className="sh-info">
        {n ? `${n} selected · ` : ""}
        {s.doc.objects.length} object{s.doc.objects.length === 1 ? "" : "s"}
        {s.planning ? " · computing…" : ""}
      </span>
    </div>
  );
}
