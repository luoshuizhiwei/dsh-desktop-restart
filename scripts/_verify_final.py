"""Final risk checks: loader engines validation + slots.register + bundled runtime."""
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

NEW = r"E:\dsh-update-022rc1-check\new\app.asar"
OLD = r"D:\develop\AI Agent\DeepSeek Harness\resources\app.asar"

for label, ASAR in [("NEW", NEW), ("OLD", OLD)]:
    H, B = load(ASAR)
    print("\n############", label, "############")

    # A) loader: does it validate engines.node / engines.dsh?
    print("----- cordis-plugin-loader engines handling -----")
    for p in [x for x in allfiles(H) if 'cordis-plugin-loader' in x and x.endswith('.js')]:
        t = get(ASAR, H, B, p)
        if 'engines' in t or 'node' in t and 'satisf' in t:
            for i,l in enumerate(t.splitlines(),1):
                if re.search(r'engines|satisf|node.*version|dsh.*version|Unsupported|requires Node', l, re.I):
                    print("  %s L%-5d %s" % (p.split('/')[-1], i, l.strip()[:150]))
            break

    # B) plugin manager / client-modules: engines.node hard-block?
    print("----- engines.node validation across host packages (NEW only sample) -----")
    if label == "NEW":
        cnt = 0
        for p in [x for x in allfiles(H) if x.endswith('.js')]:
            t = get(ASAR, H, B, p)
            for i,l in enumerate(t.splitlines(),1):
                if re.search(r'engines\??\.node|engines\??\.dsh|engines\[["\']node', l):
                    print("  %s L%-5d %s" % (p.split('/')[-2]+'/'+p.split('/')[-1], i, l.strip()[:150]))
                    cnt += 1
                    if cnt >= 12: break
            if cnt >= 12: break
        if cnt == 0: print("  (no engines.node/dsh validation found in js sources)")

    # C) slots service: register() method location
    print("----- slots 'register(' method (NEW/OLD) -----")
    F = "/dsh/node_modules/@deepseek-ai/dsh-client-ui-renderer/lib/client.js"
    t = get(ASAR, H, B, F)
    for i,l in enumerate(t.splitlines(),1):
        if re.search(r'^\s*register\s*\(', l) or re.search(r'register\s*=\s*\(', l) or 'register(definition)' in l:
            print("  L%-6d %s" % (i, l.strip()[:140]))

    # D) dsh-client-ui-primitives present in asar as a real package?
    prim = [p for p in allfiles(H) if 'dsh-client-ui-primitives' in p and p.endswith('package.json')]
    print("----- dsh-client-ui-primitives package.json in asar:", len(prim), "-----")
    for p in prim[:2]:
        print("  ", p)

# E) bundled node: list app.7z for the main exe / node
print("\n############ bundled runtime (app.7z listing) ############")
import subprocess, os
seven = r"C:\Program Files\7-Zip\7z.exe"
r = subprocess.run([seven, 'l', r"E:\dsh-update-022rc1-check\app.7z"], capture_output=True, text=True, errors='replace')
for line in r.stdout.splitlines():
    if re.search(r'\b(deepseek|DeepSeek|dsh|node|electron)\b.*\.exe\s*$', line, re.I) or re.search(r'\.(exe|node)\s+\d', line):
        print("  ", line.strip()[:160])
print("  (total lines:", len(r.stdout.splitlines()), ")")
