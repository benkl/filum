//! Thread lists: write Ink/Stitch's thread list (`thread_list.py`), read thread
//! lists (Ink/Stitch TXT, COL, EDR, INF) and apply one to the design's colours
//! (Ink/Stitch `apply_threadlist.py`).
//!
//! A thread list has one entry per colour block. Applying it walks the colour
//! blocks of the stitch plan and gives the objects sewn in block *k* the
//! colour of entry *k* — e.g. to bring back the colours of a DST, which stores
//! none.

use std::collections::{BTreeMap, HashMap};

use serde::{Deserialize, Serialize};
use filum_formats as fmts;

use crate::assemble::Engine;
use crate::model::{hex_color, Document, Thread};
use crate::plan::{flags, StitchPlan};

/// One entry of a thread list (one colour block).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ThreadListEntry {
    /// `#rrggbb`; `None`: the line names no colour (match its catalogue
    /// numbers in a thread chart, Ink/Stitch "other thread list").
    pub color: Option<String>,
    pub name: String,
    pub code: String,
    pub brand: String,
    /// Words of the line after its number, without `#` (catalogue number candidates).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub tokens: Vec<String>,
}

/// A thread list read from a file.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadList {
    /// "txt", "col", "edr", "inf" (or a stitch file's extension).
    pub kind: String,
    pub entries: Vec<ThreadListEntry>,
}

fn parse_hex(s: &str) -> Option<[u8; 3]> {
    let h = s.trim().trim_start_matches('#');
    if h.len() != 6 || !h.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    let v = u32::from_str_radix(h, 16).ok()?;
    Some([(v >> 16) as u8, (v >> 8) as u8, v as u8])
}

/// "None" (what Ink/Stitch writes for a missing value) and blanks → empty.
fn clean(s: &str) -> String {
    let s = s.trim();
    if s.eq_ignore_ascii_case("none") {
        String::new()
    } else {
        s.to_string()
    }
}

/// Parse a text thread list. Every line that starts with a digit is a colour
/// block (Ink/Stitch); its colour is the `(#rrggbb)` on it. Ink/Stitch's own
/// lines (`1 Name #code - Brand (#rrggbb)`) also give name, code and brand.
/// Stops at Ink/Stitch's "Thread Used" summary (a thread name starting with a
/// digit there would otherwise count as another block).
pub fn parse_text(text: &str) -> Vec<ThreadListEntry> {
    let mut out = Vec::new();
    for line in text.lines() {
        let line = line.trim_end_matches('\r');
        if line.trim() == "Thread Used" {
            break;
        }
        if !line.chars().next().is_some_and(|c| c.is_ascii_digit()) {
            continue;
        }
        // the colour: "(#rrggbb)"
        let color = line.match_indices("(#").find_map(|(i, _)| {
            let h = line.get(i + 1..i + 8)?;
            (line.get(i + 8..i + 9) == Some(")")).then(|| parse_hex(h)).flatten()
        });
        // catalogue number candidates: the words after the leading number
        let tokens: Vec<String> = line.replace('#', "").split_whitespace().skip(1).map(str::to_string).collect();
        let mut e = ThreadListEntry { color: color.map(hex_color), tokens, ..Default::default() };
        if color.is_some() {
            // "1 Name #code - Brand (#rrggbb)"
            let body = line.trim_start_matches(|c: char| c.is_ascii_digit()).trim_start();
            let body = body.rsplit_once(" (#").map(|x| x.0).unwrap_or(body);
            let (left, brand) = body.rsplit_once(" - ").unwrap_or((body, ""));
            let (name, code) = left.rsplit_once(" #").unwrap_or((left, ""));
            e.name = clean(name);
            e.code = clean(code);
            e.brand = clean(brand);
        }
        out.push(e);
    }
    out
}

