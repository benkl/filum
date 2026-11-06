import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";
import { flushAutosave, loadAutosave, useStore } from "./store";
import { sampleDocument } from "./sample";
import { engine } from "./engine/client";
import { openLaunchFiles } from "./lib/actions";
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
window.addEventListener("pagehide", flushAutosave);
window.addEventListener("beforeunload", flushAutosave);
// Desktop: closing the window. With autosave on the design comes back at the
// next start; without it, unsaved changes are asked about first.
if (isTauri)
  void import("@tauri-apps/api/window").then(({ getCurrentWindow }) =>
    getCurrentWindow().onCloseRequested((e) => {
      flushAutosave();
      const s = useStore.getState();
      if (!s.prefs.autosave && !s.saved && s.doc.objects.length && !confirm("Close without saving? Your changes will be lost.")) e.preventDefault();
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

// Desktop: a file Filum was opened with replaces the restored design.
void openLaunchFiles();

// dev builds, and production builds made with VITE_PERF=1 for profiling
if (import.meta.env.DEV || import.meta.env.VITE_PERF) Object.assign(window, { __store: useStore, __engine: engine });
