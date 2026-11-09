"""Confirm slots.register(definition) signature in dsh-client-ui-renderer NEW vs OLD."""
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

F = "/dsh/node_modules/@deepseek-ai/dsh-client-ui-renderer/lib/client.js"
for label, ASAR in [("NEW", r"E:\dsh-update-022rc1-check\new\app.asar"), ("OLD", r"D:\develop\AI Agent\DeepSeek Harness\resources\app.asar")]:
    H, B = load(ASAR)
    t = get(ASAR, H, B, F)
    lines = t.splitlines()
    print("\n######", label, "######")
    # all lines mentioning 'register' (def or call) in the slots service class region 1340-1610
    for i,l in enumerate(lines,1):
        if 1340 < i < 1610 and re.search(r'\bregister\b', l):
            print("  L%-6d %s" % (i, l.strip()[:160]))
    # also: the inject(key, callback) callback calls register() internally? show L1368-1400
    print("  -- inject() body L1368-1400:")
    for i in range(1368, 1401):
        print("    L%-6d %s" % (i, lines[i-1].strip()[:150]))
