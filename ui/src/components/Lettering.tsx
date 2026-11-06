import { ALargeSmall, AlignCenter, AlignJustify, AlignLeft, AlignRight, Check, Download, Search, Type, Unlink } from "lucide-react";
import { LetterSpacing, TextArc } from "../icons/stitch";
import { useEffect, useMemo, useRef, useState } from "react";
import opentype from "opentype.js";
import {
  BUNDLED_OUTLINE,
  embroideryFonts,
  embroideryIndex,
  fontKind,
  fontLabel,
  importedFonts,
  importFontFile,
  importInkFont,
  lettersToFont,
  loadFont,
  systemFonts,
  systemFontsSupported,
  type EmbroideryFont,
  type FontEntry,
} from "../lib/fonts";
import { objectBoundsCached, unionBoxes } from "../lib/geometry";
import { openFile, openFolder } from "../lib/platform";
import { MACHINE_EXT } from "../lib/actions";
import { members, type TextSpec, type TextStyle } from "../lib/text";
import { lockedToast, selectedTextGroup, textLocked, updateText } from "../lib/textOps";
import { onDownloadsChange } from "../lib/downloadStore";
import { useStore } from "../store";
import type { FillParams } from "../types";
import { Dialog, Num, Row, Section, Slider, Toggle } from "./ui";
import { BatchSection, FontSection, VARIANT_LABELS } from "./LetteringTools";
import { TransformPanel } from "./TransformPanel";
import { CommandsSection } from "./CommandsSection";
import { ElementInfoSection } from "./ElementInfo";
import { safeSetItem } from "../lib/storage";

/** Reactive spec of a lettering group. */
export function useTextSpec(group: string | null): TextSpec | null {
  return useStore((s) => (group ? s.doc.objects.find((o) => o.text?.group === group)?.text ?? null : null));
}

/** Reactive "is the selection one lettering?" */
export function useSelectedTextGroup(): string | null {
  useStore((s) => s.selection);
  useStore((s) => s.doc);
  return selectedTextGroup();
}

/** The loaded embroidery font of a key (null while loading or for outline fonts). */
function useEmbroideryFont(key: string | undefined): EmbroideryFont | null {
  const [font, setFont] = useState<EmbroideryFont | null>(null);
  useEffect(() => {
    let live = true;
    setFont(null);
    if (key && fontKind(key) === "embroidery")
      loadFont(key)
        .then((f) => {
          if (live && f.kind === "embroidery") setFont(f);
        })
        .catch(() => {});
    return () => {
      live = false;
    };
  }, [key]);
  return font;
}

const STYLES: { id: TextStyle; label: string; title: string }[] = [
  { id: "fill", label: "Fill", title: "Tatami fill" },
  { id: "border", label: "Satin edge", title: "Satin column around every letter" },
  { id: "fillBorder", label: "Fill + edge", title: "Fill with a satin border on top" },
  { id: "outline", label: "Outline", title: "Triple running stitch outline" },
];

const FILL_NAMES: Partial<Record<FillParams["method"], string>> = {
  tatami: "Tatami",
  cross: "Cross stitch",
  contour: "Contour",
  spiral: "Spiral",
  meander: "Meander",
  circular: "Circular",
  guided: "Guided",
  radial: "Radial",
  stipple: "Stipple",
  curved: "Curved",
};
const LETTER_FILLS: FillParams["method"][] = ["tatami", "cross", "contour", "meander", "curved"];

