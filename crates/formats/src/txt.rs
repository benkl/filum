//! Plain-text stitch list (write only).
//!
//! Ported from pystitch, Ink/Stitch's embroidery file library (MIT, Copyright (c) 2018 Tatarize
//! and the Ink/Stitch contributors)
//! (`TxtWriter.py`, the default variant).
//!
//! One line per encoded record: `x,y color:C command:NAME flags:N` with x, y in 0.1 mm
//! (y down), C the thread colour as a decimal `0xRRGGBB` and N pystitch's command number.
//! pystitch never advances the colour after a colour change; here it does.

use crate::encoder::{encode, Cmd, UNLIMITED};
use crate::Pattern;

/// pystitch command name and number.
pub(crate) fn command(c: Cmd) -> (&'static str, u8) {
    match c {
        Cmd::Stitch => ("STITCH", 0),
        Cmd::Jump => ("JUMP", 1),
        Cmd::Trim => ("TRIM", 2),
        Cmd::Stop => ("STOP", 3),
        Cmd::End => ("END", 4),
        Cmd::ColorChange => ("COLOR_CHANGE", 5),
    }
}

pub(crate) fn write(p: &Pattern) -> Vec<u8> {
    let e = encode(p, UNLIMITED, false);
    let color = |i: usize| {
        let [r, g, b] = e.thread(i).rgb;
        (r as u32) << 16 | (g as u32) << 8 | b as u32
    };
    let mut block = 0;
    let mut out = String::new();
    for r in &e.recs {
        if r.cmd == Cmd::ColorChange {
            block += 1;
        }
        let (name, n) = command(r.cmd);
        out += &format!("{:.1},{:.1} color:{} command:{} flags:{}\n", r.x as f64, r.y as f64, color(block), name, n);
    }
    out.into_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{cmd, Stitch, Thread};

    #[test]
    fn lines() {
        let p = Pattern {
            stitches: vec![
                Stitch::new(0.0, 0.0, 0),
                Stitch::new(1.0, 0.5, 0),
                Stitch::new(1.0, 0.5, cmd::TRIM | cmd::COLOR_CHANGE),
                Stitch::new(2.0, 0.5, 0),
            ],
            threads: vec![Thread::from_rgb([255, 0, 0]), Thread::from_rgb([0, 0, 255])],
            name: String::new(),
        };
        let s = String::from_utf8(write(&p)).unwrap();
        let lines: Vec<&str> = s.lines().collect();
        assert_eq!(lines[0], "0.0,0.0 color:16711680 command:STITCH flags:0");
        assert_eq!(lines[1], "10.0,5.0 color:16711680 command:STITCH flags:0");
        assert_eq!(lines[2], "10.0,5.0 color:16711680 command:TRIM flags:2");
        assert_eq!(lines[3], "10.0,5.0 color:255 command:COLOR_CHANGE flags:5");
        assert_eq!(lines[4], "20.0,5.0 color:255 command:JUMP flags:1");
        assert_eq!(lines[5], "20.0,5.0 color:255 command:STITCH flags:0");
        assert_eq!(lines[6], "20.0,5.0 color:255 command:END flags:4");
    }
}
