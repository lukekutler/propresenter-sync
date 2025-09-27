import os
import sys
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

ok, detail = ensure_protobuf_runtime()
if not ok:
    raise SystemExit(f"protobuf runtime not available: {detail}")

relax_protobuf_runtime_check()

try:
    from rv.data import presentation_pb2  # generated from presentation.proto
except ImportError:
    import presentation_pb2  # fallback when rv.data package is unavailable

if len(sys.argv) < 3:
    print("Usage: python scripts/pp_set_operator_notes.py /full/path/to/file.pro 'new notes text'")
    sys.exit(1)

path = sys.argv[1]
new_notes = " ".join(sys.argv[2:])

doc = presentation_pb2.Presentation()
with open(path, "rb") as f:
    doc.ParseFromString(f.read())

print("Current operator notes:", repr(doc.notes))
doc.notes = new_notes

with open(path, "wb") as f:
    f.write(doc.SerializeToString())

print("✅ Wrote operator notes to:", path)
