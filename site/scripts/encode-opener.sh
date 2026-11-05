#!/bin/sh
# Encode the opener frames (blender/hero_opener.py --anim / --flat, desktop and mobile)
# into opener[-m].webm (VP9), opener[-m].mp4 (H.264) and the posters hero-badge[-m].webp
# (the last frame).
#
# Flat-field: each frame is divided by its flat frame (flat####.png: the lens's vignetting
# on an even floor in the page colour, which changes as the lens refocuses), so the film's
# edges are exactly the page colour.
# Colour management: the maths runs in RGB, the result is converted to YUV with the BT.709
# matrix (not ffmpeg's BT.601 default) and tagged, so browsers decode the exact sRGB values.
set -e
OUT="$(dirname "$0")/../public/renders"
# the page colour #f1f1ee, per plane in ffmpeg's gbrp order (G, B, R)
FLAT="c0_expr='min(255,A*241/max(B,1))':c1_expr='min(255,A*238/max(B,1))':c2_expr='min(255,A*241/max(B,1))'"
TAGS="-colorspace bt709 -color_primaries bt709 -color_trc iec61966-2-1 -color_range tv"
TO_YUV="scale=out_color_matrix=bt709:out_range=tv,format=yuv420p,setparams=range=tv:color_primaries=bt709:color_trc=iec61966-2-1:colorspace=bt709"
for v in "" "-m"; do
  IN=/tmp/filum-opener$v
  [ -f "$IN/f0195.png" ] && [ -f "$IN/flat0195.png" ] || { echo "skip opener$v: frames or flat frames missing in $IN"; continue; }
  SIZE=$(magick identify -format "%wx%h" "$IN/f0001.png")
  W=${SIZE%x*}; H=${SIZE#*x}
  CORR="[1:v]scale=$W:$H:flags=bicubic,format=gbrp[f];[0:v]format=gbrp[a];[a][f]blend=$FLAT:shortest=1"
  ffmpeg -y -loglevel error -framerate 30 -i "$IN/f%04d.png" -framerate 30 -i "$IN/flat%04d.png" -filter_complex "$CORR,$TO_YUV" -c:v libvpx-vp9 -b:v 0 -crf 30 -row-mt 1 $TAGS "$OUT/opener$v.webm"
  ffmpeg -y -loglevel error -framerate 30 -i "$IN/f%04d.png" -framerate 30 -i "$IN/flat%04d.png" -filter_complex "$CORR,$TO_YUV" -c:v libx264 -crf 20 -preset slow $TAGS -movflags +faststart "$OUT/opener$v.mp4"
  # the poster: the finished design, the same correction, as WebP (full and half size)
  ffmpeg -y -loglevel error -i "$IN/f0195.png" -i "$IN/flat0195.png" -filter_complex "$CORR,format=rgb24" -frames:v 1 "$IN/poster.png"
  magick "$IN/poster.png" -quality 86 -define webp:method=6 "$OUT/hero-badge$v.webp"
  magick "$IN/poster.png" -resize 50% -quality 84 -define webp:method=6 "$OUT/hero-badge$v@half.webp"
  ls -la "$OUT/opener$v.webm" "$OUT/opener$v.mp4" "$OUT/hero-badge$v.webp"
done
