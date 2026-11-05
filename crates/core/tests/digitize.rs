#![cfg(feature = "digitize")]

use filum_core::digitize::{digitize_rgba, DigitizeOptions, DigitizeResult};
use filum_core::geom::{signed_area, Point};
use filum_core::{Object, StitchParams};

struct Img {
    w: usize,
    h: usize,
    px: Vec<u8>,
}

impl Img {
    fn new(w: usize, h: usize, bg: [u8; 3]) -> Img {
        let mut px = Vec::with_capacity(w * h * 4);
        for _ in 0..w * h {
            px.extend_from_slice(&[bg[0], bg[1], bg[2], 255]);
        }
        Img { w, h, px }
    }
    fn set(&mut self, x: usize, y: usize, c: [u8; 3]) {
        if x < self.w && y < self.h {
            let i = (y * self.w + x) * 4;
            self.px[i..i + 3].copy_from_slice(&c);
        }
    }
    /// Paint every pixel whose centre satisfies `f`.
    fn paint(&mut self, c: [u8; 3], f: impl Fn(f64, f64) -> bool) {
        for y in 0..self.h {
            for x in 0..self.w {
                if f(x as f64 + 0.5, y as f64 + 0.5) {
                    self.set(x, y, c);
                }
            }
        }
    }
    fn run(&self, opts: &DigitizeOptions) -> DigitizeResult {
        digitize_rgba(&self.px, self.w as u32, self.h as u32, opts)
    }
}

fn seg_dist(px: f64, py: f64, a: (f64, f64), b: (f64, f64)) -> f64 {
    let (dx, dy) = (b.0 - a.0, b.1 - a.1);
    let t = (((px - a.0) * dx + (py - a.1) * dy) / (dx * dx + dy * dy)).clamp(0.0, 1.0);
    ((px - a.0 - t * dx).powi(2) + (py - a.1 - t * dy).powi(2)).sqrt()
}

fn rgb(o: &Object, r: &DigitizeResult) -> [u8; 3] {
    r.threads.iter().find(|t| t.id == o.thread).unwrap().rgb()
}

fn area(o: &Object) -> f64 {
    o.paths.iter().map(|sp| signed_area(&sp.flatten(0.05)).abs()).sum()
}

fn points(o: &Object) -> Vec<Point> {
    o.paths.iter().flat_map(|sp| sp.flatten(0.05)).collect()
}

#[test]
fn circle_and_rectangle_become_fills() {
    let mut img = Img::new(400, 300, [255, 255, 255]);
    img.paint([220, 20, 30], |x, y| (x - 120.0).powi(2) + (y - 150.0).powi(2) <= 60.0 * 60.0);
    img.paint([30, 60, 200], |x, y| (240.0..360.0).contains(&x) && (90.0..210.0).contains(&y));
    let opts = DigitizeOptions { width_mm: 100.0, ..Default::default() };
    let r = img.run(&opts);
    assert_eq!(r.objects.len(), 2, "{:#?}", r.objects.iter().map(|o| &o.name).collect::<Vec<_>>());
    assert_eq!(r.threads.len(), 2);
    assert!(r.objects.iter().all(|o| matches!(o.stitch, StitchParams::Fill(_))));
    assert_eq!(r.objects[0].id, "dz1");
    assert_eq!(r.threads[0].id, "t1");
    assert!(r.threads.iter().all(|t| t.color != "#ffffff"), "background must be removed");

    let s = 100.0 / 400.0;
    let circle = r.objects.iter().find(|o| rgb(o, &r)[0] > 150).expect("red object");
    let expect = std::f64::consts::PI * (60.0 * s) * (60.0 * s);
    let a = area(circle);
    assert!((a - expect).abs() / expect < 0.10, "circle area {a} vs {expect}");
    let b = circle.bounds();
    let (cx, cy) = (b.center().x, b.center().y);
    assert!((cx - 30.0).abs() < 0.3 && (cy - 37.5).abs() < 0.3, "circle centre {cx},{cy}");
    // 30 mm diameter + 2 × 0.2 mm overlap
    assert!((b.width() - 30.4).abs() < 0.6, "circle diameter {}", b.width());

    let rect = r.objects.iter().find(|o| rgb(o, &r)[2] > 150).expect("blue object");
    let pts = points(rect);
    let (minx, maxx) = pts.iter().fold((f64::MAX, f64::MIN), |(a, b), p| (a.min(p.x), b.max(p.x)));
    assert!((minx - 60.0).abs() < 0.6 && (maxx - 90.0).abs() < 0.6, "rect x {minx}..{maxx}");
    let ra = area(rect);
    assert!((ra - 900.0).abs() / 900.0 < 0.10, "rect area {ra}");
    // larger colour group first (rect 900 mm² > circle 707 mm²)
    assert_eq!(r.objects[0].thread, rect.thread);
}

#[test]
fn thin_diagonal_bar_becomes_satin() {
    let mut img = Img::new(400, 300, [255, 255, 255]);
    let (a, b) = ((50.0, 60.0), (350.0, 240.0));
    img.paint([25, 25, 60], |x, y| seg_dist(x, y, a, b) <= 4.0);
    let opts = DigitizeOptions { width_mm: 100.0, ..Default::default() };
    let r = img.run(&opts);
    assert_eq!(r.objects.len(), 1);
    let o = &r.objects[0];
    let StitchParams::Satin(sp) = &o.stitch else { panic!("expected satin, got {:?}", o.stitch) };
    assert!((sp.width - 2.0).abs() <= 0.6, "satin width {}", sp.width);
    assert!(sp.center_walk);
    assert_eq!(o.paths.len(), 1);
    assert!(!o.paths[0].closed);
    let pts = o.paths[0].flatten(0.05);
    let len: f64 = pts.windows(2).map(|w| w[0].dist(w[1])).sum();
    let expect = ((300.0f64).powi(2) + 180.0f64.powi(2)).sqrt() * 0.25; // ≈ 87.5 mm
    assert!(len > expect * 0.85 && len < expect * 1.1, "centre line length {len} vs {expect}");
}

#[test]
fn hairlines_become_running() {
    let mut img = Img::new(400, 300, [250, 250, 245]);
    for x in 40..360 {
        img.set(x, 150, [10, 10, 10]);
    }
    // Bresenham-style sloped hairline (8-connected steps)
    for x in 40..360 {
        let y = 40 + (x - 40) * 60 / 320;
        img.set(x, y, [10, 10, 10]);
    }
    let opts = DigitizeOptions { width_mm: 100.0, ..Default::default() };
    let r = img.run(&opts);
    assert_eq!(r.objects.len(), 2, "{:?}", r.objects.iter().map(|o| &o.stitch).collect::<Vec<_>>());
    for o in &r.objects {
        assert!(matches!(o.stitch, StitchParams::Running(_)), "{:?}", o.stitch);
        let len: f64 = o.paths.iter().map(|sp| sp.flatten(0.05).windows(2).map(|w| w[0].dist(w[1])).sum::<f64>()).sum();
        assert!(len > 70.0, "running length {len}");
    }
}

/// Deterministic "busy" test card with 8 colours and mild noise.
fn test_card(w: usize, h: usize) -> Img {
    let mut img = Img::new(w, h, [240, 238, 230]);
    let (fw, fh) = (w as f64, h as f64);
    img.paint([30, 70, 190], |x, y| (x - 0.3 * fw).powi(2) + (y - 0.4 * fh).powi(2) <= (0.22 * fh).powi(2));
    img.paint([210, 30, 40], |x, y| x > 0.55 * fw && x < 0.9 * fw && y > 0.1 * fh && y < 0.45 * fh);
    img.paint([40, 150, 70], |x, y| {
        let d = ((x - 0.7 * fw).powi(2) + (y - 0.72 * fh).powi(2)).sqrt();
        (d - 0.15 * fh).abs() < 0.02 * fh
    });
    img.paint([245, 200, 40], |x, y| seg_dist(x, y, (0.05 * fw, 0.9 * fh), (0.5 * fw, 0.7 * fh)) < 0.012 * fw);
    img.paint([20, 20, 20], |x, y| seg_dist(x, y, (0.05 * fw, 0.08 * fh), (0.5 * fw, 0.12 * fh)) < 0.6 * fw / 640.0);
    img.paint([240, 120, 30], |x, y| y > 0.55 * fh && y < 0.95 * fh && (x - 0.7 * fw).abs() < (y - 0.55 * fh) * 0.3);
    img.paint([120, 50, 150], |x, y| ((x - 0.3 * fw) / (0.08 * fw)).powi(2) + ((y - 0.4 * fh) / (0.05 * fh)).powi(2) <= 1.0);
    // mild deterministic noise
    let mut s: u32 = 12345;
    for p in img.px.chunks_exact_mut(4) {
        for c in p.iter_mut().take(3) {
            s ^= s << 13;
            s ^= s >> 17;
            s ^= s << 5;
            let n = (s % 13) as i32 - 6;
            *c = (*c as i32 + n).clamp(0, 255) as u8;
        }
    }
    img
}

