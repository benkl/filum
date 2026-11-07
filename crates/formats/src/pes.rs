//! Brother PES reader/writer (writes PES version 1 + PEC section, like pystitch's default).
//!
//! Ported from pystitch, Ink/Stitch's embroidery file library (MIT, Copyright (c) 2018 Tatarize
//! and the Ink/Stitch contributors)
//! (`PesWriter.py`, `PesReader.py`).
//!
//! Reading uses the PEC section for stitches; for PES v5–v10 the embedded thread chart
//! (with RGB) is used for colours.

use crate::encoder::{check_count, check_size, Cmd, Encoded, Rec};
use crate::io::{ByteWriter, Reader};
use crate::pec::{color_indices, encode_for_pec, header_color_list, read_pec, write_pec};
use crate::raw::RawPattern;
use crate::{Error, Pattern, PesVersion, Thread, WriteOptions};

const EMB_ONE: &str = "CEmbOne";
const EMB_SEG: &str = "CSewSeg";

pub(crate) fn write(p: &Pattern, opts: &WriteOptions) -> Result<Vec<u8>, Error> {
    let e = encode_for_pec(p, opts);
    let indices = color_indices(&e);
    crate::pec::check(&e, &indices, "PES")?;
    if opts.pes_version == PesVersion::V6 {
        return write_v6(&e, &indices);
    }
    let mut out = Vec::new();
    out.str("#PES0001");
    let pec_offset_pos = out.len();
    out.u32le(0);
    if e.recs.is_empty() {
        write_header_v1(&mut out, 0);
        out.u16le(0x0000);
        out.u16le(0x0000);
    } else {
        write_header_v1(&mut out, 1);
        out.u16le(0xFFFF);
        out.u16le(0x0000);
        write_blocks(&e, &indices, &mut out)?;
    }
    let pec_start = out.len();
    out.patch_u32le(pec_offset_pos, pec_start as u32);
    write_pec(&e, &indices, &mut out, "PES")?;
    Ok(out)
}

/// PES version 6 (pystitch `write_version_6`): the PES header carries the
/// design's own thread list (catalogue code, RGB, name, brand) and every
/// segment refers to it, so machines that read it show the exact threads;
/// the PEC section is the same as in version 1.
fn write_v6(e: &Encoded, indices: &[usize]) -> Result<Vec<u8>, Error> {
    // one chart entry per colour block (pystitch `fix_color_count`)
    let chart: Vec<Thread> = (0..e.threads.len().max(if e.recs.is_empty() { 0 } else { 1 })).map(|i| e.thread(i)).collect();
    // segment colour codes index the chart: nearest chart colour, ties to the
    // later entry (pystitch `find_nearest_color_index(chart)`)
    let slots: Vec<Option<[u8; 3]>> = chart.iter().map(|t| Some(t.rgb)).collect();
    let codes: Vec<usize> = chart.iter().map(|t| crate::color::nearest_index(t.rgb, &slots).unwrap_or(0)).collect();
    let mut out = Vec::new();
    out.str("#PES0060");
    let pec_offset_pos = out.len();
    out.u32le(0);
    if e.recs.is_empty() {
        write_header_v6(&mut out, &e.name, &chart, 0);
        out.u16le(0x0000);
        out.u16le(0x0000);
    } else {
        write_header_v6(&mut out, &e.name, &chart, 1);
        out.u16le(0xFFFF);
        out.u16le(0x0000);
        let log = write_blocks(e, &codes, &mut out)?;
        // version 6: a node / order table after the blocks
        out.u32le(0);
        out.u32le(0);
        for i in 0..log {
            out.u32le(i as u32);
            out.u32le(0);
        }
    }
    let pec_start = out.len();
    out.patch_u32le(pec_offset_pos, pec_start as u32);
    write_pec(e, indices, &mut out, "PES")?;
    // addendum: the PEC colour list again, then the RGB of every chart entry
    let list = header_color_list(indices);
    out.extend_from_slice(&list);
    out.fill(0x20, 128usize.saturating_sub(list.len()));
    for _ in &chart {
        out.fill(0, 0x90);
    }
    for t in &chart {
        out.extend_from_slice(&[t.rgb[2], t.rgb[1], t.rgb[0]]);
    }
    out.u16le(0x0000);
    Ok(out)
}

