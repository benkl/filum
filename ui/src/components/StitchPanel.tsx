// Stitch style picker (line and fill styles as visual cards), a live preview
// of the object's own stitches, and preset chips for the common settings.

import { Check } from "lucide-react";
import { useEffect, useRef } from "react";
import { holdsInkDefaults, inkChanges, inkDefaults } from "../lib/stitchDefaults";
import { defaultApplique, defaultFill, defaultGuide, defaultRunning, defaultSatin, fillMethodDefaults, objectBounds } from "../lib/geometry";
import { defaultVector, makeGradient } from "../lib/gradient";
import { applyRamp } from "../lib/ramp";
import { collapseLayers } from "../lib/fillLayers";
import { makeTartan } from "../lib/tartan";
import { useStore } from "../store";
import type { DesignObject, StitchParams } from "../types";
import { FLAG } from "../types";
import { useEditTargets } from "./editTargets";

type St = StitchParams;

interface Style {
  id: string;
  label: string;
  title: string;
  icon: React.ReactNode;
  matches: (st: St) => boolean;
  apply: (o: DesignObject) => St | "gradient" | "shading" | "tartan";
  /** Why the style is not available for this object (null: it is). */
  needs?: (o: DesignObject) => string | null;
}

const stroke = { fill: "none", stroke: "currentColor", strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
const svg = (children: React.ReactNode) => (
  <svg viewBox="0 0 40 28" width="40" height="28" aria-hidden>
    {children}
  </svg>
);
const zig = (n: number, y0: number, y1: number, x0 = 4, x1 = 36) =>
  Array.from({ length: n + 1 }, (_, i) => `${x0 + ((x1 - x0) * i) / n},${i % 2 ? y1 : y0}`).join(" ");

/** The current parameters when the object already has this stitch type (without the type tag). */
const keep = (o: DesignObject, type: St["type"]): Record<string, unknown> => {
  if (o.stitch.type !== type) return {};
  const { type: _t, ...rest } = o.stitch as { type: string } & Record<string, unknown>;
  void _t;
  return rest;
};
const asSt = (x: object) => x as St;

export const LINE_STYLES: Style[] = [
  {
    id: "run",
    label: "Run",
    title: "Single running stitch — outlines and details",
    icon: svg(<path d="M4 18 C14 6, 26 26, 36 12" {...stroke} strokeWidth={1.4} strokeDasharray="3 2" />),
    matches: (st) => st.type === "running" && st.beanRepeats < 2 && !st.ripple && !st.stem && !st.motif && !st.zigzag,
    apply: (o) => asSt({ type: "running", ...defaultRunning(), ...keep(o, "running"), beanRepeats: 0, ripple: undefined, stem: undefined, motif: undefined, zigzag: undefined }),
  },
  {
    id: "triple",
    label: "Triple",
    title: "Triple (bean) stitch — bold, hand-stitched look",
    icon: svg(<path d="M4 18 C14 6, 26 26, 36 12" {...stroke} strokeWidth={2.6} strokeDasharray="4 2" />),
    matches: (st) => st.type === "running" && st.beanRepeats >= 2 && st.beanRepeats < 4 && !st.ripple && !st.stem && !st.motif && !st.zigzag,
    apply: (o) => asSt({ type: "running", ...defaultRunning(), ...keep(o, "running"), beanRepeats: 2, ripple: undefined, stem: undefined, motif: undefined, zigzag: undefined }),
  },
  {
    id: "heavy",
    label: "Heavy",
    title: "Five passes — very bold line",
    icon: svg(<path d="M4 18 C14 6, 26 26, 36 12" {...stroke} strokeWidth={3.8} strokeDasharray="5 2" />),
    matches: (st) => st.type === "running" && st.beanRepeats >= 4 && !st.ripple && !st.stem && !st.motif && !st.zigzag,
    apply: (o) => asSt({ type: "running", ...defaultRunning(), ...keep(o, "running"), beanRepeats: 4, ripple: undefined, stem: undefined, motif: undefined, zigzag: undefined }),
  },
  {
    id: "stem",
    label: "Stem",
    title: "Stem stitch: slanted stitches that overlap by half — a rope-like, hand-sewn line",
    icon: svg(<path d="M4 20 L12 14 M9 19 L17 13 M14 18 L22 12 M19 17 L27 11 M24 16 L32 10 M29 15 L36 10" {...stroke} strokeWidth={1.5} />),
    matches: (st) => st.type === "running" && !!st.stem,
    apply: (o) => asSt({ type: "running", ...defaultRunning(), ...keep(o, "running"), length: 2.5, beanRepeats: 0, ripple: undefined, motif: undefined, zigzag: undefined, stem: { width: 0.8 } }),
  },
  {
    id: "motif",
    label: "Motif",
    title: "Motif run: a small pattern (wave, scallop, loop, diamond…) repeated along the line",
    icon: svg(<path d="M4 14 C7 6, 10 6, 13 14 S19 22, 22 14 S28 6, 31 14 S35 20, 36 16" {...stroke} strokeWidth={1.3} />),
    matches: (st) => st.type === "running" && !!st.motif,
    apply: (o) => asSt({ type: "running", ...defaultRunning(), ...keep(o, "running"), length: 1.5, beanRepeats: 0, ripple: undefined, stem: undefined, zigzag: undefined, motif: { kind: "wave", size: 4 } }),
  },
  {
    id: "ripple",
    label: "Ripple",
    title: "Ripple stitch (Ink/Stitch): shapes spiral inwards as shrinking copies, lines repeat back and forth",
    icon: svg(
      <>
        <rect x="5" y="3" width="30" height="22" rx="7" {...stroke} strokeWidth={1.1} />
        <rect x="11" y="8" width="18" height="12" rx="4.5" {...stroke} strokeWidth={1.1} />
        <rect x="16.5" y="12" width="7" height="4" rx="2" {...stroke} strokeWidth={1.1} />
      </>,
    ),
    matches: (st) => st.type === "running" && !!st.ripple && !st.stem && !st.motif && !st.zigzag,
    apply: (o) =>
      asSt({
        type: "running",
        ...defaultRunning(),
        ...keep(o, "running"),
        zigzag: undefined,
        ripple: { lines: 10, minScale: 0, spacing: 2, rotation: 0, reverse: false, ...(o.stitch.type === "running" ? o.stitch.ripple : {}) },
      }),
  },
  {
    id: "satin",
    label: "Satin",
    title: "Satin column — smooth, shiny borders and lettering",
    icon: svg(<polyline points={zig(16, 8, 20)} {...stroke} strokeWidth={1} />),
    matches: (st) => st.type === "satin" && st.method === "satin",
    apply: (o) => asSt({ type: "satin", ...defaultSatin(), ...keep(o, "satin"), method: "satin", spacing: 0.4 }),
  },
  {
    id: "zigzag",
    label: "Zig-zag",
    title: "Open zig-zag — light borders, tack-downs. On a single line: Ink/Stitch's zig-zag line (with an angle for spokes)",
    icon: svg(<polyline points={zig(6, 8, 20)} {...stroke} strokeWidth={1.4} />),
    matches: (st) => (st.type === "satin" && st.method === "zigzag") || (st.type === "running" && !!st.zigzag),
    apply: (o) =>
      o.paths.length === 1
        ? asSt({
            type: "running",
            ...defaultRunning(),
            ...keep(o, "running"),
            ripple: undefined,
            stem: undefined,
            motif: undefined,
            beanRepeats: 0,
            zigzag: (o.stitch.type === "running" && o.stitch.zigzag) || { width: o.stitch.type === "satin" ? o.stitch.width : 2, spacing: 1.4, pullComp: 0, angle: 0 },
          })
        : asSt({ type: "satin", ...defaultSatin(), ...keep(o, "satin"), method: "zigzag", spacing: 1.4, centerWalk: false }),
  },
  {
    id: "sstitch",
    label: "S-stitch",
    title: "S-stitch: short slanted stitches in an S rhythm — a corded edge",
    icon: svg(<path d="M6 20 C6 10, 12 10, 12 14 S18 18, 18 8 M18 20 C18 10, 24 10, 24 14 S30 18, 30 8" {...stroke} strokeWidth={1.3} />),
    matches: (st) => st.type === "satin" && st.method === "sStitch",
    apply: (o) => asSt({ type: "satin", ...defaultSatin(), ...keep(o, "satin"), method: "sStitch", spacing: 0.6, centerWalk: false }),
  },
  {
    id: "blanket",
    label: "Blanket",
    title: "E-stitch / blanket stitch — appliqué edges",
    icon: svg(
      <path d="M4 20 H36 M8 20 V9 M14 20 V9 M20 20 V9 M26 20 V9 M32 20 V9" {...stroke} strokeWidth={1.3} />,
    ),
    matches: (st) => st.type === "satin" && st.method === "eStitch",
    apply: (o) => asSt({ type: "satin", ...defaultSatin(), ...keep(o, "satin"), method: "eStitch", spacing: 2, centerWalk: false }),
  },
];

const fillIcon = (inner: React.ReactNode) => svg(<g>{inner}</g>);
const hatch = Array.from({ length: 9 }, (_, i) => `M${2 + i * 5},26 L${12 + i * 5},2`).join(" ");

export const FILL_STYLES: Style[] = [
  {
    id: "tatami",
    label: "Tatami",
    title: "Rows of stitches — the standard fill",
    icon: fillIcon(
      <>
        <clipPath id="fc1">
          <rect x="4" y="3" width="32" height="22" rx="4" />
        </clipPath>
        <path d={hatch} clipPath="url(#fc1)" {...stroke} strokeWidth={1.2} />
      </>,
    ),
    matches: (st) => st.type === "fill" && st.method === "tatami" && !st.gradient && !st.ramp && (st.carve ?? "none") === "none",
    apply: (o) => asSt({ type: "fill", ...defaultFill(), ...keep(o, "fill"), ...fillMethodDefaults("tatami"), gradient: undefined, ramp: undefined, carve: "none" }),
  },
  {
    id: "carved",
    label: "Carved",
    title: "Carved / embossed fill: the needle points line up into a pattern (diamonds, waves, circles…) that catches the light",
    icon: fillIcon(
      <>
        <clipPath id="fc2">
          <rect x="4" y="3" width="32" height="22" rx="4" />
        </clipPath>
        <g clipPath="url(#fc2)">
          <path d={hatch} {...stroke} strokeWidth={0.8} opacity={0.5} />
          <path d="M4 14 L12 4 L20 14 L28 4 L36 14 M4 14 L12 24 L20 14 L28 24 L36 14" {...stroke} strokeWidth={1.6} />
        </g>
      </>,
    ),
    matches: (st) => st.type === "fill" && st.method === "tatami" && !!st.carve && st.carve !== "none" && !st.gradient,
    apply: (o) => asSt({ type: "fill", ...defaultFill(), ...keep(o, "fill"), ...fillMethodDefaults("tatami"), gradient: undefined, ramp: undefined, carve: "diamonds", carveSize: 6 }),
  },
  {
    id: "shading",
    label: "Shading",
    title: "Shading (a gradient fill): dense rows that open up across the shape — drag its direction with the gradient tool (G)",
    icon: fillIcon(<path d="M4 4 H36 M4 6 H36 M4 8.5 H36 M4 11.5 H36 M4 15 H36 M4 19.5 H36 M4 25 H36" {...stroke} strokeWidth={1.1} />),
    matches: (st) => st.type === "fill" && !!st.ramp && !st.ramp.group,
    apply: () => "shading",
  },
  {
    id: "cross",
    label: "Cross",
    title: "Cross stitch: a grid of little crosses — the hand-embroidered, pixel look",
    icon: fillIcon(<path d="M5 5 L13 13 M13 5 L5 13 M14 5 L22 13 M22 5 L14 13 M23 5 L31 13 M31 5 L23 13 M5 15 L13 23 M13 15 L5 23 M14 15 L22 23 M22 15 L14 23" {...stroke} strokeWidth={1.2} />),
    matches: (st) => st.type === "fill" && st.method === "cross",
    apply: (o) => asSt({ type: "fill", ...defaultFill(), ...keep(o, "fill"), ...fillMethodDefaults("cross"), gradient: undefined, ramp: undefined }),
  },
  {
    id: "tartan",
    label: "Tartan",
    title: "Tartan: a woven plaid in several thread colours — stripes one way and the other, rows in a twill (Ink/Stitch tartan fill)",
    icon: fillIcon(
      <>
        <path d="M10 2 V26 M24 2 V26 M2 9 H38 M2 19 H38" {...stroke} strokeWidth={3} opacity={0.55} />
        <path d="M17 2 V26 M31 2 V26 M2 14 H38" {...stroke} strokeWidth={1} />
      </>,
    ),
    matches: (st) => st.type === "fill" && st.method === "tartan",
    apply: () => "tartan",
    needs: (o) => (hasClosed(o) ? null : "Tartan fills a closed shape"),
  },
  {
    id: "curved",
    label: "Curved",
    title: "Curved fill: rows that follow the outline of the shape (how much: Follow the shape)",
    icon: fillIcon(<path d="M4 8 C12 2, 28 2, 36 8 M4 14 C12 8, 28 8, 36 14 M4 20 C12 14, 28 14, 36 20 M4 26 C12 20, 28 20, 36 26" {...stroke} strokeWidth={1.1} />),
    matches: (st) => st.type === "fill" && st.method === "curved" && !st.gradient,
    apply: (o) => asSt({ type: "fill", ...defaultFill(), ...keep(o, "fill"), ...fillMethodDefaults("curved"), gradient: undefined }),
  },
  {
    id: "flow",
    label: "Flow",
    title: "Flow fill: rows follow the picture's flow (fills made by the auto-digitizer)",
    icon: fillIcon(<path d="M4 6 C10 12, 16 2, 22 9 S32 4, 36 10 M4 13 C10 19, 16 9, 22 16 S32 11, 36 17 M4 20 C10 26, 16 16, 22 23 S32 18, 36 24" {...stroke} strokeWidth={1.1} />),
    matches: (st) => st.type === "fill" && st.method === "flow" && !st.gradient,
    apply: (o) => asSt({ type: "fill", ...defaultFill(), ...keep(o, "fill"), ...fillMethodDefaults("flow"), gradient: undefined }),
    needs: (o) => (o.stitch.type === "fill" && o.stitch.flow ? null : "Only for fills made by the auto-digitizer with the Flow fill (they carry the picture's direction field). For a gradient, pick Flow under Rows in the gradient settings: the rows follow its colour bands."),
  },
  {
    id: "contour",
    label: "Contour",
    title: "Follows the outline inwards",
    icon: fillIcon(
      <>
        <rect x="4" y="3" width="32" height="22" rx="5" {...stroke} strokeWidth={1.1} />
        <rect x="9" y="7.5" width="22" height="13" rx="3.5" {...stroke} strokeWidth={1.1} />
        <rect x="14" y="12" width="12" height="4" rx="2" {...stroke} strokeWidth={1.1} />
      </>,
    ),
    matches: (st) => st.type === "fill" && st.method === "contour",
    apply: (o) => asSt({ type: "fill", ...defaultFill(), ...keep(o, "fill"), ...fillMethodDefaults("contour"), gradient: undefined }),
  },
  {
    id: "spiral",
    label: "Spiral",
    title: "One continuous spiral",
    icon: fillIcon(<path d="M20 14 m0 0 a2 2 0 1 1 3 1 a5 5 0 1 1 -8 -3 a8 8 0 1 1 14 6 a11 11 0 0 1 -20 -6" {...stroke} strokeWidth={1.2} />),
    matches: (st) => st.type === "fill" && st.method === "spiral",
    apply: (o) => asSt({ type: "fill", ...defaultFill(), ...keep(o, "fill"), ...fillMethodDefaults("spiral"), gradient: undefined }),
  },
  {
    id: "radial",
    label: "Sunburst",
    title: "Rays from a centre",
    icon: fillIcon(<path d="M20 14 L4 4 M20 14 L20 2 M20 14 L36 4 M20 14 L38 14 M20 14 L36 25 M20 14 L20 26 M20 14 L4 25 M20 14 L2 14" {...stroke} strokeWidth={1.1} />),
    matches: (st) => st.type === "fill" && st.method === "radial",
    apply: (o) => asSt({ type: "fill", ...defaultFill(), ...keep(o, "fill"), ...fillMethodDefaults("radial"), gradient: undefined }),
  },
  {
    id: "hilbert",
    label: "Maze",
    title: "Hilbert curve — textured, even",
    icon: fillIcon(<path d="M6 24 V16 H12 V24 H18 V16 V10 H12 V4 H6 M18 4 H24 V10 H30 V4 H36 M36 10 V16 H30 V24 H36" {...stroke} strokeWidth={1.2} />),
    matches: (st) => st.type === "fill" && st.method === "hilbert",
    apply: (o) => asSt({ type: "fill", ...defaultFill(), ...keep(o, "fill"), ...fillMethodDefaults("hilbert"), gradient: undefined }),
  },
  {
    id: "stipple",
    label: "Stipple",
    title: "Meandering running stitch — light, quilted texture",
    icon: fillIcon(<path d="M4 20 C8 4, 12 26, 16 10 S24 4, 22 18 S32 26, 30 10 S38 8, 36 20" {...stroke} strokeWidth={1.2} />),
    matches: (st) => st.type === "fill" && st.method === "stipple",
    apply: (o) => asSt({ type: "fill", ...defaultFill(), ...keep(o, "fill"), ...fillMethodDefaults("stipple"), gradient: undefined }),
  },
  {
    id: "meander",
    label: "Meander",
    title: "Meander fill (Ink/Stitch): a random walk over a lattice or one of the 75 Ink/Stitch tiles — quilted look, few stitches",
    icon: fillIcon(<path d="M5 24 V18 H11 V24 H17 V12 H5 V4 H17 M17 4 H23 V18 H29 V10 H23 M29 4 H35 V24 H29" {...stroke} strokeWidth={1.2} />),
    matches: (st) => st.type === "fill" && st.method === "meander",
    apply: (o) => asSt({ type: "fill", ...defaultFill(), ...keep(o, "fill"), ...fillMethodDefaults("meander"), gradient: undefined }),
  },
  {
    id: "guided",
    label: "Guided",
    title: "Guided fill (Ink/Stitch): rows follow a guide line you can bend on the canvas",
    icon: fillIcon(<path d="M3 9 C12 1, 24 15, 37 6 M3 15 C12 7, 24 21, 37 12 M3 21 C12 13, 24 27, 37 18 M3 27 C12 19, 24 33, 37 24" {...stroke} strokeWidth={1.1} />),
    matches: (st) => st.type === "fill" && st.method === "guided",
    apply: (o) => {
      const prev = o.stitch.type === "fill" ? o.stitch.guide : undefined;
      const b = objectBounds(o);
      return asSt({ type: "fill", ...defaultFill(), ...keep(o, "fill"), ...fillMethodDefaults("guided"), guide: prev ?? (b ? defaultGuide(b) : undefined), gradient: undefined });
    },
  },
  {
    id: "circular",
    label: "Circular",
    title: "Circular fill (Ink/Stitch): one spiral around a centre you can drag",
    icon: fillIcon(<path d="M20 14 m0 0 a1.5 1.5 0 1 1 2 0.5 a4 4 0 1 1 -6 -2 a7 7 0 1 1 11 6 a10 10 0 1 1 -16 -8 a13 13 0 0 1 21 3" {...stroke} strokeWidth={1.1} />),
    matches: (st) => st.type === "fill" && st.method === "circular",
    apply: (o) => asSt({ type: "fill", ...defaultFill(), ...keep(o, "fill"), ...fillMethodDefaults("circular"), gradient: undefined }),
  },
  {
    id: "gradient",
    label: "Gradient",
    title: "Multi-colour gradient with dithering",
    icon: fillIcon(
      <>
        <defs>
          <linearGradient id="fg1">
            <stop offset="0" stopColor="currentColor" stopOpacity="1" />
            <stop offset="1" stopColor="currentColor" stopOpacity="0.15" />
          </linearGradient>
        </defs>
        <rect x="4" y="3" width="32" height="22" rx="4" fill="url(#fg1)" />
      </>,
    ),
    matches: (st) => st.type === "fill" && !!st.gradient,
    apply: () => "gradient",
  },
  {
    id: "applique",
    label: "Appliqué",
    title: "Fabric patch: placement, tack-down, cover",
    icon: fillIcon(
      <>
        <rect x="6" y="5" width="28" height="18" rx="4" fill="currentColor" opacity="0.2" />
        <rect x="6" y="5" width="28" height="18" rx="4" {...stroke} strokeWidth={3} />
      </>,
    ),
    matches: (st) => st.type === "applique",
    apply: (o) => asSt({ type: "applique", ...defaultApplique(), ...keep(o, "applique") }),
  },
];

const hasClosed = (o: DesignObject) => o.paths.some((p) => p.closed && p.nodes.length >= 3);

/** Visual stitch style picker. */
export function StylePicker({ o }: { o: DesignObject }) {
  const closed = hasClosed(o);
  const targets = useEditTargets(o);
  const many = targets.length > 1;
  // several objects: each takes the style with its own settings carried over
  const pickMany = (s: Style) => {
    const ids = new Set(targets);
    useStore.getState().commit((d) => ({
      ...d,
      objects: d.objects.map((x) => {
        // a fill style only on closed shapes
        if (!ids.has(x.id) || s.needs?.(x) || (FILL_STYLES.includes(s) && !hasClosed(x))) return x;
        const r = s.apply(x);
        return typeof r === "string" ? x : { ...x, stitch: r };
      }),
    }));
  };
  const pickStyle = (s: Style) => {
    if (many) return pickMany(s);
    const r = s.apply(o);
    if (r === "shading") {
      const b = objectBounds(o);
      if (!b) return;
      const err = applyRamp(o.id, [b.x + b.w * 0.1, b.y + b.h / 2], [b.x + b.w * 0.9, b.y + b.h / 2], "density");
      if (err) useStore.getState().toast(err, "error");
      else useStore.getState().toast("Shading: dense on the left, open on the right — drag a new direction with the gradient tool (G)");
      return;
    }
    const st = useStore.getState();
    // a layer of a gradient or tartan: the set becomes one plain fill first (its other layers go)
    const layered = !o.clone && o.stitch.type === "fill" && (!!o.stitch.gradient || !!o.stitch.tartan);
    const reselect = (id: string | undefined) => {
      const now = useStore.getState();
      if (id && !now.selection.includes(id) && st.selection.includes(o.id)) now.select([...now.selection, id]);
    };
    if (r === "tartan") {
      if (o.stitch.type === "fill" && o.stitch.tartan) return;
      let kept: string | undefined = o.id;
      st.commit((d) => {
        const c = collapseLayers(d, o.id);
        kept = c.id;
        return c.id ? makeTartan(c.doc, c.id) : d;
      });
      reselect(kept);
      st.toast("Tartan: a layer per thread colour — edit the stripes in the Tartan section");
      return;
    }
    if (r === "gradient") {
      const [a, b] = defaultVector([o]);
      if (!makeGradient(o.id, a, b)) return;
      st.toast("Gradient created — drag across the shape with the gradient tool (G) to set its direction");
      return;
    }
    const style = r;
    if (!layered) {
      st.commit((d) => ({ ...d, objects: d.objects.map((x) => (x.id === o.id ? { ...x, stitch: style } : x)) }));
      return;
    }
    // one undo step: the set collapsed, the style on the layer left
    const next: StitchParams = style.type === "fill" ? { ...style, gradient: undefined, tartan: undefined, ...(style.method === "tartan" ? { method: "tatami" as const } : {}) } : style;
    let kept: string | undefined;
    st.commit((d) => {
      const c = collapseLayers(d, o.id);
      kept = c.id;
      return { ...c.doc, objects: c.doc.objects.map((x) => (x.id === c.id ? { ...x, stitch: next } : x)) };
    });
    reselect(kept);
  };
  const card = (s: Style) => {
    // shading, gradients and tartans are made on one shape at a time
    const special = many && typeof s.apply(o) === "string";
    const missing = special ? "One object at a time" : (s.needs?.(o) ?? null);
    return (
      <button key={s.id} className={`style-card ${s.matches(o.stitch) ? "on" : ""}`} title={missing ?? s.title} disabled={!!missing} onClick={() => pickStyle(s)}>
        {s.icon}
        <span>{s.label}</span>
      </button>
    );
  };
  return (
    <div className="style-picker">
      {closed && (
        <>
          <div className="style-group-label">Fill</div>
          <div className="style-grid">{FILL_STYLES.map(card)}</div>
          <div className="style-group-label">Outline</div>
        </>
      )}
      {!closed && <div className="style-group-label">Line</div>}
      <div className="style-grid">{LINE_STYLES.map(card)}</div>
      <div className="style-extra">
        <button className={`link ${o.stitch.type === "none" ? "on" : ""}`} onClick={() => pickStyle({ ...LINE_STYLES[0], apply: () => ({ type: "none" }) })}>
          No stitches (guide)
        </button>
        {o.stitch.type === "manual" && <span className="stat">Manual stitches (imported)</span>}
      </div>
    </div>
  );
}

/** The object's own stitches from the current plan, with count and thread length. */
export function StitchPreview({ o }: { o: DesignObject }) {
  const plan = useStore((s) => s.plan);
  const index = useStore((s) => s.doc.objects.findIndex((x) => x.id === o.id));
  const color = useStore((s) => s.doc.threads.find((t) => t.id === o.thread)?.color ?? "#333");
  const ref = useRef<HTMLCanvasElement>(null);
  const label = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c || !plan) return;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth || 240;
    const h = c.clientHeight || 90;
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
    const g = c.getContext("2d")!;
    g.clearRect(0, 0, c.width, c.height);
    const { coords, flags, objects } = plan;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (let i = 0; i < flags.length; i++) {
      if (objects[i] !== index || flags[i] & FLAG.COMMANDS) continue;
      x0 = Math.min(x0, coords[2 * i]);
      x1 = Math.max(x1, coords[2 * i]);
      y0 = Math.min(y0, coords[2 * i + 1]);
      y1 = Math.max(y1, coords[2 * i + 1]);
    }
    if (!isFinite(x0)) {
      if (label.current) label.current.textContent = "No stitches";
      return;
    }
    const pad = 6 * dpr;
    const k = Math.min((c.width - 2 * pad) / Math.max(x1 - x0, 0.1), (c.height - 2 * pad) / Math.max(y1 - y0, 0.1));
    const ox = (c.width - (x1 - x0) * k) / 2 - x0 * k;
    const oy = (c.height - (y1 - y0) * k) / 2 - y0 * k;
    let n = 0;
    let len = 0;
    for (const under of [true, false]) {
      g.beginPath();
      let pen = false;
      let px = 0;
      let py = 0;
      for (let i = 0; i < flags.length; i++) {
        if (objects[i] !== index || flags[i] & FLAG.COMMANDS) {
          pen = false;
          continue;
        }
        const isUnder = !!(flags[i] & (FLAG.UNDERLAY | FLAG.TRAVEL));
        const x = coords[2 * i] * k + ox;
        const y = coords[2 * i + 1] * k + oy;
        if (pen && isUnder === under) {
          g.moveTo(px, py);
          g.lineTo(x, y);
        }
        if (!under) {
          if (pen) len += Math.hypot(x - px, y - py) / k;
          n++;
        }
        px = x;
        py = y;
        pen = true;
      }
      g.strokeStyle = under ? "rgba(120,120,120,.45)" : color;
      g.lineWidth = Math.max(0.6, Math.min(1.6, k * 0.12)) * (under ? 0.7 : 1);
      g.stroke();
    }
    if (label.current) label.current.textContent = `${n.toLocaleString()} stitches · ${(len / 1000).toFixed(2)} m thread`;
  });
  return (
    <div className="stitch-preview">
      <canvas ref={ref} />
      <span className="stitch-preview-info" ref={label} />
    </div>
  );
}

