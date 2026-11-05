"""The opener: a full-screen, animated close-up of the free-standing machine hoop, the
design sewing itself out in Filum's real stitch order (blender/data/mountain-badge.json),
shot like a high-gloss product page: a glossy white acrylic floor that reflects the hoop,
lacquered plastic, long softbox highlights, and Lens Sim's Hasselblad HC 120 mm f/4.1 Macro
(Fujinon) on a 44 x 33 mm sensor wide open, so the depth of field is shallow and the focus
follows the needle. Two framings: desktop (16:9, the hoop on the right of the headline) and
mobile (3:4 portrait, the hoop centred above the headline).

  blender --background --python blender/hero_opener.py -- --still [--mobile] [--preview]
                                                   # poster: public/renders/hero-badge[-m].png
  blender --background --python blender/hero_opener.py -- --anim [--mobile] [--from N --to M]
                                                   # frames: /tmp/filum-opener[-m]/f####.png
  blender --background --python blender/hero_opener.py -- --flat [--mobile]
                                                   # the lens's vignetting: <frames>/flat####.png
  scripts/encode-opener.sh                         # opener[-m].{webm,mp4}, hero-badge[-m].webp

Wide open the lens vignettes strongly (an even floor falls from 238 to 173 in the corners).
A flat frame is the same shot with only the floor, glowing evenly in the page colour; the
encode divides every frame by its flat frame, so the film's edges meet the page exactly.
"""

import math
import os
import sys

import bpy
from mathutils import Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C  # noqa: E402
import hero_badge as H  # noqa: E402
import machine_hoop as MH  # noqa: E402

FPS = 30
SEW_FRAMES = 150  # sewing
HOLD = 45  # the finished design
FRAMES = SEW_FRAMES + HOLD
# the set is modelled in cm; it is scaled to metres so the lens behaves like a real one
WORLD_SCALE = 0.01
LENS = "120mm f4.1 Hasselblad HC Macro (Fujinon).txt"  # Lens Sim add-on
SENSOR_MM = 44.0  # Lens Sim's 44 x 33 mm medium-format preset
F_STOP = 4.1  # wide open: a shallow, creamy depth of field
PAGE = "#f1f1ee"  # the page colour: the floor melts into it at the frame's edges

# 120 mm on 44 mm: the frame's long side is 0.37 x the distance. Desktop: the hoop on the
# right half, clear of the headline; on narrow desktops the page crops to the right.
VARIANTS = {
    "desktop": dict(size=(1920, 1080), sensor=SENSOR_MM, elev=38, dist=(0.92, 0.80), aim=((-0.089, -0.004, 0.0), (-0.083, 0.0, 0.0)), frames="/tmp/filum-opener", poster="hero-badge"),
    # portrait: the lens fits its sensor to the frame's width, so a cropped 19 mm sensor
    # frames the hoop as large at about the same distance (the same lens, the same blur)
    "mobile": dict(size=(1080, 1440), sensor=19.0, elev=42, dist=(0.88, 0.80), aim=((0.009, 0.004, 0.0), (0.009, 0.002, 0.0)), frames="/tmp/filum-opener-m", poster="hero-badge-m"),
}


def cam_at(aim, dist, elev):
    e = math.radians(elev)
    return aim + Vector((0.0, -math.cos(e) * dist, math.sin(e) * dist))


def ease(t):
    return t * t * (3 - 2 * t)


def stitches_at(frame, total):
    """How many needle points are sewn at `frame` (eased, all of them by the hold)."""
    return int(round(total * ease(min(1.0, max(0.0, (frame - 1) / (SEW_FRAMES - 1))))))


