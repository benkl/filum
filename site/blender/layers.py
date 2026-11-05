"""Issue #4 — "How it stitches": the badge pulled apart into floating layers.

From the real stitch plan: fabric, underlay, fills, then satin and running
details, each on its own layer, spaced apart, in an isometric view.
Output: public/renders/layers.png (transparent).
"""

import math
import os
import sys

import bpy

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C  # noqa: E402
import hero_badge as H  # noqa: E402

GAP = 3.3  # cm between layers
PLATE_R = 4.75  # cm: each floating layer rests on a frosted plate a little wider than the badge


def plate(scene, name, z, root):
    """A thin frosted-acrylic disc with a crisp light rim: the layer's "sheet", so a
    layer of thread reads as one layer and not as loose strands in the air."""
    frost = bpy.data.materials.get("Site Layer frost") or bpy.data.materials.new("Site Layer frost")
    frost.use_nodes = True
    b = frost.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = C.rgba("#ffffff")
    b.inputs["Roughness"].default_value = 0.55
    b.inputs["Alpha"].default_value = 0.2
    b.inputs["Coat Weight"].default_value = 0.4
    rim = C.lacquer("Site Layer rim", C.VIOLET)  # the hoop's violet: each plate a layer of the hooped design
    bpy.ops.mesh.primitive_cylinder_add(vertices=180, radius=PLATE_R, depth=0.05, location=(0, 0, z - 0.04))
    ob = bpy.context.active_object
    for c in ob.users_collection:
        c.objects.unlink(ob)
    scene.collection.objects.link(ob)
    ob.name = name
    ob.data.materials.append(frost)
    bv = ob.modifiers.new("Bevel", "BEVEL")
    bv.width = 0.02
    bv.segments = 3
    for f in ob.data.polygons:
        f.use_smooth = True
    ob.parent = root
    ring = bpy.data.curves.new(name + " rim", "CURVE")
    ring.dimensions = "3D"
    ring.bevel_depth = 0.028
    ring.bevel_resolution = 4
    sp = ring.splines.new("POLY")
    n = 180
    sp.points.add(n - 1)
    for i, p in enumerate(sp.points):
        a = 2 * math.pi * i / n
        p.co = (PLATE_R * math.cos(a), PLATE_R * math.sin(a), z - 0.04, 1.0)
    sp.use_cyclic_u = True
    rob = C.link(scene, bpy.data.objects.new(name + " rim", ring))
    rob.data.materials.append(rim)
    rob.parent = root
    return ob


def layer_of(data, stitch):
    _x, _y, flag, _block, obj = stitch
    if flag & H.UNDERLAY:
        return 1
    kind = data["objects"][obj]["type"] if obj < len(data["objects"]) else "fill"
    return 2 if kind == "fill" else 3


def main(preview=False):
    scene = C.new_scene("Site Layers")
    # framed 1.6x wider than the stack needs, so its soft shadow fades out inside the picture
    C.setup_render(scene, size=(2240, 2880), samples=256)
    data = H.load()
    root = C.link(scene, bpy.data.objects.new("Layers", None))
    # fabric slab
    bpy.ops.mesh.primitive_cylinder_add(vertices=160, radius=4.7, depth=0.08, location=(0, 0, -0.05))
    fab = bpy.context.active_object
    for c in fab.users_collection:
        c.objects.unlink(fab)
    scene.collection.objects.link(fab)
    fab.data.materials.append(H.cotton("Layers cotton", tile_cm=18.0, tint=("#e9e8e3", "#fdfcf9")))
    bv = fab.modifiers.new("Bevel", "BEVEL")
    bv.width = 0.03
    fab.parent = root
    for level in (1, 2, 3):
        plate(scene, f"Plate {level}", level * GAP, root)
        sub = dict(data, stitches=[s for s in data["stitches"] if layer_of(data, s) == level])
        for block, runs in H.runs_by_block(sub, lift=0.012).items():
            t = data["threads"][block]
            ob = C.polyline_curve(f"L{level} {block}", runs, H.THREAD_R, resolution=2)
            # underlay in a muted version of the thread colour reads as "the layer below"
            # a diagram: matte thread, so each layer shows its true colours from any angle
            ob.data.materials.append(C.material(f"Layers thread {t['color']}", t["color"], roughness=0.62, sheen=0.1, anisotropic=0.2))
            ob.location.z = level * GAP
            C.link(scene, ob).parent = root
    root.rotation_euler.z = math.radians(-30)
    C.shadow_catcher(scene, z=-0.2)
    C.soft_studio(scene, 11.0, target=(0, 0, 4.6))
    C.camera(scene, (16.0, -24.0, 15.5), (0, 0, 4.6), lens=50, ortho=29.6)
    if preview:
        scene.render.resolution_percentage = 40
        scene.cycles.samples = 24
    return C.render(scene, "layers" + ("-preview" if preview else ""))


if __name__ == "__main__":
    main()
