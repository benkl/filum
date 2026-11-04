//! Thread palettes for formats that store palette indices instead of RGB.
//!
//! Ported from pystitch, Ink/Stitch's embroidery file library (MIT, Copyright (c) 2018 Tatarize
//! and the Ink/Stitch contributors)
//! (`EmbThreadPec.py`, `EmbThreadJef.py`, `EmbThreadHus.py`, `EmbThreadShv.py`, `EmbThreadSew.py`).

use crate::color::nearest_index;
use crate::Thread;

/// A palette entry: `(rgb, name, catalog code)`.
pub type PaletteEntry = ([u8; 3], &'static str, &'static str);

/// Brother PEC thread table. File index `i` (1..=64) maps to `PEC_PALETTE[i - 1]`;
/// index 0 is "unknown".
pub const PEC_PALETTE: [PaletteEntry; 64] = [
    ([14, 31, 124], "Prussian Blue", "1"),
    ([10, 85, 163], "Blue", "2"),
    ([0, 135, 119], "Teal Green", "3"),
    ([75, 107, 175], "Cornflower Blue", "4"),
    ([237, 23, 31], "Red", "5"),
    ([209, 92, 0], "Reddish Brown", "6"),
    ([145, 54, 151], "Magenta", "7"),
    ([228, 154, 203], "Light Lilac", "8"),
    ([145, 95, 172], "Lilac", "9"),
    ([158, 214, 125], "Mint Green", "10"),
    ([232, 169, 0], "Deep Gold", "11"),
    ([254, 186, 53], "Orange", "12"),
    ([255, 255, 0], "Yellow", "13"),
    ([112, 188, 31], "Lime Green", "14"),
    ([186, 152, 0], "Brass", "15"),
    ([168, 168, 168], "Silver", "16"),
    ([125, 111, 0], "Russet Brown", "17"),
    ([255, 255, 179], "Cream Brown", "18"),
    ([79, 85, 86], "Pewter", "19"),
    ([0, 0, 0], "Black", "20"),
    ([11, 61, 145], "Ultramarine", "21"),
    ([119, 1, 118], "Royal Purple", "22"),
    ([41, 49, 51], "Dark Gray", "23"),
    ([42, 19, 1], "Dark Brown", "24"),
    ([246, 74, 138], "Deep Rose", "25"),
    ([178, 118, 36], "Light Brown", "26"),
    ([252, 187, 197], "Salmon Pink", "27"),
    ([254, 55, 15], "Vermilion", "28"),
    ([240, 240, 240], "White", "29"),
    ([106, 28, 138], "Violet", "30"),
    ([168, 221, 196], "Seacrest", "31"),
    ([37, 132, 187], "Sky Blue", "32"),
    ([254, 179, 67], "Pumpkin", "33"),
    ([255, 243, 107], "Cream Yellow", "34"),
    ([208, 166, 96], "Khaki", "35"),
    ([209, 84, 0], "Clay Brown", "36"),
    ([102, 186, 73], "Leaf Green", "37"),
    ([19, 74, 70], "Peacock Blue", "38"),
    ([135, 135, 135], "Gray", "39"),
    ([216, 204, 198], "Warm Gray", "40"),
    ([67, 86, 7], "Dark Olive", "41"),
    ([253, 217, 222], "Flesh Pink", "42"),
    ([249, 147, 188], "Pink", "43"),
    ([0, 56, 34], "Deep Green", "44"),
    ([178, 175, 212], "Lavender", "45"),
    ([104, 106, 176], "Wisteria Violet", "46"),
    ([239, 227, 185], "Beige", "47"),
    ([247, 56, 102], "Carmine", "48"),
    ([181, 75, 100], "Amber Red", "49"),
    ([19, 43, 26], "Olive Green", "50"),
    ([199, 1, 86], "Dark Fuchsia", "51"),
    ([254, 158, 50], "Tangerine", "52"),
    ([168, 222, 235], "Light Blue", "53"),
    ([0, 103, 62], "Emerald Green", "54"),
    ([78, 41, 144], "Purple", "55"),
    ([47, 126, 32], "Moss Green", "56"),
    ([255, 204, 204], "Flesh Pink", "57"),
    ([255, 217, 17], "Harvest Gold", "58"),
    ([9, 91, 166], "Electric Blue", "59"),
    ([240, 249, 112], "Lemon Yellow", "60"),
    ([227, 243, 91], "Fresh Green", "61"),
    // machine functions, not thread colours (pystitch: reserved)
    ([255, 200, 100], "Applique Material", "62"),
    ([255, 200, 200], "Applique Position", "63"),
    ([255, 200, 200], "Applique", "64"),
];

