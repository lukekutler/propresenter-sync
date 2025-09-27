#!/bin/bash
set -e

# Path to your dynamic script
SCRIPT="scripts/pp_set_operator_notes_dynamic.py"

# Re-write it with sys.path fix baked in
cat > $SCRIPT << 'PY'
import sys, os
from pathlib import Path
import importlib.util

if len(sys.argv) < 3:
    print("Usage: python scripts/pp_set_operator_notes_dynamic.py /full/path/to/file.pro 'new notes text'")
    sys.exit(1)

pro_file = os.path.expanduser(sys.argv[1])
new_notes = " ".join(sys.argv[2:])

# Find generated presentation_pb2.py anywhere under src/gen
root = Path(__file__).resolve().parents[1]  # project root
candidates = list(root.glob("src/gen/**/presentation_pb2.py"))
if not candidates:
    print("ERROR: Could not find generated 'presentation_pb2.py' under src/gen.")
    sys.exit(2)

pb2_path = candidates[0]
# Ensure sibling imports like 'import action_pb2' work:
sys.path.insert(0, str(pb2_path.parent))

# Load module dynamically
spec = importlib.util.spec_from_file_location("presentation_pb2", str(pb2_path))
presentation_pb2 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(presentation_pb2)  # type: ignore

# Parse, update notes, write back
doc = presentation_pb2.Presentation()
with open(pro_file, "rb") as f:
    doc.ParseFromString(f.read())

print("Current operator notes:", repr(doc.notes))
doc.notes = new_notes

with open(pro_file, "wb") as f:
    f.write(doc.SerializeToString())

print("✅ Wrote operator notes to:", pro_file)
print("New operator notes:", repr(new_notes))
PY

echo "✅ Script rewritten with sys.path fix."

