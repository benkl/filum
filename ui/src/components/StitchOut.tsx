// The stitch-out player: a timeline of the colour blocks under the canvas,
// the playback loop, following the needle and the stitch-out video.

import { ArrowLeftToLine, ArrowRightToLine, Gauge, Pause, Play, Video, X, ZoomIn, ZoomOut } from "lucide-react";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from "react";
import { BlockNext, BlockPrevious, ColorChange, FollowNeedle, GradientTool, MachineStop, Trim } from "../icons/stitch";
import { saveFile } from "../lib/platform";
import { startCapture, stopCapture } from "../canvas/Canvas";
import { SPEEDS, blockAt, buildTimeline, playRate, speedLabel, tickStep, type Timeline, type TimelineBlock } from "../lib/stitchout";
import { colorSequence } from "../lib/threads";
import { useStore } from "../store";
import type { PlanData } from "../types";
import { fmtTime } from "./ui";
import { threadTitle } from "./ThreadPicker";

// ---------------------------------------------------------------------------
// Playback

const timelines = new WeakMap<PlanData, { key: string; tl: Timeline }>();

/** The timeline of the current plan (cached per plan and machine timing). */
export function currentTimeline(): Timeline | null {
  const s = useStore.getState();
  return s.plan ? timelineOf(s.plan, s.doc.machine) : null;
}

function timelineOf(plan: PlanData, m: { spm: number; trimSeconds: number; colorChangeSeconds: number }): Timeline {
  const key = `${m.spm}|${m.trimSeconds}|${m.colorChangeSeconds}`;
  const hit = timelines.get(plan);
  if (hit && hit.key === key) return hit.tl;
  const tl = buildTimeline(plan, m);
  timelines.set(plan, { key, tl });
  return tl;
}

/** Moves the player to record `index` (stops playing). */
export function seek(index: number) {
  const s = useStore.getState();
  const total = s.plan?.flags.length ?? 0;
  if (!total) return;
  s.set({ anim: { ...s.anim, playing: false, index: Math.max(0, Math.min(total, Math.round(index))) } });
}

/** Opens the player (if closed) and plays from where it is, or from the start once finished. */
export function play() {
  const s = useStore.getState();
  const total = s.plan?.flags.length ?? 0;
  if (!total) return;
  const start = s.anim.index == null || s.anim.index >= total ? 0 : s.anim.index;
  if (s.viewMode === "vector") s.set({ viewMode: "realistic" });
  s.set({ anim: { ...s.anim, index: start, playing: true } });
}

export function togglePlay() {
  const s = useStore.getState();
  if (s.anim.playing) s.set({ anim: { ...s.anim, playing: false } });
  else play();
}

export function closePlayer() {
  const s = useStore.getState();
  s.set({ anim: { ...s.anim, playing: false, index: null } });
}

/** Steps to the start of the previous (-1) or next (+1) colour block. */
export function stepBlock(dir: -1 | 1) {
  const s = useStore.getState();
  const tl = currentTimeline();
  if (!tl) return;
  const i = s.anim.index ?? 0;
  const b = blockAt(tl, Math.min(i, tl.total - 1));
  if (dir > 0) seek(b + 1 < tl.blocks.length ? tl.blocks[b + 1].start : tl.total);
  // back: to this block's start, or the one before when already there
  else seek(i > tl.blocks[b].start ? tl.blocks[b].start : tl.blocks[Math.max(0, b - 1)].start);
}

/** Steps `n` records (stops playing). */
export function stepStitch(n: number) {
  const s = useStore.getState();
  seek((s.anim.index ?? s.plan?.flags.length ?? 0) + n);
}

let chasing = false;

/** Keeps the needle in view: playing glides the view towards it, scrubbing jumps. */
function follow(index: number, playing: boolean) {
  const s = useStore.getState();
  const plan = s.plan;
  const wrap = document.querySelector<HTMLElement>(".canvas-wrap");
  if (!plan || !wrap || index < 1) return;
  const i = Math.min(index, plan.flags.length) - 1;
  const { scale, ox, oy } = s.view;
  const x = plan.coords[2 * i] * scale + ox;
  const y = plan.coords[2 * i + 1] * scale + oy;
  const w = wrap.clientWidth;
  const h = wrap.clientHeight;
  const cx = w / 2;
  const cy = h / 2;
  const outside = x < w * 0.22 || x > w * 0.78 || y < h * 0.22 || y > h * 0.78;
  if (!playing) {
    if (outside) s.setView({ ox: ox + cx - x, oy: oy + cy - y });
    chasing = false;
    return;
  }
  if (outside) chasing = true;
  if (!chasing) return;
  const dx = cx - x;
  const dy = cy - y;
  if (Math.hypot(dx, dy) < 12) chasing = false;
  s.setView({ ox: ox + dx * 0.18, oy: oy + dy * 0.18 });
}

