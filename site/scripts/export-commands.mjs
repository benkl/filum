// Export the app's commands for the page's command-palette preview
// (public/data/commands.json): every command of the menus, as the app's own
// palette lists them ([menu path, label, shortcut]).
//
//   # in the Filum repo: npm run dev   (the editor on http://localhost:1420)
//   NODE_PATH=<dir with playwright>/node_modules node scripts/export-commands.mjs
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const { chromium } = createRequire(import.meta.url)("playwright");
const OUT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "public", "data", "commands.json");
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(process.env.APP_URL || "http://localhost:1420", { waitUntil: "networkidle" });
const list = await page.evaluate(async () => {
  const m = await import("/src/components/menuModel.ts");
  return m.flattenMenus(m.buildMenus()).map(({ path, item }) => [path.join(" · "), item.label, item.kbd ?? ""]);
});
writeFileSync(OUT, JSON.stringify(list));
console.log(`${list.length} commands → ${OUT}`);
await browser.close();
