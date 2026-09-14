"""Deterministic cloud pilot for Lumi.

Run with:
  blender --background --factory-startup --python blender/lumi_pilot.py -- \
    --output /tmp/lumi.mp4 --width 540 --height 960 --fps 24 --seconds 12

The model is built from reusable Blender primitives, so the character remains
identical between renders. This is the production baseline for a later polished
rig, not a generative-video call.
"""

import argparse
import math
import os
import sys

import bpy
from mathutils import Vector


def arguments():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True)
    parser.add_argument("--width", type=int, default=540)
    parser.add_argument("--height", type=int, default=960)
    parser.add_argument("--fps", type=int, default=24)
    parser.add_argument("--seconds", type=int, default=12)
    args = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    return parser.parse_args(args)


def material(name, rgba, metallic=0.0, roughness=0.45, emission=None):
    mat = bpy.data.materials.new(name)
    mat.diffuse_color = rgba
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = rgba
    bsdf.inputs["Metallic"].default_value = metallic
    bsdf.inputs["Roughness"].default_value = roughness
    if "Alpha" in bsdf.inputs:
        bsdf.inputs["Alpha"].default_value = rgba[3]
    if emission:
        emission_input = bsdf.inputs.get("Emission Color") or bsdf.inputs.get("Emission")
        if emission_input:
            emission_input.default_value = emission
        strength = bsdf.inputs.get("Emission Strength")
        if strength:
            strength.default_value = 2.5
    if rgba[3] < 1:
        if hasattr(mat, "surface_render_method"):
            mat.surface_render_method = "DITHERED"
        elif hasattr(mat, "blend_method"):
            mat.blend_method = "BLEND"
        if hasattr(mat, "use_screen_refraction"):
            mat.use_screen_refraction = True
    return mat


def smooth(obj):
    if obj.type == "MESH":
        for polygon in obj.data.polygons:
            polygon.use_smooth = True
    return obj


def parent(obj, root):
    obj.parent = root
    return obj


def uv_sphere(name, location, scale, mat, root, segments=48, rings=24):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=segments, ring_count=rings, location=location)
    obj = bpy.context.object
    obj.name = name
    obj.scale = scale
    obj.data.materials.append(mat)
    return parent(smooth(obj), root)


def cube(name, location, scale, mat, root, bevel=0.22):
    bpy.ops.mesh.primitive_cube_add(location=location)
    obj = bpy.context.object
    obj.name = name
    obj.scale = scale
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    modifier = obj.modifiers.new("Soft corners", "BEVEL")
    modifier.width = bevel
    modifier.segments = 4
    obj.data.materials.append(mat)
    return parent(smooth(obj), root)


def cylinder_between(name, start, end, radius, mat, root):
    start_v, end_v = Vector(start), Vector(end)
    delta = end_v - start_v
    midpoint = (start_v + end_v) / 2
    bpy.ops.mesh.primitive_cylinder_add(vertices=32, radius=radius, depth=delta.length, location=midpoint)
    obj = bpy.context.object
    obj.name = name
    obj.rotation_mode = "QUATERNION"
    obj.rotation_quaternion = Vector((0, 0, 1)).rotation_difference(delta.normalized())
    obj.data.materials.append(mat)
    return parent(smooth(obj), root)


def curve(name, points, bevel, mat, root):
    data = bpy.data.curves.new(name, "CURVE")
    data.dimensions = "3D"
    data.bevel_depth = bevel
    data.bevel_resolution = 4
    spline = data.splines.new("BEZIER")
    spline.bezier_points.add(len(points) - 1)
    for point, coordinate in zip(spline.bezier_points, points):
        point.co = coordinate
        point.handle_left_type = "AUTO"
        point.handle_right_type = "AUTO"
    obj = bpy.data.objects.new(name, data)
    bpy.context.collection.objects.link(obj)
    data.materials.append(mat)
    return parent(obj, root)


def star(name, location, radius_outer, radius_inner, depth, mat, root):
    vertices = []
    for z in (-depth / 2, depth / 2):
        for index in range(10):
            angle = math.pi / 2 + index * math.pi / 5
            radius = radius_outer if index % 2 == 0 else radius_inner
            vertices.append((radius * math.cos(angle), radius * math.sin(angle), z))
    faces = []
    faces.append(tuple(range(9, -1, -1)))
    faces.append(tuple(range(10, 20)))
    for index in range(10):
        nxt = (index + 1) % 10
        faces.append((index, nxt, 10 + nxt, 10 + index))
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    obj.location = location
    obj.rotation_euler = (math.radians(90), 0, 0)
    obj.data.materials.append(mat)
    bevel = obj.modifiers.new("Rounded star", "BEVEL")
    bevel.width = 0.06
    bevel.segments = 3
    return parent(smooth(obj), root)


