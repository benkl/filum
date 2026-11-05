"""The stitch-out player's icons, drawn as Grease Pencil in Blender.

Run inside Blender (Text Editor > Run Script, the Blender MCP, or
`blender --background --python assets/icons/stitchout_icons.py`). It builds a
"Filum Icons" scene with one Grease Pencil object per icon, renders a review
sheet next to this file (stitchout-icons.png) and writes each icon's SVG to
ui/src/icons/svg. The same shapes go into ui/src/icons/stitch.ts (printed at
the end, ready to paste). Other scenes in the file are not touched.

The rules are the icon set's (Lucide's grid, see ui/src/icons/stitch.ts):
24 x 24 canvas, 1 px padding (stroke centres within 2..22), 2 px centred
strokes with round caps and joins, 2 px corner radii, at least 2 px between
parts. Embroidery reads through the set's own motifs: a needle above a stitch,
a satin column for a colour block, running stitch for a stitch-out.
"""

import math
import os

try:
    import bpy
except ImportError:  # SVGs only, outside Blender
    bpy = None

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
SVG_DIR = os.path.join(ROOT, "ui", "src", "icons", "svg")

INK = "#303231"
PAPER = "#fbfbf9"
ACCENT = "#7c3aed"


# --------------------------------------------------------------------------------------
# Geometry in icon pixels (x right, y down). Each part is an SVG path and the
# points of its centreline (for the Grease Pencil stroke).

def n(v):
    return f"{v:.2f}".rstrip("0").rstrip(".")


class Part:
    def __init__(self, d, pts, closed=False):
        self.d, self.pts, self.closed = d, pts, closed


def line(*pts, closed=False):
    d = "M" + " ".join(f"{n(x)} {n(y)}" for x, y in pts[:1]) + "".join(f"L{n(x)} {n(y)}" for x, y in pts[1:]) + ("Z" if closed else "")
    return Part(d, list(pts), closed)


def rounded(pts, r, closed=False):
    """A polyline with its corners rounded to radius r (Lucide's 2 px)."""
    m = len(pts)
    corners = []  # (a, b, centre, sweep) per rounded vertex
    idx = range(m) if closed else range(1, m - 1)
    for i in idx:
        p, v, q = pts[i - 1], pts[i], pts[(i + 1) % m]
        u1 = (p[0] - v[0], p[1] - v[1])
        u2 = (q[0] - v[0], q[1] - v[1])
        l1, l2 = math.hypot(*u1), math.hypot(*u2)
        u1 = (u1[0] / l1, u1[1] / l1)
        u2 = (u2[0] / l2, u2[1] / l2)
        theta = math.acos(max(-1.0, min(1.0, u1[0] * u2[0] + u1[1] * u2[1])))
        t = r / math.tan(theta / 2)
        a = (v[0] + u1[0] * t, v[1] + u1[1] * t)
        b = (v[0] + u2[0] * t, v[1] + u2[1] * t)
        bis = (u1[0] + u2[0], u1[1] + u2[1])
        bl = math.hypot(*bis)
        c = (v[0] + bis[0] / bl * r / math.sin(theta / 2), v[1] + bis[1] / bl * r / math.sin(theta / 2))
        # incoming direction -u1, outgoing u2: clockwise on screen (y down) when the cross is positive
        sweep = 1 if (-u1[0]) * u2[1] - (-u1[1]) * u2[0] > 0 else 0
        corners.append((i, a, b, c))
    d = ""
    out = []

    def arc_pts(a, b, c):
        a0 = math.atan2(a[1] - c[1], a[0] - c[0])
        a1 = math.atan2(b[1] - c[1], b[0] - c[0])
        da = (a1 - a0 + math.pi) % (2 * math.pi) - math.pi
        return [(c[0] + r * math.cos(a0 + da * k / 8), c[1] + r * math.sin(a0 + da * k / 8)) for k in range(9)]

    if closed:
        _, a, b, c = corners[-1]
        d = f"M{n(b[0])} {n(b[1])}"
        out.append(b)
        for i, a, b, c in corners:
            sw = 1 if ((a[0] - c[0]) * (b[1] - c[1]) - (a[1] - c[1]) * (b[0] - c[0])) > 0 else 0
            d += f"L{n(a[0])} {n(a[1])}A{n(r)} {n(r)} 0 0 {sw} {n(b[0])} {n(b[1])}"
            out += arc_pts(a, b, c)
        d += "Z"
    else:
        d = f"M{n(pts[0][0])} {n(pts[0][1])}"
        out.append(pts[0])
        for i, a, b, c in corners:
            sw = 1 if ((a[0] - c[0]) * (b[1] - c[1]) - (a[1] - c[1]) * (b[0] - c[0])) > 0 else 0
            d += f"L{n(a[0])} {n(a[1])}A{n(r)} {n(r)} 0 0 {sw} {n(b[0])} {n(b[1])}"
            out += arc_pts(a, b, c)
        d += f"L{n(pts[-1][0])} {n(pts[-1][1])}"
        out.append(pts[-1])
    return Part(d, out, closed)


