//! Reader-side pattern builder and post-processing.
//!
//! Ported from pystitch, Ink/Stitch's embroidery file library (MIT, Copyright (c) 2018 Tatarize
//! and the Ink/Stitch contributors)
//! (`EmbPattern.interpolate_trims`, `interpolate_duplicate_color_as_stop`).

use crate::encoder::{Cmd, Rec, UNITS_PER_MM};
use crate::{cmd, default_thread, Pattern, Stitch, Thread};

/// Accumulates decoded records in integer format units (y down).
#[derive(Debug, Default)]
pub(crate) struct RawPattern {
    pub recs: Vec<Rec>,
    pub x: i32,
    pub y: i32,
    pub threads: Vec<Thread>,
    pub name: String,
    /// A stitch has been recorded.
    pub stitched: bool,
}

impl RawPattern {
    pub fn new() -> Self {
        Self::default()
    }

    fn push(&mut self, cmd: Cmd) {
        self.stitched |= cmd == Cmd::Stitch;
        self.recs.push(Rec {
            x: self.x,
            y: self.y,
            cmd,
        });
    }

    pub fn stitch(&mut self, dx: i32, dy: i32) {
        self.x += dx;
        self.y += dy;
        self.push(Cmd::Stitch);
    }

    pub fn jump(&mut self, dx: i32, dy: i32) {
        self.x += dx;
        self.y += dy;
        self.push(Cmd::Jump);
    }

    pub fn jump_abs(&mut self, x: i32, y: i32) {
        self.x = x;
        self.y = y;
        self.push(Cmd::Jump);
    }

    pub fn stitch_abs(&mut self, x: i32, y: i32) {
        self.x = x;
        self.y = y;
        self.push(Cmd::Stitch);
    }

    pub fn trim(&mut self) {
        self.push(Cmd::Trim);
    }

    pub fn color_change(&mut self) {
        self.push(Cmd::ColorChange);
    }

    /// pystitch `needle_change` (`NEEDLE_SET`): Ink/Stitch's import splits colour blocks
    /// at needle sets (`get_as_colorblocks`), so one before any stitching selects the
    /// first thread and every later one is a colour change.
    pub fn needle_change(&mut self) {
        if self.stitched {
            self.color_change();
        }
    }

    pub fn stop(&mut self) {
        self.push(Cmd::Stop);
    }

    /// pystitch `interpolate_trims`: a run of jumps after stitching gets a trim inserted
    /// at its start once it reaches `count_max` jumps or exceeds `distance` (format units,
    /// per axis). With `clipping`, jump runs with zero net displacement are removed.
    pub fn interpolate_trims(
        &mut self,
        count_max: Option<usize>,
        distance: Option<i32>,
        clipping: bool,
    ) {
        let s = &mut self.recs;
        let mut i: isize = -1;
        let mut ie: isize = s.len() as isize - 1;
        let (mut x, mut y) = (0i32, 0i32);
        let mut jump_count = 0usize;
        let mut jump_start = 0usize;
        let (mut jdx, mut jdy) = (0i32, 0i32);
        let mut jumping = false;
        let mut trimmed = true;
        while i < ie {
            i += 1;
            let r = s[i as usize];
            let dx = r.x - x;
            let dy = r.y - y;
            x = r.x;
            y = r.y;
            match r.cmd {
                Cmd::Stitch => {
                    trimmed = false;
                    jumping = false;
                }
                Cmd::ColorChange | Cmd::Trim => {
                    trimmed = true;
                    jumping = false;
                }
                _ => {}
            }
            if r.cmd != Cmd::Jump {
                continue;
            }
            if !jumping {
                jdx = 0;
                jdy = 0;
                jump_count = 0;
                jump_start = i as usize;
                jumping = true;
            }
            jump_count += 1;
            jdx += dx;
            jdy += dy;
            if !trimmed {
                let by_count = count_max == Some(jump_count);
                let by_dist = distance.is_some_and(|d| jdx.abs() > d || jdy.abs() > d);
                if by_count || by_dist {
                    let (px, py) = if jump_start == 0 {
                        (0, 0)
                    } else {
                        (s[jump_start - 1].x, s[jump_start - 1].y)
                    };
                    s.insert(
                        jump_start,
                        Rec {
                            x: px,
                            y: py,
                            cmd: Cmd::Trim,
                        },
                    );
                    jump_start += 1;
                    i += 1;
                    ie += 1;
                    trimmed = true;
                }
            }
            if clipping && jdx == 0 && jdy == 0 {
                s.drain(jump_start..=(i as usize));
                i = jump_start as isize - 1;
                ie = s.len() as isize - 1;
            }
        }
    }

