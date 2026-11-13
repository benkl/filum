// Abstracts file access: native dialogs + filesystem in Tauri (desktop/mobile),
// <input type=file> / downloads (or the File System Access API) in browsers.

export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** Open a web page in the system browser (desktop) or a new tab (browser). */
export async function openExternal(url: string): Promise<void> {
  if (isTauri) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
  } else window.open(url, "_blank", "noopener,noreferrer");
}

export interface OpenedFile {
  name: string;
  path: string | null;
  bytes: Uint8Array;
}

export interface FileFilter {
  name: string;
  extensions: string[];
}

export async function openFile(filters: FileFilter[]): Promise<OpenedFile | null> {
  if (isTauri) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const { readFile } = await import("@tauri-apps/plugin-fs");
    const path = await open({ multiple: false, directory: false, filters });
    if (!path || Array.isArray(path)) return null;
    const bytes = await readFile(path);
    return { name: path.split(/[\\/]/).pop() ?? path, path, bytes };
  }
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = filters.flatMap((f) => f.extensions.map((e) => (e === "*" ? "*" : `.${e}`))).join(",");
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) return resolve(null);
      resolve({ name: f.name, path: null, bytes: new Uint8Array(await f.arrayBuffer()) });
    };
    input.oncancel = () => resolve(null);
    input.click();
  });
}

/** Save bytes. Returns the chosen path (Tauri) or file name (browser), or null if cancelled. */
export async function saveFile(
  suggestedName: string,
  bytes: Uint8Array,
  filters: FileFilter[],
  existingPath?: string | null,
): Promise<string | null> {
  if (isTauri) {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const { invoke } = await import("@tauri-apps/api/core");
    const path = existingPath ?? (await save({ defaultPath: suggestedName, filters }));
    if (!path) return null;
    // written next to the file first and then put in its place (src-tauri/src/safe_write.rs):
    // a save cut off by a crash or a full disk leaves the old file whole
    await invoke("save_file", bytes, { headers: { path: encodeURIComponent(path) } });
    return path;
  }
  const w = window as unknown as {
    showSaveFilePicker?: (o: unknown) => Promise<{ createWritable: () => Promise<{ write: (b: Uint8Array) => Promise<void>; close: () => Promise<void> }> }>;
  };
  if (w.showSaveFilePicker) {
    try {
      const handle = await w.showSaveFilePicker({
        suggestedName,
        types: filters.map((f) => ({ description: f.name, accept: { "application/octet-stream": f.extensions.map((e) => `.${e}`) } })),
      });
      const wr = await handle.createWritable();
      await wr.write(bytes);
      await wr.close();
      return suggestedName;
    } catch (e) {
      if ((e as Error).name === "AbortError") return null;
    }
  }
  const blob = new Blob([bytes as BlobPart], { type: "application/octet-stream" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = suggestedName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  return suggestedName;
}

export const enc = new TextEncoder();
export const dec = new TextDecoder();

/** A file of a picked folder, read lazily. */
export interface FolderFile {
  path: string;
  text: () => Promise<string>;
  bytes: () => Promise<Uint8Array>;
}

/** A picked folder's files with these extensions (recursive, paths relative to it), read lazily. */
export async function openFolder(extensions: string[] = ["svg", "json"]): Promise<FolderFile[] | null> {
  const want = (name: string) => extensions.includes(name.split(".").pop()?.toLowerCase() ?? "");
  if (isTauri) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const { readDir, readTextFile, readFile } = await import("@tauri-apps/plugin-fs");
    const dir = await open({ directory: true, multiple: false });
    if (!dir || Array.isArray(dir)) return null;
    const out: FolderFile[] = [];
    const walk = async (d: string, rel: string, depth: number) => {
      if (depth > 3) return;
      for (const e of await readDir(d)) {
        const p = `${d}/${e.name}`;
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory) await walk(p, r, depth + 1);
        else if (want(e.name)) out.push({ path: r, text: () => readTextFile(p), bytes: () => readFile(p) });
      }
    };
    await walk(dir, "", 0);
    return out;
  }
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    (input as HTMLInputElement & { webkitdirectory: boolean }).webkitdirectory = true;
    input.onchange = () => {
      const files = [...(input.files ?? [])].filter((f) => want(f.name));
      // strip the picked folder's own name: paths relative to it
      resolve(
        files.map((f) => ({
          path: (f.webkitRelativePath || f.name).split("/").slice(1).join("/") || f.name,
          text: () => f.text(),
          bytes: async () => new Uint8Array(await f.arrayBuffer()),
        })),
      );
    };
    input.click();
  });
}