/// PEC indices from here on are machine functions (appliqué steps), never
/// chosen for a thread colour (pystitch `EmbThreadPec`, `reserved=True`).
pub(crate) const PEC_RESERVED_FROM: usize = 62;

/// Janome JEF thread table. File index `i` (1..=78) maps to `JEF_PALETTE[i - 1]`;
/// index 0 is a placeholder (used by JEF to mark a stop).
pub const JEF_PALETTE: [PaletteEntry; 78] = [
    ([0x00, 0x00, 0x00], "Black", "002"),
    ([0xFF, 0xFF, 0xFF], "White", "001"),
    ([0xFF, 0xFF, 0x17], "Yellow", "204"),
    ([0xFF, 0x66, 0x00], "Orange", "203"),
    ([0x2F, 0x59, 0x33], "Olive Green", "219"),
    ([0x23, 0x73, 0x36], "Green", "226"),
    ([0x65, 0xC2, 0xC8], "Sky", "217"),
    ([0xAB, 0x5A, 0x96], "Purple", "208"),
    ([0xF6, 0x69, 0xA0], "Pink", "201"),
    ([0xFF, 0x00, 0x00], "Red", "225"),
    ([0xB1, 0x70, 0x4E], "Brown", "214"),
    ([0x0B, 0x2F, 0x84], "Blue", "207"),
    ([0xE4, 0xC3, 0x5D], "Gold", "003"),
    ([0x48, 0x1A, 0x05], "Dark Brown", "205"),
    ([0xAC, 0x9C, 0xC7], "Pale Violet", "209"),
    ([0xFC, 0xF2, 0x94], "Pale Yellow", "210"),
    ([0xF9, 0x99, 0xB7], "Pale Pink", "211"),
    ([0xFA, 0xB3, 0x81], "Peach", "212"),
    ([0xC9, 0xA4, 0x80], "Beige", "213"),
    ([0x97, 0x05, 0x33], "Wine Red", "215"),
    ([0xA0, 0xB8, 0xCC], "Pale Sky", "216"),
    ([0x7F, 0xC2, 0x1C], "Yellow Green", "218"),
    ([0xE5, 0xE5, 0xE5], "Silver Gray", "220"),
    ([0x88, 0x9B, 0x9B], "Gray", "221"),
    ([0x98, 0xD6, 0xBD], "Pale Aqua", "227"),
    ([0xB2, 0xE1, 0xE3], "Baby Blue", "228"),
    ([0x36, 0x8B, 0xA0], "Powder Blue", "229"),
    ([0x4F, 0x83, 0xAB], "Bright Blue", "230"),
    ([0x38, 0x6A, 0x91], "Slate Blue", "231"),
    ([0x07, 0x16, 0x50], "Navy Blue", "232"),
    ([0xF9, 0x99, 0xA2], "Salmon Pink", "233"),
    ([0xF9, 0x67, 0x6B], "Coral", "234"),
    ([0xE3, 0x31, 0x1F], "Burnt Orange", "235"),
    ([0xE2, 0xA1, 0x88], "Cinnamon", "236"),
    ([0xB5, 0x94, 0x74], "Umber", "237"),
    ([0xE4, 0xCF, 0x99], "Blond", "238"),
    ([0xFF, 0xCB, 0x00], "Sunflower", "239"),
    ([0xE1, 0xAD, 0xD4], "Orchid Pink", "240"),
    ([0xC3, 0x00, 0x7E], "Peony Purple", "241"),
    ([0x80, 0x00, 0x4B], "Burgundy", "242"),
    ([0x54, 0x05, 0x71], "Royal Purple", "243"),
    ([0xB1, 0x05, 0x25], "Cardinal Red", "244"),
    ([0xCA, 0xE0, 0xC0], "Opal Green", "245"),
    ([0x89, 0x98, 0x56], "Moss Green", "246"),
    ([0x5C, 0x94, 0x1A], "Meadow Green", "247"),
    ([0x00, 0x31, 0x14], "Dark Green", "248"),
    ([0x5D, 0xAE, 0x94], "Aquamarine", "249"),
    ([0x4C, 0xBF, 0x8F], "Emerald Green", "250"),
    ([0x00, 0x77, 0x72], "Peacock Green", "251"),
    ([0x59, 0x5B, 0x61], "Dark Gray", "252"),
    ([0xFF, 0xFF, 0xF2], "Ivory White", "253"),
    ([0xB1, 0x58, 0x18], "Hazel", "254"),
    ([0xCB, 0x8A, 0x07], "Toast", "255"),
    ([0x98, 0x6C, 0x80], "Salmon", "256"),
    ([0x98, 0x69, 0x2D], "Cocoa Brown", "257"),
    ([0x4D, 0x34, 0x19], "Sienna", "258"),
    ([0x4C, 0x33, 0x0B], "Sepia", "259"),
    ([0x33, 0x20, 0x0A], "Dark Sepia", "260"),
    ([0x52, 0x3A, 0x97], "Violet Blue", "261"),
    ([0x0D, 0x21, 0x7E], "Blue Ink", "262"),
    ([0x1E, 0x77, 0xAC], "Sola Blue", "263"),
    ([0xB2, 0xDD, 0x53], "Green Dust", "264"),
    ([0xF3, 0x36, 0x89], "Crimson", "265"),
    ([0xDE, 0x64, 0x9E], "Floral Pink", "266"),
    ([0x98, 0x41, 0x61], "Wine", "267"),
    ([0x4C, 0x56, 0x12], "Olive Drab", "268"),
    ([0x4C, 0x88, 0x1F], "Meadow", "269"),
    ([0xE4, 0xDE, 0x79], "Mustard", "270"),
    ([0xCB, 0x8A, 0x1A], "Yellow Ocher", "271"),
    ([0xCB, 0xA2, 0x1C], "Old Gold", "272"),
    ([0xFF, 0x98, 0x05], "Honey Dew", "273"),
    ([0xFC, 0xB2, 0x57], "Tangerine", "274"),
    ([0xFF, 0xE5, 0x05], "Canary Yellow", "275"),
    ([0xF0, 0x33, 0x1F], "Vermilion", "202"),
    ([0x1A, 0x84, 0x2D], "Bright Green", "206"),
    ([0x38, 0x6C, 0xAE], "Ocean Blue", "222"),
    ([0xE3, 0xC4, 0xB4], "Beige Gray", "223"),
    ([0xE3, 0xAC, 0x81], "Bamboo", "224"),
];

