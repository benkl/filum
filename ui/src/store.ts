import { create } from "zustand";
import { syncClones } from "./lib/clones";
import { pruneGroups } from "./lib/layerRows";
import { translateMat, type Mat } from "./lib/geometry";
import { engine } from "./engine/client";
import { defaultStitch, uid } from "./lib/geometry";
import { loadPrefs, savePrefs, type Prefs } from "./lib/prefs";
import { loadLayout, saveLayout, type Layout } from "./lib/layout";
import type { DensityMode } from "./lib/density";
import { freshCopies, mergeThreads, placeCopies, remapThreads } from "./lib/copies";
import { settleTexts } from "./lib/textSettle";
import { repairLayers } from "./lib/fillLayers";
import { safeSetItem } from "./lib/storage";
import { checkDoc } from "./lib/docCheck";
import type {
  DensityField,
  DesignObject,
  Fabric,
  GradientKind,
  NodeRef,
  PlanData,
  StitchDocument,
  StitchParams,
  SubPath,
  Thread,
  Tool,
  ViewMode,
} from "./types";

export type StitchPatch = { type?: StitchParams["type"] } & Record<string, unknown>;

export interface View {
  scale: number; // px per mm
  ox: number; // screen px of mm origin
  oy: number;
}

export type DialogName =
  | "calibrate"
  | "swatches"
  | "crossstitch"
  | "palette"
  | "knockdown"
  | "route"
  | "export"
  | "digitize"
  | "fonts"
  | "threads"
  | "production"
  | "shortcuts"
  | "about"
  | "licenses"
  | "repeat"
  | "outline"
  | "effects"
  | "convert"
  | "settings"
  | "threadlist"
  | "rebuild"
  | null;

export interface Toast {
  id: number;
  text: string;
  kind?: "info" | "error" | "success";
}

/** Settings of the drawing tools (persisted). */
export interface ToolOptions {
  pen: { stitch: "running" | "triple"; length: number; closed: "run" | "fill" };
  freehand: { smoothing: number; output: "running" | "triple" | "satin"; width: number; closed: "run" | "fill"; corners?: number; lines?: boolean };
  satin: { width: number };
  /** Rectangle tool: rectangle / polygon / star, corner radius. */
  shape: { kind: "rect" | "polygon" | "star"; radius: number; sides: number; inner: number };
  /** Type of the gradients the gradient tool creates. */
  gradient: {
    kind: GradientKind;
    /** Colour gradients, or density gradients / colour blends. */
    mode?: "colour" | "density" | "blend";
    profile?: import("./types").RampProfile;
    dense?: number;
    sparse?: number;
  };
  /** Shape Builder: drag merges or deletes regions. */
  builder: { mode: "merge" | "delete" };
}
const TOOL_OPTS_KEY = "filum.toolOptions";
export const DEFAULT_TOOL_OPTIONS: ToolOptions = {
  pen: { stitch: "running", length: 2.5, closed: "run" },
  freehand: { smoothing: 0.5, output: "running", width: 3, closed: "run", corners: 65, lines: true },
  satin: { width: 3 },
  gradient: { kind: "linear", mode: "colour", profile: "linear", dense: 0.25, sparse: 2 },
  builder: { mode: "merge" },
  shape: { kind: "rect", radius: 0, sides: 6, inner: 0.5 },
};
function loadToolOptions(): ToolOptions {
  try {
    const raw = JSON.parse(localStorage.getItem(TOOL_OPTS_KEY) ?? "{}");
    const legacyWidth = parseFloat(localStorage.getItem("filum.satinWidth") ?? "");
    return {
      pen: { ...DEFAULT_TOOL_OPTIONS.pen, ...raw.pen },
      freehand: { ...DEFAULT_TOOL_OPTIONS.freehand, ...raw.freehand },
      satin: { ...DEFAULT_TOOL_OPTIONS.satin, ...(legacyWidth > 0 ? { width: legacyWidth } : {}), ...raw.satin },
      gradient: { ...DEFAULT_TOOL_OPTIONS.gradient, ...raw.gradient },
      builder: { ...DEFAULT_TOOL_OPTIONS.builder, ...raw.builder },
      shape: { ...DEFAULT_TOOL_OPTIONS.shape, ...raw.shape },
    };
  } catch {
    return DEFAULT_TOOL_OPTIONS;
  }
}

