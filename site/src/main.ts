import "@fontsource-variable/inter";
import "./style.css";
import { hydrateIcons } from "./demos/icons";

const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
const $ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector<T>(sel)!;
const $$ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) => [...root.querySelectorAll<T>(sel)];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

hydrateIcons();

// ---------------------------------------------------------------------------
// Scroll reveals

const reveal = new IntersectionObserver(
  (es) =>
    es.forEach((e) => {
      if (!e.isIntersecting) return;
      e.target.classList.add("in");
      reveal.unobserve(e.target);
    }),
  { threshold: 0.12, rootMargin: "0px 0px -6% 0px" },
);
$$(".reveal").forEach((el, i) => {
  (el as HTMLElement).style.setProperty("--d", `${(i % 3) * 70}ms`);
  reveal.observe(el);
});

// ---------------------------------------------------------------------------
// The opener: sews once and stays on the finished design (reduced motion: the still)

const opener = $<HTMLVideoElement>("video.opener");
const replayBtn = $<HTMLButtonElement>("[data-opener-replay]");
// two films: 16:9 beside the headline, 3:4 above it on phones (each with its poster)
const phone = matchMedia("(max-width: 700px), (max-aspect-ratio: 4/5)"); // as in style.css
function pickFilm() {
  const base = opener.dataset[phone.matches ? "mobile" : "desktop"]!;
  if (opener.dataset.film === base) return;
  opener.dataset.film = base;
  opener.poster = base.replace("opener", "hero-badge") + ".webp";
  opener.innerHTML = `<source src="${base}.webm" type="video/webm" /><source src="${base}.mp4" type="video/mp4" />`;
  opener.load();
  if (!reduced) opener.play().catch(() => (replayBtn.hidden = false));
}
pickFilm();
phone.addEventListener("change", pickFilm);
if (!reduced) {
  opener.addEventListener("ended", () => (replayBtn.hidden = false));
} else replayBtn.hidden = false;

// ---------------------------------------------------------------------------
// The job ticket on the hero counts the stitches as the film sews them (the film's
// stitch-out follows blender/hero_opener.py: 150 sewing frames, eased, at 30 fps)

const ticketCount = $("[data-ticket-count]");
const ticketBar = $("[data-ticket-bar]");
const TOTAL = 13466, SEW = 150, FPS = 30;
const easeSew = (t: number) => t * t * (3 - 2 * t);
function tick() {
  const f = opener.currentTime * FPS + 1;
  const k = easeSew(Math.min(1, Math.max(0, (f - 1) / (SEW - 1))));
  ticketCount.textContent = Math.round(TOTAL * k).toLocaleString("en-US");
  ticketBar.style.setProperty("--p", `${(k * 100).toFixed(1)}%`);
  if (!opener.paused && !opener.ended) requestAnimationFrame(tick);
}
if (!reduced) opener.addEventListener("play", () => requestAnimationFrame(tick));

// ---------------------------------------------------------------------------
// The seam: on wide screens a running stitch sews itself down the left margin as you
// scroll, through a small tag for each section (its woven label's number)

const SVGNS = "http://www.w3.org/2000/svg";
const mainEl = $("main");
const seam = document.createElementNS(SVGNS, "svg");
seam.classList.add("seam");
seam.setAttribute("aria-hidden", "true");
seam.innerHTML = `<defs><mask id="seam-mask" maskUnits="userSpaceOnUse"><path class="reveal-mask" /></mask></defs><path class="thread" mask="url(#seam-mask)" />`;
mainEl.style.position = "relative";
mainEl.prepend(seam);
const seamThread = $<SVGPathElement>("path.thread", seam);
const seamMask = $<SVGPathElement>("path.reveal-mask", seam);
let seamLen = 0, seamTop = 0, seamBottom = 0;
let seamTags: { el: HTMLElement; y: number }[] = [];

