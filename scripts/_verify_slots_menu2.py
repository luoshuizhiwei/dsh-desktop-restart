"""Focused: slots service definition (NEW) + contactUs menu wiring (NEW vs OLD)."""
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
    print("\n############", label, "############")

    # 1) slots service: find file containing "entriesOfSlot(" AND "register(" AND a provide of slots
    print("----- slots service definition file -----")
    for p in cands:
        try: t = get(ASAR, H, B, p)
        except Exception: continue
        if 'entriesOfSlot(' in t and 'provide(' in t and ('register(' in t) and ('slots' in t.lower()):
            # is it the service itself? look for class/Service with slots
            if re.search(r'provide\(\s*["\']slots["\']|["\']slots["\']\s*,\s*this|SlotsService|class\s+\w*Slots', t):
                print("  FILE:", p)
                lines = t.splitlines()
                for i, line in enumerate(lines, 1):
                    if re.search(r'^\s*(register|inject|entriesOfSlot|subscribe)\s*\(', line) or re.search(r'provide\(\s*["\']slots["\']', line):
                        print("    L%-5d %s" % (i, line.strip()[:160]))
                break

    # 2) contactUs menu item: find 'contactUs' usage + role=menuitem in same file
    print("----- contactUs / 意见反馈 menu item (role=menuitem) -----")
    for p in cands:
        try: t = get(ASAR, H, B, p)
        except Exception: continue
        if 'contactUs' in t and ('menuitem' in t or 'role: "menuitem"' in t or 'role="menuitem"' in t):
            lines = t.splitlines()
            idxs = [i for i,l in enumerate(lines,1) if 'contactUs' in l]
            # show menuitem lines near contactUs context (within whole file, menuitem defs)
            mi = [(i,l.strip()) for i,l in enumerate(lines,1) if re.search(r'menuitem', l)]
            print("  FILE:", p, " contactUs lines:", idxs[:6], " menuitem lines:", len(mi))
            # print the menu component region: lines containing contactUs and 8 lines around
            for i in idxs[:2]:
                for j in range(max(1,i-3), min(len(lines), i+6)+1):
                    if re.search(r'menuitem|contactUs|role=|MenuItem|onSelect|label', lines[j-1]):
                        print("    L%-6d %s" % (j, lines[j-1].strip()[:150]))
            break
