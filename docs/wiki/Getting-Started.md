# Getting started

This page gets Filum running and walks you through your first design.

## 1. Run Filum

Filum is the same app everywhere: in a web browser, or as a desktop app for Windows, macOS and Linux.

**On Windows**, download the installer from the [latest release](https://github.com/benkl/filum/releases/latest) and run it. The installer isn't code-signed yet, so if Windows shows "Windows protected your PC", choose *More info → Run anyway*.

**On macOS, Linux or in the browser**, build it once from the source code. It takes a few minutes.

```bash
npm install && npm --prefix ui install
npm run wasm               # build the stitch engine
npm run dev                # open http://localhost:1420 in your browser
```

Prefer a real desktop app? Run `npm run desktop:build`. On Linux this gives you a `.deb`, an `.rpm` and an AppImage in `target/release/bundle/`. On Windows and macOS you get the matching installers. [Building from source](Building-from-Source.md) lists what to install first.

> **Browser or desktop?** Both do the same things. The desktop app saves straight back to the file you opened and uses your system's file dialogs. You can also double-click a design, or use *Open with Filum*, to open it: a `.filum` project, a machine file such as PES or DST, or a picture to digitize. In the browser, saving goes through the browser's save picker (or a download), and your work is autosaved in the browser.

## 2. Meet the sample design

The first time you open Filum you'll see **Mountain badge**, a small sample design in a 100 × 100 mm hoop. It uses several stitch types: a sunburst fill for the sun, a spiral fill for the lake, a satin ring and running-stitch birds. It's there for you to play with.

![The sample design](images/editor-light.webp)

Try this:

1. Press <kbd>1</kbd>, <kbd>2</kbd> and <kbd>3</kbd> to switch between the **Vector**, **Stitch** and **Realistic** views.
2. Click the **Mountains** in the *Layers* list (or on the canvas). The right-hand panel switches to **Selection** and shows the stitch settings for that shape.
3. Pick a different fill, like **Contour** or **Stipple**, and watch the stitches update.
4. Click **Animate** in the bottom bar to watch the design sew itself out.

![The Selection panel with the stitch types of a fill](images/stitch-settings.webp)

Made a mess? <kbd>Ctrl</kbd>+<kbd>Z</kbd> undoes it, and **File → Load sample design** brings the badge back.

## 3. Start your own design

Choose **File → New design** (<kbd>Ctrl</kbd>+<kbd>N</kbd>). An empty hoop offers four ways to begin:

![Start a design](images/start.webp)

- **Auto-digitize**: turn a logo or picture into stitches. See [Auto-digitize](Auto-Digitize.md).
- **Import**: open an Ink/Stitch SVG, or an embroidery file such as PES, DST, JEF or EXP.
- **Lettering**: click and type. See [Lettering](Lettering.md).
- **Sample**: the mountain badge again.

You can also just start drawing with the tools on the left: <kbd>P</kbd> for a running-stitch pen, <kbd>S</kbd> for a satin column, <kbd>R</kbd> and <kbd>E</kbd> for rectangles and ellipses. [Drawing and stitch types](Drawing-and-Stitch-Types.md) explains each tool.

## 4. Set up the fabric and hoop

The bar under the menus has a **Fabric** picker (Cotton, Denim, Knit / Jersey, Towel / Terry, Cap / Structured and more) and a **Hoop** picker. The fabric preset adjusts density, underlay and pull compensation for the whole design. It also suggests a backing, a topping and a needle under **Design → Fabric & thread**.

## 5. Check and export

1. Look at the **Issues** tab next to *Layers*. It points out problems like a border that crosses itself or text that's too small, and often offers a one-click fix.
2. Click **Optimise** to reorder the design for fewer colour changes and jumps.
3. Click **Export** (<kbd>Ctrl</kbd>+<kbd>E</kbd>), pick your machine and format, and save.

![The Export dialog](images/export.webp)

The Export dialog runs a pre-flight check. It warns you if the design doesn't fit the hoop, or if colours will look different on your machine's screen. More in [Export and print](Export-and-Print.md).

## 6. Save your project

Save with <kbd>Ctrl</kbd>+<kbd>S</kbd>. Filum saves a `.filum` project file, which keeps all your shapes, stitch settings and lettering editable. Machine files like PES or DST only hold the finished stitches, so keep the project file too.

**Next:** take the [tour of the editor](Tour-of-the-Editor.md).
