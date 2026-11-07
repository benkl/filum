//! Tajima DST reader/writer.
//!
//! Ported from pystitch, Ink/Stitch's embroidery file library (MIT, Copyright (c) 2018 Tatarize
//! and the Ink/Stitch contributors)
//! (`DstWriter.py`, `DstReader.py`).
//!
//! DST stores 3-byte records with balanced-ternary deltas in 0.1 mm, y up.
//! There is no trim command: trims are written as a jump sequence
//! (+2,+2), (-4,-4), (+2,+2) and recognised on read as three consecutive jumps.

use crate::encoder::{check_count, check_extent, encode, Cmd, EncodeSettings, Encoded};
use crate::io::ByteWriter;
use crate::raw::RawPattern;
use crate::{Error, Pattern, Thread, WriteOptions};

pub(crate) const SETTINGS: EncodeSettings = EncodeSettings {
    max_stitch: 121,
    max_jump: 121,
    full_jump: true,
};
const HEADER_SIZE: usize = 512;
/// Number of jumps a trim is written as (pystitch `trim_at`).
const TRIM_AT: usize = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Kind {
    Stitch,
    Jump,
    ColorChange,
    End,
}

/// Encodes one record. `dx`, `dy` are in 0.1 mm with y **down**; the y flip happens here.
/// Values outside ±121 cannot be represented and are clamped.
pub(crate) fn encode_record(dx: i32, dy: i32, kind: Kind) -> [u8; 3] {
    let mut x = dx.clamp(-121, 121);
    let mut y = (-dy).clamp(-121, 121);
    let (mut b0, mut b1, mut b2) = (0u8, 0u8, 0u8);
    match kind {
        Kind::ColorChange => return [0, 0, 0b1100_0011],
        Kind::End => return [0, 0, 0b1111_0011],
        Kind::Jump => b2 |= 1 << 7,
        Kind::Stitch => {}
    }
    b2 |= 0b11;
    // (threshold, weight, byte index, bit for positive, bit for negative)
    let x_digits: [(i32, usize, u8, u8); 5] = [
        (81, 2, 2, 3),
        (27, 1, 2, 3),
        (9, 0, 2, 3),
        (3, 1, 0, 1),
        (1, 0, 0, 1),
    ];
    let y_digits: [(i32, usize, u8, u8); 5] = [
        (81, 2, 5, 4),
        (27, 1, 5, 4),
        (9, 0, 5, 4),
        (3, 1, 7, 6),
        (1, 0, 7, 6),
    ];
    let bytes = [&mut b0, &mut b1, &mut b2];
    for &(w, bi, pos, neg) in &x_digits {
        let half = w / 2;
        if x > half {
            *bytes[bi] |= 1 << pos;
            x -= w;
        }
        if x < -half {
            *bytes[bi] |= 1 << neg;
            x += w;
        }
    }
    for &(w, bi, pos, neg) in &y_digits {
        let half = w / 2;
        if y > half {
            *bytes[bi] |= 1 << pos;
            y -= w;
        }
        if y < -half {
            *bytes[bi] |= 1 << neg;
            y += w;
        }
    }
    debug_assert!(x == 0 && y == 0);
    [b0, b1, b2]
}

fn bit(b: u8, pos: u32) -> i32 {
    ((b >> pos) & 1) as i32
}

/// Decodes the x delta (0.1 mm).
pub(crate) fn decode_dx(b0: u8, b1: u8, b2: u8) -> i32 {
    81 * (bit(b2, 2) - bit(b2, 3))
        + 27 * (bit(b1, 2) - bit(b1, 3))
        + 9 * (bit(b0, 2) - bit(b0, 3))
        + 3 * (bit(b1, 0) - bit(b1, 1))
        + (bit(b0, 0) - bit(b0, 1))
}

/// Decodes the y delta (0.1 mm), already flipped to y down.
pub(crate) fn decode_dy(b0: u8, b1: u8, b2: u8) -> i32 {
    let y = 81 * (bit(b2, 5) - bit(b2, 4))
        + 27 * (bit(b1, 5) - bit(b1, 4))
        + 9 * (bit(b0, 5) - bit(b0, 4))
        + 3 * (bit(b1, 7) - bit(b1, 6))
        + (bit(b0, 7) - bit(b0, 6));
    -y
}

