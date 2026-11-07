//! Pfaff/Viking VP3 reader/writer.
//!
//! Ported from pystitch, Ink/Stitch's embroidery file library (MIT, Copyright (c) 2018 Tatarize
//! and the Ink/Stitch contributors)
//! (`Vp3Writer.py`, `Vp3Reader.py`).
//!
//! VP3 stores one block per colour with embedded RGB threads. Stitch deltas are signed
//! bytes in 0.1 mm (y down); larger moves use a 16-bit long form. There is no jump
//! command: jumps are folded into the next (long-form) stitch.
//!
//! As in pystitch, the design centre is `max - size / 2` (a half unit for odd sizes,
//! truncated when written) and long-form records are read as stitches.

use crate::encoder::{check_count, check_extent, check_size, encode, mm, too_big, Cmd, EncodeSettings, Rec};
use crate::io::{ByteWriter, Reader};
use crate::raw::RawPattern;
use crate::{Error, Pattern, Thread, WriteOptions};

pub(crate) const SETTINGS: EncodeSettings = EncodeSettings {
    max_stitch: 255,
    max_jump: 3200,
    full_jump: false,
};
const PRODUCER: &str = "Produced by     Software Ltd";

fn string16(out: &mut Vec<u8>, s: &str) {
    let units: Vec<u16> = s.encode_utf16().collect();
    out.u16be((units.len() * 2) as u32);
    for u in units {
        out.u16be(u as u32);
    }
}

fn string8(out: &mut Vec<u8>, s: &str) {
    let b = &s.as_bytes()[..s.len().min(0xFFFF)];
    out.u16be(b.len() as u32);
    out.extend_from_slice(b);
}

/// Patches a big-endian distance-to-end at `pos` (pystitch `vp3_patch_byte_offset`).
fn patch_offset(out: &mut Vec<u8>, pos: usize) {
    let d = out.len() - pos - 4;
    out.patch_u32be(pos, d as u32);
}

/// Header positions and sizes are i32 in 1/1000 mm (format units * 100).
const MAX_HEADER_UNITS: i32 = i32::MAX / 100;

pub(crate) fn write(p: &Pattern, opts: &WriteOptions) -> Result<Vec<u8>, Error> {
    let e = encode(p, SETTINGS, opts.long_stitch_as_jumps);
    let blocks = e.colorblocks_starting_with_change();
    check_count("VP3", blocks.len(), 0xFFFF, "colour blocks")?;
    let (min_x, min_y, max_x, max_y) = e.bounds();
    // Every header value (centre, block offsets, half sizes) lies within these.
    check_extent("VP3", &[min_x, min_y, max_x, max_y], -MAX_HEADER_UNITS, MAX_HEADER_UNITS)?;
    check_size("VP3", max_x - min_x, max_y - min_y, MAX_HEADER_UNITS, MAX_HEADER_UNITS)?;
    let mut out = Vec::new();
    out.str("%vsm%");
    out.u8(0);
    string16(&mut out, PRODUCER);

    out.extend_from_slice(&[0x00, 0x02, 0x00]);
    let file_end_pos = out.len();
    out.u32le(0);
    string16(&mut out, "");

    out.i32be(max_x * 100);
    out.i32be(-min_y * 100);
    out.i32be(min_x * 100);
    out.i32be(-max_y * 100);
    let count_just_stitches = e.recs.len() - e.count(Cmd::End);
    out.i32be(count_just_stitches as i32);
    out.u8(0);
    out.u8(blocks.len().min(255) as u8);
    out.u8(12);
    out.u8(0);
    out.u8(1); // number of designs

    // Design block.
    out.extend_from_slice(&[0x00, 0x03, 0x00]);
    let design_end_pos = out.len();
    out.u32le(0);
    let width = max_x - min_x;
    let height = max_y - min_y;
    let _ = (min_x, min_y);
    let center_x = max_x as f64 - width as f64 / 2.0;
    let center_y = max_y as f64 - height as f64 / 2.0;
    let half_w = width / 2;
    let half_h = height / 2;
    out.i32be(center_x.trunc() as i32 * 100);
    out.i32be(-(center_y.trunc() as i32) * 100);
    out.fill(0, 3);
    out.i32be(-half_w * 100);
    out.i32be(half_w * 100);
    out.i32be(-half_h * 100);
    out.i32be(half_h * 100);
    out.i32be(width * 100);
    out.i32be(height * 100);
    string16(&mut out, "");
    out.extend_from_slice(&[0x64, 0x64]);
    out.i32be(4096);
    out.i32be(0);
    out.i32be(0);
    out.i32be(4096);
    out.extend_from_slice(b"xxPP\x01\x00");
    string16(&mut out, PRODUCER);
    out.u16be(blocks.len() as u32);
    for (i, b) in blocks.iter().enumerate() {
        write_colorblock(&mut out, i == 0, center_x, center_y, b, &e.thread(i))?;
    }
    patch_offset(&mut out, design_end_pos);
    patch_offset(&mut out, file_end_pos);
    Ok(out)
}