def text_object(body, location, size, mat):
    bpy.ops.object.text_add(location=location, rotation=(math.radians(90), 0, 0))
    obj = bpy.context.object
    obj.data.body = body
    obj.data.align_x = "CENTER"
    obj.data.align_y = "CENTER"
    obj.data.size = size
    obj.data.extrude = 0.025
    obj.data.bevel_depth = 0.012
    obj.data.materials.append(mat)
    return obj


def look_at(obj, target):
    direction = Vector(target) - obj.location
    obj.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()


def keyframe(obj, frame, *, location=None, rotation=None, scale=None):
    if location is not None:
        obj.location = location
        obj.keyframe_insert("location", frame=frame)
    if rotation is not None:
        obj.rotation_euler = rotation
        obj.keyframe_insert("rotation_euler", frame=frame)
    if scale is not None:
        obj.scale = scale
        obj.keyframe_insert("scale", frame=frame)


def build_scene(args):
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)

    scene = bpy.context.scene
    draft = args.width <= 300
    if draft:
        scene.render.engine = "BLENDER_WORKBENCH"
        scene.display.shading.light = "STUDIO"
        scene.display.shading.color_type = "MATERIAL"
        scene.display.shading.show_shadows = True
        scene.display.shading.show_cavity = True
    else:
        scene.render.engine = "BLENDER_EEVEE_NEXT" if bpy.app.version >= (4, 0, 0) else "BLENDER_EEVEE"
    scene.render.resolution_x = args.width
    scene.render.resolution_y = args.height
    scene.render.resolution_percentage = 100
    scene.render.fps = args.fps
    scene.frame_start = 1
    scene.frame_end = args.fps * args.seconds
    scene.render.image_settings.file_format = "FFMPEG"
    scene.render.ffmpeg.format = "MPEG4"
    scene.render.ffmpeg.codec = "H264"
    scene.render.ffmpeg.constant_rate_factor = "MEDIUM"
    scene.render.ffmpeg.audio_codec = "AAC"
    scene.render.filepath = os.path.abspath(args.output)
    scene.render.film_transparent = False
    scene.world.color = (0.035, 0.055, 0.11)
    try:
        scene.view_settings.look = "Medium High Contrast" if bpy.app.version < (4, 0, 0) else "AgX - Medium High Contrast"
    except TypeError:
        pass

    yellow = material("Lumi warm yellow", (1.0, 0.57, 0.055, 1), roughness=0.38)
    blue = material("Lumi overalls", (0.18, 0.52, 0.92, 1), roughness=0.48)
    purple = material("Lumi violet", (0.53, 0.24, 0.91, 1), roughness=0.38)
    cyan = material("Lumi turquoise eyes", (0.02, 0.70, 0.88, 1), roughness=0.3)
    white = material("Soft white", (0.96, 0.98, 1.0, 1), roughness=0.45)
    dark = material("Warm dark", (0.045, 0.025, 0.06, 1), roughness=0.4)
    pink = material("Cheeks", (1.0, 0.22, 0.37, 0.82), roughness=0.5)
    wing = material("Translucent wings", (0.55, 0.90, 1.0, 0.42), metallic=0.05, roughness=0.2)
    glow = material("Magic glow", (1.0, 0.62, 0.02, 1), roughness=0.25, emission=(1.0, 0.26, 0.01, 1))
    red = material("Red answer", (0.95, 0.07, 0.12, 1), roughness=0.38)
    aqua = material("Backdrop aqua", (0.08, 0.44, 0.53, 1), roughness=0.6)

    bpy.ops.object.empty_add(type="PLAIN_AXES", location=(0, 0, 0))
    lumi = bpy.context.object
    lumi.name = "Lumi_Root"

    # Silhouette and costume.
    uv_sphere("Body", (0, 0, 3.55), (1.35, 0.75, 1.55), yellow, lumi)
    uv_sphere("Head", (0, -0.05, 5.75), (1.85, 1.0, 1.65), yellow, lumi)
    uv_sphere("Overalls", (0, -0.62, 3.55), (1.08, 0.20, 1.02), blue, lumi)
    cube("Bib", (0, -0.88, 4.05), (0.72, 0.12, 0.68), blue, lumi, bevel=0.17)
    cylinder_between("Left strap", (-0.7, -0.89, 4.75), (-0.45, -0.90, 4.25), 0.12, blue, lumi)
    cylinder_between("Right strap", (0.7, -0.89, 4.75), (0.45, -0.90, 4.25), 0.12, blue, lumi)
    uv_sphere("Pocket", (0, -1.0, 3.85), (0.42, 0.08, 0.30), blue, lumi)

    # Face.
    for x in (-0.68, 0.68):
        eye = uv_sphere("Eye white", (x, -0.92, 6.03), (0.53, 0.16, 0.66), white, lumi)
        iris = uv_sphere("Turquoise iris", (x, -1.085, 6.00), (0.27, 0.09, 0.36), cyan, lumi)
        uv_sphere("Pupil", (x, -1.17, 6.0), (0.12, 0.05, 0.18), dark, lumi)
        uv_sphere("Eye glint", (x - 0.07, -1.225, 6.15), (0.055, 0.025, 0.075), white, lumi)
        blink_frame = int(args.fps * 2.7)
        for target in (eye, iris):
            base = target.scale.copy()
            keyframe(target, blink_frame - 2, scale=base)
            keyframe(target, blink_frame, scale=(base.x, base.y, base.z * 0.08))
            keyframe(target, blink_frame + 2, scale=base)
    uv_sphere("Left cheek", (-1.18, -1.00, 5.45), (0.34, 0.06, 0.20), pink, lumi)
    uv_sphere("Right cheek", (1.18, -1.00, 5.45), (0.34, 0.06, 0.20), pink, lumi)
    curve("Smile", [(-0.56, -1.12, 5.38), (0, -1.25, 5.10), (0.56, -1.12, 5.38)], 0.075, dark, lumi)

    # Antennae, wings and feet.
    curve("Left antenna", [(-0.68, 0, 7.10), (-1.05, 0, 7.78), (-1.25, 0, 8.18)], 0.075, yellow, lumi)
    curve("Right antenna", [(0.68, 0, 7.10), (1.05, 0, 7.78), (1.25, 0, 8.18)], 0.075, yellow, lumi)
    uv_sphere("Left antenna tip", (-1.25, 0, 8.18), (0.23, 0.23, 0.23), purple, lumi)
    uv_sphere("Right antenna tip", (1.25, 0, 8.18), (0.23, 0.23, 0.23), purple, lumi)
    left_wing = uv_sphere("Left wing", (-1.45, 0.35, 4.45), (0.72, 0.13, 1.18), wing, lumi)
    left_wing.rotation_euler.y = math.radians(-28)
    right_wing = uv_sphere("Right wing", (1.45, 0.35, 4.45), (0.72, 0.13, 1.18), wing, lumi)
    right_wing.rotation_euler.y = math.radians(28)
    for wing_obj, direction in ((left_wing, -1), (right_wing, 1)):
        for frame, angle in ((1, 20), (args.fps, 35), (args.fps * 2, 20), (args.fps * 3, 35), (scene.frame_end, 20)):
            wing_obj.rotation_euler.z = math.radians(angle * direction)
            wing_obj.keyframe_insert("rotation_euler", frame=frame)
    for x in (-0.65, 0.65):
        cylinder_between("Leg", (x, 0, 2.55), (x, 0, 1.85), 0.28, yellow, lumi)
        uv_sphere("Shoe", (x, -0.25, 1.55), (0.58, 0.78, 0.34), white, lumi)
        cube("Blue shoe patch", (x, -0.92, 1.58), (0.27, 0.07, 0.16), blue, lumi, bevel=0.08)

    # Friendly open gesture and star wand.
    cylinder_between("Left arm", (-1.05, 0, 4.45), (-2.05, -0.08, 3.92), 0.23, yellow, lumi)
    uv_sphere("Left hand", (-2.18, -0.10, 3.82), (0.42, 0.28, 0.34), yellow, lumi)
    cylinder_between("Right arm", (1.05, 0, 4.5), (1.90, -0.10, 5.10), 0.23, yellow, lumi)
    uv_sphere("Right hand", (2.02, -0.10, 5.22), (0.37, 0.28, 0.34), yellow, lumi)
    wand = cylinder_between("Wand", (2.0, -0.12, 5.15), (2.45, -0.12, 6.65), 0.075, purple, lumi)
    wand_star = star("Wand star", (2.54, -0.12, 6.92), 0.50, 0.23, 0.16, glow, lumi)

    # Lesson props: one distractor and the correct yellow answer.
    red_prop = uv_sphere("Red circle", (-1.35, 0.3, 1.2), (0.62, 0.24, 0.62), red, root=lumi)
    yellow_prop = star("Yellow answer", (1.25, -0.02, 1.2), 0.72, 0.33, 0.18, glow, lumi)
    for prop in (red_prop, yellow_prop):
        final_scale = prop.scale.copy()
        keyframe(prop, args.fps * 3, scale=(0.001, 0.001, 0.001))
        keyframe(prop, args.fps * 4, scale=final_scale)
    # Emphasize the correct answer after the pause.
    keyframe(yellow_prop, args.fps * 7, scale=(1, 1, 1))
    keyframe(yellow_prop, int(args.fps * 7.35), scale=(1.28, 1.28, 1.28))
    keyframe(yellow_prop, int(args.fps * 7.7), scale=(1, 1, 1))

    question = text_object("¿Cuál es amarillo?", (0, -0.25, 0.62), 0.48, white)
    keyframe(question, args.fps * 3, scale=(0.001, 0.001, 0.001))
    keyframe(question, args.fps * 4, scale=(1, 1, 1))

    # Lumi floats gently; the wand celebrates at the answer reveal.
    for frame, z in ((1, 0), (args.fps * 2, 0.13), (args.fps * 4, 0), (args.fps * 6, 0.13), (args.fps * 8, 0), (scene.frame_end, 0.13)):
        keyframe(lumi, frame, location=(0, 0, z))
    for frame, angle in ((1, -8), (args.fps * 6, -8), (args.fps * 7, 8), (args.fps * 8, -8), (scene.frame_end, -8)):
        wand_star.rotation_euler.y = math.radians(angle)
        wand_star.keyframe_insert("rotation_euler", frame=frame)

    # Studio set.
    bpy.ops.mesh.primitive_plane_add(size=30, location=(0, 0.9, 0), rotation=(0, 0, 0))
    floor = bpy.context.object
    floor.data.materials.append(aqua)
    bpy.ops.mesh.primitive_plane_add(size=30, location=(0, 3.0, 7.0), rotation=(math.radians(90), 0, 0))
    backdrop = bpy.context.object
    backdrop.data.materials.append(material("Backdrop violet", (0.14, 0.05, 0.32, 1), roughness=0.7))

    bpy.ops.object.light_add(type="AREA", location=(-4, -6, 10))
    key = bpy.context.object
    key.data.energy = 1150
    key.data.shape = "DISK"
    key.data.size = 5
    look_at(key, (0, 0, 4))
    bpy.ops.object.light_add(type="AREA", location=(5, -2, 7))
    fill = bpy.context.object
    fill.data.energy = 850
    fill.data.color = (0.45, 0.72, 1.0)
    fill.data.size = 4
    look_at(fill, (0, 0, 4))
    bpy.ops.object.light_add(type="POINT", location=(2.55, -0.6, 6.9))
    magic = bpy.context.object
    magic.data.energy = 450
    magic.data.color = (1.0, 0.48, 0.04)

    bpy.ops.object.camera_add(location=(0, -20, 5.0))
    camera = bpy.context.object
    camera.data.type = "ORTHO"
    camera.data.ortho_scale = 10.6
    look_at(camera, (0, 0, 4.45))
    scene.camera = camera

    for fcurve in scene.animation_data.action.fcurves if scene.animation_data and scene.animation_data.action else []:
        for point in fcurve.keyframe_points:
            point.interpolation = "BEZIER"

    os.makedirs(os.path.dirname(scene.render.filepath), exist_ok=True)
    return scene


def main():
    args = arguments()
    scene = build_scene(args)
    scene.frame_set(1)
    bpy.ops.wm.save_as_mainfile(filepath=os.path.splitext(os.path.abspath(args.output))[0] + ".blend")
    bpy.ops.render.render(animation=True)


if __name__ == "__main__":
    main()
