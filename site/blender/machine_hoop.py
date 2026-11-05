"""A home-machine embroidery hoop (4 × 4″ / 100 × 100 mm screw hoop), modelled
from reference (issue #8): plastic outer frame split at a boss with a knurled
thumb screw, a taller inner frame pressed in from the top with centre notches
and mm ticks, and a mounting bracket that clips onto the embroidery arm.
Units are centimetres; the hoop sits on z = 0 with its sewing field centred.
"""

import math

import bmesh
import bpy

import common as C


OUTER_HALF, OUTER_R = 6.28, 1.95  # the outer frame's outside: half-size and corner radius (cm)
BOSS_X, SCREW_Z = 6.73, 0.52
# where the fabric's skirt must not go (hoop coordinates): the screw, its bosses and knob,
# and the bracket's neck; there the fabric ends at the frame's edge
OBSTACLES = [(6.1, 7.4, -4.0, -0.95), (-7.5, -6.1, -1.75, 1.75)]


def rounded_rect(w, h, r, n=12):
    """Points of a rounded rectangle (counter-clockwise), centred on the origin."""
    pts = []
    for cx, cy, a0 in ((w / 2 - r, h / 2 - r, 0), (-w / 2 + r, h / 2 - r, 90), (-w / 2 + r, -h / 2 + r, 180), (w / 2 - r, -h / 2 + r, 270)):
        for i in range(n + 1):
            a = math.radians(a0 + 90 * i / n)
            pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
    return pts


