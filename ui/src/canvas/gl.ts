// WebGL2 stitch renderer.
//
// Every stitch segment is an instanced quad; the fragment shader computes the
// exact distance to the segment (a capsule) and turns it into anti-aliased
// coverage, so threads stay sharp at every zoom level.
//
// Stitch view: flat lines and needle dots, one pass per colour block.
//
// Realistic view: each stitch is shaded as a lit, twisted thread in ONE pass —
// a cylinder normal across the thread (diffuse), an anisotropic Kajiya-Kay
// sheen along it (so satin columns at different angles catch the light
// differently), the ply twist as fine diagonal stripes (faded out when they
// get smaller than a few pixels), and the thread dipping into its needle
// holes at both ends. A soft contact shadow is drawn under each colour block.
// Thread width follows each thread's weight (else the design's); how glossy a thread is
// follows its brand (rayon, polyester, cotton, metallic).
//
// Performance: the whole design is ONE instanced draw call. The instance
// buffer is pre-ordered chunk by chunk and pass by pass (GPUs blend
// primitives in submission order, so layering is exact); each instance points
// at an "entry" (chunk × pass × part) whose parameters live in a small float
// texture. The stitch-out animation is a vertex-shader cut-off on the record
// index, and pan/zoom only change uniforms — nothing is re-uploaded.
//
// Layering uses depth:
// - translucent passes (stitch lines, shadows, jumps) cover a pixel once: the
//   pass has one depth value; its interior instances come before its
//   anti-aliased fringe and all of them write depth, so later fragments of
//   the same pass are rejected while later passes always pass;
// - shaded threads (realistic) are opaque and drawn in sewing order: each
//   stitch gets its own, smaller depth from its record index, so a later
//   stitch always lies on top of an earlier one.
//
// The fabric (realistic view) is a second tiny shader: a procedural texture
// per fabric (plain weave, twill, jersey, piqué, fleece, felt, terry loops,
// leather grain) in millimetres, so it scales with the zoom, inside the hoop
// (rectangle or oval).

import { threadSheen, threadWidth } from "../lib/materials";
import type { Fabric, PlanData, ThreadWeight } from "../types";
import { FLAG } from "../types";
import type { View } from "../store";
import { getChunks, type Theme } from "./render";

const STITCH_VS = `#version 300 es
layout(location = 0) in vec2 a_corner;
layout(location = 1) in vec4 i_seg;   // x0 y0 x1 y1 (mm)
layout(location = 2) in vec3 i_meta;  // entry index, record index, layering slot (shaded threads)
uniform vec3 u_view;      // device px per mm, ox, oy (device px)
uniform vec2 u_res;
uniform float u_dpr;
uniform float u_limit;    // records drawn (animation)
uniform float u_jumps;    // 1 = show jump entries
uniform float u_dots;     // 1 = show needle dots
uniform float u_depthDen; // depth slots of a realistic build
uniform highp sampler2D u_entries; // 3 texels per entry, 64 entries per row
uniform highp sampler2D u_recObj;  // object index of every record (4096 per row)
uniform highp sampler2D u_moving;  // 1 for objects a drag is transforming (4096 per row)
uniform float u_live;     // 1 while a drag transforms objects
uniform float u_objects;  // number of objects
uniform vec3 u_lm0;       // the drag's matrix: x' = a x + c y + e
uniform vec3 u_lm1;       //                    y' = b x + d y + f
flat out vec4 v_color;
flat out vec4 v_flags;    // part, depth, dash (device px; 0 = solid), kind
out vec2 v_local;
flat out float v_len;
flat out float v_hw;
flat out vec2 v_tan;
flat out float v_sheen;
flat out float v_tw;      // thread width (mm) of a shaded thread
void main() {
  int e = int(i_meta.x);
  ivec2 at = ivec2((e % 64) * 3, e / 64);
  vec4 t0 = texelFetch(u_entries, at, 0); // hw (mm), min hw css px, off x / sheen, off y
  vec4 t1 = texelFetch(u_entries, at + ivec2(1, 0), 0); // premultiplied rgba
  vec4 t2 = texelFetch(u_entries, at + ivec2(2, 0), 0); // part, depth (part 3: slot offset), dash css px, kind
  float kind = t2.w; // 0 stitch, 1 jump, 2 dot, 6 shaded thread, 7 soft shadow
  bool hidden = i_meta.y >= u_limit || (kind == 1.0 && u_jumps < 0.5) || (kind == 2.0 && u_dots < 0.5);
  if (hidden) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  vec2 off = kind == 6.0 ? vec2(0.0) : t0.zw;
  vec4 seg = i_seg;
  if (u_live > 0.5) {
    // stitches of the objects being dragged follow the drag (no new plan meanwhile)
    int r = int(i_meta.y);
    float o = texelFetch(u_recObj, ivec2(r % 4096, r / 4096), 0).r;
    if (o >= 0.0 && o < u_objects) {
      int oi = int(o);
      if (texelFetch(u_moving, ivec2(oi % 4096, oi / 4096), 0).r > 0.5) {
        seg = vec4(dot(u_lm0, vec3(seg.xy, 1.0)), dot(u_lm1, vec3(seg.xy, 1.0)), dot(u_lm0, vec3(seg.zw, 1.0)), dot(u_lm1, vec3(seg.zw, 1.0)));
      }
    }
  }
  vec2 p0 = (seg.xy + off) * u_view.x + u_view.yz;
  vec2 p1 = (seg.zw + off) * u_view.x + u_view.yz;
  vec2 d = p1 - p0;
  float len = length(d);
  vec2 t = len > 1e-5 ? d / len : vec2(1.0, 0.0);
  vec2 n = vec2(-t.y, t.x);
  float hw = max(t0.x * u_view.x, t0.y * u_dpr);
  v_tw = t0.x * 2.0;
  float ext = hw + 1.0;
  float along = mix(-ext, len + ext, a_corner.x);
  float across = a_corner.y * ext;
  vec2 p = p0 + t * along + n * across;
  v_local = vec2(along, across);
  v_len = len;
  v_hw = hw;
  v_tan = t;
  v_sheen = t0.z;
  v_color = t1;
  float depth = t2.x == 3.0 ? 1.0 - (i_meta.z + t2.y + 1.0) / (u_depthDen + 1.0) : t2.y;
  v_flags = vec4(t2.x, depth, t2.z * u_dpr, kind);
  vec2 clip = p / u_res * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
}`;

