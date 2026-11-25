// What the canvas's gesture modules (canvas/gestures/) work with: the
// component's refs and helpers, handed over as one object per render.

import type { useStore } from "../store";
import type { DesignObject, StitchDocument, StitchParams, SubPath, Vec2 } from "../types";
import type { ShapeRegion } from "../engine/client";
import type { FreehandStroke } from "./freehand";
import type { Handle } from "./handles";
import type { MenuItem } from "../components/menuModel";
import type { selectedGradient } from "../lib/gradient";
import type { Box } from "../lib/geometry";
import type { PointerEvent as RPointerEvent } from "react";
import type { InteractiveOverlay } from "./interactive";
import type { Overlay } from "./render";
import type { PenDraft } from "./penTool";
import type { freshCopies } from "../lib/copies";

import type { Drag } from "./drag";

export type { Drag };

/** The editor's state as the store has it now. */
export type StoreState = ReturnType<typeof useStore.getState>;

/** A mutable ref (React's, without depending on its version's type name). */
export interface Ref<T> {
  current: T;
}

export interface CanvasCtx {
  /** Draw the canvas again (the overlays changed). */
  draw: () => void;
  /** The interactive overlay: guides, tooltips, drafts. */
  iRef: Ref<InteractiveOverlay>;
  /** A transform's pivot, moved by hand (for the selection with this key). */
  pivotRef: Ref<{ key: string; p: Vec2 } | null>;
  /** An object transformed by a matrix (its fill angle turned along). */
  xform: (o: DesignObject, m: number[], rot?: number) => DesignObject;
  /** Copies of objects in place (Alt-drag). */
  cloneObjects: (objs: DesignObject[]) => ReturnType<typeof freshCopies>;
  /** The selection's key (its ids, sorted). */
  selKey: () => string;
  /** The renderer's overlay: drafts, snapping, marquees. */
  overlayRef: Ref<Overlay>;
  /** The object under a point (mm), or none. */
  pick: (p: Vec2) => DesignObject | null;
  /** A pointer's position on the canvas (mm). */
  toMm: (e: { clientX: number; clientY: number }) => Vec2;
  /** The path the pen, curve or satin tool is drawing. */
  penRef: Ref<PenDraft | null>;
  /** Space held: the pointer pans. */
  spaceRef: Ref<boolean>;
  /** A point (mm) snapped to another object's point within `tol`, if any (`skip`: point keys left out). */
  snapToNode: (p: Vec2, tol: number, skip?: Set<string>) => Vec2 | null;
  /** The pen's draft made into an object (or the continued one updated). */
  finishPen: (closed: boolean) => void;
  /** A point added to an object's sub-path at a segment (`both`: the satin's other rail too). */
  insertIntoObject: (o: DesignObject, si: number, seg: number, t: number, both?: boolean) => { obj: DesignObject; index: number };
  /** The freehand stroke being drawn. */
  fhRef: Ref<FreehandStroke | null>;
  /** The Split into satins line being dragged. */
  splitLiveRef: Ref<{ a: Vec2; b: Vec2; dir: boolean } | null>;
  /** The shape builder: the selection's regions and the one under the pointer. */
  builderRef: Ref<{ doc: unknown; key: string; ids: string[]; regions: ShapeRegion[] | null; hover: number | null }>;
  /** The shape builder's region at a point (mm), if any. */
  faceAt: (p: Vec2) => number | null;
  /** Merge (or delete) shape builder regions. */
  applyBuild: (faces: number[], del: boolean) => Promise<void>;
  /** A new object with the active thread and the next free name. */
  newObject: (paths: SubPath[], stitch: StitchParams, base: string) => DesignObject;
  /** An object replaced by its parts (cut by the knife). */
  replaceObjects: (orig: DesignObject, parts: DesignObject[]) => void;
  /** The document before a satin's point pairs were freed to move one (a click puts it back). */
  guideFreedFrom: Ref<StitchDocument | null>;
  /** The drag in progress (what a press starts). */
  dragRef: Ref<Drag | null>;
  /** Work out the shape builder's regions for the selection again. */
  refreshRegions: () => void;
  /** A press on a density ramp's ends or line (false: not on one). */
  rampDown: (p: Vec2, tol: number) => boolean;
  /** A press on a mesh or freeform gradient's nodes (false: off the gradient). */
  gradient2DDown: (e: RPointerEvent, p: Vec2, tol: number, sg: NonNullable<ReturnType<typeof selectedGradient>>) => boolean;
  /** The satin guide under the pointer. */
  guideHover: Ref<number | null>;
  /** The handles drawn for the selection. */
  handlesRef: Ref<Handle[]>;
  /** Where a transform turns about: the moved pivot, else the box's middle. */
  pivotOf: (box: Box) => Vec2;
  /** Open the canvas's context menu (null: close it). */
  setCtxMenu: (m: { x: number; y: number; onObject: boolean; items?: MenuItem[] } | null) => void;
}
