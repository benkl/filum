# Filum product page

The product page for [Filum](https://github.com/benkl/filum): a static site (Vite, TypeScript, no framework) in the app's own style, made bolder for the web, with a guided tour through interactive previews of its features.

```bash
npm install
npm run dev        # http://localhost:5180
npm run build      # static files in dist/ (relative paths: host it anywhere)
```

## What's where

| Path | What |
|---|---|
| `index.html`, `src/style.css`, `src/main.ts` | The page, its styles (the app's tokens), scroll reveals and the tour |
| `src/demos/` | The **dummy interfaces**: the editor (`editor.ts`), digitizer, lettering, threads and export, all running in the browser |
| `public/data/` | What the demos run on: the sample design's shapes and stitch plan (`badge.json`), three thread charts (`charts.json`), the digitizer's test picture |
| `public/renders/` | 3D augmentations rendered in Blender (WebP) |
| `public/demos/` | The digitizer's stitched result for each preset, captured from the real app (stats in `public/data/digitize.json`) |
| `public/og.png` | Social card (1200 × 630) |
| `blender/` | Blender scripts for every render, shared helpers in `common.py`, input data in `blender/data/` |
| `scripts/` | Capture, export and conversion scripts |

## Regenerating the media

Everything on the page is reproducible.

**Renders** (Blender 5.x, Cycles on the GPU). Run a script in Blender, through the Blender MCP or headless:

```bash
scripts/fetch-assets.sh                                 # CC0 textures and HDRI from Poly Haven (not committed)
blender --background --python blender/hero_opener.py -- --anim [--mobile]  # the opener: 195 frames → /tmp/filum-opener[-m]
blender --background --python blender/hero_opener.py -- --flat [--mobile]  # its flat frames (the lens's vignetting)
scripts/encode-opener.sh                                # → opener[-m].webm / .mp4 and posters hero-badge[-m].webp
blender --background --python blender/layers.py         # issue #4: how it stitches
blender --background --python blender/spools.py         # issue #5: thread spools
blender --background --python blender/logo_3d.py        # issue #6: the logo in 3D
npm run renders                                         # PNG → trimmed WebP (full and half size)
```

Every render shares one studio, `common.soft_studio`: an evenly lit sky (bright above, a light grey bounce below) carries most of the light, one large disc softbox from the front left gives direction and a soft shadow, and a broad card from behind lifts the edges. The lights never show up in reflections, so gloss shows soft gradients and no hotspots. The studio is calibrated with `blender/calibrate.py --studio`: a white top face renders at 240, just under the page's 241, so nothing clips. The materials are shared as well: `common.lacquer` for the hoop, the logo tile, the cone cores and the layer plates, and `common.satin_steel`. The hoop is in the app's colours: violet frames, a charcoal bracket and white markings. The logo is built from the icon's own geometry (22 % corner radius, its stroke width, white strokes) and seen almost face-on.

Every render uses the Khronos PBR Neutral view transform at +0.3 EV and high-quality OpenImageDenoise (albedo + normal, accurate prefilter), set in `blender/common.py`. PBR Neutral keeps base colours true, so the brand violet stays `#7c3aed` and white stays white on the white page. AgX, and its Punchy look even more, rendered diffuse white as 70 % grey and shifted the violet to blue. `blender/calibrate.py` renders a patch chart to check this. The opener is shot like a high-gloss product page: a glossy white acrylic floor that fades into the page colour, lacquered plastic, a dark studio in the reflections, and the Lens Sim Hasselblad HC 120 mm wide open at f/4.1 with the focus following the machine needle. There are two framings, 16:9 for desktop and 3:4 for phones and portrait tablets. The page picks one with the same media query as the CSS. Wide open the lens vignettes, so the encode divides each frame by a flat frame rendered with the same camera, and the film's edges come out as the page colour. Shadow-catcher floors in the other renders cover the whole frame, and `scripts/renders.mjs` subtracts their faint veil. Each script builds its own scene (`Site …`) and leaves other scenes alone. The hero and the layers are built from the app's **real stitch plan** (`blender/data/mountain-badge.json`), the logo from the app's logo geometry (`blender/data/logo.json`).

**App data and demos** need the Filum editor running (`npm run dev` in the app repo, port 1420), Playwright with Chromium, ffmpeg and ImageMagick:

```bash
NODE_PATH=<playwright>/node_modules node scripts/export-plan.mjs blender/data/mountain-badge.json
NODE_PATH=<playwright>/node_modules node scripts/export-badge.mjs   # the editor demo's data (public/data/badge.json)
NODE_PATH=<playwright>/node_modules npm run capture      # each digitizer preset's stitched result (public/demos, data/digitize.json)
NODE_PATH=<playwright>/node_modules npm run og           # the social card from scripts/og.html
```

## The dummy interfaces

Every demo is an interactive mock-up of Filum's interface, built from real data:

- **Editor**: the sample badge from its real shapes and stitch plan (13,466 stitches) on a canvas, in the Vector, Stitch and Realistic views; pick a layer to see its properties, play or scrub the stitch-out.
- **Digitizer**: presets and a colour slider; the Regions tab reduces the picture's colours live (k-means in Lab), the Stitches tab is the app's real result.
- **Lettering**: type any text in Filum's bundled OFL fonts, as fill, satin edge or outline, on an arc.
- **Threads**: fit the badge to Madeira, Isacord or Brother with CIEDE2000, or pick a colour by hand.
- **Export**: pick a machine; the format follows and the pre-flight check runs over the real design.
- **Command palette**: search the app's 166 real commands (`public/data/commands.json`, from `scripts/export-commands.mjs`), scored like the app's palette; left alone, it types a few queries itself.

## The tour

`src/main.ts` defines the tour (`STEPS`): one stop per section, each with a line of text and a **Show me** action that runs that section's preview. The hero's **Take the tour** button starts it. The tour is a woven-label card with the stop number and a row of progress stitches.
- **Wide screens:** the card glides beside the section in view, and a running stitch sews from it to the demo it's talking about.
- **Smaller screens:** it sits in the corner and steps aside while you use a demo.
- **Phones:** it starts folded into a small stitch-icon button.
- **Always:** it remembers when it was closed, works with the keyboard, and stays still with reduced motion.

There is no mascot.

## Studio details

The page carries a small embroidery-studio theme through its details, in Filum's own bright style:

- **Woven labels:** every section opens with a numbered woven label (`.eyebrow.label`, Nº 01–08), with a fine weave and a running stitch round its edge.
- **The seam:** at 1500 px and wider, a running stitch sews itself down the left margin as you scroll, looping through a small tag for each label (`layoutSeam` and `sewSeam` in `src/main.ts`).
- **Job ticket:** a ticket is pinned on the hero and counts the stitches as the opener sews them. It follows the film's own eased stitch order and carries the design's colour sequence.
- **Tape measure:** the formats marquee is a tape measure laid across the page at a slight angle, with mm, half-cm and cm ticks.
- **Captions:** the renders are captioned as figures (`.fig`, Fig. 1–4).
- **Spec sheet:** the tech specs are a job sheet with numbered rows and the colour sequence; the details are numbered swatches (S-01…).
- **Hang tag:** the get-it panel is a hang tag with an eyelet and its thread, plus an embroidered patch (satin border, running-stitch ring).
