"""Find file that DEFINES entriesOfSlot( and inject( as class methods (the real slots service)."""
import struct, json, re

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

for label, ASAR in [("NEW", r"E:\dsh-update-022rc1-check\new\app.asar"), ("OLD", r"D:\develop\AI Agent\DeepSeek Harness\resources\app.asar")]:
    H, B = load(ASAR)
    print("\n######", label, "######")
    for p in [x for x in allfiles(H) if x.endswith('.js')]:
        try: t = get(ASAR, H, B, p)
        except Exception: continue
        lines = t.splitlines()
        # look for "entriesOfSlot(" as a method definition (not just a call)
        eos_def = [(i,l.strip()) for i,l in enumerate(lines,1) if re.search(r'^\s*entriesOfSlot\s*\(', l)]
        inj_def = [(i,l.strip()) for i,l in enumerate(lines,1) if re.search(r'^\s*inject\s*\([^)]*\)\s*\{', l)]
        reg_def = [(i,l.strip()) for i,l in enumerate(lines,1) if re.search(r'^\s*register\s*\(', l)]
        if eos_def and inj_def:
            print("  SERVICE FILE:", p)
            for i,l in inj_def[:5]: print("    inject     L%-6d %s" % (i,l[:140]))
            for i,l in eos_def[:5]: print("    entrOfSlot L%-6d %s" % (i,l[:140]))
            for i,l in reg_def[:5]: print("    register   L%-6d %s" % (i,l[:140]))
            break
    else:
        print("  (no single file with both; entriesOfSlot defs:)")
        for p in [x for x in allfiles(H) if x.endswith('.js')]:
            try: t = get(ASAR, H, B, p)
            except Exception: continue
            for i,l in enumerate(t.splitlines(),1):
                if re.search(r'^\s*entriesOfSlot\s*\(', l):
                    print("    ", p, "L", i, l.strip()[:120])
                    break
