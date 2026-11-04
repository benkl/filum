//! Husqvarna/Viking Huffman + LZ decompression (HUS).
//!
//! Ported from pystitch, Ink/Stitch's embroidery file library (MIT, Copyright (c) 2018 Tatarize
//! and the Ink/Stitch contributors)
//! (`EmbCompress.py`, `expand`). Unlike the Python original it never indexes out of
//! bounds: malformed input ends decompression early.

/// Huffman lookup table built from code lengths (lowest index wins a tie).
struct Huffman {
    default_value: usize,
    lengths: Vec<usize>,
    table: Vec<usize>,
    width: usize,
}

impl Huffman {
    fn constant(value: usize) -> Self {
        Huffman { default_value: value, lengths: Vec::new(), table: Vec::new(), width: 0 }
    }

    fn build(lengths: Vec<usize>, default_value: usize) -> Option<Self> {
        let width = lengths.iter().copied().max().unwrap_or(0);
        // The lookup peeks 16 bits; pystitch would fail on longer codes.
        if width > 16 {
            return None;
        }
        let mut table = Vec::new();
        let mut size = (1usize << width) as f64;
        for bit_length in 1..=width {
            size /= 2.0;
            for (i, &l) in lengths.iter().enumerate() {
                if l == bit_length {
                    table.extend(std::iter::repeat_n(i, size as usize));
                }
            }
        }
        Some(Huffman { default_value, lengths, table, width })
    }

    /// `(value, code length)` for 16 peeked bits.
    fn lookup(&self, peek16: u32) -> Option<(usize, usize)> {
        if self.lengths.is_empty() {
            return Some((self.default_value, 0));
        }
        let v = *self.table.get((peek16 >> (16 - self.width)) as usize)?;
        Some((v, self.lengths[v]))
    }
}

struct Decoder<'a> {
    data: &'a [u8],
    bit: usize,
    block_elements: i64,
    characters: Huffman,
    distances: Huffman,
}

impl Decoder<'_> {
    /// `length` (<= 32) bits starting at bit `start`, big-endian; bits past the end read as 0.
    fn get_bits(&self, start: usize, length: usize) -> u32 {
        if length == 0 {
            return 0;
        }
        let end = start + length - 1;
        let mut value: u64 = 0;
        for i in start / 8..=end / 8 {
            value = (value << 8) | self.data.get(i).copied().unwrap_or(0) as u64;
        }
        let unused_right = (8 - (end + 1) % 8) % 8;
        ((value >> unused_right) & ((1u64 << length) - 1)) as u32
    }

    fn peek(&self, n: usize) -> u32 {
        self.get_bits(self.bit, n)
    }

    fn pop(&mut self, n: usize) -> u32 {
        let v = self.peek(n);
        self.bit += n;
        v
    }

    fn read_variable_length(&mut self) -> usize {
        let mut m = self.pop(3) as usize;
        if m != 7 {
            return m;
        }
        for _ in 0..13 {
            if self.pop(1) == 1 {
                m += 1;
            } else {
                break;
            }
        }
        m
    }

    fn load_character_length_huffman(&mut self) -> Option<Huffman> {
        let count = self.pop(5) as usize;
        if count == 0 {
            return Some(Huffman::constant(self.pop(5) as usize));
        }
        let mut lengths = vec![0; count];
        let mut index = 0;
        while index < count {
            if index == 3 {
                // Special index 3: skip up to 3 elements.
                index += self.pop(2) as usize;
                if index >= count {
                    break;
                }
            }
            lengths[index] = self.read_variable_length();
            index += 1;
        }
        Huffman::build(lengths, 8)
    }

    fn load_character_huffman(&mut self, length_huffman: &Huffman) -> Option<Huffman> {
        let count = self.pop(9) as usize;
        if count == 0 {
            return Some(Huffman::constant(self.pop(9) as usize));
        }
        let mut lengths = vec![0; count];
        let mut index = 0;
        while index < count {
            let (c, len) = length_huffman.lookup(self.peek(16))?;
            self.bit += len;
            match c {
                0 => index += 1,
                1 => index += 3 + self.pop(4) as usize,
                2 => index += 20 + self.pop(9) as usize,
                _ => {
                    lengths[index] = c - 2;
                    index += 1;
                }
            }
        }
        Huffman::build(lengths, 0)
    }

    fn load_distance_huffman(&mut self) -> Option<Huffman> {
        let count = self.pop(5) as usize;
        if count == 0 {
            return Some(Huffman::constant(self.pop(5) as usize));
        }
        let lengths = (0..count).map(|_| self.read_variable_length()).collect();
        Huffman::build(lengths, 0)
    }

    fn load_block(&mut self) -> Option<()> {
        self.block_elements = self.pop(16) as i64;
        let length_huffman = self.load_character_length_huffman()?;
        self.characters = self.load_character_huffman(&length_huffman)?;
        self.distances = self.load_distance_huffman()?;
        Some(())
    }

    fn get_token(&mut self) -> Option<usize> {
        if self.block_elements <= 0 {
            self.load_block()?;
        }
        self.block_elements -= 1;
        let (v, len) = self.characters.lookup(self.peek(16))?;
        self.bit += len;
        Some(v)
    }

    fn get_position(&mut self) -> Option<usize> {
        let (v, len) = self.distances.lookup(self.peek(16))?;
        self.bit += len;
        if v == 0 {
            return Some(0);
        }
        let v = v - 1;
        if v > 30 {
            return None;
        }
        Some((1usize << v) + self.pop(v) as usize)
    }
}

