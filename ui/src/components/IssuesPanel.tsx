// The Issues panel: what could go wrong on the machine, located on the
// canvas, with one-click fixes (lib/issues.ts finds them).

import { Info, OctagonAlert, Shapes, TriangleAlert, type LucideIcon, Type } from "lucide-react";
import { DensityMap, Hoop, StitchFill, StitchRunning, StitchSatin } from "../icons/stitch";
import { cleanupCandidates, cleanupDocument, DEFAULT_CLEANUP } from "../lib/shapeCheck";
import { computeIssues, type Issue } from "../lib/issues";
import { pruneGroups } from "../lib/layerRows";
import { useStore } from "../store";
import { focus } from "../lib/focus";

/** How bad an issue is: a shape of its own per level (never colour alone). */
const SEVERITY: Record<Issue["level"], LucideIcon> = { error: OctagonAlert, warning: TriangleAlert, info: Info };

/** What an issue is about, by its title. */
function IssueTopic({ title }: { title: string }) {
  const Icon: LucideIcon | null = /hoop/i.test(title)
    ? Hoop
    : /satin/i.test(title)
      ? StitchSatin
      : /dense/i.test(title)
        ? DensityMap
        : /fill/i.test(title)
          ? StitchFill
          : /running|long stitch/i.test(title)
            ? StitchRunning
            : /lettering/i.test(title)
              ? Type
              : /shape|self-inters|open|tiny/i.test(title)
                ? Shapes
                : null;
  return Icon ? <Icon size={12} className="issue-topic" aria-hidden /> : null;
}

function SeverityIcon({ level }: { level: Issue["level"] }) {
  const Icon = SEVERITY[level];
  return <Icon size={14} className={`lvl-${level}`} aria-label={level} />;
}

export function IssuesPanel() {
  const doc = useStore((s) => s.doc);
  const plan = useStore((s) => s.plan);
  const issues = computeIssues(doc, plan);
  const tiny = cleanupCandidates(doc);
  const cleanup = tiny.length ? (
    <div className="issue-cleanup">
      <span>
        <b>{tiny.length}</b> tiny or empty object{tiny.length > 1 ? "s" : ""} (fills under {DEFAULT_CLEANUP.minFillArea} mm², lines under{" "}
        {DEFAULT_CLEANUP.minLength} mm)
      </span>
      <button
        className="btn sm"
        title="Remove them in one step (undo brings them back) — Ink/Stitch Cleanup document"
        onClick={() => {
          const s = useStore.getState();
          const n = cleanupDocument(s.commit, s.doc);
          s.toast(`Removed ${n} object${n > 1 ? "s" : ""}`);
        }}
      >
        Clean up
      </button>
    </div>
  ) : null;
  if (!issues.length)
    return (
      cleanup ?? (
        <div className="hint" style={{ padding: 14 }}>
          No problems found. Markers appear on the canvas while this tab is open.
        </div>
      )
    );
  const locate = (i: Issue) => focus({ ids: i.objId ? [i.objId] : undefined, at: i.at });
  return (
    <div>
      {cleanup}
      {issues.map((i) => {
        const o = doc.objects.find((x) => x.id === i.objId);
        return (
          <div key={i.id} className="issue" onClick={() => locate(i)}>
            <SeverityIcon level={i.level} />
            <div>
              <b>
                <IssueTopic title={i.title} />
                {i.title}
              </b>
              <span className="stat">
                {o ? `${o.name} · ` : ""}
                {i.detail}
              </span>
            </div>
            {i.fix && (o || i.fix.doc) && (
              <button
                className="btn sm"
                onClick={(e) => {
                  e.stopPropagation();
                  const { apply, scope, doc: whole } = i.fix!;
                  // a fix may remove the object (null)
                  useStore.getState().commit((d) =>
                    whole
                      ? whole(d)
                      : pruneGroups({
                          ...d,
                          objects: d.objects.flatMap((x) => {
                            if (!apply || !(scope ? scope(x) : x.id === o?.id)) return [x];
                            const y = apply(x);
                            return y ? [y] : [];
                          }),
                        }),
                  );
                }}
              >
                {i.fix.label}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Issues worth a badge on the tab (warnings and errors). */
export function useIssueCount() {
  return useStore((s) => computeIssues(s.doc, s.plan).filter((i) => i.level !== "info").length);
}
