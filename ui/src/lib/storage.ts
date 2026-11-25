// Local storage that never throws: a full quota (big reference pictures in
// the autosave) or a blocked storage must not break the edit that wrote.

let warned = false;

/** `localStorage.setItem`; false when it could not be stored. */
export function safeSetItem(key: string, value: string): boolean {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    if (!warned) {
      warned = true;
      console.warn(`Filum: local storage is full or blocked; "${key}" was not saved`);
    }
    return false;
  }
}

/** What `key` holds as JSON, or `fallback` when nothing (readable) is stored. */
export function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

/**
 * Saved settings over their defaults: what an older version saved keeps its
 * value, a setting added since gets its default. `defaults` when nothing
 * (readable) is stored.
 */
export function loadMerged<T extends object>(key: string, defaults: T): T {
  const v = loadJson<Partial<T> | null>(key, null);
  return v && typeof v === "object" ? { ...defaults, ...v } : defaults;
}
