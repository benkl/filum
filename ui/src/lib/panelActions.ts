// Showing and hiding the side panels (View ▸ Panels, Ctrl+\).

import { useStore, type State } from "../store";

/** Issue markers are drawn on the canvas while the Issues tab is in view. */
export const issuesShown = (s: Pick<State, "outlineTab" | "layout">) => s.outlineTab === "issues" && s.layout.showOutline;

/** Hide both panels, or bring back the ones there were (Ctrl+\). */
let hidden: { showOutline: boolean; showInspector: boolean } | null = null;
export function togglePanels() {
  const s = useStore.getState();
  const { showOutline, showInspector } = s.layout;
  if (showOutline || showInspector) {
    hidden = { showOutline, showInspector };
    s.setLayout({ showOutline: false, showInspector: false });
  } else {
    s.setLayout(hidden ?? { showOutline: true, showInspector: true });
    hidden = null;
  }
}

export function showIssues() {
  const s = useStore.getState();
  s.set({ outlineTab: "issues" });
  s.setLayout({ showOutline: true });
}

export function showDesign() {
  const s = useStore.getState();
  s.set({ inspectorTab: "design" });
  s.setLayout({ showInspector: true });
}