/// Header-safe label: ASCII printable only, at most 16 characters.
fn label(name: &str) -> String {
    let n: String = name
        .chars()
        .filter(|c| c.is_ascii() && !c.is_ascii_control())
        .take(16)
        .collect();
    if n.trim().is_empty() {
        "Untitled".into()
    } else {
        n
    }
}

pub(crate) fn header(e: &Encoded) -> Vec<u8> {
    let (min_x, min_y, max_x, max_y) = e.bounds();
    let mut h = String::new();
    h += &format!("LA:{:<16}\r", label(&e.name));
    h += &format!("ST:{:>7}\r", e.recs.len());
    // colour changes and stops (pystitch)
    h += &format!("CO:{:>3}\r", e.count(Cmd::ColorChange) + e.count(Cmd::Stop));
    // pystitch writes abs() of the y-down bounds for +Y/-Y.
    h += &format!("+X:{:>5}\r", max_x.abs());
    h += &format!("-X:{:>5}\r", min_x.abs());
    h += &format!("+Y:{:>5}\r", max_y.abs());
    h += &format!("-Y:{:>5}\r", min_y.abs());
    let (ax, ay) = e.recs.last().map_or((0, 0), |r| (r.x, -r.y));
    h += &format!("AX:{}{:>5}\r", if ax >= 0 { '+' } else { '-' }, ax.abs());
    h += &format!("AY:{}{:>5}\r", if ay >= 0 { '+' } else { '-' }, ay.abs());
    h += &format!("MX:+{:>5}\r", 0);
    h += &format!("MY:+{:>5}\r", 0);
    h += &format!("PD:{:>6}\r", "******");
    let mut out = h.into_bytes();
    out.push(0x1A);
    if out.len() < HEADER_SIZE {
        out.fill(b' ', HEADER_SIZE - out.len());
    }
    out.truncate(HEADER_SIZE);
    out
}

/// The DST / TBF header's fixed-width text fields (`ST:%7d`, `CO:%3d`, `+X:%5d`, …):
/// a wider number would shift every later field.
pub(crate) fn check_header(format: &str, e: &Encoded, color_changes: usize) -> Result<(), Error> {
    check_count(format, e.recs.len(), 9_999_999, "stitch records")?;
    check_count(format, color_changes, 999, "colour changes and stops")?;
    let (min_x, min_y, max_x, max_y) = e.bounds();
    // AX / AY (the last position) lie within the bounds.
    check_extent(format, &[min_x, min_y, max_x, max_y], -99_999, 99_999)
}

pub(crate) fn write(p: &Pattern, opts: &WriteOptions) -> Result<Vec<u8>, Error> {
    let e = encode(p, SETTINGS, opts.long_stitch_as_jumps);
    check_header("DST", &e, e.count(Cmd::ColorChange) + e.count(Cmd::Stop))?;
    let mut out = header(&e);
    let (mut xx, mut yy) = (0i32, 0i32);
    for r in &e.recs {
        let dx = r.x - xx;
        let dy = r.y - yy;
        xx = r.x;
        yy = r.y;
        match r.cmd {
            Cmd::Stitch => out.extend_from_slice(&encode_record(dx, dy, Kind::Stitch)),
            Cmd::Jump => out.extend_from_slice(&encode_record(dx, dy, Kind::Jump)),
            Cmd::ColorChange | Cmd::Stop => {
                out.extend_from_slice(&encode_record(0, 0, Kind::ColorChange))
            }
            Cmd::End => out.extend_from_slice(&encode_record(0, 0, Kind::End)),
            Cmd::Trim => {
                let mut delta = -4;
                out.extend_from_slice(&encode_record(-delta / 2, -delta / 2, Kind::Jump));
                for _ in 1..TRIM_AT - 1 {
                    out.extend_from_slice(&encode_record(delta, delta, Kind::Jump));
                    delta = -delta;
                }
                out.extend_from_slice(&encode_record(delta / 2, delta / 2, Kind::Jump));
            }
        }
    }
    Ok(out)
}

fn parse_hex(s: &str) -> Option<[u8; 3]> {
    let h = s.trim().trim_start_matches('#');
    if h.len() < 6 || !h.is_ascii() {
        return None;
    }
    let v = u32::from_str_radix(&h[..6], 16).ok()?;
    Some([(v >> 16) as u8, (v >> 8) as u8, v as u8])
}

