// ZIP export (npm run test:match): the stored ZIP writer round-trips, its
// CRC-32 is the standard one and repeated names stay apart.

import { crc32, unzipStored, zip } from "./zip";

const enc = new TextEncoder();
const dec = new TextDecoder();
let failed = 0;
const check = (ok: boolean, msg: string) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${msg}`);
  if (!ok) failed++;
};

check(crc32(enc.encode("123456789")) === 0xcbf43926, "CRC-32 check value");
check(crc32(new Uint8Array()) === 0, "CRC-32 of nothing");

const files = [
  { name: "rose.dst", bytes: new Uint8Array([1, 2, 3, 0, 255]) },
  { name: "rose_threadlist.txt", bytes: enc.encode("Design Details\nÄ ö") },
  { name: "rose.dst", bytes: new Uint8Array([9]) },
  { name: "empty.col", bytes: new Uint8Array() },
];
const z = zip(files);
check(z[0] === 0x50 && z[1] === 0x4b && z[2] === 3 && z[3] === 4, "starts with a local file header");
const back = unzipStored(z);
check(back.length === 4, "four entries");
check(back[0].name === "rose.dst" && back[2].name === "rose (2).dst", `repeated names apart: ${back.map((b) => b.name).join(", ")}`);
check(back.every((b, i) => b.bytes.length === files[i].bytes.length && b.bytes.every((x, k) => x === files[i].bytes[k])), "contents round-trip");
check(dec.decode(back[1].bytes) === "Design Details\nÄ ö", "UTF-8 text intact");
// the stored CRCs match the contents (what unzip tools verify)
const v = new DataView(z.buffer);
check(v.getUint32(14, true) === crc32(files[0].bytes), "local header CRC");
// end record: the central directory's size and offset add up to where the record starts
const endAt = z.length - 22;
check(v.getUint32(endAt, true) === 0x06054b50 && v.getUint32(endAt + 12, true) + v.getUint32(endAt + 16, true) === endAt, "end record sizes");

if (failed) throw new Error(`${failed} ZIP check(s) failed`);
console.log("all passed");
