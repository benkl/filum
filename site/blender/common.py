"""Shared helpers for the product page renders (run inside Blender 5.x).

Every render script builds its own scene ("Site <name>") and leaves the
other scenes of the open file alone. Renders use Cycles on the GPU with a
transparent background and a shadow catcher, so they sit on the page.
"""

import math
import os

import bpy

SITE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RENDERS = os.path.join(SITE, "public", "renders")
DATA = os.path.join(SITE, "blender", "data")

VIOLET = "#7c3aed"
# PBR Neutral + 0.3 EV: a diffuse white lit to 1.0 lands just above the page colour
# (#f1f1ee); see blender/calibrate.py
EXPOSURE = 0.3
STEEL = "#c9ccd3"


def srgb_to_linear(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def rgba(hex_color, a=1.0):
    h = hex_color.lstrip("#")
    return tuple(srgb_to_linear(int(h[i:i + 2], 16) / 255) for i in (0, 2, 4)) + (a,)


def new_scene(name):
    """A fresh scene called `name` (an old one of that name is removed)."""
    old = bpy.data.scenes.get(name)
    if old:
        for ob in list(old.collection.all_objects):
            bpy.data.objects.remove(ob, do_unlink=True)
        bpy.data.scenes.remove(old)
    scene = bpy.data.scenes.new(name)
    if bpy.context.window:
        bpy.context.window.scene = scene
    world = bpy.data.worlds.get("Site Studio") or bpy.data.worlds.new("Site Studio")
    world.use_nodes = True
    nt = world.node_tree
    for n in list(nt.nodes):
        if n.type not in ("BACKGROUND", "OUTPUT_WORLD"):
            nt.nodes.remove(n)
    bg = nt.nodes.get("Background")
    # a soft studio: bright above, darker below, so metal gets reflections
    tc = nt.nodes.new("ShaderNodeTexCoord")
    sep = nt.nodes.new("ShaderNodeSeparateXYZ")
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    ramp.color_ramp.elements[0].position = 0.35
    ramp.color_ramp.elements[0].color = rgba("#8d8f96")
    ramp.color_ramp.elements[1].position = 0.75
    ramp.color_ramp.elements[1].color = rgba("#ffffff")
    nt.links.new(tc.outputs["Generated"], sep.inputs[0])
    nt.links.new(sep.outputs["Z"], ramp.inputs["Fac"])
    nt.links.new(ramp.outputs["Color"], bg.inputs["Color"])
    bg.inputs["Strength"].default_value = 0.8
    scene.world = world
    setup_render(scene)
    return scene


def setup_render(scene, size=(1600, 1600), samples=256):
    r = scene.render
    r.engine = "CYCLES"
    prefs = bpy.context.preferences.addons["cycles"].preferences
    prefs.compute_device_type = "OPTIX"
    prefs.get_devices()
    for d in prefs.devices:
        d.use = d.type == "OPTIX"
    scene.cycles.device = "GPU"
    scene.cycles.samples = samples
    # high-quality denoising (issue #12): OIDN with albedo + normal, accurate prefilter
    cy = scene.cycles
    cy.use_denoising = True
    try:
        cy.denoiser = "OPENIMAGEDENOISE"
    except TypeError:
        pass
    cy.denoising_input_passes = "RGB_ALBEDO_NORMAL"
    cy.denoising_prefilter = "ACCURATE"
    cy.denoising_quality = "HIGH"
    cy.denoising_use_gpu = True
    cy.use_adaptive_sampling = True
    cy.adaptive_threshold = 0.005
    scene.cycles.max_bounces = 8
    r.resolution_x, r.resolution_y = size
    r.resolution_percentage = 100
    r.film_transparent = True
    r.image_settings.file_format = "PNG"
    r.image_settings.color_mode = "RGBA"
    # colour management: Khronos PBR Neutral, the view transform made for product
    # shots. Base colours come out as their sRGB values (the brand violet stays
    # #7c3aed, white stays white on the white page) and only real highlights roll
    # off. AgX (and its Punchy look) maps diffuse white to ~70 % grey and turns the
    # violet blue — what made the first renders muddy. Contrast comes from the light.
    scene.display_settings.display_device = "sRGB"
    scene.view_settings.view_transform = "Khronos PBR Neutral"
    scene.view_settings.look = "None"
    scene.view_settings.exposure = EXPOSURE
    scene.view_settings.gamma = 1.0
    scene.sequencer_colorspace_settings.name = "sRGB"


def material(name, color, roughness=0.5, metallic=0.0, sheen=0.0, coat=0.0, anisotropic=0.0):
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes.get("Principled BSDF")
    b.inputs["Base Color"].default_value = rgba(color)
    b.inputs["Roughness"].default_value = roughness
    b.inputs["Metallic"].default_value = metallic
    if "Sheen Weight" in b.inputs:
        b.inputs["Sheen Weight"].default_value = sheen
    if "Coat Weight" in b.inputs:
        b.inputs["Coat Weight"].default_value = coat
    if "Anisotropic" in b.inputs:
        b.inputs["Anisotropic"].default_value = anisotropic
    return m


def thread_material(name, color):
    """Embroidery thread: rayon-like sheen along the stitch."""
    return material(name, color, roughness=0.38, sheen=0.6, anisotropic=0.6)


def link(scene, ob):
    scene.collection.objects.link(ob)
    return ob


def shadow_catcher(scene, size=400.0, z=0.0):
    """A floor that only catches shadows; big enough to fill every frame, so it never
    shows an edge (scripts/renders.mjs takes out its faint uniform veil)."""
    bpy.ops.mesh.primitive_plane_add(size=size, location=(0, 0, z))
    ob = bpy.context.active_object
    for c in ob.users_collection:
        c.objects.unlink(ob)
    scene.collection.objects.link(ob)
    ob.name = "Shadow catcher"
    ob.is_shadow_catcher = True
    return ob


def area_light(scene, name, loc, energy, size, color="#ffffff", target=(0, 0, 0)):
    data = bpy.data.lights.new(name, "AREA")
    data.energy = energy
    data.size = size
    data.color = rgba(color)[:3]
    ob = link(scene, bpy.data.objects.new(name, data))
    ob.location = loc
    look_at(ob, target)
    return ob


def studio_lights(scene, scale=1.0, target=(0, 0, 0), energy=1.0):
    """Key, fill and rim: soft, modern product light."""
    e = energy * scale * scale
    area_light(scene, "Key", (4 * scale, -5 * scale, 7 * scale), 900 * e, 5 * scale, "#fff6ec", target)
    area_light(scene, "Fill", (-6 * scale, -3 * scale, 3 * scale), 250 * e, 6 * scale, "#eef1ff", target)
    area_light(scene, "Rim", (-2 * scale, 6 * scale, 5 * scale), 600 * e, 3 * scale, "#ffffff", target)


def look_at(ob, target):
    from mathutils import Vector

    d = Vector(target) - ob.location
    ob.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()


def camera(scene, loc, target, lens=85.0, ortho=None):
    data = bpy.data.cameras.new("Camera")
    data.lens = lens
    if ortho:
        data.type = "ORTHO"
        data.ortho_scale = ortho
    ob = link(scene, bpy.data.objects.new("Camera", data))
    ob.location = loc
    look_at(ob, target)
    scene.camera = ob
    return ob


def render(scene, name):
    os.makedirs(RENDERS, exist_ok=True)
    path = os.path.join(RENDERS, f"{name}.png")
    scene.render.filepath = path
    with bpy.context.temp_override(scene=scene):
        bpy.ops.render.render(write_still=True, scene=scene.name)
    return path


def polyline_curve(name, runs, radius, resolution=2):
    """One curve object with a poly spline per run of (x, y, z) points, bevelled into a tube."""
    cu = bpy.data.curves.new(name, "CURVE")
    cu.dimensions = "3D"
    cu.bevel_depth = radius
    cu.bevel_resolution = resolution
    cu.use_fill_caps = True
    for pts in runs:
        if len(pts) < 2:
            continue
        sp = cu.splines.new("POLY")
        sp.points.add(len(pts) - 1)
        for p, (x, y, z) in zip(sp.points, pts):
            p.co = (x, y, z, 1.0)
    return bpy.data.objects.new(name, cu)


def deg(a):
    return math.radians(a)


ASSETS = os.path.join(SITE, "blender", "assets")


def hdri_world(scene, name="studio_small_09_2k.hdr", strength=1.0, rotation_deg=0.0, visible=False):
    """Light the scene with a studio HDRI (scripts/fetch-assets.sh); hidden from the camera."""
    world = bpy.data.worlds.get("Site HDRI") or bpy.data.worlds.new("Site HDRI")
    world.use_nodes = True
    nt = world.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputWorld")
    bg = nt.nodes.new("ShaderNodeBackground")
    env = nt.nodes.new("ShaderNodeTexEnvironment")
    env.image = bpy.data.images.load(os.path.join(ASSETS, name), check_existing=True)
    coord = nt.nodes.new("ShaderNodeTexCoord")
    mapping = nt.nodes.new("ShaderNodeMapping")
    mapping.inputs["Rotation"].default_value[2] = math.radians(rotation_deg)
    nt.links.new(coord.outputs["Generated"], mapping.inputs["Vector"])
    nt.links.new(mapping.outputs["Vector"], env.inputs["Vector"])
    nt.links.new(env.outputs["Color"], bg.inputs["Color"])
    bg.inputs["Strength"].default_value = strength
    nt.links.new(bg.outputs["Background"], out.inputs["Surface"])
    scene.world = world
    try:
        world.cycles_visibility.camera = visible
    except AttributeError:
        pass  # a transparent film hides it anyway
    return world


def image_node(nt, path, colorspace="sRGB"):
    n = nt.nodes.new("ShaderNodeTexImage")
    n.image = bpy.data.images.load(path, check_existing=True)
    n.image.colorspace_settings.name = colorspace
    return n


# ---------------------------------------------------------------- the one studio for every render
# Soft, even product light that never clips: an evenly lit studio sky (bright above, a
# light grey floor bounce below) carries most of the light, one big softbox from the
# front left gives direction and a soft shadow, a broad card from behind lifts the
# edges. Calibrated (blender/calibrate.py --studio) so that a white top face comes out
# just under the page colour and nothing in the frame reaches pure white.
STUDIO_SKY = 0.62  # the sky's share: irradiance / pi on a face looking up
STUDIO_KEY = 0.34  # the softbox's share at the target
STUDIO_RIM = 0.16


def studio_world(scene, strength=STUDIO_SKY):
    """The studio sky: soft white above, falling to a light warm grey at the horizon and
    a mid grey below (so undersides keep their shape); reflections see the same."""
    world = bpy.data.worlds.get("Site Soft Studio") or bpy.data.worlds.new("Site Soft Studio")
    world.use_nodes = True
    nt = world.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputWorld")
    bg = nt.nodes.new("ShaderNodeBackground")
    tc = nt.nodes.new("ShaderNodeTexCoord")
    sep = nt.nodes.new("ShaderNodeSeparateXYZ")
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    els = ramp.color_ramp.elements
    els[0].position, els[0].color = 0.0, rgba("#8a8985")
    els[1].position, els[1].color = 1.0, rgba("#ffffff")
    mid = els.new(0.5)
    mid.color = rgba("#e6e4df")
    ramp.color_ramp.interpolation = "EASE"
    # Generated on the world is the direction mapped to 0..1 per axis: z 0.5 is the horizon
    nt.links.new(tc.outputs["Generated"], sep.inputs[0])
    nt.links.new(sep.outputs["Z"], ramp.inputs["Fac"])
    nt.links.new(ramp.outputs["Color"], bg.inputs["Color"])
    bg.inputs["Strength"].default_value = strength
    nt.links.new(bg.outputs["Background"], out.inputs["Surface"])
    scene.world = world
    try:
        world.cycles_visibility.camera = False
    except AttributeError:
        pass
    return world


def _soft_light(scene, name, direction, dist, share, size, color, target):
    """An area light `dist` from the target along `direction`, whose irradiance at the
    target (/ pi) is `share`: E / pi = P / (pi^2 d^2) for a disc facing the target."""
    from mathutils import Vector

    d = Vector(direction).normalized() * dist
    loc = Vector(target) + d
    energy = share * math.pi ** 2 * dist ** 2
    ob = area_light(scene, name, tuple(loc), energy, size, color, target)
    ob.data.shape = "DISK"
    return ob


def soft_studio(scene, size, target=(0, 0, 0), key=STUDIO_KEY, rim=STUDIO_RIM, sky=STUDIO_SKY):
    """The site's light for an object about `size` across, centred on `target`."""
    studio_world(scene, sky)
    k = _soft_light(scene, "Studio softbox", (-0.75, -0.9, 1.25), 2.4 * size, key, 1.9 * size, "#fffaf3", target)
    r = _soft_light(scene, "Studio back card", (0.55, 1.0, 0.75), 2.6 * size, rim, 2.4 * size, "#f4f6ff", target)
    r.data.use_shadow = False
    # reflections see the soft sky only: a light's disc mirrored in gloss is a hard
    # white hotspot, the opposite of soft light
    for ob in (k, r):
        ob.visible_glossy = False
    return k, r


def lacquer(name, color, roughness=0.34, coat=0.55):
    """The site's plastic: a soft satin lacquer (hoop, logo tile, cone cores, needle eye)."""
    m = material(name, color, roughness=roughness, coat=coat)
    b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Coat Roughness"].default_value = 0.16
    return m


def satin_steel(name="Site Satin steel"):
    return material(name, "#d4d7dd", roughness=0.3, metallic=1.0, anisotropic=0.6)
