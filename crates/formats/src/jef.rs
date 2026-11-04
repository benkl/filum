//! Janome JEF reader/writer.
//!
//! Ported from pystitch, Ink/Stitch's embroidery file library (MIT, Copyright (c) 2018 Tatarize
//! and the Ink/Stitch contributors)
//! (`JefWriter.py`, `JefReader.py`).
//!
//! JEF stores signed 8-bit deltas in 0.1 mm, y up, with `0x80` control codes, and colours
//! as indices into the Janome thread table. Trims are not written (jumps imply trims);
//! on read, jump runs longer than 3 mm after stitching become trims.

use crate::encoder::{encode, Cmd, EncodeSettings};
use crate::io::{ByteWriter, Reader};
use crate::palette::{build_nonrepeat_palette, jef_slots, jef_thread};
use crate::raw::RawPattern;
use crate::{Error, Pattern, WriteOptions};

pub(crate) const SETTINGS: EncodeSettings = EncodeSettings {
    max_stitch: 127,
    max_jump: 127,
    full_jump: true,
};

const HOOP_110X110: u32 = 0;
const HOOP_50X50: u32 = 1;
const HOOP_140X200: u32 = 2;
const HOOP_126X110: u32 = 3;
const HOOP_200X200: u32 = 4;

/// Hoop code from design size in 0.1 mm (pystitch `get_jef_hoop_size`).
pub(crate) fn hoop_size(width: i32, height: i32) -> u32 {
    if width < 500 && height < 500 {
        return HOOP_50X50;
    }
    if width < 1260 && height < 1100 {
        return HOOP_126X110;
    }
    if width < 1400 && height < 2000 {
        return HOOP_140X200;
    }
    if width < 2000 && height < 2000 {
        return HOOP_200X200;
    }
    HOOP_110X110
}

fn write_hoop_edge_distance(out: &mut Vec<u8>, x: i32, y: i32) {
    if x.min(y) >= 0 {
        for v in [x, y, x, y] {
            out.i32le(v);
        }
    } else {
        for _ in 0..4 {
            out.i32le(-1);
        }
    }
}

/// `YYYYMMDDHHMMSS` for the current UTC time (fixed on wasm32, where there is no clock).
fn now_string() -> String {
    #[cfg(not(target_arch = "wasm32"))]
    {
        if let Ok(d) = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH) {
            let secs = d.as_secs() as i64;
            let days = secs.div_euclid(86400);
            let rem = secs.rem_euclid(86400);
            // Civil-from-days (Howard Hinnant).
            let z = days + 719_468;
            let era = z.div_euclid(146_097);
            let doe = z - era * 146_097;
            let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
            let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
            let mp = (5 * doy + 2) / 153;
            let day = doy - (153 * mp + 2) / 5 + 1;
            let month = if mp < 10 { mp + 3 } else { mp - 9 };
            let year = yoe + era * 400 + if month <= 2 { 1 } else { 0 };
            return format!(
                "{:04}{:02}{:02}{:02}{:02}{:02}",
                year,
                month,
                day,
                rem / 3600,
                (rem / 60) % 60,
                rem % 60
            );
        }
    }
    "20000101000000".into()
}

