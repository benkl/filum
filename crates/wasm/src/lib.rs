//! WebAssembly bindings: the same Rust engine runs in the browser, in the
//! Tauri desktop/mobile shells (inside a Web Worker) and natively in the CLI.

use js_sys::{Float32Array, Object, Reflect, Uint32Array, Uint8Array};
use filum_core::{io, optimize, svg, threads, Document, Engine};
use wasm_bindgen::prelude::*;

fn err<E: std::fmt::Display>(e: E) -> JsValue {
    JsValue::from_str(&e.to_string())
}

fn parse_doc(json: &str) -> Result<Document, JsValue> {
    serde_json::from_str(json).map_err(|e| err(format!("invalid document: {e}")))
}

fn set(o: &Object, k: &str, v: &JsValue) {
    let _ = Reflect::set(o, &JsValue::from_str(k), v);
}

#[wasm_bindgen]
pub struct StitchEngine {
    engine: Engine,
}

#[wasm_bindgen]
impl StitchEngine {
    #[wasm_bindgen(constructor)]
    pub fn new() -> StitchEngine {
        StitchEngine { engine: Engine::new() }
    }

    /// Generate the stitch plan. Returns
    /// `{ coords: Float32Array(x,y,...), flags: Uint8Array, objects: Uint32Array, meta: string(JSON) }`
    /// where meta = `{ threads, stats, bounds }`.
    pub fn plan(&mut self, doc_json: &str) -> Result<JsValue, JsValue> {
        let doc = parse_doc(doc_json)?;
        let plan = self.engine.plan(&doc);
        Ok(plan_js(&plan, &doc))
    }

    /// The plan as it goes into a file (repeats, frame out on stops), in the
    /// same shape as `plan` — for pictures of the export (PNG, print).
    #[wasm_bindgen(js_name = exportPlan)]
    pub fn export_plan(&mut self, doc_json: &str, opts_json: &str) -> Result<JsValue, JsValue> {
        let doc = parse_doc(doc_json)?;
        let opts: io::ExportOptions = serde_json::from_str(if opts_json.trim().is_empty() { "{}" } else { opts_json }).map_err(err)?;
        let plan = io::export_plan(&doc, &mut self.engine, &opts);
        Ok(plan_js(&plan, &doc))
    }

    /// The density of the design on its fabric (`density::density_field`):
    /// `{ layers, holes, added: Float32Array, class: Uint8Array, meta: string(JSON) }`
    /// where meta = `{ x0, y0, cell, cols, rows, limits, stats, hotspots }`.
    #[wasm_bindgen(js_name = densityField)]
    pub fn density_field(&mut self, doc_json: &str, opts_json: &str) -> Result<JsValue, JsValue> {
        let doc = parse_doc(doc_json)?;
        let opts: filum_core::density::DensityOptions = serde_json::from_str(if opts_json.trim().is_empty() { "{}" } else { opts_json }).map_err(err)?;
        let plan = self.engine.plan(&doc);
        let f = filum_core::density::density_field(&doc, &plan, &opts);
        let meta = serde_json::json!({ "x0": f.x0, "y0": f.y0, "cell": f.cell, "cols": f.cols, "rows": f.rows, "limits": f.limits, "stats": f.stats, "hotspots": f.hotspots });
        let o = Object::new();
        set(&o, "layers", &Float32Array::from(&f.layers[..]).into());
        set(&o, "holes", &Float32Array::from(&f.holes[..]).into());
        set(&o, "added", &Float32Array::from(&f.added[..]).into());
        set(&o, "class", &Uint8Array::from(&f.class[..]).into());
        set(&o, "meta", &JsValue::from_str(&meta.to_string()));
        Ok(o.into())
    }

    /// The objects cut by hidden-stitch removal, as they are stitched: JSON
    /// `[{ index, paths }]` (empty paths: hidden completely). Objects left whole
    /// are not listed.
    #[wasm_bindgen(js_name = stitchedShapes)]
    pub fn stitched_shapes(&mut self, doc_json: &str) -> Result<String, JsValue> {
        let doc = parse_doc(doc_json)?;
        let mut out = Vec::new();
        for i in 0..doc.objects.len() {
            if !doc.objects[i].visible {
                continue;
            }
            match self.engine.stitched_object(&doc, i) {
                None => out.push(serde_json::json!({ "index": i, "paths": [] })),
                Some(std::borrow::Cow::Owned(o)) => out.push(serde_json::json!({ "index": i, "paths": o.paths })),
                Some(_) => {}
            }
        }
        serde_json::to_string(&out).map_err(err)
    }

