import type { DesignObject, StitchDocument } from "../types";
import { conjugate, invMat, makeClone, mulMat, syncClones, unlinkClone } from "./clones";
import { rotateAbout, transformObject } from "./geometry";

function ok(c: unknown, msg: string) {
  if (!c) throw new Error(msg);
  console.log("ok  ", msg);
}

const sq: DesignObject = {
  id: "a",
  name: "Square",
  thread: "t",
  visible: true,
  locked: false,
  paths: [{ closed: true, nodes: [{ p: [0, 0] }, { p: [10, 0] }, { p: [10, 10] }, { p: [0, 10] }] }],
  stitch: { type: "fill", method: "tatami", angle: 0 } as DesignObject["stitch"],
  trimAfter: false,
  stopAfter: false,
};
const doc = (objects: DesignObject[]) => ({ objects }) as unknown as StitchDocument;

const c = makeClone(sq);
ok(c.clone?.of === "a" && c.paths[0].nodes[0].p[0] === 5, "a clone sits 5 mm off its original");

// the original changes: the clone follows
const bigger = { ...sq, paths: [{ ...sq.paths[0], nodes: sq.paths[0].nodes.map((n) => ({ p: [n.p[0] * 2, n.p[1] * 2] as [number, number] })) }] };
const d1 = syncClones(doc([bigger, c]));
ok(d1.objects[1].paths[0].nodes[2].p[0] === 25, "the clone follows the original's new shape");
ok(syncClones(d1) === d1, "nothing to do: the same document");

// the clone is turned: its fill angle turns with it, unless it keeps its own
const turned = transformObject(d1.objects[1], rotateAbout(90, 0, 0), 90);
const d2 = syncClones(doc([bigger, turned]));
const st = d2.objects[1].stitch;
ok(st.type === "fill" && Math.abs(Math.abs(st.angle) - 90) < 1e-9, "the turned clone's rows turn with it");
ok(Math.abs(d2.objects[1].paths[0].nodes[1].p[1] - 25) < 1e-9, "and its shape is the original's, turned");
const own = syncClones(doc([bigger, { ...turned, clone: { ...turned.clone!, angle: 30 } }]));
ok(own.objects[1].stitch.type === "fill" && own.objects[1].stitch.angle === 30, "own angle (Ink/Stitch clone angle)");

// the original deleted: the clone becomes a plain object
const alone = syncClones(doc([c]));
ok(!alone.objects[0].clone && alone.objects[0].paths.length === 1, "without its original a clone is a plain copy");
ok(!unlinkClone(c).clone, "unlink");

// moved together with its original: the clone keeps its place relative to it
{
  const link = makeClone(sq).clone!;
  const t: [number, number, number, number, number, number] = [0, 1, -1, 0, 30, 0];
  const c2 = conjugate(link, t);
  const back = mulMat(mulMat(invMat(t), c2.m), t);
  ok(back.every((v, i) => Math.abs(v - link.m[i]) < 1e-9), "conjugated link: the same relation in the new place");
  // the store's rule: both transformed by t in one change
  const moved = [transformObject(sq, t, 90), transformObject(makeClone(sq), t, 90)];
  const prev = doc([sq, { ...makeClone(sq), id: moved[1].id }]);
  const next = syncClones(doc([moved[0], { ...moved[1], id: moved[1].id }]), { ...prev, objects: [sq, { ...prev.objects[1], clone: link }] } as StitchDocument);
  const p0 = next.objects[1].paths[0].nodes[0].p;
  const want = transformObject(makeClone(sq), t, 90).paths[0].nodes[0].p;
  ok(Math.abs(p0[0] - want[0]) < 1e-9 && Math.abs(p0[1] - want[1]) < 1e-9, "moving original and clone together moves the clone once");
}
