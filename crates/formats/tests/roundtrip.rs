use filum_formats::palette::{nearest_jef_index, nearest_pec_index, JEF_PALETTE, PEC_PALETTE};
use filum_formats::*;

const RED: [u8; 3] = [220, 30, 45];
const GREEN: [u8; 3] = [30, 150, 60];
const BLUE: [u8; 3] = [25, 60, 190];

fn s(x: f64, y: f64, flags: u8) -> Stitch {
    Stitch { x, y, flags }
}

/// ~200 stitches, 3 colours, a long stitch (18 mm), a trim + long jump (~42 mm).
fn test_pattern() -> Pattern {
    let mut st = Vec::new();
    // Block 1: zigzag with fractional coordinates.
    let (mut x, y0) = (-25.03, -12.37);
    for i in 0..60 {
        let y = y0 + if i % 2 == 0 { 0.0 } else { 3.13 };
        st.push(s(x, y, if i < 3 { cmd::TIE } else { 0 }));
        x += 0.41;
    }
    // Long stitch (> 15 mm in x, must be split by every format but PES/PEC/VP3).
    let last = *st.last().unwrap();
    st.push(s(last.x + 18.26, last.y + 2.04, 0));
    let last = *st.last().unwrap();
    st.push(s(last.x + 0.5, last.y + 0.5, 0));
    // Trim + long jump (> 30 mm).
    let last = *st.last().unwrap();
    st.push(s(last.x, last.y, cmd::TRIM));
    st.push(s(last.x - 12.0, last.y + 40.17, cmd::JUMP));
    let (mut x, y0) = (last.x - 12.0, last.y + 40.17);
    for i in 0..30 {
        st.push(s(x, y0 - (i % 3) as f64 * 0.77, cmd::UNDERLAY));
        x -= 0.63;
    }
    // Block 2.
    let last = *st.last().unwrap();
    st.push(s(last.x, last.y, cmd::COLOR_CHANGE));
    let (mut x, mut y) = (last.x + 4.44, last.y - 6.66);
    for i in 0..60 {
        st.push(s(x, y, 0));
        x += if i % 2 == 0 { 2.35 } else { -1.9 };
        y -= 0.29;
    }
    // Block 3 (no explicit jump: the writer must insert it).
    let last = *st.last().unwrap();
    st.push(s(last.x, last.y, cmd::COLOR_CHANGE));
    let (cx, cy) = (8.0, -4.0);
    for i in 0..55 {
        let a = i as f64 * 0.35;
        let r = 3.0 + i as f64 * 0.12;
        st.push(s(cx + r * a.cos(), cy + r * a.sin(), 0));
    }
    let last = *st.last().unwrap();
    st.push(s(last.x, last.y, cmd::END));
    Pattern {
        stitches: st,
        threads: vec![
            Thread {
                rgb: RED,
                name: "Red".into(),
                code: "R1".into(),
                brand: "Test".into(),
            },
            Thread {
                rgb: GREEN,
                name: "Green".into(),
                code: "G1".into(),
                brand: "Test".into(),
            },
            Thread {
                rgb: BLUE,
                name: "Blue".into(),
                code: "B1".into(),
                brand: "Test".into(),
            },
        ],
        name: "roundtrip".into(),
    }
}

/// PEC (and PES) stitch streams start at the top-left corner of the design
/// (Ink/Stitch / pystitch): read back, the design spans from (0, 0). Move it
/// back onto the original for comparisons; other formats keep positions.
fn aligned(format: Format, orig: &Pattern, mut back: Pattern) -> Pattern {
    if matches!(format, Format::Pes | Format::Pec) {
        let min = |p: &Pattern| {
            p.stitches.iter().fold((f64::INFINITY, f64::INFINITY), |m, s| (m.0.min(s.x), m.1.min(s.y)))
        };
        let (o, b) = (min(orig), min(&back));
        for st in &mut back.stitches {
            st.x += o.0 - b.0;
            st.y += o.1 - b.1;
        }
    }
    back
}

fn penetrations(p: &Pattern) -> Vec<(f64, f64)> {
    p.stitches
        .iter()
        .filter(|s| s.is_penetration())
        .map(|s| (s.x, s.y))
        .collect()
}

fn dist(a: (f64, f64), b: (f64, f64)) -> f64 {
    ((a.0 - b.0).powi(2) + (a.1 - b.1).powi(2)).sqrt()
}

fn dist_to_segment(p: (f64, f64), a: (f64, f64), b: (f64, f64)) -> f64 {
    let (dx, dy) = (b.0 - a.0, b.1 - a.1);
    let len2 = dx * dx + dy * dy;
    if len2 == 0.0 {
        return dist(p, a);
    }
    let t = (((p.0 - a.0) * dx + (p.1 - a.1) * dy) / len2).clamp(0.0, 1.0);
    dist(p, (a.0 + t * dx, a.1 + t * dy))
}