export interface State {
  doc: StitchDocument;
  selection: string[];
  tool: Tool;
  viewMode: ViewMode;
  theme: "light" | "dark";
  view: View;
  plan: PlanData | null;
  planning: boolean;
  planError: string | null;
  past: StitchDocument[];
  future: StitchDocument[];
  saved: boolean;
  filePath: string | null;
  showJumps: boolean;
  /** The finished piece: the jump threads you snip by hand and the basting left out. */
  finished: boolean;
  showGrid: boolean;
  /** Grid spacing (mm; 0 = automatic). */
  gridStep: number;
  showUnderlay: boolean;
  /** Show on the canvas what hidden-stitch removal takes out. */
  showHidden: boolean;
  /** The objects cut by it, as they are stitched (for that view; see lib/hiddenStitching). */
  hiddenShapes: { index: number; paths: SubPath[] }[] | null;
  /** The stitch-out player: position (null = closed), speed (stitches/s, 0 = auto), whether the view follows the needle. */
  anim: { playing: boolean; index: number | null; speed: number; follow: boolean };
  dialog: DialogName;
  toasts: Toast[];
  activeThread: string | null;
  /** The tab of the layers panel. */
  outlineTab: "layers" | "issues";
  /** Object groups folded in the Layers tab (UI state: remembered, not undone). */
  foldedGroups: string[];
  /** The properties panel: the selection, or the design (follows the selection). */
  inspectorTab: "selection" | "design";
  /** Panel sizes and placement. */
  layout: Layout;
  showDensity: boolean;
  /** What the density map shows (lib/density.ts). */
  densityMode: DensityMode;
  /** The density model of the current plan, while the map is on. */
  density: DensityField | null;
  /** Lettering group whose text is being typed on the canvas. */
  editingText: string | null;
  fabricColor: string;
  /** Fabric texture on the canvas: the design's fabric, another weave, or none. */
  fabricTexture: "auto" | Fabric | "none";
  /** The fabric also in the vector and stitch views. */
  fabricAll: boolean;
  /** Draw the weave coarse enough to see when zoomed out (else true size). */
  fabricWeave: boolean;
  toolOptions: ToolOptions;
  /** Snap to other objects and the hoop while moving and scaling. */
  smartGuides: boolean;
  /** Hint shown in the tool options bar while drawing. */
  drawHint: string | null;
  /** Selected mesh nodes / freeform points of the selected gradient. */
  gradNodes: number[];
  /** Selected path nodes (node tool). */
  nodeSel: NodeRef[];
  /** Reference picture being adjusted on the canvas. */
  refEdit: string | null;
  /** How stitches are coloured on screen: thread colours, one hue per colour block, or monochrome. */
  stitchColors: "thread" | "sequence" | "mono";
  /** Dim every colour but the active thread. */
  colorFocus: boolean;
  /** User preferences (look, hints, nudging, autosave). */
  prefs: Prefs;
  /** Section the settings dialog opens at. */
  settingsTab: string;
  /** A pen or satin path is being drawn (for the shortcut hints). */
  drafting: boolean;
  /**
   * Objects being moved, scaled, rotated or skewed by a drag: the matrix from
   * where they were when the drag began. The plan is not recomputed meanwhile
   * — the renderer moves the stitches it has — and is once the drag ends.
   */
  live: { ids: string[]; m: Mat } | null;

