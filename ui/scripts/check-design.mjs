// Checks the editor's stylesheets against the design tokens: every file in
// ui/src/styles/ but the tokens themselves (styles/tokens.css), and every
// other stylesheet in ui/src (output.css). Type, weights, corners, layers and
// motion come from their scales, spacing sits on the 2 px grid, and colours
// are tokens.
//
//   node ui/scripts/check-design.mjs
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src");
const STYLES = join(SRC, "styles");
const FILES = [
  ...readdirSync(STYLES)
    .filter((f) => f.endsWith(".css") && f !== "tokens.css")
    .map((f) => join(STYLES, f)),
  ...readdirSync(SRC)
    .filter((f) => f.endsWith(".css") && f !== "styles.css")
    .map((f) => join(SRC, f)),
];

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
  ["raw rgb() colour (use a colour token)", /\brgba?\(/],
  ["global z-index (use --z-*; 1-9 stay local)", /z-index:\s*(\d{2,})/],
  ["duration in s (use --dur-*)", /transition[^;]*\b0?\.\d+s\b/],
  ["corner in px (use --r-*)", /border(?:-[a-z]+)*-radius:[^;]*\b([2-9]|\d{2,})px/],
  ["spacing off the 2 px grid", /^\s*(?:padding|margin|gap|row-gap|column-gap)[a-z-]*:[^;]*(?<![-\d.])([3579]|1[13579])px/],
];

const errors = [];
for (const file of FILES) {
  // git may check the files out with CRLF line ends
  const lines = readFileSync(file, "utf8").replace(/\r\n/g, "\n").split("\n");
  const name = relative(SRC, file).replace(/\\/g, "/");
  let sel = "";
  lines.forEach((line, i) => {
    if (line.includes("{")) sel = line;
    if (ALLOW.some(([s]) => sel.includes(s))) return;
    for (const [rule, re] of RULES) if (re.test(line)) errors.push(`${name}:${i + 1}  ${rule}\n    ${sel.trim()}  ${line.trim()}`);
  });
}
if (errors.length) {
  console.error(`check-design: ${errors.length} value(s) off the design tokens\n` + errors.join("\n"));
  process.exit(1);
}
console.log(`check-design: ${FILES.length} stylesheets follow the design tokens`);