def viewfinder():
    """The four corners of a viewfinder (2 px radius, 4 px legs)."""
    return [
        rounded([(3, 7), (3, 3), (7, 3)], 2),
        rounded([(17, 3), (21, 3), (21, 7)], 2),
        rounded([(21, 17), (21, 21), (17, 21)], 2),
        rounded([(7, 21), (3, 21), (3, 17)], 2),
    ]


def satin_column(x0, x1, y0, y1, steps=5):
    """A satin column: stitches zig-zagging between two rails."""
    pts = [((x0, x1)[k % 2], y0 + (y1 - y0) * k / steps) for k in range(steps + 1)]
    return line(*pts)


def octagon(r=2):
    k = 5.86  # the corner cut, as Lucide's octagon
    v = [(2 + k, 2), (22 - k, 2), (22, 2 + k), (22, 22 - k), (22 - k, 22), (2 + k, 22), (2, 22 - k), (2, 2 + k)]
    return rounded(v, r, closed=True)


ICONS = {
    # The stitch-out: play, over the running stitch it sews.
    "stitch-out": [
        rounded([(9, 3), (19, 9), (9, 15)], 1.5, closed=True),
        line((3, 20), (6, 20)),
        line((10.5, 20), (13.5, 20)),
        line((18, 20), (21, 20)),
    ],
    # Follow the needle: running stitch up to the needle's point, kept in a viewfinder.
    "follow-needle": viewfinder() + [
        line((7, 17), (8.5, 15.5)),
        line((11.5, 12.5), (13, 11)),
        line((16, 8), (16.01, 8)),
    ],
    # Previous / next colour block: skip to a satin column.
    "block-previous": [
        rounded([(20, 5), (12, 12), (20, 19)], 1.5, closed=True),
        satin_column(8, 4, 4, 20, 6),
    ],
    "block-next": [
        rounded([(4, 5), (12, 12), (4, 19)], 1.5, closed=True),
        satin_column(16, 20, 4, 20, 6),
    ],
    # The machine stops: pause bars sewn in running stitch, on the stop sign.
    "machine-stop": [
        octagon(),
        line((9.5, 7), (9.5, 10)),
        line((9.5, 14), (9.5, 17)),
        line((14.5, 7), (14.5, 10)),
        line((14.5, 14), (14.5, 17)),
    ],
}


def check():
    """The grid rules: stroke centres inside 2..22 (1 px padding with a 2 px stroke)."""
    bad = []
    for name, parts in ICONS.items():
        for p in parts:
            for x, y in p.pts:
                if not (1.99 <= x <= 22.01 and 1.99 <= y <= 22.01):
                    bad.append((name, round(x, 2), round(y, 2)))
    return bad


def write_svgs():
    os.makedirs(SVG_DIR, exist_ok=True)
    for name, parts in ICONS.items():
        body = "".join(f'\n  <path d="{p.d}" />' for p in parts)
        with open(os.path.join(SVG_DIR, f"{name}.svg"), "w", newline="\n") as f:
            f.write(
                '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" '
                f'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">{body}\n</svg>\n'
            )


