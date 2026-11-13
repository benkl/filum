// Run the UI logic checks (src/lib/*.test.ts) in Node: thread matching, node operations.
// A word after the command runs only the matching files: node scripts/test-match.mjs transform
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const lib = path.resolve(here, "../src/lib");
const only = process.argv[2];
const dir = mkdtempSync(path.join(tmpdir(), "filum-test-"));
const files = readdirSync(lib).filter((x) => x.endsWith(".test.ts") && (!only || x.includes(only)));
if (!files.length) throw new Error(`no test file matches "${only}"`);
for (const f of files) {
  const out = path.join(dir, f.replace(/\.ts$/, ".cjs"));
  await build({ entryPoints: [path.join(lib, f)], bundle: true, platform: "node", format: "cjs", outfile: out, logLevel: "warning" });
  console.log(`— ${f}`);
  execFileSync(process.execPath, [out], { stdio: "inherit" });
}
