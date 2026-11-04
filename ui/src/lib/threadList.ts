// Thread lists (Ink/Stitch "Apply thread list"): read a TXT, COL, EDR or INF
// file and give the design's colour blocks its colours, in order. Lists that
// name no colours (other software's TXT) are matched by catalogue number in a
// thread chart (Ink/Stitch method 2, "other thread list").

import type { ThreadListEntry } from "../types";

export const THREAD_LIST_EXT = ["txt", "col", "edr", "inf"];

/** A file the user picked / dropped, waiting for the dialog. */
export const pendingThreadList: { name: string; bytes: Uint8Array } = { name: "", bytes: new Uint8Array() };

/**
 * Entries without a colour get the colour of the first chart thread whose
 * catalogue number is one of the line's words (Ink/Stitch: `#` removed, the
 * words after the line number). Entries that already have a colour are kept.
 */
export function matchCatalog(entries: ThreadListEntry[], chart: { code: string; color: string; name: string; brand: string }[]): ThreadListEntry[] {
  const byCode = new Map<string, (typeof chart)[number]>();
  for (const c of chart) {
    const k = c.code.trim().toLowerCase();
    if (k && !byCode.has(k)) byCode.set(k, c);
  }
  return entries.map((e) => {
    if (e.color) return e;
    const hit = (e.tokens ?? []).map((t) => byCode.get(t.trim().toLowerCase())).find(Boolean);
    return hit ? { ...e, color: hit.color.toLowerCase(), name: hit.name, code: hit.code, brand: hit.brand } : e;
  });
}

/** Do the entries need a chart (some lines name no colour)? */
export const needsChart = (entries: ThreadListEntry[]) => entries.some((e) => !e.color && (e.tokens?.length ?? 0) > 0);
