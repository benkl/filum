//! Janome SEW reader/writer.
//!
//! Ported from pystitch, Ink/Stitch's embroidery file library (MIT, Copyright (c) 2018 Tatarize
//! and the Ink/Stitch contributors)
//! (`SewWriter.py`, `SewReader.py`).
//!
//! A 0x1D78-byte header with up to 12 indices into the SEW thread table and per-block
//! stitch counts, then signed 8-bit deltas in 0.1 mm (y up) with `0x80` control codes.

use crate::encoder::{encode, Cmd, EncodeSettings, Encoded};
use crate::io::{ByteWriter, Reader};
use crate::palette::{build_nonrepeat_palette, sew_slots, table_thread, SEW_PALETTE};
use crate::raw::RawPattern;
use crate::{Error, Pattern, WriteOptions};

/// pystitch's writer sets no limits but stores 8-bit deltas, so cap them at the
/// format's range; Ink/Stitch writes every format with `full_jump`.
pub(crate) const SETTINGS: EncodeSettings = EncodeSettings {
    max_stitch: 127,
    max_jump: 127,
    full_jump: true,
};
const HEADER_SIZE: usize = 0x1D78;
const STITCH_COUNT_OFFSET: usize = 0x32;
/// pystitch: "Cannot store more than 12 colors in SEW format".
pub(crate) const MAX_COLORS: usize = 12;

/// SEW table index (1..=78) per colour block: the thread's own code when it comes from
/// the SEW table, else the nearest table colour (consecutive different threads differ).
pub(crate) fn color_indices(e: &Encoded) -> Vec<usize> {
    let colors: Vec<[u8; 3]> = e.threads.iter().map(|t| t.rgb).collect();
    let nearest = build_nonrepeat_palette(&sew_slots(), &colors);
    e.threads
        .iter()
        .zip(nearest)
        .map(|(t, n)| {
            let own = t.code.trim().parse::<usize>().ok().filter(|&i| t.brand.eq_ignore_ascii_case("sew") && (1..SEW_PALETTE.len()).contains(&i));
            own.unwrap_or(n)
        })
        .collect()
}

pub(crate) fn write(p: &Pattern, opts: &WriteOptions) -> Result<Vec<u8>, Error> {
    let e = encode(p, SETTINGS, opts.long_stitch_as_jumps);
    if e.threads.len() > MAX_COLORS {
        return Err(Error::Unsupported(format!("SEW stores at most {MAX_COLORS} colours, the design has {}", e.threads.len())));
    }
    let mut out = vec![0u8; HEADER_SIZE];
    out.patch_u16le(0, e.threads.len() as u32);
    for (i, index) in color_indices(&e).into_iter().enumerate() {
        out.patch_u16le(2 + 2 * i, index as u32);
    }
    // Records per colour block, colour changes not counted (pystitch `get_as_colorblocks`).
    let mut counts = vec![0u32];
    for r in &e.recs {
        if r.cmd == Cmd::ColorChange {
            counts.push(0);
        } else {
            *counts.last_mut().unwrap() += 1;
        }
    }
    for (i, c) in counts.into_iter().take(MAX_COLORS).enumerate() {
        out.patch_u16le(STITCH_COUNT_OFFSET + 2 * i, c);
    }
    let (mut xx, mut yy) = (0, 0);
    for r in &e.recs {
        let dx = r.x - xx;
        let dy = r.y - yy;
        xx = r.x;
        yy = r.y;
        match r.cmd {
            Cmd::End => break,
            Cmd::Stitch => {
                out.i8(dx);
                out.i8(-dy);
            }
            Cmd::ColorChange => out.extend_from_slice(&[0x80, 0x01, 0x00, 0x00]),
            Cmd::Trim => out.extend_from_slice(&[0x80, 0x02, 0x00, 0x00]),
            Cmd::Jump => {
                out.extend_from_slice(&[0x80, 0x02]);
                out.i8(dx);
                out.i8(-dy);
            }
            Cmd::Stop => {} // pystitch writes nothing for a stop
        }
    }
    out.extend_from_slice(&[0x80, 0x10]);
    Ok(out)
}

pub(crate) fn read(bytes: &[u8]) -> Result<Pattern, Error> {
    let mut r = Reader::new(bytes);
    let colors = r.u16le()?;
    let mut raw = RawPattern::new();
    for _ in 0..colors {
        let index = r.u16le()? as usize;
        raw.threads.push(table_thread(&SEW_PALETTE, index, "Sew"));
    }
    let body = bytes.get(HEADER_SIZE..).unwrap_or(&[]);
    let mut i = 0;
    while i + 2 <= body.len() {
        let (b0, b1) = (body[i], body[i + 1]);
        i += 2;
        if b0 != 0x80 {
            raw.stitch(b0 as i8 as i32, -(b1 as i8 as i32));
            continue;
        }
        let control = b1;
        if i + 2 > body.len() {
            break;
        }
        let (x, y) = (body[i] as i8 as i32, -(body[i + 1] as i8 as i32));
        i += 2;
        if control & 1 != 0 {
            raw.color_change();
        } else if control == 0x04 || control == 0x02 {
            raw.jump(x, y);
        } else if control == 0x10 {
            raw.stitch(x, y);
        } else {
            break;
        }
    }
    Ok(raw.finish())
}
