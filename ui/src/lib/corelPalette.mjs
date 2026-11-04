// CorelDRAW palette XML (the Embroidery Nerds thread charts) → thread chart
// entries and GIMP palette text. Shared by the build (scripts/bundle-inkstitch.mjs
// writes the download manifest) and the app (Preferences ▸ Downloads converts
// the charts on the user's device). Plain JS so Node and the browser load it.

const unescape = (s) => s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&apos;/g, "'");

/** The palette's title: "Madeira - Polyneon" → { brand: "Madeira", name: "Madeira Polyneon" }. */
export function corelTitle(xml, fallback) {
  const title = unescape(/<palette[^>]*\bname="([^"]*)"/.exec(xml)?.[1] ?? fallback).trim();
  const [b0, ...rest] = title.split(/\s+-\s+/);
  return { brand: b0.trim(), name: rest.length ? `${b0.trim()} ${rest.join(" ").trim()}` : title };
}

/** The RGB colours of the palette: { rgb, name, code }. */
export function corelEntries(xml) {
  const entries = [];
  for (const m of xml.matchAll(/<color\b([^>]*)>/g)) {
    const a = Object.fromEntries([...m[1].matchAll(/(\w+)="([^"]*)"/g)].map((x) => [x[1], x[2]]));
    if (a.cs !== "RGB" || !a.tints) continue;
    const rgb = a.tints.split(",").map((v) => Math.max(0, Math.min(255, Math.round(parseFloat(v) * 255))));
    if (rgb.length !== 3 || rgb.some(Number.isNaN)) continue;
    const label = unescape(a.name ?? "").trim();
    // "1621 - Rust": code first; codes keep no spaces so the .gpl parser finds them
    const mm = /^(.+?)\s+-\s+(.+)$/.exec(label);
    let code = mm ? mm[1].trim() : label;
    let nm = mm ? mm[2].trim() : "";
    if (nm === code) nm = ""; // "Yellow C - Yellow C"
    if (!/\d/.test(code)) {
      // no number: it is a name
      nm = [code, nm].filter(Boolean).join(" ");
      code = "";
    } else if (!nm) {
      // "Red 032 C": the name, coded without spaces
      nm = code;
    }
    code = code.replace(/\s+/g, "");
    entries.push({ rgb, name: nm || code, code: nm ? code : "" });
  }
  return entries;
}

/** GIMP palette text (what the app's palette parser and Ink/Stitch read). */
export function gplText(name, entries) {
  const lines = ["GIMP Palette", `Name: ${name}`, "Columns: 4", "# RGB Value\tColor Name Number"];
  for (const e of entries) lines.push(`${String(e.rgb[0]).padStart(3)} ${String(e.rgb[1]).padStart(3)} ${String(e.rgb[2]).padStart(3)}\t${e.name} ${e.code}`.trimEnd());
  return lines.join("\n") + "\n";
}