pub(crate) fn read(bytes: &[u8]) -> Result<Pattern, Error> {
    if bytes.len() < 3 {
        return Err(Error::Malformed("DST file too short".into()));
    }
    let mut raw = RawPattern::new();
    read_header(bytes, &mut raw);
    read_stitches(bytes.get(HEADER_SIZE..).unwrap_or(&[]), &mut raw);
    Ok(raw.finish())
}

/// pystitch `dst_read_header`: name and `TC` thread lines of the 512-byte header
/// (also used by DSB and DSZ).
pub(crate) fn read_header(bytes: &[u8], raw: &mut RawPattern) {
    let header = &bytes[..bytes.len().min(HEADER_SIZE)];
    for line in header.split(|&b| b == b'\r' || b == b'\n') {
        let Ok(line) = std::str::from_utf8(line) else {
            continue;
        };
        let line = line.trim();
        if line.len() <= 3 || !line.is_char_boundary(2) || !line.is_char_boundary(3) {
            continue;
        }
        let (prefix, value) = (line[..2].trim(), line[3..].trim());
        match prefix {
            "LA" => raw.name = value.to_string(),
            "TC" => {
                let parts: Vec<&str> = value.split(',').map(str::trim).collect();
                if let Some(rgb) = parts.first().and_then(|h| parse_hex(h)) {
                    raw.threads.push(Thread {
                        rgb,
                        name: parts.get(1).unwrap_or(&"").to_string(),
                        code: parts.get(2).unwrap_or(&"").to_string(),
                        brand: String::new(),
                    });
                }
            }
            _ => {}
        }
    }
}

