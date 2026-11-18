#!/usr/bin/env bash
# Regenerate the committed API contract (api/openapi.json). Client generation
# (TS for web, Kotlin for Android) hooks in here in DEPTAI-466.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p api
cargo run -q --bin drivehub -- openapi > api/openapi.json
echo "api/openapi.json updated"
