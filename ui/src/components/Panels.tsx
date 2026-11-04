// The workspace around the canvas: the tool rail and two docked panels —
// layers & issues, and the properties. How they behave:
//  · Panels are fixed to the window but resizable (floating panels slow
//    people down); Ctrl+\ hides them for room.
//  · A column of section tabs beside the properties, a search that opens
//    matching sections and greys out the rest, Ctrl+click on a header to
//    open only that one; the tabs follow the selection.
//  · The object properties stay docked and modeless.
//  · The layout is remembered and can be reset.

import {
  ALargeSmall,
  Copy,
  Flag,
  Info,
  Move,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Search,
  Shapes,
  Stamp,
  Shirt,
  Timer,
  Type,
  Waves,
  X,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Applique, BatchLettering, EmbroideryMachine, Fabric as FabricIcon, Hoop, LockStitch, Spool, StitchFill, StitchProcessing, StitchRunning, StitchSatin, TextArc } from "../icons/stitch";
import { clamp, DEFAULT_LAYOUT, LIMITS, type Layout } from "../lib/layout";
import { useStore } from "../store";
import { IssuesPanel, LayersPanel, PropertiesPanel, ScenePanel, useIssueCount } from "./Dock";
import { ElementInfoSection } from "./ElementInfo";
import { openSection, SectionScope } from "./ui";

/* ---------------- layout ---------------- */

export function Workspace({ rail, center }: { rail: ReactNode; center: ReactNode }) {
  const layout = useStore((s) => s.layout);
  const mainRef = useRef<HTMLDivElement>(null);
  const { showOutline, showInspector, outlineSide } = layout;
  const stacked = outlineSide === "right";
  const cols = ["44px"];
  if (!stacked && showOutline) cols.push("var(--outline-w)");
  cols.push("minmax(0, 1fr)");
  if (stacked ? showOutline || showInspector : showInspector) cols.push("var(--inspector-w)");
  const style = {
    gridTemplateColumns: cols.join(" "),
    "--outline-w": `${layout.outlineW}px`,
    "--inspector-w": `${layout.inspectorW}px`,
    "--split": `${layout.split * 100}%`,
  } as CSSProperties;
  const both = showOutline && showInspector;
  return (
    <div className={`main${stacked ? " stacked" : ""}`} ref={mainRef} style={style}>
      {rail}
      {!stacked && showOutline && <OutlinePanel side="left" mainRef={mainRef} />}
      <div className="center-wrap">
        {center}
        {!showOutline && <PanelEdge side={stacked ? "right" : "left"} label="Show layers" onOpen={() => useStore.getState().setLayout({ showOutline: true })} offset={stacked && showInspector} />}
        {!showInspector && <PanelEdge side="right" label="Show properties" onOpen={() => useStore.getState().setLayout({ showInspector: true })} />}
      </div>
      {stacked && (showOutline || showInspector) && (
        <div className={`side-stack${both ? " both" : ""}`}>
          <WidthSash prop="inspectorW" edge="left" mainRef={mainRef} />
          {showOutline && <OutlinePanel side="right" mainRef={mainRef} />}
          {both && <SplitSash mainRef={mainRef} />}
          {showInspector && <Inspector mainRef={mainRef} stacked />}
        </div>
      )}
      {!stacked && showInspector && <Inspector mainRef={mainRef} />}
    </div>
  );
}

type MainRef = React.RefObject<HTMLDivElement | null>;

/**
 * The edge between a panel and the canvas: drag to resize (the canvas
 * follows live), double-click for the default width, arrow keys when
 * focused; dragged well past the narrowest width, the panel hides.
 */
