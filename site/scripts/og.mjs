// Issue #6 — the social card (public/og.png, 1200 × 630) from scripts/og.html:
// the 3D logo render and the page's headline in Inter.
//
//   NODE_PATH=<dir with playwright>/node_modules npm run og
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const { chromium } = createRequire(import.meta.url)("playwright");
const HERE = dirname(fileURLToPath(import.meta.url));
const browser = await chromium.launch({ args: ["--allow-file-access-from-files"] });
const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
await page.goto(pathToFileURL(join(HERE, "og.html")).href, { waitUntil: "networkidle" });
await page.evaluate(() => document.fonts.ready);
await page.screenshot({ path: resolve(HERE, "..", "public", "og.png") });
await browser.close();
console.log("public/og.png");
