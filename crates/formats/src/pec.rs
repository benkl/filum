//! Brother PEC reader/writer (standalone `.pec` and the PEC section of `.pes`).
//!
//! Ported from pystitch, Ink/Stitch's embroidery file library (MIT, Copyright (c) 2018 Tatarize
//! and the Ink/Stitch contributors)
//! (`PecWriter.py`, `PecReader.py`, `PecGraphics.py`).
//!
//! PEC stores 7-bit or 12-bit deltas in 0.1 mm, y down, colours as indices into the
//! Brother thread table, and monochrome 48x38 thumbnails.

use crate::encoder::{check_size, encode, mm, too_big, Cmd, EncodeSettings, Encoded, Rec};
use crate::io::{ByteWriter, Reader};
use crate::palette::{pec_slots, pec_thread, build_unique_palette_keyed};
use crate::raw::RawPattern;
use crate::{Error, Pattern, Thread, WriteOptions};

pub(crate) const SETTINGS: EncodeSettings = EncodeSettings {
    max_stitch: 2047,
    max_jump: 2047,
    full_jump: true,
};

const JUMP_CODE: u8 = 0x10;
const TRIM_CODE: u8 = 0x20;
const FLAG_LONG: u8 = 0x80;
pub(crate) const ICON_WIDTH: usize = 48;
pub(crate) const ICON_HEIGHT: usize = 38;
const STRIDE: usize = ICON_WIDTH / 8;

/// Lowers `p` the way the PEC/PES writers expect (stops become duplicate colours).
pub(crate) fn encode_for_pec(p: &Pattern, opts: &WriteOptions) -> Encoded {
    // The encoder already yields one thread per colour block (fix_color_count).
    let mut e = encode(p, SETTINGS, opts.long_stitch_as_jumps);
    e.stops_as_duplicate_colors();
    e
}

/// Palette index per colour block (pystitch `build_unique_palette`, per spool:
/// colour, code and brand, so different spools never share a slot).
pub(crate) fn color_indices(e: &Encoded) -> Vec<usize> {
    let colors: Vec<[u8; 3]> = e.threads.iter().map(|t| t.rgb).collect();
    let keys: Vec<([u8; 3], String, String)> = e.threads.iter().map(|t| (t.rgb, t.code.to_lowercase(), t.brand.to_lowercase())).collect();
    build_unique_palette_keyed(&pec_slots(), &colors, &keys)
}

/// The PEC header colour list: `[count - 1, slot, slot, …]` (at most 255 slots).
pub(crate) fn header_color_list(indices: &[usize]) -> Vec<u8> {
    let indices = &indices[..indices.len().min(255)];
    let mut v = Vec::with_capacity(indices.len() + 1);
    if !indices.is_empty() {
        v.push((indices.len() - 1) as u8);
        v.extend(indices.iter().map(|&i| i as u8));
    }
    v
}

pub(crate) fn write(p: &Pattern, opts: &WriteOptions) -> Result<Vec<u8>, Error> {
    let e = encode_for_pec(p, opts);
    let mut out = Vec::new();
    out.str("#PEC0001");
    write_pec(&e, &color_indices(&e), &mut out, "PEC")?;
    Ok(out)
}

/// The largest stitch block the 24-bit length field holds.
const MAX_BLOCK_LEN: usize = 0xFF_FFFF;

/// Errs if `e` does not fit the PEC section's fixed-width fields (`format` names
/// the file format in the message: PEC, or PES whose PEC section this is).
pub(crate) fn check(e: &Encoded, indices: &[usize], format: &str) -> Result<(), Error> {
    // One byte holds `count - 1`, and 0xFF means "no colours" (pystitch asserts this too).
    if indices.len() > 255 {
        return Err(too_big(format!("{format}: the design has {} colour blocks (each stop counts as one); {format} stores at most 255", indices.len())));
    }
    let (min_x, min_y, max_x, max_y) = e.bounds();
    check_size(format, max_x - min_x, max_y - min_y, 0xFFFF, 0xFFFF)?;
    // The stream opens with a 12-bit jump from the top-left corner to the origin.
    if [min_x, min_y].iter().any(|&v| !(-2048..=2047).contains(&-v)) {
        let worst = min_x.unsigned_abs().max(min_y.unsigned_abs());
        return Err(too_big(format!("{format}: the design's top-left corner is {} mm from its origin; {format} stores at most 204.7 mm", mm(worst as i64))));
    }
    Ok(())
}