/// Every original penetration appears in order (within `tol`), and every extra
/// penetration lies on the original polyline between its matched neighbours.
fn assert_penetrations_match(format: Format, orig: &[(f64, f64)], read: &[(f64, f64)], tol: f64) {
    let mut matched = Vec::with_capacity(orig.len());
    let mut j = 0;
    for (k, &p) in orig.iter().enumerate() {
        while j < read.len() && dist(read[j], p) > tol {
            j += 1;
        }
        assert!(
            j < read.len(),
            "{format:?}: original penetration #{k} {p:?} not found in order"
        );
        matched.push(j);
        j += 1;
    }
    assert_eq!(
        matched[0], 0,
        "{format:?}: unexpected penetrations before the first one"
    );
    for k in 0..orig.len() - 1 {
        for r in &read[matched[k] + 1..matched[k + 1]] {
            let d = dist_to_segment(*r, orig[k], orig[k + 1]);
            assert!(
                d <= tol,
                "{format:?}: extra penetration {r:?} is {d} mm off segment #{k}"
            );
        }
    }
    assert_eq!(
        matched[orig.len() - 1],
        read.len() - 1,
        "{format:?}: trailing extra penetrations"
    );
}

fn check_roundtrip(format: Format, opts: &WriteOptions) -> Pattern {
    let p = test_pattern();
    let bytes =
        write_with_options(&p, format, opts).unwrap_or_else(|e| panic!("{format:?} write: {e}"));
    let back = aligned(format, &p, read(&bytes, format).unwrap_or_else(|e| panic!("{format:?} read: {e}")));

    let orig = penetrations(&p);
    let got = penetrations(&back);
    assert!(orig.len() >= 200);
    // VP3 block positions are truncated from a half-unit centre, as pystitch
    // (Ink/Stitch) writes them: one more 0.1 mm unit on each axis at most
    let tol = if format == Format::Vp3 { 0.25 } else { 0.1 };
    assert_penetrations_match(format, &orig, &got, tol);

    let blocks = 1 + back
        .stitches
        .iter()
        .filter(|s| s.flags & cmd::COLOR_CHANGE != 0)
        .count();
    assert_eq!(blocks, 3, "{format:?}: colour block count");
    assert_eq!(back.threads.len(), 3, "{format:?}: thread count");
    // SEW has no trim command (pystitch writes a zero jump)
    assert!(
        format == Format::Sew || back.stitches.iter().any(|s| s.flags & cmd::TRIM != 0),
        "{format:?}: trim lost"
    );
    assert_eq!(
        back.stitches.last().unwrap().flags,
        cmd::END,
        "{format:?}: final END"
    );
    assert_eq!(
        back.stitches
            .iter()
            .filter(|s| s.flags & cmd::END != 0)
            .count(),
        1
    );

    // Long stitches and jumps were split to the format's maximum per-record delta.
    let max = match format {
        Format::Dst => Some(12.1),
        Format::Jef | Format::Exp | Format::U01 | Format::Tbf | Format::Sew => Some(12.7),
        Format::Xxx => Some(12.4),
        _ => None,
    };
    if let Some(max) = max {
        let mut prev = (0.0, 0.0);
        for s in &back.stitches {
            let (dx, dy) = ((s.x - prev.0).abs(), (s.y - prev.1).abs());
            assert!(
                dx <= max + 1e-9 && dy <= max + 1e-9,
                "{format:?}: record delta {dx},{dy} > {max}"
            );
            prev = (s.x, s.y);
        }
        assert!(
            penetrations(&back).len() > orig.len(),
            "{format:?}: long stitch was not split"
        );
    }

    // Command records do not move.
    let mut pos = (0.0, 0.0);
    for s in &back.stitches {
        if s.flags & (cmd::TRIM | cmd::COLOR_CHANGE | cmd::STOP | cmd::END) != 0 {
            assert!(
                dist(pos, (s.x, s.y)) < 1e-9,
                "{format:?}: command record moved"
            );
        }
        pos = (s.x, s.y);
    }
    back
}

#[test]
fn roundtrip_dst() {
    let back = check_roundtrip(Format::Dst, &WriteOptions::default());
    assert_eq!(back.name, "roundtrip");
    // No colours in DST: distinct synthesized threads.
    assert_ne!(back.threads[0].rgb, back.threads[1].rgb);
    assert_ne!(back.threads[1].rgb, back.threads[2].rgb);
}

