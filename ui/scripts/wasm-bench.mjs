// Time the wasm engine directly in Node (the same V8 as the browser, no worker
// or messaging): cold plan (a new engine), warm plan, and the JSON parse alone.
//   node scripts/wasm-bench.mjs <dir with .filum designs>
// Compare with the native numbers of `cargo run --release -p filum-core --example plan_bench`.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = path.resolve(here, "../src/wasm/pkg");
const mod = await import(new URL(`file:///${path.join(pkg, "filum_wasm.js").replace(/\\/g, "/")}`).href);
mod.initSync({ module: fs.readFileSync(path.join(pkg, "filum_wasm_bg.wasm")) });

const dir = process.argv[2] ?? ".";
const ms = (f) => {
  const t = performance.now();
  f();
  return performance.now() - t;
};
console.log("design                 cold ms  warm ms  stitches");
for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".filum")).sort()) {
  const json = fs.readFileSync(path.join(dir, f), "utf8");
  const cold = [];
  let stitches = 0;
  for (let i = 0; i < 3; i++) {
    const e = new mod.StitchEngine();
    cold.push(ms(() => (stitches = e.plan(json).flags.length)));
    e.free();
  }
  const e = new mod.StitchEngine();
  e.plan(json);
  const warm = ms(() => e.plan(json));
  e.free();
  console.log(`${f.replace(".filum", "").padEnd(22)} ${Math.min(...cold).toFixed(0).padStart(7)}  ${warm.toFixed(1).padStart(7)}  ${String(stitches).padStart(8)}`);
}
