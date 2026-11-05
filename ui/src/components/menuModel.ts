// Every command of the application, once: the menu bar shows them as menus
// with submenus, the command palette (Ctrl+K) searches the same list. Each
// command has one home, chosen by what it acts on:
//
//   File     the document and files (open, import, digitize a picture, save, export)
//   Edit     undo, the clipboard, selection, preferences
//   Object   arranging objects (align, mirror, repeat, group, combine)
//   Path     the geometry of shapes (effects, nodes, conversions, routing)
//   Stitch   how shapes are sewn (appliqué, gradients, cross stitch, design-wide sewing options)
//   Threads  colours and palettes
//   View     what the canvas shows, panels, theme
//   Tools    the drawing and editing tools
//   Help

import { AlignCenterHorizontal, ArrowDownUp, Clipboard, SquareSplitHorizontal, ArrowRightLeft, Blend, ClipboardPaste, Combine, Copy, CopyPlus, Eye, EyeOff, FileCode, FileDown, FilePlus, FlipHorizontal2, FlipVertical2, Flower2, FolderOpen, Grid2x2Check, Group, ImagePlus, Import, Link2, Lock, LockOpen, Mountain, Printer, Redo2, RotateCw, Route, Ruler, Scissors, Settings, Spline, Trash2, Undo2, Ungroup, Unlink, Wand2, ZoomIn, ZoomOut, type LucideIcon } from "lucide-react";
import { Applique, Basting, Rebuild, StitchAngle, Cutwork, DensityMap, Digitize, GradientTool, Hoop, Jump, Knockdown, PatchBorder, SewOrder, Spool, StitchCross, StitchRunning, StitchSatin } from "../icons/stitch";
import { TOOL_ICONS } from "../icons/toolIcons";
import { unlinkClone } from "../lib/clones";
import { centerInHoop, cloneSelection, exportDesign, fit, importFile, newDocument, openDigitizer, openDocument, optimizeOrder, saveDocument, selectAll } from "../lib/actions";
import {
  align,
  copyProperties,
  copySelection,
  distribute,
  groupSelection,
  hasClipboard,
  hasCopiedProperties,
  hideSelection,
  lockSelection,
  makeApplique,
  mirrorSelection,
  orderSelection,
  pasteClipboard,
  pasteProperties,
  combineShapes,
  rotateSelection,
  selectSimilar,
  showAll,
  ungroupSelection,
  unlockAll,
} from "../lib/arrange";
import { applies } from "../lib/convertActions";
import { exportTarget, PICTURE_SETTINGS } from "../lib/exportFiles";
import { defaultDesignOptions } from "../lib/geometry";
import { openExternal, openFile } from "../lib/platform";
import { addReference } from "../lib/references";
import { divideSelection } from "../lib/shapeBuilder";
import { cleanupDocument } from "../lib/shapeCheck";
import { DEFAULT_LAYOUT } from "../lib/layout";
import { showDesign, showIssues, togglePanels } from "../lib/panelActions";
import { reversePath, sharpen } from "../lib/shapeOps";
import { chartLabel, exportPalette, fitThreads, importPalette, matchAll, mergeSimilarColours, mergeTolerance, removeUnused, revertFit, sortBySewOrder, STITCH_COLORS } from "../lib/threads";
import { loadSample } from "../sample";
import { useStore } from "../store";
import type { Tool, ViewMode } from "../types";
import { CONVERSIONS, openConvert } from "./ConvertTools";
import { openKnockdown } from "./KnockdownDialog";
import { openRoute } from "./RouteDialog";
import { runCutwork } from "./CutworkPanel";
import { EFFECTS, lineAsFillGuide, openEffect, pathCommand } from "./ShapeEffects";
import { chooseThreadList } from "./ThreadListDialog";
import { lastChart } from "./ThreadPicker";

export type MenuItem =
  | {
      label: string;
      kbd?: string;
      run?: () => void;
      checked?: boolean;
      disabled?: boolean;
      /** What it does (tooltip, palette). */
      hint?: string;
      /** Shown in the menus and the command palette. */
      icon?: LucideIcon;
      /** A submenu. */
      sub?: MenuItem[];
    }
  | "-";