    /// Element info of the objects `ids` (all when empty): JSON `ElementInfo`.
    #[wasm_bindgen(js_name = elementInfo)]
    pub fn element_info(&mut self, doc_json: &str, ids_json: &str) -> Result<String, JsValue> {
        let doc = parse_doc(doc_json)?;
        let ids: Vec<String> = serde_json::from_str(ids_json).map_err(err)?;
        serde_json::to_string(&filum_core::info::element_info(&doc, &mut self.engine, &ids)).map_err(err)
    }

    /// Apply a thread list (one entry per colour block) to the design's
    /// colours: JSON `{ document, report }`.
    #[wasm_bindgen(js_name = applyThreadList)]
    pub fn apply_thread_list(&mut self, doc_json: &str, entries_json: &str) -> Result<String, JsValue> {
        let doc = parse_doc(doc_json)?;
        let entries: Vec<filum_core::threadlist::ThreadListEntry> = serde_json::from_str(entries_json).map_err(err)?;
        let (document, report) = filum_core::threadlist::apply_thread_list(&doc, &mut self.engine, &entries);
        serde_json::to_string(&serde_json::json!({ "document": document, "report": report })).map_err(err)
    }

    /// Shapes rebuilt from the stitches of the objects `ids` (Ink/Stitch
    /// outline): JSON `[{ id, paths: SubPath[] }]`.
    #[wasm_bindgen(js_name = stitchOutline)]
    pub fn stitch_outline(&mut self, doc_json: &str, ids_json: &str, params_json: &str) -> Result<String, JsValue> {
        let doc = parse_doc(doc_json)?;
        let ids: Vec<String> = serde_json::from_str(ids_json).map_err(err)?;
        let p: filum_core::stitch_outline::OutlineParams = serde_json::from_str(if params_json.trim().is_empty() { "{}" } else { params_json }).map_err(err)?;
        let out: Vec<serde_json::Value> = (0..doc.objects.len())
            .filter(|&i| ids.contains(&doc.objects[i].id))
            .map(|i| serde_json::json!({ "id": doc.objects[i].id, "paths": filum_core::stitch_outline::object_outline(&doc, &mut self.engine, i, &p) }))
            .collect();
        serde_json::to_string(&out).map_err(err)
    }

    /// Optimise stitch order. Returns JSON `OptimizeReport`.
    pub fn optimize(&mut self, doc_json: &str) -> Result<String, JsValue> {
        let doc = parse_doc(doc_json)?;
        let r = optimize::optimize_order(&doc, &mut self.engine);
        serde_json::to_string(&r).map_err(err)
    }

    /// Export to a machine format ("dst", "pes", "jef", "exp", "vp3", ...), or "svg"/"json".
    pub fn export(&mut self, doc_json: &str, format: &str, opts_json: &str) -> Result<Uint8Array, JsValue> {
        let doc = parse_doc(doc_json)?;
        let opts: io::ExportOptions = serde_json::from_str(if opts_json.trim().is_empty() { "{}" } else { opts_json }).map_err(err)?;
        let bytes = io::export_with(&doc, &mut self.engine, format, &opts).map_err(err)?;
        Ok(Uint8Array::from(&bytes[..]))
    }

    /// What the machine will show for each colour block (JSON `MachineColorInfo[]`).
    #[wasm_bindgen(js_name = machineColors)]
    pub fn machine_colors(&mut self, doc_json: &str, format: &str, opts_json: &str) -> Result<String, JsValue> {
        let doc = parse_doc(doc_json)?;
        let opts: io::ExportOptions = serde_json::from_str(if opts_json.trim().is_empty() { "{}" } else { opts_json }).map_err(err)?;
        let r = io::machine_colors(&doc, &mut self.engine, format, &opts).map_err(err)?;
        serde_json::to_string(&r).map_err(err)
    }
}

