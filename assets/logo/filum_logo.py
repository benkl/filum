"""Filum logo: a lower-case "f" drawn as one thread, built as Grease Pencil in Blender.

Run inside Blender (Text Editor > Run Script, the Blender MCP, or
`blender --background --python assets/logo/filum_logo.py`).
It builds a "Filum Logo" scene, renders the PNGs and writes the SVGs
next to this file. The other scenes in the file are not touched.

The thread runs in one line: up the stem, over the hook, and back down the
stem, where it loops round into the crossbar. Below the stem it goes into
the fabric as a single stitch. The glyph follows the icon set's rules
(Lucide's grid, see ui/src/icons/stitch.ts): 24 x 24 canvas, 1 px padding,
2 px centred strokes, round caps and joins, the stem on the pixel grid.
"""

import math
import os

import bpy

HERE = os.path.dirname(os.path.abspath(bpy.context.space_data.text.filepath)) if (
    getattr(bpy.context, "space_data", None) and getattr(bpy.context.space_data, "text", None)
    and bpy.context.space_data.text.filepath) else os.path.dirname(os.path.abspath(__file__))

TILE = "#7c3aed"
INK = "#ffffff"
MONO = "#1c1917"

# --------------------------------------------------------------------------------------
# Geometry, in icon pixels (x right, y down, 24 x 24 canvas)

STEM_X = 11.0

# The thread as cubic Bezier segments (p0, c1, c2, p3): the hook, the stem,
# and the loop that crosses the stem as the crossbar.
THREAD = [
    ((19.33, 4.3), (18.18, 2.77), (16.74, 2.0), (15.11, 2.0)),
    ((15.11, 2.0), (12.63, 2.0), (11.0, 3.82), (11.0, 6.69)),
    ((11.0, 6.69), (11.0, 9.18), (11.0, 11.62), (11.0, 14.11)),
    ((11.0, 14.11), (11.0, 16.26), (9.56, 17.69), (7.65, 17.69)),
    ((7.65, 17.69), (6.12, 17.69), (5.16, 16.64), (5.16, 15.4)),
    ((5.16, 15.4), (5.16, 12.72), (9.76, 10.8), (16.22, 10.8)),
]
# the stitch into the fabric, below the stem
STITCH = ((STEM_X, 20.33), (STEM_X, 22.0))


def bezier(p0, p1, p2, p3, n=80):
    pts = []
    for i in range(n + 1):
        t = i / n
        u = 1 - t
        pts.append((u ** 3 * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t ** 3 * p3[0],
                    u ** 3 * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t ** 3 * p3[1]))
    return pts


def thin(path, spacing):
    out = [path[0]]
    for q in path[1:-1]:
        if math.dist(out[-1], q) >= spacing:
            out.append(q)
    return out + [path[-1]]


def thread_path():
    pts = []
    for i, seg in enumerate(THREAD):
        b = bezier(*seg)
        pts += b if i == 0 else b[1:]
    return pts


def glyph(spacing=0.2):
    return {"thread": [thin(thread_path(), spacing)], "stitch": [list(STITCH)]}


# --------------------------------------------------------------------------------------
# SVG output (same centrelines as the Grease Pencil strokes)

def n(v):
    return f"{v:.2f}".rstrip("0").rstrip(".")


def svg_glyph_paths():
    d = f"M{n(THREAD[0][0][0])} {n(THREAD[0][0][1])}" + "".join(
        f"C{n(c1[0])} {n(c1[1])} {n(c2[0])} {n(c2[1])} {n(p3[0])} {n(p3[1])}" for _, c1, c2, p3 in THREAD)
    (x0, y0), (x1, y1) = STITCH
    return f'<path d="{d}"/><path d="M{n(x0)} {n(y0)}L{n(x1)} {n(y1)}"/>'


def write_svgs():
    stroke_attrs = 'fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"'
    paths = svg_glyph_paths()
    # Lucide-style glyph: currentColor, drop-in next to the other icons
    with open(os.path.join(HERE, "filum-glyph.svg"), "w") as f:
        f.write(f'<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" '
                f'stroke="currentColor" {stroke_attrs}>{paths}</svg>\n')
    # App icon: the glyph on the tile, glyph canvas = 3/4 of the tile
    with open(os.path.join(HERE, "filum-icon.svg"), "w") as f:
        f.write('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">'
                f'<rect width="64" height="64" rx="14" fill="{TILE}"/>'
                f'<g transform="translate(8 8) scale(2)" stroke="{INK}" {stroke_attrs}>{paths}</g></svg>\n')


# --------------------------------------------------------------------------------------
# Blender scene