  // actions
  setDoc: (doc: StitchDocument, opts?: { history?: boolean; keepSelection?: boolean }) => void;
  checkpoint: () => void;
  /** A drag that changed nothing: take back its checkpoint (the redo steps and saved state come back). */
  dropCheckpoint: () => void;
  liveUpdate: (fn: (d: StitchDocument) => StitchDocument) => void;
  /** A drag transform: the document and the live matrix together; `null` ends it. */
  liveTransform: (live: { ids: string[]; m: Mat } | null, fn?: (d: StitchDocument) => StitchDocument) => void;
  commit: (fn: (d: StitchDocument) => StitchDocument) => void;
  undo: () => void;
  redo: () => void;
  select: (ids: string[]) => void;
  setTool: (t: Tool) => void;
  setViewMode: (m: ViewMode) => void;
  setTheme: (t: "light" | "dark") => void;
  setView: (v: Partial<View>) => void;
  updateObject: (id: string, patch: Partial<DesignObject>) => void;
  /** A stitch change for one object or several (all of the same stitch type, edited together). */
  updateStitch: (id: string | string[], patch: StitchPatch, live?: boolean) => void;
  addObjects: (objs: DesignObject[], threads?: Thread[], groupParents?: Record<string, string>, groupNames?: Record<string, string>) => void;
  deleteSelection: () => void;
  duplicateSelection: () => void;
  moveInOrder: (id: string, delta: number) => void;
  reorder: (id: string, toIndex: number) => void;
  ensureThread: (color: string, name?: string) => string;
  setFabric: (f: Fabric) => void;
  toast: (text: string, kind?: Toast["kind"]) => void;
  setDialog: (d: DialogName) => void;
  set: (p: Partial<State>) => void;
  setToolOptions: <K extends keyof ToolOptions>(tool: K, patch: Partial<ToolOptions[K]>) => void;
  setPrefs: (patch: Partial<Prefs>) => void;
  setLayout: (patch: Partial<Layout>) => void;
  openSettings: (tab?: string) => void;
}

const THEME_KEY = "filum.theme";
/** The last checkpoint, so a drag that changed nothing can take it back. */
let pendingCheckpoint: { doc: StitchDocument; future: StitchDocument[]; saved: boolean } | null = null;
/** View toggles remembered between sessions. */
const VIEW_KEY = "filum.view";
const VIEW_FIELDS = ["showGrid", "showJumps", "finished", "showUnderlay", "showHidden", "smartGuides", "stitchColors", "fabricColor", "fabricTexture", "fabricAll", "fabricWeave", "densityMode", "foldedGroups"] as const;
const savedView: Partial<Pick<State, (typeof VIEW_FIELDS)[number]>> = (() => {
  try {
    return JSON.parse(localStorage.getItem(VIEW_KEY) ?? "{}");
  } catch {
    return {};
  }
})();
const DOC_KEY = "filum.autosave";
const DIRTY_KEY = "filum.autosave.dirty";
/** The stitch-out player's speed and follow setting, remembered between sessions. */
const PLAYER_KEY = "filum.player";
function playerPrefs(): { speed: number; follow: boolean } {
  try {
    const p = JSON.parse(localStorage.getItem(PLAYER_KEY) ?? "{}");
    return { speed: typeof p.speed === "number" && p.speed >= 0 ? p.speed : 0, follow: p.follow === true };
  } catch {
    return { speed: 0, follow: false };
  }
}

export const emptyDoc = (): StitchDocument => ({
  version: 1,
  name: "Untitled",
  threads: [],
  objects: [],
  hoop: { name: "100 × 100 mm", width: 100, height: 100 },
  fabric: "cotton",
  machine: {
    trimDistance: 3,
    ties: true,
    minStitch: 0.3,
    maxStitch: 12.1,
    spm: 800,
    trimSeconds: 6,
    colorChangeSeconds: 12,
  },
});

