// Run the UI logic checks (src/lib/*.test.ts) in Node: thread matching, node operations.
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const lib = path.resolve(here, "../src/lib");
const dir = mkdtempSync(path.join(tmpdir(), "filum-test-"));
for (const f of readdirSync(lib).filter((x) => x.endsWith(".test.ts"))) {
  const out = path.join(dir, f.replace(/\.ts$/, ".cjs"));
  await build({ entryPoints: [path.join(lib, f)], bundle: true, platform: "node", format: "cjs", outfile: out, logLevel: "warning" });
  console.log(`— ${f}`);
  execFileSync(process.execPath, [out], { stdio: "inherit" });
}
