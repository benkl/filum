// Builds the Rust engine to WebAssembly and generates JS bindings into src/wasm/pkg.
import { execSync } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..", "..");
const sep = process.platform === "win32" ? ";" : ":";
const env = { ...process.env, PATH: `${join(homedir(), ".cargo", "bin")}${sep}${process.env.PATH}` };
const release = !process.argv.includes("--dev");
const run = (cmd) => execSync(cmd, { cwd: root, stdio: "inherit", env });

run(`cargo build -p filum-wasm --target wasm32-unknown-unknown ${release ? "--release" : ""}`);
const wasm = join(root, "target", "wasm32-unknown-unknown", release ? "release" : "debug", "filum_wasm.wasm");
run(`wasm-bindgen --target web --out-dir ui/src/wasm/pkg "${wasm}"`);
console.log("wasm engine ready → ui/src/wasm/pkg");
