"""Dump the slots service class region (around register/entries/subscribe) to confirm inject()."""
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

F = "/dsh/node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js"
for label, ASAR in [("NEW", r"E:\dsh-update-022rc1-check\new\app.asar"), ("OLD", r"D:\develop\AI Agent\DeepSeek Harness\resources\app.asar")]:
    H, B = load(ASAR)
    t = get(ASAR, H, B, F)
    lines = t.splitlines()
    print("\n######", label, "## slots service class region ######")
    # find "class" lines near register L3356, and any 'inject' method
    for i, line in enumerate(lines, 1):
        if re.search(r'class\s+\w*[Ss]lot|SlotsService|slots\s*=|provide\([^)]*slots', line):
            print("  L%-6d %s" % (i, line.strip()[:150]))
    # every 'inject' occurrence in file with first 30
    inj = [(i,l.strip()) for i,l in enumerate(lines,1) if re.search(r'\binject\b', l)]
    print("  -- inject occurrences:", len(inj), " first 12:")
    for i,l in inj[:12]:
        print("    L%-6d %s" % (i, l[:140]))
    # the register(definition) at ~L3356 context
    for i, line in enumerate(lines, 1):
        if re.search(r'^\s*register\(definition\)', line) and 3300 < i < 3400:
            print("  -- register(definition) context L%d-%d:" % (i-2, i+14))
            for j in range(i-2, min(len(lines), i+14)+1):
                print("    L%-6d %s" % (j, lines[j-1].strip()[:140]))
            break