function WidthSash({ prop, edge, mainRef }: { prop: "outlineW" | "inspectorW"; edge: "left" | "right"; mainRef: MainRef }) {
  const value = useStore((s) => s.layout[prop]);
  const limits = LIMITS[prop];
  const cssVar = prop === "outlineW" ? "--outline-w" : "--inspector-w";
  const stacked = useStore((s) => s.layout.outlineSide === "right");
  const hide: Partial<Layout> = prop === "outlineW" ? { showOutline: false } : stacked ? { showOutline: false, showInspector: false } : { showInspector: false };
  const set = (v: number) => useStore.getState().setLayout({ [prop]: clamp(v, limits) });
  return (
    <Sash
      orientation="vertical"
      className={`sash-${edge}`}
      label={prop === "outlineW" ? "Resize the layers panel" : "Resize the properties panel"}
      value={value}
      min={limits[0]}
      max={limits[1]}
      onDrag={(start, dx, _dy, live) => {
        const raw = start + (edge === "right" ? dx : -dx);
        live(raw < limits[0] * 0.55);
        mainRef.current?.style.setProperty(cssVar, `${clamp(raw, limits)}px`);
        return raw;
      }}
      onCommit={(raw) => (raw < limits[0] * 0.55 ? useStore.getState().setLayout(hide) : set(raw))}
      onStep={(d) => set(value + (edge === "right" ? d : -d) * 16)}
      onReset={() => set(DEFAULT_LAYOUT[prop])}
    />
  );
}

/** Between the stacked layers and properties. */
function SplitSash({ mainRef }: { mainRef: MainRef }) {
  const split = useStore((s) => s.layout.split);
  const set = (v: number) => useStore.getState().setLayout({ split: clamp(v, LIMITS.split) });
  const height = () => mainRef.current?.querySelector(".side-stack")?.clientHeight || 600;
  return (
    <Sash
      orientation="horizontal"
      label="Resize the layers and properties panels"
      value={Math.round(split * 100)}
      min={LIMITS.split[0] * 100}
      max={LIMITS.split[1] * 100}
      onDrag={(_start, _dx, dy) => {
        const v = clamp(split + dy / height(), LIMITS.split);
        mainRef.current?.style.setProperty("--split", `${v * 100}%`);
        return v;
      }}
      onCommit={set}
      onStep={(d) => set(split + d * 0.04)}
      onReset={() => set(DEFAULT_LAYOUT.split)}
    />
  );
}

function Sash({
  orientation,
  label,
  value,
  min,
  max,
  className = "",
  onDrag,
  onCommit,
  onStep,
  onReset,
}: {
  orientation: "vertical" | "horizontal";
  label: string;
  value: number;
  min: number;
  max: number;
  className?: string;
  /** Live change while dragging (no re-render); returns the value to commit. */
  onDrag: (start: number, dx: number, dy: number, collapsing: (on: boolean) => void) => number;
  onCommit: (v: number) => void;
  onStep: (dir: number) => void;
  onReset: () => void;
}) {
  const [drag, setDrag] = useState<"" | "on" | "collapse">("");
  return (
    <div
      role="separator"
      aria-orientation={orientation}
      aria-label={label}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      title={`${label} — double-click: default size`}
      className={`sash ${orientation} ${className} ${drag ? "dragging" : ""} ${drag === "collapse" ? "collapse" : ""}`}
      onDoubleClick={onReset}
      onKeyDown={(e) => {
        const back = orientation === "vertical" ? "ArrowLeft" : "ArrowUp";
        const fwd = orientation === "vertical" ? "ArrowRight" : "ArrowDown";
        if (e.key === back || e.key === fwd) {
          e.preventDefault();
          onStep((e.key === fwd ? 1 : -1) * (e.shiftKey ? 4 : 1));
        } else if (e.key === "Home" || e.key === "Enter") onReset();
      }}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        const el = e.currentTarget;
        el.setPointerCapture(e.pointerId);
        const x0 = e.clientX;
        const y0 = e.clientY;
        let v = value;
        setDrag("on");
        document.body.classList.add(orientation === "vertical" ? "resizing-x" : "resizing-y");
        const move = (ev: PointerEvent) => {
          v = onDrag(value, ev.clientX - x0, ev.clientY - y0, (c) => setDrag(c ? "collapse" : "on"));
        };
        const up = () => {
          el.removeEventListener("pointermove", move);
          el.removeEventListener("pointerup", up);
          el.removeEventListener("pointercancel", up);
          document.body.classList.remove("resizing-x", "resizing-y");
          setDrag("");
          if (v !== value) onCommit(v);
        };
        el.addEventListener("pointermove", move);
        el.addEventListener("pointerup", up);
        el.addEventListener("pointercancel", up);
      }}
    />
  );
}

