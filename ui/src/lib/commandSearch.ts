// Finding commands by a few typed letters (the command palette).

/**
 * How well `query` matches `text` (higher is better, 0 = no match): every
 * word of the query must start a word of the text or appear in it; word
 * starts and the label score higher than the menu path.
 */
export function commandScore(query: string, label: string, path: string): number {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return 1;
  const l = label.toLowerCase();
  const p = path.toLowerCase();
  let total = 0;
  for (const w of words) {
    const starts = (t: string) => t.startsWith(w) || t.includes(" " + w) || t.includes("(" + w) || t.includes("-" + w);
    if (starts(l)) total += 3;
    else if (l.includes(w)) total += 2;
    else if (starts(p)) total += 1.5;
    else if (p.includes(w)) total += 1;
    else return 0;
  }
  return total + (l.startsWith(words[0]) ? 1 : 0);
}

