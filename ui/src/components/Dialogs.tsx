import { FontPickerDialog } from "./Lettering";
import { RouteDialog } from "./RouteDialog";
import { KnockdownDialog } from "./KnockdownDialog";
import { CrossStitchDialog } from "./CrossStitchAssistant";
import { TestSwatchesDialog } from "./TestSwatches";
import { LicensesDialog } from "./Licenses";
import { OutlineDialog, RepeatDialog } from "./ArrangeTools";
import { ConvertDialog } from "./ConvertTools";
import { useState } from "react";
import { CommandPalette } from "./CommandPalette";
import { useStore } from "../store";
import { Dialog } from "./ui";
import { DigitizeDialog } from "./DigitizeDialog";
import { ThreadListDialog } from "./ThreadListDialog";
import { RebuildShapesDialog } from "./RebuildShapes";
import { PrintDialog } from "./PrintDialog";
import { ExportDialog } from "./ExportDialog";
import { SettingsDialog } from "./SettingsDialog";
import { ThreadManager } from "./ThreadManager";
import { ShapeEffectsDialog } from "./ShapeEffects";

// ---------------------------------------------------------------------------
// Threads

// ---------------------------------------------------------------------------
// Machine settings

// ---------------------------------------------------------------------------

/** Keyboard shortcuts, by what they act on. */
const SHORTCUTS: { group: string; rows: [string, string][] }[] = [
  {
    group: "Everywhere",
    rows: [
      ["Ctrl+K", "Command palette — find any command by name"],
      ["Ctrl+Z / Ctrl+Shift+Z", "Undo / redo"],
      ["Ctrl+N / Ctrl+O / Ctrl+S", "New / open / save (Shift: save as)"],
      ["Ctrl+I / Ctrl+E / Ctrl+P", "Import / export embroidery / print"],
      ["Ctrl+,", "Preferences"],
      ["?", "Keyboard shortcuts"],
    ],
  },
  {
    group: "Tools",
    rows: [
      ["V / A / C / H / M", "Select · Edit nodes · Cutter · Pan · Ruler"],
      ["P / F / S", "Pen (running stitch) · Freehand · Satin column"],
      ["R / E / T", "Rectangle · Ellipse · Lettering (click to place, type, Esc to finish)"],
      ["G", "Gradient: drag across a shape · click the line to add a stop · Alt-click a stop to remove it"],
      ["G · Density / Blend", "Drag across a fill: dense where you start, open where you end (Blend: a second colour fades in)"],
      ["D", "Stitch direction: draw guide lines the rows follow"],
      ["B", "Shape builder: drag across overlaps to merge them · Alt-drag deletes · Shift-click adds shapes"],
      ["Esc", "Back to Select (or clear the selection)"],
    ],
  },
  {
    group: "View",
    rows: [
      ["1 / 2 / 3", "Vector · Stitch · Realistic view"],
      ["0 / Shift+0", "Fit hoop / fit design"],
      ["+ / − · wheel / pinch", "Zoom (at the cursor)"],
      ["Space + drag · middle mouse", "Pan"],
      ["Shift+D", "Density map"],
    ],
  },
  {
    group: "Selection & objects",
    rows: [
      ["Ctrl+A", "Select all (node tool: every point)"],
      ["Ctrl+X / Ctrl+C / Ctrl+V", "Cut / copy / paste objects (also between windows; a pasted picture becomes a reference)"],
      ["Ctrl+] / Ctrl+[", "Sew later / earlier (Shift: last / first)"],
      ["Ctrl+3 / Ctrl+Alt+3", "Hide the selection / show all"],
      ["Ctrl+2 / Ctrl+Alt+2", "Lock the selection / unlock all"],
      ["Right-click", "The commands for what is under the pointer (right-drag pans)"],
      ["Ctrl+D / Alt+D / Del", "Duplicate / linked clone / delete"],
      ["Arrows (Shift)", "Nudge 0.5 mm (5 mm)"],
      ["Ctrl+G / Ctrl+Shift+G", "Group / ungroup"],
      ["Ctrl+Shift+C / Ctrl+Shift+V", "Copy / paste stitch properties"],
      ["[ / ] with a selection", "Rotate the fill angle 5° · change the satin width (Shift: more)"],
      ["Double-click an object", "Edit its nodes (lettering: edit its text)"],
      ["Ctrl-click", "Pick one object inside a group"],
    ],
  },
  {
    group: "Transform",
    rows: [
      ["Alt + drag an object", "Move a copy"],
      ["Shift while dragging", "Constrain · rotation in 15° steps"],
      ["Scale handles", "Free · Shift: keep proportions · Alt: from the centre · drag past an edge to flip"],
      ["Rotate", "Drag just outside a corner (or the top knob) · Alt-drag the pivot to move it"],
      ["Ctrl + drag a side handle", "Skew (Shift: 15° steps)"],
      ["Ctrl while dragging", "Ignore smart guides"],
    ],
  },
  {
    group: "Pen & satin",
    rows: [
      ["Click · drag", "Corner point · smooth point with handles (Alt: break the handles, Space: move the point, Shift: snap angles)"],
      ["While drawing", "Drag points and handles · click a segment to add a point · Alt-click a point to delete · double-click: smooth ↔ corner"],
      ["Click an end of a selected path", "Continue drawing that path"],
      ["Satin: scroll or [ ]", "Width of the next point · scroll over a point to change its width"],
      ["Enter / Esc / Backspace", "Finish the path (the tool stays) / finish / remove the last point"],
      ["Freehand", "The line trails the pointer and becomes a clean Bézier path · end at the start to close"],
      ["Pen", "Points snap to existing points (Ctrl: off) · ending on the end of another running path joins them"],
      ["Cutter", "Click a line to split it, drag across fills to cut them"],
    ],
  },
  {
    group: "Node tool",
    rows: [
      ["Click a segment / Alt-click a point", "Add a point (a rung pair on two-rail satins) / delete it"],
      ["Click · Shift-click · drag a box", "Select points · drag to move them (Shift: straight, Ctrl: no snapping)"],
      ["Del / Shift+Del", "Delete the points keeping the curve's shape / plain delete"],
      ["Arrows (Shift)", "Nudge the points 0.1 mm (1 mm)"],
      ["Shift+C / S / Y", "Corner / smooth / symmetric points"],
      ["Shift+L / U", "Straight / curved segments"],
      ["Shift+B / J", "Break the path at the points / join two end points"],
      ["Alt-drag a handle", "Break the symmetry"],
    ],
  },
  {
    group: "Pictures & lettering",
    rows: [
      ["Drop or paste a picture", "Choose: a reference to trace (never stitched) or digitize it"],
      ["Double-click a reference", "Adjust it · Enter: done · Del: remove"],
      ["Lettering handles", "Drag the arch handle to bend, the arrows to space letters · double-click to reset"],
    ],
  },
];

