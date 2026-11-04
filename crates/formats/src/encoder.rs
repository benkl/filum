//! Lowering of a [`Pattern`] into format-friendly low-level records.
//!
//! Ported from pystitch, Ink/Stitch's embroidery file library (MIT, Copyright (c) 2018 Tatarize
//! and the Ink/Stitch contributors)
//! (`EmbEncoder.py`, the `Transcoder`/`Normalizer`). Only the subset needed for
//! Filum's command set is ported: stitches, jumps, trims, colour changes, stops, end.
//! Coordinates are converted to integer format units (0.1 mm) by rounding the absolute
//! position, so per-record deltas carry no accumulated rounding error.

use crate::{cmd, default_thread, Pattern, Thread};

/// Format units per millimetre (all supported formats use 0.1 mm).
pub(crate) const UNITS_PER_MM: f64 = 10.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Cmd {
    Stitch,
    Jump,
    Trim,
    ColorChange,
    Stop,
    End,
}

/// A low-level record at an absolute position in format units, y down.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Rec {
    pub x: i32,
    pub y: i32,
    pub cmd: Cmd,
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct EncodeSettings {
    pub max_stitch: i32,
    pub max_jump: i32,
    /// Emit an explicit jump to the exact target before the first stitch after a trim.
    pub full_jump: bool,
}

/// No length limits (pystitch writers without `MAX_*_DISTANCE`, e.g. TXT, JSON, G-code),
/// with Ink/Stitch's `full_jump`.
pub(crate) const UNLIMITED: EncodeSettings = EncodeSettings {
    max_stitch: i32::MAX / 4,
    max_jump: i32::MAX / 4,
    full_jump: true,
};

/// How colour changes are lowered (pystitch `thread_change_command` / `explicit_trim`).
#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct ThreadChange {
    /// pystitch `NEEDLE_SET` formats (U01, TBF): every colour block, the first included,
    /// starts with a [`Cmd::ColorChange`] record that selects its needle.
    pub needle_set: bool,
    /// pystitch `EXPLICIT_TRIM`: trim before every colour change after stitching.
    pub explicit_trim: bool,
}

/// Result of lowering: records (ending with `End`) and one thread per colour block.
#[derive(Debug, Clone)]
pub(crate) struct Encoded {
    pub recs: Vec<Rec>,
    pub threads: Vec<Thread>,
    pub name: String,
}

impl Encoded {
    /// `(min_x, min_y, max_x, max_y)` over all records (0s for an empty list).
    pub fn bounds(&self) -> (i32, i32, i32, i32) {
        if self.recs.is_empty() {
            return (0, 0, 0, 0);
        }
        let mut b = (i32::MAX, i32::MAX, i32::MIN, i32::MIN);
        for r in &self.recs {
            b.0 = b.0.min(r.x);
            b.1 = b.1.min(r.y);
            b.2 = b.2.max(r.x);
            b.3 = b.3.max(r.y);
        }
        b
    }

    pub fn count(&self, c: Cmd) -> usize {
        self.recs.iter().filter(|r| r.cmd == c).count()
    }

    /// pystitch `interpolate_stop_as_duplicate_color`: every STOP becomes a colour change
    /// to a duplicate of the current thread (used by PEC/PES which have no stop command).
    pub fn stops_as_duplicate_colors(&mut self) {
        let mut thread_index = 0usize;
        for r in self.recs.iter_mut() {
            match r.cmd {
                Cmd::ColorChange => thread_index += 1,
                Cmd::Stop => {
                    if thread_index >= self.threads.len() {
                        return;
                    }
                    let t = self.threads[thread_index].clone();
                    self.threads.insert(thread_index, t);
                    r.cmd = Cmd::ColorChange;
                    thread_index += 1;
                }
                _ => {}
            }
        }
    }

    /// Records split into colour blocks; each block after the first starts with the
    /// `ColorChange` record that opened it (pystitch Vp3Writer `get_as_colorblocks`).
    pub fn colorblocks_starting_with_change(&self) -> Vec<&[Rec]> {
        let mut out = Vec::new();
        let mut last = 0;
        for (i, r) in self.recs.iter().enumerate() {
            if r.cmd == Cmd::ColorChange {
                out.push(&self.recs[last..i]);
                last = i;
            }
        }
        out.push(&self.recs[last..]);
        out
    }

