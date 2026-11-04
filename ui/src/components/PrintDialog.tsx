// Print / PDF (Ink/Stitch "Print PDF"): client and operator views of the
// design with the job's details, per-colour estimates and notes, previewed
// page by page and printed from an iframe — "Save as PDF" in the system print
// dialog makes the PDF. Layout, branding and time factors are kept as defaults.

import { FileImage, Printer } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { blockPlan, renderPicture } from "../lib/planImage";
import { fabricInfo, threadWeightInfo } from "../lib/materials";
import { openFile } from "../lib/platform";
import { blockStats, duration, jobSeconds, PRINT_DEFAULTS, sheetHtml, type PrintSettings, type PrintView } from "../lib/printSheet";
import { useStore } from "../store";
import { Dialog, Num, Row, Section, Toggle } from "./ui";
import "../output.css";

const KEY = "filum.print";
const VIEWS: [PrintView, string, string][] = [
  ["clientOverview", "Client overview", "The design, its colours and a line for the client's signature"],
  ["clientDetailed", "Client detailed view", "A page per colour"],
  ["operatorOverview", "Operator overview", "Job details, estimated time, fabric and stabiliser"],
  ["operatorDetailed", "Operator detailed view", "Every colour block with thread, stitches, time, trims, stops and your notes"],
  ["pattern", "Full page pattern", "The design as large as the page"],
  ["info", "Information sheet", "A page of your own text (care instructions, contact, …)"],
];

function loadSettings(): PrintSettings {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return { ...PRINT_DEFAULTS, ...v, views: { ...PRINT_DEFAULTS.views, ...(v.views ?? {}) } };
  } catch {
    return PRINT_DEFAULTS;
  }
}

/** Keep everything but the machine speed and time factors, which come from the design's machine. */
function saveSettings(s: PrintSettings) {
  const { spm: _a, timeTrim: _b, timeColorChange: _c, ...rest } = s;
  void _a;
  void _b;
  void _c;
  try {
    localStorage.setItem(KEY, JSON.stringify(rest));
  } catch {
    /* a large logo may not fit */
  }
}

