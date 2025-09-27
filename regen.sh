#!/bin/bash
set -e

# 1. Reset gen folder
rm -rf src/gen
mkdir -p src/gen

# 2. Generate Python files with proper rv.data package structure
find vendor/propresenter-protos/Proto -type f -name '*.proto' -print0 \
| xargs -0 protoc --proto_path=vendor/propresenter-protos/Proto --python_out=src/gen

# 3. Add __init__.py markers to all dirs under src/gen
find src/gen -type d -exec touch {}/__init__.py \;

echo "✅ Regenerated protobufs."
echo
echo "Now test with:"
echo 'PYTHONPATH=src/gen python3 -c "from rv.data import presentation_pb2; print(dir(presentation_pb2))"'
