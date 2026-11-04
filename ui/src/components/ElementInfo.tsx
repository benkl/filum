// Element info (Ink/Stitch "Element info"): for the selected objects their
// type, method, size, stitches, small stitches left out, jumps and the
// longest / shortest stitch — and the totals of the selection (or the whole
// design): colours, colour changes, jumps, trims, stops. Copy as a table.

import { Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { engine } from "../engine/client";
import { useStore } from "../store";
import type { ElementInfo, ObjectInfo } from "../types";
import { Section } from "./ui";
import "../output.css";

const KIND: Record<string, string> = {
  fill: "Fill",
  satin: "Satin column",
  running: "Stroke",
  applique: "Appliqué",
  manual: "Manual stitch",
  none: "Not stitched",
};
const METHOD: Record<string, string> = {
  tatami: "Auto fill (tatami)",
  contour: "Contour fill",
  guided: "Guided fill",
  meander: "Meander fill",
  circular: "Circular fill",
  cross: "Cross stitch",
  flow: "Flow fill",
  curved: "Curved fill",
  satin: "Satin column",
  eStitch: "E-stitch",
  sStitch: "S-stitch",
  zigzag: "Zig-zag",
  running: "Running stitch",
  bean: "Bean stitch",
  ripple: "Ripple stitch",
  stem: "Stem stitch",
  motif: "Motif stitch",
};
/** "streamline" → "Streamline", "linearGradient" → "Linear gradient". */
const words = (id: string) => (id ? (id[0].toUpperCase() + id.slice(1)).replace(/([a-z])([A-Z])/g, (_, a, b) => `${a} ${b.toLowerCase()}`) : "");
export const methodLabel = (o: Pick<ObjectInfo, "kind" | "method">) => (o.method ? (METHOD[o.method] ?? `${words(o.method)}${o.kind === "fill" ? " fill" : ""}`) : (KIND[o.kind] ?? words(o.kind)));
const mm = (v: number) => v.toFixed(2);

/** Ink/Stitch's export text: one tab-separated line per object. */
export function infoTable(info: ElementInfo): string {
  let s = "element_id\ttype\tmethod\tdimensions\tstitches\tjumps\tmax_stitch_length\tmin_stitch_length\n";
  for (const o of info.objects) s += `${o.id}\t${KIND[o.kind] ?? o.kind}\t${methodLabel(o)}\t${mm(o.width)} x ${mm(o.height)}\t${o.stitches}\t${o.jumps}\t${mm(o.maxStitch)}\t${mm(o.minStitch)}\n`;
  return s;
}

function useElementInfo(ids: string[]): ElementInfo | null {
  const doc = useStore((s) => s.doc);
  const plan = useStore((s) => s.plan);
  const [info, setInfo] = useState<ElementInfo | null>(null);
  const key = ids.join(",");
  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      engine
        .elementInfo(doc, ids)
        .then((i) => live && setInfo(i))
        .catch(() => live && setInfo(null));
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
    // the plan changes with everything that changes stitches
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan, key]);
  return info;
}

function ObjectRows({ o }: { o: ObjectInfo }) {
  return (
    <dl className="ei-grid">
      <dt>Type</dt>
      <dd>{KIND[o.kind] ?? words(o.kind)}</dd>
      {o.method && (
        <>
          <dt>Method</dt>
          <dd>{methodLabel(o)}</dd>
        </>
      )}
      <dt>Dimensions</dt>
      <dd>
        {mm(o.width)} × {mm(o.height)} mm
      </dd>
      <dt>Stitches</dt>
      <dd className={o.stitches ? "" : "warn"} title={o.hidden ? "Not stitched: hidden, or covered by objects on top (remove hidden stitching)" : undefined}>
        {o.stitches.toLocaleString()}
      </dd>
      <dt title="Stitches shorter than the minimum stitch length (Design ▸ Stitch-out) are left out">Small stitches (removed)</dt>
      <dd>{o.smallRemoved.toLocaleString()}</dd>
      <dt title="Jumps inside the object (not the one that brings the needle to it)">Jumps</dt>
      <dd>{o.jumps}</dd>
      <dt>Max stitch length</dt>
      <dd>{mm(o.maxStitch)} mm</dd>
      <dt>Min stitch length</dt>
      <dd>{mm(o.minStitch)} mm</dd>
    </dl>
  );
}

function Panel({ ids }: { ids: string[] }) {
  const info = useElementInfo(ids);
  const toast = useStore((s) => s.toast);
  if (!info) return <p className="hint">Counting…</p>;
  const t = info.total;
  const single = ids.length === 1 && info.objects.length === 1;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(infoTable(info));
      toast(`Copied the info of ${info.objects.length} object${info.objects.length === 1 ? "" : "s"} as a table`, "success");
    } catch {
      toast("Could not copy to the clipboard", "error");
    }
  };
  return (
    <div className="ei">
      {single ? (
        <ObjectRows o={info.objects[0]} />
      ) : (
        <>
          <dl className="ei-grid">
            <dt>{ids.length ? "Selected objects" : "Objects"}</dt>
            <dd>{t.objects}</dd>
            <dt>Dimensions</dt>
            <dd>
              {mm(t.width)} × {mm(t.height)} mm
            </dd>
            <dt>Colours</dt>
            <dd>{t.colors}</dd>
            <dt>Colour changes</dt>
            <dd>{t.colorChanges}</dd>
            <dt>Jumps</dt>
            <dd>{t.jumps}</dd>
            <dt>Trims</dt>
            <dd>{t.trims}</dd>
            <dt>Stops</dt>
            <dd>{t.stops}</dd>
            <dt>Stitches</dt>
            <dd>{t.stitches.toLocaleString()}</dd>
            <dt>Small stitches (removed)</dt>
            <dd>{t.smallRemoved.toLocaleString()}</dd>
            <dt>Min stitch length</dt>
            <dd>{mm(t.minStitch)} mm</dd>
            <dt>Max stitch length</dt>
            <dd>{mm(t.maxStitch)} mm</dd>
            <dt title="Design ▸ Stitch-out ▸ Min. stitch">Filter stitches smaller than</dt>
            <dd>{mm(t.minStitchFilter)} mm</dd>
          </dl>
          {info.objects.length > 1 && info.objects.length <= 40 && (
            <Section title={`Each object (${info.objects.length})`} defaultOpen={false}>
              {info.objects.map((o) => (
                <div key={o.id} className="ei-obj">
                  <div className="ei-obj-head">
                    <i style={{ background: o.color }} />
                    <span>{o.name || o.id}</span>
                  </div>
                  <ObjectRows o={o} />
                </div>
              ))}
            </Section>
          )}
        </>
      )}
      <div className="ei-actions">
        <button className="btn sm ghost" onClick={copy} title="Copy every object's info as a tab-separated table (Ink/Stitch's element info export) — paste it into a spreadsheet">
          <Copy size={12} /> Copy table
        </button>
      </div>
    </div>
  );
}

/** "Info" section of the Properties panel: the selection, or the whole design when `ids` is empty. */
export function ElementInfoSection({ ids, defaultOpen = false, title }: { ids: string[]; defaultOpen?: boolean; title?: string }) {
  return (
    <Section title={title ?? "Element info"} defaultOpen={defaultOpen}>
      <Panel ids={ids} />
    </Section>
  );
}
