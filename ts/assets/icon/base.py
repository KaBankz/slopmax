# Shared scene setup for slopmax icon renders in Blender (Cycles, CPU).
# scene.py puts this directory on sys.path and does: import base
# then  base.setup(tile_top=(r,g,b), tile_bottom=(r,g,b))  builds an empty scene with camera, backdrop, lights,
# models its own objects, and ends with  base.render()  (the render script decides size, samples and output path).
import bpy, math, os, sys

def srgb(c):
    """sRGB 0-1 (or hex '#RRGGBB') to linear, for Blender color inputs."""
    if isinstance(c, str):
        c = tuple(int(c[i:i + 2], 16) / 255 for i in (1, 3, 5))
    f = lambda v: v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4
    return (f(c[0]), f(c[1]), f(c[2]), 1.0)

def setup(tile_top="#20403A", tile_bottom="#10241F", camera_elevation_deg=35.0, camera_distance=12.0, lens_mm=85.0):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    s = bpy.context.scene
    s.render.engine = "CYCLES"
    s.cycles.device = "CPU"
    s.cycles.use_denoising = True
    s.render.resolution_x = s.render.resolution_y = 1024
    s.render.film_transparent = False
    s.view_settings.view_transform = "AgX"
    s.view_settings.look = "AgX - Base Contrast"
    s.cycles.max_bounces = 16
    s.cycles.transmission_bounces = 16
    s.cycles.glossy_bounces = 8
    # Camera looks at the origin from the front, elevated; objects sit on the z=0 floor around the origin.
    el = math.radians(camera_elevation_deg)
    cam_data = bpy.data.cameras.new("cam"); cam_data.lens = lens_mm
    cam = bpy.data.objects.new("cam", cam_data); s.collection.objects.link(cam); s.camera = cam
    cam.location = (0, -camera_distance * math.cos(el), camera_distance * math.sin(el))
    cam.rotation_euler = (math.pi / 2 - el, 0, 0)
    # Backdrop: one big curved sweep (floor bending up into a wall behind) with a vertical gradient, like a studio cyc,
    # so the frame is filled with the tile colour and glass has something to refract.
    bpy.ops.mesh.primitive_plane_add(size=60, location=(0, 10, 0))
    floor = bpy.context.object; floor.name = "backdrop"
    mat = bpy.data.materials.new("backdrop"); mat.use_nodes = True
    nt = mat.node_tree; nt.nodes.clear()
    tc = nt.nodes.new("ShaderNodeTexCoord"); sep = nt.nodes.new("ShaderNodeSeparateXYZ")
    mr = nt.nodes.new("ShaderNodeMapRange"); mr.inputs["From Min"].default_value = -6; mr.inputs["From Max"].default_value = 14
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    ramp.color_ramp.elements[0].color = srgb(tile_bottom); ramp.color_ramp.elements[1].color = srgb(tile_top)
    bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled"); bsdf.inputs["Roughness"].default_value = 0.9
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    nt.links.new(tc.outputs["Object"], sep.inputs[0]); nt.links.new(sep.outputs["Y"], mr.inputs["Value"])
    nt.links.new(mr.outputs[0], ramp.inputs[0]); nt.links.new(ramp.outputs[0], bsdf.inputs["Base Color"])
    nt.links.new(bsdf.outputs[0], out.inputs[0]); floor.data.materials.append(mat)
    # Bend the back half of the floor up into a wall.
    mod = floor.modifiers.new("sub", "SUBSURF"); mod.levels = mod.render_levels = 0
    bpy.ops.object.mode_set(mode="EDIT"); bpy.ops.mesh.subdivide(number_cuts=60); bpy.ops.object.mode_set(mode="OBJECT")
    for v in floor.data.vertices:
        y = v.co.y + 10
        if y > 4:
            t = min(1.0, (y - 4) / 6)
            v.co.z = (1 - math.cos(t * math.pi / 2)) * 6 + max(0, y - 10)
            v.co.y = 4 - 10 + math.sin(t * math.pi / 2) * 6
    floor.data.update()
    bpy.ops.object.shade_smooth()
    # Light: a studio environment that is bright overhead and dark below (so glass has something bright to refract
    # and reflect, giving rims from above), one big soft key light from above and slightly behind, and a dim fill.
    w = bpy.data.worlds.new("w"); s.world = w; w.use_nodes = True
    wn = w.node_tree; bg = wn.nodes["Background"]
    wtc = wn.nodes.new("ShaderNodeTexCoord"); wsep = wn.nodes.new("ShaderNodeSeparateXYZ")
    wr = wn.nodes.new("ShaderNodeValToRGB")
    wr.color_ramp.elements[0].position = 0.45; wr.color_ramp.elements[0].color = (0.02, 0.02, 0.025, 1)
    wr.color_ramp.elements[1].position = 0.9; wr.color_ramp.elements[1].color = (1.6, 1.6, 1.65, 1)
    wmr = wn.nodes.new("ShaderNodeMapRange"); wmr.inputs["From Min"].default_value = -1; wmr.inputs["From Max"].default_value = 1
    wn.links.new(wtc.outputs["Generated"], wsep.inputs[0]); wn.links.new(wsep.outputs["Z"], wmr.inputs["Value"])
    wn.links.new(wmr.outputs[0], wr.inputs[0]); wn.links.new(wr.outputs[0], bg.inputs[0])
    key = bpy.data.lights.new("key", "AREA"); key.energy = 2500; key.size = 8; key.shape = "DISK"
    ko = bpy.data.objects.new("key", key); ko.location = (0, 2.5, 8); ko.rotation_euler = (math.radians(-15), 0, 0)
    s.collection.objects.link(ko)
    fill = bpy.data.lights.new("fill", "AREA"); fill.energy = 300; fill.size = 10
    fo = bpy.data.objects.new("fill", fill); fo.location = (0, -8, 4); fo.rotation_euler = (math.radians(65), 0, 0)
    s.collection.objects.link(fo)
    return s

