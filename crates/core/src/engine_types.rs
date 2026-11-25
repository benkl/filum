//! The engine's document and plan types for the editor, as TypeScript:
//! `ui/src/generated/engine-types.ts`, from the serde shapes (ts-rs). This
//! test fails while that file is out of date; write it anew with
//!
//!   UPDATE_ENGINE_TYPES=1 cargo test -p filum-core --lib engine_types
//!
//! The editor checks its own types against these (ui/src/lib/engineTypes.check.ts).

use std::path::PathBuf;
use ts_rs::{Config, TS};

fn decl<T: TS>(cfg: &Config) -> String {
    format!("export {}", T::decl(cfg))
}

fn generated() -> String {
    let cfg = Config::new().with_large_int("number");
    let decls = [
        decl::<crate::model::Node>(&cfg),
        decl::<crate::model::SubPath>(&cfg),
        decl::<crate::model::RunningParams>(&cfg),
        decl::<crate::model::ZigzagParams>(&cfg),
        decl::<crate::model::ManualParams>(&cfg),
        decl::<crate::model::StemParams>(&cfg),
        decl::<crate::model::MotifKind>(&cfg),
        decl::<crate::model::MotifParams>(&cfg),
        decl::<crate::model::RippleParams>(&cfg),
        decl::<crate::model::RippleScaleAxis>(&cfg),
        decl::<crate::model::RippleGuidePosition>(&cfg),
        decl::<crate::model::RailReverse>(&cfg),
        decl::<crate::model::SatinMethod>(&cfg),
        decl::<crate::model::SatinParams>(&cfg),
        decl::<crate::model::FillMethod>(&cfg),
        decl::<crate::model::TartanParams>(&cfg),
        decl::<crate::model::CarvePattern>(&cfg),
        decl::<crate::model::CrossKind>(&cfg),
        decl::<crate::model::FlowField>(&cfg),
        decl::<crate::model::GuidedStrategy>(&cfg),
        decl::<crate::model::TatamiRoute>(&cfg),
        decl::<crate::model::MeanderPattern>(&cfg),
        decl::<crate::model::FillParams>(&cfg),
        decl::<crate::model::RampProfile>(&cfg),
        decl::<crate::model::DensityRamp>(&cfg),
        decl::<crate::model::GradientKind>(&cfg),
        decl::<crate::model::MeshNode>(&cfg),
        decl::<crate::model::GradientMesh>(&cfg),
        decl::<crate::model::FreePoint>(&cfg),
        decl::<crate::model::TransitionCurve>(&cfg),
        decl::<crate::model::GradientMix>(&cfg),
        decl::<crate::model::DitherMethod>(&cfg),
        decl::<crate::model::GradientStop>(&cfg),
        decl::<crate::model::GradientParams>(&cfg),
        decl::<crate::model::TackdownKind>(&cfg),
        decl::<crate::model::CoverKind>(&cfg),
        decl::<crate::model::FoamOptions>(&cfg),
        decl::<crate::model::LayeredOptions>(&cfg),
        decl::<crate::model::AppliqueParams>(&cfg),
        decl::<crate::model::StitchParams>(&cfg),
        decl::<crate::model::Object>(&cfg),
        decl::<crate::model::ObjectLink>(&cfg),
        decl::<crate::model::LockOverride>(&cfg),
        decl::<crate::model::SecondRail>(&cfg),
        decl::<crate::model::StitchPattern>(&cfg),
        decl::<crate::model::CloneLink>(&cfg),
        decl::<crate::model::Thread>(&cfg),
        decl::<crate::model::Fabric>(&cfg),
        decl::<crate::model::FabricProfile>(&cfg),
        decl::<crate::model::HoopShape>(&cfg),
        decl::<crate::model::Hoop>(&cfg),
        decl::<crate::model::Ties>(&cfg),
        decl::<crate::model::LockStyle>(&cfg),
        decl::<crate::model::MachineSettings>(&cfg),
        decl::<crate::model::Cutter>(&cfg),
        decl::<crate::model::Basting>(&cfg),
        decl::<crate::model::CoverMode>(&cfg),
        decl::<crate::model::HiddenRule>(&cfg),
        decl::<crate::model::PresetSet>(&cfg),
        decl::<crate::model::DesignOptions>(&cfg),
        decl::<crate::model::Document>(&cfg),
        decl::<crate::model::ThreadSource>(&cfg),
        decl::<crate::quality::ObjectQuality>(&cfg),
        decl::<crate::quality::HotSpot>(&cfg),
        decl::<crate::quality::NarrowFill>(&cfg),
        decl::<crate::quality::StitchQuality>(&cfg),
        decl::<crate::density::ThreadSpec>(&cfg),
        decl::<crate::model::FabricLimits>(&cfg),
        decl::<crate::density::DensityClass>(&cfg),
        decl::<crate::density::Hotspot>(&cfg),
        decl::<crate::density::DensityStats>(&cfg),
        decl::<crate::density::DensityField>(&cfg),
        decl::<crate::density::DensityOptions>(&cfg),
        decl::<crate::optimize::EndPoint>(&cfg),
        decl::<crate::optimize::OptimizeReport>(&cfg),
        decl::<crate::plan::Stitch>(&cfg),
        decl::<crate::plan::StitchPlan>(&cfg),
        decl::<crate::plan::ConnectionKind>(&cfg),
        decl::<crate::plan::Connection>(&cfg),
        decl::<crate::plan::PlanStats>(&cfg),
        decl::<crate::info::ObjectInfo>(&cfg),
        decl::<crate::info::TotalInfo>(&cfg),
        decl::<crate::info::ElementInfo>(&cfg),
    ];
    let mut out = String::from(
        "// Generated from the engine by crates/core/src/engine_types.rs: do not edit.\n\
         // `UPDATE_ENGINE_TYPES=1 cargo test -p filum-core --lib engine_types` writes it\n\
         // anew; the test fails while it is out of date.\n\n",
    );
    for d in decls {
        out.push_str(&d);
        out.push_str("\n\n");
    }
    out.trim_end().to_string() + "\n"
}

#[test]
fn engine_types_are_current() {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../ui/src/generated/engine-types.ts");
    let now = generated();
    if std::env::var("UPDATE_ENGINE_TYPES").is_ok() {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, &now).unwrap();
        return;
    }
    let was = std::fs::read_to_string(&path).unwrap_or_default().replace("\r\n", "\n");
    assert!(was == now, "ui/src/generated/engine-types.ts is out of date with the engine.\nWrite it anew: UPDATE_ENGINE_TYPES=1 cargo test -p filum-core --lib engine_types");
}