#[test]
fn deterministic_output() {
    let img = test_card(320, 240);
    let opts = DigitizeOptions { colors: 8, ..Default::default() };
    let a = serde_json::to_string(&img.run(&opts)).unwrap();
    let b = serde_json::to_string(&img.run(&opts)).unwrap();
    assert!(!a.is_empty());
    assert_eq!(a, b);
}

#[test]
fn timing_640x480_8_colours() {
    let img = test_card(640, 480);
    let opts = DigitizeOptions { colors: 8, ..Default::default() };
    let t = std::time::Instant::now();
    let r = img.run(&opts);
    let dt = t.elapsed();
    let kinds = |f: fn(&StitchParams) -> bool| r.objects.iter().filter(|o| f(&o.stitch)).count();
    println!(
        "digitize 640x480, 8 colours: {:.1} ms → {} threads, {} objects ({} fill, {} satin, {} running)",
        dt.as_secs_f64() * 1000.0,
        r.threads.len(),
        r.objects.len(),
        kinds(|s| matches!(s, StitchParams::Fill(_))),
        kinds(|s| matches!(s, StitchParams::Satin(_))),
        kinds(|s| matches!(s, StitchParams::Running(_))),
    );
    for t in &r.threads {
        println!("  {} {} {}", t.id, t.color, t.name);
    }
    for o in &r.objects {
        let kind = match &o.stitch {
            StitchParams::Fill(f) => format!("fill {:.1}°", f.angle),
            StitchParams::Satin(s) => format!("satin w={:.2}", s.width),
            StitchParams::Running(_) => "running".to_string(),
            _ => "other".to_string(),
        };
        println!("  {} {:<16} {}", o.id, o.name, kind);
    }
    assert!(!r.objects.is_empty());
    assert!(r.threads.len() <= 8);

    // larger input goes through the box-filter downscale to 640 px
    let big = test_card(1600, 1200);
    let t = std::time::Instant::now();
    let r2 = big.run(&opts);
    println!(
        "digitize 1600x1200 → 640x480, 8 colours: {:.1} ms → {} threads, {} objects",
        t.elapsed().as_secs_f64() * 1000.0,
        r2.threads.len(),
        r2.objects.len()
    );
    assert_eq!(r2.threads.len(), r.threads.len());
}

#[test]
fn palette_snapping_and_transparency() {
    use filum_core::threads::PaletteEntry;
    // transparent background, two shapes
    let mut img = Img::new(200, 200, [0, 0, 0]);
    for p in img.px.chunks_exact_mut(4) {
        p[3] = 0;
    }
    let mut opaque = |x0: usize, x1: usize, c: [u8; 3]| {
        for y in 50..150 {
            for x in x0..x1 {
                let i = (y * 200 + x) * 4;
                img.px[i..i + 4].copy_from_slice(&[c[0], c[1], c[2], 255]);
            }
        }
    };
    opaque(20, 90, [200, 30, 30]);
    opaque(110, 180, [205, 35, 25]);
    let palette = vec![
        PaletteEntry { name: "Red".into(), code: "1037".into(), rgb: [200, 16, 46] },
        PaletteEntry { name: "Blue".into(), code: "1076".into(), rgb: [35, 79, 181] },
    ];
    let opts = DigitizeOptions { palette, palette_brand: "Madeira".into(), width_mm: 50.0, ..Default::default() };
    let r = img.run(&opts);
    assert_eq!(r.threads.len(), 1);
    assert_eq!(r.threads[0].code, "1037");
    assert_eq!(r.threads[0].brand, "Madeira");
    assert_eq!(r.objects.len(), 2);
    assert_eq!(r.objects[0].name, "Red 1");
    assert_eq!(r.objects[1].name, "Red 2");
}

#[test]
fn antialiased_edges_do_not_create_extra_colours() {
    // 4×4 supersampled circle: the edge pixels are pink blends of red/white
    let (w, h) = (300usize, 240usize);
    let mut img = Img::new(w, h, [255, 255, 255]);
    for y in 0..h {
        for x in 0..w {
            let mut cov = 0.0;
            for sy in 0..4 {
                for sx in 0..4 {
                    let (px, py) = (x as f64 + (sx as f64 + 0.5) / 4.0, y as f64 + (sy as f64 + 0.5) / 4.0);
                    if (px - 150.0).powi(2) + (py - 120.0).powi(2) <= 80.0 * 80.0 {
                        cov += 1.0 / 16.0;
                    }
                }
            }
            let mix = |a: f64, b: f64| (a * cov + b * (1.0 - cov)).round() as u8;
            img.set(x, y, [mix(200.0, 255.0), mix(20.0, 255.0), mix(40.0, 255.0)]);
        }
    }
    let r = img.run(&DigitizeOptions { colors: 6, ..Default::default() });
    assert_eq!(r.threads.len(), 1, "{:?}", r.threads);
    assert_eq!(r.objects.len(), 1);
    assert!(matches!(r.objects[0].stitch, StitchParams::Fill(_)));
}

#[test]
fn decodes_png() {
    use filum_core::digitize::digitize_image;
    let mut buf = image::RgbaImage::from_pixel(120, 80, image::Rgba([255, 255, 255, 255]));
    for y in 20..60 {
        for x in 30..90 {
            buf.put_pixel(x, y, image::Rgba([20, 120, 60, 255]));
        }
    }
    let mut png = Vec::new();
    buf.write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png).unwrap();
    let r = digitize_image(&png, &DigitizeOptions { width_mm: 60.0, ..Default::default() }).unwrap();
    assert_eq!(r.objects.len(), 1);
    let b = r.objects[0].bounds();
    assert!((b.min_x - 15.0).abs() < 0.5 && (b.max_x - 45.0).abs() < 0.5, "{b:?}");
    assert!(digitize_image(b"not an image", &DigitizeOptions::default()).is_err());
}

// ---------------------------------------------------------------------------
// Options added for the upgraded digitize dialog

fn two_shapes() -> Img {
    let mut img = Img::new(400, 300, [255, 255, 255]);
    img.paint([220, 20, 30], |x, y| (x - 120.0).powi(2) + (y - 150.0).powi(2) <= 60.0 * 60.0);
    img.paint([30, 60, 200], |x, y| (240.0..360.0).contains(&x) && (90.0..210.0).contains(&y));
    img
}

#[test]
fn colour_info_and_preview() {
    let img = two_shapes();
    let opts = DigitizeOptions { width_mm: 100.0, ..Default::default() };
    let r = img.run(&opts);
    assert_eq!(r.colors.len(), 3, "white, red, blue");
    let sum: f64 = r.colors.iter().map(|c| c.coverage).sum();
    assert!((sum - 1.0).abs() < 1e-6);
    assert_eq!(r.colors.iter().filter(|c| c.background).count(), 1);
    assert!((r.width_mm - 100.0).abs() < 1e-9 && (r.height_mm - 75.0).abs() < 1e-9);
    let p = filum_core::digitize::digitize_preview_rgba(&img.px, 400, 300, &opts);
    assert_eq!(p.rgba.len(), (p.width * p.height * 4) as usize);
    assert_eq!(p.colors, r.colors);
    // background pixel is transparent, circle centre is opaque red
    assert_eq!(p.rgba[3], 0);
    let i = ((150 * p.width + 120) * 4) as usize;
    assert!(p.rgba[i] > 150 && p.rgba[i + 3] == 255);
}

