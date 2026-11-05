// The stitch-out timeline (npm run test:match): colour blocks, trims, stops
// and the machine clock along a stitch plan.

import { FLAG } from "../types";
import { blockAt, buildTimeline, playRate, tickStep } from "./stitchout";

let failed = 0;
const check = (ok: boolean, msg: string) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${msg}`);
  if (!ok) failed++;
};

const S = 0;
const { JUMP, TRIM, COLOR_CHANGE, STOP, END } = FLAG;
// block 0: jump, 3 stitches, trim, jump, 2 stitches, trim, colour change
// block 1: jump, 2 stitches, stop, 2 stitches, end
const flags = new Uint8Array([JUMP, S, S, S, TRIM, JUMP, S, S, TRIM, COLOR_CHANGE, JUMP, S, S, STOP, S, S, END]);
const m = { spm: 600, trimSeconds: 6, colorChangeSeconds: 12 };
const tl = buildTimeline({ flags }, m);

check(tl.total === flags.length, "the timeline covers every record");
check(tl.blocks.length === 2, "two colour blocks");
check(tl.blocks[0].start === 0 && tl.blocks[0].end === 10, "the first block runs up to and including its colour change");
check(tl.blocks[1].start === 10 && tl.blocks[1].end === flags.length, "the second block runs to the end");
check(tl.blocks[0].stitches === 5 && tl.blocks[1].stitches === 4, "real stitches per block");
check(tl.blocks[0].trims.length === 1 && tl.blocks[0].trims[0] === 4, "the trim before the colour change belongs to the change");
check(tl.blocks[0].ending === "color" && tl.blocks[1].ending === "end", "how each block ends");
check(tl.blocks[1].stops.length === 1 && tl.blocks[1].stops[0] === 13, "a stop inside a block");
check(tl.stitchAt[flags.length] === 9 && tl.stitchAt[4] === 3, "stitches counted along the plan");
// 9 stitches at 600 spm (0.9 s), 2 trims (12 s), a colour change (12 s), 3 jumps (0.15 s)
check(Math.abs(tl.secondsAt[flags.length] - 25.05) < 1e-9, "machine time matches the engine's model");

check(blockAt(tl, 0) === 0 && blockAt(tl, 9) === 0 && blockAt(tl, 10) === 1 && blockAt(tl, 16) === 1, "block at a record");

const oneBlock = buildTimeline({ flags: new Uint8Array([S, S, STOP]) }, m);
check(oneBlock.blocks.length === 1 && oneBlock.blocks[0].ending === "stop" && !oneBlock.blocks[0].stops.length, "a closing stop ends the design with a pause");
check(buildTimeline({ flags: new Uint8Array() }, m).blocks.length === 1, "an empty plan still has one (empty) block");

check(tickStep(16588, 1600) === 1000, "ruler steps of 1, 2 or 5 × 10ⁿ");
check(tickStep(100, 1000) === 10, "small designs get small steps");
check(playRate(0, 24000) === 2000 && playRate(0, 100) === 300 && playRate(500, 24000) === 500, "auto speed sews the design in about twelve seconds");

if (failed) throw new Error(`${failed} stitch-out check(s) failed`);
console.log("all passed");
