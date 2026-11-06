// Which trims the machine cuts (npm run test:match).

import { uncutTrims } from "./cuts";
import { FLAG } from "../types";

let failed = 0;
const check = (ok: boolean, msg: string) => {
  if (!ok) {
    failed++;
    console.log("FAIL", msg);
  }
};

// stitches, then a trim with a jump of `len` mm, then stitches again; a colour change; the end
const plan = (len: number) => {
  const recs: [number, number, number][] = [
    [0, 0, 0],
    [2, 0, 0],
    [2, 0, FLAG.TRIM],
    [2 + len, 0, FLAG.JUMP],
    [2 + len, 0, 0],
    [4 + len, 0, 0],
    [4 + len, 0, FLAG.TRIM],
    [4 + len, 0, FLAG.COLOR_CHANGE],
    [40, 0, FLAG.JUMP],
    [42, 0, 0],
    [42, 0, FLAG.TRIM],
    [42, 0, FLAG.END],
  ];
  return { flags: Uint8Array.from(recs.map((r) => r[2])), coords: Float32Array.from(recs.flatMap((r) => [r[0], r[1]])) };
};

const short = plan(4);
check(uncutTrims(short.flags, short.coords, { kind: "trims", over: 5 }) === null, "a machine that cuts every trim leaves nothing");
const brother = uncutTrims(short.flags, short.coords, { kind: "jumps", over: 5 });
check(brother?.count === 1 && brother.mask[2] === 1 && brother.mask[3] === 1 && brother.mask[4] === 0, "a 4 mm jump under a 5 mm trimming length stays, with its trim");
const long = plan(8);
check(uncutTrims(long.flags, long.coords, { kind: "jumps", over: 5 }) === null, "an 8 mm jump is cut");
const none = uncutTrims(long.flags, long.coords, { kind: "none", over: 5 });
check(none?.count === 1, "no cutter: every jump stays; trims at a colour change or the end aren't hand trims");

console.log(failed ? `${failed} FAILED` : "all passed");
if (failed) throw new Error(`${failed} cut checks failed`);
