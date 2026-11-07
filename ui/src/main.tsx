import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";
import { flushAutosave, loadAutosave, useStore } from "./store";
import { sampleDocument } from "./sample";
import { engine } from "./engine/client";
import { openDroppedFile, openLaunchFiles } from "./lib/actions";
import { setFabricDefaults } from "./lib/geometry";
import { calibratedDefaults } from "./lib/calibration";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { isTauri } from "./lib/platform";

// New objects start from the design fabric's calibrated numbers (Calibrate fabric…).
setFabricDefaults(() => calibratedDefaults(useStore.getState().doc.fabric));

// Restore the last session (when autosave is on), or open the sample design
// on first launch. A restored design with changes not in a file stays unsaved.
const restored = useStore.getState().prefs.autosave ? loadAutosave() : null;
useStore.setState({ doc: restored?.doc ?? sampleDocument(), saved: !restored?.dirty, past: [], future: [] });
// leaving: the last edits go into the autosave (it waits 600 ms after an edit)
window.addEventListener("pagehide", () => void flushAutosave());
window.addEventListener("beforeunload", () => void flushAutosave());
// Desktop: closing the window. With autosave on the design comes back at the
// next start; without it, unsaved changes are asked about first.
if (isTauri)
  void import("@tauri-apps/api/window").then(({ getCurrentWindow }) =>
    getCurrentWindow().onCloseRequested((e) => {
      // what the autosave couldn't keep (it's off, or the design didn't fit) is asked about
      const kept = flushAutosave();
      const s = useStore.getState();
      if (!kept && !s.saved && s.doc.objects.length && !confirm("Close without saving? Your changes will be lost.")) e.preventDefault();
    }),
  );
document.documentElement.dataset.theme = useStore.getState().theme;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);

// A file dropped anywhere opens like one dropped on the canvas (the panels,
// menus and timeline have no drop zone: the window would navigate to the file).
window.addEventListener("dragover", (e) => {
  if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
});
window.addEventListener("drop", (e) => {
  const f = e.dataTransfer?.files?.[0];
  if (!f || e.defaultPrevented) return;
  e.preventDefault();
  if (!document.querySelector(".backdrop")) void openDroppedFile(f);
});

// Desktop: a file Filum was opened with replaces the restored design.
void openLaunchFiles();

// dev builds, and production builds made with VITE_PERF=1 for profiling
if (import.meta.env.DEV || import.meta.env.VITE_PERF) Object.assign(window, { __store: useStore, __engine: engine });
