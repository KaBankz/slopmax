import os, sys, math

# base.py (the studio, glass and render helpers) sits beside this file.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import base, bpy, bmesh
from mathutils import Vector
from bpy_extras.object_utils import world_to_camera_view

# ---------------------------------------------------------------- parameters
ROT_Z = 17.0          # keycap yaw (degrees): true three-quarter view, left skirt visible
A0 = 1.00             # half width of the (square) footprint at the floor
H = 0.70              # keycap height
TAPER = 0.20          # skirt inset floor -> top: top face ~79% of the base
RC0, RC1 = 0.22, 0.17  # corner radius at floor / at top face
RE = 0.085            # top edge fillet
RB = 0.025            # tiny floor fillet (no hard cyan line at the base)
LIP = 0.045           # flat land between the top edge and the dish
DISH = 0.10          # dish depth (spherical scoop)
EL, DIST = 46.0, 14.0
FILL = 0.75           # object width as a fraction of the frame
INSIDE = 0.38       # floor brightness seen through the glass
TILE_TOP, TILE_BOT = "#2470EE", "#0C44B4"

s = base.setup(tile_top=TILE_TOP, tile_bottom=TILE_BOT, camera_elevation_deg=EL, camera_distance=DIST, lens_mm=100)
# Khronos PBR Neutral keeps cobalt cobalt (AgX drifts saturated blue toward violet) and still rolls off highlights
s.view_settings.view_transform = "Khronos PBR Neutral"; s.view_settings.look = "None"
cam = s.camera

# studio env: overhead softbox only; the surroundings are deep cobalt so glass edges refract colour, not grey
wr = [n for n in s.world.node_tree.nodes if n.type == "VALTORGB"][0].color_ramp
wr.elements[0].position = 0.90; wr.elements[0].color = (0.02, 0.05, 0.25, 1)
wr.elements[1].position = 0.985; wr.elements[1].color = (1.2, 1.22, 1.3, 1)
kl = bpy.data.objects["key"]; kl.location = (0, 1.2, 8.5); kl.rotation_euler = (math.radians(-8), 0, 0)
kl.data.size = 5.0; kl.data.energy = 400
bpy.data.objects["fill"].data.energy = 120
# a long thin strip high behind the key: one clean bright line along the back and side top edges
st = bpy.data.lights.new("strip", "AREA"); st.shape = "RECTANGLE"; st.size = 6.0; st.size_y = 0.55; st.energy = 520
so = bpy.data.objects.new("strip", st); s.collection.objects.link(so)
so.location = (0, 1.9, 4.6)
so.rotation_euler = (Vector((0, 0, 0.6)) - so.location).to_track_quat("-Z", "Y").to_euler()

# ---------------------------------------------------------------- keycap: one solid piece of glass
def rrect(a, r, z, nc=18, ns=26):
    """Rounded square ring; the straight sides are subdivided too, so the dish (a radial scoop) is sampled densely
    everywhere and the glass surface does not ride above the true curve between corners."""
    r = max(min(r, a - 1e-4), 0.004)
    pts = []
    for cx, cy, a0 in ((a - r, a - r, 0), (-(a - r), a - r, 90), (-(a - r), -(a - r), 180), (a - r, -(a - r), 270)):
        for i in range(nc + 1):
            t = math.radians(a0 + 90 * i / nc)
            pts.append((cx + r * math.cos(t), cy + r * math.sin(t), z))
        # straight side to the next corner
        t = math.radians(a0 + 90); dx, dy = -math.sin(t), math.cos(t)
        ex, ey = cx + r * math.cos(t), cy + r * math.sin(t)
        L = 2 * (a - r)
        for k in range(1, ns):
            pts.append((ex + dx * L * k / ns, ey + dy * L * k / ns, z))
    return pts