/// Writes the PEC section (header, stitch block, graphics).
pub(crate) fn write_pec(e: &Encoded, indices: &[usize], out: &mut Vec<u8>, format: &str) -> Result<(), Error> {
    check(e, indices, format)?;
    write_header(e, indices, out);
    write_block(e, out, format)?;
    write_graphics(e, out);
    Ok(())
}

fn write_header(e: &Encoded, indices: &[usize], out: &mut Vec<u8>) {
    let name: String = {
        let n: String = e
            .name
            .chars()
            // only letters and digits: other characters can upset machines (pystitch)
            .filter(|c| c.is_ascii_alphanumeric())
            .take(8)
            .collect();
        if n.trim().is_empty() {
            "Untitled".into()
        } else {
            n
        }
    };
    out.str(&format!("LA:{:<16}\r", name));
    out.fill(0x20, 12);
    out.extend_from_slice(&[0xFF, 0x00]);
    out.u8(STRIDE as u8);
    out.u8(ICON_HEIGHT as u8);
    // PEC can store at most 255 colour entries.
    let indices = &indices[..indices.len().min(255)];
    let count = indices.len();
    if count != 0 {
        out.fill(0x20, 12);
        out.u8((count - 1) as u8);
        for &i in indices {
            out.u8(i as u8);
        }
    } else {
        out.extend_from_slice(b"\x20\x20\x20\x20\x64\x20\x00\x20\x00\x20\x20\x20\xFF");
    }
    out.fill(0x20, 463 - count);
}

fn write_block(e: &Encoded, out: &mut Vec<u8>, format: &str) -> Result<(), Error> {
    let (min_x, min_y, max_x, max_y) = e.bounds();
    let start = out.len();
    out.extend_from_slice(&[0x00, 0x00]);
    out.u24le(0);
    out.extend_from_slice(&[0x31, 0xFF, 0xF0]);
    out.u16le((max_x - min_x) as u32);
    out.u16le((max_y - min_y) as u32);
    out.u16le(0x1E0);
    out.u16le(0x1B0);
    // The stitch stream starts at the top-left corner of the design: a jump
    // from there to the origin (the design centre), as Ink/Stitch's pystitch
    // writes it. Brother machines place the design from this start; without
    // it the design lands half its size up and to the left in the hoop.
    write_value(out, -min_x, true, JUMP_CODE);
    write_value(out, -min_y, true, JUMP_CODE);
    encode_stitches(e, out);
    let len = out.len() - start;
    if len > MAX_BLOCK_LEN {
        return Err(too_big(format!("{format}: the stitch data takes {len} bytes; {format} stores at most {MAX_BLOCK_LEN} bytes")));
    }
    out.patch_u24le(start + 2, len as u32);
    Ok(())
}

fn write_value(out: &mut Vec<u8>, value: i32, long: bool, flag: u8) {
    if !long && -64 < value && value < 63 {
        out.u8((value & 0x7F) as u8);
    } else {
        let mut v = (value & 0x0FFF) as u32;
        v |= 0x8000;
        v |= (flag as u32) << 8;
        out.u8((v >> 8) as u8);
        out.u8(v as u8);
    }
}

fn write_stitch(out: &mut Vec<u8>, dx: i32, dy: i32) {
    write_value(out, dx, false, 0);
    write_value(out, dy, false, 0);
}

