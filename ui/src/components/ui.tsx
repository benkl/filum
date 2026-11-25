import { ChevronRight, GripHorizontal, GripVertical, X } from "lucide-react";
import { createContext, useContext, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { openExternal } from "../lib/platform";
import { loadJson, safeSetItem } from "../lib/storage";

export function Num({
  value,
  onChange,
  unit,
  step = 0.1,
  min,
  max,
  digits = 2,
}: {
  value: number;
  onChange: (v: number) => void;
  unit?: string;
  step?: number;
  min?: number;
  max?: number;
  digits?: number;
}) {
  const fmt = (v: number) => (Number.isFinite(v) ? String(+v.toFixed(digits)) : "");
  const [text, setText] = useState(fmt(value));
  const [focus, setFocus] = useState(false);
  useEffect(() => {
    if (!focus) setText(fmt(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, focus]);
  const commit = (t: string) => {
    let v = parseFloat(t.replace(",", "."));
    if (!Number.isFinite(v)) return setText(fmt(value));
    if (min != null) v = Math.max(min, v);
    if (max != null) v = Math.min(max, v);
    if (v !== value) onChange(v);
    setText(fmt(v));
  };
  return (
    <div className="num">
      <input
        value={text}
        onFocus={(e) => {
          setFocus(true);
          e.currentTarget.select();
        }}
        onBlur={(e) => {
          setFocus(false);
          commit(e.currentTarget.value);
        }}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "ArrowUp" || e.key === "ArrowDown") {
            e.preventDefault();
            const k = (e.key === "ArrowUp" ? 1 : -1) * step * (e.shiftKey ? 10 : 1);
            let v = +(value + k).toFixed(6);
            if (min != null) v = Math.max(min, v);
            if (max != null) v = Math.min(max, v);
            onChange(v);
          }
        }}
      />
      {unit && <span className="unit">{unit}</span>}
    </div>
  );
}

export function Slider({
  value,
  onChange,
  onLive,
  min,
  max,
  step,
  unit,
  digits = 2,
}: {
  value: number;
  onChange: (v: number) => void;
  onLive?: (v: number) => void;
  min: number;
  max: number;
  step: number;
  unit?: string;
  digits?: number;
}) {
  const [live, setLive] = useState<number | null>(null);
  return (
    <div className="slider-row">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={live ?? value}
        onChange={(e) => {
          const v = parseFloat(e.target.value);
          setLive(v);
          onLive?.(v);
        }}
        onPointerUp={() => {
          if (live != null) onChange(live);
          setLive(null);
        }}
        onKeyUp={() => {
          if (live != null) onChange(live);
          setLive(null);
        }}
      />
      <Num value={live ?? value} onChange={onChange} unit={unit} step={step} digits={digits} />
    </div>
  );
}

/** A link to a web page: the system browser on the desktop, a new tab in the browser. */
export function ExtLink({ href, children, className, title }: { href: string; children: ReactNode; className?: string; title?: string }) {
  return (
    <a
      href={href}
      className={className}
      title={title ?? href}
      target="_blank"
      rel="noreferrer"
      onClick={(e) => {
        e.preventDefault();
        void openExternal(href);
      }}
    >
      {children}
    </a>
  );
}

/**
 * A segmented control: one of a few choices side by side. `options` are
 * [value, label, tooltip?]; `label` names the group for screen readers;
 * `full` stretches it over the row.
 */
export function Seg<T extends string | number | boolean>({
  value,
  options,
  onChange,
  label,
  full,
  disabled,
  className,
  style,
}: {
  /** The current choice; null when none is (a selection that differs). */
  value: T | null;
  options: readonly (readonly [T, ReactNode, string?])[];
  onChange: (v: T) => void;
  label?: string;
  full?: boolean;
  disabled?: boolean;
  /** More classes for the group (its place in a layout). */
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <div className={`seg${full ? " seg-full" : ""}${disabled ? " disabled" : ""}${className ? ` ${className}` : ""}`} style={style} role="group" aria-label={label}>
      {options.map(([id, text, title]) => (
        <button key={String(id)} className={value === id ? "on" : ""} title={title} disabled={disabled} onClick={() => onChange(id)}>
          {text}
        </button>
      ))}
    </div>
  );
}

export function Toggle({ on, onChange, title }: { on: boolean; onChange: (v: boolean) => void; title?: string }) {
  return <button className={`toggle ${on ? "on" : ""}`} title={title} onClick={() => onChange(!on)} aria-pressed={on} />;
}

