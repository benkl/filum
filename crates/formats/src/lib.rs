//! Machine-embroidery file readers and writers for Filum.
//!
//! The encoders/decoders are ports of [pystitch](https://github.com/inkstitch/pystitch), the file library of Ink/Stitch
//! (MIT, Copyright (c) 2018 Tatarize). Each ported module carries an attribution header.
//!
//! All coordinates in the public API are millimetres with the y axis pointing **down**
//! (SVG convention). See [`Stitch`] for the command semantics.

mod color;
mod compress;
mod csv;
mod dst;
mod encoder;
mod exp;
mod gcode;
mod hus;
mod io;
mod jef;
mod json;
mod misc;
pub mod palette;
mod pcs;
mod pec;
mod pes;
mod raw;
mod sew;
mod shv;
mod tbf;
mod threadlist;
mod txt;
mod u01;
mod vp3;
mod xxx;

pub use color::{delta_e76, nearest_index, red_mean_distance, srgb_to_lab};

/// Stitch command bits used in [`Stitch::flags`].
pub mod cmd {
    /// Move the frame to (x, y) without penetrating.
    pub const JUMP: u8 = 1;
    /// Cut the thread at the current position.
    pub const TRIM: u8 = 2;
    /// Switch from `threads[k]` to `threads[k + 1]` (k = number of earlier colour changes).
    pub const COLOR_CHANGE: u8 = 4;
    /// Machine pause (no thread change).
    pub const STOP: u8 = 8;
    /// End of design.
    pub const END: u8 = 16;
    // Informational tags on normal stitches; writers ignore them.
    pub const TIE: u8 = 32;
    pub const UNDERLAY: u8 = 64;
    pub const TRAVEL: u8 = 128;
    /// All bits that make a record a command rather than a needle penetration.
    pub const COMMANDS: u8 = JUMP | TRIM | COLOR_CHANGE | STOP | END;
}

/// One record of a stitch list. Millimetres, y down.
///
/// * no command bit: needle penetration at (x, y)
/// * [`cmd::JUMP`]: move the frame to (x, y) without penetrating
/// * [`cmd::TRIM`], [`cmd::COLOR_CHANGE`], [`cmd::STOP`], [`cmd::END`]: pure commands at the
///   current position
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Stitch {
    pub x: f64,
    pub y: f64,
    pub flags: u8,
}

