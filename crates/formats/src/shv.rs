//! Husqvarna Viking SHV reader.
//!
//! Ported from pystitch, Ink/Stitch's embroidery file library (MIT, Copyright (c) 2018 Tatarize
//! and the Ink/Stitch contributors)
//! (`ShvReader.py`).
//!
//! A header with the design name, a preview bitmap and per-colour stitch counts with
//! SHV thread-table indices; then signed 8-bit deltas in 0.1 mm (y down) where `0x80`
//! introduces jumps. Colour changes are implied by the stitch counts.

use crate::io::Reader;
use crate::palette::{table_thread, SHV_PALETTE};
use crate::raw::RawPattern;
use crate::{Error, Pattern};

pub(crate) fn read(bytes: &[u8]) -> Result<Pattern, Error> {
    let mut r = Reader::new(bytes);
    r.seek(0x56)?; // header text
    let len = r.u8()? as usize;
    let mut raw = RawPattern::new();
    raw.name = r.string(len)?.trim_end_matches('\0').to_string();
    let width = r.u8()? as usize;
    let height = r.u8()? as usize;
    r.skip(4 + height.div_ceil(2) * width)?;
    let colors = r.u8()? as usize;
    r.skip(18)?;
    let mut per_color = Vec::with_capacity(colors);
    for _ in 0..colors {
        per_color.push(r.u32be()? as u64);
        let code = r.u8()? as usize;
        raw.threads.push(table_thread(&SHV_PALETTE, code, "Shv"));
        r.skip(9)?;
    }
    r.seek(r.pos - 2)?;

    let mut in_jump = false;
    let mut since_stop: u64 = 0;
    let mut color = 0usize;
    let mut max = per_color.first().copied().unwrap_or(u64::from(u32::MAX));
    while let (Ok(b0), Ok(b1)) = (r.u8(), r.u8()) {
        if since_stop >= max {
            raw.color_change();
            since_stop = 0;
            color += 1;
            max = per_color.get(color).copied().unwrap_or(u64::from(u32::MAX));
        }
        if b0 == 0x80 {
            since_stop += 1;
            match b1 {
                3 => continue,
                2 => {
                    in_jump = false;
                    continue;
                }
                1 => {
                    since_stop += 2;
                    let Ok(sx) = r.u16be() else { break };
                    let Ok(sy) = r.u16be() else { break };
                    in_jump = true;
                    raw.jump(sx as u16 as i16 as i32, sy as u16 as i16 as i32);
                    continue;
                }
                _ => {}
            }
        }
        since_stop += 1;
        let (dx, dy) = (b0 as i8 as i32, b1 as i8 as i32);
        if in_jump {
            raw.jump(dx, dy);
        } else {
            raw.stitch(dx, dy);
        }
    }
    Ok(raw.finish())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cmd;
    use crate::io::ByteWriter;

    #[test]
    fn colour_changes_from_counts() {
        let mut b = vec![0u8; 0x56];
        b.u8(4);
        b.str("Test");
        b.u8(2); // width
        b.u8(3); // height -> 2 rows * 2 bytes of bitmap
        b.fill(0, 4 + 4);
        b.u8(2); // colours
        b.fill(0, 18);
        for (count, code) in [(3u32, 3u8), (2, 12)] {
            b.extend_from_slice(&count.to_be_bytes());
            b.u8(code);
            b.fill(0, 9);
        }
        // the stitches start 2 bytes before the end of the colour table
        b.truncate(b.len() - 2);
        b.extend_from_slice(&[10, 0, 0, 10, 0x80, 0x01, 0x00, 0x14, 0x00, 0x00, 0x80, 0x02, 1, 1]);
        let p = read(&b).unwrap();
        assert_eq!(p.name, "Test");
        let flags: Vec<u8> = p.stitches.iter().map(|s| s.flags).collect();
        // the long jump counts 3 records, so block 1 (3 records) ends after it
        assert_eq!(flags, vec![0, 0, cmd::JUMP, cmd::COLOR_CHANGE, 0, cmd::END]);
        assert_eq!((p.stitches[1].x, p.stitches[1].y), (1.0, 1.0));
        assert_eq!((p.stitches[2].x, p.stitches[2].y), (3.0, 1.0));
        assert!((p.stitches[4].x - 3.1).abs() < 1e-9 && (p.stitches[4].y - 1.1).abs() < 1e-9);
        assert_eq!(p.threads[0].name, "Red");
        assert_eq!(p.threads[1].name, "White");
    }
}
