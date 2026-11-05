<p align="center">
  <img src="assets/icon.svg" width="96" height="96" alt="Filum logo: a lower-case f drawn as one thread">
</p>

<h1 align="center">Filum</h1>

<p align="center">
  <b>A friendly machine-embroidery editor: draw, digitize, letter and stitch out.</b><br>
  Free and open source · runs in the browser and on Windows, macOS and Linux
</p>

<p align="center">
  <a href="https://github.com/benkl/filum/releases/latest"><b>Download for Windows</b></a> ·
  <a href="docs/wiki/Home.md">Wiki</a> ·
  <a href="docs/wiki/Getting-Started.md">Getting started</a> ·
  <a href="#build-it-yourself">Build it yourself</a> ·
  <a href="#licence">Licence</a>
</p>

![The Filum editor with the sample design in the realistic view](docs/wiki/images/editor-light.webp)

## What is Filum?

Filum turns artwork into stitches your embroidery machine can sew. Draw shapes and satin columns, drop in a logo and let it digitize itself, type a name in one of 134 bundled embroidery fonts, then watch the design sew itself out on screen before you export it for your machine.

Under the hood is a fast stitch engine written in Rust. It's a port of the algorithms from [Ink/Stitch](https://inkstitch.org), the open-source embroidery extension for Inkscape. That means your Ink/Stitch SVGs open in Filum, and Filum's designs open in Inkscape.

## Highlights

**See it before you sew it.** Switch between the vector, stitch and realistic views with <kbd>1</kbd> <kbd>2</kbd> <kbd>3</kbd>. The realistic view shows thread sheen and fabric texture, and **Animate** plays the stitch-out stitch by stitch, with a timeline of the colour blocks, their trims and thread changes, and the machine time.

![The same badge in the vector, stitch and realistic views](docs/wiki/images/views.webp)

**Auto-digitize a picture.** Drop in a logo or a drawing and pick a preset (Logo, Patch, Line art, Photo, Pixel art and more). Filum reduces the colours and chooses a stitch type for every region: fills for areas, satin for strokes and running stitch for fine lines. It can also turn the picture into cross stitch. The optional AI helpers run on your own device.

![Auto-digitizing a cactus illustration](docs/wiki/images/digitize.webp)

**Every stitch type you'd expect, and a few you wouldn't.** You get running, bean and motif lines, and satin columns with underlay and pull compensation. Tatami fills come with gradient density. There are also contour, spiral, sunburst, stipple, meander, Hilbert curve and gradient fills, plus appliqué and cross stitch.

**Production tools.** These include knockdown stitches for towels and fleece, basting, and removing stitching hidden under other objects. You can also optimise the stitch order for fewer jumps and colour changes, run test swatches and print job sheets. Fabric presets set sensible density, underlay and pull compensation for you, and you can calibrate a fabric for your own setup by sewing and measuring one swatch.

**Opens almost anything.** Filum reads and writes DST, PES, JEF, EXP, VP3, XXX, U01, SEW and more, and reads 30 further formats (HUS, SHV, PCS, KSM, …). It also writes thread lists, PNG pictures, G-code and stitch-out videos.

<table>
  <tr>
    <td><img src="docs/wiki/images/realistic-closeup.webp" alt="Close-up of the realistic view"></td>
    <td><img src="docs/wiki/images/lettering.webp" alt="Lettering with a pre-digitized embroidery font"></td>
  </tr>
  <tr>
    <td align="center">Zoom in on the realistic view</td>
    <td align="center">Lettering with 134 pre-digitized fonts</td>
  </tr>
  <tr>
    <td><img src="docs/wiki/images/export.webp" alt="The Export dialog with a pre-flight check"></td>
    <td><img src="docs/wiki/images/editor-dark.webp" alt="The editor in the dark theme"></td>
  </tr>
  <tr>
    <td align="center">Export with a pre-flight check</td>
    <td align="center">Light and dark themes</td>
  </tr>
</table>

## Learn more in the wiki

| | |
|---|---|
| [Getting started](docs/wiki/Getting-Started.md) | Install or run Filum and make your first design |
| [A tour of the editor](docs/wiki/Tour-of-the-Editor.md) | Panels, views, the command palette and where everything lives |
| [Drawing and stitch types](docs/wiki/Drawing-and-Stitch-Types.md) | The tools, and when to use which stitch |
| [Auto-digitize](docs/wiki/Auto-Digitize.md) | Pictures to stitches, and cross stitch from a picture |
| [Lettering](docs/wiki/Lettering.md) | Embroidery fonts, TTF/OTF fonts, text on an arc or a path |
| [Threads and colours](docs/wiki/Threads-and-Colours.md) | Thread charts, your own thread stash, gradients |
| [Production tools](docs/wiki/Production-Tools.md) | Fabric, appliqué, knockdown, basting, optimising, test swatches |
| [Export and print](docs/wiki/Export-and-Print.md) | Machine formats, job sheets, videos |
| [Keyboard shortcuts](docs/wiki/Keyboard-Shortcuts.md) | Every shortcut on one page |
| [Command line](docs/wiki/Command-Line.md) | Convert, inspect and digitize in batches |
| [Building from source](docs/wiki/Building-from-Source.md) | Toolchain, desktop builds and the project layout |

## Build it yourself

You need Rust (stable, with the `wasm32-unknown-unknown` target), `wasm-bindgen-cli` 0.2.130 and Node 20 or newer.

```bash
npm install && npm --prefix ui install
npm run wasm              # compile the stitch engine to WebAssembly
npm run dev               # the editor in your browser → http://localhost:1420
npm run desktop:dev       # the desktop app (Tauri 2)
npm run desktop:build     # installers for your OS (.deb, .rpm and AppImage on Linux)
```

The [Building from source](docs/wiki/Building-from-Source.md) page covers the details: Linux libraries, the command-line tool, tests, and how to refresh the bundled fonts, the logo and these screenshots.

## Licence

Filum is free software under the **GPL-3.0-or-later**, because it contains ports of Ink/Stitch's algorithms (© Ink/Stitch authors, GPL-3.0). The file encoders are ported from Ink/Stitch's [pystitch](https://github.com/inkstitch/pystitch) (MIT), and the thread charts come from Ink/Stitch.

The embroidery fonts come from [inkstitch/embroidery-fonts](https://github.com/inkstitch/embroidery-fonts). Filum bundles only what it may share with everyone: the fonts under the SIL Open Font License, Creative Commons BY / BY-SA / BY-ND licences and in the public domain. Nunito, Bebas Neue and Pacifico use the SIL Open Font License too. Every bundled font, npm package and Rust crate is listed with its full licence text in the app under **Help → Licences**.

**Optional downloads.** Eight embroidery fonts are licensed for non-commercial use only (CC BY-NC-SA 4.0), and the 164 [Embroidery Nerds](https://github.com/Matthewenderle/Embroidery-Thread-Palette-Converter) thread charts come without a licence. Neither is part of Filum. **Preferences → Downloads** shows their licences, and one click downloads them from their authors' repositories to your device.

Thank you to the Ink/Stitch community, whose work made Filum possible.
