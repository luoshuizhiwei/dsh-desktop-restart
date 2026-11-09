"""Find the authoritative slots service class (defines entriesOfSlot/register/inject)."""
import struct, json, re

NEW = r"E:\dsh-update-022rc1-check\new\app.asar"
OLD = r"D:\develop\AI Agent\DeepSeek Harness\resources\app.asar"

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

for label, ASAR in [("NEW", NEW), ("OLD", OLD)]:
    H, B = load(ASAR)
    cands = [p for p in allfiles(H) if p.endswith('.js')]
    print("\n######", label, "######")
    found = False
    for p in cands:
        try: t = get(ASAR, H, B, p)
        except Exception: continue
        # service class that DEFINES entriesOfSlot method
        if re.search(r'entriesOfSlot\s*\(', t) and ('class ' in t or '= class' in t) and 'register(' in t and 'inject(' in t:
            print("  DEF FILE:", p)
            lines = t.splitlines()
            for i, line in enumerate(lines, 1):
                if re.search(r'^\s*(register|inject|entriesOfSlot|subscribe|entries|dispose)\s*\([^)]*\)\s*\{', line):
                    print("    L%-5d %s" % (i, line.strip()[:150]))
            found = True
            break
    if not found:
        # fallback: any file where 'entriesOfSlot(' appears as method def
        for p in cands:
            try: t = get(ASAR, H, B, p)
            except Exception: continue
            for i, line in enumerate(t.splitlines(), 1):
                if re.search(r'^\s*entriesOfSlot\s*\(', line):
                    print("  (fallback) FILE:", p, "L", i, line.strip()[:120])
                    # show nearby register/inject defs
                    ls = t.splitlines()
                    for j in range(max(1,i-40), min(len(ls), i+40)+1):
                        if re.search(r'^\s*(register|inject)\s*\(', ls[j-1]):
                            print("      L%-5d %s" % (j, ls[j-1].strip()[:140]))
                    found = True
                    break
            if found: break