impl Stitch {
    pub fn new(x: f64, y: f64, flags: u8) -> Self {
        Stitch { x, y, flags }
    }
    /// True if this record is a needle penetration (no command bits).
    pub fn is_penetration(&self) -> bool {
        self.flags & cmd::COMMANDS == 0
    }
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct Thread {
    pub rgb: [u8; 3],
    pub name: String,
    pub code: String,
    pub brand: String,
}

impl Thread {
    pub fn from_rgb(rgb: [u8; 3]) -> Self {
        Thread {
            rgb,
            ..Default::default()
        }
    }
    /// `#rrggbb`
    pub fn hex(&self) -> String {
        format!("#{:02x}{:02x}{:02x}", self.rgb[0], self.rgb[1], self.rgb[2])
    }
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct Pattern {
    pub stitches: Vec<Stitch>,
    pub threads: Vec<Thread>,
    pub name: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Format {
    Dst,
    Exp,
    Jef,
    Pes,
    Pec,
    Vp3,
    Xxx,
    /// Barudan U01 (also `.u00`, `.u02`).
    U01,
    /// Tajima TBF.
    Tbf,
    /// Janome SEW.
    Sew,
    /// G-code for DIY embroidery machines (write only).
    Gcode,
    /// Husqvarna HUS (read only).
    Hus,
    /// Husqvarna Viking SHV (read only).
    Shv,
    /// Pfaff PCS (read only).
    Pcs,
    /// Pfaff PCD (read only).
    Pcd,
    /// Pfaff PCQ (read only).
    Pcq,
    /// Pfaff PCM (read only).
    Pcm,
    /// Pfaff KSM (read only).
    Ksm,
    /// Pfaff MAX (read only).
    Max,
    /// Pfaff SPX (read only).
    Spx,
    /// Brother PHB (read only).
    Phb,
    /// Brother PHC (read only).
    Phc,
    /// Janome JPX (read only).
    Jpx,
    /// Tajima (Barudan) DSB (read only).
    Dsb,
    /// ZSK USA DSZ (read only).
    Dsz,
    /// ZSK TC ZXY (read only).
    Zxy,
    /// Happy TAP (read only).
    Tap,
    /// Sunstar or Barudan DAT (read only).
    Dat,
    /// Data Stitch STX (read only).
    Stx,
    /// Elna EMD (read only).
    Emd,
    /// Eltac EXY / `.e00`… (read only).
    Exy,
    /// Fortron FXY / `.f00`… (read only).
    Fxy,
    /// Zeng Hsing ZHS (read only).
    Zhs,
    /// Toyota 10O (read only).
    A10o,
    /// Toyota 100 (read only).
    A100,
    /// Bits & Volts BRO (read only).
    Bro,
    /// Gold Thread GT (read only).
    Gt,
    /// Inbro INB (read only).
    Inb,
    /// Mitsubishi MIT (read only).
    Mit,
    /// Ameco NEW (read only).
    New,
    /// Gunold STC (read only).
    Stc,
    /// Stitch list dump (write only).
    Csv,
    /// Stitch list as text (write only).
    Txt,
    /// Thread colour list, text (write only).
    Col,
    /// Thread colour list, binary (write only).
    Edr,
    /// Thread colour list with names (write only).
    Inf,
    /// pystitch's embroidery JSON. Not in [`formats`]: in Filum `.json` is the
    /// project format, so this one is only reachable through [`read`] / [`write`].
    Json,
}

/// What a format holds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FormatKind {
    /// Stitches for an embroidery machine.
    Machine,
    /// Only the thread colours of a design (loaded next to a stitch file).
    Threads,
    /// A human-readable stitch dump.
    Text,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FormatInfo {
    pub format: Format,
    pub extension: &'static str,
    pub name: &'static str,
    pub can_read: bool,
    pub can_write: bool,
    /// Further extensions of the same format (e.g. `u00`, `u02` for U01).
    pub aliases: &'static [&'static str],
    pub kind: FormatKind,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error {
    Unsupported(String),
    Malformed(String),
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::Unsupported(s) => write!(f, "unsupported: {s}"),
            Error::Malformed(s) => write!(f, "malformed file: {s}"),
        }
    }
}

impl std::error::Error for Error {}

const fn info(format: Format, extension: &'static str, name: &'static str, can_read: bool, can_write: bool) -> FormatInfo {
    FormatInfo { format, extension, name, can_read, can_write, aliases: &[], kind: FormatKind::Machine }
}

const fn read_only(format: Format, extension: &'static str, name: &'static str) -> FormatInfo {
    info(format, extension, name, true, false)
}

const fn with_aliases(mut i: FormatInfo, aliases: &'static [&'static str]) -> FormatInfo {
    i.aliases = aliases;
    i
}

const fn of_kind(mut i: FormatInfo, kind: FormatKind) -> FormatInfo {
    i.kind = kind;
    i
}