#[test]
fn roundtrip_exp() {
    let back = check_roundtrip(Format::Exp, &WriteOptions::default());
    assert_ne!(back.threads[0].rgb, back.threads[1].rgb);
}

fn pec_rgb(c: [u8; 3]) -> [u8; 3] {
    PEC_PALETTE[nearest_pec_index(c) - 1].0
}

fn jef_rgb(c: [u8; 3]) -> [u8; 3] {
    JEF_PALETTE[nearest_jef_index(c) - 1].0
}

#[test]
fn roundtrip_pes() {
    let back = check_roundtrip(Format::Pes, &WriteOptions::default());
    let rgbs: Vec<[u8; 3]> = back.threads.iter().map(|t| t.rgb).collect();
    assert_eq!(rgbs, vec![pec_rgb(RED), pec_rgb(GREEN), pec_rgb(BLUE)]);
    assert_eq!(back.threads[0].brand, "Brother");
    assert!(!back.threads[0].name.is_empty());
}

#[test]
fn roundtrip_pec() {
    let back = check_roundtrip(Format::Pec, &WriteOptions::default());
    let rgbs: Vec<[u8; 3]> = back.threads.iter().map(|t| t.rgb).collect();
    assert_eq!(rgbs, vec![pec_rgb(RED), pec_rgb(GREEN), pec_rgb(BLUE)]);
    assert_eq!(back.name, "roundtri"); // PEC labels hold 8 characters
}

#[test]
fn roundtrip_jef() {
    let opts = WriteOptions {
        date: Some("20240102030405".into()),
        ..Default::default()
    };
    let back = check_roundtrip(Format::Jef, &opts);
    let rgbs: Vec<[u8; 3]> = back.threads.iter().map(|t| t.rgb).collect();
    assert_eq!(rgbs, vec![jef_rgb(RED), jef_rgb(GREEN), jef_rgb(BLUE)]);
    assert_eq!(back.threads[0].brand, "Janome");
}

#[test]
fn roundtrip_vp3() {
    let back = check_roundtrip(Format::Vp3, &WriteOptions::default());
    let p = test_pattern();
    assert_eq!(back.threads, p.threads, "VP3 embeds full thread info");
}

#[test]
fn roundtrip_xxx() {
    let back = check_roundtrip(Format::Xxx, &WriteOptions::default());
    let rgbs: Vec<[u8; 3]> = back.threads.iter().map(|t| t.rgb).collect();
    assert_eq!(rgbs, vec![RED, GREEN, BLUE]);
}

#[test]
fn roundtrip_long_stitch_as_jumps() {
    // pystitch's default contingency: split long stitches with jumps, so the
    // penetrations are exactly the original ones.
    let opts = WriteOptions {
        long_stitch_as_jumps: true,
        ..Default::default()
    };
    for f in [
        Format::Dst,
        Format::Jef,
        Format::Exp,
        Format::Xxx,
        Format::Pes,
    ] {
        let p = test_pattern();
        let back = aligned(f, &p, read(&write_with_options(&p, f, &opts).unwrap(), f).unwrap());
        let (a, b) = (penetrations(&p), penetrations(&back));
        assert_eq!(a.len(), b.len(), "{f:?}");
        for (x, y) in a.iter().zip(&b) {
            assert!(dist(*x, *y) <= 0.1, "{f:?}");
        }
    }
}

#[test]
fn jef_header_and_max_delta() {
    let p = test_pattern();
    let opts = WriteOptions {
        date: Some("20240102030405".into()),
        ..Default::default()
    };
    let bytes = write_with_options(&p, Format::Jef, &opts).unwrap();
    let back = read(&bytes, Format::Jef).unwrap();
    let mut prev = (0.0, 0.0);
    for s in &back.stitches {
        assert!((s.x - prev.0).abs() <= 12.7 + 1e-9 && (s.y - prev.1).abs() <= 12.7 + 1e-9);
        prev = (s.x, s.y);
    }
    // The design is under 50 x 50 mm => hoop code 1 (HOOP_50X50), at offset 0x20.
    let xs = back.stitches.iter().map(|s| s.x);
    let ys = back.stitches.iter().map(|s| s.y);
    let w = xs.clone().fold(f64::MIN, f64::max) - xs.fold(f64::MAX, f64::min);
    let h = ys.clone().fold(f64::MIN, f64::max) - ys.fold(f64::MAX, f64::min);
    assert!(w < 50.0 && h < 50.0 && w > 30.0 && h > 30.0, "{w} x {h}");
    assert_eq!(u32::from_le_bytes(bytes[0x20..0x24].try_into().unwrap()), 1);
    // Half extents follow the hoop code.
    let half_w = i32::from_le_bytes(bytes[0x24..0x28].try_into().unwrap());
    assert!((half_w as f64 - w * 5.0).abs() <= 1.0);
    // A larger design picks a larger hoop.
    let big = Pattern {
        stitches: vec![
            s(-60.0, -50.0, 0),
            s(-60.0, 50.0, cmd::JUMP),
            s(60.0, 50.0, cmd::JUMP),
            s(60.0, 50.0, 0),
        ],
        ..Default::default()
    };
    let big_bytes = write_with_options(&big, Format::Jef, &opts).unwrap();
    assert_eq!(
        u32::from_le_bytes(big_bytes[0x20..0x24].try_into().unwrap()),
        3
    );
    assert_eq!(&bytes[8..22], b"20240102030405");
    // Three colour entries => stitch data starts at 0x74 + 3 * 8.
    assert_eq!(
        u32::from_le_bytes(bytes[0..4].try_into().unwrap()),
        0x74 + 24
    );
    assert_eq!(u32::from_le_bytes(bytes[24..28].try_into().unwrap()), 3);
}

