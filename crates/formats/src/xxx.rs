//! Singer XXX reader/writer.
//!
//! Ported from pystitch, Ink/Stitch's embroidery file library (MIT, Copyright (c) 2018 Tatarize
//! and the Ink/Stitch contributors)
//! (`XxxWriter.py`, `XxxReader.py`).
//!
//! A 0x100-byte header, signed 8-bit deltas in 0.1 mm (y up) with `0x7F` control codes,
//! then an RGB colour table after the end marker.

use crate::encoder::{check_count, check_extent, check_size, encode, Cmd, EncodeSettings};
use crate::io::{ByteWriter, Reader};
use crate::raw::RawPattern;
use crate::{Error, Pattern, Thread, WriteOptions};

pub(crate) const SETTINGS: EncodeSettings = EncodeSettings {
    max_stitch: 124,
    max_jump: 124,
    full_jump: true,
};

pub(crate) fn write(p: &Pattern, opts: &WriteOptions) -> Result<Vec<u8>, Error> {
    let e = encode(p, SETTINGS, opts.long_stitch_as_jumps);
    // Header sizes and positions are 16-bit (signed: positions can be negative);
    // readers take the colour count as 16-bit.
    let (min_x, min_y, max_x, max_y) = e.bounds();
    let last = e.recs.last().map_or((0, 0), |r| (r.x, r.y));
    check_count("XXX", e.threads.len(), 0xFFFF, "colours")?;
    check_size("XXX", max_x - min_x, max_y - min_y, 0x7FFF, 0x7FFF)?;
    check_extent("XXX", &[last.0, -last.1, -min_x, max_y], -0x8000, 0x7FFF)?;
    let mut out = Vec::new();
    // Header ("b" variant).
    out.fill(0, 0x17);
    out.u32le(e.recs.len().saturating_sub(1) as u32);
    out.fill(0, 0x0C);
    out.u32le(e.threads.len() as u32);
    out.u16le(0);
    out.u16le((max_x - min_x) as u32);
    out.u16le((max_y - min_y) as u32);
    out.u16le(last.0 as u32);
    out.u16le((-last.1) as u32);
    out.u16le((-min_x) as u32);
    out.u16le(max_y as u32);
    out.fill(0, 0x42);
    out.u16le(0);
    out.u16le(0);
    out.fill(0, 0x73);
    out.u16le(0x20);
    out.fill(0, 0x08);
    let end_pos = out.len();
    out.u32le(0);
    debug_assert_eq!(out.len(), 0x100);

    let (mut xx, mut yy) = (0, 0);
    for r in &e.recs {
        let dx = r.x - xx;
        let dy = r.y - yy;
        xx = r.x;
        yy = r.y;
        match r.cmd {
            Cmd::ColorChange | Cmd::Stop => {
                out.extend_from_slice(&[0x7F, 0x08]);
                out.i8(dx);
                out.i8(-dy);
            }
            Cmd::End => break,
            Cmd::Stitch => {
                // 0x7D..=0x7F are reserved as the first byte, so 125..=127 need the long form.
                if (-124..=124).contains(&dx) && (-124..=124).contains(&dy) {
                    out.i8(dx);
                    out.i8(-dy);
                } else {
                    out.u8(0x7D);
                    out.u16le((dx & 0xFFFF) as u32);
                    out.u16le((-dy & 0xFFFF) as u32);
                }
            }
            Cmd::Trim => {
                out.extend_from_slice(&[0x7F, 0x03]);
                out.i8(dx);
                out.i8(-dy);
            }
            Cmd::Jump => {
                out.extend_from_slice(&[0x7F, 0x01]);
                out.i8(dx);
                out.i8(-dy);
            }
        }
    }
    let stitches_end = out.len();
    out.patch_u32le(end_pos, stitches_end as u32);
    out.extend_from_slice(&[0x7F, 0x7F, 0x02, 0x14]);
    // Colour table.
    out.u8(0);
    out.u8(0);
    for t in &e.threads {
        out.u8(0);
        out.extend_from_slice(&t.rgb);
    }
    for _ in e.threads.len()..21 {
        out.u32le(0);
    }
    out.u32le(0xFFFF_FF00);
    out.u8(0);
    out.u8(1);
    Ok(out)
}

pub(crate) fn read(bytes: &[u8]) -> Result<Pattern, Error> {
    let mut r = Reader::new(bytes);
    r.seek(0x27)?;
    let num_colors = r.u16le()? as usize;
    r.seek(0x100)?;
    let mut raw = RawPattern::new();
    while let Ok(b1) = r.u8() {
        if b1 == 0x7D || b1 == 0x7E {
            let Ok(x) = r.i16le() else { break };
            let Ok(y) = r.i16le() else { break };
            raw.jump(x, -y);
            continue;
        }
        let Ok(b2) = r.u8() else { break };
        if b1 != 0x7F {
            raw.stitch(b1 as i8 as i32, -(b2 as i8 as i32));
            continue;
        }
        let Ok(b3) = r.u8() else { break };
        let Ok(b4) = r.u8() else { break };
        let (x, y) = (b3 as i8 as i32, -(b4 as i8 as i32));
        match b2 {
            0x01 => raw.jump(x, y),
            0x03 => {
                raw.trim();
                if x != 0 || y != 0 {
                    raw.jump(x, y);
                }
            }
            0x08 | 0x0A..=0x17 => raw.color_change(),
            0x7F | 0x18 => break,
            _ => {}
        }
    }
    if r.skip(2).is_ok() {
        for _ in 0..num_colors {
            let Ok(c) = r.i32be() else { break };
            let c = c as u32;
            raw.threads
                .push(Thread::from_rgb([(c >> 16) as u8, (c >> 8) as u8, c as u8]));
        }
    }
    Ok(raw.finish())
}