def srgb_to_linear(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def hex_rgba(h):
    h = h.lstrip("#")
    return tuple(srgb_to_linear(int(h[i:i + 2], 16) / 255) for i in (0, 2, 4)) + (1.0,)


def gp_material(name, stroke=None, fill=None):
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    if not m.is_grease_pencil:
        bpy.data.materials.create_gpencil_data(m)
    gs = m.grease_pencil
    gs.show_stroke = stroke is not None
    gs.show_fill = fill is not None
    if stroke:
        gs.color = hex_rgba(stroke)
    if fill:
        gs.fill_color = hex_rgba(fill)
    return m


def to_world(p):
    # icon px -> front view: X right, Z up, canvas centred on the origin, 1 px = 1 unit
    return (p[0] - 12.0, 0.0, 12.0 - p[1])


def add_strokes(drawing, paths, radius, cyclic=False, fill=False):
    first = len(drawing.strokes)
    drawing.add_strokes([len(p) for p in paths])
    for i, p in enumerate(paths):
        s = drawing.strokes[first + i]
        s.cyclic = cyclic
        if fill:
            s.fill_id = 1  # strokes are only filled when they belong to a fill group
        s.start_cap = 0  # round
        s.end_cap = 0
        for pt, xy in zip(s.points, p):
            pt.position = to_world(xy)
            pt.radius = radius
            pt.opacity = 1.0


def new_gp_object(collection, name):
    old = bpy.data.objects.get(name)
    if old:
        bpy.data.objects.remove(old, do_unlink=True)
    data = bpy.data.grease_pencils.get(name)
    if data:
        bpy.data.grease_pencils.remove(data)
    data = bpy.data.grease_pencils.new(name)
    ob = bpy.data.objects.new(name, data)
    collection.objects.link(ob)
    return ob


def rounded_square(size, r, seg=16):
    h = size / 2
    pts = []
    for qx, qy, a0 in ((h - r, h - r, 0), (-h + r, h - r, 90), (-h + r, -h + r, 180), (h - r, -h + r, 270)):
        for i in range(seg + 1):
            a = math.radians(a0 + 90 * i / seg)
            pts.append((12 + qx + r * math.cos(a), 12 + qy + r * math.sin(a)))
    return pts


def build_scene(g):
    scene = bpy.data.scenes.get("Filum Logo") or bpy.data.scenes.new("Filum Logo")
    coll = scene.collection

    glyph_ob = new_gp_object(coll, "Filum Glyph")
    glyph_ob.data.materials.append(gp_material("Logo Ink", stroke=INK))
    for name, paths in (("Thread", g["thread"]), ("Stitch", g["stitch"])):
        layer = glyph_ob.data.layers.new(name)
        layer.use_lights = False  # flat colour, the scene has no lights
        add_strokes(layer.frames.new(1).drawing, paths, radius=1.0)  # 2 px stroke

    # Tile: the glyph's 24 px canvas is 3/4 of it, corner radius 14/64 as before
    tile_ob = new_gp_object(coll, "Filum Tile")
    tile_ob.data.materials.append(gp_material("Logo Tile", fill=TILE))
    layer = tile_ob.data.layers.new("Tile")
    layer.use_lights = False
    add_strokes(layer.frames.new(1).drawing, [rounded_square(32, 7)], radius=0.0, cyclic=True, fill=True)
    tile_ob.location.y = 1.0  # behind the glyph
    tile_ob.rotation_euler = (0.0, 0.0, 0.0)

    cam_ob = bpy.data.objects.get("Logo Camera")
    if cam_ob is None:
        cam_ob = bpy.data.objects.new("Logo Camera", bpy.data.cameras.new("Logo Camera"))
        coll.objects.link(cam_ob)
    cam_ob.data.type = "ORTHO"
    cam_ob.data.ortho_scale = 32.0
    cam_ob.location = (0.0, -50.0, 0.0)
    cam_ob.rotation_euler = (math.radians(90), 0.0, 0.0)
    scene.camera = cam_ob

    r = scene.render
    r.engine = "BLENDER_EEVEE"
    r.resolution_x = r.resolution_y = 1024
    r.resolution_percentage = 100
    r.film_transparent = True
    r.image_settings.file_format = "PNG"
    r.image_settings.color_mode = "RGBA"
    scene.view_settings.view_transform = "Standard"
    scene.view_settings.look = "None"
    return scene, glyph_ob, tile_ob


def render(scene, path):
    scene.render.filepath = path
    with bpy.context.temp_override(scene=scene):
        bpy.ops.render.render(write_still=True, scene=scene.name)


def main(do_render=True):
    g = glyph()
    write_svgs()
    scene, glyph_ob, tile_ob = build_scene(g)
    if bpy.context.window:
        bpy.context.window.scene = scene
    if do_render:
        render(scene, os.path.join(HERE, "filum-icon-1024.png"))
        # monochrome glyph on transparent, for light backgrounds and docs
        tile_ob.hide_render = True
        scene.camera.data.ortho_scale = 24.0  # frame the 24 px canvas
        ink = glyph_ob.data.materials[0].grease_pencil
        ink.color = hex_rgba(MONO)
        render(scene, os.path.join(HERE, "filum-glyph-1024.png"))
        ink.color = hex_rgba(INK)
        scene.camera.data.ortho_scale = 32.0
        tile_ob.hide_render = False
    return scene


if __name__ == "__main__":
    main()