fn write_colorblock(
    out: &mut Vec<u8>,
    first: bool,
    cx: f64,
    cy: f64,
    recs: &[Rec],
    thread: &Thread,
) -> Result<(), Error> {
    out.extend_from_slice(&[0x00, 0x05, 0x00]);
    let end_pos = out.len();
    out.u32le(0);
    let (fx, fy, lx, ly) = match (recs.first(), recs.last()) {
        (Some(f), Some(l)) if !first => (f.x, f.y, l.x, l.y),
        (Some(_), Some(l)) => (0, 0, l.x, l.y),
        _ => (0, 0, 0, 0),
    };
    out.i32be((fx as f64 - cx).trunc() as i32 * 100);
    out.i32be((-(fy as f64 - cy)).trunc() as i32 * 100);
    write_thread(out, thread);
    out.i32be((lx - fx) * 100);
    out.i32be(-(ly - fy) * 100);
    write_stitches(out, recs, fx, fy)?;
    out.u8(0);
    patch_offset(out, end_pos);
    Ok(())
}

fn write_thread(out: &mut Vec<u8>, t: &Thread) {
    out.extend_from_slice(&[0x01, 0x00]); // single colour, no transition
    out.extend_from_slice(&t.rgb);
    out.extend_from_slice(&[0x00, 0x00, 0x00, 0x05, 0x28]); // no parts, no length, rayon 40wt
    string8(out, &t.code);
    if t.name.is_empty() {
        string8(out, &t.hex());
    } else {
        string8(out, &t.name);
    }
    string8(out, &t.brand);
}

fn write_stitches(out: &mut Vec<u8>, recs: &[Rec], fx: i32, fy: i32) -> Result<(), Error> {
    out.extend_from_slice(&[0x00, 0x01, 0x00]);
    let end_pos = out.len();
    out.u32le(0);
    out.extend_from_slice(&[0x0A, 0xF6, 0x00]);
    let (mut lx, mut ly) = (fx, fy);
    for r in recs {
        match r.cmd {
            Cmd::End => {
                out.extend_from_slice(&[0x80, 0x03]);
                break;
            }
            Cmd::Trim => out.extend_from_slice(&[0x80, 0x03]),
            Cmd::ColorChange | Cmd::Stop | Cmd::Jump => {}
            Cmd::Stitch => {
                let dx = r.x - lx;
                let dy = r.y - ly;
                lx = r.x;
                ly = r.y;
                if (-127..=127).contains(&dx) && (-127..=127).contains(&dy) {
                    out.i8(dx);
                    out.i8(dy);
                } else {
                    // The long form is 16-bit; VP3 has no jumps, so a jump chain
                    // ends up in one such move.
                    if !(-32768..=32767).contains(&dx) || !(-32768..=32767).contains(&dy) {
                        let worst = dx.unsigned_abs().max(dy.unsigned_abs());
                        return Err(too_big(format!("VP3: a move of {} mm exceeds the format's 3276.7 mm limit", mm(worst as i64))));
                    }
                    out.extend_from_slice(&[0x80, 0x01]);
                    out.u16be((dx & 0xFFFF) as u32);
                    out.u16be((dy & 0xFFFF) as u32);
                    out.extend_from_slice(&[0x80, 0x02]);
                }
            }
        }
    }
    patch_offset(out, end_pos);
    Ok(())
}

