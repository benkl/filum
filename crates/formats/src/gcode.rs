//! G-code for DIY embroidery machines (write only).
//!
//! Ported from pystitch, Ink/Stitch's embroidery file library (MIT, Copyright (c) 2018 Tatarize
//! and the Ink/Stitch contributors)
//! (`InkstitchGcodeWriter.py`, the writer Ink/Stitch uses for `.gcode`), with Ink/Stitch's
//! default output parameters (`templates/output_params_gcode.xml`): coordinates not negated,
//! the Z axis alternating between 0 and 1 per stitch, no custom commands, no laser mode.
//!
//! Each stitch is a `G0 X… Y…` move (millimetres, absolute, y down as in the design)
//! followed by a Z move that turns the machine's hand wheel; colour changes and stops
//! pause with `M00`. pystitch writes the stop move in 0.1 mm; here it is in millimetres.

use crate::encoder::{encode, Cmd, UNLIMITED};
use crate::Pattern;

pub(crate) fn write(p: &Pattern) -> Vec<u8> {
    let e = encode(p, UNLIMITED, false);
    let (min_x, min_y, max_x, max_y) = e.bounds();
    let mm = |v: i32| v as f64 / 10.0;
    let mut s = String::new();
    s += &format!("(STITCH_COUNT:{})\r\n", e.recs.len());
    s += &format!("(EXTENTS_LEFT:{:.3})\r\n", mm(min_x));
    s += &format!("(EXTENTS_TOP:{:.3})\r\n", mm(min_y));
    s += &format!("(EXTENTS_RIGHT:{:.3})\r\n", mm(max_x));
    s += &format!("(EXTENTS_BOTTOM:{:.3})\r\n", mm(max_y));
    s += &format!("(EXTENTS_WIDTH:{:.3})\r\n", mm(max_x - min_x));
    s += &format!("(EXTENTS_HEIGHT:{:.3})\r\n", mm(max_y - min_y));
    s += "\r\n";
    s += "G90 (use absolute coordinates)\r\n";
    s += "G21 (coordinates will be specified in millimeters)\r\n";
    s += "G0 X0.0 Y0.0\r\n";
    s += "\r\n";
    let mut z = 0;
    for r in &e.recs {
        match r.cmd {
            Cmd::Stitch => {
                s += &format!("G0 X{:.3} Y{:.3}\r\n", mm(r.x), mm(r.y));
                s += &format!("G0 Z{z:.1}\r\n", z = z as f64);
                z = 1 - z;
            }
            Cmd::ColorChange => s += "M00\r\n",
            Cmd::Stop => {
                s += &format!("G0 X{:.3} Y{:.3}\r\n", mm(r.x), mm(r.y));
                s += "M00\r\n";
            }
            // jumps are ignored by default, trims and the end are not commands
            Cmd::Jump | Cmd::Trim | Cmd::End => {}
        }
    }
    s += "\r\n";
    s += "G0 X0.0 Y0.0\r\n";
    s += "M30\r\n";
    s.into_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{cmd, Stitch};

    #[test]
    fn program() {
        let p = Pattern {
            stitches: vec![
                Stitch::new(0.0, 0.0, 0),
                Stitch::new(1.5, -2.0, 0),
                Stitch::new(1.5, -2.0, cmd::COLOR_CHANGE),
                Stitch::new(3.0, 0.0, 0),
            ],
            ..Default::default()
        };
        let s = String::from_utf8(write(&p)).unwrap();
        let expected = "(STITCH_COUNT:6)\r\n(EXTENTS_LEFT:0.000)\r\n(EXTENTS_TOP:-2.000)\r\n(EXTENTS_RIGHT:3.000)\r\n(EXTENTS_BOTTOM:0.000)\r\n\
(EXTENTS_WIDTH:3.000)\r\n(EXTENTS_HEIGHT:2.000)\r\n\r\nG90 (use absolute coordinates)\r\nG21 (coordinates will be specified in millimeters)\r\n\
G0 X0.0 Y0.0\r\n\r\nG0 X0.000 Y0.000\r\nG0 Z0.0\r\nG0 X1.500 Y-2.000\r\nG0 Z1.0\r\nM00\r\nG0 X3.000 Y0.000\r\nG0 Z0.0\r\n\r\nG0 X0.0 Y0.0\r\nM30\r\n";
        assert_eq!(s, expected);
    }
}