/** The thread new objects get: the one last picked, if the design still has it. */
export const activeThreadOf = (s: { activeThread: string | null; doc: StitchDocument }): string | null =>
  s.activeThread && s.doc.threads.some((t) => t.id === s.activeThread) ? s.activeThread : null;

export const useStore = create<State>((set, get) => ({
  doc: emptyDoc(),
  selection: [],
  tool: "select",
  viewMode: "vector",
  theme: (localStorage.getItem(THEME_KEY) as "light" | "dark") ?? "light",
  view: { scale: 5, ox: 100, oy: 60 },
  plan: null,
  planning: false,
  planError: null,
  past: [],
  future: [],
  saved: true,
  filePath: null,
  showJumps: false,
  finished: false,
  showGrid: true,
  gridStep: 0,
  showUnderlay: true,
  showHidden: false,
  hiddenShapes: null,
  anim: { playing: false, index: null, ...playerPrefs() },
  dialog: null,
  toasts: [],
  activeThread: null,
  outlineTab: "layers",
  foldedGroups: [],
  inspectorTab: "design",
  layout: loadLayout(),
  showDensity: false,
  densityMode: "coverage",
  density: null,
  editingText: null,
  toolOptions: loadToolOptions(),
  smartGuides: true,
  drawHint: null,
  gradNodes: [],
  nodeSel: [],
  refEdit: null,
  stitchColors: "thread",
  colorFocus: false,
  fabricColor: "#f4f1ea",
  fabricTexture: "auto",
  fabricAll: true,
  fabricWeave: true,
  prefs: loadPrefs(),
  settingsTab: "appearance",
  drafting: false,
  live: null,
  ...savedView,

  setDoc: (doc0, opts) => {
    const s = get();
    const doc = settleTexts(syncClones(doc0));
    pendingCheckpoint = null;
    set({
      nodeSel: opts?.keepSelection ? s.nodeSel.filter((n) => doc.objects.find((o) => o.id === n.id)?.paths[n.sp]?.nodes[n.ni]) : [],
      doc,
      past: opts?.history === false ? s.past : [...s.past.slice(-99), s.doc],
      future: opts?.history === false ? s.future : [],
      selection: opts?.keepSelection ? s.selection.filter((id) => doc.objects.some((o) => o.id === id)) : [],
      saved: false,
    });
  },
  checkpoint: () => {
    const s = get();
    pendingCheckpoint = { doc: s.doc, future: s.future, saved: s.saved };
    set({ past: [...s.past.slice(-99), s.doc], future: [], saved: false });
  },
  dropCheckpoint: () => {
    const s = get();
    const cp = pendingCheckpoint;
    pendingCheckpoint = null;
    if (cp && s.doc === cp.doc && s.past[s.past.length - 1] === cp.doc) set({ past: s.past.slice(0, -1), future: cp.future, saved: cp.saved });
  },
  // clones follow their originals; a lettering moved apart letter by letter becomes plain shapes
  liveUpdate: (fn) => set({ doc: settleTexts(syncClones(fn(get().doc), get().doc), get().doc), saved: false }),
  liveTransform: (live, fn) => set(fn ? { live, doc: settleTexts(syncClones(fn(get().doc), get().doc), get().doc), saved: false } : { live }),
  commit: (fn) => {
    const s = get();
    pendingCheckpoint = null;
    const doc = settleTexts(syncClones(fn(s.doc), s.doc), s.doc);
    // ids of objects the change removed leave the selection
    let selection = s.selection;
    if (selection.length && doc.objects !== s.doc.objects) {
      const ids = new Set(doc.objects.map((o) => o.id));
      if (!selection.every((id) => ids.has(id))) selection = selection.filter((id) => ids.has(id));
    }
    set({ past: [...s.past.slice(-99), s.doc], future: [], doc, saved: false, live: null, ...(selection !== s.selection ? { selection } : {}) });
  },
  undo: () => {
    const s = get();
    const prev = s.past[s.past.length - 1];
    if (!prev) return;
    pendingCheckpoint = null;
    set({
      doc: prev,
      past: s.past.slice(0, -1),
      future: [s.doc, ...s.future],
      selection: s.selection.filter((id) => prev.objects.some((o) => o.id === id)),
      // point indices may name other points now
      nodeSel: [],
      gradNodes: [],
      saved: false,
    });
  },
  redo: () => {
    const s = get();
    const next = s.future[0];
    if (!next) return;
    pendingCheckpoint = null;
    set({
      doc: next,
      past: [...s.past, s.doc],
      future: s.future.slice(1),
      selection: s.selection.filter((id) => next.objects.some((o) => o.id === id)),
      nodeSel: [],
      gradNodes: [],
      saved: false,
    });
  },
  select: (ids) => set({ selection: ids, gradNodes: [], nodeSel: get().nodeSel.filter((n) => ids.includes(n.id)) }),
  setTool: (tool) => set({ tool, nodeSel: [], refEdit: null }),
  setViewMode: (viewMode) => set({ viewMode }),
  setTheme: (theme) => {
    safeSetItem(THEME_KEY, theme);
    set({ theme });
  },
  setView: (v) => set({ view: { ...get().view, ...v } }),
  updateObject: (id, patch) =>
    get().commit((d) => ({ ...d, objects: d.objects.map((o) => (o.id === id ? { ...o, ...patch } : o)) })),
  updateStitch: (id, patch, live) => {
    const ids = new Set(typeof id === "string" ? [id] : id);
    const fn = (d: StitchDocument) => ({
      ...d,
      objects: d.objects.map((o) => {
        if (!ids.has(o.id)) return o;
        const next =
          "type" in patch && patch.type && patch.type !== o.stitch.type
            ? defaultStitch(patch.type as StitchParams["type"], o.stitch)
            : ({ ...o.stitch, ...patch } as StitchParams);
        return { ...o, stitch: next };
      }),
    });
    if (live) get().liveUpdate(fn);
    else get().commit(fn);
  },
  addObjects: (objs, threads, groupParents, groupNames) =>
    get().commit((d) => {
      // threads from elsewhere (clipboard, another design): the same colour is reused,
      // an id that is another colour here gets a new one
      const { add, map } = mergeThreads(d.threads, threads ?? []);
      const placed = map.size ? objs.map((o) => remapThreads(o, (id) => map.get(id) ?? id)) : objs;
      const parents = groupParents && Object.keys(groupParents).length ? { ...d.groupParents, ...groupParents } : d.groupParents;
      const names = groupNames && Object.keys(groupNames).length ? { ...d.groupNames, ...groupNames } : d.groupNames;
      // groups a paste holds only one thing of dissolve (one object copied out of a group);
      // a gradient or tartan copied only in part is renumbered (one layer: a plain fill)
      return pruneGroups(
        repairLayers({
          ...d,
          threads: [...d.threads, ...add],
          objects: [...d.objects, ...placed],
          ...(parents ? { groupParents: parents } : {}),
          ...(names ? { groupNames: names } : {}),
        }),
      );
    }),
  deleteSelection: () => {
    const sel = new Set(get().selection);
    if (!sel.size) return;
    // a gradient or tartan that lost colour layers is renumbered (one layer left: a plain fill)
    get().commit((d) => pruneGroups(repairLayers({ ...d, objects: d.objects.filter((o) => !sel.has(o.id) || o.locked) })));
    set({ selection: [] });
  },
  duplicateSelection: () => {
    const sel = new Set(get().selection);
    if (!sel.size) return;
    const doc = get().doc;
    // copies of their own: new groups, letterings, gradients and blends, 5 mm on
    const fresh = freshCopies(
      doc,
      doc.objects.filter((o) => sel.has(o.id)),
      { inPlace: true },
    );
    const copies = placeCopies(fresh.objects, translateMat(5, 5)).map((c) => ({ ...c, name: `${c.name} copy` }));
    get().addObjects(copies, undefined, fresh.parents, fresh.names);
    set({ selection: copies.map((c) => c.id) });
  },
  moveInOrder: (id, delta) =>
    get().commit((d) => {
      const i = d.objects.findIndex((o) => o.id === id);
      const j = Math.max(0, Math.min(d.objects.length - 1, i + delta));
      if (i < 0 || i === j) return d;
      const objs = d.objects.slice();
      const [o] = objs.splice(i, 1);
      objs.splice(j, 0, o);
      return { ...d, objects: objs };
    }),
  reorder: (id, toIndex) =>
    get().commit((d) => {
      const i = d.objects.findIndex((o) => o.id === id);
      if (i < 0) return d;
      const objs = d.objects.slice();
      const [o] = objs.splice(i, 1);
      objs.splice(Math.max(0, Math.min(objs.length, toIndex)), 0, o);
      return { ...d, objects: objs };
    }),
  ensureThread: (color, name) => {
    const d = get().doc;
    const hit = d.threads.find((t) => t.color.toLowerCase() === color.toLowerCase());
    if (hit) return hit.id;
    const id = uid("t");
    const t: Thread = { id, name: name ?? color.toUpperCase(), color, brand: "", code: "" };
    set({ doc: { ...d, threads: [...d.threads, t] } });
    return id;
  },
  setFabric: (fabric) => get().commit((d) => ({ ...d, fabric })),
  toast: (text, kind = "info") => {
    const id = Date.now() + Math.random();
    set({ toasts: [...get().toasts, { id, text, kind }] });
    setTimeout(() => set({ toasts: get().toasts.filter((t) => t.id !== id) }), kind === "error" ? 6000 : 3500);
  },
  setDialog: (dialog) => set({ dialog }),
  set: (p) => set(p),
  setLayout: (patch) => {
    const layout = { ...get().layout, ...patch };
    saveLayout(layout);
    set({ layout });
  },
  setPrefs: (patch) => {
    const prefs = { ...get().prefs, ...patch };
    savePrefs(prefs);
    set({ prefs });
  },
  openSettings: (tab) => set({ dialog: "settings", ...(tab ? { settingsTab: tab } : {}) }),
  setToolOptions: (tool, patch) => {
    const toolOptions = { ...get().toolOptions, [tool]: { ...get().toolOptions[tool], ...patch } };
    safeSetItem(TOOL_OPTS_KEY, JSON.stringify(toolOptions));
    set({ toolOptions });
  },
}));