/// Number of slots in the PEC table including the unused index 0.
pub const PEC_TABLE_LEN: usize = PEC_PALETTE.len() + 1;
/// Number of slots in the JEF table including the placeholder index 0.
pub const JEF_TABLE_LEN: usize = JEF_PALETTE.len() + 1;

fn entry_thread(e: &PaletteEntry, brand: &str) -> Thread {
    Thread {
        rgb: e.0,
        name: e.1.to_string(),
        code: e.2.to_string(),
        brand: brand.to_string(),
    }
}

/// Thread for a PEC file palette index (taken modulo the table size like pystitch).
pub fn pec_thread(index: usize) -> Thread {
    let i = index % PEC_TABLE_LEN;
    if i == 0 {
        Thread {
            rgb: [0, 0, 0],
            name: "Unknown".into(),
            code: "0".into(),
            brand: "Brother".into(),
        }
    } else {
        entry_thread(&PEC_PALETTE[i - 1], "Brother")
    }
}

/// Thread for a JEF file palette index (1-based, modulo the table size).
/// Returns `None` for the placeholder index 0.
pub fn jef_thread(index: usize) -> Option<Thread> {
    let i = index % JEF_TABLE_LEN;
    if i == 0 {
        None
    } else {
        Some(entry_thread(&JEF_PALETTE[i - 1], "Janome"))
    }
}

/// Table with slot 0 empty, as used by pystitch's index lookups.
pub(crate) fn pec_slots() -> Vec<Option<[u8; 3]>> {
    std::iter::once(None)
        .chain(PEC_PALETTE.iter().enumerate().map(|(i, e)| (i + 1 < PEC_RESERVED_FROM).then_some(e.0)))
        .collect()
}

