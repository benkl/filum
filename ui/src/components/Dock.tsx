import { ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, Info, OctagonAlert, Shapes, TriangleAlert, type LucideIcon, ChevronUp, Eye, EyeOff, GripVertical, ImagePlus, Lock, Move, Sparkles, Trash2, Type, Unlock, Search, X, FolderTree } from "lucide-react";
import { HiddenStitchingSection, ObjectHiddenSection } from "./HiddenStitching";
import { DensityMap, Hoop, StitchFill, StitchRunning, StitchSatin } from "../icons/stitch";
import { CommandsSection } from "./CommandsSection";
import { MachineSettings } from "./MachineSettings";
import { FabricLookRows } from "./FabricLook";
import { autoFillHint, autoSatinHint } from "../lib/underlay";
import { GuideActions } from "./SatinGuides";
import { openKnockdown } from "./KnockdownDialog";
import { MulticolorSatin } from "./MulticolorSatin";
import { cleanupCandidates, cleanupDocument, DEFAULT_CLEANUP } from "../lib/shapeCheck";
import { fabricInfo } from "../lib/materials";
import { addReference, moveReference, removeReference, updateReference } from "../lib/references";
import { openFile } from "../lib/platform";
import { TextProperties, useSelectedTextGroup } from "./Lettering";
import { Presets, StitchDefaults, StitchPreview, StylePicker } from "./StitchPanel";
import { TransformPanel } from "./TransformPanel";
import { MeanderPicker } from "./MeanderPicker";
import { GradientSection } from "./GradientPanel";
import { ThreadCard, ThreadPicker } from "./ThreadPicker";
import { computeIssues, type Issue } from "../lib/issues";
import { memo, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useShallow } from "zustand/react/shallow";
import { buildLayerRows, dropOnRow, groupInfo, moveBlock, pruneGroups, type GroupLayerRow as GroupRow, type LayerListRow, type ObjectLayerRow as ObjectRow } from "../lib/layerRows";
import { liveGroups, within } from "../lib/groups";
import { filterRows, groupByKind, groupByThread, groupTargets, KIND_FILTERS, moveToGroup, rangeIds, solo, ungroupAll, type KindFilter } from "../lib/layerTools";
import { groupSelection, selectSimilar, ungroupSelection } from "../lib/arrange";
import { Menu } from "./MenuBar";
import type { MenuItem } from "./menuModel";
import {
  defaultDesignOptions,
  defaultGuide,
  nodeCount,
  normAngle,
  objectBounds,
  pathsToPath2D,
  satinOutline,
} from "../lib/geometry";
import { useStore, type StitchPatch } from "../store";
import type { DesignObject, DesignOptions } from "../types";
import { HoopOptions } from "./Bars";
import { HoopShapeRow, MaterialSection } from "./MaterialPanel";
import { HOOPS, hoopIndex, hoopOf } from "../lib/hoops";
import { Num, PatternInput, Row, Section, Slider, Toggle } from "./ui";
import { beansToPasses, formatPattern, parsePattern, passesToBeans } from "../lib/patterns";
import { defaultRippleGuide, guidePair, isRipple, useAsRippleGuide } from "../lib/rippleGuide";
import { clonesOf, unlinkClone } from "../lib/clones";
import { applyPatterns, patternPair } from "../lib/stitchPatterns";
import { TartanSection } from "./TartanPanel";
import { CutworkSection } from "./CutworkPanel";
import { ElementInfoSection } from "./ElementInfo";

function Thumb({ o, color }: { o: DesignObject; color: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current!;
    const dpr = window.devicePixelRatio || 1;
    c.width = 26 * dpr;
    c.height = 26 * dpr;
    const ctx = c.getContext("2d")!;
    ctx.clearRect(0, 0, c.width, c.height);
    const b = objectBounds(o);
    if (!b) return;
    const s = (20 * dpr) / Math.max(b.w, b.h, 0.1);
    ctx.setTransform(s, 0, 0, s, (c.width - b.w * s) / 2 - b.x * s, (c.height - b.h * s) / 2 - b.y * s);
    if (o.stitch.type === "fill" || o.stitch.type === "none" || o.stitch.type === "applique") {
      ctx.fillStyle = color;
      ctx.fill(pathsToPath2D(o.paths), "evenodd");
    } else if (o.stitch.type === "satin") {
      const p = satinOutline(o);
      ctx.fillStyle = color;
      if (p) ctx.fill(p, "evenodd");
    } else {
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.6 / s * dpr;
      ctx.stroke(pathsToPath2D(o.paths));
    }
  }, [o, color]);
  return <canvas ref={ref} className="thumb" style={{ width: 26, height: 26 }} />;
}

/** How bad an issue is: a shape of its own per level (never colour alone). */
const SEVERITY: Record<Issue["level"], LucideIcon> = { error: OctagonAlert, warning: TriangleAlert, info: Info };

/** What an issue is about, by its title. */
function IssueTopic({ title }: { title: string }) {
  const Icon: LucideIcon | null =
    /hoop/i.test(title) ? Hoop
    : /satin/i.test(title) ? StitchSatin
    : /dense/i.test(title) ? DensityMap
    : /fill/i.test(title) ? StitchFill
    : /running|long stitch/i.test(title) ? StitchRunning
    : /lettering/i.test(title) ? Type
    : /shape|self-inters|open|tiny/i.test(title) ? Shapes
    : null;
  return Icon ? <Icon size={12} className="issue-topic" aria-hidden /> : null;
}

function SeverityIcon({ level }: { level: Issue["level"] }) {
  const Icon = SEVERITY[level];
  return <Icon size={14} className={`lvl-${level}`} aria-label={level} />;
}

/** What the layer rows do, by row key; one stable object, so rows only re-render when their own data changes. */
interface LayerCtl {
  select: (key: string, e: React.MouseEvent | React.KeyboardEvent) => void;
  check: (key: string, on: boolean) => void;
  dragStart: (key: string) => void;
  dragOver: (key: string) => void;
  drop: (key: string) => void;
  dragEnd: () => void;
  rename: (key: string | null) => void;
  /** Alt: show only this row (again: everything). */
  toggle: (o: DesignObject, only?: boolean) => void;
  fold: (group: string, folded: boolean) => void;
  showGroup: (key: string, only?: boolean) => void;
  /** Right-click a row: its menu. */
  menu: (key: string, e: React.MouseEvent) => void;
  lockGroup: (key: string) => void;
  renameGroup: (group: string, name: string) => void;
  stepGroup: (key: string, dir: 1 | -1) => void;
}

/** Fold or unfold groups in the Layers tab (remembered with the view settings, never undone). */
export function setGroupsFolded(groups: string[], folded: boolean) {
  const s = useStore.getState();
  const rest = s.foldedGroups.filter((g) => !groups.includes(g));
  s.set({ foldedGroups: folded ? [...rest, ...groups].slice(-500) : rest });
}

/** Panel header button: fold every group, or unfold them all when all are folded. */
export function FoldAllGroups() {
  // every group, the ones inside other groups too
  const groups = useStore(useShallow((s) => [...liveGroups(s.doc)]));
  const folded = useStore((s) => s.foldedGroups);
  if (!groups.length) return null;
  const allFolded = groups.every((g) => folded.includes(g));
  const label = allFolded ? "Expand all groups" : "Collapse all groups";
  return (
    <button className="icon-btn" title={label} aria-label={label} onClick={() => setGroupsFolded(groups, !allFolded)}>
      {allFolded ? <ChevronsUpDown size={14} /> : <ChevronsDownUp size={14} />}
    </button>
  );
}

const LayerRow = memo(function LayerRow({
  o,
  rowKey,
  i,
  n,
  sel,
  color,
  drop,
  renaming,
  depth,
  ctl,
}: {
  o: DesignObject;
  rowKey: string;
  i: number;
  n: number;
  sel: boolean;
  color: string;
  drop: "above" | "below" | null;
  renaming: boolean;
  /** How many groups it is in (its indent). */
  depth: number;
  ctl: LayerCtl;
}) {
  const s = useStore.getState;
  return (
    <div
      className={`layer ${depth ? "member" : ""} ${sel ? "sel" : ""} ${o.visible ? "" : "hidden-obj"} ${drop ? `drop-${drop}` : ""}`}
      style={depth ? ({ "--depth": depth } as CSSProperties) : undefined}
      onContextMenu={(e) => ctl.menu(rowKey, e)}
      onClick={(e) => ctl.select(rowKey, e)}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        ctl.dragStart(rowKey);
      }}
      onDragOver={(e) => {
        e.preventDefault();
        ctl.dragOver(rowKey);
      }}
      onDrop={(e) => {
        e.preventDefault();
        ctl.drop(rowKey);
      }}
      onDragEnd={() => ctl.dragEnd()}
    >
      <GripVertical size={12} className="grip" />
      <input type="checkbox" checked={sel} onClick={(e) => e.stopPropagation()} onChange={(e) => ctl.check(rowKey, e.target.checked)} aria-label={`Select ${o.name}`} />
      <span className="idx">{i + 1}</span>
      <Thumb o={o} color={color} />
      <span
        className="lname"
        onDoubleClick={() => (o.text ? s().set({ editingText: o.text.group }) : ctl.rename(rowKey))}
        title={o.text ? "Lettering · double-click to edit the text" : o.name}
      >
        {o.text ? (
          <>
            <Type size={11} style={{ verticalAlign: -1, marginRight: 4, opacity: 0.7 }} />
            {o.text.content.split("\n")[0]}
          </>
        ) : renaming ? (
          <input
            autoFocus
            defaultValue={o.name}
            onClick={(e) => e.stopPropagation()}
            onBlur={(e) => {
              s().updateObject(o.id, { name: e.target.value || o.name });
              ctl.rename(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              if (e.key === "Escape") ctl.rename(null);
            }}
          />
        ) : (
          o.name
        )}
      </span>
      <button
        className="mini"
        title={`${o.visible ? `Hide ${o.name}` : `Show ${o.name}`} · Alt-click: show only this`}
        onClick={(e) => {
          e.stopPropagation();
          ctl.toggle(o, e.altKey);
        }}
      >
        {o.visible ? <Eye size={14} /> : <EyeOff size={14} />}
      </button>
      <button className="mini" title={`Move ${o.name} later in stitch order`} onClick={(e) => (e.stopPropagation(), s().moveInOrder(o.id, 1))} disabled={i === n - 1}>
        <ChevronUp size={14} />
      </button>
      <button className="mini" title={`Move ${o.name} earlier in stitch order`} onClick={(e) => (e.stopPropagation(), s().moveInOrder(o.id, -1))} disabled={i === 0}>
        <ChevronDown size={14} />
      </button>
    </div>
  );
});

const ROLE_LABEL: Record<GroupRow["role"], string> = { group: "Group", gradient: "Gradient", tartan: "Tartan" };

