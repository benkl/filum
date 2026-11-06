// The print sheet (Ink/Stitch "Print PDF"): client and operator views of a
// design as printable HTML pages — overview with the job details, a detailed
// page per colour, the operator's colour table with per-colour estimates and
// notes, a full-page pattern and a free information sheet. Printed from an
// iframe, so "Save as PDF" in the print dialog makes the PDF.

import { FLAG, type PlanData, type Thread } from "../types";

export type PrintView = "clientOverview" | "clientDetailed" | "operatorOverview" | "operatorDetailed" | "pattern" | "info";

export interface PrintSettings {
  /** Ink/Stitch print layouts. */
  views: Record<PrintView, boolean>;
  paper: "a4" | "letter";
  /** Pictures shaded as sewn, or as stitch lines. */
  realistic: boolean;
  /** Estimated times on the client pages too (Ink/Stitch "display time on"). */
  clientTimes: boolean;
  /** Ink/Stitch time factors: seconds added in total, per colour change, per trim. */
  timeAdditional: number;
  timeColorChange: number;
  timeTrim: number;
  /** Machine speed (stitches per minute). */
  spm: number;
  /** Operator detailed view: thumbnail size (mm, Ink/Stitch 15–110). */
  thumbnail: number;
  showFooter: boolean;
  footer: string;
  /** Logo as a data URL. */
  logo: string;
  /** Custom information sheet (plain text). */
  infoText: string;
}

export const PRINT_DEFAULTS: PrintSettings = {
  // Ink/Stitch: the operator views
  views: { clientOverview: false, clientDetailed: false, operatorOverview: true, operatorDetailed: true, pattern: false, info: false },
  paper: typeof navigator !== "undefined" && /^en-(US|CA)|^es-(MX|US)/.test(navigator.language) ? "letter" : "a4",
  realistic: true,
  clientTimes: false,
  timeAdditional: 0,
  timeColorChange: 10,
  timeTrim: 10,
  spm: 700,
  thumbnail: 20,
  showFooter: true,
  footer: "Made with Filum",
  logo: "",
  infoText: "",
};

/** The job's words: Ink/Stitch's editable fields. */
export interface PrintJob {
  title: string;
  client: string;
  purchaseOrder: string;
  /** Operator notes per colour block. */
  notes: string[];
  date: Date;
}

export interface BlockStats {
  thread: Thread;
  stitches: number;
  trims: number;
  stops: number;
  /** Top thread (m). */
  threadM: number;
}

/** Stitches, trims, stops and thread of every colour block (Ink/Stitch color_block). */
export function blockStats(plan: PlanData): BlockStats[] {
  const out: BlockStats[] = plan.threads.map((t, i) => ({ thread: t, stitches: 0, trims: 0, stops: 0, threadM: plan.stats.threadPerColorM[i] ?? 0 }));
  let k = 0;
  for (let i = 0; i < plan.flags.length; i++) {
    const f = plan.flags[i];
    if (f & FLAG.COLOR_CHANGE) {
      k++;
      continue;
    }
    const b = out[k];
    if (!b) continue;
    if (f & FLAG.TRIM) b.trims++;
    else if (f & FLAG.STOP) b.stops++;
    else if (!(f & FLAG.COMMANDS)) b.stitches++;
  }
  return out;
}

/** Seconds a colour block takes: its stitches at the machine speed, its trims (Ink/Stitch print). */
export const blockSeconds = (b: BlockStats, s: PrintSettings) => (b.stitches / Math.max(1, s.spm)) * 60 + b.trims * s.timeTrim;

/** The whole job: every block, the colour changes and the time added (Ink/Stitch print). */
export const jobSeconds = (blocks: BlockStats[], s: PrintSettings) => blocks.reduce((t, b) => t + blockSeconds(b, s), 0) + Math.max(0, blocks.length - 1) * s.timeColorChange + s.timeAdditional;

