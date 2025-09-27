#!/usr/bin/env python3
import os, sys, json, zipfile
from pb_runtime_compat import ensure_protobuf_runtime, relax_protobuf_runtime_check

HERE = os.path.dirname(os.path.abspath(__file__))
GEN_CANDIDATES = [
    os.path.join(HERE, '..', 'src', 'gen'),
    os.path.join(HERE, '..', 'gen'),
]
for cand in GEN_CANDIDATES:
    cand = os.path.abspath(cand)
    if cand not in sys.path and os.path.isdir(cand):
        sys.path.insert(0, cand)

# Try multiple import paths for generated modules
def import_presentation_pb2():
    # Try multiple import roots; emit a banner line indicating which worked
    ok, detail = ensure_protobuf_runtime()
    if not ok:
        print(json.dumps({"error": "protobuf-runtime-missing", "detail": detail}))
        sys.exit(3)
    relax_protobuf_runtime_check()
    try:
        from rv.data import presentation_pb2
        print(json.dumps({"info":"import","path":"rv.data.presentation_pb2"}))
        return presentation_pb2
    except Exception as e1:
        try:
            import presentation_pb2
            print(json.dumps({"info":"import","path":"presentation_pb2"}))
            return presentation_pb2
        except Exception as e2:
            print(json.dumps({"error": f"failed to import presentation_pb2: {e2}"}))
            sys.exit(2)

def iter_pro_candidates(root: str):
    for dirpath, dirnames, filenames in os.walk(root):
        for name in filenames:
            if name.lower().endswith('.pro'):
                yield os.path.join(dirpath, name)
        for name in dirnames:
            if name.lower().endswith('.pro'):
                yield os.path.join(dirpath, name)

def main():
    if len(sys.argv) < 2:
        print("Usage: python scripts/pp_index_presentations.py /path/to/Library", file=sys.stderr)
        sys.exit(1)
    root = os.path.expanduser(sys.argv[1])
    pb = import_presentation_pb2()
    pro_count = 0
    found = 0
    for p in iter_pro_candidates(root):
        pro_count += 1
        try:
            payload: bytes | None = None
            if os.path.isdir(p):
                candidate = os.path.join(p, 'Contents', 'presentation.pro')
                if os.path.exists(candidate):
                    with open(candidate, 'rb') as f:
                        payload = f.read()
                else:
                    continue
            else:
                with open(p, 'rb') as f:
                    header = f.read(4)
                    f.seek(0)
                    if header == b'PK\x03\x04':
                        with zipfile.ZipFile(f) as zf:
                            for info in zf.infolist():
                                if info.filename.lower().endswith('.pro'):
                                    payload = zf.read(info.filename)
                                    break
                        if payload is None:
                            continue
                    else:
                        payload = f.read()
            if payload is None:
                continue
            doc = pb.Presentation()
            doc.ParseFromString(payload)
            # Probe several candidate fields
            uuid = (
                getattr(doc, 'uuid', '')
                or (getattr(getattr(doc, 'id', None), 'uuid', '') if getattr(doc, 'id', None) else '')
                or (getattr(getattr(doc, 'id', None), 'id', '') if getattr(doc, 'id', None) else '')
                or getattr(doc, 'identifier', '')
                or ''
            )
            title = getattr(doc, 'name', '') or getattr(doc, 'title', '') or os.path.basename(p)
            if uuid:
                print(json.dumps({"uuid": str(uuid), "title": str(title), "path": p}))
                found += 1
            else:
                # Emit a hint line so caller knows parse succeeded but no uuid present
                print(json.dumps({"warn":"no-uuid", "title": str(title), "path": p}))
        except Exception:
            # skip unreadable file
            continue
    print(json.dumps({"info": "scan complete", "count": found, "files": pro_count}))

if __name__ == '__main__':
    main()
