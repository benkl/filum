//! SVG interop with Inkscape + Ink/Stitch.
//!
//! *Import* reads plain SVG artwork **and** Ink/Stitch-annotated SVG: the
//! `inkstitch:*` attributes (namespace `http://inkstitch.org/namespace`) are
//! mapped to Filum stitch params (satin columns, fill methods, underlay,
//! running/bean/manual/zig-zag strokes, trims and stops, meander tiles), plus
//! Ink/Stitch commands (start / end / target positions, trim, stop, ignore
//! object / layer) and guide-line markers.
//!
//! *Export* writes an SVG (user unit = mm) that Ink/Stitch understands, plus a
//! `filum:params` attribute for lossless round-trips of features
//! Ink/Stitch does not have. Start, end and target positions are written as
//! Ink/Stitch commands, guide lines with the Ink/Stitch marker.

use std::collections::HashMap;
use std::str::FromStr;

use crate::geom::{offset_polyline, pt, Point, Ring};
use crate::model::*;

pub const INKSTITCH_NS: &str = "http://inkstitch.org/namespace";
pub const FILUM_NS: &str = "https://github.com/benkl/filum#namespace";
const SVG_NS: &str = "http://www.w3.org/2000/svg";
const INKSCAPE_NS: &str = "http://www.inkscape.org/namespaces/inkscape";
const XLINK_NS: &str = "http://www.w3.org/1999/xlink";

/// Ink/Stitch command symbols and markers (`symbols/*.svg`, GPL-3.0-or-later),
/// copied into exported SVGs that use them.
const INKSTITCH_SYMBOLS: &str = include_str!("../assets/inkstitch/inkstitch.svg");
const INKSTITCH_MARKERS: &str = include_str!("../assets/inkstitch/marker.svg");

/// A command (`<use xlink:href="#inkstitch_trim">`): its name.
fn command_of<'a>(n: roxmltree::Node<'a, 'a>) -> Option<&'a str> {
    if !n.is_element() || n.tag_name().name() != "use" {
        return None;
    }
    n.attribute((XLINK_NS, "href")).or_else(|| n.attribute("href"))?.strip_prefix("#inkstitch_")
}

/// Command connectors and other Inkscape connector lines.
fn is_connector(n: roxmltree::Node) -> bool {
    n.attribute((INKSCAPE_NS, "connection-start")).is_some()
        || n.attribute((INKSCAPE_NS, "connection-end")).is_some()
        || n.attribute((INKSCAPE_NS, "connector-type")).is_some()
}

/// Ink/Stitch marker of a path (`marker-start:url(#inkstitch-guide-line-marker)`):
/// "guide-line", "pattern" or "anchor-line".
fn marker_of<'a>(n: roxmltree::Node<'a, 'a>) -> Option<&'a str> {
    const KEY: &str = "marker-start:url(#inkstitch-";
    let style = n.attribute("style").unwrap_or("");
    let rest = &style[style.find(KEY)? + KEY.len()..];
    Some(&rest[..rest.find("-marker")?])
}

/// The transform of a node including its own (`composed_transform` in inkex).
fn composed_tf(n: roxmltree::Node) -> Affine {
    let mut chain = Vec::new();
    let mut cur = Some(n);
    while let Some(c) = cur {
        if let Some(t) = c.attribute("transform") {
            chain.push(parse_transform(t));
        }
        cur = c.parent();
    }
    chain.iter().rev().fold(Affine::IDENTITY, |acc, t| acc.mul(*t))
}

/// Object commands by target id (Ink/Stitch `lib/commands.py`): a connector
/// links a command symbol to its object; the command's point is the symbol's
/// position.
fn object_commands(xml: &roxmltree::Document, root_tf: Affine) -> HashMap<String, Vec<(String, [f64; 2])>> {
    let by_id: HashMap<&str, roxmltree::Node> = xml.descendants().filter(|n| n.is_element()).filter_map(|n| Some((n.attribute("id")?, n))).collect();
    let mut out: HashMap<String, Vec<(String, [f64; 2])>> = HashMap::new();
    for c in xml.descendants().filter(|n| n.is_element()) {
        let (Some(a), Some(b)) = (c.attribute((INKSCAPE_NS, "connection-start")), c.attribute((INKSCAPE_NS, "connection-end"))) else { continue };
        let (Some(&a), Some(&b)) = (by_id.get(a.trim_start_matches('#')), by_id.get(b.trim_start_matches('#'))) else { continue };
        let (sym, target) = if command_of(a).is_some() {
            (a, b)
        } else if command_of(b).is_some() {
            (b, a)
        } else {
            continue;
        };
        let num = |k: &str| sym.attribute(k).and_then(|v| v.trim().parse::<f64>().ok()).unwrap_or(0.0);
        let p = root_tf.mul(composed_tf(sym)).apply(pt(num("x"), num("y")));
        if let (Some(cmd), Some(id)) = (command_of(sym), target.attribute("id")) {
            out.entry(id.to_string()).or_default().push((cmd.to_string(), [p.x, p.y]));
        }
    }
    out
}

/// Apply Ink/Stitch commands to an imported object.
fn apply_commands(o: &mut Object, cmds: &[(String, [f64; 2])]) {
    let b = o.bounds();
    for (c, p) in cmds {
        match c.as_str() {
            "starting_point" => o.start = Some(*p),
            "ending_point" => o.end = Some(*p),
            "trim" => o.trim_after = true,
            "stop" => o.stop_after = true,
            "target_point" => match &mut o.stitch {
                StitchParams::Running(RunningParams { ripple: Some(r), .. }) => r.target = Some(*p),
                StitchParams::Fill(f) if f.method == FillMethod::Circular && b.width() > 0.0 && b.height() > 0.0 => {
                    f.center = [(p[0] - b.min_x) / b.width(), (p[1] - b.min_y) / b.height()];
                }
                _ => {}
            },
            _ => {}
        }
    }
}

#[derive(Debug, Default, Clone, serde::Serialize)]
pub struct SvgImport {
    pub document: Document,
    pub warnings: Vec<String>,
    /// `<text>` elements, for the editor to set as lettering.
    pub texts: Vec<SvgText>,
}

/// An SVG `<text>` (mm): its lines, where its baseline starts, its size and colour.
#[derive(Debug, Default, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SvgText {
    pub text: String,
    pub x: f64,
    pub y: f64,
    /// Font size (mm).
    pub size: f64,
    pub color: String,
    pub font: Option<String>,
    /// "start", "middle" or "end".
    pub anchor: String,
    /// Index in the document's objects where it sits in the sewing order.
    pub index: usize,
    /// Document order among clones and texts at one index.
    #[serde(skip)]
    seq: usize,
}

#[derive(Clone, Copy, Debug)]
struct Affine([f64; 6]);

impl Affine {
    const IDENTITY: Affine = Affine([1.0, 0.0, 0.0, 1.0, 0.0, 0.0]);
    fn mul(self, o: Affine) -> Affine {
        let [a, b, c, d, e, f] = self.0;
        let [a2, b2, c2, d2, e2, f2] = o.0;
        Affine([
            a * a2 + c * b2,
            b * a2 + d * b2,
            a * c2 + c * d2,
            b * c2 + d * d2,
            a * e2 + c * f2 + e,
            b * e2 + d * f2 + f,
        ])
    }
    fn apply(self, p: Point) -> Point {
        let [a, b, c, d, e, f] = self.0;
        pt(a * p.x + c * p.y + e, b * p.x + d * p.y + f)
    }
    fn scale_factor(self) -> f64 {
        let [a, b, c, d, _, _] = self.0;
        ((a * d - b * c).abs()).sqrt()
    }
    fn inverse(self) -> Affine {
        let [a, b, c, d, e, f] = self.0;
        let det = a * d - b * c;
        if det.abs() < 1e-12 {
            return Affine::IDENTITY;
        }
        let (ia, ib, ic, id) = (d / det, -b / det, -c / det, a / det);
        Affine([ia, ib, ic, id, -(ia * e + ic * f), -(ib * e + id * f)])
    }
}

fn parse_transform(s: &str) -> Affine {
    match svgtypes::Transform::from_str(s) {
        Ok(t) => Affine([t.a, t.b, t.c, t.d, t.e, t.f]),
        Err(_) => Affine::IDENTITY,
    }
}

fn parse_length_mm(s: &str) -> Option<f64> {
    let l = svgtypes::Length::from_str(s).ok()?;
    use svgtypes::LengthUnit::*;
    Some(match l.unit {
        Mm => l.number,
        Cm => l.number * 10.0,
        In => l.number * 25.4,
        Pt => l.number * 25.4 / 72.0,
        Pc => l.number * 25.4 / 6.0,
        None | Px => l.number * 25.4 / 96.0,
        _ => return Option::None,
    })
}

fn parse_color(s: &str) -> Option<[u8; 3]> {
    let s = s.trim();
    if s.is_empty() || s == "none" || s == "transparent" {
        return None;
    }
    if s.starts_with("url(") {
        return Some([0x1c, 0x1c, 0x1c]);
    }
    svgtypes::Color::from_str(s).ok().map(|c| [c.red, c.green, c.blue])
}

#[derive(Clone, Default)]
struct Style {
    /// `fill:url(#id)`: the paint server's id.
    fill_url: Option<String>,
    fill: Option<Option<[u8; 3]>>,
    stroke: Option<Option<[u8; 3]>>,
    stroke_width: Option<f64>,
    display_none: bool,
}

fn read_style(node: roxmltree::Node, parent: &Style) -> Style {
    let mut st = parent.clone();
    st.display_none = false;
    let mut props: Vec<(String, String)> = Vec::new();
    for a in node.attributes() {
        if a.namespace().is_none() {
            props.push((a.name().to_string(), a.value().to_string()));
        }
    }
    if let Some(style) = node.attribute("style") {
        for decl in style.split(';') {
            if let Some((k, v)) = decl.split_once(':') {
                props.push((k.trim().to_string(), v.trim().to_string()));
            }
        }
    }
    for (k, v) in props {
        match k.as_str() {
            "fill" => {
                st.fill_url = v.trim().strip_prefix("url(#").and_then(|r| r.split(')').next()).map(|s| s.trim_matches(['"', '\'']).to_string());
                st.fill = Some(parse_color(&v));
            }
            "stroke" => st.stroke = Some(parse_color(&v)),
            "stroke-width" => st.stroke_width = v.trim_end_matches("px").parse().ok(),
            "display" if v == "none" => st.display_none = true,
            "visibility" if v == "hidden" => st.display_none = true,
            _ => {}
        }
    }
    st
}

fn path_to_subpaths(d: &str, tf: Affine) -> Vec<SubPath> {
    use svgtypes::SimplePathSegment as S;
    let mut out: Vec<SubPath> = Vec::new();
    let mut cur: Option<SubPath> = None;
    let mut last = pt(0.0, 0.0);
    let flush = |cur: &mut Option<SubPath>, out: &mut Vec<SubPath>| {
        if let Some(sp) = cur.take() {
            if sp.nodes.len() >= 2 || (sp.nodes.len() == 1 && sp.closed) {
                out.push(sp);
            }
        }
    };
    for seg in svgtypes::SimplifyingPathParser::from(d) {
        let Ok(seg) = seg else { break };
        match seg {
            S::MoveTo { x, y } => {
                flush(&mut cur, &mut out);
                last = pt(x, y);
                cur = Some(SubPath { nodes: vec![Node { p: tf.apply(last).arr(), i: None, o: None }], closed: false });
            }
            S::LineTo { x, y } => {
                last = pt(x, y);
                if let Some(sp) = cur.as_mut() {
                    sp.nodes.push(Node { p: tf.apply(last).arr(), i: None, o: None });
                }
            }
            S::CurveTo { x1, y1, x2, y2, x, y } => {
                if let Some(sp) = cur.as_mut() {
                    if let Some(prev) = sp.nodes.last_mut() {
                        prev.o = Some(tf.apply(pt(x1, y1)).arr());
                    }
                    sp.nodes.push(Node { p: tf.apply(pt(x, y)).arr(), i: Some(tf.apply(pt(x2, y2)).arr()), o: None });
                }
                last = pt(x, y);
            }
            S::Quadratic { x1, y1, x, y } => {
                let q = pt(x1, y1);
                let end = pt(x, y);
                let c1 = last + (q - last) * (2.0 / 3.0);
                let c2 = end + (q - end) * (2.0 / 3.0);
                if let Some(sp) = cur.as_mut() {
                    if let Some(prev) = sp.nodes.last_mut() {
                        prev.o = Some(tf.apply(c1).arr());
                    }
                    sp.nodes.push(Node { p: tf.apply(end).arr(), i: Some(tf.apply(c2).arr()), o: None });
                }
                last = end;
            }
            S::ClosePath => {
                if let Some(sp) = cur.as_mut() {
                    sp.closed = true;
                    // drop a duplicated closing node (keep its incoming handle on the first node)
                    if sp.nodes.len() > 1 {
                        let f = sp.nodes[0].p;
                        let l = *sp.nodes.last().unwrap();
                        if (l.p[0] - f[0]).abs() < 1e-9 && (l.p[1] - f[1]).abs() < 1e-9 {
                            sp.nodes.pop();
                            if l.i.is_some() {
                                sp.nodes[0].i = l.i;
                            }
                        }
                    }
                    last = Point::from_arr(sp.nodes[0].p);
                    let start = sp.nodes[0];
                    flush(&mut cur, &mut out);
                    // a following segment without MoveTo starts at the same point
                    cur = Some(SubPath { nodes: vec![Node { p: start.p, i: None, o: None }], closed: false });
                    // inverse-transform not needed: `last` is only used for quadratic control points
                    last = tf_inverse_hint(last);
                }
            }
        }
    }
    flush(&mut cur, &mut out);
    out
}

// `last` after ClosePath is in transformed space; quadratic curves right after a
// close are rare, so we keep the transformed value (harmless approximation).
fn tf_inverse_hint(p: Point) -> Point {
    p
}

fn ellipse_subpath(cx: f64, cy: f64, rx: f64, ry: f64, tf: Affine) -> SubPath {
    const K: f64 = 0.552_284_749_8;
    let pts = [(1.0, 0.0), (0.0, 1.0), (-1.0, 0.0), (0.0, -1.0)];
    let nodes = pts
        .iter()
        .map(|(x, y)| {
            let p = pt(cx + rx * x, cy + ry * y);
            // tangent direction (counter-clockwise in y-down = clockwise visually)
            let t = pt(-y * rx * K, x * ry * K);
            Node { p: tf.apply(p).arr(), i: Some(tf.apply(p - t).arr()), o: Some(tf.apply(p + t).arr()) }
        })
        .collect();
    SubPath { nodes, closed: true }
}

fn num(node: roxmltree::Node, name: &str) -> f64 {
    node.attribute(name).and_then(|v| svgtypes::Length::from_str(v).ok()).map(|l| l.number).unwrap_or(0.0)
}

