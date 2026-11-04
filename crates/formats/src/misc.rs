//! Readers for the less common machine formats: TAP, EXY, FXY, GT, DSB, DSZ, STX, EMD,
//! ZXY, ZHS, 10O, 100, BRO, INB, KSM, MAX, MIT, NEW, PHB, PHC, SPX, STC, JPX, DAT.
//!
//! Ported from pystitch, Ink/Stitch's embroidery file library (MIT, Copyright (c) 2018 Tatarize
//! and the Ink/Stitch contributors)
//! (`TapReader.py`, `ExyReader.py`, `FxyReader.py`, `GtReader.py`, `DsbReader.py`,
//! `DszReader.py`, `StxReader.py`, `EmdReader.py`, `ZxyReader.py`, `ZhsReader.py`,
//! `A10oReader.py`, `A100Reader.py`, `BroReader.py`, `InbReader.py`, `KsmReader.py`,
//! `MaxReader.py`, `MitReader.py`, `NewReader.py`, `PhbReader.py`, `PhcReader.py`,
//! `SpxReader.py`, `StcReader.py`, `JpxReader.py`, `DatReader.py`).
//!
//! All of them store 0.1 mm units unless noted; deltas are converted to y down here.
//! Where pystitch would raise on malformed input these readers stop early instead.

use crate::io::Reader;
use crate::palette::pec_thread;
use crate::raw::RawPattern;
use crate::{default_thread, dst, exp, pec, u01, Error, Pattern, Thread};

fn tail(bytes: &[u8], from: usize) -> &[u8] {
    bytes.get(from..).unwrap_or(&[])
}

fn s8(b: u8) -> i32 {
    b as i8 as i32
}

// ----------------------------------------------------------------------------------------
// DST relatives
// ----------------------------------------------------------------------------------------

/// Happy TAP: DST records without a header.
pub(crate) fn read_tap(bytes: &[u8]) -> Result<Pattern, Error> {
    let mut raw = RawPattern::new();
    dst::read_stitches(bytes, &mut raw);
    Ok(raw.finish())
}

/// Eltac EXY (`.e00`, `.e01`, …): DST records after a 0x100-byte header.
pub(crate) fn read_exy(bytes: &[u8]) -> Result<Pattern, Error> {
    let mut raw = RawPattern::new();
    dst::read_stitches(tail(bytes, 0x100), &mut raw);
    Ok(raw.finish())
}

/// pystitch `z_stitch_encoding_read` (DSZ, FXY, GT).
fn z_stitches(body: &[u8], raw: &mut RawPattern) {
    for b in body.as_chunks::<3>().0 {
        let mut y = -(b[0] as i32);
        let mut x = b[1] as i32;
        let ctrl = b[2];
        if ctrl & 0x40 != 0 {
            x = -x;
        }
        if ctrl & 0x20 != 0 {
            y = -y;
        }
        match ctrl {
            _ if ctrl & 0x1F == 0 => raw.stitch(x, y),
            _ if ctrl & 0x1F == 1 => raw.jump(x, y),
            0x82 => raw.stop(),
            0x9B => raw.trim(),
            0x83..=0x9A => raw.needle_change(),
            _ => break,
        }
    }
}

/// ZSK USA DSZ: DST header, then z-encoded records.
pub(crate) fn read_dsz(bytes: &[u8]) -> Result<Pattern, Error> {
    let mut raw = RawPattern::new();
    dst::read_header(bytes, &mut raw);
    z_stitches(tail(bytes, 512), &mut raw);
    Ok(raw.finish())
}

/// Fortron FXY (`.f00`, `.f01`, …).
pub(crate) fn read_fxy(bytes: &[u8]) -> Result<Pattern, Error> {
    let mut raw = RawPattern::new();
    z_stitches(tail(bytes, 0x100), &mut raw);
    Ok(raw.finish())
}

/// Gold Thread GT.
pub(crate) fn read_gt(bytes: &[u8]) -> Result<Pattern, Error> {
    let mut raw = RawPattern::new();
    z_stitches(tail(bytes, 0x200), &mut raw);
    Ok(raw.finish())
}

/// Tajima (Barudan) DSB: DST header, then b-encoded records.
pub(crate) fn read_dsb(bytes: &[u8]) -> Result<Pattern, Error> {
    let mut raw = RawPattern::new();
    dst::read_header(bytes, &mut raw);
    for b in tail(bytes, 512).as_chunks::<3>().0 {
        let ctrl = b[0];
        let mut y = -(b[1] as i32);
        let mut x = b[2] as i32;
        if ctrl & 0x40 != 0 {
            y = -y;
        }
        if ctrl & 0x20 != 0 {
            x = -x;
        }
        match ctrl {
            _ if ctrl & 0x1F == 0 => raw.stitch(x, y),
            _ if ctrl & 0x1F == 1 => raw.jump(x, y),
            0xE7 => raw.trim(),
            0xE8 => raw.stop(),
            0xE9..=0xF7 => raw.needle_change(),
            _ => break, // 0xF8 end
        }
    }
    Ok(raw.finish())
}

