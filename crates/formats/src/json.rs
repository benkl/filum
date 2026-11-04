//! pystitch's embroidery JSON export (reader/writer).
//!
//! Ported from pystitch, Ink/Stitch's embroidery file library (MIT, Copyright (c) 2018 Tatarize
//! and the Ink/Stitch contributors)
//! (`JsonWriter.py`, `JsonReader.py`).
//!
//! `{"threadlist": [...], "stitches": [[x, y, "COMMAND"], ...], "extras": {...}}` with x, y
//! in 0.1 mm (y down), laid out like Python's `json.dump(..., indent=4)`. As in Ink/Stitch
//! the stitches are encoded first (full jumps, colour changes, END).

use crate::encoder::{encode, Cmd, UNLIMITED};
use crate::raw::RawPattern;
use crate::tbf::needle;
use crate::txt::command;
use crate::{Error, Pattern, Thread};

// ---------------------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------------------

/// A JSON string literal, ASCII only (Python's `ensure_ascii`).
fn quote(s: &str) -> String {
    let mut out = String::from("\"");
    for c in s.chars() {
        match c {
            '"' => out += "\\\"",
            '\\' => out += "\\\\",
            '\n' => out += "\\n",
            '\r' => out += "\\r",
            '\t' => out += "\\t",
            '\u{8}' => out += "\\b",
            '\u{c}' => out += "\\f",
            c if (' '..='~').contains(&c) => out.push(c),
            c => {
                let mut buf = [0u16; 2];
                for u in c.encode_utf16(&mut buf) {
                    out += &format!("\\u{u:04x}");
                }
            }
        }
    }
    out.push('"');
    out
}

fn opt(s: &str) -> String {
    if s.is_empty() {
        "null".into()
    } else {
        quote(s)
    }
}

pub(crate) fn write(p: &Pattern) -> Vec<u8> {
    let e = encode(p, UNLIMITED, false);
    let mut s = String::from("{\n    \"threadlist\": [");
    for (i, t) in e.threads.iter().enumerate() {
        s += if i == 0 { "\n" } else { ",\n" };
        s += "        {\n";
        s += &format!("            \"color\": {},\n", quote(&t.hex()));
        s += &format!("            \"description\": {},\n", opt(&t.name));
        s += &format!("            \"catalog_number\": {},\n", opt(&t.code));
        s += "            \"details\": null,\n";
        s += &format!("            \"brand\": {},\n", opt(&t.brand));
        s += "            \"chart\": null,\n";
        s += "            \"weight\": null\n";
        s += "        }";
    }
    s += if e.threads.is_empty() { "],\n" } else { "\n    ],\n" };
    s += "    \"stitches\": [";
    let mut changes = 0;
    for (i, r) in e.recs.iter().enumerate() {
        let name = if r.cmd == Cmd::ColorChange {
            // pystitch tags colour changes with the thread and needle of the change sequence
            changes += 1;
            format!("COLOR_CHANGE t{changes} n{}", needle(changes))
        } else {
            command(r.cmd).0.to_string()
        };
        s += if i == 0 { "\n" } else { ",\n" };
        s += &format!("        [\n            {}.0,\n            {}.0,\n            {}\n        ]", r.x, r.y, quote(&name));
    }
    s += if e.recs.is_empty() { "],\n" } else { "\n    ],\n" };
    s += &format!("    \"extras\": {{\n        \"name\": {}\n    }}\n}}", quote(&e.name));
    s.into_bytes()
}

// ---------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
#[allow(dead_code)] // booleans are parsed but not used
enum Value {
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    Arr(Vec<Value>),
    Obj(Vec<(String, Value)>),
}

impl Value {
    fn get(&self, key: &str) -> Option<&Value> {
        match self {
            Value::Obj(o) => o.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }
    fn str(&self) -> Option<&str> {
        match self {
            Value::Str(s) => Some(s),
            _ => None,
        }
    }
    fn num(&self) -> Option<f64> {
        match self {
            Value::Num(n) => Some(*n),
            _ => None,
        }
    }
    fn arr(&self) -> &[Value] {
        match self {
            Value::Arr(a) => a,
            _ => &[],
        }
    }
}

struct Parser<'a> {
    b: &'a [u8],
    i: usize,
}

fn bad(what: &str) -> Error {
    Error::Malformed(format!("JSON: {what}"))
}

