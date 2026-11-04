//! Small deterministic random numbers for stitch generators: the same seed
//! and indices always give the same stitches (like Ink/Stitch's `prng`).

/// A uniform number in [0, 1) from a seed and two indices.
pub fn uniform(seed: u32, a: u64, b: u64) -> f64 {
    let mut x = a.wrapping_mul(0x9E37_79B9_7F4A_7C15) ^ b.wrapping_mul(0xC2B2_AE3D_27D4_EB4F) ^ (seed as u64).wrapping_mul(0x1656_67B1_9E37_79F9) ^ 0x2545_F491_4F6C_DD1D;
    x ^= x >> 33;
    x = x.wrapping_mul(0xFF51_AFD7_ED55_8CCD);
    x ^= x >> 33;
    x = x.wrapping_mul(0xC4CE_B9FE_1A85_EC53);
    x ^= x >> 33;
    (x >> 11) as f64 / (1u64 << 53) as f64
}

/// An endless stream of uniform numbers for one seed and stream index.
pub struct Stream {
    seed: u32,
    stream: u64,
    i: u64,
}

impl Stream {
    pub fn new(seed: u32, stream: u64) -> Self {
        Stream { seed, stream, i: 0 }
    }
    pub fn next(&mut self) -> f64 {
        self.i += 1;
        uniform(self.seed, self.stream, self.i)
    }
}