#[test]
fn skip_colours_and_fixed_palette() {
    let img = two_shapes();
    let skip = DigitizeOptions { width_mm: 100.0, skip_colors: vec![[200, 0, 0]], ..Default::default() };
    let r = img.run(&skip);
    assert_eq!(r.objects.len(), 1, "red dropped");
    assert!(rgb(&r.objects[0], &r)[2] > 150);

    let fixed = DigitizeOptions {
        width_mm: 100.0,
        fixed_colors: vec![[255, 255, 255], [255, 0, 0], [0, 0, 255]],
        ..Default::default()
    };
    let r = img.run(&fixed);
    assert_eq!(r.colors.iter().map(|c| c.rgb).collect::<Vec<_>>(), fixed.fixed_colors);
    let mut cols: Vec<String> = r.threads.iter().map(|t| t.color.clone()).collect();
    cols.sort();
    assert_eq!(cols, vec!["#0000ff", "#ff0000"]);
}

#[test]
fn stitch_type_switches_and_fill_settings() {
    let mut img = Img::new(400, 300, [255, 255, 255]);
    img.paint([25, 25, 60], |x, y| seg_dist(x, y, (50.0, 60.0), (350.0, 240.0)) <= 4.0);
    let opts = DigitizeOptions {
        width_mm: 100.0,
        allow_satin: false,
        fill_method: filum_core::FillMethod::Contour,
        fill_angle: Some(15.0),
        row_spacing: 0.4,
        underlay: false,
        ..Default::default()
    };
    let r = img.run(&opts);
    assert_eq!(r.objects.len(), 1);
    let StitchParams::Fill(f) = &r.objects[0].stitch else { panic!("expected fill") };
    assert_eq!(f.method, filum_core::FillMethod::Contour);
    assert_eq!((f.angle, f.row_spacing, f.underlay), (15.0, 0.4, false));
}

#[test]
fn satin_outline_around_silhouette() {
    let img = two_shapes();
    let opts = DigitizeOptions {
        width_mm: 100.0,
        outline: filum_core::digitize::OutlineKind::Satin,
        outline_width_mm: 1.6,
        outline_color: [10, 10, 10],
        ..Default::default()
    };
    let r = img.run(&opts);
    let outlines: Vec<&Object> = r.objects.iter().filter(|o| o.name.starts_with("Outline")).collect();
    assert_eq!(outlines.len(), 2, "one per separate shape");
    assert!(r.objects.last().unwrap().name.starts_with("Outline"), "outlines are sewn last");
    for o in &outlines {
        assert!(o.paths[0].closed);
        assert!(matches!(&o.stitch, StitchParams::Satin(s) if (s.width - 1.6).abs() < 1e-9));
        assert_eq!(rgb(o, &r), [10, 10, 10]);
    }
    // the closed centre-line satin stitches without a seam gap
    let mut doc = filum_core::Document::default();
    doc.threads = r.threads.clone();
    doc.objects = outlines.iter().map(|o| (*o).clone()).collect();
    let plan = filum_core::Engine::new().plan(&doc);
    assert!(plan.stats(800.0, 6.0, 12.0).stitches > 400);
}

#[test]
fn outline_skips_thin_strokes() {
    let mut img = Img::new(400, 300, [255, 255, 255]);
    img.paint([220, 20, 30], |x, y| (x - 120.0).powi(2) + (y - 150.0).powi(2) <= 60.0 * 60.0);
    img.paint([25, 25, 60], |x, y| seg_dist(x, y, (220.0, 60.0), (380.0, 260.0)) <= 4.0);
    let opts = DigitizeOptions {
        width_mm: 100.0,
        outline: filum_core::digitize::OutlineKind::Running,
        ..Default::default()
    };
    let r = img.run(&opts);
    assert!(r.objects.iter().any(|o| matches!(o.stitch, StitchParams::Satin(_)) && !o.name.starts_with("Outline")));
    assert_eq!(r.objects.iter().filter(|o| o.name.starts_with("Outline")).count(), 1, "only the filled circle is outlined");
}

// ---------------------------------------------------------------------------
// Vision features

use filum_core::digitize::{FillDirection, LineArt, MaskMode, OutlineKind, PixelArt, SegMask};
use filum_core::FillMethod;

fn fills(r: &DigitizeResult) -> Vec<&Object> {
    r.objects.iter().filter(|o| matches!(o.stitch, StitchParams::Fill(_))).collect()
}

#[test]
fn seamless_neighbours_share_their_boundary() {
    // two touching rectangles on white
    let mut img = Img::new(120, 80, [255, 255, 255]);
    img.paint([200, 30, 40], |x, y| (10.0..60.0).contains(&x) && (10.0..70.0).contains(&y));
    img.paint([30, 60, 200], |x, y| (60.0..110.0).contains(&x) && (10.0..70.0).contains(&y));
    let opts = DigitizeOptions { overlap_mm: 0.0, width_mm: 120.0, denoise: 0, ..Default::default() };
    let r = img.run(&opts);
    let f = fills(&r);
    assert_eq!(f.len(), 2);
    // straight edges with sharp corners: the outlines are plain polygons of few nodes
    for o in &f {
        assert!(o.paths[0].nodes.len() <= 8, "{} nodes", o.paths[0].nodes.len());
    }
    // the common edge x = 60 is identical in both shapes
    let on_edge = |o: &Object| o.paths[0].nodes.iter().filter(|n| (n.p[0] - 60.0).abs() < 1e-6).count();
    assert!(on_edge(f[0]) >= 2 && on_edge(f[1]) >= 2);
    // areas add up with no gap or overlap
    let total: f64 = f.iter().map(|o| area(o)).sum();
    assert!((total - 100.0 * 60.0).abs() < 1.0, "{total}");
}

#[test]
fn seamless_disc_is_a_few_smooth_curves() {
    let mut img = Img::new(100, 100, [255, 255, 255]);
    img.paint([20, 120, 60], |x, y| ((x - 50.0).powi(2) + (y - 50.0).powi(2)).sqrt() < 35.0);
    let r = img.run(&DigitizeOptions { overlap_mm: 0.0, width_mm: 100.0, ..Default::default() });
    let f = fills(&r);
    assert_eq!(f.len(), 1);
    let sp = &f[0].paths[0];
    assert!(sp.nodes.len() <= 16, "{} nodes", sp.nodes.len());
    assert!(sp.nodes.iter().all(|n| n.i.is_some() || n.o.is_some()));
    for p in sp.flatten(0.05) {
        let d = ((p.x - 50.0).powi(2) + (p.y - 50.0).powi(2)).sqrt();
        assert!((d - 35.0).abs() < 0.8, "radius {d}");
    }
}

#[test]
fn pixel_art_diagonals_become_smooth() {
    // a 16 × 16 sprite: a diagonal bar, 2 px thick
    let mut img = Img::new(16, 16, [255, 255, 255]);
    img.paint([0, 0, 0], |x, y| (x - y).abs() < 1.6 && (2.0..14.0).contains(&x));
    let r = img.run(&DigitizeOptions { pixel_art: PixelArt::On, width_mm: 40.0, overlap_mm: 0.0, allow_satin: false, ..Default::default() });
    let f = fills(&r);
    assert_eq!(f.len(), 1, "{:?}", r.objects.iter().map(|o| &o.name).collect::<Vec<_>>());
    // a smooth diagonal, not a staircase of tiny steps
    assert!(f[0].paths[0].nodes.len() < 16, "{} nodes", f[0].paths[0].nodes.len());
}