#[test]
fn every_writable_format_handles_empty_and_degenerate_patterns() {
    let empty = Pattern::default();
    let one = Pattern {
        stitches: vec![s(1.0, 1.0, 0)],
        ..Default::default()
    };
    let commands_only = Pattern {
        stitches: vec![
            s(0.0, 0.0, cmd::COLOR_CHANGE),
            s(5.0, 5.0, cmd::JUMP),
            s(5.0, 5.0, cmd::END),
        ],
        ..Default::default()
    };
    for info in formats().iter().filter(|i| i.can_write) {
        for p in [&empty, &one, &commands_only] {
            let bytes = write(p, info.format).unwrap();
            if info.can_read {
                let back =
                    read(&bytes, info.format).unwrap_or_else(|e| panic!("{:?}: {e}", info.format));
                assert_eq!(back.stitches.last().map(|s| s.flags), Some(cmd::END));
                assert_eq!(
                    penetrations(&back).len(),
                    penetrations(p).len(),
                    "{:?}",
                    info.format
                );
            }
        }
    }
}

#[test]
fn readers_do_not_panic_on_garbage() {
    let p = test_pattern();
    let mut seed = 0x1234_5678u32;
    let mut rnd = || {
        seed ^= seed << 13;
        seed ^= seed >> 17;
        seed ^= seed << 5;
        seed
    };
    for info in formats().iter().filter(|i| i.can_read) {
        // read-only formats: mutate another format's file
        let good = write(&p, if info.can_write { info.format } else { Format::Dst }).unwrap();
        for _ in 0..200 {
            let mut bytes = good.clone();
            let len = (rnd() as usize) % (bytes.len() + 1);
            bytes.truncate(len);
            for _ in 0..8 {
                if !bytes.is_empty() {
                    let i = rnd() as usize % bytes.len();
                    bytes[i] = rnd() as u8;
                }
            }
            let _ = read(&bytes, info.format);
        }
        let _ = read(&[], info.format);
    }
}

#[test]
fn detect_by_magic_and_extension() {
    let p = test_pattern();
    for f in [Format::Pes, Format::Pec, Format::Dst, Format::Vp3] {
        let bytes = write(&p, f).unwrap();
        assert_eq!(detect(&bytes, None), Some(f), "{f:?}");
        // Magic wins over a misleading extension.
        assert_eq!(detect(&bytes, Some("design.jef")), Some(f), "{f:?}");
    }
    let jef = write(&p, Format::Jef).unwrap();
    assert_eq!(
        detect(&jef, Some("C:\\designs\\Flower.JEF")),
        Some(Format::Jef)
    );
    assert_eq!(detect(&jef, None), None);
    assert_eq!(detect(b"", Some("x.exp")), Some(Format::Exp));
    assert_eq!(detect(b"", Some("x.Xxx")), Some(Format::Xxx));
    assert_eq!(detect(b"", Some("noext")), None);
    assert_eq!(detect(b"", Some("x.svg")), None);
    assert_eq!(detect(b"#PES0060....", Some("x.dst")), Some(Format::Pes));
}

#[test]
fn format_table() {
    assert_eq!(formats().len(), 46);
    assert_eq!(formats().iter().filter(|i| i.can_read && i.can_write).count(), 10);
    assert!(formats().iter().all(|i| i.can_read || i.can_write));
    assert!(formats().iter().all(|i| i.format != Format::Json), "pystitch JSON stays out of the list");
    assert!(!Format::Csv.info().can_read);
    assert!(matches!(read(b"", Format::Csv), Err(Error::Unsupported(_))));
    assert_eq!(format_from_extension(".DsT"), Some(Format::Dst));
}

