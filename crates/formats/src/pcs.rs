//! Pfaff PCS / PCD / PCQ / PCM readers.
//!
//! Ported from pystitch, Ink/Stitch's embroidery file library (MIT, Copyright (c) 2018 Tatarize
//! and the Ink/Stitch contributors)
//! (`PcsReader.py`, `PcdReader.py`, `PcqReader.py`, `PcmReader.py`).
//!
//! 9-byte records with absolute 24-bit coordinates (y up) in units of 0.06 mm
//! (pystitch's `PC_SIZE_CONVERSION_RATIO` 5/3 of 0.1 mm).

use crate::io::Reader;
use crate::raw::RawPattern;
use crate::{Error, Pattern, Thread};

/// File units per millimetre (10 / (5/3)).
const UNITS_PER_MM: f64 = 6.0;

fn signed24(v: u32) -> i32 {
    ((v << 8) as i32) >> 8
}

/// Applies one record; `false` stops reading (pystitch "uncaught control").
fn record(raw: &mut RawPattern, x: u32, y: u32, ctrl: u8) -> bool {
    let (x, y) = (signed24(x), -signed24(y));
    if ctrl == 0x00 {
        raw.stitch_abs(x, y);
    } else if ctrl & 0x01 != 0 {
        raw.color_change();
    } else if ctrl & 0x04 != 0 {
        raw.jump_abs(x, y);
    } else {
        return false;
    }
    true
}

/// PCS, PCD and PCQ (pystitch `read_pc_file`).
pub(crate) fn read(bytes: &[u8]) -> Result<Pattern, Error> {
    let mut r = Reader::new(bytes);
    let _version = r.u8()?;
    let _hoop = r.u8()?; // 0 PCD, 1 PCQ (Maxi), 2 PCS small hoop, 3 PCS large hoop
    let colors = r.u16le()?;
    let mut raw = RawPattern::new();
    for _ in 0..colors {
        let c = r.u24be()?;
        raw.threads.push(Thread::from_rgb([(c >> 16) as u8, (c >> 8) as u8, c as u8]));
        r.skip(1)?;
    }
    let _stitch_count = r.u16le()?;
    while r.remaining() >= 9 {
        let _c0 = r.u8()?;
        let x = r.u24le()?;
        let _c1 = r.u8()?;
        let y = r.u24le()?;
        let ctrl = r.u8()?;
        if !record(&mut raw, x, y, ctrl) {
            break;
        }
    }
    Ok(raw.finish_scaled(UNITS_PER_MM))
}

/// pystitch's PCM colour table.
const PCM_COLORS: [u32; 16] = [
    0x000000, 0x000080, 0x0000FF, 0x008080, 0x00FFFF, 0x800080, 0xFF00FF, 0x800000, 0xFF0000, 0x008000, 0x00FF00, 0x808000, 0xFFFF00,
    0x808080, 0xC0C0C0, 0xFFFFFF,
];

pub(crate) fn read_pcm(bytes: &[u8]) -> Result<Pattern, Error> {
    let mut r = Reader::new(bytes);
    r.seek(2)?;
    let mut raw = RawPattern::new();
    let colors = r.u16be()?;
    for _ in 0..colors {
        let i = r.u16be()? as usize % PCM_COLORS.len();
        let c = PCM_COLORS[i];
        raw.threads.push(Thread {
            rgb: [(c >> 16) as u8, (c >> 8) as u8, c as u8],
            name: format!("PCM Color {}", i + 1),
            ..Default::default()
        });
    }
    let _stitch_count = r.u16be()?;
    while r.remaining() >= 9 {
        let x = r.u24be()?;
        let _c0 = r.u8()?;
        let y = r.u24be()?;
        let _c1 = r.u8()?;
        let ctrl = r.u8()?;
        if !record(&mut raw, x, y, ctrl) {
            break;
        }
    }
    Ok(raw.finish_scaled(UNITS_PER_MM))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cmd;
    use crate::io::ByteWriter;

    #[test]
    fn reads_absolute_records() {
        let mut b = Vec::new();
        b.extend_from_slice(&[0x32, 0x03]);
        b.u16le(2);
        b.extend_from_slice(&[0xFF, 0x00, 0x00, 0x00, 0x00, 0x00, 0xFF, 0x00]);
        b.u16le(4);
        // (c0, x, c1, y, ctrl); 60 units = 10 mm, y up
        for (x, y, ctrl) in [(0i32, 0i32, 0u8), (60, -30, 0), (0, 0, 1), (120, 0, 4), (120, 6, 0), (0, 0, 0x02)] {
            b.u8(0);
            b.u24le(x as u32 & 0xFF_FFFF);
            b.u8(0);
            b.u24le(y as u32 & 0xFF_FFFF);
            b.u8(ctrl);
        }
        let p = read(&b).unwrap();
        let flags: Vec<u8> = p.stitches.iter().map(|s| s.flags).collect();
        assert_eq!(flags, vec![0, 0, cmd::COLOR_CHANGE, cmd::JUMP, 0, cmd::END]);
        assert_eq!((p.stitches[1].x, p.stitches[1].y), (10.0, 5.0));
        assert_eq!((p.stitches[4].x, p.stitches[4].y), (20.0, -1.0));
        assert_eq!(p.threads[0].rgb, [0xFF, 0, 0]);
        assert_eq!(p.threads[1].rgb, [0, 0, 0xFF]);
    }

    #[test]
    fn pcm_big_endian() {
        let mut b = vec![0, 0];
        b.u16be(1);
        b.u16be(8);
        b.u16be(1);
        // x = 6, y = 12 (24-bit big-endian), c0, c1, ctrl
        b.extend_from_slice(&[0, 0, 6, 0, 0, 0, 12, 0, 0]);
        let p = read_pcm(&b).unwrap();
        assert_eq!((p.stitches[0].x, p.stitches[0].y), (1.0, -2.0));
        assert_eq!(p.threads[0].rgb, [0xFF, 0, 0]);
    }
}
