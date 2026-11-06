// Command palette (Ctrl+K): every command of the menus, found by typing a
// few letters of its name or its menu ("conv sat", "align left"). The list
// is the menu model itself, so the palette and the menus never disagree;
// recently used commands come first.

import { Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { commandScore as score } from "../lib/commandSearch";
import { buildMenus, flattenMenus, type MenuEntry } from "./menuModel";
import { safeSetItem } from "../lib/storage";

const RECENT_KEY = "filum.palette.recent";
const recent = (): string[] => {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
  } catch {
    return [];
  }
};
const keyOf = (path: string[], label: string) => [...path, label].join(" ▸ ");

/** The label with the matched words marked. */
function Marked({ text, query }: { text: string; query: string }) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return <>{text}</>;
  const lower = text.toLowerCase();
  const hit = new Array(text.length).fill(false);
  for (const w of words) {
    const i = lower.indexOf(w);
    if (i >= 0) for (let k = i; k < i + w.length; k++) hit[k] = true;
  }
  const parts: { t: string; on: boolean }[] = [];
  for (let i = 0; i < text.length; i++) {
    const last = parts[parts.length - 1];
    if (last && last.on === hit[i]) last.t += text[i];
    else parts.push({ t: text[i], on: hit[i] });
  }
  return (
    <>
      {parts.map((p, i) => (p.on ? <mark key={i}>{p.t}</mark> : <span key={i}>{p.t}</span>))}
    </>
  );
}

export function CommandPalette({ onClose }: { onClose: () => void }) {
  const [q, setQ] = useState("");
  const [at, setAt] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const all = useMemo(() => flattenMenus(buildMenus()), []);
  const results = useMemo(() => {
    const rec = recent();
    return all
      .map((c) => ({ ...c, key: keyOf(c.path, c.item.label), score: score(q, c.item.label, c.path.join(" ")) }))
      .filter((c) => c.score > 0)
      .map((c) => ({ ...c, score: c.score + (rec.includes(c.key) ? (q ? 0.5 : 10 - rec.indexOf(c.key) * 0.5) : 0) + (c.item.disabled ? -2 : 0) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 60);
  }, [all, q]);
  useEffect(() => input.current?.focus(), []);
  useEffect(() => setAt(0), [q]);
  useEffect(() => {
    list.current?.querySelector(".palette-item.on")?.scrollIntoView({ block: "nearest" });
  }, [at]);

  const run = (c: { key: string; item: MenuEntry }) => {
    if (c.item.disabled) return;
    safeSetItem(RECENT_KEY, JSON.stringify([c.key, ...recent().filter((k) => k !== c.key)].slice(0, 12)));
    onClose();
    c.item.run?.();
  };

  return (
    <div className="palette-back" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette" role="dialog" aria-label="Command palette">
        <div className="palette-input">
          <Search size={16} />
          <input
            ref={input}
            value={q}
            placeholder="Find a command…"
            aria-label="Find a command"
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") return onClose();
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                const n = results.length || 1;
                setAt((a) => (a + (e.key === "ArrowDown" ? 1 : n - 1)) % n);
              }
              if (e.key === "Enter" && results[at]) run(results[at]);
            }}
          />
        </div>
        <div className="palette-list" ref={list} role="listbox">
          {results.length ? (
            results.map((c, i) => (
              <button
                key={c.key}
                role="option"
                aria-selected={i === at}
                className={`palette-item ${i === at ? "on" : ""}`}
                disabled={c.item.disabled}
                title={c.item.hint}
                onPointerMove={() => setAt(i)}
                onClick={() => run(c)}
              >
                <span className="pl-icon">{c.item.icon && <c.item.icon size={15} />}</span>
                <span className="pl-label">
                  <Marked text={c.item.label} query={q} />
                  {c.item.checked ? " ✓" : ""}
                </span>
                <span className="pl-path">{c.path.join(" ▸ ")}{c.item.hint ? ` · ${c.item.hint}` : ""}</span>
                {c.item.kbd && <span className="kbd">{c.item.kbd}</span>}
              </button>
            ))
          ) : (
            <div className="palette-empty">No command matches “{q}”</div>
          )}
        </div>
        <div className="palette-foot">
          <span>↑↓ choose</span>
          <span>Enter run</span>
          <span>Esc close</span>
        </div>
      </div>
    </div>
  );
}
