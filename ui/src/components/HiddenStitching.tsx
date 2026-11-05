// Hidden stitching: the design-wide panel (whether stitching under objects on
// top is left out, what counts as hiding it, what gets removed, and which
// objects are cut) and each object's own setting in the selection.

import { Check, Eye, EyeOff, RotateCcw, Scissors, Sparkles } from "lucide-react";
import { StitchFill, StitchRunning, StitchSatin, Underlay } from "../icons/stitch";
import { defaultDesignOptions } from "../lib/geometry";
import { RULE_DEFAULTS, coverVerdict, hiddenOptions, suggestedOverlap, useHiddenReport, type HiddenReport } from "../lib/hiddenStitching";
import { fabricInfo } from "../lib/materials";
import { useStore } from "../store";
import type { CoverMode, DesignObject, DesignOptions } from "../types";
import { Num, Row, Section, Toggle } from "./ui";

const setOptions = (p: Partial<DesignOptions>) => useStore.getState().commit((d) => ({ ...d, options: { ...(d.options ?? defaultDesignOptions()), ...p } }));
const pctOf = (part: number, whole: number) => (whole > 0 ? Math.round((100 * part) / whole) : 0);

const TYPE_ICON = { fill: StitchFill, satin: StitchSatin, running: StitchRunning } as Record<string, typeof StitchFill | undefined>;

