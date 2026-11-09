"""Compare @deepseek-ai/dsh-client-ui-slots service class (inject/register/entriesOfSlot) NEW vs OLD."""
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
    print("\n######", label, "## dsh-client-ui-slots files ######")
    sf = [p for p in allfiles(H) if 'dsh-client-ui-slots' in p and p.endswith('.js')]
    for p in sf:
        t = get(ASAR, H, B, p)
        lines = t.splitlines()
        # find method signatures
        defs = []
        for i, l in enumerate(lines, 1):
            if re.search(r'^\s*(inject|register|entriesOfSlot|subscribe|provide|dispose)\s*\(', l):
                defs.append((i, l.strip()))
        if defs:
            print("  FILE:", p, " (%d lines)" % len(lines))
            for i,l in defs:
                print("    L%-6d %s" % (i, l[:160]))
