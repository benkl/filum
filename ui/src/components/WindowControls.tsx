// Window caption buttons for the desktop app (the native frame is off:
// tauri.conf.json "decorations": false). The menu bar is the title bar:
// elements with data-tauri-drag-region move the window, a double-click on
// them maximizes. Nothing is shown in the browser.

import { useEffect, useState } from "react";
import { isTauri } from "../lib/platform";

type Win = Awaited<ReturnType<typeof getWindow>>;
const getWindow = async () => (await import("@tauri-apps/api/window")).getCurrentWindow();

/** Whether the window is maximized and focused (desktop only). */
function useWindowState(): { win: Win | null; maximized: boolean; focused: boolean } {
  const [win, setWin] = useState<Win | null>(null);
  const [maximized, setMaximized] = useState(false);
  const [focused, setFocused] = useState(true);
  useEffect(() => {
    if (!isTauri) return;
    let live = true;
    const offs: (() => void)[] = [];
    void getWindow().then(async (w) => {
      if (!live) return;
      setWin(w);
      const sync = async () => live && setMaximized(await w.isMaximized());
      await sync();
      offs.push(await w.onResized(sync));
      offs.push(await w.onFocusChanged(({ payload }) => live && setFocused(payload)));
    });
    return () => {
      live = false;
      offs.forEach((f) => f());
    };
  }, []);
  return { win, maximized, focused };
}

/** Keeps the native window title (taskbar, Alt-Tab) in step with the design. */
export function useWindowTitle(title: string) {
  useEffect(() => {
    document.title = title;
    if (isTauri) void getWindow().then((w) => w.setTitle(title).catch(() => {}));
  }, [title]);
}

/** Focus state of the window, for dimming the title bar when inactive. */
export function useWindowFocused(): boolean {
  return useWindowState().focused;
}

export function WindowControls() {
  const { win, maximized } = useWindowState();
  if (!isTauri) return null;
  return (
    <div className="win-controls">
      <button type="button" className="win-btn" title="Minimize" aria-label="Minimize" onClick={() => win?.minimize()}>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
          <path d="M0 5.5h10" stroke="currentColor" strokeWidth="1" />
        </svg>
      </button>
      <button type="button" className="win-btn" title={maximized ? "Restore down" : "Maximize"} aria-label={maximized ? "Restore down" : "Maximize"} onClick={() => win?.toggleMaximize()}>
        {maximized ? (
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
            <path d="M2.5 2.5V.5h7v7h-2M.5 2.5h7v7h-7z" fill="none" stroke="currentColor" strokeWidth="1" />
          </svg>
        ) : (
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
            <path d="M.5.5h9v9h-9z" fill="none" stroke="currentColor" strokeWidth="1" />
          </svg>
        )}
      </button>
      <button type="button" className="win-btn close" title="Close" aria-label="Close" onClick={() => win?.close()}>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
          <path d="M.5.5l9 9M9.5.5l-9 9" stroke="currentColor" strokeWidth="1.1" />
        </svg>
      </button>
    </div>
  );
}