fn write_string8(out: &mut Vec<u8>, s: &str) {
    let b = s.as_bytes();
    let b = &b[..b.len().min(255)];
    out.u8(b.len() as u8);
    out.extend_from_slice(b);
}

fn write_header_v6(out: &mut Vec<u8>, name: &str, chart: &[Thread], distinct_block_objects: u32) {
    out.u16le(0x01); // 130x180 hoop
    out.str("02"); // a two-digit ASCII number
    write_string8(out, name);
    for _ in 0..4 {
        out.u8(0); // category, author, keywords, comments
    }
    out.u16le(0); // optimize hoop change
    out.u16le(0); // design page is custom
    out.u16le(0x64); // hoop width
    out.u16le(0x64); // hoop height
    out.u16le(0); // use existing design area
    out.u16le(0xC8); // design width
    out.u16le(0xC8); // design height
    out.u16le(0x64); // design page section width
    out.u16le(0x64); // design page section height
    out.u16le(0x64);
    out.u16le(0x07); // page background colour
    out.u16le(0x13); // page foreground colour
    out.u16le(0x01); // show grid
    out.u16le(0x01); // with axes
    out.u16le(0x00); // snap to grid
    out.u16le(100); // grid interval
    out.u16le(0x01);
    out.u16le(0x00); // optimize entry / exit points
    out.u8(0); // from-image file name length
    for v in [1.0f32, 0.0, 0.0, 1.0, 0.0, 0.0] {
        out.f32le(v);
    }
    out.u16le(0); // programmable fill patterns
    out.u16le(0); // motif patterns
    out.u16le(0); // feather patterns
    out.u16le(chart.len() as u32);
    for t in chart {
        write_string8(out, &t.code);
        out.extend_from_slice(&t.rgb);
        out.u8(0);
        out.u32le(0xA); // custom colour
        write_string8(out, &t.name);
        write_string8(out, &t.brand);
        write_string8(out, &t.brand); // chart (pystitch: the brand)
    }
    out.u16le(distinct_block_objects);
}

fn write_header_v1(out: &mut Vec<u8>, distinct_block_objects: u32) {
    out.u16le(0x01); // scale to fit
    out.u16le(0x01); // 130x180 hoop
    out.u16le(distinct_block_objects);
}

fn write_string16(out: &mut Vec<u8>, s: &str) {
    out.u16le(s.len() as u32);
    out.str(s);
}

/// Writes the CEmbOne / CSewSeg blocks; returns the colour log length.
fn write_blocks(e: &Encoded, indices: &[usize], out: &mut Vec<u8>) -> Result<usize, Error> {
    let (min_x, min_y, max_x, max_y) = e.bounds();
    // Segment points are signed 16-bit: x - left in 0..=width, y - bottom in -height..=0.
    check_size("PES", max_x - min_x, max_y - min_y, 0x7FFF, 0x8000)?;
    write_string16(out, EMB_ONE);
    let sections_pos = write_sewsegheader(out, (max_x - min_x) as f64, (max_y - min_y) as f64);
    out.u16le(0xFFFF);
    out.u16le(0x0000); // FFFF0000: more blocks follow
    write_string16(out, EMB_SEG);
    let (sections, log) = write_segments(e, indices, min_x, max_y, out)?;
    out.patch_u16le(sections_pos, sections as u32);
    out.u16le(0x0000);
    out.u16le(0x0000); // 00000000: no more blocks
    Ok(log)
}

