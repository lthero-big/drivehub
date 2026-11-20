#!/usr/bin/env bash
# Build + sign a DriveHub release directory for the auto-updater (DEPTAI-484).
#
#   DRIVEHUB_RELEASE_KEY=~/secrets/drivehub-release-signing.key \
#   scripts/make-release.sh 0.2.0 --out /srv/drivehub-releases/v0.2.0 \
#       [--channel stable|beta] [--min-client 0.1.0] [--notes-file NOTES.md] \
#       [--base-url https://github.com/lthero-big/drivehub/releases/download/v0.2.0/] \
#       [--docker ghcr.io/lthero-big/drivehub:0.2.0] [--no-web]
#
# Produces <out>/{drivehub-linux-<arch>, web.tar.gz, release-manifest.json, release-manifest.json.sig}.
# Upload all four as release assets (or serve the directory over HTTP) and point
# DRIVEHUB_UPDATE_URL at <base>/release-manifest.json. The secret key never enters the repo;
# create one with `drivehub release keygen --out <file>`.
# DRIVEHUB_BUILD_FAULT=unhealthy|migrate|crash is passed through for rollback drills only.
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION=${1:?usage: make-release.sh <version> --out <dir> [...]}
shift
OUT="" CHANNEL=stable MIN_CLIENT="" NOTES="" BASE="" DOCKER="" WEB=1
while [[ $# -gt 0 ]]; do
  case "$1" in
    --out) OUT=$2; shift 2 ;;
    --channel) CHANNEL=$2; shift 2 ;;
    --min-client) MIN_CLIENT=$2; shift 2 ;;
    --notes-file) NOTES=$2; shift 2 ;;
    --base-url) BASE=$2; shift 2 ;;
    --docker) DOCKER=$2; shift 2 ;;
    --no-web) WEB=0; shift ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done
[[ -n "$OUT" ]] || { echo "--out required" >&2; exit 2; }
KEY=${DRIVEHUB_RELEASE_KEY:?set DRIVEHUB_RELEASE_KEY to the secret signing key file}
mkdir -p "$OUT"
case "$(uname -m)" in x86_64) ARCH=amd64 ;; aarch64|arm64) ARCH=arm64 ;; *) ARCH=$(uname -m) ;; esac
PLAT="linux-$ARCH"

echo ">> server $VERSION ($PLAT${DRIVEHUB_BUILD_FAULT:+, fault=$DRIVEHUB_BUILD_FAULT})"
DRIVEHUB_BUILD_VERSION=$VERSION cargo build --release --bin drivehub
cp target/release/drivehub "$OUT/drivehub-$PLAT"
GOT=$("$OUT/drivehub-$PLAT" version | sed -n 's/.*"server_version":"\([^"]*\)".*/\1/p')
[[ "$GOT" == "$VERSION" ]] || { echo "binary reports $GOT, expected $VERSION" >&2; exit 1; }

ARGS=(--version "$VERSION" --channel "$CHANNEL" --server "$PLAT=$OUT/drivehub-$PLAT" --out "$OUT/release-manifest.json")
[[ -n "$MIN_CLIENT" ]] && ARGS+=(--min-client "$MIN_CLIENT")
[[ -n "$NOTES" ]] && ARGS+=(--notes-file "$NOTES")
[[ -n "$BASE" ]] && ARGS+=(--base-url "$BASE")
[[ -n "$DOCKER" ]] && ARGS+=(--docker "$DOCKER")
if [[ $WEB == 1 ]]; then
  echo ">> web $VERSION"
  (cd web && DRIVEHUB_WEB_VERSION=$VERSION npm run build >/dev/null)
  tar -C web/dist -czf "$OUT/web.tar.gz" .
  ARGS+=(--web "$OUT/web.tar.gz")
fi
"$OUT/drivehub-$PLAT" release manifest "${ARGS[@]}"
"$OUT/drivehub-$PLAT" release sign --key "$KEY" "$OUT/release-manifest.json"
"$OUT/drivehub-$PLAT" release verify "$OUT/release-manifest.json"
echo ">> release $VERSION ready in $OUT"
