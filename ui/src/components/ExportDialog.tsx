// Export: format, machine and frame, options; on the right what the machine
// will make of the file — checks against the machine's limits and the colour
// sequence as the machine shows it. One file, or several at once in a ZIP
// (Ink/Stitch zip.py: formats, thread list, pictures, repeats).

import { AlertTriangle, CheckCircle2, XCircle } from "lucide-react";
import { exportTarget, exportZip, isPicture, PICTURE_SETTINGS, PNG_TARGETS, targetExtension, type PictureSettings } from "../lib/exportFiles";
import { PicturePreview, PictureOptionsPanel, RepeatOptions, StopPositionChoice, ZipFileList } from "./ExportExtras";
import { useEffect, useMemo, useState } from "react";
import { engine } from "../engine/client";
import { defaultDesignOptions, objectBounds, objectBoundsCached, unionBoxes } from "../lib/geometry";
import { cleanFileName, exportChecks, MACHINES, machineById, pickFrame, presetById, type CheckLevel, type OvalReach } from "../lib/machines";
import { inHoop, ovalNorm } from "../lib/materials";
import { useStore } from "../store";
import { FLAG, type ExportOptions, type FormatInfo, type MachineColorInfo } from "../types";
import { Dialog, fmtTime, Num } from "./ui";
import { FrameButtons, MachineOptions } from "./MachineOptions";
import { cutterOf, DEFAULT_CUT_OVER, uncutTrims } from "../lib/cuts";

const FORMAT_HINT: Record<string, string> = {
  pes: "Brother, Baby Lock",
  dst: "Tajima — every machine",
  jef: "Janome, Elna",
  exp: "Melco, Bernina",
  vp3: "Pfaff, Husqvarna Viking",
  xxx: "Singer, Compucon",
  pec: "Brother (stitches only)",
  u01: "Barudan",
  tbf: "Tajima, with colours",
  sew: "Janome (older machines)",
  gcode: "DIY machines (G-code)",
  csv: "Stitch list (spreadsheet)",
  txt: "Stitch list (text)",
  col: "Thread colours (text)",
  edr: "Thread colours (Embird)",
  inf: "Thread colours (Viking, Pfaff)",
  threadlist: "Thread list (Ink/Stitch)",
  png_realistic: "Realistic picture",
  png_simple: "Simple picture (lines)",
};
const PROJECT = ["filum", "svg"];
// files for people and software, not for the machine: what each one is for
const DATA_HINT: Record<string, string> = {
  csv: "Every stitch and command as a spreadsheet — for checking or scripting, not for the machine.",
  txt: "Every stitch and command as plain text (Ink/Stitch's TXT) — for checking, not for the machine.",
  col: "Only the thread colours, one per colour block. Save it next to a file without colours (such as a DST) under the same name so software shows the right threads.",
  edr: "Only the thread colours, one per colour block (Embird). Save it next to a file without colours (such as a DST) under the same name so software shows the right threads.",
  inf: "Only the threads (colour, name, chart), one per colour block. Save it next to the stitch file under the same name for Viking and Pfaff software.",
  threadlist: "Ink/Stitch's thread list: design details and the thread of every colour block, as text for the operator. Threads ▸ Apply thread list reads it back onto a design (e.g. a DST).",
};
const DATA = Object.keys(DATA_HINT);
const PICTURE_HINT: Record<string, string> = {
  png_realistic: "The design as it will look sewn (Ink/Stitch PNG realistic) — for mock-ups, shops and customers.",
  png_simple: "Every stitch as a flat line in its thread colour (Ink/Stitch PNG simple) — clear for checking and for colouring sheets.",
};
const loadJson = <T,>(key: string, fallback: T): T => {
  try {
    const v = localStorage.getItem(key);
    return v ? { ...fallback, ...JSON.parse(v) } : fallback;
  } catch {
    return fallback;
  }
};
/** SEW stores at most 12 colours (pystitch). */
const SEW_MAX_COLOURS = 12;

