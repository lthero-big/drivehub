#!/usr/bin/env bash
# Build and package one platform's release artifacts into dist/v<VERSION>/.
#   scripts/package-release.sh                 # host target (linux x86_64 → amd64)
#   TARGET=aarch64-unknown-linux-gnu scripts/package-release.sh   # cross (needs linker/cross)
#   SKIP_WEB=1 / SKIP_SERVER=1                 # reuse an existing web/dist or binary
# Output (names match DEPTAI-484's release manifest artifacts):
#   drivehub-linux-<arch>                     raw server binary (self-update payload)
#   web.tar.gz                                 web/dist (served via DRIVEHUB_WEB_DIR)
#   drivehub-<ver>-linux-<arch>.tar.gz         bundle: binary + web/ + compose + docs
#   SHA256SUMS                                 sha256 of every file above
set -euo pipefail
cd "$(dirname "$0")/.."
scripts/check-version.sh >/dev/null
V=$(tr -d '[:space:]' < VERSION)
TARGET=${TARGET:-}
case "${TARGET:-$(uname -m)}" in
  x86_64*) ARCH=amd64 ;; aarch64*|arm64*) ARCH=arm64 ;; *) ARCH=${TARGET:-$(uname -m)} ;;
esac
OUT=${OUT:-dist/v$V}
mkdir -p "$OUT"

if [[ -z "${SKIP_WEB:-}" ]]; then
  (cd web && npm ci && npm run build)
fi
[[ -f web/dist/index.html ]] || { echo "web/dist missing" >&2; exit 1; }

if [[ -n "$TARGET" ]]; then BIN=target/$TARGET/release/drivehub; else BIN=target/release/drivehub; fi
if [[ -z "${SKIP_SERVER:-}" ]]; then
  cargo build --release --locked --bin drivehub ${TARGET:+--target "$TARGET"}
fi
[[ -x "$BIN" ]] || { echo "$BIN missing" >&2; exit 1; }

cp "$BIN" "$OUT/drivehub-linux-$ARCH"
tar -C web/dist -czf "$OUT/web.tar.gz" .

PKG=drivehub-$V-linux-$ARCH
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/$PKG"
cp "$BIN" "$STAGE/$PKG/drivehub"
cp -r web/dist "$STAGE/$PKG/web"
cp VERSION CHANGELOG.md README.md docs/deploy.md deploy/docker-compose.yml "$STAGE/$PKG/"
tar -C "$STAGE" -czf "$OUT/$PKG.tar.gz" "$PKG"

(cd "$OUT" && sha256sum -- * 2>/dev/null | grep -v ' SHA256SUMS$' > SHA256SUMS.tmp && mv SHA256SUMS.tmp SHA256SUMS)
echo "packaged $OUT:"; cat "$OUT/SHA256SUMS"