/// Every listed format in display order: machine formats that can be written, read-only
/// machine formats, then stitch dumps and thread colour lists. Names follow pystitch.
static FORMATS: [FormatInfo; 46] = [
    info(Format::Dst, "dst", "Tajima Embroidery Format", true, true),
    info(Format::Pes, "pes", "Brother Embroidery Format", true, true),
    info(Format::Jef, "jef", "Janome Embroidery Format", true, true),
    info(Format::Exp, "exp", "Melco Expanded Embroidery Format", true, true),
    info(Format::Vp3, "vp3", "Pfaff Embroidery Format", true, true),
    info(Format::Pec, "pec", "Brother Embroidery Format (PEC)", true, true),
    info(Format::Xxx, "xxx", "Singer Embroidery Format", true, true),
    with_aliases(info(Format::U01, "u01", "Barudan Embroidery Format", true, true), &["u00", "u02"]),
    info(Format::Tbf, "tbf", "Tajima Embroidery Format (TBF)", true, true),
    info(Format::Sew, "sew", "Janome Embroidery Format (SEW)", true, true),
    info(Format::Gcode, "gcode", "G-code for DIY embroidery machines", false, true),
    read_only(Format::Hus, "hus", "Husqvarna Embroidery Format"),
    read_only(Format::Shv, "shv", "Husqvarna Viking Embroidery Format"),
    read_only(Format::Pcs, "pcs", "Pfaff Embroidery Format (PCS)"),
    read_only(Format::Pcd, "pcd", "Pfaff Embroidery Format (PCD)"),
    read_only(Format::Pcq, "pcq", "Pfaff Embroidery Format (PCQ)"),
    read_only(Format::Pcm, "pcm", "Pfaff Embroidery Format (PCM)"),
    read_only(Format::Ksm, "ksm", "Pfaff Embroidery Format (KSM)"),
    read_only(Format::Max, "max", "Pfaff Embroidery Format (MAX)"),
    read_only(Format::Spx, "spx", "Pfaff Embroidery Format (SPX)"),
    read_only(Format::Phb, "phb", "Brother Embroidery Format (PHB)"),
    read_only(Format::Phc, "phc", "Brother Embroidery Format (PHC)"),
    read_only(Format::Jpx, "jpx", "Janome Embroidery Format (JPX)"),
    read_only(Format::Dsb, "dsb", "Tajima (Barudan) Embroidery Format"),
    read_only(Format::Dsz, "dsz", "ZSK USA Embroidery Format"),
    read_only(Format::Zxy, "zxy", "ZSK TC Embroidery Format"),
    read_only(Format::Tap, "tap", "Happy Embroidery Format"),
    read_only(Format::Dat, "dat", "Sunstar or Barudan Embroidery Format"),
    read_only(Format::Stx, "stx", "Data Stitch Embroidery Format"),
    read_only(Format::Emd, "emd", "Elna Embroidery Format"),
    with_aliases(read_only(Format::Exy, "exy", "Eltac Embroidery Format"), &["e00", "e01", "e02"]),
    with_aliases(read_only(Format::Fxy, "fxy", "Fortron Embroidery Format"), &["f00", "f01", "f02"]),
    read_only(Format::Zhs, "zhs", "Zeng Hsing Embroidery Format"),
    read_only(Format::A10o, "10o", "Toyota Embroidery Format (10O)"),
    read_only(Format::A100, "100", "Toyota Embroidery Format (100)"),
    read_only(Format::Bro, "bro", "Bits & Volts Embroidery Format"),
    read_only(Format::Gt, "gt", "Gold Thread Embroidery Format"),
    read_only(Format::Inb, "inb", "Inbro Embroidery Format"),
    read_only(Format::Mit, "mit", "Mitsubishi Embroidery Format"),
    read_only(Format::New, "new", "Ameco Embroidery Format"),
    read_only(Format::Stc, "stc", "Gunold Embroidery Format"),
    of_kind(info(Format::Csv, "csv", "Comma-separated values (debug dump)", false, true), FormatKind::Text),
    of_kind(info(Format::Txt, "txt", "Text stitch list (debug dump)", false, true), FormatKind::Text),
    of_kind(info(Format::Col, "col", "Thread colour list (COL)", false, true), FormatKind::Threads),
    of_kind(info(Format::Edr, "edr", "Thread colour list (EDR)", false, true), FormatKind::Threads),
    of_kind(info(Format::Inf, "inf", "Thread colour list (INF)", false, true), FormatKind::Threads),
];

/// pystitch's JSON export, deliberately not in [`FORMATS`].
static JSON_INFO: FormatInfo = of_kind(info(Format::Json, "json", "Embroidery JSON (pystitch)", true, true), FormatKind::Text);

/// All supported formats (see [`FORMATS`] for the order). pystitch's JSON
/// ([`Format::Json`]) is left out because `.json` is Filum's project format.
pub fn formats() -> &'static [FormatInfo] {
    &FORMATS
}

impl Format {
    pub fn info(self) -> &'static FormatInfo {
        if self == Format::Json {
            return &JSON_INFO;
        }
        FORMATS
            .iter()
            .find(|i| i.format == self)
            .expect("every format is listed")
    }
    pub fn extension(self) -> &'static str {
        self.info().extension
    }
}