export function Row({ label, children, title }: { label: string; children: ReactNode; title?: string }) {
  return (
    <div className="row" title={title}>
      <label>{label}</label>
      <div>{children}</div>
    </div>
  );
}

/**
 * Sections inside a panel: the panel remembers which are open (per scope),
 * opens one from its section rail, and filters them by a search.
 * Outside a scope (dialogs) a section just folds.
 */
export const SectionScope = createContext<{ scope: string; query: string } | null>(null);
const SectionDepth = createContext(0);

const OPEN_KEY = "filum.sections";
const openMemory: Record<string, boolean> = loadJson(OPEN_KEY, {});
type SectionCmd = { scope: string; depth: number; title: string; kind: "open" | "solo" };
const sectionListeners = new Set<(c: SectionCmd) => void>();

/** Open one top-level section of a panel (the section rail). */
export function openSection(scope: string, title: string) {
  sectionListeners.forEach((f) => f({ scope, depth: 0, title, kind: "open" }));
}

export function Section({ title, children, defaultOpen = true, extra }: { title: string; children: ReactNode; defaultOpen?: boolean; extra?: ReactNode }) {
  const ctx = useContext(SectionScope);
  const depth = useContext(SectionDepth);
  const scope = ctx?.scope;
  const key = scope ? `${scope}:${depth}:${title}` : null;
  const [open, setOpenState] = useState(() => (key && key in openMemory ? openMemory[key] : defaultOpen));
  const setOpen = (v: boolean) => {
    setOpenState(v);
    if (!key) return;
    openMemory[key] = v;
    safeSetItem(OPEN_KEY, JSON.stringify(openMemory));
  };
  const setRef = useRef(setOpen);
  setRef.current = setOpen;
  useEffect(() => {
    if (!scope) return;
    const f = (c: SectionCmd) => {
      if (c.scope !== scope || c.depth !== depth) return;
      if (c.kind === "solo") setRef.current(c.title === title);
      else if (c.title === title) setRef.current(true);
    };
    sectionListeners.add(f);
    return () => void sectionListeners.delete(f);
  }, [scope, depth, title]);
  // a search shows every section, so their rows can be matched
  const shown = open || !!ctx?.query;
  return (
    <div className={`section${shown ? " open" : ""}`} data-section={title} data-depth={depth}>
      <div className="section-head">
        <button
          className="section-title"
          aria-expanded={shown}
          title={scope ? "Ctrl+click: open only this one" : undefined}
          onClick={(e) => {
            // Ctrl+click on a panel header collapses all the others
            if (scope && (e.ctrlKey || e.metaKey)) sectionListeners.forEach((f) => f({ scope, depth, title, kind: "solo" }));
            else setOpen(!open);
          }}
        >
          <ChevronRight size={12} className="chev" />
          {title}
        </button>
        {extra && <div className="section-extra">{extra}</div>}
      </div>
      {shown && <SectionDepth.Provider value={depth + 1}>{children}</SectionDepth.Provider>}
    </div>
  );
}

export function Dialog({
  title,
  children,
  footer,
  onClose,
  wide,
  xwide,
  live,
}: {
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  wide?: boolean;
  xwide?: boolean;
  /** Edits preview on the canvas: no blur behind the dialog. */
  live?: boolean;
}) {
  const mv = useMovable(`dialog:${title.split(" — ")[0]}`);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <div
      className={`backdrop ${live ? "live" : ""}`}
      // live dialogs: a click beside them does not cancel the preview
      onPointerDown={(e) => !live && e.target === e.currentTarget && onClose()}
      // live dialogs: the wheel still zooms the canvas behind
      onWheel={
        live
          ? (e) => {
              if (e.target !== e.currentTarget) return;
              const n = e.nativeEvent;
              document
                .querySelector(".canvas-wrap canvas:last-of-type")
                ?.dispatchEvent(new WheelEvent("wheel", { deltaX: n.deltaX, deltaY: n.deltaY, deltaMode: n.deltaMode, clientX: n.clientX, clientY: n.clientY, ctrlKey: n.ctrlKey, shiftKey: n.shiftKey, metaKey: n.metaKey, bubbles: true, cancelable: true }));
            }
          : undefined
      }
    >
      <div
        className={`dialog ${wide ? "wide" : ""} ${xwide ? "xwide" : ""}`}
        role="dialog"
        aria-label={title}
        data-movable
        style={mv.moved ? { transform: `translate(${mv.off[0]}px, ${mv.off[1]}px)` } : undefined}
      >
        <div className="dialog-head" {...mv.grip} title="Drag to move · double-click: back to the centre">
          <h2>{title}</h2>
          <button className="icon-btn dialog-close" onClick={onClose} title="Close (Esc)" aria-label="Close">
            <X size={16} />
          </button>
        </div>
        <div className="dialog-body">{children}</div>
        {footer && <div className="dialog-foot">{footer}</div>}
      </div>
    </div>
  );
}

