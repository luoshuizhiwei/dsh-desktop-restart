"""Compare exact API-contract lines of the restart plugin's host/client dependencies, old vs new asar."""
import struct, json, re, sys

OLD = r"D:\develop\AI Agent\DeepSeek Harness\resources\app.asar"
NEW = r"E:\dsh-update-022rc1-check\new\app.asar"

# (file inside asar, list of regexes whose matching lines we want to see)
TARGETS = [
    ("/dsh/node_modules/@deepseek-ai/dsh-host-webserver/lib/index.js",
     [r"register\s*\(", r"kind\s*[:=]", r"exact", r"port", r"inject", r"webServer", r"Service", r"provide"]),
    ("/dsh/node_modules/@deepseek-ai/dsh-client-modules/lib/index.js",
     [r"dsh\.client", r"inject", r"platform", r"client\.inject", r"resolve", r"package\.json"]),
    ("/dsh/node_modules/@deepseek-ai/dsh-client-connection/lib/index.js",
     [r"requestRejection", r"connection", r"provide", r"inject"]),
    ("/dsh/node_modules/@deepseek-ai/dsh-plugin-manager/lib/index.js",
     [r"treeAlive", r"run\.json", r"process\.kill"]),
    ("/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js",
     [r"quit-inspection", r"shutdown-complete", r"platform-session", r"update-tasks", r"ELECTRON_RUN_AS_NODE", r"ipc", r"restart"]),
    ("/lib/main.js",
     [r"quit-inspection", r"shutdown-complete", r"platform-session", r"ELECTRON_RUN_AS_NODE"]),
    ("/dsh/node_modules/@deepseek-ai/dsh-client-ui-sidebar/lib/client.js",
     [r"sidebar\.footer\.action", r"sidebar\.panellist", r"register", r"provide", r"inject"]),
]

def load(path):
    with open(path, 'rb') as f:
        head = f.read(16)
        hps = struct.unpack('<I', head[4:8])[0]
        jlen = struct.unpack('<I', head[12:16])[0]
        f.seek(16)
        header = json.loads(f.read(jlen).decode('utf-8'))
        base = 8 + hps
        return header, base

def get(path, header, base, relpath):
    node = header
    for p in [x for x in relpath.split('/') if x]:
        node = node['files'][p]
    with open(path, 'rb') as f:
        f.seek(base + int(node['offset']))
        return f.read(int(node['size'])).decode('utf-8', 'replace')

def lines_matching(text, regexes):
    rx = re.compile("|".join("(?:%s)" % r for r in regexes))
    out = []
    for i, line in enumerate(text.splitlines(), 1):
        if rx.search(line):
            out.append((i, line.strip()[:160]))
    return out

for label, path in (("OLD", OLD), ("NEW", NEW)):
    print("#" * 76)
    print("#", label, path)
    print("#" * 76)
    header, base = load(path)
    for rel, regexes in TARGETS:
        try:
            text = get(path, header, base, rel)
        except KeyError:
            print("  MISSING:", rel)
            continue
        matches = lines_matching(text, regexes)
        print("--- %s  (%d matching lines) ---" % (rel, len(matches)))
        for i, line in matches[:14]:
            print("   L%-5d %s" % (i, line))