/** A group's header row: fold, select, show / hide and lock its members together, rename it. */
const GroupHeader = memo(function GroupHeader({
  r,
  sel,
  colors,
  drop,
  renaming,
  first,
  last,
  ctl,
}: {
  r: GroupRow;
  sel: "all" | "some" | "none";
  colors: string[];
  drop: "above" | "below" | null;
  renaming: boolean;
  first: boolean;
  last: boolean;
  ctl: LayerCtl;
}) {
  const box = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (box.current) box.current.indeterminate = sel === "some";
  }, [sel]);
  const shown = colors.slice(0, 5);
  const what = `${ROLE_LABEL[r.role].toLowerCase()} ${r.name}`;
  return (
    <div
      className={`layer group-head ${r.depth ? "member" : ""} ${sel === "all" ? "sel" : sel === "some" ? "part" : ""} ${r.visible === "none" ? "hidden-obj" : ""} ${drop ? `drop-${drop}` : ""}`}
      style={r.depth ? ({ "--depth": r.depth } as CSSProperties) : undefined}
      onContextMenu={(e) => ctl.menu(r.key, e)}
      tabIndex={0}
      aria-label={`${ROLE_LABEL[r.role]} ${r.name}, ${r.count} ${r.count === 1 ? "object" : "objects"}, ${r.folded ? "folded" : "unfolded"}`}
      onClick={(e) => ctl.select(r.key, e)}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget && (e.target as HTMLElement).tagName === "INPUT") return;
        const k = e.key;
        if ((k === "ArrowLeft" && !r.folded) || (k === "ArrowRight" && r.folded)) ctl.fold(r.group, k === "ArrowLeft");
        else if (k === "Enter" && e.target === e.currentTarget) ctl.select(r.key, e);
        else if (k === "F2") ctl.rename(r.key);
        else if (k !== "ArrowLeft" && k !== "ArrowRight") return;
        e.preventDefault();
        e.stopPropagation();
      }}
      draggable={!renaming}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        ctl.dragStart(r.key);
      }}
      onDragOver={(e) => {
        e.preventDefault();
        ctl.dragOver(r.key);
      }}
      onDrop={(e) => {
        e.preventDefault();
        ctl.drop(r.key);
      }}
      onDragEnd={() => ctl.dragEnd()}
    >
      <GripVertical size={12} className="grip" />
      <input ref={box} type="checkbox" checked={sel === "all"} onClick={(e) => e.stopPropagation()} onChange={(e) => ctl.check(r.key, e.target.checked)} aria-label={`Select the ${what}`} />
      <button
        className={`mini fold ${r.folded ? "" : "open"}`}
        aria-expanded={!r.folded}
        aria-label={`${r.folded ? "Unfold" : "Fold"} the ${what}`}
        title={`${r.folded ? "Unfold" : "Fold"} (← →)`}
        onClick={(e) => {
          e.stopPropagation();
          ctl.fold(r.group, !r.folded);
        }}
      >
        <ChevronRight size={14} />
      </button>
      <span className="lname" onDoubleClick={() => ctl.rename(r.key)} title={`${r.name} · ${ROLE_LABEL[r.role].toLowerCase()} of ${r.count} · double-click to rename`}>
        {renaming ? (
          <input
            autoFocus
            defaultValue={r.name}
            aria-label={`Name of the ${what}`}
            onClick={(e) => e.stopPropagation()}
            onBlur={(e) => {
              ctl.renameGroup(r.group, e.target.value.trim());
              ctl.rename(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              if (e.key === "Escape") ctl.rename(null);
            }}
          />
        ) : (
          <>
            {r.name}
            <span className="grp-n">{r.count}</span>
          </>
        )}
      </span>
      <span className="grp-sw" role="img" aria-label={`${colors.length} ${colors.length === 1 ? "thread" : "threads"}`}>
        {shown.map((c, k) => (
          <i key={k} style={{ background: c }} />
        ))}
        {colors.length > shown.length && <em>+{colors.length - shown.length}</em>}
      </span>
      <button
        className={`mini ${r.locked === "some" ? "mixed" : ""}`}
        title={r.locked === "all" ? `Unlock everything in ${r.name}` : `Lock everything in ${r.name}`}
        aria-label={r.locked === "all" ? `Unlock the ${what}` : `Lock the ${what}`}
        aria-pressed={r.locked === "all" ? true : r.locked === "some" ? "mixed" : false}
        onClick={(e) => {
          e.stopPropagation();
          ctl.lockGroup(r.key);
        }}
      >
        {r.locked === "none" ? <Unlock size={13} /> : <Lock size={13} />}
      </button>
      <button
        className={`mini ${r.visible === "some" ? "mixed" : ""}`}
        title={`${r.visible === "all" ? `Hide everything in ${r.name}` : `Show everything in ${r.name}`} · Alt-click: show only this`}
        aria-label={r.visible === "all" ? `Hide the ${what}` : `Show the ${what}`}
        onClick={(e) => {
          e.stopPropagation();
          ctl.showGroup(r.key, e.altKey);
        }}
      >
        {r.visible === "none" ? <EyeOff size={14} /> : <Eye size={14} />}
      </button>
      <button className="mini" title={`Move ${r.name} later in stitch order`} onClick={(e) => (e.stopPropagation(), ctl.stepGroup(r.key, 1))} disabled={first}>
        <ChevronUp size={14} />
      </button>
      <button className="mini" title={`Move ${r.name} earlier in stitch order`} onClick={(e) => (e.stopPropagation(), ctl.stepGroup(r.key, -1))} disabled={last}>
        <ChevronDown size={14} />
      </button>
    </div>
  );
});

export function LayersPanel() {
  const doc = useStore((s) => s.doc);
  const selection = useStore((s) => s.selection);
  const foldedGroups = useStore((s) => s.foldedGroups);
  const s = useStore.getState;
  const [renaming, setRenaming] = useState<string | null>(null);
  const [drag, setDrag] = useState<{ key: string; over: string | null; at: "above" | "below" } | null>(null);
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<KindFilter>("all");
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  /** Where a Shift-click range starts: the row clicked last. */
  const anchor = useRef<string | null>(null);
  const filtering = !!query.trim() || kind !== "all";
  const colors = new Map(doc.threads.map((t) => [t.id, t.color]));
  const n = doc.objects.length;
  const selected = new Set(selection);
  // top of the list = stitched last (sits on top); a lettering shows as one row, a group as a foldable header
  // while filtering, the groups open so what matches shows
  const allRows = useMemo(
    () => buildLayerRows(doc.objects, new Set(filtering ? [] : foldedGroups), doc.groupNames, doc.groupParents),
    [doc.objects, foldedGroups, doc.groupNames, doc.groupParents, filtering],
  );
  const rows = useMemo(() => filterRows(allRows, doc, query, kind), [allRows, doc, query, kind]);
  // the handlers read the current state through a ref: one stable object for every row
  const cur = useRef({ drag, setDrag, setRenaming, rows, setMenu });
  cur.current = { drag, setDrag, setRenaming, rows, setMenu };
  const ctl = useRef<LayerCtl | null>(null);
  if (!ctl.current) {
    const row = (key: string) => cur.current.rows.find((r) => r.key === key);
    const setAll = (ids: string[], patch: (o: DesignObject) => Partial<DesignObject>) => {
      const set = new Set(ids);
      s().commit((d) => ({ ...d, objects: d.objects.map((x) => (set.has(x.id) ? { ...x, ...patch(x) } : x)) }));
    };
    ctl.current = {
      select: (key, e) => {
        const r = row(key);
        if (!r) return;
        const sel = s().selection;
        const ids = r.ids;
        const on = r.kind === "group" ? ids.every((id) => sel.includes(id)) : sel.includes(r.o.id);
        // the row clicked last may be filtered out or folded away: then this is a plain click
        if (e.shiftKey && anchor.current && anchor.current !== key && row(anchor.current)) {
          // Shift: the rows from the one clicked last to this one (Ctrl+Shift adds them)
          const range = rangeIds(cur.current.rows, anchor.current, key);
          s().select(e.metaKey || e.ctrlKey ? [...new Set([...sel, ...range])] : range);
          return;
        }
        anchor.current = key;
        if (e.shiftKey || e.metaKey || e.ctrlKey) s().select(on ? sel.filter((x) => !ids.includes(x)) : [...sel.filter((x) => !ids.includes(x)), ...ids]);
        else s().select(ids);
        if (r.kind === "object") s().set({ activeThread: r.o.thread });
      },
      check: (key, on) => {
        const ids = row(key)?.ids ?? [];
        const sel = s().selection;
        s().select(on ? [...sel.filter((x) => !ids.includes(x)), ...ids] : sel.filter((x) => !ids.includes(x)));
      },
      dragStart: (key) => cur.current.setDrag({ key, over: null, at: "above" }),
      dragOver: (key) => {
        const { drag: d, rows: rs } = cur.current;
        if (!d) return;
        const from = rs.findIndex((r) => r.key === d.key);
        const to = rs.findIndex((r) => r.key === key);
        const t = rs[to];
        // a group over anything inside it goes nowhere
        const g = rs[from]?.kind === "group" ? (rs[from] as GroupRow).group : null;
        const doc = s().doc;
        const none = key === d.key || (!!g && !!t && (t.kind === "object" ? !!t.member && within(doc, t.member, g) : within(doc, t.group, g)));
        const over = none ? null : key;
        const at = to < from || (t?.kind === "group" && t.group === (rs[from] as ObjectRow | undefined)?.member) ? "above" : "below";
        if (d.over !== over || d.at !== at) cur.current.setDrag({ ...d, over, at });
      },
      drop: (key) => {
        const d = cur.current.drag;
        cur.current.setDrag(null);
        const from = d && row(d.key);
        const to = row(key);
        if (!from || !to) return;
        if (dropOnRow(s().doc, from, to) === s().doc) return;
        s().commit((doc) => pruneGroups(dropOnRow(doc, from, to)));
      },
      dragEnd: () => cur.current.setDrag(null),
      rename: (key) => cur.current.setRenaming(key),
      toggle: (o, only) => {
        const ids = o.text ? s().doc.objects.filter((x) => x.text?.group === o.text!.group).map((x) => x.id) : [o.id];
        if (only) s().commit((d) => solo(d, ids));
        else setAll(ids, () => ({ visible: !o.visible }));
      },
      fold: (group, folded) => setGroupsFolded([group], folded),
      showGroup: (key, only) => {
        const r = row(key);
        if (r?.kind !== "group") return;
        if (only) s().commit((d) => solo(d, r.ids));
        else setAll(r.ids, () => ({ visible: r.visible !== "all" }));
      },
      menu: (key, e) => {
        const r = row(key);
        if (!r) return;
        e.preventDefault();
        // the row's objects become the selection unless they are in it already
        const sel = s().selection;
        if (!r.ids.every((id) => sel.includes(id))) s().select(r.ids);
        const ids = s().selection;
        const doc = s().doc;
        const objs = doc.objects.filter((o) => ids.includes(o.id));
        const into = (g: string | undefined) => () => s().commit((d) => moveToGroup(d, s().selection, g));
        const targets = groupTargets(doc).filter(([g]) => !objs.every((o) => o.group === g) && !(r.kind === "group" && within(doc, g, r.group)));
        const items: MenuItem[] = [
          ...(r.kind === "group"
            ? ([
                { label: "Rename", run: () => cur.current.setRenaming(key) },
                { label: r.folded ? "Unfold" : "Fold", run: () => setGroupsFolded([r.group], !r.folded) },
                "-",
              ] as MenuItem[])
            : []),
          { label: "Group", kbd: "Ctrl+G", run: groupSelection, disabled: ids.length < 2 && r.kind !== "group" },
          { label: "Ungroup", kbd: "Ctrl+⇧G", run: ungroupSelection, disabled: !objs.some((o) => o.group) },
          {
            label: "Move to group",
            disabled: !targets.length && !objs.some((o) => o.group),
            sub: [
              ...targets.map(([g, name]): MenuItem => ({ label: name, run: into(g) })),
              ...(targets.length ? (["-"] as MenuItem[]) : []),
              { label: "Out of every group", run: into(undefined), disabled: !objs.some((o) => o.group) },
            ],
          },
          "-",
          {
            label: "Select same",
            sub: [
              { label: "Colour", run: () => selectSimilar("color") },
              { label: "Stitch type", run: () => selectSimilar("type") },
            ],
          },
          "-",
          { label: "Show only this", run: () => s().commit((d) => solo(d, ids)), hint: "Alt-click an eye does the same" },
          { label: "Show all", run: () => setAll(s().doc.objects.map((o) => o.id), () => ({ visible: true })), disabled: doc.objects.every((o) => o.visible) },
          { label: objs.every((o) => o.locked) ? "Unlock" : "Lock", run: () => setAll(ids, () => ({ locked: !objs.every((o) => o.locked) })) },
          "-",
          { label: "Delete", kbd: "Del", run: () => s().deleteSelection() },
        ];
        cur.current.setMenu({ x: e.clientX, y: e.clientY, items });
      },
      lockGroup: (key) => {
        const r = row(key);
        if (r?.kind === "group") setAll(r.ids, () => ({ locked: r.locked !== "all" }));
      },
      renameGroup: (group, name) => {
        const names = s().doc.groupNames ?? {};
        if ((names[group] ?? "") === name) return;
        const auto = !name || name === groupInfo(s().doc.objects, { ...names, [group]: "" }, s().doc.groupParents).get(group)?.name;
        s().commit((d) => {
          const { [group]: _, ...rest } = d.groupNames ?? {};
          const next = auto ? rest : { ...rest, [group]: name };
          return { ...d, groupNames: Object.keys(next).length ? next : undefined };
        });
      },
      stepGroup: (key, dir) => {
        const ts = siblings(cur.current.rows, key);
        const k = ts.findIndex((r) => r.key === key);
        const r = ts[k];
        const next = ts[k - dir];
        if (!r || !next) return;
        s().commit((d) => ({ ...d, objects: moveBlock(d.objects, r.ids, next.ids, dir > 0 ? "above" : "below") }));
      },
    };
  }
  if (!n)
    return (
      <>
        <div className="hint" style={{ padding: 14 }}>No objects yet. Draw with the tools on the left, import an SVG or embroidery file, or drop a picture to trace or auto-digitize.</div>
        <ReferencesList />
      </>
    );
  const dropOf = (key: string) => (drag?.over === key ? drag.at : null);
  const organise = (e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const run = (f: (d: typeof doc) => { doc: typeof doc; made: number }, what: string) => () => {
      const out = f(s().doc);
      if (!out.made) return s().toast(`Nothing to group: no two loose objects share a ${what}`);
      s().commit(() => out.doc);
      s().toast(`${out.made} group${out.made === 1 ? "" : "s"} by ${what} · the stitch order stays`, "success");
    };
    const groups = [...liveGroups(doc)];
    setMenu({
      x: r.left,
      y: r.bottom + 2,
      items: [
        { label: "Group loose objects by thread", run: run(groupByThread, "thread"), hint: "One group per thread colour; the stitch order stays" },
        { label: "Group loose objects by stitch type", run: run(groupByKind, "stitch type"), hint: "Fills, satins, lines and lettering; the stitch order stays" },
        { label: "Ungroup all", run: () => s().commit((d) => ungroupAll(d)), disabled: !groups.length },
        "-",
        { label: "Fold all groups", run: () => setGroupsFolded(groups, true), disabled: !groups.length },
        { label: "Unfold all groups", run: () => setGroupsFolded(groups, false), disabled: !groups.length },
        "-",
        { label: "Select what's listed", run: () => s().select([...new Set(rows.flatMap((x) => x.ids))]), hint: "Every object the filter shows" },
        { label: "Show all", run: () => s().commit((d) => ({ ...d, objects: d.objects.map((o) => (o.visible ? o : { ...o, visible: true })) })), disabled: doc.objects.every((o) => o.visible) },
        { label: "Unlock all", run: () => s().commit((d) => ({ ...d, objects: d.objects.map((o) => (o.locked ? { ...o, locked: false } : o)) })), disabled: !doc.objects.some((o) => o.locked) },
      ],
    });
  };
  return (
    <div onDragOver={(e) => e.preventDefault()}>
      <div className="layers-tools">
        <label className="layers-search">
          <Search size={13} aria-hidden="true" />
          <input
            type="search"
            placeholder="Find layers"
            aria-label="Find layers by name or thread"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setQuery("")}
          />
          {query && (
            <button className="mini" aria-label="Clear the search" onClick={() => setQuery("")}>
              <X size={12} />
            </button>
          )}
        </label>
        <select className="select" value={kind} aria-label="Show stitch type" onChange={(e) => setKind(e.target.value as KindFilter)}>
          {KIND_FILTERS.map(([k, label]) => (
            <option key={k} value={k}>
              {label}
            </option>
          ))}
        </select>
        <button className="icon-btn" title="Organise: group by thread or stitch type, fold, show and unlock all" aria-label="Organise layers" onClick={organise}>
          <FolderTree size={14} />
        </button>
      </div>
      {filtering && (
        <div className="layers-filtered">
          {rows.filter((x) => x.kind === "object").length} of {allRows.filter((x) => x.kind === "object").length} rows
          <button className="btn sm ghost" onClick={() => (setQuery(""), setKind("all"))}>
            Clear
          </button>
        </div>
      )}
      {menu && <Menu items={menu.items} x={menu.x} y={menu.y} onClose={() => setMenu(null)} />}
      {rows.map((r) =>
        r.kind === "group" ? (
          <GroupHeader
            key={r.key}
            r={r}
            sel={tri(r.ids.filter((id) => selected.has(id)).length, r.ids.length)}
            colors={r.threads.map((t) => colors.get(t) ?? "#222")}
            drop={dropOf(r.key)}
            renaming={renaming === r.key}
            first={siblings(rows, r.key)[0] === r}
            last={siblings(rows, r.key).at(-1) === r}
            ctl={ctl.current!}
          />
        ) : (
          <LayerRow
            key={r.key}
            o={r.o}
            rowKey={r.key}
            i={r.i}
            n={n}
            sel={selected.has(r.o.id)}
            color={colors.get(r.o.thread) ?? "#222"}
            drop={dropOf(r.key)}
            renaming={renaming === r.key}
            depth={r.depth}
            ctl={ctl.current!}
          />
        ),
      )}
      <ReferencesList />
    </div>
  );
}

