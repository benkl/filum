import { Check, ChevronRight, Redo2, Save, Search, Undo2 } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { saveDocument } from "../lib/actions";
import { isTauri } from "../lib/platform";
import { useStore } from "../store";
import { buildMenus, mod, type MenuItem } from "./menuModel";
import { useWindowFocused, useWindowTitle, WindowControls } from "./WindowControls";

export function MenuBar() {
  const [open, setOpen] = useState<string | null>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const ref = useRef<HTMLDivElement>(null);
  // Subscribe only to what the menus display (not to every animation frame).
  useStore(
    useShallow((st) => [st.tool, st.viewMode, st.selection, st.doc.options, st.doc.threadSources, st.past.length > 0, st.future.length > 0, st.showJumps, st.showUnderlay, st.showGrid, st.showDensity, st.smartGuides, st.theme, st.outlineTab, st.inspectorTab, st.layout, st.stitchColors, st.colorFocus, st.activeThread, st.prefs.hints, st.gridStep, st.prefs.snapPoints]),
  );
  const s = useStore.getState();
  const docName = useStore((st) => st.doc.name);
  const saved = useStore((st) => st.saved);
  const title = `${docName || "Untitled"}${saved ? "" : " •"} — Filum`;
  useWindowTitle(title);
  const focused = useWindowFocused();

  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (!(e.target as HTMLElement).closest(".menu,.menu-btn")) setOpen(null);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [open]);

  const menus = buildMenus();
  const names = Object.keys(menus);
  // keyboard: ← → between menus, ↑ ↓ within, → / Enter into a submenu, Esc closes
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      const i = names.indexOf(open);
      if (e.key === "Escape") return setOpen(null);
      if ((e.key === "ArrowRight" || e.key === "ArrowLeft") && !(document.activeElement as HTMLElement)?.closest(".menu-sub")) {
        const btn = ref.current?.querySelectorAll<HTMLButtonElement>(".menu-btn")[(i + (e.key === "ArrowRight" ? 1 : names.length - 1)) % names.length];
        if (btn && !(e.key === "ArrowRight" && (document.activeElement as HTMLElement)?.classList.contains("has-sub"))) {
          e.preventDefault();
          const r = btn.getBoundingClientRect();
          setPos({ x: r.left, y: r.bottom + 2 });
          setOpen(names[(i + (e.key === "ArrowRight" ? 1 : names.length - 1)) % names.length]);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <div className={`menubar ${isTauri ? "titlebar" : ""} ${focused ? "" : "inactive"}`} ref={ref} data-tauri-drag-region>
      <img className="app-mark" src="/icon.svg" alt="" draggable={false} data-tauri-drag-region />
      {names.map((name) => (
        <button
          key={name}
          className={`menu-btn ${open === name ? "open" : ""}`}
          onPointerDown={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setPos({ x: r.left, y: r.bottom + 2 });
            setOpen(open === name ? null : name);
          }}
          onPointerEnter={(e) => {
            if (open && open !== name) {
              const r = e.currentTarget.getBoundingClientRect();
              setPos({ x: r.left, y: r.bottom + 2 });
              setOpen(name);
            }
          }}
        >
          {name}
        </button>
      ))}
      <div className="sep" />
      <button className="icon-btn" title={`Save (${mod}S)`} onClick={() => saveDocument()}>
        <Save size={15} />
      </button>
      <button className="icon-btn" title="Undo" onClick={s.undo} disabled={!s.past.length}>
        <Undo2 size={15} />
      </button>
      <button className="icon-btn" title="Redo" onClick={s.redo} disabled={!s.future.length}>
        <Redo2 size={15} />
      </button>
      {/* the free space moves the window (desktop); double-click maximizes */}
      <div className="title-drag" data-tauri-drag-region />
      <button className="icon-btn" title={`Find a command (${mod}K)`} onClick={() => s.setDialog("palette")}>
        <Search size={15} />
      </button>
      <WindowControls />
      {open && menus[open] && <Menu key={open} items={menus[open]} x={pos.x} y={pos.y} onClose={() => setOpen(null)} />}
    </div>
  );
}