/** A hidden panel leaves a tab on the canvas edge to bring it back. */
function PanelEdge({ side, label, onOpen, offset }: { side: "left" | "right"; label: string; onOpen: () => void; offset?: boolean }) {
  const Icon = side === "left" ? PanelLeftOpen : PanelRightOpen;
  return (
    <button className={`panel-edge ${side}${offset ? " offset" : ""}`} title={`${label} (${navigator.platform.toLowerCase().includes("mac") ? "⌘" : "Ctrl+"}\\ shows all panels)`} aria-label={label} onClick={onOpen}>
      <Icon size={14} />
    </button>
  );
}

/* ---------------- panels ---------------- */

function PanelTabs<T extends string>({ tabs, value, onChange, actions }: { tabs: { id: T; label: ReactNode; title?: string }[]; value: T; onChange: (v: T) => void; actions?: ReactNode }) {
  return (
    <div className="ptabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.id} role="tab" aria-selected={value === t.id} className={`ptab${value === t.id ? " on" : ""}`} title={t.title} onClick={() => onChange(t.id)}>
          {t.label}
        </button>
      ))}
      <span className="grow" />
      {actions}
    </div>
  );
}

function OutlinePanel({ side, mainRef }: { side: "left" | "right"; mainRef: MainRef }) {
  const tab = useStore((s) => s.outlineTab);
  const set = useStore((s) => s.set);
  const issues = useIssueCount();
  const count = useStore((s) => s.doc.objects.length);
  const Close = side === "left" ? PanelLeftClose : PanelRightClose;
  return (
    <section className={`side-panel outline ${side}`} aria-label="Layers and issues">
      <PanelTabs
        value={tab}
        onChange={(v) => set({ outlineTab: v })}
        tabs={[
          { id: "layers", label: <>Layers{count > 0 && <span className="ptab-n">{count}</span>}</> },
          { id: "issues", label: <>Issues{issues > 0 && <span className="count">{issues}</span>}</>, title: "Problems that would sew badly — markers show on the canvas while this tab is open" },
        ]}
        actions={
          <button className="icon-btn" title="Hide the layers panel" onClick={() => useStore.getState().setLayout({ showOutline: false })}>
            <Close size={14} />
          </button>
        }
      />
      <div className="panel-body">{tab === "layers" ? <LayersPanel /> : <IssuesPanel />}</div>
      {side === "left" && <WidthSash prop="outlineW" edge="right" mainRef={mainRef} />}
    </section>
  );
}

/* ---------------- properties ---------------- */

const SECTION_ICONS: Record<string, LucideIcon> = {
  Transform: Move,
  Thread: Spool,
  "Stitch patterns": Stamp,
  "Stitch pattern": Stamp,
  Clone: Copy,
  Commands: Flag,
  "Element info": Info,
  "Design info": Info,
  "Ripple guide": Waves,
  Text: Type,
  "On a path": TextArc,
  Shape: Shapes,
  Stitches: StitchSatin,
  Font: ALargeSmall,
  "Batch lettering": BatchLettering,
  Hoop: Hoop,
  "Fabric & thread": FabricIcon,
  "Stitch processing": StitchProcessing,
  Machine: EmbroideryMachine,
  "Stitch-out": LockStitch,
  "Time estimates": Timer,
  "Fabric look": Shirt,
};
const TYPE_ICONS: Record<string, LucideIcon> = { running: StitchRunning, manual: StitchRunning, satin: StitchSatin, fill: StitchFill, applique: Applique };

