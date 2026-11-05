"""Issues #2 and #8 — the mountain badge stitched in 3D from Filum's real
stitch plan, in a real machine embroidery hoop (see machine_hoop.py).

Data: blender/data/mountain-badge.json (the sample design's plan, exported from
the app: needle points, flags, colour block and object per stitch).
Output: public/renders/hero-badge.png (converted to WebP by `npm run renders`).
"""

import json
import math
import os
import sys

import bmesh
import bpy

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C  # noqa: E402

JUMP, TRIM, UNDERLAY = 1, 2, 64
THREAD_R = 0.02  # cm: No. 40 thread spreads to about 0.4 mm


def load(name="mountain-badge.json"):
    with open(os.path.join(C.DATA, name)) as f:
        return json.load(f)


def runs_by_block(data, cx=50.0, cy=50.0, lift=0.0035, raise_mid=0.6, needle_z=0.004):
    """Thread runs per colour block in cm (y up), split at jumps and trims.

    Needle points sit on the fabric; a point between them is raised so the
    thread looks plump. Later blocks lie slightly higher, underlay lowest."""
    blocks = {}
    prev = None
    for x, y, flag, block, _obj in data["stitches"]:
        p = ((x - cx) / 10.0, -(y - cy) / 10.0)
        if flag & (JUMP | TRIM) or prev is None or prev[1] != block:
            blocks.setdefault(block, []).append([])
            prev = None
        z = needle_z + block * lift + (-0.003 if flag & UNDERLAY else 0.0)
        run = blocks[block][-1]
        if prev is not None:
            (px, py), _ = prev
            d = math.hypot(p[0] - px, p[1] - py)
            if d > 0.06:  # longer than 0.6 mm: a raised middle
                run.append(((px + p[0]) / 2, (py + p[1]) / 2, z + THREAD_R * raise_mid))
        run.append((p[0], p[1], z))
        prev = (p, block)
    return blocks


def weave_fabric(color="#f2eee6"):
    m = C.material("Site Fabric", color, roughness=0.85, sheen=0.4)
    nt = m.node_tree
    b = nt.nodes["Principled BSDF"]
    tex = nt.nodes.new("ShaderNodeTexCoord")
    bump = nt.nodes.new("ShaderNodeBump")
    bump.inputs["Strength"].default_value = 0.25
    mix = nt.nodes.new("ShaderNodeMath")
    mix.operation = "MULTIPLY"
    waves = []
    for axis in ("X", "Y"):
        w = nt.nodes.new("ShaderNodeTexWave")
        w.wave_type = "BANDS"
        w.bands_direction = axis
        w.inputs["Scale"].default_value = 9.0
        nt.links.new(tex.outputs["Object"], w.inputs["Vector"])
        waves.append(w)
    nt.links.new(waves[0].outputs["Fac"], mix.inputs[0])
    nt.links.new(waves[1].outputs["Fac"], mix.inputs[1])
    nt.links.new(mix.outputs[0], bump.inputs["Height"])
    nt.links.new(bump.outputs["Normal"], b.inputs["Normal"])
    return m


def cotton(name="Site Cotton", tile_cm=27.0, tint=("#e6e0d5", "#fffdf8")):
    """Off-white cotton from the scanned Rough Linen weave (Poly Haven, CC0)."""
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    b = nt.nodes.new("ShaderNodeBsdfPrincipled")
    nt.links.new(b.outputs["BSDF"], out.inputs["Surface"])
    tc = nt.nodes.new("ShaderNodeTexCoord")
    mp = nt.nodes.new("ShaderNodeMapping")
    mp.inputs["Scale"].default_value = (1 / tile_cm, 1 / tile_cm, 1 / tile_cm)
    nt.links.new(tc.outputs["Object"], mp.inputs["Vector"])
    A = C.ASSETS
    diff = C.image_node(nt, os.path.join(A, "rough_linen_diffuse_4k.jpg"))
    nor = C.image_node(nt, os.path.join(A, "rough_linen_nor_gl_4k.jpg"), "Non-Color")
    rough = C.image_node(nt, os.path.join(A, "rough_linen_rough_4k.jpg"), "Non-Color")
    for t in (diff, nor, rough):
        nt.links.new(mp.outputs["Vector"], t.inputs["Vector"])
    # recolour: the weave's light and shade, in off-white
    bw = nt.nodes.new("ShaderNodeRGBToBW")
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    ramp.color_ramp.elements[0].position = 0.18
    ramp.color_ramp.elements[0].color = C.rgba(tint[0])
    ramp.color_ramp.elements[1].position = 0.62
    ramp.color_ramp.elements[1].color = C.rgba(tint[1])
    nt.links.new(diff.outputs["Color"], bw.inputs["Color"])
    nt.links.new(bw.outputs["Val"], ramp.inputs["Fac"])
    nt.links.new(ramp.outputs["Color"], b.inputs["Base Color"])
    nm = nt.nodes.new("ShaderNodeNormalMap")
    nm.inputs["Strength"].default_value = 1.2
    nt.links.new(nor.outputs["Color"], nm.inputs["Color"])
    nt.links.new(nm.outputs["Normal"], b.inputs["Normal"])
    nt.links.new(rough.outputs["Color"], b.inputs["Roughness"])
    b.inputs["Sheen Weight"].default_value = 0.5
    b.inputs["Sheen Roughness"].default_value = 0.4
    return m