// ----------------------------------------------------------------------------------------
// EXP relatives
// ----------------------------------------------------------------------------------------

/// Data Stitch STX: EXP records at an offset given in the header.
pub(crate) fn read_stx(bytes: &[u8]) -> Result<Pattern, Error> {
    let mut r = Reader::at(bytes, 0);
    r.seek(0x0C)?;
    let _colors_at = r.u32le()?;
    let _unknown_at = r.u32le()?;
    let stitches_at = r.u32le()? as usize;
    let mut raw = RawPattern::new();
    exp::read_stitches(tail(bytes, stitches_at), &mut raw);
    Ok(raw.finish())
}

/// Elna EMD.
pub(crate) fn read_emd(bytes: &[u8]) -> Result<Pattern, Error> {
    let body = tail(bytes, 0x30);
    let mut raw = RawPattern::new();
    let mut i = 0;
    while i + 2 <= body.len() {
        let (b0, b1) = (body[i], body[i + 1]);
        i += 2;
        if b0 != 0x80 {
            raw.stitch(s8(b0), -s8(b1));
            continue;
        }
        match b1 {
            0x80 => {
                if i + 2 > body.len() {
                    break;
                }
                raw.jump(s8(body[i]), -s8(body[i + 1]));
                i += 2;
            }
            0x2A => raw.color_change(),
            0x7D => {}               // unknown, seen at position 0
            0xAD | 0x90 => raw.trim(), // 0x90: final command before returning to start
            _ => break,              // 0xFD end
        }
    }
    Ok(raw.finish())
}

/// Janome JPX.
pub(crate) fn read_jpx(bytes: &[u8]) -> Result<Pattern, Error> {
    let mut r = Reader::new(bytes);
    let stitches_at = r.u32le()? as usize;
    r.skip(0x1C)?;
    let colors = r.u32le()?;
    r.skip(0x18)?;
    let mut raw = RawPattern::new();
    for i in 0..colors as usize {
        let Ok(index) = r.u32le() else { break };
        // pystitch picks random colours; distinct defaults are reproducible.
        raw.threads.push(Thread { name: format!("JPX index {index}"), ..default_thread(i) });
    }
    let body = tail(bytes, stitches_at);
    let mut i = 0;
    while i + 2 <= body.len() {
        let (b0, b1) = (body[i], body[i + 1]);
        i += 2;
        if b0 != 0x80 {
            raw.stitch(s8(b0), -s8(b1));
            continue;
        }
        if i + 2 > body.len() {
            break;
        }
        let (x, y) = (s8(body[i]), -s8(body[i + 1]));
        i += 2;
        match b1 {
            0x02 => raw.jump(x, y),
            0x01 => {
                raw.color_change();
                // pystitch tests `x != 0 and y != 0`, dropping one-axis moves.
                if x != 0 || y != 0 {
                    raw.jump(x, y);
                }
            }
            _ => break, // 0x10 end
        }
    }
    Ok(raw.finish())
}

// ----------------------------------------------------------------------------------------
// Sign-magnitude 3-byte records
// ----------------------------------------------------------------------------------------

/// ZSK TC ZXY.
pub(crate) fn read_zxy(bytes: &[u8]) -> Result<Pattern, Error> {
    let mut r = Reader::new(bytes);
    r.seek(1)?;
    let start = r.u16be()? as usize;
    let mut raw = RawPattern::new();
    for b in tail(bytes, 3 + start).as_chunks::<3>().0 {
        let mut x = b[1] as i32;
        let mut y = -(b[2] as i32);
        if b[0] & 0x08 != 0 {
            x = -x;
        }
        if b[0] & 0x04 != 0 {
            y = -y;
        }
        let ctrl = b[0] & !0x0C;
        if ctrl == 0 {
            raw.stitch(x, y);
        } else if ctrl & 0x02 != 0 {
            raw.jump(x, y);
        } else if ctrl & 0x20 != 0 {
            if b[1] == 0xFF {
                break;
            }
            raw.needle_change();
        }
    }
    Ok(raw.finish())
}