/// Format for a file extension (case-insensitive, with or without leading dot), aliases
/// included. `json` is not matched (see [`Format::Json`]).
pub fn format_from_extension(ext: &str) -> Option<Format> {
    let e = ext.trim().trim_start_matches('.');
    FORMATS
        .iter()
        .find(|i| i.extension.eq_ignore_ascii_case(e) || i.aliases.iter().any(|a| a.eq_ignore_ascii_case(e)))
        .map(|i| i.format)
}

/// Guess the format of `bytes`: magic bytes first (`#PES`, `#PEC`, `#PHB`, `#PHC`, DST `LA:`,
/// VP3 `%vsm%`), then the extension of `filename`.
pub fn detect(bytes: &[u8], filename: Option<&str>) -> Option<Format> {
    if bytes.starts_with(b"#PES") {
        return Some(Format::Pes);
    }
    if bytes.starts_with(b"#PEC") {
        return Some(Format::Pec);
    }
    if bytes.starts_with(b"#PHB") {
        return Some(Format::Phb);
    }
    if bytes.starts_with(b"#PHC") {
        return Some(Format::Phc);
    }
    if bytes.starts_with(b"%vsm%") {
        return Some(Format::Vp3);
    }
    if bytes.starts_with(b"LA:") {
        return Some(Format::Dst);
    }
    let name = filename?;
    let ext = name.rsplit_once('.').map(|(_, e)| e)?;
    format_from_extension(ext)
}

/// PES file version.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum PesVersion {
    /// Version 1 (what Ink/Stitch writes): colours are slots of Brother's
    /// 64-colour thread table — read by every Brother machine.
    #[default]
    V1,
    /// Version 6: additionally the design's exact thread list (code, RGB,
    /// name, brand), shown by machines and software that read it.
    V6,
}

/// The colour a machine shows for one colour block of an exported file.
#[derive(Debug, Clone, PartialEq)]
pub struct MachineColor {
    /// The design's thread for this block.
    pub thread: Thread,
    /// The thread-table entry the file stores for it (PES / PEC: Brother,
    /// JEF: Janome); `None` when the file stores no colours (DST, EXP).
    pub shown: Option<Thread>,
    /// The table slot (1-based) for `shown`.
    pub slot: Option<usize>,
    /// The file also stores this block's exact colour / thread (VP3, XXX, PES v6).
    pub exact: bool,
}

/// What a machine will show for each colour block when `p` is written as `f`
/// (the same encoding as [`write_with_options`]).
pub fn machine_colors(p: &Pattern, f: Format, opts: &WriteOptions) -> Vec<MachineColor> {
    match f {
        Format::Pes | Format::Pec => {
            let e = pec::encode_for_pec(p, opts);
            let idx = pec::color_indices(&e);
            (0..e.threads.len())
                .map(|i| {
                    let slot = idx.get(i).copied().unwrap_or(0);
                    MachineColor { thread: e.thread(i), shown: Some(palette::pec_thread(slot)), slot: Some(slot), exact: f == Format::Pes && opts.pes_version == PesVersion::V6 }
                })
                .collect()
        }
        Format::Jef => {
            let e = encoder::encode(p, jef::SETTINGS, opts.long_stitch_as_jumps);
            let colors: Vec<[u8; 3]> = e.threads.iter().map(|t| t.rgb).collect();
            let idx = palette::build_nonrepeat_palette(&palette::jef_slots(), &colors);
            (0..e.threads.len())
                .map(|i| {
                    let slot = idx.get(i).copied().unwrap_or(1);
                    MachineColor { thread: e.thread(i), shown: palette::jef_thread(slot), slot: Some(slot), exact: false }
                })
                .collect()
        }
        Format::Vp3 | Format::Xxx => {
            let settings = if f == Format::Vp3 { vp3::SETTINGS } else { xxx::SETTINGS };
            let e = encoder::encode(p, settings, opts.long_stitch_as_jumps);
            (0..e.threads.len()).map(|i| MachineColor { thread: e.thread(i), shown: Some(e.thread(i)), slot: None, exact: true }).collect()
        }
        Format::Sew => {
            let e = encoder::encode(p, sew::SETTINGS, opts.long_stitch_as_jumps);
            sew::color_indices(&e)
                .into_iter()
                .enumerate()
                .map(|(i, slot)| MachineColor { thread: e.thread(i), shown: Some(palette::table_thread(&palette::SEW_PALETTE, slot, "Sew")), slot: Some(slot), exact: false })
                .collect()
        }
        // The exact colours: TBF's thread list, the thread colour files and text dumps.
        Format::Tbf | Format::Col | Format::Edr | Format::Inf | Format::Txt | Format::Csv | Format::Json => {
            let e = if f == Format::Tbf { tbf::encode(p, opts) } else { encoder::encode(p, encoder::UNLIMITED, false) };
            (0..e.threads.len()).map(|i| MachineColor { thread: e.thread(i), shown: Some(e.thread(i)), slot: None, exact: true }).collect()
        }
        // No colours in the file (DST, EXP, U01, G-code; read-only formats are never written).
        _ => {
            let settings = match f {
                Format::Exp => exp::SETTINGS,
                Format::U01 => u01::SETTINGS,
                Format::Gcode => encoder::UNLIMITED,
                _ => dst::SETTINGS,
            };
            let e = encoder::encode(p, settings, opts.long_stitch_as_jumps);
            (0..e.threads.len()).map(|i| MachineColor { thread: e.thread(i), shown: None, slot: None, exact: false }).collect()
        }
    }
}