/// A stitch plan as `{ coords: Float32Array(x,y,...), flags: Uint8Array, objects: Uint32Array, meta: string(JSON) }`
/// where meta = `{ threads, stats, bounds }`.
fn plan_js(plan: &filum_core::StitchPlan, doc: &Document) -> JsValue {
    let n = plan.stitches.len();
    let mut coords = Vec::with_capacity(n * 2);
    let mut fl = Vec::with_capacity(n);
    let mut ob = Vec::with_capacity(n);
    for s in &plan.stitches {
        coords.push(s.x as f32);
        coords.push(s.y as f32);
        fl.push(s.flags);
        ob.push(s.object);
    }
    let m = &doc.machine;
    let stats = plan.stats(m.spm, m.trim_seconds, m.color_change_seconds);
    let meta = serde_json::json!({ "threads": plan.threads, "stats": stats, "bounds": plan.bounds() });
    let o = Object::new();
    set(&o, "coords", &Float32Array::from(&coords[..]).into());
    set(&o, "flags", &Uint8Array::from(&fl[..]).into());
    set(&o, "objects", &Uint32Array::from(&ob[..]).into());
    set(&o, "meta", &JsValue::from_str(&meta.to_string()));
    o.into()
}

impl Default for StitchEngine {
    fn default() -> Self {
        Self::new()
    }
}

/// Import an SVG (plain or Ink/Stitch-annotated). Returns JSON `{document, warnings}`.
#[wasm_bindgen(js_name = importSvg)]
pub fn import_svg(text: &str) -> Result<String, JsValue> {
    let r = svg::import_svg(text).map_err(err)?;
    serde_json::to_string(&r).map_err(err)
}

/// Outline (union grown by `offset` mm, negative shrinks) of the given objects:
/// closed sub-paths as JSON (outlines & offsets, appliqué backing).
#[wasm_bindgen(js_name = outlineShapes)]
pub fn outline_shapes(doc_json: &str, ids_json: &str, offset: f64, bridge: f64, outer_only: bool, min_area: f64) -> Result<String, JsValue> {
    use filum_core::region::{object_cover, outline_with, OutlineOptions};
    let doc = parse_doc(doc_json)?;
    let ids: Vec<String> = serde_json::from_str(ids_json).map_err(err)?;
    let covers: Vec<_> = doc.objects.iter().filter(|o| ids.contains(&o.id)).flat_map(object_cover).collect();
    let rings = outline_with(&covers, &OutlineOptions { offset, bridge, outer_only, min_area });
    // exact polygons fitted back to smooth Béziers (corners stay sharp)
    let paths: Vec<filum_core::SubPath> = rings.iter().map(|r| filum_core::clip::fit_ring(r, 0.02, 30.0)).collect();
    serde_json::to_string(&paths).map_err(err)
}

/// Shape booleans: unite, minusFront, intersect or exclude the given objects (in
/// stacking order). Closed sub-paths as JSON.
#[wasm_bindgen(js_name = booleanShapes)]
pub fn boolean_shapes(doc_json: &str, ids_json: &str, op: &str) -> Result<String, JsValue> {
    use filum_core::region::{boolean, covers_bounds, object_cover, BoolOp};
    let doc = parse_doc(doc_json)?;
    let ids: Vec<String> = serde_json::from_str(ids_json).map_err(err)?;
    let op = match op {
        "unite" => BoolOp::Unite,
        "minusFront" => BoolOp::MinusFront,
        "intersect" => BoolOp::Intersect,
        "exclude" => BoolOp::Exclude,
        other => return Err(err(format!("unknown operation {other}"))),
    };
    let objects: Vec<Vec<_>> = doc.objects.iter().filter(|o| ids.contains(&o.id)).map(object_cover).collect();
    let all: Vec<_> = objects.iter().flatten().cloned().collect();
    let b = covers_bounds(&all);
    let res = (b.width().max(b.height()) / 1500.0).clamp(0.03, 0.2);
    let rings = boolean(&objects, op, res);
    // exact polygons fitted back to smooth Béziers (corners stay sharp)
    let paths: Vec<filum_core::SubPath> = rings.iter().map(|r| filum_core::clip::fit_ring(r, 0.02, 30.0)).collect();
    serde_json::to_string(&paths).map_err(err)
}