th = math.atan(TAPER / H)
prof = []  # (inset, z, material) floor -> skirt -> fillet -> land -> dish
for i in range(5):  # floor fillet
    ph = math.pi / 2 * i / 4
    prof.append((RB * (1 - math.sin(ph)) + RB * 0.3, RB * (1 - math.cos(ph)), 0))
Cz = H - RE
Cx = Cz * math.tan(th) + RE * (1 - math.sin(th))  # inset of the fillet centre (approx)
z_t = Cz + RE * math.sin(th)
for i in range(1, 11):
    z = RB + (z_t - RB) * i / 10
    prof.append((z * math.tan(th), z, 0))
s_edge = z_t * math.tan(th) + RE * math.cos(th)  # inset at the fillet centre
for i in range(1, 13):
    ph = th + (math.pi / 2 - th) * i / 12
    prof.append((s_edge - RE * math.cos(ph), Cz + RE * math.sin(ph), 1 if i > 6 else 0))
s_top = s_edge
a_dish = A0 - s_top - LIP
RD = a_dish * 1.06
def dish_profile(r):
    # spherical (paraboloid) scoop: slope grows toward the rim, so one crisp curved highlight sits in the back wall
    u = min(r / RD, 1.0)
    return DISH * (1 - u * u)
n_dish = 30
for i in range(0, n_dish + 1):
    a = a_dish * (1 - i / n_dish)
    if a < 0.01:
        break
    prof.append((A0 - a, H, 2))

def corner_r(sv):
    return max(RC0 - (RC0 - RC1) * min(sv / s_top, 1.0) - max(sv - s_top, 0), 0.02)

bm = bmesh.new()
rings, mats = [], []
for sv, z, m in prof:
    pts = rrect(A0 - sv, corner_r(sv), z)
    if m == 2:
        pts = [(x, y, zz - dish_profile(math.hypot(x, y))) for x, y, zz in pts]
    rings.append([bm.verts.new(p) for p in pts]); mats.append(m)
def bridge(r1, r2, mat):
    n = len(r1)
    for i in range(n):
        bm.faces.new((r1[i], r1[(i + 1) % n], r2[(i + 1) % n], r2[i])).material_index = mat
def fan(r, c, mat):
    n = len(r)
    for i in range(n):
        bm.faces.new((r[i], r[(i + 1) % n], c)).material_index = mat
for i in range(len(rings) - 1):
    bridge(rings[i], rings[i + 1], max(mats[i], mats[i + 1]) if mats[i + 1] == 2 else mats[i + 1])
# close the dish and the floor with single n-gons, not triangle fans: a fan pole under the subdivision
# surface showed up as a dark speck refracted through the front skirt
bm.faces.new(rings[-1]).material_index = 2
bm.faces.new(list(reversed(rings[0]))).material_index = 3
bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
me = bpy.data.meshes.new("keycap"); bm.to_mesh(me); bm.free()
key = bpy.data.objects.new("keycap", me); s.collection.objects.link(key)
for p in me.polygons: p.use_smooth = True
# smooth the ring facets (they drew sawtooth edges on the dish highlight and streaks in the skirt refraction)
_ss = key.modifiers.new("smooth", "SUBSURF"); _ss.levels = 1; _ss.render_levels = 2

IOR = 1.50
GLASS = "#A6D8FF"
def icy(name, rough, glow=None):
    m = base.glass(name, color=GLASS, roughness=rough, ior=IOR, absorption=0.55, shadow_tint=0.35)
    nt = m.node_tree; g = [n for n in nt.nodes if n.type == "BSDF_PRINCIPLED"][0]
    return m, nt, g