def ts_lines():
    """The icons as ui/src/icons/stitch.ts entries."""
    out = []
    for name, parts in ICONS.items():
        ident = "".join(w.capitalize() for w in name.split("-"))
        nodes = ",".join(f'["path",{{"d":"{p.d}"}}]' for p in parts)
        out.append(f'export const {ident} = icon("{name}", [{nodes}]);')
    return "\n\n".join(out)


# --------------------------------------------------------------------------------------
# Blender: one Grease Pencil object per icon, in a row on a paper card each

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


def new_gp_object(coll, name):
    old = bpy.data.objects.get(name)
    if old:
        bpy.data.objects.remove(old, do_unlink=True)
    data = bpy.data.grease_pencils.get(name)
    if data:
        bpy.data.grease_pencils.remove(data)
    data = bpy.data.grease_pencils.new(name)
    ob = bpy.data.objects.new(name, data)
    coll.objects.link(ob)
    return ob


def add_strokes(drawing, parts, ox, radius, fill=False):
    first = len(drawing.strokes)
    drawing.add_strokes([len(p.pts) for p in parts])
    for i, p in enumerate(parts):
        s = drawing.strokes[first + i]
        s.cyclic = p.closed
        if fill:
            s.fill_id = 1
        s.start_cap = 0  # round
        s.end_cap = 0
        for pt, (x, y) in zip(s.points, p.pts):
            pt.position = (ox + x - 12.0, 0.0, 12.0 - y)
            pt.radius = radius
            pt.opacity = 1.0


GAP = 32  # px between icon centres on the sheet


def build_scene():
    scene = bpy.data.scenes.get("Filum Icons") or bpy.data.scenes.new("Filum Icons")
    coll = scene.collection
    names = list(ICONS)
    for k, name in enumerate(names):
        ox = (k - (len(names) - 1) / 2) * GAP
        card = new_gp_object(coll, f"Card {name}")
        card.data.materials.append(gp_material("Icon Paper", fill=PAPER))
        layer = card.data.layers.new("Card")
        layer.use_lights = False
        square = [(-1, -1), (25, -1), (25, 25), (-1, 25)]
        add_strokes(layer.frames.new(1).drawing, [rounded(square, 4, closed=True)], ox, 0.0, fill=True)
        card.location.y = 1.0
        ob = new_gp_object(coll, f"Icon {name}")
        ob.data.materials.append(gp_material("Icon Ink", stroke=INK))
        layer = ob.data.layers.new(name)
        layer.use_lights = False
        add_strokes(layer.frames.new(1).drawing, ICONS[name], ox, 1.0)  # radius 1 = the 2 px stroke
    cam = bpy.data.objects.get("Icons Camera")
    if cam is None:
        cam = bpy.data.objects.new("Icons Camera", bpy.data.cameras.new("Icons Camera"))
        coll.objects.link(cam)
    cam.data.type = "ORTHO"
    cam.data.ortho_scale = GAP * len(names) + 4
    cam.location = (0.0, -50.0, 0.0)
    cam.rotation_euler = (math.radians(90), 0.0, 0.0)
    scene.camera = cam
    r = scene.render
    try:
        r.engine = "BLENDER_EEVEE"
    except TypeError:
        r.engine = "BLENDER_EEVEE_NEXT"
    r.resolution_x = 64 * len(names) * 4
    r.resolution_y = int(r.resolution_x * 36 / (GAP * len(names) + 4))
    r.resolution_percentage = 100
    r.film_transparent = True
    r.image_settings.file_format = "PNG"
    r.image_settings.color_mode = "RGBA"
    scene.view_settings.view_transform = "Standard"
    scene.view_settings.look = "None"
    return scene


def render(scene, path):
    scene.render.filepath = path
    with bpy.context.temp_override(scene=scene):
        bpy.ops.render.render(write_still=True, scene=scene.name)


def main(do_render=True):
    bad = check()
    if bad:
        raise ValueError(f"outside the 2..22 px area: {bad[:6]}")
    write_svgs()
    if bpy is None:
        return None
    scene = build_scene()
    if do_render:
        render(scene, os.path.join(HERE, "stitchout-icons.png"))
    return scene


if __name__ == "__main__":
    main()
    print(ts_lines())
