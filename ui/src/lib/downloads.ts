// Optional downloads (Preferences ▸ Downloads): fonts and thread charts whose
// licences don't let Filum ship them. The user reads the licence and
// accepts it; the files then come straight from the author's repository
// (pinned to the commit the manifest was made from), are checked against the
// manifest, converted on this device exactly like the bundling scripts do,
// and stored (lib/downloadStore.ts). Nothing is uploaded.

import { useEffect, useState } from "react";
import { corelEntries, corelTitle, gplText } from "./corelPalette.mjs";
import { PACK_IDS, installedPacks, onDownloadsChange, writeAll, type DownloadPack, type InstalledPack } from "./downloadStore";
import { packInkFolder } from "./fonts";

export type { DownloadPack, InstalledPack } from "./downloadStore";

let packsP: Promise<DownloadPack[]> | null = null;
/** The packs this build offers (public/downloads/*.json). */
export function loadPacks(): Promise<DownloadPack[]> {
  packsP ??= Promise.all(
    PACK_IDS.map((id) =>
      fetch(`/downloads/${id}.json`)
        .then((r) => (r.ok ? (r.json() as Promise<DownloadPack>) : null))
        .catch(() => null),
    ),
  ).then((ps) => ps.filter((p): p is DownloadPack => !!p));
  packsP.catch(() => (packsP = null));
  return packsP;
}

const encodePath = (p: string) => p.split("/").map(encodeURIComponent).join("/");

/** Fetch one file, reporting bytes as they arrive; checks its size against the manifest. */
async function fetchFile(url: string, size: number, onBytes: (n: number) => void, signal: AbortSignal): Promise<Uint8Array> {
  const r = await fetch(url, { signal, cache: "no-store" });
  if (!r.ok) throw new Error(`${decodeURIComponent(url.split("/").pop() ?? url)}: HTTP ${r.status}`);
  const parts: Uint8Array[] = [];
  let n = 0;
  if (r.body) {
    const reader = r.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      n += value.length;
      onBytes(value.length);
    }
  } else {
    const b = new Uint8Array(await r.arrayBuffer());
    parts.push(b);
    n = b.length;
    onBytes(n);
  }
  if (size && n !== size) throw new Error(`${decodeURIComponent(url.split("/").pop() ?? url)}: expected ${size} bytes, got ${n} — the download may be incomplete`);
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Run `fn` over `items` with at most `n` at a time. */
async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k]);
      }
    }),
  );
  return out;
}

export interface Progress {
  done: number;
  total: number;
  stage: "download" | "convert";
}

/**
 * Accept the pack's licence, download every file and install it. Either the
 * whole pack is stored or nothing is (one transaction at the end).
 */
export async function installPack(pack: DownloadPack, onProgress: (p: Progress) => void, signal: AbortSignal): Promise<InstalledPack> {
  let done = 0;
  const total = pack.bytes;
  const tick = (n: number) => {
    done += n;
    onProgress({ done, total, stage: "download" });
  };
  const files = pack.items.flatMap((it) => it.files.map(([path, size]) => ({ item: it.id, path, size })));
  const bytes = new Map<string, Uint8Array>();
  await pool(files, 4, async (f) => bytes.set(f.path, await fetchFile(pack.base + encodePath(f.path), f.size, tick, signal)));
  onProgress({ done: total, total, stage: "convert" });
  const dec = new TextDecoder();
  const changes: Parameters<typeof writeAll>[0] = [];
  for (const it of pack.items) {
    if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
    const mine = it.files.map(([p]) => ({ path: p, bytes: bytes.get(p)! }));
    if (pack.kind === "fonts") {
      const { root: _root, ...packed } = await packInkFolder(mine.filter((f) => /\.(json|svg)$/i.test(f.path)).map((f) => ({ path: f.path, text: async () => dec.decode(f.bytes) })));
      const lic = mine.find((f) => /\/(license|licence)(\.txt)?$/i.test(f.path));
      const png = mine.find((f) => /\/preview\.png$/i.test(f.path));
      changes.push({
        store: "fonts",
        key: it.id,
        value: { pack: packed, license: lic ? dec.decode(lic.bytes).replace(/\r\n/g, "\n") : "", preview: png ? new Blob([png.bytes as BlobPart], { type: "image/png" }) : undefined },
      });
    } else {
      const xml = dec.decode(mine[0].bytes);
      const { name } = corelTitle(xml, it.name);
      const entries = corelEntries(xml);
      if (!entries.length) throw new Error(`${it.name}: no colours in the chart`);
      changes.push({ store: "charts", key: it.id, value: gplText(`Embroidery Nerds: ${name}`, entries) });
    }
    // let the interface breathe between items
    await new Promise((r) => setTimeout(r, 0));
  }
  const record: InstalledPack = {
    id: pack.id,
    version: pack.version,
    license: pack.license.name,
    licenseUrl: pack.license.url,
    acceptedAt: new Date().toISOString(),
    items: pack.items.map((i) => i.id),
    bytes: total,
  };
  // an update replaces the old items; ones the new version dropped go too
  const old = (await installedPacks()).get(pack.id);
  for (const id of old?.items ?? []) if (!record.items.includes(id)) changes.push({ store: pack.kind, key: id, value: undefined });
  changes.push({ store: "packs", key: pack.id, value: record });
  await writeAll(changes);
  return record;
}

/** Remove a pack and everything it installed. */
export async function removePack(id: string, kind: DownloadPack["kind"]): Promise<void> {
  const rec = (await installedPacks()).get(id);
  await writeAll([...(rec?.items ?? []).map((k) => ({ store: kind, key: k, value: undefined })), { store: "packs" as const, key: id, value: undefined }]);
}

/** The offered packs and what is installed, kept up to date. */
export function useDownloads(): { packs: DownloadPack[] | null; installed: Map<string, InstalledPack> } {
  const [packs, setPacks] = useState<DownloadPack[] | null>(null);
  const [installed, setInstalled] = useState<Map<string, InstalledPack>>(new Map());
  useEffect(() => {
    let live = true;
    loadPacks().then((p) => live && setPacks(p));
    const refresh = () => installedPacks().then((m) => live && setInstalled(new Map(m)));
    refresh();
    const off = onDownloadsChange(refresh);
    return () => {
      live = false;
      off();
    };
  }, []);
  return { packs, installed };
}

export const formatBytes = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} kB`);
