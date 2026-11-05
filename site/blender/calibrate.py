"""Colour-management check: a row of matte patches (white, the page colour, grey, the
brand violet and the badge's threads) under an even white sky of strength 1, rendered
with the site's settings (common.setup_render). Each patch should come out close to
its own hex value; compare with

  blender -b --python blender/calibrate.py -- /tmp/calibrate.png
  magick /tmp/calibrate.png -format "%[hex:p{50,100}] …" info:
"""

import os
import sys

import bpy

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C  # noqa: E402

PATCHES = ["#ffffff", "#f1f1ee", "#bfbfbf", C.VIOLET, "#9fd3ea", "#f3b632", "#2f6b4f", "#1f2a56"]

args = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
out = next((a for a in args if not a.startswith("--")), "/tmp/calibrate.png")
scene = C.new_scene("Site Calibrate")
C.setup_render(scene, size=(100 * len(PATCHES), 200), samples=64)
scene.render.film_transparent = False
for i, h in enumerate(PATCHES):
    bpy.ops.mesh.primitive_plane_add(size=0.9, location=(i - (len(PATCHES) - 1) / 2, 0, 0))
    ob = bpy.context.active_object
    for c in ob.users_collection:
        c.objects.unlink(ob)
    scene.collection.objects.link(ob)
    ob.data.materials.append(C.material(f"Calibrate {h}", h, roughness=0.9))
if "--studio" in sys.argv:
    # the site's studio, as the renders use it, on the patches' top faces
    C.soft_studio(scene, 8.0)
else:
    world = bpy.data.worlds.new("Site Calibrate sky")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs["Color"].default_value = (1, 1, 1, 1)
    scene.world = world
C.camera(scene, (0, 0, 10), (0, 0, 0), ortho=len(PATCHES) + 0.4)
scene.render.filepath = out
bpy.ops.render.render(write_still=True, scene=scene.name)
print("patches:", " ".join(PATCHES))
