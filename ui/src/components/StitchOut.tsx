// The stitch-out player: a timeline of the colour blocks under the canvas,
// the playback loop, following the needle and the stitch-out video.

import { ArrowLeftToLine, ArrowRightToLine, Camera, LocateFixed, OctagonPause, Pause, Play, SkipBack, SkipForward, X } from "lucide-react";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from "react";
import { ColorChange, Trim } from "../icons/stitch";
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
const ROW = 22;
const MIN_H = 28 + 22 + ROW;
const loadHeight = () => {
  const v = Number(localStorage.getItem(HEIGHT_KEY));
  return v >= MIN_H ? v : 168;
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
            {b.stops.map((t) => (
              <i key={`s${t}`} className="so-stop" style={{ left: pct(t - b.start, b.end - b.start) }} title="The machine stops here" />
            ))}
          </div>
          {b.ending !== "end" && (
            <span className="so-end" style={{ left: pct(b.end, total) }} title={b.ending === "color" ? "Trim and change the thread" : "The machine stops"}>
              {b.ending === "color" ? <ColorChange size={11} /> : <OctagonPause size={11} />}
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
  const [width, setWidth] = useState(600);
  const trackRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const tl = useMemo(() => (plan ? timelineOf(plan, doc.machine) : null), [plan, doc.machine]);
  const seq = useMemo(() => colorSequence(doc, plan), [doc, plan]);

  useLayoutEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, [index == null]);

  const total = tl?.total ?? 0;
  const at = Math.max(0, Math.min(total, index ?? total));
  const cur = tl ? blockAt(tl, Math.min(at, Math.max(0, total - 1))) : 0;

  // keep the block being sewn in view
  useEffect(() => {
    const body = bodyRef.current;
    if (!body || index == null) return;
    const top = 22 + ROW * cur;
    if (top < body.scrollTop + 22 || top + ROW > body.scrollTop + body.clientHeight) body.scrollTo({ top: Math.max(0, top - 22 - ROW), behavior: playing ? "smooth" : "auto" });
  }, [cur, index == null]);

  const rows: RowInfo[] = useMemo(
    () =>
      (tl?.blocks ?? []).map((b) => {
        const t = seq[b.index]?.thread ?? plan?.threads[b.index];
        const name = t ? t.name || [t.brand, t.code].filter(Boolean).join(" ") || t.color.toUpperCase() : `Colour ${b.index + 1}`;
        const secs = tl ? tl.secondsAt[b.end] - tl.secondsAt[b.start] : 0;
        const title = [
          `${b.index + 1}. ${t ? threadTitle(t) : name}`,
          `${b.stitches.toLocaleString()} stitches · ${fmtTime(secs)} on the machine`,
          b.trims.length ? `${b.trims.length} trim${b.trims.length === 1 ? "" : "s"}` : "",
          b.stops.length ? `${b.stops.length} stop${b.stops.length === 1 ? "" : "s"}` : "",
        ]
          .filter(Boolean)
          .join("\n");
        return { block: b, color: t?.color ?? "#888", title, name };
      }),
    [tl, seq, plan],
  );

  if (index == null || !tl || !total) return null;

  const gap = Math.max(1, Math.ceil((total * 3) / Math.max(1, width)));
  const step = tickStep(tl.stitchAt[total], width);
  const ticks: { at: number; label: number }[] = [];
  // the ruler counts stitches; the bars are laid out by records
  for (let v = 0, r = 0; v <= tl.stitchAt[total]; v += step) {
    while (r < total && tl.stitchAt[r] < v) r++;
    ticks.push({ at: r, label: v });
  }

  const scrubFrom = (e: RPointerEvent<HTMLDivElement>) => {
    const rowsEl = trackRef.current;
    const el = e.currentTarget;
    if (!rowsEl || e.button !== 0) return;
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    const to = (x: number) => {
      const r = rowsEl.getBoundingClientRect();
      seek(((x - r.left) / Math.max(1, r.width)) * total);
    };
    to(e.clientX);
    const move = (ev: PointerEvent) => to(ev.clientX);
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
    const h0 = height;
    const max = Math.max(MIN_H, window.innerHeight * 0.6);
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

  const sewn = tl.stitchAt[at];
  const block = rows[cur];
  return (
    <section className="stitchout" style={{ height }} aria-label="Stitch-out">
      <div className="so-grip" onPointerDown={resizeFrom} title="Drag to resize" />
      <div className="so-head">
        <button className="icon-btn" title="To the start (Home)" onClick={() => seek(0)}>
          <ArrowLeftToLine size={14} />
        </button>
        <button className="icon-btn" title="Previous colour block (Shift+←)" onClick={() => stepBlock(-1)}>
          <SkipBack size={14} />
        </button>
        <button className={`so-play ${playing ? "on" : ""}`} title={playing ? "Pause" : "Play"} onClick={togglePlay}>
          {playing ? <Pause size={13} /> : <Play size={13} />}
        </button>
        <button className="icon-btn" title="Next colour block (Shift+→)" onClick={() => stepBlock(1)}>
          <SkipForward size={14} />
        </button>
        <button className="icon-btn" title="To the end (End)" onClick={() => seek(total)}>
          <ArrowRightToLine size={14} />
        </button>
        <div className="vsep" />
        <span className="so-count" title="Stitches sewn so far">
          <b>{sewn.toLocaleString()}</b> / {tl.stitchAt[total].toLocaleString()}
        </span>
        <span className="so-clock" title={`Machine time at ${doc.machine.spm} spm, with trims and thread changes`}>
          {fmtTime(tl.secondsAt[at])} / {fmtTime(tl.secondsAt[total])}
        </span>
        {block && (
          <span className="so-now" title={block.title}>
            <i style={{ background: block.color }} />
            {cur + 1}/{rows.length} · {block.name}
          </span>
        )}
        <div className="spacer" />
        <select className="select so-speed" value={speed} title="Playback speed (stitches per second)" onChange={(e) => set({ anim: { ...useStore.getState().anim, speed: +e.target.value } })}>
          {SPEEDS.map((v) => (
            <option key={v} value={v}>
              {speedLabel(v)}
            </option>
          ))}
        </select>
        <button className={`icon-btn ${following ? "on" : ""}`} title="Follow the needle (keep it in view)" onClick={() => set({ anim: { ...useStore.getState().anim, follow: !following } })}>
          <LocateFixed size={14} />
        </button>
        <button className="icon-btn" title="Record a stitch-out video" onClick={recordVideo}>
          <Camera size={14} />
        </button>
        <button className="icon-btn" title="Close (Esc)" onClick={closePlayer}>
          <X size={14} />
        </button>
      </div>
      <div className="so-body" ref={bodyRef} style={{ ["--rows" as string]: rows.length }}>
        <div className="so-labels">
          <div className="so-corner" title="Thread cuts: trims and thread changes">
            <Trim size={11} /> {tl.blocks.reduce((n, b) => n + b.trims.length, 0) + tl.blocks.filter((b) => b.ending === "color").length}
          </div>
          {rows.map(({ block: b, color, name, title }) => (
            <button key={b.index} className={`so-label ${b.index === cur ? "on" : ""}`} title={`${title}\nClick: go to this block`} onClick={() => seek(b.start)}>
              <i style={{ background: color }} />
              <span className="so-n">{b.index + 1}</span>
              <span className="so-name">{name}</span>
            </button>
          ))}
        </div>
        <div className="so-track" onPointerDown={scrubFrom}>
          <div className="so-ruler">
            <div className="so-scale">
              {ticks.map((t) => (
                <span key={t.label} style={{ left: pct(t.at, total) }}>
                  {t.label.toLocaleString()}
                </span>
              ))}
            </div>
          </div>
          <div className="so-rows" ref={trackRef}>
            {rows.map(({ block: b }) => (
              <div key={b.index} className={`so-lane ${b.index === cur ? "on" : ""}`} style={{ top: ROW * b.index }} />
            ))}
            <Tracks rows={rows} total={total} gap={gap} />
            {rows.map(({ block: b, color }) =>
              at > b.start ? <div key={b.index} className="so-fill" style={{ top: ROW * b.index + 7, left: pct(b.start, total), width: pct(Math.min(at, b.end) - b.start, total), ["--c" as string]: color }} /> : null,
            )}
          </div>
          <div className="so-needle" style={{ ["--at" as string]: at / total }} />
        </div>
      </div>
    </section>
  );
}