/// Read a thread list file: Ink/Stitch's or another TXT thread list, COL, EDR,
/// INF — or the colours of any stitch file Filum reads.
pub fn read_thread_list(bytes: &[u8], filename: &str) -> Result<ThreadList, String> {
    let ext = filename.rsplit_once('.').map(|x| x.1.to_ascii_lowercase()).unwrap_or_default();
    if ext == "txt" || ext.is_empty() {
        let entries = parse_text(&String::from_utf8_lossy(bytes));
        if entries.is_empty() {
            return Err("no colour blocks in this thread list (lines starting with a number)".into());
        }
        return Ok(ThreadList { kind: "txt".into(), entries });
    }
    let fmt = fmts::format_from_extension(&ext).ok_or_else(|| format!("unknown thread list .{ext}"))?;
    let threads = fmts::read_threads(bytes, fmt).map_err(|e| e.to_string())?;
    if threads.is_empty() {
        return Err("the file holds no colours".into());
    }
    let entries = threads
        .into_iter()
        .map(|t| {
            // Ink/Stitch: a description "Cut…" is a cutwork needle, not a thread
            let name = if t.name.starts_with("Cut") { String::new() } else { t.name };
            ThreadListEntry {
                color: Some(hex_color(t.rgb)),
                name,
                // COL's "catalogue number" is the line index (pystitch)
                code: if fmt == fmts::Format::Col { String::new() } else { t.code },
                brand: t.brand,
                tokens: vec![],
            }
        })
        .collect();
    Ok(ThreadList { kind: ext, entries })
}

/// Python's `str(round(v, 2))`: at least one decimal, at most two.
fn py_round2(v: f64) -> String {
    let s = format!("{:.2}", (v * 100.0).round() / 100.0);
    let s = s.trim_end_matches('0');
    if s.ends_with('.') {
        format!("{s}0")
    } else {
        s.to_string()
    }
}

/// One thread as Ink/Stitch writes it: `Name #code - Brand (#rrggbb)`.
fn thread_line(t: &Thread) -> String {
    format!("{} #{} - {} ({})", t.name, t.code, t.brand, t.color.to_ascii_lowercase())
}

/// Ink/Stitch's thread list (`get_threadlist`): design details, the thread of
/// every colour block in sewing order and the threads used.
pub fn thread_list_text(plan: &StitchPlan, design_name: &str) -> String {
    let b = plan.bounds();
    let (w, h) = if b.is_empty() { (0.0, 0.0) } else { (b.width(), b.height()) };
    let stitches = plan.stitches.iter().filter(|s| s.is_stitch()).count();
    let blocks = &plan.threads;
    let mut colours: Vec<String> = blocks.iter().map(|t| t.color.to_ascii_lowercase()).collect();
    colours.sort();
    colours.dedup();
    let mut s = String::from("Design Details\n==============================\n\n");
    s += &format!("Title: {design_name}\n");
    s += &format!("Size (mm): {} x {}\n", py_round2(w), py_round2(h));
    s += &format!("Stitches: {stitches}\n");
    s += &format!("Colors: {}\n\n", colours.len());
    s += "Thread Order\n===========================\n\n";
    let mut used: Vec<String> = Vec::new();
    for (i, t) in blocks.iter().enumerate() {
        let line = thread_line(t);
        s += &format!("{} {line}\n", i + 1);
        if !used.contains(&line) {
            used.push(line);
        }
    }
    s += "\nThread Used\n===========================\n\n";
    for l in used {
        s += &l;
        s.push('\n');
    }
    s
}

/// What applying a thread list did.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyReport {
    /// Colour blocks of the design.
    pub blocks: usize,
    /// Entries of the thread list.
    pub entries: usize,
    /// Blocks that got a colour from the list.
    pub applied: usize,
    /// Blocks whose entry has no colour (kept).
    pub unmatched: usize,
}

/// The objects (document indices) sewn in each colour block of `plan`, in order.
pub fn block_objects(plan: &StitchPlan) -> Vec<Vec<usize>> {
    let mut blocks: Vec<Vec<usize>> = vec![vec![]];
    for s in &plan.stitches {
        if s.is(flags::COLOR_CHANGE) {
            blocks.push(vec![]);
            continue;
        }
        // commands before a colour change carry the next object: count needle penetrations
        let o = s.object;
        if s.is_stitch() && o != u32::MAX && !blocks.last().unwrap().contains(&(o as usize)) {
            blocks.last_mut().unwrap().push(o as usize);
        }
    }
    // a plan without stitches has no blocks
    if plan.stitches.iter().all(|s| !s.is_stitch()) {
        return vec![];
    }
    blocks
}

