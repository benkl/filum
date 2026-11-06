//! Raster auto-digitizer: turns a bitmap (logo, clip-art, simple artwork) into
//! stitchable objects.
//!
//! Pipeline (every step is deterministic):
//! 1. decode + box-filter downscale (alpha < 128 = transparent),
//! 2. colour quantisation: k-means in CIE Lab (k-means++ seeding, fixed-seed
//!    xorshift, subsampled), anti-alias fringe suppression, optional snapping
//!    to a thread chart,
//! 3. cleanup with a line-preserving 3×3 mode filter,
//! 4. background removal (dominant border label + transparency),
//! 5. connected components; specks below `min_region_mm2` merge into their
//!    most common neighbour,
//! 6. vectorisation (crack-following contours, Chaikin, Douglas–Peucker,
//!    outset by `overlap_mm` via a distance field),
//! 7. automatic stitch type: running for hairlines, medial-axis satin for
//!    narrow elongated strokes (Zhang–Suen skeleton + tree diameter), tatami
//!    fill along the principal axis otherwise,
//! 8. ordering by colour group (largest first) and nearest neighbour.

use serde::{Deserialize, Serialize};

use crate::clip;
use crate::geom::{offset_rings, polyline_length, pt, signed_area, simplify, trace_contours, Point, Ring};
use crate::model::{
    hex_color, DitherMethod, FillMethod, FillParams, FlowField, GradientKind, GradientParams, GradientStop, Node, Object, RunningParams, SatinParams, StitchParams, SubPath, Thread,
};
use crate::threads::{lab_to_rgb, nearest_name, rgb_to_lab, PaletteEntry};
use crate::vision::boundary::{self, Chain, Seg};
use crate::vision::filters::{self, Img};
use crate::vision::gradients::{self, GradientRegion};
use crate::vision::{self, depixel, strokes};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DigitizeOptions {
    /// Number of thread colours (2..=24), background included.
    pub colors: usize,
    /// Output width of the image in mm.
    pub width_mm: f64,
    /// Drop the colour that dominates the image border.
    pub remove_background: bool,
    /// Smaller specks are merged into the neighbouring region (mm²).
    pub min_region_mm2: f64,
    /// Mode-filter passes for cleanup.
    pub smoothing: u32,
    /// Contour simplification tolerance (mm).
    pub simplify_mm: f64,
    /// Outset of every fill region to hide gaps from pull (mm).
    pub overlap_mm: f64,
    /// Narrow elongated regions up to this width become satin (mm).
    pub satin_max_width_mm: f64,
    /// Regions thinner than this become running stitch (mm).
    pub running_max_width_mm: f64,
    /// Optional thread chart: colours are snapped to these entries.
    pub palette: Vec<PaletteEntry>,
    /// Brand written into [`Thread::brand`] when a palette is supplied.
    pub palette_brand: String,
    /// Downscale so the long side is at most this many pixels.
    pub max_pixels: u32,
    /// Automatic stitch types: narrow strokes may become satin columns.
    pub allow_satin: bool,
    /// Automatic stitch types: hairlines may become running stitch.
    pub allow_running: bool,
    /// Fill method used for areas.
    pub fill_method: FillMethod,
    /// Fixed fill angle in degrees; `None` = principal axis of each region.
    pub fill_angle: Option<f64>,
    /// Fill row spacing (mm).
    pub row_spacing: f64,
    /// Underlay under fills.
    pub underlay: bool,
    /// Use exactly these colours instead of automatic quantisation
    /// (a user-edited or locked palette).
    pub fixed_colors: Vec<[u8; 3]>,
    /// Colours to leave out: the nearest quantised colour of each is treated
    /// like background (eyedropper / "hide colour").
    pub skip_colors: Vec<[u8; 3]>,
    /// Outline around the silhouette of the design (patch / sticker look).
    pub outline: OutlineKind,
    pub outline_width_mm: f64,
    pub outline_color: [u8; 3],
    /// Edge-preserving (bilateral) smoothing passes before colour reduction.
    pub denoise: u32,
    /// Merge colours closer than this CIEDE2000 difference (0 = off).
    pub merge_delta_e: f64,
    /// Shared-boundary tracing: neighbours share one curve (no gaps or
    /// overlaps), corners stay sharp, staircases become smooth curves.
    pub seamless: bool,
    /// Boundary turns sharper than this stay corners (degrees).
    pub corner_angle: f64,
    /// How fill rows are oriented (for flow fills: the base direction they lean to).
    pub fill_direction: FillDirection,
    /// Flow fill: field cells across a shape (more = rows bend with finer detail).
    pub flow_detail: f64,
    /// Flow fill: smoothing passes of the picture's edge flow (more = calmer curves).
    pub flow_smoothing: u32,
    /// Flow fill: 0..1, how much rows follow the picture instead of the base direction.
    pub flow_strength: f64,
    /// Gradient fills follow the picture's flow too (streamlines instead of
    /// straight rows; the colours share them).
    pub gradient_flow: bool,
    /// Outlines along edges between contrasting colours.
    pub edge_outlines: OutlineKind,
    /// Smallest colour difference (CIEDE2000) that gets an edge outline.
    pub edge_contrast: f64,
    /// Line art taken from the picture.
    pub line_art: LineArt,
    /// 0..1: more lines (and fainter ones) with higher values.
    pub line_strength: f64,
    /// Lines in the picture (ink strokes, narrow colour regions, branched or
    /// not) become strokes along their centre line; the fills continue under them.
    pub line_networks: bool,
    /// Lines up to this width (mm) are strokes; wider ones stay fills.
    pub line_max_width_mm: f64,
    /// Dark ink lines found on the picture itself (black-hat), 0 = off .. 100.
    pub ink_sensitivity: f64,
    /// Bridge gaps between line ends (mm). 0 = off.
    pub line_gap_mm: f64,
    /// Shorter lines and side branches are dropped (mm).
    pub line_min_mm: f64,
    /// Strokes continue through a junction when they bend less than this (degrees).
    pub line_continuity: f64,
    /// Satin lines follow the width of the line in the picture.
    pub line_taper: bool,
    /// Thin lines as triple (bean) stitch instead of a single running stitch.
    pub thin_triple: bool,
    /// Outline width (mm): dark lines of the picture (outlines, ink) are sewn
    /// as satin of exactly this width, whatever their width in the picture
    /// (below 1 mm: a triple running stitch). 0 = the picture's width.
    pub outline_line_mm: f64,
    /// Lines that meet are routed as one network: each sews out under a
    /// running path its column covers on the way back — no trims between them.
    pub route_lines: bool,
    /// Line centres follow the darkness profile across the line (sub-pixel),
    /// not the pixel grid: thin, smoothed lines stay straight and smooth.
    pub line_subpixel: bool,
    /// Zig-zag photo / mono photo stitch: the picture as rows of
    /// zigzags in one colour, wider where it is darker — no colour regions.
    pub photo_zigzag: bool,
    /// Zig-zag photo: distance between the rows (mm).
    pub photo_spacing: f64,
    /// Zig-zag photo: direction of the rows (degrees).
    pub photo_angle: f64,
    /// Zig-zag photo: contrast (gamma on the darkness; > 1 darker darks).
    pub photo_contrast: f64,
    /// Zig-zag photo: lighter than this (0..1) stays empty.
    pub photo_min: f64,
    /// Colours always sewn as lines (strokes along their centre).
    pub line_colors: Vec<[u8; 3]>,
    /// Colours always sewn as fills (never lines, also not as ink).
    pub fill_colors: Vec<[u8; 3]>,
    /// Colours that get a satin edge in their own thread where their shapes meet the
    /// background (a clean, raised rim; `outline_width_mm` wide).
    pub edge_colors: Vec<[u8; 3]>,
    /// The sew order by colour, first sewn first (each the nearest thread of the result).
    /// Every object of a colour (its fills, lines and satin edges) is sewn in its slot,
    /// so a later colour lies on top. Colours not listed keep their place after these.
    pub color_order: Vec<[u8; 3]>,
    /// Pixel-art upscaling (Kopf & Lischinski).
    pub pixel_art: PixelArt,
    /// Smooth colour ramps become gradient fills.
    pub gradients: bool,
    /// Object masks (e.g. from the segmentation model).
    pub masks: Vec<SegMask>,
    /// External edge map (e.g. from the edge detection model).
    pub edge_map: Option<EdgeMap>,
    /// Where the background colour is removed.
    pub background_scope: BackgroundScope,
    /// Regions the user stitched or left out by clicking them (latest wins).
    pub region_edits: Vec<RegionEdit>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum BackgroundScope {
    /// Background-coloured regions connected to the image border, and plain
    /// holes (one shape around them, nothing inside: a donut's hole, a letter's
    /// counter) larger than 6 mm². Small enclosed areas (highlights) and ones
    /// that are part of the picture (a badge face with shapes on it) are stitched.
    #[default]
    Outside,
    /// Every region of the background colour.
    Everywhere,
    /// Only background-coloured regions connected to the image border: every
    /// enclosed area is part of the design and stitched (a logo's white
    /// faces inside its outlines).
    Border,
}

/// A click on a region: stitch it (`keep`) or leave it out. `x`, `y` in
/// 0..1 of the image, so an edit keeps hitting the same place when other
/// settings change.
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RegionEdit {
    pub x: f64,
    pub y: f64,
    pub keep: bool,
}

/// Why a region is not stitched ([`DigitizePreview::region_reason`]).
pub mod reason {
    pub const STITCHED: u8 = 0;
    /// The background colour (border colour).
    pub const BACKGROUND: u8 = 1;
    /// A colour the user left out.
    pub const COLOUR: u8 = 2;
    /// A region the user clicked away.
    pub const EDIT: u8 = 3;
    /// Transparent in the picture, or outside / inside an object mask.
    pub const TRANSPARENT: u8 = 4;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum FillDirection {
    /// Along the principal axis of each region.
    #[default]
    Axis,
    /// The dominant direction of the picture inside each region.
    Image,
    /// Legacy: streamline fills that follow the picture's flow (now the
    /// flow fill method; read as method = flow, base direction = axis).
    Flow,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum LineArt {
    #[default]
    None,
    /// Coherent line drawing (flow-based difference of Gaussians).
    Coherent,
    /// The external edge map ([`DigitizeOptions::edge_map`]): learned edges.
    Edges,
    /// The external edge map as a learned line drawing (Informative Drawings).
    Drawing,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum PixelArt {
    /// When the image looks like pixel art (small, few exact colours).
    #[default]
    Auto,
    On,
    Off,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum MaskMode {
    /// Stitch only inside the kept masks.
    #[default]
    Keep,
    /// Never stitch here (background).
    Remove,
    /// Its own objects, even where colours continue outside it.
    Separate,
    /// Painted over with the surrounding colours (e.g. text that becomes lettering).
    Erase,
}

/// A binary mask (one byte per pixel, > 127 = inside), base64, any size: it
/// is stretched over the image.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SegMask {
    pub mode: MaskMode,
    pub width: u32,
    pub height: u32,
    pub data: String,
}

/// Edge strength (one byte per pixel, 255 = strongest), base64.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct EdgeMap {
    pub width: u32,
    pub height: u32,
    pub data: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum OutlineKind {
    #[default]
    None,
    Running,
    Satin,
}

impl Default for DigitizeOptions {
    fn default() -> Self {
        DigitizeOptions {
            colors: 6,
            width_mm: 80.0,
            remove_background: true,
            min_region_mm2: 1.5,
            smoothing: 2,
            simplify_mm: 0.12,
            overlap_mm: 0.2,
            satin_max_width_mm: 6.0,
            running_max_width_mm: 0.9,
            palette: Vec::new(),
            palette_brand: String::new(),
            max_pixels: 640,
            allow_satin: true,
            allow_running: true,
            fill_method: FillMethod::Tatami,
            fill_angle: None,
            // commercial practice for 40 wt (Ink/Stitch's fill default is 0.25)
            row_spacing: 0.4,
            underlay: true,
            fixed_colors: Vec::new(),
            skip_colors: Vec::new(),
            outline: OutlineKind::None,
            outline_width_mm: 1.5,
            outline_color: [0x1c, 0x1c, 0x1c],
            denoise: 1,
            merge_delta_e: 3.0,
            seamless: true,
            corner_angle: 50.0,
            fill_direction: FillDirection::Axis,
            flow_detail: 40.0,
            flow_smoothing: 2,
            flow_strength: 1.0,
            gradient_flow: false,
            edge_outlines: OutlineKind::None,
            edge_contrast: 30.0,
            line_art: LineArt::None,
            line_strength: 0.5,
            line_networks: true,
            line_max_width_mm: 3.0,
            ink_sensitivity: 50.0,
            line_gap_mm: 1.0,
            line_min_mm: 2.0,
            line_continuity: 35.0,
            line_taper: true,
            thin_triple: false,
            outline_line_mm: 0.0,
            route_lines: true,
            line_subpixel: true,
            photo_zigzag: false,
            photo_spacing: 1.0,
            photo_angle: 45.0,
            photo_contrast: 1.2,
            photo_min: 0.12,
            line_colors: Vec::new(),
            fill_colors: Vec::new(),
            edge_colors: Vec::new(),
            color_order: Vec::new(),
            pixel_art: PixelArt::Auto,
            gradients: false,
            masks: Vec::new(),
            edge_map: None,
            background_scope: BackgroundScope::Outside,
            region_edits: Vec::new(),
        }
    }
}

/// One quantised colour of the image.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColorInfo {
    pub rgb: [u8; 3],
    pub hex: String,
    pub name: String,
    pub code: String,
    /// Fraction of the image area (0..1).
    pub coverage: f64,
    /// Left out as a colour: the background colour or one the user dropped
    /// (with the background scope "outside", some enclosed regions are stitched).
    pub background: bool,
    /// Fraction of the image area in this colour that is not stitched.
    #[serde(default)]
    pub removed: f64,
    /// Fraction of the image area in this colour sewn as lines (strokes).
    #[serde(default)]
    pub lines: f64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DigitizeResult {
    pub threads: Vec<Thread>,
    pub objects: Vec<Object>,
    /// Every quantised colour (including background ones), in label order.
    pub colors: Vec<ColorInfo>,
    pub width_mm: f64,
    pub height_mm: f64,
}

/// Quantised, cleaned-up image (what the stitches will be built from).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct DigitizePreview {
    pub width: u32,
    pub height: u32,
    /// RGBA8; background and transparent pixels have alpha 0.
    pub rgba: Vec<u8>,
    pub colors: Vec<ColorInfo>,
    pub width_mm: f64,
    pub height_mm: f64,
    /// The regions the stitched / removed decision is made on, at
    /// `region_width × region_height` (before pixel-art upscaling): region
    /// id per pixel, and per region its label (colour index; labels past the
    /// colours are transparent or gradients) and [`reason`].
    pub region_width: u32,
    pub region_height: u32,
    pub regions: Vec<u32>,
    pub region_label: Vec<u8>,
    pub region_reason: Vec<u8>,
}

/// Decode an image file into RGBA8, upright: the EXIF orientation (phone
/// photos are usually stored sideways with a rotation tag) is applied.
pub fn decode_image(bytes: &[u8]) -> Result<(Vec<u8>, u32, u32), String> {
    use image::metadata::Orientation;
    use image::ImageDecoder;
    let err = |e: &dyn std::fmt::Display| format!("could not decode image: {e}");
    let mut decoder = image::ImageReader::new(std::io::Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|e| err(&e))?
        .into_decoder()
        .map_err(|e| err(&e))?;
    // a malformed EXIF block is no reason to reject the picture
    let orientation = decoder.orientation().unwrap_or(Orientation::NoTransforms);
    let mut img = image::DynamicImage::from_decoder(decoder).map_err(|e| err(&e))?;
    img.apply_orientation(orientation);
    let rgba = img.to_rgba8();
    let (w, h) = rgba.dimensions();
    Ok((rgba.into_raw(), w, h))
}

/// Decode an image (png/jpeg/webp/bmp/gif) and digitize it.
pub fn digitize_image(bytes: &[u8], opts: &DigitizeOptions) -> Result<DigitizeResult, String> {
    let (rgba, w, h) = decode_image(bytes)?;
    Ok(digitize_rgba(&rgba, w, h, opts))
}

/// Steps 1–5: downscale, masks, denoise, gradients, quantise, clean up,
/// background, specks (and pixel-art upscaling).
struct Prepared {
    w: usize,
    h: usize,
    s: f64,
    labels: Vec<u8>,
    colors: Vec<[u8; 3]>,
    palette_idx: Vec<Option<usize>>,
    background: Vec<bool>,
    nlab: usize,
    info: Vec<ColorInfo>,
    /// Smoothed Lab image at `lab.w × lab.h` (= w × h unless pixel art).
    lab: Img,
    /// Gradient regions and their labels.
    grads: Vec<(u8, GradientRegion)>,
    /// Separate-mask zone per pixel (0 = none).
    zone: Vec<u8>,
    /// Pixel-art upscale factor (1 = none).
    up: usize,
    /// Regions before upscaling: (width, height, id per pixel, label and reason per region).
    regions: (usize, usize, Vec<u32>, Vec<u8>, Vec<u8>),
}

fn decode_mask(m: &SegMask, w: usize, h: usize) -> Vec<bool> {
    let raw = vision::base64_decode(&m.data);
    vision::resample_u8(&raw, m.width as usize, m.height as usize, w, h).into_iter().map(|v| v > 127).collect()
}

fn lab_image(px: &[[u8; 4]], w: usize, h: usize) -> Img {
    let mut img = Img::new(w, h, 3);
    let mut last: Option<([u8; 3], [f64; 3])> = None;
    for (i, p) in px.iter().enumerate() {
        let c = [p[0], p[1], p[2]];
        let l = match last {
            Some((lc, ll)) if lc == c => ll,
            _ => {
                let ll = rgb_to_lab(c);
                last = Some((c, ll));
                ll
            }
        };
        for k in 0..3 {
            img.data[i * 3 + k] = l[k] as f32;
        }
    }
    img
}

/// Merge quantised colours closer than `thr` (CIEDE2000), by coverage.
fn merge_close_colors(q: &mut Quant, thr: f64) {
    let n = q.colors.len();
    if n < 2 || thr <= 0.0 {
        return;
    }
    let mut count = vec![0usize; n + 1];
    for &l in &q.labels {
        count[(l as usize).min(n)] += 1;
    }
    let labs: Vec<[f64; 3]> = q.colors.iter().map(|c| rgb_to_lab(*c)).collect();
    let mut to: Vec<usize> = (0..n).collect();
    let find = |to: &Vec<usize>, mut i: usize| {
        while to[i] != i {
            i = to[i];
        }
        i
    };
    for a in 0..n {
        for b in a + 1..n {
            if vision::delta_e(labs[a], labs[b]) < thr {
                let (ra, rb) = (find(&to, a), find(&to, b));
                if ra != rb {
                    // the bigger colour survives
                    if count[ra] >= count[rb] {
                        to[rb] = ra;
                    } else {
                        to[ra] = rb;
                    }
                }
            }
        }
    }
    let roots: Vec<usize> = (0..n).filter(|&i| find(&to, i) == i).collect();
    if roots.len() == n {
        return;
    }
    let new_index: Vec<usize> = (0..n).map(|i| roots.iter().position(|&r| r == find(&to, i)).unwrap()).collect();
    for l in q.labels.iter_mut() {
        let li = *l as usize;
        *l = if li < n { new_index[li] as u8 } else { roots.len() as u8 };
    }
    q.colors = roots.iter().map(|&r| q.colors[r]).collect();
    q.palette_idx = roots.iter().map(|&r| q.palette_idx[r]).collect();
}

fn prepare(rgba: &[u8], width: u32, height: u32, opts: &DigitizeOptions) -> Option<Prepared> {
    let (w0, h0) = (width as usize, height as usize);
    if w0 == 0 || h0 == 0 || rgba.len() < w0 * h0 * 4 {
        return None;
    }
    let full: Vec<[u8; 4]> = rgba.chunks_exact(4).take(w0 * h0).map(|c| [c[0], c[1], c[2], c[3]]).collect();
    let pixel = match opts.pixel_art {
        PixelArt::On => w0 * h0 <= 512 * 512,
        PixelArt::Off => false,
        PixelArt::Auto => depixel::looks_like_pixel_art(&full, w0, h0),
    };
    // 1. downscale (pixel art keeps its pixels)
    let (mut px, w, h) = if pixel { (full, w0, h0) } else { downscale(rgba, w0, h0, opts.max_pixels.max(8) as usize) };
    let width_mm = if opts.width_mm > 0.0 { opts.width_mm } else { 80.0 };
    let mut s = width_mm / w as f64; // mm per pixel

    // masks: keep / remove make background, separate makes zones
    let mut zone = vec![0u8; w * h];
    if !opts.masks.is_empty() {
        let keeps: Vec<Vec<bool>> = opts.masks.iter().filter(|m| m.mode == MaskMode::Keep).map(|m| decode_mask(m, w, h)).collect();
        for (i, p) in px.iter_mut().enumerate() {
            if !keeps.is_empty() && !keeps.iter().any(|k| k[i]) {
                p[3] = 0;
            }
        }
        for (k, m) in opts.masks.iter().enumerate() {
            match m.mode {
                MaskMode::Remove => {
                    for (i, inside) in decode_mask(m, w, h).into_iter().enumerate() {
                        if inside {
                            px[i][3] = 0;
                        }
                    }
                }
                MaskMode::Separate => {
                    for (i, inside) in decode_mask(m, w, h).into_iter().enumerate() {
                        if inside {
                            zone[i] = (k + 1).min(250) as u8;
                        }
                    }
                }
                MaskMode::Keep | MaskMode::Erase => {}
            }
        }
    }
    let alpha: Vec<bool> = px.iter().map(|p| p[3] >= 128).collect();

    // denoise: edge-preserving bilateral smoothing in Lab
    let mut lab = lab_image(&px, w, h);
    if !pixel && opts.denoise > 0 {
        for pass in 0..opts.denoise.min(4) {
            lab = filters::bilateral(&lab, 3, 2.0, 7.0 + 2.0 * pass as f32, &alpha);
        }
        for (i, p) in px.iter_mut().enumerate() {
            if alpha[i] {
                let c = lab_to_rgb([lab.data[i * 3] as f64, lab.data[i * 3 + 1] as f64, lab.data[i * 3 + 2] as f64]);
                p[0] = c[0];
                p[1] = c[1];
                p[2] = c[2];
            }
        }
    }

    // gradients: smooth ramps are kept out of the colour quantisation
    let mut grads: Vec<GradientRegion> = Vec::new();
    if !pixel && opts.gradients {
        let border = 2 * (w + h);
        let mut rgb_img = Img::new(w, h, 3);
        for (i, p) in px.iter().enumerate() {
            for k in 0..3 {
                rgb_img.data[i * 3 + k] = p[k] as f32;
            }
        }
        for g in gradients::find(&lab, &rgb_img, &alpha, 2.5, 0.02, 14.0, 4.5) {
            let on_border = g.pixels.iter().filter(|&&p| {
                let (x, y) = (p as usize % w, p as usize / w);
                x == 0 || y == 0 || x == w - 1 || y == h - 1
            });
            // a ramp covering much of the border is the background
            if opts.remove_background && on_border.count() * 3 > border {
                continue;
            }
            grads.push(g);
        }
        grads.truncate(16);
    }
    let mut qpx = px.clone();
    for g in &grads {
        for &p in &g.pixels {
            qpx[p as usize][3] = 0;
        }
    }

    // 2. quantise
    let mut q = quantize(&qpx, w, h, opts);
    if q.colors.is_empty() && grads.is_empty() {
        return None;
    }
    if opts.fixed_colors.is_empty() && !pixel {
        merge_close_colors(&mut q, opts.merge_delta_e);
    }
    let transparent = q.colors.len();
    let mut labels = q.labels;
    let mut grads_l: Vec<(u8, GradientRegion)> = Vec::new();
    for (k, g) in grads.into_iter().enumerate() {
        let l = (transparent + 1 + k).min(255) as u8;
        for &p in &g.pixels {
            labels[p as usize] = l;
        }
        grads_l.push((l, g));
    }
    let nlab = transparent + 1 + grads_l.len();

    // erase masks: their pixels take the nearest outside label (multi-source BFS)
    for m in opts.masks.iter().filter(|m| m.mode == MaskMode::Erase) {
        let inside = decode_mask(m, w, h);
        let mut done: Vec<bool> = inside.iter().map(|b| !b).collect();
        let mut queue: std::collections::VecDeque<usize> = (0..w * h).filter(|&i| done[i]).filter(|&i| {
            let (x, y) = (i % w, i / w);
            (x > 0 && inside[i - 1]) || (x + 1 < w && inside[i + 1]) || (y > 0 && inside[i - w]) || (y + 1 < h && inside[i + w])
        }).collect();
        while let Some(i) = queue.pop_front() {
            let (x, y) = (i % w, i / w);
            for j in [(x > 0).then(|| i - 1), (x + 1 < w).then(|| i + 1), (y > 0).then(|| i - w), (y + 1 < h).then(|| i + w)].into_iter().flatten() {
                if !done[j] {
                    done[j] = true;
                    labels[j] = labels[i];
                    queue.push_back(j);
                }
            }
        }
    }

    // 3. cleanup (pixel art keeps its exact pixels)
    if !pixel {
        for _ in 0..opts.smoothing.min(16) {
            mode_filter(&mut labels, w, h, nlab);
        }
    }

    // 4. colours left out: the dominant border colour, plus colours the user
    // dropped (applied per region in step 6)
    let mut background = vec![false; nlab];
    background[transparent] = true;
    let mut bg_colour: Option<usize> = None;
    let mut skipped = vec![false; nlab];
    if opts.remove_background {
        let mut border = vec![0usize; nlab];
        for x in 0..w {
            border[labels[x] as usize] += 1;
            border[labels[(h - 1) * w + x] as usize] += 1;
        }
        for y in 0..h {
            border[labels[y * w] as usize] += 1;
            border[labels[y * w + w - 1] as usize] += 1;
        }
        let mut best = 0;
        for l in 1..nlab {
            if border[l] > border[best] {
                best = l;
            }
        }
        if best != transparent {
            bg_colour = Some(best);
        }
    }
    for sc in &opts.skip_colors {
        if let Some(l) = nearest_label(&q.colors, *sc) {
            skipped[l] = true;
        }
    }

    // 5. speck removal
    let min_px = (opts.min_region_mm2.max(0.0) / (s * s)).round() as usize;
    if min_px > 1 && !pixel {
        merge_specks(&mut labels, w, h, min_px);
    }

    let mut count = vec![0usize; nlab];
    for &l in &labels {
        count[(l as usize).min(nlab - 1)] += 1;
    }

    // 6. what is stitched, per region: the background colour (outside or
    // everywhere), dropped colours, transparency, then the user's clicks
    let cc = components(&labels, w, h);
    let mut region_id = vec![0u32; w * h];
    let mut region_label = Vec::with_capacity(cc.comps.len());
    let mut region_reason = Vec::with_capacity(cc.comps.len());
    for (k, c) in cc.comps.iter().enumerate() {
        for &i in &cc.order[c.start..c.start + c.len] {
            region_id[i as usize] = k as u32;
        }
    }
    // an enclosed area of the background colour that is a plain hole (one shape around
    // it, nothing inside: a donut's hole, a letter's counter, the inside of an outline)
    // shows the fabric; small ones (highlights, eye glints) and ones that are part of a
    // picture (several shapes around or inside them: a badge face) are stitched
    let hole_px = (6.0 / (s * s)).ceil() as usize;
    let is_hole = |k: usize| -> bool {
        let c = &cc.comps[k];
        if c.len <= hole_px {
            return false;
        }
        let mut around: Option<u32> = None;
        for &i in &cc.order[c.start..c.start + c.len] {
            let (x, y) = (i as usize % w, i as usize / w);
            for (nx, ny) in [(x.wrapping_sub(1), y), (x + 1, y), (x, y.wrapping_sub(1)), (x, y + 1)] {
                if nx >= w || ny >= h {
                    continue;
                }
                let r = region_id[ny * w + nx];
                if r as usize != k && around.replace(r).is_some_and(|a| a != r) {
                    return false;
                }
            }
        }
        true
    };
    for (k, c) in cc.comps.iter().enumerate() {
        let l = c.label as usize;
        let on_border = c.x0 == 0 || c.y0 == 0 || c.x1 + 1 >= w || c.y1 + 1 >= h;
        let why = if l == transparent {
            reason::TRANSPARENT
        } else if skipped[l] {
            reason::COLOUR
        } else if bg_colour == Some(l) && (on_border || opts.background_scope == BackgroundScope::Everywhere || (opts.background_scope == BackgroundScope::Outside && is_hole(k))) {
            reason::BACKGROUND
        } else {
            reason::STITCHED
        };
        region_label.push(c.label);
        region_reason.push(why);
    }
    for e in &opts.region_edits {
        let x = ((e.x * w as f64) as isize).clamp(0, w as isize - 1) as usize;
        let y = ((e.y * h as f64) as isize).clamp(0, h as isize - 1) as usize;
        let r = region_id[y * w + x] as usize;
        if region_reason[r] != reason::TRANSPARENT {
            region_reason[r] = if e.keep { reason::STITCHED } else { reason::EDIT };
        }
    }
    let mut removed = vec![0usize; nlab];
    for (i, l) in labels.iter_mut().enumerate() {
        if region_reason[region_id[i] as usize] != reason::STITCHED {
            removed[*l as usize] += 1;
            *l = transparent as u8;
        }
    }

    let total = (w * h).max(1) as f64;
    let info = (0..transparent)
        .map(|l| {
            let rgb = q.colors[l];
            let (name, code) = match q.palette_idx[l] {
                Some(e) => (opts.palette[e].name.clone(), opts.palette[e].code.clone()),
                None => (nearest_name(rgb), String::new()),
            };
            ColorInfo {
                rgb,
                hex: hex_color(rgb),
                name,
                code,
                coverage: count[l] as f64 / total,
                background: bg_colour == Some(l) || skipped[l],
                removed: removed[l] as f64 / total,
                lines: 0.0,
            }
        })
        .collect();
    let regions = (w, h, region_id, region_label, region_reason);

    // pixel art: upscale the label image so diagonals connect smoothly
    let (mut labels, mut w, mut h, mut up) = (labels, w, h, 1usize);
    if pixel {
        let k = if w.max(h) <= 128 { 8 } else { 4 };
        let (ul, uw, uh) = depixel::upscale(&labels, w, h, k);
        zone = vision::resample_u8(&zone, w, h, uw, uh);
        labels = ul;
        w = uw;
        h = uh;
        s /= k as f64;
        up = k;
    }
    Some(Prepared { w, h, s, labels, colors: q.colors, palette_idx: q.palette_idx, background, nlab, info, lab, grads: grads_l, zone, up, regions })
}

/// The colour of a gradient region at pixel `(x, y)` (its own pixel grid).
fn ramp_color(g: &GradientRegion, x: f64, y: f64) -> [u8; 3] {
    let d = [g.to[0] - g.from[0], g.to[1] - g.from[1]];
    let l2 = (d[0] * d[0] + d[1] * d[1]).max(1e-9);
    let t = (((x - g.from[0]) * d[0] + (y - g.from[1]) * d[1]) / l2).clamp(0.0, 1.0);
    [0, 1, 2].map(|k| (g.rgb_from[k] + (g.rgb_to[k] - g.rgb_from[k]) * t).round().clamp(0.0, 255.0) as u8)
}

/// Quantised preview of what will be stitched (fast: no vectorisation).
pub fn digitize_preview_rgba(rgba: &[u8], width: u32, height: u32, opts: &DigitizeOptions) -> DigitizePreview {
    let Some(p) = prepare(rgba, width, height, opts) else { return DigitizePreview::default() };
    let mut out = vec![0u8; p.w * p.h * 4];
    for (i, &l) in p.labels.iter().enumerate() {
        let li = l as usize;
        if li < p.background.len() && p.background[li] {
            continue;
        }
        let c = if li < p.colors.len() {
            p.colors[li]
        } else if let Some((_, g)) = p.grads.iter().find(|(gl, _)| *gl == l) {
            ramp_color(g, (i % p.w) as f64 / p.up as f64, (i / p.w) as f64 / p.up as f64)
        } else {
            continue;
        };
        out[i * 4..i * 4 + 4].copy_from_slice(&[c[0], c[1], c[2], 255]);
    }
    DigitizePreview {
        width: p.w as u32,
        height: p.h as u32,
        rgba: out,
        colors: p.info,
        width_mm: p.s * p.w as f64,
        height_mm: p.s * p.h as f64,
        region_width: p.regions.0 as u32,
        region_height: p.regions.1 as u32,
        regions: p.regions.2,
        region_label: p.regions.3,
        region_reason: p.regions.4,
    }
}

/// Fitted boundary segments (grid units) → a Bézier sub-path in mm.
fn segs_to_subpath(segs: &[Seg], s: f64, closed: bool) -> SubPath {
    let mm = |p: Point| [r3(p.x * s), r3(p.y * s)];
    let mut nodes: Vec<Node> = Vec::new();
    for seg in segs {
        if nodes.is_empty() {
            nodes.push(Node { p: mm(seg.start()), i: None, o: None });
        }
        match *seg {
            Seg::Line(_, b) => nodes.push(Node { p: mm(b), i: None, o: None }),
            Seg::Cubic(_, c1, c2, b) => {
                if let Some(last) = nodes.last_mut() {
                    last.o = Some(mm(c1));
                }
                nodes.push(Node { p: mm(b), i: Some(mm(c2)), o: None });
            }
        }
    }
    if closed && nodes.len() > 2 {
        let last = *nodes.last().unwrap();
        if (last.p[0] - nodes[0].p[0]).abs() < 1e-6 && (last.p[1] - nodes[0].p[1]).abs() < 1e-6 {
            nodes.pop();
            nodes[0].i = last.i;
        }
    }
    SubPath { nodes, closed }
}

/// Grow fill shapes by the overlap (exact offset, curves re-fitted).
fn grow_paths(paths: &[SubPath], d: f64) -> Option<Vec<SubPath>> {
    let rings: Vec<Ring> = paths
        .iter()
        .map(|sp| {
            let mut r = sp.flatten(0.02);
            if r.len() > 2 && r[0].dist(*r.last().unwrap()) < 1e-6 {
                r.pop();
            }
            r
        })
        .filter(|r| r.len() >= 3)
        .collect();
    let grown = clip::rings(&clip::offset(&clip::region(&rings), d));
    let out: Vec<SubPath> = grown.iter().map(|r| clip::fit_ring(r, 0.02, 35.0)).filter(|sp| sp.nodes.len() >= 3).collect();
    (!out.is_empty()).then_some(out)
}

/// Fill angle convention: rows along (cos(-a), sin(-a)) in y-down coordinates.
fn angle_of(theta: f64) -> f64 {
    let a = ((-theta).to_degrees().rem_euclid(180.0) * 10.0).round() / 10.0;
    if a >= 180.0 { a - 180.0 } else { a + 0.0 }
}

/// Snap a colour to the thread chart (if any).
fn snap_rgb(rgb: [u8; 3], opts: &DigitizeOptions) -> ([u8; 3], String, String, String) {
    if opts.palette.is_empty() {
        return (rgb, nearest_name(rgb), String::new(), String::new());
    }
    let l = rgb_to_lab(rgb);
    let e = opts
        .palette
        .iter()
        .min_by(|a, b| vision::delta_e(l, rgb_to_lab(a.rgb)).partial_cmp(&vision::delta_e(l, rgb_to_lab(b.rgb))).unwrap())
        .unwrap();
    (e.rgb, e.name.clone(), e.code.clone(), opts.palette_brand.clone())
}

/// A thread for a colour (reused when the colour exists).
fn ensure_thread(threads: &mut Vec<Thread>, rgb: [u8; 3], name: String, code: String, brand: String) -> String {
    let hex = hex_color(rgb);
    if let Some(t) = threads.iter().find(|t| t.color.eq_ignore_ascii_case(&hex)) {
        return t.id.clone();
    }
    let id = format!("t{}", threads.len() + 1);
    threads.push(Thread { id: id.clone(), name, color: hex, brand, code, weight: None });
    id
}

/// Join open polylines that share end points into longer paths.
fn join_polylines(mut lines: Vec<Vec<Point>>, eps: f64) -> Vec<Vec<Point>> {
    let mut out = Vec::new();
    while let Some(mut cur) = lines.pop() {
        loop {
            let end = *cur.last().unwrap();
            let start = cur[0];
            if let Some(k) = lines.iter().position(|l| l[0].dist(end) < eps || l.last().unwrap().dist(end) < eps) {
                let mut l = lines.swap_remove(k);
                if l[0].dist(end) >= eps {
                    l.reverse();
                }
                cur.extend(l.into_iter().skip(1));
            } else if let Some(k) = lines.iter().position(|l| l[0].dist(start) < eps || l.last().unwrap().dist(start) < eps) {
                let mut l = lines.swap_remove(k);
                if l.last().unwrap().dist(start) >= eps {
                    l.reverse();
                }
                l.extend(cur.into_iter().skip(1));
                cur = l;
            } else {
                break;
            }
        }
        out.push(cur);
    }
    out
}

/// Digitize a raw RGBA8 buffer (row-major, `width * height * 4` bytes).
pub fn digitize_rgba(rgba: &[u8], width: u32, height: u32, opts: &DigitizeOptions) -> DigitizeResult {
    let Some(prep) = prepare(rgba, width, height, opts) else { return DigitizeResult::default() };

    if opts.photo_zigzag && prep.up == 1 {
        return photo_zigzag(&prep, opts);
    }
    let Prepared { w, h, s, mut labels, colors, palette_idx, background, nlab, mut info, lab, grads, zone, up, .. } = prep;
    let pixel = up > 1;
    let q = Quant { labels: Vec::new(), colors, palette_idx };
    let mut cc = components_zoned(&labels, &zone, w, h);
    // lines of the picture become strokes; the fills around them grow under them
    let mut line_strokes: Vec<LineStroke> = Vec::new();
    if opts.line_networks && !pixel && lab.w == w && lab.h == h {
        if let Some((line_px, strip_px, found)) = find_lines(&lab, &labels, &cc, &background, &grads, &q.colors, w, h, s, opts) {
            let total = (w * h) as f64;
            for (i, &on) in line_px.iter().enumerate() {
                let l = labels[i] as usize;
                if on && l < info.len() {
                    info[l].lines += 1.0 / total;
                }
            }
            grow_under_lines(&mut labels, &line_px, &strip_px, w, h, (0.8 / s).ceil() as u32, q.colors.len() as u8);
            cc = components_zoned(&labels, &zone, w, h);
            line_strokes = found;
        }
    }
    let mut cid = vec![0u32; w * h];
    for (k, c) in cc.comps.iter().enumerate() {
        for &p in &cc.order[c.start..c.start + c.len] {
            cid[p as usize] = k as u32;
        }
    }
    // shared boundaries, fitted once
    let (chains, fitted): (Vec<Chain>, Vec<Vec<Seg>>) = if opts.seamless {
        let ch = boundary::chains(&cid, w, h);
        let accuracy = if pixel { 0.35 * up as f64 } else { 0.35 };
        let corner = if pixel { opts.corner_angle.max(60.0) } else { opts.corner_angle };
        let f = ch.iter().map(|c| boundary::fit_chain(c, accuracy, corner, up as f64)).collect();
        (ch, f)
    } else {
        (Vec::new(), Vec::new())
    };
    let by_region = boundary::chains_by_region(&chains);
    // direction field of the picture (not for pixel art)
    let flow_fill = opts.fill_method == FillMethod::Flow || opts.fill_direction == FillDirection::Flow;
    let gradient_flow = opts.gradients && opts.gradient_flow;
    let want_flow = !pixel && (flow_fill || gradient_flow || opts.fill_direction != FillDirection::Axis || opts.line_art == LineArt::Coherent);
    let etf = want_flow.then(|| filters::edge_tangent_flow(&filters::luminance(&lab), 4, 2));
    // flow fills: their own smoothing of the edge flow
    let flow_smoothing = opts.flow_smoothing.clamp(1, 8) as usize;
    let flow_etf = (want_flow && (flow_fill || gradient_flow) && flow_smoothing != 2).then(|| filters::edge_tangent_flow(&filters::luminance(&lab), 4, flow_smoothing));

    // 6./7. vectorise + stitch type
    let ctx = Ctx { s, tol: opts.simplify_mm.max(0.0).max(s * 0.5), opts, fill_only: colour_roles(&q.colors, opts).1 };
    let mut regions: Vec<Region> = Vec::new();
    // pixels that became fills: the outline wraps these, not thin strokes
    let mut fill_mask = vec![false; w * h];
    for (k, c) in cc.comps.iter().enumerate() {
        let label = c.label as usize;
        if background[label] {
            continue;
        }
        // specks the lines left behind (a few pixels beside a stroke) after the
        // speck cleanup ran: too small to sew
        if !line_strokes.is_empty() && grads.iter().all(|(gl, _)| *gl as usize != label) && (c.len as f64) * s * s < opts.min_region_mm2.min(1.0) {
            continue;
        }
        let pix = &cc.order[c.start..c.start + c.len];
        let grad = grads.iter().find(|(gl, _)| *gl as usize == label).map(|(_, g)| g);
        let region = if grad.is_some() {
            // gradients are always fills
            let (sx, sy) = pix.iter().fold((0f64, 0f64), |a, &p| (a.0 + (p as usize % w) as f64, a.1 + (p as usize / w) as f64));
            let n = pix.len().max(1) as f64;
            Some(Region {
                label,
                rank: 0,
                centroid: pt((sx / n + 0.5) * s, (sy / n + 0.5) * s),
                area: pix.len(),
                paths: Vec::new(),
                stitch: StitchParams::Fill(FillParams { method: FillMethod::Tatami, row_spacing: opts.row_spacing.max(0.1), underlay: opts.underlay, ..Default::default() }),
            })
        } else {
            process_region(&ctx, c, pix, w)
        };
        let Some(mut r) = region else { continue };
        if r.rank == 0 {
            for &p in pix {
                fill_mask[p as usize] = true;
            }
            // seamless outlines: the shared, fitted boundaries
            if opts.seamless {
                let rings = boundary::region_rings_of(&chains, &fitted, k as u32, by_region.get(&(k as u32)).cloned().unwrap_or_default());
                let mut paths: Vec<SubPath> = rings.iter().map(|ring| segs_to_subpath(ring, s, true)).filter(|sp| sp.nodes.len() >= 2).collect();
                if opts.overlap_mm > 1e-6 && !paths.is_empty() {
                    if let Some(g) = grow_paths(&paths, opts.overlap_mm) {
                        paths = g;
                    }
                }
                if !paths.is_empty() {
                    r.paths = paths;
                }
            }
            if r.paths.is_empty() {
                continue;
            }
            // stitch direction from the picture
            if let (Some(etf), StitchParams::Fill(fp)) = (&etf, &mut r.stitch) {
                if grad.is_none() {
                    // base direction: fixed angle, the picture's or the shape's axis
                    if opts.fill_angle.is_none() && opts.fill_direction == FillDirection::Image {
                        let (theta, coherence) = filters::flow_direction(etf, pix.iter().map(|p| *p as usize));
                        if coherence > 0.2 {
                            fp.angle = angle_of(theta);
                        }
                    }
                    if flow_fill {
                        fp.method = FillMethod::Flow;
                        fp.flow = Some(region_flow_field(c, flow_etf.as_ref().unwrap_or(etf), s, -fp.angle.to_radians(), opts));
                    }
                }
            }
            // gradient ramps: two colour layers sharing one row grid
            if let (Some(g), StitchParams::Fill(fp)) = (grad, &mut r.stitch) {
                let from = [r3((g.from[0] + 0.5) * s), r3((g.from[1] + 0.5) * s)];
                let to = [r3((g.to[0] + 0.5) * s), r3((g.to[1] + 0.5) * s)];
                let phi = (to[1] - from[1]).atan2(to[0] - from[0]).to_degrees();
                fp.angle = (-(phi + 90.0)).rem_euclid(180.0);
                fp.gradient = Some(GradientParams {
                    kind: GradientKind::Linear,
                    from,
                    to,
                    stops: vec![GradientStop { pos: 0.0, mid: 0.5 }, GradientStop { pos: 1.0, mid: 0.5 }],
                    dither: DitherMethod::Diffusion,
                    cell: 2.0,
                    group: format!("dg{}", label),
                    ..Default::default()
                });
                // rows that follow the picture: the layers share the streamlines
                if gradient_flow {
                    if let Some(etf) = &etf {
                        fp.method = FillMethod::Flow;
                        fp.flow = Some(region_flow_field(c, flow_etf.as_ref().unwrap_or(etf), s, -fp.angle.to_radians(), opts));
                    }
                }
            }
        }
        regions.push(r);
    }

    // 8. ordering
    let mut group_area = vec![0usize; nlab];
    for r in &regions {
        group_area[r.label] += r.area;
    }
    let mut groups: Vec<usize> = (0..nlab).filter(|&l| group_area[l] > 0).collect();
    groups.sort_by_key(|&l| (std::cmp::Reverse(group_area[l]), l));
    let mut taken = vec![false; regions.len()];
    let mut ordered: Vec<usize> = Vec::with_capacity(regions.len());
    let mut prev = Point::ZERO;
    for &g in &groups {
        for rank in 0..2u8 {
            loop {
                let mut best: Option<(usize, f64)> = None;
                for (i, r) in regions.iter().enumerate() {
                    if taken[i] || r.label != g || r.rank != rank {
                        continue;
                    }
                    let d = (r.centroid - prev).length_sq();
                    if best.is_none_or(|b| d < b.1) {
                        best = Some((i, d));
                    }
                }
                let Some((i, _)) = best else { break };
                taken[i] = true;
                prev = regions[i].centroid;
                ordered.push(i);
            }
        }
    }

    // 9. threads in first-use order, objects
    let mut threads: Vec<Thread> = Vec::new();
    let mut name_count: Vec<(String, usize)> = Vec::new();
    let mut objects: Vec<Object> = Vec::with_capacity(ordered.len());
    let mut numbered = |name: &str| -> String {
        let num = match name_count.iter_mut().find(|(k, _)| k == name) {
            Some((_, c)) => {
                *c += 1;
                *c
            }
            None => {
                name_count.push((name.to_string(), 1));
                1
            }
        };
        format!("{name} {num}")
    };
    let label_thread = |label: usize, threads: &mut Vec<Thread>| -> (String, String) {
        let rgb = q.colors[label];
        let (name, code, brand) = match q.palette_idx[label] {
            Some(e) => {
                let pe = &opts.palette[e];
                (pe.name.clone(), pe.code.clone(), opts.palette_brand.clone())
            }
            None => (nearest_name(rgb), String::new(), String::new()),
        };
        let id = ensure_thread(threads, rgb, name.clone(), code, brand);
        (id, name)
    };
    let mut slots: Vec<Option<Region>> = regions.into_iter().map(Some).collect();
    for &ri in &ordered {
        let r = slots[ri].take().expect("region used once");
        let push = |objects: &mut Vec<Object>, name: String, thread: String, stitch: StitchParams, paths: Vec<SubPath>| {
            objects.push(Object {
                id: format!("dz{}", objects.len() + 1),
                name,
                thread,
                visible: true,
                locked: false,
                paths,
                stitch,
                trim_after: false,
                stop_after: false,
            ties: Default::default(),
            force_lock: false,
            min_stitch: None,
            min_jump: None,
            clone: None,
            hidden: None,
            patterns: vec![],
                start: None,
                end: None,
            });
        };
        if let StitchParams::Fill(fp) = &r.stitch {
            if let Some(gp) = &fp.gradient {
                let g = grads.iter().find(|(gl, _)| *gl as usize == r.label).map(|(_, g)| g).unwrap();
                for (layer, c) in [g.rgb_from, g.rgb_to].into_iter().enumerate() {
                    let (rgb, name, code, brand) = snap_rgb(c.map(|v| v.round() as u8), opts);
                    let tid = ensure_thread(&mut threads, rgb, name.clone(), code, brand);
                    let mut f = fp.clone();
                    f.gradient = Some(GradientParams { layer: layer as u32, ..gp.clone() });
                    push(&mut objects, format!("Gradient {} · colour {}", r.label, layer + 1), tid, StitchParams::Fill(f), r.paths.clone());
                }
                continue;
            }
        }
        let (tid, tname) = label_thread(r.label, &mut threads);
        let name = numbered(&tname);
        push(&mut objects, name, tid, r.stitch, r.paths);
    }

    // strokes of the lines found in the picture, after (over) every fill, one
    // colour after the other, each chained to the nearest next one
    let mut line_marks: Vec<(Vec<Point>, f64)> = Vec::new();
    if !line_strokes.is_empty() {
        // one thread per colour: an existing one, else the line's own (snapped to the chart)
        let mut keyed: Vec<([u8; 3], &LineStroke)> = Vec::new();
        for ls in &line_strokes {
            let rgb = match ls.label {
                Some(l) => q.colors[l],
                None => snap_rgb(ls.rgb, opts).0,
            };
            // lines in their own colour share a thread with one alike (blurred,
            // compressed pictures give every small stroke a slightly different shade)
            let rgb = match ls.label {
                None => keyed.iter().map(|(c, _)| *c).find(|c| crate::threads::delta_e(*c, rgb) < 12.0).unwrap_or(rgb),
                Some(_) => rgb,
            };
            keyed.push((rgb, ls));
        }
        let mut order: Vec<[u8; 3]> = Vec::new();
        for (c, _) in &keyed {
            if !order.contains(c) {
                order.push(*c);
            }
        }
        // the darkest colour last: outlines on top of coloured lines
        order.sort_by(|a, b| rgb_to_lab(*b)[0].partial_cmp(&rgb_to_lab(*a)[0]).unwrap());
        let mut cursor = objects.last().and_then(|o| o.paths.last()).and_then(|sp| sp.nodes.last()).map(|n| pt(n.p[0], n.p[1])).unwrap_or(Point::ZERO);
        for c in order {
            let first = keyed.iter().find(|(k, _)| *k == c).unwrap().1;
            let (tid, tname) = match first.label {
                Some(l) => label_thread(l, &mut threads),
                None => {
                    let (rgb, name, code, brand) = snap_rgb(first.rgb, opts);
                    (ensure_thread(&mut threads, rgb, name.clone(), code, brand), name)
                }
            };
            let mut left: Vec<&LineStroke> = keyed.iter().filter(|(k, _)| *k == c).map(|(_, ls)| *ls).collect();
            let mut k = 0;
            // this colour's lines, routed as one network at the end
            let from = cursor;
            let mut batch: Vec<Object> = Vec::new();
            while !left.is_empty() {
                // nearest start or end
                let (bi, rev) = left
                    .iter()
                    .enumerate()
                    .flat_map(|(i, ls)| {
                        let st = &ls.stroke;
                        let a = st.pts[0] * s;
                        let b = *st.pts.last().unwrap() * s;
                        [(i, false, a.dist(cursor)), (i, true && !st.closed, b.dist(cursor))]
                    })
                    .min_by(|a, b| a.2.partial_cmp(&b.2).unwrap())
                    .map(|(i, r, _)| (i, r))
                    .unwrap();
                let ls = left.remove(bi);
                let st = &ls.stroke;
                // crumbs of the stroke network (a few pixels at a junction) and loose
                // dashes shorter than a line cost a trim each and sew nothing visible
                let len_mm = polyline_length(&st.pts) * s;
                if len_mm < 0.5 || (st.closed && len_mm < opts.line_min_mm) || (!st.closed && st.free[0] && st.free[1] && len_mm < opts.line_min_mm) {
                    continue;
                }
                let fixed = (ls.ink && opts.outline_line_mm > 0.0).then_some(opts.outline_line_mm);
                let Some((paths, stitch)) = stroke_object(st, rev, s, &ctx, fixed) else { continue };
                let mut ws = st.widths.clone();
                ws.sort_by(|a, b| a.partial_cmp(b).unwrap());
                line_marks.push((st.pts.iter().map(|p| *p * s).collect(), ((ws[ws.len() / 2] - 0.5).max(0.5) * s) / 2.0));
                if let Some(e) = paths[0].nodes.last() {
                    cursor = pt(e.p[0], e.p[1]);
                }
                k += 1;
                batch.push(Object {
                    id: format!("dz{}", objects.len() + batch.len() + 1),
                    name: format!("{tname} line {k}"),
                    thread: tid.clone(),
                    visible: true,
                    locked: false,
                    paths,
                    stitch,
                    trim_after: false,
                    stop_after: false,
            ties: Default::default(),
            force_lock: false,
            min_stitch: None,
            min_jump: None,
            clone: None,
            hidden: None,
            patterns: vec![],
                    start: None,
                    end: None,
                });
            }
            let batch = if opts.route_lines { crate::outline_route::route_lines(batch, from) } else { batch };
            if let Some(e) = batch.last().and_then(|o| o.paths.last()).and_then(|sp| sp.nodes.last()) {
                cursor = pt(e.p[0], e.p[1]);
            }
            objects.extend(batch);
        }
    }

    let outline_thread = |threads: &mut Vec<Thread>| ensure_thread(threads, opts.outline_color, nearest_name(opts.outline_color), String::new(), String::new());
    let make_outline = |paths: Vec<SubPath>, name: String, thread: String, kind: OutlineKind, objects: &mut Vec<Object>| {
        let width = opts.outline_width_mm.clamp(0.4, 8.0);
        let stitch = match kind {
            OutlineKind::Satin => StitchParams::Satin(SatinParams { width, center_walk: true, contour_underlay: width > 2.5, ..Default::default() }),
            _ => StitchParams::Running(RunningParams { length: 2.0, bean_repeats: 2, ..Default::default() }),
        };
        objects.push(Object {
            id: format!("dz{}", objects.len() + 1),
            name,
            thread,
            visible: true,
            locked: false,
            paths,
            stitch,
            trim_after: false,
            stop_after: false,
            ties: Default::default(),
            force_lock: false,
            min_stitch: None,
            min_jump: None,
            clone: None,
            hidden: None,
            patterns: vec![],
            start: None,
            end: None,
        });
    };

    // Lines come from four places: strokes in the picture (satin / running
    // regions above), the border outline, edge outlines and line art. They are
    // kept in that order of priority and every later line keeps only the parts
    // that do not run along a line already placed — one line per place, never
    // a double outline from two recognitions.
    let gap = (0.6f64).max(2.0 * s);
    let mut cover = LineCover::new(s * w as f64, s * h as f64, (s * 0.5).clamp(0.08, 0.25));
    for o in &objects {
        let half = match &o.stitch {
            StitchParams::Satin(p) => p.width / 2.0,
            StitchParams::Running(_) => 0.0,
            // a long, narrow, dark fill is a line drawn in the picture too (a
            // ring outline, an ink stroke): no other line along it or inside
            // it. Pale narrow fills are shading, not lines.
            StitchParams::Fill(_) => {
                let inky = threads.iter().find(|t| t.id == o.thread).is_some_and(|t| {
                    let lab = rgb_to_lab(t.rgb());
                    lab[0] <= 45.0 || vision::delta_e(lab, rgb_to_lab(opts.outline_color)) <= 15.0
                });
                if inky {
                    let rings: Vec<Ring> = o.paths.iter().map(|sp| sp.flatten(0.05)).filter(|r| r.len() >= 3).collect();
                    if is_stroke_like(&rings, opts.satin_max_width_mm.min(3.0)) {
                        cover.stamp_area(&rings, gap / 2.0);
                    }
                }
                continue;
            }
            _ => continue,
        };
        for sp in &o.paths {
            cover.stamp(&sp.flatten(0.05), half + gap / 2.0);
        }
    }
    // the lines of the picture as wide as they are drawn
    for (pts, half) in &line_marks {
        cover.stamp(pts, half + gap / 2.0);
    }
    let outline_half = |kind: OutlineKind| if kind == OutlineKind::Satin { opts.outline_width_mm.clamp(0.4, 8.0) / 2.0 } else { 0.0 };

    // border outline around the silhouette (stitched last, but placed first)
    let mut border: Vec<SubPath> = Vec::new();
    if opts.outline != OutlineKind::None && !objects.is_empty() {
        let half = outline_half(opts.outline);
        // A satin border is a patch's edge: it has to close all the way round (the patch
        // is cut out along it), so it takes priority over the picture's own lines, which
        // give way where they run along it. A running outline gives way to them instead.
        let patch_edge = opts.outline == OutlineKind::Satin;
        let mut edge = LineCover::new(s * w as f64, s * h as f64, (s * 0.5).clamp(0.08, 0.25));
        for ring in silhouette_rings(&fill_mask, w, h, s, opts) {
            let sp = if opts.seamless { clip::fit_ring(&ring, 0.03, opts.corner_angle) } else { SubPath::polyline(&round_pts(&ring), true) };
            let mut pts = sp.flatten(0.05);
            if let Some(&p0) = pts.first() {
                pts.push(p0);
            }
            if patch_edge {
                edge.stamp(&pts, half + gap / 2.0);
                border.push(sp);
            } else {
                border.extend(cover.keep_new(&pts, sp, half + gap / 2.0, 1.5));
            }
            cover.stamp(&pts, half + gap / 2.0);
        }
        if patch_edge {
            // the picture's centre-line lines lose the parts that lie along the border (a
            // line cut in pieces becomes one object per piece: two paths would be a
            // satin's two rails)
            let mut kept: Vec<Object> = Vec::with_capacity(objects.len());
            for o in std::mem::take(&mut objects) {
                let line_half = match &o.stitch {
                    StitchParams::Satin(p) if o.paths.len() == 1 => p.width / 2.0,
                    StitchParams::Running(_) => 0.0,
                    _ => {
                        kept.push(o);
                        continue;
                    }
                };
                let satin = matches!(o.stitch, StitchParams::Satin(_));
                let pieces: Vec<SubPath> = o
                    .paths
                    .iter()
                    .flat_map(|sp| {
                        let mut pts = sp.flatten(0.05);
                        if sp.closed {
                            if let Some(&p0) = pts.first() {
                                pts.push(p0);
                            }
                        }
                        edge.keep_new(&pts, sp.clone(), line_half, 1.5)
                    })
                    .collect();
                if pieces.is_empty() {
                    continue;
                }
                if satin && pieces.len() > 1 {
                    for (k, sp) in pieces.into_iter().enumerate() {
                        let mut part = o.clone();
                        part.id = format!("{}-{}", o.id, k + 1);
                        part.paths = vec![sp];
                        kept.push(part);
                    }
                } else {
                    let mut o = o;
                    o.paths = pieces;
                    kept.push(o);
                }
            }
            objects = kept;
        }
    }

    // edge outlines between contrasting colours (on the shared boundaries)
    let mut edge_lines: Vec<SubPath> = Vec::new();
    if opts.edge_outlines != OutlineKind::None && opts.seamless && !objects.is_empty() {
        let colour_lab = |comp: u32| -> Option<[f64; 3]> {
            if comp == boundary::OUTSIDE {
                return None;
            }
            let l = cc.comps[comp as usize].label as usize;
            if l < q.colors.len() {
                Some(rgb_to_lab(q.colors[l]))
            } else {
                grads.iter().find(|(gl, _)| *gl as usize == l).map(|(_, g)| rgb_to_lab([0, 1, 2].map(|k| ((g.rgb_from[k] + g.rgb_to[k]) / 2.0).round() as u8)))
            }
        };
        let stitched = |comp: u32| comp != boundary::OUTSIDE && !background[cc.comps[comp as usize].label as usize];
        let mut lines: Vec<Vec<Point>> = Vec::new();
        for (c, f) in chains.iter().zip(&fitted) {
            if !(stitched(c.left) || stitched(c.right)) || f.is_empty() {
                continue;
            }
            let contrast = match (colour_lab(c.left), colour_lab(c.right)) {
                (Some(a), Some(b)) => vision::delta_e(a, b),
                _ => 100.0,
            };
            if contrast < opts.edge_contrast {
                continue;
            }
            let sp = segs_to_subpath(f, s, false);
            let mut pts = sp.flatten(0.05);
            if c.closed && pts.len() > 2 {
                pts.push(pts[0]);
            }
            // short pieces join their neighbours (a 0.3 mm link between two
            // edges must not leave a gap): the minimum length applies after joining
            if pts.len() >= 2 {
                lines.push(pts);
            }
        }
        let half = outline_half(opts.edge_outlines);
        for l in join_polylines(lines, 0.05) {
            if polyline_length(&l) < 1.0 {
                continue;
            }
            let closed = l.len() > 3 && l[0].dist(*l.last().unwrap()) < 0.05;
            let pts = simplify(&l, ctx.tol * 0.5);
            let mut sp = SubPath::polyline(&round_pts(&pts), closed);
            if closed && sp.nodes.len() > 3 {
                sp.nodes.pop();
            }
            edge_lines.extend(cover.keep_new(&l, sp, half + gap / 2.0, 1.0));
            cover.stamp(&l, half + gap / 2.0);
        }
    }

    if !edge_lines.is_empty() {
        let tid = outline_thread(&mut threads);
        for (k, sp) in edge_lines.into_iter().enumerate() {
            make_outline(vec![sp], format!("Edge outline {}", k + 1), tid.clone(), opts.edge_outlines, &mut objects);
        }
    }

    // satin edges of the colours that have one: in the colour's own thread, along the
    // boundaries between its shapes and the background (where something else lies
    // against it, that sits in front and covers the edge's end)
    if opts.seamless && !opts.edge_colors.is_empty() && !objects.is_empty() {
        let mut want = vec![false; q.colors.len()];
        for c in &opts.edge_colors {
            if let Some(l) = nearest_label(&q.colors, *c) {
                want[l] = !background[l];
            }
        }
        let label_of = |comp: u32| -> Option<usize> {
            if comp == boundary::OUTSIDE {
                return None;
            }
            let l = cc.comps[comp as usize].label as usize;
            (l < q.colors.len()).then_some(l)
        };
        let bg_side = |comp: u32| label_of(comp).is_none_or(|l| background[l]);
        for l in (0..q.colors.len()).filter(|&l| want[l]) {
            let mut lines: Vec<Vec<Point>> = Vec::new();
            for (c, f) in chains.iter().zip(&fitted) {
                let ours = |comp: u32| label_of(comp) == Some(l);
                if f.is_empty() || !((ours(c.left) && bg_side(c.right)) || (ours(c.right) && bg_side(c.left))) {
                    continue;
                }
                let sp = segs_to_subpath(f, s, false);
                let mut pts = sp.flatten(0.05);
                if c.closed && pts.len() > 2 {
                    pts.push(pts[0]);
                }
                if pts.len() >= 2 {
                    lines.push(pts);
                }
            }
            let (tid, tname) = label_thread(l, &mut threads);
            let mut k = 0;
            for line in join_polylines(lines, 0.05) {
                if polyline_length(&line) < 2.0 {
                    continue;
                }
                let closed = line.len() > 3 && line[0].dist(*line.last().unwrap()) < 0.05;
                let pts = simplify(&line, ctx.tol * 0.5);
                let mut sp = SubPath::polyline(&round_pts(&pts), closed);
                if closed && sp.nodes.len() > 3 {
                    sp.nodes.pop();
                }
                k += 1;
                make_outline(vec![sp], format!("{tname} edge {k}"), tid.clone(), OutlineKind::Satin, &mut objects);
            }
        }
    }

    // line art from the picture: coherent lines, learned edges or a learned
    // line drawing — vectorised like the lines of the picture (junctions,
    // gaps, sub-pixel centres) and left out where a line already runs
    if !pixel && opts.line_art != LineArt::None {
        let strength = opts.line_strength.clamp(0.0, 1.0);
        // the line mask and a ridge map (largest at the middle of a line)
        let found: Option<(Vec<bool>, Vec<f32>)> = match opts.line_art {
            LineArt::Coherent => etf.as_ref().map(|etf| {
                let m = filters::fdog_lines(&filters::luminance(&lab), etf, 1.0, 3.0, 0.99, (0.2 + 0.6 * strength) as f32);
                (m, Vec::new())
            }),
            LineArt::Edges | LineArt::Drawing => opts.edge_map.as_ref().map(|em| {
                let raw = vision::base64_decode(&em.data);
                let map = vision::resample_u8(&raw, em.width as usize, em.height as usize, w, h);
                // a drawing's lines are solid: a lower threshold keeps them whole
                let base = if opts.line_art == LineArt::Drawing { 0.65 } else { 0.8 };
                let thr = (255.0 * (base - 0.6 * strength)).max(8.0) as u8;
                (map.iter().map(|v| *v > thr).collect(), map.iter().map(|v| *v as f32 / 64.0).collect())
            }),
            LineArt::None => None,
        };
        if let Some((mut mask, edge_ridge)) = found {
            let alpha_ok = |i: usize| (labels[i] as usize) < q.colors.len() || grads.iter().any(|(gl, _)| *gl == labels[i]);
            for (i, m) in mask.iter_mut().enumerate() {
                if !alpha_ok(i) {
                    *m = false;
                }
            }
            // the skeleton walk needs an empty one-pixel frame
            for x in 0..w {
                mask[x] = false;
                mask[(h - 1) * w + x] = false;
            }
            for y in 0..h {
                mask[y * w] = false;
                mask[y * w + w - 1] = false;
            }
            let dt = edt_sq(&mask, w, h);
            let skel = zhang_suen(&mask, w, h);
            let mut found = strokes::strokes(
                &skel,
                w,
                h,
                &|i| dt[i].sqrt(),
                &strokes::StrokeOpts { min_len: (1.5 / s).max(3.0), gap: opts.line_gap_mm.max(0.0) / s, continue_deg: opts.line_continuity.clamp(0.0, 90.0) },
            );
            if opts.line_subpixel {
                let ridge: Vec<f32> = (0..w * h).map(|i| dt[i].sqrt() as f32 + edge_ridge.get(i).copied().unwrap_or(0.0)).collect();
                for st in &mut found {
                    refine_centres(st, &ridge, w, h);
                }
            }
            let mut lines = Vec::new();
            for st in &found {
                let pts: Vec<Point> = st.pts.iter().map(|p| *p * s).collect();
                let pts = if st.closed { simplify_closed(&chaikin_closed(&pts), ctx.tol) } else { simplify(&smooth_open(&pts, 2), ctx.tol) };
                if pts.len() >= 2 && polyline_length(&pts) >= 1.5 {
                    let mut flat = pts.clone();
                    if st.closed {
                        flat.push(pts[0]);
                    }
                    let sp = SubPath::polyline(&round_pts(&pts), st.closed);
                    lines.extend(cover.keep_new(&flat, sp, gap / 2.0, 1.5));
                    cover.stamp(&flat, gap / 2.0);
                }
            }
            if !lines.is_empty() {
                // the darkest stitched colour draws the lines (or the outline colour)
                let dark = (0..q.colors.len()).filter(|&l| !background[l]).min_by(|a, b| rgb_to_lab(q.colors[*a])[0].partial_cmp(&rgb_to_lab(q.colors[*b])[0]).unwrap());
                let tid = match dark.filter(|&l| rgb_to_lab(q.colors[l])[0] < 35.0) {
                    Some(l) => label_thread(l, &mut threads).0,
                    None => outline_thread(&mut threads),
                };
                for (k, chunk) in lines.chunks(40).enumerate() {
                    make_outline(chunk.to_vec(), format!("Line art {}", k + 1), tid.clone(), OutlineKind::Running, &mut objects);
                }
            }
        }
    }

    // 10. the border outline (stitched last, on top)
    if !border.is_empty() {
        let tid = outline_thread(&mut threads);
        for (k, sp) in border.into_iter().enumerate() {
            make_outline(vec![sp], format!("Outline {}", k + 1), tid.clone(), opts.outline, &mut objects);
        }
    }
    let objects = join_colour_blocks(objects);
    let (threads, objects) = apply_color_order(threads, objects, &opts.color_order);
    DigitizeResult { threads, objects, colors: info, width_mm: s * w as f64, height_mm: s * h as f64 }
}

/// Where an object lays thread, on a 0.2 mm grid, without its outer 0.4 mm:
/// two objects whose cores meet lie on each other; ones that only share an
/// edge band (fills overlapping a little at their border) do not.
struct Core {
    x0: i64,
    y0: i64,
    w: usize,
    h: usize,
    on: Vec<bool>,
}

const CORE_CELL: f64 = 0.2;

impl Core {
    fn of(o: &Object) -> Core {
        let c = CORE_CELL;
        // the area: fills and satin rails as polygons, centre lines as bands
        let mut rings: Vec<Ring> = Vec::new();
        let mut bands: Vec<(Vec<Point>, f64)> = Vec::new();
        match &o.stitch {
            StitchParams::Fill(_) => rings = o.paths.iter().map(|sp| sp.flatten(0.1)).filter(|r| r.len() >= 3).collect(),
            StitchParams::Satin(sp) if o.paths.len() >= 2 => {
                let (a, b) = (o.paths[0].flatten(0.1), o.paths[1].flatten(0.1));
                if o.paths[0].closed {
                    rings = vec![a, b];
                } else {
                    let mut r = a;
                    r.extend(b.into_iter().rev());
                    rings = vec![r];
                }
                let _ = sp;
            }
            StitchParams::Satin(sp) => bands = o.paths.iter().map(|p| (p.flatten(0.1), sp.width / 2.0)).collect(),
            _ => bands = o.paths.iter().map(|p| (p.flatten(0.1), 0.2)).collect(),
        }
        let pts = rings.iter().flatten().chain(bands.iter().flat_map(|b| b.0.iter()));
        let (mut x0, mut y0, mut x1, mut y1) = (f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
        for p in pts {
            x0 = x0.min(p.x);
            y0 = y0.min(p.y);
            x1 = x1.max(p.x);
            y1 = y1.max(p.y);
        }
        if !x0.is_finite() {
            return Core { x0: 0, y0: 0, w: 0, h: 0, on: Vec::new() };
        }
        let pad = bands.iter().map(|b| b.1).fold(0.0, f64::max) + c;
        let (gx0, gy0) = (((x0 - pad) / c).floor() as i64, ((y0 - pad) / c).floor() as i64);
        let (w, h) = ((((x1 + pad) / c).ceil() as i64 - gx0 + 1) as usize, (((y1 + pad) / c).ceil() as i64 - gy0 + 1) as usize);
        let mut on = vec![false; w * h];
        for j in 0..h {
            let y = (gy0 + j as i64) as f64 * c + c / 2.0;
            for (a, b) in crate::geom::scanline(&rings, y) {
                let i0 = (((a / c) - 0.5).ceil() as i64 - gx0).max(0);
                let i1 = (((b / c) - 0.5).floor() as i64 - gx0).min(w as i64 - 1);
                for i in i0..=i1 {
                    on[j * w + i as usize] = true;
                }
            }
        }
        for (line, r) in &bands {
            let rc = (r / c).ceil() as i64;
            let r2 = (r / c).powi(2);
            let mut stamp = |p: Point| {
                let (cx, cy) = ((p.x / c - 0.5).round() as i64 - gx0, (p.y / c - 0.5).round() as i64 - gy0);
                for dy in -rc..=rc {
                    for dx in -rc..=rc {
                        let (x, y) = (cx + dx, cy + dy);
                        if (dx * dx + dy * dy) as f64 <= r2 && x >= 0 && y >= 0 && (x as usize) < w && (y as usize) < h {
                            on[y as usize * w + x as usize] = true;
                        }
                    }
                }
            };
            for seg in line.windows(2) {
                let n = (seg[0].dist(seg[1]) / (c * 0.5)).ceil().max(1.0) as usize;
                for k in 0..=n {
                    stamp(seg[0] + (seg[1] - seg[0]) * (k as f64 / n as f64));
                }
            }
            if line.len() == 1 {
                stamp(line[0]);
            }
        }
        // the core: two cells in from every edge
        for _ in 0..2 {
            let prev = on.clone();
            for j in 0..h {
                for i in 0..w {
                    let k = j * w + i;
                    if prev[k] && (i == 0 || j == 0 || i + 1 == w || j + 1 == h || !prev[k - 1] || !prev[k + 1] || !prev[k - w] || !prev[k + w]) {
                        on[k] = false;
                    }
                }
            }
        }
        Core { x0: gx0, y0: gy0, w, h, on }
    }

    fn meets(&self, other: &Core) -> bool {
        let (ax1, ay1) = (self.x0 + self.w as i64, self.y0 + self.h as i64);
        let (bx1, by1) = (other.x0 + other.w as i64, other.y0 + other.h as i64);
        let (x0, y0, x1, y1) = (self.x0.max(other.x0), self.y0.max(other.y0), ax1.min(bx1), ay1.min(by1));
        (y0..y1).any(|y| (x0..x1).any(|x| self.on[((y - self.y0) as usize) * self.w + (x - self.x0) as usize] && other.on[((y - other.y0) as usize) * other.w + (x - other.x0) as usize]))
    }
}

/// Fewer colour changes: every object joins the last earlier block of its
/// thread when nothing sewn in between lies under or over it (an eye's dark
/// fill joins the dark outlines, a colour's strip joins its fills). Where
/// two objects lie on each other their order stays.
fn join_colour_blocks(objects: Vec<Object>) -> Vec<Object> {
    let cores: Vec<Core> = objects.iter().map(Core::of).collect();
    let mut order: Vec<usize> = Vec::with_capacity(objects.len());
    for i in 0..objects.len() {
        if let Some(pos) = order.iter().rposition(|&j| objects[j].thread == objects[i].thread) {
            if pos + 1 < order.len() && order[pos + 1..].iter().all(|&j| !cores[i].meets(&cores[j])) {
                // after the block's last object of this thread
                let mut at = pos + 1;
                while at < order.len() && objects[order[at]].thread == objects[i].thread {
                    at += 1;
                }
                order.insert(at, i);
                continue;
            }
        }
        order.push(i);
    }
    let mut slots: Vec<Option<Object>> = objects.into_iter().map(Some).collect();
    order.into_iter().map(|i| slots[i].take().unwrap()).collect()
}

/// Sew the objects in the given colour order (each listed colour matched to the nearest
/// thread of the result); within a colour, and for unlisted colours after the listed
/// ones, the digitizer's own order stays. The threads follow in first-use order.
fn apply_color_order(threads: Vec<Thread>, objects: Vec<Object>, order: &[[u8; 3]]) -> (Vec<Thread>, Vec<Object>) {
    if order.is_empty() || threads.is_empty() {
        return (threads, objects);
    }
    let labs: Vec<[f64; 3]> = threads.iter().map(|t| rgb_to_lab(t.rgb())).collect();
    let mut rank = vec![usize::MAX; threads.len()];
    for (r, c) in order.iter().enumerate() {
        let lab = rgb_to_lab(*c);
        let best = (0..threads.len())
            .filter(|&i| rank[i] == usize::MAX)
            .min_by(|&a, &b| vision::delta_e(labs[a], lab).partial_cmp(&vision::delta_e(labs[b], lab)).unwrap());
        if let Some(i) = best {
            if vision::delta_e(labs[i], lab) < 12.0 {
                rank[i] = r;
            }
        }
    }
    let rank_of = |o: &Object| threads.iter().position(|t| t.id == o.thread).map_or(usize::MAX, |i| rank[i]);
    let mut objects: Vec<(usize, Object)> = objects.into_iter().map(|o| (rank_of(&o), o)).collect();
    objects.sort_by_key(|(r, _)| *r); // stable: the digitizer's order within a colour
    let objects: Vec<Object> = objects.into_iter().map(|(_, o)| o).collect();
    let mut sorted: Vec<Thread> = Vec::with_capacity(threads.len());
    for o in &objects {
        if !sorted.iter().any(|t| t.id == o.thread) {
            if let Some(t) = threads.iter().find(|t| t.id == o.thread) {
                sorted.push(t.clone());
            }
        }
    }
    for t in threads {
        if !sorted.iter().any(|x| x.id == t.id) {
            sorted.push(t);
        }
    }
    (sorted, objects)
}

/// The quantised colour a picked colour stands for (nearest in Lab).
fn nearest_label(colors: &[[u8; 3]], rgb: [u8; 3]) -> Option<usize> {
    let l = rgb_to_lab(rgb);
    colors
        .iter()
        .enumerate()
        .map(|(i, c)| {
            let c = rgb_to_lab(*c);
            (i, (c[0] - l[0]).powi(2) + (c[1] - l[1]).powi(2) + (c[2] - l[2]).powi(2))
        })
        .min_by(|a, b| a.1.partial_cmp(&b.1).unwrap())
        .map(|(i, _)| i)
}

/// Colours the user marked as lines / as fills (per label).
fn colour_roles(colors: &[[u8; 3]], opts: &DigitizeOptions) -> (Vec<bool>, Vec<bool>) {
    let mut line = vec![false; colors.len()];
    let mut fill = vec![false; colors.len()];
    for c in &opts.line_colors {
        if let Some(l) = nearest_label(colors, *c) {
            line[l] = true;
        }
    }
    for c in &opts.fill_colors {
        if let Some(l) = nearest_label(colors, *c) {
            fill[l] = true;
            line[l] = false;
        }
    }
    (line, fill)
}

/// Sub-pixel centring: every point moves across the line to the centroid of
/// `ridge` (largest at the line's middle) over the line's width — the line
/// follows the drawn centre, not the pixel grid (a light form of Steger's
/// ridge detection, TPAMI 1998).
fn refine_centres(st: &mut strokes::Stroke, ridge: &[f32], w: usize, h: usize) {
    let n = st.pts.len();
    if n < 3 {
        return;
    }
    let sample = |x: f64, y: f64| -> f64 {
        let x = (x - 0.5).clamp(0.0, (w - 1) as f64);
        let y = (y - 0.5).clamp(0.0, (h - 1) as f64);
        let (x0, y0) = (x.floor() as usize, y.floor() as usize);
        let (x1, y1) = ((x0 + 1).min(w - 1), (y0 + 1).min(h - 1));
        let (fx, fy) = (x - x0 as f64, y - y0 as f64);
        let v = |xx: usize, yy: usize| ridge[yy * w + xx] as f64;
        (v(x0, y0) * (1.0 - fx) + v(x1, y0) * fx) * (1.0 - fy) + (v(x0, y1) * (1.0 - fx) + v(x1, y1) * fx) * fy
    };
    let orig = st.pts.clone();
    for i in 0..n {
        let a = if i == 0 { if st.closed { orig[n - 1] } else { orig[0] } } else { orig[i - 1] };
        let b = if i + 1 == n { if st.closed { orig[0] } else { orig[n - 1] } } else { orig[i + 1] };
        let d = b - a;
        let l = d.length();
        if l < 1e-9 {
            continue;
        }
        let nrm = pt(-d.y / l, d.x / l);
        let r = (st.widths[i] / 2.0 + 1.0).clamp(1.5, 6.0);
        let mut vals = Vec::new();
        let mut t = -r;
        while t <= r + 1e-9 {
            let q = orig[i] + nrm * t;
            vals.push((t, sample(q.x, q.y)));
            t += 0.25;
        }
        let lo = vals.iter().map(|v| v.1).fold(f64::INFINITY, f64::min);
        let (mut sw, mut st_) = (0.0, 0.0);
        for (t, v) in &vals {
            let wgt = (v - lo).max(0.0);
            sw += wgt;
            st_ += wgt * t;
        }
        if sw > 1e-9 {
            let off = (st_ / sw).clamp(-0.75, 0.75);
            st.pts[i] = orig[i] + nrm * off;
        }
    }
}

/// Zig-zag photo: rows of zigzags across the picture, their width following its
/// darkness (wider and denser where darker); light parts stay empty. One colour (the darkest stitched one).
fn photo_zigzag(prep: &Prepared, opts: &DigitizeOptions) -> DigitizeResult {
    let (w, h, s) = (prep.w, prep.h, prep.s);
    let ncolors = prep.colors.len();
    // darkness 0..1 per pixel; transparent and removed background are empty
    let dark: Vec<f32> = (0..w * h)
        .map(|i| {
            let l = prep.labels[i] as usize;
            if l >= ncolors || prep.background[l] {
                return 0.0;
            }
            let lum = (prep.lab.data[i * 3] / 100.0).clamp(0.0, 1.0);
            (1.0 - lum).powf(opts.photo_contrast.clamp(0.3, 4.0) as f32)
        })
        .collect();
    let sample = |x: f64, y: f64| -> f64 {
        let (px, py) = (x / s - 0.5, y / s - 0.5);
        if px < 0.0 || py < 0.0 || px > (w - 1) as f64 || py > (h - 1) as f64 {
            return 0.0;
        }
        let (x0, y0) = (px.floor() as usize, py.floor() as usize);
        let (x1, y1) = ((x0 + 1).min(w - 1), (y0 + 1).min(h - 1));
        let (fx, fy) = (px - x0 as f64, py - y0 as f64);
        let v = |a: usize, b: usize| dark[b * w + a] as f64;
        (v(x0, y0) * (1.0 - fx) + v(x1, y0) * fx) * (1.0 - fy) + (v(x0, y1) * (1.0 - fx) + v(x1, y1) * fx) * fy
    };
    let (wm, hm) = (w as f64 * s, h as f64 * s);
    let spacing = opts.photo_spacing.clamp(0.4, 5.0);
    // darker: wider and denser zigzags; lighter: narrow and airy
    let (pitch_dark, pitch_light) = ((spacing * 0.35).clamp(0.25, 1.0), (spacing * 1.2).clamp(0.6, 2.5));
    let amp = spacing * 0.5;
    let a = opts.photo_angle.to_radians();
    let (dir, nrm) = (pt(a.cos(), -a.sin()), pt(a.sin(), a.cos()));
    let c = pt(wm / 2.0, hm / 2.0);
    let reach = (wm * wm + hm * hm).sqrt() / 2.0 + spacing;
    let rows = (2.0 * reach / spacing).ceil() as i64;
    let mut paths: Vec<SubPath> = Vec::new();
    for k in 0..=rows {
        let v = -reach + k as f64 * spacing;
        let mut piece: Vec<Point> = Vec::new();
        let mut flush = |piece: &mut Vec<Point>| {
            if piece.len() >= 3 {
                // serpentine: every other row backwards (fewer jumps)
                if k % 2 == 1 {
                    piece.reverse();
                }
                paths.push(SubPath::polyline(&round_pts(piece), false));
            }
            piece.clear();
        };
        let mut u = -reach;
        let mut side = 1.0;
        while u <= reach {
            let q = c + dir * u + nrm * v;
            let d = sample(q.x, q.y);
            if d < opts.photo_min {
                flush(&mut piece);
                u += pitch_dark;
                continue;
            }
            piece.push(q + nrm * (side * d * amp));
            side = -side;
            u += pitch_light + (pitch_dark - pitch_light) * d;
        }
        flush(&mut piece);
    }
    let mut threads: Vec<Thread> = Vec::new();
    let mut objects: Vec<Object> = Vec::new();
    if !paths.is_empty() {
        let darkest = (0..ncolors).filter(|&l| !prep.background[l]).min_by(|x, y| rgb_to_lab(prep.colors[*x])[0].partial_cmp(&rgb_to_lab(prep.colors[*y])[0]).unwrap());
        let rgb = darkest.map(|l| prep.colors[l]).filter(|c| rgb_to_lab(*c)[0] < 45.0).unwrap_or([20, 20, 20]);
        let (rgb, name, code, brand) = snap_rgb(rgb, opts);
        let tid = ensure_thread(&mut threads, rgb, name, code, brand);
        objects.push(Object {
            id: "dz1".into(),
            name: "Zig-zag photo".into(),
            thread: tid,
            visible: true,
            locked: false,
            paths,
            stitch: StitchParams::Manual(Default::default()),
            trim_after: false,
            stop_after: false,
            ties: Default::default(),
            force_lock: false,
            min_stitch: None,
            min_jump: None,
            clone: None,
            hidden: None,
            patterns: vec![],
            start: None,
            end: None,
        });
    }
    DigitizeResult { threads, objects, colors: prep.info.clone(), width_mm: wm, height_mm: hm }
}

/// A stroke of a line in the picture and the colour it is sewn in.
struct LineStroke {
    stroke: strokes::Stroke,
    /// An existing colour of the design that matches it.
    label: Option<usize>,
    /// Its own colour otherwise.
    rgb: [u8; 3],
    /// A dark line (ink or a dark colour's narrow region): an outline, sewn
    /// at the outline width when one is set.
    ink: bool,
}

/// Lines in the picture: dark ink strokes (black-hat on lightness, with
/// hysteresis) and colour regions that are narrow and long (branched or not).
/// Returns the line pixels and their strokes (pixel coordinates) with the
/// colour label each one is sewn in.
#[allow(clippy::too_many_arguments)]
fn find_lines(
    lab: &Img,
    labels: &[u8],
    cc: &Components,
    background: &[bool],
    grads: &[(u8, GradientRegion)],
    colors: &[[u8; 3]],
    w: usize,
    h: usize,
    s: f64,
    opts: &DigitizeOptions,
) -> Option<(Vec<bool>, Vec<bool>, Vec<LineStroke>)> {
    let ncolors = colors.len();
    let colors_rgb = |l: usize| colors[l];
    // the widest line a stroke can sew: satin up to the line width, else running only
    let limit_mm = if opts.allow_satin {
        opts.line_max_width_mm.min(opts.satin_max_width_mm.max(0.8))
    } else if opts.allow_running {
        opts.running_max_width_mm
    } else {
        return None;
    };
    let max_w = (limit_mm.clamp(0.3, 10.0) / s).max(1.5); // px
    let min_len = opts.line_min_mm.max(0.0) / s;
    let is_grad = |l: usize| grads.iter().any(|(gl, _)| *gl as usize == l);
    let (as_line, as_fill) = colour_roles(colors, opts);
    let fill_px = |i: usize| (labels[i] as usize) < ncolors && as_fill[labels[i] as usize];
    let stitchable = |i: usize| ((labels[i] as usize) < ncolors || is_grad(labels[i] as usize)) && !fill_px(i);
    let mut mask = vec![false; w * h];
    // pixels of colours marked as lines (their strokes are kept whatever their width)
    let mut forced = vec![false; w * h];
    // darkness above the local background (for sub-pixel centring)
    let mut ink_ridge: Option<Vec<f32>> = None;

    // 1. ink: thin structures darker than their surroundings
    if opts.ink_sensitivity > 0.0 {
        let r = (max_w / 2.0).ceil() as usize + 1;
        let lum: Vec<f32> = (0..w * h).map(|i| lab.data[i * 3]).collect();
        let closed = grey_close(&lum, w, h, r);
        let k = (opts.ink_sensitivity / 100.0).clamp(0.0, 1.0) as f32;
        let hi = 32.0 - 24.0 * k; // ΔL* above the local background
        let lo = hi * 0.5;
        let bh: Vec<f32> = (0..w * h).map(|i| closed[i] - lum[i]).collect();
        ink_ridge = Some(bh.clone());
        // hysteresis: weak line pixels count when connected to strong ones
        let mut stack: Vec<usize> = (0..w * h).filter(|&i| bh[i] >= hi && stitchable(i)).collect();
        for &i in &stack {
            mask[i] = true;
        }
        while let Some(i) = stack.pop() {
            let (x, y) = (i % w, i / w);
            for (dx, dy) in [(-1i64, 0i64), (1, 0), (0, -1), (0, 1), (-1, -1), (1, 1), (-1, 1), (1, -1)] {
                let (nx, ny) = (x as i64 + dx, y as i64 + dy);
                if nx < 0 || ny < 0 || nx >= w as i64 || ny >= h as i64 {
                    continue;
                }
                let j = ny as usize * w + nx as usize;
                if !mask[j] && bh[j] >= lo && stitchable(j) {
                    mask[j] = true;
                    stack.push(j);
                }
            }
        }
        // ink the colour regions explain (as light as its region's colour: the darkness
        // only comes from a lighter neighbour) must also look like a line there:
        // narrow in its region (not a shape's body) and most of its region (not the
        // narrow parts of a big area: a banner between knocked-out letters, a rim).
        // Ink darker than its region's colour (a pen line merged into the panel by the
        // colour reduction) is ink whatever the region.
        // (against the region's body, its pixels that are not ink: a pen line merged
        // into a lighter fill by the colour reduction drags the region's colour down)
        let mut body_l = vec![f64::NAN; w * h];
        for c in &cc.comps {
            let pix = &cc.order[c.start..c.start + c.len];
            let (sum, n) = pix.iter().filter(|&&p| !mask[p as usize]).fold((0.0, 0usize), |a, &p| (a.0 + lum[p as usize] as f64, a.1 + 1));
            let l = c.label as usize;
            let v = if n > 0 { sum / n as f64 } else if l < ncolors { rgb_to_lab(colors_rgb(l))[0] } else { f64::NAN };
            for &p in pix {
                body_l[p as usize] = v;
            }
        }
        let explained = |i: usize| (labels[i] as usize) >= ncolors || body_l[i].is_nan() || lum[i] as f64 > body_l[i] - hi as f64;
        let mut edge = vec![true; w * h];
        for y in 0..h {
            for x in 0..w {
                let l = labels[y * w + x];
                let differs = |nx: usize, ny: usize| labels[ny * w + nx] != l;
                if x == 0 || y == 0 || x + 1 == w || y + 1 == h || differs(x - 1, y) || differs(x + 1, y) || differs(x, y - 1) || differs(x, y + 1) {
                    edge[y * w + x] = false;
                }
            }
        }
        let r2 = (max_w / 2.0 + 0.5).powi(2);
        let core: Vec<bool> = edt_sq(&edge, w, h).iter().map(|&d| d > r2).collect();
        let not_core: Vec<bool> = core.iter().map(|c| !c).collect();
        let near_core = edt_sq(&not_core, w, h);
        let grow2 = (r2.sqrt() + 1.5).powi(2);
        for i in 0..w * h {
            if mask[i] && (core[i] || near_core[i] <= grow2) && explained(i) {
                mask[i] = false;
            }
        }
        // ink is a colour region that is mostly line: the narrow parts of a big
        // area (a banner between knocked-out letters, its anti-aliased rim) stay fill
        for c in &cc.comps {
            let pix = &cc.order[c.start..c.start + c.len];
            let ink = pix.iter().filter(|&&p| mask[p as usize]).count();
            if ink > 0 && (ink as f64) < 0.5 * c.len as f64 {
                for &p in pix {
                    if explained(p as usize) {
                        mask[p as usize] = false;
                    }
                }
            }
        }
    }

    // the ink found on the picture itself
    let ink_px = mask.clone();
    // pixels of colour regions that are lines (each traced in its own colour)
    let mut colour_line = vec![false; w * h];
    // 2. colour regions that are lines: narrow everywhere and long
    for c in &cc.comps {
        let label = c.label as usize;
        if label >= ncolors || background[label] || is_grad(label) || c.len < 4 || as_fill[label] {
            continue;
        }
        let pix = &cc.order[c.start..c.start + c.len];
        if as_line[label] {
            for &p in pix {
                mask[p as usize] = true;
                forced[p as usize] = true;
                colour_line[p as usize] = true;
            }
            continue;
        }
        let cw = c.x1 - c.x0 + 3;
        let ch = c.y1 - c.y0 + 3;
        let mut m = vec![false; cw * ch];
        for &p in pix {
            let (x, y) = (p as usize % w, p as usize / w);
            m[(y - c.y0 + 1) * cw + (x - c.x0 + 1)] = true;
        }
        let dt = edt_sq(&m, cw, ch);
        let skel = zhang_suen(&m, cw, ch);
        let mut radii: Vec<f64> = (0..cw * ch).filter(|&i| skel[i]).map(|i| dt[i].sqrt()).collect();
        if radii.len() < 3 {
            continue;
        }
        radii.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let p95 = radii[(radii.len() * 95 / 100).min(radii.len() - 1)];
        let len = radii.len() as f64;
        let mean_w = c.len as f64 / len;
        if 2.0 * p95 - 0.5 > max_w || len < 3.0 * mean_w || len < min_len.max(3.0) {
            continue;
        }
        for &p in pix {
            mask[p as usize] = true;
            colour_line[p as usize] = true;
        }
    }
    if !mask.iter().any(|v| *v) {
        return None;
    }
    // the skeleton walk needs an empty one-pixel frame
    for x in 0..w {
        mask[x] = false;
        mask[(h - 1) * w + x] = false;
    }
    for y in 0..h {
        mask[y * w] = false;
        mask[y * w + w - 1] = false;
    }
    // every kind of line is traced on its own: ink and dark lines together,
    // each other colour apart. A narrow coloured strip between two outlines
    // (a hat brim, a stripe) merged with them would make one blob too wide
    // for a line: its own stroke would be lost and its pixels with it.
    let dark: Vec<bool> = (0..ncolors).map(|l| rgb_to_lab(colors_rgb(l))[0] <= 45.0).collect();
    let class: Vec<u16> = (0..w * h)
        .map(|i| {
            let l = labels[i] as usize;
            if !mask[i] {
                0
            } else if l >= ncolors || dark[l] || !colour_line[i] {
                // ink (with its anti-aliased rim) and dark colours' lines
                1
            } else {
                l as u16 + 2
            }
        })
        .collect();
    let mut classes: Vec<u16> = class.iter().copied().filter(|c| *c > 0).collect();
    classes.sort_unstable();
    classes.dedup();
    // a stroke too wide for a line (a blob the ink test caught) stays a fill —
    // unless its colour is marked as lines
    let on_forced = |st: &strokes::Stroke| {
        st.pts.iter().any(|p| {
            let (x, y) = ((p.x - 0.5).round().max(0.0) as usize, (p.y - 0.5).round().max(0.0) as usize);
            forced[y.min(h - 1) * w + x.min(w - 1)]
        })
    };
    let mut found: Vec<(strokes::Stroke, bool)> = Vec::new();
    for &k in &classes {
        let sub: Vec<bool> = class.iter().map(|c| *c == k).collect();
        let dt = edt_sq(&sub, w, h);
        let skel = zhang_suen(&sub, w, h);
        let traced = strokes::strokes(
            &skel,
            w,
            h,
            &|i| dt[i].sqrt(),
            &strokes::StrokeOpts { min_len: min_len.max(2.0), gap: opts.line_gap_mm.max(0.0) / s, continue_deg: opts.line_continuity.clamp(0.0, 90.0) },
        );
        let mut kept: Vec<strokes::Stroke> = traced
            .into_iter()
            .filter(|st| {
                let mut ws = st.widths.clone();
                ws.sort_by(|a, b| a.partial_cmp(b).unwrap());
                let wd = ws[ws.len() / 2] - 0.5;
                // a line is long for its width: a short, wide one is a blob (two dots the ink test joined)
                let long = st.closed || polyline_length(&st.pts) >= 2.0 * wd;
                (wd <= max_w * 1.1 && long) || on_forced(st)
            })
            .collect();
        // sub-pixel centres: the ink's darkness profile, else the distance to the line's edge
        if opts.line_subpixel {
            let ridge: Vec<f32> = (0..w * h).map(|i| dt[i].sqrt() as f32 + if k == 1 { ink_ridge.as_ref().map_or(0.0, |b| b[i].max(0.0) / 8.0) } else { 0.0 }).collect();
            for st in &mut kept {
                refine_centres(st, &ridge, w, h);
            }
        }
        found.extend(kept.into_iter().map(|st| (st, k == 1)));
    }
    // a dark line inside a dark area sewn as a fill (an eye, a nose), or along
    // its edge, sews again what the fill sews: the ink test caught the area's
    // rim. Lines leaving the area (an outline joining it) run mostly elsewhere.
    {
        let mut blob = vec![false; w * h];
        for c in &cc.comps {
            let l = c.label as usize;
            if l < ncolors && dark[l] {
                for &p in &cc.order[c.start..c.start + c.len] {
                    if !colour_line[p as usize] && !ink_px[p as usize] {
                        blob[p as usize] = true;
                    }
                }
            }
        }
        // every pixel within 2.5 px of such an area: the area's lightness
        let mut near_l = vec![f32::NAN; w * h];
        let mut queue: std::collections::VecDeque<(usize, u8)> = std::collections::VecDeque::new();
        for i in 0..w * h {
            if blob[i] {
                near_l[i] = rgb_to_lab(colors_rgb(labels[i] as usize))[0] as f32;
                queue.push_back((i, 0));
            }
        }
        while let Some((i, d)) = queue.pop_front() {
            if d >= 2 {
                continue;
            }
            let (x, y) = (i % w, i / w);
            for j in [(x > 0).then(|| i - 1), (x + 1 < w).then(|| i + 1), (y > 0).then(|| i - w), (y + 1 < h).then(|| i + w)].into_iter().flatten() {
                if near_l[j].is_nan() {
                    near_l[j] = near_l[i];
                    queue.push_back((j, d + 1));
                }
            }
        }
        // (a pen line darker than the area it is drawn on is a line of its own)
        found.retain(|(st, ink)| {
            if !*ink || st.pts.is_empty() {
                return true;
            }
            let on = st
                .pts
                .iter()
                .filter(|p| {
                    let (x, y) = ((p.x - 0.5).round().max(0.0) as usize, (p.y - 0.5).round().max(0.0) as usize);
                    let i = y.min(h - 1) * w + x.min(w - 1);
                    !near_l[i].is_nan() && lab.data[i * 3] >= near_l[i] - 12.0
                })
                .count();
            (on as f64) < 0.6 * st.pts.len() as f64
        });
    }
    if found.is_empty() {
        return None;
    }
    // line pixels are the pieces of the mask a kept stroke runs through (of its own
    // kind of line): the fills grow under those only; a piece without one (its
    // strokes pruned, too wide, too short: a letter whose stroke was dropped) stays fill
    let mut piece = vec![u32::MAX; w * h];
    let mut keep: Vec<bool> = Vec::new();
    for start in 0..w * h {
        if !mask[start] || piece[start] != u32::MAX {
            continue;
        }
        let id = keep.len() as u32;
        keep.push(false);
        piece[start] = id;
        let mut stack = vec![start];
        while let Some(i) = stack.pop() {
            let (x, y) = (i % w, i / w);
            for (dx, dy) in [(-1i64, 0i64), (1, 0), (0, -1), (0, 1), (-1, -1), (1, 1), (-1, 1), (1, -1)] {
                let (nx, ny) = (x as i64 + dx, y as i64 + dy);
                if nx < 0 || ny < 0 || nx >= w as i64 || ny >= h as i64 {
                    continue;
                }
                let j = ny as usize * w + nx as usize;
                if mask[j] && piece[j] == u32::MAX && class[j] == class[i] {
                    piece[j] = id;
                    stack.push(j);
                }
            }
        }
    }
    for (st, ink) in &found {
        for p in &st.pts {
            let (x, y) = ((p.x - 0.5).round().max(0.0) as usize, (p.y - 0.5).round().max(0.0) as usize);
            let i = y.min(h - 1) * w + x.min(w - 1);
            let k = piece[i];
            if k != u32::MAX && (class[i] == 1) == *ink {
                keep[k as usize] = true;
            }
        }
    }
    for i in 0..w * h {
        if mask[i] && !keep[piece[i] as usize] {
            mask[i] = false;
        }
    }
    // the colour of a stroke: the picture's colour along it (a thin line may
    // have been merged into its surroundings by the colour reduction), as an
    // existing thread colour when one is close
    let mut out = Vec::new();
    for (st, ink) in found {
        let mut ls: Vec<f32> = Vec::new();
        let (mut sa, mut sb) = (0f64, 0f64);
        for p in &st.pts {
            let (x, y) = ((p.x - 0.5).round().max(0.0) as usize, (p.y - 0.5).round().max(0.0) as usize);
            let i = y.min(h - 1) * w + x.min(w - 1);
            ls.push(lab.data[i * 3]);
            sa += lab.data[i * 3 + 1] as f64;
            sb += lab.data[i * 3 + 2] as f64;
        }
        ls.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let n = st.pts.len().max(1) as f64;
        let col = [ls[ls.len() / 2] as f64, sa / n, sb / n];
        let label = (0..ncolors)
            .filter(|&l| !background[l])
            .map(|l| (l, vision::delta_e(col, rgb_to_lab(colors_rgb(l)))))
            .min_by(|a, b| a.1.partial_cmp(&b.1).unwrap())
            .filter(|(_, d)| *d <= 12.0)
            .map(|(l, _)| l);
        out.push(LineStroke { stroke: st, label, rgb: lab_to_rgb(col), ink });
    }
    // the pixels of coloured strips (not ink): fills reach only their edges
    let strip: Vec<bool> = (0..w * h).map(|i| mask[i] && class[i] > 1).collect();
    Some((mask, strip, out))
}

/// Moving average of a closed polyline.
fn smooth_cyclic(pts: &[Point], radius: usize) -> Vec<Point> {
    let n = pts.len();
    if n < 2 * radius + 3 {
        return pts.to_vec();
    }
    (0..n)
        .map(|i| {
            let mut acc = pt(0.0, 0.0);
            for k in 0..=2 * radius {
                acc += pts[(i + n + k - radius) % n];
            }
            acc * (1.0 / (2 * radius + 1) as f64)
        })
        .collect()
}

/// Grey-level closing (max then min filter, square of radius r): fills dark
/// structures narrower than 2r with their surroundings.
fn grey_close(v: &[f32], w: usize, h: usize, r: usize) -> Vec<f32> {
    let pass = |src: &[f32], horizontal: bool, take_max: bool| -> Vec<f32> {
        let mut out = vec![0f32; src.len()];
        let (outer, inner) = if horizontal { (h, w) } else { (w, h) };
        let mut line = vec![0f32; inner];
        for o in 0..outer {
            for (i, x) in line.iter_mut().enumerate() {
                *x = src[if horizontal { o * w + i } else { i * w + o }];
            }
            for (i, x) in sliding_extreme(&line, r, take_max).into_iter().enumerate() {
                out[if horizontal { o * w + i } else { i * w + o }] = x;
            }
        }
        out
    };
    let d = pass(&pass(v, true, true), false, true);
    pass(&pass(&d, true, false), false, false)
}

/// The max (or min) of every window `i - r ..= i + r` of `x` (clipped at the
/// ends), in constant time per element (van Herk / Gil-Werman): block-wise
/// running extremes from the left and from the right, one of each per window.
fn sliding_extreme(x: &[f32], r: usize, take_max: bool) -> Vec<f32> {
    let n = x.len();
    let k = 2 * r + 1;
    let neutral = if take_max { f32::MIN } else { f32::MAX };
    let op = |a: f32, b: f32| if take_max { a.max(b) } else { a.min(b) };
    // padded by r neutral values on both sides, rounded up to whole blocks
    let len = (n + 2 * r).div_ceil(k) * k;
    let at = |j: usize| if j >= r && j - r < n { x[j - r] } else { neutral };
    let mut left = vec![neutral; len];
    let mut right = vec![neutral; len];
    for j in 0..len {
        left[j] = if j % k == 0 { at(j) } else { op(left[j - 1], at(j)) };
    }
    for j in (0..len).rev() {
        right[j] = if j % k == k - 1 || j + 1 == len { at(j) } else { op(right[j + 1], at(j)) };
    }
    // the window of element i is padded j = i .. i + 2r
    (0..n).map(|i| op(right[i], left[i + k - 1])).collect()
}

/// Line pixels take the colour of the nearest other pixel: the fills on both
/// sides of a line meet under its middle (the stroke covers the seam).
/// The fills around a line grow under it to its centre (no gap can show
/// beside it). Under a coloured strip (`strip`, a satin of its own colour)
/// they reach in at most `max_px` pixels: nothing is sewn twice under its
/// middle — those pixels get `empty`, a label that is not stitched.
fn grow_under_lines(labels: &mut [u8], line: &[bool], strip: &[bool], w: usize, h: usize, max_px: u32, empty: u8) {
    let mut done: Vec<bool> = line.iter().map(|l| !l).collect();
    let mut dist = vec![0u32; w * h];
    let mut queue: std::collections::VecDeque<usize> = (0..w * h).filter(|&i| !line[i]).collect();
    while let Some(i) = queue.pop_front() {
        let (x, y) = (i % w, i / w);
        let l = labels[i];
        for j in [if x > 0 { i - 1 } else { usize::MAX }, if x + 1 < w { i + 1 } else { usize::MAX }, if y > 0 { i - w } else { usize::MAX }, if y + 1 < h { i + w } else { usize::MAX }] {
            if j != usize::MAX && !done[j] {
                done[j] = true;
                dist[j] = dist[i] + 1;
                labels[j] = if strip[j] && dist[j] > max_px { empty } else { l };
                queue.push_back(j);
            }
        }
    }
}

/// A stroke as an embroidery object: running (or triple) stitch for thin
/// lines, satin for wider ones — with rails that follow the line's width,
/// or one even satin of the `fixed` width (an outline).
fn stroke_object(st: &strokes::Stroke, reverse: bool, s: f64, ctx: &Ctx, fixed: Option<f64>) -> Option<(Vec<SubPath>, StitchParams)> {
    let opts = ctx.opts;
    let mut pts: Vec<Point> = st.pts.iter().map(|p| *p * s).collect();
    let mut wid: Vec<f64> = st.widths.iter().map(|w| ((w - 0.5).max(0.5)) * s).collect();
    if reverse {
        pts.reverse();
        wid.reverse();
    }
    if pts.len() < 2 {
        return None;
    }
    let mut sorted = wid.clone();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let width = sorted[sorted.len() / 2];
    // the skeleton stops short of free ends by about the half width: give it back
    let free = if reverse { [st.free[1], st.free[0]] } else { st.free };
    if !st.closed {
        for at_start in [true, false] {
            if !free[if at_start { 0 } else { 1 }] {
                continue;
            }
            let n = pts.len();
            let (e, q) = if at_start { (pts[0], pts[(n - 1).min(3)]) } else { (pts[n - 1], pts[n.saturating_sub(4)]) };
            let d = e - q;
            let l = d.length();
            if l > 1e-9 {
                let ext = e + d * (0.4 * width / l);
                if at_start {
                    pts.insert(0, ext);
                    wid.insert(0, wid[0]);
                } else {
                    pts.push(ext);
                    wid.push(*wid.last().unwrap());
                }
            }
        }
    }
    let smooth = |pts: &[Point]| -> Vec<Point> {
        if st.closed {
            simplify_closed(&chaikin_closed(pts), ctx.tol)
        } else {
            simplify(&smooth_open(pts, 2), ctx.tol)
        }
    };
    let thin = match fixed {
        // below 1 mm a column is too narrow to sew cleanly: a triple stitch
        Some(fw) => fw < 1.0,
        None => (opts.allow_running && width < opts.running_max_width_mm) || !opts.allow_satin,
    };
    if thin {
        let line = smooth(&pts);
        if line.len() < 2 {
            return None;
        }
        let stitch = StitchParams::Running(RunningParams { length: 2.0, bean_repeats: if opts.thin_triple || fixed.is_some() { 2 } else { 0 }, ..Default::default() });
        return Some((vec![SubPath::polyline(&round_pts(&line), st.closed)], stitch));
    }
    let satin = |w: f64| SatinParams { width: r3(w), center_walk: true, contour_underlay: w > 2.5, ..Default::default() };
    // an outline: one even width along a smooth centre line
    if let Some(fw) = fixed {
        let line = smooth(&pts);
        if line.len() < 2 {
            return None;
        }
        return Some((vec![SubPath::polyline(&round_pts(&line), st.closed)], StitchParams::Satin(satin(fw.min(8.0)))));
    }
    // lines are at most the line width; colours marked as lines up to the satin width
    let max_w = opts.line_max_width_mm.max(opts.satin_max_width_mm).max(0.8);
    let w_med = width.clamp(0.8, max_w);
    let (lo, hi) = (sorted[sorted.len() / 10], sorted[sorted.len() * 9 / 10]);
    if !opts.line_taper || hi < lo * 1.3 || pts.len() < 6 {
        let line = smooth(&pts);
        if line.len() < 2 {
            return None;
        }
        return Some((vec![SubPath::polyline(&round_pts(&line), st.closed)], StitchParams::Satin(satin(w_med))));
    }
    // two rails along a smoothed centre line, sampled every ~0.6 mm
    let closed = st.closed;
    let mut centre = if closed { smooth_cyclic(&pts, 2) } else { smooth_open(&pts, 2) };

    if closed {
        // walk once around: back to the start point
        centre.push(centre[0]);
        wid.push(wid[0]);
    }
    let n = centre.len();
    let mut cum = vec![0.0; n];
    for i in 1..n {
        cum[i] = cum[i - 1] + centre[i].dist(centre[i - 1]);
    }
    let total = cum[n - 1];
    if total < 1.0 {
        return None;
    }
    let steps = ((total / 0.6).ceil() as usize).max(2);
    // widths: a moving average over ~1.5 mm, clamped to the line range
    let win = ((1.5 / (total / n as f64)).round() as usize).max(1);
    let avg: Vec<f64> = (0..wid.len())
        .map(|i| {
            let a = i.saturating_sub(win);
            let b = (i + win).min(wid.len() - 1);
            (wid[a..=b].iter().sum::<f64>() / (b - a + 1) as f64).clamp(0.6, max_w)
        })
        .collect();
    let mut j = 0;
    let mut left = Vec::with_capacity(steps + 1);
    let mut right = Vec::with_capacity(steps + 1);
    for k in 0..=steps {
        let t = total * k as f64 / steps as f64;
        while j + 1 < n - 1 && cum[j + 1] < t {
            j += 1;
        }
        let seg = (cum[j + 1] - cum[j]).max(1e-9);
        let f = ((t - cum[j]) / seg).clamp(0.0, 1.0);
        let p = centre[j] + (centre[j + 1] - centre[j]) * f;
        // tangent over a short window (around the start of a closed line)
        let (a, b) = if closed {
            let m = n - 1;
            (centre[(j + m - 2) % m], centre[(j + 3) % m])
        } else {
            (centre[j.saturating_sub(2)], centre[(j + 3).min(n - 1)])
        };
        let d = b - a;
        let l = d.length().max(1e-9);
        let nrm = pt(-d.y / l, d.x / l);
        let wi = (j as f64 + f).min((avg.len() - 1) as f64);
        let w0 = avg[wi.floor() as usize];
        let w1 = avg[(wi.ceil() as usize).min(avg.len() - 1)];
        let wv = w0 + (w1 - w0) * (wi - wi.floor());
        left.push(p + nrm * (wv / 2.0));
        right.push(p - nrm * (wv / 2.0));
    }
    if closed {
        left.pop();
        right.pop();
    }
    let rails = vec![SubPath::polyline(&round_pts(&left), closed), SubPath::polyline(&round_pts(&right), closed)];
    Some((rails, StitchParams::Satin(satin(w_med))))
}

/// Where lines are already stitched (a raster in mm): later lines keep only
/// what runs elsewhere, so two recognitions never draw the same line twice.
struct LineCover {
    g: f64,
    w: usize,
    h: usize,
    cells: Vec<bool>,
}

impl LineCover {
    fn new(width_mm: f64, height_mm: f64, g: f64) -> LineCover {
        let w = (width_mm / g).ceil() as usize + 2;
        let h = (height_mm / g).ceil() as usize + 2;
        LineCover { g, w, h, cells: vec![false; w * h] }
    }

    /// Mark everything within `r` of the polyline.
    fn stamp(&mut self, pts: &[Point], r: f64) {
        let k = (r / self.g).ceil() as isize;
        let reach = r + self.g * 0.5;
        let mut mark = |p: Point| {
            let (cx, cy) = ((p.x / self.g) as isize, (p.y / self.g) as isize);
            for dy in -k..=k {
                for dx in -k..=k {
                    let (x, y) = (cx + dx, cy + dy);
                    if x < 0 || y < 0 || x as usize >= self.w || y as usize >= self.h {
                        continue;
                    }
                    // the samples are half a cell apart: most of a disc is marked already
                    let i = y as usize * self.w + x as usize;
                    if self.cells[i] {
                        continue;
                    }
                    let c = pt((x as f64 + 0.5) * self.g, (y as f64 + 0.5) * self.g);
                    if c.dist(p) <= reach {
                        self.cells[i] = true;
                    }
                }
            }
        };
        for_samples(pts, self.g * 0.5, |p| mark(p));
    }

    /// Mark a filled area (outer rings and holes) and everything within `r` of it.
    fn stamp_area(&mut self, rings: &[Ring], r: f64) {
        let (mut x0, mut y0, mut x1, mut y1) = (f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
        for p in rings.iter().flatten() {
            x0 = x0.min(p.x);
            y0 = y0.min(p.y);
            x1 = x1.max(p.x);
            y1 = y1.max(p.y);
        }
        if !x0.is_finite() {
            return;
        }
        let cell = |v: f64, n: usize| ((v / self.g).floor().max(0.0) as usize).min(n - 1);
        for y in cell(y0, self.h)..=cell(y1, self.h) {
            for x in cell(x0, self.w)..=cell(x1, self.w) {
                if crate::geom::point_in_rings(pt((x as f64 + 0.5) * self.g, (y as f64 + 0.5) * self.g), rings) {
                    self.cells[y * self.w + x] = true;
                }
            }
        }
        for ring in rings {
            let mut closed = ring.clone();
            closed.push(ring[0]);
            self.stamp(&closed, r);
        }
    }

    /// Is anything marked within `r` of `p`?
    fn covered(&self, p: Point, r: f64) -> bool {
        let k = (r / self.g).ceil() as isize;
        let (cx, cy) = ((p.x / self.g) as isize, (p.y / self.g) as isize);
        for dy in -k..=k {
            for dx in -k..=k {
                let (x, y) = (cx + dx, cy + dy);
                if x < 0 || y < 0 || x as usize >= self.w || y as usize >= self.h {
                    continue;
                }
                if self.cells[y as usize * self.w + x as usize] && pt((x as f64 + 0.5) * self.g, (y as f64 + 0.5) * self.g).dist(p) <= r + self.g * 0.5 {
                    return true;
                }
            }
        }
        false
    }

    /// The parts of a line (`pts`, drawn as `sp`) that are not on a placed
    /// line: all of `sp` when (almost) nothing is covered, nothing when
    /// (almost) all is, else the uncovered pieces of at least `min_len` mm.
    fn keep_new(&self, pts: &[Point], sp: SubPath, r: f64, min_len: f64) -> Vec<SubPath> {
        let step = self.g * 0.5;
        let mut samples: Vec<(Point, bool)> = Vec::new();
        for_samples(pts, step, |p| samples.push((p, self.covered(p, r))));
        if samples.is_empty() {
            return vec![];
        }
        // cut only where the line really runs along another one: covered
        // stretches shorter than 2 mm (a crossing, a touch) do not break it
        let bridge = (2.0 / step).ceil() as usize;
        let mut i = 0;
        while i < samples.len() {
            if !samples[i].1 {
                i += 1;
                continue;
            }
            let start = i;
            while i < samples.len() && samples[i].1 {
                i += 1;
            }
            // (a line that lies entirely on another one is covered, however short)
            if i - start < bridge && !(start == 0 && i == samples.len()) {
                for s in &mut samples[start..i] {
                    s.1 = false;
                }
            }
        }
        let hit = samples.iter().filter(|x| x.1).count() as f64 / samples.len() as f64;
        if hit < 0.03 {
            return vec![sp];
        }
        if hit > 0.9 {
            return vec![];
        }
        let mut out = Vec::new();
        let mut run: Vec<Point> = Vec::new();
        let mut flush = |run: &mut Vec<Point>| {
            if run.len() >= 2 && polyline_length(run) >= min_len {
                out.push(SubPath::polyline(&round_pts(&simplify(run, 0.03)), false));
            }
            run.clear();
        };
        for (p, c) in samples {
            if c {
                flush(&mut run);
            } else {
                run.push(p);
            }
        }
        flush(&mut run);
        out
    }
}

/// A fill that is really a stroke: its mean width (2 × area / perimeter) is
/// at most `max_width` mm and it is at least four times as long as wide.
fn is_stroke_like(rings: &[Ring], max_width: f64) -> bool {
    let per: f64 = rings.iter().map(|r| polyline_length(r) + r.last().zip(r.first()).map_or(0.0, |(a, b)| a.dist(*b))).sum();
    // rings inside another ring are holes
    let area: f64 = rings
        .iter()
        .enumerate()
        .map(|(i, r)| {
            let hole = rings.iter().enumerate().any(|(j, o)| j != i && crate::geom::point_in_ring(r[0], o));
            if hole { -signed_area(r).abs() } else { signed_area(r).abs() }
        })
        .sum();
    if per <= 0.0 || area <= 0.0 {
        return false;
    }
    let width = 2.0 * area / per;
    width <= max_width.max(0.5) && per / 2.0 >= 4.0 * width
}

/// Points along a polyline every `step` (and its vertices).
fn for_samples(pts: &[Point], step: f64, mut f: impl FnMut(Point)) {
    if let Some(&p0) = pts.first() {
        f(p0);
    }
    for w in pts.windows(2) {
        let len = w[0].dist(w[1]);
        let n = (len / step).ceil().max(1.0) as usize;
        for i in 1..=n {
            f(w[0].lerp(w[1], i as f64 / n as f64));
        }
    }
}

/// Outer boundaries of the filled areas (strokes and holes are ignored), in mm.
fn silhouette_rings(mask: &[bool], w: usize, h: usize, s: f64, opts: &DigitizeOptions) -> Vec<Ring> {
    let rings: Vec<Ring> = trace_contours(mask, w, h)
        .into_iter()
        .map(|r| r.into_iter().map(|p| pt(p.x * s, p.y * s)).collect::<Ring>())
        .collect();
    let min_area = opts.min_region_mm2.max(1.0) * 4.0;
    let tol = opts.simplify_mm.max(0.0).max(s * 0.5);
    let mut out = Vec::new();
    for (i, r) in rings.iter().enumerate() {
        if signed_area(r).abs() < min_area {
            continue;
        }
        // outer ring ⇔ contained in an even number of other rings
        let probe = r[0].lerp(r[1 % r.len()], 0.5);
        let depth = rings.iter().enumerate().filter(|(j, o)| *j != i && crate::geom::point_in_ring(probe, o)).count();
        if depth % 2 == 1 {
            continue;
        }
        let ring = simplify_closed(&chaikin_closed(r), tol);
        if ring.len() >= 3 {
            out.push(ring);
        }
    }
    out
}

// ---------------------------------------------------------------------------
// 1. Downscale (separable area-average box filter, premultiplied alpha)
// ---------------------------------------------------------------------------

fn box_taps(src: usize, dst: usize) -> Vec<Vec<(usize, f32)>> {
    let scale = src as f64 / dst as f64;
    (0..dst)
        .map(|d| {
            let a = d as f64 * scale;
            let b = ((d + 1) as f64 * scale).min(src as f64);
            let mut v = Vec::new();
            let mut i = a.floor() as usize;
            while i < src && (i as f64) < b {
                let lo = a.max(i as f64);
                let hi = b.min(i as f64 + 1.0);
                if hi > lo {
                    v.push((i, (hi - lo) as f32));
                }
                i += 1;
            }
            let sum: f32 = v.iter().map(|t| t.1).sum();
            if sum > 0.0 {
                for t in v.iter_mut() {
                    t.1 /= sum;
                }
            }
            v
        })
        .collect()
}

fn downscale(rgba: &[u8], w: usize, h: usize, max_px: usize) -> (Vec<[u8; 4]>, usize, usize) {
    let long = w.max(h);
    if long <= max_px {
        let px = rgba[..w * h * 4].chunks_exact(4).map(|c| [c[0], c[1], c[2], c[3]]).collect();
        return (px, w, h);
    }
    let f = max_px as f64 / long as f64;
    let nw = ((w as f64 * f).round() as usize).clamp(1, max_px);
    let nh = ((h as f64 * f).round() as usize).clamp(1, max_px);
    let tx = box_taps(w, nw);
    let ty = box_taps(h, nh);
    // horizontal pass: premultiplied rgb + alpha
    let mut tmp = vec![[0f32; 4]; nw * h];
    for y in 0..h {
        let row = &rgba[y * w * 4..(y + 1) * w * 4];
        for (x, taps) in tx.iter().enumerate() {
            let mut acc = [0f32; 4];
            for &(sx, wt) in taps {
                let p = &row[sx * 4..sx * 4 + 4];
                let a = p[3] as f32 * wt;
                acc[0] += p[0] as f32 * a;
                acc[1] += p[1] as f32 * a;
                acc[2] += p[2] as f32 * a;
                acc[3] += a;
            }
            tmp[y * nw + x] = acc;
        }
    }
    let mut out = Vec::with_capacity(nw * nh);
    for taps in &ty {
        for x in 0..nw {
            let mut acc = [0f32; 4];
            for &(sy, wt) in taps {
                let p = tmp[sy * nw + x];
                for k in 0..4 {
                    acc[k] += p[k] * wt;
                }
            }
            let a = acc[3];
            if a <= 1e-6 {
                out.push([0, 0, 0, 0]);
            } else {
                let c = |v: f32| (v / a).round().clamp(0.0, 255.0) as u8;
                out.push([c(acc[0]), c(acc[1]), c(acc[2]), a.round().clamp(0.0, 255.0) as u8]);
            }
        }
    }
    (out, nw, nh)
}

// ---------------------------------------------------------------------------
// 2. Colour quantisation
// ---------------------------------------------------------------------------

const SEED: u64 = 0x2545_F491_4F6C_DD1D;

/// xorshift64 — tiny, fast, and identical on every platform.
struct Rng(u64);

impl Rng {
    fn next_u64(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        x
    }
    fn unit(&mut self) -> f64 {
        (self.next_u64() >> 11) as f64 * (1.0 / (1u64 << 53) as f64)
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next_u64() % n.max(1) as u64) as usize
    }
}

/// sRGB → linear lookup table (same formula as [`crate::threads::rgb_to_lab`]).
fn srgb_lut() -> Vec<f64> {
    (0..256)
        .map(|v| {
            let c = v as f64 / 255.0;
            if c <= 0.04045 {
                c / 12.92
            } else {
                ((c + 0.055) / 1.055).powf(2.4)
            }
        })
        .collect()
}

/// Fast [`rgb_to_lab`] using the lookup table.
fn lab_of(lut: &[f64], c: [u8; 3]) -> [f32; 3] {
    let (r, g, b) = (lut[c[0] as usize], lut[c[1] as usize], lut[c[2] as usize]);
    let x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
    let y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    let z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
    let f = |t: f64| if t > 0.008856 { t.cbrt() } else { 7.787 * t + 16.0 / 116.0 };
    let (fx, fy, fz) = (f(x), f(y), f(z));
    [(116.0 * fy - 16.0) as f32, (500.0 * (fx - fy)) as f32, (200.0 * (fy - fz)) as f32]
}

#[inline]
fn d2(c: &[f64; 3], p: &[f32; 3]) -> f64 {
    let (a, b, e) = (c[0] - p[0] as f64, c[1] - p[1] as f64, c[2] - p[2] as f64);
    a * a + b * b + e * e
}

#[inline]
fn nearest(cents: &[[f64; 3]], p: &[f32; 3], alive: Option<&[bool]>) -> usize {
    let mut best = (0usize, f64::INFINITY);
    for (j, c) in cents.iter().enumerate() {
        if alive.is_some_and(|a| !a[j]) {
            continue;
        }
        let d = d2(c, p);
        if d < best.1 {
            best = (j, d);
        }
    }
    best.0
}

/// Greedy k-means++ seeding: each new centre is the best of a few
/// D²-sampled candidates (the one that lowers the potential most).
fn kmeans_pp(sample: &[[f32; 3]], k: usize, rng: &mut Rng) -> Vec<[f64; 3]> {
    let to64 = |p: &[f32; 3]| [p[0] as f64, p[1] as f64, p[2] as f64];
    let first = to64(&sample[rng.below(sample.len())]);
    let mut cents = vec![first];
    let mut dist: Vec<f64> = sample.iter().map(|p| d2(&first, p)).collect();
    let trials = 2 + (k as f64).ln().floor() as usize;
    let mut cand_dist = vec![0f64; sample.len()];
    let mut best_dist = vec![0f64; sample.len()];
    while cents.len() < k {
        let total: f64 = dist.iter().sum();
        if total <= 1e-6 {
            break; // fewer distinct colours than k
        }
        let mut best: Option<([f64; 3], f64)> = None;
        for _ in 0..trials {
            let mut r = rng.unit() * total;
            let mut pick = usize::MAX;
            for (i, &d) in dist.iter().enumerate() {
                r -= d;
                if r < 0.0 && d > 0.0 {
                    pick = i;
                    break;
                }
            }
            if pick == usize::MAX {
                match dist.iter().rposition(|&d| d > 0.0) {
                    Some(i) => pick = i,
                    None => break,
                }
            }
            let c = to64(&sample[pick]);
            let mut pot = 0.0;
            for (i, p) in sample.iter().enumerate() {
                cand_dist[i] = dist[i].min(d2(&c, p));
                pot += cand_dist[i];
            }
            if best.is_none_or(|b| pot < b.1) {
                best = Some((c, pot));
                std::mem::swap(&mut best_dist, &mut cand_dist);
            }
        }
        let Some((c, _)) = best else { break };
        std::mem::swap(&mut dist, &mut best_dist);
        cents.push(c);
    }
    cents
}

/// Lloyd iterations; returns the member count of every centre.
fn lloyd(sample: &[[f32; 3]], cents: &mut [[f64; 3]], iters: usize) -> Vec<usize> {
    let k = cents.len();
    let mut asg = vec![usize::MAX; sample.len()];
    let mut cnt = vec![0usize; k];
    for _ in 0..iters {
        let mut changed = false;
        let mut sums = vec![[0f64; 3]; k];
        cnt.iter_mut().for_each(|c| *c = 0);
        for (i, p) in sample.iter().enumerate() {
            let j = nearest(cents, p, None);
            if asg[i] != j {
                asg[i] = j;
                changed = true;
            }
            for c in 0..3 {
                sums[j][c] += p[c] as f64;
            }
            cnt[j] += 1;
        }
        for j in 0..k {
            if cnt[j] > 0 {
                for c in 0..3 {
                    cents[j][c] = sums[j][c] / cnt[j] as f64;
                }
            }
        }
        if !changed {
            break;
        }
    }
    cnt
}

/// Merge over-segmented clusters: first every pair closer than a just
/// noticeable thread difference, then (Ward linkage) down to `k`.
fn reduce_clusters(cents: Vec<[f64; 3]>, counts: Vec<usize>, k: usize) -> Vec<[f64; 3]> {
    const SAME_DE: f64 = 6.0;
    let mut cl: Vec<([f64; 3], f64)> =
        cents.into_iter().zip(counts).filter(|(_, n)| *n > 0).map(|(c, n)| (c, n as f64)).collect();
    loop {
        if cl.len() < 2 {
            break;
        }
        let mut closest = (0, 1, f64::INFINITY);
        let mut ward = (0, 1, f64::INFINITY);
        for i in 0..cl.len() {
            for j in i + 1..cl.len() {
                let (a, b) = (&cl[i], &cl[j]);
                let dd = (a.0[0] - b.0[0]).powi(2) + (a.0[1] - b.0[1]).powi(2) + (a.0[2] - b.0[2]).powi(2);
                if dd < closest.2 {
                    closest = (i, j, dd);
                }
                let wc = a.1 * b.1 / (a.1 + b.1) * dd;
                if wc < ward.2 {
                    ward = (i, j, wc);
                }
            }
        }
        let (i, j) = if closest.2 < SAME_DE * SAME_DE {
            (closest.0, closest.1)
        } else if cl.len() > k {
            (ward.0, ward.1)
        } else {
            break;
        };
        let (b, nb) = cl.remove(j);
        let (a, na) = cl[i];
        let n = na + nb;
        cl[i] = ([(a[0] * na + b[0] * nb) / n, (a[1] * na + b[1] * nb) / n, (a[2] * na + b[2] * nb) / n], n);
    }
    cl.into_iter().map(|(c, _)| c).collect()
}

struct Quant {
    /// Label per pixel; `colors.len()` = transparent.
    labels: Vec<u8>,
    colors: Vec<[u8; 3]>,
    palette_idx: Vec<Option<usize>>,
}

fn quantize(px: &[[u8; 4]], w: usize, h: usize, opts: &DigitizeOptions) -> Quant {
    let n = w * h;
    let lut = srgb_lut();
    let mut labs = vec![[0f32; 3]; n];
    let mut opaque = Vec::with_capacity(n);
    let mut last: Option<([u8; 3], [f32; 3])> = None;
    for (i, p) in px.iter().enumerate() {
        if p[3] >= 128 {
            let c = [p[0], p[1], p[2]];
            labs[i] = match last {
                Some((lc, ll)) if lc == c => ll,
                _ => {
                    let l = lab_of(&lut, c);
                    last = Some((c, l));
                    l
                }
            };
            opaque.push(i);
        }
    }
    if opaque.is_empty() {
        return Quant { labels: vec![0; n], colors: vec![], palette_idx: vec![] };
    }
    // user-locked palette: plain nearest-colour assignment, colours kept verbatim
    if !opts.fixed_colors.is_empty() {
        let fixed: Vec<[u8; 3]> = opts.fixed_colors.iter().copied().take(250).collect();
        let cents: Vec<[f64; 3]> = fixed.iter().map(|c| rgb_to_lab(*c)).collect();
        let t = fixed.len() as u8;
        let mut labels = vec![t; n];
        for &i in &opaque {
            labels[i] = nearest(&cents, &labs[i], None) as u8;
        }
        // colours stay verbatim, but one that is (practically) a chart entry
        // keeps that entry's name, code and brand
        const SAME_THREAD_DE: f64 = 2.0;
        let pal_lab: Vec<[f64; 3]> = opts.palette.iter().map(|e| rgb_to_lab(e.rgb)).collect();
        let palette_idx = fixed
            .iter()
            .zip(&cents)
            .map(|(rgb, lab)| {
                opts.palette.iter().position(|e| e.rgb == *rgb).or_else(|| {
                    pal_lab
                        .iter()
                        .map(|pl| vision::delta_e(*lab, *pl))
                        .enumerate()
                        .filter(|&(_, d)| d <= SAME_THREAD_DE)
                        .min_by(|a, b| a.1.total_cmp(&b.1))
                        .map(|(e, _)| e)
                })
            })
            .collect();
        return Quant { labels, colors: fixed, palette_idx };
    }
    let k = opts.colors.clamp(2, 24);
    let mut rng = Rng(SEED);
    const MAX_SAMPLE: usize = 12_000;
    let m = opaque.len();
    let sample: Vec<[f32; 3]> = if m <= MAX_SAMPLE {
        opaque.iter().map(|&i| labs[i]).collect()
    } else {
        let step = m as f64 / MAX_SAMPLE as f64;
        (0..MAX_SAMPLE)
            .map(|j| {
                let o = ((j as f64 + rng.unit()) * step) as usize;
                labs[opaque[o.min(m - 1)]]
            })
            .collect()
    };
    // over-segment (2k), then merge near-duplicates and Ward-merge down to k
    let mut cents = kmeans_pp(&sample, (2 * k).min(32), &mut rng);
    let counts = lloyd(&sample, &mut cents, 30);
    let mut cents = reduce_clusters(cents, counts, k);
    lloyd(&sample, &mut cents, 15);
    let kc = cents.len();

    const NONE: u8 = u8::MAX;
    let mut raw = vec![NONE; n];
    let mut count = vec![0usize; kc];
    for &i in &opaque {
        let c = nearest(&cents, &labs[i], None);
        raw[i] = c as u8;
        count[c] += 1;
    }

    // Anti-alias fringe suppression: a cluster that consists almost only of
    // boundary pixels, touches two other clusters and whose colour lies
    // between theirs is the blend at their edges — fold its pixels into the
    // nearer side.
    let mut alive: Vec<bool> = count.iter().map(|&c| c > 0).collect();
    if kc > 2 {
        let mut border = vec![0usize; kc];
        let mut adj = vec![0usize; kc * kc]; // adj[c * kc + o]: 4-neighbour contacts c → o
        for &i in &opaque {
            let (x, y) = (i % w, i / w);
            let c = raw[i] as usize;
            let mut is_border = false;
            let mut touch = |q: usize| {
                let o = raw[q];
                if o != c as u8 {
                    is_border = true;
                    if o != NONE {
                        adj[c * kc + o as usize] += 1;
                    }
                }
            };
            if x > 0 {
                touch(i - 1);
            }
            if x + 1 < w {
                touch(i + 1);
            }
            if y > 0 {
                touch(i - w);
            }
            if y + 1 < h {
                touch(i + w);
            }
            if is_border {
                border[c] += 1;
            }
        }
        let mut order: Vec<usize> = (0..kc).filter(|&c| count[c] > 0).collect();
        order.sort_by_key(|&c| (count[c], c));
        let mut any = false;
        for &c in &order {
            if (border[c] as f64) < 0.6 * count[c] as f64 {
                continue;
            }
            let contacts: usize = adj[c * kc..(c + 1) * kc].iter().sum();
            let touches = |o: usize| adj[c * kc + o] as f64 >= 0.1 * contacts as f64;
            let others: Vec<usize> = (0..kc).filter(|&o| o != c && alive[o] && touches(o)).collect();
            'pairs: for (ai, &a) in others.iter().enumerate() {
                for &b in &others[ai + 1..] {
                    if lies_between(&cents[c], &cents[a], &cents[b]) {
                        alive[c] = false;
                        any = true;
                        break 'pairs;
                    }
                }
            }
        }
        if any {
            count.iter_mut().for_each(|c| *c = 0);
            for &i in &opaque {
                let mut c = raw[i] as usize;
                if !alive[c] {
                    c = nearest(&cents, &labs[i], Some(&alive));
                    raw[i] = c as u8;
                }
                count[c] += 1;
            }
        }
    }

    // final colours: mean Lab of all member pixels
    let mut sums = vec![[0f64; 3]; kc];
    for &i in &opaque {
        let c = raw[i] as usize;
        for j in 0..3 {
            sums[c][j] += labs[i][j] as f64;
        }
    }
    let mut final_of = vec![0u8; kc];
    let mut colors: Vec<[u8; 3]> = Vec::new();
    let mut palette_idx: Vec<Option<usize>> = Vec::new();
    let pal_lab: Vec<[f64; 3]> = opts.palette.iter().map(|e| rgb_to_lab(e.rgb)).collect();
    for c in 0..kc {
        if !alive[c] || count[c] == 0 {
            continue;
        }
        let mean = [sums[c][0] / count[c] as f64, sums[c][1] / count[c] as f64, sums[c][2] / count[c] as f64];
        if pal_lab.is_empty() {
            final_of[c] = colors.len() as u8;
            colors.push(lab_to_rgb(mean));
            palette_idx.push(None);
        } else {
            let mut best = (0usize, f64::INFINITY);
            for (e, pl) in pal_lab.iter().enumerate() {
                let d = (pl[0] - mean[0]).powi(2) + (pl[1] - mean[1]).powi(2) + (pl[2] - mean[2]).powi(2);
                if d < best.1 {
                    best = (e, d);
                }
            }
            match palette_idx.iter().position(|p| *p == Some(best.0)) {
                Some(pos) => final_of[c] = pos as u8,
                None => {
                    final_of[c] = colors.len() as u8;
                    colors.push(opts.palette[best.0].rgb);
                    palette_idx.push(Some(best.0));
                }
            }
        }
    }
    let t = colors.len() as u8;
    let labels = raw.iter().map(|&r| if r == NONE { t } else { final_of[r as usize] }).collect();
    Quant { labels, colors, palette_idx }
}

/// Is colour `c` (approximately) a blend of `a` and `b`?
fn lies_between(c: &[f64; 3], a: &[f64; 3], b: &[f64; 3]) -> bool {
    let ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    let ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    let l2 = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2];
    if l2 < 1e-9 {
        return false;
    }
    let t = (ab[0] * ac[0] + ab[1] * ac[1] + ab[2] * ac[2]) / l2;
    if !(0.08..=0.92).contains(&t) {
        return false;
    }
    let d = ((ac[0] - ab[0] * t).powi(2) + (ac[1] - ab[1] * t).powi(2) + (ac[2] - ab[2] * t).powi(2)).sqrt();
    // sRGB blends curve in Lab, so the tolerance grows with the span
    d < 8.0f64.max(0.25 * l2.sqrt())
}

// ---------------------------------------------------------------------------
// 3. Line-preserving mode filter
// ---------------------------------------------------------------------------

/// One pass of a 3×3 mode filter. Pixels that bridge two separate groups of
/// their own label (1px lines, diagonal steps) are kept so hairlines survive.
fn mode_filter(labels: &mut [u8], w: usize, h: usize, nlab: usize) {
    let src = labels.to_vec();
    // ring order: N, NE, E, SE, S, SW, W, NW
    const RING: [(isize, isize); 8] = [(0, -1), (1, -1), (1, 0), (1, 1), (0, 1), (-1, 1), (-1, 0), (-1, -1)];
    let mut cnt = vec![0u8; nlab];
    for y in 0..h {
        for x in 0..w {
            let i = y * w + x;
            let c = src[i];
            let mut same = [false; 8];
            let mut nsame = 0;
            for (k, (dx, dy)) in RING.iter().enumerate() {
                let (nx, ny) = (x as isize + dx, y as isize + dy);
                if nx >= 0 && ny >= 0 && (nx as usize) < w && (ny as usize) < h && src[ny as usize * w + nx as usize] == c {
                    same[k] = true;
                    nsame += 1;
                }
            }
            if nsame >= 7 {
                continue; // interior
            }
            let runs = (0..8).filter(|&k| same[k] && !same[(k + 7) % 8]).count();
            if runs >= 2 {
                continue; // local bridge: part of a thin line
            }
            cnt.iter_mut().for_each(|v| *v = 0);
            for (dx, dy) in RING {
                let (nx, ny) = (x as isize + dx, y as isize + dy);
                if nx >= 0 && ny >= 0 && (nx as usize) < w && (ny as usize) < h {
                    cnt[src[ny as usize * w + nx as usize] as usize] += 1;
                }
            }
            cnt[c as usize] += 1;
            let mut best = c as usize;
            for l in 0..nlab {
                if cnt[l] > cnt[best] {
                    best = l;
                }
            }
            labels[i] = best as u8;
        }
    }
}

// ---------------------------------------------------------------------------
// 5. Connected components (8-connectivity) and speck removal
// ---------------------------------------------------------------------------

struct Comp {
    label: u8,
    start: usize,
    len: usize,
    x0: usize,
    y0: usize,
    x1: usize,
    y1: usize,
}

struct Components {
    /// Pixel indices grouped by component (`comps[i].start..+len`).
    order: Vec<u32>,
    comps: Vec<Comp>,
}

fn components(labels: &[u8], w: usize, h: usize) -> Components {
    components_zoned(labels, &[], w, h)
}

/// Components that also never cross a zone border (separate masks).
fn components_zoned(labels: &[u8], zone: &[u8], w: usize, h: usize) -> Components {
    let zone_of = |i: usize| zone.get(i).copied().unwrap_or(0);
    let n = w * h;
    let mut seen = vec![false; n];
    let mut order: Vec<u32> = Vec::with_capacity(n);
    let mut comps = Vec::new();
    for s in 0..n {
        if seen[s] {
            continue;
        }
        let l = labels[s];
        let start = order.len();
        seen[s] = true;
        order.push(s as u32);
        let (mut x0, mut y0, mut x1, mut y1) = (usize::MAX, usize::MAX, 0, 0);
        let mut head = start;
        while head < order.len() {
            let p = order[head] as usize;
            head += 1;
            let (x, y) = (p % w, p / w);
            x0 = x0.min(x);
            y0 = y0.min(y);
            x1 = x1.max(x);
            y1 = y1.max(y);
            let (xa, xb) = (x.saturating_sub(1), (x + 1).min(w - 1));
            let (ya, yb) = (y.saturating_sub(1), (y + 1).min(h - 1));
            for ny in ya..=yb {
                for nx in xa..=xb {
                    let q = ny * w + nx;
                    if !seen[q] && labels[q] == l && zone_of(q) == zone_of(s) {
                        seen[q] = true;
                        order.push(q as u32);
                    }
                }
            }
        }
        comps.push(Comp { label: l, start, len: order.len() - start, x0, y0, x1, y1 });
    }
    Components { order, comps }
}

/// Relabel components smaller than `min_px` to their most common 4-neighbour label.
fn merge_specks(labels: &mut [u8], w: usize, h: usize, min_px: usize) {
    let mut cnt = [0u32; 256];
    for _ in 0..4 {
        let cc = components(labels, w, h);
        let mut small: Vec<usize> = (0..cc.comps.len()).filter(|&c| cc.comps[c].len < min_px).collect();
        if small.is_empty() {
            return;
        }
        small.sort_by_key(|&c| (cc.comps[c].len, c));
        let mut changed = false;
        for c in small {
            let comp = &cc.comps[c];
            let pix = &cc.order[comp.start..comp.start + comp.len];
            let own = labels[pix[0] as usize];
            cnt.iter_mut().for_each(|v| *v = 0);
            for &p in pix {
                let p = p as usize;
                let (x, y) = (p % w, p / w);
                let mut look = |q: usize| {
                    let l = labels[q];
                    if l != own {
                        cnt[l as usize] += 1;
                    }
                };
                if x > 0 {
                    look(p - 1);
                }
                if x + 1 < w {
                    look(p + 1);
                }
                if y > 0 {
                    look(p - w);
                }
                if y + 1 < h {
                    look(p + w);
                }
            }
            let mut best: Option<usize> = None;
            for l in 0..256 {
                if cnt[l] > 0 && best.is_none_or(|b| cnt[l] > cnt[b]) {
                    best = Some(l);
                }
            }
            if let Some(b) = best {
                for &p in pix {
                    labels[p as usize] = b as u8;
                }
                changed = true;
            }
        }
        if !changed {
            return;
        }
    }
}

// ---------------------------------------------------------------------------
// 6./7. Per-region vectorisation and stitch type selection
// ---------------------------------------------------------------------------

struct Ctx<'a> {
    /// mm per pixel
    s: f64,
    /// simplification tolerance (mm)
    tol: f64,
    opts: &'a DigitizeOptions,
    /// Colours the user marked as fills (never lines).
    fill_only: Vec<bool>,
}

struct Region {
    label: usize,
    /// 0 = fill, 1 = satin / running
    rank: u8,
    centroid: Point,
    area: usize,
    paths: Vec<SubPath>,
    stitch: StitchParams,
}

fn r3(v: f64) -> f64 {
    (v * 1000.0).round() / 1000.0
}

fn round_pts(pts: &[Point]) -> Vec<Point> {
    pts.iter().map(|p| pt(r3(p.x), r3(p.y))).collect()
}

fn chaikin_closed(ring: &[Point]) -> Ring {
    let n = ring.len();
    if n < 3 {
        return ring.to_vec();
    }
    let mut out = Vec::with_capacity(n * 2);
    for i in 0..n {
        let (a, b) = (ring[i], ring[(i + 1) % n]);
        out.push(a.lerp(b, 0.25));
        out.push(a.lerp(b, 0.75));
    }
    out
}

fn simplify_closed(ring: &[Point], tol: f64) -> Ring {
    if ring.len() < 4 {
        return ring.to_vec();
    }
    let mut closed = ring.to_vec();
    closed.push(ring[0]);
    let mut s = simplify(&closed, tol);
    s.pop();
    s
}

/// Moving average with the window shrinking at the ends (endpoints fixed).
fn smooth_open(pts: &[Point], radius: usize) -> Vec<Point> {
    let n = pts.len();
    (0..n)
        .map(|i| {
            let r = radius.min(i).min(n - 1 - i);
            let mut acc = Point::ZERO;
            for p in &pts[i - r..=i + r] {
                acc += *p;
            }
            acc / (2 * r + 1) as f64
        })
        .collect()
}

fn process_region(ctx: &Ctx, c: &Comp, pix: &[u32], w: usize) -> Option<Region> {
    let s = ctx.s;
    let opts = ctx.opts;
    let cw = c.x1 - c.x0 + 3;
    let ch = c.y1 - c.y0 + 3;
    let mut mask = vec![false; cw * ch];
    let (mut sx, mut sy) = (0f64, 0f64);
    for &p in pix {
        let (x, y) = (p as usize % w, p as usize / w);
        mask[(y - c.y0 + 1) * cw + (x - c.x0 + 1)] = true;
        sx += x as f64;
        sy += y as f64;
    }
    let area = pix.len();
    let (mx, my) = (sx / area as f64, sy / area as f64);
    let centroid = pt((mx + 0.5) * s, (my + 0.5) * s);
    // crop origin (cell-corner coordinates in image pixels)
    let (ox, oy) = (c.x0 as f64 - 1.0, c.y0 as f64 - 1.0);
    let to_mm = |p: Point| pt((ox + p.x) * s, (oy + p.y) * s);
    let cell_pt = |i: usize| pt((i % cw) as f64 + 0.5, (i / cw) as f64 + 0.5);

    let dt = edt_sq(&mask, cw, ch);
    let dmax = dt.iter().fold(0f64, |a, &b| a.max(b)).sqrt();
    // pixel-centre EDT under-reports even widths by 1px and over-reports odd
    // ones by 0; split the difference.
    let width_mm = (2.0 * dmax - 0.5).max(0.5) * s;
    let label = c.label as usize;

    // --- running stitch for hairlines
    let as_fill = ctx.fill_only.get(label).copied().unwrap_or(false);
    if opts.allow_running && width_mm < opts.running_max_width_mm && !as_fill {
        let skel = zhang_suen(&mask, cw, ch);
        let mut paths = Vec::new();
        for cells in skeleton_paths(&skel, cw, 3, 32) {
            let pts: Vec<Point> = cells.iter().map(|&i| to_mm(cell_pt(i))).collect();
            let pts = simplify(&smooth_open(&pts, 1), ctx.tol);
            // shorter ones are slivers (anti-aliased rims), not lines
            if pts.len() >= 2 && polyline_length(&pts) > (s * 1.5).max(opts.line_min_mm.min(1.5)) {
                paths.push(SubPath::polyline(&round_pts(&pts), false));
            }
        }
        if paths.is_empty() {
            // fallback: outline of the region, single pass
            let ring = trace_contours(&mask, cw, ch)
                .into_iter()
                .max_by(|a, b| signed_area(a).abs().partial_cmp(&signed_area(b).abs()).unwrap())?;
            let mm: Vec<Point> = ring.iter().map(|p| to_mm(*p)).collect();
            let r = simplify_closed(&chaikin_closed(&mm), ctx.tol);
            // a crumb (a few anti-aliased pixels) rather than a hairline
            if r.len() < 3 || polyline_length(&r) < opts.line_min_mm.min(2.0) {
                return None;
            }
            paths.push(SubPath::polyline(&round_pts(&r), true));
        }
        return Some(Region {
            label,
            rank: 1,
            centroid,
            area,
            paths,
            stitch: StitchParams::Running(RunningParams { length: 2.0, ..Default::default() }),
        });
    }

    // --- medial-axis satin for narrow elongated strokes
    if opts.allow_satin && width_mm <= opts.satin_max_width_mm && !as_fill {
        // a fill needs room for its rows: a mark narrower than 2 mm (a dash, a
        // brush tick) sews cleaner as a short column even when it is stubby
        let min_elongation = if width_mm < 2.0 { 1.0 } else { 3.0 };
        if let Some((centre, sw)) = satin_centre_line(&mask, &dt, cw, ch, area, dmax, min_elongation) {
            // rails that follow the shape's width (an ellipse, a leaf, a swoosh taper),
            // like the lines' strokes; the centre line already reaches the shape's ends
            let width_at = |p: &Point| {
                let (x, y) = ((p.x.floor().max(0.0) as usize).min(cw - 1), (p.y.floor().max(0.0) as usize).min(ch - 1));
                2.0 * dt[y * cw + x].sqrt()
            };
            let st = strokes::Stroke {
                pts: centre.iter().map(|p| pt(ox + p.x, oy + p.y)).collect(),
                widths: centre.iter().map(|p| width_at(p).max(1.0)).collect(),
                closed: false,
                free: [false, false],
            };
            if let Some((paths, stitch @ StitchParams::Satin(_))) = stroke_object(&st, false, s, ctx, None) {
                return Some(Region { label, rank: 1, centroid, area, paths, stitch });
            }
            let pts: Vec<Point> = centre.iter().map(|p| to_mm(*p)).collect();
            let pts = simplify(&pts, ctx.tol);
            if pts.len() >= 2 {
                let width = r3((sw * s).clamp(0.8, opts.satin_max_width_mm.max(0.8)));
                return Some(Region {
                    label,
                    rank: 1,
                    centroid,
                    area,
                    paths: vec![SubPath::polyline(&round_pts(&pts), false)],
                    stitch: StitchParams::Satin(SatinParams {
                        width,
                        center_walk: true,
                        contour_underlay: width > 2.5,
                        ..Default::default()
                    }),
                });
            }
        }
    }

    // --- tatami fill
    let min_area = 0.5 * s * s;
    let mut rings: Vec<Ring> = trace_contours(&mask, cw, ch)
        .iter()
        .map(|r| {
            let mm: Vec<Point> = r.iter().map(|p| to_mm(*p)).collect();
            simplify_closed(&chaikin_closed(&mm), ctx.tol)
        })
        .filter(|r| r.len() >= 3 && signed_area(r).abs() > min_area)
        .collect();
    if rings.is_empty() {
        return None;
    }
    if opts.overlap_mm > 1e-6 {
        let res = (s * 0.5).clamp(0.03, 0.2);
        let out: Vec<Ring> = offset_rings(&rings, opts.overlap_mm, res)
            .iter()
            .map(|r| simplify_closed(r, ctx.tol * 0.5))
            .filter(|r| r.len() >= 3 && signed_area(r).abs() > min_area)
            .collect();
        if !out.is_empty() {
            rings = out;
        }
    }
    // principal axis (PCA of pixel coordinates, y down)
    let (mut sxx, mut syy, mut sxy) = (0f64, 0f64, 0f64);
    for &p in pix {
        let dx = (p as usize % w) as f64 - mx;
        let dy = (p as usize / w) as f64 - my;
        sxx += dx * dx;
        syy += dy * dy;
        sxy += dx * dy;
    }
    let theta = 0.5 * (2.0 * sxy).atan2(sxx - syy); // direction (cos θ, sin θ) on screen
    // FillParams: rows run along (cos(-a), sin(-a)) in y-down coordinates → a = -θ
    let mut angle = ((-theta).to_degrees().rem_euclid(180.0) * 10.0).round() / 10.0;
    if angle >= 180.0 {
        angle -= 180.0;
    }
    angle += 0.0; // normalise -0.0
    if let Some(a) = opts.fill_angle {
        angle = a;
    }
    Some(Region {
        label,
        rank: 0,
        centroid,
        area,
        paths: rings.iter().map(|r| SubPath::polyline(&round_pts(r), true)).collect(),
        stitch: StitchParams::Fill(FillParams {
            method: opts.fill_method,
            angle,
            row_spacing: opts.row_spacing.max(0.1),
            underlay: opts.underlay,
            ..Default::default()
        }),
    })
}

/// The picture's flow over one region as a direction field (design mm),
/// leaning to `base` (radians, y down) where the flow is unclear.
fn region_flow_field(c: &Comp, field_src: &Img, s: f64, base: f64, opts: &DigitizeOptions) -> FlowField {
    let span = (c.x1 - c.x0 + 1).max(c.y1 - c.y0 + 1) as f64;
    let cell = (span / opts.flow_detail.clamp(4.0, 160.0)).max(2.0);
    let cols = (((c.x1 - c.x0 + 1) as f64) / cell).ceil().max(1.0) as u32;
    let rows = (((c.y1 - c.y0 + 1) as f64) / cell).ceil().max(1.0) as u32;
    let k = opts.flow_strength.clamp(0.0, 1.0) as f32;
    let mut angles = Vec::with_capacity((cols * rows) as usize);
    for gy in 0..rows {
        for gx in 0..cols {
            let x = c.x0 as f64 + (gx as f64 + 0.5) * cell;
            let y = c.y0 as f64 + (gy as f64 + 0.5) * cell;
            let (a, clarity) = filters::flow_at(field_src, x, y, (cell / 2.0).ceil() as i64);
            // no clear flow here (flat colour, noise): lean to the base direction
            let sure = ((clarity - 0.08) / 0.27).clamp(0.0, 1.0);
            angles.push(blend_angle(a, base as f32, k * sure));
        }
    }
    FlowField { origin: [r3(c.x0 as f64 * s), r3(c.y0 as f64 * s)], cell: cell * s, cols, rows, angles }
}

/// Blend two row directions (radians, defined modulo π): `k` = 1 gives
/// `flow`, 0 gives `base` (doubled-angle vectors, so 0° and 180° agree).
fn blend_angle(flow: f32, base: f32, k: f32) -> f32 {
    if k >= 0.999 {
        return flow;
    }
    let (c, s) = (k * (2.0 * flow).cos() + (1.0 - k) * (2.0 * base).cos(), k * (2.0 * flow).sin() + (1.0 - k) * (2.0 * base).sin());
    if c * c + s * s < 1e-9 {
        return base;
    }
    0.5 * s.atan2(c)
}

/// Centre line (crop coordinates) and width (pixels) of a satin-able region,
/// or `None` when the region is not a narrow, elongated, unbranched stroke.
fn satin_centre_line(
    mask: &[bool],
    dt: &[f64],
    cw: usize,
    ch: usize,
    area: usize,
    dmax: f64,
    min_elongation: f64,
) -> Option<(Vec<Point>, f64)> {
    let skel = zhang_suen(mask, cw, ch);
    let n_skel = skel.iter().filter(|v| **v).count();
    if n_skel < 3 {
        return None;
    }
    let start = skel.iter().position(|v| *v)?;
    let mut dist = vec![u32::MAX; cw * ch];
    let mut parent = vec![0u32; cw * ch];
    let mut touched = Vec::new();
    let path = longest_path(&skel, cw, start, &mut dist, &mut parent, &mut touched);
    let n = path.len();
    if n < 3 {
        return None;
    }
    // branchiness: skeleton pixels farther than a spur length from the path
    bfs_far(&skel, cw, &path, &mut dist, &mut parent, &mut touched);
    let spur = dmax.ceil().max(2.0) as u32;
    let near = touched.iter().filter(|&&i| dist[i] <= spur).count();
    let far = n_skel - near;
    // (a K or a Y is several columns: one satin along its longest path would lose the rest)
    if (n as f64) < 0.9 * (n + far) as f64 {
        return None;
    }
    // elongation: skeleton length ≥ `min_elongation` × mean width (area / length)
    let pts: Vec<Point> = path.iter().map(|&i| pt((i % cw) as f64 + 0.5, (i / cw) as f64 + 0.5)).collect();
    let len = polyline_length(&pts);
    let mean_w = area as f64 / len.max(1.0);
    if len < min_elongation * mean_w {
        return None;
    }
    // width: median inscribed diameter along the central part of the path
    let (lo, hi) = if n >= 10 { (n / 5, n - n / 5) } else { (0, n) };
    let mut radii: Vec<f64> = path[lo..hi].iter().map(|&i| dt[i].sqrt() - 0.25).collect();
    radii.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let r_med = radii[radii.len() / 2].max(0.5);
    // centre line: trim the wiggly corner spurs, smooth, re-extend to the ends
    let trim = (r_med.round() as usize).min(n / 4);
    let core = &pts[trim..n - trim];
    let mut line = smooth_open(core, 3);
    extend_ends(&mut line, mask, cw, ch, r_med);
    Some((line, 2.0 * r_med))
}

/// Extend both ends of a centre line along its end tangent until it leaves the mask.
fn extend_ends(line: &mut Vec<Point>, mask: &[bool], cw: usize, ch: usize, r: f64) {
    let inside = |q: Point| {
        if q.x < 0.0 || q.y < 0.0 {
            return false;
        }
        let (i, j) = (q.x as usize, q.y as usize);
        i < cw && j < ch && mask[j * cw + i]
    };
    let max_ext = 3.0 * r + 3.0;
    for end in 0..2 {
        let n = line.len();
        if n < 2 {
            return;
        }
        let back = (r.round() as usize).max(2).min(n - 1);
        let (e, prev) = if end == 0 { (line[0], line[back]) } else { (line[n - 1], line[n - 1 - back]) };
        let dir = (e - prev).unit();
        if dir.length_sq() < 0.5 {
            continue;
        }
        let mut t = 0.5;
        let mut last = 0.0;
        while t <= max_ext && inside(e + dir * t) {
            last = t;
            t += 0.5;
        }
        if last > 0.0 {
            let q = e + dir * last;
            if end == 0 {
                line.insert(0, q);
            } else {
                line.push(q);
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Raster helpers: EDT, Zhang–Suen thinning, skeleton graph search
// ---------------------------------------------------------------------------

/// 1-D squared distance transform (Felzenszwalb & Huttenlocher).
fn edt_1d(f: &[f64], d: &mut [f64], v: &mut [usize], z: &mut [f64]) {
    let n = f.len();
    if n == 0 {
        return;
    }
    let mut k = 0usize;
    v[0] = 0;
    z[0] = f64::NEG_INFINITY;
    z[1] = f64::INFINITY;
    for q in 1..n {
        let qf = q as f64;
        let mut s;
        loop {
            let pf = v[k] as f64;
            s = ((f[q] + qf * qf) - (f[v[k]] + pf * pf)) / (2.0 * (qf - pf));
            if s <= z[k] && k > 0 {
                k -= 1;
            } else {
                break;
            }
        }
        k += 1;
        v[k] = q;
        z[k] = s;
        z[k + 1] = f64::INFINITY;
    }
    k = 0;
    for q in 0..n {
        let qf = q as f64;
        while z[k + 1] < qf {
            k += 1;
        }
        let dq = qf - v[k] as f64;
        d[q] = dq * dq + f[v[k]];
    }
}

/// Squared distance (pixels) from every cell to the nearest cell outside the mask.
pub(crate) fn edt_sq(mask: &[bool], w: usize, h: usize) -> Vec<f64> {
    let mut g: Vec<f64> = mask.iter().map(|&m| if m { 1e20 } else { 0.0 }).collect();
    let n = w.max(h);
    let (mut f, mut d, mut v, mut z) = (vec![0f64; n], vec![0f64; n], vec![0usize; n], vec![0f64; n + 1]);
    for x in 0..w {
        for y in 0..h {
            f[y] = g[y * w + x];
        }
        edt_1d(&f[..h], &mut d[..h], &mut v, &mut z);
        for y in 0..h {
            g[y * w + x] = d[y];
        }
    }
    for y in 0..h {
        f[..w].copy_from_slice(&g[y * w..y * w + w]);
        edt_1d(&f[..w], &mut d[..w], &mut v, &mut z);
        g[y * w..y * w + w].copy_from_slice(&d[..w]);
    }
    g
}

/// Zhang–Suen thinning. The mask must have a false 1-cell border.
pub(crate) fn zhang_suen(mask: &[bool], w: usize, h: usize) -> Vec<bool> {
    let mut img = mask.to_vec();
    let mut fg: Vec<usize> = (0..w * h)
        .filter(|&i| img[i] && i % w > 0 && i % w + 1 < w && i / w > 0 && i / w + 1 < h)
        .collect();
    let mut del = Vec::new();
    loop {
        let mut changed = false;
        for step in 0..2 {
            del.clear();
            for &i in &fg {
                let p2 = img[i - w];
                let p3 = img[i - w + 1];
                let p4 = img[i + 1];
                let p5 = img[i + w + 1];
                let p6 = img[i + w];
                let p7 = img[i + w - 1];
                let p8 = img[i - 1];
                let p9 = img[i - w - 1];
                let nb = [p2, p3, p4, p5, p6, p7, p8, p9];
                let b = nb.iter().filter(|v| **v).count();
                if !(2..=6).contains(&b) {
                    continue;
                }
                let a = (0..8).filter(|&k| !nb[k] && nb[(k + 1) % 8]).count();
                if a != 1 {
                    continue;
                }
                let keep = if step == 0 { (p2 && p4 && p6) || (p4 && p6 && p8) } else { (p2 && p4 && p8) || (p2 && p6 && p8) };
                if !keep {
                    del.push(i);
                }
            }
            if !del.is_empty() {
                changed = true;
                for &i in &del {
                    img[i] = false;
                }
                fg.retain(|&i| img[i]);
            }
        }
        if !changed {
            break;
        }
    }
    img
}

/// Multi-source BFS over 8-connected skeleton cells. `touched` receives the
/// visited cells in BFS order; returns the farthest cell.
fn bfs_far(skel: &[bool], w: usize, sources: &[usize], dist: &mut [u32], parent: &mut [u32], touched: &mut Vec<usize>) -> usize {
    for &i in touched.iter() {
        dist[i] = u32::MAX;
    }
    touched.clear();
    for &s in sources {
        if dist[s] == u32::MAX {
            dist[s] = 0;
            parent[s] = s as u32;
            touched.push(s);
        }
    }
    let wi = w as isize;
    let offs = [-wi - 1, -wi, -wi + 1, -1, 1, wi - 1, wi, wi + 1];
    let mut far = sources[0];
    let mut head = 0;
    while head < touched.len() {
        let p = touched[head];
        head += 1;
        if dist[p] > dist[far] {
            far = p;
        }
        for o in offs {
            let q = (p as isize + o) as usize;
            if skel[q] && dist[q] == u32::MAX {
                dist[q] = dist[p] + 1;
                parent[q] = p as u32;
                touched.push(q);
            }
        }
    }
    far
}

/// Longest path in the skeleton component containing `start` (double BFS sweep).
fn longest_path(skel: &[bool], w: usize, start: usize, dist: &mut [u32], parent: &mut [u32], touched: &mut Vec<usize>) -> Vec<usize> {
    let a = bfs_far(skel, w, &[start], dist, parent, touched);
    let b = bfs_far(skel, w, &[a], dist, parent, touched);
    let mut path = vec![b];
    let mut c = b;
    while c != a {
        c = parent[c] as usize;
        path.push(c);
    }
    path
}

/// Greedy decomposition of a skeleton into long paths (for running stitch).
fn skeleton_paths(skel: &[bool], w: usize, min_cells: usize, max_paths: usize) -> Vec<Vec<usize>> {
    let mut rem = skel.to_vec();
    let n = rem.len();
    let mut dist = vec![u32::MAX; n];
    let mut parent = vec![0u32; n];
    let mut touched = Vec::new();
    let mut out = Vec::new();
    let mut cursor = 0;
    while out.len() < max_paths {
        while cursor < n && !rem[cursor] {
            cursor += 1;
        }
        if cursor >= n {
            break;
        }
        let path = longest_path(&rem, w, cursor, &mut dist, &mut parent, &mut touched);
        if path.len() >= min_cells {
            for &c in &path {
                rem[c] = false;
            }
            out.push(path);
        } else {
            for &c in &touched {
                rem[c] = false;
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A JPEG as a phone writes it: pixels stored sideways plus an EXIF
    /// orientation tag (6 = rotate 90° clockwise to view).
    #[test]
    fn decode_applies_exif_orientation() {
        // 8×4 stored: left half red, right half blue
        let (w, h) = (8u32, 4u32);
        let mut raw = Vec::new();
        for _ in 0..h {
            for x in 0..w {
                raw.extend_from_slice(if x < w / 2 { &[255, 0, 0] } else { &[0, 0, 255] });
            }
        }
        let mut jpeg = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, 100)
            .encode(&raw, w, h, image::ExtendedColorType::Rgb8)
            .unwrap();
        // APP1 "Exif": big-endian TIFF header, one IFD entry 0x0112 SHORT = 6
        let mut tiff = vec![b'M', b'M', 0, 42, 0, 0, 0, 8, 0, 1];
        tiff.extend_from_slice(&[0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0]);
        tiff.extend_from_slice(&[0, 0, 0, 0]);
        let mut app1 = vec![0xFF, 0xE1];
        let len = (2 + 6 + tiff.len()) as u16;
        app1.extend_from_slice(&len.to_be_bytes());
        app1.extend_from_slice(b"Exif\0\0");
        app1.extend_from_slice(&tiff);
        assert_eq!(&jpeg[..2], &[0xFF, 0xD8]);
        let mut tagged = jpeg[..2].to_vec();
        tagged.extend_from_slice(&app1);
        tagged.extend_from_slice(&jpeg[2..]);

        let (px, tw, th) = decode_image(&tagged).unwrap();
        assert_eq!((tw, th), (h, w), "upright: 4 wide, 8 tall");
        let at = |x: u32, y: u32| {
            let i = ((y * tw + x) * 4) as usize;
            [px[i], px[i + 1], px[i + 2]]
        };
        // rotated clockwise, the stored left (red) half is now on top
        assert!(at(2, 1)[0] > 200 && at(2, 1)[2] < 60, "{:?}", at(2, 1));
        assert!(at(2, 6)[2] > 200 && at(2, 6)[0] < 60, "{:?}", at(2, 6));
        // without the tag nothing turns
        let (_, uw, uh) = decode_image(&jpeg).unwrap();
        assert_eq!((uw, uh), (w, h));
    }

    #[test]
    fn sliding_extremes_match_a_direct_scan() {
        let mut v = 0x9e37_79b9u32;
        for n in [1usize, 2, 5, 17, 64, 101] {
            let x: Vec<f32> = (0..n)
                .map(|_| {
                    v ^= v << 13;
                    v ^= v >> 17;
                    v ^= v << 5;
                    (v % 1000) as f32 / 10.0
                })
                .collect();
            for r in [0usize, 1, 3, 8, 40] {
                for take_max in [true, false] {
                    let direct: Vec<f32> = (0..n)
                        .map(|i| {
                            let w = &x[i.saturating_sub(r)..=(i + r).min(n - 1)];
                            w.iter().copied().fold(if take_max { f32::MIN } else { f32::MAX }, |a, b| if take_max { a.max(b) } else { a.min(b) })
                        })
                        .collect();
                    assert_eq!(sliding_extreme(&x, r, take_max), direct, "n {n} r {r} max {take_max}");
                }
            }
        }
    }
}
