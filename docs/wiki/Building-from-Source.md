# Building from source

Filum is a Rust stitch engine compiled to WebAssembly, a React + TypeScript editor, and a [Tauri 2](https://tauri.app) shell for the desktop.

## What you need

- **Rust** (stable) with the WebAssembly target. Install it with [rustup](https://rustup.rs):
  ```bash
  rustup target add wasm32-unknown-unknown
  ```
- **wasm-bindgen-cli 0.2.130**. It must match the `wasm-bindgen` version in `Cargo.lock`:
  ```bash
  cargo install wasm-bindgen-cli --version 0.2.130 --locked
  ```
- **Node.js 20** or newer
- For the **desktop app**, the system libraries Tauri needs ([Tauri prerequisites](https://tauri.app/start/prerequisites/)). For example:
  - Arch / CachyOS: `webkit2gtk-4.1 base-devel openssl libappindicator-gtk3 librsvg`
  - Debian / Ubuntu: `libwebkit2gtk-4.1-dev build-essential libssl-dev libayatana-appindicator3-dev librsvg2-dev`
  - macOS: Xcode command-line tools. Windows: Microsoft C++ Build Tools and WebView2.

## Build and run

```bash
npm install && npm --prefix ui install   # JavaScript dependencies
npm run wasm                             # Rust engine → ui/src/wasm/pkg
npm run dev                              # editor in the browser: http://localhost:1420
npm run desktop:dev                      # desktop app with live reload
npm run desktop:build                    # release build and installers
```

`npm run desktop:build` writes its output to `target/release/`:
- the app itself, `filum-desktop`
- the installers, under `bundle/`. On Linux these are `deb/`, `rpm/` and `appimage/`. To build the AppImage, Tauri downloads `linuxdeploy` the first time.

`npm run build:web` builds the browser version into `ui/dist`, ready for any static web host.

> **npm and install scripts:** recent npm versions block install scripts unless you allow them. Filum builds fine without them. npm will mention esbuild, protobufjs and tesseract.js, but their scripts are optional.

## Tests

```bash
npm test
```

This runs the Rust tests (`cargo test --workspace --exclude filum-desktop`), the TypeScript type check, the UI logic checks (`ui/src/lib/*.test.ts`, including the check that nothing with a non-redistributable licence is bundled) and the wording check (`scripts/check-wording.mjs`).

## Contributing

Pull requests are welcome. A few house rules:

- **Describe behaviour in Filum's own words.** Code comments, UI text and docs say what a feature does ("a light net sewn first under the design"), not which other program has something similar. The wording check in `npm test` flags names of other editors and digitizing programs. Machine and thread brands (for formats, hoops and charts), the projects Filum builds on (Ink/Stitch, pystitch …) and research papers are fine.
- **Keep attributions.** Ported code keeps its attribution headers, and new dependencies show up under Help → Licences (`npm run licenses`).
- **Only bundle what everyone may share.** Content under non-commercial or unknown licences goes into an optional download (`ui/public/downloads/`), not into the app.

## Project layout

| Path | What's in it |
|---|---|
| `crates/core` | The engine: document model, geometry, stitch generators, plan assembly, optimiser, SVG, digitizer, I/O |
| `crates/formats` | Embroidery file readers and writers (std only, so it works in WASM) |
| `crates/wasm` | WebAssembly bindings, used by the editor's Web Worker |
| `crates/cli` | The `filum` [command-line tool](Command-Line.md) |
| `src-tauri` | The Tauri 2 desktop shell (and mobile scaffolding) |
| `ui` | The React + TypeScript editor |
| `ui/public` | Bundled embroidery fonts, thread charts, licences and AI models |
| `assets` | The app icon, and `assets/logo` with the logo's source |
| `docs` | The [implementation plan](../IMPLEMENTATION_PLAN.md), [algorithm research](../ALGORITHMS_RESEARCH.md), the [density model](../density-model.md) and this wiki |

## Refreshing bundled data

```bash
# the Ink/Stitch embroidery fonts: bundled when their licence allows it,
# the rest listed in ui/public/downloads/nc-fonts.json (pinned to the checkout's commit)
git clone --depth 1 https://github.com/inkstitch/embroidery-fonts ../embroidery-fonts
npm run fonts -- ../embroidery-fonts/src

# the licence list shown under Help → Licences
npm run licenses

# Ink/Stitch thread charts, meander tiles and command symbols, and the Embroidery Nerds
# download manifest (ui/public/downloads/embroiderynerd-charts.json); pin with
# INKSTITCH_SHA=<commit> EN_SHA=<commit> to rebuild from the same upstream commits
npm --prefix ui run inkstitch

# the digitizer's AI models (downloaded and cached, not committed; also runs before every build)
npm --prefix ui run models
```

## The logo

The logo is a lower-case "f" drawn as one thread: up the stem, over the hook, back down and round in a loop that makes the crossbar, then into the fabric as a single stitch. It is drawn on the same 24 px grid and stroke rules as the app's icons (`ui/src/icons/stitch.ts`). It's built with Grease Pencil in Blender (tested with 5.3) by `assets/logo/filum_logo.py`. That script is the single source of the logo: it holds the geometry, builds the Blender scene, renders the PNGs and writes the SVGs.

```bash
blender --background --python assets/logo/filum_logo.py
cp assets/logo/filum-icon.svg assets/icon.svg
cp assets/logo/filum-icon.svg ui/public/icon.svg
npx tauri icon assets/logo/filum-icon-1024.png -o src-tauri/icons
```

## The screenshots

The README and wiki screenshots come from `docs/tools/screenshots.mjs`. It drives the dev server with Playwright, so the pictures can be retaken whenever the UI changes:

```bash
npm run dev    # in one terminal
mkdir -p /tmp/shots && (cd /tmp/shots && npm i playwright@1 && npx playwright install chromium)
NODE_PATH=/tmp/shots/node_modules node docs/tools/screenshots.mjs            # all of them
NODE_PATH=/tmp/shots/node_modules node docs/tools/screenshots.mjs export     # just one
```

It needs ImageMagick (`magick`) and `rsvg-convert`. The digitizer shots use the test picture `docs/tools/cactus.svg`.

## Mobile

`npm run android:dev` and `npm run ios:dev` are wired up through Tauri. The mobile projects aren't generated yet, so mobile is experimental.
