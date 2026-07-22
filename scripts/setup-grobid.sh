#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tools_root="$project_root/.tools"
archive="$tools_root/grobid-0.9.0.zip"
source_root="$tools_root/grobid-0.9.0"
mkdir -p "$tools_root"

if [[ ! -x "$source_root/gradlew" ]]; then
  curl --fail --location --retry 3 --output "$archive" \
    https://github.com/grobidOrg/grobid/archive/refs/tags/0.9.0.zip
  unzip -q -o "$archive" -d "$tools_root"
fi

node "$project_root/scripts/harden-grobid-config.mjs"
cd "$source_root"
./gradlew clean assemble
