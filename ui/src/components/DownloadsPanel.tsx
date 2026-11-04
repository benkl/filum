// Preferences ▸ Downloads: what Filum includes (and under which
// licences), and the optional packs it may not include — each with its
// licence, a one-click "Accept & download" and its progress, removal and
// updates. The packs come from public/downloads/*.json (lib/downloads.ts).

import { Check, ChevronRight, Download, ExternalLink, PackageCheck, RefreshCw, Scale, Trash2, Type, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Spool } from "../icons/stitch";
import { formatBytes, installPack, removePack, useDownloads, type DownloadPack, type InstalledPack, type Progress } from "../lib/downloads";
import { embroideryIndex } from "../lib/fonts";
import { useStore } from "../store";
import { ExtLink } from "./ui";

type Job = { progress: Progress; abort: AbortController } | { error: string };

export function DownloadsPanel() {
  const { packs, installed } = useDownloads();
  const [jobs, setJobs] = useState<Record<string, Job>>({});
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const f = () => setOnline(navigator.onLine);
    window.addEventListener("online", f);
    window.addEventListener("offline", f);
    return () => {
      window.removeEventListener("online", f);
      window.removeEventListener("offline", f);
    };
  }, []);
  // a running download stops when Preferences closes
  const jobsRef = useRef(jobs);
  jobsRef.current = jobs;
  useEffect(() => () => Object.values(jobsRef.current).forEach((j) => "abort" in j && j.abort.abort()), []);

  const setJob = (id: string, j: Job | null) =>
    setJobs((m) => {
      const n = { ...m };
      if (j) n[id] = j;
      else delete n[id];
      return n;
    });
  const start = async (pack: DownloadPack) => {
    const abort = new AbortController();
    setJob(pack.id, { progress: { done: 0, total: pack.bytes, stage: "download" }, abort });
    try {
      await installPack(pack, (progress) => setJob(pack.id, { progress, abort }), abort.signal);
      setJob(pack.id, null);
      useStore.getState().toast(`${pack.title}: installed`, "success");
    } catch (e) {
      if ((e as Error).name === "AbortError") return setJob(pack.id, null);
      setJob(pack.id, { error: (e as Error).message || String(e) });
    }
  };
  const remove = async (pack: DownloadPack) => {
    if (!confirm(`Remove ${pack.title} from this device? Designs that use them keep their stitches, but can't be changed until you download them again.`)) return;
    await removePack(pack.id, pack.kind);
    useStore.getState().toast(`${pack.title}: removed`);
  };

  return (
    <>
      <section className="st-sec">
        <h4>Optional downloads</h4>
        <p className="dl-intro">
          Filum includes only what it may share with everyone. Some fonts and thread charts have licences that don't allow that, so you can download them
          yourself here: read the licence, then <b>Accept &amp; download</b>. They come straight from their authors' repositories and stay on this device.
        </p>
      </section>
      {packs === null ? (
        <p className="hint">Loading…</p>
      ) : !packs.length ? (
        <p className="hint">This version of Filum offers no downloads.</p>
      ) : (
        packs.map((p) => <PackCard key={p.id} pack={p} installed={installed.get(p.id)} job={jobs[p.id]} online={online} onStart={() => start(p)} onRemove={() => remove(p)} />)
      )}
      <Included />
    </>
  );
}

