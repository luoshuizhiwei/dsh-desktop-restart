"""Final checks: slots service API + account-menu feedback item in NEW asar."""
import struct, json, re

NEW = r"E:\dsh-update-022rc1-check\new\app.asar"
OLD = r"D:\develop\AI Agent\DeepSeek Harness\resources\app.asar"

def load(path):
    with open(path, 'rb') as f:
        head = f.read(16)
        hps = struct.unpack('<I', head[4:8])[0]
        jlen = struct.unpack('<I', head[12:16])[0]
        f.seek(16)
        header = json.loads(f.read(jlen).decode('utf-8'))
        return header, 8 + hps

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
        if 'files' in v:
            out += allfiles(v, p)
        else:
            out.append(p)
    return out

H, B = load(NEW)

# find the slots service provider (register / inject / entriesOfSlot)
print("===== files defining slots.register / inject / entriesOfSlot (NEW) =====")
cands = [p for p in allfiles(H) if p.endswith('.js')]
hits = []
for p in cands:
    try:
        t = get(NEW, H, B, p)
    except Exception:
        continue
    if ("entriesOfSlot" in t or "inject(" in t and "register(" in t) and "slots" in t.lower():
        if "provide" in t and "slots" in t:
            hits.append(p)
for p in hits:
    print("  ", p)

# locate the slots service definition more precisely
print("\n===== 'slots' service provide + register/inject signatures (NEW) =====")
for p in cands:
    try:
        t = get(NEW, H, B, p)
    except Exception:
        continue
    if re.search(r'provide\(\s*["\']slots["\']', t) or re.search(r'name:\s*["\']slots["\']', t) or 'SlotsService' in t:
        print("-- FILE:", p)
        for i, line in enumerate(t.splitlines(), 1):
            if re.search(r'\b(register|inject|entriesOfSlot|subscribe|provide)\s*\(', line) and 'slots' in p.replace('/dsh/node_modules/@deepseek-ai/',''):
                print("   L%-5d %s" % (i, line.strip()[:150]))
        # print register/inject/entriesOfSlot definitions regardless
        for i, line in enumerate(t.splitlines(), 1):
            if re.search(r'^\s*(register|inject|entriesOfSlot|subscribe)\s*\(', line):
                print("   *L%-5d %s" % (i, line.strip()[:150]))

# account menu feedback / menuitem structure
print("\n===== account menu '意见反馈'/'Feedback' menuitem (NEW) =====")
shown = 0
for p in cands:
    try:
        t = get(NEW, H, B, p)
    except Exception:
        continue
    if ('意见反馈' in t or 'Feedback' in t) and 'menuitem' in t:
        for i, line in enumerate(t.splitlines(), 1):
            if '意见反馈' in line or ('Feedback' in line and 'menuitem' in t[max(0,0):]):
                if '意见反馈' in line or 'Feedback' in line:
                    print("  %s L%-5d %s" % (p.split('/')[-1], i, line.strip()[:160]))
                    shown += 1
                    if shown > 18: break
    if shown > 18: break

# role=menuitem count / [role="menu"] context in the account-menu provider
print("\n===== role=menuitem occurrences near 意见反馈 (NEW) =====")
for p in cands:
    try:
        t = get(NEW, H, B, p)
    except Exception:
        continue
    if '意见反馈' in t:
        for i, line in enumerate(t.splitlines(), 1):
            if 'menuitem' in line or '意见反馈' in line or 'role="menu"' in line or "role: \"menu\"" in line:
                print("  %s L%-5d %s" % (p.split('/')[-1], i, line.strip()[:160]))