function layoutSeam() {
  for (const t of seamTags) t.el.remove();
  seamTags = [];
  if (!matchMedia("(min-width: 1500px)").matches) return;
  const box = mainEl.getBoundingClientRect();
  const W = box.width, top = box.top + scrollY;
  const contentLeft = (W - Math.min(W, 1248)) / 2; // main > section: --w + 48 px
  const x = Math.max(44, contentLeft / 2);
  const labels = $$(".eyebrow.label");
  const pts = labels.map((l) => {
    const r = l.getBoundingClientRect();
    return { y: r.top + scrollY - top + r.height / 2, text: $(".num", l).textContent ?? "" };
  });
  if (!pts.length) return;
  seamTop = pts[0].y - 160;
  seamBottom = pts[pts.length - 1].y + 260;
  // a gentle wave between the tags, and a small loop round each one, like a basting thread
  let d = `M ${x} ${seamTop}`;
  let prev = seamTop;
  pts.forEach((p, i) => {
    const mid = (prev + p.y) / 2, sway = i % 2 ? 18 : -18;
    d += ` C ${x + sway} ${mid - (p.y - prev) / 4}, ${x - sway} ${mid + (p.y - prev) / 4}, ${x} ${p.y - 26}`;
    d += ` c 22 6, 22 46, 0 52`;
    prev = p.y + 26;
  });
  d += ` C ${x + 18} ${prev + 80}, ${x - 18} ${seamBottom - 80}, ${x} ${seamBottom}`;
  seam.setAttribute("height", String(box.height));
  seam.setAttribute("viewBox", `0 0 ${W} ${box.height}`);
  seamThread.setAttribute("d", d);
  seamMask.setAttribute("d", d);
  seamLen = seamThread.getTotalLength();
  seamMask.style.strokeDasharray = `${seamLen} ${seamLen}`;
  for (const p of pts) {
    const el = document.createElement("span");
    el.className = "seam-tag";
    el.textContent = p.text;
    el.style.left = `${x}px`;
    el.style.top = `${p.y}px`;
    mainEl.append(el);
    seamTags.push({ el, y: p.y });
  }
  sewSeam();
}
function sewSeam() {
  if (!seamTags.length) return;
  const box = mainEl.getBoundingClientRect();
  const at = innerHeight * 0.62 - box.top; // where it sews: a little below the middle of the screen
  const k = reduced ? 1 : Math.min(1, Math.max(0, (at - seamTop) / (seamBottom - seamTop)));
  seamMask.style.strokeDashoffset = String(seamLen * (1 - k));
  for (const t of seamTags) t.el.classList.toggle("on", reduced || at >= t.y - 10);
}
addEventListener("scroll", () => requestAnimationFrame(sewSeam), { passive: true });
addEventListener("resize", layoutSeam);
addEventListener("load", layoutSeam);
document.fonts.ready.then(layoutSeam);
// the page grows as the demos load: lay the seam out again (once things settle)
let seamTimer = 0;
new ResizeObserver(() => {
  clearTimeout(seamTimer);
  seamTimer = window.setTimeout(layoutSeam, 200);
}).observe(mainEl);

// ---------------------------------------------------------------------------
// The renders with soft shadows are framed 1.6x wider than the object (.bleed): scaled
// up, they must stay inside the screen, or their shadows would end at its edge

function fitBleeds() {
  for (const img of $$<HTMLImageElement>("img.bleed")) {
    img.style.removeProperty("--bleed");
    const r = img.getBoundingClientRect();
    const w = r.width / 1.6; // the unscaled box (the rect includes the CSS scale)
    if (!w) continue;
    const mid = r.left + r.width / 2;
    const room = 2 * Math.min(mid, document.documentElement.clientWidth - mid);
    img.style.setProperty("--bleed", String(Math.max(1, Math.min(1.6, room / w))));
  }
}
fitBleeds();
addEventListener("resize", fitBleeds);
addEventListener("load", fitBleeds);

// ---------------------------------------------------------------------------
// The product bar: past the hero the nav carries the price and the call to action
// (on phones a bar at the bottom), and the section you are in is underlined

const hero = $("#top");
new IntersectionObserver(([e]) => document.body.classList.toggle("past-hero", !e.isIntersecting), { rootMargin: "-40% 0px 0px 0px" }).observe(hero);
const navLinks = $$<HTMLAnchorElement>(".nav nav a");
const spy = new IntersectionObserver(
  (es) =>
    es.forEach((e) => {
      if (!e.isIntersecting) return;
      for (const a of navLinks) a.classList.toggle("on", a.hash === `#${e.target.id}`);
    }),
  { rootMargin: "-45% 0px -50% 0px" },
);
for (const a of navLinks) spy.observe($(a.hash));
replayBtn.addEventListener("click", () => {
  replayBtn.hidden = true;
  opener.currentTime = 0;
  opener.play().catch(() => (replayBtn.hidden = false));
});

// ---------------------------------------------------------------------------
// The dummy interfaces: each starts when it comes near the viewport

