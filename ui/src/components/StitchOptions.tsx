// A single object's stitch options, by stitch type (split out of Dock.tsx).

import { Sparkles } from "lucide-react";
import { autoFillHint, autoSatinHint } from "../lib/underlay";
import { GuideActions } from "./SatinGuides";
import { toCentreLine, toTwoSides } from "../lib/satinSides";
import { MulticolorSatin } from "./MulticolorSatin";
import { fabricInfo } from "../lib/materials";
import { Presets, StitchDefaults, StitchPreview, StylePicker } from "./StitchPanel";
import { MeanderPicker } from "./MeanderPicker";
import { GradientSection } from "./GradientPanel";
import { defaultGuide, normAngle, objectBounds } from "../lib/geometry";
import { useStore, type StitchPatch } from "../store";
import type { DesignObject, StitchParams } from "../types";
import { Num, PatternInput, Row, Section, Seg, Slider, Toggle } from "./ui";
import { Satin3dSection } from "./Satin3dSection";
import { beansToPasses, formatPattern, parsePattern, passesToBeans } from "../lib/patterns";
import { defaultRippleGuide, isRipple } from "../lib/rippleGuide";
import { TartanSection } from "./TartanPanel";
import { CutworkSection } from "./CutworkPanel";
import { useEditTargets } from "./editTargets";

/** What auto underlay does on the design's fabric. */
function AutoUnderlayHint({ kind }: { kind: "fill" | "satin" }) {
  const fabric = useStore((s) => s.doc.fabric);
  const knockdown = useStore((s) => !!s.doc.options?.knockdown);
  const label = fabricInfo(fabric).label;
  return (
    <p className="hint ul-auto">
      <Sparkles size={11} /> <b>Auto on {label}:</b> {kind === "fill" ? autoFillHint(fabric, knockdown) : autoSatinHint(fabric, knockdown)}
    </p>
  );
}

/**
 * Contour / spiral direction, clockwise on screen (the engine's
 * `contourClockwise`, default true as in Ink/Stitch). Designs saved before
 * it stored `clockwise` with the opposite meaning (true = counter-clockwise);
 * the engine reads that flipped, and so does this.
 */
function contourClockwise(st: { contourClockwise?: boolean; clockwise?: boolean }): boolean {
  return st.contourClockwise ?? (st.clockwise === undefined ? true : !st.clockwise);
}

/** What every stitch type's options edit through: the object, the objects the edit goes to, and the setters. */
interface Edit {
  o: DesignObject;
  targets: string[];
  many: boolean;
  up: (p: StitchPatch) => void;
  live: (p: StitchPatch) => void;
  begin: () => void;
  sl: (key: string) => { onChange: (v: number) => void; onLive: (v: number) => void };
}

export function StitchOptions({ o }: { o: DesignObject }) {
  const st = o.stitch;
  // one object, or every selected object of this stitch type (multi-selection)
  const targets = useEditTargets(o);
  const many = targets.length > 1;
  const up = (p: StitchPatch) => useStore.getState().updateStitch(targets, p);
  const live = (p: StitchPatch) => useStore.getState().updateStitch(targets, p, true);
  const begin = () => useStore.getState().checkpoint();
  // sliders: preview live while dragging, one undo step
  const sl = (key: string) => ({
    onChange: (v: number) => up({ [key]: v } as StitchPatch),
    onLive: (v: number) => {
      if (!(window as unknown as { __sl?: boolean }).__sl) {
        begin();
        (window as unknown as { __sl?: boolean }).__sl = true;
        setTimeout(() => ((window as unknown as { __sl?: boolean }).__sl = false), 400);
      }
      live({ [key]: v } as StitchPatch);
    },
  });
  const e: Edit = { o, targets, many, up, live, begin, sl };
  return (
    <>
      <StylePicker o={o} />
      {st.type !== "none" && <StitchPreview o={o} />}
      <StitchDefaults o={o} />
      {st.type === "fill" && st.gradient && !many && <GradientSection group={st.gradient.group} />}
      {st.type === "fill" && !st.gradient && <FillOptions e={e} st={st} />}
      {st.type === "satin" && <SatinOptions e={e} st={st} />}
      {st.type === "running" && st.zigzag && <ZigzagLineOptions e={e} st={st} />}
      {st.type === "running" && !st.zigzag && <RunningOptions e={e} st={st} />}
      {st.type === "applique" && <AppliqueOptions e={e} st={st} />}
      {st.type === "manual" && <ManualOptions e={e} st={st} />}
    </>
  );
}

