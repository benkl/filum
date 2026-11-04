// Sewing commands of objects (Ink/Stitch commands and per-object params):
// start and end point, trim and stop after, lock stitches, minimum stitch and
// jump. For several objects — a lettering's glyphs, a selection — the
// settings apply to all of them, and "after" means after the last one sewn.

import { useStore } from "../store";
import type { DesignObject } from "../types";
import { Num, Row, Section, Toggle } from "./ui";

/** A value of the object's own, or the machine's (shown dimmed) until set. */
export function OwnValue({ label, title, value, fallback, onChange }: { label: string; title: string; value: number | undefined; fallback: number; onChange: (v: number | undefined) => void }) {
  return (
    <Row label={label} title={title}>
      <span className="dz-inline">
        <span style={{ opacity: value == null ? 0.55 : 1 }}>
          <Num value={value ?? fallback} step={0.1} min={0} max={20} unit="mm" onChange={(v) => onChange(v)} />
        </span>
        {value != null && (
          <button className="btn sm ghost" title="Use the machine setting again" onClick={() => onChange(undefined)}>
            Default
          </button>
        )}
      </span>
    </Row>
  );
}

const LOCKS = [
  ["both", "Both"],
  ["start", "Start"],
  ["end", "End"],
  ["none", "None"],
] as const;

export function CommandsSection({ objects }: { objects: DesignObject[] }) {
  const machine = useStore((s) => s.doc.machine);
  const order = useStore((s) => s.doc.objects);
  if (!objects.length) return null;
  const one = objects.length === 1 ? objects[0] : null;
  // "after": the last of them in the stitch order
  const last = [...objects].sort((a, b) => order.indexOf(a) - order.indexOf(b)).at(-1)!;
  const ids = new Set(objects.map((o) => o.id));
  const all = (p: Partial<DesignObject>) => useStore.getState().commit((d) => ({ ...d, objects: d.objects.map((o) => (ids.has(o.id) ? { ...o, ...p } : o)) }));
  const ties = objects.every((o) => (o.ties ?? "both") === (objects[0].ties ?? "both")) ? (objects[0].ties ?? "both") : null;
  const same = <T,>(f: (o: DesignObject) => T) => (objects.every((o) => f(o) === f(objects[0])) ? f(objects[0]) : undefined);
  return (
    <Section title="Commands" defaultOpen={!!(one?.start || one?.end)}>
      {one &&
        (["start", "end"] as const).map((k) => (
          <Row key={k} label={k === "start" ? "Start point" : "End point"} title="Drag the S / E pins on the canvas; double-click a pin to go back to automatic">
            <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span className="stat">{one[k] ? `${one[k]![0].toFixed(1)}, ${one[k]![1].toFixed(1)} mm` : k === "start" ? "Nearest the last object" : "Automatic"}</span>
              {one[k] && (
                <button className="btn sm ghost" onClick={() => useStore.getState().updateObject(one.id, { [k]: undefined })}>
                  Reset
                </button>
              )}
            </span>
          </Row>
        ))}
      <Row label="Trim after" title={one ? undefined : "After the last of them"}>
        <Toggle on={last.trimAfter} onChange={(v) => useStore.getState().updateObject(last.id, { trimAfter: v })} />
      </Row>
      <Row label="Stop after" title={`Machine pause (appliqué, puff foam, …)${one ? "" : " — after the last of them"}`}>
        <Toggle on={last.stopAfter} onChange={(v) => useStore.getState().updateObject(last.id, { stopAfter: v })} />
      </Row>
      <Row label="Locks" title="Lock stitches where it starts and ends (the shapes are set in Design ▸ Stitch-out)">
        <div className="seg">
          {LOCKS.map(([v, l]) => (
            <button key={v} className={ties === v ? "on" : ""} onClick={() => all({ ties: v === "both" ? undefined : v })}>
              {l}
            </button>
          ))}
        </div>
      </Row>
      <Row label="Force lock" title="Lock the end and the next start even when the next object follows without a trim">
        <Toggle on={objects.every((o) => !!o.forceLock)} onChange={(v) => all({ forceLock: v || undefined })} />
      </Row>
      <OwnValue
        label="Min. stitch"
        title="Drop stitches shorter than this (Ink/Stitch minimum stitch length). Default: Design ▸ Stitch-out"
        value={same((o) => o.minStitch)}
        fallback={machine.minStitch}
        onChange={(v) => all({ minStitch: v })}
      />
      <OwnValue
        label="Min. jump"
        title="Gaps after it up to this long are sewn through — no locks, no trim (Ink/Stitch minimum jump stitch length). Default: the trim distance"
        value={same((o) => o.minJump)}
        fallback={machine.trimDistance}
        onChange={(v) => all({ minJump: v })}
      />
    </Section>
  );
}