impl Parser<'_> {
    fn ws(&mut self) {
        while self.b.get(self.i).is_some_and(|c| c.is_ascii_whitespace()) {
            self.i += 1;
        }
    }

    fn eat(&mut self, c: u8) -> Result<(), Error> {
        self.ws();
        if self.b.get(self.i) == Some(&c) {
            self.i += 1;
            Ok(())
        } else {
            Err(bad(&format!("expected '{}' at byte {}", c as char, self.i)))
        }
    }

    fn value(&mut self, depth: usize) -> Result<Value, Error> {
        if depth > 64 {
            return Err(bad("nested too deeply"));
        }
        self.ws();
        match self.b.get(self.i) {
            Some(b'{') => {
                self.i += 1;
                let mut o = Vec::new();
                self.ws();
                if self.b.get(self.i) == Some(&b'}') {
                    self.i += 1;
                    return Ok(Value::Obj(o));
                }
                loop {
                    self.ws();
                    let k = self.string()?;
                    self.eat(b':')?;
                    o.push((k, self.value(depth + 1)?));
                    self.ws();
                    match self.b.get(self.i) {
                        Some(b',') => self.i += 1,
                        Some(b'}') => {
                            self.i += 1;
                            return Ok(Value::Obj(o));
                        }
                        _ => return Err(bad("expected ',' or '}'")),
                    }
                }
            }
            Some(b'[') => {
                self.i += 1;
                let mut a = Vec::new();
                self.ws();
                if self.b.get(self.i) == Some(&b']') {
                    self.i += 1;
                    return Ok(Value::Arr(a));
                }
                loop {
                    a.push(self.value(depth + 1)?);
                    self.ws();
                    match self.b.get(self.i) {
                        Some(b',') => self.i += 1,
                        Some(b']') => {
                            self.i += 1;
                            return Ok(Value::Arr(a));
                        }
                        _ => return Err(bad("expected ',' or ']'")),
                    }
                }
            }
            Some(b'"') => Ok(Value::Str(self.string()?)),
            Some(b't') if self.b[self.i..].starts_with(b"true") => {
                self.i += 4;
                Ok(Value::Bool(true))
            }
            Some(b'f') if self.b[self.i..].starts_with(b"false") => {
                self.i += 5;
                Ok(Value::Bool(false))
            }
            Some(b'n') if self.b[self.i..].starts_with(b"null") => {
                self.i += 4;
                Ok(Value::Null)
            }
            // Python also writes NaN / Infinity; they make no sense as coordinates.
            Some(c) if *c == b'-' || c.is_ascii_digit() => {
                let start = self.i;
                while self.b.get(self.i).is_some_and(|c| matches!(c, b'0'..=b'9' | b'-' | b'+' | b'.' | b'e' | b'E')) {
                    self.i += 1;
                }
                let t = std::str::from_utf8(&self.b[start..self.i]).map_err(|_| bad("number"))?;
                t.parse::<f64>().map(Value::Num).map_err(|_| bad("number"))
            }
            _ => Err(bad(&format!("unexpected input at byte {}", self.i))),
        }
    }

    fn hex4(&mut self) -> Result<u32, Error> {
        let h = self.b.get(self.i..self.i + 4).ok_or_else(|| bad("escape"))?;
        self.i += 4;
        u32::from_str_radix(std::str::from_utf8(h).map_err(|_| bad("escape"))?, 16).map_err(|_| bad("escape"))
    }

    fn string(&mut self) -> Result<String, Error> {
        if self.b.get(self.i) != Some(&b'"') {
            return Err(bad("expected a string"));
        }
        self.i += 1;
        let mut out: Vec<u8> = Vec::new();
        loop {
            let c = *self.b.get(self.i).ok_or_else(|| bad("unterminated string"))?;
            self.i += 1;
            match c {
                b'"' => return Ok(String::from_utf8_lossy(&out).into_owned()),
                b'\\' => {
                    let e = *self.b.get(self.i).ok_or_else(|| bad("escape"))?;
                    self.i += 1;
                    let ch = match e {
                        b'n' => '\n',
                        b'r' => '\r',
                        b't' => '\t',
                        b'b' => '\u{8}',
                        b'f' => '\u{c}',
                        b'u' => {
                            let mut u = self.hex4()?;
                            if (0xD800..0xDC00).contains(&u) && self.b[self.i..].starts_with(b"\\u") {
                                self.i += 2;
                                let lo = self.hex4()?;
                                u = 0x10000 + ((u - 0xD800) << 10) + (lo.wrapping_sub(0xDC00) & 0x3FF);
                            }
                            char::from_u32(u).unwrap_or('\u{FFFD}')
                        }
                        other => other as char,
                    };
                    let mut buf = [0u8; 4];
                    out.extend_from_slice(ch.encode_utf8(&mut buf).as_bytes());
                }
                c => out.push(c),
            }
        }
    }
}

/// `#rrggbb` (pystitch also accepts colour names; those fall back to a default colour).
fn parse_color(s: &str) -> Option<[u8; 3]> {
    let h = s.trim().strip_prefix('#')?;
    let v = u32::from_str_radix(h.get(..6)?, 16).ok()?;
    Some([(v >> 16) as u8, (v >> 8) as u8, v as u8])
}

/// Coordinates are kept to 0.001 mm (pystitch's are floats).
const UNITS_PER_MM: f64 = 1000.0;

