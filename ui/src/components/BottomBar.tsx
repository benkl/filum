import { Camera, Focus, Pause, Play } from "lucide-react";
import { Hoop, Spool } from "../icons/stitch";
import { useEffect, useRef } from "react";
import { fit } from "../lib/actions";
import { saveFile } from "../lib/platform";
import { startCapture, stopCapture } from "../canvas/Canvas";
import { useStore } from "../store";
import { fmtTime } from "./ui";
import { STITCH_COLORS, colorSequence, threadUsage } from "../lib/threads";
import { threadTitle } from "./ThreadPicker";

export function BottomBar() {
  const doc = useStore((s) => s.doc);
  const plan = useStore((s) => s.plan);
  const anim = useStore((s) => s.anim);
  const view = useStore((s) => s.view);
  const activeThread = useStore((s) => s.activeThread);
  const colorFocus = useStore((s) => s.colorFocus);
  const stitchColors = useStore((s) => s.stitchColors);
  const set = useStore((s) => s.set);
  const raf = useRef(0);
  const total = plan?.flags.length ?? 0;

  useEffect(() => {
    if (!anim.playing) return;
    let last = performance.now();
    const tick = (t: number) => {
      const s = useStore.getState();
      const dt = (t - last) / 1000;
      last = t;
      const n = s.plan?.flags.length ?? 0;
      // ~ 1/12 of the design per second, at least 300 stitches/s
      const rate = Math.max(300, n / 12) * s.anim.speed;
      const next = Math.min(n, (s.anim.index ?? 0) + Math.max(1, Math.round(rate * dt)));
      s.set({ anim: { ...s.anim, index: next, playing: next < n } });
      if (next < n) raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [anim.playing]);

  const toggle = () => {
    if (!total) return;
    if (anim.playing) set({ anim: { ...anim, playing: false } });
    else {
      const start = anim.index == null || anim.index >= total ? 0 : anim.index;
      if (useStore.getState().viewMode === "vector") set({ viewMode: "realistic" });
      set({ anim: { ...anim, index: start, playing: true } });
    }
  };

  const recordVideo = async () => {
    if (!total || typeof MediaRecorder === "undefined") {
      useStore.getState().toast("Video recording is not supported here", "error");
      return;
    }
    const canvas = startCapture();
    const stream = canvas.captureStream(30);
    const mime = MediaRecorder.isTypeSupported("video/webm;codecs=vp9") ? "video/webm;codecs=vp9" : "video/webm";
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 6_000_000 });
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const done = new Promise<void>((r) => (rec.onstop = () => r()));
    if (useStore.getState().viewMode === "vector") set({ viewMode: "realistic" });
    useStore.getState().toast("Recording stitch-out…");
    rec.start();
    set({ anim: { index: 0, playing: true, speed: 1 } });
    await new Promise<void>((r) => {
      const unsub = useStore.subscribe((s) => {
        if (!s.anim.playing) {
          unsub();
          setTimeout(r, 800);
        }
      });
    });
    rec.stop();
    await done;
    stopCapture();
    const bytes = new Uint8Array(await new Blob(chunks, { type: "video/webm" }).arrayBuffer());
    await saveFile(`${doc.name || "design"}-stitchout.webm`, bytes, [{ name: "WebM video", extensions: ["webm"] }]);
    set({ anim: { index: null, playing: false, speed: 1 } });
  };

  const stats = plan?.stats;
  // threads in sew order (first use), with how many colour blocks each has
  const usage = threadUsage(doc, plan);
  const seq = colorSequence(doc, plan);
  const sewOrder: { t: (typeof doc.threads)[number]; n: number }[] = [];
  for (const b of seq) {
    const t = b.threadId ? doc.threads.find((x) => x.id === b.threadId) : undefined;
    if (!t) continue;
    const hit = sewOrder.find((x) => x.t.id === t.id);
    if (hit) hit.n++;
    else sewOrder.push({ t, n: 1 });
  }
  for (const t of doc.threads) if (!sewOrder.some((x) => x.t.id === t.id) && doc.objects.some((o) => o.thread === t.id)) sewOrder.push({ t, n: 0 });
  const shown = anim.index ?? total;
  const zooms = [0.5, 1, 3, 6];
  const actual = 96 / 25.4;
  return (
    <div className="bottombar">
      <div className="swatches">
        {sewOrder.map(({ t, n }, i) => {
          const u = usage.get(t.id);
          return (
            <button
              key={t.id}
              title={`${i + 1}. ${threadTitle(t)}${u && u.stitches ? `\n${u.stitches.toLocaleString()} stitches · ${u.metres.toFixed(1)} m${n > 1 ? ` · sewn in ${n} blocks` : ""}` : ""}\nClick: select its objects${colorFocus ? " and show only this colour" : ""} · double-click: thread colours`}
              className={`${activeThread === t.id ? "active" : ""} ${colorFocus && activeThread !== t.id ? "dim" : ""}`}
              style={{ background: t.color }}
              onClick={() => {
                const s = useStore.getState();
                s.select(s.doc.objects.filter((o) => o.thread === t.id).map((o) => o.id));
                s.set({ activeThread: t.id });
              }}
              onDoubleClick={() => useStore.getState().setDialog("threads")}
            >
              {n > 1 && <sub>{n}</sub>}
            </button>
          );
        })}
      </div>
      <div className="color-tools">
        <button
          className={`icon-btn ${colorFocus ? "on" : ""}`}
          style={{ border: 0, width: 24 }}
          title="Show only the active colour (dim the others)"
          disabled={!activeThread}
          onClick={() => set({ colorFocus: !colorFocus })}
        >
          <Focus size={15} />
        </button>
        <select className="select stitch-colors" value={stitchColors} title="Colour the stitches by" onChange={(e) => set({ stitchColors: e.target.value as typeof stitchColors })}>
          {STITCH_COLORS.map((c) => (
            <option key={c.id} value={c.id} title={c.title}>
              {c.label}
            </option>
          ))}
        </select>
        <button className="icon-btn" style={{ border: 0, width: 24 }} title="Thread colours…" onClick={() => useStore.getState().setDialog("threads")}>
          <Spool size={15} />
        </button>
      </div>
      <div className="vsep" />
      <button className="btn sm" title="Fit design (Shift+0)" onClick={() => fit("design")}>
        Fit
      </button>
      <button className="icon-btn" title="Fit hoop (0)" onClick={() => fit("hoop")}>
        <Hoop size={15} />
      </button>
      {zooms.map((z) => (
        <button
          key={z}
          className="btn sm ghost bb-zoom"
          style={Math.abs(view.scale / actual - z) < 0.02 ? { color: "var(--accent)", fontWeight: 600 } : undefined}
          title={z === 1 ? "Zoom 1× (actual size)" : `Zoom ${z}×`}
          onClick={() => fit(z)}
        >
          {z}×
        </button>
      ))}
      <div className="vsep" />
      <span className="stat">
        {anim.index != null ? `${shown.toLocaleString()} / ` : ""}
        {(stats?.stitches ?? 0).toLocaleString()} stitches
        {stats && <span className="bb-more">{` · ${stats.width.toFixed(0)}×${stats.height.toFixed(0)} mm · ${fmtTime(stats.seconds)}`}</span>}
      </span>
      {anim.index != null ? (
        <input
          className="scrub"
          type="range"
          min={0}
          max={total}
          value={shown}
          onChange={(e) => set({ anim: { ...anim, playing: false, index: +e.target.value } })}
          aria-label="Stitch-out position"
        />
      ) : (
        <div className="spacer" />
      )}
      <button className="btn sm" onClick={toggle} title="Animate stitch path">
        {anim.playing ? <Pause size={13} /> : <Play size={13} />} <span className="bb-label">{anim.playing ? "Pause" : "Animate"}</span>
      </button>
      {anim.index != null && !anim.playing && (
        <button className="btn sm ghost" onClick={() => set({ anim: { ...anim, index: null } })}>
          Done
        </button>
      )}
      <button className="btn sm" onClick={recordVideo} title="Export stitch-out video">
        <Camera size={13} /> <span className="bb-label">Video</span>
      </button>
    </div>
  );
}