/// Give the objects sewn in colour block *k* the thread of entry *k* (Ink/Stitch
/// `apply_threadlist`). Entries without a colour leave their block as it is;
/// extra entries are ignored. A thread used in several blocks that get
/// different colours is split into one thread per colour (the first keeps
/// the thread's id).
pub fn apply_thread_list(doc: &Document, engine: &mut Engine, entries: &[ThreadListEntry]) -> (Document, ApplyReport) {
    let plan = engine.plan(doc);
    let blocks = block_objects(&plan);
    let mut report = ApplyReport { blocks: blocks.len(), entries: entries.len(), ..Default::default() };
    // object index → entry
    let mut assign: BTreeMap<usize, &ThreadListEntry> = BTreeMap::new();
    for (k, objs) in blocks.iter().enumerate() {
        let Some(e) = entries.get(k) else { break };
        if e.color.as_deref().and_then(parse_hex).is_none() {
            report.unmatched += 1;
            continue;
        }
        report.applied += 1;
        for &o in objs {
            assign.insert(o, e);
        }
    }
    let mut out = doc.clone();
    let spec = |t: &Thread, e: &ThreadListEntry| -> Thread {
        let rgb = parse_hex(e.color.as_deref().unwrap_or("")).unwrap_or([0, 0, 0]);
        Thread {
            id: t.id.clone(),
            name: if e.name.is_empty() { crate::threads::nearest_name(rgb) } else { e.name.clone() },
            color: hex_color(rgb),
            brand: e.brand.clone(),
            code: e.code.clone(),
            weight: t.weight,
        }
    };
    let same = |a: &Thread, b: &Thread| a.color.eq_ignore_ascii_case(&b.color) && a.name == b.name && a.code == b.code && a.brand == b.brand;
    // per thread id: the distinct new threads in object order
    let mut per_thread: HashMap<String, Vec<Thread>> = HashMap::new();
    let mut new_threads: Vec<Thread> = Vec::new();
    let mut used_ids: Vec<String> = out.threads.iter().map(|t| t.id.clone()).collect();
    let mut next_id = || {
        let mut n = used_ids.len() + 1;
        while used_ids.contains(&format!("t{n}")) {
            n += 1;
        }
        let id = format!("t{n}");
        used_ids.push(id.clone());
        id
    };
    for i in 0..out.objects.len() {
        let Some(e) = assign.get(&i) else { continue };
        let tid = out.objects[i].thread.clone();
        let Some(old) = doc.threads.iter().find(|t| t.id == tid) else {
            // an object without a known thread gets a new one
            let id = next_id();
            let blank = Thread { id: id.clone(), name: String::new(), color: String::new(), brand: String::new(), code: String::new(), weight: None };
            new_threads.push(spec(&blank, e));
            out.objects[i].thread = id;
            continue;
        };
        let want = spec(old, e);
        let list = per_thread.entry(tid.clone()).or_default();
        if let Some(t) = list.iter().find(|t| same(t, &want)) {
            out.objects[i].thread = t.id.clone();
            continue;
        }
        // the first colour a thread gets updates it in place, unless some of
        // its objects keep their colour; any other colour becomes a new thread
        let all_assigned = doc.objects.iter().enumerate().filter(|(_, o)| o.thread == tid).all(|(j, _)| assign.contains_key(&j));
        let t = if list.is_empty() && all_assigned {
            want
        } else {
            let id = next_id();
            new_threads.push(Thread { id: id.clone(), ..want.clone() });
            Thread { id, ..want }
        };
        out.objects[i].thread = t.id.clone();
        list.push(t);
    }
    for t in &mut out.threads {
        if let Some(n) = per_thread.get(&t.id).and_then(|l| l.iter().find(|n| n.id == t.id)) {
            *t = n.clone();
            // a fitted colour's original no longer applies
            out.thread_sources.remove(&t.id);
        }
    }
    out.threads.extend(new_threads);
    (out, report)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Object, StitchParams, SubPath};
    use crate::geom::pt;

    fn thread(id: &str, color: &str) -> Thread {
        Thread { id: id.into(), name: id.into(), color: color.into(), brand: String::new(), code: String::new(), weight: None }
    }

    fn line_object(id: &str, thread: &str, y: f64) -> Object {
        Object {
            id: id.into(),
            name: id.into(),
            thread: thread.into(),
            visible: true,
            locked: false,
            paths: vec![SubPath::polyline(&[pt(0.0, y), pt(5.0, y), pt(10.0, y)], false)],
            stitch: StitchParams::Manual(Default::default()),
            trim_after: false,
            stop_after: false,
            ties: Default::default(),
            force_lock: false,
            min_stitch: None,
            min_jump: None,
            patterns: vec![],
            clone: None,
            hidden: None,
            start: None,
            end: None,
            lock: None,
            color_sort_index: None,
        }
    }

    #[test]
    fn writes_and_reads_inkstitch_lists() {
        let mut t = thread("a", "#FF0000");
        t.name = "Red".into();
        t.code = "1147".into();
        t.brand = "Madeira Rayon".into();
        let plan = StitchPlan {
            stitches: vec![
                crate::plan::Stitch { x: 0.0, y: 0.0, flags: 0, object: 0 },
                crate::plan::Stitch { x: 10.0, y: 5.0, flags: 0, object: 0 },
            ],
            threads: vec![t.clone(), thread("b", "#0000ff")],
            ..Default::default()
        };
        let s = thread_list_text(&plan, "Rose");
        assert!(s.starts_with("Design Details\n==============================\n\nTitle: Rose\nSize (mm): 10.0 x 5.0\nStitches: 2\nColors: 2\n"));
        assert!(s.contains("\n1 Red #1147 - Madeira Rayon (#ff0000)\n2 b # -  (#0000ff)\n"));
        let e = parse_text(&s);
        assert_eq!(e.len(), 2);
        assert_eq!((e[0].color.as_deref(), e[0].name.as_str(), e[0].code.as_str(), e[0].brand.as_str()), (Some("#ff0000"), "Red", "1147", "Madeira Rayon"));
        assert_eq!((e[1].color.as_deref(), e[1].name.as_str(), e[1].code.as_str()), (Some("#0000ff"), "b", ""));
    }

    #[test]
    fn other_lists_give_tokens() {
        let e = parse_text("Thread chart\n1 Madeira #1147 red\n2. 1800\nnotes\n");
        assert_eq!(e.len(), 2);
        assert_eq!(e[0].color, None);
        assert_eq!(e[0].tokens, vec!["Madeira", "1147", "red"]);
        assert_eq!(e[1].tokens, vec!["1800"]);
    }

    #[test]
    fn applies_per_block_and_splits_shared_threads() {
        // red, blue, red again: three colour blocks, two threads
        let doc = Document {
            threads: vec![thread("r", "#ff0000"), thread("b", "#0000ff")],
            objects: vec![line_object("o1", "r", 0.0), line_object("o2", "b", 5.0), line_object("o3", "r", 10.0)],
            ..Document::default()
        };
        let mut engine = Engine::new();
        let list = vec![
            ThreadListEntry { color: Some("#111111".into()), ..Default::default() },
            ThreadListEntry { color: None, ..Default::default() },
            ThreadListEntry { color: Some("#333333".into()), name: "Grey".into(), ..Default::default() },
        ];
        let (out, r) = apply_thread_list(&doc, &mut engine, &list);
        assert_eq!((r.blocks, r.applied, r.unmatched), (3, 2, 1));
        let colour = |oid: &str| {
            let o = out.objects.iter().find(|o| o.id == oid).unwrap();
            out.threads.iter().find(|t| t.id == o.thread).unwrap().color.clone()
        };
        assert_eq!(colour("o1"), "#111111");
        assert_eq!(colour("o2"), "#0000ff");
        assert_eq!(colour("o3"), "#333333");
        // the first keeps its id, the second colour of "r" is a new thread
        assert_eq!(out.objects[0].thread, "r");
        assert_ne!(out.objects[2].thread, "r");
        assert_eq!(out.threads.len(), 3);
    }

    #[test]
    fn reads_colour_files() {
        let col = read_thread_list(b"2\r\n0,255,0,0\r\n1,0,0,255\r\n", "x.col").unwrap();
        assert_eq!(col.entries.iter().map(|e| e.color.clone().unwrap()).collect::<Vec<_>>(), vec!["#ff0000", "#0000ff"]);
        assert_eq!(col.entries[0].code, "");
        assert!(read_thread_list(b"no blocks here", "x.txt").is_err());
    }
}