/**
 * Follows a drag until the pointer is released or the browser cancels it
 * (a touch turned into a scroll, the window lost the pointer): `move` on
 * every step, `end` once, with `cancelled` for a cancel. Listens on `on`:
 * the element that captured the pointer, or the window.
 */
export function followPointer(on: Window | Element, move: (ev: PointerEvent) => void, end?: (ev: PointerEvent, cancelled: boolean) => void) {
  const step = move as EventListener;
  const up = ((ev: PointerEvent) => {
    on.removeEventListener("pointermove", step);
    on.removeEventListener("pointerup", up);
    on.removeEventListener("pointercancel", up);
    end?.(ev, ev.type === "pointercancel");
  }) as EventListener;
  on.addEventListener("pointermove", step);
  on.addEventListener("pointerup", up);
  on.addEventListener("pointercancel", up);
}

/**
 * Where a popover `w` px wide goes next to its anchor (a button's rect): left
 * aligned with it (`start`), right aligned (`end`) or centred, kept `margin`
 * px inside the window, `gap` px from the anchor.
 * - Its `height` known: below the anchor, or above when it doesn't fit
 *   there (`flip`, the default), or moved up just enough (`flip: false`).
 * - Else it gets a `maxHeight` (at most `maxHeight`): below when at least
 *   `minBelow` px are free there (or as much as above), else above.
 */
export function placeNear(
  r: DOMRect,
  w: number,
  { align = "start", gap = 4, margin = 8, height, maxHeight = Infinity, minBelow = 0, flip = true }: { align?: "start" | "end" | "center"; gap?: number; margin?: number; height?: number; maxHeight?: number; minBelow?: number; flip?: boolean } = {},
): { left: number; top: number; maxHeight?: number } {
  const x = align === "start" ? r.left : align === "end" ? r.right - w : r.left + r.width / 2 - w / 2;
  const left = Math.max(margin, Math.min(window.innerWidth - w - margin, x));
  if (height != null) {
    const below = r.bottom + gap;
    if (!flip) return { left, top: Math.min(below, Math.max(margin, window.innerHeight - height - margin)) };
    return { left, top: below + height > window.innerHeight - margin ? Math.max(margin, r.top - height - gap) : below };
  }
  const room = window.innerHeight - r.bottom - gap - margin;
  const above = r.top - gap - margin;
  const mh = Math.min(maxHeight, Math.max(room, above));
  return { left, top: room >= Math.min(minBelow, above) ? r.bottom + gap : Math.max(margin, r.top - gap - mh), maxHeight: mh };
}

/** What doesn't count as outside a popover: an element (its anchor), a ref (the popover) or a CSS selector (".menu" for its submenus). */
export type Inside = Element | RefObject<Element | null> | string | null | undefined;

/**
 * Closes a popover or menu while it is `open`: on a press anywhere outside
 * it (`inside` lists what belongs to it) and on Escape, which then goes no
 * further (the selection, the tool or the player behind it stay). Popovers
 * with their own Escape handling (focus going back to a button, menus
 * stepping back a level) pass `escape: false`.
 */
export function useDismiss(open: boolean, onClose: () => void, inside: Inside[], opts: { escape?: boolean } = {}) {
  const latest = useRef({ onClose, inside });
  latest.current = { onClose, inside };
  const escape = opts.escape !== false;
  useEffect(() => {
    if (!open) return;
    const within = (t: EventTarget | null) =>
      t instanceof Node &&
      latest.current.inside.some((x) => {
        if (!x) return false;
        if (typeof x === "string") return !!(t instanceof Element ? t : t.parentElement)?.closest(x);
        const el = x instanceof Element ? x : x.current;
        return !!el?.contains(t);
      });
    const down = (e: PointerEvent) => {
      if (!within(e.target)) latest.current.onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      latest.current.onClose();
    };
    window.addEventListener("pointerdown", down, true);
    if (escape) window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("keydown", key, true);
    };
  }, [open, escape]);
}

