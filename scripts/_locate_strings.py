"""Locate which asar files contain the exact slot/service strings, old vs new."""
import struct, sys

def read_asar(path):
    with open(path, 'rb') as f:
        head = f.read(16)
        hps = struct.unpack('<I', head[4:8])[0]
        jlen = struct.unpack('<I', head[12:16])[0]
        f.seek(16)
        header = json_loads(f.read(jlen))
        base = 8 + hps
        return header, base

def json_loads(b):
    import json
    return json.loads(b.decode('utf-8'))

def flatten(node, prefix=''):
    out = []
    for name, meta in node.get('files', {}).items():
        p = prefix + '/' + name
        if 'files' in meta:
            out.extend(flatten(meta, p))
        else:
            if 'offset' in meta and 'size' in meta:
                out.append((p, int(meta['offset']), int(meta['size'])))
    return out

NEEDLES = [b"sidebar.footer.action", b"sidebar.panellist",
           b"requestRejection", b"quit-inspection", b"shutdown-complete",
           b"platform-session", b"ELECTRON_RUN_AS_NODE", b"treeAlive"]

def scan(path, label):
    header, base = read_asar(path)
    files = flatten(header)
    print("=" * 72)
    print(label, "files:", len(files))
    print("=" * 72)
    with open(path, 'rb') as f:
        for p, off, size in files:
            if size < 4 or size > 20_000_000:
                continue
            f.seek(base + off)
            data = f.read(size)
            hits = [n.decode('utf-8', 'replace') for n in NEEDLES if n in data]
            if hits:
                print("  %-70s %s" % (p[:70], ",".join(hits)))

for label, path in (("OLD 0.2.1-rc.5", r"D:\develop\AI Agent\DeepSeek Harness\resources\app.asar"),
                    ("NEW 0.2.2-rc.1", r"E:\dsh-update-022rc1-check\new\app.asar")):
    scan(path, label)
