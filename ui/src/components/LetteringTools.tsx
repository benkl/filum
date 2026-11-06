// Lettering tools in the Lettering properties: batch lettering (many files
// from a list of texts), the font section (sample sheet, font info) and the
// font editor (Ink/Stitch's Edit JSON: metadata, spacing, kerning) with a
// live preview.

import { FileArchive, FileJson, LayoutGrid, PencilRuler, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { engine } from "../engine/client";
import { copyBundledFont, fontLabel, inkFontInfo, loadFont, removeInkFont, saveInkFontInfo, type EmbroideryFont } from "../lib/fonts";
import { batchTexts, FONT_INFO_DEFAULTS, fontJsonText, kerningRows, withFontInfo } from "../lib/letteringTools";
import { enc, saveFile } from "../lib/platform";
import type { TextSpec } from "../lib/text";
import { layoutText } from "../lib/textLayout";
import { batchLettering, insertFontSample, refreshLetterings, selectGroup, updateText } from "../lib/textOps";
import { makeZip } from "../lib/zip";
import { emptyDoc, useStore } from "../store";
import type { DesignObject, FormatInfo, Thread } from "../types";
import { DesignView } from "../canvas/DesignView";
import { Dialog, Num, Row, Section, Toggle } from "./ui";
import { safeSetItem } from "../lib/storage";

/** Stitch directions of Ink/Stitch font variants. */
export const VARIANT_LABELS: Record<string, { arrow: string; name: string }> = {
  ltr: { arrow: "→", name: "Left to right" },
  rtl: { arrow: "←", name: "Right to left" },
  ttb: { arrow: "↓", name: "Top to bottom" },
  btt: { arrow: "↑", name: "Bottom to top" },
};

// ---------------------------------------------------------------------------
// Batch lettering

const BATCH_KEY = "filum.batchLettering";
const QUICK_FORMATS = ["pes", "dst", "jef", "exp", "vp3", "hus", "xxx", "svg"];
const SEPARATORS: [string, string][] = [
  ["", "New line"],
  [";", "Semicolon ;"],
  [",", "Comma ,"],
  ["|", "Bar |"],
];

function loadBatch(): { text: string; separator: string; formats: string[] } {
  try {
    const v = JSON.parse(localStorage.getItem(BATCH_KEY) ?? "{}");
    return { text: v.text ?? "", separator: v.separator ?? "", formats: Array.isArray(v.formats) && v.formats.length ? v.formats : [localStorage.getItem("filum.format") ?? "pes"] };
  } catch {
    return { text: "", separator: "", formats: ["pes"] };
  }
}

/** Batch lettering (Ink/Stitch's Batch Lettering): one file per text, in a ZIP. */
export function BatchSection({ group, spec }: { group: string; spec: TextSpec }) {
  const [state, setState] = useState(loadBatch);
  const [formats, setFormats] = useState<FormatInfo[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    engine
      .formats()
      .then((f) => setFormats(f.filter((x) => x.canWrite && x.extension !== "filum" && x.extension !== "json")))
      .catch(() => {});
  }, []);
  const patch = (p: Partial<typeof state>) => {
    const next = { ...state, ...p };
    setState(next);
    safeSetItem(BATCH_KEY, JSON.stringify(next));
  };
  const texts = useMemo(() => batchTexts(state.text, state.separator), [state.text, state.separator]);
  const quick = QUICK_FORMATS.filter((e) => formats.some((f) => f.extension === e));
  const others = formats.filter((f) => !quick.includes(f.extension));
  const toggle = (ext: string) => patch({ formats: state.formats.includes(ext) ? state.formats.filter((f) => f !== ext) : [...state.formats, ext] });
  const run = async () => {
    if (!texts.length || !state.formats.length) return;
    const s = useStore.getState();
    setBusy("0");
    try {
      const { files, failed } = await batchLettering(group, texts, state.formats, (d, n) => setBusy(`${d}/${n}`));
      for (const f of failed.slice(0, 3)) s.toast(`Batch: ${f}`, "error");
      if (!files.length) return;
      const name = `${(s.doc.name || "lettering").replace(/[\\/:*?"<>|]+/g, "_")}-batch.zip`;
      const saved = await saveFile(name, makeZip(files), [{ name: "ZIP archive", extensions: ["zip"] }]);
      if (saved) s.toast(`Exported ${files.length} file${files.length === 1 ? "" : "s"} to ${name}`, "success");
    } catch (e) {
      s.toast(`Batch lettering failed: ${(e as Error).message}`, "error");
    } finally {
      setBusy(null);
    }
  };
  const total = texts.length * state.formats.length;
  return (
    <Section title="Batch lettering" defaultOpen={false}>
      <p className="hint" style={{ paddingTop: 2 }}>
        One file per text — names, numbers, team lists. Each text takes this lettering's place with its font, size, spacing, colours
        {spec.path ? " and path" : ""}; the rest of the design comes along.
      </p>
      <textarea
        className="input"
        style={{ width: "100%", height: 84, fontSize: "var(--fs-md)" }}
        placeholder={state.separator ? `Anna${state.separator}Ben${state.separator}Cleo` : "Anna\nBen\nCleo"}
        value={state.text}
        onChange={(e) => patch({ text: e.target.value })}
      />
      <Row label="Separator" title="What separates the texts. With a separator other than a new line, type \n for a line break inside a text">
        <select className="select" style={{ width: "100%" }} value={state.separator} onChange={(e) => patch({ separator: e.target.value })}>
          {SEPARATORS.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
      </Row>
      <Row label="Formats" title="Every text is exported in each of these formats">
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
          {quick.map((e) => (
            <button key={e} className={`chip ${state.formats.includes(e) ? "on" : ""}`} onClick={() => toggle(e)} title={formats.find((f) => f.extension === e)?.name}>
              {e.toUpperCase()}
            </button>
          ))}
          {state.formats
            .filter((e) => !quick.includes(e))
            .map((e) => (
              <button key={e} className="chip on" onClick={() => toggle(e)} title="Click to remove">
                {e.toUpperCase()}
              </button>
            ))}
          {others.length > 0 && (
            <select className="select" value="" onChange={(e) => e.target.value && toggle(e.target.value)} title="More formats" style={{ width: 70 }}>
              <option value="">More…</option>
              {others
                .filter((f) => !state.formats.includes(f.extension))
                .map((f) => (
                  <option key={f.extension} value={f.extension}>
                    {f.extension.toUpperCase()} · {f.name}
                  </option>
                ))}
            </select>
          )}
        </div>
      </Row>
      <button className="btn sm" style={{ width: "100%", marginTop: 6 }} disabled={!total || busy !== null} onClick={run} title="Files are named like Ink/Stitch's: 000-Anna.pes, 001-Ben.pes …">
        <FileArchive size={13} />
        {busy !== null ? ` Exporting ${busy}…` : total ? ` Export ${total} file${total === 1 ? "" : "s"} as ZIP` : " Add texts and a format"}
      </button>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Font: sample sheet and font info

/** The Font section of an embroidery-font lettering. */
export function FontSection({ group, spec, font }: { group: string; spec: TextSpec; font: EmbroideryFont | null }) {
  const [width, setWidth] = useState(() => Number(localStorage.getItem("filum.sampleWidth")) || 180);
  const [editing, setEditing] = useState<string | null>(null);
  const installed = spec.font.startsWith("inkfont:");
  const sample = async () => {
    safeSetItem("filum.sampleWidth", String(width));
    const g = await insertFontSample(spec.font, { size: spec.size, maxWidth: width, variant: spec.variant });
    if (g) {
      selectGroup(g);
      useStore.getState().toast(`Sample sheet of ${fontLabel(spec.font)}`, "success");
    } else useStore.getState().toast("This font has no glyphs to sample", "error");
  };
  const edit = async () => {
    if (installed) return setEditing(spec.font);
    // bundled fonts are read-only: edit a copy and switch this lettering to it
    useStore.getState().toast(`Copying ${fontLabel(spec.font)}…`);
    try {
      const key = await copyBundledFont(spec.font);
      await updateText(group, { font: key });
      setEditing(key);
    } catch (e) {
      useStore.getState().toast(`Could not copy the font: ${(e as Error).message}`, "error");
    }
  };
  const variants = (font?.variants ?? []).map((v) => VARIANT_LABELS[v]?.arrow ?? v).join(" ");
  return (
    <Section title="Font" defaultOpen={false}>
      <p className="hint" style={{ paddingTop: 2 }}>
        {font ? (
          <>
            {font.name} · {font.names.size} glyphs · {font.size.toFixed(0)} mm at 100 %
            {font.variants.length > 1 ? ` · directions ${variants}` : ""}
            {font.reversible ? "" : " · not reversible"}
          </>
        ) : (
          "Loading the font…"
        )}
      </p>
      <Row label="Sample width" title="Line width of the sample sheet (Ink/Stitch's Font Sampling: max. line width)">
        <Num value={width} unit="mm" step={10} min={20} max={1000} digits={0} onChange={setWidth} />
      </Row>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <button className="btn sm" onClick={sample} title="Every glyph of the font as a new lettering at this size, to check the letters, spacing and kerning">
          <LayoutGrid size={12} /> Insert sample sheet
        </button>
        <button
          className="btn sm"
          onClick={edit}
          title={installed ? "Name, description, spacing, kerning … (Ink/Stitch's font.json)" : "Bundled fonts are read-only: edit an installed copy (this lettering switches to it)"}
        >
          <PencilRuler size={12} /> {installed ? "Edit font info…" : "Edit a copy…"}
        </button>
      </div>
      {editing && createPortal(<FontInfoDialog fontKey={editing} onClose={() => setEditing(null)} />, document.body)}
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Font editor (Ink/Stitch's Edit JSON)

type Info = Record<string, unknown>;
type Tab = "info" | "settings" | "spacing" | "kerning";
const PREVIEW_THREADS: Thread[] = [{ id: "preview", name: "Preview", color: "#1f2a56", brand: "", code: "" }];

const str = (v: unknown, d = "") => (typeof v === "string" ? v : v == null ? d : String(v));
const num = (v: unknown, d: number) => (typeof v === "number" && isFinite(v) ? v : d);
const map = (v: unknown) => (v && typeof v === "object" ? (v as Record<string, number>) : {});
/** font.json as saved: keywords without empty entries. */
const cleanInfo = (info: Info): Info => (Array.isArray(info.keywords) ? { ...info, keywords: (info.keywords as string[]).filter(Boolean) } : info);

/** Adjacent letter pairs of a text (per word), for kerning. */
function textPairs(text: string): string[] {
  const out = new Set<string>();
  for (const w of text.split(/\s+/)) {
    const cs = Array.from(w);
    for (let i = 1; i < cs.length; i++) out.add(`${cs[i - 1]} ${cs[i]}`);
  }
  return [...out];
}

export function FontInfoDialog({ fontKey, onClose }: { fontKey: string; onClose: () => void }) {
  const [info, setInfo] = useState<Info | null>(null);
  const [font, setFont] = useState<EmbroideryFont | null>(null);
  const [tab, setTab] = useState<Tab>("spacing");
  const [text, setText] = useState("AVATAR Wave To\nThe quick fox");
  const [preview, setPreview] = useState<DesignObject[]>([]);
  const previewDoc = useMemo(() => ({ ...emptyDoc(), threads: PREVIEW_THREADS, objects: preview }), [preview]);
  const [filter, setFilter] = useState("");
  const [pair, setPair] = useState<[string, string]>(["", ""]);
  useEffect(() => {
    inkFontInfo(fontKey).then((i) => setInfo(i ? { ...FONT_INFO_DEFAULTS, ...i } : null));
    loadFont(fontKey).then((f) => f.kind === "embroidery" && setFont(f));
  }, [fontKey]);
  // live preview with the edited metrics
  useEffect(() => {
    if (!font || !info) return;
    let live = true;
    const f = withFontInfo(font, info);
    const t = setTimeout(() => {
      layoutText(
        { group: "preview", content: text || "Aa", font: fontKey, size: f.size, letterSpacing: 0, lineSpacing: 1, align: "left", arc: 0, rotation: 0, anchor: [0, 0], style: "fill", borderWidth: 1, fillAngle: 45, thread: "preview", borderThread: "preview" },
        f,
      )
        .then((o) => live && setPreview(o.map((x) => ({ ...x, thread: "preview" }))))
        .catch(() => {});
    }, 120);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [font, info, text, fontKey]);
  if (!info) return null;
  const set = (k: string, v: unknown) => setInfo({ ...info, [k]: v });
  const setIn = (k: "horiz_adv_x" | "kerning_pairs", key: string, v: number | null) => {
    const m = { ...map(info[k]) };
    if (v === null) delete m[key];
    else m[key] = v;
    set(k, m);
  };
  const glyphs = (Array.isArray(info.glyphs) ? (info.glyphs as string[]) : [...(font?.names ?? [])]).slice().sort();
  const q = filter.trim();
  const advDefault = info.horiz_adv_x_default == null || info.horiz_adv_x_default === "" ? null : num(info.horiz_adv_x_default, 0);
  const kern = map(info.kerning_pairs);
  const apply = async () => {
    const s = useStore.getState();
    try {
      await saveInkFontInfo(fontKey, cleanInfo(info));
      const n = await refreshLetterings(fontKey);
      s.toast(`${str(info.name, "Font")} saved${n ? ` · ${n} lettering${n === 1 ? "" : "s"} updated` : ""}`, "success");
      onClose();
    } catch (e) {
      s.toast(`Could not save the font: ${(e as Error).message}`, "error");
    }
  };
  const exportJson = async () => {
    const { glyphs: g, ...rest } = cleanInfo(info);
    const out = { ...rest, glyphs: g ?? glyphs };
    const saved = await saveFile("font.json", enc.encode(fontJsonText(out)), [{ name: "Ink/Stitch font info", extensions: ["json"] }]);
    if (saved) useStore.getState().toast("Saved font.json — put it next to the font's SVG files", "success");
  };
  const remove = async () => {
    const used = useStore.getState().doc.objects.some((o) => o.text?.font === fontKey);
    if (!confirm(`Remove ${str(info.name, "this font")} from the installed fonts?${used ? " Letterings in this design that use it can no longer be edited as text." : ""}`)) return;
    await removeInkFont(fontKey);
    useStore.getState().toast(`${fontLabel(fontKey)} removed`);
    onClose();
  };
  const field = (label: string, k: string, title?: string, area?: boolean) => (
    <label className="field" title={title}>
      <span>{label}</span>
      {area ? (
        <textarea className="input" style={{ width: "100%", height: 54 }} value={str(info[k])} onChange={(e) => set(k, e.target.value)} />
      ) : (
        <input className="input" value={str(info[k])} onChange={(e) => set(k, e.target.value)} />
      )}
    </label>
  );
  const seg = (k: string, opts: [string, string][], title?: string) => (
    <div className="seg" title={title}>
      {opts.map(([v, l]) => (
        <button key={v} className={str(info[k]) === v ? "on" : ""} onClick={() => set(k, v)}>
          {l}
        </button>
      ))}
    </div>
  );
  const kernRow = (key: string, left: string, right: string) => (
    <div key={key} className="row" style={{ gridTemplateColumns: "70px 1fr 28px" }}>
      <label className="mono" style={{ fontSize: "var(--fs-lg)" }}>
        {left} {right}
      </label>
      <Num value={kern[key] ?? kern[left + right] ?? 0} unit="px" step={0.5} digits={1} onChange={(v) => setIn("kerning_pairs", kern[key] === undefined && kern[left + right] !== undefined ? left + right : key, v || null)} />
      {kern[key] !== undefined || kern[left + right] !== undefined ? (
        <button className="icon-btn" title="Remove the pair" onClick={() => setIn("kerning_pairs", kern[key] !== undefined ? key : left + right, null)}>
          <Trash2 size={12} />
        </button>
      ) : (
        <span />
      )}
    </div>
  );
  return (
    <Dialog
      live
      wide
      title={`Font info — ${str(info.name, fontLabel(fontKey))}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={exportJson} title="Ink/Stitch's font.json with these values, for the font's folder">
            <FileJson size={13} /> Export font.json…
          </button>
          <button className="btn ghost" onClick={remove} title="Uninstall this font">
            <Trash2 size={13} /> Remove font
          </button>
          <div className="spacer" />
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={apply}>
            Apply
          </button>
        </>
      }
    >
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 300px", gap: 14 }}>
        <div>
          <div className="seg" style={{ marginBottom: 8 }}>
            {(
              [
                ["info", "Info"],
                ["settings", "Settings"],
                ["spacing", "Spacing"],
                ["kerning", "Kerning"],
              ] as const
            ).map(([v, l]) => (
              <button key={v} className={tab === v ? "on" : ""} onClick={() => setTab(v)}>
                {l}
              </button>
            ))}
          </div>
          {tab === "info" && (
            <>
              {field("Name", "name")}
              {field("Description", "description", undefined, true)}
              {field("Licence", "font_license")}
              <label className="field" title="Comma-separated: they become the font picker's filters">
                <span>Keywords</span>
                <input
                  className="input"
                  value={Array.isArray(info.keywords) ? (info.keywords as string[]).join(", ") : str(info.keywords)}
                  onChange={(e) =>
                    set(
                      "keywords",
                      e.target.value.split(",").map((k) => k.trim()).filter((k, i, a) => k || i === a.length - 1),
                    )
                  }
                />
              </label>
              {field("Original font", "original_font", "The font this embroidery font is based on")}
              {field("Original font URL", "original_font_url")}
            </>
          )}
          {tab === "settings" && (
            <>
              <Row label="Size" title="Cap height in mm at 100 % — the size the letters are digitized for">
                <Num value={num(info.size, 0)} unit="mm" step={0.5} min={0} digits={1} onChange={(v) => set("size", v)} />
              </Row>
              <Row label="Min scale" title="Smallest recommended scale (1 = 100 %)">
                <Num value={num(info.min_scale, 1)} step={0.05} min={0.05} max={10} digits={2} onChange={(v) => set("min_scale", v)} />
              </Row>
              <Row label="Max scale" title="Largest recommended scale (1 = 100 %)">
                <Num value={num(info.max_scale, 1)} step={0.05} min={0.05} max={10} digits={2} onChange={(v) => set("max_scale", v)} />
              </Row>
              <Row label="Default direction" title="The variant used unless a lettering picks another (the font's default_variant)">
                <select className="select" style={{ width: "100%" }} value={str(info.default_variant, "ltr")} onChange={(e) => set("default_variant", e.target.value)}>
                  {(font?.variants ?? ["ltr"]).map((v) => (
                    <option key={v} value={v}>
                      {VARIANT_LABELS[v]?.arrow} {VARIANT_LABELS[v]?.name ?? v}
                    </option>
                  ))}
                </select>
              </Row>
              <Row label="Text direction" title="Reading direction of the script: right to left for Hebrew, Arabic …">
                {seg("text_direction", [
                  ["ltr", "Left to right"],
                  ["rtl", "Right to left"],
                ])}
              </Row>
              <Row label="Letter case" title="Force the text to capitals or small letters (fonts with one case)">
                {seg("letter_case", [
                  ["", "As typed"],
                  ["upper", "Upper"],
                  ["lower", "Lower"],
                ])}
              </Row>
              <Row label="Default glyph" title="Shown for letters the font doesn't have; a space leaves a gap">
                <input className="input" style={{ width: 60 }} value={str(info.default_glyph, "�")} onChange={(e) => set("default_glyph", e.target.value)} />
              </Row>
              <Row label="Back and forth" title="Reversible: letterings may stitch every second line the other way round">
                <Toggle on={info.reversible !== false} onChange={(v) => set("reversible", v)} />
              </Row>
              <Row label="Colour sort" title="Sortable: multicolour letterings may sew each colour in one go">
                <Toggle on={info.sortable === true} onChange={(v) => set("sortable", v)} />
              </Row>
            </>
          )}
          {tab === "spacing" && (
            <>
              <Row label="Line height" title="Leading: distance from one baseline to the next (px, font units)">
                <Num value={num(info.leading, 100)} unit="px" step={1} digits={1} onChange={(v) => set("leading", v)} />
              </Row>
              <Row label="Space" title="Width of a space (horiz_adv_x_space, px)">
                <Num value={num(info.horiz_adv_x_space, 20)} unit="px" step={0.5} digits={1} onChange={(v) => set("horiz_adv_x_space", v)} />
              </Row>
              <Row label="Advance" title="Default horizontal advance of a glyph (px): from its origin to the next glyph's. Off: every glyph's own width">
                <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <Toggle on={advDefault !== null} onChange={(v) => set("horiz_adv_x_default", v ? 50 : null)} title="A fixed default advance instead of the glyph width" />
                  {advDefault !== null ? <Num value={advDefault} unit="px" step={0.5} digits={1} onChange={(v) => set("horiz_adv_x_default", v)} /> : <span className="hint" style={{ padding: 0 }}>Glyph width</span>}
                </div>
              </Row>
              <p className="hint">Per-glyph advances (empty: the default). Click a glyph's value to change it.</p>
              <input className="input" placeholder="Filter glyphs" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ width: "100%", marginBottom: 6 }} />
              <div style={{ maxHeight: 220, overflow: "auto", display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(130px, 1fr))", gap: "2px 10px" }}>
                {glyphs
                  .filter((g) => !q || g.includes(q))
                  .map((g) => {
                    const v = map(info.horiz_adv_x)[g];
                    return (
                      <div key={g} className="row" style={{ gridTemplateColumns: "34px 1fr" }} title={v === undefined ? "Default advance" : "Own advance — set to 0 for the default"}>
                        <label className="mono" style={{ fontSize: "var(--fs-lg)" }}>
                          {g}
                        </label>
                        <Num value={v ?? 0} unit="px" step={0.5} digits={1} onChange={(n) => setIn("horiz_adv_x", g, n || null)} />
                      </div>
                    );
                  })}
              </div>
            </>
          )}
          {tab === "kerning" && (
            <>
              <p className="hint" style={{ paddingTop: 0 }}>
                Kerning moves the right glyph of a pair closer (positive, px) or further away (negative). The preview's pairs first.
              </p>
              <div style={{ maxHeight: 150, overflow: "auto" }}>
                {textPairs(text)
                  .filter((k) => k.split(" ").every((c) => font?.names.has(c)))
                  .map((k) => {
                    const [l, r] = k.split(" ");
                    return kernRow(k, l, r);
                  })}
              </div>
              <div style={{ display: "flex", gap: 6, margin: "8px 0", alignItems: "center" }}>
                <input className="input" style={{ width: 44 }} placeholder="A" value={pair[0]} onChange={(e) => setPair([e.target.value, pair[1]])} />
                <input className="input" style={{ width: 44 }} placeholder="V" value={pair[1]} onChange={(e) => setPair([pair[0], e.target.value])} />
                <button
                  className="btn sm"
                  disabled={!pair[0] || !pair[1]}
                  onClick={() => {
                    setIn("kerning_pairs", `${pair[0]} ${pair[1]}`, kern[`${pair[0]} ${pair[1]}`] ?? 1);
                    setFilter(pair[0]);
                    setPair(["", ""]);
                  }}
                >
                  Add pair
                </button>
                <input className="input" placeholder="Filter pairs" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ flex: 1 }} />
              </div>
              <div style={{ maxHeight: 180, overflow: "auto" }}>
                {kerningRows(kern)
                  .filter((r) => !q || r.left.includes(q) || r.right.includes(q))
                  .slice(0, 400)
                  .map((r) => kernRow(r.key, r.left, r.right))}
                {!Object.keys(kern).length && <p className="hint">No kerning pairs yet.</p>}
              </div>
            </>
          )}
        </div>
        <div>
          <label className="field" title="Type pairs to check spacing and kerning">
            <span>Preview</span>
            <textarea className="input" style={{ width: "100%", height: 48 }} value={text} onChange={(e) => setText(e.target.value)} />
          </label>
          <div style={{ height: 224, borderRadius: "var(--r-md)", border: "1px solid var(--border)" }}>
            <DesignView doc={previewDoc} plan={null} mode="vector" fabricColor="#ffffff" pad={10} />
          </div>
          <p className="hint">The outlines at the font's size; Apply updates every lettering with this font.</p>
        </div>
      </div>
    </Dialog>
  );
}