/** The playback loop and needle following; mounted once (in the bottom bar). */
export function usePlayback() {
  const playing = useStore((s) => s.anim.playing);
  const raf = useRef(0);
  useEffect(() => {
    if (!playing) return;
    let last = performance.now();
    let carry = 0;
    const tick = (t: number) => {
      const s = useStore.getState();
      // a frame's timestamp can come before the effect started: never step back
      const dt = Math.max(0, Math.min(0.1, (t - last) / 1000));
      last = t;
      const n = s.plan?.flags.length ?? 0;
      carry += playRate(s.anim.speed, n) * dt;
      const step = Math.floor(carry);
      carry -= step;
      const next = Math.min(n, (s.anim.index ?? 0) + step);
      if (next !== s.anim.index || next >= n) s.set({ anim: { ...s.anim, index: next, playing: next < n } });
      if (next < n) raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [playing]);
  useEffect(
    () =>
      useStore.subscribe((s, p) => {
        if (s.anim.follow && s.anim.index != null && (s.anim.index !== p.anim.index || !p.anim.follow)) follow(s.anim.index, s.anim.playing);
      }),
    [],
  );
}

let recording = false;

/** Records the stitch-out from the start at the player's speed and saves it as a WebM video. */
export async function recordVideo() {
  const s0 = useStore.getState();
  const total = s0.plan?.flags.length ?? 0;
  if (recording) return;
  if (!total || typeof MediaRecorder === "undefined") {
    s0.toast("Video recording is not supported here", "error");
    return;
  }
  recording = true;
  try {
    const canvas = startCapture();
    const stream = canvas.captureStream(30);
    const mime = MediaRecorder.isTypeSupported("video/webm;codecs=vp9") ? "video/webm;codecs=vp9" : "video/webm";
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 6_000_000 });
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const done = new Promise<void>((r) => (rec.onstop = () => r()));
    if (s0.viewMode === "vector") s0.set({ viewMode: "realistic" });
    s0.toast("Recording the stitch-out…");
    rec.start();
    const s = useStore.getState();
    s.set({ anim: { ...s.anim, index: 0, playing: true } });
    await new Promise<void>((r) => {
      const unsub = useStore.subscribe((st) => {
        if (!st.anim.playing) {
          unsub();
          setTimeout(r, 800);
        }
      });
    });
    rec.stop();
    await done;
    stopCapture();
    const bytes = new Uint8Array(await new Blob(chunks, { type: "video/webm" }).arrayBuffer());
    await saveFile(`${s0.doc.name || "design"}-stitchout.webm`, bytes, [{ name: "WebM video", extensions: ["webm"] }]);
  } finally {
    recording = false;
  }
}

// ---------------------------------------------------------------------------
// The panel

const HEIGHT_KEY = "filum.playerHeight";
const ROW = 26;
const RULER = 30;
const HEAD = 40;
const LABEL_W = 208;
/** Margins inside the track, so the first and last end markers show. */
const PAD_L = 12;
const PAD_R = 20;
const MIN_H = HEAD + RULER + ROW;
const MAX_ZOOM = 64;
const loadHeight = () => {
  const v = Number(localStorage.getItem(HEIGHT_KEY));
  return v >= MIN_H ? v : 220;
};

/** Merges markers closer than `gap` records (thousands of trims would only draw a solid line). */
function thin(at: number[], gap: number): number[] {
  const out: number[] = [];
  for (const a of at) if (!out.length || a - out[out.length - 1] >= gap) out.push(a);
  return out;
}

const pct = (i: number, total: number) => `${(100 * i) / Math.max(1, total)}%`;