fn write_sewsegheader(out: &mut Vec<u8>, width: f64, height: f64) -> usize {
    let hoop_width = 1300.0;
    let hoop_height = 1800.0;
    for _ in 0..8 {
        out.u16le(0);
    }
    let trans_x = 350.0 + hoop_width / 2.0 - width / 2.0;
    let trans_y = 100.0 + height + hoop_height / 2.0 - height / 2.0;
    for v in [1.0f32, 0.0, 0.0, 1.0, trans_x as f32, trans_y as f32] {
        out.f32le(v);
    }
    out.u16le(1);
    out.u16le(0);
    out.u16le(0);
    out.u16le(width as u32);
    out.u16le(height as u32);
    out.fill(0, 8);
    let pos = out.len();
    out.u16le(0); // section count placeholder
    pos
}

/// Most points one section holds (a 16-bit count).
const MAX_SECTION_POINTS: usize = 0xFFFF;

/// Splits a run of stitches into sections of at most [`MAX_SECTION_POINTS`]; each
/// further section starts at the point where the previous one ended, as a stitch
/// section starts where the jump before it ended.
fn split_points(points: Vec<(i32, i32)>) -> Vec<Vec<(i32, i32)>> {
    if points.len() <= MAX_SECTION_POINTS {
        return vec![points];
    }
    let mut out = Vec::new();
    let mut start = 0;
    loop {
        let end = (start + MAX_SECTION_POINTS).min(points.len());
        out.push(points[start..end].to_vec());
        if end == points.len() {
            return out;
        }
        start = end - 1;
    }
}

/// Writes the CSewSeg segments; returns the number of sections and of colour log entries.
fn write_segments(
    e: &Encoded,
    indices: &[usize],
    adjust_x: i32,
    adjust_y: i32,
    out: &mut Vec<u8>,
) -> Result<(usize, usize), Error> {
    let code_for = |block: usize| -> u32 { indices.get(block).copied().unwrap_or(0) as u32 };
    let mut block_index = 0usize;
    let mut color_code = code_for(0);
    let (mut sx, mut sy) = (0i32, 0i32);
    let mut section = 0usize;
    let mut colorlog: Vec<(usize, u32)> = Vec::new();
    let mut previous_code: Option<u32> = None;
    let mut first = true;

    // Group consecutive records with the same command.
    let mut groups: Vec<&[Rec]> = Vec::new();
    let mut start = 0;
    for i in 1..=e.recs.len() {
        if i == e.recs.len() || e.recs[i].cmd != e.recs[start].cmd {
            groups.push(&e.recs[start..i]);
            start = i;
        }
    }
    for g in groups {
        let (points, flag): (Vec<(i32, i32)>, u32) = match g[0].cmd {
            Cmd::Jump => {
                let last = g[g.len() - 1];
                (
                    vec![
                        (sx - adjust_x, sy - adjust_y),
                        (last.x - adjust_x, last.y - adjust_y),
                    ],
                    1,
                )
            }
            Cmd::ColorChange => {
                block_index += g.len();
                color_code = code_for(block_index);
                continue;
            }
            Cmd::Stitch => {
                let pts = g.iter().map(|r| (r.x - adjust_x, r.y - adjust_y)).collect();
                let last = g[g.len() - 1];
                sx = last.x;
                sy = last.y;
                (pts, 0)
            }
            _ => continue,
        };
        for points in split_points(points) {
            if !first {
                out.u16le(0x8003); // section end
            }
            first = false;
            if previous_code != Some(color_code) {
                colorlog.push((section, color_code));
                previous_code = Some(color_code);
            }
            out.u16le(flag);
            out.u16le(color_code);
            out.u16le(points.len() as u32);
            for (x, y) in points {
                out.u16le(x as u32);
                out.u16le(y as u32);
            }
            section += 1;
        }
    }
    // The section count and the colour log's section numbers are 16-bit.
    check_count("PES", section, 0xFFFF, "stitch and jump sections")?;
    out.u16le(colorlog.len() as u32);
    let log = colorlog.len();
    for (s, c) in colorlog {
        out.u16le(s as u32);
        out.u16le(c);
    }
    Ok((section, log))
}

// ---------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------

