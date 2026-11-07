//! Designs that do not fit a format's fixed-width fields must fail to write
//! instead of producing a silently corrupt file.

use filum_formats::*;

fn s(x: f64, y: f64, flags: u8) -> Stitch {
    Stitch { x, y, flags }
}

fn pattern(stitches: Vec<Stitch>) -> Pattern {
    Pattern { stitches, ..Default::default() }
}

/// Two stitches `dx` mm apart with a trim and a jump between them.
fn trim_and_jump(dx: f64) -> Pattern {
    pattern(vec![s(0.0, 0.0, 0), s(0.5, 0.0, 0), s(0.5, 0.0, cmd::TRIM), s(dx, 0.0, cmd::JUMP), s(dx, 0.0, 0), s(dx + 0.5, 0.0, 0)])
}

/// `blocks` colour blocks of two stitches each.
fn colour_blocks(blocks: usize) -> Pattern {
    let mut st = Vec::new();
    for i in 0..blocks {
        let x = (i % 100) as f64 * 0.5;
        if i > 0 {
            st.push(s(x, 0.0, cmd::COLOR_CHANGE));
        }
        st.push(s(x, 0.0, 0));
        st.push(s(x, 1.0, 0));
    }
    pattern(st)
}

/// `n` short stitches in one run (no trims, jumps or colour changes).
fn long_run(n: usize) -> Pattern {
    pattern((0..n).map(|i| s((i % 2) as f64, i as f64 * 0.001, 0)).collect())
}

fn malformed(r: Result<Vec<u8>, Error>) -> String {
    match r {
        Err(Error::Malformed(m)) => m,
        Err(e) => panic!("expected Error::Malformed, got {e:?}"),
        Ok(_) => panic!("expected an error, the design was written"),
    }
}

fn v6() -> WriteOptions {
    WriteOptions { pes_version: PesVersion::V6, ..Default::default() }
}

#[test]
fn vp3_rejects_a_jump_longer_than_its_16_bit_move() {
    // VP3 has no jumps: the 4000 mm jump becomes one long-form move.
    let m = malformed(write(&trim_and_jump(4000.0), Format::Vp3));
    assert_eq!(m, "VP3: a move of 3999.5 mm exceeds the format's 3276.7 mm limit");
    // Within the limit the move is kept exactly.
    let back = read(&write(&trim_and_jump(3000.0), Format::Vp3).unwrap(), Format::Vp3).unwrap();
    let last = back.stitches.iter().rev().find(|s| s.is_penetration()).unwrap();
    assert!((last.x - 3000.5).abs() < 1e-9, "{last:?}");
}

#[test]
fn vp3_rejects_a_design_beyond_its_header_range() {
    // Long stitches are split into short ones, so only the 32-bit header (1/1000 mm) overflows.
    let p = pattern(vec![s(0.0, 0.0, 0), s(2_200_000.0, 0.0, 0)]);
    let m = malformed(write(&p, Format::Vp3));
    assert!(m.starts_with("VP3: the design extends 2200000.0 mm from its origin"), "{m}");
}

#[test]
fn pec_and_pes_reject_an_origin_beyond_the_12_bit_start_jump() {
    // 250 mm left of the origin: the opening jump from the top-left corner can't hold it.
    let p = pattern(vec![s(-250.0, 0.0, 0), s(-249.0, 1.0, 0), s(0.0, 0.0, 0)]);
    assert_eq!(malformed(write(&p, Format::Pec)), "PEC: the design's top-left corner is 250.0 mm from its origin; PEC stores at most 204.7 mm");
    assert_eq!(malformed(write(&p, Format::Pes)), "PES: the design's top-left corner is 250.0 mm from its origin; PES stores at most 204.7 mm");
    assert!(write_with_options(&p, Format::Pes, &v6()).is_err());
    // A design 300 mm wide around its origin, or starting at it, fits.
    for x0 in [-150.0, 0.0] {
        let p = pattern(vec![s(x0, 0.0, 0), s(x0 + 300.0, 10.0, 0)]);
        for f in [Format::Pec, Format::Pes] {
            let back = read(&write(&p, f).unwrap(), f).unwrap();
            let xs: Vec<f64> = back.stitches.iter().filter(|s| s.is_penetration()).map(|s| s.x).collect();
            let span = xs.iter().cloned().fold(f64::MIN, f64::max) - xs.iter().cloned().fold(f64::MAX, f64::min);
            assert!((span - 300.0).abs() < 1e-9, "{f:?}: {span}");
        }
    }
}

#[test]
fn pes_rejects_a_design_wider_than_its_16_bit_segments() {
    let p = pattern(vec![s(0.0, 0.0, 0), s(0.5, 0.0, 0), s(0.5, 0.0, cmd::TRIM), s(3300.0, 0.0, cmd::JUMP), s(3300.0, 0.0, 0)]);
    assert_eq!(malformed(write(&p, Format::Pes)), "PES: the design is 3300.0 mm wide; PES stores at most 3276.7 mm");
    // PEC alone stores sizes up to 6553.5 mm.
    assert!(write(&p, Format::Pec).is_ok());
}