pub(crate) fn jef_slots() -> Vec<Option<[u8; 3]>> {
    std::iter::once(None)
        .chain(JEF_PALETTE.iter().map(|e| Some(e.0)))
        .collect()
}

/// Nearest PEC palette index (1..=64) for a colour (CIE Lab ΔE76).
pub fn nearest_pec_index(rgb: [u8; 3]) -> usize {
    nearest_index(rgb, &pec_slots()).unwrap_or(20)
}

/// Nearest JEF palette index (1..=78) for a colour (CIE Lab ΔE76).
pub fn nearest_jef_index(rgb: [u8; 3]) -> usize {
    nearest_index(rgb, &jef_slots()).unwrap_or(1)
}

/// pystitch's `build_unique_palette` (every distinct thread claims the nearest
/// still-unclaimed slot, so distinct threads stay distinct), per spool: `keys` identify threads (colour, code,
/// brand), so two different spools that happen to share an RGB value still
/// get different palette slots (the machine asks for two threads, not the
/// "same" one twice). Same key, same slot.
pub(crate) fn build_unique_palette_keyed<K: PartialEq + Clone>(slots: &[Option<[u8; 3]>], colors: &[[u8; 3]], keys: &[K]) -> Vec<usize> {
    let mut remaining = slots.to_vec();
    let mut claimed: Vec<(K, usize)> = Vec::new();
    for (c, k) in colors.iter().zip(keys) {
        if claimed.iter().any(|(kk, _)| kk == k) {
            continue;
        }
        match nearest_index(*c, &remaining) {
            Some(i) => {
                remaining[i] = None;
                claimed.push((k.clone(), i));
            }
            None => break,
        }
    }
    colors
        .iter()
        .zip(keys)
        .map(|(c, k)| claimed.iter().find(|(kk, _)| kk == k).map(|x| x.1).unwrap_or_else(|| nearest_index(*c, slots).unwrap_or(0)))
        .collect()
}

/// pystitch's JEF "non-repeat" palette: consecutive *different* threads
/// that pigeonhole to the same palette entry get the second-closest entry.
pub(crate) fn build_nonrepeat_palette(slots: &[Option<[u8; 3]>], colors: &[[u8; 3]]) -> Vec<usize> {
    let mut slots = slots.to_vec();
    let mut out = Vec::with_capacity(colors.len());
    let mut last: Option<(usize, [u8; 3])> = None;
    for c in colors {
        let mut index = nearest_index(*c, &slots).unwrap_or(0);
        if let Some((li, lc)) = last {
            if li == index && lc != *c {
                let saved = slots[index].take();
                index = nearest_index(*c, &slots).unwrap_or(index);
                slots[li] = saved;
            }
        }
        out.push(index);
        last = Some((index, *c));
    }
    out
}

/// Husqvarna HUS thread table (pystitch `EmbThreadHus.py`), indexed by the file.
pub const HUS_PALETTE: [PaletteEntry; 29] = [
    ([0x00, 0x00, 0x00], "Black", "026"),
    ([0x00, 0x00, 0xe7], "Blue", "005"),
    ([0x00, 0xc6, 0x00], "Green", "002"),
    ([0xff, 0x00, 0x00], "Red", "014"),
    ([0x84, 0x00, 0x84], "Purple", "008"),
    ([0xff, 0xff, 0x00], "Yellow", "020"),
    ([0x84, 0x84, 0x84], "Grey", "024"),
    ([0x84, 0x84, 0xe7], "Light Blue", "006"),
    ([0x00, 0xff, 0x84], "Light Green", "003"),
    ([0xff, 0x7b, 0x31], "Orange", "017"),
    ([0xff, 0x8c, 0xa5], "Pink", "011"),
    ([0x84, 0x52, 0x00], "Brown", "028"),
    ([0xff, 0xff, 0xff], "White", "022"),
    ([0x00, 0x00, 0x84], "Dark Blue", "004"),
    ([0x00, 0x84, 0x00], "Dark Green", "001"),
    ([0x7b, 0x00, 0x00], "Dark Red", "013"),
    ([0xff, 0x63, 0x84], "Light Red", "015"),
    ([0x52, 0x29, 0x52], "Dark Purple", "007"),
    ([0xff, 0x00, 0xff], "Light Purple", "009"),
    ([0xff, 0xde, 0x00], "Dark Yellow", "019"),
    ([0xff, 0xff, 0x9c], "Light Yellow", "021"),
    ([0x52, 0x52, 0x52], "Dark Grey", "025"),
    ([0xd6, 0xd6, 0xd6], "Light Grey", "023"),
    ([0xff, 0x52, 0x08], "Dark Orange", "016"),
    ([0xff, 0x9c, 0x5a], "Light Orange", "018"),
    ([0xff, 0x52, 0xb5], "Dark Pink", "010"),
    ([0xff, 0xc6, 0xde], "Light Pink", "012"),
    ([0x52, 0x31, 0x00], "Dark Brown", "027"),
    ([0xb5, 0xa5, 0x84], "Light Brown", "029"),
];