/// Toyota 10O.
pub(crate) fn read_10o(bytes: &[u8]) -> Result<Pattern, Error> {
    let mut raw = RawPattern::new();
    for b in bytes.as_chunks::<3>().0 {
        let ctrl = b[0];
        let mut y = -(b[1] as i32);
        let mut x = b[2] as i32;
        if ctrl & 0x20 != 0 {
            x = -x;
        }
        if ctrl & 0x40 != 0 {
            y = -y;
        }
        match ctrl {
            _ if ctrl & 0x1F == 0 => raw.stitch(x, y),
            _ if ctrl & 0x1F == 0x10 => raw.jump(x, y),
            0x8A => {} // start
            0x85 => raw.color_change(),
            0x82 => raw.stop(),
            0x81 => raw.trim(),
            _ => break, // 0x87 end
        }
    }
    Ok(raw.finish())
}

/// Toyota 100: 4-byte records.
pub(crate) fn read_100(bytes: &[u8]) -> Result<Pattern, Error> {
    let mut raw = RawPattern::new();
    for b in bytes.as_chunks::<4>().0 {
        let sm = |v: u8| if v > 0x80 { -((v - 0x80) as i32) } else { v as i32 };
        let (x, y) = (sm(b[2]), sm(b[3]));
        if b[0] == 0x61 {
            raw.stitch(x, -y);
        } else if b[0] & 0x01 != 0 {
            raw.jump(x, -y);
        } else {
            raw.color_change();
        }
    }
    Ok(raw.finish())
}

/// Inbro INB.
pub(crate) fn read_inb(bytes: &[u8]) -> Result<Pattern, Error> {
    let mut raw = RawPattern::new();
    for b in tail(bytes, 0x2000).as_chunks::<3>().0 {
        let mut x = b[0] as i32;
        let mut y = -(b[1] as i32);
        let ctrl = b[2];
        if ctrl & 0x20 != 0 {
            y = -y;
        }
        if ctrl & 0x40 != 0 {
            x = -x;
        }
        match ctrl & 0x0F {
            0x00 => raw.stitch(x, y),
            0x01 => {
                raw.color_change();
                if x != 0 || y != 0 {
                    raw.jump(x, y);
                }
            }
            0x02 => raw.jump(x, y),
            _ => break, // 0x04 end
        }
    }
    Ok(raw.finish())
}

/// Pfaff KSM.
pub(crate) fn read_ksm(bytes: &[u8]) -> Result<Pattern, Error> {
    let mut raw = RawPattern::new();
    let mut trimmed = false;
    let mut stitched_yet = false;
    for b in tail(bytes, 0x200).as_chunks::<3>().0 {
        let mut y = -(b[0] as i32);
        let mut x = b[1] as i32;
        if b[2] & 0x40 != 0 {
            x = -x;
        }
        if b[2] & 0x20 != 0 {
            y = -y;
        }
        if x != 0 || y != 0 {
            // the displacement is executed whatever the command
            if trimmed {
                raw.jump(x, y);
            } else {
                raw.stitch(x, y);
                stitched_yet = true;
            }
        }
        match b[2] & 0x1F {
            0x00 => {}
            0x07 | 0x13 | 0x1D => {
                if stitched_yet {
                    raw.trim();
                }
                trimmed = true;
            }
            0x17..=0x19 | 0x1B => trimmed = false, // start sewing again / before end
            0x0B..=0x12 => {
                raw.needle_change();
                trimmed = true;
            }
            0x05 => raw.stop(),
            _ => break, // 0x08 end
        }
    }
    Ok(raw.finish())
}

/// Ameco NEW.
pub(crate) fn read_new(bytes: &[u8]) -> Result<Pattern, Error> {
    let mut raw = RawPattern::new();
    for b in tail(bytes, 2).as_chunks::<3>().0 {
        let mut x = b[0] as i32;
        let mut y = -(b[1] as i32);
        if b[2] & 0x40 != 0 {
            x = -x;
        }
        if b[2] & 0x20 != 0 {
            y = -y;
        }
        let ctrl = b[2] & !0xE0;
        if ctrl == 0 {
            raw.stitch(x, y);
        } else if ctrl == 0x11 {
            break;
        } else if ctrl & 0x02 != 0 {
            raw.color_change();
        } else if ctrl & 0x01 != 0 {
            raw.jump(x, y);
        }
    }
    Ok(raw.finish())
}

/// Gunold STC.
pub(crate) fn read_stc(bytes: &[u8]) -> Result<Pattern, Error> {
    let mut raw = RawPattern::new();
    for b in tail(bytes, 0x28).as_chunks::<3>().0 {
        let (x, y) = (s8(b[0]), -s8(b[1]));
        match b[2] {
            0x01 => raw.stitch(x, y),
            0x00 => raw.jump(x, y),
            25 => break,
            _ => raw.needle_change(),
        }
    }
    Ok(raw.finish())
}

