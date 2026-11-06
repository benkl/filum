// One icon per tool, shared by the tool rail, the Tools menu and the command
// palette so they never disagree.

import { Circle, Combine, Hand, MousePointer2, PenLine, PenTool, Ruler, Slice, Spline, Square, Type, Waypoints, type LucideIcon } from "lucide-react";
import type { Tool } from "../types";
import { GradientTool, StitchAngle, StitchSatin } from "./stitch";

export const TOOL_ICONS: Record<Tool, LucideIcon> = {
  select: MousePointer2,
  pan: Hand,
  ruler: Ruler,
  node: Spline,
  // a knife: scissors mean a thread trim in embroidery
  cut: Slice,
  pen: PenTool,
  curve: Waypoints,
  freehand: PenLine,
  satin: StitchSatin,
  guides: StitchAngle,
  rect: Square,
  ellipse: Circle,
  text: Type,
  gradient: GradientTool,
  builder: Combine,
};