fn read_pes_string(r: &mut Reader) -> Result<Option<String>, Error> {
    let n = r.u8()? as usize;
    if n == 0 {
        return Ok(None);
    }
    Ok(Some(r.string(n)?))
}

/// Reads name/category/author/keywords/comments; returns the name.
fn read_metadata(r: &mut Reader) -> Result<Option<String>, Error> {
    let name = read_pes_string(r)?;
    for _ in 0..4 {
        read_pes_string(r)?;
    }
    Ok(name.filter(|s| !s.is_empty()))
}

fn read_thread_chart(r: &mut Reader) -> Result<Vec<Thread>, Error> {
    let mut threads = Vec::new();
    for _ in 0..3 {
        // programmable fills, motifs, feather patterns: abort on anything complex.
        if r.u16le()? != 0 {
            return Ok(threads);
        }
    }
    let count = r.u16le()?;
    for _ in 0..count {
        let code = read_pes_string(r)?.unwrap_or_default();
        let c = r.u24be()?;
        r.skip(5)?;
        let name = read_pes_string(r)?.unwrap_or_default();
        let brand = read_pes_string(r)?.unwrap_or_default();
        let _chart = read_pes_string(r)?;
        threads.push(Thread {
            rgb: [(c >> 16) as u8, (c >> 8) as u8, c as u8],
            name,
            code,
            brand,
        });
    }
    Ok(threads)
}

/// Version-specific header layout: (skip after metadata, extra string+skip pairs).
fn read_header(r: &mut Reader, version: &[u8]) -> Result<(Option<String>, Vec<Thread>), Error> {
    // Each entry: skips interleaved with strings, as in pystitch's PesReader.
    let layout: &[usize] = match version {
        b"0040" => {
            r.skip(4)?;
            let name = read_metadata(r)?;
            return Ok((name, Vec::new()));
        }
        b"0050" | b"0055" | b"0056" => &[24, 24],
        b"0060" | b"0070" => &[36, 24],
        b"0080" => &[38, 26],
        b"0090" => &[14, 30, 34],
        b"0100" => &[14, 38, 34],
        _ => return Ok((None, Vec::new())),
    };
    r.skip(4)?;
    let name = read_metadata(r)?;
    for (i, &skip) in layout.iter().enumerate() {
        r.skip(skip)?;
        if i + 1 < layout.len() {
            read_pes_string(r)?;
        }
    }
    let threads = read_thread_chart(r)?;
    Ok((name, threads))
}

pub(crate) fn read(bytes: &[u8]) -> Result<Pattern, Error> {
    if bytes.starts_with(b"#PEC0001") {
        return crate::pec::read(bytes);
    }
    if !bytes.starts_with(b"#PES") || bytes.len() < 12 {
        return Err(Error::Malformed("missing #PES signature".into()));
    }
    let version = &bytes[4..8];
    let mut r = Reader::new(bytes);
    r.seek(8)?;
    let pec_offset = r.u32le()? as usize;
    // Header parsing is best effort: on failure fall back to the PEC palette.
    let (name, chart) = read_header(&mut r, version).unwrap_or((None, Vec::new()));
    let mut raw = RawPattern::new();
    if let Some(n) = name {
        raw.name = n;
    }
    read_pec(bytes, pec_offset, &mut raw, chart)?;
    raw.duplicate_colors_as_stops();
    Ok(raw.finish())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn long_runs_split_into_sections_that_share_their_ends() {
        let pts: Vec<(i32, i32)> = (0..2 * MAX_SECTION_POINTS as i32 + 10).map(|i| (i, 0)).collect();
        let chunks = split_points(pts.clone());
        assert_eq!(chunks.iter().map(Vec::len).collect::<Vec<_>>(), vec![MAX_SECTION_POINTS, MAX_SECTION_POINTS, 12]);
        for w in chunks.windows(2) {
            assert_eq!(w[0].last(), w[1].first());
        }
        assert_eq!(chunks.last().unwrap().last(), pts.last());
        assert_eq!(split_points(pts[..10].to_vec()), vec![pts[..10].to_vec()]);
    }
}
