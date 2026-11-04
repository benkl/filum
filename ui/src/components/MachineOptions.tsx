// Machine pickers: <option>s grouped by brand, and the frame buttons of a
// machine (everyday frames first, special ones — cap, cylinder … — apart).

import { MACHINE_BRANDS, MACHINES, SETTINGS_PRESETS, type Frame } from "../lib/machines";

function FrameButton({ f, on, onPick }: { f: Frame; on: boolean; onPick: (f: Frame) => void }) {
  return (
    <button className={on ? "on" : ""} title={`${f.width} × ${f.height} mm${f.shape === "oval" ? " (round / oval)" : ""}${f.note ? ` — ${f.note}` : ""}`} onClick={() => onPick(f)}>
      <i className={f.shape === "oval" ? "oval" : ""} style={{ aspectRatio: `${f.width} / ${f.height}` }} />
      {f.name}
    </button>
  );
}

/** A machine's frames as buttons; special-purpose frames in their own group. */
export function FrameButtons({ frames, isOn, onPick, className = "" }: { frames: Frame[]; isOn: (f: Frame) => boolean; onPick: (f: Frame) => void; className?: string }) {
  const everyday = frames.filter((f) => !f.note);
  const special = frames.filter((f) => f.note);
  return (
    <>
      <div className={`xp-frames ${className}`}>
        {everyday.map((f) => (
          <FrameButton key={f.id} f={f} on={isOn(f)} onPick={onPick} />
        ))}
      </div>
      {special.length > 0 && (
        <details className="xp-special" open={special.some(isOn)}>
          <summary>
            Special frames <span className="stat">{special.length}</span>
          </summary>
          <div className={`xp-frames ${className}`}>
            {special.map((f) => (
              <FrameButton key={f.id} f={f} on={isOn(f)} onPick={onPick} />
            ))}
          </div>
        </details>
      )}
    </>
  );
}

/** Machine profiles (export: the machine the file is for). */
export function MachineOptions() {
  return (
    <>
      {MACHINE_BRANDS.map((b) => {
        const list = MACHINES.filter((m) => m.brand === b).map((m) => (
          <option key={m.id} value={m.id} title={m.models}>
            {m.name}
          </option>
        ));
        return b ? (
          <optgroup key={b} label={b}>
            {list}
          </optgroup>
        ) : (
          list
        );
      })}
    </>
  );
}

/** Settings presets: the general ones, then every machine. */
export function SettingsPresetOptions() {
  const groups = [...new Set(SETTINGS_PRESETS.map((p) => p.group))];
  return (
    <>
      {groups.map((g) => (
        <optgroup key={g} label={g}>
          {SETTINGS_PRESETS.filter((p) => p.group === g).map((p) => (
            <option key={p.id} value={p.id} title={p.hint}>
              {p.name}
            </option>
          ))}
        </optgroup>
      ))}
    </>
  );
}