/// Sunstar or Barudan DAT: Barudan records (as U01) if every command byte has its
/// high bit set, else Sunstar records after a 0x100-byte header.
pub(crate) fn read_dat(bytes: &[u8]) -> Result<Pattern, Error> {
    let mut raw = RawPattern::new();
    if u01::read_stitches(bytes, &mut raw, true) {
        return Ok(raw.finish());
    }
    let mut raw = RawPattern::new();
    for b in tail(bytes, 0x100).as_chunks::<3>().0 {
        let mut x = (b[0] & 0x7F) as i32;
        let mut y = (b[1] & 0x7F) as i32;
        if b[0] & 0x80 != 0 {
            x = -x;
        }
        if b[1] & 0x80 != 0 {
            y = -y;
        }
        let y = -y;
        match b[2] {
            0x07 | 0x84 => raw.stitch(x, y), // 0x84: initialisation info
            0x04 => raw.jump(x, y),
            0x80 | 0x87 => {
                if b[2] == 0x80 {
                    raw.trim();
                } else {
                    raw.color_change();
                }
                if x != 0 || y != 0 {
                    raw.jump(x, y);
                }
            }
            _ => break, // 0x00 end
        }
    }
    Ok(raw.finish())
}

// ----------------------------------------------------------------------------------------
// Others
// ----------------------------------------------------------------------------------------

/// Bits & Volts BRO.
pub(crate) fn read_bro(bytes: &[u8]) -> Result<Pattern, Error> {
    let mut r = Reader::at(bytes, 0);
    r.seek(0x100.min(bytes.len()))?;
    let mut raw = RawPattern::new();
    while let (Ok(b0), Ok(b1)) = (r.u8(), r.u8()) {
        if b0 != 0x80 {
            raw.stitch(s8(b0), -s8(b1));
            continue;
        }
        let Ok(control) = r.u8() else { break };
        match control {
            0x00 => {}
            0x7E | 0x03 | 0xE1..=0xEF => {
                if control > 0xE0 {
                    raw.needle_change();
                }
                let (Ok(x), Ok(y)) = (r.i16le(), r.i16le()) else { break };
                raw.jump(x, -y);
            }
            _ => break, // 0x02, 0xE0 end
        }
    }
    Ok(raw.finish())
}

/// Mitsubishi MIT: 2-byte records in 0.2 mm.
pub(crate) fn read_mit(bytes: &[u8]) -> Result<Pattern, Error> {
    let mut raw = RawPattern::new();
    let mut previous = -1i32;
    for b in bytes.as_chunks::<2>().0 {
        let mut x = (b[0] & 0x1F) as i32 * 2;
        let mut y = -((b[1] & 0x1F) as i32) * 2;
        if b[0] & 0x80 != 0 {
            x = -x;
        }
        if b[1] & 0x80 != 0 {
            y = -y;
        }
        let ctrl = (((b[0] & 0x60) >> 3) | ((b[1] & 0x60) >> 5)) as i32;
        match ctrl {
            0b1100 => raw.jump(x, y),
            0b1000 => {
                if previous == 0b0111 {
                    raw.color_change();
                }
            }
            // pystitch adds an END and reads on; Ink/Stitch's import ignores the END.
            0b0000 => {}
            _ => raw.stitch(x, y),
        }
        previous = ctrl;
    }
    Ok(raw.finish())
}

/// Pfaff MAX: absolute 24-bit coordinates in units of 0.1235 mm (y as stored).
pub(crate) fn read_max(bytes: &[u8]) -> Result<Pattern, Error> {
    let mut r = Reader::new(bytes);
    r.seek(0xD5)?;
    let count = r.u32le()?;
    let mut raw = RawPattern::new();
    let signed24 = |v: u32| ((v << 8) as i32) >> 8;
    for _ in 0..count {
        let Ok(x) = r.u24le() else { break };
        let Ok(_c0) = r.u8() else { break };
        let Ok(y) = r.u24le() else { break };
        let Ok(_c1) = r.u8() else { break };
        raw.stitch_abs(signed24(x), signed24(y));
    }
    Ok(raw.finish_scaled(10.0 / 1.235))
}

