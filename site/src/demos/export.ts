// The export demo: pick a machine, the format follows, and the pre-flight check
// runs over the real design (size, colours, longest stitch, run time) with what
// that format really stores (crates/formats in Filum: colour support, the
// longest stitch the encoder writes before it splits one).

import { loadBadge } from "./editor";
import { icon } from "./icons";

type Check = [kind: "ok" | "warn", title: string, detail: string];
interface Machine {
  name: string;
  fmt: string;
  /** the format's longest stitch in mm (longer ones are split) */
  max: number;
  /** stitches a minute, for the run time */
  spm: number;
  colours: (n: number) => Check;
  extra?: (trims: number) => Check;
}
const MACHINES: Machine[] = [
  { name: "Brother · Baby Lock", fmt: "PES", max: 204.7, spm: 800, colours: (n) => ["ok", `${n} threads, by name and number`, "PES carries the design's own thread chart — the machine shows the exact threads"] },
  {
    name: "Janome · Elna", fmt: "JEF", max: 12.7, spm: 800,
    colours: (n) => ["ok", `${n} colours from the Janome table`, "JEF stores Janome thread numbers — each colour gets the closest one"],
    extra: (t) => ["warn", "No trim commands in JEF", `The ${t} trims go out as jumps — set the machine to trim on jumps`],
  },
  { name: "Tajima · commercial", fmt: "DST", max: 12.1, spm: 1000, colours: (n) => ["warn", "DST stores no thread colours", `The machine asks for ${n} colours in its own order — the colour sheet lists them`] },
  { name: "Bernina · Melco", fmt: "EXP", max: 12.7, spm: 800, colours: (n) => ["warn", "EXP stores no thread colours", `Set the ${n} needles from the colour sheet`] },
  { name: "Pfaff · Husqvarna Viking", fmt: "VP3", max: 25.5, spm: 800, colours: (n) => ["ok", `${n} threads with names and brands`, "VP3 keeps a block per colour with its thread"] },
  { name: "Singer", fmt: "XXX", max: 12.4, spm: 800, colours: (n) => ["ok", `${n} colours`, "XXX keeps the colour changes and an RGB colour table"] },
];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function initExport(root: HTMLElement) {
  const data = await loadBadge();
  const machines = root.querySelector<HTMLElement>("[data-machines]")!;
  const checks = root.querySelector<HTMLElement>("[data-checks]")!;
  const verdict = root.querySelector<HTMLElement>("[data-verdict]")!;
  const btn = root.querySelector<HTMLButtonElement>("[data-export]")!;
  const fmtEl = root.querySelector<HTMLElement>("[data-format]")!;
  let machine = 0;
  let run = 0;

  // the longest stitch in the plan (mm)
  let longest = 0;
  for (const b of data.blocks)
    for (const r of b.runs)
      for (let i = 2; i < r.length; i += 2) longest = Math.max(longest, Math.hypot(r[i] - r[i - 2], r[i + 1] - r[i - 1]) / 10);

  machines.innerHTML = MACHINES.map(
    ({ name, fmt }, i) => `<button type="button" class="mach" data-i="${i}" aria-pressed="${i === 0}"><span>${name}</span><b>${fmt}</b></button>`,
  ).join("");

  async function check() {
    const id = ++run;
    const m = MACHINES[machine];
    const ext = m.fmt.toLowerCase();
    const s = data.stats;
    // the app's run-time estimate is for 800 stitches a minute
    const minutes = Math.round((s.seconds / 60) * (800 / m.spm));
    const items: Check[] = [
      ["ok", `Fits the hoop`, `${s.width.toFixed(0)} × ${s.height.toFixed(0)} mm in ${data.hoop.w} × ${data.hoop.h} mm`],
      m.colours(data.blocks.length),
      longest <= m.max
        ? ["ok", `Longest stitch ${longest.toFixed(1)} mm`, m.max > 100 ? `${m.fmt} has no practical limit; none to split` : `Under ${m.fmt}'s ${m.max} mm — nothing to split`]
        : ["warn", `Longest stitch ${longest.toFixed(1)} mm`, `Split into stitches of at most ${m.max} mm for ${m.fmt}`],
      ...(m.extra ? [m.extra(s.trims)] : []),
      ["ok", `${s.stitches.toLocaleString("en-US")} stitches, ${s.trims} trims`, `About ${minutes} min at ${m.spm.toLocaleString("en-US")} stitches a minute`],
    ];
    fmtEl.textContent = `mountain-badge.${ext}`;
    btn.disabled = true;
    btn.classList.remove("done");
    btn.innerHTML = `${icon("download")} Export mountain-badge.${ext}`;
    verdict.className = "verdict";
    verdict.textContent = "Checking…";
    checks.innerHTML = items.map(([, t, d]: Check) => `<li class="ck pending"><i></i><span><b>${t}</b><small>${d}</small></span></li>`).join("");
    const lis = [...checks.querySelectorAll<HTMLElement>(".ck")];
    for (let i = 0; i < lis.length; i++) {
      await sleep(380);
      if (id !== run) return;
      lis[i].className = `ck ${items[i][0]}`;
      lis[i].querySelector("i")!.innerHTML = icon(items[i][0] === "ok" ? "check" : "alert");
    }
    const notes = items.filter((x) => x[0] === "warn").length;
    verdict.className = `verdict ${notes ? "warn" : "ok"}`;
    verdict.innerHTML = notes ? `${icon("check")} Ready · ${notes} note${notes > 1 ? "s" : ""}` : `${icon("check")} Ready for the machine`;
    btn.disabled = false;
  }

  machines.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>(".mach");
    if (!b) return;
    machine = +b.dataset.i!;
    for (const x of machines.querySelectorAll(".mach")) x.setAttribute("aria-pressed", String(x === b));
    check();
  });
  btn.addEventListener("click", () => {
    btn.classList.add("done");
    btn.innerHTML = `${icon("check")} Saved — in the app, that is`;
  });
  // run the check the first time the dialog comes into view
  new IntersectionObserver((es, io) => es.some((e) => e.isIntersecting) && (io.disconnect(), check()), { threshold: 0.4 }).observe(root);
  return { run: check };
}
