//! Barudan U01 reader/writer (also `.u00`, `.u02`).
//!
//! Ported from pystitch, Ink/Stitch's embroidery file library (MIT, Copyright (c) 2018 Tatarize
//! and the Ink/Stitch contributors)
//! (`U01Writer.py`, `U01Reader.py`).
//!
//! A 0x100-byte header (extents, stitch count), then 3-byte records: a command byte with
//! sign bits and the unsigned y and x deltas in 0.1 mm. Colours are needle sets
//! (C01–C14); the file stores no colours.

use crate::encoder::{encode_with, Cmd, EncodeSettings, Encoded, ThreadChange};
use crate::io::ByteWriter;
use crate::raw::RawPattern;
use crate::tbf::needle;
use crate::{Error, Pattern, WriteOptions};

/// pystitch writer limits; Ink/Stitch writes every format with `full_jump`.
pub(crate) const SETTINGS: EncodeSettings = EncodeSettings {
    max_stitch: 127,
    max_jump: 127,
    full_jump: true,
};
pub(crate) const THREAD_CHANGE: ThreadChange = ThreadChange {
    needle_set: true,
    explicit_trim: false,
};
const HEADER_SIZE: usize = 0x100;

pub(crate) fn encode(p: &Pattern, opts: &WriteOptions) -> Encoded {
    encode_with(p, SETTINGS, opts.long_stitch_as_jumps, THREAD_CHANGE)
}

pub(crate) fn write(p: &Pattern, opts: &WriteOptions) -> Vec<u8> {
    let e = encode(p, opts);
    let mut out = Vec::new();
    out.fill(b'0', 0x80);
    if e.recs.is_empty() {
        return out;
    }
    let (min_x, min_y, max_x, max_y) = e.bounds();
    out.u16le(min_x as u32);
    out.u16le(-max_y as u32);
    out.u16le(max_x as u32);
    out.u16le(-min_y as u32);
    out.u32le(0);
    out.u32le(e.recs.len() as u32 + 1);
    let last = e.recs[e.recs.len() - 1];
    out.u16le(last.x as u32);
    out.u16le(-last.y as u32);
    out.fill(0, HEADER_SIZE - out.len());

    let (mut xx, mut yy) = (0, 0);
    let mut needle_sets = 0;
    for r in &e.recs {
        let dx = r.x - xx;
        let dy = r.y - yy;
        xx = r.x;
        yy = r.y;
        let mut c: u8 = 0x80;
        if dy >= 0 {
            c |= 0x40;
        }
        if dx <= 0 {
            c |= 0x20;
        }
        match r.cmd {
            Cmd::Stitch => {}
            Cmd::Jump => c |= 0x01,
            Cmd::Stop => c |= 0x08,
            Cmd::Trim => c |= 0x07,
            Cmd::ColorChange => {
                let mut n = needle(needle_sets);
                needle_sets += 1;
                if n >= 15 {
                    n = n % 15 + 1;
                }
                c = (c | 0x08).wrapping_add(n);
            }
            Cmd::End => break,
        }
        out.extend_from_slice(&[c, dy.unsigned_abs() as u8, dx.unsigned_abs() as u8]);
    }
    out.extend_from_slice(&[0xF8, 0x00, 0x00]);
    out
}

pub(crate) fn read(bytes: &[u8]) -> Result<Pattern, Error> {
    let mut raw = RawPattern::new();
    read_stitches(bytes.get(HEADER_SIZE..).unwrap_or(&[]), &mut raw, false);
    Ok(raw.finish())
}

/// pystitch `read_u01_stitches` / `read_barudan_dat`. With `strict` (DAT) a command byte
/// without the high bit means "not this format": returns `false`.
pub(crate) fn read_stitches(body: &[u8], raw: &mut RawPattern, strict: bool) -> bool {
    for rec in body.as_chunks::<3>().0 {
        let ctrl = rec[0];
        if strict && ctrl & 0x80 == 0 {
            return false;
        }
        let mut dy = -(rec[1] as i32);
        let mut dx = rec[2] as i32;
        if ctrl & 0x20 != 0 {
            dx = -dx;
        }
        if ctrl & 0x40 != 0 {
            dy = -dy;
        }
        let moved = dx != 0 || dy != 0;
        match ctrl & 0x1F {
            0x00 => raw.stitch(dx, dy),
            0x01 => raw.jump(dx, dy),
            // fast / slow (speeds are not kept), with an optional stitch or jump
            0x02 | 0x04 if moved => raw.stitch(dx, dy),
            0x03 | 0x05 if moved => raw.jump(dx, dy),
            0x02..=0x05 => {}
            // T1 top thread trim, T2 bobbin trim
            0x06 | 0x07 => {
                raw.trim();
                if moved {
                    raw.jump(dx, dy);
                }
            }
            0x08 => {
                raw.stop();
                if moved {
                    raw.jump(dx, dy);
                }
            }
            // C01 – C14 needle sets
            0x09..=0x17 => {
                raw.needle_change();
                if moved {
                    raw.jump(dx, dy);
                }
            }
            _ => break, // 0x18 end, or an unknown command
        }
    }
    true
}