const STITCH_FS = `#version 300 es
precision highp float;
flat in vec4 v_color;
flat in vec4 v_flags;
in vec2 v_local;
flat in float v_len;
flat in float v_hw;
flat in vec2 v_tan;
flat in float v_sheen;
flat in float v_tw;
uniform vec3 u_view;
out vec4 o_color;
// light from the top left (screen space, y down, z towards the viewer)
const vec3 L = vec3(-0.42, -0.58, 0.70);
const vec3 H = vec3(-0.21, -0.29, 0.93); // normalize(L + V)
void main() {
  float kind = v_flags.w;
  float dx = max(max(-v_local.x, v_local.x - v_len), 0.0);
  float dist = length(vec2(dx, v_local.y));
  float hw = v_hw;
  if (kind == 6.0) {
    // shaded thread: it dips into the needle hole at both ends
    float e = min(v_local.x, v_len - v_local.x);
    float te = max(min(0.6 * v_tw * u_view.x, v_len * 0.4), 1.0);
    float dip = smoothstep(0.0, te, e);
    hw *= mix(0.45, 1.0, dip);
    float cov = clamp(hw - dist + 0.5, 0.0, 1.0);
    if (cov <= 0.0) discard;
    vec3 base = v_color.rgb / max(v_color.a, 1e-4);
    vec3 lin = base * base; // ~sRGB → linear
    // cylinder normal across the thread
    float a = clamp(v_local.y / max(hw, 1e-3), -1.0, 1.0);
    vec3 nrm = vec3(vec2(-v_tan.y, v_tan.x) * a, sqrt(max(1.0 - a * a, 0.0)));
    float diff = max(dot(nrm, normalize(L)), 0.0);
    // anisotropic sheen along the fibres (Kajiya-Kay), strongest on the lit side
    float th = dot(vec3(v_tan, 0.0), H);
    float sinTH = sqrt(max(1.0 - th * th, 0.0));
    float gloss = clamp(v_sheen, 0.0, 1.5);
    float spec = pow(sinTH, mix(10.0, 48.0, min(gloss, 1.0))) * (0.3 + 0.7 * pow(max(dot(nrm, H), 0.0), 3.0));
    // ply twist: diagonal stripes about one thread width apart
    float pitch = 0.9 * v_tw * u_view.x;
    float twist = 0.5 + 0.5 * sin(6.2832 * (v_local.x / max(pitch, 1e-3) + a * 0.5));
    float twistAmt = 0.16 * smoothstep(3.0, 9.0, pitch);
    // contact shadows: where neighbouring threads and the needle holes press in
    float occl = (1.0 - 0.35 * pow(abs(a), 3.0)) * mix(0.62, 1.0, dip);
    vec3 col = lin * (0.30 + 0.85 * diff) * occl * (1.0 - twistAmt * (1.0 - twist));
    vec3 sheenCol = mix(vec3(1.0), base, gloss > 1.1 ? 0.75 : 0.12);
    col += sheenCol * spec * gloss * 0.42 * occl;
    o_color = vec4(sqrt(col), 1.0) * cov;
    gl_FragDepth = v_flags.y;
    return;
  }
  float cov;
  if (kind == 7.0) {
    // soft contact shadow
    float soft = max(hw, 1.0);
    cov = 1.0 - smoothstep(soft * 0.3, soft + 0.5, dist);
  } else {
    cov = clamp(hw - dist + 0.5, 0.0, 1.0);
  }
  if (cov <= 0.0) discard;
  if (v_flags.x == 1.0 && cov < 0.999) discard;   // interior part
  if (v_flags.x == 2.0 && cov >= 0.999) discard;  // fringe part
  if (v_flags.z > 0.0 && mod(v_local.x, 2.0 * v_flags.z) > v_flags.z) discard;
  gl_FragDepth = v_flags.y;
  o_color = v_color * cov;
}`;

