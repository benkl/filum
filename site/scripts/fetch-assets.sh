#!/bin/sh
# Download the CC0 Poly Haven assets the renders use into blender/assets/ (not committed).
set -e
cd "$(dirname "$0")/../blender/assets"
get() { [ -f "$2" ] || curl -sfL -A "filum-site-build" "$1" -o "$2" && echo "$2"; }
B=https://dl.polyhaven.org/file/ph-assets
get "$B/Textures/jpg/4k/rough_linen/rough_linen_diff_4k.jpg" rough_linen_diffuse_4k.jpg
get "$B/Textures/jpg/4k/rough_linen/rough_linen_nor_gl_4k.jpg" rough_linen_nor_gl_4k.jpg
get "$B/Textures/jpg/4k/rough_linen/rough_linen_rough_4k.jpg" rough_linen_rough_4k.jpg
get "$B/Textures/png/4k/rough_linen/rough_linen_disp_4k.png" rough_linen_displacement_4k.png
get "$B/HDRIs/hdr/2k/studio_small_09_2k.hdr" studio_small_09_2k.hdr
