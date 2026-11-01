"""Code lines (not blank, not comment) split into product and test, per component."""
import os, re, sys, json
root = sys.argv[1]

def code_lines(text):
    out, block = [], False
    for line in text.split("\n"):
        s = line.strip()
        if block:
            if "*/" in s: block = False; s = s.split("*/", 1)[1].strip()
            else: continue
        if s.startswith("/*"):
            if "*/" not in s: block = True
            continue
        if not s or s.startswith("//"): continue
        out.append(line)
    return out

def rust_split(text):
    # Inline unit tests: everything from a top-level #[cfg(test)] on.
    m = re.search(r"^#\[cfg\(test\)\]", text, re.M)
    return (text, "") if not m else (text[:m.start()], text[m.start():])

rows = {}
def add(comp, kind, n):
    rows.setdefault(comp, {"product": 0, "test": 0})[kind] += n

def walk(base):
    for d, dirs, files in os.walk(base):
        dirs[:] = [x for x in dirs if x not in ("node_modules", "dist", "out", "target", ".turbo")]
        for f in files: yield os.path.join(d, f)

r = os.path.join(root, "crates")
for p in walk(r):
    rel = os.path.relpath(p, r); comp = "rust/" + rel.split("/")[0]
    if p.endswith(".rs"):
        prod, test = rust_split(open(p).read())
        is_test = "/tests/" in p or "/examples/" in p or "/benches/" in p
        add(comp, "test", len(code_lines(prod)) + len(code_lines(test))) if is_test else (add(comp, "product", len(code_lines(prod))), add(comp, "test", len(code_lines(test))))
    elif p.endswith(".html"):
        add(comp, "product", sum(1 for l in open(p) if l.strip()))
t = os.path.join(root, "ts")
for p in walk(t):
    rel = os.path.relpath(p, t); parts = rel.split("/")
    if not (p.endswith((".ts", ".tsx", ".css")) ) or p.endswith(".d.ts"): continue
    if parts[0] in ("apps", "packages", "tools"): comp = "ts/" + parts[1]
    else: comp = "ts/(root)"
    is_test = "/test/" in "/" + rel or ".test." in p
    add(comp, "test" if is_test else "product", len(code_lines(open(p).read())))
json.dump(rows, sys.stdout, indent=1)
