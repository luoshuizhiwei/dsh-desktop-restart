import json, struct, sys, os

def read_asar(path):
    with open(path, 'rb') as f:
        head = f.read(16)
        header_pickle_size = struct.unpack('<I', head[4:8])[0]
        jlen = struct.unpack('<I', head[12:16])[0]
        f.seek(16)
        header = json.loads(f.read(jlen).decode('utf-8'))
        base = 8 + header_pickle_size
        return header, base

def get_entries(node, prefix=''):
    out = []
    for name, meta in node.get('files', {}).items():
        p = prefix + '/' + name
        if 'files' in meta:
            out.append((p + '/', None))
            out.extend(get_entries(meta, p))
        else:
            out.append((p, meta))
    return out

def extract(path, relpath, outpath=None):
    header, base = read_asar(path)
    parts = [p for p in relpath.split('/') if p]
    node = header
    for p in parts:
        node = node['files'][p]
    if 'files' in node:
        return ('DIR', get_entries(node, relpath))
    off = base + int(node['offset'])
    size = int(node['size'])
    with open(path, 'rb') as f:
        f.seek(off)
        data = f.read(size)
    if outpath:
        with open(outpath, 'wb') as o:
            o.write(data)
        return ('WROTE', outpath, len(data))
    try:
        return ('TEXT', data.decode('utf-8'))
    except UnicodeDecodeError:
        return ('BIN', len(data))

if __name__ == '__main__':
    asar = sys.argv[1]
    cmd = sys.argv[2]
    rel = sys.argv[3] if len(sys.argv) > 3 else ''
    out = sys.argv[4] if len(sys.argv) > 4 else None
    if cmd == 'root':
        header, base = read_asar(asar)
        for p, meta in get_entries(header)[:120]:
            print(p, '' if meta is None else meta.get('size'))
    elif cmd == 'find':
        header, base = read_asar(asar)
        for p, meta in get_entries(header):
            if rel.lower() in p.lower():
                print(p, '' if meta is None else meta.get('size'))
    else:
        print(extract(asar, rel, out))
