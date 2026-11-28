//! Stitch quality, read from the plan (not in Ink/Stitch): short stitches,
//! needle drops on a hole the same object made before, and spots where the
//! needle goes down more often than the fabric takes.
//!
//! The settings can look right while the stitches are not: a fill's travel
//! runs through a narrow part of its shape again and again, on the same
//! holes; a traced line turns at every pixel. See docs/STITCH_QUALITY_PLAN.md.
//!
//! Left out on purpose: lock stitches (they sew on their own holes) and bean
//! stitches (they go back and forth through the same holes by design).

use std::collections::HashMap;

use serde::Serialize;

use crate::model::{Document, StitchParams};
use crate::plan::{flags, StitchPlan};

/// A stitch shorter than this is short (mm): about where two holes read as one.
pub const SHORT_STITCH: f64 = 0.5;
/// A running stitch under this is short for a line (mm): the safe minimum of
/// embroidery practice; a line that turns at every pixel sews mostly in these.
pub const SHORT_LINE_STITCH: f64 = 1.0;
/// A needle drop this close to an earlier one lands in its hole (mm).
pub const SAME_HOLE: f64 = 0.15;
/// Needle drops are counted within this radius for the hot spots (mm).
pub const HOT_RADIUS: f64 = 0.5;
/// A fill narrower than this gets no underlay from automatic underlay
/// (`stitches::underlay`, ordinary fabrics): a set underlay can't sit under
/// its rows and only adds holes along both edges (mm).
pub const NARROW_FILL: f64 = 2.5;
/// Up to this width automatic underlay sews an edge run only (mm; 8 on
/// ordinary fabrics, 12 on delicate ones): the fills reported with their width.
pub const EDGE_RUN_FILL: f64 = 12.0;
/// Hot spots closer than this to a worse one are the same spot (mm).
const HOT_SEPARATION: f64 = 2.0;
/// At most this many hot spots are reported, worst first.
const MAX_HOT_SPOTS: usize = 20;

/// What kind of stitch a needle drop belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Top,
    Underlay,
    Travel,
    Tie,
}

fn kind(f: u8) -> Kind {
    if f & flags::TIE != 0 {
        Kind::Tie
    } else if f & flags::TRAVEL != 0 {
        Kind::Travel
    } else if f & flags::UNDERLAY != 0 {
        Kind::Underlay
    } else {
        Kind::Top
    }
}

/// One object's share.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ObjectQuality {
    /// Index of the object in the document.
    pub index: usize,
    pub drops: usize,
    /// Stitches shorter than [`SHORT_STITCH`].
    pub short: usize,
    /// Stitches shorter than [`SHORT_LINE_STITCH`].
    pub under_1mm: usize,
    /// Needle drops on a hole the object made before.
    pub rehits: usize,
    /// Of those, travel stitches.
    pub travel_rehits: usize,
}

/// Where the needle goes down more often than the fabric takes.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct HotSpot {
    pub at: [f64; 2],
    /// Needle drops per mm² within [`HOT_RADIUS`].
    pub per_mm2: f64,
    /// The object with most drops there (index), then the others.
    pub objects: Vec<usize>,
    /// Each one's drops there, in the same order.
    pub shares: Vec<usize>,
    /// Drops there by kind.
    pub top: usize,
    pub underlay: usize,
    pub travel: usize,
    pub ties: usize,
}

/// A fill narrower than [`EDGE_RUN_FILL`].
#[derive(Debug, Clone, PartialEq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct NarrowFill {
    pub index: usize,
    /// Twice the radius of the largest circle inside it (mm).
    pub width: f64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct StitchQuality {
    /// Needle drops of the design's objects.
    pub drops: usize,
    pub short: usize,
    pub rehits: usize,
    pub travel_rehits: usize,
    /// The fabric's needle holes per mm² (`Fabric::limits().holes_max`).
    pub hole_limit: f64,
    /// The objects with short stitches or re-hit holes.
    pub objects: Vec<ObjectQuality>,
    /// Worst first.
    pub hot_spots: Vec<HotSpot>,
    /// Visible fills narrower than [`EDGE_RUN_FILL`], with their width.
    pub narrow_fills: Vec<NarrowFill>,
}