/** The plan of each document the editor planned (side views reuse it instead of planning again). */
export const planOf = new WeakMap<StitchDocument, PlanData>();

// Re-plan whenever the document changes (latest wins inside the client): on
// the next frame, so a burst of changes in one frame plans once, without a
// fixed delay on every edit.
let planFrame: unknown = 0;
const nextFrame = (f: () => void): unknown => (typeof requestAnimationFrame === "function" ? requestAnimationFrame(f) : setTimeout(f, 0));
let lastPlanned: StitchDocument | null = null;
/** Same document for the engine (reference pictures are not stitched). */
const sameForEngine = (a: StitchDocument | null, b: StitchDocument) =>
  !!a && (Object.keys(b) as (keyof StitchDocument)[]).every((k) => k === "references" || a[k] === b[k]) && Object.keys(a).length === Object.keys(b).length;
useStore.subscribe((s) => {
  // a drag moves the stitches it has; the plan follows when it ends
  if (s.live) return;
  if (s.doc === lastPlanned) return;
  const skip = sameForEngine(lastPlanned, s.doc);
  lastPlanned = s.doc;
  if (skip) return;
  if (planFrame) return;
  planFrame = nextFrame(() => {
    planFrame = 0;
    const doc = useStore.getState().doc;
    useStore.setState({ planning: true });
    engine
      .plan(doc)
      .then((plan) => {
        planOf.set(doc, plan);
        useStore.setState({ plan, planning: false, planError: null });
      })
      .catch((e: Error) => {
        if (e.message !== "superseded") useStore.setState({ planning: false, planError: e.message });
      });
  });
});