fn encode_stitches(e: &Encoded, out: &mut Vec<u8>) {
    let mut color_two = true;
    let mut jumping = true;
    let mut init = true;
    // a trim waiting for its jump: PEC carries trims on jumps only
    let mut trim = false;
    let (mut xx, mut yy) = (0, 0);
    for r in &e.recs {
        let dx = r.x - xx;
        let dy = r.y - yy;
        xx = r.x;
        yy = r.y;
        match r.cmd {
            Cmd::Stitch => {
                if trim && !jumping {
                    // no jump after the trim (the next stitch starts where the
                    // last one ended): a zero-length trim-jump keeps the trim
                    write_value(out, 0, true, TRIM_CODE);
                    write_value(out, 0, true, TRIM_CODE);
                    jumping = true;
                }
                trim = false;
                if jumping {
                    if dx != 0 && dy != 0 {
                        write_stitch(out, 0, 0);
                    }
                    jumping = false;
                }
                write_stitch(out, dx, dy);
            }
            Cmd::Jump => {
                trim = false;
                jumping = true;
                let flag = if init { JUMP_CODE } else { TRIM_CODE };
                write_value(out, dx, true, flag);
                write_value(out, dy, true, flag);
            }
            Cmd::ColorChange => {
                trim = false;
                if jumping {
                    write_stitch(out, 0, 0);
                    jumping = false;
                }
                out.extend_from_slice(&[0xFE, 0xB0, if color_two { 0x02 } else { 0x01 }]);
                color_two = !color_two;
            }
            // Stops were turned into duplicate colours; trims are implied by trim-jumps.
            Cmd::Stop => {}
            Cmd::Trim => trim = !init,
            Cmd::End => {
                out.u8(0xFF);
                break;
            }
        }
        init = false;
    }
}

/// The empty 48x38 thumbnail frame.
fn blank() -> Vec<u8> {
    let mut g = vec![0u8; STRIDE * ICON_HEIGHT];
    let rows: [(usize, [u8; 6]); 6] = [
        (1, [0xF0, 0xFF, 0xFF, 0xFF, 0xFF, 0x0F]),
        (2, [0x08, 0, 0, 0, 0, 0x10]),
        (3, [0x04, 0, 0, 0, 0, 0x20]),
        (34, [0x04, 0, 0, 0, 0, 0x20]),
        (35, [0x08, 0, 0, 0, 0, 0x10]),
        (36, [0xF0, 0xFF, 0xFF, 0xFF, 0xFF, 0x0F]),
    ];
    for (row, bytes) in rows {
        g[row * STRIDE..(row + 1) * STRIDE].copy_from_slice(&bytes);
    }
    for row in 4..=33 {
        g[row * STRIDE] = 0x02;
        g[row * STRIDE + 5] = 0x40;
    }
    g
}

fn draw_scaled(bounds: (i32, i32, i32, i32), points: &[Rec], g: &mut [u8], buffer: f64) {
    let (left, top, right, bottom) = (
        bounds.0 as f64,
        bounds.1 as f64,
        bounds.2 as f64,
        bounds.3 as f64,
    );
    let dw = if right - left == 0.0 {
        1.0
    } else {
        right - left
    };
    let dh = if bottom - top == 0.0 {
        1.0
    } else {
        bottom - top
    };
    let gw = ICON_WIDTH as f64;
    let gh = ICON_HEIGHT as f64;
    let scale = ((gw - buffer) / dw).min((gh - buffer) / dh);
    let tx = -(right + left) / 2.0 * scale + gw / 2.0;
    let ty = -(bottom + top) / 2.0 * scale + gh / 2.0;
    for p in points {
        let x = (p.x as f64 * scale + tx).floor();
        let y = (p.y as f64 * scale + ty).floor();
        if x >= 0.0 && y >= 0.0 && (x as usize) < ICON_WIDTH && (y as usize) < ICON_HEIGHT {
            let (x, y) = (x as usize, y as usize);
            g[y * STRIDE + x / 8] |= 1 << (x % 8);
        }
    }
}

