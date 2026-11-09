"""Locate the exact SlotsService class with inject(slot,...) method, NEW vs OLD."""
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
        # a file that defines both "inject(" with slot semantics AND "register(" AND "entriesOfSlot"
        lines = t.splitlines()
        # find method def lines for inject near register/entriesOfSlot
        inj = [(i,l.strip()) for i,l in enumerate(lines,1) if re.search(r'^\s*inject\s*\(', l)]
        eos = [(i,l.strip()) for i,l in enumerate(lines,1) if re.search(r'entriesOfSlot', l)]
        reg = [(i,l.strip()) for i,l in enumerate(lines,1) if re.search(r'^\s*register\s*\(', l)]
        if inj and eos and reg:
            # candidate: show inject + entriesOfSlot + register defs if within a reasonable window
            print("  FILE:", p, "inject:", [i for i,_ in inj][:6], "entriesOfSlot:", [i for i,_ in eos][:6], "register:", [i for i,_ in reg][:4])
            for i,l in inj[:6]:
                print("    inject   L%-6d %s" % (i, l[:140]))
            for i,l in eos[:4]:
                print("    entrOf   L%-6d %s" % (i, l[:140]))
            break
