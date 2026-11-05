// Filum's embroidery icons — drawn on Lucide's grid and rules (24 × 24,
// 2 px round strokes, 1 px padding, 2 px between parts) so they sit beside
// lucide-react icons and take the same props (size, strokeWidth, className…).
// The same shapes as plain SVG are in ./svg — change both together.

import { createLucideIcon, type IconNode } from "lucide-react";

const icon = (name: string, node: [string, Record<string, string>][]) =>
  createLucideIcon(name, node.map(([t, a], i) => [t, { ...a, key: `${t}${i}` }]) as IconNode);

/** running stitch */
export const StitchRunning = icon("stitch-running", [["path",{"d":"M3.01 17.97C3.43 16.28 3.92 15 4.46 14.04"}],["path",{"d":"M6.46 11.85C7.72 11.14 9.12 11.27 10.55 11.61"}],["path",{"d":"M13.45 12.39C14.88 12.73 16.28 12.86 17.54 12.15"}],["path",{"d":"M19.54 9.96C20.08 9 20.57 7.72 20.99 6.03"}]]);
/** satin column */
export const StitchSatin = icon("stitch-satin", [["path",{"d":"M7 3 17 6 7 9 17 12 7 15 17 18 7 21"}]]);
/** tatami fill */
export const StitchFill = icon("stitch-fill", [["rect",{"x":"3","y":"3","width":"18","height":"18","rx":"2"}],["path",{"d":"M6 12.34 12.34 6"}],["path",{"d":"M6 18 10.95 13.05"}],["path",{"d":"M13.05 10.95 18 6"}],["path",{"d":"M11.66 18 18 11.66"}]]);
/** contour fill */
export const StitchContour = icon("stitch-contour", [["rect",{"x":"3","y":"3","width":"18","height":"18","rx":"5"}],["rect",{"x":"7.5","y":"7.5","width":"9","height":"9","rx":"2"}],["path",{"d":"M12 12h.01"}]]);
/** spiral fill */
export const StitchSpiral = icon("stitch-spiral", [["path",{"d":"M13 12a2 2 0 0 0-4 0a4 4 0 0 0 8 0a6 6 0 0 0-12 0a8 8 0 0 0 16 0"}]]);
/** circular fill */
export const StitchRadial = icon("stitch-radial", [["circle",{"cx":"12","cy":"12","r":"10"}],["path",{"d":"M12 16L12 22"}],["path",{"d":"M8.54 14L3.34 17"}],["path",{"d":"M8.54 10L3.34 7"}],["path",{"d":"M12 8L12 2"}],["path",{"d":"M15.46 10L20.66 7"}],["path",{"d":"M15.46 14L20.66 17"}]]);
/** meander fill */
export const StitchMeander = icon("stitch-meander", [["path",{"d":"M3 18V8a3 3 0 0 1 6 0v8a3 3 0 0 0 6 0V8a3 3 0 0 1 6 0v10"}]]);
/** cross stitch */
export const StitchCross = icon("stitch-cross", [["path",{"d":"M4 4l6 6M10 4l-6 6"}],["path",{"d":"M14 4l6 6M20 4l-6 6"}],["path",{"d":"M4 14l6 6M10 14l-6 6"}],["path",{"d":"M14 14l6 6M20 14l-6 6"}]]);
/** appliqué: a fabric patch stitched down */
export const Applique = icon("applique", [["path",{"d":"M12 21.35C6.5 17 3 13.5 3 9a4.5 4.5 0 0 1 9-1.5A4.5 4.5 0 0 1 21 9c0 4.5-3.5 8-9 12.35Z"}],["path",{"d":"M12 17.3 10.63 16.17"}],["path",{"d":"M9.1 14.77 7.94 13.47"}],["path",{"d":"M6.9 11.73 6.59 10.71 6.51 10.01"}],["path",{"d":"M7.19 8.16 7.63 7.87 8.14 7.72 8.79 7.72"}],["path",{"d":"M10.29 8.99 10.4 9.5 11.6 9.5"}],["path",{"d":"M13.61 9.44 13.73 8.94 13.97 8.49 14.48 8.01"}],["path",{"d":"M16.49 7.94 16.9 8.24 17.22 8.64 17.47 9.29"}],["path",{"d":"M17.25 11.33 16.83 12.28 16.48 12.88"}],["path",{"d":"M15.2 14.46 13.92 15.69"}],["path",{"d":"M12.37 17 12 17.3"}]]);
/** patch border */
export const PatchBorder = icon("patch-border", [["path",{"d":"M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"}],["path",{"d":"M16.5 12.5 16.41 13.57 16.23 14.27"}],["path",{"d":"M15.08 16.26 14.32 16.98 13.76 17.39"}],["path",{"d":"M11.63 18.14 10.66 17.65 10.11 17.3"}],["path",{"d":"M8.44 15.65 7.94 14.73 7.72 14.12"}],["path",{"d":"M7.5 11.74 7.5 10.02"}],["path",{"d":"M8.13 8.2 9.81 7.7"}],["path",{"d":"M11.85 6.6 12.35 6.73 13.37 7.32"}],["path",{"d":"M15.56 8.14 16.08 8.24 16.5 8.55 16.5 9.11"}],["path",{"d":"M16.5 11.44 16.5 12.5"}]]);
/** underlay under the top stitches */
export const Underlay = icon("underlay", [["path",{"d":"M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"}],["path",{"d":"M2.6 14 5.12 15.14"}],["path",{"d":"M7.36 16.16 9.87 17.3"}],["path",{"d":"M12.14 18.07 12.66 17.98 14.69 17.07"}],["path",{"d":"M16.92 16.04 19.44 14.9"}]]);
/** knockdown: flattened pile */
export const Knockdown = icon("knockdown", [["path",{"d":"M8 3v7"}],["path",{"d":"M5 7l3 3 3-3"}],["path",{"d":"M16 3v7"}],["path",{"d":"M13 7l3 3 3-3"}],["path",{"d":"M3 14h18"}],["path",{"d":"M3 20c1.5 0 1.5-2 3-2s1.5 2 3 2 1.5-2 3-2 1.5 2 3 2 1.5-2 3-2 1.5 2 3 2"}]]);
/** pull compensation */
export const PullCompensation = icon("pull-compensation", [["path",{"d":"M9.5 4 14.5 7 9.5 10 14.5 13 9.5 16 14.5 19"}],["path",{"d":"M5.5 11.5H3"}],["path",{"d":"M4.5 9.5l-2 2 2 2"}],["path",{"d":"M18.5 11.5H21"}],["path",{"d":"M19.5 9.5l2 2-2 2"}]]);
/** stitch density */
export const DensityMap = icon("density-map", [["circle",{"cx":"5","cy":"5","r":"1.5"}],["circle",{"cx":"5","cy":"12","r":"1.5"}],["circle",{"cx":"5","cy":"19","r":"1.5"}],["circle",{"cx":"12","cy":"5","r":"0.75"}],["circle",{"cx":"12","cy":"12","r":"0.75"}],["circle",{"cx":"12","cy":"19","r":"0.75"}],["path",{"d":"M19 5h.01"}],["path",{"d":"M19 12h.01"}],["path",{"d":"M19 19h.01"}]]);
/** stitch direction */
export const StitchAngle = icon("stitch-angle", [["path",{"d":"M3 20h18"}],["path",{"d":"M3 20 16 7"}],["path",{"d":"M10 20a7 7 0 0 0-2.05-4.95"}]]);
/** trim */
export const Trim = icon("trim", [["circle",{"cx":"7","cy":"5","r":"2.5"}],["circle",{"cx":"17","cy":"5","r":"2.5"}],["path",{"d":"M8.43 7.05 14 15"}],["path",{"d":"M15.57 7.05 10 15"}],["path",{"d":"M3 19h6"}],["path",{"d":"M15 19h6"}]]);
/** jump */
export const Jump = icon("jump", [["path",{"d":"M2 19h4"}],["path",{"d":"M18 19h4"}],["path",{"d":"M6 16C6 8 18 8 18 16"}],["path",{"d":"M15.5 13.5 18 16l2.5-2.5"}]]);
/** lock (tie) stitch */
export const LockStitch = icon("lock-stitch", [["path",{"d":"M2 15h3"}],["path",{"d":"M8 15h5c3 0 5-2 5-5a3 3 0 0 0-6 0c0 3 2 5 5 5h5"}]]);
/** machine hoop with its centre marks */
export const Hoop = icon("hoop", [["rect",{"x":"2","y":"4","width":"20","height":"16","rx":"4"}],["path",{"d":"M12 4v3"}],["path",{"d":"M12 17v3"}],["path",{"d":"M2 12h3"}],["path",{"d":"M19 12h3"}]]);
/** fabric */
export const Fabric = icon("fabric", [["path",{"d":"M3 9h3"}],["path",{"d":"M12 9h9"}],["path",{"d":"M3 15h9"}],["path",{"d":"M18 15h3"}],["path",{"d":"M9 3v9"}],["path",{"d":"M9 18v3"}],["path",{"d":"M15 3v3"}],["path",{"d":"M15 12v9"}]]);
/** thread spool */
export const Spool = icon("spool", [["path",{"d":"M6 3h12"}],["path",{"d":"M6 21h12"}],["path",{"d":"M8 3v18"}],["path",{"d":"M16 3v18"}],["path",{"d":"M8 10l8-3"}],["path",{"d":"M8 15l8-3"}],["path",{"d":"M8 20l8-3"}]]);
/** digitize a picture */
export const Digitize = icon("digitize", [["path",{"d":"M3 7V5a2 2 0 0 1 2-2h2"}],["path",{"d":"M17 3h2a2 2 0 0 1 2 2v2"}],["path",{"d":"M21 17v2a2 2 0 0 1-2 2h-2"}],["path",{"d":"M7 21H5a2 2 0 0 1-2-2v-2"}],["circle",{"cx":"9","cy":"9","r":"1.5"}],["path",{"d":"M7 17l2.5-4 2.5 4 2.5-4 2.5 4"}]]);
/** cutwork: cut at the needle angles */
export const Cutwork = icon("cutwork", [["circle",{"cx":"12","cy":"12","r":"9"}],["path",{"d":"M12 7v10"}],["path",{"d":"M7 12h10"}],["path",{"d":"M8.5 8.5l7 7"}],["path",{"d":"M15.5 8.5l-7 7"}]]);
/** colour change */
export const ColorChange = icon("color-change", [["path",{"d":"M3 4h8"}],["path",{"d":"M3 20h8"}],["path",{"d":"M5 4v16"}],["path",{"d":"M9 4v16"}],["path",{"d":"M14 9h7"}],["path",{"d":"M18 6l3 3-3 3"}],["path",{"d":"M21 15h-7"}],["path",{"d":"M17 12l-3 3 3 3"}]]);
/** gradient */
export const GradientTool = icon("gradient-tool", [["rect",{"x":"3","y":"3","width":"18","height":"18","rx":"2"}],["path",{"d":"M9.5 14.5l5-5"}],["circle",{"cx":"8","cy":"16","r":"1.5"}],["circle",{"cx":"16","cy":"8","r":"1.5"}]]);
/** sew order */
export const SewOrder = icon("sew-order", [["circle",{"cx":"4.5","cy":"18","r":"1.5"}],["circle",{"cx":"12","cy":"18","r":"1.5"}],["circle",{"cx":"19.5","cy":"18","r":"1.5"}],["path",{"d":"M4.8 14C5.2 9.5 10.8 9.5 11.2 14"}],["path",{"d":"M12.8 14C13.2 9.5 18.8 9.5 19.2 14"}],["path",{"d":"M17 12.6l2.2 1.4 1.2-2.3"}]]);
/** row spacing */
export const RowSpacing = icon("row-spacing", [["path",{"d":"M11 5h10"}],["path",{"d":"M11 12h10"}],["path",{"d":"M11 19h10"}],["path",{"d":"M5 5v14"}],["path",{"d":"M3 7l2-2 2 2"}],["path",{"d":"M3 17l2 2 2-2"}]]);
/** stitch length */
export const StitchLength = icon("stitch-length", [["circle",{"cx":"5","cy":"9","r":"2"}],["circle",{"cx":"19","cy":"9","r":"2"}],["path",{"d":"M7.5 9h9"}],["path",{"d":"M5 15v4"}],["path",{"d":"M19 15v4"}],["path",{"d":"M5 17h14"}]]);
/** lettering on an arc */
export const TextArc = icon("text-arc", [["path",{"d":"M3 20a12 12 0 0 1 18 0"}],["path",{"d":"M8.5 13 12 4l3.5 9"}],["path",{"d":"M9.8 10h4.4"}]]);
/** letter spacing */
export const LetterSpacing = icon("letter-spacing", [["path",{"d":"M3 5v14"}],["path",{"d":"M21 5v14"}],["path",{"d":"M7 12h10"}],["path",{"d":"M9 9.5 6.5 12 9 14.5"}],["path",{"d":"M15 9.5l2.5 2.5-2.5 2.5"}]]);
/** basting: a running-stitch box around the design */
export const Basting = icon("basting", [["rect",{"x":"7.5","y":"7.5","width":"9","height":"9","rx":"2"}],["path",{"d":"M7 3 8.25 3"}],["path",{"d":"M10.9 3 13.5 3"}],["path",{"d":"M16.1 3 17.61 3.05 18.63 3.35"}],["path",{"d":"M20.53 5.11 20.88 6.06 21 7.1 21 7.6"}],["path",{"d":"M21 10.25 21 12.8"}],["path",{"d":"M21 15.45 21 16.95 20.87 18"}],["path",{"d":"M19.45 20.16 18.58 20.67 17.61 20.95 17.11 20.99"}],["path",{"d":"M14.45 21 11.9 21"}],["path",{"d":"M9.25 21 6.66 20.98"}],["path",{"d":"M4.3 19.94 3.65 19.17 3.21 18.27 3.08 17.78"}],["path",{"d":"M3 15.1 3 12.55"}],["path",{"d":"M3 9.9 3 7.35"}],["path",{"d":"M3.65 4.83 4.3 4.06 5.11 3.47 5.57 3.27"}]]);
/** shapes rebuilt from stitches */
export const Rebuild = icon("rebuild", [["path",{"d":"M4 20 4 17.65"}],["path",{"d":"M4 15.2 4 12.85"}],["path",{"d":"M4 10.4 4.01 8.89 4.1 8.02"}],["path",{"d":"M5.13 5.83 5.92 5.07 6.99 4.43"}],["path",{"d":"M9.35 4 11.7 4"}],["path",{"d":"M17 4h2a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2H8"}],["rect",{"x":"13","y":"2","width":"4","height":"4","rx":"1"}],["rect",{"x":"4","y":"19","width":"4","height":"4","rx":"1"}]]);
/** embroidery machine */
export const EmbroideryMachine = icon("embroidery-machine", [["rect",{"x":"2","y":"17","width":"20","height":"4","rx":"1"}],["path",{"d":"M19 17V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v2a2 2 0 0 0 2 2h8v7"}],["path",{"d":"M7 10v3"}],["path",{"d":"M10 4V2"}]]);
/** batch lettering: one design, many names */
export const BatchLettering = icon("batch-lettering", [["rect",{"x":"2","y":"8","width":"14","height":"14","rx":"2"}],["path",{"d":"M8 4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2"}],["path",{"d":"m6 18 3-6 3 6"}],["path",{"d":"M7 16h4"}]]);
/** design-wide stitch processing: stitches hidden under others left out */
export const StitchProcessing = icon("stitch-processing", [["rect",{"x":"9","y":"9","width":"12","height":"12","rx":"2"}],["path",{"d":"M3 5a2 2 0 0 1 2-2"}],["path",{"d":"M8 3h2"}],["path",{"d":"M13 3a2 2 0 0 1 2 2"}],["path",{"d":"M3 8v2"}],["path",{"d":"M3 13a2 2 0 0 0 2 2"}],["path",{"d":"m12 15 3-3"}],["path",{"d":"m15 18 3-3"}]]);

