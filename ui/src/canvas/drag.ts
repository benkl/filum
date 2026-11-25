// What a pointer drag on the canvas is doing (one kind per gesture), and the
// hints the canvas shows over handles.

import { type Box } from "../lib/geometry";
import type { DesignObject, NodeRef, PathNode, ReferenceImage, StitchDocument, Vec2 } from "../types";
import { type Handle } from "./handles";
import { type TextSpec } from "../lib/text";
import { type SnapTargets } from "./transform";
import { type StopEdit } from "../lib/gradient";
import type { GradientParams } from "../types";
import type { CornerStyle } from "../lib/shapeOps";

export type Drag =
  | { kind: "pan"; sx: number; sy: number; ox: number; oy: number }
  | { kind: "marquee"; a: Vec2; add: boolean }
  | { kind: "move"; start: Vec2; orig: DesignObject[]; all: DesignObject[]; moved: boolean; targets: SnapTargets | null }
  | { kind: "scale"; handle: number; box: Box; orig: DesignObject[]; uniform: boolean; targets: SnapTargets | null; pivot: Vec2 }
  | { kind: "rotate"; center: Vec2; a0: number; orig: DesignObject[] }
  | { kind: "skew"; handle: number; box: Box; orig: DesignObject[]; start: Vec2; pivot: Vec2 }
  | { kind: "pivot"; key: string }
  | { kind: "gradvec"; a: Vec2; target: string | null; group: string | null }
  | { kind: "gradend"; which: "from" | "to"; group: string }
  | { kind: "gradstop"; index: number; group: string; stops: StopEdit[]; g: GradientParams }
  | { kind: "gradnode"; group: string; idx: number[]; orig: Vec2[]; start: Vec2; moved: boolean }
  | { kind: "gradspread"; group: string; idx: number }
  | { kind: "corner"; id: string; sp: number; k: number; orig: DesignObject; all: boolean; p: Vec2; dir: Vec2; phi: number }
  | { kind: "node"; id: string; sp: number; ni: number; part: "p" | "i" | "o"; orig: DesignObject }
  | { kind: "shape"; shape: "rect" | "ellipse"; a: Vec2 }
  | { kind: "freehand" }
  | { kind: "ruler"; a: Vec2 }
  | { kind: "handle"; h: Handle; orig: DesignObject; moved: boolean }
  | { kind: "texthandle"; h: Handle; group: string; spec: TextSpec; start: Vec2; moved: boolean; spacingScale?: number }
  | { kind: "pen-new"; idx: number; moved: boolean; last: Vec2 }
  | { kind: "bend"; o: DesignObject; sp: number; seg: number; t: number; start: Vec2; moved: boolean; both: boolean }
  | { kind: "pen-close"; moved: boolean }
  | { kind: "pen-last"; moved: boolean; keepIn?: Vec2 }
  | { kind: "pen-anchor"; idx: number; orig: PathNode; start: Vec2; moved: boolean }
  | { kind: "pen-handle"; idx: number; part: "i" | "o"; orig: PathNode }
  | { kind: "cut"; a: Vec2; moved: boolean }
  | { kind: "split"; a: Vec2; dir: boolean; moved: boolean }
  | { kind: "nodes"; start: Vec2; orig: StitchDocument; sel: NodeRef[]; moved: boolean; anchor: Vec2 }
  | { kind: "nodemarquee"; a: Vec2; add: boolean; sub: boolean; base: NodeRef[]; hit: DesignObject | null }
  | { kind: "ref"; mode: "move" | "scale" | "rotate"; orig: ReferenceImage; start: Vec2; corner: number; a0: number; moved: boolean }
  | { kind: "rampend"; id: string; which: "from" | "to"; moved: boolean }
  | { kind: "rampvec"; a: Vec2; target: string | null; mode: "density" | "blend" }
  | { kind: "build"; faces: number[]; del: boolean }
  | { kind: "guideend"; id: string; index: number; end: 0 | 1; moved: boolean }
  | { kind: "guidemove"; id: string; index: number; start: Vec2; orig: [Vec2, Vec2]; moved: boolean }
  | { kind: "guidedraw"; id: string; a: Vec2 };

export const HANDLE_HINTS: Record<string, string> = {
  angle: "Drag to set the fill angle (Shift: 15° steps)",
  spacing: "Drag to change the density",
  center: "Drag to move the radial centre",
  "width-l": "Drag to change the column width",
  "width-r": "Drag to change the column width",
  reverse: "Click to sew the other way",
  start: "Drag to move the start · double-click for auto",
  end: "Drag to move the end · double-click for auto",
  "text-arc": "Drag up or down to bend the text (Shift: 15° steps) · double-click to straighten",
  "text-spacing": "Drag to change the letter spacing · double-click to reset",
};

/** What the pen and node tools keep between gestures: the style new rounded corners get (Alt-click a corner widget cycles it). */
export const penState: { cornerStyle: CornerStyle } = { cornerStyle: "round" };
