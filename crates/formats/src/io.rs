//! Small binary read/write helpers (bounds-checked reading, no panics on bad input).

use crate::Error;

/// Little helpers on top of `Vec<u8>`.
pub(crate) trait ByteWriter {
    fn u8(&mut self, v: u8);
    fn i8(&mut self, v: i32);
    fn u16le(&mut self, v: u32);
    fn u16be(&mut self, v: u32);
    fn u24le(&mut self, v: u32);
    fn u32le(&mut self, v: u32);
    fn i32le(&mut self, v: i32);
    fn i32be(&mut self, v: i32);
    fn f32le(&mut self, v: f32);
    fn str(&mut self, s: &str);
    fn fill(&mut self, b: u8, n: usize);
    fn patch_u24le(&mut self, pos: usize, v: u32);
    fn patch_u32le(&mut self, pos: usize, v: u32);
    fn patch_u32be(&mut self, pos: usize, v: u32);
    fn patch_u16le(&mut self, pos: usize, v: u32);
}

impl ByteWriter for Vec<u8> {
    fn u8(&mut self, v: u8) {
        self.push(v);
    }
    fn i8(&mut self, v: i32) {
        self.push((v & 0xFF) as u8);
    }
    fn u16le(&mut self, v: u32) {
        self.extend_from_slice(&(v as u16).to_le_bytes());
    }
    fn u16be(&mut self, v: u32) {
        self.extend_from_slice(&(v as u16).to_be_bytes());
    }
    fn u24le(&mut self, v: u32) {
        self.extend_from_slice(&v.to_le_bytes()[..3]);
    }
    fn u32le(&mut self, v: u32) {
        self.extend_from_slice(&v.to_le_bytes());
    }
    fn i32le(&mut self, v: i32) {
        self.extend_from_slice(&v.to_le_bytes());
    }
    fn i32be(&mut self, v: i32) {
        self.extend_from_slice(&v.to_be_bytes());
    }
    fn f32le(&mut self, v: f32) {
        self.extend_from_slice(&v.to_le_bytes());
    }
    fn str(&mut self, s: &str) {
        self.extend_from_slice(s.as_bytes());
    }
    fn fill(&mut self, b: u8, n: usize) {
        self.extend(std::iter::repeat_n(b, n));
    }
    fn patch_u24le(&mut self, pos: usize, v: u32) {
        self[pos..pos + 3].copy_from_slice(&v.to_le_bytes()[..3]);
    }
    fn patch_u32le(&mut self, pos: usize, v: u32) {
        self[pos..pos + 4].copy_from_slice(&v.to_le_bytes());
    }
    fn patch_u32be(&mut self, pos: usize, v: u32) {
        self[pos..pos + 4].copy_from_slice(&v.to_be_bytes());
    }
    fn patch_u16le(&mut self, pos: usize, v: u32) {
        self[pos..pos + 2].copy_from_slice(&(v as u16).to_le_bytes());
    }
}

/// Bounds-checked cursor over a byte slice.
pub(crate) struct Reader<'a> {
    pub data: &'a [u8],
    pub pos: usize,
}

fn eof() -> Error {
    Error::Malformed("unexpected end of file".into())
}

impl<'a> Reader<'a> {
    pub fn new(data: &'a [u8]) -> Self {
        Reader { data, pos: 0 }
    }
    pub fn at(data: &'a [u8], pos: usize) -> Self {
        Reader { data, pos }
    }
    pub fn remaining(&self) -> usize {
        self.data.len().saturating_sub(self.pos)
    }
    pub fn seek(&mut self, pos: usize) -> Result<(), Error> {
        if pos > self.data.len() {
            return Err(eof());
        }
        self.pos = pos;
        Ok(())
    }
    pub fn skip(&mut self, n: usize) -> Result<(), Error> {
        self.seek(self.pos.checked_add(n).ok_or_else(eof)?)
    }
    pub fn bytes(&mut self, n: usize) -> Result<&'a [u8], Error> {
        if self.remaining() < n {
            return Err(eof());
        }
        let s = &self.data[self.pos..self.pos + n];
        self.pos += n;
        Ok(s)
    }
    pub fn u8(&mut self) -> Result<u8, Error> {
        Ok(self.bytes(1)?[0])
    }
    pub fn u16le(&mut self) -> Result<u32, Error> {
        let b = self.bytes(2)?;
        Ok(u16::from_le_bytes([b[0], b[1]]) as u32)
    }
    pub fn i16le(&mut self) -> Result<i32, Error> {
        Ok(self.u16le()? as u16 as i16 as i32)
    }
    pub fn u16be(&mut self) -> Result<u32, Error> {
        let b = self.bytes(2)?;
        Ok(u16::from_be_bytes([b[0], b[1]]) as u32)
    }
    pub fn u24le(&mut self) -> Result<u32, Error> {
        let b = self.bytes(3)?;
        Ok(u32::from_le_bytes([b[0], b[1], b[2], 0]))
    }
    pub fn u24be(&mut self) -> Result<u32, Error> {
        let b = self.bytes(3)?;
        Ok(u32::from_be_bytes([0, b[0], b[1], b[2]]))
    }
    pub fn u32le(&mut self) -> Result<u32, Error> {
        let b = self.bytes(4)?;
        Ok(u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
    }
    pub fn u32be(&mut self) -> Result<u32, Error> {
        let b = self.bytes(4)?;
        Ok(u32::from_be_bytes([b[0], b[1], b[2], b[3]]))
    }
    pub fn i32le(&mut self) -> Result<i32, Error> {
        Ok(self.u32le()? as i32)
    }
    pub fn i32be(&mut self) -> Result<i32, Error> {
        let b = self.bytes(4)?;
        Ok(i32::from_be_bytes([b[0], b[1], b[2], b[3]]))
    }
    /// Lossy UTF-8 string of `n` bytes.
    pub fn string(&mut self, n: usize) -> Result<String, Error> {
        Ok(String::from_utf8_lossy(self.bytes(n)?).into_owned())
    }
}
