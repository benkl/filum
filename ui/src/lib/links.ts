// How the needle goes on from one object to the next: Automatic, Trim, Jump
// or Sew. One choice in the interface over three fields of the object:
// trimAfter (Trim), link "jump" (Jump: locked, no trim), link "join" (Sew:
// sewn through in running stitches whatever the distance). The plan reports
// what it did at every connection (PlanData.links), so Automatic can say what
// it does. After the NOVAstitch Designer fork (effepol/NOVAstitch-designer).

import type { Connection, DesignObject, PlanData, StitchDocument, Vec2 } from "../types";

export type LinkChoice = "auto" | "trim" | "jump" | "sew";

export const LINK_CHOICES: { id: LinkChoice; label: string; hint: string }[] = [
  { id: "auto", label: "Automatic", hint: "Sewn through when the gap is short and hidden, trimmed otherwise (the minimum jump)" },
  { id: "trim", label: "Trim", hint: "Locked and trimmed, whatever the distance" },
  { id: "jump", label: "Jump", hint: "Locked, then a jump without a trim: the thread is snipped by hand or covered" },
  { id: "sew", label: "Sew", hint: "Sewn through in running stitches, whatever the distance: no locks, no trim. For a connection that a later object covers" },
];

/** The choice an object holds (trim after wins, as in the engine). */
export function linkChoiceOf(o: Pick<DesignObject, "trimAfter" | "link">): LinkChoice {
  if (o.trimAfter) return "trim";
  if (o.link === "join") return "sew";
  if (o.link === "jump") return "jump";
  return "auto";
}

/** The object with this choice (stop after is left as it is). */
export function withLinkChoice<T extends Pick<DesignObject, "trimAfter" | "link">>(o: T, c: LinkChoice): T {
  const out = { ...o, trimAfter: c === "trim" };
  if (c === "sew") out.link = "join";
  else if (c === "jump") out.link = "jump";
  else delete out.link;
  return out;
}

/** The connection the plan makes after the object (by id), if it has one. */
export function connectionAfter(plan: PlanData | null | undefined, doc: Pick<StitchDocument, "objects">, id: string): Connection | undefined {
  const i = doc.objects.findIndex((o) => o.id === id);
  if (i < 0 || !plan?.links) return undefined;
  return plan.links.find((c) => c.from === i);
}

const gap = (c: Connection) => Math.hypot(c.end[0] - c.start[0], c.end[1] - c.start[1]);

/** What the plan does there, in a few words ("trimmed: 12.3 mm gap"). */
export function describeConnection(c: Connection): string {
  const g = `${gap(c).toFixed(1)} mm`;
  switch (c.kind) {
    case "trim":
      return `trimmed (${g} gap)`;
    case "jump":
      return `jumps ${g} without a trim${c.visible ? ", snip it by hand" : ""}`;
    case "sew":
      return `sewn through (${g})${c.visible ? ", and it shows" : ""}`;
    case "colorChange":
      return "the colour changes: the machine cuts";
  }
}

/** The connection whose line passes within `tol` of `p` (mm), nearest first; colour changes and gaps under 0.5 mm left out. */
export function connectionAt(plan: PlanData | null | undefined, p: Vec2, tol: number): Connection | undefined {
  let best: Connection | undefined;
  let bd = tol;
  for (const c of plan?.links ?? []) {
    if (c.kind === "colorChange" || gap(c) < 0.5) continue;
    const d = segDist(p, c.start, c.end);
    if (d <= bd) {
      bd = d;
      best = c;
    }
  }
  return best;
}

function segDist(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  const t = l2 < 1e-12 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2));
  return Math.hypot(a[0] + dx * t - p[0], a[1] + dy * t - p[1]);
}
