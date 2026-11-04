// User preferences that outlive a design: look, hints, nudging, autosave.
// The view toggles (grid, guides, …) are remembered by the store itself.

export interface Prefs {
  /** Highlight colour of the interface (hex). */
  accent: string;
  /** Contextual shortcut hints along the bottom. */
  hints: boolean;
  /** Arrow keys move objects by this much (mm), with Shift by `nudgeBig`. */
  nudge: number;
  nudgeBig: number;
  /** Arrow keys move selected points (node tool). */
  nodeNudge: number;
  nodeNudgeBig: number;
  /** Keep the design in the browser storage while working. */
  autosave: boolean;
  /** New points (pen, node tool) snap to existing points. */
  snapPoints: boolean;
}

/** The app colour (the icon's violet). */
export const APP_COLOR = "#7c3aed";

export const DEFAULT_PREFS: Prefs = {
  accent: APP_COLOR,
  hints: true,
  nudge: 0.5,
  nudgeBig: 5,
  nodeNudge: 0.1,
  nodeNudgeBig: 1,
  autosave: true,
  snapPoints: true,
};

export const ACCENTS: { color: string; label: string }[] = [
  { color: APP_COLOR, label: "Filum violet" },
  { color: "#b3203a", label: "Crimson" },
  { color: "#d9480f", label: "Orange" },
  { color: "#0f8a7e", label: "Teal" },
  { color: "#2b8a3e", label: "Green" },
  { color: "#1971c2", label: "Blue" },
  { color: "#c2255c", label: "Raspberry" },
  { color: "#495057", label: "Graphite" },
];

const KEY = "filum.prefs";

export function loadPrefs(): Prefs {
  try {
    return { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") };
  } catch {
    return DEFAULT_PREFS;
  }
}

export function savePrefs(p: Prefs) {
  localStorage.setItem(KEY, JSON.stringify(p));
}

const rgb = (hex: string) => {
  const v = parseInt(hex.replace("#", "").padEnd(6, "0").slice(0, 6), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
};
const hex = (c: number[]) => "#" + c.map((x) => Math.round(Math.max(0, Math.min(255, x))).toString(16).padStart(2, "0")).join("");
/** a + (b − a)·t */
const mix = (a: string, b: string, t: number) => {
  const x = rgb(a);
  const y = rgb(b);
  return hex(x.map((v, i) => v + (y[i] - v) * t));
};

/**
 * The interface colours from one accent: buttons, highlights and the canvas
 * selection (plain hex — the canvas appends alpha to it).
 */
export function applyAccent(accent: string, theme: "light" | "dark") {
  const s = document.documentElement.style;
  const [r, g, b] = rgb(accent);
  if (theme === "dark") {
    const a = mix(accent, "#ffffff", 0.12);
    s.setProperty("--accent", a);
    s.setProperty("--accent-hover", accent);
    s.setProperty("--accent-soft", `rgba(${r}, ${g}, ${b}, 0.2)`);
    s.setProperty("--select", mix(accent, "#ffffff", 0.3));
  } else {
    s.setProperty("--accent", accent);
    s.setProperty("--accent-hover", mix(accent, "#000000", 0.14));
    s.setProperty("--accent-soft", `rgba(${r}, ${g}, ${b}, 0.1)`);
    s.setProperty("--select", accent);
  }
  s.setProperty("--accent-fg", "#ffffff");
}