export function ExportDialog({ onClose }: { onClose: () => void }) {
  const doc = useStore((s) => s.doc);
  const plan = useStore((s) => s.plan);
  const stats = plan?.stats;
  // oval / round frames: how far the stitches reach, the design centred in the frame
  const reach = useMemo<OvalReach | undefined>(() => {
    if (!plan || !plan.flags.length) return undefined;
    const { coords, flags } = plan;
    let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
    for (let i = 0; i < flags.length; i++) {
      if (flags[i] & (FLAG.COLOR_CHANGE | FLAG.TRIM | FLAG.STOP | FLAG.END)) continue;
      const [x, y] = [coords[2 * i], coords[2 * i + 1]];
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
    const [cx, cy] = [(x0 + x1) / 2, (y0 + y1) / 2];
    return (w, h) => {
      let m = 0;
      for (let i = 0; i < flags.length; i++) {
        if (flags[i] & (FLAG.COLOR_CHANGE | FLAG.TRIM | FLAG.STOP | FLAG.END)) continue;
        m = Math.max(m, ovalNorm(cx, cy, w, h, coords[2 * i], coords[2 * i + 1]));
      }
      return m;
    };
  }, [plan]);
  const [formats, setFormats] = useState<FormatInfo[]>([]);
  const [fmt, setFmt] = useState(localStorage.getItem("filum.format") ?? "pes");
  const [pesVersion, setPesVersion] = useState<1 | 6>(() => (localStorage.getItem("filum.pesVersion") === "6" ? 6 : 1));
  // the design's machine and hoop (Design ▸ Machine): one value, changed here or there
  const machine = machineById(MACHINES.some((m) => m.id === doc.machine.profile) ? doc.machine.profile! : "doc");
  const sameHoop = (f: { width: number; height: number; shape?: string }) => doc.hoop.width === f.width && doc.hoop.height === f.height && (doc.hoop.shape ?? "rect") === (f.shape ?? "rect");
  const [name, setName] = useState(doc.name || "design");
  const [colours, setColours] = useState<MachineColorInfo[] | null>(null);
  // several files at once (Ink/Stitch ZIP export)
  const [zipMode, setZipMode] = useState(() => localStorage.getItem("filum.zip") === "1");
  const [zipTargets, setZipTargets] = useState<string[]>(() => {
    try {
      const v = JSON.parse(localStorage.getItem("filum.zipTargets") ?? "null");
      if (Array.isArray(v) && v.every((x) => typeof x === "string")) return v;
    } catch {
      /* default */
    }
    return [localStorage.getItem("filum.format") ?? "pes", "threadlist", "png_realistic"];
  });
  const [pics, setPics] = useState<PictureSettings>(() => loadJson("filum.pictures", PICTURE_SETTINGS));
  // repeats: next to each other with a 5 mm gap by default (Ink/Stitch: 100 mm)
  const [repeat, setRepeat] = useState<ExportOptions>(() => ({
    xRepeats: 1,
    yRepeats: 1,
    xSpacing: Math.ceil((stats?.width ?? 95) + 5),
    ySpacing: Math.ceil((stats?.height ?? 95) + 5),
  }));
  const toggleTarget = (t: string) => setZipTargets((v) => (v.includes(t) ? v.filter((x) => x !== t) : [...v, t]));
  useEffect(() => {
    engine.formats().then(setFormats);
  }, []);
  const isMachine = (f: string) => !PROJECT.includes(f) && !DATA.includes(f) && !isPicture(f);
  // the stitch file the checks and the colour sequence are about
  const checkFmt = zipMode ? (zipTargets.find(isMachine) ?? "") : fmt;
  const machineFormat = !!checkFmt && isMachine(checkFmt);
  const copies = (repeat.xRepeats ?? 1) * (repeat.yRepeats ?? 1);
  const opts = useMemo<ExportOptions>(() => ({ pesVersion, ...repeat }), [pesVersion, repeat]);
  // what the machine will show for each colour block
  useEffect(() => {
    let live = true;
    setColours(null);
    if (!stats?.stitches || !machineFormat) return;
    engine
      .machineColors(doc, checkFmt, { pesVersion })
      .then((c) => live && setColours(c))
      .catch(() => live && setColours([]));
    return () => {
      live = false;
    };
  }, [doc, checkFmt, pesVersion, stats?.stitches, machineFormat]);

  const box = unionBoxes(doc.objects.filter((o) => o.visible).map(objectBounds));
  const outsideHoop =
    !!box &&
    (box.x < -0.5 || box.y < -0.5 || box.x + box.w > doc.hoop.width + 0.5 || box.y + box.h > doc.hoop.height + 0.5 ||
      (doc.hoop.shape === "oval" && !!plan && (() => {
        const { coords, flags } = plan;
        for (let i = 0; i < flags.length; i++) if (!(flags[i] & (FLAG.COLOR_CHANGE | FLAG.TRIM | FLAG.STOP | FLAG.END)) && !inHoop(doc.hoop, coords[2 * i], coords[2 * i + 1], 0.5)) return true;
        return false;
      })()));
  const fileName = cleanFileName(name, machineFormat ? machine.fileNames : undefined);
  const distinct = useMemo(() => new Set((colours ?? []).map((c) => `${c.color}|${c.code}|${c.brand}`)).size, [colours]);
  // with repeats the file holds a bigger design
  const fileStats =
    stats && copies > 1
      ? {
          ...stats,
          stitches: stats.stitches * copies,
          width: stats.width + ((repeat.xRepeats ?? 1) - 1) * Math.abs(repeat.xSpacing ?? 100),
          height: stats.height + ((repeat.yRepeats ?? 1) - 1) * Math.abs(repeat.ySpacing ?? 100),
          trims: stats.trims * copies + (copies - 1) * (stats.colorChanges + 1),
          seconds: stats.seconds * copies,
        }
      : stats;
  // the chosen frame, else the smallest that fits the design (with its repeats)
  const frame = machine.frames.find(sameHoop) ?? pickFrame(machine, fileStats, copies === 1 ? reach : undefined) ?? null;
  const checks = exportChecks({
    machine,
    frame,
    format: checkFmt,
    stats: fileStats,
    hoop: doc.hoop,
    outsideHoop: outsideHoop && copies === 1,
    reach: copies === 1 ? reach : undefined,
    machineFormat,
    distinctColours: distinct,
    cuts: plan
      ? {
          cutter: cutterOf(doc.machine),
          uncut: (plan.uncut?.count ?? 0) * copies,
          brother: (uncutTrims(plan.flags, plan.coords, { kind: "jumps", over: DEFAULT_CUT_OVER })?.count ?? 0) * copies,
        }
      : undefined,
  });
  // colours the machine screen shows quite differently (the order is right)
  const far = (colours ?? []).filter((c) => c.shown && !c.exact && (c.deltaE ?? 0) > 10).length;
  if (far && checkFmt === "pes")
    checks.push({
      id: "far",
      level: "warn",
      title: `${far} colour${far === 1 ? " looks" : "s look"} different on the machine screen`,
      detail: `The nearest Brother colour is more than ΔE 10 away — the order is right, load your own spool${pesVersion === 1 ? "; PES v6 also stores the exact threads" : ""}`,
    });
  const blocks = stats?.stitches ? stats.colorChanges + 1 : 0;
  if (checkFmt === "sew" && blocks > SEW_MAX_COLOURS)
    checks.push({
      id: "sew-colours",
      level: "error",
      title: `${blocks} colours — SEW holds at most ${SEW_MAX_COLOURS}`,
      detail: "Merge colours, or export a JEF, which Janome machines also read",
    });
  const errors = checks.filter((c) => c.level === "error").length;
  const warnings = checks.filter((c) => c.level === "warn").length;
  const machineFormats = formats.filter((f) => f.canWrite && !PROJECT.includes(f.extension) && !DATA.includes(f.extension));
  const dataFormats = formats.filter((f) => f.canWrite && DATA.includes(f.extension));
  const pictureKinds = zipMode ? zipTargets.filter(isPicture) : isPicture(fmt) ? [fmt] : [];
  const hasPes = zipMode ? zipTargets.includes("pes") : fmt === "pes";
  const hasStitches = zipMode ? zipTargets.some((t) => t !== "svg" && t !== "filum") : !PROJECT.includes(fmt);
  /** A format button: picks the format, or in ZIP mode adds / removes it. */
  const fmtButton = (ext: string, label: string, hint: string, extra = "", title?: string) => {
    const on = zipMode ? zipTargets.includes(ext) : fmt === ext;
    return (
      <button key={ext} className={`${extra} ${zipMode ? "pick" : ""} ${on ? "on" : ""}`} onClick={() => (zipMode ? toggleTarget(ext) : setFmt(ext))} title={title}>
        <b>{label}</b>
        <span>{hint}</span>
      </button>
    );
  };
  /** The design's machine: its preset sets the stitch-out and time values too (as in Design ▸ Machine). */
  const pickMachine = (id: string) => {
    const p = presetById(id);
    useStore.getState().commit((d) => ({ ...d, machine: p ? { ...p.values, profile: p.id } : { ...d.machine, profile: undefined } }));
    const m = machineById(id);
    if (m.formats.length && !m.formats.includes(fmt) && isMachine(fmt)) setFmt(m.formats[0]);
  };
  /** A frame of the machine as the design's hoop. */
  const pickHoop = (f: { name: string; width: number; height: number; shape?: "rect" | "oval" }) =>
    useStore.getState().commit((d) => ({ ...d, hoop: { name: `${machine.brand} ${f.name}`.trim(), width: f.width, height: f.height, ...(f.shape ? { shape: f.shape } : {}) } }));
  const doExport = () => {
    // the default format (Preferences ▸ Export) is a file format, not a picture
    if (!isPicture(fmt) && fmt !== "threadlist") localStorage.setItem("filum.format", fmt);
    localStorage.setItem("filum.pesVersion", String(pesVersion));
    localStorage.setItem("filum.zip", zipMode ? "1" : "0");
    localStorage.setItem("filum.zipTargets", JSON.stringify(zipTargets));
    localStorage.setItem("filum.pictures", JSON.stringify(pics));
    onClose();
    if (zipMode) exportZip(zipTargets, opts, pics, fileName);
    else exportTarget(fmt, opts, pics, fileName);
  };
  const ext = targetExtension(fmt);
  const icon = (l: CheckLevel) => (l === "ok" ? <CheckCircle2 size={15} /> : l === "warn" ? <AlertTriangle size={15} /> : <XCircle size={15} />);

  return (
    <Dialog
      live
      wide
      title="Export"
      onClose={onClose}
      footer={
        <>
          {machineFormat && (
            <span className={`xp-verdict ${errors ? "error" : warnings ? "warn" : "ok"}`}>
              {icon(errors ? "error" : warnings ? "warn" : "ok")}
              {errors ? `${errors} problem${errors === 1 ? "" : "s"}` : warnings ? `${warnings} note${warnings === 1 ? "" : "s"}` : "Ready for the machine"}
            </span>
          )}
          <div className="spacer" />
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className={`btn ${errors ? "danger" : "primary"}`}
            disabled={(!stats?.stitches && hasStitches) || (zipMode && !zipTargets.length)}
            onClick={doExport}
            title={errors ? "The machine will probably reject this file" : undefined}
          >
            {errors ? "Export anyway" : zipMode ? `Export ${fileName}.zip` : `Export ${fileName}.${ext}`}
          </button>
        </>
      }
    >
      <div className="xp">
        <div className="xp-side">
          <section className="xp-sec">
            <h4>Machine</h4>
            <select className="select" value={machine.id} onChange={(e) => pickMachine(e.target.value)} title={`${machine.models} — the design's machine (Design ▸ Machine)`}>
              <MachineOptions />
            </select>
            <p className="hint xp-models" title={machine.models}>
              {machine.models}
            </p>
            {machine.frames.length > 0 && (
              <FrameButtons
                frames={machine.frames}
                isOn={(f) => sameHoop(f)}
                onPick={pickHoop}
              />
            )}
          </section>

          <section className="xp-sec">
            <h4>Format</h4>
            <div className="seg seg-full xp-mode">
              <button className={!zipMode ? "on" : ""} onClick={() => setZipMode(false)} title="Save one file">
                One file
              </button>
              <button className={zipMode ? "on" : ""} onClick={() => setZipMode(true)} title="Several formats, the thread list and pictures in one ZIP (Ink/Stitch ZIP export)">
                Several · ZIP
              </button>
            </div>
            <div className="xp-formats">
              {machineFormats.map((f) => {
                const reads = machine.id === "doc" || machine.formats.includes(f.extension);
                return fmtButton(
                  f.extension,
                  `.${f.extension.toUpperCase()}`,
                  FORMAT_HINT[f.extension] ?? f.name,
                  reads ? "" : "other",
                  reads ? f.name : `${f.name} — not read by ${machine.brand} machines`,
                );
              })}
              {PROJECT.map((e) => fmtButton(e, `.${e === "filum" ? "FILUM" : "SVG"}`, e === "svg" ? "Ink/Stitch, editable" : "Project, lossless", "project"))}
            </div>
          </section>

          {dataFormats.length > 0 && (
            <section className="xp-sec">
              <h4>Thread lists &amp; stitch data</h4>
              <div className="xp-formats">
                {dataFormats.map((f) => fmtButton(f.extension, `.${targetExtension(f.extension).toUpperCase()}`, FORMAT_HINT[f.extension] ?? f.name, "", f.name))}
              </div>
            </section>
          )}

          <section className="xp-sec">
            <h4>Pictures</h4>
            <div className="xp-formats">{PNG_TARGETS.map((t) => fmtButton(t, ".PNG", FORMAT_HINT[t], "", PICTURE_HINT[t]))}</div>
          </section>

          <section className="xp-sec">
            <h4>File</h4>
            <label className="xp-name">
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} spellCheck={false} />
              <span className="stat">{zipMode ? ".zip" : `.${ext}`}</span>
            </label>
            {fileName !== name.trim() && <p className="hint">Saved as “{fileName}.{zipMode ? "zip" : ext}”</p>}
            {hasPes && (
              <>
                <h4>PES version</h4>
                <div className="seg seg-full">
                  <button className={pesVersion === 1 ? "on" : ""} onClick={() => setPesVersion(1)} title="What Ink/Stitch writes: colours are entries of Brother's thread table — every Brother machine reads it">
                    v1 · Brother colours
                  </button>
                  <button className={pesVersion === 6 ? "on" : ""} onClick={() => setPesVersion(6)} title="Adds the exact thread list (brand, code, name, colour) for machines and software that read PES 6">
                    v6 · exact threads
                  </button>
                </div>
                <p className="hint">{pesVersion === 1 ? "Most compatible — Brother thread colours." : "Exact threads; older machines may not read v6."}</p>
              </>
            )}
            {pictureKinds.length > 0 && <PictureOptionsPanel kinds={pictureKinds} pics={pics} set={setPics} />}
            {hasStitches && <OriginChoice />}
            {hasStitches && <StopPositionChoice stops={stats?.stops ?? 0} />}
            {hasStitches && <RepeatOptions opts={repeat} set={setRepeat} width={stats?.width ?? 0} height={stats?.height ?? 0} />}
          </section>
        </div>

        <div className="xp-main">
          {fileStats && (
            <div className="stats-grid">
              <div className="stat-card">
                <div className="v">{fileStats.stitches.toLocaleString()}</div>
                <div className="k">stitches{copies > 1 ? ` · ${copies} copies` : ""}</div>
              </div>
              <div className="stat-card">
                <div className="v">{fileStats.colorChanges + (fileStats.stitches ? 1 : 0)}</div>
                <div className="k">colours · {fileStats.trims} trims</div>
              </div>
              <div className="stat-card">
                <div className="v">
                  {fileStats.width.toFixed(0)} × {fileStats.height.toFixed(0)}
                </div>
                <div className="k">mm</div>
              </div>
              <div className="stat-card">
                <div className="v">{fmtTime(fileStats.seconds)}</div>
                <div className="k">at {doc.machine.spm} spm</div>
              </div>
            </div>
          )}
          {zipMode && <ZipFileList targets={zipTargets} name={fileName} onRemove={toggleTarget} />}
          {pictureKinds.length > 0 && !(zipMode && machineFormat) && <PicturePreview kind={pictureKinds[0]} pics={pics} opts={opts} />}
          {machineFormat ? (
            <>
              <div className="xp-checks">
                {checks.map((c) => (
                  <div key={c.id} className={`xp-check ${c.level}`}>
                    {icon(c.level)}
                    <div>
                      <b>{c.title}</b>
                      <span>{c.detail}</span>
                    </div>
                  </div>
                ))}
              </div>
              {colours && colours.length > 0 && <MachineColours colours={colours} fmt={checkFmt} />}
            </>
          ) : zipMode || isPicture(fmt) ? (
            isPicture(fmt) && !zipMode && <p className="hint">{PICTURE_HINT[fmt]}</p>
          ) : (
            <p className="hint">
              {DATA_HINT[fmt] ??
                (fmt === "svg"
                  ? "An SVG with Ink/Stitch parameters: open it in Inkscape with Ink/Stitch to keep editing or export from there."
                  : "The Filum project keeps every object, setting and colour edit.")}
            </p>
          )}
        </div>
      </div>
    </Dialog>
  );
}

