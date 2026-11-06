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