interface RowInfo {
  block: TimelineBlock;
  color: string;
  title: string;
  name: string;
  seconds: number;
  /** The gradient this block is a colour of: its group, the layer's place and how many colours it has. */
  gradient?: { group: string; layer: number; of: number; first: boolean; last: boolean };
}

/** The parts of the rows that don't move while playing. */
const Tracks = memo(function Tracks({ rows, total, gap }: { rows: RowInfo[]; total: number; gap: number }) {
  return (
    <>
      {rows.map(({ block: b, color, title }) => (
        <div key={b.index} className="so-row" style={{ top: ROW * b.index }}>
          <div className="so-bar" style={{ left: pct(b.start, total), width: pct(b.end - b.start, total), ["--c" as string]: color }} title={title}>
            {thin(b.trims, gap).map((t) => (
              <i key={`t${t}`} className="so-trim" style={{ left: pct(t - b.start, b.end - b.start) }} />
            ))}
          </div>
          {b.stops.map((t) => (
            <span key={`s${t}`} className="so-mark stop" style={{ left: pct(t, total) }} title="The machine stops here">
              <MachineStop size={11} />
            </span>
          ))}
          {b.ending !== "end" && (
            <span className={`so-mark ${b.ending === "color" ? "change" : "stop"}`} style={{ left: pct(b.end, total) }} title={b.ending === "color" ? "Trim and change the thread" : "The machine stops"}>
              {b.ending === "color" ? <ColorChange size={11} /> : <MachineStop size={11} />}
            </span>
          )}
        </div>
      ))}
    </>
  );
});