    /// Thread for block `i`, synthesizing a default if missing.
    pub fn thread(&self, i: usize) -> Thread {
        self.threads
            .get(i)
            .cloned()
            .unwrap_or_else(|| default_thread(i))
    }
}

pub(crate) fn to_units(v: f64) -> i32 {
    // Python's round() (ties to even), for byte-compatibility with pystitch.
    let u = (v * UNITS_PER_MM).round_ties_even();
    u.clamp(i32::MIN as f64 / 4.0, i32::MAX as f64 / 4.0) as i32
}

struct Encoder<'a> {
    s: EncodeSettings,
    tc: ThreadChange,
    long_stitch_as_jumps: bool,
    src: &'a Pattern,
    recs: Vec<Rec>,
    threads: Vec<Thread>,
    nx: i32,
    ny: i32,
    trimmed: bool,
    started: bool,
    thread_index: usize,
}

impl<'a> Encoder<'a> {
    fn add(&mut self, cmd: Cmd, x: i32, y: i32) {
        self.recs.push(Rec { x, y, cmd });
        self.nx = x;
        self.ny = y;
    }

    fn here(&mut self, cmd: Cmd) {
        let (x, y) = (self.nx, self.ny);
        self.recs.push(Rec { x, y, cmd });
    }

    fn thread_for(&self, i: usize) -> Thread {
        self.src
            .threads
            .get(i)
            .cloned()
            .unwrap_or_else(|| default_thread(i))
    }

    /// pystitch `interpolate_gap_stitches`: emits the intermediate records so that
    /// the final hop to (x1, y1) does not exceed `max` on either axis.
    fn gaps(&mut self, x1: i32, y1: i32, max: i32, cmd: Cmd) {
        let (x0, y0) = (self.nx, self.ny);
        let dx = (x1 - x0) as f64;
        let dy = (y1 - y0) as f64;
        let max = max.max(1) as f64;
        if dx.abs() <= max && dy.abs() <= max {
            return;
        }
        let steps = (dx.abs() / max).ceil().max((dy.abs() / max).ceil());
        let (sx, sy) = (dx / steps, dy / steps);
        let (mut qx, mut qy) = (x0 as f64, y0 as f64);
        for _ in 1..steps as i64 {
            // Same float accumulation and relative rounding as pystitch's encoder +
            // writers, so split points are identical.
            qx += sx;
            qy += sy;
            let rx = self.nx + (qx - self.nx as f64).round_ties_even() as i32;
            let ry = self.ny + (qy - self.ny as f64).round_ties_even() as i32;
            self.add(cmd, rx, ry);
        }
    }

    fn stitch(&mut self, x: i32, y: i32) {
        if self.trimmed {
            if !self.started {
                self.started = true;
                let t = self.thread_for(self.thread_index);
                self.threads.push(t);
                if self.tc.needle_set {
                    // pystitch `declare_not_trimmed` -> `next_change_sequence`: the first
                    // needle set sits at the position before the jump to the first stitch.
                    self.here(Cmd::ColorChange);
                }
            }
            self.trimmed = false;
            // jump_to_within_stitchrange
            self.gaps(x, y, self.s.max_jump, Cmd::Jump);
            if self.s.full_jump && (self.nx != x || self.ny != y) {
                self.add(Cmd::Jump, x, y);
            }
        } else if self.long_stitch_as_jumps {
            // needle_to
            self.gaps(x, y, self.s.max_stitch, Cmd::Jump);
        } else {
            // sew_to
            self.gaps(x, y, self.s.max_stitch, Cmd::Stitch);
        }
        self.add(Cmd::Stitch, x, y);
    }

    fn jump(&mut self, x: i32, y: i32) {
        if self.nx == x && self.ny == y {
            return;
        }
        self.gaps(x, y, self.s.max_jump, Cmd::Jump);
        self.add(Cmd::Jump, x, y);
    }