def gloss_floor(scene):
    """A satin white acrylic floor: a soft clear coat over the page colour, so it mirrors
    the hoop softly. Seen from the camera it fades into the plain page colour away from the hoop
    (an emission of the page colour, which the view transform shows as the page colour), so
    the film has no edge; for light bouncing around it stays a lit floor."""
    m = bpy.data.materials.get("Opener gloss floor") or bpy.data.materials.new("Opener gloss floor")
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    b = nt.nodes.new("ShaderNodeBsdfPrincipled")
    # a shade lighter than the page: lit by the studio it comes out as the page colour
    b.inputs["Base Color"].default_value = C.rgba("#fbfbf9")
    b.inputs["Roughness"].default_value = 0.5
    b.inputs["Coat Weight"].default_value = 0.6
    b.inputs["Coat Roughness"].default_value = 0.1
    em = nt.nodes.new("ShaderNodeEmission")
    em.inputs["Color"].default_value = C.rgba(PAGE)
    em.inputs["Strength"].default_value = 1.0
    tc = nt.nodes.new("ShaderNodeTexCoord")
    ln = nt.nodes.new("ShaderNodeVectorMath")
    ln.operation = "LENGTH"
    mr = nt.nodes.new("ShaderNodeMapRange")
    mr.interpolation_type = "SMOOTHSTEP"
    mr.inputs["From Min"].default_value = 10.0  # cm from the hoop's centre
    mr.inputs["From Max"].default_value = 24.0
    lp = nt.nodes.new("ShaderNodeLightPath")
    mul = nt.nodes.new("ShaderNodeMath")
    mul.operation = "MULTIPLY"
    mix = nt.nodes.new("ShaderNodeMixShader")
    nt.links.new(tc.outputs["Object"], ln.inputs[0])
    nt.links.new(ln.outputs["Value"], mr.inputs["Value"])
    nt.links.new(mr.outputs["Result"], mul.inputs[0])
    nt.links.new(lp.outputs["Is Camera Ray"], mul.inputs[1])
    nt.links.new(mul.outputs["Value"], mix.inputs["Fac"])
    nt.links.new(b.outputs["BSDF"], mix.inputs[1])
    nt.links.new(em.outputs["Emission"], mix.inputs[2])
    nt.links.new(mix.outputs["Shader"], out.inputs["Surface"])
    bpy.ops.mesh.primitive_plane_add(size=600, location=(0, 0, 0))
    ob = bpy.context.active_object
    for c in ob.users_collection:
        c.objects.unlink(ob)
    scene.collection.objects.link(ob)
    ob.name = "Gloss floor"
    ob.data.materials.append(m)
    return ob


class Threads:
    """One curve object per colour block, rebuilt for the stitches sewn so far."""

    def __init__(self, scene, data, parent):
        self.data = data
        self.obs = {}
        for block, t in enumerate(data["threads"]):
            cu = bpy.data.curves.new(f"Opener thread {block}", "CURVE")
            cu.dimensions = "3D"
            cu.bevel_depth = H.THREAD_R
            cu.bevel_resolution = 3
            cu.use_fill_caps = True
            ob = C.link(scene, bpy.data.objects.new(f"Opener thread {block}", cu))
            ob.data.materials.append(C.thread_material(f"Thread {t['color']}", t["color"]))
            ob.parent = parent
            self.obs[block] = ob

    def show(self, n):
        sub = dict(self.data, stitches=self.data["stitches"][:n])
        runs = H.runs_by_block(sub, needle_z=-0.008, lift=0.003)
        for block, ob in self.obs.items():
            cu = ob.data
            cu.splines.clear()
            for pts in runs.get(block, []):
                if len(pts) < 2:
                    continue
                sp = cu.splines.new("POLY")
                sp.points.add(len(pts) - 1)
                sp.points.foreach_set("co", [c for x, y, z in pts for c in (x, y, z, 1.0)])
        if n == 0:
            return None
        x, y, _f, block, _o = self.data["stitches"][n - 1]
        return ((x - 50.0) / 10.0, -(y - 50.0) / 10.0), block


def needle(scene, parent):
    """A slim machine needle with the upper thread running to the fabric."""
    steel = C.material("Opener needle", "#d9dce2", roughness=0.25, metallic=1.0, anisotropic=0.6)
    root = C.link(scene, bpy.data.objects.new("Needle rig", None))
    root.parent = parent
    pts = [(0, 0, z) for z in (0.0, 0.25, 4.5)]
    shaft = C.polyline_curve("Needle", [pts], 0.035, resolution=4)
    shaft.data.materials.append(steel)
    C.link(scene, shaft).parent = root
    clamp = C.polyline_curve("Needle clamp", [[(0, 0, 3.4), (0, 0, 6.0)]], 0.09, resolution=4)
    clamp.data.materials.append(steel)
    C.link(scene, clamp).parent = root
    thread = C.polyline_curve("Upper thread", [[(0, 0, 0.05), (0.02, 0, 3.4)]], 0.012, resolution=2)
    C.link(scene, thread).parent = root
    # the low key would throw the needle's shadow far out onto the white floor, a dark
    # dash with nothing attached to it: the thin needle casts none
    for ob in root.children:
        ob.visible_shadow = False
    return root, thread