// The stitch-out player's icons (drawn by assets/icons/stitchout_icons.py, which also writes ./svg)

/** the stitch-out player: play over a running stitch */
export const StitchOut = icon("stitch-out", [["path",{"d":"M9 12.35L9 5.65A1.5 1.5 0 0 1 11.27 4.36L16.86 7.71A1.5 1.5 0 0 1 16.86 10.29L11.27 13.64A1.5 1.5 0 0 1 9 12.35Z"}],["path",{"d":"M3 20L6 20"}],["path",{"d":"M10.5 20L13.5 20"}],["path",{"d":"M18 20L21 20"}]]);

/** follow the needle: running stitch up to the needle point, in a viewfinder */
export const FollowNeedle = icon("follow-needle", [["path",{"d":"M3 7L3 5A2 2 0 0 1 5 3L7 3"}],["path",{"d":"M17 3L19 3A2 2 0 0 1 21 5L21 7"}],["path",{"d":"M21 17L21 19A2 2 0 0 1 19 21L17 21"}],["path",{"d":"M7 21L5 21A2 2 0 0 1 3 19L3 17"}],["path",{"d":"M7 17L8.5 15.5"}],["path",{"d":"M11.5 12.5L13 11"}],["path",{"d":"M16 8L16.01 8"}]]);

