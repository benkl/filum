import { Focus, Video } from "lucide-react";
import { Hoop, Spool, StitchOut } from "../icons/stitch";
import { fit } from "../lib/actions";
import { closePlayer, play, recordVideo, usePlayback } from "./StitchOut";
import { useStore } from "../store";
import { fmtTime } from "./ui";
import { STITCH_COLORS, colorSequence, threadUsage } from "../lib/threads";
import { threadTitle } from "./ThreadPicker";

export function BottomBar() {
  const doc = useStore((s) => s.doc);
  const plan = useStore((s) => s.plan);
  // only whether the player is open: the bar doesn't redraw on every stitch while it plays
  const playerOpen = useStore((s) => s.anim.index != null);
  const view = useStore((s) => s.view);
  const activeThread = useStore((s) => s.activeThread);
  const colorFocus = useStore((s) => s.colorFocus);
  const stitchColors = useStore((s) => s.stitchColors);
  const set = useStore((s) => s.set);
  const total = plan?.flags.length ?? 0;
  usePlayback();

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
        {(stats?.stitches ?? 0).toLocaleString()} stitches
        {stats && <span className="bb-more">{` · ${stats.width.toFixed(0)}×${stats.height.toFixed(0)} mm · ${fmtTime(stats.seconds)}`}</span>}
      </span>
      <div className="spacer" />
      <button
        className={`btn sm ${playerOpen ? "primary" : ""}`}
        disabled={!total}
        onClick={() => (playerOpen ? closePlayer() : play())}
        title={playerOpen ? "Close the stitch-out player (Esc)" : "Animate the stitch-out, with a timeline of the colour blocks"}
      >
        <StitchOut size={14} /> <span className="bb-label">Animate</span>
      </button>
      <button className="btn sm" onClick={recordVideo} disabled={!total} title="Record a stitch-out video">
        <Video size={14} /> <span className="bb-label">Video</span>
      </button>
    </div>
  );
}
