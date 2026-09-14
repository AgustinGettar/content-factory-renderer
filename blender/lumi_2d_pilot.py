import argparse
import math
import os
import sys

import bpy


def parse_args():
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True)
    parser.add_argument("--open-image", required=True)
    parser.add_argument("--blink-image", required=True)
    parser.add_argument("--width", type=int, default=540)
    parser.add_argument("--height", type=int, default=960)
    parser.add_argument("--fps", type=int, default=24)
    parser.add_argument("--seconds", type=float, default=6)
    return parser.parse_args(argv)


def clear_scene():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for collection in (bpy.data.materials, bpy.data.images, bpy.data.cameras):
        for item in list(collection):
            collection.remove(item)


def key(obj, frame, **values):
    for prop, value in values.items():
        setattr(obj, prop, value)
        obj.keyframe_insert(data_path=prop, frame=frame)


def plane_mesh(name, width, height):
    mesh = bpy.data.meshes.new(f"{name}Mesh")
    mesh.from_pydata(
        [(-width / 2, 0, 0), (width / 2, 0, 0), (width / 2, 0, height), (-width / 2, 0, height)],
        [],
        [(0, 1, 2, 3)],
    )
    uv = mesh.uv_layers.new(name="UVMap")
    coords = [(0, 0), (1, 0), (1, 1), (0, 1)]
    for loop, coord in zip(mesh.loops, coords):
        uv.data[loop.index].uv = coord
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    return obj


def canonical_material(open_path, blink_path):
    material = bpy.data.materials.new("Lumi canonical 2D")
    material.use_nodes = True
    material.blend_method = "BLEND"
    material.use_screen_refraction = True
    nodes = material.node_tree.nodes
    nodes.clear()

    out = nodes.new("ShaderNodeOutputMaterial")
    transparent = nodes.new("ShaderNodeBsdfTransparent")
    emission = nodes.new("ShaderNodeEmission")
    mix_shader = nodes.new("ShaderNodeMixShader")
    mix_color = nodes.new("ShaderNodeMixRGB")
    blink_value = nodes.new("ShaderNodeValue")
    blink_value.name = "Blink"
    blink_value.outputs[0].default_value = 0

    open_tex = nodes.new("ShaderNodeTexImage")
    blink_tex = nodes.new("ShaderNodeTexImage")
    open_tex.image = bpy.data.images.load(open_path, check_existing=False)
    blink_tex.image = bpy.data.images.load(blink_path, check_existing=False)
    for texture in (open_tex, blink_tex):
        texture.interpolation = "Linear"
        texture.extension = "CLIP"

    links = material.node_tree.links
    links.new(blink_value.outputs[0], mix_color.inputs[0])
    links.new(open_tex.outputs["Color"], mix_color.inputs[1])
    links.new(blink_tex.outputs["Color"], mix_color.inputs[2])
    links.new(mix_color.outputs[0], emission.inputs["Color"])
    emission.inputs["Strength"].default_value = 1.0
    links.new(open_tex.outputs["Alpha"], mix_shader.inputs[0])
    links.new(transparent.outputs[0], mix_shader.inputs[1])
    links.new(emission.outputs[0], mix_shader.inputs[2])
    links.new(mix_shader.outputs[0], out.inputs["Surface"])
    return material, blink_value


def flat_material(name, color, strength=1.0):
    material = bpy.data.materials.new(name)
    material.use_nodes = True
    nodes = material.node_tree.nodes
    for node in list(nodes):
        nodes.remove(node)
    out = nodes.new("ShaderNodeOutputMaterial")
    emission = nodes.new("ShaderNodeEmission")
    emission.inputs["Color"].default_value = color
    emission.inputs["Strength"].default_value = strength
    material.node_tree.links.new(emission.outputs[0], out.inputs["Surface"])
    return material


def star_object(name, radius, material, y=-0.22):
    vertices = []
    for i in range(10):
        angle = math.pi / 2 + i * math.pi / 5
        r = radius if i % 2 == 0 else radius * 0.43
        vertices.append((math.cos(angle) * r, y, math.sin(angle) * r))
    mesh = bpy.data.meshes.new(f"{name}Mesh")
    mesh.from_pydata(vertices, [], [tuple(range(10))])
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    obj.data.materials.append(material)
    return obj


def animate_blink(value_node, frames):
    socket = value_node.outputs[0]
    for center in (int(frames * 0.25), int(frames * 0.67), int(frames * 0.91)):
        for frame, value in ((center - 2, 0), (center - 1, 1), (center + 1, 1), (center + 3, 0)):
            socket.default_value = value
            socket.keyframe_insert("default_value", frame=frame)
    if socket.id_data.animation_data and socket.id_data.animation_data.action:
        for curve in socket.id_data.animation_data.action.fcurves:
            for point in curve.keyframe_points:
                point.interpolation = "CONSTANT"