def render():
    """Renders to the path, size and samples the render script passes after `--`: out.png size samples."""
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    s = bpy.context.scene
    out = argv[0] if argv else "render.png"
    size = int(argv[1]) if len(argv) > 1 else 512
    s.cycles.samples = int(argv[2]) if len(argv) > 2 else 32
    s.render.resolution_x = s.render.resolution_y = size
    s.render.filepath = out
    bpy.ops.render.render(write_still=True)

def glass(name, color="#E8F4F2", roughness=0.05, ior=1.45, absorption=0.0, shadow_tint=0.85):
    """A glass material that lets light through to whatever is under it. Shadow rays see a tinted transparent
    surface instead of glass, so the floor below stays lit (path tracing cannot find caustics through soft lights).
    roughness > 0.2 gives frosted glass. absorption > 0 tints thicker parts more (volume absorption)."""
    m = bpy.data.materials.new(name); m.use_nodes = True
    nt = m.node_tree; nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    g = nt.nodes.new("ShaderNodeBsdfPrincipled")
    g.inputs["Base Color"].default_value = srgb(color)
    g.inputs["Transmission Weight"].default_value = 1.0
    g.inputs["Roughness"].default_value = roughness
    g.inputs["IOR"].default_value = ior
    tr = nt.nodes.new("ShaderNodeBsdfTransparent")
    c = srgb(color); tr.inputs["Color"].default_value = tuple(shadow_tint * v + (1 - shadow_tint) for v in c[:3]) + (1,)
    lp = nt.nodes.new("ShaderNodeLightPath")
    mix = nt.nodes.new("ShaderNodeMixShader")
    nt.links.new(lp.outputs["Is Shadow Ray"], mix.inputs["Fac"])
    nt.links.new(g.outputs[0], mix.inputs[1]); nt.links.new(tr.outputs[0], mix.inputs[2])
    nt.links.new(mix.outputs[0], out.inputs["Surface"])
    if absorption > 0:
        v = nt.nodes.new("ShaderNodeVolumeAbsorption")
        v.inputs["Color"].default_value = srgb(color); v.inputs["Density"].default_value = absorption
        nt.links.new(v.outputs[0], out.inputs["Volume"])
    return m

def emissive(name, color="#3EF2B0", strength=6.0):
    """A self-lit material (LED-lit glyphs, light rods)."""
    m = bpy.data.materials.new(name); m.use_nodes = True
    nt = m.node_tree; nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial"); e = nt.nodes.new("ShaderNodeEmission")
    e.inputs["Color"].default_value = srgb(color); e.inputs["Strength"].default_value = strength
    nt.links.new(e.outputs[0], out.inputs["Surface"])
    return m