pub(crate) fn write(p: &Pattern, opts: &WriteOptions) -> Vec<u8> {
    let e = encode(p, SETTINGS, opts.long_stitch_as_jumps);

    // Palette: one entry per colour block (non-repeating nearest Janome colour);
    // stops alternate between the placeholder 0 and the current colour.
    let block_colors: Vec<[u8; 3]> = e.threads.iter().map(|t| t.rgb).collect();
    let block_indices = build_nonrepeat_palette(&jef_slots(), &block_colors);
    let mut palette: Vec<i32> = Vec::new();
    let mut block = 0usize;
    let mut last_index = 0i32;
    let mut toggled = false;
    for (i, r) in e.recs.iter().enumerate() {
        if (r.cmd == Cmd::ColorChange || i == 0) && block < block_indices.len() {
            last_index = block_indices[block] as i32;
            palette.push(last_index);
            block += 1;
            toggled = false;
        }
        if r.cmd == Cmd::Stop {
            toggled = !toggled;
            palette.push(if toggled { 0 } else { last_index });
        }
    }
    let color_count = palette.len() as u32;

    let mut out = Vec::new();
    out.u32le(0x74 + color_count * 8);
    out.u32le(0x14);
    let date = opts.date.clone().unwrap_or_else(now_string);
    let mut date_bytes: Vec<u8> = date.bytes().take(14).collect();
    date_bytes.resize(14, b'0');
    out.extend_from_slice(&date_bytes);
    out.u8(0);
    out.u8(0);
    out.u32le(color_count);
    let mut point_count = 1u32; // END
    for r in &e.recs {
        match r.cmd {
            Cmd::Stitch => point_count += 1,
            Cmd::Jump | Cmd::ColorChange | Cmd::Stop => point_count += 2,
            Cmd::Trim => {}
            Cmd::End => break,
        }
    }
    out.u32le(point_count);
    let (min_x, min_y, max_x, max_y) = e.bounds();
    let width = max_x - min_x;
    let height = max_y - min_y;
    out.u32le(hoop_size(width, height));
    let half_w = (width as f64 / 2.0).round_ties_even() as i32;
    let half_h = (height as f64 / 2.0).round_ties_even() as i32;
    for v in [half_w, half_h, half_w, half_h] {
        out.i32le(v);
    }
    write_hoop_edge_distance(&mut out, 550 - half_w, 550 - half_h);
    write_hoop_edge_distance(&mut out, 250 - half_w, 250 - half_h);
    write_hoop_edge_distance(&mut out, 700 - half_w, 1000 - half_h);
    write_hoop_edge_distance(&mut out, 700 - half_w, 1000 - half_h);
    for &t in &palette {
        out.i32le(t);
    }
    for _ in 0..color_count {
        out.u32le(0x0D);
    }

    let (mut xx, mut yy) = (0, 0);
    for r in &e.recs {
        let dx = r.x - xx;
        let dy = r.y - yy;
        xx = r.x;
        yy = r.y;
        match r.cmd {
            Cmd::Stitch => {
                out.i8(dx);
                out.i8(-dy);
            }
            Cmd::ColorChange | Cmd::Stop => {
                out.extend_from_slice(&[0x80, 0x01]);
                out.i8(dx);
                out.i8(-dy);
            }
            Cmd::Jump => {
                out.extend_from_slice(&[0x80, 0x02]);
                out.i8(dx);
                out.i8(-dy);
            }
            Cmd::Trim => {}
            Cmd::End => break,
        }
    }
    out.extend_from_slice(&[0x80, 0x10]);
    out
}

pub(crate) fn read(bytes: &[u8]) -> Result<Pattern, Error> {
    let mut r = Reader::new(bytes);
    let stitch_offset = r.u32le()? as usize;
    r.skip(20)?;
    let count_colors = r.u32le()? as usize;
    r.skip(88)?;
    // Placeholder index 0 marks a stop.
    let mut threads = Vec::new();
    for _ in 0..count_colors.min(r.remaining() / 4) {
        let index = r.i32le()?.unsigned_abs() as usize;
        threads.push(jef_thread(index));
    }
    let mut raw = RawPattern::new();
    let mut out_threads = Vec::new();
    let mut thread_iter = threads.into_iter();
    if let Some(t) = thread_iter.next() {
        out_threads.extend(t);
    }
    let data = bytes
        .get(stitch_offset..)
        .ok_or_else(|| Error::Malformed("JEF stitch offset out of range".into()))?;
    let mut i = 0;
    while i + 2 <= data.len() {
        let (b0, b1) = (data[i], data[i + 1]);
        i += 2;
        if b0 != 0x80 {
            raw.stitch(b0 as i8 as i32, -(b1 as i8 as i32));
            continue;
        }
        let ctrl = b1;
        if ctrl == 0x10 {
            break;
        }
        if i + 2 > data.len() {
            break;
        }
        let x = data[i] as i8 as i32;
        let y = -(data[i + 1] as i8 as i32);
        i += 2;
        match ctrl {
            // a single zero-length jump is a trim in JEF files found in the
            // wild (pystitch; some Janome machines need three jumps to trim)
            0x02 if x == 0 && y == 0 => raw.trim(),
            0x02 => raw.jump(x, y),
            0x01 => match thread_iter.next() {
                Some(None) => raw.stop(),
                Some(Some(t)) => {
                    out_threads.push(t);
                    raw.color_change();
                }
                None => raw.color_change(),
            },
            _ => break,
        }
    }
    raw.threads = out_threads;
    raw.interpolate_trims(None, Some(30), true);
    Ok(raw.finish())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hoops() {
        assert_eq!(hoop_size(100, 100), HOOP_50X50);
        assert_eq!(hoop_size(1000, 1000), HOOP_126X110);
        assert_eq!(hoop_size(1300, 1900), HOOP_140X200);
        assert_eq!(hoop_size(1900, 1900), HOOP_200X200);
        assert_eq!(hoop_size(3000, 100), HOOP_110X110);
    }
}
