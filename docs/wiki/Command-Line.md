# Command line

Filum includes a small command-line tool, `filum`, that uses the same stitch engine as the editor. It's handy for converting a folder of files, checking designs in a script, or digitizing in bulk.

## Install

Build it from the repository (see [Building from source](Building-from-Source.md)):

```bash
cargo build -p filum-cli --release
# the program is target/release/filum
```

Or run it straight through Cargo: `cargo run -p filum-cli -- <command>`.

## Commands

```text
filum convert <in> <out>
filum info <file>
filum optimize <in> <out>
filum digitize <image> <out> [--colors N] [--width MM]
filum formats
```

The file extension decides the format, both for reading and for writing.

### convert

Converts between any formats Filum can read and write. For example:

```bash
filum convert design.svg design.pes        # Ink/Stitch SVG → Brother PES
filum convert logo.dst logo.filum      # machine file → editable project
```

### info

Prints the size, stitch count, colours, trims, jumps, thread use and running time, then the stitch quality: short stitches, needle drops on a hole the same object made before, and the spots where the needle goes down more often than the fabric takes (the same checks as **Issues** in the app):

```text
$ filum info cactus.svg
Design      cactus
Objects     14
Size        211.7 × 211.7 mm
Stitches    111958
Colours     14 (13 changes)
Trims       1   Jumps 14
Thread      613.1 m top + 398.5 m bobbin
Run time    142m 39s @ 800 spm
Quality     2635 short stitches, 949 needle drops on an earlier hole (21 of them travel)
            20+ spots over 17 holes/mm², the worst 29 at (113.2, 52.1)
   1. Snow                 #ffffff   61610 st  337.5 m
   2. Cream                #ffe3a3   28037 st  153.0 m
   …
```

On a PES file the thread names are Brother's: by default a PES file stores its colours as entries of Brother's thread table, which every Brother machine reads (see *PES version* in [Export and print](Export-and-Print.md)).

> **Where did my colours go?** Some formats, such as DST, store only the stitches and the colour changes, not the thread colours. `info` on a DST file shows placeholder colours. Use PES, JEF, VP3 or a `.filum` project to keep the real threads.

### optimize

Reorders the objects for fewer colour changes and less travel, without changing which object sits on top, then saves the result. It takes every step that **Optimise** takes in the app by default, centre out on caps and stretchy fabrics included (see [Production tools](Production-Tools.md#optimise)):

```text
$ filum optimize cactus.svg cactus-optimised.pes
colour changes 13 → 11, trims 1 → 3, jumps 572 → 608 mm
```

Colour changes cost far more time than a few centimetres of travel, so the optimiser trades one for the other when it has to.

### digitize

Auto-digitizes a picture with the default settings:

```text
$ filum digitize cactus.png cactus.pes --colors 6 --width 80
Design      Digitized
Objects     11
Size        60.4 × 68.6 mm
Stitches    10439
Colours     7 (6 changes)
…
```

- `--colors N` sets the number of thread colours to reduce the picture to.
- `--width MM` sets the width of the result in millimetres.

The hoop is sized to fit the design. For presets, line art, AI helpers or cross stitch, use the digitizer in the editor ([Auto-digitize](Auto-Digitize.md)).

### formats

Lists every format, with whether it can be read, written, or both:

```text
$ filum formats
dst          Tajima Embroidery Format     read write
pes          Brother Embroidery Format    read write
jef          Janome Embroidery Format     read write
…
```

## Batch example

Convert every PES file in a folder to DST:

```bash
for f in *.pes; do filum convert "$f" "${f%.pes}.dst"; done
```