const tri = (k: number, n: number) => (k === n ? "all" : k ? "some" : "none");

/** The group a row sits in (none at the top level). */
const containerOf = (r: LayerListRow) => (r.kind === "group" ? r.parent : r.member);

/** The rows next to `key` in the same group, top first. */
function siblings(rows: LayerListRow[], key: string): LayerListRow[] {
  const r = rows.find((x) => x.key === key);
  if (!r) return [];
  const c = containerOf(r);
  return rows.filter((x) => containerOf(x) === c);
}

/** Reference pictures: under the stitch layers (they are never stitched). */
function ReferencesList() {
  const refs = useStore((s) => s.doc.references) ?? [];
  const refEdit = useStore((s) => s.refEdit);
  const add = async () => {
    const f = await openFile([{ name: "Pictures", extensions: ["png", "jpg", "jpeg", "webp", "bmp", "gif"] }]);
    if (f) await addReference(f.name, f.bytes);
  };
  return (
    <div className="refs">
      <div className="refs-head">
        <span>References</span>
        <button className="mini" title="Add a picture to trace (or drop / paste one on the canvas)" onClick={add}>
          <ImagePlus size={14} />
        </button>
      </div>
      {!refs.length && <div className="hint refs-empty">Drop or paste a picture on the canvas to trace over it.</div>}
      {[...refs].reverse().map((r) => (
        <div
          key={r.id}
          className={`layer ref-row ${refEdit === r.id ? "sel" : ""} ${r.visible ? "" : "hidden-obj"}`}
          onDoubleClick={() => !r.locked && useStore.getState().set({ refEdit: r.id })}
          title={r.locked ? r.name : `${r.name} · double-click to adjust`}
        >
          <img className="thumb ref-thumb" src={r.src} alt="" />
          <span className="lname">{r.name}</span>
          <span className="stat">{Math.round(r.opacity * 100)}%</span>
          <button
            className="mini"
            title={r.locked ? "Locked" : "Adjust on the canvas"}
            disabled={r.locked}
            onClick={() => useStore.getState().set({ refEdit: refEdit === r.id ? null : r.id })}
          >
            <Move size={13} />
          </button>
          <button className="mini" title={r.locked ? "Unlock" : "Lock"} onClick={() => updateReference(r.id, { locked: !r.locked })}>
            {r.locked ? <Lock size={13} /> : <Unlock size={13} />}
          </button>
          <button className="mini" title={r.visible ? "Hide" : "Show"} onClick={() => updateReference(r.id, { visible: !r.visible })}>
            {r.visible ? <Eye size={14} /> : <EyeOff size={14} />}
          </button>
          <button className="mini" title="Up (drawn later)" onClick={() => moveReference(r.id, 1)}>
            <ChevronUp size={14} />
          </button>
          <button className="mini" title="Down (drawn earlier)" onClick={() => moveReference(r.id, -1)}>
            <ChevronDown size={14} />
          </button>
          <button className="mini" title="Remove" onClick={() => removeReference(r.id)}>
            <Trash2 size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}

export function ScenePanel() {
  const doc = useStore((s) => s.doc);
  const commit = useStore((s) => s.commit);
  return (
    <div className="props">
      <Section title="Hoop">
        <Row label="Preset">
          <select
            className="select"
            style={{ width: "100%" }}
            value={hoopIndex(doc.hoop)}
            onChange={(e) => {
              const h = HOOPS[+e.target.value];
              if (h) commit((d) => ({ ...d, hoop: hoopOf(h) }));
            }}
          >
            <option value={-1}>Custom</option>
            <HoopOptions />
          </select>
        </Row>
        <div className="grid2">
          <div className="row">
            <label>W</label>
            <Num value={doc.hoop.width} unit="mm" step={5} min={20} onChange={(v) => commit((d) => ({ ...d, hoop: { ...d.hoop, width: v, name: "Custom" } }))} />
          </div>
          <div className="row">
            <label>H</label>
            <Num value={doc.hoop.height} unit="mm" step={5} min={20} onChange={(v) => commit((d) => ({ ...d, hoop: { ...d.hoop, height: v, name: "Custom" } }))} />
          </div>
        </div>
        <HoopShapeRow />
      </Section>
      <Section title="Fabric & thread">
        <MaterialSection />
      </Section>
      <HiddenStitchingSection />
      <DesignOptionsSection />
      <MachineSettings />
      <Section title="Fabric look" defaultOpen={false}>
        <FabricLookRows />
      </Section>
    </div>
  );
}

/** Design-wide stitch processing (applied when the plan is built, objects stay as drawn). */
function DesignOptionsSection() {
  const doc = useStore((s) => s.doc);
  const o = doc.options ?? defaultDesignOptions();
  const set = (p: Partial<DesignOptions>) => useStore.getState().commit((d) => ({ ...d, options: { ...(d.options ?? defaultDesignOptions()), ...p } }));
  return (
    <Section title="Stitch processing">
      <Row label="Basting" title="Long stitches sewn first to hold fabric and stabiliser together (floating, hard-to-hoop items)">
        <select className="select" style={{ width: "100%" }} value={o.basting} onChange={(e) => set({ basting: e.target.value as DesignOptions["basting"] })}>
          <option value="none">None</option>
          <option value="box">Box around the design</option>
          <option value="contour">Following the design</option>
        </select>
      </Row>
      {o.basting !== "none" && (
        <>
          <Row label="Distance">
            <Num value={o.bastingMargin} unit="mm" step={1} min={0} max={40} onChange={(v) => set({ bastingMargin: v })} />
          </Row>
          <Row label="Stitch length">
            <Num value={o.bastingLength} unit="mm" step={0.5} min={2} max={10} onChange={(v) => set({ bastingLength: v })} />
          </Row>
        </>
      )}
      <KnockdownRow o={o} set={set} />
    </Section>
  );
}

/** What auto underlay does on the design's fabric. */
function AutoUnderlayHint({ kind }: { kind: "fill" | "satin" }) {
  const fabric = useStore((s) => s.doc.fabric);
  const knockdown = useStore((s) => !!s.doc.options?.knockdown);
  const label = fabricInfo(fabric).label;
  return (
    <p className="hint ul-auto">
      <Sparkles size={11} /> <b>Auto on {label}:</b> {kind === "fill" ? autoFillHint(fabric, knockdown) : autoSatinHint(fabric, knockdown)}
    </p>
  );
}

/** Knockdown in Design ▸ Stitch processing: on/off and what it is; the settings are in the knockdown dialog. */
function KnockdownRow({ o, set }: { o: DesignOptions; set: (p: Partial<DesignOptions>) => void }) {
  const fabricColor = useStore((s) => s.fabricColor);
  const on = !!o.knockdown;
  return (
    <Row label="Knockdown" title="A light net sewn first under the whole design: flattens the pile of towels, fleece and fur (laydown stitch)">
      <span className="dz-inline">
        <Toggle on={on} onChange={(v) => set(v ? { knockdown: true, knockdownColor: o.knockdownColor || fabricColor } : { knockdown: false })} />
        {on && (
          <span className="stat">
            {(o.knockdownLayers ?? 2) === 2 ? "crossed" : "single"} · {o.knockdownSpacing ?? 2} mm
          </span>
        )}
        <button className="btn sm ghost" title="Knockdown settings — for the whole design or an object under the selection" onClick={() => openKnockdown("design")}>
          Edit…
        </button>
      </span>
    </Row>
  );
}

function StitchOptions({ o }: { o: DesignObject }) {
  const st = o.stitch;
  const up = (p: StitchPatch) => useStore.getState().updateStitch(o.id, p);
  const live = (p: StitchPatch) => useStore.getState().updateStitch(o.id, p, true);
  const begin = () => useStore.getState().checkpoint();
  // sliders: preview live while dragging, one undo step
  const sl = (key: string) => ({
    onChange: (v: number) => up({ [key]: v } as StitchPatch),
    onLive: (v: number) => {
      if (!(window as unknown as { __sl?: boolean }).__sl) {
        begin();
        (window as unknown as { __sl?: boolean }).__sl = true;
        setTimeout(() => ((window as unknown as { __sl?: boolean }).__sl = false), 400);
      }
      live({ [key]: v } as StitchPatch);
    },
  });
  return (
    <>
      <StylePicker o={o} />
      {st.type !== "none" && <StitchPreview o={o} />}
      <StitchDefaults o={o} />
      {st.type === "fill" && st.gradient && <GradientSection group={st.gradient.group} />}
      {st.type === "fill" && !st.gradient && (
        <>
          {st.method === "tatami" && (
            <Row label="Density">
              <Presets
                items={[
                  ["Light", 0.4, "0.40 mm rows — soft, flexible, fewer stitches"],
                  ["Normal", 0.25, "0.25 mm rows — the standard"],
                  ["Dense", 0.2, "0.20 mm rows — full coverage on dark or textured fabric"],
                ]}
                value={st.rowSpacing}
                onPick={(v) => up({ rowSpacing: v })}
              />
            </Row>
          )}
          {st.method === "meander" && (
            <>
              <Row label="Pattern" title="The lattice or Ink/Stitch tile the meander walks on">
                <MeanderPicker
                  pattern={st.meanderPattern}
                  tile={st.meanderTile}
                  onPick={(p) => up(p.tile ? { meanderTile: p.tile } : { meanderPattern: p.pattern, meanderTile: undefined })}
                />
              </Row>
              {st.meanderTile ? (
                <Row label="Scale" title="Size of the tile (Ink/Stitch meander scale) — bigger is looser and uses fewer stitches">
                  {(() => {
                    // 2.5 mm ≙ 100 %
                    const s = sl("meanderScale");
                    return <Slider min={25} max={400} step={5} digits={0} value={((st.meanderScale ?? 2.5) / 2.5) * 100} unit="%" onChange={(v) => s.onChange(v / 40)} onLive={(v) => s.onLive(v / 40)} />;
                  })()}
                </Row>
              ) : (
                <Row label="Scale" title="Cell size of the lattice — bigger is looser and uses fewer stitches">
                  <Slider min={1} max={10} step={0.1} value={st.meanderScale ?? 2.5} unit="mm" {...sl("meanderScale")} />
                </Row>
              )}
              <Row label="Height" title="Stretch or squash the pattern: its height relative to its width (Ink/Stitch separate x / y meander scale)">
                <Slider min={25} max={400} step={5} digits={0} unit="%" value={Math.round((st.meanderAspect ?? 1) * 100)} onChange={(v) => up({ meanderAspect: v / 100 })} />
              </Row>
              <Row label="Smoothness" title="0 = sharp corners, 1 = soft curves">
                <Slider min={0} max={1} step={0.05} value={st.smoothness ?? 0.5} {...sl("smoothness")} />
              </Row>
              <Row label="Zig-zag" title="Sew the meander as a zig-zag line — a bold, textured fill (Ink/Stitch zig-zag meander)">
                <span className="dz-inline">
                  <Toggle on={(st.meanderZigzag ?? 0) > 0} onChange={(on) => up({ meanderZigzag: on ? 1.5 : 0 })} />
                  {(st.meanderZigzag ?? 0) > 0 && (
                    <>
                      <Num value={st.meanderZigzag ?? 1.5} step={0.1} min={0.2} max={6} unit="mm" onChange={(v) => up({ meanderZigzag: v })} />
                      <Num value={st.meanderZigzagWidth ?? 3} step={0.25} min={0.3} max={10} unit="mm" onChange={(v) => up({ meanderZigzagWidth: v })} />
                    </>
                  )}
                </span>
              </Row>
              <Row label="Clip to shape" title="Keep every stitch inside the shape — smoothing, the zig-zag and Expand can carry them over the edge (Ink/Stitch clip)">
                <Toggle on={!!st.meanderClip} onChange={(v) => up({ meanderClip: v })} />
              </Row>
              <Row label="Variation">
                <button className="btn sm" onClick={() => up({ seed: ((st.seed ?? 1) % 9973) + 1 })}>
                  Shuffle
                </button>
              </Row>
            </>
          )}
          {st.method === "guided" && (
            <>
              <p className="hint" style={{ margin: "2px 0 6px" }}>
                Rows follow the dashed guide line — drag its points and handles on the canvas.
              </p>
              <Row label="Rows" title="Copies of the guide shifted across (they bunch where it bends), or parallel to it at an even distance — and round its ends (Ink/Stitch guided fill strategies)">
                <div className="seg">
                  {(
                    [
                      ["copy", "Copies"],
                      ["parallel", "Parallel"],
                      ["buffer", "Around"],
                    ] as const
                  ).map(([v, l]) => (
                    <button key={v} className={(st.guidedStrategy ?? "copy") === v ? "on" : ""} onClick={() => up({ guidedStrategy: v })}>
                      {l}
                    </button>
                  ))}
                </div>
              </Row>
              <Row label="Guide">
                <button
                  className="btn sm"
                  title="Reset the guide to an S-curve across the shape"
                  onClick={() => {
                    const b = objectBounds(o);
                    if (b) up({ guide: defaultGuide(b) });
                  }}
                >
                  Reset
                </button>
                <span className="stat" title="Select the fill and an open line together, then Path ▸ Use line as fill guide">or draw a line → Path ▸ Use line as fill guide</span>
              </Row>
            </>
          )}
          {st.method !== "hilbert" && st.method !== "stipple" && st.method !== "guided" && st.method !== "circular" && (
            <Row label="Angle">
              <Slider min={-90} max={90} step={1} value={st.angle} unit="°" digits={1} {...sl("angle")} onChange={(v) => up({ angle: normAngle(v) })} />
            </Row>
          )}
          {st.method === "curved" && !st.gradient && (
            <Row label="Follow the shape" title="0 %: straight rows along the angle · 100 %: rows follow the outline">
              <Slider min={0} max={100} step={5} digits={0} unit="%" value={Math.round((st.curve ?? 1) * 100)} onChange={(v) => up({ curve: v / 100 })} />
            </Row>
          )}
          <Row label={st.method === "tatami" ? "Row spacing" : "Spacing"}>
            <Slider min={0.15} max={st.method === "hilbert" || st.method === "stipple" ? 4 : 1.2} step={0.01} value={st.rowSpacing} unit="mm" {...sl("rowSpacing")} />
          </Row>
          <Row label="Max stitch">
            <Slider min={1} max={7} step={0.1} value={st.maxStitchLength} unit="mm" {...sl("maxStitchLength")} />
          </Row>
          {["tatami", "contour", "spiral", "guided", "circular"].includes(st.method) && !st.gradient && (
            <RandomLength value={st.randomLength ?? 0} onChange={(v) => up({ randomLength: v })} onShuffle={() => up({ seed: ((st.seed ?? 1) % 9973) + 1 })} />
          )}
          <Row label="Travel stitch" title="Length of the hidden running stitches that travel inside the shape">
            <Num value={st.travelLength} step={0.5} min={1} max={6} unit="mm" onChange={(v) => up({ travelLength: v })} />
          </Row>
          {st.method === "tatami" && (
            <Row label="Underpath" title="Travel inside the shape between sections, hidden under rows sewn later (off: along the outline only)">
              <Toggle on={st.underpath ?? true} onChange={(v) => up({ underpath: v })} />
            </Row>
          )}
          {st.method === "tatami" && !st.gradient && (
            <Row label="Gap rows" title="Extra rows sewn past the end of each section before travelling on, so no gap opens between sections on stretchy fabric (Ink/Stitch gap filling; always an even number)">
              <Num value={st.gapFillRows ?? 0} step={2} min={0} max={10} digits={0} unit="rows" onChange={(v) => up({ gapFillRows: Math.ceil(Math.round(v) / 2) * 2 })} />
            </Row>
          )}
          {st.method === "cross" && (
            <Row label="Cross order" title="Which diagonal goes first (all crosses alike), and how often each is sewn">
              <span className="dz-inline">
                <div className="seg">
                  <button className={!st.crossFlip ? "on" : ""} onClick={() => up({ crossFlip: false })} title="Top-left to bottom-right first">
                    \ then /
                  </button>
                  <button className={st.crossFlip ? "on" : ""} onClick={() => up({ crossFlip: true })} title="Bottom-left to top-right first">
                    / then \
                  </button>
                </div>
                <Num value={st.crossThreads ?? 1} step={2} min={1} max={5} digits={0} unit="×" onChange={(v) => up({ crossThreads: Math.max(1, Math.round((v - 1) / 2) * 2 + 1) })} />
              </span>
            </Row>
          )}
          {st.method === "tatami" && (
            <>
              <Row label="Centre out" title="Start in the middle and sew outwards to either side: the fabric is pushed out evenly instead of all towards one end — less puckering on large fills">
                <Toggle on={!!st.centerOut} onChange={(v) => up({ centerOut: v })} />
              </Row>
              <Row label="Skip last" title="Leave out the last stitch of every row: it sits right next to the first of the next one (fewer stitches, less build-up at the edges)">
                <Toggle on={!!st.skipLast} onChange={(v) => up({ skipLast: v })} />
              </Row>
            </>
          )}
          {st.method === "spiral" && (
            <Row label="Double spiral" title="In on every other ring and back out on the rest: it ends next to where it started">
              <Toggle on={!!st.contourDouble} onChange={(v) => up({ contourDouble: v })} />
            </Row>
          )}
          {(st.method === "contour" || st.method === "spiral") && (
            <Row label="Clockwise">
              <Toggle on={!!st.clockwise} onChange={(v) => up({ clockwise: v })} />
            </Row>
          )}
          {(st.method === "meander" || st.method === "circular" || st.method === "contour" || st.method === "spiral") && (
            <Row label="Repeats" title="The path sewn this many times, and bean stitch: every stitch sewn back and forth (bolder lines)">
              <span className="dz-inline">
                <Num value={st.repeats ?? 1} step={1} min={1} max={5} digits={0} onChange={(v) => up({ repeats: Math.round(v) })} />
                <span className="stat">bean</span>
                <Num value={st.beanRepeats ?? 0} step={2} min={0} max={6} digits={0} onChange={(v) => up({ beanRepeats: Math.round(v) })} />
              </span>
            </Row>
          )}
          {st.method === "tatami" && !st.gradient && (
            <Row label="Carving" title="Needle points lined up into a pattern (program split) — an embossed look">
              <span className="dz-inline">
                <select className="select" value={st.carve ?? "none"} onChange={(e) => up({ carve: e.target.value as NonNullable<typeof st.carve> })}>
                  {(
                    [
                      ["none", "None"],
                      ["diamonds", "Diamonds"],
                      ["waves", "Waves"],
                      ["chevrons", "Chevrons"],
                      ["bricks", "Bricks"],
                      ["circles", "Circles"],
                    ] as const
                  ).map(([k, l]) => (
                    <option key={k} value={k}>
                      {l}
                    </option>
                  ))}
                </select>
                {(st.carve ?? "none") !== "none" && <Num value={st.carveSize ?? 6} unit="mm" step={0.5} min={1} max={40} onChange={(v) => up({ carveSize: v })} />}
              </span>
            </Row>
          )}
          {st.method === "tartan" && st.tartan && <TartanSection t={st.tartan} />}
          {st.method === "cross" && (
            <>
              <Row label="Cell" title="Size of one cross">
                <Slider min={1} max={8} step={0.1} unit="mm" value={st.crossSize ?? 2.5} onChange={(v) => up({ crossSize: v })} />
              </Row>
              <Row label="Cell height" title="Cells taller or flatter than wide (Ink/Stitch pattern size x y); Square keeps them square">
                <span className="dz-inline">
                  <span style={{ opacity: st.crossSizeY ? 1 : 0.55 }}>
                    <Num value={st.crossSizeY || st.crossSize || 2.5} step={0.1} min={0.8} max={12} unit="mm" onChange={(v) => up({ crossSizeY: Math.abs(v - (st.crossSize ?? 2.5)) < 1e-6 ? 0 : v })} />
                  </span>
                  {!!st.crossSizeY && (
                    <button className="btn sm ghost" onClick={() => up({ crossSizeY: 0 })}>
                      Square
                    </button>
                  )}
                </span>
              </Row>
              <Row label="Coverage" title="How much of a cell must be inside the shape to get a cross">
                <Slider min={10} max={100} step={5} digits={0} unit="%" value={Math.round((st.crossCoverage ?? 0.5) * 100)} onChange={(v) => up({ crossCoverage: v / 100 })} />
              </Row>
              <Row label="Stitches">
                <div className="seg">
                  {(
                    [
                      ["cross", "×", "Both diagonals"],
                      ["half", "/", "Half cross: one diagonal"],
                      ["upright", "+", "Upright cross"],
                      ["double", "✳", "Double cross: one diagonal, the upright cross, then the other diagonal on top"],
                      ["smyrna", "⁜", "Smyrna cross: the diagonal cross, then the upright cross on top"],
                    ] as const
                  ).map(([k, l, t]) => (
                    <button key={k} title={t} className={(st.crossKind ?? "cross") === k ? "on" : ""} onClick={() => up({ crossKind: k })}>
                      {l}
                    </button>
                  ))}
                </div>
              </Row>
              {st.crossKind === "upright" && (
                <Row label="Dense" title="A second grid of upright crosses shifted by half a cell — a closed, woven look (Ink/Stitch dense upright cross)">
                  <Toggle on={!!st.crossDense} onChange={(v) => up({ crossDense: v })} />
                </Row>
              )}
              <Row label="Split longer" title="Split cross stitches longer than this — big cells stay secure (0 = never)">
                <Num value={st.crossMaxLength ?? 11} step={0.5} min={0} max={20} unit="mm" onChange={(v) => up({ crossMaxLength: v })} />
              </Row>
            </>
          )}
          {st.method === "tatami" && (
            <>
              <Row label="Staggers" title="Rows repeat their needle pattern every N rows">
                <Num value={st.staggers} step={1} min={1} max={12} digits={0} onChange={(v) => up({ staggers: Math.round(v) })} />
              </Row>
              <Row label="Gradient end" title="Row spacing at the far end (0 = off) — density gradient across the fill">
                <Num value={st.endRowSpacing} step={0.05} min={0} unit="mm" onChange={(v) => up({ endRowSpacing: v })} />
              </Row>
              {st.endRowSpacing > 0 && (
                <Row label="Even blend" title="Change the density (not the spacing) evenly — two opposite gradients add up to full coverage (colour blending)">
                  <Toggle on={!!st.gradientDensity} onChange={(v) => up({ gradientDensity: v })} />
                </Row>
              )}
              <Row label="Pull comp." title="Rows grow at both ends by this much, plus a share of their length">
                <span className="dz-inline">
                  <Num value={st.pullComp} step={0.05} unit="mm" onChange={(v) => up({ pullComp: v })} />
                  <Num value={Math.round((st.pullCompPct ?? 0) * 100)} step={1} min={0} max={30} unit="%" digits={0} onChange={(v) => up({ pullCompPct: v / 100 })} />
                </span>
              </Row>
            </>
          )}
          {(st.method === "radial" || st.method === "circular") && (
            <div className="grid2">
              <div className="row">
                <label>cx</label>
                <Num value={st.center[0]} step={0.05} min={0} max={1} onChange={(v) => up({ center: [v, st.center[1]] })} />
              </div>
              <div className="row">
                <label>cy</label>
                <Num value={st.center[1]} step={0.05} min={0} max={1} onChange={(v) => up({ center: [st.center[0], v] })} />
              </div>
            </div>
          )}
          <Section
            title="Underlay"
            extra={<Toggle on={st.underlay || !!st.underlayAuto} onChange={(v) => up(v ? { underlay: true } : { underlay: false, underlayAuto: false })} />}
          >
            <Presets
              items={[
                ["Auto", { underlayAuto: true, underlay: true }, "Chosen by the shape's size and the fabric"],
                ["None", { underlayAuto: false, underlay: false }, "No underlay — light fills, stable fabric"],
                ["Light", { underlayAuto: false, underlay: true, underlaySpacing: 1.2, underlayInset: 0.4 }, "Open grid that just holds the fabric"],
                ["Standard", { underlayAuto: false, underlay: true, underlaySpacing: 0.75, underlayInset: 0.3 }, "Good for most fabrics"],
                ["Heavy", { underlayAuto: false, underlay: true, underlaySpacing: 0.5, underlayInset: 0.2 }, "Stretchy or fluffy fabrics (knits, towels)"],
              ]}
              value={
                st.underlayAuto
                  ? { underlayAuto: true, underlay: true }
                  : st.underlay
                    ? { underlayAuto: false, underlay: true, underlaySpacing: st.underlaySpacing, underlayInset: st.underlayInset }
                    : { underlayAuto: false, underlay: false }
              }
              onPick={(v) => up(v)}
            />
            {st.underlayAuto && <AutoUnderlayHint kind="fill" />}
            {st.underlay && !st.underlayAuto && (
              <>
                <Row label="Edge run" title="A running stitch just inside the outline first: holds the edge so the fill's border stays crisp">
                  <Toggle on={!!st.underlayEdge} onChange={(v) => up({ underlayEdge: v })} />
                </Row>
                <Row label="Cross-hatch" title="Two tatami passes crossing at ±45° to the underlay angle (double tatami): for soft, stretchy and pile fabrics">
                  <Toggle on={!!st.underlayCross} onChange={(v) => up({ underlayCross: v })} />
                </Row>
                <Row label="Skip last" title="Leave out the last underlay stitch of every row (fewer stitches at the edges)">
                  <Toggle on={!!st.underlaySkipLast} onChange={(v) => up({ underlaySkipLast: v })} />
                </Row>
                <Row label="Stitch length">
                  <Num value={st.underlayStitchLength} step={0.5} min={1} max={6} unit="mm" onChange={(v) => up({ underlayStitchLength: v })} />
                </Row>
                <Row label="Angle (rel.)" title="Relative to the fill angle. Or a list of angles for several passes, e.g. 30 90 150">
                  <span className="dz-inline">
                    <Num value={st.underlayAngle} step={15} unit="°" onChange={(v) => up({ underlayAngle: v, underlayAngles: undefined })} />
                    <input
                      className="input"
                      style={{ width: 90 }}
                      placeholder="or a list"
                      title="Several passes: angles separated by spaces (Ink/Stitch's underlay angle list)"
                      defaultValue={(st.underlayAngles ?? []).join(" ")}
                      onBlur={(e) => {
                        const list = e.target.value.split(/[\s,]+/).map(Number).filter((x) => Number.isFinite(x) && e.target.value.trim() !== "");
                        up({ underlayAngles: list.length ? list : undefined });
                      }}
                    />
                  </span>
                </Row>
                <Row label="Spacing">
                  <Num value={st.underlaySpacing} step={0.1} min={0.3} unit="mm" onChange={(v) => up({ underlaySpacing: v })} />
                </Row>
                <Row label="Inset">
                  <Num value={st.underlayInset} step={0.1} min={0} unit="mm" onChange={(v) => up({ underlayInset: v })} />
                </Row>
              </>
            )}
          </Section>
        </>
      )}
      {st.type === "satin" && (
        <>
          {st.method === "satin" && (
            <Row label="Density">
              <Presets
                items={[
                  ["Open", 0.6, "0.6 mm — light, flexible"],
                  ["Normal", 0.4, "0.4 mm — the standard"],
                  ["Dense", 0.3, "0.3 mm — full, shiny coverage"],
                ]}
                value={st.spacing}
                onPick={(v) => up({ spacing: v })}
              />
            </Row>
          )}
          {o.paths.length === 1 && (
            <Row label="Width">
              <Slider min={0.5} max={12} step={0.1} value={st.width} unit="mm" {...sl("width")} />
            </Row>
          )}
          <Row label="Spacing">
            <Slider min={0.2} max={2} step={0.01} value={st.spacing} unit="mm" {...sl("spacing")} />
          </Row>
          <Row label="Pull comp.">
            <Num value={st.pullComp} step={0.05} unit="mm" onChange={(v) => up({ pullComp: v })} />
          </Row>
          <Row label="Pull comp. %">
            <Num value={st.pullCompPct} step={5} unit="%" onChange={(v) => up({ pullCompPct: v })} />
          </Row>
          <Row label="Split above" title="Split stitches longer than this (0 = off)">
            <Num value={st.maxStitchLength} step={0.5} min={0} unit="mm" onChange={(v) => up({ maxStitchLength: v })} />
          </Row>
          <Row label="Short stitch" title="In tight curves every other stitch is shortened by this share, where stitches come closer than the distance">
            <span className="dz-inline">
              <Num value={st.shortStitchInset * 100} step={5} min={0} max={90} unit="%" digits={0} onChange={(v) => up({ shortStitchInset: v / 100 })} />
              <Num value={st.shortStitchDistance ?? 0.25} step={0.05} min={0} max={2} unit="mm" onChange={(v) => up({ shortStitchDistance: v })} />
            </span>
          </Row>
          <Row label="Push comp." title="Pull the column's ends in: satins push the fabric out where they start and end">
            <Num value={st.pushComp ?? 0} step={0.1} min={0} max={3} unit="mm" onChange={(v) => up({ pushComp: v })} />
          </Row>
          {st.maxStitchLength > 0 && (
            <>
              <Row label="Split pattern" title="Where long stitches are split: evenly (the points line up), staggered from stitch to stitch, or at a random phase (Ink/Stitch split methods)">
                <div className="seg">
                  {(
                    [
                      ["even", "Even", { splitStaggers: 0, splitRandomPhase: false }],
                      ["s3", "Stagger 3", { splitStaggers: 3, splitRandomPhase: false }],
                      ["s4", "Stagger 4", { splitStaggers: 4, splitRandomPhase: false }],
                      ["random", "Random", { splitStaggers: 0, splitRandomPhase: true }],
                    ] as const
                  ).map(([k, l, patch]) => {
                    const cur = st.splitRandomPhase ? "random" : (st.splitStaggers ?? 0) >= 4 ? "s4" : (st.splitStaggers ?? 0) >= 2 ? "s3" : "even";
                    return (
                      <button key={k} className={cur === k ? "on" : ""} onClick={() => up(patch)}>
                        {l}
                      </button>
                    );
                  })}
                </div>
              </Row>
              {(st.splitStaggers ?? 0) < 2 && (
                <Row label="Split jitter" title={st.splitRandomPhase ? "Vary the length of the split stitches by up to this much" : "Move every split point by up to this share of a split stitch"}>
                  <span className="dz-inline">
                    <Num value={Math.round((st.splitJitter ?? 0) * 100)} step={5} min={0} max={100} unit="%" digits={0} onChange={(v) => up({ splitJitter: v / 100 })} />
                    {st.splitRandomPhase && (
                      <span title="Split stitches longer than this already (default: the max stitch length) — a gradual change between single and split stitches">
                        <Num value={st.splitMinLength || st.maxStitchLength} step={0.5} min={0.5} max={st.maxStitchLength} unit="mm≥" onChange={(v) => up({ splitMinLength: v >= st.maxStitchLength ? 0 : v })} />
                      </span>
                    )}
                  </span>
                </Row>
              )}
            </>
          )}
          <Row label="Texture" title="Random width (up to this much wider / narrower) and spacing for a hand-made look; Shuffle gives another pattern">
            <span className="dz-inline">
              <Num value={Math.round((st.randomWider ?? 0) * 100)} step={5} min={0} max={50} unit="%+" digits={0} onChange={(v) => up({ randomWider: v / 100 })} />
              <Num value={Math.round((st.randomNarrower ?? 0) * 100)} step={5} min={0} max={50} unit="%−" digits={0} onChange={(v) => up({ randomNarrower: v / 100 })} />
              <span title="Random spacing: each stitch's distance to the next varies by up to this much (Ink/Stitch random zig-zag spacing)">
                <Num value={Math.round((st.randomSpacing ?? 0) * 100)} step={5} min={0} max={100} unit="%↔" digits={0} onChange={(v) => up({ randomSpacing: v / 100 })} />
              </span>
              {((st.randomWider ?? 0) > 0 || (st.randomNarrower ?? 0) > 0 || (st.randomSpacing ?? 0) > 0 || (st.splitJitter ?? 0) > 0 || !!st.splitRandomPhase) && (
                <button className="btn sm ghost" title="Another random pattern" onClick={() => up({ randomSeed: ((st.randomSeed ?? 1) % 9973) + 1 })}>
                  Shuffle
                </button>
              )}
            </span>
          </Row>
          <Row label="Direction" title="Direction guides: lines across the column that set the stitch angle there (Ink/Stitch rungs)">
            <GuideActions />
          </Row>
          <Row label="Reverse">
            <Toggle on={st.reverse} onChange={(v) => up({ reverse: v })} />
          </Row>
          {o.paths.length > 1 && (
            <>
              <Row label="Swap rails">
                <Toggle on={st.swapRails} onChange={(v) => up({ swapRails: v })} />
              </Row>
              <Row label="Rail direction" title="A rail drawn the other way twists the satin: Auto detects it; set it by hand if a satin renders strangely (Ink/Stitch reverse rails)">
                <select className="select" value={st.reverseRails ?? "automatic"} onChange={(e) => up({ reverseRails: e.target.value as NonNullable<typeof st.reverseRails> })}>
                  <option value="automatic">Auto</option>
                  <option value="none">As drawn</option>
                  <option value="first">Reverse first</option>
                  <option value="second">Reverse second</option>
                  <option value="both">Reverse both</option>
                </select>
              </Row>
            </>
          )}
          <Section title="Colour stripes" defaultOpen={false}>
            <MulticolorSatin o={o} />
          </Section>
          <Section title="Underlay">
            <Presets
              items={[
                ["Auto", { underlayAuto: true }, "Chosen by the column's width and the fabric"],
                ["None", { underlayAuto: false, centerWalk: false, contourUnderlay: false, zigzagUnderlay: false }, "No underlay — thin columns"],
                ["Centre", { underlayAuto: false, centerWalk: true, contourUnderlay: false, zigzagUnderlay: false }, "Centre walk — narrow columns (< 2.5 mm)"],
                ["Edges", { underlayAuto: false, centerWalk: false, contourUnderlay: true, zigzagUnderlay: false }, "Contour underlay — crisp edges (2.5–4 mm)"],
                ["Full", { underlayAuto: false, centerWalk: false, contourUnderlay: true, zigzagUnderlay: true }, "Contour + zig-zag — wide columns, lofty look"],
              ]}
              value={
                st.underlayAuto
                  ? { underlayAuto: true }
                  : { underlayAuto: false, centerWalk: st.centerWalk, contourUnderlay: st.contourUnderlay, zigzagUnderlay: st.zigzagUnderlay }
              }
              onPick={(v) => up(v)}
            />
            {st.underlayAuto && <AutoUnderlayHint kind="satin" />}
            {!st.underlayAuto && (
            <>
            <Row label="Centre walk">
              <Toggle on={st.centerWalk} onChange={(v) => up({ centerWalk: v })} />
            </Row>
            {st.centerWalk && (
              <Row label="Walk" title="Passes along the column (there and back = 2) and where across it (50 % = centre)">
                <span className="dz-inline">
                  <Num value={st.centerWalkRepeats ?? 2} step={2} min={2} max={8} digits={0} onChange={(v) => up({ centerWalkRepeats: Math.max(2, Math.round(v / 2) * 2) })} />
                  <Num value={Math.round((st.centerWalkPosition ?? 0.5) * 100)} step={5} min={0} max={100} unit="%" digits={0} onChange={(v) => up({ centerWalkPosition: v / 100 })} />
                </span>
              </Row>
            )}
            {(st.centerWalk || st.contourUnderlay) && (
              <Row label="Run length" title="Stitch length of the centre walk and contour underlay">
                <Num value={st.underlayStitchLength ?? 2.5} step={0.5} min={1} max={6} unit="mm" onChange={(v) => up({ underlayStitchLength: v })} />
              </Row>
            )}
            <Row label="Contour">
              <Toggle on={st.contourUnderlay} onChange={(v) => up({ contourUnderlay: v })} />
            </Row>
            {st.contourUnderlay && (
              <Row label="Contour inset" title="Inset from the edges: a fixed distance plus a share of the column width">
                <span className="dz-inline">
                  <Num value={st.contourInset} step={0.1} min={0} unit="mm" onChange={(v) => up({ contourInset: v })} />
                  <Num value={Math.round((st.contourInsetPct ?? 0) * 100)} step={5} min={0} max={45} unit="%" digits={0} onChange={(v) => up({ contourInsetPct: v / 100 })} />
                </span>
              </Row>
            )}
            <Row label="Zig-zag">
              <Toggle on={st.zigzagUnderlay} onChange={(v) => up({ zigzagUnderlay: v })} />
            </Row>
            {st.zigzagUnderlay && (
              <>
                <Row label="ZZ spacing">
                  <Num value={st.zigzagUnderlaySpacing} step={0.25} min={0.5} unit="mm" onChange={(v) => up({ zigzagUnderlaySpacing: v })} />
                </Row>
                <Row label="ZZ inset" title="Inset from the edges: a fixed distance plus a share of the column width">
                  <span className="dz-inline">
                    <Num value={st.zigzagUnderlayInset} step={0.1} min={0} unit="mm" onChange={(v) => up({ zigzagUnderlayInset: v })} />
                    <Num value={Math.round((st.zigzagInsetPct ?? 0) * 100)} step={5} min={0} max={45} unit="%" digits={0} onChange={(v) => up({ zigzagInsetPct: v / 100 })} />
                  </span>
                </Row>
                <Row label="ZZ split" title="Split zig-zag underlay stitches longer than this (0 = never)">
                  <Num value={st.zigzagUnderlayMaxStitch ?? 0} step={0.5} min={0} max={10} unit="mm" onChange={(v) => up({ zigzagUnderlayMaxStitch: v })} />
                </Row>
              </>
            )}
            </>
            )}
          </Section>
        </>
      )}
      {st.type === "running" && st.zigzag && (
        <>
          <Row label="Width">
            <Slider min={0.5} max={8} step={0.1} unit="mm" value={st.zigzag.width} onChange={(v) => up({ zigzag: { ...st.zigzag!, width: v } })} />
          </Row>
          <Row label="Spacing" title="Length of one zig and zag together">
            <Slider min={0.2} max={4} step={0.05} unit="mm" value={st.zigzag.spacing} onChange={(v) => up({ zigzag: { ...st.zigzag!, spacing: v } })} />
          </Row>
          <Row label="Angle" title="Turn every zig-zag by this angle — spokes on curves (Ink/Stitch zig-zag angle)">
            <Slider min={-89} max={89} step={1} digits={0} unit="°" value={st.zigzag.angle} onChange={(v) => up({ zigzag: { ...st.zigzag!, angle: v } })} />
          </Row>
          <Row label="Pull comp." title="Widen each side against the fabric pulling the zig-zag together">
            <Num value={st.zigzag.pullComp} step={0.05} min={-1} max={2} unit="mm" onChange={(v) => up({ zigzag: { ...st.zigzag!, pullComp: v } })} />
          </Row>
          <Row label="Repeats" title="Passes along the path (2 = there and back on the same points)">
            <Num value={st.repeats} step={1} min={1} max={9} digits={0} onChange={(v) => up({ repeats: Math.round(v) })} />
          </Row>
        </>
      )}
      {st.type === "running" && !st.zigzag && (
        <>
          <Row label="Stitch">
            <Presets
              items={[
                ["Fine", 1.5, "1.5 mm — tight curves, small details"],
                ["Normal", 2.5, "2.5 mm — the standard"],
                ["Long", 3.5, "3.5 mm — straight lines, quilting"],
              ]}
              value={st.length}
              onPick={(v) => up({ length: v })}
            />
          </Row>
          <Row label="Length">
            <Slider min={0.5} max={6} step={0.1} value={st.length} unit="mm" {...sl("length")} />
          </Row>
          <Row label="Tolerance" title="How closely stitches follow curves">
            <Num value={st.tolerance} step={0.05} min={0.01} unit="mm" onChange={(v) => up({ tolerance: v })} />
          </Row>
          <Row label="Repeats" title="Passes along the path (2 = there and back)">
            <Num value={st.repeats} step={1} min={1} max={9} digits={0} onChange={(v) => up({ repeats: Math.round(v) })} />
          </Row>
          <Row label="Bean repeats" title="0 = single, 2 = triple (bean) stitch">
            <Num value={st.beanRepeats} step={2} min={0} max={8} digits={0} onChange={(v) => up({ beanRepeats: Math.round(v) })} />
          </Row>
          <CutworkSection o={o} />
          {!st.stem && !st.motif && (
            <Section title="Length pattern & texture" defaultOpen={!!(st.lengthPattern?.length || st.beanPattern?.length || st.randomLength)}>
              <Row label="Lengths" title="Several stitch lengths used in turn, e.g. “2 1” for long-short (Ink/Stitch). Empty: the length above">
                <PatternInput
                  value={st.lengthPattern}
                  placeholder={`${st.length} (even)`}
                  unit="mm"
                  parse={(t) => parsePattern(t, { min: 0.3, max: 12 })}
                  format={formatPattern}
                  onChange={(v) => up({ lengthPattern: v.length > 1 ? v : undefined, ...(v.length === 1 ? { length: v[0] } : {}) })}
                />
              </Row>
              <Row label="Bean pattern" title="Back-and-forth repeats per stitch in turn, e.g. “0 1” (1 = triple), Ink/Stitch style. Empty: the bean repeats above">
                <PatternInput
                  value={passesToBeans(st.beanPattern)}
                  placeholder={String(Math.ceil(st.beanRepeats / 2))}
                  parse={(t) => parsePattern(t, { min: 0, max: 5, integer: true })}
                  format={(v) => (v?.length ? formatPattern(v) : "")}
                  onChange={(v) => up({ beanPattern: v.length > 1 ? beansToPasses(v) : undefined, ...(v.length === 1 ? { beanRepeats: beansToPasses(v)[0] } : {}) })}
                />
              </Row>
              <RandomLength value={st.randomLength ?? 0} onChange={(v) => up({ randomLength: v })} onShuffle={() => up({ randomSeed: ((st.randomSeed ?? 1) % 9973) + 1 })} />
            </Section>
          )}
          {st.stem && (
            <Row label="Rope width" title="How far the stem stitches slant across the line">
              <Slider min={0.2} max={3} step={0.1} unit="mm" value={st.stem.width} onChange={(v) => up({ stem: { width: v } })} />
            </Row>
          )}
          {st.motif && (
            <>
              <Row label="Motif">
                <select className="select" value={st.motif.kind} onChange={(e) => up({ motif: { ...st.motif!, kind: e.target.value as typeof st.motif.kind } })}>
                  {(
                    [
                      ["wave", "Wave"],
                      ["zigzag", "Zig-zag"],
                      ["scallop", "Scallop"],
                      ["loop", "Loops"],
                      ["diamond", "Diamonds"],
                      ["cross", "Crosses"],
                    ] as const
                  ).map(([k, l]) => (
                    <option key={k} value={k}>
                      {l}
                    </option>
                  ))}
                </select>
              </Row>
              <Row label="Motif size" title="Length of one motif along the line (its height: half of it)">
                <Slider min={1.5} max={15} step={0.5} unit="mm" value={st.motif.size} onChange={(v) => up({ motif: { ...st.motif!, size: v } })} />
              </Row>
            </>
          )}
          {st.ripple && <RippleSection o={o} />}
        </>
      )}
      {st.type === "applique" && (
        <>
          <p className="hint" style={{ margin: "2px 0 8px" }}>
            Sews the placement line, stops so you can lay the fabric, tacks it down, stops so you can trim it, then covers the edge.
          </p>
          <Section title="1 · Placement line" extra={<Toggle on={st.placement} onChange={(v) => up({ placement: v })} />}>
            {st.placement && (
              <Row label="Stitch length">
                <Slider min={1} max={4} step={0.1} value={st.placementLength} unit="mm" {...sl("placementLength")} />
              </Row>
            )}
          </Section>
          <Section title="2 · Tack-down">
            <Row label="Stitch">
              <select className="select" style={{ width: "100%" }} value={st.tackdown} onChange={(e) => up({ tackdown: e.target.value })}>
                <option value="zigzag">Zig-zag</option>
                <option value="eStitch">E-stitch</option>
                <option value="run">Running stitch</option>
                <option value="none">None</option>
              </select>
            </Row>
            {st.tackdown !== "none" && (
              <Row label="Inset" title="Distance inside the edge">
                <Slider min={0} max={3} step={0.05} value={st.tackdownInset} unit="mm" {...sl("tackdownInset")} />
              </Row>
            )}
            {(st.tackdown === "zigzag" || st.tackdown === "eStitch") && (
              <>
                <Row label="Width">
                  <Slider min={0.5} max={4} step={0.1} value={st.tackdownWidth} unit="mm" {...sl("tackdownWidth")} />
                </Row>
                <Row label="Spacing">
                  <Slider min={0.4} max={4} step={0.1} value={st.tackdownSpacing} unit="mm" {...sl("tackdownSpacing")} />
                </Row>
              </>
            )}
          </Section>
          <Section title="3 · Cover">
            <Row label="Stitch">
              <select className="select" style={{ width: "100%" }} value={st.cover} onChange={(e) => up({ cover: e.target.value })}>
                <option value="satin">Satin</option>
                <option value="eStitch">E-stitch (blanket)</option>
                <option value="none">None (raw edge)</option>
              </select>
            </Row>
            {st.cover !== "none" && (
              <>
                <Row label="Width">
                  <Slider min={1} max={8} step={0.1} value={st.coverWidth} unit="mm" {...sl("coverWidth")} />
                </Row>
                <Row label="Spacing">
                  <Slider min={0.2} max={2.5} step={0.05} value={st.coverSpacing} unit="mm" {...sl("coverSpacing")} />
                </Row>
                <Row label="Offset" title="Shift the cover outwards (+) or inwards (−) from the edge">
                  <Slider min={-2} max={2} step={0.05} value={st.coverOffset} unit="mm" {...sl("coverOffset")} />
                </Row>
                <Row label="Pull comp.">
                  <Num value={st.pullComp} step={0.05} unit="mm" onChange={(v) => up({ pullComp: v })} />
                </Row>
                <Row label="Underlay">
                  <Toggle on={st.coverUnderlay} onChange={(v) => up({ coverUnderlay: v })} />
                </Row>
                {st.cover === "eStitch" && (
                  <Row label="Flip prongs">
                    <Toggle on={st.flip} onChange={(v) => up({ flip: v })} />
                  </Row>
                )}
              </>
            )}
          </Section>
          <Row label="Machine stops" title="Stop after the placement line and after the tack-down">
            <Toggle on={st.stops} onChange={(v) => up({ stops: v })} />
          </Row>
        </>
      )}
      {st.type === "manual" && (
        <>
          <div className="hint">
            Every node is a needle penetration (imported machine files use this). Edit nodes with the node tool (A), or{" "}
            <button className="link" onClick={() => useStore.getState().setDialog("rebuild")} title="Turn the stitches back into shapes that can be stitched again (Ink/Stitch Outline)">
              rebuild shapes from the stitches…
            </button>
          </div>
          <Row label="Split longer" title="Split stitches longer than this into even parts (0 = keep them; Ink/Stitch max stitch length)">
            <Num value={st.maxLength ?? 0} step={0.5} min={0} max={12} unit="mm" onChange={(v) => up({ maxLength: v || undefined })} />
          </Row>
          <Row label="Bean pattern" title="Back-and-forth repeats per stitch in turn, e.g. “1” (triple) or “0 1”">
            <PatternInput
              value={passesToBeans(st.beanPattern)}
              placeholder="0"
              parse={(t) => parsePattern(t, { min: 0, max: 5, integer: true })}
              format={(v) => (v?.length ? formatPattern(v) : "")}
              onChange={(v) => up({ beanPattern: v.some((x) => x > 0) ? beansToPasses(v) : undefined })}
            />
          </Row>
        </>
      )}
    </>
  );
}

/** Properties of several selected objects: transform, align, colour. */
function MultiProperties({ objects }: { objects: DesignObject[] }) {
  const threads = useStore((s) => s.doc.threads);
  const ids = objects.map((o) => o.id);
  const types = [...new Set(objects.map((o) => o.stitch.type))];
  return (
    <div className="props">
      <div className="props-head">
        <span className="grow">{objects.length} objects</span>
        <span className="stat">{types.join(" · ")}</span>
      </div>
      {(() => {
        const pair = guidePair(objects);
        if (!pair) return null;
        return (
          <Section title="Ripple guide">
            <p className="hint" style={{ margin: "2px 0 6px" }}>
              Copies of “{pair.ripple.name}” follow “{pair.guide.name}”{pair.guide.stitch.type === "satin" && pair.guide.paths.length >= 2 ? ", fitted between its rails" : ""} (Ink/Stitch guided ripples). The guide object is taken into the ripple.
            </p>
            <button
              className="btn primary sm"
              onClick={() => {
                useStore.getState().commit((d) => useAsRippleGuide(d, pair.ripple.id, pair.guide.id));
                useStore.getState().set({ selection: [pair.ripple.id] });
              }}
            >
              Use as ripple guide
            </button>
          </Section>
        );
      })()}
      {(() => {
        const pair = guidePair(objects) ? null : patternPair(objects);
        if (!pair) return null;
        return (
          <Section title="Stitch pattern" defaultOpen={false}>
            <p className="hint" style={{ margin: "2px 0 6px" }}>
              Draw over “{pair.target.name}”: lines add a needle point wherever a stitch crosses them, shapes leave the needle points inside them out (Ink/Stitch selection to pattern).
            </p>
            <button
              className="btn sm"
              onClick={() => {
                useStore.getState().commit((d) => applyPatterns(d, pair.target.id, pair.patterns.map((p) => p.id)));
                useStore.getState().set({ selection: [pair.target.id] });
              }}
            >
              Use {pair.patterns.length > 1 ? `these ${pair.patterns.length}` : "it"} as stitch pattern
            </button>
          </Section>
        );
      })()}
      <Section title="Transform">
        <TransformPanel objects={objects} />
      </Section>
      <Section title="Thread">
        <ThreadPicker
          value={objects[0]?.thread}
          mixed={!objects.every((o) => o.thread === objects[0]?.thread)}
          onPick={(id) => useStore.getState().commit((d) => ({ ...d, objects: d.objects.map((o) => (ids.includes(o.id) ? { ...o, thread: id } : o)) }))}
        />
        {!objects.every((o) => o.thread === objects[0]?.thread) && <p className="hint">{new Set(objects.map((o) => o.thread)).size} colours — pick one to give it to all.</p>}
        {threads.length === 0 && <p className="hint">No threads yet.</p>}
      </Section>
      <ElementInfoSection ids={ids} />
    </div>
  );
}

export function PropertiesPanel() {
  const doc = useStore((s) => s.doc);
  const selection = useStore((s) => s.selection);
  const textGroup = useSelectedTextGroup();
  if (textGroup) return <TextProperties group={textGroup} />;
  const sel = doc.objects.filter((o) => selection.includes(o.id));
  // the colour layers of one gradient are edited as one object
  const gradGroup = sel[0]?.stitch.type === "fill" ? sel[0].stitch.gradient?.group : undefined;
  const oneGradient = !!gradGroup && sel.every((x) => x.stitch.type === "fill" && x.stitch.gradient?.group === gradGroup);
  if (sel.length > 1 && !oneGradient) return <MultiProperties objects={sel} />;
  if (!sel.length)
    return (
      <div className="props">
        <div className="hint" style={{ padding: "10px 2px" }}>Select an object to see its settings. The hoop, fabric and machine are under Design.</div>
      </div>
    );
  const o = oneGradient ? [...sel].sort((a, b) => ((a.stitch as { gradient?: { layer: number } }).gradient?.layer ?? 0) - ((b.stitch as { gradient?: { layer: number } }).gradient?.layer ?? 0))[0] : sel[0];
  return (
    <div className="props">
      <div className="props-head">
        <span className="swatch" style={{ background: doc.threads.find((t) => t.id === o.thread)?.color }} />
        <span className="grow">{o.name}</span>
        <button className="icon-btn" title={o.visible ? "Hide" : "Show"} onClick={() => useStore.getState().updateObject(o.id, { visible: !o.visible })}>
          {o.visible ? <Eye size={14} /> : <EyeOff size={14} />}
        </button>
        <button className="icon-btn" title={o.locked ? "Unlock" : "Lock"} onClick={() => useStore.getState().updateObject(o.id, { locked: !o.locked })}>
          {o.locked ? <Lock size={14} /> : <Unlock size={14} />}
        </button>
      </div>
      <Section title="Transform">
        <TransformPanel objects={[o]} />
        <Row label="Nodes">{nodeCount(o)}</Row>
      </Section>
      {!oneGradient && (
      <Section title="Thread">
        <ThreadCard threadId={o.thread} />
        <ThreadPicker value={o.thread} onPick={(id) => useStore.getState().updateObject(o.id, { thread: id })} />
      </Section>
      )}
      {!!o.patterns?.length && (
        <Section title="Stitch patterns">
          <PatternList o={o} />
        </Section>
      )}
      {o.clone ? (
        <Section title="Clone">
          <CloneInfo o={o} />
        </Section>
      ) : (
        <Section title="Stitch options">
          <StitchOptions o={o} />
        </Section>
      )}
      {!o.clone && <ObjectHiddenSection o={o} />}
      <CommandsSection objects={oneGradient ? sel : [o]} />
      <ElementInfoSection ids={oneGradient ? sel.map((x) => x.id) : [o.id]} />
    </div>
  );
}

export function IssuesPanel() {
  const doc = useStore((s) => s.doc);
  const plan = useStore((s) => s.plan);
  const view = useStore((s) => s.view);
  const issues = computeIssues(doc, plan);
  const tiny = cleanupCandidates(doc);
  const cleanup = tiny.length ? (
    <div className="issue-cleanup">
      <span>
        <b>{tiny.length}</b> tiny or empty object{tiny.length > 1 ? "s" : ""} (fills under {DEFAULT_CLEANUP.minFillArea} mm², lines under {DEFAULT_CLEANUP.minLength} mm)
      </span>
      <button
        className="btn sm"
        title="Remove them in one step (undo brings them back) — Ink/Stitch Cleanup document"
        onClick={() => {
          const s = useStore.getState();
          const n = cleanupDocument(s.commit, s.doc);
          s.toast(`Removed ${n} object${n > 1 ? "s" : ""}`);
        }}
      >
        Clean up
      </button>
    </div>
  ) : null;
  if (!issues.length) return cleanup ?? <div className="hint" style={{ padding: 14 }}>No problems found. Markers appear on the canvas while this tab is open.</div>;
  const locate = (i: Issue) => {
    const s = useStore.getState();
    if (i.objId) s.select([i.objId]);
    const el = document.querySelector(".canvas-wrap")!.getBoundingClientRect();
    s.setView({ ox: el.width / 2 - i.at[0] * view.scale, oy: el.height / 2 - i.at[1] * view.scale });
  };
  return (
    <div>
      {cleanup}
      {issues.map((i) => {
        const o = doc.objects.find((x) => x.id === i.objId);
        return (
          <div key={i.id} className="issue" onClick={() => locate(i)}>
            <SeverityIcon level={i.level} />
            <div>
              <b>
                <IssueTopic title={i.title} />
                {i.title}
              </b>
              <span className="stat">
                {o ? `${o.name} · ` : ""}
                {i.detail}
              </span>
            </div>
            {i.fix && o && (
              <button
                className="btn sm"
                onClick={(e) => {
                  e.stopPropagation();
                  useStore.getState().commit((d) => ({ ...d, objects: d.objects.map((x) => ((i.fix!.scope ? i.fix!.scope(x) : x.id === o.id) ? i.fix!.apply(x) : x)) }));
                }}
              >
                {i.fix.label}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Issues worth a badge on the tab (warnings and errors). */
export function useIssueCount() {
  return useStore((s) => computeIssues(s.doc, s.plan).filter((i) => i.level !== "info").length);
}

/** Random stitch length (Ink/Stitch): off, or ± a share of every stitch, with a new pattern on Shuffle. */
function RandomLength({ value, onChange, onShuffle }: { value: number; onChange: (v: number) => void; onShuffle: () => void }) {
  return (
    <Row label="Random length" title="Vary every stitch length by up to this much, with a random start on each line — no lines or moiré across parallel rows (Ink/Stitch random stitch length)">
      <span className="dz-inline">
        <Toggle on={value > 0} onChange={(on) => onChange(on ? 10 : 0)} />
        {value > 0 && (
          <>
            <Num value={value} step={5} min={1} max={90} digits={0} unit="%" onChange={onChange} />
            <button className="btn sm ghost" title="Another random pattern" onClick={onShuffle}>
              Shuffle
            </button>
          </>
        )}
      </span>
    </Row>
  );
}

/** A per-object value that falls back to a design-wide one (shown greyed until set). */
/** Ripple stitch settings (Ink/Stitch ripple stitch): lines, guide, copies, grid. */
function RippleSection({ o }: { o: DesignObject }) {
  const st = o.stitch;
  if (!isRipple(o) || st.type !== "running" || !st.ripple) return null;
  const r = st.ripple;
  const up = (patch: Partial<typeof r>) => useStore.getState().updateObject(o.id, { stitch: { ...st, ripple: { ...r, ...patch } } });
  const closed = o.paths.length === 1 && o.paths[0].closed;
  const rails = o.paths.filter((p) => !p.closed).length >= 2;
  const guide = r.guide ?? [];
  const satinGuide = guide.length >= 2;
  return (
    <>
      <Section title="Ripple">
        <Row label="Lines" title="How many ripples: a count, or as many as fit at a minimum distance (Ink/Stitch line count / minimum line distance)">
          <span className="dz-inline">
            <div className="seg">
              <button className={!(r.minLineDist ?? 0) ? "on" : ""} onClick={() => up({ minLineDist: 0 })}>
                Count
              </button>
              <button className={(r.minLineDist ?? 0) > 0 ? "on" : ""} onClick={() => up({ minLineDist: r.minLineDist || 2 })}>
                Distance
              </button>
            </div>
            {(r.minLineDist ?? 0) > 0 ? (
              <Num value={r.minLineDist!} step={0.25} min={0.2} max={20} unit="mm" onChange={(v) => up({ minLineDist: v })} />
            ) : (
              <Num value={r.lines} step={1} min={1} max={200} digits={0} onChange={(v) => up({ lines: Math.round(v) })} />
            )}
          </span>
        </Row>
        {closed ? (
          <Row label="Inner size" title="Size of the innermost ripple (0 = shrinks to the centre)">
            <Slider min={0} max={0.95} step={0.01} value={r.minScale} onChange={(v) => up({ minScale: v })} />
          </Row>
        ) : (
          !rails &&
          !guide.length &&
          !r.fan && (
            <Row label="Spacing" title="Distance between the copies">
              <Slider min={0.3} max={10} step={0.1} unit="mm" value={r.spacing} onChange={(v) => up({ spacing: v })} />
            </Row>
          )
        )}
        <Row label="Spread" title="Bunch the ripples towards one end (exponent above 1) or the other; Flip turns it round (Ink/Stitch exponent)">
          <span className="dz-inline">
            <Slider min={0.25} max={4} step={0.05} value={r.exponent ?? 1} onChange={(v) => up({ exponent: v })} />
            <Toggle on={!!r.flipExponent} onChange={(v) => up({ flipExponent: v })} title="Flip" />
          </span>
        </Row>
        <Row label="Skip" title="Leave out ripples at the start and the end">
          <span className="dz-inline">
            <Num value={r.skipStart ?? 0} step={1} min={0} max={50} digits={0} unit="start" onChange={(v) => up({ skipStart: Math.round(v) })} />
            <Num value={r.skipEnd ?? 0} step={1} min={0} max={50} digits={0} unit="end" onChange={(v) => up({ skipEnd: Math.round(v) })} />
          </span>
        </Row>
        <Row label="Twist" title="Rotation from the first to the last ripple">
          <Slider min={-360} max={360} step={1} digits={0} unit="°" value={r.rotation} onChange={(v) => up({ rotation: v })} />
        </Row>
        <Row label="Reverse" title="Start at the centre / far copy">
          <Toggle on={r.reverse} onChange={(v) => up({ reverse: v })} />
        </Row>
      </Section>
      {!closed && (
        <Section title="Copies" defaultOpen={!!(r.joinPoint || r.flipCopies === false || r.staggers)}>
          <Row label="Back and forth" title="Sew every other copy backwards; off: every copy the same way, joined at the ends">
            <Toggle on={r.flipCopies ?? true} onChange={(v) => up({ flipCopies: v })} />
          </Row>
          <Row label="Joins" title="Where copies meet: flat connections, or points (Ink/Stitch join style)">
            <div className="seg">
              <button className={!r.joinPoint ? "on" : ""} onClick={() => up({ joinPoint: false })}>
                Flat
              </button>
              <button className={r.joinPoint ? "on" : ""} onClick={() => up({ joinPoint: true })}>
                Point
              </button>
            </div>
          </Row>
          <Row label="Staggers" title="Needle points shifted from line to line over this many lines (0 = even stitches)">
            <Num value={r.staggers ?? 0} step={1} min={0} max={12} digits={0} onChange={(v) => up({ staggers: Math.round(v) })} />
          </Row>
          {!rails && !guide.length && (
            <Row label="Towards target" title="Without a guide: parallel copies, or copies fanned towards the target (Ink/Stitch)">
              <div className="seg">
                <button className={!r.fan ? "on" : ""} onClick={() => up({ fan: false })}>
                  Parallel
                </button>
                <button className={r.fan ? "on" : ""} onClick={() => up({ fan: true })}>
                  Fan
                </button>
              </div>
            </Row>
          )}
          <Row label="Manual points" title="The outline's own points are the stitches — no running stitch in between (Ink/Stitch manual pattern placement)">
            <Toggle on={!!r.manual} onChange={(v) => up({ manual: v })} />
          </Row>
        </Section>
      )}
      {!closed && !rails && (
        <Section title="Guide" defaultOpen={guide.length > 0}>
          {guide.length ? (
            <>
              <p className="hint" style={{ margin: "2px 0 6px" }}>
                {satinGuide ? "Copies are fitted between the rails of the satin guide." : "Copies follow the guide line — drag its points on the canvas."}
              </p>
              <Row label="Scale" title="Size of the first and the last copy along the guide (Ink/Stitch scale start / end)">
                <span className="dz-inline">
                  <Num value={r.scaleStart ?? 100} step={5} min={0} max={400} digits={0} unit="%" onChange={(v) => up({ scaleStart: v })} />
                  <Num value={r.scaleEnd ?? 100} step={5} min={0} max={400} digits={0} unit="%" onChange={(v) => up({ scaleEnd: v })} />
                </span>
              </Row>
              <Row label="Scale axes">
                <div className="seg">
                  {(
                    [
                      ["both", "X Y"],
                      ["x", "X"],
                      ["y", "Y"],
                      ["none", "None"],
                    ] as const
                  ).map(([k, l]) => (
                    <button key={k} className={(r.scaleAxis ?? "both") === k ? "on" : ""} onClick={() => up({ scaleAxis: k })}>
                      {l}
                    </button>
                  ))}
                </div>
              </Row>
              <Row label="Turn with guide" title="Copies turn with the guide's direction">
                <Toggle on={r.rotateRipples ?? true} onChange={(v) => up({ rotateRipples: v })} />
              </Row>
              {satinGuide && (
                <Row label="Copies at" title="By the line count, at the satin's rungs, or as many as fit without overlapping (Ink/Stitch pattern position)">
                  <div className="seg">
                    {(
                      [
                        ["lineCount", "Count"],
                        ["rungs", "Rungs"],
                        ["adaptive", "Fit"],
                      ] as const
                    ).map(([k, l]) => (
                      <button key={k} className={(r.guidePosition ?? "lineCount") === k ? "on" : ""} onClick={() => up({ guidePosition: k })}>
                        {l}
                      </button>
                    ))}
                  </div>
                </Row>
              )}
              <button className="btn sm ghost" onClick={() => up({ guide: undefined, anchor: undefined })}>
                Remove guide
              </button>
            </>
          ) : (
            <>
              <p className="hint" style={{ margin: "2px 0 6px" }}>
                Copies can follow a guide line or a satin column: select it together with this ripple and choose “Use as ripple guide”.
              </p>
              <button
                className="btn sm"
                onClick={() => {
                  const g = defaultRippleGuide(o);
                  if (g) up({ guide: [g], scaleStart: 100, scaleEnd: 100 });
                }}
              >
                Add a straight guide
              </button>
            </>
          )}
        </Section>
      )}
      <Section title="Grid" defaultOpen={(r.gridSize ?? 0) > 0}>
        <Row label="Grid" title="Lines across the ripples, their points this far apart — a net (Ink/Stitch grid)">
          <span className="dz-inline">
            <Toggle on={(r.gridSize ?? 0) > 0} onChange={(on) => up({ gridSize: on ? 3 : 0 })} />
            {(r.gridSize ?? 0) > 0 && <Num value={r.gridSize!} step={0.5} min={0.5} max={30} unit="mm" onChange={(v) => up({ gridSize: v })} />}
          </span>
        </Row>
        {(r.gridSize ?? 0) > 0 && (
          <Row label="Grid first" title="Sew the grid before the ripples">
            <Toggle on={!!r.gridFirst} onChange={(v) => up({ gridFirst: v })} />
          </Row>
        )}
      </Section>
      {(closed || !guide.length || r.fan) && (
        <p className="hint">
          {closed ? "Drag the target handle on the canvas to move the ripple centre." : "Drag the target handle to choose the side the copies go to."}
          {r.target && (
            <button className="btn sm ghost" onClick={() => up({ target: undefined })} style={{ marginLeft: 6 }}>
              Reset
            </button>
          )}
        </p>
      )}
    </>
  );
}

/** A linked clone: what it follows, its own fill angle, and unlinking it. */
function CloneInfo({ o }: { o: DesignObject }) {
  const doc = useStore((s) => s.doc);
  const link = o.clone!;
  const src = doc.objects.find((x) => x.id === link.of);
  const fill = o.stitch.type === "fill" ? o.stitch : null;
  const setLink = (patch: Partial<typeof link>) => useStore.getState().updateObject(o.id, { clone: { ...link, ...patch } });
  return (
    <>
      <p className="hint" style={{ margin: "2px 0 6px" }}>
        Follows “{src?.name ?? "?"}”: its shape and stitch settings, moved, turned and scaled with this clone. Edit the original to change all its clones.
      </p>
      {fill && (
        <Row label="Own angle" title="Keep this fill angle instead of the original’s turned with the clone (Ink/Stitch clone angle)">
          <span className="dz-inline">
            <Toggle on={link.angle != null} onChange={(on) => setLink({ angle: on ? fill.angle : undefined })} />
            {link.angle != null && <Num value={link.angle} step={5} min={-180} max={180} digits={0} unit="°" onChange={(v) => setLink({ angle: v })} />}
          </span>
        </Row>
      )}
      <div className="dz-inline" style={{ marginTop: 6 }}>
        {src && (
          <button className="btn sm" onClick={() => useStore.getState().select([src.id])}>
            Select original
          </button>
        )}
        <button
          className="btn sm ghost"
          title="Make it a plain copy that no longer follows the original"
          onClick={() => useStore.getState().commit((d) => ({ ...d, objects: d.objects.map((x) => (x.id === o.id ? unlinkClone(x) : x)) }))}
        >
          Unlink
        </button>
      </div>
    </>
  );
}

/** Below an original: how many clones follow it. */
export function cloneCount(doc: { objects: DesignObject[] }, id: string) {
  return clonesOf(doc as never, id).length;
}

/** The stitch patterns drawn over an object: what each does, its interval, removing it. */
function PatternList({ o }: { o: DesignObject }) {
  const pats = o.patterns ?? [];
  const set = (k: number, patch: Partial<(typeof pats)[number]> | null) =>
    useStore.getState().updateObject(o.id, { patterns: pats.flatMap((p, i) => (i !== k ? [p] : patch ? [{ ...p, ...patch }] : [])) });
  return (
    <>
      {pats.map((p, k) => (
        <div key={k} className="pattern-item">
          <Row label={`Pattern ${k + 1}`} title="Lines add a needle point where stitches cross them; shapes leave the points inside out">
            <div className="seg">
              <button className={p.add && !p.remove ? "on" : ""} onClick={() => set(k, { add: true, remove: false })}>
                Add points
              </button>
              <button className={p.remove && !p.add ? "on" : ""} onClick={() => set(k, { add: false, remove: true })}>
                Leave out
              </button>
              <button className={p.add && p.remove ? "on" : ""} onClick={() => set(k, { add: true, remove: true })}>
                Both
              </button>
            </div>
          </Row>
          {p.add && (
            <Row label="Interval" title="Which crossings get a point, in turn: “2” every second one, “2 1” … (Ink/Stitch pattern interval); then how many to skip first">
              <span className="dz-inline">
                <PatternInput value={p.interval} placeholder="1" parse={(t) => parsePattern(t, { min: 1, max: 20, integer: true })} format={(v) => (v?.length ? formatPattern(v) : "")} onChange={(v) => set(k, { interval: v })} />
                <Num value={p.offset} step={1} min={0} max={50} digits={0} unit="skip" onChange={(v) => set(k, { offset: Math.round(v) })} />
              </span>
            </Row>
          )}
          <button className="btn sm ghost" onClick={() => set(k, null)}>
            Remove pattern
          </button>
        </div>
      ))}
    </>
  );
}
