#!/usr/bin/env bash
# Build base only when deploy/base.Dockerfile changed, then the runtime on top of it.
set -euo pipefail
cd "$(dirname "$0")/.."
BASE_TAG=$(sha256sum deploy/base.Dockerfile | cut -c1-12)
BASE="drivehub-base:$BASE_TAG"
if ! docker image inspect "$BASE" >/dev/null 2>&1; then
  docker build -f deploy/base.Dockerfile -t "$BASE" -t drivehub-base:latest deploy
fi
VERSION=$(grep -m1 '^version' Cargo.toml | cut -d'"' -f2)
docker build -f deploy/runtime.Dockerfile --build-arg BASE_IMAGE="$BASE" -t "drivehub:$VERSION" -t drivehub:latest .
echo "built drivehub:$VERSION on $BASE"
