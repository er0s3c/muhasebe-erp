#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
PYTHON="${CONSTRUCTION_INSTALL_PYTHON:-python3}"
RUNTIME="${CONSTRUCTION_INSTALL_RUNTIME:-$ROOT/.runtime/construction}"
TESSDATA="${CONSTRUCTION_INSTALL_TESSDATA:-$ROOT/apps/api/data/construction-runtime/tessdata}"
[[ -x "$RUNTIME/bin/python" ]] || "$PYTHON" -m venv "$RUNTIME"
"$RUNTIME/bin/python" -m pip install -r "$ROOT/installer/runtime/requirements.txt" --cache-dir "$ROOT/.cache/pip"
"$RUNTIME/bin/python" "$ROOT/installer/runtime/install-languages.py" "$TESSDATA"
printf 'CONSTRUCTION_PYTHON=%s\nCONSTRUCTION_TESSDATA_DIR=%s\n' "$RUNTIME/bin/python" "$TESSDATA"
