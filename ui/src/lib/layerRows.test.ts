import type { DesignObject, StitchDocument } from "../types";
import { buildLayerRows, dropOnRow, dropRow, gatherAtTop, moveBlock, nextGroupName, pruneGroups, type LayerListRow } from "./layerRows";

function ok(c: unknown, msg: string) {
  if (!c) throw new Error(msg);
  console.log("ok  ", msg);
}

const obj = (id: string, extra: Partial<DesignObject> = {}): DesignObject => ({
  id,
  name: id.toUpperCase(),
  thread: `t${id}`,
  visible: true,
  locked: false,
  paths: [],
  stitch: { type: "running" } as DesignObject["stitch"],
  trimAfter: false,
  stopAfter: false,
  ...extra,
});
const ids = (os: DesignObject[]) => os.map((o) => o.id).join("");
const keys = (rows: LayerListRow[]) => rows.map((r) => (r.kind === "group" ? `[${r.group}]` : r.member ? `.${r.o.id}` : r.o.id)).join(" ");

// stitch order a b c d e; b and d are grouped (not next to each other)
const objs = [obj("a"), obj("b", { group: "g" }), obj("c"), obj("d", { group: "g", visible: false }), obj("e")];

const open = buildLayerRows(objs, new Set());
ok(keys(open) === "e [g] .d .b c a", "a group shows at its topmost member, members under it");
const head = open[1];
ok(head.kind === "group" && head.name === "Group 1" && head.count === 2 && head.top === 3, "header: default name, count, place");
ok(head.kind === "group" && head.threads.join() === "tb,td" && head.visible === "some" && head.locked === "none", "header: threads, mixed visibility");
ok(keys(buildLayerRows(objs, new Set(["g"]))) === "e [g] c a", "folded: the members are hidden");
const named = buildLayerRows(objs, new Set(), { g: "Petals" })[1];
ok(named.kind === "group" && named.name === "Petals", "a stored name is shown");

// a lettering in a group is one member row
const lettering = [obj("x", { group: "g", text: { group: "T" } as DesignObject["text"] }), obj("y", { group: "g", text: { group: "T" } as DesignObject["text"] }), obj("z", { group: "g" })];
const lr = buildLayerRows(lettering, new Set());
ok(keys(lr) === "[g] .z .y" && lr[0].kind === "group" && lr[0].count === 2, "a lettering counts once in its group");
ok(lr[2].kind === "object" && lr[2].ids.join() === "x,y", "the lettering row carries all its objects");

// moving blocks
ok(ids(moveBlock(objs, ["b", "d"], ["e"])) === "acebd", "a block moved up goes above the target, in its order");
ok(ids(moveBlock(objs, ["b", "d"], ["a"])) === "bdace", "a block moved down goes below the target");
ok(ids(moveBlock(objs, ["e"], ["c"])) === "abecd", "one object moved down takes the target's place (below it)");
ok(ids(moveBlock(objs, ["a"], ["c"])) === "bcade", "one object moved up takes the target's place (above it)");
ok(moveBlock(objs, ["a"], ["a"]) === objs, "onto itself: nothing changes");
ok(ids(gatherAtTop(objs, ["b", "d"])) === "acbde", "grouping gathers the members at the topmost one");
ok(gatherAtTop(objs, ["d", "e"]) === objs, "already together: nothing changes");

// dragging rows
const row = (k: string) => open.find((r) => r.key === k)!;
ok(ids(dropRow(objs, row("g:g"), row("o:a"))) === "bdace", "dragging a header moves the whole group");
const out = dropRow(objs, row("o:b"), row("o:e"));
ok(ids(out) === "acdeb" && out.find((o) => o.id === "b")!.group === undefined, "a member dragged outside its group leaves it");
const into = dropRow(objs, row("o:c"), row("o:d"));
ok(into.find((o) => o.id === "c")!.group === "g", "an object dropped on a member joins the group");
const within = dropRow(objs, row("o:b"), row("o:d"));
ok(ids(within) === "acdbe" && within.find((o) => o.id === "b")!.group === "g", "reordered inside its group: still a member");
ok(dropRow(objs, row("g:g"), row("o:d")) === objs, "a header dropped on its own member: nothing changes");

