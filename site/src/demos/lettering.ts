// The lettering demo: type your own text, pick a font, a style and a thread,
// bend it into an arc. The outline fonts are the ones Filum bundles (SIL
// OFL); the satin look is an SVG pattern of angled thread.

import { shade } from "./colour";

const FONTS: Record<string, { family: string; label: string; size: number; spacing: number }> = {
  script: { family: "Pacifico", label: "Pacifico", size: 72, spacing: 0 },
  block: { family: "Bebas Neue", label: "Bebas Neue", size: 96, spacing: 2 },
  rounded: { family: "Nunito", label: "Nunito", size: 74, spacing: 0 },
};
const STYLE_LABEL: Record<string, string> = { fill: "tatami fill", satin: "satin edge", both: "fill + satin edge", outline: "triple-run outline" };

const esc = (t: string) => t.replace(/[<&]/g, (c) => (c === "<" ? "&lt;" : "&amp;"));

export function initLettering(root: HTMLElement) {
  const input = root.querySelector<HTMLInputElement>("[data-text]")!;
  const svg = root.querySelector<SVGSVGElement>("svg.lt-svg")!;
  const arc = root.querySelector<HTMLInputElement>("[data-arc]")!;
  const size = root.querySelector<HTMLInputElement>("[data-size]")!;
  const info = root.querySelector<HTMLElement>("[data-lt-info]")!;
  let font = "script", style = "fill", color = "#7c3aed";

  const seg = (name: string, set: (v: string) => void) => {
    const btns = [...root.querySelectorAll<HTMLButtonElement>(`[data-${name}]`)];
    for (const b of btns)
      b.addEventListener("click", () => {
        for (const x of btns) x.setAttribute("aria-pressed", String(x === b));
        set(b.dataset[name]!);
        draw();
      });
  };
  seg("font", (v) => (font = v));
  seg("style", (v) => (style = v));
  seg("thread", (v) => (color = v));

  function draw() {
    const f = FONTS[font];
    const text = (input.value || " ").slice(0, 22);
    const bend = +arc.value; // -100 … 100
    const scale = +size.value / 100;
    const W = 600, H = 260;
    const fs = f.size * scale;
    const cap = fs * 0.72;
    // the arc bends the text itself: at full arc the line wraps half a circle (180°),
    // like lettering on a badge (short words: no tighter than a 110 px radius)
    svg.innerHTML = `<text font-family="'${f.family}'" font-size="${fs}" letter-spacing="${f.spacing}">${esc(text)}</text>`;
    const len = Math.max(1, (svg.firstElementChild as SVGTextContentElement).getComputedTextLength());
    const theta = (Math.abs(bend) / 100) * Math.min(Math.PI, len / 110);
    let path: string;
    if (theta < 0.03) {
      const y = H / 2 + cap / 2;
      path = `M -200 ${y} L ${W + 200} ${y}`;
    } else {
      const r = len / theta;
      const drop = r * (1 - Math.cos(theta / 2)); // how far the ends fall (or rise) from the middle
      const up = bend > 0;
      const cy = up ? H / 2 + (cap - drop) / 2 : H / 2 + (cap + drop) / 2 - cap * 0.35;
      const half = Math.min(theta / 2 + 0.5, Math.PI * 0.97); // a path longer than the text
      const pt = (a: number) => `${(W / 2 + r * Math.sin(a)).toFixed(2)} ${(cy + (up ? 1 : -1) * r * (1 - Math.cos(a))).toFixed(2)}`;
      const sweep = up ? 1 : 0;
      path = `M ${pt(-half)} A ${r} ${r} 0 0 ${sweep} ${pt(0)} A ${r} ${r} 0 0 ${sweep} ${pt(half)}`;
    }
    const lit = shade(color, 0.42), dark = shade(color, -0.32), edge = shade(color, -0.45);
    const fill = style === "outline" ? "none" : style === "satin" ? shade(color, 0.86) : "url(#lt-satin)";
    const stroke = style === "fill" ? "none" : style === "outline" ? dark : "url(#lt-edge)";
    const sw = style === "outline" ? 1.6 : style === "fill" ? 0 : 4.5;
    const dash = style === "outline" ? `stroke-dasharray="4 2.2"` : "";
    svg.innerHTML = `
      <defs>
        <pattern id="lt-satin" width="3" height="3" patternUnits="userSpaceOnUse" patternTransform="rotate(-36)">
          <rect width="3" height="3" fill="${color}"/>
          <rect width="1.25" height="3" fill="${lit}" opacity="0.55"/>
          <rect x="2.6" width="0.4" height="3" fill="${dark}" opacity="0.6"/>
        </pattern>
        <pattern id="lt-edge" width="1.6" height="1.6" patternUnits="userSpaceOnUse" patternTransform="rotate(52)">
          <rect width="1.6" height="1.6" fill="${edge}"/>
          <rect width="0.7" height="1.6" fill="${shade(color, 0.1)}" opacity="0.7"/>
        </pattern>
        <filter id="lt-depth" x="-10%" y="-30%" width="120%" height="160%">
          <feDropShadow dx="0" dy="1.2" stdDeviation="0.9" flood-color="#2b1d10" flood-opacity="0.35"/>
        </filter>
        <path id="lt-path" d="${path}"/>
      </defs>
      <text font-family="'${f.family}'" font-size="${fs}" letter-spacing="${f.spacing}" text-anchor="middle"
        fill="${fill}" stroke="${stroke}" stroke-width="${sw}" stroke-linejoin="round" ${dash} paint-order="stroke" filter="url(#lt-depth)">
        <textPath href="#lt-path" startOffset="50%">${esc(text)}</textPath>
      </text>`;
    info.innerHTML = `<b>${f.label}</b> · stitched as ${STYLE_LABEL[style]} · cap height ≈ ${Math.round(18 * scale)} mm`;
    arc.style.setProperty("--p", `${(bend + 100) / 2}%`);
    size.style.setProperty("--p", `${((+size.value - 60) / 80) * 100}%`);
  }
  for (const el of [input, arc, size]) el.addEventListener("input", draw);
  document.fonts.ready.then(draw);
  draw();

  /** The guide's "Show me": types a name. */
  return {
    async run() {
      const word = "Hello, Ada";
      input.value = "";
      for (const ch of word) {
        input.value += ch;
        draw();
        await new Promise((r) => setTimeout(r, 110));
      }
    },
  };
}