/// Options for [`write_with_options`].
#[derive(Debug, Clone, Default)]
pub struct WriteOptions {
    /// PES version (default: 1, as Ink/Stitch).
    pub pes_version: PesVersion,
    /// Split over-long stitches with jumps instead of extra stitches (pystitch's default
    /// `CONTINGENCY_LONG_STITCH_JUMP_NEEDLE`). Default `false`: over-long stitches are split
    /// into several shorter stitches along the same line.
    pub long_stitch_as_jumps: bool,
    /// JEF header date as `YYYYMMDDHHMMSS`. Default: current UTC time (fixed date on wasm).
    pub date: Option<String>,
}

/// Encode `p` into the given format.
pub fn write(p: &Pattern, f: Format) -> Result<Vec<u8>, Error> {
    write_with_options(p, f, &WriteOptions::default())
}

/// Encode `p` into the given format with explicit options.
pub fn write_with_options(p: &Pattern, f: Format, opts: &WriteOptions) -> Result<Vec<u8>, Error> {
    for s in &p.stitches {
        if !s.x.is_finite() || !s.y.is_finite() {
            return Err(Error::Malformed("non-finite stitch coordinate".into()));
        }
    }
    match f {
        Format::Dst => Ok(dst::write(p, opts)),
        Format::Pes => Ok(pes::write(p, opts)),
        Format::Pec => Ok(pec::write(p, opts)),
        Format::Jef => Ok(jef::write(p, opts)),
        Format::Exp => Ok(exp::write(p, opts)),
        Format::Vp3 => Ok(vp3::write(p, opts)),
        Format::Xxx => Ok(xxx::write(p, opts)),
        Format::U01 => Ok(u01::write(p, opts)),
        Format::Tbf => Ok(tbf::write(p, opts)),
        Format::Sew => sew::write(p, opts),
        Format::Gcode => Ok(gcode::write(p)),
        Format::Csv => Ok(csv::write(p)),
        Format::Txt => Ok(txt::write(p)),
        Format::Col => Ok(threadlist::write_col(p)),
        Format::Edr => Ok(threadlist::write_edr(p)),
        Format::Inf => Ok(threadlist::write_inf(p)),
        Format::Json => Ok(json::write(p)),
        _ => Err(Error::Unsupported(format!("writing {} is not supported", f.extension().to_uppercase()))),
    }
}

