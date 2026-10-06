#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
PYTHON=${PYTHON:-python3}
"$PYTHON" -m pip install Nuitka==2.8.9 ordered-set==4.1.0 zstandard==0.25.0 -r "$ROOT/installer/runtime/requirements.txt"
"$PYTHON" -m nuitka --mode=standalone --assume-yes-for-downloads --include-package=ifcopenshell --include-package=pypdfium2 --include-package=PIL --output-filename=construction-worker --output-dir="$ROOT/.runtime/compiled-worker/linux-x64" "$ROOT/apps/api/src/modules/construction-control/construction-worker.py"
