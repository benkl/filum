//! Pixel-art upscaling for the digitizer, after Kopf & Lischinski,
//! "Depixelizing Pixel Art" (SIGGRAPH 2011).
//!
//! Pixels of the same colour form a similarity graph (8-connected). Where
//! both diagonals of a 2×2 block connect, the paper's heuristics decide which
//! connection is real: the **curves** heuristic (the diagonal that is part of
//! a longer one-pixel-wide curve wins), **sparse pixels** (the colour that is
//! rarer in an 8×8 window is the foreground, so its diagonal wins) and
//! **islands** (never cut off a single pixel). Kept diagonals are then made
//! visible by reshaping the pixel cells: the corners of the two other pixels
//! are given to the diagonal, so the shared-boundary tracer sees a 45° edge
//! instead of a pinch — the smooth curves come from the tracer's fitting.

/// Upscale a label image by `k` (even, ≥ 4), joining diagonal connections.
pub fn upscale(labels: &[u8], w: usize, h: usize, k: usize) -> (Vec<u8>, usize, usize) {
    let at = |x: i64, y: i64| -> Option<u8> {
        if x < 0 || y < 0 || x >= w as i64 || y >= h as i64 {
            None
        } else {
            Some(labels[y as usize * w + x as usize])
        }
    };
    // valence in the similarity graph (8-neighbours of the same colour)
    let valence = |x: i64, y: i64| -> usize {
        let l = at(x, y);
        let mut n = 0;
        for dy in -1..=1 {
            for dx in -1..=1 {
                if (dx, dy) != (0, 0) && at(x + dx, y + dy) == l {
                    n += 1;
                }
            }
        }
        n
    };
    // length of the valence-2 curve through the edge a–b
    let curve_len = |a: (i64, i64), b: (i64, i64)| -> usize {
        let mut len = 1;
        for (start, from) in [(a, b), (b, a)] {
            let (mut cur, mut prev) = (start, from);
            let l = at(cur.0, cur.1);
            let mut guard = 0;
            while valence(cur.0, cur.1) == 2 && guard < 64 {
                guard += 1;
                let mut next = None;
                for dy in -1..=1 {
                    for dx in -1..=1 {
                        let c = (cur.0 + dx, cur.1 + dy);
                        if (dx, dy) != (0, 0) && c != prev && at(c.0, c.1) == l {
                            next = Some(c);
                        }
                    }
                }
                match next {
                    Some(n) if n != start => {
                        prev = cur;
                        cur = n;
                        len += 1;
                    }
                    _ => break,
                }
            }
        }
        len
    };
    let window_count = |x: i64, y: i64, l: u8| -> usize {
        let mut n = 0;
        for dy in -3..=4 {
            for dx in -3..=4 {
                if at(x + dx, y + dy) == Some(l) {
                    n += 1;
                }
            }
        }
        n
    };
    let (ww, hh) = (w * k, h * k);
    let mut out = vec![0u8; ww * hh];
    for y in 0..h {
        for x in 0..w {
            let l = labels[y * w + x];
            for sy in 0..k {
                for sx in 0..k {
                    out[(y * k + sy) * ww + x * k + sx] = l;
                }
            }
        }
    }
    // each 2×2 block: which diagonal (if any) connects
    for y in 0..h.saturating_sub(1) as i64 {
        for x in 0..w.saturating_sub(1) as i64 {
            let (a, b, c, d) = (at(x, y).unwrap(), at(x + 1, y).unwrap(), at(x, y + 1).unwrap(), at(x + 1, y + 1).unwrap());
            let main = a == d && a != b && a != c; // ↘ diagonal
            let anti = b == c && b != a && b != d; // ↙ diagonal
            let keep = match (main, anti) {
                (true, false) => Some(true),
                (false, true) => Some(false),
                (true, true) => {
                    // curves, sparse pixels, islands
                    let mut wm = 0i64;
                    let cm = curve_len((x, y), (x + 1, y + 1)) as i64;
                    let ca = curve_len((x + 1, y), (x, y + 1)) as i64;
                    wm += cm - ca;
                    let sm = window_count(x, y, a) as i64;
                    let sa = window_count(x, y, b) as i64;
                    wm += sa - sm; // the sparser colour is the foreground
                    if valence(x, y) == 1 || valence(x + 1, y + 1) == 1 {
                        wm += 5;
                    }
                    if valence(x + 1, y) == 1 || valence(x, y + 1) == 1 {
                        wm -= 5;
                    }
                    Some(wm >= 0)
                }
                _ => None,
            };
            let Some(is_main) = keep else { continue };
            // corners of the two other pixels around the block centre go to the diagonal
            let (cx, cy) = (((x + 1) as usize) * k, ((y + 1) as usize) * k);
            let lab = if is_main { a } else { b };
            let half = (k / 2) as i64;
            for dy in -half..half {
                for dx in -half..half {
                    // the triangle |dx|+|dy| < half around the centre, in the other two quadrants
                    let (qx, qy) = (dx >= 0, dy >= 0);
                    let other = if is_main { qx != qy } else { qx == qy };
                    let (ex, ey) = (if dx >= 0 { dx } else { -dx - 1 }, if dy >= 0 { dy } else { -dy - 1 });
                    if other && ex + ey < half {
                        let (px, py) = (cx as i64 + dx, cy as i64 + dy);
                        out[py as usize * ww + px as usize] = lab;
                    }
                }
            }
        }
    }
    (out, ww, hh)
}

/// Heuristic: does the image look like pixel art (a small sprite with few
/// exact colours and no anti-aliasing)?
pub fn looks_like_pixel_art(px: &[[u8; 4]], w: usize, h: usize) -> bool {
    if w.max(h) > 96 || w * h == 0 {
        return false;
    }
    let mut seen: Vec<[u8; 4]> = Vec::new();
    for p in px {
        if !seen.contains(p) {
            seen.push(*p);
            if seen.len() > 32 {
                return false;
            }
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn diagonal_line_becomes_connected() {
        // a one-pixel diagonal line of colour 1 on 0
        let (w, h) = (8, 8);
        let labels: Vec<u8> = (0..w * h).map(|i| u8::from(i % w == i / w)).collect();
        let (up, uw, _) = upscale(&labels, w, h, 8);
        // the block centre between (2,2) and (3,3) belongs to the line now
        assert_eq!(up[(3 * 8) * uw + 3 * 8 - 1], 1);
        assert_eq!(up[(3 * 8 - 1) * uw + 3 * 8], 1);
    }
}
