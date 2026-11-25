"""Build the original Wavi model and its two glTF levels in Blender."""
from math import radians, sin, pi
from pathlib import Path
import sys

import bpy
from mathutils import Vector

output = Path(sys.argv[sys.argv.index("--") + 1]).resolve()
output.mkdir(parents=True, exist_ok=True)

def material(name, rgba, roughness=.55):
    result = bpy.data.materials.new(name)
    result.diffuse_color = rgba
    result.use_nodes = True
    shader = result.node_tree.nodes.get("Principled BSDF")
    shader.inputs["Base Color"].default_value = rgba
    shader.inputs["Roughness"].default_value = roughness
    return result

def build_model(low):
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    lime = material("Wavi / lima", (.50, .78, .075, 1))
    lime_light = material("Wavi / reflexo", (.63, .85, .15, 1))
    dark = material("Fones / grafite", (.025, .035, .043, 1))
    inner = material("Fones / almofada", (.07, .085, .097, 1), .7)
    eye = material("Olhos", (.008, .014, .012, 1), .23)
    glow = material("Reflexos", (.95, .98, .9, 1))
    tongue = material("Língua", (.94, .17, .23, 1))
    main = bpy.data.objects.new("Wavi", None)
    bpy.context.collection.objects.link(main)
    segments, rings = (12, 8) if low else (24, 14)

    def sphere(name, xyz, size, shade, angle=0):
        bpy.ops.mesh.primitive_uv_sphere_add(segments=segments, ring_count=rings, location=xyz)
        obj = bpy.context.object
        obj.name = name
        obj.parent = main
        obj.scale = size
        obj.rotation_euler.y = radians(angle)
        obj.data.materials.append(shade)
        for polygon in obj.data.polygons:
            polygon.use_smooth = True
        return obj

    def squash(obj, name, factor):
        obj.shape_key_add(name="Basis")
        shape = obj.shape_key_add(name=name)
        for vertex, point in zip(obj.data.vertices, shape.data):
            point.co.z = vertex.co.z * factor

    sphere("Corpo", (0, 0, 1.13), (.74, .53, .74), lime)
    sphere("Tufo", (-.18, -.015, 1.79), (.28, .27, .23), lime_light, -22)
    left = sphere("Braço esquerdo", (-.71, -.025, .94), (.14, .14, .32), lime, -52)
    right = sphere("Braço direito", (.72, -.015, 1.04), (.15, .14, .34), lime, 54)
    sphere("Pé esquerdo", (-.31, -.035, .39), (.25, .29, .14), lime)
    sphere("Pé direito", (.31, -.035, .39), (.25, .29, .14), lime)
    for side in (-1, 1):
        sphere(f"Cápsula {side}", (side * .67, 0, 1.39), (.185, .26, .33), dark, 8 * side)
        sphere(f"Almofada {side}", (side * .56, -.005, 1.39), (.13, .248, .31), inner)
        eye_obj = sphere(f"Eye {'L' if side < 0 else 'R'}", (side * .244, -.472, 1.36), (.098, .069, .145), eye, side * -7)
        squash(eye_obj, "Blink", .12)
        sphere(f"Luz {side}", (side * .244 - .025, -.537, 1.41), (.029, .015, .034), glow)
    mouth = sphere("Mouth", (0, -.503, 1.064), (.147, .056, .112), eye, -9)
    squash(mouth, "Talk", 1.92)
    sphere("Língua", (.028, -.554, 1.01), (.079, .022, .036), tongue, -12)
    arc = bpy.data.curves.new("Headphone arc", "CURVE")
    arc.dimensions = "3D"
    arc.resolution_u = 10 if low else 16
    arc.bevel_depth = .081
    arc.bevel_resolution = 1 if low else 3
    spline = arc.splines.new("BEZIER")
    points = [(-.675, .015, 1.48), (-.595, .055, 1.92), (0, .09, 2.16), (.595, .055, 1.92), (.675, .015, 1.48)]
    spline.bezier_points.add(len(points) - 1)
    for point, coordinate in zip(spline.bezier_points, points):
        point.co = coordinate
        point.handle_left_type = "AUTO"
        point.handle_right_type = "AUTO"
    arc_object = bpy.data.objects.new("Arco dos fones", arc)
    bpy.context.collection.objects.link(arc_object)
    arc_object.parent = main
    arc.materials.append(dark)
    bpy.ops.object.select_all(action="DESELECT")
    arc_object.select_set(True)
    bpy.context.view_layer.objects.active = arc_object
    bpy.ops.object.convert(target="MESH")
    scene = bpy.context.scene
    scene.render.fps = 24
    scene.frame_start = 1
    scene.frame_end = 48
    clips = {
        "Idle": (.022, .034, .045), "Blink": (.0, .0, .0), "HeadBob": (.04, .10, .04),
        "Talk": (.042, .065, .05), "Listening": (.01, .13, .035), "Dance": (.16, .31, .08),
        "Thinking": (.02, .08, .15), "Celebrate": (.29, .18, .1),
        "Confused": (.035, .09, .21), "Sleep": (.008, -.06, .06),
    }
    main.animation_data_create()
    for name, (height, roll, turn) in clips.items():
        for frame in (1, 9, 17, 25, 33, 41, 49):
            phase = 2 * pi * ((frame - 1) / 48)
            main.location.z = height * ((1 - __import__('math').cos(phase)) / 2)
            main.rotation_euler = (turn * sin(phase), roll * sin(phase), turn * sin(phase * 2))
            main.keyframe_insert(data_path="location", frame=frame, group="Body")
            main.keyframe_insert(data_path="rotation_euler", frame=frame, group="Body")
        action = main.animation_data.action
        action.name = name
        track = main.animation_data.nla_tracks.new()
        track.name = name
        strip = track.strips.new(name, 1, action)
        strip.name = name
        main.animation_data.action = None
    main.location = (0,0,0)
    main.rotation_euler = (0,0,0)
    # Keep the source scene tidy when opened for editing.
    for obj in bpy.context.scene.objects:
        obj.select_set(obj == main)
    bpy.context.view_layer.objects.active = main
    if not low:
        bpy.ops.wm.save_as_mainfile(filepath=str(output / "wavi.blend"))
    bpy.ops.export_scene.gltf(filepath=str(output / ("wavi-low.glb" if low else "wavi.glb")),
        export_format="GLB", export_animation_mode="NLA_TRACKS", export_cameras=False, export_lights=False)

build_model(False)
build_model(True)