skirt, snt, sg = icy("skirt", 0.0)
edge, ent, eg = icy("edge", 0.0)
dish, dnt, dg = icy("dish", 0.34)
bot, bnt, bg_ = icy("bottom", 0.6)
# the dish is polished on the surface but frosted inside: rough refraction (calm milky field, no inner reflections)
# with a sharp reflection, so only one crisp curved highlight shows the scoop instead of a broad sheen
_rf = dnt.nodes.new("ShaderNodeBsdfRefraction"); _rf.inputs["Roughness"].default_value = 0.34; _rf.inputs["IOR"].default_value = IOR
_rf.inputs["Color"].default_value = base.srgb(GLASS)
_gl = dnt.nodes.new("ShaderNodeBsdfGlossy"); _gl.inputs["Roughness"].default_value = 0.05
_fr = dnt.nodes.new("ShaderNodeFresnel"); _fr.inputs["IOR"].default_value = IOR
_dm = dnt.nodes.new("ShaderNodeMixShader")
dnt.links.new(_fr.outputs[0], _dm.inputs["Fac"]); dnt.links.new(_rf.outputs[0], _dm.inputs[1]); dnt.links.new(_gl.outputs[0], _dm.inputs[2])
_sm = [n for n in dnt.nodes if n.type == "MIX_SHADER" and n != _dm][0]
dnt.links.new(_dm.outputs[0], _sm.inputs[1])

# LED under the key: mint light carried by the skirt glass, strongest at the floor, gone by ~40% of the height
def add_glow(m, color, strength, height):
    nt = m.node_tree; g = [n for n in nt.nodes if n.type == "BSDF_PRINCIPLED"][0]
    tc = nt.nodes.new("ShaderNodeTexCoord"); sp = nt.nodes.new("ShaderNodeSeparateXYZ")
    mr = nt.nodes.new("ShaderNodeMapRange"); mr.inputs["From Min"].default_value = 0.0; mr.inputs["From Max"].default_value = height
    mr.inputs["To Min"].default_value = 1.0; mr.inputs["To Max"].default_value = 0.0
    pw = nt.nodes.new("ShaderNodeMath"); pw.operation = "POWER"; pw.inputs[1].default_value = 1.8
    ml = nt.nodes.new("ShaderNodeMath"); ml.operation = "MULTIPLY"; ml.inputs[1].default_value = strength
    nt.links.new(tc.outputs["Object"], sp.inputs[0]); nt.links.new(sp.outputs["Z"], mr.inputs["Value"])
    nt.links.new(mr.outputs[0], pw.inputs[0]); nt.links.new(pw.outputs[0], ml.inputs[0])
    g.inputs["Emission Color"].default_value = base.srgb(color)
    nt.links.new(ml.outputs[0], g.inputs["Emission Strength"])
    m.cycles.emission_sampling = "NONE"
add_glow(skirt, "#5CFFD2", 0.55, 0.28)
for m in (skirt, edge, dish, bot): me.materials.append(m)

# ---------------------------------------------------------------- glyph: the option key, inlaid flush in the dish
def dish_z(x, y):
    return H - dish_profile(math.hypot(x, y))

def stroke_outline(path, w, R=0.11, ncap=16, nbend=10):
    P = [Vector(p) for p in path]
    cl = [P[0]]
    for i in range(1, len(P) - 1):
        d0 = (P[i] - P[i - 1]).normalized(); d1 = (P[i + 1] - P[i]).normalized()
        ang = math.acos(max(-1, min(1, d0.dot(d1))))
        t = R * math.tan(ang / 2)
        a, b = P[i] - d0 * t, P[i] + d1 * t
        n0 = Vector((-d0.y, d0.x)); side = 1 if (d0.x * d1.y - d0.y * d1.x) > 0 else -1
        c = a + n0 * side * R
        a0 = math.atan2(a.y - c.y, a.x - c.x); a1 = math.atan2(b.y - c.y, b.x - c.x)
        da = (a1 - a0 + math.pi) % (2 * math.pi) - math.pi
        for k in range(nbend + 1):
            t2 = a0 + da * k / nbend
            cl.append(c + Vector((math.cos(t2), math.sin(t2))) * R)
    cl.append(P[-1])
    pts = [cl[0]]
    for i in range(1, len(cl)):
        seg = cl[i] - cl[i - 1]; n = max(1, int(seg.length / 0.03))
        for k in range(1, n + 1):
            pts.append(cl[i - 1] + seg * (k / n))
    def normal(i):
        d = pts[min(i + 1, len(pts) - 1)] - pts[max(i - 1, 0)]
        d.normalize(); return Vector((-d.y, d.x))
    left = [pts[i] + normal(i) * w for i in range(len(pts))]
    right = [pts[i] - normal(i) * w for i in range(len(pts))]
    out = list(left)
    d = (pts[-1] - pts[-2]).normalized(); ba = math.atan2(d.y, d.x)
    for k in range(1, ncap):
        t = ba + math.pi / 2 - math.pi * k / ncap
        out.append(pts[-1] + Vector((math.cos(t), math.sin(t))) * w)
    out += list(reversed(right))
    d = (pts[1] - pts[0]).normalized(); ba = math.atan2(d.y, d.x)
    for k in range(1, ncap):
        t = ba - math.pi / 2 - math.pi * k / ncap
        out.append(pts[0] + Vector((math.cos(t), math.sin(t))) * w)
    return out

