// Icons: the app's embroidery icons (src/icons, from Filum) and a few
// interface glyphs drawn on the same 24 px grid, 2 px round strokes.
const raw = import.meta.glob("../icons/*.svg", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const stitch: Record<string, string> = {};
for (const [k, v] of Object.entries(raw)) stitch[k.replace(/^.*\/|\.svg$/g, "")] = v.replace(/width="24" height="24"/, 'width="1em" height="1em"');

const g = (body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
const ui: Record<string, string> = {
  select: g('<path d="M4 4l7 17 2.5-7.5L21 11z"/>'),
  pen: g('<path d="M12 19l7-7 3 3-7 7z"/><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18z"/><path d="M2 2l7.6 7.6"/><circle cx="11" cy="11" r="2"/>'),
  text: g('<path d="M4 7V4h16v3"/><path d="M9 20h6"/><path d="M12 4v16"/>'),
  square: g('<rect x="3" y="3" width="18" height="18" rx="2"/>'),
  hand: g('<path d="M18 11V6a2 2 0 0 0-4 0v5"/><path d="M14 10V4a2 2 0 0 0-4 0v6"/><path d="M10 10.5V6a2 2 0 0 0-4 0v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/>'),
  play: g('<path d="M7 4l13 8-13 8z"/>'),
  pause: g('<path d="M8 4v16"/><path d="M16 4v16"/>'),
  eye: g('<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'),
  check: g('<path d="M20 6 9 17l-5-5"/>'),
  alert: g('<path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>'),
  download: g('<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/>'),
  search: g('<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>'),
  sparkle: g('<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/>'),
  image: g('<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/>'),
  palette: g('<circle cx="13.5" cy="6.5" r="1"/><circle cx="17.5" cy="10.5" r="1"/><circle cx="8.5" cy="7.5" r="1"/><circle cx="6.5" cy="12.5" r="1"/><path d="M12 2a10 10 0 0 0 0 20 1.7 1.7 0 0 0 1.2-2.9 1.7 1.7 0 0 1 1.2-2.9H16a6 6 0 0 0 6-6C22 5.8 17.5 2 12 2z"/>'),
  command: g('<path d="M15 6v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3"/>'),
  printer: g('<path d="M6 9V2h12v7"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8" rx="1"/>'),
  video: g('<path d="m22 8-6 4 6 4V8z"/><rect x="2" y="6" width="14" height="12" rx="2"/>'),
  globe: g('<circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15 15 0 0 1 0 20 15 15 0 0 1 0-20"/>'),
  cpu: g('<rect x="5" y="5" width="14" height="14" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"/>'),
  undo: g('<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-1"/>'),
  redo: g('<path d="m15 14 5-5-5-5"/><path d="M20 9H9a5 5 0 0 0 0 10h1"/>'),
};

/** An icon as inline SVG markup. */
export const icon = (name: string) => stitch[name] ?? ui[name] ?? "";

/** Fill every `[data-icon]` element with its icon. */
export function hydrateIcons(root: ParentNode = document) {
  for (const el of root.querySelectorAll<HTMLElement>("[data-icon]")) el.innerHTML = icon(el.dataset.icon!);
}