/** "1 h 05 min", "12 min 30 s". */
export function duration(sec: number): string {
  const t = Math.max(0, Math.round(sec));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  if (h) return `${h} h ${String(m).padStart(2, "0")} min`;
  if (m) return `${m} min ${String(s).padStart(2, "0")} s`;
  return `${s} s`;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const rgbOf = (hex: string) => {
  const v = parseInt(hex.replace("#", ""), 16) || 0;
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
};
/** Black or white text on a colour (Ink/Stitch font_color). */
const inkOn = (hex: string) => {
  const [r, g, b] = rgbOf(hex);
  return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? "#000" : "#fff";
};
const threadLabel = (t: Thread) => [t.brand, t.code ? `#${t.code}` : ""].filter(Boolean).join(" ");

export interface SheetInput {
  name: string;
  width: number;
  height: number;
  blocks: BlockStats[];
  /** Total thread (m): top and bobbin. */
  threadM: number;
  bobbinM: number;
  /** Trims the machine leaves uncut (lib/cuts.ts): jumps to snip by hand. */
  handTrims?: number;
  /** Data URLs: the whole design and every colour block. */
  overview: string;
  blockPictures: string[];
  /** Fabric / stabiliser / needle advice. */
  materials: [string, string][];
}

/** The print sheet as an HTML document. */
export function sheetHtml(input: SheetInput, job: PrintJob, s: PrintSettings): string {
  const { blocks } = input;
  const colours = new Set(blocks.map((b) => b.thread.color.toLowerCase())).size;
  const stops = blocks.reduce((n, b) => n + b.stops, 0);
  const trims = blocks.reduce((n, b) => n + b.trims, 0);
  const stitches = blocks.reduce((n, b) => n + b.stitches, 0);
  const total = duration(jobSeconds(blocks, s));
  const [pw, ph] = s.paper === "letter" ? [215.9, 279.4] : [210, 297];
  const date = job.date.toLocaleDateString();
  const head = `<header>
  ${s.logo ? `<img class="logo" src="${s.logo}" alt="">` : ""}
  <div class="headline">
    <h1>${esc(job.title || input.name || "Untitled")}</h1>
    ${job.client ? `<p><span>Client:</span> ${esc(job.client)}</p>` : ""}
    ${job.purchaseOrder ? `<p><span>Purchase order #:</span> ${esc(job.purchaseOrder)}</p>` : ""}
  </div>
  <div class="date">${esc(date)}</div>
</header>`;
  const details = (time: boolean) => `<div class="details">
  <dl><dt>Unique colours</dt><dd>${colours}</dd><dt>Colour blocks</dt><dd>${blocks.length}</dd><dt>Total stops</dt><dd>${stops}</dd><dt>Total trims</dt><dd>${trims}</dd>${input.handTrims ? `<dt>Snip by hand</dt><dd>${input.handTrims} jumps</dd>` : ""}</dl>
  <dl><dt>Design box size</dt><dd>${input.width.toFixed(1)} × ${input.height.toFixed(1)} mm</dd><dt>Total stitch count</dt><dd>${stitches.toLocaleString()}</dd><dt>Total thread used</dt><dd>${input.threadM.toFixed(1)} m top · ${input.bobbinM.toFixed(1)} m bobbin</dd></dl>
  ${time ? `<dl class="time"><dt>Job estimated time</dt><dd>${total}</dd><dt>Machine speed</dt><dd>${s.spm} spm</dd></dl>` : ""}
</div>`;
  const swatch = (b: BlockStats, i: number) => `<div class="swatch" style="background:${b.thread.color};color:${inkOn(b.thread.color)}">
  <b>${i + 1}. ${esc(b.thread.name)}</b>
  ${blocks.length < 13 ? `<span>rgb ${rgbOf(b.thread.color).join(", ")}</span>` : ""}
  ${threadLabel(b.thread) && blocks.length < 13 ? `<span>${esc(threadLabel(b.thread))}</span>` : ""}
  ${blocks.length < 49 ? `<span>${b.stitches.toLocaleString()} stitches</span>` : ""}
  ${blocks.length < 13 ? `<span>${b.trims} trims · ${b.stops} stops</span>` : ""}
</div>`;
  const pages: string[] = [];
  if (s.views.clientOverview)
    pages.push(`<section class="page">${head}${details(s.clientTimes)}
<figure class="big"><img src="${input.overview}" alt=""></figure>
<div class="palette">${blocks.map(swatch).join("")}</div>
<div class="signature">Client signature</div></section>`);
  if (s.views.clientDetailed)
    blocks.forEach((b, i) =>
      pages.push(`<section class="page">${head}
<div class="details"><dl><dt>Colour ${i + 1}</dt><dd>${esc(b.thread.name)}</dd><dt>rgb</dt><dd>${rgbOf(b.thread.color).join(", ")}</dd><dt>Thread</dt><dd>${esc(threadLabel(b.thread) || "—")}</dd></dl>
<dl><dt># stitches</dt><dd>${b.stitches.toLocaleString()}</dd><dt># trims</dt><dd>${b.trims}</dd><dt>Stop after?</dt><dd>${b.stops ? "yes" : "no"}</dd></dl>
${s.clientTimes ? `<dl class="time"><dt>Estimated time</dt><dd>${duration(blockSeconds(b, s))}</dd></dl>` : ""}</div>
<figure class="big"><img src="${input.blockPictures[i]}" alt=""><i class="chip" style="background:${b.thread.color}"></i></figure></section>`),
    );
  if (s.views.operatorOverview)
    pages.push(`<section class="page">${head}${details(true)}
<figure class="big"><img src="${input.overview}" alt=""></figure>
${input.materials.length ? `<dl class="materials">${input.materials.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>` : ""}</section>`);
  if (s.views.operatorDetailed) {
    const th = Math.max(10, Math.min(110, s.thumbnail));
    const rows = blocks
      .map(
        (b, i) => `<tr>
  <td class="sw" style="background:${b.thread.color};color:${inkOn(b.thread.color)}">#${i + 1}</td>
  <td class="th"><img src="${input.blockPictures[i]}" alt="" style="width:${th}mm;height:${th}mm"></td>
  <td><b>${esc(b.thread.name)}</b><span>rgb ${rgbOf(b.thread.color).join(", ")}</span><span>${esc(threadLabel(b.thread))}</span></td>
  <td><span>${b.stitches.toLocaleString()} stitches</span><span>${b.threadM.toFixed(1)} m thread</span><span>${duration(blockSeconds(b, s))}</span></td>
  <td><span>${b.trims} trims</span><span>${b.stops} stops</span></td>
  <td class="notes">${esc(job.notes[i] ?? "").replace(/\n/g, "<br>")}</td>
</tr>`,
      )
      .join("");
    pages.push(`<section class="page">${head}
<table class="opd"><thead><tr><th></th><th></th><th>Colour</th><th>Thread consumption</th><th>Stops and trims</th><th>Notes</th></tr></thead><tbody>
<tr class="sum"><td class="sw">##</td><td class="th"><img src="${input.overview}" alt="" style="width:${th}mm;height:${th}mm"></td>
<td><span>Unique colours: ${colours}</span><span>Colour blocks: ${blocks.length}</span></td>
<td><span>${input.width.toFixed(1)} × ${input.height.toFixed(1)} mm</span><span>${stitches.toLocaleString()} stitches</span><span>${total}</span></td>
<td><span>${stops} stops</span><span>${trims} trims</span></td><td></td></tr>
${rows}</tbody></table></section>`);
  }
  if (s.views.pattern) pages.push(`<section class="page pattern"><figure class="full"><img src="${input.overview}" alt=""></figure></section>`);
  if (s.views.info) pages.push(`<section class="page">${head}<div class="info">${esc(s.infoText || "").replace(/\n/g, "<br>")}</div></section>`);
  const footer = s.showFooter && s.footer ? `<footer>${esc(s.footer)}</footer>` : "";
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(job.title || input.name)}</title><style>
@page { size: ${s.paper === "letter" ? "letter" : "A4"}; margin: 12mm; }
* { box-sizing: border-box; }
html, body { margin: 0; }
body { font: 10pt/1.35 system-ui, "Segoe UI", Roboto, sans-serif; color: #222; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.page { width: ${pw - 24}mm; break-after: page; padding-bottom: 8mm; }
.page:last-of-type { break-after: auto; }
header { display: flex; align-items: flex-start; gap: 5mm; border-bottom: 0.4mm solid #222; padding-bottom: 3mm; margin-bottom: 4mm; }
.logo { max-height: 18mm; max-width: 40mm; object-fit: contain; }
.headline { flex: 1; }
h1 { margin: 0 0 1mm; font-size: 17pt; }
.headline p { margin: 0; } .headline span { color: #666; }
.date { color: #666; white-space: nowrap; }
.details { display: flex; gap: 6mm; margin-bottom: 4mm; }
.details dl, .materials { display: grid; grid-template-columns: auto auto; gap: 0.6mm 3mm; margin: 0; align-content: start; }
.details dt, .materials dt { color: #666; } .details dd, .materials dd { margin: 0; font-weight: 600; }
.details .time dd { font-size: 12pt; }
figure { margin: 0; display: flex; align-items: center; justify-content: center; position: relative; }
figure.big { height: 150mm; border: 0.3mm solid #ddd; border-radius: 2mm; margin-bottom: 4mm; }
figure.big img { max-width: 92%; max-height: 92%; object-fit: contain; }
figure .chip { position: absolute; left: 3mm; top: 3mm; width: 10mm; height: 10mm; border-radius: 1.5mm; border: 0.3mm solid #ccc; }
.pattern figure.full { height: ${ph - 34}mm; } .pattern figure.full img { max-width: 100%; max-height: 100%; object-fit: contain; }
.palette { display: grid; grid-template-columns: repeat(${blocks.length > 12 ? 6 : 4}, 1fr); gap: 2mm; }
.swatch { border-radius: 1.5mm; padding: 2mm; min-height: 14mm; display: flex; flex-direction: column; font-size: 8pt; border: 0.3mm solid #ccc; break-inside: avoid; }
.swatch b { font-size: 9pt; }
.signature { margin-top: 12mm; border-top: 0.3mm solid #222; width: 70mm; padding-top: 1mm; color: #666; }
.materials { margin-top: 2mm; }
table.opd { width: 100%; border-collapse: collapse; }
.opd th { text-align: left; font-size: 8pt; color: #666; font-weight: 600; border-bottom: 0.3mm solid #222; padding: 1mm; }
.opd td { border-bottom: 0.2mm solid #ddd; padding: 1.5mm 1mm; vertical-align: top; }
.opd tr { break-inside: avoid; }
.opd td span { display: block; } .opd td b { display: block; }
.opd .sw { width: 13mm; font-weight: 700; text-align: center; vertical-align: middle; }
.opd .sum .sw { background: #eee; }
.opd .th img { display: block; object-fit: contain; }
.opd .notes { width: 40mm; white-space: pre-wrap; }
.info { white-space: normal; font-size: 11pt; }
footer { position: fixed; bottom: 0; left: 0; right: 0; text-align: center; font-size: 8pt; color: #888; }
@media screen {
  html { background: transparent; }
  body { padding: 0; zoom: var(--zoom, 1); }
  .page { width: ${pw}mm; min-height: ${ph}mm; padding: 12mm; margin: 0 auto 8mm; background: #fff; box-shadow: 0 1mm 4mm rgba(0,0,0,.18); position: relative; break-after: auto; }
  footer { display: none; }
  .page::after { content: ${JSON.stringify(s.showFooter ? s.footer : "")}; position: absolute; bottom: 5mm; left: 0; right: 0; text-align: center; font-size: 8pt; color: #888; }
}
</style></head><body>${pages.join("\n") || `<section class="page"><p>Choose at least one layout.</p></section>`}${footer}</body></html>`;
}
