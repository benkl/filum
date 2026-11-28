//! # Filum core
//!
//! The embroidery engine behind Filum: a document model, stitch
//! generators ported from [Ink/Stitch](https://github.com/inkstitch/inkstitch)
//! plus new ones, stitch-plan assembly, ordering optimisation, Ink/Stitch SVG
//! interop, raster auto-digitizing and machine file formats.
//!
//! Licensed GPL-3.0-or-later (it contains ports of Ink/Stitch algorithms).

#[macro_use]
pub mod prof;
pub mod assemble;
pub mod bezfit;
pub mod clip;
pub mod convert;
pub mod density;
#[cfg(feature = "digitize")]
pub mod digitize;
#[cfg(test)]
mod engine_types;
pub mod geom;
pub mod info;
pub mod io;
pub mod locks;
pub mod model;
pub mod optimize;
pub mod outline_route;
pub mod plan;
pub mod prng;
pub mod quality;
pub mod region;
pub mod stitch_outline;
pub mod stitches;
pub mod svg;
pub mod threadlist;
pub mod threads;
pub mod vision;

pub use assemble::Engine;
pub use model::*;
pub use plan::{flags, PlanStats, Stitch, StitchPlan};