// The density model follows the plan while the map is on (one request at a
// time, the latest plan next).
let densityBusy = false;
let densityFor: PlanData | null = null;
function requestDensity() {
  const s = useStore.getState();
  if (densityBusy || !s.showDensity || !s.plan || s.plan === densityFor) return;
  densityBusy = true;
  densityFor = s.plan;
  engine
    .densityField(s.doc)
    .then((density) => useStore.setState({ density }))
    // a failure waits for the next plan (retrying the same one would loop)
    .catch(() => {})
    .finally(() => {
      densityBusy = false;
      requestDensity();
    });
}
useStore.subscribe((s, p) => {
  if (s.showDensity && (s.plan !== p.plan || !p.showDensity)) requestDensity();
});

// Autosave to local storage (desktop users also get real files via Save).
let saveTimer: ReturnType<typeof setTimeout> | null = null;
useStore.subscribe((s, prev) => {
  if (s.anim.speed !== prev.anim.speed || s.anim.follow !== prev.anim.follow) safeSetItem(PLAYER_KEY, JSON.stringify({ speed: s.anim.speed, follow: s.anim.follow }));
  if (VIEW_FIELDS.some((k) => s[k] !== prev[k])) safeSetItem(VIEW_KEY, JSON.stringify(Object.fromEntries(VIEW_FIELDS.map((k) => [k, s[k]]))));
  if (!s.prefs.autosave) return;
  // whether the autosaved design has changes not in a file (asked about before it's replaced)
  if (s.saved !== prev.saved && !autosaveDiscarded) safeSetItem(DIRTY_KEY, s.saved ? "0" : "1");
  if (s.doc === prev.doc) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void flushAutosave(), 600);
});

