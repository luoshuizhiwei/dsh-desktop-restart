"""Check whether engines.dsh/engines.node can hard-block the restart plugin in NEW asar."""
import struct, json, re, subprocess

NEW = r"E:\dsh-update-022rc1-check\new\app.asar"

def load(path):
    with open(path, 'rb') as f:
        head = f.read(16)
        hps = struct.unpack('<I', head[4:8])[0]
        jlen = struct.unpack('<I', head[12:16])[0]
        f.seek(16)
        return json.loads(f.read(jlen).decode('utf-8')), 8 + hps

def get(path, header, base, rel):
    node = header
    for p in [x for x in rel.split('/') if x]:
        node = node['files'][p]
    with open(path, 'rb') as f:
        f.seek(base + int(node['offset']))
        return f.read(int(node['size'])).decode('utf-8', 'replace')

def allfiles(header, prefix=""):
    out = []
    for k, v in header.get('files', {}).items():
        p = prefix + "/" + k
        if 'files' in v: out += allfiles(v, p)
        else: out.append(p)
    return out

H, B = load(NEW)
js = [p for p in allfiles(H) if p.endswith('.js')]

# 1) which package owns the "requirements ... engines.dsh" schema?
print("===== files with engines.dsh requirements schema =====")
owner = set()
for p in js:
    try: t = get(NEW, H, B, p)
    except Exception: continue
    if 'Only the requirements the running version does not satisfy' in t:
        owner.add('/'.join(p.split('/')[:4]))
print("  packages:", sorted(owner))

# 2) does any host code READ a plugin's engines and refuse to load it?
print("\n===== engines checks in plugin loader / manager / client-modules =====")
targets = [p for p in js if any(k in p for k in ['cordis-plugin-loader', 'dsh-plugin-manager', 'dsh-client-modules', 'dsh-host-plugin-inventory'])]
for p in targets:
    t = get(NEW, H, B, p)
    hits = [(i,l.strip()) for i,l in enumerate(t.splitlines(),1) if re.search(r'\bengines\b', l)]
    if hits:
        print("  FILE:", p, "(%d engines hits)" % len(hits))
        for i,l in hits[:10]:
            print("    L%-6d %s" % (i, l[:150]))

# 3) any hard error text about unmet requirements / node version
print("\n===== hard-block error strings about engines/node version =====")
pat = re.compile(r'(unmet|not satisfy|unsupported|requires? node|node version|engine)', re.I)
seen = 0
for p in targets:
    t = get(NEW, H, B, p)
    for i,l in enumerate(t.splitlines(),1):
        if re.search(r'(engines|requirement)', l, re.I) and pat.search(l) and ('throw new Error' in l or 'Error(' in l or 'reason' in l or 'blocker' in l):
            print("  %s L%-6d %s" % (p.split('/')[-1], i, l.strip()[:160]))
            seen += 1
            if seen > 14: break
    if seen > 14: break
if seen == 0: print("  (no hard-block throw tied to engines found)")

# 4) bundled node.exe version from app.7z (extract just that file's PE version via 7z e to stdout is not possible; list + strings)
print("\n===== bundled node.exe (extract & read version) =====")
seven = r"C:\Program Files\7-Zip\7z.exe"
out = r"E:\dsh-update-022rc1-check\bundled-node"
subprocess.run([seven, 'e', r"E:\dsh-update-022rc1-check\app.7z", "-o"+out,
                "resources/runtime/primary-runtime/dependencies/node/bin/node.exe", "-y"],
               capture_output=True, text=True, errors='replace')
import os, glob
exe = os.path.join(out, "node.exe")
if os.path.exists(exe):
    print("  extracted:", exe, os.path.getsize(exe), "bytes")
    r = subprocess.run([exe, "--version"], capture_output=True, text=True, errors='replace')
    print("  node --version:", r.stdout.strip(), r.stderr.strip()[:200])
else:
    print("  (extraction failed / not found)")
