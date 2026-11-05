import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";
import { loadAutosave, useStore } from "./store";
import { sampleDocument } from "./sample";
import { engine } from "./engine/client";
import { openLaunchFiles } from "./lib/actions";
import { setFabricDefaults } from "./lib/geometry";
import { calibratedDefaults } from "./lib/calibration";

// New objects start from the design fabric's calibrated numbers (Calibrate fabric…).
setFabricDefaults(() => calibratedDefaults(useStore.getState().doc.fabric));

// Restore the last session, or open the sample design on first launch.
const saved = loadAutosave();
const doc = saved && saved.objects ? saved : sampleDocument();
useStore.setState({ doc, saved: true, past: [], future: [] });
document.documentElement.dataset.theme = useStore.getState().theme;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Desktop: a file Filum was opened with replaces the restored design.
void openLaunchFiles();

if (import.meta.env.DEV) Object.assign(window, { __store: useStore, __engine: engine });