export type MenuEntry = Exclude<MenuItem, "-">;


/** Zoom around the middle of the canvas. */
export function zoomBy(f: number) {
  const s = useStore.getState();
  const el = document.querySelector(".canvas-wrap")?.getBoundingClientRect();
  if (!el) return;
  const mx = el.width / 2;
  const my = el.height / 2;
  const scale = Math.max(0.3, Math.min(400, s.view.scale * f));
  const k = scale / s.view.scale;
  s.setView({ scale, ox: mx - (mx - s.view.ox) * k, oy: my - (my - s.view.oy) * k });
}

export const mod = navigator.platform.toLowerCase().includes("mac") ? "⌘" : "Ctrl+";

/** Put text on the system clipboard (best effort: menus can't use the copy event). */
const clipboardWrite = (text: string | null) => {
  if (text) navigator.clipboard?.writeText(text).catch(() => {});
};

async function addReferencePicture() {
  const f = await openFile([{ name: "Pictures", extensions: ["png", "jpg", "jpeg", "webp", "bmp", "gif"] }]);
  if (f) await addReference(f.name, f.bytes);
}

/** The application's menus, for the current state. */
export function buildMenus(): Record<string, MenuItem[]> {
  const s = useStore.getState();
  const hasSel = s.selection.length > 0;
  const many = s.selection.length > 1;
  const selected = s.doc.objects.filter((o) => s.selection.includes(o.id));
  const selObj = selected[0];
  const oneFill = s.selection.length === 1 && selObj?.stitch.type === "fill";
  const opts = s.doc.options ?? defaultDesignOptions();
  const setOpts = (p: Partial<typeof opts>) => s.commit((d) => ({ ...d, options: { ...(d.options ?? defaultDesignOptions()), ...p } }));
  const tool = (t: Tool, label: string, kbd: string, hint?: string): MenuItem => ({ label, kbd, hint, icon: TOOL_ICONS[t], run: () => s.setTool(t), checked: s.tool === t });
  const mode = (m: ViewMode, label: string, kbd: string): MenuItem => ({ label, kbd, run: () => s.setViewMode(m), checked: s.viewMode === m });
  const toggle = (label: string, on: boolean, flip: () => void, kbd?: string, hint?: string): MenuItem => ({ label, kbd, hint, run: flip, checked: on });
  const gradient = (m: "blend" | "density", toast: string) => () => {
    s.setToolOptions("gradient", { mode: m });
    s.setTool("gradient");
    s.toast(toast);
  };

  return {
    File: [
      { label: "New design", icon: FilePlus, kbd: `${mod}N`, run: newDocument },
      { label: "Open…", icon: FolderOpen, kbd: `${mod}O`, run: openDocument },
      { label: "Load sample design", icon: Mountain, run: loadSample },
      "-",
      { label: "Import artwork or embroidery…", icon: Import, kbd: `${mod}I`, run: importFile, hint: "SVG artwork, machine files (DST, PES, JEF …) or a picture to digitize" },
      { label: "Digitize a picture…", icon: Digitize, run: () => openDigitizer("shapes"), hint: "Turn a picture into fills, satins and lines" },
      { label: "Cross stitch from a picture…", icon: StitchCross, run: () => openDigitizer("cross"), hint: "Turn a picture into cross stitch on a grid" },
      { label: "Add reference picture…", icon: ImagePlus, run: () => void addReferencePicture(), hint: "A picture to trace over — never stitched" },
      "-",
      { label: "Save", kbd: `${mod}S`, run: () => saveDocument() },
      { label: "Save as…", kbd: `${mod}⇧S`, run: () => saveDocument(true) },
      "-",
      { label: "Export embroidery…", icon: FileDown, kbd: `${mod}E`, run: () => s.setDialog("export") },
      { label: "Export Ink/Stitch SVG", icon: FileCode, run: () => exportDesign("svg") },
      { label: "Print / PDF…", icon: Printer, kbd: `${mod}P`, run: () => s.setDialog("production") },
    ],
    Edit: [
      { label: "Undo", icon: Undo2, kbd: `${mod}Z`, run: s.undo, disabled: !s.past.length },
      { label: "Redo", icon: Redo2, kbd: `${mod}⇧Z`, run: s.redo, disabled: !s.future.length },
      "-",
      { label: "Cut", icon: Scissors, kbd: `${mod}X`, run: () => clipboardWrite(copySelection(true)), disabled: !hasSel },
      { label: "Copy", icon: Copy, kbd: `${mod}C`, run: () => clipboardWrite(copySelection()), disabled: !hasSel },
      { label: "Paste", icon: ClipboardPaste, kbd: `${mod}V`, run: () => pasteClipboard(), disabled: !hasClipboard() },
      { label: "Paste in place", icon: Clipboard, run: () => pasteClipboard(true), disabled: !hasClipboard() },
      "-",
      { label: "Duplicate", icon: CopyPlus, kbd: `${mod}D`, run: s.duplicateSelection, disabled: !hasSel },
      { label: "Clone (linked copy)", icon: Link2, kbd: "Alt+D", run: cloneSelection, disabled: !hasSel },
      {
        label: "Unlink clone",
        icon: Unlink,
        run: () => s.commit((d) => ({ ...d, objects: d.objects.map((o) => (s.selection.includes(o.id) && o.clone ? unlinkClone(o) : o)) })),
        disabled: !selected.some((o) => o.clone),
      },
      { label: "Delete", icon: Trash2, kbd: "Del", run: s.deleteSelection, disabled: !hasSel },
      "-",
      { label: "Select all", kbd: `${mod}A`, run: selectAll },
      {
        label: "Select same",
        disabled: !hasSel,
        sub: [
          { label: "Colour", run: () => selectSimilar("color"), disabled: !hasSel },
          { label: "Stitch type", run: () => selectSimilar("type"), disabled: !hasSel },
        ],
      },
      {
        label: "Stitch properties",
        disabled: !hasSel,
        sub: [
          { label: "Copy", kbd: `${mod}⇧C`, run: copyProperties, disabled: !hasSel },
          { label: "Paste", kbd: `${mod}⇧V`, run: () => pasteProperties(false), disabled: !hasSel || !hasCopiedProperties() },
          { label: "Paste with colour", run: () => pasteProperties(true), disabled: !hasSel || !hasCopiedProperties() },
        ],
      },
      "-",
      { label: "Preferences…", icon: Settings, kbd: `${mod},`, run: () => s.openSettings() },
    ],
    Object: [
      {
        label: "Align",
        icon: AlignCenterHorizontal,
        disabled: !hasSel,
        sub: [
          { label: many ? "Left" : "Left in hoop", run: () => align("left"), disabled: !hasSel },
          { label: "Centre horizontally", run: () => align("hcenter"), disabled: !hasSel },
          { label: many ? "Right" : "Right in hoop", run: () => align("right"), disabled: !hasSel },
          "-",
          { label: many ? "Top" : "Top in hoop", run: () => align("top"), disabled: !hasSel },
          { label: "Centre vertically", run: () => align("vcenter"), disabled: !hasSel },
          { label: many ? "Bottom" : "Bottom in hoop", run: () => align("bottom"), disabled: !hasSel },
          "-",
          { label: "Distribute horizontally", run: () => distribute("h"), disabled: s.selection.length < 3 },
          { label: "Distribute vertically", run: () => distribute("v"), disabled: s.selection.length < 3 },
        ],
      },
      { label: "Centre in hoop", icon: Hoop, run: centerInHoop, hint: "The selection, or the whole design" },
      {
        label: "Stitch order",
        icon: ArrowDownUp,
        disabled: !hasSel,
        sub: [
          { label: "Sew last (to front)", kbd: `${mod}⇧]`, run: () => orderSelection("front"), disabled: !hasSel },
          { label: "Sew later", kbd: `${mod}]`, run: () => orderSelection("forward"), disabled: !hasSel },
          { label: "Sew earlier", kbd: `${mod}[`, run: () => orderSelection("backward"), disabled: !hasSel },
          { label: "Sew first (to back)", kbd: `${mod}⇧[`, run: () => orderSelection("back"), disabled: !hasSel },
        ],
      },
      "-",
      {
        label: "Rotate",
        icon: RotateCw,
        disabled: !hasSel,
        sub: [
          { label: "90° clockwise", run: () => rotateSelection(90), disabled: !hasSel },
          { label: "90° counter-clockwise", run: () => rotateSelection(-90), disabled: !hasSel },
          { label: "180°", run: () => rotateSelection(180), disabled: !hasSel },
        ],
      },
      { label: "Mirror horizontally", icon: FlipHorizontal2, run: () => mirrorSelection("h"), disabled: !hasSel },
      { label: "Mirror vertically", icon: FlipVertical2, run: () => mirrorSelection("v"), disabled: !hasSel },
      { label: "Repeat: wreath, kaleidoscope, mirror-merge…", icon: Flower2, run: () => s.setDialog("repeat"), disabled: !hasSel },
      "-",
      { label: "Group", icon: Group, kbd: `${mod}G`, run: groupSelection, disabled: !many },
      { label: "Ungroup", icon: Ungroup, kbd: `${mod}⇧G`, run: ungroupSelection, disabled: !hasSel },
      "-",
      { label: "Hide", icon: EyeOff, kbd: `${mod}3`, run: hideSelection, disabled: !hasSel, hint: "Hidden objects are not sewn" },
      { label: "Show all", icon: Eye, kbd: `${mod}Alt+3`, run: showAll, disabled: !s.doc.objects.some((o) => !o.visible) },
      { label: "Lock", icon: Lock, kbd: `${mod}2`, run: lockSelection, disabled: !hasSel, hint: "Locked objects can't be selected on the canvas" },
      { label: "Unlock all", icon: LockOpen, kbd: `${mod}Alt+2`, run: unlockAll, disabled: !s.doc.objects.some((o) => o.locked) },
      "-",
      {
        label: "Combine shapes",
        icon: Combine,
        sub: [
          { label: "Unite", run: () => combineShapes("unite"), disabled: !many },
          { label: "Minus front", run: () => combineShapes("minusFront"), disabled: !many },
          { label: "Intersect", run: () => combineShapes("intersect"), disabled: !many },
          { label: "Exclude", run: () => combineShapes("exclude"), disabled: !many },
          "-",
          { label: "Divide into regions", icon: SquareSplitHorizontal, run: () => void divideSelection(), disabled: !many },
          tool("builder", "Shape builder", "B", "Merge or delete the overlap regions by dragging across them"),
        ],
      },
    ],
    Path: [
      { label: "Effects", icon: Wand2, disabled: !hasSel, sub: EFFECTS.map((e): MenuItem => ({ label: `${e.label}…`, hint: e.title, run: () => openEffect(e.id), disabled: !hasSel })) },
      { label: "Outlines & offsets…", icon: PatchBorder, run: () => s.setDialog("outline"), disabled: !hasSel },
      {
        label: "Nodes",
        icon: Spline,
        disabled: !hasSel,
        sub: [
          { label: "Make all corners sharp", run: () => pathCommand(sharpen, "Corners sharpened"), disabled: !hasSel },
          { label: "Reverse path direction", run: () => pathCommand(reversePath, "Reversed"), disabled: !hasSel },
        ],
      },
      "-",
      {
        label: "Convert",
        icon: ArrowRightLeft,
        sub: [
          ...CONVERSIONS.map((c): MenuItem => ({ label: c.menu, hint: c.title, run: () => openConvert(c.id), disabled: !applies(c.id, selected) })),
          "-",
          { label: "Rebuild shapes from stitches…", icon: Rebuild, run: () => s.setDialog("rebuild"), disabled: !hasSel },
        ],
      },
      {
        label: "Route",
        icon: Route,
        sub: [
          { label: "Auto-route running stitch…", icon: StitchRunning, run: () => openRoute("running"), disabled: !selected.some((o) => o.stitch.type === "running"), hint: "Also out and back (redwork)" },
          { label: "Auto-route satin columns…", icon: StitchSatin, run: () => openRoute("satin"), disabled: !selected.some((o) => o.stitch.type === "satin") },
          { label: "Jumps to running stitch…", icon: Jump, run: () => openRoute("jumps") },
        ],
      },
      { label: "Cutwork segmentation", icon: Cutwork, run: () => runCutwork(s.selection), disabled: !selected.some((o) => o.stitch.type === "running") },
      { label: "Use line as fill guide", icon: StitchAngle, run: lineAsFillGuide, disabled: s.selection.length !== 2, hint: "Select a fill and a line" },
    ],
    Stitch: [
      { label: "Make appliqué", icon: Applique, run: makeApplique, disabled: !hasSel },
      { label: "Knockdown…", icon: Knockdown, run: () => openKnockdown(), hint: "A net that flattens pile fabrics — under the whole design or the selection" },
      { label: "Cross stitch shapes…", icon: StitchCross, run: () => s.setDialog("crossstitch"), disabled: !selected.some((o) => o.stitch.type === "fill") },
      {
        label: "Gradient",
        icon: GradientTool,
        disabled: !oneFill,
        sub: [
          { label: "Colour blending", icon: Blend, run: gradient("blend", "Drag across the shape: this colour fades out, the next fades in"), disabled: !oneFill },
          { label: "Density gradient", icon: DensityMap, run: gradient("density", "Drag across the shape: dense where you start, open where you end"), disabled: !oneFill },
        ],
      },
      tool("guides", "Stitch direction", "D", "Draw guide lines the rows follow"),
      { label: "Test swatches…", icon: Grid2x2Check, run: () => s.setDialog("swatches"), disabled: !hasSel },
      { label: "Calibrate fabric…", icon: Ruler, run: () => s.setDialog("calibrate"), hint: "Sew a swatch, measure it: new objects on the fabric start from your pull compensation" },
      "-",
      {
        label: "Basting",
        icon: Basting,
        sub: [
          { label: "None", run: () => setOpts({ basting: "none" }), checked: opts.basting === "none" },
          { label: "Box around the design", run: () => setOpts({ basting: "box" }), checked: opts.basting === "box" },
          { label: "Following the design", run: () => setOpts({ basting: "contour" }), checked: opts.basting === "contour" },
        ],
      },
      { label: "Optimise stitch order", icon: SewOrder, run: optimizeOrder, hint: "Fewer colour changes, jumps and trims" },
      "-",
      toggle("Remove hidden stitching", !!opts.removeOverlaps, () => setOpts({ removeOverlaps: !opts.removeOverlaps }), undefined, "Leave out what lies under the objects on top"),
      toggle("Show hidden stitching", s.showHidden, () => s.set({ showHidden: !s.showHidden }), undefined, "Mark what is left out on the canvas (Design ▸ Hidden stitching)"),
      {
        label: "Clean up tiny objects",
        run: () => {
          const n = cleanupDocument(s.commit, s.doc);
          s.toast(n ? `Removed ${n} tiny or empty object${n > 1 ? "s" : ""}` : "Nothing to clean up");
        },
      },
      { label: "Troubleshoot…", run: () => showIssues(), hint: "The Issues panel" },
    ],
    Threads: [
      { label: "Thread colours…", icon: Spool, run: () => s.setDialog("threads") },
      "-",
      {
        label: "Fit design to My threads",
        run: async () => {
          const r = await fitThreads({ kind: "mine" });
          if (!r) return s.toast("My threads is empty — add your spools in Thread colours… → My threads");
          s.toast(`Fitted ${r.fitted} threads to your spools${r.shared ? ` · ${r.shared} sharing a spool` : ""}${r.far.length ? ` · ${r.far.length} without a close spool` : ""}`, r.far.length ? "info" : "success");
        },
      },
      {
        label: "Revert fitted colours",
        run: () => {
          const n = revertFit();
          s.toast(n ? `${n} thread${n === 1 ? "" : "s"} back to their original colours` : "No fitted threads");
        },
        disabled: !Object.keys(s.doc.threadSources ?? {}).length,
      },
      { label: `Match all to ${chartLabel(lastChart())}`, run: async () => s.toast(`Matched ${await matchAll(lastChart())} threads to ${chartLabel(lastChart())}`, "success") },
      "-",
      { label: `Merge similar colours (ΔE < ${mergeTolerance()})`, run: mergeSimilarColours, hint: "Threads this close share a spool; the tolerance is set in Thread colours" },
      {
        label: "Remove unused threads",
        run: () => {
          const n = removeUnused();
          s.toast(n ? `Removed ${n} unused thread${n === 1 ? "" : "s"}` : "Every thread is in use");
        },
      },
      { label: "Sort threads by sew order", run: sortBySewOrder },
      "-",
      {
        label: "Palette",
        sub: [
          { label: "Import (.gpl)…", run: async () => s.toast(`Added ${await importPalette()} threads`) },
          { label: "Export (.gpl)…", run: () => exportPalette() },
        ],
      },
      {
        label: "Thread list",
        sub: [
          { label: "Apply (TXT, COL, EDR, INF)…", run: chooseThreadList },
          { label: "Export (TXT)…", run: () => exportTarget("threadlist", {}, PICTURE_SETTINGS, s.doc.name || "design"), disabled: !s.doc.objects.length },
        ],
      },
    ],
    View: [
      mode("vector", "Vector", "1"),
      mode("stitch", "Stitches", "2"),
      mode("realistic", "Realistic", "3"),
      "-",
      {
        label: "Show",
        sub: [
          toggle("Jump stitches", s.showJumps, () => s.set({ showJumps: !s.showJumps })),
          toggle("Underlay", s.showUnderlay, () => s.set({ showUnderlay: !s.showUnderlay })),
          toggle("Grid", s.showGrid, () => s.set({ showGrid: !s.showGrid })),
          {
            label: "Grid spacing",
            sub: [
              { label: "Automatic (5 / 10 mm)", run: () => s.set({ gridStep: 0, showGrid: true }), checked: !s.gridStep },
              ...[1, 2, 2.5, 5, 10].map((g): MenuItem => ({ label: `${g} mm`, run: () => s.set({ gridStep: g, showGrid: true }), checked: s.gridStep === g })),
              ...(s.gridStep && ![1, 2, 2.5, 5, 10].includes(s.gridStep) ? [{ label: `${s.gridStep} mm (cross stitch cells)`, checked: true, run: () => {} } as MenuItem] : []),
            ],
          },
          toggle("Density map", s.showDensity, () => s.set({ showDensity: !s.showDensity }), "⇧D"),
        ],
      },
      {
        label: "Stitch colours",
        sub: [
          ...STITCH_COLORS.map((c): MenuItem => ({ label: c.label, hint: c.title, run: () => s.set({ stitchColors: c.id }), checked: s.stitchColors === c.id })),
          "-",
          { label: "Only the active colour", run: () => s.set({ colorFocus: !s.colorFocus }), checked: s.colorFocus, disabled: !s.activeThread },
        ],
      },
      {
        label: "Snapping",
        sub: [
          toggle("Smart guides", s.smartGuides, () => s.set({ smartGuides: !s.smartGuides }), undefined, "Snap to other objects and the hoop while moving (Ctrl while dragging: off)"),
          toggle("Snap to points", s.prefs.snapPoints, () => s.setPrefs({ snapPoints: !s.prefs.snapPoints }), undefined, "Pen and node tool: points snap to existing points"),
        ],
      },
      "-",
      { label: "Zoom in", icon: ZoomIn, kbd: "+", run: () => zoomBy(1.25) },
      { label: "Zoom out", icon: ZoomOut, kbd: "−", run: () => zoomBy(0.8) },
      "-",
      { label: "Fit hoop", kbd: "0", run: () => fit("hoop") },
      { label: "Fit design", kbd: "⇧0", run: () => fit("design") },
      { label: "Actual size", run: () => fit(1) },
      "-",
      {
        label: "Panels",
        sub: [
          toggle("Layers panel", s.layout.showOutline, () => s.setLayout({ showOutline: !s.layout.showOutline }), undefined, "Layers and issues"),
          toggle("Properties panel", s.layout.showInspector, () => s.setLayout({ showInspector: !s.layout.showInspector }), undefined, "The selection's and the design's settings"),
          { label: s.layout.showOutline || s.layout.showInspector ? "Hide panels" : "Show panels", kbd: `${mod}\\`, run: togglePanels, hint: "More room for the canvas" },
          "-",
          { label: "Issues", run: () => showIssues(), checked: s.layout.showOutline && s.outlineTab === "issues" },
          { label: "Design settings", run: () => showDesign(), checked: s.layout.showInspector && s.inspectorTab === "design" },
          "-",
          { label: "Layers on the left", run: () => s.setLayout({ outlineSide: "left" }), checked: s.layout.outlineSide === "left", hint: "Layers left of the canvas, properties right" },
          { label: "Layers above properties", run: () => s.setLayout({ outlineSide: "right" }), checked: s.layout.outlineSide === "right", hint: "Both panels on the right, one above the other" },
          { label: "Reset panel layout", run: () => s.setLayout({ ...DEFAULT_LAYOUT }) },
        ],
      },
      {
        label: "Theme",
        sub: [
          { label: "Light", run: () => s.setTheme("light"), checked: s.theme === "light" },
          { label: "Dark", run: () => s.setTheme("dark"), checked: s.theme === "dark" },
        ],
      },
      toggle("Shortcut hints", s.prefs.hints, () => s.setPrefs({ hints: !s.prefs.hints })),
    ],
    Tools: [
      tool("select", "Select", "V"),
      tool("pan", "Pan", "H"),
      tool("ruler", "Ruler", "M"),
      tool("node", "Edit nodes", "A"),
      tool("cut", "Cutter", "C"),
      "-",
      tool("pen", "Pen", "P"),
      tool("freehand", "Freehand", "F"),
      tool("satin", "Satin column", "S"),
      tool("rect", "Rectangle", "R"),
      tool("ellipse", "Ellipse", "E"),
      tool("text", "Lettering", "T"),
      "-",
      tool("gradient", "Gradient", "G"),
      tool("guides", "Stitch direction", "D"),
      tool("builder", "Shape builder", "B"),
    ],
    Help: [
      { label: "Command palette…", kbd: `${mod}K`, run: () => s.setDialog("palette"), hint: "Find any command by name" },
      { label: "Keyboard shortcuts", kbd: "?", run: () => s.setDialog("shortcuts") },
      { label: "Ink/Stitch documentation", run: () => void openExternal("https://inkstitch.org/docs/") },
      "-",
      { label: "Optional downloads…", run: () => s.openSettings("downloads"), hint: "Fonts and thread charts Filum can't include: accept their licence and download them" },
      { label: "Licences…", run: () => s.setDialog("licenses") },
      { label: "About Filum", run: () => s.setDialog("about") },
    ],
  };
}