fn shape_subpaths(node: roxmltree::Node, tf: Affine) -> Vec<SubPath> {
    match node.tag_name().name() {
        "path" => node.attribute("d").map(|d| path_to_subpaths(d, tf)).unwrap_or_default(),
        "rect" => {
            let (x, y, w, h) = (num(node, "x"), num(node, "y"), num(node, "width"), num(node, "height"));
            if w <= 0.0 || h <= 0.0 {
                return vec![];
            }
            let pts = [pt(x, y), pt(x + w, y), pt(x + w, y + h), pt(x, y + h)];
            vec![SubPath::polyline(&pts.map(|p| tf.apply(p)), true)]
        }
        "circle" => {
            let r = num(node, "r");
            if r <= 0.0 {
                return vec![];
            }
            vec![ellipse_subpath(num(node, "cx"), num(node, "cy"), r, r, tf)]
        }
        "ellipse" => {
            let (rx, ry) = (num(node, "rx"), num(node, "ry"));
            if rx <= 0.0 || ry <= 0.0 {
                return vec![];
            }
            vec![ellipse_subpath(num(node, "cx"), num(node, "cy"), rx, ry, tf)]
        }
        "line" => {
            let pts = [pt(num(node, "x1"), num(node, "y1")), pt(num(node, "x2"), num(node, "y2"))];
            vec![SubPath::polyline(&pts.map(|p| tf.apply(p)), false)]
        }
        "polyline" | "polygon" => {
            let nums: Vec<f64> = node
                .attribute("points")
                .unwrap_or("")
                .split(|c: char| c == ',' || c.is_whitespace())
                .filter_map(|s| s.parse().ok())
                .collect();
            let pts: Vec<Point> = nums.chunks_exact(2).map(|c| tf.apply(pt(c[0], c[1]))).collect();
            if pts.len() < 2 {
                return vec![];
            }
            vec![SubPath::polyline(&pts, node.tag_name().name() == "polygon")]
        }
        _ => vec![],
    }
}

struct Ink<'a> {
    attrs: HashMap<&'a str, &'a str>,
}

impl<'a> Ink<'a> {
    fn new(node: roxmltree::Node<'a, 'a>) -> Ink<'a> {
        let attrs = node.attributes().filter(|a| a.namespace() == Some(INKSTITCH_NS)).map(|a| (a.name(), a.value())).collect();
        Ink { attrs }
    }
    fn has_any(&self) -> bool {
        !self.attrs.is_empty()
    }
    fn get(&self, k: &str) -> Option<&str> {
        self.attrs.get(k).copied().filter(|v| !v.trim().is_empty())
    }
    fn f(&self, k: &str, d: f64) -> f64 {
        // nan / inf / 1e400 parse as floats but can't go through JSON
        self.get(k).and_then(|v| v.trim().split_whitespace().next()?.parse().ok()).filter(|v: &f64| v.is_finite()).unwrap_or(d)
    }
    fn b(&self, k: &str, d: bool) -> bool {
        match self.get(k).map(|v| v.to_ascii_lowercase()) {
            Some(v) => v == "true" || v == "1" || v == "yes",
            None => d,
        }
    }
    fn u(&self, k: &str, d: u32) -> u32 {
        self.f(k, d as f64).max(0.0) as u32
    }
    /// All numbers of a value with several ("2 1").
    fn list(&self, k: &str) -> Vec<f64> {
        self.get(k).map(|v| v.split(|c: char| c.is_whitespace() || c == ',').filter_map(|x| x.parse().ok()).filter(|v: &f64| v.is_finite()).collect()).unwrap_or_default()
    }
    /// Ink/Stitch random stitch length (% jitter, 0 = off).
    fn random_length(&self) -> f64 {
        if self.b("enable_random_stitch_length", false) {
            self.f("random_stitch_length_jitter_percent", 10.0).max(0.0)
        } else {
            0.0
        }
    }
    /// Bean repeats as passes: one value, or a pattern of several.
    fn beans(&self) -> (u32, Vec<u32>) {
        let v: Vec<u32> = self.list("bean_stitch_repeats").into_iter().map(|x| x.max(0.0) as u32 * 2).collect();
        match v.len() {
            0 => (0, vec![]),
            1 => (v[0], vec![]),
            _ => (v[0], v),
        }
    }
}

/// Several values the Ink/Stitch way ("2 1").
fn fmt_list(v: &[f64]) -> String {
    v.iter().map(|x| fmt(*x)).collect::<Vec<_>>().join(" ")
}

/// Ink/Stitch random stitch length attributes.
fn push_random(attrs: &mut Vec<(String, String)>, pct: f64, seed: u32) {
    if pct > 0.0 {
        attrs.push(("enable_random_stitch_length".into(), "True".into()));
        attrs.push(("random_stitch_length_jitter_percent".into(), fmt(pct)));
        attrs.push(("random_seed".into(), seed.to_string()));
    }
}

fn ink_fill(ink: &Ink) -> FillParams {
    let method = match ink.get("fill_method").unwrap_or("tatami_fill") {
        "contour_fill" => {
            if ink.get("contour_strategy").map_or(false, |s| s != "0" && s != "inner_to_outer") {
                FillMethod::Spiral
            } else {
                FillMethod::Contour
            }
        }
        "circular_fill" => FillMethod::Circular,
        "meander_fill" => FillMethod::Meander,
        "guided_fill" => FillMethod::Guided,
        "cross_stitch" => FillMethod::Cross,
        "tartan_fill" => FillMethod::Tartan,
        _ => FillMethod::Tatami,
    };
    let cross = method == FillMethod::Cross;
    let meander = method == FillMethod::Meander;
    // meander and circular fills stitch with the running stitch length
    let running = matches!(method, FillMethod::Meander | FillMethod::Circular);
    // the cross stitch grid turns by its own rotation (Ink/Stitch: clockwise on screen)
    let angle = if meander {
        ink.f("meander_angle", 0.0)
    } else if method == FillMethod::Cross {
        -ink.f("cross_rotation", 0.0)
    } else {
        ink.f("angle", 0.0)
    };
    let row = ink.f("row_spacing_mm", 0.25);
    let underlay_angles: Vec<f64> = ink
        .get("fill_underlay_angle")
        .map(|v| v.split_whitespace().filter_map(|a| a.trim_end_matches(",").parse::<f64>().ok()).collect())
        .unwrap_or_default();
    FillParams {
        method,
        angle,
        row_spacing: row,
        end_row_spacing: ink.f("end_row_spacing_mm", 0.0),
        max_stitch_length: if running { ink.f("running_stitch_length_mm", 2.5) } else { ink.f("max_stitch_length_mm", 4.0) },
        staggers: ink.u("staggers", 4),
        pull_comp: ink.f("pull_compensation_mm", 0.0),
        // Ink/Stitch: underlay for every method but cross stitch
        underlay: ink.b("fill_underlay", !cross),
        // Ink/Stitch: a list of underlay angles; two that cross become our
        // cross-hatched underlay (its passes at ±45° around the middle angle)
        underlay_angle: match underlay_angles.as_slice() {
            [a, b, ..] => (a + b) / 2.0 - angle,
            [a] => a - angle,
            [] => 90.0,
        },
        // more than two, or two that do not cross at 90°: the list itself
        underlay_cross: underlay_angles.len() == 2 && ((underlay_angles[1] - underlay_angles[0]).abs() - 90.0).abs() < 1e-6,
        underlay_angles: if underlay_angles.len() > 2 || (underlay_angles.len() == 2 && ((underlay_angles[1] - underlay_angles[0]).abs() - 90.0).abs() >= 1e-6) {
            underlay_angles.iter().map(|a| a - angle).collect()
        } else {
            Vec::new()
        },
        repeats: ink.u("repeats", 1).max(1),
        bean_repeats: ink.get("bean_stitch_repeats").and_then(|v| v.split_whitespace().next()?.parse().ok()).unwrap_or(0),
        contour_double: matches!(ink.get("contour_strategy"), Some("double_spiral") | Some("2")),
        clockwise: ink.b("clockwise", false),
        pull_comp_pct: ink.f("pull_compensation_percent", 0.0) / 100.0,
        skip_last: ink.b("skip_last", false),
        underlay_spacing: ink.f("fill_underlay_row_spacing_mm", row * 3.0),
        underlay_inset: ink.f("fill_underlay_inset_mm", 0.0),
        // Ink/Stitch: defaults to the fill's own max stitch length
        underlay_stitch_length: ink.f("fill_underlay_max_stitch_length_mm", ink.f("max_stitch_length_mm", 4.0)),
        travel_length: ink.f("running_stitch_length_mm", 2.5),
        center: [0.5, 0.5],
        gradient_density: false,
        gradient: None,
        meander_scale: ink.f("meander_scale_percent", 100.0).max(1.0) / 100.0 * 2.5,
        // "x y": the height relative to the width
        meander_aspect: match ink.list("meander_scale_percent").as_slice() {
            [x, y, ..] if *x > 0.0 => (y / x).clamp(0.1, 10.0),
            _ => 1.0,
        },
        meander_zigzag: if meander { ink.f("zigzag_spacing_mm", 0.0).max(0.0) } else { 0.0 },
        meander_zigzag_width: ink.f("zigzag_width_mm", 3.0).max(0.1),
        meander_clip: ink.b("clip", false),
        // Ink/Stitch draws meanders with tiles; without a pattern it uses its first tile
        meander_tile: meander.then(|| {
            let id = ink.get("meander_pattern").filter(|id| crate::stitches::meander_tiles::tile(id).is_some());
            id.unwrap_or(crate::stitches::meander_tiles::DEFAULT_TILE).to_string()
        }),
        smoothness: if meander { (ink.f("smoothness_mm", 0.0) / 2.0).clamp(0.0, 1.0) } else { FillParams::default().smoothness },
        seed: ink.u("random_seed", 1).max(1),
        random_length: ink.random_length(),
        cross_size: ink.get("pattern_size_mm").and_then(|v| v.split_whitespace().next()?.parse().ok()).unwrap_or(3.0),
        cross_coverage: ink.f("fill_coverage", 50.0) / 100.0,
        cross_kind: match ink.get("cross_stitch_method").unwrap_or("simple_cross").replace(' ', "_").as_str() {
            m if m.starts_with("half_cross") => CrossKind::Half,
            m if m.starts_with("upright_cross") || m.starts_with("dense_upright") => CrossKind::Upright,
            m if m.starts_with("double_cross") => CrossKind::Double,
            m if m.starts_with("smyrna") => CrossKind::Smyrna,
            _ => CrossKind::Cross,
        },
        cross_grid_canvas: ink.b("canvas_grid_origin", true),
        cross_flip: ink.get("cross_stitch_method").is_some_and(|m| m.contains("flipped")),
        cross_threads: ink.u("cross_thread_count", 1).max(1),
        tartan: (method == FillMethod::Tartan).then(|| ink_tartan(ink)),
        cross_size_y: match ink.list("pattern_size_mm").as_slice() {
            [x, y, ..] if (x - y).abs() > 1e-9 => y.max(0.1),
            _ => 0.0,
        },
        cross_dense: ink.get("cross_stitch_method").is_some_and(|m| m.starts_with("dense")),
        cross_max_length: ink.f("max_cross_stitch_length_mm", 11.0).max(0.0),
        underlay_skip_last: ink.b("fill_underlay_skip_last", false),
        underpath: ink.b("underpath", true),
        gap_fill_rows: ink.u("gap_fill_rows", 0),
        guided_strategy: match ink.get("guided_fill_strategy") {
            Some("parallel_offset") | Some("1") => GuidedStrategy::Parallel,
            Some("buffer") | Some("2") => GuidedStrategy::Buffer,
            _ => GuidedStrategy::Copy,
        },
        cross_offset: {
            // "x y", or one value for both
            let v: Vec<f64> = ink.get("cross_offset_mm").map(|v| v.split_whitespace().filter_map(|x| x.parse().ok()).filter(|v: &f64| v.is_finite()).collect()).unwrap_or_default();
            match v.as_slice() {
                [x, y, ..] => [x.max(0.0), y.max(0.0)],
                [x] => [x.max(0.0), x.max(0.0)],
                [] => [0.0, 0.0],
            }
        },
        expand: ink.f("expand_mm", 0.0),
        ..FillParams::default()
    }
}

fn ink_satin(ink: &Ink) -> SatinParams {
    SatinParams {
        method: match ink.get("satin_method").unwrap_or("satin_column") {
            "e_stitch" => SatinMethod::EStitch,
            "s_stitch" => SatinMethod::SStitch,
            "zigzag" => SatinMethod::Zigzag,
            _ => SatinMethod::Satin,
        },
        spacing: ink.f("zigzag_spacing_mm", 0.4),
        width: 3.0,
        // Ink/Stitch adds these to each side, ours are the total
        pull_comp: ink.f("pull_compensation_mm", 0.0) * 2.0,
        pull_comp_pct: ink.f("pull_compensation_percent", 0.0) * 2.0,
        max_stitch_length: ink.f("max_stitch_length_mm", 0.0),
        short_stitch_inset: ink.f("short_stitch_inset", 15.0) / 100.0,
        center_walk: ink.b("center_walk_underlay", false),
        contour_underlay: ink.b("contour_underlay", false),
        contour_inset: ink.f("contour_underlay_inset_mm", 0.4),
        zigzag_underlay: ink.b("zigzag_underlay", false),
        zigzag_underlay_spacing: ink.f("zigzag_underlay_spacing_mm", 3.0),
        // Ink/Stitch: half the contour underlay inset when not set
        zigzag_underlay_inset: ink.f("zigzag_underlay_inset_mm", ink.f("contour_underlay_inset_mm", 0.4) * 0.5),
        underlay_auto: false,
        center_walk_repeats: ink.u("center_walk_underlay_repeats", 2).max(1),
        center_walk_position: ink.f("center_walk_underlay_position", 50.0) / 100.0,
        underlay_stitch_length: ink.f("contour_underlay_stitch_length_mm", ink.f("center_walk_underlay_stitch_length_mm", 3.0)),
        contour_inset_pct: ink.f("contour_underlay_inset_percent", 0.0) / 100.0,
        zigzag_inset_pct: ink.f("zigzag_underlay_inset_percent", 0.0) / 100.0,
        zigzag_underlay_max_stitch: ink.f("zigzag_underlay_max_stitch_length_mm", 0.0),
        short_stitch_distance: ink.f("short_stitch_distance_mm", 0.25),
        push_comp: ink.f("push_compensation_mm", 0.0),
        random_wider: ink.f("random_width_increase_percent", 0.0) / 100.0,
        random_narrower: ink.f("random_width_decrease_percent", 0.0) / 100.0,
        random_seed: ink.u("random_seed", 1),
        random_spacing: (ink.f("random_zigzag_spacing_percent", 0.0) / 100.0).max(0.0),
        split_jitter: (ink.f("random_split_jitter_percent", 0.0) / 100.0).clamp(0.0, 1.0),
        split_random_phase: ink.b("random_split_phase", false),
        split_min_length: ink.f("min_random_split_length_mm", 0.0).max(0.0),
        reverse_rails: match ink.get("reverse_rails").unwrap_or("automatic") {
            "none" => RailReverse::None,
            "first" => RailReverse::First,
            "second" => RailReverse::Second,
            "both" => RailReverse::Both,
            _ => RailReverse::Automatic,
        },
        split_staggers: if ink.get("split_method") == Some("staggered") { ink.u("split_staggers", 4) } else { 0 },
        guides: Vec::new(),
        swap_rails: ink.b("swap_satin_rails", false),
        reverse: false,
        multi: false,
    }
}