    fn run(&mut self) {
        let src = self.src;
        let last_penetration = src.stitches.iter().rposition(|s| s.is_penetration());
        for (i, s) in src.stitches.iter().enumerate() {
            let f = s.flags & cmd::COMMANDS;
            let (x, y) = (to_units(s.x), to_units(s.y));
            let more_stitching = last_penetration.is_some_and(|l| l > i);
            if f == 0 {
                self.stitch(x, y);
                continue;
            }
            if f & cmd::TRIM != 0 && !self.trimmed {
                self.here(Cmd::Trim);
                self.trimmed = true;
            }
            if f & cmd::COLOR_CHANGE != 0 {
                if self.tc.explicit_trim && !self.trimmed {
                    self.here(Cmd::Trim);
                    self.trimmed = true;
                }
                self.thread_index += 1;
                if self.started && more_stitching {
                    self.here(Cmd::ColorChange);
                    let t = self.thread_for(self.thread_index);
                    self.threads.push(t);
                    self.trimmed = true;
                }
            }
            if f & cmd::STOP != 0 && self.started && more_stitching {
                self.here(Cmd::Stop);
                self.trimmed = true;
            }
            if f & cmd::JUMP != 0 {
                self.jump(x, y);
            }
            if f & cmd::END != 0 {
                break;
            }
        }
        self.here(Cmd::End);
    }
}

/// Lower `p` with the given format constraints.
pub(crate) fn encode(p: &Pattern, s: EncodeSettings, long_stitch_as_jumps: bool) -> Encoded {
    encode_with(p, s, long_stitch_as_jumps, ThreadChange::default())
}

/// Lower `p` with the given format constraints and colour-change style.
pub(crate) fn encode_with(p: &Pattern, s: EncodeSettings, long_stitch_as_jumps: bool, tc: ThreadChange) -> Encoded {
    let mut e = Encoder {
        s,
        tc,
        long_stitch_as_jumps,
        src: p,
        recs: Vec::with_capacity(p.stitches.len() + 16),
        threads: Vec::new(),
        nx: 0,
        ny: 0,
        trimmed: true,
        started: false,
        thread_index: 0,
    };
    e.run();
    Encoded {
        recs: e.recs,
        threads: e.threads,
        name: p.name.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Stitch;

    fn st(x: f64, y: f64, f: u8) -> Stitch {
        Stitch { x, y, flags: f }
    }

    #[test]
    fn splits_long_stitches_and_jumps() {
        let p = Pattern {
            stitches: vec![
                st(0.0, 0.0, 0),
                st(30.0, 0.0, 0),
                st(30.0, 0.0, cmd::TRIM),
                st(-10.0, 25.0, cmd::JUMP),
                st(-10.0, 25.0, 0),
            ],
            ..Default::default()
        };
        let s = EncodeSettings {
            max_stitch: 121,
            max_jump: 121,
            full_jump: false,
        };
        let e = encode(&p, s, false);
        for w in e.recs.windows(2) {
            assert!((w[1].x - w[0].x).abs() <= 121 && (w[1].y - w[0].y).abs() <= 121);
        }
        let stitches = e.recs.iter().filter(|r| r.cmd == Cmd::Stitch).count();
        assert_eq!(stitches, 1 + 3 + 1);
        assert_eq!(e.count(Cmd::Trim), 1);
        assert_eq!(e.recs.last().unwrap().cmd, Cmd::End);
        assert_eq!(e.threads.len(), 1);
    }

    #[test]
    fn colour_change_lowering() {
        let p = Pattern {
            stitches: vec![
                st(0.0, 0.0, 0),
                st(1.0, 0.0, 0),
                st(1.0, 0.0, cmd::COLOR_CHANGE),
                st(2.0, 0.0, 0),
                st(2.0, 0.0, cmd::COLOR_CHANGE), // trailing: dropped
                st(2.0, 0.0, cmd::END),
            ],
            threads: vec![Thread::from_rgb([1, 2, 3])],
            ..Default::default()
        };
        let s = EncodeSettings {
            max_stitch: 127,
            max_jump: 127,
            full_jump: true,
        };
        let e = encode(&p, s, false);
        assert_eq!(e.count(Cmd::ColorChange), 1);
        assert_eq!(e.threads.len(), 2);
        assert_eq!(e.threads[0].rgb, [1, 2, 3]);
        assert_eq!(e.threads[1], default_thread(1));
        // full jump to the first stitch of block 2.
        let cc = e
            .recs
            .iter()
            .position(|r| r.cmd == Cmd::ColorChange)
            .unwrap();
        assert_eq!(
            e.recs[cc + 1],
            Rec {
                x: 20,
                y: 0,
                cmd: Cmd::Jump
            }
        );
    }
}