def inlay(name, outline, mat, depth=0.06, bev=0.022, proud=0.006):
    """Flat-topped bar with a rounded top edge, wrapped onto the dish, its top just proud of the glass."""
    cu = bpy.data.curves.new(name, "CURVE"); cu.dimensions = "2D"; cu.fill_mode = "BOTH"
    cu.extrude = depth; cu.bevel_depth = bev; cu.bevel_resolution = 5
    sp = cu.splines.new("POLY"); sp.points.add(len(outline) - 1)
    for p, v in zip(sp.points, outline): p.co = (v.x, v.y, 0, 1)
    sp.use_cyclic_u = True
    ob = bpy.data.objects.new(name, cu); s.collection.objects.link(ob)
    bpy.context.view_layer.objects.active = ob; ob.select_set(True)
    bpy.ops.object.convert(target="MESH"); ob = bpy.context.object; ob.select_set(False)
    # densify the flat caps so they follow the dish curvature exactly
    bm2 = bmesh.new(); bm2.from_mesh(ob.data)
    bmesh.ops.triangulate(bm2, faces=bm2.faces)
    for _ in range(3):
        long_e = [e for e in bm2.edges if e.calc_length() > 0.04]
        if not long_e: break
        bmesh.ops.subdivide_edges(bm2, edges=long_e, cuts=1, use_grid_fill=True)
        bmesh.ops.triangulate(bm2, faces=bm2.faces)
    bm2.to_mesh(ob.data); bm2.free()
    top = depth + bev
    for v in ob.data.vertices:
        v.co.z = v.co.z - top + proud + dish_z(v.co.x, v.co.y)
    for p in ob.data.polygons: p.use_smooth = True
    ob.data.materials.append(mat)
    return ob