pub(crate) fn read(bytes: &[u8]) -> Result<Pattern, Error> {
    let mut parser = Parser { b: bytes, i: 0 };
    let root = parser.value(0)?;
    let mut raw = RawPattern::new();
    if let Some(name) = root.get("extras").and_then(|x| x.get("name")).and_then(Value::str) {
        raw.name = name.to_string();
    }
    for (i, t) in root.get("threadlist").map(Value::arr).unwrap_or(&[]).iter().enumerate() {
        let text = |k: &str| t.get(k).and_then(Value::str).unwrap_or("").to_string();
        let rgb = t.get("color").and_then(Value::str).and_then(parse_color).unwrap_or(crate::default_thread(i).rgb);
        raw.threads.push(Thread { rgb, name: text("description"), code: text("catalog_number"), brand: text("brand") });
    }
    for s in root.get("stitches").map(Value::arr).unwrap_or(&[]) {
        let a = s.arr();
        let (Some(x), Some(y), Some(name)) = (a.first().and_then(Value::num), a.get(1).and_then(Value::num), a.get(2).and_then(Value::str)) else {
            return Err(bad("stitch entries are [x, y, \"COMMAND\"]"));
        };
        if !x.is_finite() || !y.is_finite() {
            return Err(bad("non-finite coordinate"));
        }
        // 0.1 mm file units to 0.001 mm
        let to = |v: f64| (v * 100.0).round().clamp(i32::MIN as f64 / 4.0, i32::MAX as f64 / 4.0) as i32;
        let (x, y) = (to(x), to(y));
        match name.split(' ').next().unwrap_or("") {
            "STITCH" => raw.stitch_abs(x, y),
            "JUMP" => raw.jump_abs(x, y),
            other => {
                (raw.x, raw.y) = (x, y);
                match other {
                    "TRIM" => raw.trim(),
                    "STOP" => raw.stop(),
                    "COLOR_CHANGE" => raw.color_change(),
                    "NEEDLE_SET" => raw.needle_change(),
                    "END" => break,
                    _ => {} // speeds, sequins, settings: not kept
                }
            }
        }
    }
    Ok(raw.finish_scaled(UNITS_PER_MM))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{cmd, Stitch};

    fn pattern() -> Pattern {
        Pattern {
            stitches: vec![
                Stitch::new(0.0, 0.0, 0),
                Stitch::new(1.5, -2.0, 0),
                Stitch::new(1.5, -2.0, cmd::COLOR_CHANGE),
                Stitch::new(3.0, 0.0, 0),
            ],
            threads: vec![
                Thread { rgb: [255, 0, 0], name: "Rot \"Ü\"".into(), code: "1147".into(), brand: "Madeira".into() },
                Thread::from_rgb([0, 0, 255]),
            ],
            name: "Test".into(),
        }
    }

    #[test]
    fn python_layout() {
        let s = String::from_utf8(write(&pattern())).unwrap();
        assert!(s.starts_with("{\n    \"threadlist\": [\n        {\n            \"color\": \"#ff0000\",\n            \"description\": \"Rot \\\"\\u00dc\\\"\",\n"));
        assert!(s.contains("            \"catalog_number\": null,\n            \"details\": null,\n            \"brand\": null,\n"));
        assert!(s.contains("    \"stitches\": [\n        [\n            0.0,\n            0.0,\n            \"STITCH\"\n        ],\n        [\n            15.0,\n            -20.0,\n"));
        assert!(s.contains("\"COLOR_CHANGE t1 n2\""));
        assert!(s.ends_with("        [\n            30.0,\n            0.0,\n            \"END\"\n        ]\n    ],\n    \"extras\": {\n        \"name\": \"Test\"\n    }\n}"));
    }

    #[test]
    fn roundtrip() {
        let p = pattern();
        let back = read(&write(&p)).unwrap();
        assert_eq!(back.name, "Test");
        assert_eq!(back.threads[0].name, "Rot \"Ü\"");
        assert_eq!(back.threads[0].code, "1147");
        assert_eq!(back.threads[1].rgb, [0, 0, 255]);
        let flags: Vec<u8> = back.stitches.iter().map(|s| s.flags).collect();
        assert_eq!(flags, vec![0, 0, cmd::COLOR_CHANGE, cmd::JUMP, 0, cmd::END]);
        assert_eq!((back.stitches[1].x, back.stitches[1].y), (1.5, -2.0));
    }

    #[test]
    fn fractional_coordinates_and_needle_sets() {
        let j = br#"{"threadlist": [], "stitches": [[0, 0, "NEEDLE_SET n1"], [12.34, -5, "STITCH"], [12.34, -5, "NEEDLE_SET n2"], [20, 0, "STITCH"], [20, 0, "END"]], "extras": {}}"#;
        let p = read(j).unwrap();
        let flags: Vec<u8> = p.stitches.iter().map(|s| s.flags).collect();
        assert_eq!(flags, vec![0, cmd::COLOR_CHANGE, 0, cmd::END]);
        assert!((p.stitches[0].x - 1.234).abs() < 1e-9);
        assert_eq!(p.threads.len(), 2);
        assert!(read(b"{\"stitches\": [[1, 2]]}").is_err());
        assert!(read(b"[[[[").is_err());
    }
}
