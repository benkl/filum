// Turn the Blender renders (public/renders/*.png, see blender/) into web
// images: transparent margins trimmed (with a little air), WebP with alpha at
// full and half size. The PNGs are build artefacts and are not committed.
//
//   npm run renders
import { execFileSync } from "node:child_process";
import { readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "public", "renders");
// (the opener's posters, hero-badge*, come from scripts/encode-opener.sh)
for (const f of readdirSync(DIR).filter((x) => x.endsWith(".png") && !x.includes("preview") && !x.startsWith("hero-badge"))) {
  const src = join(DIR, f);
  const base = f.replace(/\.png$/, "");
  const trimmed = join(DIR, `${base}.trim.png`);
  {
    // Shadows: the scenes are framed 1.6x wider than the object needs (blender/*.py), so
    // the soft shadows fall off inside the picture (the page scales these images by 1.6, see
    // .bleed in style.css). Take out the shadow catcher's faint even veil and ease what is
    // left of the shadows to nothing with an elliptical falloff over the whole frame (full
    // strength out to 62 % of the way to the edge, nothing at the edge), so no shadow, not
    // even the broad faint wash, ever ends in a line. The object itself (alpha ≥ 0.97) stays.
    const [W, H] = execFileSync("magick", ["identify", "-format", "%w %h", src]).toString().split(" ").map(Number);
    const cw = W, ch = H;
    const veil = Math.min(0.2, +execFileSync("magick", [src, "-alpha", "extract", "-crop", `${Math.round(W * 0.6)}x${Math.round(H * 0.03)}+${Math.round(W * 0.2)}+0`, "-format", "%[fx:mean]", "info:"]).toString());
    execFileSync("magick", [
      src,
      // v: 1 out to 62 % of the way to the frame, easing (smoothstep) to 0 at the frame
      "(", "-size", `${cw}x${ch}`, "-define", `gradient:radii=${cw / 2},${ch / 2}`, "radial-gradient:white-black", "-level", "0%,38%", "-fx", "u * u * (3 - 2 * u)", ")",
      // (shadow pixels are black with some alpha: work on the alpha only)
      "-channel", "A", "-fx", `u >= 0.97 ? u : max(0, (u - ${veil.toFixed(4)}) / ${(1 - veil).toFixed(4)}) * v.r`, "+channel",
      "-delete", "1", trimmed,
    ]);
  }
  execFileSync("magick", [trimmed, "-quality", "88", "-define", "webp:alpha-quality=90", "-define", "webp:method=6", join(DIR, `${base}.webp`)]);
  execFileSync("magick", [trimmed, "-resize", "50%", "-quality", "86", "-define", "webp:method=6", join(DIR, `${base}@half.webp`)]);
  rmSync(trimmed);
  const size = execFileSync("magick", ["identify", "-format", "%wx%h", join(DIR, `${base}.webp`)]).toString();
  console.log(`${base}: ${size}`);
}
