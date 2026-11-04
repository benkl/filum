//! Thread colour files COL, EDR and INF.
//!
//! Ported from pystitch, Ink/Stitch's embroidery file library (MIT, Copyright (c) 2018 Tatarize
//! and the Ink/Stitch contributors)
//! (`ColWriter.py`, `EdrWriter.py`, `InfWriter.py` and their readers).
//!
//! They hold one entry per colour block and no stitches; machines and software load them
//! next to a stitch file of the same name (e.g. a DST, which has no colours).

use crate::encoder::{encode, UNLIMITED};
use crate::io::ByteWriter;
use crate::{Pattern, Thread};

/// One thread per colour block, as Ink/Stitch's pattern thread list.
fn threads(p: &Pattern) -> Vec<Thread> {
    encode(p, UNLIMITED, false).threads
}

/// COL: a text list `index,r,g,b`.
pub(crate) fn write_col(p: &Pattern) -> Vec<u8> {
    let t = threads(p);
    let mut s = format!("{}\r\n", t.len());
    for (i, t) in t.iter().enumerate() {
        s += &format!("{},{},{},{}\r\n", i, t.rgb[0], t.rgb[1], t.rgb[2]);
    }
    s.into_bytes()
}

/// EDR: `r, g, b, 0` per thread.
pub(crate) fn write_edr(p: &Pattern) -> Vec<u8> {
    let mut out = Vec::new();
    for t in threads(p) {
        out.extend_from_slice(&t.rgb);
        out.u8(0);
    }
    out
}

/// INF: big-endian records with colour, needle number, description and chart.
pub(crate) fn write_inf(p: &Pattern) -> Vec<u8> {
    let t = threads(p);
    let mut out = Vec::new();
    out.extend_from_slice(&1u32.to_be_bytes());
    out.extend_from_slice(&8u32.to_be_bytes());
    let placeholder = out.len();
    out.u32le(0);
    out.extend_from_slice(&(t.len() as u32).to_be_bytes());
    for (i, t) in t.iter().enumerate() {
        let details = if t.name.is_empty() { "Unknown" } else { &t.name };
        // pystitch's chart: the thread chart / palette; the brand is ours.
        let chart = if t.brand.is_empty() { "Unknown" } else { &t.brand };
        // 2 + 2 + 3 + 2 + details + 1 + chart + 1 (pystitch counts characters; bytes here)
        out.u16be((11 + details.len() + chart.len()) as u32);
        out.u16be(i as u32); // record index
        out.extend_from_slice(&t.rgb);
        out.u16be(i as u32 + 1); // needle number
        out.str(details);
        out.u8(0);
        out.str(chart);
        out.u8(0);
    }
    let size = (out.len() - placeholder - 4) as u32;
    out.patch_u32be(placeholder, size);
    out
}

// ---------------------------------------------------------------------------
// Reading (pystitch `ColReader.py`, `EdrReader.py`, `InfReader.py`)

/// COL: the count, then `index,r,g,b` per line (pystitch keeps the index as the
/// catalogue number). Lines that do not parse are skipped.
pub(crate) fn read_col(bytes: &[u8]) -> Result<Vec<Thread>, crate::Error> {
    let text = String::from_utf8_lossy(bytes);
    let mut lines = text.lines();
    let count: usize = lines
        .next()
        .and_then(|l| l.trim().trim_start_matches('\u{feff}').parse().ok())
        .ok_or_else(|| crate::Error::Malformed("COL: no colour count".into()))?;
    let mut out = Vec::new();
    for line in lines.take(count) {
        let s: Vec<&str> = line.split(',').map(str::trim).collect();
        let c = |i: usize| s.get(i).and_then(|v| v.parse::<i64>().ok()).map(|v| v.clamp(0, 255) as u8);
        if let (Some(r), Some(g), Some(b)) = (c(1), c(2), c(3)) {
            let mut t = Thread::from_rgb([r, g, b]);
            t.code = s[0].to_string();
            out.push(t);
        }
    }
    Ok(out)
}

/// EDR: `r, g, b, 0` per thread.
pub(crate) fn read_edr(bytes: &[u8]) -> Result<Vec<Thread>, crate::Error> {
    Ok(bytes.chunks(4).filter(|c| c.len() >= 3).map(|c| Thread::from_rgb([c[0], c[1], c[2]])).collect())
}

