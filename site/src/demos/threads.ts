// The thread demo: the badge's threads, three real thread charts (Ink/Stitch's
// charts, as bundled in Filum) and "Fit to chart" with CIEDE2000, the same
// matching the app uses. The badge preview recolours as the threads change.

import { deltaE, lab } from "./colour";
import { loadBadge } from "./editor";

interface Charts {
  charts: { name: string; entries: [string, string, string][] }[];
}
const deltaLabel = (d: number) => (d < 1 ? "invisible" : d < 3 ? "barely visible" : d < 6 ? "close" : "noticeable");

export async function initThreads(root: HTMLElement) {
  const [badge, charts] = await Promise.all([loadBadge(), fetch("./data/charts.json").then((r) => r.json() as Promise<Charts>)]);
  const preview = root.querySelector<SVGSVGElement>("svg.th-badge")!;
  const rows = root.querySelector<HTMLElement>("[data-th-rows]")!;
  const grid = root.querySelector<HTMLElement>("[data-th-grid]")!;
  const search = root.querySelector<HTMLInputElement>("[data-th-search]")!;
  const fitBtn = root.querySelector<HTMLButtonElement>("[data-th-fit]")!;
  const resetBtn = root.querySelector<HTMLButtonElement>("[data-th-reset]")!;
  const chartBtns = [...root.querySelectorAll<HTMLButtonElement>("[data-chart]")];
  const summary = root.querySelector<HTMLElement>("[data-th-summary]")!;

  const original = badge.threads.map((t) => ({ ...t }));
  let current = original.map((t) => ({ name: t.name, code: "", color: t.color, d: null as number | null }));
  let chart = 0;
  let selected = 0;

  preview.setAttribute("viewBox", `4 4 ${badge.hoop.w - 8} ${badge.hoop.h - 8}`);
  function drawBadge() {
    preview.innerHTML = badge.objects
      .map((o) => {
        const c = current[o.thread].color;
        // fills and two-rail satins are areas (the column between the rails), as in the app
        return o.type === "fill" || (o.type === "satin" && (o.d.match(/M/g) ?? []).length === 2)
          ? `<path d="${o.d}" fill="${c}" fill-rule="evenodd"/>`
          : `<path d="${o.d}" fill="none" stroke="${c}" stroke-width="${o.type === "satin" ? o.width ?? 3 : 0.6}" stroke-linecap="round" stroke-linejoin="round"/>`;
      })
      .join("");
  }

  function drawRows() {
    rows.innerHTML = current
      .map(
        (t, i) => `<li class="th-row" data-i="${i}" aria-selected="${i === selected}">
          <i class="sw big" style="--c:${t.color}"></i>
          <span class="th-name"><b>${t.name}</b><small>${t.code ? `${charts.charts[chart].name} ${t.code}` : t.color.toUpperCase()}</small></span>
          ${t.d === null ? "" : `<span class="de ${t.d < 3 ? "ok" : "warn"}" title="${deltaLabel(t.d)}">ΔE ${t.d.toFixed(1)}</span>`}
        </li>`,
      )
      .join("");
  }

  function drawGrid() {
    const q = search.value.trim().toLowerCase();
    const list = charts.charts[chart].entries.filter(([n, c, h]) => !q || n.toLowerCase().includes(q) || c.includes(q) || h.includes(q));
    grid.innerHTML = list
      .slice(0, 240)
      .map(([n, c, h]) => `<button type="button" class="chip-sw" style="--c:${h}" title="${n} ${c}" data-name="${n}" data-code="${c}" data-hex="${h}"></button>`)
      .join("");
  }

  function fit() {
    const entries = charts.charts[chart].entries.map(([n, c, h]) => ({ n, c, h, L: lab(h) }));
    current = original.map((t) => {
      const L = lab(t.color);
      let best = entries[0], bd = Infinity;
      for (const e of entries) {
        const d = deltaE(L, e.L);
        if (d < bd) [bd, best] = [d, e];
      }
      return { name: best.n, code: best.c, color: best.h, d: bd };
    });
    const avg = current.reduce((s, t) => s + (t.d ?? 0), 0) / current.length;
    summary.innerHTML = `Fitted to <b>${charts.charts[chart].name}</b> · average ΔE <b>${avg.toFixed(1)}</b> (${deltaLabel(avg)})`;
    root.classList.remove("fitted");
    void root.offsetWidth;
    root.classList.add("fitted");
    drawRows();
    drawBadge();
  }

  function reset() {
    current = original.map((t) => ({ name: t.name, code: "", color: t.color, d: null }));
    summary.innerHTML = `The badge's own colours · pick a chart and fit, or click a thread, then a colour`;
    drawRows();
    drawBadge();
  }

  chartBtns.forEach((b, i) =>
    b.addEventListener("click", () => {
      chart = i;
      for (const x of chartBtns) x.setAttribute("aria-pressed", String(x === b));
      fitBtn.textContent = `Fit to ${charts.charts[i].name}`;
      drawGrid();
    }),
  );
  rows.addEventListener("click", (e) => {
    const r = (e.target as HTMLElement).closest<HTMLElement>(".th-row");
    if (!r) return;
    selected = +r.dataset.i!;
    drawRows();
  });
  grid.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>(".chip-sw");
    if (!b) return;
    const d = deltaE(lab(original[selected].color), lab(b.dataset.hex!));
    current[selected] = { name: b.dataset.name!, code: b.dataset.code!, color: b.dataset.hex!, d };
    drawRows();
    drawBadge();
  });
  search.addEventListener("input", drawGrid);
  fitBtn.addEventListener("click", fit);
  resetBtn.addEventListener("click", reset);
  fitBtn.textContent = `Fit to ${charts.charts[0].name}`;
  reset();
  drawGrid();
  return { run: fit };
}