/// Shape Builder: the regions of the overlap arrangement of the given objects
/// (stacking order) — every connected area covered by one set of them.
/// JSON: [{ rings: [[[x, y], …], …], owners: [id, …] }].
#[wasm_bindgen(js_name = shapeRegions)]
pub fn shape_regions(doc_json: &str, ids_json: &str) -> Result<String, JsValue> {
    let (objects, ids) = builder_objects(doc_json, ids_json)?;
    let faces = filum_core::region::arrangement(&objects);
    let out: Vec<serde_json::Value> = faces
        .iter()
        .map(|f| {
            serde_json::json!({
                "rings": f.rings.iter().map(|r| r.iter().map(|p| [p.x, p.y]).collect::<Vec<_>>()).collect::<Vec<_>>(),
                "owners": f.owners.iter().map(|&i| ids[i].clone()).collect::<Vec<_>>(),
            })
        })
        .collect();
    serde_json::to_string(&out).map_err(err)
}

/// Shape Builder: merge the given regions into one shape, delete them, or
/// divide everything into its regions. JSON: { merged: SubPath[] | null,
/// updates: [{ id, paths }], parts: [{ owner, paths }] } — updated objects
/// with empty paths are gone.
#[wasm_bindgen(js_name = shapeBuild)]
pub fn shape_build(doc_json: &str, ids_json: &str, faces_json: &str, mode: &str) -> Result<String, JsValue> {
    use filum_core::clip::fit_ring;
    use filum_core::region::{arrangement, subtract_region, union_rings};
    let (objects, ids) = builder_objects(doc_json, ids_json)?;
    let faces = arrangement(&objects);
    let fit = |rings: &[filum_core::geom::Ring]| rings.iter().map(|r| fit_ring(r, 0.02, 30.0)).collect::<Vec<_>>();
    if mode == "divide" {
        let parts: Vec<serde_json::Value> = faces
            .iter()
            .map(|f| serde_json::json!({ "owner": ids[*f.owners.last().unwrap()], "paths": fit(&f.rings) }))
            .collect();
        return serde_json::to_string(&serde_json::json!({ "merged": null, "updates": [], "parts": parts })).map_err(err);
    }
    let pick: Vec<usize> = serde_json::from_str(faces_json).map_err(err)?;
    let chosen: Vec<Vec<filum_core::geom::Ring>> = pick.iter().filter_map(|&k| faces.get(k)).map(|f| f.rings.clone()).collect();
    if chosen.is_empty() {
        return Err(err("no regions"));
    }
    let cut = union_rings(&chosen);
    let touched: std::collections::BTreeSet<usize> = pick.iter().filter_map(|&k| faces.get(k)).flat_map(|f| f.owners.iter().copied()).collect();
    let updates: Vec<serde_json::Value> = touched
        .iter()
        .map(|&i| serde_json::json!({ "id": ids[i], "paths": fit(&subtract_region(&objects[i], &cut)) }))
        .collect();
    let merged = if mode == "merge" { Some(fit(&cut)) } else { None };
    serde_json::to_string(&serde_json::json!({ "merged": merged, "updates": updates, "parts": [] })).map_err(err)
}

/// The covers of the given objects (stacking order) and their ids.
fn builder_objects(doc_json: &str, ids_json: &str) -> Result<(Vec<Vec<filum_core::region::Cover>>, Vec<String>), JsValue> {
    use filum_core::region::object_cover;
    let doc = parse_doc(doc_json)?;
    let ids: Vec<String> = serde_json::from_str(ids_json).map_err(err)?;
    let chosen: Vec<&filum_core::Object> = doc.objects.iter().filter(|o| ids.contains(&o.id)).collect();
    Ok((chosen.iter().map(|o| object_cover(o)).collect(), chosen.iter().map(|o| o.id.clone()).collect()))
}

