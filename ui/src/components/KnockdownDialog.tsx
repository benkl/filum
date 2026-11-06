// Knockdown (laydown stitch; knockdown fill in Ink/Stitch): a light net sewn
// first that flattens the pile of towels, fleece and fur so the embroidery
// doesn't sink in. One tool, two scopes:
//
// - Whole design: automatic — the engine lays the net under everything and it
//   follows every edit (a design setting, saved with the design).
// - Under the selection: an ordinary fill object under the selected objects
//   (their outline grown, or a rectangle / circle around them), editable and
//   reorderable like any other object.
//
// Both use the same words: reach, keep holes, stitch length, colour.


import { useState } from "react";
import { defaultDesignOptions } from "../lib/geometry";
import { createKnockdown, DEFAULT_KNOCKDOWN, type JoinStyle, type KnockdownSelectionOptions } from "../lib/knockdown";
import { useStore } from "../store";
import type { DesignOptions } from "../types";
import { Dialog, Num, Row, Toggle } from "./ui";
import { safeSetItem } from "../lib/storage";

type Scope = "design" | "selection";
let pendingScope: Scope | null = null;

/** Open the knockdown dialog (on the selection when there is one). */
export function openKnockdown(scope?: Scope) {
  pendingScope = scope ?? null;
  useStore.getState().setDialog("knockdown");
}

const KEY = "filum.knockdown";
const loadSelection = (): KnockdownSelectionOptions => {
  try {
    return { ...DEFAULT_KNOCKDOWN, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") };
  } catch {
    return DEFAULT_KNOCKDOWN;
  }
};

const JOINS: [JoinStyle, string][] = [
  ["round", "Round"],
  ["mitre", "Mitre"],
  ["bevel", "Bevel"],
];

function Seg<T extends string | number>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div className="seg">
      {options.map(([k, l]) => (
        <button key={String(k)} className={value === k ? "on" : ""} onClick={() => onChange(k)}>
          {l}
        </button>
      ))}
    </div>
  );
}

function ColourRow({ value, onChange }: { value: string; onChange: (hex: string) => void }) {
  const fabricColor = useStore((s) => s.fabricColor);
  const color = value || fabricColor;
  return (
    <Row label="Colour" title="Usually the fabric's colour, so the knockdown disappears">
      <div className="kd-color">
        <input type="color" value={color} onChange={(e) => onChange(e.target.value)} />
        <button className="btn sm ghost" disabled={color.toLowerCase() === fabricColor.toLowerCase()} title="Use the fabric colour" onClick={() => onChange(fabricColor)}>
          Fabric
        </button>
      </div>
    </Row>
  );
}

/** The whole design's knockdown (a design setting: live, no Create). */
export function DesignKnockdownFields({ o, set }: { o: DesignOptions; set: (p: Partial<DesignOptions>) => void }) {
  const fabricColor = useStore((s) => s.fabricColor);
  const on = !!o.knockdown;
  return (
    <>
      <Row label="Knockdown" title="A light net sewn first under the whole design — it follows every edit">
        <Toggle on={on} onChange={(v) => set(v ? { knockdown: true, knockdownColor: o.knockdownColor || fabricColor } : { knockdown: false })} />
      </Row>
      {on && (
        <>
          <Row label="Reach" title="How far the net reaches beyond the design">
            <Num value={o.knockdownOffset ?? 2} unit="mm" step={0.5} min={0} max={15} onChange={(v) => set({ knockdownOffset: v })} />
          </Row>
          <Row label="Keep holes" title="Leave the pile standing inside the design's holes (letter counters, gaps)">
            <Toggle on={!!o.knockdownHoles} onChange={(v) => set({ knockdownHoles: v })} />
          </Row>
          <Row label="Net" title="One layer, or two crossing at 90° for deep pile">
            <Seg
              value={o.knockdownLayers ?? 2}
              onChange={(v) => set({ knockdownLayers: v })}
              options={[
                [1, "Single"],
                [2, "Crossed"],
              ]}
            />
          </Row>
          <Row label="Spacing" title="Row distance of the net: 1.5–2 mm for deep pile, 2–2.5 mm for medium">
            <Num value={o.knockdownSpacing ?? 2} unit="mm" step={0.25} min={0.5} max={6} onChange={(v) => set({ knockdownSpacing: v })} />
          </Row>
          <Row label="Stitch length" title="Long stitches lie over the loops (about 4 mm)">
            <Num value={o.knockdownLength ?? 4} unit="mm" step={0.5} min={1} max={8} onChange={(v) => set({ knockdownLength: v })} />
          </Row>
          <Row label="Angle">
            <Num value={o.knockdownAngle ?? 45} unit="°" step={15} onChange={(v) => set({ knockdownAngle: v })} />
          </Row>
          <ColourRow value={o.knockdownColor ?? ""} onChange={(v) => set({ knockdownColor: v })} />
        </>
      )}
    </>
  );
}