type Demo = { run?: () => unknown };
const demos: Record<string, Promise<Demo>> = {};
const starters: Record<string, () => Promise<Demo>> = {
  editor: () => import("./demos/editor").then((m) => m.initEditor($("[data-demo=editor]"))).then((e) => ({ run: () => e.play(true), e })),
  digitize: () => import("./demos/digitize").then((m) => m.initDigitize($("[data-demo=digitize]"))),
  lettering: () => import("./demos/lettering").then((m) => m.initLettering($("[data-demo=lettering]"))),
  threads: () => import("./demos/threads").then((m) => m.initThreads($("[data-demo=threads]"))),
  export: () => import("./demos/export").then((m) => m.initExport($("[data-demo=export]"))),
};
const demo = (id: string) => (demos[id] ??= starters[id]());
const near = new IntersectionObserver(
  (es) =>
    es.forEach((e) => {
      if (!e.isIntersecting) return;
      const id = (e.target as HTMLElement).dataset.demo!;
      near.unobserve(e.target);
      demo(id);
    }),
  { rootMargin: "400px 0px" },
);
$$("[data-demo]").forEach((el) => near.observe(el));
const runDemo = (id: string) => demo(id).then((d) => d.run?.());

/** Restart a CSS animation by toggling a class. */
function replay(el: Element, cls = "play") {
  el.classList.remove(cls);
  void (el as HTMLElement).offsetWidth;
  el.classList.add(cls);
}

// The command palette tile: a preview of the app's palette over its real commands
// (public/data/commands.json, scripts/export-commands.mjs), scored the way the app scores
// them (ui/src/lib/commandSearch.ts). Type your own query; left alone, it types a few.

/** How well `query` matches a command (0 = no match): the app's commandScore. */
function commandScore(query: string, label: string, path: string): number {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return 1;
  const l = label.toLowerCase(), p = path.toLowerCase();
  let total = 0;
  for (const w of words) {
    const starts = (t: string) => t.startsWith(w) || t.includes(" " + w) || t.includes("(" + w) || t.includes("-" + w);
    if (starts(l)) total += 3;
    else if (l.includes(w)) total += 2;
    else if (starts(p)) total += 1.5;
    else if (p.includes(w)) total += 1;
    else return 0;
  }
  return total + (l.startsWith(words[0]) ? 1 : 0);
}
const esc = (t: string) => t.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
/** The text with the query's words marked. */
function marked(text: string, query: string) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const hit = new Array(text.length).fill(false);
  for (const w of words) {
    const i = text.toLowerCase().indexOf(w);
    if (i >= 0) for (let k = i; k < i + w.length; k++) hit[k] = true;
  }
  let out = "", on = false;
  for (let i = 0; i < text.length; i++) {
    if (hit[i] !== on) {
      out += hit[i] ? "<mark>" : "</mark>";
      on = hit[i];
    }
    out += esc(text[i]);
  }
  return out + (on ? "</mark>" : "");
}

(async () => {
  const box = $("[data-cmdk]");
  const input = $<HTMLInputElement>("[data-cmdk-input]", box);
  const list = $("[data-cmdk-list]", box);
  const foot = $("[data-cmdk-foot]", box);
  const commands = (await fetch("./data/commands.json").then((r) => r.json())) as [string, string, string][];
  foot.textContent = `${commands.length} commands, the same ones as in the app's menus`;
  function search() {
    const q = input.value.trim();
    const hits = commands
      .map(([path, label, kbd]) => ({ path, label, kbd, score: commandScore(q, label, path) }))
      .filter((c) => c.score > 0)
      .sort((a, b) => b.score - a.score);
    list.innerHTML = hits.length
      ? hits
          .slice(0, 3)
          .map(
            (c, i) =>
              `<li${i ? "" : ' class="on"'}><span class="cpath">${esc(c.path.replace(/ · /g, " › "))} ›</span><span class="clabel">${marked(c.label, q)}</span>${c.kbd ? `<kbd>${esc(c.kbd)}</kbd>` : ""}</li>`,
          )
          .join("")
      : `<li class="none">No command for &ldquo;${esc(q)}&rdquo;</li>`;
    if (q) foot.textContent = `${hits.length} of ${commands.length} commands match`;
  }
  input.addEventListener("input", search);
  search();
  if (reduced) return;
  // left alone, it types a few queries of its own (each has real results)
  const words = ["satin", "mirror", "appliqué", "align", "basting"];
  let typing = true;
  input.addEventListener("focus", () => (typing = false));
  for (let w = 0; typing; w = (w + 1) % words.length) {
    for (let i = 1; i <= words[w].length && typing; i++) {
      input.value = words[w].slice(0, i);
      search();
      await sleep(90);
    }
    await sleep(1800);
    for (let i = words[w].length; i >= 0 && typing; i--) {
      input.value = words[w].slice(0, i);
      search();
      await sleep(40);
    }
    await sleep(250);
  }
})();