fn write_graphics(e: &Encoded, out: &mut Vec<u8>) {
    let bounds = e.bounds();
    let stitches: Vec<Rec> = e
        .recs
        .iter()
        .copied()
        .filter(|r| r.cmd == Cmd::Stitch)
        .collect();
    let mut g = blank();
    draw_scaled(bounds, &stitches, &mut g, 4.0);
    out.extend_from_slice(&g);
    // One image per colour block; blocks end with (and include) their colour change.
    let mut start = 0;
    let mut blocks: Vec<&[Rec]> = Vec::new();
    for (i, r) in e.recs.iter().enumerate() {
        if r.cmd == Cmd::ColorChange {
            blocks.push(&e.recs[start..=i]);
            start = i + 1;
        }
    }
    if start != e.recs.len() {
        blocks.push(&e.recs[start..]);
    }
    for b in blocks {
        let pts: Vec<Rec> = b.iter().copied().filter(|r| r.cmd == Cmd::Stitch).collect();
        let mut g = blank();
        draw_scaled(bounds, &pts, &mut g, 5.0);
        out.extend_from_slice(&g);
    }
}

// ---------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------

pub(crate) fn read(bytes: &[u8]) -> Result<Pattern, Error> {
    if !bytes.starts_with(b"#PEC") {
        return Err(Error::Malformed("missing #PEC signature".into()));
    }
    let mut raw = RawPattern::new();
    read_pec(bytes, 8, &mut raw, Vec::new())?;
    raw.duplicate_colors_as_stops();
    Ok(raw.finish())
}

/// Maps PEC colour bytes to threads, optionally using a PES thread chart (v5+).
fn map_colors(color_bytes: &[u8], mut chart: Vec<Thread>) -> Vec<Thread> {
    if chart.is_empty() {
        return color_bytes
            .iter()
            .map(|&b| pec_thread(b as usize))
            .collect();
    }
    if chart.len() >= color_bytes.len() {
        return chart;
    }
    // Tabled mode: each distinct palette index takes the next chart thread.
    let mut map: Vec<(usize, Thread)> = Vec::new();
    let mut out = Vec::new();
    for &b in color_bytes {
        let idx = b as usize % crate::palette::PEC_TABLE_LEN;
        let t = match map.iter().find(|(i, _)| *i == idx) {
            Some((_, t)) => t.clone(),
            None => {
                let t = if chart.is_empty() {
                    pec_thread(idx)
                } else {
                    chart.remove(0)
                };
                map.push((idx, t.clone()));
                t
            }
        };
        out.push(t);
    }
    out
}

fn signed12(v: u32) -> i32 {
    let v = (v & 0xFFF) as i32;
    if v > 0x7FF {
        v - 0x1000
    } else {
        v
    }
}

fn signed7(v: u8) -> i32 {
    if v > 63 {
        v as i32 - 128
    } else {
        v as i32
    }
}

/// Reads the PEC section starting at `start` into `raw`.
pub(crate) fn read_pec(
    bytes: &[u8],
    start: usize,
    raw: &mut RawPattern,
    chart: Vec<Thread>,
) -> Result<(), Error> {
    let mut r = Reader::at(bytes, start);
    r.seek(start)?;
    r.skip(3)?; // LA:
    let label = r.string(16)?;
    if raw.name.is_empty() {
        raw.name = label.trim().to_string();
    }
    r.skip(0xF)?;
    let _stride = r.u8()?;
    let _icon_height = r.u8()?;
    r.skip(0xC)?;
    let color_changes = r.u8()? as usize;
    // 0xFF is written for a pattern without colours.
    let count_colors = if color_changes == 0xFF {
        0
    } else {
        color_changes + 1
    };
    let color_bytes = r.bytes(count_colors)?.to_vec();
    raw.threads = map_colors(&color_bytes, chart);
    // Header is 512 bytes; the stitch block length lives 2 bytes into the block.
    r.seek(start + 512 + 2)?;
    let block_len = r.u24le()? as usize;
    let block_end = (start + 512 + block_len).min(bytes.len());
    r.skip(0x0B)?;
    let data = bytes.get(r.pos..block_end.max(r.pos)).unwrap_or(&[]);
    read_stitches(data, raw);
    Ok(())
}