/// Decode a file of the given format.
pub fn read(bytes: &[u8], f: Format) -> Result<Pattern, Error> {
    match f {
        Format::Dst => dst::read(bytes),
        Format::Pes => pes::read(bytes),
        Format::Pec => pec::read(bytes),
        Format::Jef => jef::read(bytes),
        Format::Exp => exp::read(bytes),
        Format::Vp3 => vp3::read(bytes),
        Format::Xxx => xxx::read(bytes),
        Format::U01 => u01::read(bytes),
        Format::Tbf => tbf::read(bytes),
        Format::Sew => sew::read(bytes),
        Format::Hus => hus::read(bytes),
        Format::Shv => shv::read(bytes),
        Format::Pcs | Format::Pcd | Format::Pcq => pcs::read(bytes),
        Format::Pcm => pcs::read_pcm(bytes),
        Format::Ksm => misc::read_ksm(bytes),
        Format::Max => misc::read_max(bytes),
        Format::Spx => misc::read_spx(bytes),
        Format::Phb => misc::read_phb(bytes),
        Format::Phc => misc::read_phc(bytes),
        Format::Jpx => misc::read_jpx(bytes),
        Format::Dsb => misc::read_dsb(bytes),
        Format::Dsz => misc::read_dsz(bytes),
        Format::Zxy => misc::read_zxy(bytes),
        Format::Tap => misc::read_tap(bytes),
        Format::Dat => misc::read_dat(bytes),
        Format::Stx => misc::read_stx(bytes),
        Format::Emd => misc::read_emd(bytes),
        Format::Exy => misc::read_exy(bytes),
        Format::Fxy => misc::read_fxy(bytes),
        Format::Zhs => misc::read_zhs(bytes),
        Format::A10o => misc::read_10o(bytes),
        Format::A100 => misc::read_100(bytes),
        Format::Bro => misc::read_bro(bytes),
        Format::Gt => misc::read_gt(bytes),
        Format::Inb => misc::read_inb(bytes),
        Format::Mit => misc::read_mit(bytes),
        Format::New => misc::read_new(bytes),
        Format::Stc => misc::read_stc(bytes),
        Format::Json => json::read(bytes),
        Format::Gcode | Format::Csv | Format::Txt | Format::Col | Format::Edr | Format::Inf => {
            Err(Error::Unsupported(format!("reading {} is not supported", f.extension().to_uppercase())))
        }
    }
}

/// The thread list of a thread colour file (COL, EDR, INF): one entry per
/// colour block, as pystitch reads them.
pub fn read_threads(bytes: &[u8], f: Format) -> Result<Vec<Thread>, Error> {
    match f {
        Format::Col => threadlist::read_col(bytes),
        Format::Edr => threadlist::read_edr(bytes),
        Format::Inf => threadlist::read_inf(bytes),
        _ => Ok(read(bytes, f)?.threads),
    }
}

/// Distinct fallback colours used when a file has no colour information
/// (DST, EXP) or a pattern has fewer threads than colour blocks.
const DEFAULT_COLORS: [[u8; 3]; 12] = [
    [0x1f, 0x77, 0xb4],
    [0xd6, 0x27, 0x28],
    [0x2c, 0xa0, 0x2c],
    [0xff, 0x7f, 0x0e],
    [0x94, 0x67, 0xbd],
    [0x8c, 0x56, 0x4b],
    [0xe3, 0x77, 0xc2],
    [0x7f, 0x7f, 0x7f],
    [0xbc, 0xbd, 0x22],
    [0x17, 0xbe, 0xcf],
    [0x00, 0x00, 0x00],
    [0xff, 0xd7, 0x00],
];

/// Synthesized thread for colour block `index` when none is available.
pub fn default_thread(index: usize) -> Thread {
    Thread {
        rgb: DEFAULT_COLORS[index % DEFAULT_COLORS.len()],
        name: format!("Color {}", index + 1),
        code: String::new(),
        brand: String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extension_lookup() {
        assert_eq!(format_from_extension("DST"), Some(Format::Dst));
        assert_eq!(format_from_extension(".pes"), Some(Format::Pes));
        assert_eq!(format_from_extension("Vp3"), Some(Format::Vp3));
        assert_eq!(format_from_extension("svg"), None);
        for i in formats() {
            assert_eq!(format_from_extension(i.extension), Some(i.format));
        }
    }
}