/** Embroidery fonts: the letters' fill — the font's own by default. */
function LetterFill({ group, spec, fontFill }: { group: string; spec: TextSpec; fontFill?: FillParams["method"] }) {
  if (!fontFill) return null;
  const cur = spec.fill ?? "font";
  const crosses = (cur === "font" && fontFill === "cross") || cur === "cross";
  return (
    <>
      <Row label="Fill" title="The fill of the letters' filled areas: as the font is digitized, or another fill">
        <select className="select" style={{ width: "100%" }} value={cur} onChange={(e) => updateText(group, { fill: e.target.value as TextSpec["fill"] })}>
          <option value="font">Font's own · {FILL_NAMES[fontFill] ?? fontFill}</option>
          {LETTER_FILLS.filter((m) => m !== fontFill).map((m) => (
            <option key={m} value={m}>
              {FILL_NAMES[m]}
            </option>
          ))}
        </select>
      </Row>
      {crosses && cur === "font" && (
        <Row label="Crosses" title="Keep the font's cross size (more crosses on bigger letters, as Ink/Stitch) or grow the crosses with the letters (the designed pattern at every size)">
          <div className="seg">
            <button className={!spec.crossScale ? "on" : ""} onClick={() => updateText(group, { crossScale: false })}>
              Font size
            </button>
            <button className={spec.crossScale ? "on" : ""} onClick={() => updateText(group, { crossScale: true })}>
              Grow with letters
            </button>
          </div>
        </Row>
      )}
    </>
  );
}

function FontButton({ spec }: { spec: TextSpec }) {
  const [, rerender] = useState(0);
  useEffect(() => {
    embroideryIndex()
      .then(() => rerender((n) => n + 1))
      .catch(() => {});
  }, []);
  return (
    <button className="btn sm font-btn" title="Choose font" onClick={() => useStore.getState().setDialog("fonts")}>
      <Type size={13} />
      <span>{fontLabel(spec.font)}</span>
      {fontKind(spec.font) === "embroidery" && <span className="badge">stitched</span>}
    </button>
  );
}

function AlignSeg({ spec, group }: { spec: TextSpec; group: string }) {
  const icons = { left: <AlignLeft size={13} />, center: <AlignCenter size={13} />, right: <AlignRight size={13} />, block: <AlignJustify size={13} /> };
  const titles = { left: "Align left", center: "Centre", right: "Align right", block: "Block: spread every line to the width of the longest (Ink/Stitch Block)" };
  const block = spec.align === "block" || spec.align === "blockLetters";
  return (
    <div className="seg" role="group" aria-label="Alignment">
      {(["left", "center", "right", "block"] as const).map((a) => (
        <button
          key={a}
          title={titles[a]}
          className={(a === "block" ? block : spec.align === a) ? "on" : ""}
          onClick={() => !(a === "block" && block) && updateText(group, { align: a })}
        >
          {icons[a]}
        </button>
      ))}
    </div>
  );
}

/** Context bar for a selected lettering. */
export function TextBar({ group }: { group: string }) {
  const spec = useTextSpec(group);
  if (!spec) return null;
  const outline = fontKind(spec.font) === "outline";
  return (
    <div className="contextbar">
      <span className="obj-name">
        <Type size={14} />
        <span>“{spec.content.split("\n")[0]}”</span>
      </span>
      <FontButton spec={spec} />
      <label className="ctx-field" title="Cap height">
        <ALargeSmall size={14} />
        <span className="sr-only">Cap height</span>
        <Num value={spec.size} unit="mm" step={0.5} min={2} max={200} onChange={(v) => updateText(group, { size: v })} />
      </label>
      {outline && (
        <div className="seg" role="group" aria-label="Style">
          {STYLES.map((s) => (
            <button key={s.id} title={s.title} className={spec.style === s.id ? "on" : ""} onClick={() => updateText(group, { style: s.id })}>
              {s.label}
            </button>
          ))}
        </div>
      )}
      <AlignSeg spec={spec} group={group} />
      <label className="ctx-field" title="Arc (bend): positive arches up, negative dips down">
        <TextArc size={13} />
        <span className="sr-only">Arc (bend): positive arches up, negative dips down</span>
        <Num value={spec.arc} unit="°" step={5} min={-330} max={330} digits={0} onChange={(v) => updateText(group, { arc: v })} />
      </label>
      <label className="ctx-field" title="Letter spacing">
        <LetterSpacing size={13} />
        <span className="sr-only">Letter spacing</span>
        <Num value={spec.letterSpacing} unit="mm" step={0.1} min={-10} max={50} onChange={(v) => updateText(group, { letterSpacing: v })} />
      </label>
      <button className="btn sm" onClick={() => useStore.getState().set({ editingText: group })}>
        Edit text
      </button>
    </div>
  );
}