/// The fills narrower than [`EDGE_RUN_FILL`]. Twice the area over the
/// perimeter is a lower bound of the width (a strip's width, half a
/// circle's), so only the fills under the limit by it are measured.
fn narrow_fills(doc: &Document) -> Vec<NarrowFill> {
    doc.objects
        .iter()
        .enumerate()
        .filter(|(_, o)| o.visible && matches!(o.stitch, StitchParams::Fill(_)))
        .filter_map(|(index, o)| {
            let rings: Vec<Vec<crate::geom::Point>> = o.paths.iter().filter(|p| p.closed).map(|p| p.flatten(0.05)).filter(|r| r.len() >= 3).collect();
            let area: f64 = rings.iter().map(|r| crate::geom::signed_area(r)).sum::<f64>().abs();
            let perimeter: f64 = rings.iter().map(|r| crate::geom::polyline_length(r) + r[0].dist(r[r.len() - 1])).sum();
            if perimeter <= 0.0 || 2.0 * area / perimeter >= EDGE_RUN_FILL {
                return None;
            }
            let width = crate::stitches::underlay::shape_width(&rings);
            (width > 0.0 && width < EDGE_RUN_FILL).then_some(NarrowFill { index, width })
        })
        .collect()
}

/// Does the object sew through its own holes on purpose (bean stitch)?
fn beans(p: &StitchParams) -> bool {
    match p {
        StitchParams::Running(r) => r.beans().iter().any(|b| *b > 0),
        StitchParams::Manual(m) => m.bean_pattern.iter().any(|b| *b > 0),
        _ => false,
    }
}

/// A grid of points for "within r" questions.
struct Grid {
    r: f64,
    cells: HashMap<(i64, i64), Vec<usize>>,
}

impl Grid {
    fn new(r: f64) -> Self {
        Grid { r, cells: HashMap::new() }
    }
    fn cell(&self, x: f64, y: f64) -> (i64, i64) {
        ((x / self.r).floor() as i64, (y / self.r).floor() as i64)
    }
    fn add(&mut self, x: f64, y: f64, i: usize) {
        let c = self.cell(x, y);
        self.cells.entry(c).or_default().push(i);
    }
    /// The indices in the cells around (x, y): every point within r is among them.
    fn near(&self, x: f64, y: f64) -> impl Iterator<Item = usize> + '_ {
        let (cx, cy) = self.cell(x, y);
        (-1..=1).flat_map(move |dx| (-1..=1).flat_map(move |dy| self.cells.get(&(cx + dx, cy + dy)).into_iter().flatten().copied()))
    }
}