#[test]
fn csv_dump_is_text() {
    let s = String::from_utf8(write(&test_pattern(), Format::Csv).unwrap()).unwrap();
    assert!(s.contains("STITCH_COUNT"));
    assert!(s.contains("COLOR_CHANGE"));
}

#[test]
fn pec_stream_starts_at_the_top_left_corner() {
    // Ink/Stitch (pystitch): the PEC stitch block opens with a jump from the
    // design's top-left corner to its origin, so machines place the design
    // from that corner. Read back, the design spans from (0, 0).
    let p = Pattern {
        stitches: vec![s(-12.0, -8.0, 0), s(12.0, -8.0, 0), s(12.0, 8.0, 0), s(-12.0, 8.0, 0), s(-12.0, -8.0, 0)],
        ..Default::default()
    };
    for f in [Format::Pes, Format::Pec] {
        let back = read(&write(&p, f).unwrap(), f).unwrap();
        let pts = penetrations(&back);
        let min_x = pts.iter().map(|q| q.0).fold(f64::INFINITY, f64::min);
        let min_y = pts.iter().map(|q| q.1).fold(f64::INFINITY, f64::min);
        assert!(min_x.abs() < 0.11 && min_y.abs() < 0.11, "{f:?}: starts at ({min_x}, {min_y})");
        let max_x = pts.iter().map(|q| q.0).fold(f64::NEG_INFINITY, f64::max);
        assert!((max_x - 24.0).abs() < 0.11, "{f:?}: width {max_x}");
    }
}

#[test]
fn writers_do_not_recentre() {
    // A design far off-centre must keep its absolute position (PEC / PES
    // anchor at the top-left corner instead, see above).
    let p = Pattern {
        stitches: vec![s(40.0, 30.0, 0), s(41.0, 30.0, 0), s(41.0, 31.0, 0)],
        ..Default::default()
    };
    for f in [
        Format::Dst,
        Format::Jef,
        Format::Exp,
        Format::Vp3,
        Format::Xxx,
    ] {
        let back = read(&write(&p, f).unwrap(), f).unwrap();
        let got = penetrations(&back);
        assert_penetrations_match(f, &penetrations(&p), &got, 0.1);
    }
}

#[test]
fn stop_roundtrips_where_the_format_can_express_it() {
    let p = Pattern {
        stitches: vec![
            s(0.0, 0.0, 0),
            s(2.0, 0.0, 0),
            s(2.0, 0.0, cmd::STOP),
            s(4.0, 1.0, 0),
            s(4.0, 1.0, cmd::COLOR_CHANGE),
            s(6.0, 1.0, 0),
            s(6.0, 1.0, cmd::END),
        ],
        threads: vec![Thread::from_rgb(RED), Thread::from_rgb(BLUE)],
        name: String::new(),
    };
    for f in [Format::Pes, Format::Pec, Format::Jef] {
        let back = read(&write(&p, f).unwrap(), f).unwrap();
        let stops = back
            .stitches
            .iter()
            .filter(|s| s.flags & cmd::STOP != 0)
            .count();
        let changes = back
            .stitches
            .iter()
            .filter(|s| s.flags & cmd::COLOR_CHANGE != 0)
            .count();
        assert_eq!((stops, changes, back.threads.len()), (1, 1, 2), "{f:?}");
    }
    // DST/EXP/XXX use the same record for stop and colour change.
    for f in [Format::Dst, Format::Exp, Format::Xxx] {
        let back = read(&write(&p, f).unwrap(), f).unwrap();
        let changes = back
            .stitches
            .iter()
            .filter(|s| s.flags & cmd::COLOR_CHANGE != 0)
            .count();
        assert_eq!(changes, 2, "{f:?}");
    }
}

#[test]
fn pec_never_picks_the_applique_slots() {
    // pystitch: PEC 62..=64 are machine functions, not thread colours
    assert_eq!(PEC_PALETTE[61].1, "Applique Material");
    for rgb in [[255, 200, 100], [255, 200, 200], [255, 153, 0]] {
        let i = nearest_pec_index(rgb);
        assert!(i < 62, "{rgb:?} → slot {i}");
    }
}

#[test]
fn dst_colour_count_includes_stops() {
    let p = Pattern {
        stitches: vec![s(0.0, 0.0, 0), s(2.0, 0.0, 0), s(2.0, 0.0, cmd::STOP), s(4.0, 0.0, 0), s(4.0, 0.0, cmd::COLOR_CHANGE), s(6.0, 0.0, 0)],
        ..Default::default()
    };
    let bytes = write(&p, Format::Dst).unwrap();
    let header = String::from_utf8_lossy(&bytes[..512]);
    assert!(header.contains("CO:  2"), "{header}");
}