// ---------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------

/// 1/1000 mm -> 0.1 mm.
fn thousandths_to_units(v: i32) -> i32 {
    (v as f64 / 100.0).round() as i32
}

fn skip_string(r: &mut Reader) -> Result<(), Error> {
    let n = r.u16be()? as usize;
    r.skip(n)
}

fn read_string8(r: &mut Reader) -> Result<String, Error> {
    let n = r.u16be()? as usize;
    r.string(n)
}

fn read_thread(r: &mut Reader) -> Result<Thread, Error> {
    let mut t = Thread::default();
    let colors = r.u8()?;
    let _transition = r.u8()?;
    for _ in 0..colors {
        let c = r.u24be()?;
        t.rgb = [(c >> 16) as u8, (c >> 8) as u8, c as u8];
        let _parts = r.u8()?;
        let _len = r.u16be()?;
    }
    let _thread_type = r.u8()?;
    let _weight = r.u8()?;
    t.code = read_string8(r)?;
    t.name = read_string8(r)?;
    t.brand = read_string8(r)?;
    Ok(t)
}

pub(crate) fn read(bytes: &[u8]) -> Result<Pattern, Error> {
    if !bytes.starts_with(b"%vsm%") {
        return Err(Error::Malformed("missing %vsm% signature".into()));
    }
    let mut r = Reader::new(bytes);
    r.skip(6)?;
    skip_string(&mut r)?;
    r.skip(7)?;
    skip_string(&mut r)?;
    r.skip(32)?;
    // Positions in VP3 headers are 1/1000 mm; stitch data is 0.1 mm.
    let center_x = thousandths_to_units(r.i32be()?);
    let center_y = -thousandths_to_units(r.i32be()?);
    r.skip(27)?;
    skip_string(&mut r)?;
    r.skip(24)?;
    skip_string(&mut r)?;
    let count_colors = r.u16be()?;
    let mut raw = RawPattern::new();
    for i in 0..count_colors {
        read_colorblock(&mut r, &mut raw, center_x, center_y)?;
        if i + 1 < count_colors {
            raw.color_change();
        }
    }
    Ok(raw.finish())
}

fn read_colorblock(r: &mut Reader, raw: &mut RawPattern, cx: i32, cy: i32) -> Result<(), Error> {
    r.skip(3)?; // 00 05 00
    let dist = r.i32be()? as u32;
    let block_end = r.pos.saturating_add(dist as usize).min(r.data.len());
    let sx = thousandths_to_units(r.i32be()?);
    let sy = -thousandths_to_units(r.i32be()?);
    let (ax, ay) = (sx + cx, sy + cy);
    if ax != raw.x || ay != raw.y {
        raw.jump_abs(ax, ay);
    }
    let thread = read_thread(r)?;
    raw.threads.push(thread);
    r.skip(15)?;
    r.skip(3)?; // 0A F6 00
    let data: Vec<i32> = r
        .data
        .get(r.pos..block_end.max(r.pos))
        .unwrap_or(&[])
        .iter()
        .map(|&b| b as i8 as i32)
        .collect();
    r.seek(block_end.max(r.pos))?;
    let mut i = 0usize;
    while i + 1 < data.len() {
        let x = data[i];
        let y = data[i + 1];
        i += 2;
        if (x & 0xFF) != 0x80 {
            raw.stitch(x, y);
            continue;
        }
        match y {
            0x01 => {
                if i + 4 > data.len() {
                    break;
                }
                let s16 = |a: i32, b: i32| (((a & 0xFF) << 8) | (b & 0xFF)) as u16 as i16 as i32;
                let dx = s16(data[i], data[i + 1]);
                let dy = s16(data[i + 2], data[i + 3]);
                i += 6; // includes the trailing 80 02
                raw.stitch(dx, dy);
            }
            0x03 => raw.trim(),
            _ => {}
        }
    }
    Ok(())
}
