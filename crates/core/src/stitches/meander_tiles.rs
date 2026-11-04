//! Ink/Stitch meander tiles (`tiles/*/tile.svg`, GPL-3.0-or-later), bundled
//! by `ui/scripts/bundle-inkstitch.mjs` as line segments in mm, centred on
//! their bounds, with the two repeat vectors of the tiling.

use serde::{Deserialize, Serialize};
use std::sync::OnceLock;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Tile {
    pub id: String,
    pub name: String,
    /// Repeat vectors (mm at 100 %).
    pub shift0: [f64; 2],
    pub shift1: [f64; 2],
    /// Segments `[x1, y1, x2, y2]` (mm at 100 %).
    pub lines: Vec<[f64; 4]>,
}

#[derive(Deserialize)]
struct TileFile {
    tiles: Vec<Tile>,
}

/// Ink/Stitch's default pattern (its alphabetically first tile).
pub const DEFAULT_TILE: &str = "N3-11a";

/// Ink/Stitch snaps tile nodes to whole pixels so neighbouring tiles share them.
pub const SNAP: f64 = 25.4 / 96.0;

/// All bundled tiles, sorted by id.
pub fn tiles() -> &'static [Tile] {
    static TILES: OnceLock<Vec<Tile>> = OnceLock::new();
    TILES.get_or_init(|| serde_json::from_str::<TileFile>(include_str!("meander_tiles.json")).map(|f| f.tiles).unwrap_or_default())
}

pub fn tile(id: &str) -> Option<&'static Tile> {
    tiles().iter().find(|t| t.id == id)
}

/// The bundled tiles as JSON (for the editor's pattern picker).
pub fn tiles_json() -> &'static str {
    include_str!("meander_tiles.json")
}
