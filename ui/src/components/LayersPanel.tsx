// The Layers panel: the objects in sew order with their groups, thumbnails,
// links and the reference pictures (split out of Dock.tsx).

import {
  CirclePause,
  Link2,
  Scissors,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  ChevronUp,
  Eye,
  EyeOff,
  GripVertical,
  ImagePlus,
  Lock,
  Move,
  Trash2,
  Type,
  Unlock,
  Search,
  X,
  FolderTree,
} from "lucide-react";
import { Jump } from "../icons/stitch";
import { addReference, moveReference, removeReference, updateReference } from "../lib/references";
import { openFile } from "../lib/platform";
import { memo, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  buildLayerRows,
  dropOnRow,
  groupInfo,
  moveBlock,
  pruneGroups,
  type GroupLayerRow as GroupRow,
  type LayerListRow,
  type ObjectLayerRow as ObjectRow,
} from "../lib/layerRows";
import { liveGroups, within } from "../lib/groups";
import {
  filterRows,
  groupByKind,
  groupByThread,
  groupTargets,
  KIND_FILTERS,
  moveToGroup,
  rangeIds,
  solo,
  ungroupAll,
  type KindFilter,
} from "../lib/layerTools";
import { groupSelection, selectSimilar, showAll, ungroupSelection, unlockAll } from "../lib/arrange";
import { Menu } from "./MenuBar";
import { lastInOrder, linkMenu } from "./linkMenu";
import { linkChoiceOf } from "../lib/links";
import { mod, type MenuItem } from "./menuModel";
import { objectBounds, pathsToPath2D, satinOutline } from "../lib/geometry";
import { useStore } from "../store";
import type { DesignObject } from "../types";
import { useDismiss } from "./ui";

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
      ctx.lineWidth = (1.6 / s) * dpr;
      ctx.stroke(pathsToPath2D(o.paths));
    }
  }, [o, color]);
  return <canvas ref={ref} className="thumb" style={{ width: 26, height: 26 }} />;
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
  /** The row's connection mark: the Trim / Jump / Sew menu of what follows it. */
  linkMenu: (id: string, e: React.MouseEvent) => void;
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

/** What follows an object when chosen by hand (trim, jump, sew, stop): a mark that opens the menu. */
function LinkMark({ o, ctl }: { o: DesignObject; ctl: LayerCtl }) {
  const c = linkChoiceOf(o);
  if (c === "auto" && !o.stopAfter) return null;
  const [Icon, what] = o.stopAfter
    ? [CirclePause, "A stop"]
    : c === "trim"
      ? [Scissors, "A trim"]
      : c === "jump"
        ? [Jump, "A jump without a trim"]
        : [Link2, "Sewn through"];
  return (
    <button
      className="mini link-mark manual"
      title={`${what} after ${o.name} (chosen by hand) · click to change`}
      onClick={(e) => {
        e.stopPropagation();
        ctl.linkMenu(o.id, e);
      }}
    >
      <Icon size={13} />
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
      <input
        type="checkbox"
        checked={sel}
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => ctl.check(rowKey, e.target.checked)}
        aria-label={`Select ${o.name}`}
      />
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
      <LinkMark o={o} ctl={ctl} />
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
      <button
        className="mini"
        title={`Move ${o.name} later in stitch order`}
        onClick={(e) => (e.stopPropagation(), s().moveInOrder(o.id, 1))}
        disabled={i === n - 1}
      >
        <ChevronUp size={14} />
      </button>
      <button
        className="mini"
        title={`Move ${o.name} earlier in stitch order`}
        onClick={(e) => (e.stopPropagation(), s().moveInOrder(o.id, -1))}
        disabled={i === 0}
      >
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
      <input
        ref={box}
        type="checkbox"
        checked={sel === "all"}
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => ctl.check(r.key, e.target.checked)}
        aria-label={`Select the ${what}`}
      />
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
      <span
        className="lname"
        onDoubleClick={() => ctl.rename(r.key)}
        title={`${r.name} · ${ROLE_LABEL[r.role].toLowerCase()} of ${r.count} · double-click to rename`}
      >
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
      <button
        className="mini"
        title={`Move ${r.name} earlier in stitch order`}
        onClick={(e) => (e.stopPropagation(), ctl.stepGroup(r.key, -1))}
        disabled={last}
      >
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
  const closeMenu = () => setMenu(null);
  useDismiss(!!menu, closeMenu, [".menu"]);
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
    const setAll = (ids: string[], patch: (o: DesignObject) => Partial<DesignObject>) => s().updateObject(ids, patch);
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
        const ids = o.text
          ? s()
              .doc.objects.filter((x) => x.text?.group === o.text!.group)
              .map((x) => x.id)
          : [o.id];
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
          { label: "Group", kbd: `${mod}G`, run: groupSelection, disabled: ids.length < 2 && r.kind !== "group" },
          { label: "Ungroup", kbd: `${mod}⇧G`, run: ungroupSelection, disabled: !objs.some((o) => o.group) },
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
          ...(r.kind !== "group" && ids.length
            ? ([{ label: "After it", hint: "Automatic, trim, jump or sew to the next object", sub: linkMenu(lastInOrder(ids)!) }, "-"] as MenuItem[])
            : []),
          { label: "Show only this", run: () => s().commit((d) => solo(d, ids)), hint: "Alt-click an eye does the same" },
          { label: "Show all", kbd: `${mod}Alt+3`, run: showAll, disabled: doc.objects.every((o) => o.visible) },
          { label: objs.every((o) => o.locked) ? "Unlock" : "Lock", run: () => setAll(ids, () => ({ locked: !objs.every((o) => o.locked) })) },
          "-",
          { label: "Delete", kbd: "Del", run: () => s().deleteSelection() },
        ];
        cur.current.setMenu({ x: e.clientX, y: e.clientY, items });
      },
      linkMenu: (id, e) => {
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        cur.current.setMenu({ x: r.left, y: r.bottom + 2, items: linkMenu(id) });
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
        <div className="hint" style={{ padding: 14 }}>
          No objects yet. Draw with the tools on the left, import an SVG or embroidery file, or drop a picture to trace or auto-digitize.
        </div>
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
        {
          label: "Group loose objects by stitch type",
          run: run(groupByKind, "stitch type"),
          hint: "Fills, satins, lines and lettering; the stitch order stays",
        },
        { label: "Ungroup all", run: () => s().commit((d) => ungroupAll(d)), disabled: !groups.length },
        "-",
        { label: "Fold all groups", run: () => setGroupsFolded(groups, true), disabled: !groups.length },
        { label: "Unfold all groups", run: () => setGroupsFolded(groups, false), disabled: !groups.length },
        "-",
        { label: "Select what's listed", run: () => s().select([...new Set(rows.flatMap((x) => x.ids))]), hint: "Every object the filter shows" },
        { label: "Show all", kbd: `${mod}Alt+3`, run: showAll, disabled: doc.objects.every((o) => o.visible) },
        { label: "Unlock all", kbd: `${mod}Alt+2`, run: unlockAll, disabled: !doc.objects.some((o) => o.locked) },
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
        <button
          className="icon-btn"
          title="Organise: group by thread or stitch type, fold, show and unlock all"
          aria-label="Organise layers"
          onClick={organise}
        >
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
      {menu && <Menu items={menu.items} x={menu.x} y={menu.y} onClose={closeMenu} />}
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