/** A row of preset chips. */
export function Presets<T>({ items, value, onPick, eq }: { items: [string, T, string?][]; value: T; onPick: (v: T) => void; eq?: (a: T, b: T) => boolean }) {
  const same = eq ?? ((a: T, b: T) => JSON.stringify(a) === JSON.stringify(b));
  return (
    <div className="presets">
      {items.map(([label, v, title]) => (
        <button key={label} className={`chip ${same(value, v) ? "on" : ""}`} title={title} onClick={() => onPick(v)}>
          {label}
        </button>
      ))}
    </div>
  );
}

/** Ink/Stitch's defaults for the object's stitch type: whether it holds them, and a button to put them back. */
export function StitchDefaults({ o }: { o: DesignObject }) {
  const values = inkDefaults(o.stitch);
  const targets = useEditTargets(o);
  if (!values) return null;
  const on = holdsInkDefaults(o.stitch);
  const changes = inkChanges(o.stitch);
  return (
    <div className="st-defaults">
      <span className="st-defaults-label">Defaults</span>
      <div className="seg">
        <button
          className={on ? "on" : ""}
          title={on ? "Holds Ink/Stitch's defaults" : `Back to Ink/Stitch's defaults: ${changes.join(", ")}`}
          onClick={() => useStore.getState().updateStitch(targets, values)}
        >
          {on && <Check size={11} />}
          Ink/Stitch
        </button>
      </div>
      {!on && <span className="stat">custom</span>}
    </div>
  );
}