/// Shape conversions (Path menu, `filum_core::convert`): `op` is one of
/// fillToSatin, centreLines, satinCentreLine, breakApart, knockdown; `args`
/// is a JSON object (geometry in mm), `doc_json` is only read by knockdown.
#[wasm_bindgen(js_name = convertShapes)]
pub fn convert_shapes(op: &str, doc_json: &str, args_json: &str) -> Result<String, JsValue> {
    use serde_json::{json, Value};
    use filum_core::clip::{fit_ring, Join};
    use filum_core::convert::*;
    use filum_core::geom::{pt, Point};
    use filum_core::stitches::fill::fill_rings;
    use filum_core::SubPath;
    let a: Value = serde_json::from_str(args_json).map_err(err)?;
    let paths = || -> Result<Vec<SubPath>, JsValue> { serde_json::from_value(a["paths"].clone()).map_err(err) };
    let lines = |k: &str| -> Vec<Vec<Point>> {
        a[k].as_array()
            .map(|ls| ls.iter().filter_map(|l| serde_json::from_value::<Vec<[f64; 2]>>(l.clone()).ok()).map(|l| l.iter().map(|q| pt(q[0], q[1])).collect()).collect())
            .unwrap_or_default()
    };
    let num = |k: &str, d: f64| a[k].as_f64().unwrap_or(d);
    let flag = |k: &str, d: bool| a[k].as_bool().unwrap_or(d);
    let join = |k: &str| match a[k].as_str() {
        Some("mitre") => Join::Mitre,
        Some("bevel") => Join::Bevel,
        _ => Join::Round,
    };
    let out: Value = match op {
        "fillToSatin" => json!(fill_to_satin(&fill_rings(&paths()?), &lines("rungs"), flag("skipEndSection", false))),
        "centreLines" => {
            let o = CentreLineOpts { dead_end: num("deadEnd", 10.0), cut_lines: lines("cutLines"), close_gaps: flag("closeGaps", false), ..Default::default() };
            json!(centre_lines(&fill_rings(&paths()?), &o))
        }
        "satinCentreLine" => {
            let obj: filum_core::Object = serde_json::from_value(a["object"].clone()).map_err(err)?;
            let filum_core::StitchParams::Satin(p) = &obj.stitch else { return Err(err("not a satin")) };
            json!(satin_centre_line(&obj.paths, p).iter().map(|q| q.arr()).collect::<Vec<_>>())
        }
        "breakApart" => {
            let src = paths()?;
            let method = if a["method"].as_str() == Some("complex") { BreakMethod::Complex } else { BreakMethod::Simple };
            // rings with the index of their sub-path (degenerate ones are dropped)
            let (index, rings): (Vec<usize>, Vec<_>) = src.iter().enumerate().flat_map(|(i, sp)| fill_rings(std::slice::from_ref(sp)).into_iter().map(move |r| (i, r))).unzip();
            let mut r = break_apart(&rings, method, num("minArea", 1.4));
            if let BreakApart::Parts { parts } = &mut r {
                for p in parts.iter_mut() {
                    for s in p.source.iter_mut() {
                        *s = s.map(|k| index[k]);
                    }
                }
            }
            json!(r)
        }
        "knockdown" => {
            use filum_core::region::object_cover;
            let doc = parse_doc(doc_json)?;
            let ids: Vec<String> = serde_json::from_value(a["ids"].clone()).map_err(err)?;
            let covers: Vec<_> = doc.objects.iter().filter(|o| ids.contains(&o.id)).flat_map(object_cover).collect();
            let frame = match a["frame"].as_str() {
                Some("rect") => KnockdownFrame::Rect,
                Some("circle") => KnockdownFrame::Circle,
                _ => KnockdownFrame::None,
            };
            let o = KnockdownShapeOpts {
                offset: num("offset", 1.0),
                join: join("join"),
                mitre_limit: num("mitreLimit", 5.0),
                keep_holes: flag("keepHoles", true),
                frame,
                frame_offset: num("frameOffset", 1.0),
                frame_join: join("frameJoin"),
                frame_only: flag("frameOnly", false),
            };
            let rings = knockdown_shape(&covers, &o);
            json!(rings.iter().map(|r| fit_ring(r, 0.02, 30.0)).collect::<Vec<_>>())
        }
        other => return Err(err(format!("unknown conversion {other}"))),
    };
    Ok(out.to_string())
}

/// Export an Ink/Stitch-compatible SVG.
#[wasm_bindgen(js_name = exportSvg)]
pub fn export_svg(doc_json: &str) -> Result<String, JsValue> {
    Ok(svg::export_svg(&parse_doc(doc_json)?))
}

/// Import a machine embroidery file. Returns a document JSON (objects use manual stitches).
#[wasm_bindgen(js_name = importEmbroidery)]
pub fn import_embroidery(bytes: &[u8], filename: &str) -> Result<String, JsValue> {
    let doc = io::import(bytes, Some(filename)).map_err(err)?;
    serde_json::to_string(&doc).map_err(err)
}

/// List supported formats as JSON.
#[wasm_bindgen]
pub fn formats() -> String {
    serde_json::to_string(&io::formats()).unwrap_or_default()
}

