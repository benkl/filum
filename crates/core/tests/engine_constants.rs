//! What the editor needs from the engine before the engine has loaded (it
//! runs in a worker): stitch flags, the fabrics' automatic-underlay widths,
//! limits and Optimise defaults, thread sizes, the design options' defaults.
//! Written to `ui/src/generated/engine.ts`; this test fails while that file
//! is out of date. Write it anew with
//!
//!   UPDATE_ENGINE_CONSTANTS=1 cargo test -p filum-core --test engine_constants

use filum_core::density::thread_spec;
use filum_core::flags;
use filum_core::model::{DesignOptions, Fabric};
use filum_core::optimize::center_out_by_default;
use filum_core::plan::JUMP_SECONDS;
use filum_core::stitches::underlay::{auto_fill_widths, auto_satin_widths};
use serde_json::{json, Map, Value};
use std::path::PathBuf;

fn generated() -> String {
    let flag = json!({
        "JUMP": flags::JUMP,
        "TRIM": flags::TRIM,
        "COLOR_CHANGE": flags::COLOR_CHANGE,
        "STOP": flags::STOP,
        "END": flags::END,
        "TIE": flags::TIE,
        "UNDERLAY": flags::UNDERLAY,
        "TRAVEL": flags::TRAVEL,
        "COMMANDS": flags::COMMANDS,
    });
    let mut fabrics = Map::new();
    for f in Fabric::ALL {
        let name = serde_json::to_value(f).unwrap().as_str().unwrap().to_string();
        let p = f.profile();
        let (none, edge) = auto_fill_widths(&p);
        let (s0, s1, s2) = auto_satin_widths(&p);
        fabrics.insert(
            name,
            json!({
                "stretch": p.stretch,
                "delicate": p.delicate,
                "autoFill": [none, edge],
                "autoSatin": [s0, s1, s2],
                "centerOut": center_out_by_default(f),
                "limits": f.limits(),
            }),
        );
    }
    let mut tex = Map::new();
    for w in [75u32, 60, 40, 30, 12] {
        tex.insert(w.to_string(), json!(thread_spec(w).tex));
    }
    let pretty = |v: &Value| serde_json::to_string_pretty(v).unwrap();
    format!(
        "// Generated from the engine by crates/core/tests/engine_constants.rs: do not edit.\n\
         // `UPDATE_ENGINE_CONSTANTS=1 cargo test -p filum-core --test engine_constants`\n\
         // writes it anew; the test fails while it is out of date.\n\
         \n\
         /** Stitch flags of a plan record (crates/core/src/plan.rs, the formats crate's command bits). */\n\
         export const FLAG = {} as const;\n\
         \n\
         /** `plan.objects` of a record no object sews (a command, the frame moving out). */\n\
         export const NO_OBJECT = {};\n\
         \n\
         /** What a jump costs the machine (s). */\n\
         export const JUMP_SECONDS = {};\n\
         \n\
         /**\n\
         \x20* Per fabric: whether it stretches or is delicate, automatic underlay's\n\
         \x20* widths (mm; fills: none below the first, an edge run below the second;\n\
         \x20* satins: none, centre walk, contour), whether Optimise sews it centre out,\n\
         \x20* and what it takes (the density model's limits).\n\
         \x20*/\n\
         export const FABRICS = {} as const;\n\
         \n\
         /** Linear density (tex) of the thread weights. */\n\
         export const THREAD_TEX = {} as const;\n\
         \n\
         /** The design options' defaults (a document leaving one out gets it). */\n\
         export const DESIGN_OPTIONS = {} as const;\n",
        pretty(&flag),
        u32::MAX,
        JUMP_SECONDS,
        pretty(&Value::Object(fabrics)),
        pretty(&Value::Object(tex)),
        pretty(&serde_json::to_value(DesignOptions::default()).unwrap()),
    )
}

#[test]
fn generated_engine_constants_are_current() {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../ui/src/generated/engine.ts");
    let now = generated();
    if std::env::var("UPDATE_ENGINE_CONSTANTS").is_ok() {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, &now).unwrap();
        return;
    }
    let was = std::fs::read_to_string(&path).unwrap_or_default().replace("\r\n", "\n");
    assert!(
        was == now,
        "ui/src/generated/engine.ts is out of date with the engine.\nWrite it anew: UPDATE_ENGINE_CONSTANTS=1 cargo test -p filum-core --test engine_constants"
    );
}