/**
 * The thread to load for every colour block and what the machine will show
 * for it: PES / PEC store entries of Brother's thread table, JEF Janome's,
 * DST / EXP no colours at all.
 */
function MachineColours({ colours, fmt }: { colours: MachineColorInfo[]; fmt: string }) {
  const table = fmt === "jef" || fmt === "sew" ? "Janome" : "Brother";
  const noColours = colours.every((c) => !c.shown);
  const exact = colours.every((c) => c.exact);
  return (
    <div className="exp-colours">
      <div className="exp-colours-head">
        <b>Colour sequence on the machine</b>
        <span className="stat">
          {noColours
            ? "This format stores no colours: the machine stops at every change — load the threads in this order."
            : exact
              ? "The file stores the exact threads."
              : `The file stores ${table} thread-table colours; load your spool when the machine shows its ${table} colour.`}
        </span>
      </div>
      <div className="exp-colours-list">
        {colours.map((c) => (
          <div key={c.block} className="exp-colour">
            <span className="ec-n">{c.block + 1}</span>
            <i style={{ background: c.color }} />
            <span className="ec-name" title={[c.brand, c.code, c.name].filter(Boolean).join(" ")}>
              {[c.brand, c.code].filter(Boolean).join(" ")} <span className="stat">{c.name}</span>
            </span>
            {c.shown && !c.exact && (
              <>
                <span className="stat">→</span>
                <i style={{ background: c.shown.color }} />
                <span className="ec-name" title={`${table} ${c.shown.code} ${c.shown.name}`}>
                  {table} {c.shown.code} <span className="stat">{c.shown.name}</span>
                </span>
                <span className={`ec-de ${(c.deltaE ?? 0) > 10 ? "far" : ""}`}>ΔE {(c.deltaE ?? 0).toFixed(0)}</span>
              </>
            )}
            {c.exact && <span className="badge ok">exact</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Where the design sits in the machine file: its centre (the usual), or a
 *  chosen point (Ink/Stitch "origin" command) — e.g. the top-left corner. */
function OriginChoice() {
  const origin = useStore((s) => s.doc.options?.origin);
  const commit = useStore((s) => s.commit);
  const set = (o: [number, number] | undefined) => commit((d) => ({ ...d, options: { ...(d.options ?? defaultDesignOptions()), origin: o } }));
  const corner = (): [number, number] | null => {
    const d = useStore.getState().doc;
    const b = unionBoxes(d.objects.filter((o) => o.visible).map((o) => objectBoundsCached(o)));
    return b ? [+b.x.toFixed(2), +b.y.toFixed(2)] : null;
  };
  return (
    <>
      <h4>Origin</h4>
      <div className="seg seg-full">
        <button className={!origin ? "on" : ""} onClick={() => set(undefined)} title="The design is centred on the needle position (machine default)">
          Centre
        </button>
        <button
          className={origin ? "on" : ""}
          onClick={() => {
            const c = corner();
            if (c) set(c);
          }}
          title="A fixed point becomes the needle position: the top-left corner of the design, or the point set here (Ink/Stitch origin command)"
        >
          Point
        </button>
      </div>
      {origin && (
        <div className="xp-origin">
          <label className="ctx-field">
            X <Num value={origin[0]} unit="mm" step={1} onChange={(v) => set([v, origin[1]])} />
          </label>
          <label className="ctx-field">
            Y <Num value={origin[1]} unit="mm" step={1} onChange={(v) => set([origin[0], v])} />
          </label>
        </div>
      )}
    </>
  );
}
