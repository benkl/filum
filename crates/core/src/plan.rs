//! Stitch plan: the flat, machine-level list of needle movements and commands.
//!
//! Conventions (mirror Ink/Stitch's pystitch so format writers are simple):
//! * A record with no command bit set is a normal needle penetration at (x, y).
//! * `JUMP` moves the frame to (x, y) without penetrating.
//! * `TRIM`, `COLOR_CHANGE`, `STOP` and `END` are pure commands: their (x, y)
//!   equals the current position and carries no movement.
//! * `COLOR_CHANGE` number *k* switches from `threads[k]` to `threads[k+1]`.
//! * `TIE`, `UNDERLAY`, `TRAVEL` are informational tags on normal stitches.
//!
//! Units are millimetres, y down.

use serde::{Deserialize, Serialize};

use crate::geom::{Point, Rect};
use crate::model::Thread;

/// Top thread per stitch of standard length (Madeira: ~5 m per 1,000 stitches).
const TOP_PER_STITCH_MM: f64 = 5.0;
/// Thread for the loop through the fabric on top of a stitch's length
/// (what a standard ~3.5 mm stitch adds up to Madeira's 5 mm).
const LOOP_MM: f64 = 1.5;
/// Bobbin thread against top thread (Madeira: 3–3.5 m bobbin per 5 m top).
const BOBBIN_SHARE: f64 = 0.65;

pub mod flags {
    pub const JUMP: u8 = 1;
    pub const TRIM: u8 = 2;
    pub const COLOR_CHANGE: u8 = 4;
    pub const STOP: u8 = 8;
    pub const END: u8 = 16;
    /// informational
    pub const TIE: u8 = 32;
    pub const UNDERLAY: u8 = 64;
    pub const TRAVEL: u8 = 128;