#[test]
fn gradients_become_gradient_fills() {
    let mut img = Img::new(120, 80, [255, 255, 255]);
    for y in 10..70 {
        for x in 10..110 {
            let t = (x - 10) as f64 / 100.0;
            img.set(x, y, [(30.0 + 200.0 * t) as u8, 60, (220.0 - 180.0 * t) as u8]);
        }
    }
    let r = img.run(&DigitizeOptions { gradients: true, width_mm: 120.0, ..Default::default() });
    let g: Vec<&Object> = r.objects.iter().filter(|o| matches!(&o.stitch, StitchParams::Fill(f) if f.gradient.is_some())).collect();
    assert_eq!(g.len(), 2, "{:?}", r.objects.iter().map(|o| &o.name).collect::<Vec<_>>());
    let (StitchParams::Fill(a), StitchParams::Fill(b)) = (&g[0].stitch, &g[1].stitch) else { unreachable!() };
    let (ga, gb) = (a.gradient.as_ref().unwrap(), b.gradient.as_ref().unwrap());
    assert_eq!(ga.group, gb.group);
    assert_eq!((ga.layer, gb.layer), (0, 1));
    // the ramp runs left to right
    assert!((ga.to[0] - ga.from[0]).abs() > 80.0, "{:?} {:?}", ga.from, ga.to);
    assert_ne!(g[0].thread, g[1].thread);
}

#[test]
fn gradients_can_follow_the_flow() {
    let mut img = Img::new(120, 80, [255, 255, 255]);
    for y in 10..70 {
        for x in 10..110 {
            let t = (x - 10) as f64 / 100.0;
            img.set(x, y, [(30.0 + 200.0 * t) as u8, 60, (220.0 - 180.0 * t) as u8]);
        }
    }
    let r = img.run(&DigitizeOptions { gradients: true, gradient_flow: true, width_mm: 120.0, ..Default::default() });
    let g: Vec<&Object> = r.objects.iter().filter(|o| matches!(&o.stitch, StitchParams::Fill(f) if f.gradient.is_some())).collect();
    assert_eq!(g.len(), 2);
    for o in &g {
        let StitchParams::Fill(f) = &o.stitch else { unreachable!() };
        assert_eq!(f.method, FillMethod::Flow);
        assert!(f.flow.is_some());
    }
    // both layers are sewn, together covering the area
    let doc = filum_core::Document { objects: r.objects.clone(), threads: r.threads.clone(), ..Default::default() };
    let n = |o: &Object| filum_core::Engine::new().plan(&filum_core::Document { objects: vec![o.clone()], ..doc.clone() }).stitches.len();
    assert!(n(g[0]) > 200 && n(g[1]) > 200, "{} {}", n(g[0]), n(g[1]));
    // off: straight rows as before
    let r = img.run(&DigitizeOptions { gradients: true, width_mm: 120.0, ..Default::default() });
    assert!(r.objects.iter().all(|o| !matches!(&o.stitch, StitchParams::Fill(f) if f.method == FillMethod::Flow)));
}

#[test]
fn masks_keep_and_separate() {
    let mut img = Img::new(100, 50, [255, 255, 255]);
    img.paint([200, 30, 40], |x, y| (5.0..45.0).contains(&x) && (5.0..45.0).contains(&y));
    img.paint([200, 30, 40], |x, y| (55.0..95.0).contains(&x) && (5.0..45.0).contains(&y));
    // keep only the left half
    let mut m = vec![0u8; 100 * 50];
    for y in 0..50 {
        for x in 0..50 {
            m[y * 100 + x] = 255;
        }
    }
    let b64 = base64(&m);
    let keep = SegMask { mode: MaskMode::Keep, width: 100, height: 50, data: b64.clone() };
    let r = img.run(&DigitizeOptions { width_mm: 100.0, masks: vec![keep], ..Default::default() });
    assert_eq!(fills(&r).len(), 1);
    // a separate mask splits one colour area in two objects
    let mut one = Img::new(100, 50, [255, 255, 255]);
    one.paint([200, 30, 40], |x, y| (5.0..95.0).contains(&x) && (5.0..45.0).contains(&y));
    let sep = SegMask { mode: MaskMode::Separate, width: 100, height: 50, data: b64 };
    let r = one.run(&DigitizeOptions { width_mm: 100.0, masks: vec![sep], ..Default::default() });
    assert_eq!(fills(&r).len(), 2);
}

