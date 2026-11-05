"""Issue #5 — thread spools in the brand palette.

Embroidery cones with finely grooved thread, in the badge's colours and the
Filum violet, in a gentle arc; the front one has a loose thread end.
Output: public/renders/spools.png (transparent).
"""

import math
import os
import sys

import bmesh
import bpy

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C  # noqa: E402
import hero_badge as H  # noqa: E402


def wound_material(name, color):
    """Thread wound on a cone: fine grooves around it, a soft sheen."""
    m = C.thread_material(name, color)
    nt = m.node_tree
    b = nt.nodes["Principled BSDF"]
    tc = nt.nodes.new("ShaderNodeTexCoord")
    wave = nt.nodes.new("ShaderNodeTexWave")
    wave.wave_type = "BANDS"
    wave.bands_direction = "Z"
    wave.inputs["Scale"].default_value = 60.0
    wave.inputs["Distortion"].default_value = 0.4
    bump = nt.nodes.new("ShaderNodeBump")
    bump.inputs["Strength"].default_value = 0.35
    nt.links.new(tc.outputs["Object"], wave.inputs["Vector"])
    nt.links.new(wave.outputs["Fac"], bump.inputs["Height"])
    nt.links.new(bump.outputs["Normal"], b.inputs["Normal"])
    return m


def cone(scene, name, color, loc):
    """A thread cone: a plastic core with a lip at the bottom, the wound thread on it."""
    root = C.link(scene, bpy.data.objects.new(name, None))
    root.location = loc
    plastic = C.lacquer("Site Cone core", "#fbfbf9")  # the site's white lacquer
    # wound thread: a truncated cone with rounded shoulders
    me = bpy.data.meshes.new(name + " thread")
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, segments=96, radius1=1.25, radius2=0.62, depth=3.2)
    bm.to_mesh(me)
    bm.free()
    th = C.link(scene, bpy.data.objects.new(name + " thread", me))
    th.location.z = 1.85
    bv = th.modifiers.new("Bevel", "BEVEL")
    bv.width = 0.18
    bv.segments = 5
    th.data.materials.append(wound_material(f"Wound {color}", color))
    for p in th.data.polygons:
        p.use_smooth = True
    th.parent = root
    # core: base lip and the tip sticking out at the top
    for (r1, r2, depth, z) in ((1.32, 1.32, 0.18, 0.12), (0.42, 0.3, 0.6, 3.6)):
        me = bpy.data.meshes.new(name + " core")
        bm = bmesh.new()
        bmesh.ops.create_cone(bm, cap_ends=True, segments=64, radius1=r1, radius2=r2, depth=depth)
        bm.to_mesh(me)
        bm.free()
        c = C.link(scene, bpy.data.objects.new(name + " core", me))
        c.location.z = z
        b2 = c.modifiers.new("Bevel", "BEVEL")
        b2.width = 0.05
        b2.segments = 3
        c.data.materials.append(plastic)
        for p in c.data.polygons:
            p.use_smooth = True
        c.parent = root
    return root


def loose_end(scene, color, start):
    """A thread end unwinding from the front cone across the floor."""
    x, y, z = start
    pts = [(x + 0.62, y - 0.78, z + 2.2), (x + 1.0, y - 1.15, z + 1.4), (x + 1.3, y - 1.7, 0.4), (x + 2.0, y - 2.3, 0.04), (x + 3.6, y - 2.6, 0.04), (x + 4.4, y - 3.8, 0.04), (x + 6.0, y - 4.0, 0.04)]
    cu = bpy.data.curves.new("Loose end", "CURVE")
    cu.dimensions = "3D"
    cu.bevel_depth = 0.035
    cu.bevel_resolution = 4
    sp = cu.splines.new("NURBS")
    sp.points.add(len(pts) - 1)
    for p, v in zip(sp.points, pts):
        p.co = (*v, 1)
    sp.order_u = 4
    sp.use_endpoint_u = True
    sp.resolution_u = 24
    ob = C.link(scene, bpy.data.objects.new("Loose end", cu))
    ob.data.materials.append(C.thread_material(f"Thread {color}", color))
    return ob


def main(preview=False):
    scene = C.new_scene("Site Spools")
    # framed 1.6x wider than the cones need, so their soft shadows fade out inside the picture
    C.setup_render(scene, size=(3200, 1760), samples=256)
    threads = [t["color"] for t in H.load()["threads"]]
    colors = [threads[3], threads[1], threads[0], C.VIOLET, threads[5], threads[2], threads[-1]]  # (the last: the ring's navy)
    n, mid = len(colors), len(colors) // 2
    front = None
    for i, col in enumerate(colors):
        a = math.radians(-54 + 108 * i / (n - 1))
        r = 10.5
        loc = (r * math.sin(a), r * (1 - math.cos(a)) + (-1.8 if i == mid else 0), 0)
        cone(scene, f"Cone {i}", col, loc)
        if i == mid:
            front = loc
    loose_end(scene, C.VIOLET, front)
    C.shadow_catcher(scene, z=0.0)
    C.soft_studio(scene, 22.0, target=(0, 2, 1.5))
    C.camera(scene, (0, -26, 9.5), (0, 2.2, 1.6), lens=34.4)
    if preview:
        scene.render.resolution_percentage = 40
        scene.cycles.samples = 24
    return C.render(scene, "spools" + ("-preview" if preview else ""))


if __name__ == "__main__":
    main()