fn ink_running(ink: &Ink) -> RunningParams {
    let lengths = ink.list("running_stitch_length_mm");
    // Ink/Stitch: 1 = triple, 2 = quintuple; ours counts the extra passes (2 = triple)
    let (bean_repeats, bean_pattern) = ink.beans();
    RunningParams {
        length: ink.f("running_stitch_length_mm", 2.5),
        length_pattern: if lengths.len() > 1 { lengths } else { vec![] },
        random_length: ink.random_length(),
        random_seed: ink.u("random_seed", 1),
        cutwork_needle: ink.u("cutwork_needle", 0),
        tolerance: ink.f("running_stitch_tolerance_mm", 0.2),
        repeats: ink.u("repeats", 1).max(1),
        bean_repeats,
        bean_pattern,
        ripple: (ink.get("stroke_method") == Some("ripple_stitch")).then(|| RippleParams {
            lines: ink.u("line_count", 10).max(1),
            reverse: ink.b("reverse", false),
            min_line_dist: ink.f("min_line_dist_mm", 0.0).max(0.0),
            skip_start: ink.u("skip_start", 0),
            skip_end: ink.u("skip_end", 0),
            flip_copies: ink.b("flip_copies", true),
            exponent: ink.f("exponent", 1.0).max(0.01),
            flip_exponent: ink.b("flip_exponent", false),
            staggers: ink.u("staggers", 0),
            join_point: matches!(ink.get("join_style"), Some("1") | Some("point")),
            grid_size: ink.f("grid_size_mm", 0.0).max(0.0),
            grid_first: ink.b("grid_first", false),
            scale_axis: match ink.get("scale_axis") {
                Some("1") => RippleScaleAxis::X,
                Some("2") => RippleScaleAxis::Y,
                Some("3") => RippleScaleAxis::None,
                _ => RippleScaleAxis::Both,
            },
            // Ink/Stitch's defaults: from full size to nothing along the guide
            scale_start: ink.f("scale_start", 100.0),
            scale_end: ink.f("scale_end", 0.0),
            rotate_ripples: ink.b("rotate_ripples", true),
            manual: ink.b("manual_pattern_placement", false),
            // without a guide Ink/Stitch fans an open line towards its target
            fan: true,
            guide_position: match ink.get("satin_guide_pattern_position") {
                Some("render_at_rungs") => RippleGuidePosition::Rungs,
                Some("adaptive") => RippleGuidePosition::Adaptive,
                _ => RippleGuidePosition::LineCount,
            },
            ..RippleParams::default()
        }),
        stem: None,
        motif: None,
        zigzag: None,
    }
}

struct Ctx<'a> {
    doc: Document,
    warnings: Vec<String>,
    root_tf: Affine,
    counter: usize,
    /// Ink/Stitch object commands by target id.
    commands: HashMap<String, Vec<(String, [f64; 2])>>,
    /// The guide line of the current group (Ink/Stitch guide-line marker):
    /// its sub-paths (several: a satin guide).
    guide: Option<Vec<SubPath>>,
    /// The anchor line of the current group (Ink/Stitch anchor-line marker).
    anchor: Option<[[f64; 2]; 2]>,
    /// Stitch patterns of the current group (Ink/Stitch pattern markers).
    patterns: Vec<StitchPattern>,
    /// Elements by id (clones, clip paths, gradients).
    by_id: HashMap<&'a str, roxmltree::Node<'a, 'a>>,
    /// Objects made from an element (by its id), and the transform it was walked with.
    made: HashMap<String, (Vec<String>, Affine)>,
    /// `<use>` clones, expanded after the walk: where they go in the
    /// sewing order, their target, transform, the `<use>` and its style.
    deferred: Vec<(usize, roxmltree::Node<'a, 'a>, Affine, roxmltree::Node<'a, 'a>, Style, usize)>,
    /// Document order of clones and texts.
    seq: usize,
    /// Inside a clone: `<symbol>`s are walked, nested clones expanded in place.
    in_clone: u32,
    /// The clip region in force (mm).
    clip: Option<Vec<Ring>>,
    texts: Vec<SvgText>,
    _p: std::marker::PhantomData<&'a ()>,
}

impl<'a> Ctx<'a> {
    fn add(&mut self, name: String, color: [u8; 3], paths: Vec<SubPath>, stitch: StitchParams, ink: &Ink) {
        // a tartan: one layer object per colour of its palette
        if let StitchParams::Fill(f) = &stitch {
            if let Some(t) = f.tartan.as_ref().filter(|t| t.layer == 0) {
                let colors = crate::stitches::tartan::tartan_colors(&t.palette);
                if !colors.is_empty() {
                    let group = if t.group.is_empty() { format!("tartan{}", self.counter + 1) } else { t.group.clone() };
                    for (k, c) in colors.iter().enumerate() {
                        let rgb = parse_color(c).unwrap_or(color);
                        let mut fp = f.clone();
                        fp.tartan = Some(TartanParams { layer: k as u32, group: group.clone(), ..t.clone() });
                        let n = if colors.len() > 1 { format!("{name} · colour {}", k + 1) } else { name.clone() };
                        self.add_one(n, rgb, paths.clone(), StitchParams::Fill(fp), ink);
                    }
                    return;
                }
            }
        }
        self.add_one(name, color, paths, stitch, ink);
    }

    fn add_one(&mut self, name: String, color: [u8; 3], paths: Vec<SubPath>, stitch: StitchParams, ink: &Ink) {
        // a clip path: fills cut to it, lines kept where they are inside (Ink/Stitch clip)
        let paths = match (&self.clip, &stitch) {
            (Some(clip), StitchParams::Fill(_)) | (Some(clip), StitchParams::Applique(_)) | (Some(clip), StitchParams::None) => {
                let rings: Vec<Ring> = paths.iter().filter(|s| s.nodes.len() >= 3 || (s.closed && s.nodes.len() >= 2)).map(|s| s.flatten(0.05)).collect();
                let cut = crate::clip::intersect(&crate::clip::region(&rings), &crate::clip::region(clip));
                crate::clip::rings(&cut).iter().filter(|r| r.len() >= 3).map(|r| crate::clip::fit_ring(r, 0.02, 30.0)).collect()
            }
            (Some(clip), StitchParams::Running(_)) | (Some(clip), StitchParams::Manual(_)) => paths
                .iter()
                .flat_map(|s| {
                    let mut pts = s.flatten(0.05);
                    if s.closed && pts.len() > 2 {
                        pts.push(pts[0]);
                    }
                    crate::geom::clip_polyline(&pts, clip)
                })
                .map(|pts| SubPath::polyline(&pts, false))
                .collect(),
            _ => paths,
        };
        if paths.is_empty() {
            return;
        }
        self.counter += 1;
        let thread = self.doc.ensure_thread(color, None);
        let obj = Object {
            id: format!("o{}", self.counter),
            name,
            thread,
            visible: true,
            locked: false,
            paths,
            stitch,
            trim_after: ink.b("trim_after", false),
            stop_after: ink.b("stop_after", false),
            // Ink/Stitch "ties": both / start / end / none (also the old 0–3 values)
            ties: match ink.get("ties").unwrap_or("both") {
                "start" | "1" => Ties::Start,
                "end" | "2" => Ties::End,
                "none" | "3" => Ties::None,
                _ => Ties::Both,
            },
            force_lock: ink.b("force_lock_stitches", false),
            min_stitch: ink.get("min_stitch_length_mm").and_then(|v| v.trim().parse().ok()),
            min_jump: ink.get("min_jump_stitch_length_mm").and_then(|v| v.trim().parse().ok()),
            clone: None,
            hidden: None,
            patterns: vec![],
            start: None,
            end: None,
        };
        self.doc.objects.push(obj);
    }

    fn walk(&mut self, node: roxmltree::Node<'a, 'a>, tf: Affine, style: &Style) {
        if !node.is_element() {
            return;
        }
        let tag = node.tag_name().name();
        let ns = node.tag_name().namespace();
        if ns.is_some() && ns != Some(SVG_NS) {
            return;
        }
        if matches!(tag, "defs" | "clipPath" | "mask" | "metadata" | "title" | "desc" | "style" | "marker" | "pattern" | "linearGradient" | "radialGradient") || (tag == "symbol" && self.in_clone == 0) {
            return;
        }
        if is_connector(node) {
            return;
        }
        let st = read_style(node, style);
        if st.display_none {
            return;
        }
        let ctx_tf = tf;
        let tf = node.attribute("transform").map(|t| tf.mul(parse_transform(t))).unwrap_or(tf);
        // a clip path (on the element or a group around it) in force while it is walked
        let outer_clip = self.clip.clone();
        if let Some(region) = self.clip_of(node, tf) {
            self.clip = Some(match &self.clip {
                Some(c) => crate::clip::rings(&crate::clip::intersect(&crate::clip::region(c), &crate::clip::region(&region))),
                None => region,
            });
        }
        let first = self.doc.objects.len();
        self.walk_inner(node, tag, tf, &st);
        // what this element became (for clones of it)
        if let Some(id) = node.attribute("id") {
            if self.in_clone == 0 && self.doc.objects.len() > first {
                let ids = self.doc.objects[first..].iter().map(|o| o.id.clone()).collect();
                self.made.insert(id.to_string(), (ids, ctx_tf));
            }
        }
        self.clip = outer_clip;
    }

    /// The region of an element's `clip-path` (mm), if it has one.
    fn clip_of(&self, node: roxmltree::Node<'a, 'a>, tf: Affine) -> Option<Vec<Ring>> {
        let style_val = node.attribute("style").and_then(|s| s.split(';').find_map(|d| d.split_once(':').filter(|(k, _)| k.trim() == "clip-path").map(|(_, v)| v.trim().to_string())));
        let val = node.attribute("clip-path").map(|s| s.to_string()).or(style_val)?;
        let id = val.trim().strip_prefix("url(#")?.split(')').next()?.trim_matches(['"', '\'']);
        let cp = *self.by_id.get(id)?;
        let cp_tf = cp.attribute("transform").map(|t| tf.mul(parse_transform(t))).unwrap_or(tf);
        let mut rings = Vec::new();
        for c in cp.children().filter(|c| c.is_element()) {
            let ctf = c.attribute("transform").map(|t| cp_tf.mul(parse_transform(t))).unwrap_or(cp_tf);
            for sp in shape_subpaths(c, self.root_tf.mul(ctf)) {
                let r = sp.flatten(0.05);
                if r.len() >= 3 {
                    rings.push(r);
                }
            }
        }
        (!rings.is_empty()).then_some(rings)
    }

    /// Expand the `<use>` clones (Ink/Stitch clones): each becomes copies of
    /// its target's objects, linked to them when the target was imported too,
    /// fill angles turned with the clone (or its own `angle`, `flip_angle`).
    fn expand_clones(&mut self) {
        // last first, so earlier insert positions stay valid (and clones at one
        // position keep their document order)
        let deferred = std::mem::take(&mut self.deferred);
        for (at, target, tf_c, use_node, st, seq) in deferred.into_iter().rev() {
            let before = self.doc.objects.len();
            self.in_clone += 1;
            self.walk(target, tf_c, &st);
            self.in_clone -= 1;
            let mut new: Vec<Object> = self.doc.objects.drain(before..).collect();
            if new.is_empty() {
                continue;
            }
            // the original's transform: where it was walked, or where it sits in the document
            let tf_o = target.attribute("id").and_then(|id| self.made.get(id)).map(|m| m.1).unwrap_or_else(|| target.parent().map(composed_tf).unwrap_or(Affine::IDENTITY));
            let m = self.root_tf.mul(tf_c).mul(self.root_tf.mul(tf_o).inverse());
            let [a, b, c, d, _, _] = m.0;
            let rot = b.atan2(a).to_degrees();
            let mirrored = a * d - b * c < 0.0;
            let ink = Ink::new(use_node);
            let custom = ink.get("angle").and_then(|v| v.trim().parse::<f64>().ok());
            let flip = ink.b("flip_angle", false);
            let originals = target.attribute("id").and_then(|id| self.made.get(id)).map(|m| m.0.clone()).filter(|ids| ids.len() == new.len());
            for (k, o) in new.iter_mut().enumerate() {
                let mut own: Option<f64> = None;
                if let StitchParams::Fill(f) = &mut o.stitch {
                    // Ink/Stitch Clone.apply_angles: the fill direction through the clone's transform
                    let angle = match custom {
                        Some(v) => v,
                        None => {
                            let r = (-f.angle).to_radians();
                            let v = pt(a * r.cos() + c * r.sin(), b * r.cos() + d * r.sin());
                            -v.y.atan2(v.x).to_degrees()
                        }
                    };
                    let angle = if flip { -angle } else { angle };
                    if custom.is_some() || flip || mirrored {
                        own = Some(angle);
                    }
                    f.angle = angle;
                }
                if let Some(ids) = &originals {
                    o.clone = Some(CloneLink { of: ids[k].clone(), m: m.0, rot, angle: own });
                }
            }
            let at = at.min(self.doc.objects.len());
            // texts after the clone in the document move behind its objects
            for t in &mut self.texts {
                if t.index > at || (t.index == at && t.seq > seq) {
                    t.index += new.len();
                }
            }
            self.doc.objects.splice(at..at, new);
        }
    }