/// Pfaff SPX.
pub(crate) fn read_spx(bytes: &[u8]) -> Result<Pattern, Error> {
    let mut r = Reader::new(bytes);
    r.seek(0x11E)?;
    let mut raw = RawPattern::new();
    loop {
        if r.skip(2).is_err() {
            break;
        }
        let (Ok(dy), Ok(dx), Ok(c)) = (r.u16be(), r.u16be(), r.u8()) else { break };
        let dy = -(dy as u16 as i16 as i32) - s8(c);
        if r.skip(2).is_err() {
            break;
        }
        raw.stitch(dx as u16 as i16 as i32, dy);
    }
    Ok(raw.finish())
}

/// Zeng Hsing ZHS.
pub(crate) fn read_zhs(bytes: &[u8]) -> Result<Pattern, Error> {
    let mut r = Reader::new(bytes);
    r.seek(0x0F)?;
    let stitches_at = r.u32le()? as usize;
    let header_at = r.u32le()? as usize;
    r.seek(header_at)?;
    let mut raw = RawPattern::new();
    let colors = r.u8()?;
    for _ in 0..colors {
        let c = r.u24be()?;
        raw.threads.push(Thread::from_rgb([(c >> 16) as u8, (c >> 8) as u8, c as u8]));
    }
    if let Ok(len) = r.u16le() {
        if let Ok(text) = r.bytes(len as usize) {
            let text = String::from_utf8_lossy(text);
            for (t, data) in raw.threads.iter_mut().zip(text.split("&$").skip(1)) {
                let parts: Vec<&str> = data.split("&#").collect();
                if let Some(chart) = parts.first().filter(|s| !s.is_empty()) {
                    t.brand = chart.to_string();
                }
                if let Some(desc) = parts.get(1).filter(|s| !s.is_empty()) {
                    t.name = desc.to_string();
                }
                if let Some(code) = parts.get(2).filter(|s| s.chars().count() > 3) {
                    t.code = code.chars().take(code.chars().count() - 2).collect();
                }
            }
        }
    }
    // Bits of x and y are interleaved over the two data bytes.
    let decode = |lo: u8, hi: u8| {
        let v = (lo & 0b0101_0101) | (hi & 0b1010_1010);
        let mut v = s8(v);
        if v >= 63 {
            v += 1;
        }
        if v <= -63 {
            v -= 1;
        }
        v
    };
    let (mut xx, mut yy) = (0, 0);
    for b in tail(bytes, stitches_at).as_chunks::<3>().0 {
        let ctrl = b[0];
        if ctrl == 0x10 {
            continue; // checksum
        }
        xx += decode(b[1], b[2]);
        yy += decode(b[2], b[1]);
        match ctrl {
            0x02 => raw.stitch(xx, -yy),
            0x01 => raw.jump(xx, -yy),
            0x04 => raw.color_change(),
            0x80 => break,
            _ => continue, // 0x41 and others: keep accumulating
        }
        (xx, yy) = (0, 0);
    }
    Ok(raw.finish())
}

/// Brother PHB: PEC stitches behind a chain of section offsets.
pub(crate) fn read_phb(bytes: &[u8]) -> Result<Pattern, Error> {
    let mut r = Reader::new(bytes);
    r.seek(0x71)?;
    let colors = r.u16le()?;
    let mut raw = RawPattern::new();
    for _ in 0..colors {
        raw.threads.push(pec_thread(r.u8()? as usize));
    }
    let mut offset: usize = 0x52;
    r.seek(0x54)?;
    offset = offset.checked_add(r.u32le()? as usize).ok_or_else(bad_offset)?;
    r.seek(offset)?;
    offset = offset.checked_add(r.u32le()? as usize + 2).ok_or_else(bad_offset)?;
    r.seek(offset)?;
    offset = offset.checked_add(r.u32le()? as usize).ok_or_else(bad_offset)?;
    r.seek(offset.checked_add(14).ok_or_else(bad_offset)?)?;
    let colors2 = r.u8()? as usize;
    r.skip(colors2 + 0x15)?;
    pec::read_stitches(tail(bytes, r.pos), &mut raw);
    raw.duplicate_colors_as_stops();
    Ok(raw.finish())
}

/// Brother PHC.
pub(crate) fn read_phc(bytes: &[u8]) -> Result<Pattern, Error> {
    let mut r = Reader::new(bytes);
    r.seek(0x4A)?;
    let _icon_height = r.u8()?;
    r.skip(1)?;
    let _stride = r.u8()?;
    let colors = r.u16le()?;
    let mut raw = RawPattern::new();
    for _ in 0..colors {
        let Ok(c) = r.u8() else {
            // the file ends before its colour list does
            return Ok(raw.finish());
        };
        raw.threads.push(pec_thread(c as usize));
    }
    r.seek(0x2B)?;
    let pec_add = r.u8()? as usize;
    r.skip(4)?;
    let pec_offset = r.u16le()? as usize;
    r.seek(pec_offset + pec_add)?;
    let section = r.u16le()? as usize;
    r.skip(section)?;
    let section2 = r.u32le()? as usize;
    r.skip(section2.checked_add(10).ok_or_else(bad_offset)?)?;
    let colors2 = r.u8()? as usize;
    r.skip(colors2 + 0x1D)?;
    pec::read_stitches(tail(bytes, r.pos), &mut raw);
    raw.duplicate_colors_as_stops();
    Ok(raw.finish())
}

