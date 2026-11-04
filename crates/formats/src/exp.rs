//! Melco EXP reader/writer.
//!
//! Ported from pystitch, Ink/Stitch's embroidery file library (MIT, Copyright (c) 2018 Tatarize
//! and the Ink/Stitch contributors)
//! (`ExpWriter.py`, `ExpReader.py`).
//!
//! EXP is a bare stream of signed 8-bit deltas in 0.1 mm, y up, with `0x80` control codes.
//! It has no colour information.

use crate::encoder::{encode, Cmd, EncodeSettings};
use crate::raw::RawPattern;
use crate::{Error, Pattern, WriteOptions};

pub(crate) const SETTINGS: EncodeSettings = EncodeSettings {
    max_stitch: 127,
    max_jump: 127,
    full_jump: true,
};

pub(crate) fn write(p: &Pattern, opts: &WriteOptions) -> Vec<u8> {
    let e = encode(p, SETTINGS, opts.long_stitch_as_jumps);
    let mut out = Vec::new();
    let (mut xx, mut yy) = (0, 0);
    for r in &e.recs {
        let dx = r.x - xx;
        let dy = r.y - yy;
        xx = r.x;
        yy = r.y;
        match r.cmd {
            Cmd::Stitch => out.extend_from_slice(&[(dx & 0xFF) as u8, (-dy & 0xFF) as u8]),
            Cmd::Jump => {
                out.extend_from_slice(&[0x80, 0x04, (dx & 0xFF) as u8, (-dy & 0xFF) as u8])
            }
            Cmd::Trim => out.extend_from_slice(&[0x80, 0x80, 0x07, 0x00]),
            Cmd::ColorChange | Cmd::Stop => out.extend_from_slice(&[0x80, 0x01, 0x00, 0x00]),
            Cmd::End => {}
        }
    }
    out
}

pub(crate) fn read(bytes: &[u8]) -> Result<Pattern, Error> {
    let mut raw = RawPattern::new();
    read_stitches(bytes, &mut raw);
    Ok(raw.finish())
}

/// pystitch `read_exp_stitches` (also used by STX).
pub(crate) fn read_stitches(bytes: &[u8], raw: &mut RawPattern) {
    let mut i = 0;
    while i + 2 <= bytes.len() {
        let (b0, b1) = (bytes[i], bytes[i + 1]);
        i += 2;
        if b0 != 0x80 {
            raw.stitch(b0 as i8 as i32, -(b1 as i8 as i32));
            continue;
        }
        let control = b1;
        if i + 2 > bytes.len() {
            break;
        }
        let x = bytes[i] as i8 as i32;
        let y = -(bytes[i + 1] as i8 as i32);
        i += 2;
        match control {
            0x80 => raw.trim(),
            0x02 => raw.stitch(x, y),
            0x04 => raw.jump(x, y),
            0x01 => {
                raw.color_change();
                if x != 0 || y != 0 {
                    raw.jump(x, y);
                }
            }
            _ => break,
        }
    }
}