def fabric_sheet(scene, mat, w=46.0, h=40.0, nx=300, ny=260, flat=6.35, seed=3):
    """The hooped fabric: taut inside the hoop, soft folds around it, lying on z = 0."""
    from mathutils import noise, Vector

    me = bpy.data.meshes.new("Fabric")
    bm = bmesh.new()
    verts = []
    for j in range(ny + 1):
        row = []
        for i in range(nx + 1):
            x = -w / 2 + w * i / nx
            y = -h / 2 + h * j / ny
            # distance outside the hoop's outer frame (rounded square, half-size `flat`)
            dx, dy = max(0.0, abs(x) - flat), max(0.0, abs(y) - flat)
            d = math.hypot(dx, dy)
            t = min(1.0, d / 3.4)
            k = t * t * (3 - 2 * t)  # smooth from the frame outwards
            p = Vector((x * 0.11 + seed, y * 0.11 - seed, 0.0))
            # soft ridges (cloth folds) and a little ripple
            ridge = (1.0 - abs(noise.noise(p))) ** 3
            folds = ridge * 1.25 + 0.35 * max(0.0, noise.noise(p * 0.5 + Vector((5, 1, 0)))) + 0.08 * noise.noise(p * 4.0)
            # a gentle lift where the fabric comes out from under the frame
            lip = 0.06 * math.exp(-((d - 0.3) ** 2) / 0.12) if d > 0 else 0.0
            # edges a little uneven, like cut cloth
            ex = 0.25 * noise.noise(Vector((y * 0.6, seed, 1.0))) if i in (0, nx) else 0.0
            ey = 0.25 * noise.noise(Vector((x * 0.6, -seed, 2.0))) if j in (0, ny) else 0.0
            row.append(bm.verts.new((x + ex, y + ey, max(0.0, folds * k) + lip)))
        verts.append(row)
    for j in range(ny):
        for i in range(nx):
            bm.faces.new((verts[j][i], verts[j][i + 1], verts[j + 1][i + 1], verts[j + 1][i]))
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new("Fabric", me)
    for p in ob.data.polygons:
        p.use_smooth = True
    so = ob.modifiers.new("Thickness", "SOLIDIFY")
    so.thickness = 0.04
    so.offset = -1
    ob.data.materials.append(mat)
    return C.link(scene, ob)


def build(scene, data):
    import machine_hoop as MH

    root = C.link(scene, bpy.data.objects.new("Hooped design", None))
    # the design, in the hoop's sewing field; every needle point dips into the cloth
    for block, runs in runs_by_block(data, needle_z=-0.008, lift=0.003).items():
        t = data["threads"][block] if block < len(data["threads"]) else data["threads"][-1]
        ob = C.polyline_curve(f"Thread {block} {t['name']}", runs, THREAD_R, resolution=3)
        ob.data.materials.append(C.thread_material(f"Thread {t['color']}", t["color"]))
        C.link(scene, ob).parent = root
    fab = fabric_sheet(scene, cotton())
    fab.parent = root
    MH.build(scene, root)
    # fabric and stabiliser showing where they are clamped between the frames
    band_f = MH.ring("Clamped fabric", 11.74, 11.74, 1.55, 0.06, 0.0, 0.86, cotton(), bevel=0.01)
    band_s = MH.ring("Clamped stabiliser", 11.82, 11.82, 1.6, 0.04, 0.0, 0.9, C.material("Site Stabiliser", "#fbfbfa", roughness=0.9, sheen=0.3), bevel=0.01)
    for b in (band_f, band_s):
        C.link(scene, b).parent = root
    root.rotation_euler.z = math.radians(6)
    return root


def main(preview=False):
    scene = C.new_scene("Site Hero")
    C.setup_render(scene, size=(1800, 1500), samples=384)
    data = load()
    build(scene, data)
    C.hdri_world(scene, strength=1.35, rotation_deg=40)
    C.area_light(scene, "Key", (-18, -8, 22), 4200, 4.5, "#fff4e6", (0, 0, 0))
    C.area_light(scene, "Rim", (10, 16, 10), 900, 6, "#eef2ff", (0, 0, 0))
    C.shadow_catcher(scene, size=200.0, z=-0.012)
    cam = C.camera(scene, (-1.2, -27.0, 22.5), (0.0, 0.2, 0.0), lens=70)
    cam.data.dof.use_dof = True
    cam.data.dof.focus_distance = (cam.location.length)
    cam.data.dof.aperture_fstop = 4.5
    if preview:
        scene.render.resolution_percentage = 50
        scene.cycles.samples = 32
    return C.render(scene, "hero-badge" + ("-preview" if preview else ""))


if __name__ == "__main__":
    main()
