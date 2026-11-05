"""The logo mark in 3D, true to the app icon (assets/icon.svg): a violet tile with the
icon's 22 % corner radius, the f as one raised white thread and its stitch into the
fabric, both at the icon's stroke width, seen almost face-on.

Geometry: blender/data/logo.json (the logo's centrelines on its 24 px grid,
exported from the app's assets/logo/filum_logo.py).
Output: public/renders/logo-3d.png (transparent).
"""

import json
import math
import os
import sys

import bmesh
import bpy

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C  # noqa: E402


# the icon strokes are 2 px on the 24 px grid (radius 0.5 units); raised and lit they read
# a little thinner than the flat icon, so they are drawn a touch bolder
STROKE = 0.58


def to3(p, z):
    # icon px (y down, 24 grid) → units, centred
    return ((p[0] - 12.0) / 2.0, (12.0 - p[1]) / 2.0, z)


def rounded_tile(name, size, radius, depth, mat, edge=0.35):
    """The icon's tile: a rounded square (corner radius `radius`) extruded `depth`, its
    top edge softly rounded by `edge`."""
    import math as _m

    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    n = 24
    pts = []
    h = size / 2 - radius
    for cx, cy, a0 in ((h, h, 0), (-h, h, 90), (-h, -h, 180), (h, -h, 270)):
        for i in range(n + 1):
            a = _m.radians(a0 + 90 * i / n)
            pts.append((cx + radius * _m.cos(a), cy + radius * _m.sin(a)))
    bot = [bm.verts.new((x, y, -depth / 2)) for x, y in pts]
    top = [bm.verts.new((x, y, depth / 2)) for x, y in pts]
    bm.faces.new(bot[::-1])
    bm.faces.new(top)
    for i in range(len(pts)):
        j = (i + 1) % len(pts)
        bm.faces.new((bot[i], bot[j], top[j], top[i]))
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new(name, me)
    bv = ob.modifiers.new("Edge", "BEVEL")
    bv.width = edge
    bv.segments = 10
    bv.limit_method = "ANGLE"
    bv.angle_limit = _m.radians(60)
    ob.modifiers.new("Normals", "WEIGHTED_NORMAL").keep_sharp = False
    ob.data.materials.append(mat)
    for p in ob.data.polygons:
        p.use_smooth = True
    return ob


def soft_touch(name, color):
    """Soft-touch matte plastic: no coat, a fine grain that breaks up the highlights."""
    m = C.material(name, color, roughness=0.58, sheen=0.15)
    nt = m.node_tree
    b = nt.nodes["Principled BSDF"]
    noise = nt.nodes.new("ShaderNodeTexNoise")
    noise.inputs["Scale"].default_value = 140.0
    noise.inputs["Detail"].default_value = 6.0
    bump = nt.nodes.new("ShaderNodeBump")
    bump.inputs["Strength"].default_value = 0.06
    rough = nt.nodes.new("ShaderNodeMapRange")
    rough.inputs["To Min"].default_value = 0.5
    rough.inputs["To Max"].default_value = 0.66
    nt.links.new(noise.outputs["Fac"], bump.inputs["Height"])
    nt.links.new(noise.outputs["Fac"], rough.inputs["Value"])
    nt.links.new(rough.outputs["Result"], b.inputs["Roughness"])
    nt.links.new(bump.outputs["Normal"], b.inputs["Normal"])
    return m


def matte_thread(name, color):
    """Matte embroidery thread: a fibre twist across the strand, soft sheen."""
    m = C.material(name, color, roughness=0.62, sheen=0.7)
    nt = m.node_tree
    b = nt.nodes["Principled BSDF"]
    b.inputs["Sheen Roughness"].default_value = 0.35
    tc = nt.nodes.new("ShaderNodeTexCoord")
    wave = nt.nodes.new("ShaderNodeTexWave")
    wave.wave_type = "BANDS"
    wave.bands_direction = "DIAGONAL"
    wave.inputs["Scale"].default_value = 9.0
    wave.inputs["Distortion"].default_value = 1.5
    wave.inputs["Detail"].default_value = 3.0
    bump = nt.nodes.new("ShaderNodeBump")
    bump.inputs["Strength"].default_value = 0.35
    nt.links.new(tc.outputs["Object"], wave.inputs["Vector"])
    nt.links.new(wave.outputs["Fac"], bump.inputs["Height"])
    nt.links.new(bump.outputs["Normal"], b.inputs["Normal"])
    return m


def main(preview=False):
    scene = C.new_scene("Site Logo 3D")
    # framed 1.6x wider than the tile needs, so its soft shadow fades out inside the picture
    C.setup_render(scene, size=(2560, 2560), samples=512)
    data = json.load(open(os.path.join(C.DATA, "logo.json")))
    root = C.link(scene, bpy.data.objects.new("Logo", None))
    # the icon: a 64 px tile with rx 14; the glyph's 24 px grid spans 48 px of it → in
    # units (2 per grid px) the tile is 16 across, its corner radius 3.5
    depth = 1.4
    tile = rounded_tile("Tile", 16.0, 3.5, depth, C.lacquer("Site Logo violet", C.VIOLET, roughness=0.42, coat=0.35))
    C.link(scene, tile).parent = root
    # the strokes sit on the tile (2 px wide on the grid → 1 unit: radius 0.5), a touch sunk
    z = depth / 2 + 0.38
    white_thread = matte_thread("Site Thread matte", "#ffffff")
    runs = [[to3(p, z) for p in line] for line in data["thread"] + data["stitch"]]
    th = C.polyline_curve("f thread", runs, STROKE, resolution=4)
    th.data.materials.append(white_thread)
    C.link(scene, th).parent = root
    # round caps, like the icon's strokes
    for pts in runs:
        for end in (pts[0], pts[-1]):
            bpy.ops.mesh.primitive_uv_sphere_add(radius=STROKE, location=end, segments=32, ring_count=16)
            cap = bpy.context.active_object
            for c in cap.users_collection:
                c.objects.unlink(cap)
            scene.collection.objects.link(cap)
            cap.data.materials.append(white_thread)
            for f in cap.data.polygons:
                f.use_smooth = True
            cap.parent = root
    # almost face-on, like the icon, with a gentle three-quarter turn and a lift off the floor
    # (the tile stands up facing the camera, which looks down 24 degrees; it is turned
    # 10 degrees off axis and floats a hand's width above the floor)
    root.location.z = 10.0
    root.rotation_euler = (math.radians(62), math.radians(0), math.radians(-10))
    C.shadow_catcher(scene, size=400.0, z=0.0)
    C.soft_studio(scene, 16.0, target=(0, 0, 9.0))
    # framed like the other .bleed renders: the tile ~42 % of the picture
    C.camera(scene, (0, -64, 37), (0, 0, 8.0), lens=68)
    if preview:
        scene.render.resolution_percentage = 30
        scene.cycles.samples = 48
    return C.render(scene, "logo-3d" + ("-preview" if preview else ""))


if __name__ == "__main__":
    main()
