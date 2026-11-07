// The machine of this design and how it sews: preset, stitch-out (ties,
// lock shapes, trims, stitch lengths) and the time estimate's values. Saved
// with the design, so it lives in the Design tab of the dock (each part is
// a collapsible section there).

import { RotateCcw } from "lucide-react";
import type { ReactNode } from "react";
import { cutterOf } from "../lib/cuts";
import { currentPreset, MACHINES, presetById } from "../lib/machines";
import { useStore } from "../store";
import { LockPicker } from "./LockPicker";
import { FrameButtons, SettingsPresetOptions } from "./MachineOptions";
import { Num, Row, Section as DockSection, Toggle } from "./ui";

function Section({ title, hint, children }: { title: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <DockSection title={title} defaultOpen={false}>
      {children}
      {hint && <p className="hint">{hint}</p>}
    </DockSection>
  );
}

export function MachineSettings() {
  const m = useStore((s) => s.doc.machine);
  const hoop = useStore((s) => s.doc.hoop);
  const commit = useStore((s) => s.commit);
  const up = (p: Partial<typeof m>) => commit((d) => ({ ...d, machine: { ...d.machine, ...p } }));
  const { preset, modified } = currentPreset(m);
  const profile = preset && MACHINES.find((x) => x.id === preset.id);
  const apply = (id: string) => {
    const p = presetById(id);
    // the preset's values over the design's own: lock stitches (not part of a
    // preset) stay; a preset without a cutter clears the old one
    if (p) commit((d) => ({ ...d, machine: { ...d.machine, cutter: undefined, cutOver: undefined, ...p.values, profile: p.id } }));
  };
  const fmtField = (w: number, h: number) => `${w / 10} × ${h / 10} cm`;
  const cut = cutterOf(m);
  return (
    <>
      <Section title="Machine" hint={preset?.hint ?? "Your own settings — pick a preset to start from a machine."}>
        <Row label="Preset" title="Sets the stitch-out and time settings below; saved with the design">
          <span className="dz-inline">
            <select className="select" value={preset?.id ?? "custom"} onChange={(e) => apply(e.target.value)}>
              {!preset && <option value="custom">Custom</option>}
              <SettingsPresetOptions />
            </select>
            {preset && modified && (
              <>
                <span className="badge warn" title="Changed since the preset was applied">
                  edited
                </span>
                <button className="btn sm" onClick={() => apply(preset.id)} title={`Back to the ${preset.name} settings`}>
                  <RotateCcw size={12} /> Reset
                </button>
              </>
            )}
          </span>
        </Row>
        {profile && (
          <div className="mc-card">
            <dl className="mc-facts">
              <div>
                <dt>Needles</dt>
                <dd>{profile.needles ?? 1}</dd>
              </div>
              <div title={profile.speed?.source}>
                <dt>Top speed</dt>
                <dd>{profile.speed ? `${profile.speed.spm} spm` : "—"}</dd>
              </div>
              <div>
                <dt>Field</dt>
                <dd>{fmtField(profile.field.width, profile.field.height)}</dd>
              </div>
              <div>
                <dt>Reads</dt>
                <dd>{profile.formats.map((f) => "." + f.toUpperCase()).join(" ")}</dd>
              </div>
              {profile.maxStitches && (
                <div title={profile.maxStitches.source}>
                  <dt>Stitches</dt>
                  <dd>≤ {profile.maxStitches.value.toLocaleString()}</dd>
                </div>
              )}
              {profile.maxColorChanges && (
                <div title={profile.maxColorChanges.source}>
                  <dt>Colour changes</dt>
                  <dd>≤ {profile.maxColorChanges.value}</dd>
                </div>
              )}
            </dl>
            {profile.frames.length > 0 && (
              <div className="mc-frames-wrap">
                <span className="mc-label">Use a frame as the design hoop</span>
                <FrameButtons
                  className="mc-frames"
                  frames={profile.frames}
                  isOn={(f) => hoop.width === f.width && hoop.height === f.height && (hoop.shape ?? "rect") === (f.shape ?? "rect")}
                  onPick={(f) => commit((d) => ({ ...d, hoop: { name: `${profile.brand} ${f.name}`, width: f.width, height: f.height, ...(f.shape ? { shape: f.shape } : {}) } }))}
                />
              </div>
            )}
            {profile.notes && <p className="hint">{profile.notes}</p>}
          </div>
        )}
      </Section>
      <Section title="Stitch-out">
        <Row label="Tie-in / tie-off" title="Lock stitches at the start and end of every piece">
          <Toggle on={m.ties} onChange={(v) => up({ ties: v })} />
        </Row>
        {m.ties && (
          <>
            <Row label="Start lock" title="Lock stitch shape where a piece starts (Ink/Stitch lock styles)">
              <LockPicker value={m.lockStart ?? "halfStitch"} onChange={(v) => up({ lockStart: v })} />
            </Row>
            <Row label="End lock" title="Lock stitch shape where a piece ends">
              <LockPicker value={m.lockEnd ?? "halfStitch"} onChange={(v) => up({ lockEnd: v })} />
            </Row>
            {[m.lockStart, m.lockEnd].some((l) => l && l !== "halfStitch" && l !== "backForth") && (
              <Row label="Lock size" title="Size of the shaped locks">
                <Num value={m.lockScale ?? 100} unit="%" step={10} min={30} max={300} digits={0} onChange={(v) => up({ lockScale: v })} />
              </Row>
            )}
            {[m.lockStart, m.lockEnd].includes("backForth") && (
              <Row label="Lock length" title="Length of the back-and-forth lock">
                <Num value={m.lockLength ?? 0.7} unit="mm" step={0.1} min={0.2} max={3} onChange={(v) => up({ lockLength: v })} />
              </Row>
            )}
          </>
        )}
        <Row label="Trim jumps over" title="Longer travel becomes tie-off + trim + jump">
          <Num value={m.trimDistance} unit="mm" step={0.5} min={0.5} onChange={(v) => up({ trimDistance: v })} />
        </Row>
        <Row label="Thread cutter" title="What the machine cuts: jumps it leaves are shown as thread and counted as hand trims">
          <select
            className="select"
            value={cut.kind}
            onChange={(e) => {
              const kind = e.target.value as typeof cut.kind;
              up(kind === "trims" ? { cutter: undefined, cutOver: undefined } : { cutter: kind, cutOver: kind === "jumps" ? cut.over : undefined });
            }}
          >
            <option value="trims">Cuts every trim</option>
            <option value="jumps">Cuts longer jumps only</option>
            <option value="none">None: snip by hand</option>
          </select>
        </Row>
        {cut.kind === "jumps" && (
          <Row label="Cuts jumps over" title="The machine's jump stitch trimming length (Brother and Baby Lock: 5 mm by default, 5–50 mm)">
            <Num value={cut.over} unit="mm" step={1} min={0} max={50} digits={0} onChange={(v) => up({ cutOver: v })} />
          </Row>
        )}
        <Row label="Min. stitch" title="Shorter stitches are dropped">
          <Num value={m.minStitch} unit="mm" step={0.05} min={0} onChange={(v) => up({ minStitch: v })} />
        </Row>
        <Row label="Max. stitch" title="Longer stitches are split">
          <Num value={m.maxStitch} unit="mm" step={0.5} min={2} max={12.7} onChange={(v) => up({ maxStitch: v })} />
        </Row>
      </Section>
      <Section title="Time estimates" hint="The rated top speed: dense designs with short stitches run slower. A one-needle machine waits for you to rethread at every colour change.">
        <Row label="Speed">
          <Num value={m.spm} unit="spm" step={50} min={100} digits={0} onChange={(v) => up({ spm: v })} />
        </Row>
        <Row label="Trim time">
          <Num value={m.trimSeconds} unit="s" step={1} min={0} onChange={(v) => up({ trimSeconds: v })} />
        </Row>
        <Row label="Colour change">
          <Num value={m.colorChangeSeconds} unit="s" step={1} min={0} onChange={(v) => up({ colorChangeSeconds: v })} />
        </Row>
      </Section>
    </>
  );
}

