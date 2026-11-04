// Arrange toolbar (align / distribute / mirror) and the arranging
// dialogs: Wreath · Kaleidoscope · Mirror-merge, Outlines & offsets, Colour
// blending.

import { AlignCenterHorizontal, AlignCenterVertical, AlignEndHorizontal, AlignEndVertical, AlignHorizontalDistributeCenter, AlignStartHorizontal, AlignStartVertical, AlignVerticalDistributeCenter, Crosshair, FlipHorizontal2, FlipVertical2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { align, distribute, mirrorSelection, outlineObject, repeatSelection, repeatTransforms, withOutline, type OutlineKind, type OutlineOptions, type RepeatMode } from "../lib/arrange";
import { centerInHoop } from "../lib/actions";
import { applyMat, objectBounds, unionBoxes } from "../lib/geometry";
import { useStore } from "../store";
import type { DesignObject, Vec2 } from "../types";
import { Dialog, Num, Row, Toggle } from "./ui";

/** Align / distribute / mirror buttons for the context bar. */
export function ArrangeButtons({ count }: { count: number }) {
  const b = (title: string, icon: React.ReactNode, run: () => void, disabled = false) => (
    <button title={title} onClick={run} disabled={disabled}>
      {icon}
    </button>
  );
  const to = count > 1 ? "selection" : "hoop";
  return (
    <>
      <div className="seg" role="group" aria-label="Align">
        {b(`Align left edges (to the ${to})`, <AlignStartVertical size={14} />, () => align("left"))}
        {b(`Centre horizontally (to the ${to})`, <AlignCenterVertical size={14} />, () => align("hcenter"))}
        {b(`Align right edges (to the ${to})`, <AlignEndVertical size={14} />, () => align("right"))}
        {b(`Align top edges (to the ${to})`, <AlignStartHorizontal size={14} />, () => align("top"))}
        {b(`Centre vertically (to the ${to})`, <AlignCenterHorizontal size={14} />, () => align("vcenter"))}
        {b(`Align bottom edges (to the ${to})`, <AlignEndHorizontal size={14} />, () => align("bottom"))}
      </div>
      {count > 2 && (
        <div className="seg" role="group" aria-label="Distribute">
          {b("Distribute horizontally (equal gaps)", <AlignHorizontalDistributeCenter size={14} />, () => distribute("h"))}
          {b("Distribute vertically (equal gaps)", <AlignVerticalDistributeCenter size={14} />, () => distribute("v"))}
        </div>
      )}
      <div className="seg" role="group" aria-label="Mirror">
        {b("Mirror horizontally", <FlipHorizontal2 size={14} />, () => mirrorSelection("h"))}
        {b("Mirror vertically", <FlipVertical2 size={14} />, () => mirrorSelection("v"))}
        {b("Centre in hoop", <Crosshair size={14} />, centerInHoop)}
      </div>
    </>
  );
}

const selectionBox = () => {
  const s = useStore.getState();
  return unionBoxes(s.doc.objects.filter((o) => s.selection.includes(o.id)).map(objectBounds));
};

function ThreadSwatches({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const threads = useStore((s) => s.doc.threads);
  return (
    <div className="thread-pick">
      {threads.map((t) => (
        <button key={t.id} title={t.name} className={t.id === value ? "on" : ""} style={{ background: t.color }} onClick={() => onChange(t.id)} />
      ))}
    </div>
  );
}

/** Small schematic of where the copies of a repeat go. */
function RepeatPreview({ mode, copies, center }: { mode: RepeatMode; copies: number; center: Vec2 }) {
  const box = selectionBox();
  const shapes = useMemo(() => {
    if (!box) return [];
    const pts: Vec2[] = [
      [box.x, box.y],
      [box.x + box.w, box.y],
      [box.x + box.w, box.y + box.h],
      [box.x + box.w * 0.25, box.y + box.h],
    ];
    return [{ pts, orig: true }, ...repeatTransforms({ mode, copies, center }).map(({ m }) => ({ pts: pts.map((p) => applyMat(m, p)), orig: false }))];
  }, [box, mode, copies, center]);
  const all = shapes.flatMap((s) => s.pts);
  if (!all.length) return null;
  const xs = all.map((p) => p[0]);
  const ys = all.map((p) => p[1]);
  const [x0, x1, y0, y1] = [Math.min(...xs, center[0]), Math.max(...xs, center[0]), Math.min(...ys, center[1]), Math.max(...ys, center[1])];
  const pad = Math.max(x1 - x0, y1 - y0) * 0.08 + 1;
  return (
    <svg className="repeat-preview" viewBox={`${x0 - pad} ${y0 - pad} ${x1 - x0 + 2 * pad} ${y1 - y0 + 2 * pad}`}>
      {shapes.map((s, i) => (
        <polygon key={i} points={s.pts.map((p) => p.join(",")).join(" ")} className={s.orig ? "orig" : ""} />
      ))}
      <circle cx={center[0]} cy={center[1]} r={pad * 0.25} />
    </svg>
  );
}

export function RepeatDialog({ onClose }: { onClose: () => void }) {
  const doc = useStore((s) => s.doc);
  const [mode, setMode] = useState<RepeatMode>("wreath");
  const [copies, setCopies] = useState(6);
  const [around, setAround] = useState<"hoop" | "radius">("radius");
  const [radius, setRadius] = useState(25);
  const box = selectionBox();
  const center: Vec2 =
    around === "hoop" || !box ? [doc.hoop.width / 2, doc.hoop.height / 2] : [box.x + box.w / 2, box.y + box.h / 2 + (mode.startsWith("mirror") ? box.h / 2 + radius / 5 : radius)];
  const rotational = mode === "wreath" || mode === "kaleidoscope";
  const total = repeatTransforms({ mode, copies, center }).length + 1;
  return (
    <Dialog
      live
      title="Wreath · Kaleidoscope · Mirror-merge"
      onClose={onClose}
      footer={
        <>
          <span className="hint">{total} copies in total</span>
          <div className="spacer" />
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            disabled={!box}
            onClick={() => {
              const n = repeatSelection({ mode, copies, center });
              useStore.getState().toast(`Created ${n} objects`, "success");
              onClose();
            }}
          >
            Create
          </button>
        </>
      }
    >
      {!box && <p className="hint warn">Select the objects to repeat first.</p>}
      <div className="seg" style={{ marginBottom: 10 }}>
        {(
          [
            ["wreath", "Wreath"],
            ["kaleidoscope", "Kaleidoscope"],
            ["mirrorH", "Mirror ↔"],
            ["mirrorV", "Mirror ↕"],
            ["mirrorHV", "Mirror 4×"],
          ] as [RepeatMode, string][]
        ).map(([id, label]) => (
          <button key={id} className={mode === id ? "on" : ""} onClick={() => setMode(id)}>
            {label}
          </button>
        ))}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 200px", gap: 16, alignItems: "start" }}>
        <div>
          {rotational && (
            <Row label="Copies" title="Number of repeats around the centre">
              <Num value={copies} step={1} min={2} max={36} digits={0} onChange={(v) => setCopies(Math.round(v))} />
            </Row>
          )}
          <Row label="Centre">
            <div className="seg">
              <button className={around === "radius" ? "on" : ""} onClick={() => setAround("radius")}>
                {rotational ? "Below selection" : "Next to selection"}
              </button>
              <button className={around === "hoop" ? "on" : ""} onClick={() => setAround("hoop")}>
                Hoop centre
              </button>
            </div>
          </Row>
          {around === "radius" && rotational && (
            <Row label="Radius" title="Distance from the selection's centre to the wreath centre">
              <Num value={radius} unit="mm" step={1} min={1} onChange={setRadius} />
            </Row>
          )}
          <p className="hint">
            {mode === "wreath" && "Copies rotate around the centre — rings, flowers, borders."}
            {mode === "kaleidoscope" && "Rotated copies plus their mirror images — snowflake-like symmetry."}
            {mode.startsWith("mirror") && "Mirror images joined at the centre line (mirror-merge)."} Fill angles follow every copy; mirrored
            lettering becomes shapes.
          </p>
        </div>
        <RepeatPreview mode={mode} copies={copies} center={center} />
      </div>
    </Dialog>
  );
}

/** Remembered settings of the outline dialog. */
const OUTLINE_KEY = "filum.outline";
interface OutlineSettings {
  kind: OutlineKind;
  offset: number;
  width: number;
  bridge: number;
  outerOnly: boolean;
}
const OUTLINE_DEFAULTS: OutlineSettings = { kind: "triple", offset: 1.5, width: 3, bridge: 0, outerOnly: false };
const loadOutline = (): OutlineSettings => {
  try {
    return { ...OUTLINE_DEFAULTS, ...JSON.parse(localStorage.getItem(OUTLINE_KEY) ?? "{}") };
  } catch {
    return OUTLINE_DEFAULTS;
  }
};

/**
 * Outlines & offsets: a running, triple or satin outline, a
 * backing fill or an appliqué around the selection — previewed live with its
 * stitches. Patch borders: Bridge gaps joins pieces that don't touch into one
 * border, Outer edge only leaves the holes out.
 */
export function OutlineDialog({ onClose }: { onClose: () => void }) {
  // the design and selection as they were when the dialog opened (the preview is added to it)
  const [orig] = useState(() => useStore.getState().doc);
  const [ids] = useState(() => useStore.getState().selection.filter((id) => orig.objects.some((o) => o.id === id && o.visible)));
  const firstThread = orig.objects.find((o) => ids.includes(o.id))?.thread ?? orig.threads[0]?.id ?? "";
  const [o, setO] = useState(loadOutline);
  const [thread, setThread] = useState(firstThread);
  const [behind, setBehind] = useState(o.kind === "fill" || o.kind === "applique");
  const [preview, setPreview] = useState<DesignObject | null>(null);
  const [busy, setBusy] = useState(false);
  const created = useRef(false);
  const set = (p: Partial<OutlineSettings>) =>
    setO((v) => {
      const next = { ...v, ...p };
      localStorage.setItem(OUTLINE_KEY, JSON.stringify(next));
      return next;
    });
  const opt: OutlineOptions = { kind: o.kind, offset: o.offset, width: o.width, thread, behind, bridge: o.bridge, outerOnly: o.outerOnly };

  // live preview: the outline object itself, with its stitches
  useEffect(() => {
    if (!ids.length) return;
    let live = true;
    const t = setTimeout(async () => {
      const obj = await outlineObject(orig, ids, opt);
      if (!live) return;
      setPreview(obj);
      useStore.getState().liveUpdate(() => (obj ? withOutline(orig, ids, obj, behind) : orig));
    }, 120);
    return () => {
      live = false;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [o, thread, behind]);
  // closing without Create takes the preview away
  useEffect(
    () => () => {
      if (!created.current && ids.length) useStore.getState().liveUpdate(() => orig);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const create = async () => {
    setBusy(true);
    try {
      const obj = preview ?? (await outlineObject(orig, ids, opt));
      if (!obj) {
        useStore.getState().toast("Nothing to outline", "error");
        setBusy(false);
        return;
      }
      created.current = true;
      const s = useStore.getState();
      s.liveUpdate(() => orig);
      s.commit((d) => withOutline(d, ids, obj, behind));
      s.select([obj.id]);
      s.toast(`${obj.name}: ${obj.paths.length} outline${obj.paths.length > 1 ? "s" : ""}`, "success");
      onClose();
    } catch (e) {
      useStore.getState().toast(String((e as Error).message ?? e), "error");
      setBusy(false);
    }
  };

  const kinds: [OutlineKind, string, string][] = [
    ["running", "Run", "Running stitch outline"],
    ["triple", "Triple run", "Bold triple (bean) stitch outline"],
    ["satin", "Satin border", "Satin column along the outline — the classic patch border"],
    ["fill", "Backing fill", "A filled shape behind the design (patches)"],
    ["applique", "Appliqué", "Placement, tack-down and cover along the outline"],
  ];
  // how many separate outlines the result has (outer edges and holes)
  const pieces = preview?.paths.length ?? 0;
  const patchKind = o.kind === "satin" || o.kind === "fill" || o.kind === "applique";
  return (
    <Dialog
      live
      title="Outlines & offsets"
      onClose={onClose}
      footer={
        <>
          <span className="stat">{ids.length ? (pieces ? `${pieces} outline${pieces > 1 ? "s" : ""}` : "—") : ""}</span>
          <div className="spacer" />
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!ids.length || busy || !preview} onClick={create}>
            {busy ? "Working…" : "Create"}
          </button>
        </>
      }
    >
      {!ids.length && <p className="hint warn">Select the objects to outline first.</p>}
      <div className="seg" style={{ marginBottom: 10, flexWrap: "wrap" }}>
        {kinds.map(([id, label, title]) => (
          <button
            key={id}
            title={title}
            className={o.kind === id ? "on" : ""}
            onClick={() => {
              // patch borders: one border around the whole art by default
              set(id === "satin" || id === "fill" || id === "applique" ? { kind: id, outerOnly: true, bridge: Math.max(o.bridge, 2) } : { kind: id });
              setBehind(id === "fill" || id === "applique");
            }}
          >
            {label}
          </button>
        ))}
      </div>
      <Row label="Offset" title="Distance from the design (negative = inside)">
        <Num value={o.offset} unit="mm" step={0.5} min={-10} max={50} onChange={(v) => set({ offset: v })} />
      </Row>
      {(o.kind === "satin" || o.kind === "applique") && (
        <Row label={o.kind === "satin" ? "Width" : "Cover width"}>
          <Num value={o.width} unit="mm" step={0.1} min={0.5} max={12} onChange={(v) => set({ width: v })} />
        </Row>
      )}
      <Row label="Bridge gaps" title="Join pieces of the art that don't touch — gaps up to twice this close — and fill narrow notches, so one border runs around everything (0: follow every gap)">
        <Num value={o.bridge} unit="mm" step={0.5} min={0} max={50} onChange={(v) => set({ bridge: v })} />
      </Row>
      <Row label="Outer edge only" title="No outlines around holes (letter counters, gaps inside the art)">
        <Toggle on={o.outerOnly} onChange={(v) => set({ outerOnly: v })} />
      </Row>
      <Row label="Colour">
        <ThreadSwatches value={thread} onChange={setThread} />
      </Row>
      <Row label="Sew it first" title="Place the new object behind the selection (backings, appliqué) instead of on top (borders)">
        <Toggle on={behind} onChange={setBehind} />
      </Row>
      {pieces > 1 && patchKind ? (
        <p className="hint warn">
          {pieces} separate outlines: parts of the art don't touch{o.outerOnly ? "" : " or have holes"}. For one patch border, raise Bridge gaps{o.outerOnly ? "" : " and turn on Outer edge only"}.
        </p>
      ) : (
        <p className="hint">Follows the union of everything selected — lettering, satins and fills — so one outline hugs the whole group. Pieces under 1 mm² are left out.</p>
      )}
    </Dialog>
  );
}