function PackCard({
  pack,
  installed,
  job,
  online,
  onStart,
  onRemove,
}: {
  pack: DownloadPack;
  installed?: InstalledPack;
  job?: Job;
  online: boolean;
  onStart: () => void;
  onRemove: () => void;
}) {
  const [open, setOpen] = useState(false);
  const running = job && "progress" in job ? job : null;
  const failed = job && "error" in job ? job.error : null;
  const outdated = !!installed && installed.version !== pack.version;
  const unit = pack.kind === "fonts" ? (pack.items.length === 1 ? "font" : "fonts") : pack.items.length === 1 ? "thread chart" : "thread charts";
  // no published licence: nothing to accept beyond using it for oneself
  const unlicensed = /^no licen[cs]e/i.test(pack.license.name);
  const pct = running ? Math.min(100, Math.round((running.progress.done / Math.max(1, running.progress.total)) * 100)) : 0;
  const licence = (
    <ExtLink href={pack.license.url} className="dl-link">
      {pack.license.name}
      <ExternalLink size={10} />
    </ExtLink>
  );
  return (
    <article className={`dl-card ${installed ? "installed" : ""}`}>
      <header className="dl-head">
        <span className="dl-icon">{pack.kind === "fonts" ? <Type size={17} /> : <Spool size={17} />}</span>
        <div className="dl-title">
          <b>{pack.title}</b>
          <span className="dl-meta">
            {pack.items.length} {unit} · {formatBytes(pack.bytes)} · from{" "}
            <ExtLink href={pack.source.url} title={pack.source.label}>
              {pack.source.label.split("/")[0]} on GitHub
            </ExtLink>
          </span>
        </div>
        <span className={`dl-status ${installed ? (outdated ? "update" : "ok") : ""}`}>
          {installed ? (
            outdated ? (
              "Update available"
            ) : (
              <>
                <Check size={12} /> Installed
              </>
            )
          ) : (
            "Not installed"
          )}
        </span>
      </header>
      <p className="dl-sum">{pack.summary}</p>
      <div className="dl-licence">
        <Scale size={15} />
        <div>
          <b>Licence: {licence}</b>
          <p>{pack.license.terms}</p>
        </div>
      </div>
      <button className={`dl-items-toggle ${open ? "open" : ""}`} onClick={() => setOpen(!open)} aria-expanded={open}>
        <ChevronRight size={12} />
        What's included
      </button>
      {open && (
        <ul className="dl-items">
          {pack.items.map((it) => (
            <li key={it.id}>
              <span>{it.name}</span>
              <span className="dl-item-meta">{it.count ? `${it.count} colours` : formatBytes(it.files.reduce((n, f) => n + f[1], 0))}</span>
            </li>
          ))}
        </ul>
      )}
      <footer className="dl-foot">
        {running ? (
          <>
            <div className="dl-bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
              <i style={{ width: `${pct}%` }} />
            </div>
            <span className="dl-prog">
              {running.progress.stage === "convert" ? "Preparing…" : `${formatBytes(running.progress.done)} of ${formatBytes(running.progress.total)}`}
            </span>
            <button className="btn sm ghost" onClick={() => running.abort.abort()}>
              <X size={13} /> Cancel
            </button>
          </>
        ) : installed && !outdated ? (
          <>
            <span className="dl-accepted">
              <PackageCheck size={14} />
              {unlicensed ? `Downloaded for your own use on ${new Date(installed.acceptedAt).toLocaleDateString()}` : `You accepted ${installed.license} on ${new Date(installed.acceptedAt).toLocaleDateString()}`}
            </span>
            <button className="btn sm ghost" onClick={onRemove}>
              <Trash2 size={13} /> Remove
            </button>
          </>
        ) : (
          <>
            <span className="dl-accept">
              {failed ? <span className="dl-err">Download failed: {failed}</span> : !online ? (
                "You're offline. Connect to the internet to download."
              ) : unlicensed ? (
                <>No licence is published ({licence}): by downloading you agree to use them only for yourself.</>
              ) : (
                <>By downloading you accept the {licence} licence.</>
              )}
            </span>
            {installed && (
              <button className="btn sm ghost" onClick={onRemove}>
                <Trash2 size={13} /> Remove
              </button>
            )}
            <button className="btn primary" disabled={!online} onClick={onStart}>
              {installed ? <RefreshCw size={14} /> : <Download size={14} />}
              {failed ? "Try again" : installed ? (unlicensed ? "Update" : "Accept & update") : unlicensed ? "Agree & download" : "Accept & download"}
            </button>
          </>
        )}
      </footer>
    </article>
  );
}

/** What ships with Filum, by licence. */
function Included() {
  const [fonts, setFonts] = useState<{ n: number; licences: string[] } | null>(null);
  const [charts, setCharts] = useState<number | null>(null);
  useEffect(() => {
    embroideryIndex()
      .then((ix) => {
        const bundled = ix.fonts.filter((f) => !f.download);
        const norm = (l: string) => (/open font/i.test(l) ? "SIL OFL" : /mublic|public/i.test(l) ? "public domain" : l.replace(/^S(CC)/, "$1").replace(/^CC-/, "CC "));
        setFonts({ n: bundled.length, licences: [...new Set(bundled.map((f) => norm(f.license)))].sort() });
      })
      .catch(() => {});
    fetch("/palettes/index.json")
      .then((r) => r.json())
      .then((j: { charts: { download?: string }[] }) => setCharts(j.charts.filter((c) => !c.download).length))
      .catch(() => {});
  }, []);
  return (
    <section className="st-sec">
      <h4>Included with Filum</h4>
      <ul className="dl-included">
        <li>
          <Type size={13} />
          <span>{fonts ? `${fonts.n} embroidery fonts` : "Embroidery fonts"}</span>
          <span className="dl-item-meta">{fonts ? fonts.licences.join(", ") : ""}</span>
        </li>
        <li>
          <Type size={13} />
          <span>3 outline fonts: Nunito, Bebas Neue, Pacifico</span>
          <span className="dl-item-meta">SIL OFL</span>
        </li>
        <li>
          <Spool size={13} />
          <span>{charts ? `${charts} thread charts` : "Thread charts"} from Ink/Stitch and Madeira colour cards</span>
          <span className="dl-item-meta">GPL-3.0, colours sampled from published cards</span>
        </li>
        <li>
          <PackageCheck size={13} />
          <span>On-device AI models (MobileSAM, DexiNed, Informative Drawings, Tesseract)</span>
          <span className="dl-item-meta">MIT, Apache-2.0</span>
        </li>
      </ul>
      <p className="hint">
        Filum itself is free software under the GPL-3.0-or-later.{" "}
        <button className="link" onClick={() => useStore.getState().setDialog("licenses")}>
          Every licence and its full text…
        </button>
      </p>
    </section>
  );
}