def build(scene, v):
    data = H.load()
    # the site's soft studio (common.soft_studio); the camera never sees its sky, but
    # make that the page colour anyway
    C.soft_studio(scene, 16.0, target=(0, 0, 0.6))
    nt = scene.world.node_tree
    bg = next(n for n in nt.nodes if n.type == "BACKGROUND")
    out = next(n for n in nt.nodes if n.type == "OUTPUT_WORLD")
    plain = nt.nodes.new("ShaderNodeBackground")
    plain.inputs["Color"].default_value = C.rgba(PAGE)
    lp = nt.nodes.new("ShaderNodeLightPath")
    mix = nt.nodes.new("ShaderNodeMixShader")
    nt.links.new(lp.outputs["Is Camera Ray"], mix.inputs["Fac"])
    nt.links.new(bg.outputs["Background"], mix.inputs[1])
    nt.links.new(plain.outputs["Background"], mix.inputs[2])
    nt.links.new(mix.outputs["Shader"], out.inputs["Surface"])
    root = C.link(scene, bpy.data.objects.new("Hooped design", None))
    # clean white cotton, hooped the way it really sits: through the frames, not into them
    fab = MH.hooped_fabric(scene, H.cotton("Opener cotton", tint=("#e9e8e3", "#fdfcf9")))
    fab.parent = root
    MH.build(scene, root, gloss=True)
    for b in (
        MH.ring("Clamped fabric", 11.74, 11.74, 1.55, 0.06, 0.0, 0.86, H.cotton(), bevel=0.01),
        MH.ring("Clamped stabiliser", 11.82, 11.82, 1.6, 0.04, 0.0, 0.9, C.material("Site Stabiliser", "#fbfbfa", roughness=0.9, sheen=0.3), bevel=0.01),
    ):
        C.link(scene, b).parent = root
    # the hoop's bracket points away, to the machine at the back, so nothing dark
    # reaches into the headline; the design inside is turned back upright
    root.rotation_euler.z = math.radians(-80)
    design = C.link(scene, bpy.data.objects.new("Design", None))
    design.parent = root
    design.rotation_euler.z = math.radians(90)
    threads = Threads(scene, data, design)
    rig, upper = needle(scene, design)
    gloss_floor(scene)
    (a0, a1), (d0, d1) = v["aim"], v["dist"]
    cam = C.camera(scene, tuple(cam_at(Vector(a0), d0, v["elev"])), a0, lens=70)
    cam.data.dof.use_dof = True
    to_metres(scene, cam)
    lens_camera(scene, cam, v["sensor"])
    return data, design, threads, rig, upper, cam


def to_metres(scene, cam):
    """Put everything but the camera under one empty scaled to metres; lights follow."""
    world = C.link(scene, bpy.data.objects.new("World scale", None))
    for ob in list(scene.collection.all_objects):
        if ob in (cam, world) or ob.parent is not None:
            continue
        ob.parent = world
        if ob.type == "LIGHT":
            ob.data.energy *= WORLD_SCALE ** 2
            if ob.data.type == "SPOT":
                ob.data.shadow_soft_size *= WORLD_SCALE
            if ob.data.type == "AREA":
                ob.data.size *= WORLD_SCALE
    world.scale = (WORLD_SCALE,) * 3


def lens_camera(scene, cam, sensor=SENSOR_MM):
    """Turn the camera into a Lens Sim camera with the Hasselblad HC 120 mm Macro (Fujinon)."""
    ls = sys.modules.get("bl_ext.user_default.lens_sim")
    if ls is None:
        import addon_utils

        addon_utils.enable("bl_ext.user_default.lens_sim", default_set=False)
        ls = sys.modules["bl_ext.user_default.lens_sim"]
    ctx = {"scene": scene}
    if bpy.context.window:
        bpy.context.window.scene = scene
        ctx["window"] = bpy.context.window
    # the lens shader reads the sensor from the camera itself (cam:sensor_size)
    cam.data.sensor_fit = "HORIZONTAL"
    cam.data.sensor_width = sensor
    cam.data.sensor_height = sensor * 0.75
    with bpy.context.temp_override(**ctx):
        bpy.ops.object.convert_camera_from_list(camera_name=cam.name)
        scene.my_addon_props.lenses_enum = LENS
        ls.LensSim_Camera = cam
        ls.set_prop("sensor width", sensor)
        ls.set_prop("f stop", F_STOP)
        ls.set_prop("focus mode", 1)  # focus distance
        ls.sync_cam_parms(force_compile_osl_shader=True)


def needle_at(data, frame):
    """The needle's point in design coordinates (cm) at `frame` (the last stitch sewn)."""
    n = stitches_at(frame, len(data["stitches"]))
    if n == 0:
        return Vector((0.0, 0.0, 0.0))
    x, y = data["stitches"][n - 1][:2]
    return Vector(((x - 50.0) / 10.0, -(y - 50.0) / 10.0, 0.0))


