#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_root"

if [[ ! -x .venv-docling/bin/python ]]; then
  uv venv --python 3.12 .venv-docling
fi
uv pip install --python .venv-docling/bin/python "docling==2.93.0"
.venv-docling/bin/docling --version