const FABRIC_VS = `#version 300 es
layout(location = 0) in vec2 a_corner;
void main() { gl_Position = vec4(a_corner.x * 2.0 - 1.0, a_corner.y, 0.0, 1.0); }`;

const FABRIC_FS = `#version 300 es
precision highp float;
uniform vec4 u_rect;   // hoop x, y, w, h (css px)
uniform float u_radius;
uniform float u_dpr;
uniform float u_height; // canvas height (device px)
uniform float u_scale;  // css px per mm
uniform vec3 u_color;
uniform float u_kind;   // texture kind
uniform float u_pitch;  // feature size (mm)
uniform float u_oval;   // 1 = oval / round hoop
uniform float u_minPx;  // the weave is drawn at least this coarse (device px; 0 = true size)
out vec4 o_color;

float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) { return 0.5 * vnoise(p) + 0.3 * vnoise(p * 2.03 + 7.1) + 0.2 * vnoise(p * 4.1 + 3.7); }
// distance to the nearest and second-nearest cell point
vec2 worley(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  float d1 = 9.0, d2 = 9.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 g = vec2(x, y);
    vec2 o = vec2(hash(i + g), hash(i + g + 17.3));
    float d = length(g + o - f);
    if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) d2 = d;
  }
  return vec2(d1, d2);
}
// a yarn seen from above: bright on its crown, dark where it dips under
float yarn(float f) { return 0.78 + 0.3 * sin(3.14159 * f); }

void main() {
  vec2 css = vec2(gl_FragCoord.x, u_height - gl_FragCoord.y) / u_dpr;
  vec2 half_ = u_rect.zw * 0.5;
  vec2 rel = css - u_rect.xy - half_;
  float sd;
  if (u_oval > 0.5) {
    float k = length(rel / half_);
    sd = (k - 1.0) * min(half_.x, half_.y);
  } else {
    vec2 q = abs(rel) - half_ + u_radius;
    sd = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - u_radius;
  }
  float cov = clamp(0.5 - sd * u_dpr, 0.0, 1.0);
  if (cov <= 0.0) discard;

  vec2 mm = (css - u_rect.xy) / u_scale;
  // true size, or coarser where it would be finer than u_minPx pixels
  float pitch = max(u_pitch, u_minPx / (u_scale * u_dpr));
  vec2 g = mm / pitch;
  vec2 i = floor(g), f = fract(g);
  float k = u_kind;
  float v = 1.0;      // brightness
  float mean = 0.92;  // its average, shown when the texture is too fine to see
  vec3 tint = vec3(1.0);
  if (k < -0.5) {
    // no texture: the plain colour
    v = 1.0;
    mean = 1.0;
  } else if (k < 0.5) {
    // plain weave: warp and weft alternate over and under
    bool weftUp = mod(i.x + i.y, 2.0) < 1.0;
    v = weftUp ? yarn(f.y) : yarn(f.x) * 0.96;
  } else if (k < 1.5) {
    // open plain weave (organza): gaps between the yarns
    bool weftUp = mod(i.x + i.y, 2.0) < 1.0;
    float gap = smoothstep(0.0, 0.18, min(min(f.x, 1.0 - f.x), min(f.y, 1.0 - f.y)));
    v = (weftUp ? yarn(f.y) : yarn(f.x)) * mix(0.72, 1.0, gap);
    mean = 0.86;
  } else if (k < 2.5) {
    // 2/1 twill (denim, caps): diagonal ribs; the weft shows lighter
    bool warpUp = mod(i.x - i.y, 3.0) < 2.0;
    v = warpUp ? yarn(f.x) : yarn(f.y);
    if (!warpUp) tint = vec3(1.18);
    mean = 0.97;
  } else if (k < 3.5) {
    // single jersey: columns of V-shaped loops
    vec2 c = vec2(fract(mm.x / pitch) * 2.0 - 1.0, fract(mm.y / (pitch * 0.78)));
    float leg = min(abs(c.x + 0.5 - (c.y - 0.5) * 0.7), abs(c.x - 0.5 + (c.y - 0.5) * 0.7));
    v = 0.7 + 0.36 * sqrt(clamp(1.0 - leg / 0.48, 0.0, 1.0));
    mean = 0.9;
  } else if (k < 4.5) {
    // piqué: jersey with a staggered grid of pits
    vec2 c = vec2(fract(mm.x / (pitch * 0.5)) * 2.0 - 1.0, fract(mm.y / (pitch * 0.4)));
    float leg = min(abs(c.x + 0.5 - (c.y - 0.5) * 0.7), abs(c.x - 0.5 + (c.y - 0.5) * 0.7));
    v = 0.76 + 0.3 * sqrt(clamp(1.0 - leg / 0.48, 0.0, 1.0));
    vec2 h = g + vec2(mod(i.y, 2.0) * 0.5, 0.0);
    float pit = length(fract(h) - 0.5);
    v *= mix(0.78, 1.0, smoothstep(0.18, 0.34, pit));
    mean = 0.88;
  } else if (k < 5.5) {
    // fleece: soft, fuzzy, no structure
    v = 0.86 + 0.18 * fbm(mm * 2.4) + 0.08 * (vnoise(mm * 14.0) - 0.5);
    mean = 0.95;
  } else if (k < 6.5) {
    // felt: matted fibres
    float a = vnoise(mm * vec2(9.0, 2.2));
    float b = vnoise(mm.yx * vec2(8.0, 2.6) + 11.0);
    v = 0.86 + 0.16 * fbm(mm * 1.6) + 0.07 * (a + b - 1.0);
    mean = 0.94;
  } else if (k < 7.5) {
    // terry: dense loops
    vec2 w = worley(g * 1.6);
    v = 0.84 + 0.2 * smoothstep(0.8, 0.15, w.x) - 0.05 * vnoise(mm * 6.0);
    mean = 0.92;
  } else {
    // leather: grain cells and creases
    vec2 w = worley(g);
    float crease = smoothstep(0.0, 0.18, w.y - w.x);
    v = (0.72 + 0.3 * crease) * (0.9 + 0.14 * fbm(mm * 5.0)) * (0.95 + 0.1 * vnoise(mm * 0.6));
    mean = 0.9;
  }
  // fade the texture out where it gets smaller than the pixels
  float px = pitch * u_scale * u_dpr;
  float detail = k > 4.5 && k < 6.5 ? smoothstep(0.6, 2.5, px) : smoothstep(1.6, 4.0, px);
  vec3 lin = u_color * u_color;
  vec3 col = lin * mix(vec3(mean), v * tint, detail);
  col *= 1.0 + 0.05 * (fbm(mm * 0.08) - 0.5); // dye and tension variation
  // the hoop ring shades the fabric next to it
  col *= mix(0.86, 1.0, smoothstep(0.0, 9.0, -sd));
  col = sqrt(col);
  o_color = vec4(col * cov, cov);
}`;