/** Every runnable command with its menu path (for the command palette). */
export function flattenMenus(menus: Record<string, MenuItem[]>): { path: string[]; item: MenuEntry }[] {
  const out: { path: string[]; item: MenuEntry }[] = [];
  const walk = (items: MenuItem[], path: string[]) => {
    for (const it of items) {
      if (it === "-") continue;
      if (it.sub) walk(it.sub, [...path, it.label]);
      else if (it.run) out.push({ path, item: it });
    }
  };
  for (const [name, items] of Object.entries(menus)) walk(items, [name]);
  return out;
}

/** The canvas's right-click menu: the commands for what was clicked, taken from the menus. */
export function contextMenu(onObject: boolean): MenuItem[] {
  const menus = buildMenus();
  const find = (menu: string, ...labels: string[]): MenuItem[] => {
    const out: MenuItem[] = [];
    for (const label of labels) {
      const it = menus[menu]?.find((x) => x !== "-" && x.label === label);
      if (it) out.push(it);
    }
    return out;
  };
  if (!onObject)
    return [
      ...find("Edit", "Paste", "Paste in place"),
      "-",
      ...find("Edit", "Select all"),
      "-",
      ...find("Object", "Show all", "Unlock all"),
      "-",
      ...find("View", "Fit hoop", "Fit design"),
      "-",
      ...find("File", "Add reference picture…", "Digitize a picture…"),
    ];
  return [
    ...find("Edit", "Cut", "Copy", "Paste", "Duplicate", "Delete"),
    "-",
    ...find("Object", "Stitch order", "Align", "Rotate", "Mirror horizontally", "Mirror vertically"),
    "-",
    ...find("Object", "Group", "Ungroup", "Hide", "Lock"),
    "-",
    ...find("Edit", "Select same", "Stitch properties"),
    "-",
    ...find("Path", "Convert"),
  ];
}