// ---------------------------------------------------------------------------
// The tour: a woven-label card that walks the visitor through the demos. On wide screens
// it glides beside the section in view and a running stitch sews from it to the demo.

interface Step {
  id: string;
  text: string;
  show?: string;
  run?: () => void;
}

const STEPS: Step[] = [
  { id: "hero", text: "A short tour of Filum, one stop per feature. Each one is an interactive preview, built from the app&rsquo;s real data.", show: "Start the tour", run: () => go("editor") },
  { id: "editor", text: "A preview of the editor with its real sample design. Pick a shape, switch the view, or press <b>Show me</b> to watch it sew.", run: () => runDemo("editor") },
  { id: "digitize", text: "Drop a picture into the app and it finds the colours, then turns them into <b>fills, satins and lines</b>.", run: () => runDemo("digitize") },
  { id: "lettering", text: "Type a name: the preview sets it in a real <b>embroidery font</b>. Bend it with the arc slider.", run: () => runDemo("lettering") },
  { id: "threads", text: "Real threads: Filum finds the <b>closest colour</b> in 75 thread charts.", show: "Fit the badge", run: () => runDemo("threads") },
  { id: "export", text: "Pick a machine: the export checks the <b>hoop and the format</b> before you sew.", show: "Check it", run: () => runDemo("export") },
  { id: "layers", text: "Good embroidery is sewn in <b>layers</b>, from underlay up to satin.", run: () => replay($(".layer-list"), "play") },
  { id: "more", text: "And the <b>production details</b>: appliqué, knockdown, gradients, job sheets and more." },
  { id: "specs", text: "The <b>tech specs</b>: every format, font and stitch type in one list." },
  { id: "open", text: "That&rsquo;s the tour. Filum is <b>free and open source</b>: get it on GitHub to try the real thing.", show: "Get Filum", run: () => (location.href = "https://github.com/benkl/filum") },
];

const guide = $(".guide");
const pill = $<HTMLButtonElement>(".guide-pill");
const text = $(".bubble-text", guide);
const stop = $(".bubble-stop", guide);
const steps = $(".bubble-steps", guide);
const showBtn = $<HTMLButtonElement>("[data-guide-show]", guide);
const nextBtn = $<HTMLButtonElement>("[data-guide-next]", guide);
const tourThread = $<SVGSVGElement>(".tour-thread");
const tourPath = $<SVGPathElement>(".tour-path", tourThread);
const tourMask = $<SVGPathElement>(".tour-mask", tourThread);
const KEY = "filum.site.guide";
let current = -1;
steps.innerHTML = STEPS.map(() => "<i></i>").join("");

// the card glides beside the sections only where the margin fits it (see .guide in style.css)
const following = () => matchMedia("(min-width: 1900px)").matches && !reduced;
const section = (id: string) => document.getElementById(id === "hero" ? "top" : id)!;

function go(id: string) {
  section(id).scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: id === "hero" ? "start" : "center" });
}

/** What the tour points at in a section: its demo, or its main picture. */
const targetOf = (step: Step) =>
  section(step.id).querySelector<HTMLElement>("[data-demo], .hero-foot, .layers-art, .bento, .sheet, .open-logo") ?? section(step.id);

/** Where the card should float: beside the section's demo, inside the viewport. */
function targetY(step: Step): number {
  const r = targetOf(step).getBoundingClientRect();
  const h = guide.offsetHeight || 160;
  return Math.max(90, Math.min(innerHeight - h - 24, r.top + r.height / 2 - h / 2));
}

/** The running stitch from the card's left edge to the demo's right edge. */
function sewTo(step: Step, y: number, animate: boolean) {
  if (!following() || guide.hidden) {
    tourThread.classList.remove("on");
    return;
  }
  const t = targetOf(step).getBoundingClientRect();
  const g = guide.getBoundingClientRect();
  const x0 = g.left - 6, y0 = y + 34;
  const x1 = Math.min(t.right, g.left - 40) + 4;
  const y1 = Math.max(t.top + 24, Math.min(t.bottom - 24, y0));
  if (x0 - x1 < 24) return tourThread.classList.remove("on");
  const dx = (x0 - x1) / 2;
  const d = `M ${x0} ${y0} C ${x0 - dx} ${y0 + 26}, ${x1 + dx} ${y1 - 26}, ${x1} ${y1}`;
  tourPath.setAttribute("d", d);
  tourMask.setAttribute("d", d);
  const len = tourPath.getTotalLength();
  tourMask.style.strokeDasharray = `${len} ${len}`;
  tourThread.classList.add("on");
  if (animate) {
    tourMask.style.transition = "none";
    tourMask.style.strokeDashoffset = String(len);
    void tourMask.getBoundingClientRect();
    tourMask.style.transition = "";
  }
  tourMask.style.strokeDashoffset = "0";
}