/// INF: big-endian records; colour at bytes 2..5 of a record, then the needle
/// number, the description (name) and the chart (brand), NUL-terminated.
pub(crate) fn read_inf(bytes: &[u8]) -> Result<Vec<Thread>, crate::Error> {
    let mut r = crate::io::Reader::new(bytes);
    r.skip(12)?;
    let n = r.u32be()? as usize;
    let mut out = Vec::new();
    for _ in 0..n.min(10_000) {
        let Ok(len) = r.u16be() else { break };
        let Ok(rec) = r.bytes((len as usize).saturating_sub(2)) else { break };
        if rec.len() < 7 {
            break;
        }
        let mut t = Thread::from_rgb([rec[2], rec[3], rec[4]]);
        let mut parts = rec[7..].split(|&b| b == 0);
        let text = |b: Option<&[u8]>| b.map(|b| String::from_utf8_lossy(b).trim().to_string()).unwrap_or_default();
        let (name, chart) = (text(parts.next()), text(parts.next()));
        if name != "Unknown" {
            t.name = name;
        }
        if chart != "Unknown" {
            t.brand = chart;
        }
        out.push(t);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{cmd, Stitch};

    fn pattern() -> Pattern {
        Pattern {
            stitches: vec![
                Stitch::new(0.0, 0.0, 0),
                Stitch::new(1.0, 0.0, cmd::COLOR_CHANGE),
                Stitch::new(1.0, 0.0, 0),
                Stitch::new(1.0, 0.0, cmd::END),
            ],
            threads: vec![
                Thread { rgb: [255, 0, 0], name: "Red".into(), code: "1147".into(), brand: "Madeira".into() },
                Thread::from_rgb([0, 128, 255]),
                Thread::from_rgb([1, 2, 3]), // unused: no third block
            ],
            name: "x".into(),
        }
    }

    #[test]
    fn col() {
        assert_eq!(String::from_utf8(write_col(&pattern())).unwrap(), "2\r\n0,255,0,0\r\n1,0,128,255\r\n");
    }

    #[test]
    fn edr() {
        assert_eq!(write_edr(&pattern()), vec![255, 0, 0, 0, 0, 128, 255, 0]);
    }

    #[test]
    fn inf() {
        let b = write_inf(&pattern());
        assert_eq!(&b[..8], &[0, 0, 0, 1, 0, 0, 0, 8]);
        assert_eq!(u32::from_be_bytes(b[8..12].try_into().unwrap()) as usize, b.len() - 12);
        assert_eq!(&b[12..16], &[0, 0, 0, 2]);
        // first record: length, index 0, rgb, needle 1, "Red\0Madeira\0"
        assert_eq!(&b[16..25], &[0, 21, 0, 0, 255, 0, 0, 0, 1]);
        assert_eq!(&b[25..37], b"Red\0Madeira\0");
        assert_eq!(&b[37..39], &[0, 25]); // 11 + "Unknown" + "Unknown"
    }

    #[test]
    fn round_trips() {
        let p = pattern();
        let col = read_col(&write_col(&p)).unwrap();
        assert_eq!(col.iter().map(|t| t.rgb).collect::<Vec<_>>(), vec![[255, 0, 0], [0, 128, 255]]);
        assert_eq!(col[1].code, "1");
        let edr = read_edr(&write_edr(&p)).unwrap();
        assert_eq!(edr.iter().map(|t| t.rgb).collect::<Vec<_>>(), vec![[255, 0, 0], [0, 128, 255]]);
        let inf = read_inf(&write_inf(&p)).unwrap();
        assert_eq!(inf.len(), 2);
        assert_eq!((inf[0].rgb, inf[0].name.as_str(), inf[0].brand.as_str()), ([255, 0, 0], "Red", "Madeira"));
        assert_eq!((inf[1].rgb, inf[1].name.as_str()), ([0, 128, 255], ""));
    }

    #[test]
    fn col_skips_bad_lines() {
        let c = read_col(b"3
0,1,2,3
nonsense
2,300,0,0
").unwrap();
        assert_eq!(c.iter().map(|t| t.rgb).collect::<Vec<_>>(), vec![[1, 2, 3], [255, 0, 0]]);
        assert!(read_col(b"").is_err());
    }
}