#[test]
fn jef_zero_length_jump_reads_as_trim() {
    let p = Pattern { stitches: vec![s(0.0, 0.0, 0), s(1.0, 0.0, 0), s(2.0, 0.0, 0)], ..Default::default() };
    assert!(!read(&write(&p, Format::Jef).unwrap(), Format::Jef).unwrap().stitches.iter().any(|st| st.flags & cmd::TRIM != 0), "no trim without the zero jump");
    let mut bytes = write(&p, Format::Jef).unwrap();
    // insert 80 02 00 00 (a jump of 0, 0) after the stitches, before the end marker 80 10
    let end = bytes.windows(2).rposition(|w| w == [0x80, 0x10]).expect("end marker");
    let tail = bytes.split_off(end);
    let mut patched = bytes;
    patched.extend_from_slice(&[0x80, 0x02, 0x00, 0x00]);
    patched.extend_from_slice(&tail);
    let back = read(&patched, Format::Jef).unwrap();
    assert!(back.stitches.iter().any(|st| st.flags & cmd::TRIM != 0), "{:?}", &back.stitches[..4.min(back.stitches.len())]);
}

fn two_block_pattern(a: Thread, b: Thread) -> Pattern {
    Pattern {
        stitches: vec![s(0.0, 0.0, 0), s(3.0, 0.0, 0), s(3.0, 0.0, cmd::COLOR_CHANGE), s(6.0, 0.0, 0), s(9.0, 0.0, 0)],
        threads: vec![a, b],
        name: "Spools".into(),
    }
}
fn spool(rgb: [u8; 3], name: &str, code: &str, brand: &str) -> Thread {
    Thread { rgb, name: name.into(), code: code.into(), brand: brand.into() }
}

#[test]
fn pes_v6_keeps_the_exact_threads() {
    let p = two_block_pattern(spool([184, 82, 28], "Rust", "1621", "Madeira Polyneon"), spool([31, 42, 86], "Navy", "1967", "Madeira Polyneon"));
    let opts = WriteOptions { pes_version: PesVersion::V6, ..Default::default() };
    let bytes = write_with_options(&p, Format::Pes, &opts).unwrap();
    assert!(bytes.starts_with(b"#PES0060"));
    let back = read(&bytes, Format::Pes).unwrap();
    let got: Vec<([u8; 3], String)> = back.threads.iter().map(|t| (t.rgb, t.code.clone())).collect();
    assert_eq!(got, vec![([184, 82, 28], "1621".to_string()), ([31, 42, 86], "1967".to_string())]);
    assert_eq!(back.threads[0].name, "Rust");
    assert_penetrations_match(Format::Pes, &penetrations(&p), &penetrations(&aligned(Format::Pes, &p, back)), 0.1);
}

#[test]
fn different_spools_never_share_a_brother_slot() {
    // same RGB, different catalogue codes: two threads to load, two slots
    let p = two_block_pattern(spool([200, 30, 40], "Red", "1747", "Madeira"), spool([200, 30, 40], "Red", "3100", "Isacord"));
    let m = machine_colors(&p, Format::Pes, &WriteOptions::default());
    assert_eq!(m.len(), 2);
    assert_ne!(m[0].slot, m[1].slot);
    // the same spool twice keeps one slot
    let same = two_block_pattern(spool([200, 30, 40], "Red", "1747", "Madeira"), spool([200, 30, 40], "Red", "1747", "Madeira"));
    let m = machine_colors(&same, Format::Pes, &WriteOptions::default());
    assert_eq!(m[0].slot, m[1].slot);
}

#[test]
fn machine_colours_per_format() {
    let p = two_block_pattern(spool([184, 82, 28], "Rust", "1621", "Madeira"), spool([31, 42, 86], "Navy", "1967", "Madeira"));
    let pes = machine_colors(&p, Format::Pes, &WriteOptions::default());
    assert!(pes.iter().all(|c| c.shown.is_some() && !c.exact && c.slot.unwrap() < 62));
    let pes6 = machine_colors(&p, Format::Pes, &WriteOptions { pes_version: PesVersion::V6, ..Default::default() });
    assert!(pes6.iter().all(|c| c.exact));
    let vp3 = machine_colors(&p, Format::Vp3, &WriteOptions::default());
    assert!(vp3.iter().all(|c| c.exact && c.shown.as_ref().unwrap().rgb == c.thread.rgb));
    let dst = machine_colors(&p, Format::Dst, &WriteOptions::default());
    assert!(dst.iter().all(|c| c.shown.is_none()));
    assert_eq!(machine_colors(&p, Format::Jef, &WriteOptions::default()).len(), 2);
}