/** Design ▸ Hidden stitching. */
export function HiddenStitchingSection() {
  const doc = useStore((s) => s.doc);
  const show = useStore((s) => s.showHidden);
  const o = hiddenOptions(doc.options);
  const report = useHiddenReport();
  const fabric = fabricInfo(doc.fabric);
  const sug = suggestedOverlap(doc.fabric);
  const overrides = doc.objects.map((x, i) => ({ x, i })).filter(({ x }) => x.hidden && (x.hidden.keep || (x.hidden.covers && x.hidden.covers !== "auto")));
  const changed = (Object.keys(RULE_DEFAULTS) as (keyof DesignOptions)[]).some((k) => o[k as keyof typeof o] !== RULE_DEFAULTS[k]);
  return (
    <Section
      title="Hidden stitching"
      extra={<Toggle on={o.removeOverlaps} title="Leave out stitching hidden under objects stacked on top" onChange={(v) => setOptions({ removeOverlaps: v })} />}
    >
      {!o.removeOverlaps ? (
        <p className="hint hs-off">
          Everything is sewn, also where an object on top hides it. Turn this on to leave hidden stitching out: less bulk, fewer needle holes, faster sewing. The shapes stay as
          drawn; you can change it any time.
        </p>
      ) : (
        <>
          <Summary report={report} show={show} />

          <h6 className="hs-sub">Overlap</h6>
          <Row label="Under the top" title="How far a cut fill (or line) still reaches under the object on top, so no gap opens when the fabric pulls">
            <Num value={o.overlapMargin} unit="mm" step={0.1} min={0} max={3} onChange={(v) => setOptions({ overlapMargin: v })} />
          </Row>
          {Math.abs(o.overlapMargin - sug.value) > 0.05 && (
            <button className="hs-suggest" onClick={() => setOptions({ overlapMargin: sug.value })} title={`The overlap practitioners suggest for ${fabric.label.toLowerCase()}: ${sug.why}`}>
              <Sparkles size={11} /> {sug.value} mm suggested for {fabric.label.toLowerCase()}
            </button>
          )}

          <h6 className="hs-sub">What hides stitching</h6>
          <Row label="Narrowest" title="An object only hides what's under it where it is at least this wide: outlines, thin borders and narrow satins don't, so the fill under them stays whole">
            <Num value={o.coverMinWidth} unit="mm" step={0.5} min={0} max={10} onChange={(v) => setOptions({ coverMinWidth: v })} />
          </Row>
          <Row label="Rows up to" title="Fills and satins with rows further apart than this are open and show what's under them (0: any spacing hides)">
            <Num value={o.coverMaxSpacing} unit="mm" step={0.1} min={0} max={5} onChange={(v) => setOptions({ coverMaxSpacing: v })} />
          </Row>
          <Row label="Textures" title="Stipple, meander, Hilbert and cross stitch fills leave the fabric showing; on: they hide what's under them anyway">
            <Toggle on={o.texturedCovers} onChange={(v) => setOptions({ texturedCovers: v })} />
          </Row>
          <Row label="Appliqué fabric" title="The fabric of an appliqué hides what's under it (its placement, tack-down and cover are never cut)">
            <Toggle on={o.appliqueCovers} onChange={(v) => setOptions({ appliqueCovers: v })} />
          </Row>

          <h6 className="hs-sub">What is removed</h6>
          <p className="hs-note">
            <StitchFill size={12} /> Fills, under anything that hides them. Satins and appliqués keep their stitches.
          </p>
          <Row label="Running stitch" title="Lines under an object that hides them are cut too, reaching the overlap under it">
            <Toggle on={o.trimRunning} onChange={(v) => setOptions({ trimRunning: v })} />
          </Row>
          <Row label="Underlay" title="Kept: the cut fill's underlay is sewn in full, so the fabric under the object on top stays steady">
            <div className="seg hs-seg">
              <button className={!o.keepUnderlay ? "on" : ""} onClick={() => setOptions({ keepUnderlay: false })}>
                Cut too
              </button>
              <button className={o.keepUnderlay ? "on" : ""} onClick={() => setOptions({ keepUnderlay: true })}>
                <Underlay size={12} /> Kept
              </button>
            </div>
          </Row>
          <Row label="Smallest piece" title="Leftover pieces smaller than this are left out (not worth a jump and a trim), and holes smaller than it aren't cut">
            <Num value={o.minFragment} unit="mm²" step={1} min={0} max={100} digits={1} onChange={(v) => setOptions({ minFragment: v })} />
          </Row>
          {changed && (
            <button className="btn sm ghost hs-reset" onClick={() => setOptions(RULE_DEFAULTS)}>
              <RotateCcw size={12} /> Default rules
            </button>
          )}

          <h6 className="hs-sub">Objects</h6>
          <ObjectList report={report} />
          {overrides.length > 0 && (
            <div className="hs-overrides">
              <p className="hs-note">Set by hand:</p>
              {overrides.map(({ x }) => (
                <button key={x.id} className="hs-chip" onClick={() => useStore.getState().select([x.id])} title="Select it (its own setting is in Selection ▸ Hidden stitching)">
                  <i style={{ background: doc.threads.find((t) => t.id === x.thread)?.color }} />
                  {x.name}
                  <span>{[x.hidden?.covers === "always" ? "always hides" : x.hidden?.covers === "never" ? "never hides" : "", x.hidden?.keep ? "keeps its stitches" : ""].filter(Boolean).join(" · ")}</span>
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </Section>
  );
}

function Summary({ report, show }: { report: HiddenReport | null; show: boolean }) {
  const saved = report ? report.before - report.after : 0;
  const gone = report?.objects.filter((x) => x.gone).length ?? 0;
  return (
    <div className={`hs-summary ${report && saved === 0 ? "none" : ""}`}>
      <div className="hs-big">
        {report == null ? (
          <span className="hs-wait">Working it out…</span>
        ) : saved > 0 ? (
          <>
            <b>−{saved.toLocaleString()}</b> stitches <span className="hs-pct">{pctOf(saved, report.before)} %</span>
          </>
        ) : (
          <span>Nothing is hidden under other objects.</span>
        )}
      </div>
      {report && saved > 0 && (
        <div className="hs-bar" title={`${report.after.toLocaleString()} of ${report.before.toLocaleString()} stitches are sewn`}>
          <i style={{ width: `${100 - pctOf(saved, report.before)}%` }} />
        </div>
      )}
      <div className="hs-meta">
        {report && saved > 0 && (
          <span>
            {report.objects.length} object{report.objects.length === 1 ? "" : "s"} cut{gone ? ` · ${gone} left out completely` : ""}
          </span>
        )}
        <button className={`hs-show ${show ? "on" : ""}`} onClick={() => useStore.getState().set({ showHidden: !show })} title="Mark what is left out on the canvas (hatched)">
          {show ? <Eye size={12} /> : <EyeOff size={12} />} Show on canvas
        </button>
      </div>
    </div>
  );
}

/** The objects that lose stitches, most first; each can keep its stitches. */
function ObjectList({ report }: { report: HiddenReport | null }) {
  const doc = useStore((s) => s.doc);
  const selection = useStore((s) => s.selection);
  if (!report) return null;
  if (!report.objects.length) return <p className="hs-note">No object loses stitches.</p>;
  return (
    <ul className="hs-list">
      {report.objects.map((r) => {
        const o = doc.objects[r.index];
        if (!o) return null;
        const Icon = TYPE_ICON[o.stitch.type];
        const cut = r.before - r.after;
        return (
          <li key={o.id} className={selection.includes(o.id) ? "on" : ""}>
            <button className="hs-obj" onClick={() => useStore.getState().select([o.id])} title={`Select ${o.name}`}>
              <i className="hs-sw" style={{ background: doc.threads.find((t) => t.id === o.thread)?.color }} />
              {Icon && <Icon size={12} />}
              <span className="hs-name">{o.name}</span>
              <span className="hs-cut">{r.gone ? "left out" : `−${cut.toLocaleString()}`}</span>
              <span className="hs-mini" aria-hidden>
                <i style={{ width: `${pctOf(cut, r.before)}%` }} />
              </span>
            </button>
            <button
              className="icon-btn hs-keep"
              title={`Keep all of ${o.name}'s stitches (sew it whole)`}
              onClick={() => useStore.getState().updateObject(o.id, { hidden: { ...o.hidden, keep: true } })}
            >
              <Check size={12} />
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** Selection ▸ Hidden stitching: one object's part in it. */
export function ObjectHiddenSection({ o }: { o: DesignObject }) {
  const doc = useStore((s) => s.doc);
  const opts = hiddenOptions(doc.options);
  const report = useHiddenReport();
  const index = doc.objects.indexOf(o);
  const mine = report?.objects.find((x) => x.index === index);
  const st = o.stitch.type;
  const canCover = st === "fill" || st === "satin" || st === "applique";
  const canBeCut = st === "fill" || (st === "running" && opts.trimRunning);
  if (!canCover && st !== "running") return null;
  const mode: CoverMode = o.hidden?.covers ?? "auto";
  const verdict = coverVerdict(o, doc.options);
  const set = (h: Partial<NonNullable<DesignObject["hidden"]>>) => {
    const next = { ...o.hidden, ...h };
    const empty = (next.covers ?? "auto") === "auto" && !next.keep;
    useStore.getState().updateObject(o.id, { hidden: empty ? undefined : next });
  };
  return (
    <Section title="Hidden stitching" defaultOpen={!!o.hidden || !!mine}>
      {!opts.removeOverlaps && (
        <p className="hint hs-off">
          Hidden stitching is sewn in this design.{" "}
          <button className="btn sm" onClick={() => setOptions({ removeOverlaps: true })}>
            Leave it out
          </button>
        </p>
      )}
      {canCover && (
        <>
          <Row label="Hides" title="Whether stitching under this object is left out">
            <div className="seg hs-seg">
              {(["auto", "always", "never"] as const).map((m) => (
                <button key={m} className={mode === m ? "on" : ""} onClick={() => set({ covers: m })}>
                  {m === "auto" ? "Auto" : m === "always" ? "Always" : "Never"}
                </button>
              ))}
            </div>
          </Row>
          <p className={`hs-verdict ${verdict.hides}`}>
            {verdict.hides === "no" ? <EyeOff size={11} /> : <Eye size={11} />} {verdict.why}
          </p>
        </>
      )}
      {(canBeCut || o.hidden?.keep) && (
        <Row label="Keep its stitches" title="Sew this object whole, also where something on top hides it">
          <Toggle on={!!o.hidden?.keep} onChange={(v) => set({ keep: v })} />
        </Row>
      )}
      {opts.removeOverlaps && canBeCut && !o.hidden?.keep && (
        <p className="hs-note">
          <Scissors size={11} />{" "}
          {mine
            ? mine.gone
              ? "Hidden completely: it is left out."
              : `${(mine.before - mine.after).toLocaleString()} of its ${mine.before.toLocaleString()} stitches are hidden and left out (${pctOf(mine.before - mine.after, mine.before)} %).`
            : report
              ? "Nothing on top hides it."
              : "Working it out…"}
        </p>
      )}
    </Section>
  );
}
