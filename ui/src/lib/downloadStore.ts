// Storage of the optional downloads (Preferences ▸ Downloads): content that
// Filum may not redistribute, fetched from its authors when the user
// accepts its licence and kept on this device (IndexedDB, in the browser and
// in the desktop app's web view). No other app modules are imported here, so
// fonts.ts and threads.ts can read from it without import cycles; downloads.ts
// does the downloading and converting.

/** One download pack (public/downloads/<id>.json, written by the bundling scripts). */
export interface DownloadPack {
  id: string;
  kind: "fonts" | "charts";
  title: string;
  summary: string;
  license: { name: string; url: string; terms: string };
  source: { label: string; url: string };
  /** Upstream base URL the item files are relative to (pinned to `version`). */
  base: string;
  /** Upstream commit the files are pinned to. */
  version: string;
  bytes: number;
  items: PackItem[];
}
export interface PackItem {
  id: string;
  name: string;
  brand?: string;
  count?: number;
  license?: string;
  /** [path relative to `base`, size in bytes] */
  files: [string, number][];
}

/** What is installed of a pack, and the licence the user accepted for it. */
export interface InstalledPack {
  id: string;
  version: string;
  license: string;
  licenseUrl: string;
  acceptedAt: string;
  items: string[];
  bytes: number;
}

/** A downloaded embroidery font: packed like an imported one, with its licence and preview. */
export interface StoredFont {
  pack: unknown;
  license: string;
  preview?: Blob;
}

export const PACK_IDS = ["nc-fonts", "embroiderynerd-charts"] as const;

const DB = "filum-downloads";
const STORES = ["packs", "fonts", "charts"] as const;
type Store = (typeof STORES)[number];

let dbP: Promise<IDBDatabase> | null = null;
function db(): Promise<IDBDatabase> {
  dbP ??= new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => {
      for (const s of STORES) if (!r.result.objectStoreNames.contains(s)) r.result.createObjectStore(s);
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => {
      dbP = null;
      rej(r.error);
    };
  });
  return dbP;
}

async function get<T>(store: Store, key: string): Promise<T | undefined> {
  const d = await db();
  return new Promise((res, rej) => {
    const q = d.transaction(store).objectStore(store).get(key);
    q.onsuccess = () => res(q.result as T | undefined);
    q.onerror = () => rej(q.error);
  });
}

/** Write (value) or delete (undefined) several records of several stores in one transaction. */
export async function writeAll(changes: { store: Store; key: string; value: unknown }[]): Promise<void> {
  const d = await db();
  await new Promise<void>((res, rej) => {
    const t = d.transaction([...new Set(changes.map((c) => c.store))], "readwrite");
    for (const c of changes) {
      const os = t.objectStore(c.store);
      if (c.value === undefined) os.delete(c.key);
      else os.put(c.value, c.key);
    }
    t.oncomplete = () => res();
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error ?? new Error("storage aborted"));
  });
  installedP = null;
  for (const f of listeners) f();
}

let installedP: Promise<Map<string, InstalledPack>> | null = null;
/** The installed packs, by id. */
export function installedPacks(): Promise<Map<string, InstalledPack>> {
  installedP ??= db()
    .then(
      (d) =>
        new Promise<Map<string, InstalledPack>>((res) => {
          const out = new Map<string, InstalledPack>();
          const cur = d.transaction("packs").objectStore("packs").openCursor();
          cur.onsuccess = () => {
            const c = cur.result;
            if (!c) return res(out);
            out.set(String(c.key), c.value as InstalledPack);
            c.continue();
          };
          cur.onerror = () => res(out);
        }),
    )
    .catch(() => new Map());
  return installedP;
}

/** Ids of every installed item (fonts and charts). */
export async function installedItems(): Promise<Set<string>> {
  return new Set([...(await installedPacks()).values()].flatMap((p) => p.items));
}

export const storedFont = (id: string) => get<StoredFont>("fonts", id);
export const storedChart = (id: string) => get<string>("charts", id);

const listeners = new Set<() => void>();
/** Called after every install or removal. */
export function onDownloadsChange(f: () => void): () => void {
  listeners.add(f);
  return () => listeners.delete(f);
}