fn base64(bytes: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for c in bytes.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        for k in 0..4 {
            if k <= c.len() {
                out.push(T[(n >> (18 - 6 * k) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

#[test]
fn edge_outlines_line_art_and_flow() {
    let mut img = Img::new(120, 80, [250, 250, 245]);
    img.paint([240, 200, 40], |x, y| ((x - 40.0).powi(2) + (y - 40.0).powi(2)).sqrt() < 30.0);
    img.paint([30, 90, 200], |x, y| (60.0..110.0).contains(&x) && (15.0..65.0).contains(&y));
    // contrast outlines around both shapes
    let r = img.run(&DigitizeOptions { width_mm: 120.0, edge_outlines: OutlineKind::Running, edge_contrast: 20.0, ..Default::default() });
    assert!(r.objects.iter().any(|o| o.name.starts_with("Edge outline")), "{:?}", r.objects.iter().map(|o| &o.name).collect::<Vec<_>>());
    // coherent line art traces the shapes' edges
    let r = img.run(&DigitizeOptions { width_mm: 120.0, line_art: LineArt::Coherent, ..Default::default() });
    assert!(r.objects.iter().any(|o| o.name.starts_with("Line art")));
    // flow fills carry a direction field
    let r = img.run(&DigitizeOptions { width_mm: 120.0, fill_direction: FillDirection::Flow, ..Default::default() });
    assert!(fills(&r).iter().all(|o| matches!(&o.stitch, StitchParams::Fill(f) if f.method == FillMethod::Flow && f.flow.is_some())));
    // and the engine sews them
    let plan = filum_core::Engine::new().plan(&filum_core::Document { objects: r.objects.clone(), threads: r.threads.clone(), ..Default::default() });
    assert!(plan.stitches.len() > 500, "{}", plan.stitches.len());
}

#[test]
fn flow_is_a_fill_method_with_its_own_controls() {
    let mut img = Img::new(120, 80, [250, 250, 245]);
    img.paint([240, 200, 40], |x, y| ((x - 40.0).powi(2) + (y - 40.0).powi(2)).sqrt() < 30.0);
    img.paint([30, 90, 200], |x, y| (60.0..110.0).contains(&x) && (15.0..65.0).contains(&y));
    let flows = |o: &DigitizeOptions| -> Vec<filum_core::model::FlowField> {
        let r = img.run(o);
        fills(&r)
            .iter()
            .map(|o| match &o.stitch {
                StitchParams::Fill(f) if f.method == FillMethod::Flow => f.flow.clone().expect("field"),
                _ => panic!("not a flow fill"),
            })
            .collect()
    };
    // the fill method alone makes flow fills, with a fixed base angle too
    let base = DigitizeOptions { width_mm: 120.0, fill_method: FillMethod::Flow, ..Default::default() };
    let full = flows(&base);
    assert!(!full.is_empty());
    assert!(!flows(&DigitizeOptions { fill_angle: Some(30.0), ..base.clone() }).is_empty());
    // detail: fewer cells across each shape
    let coarse = flows(&DigitizeOptions { flow_detail: 8.0, ..base.clone() });
    assert!(coarse[0].cols * coarse[0].rows < full[0].cols * full[0].rows);
    // strength 0: every cell is the base direction (here a fixed 30°)
    let flat = flows(&DigitizeOptions { flow_strength: 0.0, fill_angle: Some(30.0), ..base.clone() });
    let want = -(30f32).to_radians();
    for f in &flat {
        for a in &f.angles {
            let d = (2.0 * (a - want)).sin().abs();
            assert!(d < 1e-3, "{a} vs {want}");
        }
    }
    // smoothing is accepted and still sews
    assert!(!flows(&DigitizeOptions { flow_smoothing: 5, ..base.clone() }).is_empty());
}



#[test]
#[ignore]
fn profile_photo() {
    let path = std::env::var("DZ_IMAGE").expect("DZ_IMAGE");
    let bytes = std::fs::read(path).unwrap();
    let opts = DigitizeOptions {
        width_mm: 140.0,
        colors: 10,
        smoothing: 1,
        denoise: 2,
        merge_delta_e: 4.0,
        min_region_mm2: 2.0,
        fill_direction: if std::env::var("DZ_AXIS").is_ok() { FillDirection::Axis } else { FillDirection::Flow },
        gradients: std::env::var("DZ_NOGRAD").is_err(),
        row_spacing: 0.3,
        remove_background: false,
        pixel_art: PixelArt::Off,
        ..Default::default()
    };
    let t = std::time::Instant::now();
    let r = filum_core::digitize::digitize_image(&bytes, &opts).unwrap();
    eprintln!("digitize: {:?}, {} objects", t.elapsed(), r.objects.len());
    let t = std::time::Instant::now();
    let plan = filum_core::Engine::new().plan(&filum_core::Document { objects: r.objects.clone(), threads: r.threads.clone(), ..Default::default() });
    eprintln!("plan: {:?}, {} stitches", t.elapsed(), plan.stitches.len());
}

#[test]
#[ignore]
fn profile_sketch() {
    let bytes = std::fs::read(std::env::var("DZ_IMAGE").expect("DZ_IMAGE")).unwrap();
    let opts = DigitizeOptions {
        width_mm: 140.0,
        colors: 4,
        denoise: 2,
        line_art: LineArt::Coherent,
        line_strength: 0.5,
        fill_method: FillMethod::Meander,
        row_spacing: 1.6,
        underlay: false,
        remove_background: false,
        pixel_art: PixelArt::Off,
        allow_satin: false,
        allow_running: false,
        ..Default::default()
    };
    let r = filum_core::digitize::digitize_image(&bytes, &opts).unwrap();
    eprintln!("{} objects", r.objects.len());
    let plan = filum_core::Engine::new().plan(&filum_core::Document { objects: r.objects.clone(), threads: r.threads.clone(), ..Default::default() });
    eprintln!("{} stitches", plan.stitches.len());
}

#[test]
fn line_art_touching_the_border() {
    let mut img = Img::new(80, 60, [250, 250, 245]);
    img.paint([20, 30, 90], |x, y| x < 30.0 || y < 8.0);
    img.paint([200, 40, 40], |x, y| ((x - 60.0).powi(2) + (y - 60.0).powi(2)).sqrt() < 25.0);
    for la in [LineArt::Coherent] {
        let r = img.run(&DigitizeOptions { width_mm: 80.0, line_art: la, edge_outlines: OutlineKind::Running, ..Default::default() });
        assert!(!r.objects.is_empty());
    }
}

#[test]
fn erase_mask_paints_over_with_surroundings() {
    // a dark word-like block inside a blue banner
    let mut img = Img::new(100, 40, [255, 255, 255]);
    img.paint([40, 80, 200], |x, y| (5.0..95.0).contains(&x) && (5.0..35.0).contains(&y));
    img.paint([10, 10, 10], |x, y| (35.0..65.0).contains(&x) && (14.0..26.0).contains(&y));
    let mut m = vec![0u8; 100 * 40];
    for y in 12..28 {
        for x in 33..67 {
            m[y * 100 + x] = 255;
        }
    }
    let erase = SegMask { mode: MaskMode::Erase, width: 100, height: 40, data: base64(&m) };
    let r = img.run(&DigitizeOptions { width_mm: 100.0, overlap_mm: 0.0, masks: vec![erase], ..Default::default() });
    let f = fills(&r);
    assert_eq!(f.len(), 1, "{:?}", r.objects.iter().map(|o| &o.name).collect::<Vec<_>>());
    // the banner has no hole
    assert!((area(f[0]) - 90.0 * 30.0).abs() < 30.0, "{}", area(f[0]));
}

/// The region decision at a point (0..1) of the preview.
fn reason_at(p: &filum_core::digitize::DigitizePreview, fx: f64, fy: f64) -> u8 {
    let (w, h) = (p.region_width as usize, p.region_height as usize);
    let (x, y) = (((fx * w as f64) as usize).min(w - 1), ((fy * h as f64) as usize).min(h - 1));
    p.region_reason[p.regions[y * w + x] as usize]
}

#[test]
fn background_removal_is_per_region_and_editable() {
    use filum_core::digitize::{digitize_preview_rgba, reason, BackgroundScope, RegionEdit};
    // white background, a black ring with a white centre and a black disc with a
    // small white highlight (like an eye)
    let mut img = Img::new(300, 300, [255, 255, 255]);
    img.paint([20, 20, 20], |x, y| {
        let d = ((x - 150.0).powi(2) + (y - 150.0).powi(2)).sqrt();
        (50.0..=100.0).contains(&d) || (x - 40.0).powi(2) + (y - 40.0).powi(2) <= 25.0 * 25.0
    });
    img.paint([255, 255, 255], |x, y| (x - 46.0).powi(2) + (y - 34.0).powi(2) <= 5.0 * 5.0);
    let preview = |o: &DigitizeOptions| digitize_preview_rgba(&img.px, 300, 300, o);
    let base = DigitizeOptions { width_mm: 60.0, ..Default::default() };

    // outside only (default): the surrounding white is not stitched, nor the ring's
    // centre (a plain hole: the fabric shows); the highlight is
    let p = preview(&base);
    assert_eq!(reason_at(&p, 0.5, 0.5), reason::BACKGROUND, "the ring's hole");
    assert_eq!(reason_at(&p, 46.0 / 300.0, 34.0 / 300.0), reason::STITCHED, "the highlight");
    assert_eq!(reason_at(&p, 0.02, 0.02), reason::BACKGROUND);
    assert_eq!(reason_at(&p, 0.5, 0.25), reason::STITCHED, "the ring");
    let r = img.run(&base);
    assert_eq!(r.threads.len(), 2, "black and the white highlight");
    let white = r.colors.iter().find(|c| c.rgb[0] > 200).unwrap();
    assert!(white.background && white.removed > 0.5 && white.removed < white.coverage);

    // everywhere: the highlight is a hole too
    let all = DigitizeOptions { background_scope: BackgroundScope::Everywhere, ..base.clone() };
    assert_eq!(reason_at(&preview(&all), 46.0 / 300.0, 34.0 / 300.0), reason::BACKGROUND);
    assert_eq!(img.run(&all).threads.len(), 1);

    // clicks: stitch the ring's hole and the outside, leave the highlight out
    let edited = DigitizeOptions {
        region_edits: vec![
            RegionEdit { x: 0.5, y: 0.5, keep: true },
            RegionEdit { x: 0.02, y: 0.02, keep: true },
            RegionEdit { x: 46.0 / 300.0, y: 34.0 / 300.0, keep: false },
        ],
        ..base.clone()
    };
    let p = preview(&edited);
    assert_eq!(reason_at(&p, 0.5, 0.5), reason::STITCHED);
    assert_eq!(reason_at(&p, 46.0 / 300.0, 34.0 / 300.0), reason::EDIT);
    assert_eq!(reason_at(&p, 0.02, 0.02), reason::STITCHED);
    let r = img.run(&edited);
    let fills_white: f64 = r.objects.iter().filter(|o| rgb(o, &r)[0] > 200).map(area).sum();
    assert!(fills_white > 60.0 * 60.0 * 0.5, "the outside white is stitched now: {fills_white}");

    // a dropped colour wins over the scope; a click brings one region back
    let dropped = DigitizeOptions { skip_colors: vec![[20, 20, 20]], ..base.clone() };
    assert_eq!(reason_at(&preview(&dropped), 0.5, 0.25), reason::COLOUR);
    let back = DigitizeOptions { region_edits: vec![RegionEdit { x: 0.5, y: 0.25, keep: true }], ..dropped };
    assert_eq!(reason_at(&preview(&back), 0.5, 0.25), reason::STITCHED);
}

/// Line objects (satin columns and running lines) with their half widths.
fn line_objects(r: &DigitizeResult) -> Vec<(&Object, f64, Vec<Point>)> {
    r.objects
        .iter()
        .filter_map(|o| match &o.stitch {
            StitchParams::Satin(s) => Some((o, s.width / 2.0, points(o))),
            StitchParams::Running(_) => Some((o, 0.0, points(o))),
            _ => None,
        })
        .collect()
}

fn dist_to_polyline(p: Point, pts: &[Point]) -> f64 {
    pts.windows(2).map(|w| seg_dist(p.x, p.y, (w[0].x, w[0].y), (w[1].x, w[1].y))).fold(f64::INFINITY, f64::min)
}

#[test]
fn line_recognitions_never_double_up() {
    // a cartoon: a red disc with a thick black outline stroke, a blue square
    // and a thin black line — every line source switched on at once
    let mut img = Img::new(400, 300, [255, 255, 255]);
    img.paint([220, 20, 30], |x, y| (x - 130.0).powi(2) + (y - 150.0).powi(2) <= 80.0 * 80.0);
    img.paint([15, 15, 15], |x, y| {
        let d = ((x - 130.0).powi(2) + (y - 150.0).powi(2)).sqrt();
        (80.0..=88.0).contains(&d)
    });
    img.paint([30, 60, 200], |x, y| (250.0..360.0).contains(&x) && (90.0..210.0).contains(&y));
    img.paint([250, 210, 20], |x, y| (280.0..330.0).contains(&x) && (120.0..180.0).contains(&y));
    img.paint([15, 15, 15], |x, y| seg_dist(x, y, (240.0, 250.0), (380.0, 250.0)) <= 1.5);
    let opts = DigitizeOptions {
        width_mm: 100.0,
        edge_outlines: OutlineKind::Running,
        edge_contrast: 20.0,
        outline: OutlineKind::Running,
        line_art: LineArt::Coherent,
        line_strength: 0.8,
        ..Default::default()
    };
    let r = img.run(&opts);
    let mut lines = line_objects(&r);
    // the black ring is a line of the picture: a satin stroke (or, without
    // line networks, a narrow fill whose boundaries count as lines)
    let ring_fill = r.objects.iter().find(|o| matches!(o.stitch, StitchParams::Fill(_)) && rgb(o, &r).iter().all(|c| *c < 60));
    let ring_stroke = lines.iter().any(|(o, _, _)| matches!(o.stitch, StitchParams::Satin(_)) && rgb(o, &r).iter().all(|c| *c < 60));
    assert!(ring_fill.is_some() || ring_stroke, "black ring");
    if let Some(ring) = ring_fill {
        for sp in &ring.paths {
            lines.push((ring, 0.0, sp.flatten(0.05)));
        }
    }
    let added = |o: &Object| o.name.starts_with("Edge outline") || o.name.starts_with("Outline") || o.name.starts_with("Line art");
    assert!(lines.iter().any(|(o, _, _)| o.name.starts_with("Edge outline")), "the yellow / blue edge is outlined");
    // no added line runs along another line
    for (i, (a, ha, pa)) in lines.iter().enumerate() {
        for (j, (b, hb, pb)) in lines.iter().enumerate() {
            if i == j || !added(a) || pa.is_empty() || pb.len() < 2 || std::ptr::eq(*a, *b) {
                continue;
            }
            let near = pa.iter().filter(|p| dist_to_polyline(**p, pb) < ha + hb + 0.3).count() as f64 / pa.len() as f64;
            assert!(near < 0.25, "{} runs along {} ({:.0} % of it)", a.name, b.name, near * 100.0);
        }
    }
    // without the other sources the same edges are all there
    let only_edges = DigitizeOptions { edge_outlines: OutlineKind::Running, edge_contrast: 20.0, allow_satin: false, allow_running: false, ..opts.clone() };
    let only_edges = DigitizeOptions { outline: OutlineKind::None, line_art: LineArt::None, ..only_edges };
    assert!(img.run(&only_edges).objects.iter().filter(|o| o.name.starts_with("Edge outline")).count() >= 2);
}

#[test]
fn pale_shading_does_not_break_the_outline() {
    // a peach disc with a pale shading band along its rim (like a sticker's
    // highlight): the band is narrow, but it is shading, not an ink line, so
    // the edge outline around the design stays one continuous line
    let mut img = Img::new(400, 400, [255, 255, 255]);
    img.paint([240, 160, 120], |x, y| (x - 200.0).powi(2) + (y - 200.0).powi(2) <= 150.0 * 150.0);
    img.paint([250, 215, 195], |x, y| {
        let d = ((x - 200.0).powi(2) + (y - 200.0).powi(2)).sqrt();
        (139.0..=146.0).contains(&d) && y < 260.0
    });
    let opts = DigitizeOptions { width_mm: 100.0, edge_outlines: OutlineKind::Satin, edge_contrast: 26.0, allow_satin: false, allow_running: false, ..Default::default() };
    let r = img.run(&opts);
    let rim = 2.0 * std::f64::consts::PI * 150.0 * 0.25; // mm
    let longest = r
        .objects
        .iter()
        .filter(|o| o.name.starts_with("Edge outline"))
        .map(|o| o.paths.iter().map(|sp| { let p = sp.flatten(0.05); p.windows(2).map(|w| w[0].dist(w[1])).sum::<f64>() }).sum::<f64>())
        .fold(0.0, f64::max);
    assert!(longest > rim * 0.95, "outline {longest:.1} of {rim:.1} mm");
}

/// A cartoon face: a yellow disc with a black outline, crossed by a black
/// line (junctions with the ring) and two eye strokes.
fn cartoon() -> Img {
    let mut img = Img::new(400, 300, [255, 255, 255]);
    img.paint([250, 205, 40], |x, y| (x - 200.0).powi(2) + (y - 150.0).powi(2) <= 100.0 * 100.0);
    img.paint([15, 15, 15], |x, y| {
        let d = ((x - 200.0).powi(2) + (y - 150.0).powi(2)).sqrt();
        (97.0..=103.0).contains(&d)
    });
    // a branch: a horizontal line through the disc, touching the ring on both sides
    img.paint([15, 15, 15], |x, y| seg_dist(x, y, (100.0, 190.0), (300.0, 190.0)) <= 3.0);
    // eyes
    img.paint([15, 15, 15], |x, y| seg_dist(x, y, (165.0, 100.0), (165.0, 135.0)) <= 3.0);
    img.paint([15, 15, 15], |x, y| seg_dist(x, y, (235.0, 100.0), (235.0, 135.0)) <= 3.0);
    img
}

#[test]
fn line_networks_become_strokes_with_fills_under_them() {
    let img = cartoon();
    // the strokes as found (routing cuts them where they meet: see below)
    let opts = DigitizeOptions { width_mm: 100.0, colors: 3, route_lines: false, ..Default::default() };
    let r = img.run(&opts);
    let dark = |o: &Object| rgb(o, &r).iter().all(|c| *c < 70);
    // the black line drawing is strokes, not a narrow fill
    assert!(!r.objects.iter().any(|o| dark(o) && matches!(o.stitch, StitchParams::Fill(_))), "{:?}", r.objects.iter().map(|o| &o.name).collect::<Vec<_>>());
    let strokes: Vec<&Object> = r.objects.iter().filter(|o| dark(o)).collect();
    // ring + crossing line + two eyes: a handful of long strokes, not dozens of pieces
    assert!((3..=6).contains(&strokes.len()), "{} strokes: {:?}", strokes.len(), strokes.iter().map(|o| &o.name).collect::<Vec<_>>());
    // the ring runs through its junctions with the crossing line: one closed stroke
    assert!(strokes.iter().any(|o| o.paths.iter().any(|sp| sp.closed) || o.paths.len() == 2 && polyline_len(o) > 120.0), "the ring is one stroke");
    // the yellow fill reaches under the black ring (no gap between fill and line)
    let yellow: Vec<&Object> = r.objects.iter().filter(|o| rgb(o, &r)[0] > 200 && rgb(o, &r)[2] < 120).collect();
    let span = yellow.iter().flat_map(|o| points(o)).fold((f64::MAX, f64::MIN), |a, p| (a.0.min(p.x), a.1.max(p.x)));
    assert!(span.1 - span.0 > 2.0 * 99.0 * 0.25, "yellow spans {:.1} mm", span.1 - span.0);
    // the engine sews every stroke (two-rail satins too)
    let plan = filum_core::Engine::new().plan(&filum_core::Document { objects: r.objects.clone(), threads: r.threads.clone(), ..Default::default() });
    assert!(plan.stitches.len() > 2000, "{}", plan.stitches.len());
    for o in strokes.iter() {
        let one = filum_core::Engine::new().plan(&filum_core::Document { objects: vec![(*o).clone()], threads: r.threads.clone(), ..Default::default() });
        assert!(one.stitches.len() > 20, "{} sews {} stitches", o.name, one.stitches.len());
    }
    // strokes are sewn after every fill
    let last_fill = r.objects.iter().rposition(|o| matches!(o.stitch, StitchParams::Fill(_))).unwrap();
    let first_stroke = r.objects.iter().position(|o| dark(o)).unwrap();
    assert!(first_stroke > last_fill);
}

fn polyline_len(o: &Object) -> f64 {
    o.paths.iter().map(|sp| filum_core::geom::polyline_length(&sp.flatten(0.1))).fold(0.0, f64::max)
}

#[test]
fn ink_lines_are_found_even_when_the_colours_merge_them() {
    // a thin dark grey line on a blue panel; two colours only: the line is
    // lost in the colour reduction, the ink detection still finds it
    let mut img = Img::new(400, 300, [255, 255, 255]);
    img.paint([40, 90, 200], |x, y| (60.0..340.0).contains(&x) && (60.0..240.0).contains(&y));
    img.paint([20, 30, 60], |x, y| seg_dist(x, y, (100.0, 150.0), (300.0, 150.0)) <= 1.2);
    let base = DigitizeOptions { width_mm: 100.0, colors: 2, ..Default::default() };
    let has_line = |r: &DigitizeResult| r.objects.iter().any(|o| o.name.contains("line") && points(o).iter().any(|p| (p.y - 37.6).abs() < 1.5));
    assert!(has_line(&img.run(&base)), "{:?}", img.run(&base).objects.iter().map(|o| &o.name).collect::<Vec<_>>());
    assert!(!has_line(&img.run(&DigitizeOptions { ink_sensitivity: 0.0, ..base.clone() })));
}

#[test]
fn line_options_change_the_strokes() {
    let img = cartoon();
    let base = DigitizeOptions { width_mm: 100.0, colors: 3, route_lines: false, ..Default::default() };
    let dark_count = |o: &DigitizeOptions| {
        let r = img.run(o);
        r.objects.iter().filter(|x| rgb(x, &r).iter().all(|c| *c < 70)).count()
    };
    // no continuation through junctions: more, shorter strokes
    assert!(dark_count(&DigitizeOptions { line_continuity: 0.0, ..base.clone() }) > dark_count(&base));
    // networks off: the old behaviour (the branched drawing is a fill)
    let r = img.run(&DigitizeOptions { line_networks: false, ..base.clone() });
    assert!(r.objects.iter().any(|o| rgb(o, &r).iter().all(|c| *c < 70) && matches!(o.stitch, StitchParams::Fill(_))));
    // thin lines as triple stitch
    let mut thin = Img::new(400, 300, [255, 255, 255]);
    thin.paint([15, 15, 15], |x, y| seg_dist(x, y, (50.0, 150.0), (350.0, 150.0)) <= 1.0);
    let r = thin.run(&DigitizeOptions { thin_triple: true, ..base.clone() });
    assert!(r.objects.iter().any(|o| matches!(&o.stitch, StitchParams::Running(p) if p.bean_repeats == 2)));
}


#[test]
fn colour_roles_force_lines_and_fills() {
    let img = cartoon();
    let base = DigitizeOptions { width_mm: 100.0, colors: 3, ..Default::default() };
    let r = img.run(&base);
    let black = r.colors.iter().find(|c| c.rgb.iter().all(|v| *v < 70)).expect("black").rgb;
    // the auto decision is reported per colour
    let bc = r.colors.iter().find(|c| c.rgb == black).unwrap();
    assert!(bc.lines > bc.coverage * 0.6, "black is sewn as lines: {} of {}", bc.lines, bc.coverage);
    // black as fill: no strokes, a fill instead
    let r = img.run(&DigitizeOptions { fill_colors: vec![black], ..base.clone() });
    let dark = |o: &Object, r: &DigitizeResult| rgb(o, r).iter().all(|c| *c < 70);
    assert!(r.objects.iter().filter(|o| dark(o, &r)).all(|o| matches!(o.stitch, StitchParams::Fill(_))));
    assert!(r.objects.iter().any(|o| dark(o, &r)));
    // a wide bar (wider than a line) marked as lines: a satin along its centre
    let mut bar = Img::new(400, 300, [255, 255, 255]);
    bar.paint([200, 30, 40], |x, y| (60.0..340.0).contains(&x) && (130.0..152.0).contains(&y)); // 5.5 mm
    let base = DigitizeOptions { allow_satin: true, satin_max_width_mm: 4.0, ..base.clone() };
    let auto = bar.run(&base);
    assert!(auto.objects.iter().all(|o| matches!(o.stitch, StitchParams::Fill(_))), "auto: a fill");
    let red = auto.colors.iter().find(|c| c.rgb[0] > 150 && c.rgb[1] < 100).unwrap().rgb;
    let forced = bar.run(&DigitizeOptions { line_colors: vec![red], ..base.clone() });
    assert!(forced.objects.iter().any(|o| matches!(o.stitch, StitchParams::Satin(_))), "{:?}", forced.objects.iter().map(|o| &o.name).collect::<Vec<_>>());
}

#[test]
fn sub_pixel_centres_keep_thin_lines_straight() {
    // an anti-aliased hairline at a shallow angle: on the pixel grid its
    // centre line staircases, sub-pixel centring follows the drawn line
    let mut img = Img::new(400, 300, [255, 255, 255]);
    let line = |x: f64| 100.0 + 0.12 * x;
    for y in 0..300 {
        for x in 0..400 {
            let (fx, fy) = (x as f64 + 0.5, y as f64 + 0.5);
            if !(30.0..370.0).contains(&fx) {
                continue;
            }
            let d = (fy - line(fx)).abs() / (1.0f64 + 0.12 * 0.12).sqrt();
            let cov = (1.6 - d).clamp(0.0, 1.0);
            if cov > 0.0 {
                let v = (255.0 * (1.0 - cov) + 20.0 * cov).round() as u8;
                img.set(x, y, [v, v, v]);
            }
        }
    }
    let dev = |opts: &DigitizeOptions| {
        let r = img.run(opts);
        let o = r.objects.iter().max_by(|a, b| polyline_len(a).partial_cmp(&polyline_len(b)).unwrap()).expect("a line");
        let s = 100.0 / 400.0;
        let pts: Vec<Point> = o.paths[0].flatten(0.02);
        let inner: Vec<&Point> = pts.iter().filter(|p| (60.0 * s..340.0 * s).contains(&p.x)).collect();
        inner.iter().map(|p| ((p.y / s) - line(p.x / s)).abs() * s).fold(0.0, f64::max)
    };
    let base = DigitizeOptions { width_mm: 100.0, colors: 2, simplify_mm: 0.02, ..Default::default() };
    let sharp = dev(&base);
    let grid = dev(&DigitizeOptions { line_subpixel: false, ..base.clone() });
    assert!(sharp < 0.12, "sub-pixel: {sharp:.3} mm off the drawn line");
    assert!(sharp <= grid + 1e-9, "sub-pixel {sharp:.3} vs grid {grid:.3}");
}

#[test]
fn line_art_from_a_drawing_map_becomes_strokes() {
    // a learned line drawing arrives as an edge map: two crossing lines
    let (mw, mh) = (200usize, 150usize);
    let mut map = vec![0u8; mw * mh];
    for x in 20..180 {
        for d in 0..2 {
            map[(75 + d) * mw + x] = 255;
        }
    }
    for y in 15..135 {
        for d in 0..2 {
            map[y * mw + 100 + d] = 255;
        }
    }
    let img = Img::new(400, 300, [240, 240, 240]);
    let mut solid = img;
    solid.paint([60, 90, 160], |x, y| (20.0..380.0).contains(&x) && (20.0..280.0).contains(&y));
    let opts = DigitizeOptions {
        width_mm: 100.0,
        colors: 2,
        remove_background: false,
        line_art: LineArt::Drawing,
        line_strength: 0.5,
        edge_map: Some(filum_core::digitize::EdgeMap { width: mw as u32, height: mh as u32, data: b64(&map) }),
        ..Default::default()
    };
    let r = solid.run(&opts);
    let art: Vec<&Object> = r.objects.iter().filter(|o| o.name.starts_with("Line art")).collect();
    let paths: usize = art.iter().map(|o| o.paths.len()).sum();
    assert_eq!(paths, 2, "two lines through the crossing: {paths}");
}

fn b64(bytes: &[u8]) -> String {
    const A: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for c in bytes.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        for k in 0..4 {
            if k <= c.len() {
                out.push(A[(n >> (18 - 6 * k) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

#[test]
fn photo_zigzag_draws_rows_of_zigzags() {
    // a dark disc fading to the edge on white
    let mut img = Img::new(200, 150, [255, 255, 255]);
    for y in 0..150 {
        for x in 0..200 {
            let d = ((x as f64 - 100.0).powi(2) + (y as f64 - 75.0).powi(2)).sqrt();
            if d < 60.0 {
                let v = (40.0 + 200.0 * d / 60.0) as u8;
                img.set(x, y, [v, v, v]);
            }
        }
    }
    let opts = DigitizeOptions { width_mm: 80.0, photo_zigzag: true, ..Default::default() };
    let r = img.run(&opts);
    assert_eq!(r.objects.len(), 1);
    let o = &r.objects[0];
    assert!(matches!(o.stitch, StitchParams::Manual(_)));
    assert!(o.paths.len() > 20, "{} rows", o.paths.len());
    // denser zigzags in the dark middle than near the light edge
    let near = |cx: f64| o.paths.iter().flat_map(|sp| &sp.nodes).filter(|n| ((n.p[0] - cx).powi(2) + (n.p[1] - 30.0).powi(2)).sqrt() < 3.0).count();
    assert!(near(40.0) as f64 > 1.5 * near(58.0) as f64, "centre {} edge {}", near(40.0), near(58.0));
    // the white outside is empty
    assert!(o.paths.iter().flat_map(|sp| &sp.nodes).all(|n| ((n.p[0] - 40.0).powi(2) + (n.p[1] - 30.0).powi(2)).sqrt() < 26.0));
    // the engine sews it
    let plan = filum_core::Engine::new().plan(&filum_core::Document { objects: r.objects.clone(), threads: r.threads.clone(), ..Default::default() });
    assert!(plan.stitches.len() > 500);
}

/// A large yellow disc with a red square overlapping its lower edge (in front of it).
fn disc_and_pot() -> Img {
    let mut img = Img::new(200, 200, [255, 255, 255]);
    img.paint([250, 210, 90], |x, y| (x - 100.0).powi(2) + (y - 90.0).powi(2) < 70.0 * 70.0);
    img.paint([200, 40, 40], |x, y| (60.0..140.0).contains(&x) && (130.0..185.0).contains(&y));
    img
}

#[test]
fn colour_order_sets_the_sew_order() {
    let img = disc_and_pot();
    let base = DigitizeOptions { colors: 3, width_mm: 50.0, ..Default::default() };
    // by default the largest colour comes first
    let r = img.run(&base);
    assert_eq!(rgb(&r.objects[0], &r)[0] > 240, true, "the disc first by default");
    // red first, then yellow
    let r = img.run(&DigitizeOptions { color_order: vec![[200, 40, 40], [250, 210, 90]], ..base.clone() });
    let reds: Vec<usize> = r.objects.iter().enumerate().filter(|(_, o)| rgb(o, &r)[1] < 100).map(|(i, _)| i).collect();
    let yellows: Vec<usize> = r.objects.iter().enumerate().filter(|(_, o)| rgb(o, &r)[1] > 150).map(|(i, _)| i).collect();
    assert!(!reds.is_empty() && !yellows.is_empty());
    assert!(reds.iter().max() < yellows.iter().min(), "every red object before every yellow one");
    // the threads follow the sew order
    assert!(r.threads[0].rgb()[1] < 100);
}

#[test]
fn satin_edge_in_the_colours_own_thread() {
    let img = disc_and_pot();
    let base = DigitizeOptions { colors: 3, width_mm: 50.0, outline_width_mm: 1.5, ..Default::default() };
    let r = img.run(&DigitizeOptions { edge_colors: vec![[250, 210, 90]], ..base.clone() });
    let edges: Vec<&Object> = r.objects.iter().filter(|o| matches!(o.stitch, StitchParams::Satin(_)) && rgb(o, &r)[1] > 150).collect();
    assert_eq!(edges.len(), 1, "one satin edge round the disc");
    // along the disc's edge to the background (radius 70 px → 17.5 mm), not where the
    // square lies against it: an open arc that ends at the square
    let pts = points(edges[0]);
    let mm = 50.0 / 200.0;
    let (cx, cy, rad) = (100.0 * mm, 90.0 * mm, 70.0 * mm);
    for p in &pts {
        let d = ((p.x - cx).powi(2) + (p.y - cy).powi(2)).sqrt();
        assert!((d - rad).abs() < 0.8, "on the disc's rim ({d} vs {rad})");
    }
    assert!(pts.iter().all(|p| p.y < 185.0 * mm), "not below the square");
    let lowest = pts.iter().map(|p| p.y).fold(f64::MIN, f64::max);
    // the rim meets the square's sides at y = 90 + √(70² − 40²) ≈ 147 px
    assert!((lowest - 147.4 * mm).abs() < 1.0, "ends where the square covers the disc, {lowest}");
    // the same thread as the disc's fill
    let disc = r.objects.iter().find(|o| matches!(o.stitch, StitchParams::Fill(_)) && rgb(o, &r)[1] > 150).unwrap();
    assert_eq!(disc.thread, edges[0].thread);
}

#[test]
fn outlines_at_a_set_width_sew_as_one_network() {
    // a grid drawing at a fixed outline width: every dark line a satin of
    // that width, the whole network sewn with fewer trims than line by line
    // a frame with three bars down and one across (T and X junctions)
    let mut img = Img::new(400, 300, [255, 255, 255]);
    let ink = [15u8, 15, 15];
    let bars: Vec<((f64, f64), (f64, f64))> = vec![
        ((50.0, 50.0), (350.0, 50.0)),
        ((350.0, 50.0), (350.0, 250.0)),
        ((350.0, 250.0), (50.0, 250.0)),
        ((50.0, 250.0), (50.0, 50.0)),
        ((125.0, 50.0), (125.0, 250.0)),
        ((200.0, 50.0), (200.0, 250.0)),
        ((275.0, 50.0), (275.0, 250.0)),
        ((50.0, 150.0), (350.0, 150.0)),
    ];
    for (a, b) in bars {
        img.paint(ink, |x, y| seg_dist(x, y, a, b) <= 3.0);
    }
    let opts = DigitizeOptions { width_mm: 100.0, colors: 2, outline_line_mm: 1.4, ..Default::default() };
    let r = img.run(&opts);
    let dark = |o: &Object| rgb(o, &r).iter().all(|c| *c < 70);
    let satins: Vec<&Object> = r.objects.iter().filter(|o| dark(o) && matches!(o.stitch, StitchParams::Satin(_))).collect();
    assert!(!satins.is_empty());
    for o in &satins {
        let StitchParams::Satin(p) = &o.stitch else { unreachable!() };
        assert!((p.width - 1.4).abs() < 1e-9, "{} is {} mm", o.name, p.width);
    }
    let doc = filum_core::Document { objects: r.objects.clone(), threads: r.threads.clone(), ..Default::default() };
    let plan = filum_core::Engine::new().plan(&doc);
    let trims = plan.stitches.iter().filter(|s| s.flags & filum_core::plan::flags::TRIM != 0).count();
    let routed = filum_core::Engine::new().plan(&filum_core::Document { objects: img.run(&DigitizeOptions { route_lines: false, ..opts.clone() }).objects, threads: r.threads.clone(), ..Default::default() });
    let unrouted = routed.stitches.iter().filter(|s| s.flags & filum_core::plan::flags::TRIM != 0).count();
    assert!(trims < unrouted && trims <= 1, "routed {trims} trims, unrouted {unrouted}");
}
