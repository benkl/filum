// Wording check (part of `npm test`): Filum's code and docs describe
// what the app does in its own words and don't name other editors or
// digitizing programs. Machine and thread brands (formats, hoops, charts),
// the projects Filum is built on (Ink/Stitch, pystitch …) and research
// papers are fine.
//
// The names to avoid are kept as salted hashes, so this file doesn't list
// them. A hit prints the file, line and word; describe the behaviour instead.
//
//   node scripts/check-wording.mjs

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const SALT = "filum-wording-v1";
const hash = (kind, s) => createHash("sha256").update(`${SALT}:${kind}:${s}`).digest("hex").slice(0, 24);

// i: any case (single words and two-word names); c: exact case
const AVOID = new Set([
  "8cb5d1cab81868ded9337fd3", "571d33ed5f55a10bb60a957e", "6eca7fceccb21424d2e815d6", "9473d1dd0db0b420e2131c20",
  "384c835f485eb323f922139f", "de2a9dfe93548619799ec8b0", "5ac4c7c6921fe1bf4dd8419e", "cb53c85c69d18be466e28661",
  "6a18766c81e955a86ada53e3", "edef342b17b66ba330aa1d72", "44ca3f4228cf55c071b271c2", "74f5f98112db1edee1f38ffa",
  "b3313910ae69074759c9ae7d", "4ac931dbb3199380913dfe56",
]);
// a name allowed where it is a tool the project uses, not a model it follows
const ALLOWED_IN = { "4ac931dbb3199380913dfe56": ["assets/logo/", "docs/wiki/Building-from-Source.md", "site/README.md", "site/blender/", "site/scripts/"] };

// upstream data (font and chart metadata, licence texts) is checked by its own tests
const SKIP = [/^ui\/public\/(embroidery-fonts|palettes|downloads|licenses)\//, /(^|\/)(Cargo|package-lock)\.(lock|json)$/, /\.(png|webp|jpe?g|gif|ico|icns|gz|blend|wasm|ttf|otf|onnx|pdf)$/i];

const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { encoding: "utf8" })
  .split("\n")
  .filter((f) => f && !SKIP.some((r) => r.test(f)));

let hits = 0;
for (const file of files) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  if (text.includes("\u0000")) continue; // binary
  text.split("\n").forEach((line, i) => {
    const words = line.match(/[A-Za-z][A-Za-z0-9]*/g) ?? [];
    const candidates = [
      ...words.flatMap((w) => [["i", w.toLowerCase(), w], ["c", w, w]]),
      ...words.slice(1).map((w, k) => ["i", `${words[k]} ${w}`.toLowerCase(), `${words[k]} ${w}`]),
    ];
    for (const [kind, key, shown] of candidates) {
      const h = hash(kind, key);
      if (!AVOID.has(h) || ALLOWED_IN[h]?.some((p) => file.startsWith(p))) continue;
      console.log(`${file}:${i + 1}: "${shown}" names another product — describe the behaviour instead`);
      hits++;
    }
  });
}
if (hits) {
  console.error(`wording check: ${hits} hit${hits === 1 ? "" : "s"} in ${files.length} files`);
  process.exit(1);
}
console.log(`wording check: ${files.length} files ok`);