export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  const [q, setQ] = useState("");
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const match = (r: [string, string]) => words.every((w) => (r[0] + " " + r[1]).toLowerCase().includes(w));
  const groups = SHORTCUTS.map((g) => ({ ...g, rows: g.rows.filter(match) })).filter((g) => g.rows.length);
  return (
    <Dialog wide title="Keyboard shortcuts" onClose={onClose}>
      <input className="input" style={{ width: "100%", marginBottom: 10 }} placeholder="Filter shortcuts…" value={q} autoFocus onChange={(e) => setQ(e.target.value)} aria-label="Filter shortcuts" />
      <div className="shortcut-groups">
        {groups.map((g) => (
          <section key={g.group}>
            <h4>{g.group}</h4>
            <table className="shortcuts">
              <tbody>
                {g.rows.map(([k, v]) => (
                  <tr key={k + v}>
                    <td>
                      <kbd>{k}</kbd>
                    </td>
                    <td>{v}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ))}
        {!groups.length && <p className="hint">No shortcut matches “{q}”.</p>}
      </div>
    </Dialog>
  );
}

export function AboutDialog({ onClose }: { onClose: () => void }) {
  return (
    <Dialog title="Filum" onClose={onClose}>
      <p>A modern, Rust-powered machine-embroidery editor. The stitch engine is a Rust port of algorithms from Ink/Stitch, extended with new fills (radial, Hilbert, stipple), raster auto-digitizing, fabric-aware compensation and a stacking-aware stitch-order optimiser.</p>
      <p className="hint">
        GPL-3.0-or-later. Ink/Stitch © its authors (GPL-3.0). File encoders ported from Ink/Stitch's pystitch (MIT). Includes the Ink/Stitch embroidery-font
        collection and the Nunito, Bebas Neue and Pacifico fonts (each under its own licence, mostly SIL OFL 1.1).
      </p>
      <button className="btn sm" onClick={() => useStore.getState().setDialog("licenses")}>
        Open-source licences…
      </button>
    </Dialog>
  );
}

export function Dialogs() {
  const dialog = useStore((s) => s.dialog);
  const close = () => useStore.getState().setDialog(null);
  switch (dialog) {
    case "route":
      return <RouteDialog onClose={close} />;
    case "knockdown":
      return <KnockdownDialog onClose={close} />;
    case "palette":
      return <CommandPalette onClose={close} />;
    case "export":
      return <ExportDialog onClose={close} />;
    case "digitize":
      return <DigitizeDialog onClose={close} />;
    case "fonts":
      return <FontPickerDialog onClose={close} />;
    case "threads":
      return <ThreadManager onClose={close} />;
    case "settings":
      return <SettingsDialog onClose={close} />;
    case "production":
      return <PrintDialog onClose={close} />;
    case "threadlist":
      return <ThreadListDialog onClose={close} />;
    case "rebuild":
      return <RebuildShapesDialog onClose={close} />;
    case "shortcuts":
      return <ShortcutsDialog onClose={close} />;
    case "about":
      return <AboutDialog onClose={close} />;
    case "licenses":
      return <LicensesDialog onClose={close} />;
    case "repeat":
      return <RepeatDialog onClose={close} />;
    case "outline":
      return <OutlineDialog onClose={close} />;
    case "convert":
      return <ConvertDialog onClose={close} />;
    case "effects":
      return <ShapeEffectsDialog onClose={close} />;
    case "swatches":
      return <TestSwatchesDialog onClose={close} />;
    case "crossstitch":
      return <CrossStitchDialog onClose={close} />;
    default:
      return null;
  }
}