    fn walk_inner(&mut self, node: roxmltree::Node<'a, 'a>, tag: &str, tf: Affine, st: &Style) {
        let st = st.clone();
        match tag {
            "svg" | "g" | "a" | "switch" | "symbol" => {
                // Ink/Stitch "ignore layer" command
                if node.children().any(|c| command_of(c) == Some("ignore_layer")) {
                    return;
                }
                // a guide line applies to the fills grouped with it
                let marked = |name: &str| {
                    node.children().filter(|c| c.is_element() && marker_of(*c) == Some(name)).find_map(|c| {
                        let ctf = c.attribute("transform").map(|t| tf.mul(parse_transform(t))).unwrap_or(tf);
                        let sps: Vec<SubPath> = shape_subpaths(c, self.root_tf.mul(ctf)).into_iter().filter(|sp| sp.nodes.len() >= 2).collect();
                        (!sps.is_empty()).then_some(sps)
                    })
                };
                let guide = marked("guide-line");
                // the anchor line of satin-guided ripples: its two end points
                let anchor = marked("anchor-line").and_then(|sps| {
                    let pts = sps[0].flatten(0.1);
                    Some([pts.first()?.arr(), pts.last()?.arr()])
                });
                // pattern markers: lines add needle points, filled shapes leave them out
                let patterns: Vec<StitchPattern> = node
                    .children()
                    .filter(|c| c.is_element() && marker_of(*c) == Some("pattern"))
                    .filter_map(|c| {
                        let ctf = c.attribute("transform").map(|t| tf.mul(parse_transform(t))).unwrap_or(tf);
                        let paths: Vec<SubPath> = shape_subpaths(c, self.root_tf.mul(ctf)).into_iter().filter(|sp| sp.nodes.len() >= 2).collect();
                        let cst = read_style(c, &st);
                        let ink = Ink::new(c);
                        let p = StitchPattern {
                            add: cst.stroke.flatten().is_some() && !ink.b("satin_column", false),
                            remove: cst.fill.flatten().is_some() || cst.fill_url.is_some(),
                            interval: ink.list("pattern_interval").into_iter().map(|v| v.max(1.0) as u32).collect(),
                            offset: ink.u("pattern_offset", 0),
                            paths,
                        };
                        (!p.paths.is_empty() && (p.add || p.remove)).then_some(p)
                    })
                    .collect();
                let outer_patterns = std::mem::replace(&mut self.patterns, patterns);
                let outer = std::mem::replace(&mut self.guide, guide);
                let outer_anchor = std::mem::replace(&mut self.anchor, anchor);
                for c in node.children() {
                    self.walk(c, tf, &st);
                }
                self.guide = outer;
                self.anchor = outer_anchor;
                self.patterns = outer_patterns;
            }
            "use" => match command_of(node) {
                Some(cmd @ ("origin" | "stop_position")) => {
                    let num = |k: &str| node.attribute(k).and_then(|v| v.trim().parse::<f64>().ok()).unwrap_or(0.0);
                    let ctf = node.attribute("transform").map(|t| tf.mul(parse_transform(t))).unwrap_or(tf);
                    let p = self.root_tf.mul(ctf).apply(pt(num("x"), num("y")));
                    if cmd == "origin" {
                        self.doc.options.origin = Some([p.x, p.y]);
                    } else {
                        self.doc.options.stop_position = Some([p.x, p.y]);
                    }
                }
                Some(_) => {}
                None => {
                    // a clone: expanded after the walk, in this place in the sewing order
                    let href = node.attribute("href").or_else(|| node.attribute(("http://www.w3.org/1999/xlink", "href"))).unwrap_or("");
                    let num = |k: &str| node.attribute(k).and_then(|v| v.trim().parse::<f64>().ok()).unwrap_or(0.0);
                    match href.strip_prefix('#').and_then(|id| self.by_id.get(id).copied()) {
                        Some(target) => {
                            let tf_c = tf.mul(Affine([1.0, 0.0, 0.0, 1.0, num("x"), num("y")]));
                            if self.in_clone > 0 {
                                // a clone inside a clone: copied in place
                                if self.in_clone < 8 {
                                    self.in_clone += 1;
                                    self.walk(target, tf_c, &st);
                                    self.in_clone -= 1;
                                }
                            } else {
                                self.seq += 1;
                                self.deferred.push((self.doc.objects.len(), target, tf_c, node, st.clone(), self.seq));
                            }
                        }
                        None => self.warnings.push(format!("A clone of a missing element ({href}) was left out")),
                    }
                }
            },
            "text" => self.text(node, tf, &st),
            "image" => self.warnings.push("Embedded images are ignored — use Auto-digitize instead".into()),
            _ => {
                match marker_of(node) {
                    Some("guide-line") | Some("anchor-line") | Some("pattern") => return,
                    Some(m) => {
                        self.warnings.push(format!("Ink/Stitch {m} markers are not supported"));
                        return;
                    }
                    None => {}
                }
                let cmds = node.attribute("id").and_then(|id| self.commands.get(id)).cloned().unwrap_or_default();
                if Ink::new(node).b("ignore_object", false) || cmds.iter().any(|(c, _)| c == "ignore_object") {
                    return;
                }
                let first = self.doc.objects.len();
                self.shape(node, tf, &st, tag);
                let guide = self.guide.clone();
                let anchor = self.anchor;
                let patterns = self.patterns.clone();
                for o in &mut self.doc.objects[first..] {
                    apply_commands(o, &cmds);
                    if o.patterns.is_empty() {
                        o.patterns = patterns.clone();
                    }
                    match (&mut o.stitch, &guide) {
                        (StitchParams::Fill(f), Some(g)) if f.method == FillMethod::Guided && f.guide.is_none() => f.guide = Some(g[0].clone()),
                        (StitchParams::Running(RunningParams { ripple: Some(r), .. }), Some(g)) if r.guide.is_empty() => {
                            r.guide = g.clone();
                            r.anchor = anchor;
                        }
                        _ => {}
                    }
                }
            }
        }
    }

    /// A linear gradient paint server for `node`: its vector in mm and its
    /// stops (offset, colour), following `href` chains.
    #[allow(clippy::type_complexity)]
    fn linear_gradient(&self, id: &str, node: roxmltree::Node<'a, 'a>, full: Affine) -> Option<([f64; 2], [f64; 2], Vec<(f64, [u8; 3])>)> {
        let g = *self.by_id.get(id)?;
        if g.tag_name().name() != "linearGradient" {
            return None;
        }
        // attributes and stops may come from referenced gradients
        let chain: Vec<roxmltree::Node> = std::iter::successors(Some(g), |n| {
            let h = n.attribute("href").or_else(|| n.attribute(("http://www.w3.org/1999/xlink", "href")))?;
            self.by_id.get(h.strip_prefix('#')?).copied()
        })
        .take(8)
        .collect();
        let attr = |k: &str| chain.iter().find_map(|n| n.attribute(k));
        let stops: Vec<(f64, [u8; 3])> = chain
            .iter()
            .map(|n| n.children().filter(|c| c.is_element() && c.tag_name().name() == "stop").collect::<Vec<_>>())
            .find(|v| !v.is_empty())?
            .into_iter()
            .filter_map(|s| {
                let off = s.attribute("offset").unwrap_or("0").trim();
                let off = off.strip_suffix('%').map(|v| v.parse::<f64>().unwrap_or(0.0) / 100.0).unwrap_or_else(|| off.parse().unwrap_or(0.0));
                let color = s
                    .attribute("style")
                    .and_then(|st| st.split(';').find_map(|d| d.split_once(':').filter(|(k, _)| k.trim() == "stop-color").map(|(_, v)| v.trim().to_string())))
                    .or_else(|| s.attribute("stop-color").map(|v| v.to_string()))
                    .and_then(|v| parse_color(&v))?;
                Some((off.clamp(0.0, 1.0), color))
            })
            .collect();
        if stops.len() < 2 {
            return stops.first().map(|s| ([0.0, 0.0], [1.0, 0.0], vec![*s]));
        }
        let coord = |k: &str, d: f64| attr(k).map(|v| v.trim()).map(|v| v.strip_suffix('%').map(|p| p.parse::<f64>().unwrap_or(0.0) / 100.0).unwrap_or_else(|| v.parse().unwrap_or(d))).unwrap_or(d);
        let (x1, y1, x2, y2) = (coord("x1", 0.0), coord("y1", 0.0), coord("x2", 1.0), coord("y2", 0.0));
        let gt = attr("gradientTransform").map(parse_transform).unwrap_or(Affine::IDENTITY);
        let user = if attr("gradientUnits") == Some("userSpaceOnUse") {
            gt
        } else {
            // relative to the element's own box
            let pts: Vec<Point> = shape_subpaths(node, Affine::IDENTITY).iter().flat_map(|s| s.flatten(0.2)).collect();
            let (mut lo, mut hi) = (pt(f64::INFINITY, f64::INFINITY), pt(f64::NEG_INFINITY, f64::NEG_INFINITY));
            for p in &pts {
                lo = pt(lo.x.min(p.x), lo.y.min(p.y));
                hi = pt(hi.x.max(p.x), hi.y.max(p.y));
            }
            if !lo.x.is_finite() {
                return None;
            }
            Affine([hi.x - lo.x, 0.0, 0.0, hi.y - lo.y, lo.x, lo.y]).mul(gt)
        };
        let m = full.mul(user);
        Some((m.apply(pt(x1, y1)).arr(), m.apply(pt(x2, y2)).arr(), stops))
    }

    /// An SVG `<text>`: kept for the editor to set as lettering.
    fn text(&mut self, node: roxmltree::Node<'a, 'a>, tf: Affine, st: &Style) {
        // lines: Inkscape's line tspans, else the whole text
        let line_spans: Vec<roxmltree::Node> = node.children().filter(|c| c.is_element() && c.tag_name().name() == "tspan").collect();
        let collect = |n: roxmltree::Node| n.descendants().filter(|d| d.is_text()).filter_map(|d| d.text()).collect::<String>();
        let text = if line_spans.len() > 1 { line_spans.iter().map(|s| collect(*s)).collect::<Vec<_>>().join("\n") } else { collect(node) };
        let text = text.trim().to_string();
        if text.is_empty() {
            return;
        }
        let first = line_spans.first().copied().unwrap_or(node);
        let num = |n: roxmltree::Node, k: &str| n.attribute(k).and_then(|v| v.split_whitespace().next()?.parse::<f64>().ok());
        let x = num(first, "x").or_else(|| num(node, "x")).unwrap_or(0.0);
        let y = num(first, "y").or_else(|| num(node, "y")).unwrap_or(0.0);
        let prop = |k: &str| -> Option<String> {
            node.ancestors().filter(|a| a.is_element()).find_map(|a| {
                a.attribute("style").and_then(|s| s.split(';').find_map(|d| d.split_once(':').filter(|(kk, _)| kk.trim() == k).map(|(_, v)| v.trim().to_string()))).or_else(|| a.attribute(k).map(|v| v.to_string()))
            })
        };
        let size_px = prop("font-size").and_then(|v| v.trim_end_matches("px").trim().parse::<f64>().ok()).unwrap_or(16.0);
        let full = self.root_tf.mul(tf);
        let p = full.apply(pt(x, y));
        let color = st.fill.flatten().unwrap_or([0x1c, 0x1c, 0x1c]);
        self.texts.push(SvgText {
            text,
            x: p.x,
            y: p.y,
            size: size_px * full.scale_factor(),
            color: format!("#{:02x}{:02x}{:02x}", color[0], color[1], color[2]),
            font: prop("font-family").map(|f| f.trim_matches(['"', '\'']).to_string()),
            anchor: prop("text-anchor").unwrap_or_else(|| "start".into()),
            index: self.doc.objects.len(),
            seq: {
                self.seq += 1;
                self.seq
            },
        });
    }

    /// Objects for one SVG shape element.
    fn shape(&mut self, node: roxmltree::Node<'a, 'a>, tf: Affine, st: &Style, tag: &str) {
        let full = self.root_tf.mul(tf);
        let paths = shape_subpaths(node, full);
        if paths.is_empty() {
            return;
        }
        let ink = Ink::new(node);
        let label = node
            .attributes()
            .find(|a| a.name() == "label")
            .map(|a| a.value().to_string())
            .or_else(|| node.attribute("id").map(|s| s.to_string()))
            .unwrap_or_else(|| format!("{} {}", tag, self.counter + 1));
        // lossless round-trip from our own exporter
        if let Some(json) = node.attributes().find(|a| a.namespace() == Some(FILUM_NS) && a.name() == "params").map(|a| a.value()) {
            if let Ok(stitch) = serde_json::from_str::<StitchParams>(json) {
                let color = st.fill.flatten().or(st.stroke.flatten()).unwrap_or([0x1c, 0x1c, 0x1c]);
                let paths = if let StitchParams::Satin(_) = stitch { paths } else { paths };
                let first = self.doc.objects.len();
                self.add(label, color, paths, stitch, &ink);
                // its part in hidden-stitch removal
                if let Some(h) = node.attributes().find(|a| a.namespace() == Some(FILUM_NS) && a.name() == "hidden").and_then(|a| serde_json::from_str(a.value()).ok()) {
                    for o in &mut self.doc.objects[first..] {
                        o.hidden = Some(h);
                    }
                }
                return;
            }
        }
        let stroke_mm = st.stroke_width.unwrap_or(1.0) * full.scale_factor();
        if ink.b("satin_column", false) {
            let color = st.stroke.flatten().or(st.fill.flatten()).unwrap_or([0x1c, 0x1c, 0x1c]);
            let mut sp = ink_satin(&ink);
            if paths.len() == 1 {
                sp.width = stroke_mm.max(0.5);
            }
            self.add(label, color, paths, StitchParams::Satin(sp), &ink);
            return;
        }
        let fill = st.fill.unwrap_or(Some([0, 0, 0])); // SVG default fill is black
        if let Some(c) = fill {
            // a closed path of two curved nodes (a lens, a leaf) is a shape too
            let closed: Vec<SubPath> = paths.iter().filter(|s| s.nodes.len() >= 3 || (s.closed && s.nodes.len() >= 2 && s.flatten(0.1).len() >= 3)).cloned().collect();
            if !closed.is_empty() && (ink.b("auto_fill", true) || ink.get("fill_method").is_some()) {
                let grad = st.fill_url.as_deref().and_then(|id| self.linear_gradient(id, node, full));
                match grad {
                    // Ink/Stitch's linear gradient fill: the colours in alternating rows
                    // across the gradient; a plain SVG gradient: blended by density
                    Some((from, to, stops)) if ink.get("fill_method") == Some("linear_gradient_fill") || !ink.has_any() => {
                        let rows = ink.get("fill_method") == Some("linear_gradient_fill");
                        let group = format!("svggrad{}", self.counter + 1);
                        let (dx, dy) = (to[0] - from[0], to[1] - from[1]);
                        let across = (-dx).atan2(-dy).to_degrees();
                        let base = ink_fill(&ink);
                        let g = GradientParams {
                            kind: GradientKind::Linear,
                            from,
                            to,
                            stops: stops.iter().map(|(pos, _)| GradientStop { pos: *pos, mid: 0.5 }).collect(),
                            mix: if rows { GradientMix::Rows } else { GradientMix::Blend },
                            group,
                            ..GradientParams::default()
                        };
                        for (layer, (_, color)) in stops.iter().enumerate() {
                            let fp = FillParams {
                                method: FillMethod::Tatami,
                                angle: if rows { across } else { base.angle },
                                gradient: Some(GradientParams { layer: layer as u32, ..g.clone() }),
                                ..base.clone()
                            };
                            self.add(format!("{label} {}", layer + 1), *color, closed.clone(), StitchParams::Fill(fp), &ink);
                        }
                    }
                    // other fills: the gradient's first colour
                    Some((_, _, stops)) => self.add(label.clone(), stops[0].1, closed, StitchParams::Fill(ink_fill(&ink)), &ink),
                    None => self.add(label.clone(), c, closed, StitchParams::Fill(ink_fill(&ink)), &ink),
                }
            }
        }
        if let Some(c) = st.stroke.flatten() {
            let stitch = match ink.get("stroke_method").unwrap_or("running_stitch") {
                "manual_stitch" => StitchParams::Manual(ManualParams { max_length: ink.f("max_stitch_length_mm", 0.0).max(0.0), bean_pattern: manual_beans(&ink) }),
                "zigzag_stitch" => StitchParams::Running(RunningParams {
                    zigzag: Some(ZigzagParams {
                        width: stroke_mm.max(0.1),
                        spacing: ink.f("zigzag_spacing_mm", 0.4).max(0.01),
                        pull_comp: ink.f("stroke_pull_compensation_mm", 0.0),
                        angle: ink.f("zigzag_angle", 0.0).clamp(-89.0, 89.0),
                    }),
                    ..ink_running(&ink)
                }),
                _ => {
                    if !ink.has_any() && stroke_mm >= 2.0 {
                        // wide plain strokes look best as satin
                        StitchParams::Satin(SatinParams { width: stroke_mm, ..SatinParams::default() })
                    } else {
                        StitchParams::Running(ink_running(&ink))
                    }
                }
            };
            let name = if fill.is_some() { format!("{label} outline") } else { label };
            // a satin centre line can only use the first sub-path
            if let StitchParams::Satin(_) = stitch {
                for (k, p) in paths.into_iter().enumerate() {
                    self.add(if k == 0 { name.clone() } else { format!("{name} {}", k + 1) }, c, vec![p], stitch.clone(), &ink);
                }
            } else {
                self.add(name, c, paths, stitch, &ink);
            }
        }
    }
}