/** previous colour block: skip back to a satin column */
export const BlockPrevious = icon("block-previous", [["path",{"d":"M20 15.69L20 8.31A1.5 1.5 0 0 0 17.51 7.18L13.29 10.87A1.5 1.5 0 0 0 13.29 13.13L17.51 16.82A1.5 1.5 0 0 0 20 15.69Z"}],["path",{"d":"M8 4L4 6.67L8 9.33L4 12L8 14.67L4 17.33L8 20"}]]);

/** next colour block: skip to a satin column */
export const BlockNext = icon("block-next", [["path",{"d":"M4 15.69L4 8.31A1.5 1.5 0 0 1 6.49 7.18L10.71 10.87A1.5 1.5 0 0 1 10.71 13.13L6.49 16.82A1.5 1.5 0 0 1 4 15.69Z"}],["path",{"d":"M16 4L20 6.67L16 9.33L20 12L16 14.67L20 17.33L16 20"}]]);

/** the machine stops: stitched pause bars on a stop sign */
export const MachineStop = icon("machine-stop", [["path",{"d":"M2.59 7.27L7.27 2.59A2 2 0 0 1 8.69 2L15.31 2A2 2 0 0 1 16.73 2.59L21.41 7.27A2 2 0 0 1 22 8.69L22 15.31A2 2 0 0 1 21.41 16.73L16.73 21.41A2 2 0 0 1 15.31 22L8.69 22A2 2 0 0 1 7.27 21.41L2.59 16.73A2 2 0 0 1 2 15.31L2 8.69A2 2 0 0 1 2.59 7.27Z"}],["path",{"d":"M9.5 7L9.5 10"}],["path",{"d":"M9.5 14L9.5 17"}],["path",{"d":"M14.5 7L14.5 10"}],["path",{"d":"M14.5 14L14.5 17"}]]);
