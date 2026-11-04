// Values with several numbers, the Ink/Stitch way ("2 1"): stitch length
// patterns, bean repeat patterns. Shared by the running stitch, manual stitch
// and any other setting that takes a repeating pattern.

/** Numbers of a pattern text ("2 1", "2, 1", "2;1"); invalid parts are left out. */
export function parsePattern(text: string, opts: { min?: number; max?: number; integer?: boolean } = {}): number[] {
  const { min = -Infinity, max = Infinity, integer = false } = opts;
  return text
    .split(/[\s,;]+/)
    .filter(Boolean)
    .map((s) => Number(s.replace(",", ".")))
    .filter((v) => Number.isFinite(v))
    .map((v) => Math.min(max, Math.max(min, integer ? Math.round(v) : v)));
}

/** A pattern as text ("2 1"). */
export function formatPattern(values: number[] | undefined): string {
  return (values ?? []).map((v) => String(Math.round(v * 100) / 100)).join(" ");
}

/**
 * Bean repeats as the user writes them (Ink/Stitch: 1 = triple, 2 = five
 * threads) and as the engine stores them (passes: 2 = triple).
 */
export const beansToPasses = (v: number[]) => v.map((x) => Math.max(0, Math.round(x)) * 2);
export const passesToBeans = (v: number[] | undefined) => (v ?? []).map((x) => Math.ceil(x / 2));

/** Stitch lengths of a pattern for a preview line: the lengths in turn until `total` mm. */
export function patternLengths(pattern: number[], total: number): number[] {
  const p = pattern.filter((x) => x > 0);
  if (!p.length) return [];
  const out: number[] = [];
  let sum = 0;
  for (let i = 0; sum < total && i < 10000; i++) {
    const l = p[i % p.length];
    out.push(l);
    sum += l;
  }
  return out;
}