#[test]
fn pec_and_pes_reject_more_than_255_colour_blocks() {
    let p = colour_blocks(256);
    assert_eq!(malformed(write(&p, Format::Pec)), "PEC: the design has 256 colour blocks (each stop counts as one); PEC stores at most 255");
    assert!(malformed(write(&p, Format::Pes)).starts_with("PES: the design has 256 colour blocks"));
    assert!(write_with_options(&p, Format::Pes, &v6()).is_err());
    let p = colour_blocks(255);
    for f in [Format::Pec, Format::Pes] {
        let back = read(&write(&p, f).unwrap(), f).unwrap();
        assert_eq!(back.threads.len(), 255, "{f:?}");
        assert_eq!(back.stitches.iter().filter(|s| s.flags & cmd::COLOR_CHANGE != 0).count(), 254, "{f:?}");
    }
}

#[test]
fn pes_splits_a_run_longer_than_one_section() {
    // A section holds at most 65535 points: a longer run is written as several.
    let p = long_run(70_000);
    for opts in [WriteOptions::default(), v6()] {
        let bytes = write_with_options(&p, Format::Pes, &opts).unwrap();
        let back = read(&bytes, Format::Pes).unwrap();
        assert_eq!(back.stitches.iter().filter(|s| s.is_penetration()).count(), 70_000);
    }
}

#[test]
fn dst_and_tbf_reject_numbers_wider_than_their_header_fields() {
    let far = pattern(vec![s(0.0, 0.0, 0), s(10_000.5, 0.0, 0)]);
    assert_eq!(malformed(write(&far, Format::Dst)), "DST: the design extends 10000.5 mm from its origin; DST stores at most 9999.9 mm");
    assert_eq!(malformed(write(&far, Format::Tbf)), "TBF: the design extends 10000.5 mm from its origin; TBF stores at most 9999.9 mm");
    assert!(write(&pattern(vec![s(0.0, 0.0, 0), s(-9_999.9, 0.0, 0)]), Format::Dst).is_ok());

    assert_eq!(malformed(write(&colour_blocks(1001), Format::Dst)), "DST: the design has 1000 colour changes and stops; DST stores at most 999");
    assert!(write(&colour_blocks(1000), Format::Dst).is_ok());
}

#[test]
fn tbf_rejects_more_colours_than_its_thread_list_holds() {
    assert_eq!(malformed(write(&colour_blocks(73), Format::Tbf)), "TBF: the design has 73 colours; TBF stores at most 72");
    let back = read(&write(&colour_blocks(72), Format::Tbf).unwrap(), Format::Tbf).unwrap();
    assert_eq!(back.threads.len(), 72);
}

#[test]
fn u01_and_xxx_reject_designs_beyond_their_16_bit_header() {
    let p = trim_and_jump(3300.0);
    assert_eq!(malformed(write(&p, Format::U01)), "U01: the design extends 3300.5 mm from its origin; U01 stores at most 3276.7 mm");
    assert_eq!(malformed(write(&p, Format::Xxx)), "XXX: the design is 3300.5 mm wide; XXX stores at most 3276.7 mm");
    // The jumps from the origin are part of the design: 3278 mm away, 3265.6 mm wide.
    let off = pattern(vec![s(-3278.0, 0.0, 0), s(-3277.0, 0.0, 0)]);
    assert_eq!(malformed(write(&off, Format::Xxx)), "XXX: the design extends 3278.0 mm from its origin; XXX stores at most 3276.7 mm");
    for f in [Format::U01, Format::Xxx] {
        assert!(write(&trim_and_jump(3000.0), f).is_ok(), "{f:?}");
    }
}

#[test]
fn sew_rejects_a_colour_block_beyond_its_16_bit_count() {
    assert_eq!(malformed(write(&long_run(70_000), Format::Sew)), "SEW: a colour block has 70001 stitch records; SEW stores at most 65535 per colour");
    assert!(write(&long_run(60_000), Format::Sew).is_ok());
}

#[test]
fn inf_rejects_a_thread_name_beyond_its_16_bit_record() {
    let mut p = long_run(2);
    p.threads = vec![Thread { rgb: [1, 2, 3], name: "x".repeat(70_000), ..Default::default() }];
    assert_eq!(malformed(write(&p, Format::Inf)), "INF: the name and brand of colour 1 take 70007 bytes; INF stores at most 65524");
}

#[test]
fn formats_without_size_limits_still_write_huge_designs() {
    let p = trim_and_jump(5000.0);
    for f in [Format::Jef, Format::Exp, Format::Gcode, Format::Csv, Format::Txt, Format::Json, Format::Col, Format::Edr, Format::Inf] {
        assert!(write(&p, f).is_ok(), "{f:?}");
    }
}