function Inspector({ mainRef, stacked }: { mainRef: MainRef; stacked?: boolean }) {
  const tab = useStore((s) => s.inspectorTab);
  const set = useStore((s) => s.set);
  const nSel = useStore((s) => s.selection.length);
  const stitchType = useStore((s) => (s.selection.length ? s.doc.objects.find((o) => o.id === s.selection[0])?.stitch.type : undefined));
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  // the tabs follow the selection
  const had = useRef(nSel > 0);
  useEffect(() => {
    if (nSel > 0 !== had.current) set({ inspectorTab: nSel > 0 ? "selection" : "design" });
    had.current = nSel > 0;
  }, [nSel, set]);

  // Ctrl+F: search the properties
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "f" && !useStore.getState().dialog) {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, []);

  const sections = useSections(bodyRef, query, tab);
  const icons: Record<string, LucideIcon> = { ...SECTION_ICONS, "Stitch options": (stitchType && TYPE_ICONS[stitchType]) || StitchRunning };
  return (
    <section className="side-panel inspector" aria-label="Properties">
      <PanelTabs
        value={tab}
        onChange={(v) => set({ inspectorTab: v })}
        tabs={[
          { id: "selection", label: <>Selection{nSel > 1 && <span className="ptab-n">{nSel}</span>}</>, title: "The selected objects' settings" },
          { id: "design", label: "Design", title: "Hoop, fabric, machine and stitch-out — saved with the design" },
        ]}
        actions={
          <button className="icon-btn" title="Hide the properties panel" onClick={() => useStore.getState().setLayout({ showInspector: false })}>
            <PanelRightClose size={14} />
          </button>
        }
      />
      <div className="insp-search">
        <Search size={13} aria-hidden />
        <input
          ref={searchRef}
          type="search"
          placeholder="Search properties"
          aria-label="Search properties"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setQuery("");
              e.currentTarget.blur();
            }
          }}
        />
        {query ? (
          <button className="icon-btn" title="Clear (Esc)" onClick={() => setQuery("")}>
            <X size={13} />
          </button>
        ) : (
          <kbd className="insp-kbd">{navigator.platform.toLowerCase().includes("mac") ? "⌘" : "Ctrl"} F</kbd>
        )}
      </div>
      <div className="insp">
        <nav className="sec-rail" aria-label="Sections">
          {sections.list.map((s) => {
            const Icon = icons[s.title.replace(/ \(\d+\)$/, "")];
            return (
              <button
                key={s.title}
                className={`sec-tab${sections.active === s.title ? " on" : ""}${s.dim ? " dim" : ""}`}
                title={s.title}
                aria-label={s.title}
                disabled={s.dim}
                onClick={() => {
                  openSection(tab, s.title);
                  sections.go(s.title);
                }}
              >
                {Icon ? <Icon size={15} /> : <span className="sec-letter">{s.title[0]}</span>}
              </button>
            );
          })}
        </nav>
        <div className={`panel-body insp-body${query ? " filtering" : ""}`} ref={bodyRef}>
          <SectionScope.Provider value={{ scope: tab, query }}>
            {tab === "selection" ? (
              <PropertiesPanel />
            ) : (
              <>
                <ScenePanel />
                <div className="props" style={{ paddingTop: 0 }}>
                  <ElementInfoSection ids={[]} title="Design info" />
                </div>
              </>
            )}
          </SectionScope.Provider>
          {query && sections.none && <div className="hint insp-none">No property matches “{query}”.</div>}
        </div>
      </div>
      {!stacked && <WidthSash prop="inspectorW" edge="left" mainRef={mainRef} />}
    </section>
  );
}

/**
 * The top-level sections in the panel body, which one is in view (scroll
 * spy) and the search filter: rows whose label matches stay, sections whose
 * title matches stay whole, the rest hide.
 */
