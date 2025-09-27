"""Helpers to smooth over protobuf runtime/gencode version mismatches.

Some of the generated *_pb2.py files call
google.protobuf.runtime_version.ValidateProtobufRuntimeVersion, which
raises when the locally-installed protobuf runtime is older than the
generator used in this repo. That is common on macOS where the system
python ships an older protobuf package. We override the validator with a
no-op so we can still parse the messages.

We also provide a helper to ensure the protobuf runtime exists, with a
best-effort `pip install protobuf` fallback when it is missing.
"""

from __future__ import annotations

import os
import subprocess
import sys
from typing import Tuple

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DEPS_DIR = os.path.join(BASE_DIR, '.pydeps')
os.makedirs(DEPS_DIR, exist_ok=True)
if DEPS_DIR not in sys.path:
  sys.path.insert(0, DEPS_DIR)

_ENSURED = False



def ensure_protobuf_runtime() -> Tuple[bool, str]:
  """Ensure google.protobuf is importable.

  Returns (ok, details). If installation fails, details contains the
  error output so callers can surface it to the user.
  """

  global _ENSURED
  if _ENSURED:
    try:
      import google.protobuf  # type: ignore  # noqa: F401
      return True, ''
    except Exception as exc:  # pragma: no cover - defensive
      return False, f"post-ensure import failed: {exc}"

  try:
    import google.protobuf  # type: ignore  # noqa: F401
    _ENSURED = True
    return True, ''
  except Exception:
    pass

  cmd = [
    sys.executable,
    '-m',
    'pip',
    'install',
    '--upgrade',
    '--target',
    DEPS_DIR,
    'protobuf>=4.25.0',
  ]
  try:
    proc = subprocess.run(cmd, capture_output=True, text=True, check=False)
  except Exception as exc:  # pragma: no cover - defensive
    return False, f"pip invocation failed: {exc}"

  if proc.returncode != 0:
    detail = (proc.stdout or '') + (proc.stderr or '')
    return False, detail.strip()

  try:
    import google.protobuf  # type: ignore  # noqa: F401
    _ENSURED = True
    return True, (proc.stdout or '').strip()
  except Exception as exc:
    detail = (proc.stdout or '') + (proc.stderr or '') + f"\npost-install import failed: {exc}"
    return False, detail.strip()


def relax_protobuf_runtime_check() -> None:
  try:
    from google.protobuf import runtime_version as _runtime_version  # type: ignore
  except Exception:
    return

  try:
    def _noop_validate(*_args, **_kwargs):
      return None

    if hasattr(_runtime_version, 'ValidateProtobufRuntimeVersion'):
      _runtime_version.ValidateProtobufRuntimeVersion = _noop_validate  # type: ignore[attr-defined]
  except Exception:
    # If anything goes wrong, fall back to default behaviour.
    pass