/// Husqvarna Viking SHV thread table (pystitch `EmbThreadShv.py`), indexed by the file.
pub const SHV_PALETTE: [PaletteEntry; 43] = [
    ([0, 0, 0], "Black", "0"),
    ([0, 0, 255], "Blue", "1"),
    ([51, 204, 102], "Green", "2"),
    ([255, 0, 0], "Red", "3"),
    ([255, 0, 255], "Purple", "4"),
    ([255, 255, 0], "Yellow", "5"),
    ([127, 127, 127], "Gray", "6"),
    ([51, 154, 255], "Light Blue", "7"),
    ([0, 255, 0], "Light Green", "8"),
    ([255, 127, 0], "Orange", "9"),
    ([255, 160, 180], "Pink", "10"),
    ([153, 75, 0], "Brown", "11"),
    ([255, 255, 255], "White", "12"),
    ([0, 0, 0], "Black", "13"),
    ([0, 0, 0], "Black", "14"),
    ([0, 0, 0], "Black", "15"),
    ([0, 0, 0], "Black", "16"),
    ([0, 0, 0], "Black", "17"),
    ([0, 0, 0], "Black", "18"),
    ([255, 127, 127], "Light Red", "19"),
    ([255, 127, 255], "Light Purple", "20"),
    ([255, 255, 153], "Light Yellow", "21"),
    ([192, 192, 192], "Light Gray", "22"),
    ([0, 0, 0], "Black", "23"),
    ([0, 0, 0], "Black", "24"),
    ([255, 165, 65], "Light Orange", "25"),
    ([255, 204, 204], "Light Pink", "26"),
    ([175, 90, 10], "Light Brown", "27"),
    ([0, 0, 0], "Black", "28"),
    ([0, 0, 0], "Black", "29"),
    ([0, 0, 0], "Black", "30"),
    ([0, 0, 0], "Black", "31"),
    ([0, 0, 0], "Black", "32"),
    ([0, 0, 127], "Dark Blue", "33"),
    ([0, 127, 0], "Dark Green", "34"),
    ([127, 0, 0], "Dark Red", "35"),
    ([127, 0, 127], "Dark Purple", "36"),
    ([200, 200, 0], "Dark Yellow", "37"),
    ([60, 60, 60], "Dark Gray", "38"),
    ([0, 0, 0], "Black", "39"),
    ([0, 0, 0], "Black", "40"),
    ([232, 63, 0], "Dark Orange", "41"),
    ([255, 102, 122], "Dark Pink", "42"),
];

