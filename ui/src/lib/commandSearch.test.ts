// Command palette search (npm run test:match).

import { commandScore } from "./commandSearch";

let failed = 0;
const check = (ok: boolean, msg: string) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${msg}`);
  if (!ok) failed++;
};

check(commandScore("", "Anything", "File") > 0, "an empty query lists everything");
check(commandScore("align left", "Left", "Object Align") > 0, "words may match the menu path");
check(commandScore("conv sat", "Fill → satin…", "Path Convert") > 0, "word starts: conv(ert) · sat(in)");
check(commandScore("xyz", "Save", "File") === 0, "no match");
check(commandScore("save", "Save as…", "File") > commandScore("save", "Auto-route satin columns", "Path Route"), "the label beats the path");
check(commandScore("sa", "Save", "File") > commandScore("sa", "Remove hidden stitching", "Stitch"), "a word start beats the middle of a word");
check(commandScore("dens", "Density map", "View Show") > commandScore("dens", "Density gradient", "Stitch Gradient") - 1e-9, "both density commands match");

if (failed) throw new Error(`${failed} command search check(s) failed`);