function useSections(bodyRef: React.RefObject<HTMLDivElement | null>, query: string, tab: string) {
  const [state, setState] = useState<{ list: { title: string; dim: boolean }[]; active: string | null; none: boolean }>({ list: [], active: null, none: false });
  const q = query.trim().toLowerCase();
  // a section picked on the rail stays lit while the panel scrolls to it
  const pin = useRef<{ title: string; until: number } | null>(null);
  const go = (title: string) => {
    pin.current = { title, until: performance.now() + 900 };
    setState((s) => ({ ...s, active: title }));
    const scroll = (behavior: ScrollBehavior) => {
      const body = bodyRef.current;
      const el = body?.querySelector<HTMLElement>(`.section[data-depth="0"][data-section="${CSS.escape(title)}"]`);
      if (body && el) body.scrollTo({ top: el.offsetTop, behavior });
    };
    requestAnimationFrame(() => scroll("smooth"));
    // the section may still be growing (it was closed): land on it once it has
    setTimeout(() => scroll("auto"), 420);
  };
  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    let raf = 0;
    const spy = () => {
      if (pin.current && performance.now() < pin.current.until) return;
      pin.current = null;
      const tops = [...body.querySelectorAll<HTMLElement>('.section[data-depth="0"]:not([data-filtered])')];
      let active: string | null = tops[0]?.dataset.section ?? null;
      for (const el of tops) if (el.offsetTop - body.scrollTop <= 24) active = el.dataset.section ?? null;
      setState((s) => (s.active === active ? s : { ...s, active }));
    };
    const scan = () => {
      raf = 0;
      filter(body, q);
      const tops = [...body.querySelectorAll<HTMLElement>('.section[data-depth="0"]')];
      const list = tops.map((el) => ({ title: el.dataset.section ?? "", dim: el.hasAttribute("data-filtered") }));
      const none = !!q && list.every((x) => x.dim);
      setState((s) => (JSON.stringify(s.list) === JSON.stringify(list) && s.none === none ? s : { ...s, list, none }));
      spy();
    };
    scan();
    const mo = new MutationObserver(() => {
      if (!raf) raf = requestAnimationFrame(scan);
    });
    mo.observe(body, { childList: true, subtree: true, characterData: true });
    body.addEventListener("scroll", spy, { passive: true });
    return () => {
      mo.disconnect();
      cancelAnimationFrame(raf);
      body.removeEventListener("scroll", spy);
    };
  }, [bodyRef, q, tab]);
  return { ...state, go };
}

/** Visible words of an element: labels and text, not the options of a list or the content of fields. */
function wordsOf(el: Element): string {
  let out = "";
  const walk = (n: Node) => {
    if (n.nodeType === Node.TEXT_NODE) out += " " + n.textContent;
    else if (n.nodeType === Node.ELEMENT_NODE && !/^(SELECT|OPTION|TEXTAREA|svg)$/i.test((n as Element).tagName)) n.childNodes.forEach(walk);
  };
  walk(el);
  return out.toLowerCase();
}

function filter(body: HTMLElement, q: string) {
  body.querySelectorAll("[data-filtered]").forEach((e) => e.removeAttribute("data-filtered"));
  body.querySelectorAll(".hit").forEach((e) => e.classList.remove("hit"));
  if (!q) return;
  // deepest first: a section knows whether its inner sections kept anything
  const secs = [...body.querySelectorAll<HTMLElement>(".section")].reverse();
  for (const sec of secs) {
    if ((sec.dataset.section ?? "").toLowerCase().includes(q)) {
      sec.querySelectorAll("[data-filtered]").forEach((e) => e.removeAttribute("data-filtered"));
      sec.querySelector(":scope > .section-head")?.classList.add("hit");
      continue;
    }
    let any = false;
    for (const child of [...sec.children]) {
      if (child.classList.contains("section-head")) continue;
      const keep = child.classList.contains("section") ? !child.hasAttribute("data-filtered") : wordsOf(child).includes(q);
      if (keep) {
        any = true;
        child.querySelectorAll(":scope label, :scope .row > :first-child").forEach((l) => {
          if (wordsOf(l).includes(q)) l.classList.add("hit");
        });
        if (!child.classList.contains("section") && wordsOf(child).includes(q) && child.matches(".row")) child.querySelector("label")?.classList.add("hit");
      } else child.setAttribute("data-filtered", "");
    }
    if (!any) sec.setAttribute("data-filtered", "");
  }
}