/// Import SVG text. Coordinates are converted to millimetres.
pub fn import_svg(text: &str) -> Result<SvgImport, String> {
    let opt = roxmltree::ParsingOptions { allow_dtd: true, ..Default::default() };
    let xml = roxmltree::Document::parse_with_options(text, opt).map_err(|e| e.to_string())?;
    let root = xml.root_element();
    if root.tag_name().name() != "svg" {
        return Err("not an SVG document".into());
    }
    let vb: Option<Vec<f64>> = root.attribute("viewBox").map(|v| {
        v.split(|c: char| c == ',' || c.is_whitespace()).filter_map(|s| s.parse().ok()).collect()
    });
    let w_mm = root.attribute("width").and_then(parse_length_mm);
    let h_mm = root.attribute("height").and_then(parse_length_mm);
    let px = 25.4 / 96.0;
    let root_tf = match (&vb, w_mm, h_mm) {
        (Some(v), Some(w), Some(h)) if v.len() == 4 && v[2] > 0.0 && v[3] > 0.0 => {
            let (sx, sy) = (w / v[2], h / v[3]);
            let s = sx.min(sy);
            Affine([s, 0.0, 0.0, s, -v[0] * s, -v[1] * s])
        }
        (Some(v), _, _) if v.len() == 4 => Affine([px, 0.0, 0.0, px, -v[0] * px, -v[1] * px]),
        _ => Affine([px, 0.0, 0.0, px, 0.0, 0.0]),
    };
    let commands = object_commands(&xml, root_tf);
    let by_id: HashMap<&str, roxmltree::Node> = xml.descendants().filter(|n| n.is_element()).filter_map(|n| Some((n.attribute("id")?, n))).collect();
    let mut ctx = Ctx {
        doc: Document::default(),
        warnings: vec![],
        root_tf,
        counter: 0,
        commands,
        guide: None,
        anchor: None,
        by_id,
        made: HashMap::new(),
        deferred: Vec::new(),
        in_clone: 0,
        seq: 0,
        patterns: Vec::new(),
        clip: None,
        texts: Vec::new(),
        _p: Default::default(),
    };
    if let Some(w) = w_mm {
        ctx.doc.hoop.width = w.max(10.0);
    }
    if let Some(h) = h_mm {
        ctx.doc.hoop.height = h.max(10.0);
    }
    ctx.doc.name = root.attribute("docname").unwrap_or("Imported SVG").to_string();
    let style = Style::default();
    for c in root.children() {
        ctx.walk(c, Affine::IDENTITY, &style);
    }
    ctx.expand_clones();
    ctx.warnings.sort();
    ctx.warnings.dedup();
    Ok(SvgImport { document: ctx.doc, warnings: ctx.warnings, texts: ctx.texts })
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

fn fmt(v: f64) -> String {
    let s = format!("{:.4}", v);
    let s = s.trim_end_matches('0').trim_end_matches('.');
    if s == "-0" { "0".into() } else { s.to_string() }
}

pub fn subpaths_to_d(paths: &[SubPath]) -> String {
    let mut d = String::new();
    for sp in paths {
        let n = sp.nodes.len();
        if n == 0 {
            continue;
        }
        let p0 = sp.nodes[0].p;
        d.push_str(&format!("M {} {} ", fmt(p0[0]), fmt(p0[1])));
        let segs = if sp.closed { n } else { n - 1 };
        for s in 0..segs {
            let a = sp.nodes[s];
            let b = sp.nodes[(s + 1) % n];
            if a.o.is_none() && b.i.is_none() {
                d.push_str(&format!("L {} {} ", fmt(b.p[0]), fmt(b.p[1])));
            } else {
                let c1 = a.o.unwrap_or(a.p);
                let c2 = b.i.unwrap_or(b.p);
                d.push_str(&format!(
                    "C {} {} {} {} {} {} ",
                    fmt(c1[0]),
                    fmt(c1[1]),
                    fmt(c2[0]),
                    fmt(c2[1]),
                    fmt(b.p[0]),
                    fmt(b.p[1])
                ));
            }
        }
        if sp.closed {
            d.push_str("Z ");
        }
    }
    d.trim_end().to_string()
}

fn esc(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;").replace('\'', "&apos;")
}

fn b(v: bool) -> &'static str {
    if v { "True" } else { "False" }
}

/// An element of a bundled Ink/Stitch SVG, by id, as source text.
fn asset_element(svg: &str, id: &str) -> Option<String> {
    let doc = roxmltree::Document::parse(svg).ok()?;
    let n = doc.descendants().find(|n| n.attribute("id") == Some(id))?;
    Some(svg[n.range()].to_string())
}

/// Ink/Stitch command descriptions (`lib/commands.py`).
fn command_label(c: &str) -> &'static str {
    match c {
        "starting_point" => "Starting position",
        "ending_point" => "Ending position",
        "target_point" => "Target position",
        "trim" => "Trim thread after sewing this object",
        "stop" => "Stop (pause machine) after sewing this object",
        _ => "Command",
    }
}

/// An Ink/Stitch object command: the symbol at `at`, connected to the object.
fn command_group(oid: &str, k: usize, cmd: &str, at: [f64; 2], to: Point) -> String {
    let id = format!("{oid}-command-{k}");
    // starting / ending positions hide their connector (HIDDEN_CONNECTOR_COMMANDS)
    let hidden = if matches!(cmd, "starting_point" | "ending_point") { ";display:none" } else { "" };
    format!(
        "    <g id=\"{id}\" inkscape:label=\"Ink/Stitch Command: {label}\">\n      <path id=\"{id}-connector\" inkscape:label=\"connector\" \
style=\"fill:none;stroke:#000000;stroke-width:1;stroke-opacity:0.5;vector-effect:non-scaling-stroke;-inkscape-stroke:hairline{hidden}\" \
d=\"M {},{} {},{}\" inkscape:connector-type=\"polyline\" inkscape:connection-start=\"#{id}-use\" inkscape:connection-end=\"#{oid}\" />\n      \
<use id=\"{id}-use\" inkscape:label=\"command marker\" xlink:href=\"#inkstitch_{cmd}\" x=\"{}\" y=\"{}\" width=\"100%\" height=\"100%\" />\n    </g>\n",
        fmt(at[0]),
        fmt(at[1]),
        fmt(to.x),
        fmt(to.y),
        fmt(at[0]),
        fmt(at[1]),
        label = command_label(cmd),
    )
}

