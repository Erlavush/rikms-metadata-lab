#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source_root="$project_root/.tools/grobid-0.9.0"
if [[ ! -x "$source_root/gradlew" ]]; then
  echo "GROBID is not installed. Run: npm run setup:grobid" >&2
  exit 1
fi
node "$project_root/scripts/harden-grobid-config.mjs"
cd "$source_root"
exec ./gradlew run