/// The bundled Ink/Stitch meander tiles as JSON (`{ tiles: [{ id, name, shift0, shift1, lines }] }`).
#[wasm_bindgen(js_name = meanderTiles)]
pub fn meander_tiles() -> String {
    filum_core::stitches::meander_tiles::tiles_json().to_string()
}

/// Read a thread list (Ink/Stitch or other TXT, COL, EDR, INF): JSON `ThreadList`.
#[wasm_bindgen(js_name = readThreadList)]
pub fn read_thread_list(bytes: &[u8], filename: &str) -> Result<String, JsValue> {
    let r = filum_core::threadlist::read_thread_list(bytes, filename).map_err(err)?;
    serde_json::to_string(&r).map_err(err)
}

/// Parse a GIMP/Ink/Stitch .gpl thread palette. Returns JSON `Palette`.
#[wasm_bindgen(js_name = parsePalette)]
pub fn parse_palette(text: &str) -> String {
    serde_json::to_string(&threads::parse_gpl(text)).unwrap_or_default()
}

type Decoded = std::rc::Rc<(Vec<u8>, u32, u32)>;

thread_local! {
    // The digitize dialog re-runs with new options many times on the same
    // image: keep the last decoded image instead of decoding every time.
    static LAST_IMAGE: std::cell::RefCell<Option<(u64, Decoded)>> = const { std::cell::RefCell::new(None) };
}

fn decoded(bytes: &[u8]) -> Result<Decoded, JsValue> {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    bytes.hash(&mut h);
    let key = h.finish();
    if let Some(hit) = LAST_IMAGE.with(|c| c.borrow().as_ref().filter(|(k, _)| *k == key).map(|(_, d)| d.clone())) {
        return Ok(hit);
    }
    let img: Decoded = std::rc::Rc::new(filum_core::digitize::decode_image(bytes).map_err(err)?);
    LAST_IMAGE.with(|c| *c.borrow_mut() = Some((key, img.clone())));
    Ok(img)
}

/// Auto-digitize a raster image (PNG/JPEG/WebP/...). `opts_json` = DigitizeOptions.
#[wasm_bindgen]
pub fn digitize(bytes: &[u8], opts_json: &str) -> Result<String, JsValue> {
    let opts: filum_core::digitize::DigitizeOptions = serde_json::from_str(opts_json).map_err(err)?;
    let img = decoded(bytes)?;
    let r = filum_core::digitize::digitize_rgba(&img.0, img.1, img.2, &opts);
    serde_json::to_string(&r).map_err(err)
}

/// Quantised colour preview: `{ width, height, rgba: Uint8ClampedArray, regionWidth, regionHeight, regions: Uint32Array, regionLabel / regionReason: Uint8Array, meta: string(JSON{colors,widthMm,heightMm,sourceWidth,sourceHeight}) }`.
#[wasm_bindgen(js_name = digitizePreview)]
pub fn digitize_preview(bytes: &[u8], opts_json: &str) -> Result<JsValue, JsValue> {
    let opts: filum_core::digitize::DigitizeOptions = serde_json::from_str(opts_json).map_err(err)?;
    let img = decoded(bytes)?;
    let p = filum_core::digitize::digitize_preview_rgba(&img.0, img.1, img.2, &opts);
    let meta = serde_json::json!({
        "colors": p.colors,
        "widthMm": p.width_mm,
        "heightMm": p.height_mm,
        "sourceWidth": img.1,
        "sourceHeight": img.2,
    });
    let o = Object::new();
    set(&o, "width", &JsValue::from(p.width));
    set(&o, "height", &JsValue::from(p.height));
    set(&o, "rgba", &js_sys::Uint8ClampedArray::from(&p.rgba[..]).into());
    set(&o, "regionWidth", &JsValue::from(p.region_width));
    set(&o, "regionHeight", &JsValue::from(p.region_height));
    set(&o, "regions", &Uint32Array::from(&p.regions[..]).into());
    set(&o, "regionLabel", &Uint8Array::from(&p.region_label[..]).into());
    set(&o, "regionReason", &Uint8Array::from(&p.region_reason[..]).into());
    set(&o, "meta", &JsValue::from_str(&meta.to_string()));
    Ok(o.into())
}

#[wasm_bindgen]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}