/** Properties panel section for a selected lettering. */
export function TextProperties({ group }: { group: string }) {
  const spec = useTextSpec(group);
  const doc = useStore((s) => s.doc);
  const [draft, setDraft] = useState(spec?.content ?? "");
  const typing = useRef(false);
  const emb = useEmbroideryFont(spec?.font);
  useEffect(() => {
    if (!typing.current) setDraft(spec?.content ?? "");
  }, [spec?.content]);
  if (!spec) return null;
  const outline = fontKind(spec.font) === "outline";
  // the glyph objects of this lettering (transform, commands and info act on all of them)
  const groupObjects = doc.objects.filter((o) => o.text?.group === group);
  const live = (patch: Partial<TextSpec>) => {
    // locked: refused before an (empty) undo step is taken
    if (textLocked(group)) return lockedToast();
    if (!typing.current) {
      useStore.getState().checkpoint();
      typing.current = true;
    }
    updateText(group, patch, true);
  };
  const swatches = (cur: string | undefined, pick: (id: string) => void) => (
    <div className="thread-pick">
      {doc.threads.map((t) => (
        <button key={t.id} title={t.name} className={t.id === cur ? "on" : ""} style={{ background: t.color }} onClick={() => pick(t.id)} />
      ))}
    </div>
  );
  const threadPick = (key: "thread" | "borderThread") => swatches(spec[key], (id) => updateText(group, { [key]: id }));
  const palette = spec.palette;
  const fontFill = useStore((s) => s.doc.objects.find((o) => o.text?.group === group)?.text?.fontFill);
  const range = emb ? [emb.size * emb.minScale, emb.size * emb.maxScale] : null;
  const outOfRange = !!range && range[1] > range[0] && (spec.size < range[0] * 0.98 || spec.size > range[1] * 1.02);
  const count = members(doc.objects, group).length;
  return (
    <div className="props">
      <div className="props-head">
        <Type size={15} />
        <span className="grow">Lettering</span>
        <span className="stat">{count} objects</span>
      </div>
      <Section title="Text">
        <textarea
          className="input"
          style={{ width: "100%", height: 64, fontSize: "var(--fs-lg)" }}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            if (e.target.value.trim()) live({ content: e.target.value });
          }}
          onBlur={() => {
            typing.current = false;
            setDraft(spec.content);
          }}
        />
        <Row label="Font">
          <FontButton spec={spec} />
        </Row>
        <Row label="Cap height">
          <Slider min={3} max={80} step={0.5} unit="mm" value={spec.size} onChange={(v) => updateText(group, { size: v })} />
        </Row>
        <Row label="Letter spacing">
          <Slider min={-3} max={10} step={0.1} unit="mm" value={spec.letterSpacing} onChange={(v) => updateText(group, { letterSpacing: v })} />
        </Row>
        <Row label="Word spacing" title="Extra space between words (Ink/Stitch word spacing)">
          <Slider min={-5} max={20} step={0.1} unit="mm" value={spec.wordSpacing ?? 0} onChange={(v) => updateText(group, { wordSpacing: v })} />
        </Row>
        <Row label="Line spacing">
          <Slider min={0.6} max={2.5} step={0.05} unit="×" value={spec.lineSpacing} onChange={(v) => updateText(group, { lineSpacing: v })} />
        </Row>
        <Row label="Align">
          <AlignSeg spec={spec} group={group} />
        </Row>
        {(spec.align === "block" || spec.align === "blockLetters") && (
          <Row label="One-word lines" title="Block alignment widens the gaps between words; a line of one word can keep its spacing or spread its letters (Ink/Stitch Block, letter spacing)">
            <div className="seg">
              <button className={spec.align === "block" ? "on" : ""} onClick={() => updateText(group, { align: "block" })}>
                Keep
              </button>
              <button className={spec.align === "blockLetters" ? "on" : ""} onClick={() => updateText(group, { align: "blockLetters" })}>
                Spread letters
              </button>
            </div>
          </Row>
        )}
      </Section>
      {spec.path && (
        <Section title="On a path">
          <Row label="Place" title="Where the text sits along the path">
            <div className="seg">
              {(
                [
                  ["start", "Start"],
                  ["center", "Centre"],
                  ["end", "End"],
                  ["stretch", "Stretch"],
                ] as const
              ).map(([v, l]) => (
                <button key={v} className={(spec.pathAlign ?? "center") === v ? "on" : ""} onClick={() => updateText(group, { pathAlign: v })}>
                  {l}
                </button>
              ))}
            </div>
          </Row>
          <Row label="Side" title="Letters on top of the path, or below it (the path read backwards)">
            <div className="seg">
              <button className={!spec.pathFlip ? "on" : ""} onClick={() => updateText(group, { pathFlip: false })}>
                Above
              </button>
              <button className={spec.pathFlip ? "on" : ""} onClick={() => updateText(group, { pathFlip: true })}>
                Below
              </button>
            </div>
          </Row>
          <button className="btn sm ghost" onClick={() => updateText(group, { path: undefined })} title="Back to straight text at the anchor">
            Off the path
          </button>
        </Section>
      )}
      <Section title="Shape">
        <Row label="Arc" title="Bend the text along a circle: positive arches up, negative dips down">
          <Slider min={-330} max={330} step={1} digits={0} unit="°" value={spec.arc} onChange={(v) => updateText(group, { arc: v })} />
        </Row>
        <Row label="Rotation">
          <Num value={spec.rotation} unit="°" step={5} digits={1} onChange={(v) => updateText(group, { rotation: v })} />
        </Row>
      </Section>
      <Section title="Stitches">
        {outline ? (
          <>
            <Row label="Style">
              <select className="select" style={{ width: "100%" }} value={spec.style} onChange={(e) => updateText(group, { style: e.target.value as TextStyle })}>
                {STYLES.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </select>
            </Row>
            {(spec.style === "fill" || spec.style === "fillBorder") && (
              <Row label="Fill angle">
                <Slider min={-90} max={90} step={1} digits={0} unit="°" value={spec.fillAngle} onChange={(v) => updateText(group, { fillAngle: v })} />
              </Row>
            )}
            {(spec.style === "border" || spec.style === "fillBorder") && (
              <Row label="Edge width">
                <Slider min={0.5} max={4} step={0.1} unit="mm" value={spec.borderWidth} onChange={(v) => updateText(group, { borderWidth: v })} />
              </Row>
            )}
          </>
        ) : (
          <>
          <LetterFill group={group} spec={spec} fontFill={fontFill} />
          {emb && emb.variants.length > 1 && (
            <Row label="Direction" title="The direction the letters are stitched in: the font comes digitized in several (Ink/Stitch font variants)">
              <div className="seg">
                {emb.variants.map((v) => (
                  <button
                    key={v}
                    title={`${VARIANT_LABELS[v]?.name ?? v}${v === emb.variant ? " (the font's default)" : ""}`}
                    className={(spec.variant && emb.variants.includes(spec.variant) ? spec.variant : emb.variant) === v ? "on" : ""}
                    onClick={() => updateText(group, { variant: v === emb.variant ? undefined : v })}
                  >
                    {VARIANT_LABELS[v]?.arrow ?? v}
                  </button>
                ))}
              </div>
            </Row>
          )}
          <Row
            label="Back and forth"
            title={
              emb && !emb.reversible
                ? "This font is digitized to be stitched in one direction only (font.json: reversible false)"
                : "Stitch every second line the other way round, so each line starts where the last one ended — less travel (Ink/Stitch: stitch lines of text back and forth)"
            }
          >
            {emb && !emb.reversible ? (
              <span className="hint" style={{ padding: 0 }}>
                Not for this font
              </span>
            ) : (
              <Toggle on={!!spec.backAndForth} onChange={(v) => updateText(group, { backAndForth: v })} />
            )}
          </Row>
          <Row label="Trims" title="Trim the thread after every letter, word or line (the font's own trims are always kept)">
            <div className="seg">
              {(
                [
                  ["never", "Never"],
                  ["letter", "Letters"],
                  ["word", "Words"],
                  ["line", "Lines"],
                ] as const
              ).map(([v, l]) => (
                <button key={v} className={(spec.trims ?? "never") === v ? "on" : ""} onClick={() => updateText(group, { trims: v })}>
                  {l}
                </button>
              ))}
            </div>
          </Row>
          <p className={`hint ${outOfRange ? "warn" : ""}`}>
            Pre-digitized Ink/Stitch embroidery font: every letter carries its own satin columns and underlay.
            {range &&
              (range[1] > range[0]
                ? ` Designed for ${range[0].toFixed(0)}–${range[1].toFixed(0)} mm${outOfRange ? " — outside this range stitches get too dense or too loose." : "."}`
                : ` Designed for ${range[0].toFixed(0)} mm.`)}
          </p>
          </>
        )}
        {palette && palette.length > 1 && (
          <Row label="Colour order" title="Sew each colour in one go within the whole text, each line or each word — fewer colour changes (Ink/Stitch colour sort)">
            <div className="seg">
              {(
                [
                  ["off", "As drawn"],
                  ["all", "Text"],
                  ["line", "Line"],
                  ["word", "Word"],
                ] as const
              ).map(([v, l]) => (
                <button key={v} className={(spec.colorSort ?? "off") === v ? "on" : ""} onClick={() => updateText(group, { colorSort: v })}>
                  {l}
                </button>
              ))}
            </div>
          </Row>
        )}
        {palette && palette.length > 1 ? (
          palette.map((tid, i) => (
            <Row key={i} label={`Colour ${i + 1}`}>
              {swatches(tid, (id) => {
                const next = [...palette];
                next[i] = id;
                updateText(group, { palette: next, ...(i === 0 ? { thread: id } : {}) });
              })}
            </Row>
          ))
        ) : (
          <Row label={spec.style === "fillBorder" && outline ? "Fill colour" : "Colour"}>{threadPick("thread")}</Row>
        )}
        {spec.style === "fillBorder" && outline && <Row label="Edge colour">{threadPick("borderThread")}</Row>}
      </Section>
      {!outline && <FontSection group={group} spec={spec} font={emb} />}
      <BatchSection group={group} spec={spec} />
      <Section title="Transform" defaultOpen={false}>
        <TransformPanel objects={groupObjects} />
      </Section>
      <CommandsSection objects={groupObjects} />
      <ElementInfoSection ids={groupObjects.map((o) => o.id)} />
      <div style={{ display: "flex", gap: 6, marginTop: 10 }}>
        <button className="btn sm" onClick={() => useStore.getState().set({ editingText: group })}>
          Edit on canvas
        </button>
        <button
          className="btn sm ghost"
          title="Turn into ordinary shapes (no longer editable as text)"
          onClick={() => useStore.getState().commit((d) => ({ ...d, objects: d.objects.map((o) => (o.text?.group === group ? { ...o, text: undefined } : o)) }))}
        >
          <Unlink size={12} /> Convert to shapes
        </button>
      </div>
    </div>
  );
}