// gradient layers keep their group
const grad = (id: string) => obj(id, { group: "grd1", stitch: { type: "fill", gradient: { group: "grd1" } } as unknown as DesignObject["stitch"] });
const gobjs = [grad("p"), grad("q"), obj("r")];
const grows = buildLayerRows(gobjs, new Set());
ok(grows[1].kind === "group" && grows[1].role === "gradient" && grows[1].name === "P", "a gradient's layers show as one group, named after it");
const gout = dropRow(gobjs, grows.find((r) => r.key === "o:p")!, grows.find((r) => r.key === "o:r")!);
ok(gout.find((o) => o.id === "p")!.group === "grd1", "a gradient layer dragged out keeps its gradient");
const rIn = dropRow(gobjs, grows.find((r) => r.key === "o:r")!, grows.find((r) => r.key === "o:q")!);
ok(rIn.find((o) => o.id === "r")!.group === undefined, "objects do not join a gradient");

// names and pruning
const doc = (objects: DesignObject[], groupNames?: Record<string, string>) => ({ objects, groupNames }) as unknown as StitchDocument;
ok(nextGroupName(doc(objs)) === "Group 2", "a new group gets the next free name");
ok(nextGroupName(doc(objs, { g: "Petals" })) === "Group 1", "named groups leave their number free");
const pruned = pruneGroups(doc([obj("a", { group: "g" }), obj("b")], { g: "Petals", old: "Gone" }));
ok(pruned.objects[0].group === undefined && pruned.groupNames === undefined, "a group of one dissolves, stale names go");
const d0 = doc(objs, { g: "Petals" });
ok(pruneGroups(d0) === d0, "nothing to prune: the same document");
ok(pruneGroups(doc(gobjs.slice(0, 1))).objects[0].group === "grd1", "a lone gradient layer keeps its group");

// nested groups: "in" (b, c) sits in "out" (with d); e stands alone
const nobjs = [obj("a"), obj("b", { group: "in" }), obj("c", { group: "in" }), obj("d", { group: "out" }), obj("e")];
const parents = { in: "out" };
const nrows = buildLayerRows(nobjs, new Set(), {}, parents);
ok(keys(nrows) === "e [out] .d [in] .c .b a", "a group inside a group: its header under the outer one, its members under it");
const inner = nrows.find((r) => r.key === "g:in")!;
const outer = nrows.find((r) => r.key === "g:out")!;
ok(inner.kind === "group" && inner.depth === 1 && inner.parent === "out" && inner.count === 2, "the inner header: one level in, two rows");
ok(outer.kind === "group" && outer.depth === 0 && outer.count === 2 && outer.ids.join("") === "bcd", "the outer header counts its object and its group, and holds all three objects");
ok(nrows.find((r) => r.key === "o:b")!.depth === 2, "members of the inner group are two levels in");
ok(keys(buildLayerRows(nobjs, new Set(["out"]), {}, parents)) === "e [out] a", "folding the outer group hides the inner one too");
const ndoc = (objects: DesignObject[], groupParents?: Record<string, string>) => ({ objects, groupParents }) as unknown as StitchDocument;
// dragging a group onto a row in another group puts it there
const moved = dropOnRow(ndoc(nobjs, parents), inner, nrows.find((r) => r.key === "o:e")!);
ok(!moved.groupParents?.in, "a group dragged onto a top-level row leaves its group");
ok(dropOnRow(ndoc(nobjs, parents), outer, inner).objects === nobjs, "a group dropped on a group inside it: nothing changes");
// pruning: an outer group left holding only one group dissolves into it
const lonely = pruneGroups(ndoc([obj("b", { group: "in" }), obj("c", { group: "in" }), obj("e")], parents));
ok(lonely.groupParents === undefined && lonely.objects[0].group === "in", "a group around just one group dissolves");