/** A knockdown object under the selection (Ink/Stitch knockdown fill). */
function SelectionKnockdownFields({ o, set }: { o: KnockdownSelectionOptions; set: (p: Partial<KnockdownSelectionOptions>) => void }) {
  return (
    <>
      <Row label="Reach" title="How far the knockdown reaches beyond the selection (negative: inside)">
        <Num value={o.offset} unit="mm" step={0.5} min={-50} max={50} onChange={(v) => set({ offset: v })} />
      </Row>
      <Row label="Keep holes" title="Leave the pile standing inside the design's holes (letter counters, gaps)">
        <Toggle on={o.keepHoles} onChange={(v) => set({ keepHoles: v })} />
      </Row>
      <Row label="Corners" title="Corner style of the grown outline">
        <Seg value={o.join} onChange={(v) => set({ join: v })} options={JOINS} />
      </Row>
      {(o.join === "mitre" || (o.frame === "rect" && o.frameJoin === "mitre")) && (
        <Row label="Mitre limit" title="Sharp mitred corners reaching further than this many times the reach are cut off">
          <Num value={o.mitreLimit} step={0.5} min={0.1} max={50} onChange={(v) => set({ mitreLimit: v })} />
        </Row>
      )}
      <Row label="Shape" title="Follow the design, or a rectangle / circle around it with the design cut out (an embossed look)">
        <Seg
          value={o.frame}
          onChange={(v) => set({ frame: v })}
          options={[
            ["none", "Design"],
            ["rect", "Rectangle"],
            ["circle", "Circle"],
          ]}
        />
      </Row>
      {o.frame !== "none" && (
        <>
          <Row label="Shape margin" title="Margin between the design's outline and the rectangle / circle">
            <Num value={o.frameOffset} unit="mm" step={0.5} min={0} max={50} onChange={(v) => set({ frameOffset: v })} />
          </Row>
          {o.frame === "rect" && (
            <Row label="Shape corners">
              <Seg value={o.frameJoin} onChange={(v) => set({ frameJoin: v })} options={JOINS} />
            </Row>
          )}
          <Row label="Cut out design" title="Off: the whole rectangle / circle is flattened, the design included">
            <Toggle on={!o.frameOnly} onChange={(v) => set({ frameOnly: !v })} />
          </Row>
        </>
      )}
      <Row label="Stitch length" title="Long stitches lie over the loops; the rows are √3⁄2 of it apart, with a ±60° underlay (Ink/Stitch)">
        <Num value={o.stitchLength} unit="mm" step={0.5} min={0.5} max={10} onChange={(v) => set({ stitchLength: v })} />
      </Row>
      <ColourRow value={o.color} onChange={(v) => set({ color: v })} />
    </>
  );
}

export function KnockdownDialog({ onClose }: { onClose: () => void }) {
  const hasSel = useStore((s) => s.selection.length > 0);
  const options = useStore((s) => s.doc.options) ?? defaultDesignOptions();
  const [scope, setScope] = useState<Scope>(() => {
    const p = pendingScope;
    pendingScope = null;
    return p ?? (useStore.getState().selection.length ? "selection" : "design");
  });
  const [kd, setKd] = useState(loadSelection);
  const [busy, setBusy] = useState(false);
  const setSelection = (p: Partial<KnockdownSelectionOptions>) =>
    setKd((v) => {
      const next = { ...v, ...p };
      safeSetItem(KEY, JSON.stringify(next));
      return next;
    });
  const setDesign = (p: Partial<DesignOptions>) => useStore.getState().commit((d) => ({ ...d, options: { ...(d.options ?? defaultDesignOptions()), ...p } }));
  const create = async () => {
    setBusy(true);
    try {
      const n = await createKnockdown(kd);
      if (n) useStore.getState().toast(`Knockdown with ${n} outline${n > 1 ? "s" : ""} created — sewn before the selection`, "success");
      onClose();
    } catch (e) {
      useStore.getState().toast(String((e as Error).message ?? e), "error");
      setBusy(false);
    }
  };
  return (
    <Dialog
      live
      title="Knockdown"
      onClose={onClose}
      footer={
        scope === "design" ? (
          <>
            <div className="spacer" />
            <button className="btn primary" onClick={onClose}>
              Done
            </button>
          </>
        ) : (
          <>
            <div className="spacer" />
            <button className="btn" onClick={onClose}>
              Cancel
            </button>
            <button className="btn primary" disabled={!hasSel || busy} onClick={create}>
              {busy ? "Working…" : "Create knockdown"}
            </button>
          </>
        )
      }
    >
      <div className="seg seg-full" style={{ marginBottom: 10 }}>
        <button className={scope === "design" ? "on" : ""} onClick={() => setScope("design")} title="Automatic: under everything, following every edit">
          Whole design
        </button>
        <button className={scope === "selection" ? "on" : ""} onClick={() => setScope("selection")} title="An editable object under the selected objects">
          Under the selection
        </button>
      </div>
      {scope === "design" ? (
        <>
          <DesignKnockdownFields o={options} set={setDesign} />
          <p className="hint">Saved with the design and redone with every edit. For towels, fleece and fur.</p>
        </>
      ) : (
        <>
          {!hasSel && <p className="hint warn">Select the objects to knock down first.</p>}
          <SelectionKnockdownFields o={kd} set={setSelection} />
          <p className="hint">An editable fill under the selection, sewn before it — reorder, reshape or recolour it like any object.</p>
        </>
      )}
    </Dialog>
  );
}