export function PrintDialog({ onClose }: { onClose: () => void }) {
  const doc = useStore((s) => s.doc);
  const plan = useStore((s) => s.plan);
  const fabricColor = useStore((s) => s.fabricColor);
  const [s, setS] = useState<PrintSettings>(() => ({
    ...loadSettings(),
    spm: doc.machine.spm,
    timeTrim: doc.machine.trimSeconds,
    timeColorChange: doc.machine.colorChangeSeconds,
  }));
  const machine = (p: Partial<typeof doc.machine>) => useStore.getState().commit((d) => ({ ...d, machine: { ...d.machine, ...p } }));
  const [title, setTitle] = useState(doc.name || "");
  const [client, setClient] = useState("");
  const [po, setPo] = useState("");
  const [notes, setNotes] = useState<string[]>([]);
  const frame = useRef<HTMLIFrameElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const set = (p: Partial<PrintSettings>) =>
    setS((x) => {
      const n = { ...x, ...p };
      saveSettings(n);
      return n;
    });

  const blocks = useMemo(() => (plan ? blockStats(plan) : []), [plan]);
  // pictures: the whole design and every colour block on its own
  const pictures = useMemo(() => {
    if (!plan || !plan.flags.length) return null;
    const opts = { kind: s.realistic ? ("realistic" as const) : ("simple" as const), lineWidth: 0.3, background: "transparent" as const, fabricColor, threadWeight: doc.options?.threadWeight, maxSide: 1800 };
    const url = (p: typeof plan, dpi: number) => renderPicture(p, { ...opts, dpi }).toDataURL("image/png");
    const big = Math.max(plan.stats.width, plan.stats.height, 1);
    return {
      overview: url(plan, Math.min(300, (1600 / big) * 25.4)),
      blocks: plan.threads.map((_, i) => url(blockPlan(plan, i), Math.min(200, (700 / big) * 25.4))),
    };
  }, [plan, s.realistic, fabricColor, doc.options?.threadWeight]);

  const html = useMemo(() => {
    if (!plan || !pictures) return "";
    const fabric = fabricInfo(doc.fabric);
    const weight = threadWeightInfo(doc.options?.threadWeight);
    return sheetHtml(
      {
        name: doc.name,
        width: plan.stats.width,
        height: plan.stats.height,
        blocks,
        threadM: plan.stats.threadM,
        bobbinM: plan.stats.bobbinM,
        overview: pictures.overview,
        blockPictures: pictures.blocks,
        materials: [
          ["Hoop", doc.hoop.name],
          ["Fabric", fabric.label],
          ["Backing", fabric.backing],
          ["Topping", fabric.topping],
          ["Thread", `No. ${weight.weight}`],
          ["Needle", fabric.needle + (weight.weight !== 40 ? ` · thread: ${weight.needle}` : "")],
        ],
      },
      { title, client, purchaseOrder: po, notes, date: new Date() },
      s,
    );
  }, [plan, pictures, blocks, doc.name, doc.fabric, doc.hoop.name, doc.options?.threadWeight, title, client, po, notes, s]);

  // the preview: pages zoomed to the box width, the frame as tall as its pages
  useEffect(() => {
    const f = frame.current;
    if (!f) return;
    const fit = () => {
      const d = f.contentDocument;
      if (!d?.body || !box.current) return;
      const pagePx = ((s.paper === "letter" ? 215.9 : 210) / 25.4) * 96;
      const zoom = Math.min(1, (box.current.clientWidth - 32) / pagePx);
      d.documentElement.style.setProperty("--zoom", String(zoom));
      f.style.height = `${Math.ceil(d.documentElement.scrollHeight) + 4}px`;
    };
    f.onload = fit;
    f.srcdoc = html;
  }, [html, s.paper]);

  const print = () => {
    const w = frame.current?.contentWindow;
    if (!w) return;
    w.focus();
    w.print();
  };
  const pickLogo = async () => {
    const f = await openFile([{ name: "Pictures", extensions: ["png", "jpg", "jpeg", "svg", "webp", "gif"] }]);
    if (!f) return;
    const ext = f.name.split(".").pop()?.toLowerCase();
    const type = ext === "svg" ? "image/svg+xml" : ext === "jpg" ? "image/jpeg" : `image/${ext}`;
    const url = await new Promise<string>((res) => {
      const r = new FileReader();
      r.onload = () => res(String(r.result));
      r.readAsDataURL(new Blob([f.bytes as BlobPart], { type }));
    });
    set({ logo: url });
  };
  if (!plan) return null;
  const pages = VIEWS.filter(([v]) => s.views[v]).length;

  return (
    <Dialog
      live
      xwide
      title={`Print — ${doc.name || "design"}`}
      onClose={onClose}
      footer={
        <>
          <span className="stat">
            {blocks.length} colour block{blocks.length === 1 ? "" : "s"} · {duration(jobSeconds(blocks, s))} at {s.spm} spm
          </span>
          <div className="spacer" />
          <button className="btn" onClick={onClose}>
            Close
          </button>
          <button className="btn primary" disabled={!pages || !html} onClick={print} title="Opens the print dialog — choose “Save as PDF” there for a PDF">
            <Printer size={14} /> Print / Save as PDF
          </button>
        </>
      }
    >
      <div className="pr">
        <div className="pr-side">
          <Section title="Layouts">
            {VIEWS.map(([v, l, hint]) => (
              <label key={v} className="check" title={hint}>
                <input type="checkbox" checked={s.views[v]} onChange={(e) => set({ views: { ...s.views, [v]: e.target.checked } })} />
                {l}
              </label>
            ))}
            <Row label="Paper">
              <div className="seg">
                <button className={s.paper === "a4" ? "on" : ""} onClick={() => set({ paper: "a4" })}>
                  A4
                </button>
                <button className={s.paper === "letter" ? "on" : ""} onClick={() => set({ paper: "letter" })}>
                  Letter
                </button>
              </div>
            </Row>
            <Row label="Pictures" title="Realistic: as sewn · Stitches: every stitch as a line">
              <div className="seg">
                <button className={s.realistic ? "on" : ""} onClick={() => set({ realistic: true })}>
                  Realistic
                </button>
                <button className={!s.realistic ? "on" : ""} onClick={() => set({ realistic: false })}>
                  Stitches
                </button>
              </div>
            </Row>
            {s.views.operatorDetailed && (
              <Row label="Thumbnails" title="Size of the colour pictures in the operator detailed view (Ink/Stitch 15–110 mm)">
                <Num value={s.thumbnail} unit="mm" step={5} min={10} max={110} digits={0} onChange={(v) => set({ thumbnail: v })} />
              </Row>
            )}
          </Section>
          <Section title="Job">
            <label className="pr-field">
              <span className="stat">Title</span>
              <input className="input" value={title} placeholder={doc.name || "Job title"} onChange={(e) => setTitle(e.target.value)} />
            </label>
            <label className="pr-field">
              <span className="stat">Client</span>
              <input className="input" value={client} placeholder="Client name" onChange={(e) => setClient(e.target.value)} />
            </label>
            <label className="pr-field">
              <span className="stat">Purchase order #</span>
              <input className="input" value={po} onChange={(e) => setPo(e.target.value)} />
            </label>
          </Section>
          {s.views.operatorDetailed && (
            <Section title="Operator notes" defaultOpen={false}>
              {blocks.map((b, i) => (
                <label key={i} className="pr-note">
                  <i style={{ background: b.thread.color }} />
                  <input
                    className="input"
                    value={notes[i] ?? ""}
                    placeholder={`${i + 1}. ${b.thread.name}`}
                    onChange={(e) => setNotes((n) => Object.assign([...n], { [i]: e.target.value }))}
                  />
                </label>
              ))}
            </Section>
          )}
          <Section title="Estimated time" defaultOpen={false}>
            {/* the design's own values (Design ▸ Time estimates): one place, saved with the design */}
            <Row label="Speed" title="Stitches per minute — saved with the design (Design ▸ Time estimates)">
              <Num value={s.spm} unit="spm" step={50} min={100} max={2000} digits={0} onChange={(v) => (set({ spm: v }), machine({ spm: v }))} />
            </Row>
            <Row label="Trim time" title="Seconds for every trim — saved with the design">
              <Num value={s.timeTrim} unit="s" step={1} min={0} max={120} digits={0} onChange={(v) => (set({ timeTrim: v }), machine({ trimSeconds: v }))} />
            </Row>
            <Row label="Colour change" title="Seconds for every colour change — saved with the design">
              <Num value={s.timeColorChange} unit="s" step={1} min={0} max={600} digits={0} onChange={(v) => (set({ timeColorChange: v }), machine({ colorChangeSeconds: v }))} />
            </Row>
            <Row label="Add to total" title="Preparing the machine, thread breaks, bobbin changes…">
              <Num value={s.timeAdditional} unit="s" step={30} min={0} max={36000} digits={0} onChange={(v) => set({ timeAdditional: v })} />
            </Row>
            <Row label="Client pages" title="Show the estimated time on the client pages too">
              <Toggle on={s.clientTimes} onChange={(v) => set({ clientTimes: v })} />
            </Row>
          </Section>
          <Section title="Branding" defaultOpen={false}>
            <Row label="Logo">
              <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
                {s.logo && <img src={s.logo} alt="" style={{ maxHeight: 24, maxWidth: 70 }} />}
                <button className="btn sm" onClick={pickLogo}>
                  <FileImage size={12} /> Choose…
                </button>
                {s.logo && (
                  <button className="btn sm ghost" onClick={() => set({ logo: "" })}>
                    Remove
                  </button>
                )}
              </span>
            </Row>
            <Row label="Footer">
              <Toggle on={s.showFooter} onChange={(v) => set({ showFooter: v })} />
            </Row>
            {s.showFooter && <input className="input" value={s.footer} onChange={(e) => set({ footer: e.target.value })} placeholder="Contact, website…" />}
            {s.views.info && (
              <>
                <span className="stat">Information sheet</span>
                <textarea className="input" value={s.infoText} onChange={(e) => set({ infoText: e.target.value })} placeholder="Care instructions, terms, contact…" />
              </>
            )}
          </Section>
        </div>
        <div className="pr-preview" ref={box}>
          <iframe ref={frame} title="Print preview" />
        </div>
      </div>
    </Dialog>
  );
}