export function StitchOutPanel() {
  const index = useStore((s) => s.anim.index);
  const playing = useStore((s) => s.anim.playing);
  const speed = useStore((s) => s.anim.speed);
  const following = useStore((s) => s.anim.follow);
  const plan = useStore((s) => s.plan);
  const doc = useStore((s) => s.doc);
  const set = useStore((s) => s.set);
  const [height, setHeight] = useState(loadHeight);
  const [view, setView] = useState(600);
  const [zoom, setZoom] = useState(1);
  const [hover, setHover] = useState<number | null>(null);
  const rowsRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  /** Scroll position to apply after a zoom renders (keeps the record under the pointer in place). */
  const pending = useRef<number | null>(null);
  const tl = useMemo(() => (plan ? timelineOf(plan, doc.machine) : null), [plan, doc.machine]);
  const seq = useMemo(() => colorSequence(doc, plan), [doc, plan]);
  const open = index != null;
  // the panel slides in and out (the canvas follows it, see Canvas keepInView):
  // it stays mounted while it closes
  const [phase, setPhase] = useState<"closed" | "opening" | "open" | "closing">(open ? "open" : "closed");
  useEffect(() => {
    if (open) setPhase((p) => (p === "open" ? p : "opening"));
    else setPhase((p) => (p === "closed" ? p : "closing"));
  }, [open]);

  // the track fills the body's width at zoom 1
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setView(Math.max(120, el.clientWidth - LABEL_W)));
    ro.observe(el);
    setView(Math.max(120, el.clientWidth - LABEL_W));
    return () => ro.disconnect();
  }, [open]);
  const trackW = view * zoom;
  const inner = Math.max(1, trackW - PAD_L - PAD_R);

  useLayoutEffect(() => {
    if (pending.current != null && bodyRef.current) bodyRef.current.scrollLeft = pending.current;
    pending.current = null;
  }, [zoom]);

  const total = tl?.total ?? 0;
  const at = Math.max(0, Math.min(total, index ?? total));
  const cur = tl ? blockAt(tl, Math.min(at, Math.max(0, total - 1))) : 0;

  /** Zoom around a point of the body (px from its left edge). */
  const zoomTo = (z: number, px?: number) => {
    const body = bodyRef.current;
    const next = Math.max(1, Math.min(MAX_ZOOM, z));
    if (!body || next === zoom) return;
    const x = px ?? LABEL_W + (body.clientWidth - LABEL_W) / 2;
    const frac = (body.scrollLeft + x - LABEL_W - PAD_L) / inner;
    const nextInner = view * next - PAD_L - PAD_R;
    pending.current = Math.max(0, frac * nextInner + PAD_L + LABEL_W - x);
    setZoom(next);
  };
  // Ctrl / ⌘ + wheel zooms the timeline (React's wheel listeners can't prevent the page zoom)
  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const wheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      const r = body.getBoundingClientRect();
      zoomTo(zoom * Math.exp(-e.deltaY * 0.004), e.clientX - r.left);
    };
    body.addEventListener("wheel", wheel, { passive: false });
    return () => body.removeEventListener("wheel", wheel);
  });

  // keep the block being sewn in view, and the needle when zoomed in
  useEffect(() => {
    const body = bodyRef.current;
    if (!body || !open) return;
    const top = RULER + ROW * cur;
    if (top < body.scrollTop + RULER || top + ROW > body.scrollTop + body.clientHeight) body.scrollTo({ top: Math.max(0, top - RULER - ROW), behavior: playing ? "smooth" : "auto" });
  }, [cur, open]);
  useEffect(() => {
    const body = bodyRef.current;
    if (!body || !open || zoom === 1 || !total) return;
    const x = LABEL_W + PAD_L + (at / total) * inner;
    const left = body.scrollLeft + LABEL_W + 24;
    const right = body.scrollLeft + body.clientWidth - 24;
    if (x < left || x > right) body.scrollLeft = Math.max(0, x - LABEL_W - (body.clientWidth - LABEL_W) * (playing ? 0.15 : 0.5));
  }, [at, zoom, open]);

  const rows: RowInfo[] = useMemo(() => {
    if (!tl || !plan) return [];
    const out = tl.blocks.map((b) => {
      const t = seq[b.index]?.thread ?? plan.threads[b.index];
      const name = t ? t.name || [t.brand, t.code].filter(Boolean).join(" ") || t.color.toUpperCase() : `Colour ${b.index + 1}`;
      const seconds = tl.secondsAt[b.end] - tl.secondsAt[b.start];
      // the object of the block's first stitch: is it a colour of a gradient?
      let obj: (typeof doc.objects)[number] | undefined;
      for (let i = b.start; i < b.end && !obj; i++) if (plan.objects[i] < doc.objects.length) obj = doc.objects[plan.objects[i]];
      const g = obj?.stitch.type === "fill" ? obj.stitch.gradient : undefined;
      const title = [
        `${b.index + 1}. ${t ? threadTitle(t) : name}`,
        g ? `Colour ${g.layer + 1} of ${g.stops.length} of a gradient (${obj!.name.replace(/ · colour \d+$/, "")})` : obj ? obj.name : "",
        `${b.stitches.toLocaleString()} stitches · ${fmtTime(seconds)} on the machine`,
        b.trims.length ? `${b.trims.length} trim${b.trims.length === 1 ? "" : "s"}` : "",
        b.stops.length ? `${b.stops.length} stop${b.stops.length === 1 ? "" : "s"}` : "",
      ]
        .filter(Boolean)
        .join("\n");
      return { block: b, color: t?.color ?? "#888", title, name, seconds, gradient: g ? { group: g.group, layer: g.layer, of: g.stops.length, first: false, last: false } : undefined };
    });
    // a bracket joins the neighbouring rows of one gradient
    out.forEach((r, i) => {
      if (!r.gradient) return;
      r.gradient.first = out[i - 1]?.gradient?.group !== r.gradient.group;
      r.gradient.last = out[i + 1]?.gradient?.group !== r.gradient.group;
    });
    return out;
  }, [tl, seq, plan, doc.objects]);

  if (phase === "closed" || !tl || !total) return null;

  const stitches = tl.stitchAt[total];
  const gap = Math.max(1, Math.ceil((total * 3) / inner));
  const step = tickStep(stitches, inner, 80);
  const ticks: { at: number; label: number }[] = [];
  // the ruler counts stitches; the bars are laid out by records
  for (let v = 0, r = 0; v <= stitches; v += step) {
    while (r < total && tl.stitchAt[r] < v) r++;
    ticks.push({ at: r, label: v });
  }

  const recordAt = (clientX: number) => {
    const el = rowsRef.current;
    if (!el) return 0;
    const r = el.getBoundingClientRect();
    return Math.max(0, Math.min(total, Math.round(((clientX - r.left) / Math.max(1, r.width)) * total)));
  };
  const scrubFrom = (e: RPointerEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    if (e.button !== 0) return;
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    seek(recordAt(e.clientX));
    const move = (ev: PointerEvent) => seek(recordAt(ev.clientX));
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };

  const resizeFrom = (e: RPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const y0 = e.clientY;
    const h0 = Math.min(height, fit);
    const max = Math.max(MIN_H, Math.min(fit, window.innerHeight * 0.6));
    let h = h0;
    const move = (ev: PointerEvent) => {
      h = Math.round(Math.max(MIN_H, Math.min(max, h0 + y0 - ev.clientY)));
      setHeight(h);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      localStorage.setItem(HEIGHT_KEY, String(h));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // a few blocks: the panel is only as tall as they need
  const fit = HEAD + RULER + rows.length * ROW + 10;
  const sewn = tl.stitchAt[at];
  const block = rows[cur];
  const left = tl.secondsAt[total] - tl.secondsAt[at];
  const hoverRow = hover != null ? rows[blockAt(tl, Math.min(hover, total - 1))] : null;
  const cuts = tl.blocks.reduce((n, b) => n + b.trims.length, 0) + tl.blocks.filter((b) => b.ending === "color").length;
  return (
    <section
      className={`stitchout ${playing ? "playing" : ""} ${phase === "opening" || phase === "closing" ? phase : ""}`}
      onAnimationEnd={(e) => e.target === e.currentTarget && setPhase(phase === "closing" ? "closed" : "open")}
      style={{ height: Math.min(height, fit), ["--so-label" as string]: `${LABEL_W}px`, ["--so-row" as string]: `${ROW}px` }} aria-label="Stitch-out">
      <div className="so-grip" onPointerDown={resizeFrom} title="Drag to resize" />
      <div className="so-head">
        <div className="so-transport" role="group" aria-label="Transport">
          <button title="To the start (Home)" onClick={() => seek(0)}>
            <ArrowLeftToLine size={14} />
          </button>
          <button title="Previous colour block (Shift+←)" onClick={() => stepBlock(-1)}>
            <BlockPrevious size={15} />
          </button>
          <button className="so-play" title={playing ? "Pause" : "Play"} aria-pressed={playing} onClick={togglePlay}>
            {playing ? <Pause size={14} fill="currentColor" /> : <Play size={14} fill="currentColor" />}
          </button>
          <button title="Next colour block (Shift+→)" onClick={() => stepBlock(1)}>
            <BlockNext size={15} />
          </button>
          <button title="To the end (End)" onClick={() => seek(total)}>
            <ArrowRightToLine size={14} />
          </button>
        </div>
        <div className="so-readout">
          <span className="so-count" title="Stitches sewn so far">
            <b>{sewn.toLocaleString()}</b>
            <span> / {stitches.toLocaleString()}</span>
          </span>
          <span className="so-pct">{Math.round((100 * at) / total)}%</span>
          <span className="so-clock" title={`Machine time at ${doc.machine.spm} spm, with trims and thread changes`}>
            {fmtTime(tl.secondsAt[at])}
            <span> / {fmtTime(tl.secondsAt[total])}</span>
          </span>
          {left > 0 && <span className="so-left">{fmtTime(left)} left</span>}
        </div>
        {block && (
          <span className="so-now" title={block.title}>
            <i style={{ background: block.color }} />
            <span className="so-now-n">{cur + 1}</span>
            <span className="so-now-name">{block.name}</span>
            {block.gradient && <GradientTool size={12} className="so-grad" />}
          </span>
        )}
        <div className="spacer" />
        <div className="so-zoom" role="group" aria-label="Timeline zoom">
          <button title="Zoom out (Ctrl+wheel)" disabled={zoom <= 1} onClick={() => zoomTo(zoom / 2)}>
            <ZoomOut size={13} />
          </button>
          <button className="so-zoom-v" title="Fit the whole stitch-out" onClick={() => zoomTo(1)}>
            {zoom === 1 ? "Fit" : `${zoom >= 10 ? Math.round(zoom) : zoom.toFixed(1).replace(/\.0$/, "")}×`}
          </button>
          <button title="Zoom in (Ctrl+wheel)" disabled={zoom >= MAX_ZOOM} onClick={() => zoomTo(zoom * 2)}>
            <ZoomIn size={13} />
          </button>
        </div>
        <label className="so-speed" title="Playback speed (stitches per second)">
          <Gauge size={13} />
          <select value={speed} onChange={(e) => set({ anim: { ...useStore.getState().anim, speed: +e.target.value } })}>
            {SPEEDS.map((v) => (
              <option key={v} value={v}>
                {speedLabel(v)}
              </option>
            ))}
          </select>
        </label>
        <button className={`icon-btn so-tog ${following ? "on" : ""}`} title="Follow the needle: keep it in view on the canvas" aria-pressed={following} onClick={() => set({ anim: { ...useStore.getState().anim, follow: !following } })}>
          <FollowNeedle size={15} />
        </button>
        <button className="icon-btn" title="Record a stitch-out video" onClick={recordVideo}>
          <Video size={15} />
        </button>
        <button className="icon-btn" title="Close (Esc)" onClick={closePlayer}>
          <X size={15} />
        </button>
      </div>
      <div className="so-body" ref={bodyRef} style={{ ["--rows" as string]: rows.length, gridTemplateColumns: `${LABEL_W}px ${trackW}px` }}>
        <div className="so-labels">
          <div className="so-corner">
            <span title="Colour blocks">{rows.length} blocks</span>
            <span title="Thread cuts: trims and thread changes">
              <Trim size={11} /> {cuts}
            </span>
          </div>
          {rows.map(({ block: b, color, name, title, seconds, gradient }) => (
            <button key={b.index} className={`so-label ${b.index === cur ? "on" : ""} ${b.index < cur ? "done" : ""}`} title={`${title}\nClick: go to this block`} onClick={() => seek(b.start)}>
              {gradient && <span className={`so-bracket ${gradient.first ? "first" : ""} ${gradient.last ? "last" : ""}`} aria-hidden />}
              <i className="so-sw" style={{ background: color }} />
              <span className="so-n">{b.index + 1}</span>
              <span className="so-name">{name}</span>
              {gradient && <GradientTool size={11} className="so-grad" />}
              <span className="so-meta">
                {b.stitches.toLocaleString()} · {fmtTime(seconds)}
              </span>
            </button>
          ))}
        </div>
        <div className="so-track" onPointerDown={scrubFrom} onPointerMove={(e) => setHover(recordAt(e.clientX))} onPointerLeave={() => setHover(null)}>
          <div className="so-ruler">
            <div className="so-scale">
              {ticks.map((t) => (
                <span key={t.label} style={{ left: pct(t.at, total) }}>
                  {t.label.toLocaleString()}
                </span>
              ))}
              {/* the colour sequence, sewn part in full colour */}
              <div className="so-ribbon">
                {rows.map(({ block: b, color }) => (
                  <i key={b.index} style={{ left: pct(b.start, total), width: pct(b.end - b.start, total), ["--c" as string]: color, ["--sewn" as string]: `${Math.max(0, Math.min(1, (at - b.start) / Math.max(1, b.end - b.start))) * 100}%` }} />
                ))}
              </div>
              {hover != null && hoverRow && (
                <span className={`so-hover-tip ${hover / total > 0.75 ? "flip" : ""}`} style={{ left: pct(hover, total) }}>
                  <i style={{ background: hoverRow.color }} />
                  {tl.stitchAt[hover].toLocaleString()} · {fmtTime(tl.secondsAt[hover])}
                </span>
              )}
            </div>
          </div>
          <div className="so-rows" ref={rowsRef}>
            {rows.map(({ block: b }) => (
              <div key={b.index} className={`so-lane ${b.index === cur ? "on" : ""}`} style={{ top: ROW * b.index }} />
            ))}
            <Tracks rows={rows} total={total} gap={gap} />
            {rows.map(({ block: b, color }) =>
              at > b.start ? (
                <div
                  key={b.index}
                  className={`so-fill ${b.index === cur && at < b.end ? "live" : ""}`}
                  style={{ top: ROW * b.index + (ROW - 10) / 2, left: pct(b.start, total), width: pct(Math.min(at, b.end) - b.start, total), ["--c" as string]: color }}
                />
              ) : null,
            )}
            {hover != null && <div className="so-hover" style={{ left: pct(hover, total) }} />}
          </div>
          <div className="so-needle" style={{ left: PAD_L + (at / total) * inner }}>
            <span />
          </div>
        </div>
      </div>
    </section>
  );
}
