//! `filum` command line: batch conversion, stats, auto-digitizing and
//! order optimisation using the same engine as the editor.
//!
//! ```text
//! filum convert design.svg design.pes        # Ink/Stitch SVG → PES
//! filum convert logo.dst logo.filum      # machine file → editable project
//! filum info design.svg                       # stitch count, colours, time, thread
//! filum digitize photo.png out.dst --colors 6 --width 90
//! filum optimize in.svg out.svg               # fewer colour changes & jumps
//! ```

use std::io::Write;
use std::path::Path;
use std::process::ExitCode;

use filum_core::{io, optimize, Document, Engine};

/// `println!` that stops quietly when the reader goes away (`filum formats | head`)
/// instead of panicking on the closed pipe.
macro_rules! out {
    ($($arg:tt)*) => {
        if let Err(e) = writeln!(std::io::stdout(), $($arg)*) {
            if e.kind() == std::io::ErrorKind::BrokenPipe {
                std::process::exit(0);
            }
            return Err(e.to_string());
        }
    };
}

fn ext(p: &str) -> String {
    Path::new(p).extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase()
}

fn load(path: &str) -> Result<Document, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("{path}: {e}"))?;
    io::import(&bytes, Some(path))
}

fn save(doc: &Document, engine: &mut Engine, path: &str) -> Result<(), String> {
    let bytes = io::export(doc, engine, &ext(path))?;
    std::fs::write(path, bytes).map_err(|e| format!("{path}: {e}"))
}

fn flag(args: &[String], name: &str) -> Option<String> {
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned()
}

fn info(doc: &Document, engine: &mut Engine) -> Result<(), String> {
    let plan = engine.plan(doc);
    let m = &doc.machine;
    let s = plan.stats(m.spm, m.trim_seconds, m.color_change_seconds);
    out!("Design      {}", doc.name);
    out!("Objects     {}", doc.objects.len());
    out!("Size        {:.1} × {:.1} mm", s.width, s.height);
    out!("Stitches    {}", s.stitches);
    out!("Colours     {} ({} changes)", plan.threads.len(), s.color_changes);
    out!("Trims       {}   Jumps {}", s.trims, s.jumps);
    out!("Thread      {:.1} m top + {:.1} m bobbin", s.thread_m, s.bobbin_m);
    out!("Run time    {}m {:02}s @ {} spm", (s.seconds / 60.0) as u32, (s.seconds % 60.0) as u32, m.spm);
    for (i, t) in plan.threads.iter().enumerate() {
        out!(
            "  {:>2}. {:<20} {}  {:>6} st  {:.1} m",
            i + 1,
            t.name,
            t.color,
            s.stitches_per_color.get(i).unwrap_or(&0),
            s.thread_per_color_m.get(i).unwrap_or(&0.0)
        );
    }
    Ok(())
}

fn run(args: Vec<String>) -> Result<(), String> {
    let mut engine = Engine::new();
    match args.first().map(String::as_str) {
        Some("convert") if args.len() >= 3 => {
            let doc = load(&args[1])?;
            save(&doc, &mut engine, &args[2])?;
            out!("wrote {}", args[2]);
        }
        Some("info") if args.len() >= 2 => {
            let doc = load(&args[1])?;
            info(&doc, &mut engine)?;
        }
        Some("optimize") if args.len() >= 3 => {
            let mut doc = load(&args[1])?;
            let r = optimize::optimize_order(&doc, &mut engine);
            optimize::apply_order(&mut doc, &r.order);
            out!(
                "colour changes {} → {}, travel {:.0} → {:.0} mm",
                r.color_changes_before, r.color_changes_after, r.travel_before_mm, r.travel_after_mm
            );
            save(&doc, &mut engine, &args[2])?;
        }
        Some("digitize") if args.len() >= 3 => {
            let bytes = std::fs::read(&args[1]).map_err(|e| e.to_string())?;
            let mut opts = filum_core::digitize::DigitizeOptions::default();
            if let Some(c) = flag(&args, "--colors") {
                opts.colors = c.parse().map_err(|_| "--colors expects a number")?;
            }
            if let Some(w) = flag(&args, "--width") {
                opts.width_mm = w.parse().map_err(|_| "--width expects mm")?;
            }
            let r = filum_core::digitize::digitize_image(&bytes, &opts)?;
            let mut doc = Document { name: "Digitized".into(), threads: r.threads, objects: r.objects, ..Document::default() };
            let b = doc.bounds();
            doc.hoop.width = (b.max_x + 10.0).ceil().max(50.0);
            doc.hoop.height = (b.max_y + 10.0).ceil().max(50.0);
            save(&doc, &mut engine, &args[2])?;
            info(&doc, &mut engine)?;
        }
        Some("formats") => {
            for f in io::formats() {
                out!(
                    "{:<12} {:<28} {}{}",
                    f.extension,
                    f.name,
                    if f.can_read { "read " } else { "     " },
                    if f.can_write { "write" } else { "" }
                );
            }
        }
        _ => {
            eprintln!(
                "filum {}\n\nUSAGE:\n  filum convert <in> <out>\n  filum info <file>\n  filum optimize <in> <out>\n  filum digitize <image> <out> [--colors N] [--width MM]\n  filum formats",
                env!("CARGO_PKG_VERSION")
            );
            return Err(String::new());
        }
    }
    Ok(())
}

fn main() -> ExitCode {
    match run(std::env::args().skip(1).collect()) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            if !e.is_empty() {
                eprintln!("error: {e}");
            }
            ExitCode::FAILURE
        }
    }
}