GW, GH, SW = 0.50, 0.33, 0.100   # glyph half width / half height / stroke half width
GOFF = (0.0, -0.01)
lit = base.emissive("whitehot", color="#FFFFFF", strength=1.0)
_nt = lit.node_tree; _e = [n for n in _nt.nodes if n.type == "EMISSION"][0]
_lw = _nt.nodes.new("ShaderNodeLayerWeight"); _lw.inputs["Blend"].default_value = 0.3
_cr = _nt.nodes.new("ShaderNodeValToRGB")
_cr.color_ramp.elements[0].color = (7.0, 7.4, 7.6, 1); _cr.color_ramp.elements[0].position = 0.15
_cr.color_ramp.elements[1].color = tuple(v * 5.0 for v in base.srgb("#5CFFD2")[:3]) + (1,); _cr.color_ramp.elements[1].position = 0.7
_nt.links.new(_lw.outputs["Facing"], _cr.inputs[0]); _nt.links.new(_cr.outputs[0], _e.inputs["Color"])
# the buried flanks glow mint inside the frosted glass (the light bleeds a little into the dish)
_gm = _nt.nodes.new("ShaderNodeNewGeometry"); _sz = _nt.nodes.new("ShaderNodeSeparateXYZ")
_nt.links.new(_gm.outputs["Normal"], _sz.inputs[0])
_mz = _nt.nodes.new("ShaderNodeMapRange"); _mz.inputs["From Min"].default_value = 0.5; _mz.inputs["From Max"].default_value = 0.95
_mz.inputs["To Min"].default_value = 0.0; _mz.inputs["To Max"].default_value = 1.0
_nt.links.new(_sz.outputs["Z"], _mz.inputs["Value"])
_side = _nt.nodes.new("ShaderNodeEmission"); _side.inputs["Color"].default_value = base.srgb("#5CFFD2"); _side.inputs["Strength"].default_value = 1.4
_mix = _nt.nodes.new("ShaderNodeMixShader")
_nt.links.new(_mz.outputs[0], _mix.inputs["Fac"]); _nt.links.new(_side.outputs[0], _mix.inputs[1]); _nt.links.new(_e.outputs[0], _mix.inputs[2])
_out = [n for n in _nt.nodes if n.type == "OUTPUT_MATERIAL"][0]
_nt.links.new(_mix.outputs[0], _out.inputs["Surface"])

# straight-ahead track: unlit, a pale satin inlay of the same shape, clearly part of the glyph but secondary
unlit = bpy.data.materials.new("unlit"); unlit.use_nodes = True
ug = unlit.node_tree.nodes["Principled BSDF"]
ug.inputs["Base Color"].default_value = base.srgb("#CFE3F6"); ug.inputs["Roughness"].default_value = 0.45
ug.inputs["Emission Color"].default_value = base.srgb("#B4D2F2"); ug.inputs["Emission Strength"].default_value = 0.8
ug.inputs["Coat Weight"].default_value = 0.0

ox, oy = GOFF
divert = stroke_outline([(-GW + ox, GH + oy), (-0.19 + ox, GH + oy), (0.17 + ox, -GH + oy), (GW + ox, -GH + oy)], SW - 0.022)
straight = stroke_outline([(0.16 + ox, GH + oy), (GW + ox, GH + oy)], SW - 0.022)
g1 = inlay("divert", divert, lit)
g2 = inlay("straight", straight, unlit)
glyph = [g1, g2]
for g in glyph: g.visible_shadow = False

# strip light only touches the glass edge, so the tile keeps its colour
rc = bpy.data.collections.new("striprecv"); rc.objects.link(key)
so.light_linking.receiver_collection = rc

root = bpy.data.objects.new("root", None); s.collection.objects.link(root)
for ob in [key] + glyph:
    ob.parent = root
root.rotation_euler = (0, 0, math.radians(ROT_Z))

# ---------------------------------------------------------------- tile: flat, self-lit two-tone (no vignette)
#  plus one contact shadow: a tight dark band hugging the base and a broad soft falloff (ambient occlusion)
bd = bpy.data.materials["backdrop"]; nt = bd.node_tree
ramp = [n for n in nt.nodes if n.type == "VALTORGB"][0]
out = [n for n in nt.nodes if n.type == "OUTPUT_MATERIAL"][0]
mrg = [n for n in nt.nodes if n.type == "MAP_RANGE"][0]
mrg.inputs["From Min"].default_value = -3; mrg.inputs["From Max"].default_value = 9
em = nt.nodes.new("ShaderNodeEmission"); em.inputs["Strength"].default_value = 1.0
def ao_term(dist, power):
    ao = nt.nodes.new("ShaderNodeAmbientOcclusion"); ao.inputs["Distance"].default_value = dist; ao.samples = 16
    ao.only_local = False
    pw = nt.nodes.new("ShaderNodeMath"); pw.operation = "POWER"; pw.inputs[1].default_value = power
    nt.links.new(ao.outputs["AO"], pw.inputs[0])
    return pw
