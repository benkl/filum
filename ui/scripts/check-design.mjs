// Checks ui/src/styles.css against the design tokens: outside the token blocks at
// the top, type, weights, corners, layers and motion come from their scales,
// spacing sits on the 2 px grid, and colours are tokens.
//
//   node ui/scripts/check-design.mjs
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CSS = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src", "styles.css");
// git may check the file out with CRLF line ends
const src = readFileSync(CSS, "utf8").replace(/\r\n/g, "\n");
const start = src.indexOf("* {\n  box-sizing: border-box;");
if (start < 0) throw new Error("check-design: the end of the token blocks was not found");
const offset = src.slice(0, start).split("\n").length - 1;

// raw values allowed on purpose: selector fragment → why
const ALLOW = [
  [".cal-piece text", "SVG text in a millimetre viewBox"],
  [".cal-dim text", "SVG text in a millimetre viewBox"],
  ['[data-theme="dark"] .dialog', "a dialog's own border tokens"],
  [".sh-list", "a mask gradient (opaque to transparent)"],
];

const RULES = [
  ["font-size in px (use --fs-*)", /font-size:\s*[\d.]+px/],
  ["font-weight number (use --fw-*)", /font-weight:\s*\d+/],
  ["raw hex colour (use a colour token)", /#[0-9a-fA-F]{3,8}\b/],
  ["global z-index (use --z-*; 1-9 stay local)", /z-index:\s*(\d{2,})/],
  ["duration in s (use --dur-*)", /transition[^;]*\b0?\.\d+s\b/],
  ["corner in px (use --r-*)", /border(?:-[a-z]+)*-radius:[^;]*\b([2-9]|\d{2,})px/],
  ["spacing off the 2 px grid", /^\s*(?:padding|margin|gap|row-gap|column-gap)[a-z-]*:[^;]*(?<![-\d.])([3579]|1[13579])px/],
];

const lines = src.slice(start).split("\n");
let sel = "";
const errors = [];
lines.forEach((line, i) => {
  if (line.includes("{")) sel = line;
  if (ALLOW.some(([s]) => sel.includes(s))) return;
  for (const [name, re] of RULES) if (re.test(line)) errors.push(`styles.css:${offset + i + 1}  ${name}\n    ${sel.trim()}  ${line.trim()}`);
});
if (errors.length) {
  console.error(`check-design: ${errors.length} value(s) off the design tokens\n` + errors.join("\n"));
  process.exit(1);
}
console.log("check-design: styles.css follows the design tokens");