let autosaveWarned = false;
/** Write the autosave now (also when the window closes). */
/**
 * Write the autosave now (also when the window closes). True when the whole
 * design is in it (false: autosave is off, or the pictures or all of it
 * didn't fit).
 */
export function flushAutosave(): boolean {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  const s = useStore.getState();
  if (!s.prefs.autosave || autosaveDiscarded) return false;
  safeSetItem(DIRTY_KEY, s.saved ? "0" : "1");
  if (safeSetItem(DOC_KEY, JSON.stringify(s.doc))) return true;
  // quota: keep the design, drop the reference pictures from the autosave
  if (safeSetItem(DOC_KEY, JSON.stringify({ ...s.doc, references: undefined }))) return !s.doc.references?.length;
  // not even that: an old autosave must not come back in its place
  localStorage.removeItem(DOC_KEY);
  if (!autosaveWarned) {
    autosaveWarned = true;
    s.toast("The design is too big to autosave: save it to a file", "error");
  }
  return false;
}

let autosaveDiscarded = false;
/** Forget the autosave for good in this session (the error screen's "Start afresh" reloads after it). */
export function discardAutosave() {
  autosaveDiscarded = true;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  localStorage.removeItem(DOC_KEY);
  localStorage.removeItem(DIRTY_KEY);
}

/** The autosaved design (checked), and whether it had unsaved changes. */
export function loadAutosave(): { doc: StitchDocument; dirty: boolean } | null {
  try {
    const raw = localStorage.getItem(DOC_KEY);
    const checked = raw ? checkDoc(JSON.parse(raw), emptyDoc()) : null;
    return checked ? { doc: checked.doc, dirty: localStorage.getItem(DIRTY_KEY) === "1" } : null;
  } catch {
    return null;
  }
}

export const selectedObjects = (s: State) => s.doc.objects.filter((o) => s.selection.includes(o.id));
export const threadOf = (doc: StitchDocument, id: string) => doc.threads.find((t) => t.id === id);