tight = ao_term(0.10, 3.0)
broad = ao_term(1.1, 1.6)
m1 = nt.nodes.new("ShaderNodeMath"); m1.operation = "MULTIPLY"
nt.links.new(tight.outputs[0], m1.inputs[0]); nt.links.new(broad.outputs[0], m1.inputs[1])
geo = nt.nodes.new("ShaderNodeNewGeometry")
vr = nt.nodes.new("ShaderNodeVectorRotate"); vr.rotation_type = "Z_AXIS"; vr.inputs["Angle"].default_value = -math.radians(ROT_Z)
nt.links.new(geo.outputs["Position"], vr.inputs["Vector"])
sxy = nt.nodes.new("ShaderNodeSeparateXYZ"); nt.links.new(vr.outputs[0], sxy.inputs[0])
def absn(sock):
    n = nt.nodes.new("ShaderNodeMath"); n.operation = "ABSOLUTE"; nt.links.new(sock, n.inputs[0]); return n
mx = nt.nodes.new("ShaderNodeMath"); mx.operation = "MAXIMUM"
nt.links.new(absn(sxy.outputs["X"]).outputs[0], mx.inputs[0]); nt.links.new(absn(sxy.outputs["Y"]).outputs[0], mx.inputs[1])
inside = nt.nodes.new("ShaderNodeMapRange"); inside.interpolation_type = "SMOOTHSTEP"
inside.inputs["From Min"].default_value = A0 - 0.05; inside.inputs["From Max"].default_value = A0 - 0.35
inside.inputs["To Min"].default_value = 0.0; inside.inputs["To Max"].default_value = INSIDE
nt.links.new(mx.outputs[0], inside.inputs["Value"])
m1b = nt.nodes.new("ShaderNodeMath"); m1b.operation = "MAXIMUM"
nt.links.new(m1.outputs[0], m1b.inputs[0]); nt.links.new(inside.outputs[0], m1b.inputs[1])
m1 = m1b
mul = nt.nodes.new("ShaderNodeMix"); mul.data_type = "RGBA"; mul.blend_type = "MULTIPLY"; mul.inputs[0].default_value = 1.0
nt.links.new(ramp.outputs[0], mul.inputs[6]); nt.links.new(m1.outputs[0], mul.inputs[7])
# keep a hint of the darkest shadow from going black: lerp toward a deep navy
nt.links.new(mul.outputs[2], em.inputs["Color"]); nt.links.new(em.outputs[0], out.inputs["Surface"])
bpy.data.objects["backdrop"].visible_shadow = False

# ---------------------------------------------------------------- frame: fit the object to FILL of the frame, optically centred
bpy.context.view_layer.update()
def bbox():
    dg_ = bpy.context.evaluated_depsgraph_get()
    xs, ys = [], []
    for v in key.evaluated_get(dg_).data.vertices:
        p = world_to_camera_view(s, cam, key.matrix_world @ v.co); xs.append(p.x); ys.append(p.y)
    return min(xs), max(xs), min(ys), max(ys)
for _ in range(3):
    x0, x1, y0, y1 = bbox()
    size = max(x1 - x0, y1 - y0)
    cam.data.lens *= FILL / size
    bpy.context.view_layer.update()
    x0, x1, y0, y1 = bbox()
    cam.data.shift_x += (x0 + x1) / 2 - 0.5
    cam.data.shift_y += (y0 + y1) / 2 - 0.515   # a touch high: the contact shadow below adds visual weight
    bpy.context.view_layer.update()

s.cycles.caustics_reflective = False
s.cycles.sample_clamp_indirect = 4.0
s.cycles.blur_glossy = 0.6
s.cycles.use_adaptive_sampling = True; s.cycles.adaptive_threshold = 0.02
s.cycles.time_limit = 1250
s.cycles.max_bounces = 12; s.cycles.transmission_bounces = 12
base.render()
