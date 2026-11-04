// Lock stitch styles (Ink/Stitch lock_stitch.py) with small previews drawn
// from the same shapes the engine uses (crates/core/src/locks.rs).

import type { LockStyle } from "../types";

export const LOCKS: { id: LockStyle; label: string; d: string; hint: string }[] = [
  { id: "halfStitch", label: "Half stitch", d: "M 0,0 0,0.75 0,1.5 0,0.75 0,0", hint: "Half a stitch back and forth along the path (Ink/Stitch's default)" },
  { id: "backForth", label: "Back and forth", d: "M 0,0 0,0.7 0,1.4 0,0.7", hint: "Back and forth over a set length" },
  { id: "arrow", label: "Arrow", d: "M 0.5,0.3 0.3,1.31 -0.11,0.68 H 0.9 L 0.5,1.31 0.4,0.31 V 0.31", hint: "Arrow shape" },
  { id: "bowtie", label: "Bowtie", d: "M 0,0 -0.39,0.97 0.3,0.03 0.14,1.02 0,0", hint: "Bowtie shape" },
  { id: "cross", label: "Cross", d: "M 0,0 -0.7,-0.7 0.7,0.7 0,0 -0.7,0.7 0.7,-0.7 0,0", hint: "Cross over the lock point" },
  { id: "star", label: "Star", d: "M 0.67,-0.2 C 0.27,-0.06 -0.22,0.11 -0.67,0.27 L 0.57,0.33 -0.5,-0.27 0,0.67 V 0", hint: "Star shape" },
  { id: "simple", label: "Simple", d: "M -0.03,0 0.09,0.81 0,1.49 V 0", hint: "A small loop along the path" },
  { id: "triangle", label: "Triangle", d: "M -0.26,0.33 H 0.55 L 0,0.84 V 0", hint: "Triangle shape" },
  { id: "zigzag", label: "Zig-zag", d: "M -0.25,0.2 0.17,0.77 -0.22,1.45 0.21,2.05 -0.03,3", hint: "Zig-zag along the path" },
];

function Preview({ d }: { d: string }) {
  return (
    <svg viewBox="-1.1 -1 2.2 4.2" width="18" height="30" aria-hidden="true">
      <path d={d} fill="none" stroke="currentColor" strokeWidth="0.16" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx="0" cy="0" r="0.18" fill="currentColor" />
    </svg>
  );
}

export function LockPicker({ value, onChange }: { value: LockStyle; onChange: (v: LockStyle) => void }) {
  return (
    <div className="lock-picker" role="radiogroup">
      {LOCKS.map((l) => (
        <button key={l.id} className={`lock-chip ${value === l.id ? "on" : ""}`} title={`${l.label}: ${l.hint}`} aria-checked={value === l.id} role="radio" onClick={() => onChange(l.id)}>
          <Preview d={l.d} />
        </button>
      ))}
    </div>
  );
}