    /// pystitch `interpolate_duplicate_color_as_stop`: a colour change between two
    /// identical consecutive threads is really a stop.
    pub fn duplicate_colors_as_stops(&mut self) {
        let mut thread_index = 0usize;
        let mut init_color = true;
        let mut last_change: Option<usize> = None;
        for pos in 0..self.recs.len() {
            match self.recs[pos].cmd {
                Cmd::Stitch => {
                    if init_color {
                        if thread_index >= self.threads.len() {
                            return;
                        }
                        if let (Some(lc), true) = (last_change, thread_index != 0) {
                            if self.threads[thread_index - 1].rgb == self.threads[thread_index].rgb
                            {
                                self.threads.remove(thread_index);
                                self.recs[lc].cmd = Cmd::Stop;
                            } else {
                                thread_index += 1;
                            }
                        } else {
                            thread_index += 1;
                        }
                        init_color = false;
                    }
                }
                Cmd::ColorChange => {
                    init_color = true;
                    last_change = Some(pos);
                }
                _ => {}
            }
        }
    }

    /// Finalizes: truncates after the first END and appends one, drops redundant trims,
    /// reconciles the thread list with the colour block count and converts to millimetres.
    pub fn finish(self) -> Pattern {
        self.finish_scaled(UNITS_PER_MM)
    }

    /// [`Self::finish`] for formats whose units are not 0.1 mm (`units_per_mm` file units per mm).
    pub fn finish_scaled(mut self, units_per_mm: f64) -> Pattern {
        if let Some(e) = self.recs.iter().position(|r| r.cmd == Cmd::End) {
            self.recs.truncate(e);
        }
        // Drop trims that cut nothing (no stitches since the last trim / colour change).
        let mut trimmed = true;
        self.recs.retain(|r| match r.cmd {
            Cmd::Stitch => {
                trimmed = false;
                true
            }
            Cmd::Trim | Cmd::ColorChange => {
                let keep = !(r.cmd == Cmd::Trim && trimmed);
                trimmed = true;
                keep
            }
            _ => true,
        });
        let (ex, ey) = self.recs.last().map_or((0, 0), |r| (r.x, r.y));
        self.recs.push(Rec {
            x: ex,
            y: ey,
            cmd: Cmd::End,
        });

        let has_stitches = self.recs.iter().any(|r| r.cmd == Cmd::Stitch);
        if has_stitches {
            let blocks = 1 + self
                .recs
                .iter()
                .filter(|r| r.cmd == Cmd::ColorChange)
                .count();
            self.threads.truncate(blocks);
            while self.threads.len() < blocks {
                let i = self.threads.len();
                self.threads.push(default_thread(i));
            }
        }

        let stitches = self
            .recs
            .iter()
            .map(|r| Stitch {
                x: r.x as f64 / units_per_mm,
                y: r.y as f64 / units_per_mm,
                flags: match r.cmd {
                    Cmd::Stitch => 0,
                    Cmd::Jump => cmd::JUMP,
                    Cmd::Trim => cmd::TRIM,
                    Cmd::ColorChange => cmd::COLOR_CHANGE,
                    Cmd::Stop => cmd::STOP,
                    Cmd::End => cmd::END,
                },
            })
            .collect();
        Pattern {
            stitches,
            threads: self.threads,
            name: self.name,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trim_sequence_becomes_trim() {
        let mut r = RawPattern::new();
        r.stitch(10, 10);
        r.jump(2, 2);
        r.jump(-4, -4);
        r.jump(2, 2);
        r.jump(50, 0);
        r.stitch(1, 0);
        r.interpolate_trims(Some(3), None, true);
        let cmds: Vec<Cmd> = r.recs.iter().map(|r| r.cmd).collect();
        assert_eq!(cmds, vec![Cmd::Stitch, Cmd::Trim, Cmd::Jump, Cmd::Stitch]);
        assert_eq!((r.recs[1].x, r.recs[1].y), (10, 10));
        assert_eq!((r.recs[2].x, r.recs[2].y), (60, 10));
    }

    #[test]
    fn finish_drops_redundant_trims_and_fills_threads() {
        let mut r = RawPattern::new();
        r.trim();
        r.stitch(1, 1);
        r.trim();
        r.jump(5, 5);
        r.trim();
        r.color_change();
        r.stitch(1, 1);
        let p = r.finish();
        let flags: Vec<u8> = p.stitches.iter().map(|s| s.flags).collect();
        assert_eq!(
            flags,
            vec![0, cmd::TRIM, cmd::JUMP, cmd::COLOR_CHANGE, 0, cmd::END]
        );
        assert_eq!(p.threads.len(), 2);
    }
}