/** A fill's options (not a gradient's: GradientSection has those). */
function FillOptions({ e, st }: { e: Edit; st: Extract<StitchParams, { type: "fill" }> }) {
  const { targets, up, sl } = e;
  return (
    <>
      {st.method === "tatami" && (
        <Row label="Density">
          <Presets
            items={[
              ["Light", 0.4, "0.40 mm rows — soft, flexible, fewer stitches"],
              ["Normal", 0.25, "0.25 mm rows — the standard"],
              ["Dense", 0.2, "0.20 mm rows — full coverage on dark or textured fabric"],
            ]}
            value={st.rowSpacing}
            onPick={(v) => up({ rowSpacing: v })}
          />
        </Row>
      )}
      {st.method === "meander" && (
        <>
          <Row label="Pattern" title="The lattice or Ink/Stitch tile the meander walks on">
            <MeanderPicker
              pattern={st.meanderPattern}
              tile={st.meanderTile}
              onPick={(p) => up(p.tile ? { meanderTile: p.tile } : { meanderPattern: p.pattern, meanderTile: undefined })}
            />
          </Row>
          {st.meanderTile ? (
            <Row label="Scale" title="Size of the tile (Ink/Stitch meander scale) — bigger is looser and uses fewer stitches">
              {(() => {
                // 2.5 mm ≙ 100 %
                const s = sl("meanderScale");
                return (
                  <Slider
                    min={25}
                    max={400}
                    step={5}
                    digits={0}
                    value={((st.meanderScale ?? 2.5) / 2.5) * 100}
                    unit="%"
                    onChange={(v) => s.onChange(v / 40)}
                    onLive={(v) => s.onLive(v / 40)}
                  />
                );
              })()}
            </Row>
          ) : (
            <Row label="Scale" title="Cell size of the lattice — bigger is looser and uses fewer stitches">
              <Slider min={1} max={10} step={0.1} value={st.meanderScale ?? 2.5} unit="mm" {...sl("meanderScale")} />
            </Row>
          )}
          <Row label="Height" title="Stretch or squash the pattern: its height relative to its width (Ink/Stitch separate x / y meander scale)">
            <Slider
              min={25}
              max={400}
              step={5}
              digits={0}
              unit="%"
              value={Math.round((st.meanderAspect ?? 1) * 100)}
              onChange={(v) => up({ meanderAspect: v / 100 })}
            />
          </Row>
          <Row label="Smoothness" title="0 = sharp corners, 1 = soft curves">
            <Slider min={0} max={1} step={0.05} value={st.smoothness ?? 0.5} {...sl("smoothness")} />
          </Row>
          <Row label="Zig-zag" title="Sew the meander as a zig-zag line — a bold, textured fill (Ink/Stitch zig-zag meander)">
            <span className="dz-inline">
              <Toggle on={(st.meanderZigzag ?? 0) > 0} onChange={(on) => up({ meanderZigzag: on ? 1.5 : 0 })} />
              {(st.meanderZigzag ?? 0) > 0 && (
                <>
                  <Num value={st.meanderZigzag ?? 1.5} step={0.1} min={0.2} max={6} unit="mm" onChange={(v) => up({ meanderZigzag: v })} />
                  <Num value={st.meanderZigzagWidth ?? 3} step={0.25} min={0.3} max={10} unit="mm" onChange={(v) => up({ meanderZigzagWidth: v })} />
                </>
              )}
            </span>
          </Row>
          <Row
            label="Clip to shape"
            title="Keep every stitch inside the shape — smoothing, the zig-zag and Expand can carry them over the edge (Ink/Stitch clip)"
          >
            <Toggle on={!!st.meanderClip} onChange={(v) => up({ meanderClip: v })} />
          </Row>
          <Row label="Variation">
            <button className="btn sm" onClick={() => up({ seed: ((st.seed ?? 1) % 9973) + 1 })}>
              Shuffle
            </button>
          </Row>
        </>
      )}
      {st.method === "guided" && (
        <>
          <p className="hint" style={{ margin: "2px 0 6px" }}>
            Rows follow the dashed guide line — drag its points and handles on the canvas.
          </p>
          <Row
            label="Rows"
            title="Copies of the guide shifted across (they bunch where it bends), or parallel to it at an even distance — and round its ends (Ink/Stitch guided fill strategies)"
          >
            <Seg
              value={st.guidedStrategy ?? "copy"}
              options={
                [
                  ["copy", "Copies"],
                  ["parallel", "Parallel"],
                  ["buffer", "Around"],
                ] as const
              }
              onChange={(v) => up({ guidedStrategy: v })}
            />
          </Row>
          <Row label="Guide">
            <button
              className="btn sm"
              title="Reset the guide to an S-curve across the shape"
              onClick={() => {
                // each object's guide across its own shape
                const ids = new Set(targets);
                useStore.getState().commit((d) => ({
                  ...d,
                  objects: d.objects.map((x) => {
                    const b = ids.has(x.id) && x.stitch.type === "fill" ? objectBounds(x) : null;
                    return b && x.stitch.type === "fill" ? { ...x, stitch: { ...x.stitch, guide: defaultGuide(b) } } : x;
                  }),
                }));
              }}
            >
              Reset
            </button>
            <span className="stat" title="Select the fill and an open line together, then Path ▸ Use line as fill guide">
              or draw a line → Path ▸ Use line as fill guide
            </span>
          </Row>
        </>
      )}
      {st.method !== "hilbert" && st.method !== "stipple" && st.method !== "guided" && st.method !== "circular" && (
        <Row label="Angle">
          <Slider min={-90} max={90} step={1} value={st.angle} unit="°" digits={1} {...sl("angle")} onChange={(v) => up({ angle: normAngle(v) })} />
        </Row>
      )}
      {st.method === "curved" && !st.gradient && (
        <Row label="Follow the shape" title="0 %: straight rows along the angle · 100 %: rows follow the outline">
          <Slider min={0} max={100} step={5} digits={0} unit="%" value={Math.round((st.curve ?? 1) * 100)} onChange={(v) => up({ curve: v / 100 })} />
        </Row>
      )}
      {/* cross stitch: the cell sets both (see the cross section below) */}
      {st.method !== "cross" && (
        <>
          <Row label={st.method === "tatami" ? "Row spacing" : "Spacing"}>
            <Slider
              min={0.15}
              max={st.method === "hilbert" || st.method === "stipple" ? 4 : 1.2}
              step={0.01}
              value={st.rowSpacing}
              unit="mm"
              {...sl("rowSpacing")}
            />
          </Row>
          <Row label="Max stitch">
            <Slider min={1} max={7} step={0.1} value={st.maxStitchLength} unit="mm" {...sl("maxStitchLength")} />
          </Row>
        </>
      )}
      {["tatami", "contour", "spiral", "guided", "circular"].includes(st.method) && !st.gradient && (
        <RandomLength value={st.randomLength ?? 0} onChange={(v) => up({ randomLength: v })} onShuffle={() => up({ seed: ((st.seed ?? 1) % 9973) + 1 })} />
      )}
      <Row label="Travel stitch" title="Length of the hidden running stitches that travel inside the shape">
        <Num value={st.travelLength} step={0.5} min={1} max={6} unit="mm" onChange={(v) => up({ travelLength: v })} />
      </Row>
      {st.method === "tatami" && (
        <Row label="Underpath" title="Travel inside the shape between sections, hidden under rows sewn later (off: along the outline only)">
          <Toggle on={st.underpath ?? true} onChange={(v) => up({ underpath: v })} />
        </Row>
      )}
      {st.method === "tatami" && !st.gradient && (
        <Row
          label="Gap rows"
          title="Extra rows sewn past the end of each section before travelling on, so no gap opens between sections on stretchy fabric (Ink/Stitch gap filling; always an even number)"
        >
          <Num
            value={st.gapFillRows ?? 0}
            step={2}
            min={0}
            max={10}
            digits={0}
            unit="rows"
            onChange={(v) => up({ gapFillRows: Math.ceil(Math.round(v) / 2) * 2 })}
          />
        </Row>
      )}
      {st.method === "cross" && (
        <Row label="Cross order" title="Which diagonal goes first (all crosses alike), and how often each is sewn">
          <span className="dz-inline">
            <Seg
              value={!!st.crossFlip}
              options={
                [
                  [false, "\\ then /", "Top-left to bottom-right first"],
                  [true, "/ then \\", "Bottom-left to top-right first"],
                ] as const
              }
              onChange={(v) => up({ crossFlip: v })}
            />
            <Num
              value={st.crossThreads ?? 1}
              step={2}
              min={1}
              max={5}
              digits={0}
              unit="×"
              onChange={(v) => up({ crossThreads: Math.max(1, Math.round((v - 1) / 2) * 2 + 1) })}
            />
          </span>
        </Row>
      )}
      {st.method === "tatami" && (
        <>
          <Row
            label="Sewing order"
            title="The order the rows are sewn in (the underlay too). One way: from the top row down, so the fabric is pushed one way only and never caught between rows sewn towards each other (a start pin near the bottom turns it round). Centre out: from the middle out to both sides. Ink/Stitch: least travel, ends where it started, so a shape is often sewn in two halves that meet in the middle."
          >
            <select
              className="select"
              aria-label="Sewing order"
              value={st.centerOut ? "centre" : st.tatamiRoute === "inkStitch" ? "inkStitch" : "oneWay"}
              onChange={(e) => {
                const v = e.target.value;
                up(v === "centre" ? { centerOut: true } : { centerOut: false, tatamiRoute: v as "oneWay" | "inkStitch" });
              }}
            >
              <option value="oneWay">One way</option>
              <option value="centre">Centre out</option>
              <option value="inkStitch">Ink/Stitch</option>
            </select>
          </Row>
          <Row
            label="Skip last"
            title="Leave out the last stitch of every row: it sits right next to the first of the next one (fewer stitches, less build-up at the edges)"
          >
            <Toggle on={!!st.skipLast} onChange={(v) => up({ skipLast: v })} />
          </Row>
        </>
      )}
      {st.method === "spiral" && (
        <Row label="Double spiral" title="In on every other ring and back out on the rest: it ends next to where it started">
          <Toggle on={!!st.contourDouble} onChange={(v) => up({ contourDouble: v })} />
        </Row>
      )}
      {(st.method === "contour" || st.method === "spiral") && (
        <Row label="Clockwise" title="Go round clockwise (Ink/Stitch's default) or counter-clockwise">
          <Toggle on={contourClockwise(st)} onChange={(v) => up({ contourClockwise: v, clockwise: undefined })} />
        </Row>
      )}
      {(st.method === "meander" || st.method === "circular" || st.method === "contour" || st.method === "spiral") && (
        <Row label="Repeats" title="The path sewn this many times, and bean stitch: every stitch sewn back and forth (bolder lines)">
          <span className="dz-inline">
            <Num value={st.repeats ?? 1} step={1} min={1} max={5} digits={0} onChange={(v) => up({ repeats: Math.round(v) })} />
            <span className="stat">bean</span>
            <Num value={st.beanRepeats ?? 0} step={2} min={0} max={6} digits={0} onChange={(v) => up({ beanRepeats: Math.round(v) })} />
          </span>
        </Row>
      )}
      {st.method === "tatami" && !st.gradient && (
        <Row label="Carving" title="Needle points lined up into a pattern (program split) — an embossed look">
          <span className="dz-inline">
            <select className="select" value={st.carve ?? "none"} onChange={(e) => up({ carve: e.target.value as NonNullable<typeof st.carve> })}>
              {(
                [
                  ["none", "None"],
                  ["diamonds", "Diamonds"],
                  ["waves", "Waves"],
                  ["chevrons", "Chevrons"],
                  ["bricks", "Bricks"],
                  ["circles", "Circles"],
                ] as const
              ).map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
            </select>
            {(st.carve ?? "none") !== "none" && <Num value={st.carveSize ?? 6} unit="mm" step={0.5} min={1} max={40} onChange={(v) => up({ carveSize: v })} />}
          </span>
        </Row>
      )}
      {st.method === "tartan" && st.tartan && <TartanSection t={st.tartan} />}
      {st.method === "cross" && (
        <>
          <Row label="Cell" title="Size of one cross">
            <Slider min={1} max={8} step={0.1} unit="mm" value={st.crossSize ?? 2.5} onChange={(v) => up({ crossSize: v })} />
          </Row>
          <Row label="Cell height" title="Cells taller or flatter than wide (Ink/Stitch pattern size x y); Square keeps them square">
            <span className="dz-inline">
              <span style={{ opacity: st.crossSizeY ? 1 : 0.55 }}>
                <Num
                  value={st.crossSizeY || st.crossSize || 2.5}
                  step={0.1}
                  min={0.8}
                  max={12}
                  unit="mm"
                  onChange={(v) => up({ crossSizeY: Math.abs(v - (st.crossSize ?? 2.5)) < 1e-6 ? 0 : v })}
                />
              </span>
              {!!st.crossSizeY && (
                <button className="btn sm ghost" onClick={() => up({ crossSizeY: 0 })}>
                  Square
                </button>
              )}
            </span>
          </Row>
          <Row label="Coverage" title="How much of a cell must be inside the shape to get a cross">
            <Slider
              min={10}
              max={100}
              step={5}
              digits={0}
              unit="%"
              value={Math.round((st.crossCoverage ?? 0.5) * 100)}
              onChange={(v) => up({ crossCoverage: v / 100 })}
            />
          </Row>
          <Row label="Stitches">
            <Seg
              value={st.crossKind ?? "cross"}
              options={
                [
                  ["cross", "×", "Both diagonals"],
                  ["half", "/", "Half cross: one diagonal"],
                  ["upright", "+", "Upright cross"],
                  ["double", "✳", "Double cross: one diagonal, the upright cross, then the other diagonal on top"],
                  ["smyrna", "⁜", "Smyrna cross: the diagonal cross, then the upright cross on top"],
                ] as const
              }
              onChange={(k) => up({ crossKind: k })}
            />
          </Row>
          {st.crossKind === "upright" && (
            <Row label="Dense" title="A second grid of upright crosses shifted by half a cell — a closed, woven look (Ink/Stitch dense upright cross)">
              <Toggle on={!!st.crossDense} onChange={(v) => up({ crossDense: v })} />
            </Row>
          )}
          <Row label="Split longer" title="Split cross stitches longer than this — big cells stay secure (0 = never)">
            <Num value={st.crossMaxLength ?? 11} step={0.5} min={0} max={20} unit="mm" onChange={(v) => up({ crossMaxLength: v })} />
          </Row>
        </>
      )}
      {st.method === "tatami" && (
        <>
          <Row label="Staggers" title={st.rowOffsets?.length ? "Row offsets below set where each row begins" : "Rows repeat their needle pattern every N rows"}>
            <Num value={st.staggers} step={1} min={1} max={12} digits={0} onChange={(v) => up({ staggers: Math.round(v) })} />
          </Row>
          <TatamiPattern st={st} up={up} />
          <Row label="Gradient end" title="Row spacing at the far end (0 = off) — density gradient across the fill">
            <Num value={st.endRowSpacing} step={0.05} min={0} unit="mm" onChange={(v) => up({ endRowSpacing: v })} />
          </Row>
          {st.endRowSpacing > 0 && (
            <Row label="Even blend" title="Change the density (not the spacing) evenly — two opposite gradients add up to full coverage (colour blending)">
              <Toggle on={!!st.gradientDensity} onChange={(v) => up({ gradientDensity: v })} />
            </Row>
          )}
          <Row label="Pull comp." title="Rows grow at both ends by this much, plus a share of their length">
            <span className="dz-inline">
              <Num value={st.pullComp} step={0.05} unit="mm" onChange={(v) => up({ pullComp: v })} />
              <Num
                value={Math.round((st.pullCompPct ?? 0) * 100)}
                step={1}
                min={0}
                max={30}
                unit="%"
                digits={0}
                onChange={(v) => up({ pullCompPct: v / 100 })}
              />
            </span>
          </Row>
        </>
      )}
      {(st.method === "radial" || st.method === "circular") && (
        <div className="grid2">
          <div className="row">
            <label>cx</label>
            <Num value={st.center[0]} step={0.05} min={0} max={1} onChange={(v) => up({ center: [v, st.center[1]] })} />
          </div>
          <div className="row">
            <label>cy</label>
            <Num value={st.center[1]} step={0.05} min={0} max={1} onChange={(v) => up({ center: [st.center[0], v] })} />
          </div>
        </div>
      )}
      <Section
        title="Underlay"
        extra={<Toggle on={st.underlay || !!st.underlayAuto} onChange={(v) => up(v ? { underlay: true } : { underlay: false, underlayAuto: false })} />}
      >
        <Presets
          items={[
            ["Auto", { underlayAuto: true, underlay: true }, "Chosen by the shape's size and the fabric"],
            ["None", { underlayAuto: false, underlay: false }, "No underlay — light fills, stable fabric"],
            ["Light", { underlayAuto: false, underlay: true, underlaySpacing: 1.2, underlayInset: 0.4 }, "Open grid that just holds the fabric"],
            ["Standard", { underlayAuto: false, underlay: true, underlaySpacing: 0.75, underlayInset: 0.3 }, "Good for most fabrics"],
            ["Heavy", { underlayAuto: false, underlay: true, underlaySpacing: 0.5, underlayInset: 0.2 }, "Stretchy or fluffy fabrics (knits, towels)"],
          ]}
          value={
            st.underlayAuto
              ? { underlayAuto: true, underlay: true }
              : st.underlay
                ? { underlayAuto: false, underlay: true, underlaySpacing: st.underlaySpacing, underlayInset: st.underlayInset }
                : { underlayAuto: false, underlay: false }
          }
          onPick={(v) => up(v)}
        />
        {st.underlayAuto && <AutoUnderlayHint kind="fill" />}
        {st.underlay && !st.underlayAuto && (
          <>
            <Row label="Edge run" title="A running stitch just inside the outline first: holds the edge so the fill's border stays crisp">
              <Toggle on={!!st.underlayEdge} onChange={(v) => up({ underlayEdge: v })} />
            </Row>
            <Row label="Cross-hatch" title="Two tatami passes crossing at ±45° to the underlay angle (double tatami): for soft, stretchy and pile fabrics">
              <Toggle on={!!st.underlayCross} onChange={(v) => up({ underlayCross: v })} />
            </Row>
            <Row label="Skip last" title="Leave out the last underlay stitch of every row (fewer stitches at the edges)">
              <Toggle on={!!st.underlaySkipLast} onChange={(v) => up({ underlaySkipLast: v })} />
            </Row>
            <Row label="Stitch length">
              <Num value={st.underlayStitchLength} step={0.5} min={1} max={6} unit="mm" onChange={(v) => up({ underlayStitchLength: v })} />
            </Row>
            <Row label="Angle (rel.)" title="Relative to the fill angle. Or a list of angles for several passes, e.g. 30 90 150">
              <span className="dz-inline">
                <Num value={st.underlayAngle} step={15} unit="°" onChange={(v) => up({ underlayAngle: v, underlayAngles: undefined })} />
                <input
                  className="input"
                  style={{ width: 90 }}
                  placeholder="or a list"
                  title="Several passes: angles separated by spaces (Ink/Stitch's underlay angle list)"
                  defaultValue={(st.underlayAngles ?? []).join(" ")}
                  onBlur={(e) => {
                    const list = e.target.value
                      .split(/[\s,]+/)
                      .map(Number)
                      .filter((x) => Number.isFinite(x) && e.target.value.trim() !== "");
                    up({ underlayAngles: list.length ? list : undefined });
                  }}
                />
              </span>
            </Row>
            <Row label="Spacing">
              <Num value={st.underlaySpacing} step={0.1} min={0.3} unit="mm" onChange={(v) => up({ underlaySpacing: v })} />
            </Row>
            <Row label="Inset">
              <Num value={st.underlayInset} step={0.1} min={0} unit="mm" onChange={(v) => up({ underlayInset: v })} />
            </Row>
          </>
        )}
      </Section>
    </>
  );
}

/** A satin's options. */
function SatinOptions({ e, st }: { e: Edit; st: Extract<StitchParams, { type: "satin" }> }) {
  const { o, targets, many, up, sl } = e;
  return (
    <>
      {st.method === "satin" && (
        <Row label="Density">
          <Presets
            items={[
              ["Open", 0.6, "0.6 mm — light, flexible"],
              ["Normal", 0.4, "0.4 mm — the standard"],
              ["Dense", 0.3, "0.3 mm — full, shiny coverage"],
            ]}
            value={st.spacing}
            onPick={(v) => up({ spacing: v })}
          />
        </Row>
      )}
      {o.paths.length === 1 && (
        <Row label="Width">
          <Slider min={0.5} max={12} step={0.1} value={st.width} unit="mm" {...sl("width")} />
        </Row>
      )}
      <Row label="Spacing">
        <Slider min={0.2} max={2} step={0.01} value={st.spacing} unit="mm" {...sl("spacing")} />
      </Row>
      <Row label="Pull comp.">
        <Num value={st.pullComp} step={0.05} unit="mm" onChange={(v) => up({ pullComp: v })} />
      </Row>
      <Row label="Pull comp. %">
        <Num value={st.pullCompPct} step={5} unit="%" onChange={(v) => up({ pullCompPct: v })} />
      </Row>
      <Row label="Split above" title="Split stitches longer than this (0 = off)">
        <Num value={st.maxStitchLength} step={0.5} min={0} unit="mm" onChange={(v) => up({ maxStitchLength: v })} />
      </Row>
      <Row label="Short stitch" title="In tight curves every other stitch is shortened by this share, where stitches come closer than the distance">
        <span className="dz-inline">
          <Num value={st.shortStitchInset * 100} step={5} min={0} max={90} unit="%" digits={0} onChange={(v) => up({ shortStitchInset: v / 100 })} />
          <Num value={st.shortStitchDistance ?? 0.25} step={0.05} min={0} max={2} unit="mm" onChange={(v) => up({ shortStitchDistance: v })} />
        </span>
      </Row>
      <Row label="Push comp." title="Pull the column's ends in: satins push the fabric out where they start and end">
        <Num value={st.pushComp ?? 0} step={0.1} min={0} max={3} unit="mm" onChange={(v) => up({ pushComp: v })} />
      </Row>
      {!st.foam && !st.layered && (
        <Row
          label="Bisatin"
          title="The cover in two columns half as wide, split along the middle: the first sewn to the far end, the second back to the start, over the column's underlay. For columns too wide for one stitch (not in Ink/Stitch)"
        >
          <Toggle on={!!st.bisatin} onChange={(v) => up({ bisatin: v || undefined })} />
        </Row>
      )}
      {st.maxStitchLength > 0 && (
        <>
          <Row
            label="Split pattern"
            title="Where long stitches are split: evenly (the points line up), staggered from stitch to stitch, or at a random phase (Ink/Stitch split methods)"
          >
            <div className="seg">
              {(
                [
                  ["even", "Even", { splitStaggers: 0, splitRandomPhase: false }],
                  // Ink/Stitch "simple": the same split points on every stitch
                  ["simple", "Simple", { splitStaggers: 1, splitRandomPhase: false }],
                  ["s3", "Stagger 3", { splitStaggers: 3, splitRandomPhase: false }],
                  ["s4", "Stagger 4", { splitStaggers: 4, splitRandomPhase: false }],
                  ["random", "Random", { splitStaggers: 0, splitRandomPhase: true }],
                ] as const
              ).map(([k, l, patch]) => {
                const cur = st.splitRandomPhase
                  ? "random"
                  : (st.splitStaggers ?? 0) >= 4
                    ? "s4"
                    : (st.splitStaggers ?? 0) >= 2
                      ? "s3"
                      : st.splitStaggers === 1
                        ? "simple"
                        : "even";
                return (
                  <button key={k} className={cur === k ? "on" : ""} onClick={() => up(patch)}>
                    {l}
                  </button>
                );
              })}
            </div>
          </Row>
          {(st.splitStaggers ?? 0) < 2 && (
            <Row
              label="Split jitter"
              title={
                st.splitRandomPhase
                  ? "Vary the length of the split stitches by up to this much"
                  : "Move every split point by up to this share of a split stitch"
              }
            >
              <span className="dz-inline">
                <Num
                  value={Math.round((st.splitJitter ?? 0) * 100)}
                  step={5}
                  min={0}
                  max={100}
                  unit="%"
                  digits={0}
                  onChange={(v) => up({ splitJitter: v / 100 })}
                />
                {st.splitRandomPhase && (
                  <span title="Split stitches longer than this already (default: the max stitch length) — a gradual change between single and split stitches">
                    <Num
                      value={st.splitMinLength || st.maxStitchLength}
                      step={0.5}
                      min={0.5}
                      max={st.maxStitchLength}
                      unit="mm≥"
                      onChange={(v) => up({ splitMinLength: v >= st.maxStitchLength ? 0 : v })}
                    />
                  </span>
                )}
              </span>
            </Row>
          )}
        </>
      )}
      <Row label="Texture" title="Random width (up to this much wider / narrower) and spacing for a hand-made look; Shuffle gives another pattern">
        <span className="dz-inline">
          <Num value={Math.round((st.randomWider ?? 0) * 100)} step={5} min={0} max={50} unit="%+" digits={0} onChange={(v) => up({ randomWider: v / 100 })} />
          <Num
            value={Math.round((st.randomNarrower ?? 0) * 100)}
            step={5}
            min={0}
            max={50}
            unit="%−"
            digits={0}
            onChange={(v) => up({ randomNarrower: v / 100 })}
          />
          <span title="Random spacing: each stitch's distance to the next varies by up to this much (Ink/Stitch random zig-zag spacing)">
            <Num
              value={Math.round((st.randomSpacing ?? 0) * 100)}
              step={5}
              min={0}
              max={100}
              unit="%↔"
              digits={0}
              onChange={(v) => up({ randomSpacing: v / 100 })}
            />
          </span>
          {((st.randomWider ?? 0) > 0 || (st.randomNarrower ?? 0) > 0 || (st.randomSpacing ?? 0) > 0 || (st.splitJitter ?? 0) > 0 || !!st.splitRandomPhase) && (
            <button className="btn sm ghost" title="Another random pattern" onClick={() => up({ randomSeed: ((st.randomSeed ?? 1) % 9973) + 1 })}>
              Shuffle
            </button>
          )}
        </span>
      </Row>
      <Row label="Direction" title="Direction guides: lines across the column that set the stitch angle there (Ink/Stitch rungs)">
        <GuideActions />
      </Row>
      <Row
        label="Sides"
        title="Centre line: one line with a width, edited with the width handles. Two sides: each side shaped on its own with the node tool (A). Switch at any time."
      >
        {st.multi ? (
          <span className="stat">One line per column</span>
        ) : (
          <div className="seg" role="group" aria-label="Sides">
            <button
              className={o.paths.length === 1 ? "on" : ""}
              title="One centre line with a width: the column keeps an even width"
              onClick={() =>
                o.paths.length !== 1 &&
                useStore.getState().commit((d) => ({ ...d, objects: d.objects.map((x) => (targets.includes(x.id) && !x.locked ? toCentreLine(x) : x)) }))
              }
            >
              Centre line
            </button>
            <button
              className={o.paths.length > 1 ? "on" : ""}
              title="Two sides, point for point: shape each side on its own with the node tool (A)"
              onClick={() => {
                if (o.paths.length !== 1) return;
                const s = useStore.getState();
                s.commit((d) => ({ ...d, objects: d.objects.map((x) => (targets.includes(x.id) && !x.locked ? toTwoSides(x) : x)) }));
                s.setTool("node");
              }}
            >
              Two sides
            </button>
          </div>
        )}
      </Row>
      <Row label="Reverse">
        <Toggle on={st.reverse} onChange={(v) => up({ reverse: v })} />
      </Row>
      {o.paths.length > 1 && (
        <>
          <Row label="Swap rails">
            <Toggle on={st.swapRails} onChange={(v) => up({ swapRails: v })} />
          </Row>
          <Row
            label="Rail direction"
            title="A rail drawn the other way twists the satin: Auto detects it; set it by hand if a satin renders strangely (Ink/Stitch reverse rails)"
          >
            <select
              className="select"
              value={st.reverseRails ?? "automatic"}
              onChange={(e) => up({ reverseRails: e.target.value as NonNullable<typeof st.reverseRails> })}
            >
              <option value="automatic">Auto</option>
              <option value="none">As drawn</option>
              <option value="first">Reverse first</option>
              <option value="second">Reverse second</option>
              <option value="both">Reverse both</option>
            </select>
          </Row>
        </>
      )}
      {!many && (
        <Section title="Colour stripes" defaultOpen={false}>
          <MulticolorSatin o={o} />
        </Section>
      )}
      <Satin3dSection o={o} st={st} up={up} />
      <Section title="Underlay">
        {(st.foam || st.layered) && (
          <p className="hint">{st.foam ? "Over foam the underlay is a contour (3D above)." : "The layers' core has its own underlay (3D above)."}</p>
        )}
        <Presets
          items={[
            ["Auto", { underlayAuto: true }, "Chosen by the column's width and the fabric"],
            ["None", { underlayAuto: false, centerWalk: false, contourUnderlay: false, zigzagUnderlay: false }, "No underlay — thin columns"],
            ["Centre", { underlayAuto: false, centerWalk: true, contourUnderlay: false, zigzagUnderlay: false }, "Centre walk — narrow columns (< 2.5 mm)"],
            ["Edges", { underlayAuto: false, centerWalk: false, contourUnderlay: true, zigzagUnderlay: false }, "Contour underlay — crisp edges (2.5–4 mm)"],
            ["Full", { underlayAuto: false, centerWalk: false, contourUnderlay: true, zigzagUnderlay: true }, "Contour + zig-zag — wide columns, lofty look"],
          ]}
          value={
            st.underlayAuto
              ? { underlayAuto: true }
              : { underlayAuto: false, centerWalk: st.centerWalk, contourUnderlay: st.contourUnderlay, zigzagUnderlay: st.zigzagUnderlay }
          }
          onPick={(v) => up(v)}
        />
        {st.underlayAuto && <AutoUnderlayHint kind="satin" />}
        {!st.underlayAuto && (
          <>
            <Row label="Centre walk">
              <Toggle on={st.centerWalk} onChange={(v) => up({ centerWalk: v })} />
            </Row>
            {st.centerWalk && (
              <Row label="Walk" title="Passes along the column (there and back = 2) and where across it (50 % = centre)">
                <span className="dz-inline">
                  <Num
                    value={st.centerWalkRepeats ?? 2}
                    step={2}
                    min={2}
                    max={8}
                    digits={0}
                    onChange={(v) => up({ centerWalkRepeats: Math.max(2, Math.round(v / 2) * 2) })}
                  />
                  <Num
                    value={Math.round((st.centerWalkPosition ?? 0.5) * 100)}
                    step={5}
                    min={0}
                    max={100}
                    unit="%"
                    digits={0}
                    onChange={(v) => up({ centerWalkPosition: v / 100 })}
                  />
                </span>
              </Row>
            )}
            {(st.centerWalk || st.contourUnderlay) && (
              <Row label="Run length" title="Stitch length of the centre walk and contour underlay">
                <Num value={st.underlayStitchLength ?? 2.5} step={0.5} min={1} max={6} unit="mm" onChange={(v) => up({ underlayStitchLength: v })} />
              </Row>
            )}
            <Row label="Contour">
              <Toggle on={st.contourUnderlay} onChange={(v) => up({ contourUnderlay: v })} />
            </Row>
            {st.contourUnderlay && (
              <Row label="Contour inset" title="Inset from the edges: a fixed distance plus a share of the column width">
                <span className="dz-inline">
                  <Num value={st.contourInset} step={0.1} min={0} unit="mm" onChange={(v) => up({ contourInset: v })} />
                  <Num
                    value={Math.round((st.contourInsetPct ?? 0) * 100)}
                    step={5}
                    min={0}
                    max={45}
                    unit="%"
                    digits={0}
                    onChange={(v) => up({ contourInsetPct: v / 100 })}
                  />
                </span>
              </Row>
            )}
            <Row label="Zig-zag">
              <Toggle on={st.zigzagUnderlay} onChange={(v) => up({ zigzagUnderlay: v })} />
            </Row>
            {st.zigzagUnderlay && (
              <>
                <Row label="ZZ spacing">
                  <Num value={st.zigzagUnderlaySpacing} step={0.25} min={0.5} unit="mm" onChange={(v) => up({ zigzagUnderlaySpacing: v })} />
                </Row>
                <Row label="ZZ inset" title="Inset from the edges: a fixed distance plus a share of the column width">
                  <span className="dz-inline">
                    <Num value={st.zigzagUnderlayInset} step={0.1} min={0} unit="mm" onChange={(v) => up({ zigzagUnderlayInset: v })} />
                    <Num
                      value={Math.round((st.zigzagInsetPct ?? 0) * 100)}
                      step={5}
                      min={0}
                      max={45}
                      unit="%"
                      digits={0}
                      onChange={(v) => up({ zigzagInsetPct: v / 100 })}
                    />
                  </span>
                </Row>
                <Row label="ZZ split" title="Split zig-zag underlay stitches longer than this (0 = never)">
                  <Num value={st.zigzagUnderlayMaxStitch ?? 0} step={0.5} min={0} max={10} unit="mm" onChange={(v) => up({ zigzagUnderlayMaxStitch: v })} />
                </Row>
              </>
            )}
          </>
        )}
      </Section>
    </>
  );
}

/** A running stitch sewn as a zig-zag line (`st.zigzag` is set). */
function ZigzagLineOptions({ e, st }: { e: Edit; st: Extract<StitchParams, { type: "running" }> }) {
  const { up } = e;
  const zz = st.zigzag!;
  return (
    <>
      <Row label="Width">
        <Slider min={0.5} max={8} step={0.1} unit="mm" value={zz.width} onChange={(v) => up({ zigzag: { ...zz, width: v } })} />
      </Row>
      <Row label="Spacing" title="Length of one zig and zag together">
        <Slider min={0.2} max={4} step={0.05} unit="mm" value={zz.spacing} onChange={(v) => up({ zigzag: { ...zz, spacing: v } })} />
      </Row>
      <Row label="Angle" title="Turn every zig-zag by this angle — spokes on curves (Ink/Stitch zig-zag angle)">
        <Slider min={-89} max={89} step={1} digits={0} unit="°" value={zz.angle} onChange={(v) => up({ zigzag: { ...zz, angle: v } })} />
      </Row>
      <Row label="Pull comp." title="Widen each side against the fabric pulling the zig-zag together">
        <Num value={zz.pullComp} step={0.05} min={-1} max={2} unit="mm" onChange={(v) => up({ zigzag: { ...zz, pullComp: v } })} />
      </Row>
      <Row label="Repeats" title="Passes along the path (2 = there and back on the same points)">
        <Num value={st.repeats} step={1} min={1} max={9} digits={0} onChange={(v) => up({ repeats: Math.round(v) })} />
      </Row>
    </>
  );
}

/** A running stitch's options. */
function RunningOptions({ e, st }: { e: Edit; st: Extract<StitchParams, { type: "running" }> }) {
  const { o, up, sl } = e;
  return (
    <>
      <Row label="Stitch">
        <Presets
          items={[
            ["Fine", 1.5, "1.5 mm — tight curves, small details"],
            ["Normal", 2.5, "2.5 mm — the standard"],
            ["Long", 3.5, "3.5 mm — straight lines, quilting"],
          ]}
          value={st.length}
          onPick={(v) => up({ length: v })}
        />
      </Row>
      <Row label="Length">
        <Slider min={0.5} max={6} step={0.1} value={st.length} unit="mm" {...sl("length")} />
      </Row>
      <Row label="Tolerance" title="How closely stitches follow curves">
        <Num value={st.tolerance} step={0.05} min={0.01} unit="mm" onChange={(v) => up({ tolerance: v })} />
      </Row>
      <Row label="Repeats" title="Passes along the path (2 = there and back)">
        <Num value={st.repeats} step={1} min={1} max={9} digits={0} onChange={(v) => up({ repeats: Math.round(v) })} />
      </Row>
      <Row label="Bean repeats" title="0 = single, 2 = triple (bean) stitch">
        <Num value={st.beanRepeats} step={2} min={0} max={8} digits={0} onChange={(v) => up({ beanRepeats: Math.round(v) })} />
      </Row>
      <CutworkSection o={o} />
      {!st.stem && !st.motif && (
        <Section title="Length pattern & texture" defaultOpen={!!(st.lengthPattern?.length || st.beanPattern?.length || st.randomLength)}>
          <Row label="Lengths" title="Several stitch lengths used in turn, e.g. “2 1” for long-short (Ink/Stitch). Empty: the length above">
            <PatternInput
              value={st.lengthPattern}
              placeholder={`${st.length} (even)`}
              unit="mm"
              parse={(t) => parsePattern(t, { min: 0.3, max: 12 })}
              format={formatPattern}
              onChange={(v) => up({ lengthPattern: v.length > 1 ? v : undefined, ...(v.length === 1 ? { length: v[0] } : {}) })}
            />
          </Row>
          <Row label="Bean pattern" title="Back-and-forth repeats per stitch in turn, e.g. “0 1” (1 = triple), Ink/Stitch style. Empty: the bean repeats above">
            <PatternInput
              value={passesToBeans(st.beanPattern)}
              placeholder={String(Math.ceil(st.beanRepeats / 2))}
              parse={(t) => parsePattern(t, { min: 0, max: 5, integer: true })}
              format={(v) => (v?.length ? formatPattern(v) : "")}
              onChange={(v) =>
                up({ beanPattern: v.length > 1 ? beansToPasses(v) : undefined, ...(v.length === 1 ? { beanRepeats: beansToPasses(v)[0] } : {}) })
              }
            />
          </Row>
          <RandomLength
            value={st.randomLength ?? 0}
            onChange={(v) => up({ randomLength: v })}
            onShuffle={() => up({ randomSeed: ((st.randomSeed ?? 1) % 9973) + 1 })}
          />
        </Section>
      )}
      {st.stem && (
        <Row label="Rope width" title="How far the stem stitches slant across the line">
          <Slider min={0.2} max={3} step={0.1} unit="mm" value={st.stem.width} onChange={(v) => up({ stem: { width: v } })} />
        </Row>
      )}
      {st.motif && (
        <>
          <Row label="Motif">
            <select className="select" value={st.motif.kind} onChange={(e) => up({ motif: { ...st.motif!, kind: e.target.value as typeof st.motif.kind } })}>
              {(
                [
                  ["wave", "Wave"],
                  ["zigzag", "Zig-zag"],
                  ["scallop", "Scallop"],
                  ["loop", "Loops"],
                  ["diamond", "Diamonds"],
                  ["cross", "Crosses"],
                ] as const
              ).map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
            </select>
          </Row>
          <Row label="Motif size" title="Length of one motif along the line (its height: half of it)">
            <Slider min={1.5} max={15} step={0.5} unit="mm" value={st.motif.size} onChange={(v) => up({ motif: { ...st.motif!, size: v } })} />
          </Row>
        </>
      )}
      {st.ripple && <RippleSection o={o} />}
    </>
  );
}

/** An appliqué's options. */
function AppliqueOptions({ e, st }: { e: Edit; st: Extract<StitchParams, { type: "applique" }> }) {
  const { up, sl } = e;
  return (
    <>
      <p className="hint" style={{ margin: "2px 0 8px" }}>
        {st.freeEdge
          ? "Sews the placement line, stops so you can glue the fabric down, then covers the edge."
          : "Sews the placement line, stops so you can lay the fabric, tacks it down, stops so you can trim it, then covers the edge."}
      </p>
      <Row label="Free edge" title="No tack-down: the placement line 5 mm inside, one stop to glue the fabric on, then the cover (Punch)">
        <Toggle on={!!st.freeEdge} onChange={(v) => up({ freeEdge: v })} />
      </Row>
      <Section title="1 · Placement line" extra={<Toggle on={st.placement} onChange={(v) => up({ placement: v })} />}>
        {st.placement && (
          <>
            <Row label="Stitch length">
              <Slider min={1} max={4} step={0.1} value={st.placementLength} unit="mm" {...sl("placementLength")} />
            </Row>
            {!st.freeEdge && (
              <Row label="Inset" title="Distance of the placement line inside the edge (Punch: 1–1.5 mm), so the fabric laid on it covers it">
                <Slider min={0} max={3} step={0.05} value={st.placementInset ?? 0} unit="mm" onChange={(v) => up({ placementInset: v })} />
              </Row>
            )}
          </>
        )}
      </Section>
      {!st.freeEdge && (
        <Section title="2 · Tack-down">
          <Row label="Stitch">
            <select className="select" style={{ width: "100%" }} value={st.tackdown} onChange={(e) => up({ tackdown: e.target.value })}>
              <option value="zigzag">Zig-zag</option>
              <option value="eStitch">E-stitch</option>
              <option value="run">Running stitch</option>
              <option value="none">None</option>
            </select>
          </Row>
          {st.tackdown !== "none" && (
            <Row label="Inset" title="Distance inside the edge">
              <Slider min={0} max={3} step={0.05} value={st.tackdownInset} unit="mm" {...sl("tackdownInset")} />
            </Row>
          )}
          {(st.tackdown === "zigzag" || st.tackdown === "eStitch") && (
            <>
              <Row label="Width">
                <Slider min={0.5} max={4} step={0.1} value={st.tackdownWidth} unit="mm" {...sl("tackdownWidth")} />
              </Row>
              <Row label="Spacing">
                <Slider min={0.4} max={4} step={0.1} value={st.tackdownSpacing} unit="mm" {...sl("tackdownSpacing")} />
              </Row>
            </>
          )}
        </Section>
      )}
      <Section title={st.freeEdge ? "2 · Cover" : "3 · Cover"}>
        <Row label="Stitch">
          <select className="select" style={{ width: "100%" }} value={st.cover} onChange={(e) => up({ cover: e.target.value })}>
            <option value="satin">Satin</option>
            <option value="eStitch">E-stitch (blanket)</option>
            <option value="none">None (raw edge)</option>
          </select>
        </Row>
        {st.cover !== "none" && (
          <>
            <Row label="Width">
              <Slider min={1} max={8} step={0.1} value={st.coverWidth} unit="mm" {...sl("coverWidth")} />
            </Row>
            <Row label="Spacing">
              <Slider min={0.2} max={2.5} step={0.05} value={st.coverSpacing} unit="mm" {...sl("coverSpacing")} />
            </Row>
            <Row label="Offset" title="Shift the cover outwards (+) or inwards (−) from the edge">
              <Slider min={-2} max={2} step={0.05} value={st.coverOffset} unit="mm" {...sl("coverOffset")} />
            </Row>
            <Row label="Pull comp.">
              <Num value={st.pullComp} step={0.05} unit="mm" onChange={(v) => up({ pullComp: v })} />
            </Row>
            <Row label="Underlay">
              <Toggle on={st.coverUnderlay} onChange={(v) => up({ coverUnderlay: v })} />
            </Row>
            {st.cover === "eStitch" && (
              <Row label="Flip prongs">
                <Toggle on={st.flip} onChange={(v) => up({ flip: v })} />
              </Row>
            )}
          </>
        )}
      </Section>
      <Row label="Machine stops" title="Stop after the placement line and after the tack-down">
        <Toggle on={st.stops} onChange={(v) => up({ stops: v })} />
      </Row>
    </>
  );
}

/** Manual stitches' options. */
function ManualOptions({ e, st }: { e: Edit; st: Extract<StitchParams, { type: "manual" }> }) {
  const { up } = e;
  return (
    <>
      <div className="hint">
        Every node is a needle penetration (imported machine files use this). Edit nodes with the node tool (A), or{" "}
        <button
          className="link"
          onClick={() => useStore.getState().setDialog("rebuild")}
          title="Turn the stitches back into shapes that can be stitched again (Ink/Stitch Outline)"
        >
          rebuild shapes from the stitches…
        </button>
      </div>
      <Row label="Split longer" title="Split stitches longer than this into even parts (0 = keep them; Ink/Stitch max stitch length)">
        <Num value={st.maxLength ?? 0} step={0.5} min={0} max={12} unit="mm" onChange={(v) => up({ maxLength: v || undefined })} />
      </Row>
      <Row label="Bean pattern" title="Back-and-forth repeats per stitch in turn, e.g. “1” (triple) or “0 1”">
        <PatternInput
          value={passesToBeans(st.beanPattern)}
          placeholder="0"
          parse={(t) => parsePattern(t, { min: 0, max: 5, integer: true })}
          format={(v) => (v?.length ? formatPattern(v) : "")}
          onChange={(v) => up({ beanPattern: v.some((x) => x > 0) ? beansToPasses(v) : undefined })}
        />
      </Row>
    </>
  );
}

/** Random stitch length (Ink/Stitch): off, or ± a share of every stitch, with a new pattern on Shuffle. */
/**
 * Long-short tatami: 4 and 2 mm in turn, the rows staggered (a quarter of the
 * pattern each with 4 staggers, so no two of four rows share a needle hole).
 * The NOVAstitch Designer fork's «Lungo-corto» shifts rows by thirds, which
 * puts every hole on one 2 mm grid: columns of holes. Check on a test stitch-out.
 */
const LONG_SHORT = { lengthPattern: [4, 2], rowOffsets: undefined };

/** Tatami rows in a pattern: stitch lengths in turn and where each row begins (not in Ink/Stitch). */
function TatamiPattern({ st, up }: { st: Extract<StitchParams, { type: "fill" }>; up: (p: StitchPatch) => void }) {
  const offsetsShown = st.rowOffsets?.map((v) => Math.round(v * 1000) / 10);
  const stagger = Array.from({ length: Math.max(1, st.staggers) }, (_, k) => Math.round((100 * k) / Math.max(1, st.staggers)));
  return (
    <Section title="Row pattern" defaultOpen={!!(st.lengthPattern?.length || st.rowOffsets?.length)}>
      {(st.randomLength ?? 0) > 0 && <p className="hint">Random length is on: it decides the stitches instead.</p>}
      <Presets
        items={[
          ["Even", { lengthPattern: undefined, rowOffsets: undefined }, "Every stitch the max stitch length, the rows staggered (Ink/Stitch)"],
          ["Long-short", LONG_SHORT, "4 and 2 mm in turn, the rows staggered: a woven look"],
        ]}
        value={{ lengthPattern: st.lengthPattern?.length ? st.lengthPattern : undefined, rowOffsets: st.rowOffsets?.length ? st.rowOffsets : undefined }}
        onPick={(v) => up(v)}
      />
      <Row label="Lengths" title="Stitch lengths used in turn along each row, e.g. “4 2” for long-short. Empty: the max stitch length">
        <PatternInput
          value={st.lengthPattern}
          placeholder={`${st.maxStitchLength} (even)`}
          unit="mm"
          parse={(t) => parsePattern(t, { min: 0.3, max: 12 }).slice(0, 8)}
          format={formatPattern}
          onChange={(v) => up({ lengthPattern: v.length ? v : undefined })}
        />
      </Row>
      <Row
        label="Row offsets"
        title="Where each row's pattern begins, as a share of the pattern's length, used in turn row after row, e.g. “0 33 67”. Empty: the staggers"
      >
        <PatternInput
          value={offsetsShown}
          placeholder={stagger.join(" ")}
          unit="%"
          parse={(t) => parsePattern(t, { min: 0, max: 100 }).slice(0, 8)}
          format={formatPattern}
          onChange={(v) => up({ rowOffsets: v.length ? v.map((x) => x / 100) : undefined })}
        />
      </Row>
    </Section>
  );
}

function RandomLength({ value, onChange, onShuffle }: { value: number; onChange: (v: number) => void; onShuffle: () => void }) {
  return (
    <Row
      label="Random length"
      title="Vary every stitch length by up to this much, with a random start on each line — no lines or moiré across parallel rows (Ink/Stitch random stitch length)"
    >
      <span className="dz-inline">
        <Toggle on={value > 0} onChange={(on) => onChange(on ? 10 : 0)} />
        {value > 0 && (
          <>
            <Num value={value} step={5} min={1} max={90} digits={0} unit="%" onChange={onChange} />
            <button className="btn sm ghost" title="Another random pattern" onClick={onShuffle}>
              Shuffle
            </button>
          </>
        )}
      </span>
    </Row>
  );
}

/** Ripple stitch settings (Ink/Stitch ripple stitch): lines, guide, copies, grid. */
function RippleSection({ o }: { o: DesignObject }) {
  const targets = useEditTargets(o);
  const st = o.stitch;
  if (!isRipple(o) || st.type !== "running" || !st.ripple) return null;
  const r = st.ripple;
  // every target keeps its own ripple settings and takes just the change
  const up = (patch: Partial<typeof r>) => {
    const ids = new Set(targets);
    useStore.getState().commit((d) => ({
      ...d,
      objects: d.objects.map((x) =>
        ids.has(x.id) && x.stitch.type === "running" && x.stitch.ripple ? { ...x, stitch: { ...x.stitch, ripple: { ...x.stitch.ripple, ...patch } } } : x,
      ),
    }));
  };
  const closed = o.paths.length === 1 && o.paths[0].closed;
  const rails = o.paths.filter((p) => !p.closed).length >= 2;
  const guide = r.guide ?? [];
  const satinGuide = guide.length >= 2;
  return (
    <>
      <Section title="Ripple">
        <Row label="Lines" title="How many ripples: a count, or as many as fit at a minimum distance (Ink/Stitch line count / minimum line distance)">
          <span className="dz-inline">
            <div className="seg">
              <button className={!(r.minLineDist ?? 0) ? "on" : ""} onClick={() => up({ minLineDist: 0 })}>
                Count
              </button>
              <button className={(r.minLineDist ?? 0) > 0 ? "on" : ""} onClick={() => up({ minLineDist: r.minLineDist || 2 })}>
                Distance
              </button>
            </div>
            {(r.minLineDist ?? 0) > 0 ? (
              <Num value={r.minLineDist!} step={0.25} min={0.2} max={20} unit="mm" onChange={(v) => up({ minLineDist: v })} />
            ) : (
              <Num value={r.lines} step={1} min={1} max={200} digits={0} onChange={(v) => up({ lines: Math.round(v) })} />
            )}
          </span>
        </Row>
        {closed ? (
          <Row label="Inner size" title="Size of the innermost ripple (0 = shrinks to the centre)">
            <Slider min={0} max={0.95} step={0.01} value={r.minScale} onChange={(v) => up({ minScale: v })} />
          </Row>
        ) : (
          !rails &&
          !guide.length &&
          !r.fan && (
            <Row label="Spacing" title="Distance between the copies">
              <Slider min={0.3} max={10} step={0.1} unit="mm" value={r.spacing} onChange={(v) => up({ spacing: v })} />
            </Row>
          )
        )}
        <Row label="Spread" title="Bunch the ripples towards one end (exponent above 1) or the other; Flip turns it round (Ink/Stitch exponent)">
          <span className="dz-inline">
            <Slider min={0.25} max={4} step={0.05} value={r.exponent ?? 1} onChange={(v) => up({ exponent: v })} />
            <Toggle on={!!r.flipExponent} onChange={(v) => up({ flipExponent: v })} title="Flip" />
          </span>
        </Row>
        <Row label="Skip" title="Leave out ripples at the start and the end">
          <span className="dz-inline">
            <Num value={r.skipStart ?? 0} step={1} min={0} max={50} digits={0} unit="start" onChange={(v) => up({ skipStart: Math.round(v) })} />
            <Num value={r.skipEnd ?? 0} step={1} min={0} max={50} digits={0} unit="end" onChange={(v) => up({ skipEnd: Math.round(v) })} />
          </span>
        </Row>
        <Row label="Twist" title="Rotation from the first to the last ripple">
          <Slider min={-360} max={360} step={1} digits={0} unit="°" value={r.rotation} onChange={(v) => up({ rotation: v })} />
        </Row>
        <Row label="Reverse" title="Start at the centre / far copy">
          <Toggle on={r.reverse} onChange={(v) => up({ reverse: v })} />
        </Row>
      </Section>
      {!closed && (
        <Section title="Copies" defaultOpen={!!(r.joinPoint || r.flipCopies === false || r.staggers)}>
          <Row label="Back and forth" title="Sew every other copy backwards; off: every copy the same way, joined at the ends">
            <Toggle on={r.flipCopies ?? true} onChange={(v) => up({ flipCopies: v })} />
          </Row>
          <Row label="Joins" title="Where copies meet: flat connections, or points (Ink/Stitch join style)">
            <Seg
              value={!!r.joinPoint}
              options={
                [
                  [false, "Flat"],
                  [true, "Point"],
                ] as const
              }
              onChange={(v) => up({ joinPoint: v })}
            />
          </Row>
          <Row label="Staggers" title="Needle points shifted from line to line over this many lines (0 = even stitches)">
            <Num value={r.staggers ?? 0} step={1} min={0} max={12} digits={0} onChange={(v) => up({ staggers: Math.round(v) })} />
          </Row>
          {!rails && !guide.length && (
            <Row label="Towards target" title="Without a guide: parallel copies, or copies fanned towards the target (Ink/Stitch)">
              <Seg
                value={!!r.fan}
                options={
                  [
                    [false, "Parallel"],
                    [true, "Fan"],
                  ] as const
                }
                onChange={(v) => up({ fan: v })}
              />
            </Row>
          )}
          <Row label="Manual points" title="The outline's own points are the stitches — no running stitch in between (Ink/Stitch manual pattern placement)">
            <Toggle on={!!r.manual} onChange={(v) => up({ manual: v })} />
          </Row>
        </Section>
      )}
      {!closed && !rails && (
        <Section title="Guide" defaultOpen={guide.length > 0}>
          {guide.length ? (
            <>
              <p className="hint" style={{ margin: "2px 0 6px" }}>
                {satinGuide ? "Copies are fitted between the rails of the satin guide." : "Copies follow the guide line — drag its points on the canvas."}
              </p>
              <Row label="Scale" title="Size of the first and the last copy along the guide (Ink/Stitch scale start / end)">
                <span className="dz-inline">
                  <Num value={r.scaleStart ?? 100} step={5} min={0} max={400} digits={0} unit="%" onChange={(v) => up({ scaleStart: v })} />
                  <Num value={r.scaleEnd ?? 100} step={5} min={0} max={400} digits={0} unit="%" onChange={(v) => up({ scaleEnd: v })} />
                </span>
              </Row>
              <Row label="Scale axes">
                <Seg
                  value={r.scaleAxis ?? "both"}
                  options={
                    [
                      ["both", "X Y"],
                      ["x", "X"],
                      ["y", "Y"],
                      ["none", "None"],
                    ] as const
                  }
                  onChange={(k) => up({ scaleAxis: k })}
                />
              </Row>
              <Row label="Turn with guide" title="Copies turn with the guide's direction">
                <Toggle on={r.rotateRipples ?? true} onChange={(v) => up({ rotateRipples: v })} />
              </Row>
              {satinGuide && (
                <Row label="Copies at" title="By the line count, at the satin's rungs, or as many as fit without overlapping (Ink/Stitch pattern position)">
                  <Seg
                    value={r.guidePosition ?? "lineCount"}
                    options={
                      [
                        ["lineCount", "Count"],
                        ["rungs", "Rungs"],
                        ["adaptive", "Fit"],
                      ] as const
                    }
                    onChange={(k) => up({ guidePosition: k })}
                  />
                </Row>
              )}
              <button className="btn sm ghost" onClick={() => up({ guide: undefined, anchor: undefined })}>
                Remove guide
              </button>
            </>
          ) : (
            <>
              <p className="hint" style={{ margin: "2px 0 6px" }}>
                Copies can follow a guide line or a satin column: select it together with this ripple and choose “Use as ripple guide”.
              </p>
              <button
                className="btn sm"
                onClick={() => {
                  const g = defaultRippleGuide(o);
                  if (g) up({ guide: [g], scaleStart: 100, scaleEnd: 100 });
                }}
              >
                Add a straight guide
              </button>
            </>
          )}
        </Section>
      )}
      <Section title="Grid" defaultOpen={(r.gridSize ?? 0) > 0}>
        <Row label="Grid" title="Lines across the ripples, their points this far apart — a net (Ink/Stitch grid)">
          <span className="dz-inline">
            <Toggle on={(r.gridSize ?? 0) > 0} onChange={(on) => up({ gridSize: on ? 3 : 0 })} />
            {(r.gridSize ?? 0) > 0 && <Num value={r.gridSize!} step={0.5} min={0.5} max={30} unit="mm" onChange={(v) => up({ gridSize: v })} />}
          </span>
        </Row>
        {(r.gridSize ?? 0) > 0 && (
          <Row label="Grid first" title="Sew the grid before the ripples">
            <Toggle on={!!r.gridFirst} onChange={(v) => up({ gridFirst: v })} />
          </Row>
        )}
      </Section>
      {(closed || !guide.length || r.fan) && (
        <p className="hint">
          {closed ? "Drag the target handle on the canvas to move the ripple centre." : "Drag the target handle to choose the side the copies go to."}
          {r.target && (
            <button className="btn sm ghost" onClick={() => up({ target: undefined })} style={{ marginLeft: 6 }}>
              Reset
            </button>
          )}
        </p>
      )}
    </>
  );
}
