import { create } from "zustand";
import { syncClones } from "./lib/clones";
import { pruneGroups } from "./lib/layerRows";
import { mulMat, translateMat, type Mat } from "./lib/geometry";
import { engine } from "./engine/client";
import { defaultStitch, uid } from "./lib/geometry";
import { loadPrefs, savePrefs, type Prefs } from "./lib/prefs";
import { loadLayout, saveLayout, type Layout } from "./lib/layout";
import type { DensityMode } from "./lib/density";
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
  updateStitch: (id: string, patch: StitchPatch, live?: boolean) => void;
  addObjects: (objs: DesignObject[], threads?: Thread[]) => void;
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
/** View toggles remembered between sessions. */
const VIEW_KEY = "filum.view";
const VIEW_FIELDS = ["showGrid", "showJumps", "showUnderlay", "showHidden", "smartGuides", "stitchColors", "fabricColor", "fabricTexture", "fabricAll", "fabricWeave", "densityMode", "foldedGroups"] as const;
const savedView: Partial<Pick<State, (typeof VIEW_FIELDS)[number]>> = (() => {
  try {
    return JSON.parse(localStorage.getItem(VIEW_KEY) ?? "{}");
  } catch {
    return {};
  }
})();
const DOC_KEY = "filum.autosave";
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
    const doc = syncClones(doc0);
    set({
      doc,
      past: opts?.history === false ? s.past : [...s.past.slice(-99), s.doc],
      future: opts?.history === false ? s.future : [],
      selection: opts?.keepSelection ? s.selection.filter((id) => doc.objects.some((o) => o.id === id)) : [],
      saved: false,
    });
  },
  checkpoint: () => {
    const s = get();
    set({ past: [...s.past.slice(-99), s.doc], future: [], saved: false });
  },
  liveUpdate: (fn) => set({ doc: syncClones(fn(get().doc), get().doc), saved: false }),
  liveTransform: (live, fn) => set(fn ? { live, doc: syncClones(fn(get().doc), get().doc), saved: false } : { live }),
  commit: (fn) => {
    const s = get();
    set({ past: [...s.past.slice(-99), s.doc], future: [], doc: syncClones(fn(s.doc), s.doc), saved: false, live: null });
  },
  undo: () => {
    const s = get();
    const prev = s.past[s.past.length - 1];
    if (!prev) return;
    set({
      doc: prev,
      past: s.past.slice(0, -1),
      future: [s.doc, ...s.future],
      selection: s.selection.filter((id) => prev.objects.some((o) => o.id === id)),
      saved: false,
    });
  },
  redo: () => {
    const s = get();
    const next = s.future[0];
    if (!next) return;
    set({
      doc: next,
      past: [...s.past, s.doc],
      future: s.future.slice(1),
      selection: s.selection.filter((id) => next.objects.some((o) => o.id === id)),
      saved: false,
    });
  },
  select: (ids) => set({ selection: ids, gradNodes: [], nodeSel: get().nodeSel.filter((n) => ids.includes(n.id)) }),
  setTool: (tool) => set({ tool, nodeSel: [], refEdit: null }),
  setViewMode: (viewMode) => set({ viewMode }),
  setTheme: (theme) => {
    localStorage.setItem(THEME_KEY, theme);
    set({ theme });
  },
  setView: (v) => set({ view: { ...get().view, ...v } }),
  updateObject: (id, patch) =>
    get().commit((d) => ({ ...d, objects: d.objects.map((o) => (o.id === id ? { ...o, ...patch } : o)) })),
  updateStitch: (id, patch, live) => {
    const fn = (d: StitchDocument) => ({
      ...d,
      objects: d.objects.map((o) => {
        if (o.id !== id) return o;
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
  addObjects: (objs, threads) =>
    get().commit((d) => {
      const merged = [...d.threads];
      for (const t of threads ?? []) if (!merged.some((m) => m.id === t.id)) merged.push(t);
      return { ...d, threads: merged, objects: [...d.objects, ...objs] };
    }),
  deleteSelection: () => {
    const sel = new Set(get().selection);
    if (!sel.size) return;
    get().commit((d) => pruneGroups({ ...d, objects: d.objects.filter((o) => !sel.has(o.id) || o.locked) }));
    set({ selection: [] });
  },
  duplicateSelection: () => {
    const sel = new Set(get().selection);
    if (!sel.size) return;
    const copies: DesignObject[] = [];
    for (const o of get().doc.objects)
      if (sel.has(o.id)) {
        const c = structuredClone(o);
        c.id = uid();
        if (c.clone) c.clone = { ...c.clone, m: mulMat(translateMat(5, 5), c.clone.m) };
        c.name = `${o.name} copy`;
        c.paths = c.paths.map((sp) => ({
          ...sp,
          nodes: sp.nodes.map((n) => ({
            p: [n.p[0] + 5, n.p[1] + 5],
            ...(n.i ? { i: [n.i[0] + 5, n.i[1] + 5] } : {}),
            ...(n.o ? { o: [n.o[0] + 5, n.o[1] + 5] } : {}),
          })),
        })) as DesignObject["paths"];
        copies.push(c);
      }
    get().addObjects(copies);
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
    localStorage.setItem(TOOL_OPTS_KEY, JSON.stringify(toolOptions));
    set({ toolOptions });
  },
}));

/** The plan of each document the editor planned (side views reuse it instead of planning again). */
export const planOf = new WeakMap<StitchDocument, PlanData>();

// Re-plan whenever the document changes (latest wins inside the client).
let planTimer: ReturnType<typeof setTimeout> | null = null;
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
  if (planTimer) clearTimeout(planTimer);
  planTimer = setTimeout(() => {
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
  }, 40);
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
    .catch(() => {
      densityFor = null;
    })
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
  if (s.anim.speed !== prev.anim.speed || s.anim.follow !== prev.anim.follow) localStorage.setItem(PLAYER_KEY, JSON.stringify({ speed: s.anim.speed, follow: s.anim.follow }));
  if (VIEW_FIELDS.some((k) => s[k] !== prev[k])) localStorage.setItem(VIEW_KEY, JSON.stringify(Object.fromEntries(VIEW_FIELDS.map((k) => [k, s[k]]))));
  if (s.doc === prev.doc || !s.prefs.autosave) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const doc = useStore.getState().doc;
    try {
      localStorage.setItem(DOC_KEY, JSON.stringify(doc));
    } catch {
      // quota: keep the design, drop the reference pictures from the autosave
      try {
        localStorage.setItem(DOC_KEY, JSON.stringify({ ...doc, references: undefined }));
      } catch {
        /* quota */
      }
    }
  }, 600);
});

export function loadAutosave(): StitchDocument | null {
  try {
    const raw = localStorage.getItem(DOC_KEY);
    return raw ? (JSON.parse(raw) as StitchDocument) : null;
  } catch {
    return null;
  }
}

export const selectedObjects = (s: State) => s.doc.objects.filter((o) => s.selection.includes(o.id));
export const threadOf = (doc: StitchDocument, id: string) => doc.threads.find((t) => t.id === id);