/**
 * A dropdown of menu items. Items with a submenu open it to the side (left
 * when there is no room) on hover, → or Enter; ← goes back; a command closes
 * every level.
 */
export function Menu({ items, x, y, alt, onClose, onBack }: { items: MenuItem[]; x: number; y: number; alt?: number; onClose: () => void; onBack?: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [openSub, setOpenSub] = useState<{ i: number; x: number; y: number; alt: number } | null>(null);
  const [place, setPlace] = useState({ x, y });
  // keep the menu on screen
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    let nx = x;
    if (x + w > window.innerWidth - 4) nx = alt != null ? alt - w : window.innerWidth - w - 4;
    const ny = y + h > window.innerHeight - 4 ? Math.max(4, window.innerHeight - h - 4) : y;
    setPlace({ x: Math.max(4, nx), y: ny });
  }, [x, y, alt]);
  // the first item takes the focus (keyboard navigation)
  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>(":scope > .menu-item:not(:disabled)")?.focus({ preventScroll: true });
  }, []);
  const focusables = () => [...(ref.current?.querySelectorAll<HTMLButtonElement>(":scope > .menu-item:not(:disabled)") ?? [])];
  const showSub = (i: number, el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    setOpenSub({ i, x: r.right + 2, y: r.top - 6, alt: r.left - 2 });
  };
  const subItems = openSub ? items[openSub.i] : null;
  return (
    <div
      ref={ref}
      className={`menu ${onBack ? "menu-sub" : ""}`}
      role="menu"
      style={{ left: place.x, top: place.y }}
      onKeyDown={(e) => {
        if (e.target !== document.activeElement || !(e.currentTarget as HTMLElement).contains(e.target as Node) || (e.target as HTMLElement).parentElement !== e.currentTarget) return;
        const f = focusables();
        const k = f.indexOf(document.activeElement as HTMLButtonElement);
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          e.stopPropagation();
          f[(k + (e.key === "ArrowDown" ? 1 : f.length - 1)) % f.length]?.focus();
        } else if (e.key === "ArrowLeft" && onBack) {
          e.preventDefault();
          e.stopPropagation();
          onBack();
        }
      }}
    >
      {items.map((it, i) =>
        it === "-" ? (
          <div key={i} className="menu-sep" role="separator" />
        ) : (
          <button
            key={i}
            role="menuitem"
            className={`menu-item ${it.sub ? "has-sub" : ""} ${openSub?.i === i ? "sub-open" : ""}`}
            disabled={it.disabled}
            title={it.hint}
            aria-haspopup={it.sub ? "menu" : undefined}
            aria-expanded={it.sub ? openSub?.i === i : undefined}
            onPointerEnter={(e) => (it.sub && !it.disabled ? showSub(i, e.currentTarget) : setOpenSub(null))}
            onKeyDown={(e) => {
              if (it.sub && (e.key === "ArrowRight" || e.key === "Enter")) {
                e.preventDefault();
                e.stopPropagation();
                showSub(i, e.currentTarget);
              }
            }}
            onClick={(e) => {
              if (it.sub) return showSub(i, e.currentTarget);
              onClose();
              it.run?.();
            }}
          >
            <span className="check">{it.checked ? <Check size={13} /> : it.icon && <it.icon size={14} />}</span>
            {it.label}
            {it.kbd && <span className="kbd">{it.kbd}</span>}
            {it.sub && <ChevronRight size={13} className="sub-arrow" />}
          </button>
        ),
      )}
      {openSub && subItems && subItems !== "-" && subItems.sub && (
        <Menu
          items={subItems.sub}
          x={openSub.x}
          y={openSub.y}
          alt={openSub.alt}
          onClose={onClose}
          onBack={() => {
            const i = openSub.i;
            setOpenSub(null);
            ref.current?.querySelectorAll<HTMLElement>(":scope > .menu-item, :scope > .menu-sep")[i]?.focus();
          }}
        />
      )}
    </div>
  );
}
