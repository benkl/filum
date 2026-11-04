//! Tajima TBF reader/writer.
//!
//! Ported from pystitch, Ink/Stitch's embroidery file library (MIT, Copyright (c) 2018 Tatarize
//! and the Ink/Stitch contributors)
//! (`TbfWriter.py`, `TbfReader.py`).
//!
//! A 0x600-byte DST-like text header with the needle order (`DO`) and the exact thread
//! colours (`DA`), then 3-byte records: signed 8-bit deltas in 0.1 mm (y up) and a
//! command byte. Colours are needle sets; trims are explicit.

use crate::encoder::{encode_with, Cmd, EncodeSettings, Encoded, ThreadChange};
use crate::io::ByteWriter;
use crate::raw::RawPattern;
use crate::{Error, Pattern, Thread, WriteOptions};

/// pystitch writer limits; Ink/Stitch writes every format with `full_jump`.
pub(crate) const SETTINGS: EncodeSettings = EncodeSettings {
    max_stitch: 127,
    max_jump: 127,
    full_jump: true,
};
pub(crate) const THREAD_CHANGE: ThreadChange = ThreadChange {
    needle_set: true,
    explicit_trim: true,
};
/// pystitch's default `needle_count`: needles are assigned 1, 2, …, 5, 1, …
pub(crate) const NEEDLE_COUNT: usize = 5;
const HEADER_SIZE: usize = 0x600;
const THREAD_ORDER_AT: usize = 0x10A;
const THREADS_AT: usize = 0x20E;
const THREADS_END: usize = 0x376;

/// Needle (1-based) for the `k`-th needle set.
pub(crate) fn needle(k: usize) -> u8 {
    (k % NEEDLE_COUNT + 1) as u8
}

pub(crate) fn encode(p: &Pattern, opts: &WriteOptions) -> Encoded {
    encode_with(p, SETTINGS, opts.long_stitch_as_jumps, THREAD_CHANGE)
}

/// Header-safe label: ASCII printable, exactly 16 characters wide (the header offsets
/// depend on it).
fn label(name: &str) -> String {
    let n: String = name.chars().filter(|c| c.is_ascii() && !c.is_ascii_control()).take(16).collect();
    if n.trim().is_empty() {
        "Untitled".into()
    } else {
        n
    }
}

pub(crate) fn write(p: &Pattern, opts: &WriteOptions) -> Vec<u8> {
    let e = encode(p, opts);
    let (min_x, min_y, max_x, max_y) = e.bounds();
    let mut out = Vec::new();
    out.str("3.00");
    out.fill(b' ', 0x80 - out.len());
    out.str(&format!("LA:{:<16}\r", label(&e.name)));
    out.str(&format!("ST:{:>7}\r", e.recs.len()));
    out.str(&format!("CO:{:>3}\r", e.count(Cmd::ColorChange)));
    out.str(&format!("+X:{:>5}\r", max_x.abs()));
    out.str(&format!("-X:{:>5}\r", min_x.abs()));
    out.str(&format!("+Y:{:>5}\r", max_y.abs()));
    out.str(&format!("-Y:{:>5}\r", min_y.abs()));
    let (ax, ay) = e.recs.last().map_or((0, 0), |r| (r.x, -r.y));
    out.str(&format!("AX:{}{:>5}\r", if ax >= 0 { '+' } else { '-' }, ax.abs()));
    out.str(&format!("AY:{}{:>5}\r", if ay >= 0 { '+' } else { '-' }, ay.abs()));
    out.str(&format!("TP:{:<32}\r", "EG/"));
    out.str("JC:3\r");
    // DO: the needle of every needle set.
    out.str("DO:");
    let mut order = [0u8; 0x100];
    for (k, slot) in order.iter_mut().enumerate().take(e.count(Cmd::ColorChange)) {
        *slot = needle(k);
    }
    out.extend_from_slice(&order);
    out.str("\r");
    // DA: the thread list.
    out.str("DA:");
    debug_assert_eq!(out.len(), THREADS_AT);
    for t in e.threads.iter().take((THREADS_END - THREADS_AT) / 5) {
        out.u8(0x45);
        out.extend_from_slice(&t.rgb);
        out.u8(0x20);
    }
    out.fill(b' ', THREADS_END.saturating_sub(out.len()));
    out.extend_from_slice(&[0x0D, 0x1A]);
    out.fill(b' ', HEADER_SIZE - out.len());

    let (mut xx, mut yy) = (0, 0);
    for r in &e.recs {
        let dx = r.x - xx;
        let dy = r.y - yy;
        xx = r.x;
        yy = r.y;
        let c = match r.cmd {
            Cmd::Stitch => 0x80,
            Cmd::Jump => 0x90,
            Cmd::Stop => 0x40,
            Cmd::Trim => 0x86,
            Cmd::ColorChange => 0x81,
            Cmd::End => 0x8F,
        };
        out.i8(dx);
        out.i8(-dy);
        out.u8(c);
        if r.cmd == Cmd::End {
            break;
        }
    }
    out.u8(0x1A);
    out
}

pub(crate) fn read(bytes: &[u8]) -> Result<Pattern, Error> {
    if bytes.len() < HEADER_SIZE {
        return Err(Error::Malformed("TBF file too short".into()));
    }
    let mut raw = RawPattern::new();
    raw.name = String::from_utf8_lossy(&bytes[0x83..0x93]).trim().to_string();
    let order = &bytes[THREAD_ORDER_AT..THREAD_ORDER_AT + 0x100];
    let mut i = THREADS_AT;
    while i + 5 <= bytes.len() && bytes[i] == 0x45 {
        raw.threads.push(Thread::from_rgb([bytes[i + 1], bytes[i + 2], bytes[i + 3]]));
        i += 5;
    }
    let mut needle = 0usize;
    for rec in bytes[HEADER_SIZE..].as_chunks::<3>().0 {
        let (x, y) = (rec[0] as i8 as i32, -(rec[1] as i8 as i32));
        match rec[2] {
            0x80 => raw.stitch(x, y),
            0x81 => {
                let value = order.get(needle).copied().unwrap_or(0);
                needle += 1;
                if value == 0 {
                    // needle 0 should not exist; pystitch reads it as a stop
                    raw.stop();
                } else {
                    raw.needle_change();
                }
            }
            0x90 => {
                if x == 0 && y == 0 {
                    raw.trim();
                } else {
                    raw.jump(x, y);
                }
            }
            0x40 => raw.stop(),
            0x86 => raw.trim(),
            _ => break, // 0x8F end
        }
    }
    Ok(raw.finish())
}