/// pystitch `expand`: decompress `data`, producing at most about `size` bytes.
pub(crate) fn expand(data: &[u8], size: usize) -> Vec<u8> {
    let mut d = Decoder {
        data,
        bit: 0,
        block_elements: -1,
        characters: Huffman::constant(0),
        distances: Huffman::constant(0),
    };
    let mut out: Vec<u8> = Vec::new();
    let bits_total = data.len() * 8;
    while bits_total > d.bit && out.len() <= size {
        let Some(character) = d.get_token() else { break };
        if character <= 255 {
            out.push(character as u8);
        } else if character == 510 {
            break; // end
        } else {
            let length = character - 253; // minimum length 3
            let Some(back) = d.get_position().map(|p| p + 1) else { break };
            if back > out.len() {
                break; // reference before the start: malformed
            }
            let position = out.len() - back;
            for i in position..position + length {
                let b = out[i];
                out.push(b);
            }
        }
    }
    out
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// pystitch `compress`: a single block with a flat 8-bit literal code. The block
    /// element count is the 16-bit big-endian value of the first two bytes, so it is
    /// written big-endian here (pystitch writes it little-endian, which only works when
    /// the swapped value happens to be large enough).
    pub(crate) fn compress(data: &[u8]) -> Vec<u8> {
        let n = data.len().min(0xFFFF) as u16;
        let mut out = vec![(n >> 8) as u8, n as u8, 0x02, 0xA0, 0x01, 0xFE];
        out.extend_from_slice(data);
        out
    }

    #[test]
    fn literal_block_roundtrip() {
        let data: Vec<u8> = (0..300u32).map(|i| (i * 7 % 256) as u8).collect();
        assert_eq!(expand(&compress(&data), data.len()), data);
    }

    #[test]
    fn pystitch_header_bytes() {
        // pystitch's own header for 300 bytes (0x2C, 0x01: 0x2C01 elements >= 300) works too.
        let data: Vec<u8> = (0..300u32).map(|i| (i % 251) as u8).collect();
        let mut c = vec![0x2C, 0x01, 0x02, 0xA0, 0x01, 0xFE];
        c.extend_from_slice(&data);
        assert_eq!(expand(&c, data.len()), data);
    }

    #[test]
    fn garbage_does_not_panic() {
        for seed in 0..200u32 {
            let bytes: Vec<u8> = (0..64u32).map(|i| (i.wrapping_mul(2654435761).wrapping_add(seed * 97) >> 7) as u8).collect();
            let _ = expand(&bytes, 100);
        }
    }
}
