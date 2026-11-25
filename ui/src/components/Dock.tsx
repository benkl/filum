// The right-hand dock's panels: the design (hoop, fabric, machine, design
// options) and the selection's properties. The Layers panel, the Issues panel
// and the stitch options have files of their own.

import { Eye, EyeOff, Lock, Unlock } from "lucide-react";
import { HiddenStitchingSection, ObjectHiddenSection } from "./HiddenStitching";
import { StitchOptions } from "./StitchOptions";
import { CommandsSection } from "./CommandsSection";
import { MachineSettings } from "./MachineSettings";
import { FabricLookRows } from "./FabricLook";
import { openKnockdown } from "./KnockdownDialog";
import { TextProperties, useSelectedTextGroup } from "./Lettering";
import { TransformPanel } from "./TransformPanel";
import { ThreadCard, ThreadPicker } from "./ThreadPicker";
import { setObjectsThread } from "../lib/textSettle";
import { defaultDesignOptions, nodeCount } from "../lib/geometry";
import { useStore } from "../store";
import type { DesignObject, DesignOptions } from "../types";
import { HoopOptions } from "./Bars";
import { HoopShapeRow, MaterialSection } from "./MaterialPanel";
import { HOOPS, hoopIndex, hoopOf } from "../lib/hoops";
import { fitHoopToDesign } from "../lib/actions";
import { Num, PatternInput, Row, Section, Toggle } from "./ui";
import { formatPattern, parsePattern } from "../lib/patterns";
import { guidePair, useAsRippleGuide } from "../lib/rippleGuide";
import { clonesOf, unlinkClone } from "../lib/clones";
import { applyPatterns, patternPair } from "../lib/stitchPatterns";
import { ElementInfoSection } from "./ElementInfo";
import { differingSettings, EditTargets, settingLabel } from "./editTargets";
import { mapObjects } from "../lib/docEdit";

export function ScenePanel() {
  const doc = useStore((s) => s.doc);
  const commit = useStore((s) => s.commit);
  const fabricAll = useStore((s) => s.fabricAll);
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
        <Row label="Custom size" title="Any frame: type its width and height above, or fit a hoop round the whole design">
          <button className="btn sm ghost" title="A custom hoop round the whole design with a 10 mm margin, the design centred in it" onClick={fitHoopToDesign} disabled={!doc.objects.length}>
            Fit to design
          </button>
        </Row>
        <Row label="Fabric inside" title="Fill the hoop with the fabric colour in the vector and stitch views (off: the hoop is an outline only)">
          <Toggle on={fabricAll} onChange={(v) => useStore.getState().set({ fabricAll: v })} />
        </Row>
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
      <Row label="Avoid holes" title="Travel stitches keep off the needle holes their object made before: fewer drops in one spot, fewer torn fabrics and broken needles. Off: stitch for stitch as Ink/Stitch">
        <Toggle on={o.avoidHoles ?? true} onChange={(v) => set({ avoidHoles: v })} />
      </Row>
      <Row label="Hide travel" title="A gap to the next object up to 12 mm that later stitching covers all along is sewn through instead of trimmed: fewer trims, shorter sewing. Off: trimmed as Ink/Stitch does">
        <Toggle on={o.hiddenTravel ?? true} onChange={(v) => set({ hiddenTravel: v })} />
      </Row>
    </Section>
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
      <MultiStitchOptions objects={objects} />
      <Section title="Thread">
        <ThreadPicker
          value={objects[0]?.thread}
          mixed={!objects.every((o) => o.thread === objects[0]?.thread)}
          // letters: their lettering keeps the colour (all its letters of that colour take it)
          onPick={(id) => useStore.getState().commit((d) => ({ ...d, objects: setObjectsThread(d.objects, ids, id) }))}
        />
        {!objects.every((o) => o.thread === objects[0]?.thread) && <p className="hint">{new Set(objects.map((o) => o.thread)).size} colours — pick one to give it to all.</p>}
        {threads.length === 0 && <p className="hint">No threads yet.</p>}
      </Section>
      <CommandsSection objects={objects} />
      <ElementInfoSection ids={ids} />
    </div>
  );
}

const TYPE_LABEL: Record<string, string> = { fill: "Fill", satin: "Satin", running: "Line", applique: "Appliqué", manual: "Manual stitch", none: "No stitches", zigzag: "Zig-zag" };

/**
 * Several objects selected: their stitch settings, one panel per stitch type,
 * each change going to every selected object of that type. Linked clones
 * follow their original and gradient or tartan layers are edited as a set,
 * so they're left out here.
 */
function MultiStitchOptions({ objects }: { objects: DesignObject[] }) {
  const editable = objects.filter((o) => !o.clone && !o.locked && !(o.stitch.type === "fill" && (o.stitch.gradient || o.stitch.tartan)));
  const skipped = objects.length - editable.length;
  const groups = new Map<string, DesignObject[]>();
  for (const o of editable) groups.set(o.stitch.type, [...(groups.get(o.stitch.type) ?? []), o]);
  if (!groups.size)
    return skipped ? (
      <Section title="Stitch options">
        <p className="hint">Linked clones, locked objects, gradients and tartans are edited one at a time.</p>
      </Section>
    ) : null;
  return (
    <>
      {[...groups].map(([type, objs]) => {
        const differ = differingSettings(objs);
        return (
          <Section key={type} title={`Stitch options · ${TYPE_LABEL[type] ?? type}${groups.size > 1 || objs.length !== objects.length ? ` (${objs.length})` : ""}`}>
            <p className="hint" style={{ margin: "2px 0 6px" }}>
              {objs.length > 1 ? `Changes apply to all ${objs.length}.` : "Changes apply to this one."}
              {differ.length > 0 && ` They differ in ${differ.slice(0, 5).map(settingLabel).join(", ")}${differ.length > 5 ? ` and ${differ.length - 5} more` : ""}: shown is the first one's.`}
            </p>
            <EditTargets.Provider value={objs.map((o) => o.id)}>
              <StitchOptions o={objs[0]} />
            </EditTargets.Provider>
          </Section>
        );
      })}
      {skipped > 0 && <p className="hint">{skipped} not included: linked clones, locked objects, gradients and tartans are edited one at a time.</p>}
    </>
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
          onClick={() => useStore.getState().commit((d) => mapObjects(d, o.id, (x) => unlinkClone(x)))}
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