def focus_point(data, frame):
    """Where the lens focuses: on the needle, smoothed over a second either side so the
    focus glides; once the design is done it settles on the design's centre."""
    window = [needle_at(data, f) for f in range(max(1, frame - 15), min(SEW_FRAMES, frame + 15) + 1)]
    p = sum(window, Vector()) / max(1, len(window)) if frame <= SEW_FRAMES + 15 else Vector()
    k = ease(min(1.0, max(0.0, (frame - SEW_FRAMES) / HOLD)))
    return p.lerp(Vector(), k)


def place(frame, v, data, design, threads, rig, upper, cam):
    n = stitches_at(frame, len(data["stitches"]))
    hit = threads.show(n)
    # the camera pushes in slowly
    t = ease(min(1.0, (frame - 1) / (FRAMES - 1)))
    (a0, a1), (d0, d1) = v["aim"], v["dist"]
    aim = Vector(a0).lerp(Vector(a1), t)
    cam.location = cam_at(aim, d0 + (d1 - d0) * t, v["elev"])
    C.look_at(cam, tuple(aim))
    bpy.context.view_layer.update()
    target = design.matrix_world @ focus_point(data, frame)
    cam.data.dof.focus_distance = (target - cam.location).dot(cam.matrix_world.to_quaternion() @ Vector((0, 0, -1)))
    sewing = hit is not None and frame <= SEW_FRAMES
    for ob in [rig, *rig.children]:
        ob.hide_render = not sewing
    if sewing:
        (x, y), block = hit
        bob = abs(math.sin(frame * math.pi / 3.0))  # up and down with every frame
        rig.location = (x, y, 0.05 + 0.9 * bob)
        mat = threads.obs[block].data.materials[0]
        if upper.data.materials:
            upper.data.materials[0] = mat
        else:
            upper.data.materials.append(mat)


def main(mode="still", first=1, last=FRAMES, preview=False, variant="desktop"):
    v = VARIANTS[variant]
    scene = C.new_scene("Site Opener")
    C.setup_render(scene, size=v["size"], samples=(96 if preview else 768) if mode == "still" else 256)
    scene.render.film_transparent = False
    scene.render.fps = FPS
    parts = build(scene, v)
    if mode == "still":
        place(FRAMES, v, *parts)
        if preview:
            scene.render.resolution_percentage = int(os.environ.get("PREVIEW_PCT", "50"))
        return C.render(scene, v["poster"] + ("-preview" if preview else ""))
    os.makedirs(v["frames"], exist_ok=True)
    if mode == "flat":
        # one flat frame per film frame: the vignetting changes as the lens refocuses
        # (it follows the needle) and the camera pushes in
        nt = bpy.data.materials["Opener gloss floor"].node_tree
        mix = next(n for n in nt.nodes if n.type == "MIX_SHADER")
        for ln in list(mix.inputs["Fac"].links):
            nt.links.remove(ln)
        mix.inputs["Fac"].default_value = 1.0
        scene.cycles.samples = 48
        for f in range(first, last + 1):
            out = os.path.join(v["frames"], f"flat{f:04d}.png")
            if os.path.exists(out):
                continue
            place(f, v, *parts)
            for ob in scene.objects:
                if ob.type in ("MESH", "CURVE") and ob.name != "Gloss floor":
                    ob.hide_render = True
            scene.frame_set(f)
            scene.render.filepath = out
            bpy.ops.render.render(write_still=True, scene=scene.name)
        return v["frames"]
    for f in range(first, last + 1):
        out = os.path.join(v["frames"], f"f{f:04d}.png")
        if os.path.exists(out):
            continue
        place(f, v, *parts)
        scene.frame_set(f)
        scene.render.filepath = out
        bpy.ops.render.render(write_still=True, scene=scene.name)
        print(f"frame {f}/{last}", flush=True)
    return v["frames"]


if __name__ == "__main__":
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    variant = "mobile" if "--mobile" in argv else "desktop"
    if "--flat" in argv:
        a = lambda k, d: int(argv[argv.index(k) + 1]) if k in argv else d  # noqa: E731
        main("flat", a("--from", 1), a("--to", FRAMES), variant=variant)
    elif "--anim" in argv:
        a = lambda k, d: int(argv[argv.index(k) + 1]) if k in argv else d  # noqa: E731
        main("anim", a("--from", 1), a("--to", FRAMES), variant=variant)
    else:
        main("still", preview="--preview" in argv, variant=variant)