pub(crate) fn read_stitches(data: &[u8], raw: &mut RawPattern) {
    let mut i = 0usize;
    let next = |i: &mut usize| -> Option<u8> {
        let b = data.get(*i).copied();
        *i += 1;
        b
    };
    while let Some(v1) = next(&mut i) {
        let Some(mut v2) = next(&mut i) else { break };
        if v1 == 0xFF && v2 == 0x00 {
            break;
        }
        if v1 == 0xFE && v2 == 0xB0 {
            i += 1;
            raw.color_change();
            continue;
        }
        let mut jump = false;
        let mut trim = false;
        let x;
        if v1 & FLAG_LONG != 0 {
            trim |= v1 & TRIM_CODE != 0;
            jump |= v1 & JUMP_CODE != 0;
            x = signed12(((v1 as u32) << 8) | v2 as u32);
            let Some(b) = next(&mut i) else { break };
            v2 = b;
        } else {
            x = signed7(v1);
        }

        let y = if v2 & FLAG_LONG != 0 {
            trim |= v2 & TRIM_CODE != 0;
            jump |= v2 & JUMP_CODE != 0;
            let Some(v3) = next(&mut i) else { break };
            signed12(((v2 as u32) << 8) | v3 as u32)
        } else {
            signed7(v2)
        };
        if jump {
            raw.jump(x, y);
        } else if trim {
            raw.trim();
            raw.jump(x, y);
        } else {
            raw.stitch(x, y);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blank_matches_pystitch() {
        let g = blank();
        assert_eq!(g.len(), 228);
        assert_eq!(&g[0..6], &[0; 6]);
        assert_eq!(&g[6..12], &[0xF0, 0xFF, 0xFF, 0xFF, 0xFF, 0x0F]);
        assert_eq!(&g[24..30], &[0x02, 0, 0, 0, 0, 0x40]);
        assert_eq!(&g[33 * 6..34 * 6], &[0x02, 0, 0, 0, 0, 0x40]);
        assert_eq!(&g[34 * 6..35 * 6], &[0x04, 0, 0, 0, 0, 0x20]);
        assert_eq!(&g[222..228], &[0; 6]);
    }

    #[test]
    fn a_trim_with_no_jump_after_it_is_kept() {
        let rec = |x, cmd| Rec { x, y: 0, cmd };
        let e = Encoded {
            recs: vec![rec(0, Cmd::Jump), rec(0, Cmd::Stitch), rec(10, Cmd::Stitch), rec(10, Cmd::Trim), rec(10, Cmd::Stitch), rec(20, Cmd::Stitch), rec(20, Cmd::End)],
            threads: Vec::new(),
            name: String::new(),
        };
        let mut out = Vec::new();
        encode_stitches(&e, &mut out);
        let mut raw = RawPattern::new();
        read_stitches(&out, &mut raw);
        assert_eq!(raw.recs.iter().filter(|r| r.cmd == Cmd::Trim).count(), 1);
    }

    #[test]
    fn a_stitch_block_beyond_the_24_bit_length_is_an_error() {
        // 4 bytes per long jump: just over 16 MB of stitch data.
        let n = MAX_BLOCK_LEN / 4 + 1;
        let mut recs: Vec<Rec> = (0..n).map(|i| Rec { x: if i % 2 == 0 { 2000 } else { 0 }, y: 0, cmd: Cmd::Jump }).collect();
        recs.push(Rec { x: 0, y: 0, cmd: Cmd::End });
        let e = Encoded { recs, threads: Vec::new(), name: String::new() };
        let err = write_block(&e, &mut Vec::new(), "PEC").unwrap_err();
        assert_eq!(err, Error::Malformed(format!("PEC: the stitch data takes {} bytes; PEC stores at most 16777215 bytes", 4 * n + 21)));
    }

    #[test]
    fn value_encoding() {
        let mut v = Vec::new();
        write_value(&mut v, -1, false, 0);
        write_value(&mut v, 62, false, 0);
        write_value(&mut v, 63, false, 0);
        write_value(&mut v, -300, true, JUMP_CODE);
        assert_eq!(v, vec![0x7F, 0x3E, 0x80, 0x3F, 0x9E, 0xD4]);
        assert_eq!(signed7(0x7F), -1);
        assert_eq!(signed12(0x9ED4), -300);
    }
}