// ---------------------------------------------------------------------------------------
// Formats ported for issues #70 / #71
// ---------------------------------------------------------------------------------------

#[test]
fn roundtrip_u01() {
    let back = check_roundtrip(Format::U01, &WriteOptions::default());
    // no colours in U01: distinct synthesized threads
    assert_ne!(back.threads[0].rgb, back.threads[1].rgb);
}

#[test]
fn roundtrip_tbf() {
    let back = check_roundtrip(Format::Tbf, &WriteOptions::default());
    assert_eq!(back.name, "roundtrip");
    let rgbs: Vec<[u8; 3]> = back.threads.iter().map(|t| t.rgb).collect();
    assert_eq!(rgbs, vec![RED, GREEN, BLUE]);
}

#[test]
fn roundtrip_sew() {
    let back = check_roundtrip(Format::Sew, &WriteOptions::default());
    let sew = |c: [u8; 3]| palette::SEW_PALETTE[nearest_index(c, &palette::SEW_PALETTE.iter().enumerate().map(|(i, e)| (i > 0).then_some(e.0)).collect::<Vec<_>>()).unwrap()].0;
    let rgbs: Vec<[u8; 3]> = back.threads.iter().map(|t| t.rgb).collect();
    assert_eq!(rgbs, vec![sew(RED), sew(GREEN), sew(BLUE)]);
    assert_eq!(back.threads[0].brand, "Sew");
}

#[test]
fn roundtrip_pystitch_json() {
    let back = check_roundtrip(Format::Json, &WriteOptions::default());
    assert_eq!(back.name, "roundtrip");
    let p = test_pattern();
    for (a, b) in back.threads.iter().zip(&p.threads) {
        assert_eq!((a.rgb, &a.name, &a.code, &a.brand), (b.rgb, &b.name, &b.code, &b.brand));
    }
    // stitches are kept exactly (0.1 mm), long stitches are not split
    assert_eq!(penetrations(&back).len(), penetrations(&p).len());
}

#[test]
fn sew_rejects_more_than_twelve_colours() {
    let mut stitches = Vec::new();
    for i in 0..13 {
        stitches.push(s(i as f64, 0.0, 0));
        stitches.push(s(i as f64 + 0.5, 0.0, 0));
        stitches.push(s(i as f64 + 0.5, 0.0, cmd::COLOR_CHANGE));
    }
    stitches.push(s(20.0, 0.0, 0));
    let p = Pattern { stitches, ..Default::default() };
    assert!(matches!(write(&p, Format::Sew), Err(Error::Unsupported(_))));
}

#[test]
fn sew_keeps_its_own_table_codes() {
    // a thread read from a SEW file goes back into the same slot
    let p = two_block_pattern(spool([255, 0, 0], "Red", "10", "Sew"), spool([250, 160, 96], "Hazel", "4", "Sew"));
    let bytes = write(&p, Format::Sew).unwrap();
    assert_eq!(&bytes[0..6], &[2, 0, 10, 0, 4, 0]);
    let m = machine_colors(&p, Format::Sew, &WriteOptions::default());
    assert_eq!((m[0].slot, m[1].slot), (Some(10), Some(4)));
    let back = read(&bytes, Format::Sew).unwrap();
    assert_eq!(back.threads[0].name, "Red");
    assert_eq!(back.threads[1].name, "Hazel");
}

#[test]
fn tbf_header_matches_pystitch() {
    let p = two_block_pattern(spool([184, 82, 28], "Rust", "1621", "Madeira"), spool([31, 42, 86], "Navy", "1967", "Madeira"));
    let b = write(&p, Format::Tbf).unwrap();
    assert_eq!(&b[0..4], b"3.00");
    assert_eq!(&b[0x80..0x94], b"LA:Spools          \r".as_slice());
    // records: needle set, stitch x2, trim, needle set, jump, stitch x2, end = 9
    assert!(String::from_utf8_lossy(&b[0x80..0x200]).contains("ST:      9\rCO:  2\r"));
    // DO: needles 1, 2 (pystitch's default of 5 needles, cycled)
    assert_eq!(&b[0x10A..0x10D], &[1, 2, 0]);
    // DA: the exact thread colours
    assert_eq!(&b[0x20B..0x218], b"DA:\x45\xB8\x52\x1C\x20\x45\x1F\x2A\x56\x20".as_slice());
    assert_eq!(&b[0x376..0x378], &[0x0D, 0x1A]);
    assert_eq!(b.len(), 0x600 + 9 * 3 + 1);
    // first record: needle set (0x81); the explicit trim before the colour change (0x86)
    assert_eq!(b[0x600 + 2], 0x81);
    assert_eq!(&b[0x600 + 9..0x600 + 15], &[0, 0, 0x86, 0, 0, 0x81]);
    assert_eq!(&b[b.len() - 4..], &[0, 0, 0x8F, 0x1A]);
}