/// pystitch `dst_read_stitches`: the 3-byte records of `body`, then jump runs become trims
/// (also used by TAP and EXY).
pub(crate) fn read_stitches(body: &[u8], raw: &mut RawPattern) {
    let mut sequin_mode = false;
    for rec in body.as_chunks::<3>().0 {
        let (b0, b1, b2) = (rec[0], rec[1], rec[2]);
        let dx = decode_dx(b0, b1, b2);
        let dy = decode_dy(b0, b1, b2);
        if b2 & 0b1111_0011 == 0b1111_0011 {
            break;
        } else if b2 & 0b1100_0011 == 0b1100_0011 {
            raw.color_change();
            if dx != 0 || dy != 0 {
                raw.jump(dx, dy);
            }
        } else if b2 & 0b0100_0011 == 0b0100_0011 {
            // Sequin mode toggle: no sequin support, keep the displacement.
            sequin_mode = !sequin_mode;
            if dx != 0 || dy != 0 {
                raw.jump(dx, dy);
            }
        } else if b2 & 0b1000_0011 == 0b1000_0011 {
            if sequin_mode {
                raw.stitch(dx, dy); // sequin eject is a penetration
            } else {
                raw.jump(dx, dy);
            }
        } else {
            raw.stitch(dx, dy);
        }
    }
    raw.interpolate_trims(Some(TRIM_AT), None, true);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{cmd, Stitch};

    #[test]
    fn ternary_encoding_known_values() {
        // Values derived by hand from pystitch's DstWriter.encode_record.
        assert_eq!(encode_record(1, 0, Kind::Stitch), [0x01, 0x00, 0x03]);
        assert_eq!(encode_record(-1, 0, Kind::Stitch), [0x02, 0x00, 0x03]);
        // y down +1 is y up -1: b0 bit 6.
        assert_eq!(encode_record(0, 1, Kind::Stitch), [0x40, 0x00, 0x03]);
        assert_eq!(encode_record(13, 0, Kind::Stitch), [0x05, 0x01, 0x03]);
        assert_eq!(encode_record(121, 0, Kind::Stitch), [0x05, 0x05, 0x07]);
        assert_eq!(encode_record(-121, 0, Kind::Stitch), [0x0A, 0x0A, 0x0B]);
        // y down -50 => y up +50 = 81 - 27 - 3 - 1.
        assert_eq!(encode_record(0, -50, Kind::Stitch), [0x40, 0x50, 0x23]);
        assert_eq!(encode_record(0, 0, Kind::Jump), [0x00, 0x00, 0x83]);
        assert_eq!(encode_record(2, -2, Kind::Jump), [0x42, 0x81, 0x83]);
        assert_eq!(encode_record(0, 0, Kind::ColorChange), [0x00, 0x00, 0xC3]);
        assert_eq!(encode_record(0, 0, Kind::End), [0x00, 0x00, 0xF3]);
    }

    #[test]
    fn ternary_roundtrip_all_deltas() {
        for dx in -121..=121 {
            for dy in [-121, -77, -40, -13, -4, -1, 0, 1, 5, 14, 41, 100, 121] {
                let b = encode_record(dx, dy, Kind::Stitch);
                assert_eq!(decode_dx(b[0], b[1], b[2]), dx);
                assert_eq!(decode_dy(b[0], b[1], b[2]), dy);
                let b = encode_record(dy, dx, Kind::Jump);
                assert_eq!(decode_dx(b[0], b[1], b[2]), dy);
                assert_eq!(decode_dy(b[0], b[1], b[2]), dx);
                assert_eq!(b[2] & 0x83, 0x83);
            }
        }
    }

    #[test]
    fn header_fields() {
        let p = Pattern {
            stitches: vec![
                Stitch::new(-5.0, -3.0, 0),
                Stitch::new(5.0, -3.0, 0),
                Stitch::new(5.0, 4.0, 0),
                Stitch::new(5.0, 4.0, cmd::COLOR_CHANGE),
                Stitch::new(-2.0, 4.0, 0),
                Stitch::new(-2.0, 4.0, cmd::END),
            ],
            threads: vec![],
            name: "Test design".into(),
        };
        let bytes = write(&p, &WriteOptions::default()).unwrap();
        assert_eq!(bytes.len() % 3, 512 % 3);
        let h = &bytes[..512];
        let text = String::from_utf8_lossy(h);
        let lines: Vec<&str> = text.split('\r').collect();
        assert_eq!(lines[0], "LA:Test design     ");
        // records (Ink/Stitch's full jump: a jump to the exact point before the
        // first stitch of a block): jump(-50,-30), stitch(0,0), stitch(100,0),
        // stitch(0,70), color change, jump(-70,0), stitch(0,0), end => 8.
        assert_eq!(lines[1], "ST:      8");
        assert_eq!(lines[2], "CO:  1");
        assert_eq!(lines[3], "+X:   50");
        assert_eq!(lines[4], "-X:   50");
        assert_eq!(lines[5], "+Y:   40");
        assert_eq!(lines[6], "-Y:   30");
        assert_eq!(lines[7], "AX:-   20");
        assert_eq!(lines[8], "AY:-   40");
        assert_eq!(lines[9], "MX:+    0");
        assert_eq!(lines[10], "MY:+    0");
        assert_eq!(lines[11], "PD:******");
        assert_eq!(lines[12].as_bytes()[0], 0x1A);
        assert!(h[h.iter().position(|&b| b == 0x1A).unwrap() + 1..]
            .iter()
            .all(|&b| b == b' '));
        assert_eq!(&bytes[bytes.len() - 3..], &[0, 0, 0xF3]);
    }

    #[test]
    fn trim_is_three_jumps() {
        let p = Pattern {
            stitches: vec![
                Stitch::new(0.0, 0.0, 0),
                Stitch::new(1.0, 0.0, 0),
                Stitch::new(1.0, 0.0, cmd::TRIM),
                Stitch::new(3.0, 0.0, cmd::JUMP),
                Stitch::new(3.0, 0.0, 0),
            ],
            ..Default::default()
        };
        let bytes = write(&p, &WriteOptions::default()).unwrap();
        let body = &bytes[512..];
        // stitch(0,0), stitch(10,0), 3 trim jumps, jump(20,0), stitch(0,0), end
        assert_eq!(body.len(), 8 * 3);
        assert_eq!(&body[6..9], &encode_record(2, 2, Kind::Jump));
        assert_eq!(&body[9..12], &encode_record(-4, -4, Kind::Jump));
        assert_eq!(&body[12..15], &encode_record(2, 2, Kind::Jump));
        let back = read(&bytes).unwrap();
        let flags: Vec<u8> = back.stitches.iter().map(|s| s.flags).collect();
        assert_eq!(flags, vec![0, 0, cmd::TRIM, cmd::JUMP, 0, cmd::END]);
    }
}