fn bad_offset() -> Error {
    Error::Malformed("section offset out of range".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cmd;

    fn flags(p: &Pattern) -> Vec<u8> {
        p.stitches.iter().map(|s| s.flags).collect()
    }

    fn xy(p: &Pattern, i: usize) -> (f64, f64) {
        let s = p.stitches[i];
        ((s.x * 10.0).round() / 10.0, (s.y * 10.0).round() / 10.0)
    }

    #[test]
    fn tap_is_headerless_dst() {
        use crate::dst::{encode_record, Kind};
        let mut b = Vec::new();
        b.extend_from_slice(&encode_record(10, 0, Kind::Stitch));
        b.extend_from_slice(&encode_record(0, 10, Kind::Stitch));
        b.extend_from_slice(&encode_record(0, 0, Kind::End));
        let p = read_tap(&b).unwrap();
        assert_eq!(flags(&p), vec![0, 0, cmd::END]);
        assert_eq!(xy(&p, 1), (1.0, 1.0));
        let mut e = vec![0u8; 0x100];
        e.extend_from_slice(&b);
        assert_eq!(read_exy(&e).unwrap().stitches, p.stitches);
    }

    #[test]
    fn z_encoding() {
        // (y magnitude, x magnitude, ctrl); 0x40 negates x, 0x20 negates y (y up)
        let recs = [[10, 20, 0x00], [5, 5, 0x60], [0, 0, 0x9B], [30, 0, 0x01], [0, 0, 0x85], [1, 1, 0x00], [0, 0, 0xFF]];
        let mut b = vec![0u8; 0x200];
        b.extend(recs.iter().flatten());
        let p = read_gt(&b).unwrap();
        assert_eq!(flags(&p), vec![0, 0, cmd::TRIM, cmd::JUMP, cmd::COLOR_CHANGE, 0, cmd::END]);
        assert_eq!(xy(&p, 0), (2.0, -1.0));
        assert_eq!(xy(&p, 1), (1.5, -0.5));
        assert_eq!(xy(&p, 3), (1.5, -3.5));
        let mut d = vec![b' '; 512];
        d[..13].copy_from_slice(b"LA:Name     \r");
        d.extend(recs.iter().flatten());
        let p2 = read_dsz(&d).unwrap();
        assert_eq!(p2.name, "Name");
        assert_eq!(p2.stitches, p.stitches);
    }

    #[test]
    fn dsb_records() {
        let mut b = vec![b' '; 512];
        // (ctrl, y, x); 0x40 negates y, 0x20 negates x
        b.extend([0x80, 10, 20, 0xA0, 0, 5, 0xE7, 0, 0, 0x81, 0, 30, 0xE9, 0, 0, 0x80, 1, 1, 0xF8, 0, 0]);
        let p = read_dsb(&b).unwrap();
        assert_eq!(flags(&p), vec![0, 0, cmd::TRIM, cmd::JUMP, cmd::COLOR_CHANGE, 0, cmd::END]);
        assert_eq!(xy(&p, 0), (2.0, -1.0));
        assert_eq!(xy(&p, 1), (1.5, -1.0));
    }

    #[test]
    fn stx_and_emd() {
        let mut b = vec![0u8; 0x0C];
        b.extend_from_slice(&0u32.to_le_bytes());
        b.extend_from_slice(&0u32.to_le_bytes());
        b.extend_from_slice(&0x20u32.to_le_bytes());
        b.resize(0x20, 0);
        b.extend([10, 10, 0x80, 0x01, 0, 0, 5, 0]);
        let p = read_stx(&b).unwrap();
        assert_eq!(flags(&p), vec![0, cmd::COLOR_CHANGE, 0, cmd::END]);
        assert_eq!(xy(&p, 0), (1.0, -1.0));

        let mut e = vec![0u8; 0x30];
        e.extend([0x80, 0x7D, 10, 10, 0x80, 0xAD, 0x80, 0x80, 20, 0, 0x80, 0x2A, 1, 1, 0x80, 0xFD]);
        let p = read_emd(&e).unwrap();
        assert_eq!(flags(&p), vec![0, cmd::TRIM, cmd::JUMP, cmd::COLOR_CHANGE, 0, cmd::END]);
        assert_eq!(xy(&p, 4), (3.1, -1.1));
    }

    #[test]
    fn zxy_needles() {
        let mut b = vec![0u8, 0, 2, 0xAA, 0xBB];
        // (ctrl, x, y); 0x08 negates x, 0x04 negates y (y up)
        b.extend([0x00, 10, 10, 0x0C, 5, 5, 0x20, 1, 0, 0x02, 20, 0, 0x20, 2, 0, 0x00, 1, 1, 0x20, 0xFF, 0]);
        let p = read_zxy(&b).unwrap();
        assert_eq!(flags(&p), vec![0, 0, cmd::COLOR_CHANGE, cmd::JUMP, cmd::COLOR_CHANGE, 0, cmd::END]);
        assert_eq!(xy(&p, 1), (0.5, -0.5));
    }

    #[test]
    fn toyota_10o_and_100() {
        let b = [0x8A, 0, 0, 0x00, 10, 20, 0x60, 5, 5, 0x81, 0, 0, 0x10, 0, 30, 0x85, 0, 0, 0x00, 1, 1, 0x87, 0, 0];
        let p = read_10o(&b).unwrap();
        assert_eq!(flags(&p), vec![0, 0, cmd::TRIM, cmd::JUMP, cmd::COLOR_CHANGE, 0, cmd::END]);
        assert_eq!(xy(&p, 0), (2.0, -1.0));
        assert_eq!(xy(&p, 1), (1.5, -0.5));
        let b = [0x61, 0, 10, 0x85, 0x01, 0, 0x83, 0, 0x00, 0, 0, 0];
        let p = read_100(&b).unwrap();
        assert_eq!(flags(&p), vec![0, cmd::JUMP, cmd::COLOR_CHANGE, cmd::END]);
        assert_eq!(xy(&p, 0), (1.0, 0.5));
        assert_eq!(xy(&p, 1), (0.7, 0.5));
    }

    #[test]
    fn inb_ksm_new_stc() {
        let mut b = vec![0u8; 0x2000];
        b.extend([10, 10, 0x00, 5, 5, 0x60, 0, 0, 0x01, 20, 0, 0x02, 1, 1, 0x00, 0, 0, 0x04]);
        let p = read_inb(&b).unwrap();
        assert_eq!(flags(&p), vec![0, 0, cmd::COLOR_CHANGE, cmd::JUMP, 0, cmd::END]);
        assert_eq!(xy(&p, 1), (0.5, -0.5));

        let mut k = vec![0u8; 0x200];
        // (y, x, ctrl): stitch, stitch + trim, jump (trimmed), sew again, needle, stitch, end
        k.extend([10, 10, 0x00, 5, 5, 0x07, 0, 20, 0x00, 0, 0, 0x17, 0, 0, 0x0B, 1, 1, 0x00, 0, 0, 0x08]);
        let p = read_ksm(&k).unwrap();
        assert_eq!(flags(&p), vec![0, 0, cmd::TRIM, cmd::JUMP, cmd::COLOR_CHANGE, cmd::JUMP, cmd::END]);

        let n = [0, 0, 10, 10, 0x00, 5, 5, 0x60, 0, 0, 0x02, 20, 0, 0x01, 1, 1, 0x00, 0, 0, 0x11];
        let p = read_new(&n).unwrap();
        assert_eq!(flags(&p), vec![0, 0, cmd::COLOR_CHANGE, cmd::JUMP, 0, cmd::END]);
        assert_eq!(xy(&p, 1), (0.5, -0.5));

        let mut s = vec![0u8; 0x28];
        s.extend([10, 10, 0x01, 0xF6, 0, 0x00, 0, 0, 0x03, 1, 1, 0x01, 0, 0, 25]);
        let p = read_stc(&s).unwrap();
        assert_eq!(flags(&p), vec![0, cmd::JUMP, cmd::COLOR_CHANGE, 0, cmd::END]);
        assert_eq!(xy(&p, 1), (0.0, -1.0));
    }

    #[test]
    fn dat_variants() {
        // Barudan: every command byte has the high bit
        let b = [0x80, 10, 20, 0xE0, 5, 5, 0xE9, 0, 0, 0x80, 1, 1, 0x98, 0, 0];
        let p = read_dat(&b).unwrap();
        assert_eq!(flags(&p), vec![0, 0, cmd::COLOR_CHANGE, 0, cmd::END]);
        assert_eq!(xy(&p, 0), (2.0, -1.0));
        assert_eq!(xy(&p, 1), (1.5, -0.5));
        // Sunstar
        let mut s = vec![0u8; 0x100];
        s.extend([10, 10, 0x07, 0x85, 0x85, 0x07, 0, 0, 0x80, 20, 0, 0x04, 0, 0, 0x87, 1, 1, 0x07, 0, 0, 0]);
        let p = read_dat(&s).unwrap();
        assert_eq!(flags(&p), vec![0, 0, cmd::TRIM, cmd::JUMP, cmd::COLOR_CHANGE, 0, cmd::END]);
        assert_eq!(xy(&p, 1), (0.5, -0.5));
    }

    #[test]
    fn bro_mit_max_spx() {
        let mut b = vec![0u8; 0x100];
        b.extend([10, 10, 0x80, 0, 0x7E, 20, 0, 0, 0, 0x80, 0, 0xE1, 0, 0, 0, 0, 1, 1, 0x80, 0, 0x02]);
        let p = read_bro(&b).unwrap();
        assert_eq!(flags(&p), vec![0, cmd::JUMP, cmd::COLOR_CHANGE, cmd::JUMP, 0, cmd::END]);
        assert_eq!(xy(&p, 1), (3.0, -1.0));

        // MIT: ctrl from bits 5-6 of both bytes; 0b0111 stitch, 0b1000 colour change after it
        let m = [0x20 | 5, 0x60 | 5, 0x40, 0x00, 0x20 | 1, 0x60 | 1];
        let p = read_mit(&m).unwrap();
        assert_eq!(flags(&p), vec![0, cmd::COLOR_CHANGE, 0, cmd::END]);
        assert_eq!(xy(&p, 0), (1.0, -1.0));

        let mut x = vec![0u8; 0xD5];
        x.extend_from_slice(&1u32.to_le_bytes());
        x.extend([100, 0, 0, 0, 200, 0, 0, 0]);
        let p = read_max(&x).unwrap();
        assert!((p.stitches[0].x - 12.35).abs() < 1e-9 && (p.stitches[0].y - 24.7).abs() < 1e-9);

        let mut s = vec![0u8; 0x11E];
        s.extend([0, 0, 0, 10, 0, 20, 2, 0, 0]);
        let p = read_spx(&s).unwrap();
        assert_eq!(xy(&p, 0), (2.0, -1.2));
    }

    #[test]
    fn zhs_threads_and_interleaved_bits() {
        let mut b = vec![0u8; 0x0F];
        let header_at = 0x20u32;
        b.extend_from_slice(&0x60u32.to_le_bytes());
        b.extend_from_slice(&header_at.to_le_bytes());
        b.resize(header_at as usize, 0);
        b.push(1);
        b.extend([0x12, 0x34, 0x56]);
        let text = b"&$Madeira&#Red&#1147  ";
        b.extend_from_slice(&(text.len() as u16).to_le_bytes());
        b.extend_from_slice(text);
        b.resize(0x60, 0);
        // x = 3: bits 0,1 -> lo bit 0 (b1), bit 1 (b2); y = 0
        b.extend([0x02, 0x01, 0x02, 0x10, 0xFF, 0xFF, 0x02, 0x00, 0x00, 0x80, 0, 0]);
        let p = read_zhs(&b).unwrap();
        assert_eq!(p.threads[0].rgb, [0x12, 0x34, 0x56]);
        assert_eq!(p.threads[0].name, "Red");
        assert_eq!(p.threads[0].brand, "Madeira");
        assert_eq!(p.threads[0].code, "1147");
        assert_eq!(flags(&p), vec![0, 0, cmd::END]);
        assert_eq!(xy(&p, 0), (0.3, 0.0));
    }

    #[test]
    fn readers_survive_truncation() {
        type ReadFn = fn(&[u8]) -> Result<Pattern, Error>;
        let readers: [ReadFn; 24] = [
            read_tap, read_exy, read_fxy, read_gt, read_dsb, read_dsz, read_stx, read_emd, read_jpx, read_zxy, read_10o, read_100, read_inb, read_ksm,
            read_new, read_stc, read_dat, read_bro, read_mit, read_max, read_spx, read_zhs, read_phb, read_phc,
        ];
        let junk: Vec<u8> = (0..0x2400u32).map(|i| (i.wrapping_mul(2654435761) >> 13) as u8).collect();
        for f in readers {
            for n in [0, 1, 2, 3, 7, 0x40, 0x120, 0x210, 0x2010, junk.len()] {
                let _ = f(&junk[..n]);
            }
        }
    }
}