/// Export as Ink/Stitch-compatible SVG (user unit = 1 mm).
pub fn export_svg(doc: &Document) -> String {
    let (w, h) = (doc.hoop.width, doc.hoop.height);
    let mut s = String::new();
    s.push_str("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n");
    s.push_str(&format!(
        "<svg xmlns=\"{SVG_NS}\" xmlns:inkstitch=\"{INKSTITCH_NS}\" xmlns:filum=\"{FILUM_NS}\" \
xmlns:inkscape=\"http://www.inkscape.org/namespaces/inkscape\" xmlns:sodipodi=\"http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd\" \
xmlns:xlink=\"http://www.w3.org/1999/xlink\" width=\"{}mm\" height=\"{}mm\" viewBox=\"0 0 {} {}\">\n",
        fmt(w),
        fmt(h),
        fmt(w),
        fmt(h)
    ));
    s.push_str(&format!("  <metadata><inkstitch:inkstitch_svg_version>3</inkstitch:inkstitch_svg_version></metadata>\n"));
    let mut body = String::new();
    let mut symbols: Vec<&str> = Vec::new();
    let mut markers: Vec<&str> = Vec::new();
    for o in &doc.objects {
        if matches!(&o.stitch, StitchParams::Fill(f) if f.tartan.as_ref().is_some_and(|t| t.layer > 0)) {
            continue;
        }
        let color = doc.thread(&o.thread).map(|t| t.color.clone()).unwrap_or_else(|| "#000000".into());
        let params = esc(&serde_json::to_string(&o.stitch).unwrap_or_default());
        let mut attrs: Vec<(String, String)> = Vec::new();
        let mut paths = o.paths.clone();
        let style;
        match &o.stitch {
            StitchParams::Fill(p) => {
                style = format!("fill:{color};stroke:none");
                let method = match p.method {
                    FillMethod::Contour | FillMethod::Spiral => "contour_fill",
                    FillMethod::Stipple | FillMethod::Meander => "meander_fill",
                    FillMethod::Circular => "circular_fill",
                    FillMethod::Cross => "cross_stitch",
                    FillMethod::Tartan => "tartan_fill",
                    FillMethod::Flow | FillMethod::Curved => "tatami_fill",
                    FillMethod::Guided => "guided_fill",
                    _ => "tatami_fill",
                };
                attrs.push(("fill_method".into(), method.into()));
                if p.method == FillMethod::Spiral {
                    attrs.push(("contour_strategy".into(), "single_spiral".into()));
                }
                attrs.push(("angle".into(), fmt(p.angle)));
                attrs.push(("row_spacing_mm".into(), fmt(p.row_spacing)));
                if p.end_row_spacing > 0.0 {
                    attrs.push(("end_row_spacing_mm".into(), fmt(p.end_row_spacing)));
                }
                attrs.push(("max_stitch_length_mm".into(), fmt(p.max_stitch_length)));
                attrs.push(("staggers".into(), p.staggers.to_string()));
                attrs.push(("pull_compensation_mm".into(), fmt(p.pull_comp)));
                attrs.push(("fill_underlay".into(), b(p.underlay).into()));
                // Ink/Stitch takes a list of underlay angles: the cross-hatch as two
                attrs.push((
                    "fill_underlay_angle".into(),
                    if !p.underlay_angles.is_empty() {
                        p.underlay_angles.iter().map(|a| fmt(p.angle + a)).collect::<Vec<_>>().join(" ")
                    } else if p.underlay_cross {
                        format!("{} {}", fmt(p.angle + p.underlay_angle - 45.0), fmt(p.angle + p.underlay_angle + 45.0))
                    } else {
                        fmt(p.angle + p.underlay_angle)
                    },
                ));
                attrs.push(("fill_underlay_row_spacing_mm".into(), fmt(p.underlay_spacing)));
                attrs.push(("fill_underlay_inset_mm".into(), fmt(p.underlay_inset)));
                attrs.push(("fill_underlay_max_stitch_length_mm".into(), fmt(p.underlay_stitch_length)));
                let running = matches!(p.method, FillMethod::Meander | FillMethod::Circular);
                attrs.push(("running_stitch_length_mm".into(), fmt(if running { p.max_stitch_length } else { p.travel_length })));
                if p.method == FillMethod::Meander {
                    if let Some(t) = &p.meander_tile {
                        attrs.push(("meander_pattern".into(), t.clone()));
                    }
                    let sx = p.meander_scale / 2.5 * 100.0;
                    let scale = if (p.meander_aspect - 1.0).abs() > 1e-6 { format!("{} {}", fmt(sx), fmt(sx * p.meander_aspect)) } else { fmt(sx) };
                    attrs.push(("meander_scale_percent".into(), scale));
                    if p.meander_zigzag > 0.0 {
                        attrs.push(("zigzag_spacing_mm".into(), fmt(p.meander_zigzag)));
                        attrs.push(("zigzag_width_mm".into(), fmt(p.meander_zigzag_width)));
                    }
                    if p.meander_clip {
                        attrs.push(("clip".into(), "True".into()));
                    }
                    attrs.push(("meander_angle".into(), fmt(p.angle)));
                    attrs.push(("smoothness_mm".into(), fmt(p.smoothness * 2.0)));
                    attrs.push(("random_seed".into(), p.seed.to_string()));
                }
                if p.method != FillMethod::Meander {
                    push_random(&mut attrs, p.random_length, p.seed);
                }
                if let (FillMethod::Tartan, Some(t)) = (p.method, &p.tartan) {
                    let json = serde_json::json!({
                        "palette": t.palette,
                        "rotate": t.rotate,
                        "offset_x": t.offset[0],
                        "offset_y": t.offset[1],
                        "symmetry": t.symmetry,
                        "scale": t.scale,
                        "min_stripe_width": t.min_stripe_width,
                    });
                    attrs.push(("tartan".into(), json.to_string()));
                    attrs.push(("tartan_angle".into(), fmt(t.angle)));
                    attrs.push(("rows_per_thread".into(), t.rows_per_thread.to_string()));
                    if t.herringbone > 0.0 {
                        attrs.push(("herringbone_width_mm".into(), fmt(t.herringbone)));
                    }
                }
                if p.method == FillMethod::Cross {
                    let size = if p.cross_size_y > 0.0 { format!("{} {}", fmt(p.cross_size), fmt(p.cross_size_y)) } else { fmt(p.cross_size) };
                    attrs.push(("pattern_size_mm".into(), size));
                    if p.angle != 0.0 {
                        attrs.push(("cross_rotation".into(), fmt(-p.angle)));
                    }
                    attrs.push(("max_cross_stitch_length_mm".into(), fmt(p.cross_max_length)));
                    attrs.push(("fill_coverage".into(), fmt(p.cross_coverage * 100.0)));
                    let kind = match p.cross_kind {
                        CrossKind::Cross => "simple_cross",
                        CrossKind::Half => "half_cross",
                        CrossKind::Upright if p.cross_dense => "dense_upright_cross",
                        CrossKind::Upright => "upright_cross",
                        CrossKind::Double => "double_cross",
                        CrossKind::Smyrna => "smyrna_cross",
                    };
                    attrs.push(("cross_stitch_method".into(), if p.cross_flip { format!("{kind}_flipped") } else { kind.to_string() }));
                    if p.cross_threads > 1 {
                        attrs.push(("cross_thread_count".into(), p.cross_threads.to_string()));
                    }
                    attrs.push(("canvas_grid_origin".into(), b(p.cross_grid_canvas).into()));
                    if p.cross_offset != [0.0, 0.0] {
                        attrs.push(("cross_offset_mm".into(), format!("{} {}", fmt(p.cross_offset[0]), fmt(p.cross_offset[1]))));
                    }
                }
                if p.expand != 0.0 {
                    attrs.push(("expand_mm".into(), fmt(p.expand)));
                }
                if p.repeats > 1 {
                    attrs.push(("repeats".into(), p.repeats.to_string()));
                }
                if p.bean_repeats > 0 {
                    attrs.push(("bean_stitch_repeats".into(), p.bean_repeats.to_string()));
                }
                if p.method == FillMethod::Spiral {
                    attrs.push(("contour_strategy".into(), if p.contour_double { "double_spiral" } else { "single_spiral" }.into()));
                }
                if p.clockwise {
                    attrs.push(("clockwise".into(), "True".into()));
                }
                if p.pull_comp_pct > 0.0 {
                    attrs.push(("pull_compensation_percent".into(), fmt(p.pull_comp_pct * 100.0)));
                }
                if p.skip_last {
                    attrs.push(("skip_last".into(), "True".into()));
                }
                if p.underlay_skip_last {
                    attrs.push(("fill_underlay_skip_last".into(), "True".into()));
                }
                if !p.underpath {
                    attrs.push(("underpath".into(), "False".into()));
                }
                if p.gap_fill_rows > 0 {
                    attrs.push(("gap_fill_rows".into(), p.gap_fill_rows.to_string()));
                }
                if p.method == FillMethod::Guided {
                    attrs.push((
                        "guided_fill_strategy".into(),
                        match p.guided_strategy {
                            GuidedStrategy::Copy => "copy",
                            GuidedStrategy::Parallel => "parallel_offset",
                            GuidedStrategy::Buffer => "buffer",
                        }
                        .into(),
                    ));
                }
            }
            StitchParams::Satin(p) => {
                style = format!("fill:none;stroke:{color};stroke-width:0.3");
                if paths.len() == 1 {
                    // Ink/Stitch needs two rails: expand the centre line
                    let c = paths[0].flatten(0.05);
                    let r0 = offset_polyline(&c, -p.width / 2.0);
                    let r1 = offset_polyline(&c, p.width / 2.0);
                    paths = vec![SubPath::polyline(&r0, false), SubPath::polyline(&r1, false)];
                }
                // direction guides are Ink/Stitch rungs: two-point sub-paths
                // across both rails (lengthened a little so they cross them)
                for g in &p.guides {
                    let (a, b) = (Point::from_arr(g[0]), Point::from_arr(g[1]));
                    let u = (b - a).unit() * 0.3;
                    paths.push(SubPath::polyline(&[a - u, b + u], false));
                }
                attrs.push(("satin_column".into(), "True".into()));
                attrs.push((
                    "satin_method".into(),
                    match p.method {
                        SatinMethod::Satin => "satin_column",
                        SatinMethod::EStitch => "e_stitch",
                        SatinMethod::SStitch => "s_stitch",
                        SatinMethod::Zigzag => "zigzag",
                    }
                    .into(),
                ));
                attrs.push(("zigzag_spacing_mm".into(), fmt(p.spacing)));
                // Ink/Stitch adds them to each side
                attrs.push(("pull_compensation_mm".into(), fmt(p.pull_comp / 2.0)));
                attrs.push(("pull_compensation_percent".into(), fmt(p.pull_comp_pct / 2.0)));
                if p.max_stitch_length > 0.0 {
                    attrs.push(("max_stitch_length_mm".into(), fmt(p.max_stitch_length)));
                }
                attrs.push(("short_stitch_inset".into(), fmt(p.short_stitch_inset * 100.0)));
                attrs.push(("center_walk_underlay".into(), b(p.center_walk).into()));
                attrs.push(("contour_underlay".into(), b(p.contour_underlay).into()));
                attrs.push(("contour_underlay_inset_mm".into(), fmt(p.contour_inset)));
                attrs.push(("zigzag_underlay".into(), b(p.zigzag_underlay).into()));
                attrs.push(("zigzag_underlay_spacing_mm".into(), fmt(p.zigzag_underlay_spacing)));
                attrs.push(("zigzag_underlay_inset_mm".into(), fmt(p.zigzag_underlay_inset)));
                attrs.push(("center_walk_underlay_repeats".into(), p.center_walk_repeats.to_string()));
                attrs.push(("center_walk_underlay_position".into(), fmt(p.center_walk_position * 100.0)));
                attrs.push(("contour_underlay_stitch_length_mm".into(), fmt(p.underlay_stitch_length)));
                attrs.push(("center_walk_underlay_stitch_length_mm".into(), fmt(p.underlay_stitch_length)));
                if p.contour_inset_pct > 0.0 {
                    attrs.push(("contour_underlay_inset_percent".into(), fmt(p.contour_inset_pct * 100.0)));
                }
                if p.zigzag_inset_pct > 0.0 {
                    attrs.push(("zigzag_underlay_inset_percent".into(), fmt(p.zigzag_inset_pct * 100.0)));
                }
                if p.short_stitch_distance != 0.25 {
                    attrs.push(("short_stitch_distance_mm".into(), fmt(p.short_stitch_distance)));
                }
                if p.push_comp > 0.0 {
                    attrs.push(("push_compensation_mm".into(), fmt(p.push_comp)));
                }
                if p.random_wider > 0.0 || p.random_narrower > 0.0 {
                    attrs.push(("random_width_increase_percent".into(), fmt(p.random_wider * 100.0)));
                    attrs.push(("random_width_decrease_percent".into(), fmt(p.random_narrower * 100.0)));
                    attrs.push(("random_seed".into(), p.random_seed.to_string()));
                }
                if p.split_staggers > 1 {
                    attrs.push(("split_method".into(), "staggered".into()));
                    attrs.push(("split_staggers".into(), p.split_staggers.to_string()));
                }
                if p.random_spacing > 0.0 {
                    attrs.push(("random_zigzag_spacing_percent".into(), fmt(p.random_spacing * 100.0)));
                }
                if p.split_jitter > 0.0 {
                    attrs.push(("random_split_jitter_percent".into(), fmt(p.split_jitter * 100.0)));
                }
                if p.split_random_phase {
                    attrs.push(("random_split_phase".into(), "True".into()));
                    if p.split_min_length > 0.0 {
                        attrs.push(("min_random_split_length_mm".into(), fmt(p.split_min_length)));
                    }
                }
                if p.reverse_rails != RailReverse::Automatic {
                    let v = match p.reverse_rails {
                        RailReverse::None => "none",
                        RailReverse::First => "first",
                        RailReverse::Second => "second",
                        _ => "both",
                    };
                    attrs.push(("reverse_rails".into(), v.into()));
                }
                if p.random_spacing > 0.0 || p.split_jitter > 0.0 || p.split_random_phase || p.random_wider > 0.0 || p.random_narrower > 0.0 {
                    attrs.push(("random_seed".into(), p.random_seed.to_string()));
                }
                if p.zigzag_underlay_max_stitch > 0.0 {
                    attrs.push(("zigzag_underlay_max_stitch_length_mm".into(), fmt(p.zigzag_underlay_max_stitch)));
                }
            }
            StitchParams::Running(p) => {
                style = format!("fill:none;stroke:{color};stroke-width:{}", p.zigzag.as_ref().map_or("0.3".to_string(), |z| fmt(z.width)));
                let method = match (&p.ripple, &p.zigzag) {
                    (Some(_), _) => "ripple_stitch",
                    (None, Some(_)) => "zigzag_stitch",
                    _ => "running_stitch",
                };
                attrs.push(("stroke_method".into(), method.into()));
                if let Some(r) = &p.ripple {
                    attrs.push(("line_count".into(), r.lines.to_string()));
                    if r.min_line_dist > 0.0 {
                        attrs.push(("min_line_dist_mm".into(), fmt(r.min_line_dist)));
                    }
                    attrs.push(("skip_start".into(), r.skip_start.to_string()));
                    attrs.push(("skip_end".into(), r.skip_end.to_string()));
                    attrs.push(("flip_copies".into(), b(r.flip_copies).into()));
                    attrs.push(("exponent".into(), fmt(r.exponent)));
                    attrs.push(("flip_exponent".into(), b(r.flip_exponent).into()));
                    attrs.push(("staggers".into(), r.staggers.to_string()));
                    attrs.push(("join_style".into(), if r.join_point { "1" } else { "0" }.into()));
                    attrs.push(("grid_size_mm".into(), fmt(r.grid_size)));
                    attrs.push(("grid_first".into(), b(r.grid_first).into()));
                    let axis = match r.scale_axis {
                        RippleScaleAxis::Both => "0",
                        RippleScaleAxis::X => "1",
                        RippleScaleAxis::Y => "2",
                        RippleScaleAxis::None => "3",
                    };
                    attrs.push(("scale_axis".into(), axis.into()));
                    attrs.push(("scale_start".into(), fmt(r.scale_start)));
                    attrs.push(("scale_end".into(), fmt(r.scale_end)));
                    attrs.push(("rotate_ripples".into(), b(r.rotate_ripples).into()));
                    attrs.push(("manual_pattern_placement".into(), b(r.manual).into()));
                    let pos = match r.guide_position {
                        RippleGuidePosition::LineCount => "default",
                        RippleGuidePosition::Rungs => "render_at_rungs",
                        RippleGuidePosition::Adaptive => "adaptive",
                    };
                    attrs.push(("satin_guide_pattern_position".into(), pos.into()));
                    attrs.push(("reverse".into(), b(r.reverse).into()));
                }
                if let Some(z) = &p.zigzag {
                    attrs.push(("zigzag_spacing_mm".into(), fmt(z.spacing)));
                    if z.pull_comp != 0.0 {
                        attrs.push(("stroke_pull_compensation_mm".into(), fmt(z.pull_comp)));
                    }
                    if z.angle != 0.0 {
                        attrs.push(("zigzag_angle".into(), fmt(z.angle)));
                    }
                }
                let lengths = if p.length_pattern.is_empty() { fmt(p.length) } else { fmt_list(&p.length_pattern) };
                attrs.push(("running_stitch_length_mm".into(), lengths));
                attrs.push(("running_stitch_tolerance_mm".into(), fmt(p.tolerance)));
                attrs.push(("repeats".into(), p.repeats.to_string()));
                let beans: Vec<String> = p.beans().iter().map(|b| b.div_ceil(2).to_string()).collect();
                attrs.push(("bean_stitch_repeats".into(), beans.join(" ")));
                push_random(&mut attrs, p.random_length, p.random_seed);
                if p.cutwork_needle > 0 {
                    attrs.push(("cutwork_needle".into(), p.cutwork_needle.to_string()));
                }
            }
            StitchParams::Applique(_) => {
                // no Ink/Stitch equivalent: the outline as a running stitch, full settings in filum:params
                style = format!("fill:{color};fill-opacity:0.25;stroke:{color};stroke-width:0.3");
                attrs.push(("auto_fill".into(), "False".into()));
                attrs.push(("stroke_method".into(), "running_stitch".into()));
            }
            StitchParams::Manual(m) => {
                style = format!("fill:none;stroke:{color};stroke-width:0.2");
                attrs.push(("stroke_method".into(), "manual_stitch".into()));
                if m.max_length > 0.0 {
                    attrs.push(("max_stitch_length_mm".into(), fmt(m.max_length)));
                }
                if !m.bean_pattern.is_empty() {
                    let beans: Vec<String> = m.bean_pattern.iter().map(|b| b.div_ceil(2).to_string()).collect();
                    attrs.push(("bean_stitch_repeats".into(), beans.join(" ")));
                }
            }
            StitchParams::None => {
                style = format!("fill:{color};fill-opacity:0.35;stroke:none");
                attrs.push(("auto_fill".into(), "False".into()));
            }
        }
        if o.trim_after {
            attrs.push(("trim_after".into(), "True".into()));
        }
        if o.stop_after {
            attrs.push(("stop_after".into(), "True".into()));
        }
        if o.ties != Ties::Both {
            attrs.push(("ties".into(), match o.ties { Ties::Start => "start", Ties::End => "end", Ties::None => "none", Ties::Both => "both" }.into()));
        }
        if o.force_lock {
            attrs.push(("force_lock_stitches".into(), "True".into()));
        }
        if let Some(v) = o.min_stitch {
            attrs.push(("min_stitch_length_mm".into(), fmt(v)));
        }
        if let Some(v) = o.min_jump {
            attrs.push(("min_jump_stitch_length_mm".into(), fmt(v)));
        }
        // one value per attribute (several settings share e.g. the random seed)
        let mut seen = std::collections::HashSet::new();
        attrs.retain(|(k, _)| seen.insert(k.clone()));
        let ink: String = attrs.iter().map(|(k, v)| format!(" inkstitch:{k}=\"{}\"", esc(v))).collect();
        let hidden = if o.visible { "" } else { " display=\"none\"" };
        let rule = o.hidden.map(|h| format!(" filum:hidden=\"{}\"", esc(&serde_json::to_string(&h).unwrap_or_default()))).unwrap_or_default();
        // guided fills: the guide line, grouped with the fill (Ink/Stitch guide-line marker)
        // ripples: their guide line or satin guide, and the anchor line
        let (guide, guide_satin, anchor): (Option<Vec<SubPath>>, bool, Option<[[f64; 2]; 2]>) = match &o.stitch {
            StitchParams::Fill(p) if p.method == FillMethod::Guided => (Some(vec![p.guide.clone().unwrap_or_else(|| crate::stitches::inkfills::default_guide(o.bounds()))]), false, None),
            StitchParams::Running(RunningParams { ripple: Some(r), .. }) if !r.guide.is_empty() => (Some(r.guide.clone()), r.guide.len() >= 2, r.anchor),
            _ => (None, false, None),
        };
        let grouped = guide.is_some() || !o.patterns.is_empty();
        let indent = if grouped { "  " } else { "" };
        if grouped {
            body.push_str(&format!("    <g id=\"{}-group\" inkscape:label=\"{}\">\n", esc(&o.id), esc(&o.name)));
        }
        body.push_str(&format!(
            "    {indent}<path id=\"{}\" inkscape:label=\"{}\" style=\"{}\"{hidden} d=\"{}\"{ink} filum:params=\"{params}\"{rule} />\n",
            esc(&o.id),
            esc(&o.name),
            style,
            subpaths_to_d(&paths)
        ));
        if let Some(g) = &guide {
            if !markers.contains(&"guide-line") {
                markers.push("guide-line");
            }
            let satin = if guide_satin { " inkstitch:satin_column=\"True\"" } else { "" };
            body.push_str(&format!(
                "      <path id=\"{}-guide\" inkscape:label=\"Guide line\" style=\"fill:none;stroke:#ff5500;stroke-width:0.3;marker-start:url(#inkstitch-guide-line-marker)\" d=\"{}\"{satin} />\n",
                esc(&o.id),
                subpaths_to_d(g)
            ));
            if let Some([a, z]) = anchor {
                if !markers.contains(&"anchor-line") {
                    markers.push("anchor-line");
                }
                body.push_str(&format!(
                    "      <path id=\"{}-anchor\" inkscape:label=\"Anchor line\" style=\"fill:none;stroke:#0088ff;stroke-width:0.3;marker-start:url(#inkstitch-anchor-line-marker)\" d=\"M {} {} L {} {}\" />\n",
                    esc(&o.id),
                    fmt(a[0]),
                    fmt(a[1]),
                    fmt(z[0]),
                    fmt(z[1])
                ));
            }
        }
        for (k, p) in o.patterns.iter().enumerate() {
            if !markers.contains(&"pattern") {
                markers.push("pattern");
            }
            let style = match (p.add, p.remove) {
                (true, true) => "fill:#a0a0a0;fill-opacity:0.4;stroke:#606060;stroke-width:0.3",
                (false, true) => "fill:#a0a0a0;fill-opacity:0.4;stroke:none",
                _ => "fill:none;stroke:#606060;stroke-width:0.3",
            };
            let mut extra = String::new();
            if p.add && p.interval.iter().any(|v| *v > 1) || p.interval.len() > 1 {
                extra.push_str(&format!(" inkstitch:pattern_interval=\"{}\"", p.interval.iter().map(|v| v.to_string()).collect::<Vec<_>>().join(" ")));
            }
            if p.offset > 0 {
                extra.push_str(&format!(" inkstitch:pattern_offset=\"{}\"", p.offset));
            }
            body.push_str(&format!(
                "      <path id=\"{}-pattern{}\" inkscape:label=\"Pattern\" style=\"{style};marker-start:url(#inkstitch-pattern-marker)\" d=\"{}\"{extra} />\n",
                esc(&o.id),
                k + 1,
                subpaths_to_d(&p.paths)
            ));
        }
        if grouped {
            body.push_str("    </g>\n");
        }
        // commands: starting / ending position, target (ripple, circular centre)
        let b = o.bounds();
        let mut cmds: Vec<(&str, [f64; 2])> = Vec::new();
        if let Some(p) = o.start {
            cmds.push(("starting_point", p));
        }
        if let Some(p) = o.end {
            cmds.push(("ending_point", p));
        }
        match &o.stitch {
            StitchParams::Running(RunningParams { ripple: Some(RippleParams { target: Some(t), .. }), .. }) => cmds.push(("target_point", *t)),
            StitchParams::Fill(p) if p.method == FillMethod::Circular && !b.is_empty() => {
                cmds.push(("target_point", [b.min_x + b.width() * p.center[0], b.min_y + b.height() * p.center[1]]));
            }
            _ => {}
        }
        let centre = pt((b.min_x + b.max_x) / 2.0, (b.min_y + b.max_y) / 2.0);
        for (k, (cmd, at)) in cmds.into_iter().enumerate() {
            if !symbols.contains(&cmd) {
                symbols.push(cmd);
            }
            body.push_str(&command_group(&esc(&o.id), k, cmd, at, centre));
        }
    }
    // global commands (Ink/Stitch: standalone symbols anywhere in the document)
    for (cmd, at) in [("origin", doc.options.origin), ("stop_position", doc.options.stop_position)] {
        if let Some([x, y]) = at {
            symbols.push(cmd);
            body.push_str(&format!(
                "    <use id=\"inkstitch_global_{cmd}\" inkscape:label=\"command marker\" xlink:href=\"#inkstitch_{cmd}\" x=\"{}\" y=\"{}\" width=\"100%\" height=\"100%\" />\n",
                fmt(x),
                fmt(y)
            ));
        }
    }
    if !symbols.is_empty() || !markers.is_empty() {
        s.push_str("  <defs>\n");
        for c in &symbols {
            if let Some(x) = asset_element(INKSTITCH_SYMBOLS, &format!("inkstitch_{c}")) {
                s.push_str(&format!("    {x}\n"));
            }
        }
        for m in &markers {
            if let Some(x) = asset_element(INKSTITCH_MARKERS, &format!("inkstitch-{m}-marker")) {
                s.push_str(&format!("    {x}\n"));
            }
        }
        s.push_str("  </defs>\n");
    }
    s.push_str(&format!("  <g inkscape:groupmode=\"layer\" inkscape:label=\"{}\">\n", esc(&doc.name)));
    s.push_str(&body);
    s.push_str("  </g>\n</svg>\n");
    s
}