export const fmtTime = (s: number) => {
  const t = Math.max(0, Math.round(s));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
};

// ---------------------------------------------------------------------------
// Movable popovers

const MOVED_KEY = "filum.popovers";
const moved: Record<string, [number, number]> = loadJson(MOVED_KEY, {});

/**
 * Lets a popover be dragged by its grip. The offset is added to the
 * popover's own placement; with `remember` it is kept for the next time.
 * Double-click the grip: back to where it opens.
 */
export function useMovable(remember?: string) {
  const [off, setOff] = useState<[number, number]>(() => {
    const o = remember ? moved[remember] : undefined;
    // a remembered place from a larger window: back to the default
    return o && Math.abs(o[0]) < window.innerWidth * 0.8 && Math.abs(o[1]) < window.innerHeight * 0.8 ? o : [0, 0];
  });
  const save = (o: [number, number]) => {
    if (!remember) return;
    moved[remember] = o;
    safeSetItem(MOVED_KEY, JSON.stringify(moved));
  };
  const grip = {
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
      if (e.button !== 0 || (e.target as Element).closest?.("button,input,select,textarea,a")) return;
      e.preventDefault();
      e.stopPropagation();
      const el = e.currentTarget;
      const box = (el.closest("[data-movable]") as HTMLElement | null)?.getBoundingClientRect();
      el.setPointerCapture(e.pointerId);
      const [sx, sy, ox, oy] = [e.clientX, e.clientY, off[0], off[1]];
      let last: [number, number] = off;
      const move = (ev: PointerEvent) => {
        let dx = ev.clientX - sx;
        let dy = ev.clientY - sy;
        // stay on screen (whole, when it fits)
        if (box) {
          const W = window.innerWidth;
          const H = window.innerHeight;
          dx = box.width <= W ? Math.max(-box.left, Math.min(W - box.right, dx)) : Math.max(W - box.right, Math.min(-box.left, dx));
          dy = box.height <= H ? Math.max(-box.top, Math.min(H - box.bottom, dy)) : Math.max(-box.top - box.height + 60, Math.min(-box.top, dy));
        }
        last = [ox + dx, oy + dy];
        setOff(last);
      };
      followPointer(el, move, () => save(last));
    },
    onDoubleClick: (e: React.MouseEvent) => {
      if ((e.target as Element).closest?.("button,input,select,textarea,a")) return;
      setOff([0, 0]);
      save([0, 0]);
    },
  };
  return { off, grip, moved: off[0] !== 0 || off[1] !== 0 };
}

/** The drag handle of a movable popover. */
export function Grip({ grip, vertical, label }: { grip: ReturnType<typeof useMovable>["grip"]; vertical?: boolean; label?: ReactNode }) {
  return (
    <div className={`pop-grip ${vertical ? "vertical" : ""}`} {...grip} title="Drag to move · double-click: back to its place">
      {vertical ? <GripVertical size={14} /> : <GripHorizontal size={14} />}
      {label && <span>{label}</span>}
    </div>
  );
}

/**
 * A value with several numbers ("2 1", Ink/Stitch patterns): typed as text,
 * committed on Enter / blur. Empty means no pattern (`placeholder` shows what
 * is used then).
 */
export function PatternInput({
  value,
  onChange,
  placeholder,
  unit,
  parse,
  format,
}: {
  value: number[] | undefined;
  onChange: (v: number[]) => void;
  placeholder?: string;
  unit?: string;
  parse: (text: string) => number[];
  format: (v: number[] | undefined) => string;
}) {
  const [text, setText] = useState(format(value));
  const [focus, setFocus] = useState(false);
  useEffect(() => {
    if (!focus) setText(format(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(value), focus]);
  const commit = (t: string) => {
    const v = parse(t);
    if (JSON.stringify(v) !== JSON.stringify(value ?? [])) onChange(v);
    setText(format(v));
  };
  return (
    <div className="num pattern">
      <input
        value={text}
        placeholder={placeholder}
        onFocus={(e) => {
          setFocus(true);
          e.currentTarget.select();
        }}
        onBlur={(e) => {
          setFocus(false);
          commit(e.currentTarget.value);
        }}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
      />
      {unit && <span className="unit">{unit}</span>}
    </div>
  );
}
