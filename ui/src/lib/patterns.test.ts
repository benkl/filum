import { beansToPasses, formatPattern, parsePattern, passesToBeans, patternLengths } from "./patterns";

function eq(a: unknown, b: unknown, msg: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`);
  console.log("ok  ", msg);
}

eq(parsePattern("2 1"), [2, 1], "spaces");
eq(parsePattern(" 2,5 ; 1 "), [2, 5, 1], "commas and semicolons separate");
eq(parsePattern("2 x 1"), [2, 1], "junk left out");
eq(parsePattern("0.1 9", { min: 0.3, max: 6 }), [0.3, 6], "clamped");
eq(parsePattern("1.6 2", { integer: true }), [2, 2], "integers");
eq(formatPattern([2, 1.25]), "2 1.25", "formatted");
eq(beansToPasses([0, 1, 3]), [0, 2, 6], "Ink/Stitch bean repeats to passes");
eq(passesToBeans([0, 2, 6]), [0, 1, 3], "and back");
eq(patternLengths([2, 1], 5), [2, 1, 2], "preview lengths");