/// Ink/Stitch's tartan settings (`inkstitch:tartan` JSON and the tartan fill parameters).
fn ink_tartan(ink: &Ink) -> TartanParams {
    let d = TartanParams::default();
    let json: serde_json::Value = ink.get("tartan").and_then(|v| serde_json::from_str(v).ok()).unwrap_or(serde_json::Value::Null);
    let num = |k: &str, def: f64| json.get(k).and_then(|v| v.as_f64().or_else(|| v.as_str()?.parse().ok())).unwrap_or(def);
    TartanParams {
        palette: json.get("palette").and_then(|v| v.as_str()).map(|s| s.to_string()).unwrap_or(d.palette),
        rotate: num("rotate", 0.0),
        offset: [num("offset_x", 0.0), num("offset_y", 0.0)],
        symmetry: json.get("symmetry").and_then(|v| v.as_bool()).unwrap_or(true),
        scale: num("scale", 100.0),
        min_stripe_width: num("min_stripe_width", 1.0),
        angle: ink.f("tartan_angle", -45.0),
        rows_per_thread: ink.u("rows_per_thread", 2).max(1),
        herringbone: ink.f("herringbone_width_mm", 0.0).max(0.0),
        layer: 0,
        group: String::new(),
    }
}

/// Manual stitch bean repeats as a pattern (one value is a pattern of one).
fn manual_beans(ink: &Ink) -> Vec<u32> {
    match ink.beans() {
        (_, v) if !v.is_empty() => v,
        (0, _) => vec![],
        (b, _) => vec![b],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const INK: &str = r##"<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkstitch="http://inkstitch.org/namespace"
        width="100mm" height="50mm" viewBox="0 0 200 100">
      <g transform="translate(10,0)">
        <path d="M 0 0 L 40 0 L 40 40 L 0 40 Z" style="fill:#ff0000;stroke:none"
              inkstitch:angle="45" inkstitch:row_spacing_mm="0.3" inkstitch:fill_underlay="False"/>
        <path d="M 60 10 L 100 10 M 60 20 L 100 20" style="fill:none;stroke:#0000ff"
              inkstitch:satin_column="True" inkstitch:zigzag_spacing_mm="0.5" inkstitch:center_walk_underlay="True"/>
        <path d="M 0 60 C 20 50 40 70 60 60" style="fill:none;stroke:#00ff00"
              inkstitch:stroke_method="running_stitch" inkstitch:bean_stitch_repeats="2"/>
      </g>
      <circle cx="150" cy="50" r="10" fill="#123456"/>
      <text x="0" y="0">hi</text>
    </svg>"##;

    #[test]
    fn converts_inkstitch_units() {
        let svg = r##"<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkstitch="http://inkstitch.org/namespace" width="100mm" height="100mm" viewBox="0 0 100 100">
          <path d="M 10 10 L 60 10 M 10 20 L 60 20" style="fill:none;stroke:#000" inkstitch:satin_column="True" inkstitch:pull_compensation_mm="0.3" inkstitch:contour_underlay_inset_mm="0.6"/>
          <path d="M 10 40 L 60 40" style="fill:none;stroke:#000" inkstitch:stroke_method="running_stitch" inkstitch:bean_stitch_repeats="1"/>
          <path d="M 10 50 L 60 50" style="fill:none;stroke:#000;stroke-width:3" inkstitch:stroke_method="zigzag_stitch" inkstitch:stroke_pull_compensation_mm="0.2"/>
          <path d="M 10 60 L 60 60 L 60 90 L 10 90 Z" style="fill:#f00;stroke:none" inkstitch:fill_method="cross_stitch" inkstitch:pattern_size_mm="4" inkstitch:cross_stitch_method="half_cross"/>
          <path d="M 70 60 L 95 60 L 95 90 L 70 90 Z" style="fill:#0f0;stroke:none"/>
        </svg>"##;
        let d = import_svg(svg).unwrap().document;
        match &d.objects[0].stitch {
            StitchParams::Satin(s) => {
                assert!((s.pull_comp - 0.6).abs() < 1e-9, "per side 0.3 = 0.6 in total");
                assert!((s.zigzag_underlay_inset - 0.3).abs() < 1e-9, "half the contour inset");
            }
            s => panic!("{s:?}"),
        }
        assert!(matches!(&d.objects[1].stitch, StitchParams::Running(r) if r.bean_repeats == 2), "Ink/Stitch triple");
        // Ink/Stitch zig-zag line: its width, the pull compensation per side
        assert!(matches!(&d.objects[2].stitch, StitchParams::Running(r) if r.zigzag.as_ref().is_some_and(|z| (z.pull_comp - 0.2).abs() < 1e-9 && (z.width - 3.0).abs() < 1e-6)));
        match &d.objects[3].stitch {
            StitchParams::Fill(f) => {
                assert_eq!(f.method, FillMethod::Cross);
                assert_eq!(f.cross_size, 4.0);
                assert_eq!(f.cross_kind, CrossKind::Half);
                assert!(!f.underlay);
            }
            s => panic!("{s:?}"),
        }
        match &d.objects[4].stitch {
            StitchParams::Fill(f) => {
                assert_eq!(f.max_stitch_length, 4.0);
                assert_eq!(f.underlay_stitch_length, 4.0);
            }
            s => panic!("{s:?}"),
        }
        // and back: Ink/Stitch values again
        let out = export_svg(&d);
        assert!(out.contains("inkstitch:pull_compensation_mm=\"0.3\""), "{out}");
        assert!(out.contains("inkstitch:bean_stitch_repeats=\"1\""));
        assert!(out.contains("inkstitch:fill_method=\"cross_stitch\""));
        assert!(out.contains("inkstitch:cross_stitch_method=\"half_cross\""));
    }

    #[test]
    fn imports_inkstitch_params() {
        let r = import_svg(INK).unwrap();
        let d = &r.document;
        assert_eq!(d.objects.len(), 4);
        match &d.objects[0].stitch {
            StitchParams::Fill(f) => {
                assert_eq!(f.angle, 45.0);
                assert_eq!(f.row_spacing, 0.3);
                assert!(!f.underlay);
            }
            s => panic!("{s:?}"),
        }
        // viewBox 200 → 100mm: scale 0.5, translate 10 → x = 5mm
        assert!((d.objects[0].paths[0].nodes[0].p[0] - 5.0).abs() < 1e-9);
        assert!(matches!(&d.objects[1].stitch, StitchParams::Satin(s) if s.spacing == 0.5 && s.center_walk));
        assert_eq!(d.objects[1].paths.len(), 2);
        // Ink/Stitch bean 2 = quintuple = our 4
        assert!(matches!(&d.objects[2].stitch, StitchParams::Running(r) if r.bean_repeats == 4));
        assert!(matches!(&d.objects[3].stitch, StitchParams::Fill(_)));
        assert_eq!(d.threads.len(), 4);
        // the text is kept for lettering, not a warning
        assert!(r.warnings.is_empty(), "{:?}", r.warnings);
        assert_eq!(r.texts.len(), 1);
    }

    /// Ink/Stitch commands (connector + symbol), guide-line markers, ignore
    /// commands and meander / circular parameters, as Ink/Stitch writes them.
    const INK_COMMANDS: &str = r##"<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkstitch="http://inkstitch.org/namespace"
        xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" xmlns:xlink="http://www.w3.org/1999/xlink"
        width="100mm" height="100mm" viewBox="0 0 100 100">
      <defs><symbol id="inkstitch_starting_point"><path d="M 0 0 L 1 1"/></symbol></defs>
      <g inkscape:groupmode="layer">
        <path id="fill1" d="M 0 0 L 40 0 L 40 40 L 0 40 Z" style="fill:#ff0000" inkstitch:fill_method="meander_fill"
              inkstitch:meander_pattern="P3-1" inkstitch:meander_scale_percent="200" inkstitch:meander_angle="30"
              inkstitch:running_stitch_length_mm="1.8" inkstitch:random_seed="5"/>
        <g inkscape:label="Ink/Stitch Command: Starting position" transform="translate(2,3)">
          <path d="M 3,4 20,20" inkscape:connection-start="#use1" inkscape:connection-end="#fill1" style="fill:none;stroke:#000;display:none"/>
          <use id="use1" xlink:href="#inkstitch_starting_point" x="3" y="4"/>
        </g>
        <g>
          <path d="M 60 0 L 100 0 L 100 40 L 60 40 Z" style="fill:#00ff00" inkstitch:fill_method="guided_fill"/>
          <path d="M 60 20 C 70 10 90 30 100 20" style="fill:none;stroke:#000;marker-start:url(#inkstitch-guide-line-marker)"/>
        </g>
        <path id="circ" d="M 0 60 L 40 60 L 40 100 L 0 100 Z" style="fill:#0000ff" inkstitch:fill_method="circular_fill"/>
        <g><path d="M 10,70 20,80" inkscape:connection-start="#circ" inkscape:connection-end="#use2" inkscape:connector-type="polyline"/>
           <use id="use2" xlink:href="#inkstitch_target_point" x="10" y="70"/></g>
        <path id="trimmed" d="M 50 60 L 90 60" style="fill:none;stroke:#000" inkstitch:stroke_method="running_stitch"/>
        <g><path d="M 50,60 60,60" inkscape:connection-start="#use3" inkscape:connection-end="#trimmed"/>
           <use id="use3" xlink:href="#inkstitch_trim" x="50" y="55"/></g>
        <path id="gone" d="M 50 70 L 90 70" style="fill:none;stroke:#000"/>
        <g><path d="M 50,70 60,70" inkscape:connection-start="#use4" inkscape:connection-end="#gone"/>
           <use id="use4" xlink:href="#inkstitch_ignore_object" x="50" y="75"/></g>
        <path d="M 50 80 L 90 80" style="fill:none;stroke:#000" inkstitch:ignore_object="True"/>
      </g>
      <g inkscape:groupmode="layer"><use xlink:href="#inkstitch_ignore_layer" x="0" y="0"/>
        <path d="M 0 0 L 10 10" style="fill:none;stroke:#000"/></g>
    </svg>"##;

    #[test]
    fn imports_inkstitch_commands_and_markers() {
        let r = import_svg(INK_COMMANDS).unwrap();
        let d = &r.document;
        let names: Vec<&str> = d.objects.iter().map(|o| o.name.as_str()).collect();
        // connectors, symbols, guide lines, ignored objects and layers are not objects
        assert_eq!(d.objects.len(), 4, "{names:?} {:?}", r.warnings);
        let fill = &d.objects[0];
        assert_eq!(fill.start, Some([5.0, 7.0]));
        match &fill.stitch {
            StitchParams::Fill(f) => {
                assert_eq!(f.method, FillMethod::Meander);
                assert_eq!(f.meander_tile.as_deref(), Some("P3-1"));
                assert_eq!(f.meander_scale, 5.0);
                assert_eq!(f.angle, 30.0);
                assert_eq!(f.max_stitch_length, 1.8);
                assert_eq!(f.seed, 5);
            }
            s => panic!("{s:?}"),
        }
        match &d.objects[1].stitch {
            StitchParams::Fill(f) => {
                assert_eq!(f.method, FillMethod::Guided);
                let g = f.guide.as_ref().expect("guide line");
                assert_eq!(g.nodes[0].p, [60.0, 20.0]);
            }
            s => panic!("{s:?}"),
        }
        match &d.objects[2].stitch {
            StitchParams::Fill(f) => assert_eq!(f.center, [0.25, 0.25]),
            s => panic!("{s:?}"),
        }
        assert!(d.objects[3].trim_after);
        assert!(r.warnings.iter().all(|w| !w.contains("clone")), "{:?}", r.warnings);
    }

    #[test]
    fn exports_inkstitch_commands_and_markers() {
        let r = import_svg(INK_COMMANDS).unwrap();
        let mut doc = r.document.clone();
        doc.objects[0].end = Some([30.0, 30.0]);
        let svg = export_svg(&doc);
        // valid XML with the symbols and the marker Ink/Stitch needs
        roxmltree::Document::parse(&svg).unwrap();
        assert!(svg.contains("<symbol") && svg.contains("id=\"inkstitch_starting_point\"") && svg.contains("id=\"inkstitch_ending_point\""));
        assert!(svg.contains("id=\"inkstitch_target_point\"") && svg.contains("id=\"inkstitch-guide-line-marker\""));
        assert!(svg.contains("inkstitch:meander_pattern=\"P3-1\""));
        let back = import_svg(&svg).unwrap().document;
        assert_eq!(back.objects.len(), doc.objects.len());
        for (a, b) in doc.objects.iter().zip(&back.objects) {
            assert_eq!(a.start, b.start);
            assert_eq!(a.end, b.end);
            assert_eq!(a.trim_after, b.trim_after);
            assert_eq!(a.stitch, b.stitch, "{}", a.name);
        }
        // Ink/Stitch-only reading (without our params) keeps the commands too
        let plain: String = svg.lines().map(|l| l.split(" filum:params=").next().unwrap().to_string() + if l.contains(" filum:params=") { " />" } else { "" }).collect::<Vec<_>>().join("\n");
        let ink = import_svg(&plain).unwrap().document;
        assert_eq!(ink.objects[0].start, Some([5.0, 7.0]));
        assert_eq!(ink.objects[0].end, Some([30.0, 30.0]));
        assert!(matches!(&ink.objects[1].stitch, StitchParams::Fill(f) if f.guide.is_some()));
    }

    #[test]
    fn cross_hatched_underlay_is_an_angle_list() {
        // Ink/Stitch: fill_underlay_angle takes a list of angles
        let mut r = import_svg(INK).unwrap();
        let o = r.document.objects.iter_mut().find(|o| matches!(o.stitch, StitchParams::Fill(_))).unwrap();
        if let StitchParams::Fill(f) = &mut o.stitch {
            f.underlay = true;
            f.underlay_cross = true;
            f.underlay_angle = 90.0;
        }
        let svg = export_svg(&r.document);
        let back = import_svg(&svg).unwrap();
        let f = back.document.objects.iter().find_map(|o| if let StitchParams::Fill(f) = &o.stitch { Some(f.clone()) } else { None }).unwrap();
        assert!(f.underlay_cross && (f.underlay_angle - 90.0).abs() < 1e-6, "{} {}", f.underlay_cross, f.underlay_angle);
    }

    #[test]
    fn export_roundtrip() {
        let r = import_svg(INK).unwrap();
        let svg = export_svg(&r.document);
        assert!(svg.contains("inkstitch:satin_column=\"True\""));
        let back = import_svg(&svg).unwrap();
        assert_eq!(back.document.objects.len(), r.document.objects.len());
        for (a, b) in r.document.objects.iter().zip(back.document.objects.iter()) {
            assert_eq!(a.stitch, b.stitch);
            let (pa, pb) = (a.paths[0].nodes[0].p, b.paths[0].nodes[0].p);
            assert!((pa[0] - pb[0]).abs() < 1e-3 && (pa[1] - pb[1]).abs() < 1e-3);
        }
    }

    #[test]
    fn keeps_an_objects_hidden_stitching_rule() {
        let mut doc = import_svg(INK).unwrap().document;
        let rule = crate::model::HiddenRule { covers: crate::model::CoverMode::Never, keep: true };
        doc.objects[0].hidden = Some(rule);
        let back = import_svg(&export_svg(&doc)).unwrap().document;
        assert_eq!(back.objects[0].hidden, Some(rule));
        assert_eq!(back.objects[1].hidden, None);
    }

    #[test]
    fn reads_and_writes_stitch_patterns_random_lengths_zigzag_and_manual() {
        let svg = r##"<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkstitch="http://inkstitch.org/namespace" viewBox="0 0 100 100" width="100mm" height="100mm">
          <path id="a" d="M 10 10 L 60 10" style="fill:none;stroke:#000;stroke-width:0.3" inkstitch:stroke_method="running_stitch" inkstitch:running_stitch_length_mm="2 1" inkstitch:bean_stitch_repeats="0 1" inkstitch:enable_random_stitch_length="True" inkstitch:random_stitch_length_jitter_percent="15" inkstitch:random_seed="4" inkstitch:min_stitch_length_mm="0.5" inkstitch:min_jump_stitch_length_mm="6"/>
          <path id="b" d="M 10 30 L 60 30" style="fill:none;stroke:#000;stroke-width:3" inkstitch:stroke_method="zigzag_stitch" inkstitch:zigzag_spacing_mm="0.8" inkstitch:zigzag_angle="30" inkstitch:stroke_pull_compensation_mm="0.2"/>
          <path id="c" d="M 10 50 L 60 50" style="fill:none;stroke:#000;stroke-width:0.3" inkstitch:stroke_method="manual_stitch" inkstitch:max_stitch_length_mm="4" inkstitch:bean_stitch_repeats="1"/>
          <path id="d" d="M 10 60 L 60 60 L 60 90 L 10 90 Z" style="fill:#f00" inkstitch:fill_method="tatami_fill" inkstitch:enable_random_stitch_length="True"/>
        </svg>"##;
        let doc = import_svg(svg).unwrap().document;
        let StitchParams::Running(a) = &doc.objects[0].stitch else { panic!() };
        assert_eq!(a.length_pattern, vec![2.0, 1.0]);
        assert_eq!(a.bean_pattern, vec![0, 2]);
        assert_eq!((a.random_length, a.random_seed), (15.0, 4));
        assert_eq!((doc.objects[0].min_stitch, doc.objects[0].min_jump), (Some(0.5), Some(6.0)));
        let StitchParams::Running(b) = &doc.objects[1].stitch else { panic!("zig-zag is a running line") };
        let z = b.zigzag.as_ref().unwrap();
        assert!((z.width - 3.0).abs() < 1e-6 && z.spacing == 0.8 && z.angle == 30.0 && z.pull_comp == 0.2, "{z:?}");
        let StitchParams::Manual(c) = &doc.objects[2].stitch else { panic!() };
        assert_eq!((c.max_length, c.bean_pattern.clone()), (4.0, vec![2]));
        let StitchParams::Fill(d) = &doc.objects[3].stitch else { panic!() };
        assert_eq!(d.random_length, 10.0, "Ink/Stitch's default jitter");
        // written back the Ink/Stitch way
        let out = export_svg(&doc);
        for attr in [
            "running_stitch_length_mm=\"2 1\"",
            "bean_stitch_repeats=\"0 1\"",
            "random_stitch_length_jitter_percent=\"15\"",
            "min_jump_stitch_length_mm=\"6\"",
            "stroke_method=\"zigzag_stitch\"",
            "zigzag_angle=\"30\"",
            "max_stitch_length_mm=\"4\"",
            "enable_random_stitch_length=\"True\"",
        ] {
            assert!(out.contains(attr), "{attr} in export");
        }
    }

    #[test]
    fn reads_and_writes_guided_ripples() {
        let svg = r##"<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkstitch="http://inkstitch.org/namespace" viewBox="0 0 100 100" width="100mm" height="100mm">
          <g>
            <path d="M 10 10 L 20 10" style="fill:none;stroke:#000;stroke-width:0.3" inkstitch:stroke_method="ripple_stitch" inkstitch:line_count="7" inkstitch:skip_start="1" inkstitch:staggers="3" inkstitch:join_style="1" inkstitch:scale_axis="2" inkstitch:satin_guide_pattern_position="adaptive"/>
            <path d="M 10 30 L 90 30 M 10 40 L 90 40" style="fill:none;stroke:#f00;marker-start:url(#inkstitch-guide-line-marker)" inkstitch:satin_column="True"/>
            <path d="M 10 10 L 20 10" style="fill:none;stroke:#00f;marker-start:url(#inkstitch-anchor-line-marker)"/>
          </g>
        </svg>"##;
        let r = import_svg(svg).unwrap();
        assert_eq!(r.document.objects.len(), 1, "guide and anchor are not objects");
        let StitchParams::Running(RunningParams { ripple: Some(rp), .. }) = &r.document.objects[0].stitch else { panic!() };
        assert_eq!((rp.lines, rp.skip_start, rp.staggers, rp.join_point), (7, 1, 3, true));
        assert_eq!((rp.scale_axis, rp.guide_position, rp.scale_end), (RippleScaleAxis::Y, RippleGuidePosition::Adaptive, 0.0));
        assert_eq!(rp.guide.len(), 2, "a satin guide");
        assert_eq!(rp.anchor, Some([[10.0, 10.0], [20.0, 10.0]]));
        let out = export_svg(&r.document);
        roxmltree::Document::parse(&out).unwrap();
        assert!(out.contains("inkstitch-anchor-line-marker") && out.contains("satin_column=\"True\""));
        assert!(out.contains("satin_guide_pattern_position=\"adaptive\""));
        // and it stitches
        let plan = crate::Engine::new().plan(&r.document);
        assert!(plan.stitches.len() > 50);
    }

    #[test]
    fn imports_clones_clip_paths_gradients_and_text() {
        let svg = r##"<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:inkstitch="http://inkstitch.org/namespace" viewBox="0 0 100 100" width="100mm" height="100mm">
          <defs>
            <clipPath id="cp"><rect x="0" y="0" width="50" height="100"/></clipPath>
            <symbol id="sym"><rect x="0" y="0" width="5" height="5" style="fill:#00f"/></symbol>
            <linearGradient id="lg" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#ff0000"/><stop offset="100%" style="stop-color:#0000ff"/></linearGradient>
          </defs>
          <rect id="orig" x="10" y="10" width="10" height="10" style="fill:#f00" inkstitch:angle="0"/>
          <use xlink:href="#orig" transform="rotate(90 50 50)"/>
          <use href="#orig" x="20" inkstitch:angle="30"/>
          <use href="#sym" x="80" y="80"/>
          <g clip-path="url(#cp)">
            <rect x="30" y="60" width="40" height="10" style="fill:#0f0"/>
            <path d="M 30 80 L 90 80" style="fill:none;stroke:#000;stroke-width:0.3"/>
          </g>
          <rect x="60" y="10" width="30" height="20" style="fill:url(#lg)"/>
          <rect x="60" y="40" width="30" height="10" style="fill:url(#lg)" inkstitch:fill_method="linear_gradient_fill"/>
          <text x="10" y="95" style="font-size:8px;fill:#123456;font-family:Sans">Hi there</text>
        </svg>"##;
        let r = import_svg(svg).unwrap();
        let o = &r.document.objects;
        // the original, then its two linked clones in document order
        assert_eq!(o[1].clone.as_ref().map(|c| c.of.as_str()), Some(o[0].id.as_str()));
        let StitchParams::Fill(f1) = &o[1].stitch else { panic!() };
        assert!((f1.angle.rem_euclid(180.0) - 90.0).abs() < 1e-6, "turned with the clone: {}", f1.angle);
        let StitchParams::Fill(f2) = &o[2].stitch else { panic!() };
        assert_eq!(f2.angle, 30.0, "own angle of the clone");
        assert_eq!(o[2].clone.as_ref().unwrap().angle, Some(30.0));
        assert!((o[2].bounds().min_x - 30.0).abs() < 1e-6, "moved by x");
        // a symbol from defs: a plain copy
        assert!(o[3].clone.is_none() && (o[3].bounds().min_x - 80.0).abs() < 1e-6);
        // clipped to x <= 50
        assert!(o[4].bounds().max_x <= 50.0 + 1e-6 && (o[4].bounds().max_x - 50.0).abs() < 0.1, "fill clipped: {:?}", o[4].bounds());
        assert!(o[5].bounds().max_x <= 50.0 + 1e-6, "line clipped");
        // a plain gradient: two blended layers; Ink/Stitch linear gradient fill: rows
        let grads: Vec<&FillParams> = o.iter().filter_map(|x| if let StitchParams::Fill(f) = &x.stitch { f.gradient.as_ref().map(|_| f) } else { None }).collect();
        assert_eq!(grads.len(), 4);
        assert_eq!(grads[0].gradient.as_ref().unwrap().mix, GradientMix::Blend);
        assert_eq!(grads[2].gradient.as_ref().unwrap().mix, GradientMix::Rows);
        assert!((grads[2].angle.rem_euclid(180.0) - 90.0).abs() < 1e-6, "rows across a horizontal gradient: {}", grads[2].angle);
        assert_eq!(r.document.thread(&o[6].thread).map(|t| t.color.clone()), Some("#ff0000".to_string()));
        // text kept for lettering
        assert_eq!(r.texts.len(), 1);
        assert_eq!(r.texts[0].text, "Hi there");
        assert_eq!(r.texts[0].index, o.len(), "after every object before it in the document, clones included");
        assert!((r.texts[0].size - 8.0).abs() < 1e-6 && r.texts[0].color == "#123456");
        assert!(r.warnings.iter().all(|w| !w.contains("clone") && !w.contains("Text")), "{:?}", r.warnings);
    }

    #[test]
    fn imports_and_exports_tartan_fills() {
        let svg = r##"<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkstitch="http://inkstitch.org/namespace" viewBox="0 0 100 100" width="100mm" height="100mm">
          <rect x="10" y="10" width="40" height="40" style="fill:#000" inkstitch:fill_method="tartan_fill" inkstitch:rows_per_thread="3" inkstitch:tartan_angle="45" inkstitch:tartan="{&quot;palette&quot;: &quot;(#0000FF)/4 (#FFFFFF)0.5 (#FF0000)/4&quot;, &quot;rotate&quot;: 10, &quot;offset_x&quot;: 0, &quot;offset_y&quot;: 0, &quot;symmetry&quot;: true, &quot;scale&quot;: 100, &quot;min_stripe_width&quot;: 1.0}"/>
        </svg>"##;
        let doc = import_svg(svg).unwrap().document;
        assert_eq!(doc.objects.len(), 3, "a layer per colour");
        let colors: Vec<String> = doc.objects.iter().map(|o| doc.thread(&o.thread).unwrap().color.clone()).collect();
        assert_eq!(colors, vec!["#0000ff", "#ffffff", "#ff0000"]);
        let StitchParams::Fill(f) = &doc.objects[1].stitch else { panic!() };
        let t = f.tartan.as_ref().unwrap();
        assert_eq!((f.method, t.layer, t.rows_per_thread, t.angle, t.rotate), (FillMethod::Tartan, 1, 3, 45.0, 10.0));
        let plan = crate::Engine::new().plan(&doc);
        assert!(plan.stitches.len() > 500);
        // written back as one Ink/Stitch element, read back as the same layers
        let out = export_svg(&doc);
        assert_eq!(out.matches("tartan_fill").count(), 1);
        let back = import_svg(&out).unwrap().document;
        assert_eq!(back.objects.len(), 3);
    }
}