/// The plan's stitch quality.
pub fn stitch_quality(doc: &Document, plan: &StitchPlan) -> StitchQuality {
    let n = doc.objects.len();
    let bean: Vec<bool> = doc.objects.iter().map(|o| beans(&o.stitch)).collect();
    // the needle drops of the design's objects, in sewing order
    let drops: Vec<(f64, f64, usize, Kind)> = plan.stitches.iter().filter(|s| s.is_stitch() && (s.object as usize) < n).map(|s| (s.x, s.y, s.object as usize, kind(s.flags))).collect();
    let mut per: Vec<ObjectQuality> = (0..n).map(|index| ObjectQuality { index, ..Default::default() }).collect();
    let mut holes = Grid::new(SAME_HOLE);
    let mut prev: Option<(f64, f64, usize, Kind)> = None;
    for (i, &(x, y, o, k)) in drops.iter().enumerate() {
        per[o].drops += 1;
        if !bean[o] && k != Kind::Tie {
            if let Some((px, py, po, pk)) = prev {
                let d = (x - px).hypot(y - py);
                if po == o && pk != Kind::Tie && d < SHORT_LINE_STITCH {
                    per[o].under_1mm += 1;
                    if d < SHORT_STITCH {
                        per[o].short += 1;
                    }
                }
            }
            if holes.near(x, y).any(|j| drops[j].2 == o && drops[j].3 != Kind::Tie && (drops[j].0 - x).hypot(drops[j].1 - y) < SAME_HOLE) {
                per[o].rehits += 1;
                if k == Kind::Travel {
                    per[o].travel_rehits += 1;
                }
            }
            holes.add(x, y, i);
        }
        prev = Some((x, y, o, k));
    }

    // hot spots: drops within the radius, beyond the fabric's limit (bean stitches reuse their holes)
    let limit = doc.fabric.limits().holes_max;
    let area = std::f64::consts::PI * HOT_RADIUS * HOT_RADIUS;
    let mut grid = Grid::new(HOT_RADIUS);
    let counted: Vec<usize> = (0..drops.len()).filter(|&i| !bean[drops[i].2]).collect();
    for &i in &counted {
        grid.add(drops[i].0, drops[i].1, i);
    }
    let drops = &drops;
    let grid = &grid;
    let within = |x: f64, y: f64| grid.near(x, y).filter(move |&j| (drops[j].0 - x).hypot(drops[j].1 - y) < HOT_RADIUS);
    let mut dense: Vec<(usize, usize)> = counted.iter().map(|&i| (within(drops[i].0, drops[i].1).count(), i)).filter(|&(c, _)| c as f64 / area > limit).collect();
    dense.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
    let mut hot_spots: Vec<HotSpot> = Vec::new();
    for (c, i) in dense {
        let (x, y) = (drops[i].0, drops[i].1);
        if hot_spots.iter().any(|h| (h.at[0] - x).hypot(h.at[1] - y) < HOT_SEPARATION) {
            continue;
        }
        let mut by_obj: HashMap<usize, usize> = HashMap::new();
        let mut h = HotSpot { at: [x, y], per_mm2: c as f64 / area, objects: vec![], shares: vec![], top: 0, underlay: 0, travel: 0, ties: 0 };
        for j in within(x, y) {
            *by_obj.entry(drops[j].2).or_default() += 1;
            match drops[j].3 {
                Kind::Top => h.top += 1,
                Kind::Underlay => h.underlay += 1,
                Kind::Travel => h.travel += 1,
                Kind::Tie => h.ties += 1,
            }
        }
        let mut objs: Vec<(usize, usize)> = by_obj.into_iter().collect();
        objs.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
        h.shares = objs.iter().map(|(_, n)| *n).collect();
        h.objects = objs.into_iter().map(|(o, _)| o).collect();
        hot_spots.push(h);
        if hot_spots.len() >= MAX_HOT_SPOTS {
            break;
        }
    }

    StitchQuality {
        drops: drops.len(),
        short: per.iter().map(|o| o.short).sum(),
        rehits: per.iter().map(|o| o.rehits).sum(),
        travel_rehits: per.iter().map(|o| o.travel_rehits).sum(),
        hole_limit: limit,
        objects: per.into_iter().filter(|o| o.under_1mm > 0 || o.rehits > 0).collect(),
        hot_spots,
        narrow_fills: narrow_fills(doc),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geom::pt;
    use crate::model::*;
    use crate::plan::Stitch;

    fn plan(pts: &[(f64, f64, u8, u32)]) -> StitchPlan {
        StitchPlan { stitches: pts.iter().map(|&(x, y, f, o)| Stitch { x, y, flags: f, object: o }).collect(), threads: vec![], basting: None, links: vec![] }
    }

    fn doc(stitches: Vec<StitchParams>) -> Document {
        let d = Document {
            objects: stitches
            .into_iter()
            .enumerate()
            .map(|(i, stitch)| Object { id: format!("o{i}"), name: format!("o{i}"), thread: "t".into(), paths: vec![SubPath::polyline(&[pt(0.0, 0.0), pt(1.0, 0.0)], false)], stitch, ..serde_json::from_str(r#"{"id":"x","thread":"t","paths":[]}"#).unwrap() })
            .collect(),
            ..Default::default()
        };
        d
    }

    #[test]
    fn short_stitches_and_holes_hit_again() {
        let run = || StitchParams::Running(RunningParams::default());
        let d = doc(vec![run(), run()]);
        // object 0: 0 → 0.3 (short) → 3 → back to 0.05 (its first hole) → 6; object 1 goes through 3 (not its own hole)
        let p = plan(&[(0.0, 0.0, 0, 0), (0.3, 0.0, 0, 0), (3.0, 0.0, 0, 0), (0.05, 0.0, flags::TRAVEL, 0), (6.0, 0.0, 0, 0), (3.0, 0.02, 0, 1)]);
        let q = stitch_quality(&d, &p);
        assert_eq!(q.drops, 6);
        assert_eq!((q.short, q.rehits, q.travel_rehits), (1, 1, 1));
        assert_eq!(q.objects.len(), 1, "object 1 lands on object 0's hole, not its own: {:?}", q.objects);
    }

    #[test]
    fn lock_and_bean_stitches_are_left_out() {
        let bean = StitchParams::Running(RunningParams { bean_repeats: 2, ..Default::default() });
        let d = doc(vec![bean, StitchParams::Running(RunningParams::default())]);
        let p = plan(&[
            // a bean stitch: there and back
            (0.0, 0.0, 0, 0),
            (2.0, 0.0, 0, 0),
            (0.0, 0.0, 0, 0),
            (2.0, 0.0, 0, 0),
            // a lock stitch: back and forth on its own holes
            (10.0, 0.0, flags::TIE, 1),
            (10.3, 0.0, flags::TIE, 1),
            (10.0, 0.0, flags::TIE, 1),
            (13.0, 0.0, 0, 1),
        ]);
        let q = stitch_quality(&d, &p);
        assert_eq!((q.short, q.rehits), (0, 0), "{q:?}");
    }

    #[test]
    fn a_hot_spot_names_the_object_and_the_kind_of_stitches() {
        let fill = || StitchParams::Fill(FillParams::default());
        let d = doc(vec![fill(), fill()]);
        // 20 travel drops of object 1 around one point (cotton takes 17 per mm², 13 within 0.5 mm), a few of object 0
        let mut pts: Vec<(f64, f64, u8, u32)> = (0..20).map(|k| (5.0 + 0.02 * k as f64, 5.0 + 0.01 * (k % 3) as f64, flags::TRAVEL, 1)).collect();
        pts.extend([(5.1, 5.2, 0, 0), (5.2, 5.0, 0, 0)]);
        pts.extend((0..10).map(|k| (40.0 + k as f64 * 2.0, 0.0, 0, 0)));
        let q = stitch_quality(&d, &plan(&pts));
        assert_eq!(q.hot_spots.len(), 1, "{:?}", q.hot_spots);
        let h = &q.hot_spots[0];
        assert!(h.per_mm2 > 17.0 && h.objects[0] == 1 && h.travel == 20, "{h:?}");
        assert!((h.at[0] - 5.2).abs() < 0.5 && (h.at[1] - 5.0).abs() < 0.5);
    }

    #[test]
    fn narrow_fills_are_found_by_their_width() {
        let fill = || StitchParams::Fill(FillParams::default());
        let mut d = doc(vec![fill(), fill(), fill()]);
        let rect = |w: f64, h: f64| vec![SubPath::polyline(&[pt(0.0, 0.0), pt(w, 0.0), pt(w, h), pt(0.0, h)], true)];
        // a 1.2 × 20 mm strip, a 2 mm square, a 20 mm square (wider than any fabric's edge-run width)
        d.objects[0].paths = rect(20.0, 1.2);
        d.objects[1].paths = rect(2.0, 2.0);
        d.objects[2].paths = rect(20.0, 20.0);
        let q = stitch_quality(&d, &plan(&[]));
        let found: Vec<usize> = q.narrow_fills.iter().map(|n| n.index).collect();
        assert_eq!(found, vec![0, 1], "{:?}", q.narrow_fills);
        assert!((q.narrow_fills[0].width - 1.2).abs() < 0.2, "{:?}", q.narrow_fills[0]);
    }
}