/** Floating editor that appears under a lettering while typing. */
export function TextEditorOverlay() {
  const group = useStore((s) => s.editingText);
  const doc = useStore((s) => s.doc);
  const view = useStore((s) => s.view);
  const ref = useRef<HTMLTextAreaElement>(null);
  const spec = useTextSpec(group);
  const [value, setValue] = useState(spec?.content ?? "");
  const started = useRef(false);
  useEffect(() => {
    // a locked lettering can't be edited (double-click on the canvas or in Layers)
    if (group && textLocked(group)) {
      lockedToast();
      useStore.getState().set({ editingText: null });
      return;
    }
    setValue(spec?.content ?? "");
    started.current = false;
    setTimeout(() => {
      ref.current?.focus();
      ref.current?.select();
    }, 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [group]);
  if (!group || !spec) return null;
  const box = unionBoxes(members(doc.objects, group).map(objectBoundsCached)) ?? { x: spec.anchor[0], y: spec.anchor[1], w: 0, h: 0 };
  const left = view.ox + (box.x + box.w / 2) * view.scale;
  const top = view.oy + (box.y + box.h) * view.scale + 12;
  const close = () => {
    const s = useStore.getState();
    if (!value.trim() && !textLocked(group)) {
      // emptied text removes the lettering (not a locked one)
      s.commit((d) => ({ ...d, objects: d.objects.filter((o) => o.text?.group !== group) }));
    }
    s.set({ editingText: null });
  };
  return (
    <div className="text-editor" style={{ left, top }} onPointerDown={(e) => e.stopPropagation()}>
      <textarea
        ref={ref}
        value={value}
        rows={Math.min(6, value.split("\n").length)}
        placeholder="Type…"
        onChange={(e) => {
          setValue(e.target.value);
          if (!e.target.value.trim()) return;
          if (!started.current) {
            useStore.getState().checkpoint();
            started.current = true;
          }
          updateText(group, { content: e.target.value }, true);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape" || (e.key === "Enter" && (e.ctrlKey || e.metaKey))) {
            e.preventDefault();
            close();
          }
          e.stopPropagation();
        }}
        onBlur={close}
      />
      <span className="text-editor-hint">
        <Check size={11} /> Esc or click outside to finish · Enter for a new line
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Font picker

function OutlinePreview({ entry, text }: { entry: FontEntry; text: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let cancel = false;
    loadFont(entry.key)
      .then((f) => {
        if (cancel || f.kind !== "outline" || !ref.current) return;
        const c = ref.current;
        const dpr = window.devicePixelRatio || 1;
        c.width = 220 * dpr;
        c.height = 46 * dpr;
        const g = c.getContext("2d")!;
        g.clearRect(0, 0, c.width, c.height);
        const size = 30 * dpr;
        const w = f.font.getAdvanceWidth(text, size);
        const k = Math.min(1, (c.width - 12 * dpr) / w);
        const p = (f.font as opentype.Font).getPath(text, 6 * dpr, 34 * dpr, size * k);
        p.fill = "#222";
        p.draw(g);
      })
      .catch(() => {});
    return () => {
      cancel = true;
    };
  }, [entry.key, text]);
  return <canvas ref={ref} style={{ width: 220, height: 46 }} />;
}

type Tab = "embroidery" | "outline" | "system";

export function FontPickerDialog({ onClose }: { onClose: () => void }) {
  const group = selectedTextGroup();
  const spec = useTextSpec(group);
  const current = spec?.font;
  const sample = (spec?.content.split("\n")[0] || "Filum").slice(0, 16);
  const [tab, setTab] = useState<Tab>(current && fontKind(current) === "embroidery" ? "embroidery" : "outline");
  const [query, setQuery] = useState("");
  const [library, setLibrary] = useState<FontEntry[]>([]);
  const [imported, setImported] = useState<FontEntry[]>([]);
  const [system, setSystem] = useState<FontEntry[] | null>(null);
  const [tag, setTag] = useState<string | null>(null);
  useEffect(() => {
    importedFonts().then(setImported);
    const load = () =>
      embroideryFonts()
        .then(setLibrary)
        .catch(() => {});
    load();
    return onDownloadsChange(load);
  }, []);
  // the most common keywords as quick filters
  const tags = useMemo(() => {
    const n = new Map<string, number>();
    for (const f of library) for (const k of f.keywords ?? []) n.set(k, (n.get(k) ?? 0) + 1);
    return [...n.entries()]
      .filter(([, c]) => c >= 3)
      .sort((x, y) => y[1] - x[1])
      .slice(0, 18)
      .map(([k]) => k);
  }, [library]);
  const list = useMemo(() => {
    // installed Ink/Stitch fonts (imported, copies, made from letters) first among the embroidery fonts
    const installed = imported.filter((f) => f.kind === "embroidery");
    let all = tab === "embroidery" ? [...installed, ...library] : tab === "outline" ? [...BUNDLED_OUTLINE, ...imported.filter((f) => f.kind === "outline")] : system ?? [];
    if (tab === "embroidery" && tag) all = all.filter((f) => f.keywords?.includes(tag));
    const q = query.trim().toLowerCase();
    return q
      ? all.filter(
          (f) =>
            f.name.toLowerCase().includes(q) ||
            f.description?.toLowerCase().includes(q) ||
            f.keywords?.some((k) => k.toLowerCase().includes(q)) ||
            f.original?.toLowerCase().includes(q),
        )
      : all;
  }, [tab, library, imported, system, query, tag]);

  const choose = async (key: string) => {
    const entry = library.find((f) => f.key === key);
    if (entry?.download && !entry.installed) {
      // not included: its licence is accepted and the font downloaded in Preferences
      onClose();
      useStore.getState().openSettings("downloads");
      return;
    }
    if (group) {
      useStore.getState().toast(`Loading ${fontLabel(key)}…`);
      await updateText(group, { font: key });
    } else {
      const d = JSON.parse(localStorage.getItem("filum.textDefaults") ?? "{}");
      safeSetItem("filum.textDefaults", JSON.stringify({ ...d, font: key }));
      useStore.getState().toast(`${fontLabel(key)} will be used for new text`);
    }
    onClose();
  };
  const importInk = async () => {
    const files = await openFolder();
    if (!files) return;
    try {
      const key = await importInkFont(files);
      setImported(await importedFonts());
      setTab("embroidery");
      await choose(key);
    } catch (e) {
      useStore.getState().toast(`Not an Ink/Stitch font: ${(e as Error).message}`, "error");
    }
  };
  const fromLetters = async () => {
    const files = await openFolder([...MACHINE_EXT, "svg"]);
    if (!files) return;
    const s = useStore.getState();
    s.toast("Making a font from the letter files…");
    try {
      const { key, letters } = await lettersToFont(files);
      setImported(await importedFonts());
      setTab("embroidery");
      await choose(key);
      useStore.getState().toast(`${fontLabel(key)}: ${letters} letters — fine-tune spacing and kerning in Lettering → Font → Edit font info`, "success");
    } catch (e) {
      s.toast(`Letters to font: ${(e as Error).message}`, "error");
    }
  };
  const importFont = async () => {
    const f = await openFile([{ name: "Fonts", extensions: ["ttf", "otf"] }]);
    if (!f) return;
    try {
      const key = await importFontFile(f.name, f.bytes);
      setImported(await importedFonts());
      setTab("outline");
      await choose(key);
    } catch (e) {
      useStore.getState().toast(`Not a usable font: ${(e as Error).message}`, "error");
    }
  };

  return (
    <Dialog
      live
      wide
      title="Fonts"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={importFont}>
            Import TTF / OTF…
          </button>
          <button className="btn" onClick={importInk} title="A folder with font.json and the font's Inkscape files (ltr.svg / →.svg, and the other directions if it has them), as in Ink/Stitch's fonts folder">
            Import Ink/Stitch font…
          </button>
          <button
            className="btn"
            onClick={fromLetters}
            title="Letters to font: a folder of embroidery files (PES, DST, JEF … or SVG), one letter each, the letter at the end of the name — Font_A.pes, Font_B.pes …"
          >
            Letters to font…
          </button>
          <div className="spacer" />
          <button className="btn" onClick={onClose}>
            Close
          </button>
        </>
      }
    >
      <div className="font-tabs">
        <div className="seg">
          <button className={tab === "embroidery" ? "on" : ""} onClick={() => setTab("embroidery")}>
            Embroidery fonts ({library.length})
          </button>
          <button className={tab === "outline" ? "on" : ""} onClick={() => setTab("outline")}>
            Outline fonts
          </button>
          <button
            className={tab === "system" ? "on" : ""}
            onClick={async () => {
              setTab("system");
              if (system === null) {
                try {
                  setSystem(await systemFonts());
                } catch {
                  setSystem([]);
                }
              }
            }}
          >
            System fonts
          </button>
        </div>
        <label className="ctx-field" style={{ flex: 1 }}>
          <Search size={13} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search fonts" style={{ width: "100%", textAlign: "left" }} />
        </label>
      </div>
      <p className="hint" style={{ padding: "6px 2px" }}>
        {tab === "embroidery" &&
          "The Ink/Stitch community collection, bundled for offline use: every letter is hand-digitized with satin columns and underlay. Each font has its own licence (Help → Licences). Fonts marked optional download aren't included because of their licence: click one to download them in Preferences → Downloads."}
        {tab === "outline" && "Regular fonts, stitched as fill, satin edge, fill + edge or outline."}
        {tab === "system" && (systemFontsSupported() ? "Fonts installed on this computer (the browser asks for permission once)." : "This browser can't list system fonts — import a TTF/OTF file instead.")}
      </p>
      {tab === "embroidery" && tags.length > 0 && (
        <div className="font-tags">
          {tags.map((t) => (
            <button key={t} className={`chip ${tag === t ? "on" : ""}`} onClick={() => setTag(tag === t ? null : t)}>
              {t}
            </button>
          ))}
        </div>
      )}
      <div className="font-grid">
        {list.map((f) => (
          <button
            key={f.key}
            className={`font-card ${f.key === current ? "on" : ""} ${f.download && !f.installed ? "to-download" : ""}`}
            onClick={() => choose(f.key)}
            title={
              f.download && !f.installed
                ? `Optional download (${f.license}): Preferences → Downloads`
                : [f.description, f.original && `Based on ${f.original}`, f.license].filter(Boolean).join("\n") || f.name
            }
          >
            <div className="font-preview">
              {f.download && !f.installed ? (
                <span className="font-dl">
                  <Download size={16} />
                  Optional download
                </span>
              ) : f.kind === "embroidery" && f.preview ? (
                <img src={f.preview} alt="" loading="lazy" />
              ) : f.kind === "embroidery" ? (
                <span style={{ fontSize: "var(--fs-md)", color: "var(--muted)" }}>Installed font</span>
              ) : f.source === "system" ? (
                <span style={{ fontFamily: `"${f.description}", sans-serif`, fontSize: 24 }}>{sample}</span>
              ) : (
                <OutlinePreview entry={f} text={sample} />
              )}
            </div>
            <b>{f.name}</b>
            {f.description && f.source !== "system" && <span className="font-desc">{f.description}</span>}
            {f.kind === "embroidery" && !!f.size && (
              <span className="font-meta">
                {f.minScale && f.maxScale && f.maxScale > f.minScale
                  ? `${(f.size * f.minScale).toFixed(0)}–${(f.size * f.maxScale).toFixed(0)} mm`
                  : `${f.size.toFixed(0)} mm`}
                {" · "}
                {f.glyphs} glyphs{f.direction === "rtl" ? " · RTL" : ""}
              </span>
            )}
            {f.kind === "embroidery" && f.license && (/\bNC\b/.test(f.license) || /non.?commercial/i.test(f.license)) && (
              <span className="font-meta warn" title={f.license}>
                Non-commercial licence
              </span>
            )}
          </button>
        ))}
        {!list.length && <p className="hint">{tab === "system" && system === null ? "Loading…" : "No fonts found."}</p>}
      </div>
    </Dialog>
  );
}