/** Texture kind and feature size (mm) of each fabric in the realistic view. */
const FABRIC_LOOK: Record<Fabric, [kind: number, pitch: number]> = {
  cotton: [0, 0.28],
  polyester: [0, 0.22],
  silk: [0, 0.12],
  canvas: [0, 0.6],
  sheer: [1, 0.4],
  denim: [2, 0.45],
  cap: [2, 0.38],
  knit: [3, 0.9],
  pique: [4, 1.4],
  fleece: [5, 1.0],
  felt: [6, 1.0],
  towel: [7, 1.3],
  leather: [8, 0.9],
};

function rgb(c: string): [number, number, number] {
  const m = /rgb\((\d+),(\d+),(\d+)\)/.exec(c);
  if (m) return [+m[1] / 255, +m[2] / 255, +m[3] / 255];
  const v = parseInt(c.replace("#", ""), 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

type Mode = "stitch" | "realistic";

interface Built {
  plan: PlanData;
  underlay: boolean;
  mode: Mode;
  dark: boolean;
  /** Design thread width (mm) the build was made for. */
  threadW: number;
  instances: number;
  inst: WebGLBuffer;
  entries: WebGLTexture;
  /** Depth slots of a realistic build. */
  depthDen: number;
  /** Object index of every record. */
  recObj: WebGLTexture;
}

export interface GLFrame {
  view: View;
  dpr: number;
  width: number; // CSS px
  height: number;
  mode: Mode;
  plan: PlanData;
  showUnderlay: boolean;
  showJumps: boolean;
  limit: number;
  theme: Theme;
  fabricColor: string;
  hoop: { width: number; height: number; shape?: string };
  /** The design's fabric (texture in the realistic view). */
  fabric?: Fabric;
  /** Thread width on the fabric (mm) from the design's thread weight; threads with their own weight use theirs. */
  threadWidth?: number;
  /** The 2D layer paints the fabric (reference pictures sit on it). */
  noFabric?: boolean;
  /** Where the fabric lies (mm) when it is not the hoop (previews). */
  fabricArea?: { x: number; y: number; w: number; h: number };
  /** The fabric texture when it is not the design's fabric ("none": plain colour). */
  fabricTexture?: Fabric | "none";
  /** Draw the weave at least this coarse (device px) so it shows when zoomed out; 0 = true size. */
  weaveMinPx?: number;
  /** A drag transforming objects: their indices (1 = moving, per object) and the matrix [a b c d e f]. */
  live?: { key: string; mask: Uint8Array; m: [number, number, number, number, number, number] } | null;
}

/**
 * Layering slots for the shaded threads of one colour block (realistic view). A later
 * stitch normally lies on top of an earlier one, which is right between objects and
 * for satins. But in a fill the rows overlap their neighbours, and a section sewn
 * upwards would show every row's shaded lower half while one sewn downwards shows the
 * lit upper half: the same fill looked striped wherever the engine changed its section
 * direction. So within each run of near-parallel top stitches of one object (a fill's
 * rows), the rows are layered by position, the lower on screen on top (away from the
 * light), whatever order they were sewn in. The slots are those of the run itself, so
 * the layering between objects and the stitch-out cut-off are unchanged. (The caller
 * submits the threads in this order as well.)
 */
export function rowSlots(segs: number[], rec: number[], plan: PlanData): number[] {
  const slots = rec.slice();
  const n = rec.length;
  let a = 0;
  while (a < n) {
    const obj = plan.objects[rec[a]];
    const under = plan.flags[rec[a]] & FLAG.UNDERLAY;
    let b = a + 1;
    while (b < n && plan.objects[rec[b]] === obj && (plan.flags[rec[b]] & FLAG.UNDERLAY) === under) b++;
    if (!under && b - a >= 24) {
      // the run's dominant stitch direction (mean of doubled angles) and how coherent it is
      let cx = 0, cy = 0, w = 0;
      for (let j = a; j < b; j++) {
        const dx = segs[4 * j + 2] - segs[4 * j], dy = segs[4 * j + 3] - segs[4 * j + 1];
        const l2 = dx * dx + dy * dy;
        if (l2 < 1e-6) continue;
        cx += (dx * dx - dy * dy) / Math.sqrt(l2);
        cy += (2 * dx * dy) / Math.sqrt(l2);
        w += Math.sqrt(l2);
      }
      if (w > 0 && Math.hypot(cx, cy) / w > 0.85) {
        const th = Math.atan2(cy, cx) / 2;
        // across the rows, pointing away from the light (which comes from the top left)
        let nx = -Math.sin(th), ny = Math.cos(th);
        if (nx * 0.6 + ny * 0.8 < 0) [nx, ny] = [-nx, -ny];
        const ux = Math.cos(th), uy = Math.sin(th);
        // stitches across the rows (the short links between them) go underneath, in their
        // own order; the rows themselves are layered by position
        const along = (j: number) => {
          const dx = segs[4 * j + 2] - segs[4 * j], dy = segs[4 * j + 3] - segs[4 * j + 1];
          const l = Math.hypot(dx, dy);
          return l < 1e-3 || Math.abs(dx * ux + dy * uy) / l > 0.94;
        };
        const links: number[] = [], rows: number[] = [];
        for (let j = a; j < b; j++) (along(j) ? rows : links).push(j);
        const key = (j: number) => ((segs[4 * j] + segs[4 * j + 2]) / 2) * nx + ((segs[4 * j + 1] + segs[4 * j + 3]) / 2) * ny;
        rows.sort((p, q) => key(p) - key(q));
        const idx = [...links, ...rows];
        const pool = rec.slice(a, b).sort((p, q) => p - q);
        idx.forEach((j, r) => (slots[j] = pool[r]));
      }
    }
    a = b;
  }
  return slots;
}

export class StitchGL {
  readonly gl: WebGL2RenderingContext;
  private stitchProg: WebGLProgram;
  private fabricProg: WebGLProgram;
  private vao: WebGLVertexArrayObject;
  private fabricVao: WebGLVertexArrayObject;
  private quad: WebGLBuffer;
  private us: Record<string, WebGLUniformLocation | null> = {};
  private uf: Record<string, WebGLUniformLocation | null> = {};
  private built: Built | null = null;

  static create(canvas: HTMLCanvasElement): StitchGL | null {
    const gl = canvas.getContext("webgl2", { antialias: false, depth: true, premultipliedAlpha: true, preserveDrawingBuffer: true, alpha: true });
    if (!gl) return null;
    try {
      return new StitchGL(gl);
    } catch (e) {
      console.warn("WebGL2 stitch renderer unavailable:", e);
      return null;
    }
  }

  private program(vs: string, fs: string): WebGLProgram {
    const gl = this.gl;
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader");
      return s;
    };
    const p = gl.createProgram()!;
    gl.attachShader(p, sh(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? "link");
    return p;
  }

  private constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.stitchProg = this.program(STITCH_VS, STITCH_FS);
    this.fabricProg = this.program(FABRIC_VS, FABRIC_FS);
    for (const n of ["u_view", "u_res", "u_dpr", "u_limit", "u_jumps", "u_dots", "u_entries", "u_depthDen", "u_recObj", "u_moving", "u_live", "u_objects", "u_lm0", "u_lm1"]) this.us[n] = gl.getUniformLocation(this.stitchProg, n);
    for (const n of ["u_rect", "u_radius", "u_dpr", "u_height", "u_color", "u_scale", "u_kind", "u_pitch", "u_oval", "u_minPx"]) this.uf[n] = gl.getUniformLocation(this.fabricProg, n);
    this.quad = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, -1, 1, -1, 0, 1, 1, 1]), gl.STATIC_DRAW);
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    this.fabricVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.fabricVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
  }

  /** Build the ordered instance buffer + entry table for a plan and mode. */
  private build(plan: PlanData, showUnderlay: boolean, mode: Mode, theme: Theme, threadW: number): Built {
    const b = this.built;
    if (b && b.plan === plan && b.underlay === showUnderlay && b.mode === mode && b.dark === theme.dark && b.threadW === threadW) return b;
    const gl = this.gl;
    if (b) {
      gl.deleteBuffer(b.inst);
      gl.deleteTexture(b.entries);
      gl.deleteTexture(b.recObj);
    }
    const { coords, flags } = plan;
    const chunks = getChunks(plan, showUnderlay);
    // Entry table: [hw, min hw css px, off x | sheen, off y][r g b a premultiplied][part, depth | slot offset, dash css px, kind]
    const entries: number[] = [];
    const inst: number[] = [];
    // geometry of the current colour block
    let segs: number[] = [];
    let segRec: number[] = [];
    let jumps: number[] = [];
    let jumpRec: number[] = [];
    let dots: number[] = [];
    let dotRec: number[] = [];
    const realistic = mode === "realistic";
    // stitch view: one depth per entry, decreasing with every entry
    const perChunk = 2 + 2 + 2;
    const total = chunks.length * perChunk + 2;
    // realistic view: depth slots — per colour block k the shadow (first record + 3k),
    // every stitch (its record + 3k + 1) and the jumps (last record + 3k + 2)
    const blocks = chunks.length ? chunks[chunks.length - 1].block + 1 : 0;
    const depthDen = flags.length + 3 * blocks + 4;
    const slotDepth = (slot: number) => 1 - (slot + 1) / (depthDen + 1);
    let entryCount = 0;
    const addEntry = (hw: number, minHw: number, ox: number, oy: number, c: [number, number, number], a: number, part: number, depth: number, dash: number, kind: number) => {
      entries.push(hw, minHw, ox, oy, c[0] * a, c[1] * a, c[2] * a, a, part, depth, dash, kind);
      return entryCount++;
    };
    const nextDepth = () => 1 - (entryCount + 1) / (total + 1);
    const emit = (geo: number[], rec: number[], e: number, slot: number[] = rec) => {
      for (let i = 0, j = 0; i < geo.length; i += 4, j++) inst.push(geo[i], geo[i + 1], geo[i + 2], geo[i + 3], e, rec[j], slot[j]);
    };
    /** A pass drawn once per pixel: interior instances first, then the fringe. */
    const pass = (geo: number[], rec: number[], hw: number, minHw: number, ox: number, oy: number, c: [number, number, number], a: number, dash = 0, kind = 0, depth?: number) => {
      emit(geo, rec, addEntry(hw, minHw, ox, oy, c, a, 1, depth ?? nextDepth(), dash, kind));
      emit(geo, rec, addEntry(hw, minHw, ox, oy, c, a, 2, depth ?? nextDepth(), dash, kind));
    };
    const dotColor: [number, number, number] = theme.dark ? [1, 1, 1] : [0, 0, 0];
    let blockStart = 0;
    for (let ci = 0; ci < chunks.length; ci++) {
      const c = chunks[ci];
      // geometry accumulates over the chunks of one colour block
      if (ci === 0 || chunks[ci - 1].block !== c.block) {
        segs = [];
        segRec = [];
        jumps = [];
        jumpRec = [];
        dots = [];
        dotRec = [];
        blockStart = c.start;
      }
      let pen = c.penIn;
      let x = c.x;
      let y = c.y;
      for (let i = c.start; i < c.end; i++) {
        const f = flags[i];
        const nx = coords[i * 2];
        const ny = coords[i * 2 + 1];
        if (f & (FLAG.COLOR_CHANGE | FLAG.TRIM | FLAG.STOP | FLAG.END)) {
          pen = false;
          continue;
        }
        if (f & FLAG.JUMP) {
          jumps.push(x, y, nx, ny);
          jumpRec.push(i);
          pen = false;
          x = nx;
          y = ny;
          continue;
        }
        if (!showUnderlay && f & FLAG.UNDERLAY) {
          pen = false;
          x = nx;
          y = ny;
          continue;
        }
        if (pen) {
          segs.push(x, y, nx, ny);
          segRec.push(i);
        }
        if (!realistic) {
          dots.push(nx, ny, nx, ny);
          dotRec.push(i);
        }
        pen = true;
        x = nx;
        y = ny;
      }
      // passes once the block is complete
      if (ci + 1 < chunks.length && chunks[ci + 1].block === c.block) continue;
      const col = rgb(c.color);
      if (realistic) {
        const k = c.block;
        // the thread's own width (its weight), else the design's
        const tw = plan.threads[k]?.weight ? threadWidth(plan.threads[k].weight as ThreadWeight) : threadW;
        // soft contact shadow, offset away from the light
        pass(segs, segRec, 0.85 * tw, 0, 0.06, 0.09, [0, 0, 0], 0.3, 0, 7, slotDepth(blockStart + 3 * k));
        // shaded threads in sewing order (opaque: one instance per stitch, own depth)
        const e = addEntry(0.5 * tw, 0, threadSheen(plan.threads[k]), 0, col, 1, 3, 3 * k + 1, 0, 6);
        // submitted in layering order too: the threads' soft edges blend over what is
        // already drawn, so whatever lies underneath has to be drawn first
        const slots = rowSlots(segs, segRec, plan);
        const order = slots.map((_, j) => j).sort((a, b) => slots[a] - slots[b]);
        const g: number[] = [], rc: number[] = [], sl: number[] = [];
        for (const j of order) {
          g.push(segs[4 * j], segs[4 * j + 1], segs[4 * j + 2], segs[4 * j + 3]);
          rc.push(segRec[j]);
          sl.push(slots[j]);
        }
        emit(g, rc, e, sl);
        pass(jumps, jumpRec, 0, 0.5, 0, 0, dotColor, theme.dark ? 0.5 : 0.45, 3.6, 1, slotDepth(c.end + 3 * k + 2));
      } else {
        pass(segs, segRec, 0.06, 0.55, 0, 0, col, 1);
        pass(dots, dotRec, 0, 0.8, 0, 0, dotColor, theme.dark ? 0.55 : 0.45, 0, 2);
        pass(jumps, jumpRec, 0, 0.5, 0, 0, dotColor, theme.dark ? 0.5 : 0.45, 3.6, 1);
      }
    }

    const instBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, instBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(inst.length ? inst : [0, 0, 0, 0, 0, 1e9, 1e9]), gl.STATIC_DRAW);
    gl.bindVertexArray(this.vao);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 28, 0);
    gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 3, gl.FLOAT, false, 28, 16);
    gl.vertexAttribDivisor(2, 1);
    gl.bindVertexArray(null);

    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    const rows = Math.max(1, Math.ceil(entryCount / 64));
    const table = new Float32Array(rows * 64 * 12);
    table.set(entries);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, 64 * 3, rows, 0, gl.RGBA, gl.FLOAT, table);
    // which object every record belongs to (a drag moves their stitches)
    const recObj = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, recObj);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    const recRows = Math.max(1, Math.ceil(plan.objects.length / 4096));
    const objs = new Float32Array(recRows * 4096).fill(-1);
    for (let i = 0; i < plan.objects.length; i++) objs[i] = plan.objects[i] === 0xffffffff ? -1 : plan.objects[i];
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, 4096, recRows, 0, gl.RED, gl.FLOAT, objs);
    this.built = { plan, underlay: showUnderlay, mode, dark: theme.dark, threadW, instances: inst.length / 7, inst: instBuf, entries: tex, depthDen, recObj };
    return this.built;
  }

  private resize(pw: number, ph: number) {
    const c = this.gl.canvas as HTMLCanvasElement;
    if (c.width !== pw || c.height !== ph) {
      c.width = pw;
      c.height = ph;
    }
    this.gl.viewport(0, 0, pw, ph);
  }

  clear(pw: number, ph: number) {
    const gl = this.gl;
    this.resize(pw, ph);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  }

  render(f: GLFrame) {
    const gl = this.gl;
    const pw = Math.round(f.width * f.dpr);
    const ph = Math.round(f.height * f.dpr);
    this.resize(pw, ph);
    gl.clearColor(0, 0, 0, 0);
    gl.clearDepth(1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    if (f.mode === "realistic" && !f.noFabric) {
      gl.disable(gl.DEPTH_TEST);
      gl.useProgram(this.fabricProg);
      gl.bindVertexArray(this.fabricVao);
      const { scale, ox, oy } = f.view;
      const tex = f.fabricTexture ?? f.fabric ?? "cotton";
      const [kind, pitch] = tex === "none" ? [-1, 1] : (FABRIC_LOOK[tex] ?? FABRIC_LOOK.cotton);
      gl.uniform1f(this.uf.u_minPx, f.weaveMinPx ?? 0);
      const fa = f.fabricArea;
      if (fa) gl.uniform4f(this.uf.u_rect, ox + fa.x * scale, oy + fa.y * scale, fa.w * scale, fa.h * scale);
      else gl.uniform4f(this.uf.u_rect, ox, oy, f.hoop.width * scale, f.hoop.height * scale);
      gl.uniform1f(this.uf.u_radius, Math.min(12, 6 * scale));
      gl.uniform1f(this.uf.u_dpr, f.dpr);
      gl.uniform1f(this.uf.u_height, ph);
      gl.uniform1f(this.uf.u_scale, scale);
      gl.uniform1f(this.uf.u_kind, kind);
      gl.uniform1f(this.uf.u_pitch, pitch);
      gl.uniform1f(this.uf.u_oval, !f.fabricArea && f.hoop.shape === "oval" ? 1 : 0);
      const fc = rgb(f.fabricColor);
      gl.uniform3f(this.uf.u_color, fc[0], fc[1], fc[2]);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    const b = this.build(f.plan, f.showUnderlay, f.mode, f.theme, f.threadWidth ?? 0.4);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LESS);
    gl.depthMask(true);
    gl.useProgram(this.stitchProg);
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, b.entries);
    gl.uniform1i(this.us.u_entries, 0);
    const s = f.view.scale * f.dpr;
    gl.uniform3f(this.us.u_view, s, f.view.ox * f.dpr, f.view.oy * f.dpr);
    gl.uniform2f(this.us.u_res, pw, ph);
    gl.uniform1f(this.us.u_dpr, f.dpr);
    gl.uniform1f(this.us.u_limit, f.limit);
    gl.uniform1f(this.us.u_jumps, f.showJumps ? 1 : 0);
    gl.uniform1f(this.us.u_dots, f.mode === "stitch" && f.view.scale > 14 ? 1 : 0);
    gl.uniform1f(this.us.u_depthDen, b.depthDen);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, b.recObj);
    gl.uniform1i(this.us.u_recObj, 1);
    const live = f.live && f.live.mask.length ? f.live : null;
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.movingTex(live));
    gl.uniform1i(this.us.u_moving, 2);
    gl.uniform1f(this.us.u_live, live ? 1 : 0);
    gl.uniform1f(this.us.u_objects, live ? live.mask.length : 0);
    const m = live?.m ?? [1, 0, 0, 1, 0, 0];
    gl.uniform3f(this.us.u_lm0, m[0], m[2], m[4]);
    gl.uniform3f(this.us.u_lm1, m[1], m[3], m[5]);
    gl.activeTexture(gl.TEXTURE0);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, b.instances);
    gl.bindVertexArray(null);
  }

  private moving: { key: string; tex: WebGLTexture } | null = null;

  /** The mask of the objects a drag transforms (uploaded when the set changes). */
  private movingTex(live: GLFrame["live"]): WebGLTexture {
    const gl = this.gl;
    const key = live?.key ?? "";
    if (this.moving && this.moving.key === key) return this.moving.tex;
    const tex = this.moving?.tex ?? gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    const n = live?.mask.length ?? 0;
    const rows = Math.max(1, Math.ceil(n / 4096));
    const data = new Uint8Array(rows * 4096);
    if (live) data.set(live.mask);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, 4096, rows, 0, gl.RED, gl.UNSIGNED_BYTE, data);
    this.moving = { key, tex };
    return tex;
  }

  dispose() {
    const gl = this.gl;
    if (this.built) {
      gl.deleteBuffer(this.built.inst);
      gl.deleteTexture(this.built.entries);
      gl.deleteTexture(this.built.recObj);
    }
    if (this.moving) gl.deleteTexture(this.moving.tex);
    gl.deleteBuffer(this.quad);
    gl.deleteVertexArray(this.vao);
    gl.deleteVertexArray(this.fabricVao);
    gl.deleteProgram(this.stitchProg);
    gl.deleteProgram(this.fabricProg);
    // previews come and go: give the context back (browsers allow only a few)
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}
