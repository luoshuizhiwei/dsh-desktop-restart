"""Verify exact call signatures the restart plugin uses, in NEW asar only."""
import struct, json, re

NEW = r"E:\dsh-update-022rc1-check\new\app.asar"

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

header, base = load(NEW)

CHECKS = [
    ("dsh-host-webserver/lib/index.js", "register(", [
        r"register\s*\(route", r"register\s*\(options", r"kind", r"case \"exact\"",
        r"switch\s*\(.*kind", r"\.path", r"handler", r"provide\(.*webServer",
        r"class WebServer", r"Service", r"inject",
    ]),
    ("dsh-client-connection/lib/index.js", "requestRejection", [
        r"requestRejection", r"reject", r"method",
    ]),
    ("dsh-plugin-manager/lib/index.js", "commands.register", [r"commands", r"register"]),
]

files = {
    "webserver": "/dsh/node_modules/@deepseek-ai/dsh-host-webserver/lib/index.js",
    "connection": "/dsh/node_modules/@deepseek-ai/dsh-client-connection/lib/index.js",
    "sidebar": "/dsh/node_modules/@deepseek-ai/dsh-client-ui-sidebar/lib/client.js",
    "cordis": "/dsh/node_modules/@deepseek-ai/cordis/lib/index.js",
    "loader": "/dsh/node_modules/@deepseek-ai/cordis-plugin-loader/lib/index.js",
}

# 1) exact context around requestRejection
print("===== connection.requestRejection definition (NEW) =====")
t = get(NEW, header, base, files["connection"])
for i, line in enumerate(t.splitlines(), 1):
    if "requestRejection" in line:
        print("  L%-5d %s" % (i, line.strip()[:170]))

# 2) webServer.register signature + exact kind handling
print("\n===== webserver register/kind handling (NEW) =====")
t = get(NEW, header, base, files["webserver"])
for i, line in enumerate(t.splitlines(), 1):
    if re.search(r"register\s*\(|kind|\"exact\"|'exact'|case .exact|\.handler|\.path|class .*WebServer|provide\(|inject\s*=", line):
        print("  L%-5d %s" % (i, line.strip()[:170]))

# 3) cordis Service / inject / effect / get / logger  — core 4.1.0
print("\n===== Cordis core public API (NEW 4.1.0) =====")
t = get(NEW, header, base, files["cordis"])
for i, line in enumerate(t.splitlines(), 1):
    if re.search(r"\b(effect|inject|get|logger|provide|Service|scope|plugin)\b\s*[(=:]", line) and len(line.strip()) < 120:
        print("  L%-5d %s" % (i, line.strip()[:150]))
