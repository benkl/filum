//! Human-readable CSV debug dump (write only).
//!
//! Layout modelled on pystitch's `CsvWriter.py` (Ink/Stitch; MIT, Copyright (c) 2018 Tatarize):
//! `>` summary rows, `$` thread rows and `*` stitch rows. Unlike the binary writers the
//! pattern is dumped as-is (millimetres, y down, no encoding), like pystitch's
//! `ENCODE = False`.

use crate::{cmd, Pattern};

fn row(out: &mut String, values: &[&str]) {
    let cells: Vec<String> = values
        .iter()
        .map(|v| format!("\"{}\"", v.replace('"', "\"\"")))
        .collect();
    out.push_str(&cells.join(","));
    out.push('\n');
}

/// Name of a flag combination, e.g. `STITCH`, `JUMP`, `STITCH|UNDERLAY`.
pub(crate) fn flag_name(flags: u8) -> String {
    let mut parts: Vec<&str> = Vec::new();
    let names = [
        (cmd::JUMP, "JUMP"),
        (cmd::TRIM, "TRIM"),
        (cmd::COLOR_CHANGE, "COLOR_CHANGE"),
        (cmd::STOP, "STOP"),
        (cmd::END, "END"),
    ];
    for (bit, name) in names {
        if flags & bit != 0 {
            parts.push(name);
        }
    }
    if parts.is_empty() {
        parts.push("STITCH");
    }
    for (bit, name) in [
        (cmd::TIE, "TIE"),
        (cmd::UNDERLAY, "UNDERLAY"),
        (cmd::TRAVEL, "TRAVEL"),
    ] {
        if flags & bit != 0 {
            parts.push(name);
        }
    }
    parts.join("|")
}

pub(crate) fn write(p: &Pattern) -> Vec<u8> {
    let mut out = String::new();
    let (mut min_x, mut min_y, mut max_x, mut max_y) = (0.0f64, 0.0f64, 0.0f64, 0.0f64);
    if let Some(f) = p.stitches.first() {
        (min_x, min_y, max_x, max_y) = (f.x, f.y, f.x, f.y);
    }
    for s in &p.stitches {
        min_x = min_x.min(s.x);
        min_y = min_y.min(s.y);
        max_x = max_x.max(s.x);
        max_y = max_y.max(s.y);
    }
    let count = |bit: u8| p.stitches.iter().filter(|s| s.flags & bit != 0).count();
    let penetrations = p.stitches.iter().filter(|s| s.is_penetration()).count();

    row(&mut out, &["#", "[VAR_NAME]", "[VAR_VALUE]"]);
    let vars: Vec<(&str, String)> = vec![
        ("NAME:", p.name.clone()),
        ("STITCH_COUNT:", p.stitches.len().to_string()),
        ("THREAD_COUNT:", p.threads.len().to_string()),
        ("EXTENTS_LEFT:", format!("{min_x:.2}")),
        ("EXTENTS_TOP:", format!("{min_y:.2}")),
        ("EXTENTS_RIGHT:", format!("{max_x:.2}")),
        ("EXTENTS_BOTTOM:", format!("{max_y:.2}")),
        ("EXTENTS_WIDTH:", format!("{:.2}", max_x - min_x)),
        ("EXTENTS_HEIGHT:", format!("{:.2}", max_y - min_y)),
        ("COMMAND_STITCH", penetrations.to_string()),
        ("COMMAND_JUMP", count(cmd::JUMP).to_string()),
        ("COMMAND_TRIM", count(cmd::TRIM).to_string()),
        ("COMMAND_COLOR_CHANGE", count(cmd::COLOR_CHANGE).to_string()),
        ("COMMAND_STOP", count(cmd::STOP).to_string()),
        ("COMMAND_END", count(cmd::END).to_string()),
    ];
    for (k, v) in &vars {
        row(&mut out, &[">", k, v]);
    }
    out.push('\n');

    if !p.threads.is_empty() {
        row(
            &mut out,
            &[
                "#",
                "[THREAD_NUMBER]",
                "[HEX_COLOR]",
                "[DESCRIPTION]",
                "[BRAND]",
                "[CATALOG_NUMBER]",
            ],
        );
        for (i, t) in p.threads.iter().enumerate() {
            row(
                &mut out,
                &["$", &i.to_string(), &t.hex(), &t.name, &t.brand, &t.code],
            );
        }
        out.push('\n');
    }

    if !p.stitches.is_empty() {
        row(
            &mut out,
            &[
                "#",
                "[STITCH_INDEX]",
                "[STITCH_TYPE]",
                "[X]",
                "[Y]",
                "[DX]",
                "[DY]",
            ],
        );
        let (mut cx, mut cy) = (0.0, 0.0);
        for (i, s) in p.stitches.iter().enumerate() {
            row(
                &mut out,
                &[
                    "*",
                    &i.to_string(),
                    &flag_name(s.flags),
                    &format!("{:.3}", s.x),
                    &format!("{:.3}", s.y),
                    &format!("{:.3}", s.x - cx),
                    &format!("{:.3}", s.y - cy),
                ],
            );
            cx = s.x;
            cy = s.y;
        }
    }
    out.into_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Stitch, Thread};

    #[test]
    fn dump_contains_rows() {
        let p = Pattern {
            stitches: vec![
                Stitch::new(1.0, 2.0, cmd::UNDERLAY),
                Stitch::new(1.0, 2.0, cmd::END),
            ],
            threads: vec![Thread::from_rgb([255, 0, 0])],
            name: "x".into(),
        };
        let s = String::from_utf8(write(&p)).unwrap();
        assert!(s.contains("\"$\",\"0\",\"#ff0000\""));
        assert!(s.contains("\"*\",\"0\",\"STITCH|UNDERLAY\",\"1.000\",\"2.000\""));
        assert!(s.contains("\"*\",\"1\",\"END\""));
    }
}