#[test]
fn u01_header_and_needles() {
    let p = two_block_pattern(Thread::from_rgb(RED), Thread::from_rgb(BLUE));
    let b = write(&p, Format::U01).unwrap();
    assert!(b[..0x80].iter().all(|&c| c == b'0'));
    let i16_at = |o: usize| i16::from_le_bytes([b[o], b[o + 1]]);
    // extents: min x, -max y, max x, -min y (0.1 mm)
    assert_eq!((i16_at(0x80), i16_at(0x82), i16_at(0x84), i16_at(0x86)), (0, 0, 90, 0));
    // records: needle set, stitch x2, needle set, jump, stitch x2, end = 8 (+1)
    assert_eq!(u32::from_le_bytes(b[0x8C..0x90].try_into().unwrap()), 9);
    assert_eq!(i16_at(0x90), 90);
    assert!(b[0x94..0x100].iter().all(|&c| c == 0));
    // needle 1, then needle 2: 0x80 | 0x40 (dy >= 0) | 0x20 (dx <= 0) | 0x08 + needle
    assert_eq!(&b[0x100..0x103], &[0xE9, 0, 0]);
    assert_eq!(&b[0x103..0x106], &[0xE0, 0, 0]); // stitch at the origin
    assert_eq!(&b[0x106..0x109], &[0xC0, 0, 30]); // stitch 3 mm right
    assert_eq!(&b[0x109..0x10C], &[0xEA, 0, 0]);
    assert_eq!(&b[b.len() - 3..], &[0xF8, 0, 0]);
    // aliases read as U01
    assert_eq!(detect(&b, Some("design.U00")), Some(Format::U01));
}

#[test]
fn colour_files_and_text_dumps() {
    let p = test_pattern();
    let col = String::from_utf8(write(&p, Format::Col).unwrap()).unwrap();
    assert_eq!(col, "3\r\n0,220,30,45\r\n1,30,150,60\r\n2,25,60,190\r\n");
    assert_eq!(write(&p, Format::Edr).unwrap(), vec![220, 30, 45, 0, 30, 150, 60, 0, 25, 60, 190, 0]);
    let inf = write(&p, Format::Inf).unwrap();
    assert_eq!(&inf[12..16], &[0, 0, 0, 3]);
    assert!(inf.windows(9).any(|w| w == b"Red\0Test\0"));
    let txt = String::from_utf8(write(&p, Format::Txt).unwrap()).unwrap();
    assert!(txt.contains("command:COLOR_CHANGE flags:5"));
    assert!(txt.lines().last().unwrap().ends_with("command:END flags:4"));
    let gcode = String::from_utf8(write(&p, Format::Gcode).unwrap()).unwrap();
    assert!(gcode.starts_with("(STITCH_COUNT:"));
    assert_eq!(gcode.matches("M00\r\n").count(), 2, "one pause per colour change");
    assert_eq!(gcode.matches(" Z").count(), penetrations(&p).len());
    assert!(gcode.ends_with("G0 X0.0 Y0.0\r\nM30\r\n"));
    for f in [Format::Col, Format::Edr, Format::Inf, Format::Txt, Format::Gcode] {
        assert!(matches!(read(b"", f), Err(Error::Unsupported(_))), "{f:?}");
        assert!(!f.info().can_read);
    }
}

#[test]
fn read_only_formats_refuse_to_write() {
    for info in formats().iter().filter(|i| !i.can_write) {
        assert!(matches!(write(&test_pattern(), info.format), Err(Error::Unsupported(_))), "{:?}", info.format);
    }
}

#[test]
fn new_extensions_and_aliases() {
    for (ext, f) in [
        ("u01", Format::U01),
        ("U02", Format::U01),
        ("tbf", Format::Tbf),
        ("sew", Format::Sew),
        ("hus", Format::Hus),
        ("shv", Format::Shv),
        ("pcs", Format::Pcs),
        ("e01", Format::Exy),
        ("f00", Format::Fxy),
        ("10o", Format::A10o),
        ("100", Format::A100),
        ("gcode", Format::Gcode),
        ("col", Format::Col),
    ] {
        assert_eq!(format_from_extension(ext), Some(f), "{ext}");
    }
    assert_eq!(format_from_extension("json"), None, "json is the Filum project");
    assert_eq!(Format::Json.extension(), "json");
    assert_eq!(detect(b"#PHB0003", Some("x.dst")), Some(Format::Phb));
}
