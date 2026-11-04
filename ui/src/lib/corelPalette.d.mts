export interface CorelEntry {
  rgb: [number, number, number];
  name: string;
  code: string;
}
export function corelTitle(xml: string, fallback: string): { brand: string; name: string };
export function corelEntries(xml: string): CorelEntry[];
export function gplText(name: string, entries: CorelEntry[]): string;