def animate_sparkles(frames, material):
    positions = [(-3.3, 2.35), (-2.75, 3.05), (-3.55, 3.55), (-2.35, 3.65), (-3.75, 2.85)]
    for index, (x, z) in enumerate(positions):
        star = star_object(f"Magic sparkle {index + 1}", 0.14 + 0.035 * (index % 3), material)
        start = 4 + index * 7
        cycle = max(30, frames // 2)
        for offset in (0, cycle):
            a = start + offset
            key(star, a, location=(x, -0.22, z), scale=(0.01, 0.01, 0.01))
            key(star, min(frames, a + 8), location=(x + 0.18, -0.22, z + 0.22), scale=(1, 1, 1))
            key(star, min(frames, a + 18), location=(x + 0.35, -0.22, z + 0.52), scale=(0.01, 0.01, 0.01))


def build_scene(args):
    clear_scene()
    scene = bpy.context.scene
    frames = max(2, int(args.fps * args.seconds))
    scene.frame_start = 1
    scene.frame_end = frames
    scene.render.engine = "BLENDER_EEVEE"
    # One sample is sufficient for the unlit 2D artwork and keeps review jobs
    # inside the limits of Render's 0.15 CPU free instance.
    scene.eevee.taa_render_samples = 1
    scene.render.resolution_x = args.width
    scene.render.resolution_y = args.height
    scene.render.resolution_percentage = 100
    scene.render.fps = args.fps
    scene.render.image_settings.file_format = "FFMPEG"
    scene.render.ffmpeg.format = "MPEG4"
    scene.render.ffmpeg.codec = "H264"
    scene.render.ffmpeg.constant_rate_factor = "MEDIUM"
    scene.render.ffmpeg.ffmpeg_preset = "GOOD"
    scene.render.filepath = os.path.abspath(args.output)
    scene.world.color = (0.93, 0.90, 1.0)
    scene.view_settings.view_transform = "Standard"
    scene.view_settings.look = "Medium High Contrast"
    scene.view_settings.exposure = 0
    scene.view_settings.gamma = 1

    camera_data = bpy.data.cameras.new("Camera")
    camera = bpy.data.objects.new("Camera", camera_data)
    bpy.context.collection.objects.link(camera)
    camera.location = (0, -10, 0)
    camera.rotation_euler = (math.radians(90), 0, 0)
    camera_data.type = "ORTHO"
    camera_data.ortho_scale = 11.4
    scene.camera = camera

    background = plane_mesh("Pastel background", 13, 13)
    background.location = (0, 1.0, -6.5)
    background.data.materials.append(flat_material("Pastel lavender", (0.89, 0.84, 1.0, 1)))

    material, blink_value = canonical_material(os.path.abspath(args.open_image), os.path.abspath(args.blink_image))
    sprite_height = 10.15
    sprite = plane_mesh("Lumi canonical", sprite_height * 1122 / 1402, sprite_height)
    sprite.data.materials.append(material)
    rig = bpy.data.objects.new("Lumi 2D rig", None)
    bpy.context.collection.objects.link(rig)
    sprite.parent = rig
    rig.location = (0.15, 0, -5.05)

    # Quiet, child-friendly motion. The feet stay grounded while the torso
    # breathes and the pose follows a small, eased side-to-side arc.
    motion = [
        (1, -0.8, 0.00, 1.000, 1.000),
        (int(frames * 0.24), 0.55, 0.06, 1.004, 1.010),
        (int(frames * 0.50), 0.85, 0.00, 1.000, 1.000),
        (int(frames * 0.76), -0.45, 0.07, 1.004, 1.011),
        (frames, -0.8, 0.00, 1.000, 1.000),
    ]
    for frame, angle, rise, sx, sz in motion:
        rig.rotation_euler = (0, 0, math.radians(angle))
        rig.location = (0.15, 0, -5.05 + rise)
        rig.scale = (sx, 1, sz)
        rig.keyframe_insert("rotation_euler", frame=frame)
        rig.keyframe_insert("location", frame=frame)
        rig.keyframe_insert("scale", frame=frame)
    if rig.animation_data and rig.animation_data.action:
        for curve in rig.animation_data.action.fcurves:
            for point in curve.keyframe_points:
                point.interpolation = "BEZIER"
                point.handle_left_type = "AUTO_CLAMPED"
                point.handle_right_type = "AUTO_CLAMPED"

    animate_blink(blink_value, frames)
    animate_sparkles(frames, flat_material("Magic gold", (1.0, 0.63, 0.05, 1), 1.3))
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(os.path.dirname(os.path.abspath(args.output)), "lumi-2d-pilot.blend"))
    bpy.ops.render.render(animation=True)


if __name__ == "__main__":
    build_scene(parse_args())
