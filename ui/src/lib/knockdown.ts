// Knockdown for a selection (Ink/Stitch "Knockdown fill"): a light fill
// object under the selected objects — their outline grown by an offset, or a
// rectangle / circle around them with the design cut out (embossed look).
// The design-wide knockdown (DesignOptions.knockdown*) covers everything;
// this one is an ordinary, editable object.

import { engine } from "../engine/client";
import { useStore } from "../store";
import type { DesignObject, FillParams, StitchDocument, SubPath } from "../types";
import { defaultFill, uid } from "./geometry";

export type JoinStyle = "round" | "mitre" | "bevel";

export interface KnockdownSelectionOptions {
  /** Distance beyond the design (mm, negative shrinks). */
  offset: number;
  join: JoinStyle;
  /** Mitred corners reaching further than this × the offset are cut off. */
  mitreLimit: number;
  /** Leave the pile standing in the design's holes. */
  keepHoles: boolean;
  /** Around the design itself, or a rectangle / circle around it. */
  frame: "none" | "rect" | "circle";
  frameOffset: number;
  frameJoin: JoinStyle;
  /** The frame only: the design is not cut out of it. */
  frameOnly: boolean;
  /** Stitch length; the rows are √3⁄2 of it apart (Ink/Stitch). */
  stitchLength: number;
  /** Thread colour (#rrggbb); empty = the fabric colour. */
  color: string;
}

// Ink/Stitch's defaults
export const DEFAULT_KNOCKDOWN: KnockdownSelectionOptions = {
  offset: 1,
  join: "round",
  mitreLimit: 5,
  keepHoles: true,
  frame: "none",
  frameOffset: 1,
  frameJoin: "round",
  frameOnly: false,
  stitchLength: 3,
  color: "",
};

/** Ink/Stitch's knockdown fill settings: long stitches, rows √3⁄2 apart, a ±60° underlay, no underpath. */
export function knockdownStitch(len: number): { type: "fill" } & FillParams {
  const spacing = +((Math.sqrt(3) * len) / 2).toFixed(4);
  return {
    type: "fill",
    ...defaultFill(),
    angle: 0,
    maxStitchLength: len,
    rowSpacing: spacing,
    staggers: 2,
    underlay: true,
    underlayAuto: false,
    underlayAngles: [60, -60],
    underlayStitchLength: len,
    underlaySpacing: spacing,
    underpath: false,
  };
}

/** The knockdown's outline for the selected objects. */
export function knockdownPaths(doc: StitchDocument, ids: string[], o: KnockdownSelectionOptions): Promise<SubPath[]> {
  return engine.convertShapes<SubPath[]>(
    "knockdown",
    { ids, offset: o.offset, join: o.join, mitreLimit: o.mitreLimit, keepHoles: o.keepHoles, frame: o.frame, frameOffset: o.frameOffset, frameJoin: o.frameJoin, frameOnly: o.frameOnly },
    doc,
  );
}

/** Create the knockdown object, sewn before the first selected object. Returns the number of parts. */
export async function createKnockdown(o: KnockdownSelectionOptions): Promise<number> {
  const s = useStore.getState();
  const ids = s.doc.objects.filter((x) => s.selection.includes(x.id) && x.visible).map((x) => x.id);
  if (!ids.length) return 0;
  const paths = await knockdownPaths(s.doc, ids, o);
  if (!paths.length) {
    s.toast("Nothing to knock down", "error");
    return 0;
  }
  const color = (o.color || s.fabricColor || "#f4f1ea").toLowerCase();
  const st = useStore.getState();
  const existing = st.doc.threads.find((t) => t.color.toLowerCase() === color);
  const thread = existing ?? { id: uid("t"), name: "Knockdown", color, brand: "", code: "" };
  const obj: DesignObject = {
    id: uid(),
    name: o.frame === "none" ? "Knockdown" : `Knockdown (${o.frame === "rect" ? "rectangle" : "circle"})`,
    thread: thread.id,
    visible: true,
    locked: false,
    paths,
    stitch: knockdownStitch(o.stitchLength),
    trimAfter: false,
    stopAfter: false,
  };
  st.commit((d) => {
    const at = d.objects.findIndex((x) => ids.includes(x.id));
    const objects = [...d.objects];
    objects.splice(Math.max(0, at), 0, obj);
    return { ...d, threads: existing ? d.threads : [...d.threads, thread], objects };
  });
  st.select([obj.id]);
  return paths.length;
}