/// Janome SEW thread table (pystitch `EmbThreadSew.py`); index 0 is "Unknown".
pub const SEW_PALETTE: [PaletteEntry; 79] = [
    ([0, 0, 0], "Unknown", "0"),
    ([0, 0, 0], "Black", "1"),
    ([255, 255, 255], "White", "2"),
    ([255, 255, 23], "Sunflower", "3"),
    ([250, 160, 96], "Hazel", "4"),
    ([92, 118, 73], "Green Dust", "5"),
    ([64, 192, 48], "Green", "6"),
    ([101, 194, 200], "Sky", "7"),
    ([172, 128, 190], "Purple", "8"),
    ([245, 188, 203], "Pink", "9"),
    ([255, 0, 0], "Red", "10"),
    ([192, 128, 0], "Brown", "11"),
    ([0, 0, 240], "Blue", "12"),
    ([228, 195, 93], "Gold", "13"),
    ([165, 42, 42], "Dark Brown", "14"),
    ([213, 176, 212], "Pale Violet", "15"),
    ([252, 242, 148], "Pale Yellow", "16"),
    ([240, 208, 192], "Pale Pink", "17"),
    ([255, 192, 0], "Peach", "18"),
    ([201, 164, 128], "Beige", "19"),
    ([155, 61, 75], "Wine Red", "20"),
    ([160, 184, 204], "Pale Sky", "21"),
    ([127, 194, 28], "Yellow Green", "22"),
    ([185, 185, 185], "Silver Grey", "23"),
    ([160, 160, 160], "Grey", "24"),
    ([152, 214, 189], "Pale Aqua", "25"),
    ([184, 240, 240], "Baby Blue", "26"),
    ([54, 139, 160], "Powder Blue", "27"),
    ([79, 131, 171], "Bright Blue", "28"),
    ([56, 106, 145], "Slate Blue", "29"),
    ([0, 32, 107], "Nave Blue", "30"),
    ([229, 197, 202], "Salmon Pink", "31"),
    ([249, 103, 107], "Coral", "32"),
    ([227, 49, 31], "Burnt Orange", "33"),
    ([226, 161, 136], "Cinnamon", "34"),
    ([181, 148, 116], "Umber", "35"),
    ([228, 207, 153], "Blonde", "36"),
    ([225, 203, 0], "Sunflower", "37"),
    ([225, 173, 212], "Orchid Pink", "38"),
    ([195, 0, 126], "Peony Purple", "39"),
    ([128, 0, 75], "Burgundy", "40"),
    ([160, 96, 176], "Royal Purple", "41"),
    ([192, 64, 32], "Cardinal Red", "42"),
    ([202, 224, 192], "Opal Green", "43"),
    ([137, 152, 86], "Moss Green", "44"),
    ([0, 170, 0], "Meadow Green", "45"),
    ([33, 138, 33], "Dark Green", "46"),
    ([93, 174, 148], "Aquamarine", "47"),
    ([76, 191, 143], "Emerald Green", "48"),
    ([0, 119, 114], "Peacock Green", "49"),
    ([112, 112, 112], "Dark Grey", "50"),
    ([242, 255, 255], "Ivory White", "51"),
    ([177, 88, 24], "Hazel", "52"),
    ([203, 138, 7], "Toast", "53"),
    ([247, 146, 123], "Salmon", "54"),
    ([152, 105, 45], "Cocoa Brown", "55"),
    ([162, 113, 72], "Sienna", "56"),
    ([123, 85, 74], "Sepia", "57"),
    ([79, 57, 70], "Dark Sepia", "58"),
    ([82, 58, 151], "Violet Blue", "59"),
    ([0, 0, 160], "Blue Ink", "60"),
    ([0, 150, 222], "Solar Blue", "61"),
    ([178, 221, 83], "Green Dust", "62"),
    ([250, 143, 187], "Crimson", "63"),
    ([222, 100, 158], "Floral Pink", "64"),
    ([181, 80, 102], "Wine", "65"),
    ([94, 87, 71], "Olive Drab", "66"),
    ([76, 136, 31], "Meadow", "67"),
    ([228, 220, 121], "Canary Yellow", "68"),
    ([203, 138, 26], "Toast", "69"),
    ([198, 170, 66], "Beige", "70"),
    ([236, 176, 44], "Honey Dew", "71"),
    ([248, 128, 64], "Tangerine", "72"),
    ([255, 229, 5], "Ocean Blue", "73"),
    ([250, 122, 122], "Sepia", "74"),
    ([107, 224, 0], "Royal Purple", "75"),
    ([56, 108, 174], "Yellow Ocher", "76"),
    ([208, 186, 176], "Beige Grey", "77"),
    ([227, 190, 129], "Bamboo", "78"),
];

/// Thread of a file-indexed table (`index` modulo the table length, like pystitch).
pub(crate) fn table_thread(table: &[PaletteEntry], index: usize, brand: &str) -> Thread {
    entry_thread(&table[index % table.len()], brand)
}

/// SEW table slots, the placeholder index 0 excluded.
pub(crate) fn sew_slots() -> Vec<Option<[u8; 3]>> {
    SEW_PALETTE.iter().enumerate().map(|(i, e)| (i != 0).then_some(e.0)).collect()
}