def ring(name, w, h, r, wall, z0, z1, mat, bevel=0.035):
    """A frame: the band between a rounded rectangle and its inset, from z0 to z1."""
    outer = rounded_rect(w, h, r)
    inner = rounded_rect(w - 2 * wall, h - 2 * wall, max(0.05, r - wall))
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    loops = [[bm.verts.new((x, y, z)) for x, y in pts] for pts, z in ((outer, z0), (outer, z1), (inner, z1), (inner, z0))]
    n = len(outer)
    for a, b in ((0, 1), (1, 2), (2, 3), (3, 0)):
        for i in range(n):
            j = (i + 1) % n
            bm.faces.new((loops[a][i], loops[a][j], loops[b][j], loops[b][i]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new(name, me)
    bv = ob.modifiers.new("Bevel", "BEVEL")
    bv.width = bevel
    bv.segments = 3
    bv.limit_method = "ANGLE"
    ob.modifiers.new("Normals", "WEIGHTED_NORMAL").keep_sharp = True
    ob.data.materials.append(mat)
    for p in ob.data.polygons:
        p.use_smooth = True
    return ob


def box(name, size, loc, mat, bevel=0.06, rot=(0, 0, 0)):
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    for v in bm.verts:
        v.co.x *= size[0]
        v.co.y *= size[1]
        v.co.z *= size[2]
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new(name, me)
    ob.location = loc
    ob.rotation_euler = rot
    if bevel:
        bv = ob.modifiers.new("Bevel", "BEVEL")
        bv.width = bevel
        bv.segments = 4
        ob.modifiers.new("Normals", "WEIGHTED_NORMAL")
    ob.data.materials.append(mat)
    for p in ob.data.polygons:
        p.use_smooth = True
    return ob


def cylinder(name, r, depth, loc, mat, rot=(0, 0, 0), segments=64, knurl=0, bevel=0.03):
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, segments=segments, radius1=r, radius2=r, depth=depth)
    if knurl:  # ribs around the grip
        for v in bm.verts:
            a = math.atan2(v.co.y, v.co.x)
            k = 1.0 + 0.045 * (0.5 + 0.5 * math.cos(a * knurl))
            v.co.x *= k
            v.co.y *= k
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new(name, me)
    ob.location = loc
    ob.rotation_euler = rot
    if bevel:
        bv = ob.modifiers.new("Bevel", "BEVEL")
        bv.width = bevel
        bv.segments = 3
        bv.limit_method = "ANGLE"
    ob.data.materials.append(mat)
    for p in ob.data.polygons:
        p.use_smooth = True
    return ob


def cut(ob, cutter, scene):
    """Boolean difference; the cutter stays hidden."""
    m = ob.modifiers.new("Cut " + cutter.name, "BOOLEAN")
    m.operation = "DIFFERENCE"
    m.object = cutter
    m.solver = "EXACT"
    cutter.hide_render = True
    cutter.hide_viewport = True
    # put the boolean before the bevel so the edges of the cut get rounded too
    ob.modifiers.move(len(ob.modifiers) - 1, 0)
    return m


def plastic(name, color, roughness=0.32, gloss=False):
    """ABS: a soft gloss with a faint moulding texture (gloss: a lacquered clear coat)."""
    m = C.material(name, color, roughness=roughness, coat=0.15)
    if gloss:
        b = m.node_tree.nodes["Principled BSDF"]
        b.inputs["Roughness"].default_value = min(roughness, 0.22)
        b.inputs["Coat Weight"].default_value = 1.0
        b.inputs["Coat Roughness"].default_value = 0.04
    nt = m.node_tree
    b = nt.nodes["Principled BSDF"]
    noise = nt.nodes.new("ShaderNodeTexNoise")
    noise.inputs["Scale"].default_value = 180.0
    noise.inputs["Detail"].default_value = 4.0
    bump = nt.nodes.new("ShaderNodeBump")
    bump.inputs["Strength"].default_value = 0.04
    nt.links.new(noise.outputs["Fac"], bump.inputs["Height"])
    nt.links.new(bump.outputs["Normal"], b.inputs["Normal"])
    return m


def build(scene, parent, gloss=False):
    """The hoop with the sewing field (10 × 10 cm) centred on the origin, in the app's
    colours: violet frames (the accent), charcoal bracket and knob (the app's text colour),
    white markings, satin steel."""
    if gloss:
        light = C.lacquer("Hoop violet", C.VIOLET, roughness=0.36, coat=0.5)
        inner_m = C.lacquer("Hoop violet light", "#8b5cf6", roughness=0.36, coat=0.5)
        dark = C.lacquer("Hoop charcoal", "#46484a", roughness=0.42, coat=0.35)
        mark = C.lacquer("Hoop marking", "#fbfbf9", roughness=0.5, coat=0.2)
        steel = C.satin_steel()
    else:
        light = plastic("Hoop light plastic", "#d3d7dd")
        inner_m = light
        dark = plastic("Hoop dark plastic", "#4a4f57", roughness=0.4)
        mark = dark
        steel = C.material("Hoop steel", "#c9ccd1", roughness=0.22, metallic=1.0, anisotropic=0.3)
    obs = []
    # inner frame: taller, pressed in from the top
    inner = ring("Hoop inner frame", 11.6, 11.6, 1.5, 0.38, 0.0, 1.05, inner_m)
    obs.append(inner)
    # outer frame: lower, wider, around the inner one (fabric between them)
    outer = ring("Hoop outer frame", 12.56, 12.56, 1.95, 0.42, 0.0, 0.78, light)
    obs.append(outer)
    # the split in the outer frame where the screw closes it (right side, a little forward)
    gap = box("Hoop split", (1.0, 0.16, 2.0), (6.1, -2.2, 0.4), light, bevel=0)
    cut(outer, gap, scene)
    obs.append(gap)
    # screw bosses either side of the split, just outside the frame (so the fabric over
    # the frame clears them), the screw through them, the knurled knob outside; all of it
    # above the table (the knob's radius stays under the screw's height)
    for dy in (-0.62, 0.62):
        b = box("Hoop boss", (0.9, 0.95, 0.74), (BOSS_X, -2.2 + dy, 0.37), light, bevel=0.12)
        obs.append(b)
    obs.append(cylinder("Hoop screw", 0.11, 2.2, (BOSS_X, -2.2, SCREW_Z), steel, rot=(math.radians(90), 0, 0), segments=32, bevel=0))
    obs.append(cylinder("Hoop knob", 0.5, 0.62, (BOSS_X, -3.55, SCREW_Z), dark, rot=(math.radians(90), 0, 0), segments=96, knurl=24, bevel=0.06))
    obs.append(cylinder("Hoop knob cap", 0.33, 0.66, (BOSS_X, -3.56, SCREW_Z), dark, rot=(math.radians(90), 0, 0), segments=64, bevel=0.08))
    # mounting bracket on the left: a neck from the frame, an arm with two mounting holes,
    # a spring clip (metal) and a release lever, like the brackets that clip onto the arm
    obs.append(box("Bracket neck", (1.0, 3.0, 0.5), (-6.75, 0.0, 0.42), dark, bevel=0.12))
    arm = box("Hoop bracket", (3.2, 3.4, 0.32), (-8.7, 0.0, 0.5), dark, bevel=0.14)
    obs.append(arm)
    for dy in (-0.95, 0.95):
        hole = cylinder("Bracket hole", 0.28, 1.0, (-9.55, dy, 0.5), dark, bevel=0)
        cut(arm, hole, scene)
        obs.append(hole)
    obs.append(box("Bracket clip", (0.9, 2.2, 0.05), (-8.35, 0.0, 0.69), steel, bevel=0.025))
    obs.append(cylinder("Clip rivet", 0.09, 0.1, (-8.35, 0.75, 0.73), steel, segments=24, bevel=0.02))
    obs.append(cylinder("Clip rivet", 0.09, 0.1, (-8.35, -0.75, 0.73), steel, segments=24, bevel=0.02))
    obs.append(box("Bracket lever", (0.55, 1.6, 0.42), (-7.45, 0.0, 0.84), light, bevel=0.14))
    # centre notches on the inner frame's top edge and mm ticks along it
    for (x, y, rz) in ((0, 5.62, 0), (0, -5.62, 0), (5.62, 0, 90), (-5.62, 0, 90)):
        obs.append(box("Hoop notch", (0.08, 0.42, 0.06), (x, y, 1.06), mark, bevel=0.01, rot=(0, 0, math.radians(rz))))
    for side in range(4):
        for k in range(-8, 9):
            if k == 0:
                continue
            long = k % 5 == 0
            t = k * 0.5
            x, y, rz = ((t, 5.62, 0), (t, -5.62, 0), (5.62, t, 90), (-5.62, t, 90))[side]
            obs.append(box("Hoop tick", (0.022, 0.2 if long else 0.12, 0.012), (x, y, 1.056), mark, bevel=0, rot=(0, 0, math.radians(rz))))
    for ob in obs:
        C.link(scene, ob).parent = parent
    return obs


def offset_ring(d, ns=48, nc=14):
    """Points around the outer frame's rounded square offset by d (negative: inwards),
    counter-clockwise, always the same count, so rings at different offsets line up."""
    A = OUTER_HALF + d
    R = max(0.05, OUTER_R + d)
    sd = A - R
    pts = []
    for k in range(4):
        a0 = math.radians(90 * k)
        ux, uy = math.cos(a0), math.sin(a0)
        vx, vy = -uy, ux
        for i in range(ns):  # the straight side
            t = -sd + 2 * sd * i / ns
            pts.append((ux * A + vx * t, uy * A + vy * t, i / ns + k))
        cx, cy = ux * sd + vx * sd, uy * sd + vy * sd
        for i in range(nc):  # the corner
            a = a0 + math.radians(90) * i / nc
            pts.append((cx + R * math.cos(a), cy + R * math.sin(a), k + 0.75 + 0.25 * i / nc))
    return pts


# the hooped fabric's cross-section, from the sewing field outwards: (offset from the
# outer frame's outside, height of the fabric's top surface). Taut and flat in the field
# and under the inner frame, straight up in the gap between the frames, over the outer
# frame's top, round its edge and down its wall to a hem. (cm; frames: inner ring from
# -0.86 to -0.48, gap -0.48 to -0.42, outer ring -0.42 to 0, its top at 0.78)
PROFILE = [(-0.95, 0.0), (-0.46, 0.0), (-0.445, 0.83), (-0.40, 0.83), (-0.2, 0.835), (-0.03, 0.825),
           (0.03, 0.79), (0.065, 0.70), (0.08, 0.55), (0.085, 0.40), (0.09, 0.26), (0.095, 0.13)]


def hooped_fabric(scene, mat, seed=4):
    """The fabric as it sits in the hoop (see PROFILE), with a few soft wrinkles where it
    gathers round the corners and an uneven hem. Never passes through a frame."""
    from mathutils import Vector, noise

    me = bpy.data.meshes.new("Hooped fabric")
    bm = bmesh.new()
    rings = []
    for j, (d, z) in enumerate(PROFILE):
        ring = []
        for x, y, u in offset_ring(d):
            skirt = d > 0.0
            # gathers: the corners (u's fraction ≥ 0.75) wrinkle more than the sides
            corner = 1.0 if (u % 1.0) >= 0.72 else 0.35
            w = noise.noise(Vector((u * 9.0, seed, 0.3))) if skirt else 0.0
            dz = 0.0
            if j == len(PROFILE) - 1:  # the hem, a little uneven
                dz = 0.05 * noise.noise(Vector((u * 6.0, -seed, 1.7)))
            k = 1.0 + (0.022 * corner * w) / max(0.5, math.hypot(x, y)) * 6.0 if skirt else 1.0
            ring.append(bm.verts.new((x * k, y * k, z + dz)))
        rings.append(ring)
    n = len(rings[0])
    # the field: one flat face inside the innermost ring
    bm.faces.new(rings[0])

    def blocked(x, y):
        return any(x0 <= x <= x1 and y0 <= y <= y1 for x0, x1, y0, y1 in OBSTACLES)

    for j in range(len(rings) - 1):
        skirt = PROFILE[j + 1][0] > 0.0
        for i in range(n):
            a, b = rings[j][i], rings[j][(i + 1) % n]
            c, e = rings[j + 1][(i + 1) % n], rings[j + 1][i]
            if skirt:
                cx = (a.co.x + b.co.x + c.co.x + e.co.x) / 4
                cy = (a.co.y + b.co.y + c.co.y + e.co.y) / 4
                if blocked(cx, cy):
                    continue
            bm.faces.new((a, b, c, e))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new("Hooped fabric", me)
    for p in ob.data.polygons:
        p.use_smooth = True
    so = ob.modifiers.new("Thickness", "SOLIDIFY")
    so.thickness = 0.035
    so.offset = -1
    ob.data.materials.append(mat)
    return C.link(scene, ob)