/** Glide beside the current section while the page scrolls. */
function follow() {
  if (current < 0 || !following()) return sewTo(STEPS[Math.max(0, current)], 0, false);
  const y = targetY(STEPS[current]);
  guide.style.setProperty("--gy", `${y}px`);
  sewTo(STEPS[current], y, false);
}

function setStep(i: number) {
  if (i === current || i < 0) return follow();
  current = i;
  const step = STEPS[i];
  text.innerHTML = step.text;
  stop.textContent = `Tour · stop ${i + 1} / ${STEPS.length}`;
  steps.querySelectorAll("i").forEach((el, j) => el.classList.toggle("on", j <= i));
  showBtn.textContent = step.show ?? "Show me";
  showBtn.hidden = !step.run;
  nextBtn.hidden = i === STEPS.length - 1;
  if (!following()) return sewTo(step, 0, false);
  const y = targetY(step);
  guide.style.setProperty("--gy", `${y}px`);
  replay(guide, "hop");
  // sew the thread once the card has glided into place
  setTimeout(() => current === i && sewTo(step, targetY(step), true), 450);
}

/** The step of the section nearest the middle of the viewport. */
function nearestStep() {
  const mid = innerHeight * 0.45;
  let best = 0, dist = Infinity;
  STEPS.forEach((s, i) => {
    const r = section(s.id).getBoundingClientRect();
    const d = r.top <= mid && r.bottom >= mid ? 0 : Math.min(Math.abs(r.top - mid), Math.abs(r.bottom - mid));
    if (d < dist) [best, dist] = [i, d];
  });
  return best;
}
const pickStep = () => setStep(nearestStep());

// Below 1900 px the tour card sits in a corner over the page. Once you play with a demo
// (or after "Show me") it steps aside into the small pill, so it never covers what
// you are doing; it comes back at the next section, or when you click the pill.
let tuckedAt = -1;
function tuck() {
  if (guide.hidden || following()) return;
  tuckedAt = current;
  guide.hidden = true;
  tourThread.classList.remove("on");
  pill.hidden = false;
}
document.addEventListener(
  "pointerdown",
  (e) => {
    const t = e.target as HTMLElement;
    if (!t.closest(".guide") && t.closest("[data-demo], .win, .app")) tuck();
  },
  { passive: true },
);

function openGuide() {
  tuckedAt = -1;
  guide.hidden = false;
  pill.hidden = true;
  localStorage.removeItem(KEY);
  current = -1;
  pickStep();
}
function hideGuide() {
  tuckedAt = -1;
  guide.hidden = true;
  tourThread.classList.remove("on");
  pill.hidden = false;
  localStorage.setItem(KEY, "hidden");
  pill.focus();
}

showBtn.addEventListener("click", () => {
  STEPS[current]?.run?.();
  // let the demo be seen: step aside once it has started
  setTimeout(tuck, reduced ? 0 : 600);
});
nextBtn.addEventListener("click", () => {
  const next = STEPS[Math.min(STEPS.length - 1, current + 1)];
  go(next.id);
  setTimeout(() => next.run?.(), reduced ? 0 : 700);
});
$("[data-guide-hide]", guide).addEventListener("click", hideGuide);
pill.addEventListener("click", openGuide);
for (const b of $$("[data-tour]"))
  b.addEventListener("click", (e) => {
    e.preventDefault();
    if (guide.hidden) openGuide();
    go("editor");
  });

let ticking = false;
addEventListener(
  "scroll",
  () => {
    if (ticking) return;
    if (guide.hidden && tuckedAt < 0) return;
    ticking = true;
    requestAnimationFrame(() => {
      ticking = false;
      if (!guide.hidden) return pickStep();
      // tucked away: back at the next section
      if (nearestStep() !== tuckedAt) {
        guide.hidden = false;
        pill.hidden = true;
        tuckedAt = -1;
        current = -1;
        pickStep();
      }
    });
  },
  { passive: true },
);
addEventListener("resize", () => {
  if (guide.hidden || current < 0) return;
  const i = current;
  current = -1;
  setStep(i);
});

// say hello a moment after the page appears (unless the guide was hidden)
// (on phones and portrait tablets it starts folded up, so it doesn't cover the page)
setTimeout(
  () => {
    if (localStorage.getItem(KEY) === "hidden" || phone.matches) pill.hidden = false;
    else openGuide();
  },
  reduced ? 0 : 900,
);
