//! Husqvarna Viking HUS reader.
//!
//! Ported from pystitch, Ink/Stitch's embroidery file library (MIT, Copyright (c) 2018 Tatarize
//! and the Ink/Stitch contributors)
//! (`HusReader.py`).
//!
//! A header with Husqvarna thread-table indices, then three separately compressed
//! streams (commands, x deltas, y deltas; see [`crate::compress`]), 0.1 mm, y up.

use crate::compress::expand;
use crate::io::Reader;
use crate::palette::{table_thread, HUS_PALETTE};
use crate::raw::RawPattern;
use crate::{Error, Pattern};

pub(crate) fn read(bytes: &[u8]) -> Result<Pattern, Error> {
    let mut r = Reader::new(bytes);
    let _magic = r.u32le()?;
    let stitches = r.u32le()? as usize;
    let colors = r.u32le()? as usize;
    if stitches == 0 {
        return Err(Error::Malformed("no stitches found, the file appears to be corrupted".into()));
    }
    r.skip(8)?; // extents: +x, +y, -x, -y
    let command_offset = r.u32le()? as usize;
    let x_offset = r.u32le()? as usize;
    let y_offset = r.u32le()? as usize;
    r.skip(8 + 2)?; // string, unknown
    let mut raw = RawPattern::new();
    for _ in 0..colors {
        let index = r.u16le()? as usize;
        raw.threads.push(table_thread(&HUS_PALETTE, index, "Hus"));
    }
    let section = |from: usize, to: usize| bytes.get(from..to.min(bytes.len()).max(from)).unwrap_or(&[]);
    // Each stream holds one byte per stitch; never expand past what the file can hold.
    let limit = stitches.min(bytes.len().saturating_mul(256));
    let commands = expand(section(command_offset, x_offset), limit);
    let xs = expand(section(x_offset, y_offset), limit);
    let ys = expand(section(y_offset, bytes.len()), limit);
    let count = commands.len().min(xs.len()).min(ys.len());
    for i in 0..count {
        let x = xs[i] as i8 as i32;
        let y = -(ys[i] as i8 as i32);
        match commands[i] {
            0x80 => raw.stitch(x, y),
            0x81 => raw.jump(x, y),
            0x84 => {
                raw.color_change();
                if x != 0 || y != 0 {
                    raw.jump(x, y);
                }
            }
            0x88 => {
                if x != 0 || y != 0 {
                    raw.jump(x, y);
                }
                raw.trim();
            }
            _ => break, // 0x90 end, or an unmapped command
        }
    }
    Ok(raw.finish())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cmd;
    use crate::compress::tests::compress;
    use crate::io::ByteWriter;

    /// A HUS file with the given (command, dx, dy) records, deltas y up.
    pub(crate) fn hus_file(recs: &[(u8, i8, i8)], colors: &[u16]) -> Vec<u8> {
        let c: Vec<u8> = recs.iter().map(|r| r.0).collect();
        let x: Vec<u8> = recs.iter().map(|r| r.1 as u8).collect();
        let y: Vec<u8> = recs.iter().map(|r| r.2 as u8).collect();
        let (c, x, y) = (compress(&c), compress(&x), compress(&y));
        let header = 4 * 3 + 8 + 4 * 3 + 8 + 2 + 2 * colors.len();
        let mut out = Vec::new();
        out.u32le(0x0090_FF00);
        out.u32le(recs.len() as u32);
        out.u32le(colors.len() as u32);
        out.fill(0, 8);
        out.u32le(header as u32);
        out.u32le((header + c.len()) as u32);
        out.u32le((header + c.len() + x.len()) as u32);
        out.fill(0, 10);
        for &i in colors {
            out.u16le(i as u32);
        }
        out.extend_from_slice(&c);
        out.extend_from_slice(&x);
        out.extend_from_slice(&y);
        out
    }

    #[test]
    fn reads_compressed_streams() {
        let bytes = hus_file(&[(0x80, 0, 0), (0x80, 10, 5), (0x88, 0, 0), (0x81, 20, 0), (0x84, 0, 0), (0x80, -3, -4), (0x90, 0, 0)], &[3, 12]);
        let p = read(&bytes).unwrap();
        let flags: Vec<u8> = p.stitches.iter().map(|s| s.flags).collect();
        assert_eq!(flags, vec![0, 0, cmd::TRIM, cmd::JUMP, cmd::COLOR_CHANGE, 0, cmd::END]);
        assert_eq!((p.stitches[1].x, p.stitches[1].y), (1.0, -0.5));
        assert_eq!((p.stitches[5].x, p.stitches[5].y), (2.7, -0.1));
        assert_eq!(p.threads.len(), 2);
        assert_eq!(p.threads[0].name, "Red");
        assert_eq!(p.threads[1].rgb, [0xff, 0xff, 0xff]);
    }

    #[test]
    fn truncated_is_an_error_not_a_panic() {
        let bytes = hus_file(&[(0x80, 1, 1)], &[0]);
        for n in 0..bytes.len() {
            let _ = read(&bytes[..n]);
        }
        assert!(read(&[0; 12]).is_err());
    }
}