    pub const COMMANDS: u8 = JUMP | TRIM | COLOR_CHANGE | STOP | END;
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Stitch {
    pub x: f64,
    pub y: f64,
    pub flags: u8,
    /// Index of the source object in the document (u32::MAX for none).
    pub object: u32,
}

impl Stitch {
    pub fn new(p: Point, flags: u8, object: u32) -> Stitch {
        Stitch { x: p.x, y: p.y, flags, object }
    }
    pub fn pos(&self) -> Point {
        Point { x: self.x, y: self.y }
    }
    pub fn is(&self, f: u8) -> bool {
        self.flags & f != 0
    }
    /// A real needle penetration.
    pub fn is_stitch(&self) -> bool {
        self.flags & flags::COMMANDS == 0
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct StitchPlan {
    pub stitches: Vec<Stitch>,
    /// Thread for each colour block, in sewing order.
    pub threads: Vec<Thread>,
    /// The records of the basting, `[start, end)`: stitched first and pulled
    /// out after sewing (the finished view leaves them out).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub basting: Option<(usize, usize)>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanStats {
    pub stitches: usize,
    pub jumps: usize,
    pub trims: usize,
    pub color_changes: usize,
    pub stops: usize,
    pub width: f64,
    pub height: f64,
    /// Top thread length in metres (incl. penetration allowance).
    pub thread_m: f64,
    /// Bobbin thread length in metres (estimate).
    pub bobbin_m: f64,
    /// Estimated sewing time in seconds.
    pub seconds: f64,
    /// Per colour block top-thread metres.
    pub thread_per_color_m: Vec<f64>,
    pub stitches_per_color: Vec<usize>,
}

impl StitchPlan {
    pub fn bounds(&self) -> Rect {
        let mut r = Rect::EMPTY;
        for s in &self.stitches {
            if s.is_stitch() {
                r.include(s.pos());
            }
        }
        r
    }

    /// Returns a copy where every movement (stitch or jump) longer than `max`
    /// is broken into evenly spaced shorter movements of the same kind.
    pub fn split_long_moves(&self, max: f64) -> StitchPlan {
        let mut out = Vec::with_capacity(self.stitches.len());
        let mut cur: Option<Point> = None;
        for s in &self.stitches {
            let moving = s.is_stitch() || s.is(flags::JUMP);
            if moving {
                if let Some(c) = cur {
                    let d = c.dist(s.pos());
                    if d > max {
                        let n = (d / max).ceil() as usize;
                        for k in 1..n {
                            let p = c.lerp(s.pos(), k as f64 / n as f64);
                            out.push(Stitch::new(p, s.flags, s.object));
                        }
                    }
                }
                cur = Some(s.pos());
            }
            out.push(*s);
        }
        StitchPlan { stitches: out, threads: self.threads.clone(), basting: None }
    }

    /// Translate so the design is centred on (0,0) — embroidery files are
    /// conventionally centred on the hoop.
    pub fn centered(&self) -> StitchPlan {
        let b = self.bounds();
        if b.is_empty() {
            return self.clone();
        }
        let c = b.center();
        let mut p = self.clone();
        for s in &mut p.stitches {
            s.x -= c.x;
            s.y -= c.y;
        }
        p
    }

    /// The design repeated at each offset (Ink/Stitch `StitchPlan.make_offsets`,
    /// ZIP export "panelization"): every colour block sews all its copies, a
    /// trim between them, and keeps its trailing commands once at the end.
    pub fn make_offsets(&self, offsets: &[Point]) -> StitchPlan {
        if offsets.len() <= 1 && offsets.first().map_or(true, |o| o.x == 0.0 && o.y == 0.0) {
            return self.clone();
        }
        let mut out = Vec::with_capacity(self.stitches.len() * offsets.len() + 16);
        let mut blocks: Vec<&[Stitch]> = self.stitches.split_inclusive(|s| s.is(flags::COLOR_CHANGE)).collect();
        if blocks.is_empty() {
            blocks.push(&[]);
        }
        for block in blocks {
            // the colour change itself and the trims / stops / end before it
            let mut body = block.len();
            while body > 0 && block[body - 1].flags & (flags::TRIM | flags::STOP | flags::END | flags::COLOR_CHANGE) != 0 {
                body -= 1;
            }
            if body == 0 {
                out.extend_from_slice(block);
                continue;
            }
            for (i, d) in offsets.iter().enumerate() {
                let first = block[0];
                // every copy starts with a move to its first stitch
                if !first.is(flags::JUMP) {
                    out.push(Stitch { x: first.x + d.x, y: first.y + d.y, flags: flags::JUMP, object: first.object });
                }
                out.extend(block[..body].iter().map(|s| Stitch { x: s.x + d.x, y: s.y + d.y, ..*s }));
                if i + 1 < offsets.len() {
                    let last = out[out.len() - 1];
                    out.push(Stitch { flags: flags::TRIM, ..last });
                }
            }
            // trailing commands at the last copy's end
            let last = out[out.len() - 1];
            out.extend(block[body..].iter().map(|s| Stitch { x: last.x, y: last.y, ..*s }));
        }
        StitchPlan { stitches: out, threads: self.threads.clone(), basting: None }
    }

    /// Ink/Stitch "stop position" (frame out): the frame moves to `p` before
    /// every stop, so the operator can reach the fabric (appliqué, puff foam).
    pub fn with_stop_position(&self, p: Point) -> StitchPlan {
        let mut out = Vec::with_capacity(self.stitches.len() + 8);
        for s in &self.stitches {
            if s.is(flags::STOP) {
                out.push(Stitch { x: p.x, y: p.y, flags: flags::JUMP, object: s.object });
                out.push(Stitch { x: p.x, y: p.y, ..*s });
            } else {
                out.push(*s);
            }
        }
        StitchPlan { stitches: out, threads: self.threads.clone(), basting: None }
    }

    /// Offsets of an x × y grid of repeats `dx`, `dy` apart (Ink/Stitch order:
    /// columns first).
    pub fn grid_offsets(x_repeats: u32, y_repeats: u32, dx: f64, dy: f64) -> Vec<Point> {
        let mut v = Vec::new();
        for x in 0..x_repeats.max(1) {
            for y in 0..y_repeats.max(1) {
                v.push(Point { x: x as f64 * dx, y: y as f64 * dy });
            }
        }
        v
    }

    /// Counts, size, time and thread. Thread follows Madeira (FAQ and the
    /// Madeira USA digitizing guide): ~5 m top thread and ~3–3.5 m bobbin per
    /// 1,000 standard stitches.
    pub fn stats(&self, spm: f64, trim_s: f64, color_s: f64) -> PlanStats {
        let mut st = PlanStats::default();
        let mut cur: Option<Point> = None;
        let mut block_len = 0.0;
        let mut block_count = 0usize;
        let mut total_len = 0.0;
        for s in &self.stitches {
            if s.is(flags::COLOR_CHANGE) {
                st.color_changes += 1;
                st.thread_per_color_m.push(block_len / 1000.0);
                st.stitches_per_color.push(block_count);
                block_len = 0.0;
                block_count = 0;
                continue;
            }
            if s.is(flags::TRIM) {
                st.trims += 1;
                continue;
            }
            if s.is(flags::STOP) {
                st.stops += 1;
                continue;
            }
            if s.is(flags::END) {
                continue;
            }
            if s.is(flags::JUMP) {
                st.jumps += 1;
                cur = Some(s.pos());
                continue;
            }
            st.stitches += 1;
            block_count += 1;
            if let Some(c) = cur {
                // Madeira: about 5 m of top thread per 1,000 stitches of
                // standard length; a longer stitch takes its own length
                // plus the loop through the fabric.
                let l = (c.dist(s.pos()) + LOOP_MM).max(TOP_PER_STITCH_MM);
                block_len += l;
                total_len += l;
            }
            cur = Some(s.pos());
        }
        st.thread_per_color_m.push(block_len / 1000.0);
        st.stitches_per_color.push(block_count);
        let b = self.bounds();
        st.width = b.width();
        st.height = b.height();
        st.thread_m = total_len / 1000.0;
        st.bobbin_m = st.thread_m * BOBBIN_SHARE;
        st.seconds = st.stitches as f64 / spm.max(1.0) * 60.0
            + st.trims as f64 * trim_s
            + st.color_changes as f64 * color_s
            + st.jumps as f64 * 0.05;
        st
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn st(x: f64, y: f64, f: u8) -> Stitch {
        Stitch { x, y, flags: f, object: 0 }
    }

    #[test]
    fn repeats_every_colour_block() {
        let plan = StitchPlan {
            stitches: vec![st(0.0, 0.0, flags::JUMP), st(0.0, 0.0, 0), st(1.0, 0.0, 0), st(1.0, 0.0, flags::TRIM), st(1.0, 0.0, flags::COLOR_CHANGE), st(5.0, 5.0, flags::JUMP), st(5.0, 5.0, 0), st(6.0, 5.0, 0), st(6.0, 5.0, flags::END)],
            threads: vec![],
            ..Default::default()
        };
        let r = plan.make_offsets(&StitchPlan::grid_offsets(2, 1, 10.0, 0.0));
        let f: Vec<(f64, u8)> = r.stitches.iter().map(|s| (s.x, s.flags)).collect();
        assert_eq!(
            f,
            vec![
                (0.0, flags::JUMP), (0.0, 0), (1.0, 0), (1.0, flags::TRIM),
                (10.0, flags::JUMP), (10.0, 0), (11.0, 0), (11.0, flags::TRIM), (11.0, flags::COLOR_CHANGE),
                (5.0, flags::JUMP), (5.0, 0), (6.0, 0), (6.0, flags::TRIM),
                (15.0, flags::JUMP), (15.0, 0), (16.0, 0), (16.0, flags::END),
            ]
        );
        assert_eq!(r.stats(800.0, 0.0, 0.0).stitches, 8);
        // 1 × 1: unchanged
        assert_eq!(plan.make_offsets(&StitchPlan::grid_offsets(1, 1, 100.0, 100.0)), plan);
    }

    #[test]
    fn frames_out_before_stops() {
        let plan = StitchPlan { stitches: vec![st(1.0, 1.0, 0), st(1.0, 1.0, flags::TRIM), st(1.0, 1.0, flags::STOP), st(2.0, 2.0, flags::JUMP), st(2.0, 2.0, 0)], threads: vec![], ..Default::default() };
        let r = plan.with_stop_position(Point { x: 50.0, y: -10.0 });
        let f: Vec<(f64, u8)> = r.stitches.iter().map(|s| (s.y, s.flags)).collect();
        assert_eq!(f, vec![(1.0, 0), (1.0, flags::TRIM), (-10.0, flags::JUMP), (-10.0, flags::STOP), (2.0, flags::JUMP), (2.0, 0)]);
    }
}
